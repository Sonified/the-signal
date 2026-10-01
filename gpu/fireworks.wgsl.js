// WGSL for the Fireworks layer: one instanced draw, no simulation pass.
//
// Every piece of a show moves on a closed form of its own age. A spark
// thrown with velocity v0 against drag k and a constant pull G is at
//   p(t) = p0 + v0 f + G (t - f) / k,   f = (1 - e^(-k t)) / k
// so the vertex shader places it straight from the show's age, and places
// its tail by asking the same question a moment earlier. The streaks are the
// spark's real path, not a stored history, and the motion is the same at
// any frame rate.
//
// Positions are in space: xy in field units (0 at the centre of the visible
// field, 1 at half its shorter side, at depth 1) and z the depth, seen in
// perspective as xy / z, the tunnel's own sense of depth. A flat show lives
// at depth 1 with gravity pulling down the screen, which draws exactly as a
// flat 2D show would. A deep show's gravity pulls toward the viewer, so its
// sparks come at you: spreading out from the centre and growing as they
// near, and let go before they reach the viewer.
//
// Each show also carries a 2x2 matrix applied to its xy on screen. A show
// is worked out in its own frame, and four copies of one show with four
// mirror or quarter-turn matrices are four identical shows placed
// symmetrically about the centre.
//
// A show's instances, in order: the shell's head, the embers it sheds along
// its flight, the burst's sparks, and one soft flash at the moment of the
// burst.
export const SHELL_N = 48;
export const SPARK_N = 720;
export const PER_SHOW = 1 + SHELL_N + SPARK_N + 1;
export const MAX_SHOWS = 16;
export const SHOW_FLOATS = 24;
// The view block (two vec4f) and the shows (six vec4f each).
export const UNIFORM_FLOATS = 8 + MAX_SHOWS * SHOW_FLOATS;
// How long a burst's longest-lived spark lasts, per recipe, before the
// show's life multiplier (lifeBase times at most 1.2 in the shader). The CPU
// retires a show from these.
export const LIFE_BASE = [1.9, 1.9, 1.9, 3.3, 1.9, 1.9];

