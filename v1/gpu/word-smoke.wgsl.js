// WGSL for the word smoke (word-smoke.js): recorded dissolutions.
//
// The word is rasterised into a density field from its real glyph SDFs at
// its real place on screen, and dissolved offscreen: advected through a
// seeded wind, diffused a little, and thinned by DILUTION — the expanding
// flow reduces the density it carries (continuity), which is how smoke
// actually disappears: things spread out until they are gone. Snapshots go
// into a texture-array recording; arrival plays a recording backward from
// empty air to the exact word, departure plays one forward, and playback
// warps neighbouring snapshots along the same analytic wind before
// blending, so motion is continuous at any frame rate.
//
// Every recording has its own flow seed: octave offsets and drift
// directions all derive from it, so no two words ever dissolve through the
// same air and a departure never retraces an arrival.
//
// The wind is baked: once per step, windMain evaluates the five noise
// octaves on a coarse grid (a third of the field's resolution; the wind is
// smooth at that scale) and the step samples it, rather than every texel
// rebuilding the whole field twice per step.
//
// The density field carries its own texture coordinates in g and b: where
// the material started, in word heights from the word's centre. They ride
// the same advection as the density, so the playback's grain is attached to
// the vapour and stretches with it, instead of a fixed grid it slides through.
//
// The left-to-right sweep is applied at PLAYBACK, never baked: each column
// of the word runs the same recording on its own delayed clock, so the
// wave crosses in wall-clock fade time under live settings, and the same
// delay pattern makes arrivals assemble left to right when reversed.

const COMMON = /* wgsl */ `
struct U {
  m0: vec4f,   // region x, y, w, h (css px)
  m1: vec4f,   // 1/texW, 1/texH, prep: dt s, sim time s. playback: snapshot spacing s, word size
  m2: vec4f,   // prep: word size, recording length s, diffusion 1/s, decay scale.
               // playback: slot base layer, SNAPS-1, raw progress, peak
  m3: vec4f,   // viewport css w, h, prep: turbulence, flow seed. playback: unused, firm ramp
  m4: vec4f,   // playback: colour rgb, wind speed px/s. prep: wind speed in x, letter count in w
  m5: vec4f,   // playback: turbulence, flow seed, sweep share (0 off), 0.
               // live sim: sweep share, 1 (the live flag), 0, tail position 0..1
  m6: vec4f,   // word ink x0, x1 (css px), direction (+1 leave, -1 arrive), ease exponent
  m7: vec4f,   // Outward (radial vs swirl balance 0..1), Acceleration (wind-up 0..1), the ink's centre x, y (css px), where Outward pushes from
  m8: vec4f,   // radial equality 0..1 (whole-word drift removed as it rises); lines running
               // separately: their count (1 = together) and spacing (css px); 0
};

// three vec4s per letter, word-fx.js's wordLetters layout
struct Letters { v: array<vec4f, 216> };

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

// sd is the octave's own drift direction, from the recording's seed, so no
// fixed scroll ever stamps one lean on every word.
fn psi(p: vec2f, t: f32, sd: vec2f) -> f32 {
  return vnoise(p + sd * t);
}
fn curl(p: vec2f, t: f32, sd: vec2f) -> vec2f {
  let e = 0.25;
  let dx = psi(p + vec2f(e, 0.0), t, sd) - psi(p - vec2f(e, 0.0), t, sd);
  let dy = psi(p + vec2f(0.0, e), t, sd) - psi(p - vec2f(0.0, e), t, sd);
  return vec2f(dy, -dx) / (2.0 * e);
}

// Weighted so the WORKHORSE eddies sit at letter scale, not word scale: a
// word-sized vortex grabs the whole word and winds it into one spiral arm,
// while letter-sized swirls catch different parts of the word and carry
// them apart into several plumes. Each octave's pattern drifts fast enough
// that no single vortex holds material long enough to wind it all up.
fn windShape(p: vec2f, t: f32, size: f32, turb: f32, seed: f32) -> vec2f {
  let gain = 0.5 + 1.3 * turb;
  let a1 = seed * 2.39996; let a2 = seed * 4.7711 + 1.7; let a3 = seed * 7.213 + 3.9;
  let a4 = seed * 9.517 + 0.6; let a5 = seed * 11.31 + 2.2;
  let o = vec2f(seed * 13.7, seed * 7.9);
  var v = curl(p / (size * 4.5) + vec2f(9.1, 71.7) + o, t * 0.7, vec2f(cos(a1), sin(a1)) * 0.10) * 0.45 * gain;
  v += curl(p / (size * 2.2) + o * 1.7, t, vec2f(cos(a2), sin(a2)) * 0.09) * 0.55 * gain;
  v += curl(p / (size * 1.1) + vec2f(23.9, 51.3) + o * 0.6, t * 1.1, vec2f(cos(a5), sin(a5)) * 0.10) * 0.75 * gain;
  v += curl(p / (size * 0.6) + vec2f(41.3, 17.7) + o, t * 1.6, vec2f(cos(a3), sin(a3)) * 0.12) * 0.8 * gain;
  v += curl(p / (size * 0.3) + vec2f(5.9, 88.1) + o, t * 2.3, vec2f(cos(a4), sin(a4)) * 0.16) * 0.35 * gain;
  return v;
}
`;

