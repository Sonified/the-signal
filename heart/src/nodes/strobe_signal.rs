//! The strobe's own flash as a signal, for every Vary with strobe stage
//! (js/strobe-am.js): one of these feeds them all. The port of js/worklet.js's
//! 'strobe-signal' processor.
//!
//! It is not a clock of its own and it chases nothing. The flash is one
//! formula of time (v1/core/signal.js), and this runs that formula at every
//! sample's own time, handed the formula's numbers by the page whenever they
//! change: the anchor, the phase there, the rate and its ramp, the wave, the
//! duty, and whether the flicker shows. Between changes there is nothing to
//! tell it; the screen and this are each just reading the same law at their
//! own moment.
//!
//! Out comes 2 × shape − 1: +1 lit, −1 dark. With the flicker stopped
//! (paused) it eases over a twentieth of a second to +1, the steady lit level
//! the field holds, and back when it starts. A millisecond's smoothing keeps a
//! square's edges, and the rare re-anchor of the phase, from clicking.
//!
//! The law itself (cycles_at, rate_at, wave_shape) lives here once, for this
//! node and for genus, which reads the first two for its phase while linked
//! to the visual. They are v1/core/signal.js's cyclesAt, rateAt and
//! waveShape, which js/worklet.js copies as sigCycles, sigRate and sigShape;
//! a change to any of them there must be made here too.
//!
//! ---------- time ----------
//! The JS reads its anchor in context seconds against `currentTime`. Here the
//! anchor arrives as an engine frame, so the formula is evaluated on the same
//! frame clock every stage shares, and a sample's time since the anchor is
//! worked out in the worklet's own steps (tau_at): the quantum's time less
//! the anchor's, then i sample periods on. Worked out any other way, as
//! (frame + i − at_frame) / sampleRate say, it can differ in the last bit,
//! and a square's edge falls on whichever side that bit says.
//!
//! ---------- replicas ----------
//! This node is made once on every stage that uses it, and every message goes
//! to every replica (documents/heart-audio-engine.md 7.4). The formula is a
//! pure function of the frame clock, so the replicas agree on it exactly. The
//! two smoothers (the millisecond's ease and the hold) carry history, though,
//! so a message has to land on the same frame everywhere for the replicas to
//! agree to the bit. A message whose anchor lies ahead of the frame being
//! rendered therefore waits for it and takes effect on exactly that sample;
//! one whose anchor has passed takes effect at once, as the worklet's would.
//! The page can make every change land on a known frame by anchoring the
//! formula ahead of every stage's render horizon; the formula allows that
//! without changing it (fold it forward: at' = at + Δ, p' = p + cycles(Δ),
//! r0' = rate(Δ), and the ramp's remainder).
//!
//! ---------- the message ----------
//! protocol.json processor_messages.strobe_signal_in, little-endian, no
//! padding: u32 type 1, then f64 at_frame, p, r0, r1, dur, wave, duty, on.

use crate::events::Events;
use crate::node::{Activity, Bus, Node, NodeInit, RenderCtx, QUANTUM};

// ---------- the law ----------

/// Cycles since the anchor, tau seconds after it. Before the anchor (a reader
/// whose clock sits a hair behind the writer's) it runs back at r0. A rate
/// ramping from r0 to r1 over dur seconds integrates to the quadratic, then
/// holds at r1.
#[inline]
pub(crate) fn cycles_at(tau: f64, r0: f64, r1: f64, dur: f64) -> f64 {
    // `!(dur > 0)` rather than `dur <= 0`: a NaN duration is no ramp.
    if tau <= 0.0 || !(dur > 0.0) { return r0 * tau; }
    if tau < dur { return r0 * tau + (r1 - r0) * tau * tau / (2.0 * dur); }
    (r0 + r1) * 0.5 * dur + r1 * (tau - dur)
}

/// The formula's rate, tau seconds after the anchor.
#[inline]
pub(crate) fn rate_at(tau: f64, r0: f64, r1: f64, dur: f64) -> f64 {
    if tau <= 0.0 || !(dur > 0.0) { return r0; }
    if tau < dur { r0 + (r1 - r0) * tau / dur } else { r1 }
}

