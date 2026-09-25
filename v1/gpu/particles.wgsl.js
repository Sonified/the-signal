// WGSL for the particle generator (see particles.js).
//
// Two modules share one particle record and one idea of what a particle
// looks like on screen. The simulation is a compute pass over a storage
// buffer: every invocation owns one slot, births overwrite the slots a
// ring-buffer cursor hands out this frame, and everything else that is alive
// advances. Straight after it advances, the same invocation asks footprint()
// whether any of the particle would reach the target at all (bright enough
// to move an 8-bit pixel, and with its quad overlapping the target), and only
// then appends its slot to a compact list with an atomic counter. That
// counter is the instance count of an indirect draw, so the render module
// never meets a dead, faded or off-screen particle: it reads the list,
// projects each particle through the tunnel's perspective (the ring layer's
// r = FOCAL / z) with the very same footprint(), and shades it in one of the
// styles.
//
// A particle lives in tunnel space: x and y in units where the tunnel wall
// sits at radius 1, z from Z_FAR (the vanishing point) toward Z_NEAR (the
// viewer). So a particle at |xy| = 1 reaches the rim of the screen just as it
// passes the viewer, exactly as the rings do.
//
// A particle is emitted at the far plane but not born there. Most of the way
// in from the vanishing point it sits so near the centre of the screen that
// the radial fade keeps it dark, so each birth is placed straight at the
// point on its own path where it first shows (birthParticle) and lives only
// the part of its flight anyone can see.
//
// Growth points. An emitter is one branch of emitParticle, selected by the
// emitter id in the sim block: a new one (a 3D grid, a sphere shell, a shape
// sampled from an image) is a new branch here plus a name in particles.js's
// EMITTER_IDS and a line in its emitterReach, nothing else. A style is one
// branch in footprint (its peak brightness and the uv rectangle where it is
// still visible), one in fsPart (how it looks), plus a name in STYLE_IDS.
// The rectangle has to be worked out from the style's own curve, so that
// nothing it leaves out could have shown.

import { RADIAL_FADE_WGSL } from '../core/fade.js';

const PARTICLE_STRUCT = /* wgsl */ `
struct P {
  pos: vec4f,   // x, y, z in tunnel space; w is 1 while alive
  vel: vec4f,   // velocity per second; w unused
  info: vec4f,  // age (s), size (tunnel units), twinkle seed, hue parameter
};
`;

