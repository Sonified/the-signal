//! AnalyserNode, as far as the app uses one: the input passes through
//! untouched, and the node remembers the last fftSize frames of its mono
//! down-mix so it can answer "how loud was it just now" with the peak |x|
//! over them. The app reads nothing else from an analyser, so there is no
//! FFT here.
//!
//! The history never skips. A silent quantum writes zeros into it, and the
//! node keeps a tail of fftSize frames so the graph goes on rendering it
//! until the history has emptied; a meter on a voice that has gone quiet
//! then falls to zero, as a native one does, instead of holding its last
//! loud moment. Should the graph skip quanta all the same, the gap is
//! written as the silence it was.

use crate::events::Events;
use crate::node::{Activity, Bus, Node, NodeInit, QUANTUM, RenderCtx};
use crate::simd;

/// The attr that sets fftSize (protocol.json attrs.fftSize).
const ATTR_FFT_SIZE: u32 = 7;
const DEFAULT_FFT_SIZE: usize = 2048;

/// fftSize is a power of two from 32 to 32768 (spec); anything else is
/// refused, keeping the size it had.
fn valid_fft_size(v: f64) -> Option<usize> {
    let n = v as usize;
    (v == n as f64 && (32..=32768).contains(&n) && n.is_power_of_two()).then_some(n)
}

pub struct Analyser {
    /// The last fftSize frames of the mono down-mix, oldest overwritten first.
    history: Vec<f32>,
    /// Where the next frame goes.
    next: usize,
    /// The engine frame the next quantum should start at, to spot a gap.
    expected: Option<u64>,
}

impl Analyser {
    pub fn new(init: &NodeInit) -> Self {
        let size = valid_fft_size(init.opts[0]).unwrap_or(DEFAULT_FFT_SIZE);
        Analyser { history: vec![0.0; size], next: 0, expected: None }
    }

    fn push(&mut self, x: f32) {
        self.history[self.next] = x;
        self.next += 1;
        if self.next == self.history.len() { self.next = 0; }
    }

    fn push_silence(&mut self, frames: usize) {
        for _ in 0..frames.min(self.history.len()) { self.push(0.0); }
    }
}

impl Node for Analyser {
    fn output_channels(&self, _o: usize, input_channels: &[usize]) -> usize {
        input_channels.first().copied().unwrap_or(1)
    }

    fn tail_frames(&self) -> f64 { self.history.len() as f64 }

    fn set_attr(&mut self, attr: u32, value: f64) {
        let Some(size) = valid_fft_size(value).filter(|_| attr == ATTR_FFT_SIZE) else { return };
        if size == self.history.len() { return; }
        // Keep the most recent frames that fit, oldest first, so the peak
        // stays true across the change.
        let old = self.history.len();
        let kept = size.min(old);
        let mut history = vec![0.0; size];
        for (i, slot) in history[size - kept..].iter_mut().enumerate() {
            *slot = self.history[(self.next + old - kept + i) % old];
        }
        self.history = history;
        self.next = 0;
    }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        if let Some(expected) = self.expected && ctx.frame > expected {
            self.push_silence((ctx.frame - expected) as usize);
        }
        self.expected = Some(ctx.frame + QUANTUM as u64);

        let input = &ctx.inputs[0];
        let out = &mut out[0];
        if input.silent {
            self.push_silence(QUANTUM);
            out.zero();
            return Activity::Silent;
        }
        out.silent = false;
        for c in 0..out.channels {
            out.data[c] = *input.channel(c.min(input.channels - 1));
        }
        // The spec's speakers down-mix of stereo to mono: ½(L + R).
        if input.channels == 1 {
            for i in 0..QUANTUM { self.push(input.data[0][i]); }
        } else {
            for i in 0..QUANTUM { self.push(0.5 * (input.data[0][i] + input.data[1][i])); }
        }
        Activity::Active
    }

    fn request_peak(&mut self, node: u32, events: &mut Events) {
        events.peak(node, simd::max_abs(&self.history));
    }
}
