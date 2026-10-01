//! The AudioParam timeline: the Web Audio spec's automation, with Chrome's
//! numbers wherever the spec leaves the arithmetic to the browser (the null
//! tests listen against Chrome).
//!
//! A timeline is two things. The pending events, sorted by time, each
//! waiting for the frame it starts on; and the segment that governs now,
//! made by the last event that started (a held value, a setTarget's
//! approach, a curve). As frames pass, every event whose time has come is
//! applied, in order, and becomes the governing segment. The one exception
//! is a ramp: a linear or exponential ramp is defined by where it ends, so
//! while one is the next pending event it draws the frames before it,
//! running from the `anchor` (the time and value of the event before it) to
//! its own time and value, exactly as the spec has it. When its time comes
//! it is applied like any other event, and the value holds there.
//!
//! The same timeline runs two ways:
//!
//! - **Rendering** (`fill`), on a stage, a quantum at a time, carrying the
//!   last value it computed. This follows Chrome's AudioParamTimeline step
//!   for step, because its rounding is audible in a null test: setTarget
//!   moves by `v += (target − v)·(1 − e^(−1/(sr·τ)))` in f32 from the
//!   previous sample, starting from the closed form on its first frame and
//!   snapping to the target once within Chrome's threshold; an exponential
//!   ramp multiplies an f64 accumulator; a curve indexes by the spec's
//!   formula and interpolates between its two nearest points.
//! - **Reading** (`value_at`), in the shadow on the main thread, answering
//!   `AudioParam.value` at whatever frame is asked, in closed form, since
//!   the shadow never renders and its reads are sparse.
//!
//! Both share every rule about the events themselves: where one goes, what
//! cancelling does, which value a ramp starts from. Times are engine frames
//! (f64); a setTarget's time constant and a curve's duration arrive in
//! seconds and are kept here in frames.
//!
//! Chrome's habits kept here, each named where it happens:
//! - An event set in the past moves up to the present: on a stage at once,
//!   and again, as Chrome clamps its new events, to the start of the first
//!   quantum that renders after it was set. That second rule matters only
//!   for a source's params, which Chrome renders only while the source
//!   plays: automation set from time 0 on a source started later begins
//!   where the source does.
//! - A ramp with nothing before it starts from the present value, now.
//! - A ramp after a setTarget starts from wherever the approach has got to
//!   when the ramp becomes its next event (ProcessSetTargetFollowedByRamp).
//! - Once the last event is a quantum and a half behind and has settled,
//!   the history is forgotten (HandleAllEventsInThePast), so a ramp set
//!   after that again starts from the present.
//! - An exponential ramp between values of opposite signs, or from zero,
//!   holds its start value until its end time, and takes its own value
//!   there, as the spec has it. While it holds, Chrome does not count the
//!   frames it fills, so whatever follows it in the same quantum is worked
//!   out as though it began that many frames earlier (see `run`).
//! - cancelAndHoldAtTime during a setTarget holds the value reached, but a
//!   ramp after it starts from 0, the value of Chrome's CancelValues event,
//!   which nothing sets in that case.
//! - Computed values are clamped to [min, max], and so is the kept value.

use std::collections::VecDeque;

use crate::node::{QUANTUM, Rate};

/// Chrome's setTarget convergence (audio_param_timeline.cc): settled once
/// ten time constants have passed, or the value is within e^−10 of the
/// target relative to itself, or, for a target of zero, within e^−10 of it
/// outright. Chrome uses the one threshold for both; the bench measured it
/// (a setTarget to 0 snaps to 0 at the first quantum whose value is under
/// 4.54e−5, at both rates).
const TIME_CONSTANTS_TO_CONVERGE: f64 = 10.0;
const SET_TARGET_THRESHOLD: f32 = 4.539_993e-5;
/// How far behind the last event must be before Chrome forgets the history.
const FORGET_AFTER: f64 = 1.5 * QUANTUM as f64;

#[derive(Clone, Copy, Debug, PartialEq)]
enum RampKind { Linear, Exponential }

