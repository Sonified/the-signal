//! OscillatorNode: a sine, square, sawtooth or triangle at `frequency`
//! detuned by `detune` cents, played from Chrome's band-limited wavetables
//! (periodic_wave.rs) between start() and stop().
//!
//! Every step follows Chromium's oscillator_node.cc, because how a browser
//! reads a wavetable is its own choice and the null test listens for it:
//!
//! - The phase is a read position in the table, f64, starting at 0 on
//!   start. A start that falls between two frames begins at the next frame
//!   with the phase it would have reached by then.
//! - While frequency and detune hold still over the quantum, one pair of
//!   tables serves the whole quantum (k-rate), and Chrome's SIMD loop reads
//!   four frames at a time with the read positions held in f32. While either
//!   moves, the tables and the step are worked out per frame (a-rate) and
//!   the position stays f64.
//! - Within a table, steps of 0.3 table samples or more interpolate
//!   linearly; slower steps (an LFO of a few hertz) use 3- or 5-point
//!   Lagrange, so a slow sweep through a coarse table stays smooth.

use std::sync::Arc;

use super::constant_source::Schedule;
use super::periodic_wave::{PeriodicWave, Shape};
use crate::node::{Activity, Bus, Node, NodeInit, ParamBlock, ParamSpec, QUANTUM, Rate, RenderCtx};

/// frequency's nominal range is ±Nyquist, which depends on the sample rate;
/// the node clamps to it itself (protocol.json, params).
static PARAMS: [ParamSpec; 2] = [
    ParamSpec { name: "frequency", default: 440.0, min: -f32::MAX, max: f32::MAX, rate: Rate::A },
    ParamSpec { name: "detune", default: 0.0, min: -153600.0, max: 153600.0, rate: Rate::A },
];

/// The attr that sets the wave type (protocol.json attrs.type).
const ATTR_TYPE: u32 = 1;

/// Steps (table samples per frame) at or above which linear interpolation
/// is used, and above which 3-point Lagrange is; below both, 5-point.
const INTERPOLATE_2_POINT: f32 = 0.3;
const INTERPOLATE_3_POINT: f32 = 0.16;

pub struct Oscillator {
    sample_rate: f32,
    wave: Arc<PeriodicWave>,
    schedule: Schedule,
    /// The read position in the table, in table samples, in [0, size).
    phase: f64,
}

impl Oscillator {
    pub fn new(init: &NodeInit) -> Self {
        Oscillator {
            sample_rate: init.sample_rate,
            wave: PeriodicWave::basic(Shape::from_wire(init.opts[0]), init.sample_rate),
            schedule: Schedule::default(),
            phase: 0.0,
        }
    }
}

/// Clamps a frequency to ±Nyquist, NaN to zero, as Chrome's ClampFrequency.
#[inline]
fn clamp_frequency(f: f32, nyquist: f32) -> f32 {
    if f.is_nan() { 0.0 } else { f.clamp(-nyquist, nyquist) }
}

/// Detune in cents as a frequency ratio. Chrome: exp2 in f32.
#[inline]
fn detune_ratio(cents: f32) -> f32 { (cents / 1200.0).exp2() }

/// Wraps a read position into [0, size).
#[inline]
fn wrap(position: f64, size: f64) -> f64 {
    position - (position / size).floor() * size
}

/// Chrome's WrapVirtualIndexVector, one lane: the f32 wrap of its SIMD loop,
/// which floors by truncating and correcting negatives.
#[inline]
fn wrap_lane(x: f32, size: f32) -> f32 {
    let r = x * (1.0 / size);
    let mut f = r as i32;
    if r < f as f32 { f -= 1; }
    x - f as f32 * size
}

/// One sample read from two tables at `position`, following Chrome's
/// DoInterpolation: within each table by the rule for this step size, then
/// crossfaded from the table with more partials to the one with fewer.
#[inline]
fn interpolate(position: f64, step: f32, higher: &[f32], lower: &[f32], crossfade: f32) -> f32 {
    let mask = higher.len() - 1;
    let r0 = position as usize;
    let (mut sample_higher, mut sample_lower) = (0.0f64, 0.0f64);
    if step >= INTERPOLATE_2_POINT {
        let (i0, i1) = (r0 & mask, (r0 + 1) & mask);
        // Chrome: the fraction is taken from the position rounded to f32.
        let t = (position as f32 - i0 as f32) as f64;
        sample_higher = (1.0 - t) * higher[i0] as f64 + t * higher[i1] as f64;
        sample_lower = (1.0 - t) * lower[i0] as f64 + t * lower[i1] as f64;
    } else if step >= INTERPOLATE_3_POINT {
        let t = position - r0 as f64;
        let a = [0.5 * t * (t - 1.0), 1.0 - t * t, 0.5 * t * (t + 1.0)];
        for (k, a) in a.iter().enumerate() {
            let i = (r0 + k).wrapping_sub(1) & mask;
            sample_higher += a * higher[i] as f64;
            sample_lower += a * lower[i] as f64;
        }
    } else {
        let t = position - r0 as f64;
        let t2 = t * t;
        let a = [
            t * (t2 - 1.0) * (t - 2.0) / 24.0,
            -t * (t - 1.0) * (t2 - 4.0) / 6.0,
            (t2 - 1.0) * (t2 - 4.0) / 4.0,
            -t * (t + 1.0) * (t2 - 4.0) / 6.0,
            t * (t2 - 1.0) * (t + 2.0) / 24.0,
        ];
        for (k, a) in a.iter().enumerate() {
            let i = (r0 + k).wrapping_sub(2) & mask;
            sample_higher += a * higher[i] as f64;
            sample_lower += a * lower[i] as f64;
        }
    }
    ((1.0 - crossfade) as f64 * sample_higher + crossfade as f64 * sample_lower) as f32
}

