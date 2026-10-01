//! A one-pole low-pass, 6 dB an octave, for the drone filter's gentlest
//! rolloff: the browser's BiquadFilterNode starts at 12. This is the port of
//! js/worklet.js's 'one-pole' processor, sample for sample.
//!
//! It is the topology-preserving (trapezoidal) form, so it stays stable and
//! exact as the cutoff moves every sample, and it passes the signal through
//! untouched with the cutoff at the top. The cutoff is an a-rate param, so a
//! ConstantSource connected to it (piano.js's shared drone cutoff) drives it
//! sample for sample alongside the biquad chains.
//!
//! The per-sample gains are worked out once per quantum and shared by both
//! channels. While the drone's sweep runs the cutoff differs on every sample,
//! which would mean a tan per sample per channel; instead the gain is
//! computed exactly every GSTEP samples and drawn in a straight line between.
//! The sweep's slowest breakpoint is thousands of samples long and tan barely
//! curves over eight, so the difference is far below anything audible, and a
//! quantum costs seventeen tans instead of two hundred and fifty-six.
//!
//! Numbers are f64 throughout, as the JS's are, and the state is f64 as its
//! Float64Array is.

use crate::node::{Activity, Bus, ChannelConfig, Node, NodeInit, ParamSpec, Rate, RenderCtx, QUANTUM};

static PARAMS: [ParamSpec; 1] = [
    ParamSpec { name: "frequency", default: 24000.0, min: 0.0, max: 96000.0, rate: Rate::A },
];

/// Exact gains every this many samples, straight lines between.
const GSTEP: usize = 8;

pub struct OnePole {
    sample_rate: f64,
    /// Each channel's integrator state.
    s: [f64; 2],
    /// This quantum's gain per sample, shared by both channels.
    g: [f64; QUANTUM],
}

impl OnePole {
    pub fn new(init: &NodeInit) -> Self {
        OnePole { sample_rate: init.sample_rate as f64, s: [0.0; 2], g: [0.0; QUANTUM] }
    }

    /// The trapezoidal integrator's gain G = g / (1 + g) for a cutoff of f
    /// hertz. At or past the top it is a straight wire: G = 1 gives y = x.
    fn gain_at(&self, f: f64) -> f64 {
        if f >= 0.49 * self.sample_rate { return 1.0; }
        let g = (std::f64::consts::PI / self.sample_rate * f.max(1.0)).tan();
        g / (1.0 + g)
    }

    fn fill_gains(&mut self, fq: &crate::node::ParamBlock) {
        let n = QUANTUM;
        if let crate::node::ParamBlock::Const(f) = *fq {
            let g = self.gain_at(f as f64);
            self.g.fill(g);
            return;
        }
        let mut i0 = 0;
        let mut f0 = fq.at(0) as f64;
        let mut g0 = self.gain_at(f0);
        while i0 < n - 1 {
            let i1 = (i0 + GSTEP).min(n - 1);
            let f1 = fq.at(i1) as f64;
            // A cutoff holding still (the sweep off, or parked between
            // ramps) is one gain for the whole stretch, exactly as before.
            let g1 = if f1 == f0 { g0 } else { self.gain_at(f1) };
            let d = (g1 - g0) / (i1 - i0) as f64;
            for i in i0..i1 { self.g[i] = g0 + d * (i - i0) as f64; }
            i0 = i1; f0 = f1; g0 = g1;
        }
        self.g[n - 1] = g0;
    }
}

impl Node for OnePole {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }

    /// Two channels, as the app constructs it (outputChannelCount [2]).
    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { 2 }

    /// An AudioWorkletNode's defaults: two channels, max, speakers.
    fn channel_config(&self) -> ChannelConfig { ChannelConfig::default() }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let inp = &ctx.inputs[0];
        let o = &mut out[0];
        // With nothing live at its input the worklet is handed no channels
        // and writes nothing, its state held where it was; so here.
        if inp.silent {
            o.zero();
            return Activity::Silent;
        }
        self.fill_gains(&ctx.params[0]);
        let g = &self.g;
        for ch in 0..o.channels {
            // A mono input feeds both channels, as `inp[ch] || inp[0]` does.
            let x = inp.channel(if ch < inp.channels { ch } else { 0 });
            let y = &mut o.data[ch];
            let mut s = self.s[ch];
            for i in 0..QUANTUM {
                let v = (x[i] as f64 - s) * g[i];
                let r = v + s;
                s = r + v;
                y[i] = r as f32;
            }
            self.s[ch] = s;
        }
        o.silent = false;
        Activity::Active
    }
}