#[derive(Clone, Debug)]
enum What {
    /// setValueAtTime, and the implicit one at the end of every curve.
    Set,
    Ramp(RampKind),
    /// setTargetAtTime; tau in frames.
    Target { tau: f64 },
    /// setValueCurveAtTime; duration in frames. `per_frame` is the spec's
    /// (N − 1)/duration, kept apart because a curve cut short by
    /// cancelAndHold keeps its original pace.
    Curve { duration: f64, per_frame: f64, values: Vec<f32> },
    /// cancelAndHoldAtTime: hold the value reached here. When it cut a ramp
    /// short, that ramp (kind, end time, end value) still draws the frames
    /// up to here, so the value runs on exactly as it would have.
    Hold { cut: Option<(RampKind, f64, f32)> },
}

#[derive(Clone, Debug)]
struct Event {
    time: f64,
    value: f32,
    what: What,
    /// Set since the timeline last rendered, so its time is still to be
    /// clamped to the quantum that first renders it.
    fresh: bool,
}

impl Event {
    fn new(time: f64, value: f32, what: What) -> Event { Event { time, value, what, fresh: true } }
}

/// A ramp being drawn: its kind, where it starts and where it ends.
type Ramp = (RampKind, (f64, f32), (f64, f32));

#[derive(Clone, Debug)]
enum Seg {
    Hold(f32),
    /// v0 is the value the approach started from at t0, for the reader's
    /// closed form; the renderer goes from sample to sample instead.
    Target { t0: f64, v0: f32, target: f32, tau: f64, converged: bool },
    /// `before` is the value the curve took over from, which
    /// cancelScheduledValues restores.
    Curve { t0: f64, end: f64, per_frame: f64, values: Vec<f32>, before: f32 },
}

/// What one quantum of a param came to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fill {
    /// The same value on every frame, and the block was not written.
    Const(f32),
    /// The block holds a value per frame.
    Varying,
}

pub struct Timeline {
    events: VecDeque<Event>,
    seg: Seg,
    /// Where a ramp starts: the last applied event's time and value. None
    /// before any event, and once Chrome would have forgotten them.
    anchor: Option<(f64, f32)>,
    /// The last value computed, clamped: Chrome's intrinsic value.
    value: f32,
    min: f32,
    max: f32,
    sample_rate: f64,
    /// Frames per computed value: 1 for a-rate, a quantum for k-rate
    /// (Chrome's control rate, which sets the size of setTarget's step).
    step: f64,
    reader: bool,
    /// How many pending events are fresh (see Event).
    fresh: usize,
    /// Whether any event has ever been set, and whether one has started:
    /// Chrome's AudioParamTimeline keeps at least the last of its events for
    /// good, so from then on its param has sample-accurate values (see
    /// `has_values`).
    touched: bool,
    started: bool,
}

impl Timeline {
    /// A timeline that renders, on a stage.
    pub fn new(default: f32, min: f32, max: f32, rate: Rate, sample_rate: f32) -> Timeline {
        let value = default.max(min).min(max);
        Timeline {
            events: VecDeque::new(),
            seg: Seg::Hold(value),
            anchor: None,
            value,
            min,
            max,
            sample_rate: sample_rate as f64,
            step: match rate { Rate::A => 1.0, Rate::K => QUANTUM as f64 },
            reader: false,
            fresh: 0,
            touched: false,
            started: false,
        }
    }

    /// A timeline that only answers `value_at`, for the shadow.
    pub fn reader(default: f32, min: f32, max: f32, rate: Rate, sample_rate: f32) -> Timeline {
        Timeline { reader: true, ..Timeline::new(default, min, max, rate, sample_rate) }
    }

    /// The last value computed (Chrome's intrinsic value).
    pub fn value(&self) -> f32 { self.value }

    // ---------- the seven methods ----------
    // Each takes `now`, the first frame not yet rendered (for the shadow, the
    // latest frame it has been asked about); an event before it moves up to
    // it. Arguments the spec refuses are dropped: the page's HeartParam
    // throws for them first, so they never come from the app.

    pub fn set_value(&mut self, time: f64, value: f32, now: f64) {
        if time.is_finite() && value.is_finite() {
            self.insert(Event::new(time, value, What::Set), now);
        }
    }

