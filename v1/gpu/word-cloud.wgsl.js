// WGSL for the word cloud (word-cloud.js): the centre word condensing out of
// smoke and eroding back into it, as one material.
//
// There are no particles and no destinations. The smoke is a density field
// advected through a prescribed wind (semi-Lagrangian, midpoint backtrace),
// and the word is per-pixel ink from the glyph SDF atlas gated by a
// word mask. The field begins as a loose, word-shaped halo on arrival and
// as the exact word on departure. It is then advected, guided and settled
// as one continuous material. There is no second glyph reveal underneath
// the mist and no unrelated rectangle of ambient noise.
//
// The wind is shared by every sample: a gentle common drift, broad rolling
// eddies, weaker curls riding them. Density that shears under it stretches
// into filaments, which is what dots could never do. Nothing homes, nothing
// snaps, nothing is caged; arrival completes because the formation mask is
// deterministic in progress, not because anything was dragged into place.
//
// Four entry points: maskMain bakes the word's coverage and variation once
// per word; seedMain initializes a density texture from that mask; simMain
// is one fixed timestep of advection and settling; and the composite draws
// only that density, premultiplied over the scene.

const COMMON = /* wgsl */ `
struct U {
  m0: vec4f,   // region x, y, w, h (css px)
  m1: vec4f,   // 1/texW, 1/texH, dt s, sim time s
  m2: vec4f,   // progress at substep end, at substep start, dir (+1 leave, -1 arrive, 0 none), peak
  m3: vec4f,   // viewport css w, h, turbulence, distance D css px
  m4: vec4f,   // ink rgb, configured fade seconds for this phase
  m5: vec4f,   // ease, word size css px, letter count, seed
};

// three vec4s per letter, word-fx.js's wordLetters layout
struct Letters { v: array<vec4f, 96> };

const ATLAS = 2048.0;
const SDF_RANGE = 6.0;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn lhash(q: vec2i) -> f32 {
  let h = pcg((u32(q.x + 100000) * 1597334677u) ^ (u32(q.y + 100000) * 3812015801u));
  return f32(h) / 4294967296.0;
}
fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = lhash(i);
  let b = lhash(i + vec2i(1, 0));
  let c = lhash(i + vec2i(0, 1));
  let d = lhash(i + vec2i(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The scalar field the wind curls around. Its domain scrolls far slower
// than the flow it produces, so an eddy outlives the mist riding it.
fn psi(p: vec2f, t: f32) -> f32 {
  return vnoise(p + vec2f(t * 0.031, t * 0.023));
}
fn curl(p: vec2f, t: f32) -> vec2f {
  let e = 0.25;
  let dx = psi(p + vec2f(e, 0.0), t) - psi(p - vec2f(e, 0.0), t);
  let dy = psi(p + vec2f(0.0, e), t) - psi(p - vec2f(0.0, e), t);
  return vec2f(dy, -dx) / (2.0 * e);
}

// The air, css px/s: gentle drift with a touch of rise, broad eddies about
// the word's height, weaker curls riding them. Turbulence scales the eddies,
// never the transition clock, so a longer fade shows more of the same calm
// motion instead of faster motion.
fn wind(p: vec2f, t: f32, size: f32, turb: f32) -> vec2f {
  let gain = 0.4 + 1.6 * turb;
  var v = curl(p / (size * 2.6), t) * 20.0 * gain;
  v += curl(p / (size * 0.9) + vec2f(37.7, 11.3), t * 1.7) * 8.0 * gain;
  return v;
}

// The formation mask, 0 mist to 1 ink, per pixel. n is the word's baked
// dissolve noise, p the eased transition progress; stagger sets how patchy
// the dissolve is (0 the whole word together, 1 strongly uneven). It is
// deterministic in p: at p 1 every pixel is formed, so a quiet corner of
// noise can never leave a hole in the word.
fn formed(n: f32, p: f32, stagger: f32) -> f32 {
  let w = 0.3;
  let th = mix(0.5, n, 0.25 + 0.75 * stagger);
  return clamp((p * (1.0 + w) - th) / w, 0.0, 1.0);
}

// Progress eased the way the letter effects ease: arrivals settle, exits
// pick up speed. dir says which side of the word's life this is.
fn eased(prog: f32, ease: f32, dir: f32) -> f32 {
  let k = 1.0 + 2.0 * ease;
  if (dir < 0.0) { return 1.0 - pow(1.0 - prog, k); }
  return pow(prog, k);
}
`;

