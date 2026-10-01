//! ConstantSourceNode: one channel carrying its `offset` param, between
//! start() and stop().
//!
//! This file also holds `Schedule`, the start/stop clock every scheduled
//! source shares (this one, the oscillator and the buffer source), since
//! ConstantSource is the source that is nothing but its schedule. It follows
//! Chrome's AudioScheduledSourceHandler::UpdateSchedulingInfo, so a source
//! begins and ends on exactly the frame a native one would.

use crate::node::{Activity, Bus, Node, NodeInit, ParamBlock, ParamSpec, QUANTUM, Rate, RenderCtx};

static PARAMS: [ParamSpec; 1] = [
    ParamSpec { name: "offset", default: 1.0, min: -f32::MAX, max: f32::MAX, rate: Rate::A },
];

/// Where a source is in its life, and which frames of a quantum it plays.
#[derive(Default)]
pub struct Schedule {
    /// The start time as an engine frame, fractional when the app's time
    /// fell between samples.
    start: Option<f64>,
    stop: Option<f64>,
    playing: bool,
    finished: bool,
}

/// The part of one quantum a source plays.
pub struct Window {
    /// The frames [from, to) of the quantum carry sound; the rest are silent.
    pub from: usize,
    pub to: usize,
    /// On the source's first quantum, the start time minus the frame it was
    /// rounded up to: in (−1, 0], how far before the first played frame the
    /// source really began. Zero after that.
    pub start_offset: f64,
}

impl Schedule {
    /// Schedules the start. A second start is ignored (JS throws for it
    /// before it reaches us).
    pub fn start(&mut self, frame: f64) {
        if self.start.is_none() { self.start = Some(frame.max(0.0)); }
    }

    /// Schedules the stop. A later stop replaces an earlier one, as the spec
    /// says, until the source has finished.
    pub fn stop(&mut self, frame: f64) {
        if !self.finished { self.stop = Some(frame.max(0.0)); }
    }

    pub fn started(&self) -> Option<f64> { self.start }
    pub fn finish(&mut self) { self.finished = true; }

    /// Whether a stop time has passed by the quantum starting at `q0`.
    pub fn stopped_by(&self, q0: u64) -> bool {
        self.stop.is_some_and(|s| s.ceil() <= q0 as f64)
    }

    /// The frames of the quantum starting at engine frame `q0` that play, or
    /// None when none do.
    ///
    /// Both times round up to whole frames, so a source never sounds before
    /// its start nor at its stop. A start already in the past plays from now.
    pub fn window(&mut self, q0: u64) -> Option<Window> {
        let q1 = q0 + QUANTUM as u64;
        if self.stopped_by(q0) { self.finished = true; }
        let start = self.start?;
        if self.finished { return None; }
        let start_frame = start.ceil();
        if start_frame >= q1 as f64 { return None; }

        // Chrome: the fractional offset is taken against the rounded start
        // frame even when that frame is already past, so a late start begins
        // with only its sub-sample phase, never a skip.
        let start_offset = if self.playing { 0.0 } else { start - start_frame };
        self.playing = true;

        let from = (start_frame - q0 as f64).clamp(0.0, QUANTUM as f64) as usize;
        let mut to = QUANTUM;
        if let Some(stop) = self.stop {
            let end_frame = stop.ceil();
            if end_frame < q1 as f64 {
                to = (end_frame - q0 as f64) as usize;
                self.finished = true;
            }
        }
        Some(Window { from, to: to.max(from), start_offset })
    }

    /// What a source reports for a quantum it played nothing in. A source
    /// that stops partway through a quantum reports Active for it and
    /// Finished for the next, all-silent one, so whatever the graph does with
    /// a finished node's bus, no sample is lost.
    pub fn idle(&self) -> Activity {
        if self.finished { Activity::Finished } else { Activity::Silent }
    }
}

pub struct ConstantSource {
    schedule: Schedule,
}

impl ConstantSource {
    pub fn new(_init: &NodeInit) -> Self { ConstantSource { schedule: Schedule::default() } }
}

impl Node for ConstantSource {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }
    fn inputs(&self) -> usize { 0 }
    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { 1 }
    fn is_source(&self) -> bool { true }
    fn start(&mut self, frame: f64, _offset: f64, _duration: f64) { self.schedule.start(frame); }
    fn stop(&mut self, frame: f64) { self.schedule.stop(frame); }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let out = &mut out[0];
        let Some(window) = self.schedule.window(ctx.frame) else {
            out.zero();
            return self.schedule.idle();
        };
        out.zero();
        out.silent = false;
        let dest = &mut out.channel_mut(0)[window.from..window.to];
        match ctx.params[0] {
            ParamBlock::Const(v) => dest.fill(v),
            ParamBlock::Varying(v) => dest.copy_from_slice(&v[window.from..window.to]),
        }
        Activity::Active
    }
}