    pub fn linear_ramp(&mut self, time: f64, value: f32, now: f64) {
        if time.is_finite() && value.is_finite() {
            self.insert(Event::new(time, value, What::Ramp(RampKind::Linear)), now);
        }
    }

    /// A target of exactly zero is refused (RangeError); a negative one is
    /// legal, and a ramp across zero holds (see the top).
    pub fn exponential_ramp(&mut self, time: f64, value: f32, now: f64) {
        if time.is_finite() && value.is_finite() && value != 0.0 {
            self.insert(Event::new(time, value, What::Ramp(RampKind::Exponential)), now);
        }
    }

    /// A time constant of zero jumps straight to the target, as the spec
    /// says and as Chrome does it, with a setValueAtTime.
    pub fn set_target(&mut self, time: f64, target: f32, tau_seconds: f64, now: f64) {
        if !time.is_finite() || !target.is_finite() || !(tau_seconds >= 0.0) || !tau_seconds.is_finite() { return; }
        let what = if tau_seconds == 0.0 { What::Set } else { What::Target { tau: tau_seconds * self.sample_rate } };
        self.insert(Event::new(time, target, what), now);
    }

    /// The curve, and the spec's implicit setValueAtTime of its last value
    /// at its end, so that whatever follows starts from there.
    pub fn set_curve(&mut self, time: f64, duration_seconds: f64, values: Vec<f32>, now: f64) {
        let duration = duration_seconds * self.sample_rate;
        if !time.is_finite() || !(duration > 0.0) || !duration.is_finite()
            || values.len() < 2 || !values.iter().all(|v| v.is_finite()) { return; }
        self.settle(now);
        let time = time.max(now);
        if self.collides(time, Some(duration)) { return; }
        let (first, last) = (values[0], values[values.len() - 1]);
        let per_frame = (values.len() - 1) as f64 / duration;
        self.place(Event::new(time, first, What::Curve { duration, per_frame, values }));
        self.place(Event::new(time + duration, last, What::Set));
        self.ramp_follows_target(now);
    }

    /// cancelScheduledValues: every event from `time` on goes, and so does a
    /// curve still playing at `time`, which gives back the value from before
    /// it. Events already applied stay, since on a stage that renders ahead
    /// they have been heard; a ramp under way is still pending (its time is
    /// its end), so it goes, and the value falls back to where it started,
    /// as the spec says.
    pub fn cancel(&mut self, time: f64, now: f64) {
        if !time.is_finite() { return; }
        self.settle(now);
        let cut = self.events.iter().position(|e| {
            e.time >= time || matches!(e.what, What::Curve { duration, .. } if time < e.time + duration)
        });
        if let Some(i) = cut { self.events.truncate(i); }
        if let Seg::Curve { t0, end, before, .. } = self.seg && time < end {
            self.seg = Seg::Hold(before);
            self.anchor = Some((t0, before));
        }
        self.recount();
        self.ramp_follows_target(now);
    }

    /// cancelAndHoldAtTime, as Chrome's CancelAndHoldAtTime: everything after
    /// `time` goes, and the automation running at `time` holds the value it
    /// reaches there. A ramp running then becomes a Hold that remembers it;
    /// a setTarget runs on until a Hold at `time`; a curve is cut short
    /// there with a setValueAtTime of its value at that moment.
    pub fn cancel_and_hold(&mut self, time: f64, now: f64) {
        if !time.is_finite() { return; }
        self.settle(now);
        let time = time.max(now);
        // The automation running at `time` is the last event at or before
        // it, or, with none pending, the segment that governs now.
        let i = self.events.partition_point(|e| e.time <= time);
        let running = if i > 0 { Some(i - 1) } else { None };
        match running.map(|r| (self.events[r].time, &self.events[r].what)) {
            Some((t0, What::Target { .. })) => {
                self.events.truncate(if t0 < time { i } else { i - 1 });
                if t0 < time { self.hold_at(time, None); }
            }
            Some((t0, &What::Curve { duration, per_frame, .. })) => {
                if t0 < time && time < t0 + duration {
                    self.events.truncate(i);
                    let curve = self.events.back_mut().expect("the curve is the last event left");
                    let What::Curve { duration, values, .. } = &mut curve.what else { unreachable!() };
                    let held = curve_value(values, t0, per_frame, time);
                    *duration = time - t0;
                    self.events.push_back(Event::new(time, held, What::Set));
                } else {
                    self.events.truncate(if t0 < time { i } else { i - 1 });
                }
            }
            Some(_) => self.hold_next(i, time),
            None => match &mut self.seg {
                Seg::Target { .. } => {
                    self.events.clear();
                    self.hold_at(time, None);
                }
                Seg::Curve { t0, end, per_frame, values, .. } if time < *end => {
                    let held = curve_value(values, *t0, *per_frame, time);
                    *end = time;
                    self.events.clear();
                    self.events.push_back(Event::new(time, held, What::Set));
                }
                _ => self.hold_next(0, time),
            },
        }
        self.recount();
        self.ramp_follows_target(now);
    }

