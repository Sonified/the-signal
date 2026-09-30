// Waking gently: what the app does when it comes back from being away. A
// phone locked in a pocket, a tab left in the background, a laptop lid shut:
// the frame loop simply stops being called, and when it is called again the
// clock has jumped by seconds or hours. This file owns the rule for that
// moment, and it is a photosensitivity rule before it is anything else.
//
// SAFETY RULE, and it is absolute. A return must never burst. Fast flashing
// between roughly 3 and 30 Hz can trigger a seizure in a photosensitive
// viewer, and the dangerous way to wake is to catch up: to replay the missed
// time in one frame, fire every scheduled event that came due while away, or
// sweep a phase through the cycles it missed. Each of those is flashing the
// viewer did not choose. So the app holds its breath instead.
//
// The gap rule. Any frame that arrives more than GAP_MS after the one before
// it advances nothing: the engine hands it a dt of zero, so every
// accumulator holds where it was, and main.js re-anchors every scheduler
// that keeps an absolute due-time (the words, the journey, the performer's
// glides, the strobe's own preset glide) by the time spent away, so each one
// carries on from exactly where it stood with nothing skipped and nothing
// stacked. Alone, the viewer finds the scene exactly as they left it. Inside
// a broadcast room the room's clock really did move on, so everything derived
// from it lands at the room's now in a single step (core/room-clock.js, the
// strobe's beacon sync): a snap reads as one blink, a fast sweep reads as
// flashing. A page coming back into view arms the same resume, so the first
// frame after a wake is caught even if its gap happened to look small, and
// the very first frame of a boot counts as one too, which is what a device
// lost and reloaded looks like.
//
// The umbrella. Whatever the rules above miss, a bug in any of them or one
// not yet written, the strobe's contrast ramps in from nothing over RAMP_S
// after every resume: the gap rule firing, the page coming back into view,
// the first frame of a boot, and a follower's tap into a running stream.
// Not its phase or frequency, its amplitude: whatever the pattern does in
// those seconds, it does it at next to no contrast first. gentleResume()
// starts the ramp; core/strobe.js multiplies wakeRamp() into the one place
// every strobing layer takes its flicker depth from (flickerLum and
// flickerLevel), so it composes with the set depth and never replaces it,
// and the UI, which never strobes, never sees it.
//
// Runtime state only, nothing saved, nothing allocated per frame.

// The gap that counts as having been away. A 60 Hz frame is 17 ms and a
// 120 Hz one 8 ms; a garbage collection pause or a heavy frame costs tens of
// milliseconds, a bad one a hundred. A quarter of a second is well clear of
// all of those and still short enough that any real absence (a hidden tab
// gets no frames at all) is caught. The panel guard (js/panel-guard.js) drops
// its measurement past the same 250 ms, for the same reason.
export const GAP_MS = 250;

// How long the strobe's contrast takes to come back after a resume.
export const RAMP_S = 2;

let armed = false;        // a resume is due on the next frame whatever its gap
let rampPending = false;  // gentleResume was asked; the ramp starts on the next frame's t
let rampT0 = -1;          // t the running ramp began, -1 when none runs
let ramp = 1;             // this frame's contrast factor, 0 to 1

// Starts (or restarts) the contrast ramp. Safe to call from anywhere, any
// time, from inside a frame or from a DOM event between frames: the ramp
// takes its start from the next frame's timestamp, since this module keeps
// time only by the frames it is handed.
export function gentleResume() { rampPending = true; }

// The page has come back into view (platform.onVisibility): the next frame
// is a resume however small its gap.
export function armResume() { armed = true; }

// Asked by the engine once per frame with this frame's timestamp and the
// last one's (null before the first frame). Returns -1 for an ordinary
// frame, or, for a resume, the milliseconds spent away (0 on the first
// frame), which the frame must hold still through and re-anchor by. A
// resume also starts the contrast ramp.
export function wakeGap(t, lastT) {
  if (lastT === null) { armed = false; gentleResume(); return 0; }
  const gap = t - lastT;
  if (gap > GAP_MS || armed) {
    armed = false;
    gentleResume();
    return gap > 0 ? gap : 0;
  }
  return -1;
}

// Once a frame, from the strobe step, before any flicker is worked out.
// The ramp is squared rather than straight: contrast is what the eye reads,
// and the square keeps the first second under a quarter of the set depth,
// so the moments nearest the wake are the quietest.
export function stepWakeRamp(t) {
  if (rampPending) { rampPending = false; rampT0 = t; }
  if (rampT0 < 0) { ramp = 1; return; }
  const u = (t - rampT0) / (RAMP_S * 1000);
  if (u >= 1) { rampT0 = -1; ramp = 1; return; }
  ramp = u > 0 ? u * u : 0;
}

// This frame's contrast factor: 1 except in the seconds after a resume.
export function wakeRamp() { return ramp; }
