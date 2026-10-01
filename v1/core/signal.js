// The strobe signal: one law, written once, that says how lit the strobe is
// at any moment, and that the screen and the sound both read. The flash is
// not a thing one side runs and the other chases. It is a formula of time:
//
//   phase(t) = (offset + cycles since the anchor) mod 1
//   value(t) = shape(phase(t))        1 lit, 0 dark
//
// where the cycles since the anchor are rate x (t - at), with t on one
// clock that every thread can read (below), and shape is the strobe's wave:
// a raised cosine, a triangle, or a square lit for the first `duty` of the
// cycle. Anything that wants to know whether the strobe is lit at time t
// works it out from these few numbers, and two readers handed the same
// numbers can only agree.
//
// That is all this file is: the law (waveShape, phaseAt, valueAt, rateAt),
// the one state it reads (signal), and the few ways that state may be
// changed (retimeSignal, pinSignal, steerSignal, setSignalShape). It imports
// nothing, so the js/ audio modules share it with v1 as they are, as they
// share core/variance.js.
//
// ---------- who reads it ----------
// The strobe core (core/strobe.js) is the one writer, and the field is its
// first reader: each frame's phase is phaseAt(the frame's time), and the lum
// every strobing layer flickers by is the shape at that phase. Under frame
// lock the screen can only show whole frames, so there the frame counter
// keeps the exact lit/dark pattern and the signal is pinned onto its grid
// (strobe.js says how): either way the flash on the screen and the formula
// are the same thing.
//
// The sound is the second reader. Every Vary with strobe stage (js/strobe-
// am.js, the drone, the choir, the clouds and the sequencer's own) taps one
// AudioWorklet node, 'strobe-signal' in js/worklet.js, which runs this same
// formula at every sample's own time and puts out 2 x value - 1, +1 lit and
// -1 dark. It is told the state only when the state changes (strobe-am.js
// posts it, onSignal below), never a stream of phase corrections, so between
// changes the sound and the screen are each simply evaluating the same law.
// The worklet cannot share this file (js/worklet.js says why) and keeps its
// own copy of phaseAt, rateAt and waveShape, which must be kept in step with
// these.
//
// The entrainment engine itself is the third reader: the 'genus' processor
// in js/worklet.js, whose one phase drives the tone, the harmonics and the
// pips. strobe-am.js hands it the same numbers on the same changes, with
// whether the pulse is linked to the visual (S.amLinked). Linked, its phase
// is steered sample by sample onto this formula's, shifted so the loud part
// of the pulse falls on the lit part of the flash (flashAlign there), and a
// jump in the formula (a pin, a change of wave, the link switched on) is
// glided across rather than heard. Free, it ignores the formula and runs at
// its own rate.
//
// In worker mode (core/engine-thread.js) the writer lives in the engine's
// worker and the sound on the page. Each thread has its own copy of this
// module and of `signal`; the worker's audio link (core/audio-link.js) sends
// the packed state across whenever it changes (packSignal, unpackSignal),
// and the page's copy then feeds the worklet exactly as main mode's does.
//
// ---------- the clock ----------
// Every t here is absolute milliseconds: the thread's performance.timeOrigin
// plus its performance.now(), or a frame's rAF time, which is on that same
// timeline (SIGNAL_ORIGIN + t). Each thread has its own time origin, but the
// sum is the same clock on all of them, the one the worker bridge already
// moves input times across on, so an anchor set in the worker means the same
// instant on the page. The audio clock (AudioContext.currentTime) is a third
// clock again; js/strobe-am.js places it on this one and hands the worklet
// the anchor in its own seconds.
//
// The anchor (`at`, `offset`) is what keeps a change of rate from jumping
// the phase, exactly as the room clock's offset does for the broadcast
// room's swings (core/room-clock.js retimeRoomPhase). A new rate is folded in
// at the moment it lands: the anchor moves to now and the offset becomes the
// phase the old numbers gave now, so the formula carries on from where it is
// at the new rate. A drag folds on every step and the steps telescope.
//
// ---------- a rate that is moving ----------
// The strobe's rate is not always still: a preset glides it, the frequency
// drift swings it, a follower bends it onto the broadcaster's phase. So the
// formula carries one more thing besides a rate: a straight ramp of it, from
// r0 at the anchor to r1 `dur` seconds later, held at r1 after that. With
// dur 0 it is the plain formula at rate r0. Integrated, the cycles since the
// anchor at tau seconds are
//
//   r0 tau + (r1 - r0) tau^2 / 2dur          while tau < dur
//   (r0 + r1) dur / 2 + r1 (tau - dur)       after
//
// which is still nothing but a formula of time, and one a reader can run
// with no help. steerSignal is how the writer uses it: handed the rate it
// wants each frame, it leaves the formula alone while the formula's own rate
// is within a hair of it (STEER_TOL), and otherwise folds the wanted rate in
// with a ramp along the way that rate has been moving, so a glide is a ramp
// or two and the drift a fold every second or so, not a message a frame.
// The ramp ends and holds, so a reader that stops hearing anything (a tab
// gone to the background) runs on at a steady rate, never off to nowhere.