    // ---------- rendering ----------

    /// One quantum from engine frame `start`: a value per frame for an a-rate
    /// param, or, for a k-rate one, the single value at `start`, which comes
    /// back as Const. When nothing can change inside the quantum the block is
    /// not touched and the answer is Const; a block that comes out the same
    /// on every frame is reported Const too, so nodes can take their fast
    /// path whenever it holds.
    pub fn fill(&mut self, block: &mut [f32; QUANTUM], start: u64) -> Fill {
        let from = start as f64;
        self.clamp_fresh(from);
        self.forget(from);
        let n = if self.step > 1.0 { 1 } else { QUANTUM };
        let last = from + (n - 1) as f64;
        if let Some(v) = self.settled() {
            let quiet = match self.events.front() {
                None => true,
                Some(e) => e.time > last && self.ramp_ahead().is_none(),
            };
            if quiet {
                self.value = self.clamp(v);
                return Fill::Const(self.value);
            }
        }
        let out = &mut block[..n];
        self.run(out, start);
        for v in out.iter_mut() { *v = v.max(self.min).min(self.max); }
        self.value = out[n - 1];
        if out.iter().all(|&v| v == out[0]) { Fill::Const(out[0]) } else { Fill::Varying }
    }

    /// The renderer proper: frame by frame from `start`, applying each event
    /// as its frame comes and drawing the spans between them. Chrome's
    /// `value` (the running value) lives in self.value meanwhile, unclamped
    /// until `fill` is done.
    fn run(&mut self, out: &mut [f32], start: u64) {
        let end = start + out.len() as u64;
        let (mut f, mut w) = (start, 0);
        // Chrome's running frame (current_frame in ValuesForFrameRange) can
        // fall behind the frame being written. Its exponential ramp between
        // values of opposite signs fills its frames without counting them,
        // so anything after it in the same quantum is worked out as though
        // it began that many frames earlier. A held value, a curve, or a
        // setTarget still moving sets the running frame afresh at its span's
        // end; a ramp counts frame by frame and so carries the lag on. Each
        // quantum starts true.
        let mut lag = 0;
        while w < out.len() {
            self.apply_due(f as f64);
            // The span runs to the frame the next event starts on, ceil of its
            // time, as Chrome computes it. That is always past `f` (every
            // event at or before `f` has just been applied); the max keeps
            // the loop moving even if rounding ever said otherwise.
            let stop = self.events.front().map_or(end, |e| end.min(e.time.ceil() as u64)).max(f + 1);
            let span = &mut out[w..w + (stop - f) as usize];
            match self.ramp_ahead() {
                Some(ramp) => {
                    if !self.draw_ramp(span, f - lag, ramp) { lag += span.len() as u64; }
                }
                None => {
                    if self.draw_seg(span, f - lag) { lag = 0; }
                }
            }
            w += span.len();
            f = stop;
        }
    }

