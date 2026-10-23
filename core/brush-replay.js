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
// A pass begins where the room arrives, not at the mark. Robert rehearses
// on the very tape the show plays from, and alone he never has more than
// three hands drawing at once (his phones and the laptop), so the first
// moment more than three drawers have each sent a stroke within a minute
// and a half is the room drawing together, and the pass starts at the
// earliest stroke of that stretch, every arriving hand's lead-in with it.
// A tape that never gets there (Robert testing the playback alone) plays
// whole from the mark, as it always did.
//
// Pure: tape in, plans and messages out (tools/brush-replay.test.mjs).

import { TOGETHER_MS } from '../touch/replay.js';

export const LOOP_MS = TOGETHER_MS;
export const LOOP_REST_MS = 2000;
export const REPLAY_ID = 100000;
// The room has arrived when ROOM_HANDS drawers (one more than Robert ever
// has going alone) have each drawn within ROOM_WINDOW_MS of each other: a
// fourth live hand inside a minute and a half is the audience, not a test.
export const ROOM_HANDS = 4;
export const ROOM_WINDOW_MS = 90000;

// Where the room arrives on `good` (valid entries, oldest first): the index
// of the earliest batch in the first ROOM_WINDOW_MS stretch, ending at a
// batch, that holds ROOM_HANDS distinct drawers, or -1 when it never does.
// One walk with a trailing edge, each batch counted in and out once, on a
// map kept across passes so a re-plan allocates nothing new. The first
// such stretch on a tape only ever grown at its end stays the first, so
// every re-plan finds the same start. The window grows by one drawer at
// most per batch, so the stretch found holds exactly `hands` of them.
const inWindow = new Map();
export function roomArrives(good, hands = ROOM_HANDS, windowMs = ROOM_WINDOW_MS) {
  inWindow.clear();
  let lo = 0, at = -1;
  for (let i = 0; i < good.length; i++) {
    const id = good[i].id;
    inWindow.set(id, (inWindow.get(id) || 0) + 1);
    while (good[i].at - good[lo].at > windowMs) {
      const o = good[lo++].id, n = inWindow.get(o) - 1;
      if (n) inWindow.set(o, n); else inWindow.delete(o);
    }
    if (inWindow.size >= hands) { at = lo; break; }
  }
  inWindow.clear();
  return at;
}

// Where the room leaves again: the last batch whose trailing LEAVE_WINDOW_MS
// still holds ROOM_HANDS distinct drawers, from `from` on. Everything after
// it is stragglers, and the Brush section's Trim event (on by default) ends
// the pass there, so the loop is the room at full strength edge to edge.
// Arrival listens wide (90 s: phones trickling in count toward a room) but
// leaving listens tight: four hands sharing fifteen seconds is a room
// still drawing, while stragglers trading turns across a minute is not —
// on the first event's tape the wide window never cut at all, and 15 s
// ends the pass at the room's true last gathering.
export const LEAVE_WINDOW_MS = 15000;
export function roomLeaves(good, from, hands = ROOM_HANDS, windowMs = LEAVE_WINDOW_MS) {
  inWindow.clear();
  let lo = from, last = good.length - 1;
  for (let i = from; i < good.length; i++) {
    const id = good[i].id;
    inWindow.set(id, (inWindow.get(id) || 0) + 1);
    while (good[i].at - good[lo].at > windowMs) {
      const o = good[lo++].id, n = inWindow.get(o) - 1;
      if (n) inWindow.set(o, n); else inWindow.delete(o);
    }
    if (inWindow.size >= hands) last = i;
  }
  inWindow.clear();
  return last;
}

// The pass over `entries` (the tape's, oldest first): { steps, scale, ms,
// skipped, drawers }, steps [{ tMs, id, s }] from the pass's zero, ms the
// pass's length with its rest, skipped how many batches before the room
// arrived were left out (0 when it never arrived and the whole tape plays)
// and drawers how many hands it arrived with (0 then too). Entries without
// a time, a drawer or a stroke are skipped. loopMs is the window a long
// tape is squeezed into: LOOP_MS for the show's cue 24, Infinity for the
// standing playback between shows (platform/tape-replay.js), whose passes
// keep scale 1 and play the drawing in real time. trim ends the pass where
// the room leaves (roomLeaves above; trimmed says how many batches the cut
// left out); it only ever cuts when the room arrived at all, so a solo
// tape plays whole with or without it.
export function planPass(entries, loopMs = LOOP_MS, restMs = LOOP_REST_MS, trim = false) {
  const good = [];
  for (const e of entries || []) {
    if (e && typeof e.at === 'number' && typeof e.id === 'number' && e.s && e.s.t === 's') good.push(e);
  }
  if (!good.length) return { steps: [], scale: 1, ms: 0 };
  const a = roomArrives(good), skipped = a > 0 ? a : 0;
  const drawers = a >= 0 ? ROOM_HANDS : 0;
  const end = trim && a >= 0 ? roomLeaves(good, skipped) : good.length - 1;
  const trimmed = good.length - 1 - end;
  const t0 = good[skipped].at, span = good[end].at - t0;
  const scale = span > 0 ? Math.min(1, loopMs / span) : 1;
  const steps = new Array(end + 1 - skipped);
  for (let i = skipped; i <= end; i++) {
    const e = good[i];
    steps[i - skipped] = { tMs: (e.at - t0) * scale, id: e.id, s: e.s };
  }
  return { steps, scale, ms: span * scale + restMs, skipped, drawers, trimmed };
}

// A step as the message brushTake plays: the stroke under the drawer's
// replay key, its points' times (when it carries them) laid on this
// screen's clock with its last point at `base` and the rest `scale` as far
// apart as they were drawn. Whole ms, as the wire wants: each point's time
// rounded, the gaps taken between the rounded times, so none drifts. size
// (the Brush section's Replay size, 1 as drawn) scales the width it is
// drawn at, whole and held to the wire's 1 to 100.
export function retime(step, base, scale, size = 1) {
  const s = step.s, msg = Object.assign({}, s, { id: REPLAY_ID + step.id });
  if (size !== 1 && typeof s.w === 'number') msg.w = Math.max(1, Math.min(100, Math.round(s.w * size)));
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
