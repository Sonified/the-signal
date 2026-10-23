// The receiver's playback of a remote brush stroke, pure. A stroke from the
// hall or the broadcast arrives a batch at a time (every 30 ms,
// touch/strokes.js), each point stamped with the sender's own clock (the
// wire's q). Every stamp is placed exactly as before (core/brush-stamps.js,
// so the figure is the sender's to the bit); only when it appears is
// decided here.
//
// The timeline. A stroke is played on the sender's timeline, late by a
// fixed amount: a point the sender made at its time s is shown at local
// time s + offset + delay. offset maps the sender's clock onto this one,
// with no clock protocol at all: it is the least (arrival here - the
// batch's last point's time) over every batch from that sender
// (minOffset), so it rides the fastest delivery there has ever been, and
// the rest of the delay is the allowance for everything slower. delay
// starts at DELAY0_MS: a batch's span (its first point waited that long
// for the flush) plus JITTER_MS for the network's moods, so a stroke is
// drawn about the one-way trip plus 60 ms behind the hand, at the hand's
// own pace, point to point, the cursor interpolated along the sender's
// timeline between them (timelineAt).
//
// Late means ratchet. A batch whose first new point's play time has
// already gone by when it arrives came later than the delay allowed: the
// cursor had stopped at the last point it had, waiting, and the delay goes
// up by exactly how late the point is (ratchetDelay), so play resumes from
// where it stopped, and it never comes back down in the session. A delay
// that starved once is not probed again. A hand held still sends nothing
// and is not late: its next point carries the later time it was made at.
//
// A stroke without times (an older sender or tape) is glided instead: a
// cursor following its received end through PLAY_STAGES exponential stages
// of PLAY_TAU_S (playStep), three of 20 ms, about 70 ms behind with its
// speed steady within 1.4 times, where one stage pulsed 2.6 times with
// every batch. LEAD, half a stamp past the end, lets its last stamp out in
// bounded time.

export const BATCH_MS = 30, JITTER_MS = 30;
export const DELAY0_MS = BATCH_MS + JITTER_MS;
export const DELAY_MAX_MS = 2000;

// The sender-to-here offset after one more batch: arrival here (ms, this
// clock) less the sender's time of the batch's last point, the least yet.
export function minOffset(off, arrival, senderT) {
  const o = arrival - senderT;
  return off === off && off <= o ? off : o;   // NaN (none yet) takes the first
}

// The play time of `now` on the sender's clock.
export function playTime(now, off, delay) {
  return now - off - delay;
}

// The delay after a batch whose first new point (sender time firstT)
// arrived when play had reached P: raised by the lateness, never lowered,
// held to DELAY_MAX_MS.
export function ratchetDelay(delay, P, firstT) {
  const late = P - firstT;
  if (!(late > 0)) return delay;
  const d = delay + late;
  return d < DELAY_MAX_MS ? d : DELAY_MAX_MS;
}

// Where the cursor stands at sender time P on a timeline of n points
// (times ascending, pos the stroke's stamp count at each), searching from
// point i0 on. out.i is the segment's first point, for the next frame to
// start from; before the first point nothing is due yet (a count just
// short of the first point's), past the last it holds at the last (waiting
// for more).
export function timelineAt(times, pos, n, i0, P, out) {
  if (n <= 0) { out.i = 0; return -1; }
  let i = i0 > 0 ? (i0 < n ? i0 : n - 1) : 0;
  while (i + 1 < n && times[i + 1] <= P) i++;
  out.i = i;
  if (i === 0 && P < times[0]) return pos[0] - 0.5;
  if (P <= times[i] || i + 1 >= n) return pos[i];
  const span = times[i + 1] - times[i];
  if (!(span > 0)) return pos[i + 1];
  return pos[i] + (pos[i + 1] - pos[i]) * ((P - times[i]) / span);
}

// ---------- the glide, for strokes without times ----------
export const PLAY_TAU_S = 0.02;
export const PLAY_STAGES = 3;
export const PLAY_LEAD = 0.5;

// One frame: c the stages (a Float64Array, from offset o), end the
// stroke's received end, dt seconds. Returns the cursor, the last stage.
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
