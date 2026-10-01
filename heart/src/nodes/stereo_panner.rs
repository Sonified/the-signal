//! StereoPannerNode: the spec's equal-power pan, for mono and stereo inputs.
//!
//! A mono input is placed between the speakers with gains cos and sin of the
//! pan's quarter turn, so its power stays constant as it moves. A stereo
//! input is not re-panned as a whole; the side being panned away from is
//! folded into the other with the same equal-power gains, so a stereo image
//! panned hard left is both channels in the left speaker, and at the centre
//! the input passes through.
//!
//! The arithmetic follows Chrome's stereo_panner.cc: gains in f64, each
//! output rounded to f32 once.

use std::f64::consts::FRAC_PI_2;

use crate::node::{Activity, Bus, ChannelConfig, CountMode, Node, NodeInit, ParamBlock, ParamSpec, Rate, RenderCtx};

static PARAMS: [ParamSpec; 1] = [
    ParamSpec { name: "pan", default: 0.0, min: -1.0, max: 1.0, rate: Rate::A },
];

pub struct StereoPanner;

impl StereoPanner {
    pub fn new(_init: &NodeInit) -> Self { StereoPanner }
}

/// The left and right gains for a mono input at `pan`: x = (pan + 1)/2.
#[inline]
fn mono_gains(pan: f64) -> (f64, f64) {
    let angle = (pan * 0.5 + 0.5) * FRAC_PI_2;
    (angle.cos(), angle.sin())
}

/// The fold gains for a stereo input: x = pan + 1 when panning left (pan ≤ 0),
/// x = pan when panning right.
#[inline]
fn stereo_gains(x: f64) -> (f64, f64) {
    let angle = x * FRAC_PI_2;
    (angle.cos(), angle.sin())
}

/// One stereo frame at `pan`, with its fold gains already worked out.
#[inline]
fn fold(l: f32, r: f32, pan: f64, gain_l: f64, gain_r: f64) -> (f32, f32) {
    if pan <= 0.0 {
        ((l as f64 + r as f64 * gain_l) as f32, (r as f64 * gain_r) as f32)
    } else {
        ((l as f64 * gain_l) as f32, (r as f64 + l as f64 * gain_r) as f32)
    }
}

impl Node for StereoPanner {
    fn param_specs(&self) -> &'static [ParamSpec] { &PARAMS }

    fn output_channels(&self, _o: usize, _input_channels: &[usize]) -> usize { 2 }

    fn channel_config(&self) -> ChannelConfig {
        ChannelConfig { count: 2, mode: CountMode::ClampedMax, speakers: true }
    }

    fn render(&mut self, ctx: &mut RenderCtx, out: &mut [Bus]) -> Activity {
        let input = &ctx.inputs[0];
        let out = &mut out[0];
        if input.silent {
            out.zero();
            return Activity::Silent;
        }
        out.channels = 2;
        out.silent = false;
        let [dest_l, dest_r] = &mut out.data;
        let src_l = input.channel(0);

        if input.channels == 1 {
            match ctx.params[0] {
                ParamBlock::Const(pan) => {
                    let (gl, gr) = mono_gains(pan.clamp(-1.0, 1.0) as f64);
                    for i in 0..src_l.len() {
                        let x = src_l[i] as f64;
                        dest_l[i] = (x * gl) as f32;
                        dest_r[i] = (x * gr) as f32;
                    }
                }
                ParamBlock::Varying(pans) => {
                    for i in 0..src_l.len() {
                        let (gl, gr) = mono_gains((pans[i] as f64).clamp(-1.0, 1.0));
                        let x = src_l[i] as f64;
                        dest_l[i] = (x * gl) as f32;
                        dest_r[i] = (x * gr) as f32;
                    }
                }
            }
        } else {
            let src_r = input.channel(1);
            match ctx.params[0] {
                ParamBlock::Const(pan) => {
                    let pan = pan.clamp(-1.0, 1.0);
                    // Chrome: in the constant path `pan + 1` is an f32 sum
                    // (in the varying path it is f64); this keeps its rounding.
                    let x = if pan <= 0.0 { pan + 1.0 } else { pan };
                    let (gl, gr) = stereo_gains(x as f64);
                    for i in 0..src_l.len() {
                        (dest_l[i], dest_r[i]) = fold(src_l[i], src_r[i], pan as f64, gl, gr);
                    }
                }
                ParamBlock::Varying(pans) => {
                    for i in 0..src_l.len() {
                        let pan = (pans[i] as f64).clamp(-1.0, 1.0);
                        let (gl, gr) = stereo_gains(if pan <= 0.0 { pan + 1.0 } else { pan });
                        (dest_l[i], dest_r[i]) = fold(src_l[i], src_r[i], pan, gl, gr);
                    }
                }
            }
        }
        Activity::Active
    }
}
