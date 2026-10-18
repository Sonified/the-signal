// The Rotational hum's two variances, its Cutoff and its Reverb mix, run
// where the hum is. Each dips its setting by core/variance.js's one law
// (variedBy): set x (1 - amount x (1 - d)), d from its Drive, 1 at the
// driver's top and 0 at its bottom:
//
//   Time     the variance's own cosine, its phase stepped by the time that
//            passes over its period (scaled by the pause, below), and pulled
//            onto the broadcast room's clock in a room (core/room-clock.js)
//   Strobe   the strobe's wave, the signal's formula at this moment
//            (core/signal.js valueAt), 1 while no flicker shows
//   Breath   the sun's breath, its formula at this moment (core/breath.js)
//
// Every input is a formula of time or a phase stepped on the caller's clock,
// so the variance can be worked out at any moment on any thread, and it is:
// once a frame while frames are drawn, and on a timer when they are not.
// That is the point of it living here rather than in the renderer's frame.
// A hidden tab stops its frames (the filter parked wherever the last one
// left it while the hum played on), and a heavy frame (the sun's video
// decoding) stepped the filter coarsely enough to hear; the timer
// (js/ticker.js, whose clock runs in a worker of its own, so a hidden page's
// throttling does not reach it) fills every gap longer than STALE_MS at
// TICK_MS, and each push glides there over the time since the last one, so
// the filter moves as smoothly at 20 a second as at 60.
//
// The pause: Time's phase steps by the elapsed time times the breath's pause
// scale (breath.js breathScaleAt), which is the motion's wind-down
// (core/motion.js) carried in the breath's formula, so a paused scene's hum
// eases its variances to a stop with the screen's, on a thread that runs no
// motion of its own (the page in worker mode) as on one that does.
//
// Who calls it. stepHumVary(t) runs once a frame from the engine's loop
// (main.js), in main mode and in worker mode's worker alike, and from the
// page's audio frame in worker mode (core/audio-shell.js tick). In the
// worker it only publishes S.effSunHumCutoff and S.effSunHumVerb, which
// light the drawer's two bars there; the pushes into the hum are no-ops
// (core/sun-hum.js has no AudioContext in a worker). On the page and in main
// mode it publishes the same and moves the sound. The two threads read the
// same formulas, so the worker's bars and the page's filter agree; only
// Time's stepped phase is each thread's own (and the room's pull the
// worker's alone, since the room lives there).
//
// The effectives are published while the layer is on and the variance's
// amount above 0, undefined otherwise, and cleared once when the Sun layer
// goes off, as the renderer did. Time's phase steps only while the layer is
// on, as it did there.

import { S } from '../js/state.js';
import { SIGNAL_ORIGIN, signal, valueAt } from './signal.js';
import { sunBreath, breathPosAt, breathScaleAt, BREATH_STOP } from './breath.js';
import { variedBy } from './variance.js';
import { roomPhase, roomPhaseState } from './room-clock.js';
import { setCutoffHz, cutoffHz, setReverbMix, humAvailable } from './sun-hum.js';
import { every, clear, walkAhead } from '../js/ticker.js';

// The timer's cadence, and how recent a step must be for a tick to leave it
// to the frames (a 60 Hz frame is 17 ms; anything slower than 25 a second
// is a gap the timer fills).
const TICK_MS = 50, STALE_MS = 40;
// A gap longer than this (a laptop asleep) is an absence: Time steps nothing
// over it, as the strobe's own clock does.
const GAP_S = 5;
// The longest glide a push asks for. The timer's own clock keeps it at
// TICK_MS hidden or not; where that clock cannot be had, the page's own
// timers stand in (js/ticker.js) and a hidden page's are throttled to about
// one a second, which a glide this long still bridges smoothly.
const GLIDE_MAX = 1;

function clampNum(v, lo, hi, def) {
  if (typeof v !== 'number' || !(v === v)) return def;
  return v < lo ? lo : (v > hi ? hi : v);
}

