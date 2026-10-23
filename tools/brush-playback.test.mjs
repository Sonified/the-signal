// The receiver's playback of remote brush strokes (core/brush-playback.js,
// core/brush.js brushTake / brushPlay): on the sender's own timeline when a
// stroke carries its times (the wire's q), on the glide when it does not;
// either way the cursor only gates when stamps appear, never where they
// fall.
//
//   node --test tools/brush-playback.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  playStep, PLAY_TAU_S, PLAY_STAGES, minOffset, playTime, ratchetDelay, timelineAt, DELAY0_MS, BATCH_MS
} from '../core/brush-playback.js';
import { stampsFor, brushSpacing, BRUSH_W } from '../core/brush-stamps.js';
import { encodeStroke, decodeStroke, timesToQ, MOTIF } from '../touch/strokes.js';
import { brushTake, brushPlay, brushPlaying, brushQueue, brushQueueDrop, STAMP_FLOATS, setBrushClock, brushPlayDelay, brushPlayReset } from '../core/brush.js';

let now = 5e6;
setBrushClock(() => now);

const take = () => {
  const q = brushQueue, out = [];
  for (let i = 0; i < q.count; i++) {
    const o = ((q.head + i) % q.cap) * STAMP_FLOATS;
    out.push(Array.from(q.buf.subarray(o, o + STAMP_FLOATS)));
  }
  brushQueueDrop(q.count);
  return out;
};

test('the law: min offset, play time, the ratchet, the timeline', () => {
  let off = NaN;
  for (const [arrive, sent] of [[1100, 1000], [1135, 1030], [1150, 1060], [1300, 1090]]) off = minOffset(off, arrive, sent);
  assert.equal(off, 90, 'the fastest delivery there has been');
  assert.equal(playTime(2000, 90, 60), 1850);
  assert.equal(ratchetDelay(60, 1850, 1900), 60, 'early is not late');
  assert.equal(ratchetDelay(60, 1850, 1810), 100, 'raised by the lateness');
  assert.equal(ratchetDelay(100, 0, 10), 100, 'never lowered');
  const T = [0, 10, 30, 30, 60], P = [0, 1, 3, 3.5, 6], out = { i: 0 };
  assert.ok(timelineAt(T, P, 5, 0, -5, out) < 0, 'nothing due before the first point');
  assert.equal(timelineAt(T, P, 5, 0, 0, out), 0);
  assert.equal(timelineAt(T, P, 5, 0, 5, out), 0.5);
  assert.equal(out.i, 0);
  assert.equal(timelineAt(T, P, 5, out.i, 20, out), 2);
  assert.equal(timelineAt(T, P, 5, out.i, 30, out), 3.5, 'two points at one time: the later');
  assert.equal(timelineAt(T, P, 5, out.i, 45, out), 4.75);
  assert.equal(timelineAt(T, P, 5, out.i, 500, out), 6, 'past the last: held there');
});

test('the glide (strokes without times): never back, at the end in three time constants', () => {
  const c = new Float64Array(PLAY_STAGES);
  let prev = 0, t = 0, end = 0, reached = -1;
  for (let f = 0; f < 240; f++) {
    if (f === 10) end = 10;
    const x = playStep(c, 0, end, 1 / 120);
    t += 1 / 120;
    assert.ok(x >= prev - 1e-12);
    prev = x;
    if (end && reached < 0 && x >= end) reached = t - 10 / 120;
  }
  assert.ok(reached > 0 && reached <= 3 * PLAY_TAU_S * PLAY_STAGES);
});