impl Oscillator {
    /// The k-rate path: one frequency for the whole quantum.
    fn render_steady(&mut self, dest: &mut [f32], frequency: f32) {
        let wave = &*self.wave;
        let size = wave.size();
        let (higher, lower, crossfade) = wave.tables_for(frequency);
        let step = frequency * wave.rate_scale();
        let mut position = self.phase;
        let mut done = 0;

        // Chrome: this is its SIMD loop (SSE2 or NEON), four frames at a
        // time with each lane's read position an f32 that steps by 4·step
        // and wraps in f32. The f64 position is brought up to date at the
        // end, so the rounding never accumulates past a quantum. Chrome takes
        // this path only for steps of at least 0.3, where it would
        // interpolate linearly anyway.
        if step >= INTERPOLATE_2_POINT {
            let size_f = size as f32;
            let mask = size - 1;
            let mut lanes = [0f32; 4];
            for (j, lane) in lanes.iter_mut().enumerate() {
                *lane = wrap_lane((position + (j as f32 * step) as f64) as f32, size_f);
            }
            let stride = 4.0 * step;
            done = dest.len() / 4 * 4;
            for frames in dest[..done].as_chunks_mut::<4>().0 {
                for (d, lane) in frames.iter_mut().zip(lanes.iter_mut()) {
                    let i0 = (*lane as i32 as usize) & mask;
                    let i1 = (i0 + 1) & mask;
                    let t = *lane - i0 as f32;
                    let h = higher[i0] + t * (higher[i1] - higher[i0]);
                    let l = lower[i0] + t * (lower[i1] - lower[i0]);
                    *d = h + crossfade * (l - h);
                    *lane = wrap_lane(*lane + stride, size_f);
                }
            }
            position = wrap(position + (done as f32 * step) as f64, size as f64);
        }

        for d in dest[done..].iter_mut() {
            *d = interpolate(position, step.abs(), higher, lower, crossfade);
            position = wrap(position + step as f64, size as f64);
        }
        self.phase = position;
    }

    /// The a-rate path: a step and a pair of tables for every frame.
    fn render_moving(&mut self, dest: &mut [f32], steps: &[f32]) {
        let wave = &*self.wave;
        let size = wave.size() as f64;
        let per_hertz = 1.0 / wave.rate_scale();
        let mut position = self.phase;
        for (d, &step) in dest.iter_mut().zip(steps) {
            // Chrome: the frame's frequency is recovered from its step.
            let (higher, lower, crossfade) = wave.tables_for(per_hertz * step);
            *d = interpolate(position, step.abs(), higher, lower, crossfade);
            position = wrap(position + step as f64, size);
        }
        self.phase = position;
    }
}

impl Node for Oscillator {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }
    fn inputs(&self) -> usize { 0 }
    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { 1 }
    fn is_source(&self) -> bool { true }
    fn start(&mut self, frame: f64, _offset: f64, _duration: f64) { self.schedule.start(frame); }
    fn stop(&mut self, frame: f64) { self.schedule.stop(frame); }

    fn set_attr(&mut self, attr: u32, value: f64) {
        // A new type keeps the phase, as Chrome's does, so a waveform change
        // mid-note does not restart the cycle.
        if attr == ATTR_TYPE {
            self.wave = PeriodicWave::basic(Shape::from_wire(value), self.sample_rate);
        }
    }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let out = &mut out[0];
        let Some(window) = self.schedule.window(ctx.frame) else {
            out.zero();
            return self.schedule.idle();
        };
        out.zero();
        out.silent = false;

        let nyquist = self.sample_rate / 2.0;
        let rate_scale = self.wave.rate_scale();
        let (frequency, detune) = (ctx.params[0], ctx.params[1]);
        let moving = !(frequency.is_const() && detune.is_const());
        // The frequency param's own range is ±Nyquist.
        let param = |f: f32| clamp_frequency(f, nyquist);

        // Chrome: the steady frequency is also what scales the sub-sample
        // start below, and it is left at zero when the params move, so a
        // start between frames under automation begins at phase zero.
        let steady = if moving { 0.0 } else {
            clamp_frequency(param(frequency.first()) * detune_ratio(detune.first()), nyquist)
        };
        if window.start_offset < 0.0 {
            self.phase = -window.start_offset * steady as f64 * rate_scale as f64;
        }

        let dest = &mut out.channel_mut(0)[window.from..window.to];
        if !moving {
            self.render_steady(dest, steady);
            return Activity::Active;
        }

        // Chrome's CalculateSampleAccuratePhaseIncrements, in its order: a
        // moving frequency is clamped before a steady detune scales it, and
        // after a moving one does.
        let mut steps = [0f32; QUANTUM];
        let mut scale = rate_scale;
        match (frequency, detune) {
            (ParamBlock::Varying(f), ParamBlock::Varying(d)) => {
                for i in 0..QUANTUM { steps[i] = param(f[i]) * detune_ratio(d[i]); }
            }
            (ParamBlock::Varying(f), ParamBlock::Const(d)) => {
                for i in 0..QUANTUM { steps[i] = param(f[i]); }
                scale *= detune_ratio(d);
            }
            (ParamBlock::Const(f), ParamBlock::Varying(d)) => {
                scale *= param(f);
                for i in 0..QUANTUM { steps[i] = detune_ratio(d[i]); }
            }
            (ParamBlock::Const(_), ParamBlock::Const(_)) => unreachable!("a steady quantum took the k-rate path"),
        }
        for s in steps.iter_mut() { *s = clamp_frequency(*s, nyquist) * scale; }
        self.render_moving(dest, &steps[window.from..window.to]);
        Activity::Active
    }
}
