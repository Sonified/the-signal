// The viewer's eye: where the head is, relative to the tunnel's axis, for
// head-tracked parallax.
//
// Every layer that projects depth reads the one object below. It is in
// TUNNEL UNITS, the space the particles, confetti and rings live in: the
// tunnel wall sits at radius 1, x runs right and y runs down the screen (as
// the projection has it), and a point at depth z lands on screen at
//
//   screen = centre + (xy - eye) * FOCAL / z,   FOCAL = maxR * Z_NEAR
//
// (Z_NEAR and Z_FAR in js/state.js). So moving the eye is a sideways camera
// move: far things (large z) barely shift, near things shift a lot, and a
// head moving right slides the near things left. At the nearest depth,
// Z_NEAR, an eye of 1 shifts a point by a whole rim radius (maxR).
//
// For now the eye is driven by a simulated head sway (the Render section's
// Parallax sim). Head tracking will later write eye.x and eye.y itself, once
// a frame, instead of stepEye's sway; nothing that reads the eye needs to
// change for that. The frame loop and every layer share one thread (main.js
// runs whole in the worker when the engine does), so a plain module-level
// object is all the sharing it needs.
//
// With the sim off and settled, eye is exactly { x: 0, y: 0 }, and every
// projection that subtracts it gives the same bits it gave before parallax
// existed.

import { S } from '../../js/state.js';

export const eye = { x: 0, y: 0 };

const TAU = Math.PI * 2;
// How fast the sway's size follows its target (the Amount when on, 0 when
// off), seconds: about 95% of the way in three of these, so switching the
// sim on or off, or dragging Amount, eases over some 0.3 s instead of the
// scene jumping sideways.
const EASE_TC = 0.1;
// Below this the sway has finished easing out and is set to exactly 0.
const SETTLED = 1e-5;

// amp: the sway's current peak (tunnel units), easing toward target.
// phase: how far through its cycle the sway is, in cycles, kept in [0, 1).
let amp = 0, target = 0, phase = 0;

// Steps the eye once a frame (main.js, straight after the pause wind-down's
// tick). dt is the frame's wall-clock seconds, NOT the scene's travel clock,
// so the head keeps swaying while the scene is paused, which is the easiest
// way to see the parallax. The phase is accumulated rather than taken from
// sin(TAU * speed * t), so moving the Head speed slider changes the pace
// without the head jumping to a new place.
export function stepEye(dt) {
  const on = S.parallaxSim === true;
  const a = S.parallaxAmount, f = S.parallaxSpeed;
  const amount = (typeof a === 'number' && isFinite(a)) ? Math.max(0, Math.min(0.3, a)) : 0.1;
  const speed = (typeof f === 'number' && isFinite(f)) ? Math.max(0.05, Math.min(2, f)) : 0.25;
  target = on ? amount : 0;
  // A gap (tab away, a stall) is not a reason for the head to lurch.
  const step = dt > 0 && dt < 0.25 ? dt : 0;
  amp += (target - amp) * (1 - Math.exp(-step / EASE_TC));
  if (target === 0 && amp < SETTLED) {
    // Settled still: exactly 0, and the next start begins from the middle.
    amp = 0;
    phase = 0;
    eye.x = 0;
    eye.y = 0;
    return;
  }
  phase += speed * step;
  phase -= Math.floor(phase);
  eye.x = amp * Math.sin(TAU * phase);
  eye.y = 0;
}

// The largest |eye| (tunnel units) that can happen while the current
// settings hold: the sway's Amount while it is on, and while it eases out
// whatever is left of it. For overscan margins: a layer trimmed to the
// visible screen widens its trim by eyeMax() * FOCAL / z device px at depth
// z, so nothing pops in at the edge when the head leans. 0 exactly with the
// sim off and settled. It also covers an eye written from outside (head
// tracking) by never reporting less than where the eye is now.
export function eyeMax() {
  const now = Math.hypot(eye.x, eye.y);
  const sway = amp > target ? amp : target;
  return now > sway ? now : sway;
}