// The render block and everything that turns a particle into a quad on the
// target. Both modules carry it; each declares its own binding of r.
const VIEW_WGSL = /* wgsl */ RADIAL_FADE_WGSL + `
struct R {
  view: vec4f,  // origin x, y in the target (px or texels), target units per device px, FOCAL (device px)
  tgt: vec4f,   // 1 / target width, 1 / target height, largest size in device px, style id
  col: vec4f,   // strobe colour rgb (0..1), colour mode
  misc: vec4f,  // brightness (opacity x pulse), hue variation, time, trail
  z: vec4f,     // Z_FAR, Z_NEAR, live size multiplier, live speed
  fade: vec4f,  // radial fade in amount (0..1), 1 / the rings' rim (device px), unused, unused
};

// One step of an 8-bit target. Light below it cannot change a pixel.
const VIS: f32 = 0.0039215686;

// Hue rotation about the grey axis (Rodrigues), so 'strobe' colour can vary
// per particle without leaving the strobe's family.
fn hueRotate(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735027, 0.57735027, 0.57735027);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
fn hsv(h: f32) -> vec3f {
  let k = vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let p = abs(fract(vec3f(h, h, h) + k) * 6.0 - 3.0);
  return clamp(p - 1.0, vec3f(0.0, 0.0, 0.0), vec3f(1.0, 1.0, 1.0));
}
fn particleColour(hp: f32) -> vec3f {
  let mode = u32(r.col.w + 0.5);
  if (mode == 1u) { return mix(vec3f(1.0, 1.0, 1.0), hsv(hp + r.misc.z * 0.03), 0.85); }
  if (mode == 2u) { return vec3f(1.0, 1.0, 1.0); }
  return max(hueRotate(r.col.rgb, (hp - 0.5) * r.misc.y * 6.2831853), vec3f(0.0, 0.0, 0.0));
}

// A particle's quad on the target. A point of the style's own uv space lands
// at base + u * uv.x + v * uv.y (target px), and only the uv rectangle
// [lo, hi] is drawn: the part of the style's shape that can still show at
// this particle's brightness. alpha 0 means none of it can.
struct Quad {
  base: vec2f,
  u: vec2f,
  v: vec2f,
  lo: vec2f,
  hi: vec2f,
  arm: f32,     // spark only: half width in uv of the cross its rays need
  alpha: f32,
  color: vec3f,
};

fn footprint(p: P) -> Quad {
  var q: Quad;   // zeroed, so alpha 0 until it earns more
  let z = p.pos.z;
  let zNear = r.z.y;
  if (p.pos.w < 0.5 || z <= zNear) { return q; }

  let focal = r.view.w;
  let head = p.pos.xy * (focal / z);                 // device px from the field centre
  // Fade in from the centre on the rings' own curve, by how far out the
  // particle sits on screen: kr is 0 at the vanishing point and 1 at the
  // rings' rim. head is measured from the field centre in device px in both
  // paths; in the chamber that centre is the fold's own, so the folded
  // pattern fades from its middle too.
  let kr = length(head) * r.fade.y;
  // fade out as it passes the viewer, whatever its radius (0 from Z_NEAR in,
  // which is where the simulation lets it go)
  let fout = smoothstep(zNear, zNear * 2.5, z);
  // and by age as well, so a newborn never switches on at part brightness
  let born = min(p.info.x / 0.4, 1.0);
  let alpha = radialFade(r.fade.x, kr) * fout * born * r.misc.x;
  if (alpha <= 0.0) { return q; }
  let color = particleColour(p.info.w);
  // the most any fragment of it can add to one channel, per unit of shape
  let l = alpha * max(max(color.r, color.g), color.b);

  let sizePx = min(p.info.y * r.z.z * focal / z, r.tgt.z);
  let style = u32(r.tgt.w + 0.5);
  var base = head;
  var u = vec2f(0.0, 0.0);
  var v = vec2f(0.0, 0.0);
  var lo = vec2f(0.0, 0.0);
  var hi = vec2f(0.0, 0.0);
  var arm = 0.0;

  // Each branch first drops a particle whose brightest point (the style's
  // peak times l) is under one step, then bounds the rest. Where a shape is
  // a sum of terms, each term gets a share of the step, so their sum stays
  // under it everywhere outside the rectangle.
  if (style == 1u) {
    // streak: a quad from where it was a moment ago to where it is, so its
    // length is its speed across the screen. Shape exp(-5 y^2) * along^2,
    // peak 1: the tail is trimmed where along^2 * l falls under a step, the
    // sides where exp(-5 y^2) * l does.
    if (l < VIS) { return q; }
    let tail3 = p.pos.xyz - p.vel.xyz * (r.z.w * (0.05 + r.misc.w * 0.45));
    let tz = max(tail3.z, zNear * 0.6);
    let tail = tail3.xy * (focal / tz);
    let d = head - tail;
    let len = length(d);
    var dir = vec2f(0.0, 1.0);
    if (len > 0.001) { dir = d / len; }
    base = (head + tail) * 0.5;
    u = dir * (len * 0.5 + sizePx);
    v = vec2f(-dir.y, dir.x) * sizePx;
    let x0 = clamp(2.0 * sqrt(VIS / l) - 1.0, -1.0, 1.0);
    let ey = sqrt(clamp(log(l / VIS) / 5.0, 0.0, 1.0));
    lo = vec2f(x0, -ey);
    hi = vec2f(1.0, ey);
  } else {
    // room each round style needs about its core, in core sizes
    var k = 1.0;
    var e = 1.0;
    if (style == 2u) {
      // spark: 0.9 * (two rays) + 1.2 * core, peak 3. Past |x| = e a ray
      // is at most 1 - e and the cross ray and the core are exponentially
      // small; shares 0.6, 0.2, 0.2 of the step. Off the cross (|x| and |y|
      // both past arm) both rays are under exp(-40 arm) and the core under
      // exp(-120 arm^2); shares 0.7 and 0.3. The vertex shader draws the
      // cross as three quads that do not overlap.
      if (l * 3.0 < VIS) { return q; }
      k = 3.0;
      e = clamp(max(max(1.0 - VIS * 0.6 / (0.9 * l),
                        log(0.9 * l / (0.2 * VIS)) / 40.0),
                    sqrt(max(log(1.2 * l / (0.2 * VIS)), 0.0) / 60.0)), 0.0, 1.0);
      arm = clamp(max(log(1.8 * l / (0.7 * VIS)) / 40.0,
                      sqrt(max(log(1.2 * l / (0.3 * VIS)), 0.0) / 120.0)), 0.0, e);
    } else if (style == 3u) {
      // bokeh: its disc ends at d = 0.62 (peak 0.77, disc plus rim)
      if (l * 0.77 < VIS) { return q; }
      k = 1.6;
      e = 0.62;
    } else if (style == 4u) {
      // dust: 0.5 * exp(-4 d^2), peak 0.5
      if (l * 0.5 < VIS) { return q; }
      k = 0.8;
      e = sqrt(clamp(log(0.5 * l / VIS) / 4.0, 0.0, 1.0));
    } else {
      // glow: core exp(-40 d^2) plus halo 0.35 * exp(-6 d^2), peak 1.35;
      // shares 0.1 of the step to the core, 0.9 to the halo. At full
      // brightness that is d = 0.875, where the old quad ran to 1.
      if (l * 1.35 < VIS) { return q; }
      k = 2.5;
      e = sqrt(clamp(max(log(0.35 * l / (0.9 * VIS)) / 6.0,
                         log(l / (0.1 * VIS)) / 40.0), 0.0, 1.0));
    }
    u = vec2f(sizePx * k, 0.0);
    v = vec2f(0.0, sizePx * k);
    lo = vec2f(-e, -e);
    hi = vec2f(e, e);
  }

  let sc = r.view.z;
  q.base = r.view.xy + base * sc;
  q.u = u * sc;
  q.v = v * sc;
  q.lo = lo;
  q.hi = hi;
  q.arm = arm;
  q.alpha = alpha;
  q.color = color;
  return q;
}

// Whether the quad's bounding box overlaps the target at all.
fn onTarget(q: Quad) -> bool {
  let m = (q.lo + q.hi) * 0.5;
  let h = (q.hi - q.lo) * 0.5;
  let o = q.base + q.u * m.x + q.v * m.y;
  let ext = abs(q.u) * h.x + abs(q.v) * h.y;
  let hw = vec2f(0.5 / r.tgt.x, 0.5 / r.tgt.y);
  return all(abs(o - hw) <= hw + ext);
}
`;

