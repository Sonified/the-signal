// WGSL for the Confetti layer: one instanced draw, no simulation pass.
//
// The pieces live in a pool of N_MAX slots. The CPU writes a slot's record
// once, when a piece is born into it (confetti.js): the moment of its birth
// on the wrapped travel clock, its own speed and size factors, and its seed,
// and a second part: where in the plane it starts, the spin clock at its
// birth, its alignment and its outward kick, and a third: its own share of
// the spin rate (see slots below).
// Nothing about a piece changes after that, so where it is now is a closed
// form of its record and the clocks: its age is T minus its birth, wrapped,
// its flight so far is that age times its speed factor over FLIGHT, and
// every other random choice about it hashes its seed.
//
// Which slots to draw, and in what order, is the CPU's list too: instance ii
// draws slot order[ii], and the list runs from the farthest piece to the
// nearest, so premultiplied "over" blending stacks them correctly. The CPU
// keeps it sorted by the same depth this shader works out; see confetti.js.
//
// Each piece is a flat card in the tunnel's own space (xy in tunnel units, z
// the depth, seen at screen = centre + xy * focal / z, as the particles and
// rings project). It tumbles about its own axis, and each of its four
// corners is projected with its own depth, so a card turning edge-on
// foreshortens as paper does. The clip position carries that depth as w, so
// the uv across the card interpolates in true perspective.
//
// Lighting happens in view space with the eye at the origin, screen y
// growing downward as the projection has it. Paper is matte with a faint
// sheen. Foil reflects a small procedural studio: a tight bright softbox and
// a broad dim one, so it flashes as it tumbles into the key and goes nearly
// dark between flashes.
//
// Every tumble and flutter rate is a whole number of cycles per
// TUMBLE_PERIOD seconds, so the CPU can wrap the tumble clock at that period
// and keep every angle continuous while the float stays small.
//
// The same draw serves the screen and, with Kaleidoscope on, the fold's
// chamber (fold.js). A projected point's offset from the field centre, in
// device px, is scaled by mot.z and placed about view.xy, in a target of
// 1 / tgt.x by 1 / tgt.y: on screen that is the field centre with scale 1,
// in the chamber the centre's texel and the chamber's texels per device px.
// The size cap is worked out in tunnel units from device px, before that
// scale, so it shrinks with the piece in the chamber on its own.
//
// Folded, the pieces are born only into the fold's fundamental domain (lf.z
// and lf.w), at that share of the rate, since the fold reads nothing else.
// Flutter still carries a piece across the domain's edges, and in the
// unfolded field as many came in from outside as went out, so a piece is
// drawn where the fold would show it: its fluttered position is taken back
// into the domain by the fold's own map (fold.wgsl.js), rotations and
// mirrors, the whole card with it. The fold then shows it exactly where it
// flew, and the density stays even right up to every seam. A card that
// straddles an edge is drawn a second time across it, so both parts show;
// each piece has two instances in a row for that, the second collapsing at
// once unless it straddles.

import { RADIAL_FADE_WGSL } from '../core/fade.js';

export const N_MAX = 8192;
// One piece's flight from the far end to the letting-go depth, travel-seconds,
// at speed factor 1.
export const FLIGHT = 9;
// The depth a piece is let go at, tunnel units: the end of its flight. The
// CPU works out each piece's depth with it to sort the draw order.
export const LETGO = 0.12;
export const TUMBLE_PERIOD = 64;
// The uniform block: nine vec4f.
export const UNIFORM_FLOATS = 36;
// A slot's record: three vec4f, side by side in the slots array (slot s at
// entries 3s, 3s + 1 and 3s + 2), so the CPU's upload of a run of slots is
// still one contiguous range. The third holds the piece's spin factor
// (Rotation variance) and three spares for whatever a piece needs next.
export const SLOT_VEC4 = 3;
export const SLOT_FLOATS = SLOT_VEC4 * 4;
// The base xy radius range, tunnel units, that the CPU draws a piece's start
// from (bias toward the middle). Perspective alone spreads the pieces out
// from the middle as they come.
export const R_MIN = 0.08;
export const R_MAX = 1.6;
// The outward kick is packed as the fraction of the second record's w (its
// whole part is the alignment in percent): the fraction times KICK_PACK is
// how far out the kick carries the piece over its whole flight, tunnel
// units. The CPU keeps the fraction below 1 (confetti.js).
export const KICK_PACK = 8;

