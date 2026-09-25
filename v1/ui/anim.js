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
// asked for and reused forever after (the frame loop may not allocate). The
// id is whatever numeric id the caller already has (imgui.js hands out
// widget ids as integers for exactly this reason); this module never builds
// or hashes strings.
//
// The integrator is semi-implicit Euler on a damped harmonic oscillator,
// unit mass: accel = stiffness * (target - x) - damping * v, v += accel * dt,
// x += v * dt. It is not critically damped in the strict sense for every
// (stiffness, damping) pair in theme.js, and that is deliberate: the theme's
// pairs were picked by feel, and a couple of them ring very slightly, which
// reads as a little life in a hover rather than a dead stop. Nothing here
// enforces the critical-damping relationship; that tuning lives in theme.js.
//
// The one exception is a cfg marked `monotone`, used for a height the layout
// flows from (a group folding open or shut). There a ring is not life but a
// wobble of everything below it, so such a spring must arrive without passing
// its target. Its pair in theme.js is at or past critical damping, but a
// damped pair integrated in one big step can still ring (semi-implicit Euler
// on a 50 ms hitch flips sign every step), so it is integrated in substeps
// small enough to keep the discrete motion as calm as the continuous one,
// and any step that would still cross the target lands on it instead.

const springs = new Map(); // id (number) -> { x, v, target, settled }

const EPS_X = 0.01;
const EPS_V = 0.01;
const DT_MAX = 0.05; // seconds; a stalled tab or a debugger pause must not fling a spring
const MONO_STEP = 1 / 240; // seconds; the largest substep a monotone spring takes

let currentDt = 0;

// Called once per frame by imgui.js's begin(), before any widget touches a
// spring. Kept as a module-level scalar rather than a parameter threaded
// through every spring() call, since every spring in a given frame integrates
// by the same frame dt.
export function setDt(dtSeconds) {
  currentDt = dtSeconds < 0 ? 0 : (dtSeconds > DT_MAX ? DT_MAX : dtSeconds);
}

function stateFor(id) {
  let s = springs.get(id);
  if (!s) {
    s = { x: 0, v: 0, target: 0, settled: true, primed: false };
    springs.set(id, s);
  }
  return s;
}

// Advances the spring toward target and returns its position. cfg is one of
// theme.js's MOTION entries, { stiffness, damping }. The very first call for
// an id snaps to target with zero velocity instead of animating in from zero,
// since a widget's opening frame should not visibly spring from the origin
// of the coordinate system.
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
  if (dt > 0 && cfg.monotone) {
    const n = Math.ceil(dt / MONO_STEP);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const x0 = s.x;
      s.v += (cfg.stiffness * (target - x0) - cfg.damping * s.v) * h;
      s.x = x0 + s.v * h;
      if ((target - x0) * (target - s.x) < 0) { s.x = target; s.v = 0; break; }
    }
  } else if (dt > 0) {
    const accel = cfg.stiffness * (target - s.x) - cfg.damping * s.v;
    s.v += accel * dt;
    s.x += s.v * dt;
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
