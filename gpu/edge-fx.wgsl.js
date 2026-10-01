// WGSL for the Edge layer's three light effects beside Surfing (the tapered
// tails in scene.wgsl.js): Particles, Flame and Glow. See gpu/edge-fx.js for
// the CPU half. All three are light only, drawn with additive blending and
// alpha 0, so they add into the scene or into the edge's feedback image the
// same way the tails do, and two of them drawn at once during a crossfade
// sum to a true crossfade.
//
// Everything lives on the visible rectangle, x from the drawer's inset to
// the screen's right, y from 0 to the bottom, in device pixels.
//
// Particles are stateless, as the fireworks are. A fixed pool of slots each
// runs a birth every SPARK period, staggered evenly across the pool, and a
// slot's generation (how many periods it has been through) and its index
// hash into everything that spark is: whether it is born at all (a share of
// births set by Rate, so the rate changes which births happen, never when),
// where on the perimeter, how long it lives, how fast it drifts. So a spark
// is a closed form of its age, and nothing is simulated.
//
// Flame and Glow are four border bands, one per side, each a trapezoid
// mitred at the corners, so the four meet on the diagonals and no pixel is
// covered twice. A fragment knows its band, so its distance in from that
// border, and its place along the perimeter of the rectangle inset by that
// distance, which runs on unbroken round every corner (the two bands agree
// on the diagonal between them). Flame lays periodic value noise over that
// place and distance, scrolling inward so the licks rise off the frame; Glow
// is a plain falloff with distance.

// Slots in the particle pool, and the most births a second it can give: a
// slot comes round every SPARK_SLOTS / SPARK_RATE_MAX seconds, which has to
// be longer than the longest life (SPARK_LIFE times SPARK_LIFE_SPREAD_MAX,
// in edge-fx.js) so a slot is never asked for two sparks at once.
export const SPARK_SLOTS = 1024;
export const SPARK_RATE_MAX = 512;
// The uniform block, in floats (see struct U).
export const FX_UNIFORM_FLOATS = 80;
// Flame's noise repeats this many cells in depth, so its scroll can wrap
// without a seam (edge-fx.js keeps its offset inside one repeat).
export const FLAME_PERIOD_D = 256;

