//! The shadow: the main thread's own copy of every param timeline, so that
//! `AudioParam.value` is answered by the same Rust that renders (principle
//! 2), with no audio and no nodes.
//!
//! It hears the same create, destroy and param commands as the stages, and
//! ignores the rest. A param's default and bounds come from the protocol's
//! table, the one both sides are generated from, with the bounds that
//! depend on the context or the node (Nyquist, a delay's maxDelayTime)
//! worked out here, so `value` is clamped exactly as the node clamps.
//!
//! Its present is the page's: the latest frame it has been asked about, or
//! told of with heart_now before each batch of commands (js/heart/heart.js
//! does both, at the present the page's calls land on, its render horizon,
//! which only moves forward; js/heart/nodes.js, late gestures).
//! Automation set before that time moves up to it, as on a stage, and a ramp
//! with nothing before it starts there, at the time of the call, as Chrome's
//! does. A param nobody has read for a while would otherwise anchor such a
//! ramp at the last read, long ago.

use std::collections::HashMap;

use crate::param::Timeline;
use crate::protocol_gen::{Bound, Command, params};

pub struct Shadow {
    sample_rate: f32,
    now: f64,
    nodes: HashMap<u32, Vec<Timeline>>,
    pub rejected: u32,
}

impl Shadow {
    pub fn new(sample_rate: f32) -> Shadow {
        Shadow { sample_rate, now: 0.0, nodes: HashMap::new(), rejected: 0 }
    }

    pub fn apply(&mut self, id: u32, command: Command) {
        let now = self.now;
        let done = match command {
            Command::Create { kind, opts, .. } => {
                let nyquist = self.sample_rate / 2.0;
                // Web Audio's default maxDelayTime is one second.
                let max_delay = if opts[0] > 0.0 { opts[0] as f32 } else { 1.0 };
                let resolve = |b: Bound| match b {
                    Bound::Value(v) => v,
                    Bound::Nyquist(k) => k * nyquist,
                    Bound::MaxDelayTime => max_delay,
                };
                let timelines = params(kind).iter()
                    .map(|p| Timeline::reader(p.default, resolve(p.min), resolve(p.max), p.rate, self.sample_rate))
                    .collect();
                self.nodes.insert(id, timelines).is_none()
            }
            Command::Destroy => self.nodes.remove(&id).is_some(),
            Command::ParamSet { param, time, value } => self.with(id, param, |t| t.set_value(time, value, now)),
            Command::ParamLinear { param, time, value } => self.with(id, param, |t| t.linear_ramp(time, value, now)),
            Command::ParamExp { param, time, value } => self.with(id, param, |t| t.exponential_ramp(time, value, now)),
            Command::ParamTarget { param, time, value, tau } => self.with(id, param, |t| t.set_target(time, value, tau, now)),
            Command::ParamCurve { param, time, duration, values } => {
                self.with(id, param, |t| t.set_curve(time, duration, values, now))
            }
            Command::ParamCancel { param, time } => self.with(id, param, |t| t.cancel(time, now)),
            Command::ParamCancelHold { param, time } => self.with(id, param, |t| t.cancel_and_hold(time, now)),
            _ => true,
        };
        if !done { self.rejected += 1; }
    }

    fn with(&mut self, id: u32, param: u32, op: impl FnOnce(&mut Timeline)) -> bool {
        match self.nodes.get_mut(&id).and_then(|ps| ps.get_mut(param as usize)) {
            Some(t) => { op(t); true }
            None => false,
        }
    }

    /// Moves the present up to `frame`; it never goes back.
    pub fn advance(&mut self, frame: f64) {
        if frame.is_finite() { self.now = self.now.max(frame); }
    }

    /// The param's intrinsic value at `frame`, or NaN for a param it does
    /// not know (a node never created, or already destroyed).
    pub fn value(&mut self, id: u32, param: u32, frame: f64) -> f32 {
        self.advance(frame);
        match self.nodes.get_mut(&id).and_then(|ps| ps.get_mut(param as usize)) {
            Some(t) => t.value_at(frame),
            None => f32::NAN,
        }
    }

    pub fn nodes(&self) -> usize { self.nodes.len() }
}
