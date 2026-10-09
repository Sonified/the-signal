// The still frame's wake-ups. Paused, wound down, with nothing on screen
// left to change, the frame loop stops asking for frames (main.js decides,
// gpu/engine.js sleep) and the canvas goes on showing the last one. From
// then on nothing runs until something could change the picture, and that
// something says so here: idleWake(why) from anywhere on the engine's
// thread brings the loop back for at least a frame, and main.js lets it
// rest again once the picture is still.
//
// Input, a resume, a resize and the page coming back into view are wired
// in main.js and the engine. The rest come from the modules that know: a
// setting saved (core/store.js), a broadcast message arriving
// (core/broadcast.js), another tab's write (main.js).
//
// Work that finishes later, off the frame loop (a sprite sheet decoding, an
// atlas building), holds the loop awake while it runs: idleHold() when it
// starts, idleRelease(why) when it ends, done or failed, which also wakes
// the loop so the result is drawn.
//
// ?idlediag=1 in the page's address logs each rest and each wake with its
// reason, and a heartbeat each minute of rest (main.js). Page mode only, as
// the other diagnostics; one boolean when off.

export const IDLE_DIAG = (() => { try { return /[?&]idlediag=1(&|$)/.test(location.search); } catch (e) { return false; } })();

let waker = null;
let holds = 0;

// main.js hands over what a wake does, once the engine exists.
export function setIdleWaker(fn) { waker = fn; }

export function idleWake(why) { if (waker) waker(why); }

export function idleHold() { holds++; }
export function idleRelease(why) {
  if (holds > 0) holds--;
  idleWake(why);
}
export function idleHeld() { return holds > 0; }
