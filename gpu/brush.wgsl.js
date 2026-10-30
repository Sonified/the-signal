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
// (particles.wgsl.js), a bright core in a soft halo. The shape keeps its
// share of its coverage (c.x, colour and coverage alike, premultiplied)
// and the particle gives its share of light (c.y), both worked out per
// stamp so a ribbon of overlapping stamps crossfades as one, 1 - m and m
// (gpu/brush.js shapeKeep, particleLight), in the one draw, so the
// crossfade costs no second pass; at 0 the particle is never worked out. The particle is
// light, as the voice's glow is: its alpha stays 0, so premultiplied "over"
// adds it to whatever is beneath, and where particles crowd (a dense
// ribbon, two hands over one spot) they bloom brighter toward white rather
// than settling to a flat paint. Its colour is the tile's average at full
// brightness (its hue and saturation kept, its value raised to 1, so a dark
// motif glows as brightly as a light one; a tile with next to no colour
// glows white), times its stamp's share of the ribbon's light (b.w,
// gpu/brush.js particleLight: a dense ribbon's stamps each give less, so the
// ribbon stands at its colour instead of adding up to white) and view.w,
// the drawer's Particle brightness. The shape's path is untouched by any of
// it.
//
// Each stamp's brightness (c.z, 1 but on a replayed stroke's fade up and
// fade down, core/brush.js fadeGains) multiplies all it gives, shape and
// light together, premultiplied, so a faded stamp is dimmer and thinner
// alike, in the trail and live; at 1 it is exactly what it was.

export const BRUSH_WGSL = /* wgsl */ `
struct BU {
  view: vec4f,  // 2 / target width, 2 / target height (device px), the morph (0 shapes, 1 particles), the particles' brightness
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
  @location(5) @interpolate(flat) light: f32,
  @location(6) @interpolate(flat) keep: f32,
  @location(7) @interpolate(flat) gain: f32,
};

// How far the particle's glow reaches, as a share of the quad's half side.
const PART_REACH = 0.6;

const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
);

// a: centre x, y (device px), half side (px), angle (radians)
// b: the tile's inner square's top left as UV, the tile (0..63), unused
// c: the share of its shape's coverage it keeps, its particle's light (the
//    morph already in both, gpu/brush.js shapeKeep and particleLight), its
//    brightness, unused
@vertex
fn vsStamp(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c4: vec4f) -> VOut {
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
  out.light = c4.y * bu.view.w;
  out.keep = c4.x;
  out.gain = c4.z;
  // the tile's colour at full brightness: hue and saturation kept, value 1
  let avg = bu.tint[min(u32(b.z + 0.5), 63u)].rgb;
  let top = max(avg.r, max(avg.g, avg.b));
  out.tint = select(vec3f(1.0, 1.0, 1.0), avg / max(top, 1e-3), top >= 0.02);
  return out;
}

@fragment
fn fsStamp(in: VOut) -> @location(0) vec4f {
  let shape = textureSample(atlas, samp, clamp(in.uv, in.lo, in.hi));
  let m = bu.view.z;
  if (m <= 0.0) { return shape * in.gain; }
  let d = length(in.q) / PART_REACH;
  let core = exp(-d * d * 40.0);
  let halo = exp(-d * d * 6.0) * 0.35;
  let g = (core + halo) * (1.0 - smoothstep(0.9, 1.0, d));
  // the shape premultiplied, colour and coverage faded together; the
  // particle light alone (alpha 0), so it adds
  let light = vec4f(in.tint * (g * in.light), 0.0);
  return (shape * in.keep + light) * in.gain;
}
`;