    /// Chrome's ProcessLinearRamp and ProcessExponentialRamp, from its
    /// running frame `f`. Returns false for the exponential ramp that holds,
    /// whose frames Chrome does not count (see `run`).
    fn draw_ramp(&mut self, span: &mut [f32], f: u64, (kind, (t1, v1), (t2, v2)): Ramp) -> bool {
        let from = f as f64;
        match kind {
            RampKind::Linear => {
                let k = if t2 > t1 { 1.0 / (t2 - t1) } else { 0.0 };
                let delta = v2 - v1;
                for (i, out) in span.iter_mut().enumerate() {
                    let x = ((from + i as f64 - t1) * k) as f32;
                    *out = v1 + x * delta;
                }
            }
            RampKind::Exponential if v1 * v2 > 0.0 => {
                // v(t) = v1·(v2/v1)^((t − t1)/(t2 − t1)), sampled as a start
                // value times a per-frame multiplier, the multiplier in f64.
                let frames = t2 - t1;
                let multiplier = ((v2 / v1) as f64).powf(1.0 / frames);
                let first = (v1 as f64 * (v2 as f64 / v1 as f64).powf((from - t1) / frames)) as f32;
                let mut acc = first as f64;
                for out in span.iter_mut() {
                    *out = acc as f32;
                    acc *= multiplier;
                }
            }
            // Opposite signs, or a start of zero: the start value holds.
            RampKind::Exponential => {
                span.fill(v1);
                self.value = v1;
                return false;
            }
        }
        self.value = span[span.len() - 1];
        true
    }

    /// The governing segment over a span with no ramp ahead, from Chrome's
    /// running frame `f`. Returns whether Chrome sets its running frame
    /// afresh at the span's end: a held value or a curve does, and so does a
    /// setTarget unless it has converged, when it counts its frames instead.
    fn draw_seg(&mut self, span: &mut [f32], f: u64) -> bool {
        let from = f as f64;
        let step = self.step;
        let running = self.value;
        let resets = match &mut self.seg {
            Seg::Hold(v) => {
                span.fill(*v);
                true
            }
            Seg::Target { t0, target, tau, converged, .. } => {
                // Chrome's ProcessSetTarget: the first frame from the closed
                // form if the approach starts within the frame before it,
                // else one step on from the last value; then, unless settled,
                // a step per frame in f32.
                let target = *target;
                let mut v = target_next(running, *t0, target, *tau, step, from);
                if *converged || has_converged(v, target, from, *t0, *tau) {
                    *converged = true;
                    span.fill(target);
                    false
                } else {
                    let k = discrete_time_constant(*tau, step);
                    for out in span.iter_mut() {
                        *out = v;
                        v += (target - v) * k;
                    }
                    true
                }
            }
            Seg::Curve { t0, per_frame, values, .. } => {
                // Chrome's ProcessSetValueCurve: the spec's index, worked out
                // afresh each frame (never accumulated) to keep rounding off.
                let n = values.len();
                let base = (from - *t0).max(0.0) * *per_frame;
                for (k, out) in span.iter_mut().enumerate() {
                    let index = base + k as f64 * *per_frame;
                    let i0 = if index < n as f64 { index as usize } else { n - 1 };
                    let i1 = (i0 + 1).min(n - 1);
                    let delta = (index - i0 as f64).min(1.0);
                    *out = (values[i0] as f64 + (values[i1] - values[i0]) as f64 * delta) as f32;
                }
                true
            }
        };
        self.value = span[span.len() - 1];
        resets
    }

    // ---------- reading ----------

    /// The intrinsic value at `frame`, clamped, for the shadow. Frames asked
    /// about should not go backwards: events up to `frame` are applied and
    /// let go of, which is what keeps the shadow's timelines short.
    pub fn value_at(&mut self, frame: f64) -> f32 {
        self.apply_due(frame);
        self.forget(frame);
        let v = match self.ramp_ahead() {
            Some((kind, a, b)) => ramp_value(kind, a, b, frame),
            None => self.seg_value(frame),
        };
        self.value = self.clamp(v);
        self.value
    }

    /// The governing segment's value at `frame`, in closed form.
    fn seg_value(&self, frame: f64) -> f32 {
        match &self.seg {
            Seg::Hold(v) => *v,
            Seg::Target { t0, v0, target, tau, converged } => {
                let v = (*target as f64 + (*v0 - *target) as f64 * (-(frame - t0) / tau).exp()) as f32;
                if *converged || has_converged(v, *target, frame, *t0, *tau) { *target } else { v }
            }
            Seg::Curve { t0, per_frame, values, .. } => curve_value(values, *t0, *per_frame, frame),
        }
    }