export const PREP_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var prev: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var next: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var atlas: texture_2d<f32>;
@group(0) @binding(5) var<uniform> LT: Letters;
@group(0) @binding(6) var windTex: texture_2d<f32>;

// The word as density: soft coverage from the glyph SDFs, a touch over one
// texel of anti-aliasing so thin strokes and letter counters survive the
// advection instead of aliasing away.
@compute @workgroup_size(8, 8)
fn rasterMain(@builtin(global_invocation_id) gid: vec3u) {
  let texel = 1.0 / P.m1.xy;
  if (f32(gid.x) >= texel.x || f32(gid.y) >= texel.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) * P.m1.xy;
  let pos = P.m0.xy + uv * P.m0.zw;
  let texelCss = P.m0.z * P.m1.x;

  var cov = 0.0;
  let n = i32(P.m4.w);
  for (var j = 0; j < n; j++) {
    let A = LT.v[j * 3];
    let B = LT.v[j * 3 + 1];
    let local = (pos - A.xy) / max(A.zw, vec2f(0.001));
    if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) { continue; }
    let auv = mix(B.xy, B.zw, local * 0.5 + vec2f(0.5));
    let s = textureSampleLevel(atlas, samp, auv, 0.0).r;
    let distCss = (s - 0.5) * 2.0 * SDF_RANGE * (2.0 * A.z) / max((B.z - B.x) * ATLAS, 0.001);
    cov = max(cov, smoothstep(-0.7 * texelCss, 0.7 * texelCss, distCss));
  }
  // g, b: this spot's own coordinates, carried with the material from here
  let o = (pos - P.m7.zw) / max(P.m2.x, 1.0);
  textureStore(next, vec2i(gid.xy), vec4f(cov, o.x, o.y, 0.0));
}