export const EDGE_FX_WGSL = /* wgsl */ `
struct U {
  view: vec4f,             // left inset x0, right x1, bottom y1 (device px), dpr
  res: vec4f,              // 1 / pixel width, 1 / pixel height, per-element colour (0 or 1), flame band px
  col: vec4f,              // the edge's colour rgb, unused
  pal: array<vec4f, 8>,    // per-element colours round the perimeter (rgb)
  lvA: vec4f,              // the strobe's shimmer at eight phase offsets, 0..3
  lvB: vec4f,              // and 4..7
  part: vec4f,             // cycle fraction, cycle count (mod 65536), spark radius px, drift -1..1
  part2: vec4f,            // sparkle 0..1, gain, share of births (rate / max), jitter px
  part3: vec4f,            // drift px/s at 1, slot period s, base life s, birth band px
  flame: vec4f,            // Height px (the envelope only), turbulence 0..1, gain, cells round the perimeter
  flame2: vec4f,           // along offset (cells), rise offset, warp offset, depth px per cell
  glow: vec4f,             // falloff exponent, Width px, gain, softness 0..1
};
@group(0) @binding(0) var<uniform> u: U;

const SLOTS = ${SPARK_SLOTS}u;
const PERIOD_D = ${FLAME_PERIOD_D};
const TAU = 6.2831853;
// A spark's shape: a bright core and a faint halo, the quad reaching
// SPARK_REACH radii out so the halo is never cut.
const SPARK_REACH = 3.0;
const SPARK_CORE = 1.6;
const SPARK_HALO = 0.35;
const SPARK_HALO_GAIN = 0.18;
// How quickly a spark's drift eases off, per second, and how much faster or
// slower one spark drifts than another, either way.
const DRIFT_EASE = 0.9;
const DRIFT_SPREAD = 0.4;
// The tangential jitter's rate, cycles a second, before each spark's own
// spread of it.
const JITTER_HZ = 1.3;
// The share of a spark's life it takes to come up, and how white hot it is
// at birth, cooling at SPARK_COOL a second.
const SPARK_RISE = 0.08;
const SPARK_HOT = 0.55;
const SPARK_COOL = 6.0;
// The sparkle: a fresh draw of brightness this many times a second, at full
// Sparkle anywhere between SPARKLE_LO and SPARKLE_LO + SPARKLE_SPAN.
const SPARKLE_HZ = 24.0;
const SPARKLE_LO = 0.15;
const SPARKLE_SPAN = 1.5;
// Rate thins births by a hash threshold; within this share of the threshold
// a spark is faded rather than cut, so moving Rate never pops one away.
const RATE_SOFT = 0.03;
// Flame: how hard the noise is pushed apart before it meets the height
// (more contrast, taller and more broken licks), the softness of a lick's
// edge, how far Turbulence warps the noise sideways (cells), and the
// octave gain at Turbulence 0 and 1.
const FLAME_CONTRAST = 1.9;
const FLAME_EDGE = 0.14;
const FLAME_WARP = 1.4;
const FLAME_GAIN_LO = 0.35;
const FLAME_GAIN_HI = 0.7;
// The glow of the fire's base along the border, and how white its hottest
// part runs.
const FLAME_BASE = 0.22;
const FLAME_HOT = 0.4;

fn pcg(n: u32) -> u32 {
  let s = (n * 747796405u) + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32, k: u32) -> f32 {
  return f32(pcg(seed ^ pcg(k))) * (1.0 / 4294967296.0);
}

// The strobe's shimmer at offset k of eight.
fn level(k: u32) -> f32 {
  let j = k & 7u;
  if (j < 4u) { return u.lvA[j]; }
  return u.lvB[j - 4u];
}

// The colour at a place round the perimeter, 0..1 from the top left
// clockwise: the edge's own, or under per-element colour the eight hues
// blended round it, closing on itself at the top left.
fn palAt(sn: f32) -> vec3f {
  if (u.res.z < 0.5) { return u.col.rgb; }
  let f = fract(sn) * 8.0;
  let i = u32(floor(f)) & 7u;
  let j = (i + 1u) & 7u;
  return mix(u.pal[i].rgb, u.pal[j].rgb, smoothstep(0.0, 1.0, fract(f)));
}

fn toClip(p: vec2f) -> vec4f {
  return vec4f((p.x * u.res.x * 2.0) - 1.0, 1.0 - (p.y * u.res.y * 2.0), 0.0, 1.0);
}

// ---- Particles ----

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,   // px from the spark's centre
  @location(1) radius: f32,
  @location(2) color: vec3f,
  @location(3) alpha: f32,
};

@vertex
fn vsPart(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  var o: POut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);   // nothing to show collapses off screen
  o.local = vec2f(0.0, 0.0);
  o.radius = 1.0;
  o.color = vec3f(0.0, 0.0, 0.0);
  o.alpha = 0.0;

  // Where this slot is in its own period, and which generation of spark
  // that is: slot i runs i / SLOTS of a period behind the pool's clock.
  var x = u.part.x - f32(ii) / f32(SLOTS);
  var gen = i32(u.part.y);
  if (x < 0.0) { x = x + 1.0; gen = gen - 1; }
  let period = u.part3.y;
  let age = x * period;
  let seed = pcg((u32(gen) * SLOTS) + ii);

  // Rate: only this share of births happen, the rest faded out near it.
  let e = rnd(seed, 0u);
  let share = u.part2.z;
  if (e >= share) { return o; }
  let born = clamp((share - e) / RATE_SOFT, 0.0, 1.0);
  let life = u.part3.z * (0.6 + 0.8 * rnd(seed, 1u));
  if (age >= life) { return o; }
  let q = age / life;

  // Born anywhere round the perimeter, evenly by length.
  let x0 = u.view.x;
  let x1 = u.view.y;
  let y1 = u.view.z;
  let w = x1 - x0;
  let per = 2.0 * (w + y1);
  var s = rnd(seed, 2u) * per;
  var at = vec2f(x0 + s, 0.0);
  var inward = vec2f(0.0, 1.0);
  if (s >= w) {
    s = s - w;
    if (s < y1) { at = vec2f(x1, s); inward = vec2f(-1.0, 0.0); }
    else {
      s = s - y1;
      if (s < w) { at = vec2f(x1 - s, y1); inward = vec2f(0.0, -1.0); }
      else { at = vec2f(x0, y1 - (s - w)); inward = vec2f(1.0, 0.0); }
    }
  }
  let along = vec2f(inward.y, -inward.x);

  // A little way in from the border at birth, then drifting out (Drift
  // above 0) or in (below), easing off as it goes, with a small wobble along
  // the border.
  let depth0 = rnd(seed, 3u) * u.part3.w;
  let v = u.part.w * u.part3.x * (1.0 + DRIFT_SPREAD * (2.0 * rnd(seed, 4u) - 1.0));
  let travel = v * (1.0 - exp(-DRIFT_EASE * age)) / DRIFT_EASE;
  let wob = sin(TAU * (JITTER_HZ * (0.7 + 0.6 * rnd(seed, 5u)) * age + rnd(seed, 6u)));
  let c = at + inward * (depth0 - travel) + along * (u.part2.w * rnd(seed, 7u) * wob);

  // Up quickly, then fading over the rest of its life; twinkling with
  // Sparkle; shimmering with the strobe at its own offset.
  let env = smoothstep(0.0, SPARK_RISE, q) * (1.0 - q) * (1.0 - q);
  let flick = rnd(seed, 8u + u32(age * SPARKLE_HZ));
  let sparkle = mix(1.0, SPARKLE_LO + SPARKLE_SPAN * flick, u.part2.x);
  let a = env * sparkle * born * level(seed >> 3u) * u.part2.y;
  if (a < 0.002) { return o; }

  var col = u.col.rgb;
  if (u.res.z > 0.5) { col = u.pal[(seed >> 7u) & 7u].rgb; }
  col = mix(col, vec3f(1.0, 1.0, 1.0), SPARK_HOT * exp(-age * SPARK_COOL));

  let r = max(u.part.z * (0.7 + 0.6 * rnd(seed, 9u)) * (1.0 - 0.4 * q), 0.5);
  let reach = r * SPARK_REACH + 1.0;
  var ks = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let local = ks[vi % 6u] * reach;
  o.pos = toClip(c + local);
  o.local = local;
  o.radius = r;
  o.color = col;
  o.alpha = a;
  return o;
}

@fragment
fn fsPart(o: POut) -> @location(0) vec4f {
  let d = length(o.local) / o.radius;
  let edge = 1.0 - smoothstep(SPARK_REACH * 0.8, SPARK_REACH, d);
  let a = (exp(-d * d * SPARK_CORE) + SPARK_HALO_GAIN * exp(-d * d * SPARK_HALO)) * edge;
  // Light only: alpha stays 0.
  return vec4f(o.color * (a * o.alpha), 0.0);
}

// ---- the border bands, Flame and Glow ----

// px is the fragment's place in device px, carried rather than read from
// pos: pos is in the target's own pixels, which for the edge's feedback
// image at a Trail res under 1 (feedback.js ensure) are fewer than the
// screen's, while bandPlace, the flame's noise cells and the glow's width
// all go by device px. Interpolated across the band it is exact (the band
// is flat, w is 1), and at full size it is pos.xy itself.
struct BOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) band: u32,
  @location(1) px: vec2f,
};

// The rectangle's corner k (0 top left, clockwise), pulled r in along its
// diagonal.
fn corner(k: u32, r: f32) -> vec2f {
  let x0 = u.view.x;
  let x1 = u.view.y;
  let y1 = u.view.z;
  switch (k & 3u) {
    case 0u: { return vec2f(x0 + r, r); }
    case 1u: { return vec2f(x1 - r, r); }
    case 2u: { return vec2f(x1 - r, y1 - r); }
    default: { return vec2f(x0 + r, y1 - r); }
  }
}

// Four trapezoids, six vertices each: band b runs from outer corner b to
// outer corner b + 1 along its border and in to the same two corners pulled
// r in, so neighbours share the diagonal between them.
fn bandVert(vi: u32, r: f32) -> BOut {
  let b = vi / 6u;
  var ks = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  let k = ks[vi % 6u];
  var p = vec2f(0.0, 0.0);
  if (k == 0u) { p = corner(b, 0.0); }
  else if (k == 1u) { p = corner(b + 1u, 0.0); }
  else if (k == 2u) { p = corner(b + 1u, r); }
  else { p = corner(b, r); }
  var o: BOut;
  o.pos = toClip(p);
  o.band = b;
  o.px = p;
  return o;
}

// A pixel's distance in from its band's border, and its place round the
// perimeter of the rectangle inset by that distance, 0..1 clockwise from
// that rectangle's top left.
fn bandPlace(p: vec2f, b: u32) -> vec2f {
  let x0 = u.view.x;
  let x1 = u.view.y;
  let y1 = u.view.z;
  let w = x1 - x0;
  var d = 0.0;
  var s = 0.0;
  switch b {
    case 0u: { d = p.y; s = p.x - x0 - d; }
    case 1u: { d = x1 - p.x; s = (w - 2.0 * d) + (p.y - d); }
    case 2u: { d = y1 - p.y; s = (w - 2.0 * d) + (y1 - 2.0 * d) + (x1 - d - p.x); }
    default: { d = p.x - x0; s = 2.0 * (w - 2.0 * d) + (y1 - 2.0 * d) + (y1 - d - p.y); }
  }
  let per = max(2.0 * (w + y1) - 8.0 * d, 1.0);
  return vec2f(max(d, 0.0), s / per);
}

@vertex
fn vsFlame(@builtin(vertex_index) vi: u32) -> BOut {
  return bandVert(vi, u.res.w);
}

@vertex
fn vsGlow(@builtin(vertex_index) vi: u32) -> BOut {
  return bandVert(vi, u.glow.y + 1.0);
}

// Value noise that repeats every px cells across and py cells down, so the
// flame closes on itself round the perimeter and its scroll can wrap.
fn wrapI(i: i32, n: i32) -> i32 {
  return ((i % n) + n) % n;
}
fn cellHash(ix: i32, iy: i32) -> f32 {
  return f32(pcg((u32(ix) * 1597334677u) ^ pcg(u32(iy)))) * (1.0 / 4294967296.0);
}
fn vnoise(p: vec2f, px: i32, py: i32) -> f32 {
  let fl = floor(p);
  let f = p - fl;
  let ix = i32(fl.x);
  let iy = i32(fl.y);
  let x0 = wrapI(ix, px);
  let x1 = wrapI(ix + 1, px);
  let y0 = wrapI(iy, py);
  let y1 = wrapI(iy + 1, py);
  let sm = f * f * (3.0 - 2.0 * f);
  let a = mix(cellHash(x0, y0), cellHash(x1, y0), sm.x);
  let b = mix(cellHash(x0, y1), cellHash(x1, y1), sm.x);
  return mix(a, b, sm.y);
}
// Four octaves, each twice as fine as the last, its repeat doubling with it.
fn fbm(p: vec2f, px: i32, py: i32, gain: f32) -> f32 {
  var sum = 0.0;
  var norm = 0.0;
  var amp = 1.0;
  var q = p;
  var nx = px;
  var ny = py;
  for (var o = 0; o < 4; o = o + 1) {
    sum = sum + amp * vnoise(q, nx, ny);
    norm = norm + amp;
    amp = amp * gain;
    q = q * 2.0;
    nx = nx * 2;
    ny = ny * 2;
  }
  return sum / norm;
}

@fragment
fn fsFlame(o: BOut) -> @location(0) vec4f {
  let pl = bandPlace(o.px, o.band);
  let reach = u.flame.x;
  let h = pl.x / reach;
  if (h >= 1.0) { return vec4f(0.0, 0.0, 0.0, 0.0); }
  let turb = u.flame.y;
  let cells = u.flame.w;
  let nx = i32(cells + 0.5);
  // The noise is sampled in the screen's own pixels, rooted at the border:
  // cells of a fixed size (edge-fx.js), never scaled by Height, which is
  // only the envelope h above, so a taller flame is the same flames reaching
  // further in. Across: the place round the perimeter in cells, drifting
  // slowly along. Down: the depth in cells, less the rise, so the pattern
  // moves inward.
  let depth = pl.x / u.flame2.w;
  let across = pl.y * cells + u.flame2.x;
  let warp = vnoise(vec2f(pl.y * cells, depth - u.flame2.z), nx, PERIOD_D) - 0.5;
  let p = vec2f(across + FLAME_WARP * turb * warp, depth - u.flame2.y);
  let n = fbm(p, nx, PERIOD_D, mix(FLAME_GAIN_LO, FLAME_GAIN_HI, turb));
  let lick = (n - 0.5) * FLAME_CONTRAST + 0.5;
  let body = smoothstep(h - FLAME_EDGE, h + FLAME_EDGE, lick) * (1.0 - h);
  let base = FLAME_BASE * pow(1.0 - h, 6.0);
  let c = body + base;
  var col = palAt(pl.y);
  col = mix(col, vec3f(1.0, 0.95, 0.85), FLAME_HOT * body * (1.0 - h) * (1.0 - h));
  return vec4f(col * (c * u.flame.z), 0.0);
}

@fragment
fn fsGlow(o: BOut) -> @location(0) vec4f {
  let pl = bandPlace(o.px, o.band);
  // Light bleeding in from beyond the border: full on the screen's very
  // edge and falling away inward to nothing by Width, (1 - t)^k over the
  // share t of Width. The depth is taken from the outer side of the pixel,
  // so the outermost row is at full strength and the light is seen to come
  // from the edge itself. The exponent is Softness's (edge-fx.js): high for a
  // crisp bright rim that drops fast, near 1 for a long even decay, and
  // above 1 either way so the light settles onto 0 at Width with no line.
  let t = clamp(max(pl.x - 0.5, 0.0) / u.glow.y, 0.0, 1.0);
  let a = pow(1.0 - t, u.glow.x);
  return vec4f(palAt(pl.y) * (a * u.glow.z), 0.0);
}
`;
