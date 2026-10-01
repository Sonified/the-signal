//! The master room's algorithmic reverb: a feedback delay network, the Music
//! drawer's Reverb type 'Algorithmic' (js/piano.js, the room). The port of
//! js/fdn-worklet.js, sample for sample, with the same constants.
//!
//! Where the convolution room plays a fixed impulse, so a new decay is a new
//! impulse built and crossfaded in, here the decay is one number: the gain
//! each delay line keeps on every trip round, so a moved decay is heard on
//! the very next quantum.
//!
//! The input, summed to mono, runs through four allpass diffusers that smear
//! a strike into a dense wash before it reaches the network. The network is
//! eight delay lines of mutually unrelated lengths, mixed into one another on
//! every trip by an 8×8 Hadamard matrix (energy kept exactly, every line
//! feeding every other), each line's return through a one-pole filter that
//! sets how much of it survives the trip: at the low end what the decay asks,
//! at the top end less as the damping rises, so highs die first as they do in
//! a real room (Jot's design, the filter matched exactly at DC and Nyquist).
//! Each line's length drifts slowly by up to MOD_MS, every line at its own
//! rate, which keeps a held tone from settling into the network's resonances
//! and ringing metallic.
//!
//! The level is matched to the convolution room by calculation: a convolver
//! normalises its impulse to an RMS of 10^(−58/20) at 44.1 kHz (the Web Audio
//! spec's calibration), so its tail's energy is that squared times the
//! impulse's length. The network's tail energy, with a decay of T seconds, is
//! the injected energy times T·sampleRate / (13.8 · the mean line length),
//! 13.8 being ln(10^6), the 60 dB the decay is measured over. The output gain
//! sets the two equal, so the switch is a change of character rather than of
//! level.
//!
//! Nothing feeding it (piano.js unplugs it once its tail has rung out), it
//! plays on until the tail has had its decay and a second more, then clears
//! and sleeps, costing nothing.
//!
//! "Feeding" is the worklet's own test, `inputs[0].length > 0`, which in
//! Chrome means connected, sounding or not: a source not yet started, or
//! quiet, still hands it a channel of zeros, and only a finished one (whose
//! output Chrome disables) or none hands it no channels at all. So it wakes
//! the moment something is connected, and from then on its lines' slow
//! drift runs, silence or not; waking only at the first sound would start
//! the drift late and the tail would not null against Chrome's (−8 dB on
//! the bench, whose burst starts 50 ms in). The graph is told so through
//! RenderCtx::connected, and renders it every quantum as Chrome renders a
//! worklet whose process() keeps returning true.
//!
//! The arithmetic is f64 as the JS's is, and the delay memories are f32 as
//! its Float32Arrays are, so every write rounds where the worklet's does. The
//! Hadamard and the taps keep the worklet's order of operations: wider
//! arithmetic would sum the taps in another order and stop being the same
//! numbers.

use crate::node::{Activity, Bus, ChannelConfig, Node, NodeInit, ParamSpec, Rate, RenderCtx, QUANTUM};

static PARAMS: [ParamSpec; 3] = [
    ParamSpec { name: "decay", default: 4.5, min: 0.1, max: 60.0, rate: Rate::K },
    ParamSpec { name: "damping", default: 0.35, min: 0.0, max: 1.0, rate: Rate::K },
    ParamSpec { name: "mod", default: 0.3, min: 0.0, max: 1.0, rate: Rate::K },
];

const LINE_MS: [f64; 8] = [29.7, 37.1, 41.1, 43.7, 53.0, 59.9, 67.7, 73.1];
const DIFF_MS: [f64; 4] = [4.77, 3.59, 12.73, 9.30];
const DIFF_G: f64 = 0.6;
const MOD_HZ: [f64; 8] = [0.11, 0.13, 0.17, 0.19, 0.23, 0.29, 0.31, 0.37];
const MOD_MS: f64 = 0.6;
// Rows of the Hadamard matrix: the input's spread into the lines and the two
// outputs' taps, orthogonal so left and right come out decorrelated.
const TAP_IN: [f64; 8] = [1.0, 1.0, 1.0, 1.0, -1.0, -1.0, -1.0, -1.0];
const TAP_L: [f64; 8] = [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0];
const TAP_R: [f64; 8] = [1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0];
const N: usize = 8;
// Added and taken away again, which rounds anything far below hearing to an
// exact 0, so a long fade never runs on in denormals.
const FLUSH: f64 = 1e-20;

