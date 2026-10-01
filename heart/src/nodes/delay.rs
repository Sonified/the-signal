//! DelayNode: the input, `delayTime` seconds later, read from a ring with
//! linear interpolation between the two samples either side of a fractional
//! delay, as Chrome's AudioDelayDSPKernel does.
//!
//! The ring holds maxDelayTime plus one quantum, so a whole quantum can be
//! written before it is read without the write ever landing on a sample
//! still to be read. The node renders as Chrome does: write the quantum's
//! input, then read, so a delay shorter than a quantum (even zero) works.
//! Inside a cycle nothing changes here: the graph feeds the cycle's way
//! back from the quantum before, as Chrome does, which is what keeps a
//! cycle's round trip at least a quantum long.
//!
//! Which arithmetic reads the ring is Chrome's choice, not the values':
//! a delayTime with no automation and nothing connected is read once a
//! quantum in f64 (ProcessKRate), and one that has ever been automated
//! (setting `.value` counts) or is fed is read a frame at a time in f32
//! (ProcessARate), even while it holds still. The node asks the graph for
//! that (`sample_accurate`) and takes the f32 path for any Varying block;
//! between fractional frames the two differ by up to the f32 spacing of the
//! ring's length, audible in a null test (−56 dB on the bench's burst).
//!
//! A ring that has taken in nothing but silence for its whole length holds
//! only zeros, so the node knows it is silent without reading.

use crate::node::{Activity, Bus, Node, NodeInit, ParamBlock, ParamSpec, QUANTUM, Rate, RenderCtx};

/// delayTime's nominal maximum is the node's own maxDelayTime, which a static
/// table cannot hold; the node clamps to it itself (protocol.json, params).
static PARAMS: [ParamSpec; 1] = [
    ParamSpec { name: "delayTime", default: 0.0, min: 0.0, max: f32::MAX, rate: Rate::A },
];

pub struct Delay {
    sample_rate: f32,
    /// maxDelayTime in seconds.
    max_delay: f64,
    /// Ring length in frames: maxDelayTime·sr rounded up, plus a quantum.
    len: usize,
    lines: [Vec<f32>; 2],
    /// Where this quantum's first input frame goes.
    write: usize,
    /// The channel count the ring holds, taken from the last sounding input.
    channels: usize,
    /// Frames of silence written since the last sound (≥ len: the ring is
    /// all zeros).
    quiet: usize,
}

impl Delay {
    pub fn new(init: &NodeInit) -> Self {
        let max_delay = if init.opts[0] > 0.0 { init.opts[0] } else { 1.0 };
        let len = QUANTUM + (max_delay * init.sample_rate as f64).ceil() as usize;
        Delay {
            sample_rate: init.sample_rate,
            max_delay,
            len,
            lines: [vec![0.0; len], vec![0.0; len]],
            write: 0,
            channels: 1,
            quiet: len,
        }
    }

    /// Follows the input's channel count. Chrome rebuilds its delay kernels
    /// when the count changes, starting them empty, and so does this.
    fn adopt_channels(&mut self, input: &Bus) {
        if input.silent || input.channels == self.channels { return; }
        self.channels = input.channels;
        for line in self.lines.iter_mut() { line.fill(0.0); }
        self.quiet = self.len;
    }

    fn is_empty(&self) -> bool { self.quiet >= self.len }

    /// Copies the quantum's input into the ring at the write position
    /// (zeros for a silent input, skipped once the ring is all zeros).
    fn write_block(&mut self, input: &Bus) {
        if input.silent {
            if self.is_empty() { return; }
            self.quiet = self.quiet.saturating_add(QUANTUM);
        } else {
            self.quiet = 0;
        }
        let first = (self.len - self.write).min(QUANTUM);
        for c in 0..self.channels {
            let line = &mut self.lines[c];
            if input.silent {
                line[self.write..self.write + first].fill(0.0);
                line[..QUANTUM - first].fill(0.0);
            } else {
                let src = input.channel(c.min(input.channels - 1));
                line[self.write..self.write + first].copy_from_slice(&src[..first]);
                line[..QUANTUM - first].copy_from_slice(&src[first..]);
            }
        }
    }

    fn advance(&mut self) {
        self.write = (self.write + QUANTUM) % self.len;
    }

    /// Reads the quantum's output.
    fn read(&self, delay_time: ParamBlock, out: &mut Bus) {
        let len = self.len;
        let mut index = [0usize; QUANTUM];
        let mut fraction = [0f32; QUANTUM];

        match delay_time {
            ParamBlock::Const(t) => {
                // One read position for the quantum, worked out in f64.
                let t = (t as f64).clamp(0.0, self.max_delay);
                let frames = t * self.sample_rate as f64;
                let mut position = (self.write + len) as f64 - frames;
                if position >= len as f64 { position -= len as f64; }
                let first = position as usize;
                let f = (position - first as f64) as f32;
                for i in 0..QUANTUM {
                    let r = first + i;
                    index[i] = if r >= len { r - len } else { r };
                    fraction[i] = f;
                }
            }
            ParamBlock::Varying(times) => {
                // Chrome: the a-rate kernel runs four frames at a time in f32
                // SIMD (SSE2 and NEON alike), write index and read position
                // included, so a long ring quantises the read position to
                // the f32 spacing at its length. This is that arithmetic,
                // lane for lane.
                let len_f = len as f32;
                let max = self.max_delay as f32;
                let mut lanes = [0f32; 4];
                for (j, lane) in lanes.iter_mut().enumerate() {
                    let w = (self.write + j) as f32;
                    *lane = if w >= len_f { w - len_f } else { w };
                }
                for k in (0..QUANTUM).step_by(4) {
                    for j in 0..4 {
                        let t = times[k + j];
                        // A NaN delay reads as the longest, as Chrome's does.
                        let t = if t.is_nan() { max } else { t.clamp(0.0, max) };
                        let frames = t * self.sample_rate;
                        let mut position = lanes[j] + (len_f - frames);
                        if position >= len_f { position -= len_f; }
                        let r = position as usize;
                        index[k + j] = r;
                        fraction[k + j] = position - r as f32;
                        lanes[j] += 4.0;
                        if lanes[j] >= len_f { lanes[j] -= len_f; }
                    }
                }
            }
        }

        out.silent = false;
        for c in 0..out.channels {
            let line = &self.lines[c.min(self.channels - 1)];
            for (i, d) in out.data[c].iter_mut().enumerate() {
                let r1 = index[i];
                let r2 = if r1 + 1 == len { 0 } else { r1 + 1 };
                let (s1, s2) = (line[r1], line[r2]);
                *d = s1 + fraction[i] * (s2 - s1);
            }
        }
    }
}

impl Node for Delay {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }

    fn output_channels(&self, _o: usize, input_channels: &[usize]) -> usize {
        input_channels.first().copied().unwrap_or(1)
    }

    fn tail_frames(&self) -> f64 { self.max_delay * self.sample_rate as f64 }

    fn sample_accurate(&self) -> bool { true }

    fn allowed_in_cycle(&self) -> bool { true }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let input = &ctx.inputs[0];
        self.adopt_channels(input);
        if input.silent && self.is_empty() {
            out[0].zero();
            self.advance();
            return Activity::Silent;
        }
        self.write_block(input);
        self.read(ctx.params[0], &mut out[0]);
        self.advance();
        Activity::Active
    }
}