export const FIREWORKS_WGSL = /* wgsl */ `
struct Show {
  a: vec4f,   // age (s), launch time D (s), recipe, seed
  b: vec4f,   // burst point xy on screen (field units, the show's own frame), path bend, size
  c: vec4f,   // colour rgb, burst depth
  d: vec4f,   // pattern angle, ring squash, star rays, deep (0 flat, 1 deep)
  e: vec4f,   // screen matrix: x' = e.x x + e.y y, y' = e.z x + e.w y
  f: vec4f,   // gravity, life multiplier, shell's starting depth, drag multiplier
};
struct U {
  view: vec4f,   // centre xy (device px), one field unit (device px), dpr
  tgt: vec4f,    // 1 / pixel width, 1 / pixel height, gain, show count
  shows: array<Show, ${MAX_SHOWS}>,
};
@group(0) @binding(0) var<uniform> u: U;

const SHELL_N = ${SHELL_N}u;
const SPARK_N = ${SPARK_N}u;
const PER = ${PER_SHOW}u;
const TAU = 6.2831853;
// A deep spark is let go this close to the viewer, fading out from NEAR_FADE.
const NEAR = 0.18;
const NEAR_FADE = 0.45;

fn pcg(n: u32) -> u32 {
  let s = n * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seed: u32, j: u32, k: u32) -> f32 {
  return f32(pcg(seed ^ pcg(j * 16u + k))) * (1.0 / 4294967296.0);
}

// A spark thrown from p0 at v0 under a constant pull g, t seconds later.
fn fall(p0: vec3f, v0: vec3f, k: f32, g: vec3f, t: f32) -> vec3f {
  let f = (1.0 - exp(-k * t)) / k;
  return p0 + v0 * f + g * ((t - f) / k);
}

// Gravity as the show feels it: down the screen when flat, toward the viewer
// when deep.
fn pull(sh: Show, g: f32) -> vec3f {
  if (sh.d.w > 0.5) { return vec3f(0.0, 0.0, -g); }
  return vec3f(0.0, g, 0.0);
}

// The shell's flight: out from the centre to the burst point, slowing as it
// climbs, bowed a little to one side. A deep shell flies the same line in
// space, in from far down the tunnel to its burst depth, so on screen it
// rises out of the vanishing point and swells as it comes.
fn shellPos(sh: Show, tau: f32) -> vec3f {
  let q = clamp(tau / sh.a.y, 0.0, 1.0);
  let s = 1.0 - (1.0 - q) * (1.0 - q);
  let b = sh.b.xy;
  let xy = b * s + vec2f(-b.y, b.x) * (sh.b.z * sin(3.14159265 * s));
  if (sh.d.w < 0.5) { return vec3f(xy, 1.0); }
  let zb = sh.c.w;
  return vec3f(xy * zb, mix(sh.f.z, zb, s));
}

// A direction on the unit sphere. Flat, only its xy is used: a burst that is
// round in space reads as a disc with a bright rim, as a real one does.
fn sphere(h1: f32, h2: f32) -> vec3f {
  let z = 2.0 * h1 - 1.0;
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = TAU * h2;
  return vec3f(cos(phi) * r, sin(phi) * r, z);
}

// Each recipe is only a different first velocity: peony (0), ring (1),
// star (2), willow (3, slower, heavier, longer lived), double (4, a shell
// inside a shell) and sunflower (5, a phyllotaxis disc). The ring, star and
// sunflower lie in a plane facing the viewer.
fn sparkVel(sh: Show, recipe: u32, j: u32, seed: u32) -> vec3f {
  let speed = 0.7 * sh.b.w;
  let h1 = rnd(seed, j, 0u);
  let h2 = rnd(seed, j, 1u);
  let h3 = rnd(seed, j, 2u);
  let n = f32(SPARK_N);
  var v = vec3f(0.0, 0.0, 0.0);
  switch recipe {
    case 1u: {
      let ang = TAU * (f32(j) + h1 * 0.3) / n;
      let c = vec2f(cos(ang), sin(ang) * sh.d.y);
      let ca = cos(sh.d.x);
      let sa = sin(sh.d.x);
      v = vec3f(vec2f(c.x * ca - c.y * sa, c.x * sa + c.y * ca) * speed * (0.96 + 0.04 * h2), 0.0);
    }
    case 2u: {
      let rays = sh.d.z;
      let ray = floor(h1 * rays);
      let ang = sh.d.x + TAU * ray / rays + (h2 - 0.5) * 0.06;
      v = vec3f(vec2f(cos(ang), sin(ang)) * speed * (0.2 + 0.85 * h3), 0.0);
    }
    case 4u: {
      let inner = (j & 1u) == 1u;
      v = sphere(h1, h2) * speed * select(1.0, 0.5, inner) * (0.94 + 0.06 * h3);
    }
    case 5u: {
      let ang = f32(j) * 2.3999632 + sh.d.x;
      v = vec3f(vec2f(cos(ang), sin(ang)) * speed * sqrt((f32(j) + 0.5) / n), 0.0);
    }
    case 3u: {
      v = sphere(h1, h2) * speed * 0.8 * (0.85 + 0.15 * h3);
    }
    default: {
      v = sphere(h1, h2) * speed * (0.92 + 0.08 * h3);
    }
  }
  // Flat, a burst has no depth to move in.
  v.z = v.z * sh.d.w;
  // The shell's outward push carries into the burst, so every show keeps
  // travelling on toward its corner as it opens.
  let bl = length(sh.b.xy);
  if (bl > 0.0001) { v = v + vec3f(sh.b.xy / bl * (0.12 * sh.b.w), 0.0); }
  return v;
}

// A point in space to the show's place on screen, in field units.
fn toScreen(sh: Show, p: vec3f) -> vec2f {
  let s = p.xy / p.z;
  return vec2f(sh.e.x * s.x + sh.e.y * s.y, sh.e.z * s.x + sh.e.w * s.y);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) loc: vec2f,     // px along the segment from its tail, px across
  @location(1) seg: vec2f,     // segment length, reach (px)
  @location(2) color: vec3f,
  @location(3) alpha: f32,
  @location(4) soft: f32,      // 1 for the burst flash
};

@vertex
fn vsFire(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);   // nothing to show collapses off screen
  o.loc = vec2f(0.0, 0.0);
  o.seg = vec2f(0.0, 1.0);
  o.color = vec3f(0.0, 0.0, 0.0);
  o.alpha = 0.0;
  o.soft = 0.0;

  let si = ii / PER;
  let j = ii % PER;
  if (f32(si) >= u.tgt.w) { return o; }
  let sh = u.shows[si];
  let age = sh.a.x;
  let dur = sh.a.y;
  let recipe = u32(sh.a.z + 0.5);
  let seed = u32(sh.a.w);
  let unit = u.view.z;
  let dpr = u.view.w;
  let zb = sh.c.w;
  let burst = vec3f(sh.b.xy * zb, zb);

  var head = vec3f(0.0, 0.0, 1.0);
  var tail = vec3f(0.0, 0.0, 1.0);
  var alpha = 0.0;
  var widthCss = 1.0;
  var soft = 0.0;
  var col = sh.c.rgb;
  let willow = recipe == 3u;
  if (willow) { col = mix(col, vec3f(1.0, 0.72, 0.32), 0.65); }

  if (j == 0u) {
    // the shell itself, brightening as it leaves the centre
    if (age >= dur) { return o; }
    let q = age / dur;
    head = shellPos(sh, age);
    tail = shellPos(sh, max(age - 0.07, 0.0));
    alpha = smoothstep(0.0, 0.3, q) * 0.9;
    widthCss = mix(0.6, 1.4, q);
    col = mix(col, vec3f(1.0, 0.9, 0.75), 0.6);
  } else if (j <= SHELL_N) {
    // embers shed evenly along the flight, each falling away on its own
    let e = j - 1u;
    let born = dur * (f32(e) + 0.5) / f32(SHELL_N);
    let ea = age - born;
    let life = 0.35 + 0.35 * rnd(seed, j, 3u);
    if (ea < 0.0 || ea >= life) { return o; }
    let p0 = shellPos(sh, born);
    let v0 = vec3f((vec2f(rnd(seed, j, 4u), rnd(seed, j, 5u)) - 0.5) * 0.12, 0.0);
    let g = select(vec3f(0.0, 0.12, 0.0), vec3f(0.0, 0.0, -0.3), sh.d.w > 0.5);
    head = fall(p0, v0, 3.0, g, ea);
    tail = fall(p0, v0, 3.0, g, max(ea - 0.05, 0.0));
    let fade = 1.0 - ea / life;
    alpha = fade * fade * 0.6 * smoothstep(0.0, 0.35, born / dur);
    widthCss = 0.7;
    col = mix(col, vec3f(1.0, 0.8, 0.5), 0.5);
  } else if (j < PER - 1u) {
    // a burst spark
    let k = j - SHELL_N - 1u;
    let tb = age - dur;
    if (tb < 0.0) { return o; }
    let lifeBase = select(1.9, 3.3, willow) * sh.f.y;
    let life = lifeBase * (0.7 + 0.5 * rnd(seed, k, 6u));
    if (tb >= life) { return o; }
    let drag = select(1.6, 1.05, willow) * sh.f.w;
    let g = pull(sh, sh.f.x * select(1.0, 2.4, willow));
    let trail = select(0.16, 0.5, willow);
    let v0 = sparkVel(sh, recipe, k, seed);
    head = fall(burst, v0, drag, g, tb);
    tail = fall(burst, v0, drag, g, max(tb - trail, 0.0));
    let lf = tb / life;
    // late in life the sparks crackle: each flickers on its own, a new
    // draw about thirty times a second
    let flick = rnd(seed, k, 7u + u32(tb * 28.0));
    let crackle = mix(1.0, 0.2 + 1.3 * flick, smoothstep(0.4, 0.75, lf));
    // Every spark starts on the same pixel, so they come up over the first
    // few frames as they part; the flash carries the moment itself.
    alpha = (1.0 - smoothstep(0.6, 1.0, lf)) * crackle * (0.6 + 0.4 * exp(-tb * 2.0)) * smoothstep(0.0, 0.05, tb);
    widthCss = 1.2 * (1.0 - 0.45 * lf);
    if (recipe == 4u && (k & 1u) == 1u) { col = mix(col, vec3f(1.0, 1.0, 1.0), 0.55); }
    // white hot at the burst, cooling into the colour
    col = mix(col, vec3f(1.0, 1.0, 1.0), 0.75 * exp(-tb * 5.0));
  } else {
    // the flash
    let tb = age - dur;
    if (tb < 0.0 || tb >= 0.45) { return o; }
    head = burst;
    tail = burst;
    alpha = 0.55 * exp(-tb * 10.0);
    soft = 1.0;
    col = mix(col, vec3f(1.0, 1.0, 1.0), 0.6);
  }

  // Near the viewer a deep piece fades, then is let go; a flat one sits at
  // depth 1 and is untouched. Nearer reads larger, as in the tunnel.
  if (head.z <= NEAR) { return o; }
  alpha = alpha * smoothstep(NEAR, NEAR_FADE, head.z);
  tail.z = max(tail.z, NEAR);
  let depthScale = min(1.0 / head.z, 6.0);

  let c = u.view.xy;
  let hp = c + toScreen(sh, head) * unit;
  let tp = c + toScreen(sh, tail) * unit;
  var reach = max(widthCss * depthScale * dpr * 3.0, 1.5);
  if (soft > 0.5) { reach = 0.22 * unit * sh.b.w * depthScale; }
  let dv = hp - tp;
  let len = length(dv);
  var ax = vec2f(1.0, 0.0);
  if (len > 0.001) { ax = dv / len; }
  let px = vec2f(-ax.y, ax.x);

  var ks = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let kk = ks[vi % 6u];
  let lx = mix(-reach, len + reach, kk.x);
  let ly = mix(-reach, reach, kk.y);
  let p = tp + ax * lx + px * ly;
  o.pos = vec4f(p.x * u.tgt.x * 2.0 - 1.0, 1.0 - p.y * u.tgt.y * 2.0, 0.0, 1.0);
  o.loc = vec2f(lx, ly);
  o.seg = vec2f(len, reach);
  o.color = col;
  o.alpha = alpha * u.tgt.z;
  o.soft = soft;
  return o;
}

@fragment
fn fsFire(o: VOut) -> @location(0) vec4f {
  let len = o.seg.x;
  let reach = o.seg.y;
  let cx = clamp(o.loc.x, 0.0, len);
  let d = length(vec2f(o.loc.x - cx, o.loc.y)) / reach;
  let edge = 1.0 - smoothstep(0.85, 1.0, d);
  var a = 0.0;
  if (o.soft > 0.5) {
    a = exp(-d * d * 4.0) * edge;
  } else {
    // bright at the head, thinning to a faint thread at the tail
    var along = 1.0;
    if (len > 0.001) { along = cx / len; }
    let core = exp(-d * d * 28.0);
    let halo = exp(-d * d * 5.0) * 0.22;
    a = (core + halo) * (0.08 + 0.92 * along * along) * edge;
  }
  // Light only: alpha stays 0, so additive blending lays it over the scene.
  return vec4f(o.color * (a * o.alpha), 0.0);
}
`;