/// How lit the strobe is at phase p, 0 to 1: a square lit for the first
/// `duty` of the cycle (wave 2), a triangle (1), or a raised cosine (0).
#[inline]
pub(crate) fn wave_shape(wave: i32, duty: f64, p: f64) -> f64 {
    if wave == 2 { return if p < duty { 1.0 } else { 0.0 }; }
    if wave == 1 { return if p < 0.5 { p * 2.0 } else { 2.0 - p * 2.0 }; }
    0.5 * (1.0 - (std::f64::consts::TAU * p).cos())
}

// ---------- the wire ----------

/// Seconds from the anchor (an engine frame) to sample `i` of the quantum at
/// engine frame `frame`, as the worklets have it: `currentTime − at`, with
/// currentTime = frame / sampleRate, plus i · (1 / sampleRate).
#[inline]
pub(crate) fn tau_at(frame: u64, at_frame: f64, i: usize, sr: f64) -> f64 {
    (frame as f64 / sr - at_frame / sr) + i as f64 * (1.0 / sr)
}

/// The f64 at byte `off` of a message, or NaN past its end.
#[inline]
pub(crate) fn f64_at(b: &[u8], off: usize) -> f64 {
    match b.get(off..off + 8) {
        Some(s) => f64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]),
        None => f64::NAN,
    }
}

/// The u32 at byte `off` of a message, or None past its end.
#[inline]
pub(crate) fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// JS's `+x || 0`: a number, with NaN (and -0) read as 0.
#[inline]
pub(crate) fn or_zero(x: f64) -> f64 { if x.is_nan() || x == 0.0 { 0.0 } else { x } }

/// JS's `x | 0`: ToInt32, truncating toward zero and wrapping.
#[inline]
pub(crate) fn to_int32(x: f64) -> i32 {
    if !x.is_finite() { return 0; }
    (x.trunc().rem_euclid(4294967296.0) as u64 as u32) as i32
}

/// JS's `!!x` on a number.
#[inline]
pub(crate) fn truthy(x: f64) -> bool { !(x == 0.0 || x.is_nan()) }

// ---------- the node ----------

/// The formula's numbers, as one message carries them.
#[derive(Clone, Copy)]
struct Formula {
    /// The anchor, an engine frame (may be fractional).
    at: f64,
    p: f64,
    r0: f64,
    r1: f64,
    dur: f64,
    wave: i32,
    duty: f64,
    on: bool,
}

/// Messages whose anchors lie ahead, oldest first. Eight is far more than a
/// lookahead's worth of changes (the writer folds a few times a second at
/// most outside a drag); should it ever fill, the oldest takes effect at once.
const PENDING: usize = 8;

pub struct StrobeSignal {
    sample_rate: f64,
    f: Formula,
    /// The output's smoothing and the ease to lit.
    y: f64,
    hold: f64,
    a: f64,
    h: f64,
    pending: [Formula; PENDING],
    n_pending: usize,
    /// The frame the next render starts at, so a message can tell whether
    /// its anchor is still ahead.
    next_frame: f64,
}

impl StrobeSignal {
    pub fn new(init: &NodeInit) -> Self {
        let sr = init.sample_rate as f64;
        StrobeSignal {
            sample_rate: sr,
            // Until the page's first word, a steady 7.5 Hz square held lit.
            f: Formula { at: 0.0, p: 0.0, r0: 7.5, r1: 7.5, dur: 0.0, wave: 2, duty: 0.5, on: false },
            // Starting at rest, lit.
            y: 1.0,
            hold: 1.0,
            a: 1.0 - (-1.0 / (0.001 * sr)).exp(),
            h: 1.0 - (-1.0 / (0.05 * sr)).exp(),
            pending: [Formula { at: 0.0, p: 0.0, r0: 0.0, r1: 0.0, dur: 0.0, wave: 0, duty: 0.0, on: false }; PENDING],
            n_pending: 0,
            next_frame: 0.0,
        }
    }