// The wave as a number, the same on every thread and in the worklet.
export const WAVE_SINE = 0, WAVE_TRIANGLE = 1, WAVE_SQUARE = 2;
export function waveCode(name) {
  return name === 'square' ? WAVE_SQUARE : name === 'triangle' ? WAVE_TRIANGLE : WAVE_SINE;
}

// The shape: how lit the strobe is at phase p, 0 to 1. js/util.js's shape()
// is this with the strobe's own wave and duty from S.
export function waveShape(wave, duty, p) {
  if (wave === WAVE_SQUARE) return p < duty ? 1 : 0;
  if (wave === WAVE_TRIANGLE) return p < 0.5 ? p * 2 : 2 - p * 2;
  return 0.5 * (1 - Math.cos(2 * Math.PI * p));
}

// This thread's time origin, so that SIGNAL_ORIGIN + a rAF time (or + the
// performance.now() the frame's time is on) is the shared absolute clock.
export const SIGNAL_ORIGIN = typeof performance !== 'undefined' ? performance.timeOrigin : 0;
export const signalNow = () => SIGNAL_ORIGIN + performance.now();

// The state the law reads:
//   at        the anchor, absolute ms
//   offset    the phase at the anchor, 0 to 1
//   r0, r1    the rate at the anchor and at the end of its ramp, Hz
//   dur       the ramp's length in seconds, 0 for a steady rate (r1 = r0)
//   wave      WAVE_*; duty the square's lit share of the cycle
//   on        whether the flicker shows at all; a reader holds lit when not
//   gen       bumped by every change, so a reader can tell it has moved
//   driven    whether a writer has ever set it (js/strobe-am.js steers it
//             itself from S while nothing does, which is v0)
//   wt, wv    steerSignal's memory of the last rate it was handed and when
export function signalState() {
  return {
    at: SIGNAL_ORIGIN, offset: 0, r0: 7.5, r1: 7.5, dur: 0,
    wave: WAVE_SQUARE, duty: 0.5, on: false, gen: 0, driven: false, wt: NaN, wv: NaN
  };
}

// The one signal of this thread.
export const signal = signalState();

// ---------- the law ----------
// Cycles since the anchor, tau seconds after it. Before the anchor (a reader
// whose clock sits a hair behind the writer's) it runs back at r0.
function cyclesAt(s, tau) {
  if (tau <= 0 || !(s.dur > 0)) return s.r0 * tau;
  if (tau < s.dur) return s.r0 * tau + (s.r1 - s.r0) * tau * tau / (2 * s.dur);
  return (s.r0 + s.r1) * 0.5 * s.dur + s.r1 * (tau - s.dur);
}

export function phaseAt(s, t) {
  const x = s.offset + cyclesAt(s, (t - s.at) / 1000);
  return x - Math.floor(x);
}

export function rateAt(s, t) {
  const tau = (t - s.at) / 1000;
  if (tau <= 0 || !(s.dur > 0)) return s.r0;
  return tau < s.dur ? s.r0 + (s.r1 - s.r0) * tau / s.dur : s.r1;
}

export function valueAt(s, t) {
  return waveShape(s.wave, s.duty, phaseAt(s, t));
}

// ---------- changing it ----------
// Folds a new rate in at t: from t on the formula runs at r0, ramping to r1
// over dur seconds (dur 0: steady at r0), and its phase at t is the one the
// old numbers gave, so it carries on rather than jumping.
export function retimeSignal(s, t, r0, r1 = r0, dur = 0) {
  const p = phaseAt(s, t);
  s.at = t; s.offset = p;
  s.r0 = r0;
  if (dur > 0) { s.r1 = r1; s.dur = dur; } else { s.r1 = r0; s.dur = 0; }
  s.gen++;
}