// One fixed step of the dissolution: midpoint-backtraced advection through
// the seeded wind plus a gentle radial dispersal, light diffusion, and
// dilution.
@compute @workgroup_size(8, 8)
fn simMain(@builtin(global_invocation_id) gid: vec3u) {
  let texel = 1.0 / P.m1.xy;
  if (f32(gid.x) >= texel.x || f32(gid.y) >= texel.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) * P.m1.xy;
  let pos = P.m0.xy + uv * P.m0.zw;
  let dt = P.m1.z;
  let t = P.m1.w;
  let size = P.m2.x;
  let turb = P.m3.z;
  let spd = P.m4.x;
  let fs = P.m3.w;    // the recording's flow seed

  // A gentle radial expansion rides with the swirls: the vapour spreads
  // outward from the word as it dissolves, several plumes diffusing away.
  // Played backward this same term is a gentle inflow — condensation.
  // Outward means out from the WORD, not from the field: the field is the
  // whole viewport now, and the word sits wherever the drawer inset put it,
  // so the radial centre is the middle of the word's ink, passed in, never
  // the region's (and never the baseline anchor, which sits under the letters).
  let ctr = P.m7.zw;
  let radial = pos - ctr;
  let tnE = clamp(t / max(P.m2.y, 0.001), 0.0, 1.0);

  // The LIVE departure's sweep: a soft front crosses the word's ink in
  // wall-clock time (the live sim's clock IS wall clock) and the physics
  // only ignites behind it; each column then lives its own dissolution on
  // a local clock from when the front passed. Recordings always pass 0
  // here — the arrival's sweep is a playback remap instead.
  let sw = P.m5.x;
  var act = 1.0;
  var tnL = tnE;
  if (sw > 0.0) {
    let soft = size * 0.9;
    // Lines running one after another (m8.y > 1): this cell belongs to one
    // wrapped line, and that line owns a compressed window of the fade —
    // the first line dissolves, then the next. Its front and local clock
    // run inside that window; ahead of it the letters stand untouched.
    var tL = t;
    var TT = P.m2.y;
    let nL = P.m8.y;
    if (nL > 1.5) {
      let kL = clamp(round((pos.y - P.m7.w) / max(P.m8.z, 1.0) + (nL - 1.0) * 0.5), 0.0, nL - 1.0);
      TT = P.m2.y / nL;
      tL = t - kL * TT;
    }
    // f is deliberately unclamped: the front keeps travelling past the ink
    // at the same pace instead of parking at the last letter — a parked
    // front is an invisible wall that only the rightward smoke ever meets.
    // And shortly after the crossing the gate releases everywhere, so
    // vapour outrunning the front is never held against it either.
    let f = tL / max(sw * TT, 0.001);
    let frontX = mix(P.m6.x - soft, P.m6.y + soft, f);
    act = 1.0 - smoothstep(frontX, frontX + soft, pos.x);
    act = max(act, smoothstep(1.0, 1.6, f));
    let fx = clamp((pos.x - P.m6.x) / max(P.m6.y - P.m6.x, 1.0), 0.0, 1.0);
    let tf = fx * sw * TT;
    tnL = clamp((tL - tf) / max(TT - tf, 0.1), 0.0, 1.0);
  }

  // Outward (m7.x) balances the radial bloom against the curls: high and
  // the letters exhale from the word's centre with swirl as texture, low
  // and the eddies own it. Acceleration (m7.y) is the wind-up: an envelope
  // that holds the big motion back at first — the word destabilises,
  // quivering under a fraction of the swirl, edges fraying — then lets the
  // momentum build. It runs on the column's local clock, so a sweeping
  // front gives every letter its own wind-up. Reversed playback turns all
  // of it into breathing inward and settling.
  let radB = 0.15 + 0.75 * P.m7.x;
  let windMul = 0.9 - 0.6 * P.m7.x;
  let ramp = mix(0.65, 0.02, P.m7.y);
  let env = smoothstep(0.0, max(ramp, 0.001), tnL);
  let vOut = radial / max(length(radial), size) * spd * (radB + 0.5 * tnL) * env;
  // the baked wind (windMain), at this texel and again at the midpoint
  let wScale = spd * windMul * (0.35 + 0.65 * env);
  let v1 = (textureSampleLevel(windTex, samp, uv, 0.0).xy * wScale + vOut) * act;
  let uvMid = uv - (v1 * (dt * 0.5)) / P.m0.zw;
  let v2 = (textureSampleLevel(windTex, samp, uvMid, 0.0).xy * wScale + vOut) * act;
  let fromUv = uv - (v2 * dt) / P.m0.zw;
  let src = textureSampleLevel(prev, samp, fromUv, 0.0);
  var d = src.r;

  // diffusion: a light pull toward the neighbourhood mean, the difference
  // between filaments that soften as they stretch and edges that crumble
  let e = P.m1.xy;
  let avg = 0.25 * (textureSampleLevel(prev, samp, fromUv + vec2f(e.x, 0.0), 0.0).r
                  + textureSampleLevel(prev, samp, fromUv - vec2f(e.x, 0.0), 0.0).r
                  + textureSampleLevel(prev, samp, fromUv + vec2f(0.0, e.y), 0.0).r
                  + textureSampleLevel(prev, samp, fromUv - vec2f(0.0, e.y), 0.0).r);
  d = mix(d, avg, (1.0 - exp(-P.m2.z * dt)) * act);

  // Dilution, not clocks. The expanding flow thins what it carries
  // (continuity: dRho/dt = -Rho * div v), and that thinning IS how smoke
  // disappears: things spread out until they are gone. On top of it, only
  // slow mixing with clean air (Linger sets how clean) and slightly faster
  // mixing-away of already-thin strands. The single clock left is a
  // backstop pinned to the recording's final frames so the last snapshot
  // is truly empty air; almost nothing survives to meet it. Margins
  // absorb, so a wisp never meets an edge.
  // A recording must end as empty air (its last snapshot is played as the
  // arrival's first frame), so it keeps a backstop in its final frames.
  // The LIVE departure never hard-fades: it outlives the word on a tail,
  // and only the slow mixing rises gently across that tail, so the vapour
  // flows out until dilution takes it under visibility.
  // A third of the true continuity dilution: full 1/r thinning takes the
  // vapour under visibility at one consistent radius, which reads as an
  // invisible wall. Smoke carries visibly farther this way, and mixing
  // (Linger) still ends it.
  let divg = 0.35 * spd * (radB + 0.5 * tnL) * env / max(length(radial), size);
  let faint = 1.0 - clamp(d * 4.0, 0.0, 1.0);
  let tail = P.m5.w;
  let mixing = (0.3 + 0.25 * faint) * P.m2.w * (1.0 + 3.0 * tail * tail);
  let decay = (mixing + divg) * act + (1.0 - P.m5.y) * 10.0 * smoothstep(0.92, 1.0, tnE);
  // No kill zone. The field is sized (or IS the viewport, for the live
  // departure) so dilution finishes the smoke long before any edge; the
  // only absorption left is a guard in the outermost few percent, for the
  // clamped sampler at the boundary itself.
  let er = length((uv - vec2f(0.5)) * 2.0);
  let edgeMix = 15.0 * smoothstep(0.985, 1.0, er);
  d *= exp(-(decay + edgeMix) * dt);

  textureStore(next, vec2i(gid.xy), vec4f(d, src.g, src.b, 0.0));
}
`;

// The wind for one step, on its own coarse grid over the same region: the
// raw octaves only. Everything that varies per texel on top of it (the
// radial bloom, the wind-up envelope, the sweep gate) is cheap arithmetic
// the step still does itself.
export const WIND_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var windOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn windMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(windOut);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let pos = P.m0.xy + uv * P.m0.zw;
  var w = windShape(pos, P.m1.w, P.m2.x, P.m3.z, P.m3.w);
  // Radial equality: whole-word drift is the half of the wind that is the
  // SAME at a point and at its mirror through the word's centre; flow that
  // blooms outward is the half that flips sign there. Blending toward the
  // flipping half removes "the whole word goes up" without touching the
  // swirls' texture — at 1 every push away from centre has its equal on
  // the far side, at 0 the wind is what it always was.
  let eq = P.m8.x;
  if (eq > 0.0) {
    let wm = windShape(2.0 * P.m7.zw - pos, P.m1.w, P.m2.x, P.m3.z, P.m3.w);
    w = mix(w, (w - wm) * 0.5, eq);
  }
  textureStore(windOut, vec2i(gid.xy), vec4f(w, 0.0, 0.0));
}
`;