// The two variances: the setting's key and default, the effective's key, the
// push into the hum with its shortest glide (the hum's own: 10 ms for the
// filter, 30 ms for the wet/dry pair), and Time's phase with its room
// bookkeeping.
const VARS = [
  { key: 'sunHumCutoff', def: 0.25, eff: 'effSunHumCutoff', glide: 0.01, phase: 0, room: roomPhaseState(),
    push: (v, tau) => setCutoffHz(cutoffHz(v), tau) },
  { key: 'sunHumVerb', def: 0.3, eff: 'effSunHumVerb', glide: 0.03, phase: 0, room: roomPhaseState(),
    push: (v, tau) => setReverbMix(v, tau) }
];

// The absolute time the variances were last stepped at (-1 before the
// first), whether the layer was on then, and the timer's handle.
let at = -1, wasOn = false, timer = 0;

// t is this thread's ms (a frame's rAF time, or performance.now), the
// timeline core/signal.js adds SIGNAL_ORIGIN to.
export function stepHumVary(t) {
  const tAbs = SIGNAL_ORIGIN + t;
  // Behind the last step: a walked tick (js/ticker.js, the idle render-ahead)
  // has already planned past this moment, so there is nothing to add.
  if (at >= 0 && tAbs < at) return;
  let dt = at >= 0 ? (tAbs - at) / 1000 : 0;
  if (dt > GAP_S) dt = 0;
  at = tAbs;
  syncHumVary();
  if (!(S.layers && S.layers.sun)) {
    if (wasOn) {
      wasOn = false;
      for (let i = 0; i < VARS.length; i++) S[VARS[i].eff] = undefined;
    }
    return;
  }
  wasOn = true;
  const md = dt * breathScaleAt(sunBreath, tAbs);
  const lum = signal.on ? valueAt(signal, tAbs) : 1;
  const pos = breathPosAt(sunBreath, tAbs);
  const glide = dt < GLIDE_MAX ? dt : GLIDE_MAX;
  for (let i = 0; i < VARS.length; i++) {
    const v = VARS[i], k = v.key;
    const period = Math.max(0.5, clampNum(S[k + 'VarPeriod'], 0, 120, 20));
    v.phase += md / period;
    v.phase -= Math.floor(v.phase);
    v.phase = roomPhase(v.room, v.phase, t, md, period, S[k + 'VarPeriodOff'] || 0);
    const amount = clampNum(S[k + 'Var'], 0, 1, 0);
    const val = variedBy(S[k + 'VarDrive'], clampNum(S[k], 0, 1, v.def), amount, v.phase, lum, pos);
    S[v.eff] = amount > 0 ? val : undefined;
    v.push(val, glide > v.glide ? glide : v.glide);
  }
}

// The timer runs while the hum can sound here and is asked for: its switch
// and the Sun layer on (core/schema-sun.js syncHum's own condition), on a
// thread with an AudioContext, and while anything can move: the scene
// running or still winding down. Stopped, the pause gate has closed on the
// hum, the breath and Time's phase both hold, and the strobe shows no
// flicker, so there is nothing to follow and nothing to wake the page for;
// the resume's first frame starts it again. Called by every frame's step,
// by syncHum, and by the tick itself, which ends it once it is not wanted.
export function syncHumVary() {
  const need = humAvailable() && !!S.sunHumOn && !!(S.layers && S.layers.sun) &&
    (!!S.running || sunBreath.mode !== BREATH_STOP);
  if (need && !timer) timer = every(TICK_MS, humVaryTick);
  else if (!need && timer) { clear(timer); timer = 0; }
}

// A walked tick (the idle render-ahead fires the timers early, js/ticker.js)
// steps at the moment it stands for, which the formulas make exact; an
// ordinary one only when no frame has stepped within STALE_MS.
function humVaryTick() {
  const ahead = walkAhead();
  const t = performance.now() + ahead * 1000;
  if (!ahead && at >= 0 && SIGNAL_ORIGIN + t - at < STALE_MS) { syncHumVary(); return; }
  stepHumVary(t);
}
