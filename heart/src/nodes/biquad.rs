//! BiquadFilterNode: all eight of the spec's second-order filters, from the
//! Audio EQ Cookbook formulas as the spec writes them, run as Chrome runs
//! them (biquad.cc and biquad_dsp_kernel.cc).
//!
//! Two of the spec's choices are easy to miss. For lowpass and highpass, Q
//! is in decibels: the resonance is 10^(Q/20), so the app's Q of 1 is a
//! gentle 1.12, not the cookbook's 1. And detune multiplies the frequency by
//! 2^(detune/1200) before anything else.
//!
//! The coefficients and the filter's state are f64, the filter is Direct
//! Form I, and each output is rounded to f32 before it is fed back, all as
//! Chrome does. The coefficients are worked out once per quantum while every
//! param holds still, and per sample while any one of them moves (automation
//! or an audio-rate input), which is what lets a swept filter sound smooth.

use std::f64::consts::PI;

use crate::node::{Activity, Bus, MAX_CHANNELS, Node, NodeInit, ParamSpec, QUANTUM, Rate, RenderCtx};

/// frequency's nominal maximum is Nyquist, which depends on the sample rate;
/// the node clamps to it itself (protocol.json, params).
static PARAMS: [ParamSpec; 4] = [
    ParamSpec { name: "frequency", default: 350.0, min: 0.0, max: f32::MAX, rate: Rate::A },
    ParamSpec { name: "detune", default: 0.0, min: -153600.0, max: 153600.0, rate: Rate::A },
    ParamSpec { name: "Q", default: 1.0, min: -f32::MAX, max: f32::MAX, rate: Rate::A },
    ParamSpec { name: "gain", default: 0.0, min: -1541.0, max: 1541.0, rate: Rate::A },
];

const FREQUENCY: usize = 0;
const DETUNE: usize = 1;
const Q: usize = 2;
const GAIN: usize = 3;

/// The attr that sets the filter type (protocol.json attrs.type).
const ATTR_TYPE: u32 = 1;

/// The filter types, numbered as protocol.json's biquad_type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterType {
    Lowpass = 0,
    Highpass = 1,
    Bandpass = 2,
    Lowshelf = 3,
    Highshelf = 4,
    Peaking = 5,
    Notch = 6,
    Allpass = 7,
}

impl FilterType {
    /// The type for a wire value; anything unknown is a lowpass, the spec's
    /// default type.
    pub fn from_wire(v: f64) -> FilterType {
        use FilterType::*;
        match v as i64 {
            1 => Highpass, 2 => Bandpass, 3 => Lowshelf, 4 => Highshelf,
            5 => Peaking, 6 => Notch, 7 => Allpass,
            _ => Lowpass,
        }
    }
}

