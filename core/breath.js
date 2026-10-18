// The sun's breath: one law, written once, that says where the breath is at
// any moment, and that the screen and the sound both read. It is the
// strobe's own pattern (core/signal.js, whose header is the spec), carried
// over to a slower wave: not an accumulator a frame steps, but a formula of
// time,
//
//   phase(t)    = (offset + cycles since the anchor) mod 1
//   position(t) = 0.5 + 0.5 sin 2π phase(t)      0 full exhale, 1 full inhale
//   rising(t)   = cos 2π phase(t) >= 0           inhaling
//
// with t on the clock every thread shares (signal.js SIGNAL_ORIGIN plus the
// thread's performance.now, or a frame's rAF time on that same timeline).
// So a reader that is not drawing frames (the hum's variances on a timer in
// a hidden tab, the page's audio in worker mode) knows where the breath is
// exactly as the frame that draws it does, and the hum's filter follows the
// breath at the audio's own cadence rather than the screen's.
//
// That is all this file is: the law (breathPhaseAt, breathPosAt,
// breathRising, breathRateAt, breathScaleAt), the one state of this thread
// (sunBreath), its one writer (steerBreath) and its trip across threads
// (packBreath, unpackBreath). Like signal.js it imports nothing, so the js/
// audio modules can share it as they share variance.js.
//
// ---------- the rate, and the pause ----------
// The rate is S.sunBreathRate breaths a minute, clamped 0.5 to 12
// (breathHz, cycles a second = rate / 60). A new rate is folded in at the
// moment it lands, as signal.js retimeSignal folds the strobe's: the anchor
// moves to now and the offset becomes the phase the old numbers gave now, so
// the breath carries on from where it is at the new rate. A preset's or a
// journey's glide hands the writer a new rate every frame and every one
// folds; the folds telescope, so the glide is as smooth as a drag.
//
// The pause is the second thing the formula carries. The scene's motion
// eases to a stop over the pause wind-down (core/motion.js): its scale on
// every frame's step is (1 - u)^2 over the wind-down's share u of its
// S.pauseWindDown seconds, and the breath rode that scale. So the formula's
// rate can be that ease too: from r0 at the anchor down to 0 `dur` seconds
// later,
//
//   rate(tau)   = r0 (1 - tau/dur)^2                        while tau < dur
//   cycles(tau) = r0 dur/3 (1 - (1 - tau/dur)^3)            while tau < dur
//               = r0 dur/3                                  after: held
//
// which is the old accumulator's own curve, solved rather than summed, so
// the breath glides to a halt, holds exactly where the motion's ease would
// have left it, and needs no frame to get there. The ease's tail is the same
// shape again ((1 - u)^2 from any u on is a scaled copy of itself over what
// is left of the wind-down), so a fold made mid-wind-down (the rate moved, the
// wind-down's length moved) starts a fresh ease from where the motion's
// scale stands: r0 = the rate x the scale, dur = the wind-down x sqrt(scale),
// the seconds the motion has left. A stop for safety (motionHalt), or a
// wind-down of 0, is a fold to rate 0 at once; a resume is a fold back to the
// full rate at once, as the motion's own resume is, from wherever the breath
// held.
//
// breathScaleAt is the same ease read back as a scale, rate over the full
// rate: 1 running, the motion's (1 - u)^2 while winding down, 0 stopped. A
// reader with no motion of its own (the page in worker mode) steps a
// variance's own clock by it, so a paused scene's hum holds its variances
// still as the screen's do.
//
// ---------- who writes, who reads ----------
// main.js is the one writer, once a frame straight after the motion's tick,
// in the engine's own loop: in worker mode that is the worker. gpu/sun.js
// reads the frame's position (the Atmosphere sweep, the trails' Stream, the
// Breath drawer's live gauge, S.effSunBreathPos and S.effSunBreathIn), and
// core/sun-hum-vary.js reads it at its own times for the hum. In worker
// mode the page keeps its own copy of this module and of sunBreath; the
// worker's audio link (core/audio-link.js) sends the packed state across
// whenever it changes (a rate moved, a pause, a resume), which is rarely,
// and between changes the two threads are each evaluating the same law.

// The state the law reads:
//   at        the anchor, absolute ms on the shared clock
//   offset    the phase at the anchor, 0 to 1
//   r0        the rate at the anchor, Hz (cycles a second)
//   dur       the ease to a stop, seconds from the anchor; 0 a steady rate
//   full      the running rate, Hz, which breathScaleAt reads the ease against
//   mode      what the writer last folded in: BREATH_RUN, _WIND or _STOP
//   wind      the wind-down length that fold was made with, seconds
//   gen       bumped by every change, so a reader can tell it has moved
// The app boots stopped, so the breath does: rate 0 at the top of its cycle
// (position 0.5, inhaling), where the old accumulator began.
export const BREATH_RUN = 0, BREATH_WIND = 1, BREATH_STOP = 2;
export function sunBreathState() {
  return { at: 0, offset: 0, r0: 0, dur: 0, full: 5.5 / 60, mode: BREATH_STOP, wind: 0, gen: 0 };
}

