//! AudioBufferSourceNode: plays a sample buffer from the BufferPool, once or
//! looping, at a rate set by `playbackRate` and `detune`.
//!
//! The playback follows Chrome's AudioBufferSourceHandler::RenderFromBuffer,
//! which is the spec's algorithm with Chrome's answers to the questions the
//! spec leaves open:
//!
//! - The read position (the playhead) is an f64 in buffer frames. Between
//!   two frames it interpolates linearly, in f64, rounding once to f32; at a
//!   whole frame that gives the stored sample exactly, so a buffer played at
//!   rate 1 from a whole frame comes out bit for bit.
//! - The frame after the last one is not there: past the buffer's last
//!   frame (no loop) Chrome extrapolates the line through the last two, and
//!   looping, the frame after the loop's end is the one its wrap lands on.
//!   Both show only at fractional positions (the bench's rate 1.37: at 48
//!   kHz its last read falls between frames, at 44.1 kHz on one).
//! - The rate is k-rate: playbackRate · 2^(detune/1200) · (buffer rate /
//!   context rate), taken at each quantum's first frame and clamped to
//!   [0, 1024]. A negative rate plays as a held sample, as in Chrome.
//! - loopStart and loopEnd apply only when they make a loop (0 ≤ start <
//!   end, not both zero); otherwise the whole buffer (or the played grain)
//!   loops. The loop wraps keeping the sub-sample position, and a playhead
//!   that starts past the loop's end jumps to its start.
//! - start(when, offset, duration): the offset rounds to the nearest buffer
//!   frame, and the duration counts buffer time, ending the grain there;
//!   with loop on, it instead stops the source that many seconds after the
//!   start, however many times the loop has gone round.

use super::constant_source::Schedule;
use crate::buffers::AudioData;
use crate::node::{Activity, Bus, MAX_CHANNELS, Node, NodeInit, ParamSpec, Rate, RenderCtx};

static PARAMS: [ParamSpec; 2] = [
    ParamSpec { name: "playbackRate", default: 1.0, min: -f32::MAX, max: f32::MAX, rate: Rate::K },
    ParamSpec { name: "detune", default: 0.0, min: -f32::MAX, max: f32::MAX, rate: Rate::K },
];

/// The attrs this node reads (protocol.json attrs).
const ATTR_LOOP: u32 = 2;
const ATTR_LOOP_START: u32 = 3;
const ATTR_LOOP_END: u32 = 4;
const ATTR_BUFFER: u32 = 5;

/// Chrome's ceiling on the computed rate.
const MAX_RATE: f64 = 1024.0;

/// What start() asked for, kept until the buffer is there to measure it by.
#[derive(Clone, Copy)]
struct Grain {
    offset: f64,
    /// Seconds of buffer to play, or None for the rest of it.
    duration: Option<f64>,
}

pub struct BufferSource {
    sample_rate: f32,
    schedule: Schedule,
    buffer: Option<u32>,
    /// The channel count of the buffer, once it has been seen.
    channels: usize,
    looping: bool,
    loop_start: f64,
    loop_end: f64,
    grain: Grain,
    /// The grain's end in buffer seconds, once start() and the buffer have
    /// met (Chrome's ClampGrainParameters).
    grain_end: Option<f64>,
    /// The playhead, in buffer frames.
    playhead: f64,
    /// Played out (no loop) partway through the last quantum.
    played_out: bool,
}

impl BufferSource {
    pub fn new(init: &NodeInit) -> Self {
        BufferSource {
            sample_rate: init.sample_rate,
            schedule: Schedule::default(),
            buffer: None,
            channels: 1,
            looping: false,
            loop_start: 0.0,
            loop_end: 0.0,
            grain: Grain { offset: 0.0, duration: None },
            grain_end: None,
            playhead: 0.0,
            played_out: false,
        }
    }

    /// Fits the grain to the buffer and puts the playhead at its offset, as
    /// Chrome does the moment both the buffer and start() are known.
    fn clamp_grain(&mut self, data: &AudioData) {
        let rate = data.sample_rate as f64;
        let length = data.frames() as f64 / rate;
        let offset = self.grain.offset.clamp(0.0, length);
        let duration = match self.grain.duration {
            None => length - offset,
            // A looping grain's duration was turned into a stop time at
            // start(); here it may run past the buffer.
            Some(d) if self.looping => d.max(0.0),
            Some(d) => d.clamp(0.0, length - offset),
        };
        self.grain_end = Some(offset + duration);
        // Chrome: the offset is rounded to a whole frame, so that a buffer at
        // rate 1 plays its samples exactly rather than interpolated between.
        self.playhead = (offset * rate).round();
    }

    /// The computed playback rate for this quantum.
    fn rate(&self, ctx: &RenderCtx, data: &AudioData) -> f64 {
        let playback = ctx.params[0].first() as f64;
        let detune = ctx.params[1].first();
        let base = data.sample_rate as f64 / self.sample_rate as f64;
        // Chrome: detune / 1200 is an f32 quotient; the power is f64.
        let rate = base * playback * 2f64.powf((detune / 1200.0) as f64);
        if rate.is_nan() { 0.0 } else { rate.clamp(0.0, MAX_RATE) }
    }