    /// How many events are still to start (the tests watch it).
    pub fn pending(&self) -> usize { self.events.len() }

    // ---------- events ----------

    /// The reader catches up to `now` before any change, so that what has
    /// passed is applied and let go of even on a param nobody reads (the
    /// shadow's present moves whenever any param is read). The renderer
    /// is always caught up: it applies events as it renders.
    fn settle(&mut self, now: f64) {
        if self.reader {
            self.apply_due(now);
            self.forget(now);
        }
    }

    fn insert(&mut self, mut e: Event, now: f64) {
        self.settle(now);
        e.time = e.time.max(now);
        if self.collides(e.time, None) { return; }
        // Chrome: a ramp with no event at all before it gets a setValueAtTime
        // of the present value, at the present, to start from.
        if matches!(e.what, What::Ramp(_)) && self.events.is_empty() && self.anchor.is_none() {
            let v = self.clamp(self.value_now(now));
            self.place(Event::new(now, v, What::Set));
        }
        self.place(e);
        self.ramp_follows_target(now);
    }

    /// Into time order, after every event already at the same time (spec).
    fn place(&mut self, e: Event) {
        let i = self.events.partition_point(|x| x.time <= e.time);
        self.events.insert(i, e);
        self.fresh += 1;
        self.touched = true;
    }

    /// Counts the pending events afresh after a cancel has cut some away or
    /// added its own: how many are fresh, and that the timeline has had one.
    fn recount(&mut self) {
        self.fresh = self.events.iter().filter(|e| e.fresh).count();
        self.touched |= !self.events.is_empty();
    }

    /// Chrome's clamping of new events (ValuesForFrameRange): each event set
    /// since the last render whose time has already gone moves up to the
    /// start of the quantum now rendering, `from`.
    fn clamp_fresh(&mut self, from: f64) {
        if self.fresh == 0 { return; }
        for e in self.events.iter_mut().filter(|e| e.fresh) {
            e.fresh = false;
            if e.time < from { e.time = from; }
        }
        self.fresh = 0;
    }

    /// Chrome's AudioParamTimeline::HasValues for the quantum from `start`:
    /// whether the param has sample-accurate values, which some nodes answer
    /// with other arithmetic even when the values come out constant (a
    /// DelayNode then reads its ring in f32). True once any event has been
    /// set, since Chrome always keeps the last of them, unless nothing has
    /// started yet and the first event, a value, a setTarget or a curve, is
    /// still to come after this quantum.
    pub fn has_values(&self, start: u64) -> bool {
        if !self.touched { return false; }
        if !self.started
            && let Some(e) = self.events.front()
            && e.time >= (start + QUANTUM as u64) as f64
            && matches!(e.what, What::Set | What::Target { .. } | What::Curve { .. })
        {
            return false;
        }
        true
    }

    /// Would an event at `time` (a curve, when `curve` gives its duration)
    /// land inside a curve, or a curve be laid over another event? The spec
    /// refuses both (NotSupportedError).
    fn collides(&self, time: f64, curve: Option<f64>) -> bool {
        if let Seg::Curve { t0, end, .. } = self.seg && t0 <= time && time < end { return true; }
        self.events.iter().any(|e| {
            matches!(e.what, What::Curve { duration, .. } if e.time <= time && time < e.time + duration)
                || curve.is_some_and(|d| time < e.time && e.time < time + d)
        })
    }

    /// cancelAndHold where the running automation is a value held or a ramp
    /// ended: only a ramp still to come (the first event after `time`) needs
    /// remembering in the Hold; anything else after `time` simply goes.
    fn hold_next(&mut self, i: usize, time: f64) {
        let Some(next) = self.events.get(i) else { return };
        let cut = match next.what {
            What::Ramp(kind) => Some((kind, next.time, next.value)),
            _ => None,
        };
        self.events.truncate(i);
        if cut.is_some() { self.hold_at(time, cut); }
    }

    fn hold_at(&mut self, time: f64, cut: Option<(RampKind, f64, f32)>) {
        self.events.push_back(Event::new(time, 0.0, What::Hold { cut }));
    }

