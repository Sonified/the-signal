// WGSL for the kaleidoscope layer, in two halves that share one uniform
// block (uniforms, a texture, a sampler; the sprite half adds a second
// texture, see tex2).
//
// The sprite half draws the object chamber: one instanced quad per object,
// sampled from the 8 x 8 motif atlas that kaleido.js cleans, premultiplies
// and mipmaps at load, into an offscreen chamber texture cleared to
// transparent each frame. The mip chain itself is built with the flower
// layer's box-filter pass (MIP_WGSL in flowers.wgsl.js), which knows nothing
// about either atlas and averages premultiplied texels correctly as they are.
//
// The fold half is a fullscreen pass in the scene. Every screen pixel's angle
// about the field centre is folded back into the fundamental domain, the one
// wedge the chamber holds, and the chamber is read there. That is the whole
// kaleidoscope: every object in the chamber appears once per wedge (twice
// with mirror, as mirror images), and where an object crosses a mirror line
// it meets its own reflection, merges and splits, with no seam to hide,
// because both sides of the line read the very same chamber pixels.
//
// Every colour in the atlas and the chamber is premultiplied and every output
// here is too, so both pipelines blend with one / one-minus-src-alpha, exactly
// as the flowers do, and the motifs sit on the field as solid objects rather
// than adding light to it.