    /// Plays frames [from, to) of the quantum from the buffer. Returns false
    /// when the rate is wider than the loop itself, which Chrome answers
    /// with silence.
    fn play(&mut self, data: &AudioData, rate: f64, out: &mut Bus, from: usize, to: usize) -> bool {
        let length = data.frames();
        let buffer_rate = data.sample_rate as f64;
        // Chrome: the grain's end is rounded to the nearest frame.
        let end_frame = (self.grain_end.unwrap_or(0.0) * buffer_rate).round().min(length as f64);

        let mut end = end_frame;
        let mut span = end_frame;
        if self.looping && (self.loop_start != 0.0 || self.loop_end != 0.0)
            && self.loop_start >= 0.0 && self.loop_end > 0.0 && self.loop_start < self.loop_end
        {
            let loop_start = self.loop_start * buffer_rate;
            end = (self.loop_end * buffer_rate).min(end);
            span = end - loop_start;
        }
        if self.looping && self.playhead >= end {
            let loop_start = if self.loop_start < 0.0 { 0.0 } else { self.loop_start * buffer_rate };
            self.playhead = loop_start.min((length - 1) as f64);
        }
        if rate > span { return false; }

        let channels = self.channels;
        let mut position = self.playhead;
        for i in from..to {
            let r1 = position as usize;
            let t = position - r1 as f64;
            let mut r2 = r1 + 1;
            // Chrome: looping, the frame after the loop's end is where the
            // wrap lands, one loop back (the bench's loops, at 48 and 44.1
            // kHz, null only so); without a loop, past the buffer's last
            // frame there is none, and the last frame stands in.
            if self.looping && r2 as f64 >= end {
                r2 = (position + 1.0 - span).max(0.0) as usize;
            } else if r2 >= length {
                r2 = r1;
            }
            if r1 >= length || r2 >= length { break; }
            for c in 0..channels {
                let src = &data.channels[c];
                out.data[c][i] = if r2 == r1 && r1 >= 1 {
                    // Chrome: at the buffer's end, the line through its last
                    // two frames carried on.
                    let (s1, s2) = (src[r1 - 1] as f64, src[r1] as f64);
                    (s2 + t * (s2 - s1)) as f32
                } else {
                    ((1.0 - t) * src[r1] as f64 + t * src[r2] as f64) as f32
                };
            }
            position += rate;
            if position >= end {
                position -= span;
                if !self.looping {
                    self.played_out = true;
                    break;
                }
            }
        }
        self.playhead = position;
        true
    }
}

impl Node for BufferSource {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }
    fn inputs(&self) -> usize { 0 }
    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { self.channels }
    fn is_source(&self) -> bool { true }

    fn set_attr(&mut self, attr: u32, value: f64) {
        match attr {
            ATTR_LOOP => self.looping = value != 0.0,
            ATTR_LOOP_START => self.loop_start = value,
            ATTR_LOOP_END => self.loop_end = value,
            // A buffer can be given once (JS enforces it, as the spec does).
            ATTR_BUFFER if value >= 0.0 => self.buffer = Some(value as u32),
            _ => {}
        }
    }

    fn start(&mut self, frame: f64, offset: f64, duration: f64) {
        if self.schedule.started().is_some() { return; }
        self.schedule.start(frame);
        let duration = if duration >= 0.0 { Some(duration) } else { None };
        self.grain = Grain { offset: offset.max(0.0), duration };
        // Chrome: a looping grain with a duration plays for that long in
        // context time, as though stop(when + duration) had been called; a
        // later stop() replaces it.
        if let (true, Some(d)) = (self.looping, duration) {
            self.schedule.stop(frame + d * self.sample_rate as f64);
        }
    }

    fn stop(&mut self, frame: f64) { self.schedule.stop(frame); }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let out = &mut out[0];
        if self.played_out { self.schedule.finish(); }

        // Chrome: until the buffer is there, the source outputs silence
        // without its start being used up, so a late buffer still plays
        // from the beginning. A stop time still ends it.
        let Some(data) = self.buffer.and_then(|id| ctx.buffers.get(id)) else {
            if self.schedule.stopped_by(ctx.frame) { self.schedule.finish(); }
            out.zero();
            return self.schedule.idle();
        };
        // The graph sizes the bus by output_channels, which cannot see the
        // pool, so the buffer's channel count is learned here and the bus
        // widened to it from this quantum on.
        self.channels = data.channels.len().clamp(1, MAX_CHANNELS);
        out.channels = self.channels;

        let Some(window) = self.schedule.window(ctx.frame) else {
            out.zero();
            return self.schedule.idle();
        };
        if self.grain_end.is_none() { self.clamp_grain(data); }
        out.zero();
        if data.frames() == 0 {
            self.played_out = true;
            return Activity::Silent;
        }

        let rate = self.rate(ctx, data);
        // The spec's sub-sample start: the first frame played is the start
        // time rounded up, and by then the playhead has moved on by that
        // fraction of a frame at the playback rate.
        // Chrome: assumed to do the same since its sub-sample scheduling
        // work (the spec's wording, and Chrome's own oscillator, do); if the
        // wave-2 null test shows a start between frames playing the stored
        // samples unshifted, this is the line to remove.
        if window.start_offset < 0.0 {
            self.playhead += -window.start_offset * rate;
        }
        if !self.play(data, rate, out, window.from, window.to) {
            return Activity::Silent;
        }
        out.silent = false;
        Activity::Active
    }
}