export const PLAY_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var rec: texture_2d_array<f32>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> LT: Letters;

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
fn vsSmoke(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let unit = QUAD[vi];
  let css = P.m0.xy + unit * P.m0.zw;
  let ndc = css / P.m3.xy * 2.0 - vec2f(1.0, 1.0);
  o.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  o.uv = unit;
  o.world = css;
  return o;
}

@fragment
fn fsSmoke(in: VOut) -> @location(0) vec4f {
  let sz = max(P.m1.w, 8.0);
  let snapS = P.m1.z;
  let nMax = max(P.m2.y, 1.0);       // SNAPS - 1
  let dir = P.m6.z;                  // +1 departure, -1 arrival

  // The sweep, at playback: this column's own clock, delayed by its place
  // across the word's ink, so the LEFT letters are touched first and the
  // wave crosses in wall-clock fade time under the live settings. Reversed
  // playback assembles left to right for free. sws is the share of the
  // fade the front spends crossing; each column then plays its whole
  // dissolution in the time that remains after its delay.
  var pl = P.m2.z;
  // Lines running one after another: this pixel's line owns a compressed
  // share of the fade — the block arrives (and leaves) top line first. The
  // column sweep and the firmness below then read the line's own clock.
  let nLp = P.m8.y;
  if (nLp > 1.5) {
    let kL = clamp(round((in.world.y - P.m7.w) / max(P.m8.z, 1.0) + (nLp - 1.0) * 0.5), 0.0, nLp - 1.0);
    pl = clamp(pl * nLp - kL, 0.0, 1.0);
  }
  let sws = P.m5.z;
  if (sws > 0.0) {
    let fx = clamp((in.world.x - P.m6.x) / max(P.m6.y - P.m6.x, 1.0), 0.0, 1.0);
    pl = clamp((pl - fx * sws) / max(1.0 - sws, 0.05), 0.0, 1.0);
  }

  // this column's place in the recording, eased the way the effects ease
  let k = max(P.m6.w, 1.0);
  var pe: f32;
  if (dir < 0.0) { pe = 1.0 - pow(1.0 - pl, k); } else { pe = pow(pl, k); }
  let tau = select(pe, 1.0 - pe, dir < 0.0);
  let lf = clamp(tau, 0.0, 1.0) * nMax;
  let la = floor(lf);
  let frac = lf - la;
  let lb = min(la + 1.0, nMax);
  let tn = lf / nMax;

  // Motion-compensated blend: the same wind the recording was made in,
  // radial dispersal included, warps both neighbouring snapshots along the
  // flow before mixing, so playback moves continuously at any frame rate
  // instead of crossfading stills.
  // The live departure has no snapshots (spacing 0) and needs no warp, so
  // it skips the wind entirely.
  var duv = vec2f(0.0);
  if (snapS > 0.0) {
    let ctr = P.m7.zw;
    let radial = in.world - ctr;
    let radB = 0.15 + 0.75 * P.m7.x;
    let windMul = 0.9 - 0.6 * P.m7.x;
    let envW = smoothstep(0.0, max(mix(0.65, 0.02, P.m7.y), 0.001), tn);
    let vOut = radial / max(length(radial), sz) * P.m4.w * (radB + 0.5 * tn) * envW;
    var wr = windShape(in.world, lf * snapS, sz, P.m5.x, P.m5.y);
    // the same radial-equality blend the recording was simulated under
    if (P.m8.x > 0.0) {
      let wm = windShape(2.0 * ctr - in.world, lf * snapS, sz, P.m5.x, P.m5.y);
      wr = mix(wr, (wr - wm) * 0.5, P.m8.x);
    }
    let w = wr * P.m4.w * windMul * (0.35 + 0.65 * envW) + vOut;
    duv = (w * snapS) / P.m0.zw;
  }
  let sa = textureSampleLevel(rec, samp, in.uv - duv * frac, i32(P.m2.x + la), 0.0);
  let sb = textureSampleLevel(rec, samp, in.uv + duv * (1.0 - frac), i32(P.m2.x + lb), 0.0);
  let d = mix(sa.r, sb.r, frac);
  let matUv = mix(sa.gb, sb.gb, frac);   // where this bit of vapour started

  // Firm where the word is standing: globally at the fade's crisp end
  // (m3.w, from the CPU), and per column while its own clock has not
  // started — or, arriving, once it has finished — so letters waiting for
  // the front are letters, not soft ghosts.
  var firm = P.m3.w;
  if (sws > 0.0) {
    if (dir > 0.0) { firm = max(firm, 1.0 - smoothstep(0.0, 0.04, pl)); }
    else { firm = max(firm, smoothstep(0.96, 1.0, pl)); }
  }

  // Smoky grain: fine noise on the material's own coordinates, so it moves
  // and stretches with the vapour, shreds the faint body into texture while
  // dense cores hold together, and dies out entirely as the word firms.
  let g = vnoise(matUv / 0.42);
  let shred = (1.0 - firm) * 0.55 * (1.0 - g) * (1.0 - clamp(d * 1.4 - 0.1, 0.0, 1.0));
  let dd = d * (1.0 - shred);
  let d2 = mix(dd, smoothstep(0.35, 0.65, dd), firm);
  let a = (1.0 - exp(-mix(3.2, 6.0, firm) * d2)) * P.m2.w;
  return vec4f(P.m4.rgb * a, a);
}
`;