export const KALEIDO_WGSL = `
struct KU {
  chamber: vec4f, // chamber texture width, height, 1/width, 1/height (texels)
  map: vec4f,     // the field centre's place in the chamber (texels), texels per device px, hole radius (device px)
  tint: vec4f,    // strobe colour scaled so its brightest channel is 1, tint amount
  fold: vec4f,    // field centre x, y (device px), wedge angle, complete rotation (radians)
  dom: vec4f,     // the domain's starting angle, mirror (0 or 1), layer gain, unused
  grade: vec4f,   // brightness, contrast, saturation (1 leaves each alone), unused
  lay0: vec4f,    // tex's layout as UV: tile padding, motif inner square, half a texel, unused
  lay1: vec4f,    // the same for tex2 (see the layout note below)
};
@group(0) @binding(0) var<uniform> u: KU;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
// The sprite half only: the second motif atlas. While the Image set
// crossfades, pieces born from the outgoing set keep drawing from its atlas
// until they retire, so two atlases are live at once; each instance says
// which of the two it reads. With one set live both bindings hold the same
// atlas. The fold never reads it, so its layout leaves it out.
@group(0) @binding(3) var tex2: texture_2d<f32>;

// Every atlas is 8 x 8 tiles, each a motif's inner square inside a frame of
// transparent padding: 1024 texels square with 12 round 104 for an ordinary
// set, 1536 with 18 round 156 for a high resolution one. The two share
// proportions, but each atlas says its own (lay0 for tex, lay1 for tex2),
// because during a set crossfade the two bindings can hold one of each. The
// quad covers only the inner square, and sampling is clamped half a texel
// inside it, so bilinear taps and every mip level the sampler reaches never
// touch a neighbouring motif.
const TILE_UV = 0.125;

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) lo: vec2f,
  @location(2) @interpolate(flat) hi: vec2f,
  @location(3) alpha: f32,
  @location(4) @interpolate(flat) slot: f32,
};

// One instance per object: its centre as device px from the field centre,
// half size and alpha; then its up axis (its own outward ray turned by its
// spin), the motif index and which atlas it reads (0 tex, 1 tex2); the
// motif index is a tile of that atlas, not of the other. The chamber shares
// the screen's orientation and scale about the field centre, shrunk by map.z texels per device px, so the
// only step from screen space into it is that scale and an offset. Corners
// come from vertex_index, as the flowers' do.
@vertex
fn vsSprite(@builtin(vertex_index) vi: u32,
            @location(0) posHalfAlpha: vec4f,
            @location(1) upMotif: vec4f) -> SOut {
  var ks = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let k = ks[vi];
  let sx = select(-1.0, 1.0, (k & 1u) == 1u);
  let sy = select(-1.0, 1.0, (k & 2u) == 2u);
  let motif = u32(upMotif.z + 0.5) & 63u;
  let up = upMotif.xy;
  // Image y runs from the top of the motif down, so -sy steps outward along up.
  let across = vec2f(-up.y, up.x);
  let wp = posHalfAlpha.xy + (across * sx - up * sy) * posHalfAlpha.z;
  let t = u.map.xy + wp * u.map.z;

  var o: SOut;
  o.pos = vec4f(t.x * u.chamber.z * 2.0 - 1.0, 1.0 - t.y * u.chamber.w * 2.0, 0.0, 1.0);
  let lay = select(u.lay0, u.lay1, upMotif.w > 0.5);
  let tile = vec2f(f32(motif & 7u), f32(motif >> 3u)) * TILE_UV;
  o.uv = tile + vec2f(lay.x) + (vec2f(sx, sy) * 0.5 + 0.5) * lay.y;
  o.lo = tile + vec2f(lay.x + lay.z);
  o.hi = tile + vec2f(lay.x + lay.y - lay.z);
  o.alpha = posHalfAlpha.w;
  o.slot = upMotif.w;
  return o;
}

// The atlas is picked per instance, so the read sits in a branch that is
// not uniform; textureSample would need uniform control flow for its
// implicit derivatives, so they are taken first, outside the branch, and
// handed to textureSampleGrad, which picks exactly the mip level the plain
// read did. Only one atlas is read per fragment.
@fragment
fn fsSprite(o: SOut) -> @location(0) vec4f {
  let uv = clamp(o.uv, o.lo, o.hi);
  let gx = dpdx(uv);
  let gy = dpdy(uv);
  var c: vec4f;
  if (o.slot > 0.5) {
    c = textureSampleGrad(tex2, samp, uv, gx, gy);
  } else {
    c = textureSampleGrad(tex, samp, uv, gx, gy);
  }
  return c * o.alpha;
}

@vertex
fn vsFold(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

// The fold. The pixel's angle, less the complete rotation, is measured from
// the domain's start and taken modulo one wedge; with mirror, the far half of
// each wedge is reflected back onto the near half, so alternate copies are
// mirror images and a mirror line reads the same chamber pixel from either
// side. The radius is kept, so the chamber point is the pixel turned about
// the centre into the domain, and one bilinear read there is the answer.
// At the exact centre the angle means nothing and atan2 has no answer; any
// angle lands on the same chamber point there, so it is simply taken as 0.
// Tint multiplies toward the strobe colour rather than replacing it, so each
// motif's own shading survives at any amount.
//
// What the fold samples, in the chamber's own frame (straight up is the
// domain's centre line, the complete rotation turns the screen's read, never
// the chamber): every point whose angle from straight up is within half the
// domain either side (the whole wedge 2 pi / folds unmirrored, half of it
// mirrored) and whose radius runs from the hole out to the farthest screen
// pixel, plus the one chamber texel a bilinear read reaches past each edge.
// The hole is a small disk about the centre, map.w device px, that the fold
// reads nothing from at all, opening to a full read by twice that radius.
// Every object is born wholly inside it (kaleido.js sizes it so, sprite and
// bilinear reach included), so nothing is ever born where the fold can see
// it: a newborn comes into view only by flying out across that soft edge,
// leading edge first, as anything entering past the screen's edge would.
// The wedge's apex is a single point where every wedge meets, so the hole
// costs the pattern nothing it could show.
@fragment
fn fsFold(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let v = p.xy - u.fold.xy;
  let r = length(v);
  if (r <= u.map.w) {
    return vec4f(0.0);
  }
  let hole = smoothstep(u.map.w, 2.0 * u.map.w, r);
  let a = select(0.0, atan2(v.y, v.x), r > 1e-3);
  let w = u.fold.z;
  let rel = a - u.fold.w - u.dom.x;
  var m = rel - w * floor(rel / w);
  if (u.dom.y > 0.5) {
    m = 0.5 * w - abs(m - 0.5 * w);
  }
  let ang = u.dom.x + m;
  let t = u.map.xy + vec2f(cos(ang), sin(ang)) * (r * u.map.z);
  let c = textureSampleLevel(tex, samp, t * u.chamber.zw, 0.0);
  // Most of the chamber is empty, and an empty texel grades and tints to
  // nothing, so it goes straight out as nothing.
  if (c.a <= 0.0) {
    return vec4f(0.0);
  }
  // The grade works on the straight colour, so a soft edge is graded like
  // the body it belongs to: saturation about Rec. 709 luma, contrast about
  // mid grey, then brightness as a gain. Premultiplied again after. With
  // the Color switch off the grade is the identity (all three 1, a uniform
  // branch), and the texel is already what it would give.
  var s = c.rgb;
  if (u.grade.x != 1.0 || u.grade.y != 1.0 || u.grade.z != 1.0) {
    s = c.rgb / max(c.a, 1e-4);
    s = mix(vec3f(dot(s, vec3f(0.2126, 0.7152, 0.0722))), s, u.grade.z);
    s = (s - 0.5) * u.grade.y + 0.5;
    s = clamp(s * u.grade.x, vec3f(0.0), vec3f(1.0)) * c.a;
  }
  let rgb = mix(s, s * u.tint.rgb, u.tint.w);
  return vec4f(rgb, c.a) * (u.dom.z * hole);
}
`;