// The glyph decode used by the mask and the composite, the same one the
// UI's glyph shader uses:
//   local = (pos - centre) / halfSize                    (-1..1 in the quad)
//   uv    = mix(B.xy, B.zw, local * 0.5 + 0.5)
//   dist  = (sample - 0.5) * 2 * SDF_RANGE               (atlas texels)
//   css   = dist * (2 * halfW) / ((u1 - u0) * ATLAS)     (texels -> css px)

export const MASK_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var<uniform> LT: Letters;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var mask: texture_storage_2d<rgba8unorm, write>;

// Once per word: r = ink coverage (soft, at mask resolution), g and b two
// smooth multi-scale noises seeded by the word, one for forming and one for
// eroding, so a word never dissolves the way it condensed.
@compute @workgroup_size(8, 8)
fn maskMain(@builtin(global_invocation_id) gid: vec3u) {
  let texel = 1.0 / P.m1.xy;
  if (f32(gid.x) >= texel.x || f32(gid.y) >= texel.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) * P.m1.xy;
  let pos = P.m0.xy + uv * P.m0.zw;

  var cov = 0.0;
  let n = i32(P.m5.z);
  for (var j = 0; j < n; j++) {
    let A = LT.v[j * 3];
    let B = LT.v[j * 3 + 1];
    let local = (pos - A.xy) / max(A.zw, vec2f(0.001));
    if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) { continue; }
    let auv = mix(B.xy, B.zw, local * 0.5 + vec2f(0.5));
    let s = textureSampleLevel(atlas, samp, auv, 0.0).r;
    let distCss = (s - 0.5) * 2.0 * SDF_RANGE * (2.0 * A.z) / max((B.z - B.x) * ATLAS, 0.001);
    cov = max(cov, smoothstep(-1.2, 1.2, distCss));
  }

  let size = P.m5.y;
  let seed = P.m5.w;
  let q = pos / (size * 0.85) + vec2f(seed * 0.173, seed * 0.117);
  let g = 0.65 * vnoise(q) + 0.35 * vnoise(q * 2.7 + vec2f(11.3, 5.1));
  let q2 = pos / (size * 0.85) + vec2f(seed * 0.311 + 53.7, seed * 0.271 + 19.3);
  let b = 0.65 * vnoise(q2) + 0.35 * vnoise(q2 * 2.7 + vec2f(7.9, 2.3));
  textureStore(mask, vec2i(gid.xy), vec4f(cov, g, b, 0.0));
}
`;

export const SIM_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var prev: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var next: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var mask: texture_2d<f32>;

fn coverage(uv: vec2f) -> f32 {
  return textureSampleLevel(mask, samp, uv, 0.0).r;
}

// A compact blur of the glyph mask. This is deliberately local to the
// strokes: it gives the seed a soft plume without filling the simulation's
// rectangular region with unrelated fog.
fn wordPotential(uv: vec2f, r: vec2f) -> f32 {
  var h = coverage(uv) * 0.20;
  h += coverage(uv + vec2f( r.x, 0.0)) * 0.09;
  h += coverage(uv + vec2f(-r.x, 0.0)) * 0.09;
  h += coverage(uv + vec2f(0.0,  r.y)) * 0.09;
  h += coverage(uv + vec2f(0.0, -r.y)) * 0.09;
  let d = r * 0.72;
  h += coverage(uv + vec2f( d.x,  d.y)) * 0.065;
  h += coverage(uv + vec2f(-d.x,  d.y)) * 0.065;
  h += coverage(uv + vec2f( d.x, -d.y)) * 0.065;
  h += coverage(uv + vec2f(-d.x, -d.y)) * 0.065;
  h += coverage(uv + vec2f( r.x * 1.75, 0.0)) * 0.04;
  h += coverage(uv + vec2f(-r.x * 1.75, 0.0)) * 0.04;
  h += coverage(uv + vec2f(0.0,  r.y * 1.75)) * 0.04;
  h += coverage(uv + vec2f(0.0, -r.y * 1.75)) * 0.04;
  return h;
}

@compute @workgroup_size(8, 8)
fn seedMain(@builtin(global_invocation_id) gid: vec3u) {
  let texel = 1.0 / P.m1.xy;
  if (f32(gid.x) >= texel.x || f32(gid.y) >= texel.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) * P.m1.xy;
  let cov = coverage(uv);
  var d = cov;

  if (P.m2.z < 0.0) {
    // Born OUT THERE, at the Distance setting, not hugging the word: a
    // ring of soft clumps around the region (whose margins are built from
    // Distance, so the ring scales with the dial), roughed up by noise so
    // they read as torn vapour rather than dabs. Between them and the
    // word: empty air the journey will cross. Nothing is seeded on the
    // strokes; whatever the word condenses from must visibly travel in.
    let pos = P.m0.xy + uv * P.m0.zw;
    let size = P.m5.y;
    let si = i32(P.m5.w) + 13;
    d = 0.0;
    for (var i = 0; i < 14; i++) {
      let ang = lhash(vec2i(i, si)) * 6.2831853;
      let rr = 0.62 + 0.30 * lhash(vec2i(i + 40, si));
      let cuv = vec2f(0.5) + vec2f(cos(ang) * 0.5, sin(ang) * 0.5) * rr;
      let sg = size * (0.4 + 0.55 * lhash(vec2i(i + 80, si)));
      let oc = (uv - cuv) * P.m0.zw;
      d += 0.9 * exp(-dot(oc, oc) / (2.0 * sg * sg));
    }
    let tear = 0.55 + 0.45 * vnoise(pos / (size * 0.9) + vec2f(f32(si) * 0.31, f32(si) * 0.17));
    d = clamp(d * tear, 0.0, 1.1);
  }

  textureStore(next, vec2i(gid.xy), vec4f(d, 0.0, 0.0, 0.0));
}

// One fixed step: advect and reshape the same density. Arrival pulls its
// word-local halo toward the strokes and settles it into their coverage.
// Departure starts as those strokes and lets the same field shear away.
@compute @workgroup_size(8, 8)
fn simMain(@builtin(global_invocation_id) gid: vec3u) {
  let texel = 1.0 / P.m1.xy;
  if (f32(gid.x) >= texel.x || f32(gid.y) >= texel.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) * P.m1.xy;
  let pos = P.m0.xy + uv * P.m0.zw;
  let dt = P.m1.z;
  let t = P.m1.w;
  let size = P.m5.y;
  let turb = P.m3.z;

  let dir = P.m2.z;
  let p = select(0.0, eased(P.m2.x, P.m5.x, dir), dir != 0.0);

  // The gradient of a soft version of the word is a local direction field.
  // It guides arrival inward without assigning any particle a destination
  // or introducing a second visible layer. Departure is left to the air.
  let reach = vec2f(size * 0.30) / P.m0.zw;
  let gx = wordPotential(uv + vec2f(reach.x, 0.0), reach * 0.55) -
           wordPotential(uv - vec2f(reach.x, 0.0), reach * 0.55);
  let gy = wordPotential(uv + vec2f(0.0, reach.y), reach * 0.55) -
           wordPotential(uv - vec2f(0.0, reach.y), reach * 0.55);
  let grad = vec2f(gx, gy);
  let gl = length(grad);
  // The journey. Far from the word the guide points at its centre; near
  // the strokes it bends down the silhouette gradient into the letterforms
  // themselves. Its speed is Distance over the configured fade time, so
  // wisps born at the Distance ring arrive as the fade completes, whatever
  // both dials say; the air's curls ride on top of the trip, they never
  // replace it.
  var guide = vec2f(0.0);
  let fadeS = max(P.m4.w, 0.3);
  let centre = P.m0.xy + P.m0.zw * 0.5;
  if (dir < 0.0) {
    let toC = centre - pos;
    let near = clamp(wordPotential(uv, vec2f(size * 0.30) / P.m0.zw) * 9.0, 0.0, 1.0);
    var gdir = toC / max(length(toC), 1.0);
    if (gl > 0.0001) { gdir = normalize(mix(gdir, grad / gl, near)); }
    let spd = (P.m3.w * 1.25 / fadeS) * smoothstep(0.0, 0.2, p) * (1.0 - 0.55 * near);
    guide = gdir * spd;
  } else if (dir > 0.0) {
    let away = pos - centre;
    guide = away / max(length(away), 1.0) * (P.m3.w * 0.9 / fadeS) * smoothstep(0.05, 0.5, p);
  }

  // where was this texel's material one step ago
  let v1 = wind(pos, t, size, turb) + guide;
  let v2 = wind(pos - v1 * (dt * 0.5), t, size, turb);
  let fromUv = uv - ((v2 + guide) * dt) / P.m0.zw;
  var d = textureSampleLevel(prev, samp, fromUv, 0.0).r;

  // slow dissipation, absorption at the margins: a wisp that reaches the
  // region's edge thins into air, never meets a rectangle
  let bord = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  d *= exp(-0.14 * dt) * mix(0.90, 1.0, smoothstep(0.0, 0.10, bord));

  if (dir < 0.0) {
    let cov = coverage(uv);
    // Sticky, not conjured: material that has actually arrived on ink
    // thickens onto it, and a bare stroke STAYS bare until real mass gets
    // there — the difference between condensation and an in-place fade.
    d = min(d + d * cov * 7.0 * dt * smoothstep(0.15, 0.7, p), 1.3);
    // off the strokes, gathering air thins as the journey completes
    d *= exp(-(1.0 - cov) * smoothstep(0.6, 1.0, p) * 1.4 * dt);
    // the deadline: the last stretch relaxes the field to exact coverage,
    // by which time the journey is already home
    let dl = smoothstep(0.86, 1.0, p);
    d = mix(d, cov, 1.0 - exp(-dl * 9.0 * dt));
  } else if (dir > 0.0) {
    // The field was seeded from exact coverage at the phase boundary. Let
    // it stretch, rise and thin; nothing else is drawn beneath it.
    d *= exp(-mix(0.04, 0.52, p) * dt);
  }

  d = min(d, 1.6);
  textureStore(next, vec2i(gid.xy), vec4f(d, 0.0, 0.0, 0.0));
}
`;

