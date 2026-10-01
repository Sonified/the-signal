//! The spec's channel rules: how many channels an input mixes to, and how a
//! connection of one width is summed into an input of another.
//!
//! Every bus in the app is mono or stereo, so the speaker layouts here are
//! the spec's mono and stereo ones: up-mixing mono copies it to both sides,
//! down-mixing stereo takes ½(L + R). 'discrete' (which the app never asks
//! for, but the wire can say) fills the channels both sides have and drops
//! or leaves silent the rest.

use crate::node::{Bus, ChannelConfig, CountMode, QUANTUM};
use crate::simd;

/// computedNumberOfChannels: what an input mixes to, given the widest of
/// the connections feeding it. As Chrome does, every connection counts,
/// sounding or not, and an input with none is mono.
pub fn computed_channels(cfg: &ChannelConfig, widest: usize) -> usize {
    let widest = widest.max(1);
    match cfg.mode {
        CountMode::Max => widest,
        CountMode::ClampedMax => widest.min(cfg.count),
        CountMode::Explicit => cfg.count,
    }
}

/// Sums `src` into `dst` (already sized to its channel count), up- or
/// down-mixing as `speakers` says. A silent `src` adds nothing, and the
/// first sounding one is copied rather than added, so `dst` needs no
/// clearing first: it must come in with `silent` set when it holds nothing.
pub fn mix_into(dst: &mut Bus, src: &Bus, speakers: bool) {
    if src.silent { return; }
    let first = dst.silent;
    dst.silent = false;
    let (dn, sn) = (dst.channels, src.channels);
    if dn == sn || !speakers {
        for c in 0..dn {
            if c < sn {
                put(&mut dst.data[c], &src.data[c], first);
            } else if first {
                dst.data[c].fill(0.0);
            }
        }
    } else if sn == 1 {
        // mono → stereo: the one channel to both sides
        for c in 0..dn { put(&mut dst.data[c], &src.data[0], first); }
    } else {
        // stereo → mono: ½(L + R)
        let out = &mut dst.data[0];
        if first { simd::scale_from(out, &src.data[0], 0.5); } else { simd::mul_add(out, &src.data[0], 0.5); }
        simd::mul_add(out, &src.data[1], 0.5);
    }
}

#[inline]
fn put(dst: &mut [f32; QUANTUM], src: &[f32; QUANTUM], first: bool) {
    if first { simd::copy(dst, src) } else { simd::add_into(dst, src) }
}
