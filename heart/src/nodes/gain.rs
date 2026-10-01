//! GainNode: every channel of the input times `gain`, sample by sample.
//!
//! The most common node in the app by far (every envelope, send and fader
//! is one), so it is also where silence is decided most often. A silent
//! input gives a silent output without touching a sample, and so does a
//! gain held at exactly zero, as Chrome's GainHandler does: that second rule
//! is what lets a voice whose envelope has closed cost nothing downstream.

use crate::node::{Activity, Bus, Node, NodeInit, ParamBlock, ParamSpec, Rate, RenderCtx};
use crate::simd;

static PARAMS: [ParamSpec; 1] = [
    ParamSpec { name: "gain", default: 1.0, min: -f32::MAX, max: f32::MAX, rate: Rate::A },
];

pub struct Gain;

impl Gain {
    pub fn new(_init: &NodeInit) -> Self { Gain }
}

impl Node for Gain {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }

    fn output_channels(&self, _o: usize, input_channels: &[usize]) -> usize {
        input_channels.first().copied().unwrap_or(1)
    }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let input = &ctx.inputs[0];
        let out = &mut out[0];
        let gain = ctx.params[0];
        // Chrome zeroes only a gain that is constant over the quantum; a ramp
        // passing through zero still multiplies, and so gives zeros the long
        // way round, exactly as it does there.
        if input.silent || matches!(gain, ParamBlock::Const(g) if g == 0.0) {
            out.zero();
            return Activity::Silent;
        }
        out.silent = false;
        for c in 0..out.channels {
            // A mono input feeding a wider output is copied to every channel.
            let src = input.channel(c.min(input.channels - 1));
            let dest = &mut out.data[c];
            match gain {
                ParamBlock::Const(g) => simd::scale_from(dest, src, g),
                ParamBlock::Varying(g) => {
                    simd::copy(dest, src);
                    simd::mul_into(dest, g);
                }
            }
        }
        Activity::Active
    }
}