// Sets the phase at t outright, at a steady rate: the one deliberate jump,
// for when the phase has to be somewhere else (frame lock's grid, a
// follower landing on the broadcaster's phase after a wake).
export function pinSignal(s, t, phase, rate) {
  s.at = t; s.offset = phase - Math.floor(phase);
  s.r0 = rate; s.r1 = rate; s.dur = 0;
  s.gen++;
}

// The wave, the duty and whether the flicker shows; a change bumps gen.
export function setSignalShape(s, wave, duty, on) {
  on = !!on;
  if (s.wave === wave && s.duty === duty && s.on === on) return;
  s.wave = wave; s.duty = duty; s.on = on;
  s.gen++;
}

// How far the formula's rate may sit from the wanted rate before steerSignal
// folds the wanted one in: two thousandths of a hertz plus a thousandth of
// the rate, a fraction of a per cent anywhere the strobe runs.
const STEER_TOL_HZ = 0.002, STEER_TOL = 0.001;
// The ramp a fold lays down, along the way the wanted rate has been moving:
// this long, and only for a rate moving no faster than MAX_SWEEP Hz a second
// (a preset's widest glide is about forty). Faster than that is a step (a
// dragged slider, the glide's one stride across the risk band) and lands as
// a steady rate.
const SWEEP_S = 1, MAX_SWEEP = 60;

// Keeps the formula on the rate the writer wants, `want` at t, with as few
// changes as it can: none while the formula's own rate is within STEER_TOL
// of it, otherwise one fold with a ramp along the wanted rate's slope since
// the last call. avoidLo and avoidHi, when given, are a band of rates a ramp
// must not carry the formula into from outside (the photosensitive band a
// glide skips, core/strobe.js): such a ramp ends at the band's near edge,
// and the formula only enters the band when the wanted rate itself does.
// Returns whether it folded.
export function steerSignal(s, t, want, avoidLo = 0, avoidHi = 0) {
  let slope = 0;
  const dt = (t - s.wt) / 1000;
  if (dt > 0 && dt < 0.25) {
    slope = (want - s.wv) / dt;
    if (slope > MAX_SWEEP || slope < -MAX_SWEEP) slope = 0;
  }
  s.wt = t; s.wv = want;
  const err = rateAt(s, t) - want, tol = STEER_TOL_HZ + STEER_TOL * Math.abs(want);
  if (err <= tol && err >= -tol) return false;
  if (!slope) { retimeSignal(s, t, want); return true; }
  // the ramp keeps the wanted rate's slope, and stops short (sooner, at the
  // same slope) at a band's edge or at a standstill
  let r1 = want + slope * SWEEP_S;
  let edge = NaN;
  if (r1 < 0) edge = 0;
  if (avoidHi > avoidLo) {
    if (want < avoidLo && r1 > avoidLo) edge = avoidLo;
    else if (want > avoidHi && r1 < avoidHi) edge = avoidHi;
  }
  let dur = SWEEP_S;
  if (edge === edge) { r1 = edge; dur = (edge - want) / slope; }
  retimeSignal(s, t, want, r1, dur);
  return true;
}

// ---------- across threads ----------
// The state as eight numbers, for the audio link's call (a Float64Array:
// the anchor is absolute ms and needs every bit of a double).
export const SIGNAL_PACK = 8;
export function packSignal(s, out) {
  out[0] = s.at; out[1] = s.offset; out[2] = s.r0; out[3] = s.r1; out[4] = s.dur;
  out[5] = s.wave; out[6] = s.duty; out[7] = s.on ? 1 : 0;
  return out;
}
export function unpackSignal(s, a) {
  s.at = a[0]; s.offset = a[1]; s.r0 = a[2]; s.r1 = a[3]; s.dur = a[4];
  s.wave = a[5]; s.duty = a[6]; s.on = !!a[7];
  s.driven = true;
  s.gen++;
}

// ---------- telling the readers ----------
// A reader that keeps its own copy (the worklet, through js/strobe-am.js)
// registers here, and the writer calls publishSignal once it has made its
// changes for the frame: each listener hears of this thread's signal once
// per change, never once per frame.
const listeners = [];
let publishedGen = -1;
export function onSignal(fn) { listeners.push(fn); }
export function publishSignal() {
  if (signal.gen === publishedGen) return;
  publishedGen = signal.gen;
  for (let i = 0; i < listeners.length; i++) listeners[i](signal);
}
