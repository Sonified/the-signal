//! The entrainment engine: the port of js/worklet.js's 'genus' processor, in
//! full, formula for formula and constant for constant.
//!
//! One processor generates both the modulated tone and the pip train from a
//! single sample-accurate phase accumulator, so tone and clicks are locked by
//! construction and parameters change without restarting anything (the
//! looping buffers it replaced never quite ran at the asked rate, had to be
//! rebuilt on every change, and dragged the carrier along with any drift).
//!
//! Every parameter is meant to be glided, not stepped: a preset moves them
//! all together along straight lines over a second and a half (beginGlide in
//! js/audio.js). So nothing below turns a gliding number into a switch. The
//! pip shape is two voices with a level each rather than a flag, the harmonic
//! count fades its top partial in by the fractional part rather than
//! rounding, the bilateral shape blends between its two curves, and a pip is
//! timed from the start of its own cycle rather than recomputed from the
//! phase, so a rate that moves mid-pip cannot move the pip.
//!
//! Linked to the visual (S.amLinked), that one phase is the strobe's own: the
//! flash is a formula of time (v1/core/signal.js, strobe_signal.rs here), the
//! page hands this node the formula's numbers whenever they change, and while
//! linked the phase is steered sample by sample onto the formula's phase,
//! shifted so the loud part of the pulse lands on the lit part of the flash
//! (flash_align, below). Free, it runs at the rate param exactly as it always
//! has. Either way the phase only ever moves forward and never jumps, so the
//! pips, timed from the start of each cycle, still fire once a cycle and stay
//! whole.
//!
//! Outputs: 0 is the tone and the pips (stereo), 1 the harmonics (stereo),
//! 2 the pips again, mono, for their reverb send.
//!
//! ---------- numbers ----------
//! The JS's arithmetic is f64, and so is this. Where it keeps state in a
//! Float32Array (the partials' pan and shimmer phases and rates, their
//! amplitudes) the state here is f32 too, so each write rounds where the
//! worklet's does. Math.random is the node's own Rng, seeded from NodeInit,
//! drawn in the same order, so a null test can seed both sides alike.
//!
//! ---------- messages ----------
//! protocol.json processor_messages, little-endian, no padding, a u32 type
//! first. In: 1 signal (f64 at_frame, p, r0, r1, dur, wave, duty, linked),
//! 2 meters (f64 on), 3 dipWatch (f64 on), 4 chirp (f64 sig, f64 xf,
//! u32 count, f32[count] table). Out, through events.port: 101 peaks (f32
//! tone, pulse, harm), 102 dip (f32 dip), 103 chirpAck (f64 sig). The signal's
//! anchor is an engine frame: where the JS reads `currentTime − at` in
//! seconds, this reads the same in the same steps (strobe_signal.rs tau_at).

use super::strobe_signal::{cycles_at, f64_at, or_zero, rate_at, tau_at, to_int32, truthy, u32_at};
use crate::events::Events;
use crate::node::{Activity, Bus, Node, NodeInit, ParamBlock, ParamSpec, Rate, RenderCtx, QUANTUM};
use crate::rng::Rng;
use std::f64::consts::{PI, TAU};

macro_rules! spec {
    ($n:expr, $d:expr, $lo:expr, $hi:expr, $r:ident) => {
        ParamSpec { name: $n, default: $d, min: $lo, max: $hi, rate: Rate::$r }
    };
}

/// The 27 params, in protocol.json's order. The comments are the worklet's.
static PARAMS: [ParamSpec; 27] = [
    // The pulse rate the phase runs at while free. Linked to the visual, once
    // the flash's formula has arrived, the formula sets the pace instead and
    // this only stands ready for the moment the link is let go (or for a
    // linked start before the first post).
    spec!("rate", 40.0, 0.05, 200.0, K),
    // How much the pulse envelope moves the tone and the harmonics: 1 is the
    // full pulse, 0 a steady tone at the pulse's peak. It is the Amplitude
    // modulation switch, glided rather than stepped, and it touches only the
    // envelope, never the phase: the rate runs on underneath at either end,
    // so the pips (timed from that same phase) never notice, and the pulse
    // comes back in step when the switch returns. a-rate like the levels, so
    // a glide moves the envelope sample by sample instead of per quantum.
    spec!("amDepth", 1.0, 0.0, 1.0, A),
    spec!("carrier", 200.0, 20.0, 20000.0, K),
    spec!("pipMs", 5.0, 0.1, 100.0, K),
    spec!("toneLevel", 0.0, 0.0, 1.0, A),
    // The click and the chirp each have their own level and their own reverb
    // send. Switching shape is then just one level going down while the other
    // comes up, and each only ever moves between its own two values, so the
    // chirp can never be heard at the click's level on the way through.
    spec!("clickLevel", 0.0, 0.0, 1.0, A),
    spec!("clickSend", 0.0, 0.0, 1.0, A),
    spec!("chirpLevel", 0.0, 0.0, 1.0, A),
    spec!("chirpSend", 0.0, 0.0, 1.0, A),
    spec!("clickModDepth", 0.0, 0.0, 1.0, K),
    spec!("clickModRate", 0.1, 0.005, 8.0, K),
    spec!("biDepth", 0.0, 0.0, 1.0, K),
    spec!("biRate", 1.0, 0.02, 4.0, K),
    // 0 is the sine sweep, 1 the hard switch, and anything between is a blend
    // of the two curves, so a preset can glide from one to the other.
    spec!("biHard", 1.0, 0.0, 1.0, K),
    spec!("harmLevel", 0.0, 0.0, 1.0, A),
    spec!("harmCount", 6.0, 1.0, 16.0, K),
    spec!("harmBright", 1.2, 0.1, 4.0, K),
    spec!("harmSpread", 0.7, 0.0, 1.0, K),
    spec!("harmPanRate", 0.15, 0.0, 4.0, K),
    spec!("shimDepth", 0.0, 0.0, 1.0, K),
    spec!("shimRate", 0.25, 0.01, 6.0, K),
    // The pip train's lowpass sweep. The cutoff travels between lo and hi on
    // a raised cosine, one full down-and-up every lpfPeriod seconds; wander
    // makes each half-sweep a different length and lets the dips stop short
    // of the floor, so the train sinks back irregularly instead of on a clock.
    spec!("lpfOn", 0.0, 0.0, 1.0, K),
    spec!("lpfLo", 400.0, 20.0, 20000.0, K),
    spec!("lpfHi", 9000.0, 20.0, 20000.0, K),
    spec!("lpfPeriod", 60.0, 0.5, 600.0, K),
    spec!("lpfQ", 0.707, 0.3, 10.0, K),
    spec!("lpfWander", 0.0, 0.0, 1.0, K),
];