/// The convolver's RMS calibration, times its sample rate.
fn cal() -> f64 { 10f64.powf(-58.0 / 20.0) * 44100.0 }

pub struct Fdn {
    sample_rate: f64,
    mod_max: f64,
    /// Each line's resting length, whole samples, so a line at rest reads its
    /// sample exactly rather than interpolating, which would dull the highs a
    /// little on every trip.
    base: [f64; N],
    lines: [Vec<f32>; N],
    wi: [usize; N],
    /// The damping filters' memories and the read allpasses' memories.
    lp: [f64; N],
    ap: [f64; N],
    b0: [f64; N],
    a1: [f64; N],
    /// Each line's current length and its step per sample this quantum.
    d_now: [f64; N],
    d_step: [f64; N],
    mod_ph: [f64; N],
    v: [f64; N],
    diff: [Vec<f32>; 4],
    di: [usize; 4],
    out_g: f64,
    /// The decay and damping the filters are tuned to (−1: not yet).
    decay: f64,
    damp: f64,
    /// Frames of silent input since the last live one.
    quiet: f64,
    asleep: bool,
}

impl Fdn {
    pub fn new(init: &NodeInit) -> Self {
        let sr = init.sample_rate as f64;
        let mod_max = MOD_MS / 1000.0 * sr;
        let base = LINE_MS.map(|ms| js_round(ms / 1000.0 * sr));
        let lines = base.map(|d| vec![0f32; (d + mod_max).ceil() as usize + 4]);
        let diff = DIFF_MS.map(|ms| vec![0f32; (js_round(ms / 1000.0 * sr) as usize).max(1)]);
        let mut mod_ph = [0.0; N];
        for (i, p) in mod_ph.iter_mut().enumerate() { *p = i as f64 / N as f64; }
        let mut sum = 0.0;
        for d in base { sum += d; }
        let mean_d = sum / N as f64;
        Fdn {
            sample_rate: sr,
            mod_max,
            base,
            lines,
            wi: [0; N],
            lp: [0.0; N],
            ap: [0.0; N],
            b0: [0.0; N],
            a1: [0.0; N],
            d_now: base,
            d_step: [0.0; N],
            mod_ph,
            v: [0.0; N],
            diff,
            di: [0; 4],
            out_g: cal() / sr * (13.8 * mean_d).sqrt(),
            decay: -1.0,
            damp: -1.0,
            quiet: 0.0,
            asleep: true,
        }
    }

    /// Each line's survival per trip, at DC from the decay and at Nyquist from
    /// the decay shortened by the damping, as a one-pole filter's two ends.
    fn tune(&mut self, decay: f64, damp: f64) {
        self.decay = decay;
        self.damp = damp;
        let sr = self.sample_rate;
        let t_lo = decay.max(0.1);
        let t_hi = t_lo * (1.0 - 0.85 * damp);
        for i in 0..N {
            let gd = 10f64.powf(-3.0 * self.base[i] / (t_lo * sr));
            let gn = 10f64.powf(-3.0 * self.base[i] / (t_hi * sr));
            let a1 = (gd - gn) / (gd + gn);
            self.a1[i] = a1;
            self.b0[i] = gd * (1.0 - a1);
        }
    }

    fn sleep(&mut self) {
        self.asleep = true;
        for l in self.lines.iter_mut() { l.fill(0.0); }
        for d in self.diff.iter_mut() { d.fill(0.0); }
        self.lp = [0.0; N];
        self.ap = [0.0; N];
    }
}

/// JS's Math.round: halves go up, toward +∞.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

