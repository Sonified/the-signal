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
// (sunBreath), its one writer (steerBreath), the voices' read of it
// (breathHeardAt) and its trip across threads (packBreath, unpackBreath).
// Like signal.js it imports nothing, so the js/ audio modules can share it
// as they share variance.js.
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
// the sound reads it at its own times: core/sun-hum-vary.js for the hum, and
// the music variances linked to it (js/choir.js's level, Stack and Density,
// js/piano.js's drone level) through breathHeardAt, on their 10 Hz ticks.
// None of the sound reads the frame's gauge, so a hidden tab, whose frames
// stop, leaves none of it parked. In worker mode the page keeps its own copy
// of this module and of sunBreath; the worker's audio link
// (core/audio-link.js) sends the packed state across whenever it changes (a
// rate moved, a pause, a resume), which is rarely, and between changes the
// two threads are each evaluating the same law.

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

// The breath as a music variance linked to it hears it: this thread's breath
// at t (absolute ms on the shared clock) while the Sun layer is on, and
// undefined while it is off, which core/variance.js variedBy reads as no
// breath, the setting held. The breath keeps its time with the layer off
// (main.js steers it all the same), but the voices never followed a breath
// the screen was not drawing: the gauge they read before was the frame's,
// cleared to undefined as the layer went off, and this is that rule as a
// formula, read at the voice's own moment on the voice's own thread (in
// worker mode the page's copy, as the link last unpacked it). S is passed
// in rather than imported, so this file still imports nothing.
export function breathHeardAt(S, t) {
  return S.layers && S.layers.sun ? breathPosAt(sunBreath, t) : undefined;
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

// ---------- in a broadcast room ----------
// Two screens at the same rate still breathe at unrelated points of the
// cycle, because each one's anchor is wherever its own writer last folded.
// The room fixes that the way it fixes the strobe (core/strobe.js applySync):
// the broadcaster's beacon carries its breath phase and running rate,
// stamped with the shared time, and a follower bends its own breath toward
// where that says the breath is now. Rates are already the same (they ride
// the settings), so the two formulas only need their offsets to agree, and
// from then on they keep time with no further messages.
//
// The pull is a slew, never a jump (the sun swells with the phase and the
// hum's filter follows it): the offset moves by the phase error x
// SYNC_RATE a second, held to SYNC_BEND of the breath's own rate, so the
// breath is a little quicker or slower for a few breaths and lands on the
// shared phase. Only the first beacon of a joining screen lands in one
// step, as it has no breath to disturb yet. Nothing pulls while the scene
// is paused or winding down (the formula holds still there, as the room's
// swings do), when the beacon is stale, or when the viewer has taken this
// screen's rate off the broadcaster's (a pull would bend it for good).
const SYNC_RATE = 0.8, SYNC_BEND = 0.4, SYNC_STALE_S = 8, SYNC_RATE_TOL = 0.02;
let syncOn = false, syncFresh = false;
let syncAt = 0, syncPh = 0, syncHz = 0;   // the beacon: shared ms, phase then, rate then (Hz)
let syncClockOff = NaN;                   // shared ms minus this tab's rAF ms

export function setBreathClockOffset(off) { syncClockOff = Number.isFinite(off) ? off : NaN; }
export function setBreathSyncTarget(at, phase, hz) {
  if (!syncOn) syncFresh = true;
  syncAt = at; syncPh = phase; syncHz = hz;
  syncOn = true;
}
export function clearBreathSync() { syncOn = false; syncFresh = false; }

// The beacon's side: this thread's breath at tRaf (the page's rAF ms), as the
// beacon carries it, or null when the breath is not running a steady rate
// (a pause, or a wind-down, has nothing for a follower to be set against).
export function breathBeacon(s, tAbs) {
  if (s.mode !== BREATH_RUN || !(s.full > 0)) return null;
  return { ph: breathPhaseAt(s, tAbs), hz: s.full };
}

// The follower's side, once a frame after steerBreath: tAbs is the frame on
// the signal timeline (as steerBreath gets it), tRaf the same moment as the
// rAF time the room clock's offset is against, dt the frame's seconds.
export function syncBreath(s, tAbs, tRaf, dt) {
  if (!syncOn || syncClockOff !== syncClockOff) return;
  if (s.mode !== BREATH_RUN || !(syncHz > 0)) return;
  if (Math.abs(s.full - syncHz) > syncHz * SYNC_RATE_TOL) return;
  const el = (tRaf + syncClockOff - syncAt) / 1000;
  if (el < 0 || el > SYNC_STALE_S) return;
  let err = syncPh + el * syncHz - breathPhaseAt(s, tAbs);
  err -= Math.round(err);
  if (syncFresh) {
    syncFresh = false;
    s.offset += err; s.gen++;
    return;
  }
  const cap = syncHz * SYNC_BEND;
  let bend = err * SYNC_RATE;
  bend = bend > cap ? cap : bend < -cap ? -cap : bend;
  if (Math.abs(err) < 1e-5) return;
  s.offset += bend * (dt < 0.1 ? dt : 0.1);
  s.gen++;
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