export const CONFETTI_WGSL = /* wgsl */ `
struct U {
  view: vec4f,   // origin xy (the field centre in the target: device px, or chamber texels), focal (device px), dpr
  tgt: vec4f,    // 1 / target width, 1 / target height, largest half size on screen (device px), brightness
  clk: vec4f,    // travel clock T (travel s, wrapped at W), W, unused, tumble clock (s, wrapped)
  par: vec4f,    // shapes bitmask (1 square, 2 rectangle, 4 circle, 8 oval), size multiplier, shine, palette (0 rainbow, 1 strobe, 2 gold and silver)
  col: vec4f,    // strobe colour rgb (0..1), Z_FAR
  mot: vec4f,    // spread (0..1), flutter (0..1), target units per device px (1 on screen), opacity (0..1)
  fd: vec4f,     // centre fade in amount (0..1), Z_NEAR, spin clock (s, wrapped), tumble (0 flat to 1 full 3D)
  lf: vec4f,     // life (share of the flight, 0..1), fold (0 off, 1 on, 2 on and mirrored), domain start angle, domain span (radians)
  eye: vec4f,    // the viewer's eye x, y (tunnel units, core/eye.js), unused, unused
};
@group(0) @binding(0) var<uniform> u: U;
// One record per slot, three vec4f, written at birth. Entry 3s: birth time
// on the travel clock, speed factor, seed (an exact integer below 2^24), size
// factor. Entry 3s + 1: the angle out from the centre it starts at
// (radians), its base radius (tunnel units), the spin clock at its birth
// (s, wrapped), and its alignment and kick packed together: the whole part
// the alignment in percent (0..100), the fraction the kick over KICK_PACK.
// Entry 3s + 2: its spin factor (Rotation variance, 1 for none), then three
// spares the CPU writes as 0.
@group(0) @binding(1) var<storage, read> slots: array<vec4f, ${SLOT_VEC4 * N_MAX}>;
// The live slots, far to near.
@group(0) @binding(2) var<storage, read> order: array<u32, ${N_MAX}>;
${RADIAL_FADE_WGSL}

const FLIGHT = ${FLIGHT}.0;
const PERIOD = ${TUMBLE_PERIOD}.0;
const TAU = 6.2831853;

// Where a piece is let go, and the depth its fade out starts from. It fades
// in over the first FADE_IN of its flight, so the vanishing point never piles
// up with dots.
const LETGO = ${LETGO};
const FADE_Z = 0.2;
const FADE_IN = 0.12;

const KICK_PACK = ${KICK_PACK}.0;
// Spread: how far out a piece drifts over its whole flight at Spread 100%,
// tunnel units, before its own 0.5 to 1.5 share. The drift is steady, so a
// path is a straight line angled out from the vanishing point, and on screen
// the edge sits at about 8 z units out: at full Spread most pieces leave
// through the sides before they come near the viewer.
const SPREAD_REACH = 12.0;
// The flutter in the plane: amplitude (tunnel units) and frequency (Hz).
const FLUTTER_AMP_LO = 0.04;
const FLUTTER_AMP_HI = 0.12;
const FLUTTER_LO = 0.4;
const FLUTTER_HI = 1.3;
// The tumble's angular speed, rad/s.
const SPIN_LO = 2.0;
const SPIN_HI = 7.0;
// A piece's half size in tunnel units at Size 1, before its own size factor
// (from 1 - v to 1 + v at Size variance v, 0.8 to 1.2 at the default). Real confetti seen across a room: at mid flight on a laptop
// screen a square is about half a css px, and one passing close by a few px.
// (It was 0.12 at first, which read about 25 times too big.)
const BASE_HALF = 0.0048;
// How far the card's normal bends across its width, so a highlight sweeps
// across a turning piece instead of the whole card blinking at once.
const CURL = 0.35;
// The fold: bounds on how far a card's corners reach from its centre in the
// plane, its half diagonal. Before the size cap that is at most 1.51 of its
// half size unit (the 0.8 by 1.28 rectangle's diagonal, the longest); after
// it, at most 1.415 of its capped longest half side (the square's root 2).
const DIAG_MAX = 1.51;
const DIAG_CAP = 1.415;
// And the chamber texels of slack past that, so a card whose outline stops
// just short of a seam still draws its twin: the fold's bilinear read at the
// seam reaches about a texel across it.
const EDGE_SLACK = 2.0;

// The lights, as directions toward them. The key comes from upper left and
// in front (toward the viewer, negative z), the rim from behind the pieces
// and to the right, so it only catches a card nearly edge-on. The second
// softbox is broad and dim, upper right and in front; only foil sees it.
const L1 = vec3f(-0.5, -0.65, -0.57);
// The fill, from lower right and in front, across from the key: a card
// turned away from the key catches this one instead, dimmer and from the
// other side, so it is shaded rather than lost to black. With the key alone
// every card facing away went dark; far away those were specks that vanished
// against the dark field, but close by they read as big dark shapes, so the
// stream looked lit only in the middle.
const LF = vec3f(0.55, 0.45, -0.7);
const L2 = vec3f(0.7, -0.1, 0.71);
const L3 = vec3f(0.55, -0.5, -0.67);

// Paper: ambient, key and fill diffuse, rim, and a satin sheen off both the
// key and the fill, so paper glints as it turns as well as foil.
const AMBIENT = 0.2;
const DIFFUSE = 0.75;
const FILL = 0.4;
const RIM = 0.3;
const SHEEN = 0.2;
const FILL_SHEEN = 0.1;
const SHEEN_POW = 16.0;
// Foil's studio: a dim base, the tight key softbox, a fill softbox across
// from it, the broad one, and a gentle top to bottom gradient.
const ENV_BASE = 0.05;
const ENV_FILL_POW = 12.0;
const ENV_FILL_GAIN = 0.8;
const ENV_KEY_POW = 24.0;
const ENV_KEY_GAIN = 1.6;
const ENV_BOX_POW = 6.0;
const ENV_BOX_GAIN = 0.45;
const ENV_GRAD = 0.1;

const GOLD = vec3f(1.0, 0.78, 0.34);
const SILVER = vec3f(0.85, 0.87, 0.90);

fn pcg(n: u32) -> u32 {
  let s = n * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn unit(h: u32) -> f32 {
  return f32(h) * (1.0 / 4294967296.0);
}
fn rnd(seed: u32, k: u32) -> f32 {
  return unit(pcg(seed ^ pcg(k * 7919u + 17u)));
}

// A direction on the unit sphere.
fn sphere(h1: f32, h2: f32) -> vec3f {
  let z = 2.0 * h1 - 1.0;
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = TAU * h2;
  return vec3f(cos(phi) * r, sin(phi) * r, z);
}

// Rodrigues: v turned by angle a about the unit axis k.
fn turn(v: vec3f, k: vec3f, c: f32, s: f32) -> vec3f {
  return v * c + cross(k, v) * s + k * (dot(k, v) * (1.0 - c));
}

fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3f {
  let k = fract(vec3f(0.0, 8.0, 4.0) / 12.0 + h) * 12.0;
  let a = s * min(l, 1.0 - l);
  return l - a * clamp(min(k - 3.0, 9.0 - k), vec3f(-1.0), vec3f(1.0));
}
fn rgb2hsl(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) * 0.5;
  let d = mx - mn;
  if (d < 0.00001) { return vec3f(0.0, 0.0, l); }
  let s = d / max(1.0 - abs(2.0 * l - 1.0), 0.00001);
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3f(h / 6.0, s, l);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,       // -1..1 across the card
  @location(1) view: vec3f,     // the point on the card, view space
  @location(2) nrm: vec3f,      // the card's normal
  @location(3) tng: vec3f,      // the card's own x axis
  @location(4) albedo: vec3f,
  @location(5) misc: vec3f,     // foil (0 or 1), circle (0 or 1), fade
};

@vertex
fn vsConf(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0);   // a piece not showing collapses off screen
  o.uv = vec2f(0.0, 0.0);
  o.view = vec3f(0.0, 0.0, 1.0);
  o.nrm = vec3f(0.0, 0.0, -1.0);
  o.tng = vec3f(1.0, 0.0, 0.0);
  o.albedo = vec3f(0.0, 0.0, 0.0);
  o.misc = vec3f(0.0, 0.0, 0.0);

  // The piece: its slot's record, and how far through its flight it is.
  // Its age wraps with the travel clock (the CPU only lists pieces younger
  // than their flight, far less than W), and a hair below 0 is a birth whose
  // time rounded just past the clock's, so just born. As confetti.js has it.
  // Folded, each list entry has two instances in a row, the piece and its
  // twin across the nearer edge, so the far to near order holds.
  let folded = u.lf.y > 0.5;
  let mirrored = u.lf.y > 1.5;
  var li = ii;
  var twin = 0u;
  if (folded) { li = ii >> 1u; twin = ii & 1u; }
  let si = order[li];
  let rec = slots[(${SLOT_VEC4}u * si)];
  let rec2 = slots[(${SLOT_VEC4}u * si) + 1u];
  let rec3 = slots[(${SLOT_VEC4}u * si) + 2u];
  var age = u.clk.x - rec.x;
  if (age < -0.5 * u.clk.y) { age = age + u.clk.y; }
  age = max(age, 0.0);
  let q = age * rec.y / FLIGHT;
  let zfar = u.col.w;
  let z = zfar - (zfar - LETGO) * q;
  let fade = smoothstep(0.0, FADE_IN, q) * smoothstep(LETGO, FADE_Z, z);
  if (fade <= 0.0) { return o; }
  let seed = pcg(u32(rec.z) ^ 0x68bc21ebu);
  // Life: the share of the flight a piece lives before it fades out. At 1
  // that is the whole flight. Shorter, each piece ends a little before the
  // setting, by up to 30% of the life cut: at Speed variance 0 every piece
  // nears the viewer at the same rate, so one shared end would fade them all
  // at the same depth, a wall.
  let life = u.lf.x;
  let lend = life - (1.0 - life) * 0.3 * rnd(seed, 17u);
  let lifeFade = 1.0 - smoothstep(lend - max(0.06, 0.25 * lend), lend, q);
  if (lifeFade <= 0.0) { return o; }
  let tc = u.clk.w;

  // Where it flies: its base point in the plane, the angle and radius the CPU
  // drew at birth (confetti.js, where Clump gathers a burst onto one ring),
  // drifting straight out along that angle, plus a flutter. Frequencies are
  // whole cycles per PERIOD. The drift is Spread's, live, and the burst's
  // own kick, fixed at birth; both steady, so a path stays a straight line
  // angled out from the vanishing point. Folded, the CPU keeps the angle
  // inside the domain, which is all the fold reads, and the drift follows it
  // outward, so it stays there too.
  let th = rec2.x;
  let alignPct = floor(rec2.w);
  let kick = (rec2.w - alignPct) * KICK_PACK;
  let rad = rec2.y
    + (u.mot.x * SPREAD_REACH * mix(0.5, 1.5, rnd(seed, 16u)) + kick) * q;
  let fm = floor(mix(FLUTTER_LO, FLUTTER_HI, rnd(seed, 3u)) * PERIOD);
  let fa = TAU * fract(fm * tc / PERIOD) + TAU * rnd(seed, 4u);
  let famp = mix(FLUTTER_AMP_LO, FLUTTER_AMP_HI, rnd(seed, 5u)) * u.mot.y;
  let wob = famp * vec2f(sin(fa), 0.5 * sin(2.0 * fa + TAU * rnd(seed, 6u)));
  let centre = vec3f(vec2f(cos(th), sin(th)) * rad + wob, z);
  // The same centre as the viewer's eye sees it (core/eye.js): the eye's
  // sideways offset comes off in the plane before the perspective divide,
  // so a far piece barely moves and a near one moves a lot. Everything that
  // decides where it lands on screen (the fold's element and twin below,
  // the corners' projection) goes by this; its fades and its light stay on
  // its own position, since they belong to the piece and must ride with it.
  // With the eye at 0 it is centre.xy, bit for bit.
  let seen = centre.xy - u.eye.xy;

  // The size cap (used below), needed here for the twin's reach.
  let focal = u.view.z;
  let lim = min(u.tgt.z * z / focal, 0.5 * z);

  // Folded: the element of the fold's symmetry that takes the fluttered
  // centre back into the domain, as the fold itself turns a screen point in.
  // It is kept as a turn phi after a flip of y when gsg is -1, so a point at
  // angle a lands at phi + gsg * a. The twin then goes one step further,
  // across the domain edge nearer that image: reflected across it with
  // mirror, turned one span on without, which puts the part of the card
  // hanging out past the edge where the fold will read it. The twin is kept
  // only if the card reaches that edge, which, since projection keeps a
  // point's angle, is r sin(gap) against the card's half diagonal in the
  // plane; the gap is at most half the span, never past a right angle, and
  // at r near 0 the test keeps it.
  var gc = 1.0;
  var gs = 0.0;
  var gsg = 1.0;
  if (folded) {
    let dom0 = u.lf.z;
    let span = u.lf.w;
    let wdg = select(span, 2.0 * span, mirrored);
    let r = length(seen);
    let a = select(dom0 + 0.5 * span, atan2(seen.y, seen.x), r > 1e-6);
    let rel = a - dom0;
    let kw = wdg * floor(rel / wdg);
    var m = rel - kw;
    var phi = -kw;
    if (mirrored && m > span) {
      m = wdg - m;
      phi = 2.0 * dom0 + kw + wdg;
      gsg = -1.0;
    }
    if (twin == 1u) {
      let nearStart = m < 0.5 * span;
      let gap = max(select(span - m, m, nearStart), 0.0);
      let reach = min(DIAG_MAX * BASE_HALF * u.par.y * rec.w, DIAG_CAP * lim)
        + EDGE_SLACK * z / (focal * max(u.mot.z, 1e-6));
      if (r * sin(gap) > reach) { return o; }
      if (mirrored) {
        phi = 2.0 * select(dom0 + span, dom0, nearStart) - phi;
        gsg = -gsg;
      } else {
        phi = phi + select(-span, span, nearStart);
      }
    }
    gc = cos(phi);
    gs = sin(phi);
  }

  // The centre fade: the tunnel rings' own Fade in curve (core/fade.js), so
  // one setting means the same here as on the rings and the particles. kr is
  // the piece's distance from the vanishing point over the rings' rim, which
  // with focal = rim * Z_NEAR is |xy| / z * Z_NEAR. Only the fade in: the
  // rings' fade out toward the rim would dim the pieces at the edges again.
  let kr = length(centre.xy) / z * u.fd.y;
  let centreFade = radialFadeIn(u.fd.x, kr);
  if (centreFade <= 0.0) { return o; }

  // The tumble: turning a whole number of times per PERIOD on the spin
  // clock, which runs at the Rotation speed. The axis leans from straight at
  // the viewer (Tumble 0: the card spins flat in the screen's plane, always
  // face on, a turning square) to the piece's own random axis (Tumble 1: the
  // full 3D tumble). The random axis is taken on the viewer's side first, so
  // the lean never passes through zero; turning about -a is only the same
  // turn run backward.
  //
  // Alignment: the turn starts from the piece's pose at birth, which is the
  // aligned pose, the card face on with its own long axis (y) pointing
  // straight out from the centre along its angle th, as the Kaleidoscope
  // layer seats its shapes. The angle turned is counted from the spin clock
  // at its birth (rec2.z), so a piece born this moment shows that pose
  // exactly, plus a random phase that the alignment at birth takes away: at
  // 100% every piece is born pointing straight out, at 0 the phase is fully
  // random and the pose as random as ever. Since wn is a whole number of
  // turns per PERIOD, the difference of two wrapped clocks gives the same
  // angle as the unwrapped one. With Rotation speed 0 the clock stands and
  // an aligned piece stays aligned.
  //
  // Rotation variance: the piece's own spin factor, drawn at birth (rec3.x),
  // scales its turns per PERIOD and is rounded back to a whole number, never
  // below 0, so the wrapped clocks still give a continuous angle. It changes
  // only the rate: the angle is still 0 at the piece's birth, so alignment
  // holds.
  var own = sphere(rnd(seed, 7u), rnd(seed, 8u));
  if (own.z < 0.0) { own = -own; }
  let axis = normalize(mix(vec3f(0.0, 0.0, 1.0), own, u.fd.w));
  let wn0 = floor(mix(SPIN_LO, SPIN_HI, rnd(seed, 9u)) * PERIOD / TAU);
  let wn = max(0.0, round(wn0 * rec3.x));
  let align = alignPct * 0.01;
  let ang = TAU * fract(wn * (u.fd.z - rec2.z) / PERIOD)
    + (1.0 - align) * TAU * rnd(seed, 10u);
  let ca = cos(ang);
  let sa = sin(ang);
  // The aligned pose: the card turned in the screen's plane so its y runs
  // along (cos th, sin th) and its x a quarter turn clockwise of that, which
  // keeps the normal x cross y pointing along +z as before.
  let bx = vec3f(sin(th), -cos(th), 0.0);
  let by = vec3f(cos(th), sin(th), 0.0);
  let ex = turn(bx, axis, ca, sa);
  let ey = turn(by, axis, ca, sa);

  // The shape, one of those lit in the Shapes control: 0 square, 1 rectangle
  // 1 : 1.6, 2 circle, 3 oval, sent as the bitmask par.x (bit i for shape i).
  // Each piece picks evenly among the lit shapes from its own seed, so it
  // keeps its shape all the way down, and a change to the set reshapes the
  // pieces already flying too. An empty mask never arrives, but reads as all
  // four so a piece always has something to be. The odd shapes are the long
  // ones and the upper two the round ones; an oval is the circle's disc test
  // on the rectangle's card, which the uv space stretches into an ellipse.
  var mask = (u32(u.par.x + 0.5) & 15u);
  if (mask == 0u) { mask = 15u; }
  let lit = countOneBits(mask);
  var pick = min(u32(rnd(seed, 11u) * f32(lit)), (lit - 1u));
  var shape = 0u;
  for (var i = 0u; i < 4u; i++) {
    if (((mask >> i) & 1u) == 1u) {
      if (pick == 0u) { shape = i; break; }
      pick = pick - 1u;
    }
  }
  let half = select(vec2f(1.0, 1.0), vec2f(0.8, 1.28), ((shape & 1u) == 1u));
  let circle = select(0.0, 1.0, shape >= 2u);
  // The size factor was drawn at birth (the record's w), so Size variance
  // only reaches pieces born after it moves.
  var hxy = half * (BASE_HALF * u.par.y * rec.w);
  // Never larger on screen than the cap, and never so large near the viewer
  // that a corner could reach behind the eye.
  let longest = max(hxy.x, hxy.y);
  hxy = hxy * min(1.0, lim / longest);

  var ks = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let k = ks[vi % 6u];
  let pc = centre + ex * (k.x * hxy.x) + ey * (k.y * hxy.y);
  let w = max(pc.z, 0.01);
  // Folded, the whole card goes through the fold's element, every corner
  // alike; unfolded that is the identity. Only where it lands changes: it
  // keeps its own normal and light, so the fold shows the piece where it
  // flew exactly as it would look there, with no jump as it crosses a seam.
  // Each corner is first moved by the eye, the same shift in the plane for
  // all four, then divided by its own depth; the fold comes after, so the
  // kaleidoscope folds the scene as the moved eye sees it.
  let ps = pc.xy - u.eye.xy;
  let pxy = vec2f(gc * ps.x - gs * gsg * ps.y, gs * ps.x + gc * gsg * ps.y);
  let sp = u.view.xy + pxy * (focal / w * u.mot.z);
  let ndc = vec2f(sp.x * u.tgt.x * 2.0 - 1.0, 1.0 - sp.y * u.tgt.y * 2.0);
  o.pos = vec4f(ndc * w, 0.0, w);

  // The colour, and paper or foil.
  let pal = u32(u.par.w + 0.5);
  let hc = rnd(seed, 13u);
  let hl = rnd(seed, 14u);
  var foil = select(0.0, 1.0, rnd(seed, 15u) < u.par.z);
  var alb = vec3f(1.0, 1.0, 1.0);
  if (pal == 2u) {
    foil = 1.0;
    alb = select(SILVER, GOLD, hc < 0.6);
  } else if (pal == 1u) {
    // the strobe's colour, each piece's hue turned up to 25 degrees either
    // way and its lightness varied
    let hsl = rgb2hsl(u.col.rgb);
    let l = clamp(hsl.z + (hl - 0.5) * 0.3, 0.15, 0.85);
    alb = hsl2rgb(hsl.x + (hc - 0.5) * (50.0 / 360.0), hsl.y, l);
  } else {
    var hues = array<f32, 6>(350.0, 28.0, 50.0, 140.0, 200.0, 275.0);
    let hue = hues[min(u32(hc * 6.0), 5u)] / 360.0;
    alb = hsl2rgb(hue, 0.75, 0.55 + (hl - 0.5) * 0.08);
  }

  o.uv = k;
  o.view = pc;
  o.nrm = cross(ex, ey);
  o.tng = ex;
  o.albedo = alb;
  o.misc = vec3f(foil, circle, fade * centreFade * lifeFade * u.mot.w);
  return o;
}

// The studio foil reflects: brightness seen along the reflected ray r.
fn env(r: vec3f) -> f32 {
  let key = pow(max(dot(r, normalize(L1)), 0.000001), ENV_KEY_POW) * ENV_KEY_GAIN;
  let box = pow(max(dot(r, normalize(L3)), 0.000001), ENV_BOX_POW) * ENV_BOX_GAIN;
  let fill = pow(max(dot(r, normalize(LF)), 0.000001), ENV_FILL_POW) * ENV_FILL_GAIN;
  // brighter overhead; screen y grows downward
  let grad = ENV_GRAD * (0.5 - 0.5 * r.y);
  return ENV_BASE + key + fill + box + grad;
}

@fragment
fn fsConf(o: VOut) -> @location(0) vec4f {
  // Derivatives first, while control flow is still uniform.
  let fw = max(fwidth(o.uv), vec2f(0.0001));
  let d = length(o.uv);
  let fd = max(fwidth(d), 0.0001);
  // About a one pixel soft edge, inside the card's outline.
  let edge = clamp((vec2f(1.0) - abs(o.uv)) / fw, vec2f(0.0), vec2f(1.0));
  let cov = select(edge.x * edge.y, clamp((1.0 - d) / fd, 0.0, 1.0), o.misc.y > 0.5);
  if (cov <= 0.0) { discard; }

  // Lit as if seen straight down the tunnel, the same view for every piece,
  // so a piece's light depends only on how it is turned. The tunnel's
  // perspective is very wide (the screen's edge is some 80 degrees off the
  // centre line), and shaded from its own true view a piece near the edge or
  // close by is seen almost side on, its face turned away from the lights,
  // which left only the middle of the stream bright.
  let v = vec3f(0.0, 0.0, -1.0);
  var n = normalize(o.nrm);
  // Two-sided: whichever face the viewer sees is lit.
  if (dot(n, v) < 0.0) { n = -n; }
  let n2 = normalize(n + normalize(o.tng) * (o.uv.x * CURL));
  let l1 = normalize(L1);
  let l2 = normalize(L2);
  let alb = o.albedo;

  var col: vec3f;
  if (o.misc.x > 0.5) {
    // Foil: the studio's reflection, tinted by the metal, whitening toward
    // grazing (Schlick, F0 the albedo).
    let r = reflect(-v, n2);
    let cosv = clamp(dot(n2, v), 0.0, 1.0);
    let f = pow(1.0 - cosv, 5.0);
    col = env(r) * mix(alb, vec3f(1.0), f);
  } else {
    // Paper.
    let lf = normalize(LF);
    let lit = AMBIENT + DIFFUSE * max(dot(n2, l1), 0.0) + FILL * max(dot(n2, lf), 0.0)
      + RIM * max(dot(n2, l2), 0.0);
    let hv = normalize(l1 + v);
    let hf = normalize(lf + v);
    let sheen = SHEEN * pow(max(dot(n2, hv), 0.000001), SHEEN_POW)
      + FILL_SHEEN * pow(max(dot(n2, hf), 0.000001), SHEEN_POW);
    col = alb * lit + vec3f(sheen);
  }
  // Opaque paper, premultiplied: the fade is opacity, Brightness darkens.
  let a = cov * o.misc.z;
  col = clamp(col, vec3f(0.0), vec3f(1.0)) * u.tgt.w;
  return vec4f(col * a, a);
}
`;