// The params' places in PARAMS.
const P_RATE: usize = 0;
const P_AM_DEPTH: usize = 1;
const P_CARRIER: usize = 2;
const P_PIP_MS: usize = 3;
const P_TONE_LEVEL: usize = 4;
const P_CLICK_LEVEL: usize = 5;
const P_CLICK_SEND: usize = 6;
const P_CHIRP_LEVEL: usize = 7;
const P_CHIRP_SEND: usize = 8;
const P_CLICK_MOD_DEPTH: usize = 9;
const P_CLICK_MOD_RATE: usize = 10;
const P_BI_DEPTH: usize = 11;
const P_BI_RATE: usize = 12;
const P_BI_HARD: usize = 13;
const P_HARM_LEVEL: usize = 14;
const P_HARM_COUNT: usize = 15;
const P_HARM_BRIGHT: usize = 16;
const P_HARM_SPREAD: usize = 17;
const P_HARM_PAN_RATE: usize = 18;
const P_SHIM_DEPTH: usize = 19;
const P_SHIM_RATE: usize = 20;
const P_LPF_ON: usize = 21;
const P_LPF_LO: usize = 22;
const P_LPF_HI: usize = 23;
const P_LPF_PERIOD: usize = 24;
const P_LPF_Q: usize = 25;
const P_LPF_WANDER: usize = 26;

// ---------- locked to the flash ----------

/// Where on the strobe's cycle the genus lands while linked, as phases of the
/// flash's own cycle (0 is the cycle's start, where a square lights; a sine
/// or a triangle is brightest at 0.5). Robert's rule is that the sound is
/// loudest while the screen is lit. `pip` is where the pip fires and the
/// genus cycle begins; `peak` is where the tone's envelope (and the
/// harmonics', which share it) is at its loudest.
///
///   sine, triangle   both at 0.5, the flash's peak: the envelope is a raised
///                    cosine like the sine's own brightness, so the two swell
///                    and fade together, and the pip sits on the brightest
///                    moment.
///   square           the pip at 0, the onset, the instant the screen lights;
///                    the envelope's peak at duty / 2, the middle of the lit
///                    window, so the louder half of the pulse is the lit half.
///                    Under frame lock the duty is the lit frames' share
///                    (core/strobe.js signalDuty), so it centres on the
///                    frames actually lit.
///
/// This is the one place to tune it. Any change of either (a new wave, a new
/// duty) is glided, never stepped: the pip's by the lock below, the peak's by
/// ENV_SHIFT_S.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Align { pub pip: f64, pub peak: f64 }

pub fn flash_align(wave: i32, duty: f64) -> Align {
    if wave == 2 { Align { pip: 0.0, peak: duty / 2.0 } } else { Align { pip: 0.5, peak: 0.5 } }
}

/// How the phase is held on the formula. Each sample the phase advances by
/// the formula's own step (its rate at that moment) plus a pull toward the
/// formula's phase, the gap closing with a time constant of LOCK_TAU_S. In
/// steady running the gap is nothing and the pull is nothing. A gap opens
/// only when the formula itself jumps: the link switched on (the free phase
/// sits wherever it was), the formula arriving for the first time, the wave
/// changing (the pip's place moves by half a cycle), the clock estimate being
/// re-posted, or frame lock pinning the formula back onto its frame grid. The
/// pull is capped at LOCK_SLEW of the formula's step, so while a gap closes
/// the pulse runs between half and one and a half times its rate, and never
/// backward: a backward pin slows the phase rather than turning it round, so
/// no cycle boundary is crossed twice and no pip fires twice, and a forward
/// one hurries it, so no boundary is jumped and no pip is lost.
const LOCK_TAU_S: f64 = 0.05;
const LOCK_SLEW: f64 = 0.5;
/// The envelope's own shift from the pip (flash_align's peak less its pip)
/// glides to a new value over this time constant, and back to 0 when the
/// link is let go.
const ENV_SHIFT_S: f64 = 0.05;

/// Every harmonic gets its own pan phase and its own slightly different pan
/// rate, so they never settle into a single synchronised sweep.
const MAXH: usize = 16;

// ---------- the bilateral law ----------

/// The pips' placement between the ears at bilateral phase `ph`: a blend of
/// the hard switch (left for the first half, right for the second) and the
/// sine sweep, by `hard`, scaled by `depth`, through the equal-power law.
/// The tone is never placed; it stays centred so it keeps driving both ears
/// while the clicks alternate. Returns the left and right gains.
pub fn bilateral(depth: f64, hard: f64, ph: f64) -> (f64, f64) {
    if !(depth > 0.0) { return (1.0, 1.0); }
    let mut raw = 0.0;
    if hard > 0.0 { raw += hard * if ph < 0.5 { -1.0 } else { 1.0 }; }
    if hard < 1.0 { raw += (1.0 - hard) * (TAU * ph).sin(); }
    let pan = raw * depth;
    ((0.5 * (1.0 - pan)).sqrt(), (0.5 * (1.0 + pan)).sqrt())
}