// A sender drawing a wobbly line, a point every 1/120 s from sender time
// t0, flushed every BATCH_MS as the main app does (each batch from the last
// one's final point, its times on the wire). extras the motif's fields.
function sender(n, t0, extras, timed = true) {
  const pts = [], ts = [];
  for (let i = 0; i < n; i++) { pts.push({ u: 0.3 + i * 0.003, v: 0.4 + Math.sin(i * 0.15) * 0.03 }); ts.push(t0 + i * 1000 / 120); }
  const msgs = [];
  let from = 0;
  while (from < n - 1) {
    let to = from;
    while (to + 1 < n && ts[to + 1] - ts[from] <= BATCH_MS) to++;
    if (to === from) to++;
    const d = from === 0 ? 0 : to === n - 1 ? 2 : 1;
    const e = Object.assign({}, extras, timed ? { q: timesToQ(ts.slice(from, to + 1)) } : {});
    msgs.push({ msg: encodeStroke(MOTIF, 10, BRUSH_W, d, pts.slice(from, to + 1), e), sentAt: ts[to] });
    from = to;
  }
  return { msgs, pts, ts };
}

// Delivers msgs at sentAt + latency(i) (sender clock, mapped onto this one
// by a fixed skew), stepping frames at hz; returns when each stamp came out.
function deliver(msgs, latency, hz, key, skew = 123456) {
  take();
  brushPlayReset();
  const outAt = [];
  const dt = 1000 / hz;
  // a socket keeps order: a late batch holds back the ones after it
  let last = -Infinity;
  const arrivals = msgs.map((m, i) => { last = Math.max(last, m.sentAt + skew + latency(i)); return { m: m.msg, at: last }; });
  now = arrivals[0].at - 5;
  let a = 0;
  for (let f = 0; f < 4000 && (a < arrivals.length || brushPlaying()); f++) {
    now += dt;
    while (a < arrivals.length && arrivals[a].at <= now) { brushTake({ ...arrivals[a].m, id: key }); a++; }
    brushPlay(dt / 1000);
    const q = brushQueue;
    for (let i = outAt.length; i < q.count; i++) outAt.push(now);
  }
  return { stamps: take(), outAt, skew };
}

const unsmoothed = msgs => {
  let carry = 0;
  const out = [];
  for (const { msg } of msgs) {
    const r = stampsFor(decodeStroke(msg), carry);
    carry = r.carry;
    for (const st of r.stamps) out.push([st.u, st.v, st.angle]);
  }
  return out;
};
const sameFigure = (got, expect) => {
  assert.equal(got.length, expect.length, 'every stamp, none lost or added');
  got.forEach((g, i) => assert.ok(Math.abs(g[0] - expect[i][0]) < 1e-6 && Math.abs(g[1] - expect[i][1]) < 1e-6 &&
    Math.abs(g[2] - expect[i][2]) < 1e-6, `stamp ${i} in place`));
};

test('timed: played on the sender\'s timeline, delay steady, the figure exact', () => {
  const c = 2;
  const { msgs, ts } = sender(240, 1000, { a: 3, m: 7, c, f: 0.5 });
  // 40 ms one way, wandering up to 25 ms more: within the jitter allowance
  const jitter = i => 40 + ((i * 37) % 26);
  const d0 = DELAY0_MS;
  const { stamps, outAt, skew } = deliver(msgs, jitter, 240, 'tl');
  sameFigure(stamps, unsmoothed(msgs));
  assert.equal(brushPlayDelay(), d0, 'no batch was late, so no ratchet');
  // each stamp out at its own moment on the hand's timeline: stamp k sits at
  // arc k * spacing, which the sender reached at a time the points tell;
  // it must come out the min offset (40 ms + the batch's own wait folded
  // into it) plus the delay after that, give or take a frame
  const spacing = brushSpacing(BRUSH_W);
  const arc = [0];
  const { pts } = sender(240, 1000, {});
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v));
  const timeOf = s => { let i = 0; while (i + 1 < arc.length && arc[i + 1] < s) i++; return ts[i] + (ts[i + 1] - ts[i]) * ((s - arc[i]) / (arc[i + 1] - arc[i] || 1)); };
  const lead = [];
  for (let k = 0; k * c < stamps.length; k++) lead.push(outAt[k * c] - skew - timeOf(k * spacing));
  const min = Math.min(...lead), max = Math.max(...lead);
  // (within three frames at 240 Hz: each stamp's own frame, and the min
  // offset settling as deliveries that land nearer a frame's start turn
  // up, each measured only to the frame it is taken in)
  assert.ok(max - min <= 3 * 1000 / 240 + 1, `steady behind the hand: ${min.toFixed(1)}..${max.toFixed(1)} ms`);
  assert.ok(min >= 40 + d0 - 5 && max <= 40 + d0 + BATCH_MS + 5, `about one trip + ${d0} ms behind (${min.toFixed(0)} ms)`);
});