    /// Takes the oldest waiting message off the queue and makes it current.
    fn apply_front(&mut self) {
        self.f = self.pending[0];
        self.pending.copy_within(1..self.n_pending, 0);
        self.n_pending -= 1;
    }

    /// The first frame on which the oldest waiting message applies.
    fn front_frame(&self) -> Option<f64> {
        if self.n_pending == 0 { None } else { Some(self.pending[0].at.ceil()) }
    }

    /// Renders samples [i0, i1) of the quantum with the current formula.
    fn run(&mut self, frame: u64, out: &mut [f32; QUANTUM], i0: usize, i1: usize) {
        let f = self.f;
        let (a, h) = (self.a, self.h);
        let hold_to = if f.on { 0.0 } else { 1.0 };
        let (mut y, mut hold) = (self.y, self.hold);
        // At rest and lit, every sample is exactly +1 and the smoothers stay
        // exactly where they are, so the formula need not be run.
        if !f.on && y == 1.0 && hold == 1.0 {
            out[i0..i1].fill(1.0);
            return;
        }
        let sr = self.sample_rate;
        for i in i0..i1 {
            let tau = tau_at(frame, f.at, i, sr);
            let mut ph = f.p + cycles_at(tau, f.r0, f.r1, f.dur);
            ph -= ph.floor();
            hold += h * (hold_to - hold);
            let v = wave_shape(f.wave, f.duty, ph) * (1.0 - hold) + hold;
            y += a * (v - y);
            out[i] = (2.0 * y - 1.0) as f32;
        }
        self.y = y;
        self.hold = hold;
    }
}

impl Node for StrobeSignal {
    fn inputs(&self) -> usize { 0 }
    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { 1 }
    /// A function of the frame clock with no inputs: it never stops.
    fn tail_frames(&self) -> f64 { f64::INFINITY }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let frame = ctx.frame;
        let o = &mut out[0];
        let buf = &mut o.data[0];
        // Anything whose frame has come applies before the first sample.
        while let Some(at) = self.front_frame() {
            if at > frame as f64 { break; }
            self.apply_front();
        }
        let mut i0 = 0;
        while i0 < QUANTUM {
            // The next waiting message inside this quantum splits it there.
            let i1 = match self.front_frame() {
                Some(at) if at < (frame + QUANTUM as u64) as f64 => (at - frame as f64) as usize,
                _ => QUANTUM,
            };
            self.run(frame, buf, i0, i1);
            i0 = i1;
            while let Some(at) = self.front_frame() {
                if at > (frame + i0 as u64) as f64 { break; }
                self.apply_front();
            }
        }
        o.silent = false;
        self.next_frame = (frame + QUANTUM as u64) as f64;
        Activity::Active
    }

    fn message(&mut self, bytes: &[u8], _node: u32, _events: &mut Events) {
        if u32_at(bytes, 0) != Some(1) || bytes.len() < 4 + 8 * 8 { return; }
        let g = |k: usize| f64_at(bytes, 4 + 8 * k);
        let f = Formula {
            at: or_zero(g(0)),
            p: or_zero(g(1)),
            r0: or_zero(g(2)),
            r1: or_zero(g(3)),
            dur: or_zero(g(4)),
            wave: to_int32(g(5)),
            // `+d.duty` as it is: a NaN duty lights nothing on a square.
            duty: g(6),
            on: truthy(g(7)),
        };
        // A newer message is the truth from its anchor on, so anything still
        // waiting to land at or after that anchor is stale and goes.
        while self.n_pending > 0 && self.pending[self.n_pending - 1].at >= f.at {
            self.n_pending -= 1;
        }
        if f.at.ceil() > self.next_frame {
            // Its anchor still ahead: it waits for it.
            if self.n_pending == PENDING { self.apply_front(); }
            self.pending[self.n_pending] = f;
            self.n_pending += 1;
        } else {
            // Its anchor has passed: it lands at once, before the next sample,
            // as the worklet's would.
            self.n_pending = 0;
            self.f = f;
        }
    }
}
