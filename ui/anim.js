// Springs for the toolkit.
//
// Every hover, press, selection and panel-height change in v1 moves under a
// spring rather than an eased tween, because an eased tween has no notion of
// where it currently is: retrigger one halfway through (hover off, then back
// on before it settles) and it snaps to the start of a new curve. A spring
// carries its velocity across that retrigger, so the motion stays continuous
// no matter how the input changes underneath it. That continuity is most of
// what makes an immediate-mode UI, rebuilt from nothing every frame, read as
// a soft physical surface instead of a slideshow of computed states.
//
// State is one small object per spring id, created the first time that id is
// asked for and reused forever after (the frame loop may not allocate).
//
// The damped harmonic oscillator has an exact solution, so nothing here is
// integrated: each frame evaluates where the continuous spring really is
// after dt, however long dt turns out to be. A numerical step (the
// semi-implicit Euler this file used to take) is only an approximation of
// that solution, and one with a stability limit: past a step of roughly
// 30 ms the press pair's correction overshoots by more than the whole
// distance and grows instead of settling — on a phone whose frames stretched
// under a slider drag, the knob's radius diverged by a factor of three a
// frame until the circle filled the screen. The exact solution has no step
// size, so there is nothing to clamp (the old DT_MAX) and nothing to divide
// into substeps (the old monotone loop): a stalled tab's ten-second dt just
// lands the spring settled at its target, where a real spring would be. It
// also makes the motion exactly frame-rate independent: a hover at 30 fps
// and at 120 Hz trace the same curve through time.
//
// Per cfg — one of theme.js's MOTION pairs, { stiffness, damping }, unit
// mass — the solution over this frame's dt is a 2x2 transition matrix on
// (offset from target, velocity). It is cached on the cfg object and
// recomputed only when dt changes, so the five shared pairs cost a handful
// of transcendentals a frame while each of the hundreds of spring updates is
// four multiplies. With z = damping/2 and w² = stiffness, an underdamped
// pair (z < w, every hover and press in theme.js) decays along
// e^(-z·t)·(cos, sin) of w_d = sqrt(w² - z²); an overdamped pair (the fold)
// is two real exponentials e^((-z ± d)·t), d = sqrt(z² - w²), both decaying,
// kept as the two exponentials rather than e^(-z·t)·cosh(d·t) so neither
// factor can overflow while their product underflows; the critically damped
// seam between them is the d → 0 limit of either.
//
// A cfg marked `monotone` is used for a height the layout flows from (a
// group folding open or shut), where a ring is not life but a wobble of
// everything below it. Its pair is at or past critical damping, so the
// exact solution never oscillates; the one crossing a carried velocity can
// still make (physics, not discretization) is landed on the target instead.

const springs = new Map(); // id -> { x, v, target, settled, primed }

const EPS_X = 0.01;
const EPS_V = 0.01;

let currentDt = 0;

// Called once per frame by imgui.js's begin() (and main.js on the idle
// frames whose UI build is skipped), before any widget touches a spring.
// Kept as a module-level scalar rather than a parameter threaded through
// every spring() call, since every spring in a given frame moves over the
// same dt.
export function setDt(dtSeconds) {
  currentDt = dtSeconds < 0 ? 0 : dtSeconds;
}

function stateFor(id) {
  let s = springs.get(id);
  if (!s) {
    s = { x: 0, v: 0, target: 0, settled: true, primed: false };
    springs.set(id, s);
  }
  return s;
}

// The exact transition over dt for this cfg, cached on the cfg itself:
// offset' = xx·offset + xv·v, v' = vx·offset + vv·v.
function refreshCoeffs(cfg, dt) {
  cfg._dt = dt;
  const w2 = cfg.stiffness, z = cfg.damping / 2;
  const d2 = z * z - w2;
  if (d2 < -1e-9) {
    // underdamped: a decaying spiral at w_d
    const wd = Math.sqrt(-d2);
    const E = Math.exp(-z * dt);
    const C = Math.cos(wd * dt), S = Math.sin(wd * dt) / wd;
    cfg._xx = E * (C + z * S);
    cfg._xv = E * S;
    cfg._vx = -E * w2 * S;
    cfg._vv = E * (C - z * S);
  } else if (d2 > 1e-9) {
    // overdamped: two real exponentials, both in (0, 1], never overflowing
    const d = Math.sqrt(d2), inv = -0.5 / d;
    const r1 = -z + d, r2 = -z - d;
    const z1 = Math.exp(r1 * dt), z2 = Math.exp(r2 * dt);
    cfg._xx = (r2 * z1 - r1 * z2) * inv;
    cfg._xv = (z2 - z1) * inv;
    cfg._vx = w2 * (z1 - z2) * inv;
    cfg._vv = (r2 * z2 - r1 * z1) * inv;
  } else {
    // critically damped: the seam, the d -> 0 limit of both
    const E = Math.exp(-z * dt);
    cfg._xx = E * (1 + z * dt);
    cfg._xv = E * dt;
    cfg._vx = -E * z * z * dt;
    cfg._vv = E * (1 - z * dt);
  }
}

// Moves the spring to where it stands dt after this frame's start and
// returns its position. cfg is one of theme.js's MOTION entries. The very
// first call for an id snaps to target with zero velocity instead of
// animating in from zero, since a widget's opening frame should not visibly
// spring from the origin of the coordinate system.
export function spring(id, target, cfg) {
  const s = stateFor(id);
  if (!s.primed) {
    s.primed = true;
    s.x = target;
    s.target = target;
    s.settled = true;
    return s.x;
  }
  s.target = target;
  if (s.settled && s.x === target) return s.x;
  const dt = currentDt;
  if (dt > 0) {
    if (cfg._dt !== dt) refreshCoeffs(cfg, dt);
    const e = s.x - target, v = s.v;
    s.x = target + cfg._xx * e + cfg._xv * v;
    s.v = cfg._vx * e + cfg._vv * v;
    // the one crossing carried velocity can make lands on the target
    if (cfg.monotone && e * (s.x - target) < 0) { s.x = target; s.v = 0; }
  }
  if (Math.abs(target - s.x) < EPS_X && Math.abs(s.v) < EPS_V) {
    s.x = target;
    s.v = 0;
    s.settled = true;
  } else {
    s.settled = false;
  }
  return s.x;
}

// Sets a spring's position and velocity directly with no motion, for the one
// case that is not an animation: a control mounting at its real value (a
// slider's first frame at the saved position, not a spring in from zero) or a
// hard reset after a jump the viewer should not see travel (opening a panel
// somewhere new). Safe to call before or after the id's first spring() call.
export function reset(id, value) {
  const s = stateFor(id);
  s.x = value;
  s.v = 0;
  s.target = value;
  s.settled = true;
  s.primed = true;
}

export function velocity(id) {
  const s = springs.get(id);
  return s ? s.v : 0;
}

export function settled(id) {
  const s = springs.get(id);
  return s ? s.settled : true;
}

export function value(id) {
  const s = springs.get(id);
  return s ? s.x : 0;
}

// Writes a linearly-mixed colour into a caller-owned Float32Array(4), a to b
// at t (0..1, unclamped so an overshoot spring can push past the ends on
// purpose). Never allocates; `out` is scratch the caller keeps across frames.
export function mixColor(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  out[3] = a[3] + (b[3] - a[3]) * t;
}