/// The click pip: a sine at the carrier, `n` samples into its cycle at sine
/// phase `pip_ph`, decaying by 3.5 time constants over its length, and
/// nothing past its end.
#[inline]
pub fn pip(n: f64, pip_ph: f64, pip_samples: f64, decay: f64, sr: f64) -> f64 {
    if n < pip_samples { (TAU * pip_ph).sin() * (-(n / sr) * decay).exp() } else { 0.0 }
}

/// JS's Math.round: halves go up, toward +∞.
#[inline]
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

pub struct Genus {
    sr: f64,
    rng: Rng,
    phase: f64,
    cphase: f64,
    cmod_phase: f64,
    bi_phase: f64,
    /// Samples since the current cycle began, and the click pip's own sine
    /// phase. The pip used to find its place as phase / increment, which is
    /// right only while the rate holds still: a rate gliding under a pip that
    /// was sounding moved the pip's position within itself, and that step was
    /// a click. Counting from the cycle's start keeps each pip whole whatever
    /// the rate does, and a carrier that moves mid-pip bends it rather than
    /// jumping its phase.
    pip_n: f64,
    pip_ph: f64,

    /// The flash's formula (the anchor as an engine frame, the phase there,
    /// the rate and its ramp), whether the pulse is linked to it, and where
    /// on it the genus lands. Until the first post there is no formula and
    /// the phase runs free at the rate param even when linked. env_sh is the
    /// envelope's shift from the pip as it glides, 0 whenever the phase is
    /// free.
    sig_ok: bool,
    linked: bool,
    s_at: f64,
    s_p: f64,
    s_r0: f64,
    s_r1: f64,
    s_dur: f64,
    align: Align,
    env_sh: f64,
    lock_a: f64,
    env_a: f64,

    /// Lowpass sweep state. The sweep is a run of half-sweeps, each an eased
    /// move of the position (0 = the low cutoff, 1 = the high) from lpf_from
    /// to lpf_to; lpf_u is how far through the current one it is. lpf_log is
    /// the cutoff actually in use, in log Hz, smoothed toward the sweep so a
    /// toggle or a dial never steps it. Two filters, the dry pips and their
    /// reverb send.
    lpf_active: bool,
    lpf_was_on: bool,
    lpf_from: f64,
    lpf_to: f64,
    lpf_u: f64,
    lpf_mul: f64,
    lpf_log: f64,
    lb0: f64,
    lb1: f64,
    lb2: f64,
    la1: f64,
    la2: f64,
    dz1: f64,
    dz2: f64,
    sz1: f64,
    sz2: f64,

    /// The chirp is a fixed waveform for a given set of controls, so it is
    /// built once on the main thread (js/chirp.js) and shipped over rather
    /// than recomputed per sample here; playing it is a table read, cheaper
    /// than the pip's damped sine and immune to drift.
    ///
    /// A new table never replaces the old one outright, since a table swapped
    /// under a chirp that is sounding steps it. The two are crossfaded
    /// instead, over however long the main thread asks (the whole transition
    /// during a preset, a few milliseconds for a slider). A table that
    /// arrives while a crossfade is still running waits for it to finish, and
    /// only the newest waiting one is kept. An empty table is the same as
    /// none: the chirp falls back to the click's damped sine. The three are
    /// swapped, never reallocated, as tables come and go.
    chirp: Vec<f32>,
    chirp_old: Vec<f32>,
    chirp_next: Vec<f32>,
    has_next: bool,
    xf_left: f64,
    xf_len: f64,
    xf_next: f64,

    /// Meter taps. Tone, pips and harmonics leave folded into two outputs, so
    /// no analyser downstream can tell them apart. Each one's peak is taken
    /// at the point it is still its own signal and reported on its own clock
    /// (see report_peaks), which is cheaper than three extra outputs and
    /// exact. The page can switch the reports off while nothing reads them.
    pk_tone: f64,
    pk_pip: f64,
    pk_harm: f64,
    pk_frames: f64,
    meters_on: bool,
    /// The pips' loudness dip, reported on the same clock for the drawer's
    /// level bar: the share of the set level it leaves right now. Off until
    /// the page asks, and never sent while the depth is 0.
    dip_watch: bool,
    cmod_depth_now: f64,

    pan_phase: [f32; MAXH],
    pan_mul: [f32; MAXH],
    shim_phase: [f32; MAXH],
    shim_mul: [f32; MAXH],
    /// Each partial's normalised amplitude, this quantum's and the last's.
    /// Count and brightness are k-rate, so they arrive once per quantum; the
    /// amplitudes are interpolated across it from the last values to these,
    /// which turns a gliding count or brightness into a smooth curve instead
    /// of a staircase of 128-sample steps. Working them out once per quantum
    /// also takes a pow per partial per sample out of the loop.
    h_amp: [f32; MAXH],
    h_amp_prev: [f32; MAXH],
    h_top_prev: usize,
    h_primed: bool,
    h_count_in: f64,
    h_bright_in: f64,
    h_top_in: usize,
    /// Each partial's left and right gain (its pan and its shimmer folded
    /// together) at the start of the quantum, and how much it moves per
    /// sample across it. See block_gains.
    g_l: [f64; MAXH],
    d_l: [f64; MAXH],
    g_r: [f64; MAXH],
    d_r: [f64; MAXH],
}

