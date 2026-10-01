// The pause wind-down: one shared scale, 0 to 1, that every moving thing in
// the scene multiplies its frame step by. While the strobe runs it is 1, so
// nothing changes. When the viewer pauses, it eases from 1 to 0 over
// S.pauseWindDown seconds (Render > Pause wind-down), and the tunnel, the
// edge, the colour walk and every layer coast to a stop instead of freezing
// on the spot. A setting of 0 drops it to 0 at once, the hard stop of before.
// A resume puts it straight back to 1.
//
// The ease is (1 - u)^2 over the wind-down's share u of its time: the speed
// falls off quickest at first and then settles gently onto zero, so the last
// of the motion is the slowest and nothing lands with a jolt.
//
// motionTick runs once a frame from the frame loop (main.js), which is the
// engine's own loop, so in worker mode this lives in the worker alongside
// everything that reads it. S.running is read directly by the other helpers,
// so a start or stop made partway through a frame (a click on the field
// during the UI build) is seen by every step after it in that same frame: a
// resume moves at full speed at once, and a pause starts coasting from full
// speed rather than from wherever the scale was.
//
// This scales motion only. Whether the app is running, for the audio, the
// panel guard, the frame lock, the lit log and the hint, stays S.running.

import { S } from '../js/state.js';

// 0 at boot: nothing has moved yet, so there is nothing to wind down.
let scale = 0;
let wasRunning = false;
let elapsed = 0;

export function motionTick(dt) {
  if (S.running) { scale = 1; wasRunning = true; return; }
  // The first frame after a stop starts the clock from zero.
  if (wasRunning) { wasRunning = false; elapsed = 0; }
  if (scale <= 0) return;
  const T = S.pauseWindDown;
  if (!(T > 0)) { scale = 0; return; }
  if (dt > 0) elapsed += dt;
  const u = elapsed / T;
  if (u >= 1) { scale = 0; return; }
  const k = 1 - u;
  scale = k * k;
}

// A stop for safety (the panel guard, the second clock) is a hard stop, the
// way it always was: the scale goes to 0 at once, so the strobe's flicker
// ends on the spot rather than easing out after it was judged a risk.
export function motionHalt() {
  scale = 0;
  wasRunning = false;
}

// The current scale: 1 while running, else the wind-down's.
export function motionScale() {
  return S.running ? 1 : scale;
}

// This frame's step for anything that moves: dt while running, dt times the
// scale while winding down, 0 once stopped.
export function motionStep(dt) {
  return S.running ? dt : dt * scale;
}

// Paused, but still coasting to a stop.
export function winding() {
  return !S.running && scale > 0;
}
