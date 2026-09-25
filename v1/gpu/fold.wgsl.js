// WGSL for the reusable kaleidoscope fold (see fold.js): one fullscreen
// triangle in the scene pass that turns every screen pixel's angle about the
// field centre back into the fundamental domain and reads a chamber texture
// there. The maths is kaleido.wgsl.js's fsFold, the same fold the
// kaleidoscope layer uses, with its motif tint left out (a layer that wants a
// tint can put it into the chamber itself) and the layer gain moved into the
// map block so the struct stays four vectors.
//
// The chamber shares the screen's orientation and scale about the field
// centre, shrunk by map.z texels per device px, with the field centre at
// map.xy (the middle of the chamber's bottom edge, since the domain always
// points straight up). Whatever a layer drew there is premultiplied, so the
// output is too, and the pipeline blends one / one-minus-src-alpha: a chamber
// texel with alpha 0 simply adds its light, one with alpha 1 covers the
// field, and everything between is the ordinary premultiplied over.

export const FOLD_WGSL = `
struct FU {
  chamber: vec4f, // chamber texture width, height, 1/width, 1/height (texels)
  map: vec4f,     // the field centre's place in the chamber (texels), texels per device px, gain
  fold: vec4f,    // field centre x, y (device px), wedge angle, complete rotation (radians)
  dom: vec4f,     // the domain's starting angle, mirror (0 or 1), unused, unused
};
@group(0) @binding(0) var<uniform> u: FU;
@group(0) @binding(1) var chamberTex: texture_2d<f32>;
@group(0) @binding(2) var chamberSamp: sampler;

@vertex
fn vsFold(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

// The pixel's angle, less the complete rotation, is measured from the
// domain's start and taken modulo one wedge; with mirror, the far half of
// each wedge is reflected back onto the near half, so alternate copies are
// mirror images and a mirror line reads the same chamber texel from either
// side. The radius is kept, so the chamber point is the pixel turned about
// the centre into the domain. At the exact centre atan2 has no answer and any
// angle lands on the same chamber point, so it is taken as 0.
@fragment
fn fsFold(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let v = p.xy - u.fold.xy;
  let r = length(v);
  let a = select(0.0, atan2(v.y, v.x), r > 1e-3);
  let w = u.fold.z;
  let rel = a - u.fold.w - u.dom.x;
  var m = rel - w * floor(rel / w);
  if (u.dom.y > 0.5) {
    m = 0.5 * w - abs(m - 0.5 * w);
  }
  let ang = u.dom.x + m;
  let t = u.map.xy + vec2f(cos(ang), sin(ang)) * (r * u.map.z);
  let c = textureSampleLevel(chamberTex, chamberSamp, t * u.chamber.zw, 0.0);
  return c * u.map.w;
}
`;