impl Genus {
    pub fn new(init: &NodeInit) -> Self {
        let sr = init.sample_rate as f64;
        let mut rng = Rng::new(init.seed);
        let mut pan_phase = [0f32; MAXH];
        let mut pan_mul = [0f32; MAXH];
        let mut shim_phase = [0f32; MAXH];
        let mut shim_mul = [0f32; MAXH];
        for i in 0..MAXH {
            pan_phase[i] = rng.next_f64() as f32;
            pan_mul[i] = (0.65 + rng.next_f64() * 0.7) as f32;
            shim_phase[i] = rng.next_f64() as f32;
            shim_mul[i] = (0.55 + rng.next_f64() * 0.9) as f32;
        }
        let mut g = Genus {
            sr,
            rng,
            phase: 0.0,
            cphase: 0.0,
            cmod_phase: 0.0,
            bi_phase: 0.0,
            pip_n: 0.0,
            pip_ph: 0.0,
            sig_ok: false,
            linked: false,
            s_at: 0.0,
            s_p: 0.0,
            s_r0: 0.0,
            s_r1: 0.0,
            s_dur: 0.0,
            align: flash_align(0, 0.5),
            env_sh: 0.0,
            lock_a: 1.0 - (-1.0 / (LOCK_TAU_S * sr)).exp(),
            env_a: 1.0 - (-1.0 / (ENV_SHIFT_S * sr)).exp(),
            lpf_active: false,
            lpf_was_on: false,
            lpf_from: 1.0,
            lpf_to: 0.0,
            lpf_u: 0.0,
            lpf_mul: 1.0,
            lpf_log: 0.0,
            lb0: 1.0,
            lb1: 0.0,
            lb2: 0.0,
            la1: 0.0,
            la2: 0.0,
            dz1: 0.0,
            dz2: 0.0,
            sz1: 0.0,
            sz2: 0.0,
            chirp: Vec::new(),
            chirp_old: Vec::new(),
            chirp_next: Vec::new(),
            has_next: false,
            xf_left: 0.0,
            xf_len: 1.0,
            xf_next: 1.0,
            pk_tone: 0.0,
            pk_pip: 0.0,
            pk_harm: 0.0,
            pk_frames: 0.0,
            meters_on: true,
            dip_watch: false,
            cmod_depth_now: 0.0,
            pan_phase,
            pan_mul,
            shim_phase,
            shim_mul,
            h_amp: [0.0; MAXH],
            h_amp_prev: [0.0; MAXH],
            h_top_prev: 0,
            h_primed: false,
            h_count_in: f64::NAN,
            h_bright_in: f64::NAN,
            h_top_in: 0,
            g_l: [0.0; MAXH],
            d_l: [0.0; MAXH],
            g_r: [0.0; MAXH],
            d_r: [0.0; MAXH],
        };
        g.lpf_log = g.lpf_ceil().ln();
        g
    }

    /// Posted on its own clock rather than per quantum: 128 frames is under
    /// three milliseconds, far faster than any meter can be read, and each
    /// window reports the loudest sample in it so a pip transient is never
    /// missed between reads.
    fn report_peaks(&mut self, frames: usize, node: u32, events: &mut Events) {
        self.pk_frames += frames as f64;
        if self.pk_frames < self.sr / 50.0 { return; } // ~20 ms
        self.pk_frames = 0.0;
        if self.meters_on {
            let mut m = [0u8; 16];
            m[0..4].copy_from_slice(&101u32.to_le_bytes());
            m[4..8].copy_from_slice(&(self.pk_tone as f32).to_le_bytes());
            m[8..12].copy_from_slice(&(self.pk_pip as f32).to_le_bytes());
            m[12..16].copy_from_slice(&(self.pk_harm as f32).to_le_bytes());
            events.port(node, &m);
        }
        if self.dip_watch && self.cmod_depth_now > 0.0 {
            // the very curve the pips ride below, at the phase they have reached
            let dip = 1.0 - self.cmod_depth_now * 0.5 * (1.0 - (2.0 * PI * self.cmod_phase).cos());
            let mut m = [0u8; 8];
            m[0..4].copy_from_slice(&102u32.to_le_bytes());
            m[4..8].copy_from_slice(&(dip as f32).to_le_bytes());
            events.port(node, &m);
        }
        self.pk_tone = 0.0;
        self.pk_pip = 0.0;
        self.pk_harm = 0.0;
    }

    /// The harmonic count is fractional while it glides: 6.4 is six partials
    /// at full weight and a seventh at 0.4, so partials fade in and out one at
    /// a time instead of popping. Partial k (the (k+2)th harmonic) weighs
    /// (k+2)^−bright, and the stack is normalised to unity. Returns how many
    /// partials carry any weight.
    pub fn harm_amps(&mut self, count_f: f64, bright: f64) -> usize {
        // Both are k-rate and sit still nearly all the time, so the sixteen
        // pows are only redone when one of them has moved.
        if self.h_primed && count_f == self.h_count_in && bright == self.h_bright_in { return self.h_top_in; }
        self.h_count_in = count_f;
        self.h_bright_in = bright;
        let c = (MAXH as f64).min(count_f.max(1.0));
        let whole = c.floor();
        let frac = c - whole;
        let top = if frac > 1e-6 { whole + 1.0 } else { whole };
        let mut sum = 0.0;
        for k in 0..MAXH {
            let kf = k as f64;
            let mut a = 0.0;
            if kf < whole { a = (kf + 2.0).powf(-bright); }
            else if kf < top { a = frac * (kf + 2.0).powf(-bright); }
            self.h_amp[k] = a as f32;
            sum += a;
        }
        // the sum used to keep the stack at unity
        let norm = if sum > 0.0 { 1.0 / sum } else { 0.0 };
        let top = top as usize;
        for k in 0..top { self.h_amp[k] = (self.h_amp[k] as f64 * norm) as f32; }
        if !self.h_primed {
            self.h_amp_prev = self.h_amp;
            self.h_top_prev = top;
            self.h_primed = true;
        }
        self.h_top_in = top;
        top
    }

