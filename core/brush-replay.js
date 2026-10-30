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
import { QUANT } from '../touch/strokes.js';
import { printsPerSecond } from './brush-stamps.js';
import { smoothBatch, smoothState, smoothOut, smoothJoins, smoothEnd, smoothLive, smoothPen, SMOOTH_MODES } from './brush-smooth.js';

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
// skipped, drawers }, steps [{ tMs, takeMs, id, s }] from the pass's zero
// (tMs the batch's last point, takeMs when it is handed to the brush, its
// first new point's moment, see paceStrokes), ms the
// pass's length with its rest, ahead how early the playback takes each
// step (jointGap below), skipped how many batches before the room
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
  paceStrokes(good);
  let t0 = Infinity, tEnd = -Infinity;
  for (let i = skipped; i <= end; i++) {
    if (paceTake[i] < t0) t0 = paceTake[i];
    if (paceLast[i] > tEnd) tEnd = paceLast[i];
  }
  const span = tEnd - t0;
  const scale = span > 0 ? Math.min(1, loopMs / span) : 1;
  const steps = new Array(end + 1 - skipped);
  let ahead = 0;
  for (let i = skipped; i <= end; i++) {
    const e = good[i];
    steps[i - skipped] = { tMs: (paceLast[i] - t0) * scale, takeMs: (paceTake[i] - t0) * scale, id: e.id, s: e.s };
    if (paceEnd[i]) steps[i - skipped].end = paceEnd[i];
    const g = jointGap(e);
    if (g > ahead) ahead = g;
  }
  // taken in the order their first points come due (stable, so a drawer's
  // own batches, whose takes never go back, keep their order)
  steps.sort((a, b) => a.takeMs - b.takeMs);
  return { steps, scale, ms: span * scale + restMs, skipped, drawers, trimmed,
           ahead: (ahead < AHEAD_MAX_MS ? ahead : AHEAD_MAX_MS) * scale };
}

// How far ahead of its first new point a batch must be in hand for the
// playback's smoothing: from its joint on, since the eased pen leaves the
// joint at once, its sub-steps between the joint and the first new point
// coming due through that whole gap (taken only at the first new point, it
// would find them gone by and the cursor would leap to catch up). The
// pass's `ahead` is the longest such gap (pass ms), held to AHEAD_MAX_MS
// of drawing time so one long stillness does not hand every batch over
// seconds early; core/brush.js takes every step that much early, smoothed
// or not (a batch in hand early only waits for its moment). On
// the WIN 2026 tape a joint's gap is 17 ms at the median, 134 at p99 and
// 673 at p99.9, and 283 of 57,288 pass 250 ms: those few, a hand's pause,
// still come in late by the rest, as every one did unsmoothed. 250 ms at
// 0.05x is 5 s early, about 625 sub-steps held ahead in a slot, well
// within its timeline (core/brush.js TL_CAP, 2048).
export const AHEAD_MAX_MS = 250;
function jointGap(e) {
  const s = e.s, q = s.q;
  return s.d !== 0 && !(s.r < 1) && Array.isArray(q) && q.length > 1 && q[1] > 0 ? q[1] : 0;
}

