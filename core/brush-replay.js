// The show's playback (the controller's cue 24): everything the room drew
// since the show's first drawing cue, played back on the main screen on a
// loop, through the very brush that drew it live. The tape is the hall's
// recording (broadcast-worker/src/index.js, every stroke as { at, id, s }:
// ms since the hall's epoch, the drawer, the stroke as said), kept on the
// presentation screen as the show goes (platform/show-tape.js), so the
// loop never waits on a download.
//
// One pass is the whole tape on its common timeline, everyone at once,
// squeezed to fit LOOP_MS when it ran longer (the replay page's together
// movement and its rule: compression only ever speeds a drawing up, never
// stretches a short one into slow motion), then LOOP_REST_MS of rest while
// the last marks land, and round again. Each pass is planned afresh from
// the tape as it stands, so strokes drawn during the playback join the
// next pass.
//
// A stroke's own points carry its sender's times (touch/strokes.js q), and
// the brush plays each stroke on them (core/brush.js brushTake), so a
// squeezed pass squeezes those too: retime lays each batch's points on
// this screen's clock, the batch's last point at its moment in the pass,
// the ones before it closer by the same scale. Each drawer plays under a
// key of its own (REPLAY_ID + its id), never sharing a slot or a clock
// offset with that drawer's live strokes.
//
// Pure: tape in, plans and messages out (tools/brush-replay.test.mjs).

import { TOGETHER_MS } from '../touch/replay.js';

export const LOOP_MS = TOGETHER_MS;
export const LOOP_REST_MS = 2000;
export const REPLAY_ID = 100000;

// The pass over `entries` (the tape's, oldest first): { steps, scale, ms },
// steps [{ tMs, id, s }] from the pass's zero, ms the pass's length with its
// rest. Entries without a time, a drawer or a stroke are skipped.
export function planPass(entries, loopMs = LOOP_MS, restMs = LOOP_REST_MS) {
  const good = [];
  for (const e of entries || []) {
    if (e && typeof e.at === 'number' && typeof e.id === 'number' && e.s && e.s.t === 's') good.push(e);
  }
  if (!good.length) return { steps: [], scale: 1, ms: 0 };
  const t0 = good[0].at, span = good[good.length - 1].at - t0;
  const scale = span > 0 ? Math.min(1, loopMs / span) : 1;
  const steps = good.map(e => ({ tMs: (e.at - t0) * scale, id: e.id, s: e.s }));
  return { steps, scale, ms: span * scale + restMs };
}

// A step as the message brushTake plays: the stroke under the drawer's
// replay key, its points' times (when it carries them) laid on this
// screen's clock with its last point at `base` and the rest `scale` as far
// apart as they were drawn. Whole ms, as the wire wants: each point's time
// rounded, the gaps taken between the rounded times, so none drifts.
export function retime(step, base, scale) {
  const s = step.s, msg = Object.assign({}, s, { id: REPLAY_ID + step.id });
  const q = s.q;
  if (!Array.isArray(q) || !q.length) { delete msg.q; return msg; }
  const T = new Array(q.length);
  T[0] = q[0];
  for (let j = 1; j < q.length; j++) T[j] = T[j - 1] + q[j];
  const last = T[q.length - 1], q2 = new Array(q.length);
  let prev = 0;
  for (let j = 0; j < q.length; j++) {
    const a = Math.max(0, Math.round(base - (last - T[j]) * scale));
    q2[j] = j ? a - prev : a;
    prev = a;
  }
  msg.q = q2;
  return msg;
}