export const SIM_WGSL = /* wgsl */ PARTICLE_STRUCT + VIEW_WGSL + `
struct Sim {
  a: vec4f,  // dt, time, spawn start slot, spawn count
  b: vec4f,  // capacity, emitter id, speed, spread
  c: vec4f,  // swirl, size multiplier, size variance, frame seed
  d: vec4f,  // Z_FAR, Z_NEAR, prewarm count, births per second
  e: vec4f,  // live window first slot, live window count, first-visible kr, birth jitter (s)
};
// The indirect draw's four words. Only the instance count is written here;
// particles.js sets the vertex count and zeroes this one before every frame.
struct Args {
  vertexCount: u32,
  instanceCount: atomic<u32>,
  firstVertex: u32,
  firstInstance: u32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> parts: array<P>;
@group(0) @binding(2) var<uniform> r: R;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: Args;

// A small integer hash (lowbias32), then a float in [0, 1) from it. Each call
// through rnd advances the seed, so one slot draws as many independent
// numbers as a birth needs.
fn hash(x: u32) -> u32 {
  var h = x;
  h = h ^ (h >> 16u);
  h = h * 0x7feb352du;
  h = h ^ (h >> 15u);
  h = h * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return h;
}
fn rnd(s: ptr<function, u32>) -> f32 {
  *s = hash(*s);
  return f32(*s) * (1.0 / 4294967296.0);
}

// Base size of a particle in tunnel units at size 1: about 1.2% of the
// tunnel's radius, so it reads as a point far away and a soft light close up.
const BASE_SIZE: f32 = 0.012;

// A particle born into slot i at time tBirth (s, the sim clock). Only the
// spiral reads the time, for the angle its arms have turned to.
fn emitParticle(i: u32, tBirth: f32) -> P {
  var s: u32 = hash(i * 747796405u + u32(sim.c.w));
  let h0 = rnd(&s);
  let h1 = rnd(&s);
  let h2 = rnd(&s);
  let h3 = rnd(&s);
  let h4 = rnd(&s);
  let h5 = rnd(&s);
  let h6 = rnd(&s);
  let h7 = rnd(&s);
  let h8 = rnd(&s);

  let emitter = u32(sim.b.y + 0.5);
  let spread = sim.b.w;
  let zFar = sim.d.x;
  let a0 = h0 * 6.2831853;
  let dir = vec2f(cos(a0), sin(a0));
  var xy = vec2f(0.0, 0.0);
  var lat = vec2f(0.0, 0.0);

  if (emitter == 1u) {
    // ring: a circle of radius spread at the far plane, drifting only a
    // little sideways, so it arrives as an expanding ring of lights
    let rr = 0.05 + spread * 0.95;
    xy = dir * rr;
    lat = dir * ((h1 - 0.5) * 0.04);
  } else if (emitter == 2u) {
    // spiral: three arms whose birth angle turns with time, so the tunnel
    // fills with a slowly rotating helix
    let arm = floor(h2 * 3.0);
    let a = tBirth * 1.3 + arm * 2.0943951 + (h1 - 0.5) * 0.35;
    let d = vec2f(cos(a), sin(a));
    xy = d * (0.03 + spread * 0.6 * (0.3 + 0.7 * h3));
    lat = d * (spread * 0.05);
  } else {
    // centre: a small disc at the vanishing point, fanning outward
    xy = dir * (sqrt(h1) * (0.01 + spread * 0.06));
    lat = dir * (spread * (0.05 + 0.25 * h3));
  }

  var p: P;
  p.pos = vec4f(xy, zFar * (0.85 + 0.15 * h5), 1.0);
  // Velocity and size are stored at Speed 1 and Size 1; the live Speed and
  // Size multiply them every frame, so moving either slider changes every
  // particle already in flight, not just the ones born after.
  p.vel = vec4f(lat, -(0.6 + 0.8 * h4) * 0.8, 0.0);
  p.info = vec4f(0.0, (1.0 - sim.c.z * h6) * BASE_SIZE, h8, h7);
  return p;
}

// A particle carried along its path in closed form, by travel (tunnel time,
// seconds times Speed) and the swirl's angle over the same stretch. simMain
// turns position and velocity together by the swirl every step, then moves
// the position along the velocity; with the swirl and speed held, n steps of
// that come to the start position plus travel times the start velocity, the
// lot turned by the swirl's angle.
fn carry(p: P, travel: f32, ang: f32) -> P {
  var o = p;
  let cs = cos(ang);
  let sn = sin(ang);
  let q = p.pos.xy + p.vel.xy * travel;
  let v = p.vel.xy;
  o.pos = vec4f(q.x * cs - q.y * sn, q.x * sn + q.y * cs, p.pos.z + p.vel.z * travel, p.pos.w);
  o.vel = vec4f(v.x * cs - v.y * sn, v.x * sn + v.y * cs, p.vel.z, p.vel.w);
  return o;
}

// How far along its own path (in travel) a particle emitted at the far plane
// first reaches the radius where the Fade in lets it show: 0 if it already
// shows where it starts, -1 if it never does before it passes the viewer.
//
// The swirl only turns a particle about the axis, so it never changes |xy|,
// and kr = |xy| * Z_NEAR / z is then a ratio of the straight line
// |P + L s| to the depth z0 - c s. kr reaches the threshold K where
// |P + L s|^2 = m^2 (z0 - c s)^2 with m = K / Z_NEAR, a quadratic
// A s^2 + B s + C whose C is negative (not yet showing at s = 0). Its first
// positive root is -2C / (B + sqrt(D)) in every case that has one: with
// A > 0 it is the only positive root, with A < 0 it is the nearer of two,
// with A = 0 it is -C / B. B is positive for every emitter here, so this
// form adds two positives where the textbook one would subtract near-equals.
fn firstVisible(p: P) -> f32 {
  let kv = sim.e.z;
  if (kv <= 0.0) { return 0.0; }
  let c = -p.vel.z;
  // not flying toward the viewer at all: nothing to solve, leave it as emitted
  if (c <= 0.0) { return 0.0; }
  let zNear = sim.d.y;
  let m = kv / zNear;
  let m2 = m * m;
  let z0 = p.pos.z;
  let a = p.pos.xy;
  let l = p.vel.xy;
  let cc = dot(a, a) - m2 * z0 * z0;
  if (cc >= 0.0) { return 0.0; }
  let aa = dot(l, l) - m2 * c * c;
  let bb = 2.0 * (dot(a, l) + m2 * c * z0);
  let dd = bb * bb - 4.0 * aa * cc;
  if (dd < 0.0) { return -1.0; }
  let den = bb + sqrt(dd);
  if (den <= 0.0) { return -1.0; }
  let s = -2.0 * cc / den;
  // past the viewer by then: it would have flown its whole way unseen
  if (s >= (z0 - zNear) / c) { return -1.0; }
  return s;
}

// A birth at time tNow. The particle is emitted at the far plane as ever,
// then placed where on its own path it first shows, less a random fraction
// of the birth jitter so the births do not all land on one ring of the
// screen, exactly where a particle emitted that long ago would be now: the
// same draws (the same slot and frame seed), with the spiral's arms where
// they were at that earlier time, carried the rest of the way in closed
// form. The distance depends only on magnitudes the emit time does not
// change, so the first emit's answer holds for the second. It starts at
// age 0, so the age fade in footprint() still eases it in from nothing.
//
// A birth that would never show (at Fade in, a centre stream with no Spread
// that stays too near the axis all the way) is dropped: its slot is marked
// dead and costs nothing more. It was just as dark before; it only flew.
fn birthParticle(i: u32, tNow: f32) -> P {
  var p = emitParticle(i, tNow);
  let s = firstVisible(p);
  if (s < 0.0) {
    p.pos.w = 0.0;
    return p;
  }
  if (s <= 0.0) { return p; }
  let spd = max(sim.b.z, 0.001);
  var js: u32 = hash(i * 747796405u + u32(sim.c.w)) ^ 0x68e31da4u;
  let back = max(s - rnd(&js) * sim.e.w * spd, 0.0);
  let lead = back / spd;   // the seconds it would have flown to get here
  p = emitParticle(i, tNow - lead);
  return carry(p, back, sim.c.x * 1.5 * lead);
}

@compute @workgroup_size(64)
fn simMain(@builtin(global_invocation_id) gid: vec3u) {
  // The dispatch covers only the live window: the slots born recently
  // enough that their particle may still be in flight, this frame's births
  // last, running back around the ring from the cursor.
  let cap = u32(sim.b.x + 0.5);
  if (gid.x >= u32(sim.e.y + 0.5)) { return; }
  let i = (u32(sim.e.x + 0.5) + gid.x) % cap;

  // This frame's births take the slots [start, start + count) around the ring.
  // A newborn is at age 0, so it has nothing to show until next frame.
  let start = u32(sim.a.z + 0.5);
  let count = u32(sim.a.w + 0.5);
  let off = (i + cap - start) % cap;
  if (off < count) {
    parts[i] = birthParticle(i, sim.a.y);
    return;
  }

  var p = parts[i];
  if (p.pos.w < 0.5) { return; }
  let dt = sim.a.x;
  let spd = sim.b.z;   // the live Speed: 0 freezes the stream
  // swirl turns position and velocity together about the tunnel's axis
  let ang = sim.c.x * 1.5 * dt;
  let cs = cos(ang);
  let sn = sin(ang);
  let q = vec2f(p.pos.x * cs - p.pos.y * sn, p.pos.x * sn + p.pos.y * cs);
  let v = vec2f(p.vel.x * cs - p.vel.y * sn, p.vel.x * sn + p.vel.y * cs);
  p.pos = vec4f(q + v * (dt * spd), p.pos.z + p.vel.z * (dt * spd), p.pos.w);
  p.vel = vec4f(v, p.vel.z, p.vel.w);
  p.info.x = p.info.x + dt;
  // Gone once it reaches the viewer: from Z_NEAR in its pass-the-viewer
  // fade is exactly 0, so it could only cost fill (at its largest) without
  // ever showing.
  if (p.pos.z <= sim.d.y) { p.pos.w = 0.0; }
  parts[i] = p;

  // Onto this frame's draw list only if some of it would show.
  let f = footprint(p);
  // This is the only pass that appends, once a frame, one slot at most once,
  // so the count cannot pass the list's length; the guard is belt and braces.
  if (f.alpha > 0.0 && onTarget(f)) {
    let k = atomicAdd(&args.instanceCount, 1u);
    if (k < arrayLength(&visible)) { visible[k] = i; }
  }
}

// The prewarm: the visible band as a steady stream would have left it, in
// one dispatch just ahead of simMain on the frame the stream (re)starts.
// Slots [0, count) hold the births of the last count / rate seconds, oldest
// first, where count / rate is the longest any birth can still be in flight
// (particles.js), so the ring cursor goes on from count exactly as if it had
// been running; every other slot is cleared. Each birth is made where it
// would have been made then, at its first-visible point, and carried on from
// there by its age in closed form, so the band from that point to the viewer
// fills and nothing is laid down in the dark stretch behind it. It appends
// nothing to the visible list; simMain does that straight after.
@compute @workgroup_size(64)
fn prewarmMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let cap = u32(sim.b.x + 0.5);
  if (i >= cap) { return; }
  let n = u32(sim.d.z + 0.5);
  if (i >= n) {
    var gone: P;   // zeroed, so pos.w 0: dead
    parts[i] = gone;
    return;
  }
  let age = (f32(n - i) - 0.5) / sim.d.w;
  var p = birthParticle(i, sim.a.y - age);
  if (p.pos.w > 0.5) {
    p = carry(p, age * sim.b.z, sim.c.x * 1.5 * age);
    p.info.x = age;
    // already past the viewer: gone, as simMain would have let it go
    if (p.pos.z <= sim.d.y) { p.pos.w = 0.0; }
  }
  parts[i] = p;
}
`;