// Each batch's moment on the tape, from its sender's own clock. The tape's
// `at` is when the batch reached the hall, the network's moods and all: a
// batch held up 100 ms and then the next ones bunched in behind it. Played
// by `at`, the stroke stalled through the hold-up and then the bunch landed
// at once, laid on top of each other in time, and the cursor leapt through
// all of them in one frame: the jump, 20 times as long and as far at 0.05x
// as at 1x. So within a stroke (a drawer's d 0 to its d 2) every batch
// keeps its own points' times (q) and the stroke is placed by its fastest
// delivery, the least (at - its last point's time) over its batches, as
// the live playback rides its fastest delivery (core/brush-playback.js
// minOffset): the stroke at the hand's own pace, never later than it
// reached the hall. paceLast is that moment for each batch's last point,
// paceTake for its first new point (the joint excepted: it is the last
// batch's), when the batch must be in hand to play it in time. A batch
// without times keeps `at` for both. A drawer's batches never go back
// against its own last one, so a stroke never starts before the one before
// it ends. Arrays kept across passes, as inWindow is. paceEnd is how a
// finished stroke was moving as it ended (endMotion), on its d 2 batch,
// for the fade down's tail (retime); null elsewhere.
const paceLast = [], paceTake = [], paceEnd = [];
const drawerLast = new Map();
function batchTimes(e) {
  const q = e.s.q;
  if (!Array.isArray(q) || !q.length) return null;
  let last = 0;
  for (let j = 0; j < q.length; j++) last += q[j];
  const first = e.s.d === 0 || e.s.r < 1 || q.length < 2 ? 0 : 1;   // prints repeat no joint
  let lead = 0;
  for (let j = first + 1; j < q.length; j++) lead += q[j];
  return { last, lead };
}
function paceStrokes(good) {
  const n = good.length;
  paceLast.length = n; paceTake.length = n; paceEnd.length = n;
  const open = new Map();   // drawer -> its open stroke's batch indices
  const close = list => {
    let off = Infinity;
    for (const i of list) { const b = batchTimes(good[i]); if (b) off = Math.min(off, good[i].at - b.last); }
    for (const i of list) {
      const b = batchTimes(good[i]);
      if (b && off < Infinity) { paceLast[i] = b.last + off; paceTake[i] = paceLast[i] - b.lead; }
      else { paceLast[i] = paceTake[i] = good[i].at; }
      paceEnd[i] = null;
    }
    // a finished stroke's end: how long the hand held still before letting
    // go is how much later than its fastest delivery the last batch reached
    // the hall, its last point's time being the hand's last move
    const z = list[list.length - 1], bz = batchTimes(good[z]);
    if (good[z].s.d === 2 && bz && off < Infinity) {
      const from = list.length > END_BATCHES ? list.length - END_BATCHES : 0;
      paceEnd[z] = endMotion(list.slice(from).map(i => good[i].s), good[z].at - bz.last - off);
    }
  };
  for (let i = 0; i < n; i++) {
    const id = good[i].id, s = good[i].s;
    let list = open.get(id);
    if (list && s.d === 0) { close(list); list = null; }
    if (!list) { list = []; open.set(id, list); }
    list.push(i);
    if (s.d === 2) { close(list); open.delete(id); }
  }
  for (const list of open.values()) close(list);
  drawerLast.clear();
  for (let i = 0; i < n; i++) {
    const id = good[i].id, prev = drawerLast.get(id);
    if (prev !== undefined && paceTake[i] < prev) {
      const d = prev - paceTake[i];
      paceTake[i] += d; paceLast[i] += d;
    }
    drawerLast.set(id, paceTake[i]);
  }
  drawerLast.clear();
}

// A step as the message brushTake plays: the stroke under the drawer's
// replay key, its points' times (when it carries them) laid on this
// screen's clock with its last point at `base` and the rest `scale` as far
// apart as they were drawn. Whole ms, as the wire wants: each point's time
// rounded, the gaps taken between the rounded times, so none drifts. size
// (the Brush section's Replay size, 1 as drawn) scales the width it is
// drawn at, whole and held to the wire's 1 to 100.
//
// fadeUp and fadeDown are the Brush section's Replay fade up and fade down,
// ms of the stroke's own drawing time (0 off). They ride the message laid
// on this screen's clock, as fu and fd (the same times times the scale, so
// a fade covers the same stretch of the line at any speed), for
// core/brush.js to fade each stamp by; a stroke's last batch also gets its
// tail (fadeTail below) and fe, the moment of its real last point, after
// which the marks fade. Only the playback's messages carry them; nothing
// with them is ever sent.
//
// smooth is the Brush section's Replay smoothing ('off', 'auto', 'set' or
// 'euro', core/brush-smooth.js) and smoothMs Set's time constant in screen
// ms: a continuous stroke's points are eased into a curve and laid finer
// than they were drawn (smoothInto below), so a slowed playback glides
// from point to point instead of ticking. 'off' is the playback exactly
// as it was. A stroke whose last batch gets the fade down's tail is not
// settled into its end: the tail carries on from the eased end.
export function retime(step, base, scale, size = 1, fadeUp = 0, fadeDown = 0, smooth = 'off', smoothMs = 0) {
  const s = step.s, msg = Object.assign({}, s, { id: REPLAY_ID + step.id });
  if (size !== 1 && typeof s.w === 'number') msg.w = Math.max(1, Math.min(100, Math.round(s.w * size)));
  const q = s.q;
  if (!Array.isArray(q) || !q.length) { delete msg.q; return msg; }
  const T = new Array(q.length);
  T[0] = q[0];
  for (let j = 1; j < q.length; j++) T[j] = T[j - 1] + q[j];
  const last = T[q.length - 1];
  const tail = fadeDown > 0 && s.d === 2 && !!step.end;
  // the settle into the real end is the stroke's last batch's alone: on
  // every batch it laid each one's ease-out past the next one's start, the
  // timeline going back at every batch and the pen leaping (the stutter)
  let prev = smoothInto(msg, step.id, T, base, scale, smooth, smoothMs, s.d === 2 && !tail);
  if (prev < 0) {
    const q2 = new Array(q.length);
    prev = 0;
    for (let j = 0; j < q.length; j++) {
      const a = Math.max(0, Math.round(base - (last - T[j]) * scale));
      q2[j] = j ? a - prev : a;
      prev = a;
    }
    msg.q = q2;
  }
  if (fadeUp > 0) msg.fu = fadeUp * scale;
  if (tail) {
    msg.fe = prev; msg.fd = fadeDown * scale;
    fadeTail(msg, step.end, fadeDown, prev, scale);
  }
  return msg;
}

