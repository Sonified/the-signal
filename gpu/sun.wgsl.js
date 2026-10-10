// WGSL for the Sun layer (gpu/sun.js): the sun at the field centre, drawn
// from one frame of the NASA SDO mosaic video, imported zero copy as a
// texture_external each frame.
//
// The mosaic is a 3 x 2 grid of tiles, one SDO channel each: row 0 holds
// 1700, 0304 and 0171, row 1 holds 0193 and 0211 (the sixth tile is black).
// The picture is meditatewiththesun.com's composite exactly: every channel's
// tile read at the same point, multiplied by its tint and its gain, and
// summed, so the channels add as light. The gains come from the CPU (the
// Atmosphere sweep, at most two channels lit at once, summing to 1), so the
// sum never passes the brightest tint; it is clamped all the same.
//
// The frame: the whole square tile is drawn, corona and all, never clipped
// at the limb. Its edge is taken away by the site's own circular feather
// instead: in the quad's uv (0 to 1 across the tile), r is the distance from
// the middle in half widths (1 at the edges' midpoints, root 2 at the
// corners), and the picture fades to black across a band FEATHER_HARD wide
// about FEATHER_SIZE, so the corona reaches out and melts away, the sun
// floating in the room rather than seen through a window frame. The site's
// defaults, as constants. The tile, and so the sun, is sized on the CPU
// (gpu/sun.js) so the photosphere keeps the diameter Size gives it.
//
// The output is light, premultiplied with alpha 0, as the site composites
// additively over black: it adds to whatever is under it (the blend is the
// repo's premultiplied over, where alpha 0 adds), and the feather scales the
// whole texel, so the contribution goes smoothly to nothing. A fold's chamber
// and the feedback image take light the same way (fold.js, feedback.js).
//
// The Center fade, the site's gate on what feeds the trails: in the same r,
// the picture is scaled by smoothstep(G - w, G + w, r), so the inner
// sun lays nothing into the feedback image and the energy flows only from
// the edge. G is look.z and the band's half width w is g1.y (the Softness,
// 0.03 the site's own), both set only in the feedback image's slot (gpu/sun.js);
// the scene and the chamber pass 0, and at 0 the gate is skipped entirely
// (smoothstep(-w, w, r) would still dim a dot at the very centre), so
// the live picture is never gated. r is in the sun's own square, so the gate
// grows with Size and the look holds.
//
// The Color grade, the site's own brightness and colorization, taken on the
// summed picture before the feather and the Center fade, so every target
// (scene, chamber, feedback image) carries it: brightness scales, contrast
// pivots about mid grey, saturation mixes from the Rec. 709 luma, then a
// clamp, in the site's order. grade.w says it is on; off, the branch is
// skipped and the picture is exactly as without it. Note the layer adds
// light: a contrast below 1 lifts black toward grey, so the whole square
// lays a faint wash over the scene (only the feather takes it away). That
// is the site's math, kept faithfully.
//
// One shader serves three targets (the scene, the fold's chamber, the
// feedback image), each with its own uniform slot (a dynamic offset):
// place.xy is the centre in the target's own texels and place.z the target's
// texels per device px, so the vertex stage lays the square in those texels
// and the fragment stage turns its own position back into device px about
// the centre.

export const SUN_WGSL = `
struct SU {
  place: vec4f, // centre x, y (target texels), target texels per device px, the square's half side (device px)
  look: vec4f,  // target width, height (texels), Center fade G (0 off), gain
  g0: vec4f,    // channel gains: 1700, 0304, 0171, 0193
  g1: vec4f,    // channel gain 0211, Center fade band half width w (square units), unused x2
  grade: vec4f, // Color grade: brightness, contrast, saturation, on (0 or 1)
};
@group(0) @binding(0) var<uniform> u: SU;
@group(0) @binding(1) var sunTex: texture_external;
@group(0) @binding(2) var sunSamp: sampler;

// meditatewiththesun.com's feather: where it sits, in half widths from the
// middle, and how hard it is (0 soft, a band 0.6 wide; 1 a near cut).
const FEATHER_SIZE: f32 = 0.90;
const FEATHER_HARD: f32 = 0.40;

@vertex
fn vsSun(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let px = u.place.xy + corners[vi] * (u.place.w * u.place.z);
  return vec4f(px.x / u.look.x * 2.0 - 1.0, 1.0 - px.y / u.look.y * 2.0, 0.0, 1.0);
}

// One channel's tile at a point of the tile (0..1 each way, y down as the
// video's own uv).
fn tileAt(uv: vec2f, col: f32, row: f32) -> vec3f {
  return textureSampleBaseClampToEdge(sunTex, sunSamp, (uv + vec2f(col, row)) / vec2f(3.0, 2.0)).rgb;
}

@fragment
fn fsSun(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let d = (p.xy - u.place.xy) / u.place.z;
  let uv = clamp(vec2f(0.5) + d * (0.5 / u.place.w), vec2f(0.0), vec2f(1.0));
  var c = vec3f(0.0);
  // The gains are uniforms, so these branches are uniform control flow;
  // only the lit channels are read.
  if (u.g0.x > 0.0) { c += tileAt(uv, 0.0, 0.0) * (vec3f(255.0, 154.0, 138.0) / 255.0) * u.g0.x; }
  if (u.g0.y > 0.0) { c += tileAt(uv, 1.0, 0.0) * (vec3f(255.0, 77.0, 46.0) / 255.0) * u.g0.y; }
  if (u.g0.z > 0.0) { c += tileAt(uv, 2.0, 0.0) * (vec3f(255.0, 194.0, 51.0) / 255.0) * u.g0.z; }
  if (u.g0.w > 0.0) { c += tileAt(uv, 0.0, 1.0) * (vec3f(201.0, 138.0, 75.0) / 255.0) * u.g0.w; }
  if (u.g1.x > 0.0) { c += tileAt(uv, 1.0, 1.0) * (vec3f(180.0, 140.0, 255.0) / 255.0) * u.g1.x; }
  c = min(c, vec3f(1.0));
  // The Color grade (see the top of this file); a uniform branch.
  if (u.grade.w > 0.5) {
    c = c * u.grade.x;
    c = (c - vec3f(0.5)) * u.grade.y + vec3f(0.5);
    let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    c = mix(vec3f(lum), c, u.grade.z);
    c = clamp(c, vec3f(0.0), vec3f(1.0));
  }
  // The feather (see the top of this file).
  let r = length(uv - vec2f(0.5)) * 2.0;
  let w = max(mix(0.6, 0.0, FEATHER_HARD), 0.003);
  var m = 1.0 - smoothstep(FEATHER_SIZE - w * 0.5, FEATHER_SIZE + w * 0.5, r);
  // The Center fade (see the top of this file); a uniform branch.
  if (u.look.z > 0.0) {
    m = m * smoothstep(u.look.z - u.g1.y, u.look.z + u.g1.y, r);
  }
  return vec4f(c * (m * u.look.w), 0.0);
}
`;