/// One set of normalised coefficients (a0 divided through):
/// y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2] − a1·y[n−1] − a2·y[n−2].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefficients {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Coefficients {
    fn normalised(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coefficients {
        let inv = 1.0 / a0;
        Coefficients { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1 * inv, a2: a2 * inv }
    }

    /// A filter that is just a gain.
    fn gain(g: f64) -> Coefficients { Coefficients::normalised(g, 0.0, 0.0, 1.0, 0.0, 0.0) }

    /// The coefficients for `kind` at `normalised` frequency (hertz over
    /// Nyquist, detune applied), with Q and gain as the params give them.
    /// Each type's edge cases (frequency 0 or Nyquist, Q of 0) take the
    /// limit of its transfer function, as Chrome's biquad.cc does, instead
    /// of dividing by zero.
    pub fn compute(kind: FilterType, normalised: f64, q: f64, gain_db: f64) -> Coefficients {
        use FilterType::*;
        match kind {
            Lowpass | Highpass => {
                let f = normalised.clamp(0.0, 1.0);
                let high = kind == Highpass;
                if f == 1.0 {
                    // At Nyquist a lowpass passes everything and a highpass nothing.
                    return Coefficients::gain(if high { 0.0 } else { 1.0 });
                }
                if f <= 0.0 {
                    return Coefficients::gain(if high { 1.0 } else { 0.0 });
                }
                // The spec's α_QdB: Q is a resonance in decibels.
                let resonance = 10f64.powf(q / 20.0);
                let w0 = PI * f;
                let alpha = w0.sin() / (2.0 * resonance);
                let cos = w0.cos();
                let (b0, b1, b2) = if high {
                    let beta = (1.0 + cos) / 2.0;
                    (beta, -2.0 * beta, beta)
                } else {
                    let beta = (1.0 - cos) / 2.0;
                    (beta, 2.0 * beta, beta)
                };
                Coefficients::normalised(b0, b1, b2, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
            }
            Bandpass => {
                let f = normalised.max(0.0);
                let q = q.max(0.0);
                if !(f > 0.0 && f < 1.0) { return Coefficients::gain(0.0); }
                if q <= 0.0 { return Coefficients::gain(1.0); }
                let w0 = PI * f;
                let alpha = w0.sin() / (2.0 * q);
                let k = w0.cos();
                Coefficients::normalised(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * k, 1.0 - alpha)
            }
            Lowshelf | Highshelf => {
                let f = normalised.clamp(0.0, 1.0);
                let a = 10f64.powf(gain_db / 40.0);
                let low = kind == Lowshelf;
                // At the ends a shelf is all shelf (gain A²) or none (gain 1).
                if f == 1.0 { return Coefficients::gain(if low { a * a } else { 1.0 }); }
                if f <= 0.0 { return Coefficients::gain(if low { 1.0 } else { a * a }); }
                let w0 = PI * f;
                // The spec's α_S with the shelf slope S = 1.
                let s = 1.0;
                let alpha = 0.5 * w0.sin() * ((a + 1.0 / a) * (1.0 / s - 1.0) + 2.0).sqrt();
                let k = w0.cos();
                let k2 = 2.0 * a.sqrt() * alpha;
                let (ap1, am1) = (a + 1.0, a - 1.0);
                if low {
                    Coefficients::normalised(
                        a * (ap1 - am1 * k + k2),
                        2.0 * a * (am1 - ap1 * k),
                        a * (ap1 - am1 * k - k2),
                        ap1 + am1 * k + k2,
                        -2.0 * (am1 + ap1 * k),
                        ap1 + am1 * k - k2,
                    )
                } else {
                    Coefficients::normalised(
                        a * (ap1 + am1 * k + k2),
                        -2.0 * a * (am1 + ap1 * k),
                        a * (ap1 + am1 * k - k2),
                        ap1 - am1 * k + k2,
                        2.0 * (am1 - ap1 * k),
                        ap1 - am1 * k - k2,
                    )
                }
            }
            Peaking | Notch | Allpass => {
                let f = normalised.clamp(0.0, 1.0);
                let q = q.max(0.0);
                let a = 10f64.powf(gain_db / 40.0);
                if !(f > 0.0 && f < 1.0) { return Coefficients::gain(1.0); }
                if q <= 0.0 {
                    // The Q → 0 limits: a peak becomes its full gain, a notch
                    // closes everything, an allpass inverts.
                    return Coefficients::gain(match kind { Peaking => a * a, Notch => 0.0, _ => -1.0 });
                }
                let w0 = PI * f;
                let alpha = w0.sin() / (2.0 * q);
                let k = w0.cos();
                match kind {
                    Peaking => Coefficients::normalised(
                        1.0 + alpha * a, -2.0 * k, 1.0 - alpha * a,
                        1.0 + alpha / a, -2.0 * k, 1.0 - alpha / a,
                    ),
                    Notch => Coefficients::normalised(1.0, -2.0 * k, 1.0, 1.0 + alpha, -2.0 * k, 1.0 - alpha),
                    _ => Coefficients::normalised(
                        1.0 - alpha, -2.0 * k, 1.0 + alpha,
                        1.0 + alpha, -2.0 * k, 1.0 - alpha,
                    ),
                }
            }
        }
    }

    /// Frames until the impulse response has died away: the time the
    /// slowest pole takes to fall by 90 dB (to 2^−15), capped at 30 s.
    ///
    /// Chrome works its tail out from the poles too (Biquad::TailFrame),
    /// with a fuller account of the residues; the slowest pole's decay is
    /// the part that matters, and a tail that ends a touch early or late
    /// changes only when an idle filter stops being rendered, not its sound.
    /// A pole on or outside the unit circle rings forever, so it gets the cap.
    pub fn tail_frames(&self, sample_rate: f32) -> f64 {
        const FLOOR: f64 = 1.0 / 32768.0;
        let cap = 30.0 * sample_rate as f64;
        let (a1, a2) = (self.a1, self.a2);
        if a1 == 0.0 && a2 == 0.0 {
            // No feedback: the response is the three taps.
            return 2.0;
        }
        // The poles are the roots of z² + a1·z + a2.
        let discriminant = a1 * a1 - 4.0 * a2;
        let radius = if discriminant >= 0.0 {
            let root = discriminant.sqrt();
            ((-a1 + root) / 2.0).abs().max(((-a1 - root) / 2.0).abs())
        } else {
            // A complex pair: both have magnitude √a2.
            a2.sqrt()
        };
        if radius.is_nan() || radius >= 1.0 { return cap; }
        if radius == 0.0 { return 2.0; }
        (FLOOR.ln() / radius.ln()).ceil().min(cap)
    }
}

/// One channel's Direct Form I memory: the last two inputs and outputs.
#[derive(Clone, Copy, Default)]
struct State {
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl State {
    fn is_zero(&self) -> bool { self.x1 == 0.0 && self.x2 == 0.0 && self.y1 == 0.0 && self.y2 == 0.0 }

    /// Chrome flushes the state to zero below f32's smallest normal once per
    /// quantum, outside the loop, so a decaying tail never drags through
    /// denormals.
    fn flush_denormals(&mut self) {
        for v in [&mut self.x1, &mut self.x2, &mut self.y1, &mut self.y2] {
            if v.abs() < f32::MIN_POSITIVE as f64 { *v = 0.0; }
        }
    }

    #[inline]
    fn step(&mut self, c: &Coefficients, x: f32) -> f32 {
        // Chrome: the sum is f64 and the output an f32, which then feeds back
        // as y1; evaluated left to right as biquad.cc writes it.
        let xd = x as f64;
        let y = (c.b0 * xd + c.b1 * self.x1 + c.b2 * self.x2 - c.a1 * self.y1 - c.a2 * self.y2) as f32;
        self.x2 = self.x1;
        self.x1 = xd;
        self.y2 = self.y1;
        self.y1 = y as f64;
        y
    }
}

/// The params a set of constant coefficients was made from, so an unchanged
/// quantum reuses them instead of recomputing.
#[derive(Clone, Copy, PartialEq)]
struct Settings {
    kind: FilterType,
    frequency: f32,
    detune: f32,
    q: f32,
    gain: f32,
}

pub struct Biquad {
    sample_rate: f32,
    kind: FilterType,
    states: [State; MAX_CHANNELS],
    /// The channel count the states belong to.
    channels: usize,
    coefficients: Coefficients,
    /// What `coefficients` was computed from, while it was constant.
    settings: Option<Settings>,
    /// Per-sample coefficients for a quantum where a param moves.
    varying: [Coefficients; QUANTUM],
    tail: f64,
}

impl Biquad {
    pub fn new(init: &NodeInit) -> Self {
        let pass = Coefficients::gain(1.0);
        Biquad {
            sample_rate: init.sample_rate,
            kind: FilterType::from_wire(init.opts[0]),
            states: [State::default(); MAX_CHANNELS],
            channels: 1,
            coefficients: pass,
            settings: None,
            varying: [pass; QUANTUM],
            tail: 0.0,
        }
    }

    /// Hertz over Nyquist, with the frequency clamped to [0, Nyquist] and
    /// then detuned.
    fn normalised(&self, frequency: f32, detune: f32) -> f64 {
        let nyquist = self.sample_rate as f64 / 2.0;
        let mut f = (frequency as f64).clamp(0.0, nyquist) / nyquist;
        if detune != 0.0 {
            // Chrome: exp2 of an f32 argument, in f32.
            f *= (detune / 1200.0).exp2() as f64;
        }
        f
    }

    fn coefficients_at(&self, frequency: f32, detune: f32, q: f32, gain: f32) -> Coefficients {
        Coefficients::compute(self.kind, self.normalised(frequency, detune), q as f64, gain as f64)
    }
}

impl Node for Biquad {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }

    fn output_channels(&self, _o: usize, input_channels: &[usize]) -> usize {
        input_channels.first().copied().unwrap_or(1)
    }

    fn tail_frames(&self) -> f64 { self.tail }

    fn set_attr(&mut self, attr: u32, value: f64) {
        if attr == ATTR_TYPE {
            self.kind = FilterType::from_wire(value);
            self.settings = None;
        }
    }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let input = &ctx.inputs[0];
        let out = &mut out[0];

        // Chrome rebuilds its kernels, starting them empty, when the input's
        // channel count changes.
        if !input.silent && input.channels != self.channels {
            self.channels = input.channels;
            self.states = [State::default(); MAX_CHANNELS];
        }
        let channels = out.channels.min(MAX_CHANNELS);
        if input.silent && self.states[..channels].iter().all(State::is_zero) {
            out.zero();
            return Activity::Silent;
        }

        let p = ctx.params;
        let moving = !(p[FREQUENCY].is_const() && p[DETUNE].is_const() && p[Q].is_const() && p[GAIN].is_const());
        if moving {
            for i in 0..QUANTUM {
                self.varying[i] = self.coefficients_at(p[FREQUENCY].at(i), p[DETUNE].at(i), p[Q].at(i), p[GAIN].at(i));
            }
            // Chrome takes the tail from the quantum's last coefficients.
            self.coefficients = self.varying[QUANTUM - 1];
            self.tail = self.coefficients.tail_frames(self.sample_rate);
            self.settings = None;
        } else {
            let now = Settings {
                kind: self.kind,
                frequency: p[FREQUENCY].first(),
                detune: p[DETUNE].first(),
                q: p[Q].first(),
                gain: p[GAIN].first(),
            };
            if self.settings != Some(now) {
                self.coefficients = self.coefficients_at(now.frequency, now.detune, now.q, now.gain);
                self.tail = self.coefficients.tail_frames(self.sample_rate);
                self.settings = Some(now);
            }
        }

        // A silent input is all zeros, so it runs through the same loop and
        // the filter rings out its tail.
        out.silent = false;
        for c in 0..channels {
            let state = &mut self.states[c];
            let src = input.channel(c.min(input.channels - 1));
            let dest = &mut out.data[c];
            if moving {
                for i in 0..QUANTUM { dest[i] = state.step(&self.varying[i], src[i]); }
            } else {
                let k = self.coefficients;
                for i in 0..QUANTUM { dest[i] = state.step(&k, src[i]); }
            }
            state.flush_denormals();
        }
        Activity::Active
    }
}