test('timed: a late batch ratchets the delay up, play resumes from where it held, never back', () => {
  const { msgs } = sender(240, 1000, { a: 3, m: 7, c: 1, f: 0.5 });
  const d0 = DELAY0_MS;
  // batch 5 is 120 ms late
  const late = i => (i === 5 ? 160 : 40);
  let prev = -1, monotone = true;
  const { stamps, outAt } = deliver(msgs, late, 240, 'lt');
  for (const t of outAt) { if (t < prev) monotone = false; prev = t; }
  assert.ok(monotone);
  sameFigure(stamps, unsmoothed(msgs));
  const d1 = brushPlayDelay();
  assert.ok(d1 > d0 && d1 < d0 + 130, `ratcheted ${d0} -> ${d1.toFixed(0)} ms`);
  // and stays there: a clean stroke after does not bring it down
  const more = sender(120, 9000, { a: 3, m: 7, c: 1, f: 0.5 }).msgs;
  for (const m of more) { now = m.sentAt + 123456 + 40; brushTake({ ...m.msg, id: 'lt' }); brushPlay(0.004); }
  for (let i = 0; i < 400 && brushPlaying(); i++) { now += 4; brushPlay(0.004); }
  take();
  assert.equal(brushPlayDelay(), d1, 'never lowered');
});

test('timed: a hand held still is not late', () => {
  const { msgs } = sender(60, 1000, { a: 1, m: 0, c: 1, f: 0.5 });
  const d0 = DELAY0_MS;
  // the second half drawn 2 s later: its times say so, nothing ratchets
  const later = sender(60, 3000, { a: 1, m: 0, c: 1, f: 0.5 }).msgs.map((m, i) => i === 0 ? m : m);
  const joined = msgs.slice(0, -1).concat(later.slice(1).map(m => ({ ...m, msg: { ...m.msg, d: m.msg.d === 0 ? 1 : m.msg.d } })));
  deliver(joined, () => 40, 240, 'still');
  assert.equal(brushPlayDelay(), d0);
});

test('untimed (an older sender or tape): glides, the figure exact', () => {
  const { msgs } = sender(160, 1000, { a: 2, m: 5, c: 3, f: 0.5 }, false);
  const { stamps } = deliver(msgs, () => 40, 120, 'old');
  sameFigure(stamps, unsmoothed(msgs));
});

test('timed slowed stroke: each print out at its own time', () => {
  const ts = [1000, 1400, 1800, 2200, 2600];
  const pts = ts.map((_, i) => ({ u: 0.2 + i * 0.1, v: 0.5 }));
  // the last four arrive in one batch, late: the delay takes the lateness,
  // and they still come out one by one at the hand's own pace
  const msgs = [{ msg: encodeStroke(MOTIF, 10, BRUSH_W, 0, pts.slice(0, 1), { a: 1, m: 0, c: 3, f: 0.5, r: 0.2, q: timesToQ(ts.slice(0, 1)) }), sentAt: 1000 },
                { msg: encodeStroke(MOTIF, 10, BRUSH_W, 2, pts.slice(1), { a: 1, m: 0, c: 3, f: 0.5, r: 0.2, q: timesToQ(ts.slice(1)) }), sentAt: 2600 }];
  const { stamps, outAt } = deliver(msgs, () => 40, 120, 'pr');
  assert.equal(stamps.length, 15);
  const at = [0, 3, 6, 9, 12].map(i => outAt[i]);
  for (let i = 2; i < at.length; i++) assert.ok(Math.abs(at[i] - at[i - 1] - 400) < 1000 / 120 + 1, `print ${i} 400 ms after the last`);
});