// ---------- the smoothing ----------
// A batch's points through its drawer's filter (core/brush-smooth.js
// smoothBatch, in the drawing's own time), and the eased points it gives
// back laid on this screen's clock as retime lays the drawn ones (the
// batch's last at base, the rest scale as far apart, whole ms, gaps taken
// between the rounded times) with a settle's after it, each position
// rounded to the wire's grid. msg gets its own p and q; the tape's arrays
// are never touched. Returns the last point's time on this clock, or -1
// when it left the batch as it was: smoothing off, a print stroke (each
// point a print where the hand put it, nothing between to ease), a batch
// whose points and times do not pair. Off still minds a stroke the
// smoothing was easing when it was switched off: its next batch's joint
// is moved to where the eased pen stands, so the line bends back onto the
// drawing instead of jumping to it. Each drawer's state is kept across
// batches and passes (smoothSt), as the pace's arrays are, and a batch
// that does not carry on from it starts afresh.
const smoothSt = new Map();
// A seek (core/brush.js brushReplaySeek): every drawer's filter let go, so
// the first batch from the new place starts its pen afresh where it is
// drawn, never gliding over from where the eased pen stood before the
// jump. The only state retime carries from batch to batch; the pace's
// arrays are a plan's, made afresh with each pass.
export function replaySmoothReset() { smoothSt.clear(); }
let smU = new Float64Array(64), smV = new Float64Array(64);
const smPen = { u: 0, v: 0 };
function smoothInto(msg, id, T, base, scale, smooth, smoothMs, settle) {
  const s = msg, p = s.p, n = T.length;
  if (s.r < 1 || !Array.isArray(p) || p.length !== n * 2) return -1;
  const mode = SMOOTH_MODES.indexOf(smooth);
  let st = smoothSt.get(id);
  if (!(mode >= 1)) {
    if (st && smoothLive(st)) {
      if (s.d !== 0 && smoothJoins(st, T[0], p[0] / QUANT, p[1] / QUANT)) {
        smoothPen(st, smPen);
        msg.p = p.slice();
        msg.p[0] = Math.max(0, Math.min(QUANT, Math.round(smPen.u * QUANT)));
        msg.p[1] = Math.max(0, Math.min(QUANT, Math.round(smPen.v * QUANT)));
      }
      smoothEnd(st);
    }
    return -1;
  }
  if (!st) { st = smoothState(); smoothSt.set(id, st); }
  if (smU.length < n) { smU = new Float64Array(n * 2); smV = new Float64Array(n * 2); }
  for (let j = 0; j < n; j++) { smU[j] = p[2 * j] / QUANT; smV[j] = p[2 * j + 1] / QUANT; }
  const m = smoothBatch(mode, smoothMs, T, smU, smV, n, s.d, scale, st, settle);
  if (!(m > 0)) return -1;
  const o = smoothOut, last = T[n - 1], p2 = new Array(m * 2), q2 = new Array(m);
  let prev = 0;
  for (let j = 0; j < m; j++) {
    p2[2 * j] = Math.max(0, Math.min(QUANT, Math.round(o.u[j] * QUANT)));
    p2[2 * j + 1] = Math.max(0, Math.min(QUANT, Math.round(o.v[j] * QUANT)));
    const a = Math.max(j ? prev : 0, Math.round(base - (last - o.t[j]) * scale));
    q2[j] = j ? a - prev : a;
    prev = a;
  }
  msg.p = p2; msg.q = q2;
  return prev;
}

