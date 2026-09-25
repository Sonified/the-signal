// WGSL for the scene: field, rings and corners as one full-screen pass
// (reusing the maths in js/shaders.js's WGSL export almost unchanged), plus
// the edge layer's tail and head-cap passes, which are new for v1.
//
// The full-screen pass widens past the old struct U in one way: cornerCol
// and the ring lookup table both went from a single shared tint to their own
// colour, so S.perElementColor can give rings and corners their own hue the
// way js/renderers/canvas2d.js already does. Field stays a single global
// colour, same as canvas2d's drawField, which never branches on
// perElementColor either. The 'full' field mode also now checks the left
// inset (insetPx) before painting a pixel, matching canvas2d's plain
// fillRect(S.edgeInset, 0, visW(), H); the old WebGPU port never bounded it
// and painted straight across, which only looked right because v0's DOM
// drawer physically covered the gap.
//
// Everything downstream is one additive sum, clamped once at the very end
// rather than after every layer. That is equivalent to canvas2d's per-draw
// 'lighter' clamping here because every term being summed is already
// non-negative and already bounded near 1 on its own: once a channel's
// running total reaches 1, further additions keep it at or above 1 under
// either scheme, so the final clamp lands on the same number.

export const SCENE_WGSL = `
// Every fragment of an instance shares one kind, so the per-kind branch below
// never splits a 2x2 pixel quad and derivatives (fwidth, textureSample's
// implicit LOD) are well defined inside it. The compiler cannot prove that
// from a vertex input, so its uniformity check is turned off, deliberately.
diagnostic(off, derivative_uniformity);
struct U {
  res: vec4f,               // Wd, Hd, 1/Wd, 1/Hd (device px)
  col: vec4f,                // field colour rgb, field level
  fieldP: vec4f,              // mode (0 disc, 1 panel, 2 full), radius/half-extent, panel corner radius, fieldOn
  cornerA: vec4f,              // per-corner glow alpha, order matches canvas2d: TL(inset), TR, BR, BL(inset)
  cornerCol: array<vec4f, 4>,   // per-corner glow colour, same order
  misc: vec4f,                  // corner glow radius, ring outer radius, LUT_N, ringsOn
  misc2: vec4f,                  // cornersOn, left inset in device px, unused, unused
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> lut: array<f32>;   // rgb triples, one per radial sample

fn sdRoundBox(p: vec2f, b: f32, r: f32) -> f32 {
  let q = abs(p) - vec2f(b - r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

@fragment
fn fsFull(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let Wp = u.res.x; let Hp = u.res.y;
  let p = fc.xy;
  let insetPx = u.misc2.y;
  // Centred inside the area the drawer leaves visible, same as
  // js/geometry.js's visCx, so the field and the rings recentre when the
  // panel opens instead of drifting off behind it.
  let ctr = vec2f((insetPx + Wp) * 0.5, Hp * 0.5);
  var rgb = vec3f(0.0);

  if (u.fieldP.w > 0.5) {
    let mode = u.fieldP.x;
    var a = 1.0;
    if (mode < 0.5) {
      a = clamp((1.0 - length(p - ctr) / u.fieldP.y) / 0.28, 0.0, 1.0);
    } else if (mode < 1.5) {
      a = clamp(0.5 - sdRoundBox(p - ctr, u.fieldP.y, u.fieldP.z), 0.0, 1.0);
    } else {
      // full: a flat cut at the inset, not a falloff, matching canvas2d's fillRect.
      a = select(0.0, 1.0, p.x >= insetPx);
    }
    rgb = rgb + u.col.rgb * (u.col.w * a);
  }

  if (u.misc.w > 0.5) {
    let n = u.misc.z;
    let x = length(p - ctr) / u.misc.y * n - 0.5;
    if (x > -1.0 && x < n) {
      let i0 = u32(clamp(floor(x), 0.0, n - 2.0));
      let f = clamp(x - f32(i0), 0.0, 1.0);
      let a0 = vec3f(lut[i0 * 3u], lut[i0 * 3u + 1u], lut[i0 * 3u + 2u]);
      let a1 = vec3f(lut[(i0 + 1u) * 3u], lut[(i0 + 1u) * 3u + 1u], lut[(i0 + 1u) * 3u + 2u]);
      rgb = rgb + mix(a0, a1, f);
    }
  }

  if (u.misc2.x > 0.5) {
    let R = u.misc.x;
    let c0 = vec2f(insetPx, 0.0);
    let c1 = vec2f(Wp, 0.0);
    let c2 = vec2f(Wp, Hp);
    let c3 = vec2f(insetPx, Hp);
    rgb = rgb + u.cornerCol[0].rgb * (u.cornerA.x * max(0.0, 1.0 - length(p - c0) / R));
    rgb = rgb + u.cornerCol[1].rgb * (u.cornerA.y * max(0.0, 1.0 - length(p - c1) / R));
    rgb = rgb + u.cornerCol[2].rgb * (u.cornerA.z * max(0.0, 1.0 - length(p - c2) / R));
    rgb = rgb + u.cornerCol[3].rgb * (u.cornerA.w * max(0.0, 1.0 - length(p - c3) / R));
  }

  return vec4f(min(rgb, vec3f(1.0)), 1.0);
}

// ---- edge layer: tail ----
// One continuous tapered polygon per particle rather than a capsule per
// segment. The vertex buffer is a triangle list built on the CPU each frame
// (see scene-data.js's buildEdge); "across" runs -1..1 over the tail's local
// width so the fragment shader can soften the long edges with fwidth, which
// a raw triangle edge cannot do on its own without MSAA.

struct TOut {
  @builtin(position) pos: vec4f,
  @location(0) across: f32,
  @location(1) alpha: f32,
  @location(2) rgb: vec3f,
};

@vertex
fn vsTail(@location(0) xyAcrossAlpha: vec4f, @location(1) rgbPad: vec4f) -> TOut {
  let wp = xyAcrossAlpha.xy;
  var o: TOut;
  o.pos = vec4f(wp.x / u.res.x * 2.0 - 1.0, 1.0 - wp.y / u.res.y * 2.0, 0.0, 1.0);
  o.across = xyAcrossAlpha.z;
  o.alpha = xyAcrossAlpha.w;
  o.rgb = rgbPad.xyz;
  return o;
}

@fragment
fn fsTail(o: TOut) -> @location(0) vec4f {
  let aa = max(fwidth(o.across), 1e-4);
  let edge = 1.0 - smoothstep(1.0 - aa, 1.0, abs(o.across));
  return vec4f(o.rgb * o.alpha * edge, 0.0);
}

// ---- edge layer: head cap ----
// One instance per particle, a quad expanded past the circle's radius the
// same way v0's old edge line drew its antialiasing margin, with corners
// built from vertex_index rather than a dedicated quad buffer (same trick
// js/shaders.js's vsEdge already used). cutDir is the tail's own leading
// direction; fsCap discards the half of the circle behind it, which is the
// half the tail polygon already paints, so additive blending never doubles
// up into a bright seam where the two shapes meet.

struct COut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) radius: f32,
  @location(2) alpha: f32,
  @location(3) rgb: vec3f,
  @location(4) cutDir: vec2f,
};

@vertex
fn vsCap(@builtin(vertex_index) vi: u32,
         @location(0) cxyRadiusAlpha: vec4f,
         @location(1) rgbCutX: vec4f,
         @location(2) cutY: f32) -> COut {
  var ks = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let k = ks[vi];
  let sx = select(-1.0, 1.0, (k & 1u) == 1u);
  let sy = select(-1.0, 1.0, (k & 2u) == 2u);
  let center = cxyRadiusAlpha.xy;
  let radius = cxyRadiusAlpha.z;
  let pad = radius + 1.5;
  let local = vec2f(sx, sy) * pad;
  let wp = center + local;
  var o: COut;
  o.pos = vec4f(wp.x / u.res.x * 2.0 - 1.0, 1.0 - wp.y / u.res.y * 2.0, 0.0, 1.0);
  o.local = local;
  o.radius = radius;
  o.alpha = cxyRadiusAlpha.w;
  o.rgb = rgbCutX.xyz;
  o.cutDir = vec2f(rgbCutX.w, cutY);
  return o;
}

@fragment
fn fsCap(o: COut) -> @location(0) vec4f {
  if (dot(o.local, o.cutDir) > 0.0) {
    discard;
  }
  let dist = length(o.local);
  let a = clamp(o.radius + 0.5 - dist, 0.0, 1.0) * o.alpha;
  return vec4f(o.rgb * a, 0.0);
}
`;
