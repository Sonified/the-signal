// WGSL for the brush (gpu/brush.js): each stamp is one instanced quad of a
// motif atlas tile, turned about its own centre and drawn into the brush's
// feedback image with premultiplied "over", so marks trail and fade there.
//
// The quad covers the tile's inner square, the motif's own, and the read is
// clamped half a texel inside it, so a filtered tap never reaches into a
// neighbour; the padding round it is transparent. Positions arrive in the
// target's device pixels with y down and go out in NDC (view.xy is 2 over
// the target's width and height), which lands right in an image made
// smaller by Trail res too (feedback.js). A positive angle turns clockwise
// on screen, as the copies turn (core/brush-stamps.js).

export const BRUSH_WGSL = /* wgsl */ `
struct BU {
  view: vec4f,  // 2 / target width, 2 / target height (device px), unused, unused
  lay: vec4f,   // the inner square's side as UV, half a texel as UV, unused, unused
};
@group(0) @binding(0) var<uniform> bu: BU;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) lo: vec2f,
  @location(2) hi: vec2f,
};

const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
);

// a: centre x, y (device px), half side (px), angle (radians)
// b: the tile's inner square's top left as UV, unused, unused
@vertex
fn vsStamp(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> VOut {
  var out: VOut;
  let q = QUAD[vi];
  let c = cos(a.w);
  let s = sin(a.w);
  let d = q * a.z;
  let p = a.xy + vec2f(c * d.x - s * d.y, s * d.x + c * d.y);
  out.pos = vec4f(p.x * bu.view.x - 1.0, 1.0 - p.y * bu.view.y, 0.0, 1.0);
  out.uv = b.xy + (q * 0.5 + vec2f(0.5, 0.5)) * bu.lay.x;
  out.lo = b.xy + vec2f(bu.lay.y, bu.lay.y);
  out.hi = b.xy + vec2f(bu.lay.x - bu.lay.y, bu.lay.x - bu.lay.y);
  return out;
}

@fragment
fn fsStamp(in: VOut) -> @location(0) vec4f {
  return textureSample(atlas, samp, clamp(in.uv, in.lo, in.hi));
}
`;