    /// The partials' amplitudes as harm_amps last left them.
    pub fn amps(&self) -> &[f32; MAXH] { &self.h_amp }

    /// The pan and shimmer oscillators run at a few hertz at most (a 4 Hz pan
    /// rate times a 1.35 spread, a 6 Hz shimmer times 1.45), so across one
    /// quantum each moves through well under a hundredth of its cycle and the
    /// curve it traces is a straight line to within a part in a hundred
    /// thousand. So each partial's gains are worked out at the quantum's two
    /// ends and drawn as a line between them, rather than as a cosine, a sine
    /// and two square roots per partial per sample. The phases still advance
    /// by exactly the same amount per quantum.
    fn block_gains(&mut self, n_parts: usize, spread: f64, pan_inc: f64, shim_depth: f64, shim_inc: f64, len: usize) {
        let lenf = len as f64;
        let inv = 1.0 / lenf;
        for k in 0..n_parts {
            let p0 = self.pan_phase[k] as f64;
            let p1 = p0 + pan_inc * self.pan_mul[k] as f64 * lenf;
            let pan0 = (TAU * p0).sin() * spread;
            let pan1 = (TAU * p1).sin() * spread;
            self.pan_phase[k] = (p1 - p1.floor()) as f32;
            let (mut s0, mut s1) = (1.0, 1.0);
            if shim_depth > 0.0 {
                let q0 = self.shim_phase[k] as f64;
                let q1 = q0 + shim_inc * self.shim_mul[k] as f64 * lenf;
                s0 = 1.0 - shim_depth * 0.5 * (1.0 - (TAU * q0).cos());
                s1 = 1.0 - shim_depth * 0.5 * (1.0 - (TAU * q1).cos());
                self.shim_phase[k] = (q1 - q1.floor()) as f32;
            }
            let l0 = s0 * (0.5 * (1.0 - pan0)).sqrt();
            let l1 = s1 * (0.5 * (1.0 - pan1)).sqrt();
            let r0 = s0 * (0.5 * (1.0 + pan0)).sqrt();
            let r1 = s1 * (0.5 * (1.0 + pan1)).sqrt();
            self.g_l[k] = l0;
            self.d_l[k] = (l1 - l0) * inv;
            self.g_r[k] = r0;
            self.d_r[k] = (r1 - r0) * inv;
        }
    }

    /// The top of the filter's travel, where it is as good as open. Clamped
    /// under Nyquist so the coefficients stay stable at 44.1 kHz.
    fn lpf_ceil(&self) -> f64 { 20000f64.min(self.sr * 0.45) }

    /// Where a dip bottoms out: the floor with no wander, anywhere in the
    /// lower two thirds of the travel with full wander.
    fn lpf_floor(&mut self, w: f64) -> f64 { if w > 0.0 { self.rng.next_f64() * 0.66 * w } else { 0.0 } }

    /// Advances the sweep by one quantum and sets this quantum's biquad
    /// coefficients (RBJ lowpass, Q as a plain ratio here, not the biquad
    /// node's dB). The cutoff moves slowly enough that once per 128 samples
    /// is indistinguishable from per sample.
    fn lpf_block(&mut self, p: &[ParamBlock], len: usize) {
        let on = p[P_LPF_ON].first() as f64 > 0.5;
        let ceil = self.lpf_ceil();
        if on && !self.lpf_was_on {
            // switched on: start at the top and head down, so it enters from open
            self.lpf_from = 1.0;
            self.lpf_to = self.lpf_floor(p[P_LPF_WANDER].first() as f64);
            self.lpf_u = 0.0;
            self.lpf_mul = 1.0;
            // fresh memory only if it had fully let go; re-enabled mid-glide
            // it keeps ringing through, or the reset would tick
            if !self.lpf_active { self.dz1 = 0.0; self.dz2 = 0.0; self.sz1 = 0.0; self.sz2 = 0.0; }
            self.lpf_active = true;
        }
        self.lpf_was_on = on;
        let mut target = ceil.ln();
        if on {
            let half = 0.5 * p[P_LPF_PERIOD].first() as f64 * self.lpf_mul;
            self.lpf_u += len as f64 / (half * self.sr);
            if self.lpf_u >= 1.0 {
                // a turnaround: the next half-sweep goes the other way, with
                // its own length and, on the way down, its own depth when
                // wander is up
                let w = p[P_LPF_WANDER].first() as f64;
                self.lpf_from = self.lpf_to;
                self.lpf_to = if self.lpf_from > 0.5 { self.lpf_floor(w) } else { 1.0 };
                self.lpf_u = 0.0;
                self.lpf_mul = 2f64.powf((self.rng.next_f64() * 2.0 - 1.0) * 1.5 * w);
            }
            let e = 0.5 - 0.5 * (PI * self.lpf_u.min(1.0)).cos();
            let pos = self.lpf_from + (self.lpf_to - self.lpf_from) * e;
            let lo = ceil.min(p[P_LPF_LO].first() as f64).ln();
            let hi = ceil.min(p[P_LPF_HI].first() as f64).ln();
            target = lo + (hi - lo) * pos;
        }
        // ~0.25 s smoothing: a toggle glides the filter open or shut, a dial glides
        self.lpf_log += (target - self.lpf_log) * (1.0 - (-(len as f64) / (0.25 * self.sr)).exp());
        if !on && self.lpf_log > ceil.ln() - 0.005 {
            self.lpf_active = false;
            self.dz1 = 0.0; self.dz2 = 0.0; self.sz1 = 0.0; self.sz2 = 0.0;
            return;
        }
        let f = self.lpf_log.exp();
        let w0 = 2.0 * PI * f / self.sr;
        let cw = w0.cos();
        let alpha = w0.sin() / (2.0 * p[P_LPF_Q].first() as f64);
        let a0 = 1.0 + alpha;
        self.lb0 = (1.0 - cw) * 0.5 / a0;
        self.lb1 = (1.0 - cw) / a0;
        self.lb2 = self.lb0;
        self.la1 = -2.0 * cw / a0;
        self.la2 = (1.0 - alpha) / a0;
    }