test('a stroke whose sender vanished still lets out all it had, and its slot frees', () => {
  brushPlayReset(); take();
  const { msgs } = sender(60, 1000, { a: 1, m: 0, c: 1, f: 0.5 });
  const cut = msgs.slice(0, 3);
  for (const m of cut) brushTake({ ...m.msg, id: 'gone' });
  let n = 0;
  while (brushPlaying() && n < 2000) { now += 1000 / 60; brushPlay(1 / 60); n++; }
  assert.ok(!brushPlaying(), 'freed');
  assert.ok(n / 60 >= 2.95 && n / 60 < 4, `let go after ${(n / 60).toFixed(2)} s with nothing new`);
  sameFigure(take(), unsmoothed(cut));
});

test('a new stroke from the same sender plays beside the one still playing', () => {
  brushPlayReset(); take();
  const one = sender(40, 1000, { a: 1, m: 0, c: 1, f: 0.5 }).msgs, two = sender(40, 1400, { a: 1, m: 1, c: 1, f: 0.5 }).msgs;
  for (const m of one) brushTake({ ...m.msg, id: 's' });
  for (const m of two) brushTake({ ...m.msg, id: 's' });
  for (let i = 0; i < 1000 && brushPlaying(); i++) { now += 1000 / 60; brushPlay(1 / 60); }
  const got = take();
  assert.equal(got.filter(g => g[4] === 0).length, got.filter(g => g[4] === 1).length, 'both whole');
});

test('the wire: q round-trips, refuses junk, and is optional', () => {
  const ts = [1000.4, 1008.7, 1016.9, 1040];
  const q = timesToQ(ts);
  assert.deepEqual(q, [1000, 9, 8, 23]);
  const pts = ts.map(() => ({ u: 0.5, v: 0.5 }));
  const ok = decodeStroke(encodeStroke(0, 10, 10, 0, pts, { q }));
  assert.deepEqual(ok.times, [1000, 1009, 1017, 1040]);
  for (const bad of [[1000, 9, 8], [1000, -1, 8, 2], [1000, 9.5, 8, 2], ['1000', 1, 1, 1], [1000, 70000, 1, 1], 'x'])
    assert.equal(decodeStroke({ ...encodeStroke(0, 10, 10, 0, pts), q: bad }), null, JSON.stringify(bad));
  assert.equal(decodeStroke(encodeStroke(0, 10, 10, 0, pts)).times, undefined);
  // the default room: a 20 ms stream and 30 ms of smoothing
  assert.equal(DELAY0_MS, 50);
});

test('a hand still past the abandon time mid-stroke does not raise the delay when it moves on', () => {
  brushPlayReset();
  take();
  const d0 = brushPlayDelay();
  const T = 900000, key = 777;
  const pts = [{ u: 0.3, v: 0.3 }, { u: 0.32, v: 0.31 }];
  brushTake(Object.assign(encodeStroke(MOTIF, 200, 50, 0, pts, { a: 1, m: 3, c: 1, f: 0.5, q: timesToQ([T, T + 16]) }), { id: key }));
  // five seconds still (the slot is let go after its abandon time)
  for (let i = 0; i < 300; i++) { now += 1000 / 60; brushPlay(1 / 60); take(); }
  // then on: the joint is the stillness's start, the new point now
  const on = [{ u: 0.32, v: 0.31 }, { u: 0.36, v: 0.33 }];
  brushTake(Object.assign(encodeStroke(MOTIF, 200, 50, 1, on, { a: 1, m: 3, c: 1, f: 0.5, q: timesToQ([T + 16, T + 5016]) }), { id: key }));
  assert.equal(brushPlayDelay(), d0, 'the joint carries no stamp, so it is never late');
  for (let i = 0; i < 300; i++) { now += 1000 / 60; brushPlay(1 / 60); take(); }
});