export const COMP_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var<uniform> LT: Letters;
@group(0) @binding(2) var dens: texture_2d<f32>;
@group(0) @binding(3) var mask: texture_2d<f32>;
@group(0) @binding(4) var atlas: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec2f,
};

const QUAD = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0)
);

@vertex
fn vsCloud(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let unit = QUAD[vi];
  let css = P.m0.xy + unit * P.m0.zw;
  let ndc = css / P.m3.xy * 2.0 - vec2f(1.0, 1.0);
  o.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  o.uv = unit;
  o.world = css;
  return o;
}

// One draw of one material. The last part of arrival resolves the simulated
// density to exact baked coverage so its handoff to the normal held word is
// crisp. This is a boundary condition on the same field, not another glyph
// layer or an independently timed reveal.
@fragment
fn fsCloud(in: VOut) -> @location(0) vec4f {
  let d = textureSample(dens, samp, in.uv).r;
  let dir = P.m2.z;
  var material = d;
  if (dir < 0.0) {
    let p = eased(P.m2.x, P.m5.x, dir);
    let resolve = smoothstep(0.88, 1.0, p);
    material = mix(d, textureSample(mask, samp, in.uv).r, resolve);
  }
  let a = (1.0 - exp(-3.2 * material)) * P.m2.w;
  return vec4f(P.m4.rgb * a, a);
}
`;