    /// Applies every pending event whose time has come by `frame`.
    fn apply_due(&mut self, frame: f64) {
        while self.events.front().is_some_and(|e| e.time <= frame) {
            let e = self.events.pop_front().expect("checked above");
            // The renderer applies at the frame it has reached; the reader,
            // in closed form, at the event's own time.
            let at = if self.reader { e.time } else { frame };
            self.apply(e, at);
        }
    }

    /// Makes `e` the governing segment. An event that settles on a value
    /// also makes it the running value at once, as Chrome's loop does when
    /// it passes the event even for no frames, so whatever starts on the
    /// same frame (a setTarget at a ramp's end) starts from there.
    fn apply(&mut self, e: Event, at: f64) {
        let (time, value) = (e.time, e.value);
        self.started = true;
        match e.what {
            What::Set | What::Ramp(RampKind::Linear) => {
                self.seg = Seg::Hold(value);
                self.anchor = Some((time, value));
                self.value = value;
            }
            // An exponential ramp, even one across zero that held its start
            // value until now, ends on its own value (the spec's, and what
            // the bench hears from Chrome: a ramp from 0 to 5000 on a
            // biquad's frequency jumps to 5000 at its end time).
            What::Ramp(RampKind::Exponential) => {
                self.seg = Seg::Hold(value);
                self.anchor = Some((time, value));
                self.value = value;
            }
            What::Target { tau } => {
                let v0 = if self.reader { self.seg_value(time) } else { self.value };
                self.seg = Seg::Target { t0: time, v0, target: value, tau, converged: false };
                self.anchor = Some((time, v0));
                self.ramp_follows_target(at);
            }
            What::Curve { duration, per_frame, values } => {
                let before = if self.reader { self.seg_value(time) } else { self.value };
                self.seg = Seg::Curve { t0: time, end: time + duration, per_frame, values, before };
                self.anchor = Some((time, value));
            }
            What::Hold { cut } => {
                let held = match (cut, self.anchor) {
                    (Some((kind, t, v)), Some(a)) => ramp_value(kind, a, (t, v), time),
                    _ if self.reader => self.seg_value(time),
                    _ => self.value_now(at),
                };
                self.seg = Seg::Hold(held);
                // Chrome: a hold that cut a ramp short has its value cached
                // on its CancelValues event, so a ramp after it starts from
                // there. One that stopped a setTarget (no cut) never has its
                // event's value set, so a ramp after it starts from 0, though
                // the value holds where the approach had got to until then.
                let start = if cut.is_some() { held } else { 0.0 };
                self.anchor = Some((time, start));
                self.value = held;
            }
        }
    }

    /// Chrome's ProcessSetTargetFollowedByRamp: when a ramp becomes the next
    /// event after a setTarget, the approach stops where it has got to by
    /// `at` and the ramp starts from there.
    fn ramp_follows_target(&mut self, at: f64) {
        if matches!(self.seg, Seg::Target { .. })
            && self.events.front().is_some_and(|e| matches!(e.what, What::Ramp(_)))
        {
            let v = self.value_now(at);
            self.seg = Seg::Hold(v);
            self.anchor = Some((at, v));
        }
    }

    /// The governing segment's value at frame `at`: in closed form for the
    /// reader; for the renderer, the next value on from the last one
    /// computed, as Chrome would compute it on reaching `at`.
    fn value_now(&self, at: f64) -> f32 {
        if self.reader { return self.seg_value(at); }
        match &self.seg {
            Seg::Hold(v) => *v,
            Seg::Target { target, converged: true, .. } => *target,
            Seg::Target { t0, target, tau, .. } => target_next(self.value, *t0, *target, *tau, self.step, at),
            Seg::Curve { t0, per_frame, values, .. } => curve_value(values, *t0, *per_frame, at),
        }
    }

    /// The ramp drawing the frames before the next event, if one is: a ramp
    /// event, or a Hold that cut one short. With nothing applied before it
    /// to start from, a ramp draws nothing and the value holds until its
    /// time, as in Chrome.
    fn ramp_ahead(&self) -> Option<Ramp> {
        let a = self.anchor?;
        let e = self.events.front()?;
        match e.what {
            What::Ramp(kind) => Some((kind, a, (e.time, e.value))),
            What::Hold { cut: Some((kind, t, v)) } => Some((kind, a, (e.time, ramp_value(kind, a, (t, v), e.time)))),
            _ => None,
        }
    }

