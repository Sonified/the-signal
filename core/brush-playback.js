// The receiver's playback cursor for a remote brush stroke, pure. A stroke
// from the hall or the broadcast arrives a batch at a time (every 45 ms,
// touch/strokes.js), so stamping each batch the moment it lands moves the
// ribbon forward in jumps. Instead every stamp is placed as before
// (core/brush-stamps.js, so the figure is exactly the sender's) but held
// until a cursor that glides after the received end passes it.
//
// The cursor counts stamps: stamp k of a stroke (its copies with it) is
// shown once the cursor reaches k. The end is how far the stroke has come,
// in the same count (the received arc length over the spacing, or the last
// print's number for a slowed stroke), and the cursor follows end + LEAD
// through PLAY_STAGES exponential stages in a row, each
//   c += (in - c) * (1 - exp(-dt / PLAY_TAU_S)),
// a cascade rather than one stage because one stage's speed still pulses
// with every batch (2.6 times from slowest to fastest at a 45 ms tau,
// simulated at 120 Hz), three of 20 ms bring that to 1.4 for about 70 ms of
// lag in all (unsmoothed, a batch's stamps wait 22 ms on average: some 50
// ms more). Each stage follows a rising input from below, so the cursor
// never steps back. LEAD, half a stamp past the end, makes the last stamp
// shown in bounded time rather than only as the cursor's approach
// approaches it.

export const PLAY_TAU_S = 0.02;
export const PLAY_STAGES = 3;
export const PLAY_LEAD = 0.5;

// One frame: c the stages (a Float64Array of PLAY_STAGES, or a slice of a
// larger one at offset o), end the stroke's end, dt seconds. Returns the
// cursor, the last stage.
export function playStep(c, o, end, dt) {
  const k = dt > 0 ? 1 - Math.exp(-dt / PLAY_TAU_S) : 0;
  let x = end + PLAY_LEAD;
  for (let i = 0; i < PLAY_STAGES; i++) {
    const v = c[o + i] + (x - c[o + i]) * k;
    c[o + i] = v;
    x = v;
  }
  return x;
}