// ---------- the fade down's tail ----------
// A replayed stroke with Replay fade down on does not stop dead at its last
// point: the line carries on past it the way it was going, at the speed it
// was going, for the fade-down time, and the brush fades those extra marks
// out to nothing while the real stroke keeps its full brightness.
//
// endMotion is how the stroke was moving as it ended, from its own batches
// (the wire's messages, oldest first, the last its d 2): the displacement
// over its last END_SPAN point gaps, over their time, so one jittery point
// never aims it, in unit-square units a ms; and the pace its points came at
// (their mean gap, or a print stroke's print interval), at which the tail
// is laid. null for a hand at rest as it lifted: restMs, how long it held
// still before letting go, REST_MS or more, or no time between its points.
// Joints are left out, and a repeat of the point before (a last batch of
// only its joint) counts once.
export const END_SPAN = 4, REST_MS = 150;
const END_BATCHES = END_SPAN + 2;
export function endMotion(batches, restMs = 0) {
  if (!batches || !batches.length || restMs >= REST_MS) return null;
  const lastB = batches[batches.length - 1];
  const prints = lastB.r < 1;
  let n = 0, u1 = 0, v1 = 0, t1 = 0, u0 = 0, v0 = 0, t0 = 0;
  for (let b = batches.length - 1; b >= 0 && n <= END_SPAN; b--) {
    const s = batches[b], q = s.q, p = s.p;
    if (!Array.isArray(q) || !Array.isArray(p) || p.length !== q.length * 2) return null;
    const ts = new Array(q.length);
    let T = 0;
    for (let j = 0; j < q.length; j++) { T += q[j]; ts[j] = T; }
    const first = s.d === 0 || prints || q.length < 2 ? 0 : 1;
    for (let j = q.length - 1; j >= first && n <= END_SPAN; j--) {
      const u = p[2 * j], v = p[2 * j + 1];
      if (n > 0 && ts[j] === t0 && u === u0 && v === v0) continue;
      if (n === 0) { u1 = u; v1 = v; t1 = ts[j]; }
      u0 = u; v0 = v; t0 = ts[j];
      n++;
    }
  }
  const dt = t1 - t0;
  if (n < 2 || !(dt > 0)) return null;
  return { vu: (u1 - u0) / QUANT / dt, vv: (v1 - v0) / QUANT / dt,
           gap: prints ? 1000 / printsPerSecond(lastB.r) : dt / (n - 1), prints };
}

// The tail onto a stroke's last batch as retime laid it (msg, its last
// point's time on this clock at endT): points along end's way from the last
// point out to fadeMs of drawing time later, at the stroke's own pace (a
// continuous stroke's evenly so the last falls at fadeMs, a print stroke's
// at its print interval, none when the first would fall past it), each at
// its moment on this clock at the scale. It stops at the unit square's edge
// (the wire holds no point outside it), and has nothing to add when the
// line would not travel a step of the wire's grid in the whole tail.
const TAIL_MAX = 256, TAIL_GAP_MIN = 4;
export function fadeTail(msg, end, fadeMs, endT, scale) {
  const q = msg.q, n = msg.p ? msg.p.length : 0;
  if (!(fadeMs > 0) || !end || n < 2 || !q || q.length * 2 !== n) return msg;
  // the message's own copy: its points are the tape's own array till now
  const p = msg.p = msg.p.slice();
  const vu = end.vu * QUANT, vv = end.vv * QUANT;
  if (Math.hypot(vu, vv) * fadeMs < 1) return msg;
  // how long before the line leaves the square
  let reach = fadeMs;
  const u = p[n - 2], v = p[n - 1];
  if (vu > 0) reach = Math.min(reach, (QUANT - u) / vu); else if (vu < 0) reach = Math.min(reach, -u / vu);
  if (vv > 0) reach = Math.min(reach, (QUANT - v) / vv); else if (vv < 0) reach = Math.min(reach, -v / vv);
  const gap = end.gap > TAIL_GAP_MIN ? end.gap : TAIL_GAP_MIN;
  const count = end.prints ? Math.min(TAIL_MAX, Math.floor(fadeMs / gap)) : Math.min(TAIL_MAX, Math.ceil(fadeMs / gap));
  const step = end.prints ? gap : fadeMs / count;
  let prev = endT;
  for (let k = 1; k <= count; k++) {
    const dt = k * step;
    if (dt > reach + 1e-9) break;
    const a = Math.max(prev, Math.round(endT + dt * scale));
    p.push(Math.max(0, Math.min(QUANT, Math.round(u + vu * dt))), Math.max(0, Math.min(QUANT, Math.round(v + vv * dt))));
    q.push(a - prev);
    prev = a;
  }
  return msg;
}
