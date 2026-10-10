// WGSL for the Sun layer (gpu/sun.js): the sun as a disc at the field
// centre, drawn from one frame of the NASA SDO mosaic video, imported zero
// copy as a texture_external each frame.
//
// The mosaic is a 3 x 2 grid of tiles, one SDO channel each: row 0 holds
// 1700, 0304 and 0171, row 1 holds 0193 and 0211 (the sixth tile is black).
// The picture is meditatewiththesun.com's composite exactly: every channel's
// tile read at the same point, multiplied by its tint and its gain, and
// summed, so the channels add as light. The gains come from the CPU (the
// Atmosphere sweep, at most two channels lit at once, summing to 1), so the
// sum never passes the brightest tint; it is clamped all the same.
//
// The disc: a pixel's offset from the centre, in device px, over the disc's
// radius R, times the photosphere's radius in tile half widths (0.775), is
// the point in the tile, so the sun's limb lands on the disc's edge. The
// alpha falls from 1 to 0 over the last few px inside the limb, and the
// output is premultiplied: the disc covers what is under it.
//
// One shader serves three targets (the scene, the fold's chamber, the
// feedback image), each with its own uniform slot (a dynamic offset):
// place.xy is the centre in the target's own texels and place.z the target's
// texels per device px, so the vertex stage lays a quad round the disc in
// those texels and the fragment stage turns its own position back into
// device px about the centre.

export const SUN_WGSL = `
struct SU {
  place: vec4f, // centre x, y (target texels), target texels per device px, disc radius (device px)
  look: vec4f,  // target width, height (texels), soft edge (device px), gain
  g0: vec4f,    // channel gains: 1700, 0304, 0171, 0193
  g1: vec4f,    // channel gain 0211, photosphere radius in tile half widths, unused, unused
};
@group(0) @binding(0) var<uniform> u: SU;
@group(0) @binding(1) var sunTex: texture_external;
@group(0) @binding(2) var sunSamp: sampler;

@vertex
fn vsSun(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  // The disc's reach in the target's texels, plus one for the raster.
  let ext = u.place.w * u.place.z + 1.0;
  let px = u.place.xy + corners[vi] * ext;
  return vec4f(px.x / u.look.x * 2.0 - 1.0, 1.0 - px.y / u.look.y * 2.0, 0.0, 1.0);
}

// One channel's tile at a point of the tile (0..1 each way, y down as the
// video's own uv).
fn tileAt(local: vec2f, col: f32, row: f32) -> vec3f {
  return textureSampleBaseClampToEdge(sunTex, sunSamp, (local + vec2f(col, row)) / vec2f(3.0, 2.0)).rgb;
}

@fragment
fn fsSun(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let d = (p.xy - u.place.xy) / u.place.z;
  let r = length(d);
  let a = clamp((u.place.w - r) / u.look.z, 0.0, 1.0);
  let local = vec2f(0.5) + d * (0.5 * u.g1.y / u.place.w);
  var c = vec3f(0.0);
  // The gains are uniforms, so these branches are uniform control flow;
  // only the lit channels are read.
  if (u.g0.x > 0.0) { c += tileAt(local, 0.0, 0.0) * (vec3f(255.0, 154.0, 138.0) / 255.0) * u.g0.x; }
  if (u.g0.y > 0.0) { c += tileAt(local, 1.0, 0.0) * (vec3f(255.0, 77.0, 46.0) / 255.0) * u.g0.y; }
  if (u.g0.z > 0.0) { c += tileAt(local, 2.0, 0.0) * (vec3f(255.0, 194.0, 51.0) / 255.0) * u.g0.z; }
  if (u.g0.w > 0.0) { c += tileAt(local, 0.0, 1.0) * (vec3f(201.0, 138.0, 75.0) / 255.0) * u.g0.w; }
  if (u.g1.x > 0.0) { c += tileAt(local, 1.0, 1.0) * (vec3f(180.0, 140.0, 255.0) / 255.0) * u.g1.x; }
  c = min(c, vec3f(1.0));
  return vec4f(c * a, a) * u.look.w;
}
`;