// The render module draws the compact list the simulation just wrote: one
// instance per visible particle, six vertices each (eighteen for the spark,
// whose cross is three quads).
export const RENDER_WGSL = /* wgsl */ PARTICLE_STRUCT + VIEW_WGSL + `
@group(0) @binding(0) var<uniform> r: R;
@group(0) @binding(1) var<storage, read> parts: array<P>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
  @location(3) seed: f32,
};

@vertex
fn vsPart(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);   // anything with nothing to show collapses off screen
  o.uv = vec2f(0.0, 0.0);
  o.color = vec3f(0.0, 0.0, 0.0);
  o.alpha = 0.0;
  o.seed = 0.0;

  if (ii >= arrayLength(&visible)) { return o; }
  let p = parts[visible[ii]];
  let q = footprint(p);
  // The list was made from the same particle with the same uniforms, so
  // this only catches what should not happen; it costs one branch.
  if (q.alpha <= 0.0) { return o; }

  var lo = q.lo;
  var hi = q.hi;
  if (u32(r.tgt.w + 0.5) == 2u) {
    // spark: the cross as a full-width bar and the two stubs above and
    // below it, so no pixel is lit twice
    let e = q.hi.x;
    let w = q.arm;
    let piece = vi / 6u;
    if (piece == 1u) {
      lo = vec2f(-w, w); hi = vec2f(w, e);
    } else if (piece == 2u) {
      lo = vec2f(-w, -e); hi = vec2f(w, -w);
    } else {
      lo = vec2f(-e, -w); hi = vec2f(e, w);
    }
  }

  var ks = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let uv = mix(lo, hi, ks[vi % 6u]);
  let t = q.base + q.u * uv.x + q.v * uv.y;
  o.pos = vec4f(t.x * r.tgt.x * 2.0 - 1.0, 1.0 - t.y * r.tgt.y * 2.0, 0.0, 1.0);
  o.uv = uv;
  o.alpha = q.alpha;
  o.seed = p.info.z;
  o.color = q.color;
  return o;
}

@fragment
fn fsPart(o: VOut) -> @location(0) vec4f {
  let style = u32(r.tgt.w + 0.5);
  let q = o.uv;
  let d = length(q);
  var a = 0.0;
  if (style == 1u) {
    // streak: bright at the head, thinning to nothing at the tail
    let along = q.x * 0.5 + 0.5;
    a = exp(-q.y * q.y * 5.0) * along * along * (1.0 - smoothstep(0.85, 1.0, abs(q.x)));
  } else if (style == 2u) {
    // spark: a four-point star with a hot core, twinkling on its own seed
    let arms = exp(-abs(q.y) * 40.0) * (1.0 - abs(q.x)) + exp(-abs(q.x) * 40.0) * (1.0 - abs(q.y));
    let core = exp(-d * d * 60.0);
    let twinkle = 0.55 + 0.45 * sin(r.misc.z * 7.0 + o.seed * 40.0);
    a = (arms * 0.9 + core * 1.2) * twinkle;
  } else if (style == 3u) {
    // bokeh: an out-of-focus light, a faint disc with a brighter rim
    let disc = 1.0 - smoothstep(0.55, 0.62, d);
    let rim = smoothstep(0.45, 0.6, d) * disc;
    a = disc * 0.22 + rim * 0.55;
  } else if (style == 4u) {
    // dust: tiny and dim; it is the numbers that make it
    a = exp(-d * d * 4.0) * 0.5;
  } else {
    // glow: a bright core in a soft halo
    let core = exp(-d * d * 40.0);
    let halo = exp(-d * d * 6.0) * 0.35;
    a = (core + halo) * (1.0 - smoothstep(0.9, 1.0, d));
  }
  a = a * o.alpha;
  // Light only: alpha stays 0, so additive blending (and the fold's 'add')
  // lays it over whatever is beneath.
  return vec4f(o.color * a, 0.0);
}
`;