impl Node for Fdn {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }

    /// Two channels, as piano.js constructs it (outputChannelCount [2]).
    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { 2 }

    fn channel_config(&self) -> ChannelConfig { ChannelConfig::default() }

    /// Endless, as a worklet's is to Chrome while its process() returns
    /// true (this one's always does): it is rendered every quantum, so it can
    /// wake on a connection alone, and asleep that costs one test.
    fn tail_frames(&self) -> f64 { f64::INFINITY }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let n = QUANTUM;
        let inp = &ctx.inputs[0];
        // The worklet's `has`: anything connected, sounding or not (see the top).
        let has = ctx.connected.first().copied().unwrap_or(false);
        let decay = ctx.params[0].first() as f64;
        let damp = ctx.params[1].first() as f64;
        let modv = ctx.params[2].first() as f64;
        if has {
            self.asleep = false;
            self.quiet = 0.0;
        } else if !self.asleep {
            self.quiet += n as f64;
            if self.quiet > (decay + 1.0) * self.sample_rate { self.sleep(); }
        }
        let o = &mut out[0];
        if self.asleep {
            if !o.silent { o.zero(); }
            return Activity::Silent;
        }
        if decay != self.decay || damp != self.damp { self.tune(decay, damp); }

        // The lines' drifting lengths, eased across the quantum from where the
        // last one left them.
        let sr = self.sample_rate;
        for i in 0..N {
            self.mod_ph[i] = (self.mod_ph[i] + MOD_HZ[i] * n as f64 / sr) % 1.0;
            let d_end = self.base[i]
                + modv * self.mod_max * (2.0 * std::f64::consts::PI * self.mod_ph[i]).sin();
            self.d_step[i] = (d_end - self.d_now[i]) / n as f64;
        }
        let (in_l, in_r) = if inp.channels > 1 { (&inp.data[0], &inp.data[1]) } else { (&inp.data[0], &inp.data[0]) };
        let out_g = self.out_g;
        let Fdn { lines, wi, lp, ap, b0, a1, d_now, d_step, v, diff, di, .. } = self;
        let [lo, ro] = &mut o.data;

        for s in 0..n {
            let mut x = if has { 0.5 * (in_l[s] as f64 + in_r[s] as f64) } else { 0.0 };
            for k in 0..diff.len() {
                let buf = &mut diff[k];
                let idx = di[k];
                let dl = buf[idx] as f64;
                let t = x + DIFF_G * dl;
                x = dl - DIFF_G * t;
                buf[idx] = t as f32;
                di[k] = if idx + 1 == buf.len() { 0 } else { idx + 1 };
            }
            let mut yl = 0.0;
            let mut yr = 0.0;
            for i in 0..N {
                let line = &lines[i];
                let len = line.len() as isize;
                // The read, d samples back: whole samples k, then the
                // fraction by a first-order allpass, which passes every
                // frequency whole where a straight-line blend between two
                // samples would dull the highs on every trip. The fraction is
                // kept between 0.5 and 1.5, where the allpass is well behaved.
                let d = d_now[i] + d_step[i] * s as f64;
                let k = (d - 0.5).floor();
                let fr = d - k;
                let mut p0 = wi[i] as isize - k as isize;
                if p0 < 0 { p0 += len; }
                let p1 = if p0 == 0 { len - 1 } else { p0 - 1 };
                let eta = (1.0 - fr) / (1.0 + fr);
                let r = eta * line[p0 as usize] as f64 + line[p1 as usize] as f64 - eta * ap[i];
                ap[i] = r;
                yl += TAP_L[i] * r;
                yr += TAP_R[i] * r;
                let f = (b0[i] * r + a1[i] * lp[i] + FLUSH) - FLUSH;
                lp[i] = f;
                v[i] = f;
            }
            hadamard8(v);
            let norm = 1.0 / (N as f64).sqrt();
            for i in 0..N {
                let line = &mut lines[i];
                let w = wi[i];
                line[w] = ((v[i] + x * TAP_IN[i]) * norm) as f32;
                wi[i] = if w + 1 == line.len() { 0 } else { w + 1 };
            }
            lo[s] = (yl * out_g) as f32;
            ro[s] = (yr * out_g) as f32;
        }
        for i in 0..N { d_now[i] += d_step[i] * n as f64; }
        o.silent = false;
        Activity::Active
    }
}

/// The 8×8 Hadamard transform in place, unnormalised: three rounds of
/// butterflies, each pair becoming its sum and its difference. Each output is
/// the same chain of additions in the same order as the worklet's loop, so
/// the numbers match it exactly.
#[inline(always)]
fn hadamard8(v: &mut [f64; 8]) {
    let mut h = 1;
    while h < 8 {
        let mut i = 0;
        while i < 8 {
            for j in i..i + h {
                let a = v[j];
                let b = v[j + h];
                v[j] = a + b;
                v[j + h] = a - b;
            }
            i += h << 1;
        }
        h <<= 1;
    }
}