    /// The value the segment has settled on, if it has: a hold, or a
    /// setTarget that has converged.
    fn settled(&self) -> Option<f32> {
        match self.seg {
            Seg::Hold(v) => Some(v),
            Seg::Target { target, converged: true, .. } => Some(target),
            _ => None,
        }
    }

    /// Chrome's HandleAllEventsInThePast: once nothing is pending, the last
    /// event is more than a quantum and a half behind `frame`, and a
    /// setTarget among them has converged, the history is dropped and the
    /// value simply holds. From then on a new ramp starts from the present.
    fn forget(&mut self, frame: f64) {
        if !self.events.is_empty() { return; }
        let Some((t, _)) = self.anchor else { return };
        if t + FORGET_AFTER >= frame { return; }
        match self.seg {
            Seg::Hold(_) => self.anchor = None,
            Seg::Target { t0, target, tau, converged, .. } => {
                if converged || has_converged(self.value, target, frame, t0, tau) {
                    self.seg = Seg::Hold(target);
                    self.value = self.clamp(target);
                    self.anchor = None;
                }
            }
            Seg::Curve { .. } => {}
        }
    }

    fn clamp(&self, v: f32) -> f32 { v.max(self.min).min(self.max) }
}

/// The spec's ramps at time t, from a = (t1, v1) to b = (t2, v2), in closed
/// form (Chrome's LinearRampAtTime and ExponentialRampAtTime).
fn ramp_value(kind: RampKind, (t1, v1): (f64, f32), (t2, v2): (f64, f32), t: f64) -> f32 {
    if t >= t2 || t2 <= t1 {
        return match kind {
            RampKind::Exponential if v1 * v2 <= 0.0 => v1,
            _ => v2,
        };
    }
    let x = (t - t1) / (t2 - t1);
    match kind {
        RampKind::Linear => (v1 as f64 + (v2 - v1) as f64 * x) as f32,
        RampKind::Exponential if v1 * v2 > 0.0 => (v1 as f64 * (v2 as f64 / v1 as f64).powf(x)) as f32,
        RampKind::Exponential => v1,
    }
}

/// The spec's curve at frame t: index k = ⌊(N − 1)/T_D·(t − T0)⌋, linear
/// between V[k] and V[k + 1], and the last value from the end on.
fn curve_value(values: &[f32], t0: f64, per_frame: f64, t: f64) -> f32 {
    let n = values.len();
    let index = (t - t0).max(0.0) * per_frame;
    let k = (index as usize).min(n - 1);
    let k1 = (k + 1).min(n - 1);
    let delta = (index - k as f64).min(1.0);
    (values[k] as f64 + (values[k1] - values[k]) as f64 * delta) as f32
}

/// setTarget's value on reaching frame `at`, from `running`, the value one
/// step before: the closed form if the approach starts within that step's
/// last frame, otherwise one step of the recurrence (Chrome's ProcessSetTarget).
fn target_next(running: f32, t0: f64, target: f32, tau: f64, step: f64, at: f64) -> f32 {
    if t0 <= at && at < t0 + 1.0 {
        (target as f64 + (running - target) as f64 * (-(at - t0) / tau).exp()) as f32
    } else {
        running + (target - running) * discrete_time_constant(tau, step)
    }
}

/// 1 − e^(−step/τ), τ and the step in frames: the share of the remaining
/// distance a setTarget covers per computed value (Chrome's
/// DiscreteTimeConstantForSampleRate at the param's control rate).
fn discrete_time_constant(tau: f64, step: f64) -> f32 {
    (1.0 - (-step / tau).exp()) as f32
}

/// Chrome's HasSetTargetConverged, with times in frames.
fn has_converged(v: f32, target: f32, now: f64, t0: f64, tau: f64) -> bool {
    now > t0 + TIME_CONSTANTS_TO_CONVERGE * tau
        || (target == 0.0 && v.abs() < SET_TARGET_THRESHOLD)
        || (target != 0.0 && (target - v).abs() < SET_TARGET_THRESHOLD * v.abs())
}