    /// Where the flash's formula has the genus cycle at sample `i` of the
    /// quantum at engine frame `frame`: the formula's phase less the pip's
    /// place, 0 to 1, and the formula's own step per sample there.
    #[inline]
    fn sig_at(&self, frame: u64, i: usize, pip_at: f64) -> (f64, f64) {
        let tau = tau_at(frame, self.s_at, i, self.sr);
        let mut x = self.s_p + cycles_at(tau, self.s_r0, self.s_r1, self.s_dur) - pip_at;
        x -= x.floor();
        (x, rate_at(tau, self.s_r0, self.s_r1, self.s_dur) / self.sr)
    }
}

impl Node for Genus {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }
    fn inputs(&self) -> usize { 0 }
    fn outputs(&self) -> usize { 3 }
    /// 0: tone and pips, 1: harmonics, 2: the pips' reverb send.
    fn output_channels(&self, o: usize, _input_channels: &[usize]) -> usize { if o == 2 { 1 } else { 2 } }
    /// It has no inputs to wake it, and its phase, its sweeps and its meters
    /// run on through silence, so it is rendered every quantum: idle, it
    /// writes zeros flagged silent and says so, which costs almost nothing.
    fn tail_frames(&self) -> f64 { f64::INFINITY }

    fn render(&mut self, ctx: &mut RenderCtx, outs: &mut [Bus]) -> Activity {
        let p = ctx.params;
        let sr = self.sr;
        let len = QUANTUM;
        let rate = p[P_RATE].first() as f64;
        let carrier = p[P_CARRIER].first() as f64;
        // a-rate: these arrive as a value per sample while automating, and as
        // a single value when steady. Reading them per sample is what removes
        // the step at each quantum boundary that a k-rate gain produces.
        let tl_p = p[P_TONE_LEVEL];
        let cl_p = p[P_CLICK_LEVEL];
        let chl_p = p[P_CHIRP_LEVEL];
        let cs_p = p[P_CLICK_SEND];
        let hs_p = p[P_CHIRP_SEND];
        let ad_p = p[P_AM_DEPTH];
        let hl_p = p[P_HARM_LEVEL];
        let pip_sec = p[P_PIP_MS].first() as f64 / 1000.0;
        let pip_samples = (pip_sec * sr).max(2.0);
        let decay = 3.5 / pip_sec;
        let inc = rate / sr;
        let cinc = carrier / sr;
        let h_spread = p[P_HARM_SPREAD].first() as f64;
        let h_pan_inc = p[P_HARM_PAN_RATE].first() as f64 / sr;
        let bi_depth = p[P_BI_DEPTH].first() as f64;
        let bi_inc = p[P_BI_RATE].first() as f64 / sr;
        let bi_hard = p[P_BI_HARD].first() as f64;
        let cmod_depth = p[P_CLICK_MOD_DEPTH].first() as f64;
        let cmod_inc = p[P_CLICK_MOD_RATE].first() as f64 / sr;
        self.cmod_depth_now = cmod_depth;
        let shim_depth = p[P_SHIM_DEPTH].first() as f64;
        let shim_inc = p[P_SHIM_RATE].first() as f64 / sr;
        // Locked to the flash (see flash_align and LOCK_TAU_S above): the
        // envelope shift the glide heads for. Free, none of it is touched and
        // the rate param drives the phase alone.
        let lock = self.linked && self.sig_ok;
        let pip_at = self.align.pip;
        let env_to = if lock { self.align.peak - pip_at } else { 0.0 };
        let (lock_a, env_a) = (self.lock_a, self.env_a);
        self.lpf_block(p, len);

        // A waiting chirp table starts its crossfade once the last one has done.
        if self.has_next && self.xf_left <= 0.0 {
            std::mem::swap(&mut self.chirp_old, &mut self.chirp);
            std::mem::swap(&mut self.chirp, &mut self.chirp_next);
            self.chirp_next.clear();
            self.has_next = false;
            self.xf_len = self.xf_next;
            self.xf_left = self.xf_next;
        }

        let h_top = self.harm_amps(p[P_HARM_COUNT].first() as f64, p[P_HARM_BRIGHT].first() as f64);
        let h_loop = h_top.max(self.h_top_prev);

        // idle only when every level is steady at zero; mid-ramp values must render
        let still_zero = |b: &ParamBlock| matches!(b, ParamBlock::Const(v) if *v <= 0.0);
        if still_zero(&tl_p) && still_zero(&cl_p) && still_zero(&chl_p) && still_zero(&hl_p)
            && still_zero(&cs_p) && still_zero(&hs_p)
        {
            for o in outs.iter_mut() { o.zero(); }
            if lock {
                // nothing is sounding, so the phase is simply put where the
                // flash has it at the quantum's end, with no glide to hear
                let (x, fi) = self.sig_at(ctx.frame, len, pip_at);
                self.phase = x;
                self.pip_n = if fi > 0.0 { self.phase / fi } else { 1e7 };
            } else {
                self.phase = (self.phase + inc * len as f64) % 1.0;
                self.pip_n = self.phase / inc;
            }
            self.env_sh = env_to;
            self.cphase = (self.cphase + cinc * len as f64) % 1.0;
            self.cmod_phase = (self.cmod_phase + cmod_inc * len as f64) % 1.0;
            self.bi_phase = (self.bi_phase + bi_inc * len as f64) % 1.0;
            self.pip_ph = (self.pip_n * cinc) % 1.0;
            self.xf_left = (self.xf_left - len as f64).max(0.0);
            self.h_amp_prev = self.h_amp;
            self.h_top_prev = h_top;
            self.report_peaks(len, ctx.node, ctx.events);
            return Activity::Silent;
        }

        let mut pk_t = self.pk_tone;
        let mut pk_p = self.pk_pip;
        let mut pk_h = self.pk_harm;
        let mut xf_left = self.xf_left;
        let xf_len = self.xf_len;
        let inv_len = 1.0 / len as f64;
        // Whether the harmonics sound anywhere in this quantum; only then do
        // their pan and shimmer oscillators move.
        let harm_on = !hl_p.is_const() || hl_p.first() > 0.0;
        if harm_on { self.block_gains(h_loop, h_spread, h_pan_inc, shim_depth, shim_inc, len); }
        let lpf = self.lpf_active;
        let (lb0, lb1, lb2, la1, la2) = (self.lb0, self.lb1, self.lb2, self.la1, self.la2);
        let (mut dz1, mut dz2, mut sz1, mut sz2) = (self.dz1, self.dz2, self.sz1, self.sz2);
        let (mut phase, mut cphase, mut pip_n, mut pip_ph) = (self.phase, self.cphase, self.pip_n, self.pip_ph);
        let (mut cmod_phase, mut bi_phase, mut env_sh) = (self.cmod_phase, self.bi_phase, self.env_sh);
        let chirp: &[f32] = &self.chirp;
        let old: &[f32] = &self.chirp_old;
        let has_chirp = !chirp.is_empty();
        let has_old = !old.is_empty();
        let (amp, amp_prev) = (&self.h_amp, &self.h_amp_prev);
        let (g_l, d_l, g_r, d_r) = (&self.g_l, &self.d_l, &self.g_r, &self.d_r);

        let (o0, rest) = outs.split_at_mut(1);
        let (o1, o2) = rest.split_at_mut(1);
        let [out_l, out_r] = &mut o0[0].data;
        let [h_l, h_r] = &mut o1[0].data;
        let c_out = &mut o2[0].data[0];

        for i in 0..len {
            let tl = tl_p.at(i) as f64;
            let cl = cl_p.at(i) as f64;
            let chl = chl_p.at(i) as f64;
            let cs = cs_p.at(i) as f64;
            let hs = hs_p.at(i) as f64;
            let hl = hl_p.at(i) as f64;
            let harm_now = harm_on && hl > 0.0;
            // The carrier's sine and the pulse envelope are shared by the tone
            // and the harmonics, so each is computed once a sample, and only
            // if needed.
            let mut env = 0.0;
            let mut sc = 0.0;
            if tl > 0.0 || harm_now {
                // peaks with the pip (or, linked, env_sh after it: see
                // flash_align); the depth only ever pulls the troughs up
                // toward the peak (at full depth this is 0.75 + 0.25 cos)
                let ad = ad_p.at(i) as f64;
                env = if ad > 0.0 { 1.0 - 0.25 * ad * (1.0 - (TAU * (phase - env_sh)).cos()) } else { 1.0 };
                sc = (TAU * cphase).sin();
            }
            let mut v = 0.0;
            if tl > 0.0 { v += tl * sc * env; }
            // The two pip voices. The chirp falls back to the click's damped
            // sine while no table has arrived yet.
            let mut pc = 0.0;
            let mut ph = 0.0;
            let n = pip_n; // samples into the cycle
            if cl > 0.0 || chl > 0.0 || cs > 0.0 || hs > 0.0 {
                pc = pip(n, pip_ph, pip_samples, decay, sr);
                if chl > 0.0 || hs > 0.0 {
                    let k = n as usize; // `n | 0`: n is never negative
                    ph = if has_chirp { if k < chirp.len() { chirp[k] as f64 } else { 0.0 } } else { pc };
                    if xf_left > 0.0 {
                        let o = if has_old { if k < old.len() { old[k] as f64 } else { 0.0 } } else { pc };
                        ph += (o - ph) * (xf_left / xf_len);
                    }
                }
            }
            if xf_left > 0.0 { xf_left -= 1.0; }
            // slow loudness modulation on the pips alone; only ever dips
            // below the set click level, never above it
            let mut cmod = 1.0;
            if cmod_depth > 0.0 { cmod = 1.0 - cmod_depth * 0.5 * (1.0 - (TAU * cmod_phase).cos()); }
            cmod_phase += cmod_inc;
            if cmod_phase >= 1.0 { cmod_phase -= 1.0; }

            // bilateral placement applies to the pips alone; the tone stays
            // centred so it keeps driving both ears while the clicks alternate
            let (bl, br) = bilateral(bi_depth, bi_hard, bi_phase);
            bi_phase += bi_inc;
            if bi_phase >= 1.0 { bi_phase -= 1.0; }

            let mut pip_out = (cl * pc + chl * ph) * cmod;
            let mut send = (cs * pc + hs * ph) * cmod;
            if lpf {
                // transposed direct form II, one state pair per signal
                let yd = lb0 * pip_out + dz1;
                dz1 = lb1 * pip_out - la1 * yd + dz2;
                dz2 = lb2 * pip_out - la2 * yd;
                pip_out = yd;
                let ys = lb0 * send + sz1;
                sz1 = lb1 * send - la1 * ys + sz2;
                sz2 = lb2 * send - la2 * ys;
                send = ys;
            }
            let av = v.abs();
            if av > pk_t { pk_t = av; }
            let ap = pip_out.abs();
            if ap > pk_p { pk_p = ap; }
            c_out[i] = send as f32;
            out_l[i] = (v + pip_out * bl) as f32;
            out_r[i] = (v + pip_out * br) as f32;

            if harm_now {
                let f = (i + 1) as f64 * inv_len;
                // Partial n's sine comes from the two below it, sin((n+1)x) =
                // 2cos(x)sin(nx) − sin((n−1)x), exact in double precision this
                // far up, so the whole stack costs one cosine a sample instead
                // of a sine per partial. The partials start at the second,
                // sin(2x) = 2cos(x)sin(x).
                let c2 = 2.0 * (TAU * cphase).cos();
                let mut s_prev = sc;
                let mut s_cur = c2 * sc;
                let mut l = 0.0;
                let mut r = 0.0;
                let fi = i as f64;
                for k in 0..h_loop {
                    let ap = amp_prev[k] as f64;
                    let a = ap + (amp[k] as f64 - ap) * f;
                    let sig = s_cur * a;
                    l += sig * (g_l[k] + d_l[k] * fi);
                    r += sig * (g_r[k] + d_r[k] * fi);
                    let s_next = c2 * s_cur - s_prev;
                    s_prev = s_cur;
                    s_cur = s_next;
                }
                // the same envelope as the tone, so the harmonics reinforce
                // the pulse rather than filling in its troughs
                let g = hl * env;
                let vl = l * g;
                let vr = r * g;
                h_l[i] = vl as f32;
                h_r[i] = vr as f32;
                if vl.abs() > pk_h { pk_h = vl.abs(); }
                if vr.abs() > pk_h { pk_h = vr.abs(); }
            } else {
                h_l[i] = 0.0;
                h_r[i] = 0.0;
            }

            // The phase's step: the rate param's, free; linked, the formula's
            // own step at this sample plus the capped pull onto its phase
            // (see LOCK_TAU_S), which is always forward. The envelope's shift
            // glides toward its place, and back to exactly 0 once the link is
            // let go.
            let mut step = inc;
            if lock {
                let (x, fi) = self.sig_at(ctx.frame, i, pip_at);
                let mut gap = x - phase;
                gap -= js_round(gap); // the near way round, −0.5..0.5
                let mut pull = gap * lock_a;
                let cap = LOCK_SLEW * fi;
                if pull > cap { pull = cap; } else if pull < -cap { pull = -cap; }
                step = fi + pull;
            }
            let sh = env_sh;
            if sh != env_to {
                let d = env_to - sh;
                env_sh = if d < 1e-6 && d > -1e-6 { env_to } else { sh + env_a * d };
            }
            phase += step;
            if phase >= 1.0 {
                phase -= 1.0;
                // a new cycle, and a new pip, starting this far past the boundary
                pip_n = if step > 0.0 { phase / step } else { 0.0 };
                pip_ph = pip_n * cinc;
            } else {
                pip_n += 1.0;
                pip_ph += cinc;
                if pip_ph >= 1.0 { pip_ph -= 1.0; }
            }
            cphase += cinc;
            if cphase >= 1.0 { cphase -= 1.0; }
        }
        for o in outs.iter_mut() { o.silent = false; }
        self.phase = phase;
        self.cphase = cphase;
        self.pip_n = pip_n;
        self.pip_ph = pip_ph;
        self.cmod_phase = cmod_phase;
        self.bi_phase = bi_phase;
        self.env_sh = env_sh;
        self.xf_left = xf_left;
        if xf_left <= 0.0 { self.chirp_old.clear(); }
        // flushed to zero once the pips have rung out, so the silence between
        // them never drifts into denormals
        let tiny = 1e-25;
        let flush = |x: f64| if x.abs() < tiny { 0.0 } else { x };
        self.dz1 = flush(dz1);
        self.dz2 = flush(dz2);
        self.sz1 = flush(sz1);
        self.sz2 = flush(sz2);
        self.h_amp_prev = self.h_amp;
        self.h_top_prev = h_top;
        self.pk_tone = pk_t;
        self.pk_pip = pk_p;
        self.pk_harm = pk_h;
        self.report_peaks(len, ctx.node, ctx.events);
        Activity::Active
    }

    fn message(&mut self, bytes: &[u8], node: u32, events: &mut Events) {
        match u32_at(bytes, 0) {
            Some(1) => {
                // the flash's formula and the link, posted only when one changes
                let g = |k: usize| f64_at(bytes, 4 + 8 * k);
                self.s_at = or_zero(g(0));
                self.s_p = or_zero(g(1));
                self.s_r0 = or_zero(g(2));
                self.s_r1 = or_zero(g(3));
                self.s_dur = or_zero(g(4));
                let duty = g(6);
                self.align = flash_align(to_int32(g(5)), if duty.is_nan() { 0.5 } else { duty });
                self.linked = truthy(g(7));
                self.sig_ok = true;
            }
            Some(2) => self.meters_on = truthy(f64_at(bytes, 4)),
            Some(3) => self.dip_watch = truthy(f64_at(bytes, 4)),
            Some(4) => {
                let sig = f64_at(bytes, 4);
                let xf = f64_at(bytes, 12);
                let count = u32_at(bytes, 20).unwrap_or(0) as usize;
                let table = bytes.get(24..).unwrap_or(&[]);
                let count = count.min(table.len() / 4);
                self.chirp_next.clear();
                self.chirp_next.extend(
                    table[..count * 4].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])),
                );
                self.has_next = true;
                self.xf_next = js_round((if xf > 0.0 { xf } else { 0.03 }) * self.sr).max(1.0);
                // Say which table is in hand. A post made while the context
                // was still suspended can be lost before it ever reaches
                // here, and without an acknowledgement the page cannot tell
                // that from a delivery.
                let mut m = [0u8; 12];
                m[0..4].copy_from_slice(&103u32.to_le_bytes());
                m[4..12].copy_from_slice(&sig.to_le_bytes());
                events.port(node, &m);
            }
            _ => {}
        }
    }
}