// The one breath of this thread.
export const sunBreath = sunBreathState();

// S.sunBreathRate as the law takes it: breaths a minute, clamped 0.5 to 12
// (5.5, coherent breathing, for anything not a number), as cycles a second.
export function breathHz(bpm) {
  if (typeof bpm !== 'number' || !(bpm === bpm)) return 5.5 / 60;
  return (bpm < 0.5 ? 0.5 : bpm > 12 ? 12 : bpm) / 60;
}

// ---------- the law ----------
// Cycles since the anchor, tau seconds after it. Before the anchor (a reader
// whose clock sits a hair behind the writer's) it runs back at r0.
function cyclesAt(s, tau) {
  if (tau <= 0 || !(s.dur > 0)) return s.r0 * tau;
  if (tau >= s.dur) return s.r0 * s.dur / 3;
  const k = 1 - tau / s.dur;
  return s.r0 * s.dur / 3 * (1 - k * k * k);
}

export function breathPhaseAt(s, t) {
  const x = s.offset + cyclesAt(s, (t - s.at) / 1000);
  return x - Math.floor(x);
}

export function breathRateAt(s, t) {
  const tau = (t - s.at) / 1000;
  if (tau <= 0 || !(s.dur > 0)) return s.r0;
  if (tau >= s.dur) return 0;
  const k = 1 - tau / s.dur;
  return s.r0 * k * k;
}

// Where the breath is, 0 full exhale to 1 full inhale.
export function breathPosAt(s, t) {
  return 0.5 + 0.5 * Math.sin(2 * Math.PI * breathPhaseAt(s, t));
}

// Whether it is inhaling (rising) at t.
export function breathRising(s, t) {
  return Math.cos(2 * Math.PI * breathPhaseAt(s, t)) >= 0;
}

// The pause as a scale on motion, 0 to 1 (see the top of this file).
export function breathScaleAt(s, t) {
  if (!(s.full > 0)) return 0;
  const k = breathRateAt(s, t) / s.full;
  return k > 1 ? 1 : k < 0 ? 0 : k;
}

// ---------- changing it ----------
// Folds a new rate in at t: from t on the formula runs at r0, easing to a
// stop over dur seconds (dur 0: steady at r0), and its phase at t is the one
// the old numbers gave, so it carries on rather than jumping.
export function retimeBreath(s, t, r0, dur = 0) {
  const p = breathPhaseAt(s, t);
  s.at = t; s.offset = p;
  s.r0 = r0; s.dur = dur > 0 ? dur : 0;
  s.gen++;
}

// The writer, once a frame: the rate wanted (breathHz), whether the scene
// runs (S.running), the motion's scale this frame (core/motion.js
// motionScale) and the wind-down's length (S.pauseWindDown). It folds only
// when one of them says something new, so a steady breath is never touched
// and a paused one is folded once; returns whether it folded.
export function steerBreath(s, t, want, running, scale, windS) {
  if (running) {
    if (s.mode === BREATH_RUN && s.full === want) return false;
    retimeBreath(s, t, want);
    s.mode = BREATH_RUN; s.full = want;
    return true;
  }
  if (scale > 0 && windS > 0) {
    if (s.mode === BREATH_WIND && s.full === want && s.wind === windS) return false;
    const k = scale < 1 ? scale : 1;
    retimeBreath(s, t, want * k, windS * Math.sqrt(k));
    s.mode = BREATH_WIND; s.full = want; s.wind = windS;
    return true;
  }
  if (s.mode === BREATH_STOP) return false;
  retimeBreath(s, t, 0);
  s.mode = BREATH_STOP;
  return true;
}

// ---------- across threads ----------
// The state as six numbers, for the audio link's call (a Float64Array: the
// anchor is absolute ms and needs every bit of a double).
export const BREATH_PACK = 6;
export function packBreath(s, out) {
  out[0] = s.at; out[1] = s.offset; out[2] = s.r0; out[3] = s.dur; out[4] = s.full; out[5] = s.mode;
  return out;
}
export function unpackBreath(s, a) {
  s.at = a[0]; s.offset = a[1]; s.r0 = a[2]; s.dur = a[3]; s.full = a[4]; s.mode = a[5];
  s.gen++;
}
