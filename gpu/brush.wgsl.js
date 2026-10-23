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
//
// The morph (core/brush-morph.js, view.z): each stamp is also a small
// glowing particle, round about the stamp's centre (so it looks the same at
// any turn), tinted with its own tile's average colour (tint, measured from
// the atlas, gpu/atlas-bake.js tileTints) and sized with the stamp, its glow
// reaching PART_REACH of the quad's half side: the voice's glow shape
// (particles.wgsl.js), a bright core in a soft halo. The shape is drawn at
// 1 - m and the particle at m, in the one draw, so the crossfade costs no
// second pass; at 0 the particle is never worked out. The particle's halo
// is laid over like the shape (premultiplied, its alpha its coverage), so a
// dense stroke of them settles to its colour rather than burning white, and
// only its core's peak over 1 adds light.

export const BRUSH_WGSL = /* wgsl */ `
struct BU {
  view: vec4f,  // 2 / target width, 2 / target height (device px), the morph (0 shapes, 1 particles), unused
  lay: vec4f,   // the inner square's side as UV, half a texel as UV, unused, unused
  tint: array<vec4f, 64>,  // each tile's average colour, straight, 0..1 (sheet order)
};
@group(0) @binding(0) var<uniform> bu: BU;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) lo: vec2f,
  @location(2) hi: vec2f,
  @location(3) q: vec2f,
  @location(4) @interpolate(flat) tint: vec3f,
};

// How far the particle's glow reaches, as a share of the quad's half side.
const PART_REACH = 0.6;

const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
);

// a: centre x, y (device px), half side (px), angle (radians)
// b: the tile's inner square's top left as UV, the tile (0..63), unused
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
  out.q = q;
  out.tint = bu.tint[min(u32(b.z + 0.5), 63u)].rgb;
  return out;
}

@fragment
fn fsStamp(in: VOut) -> @location(0) vec4f {
  let shape = textureSample(atlas, samp, clamp(in.uv, in.lo, in.hi));
  let m = bu.view.z;
  if (m <= 0.0) { return shape; }
  let d = length(in.q) / PART_REACH;
  let core = exp(-d * d * 40.0);
  let halo = exp(-d * d * 6.0) * 0.35;
  let g = (core + halo) * (1.0 - smoothstep(0.9, 1.0, d));
  let light = vec4f(in.tint * g, min(g, 1.0));
  return shape * (1.0 - m) + light * m;
}
`;
