// The receiver's playback of remote brush strokes (core/brush-playback.js,
// core/brush.js brushTake / brushPlay): the cursor only gates when stamps
// appear, never where they fall.
//
//   node --test tools/brush-playback.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { playStep, PLAY_TAU_S, PLAY_STAGES } from '../core/brush-playback.js';
import { stampsFor, stampCopies, BRUSH_W } from '../core/brush-stamps.js';
import { encodeStroke, decodeStroke, MOTIF } from '../touch/strokes.js';
import { brushTake, brushPlay, brushPlaying, brushQueue, brushQueueDrop, STAMP_FLOATS } from '../core/brush.js';

const take = () => {
  const q = brushQueue, out = [];
  for (let i = 0; i < q.count; i++) {
    const o = ((q.head + i) % q.cap) * STAMP_FLOATS;
    out.push(Array.from(q.buf.subarray(o, o + STAMP_FLOATS)));
  }
  brushQueueDrop(q.count);
  return out;
};

test('the cursor: never steps back, and reaches a still end in about three of its time constants', () => {
  const c = new Float64Array(PLAY_STAGES);
  let prev = 0, t = 0, end = 0, reached = -1;
  for (let f = 0; f < 240; f++) {
    if (f === 10) end = 10;            // a batch lands
    const x = playStep(c, 0, end, 1 / 120);
    t += 1 / 120;
    assert.ok(x >= prev - 1e-12, 'monotone');
    prev = x;
    if (end && reached < 0 && x >= end) reached = t - 10 / 120;
  }
  const total = PLAY_TAU_S * PLAY_STAGES;
  assert.ok(reached > 0 && reached <= 3 * total, `reached the end in ${(reached * 1000).toFixed(0)} ms`);
  // no time, no movement
  const before = c[PLAY_STAGES - 1];
  assert.equal(playStep(c, 0, 50, 0), before);
});

// A wobbly stroke, cut into the sender's 45 ms batches (each from the last
// one's final point), as touch/strokes.js messages.
function stroke(n, perBatch, extras) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ u: 0.3 + i * 0.004, v: 0.4 + Math.sin(i * 0.2) * 0.03 });
  const msgs = [];
  for (let at = 0; at < pts.length - 1; at += perBatch) {
    const end = Math.min(pts.length - 1, at + perBatch);
    msgs.push(encodeStroke(MOTIF, 10, BRUSH_W, at === 0 ? 0 : end === pts.length - 1 ? 2 : 1,
      pts.slice(at === 0 ? 0 : at, end + 1), extras));
  }
  return msgs;
}

// Plays msgs in at 45 ms apart while frames step at hz; returns how many
// stamps came out each frame and when the last came out (s after the last batch).
function play(msgs, hz, key) {
  take();
  const perFrame = [];
  const dt = 1 / hz;
  let t = 0, next = 0, sent = 0, lastAt = 0;
  while (sent < msgs.length || brushPlaying()) {
    while (sent < msgs.length && next <= t) { brushTake({ ...msgs[sent], id: key }); sent++; next += 0.045; if (sent === msgs.length) lastAt = t; }
    brushPlay(dt);
    t += dt;
    perFrame.push(brushQueue.count - perFrame.reduce((a, b) => a + b, 0));
    if (t > 30) break;
  }
  return { perFrame, drainedAfter: t - lastAt };
}

test('a continuous stroke glides out, and the figure is exactly the unsmoothed one', () => {
  const extras = { a: 2, m: 5, c: 3, f: 0.5 };
  const msgs = stroke(160, 6, extras);
  // the figure without playback: the pure walk over the same batches
  let carry = 0;
  const expect = [];
  for (const m of msgs) {
    const r = stampsFor(decodeStroke(m), carry);
    carry = r.carry;
    for (const st of r.stamps) expect.push([st.u, st.v, st.angle]);
  }
  const { perFrame, drainedAfter } = play(msgs, 120, 'a');
  const got = take();
  assert.equal(got.length, expect.length, 'every stamp, none lost or added');
  got.forEach((g, i) => {
    assert.ok(Math.abs(g[0] - expect[i][0]) < 1e-6 && Math.abs(g[1] - expect[i][1]) < 1e-6 && Math.abs(g[2] - expect[i][2]) < 1e-6, `stamp ${i} in place`);
    assert.deepEqual([g[4], g[5]], [5, 2]);
  });
  // spread over many frames rather than in a burst per batch: at 120 Hz a
  // 45 ms batch spans five or six frames, and most of them let stamps out
  const busy = perFrame.filter(n => n > 0).length;
  assert.ok(busy > msgs.length * 3, `${busy} frames let stamps out for ${msgs.length} batches`);
  // the end drains, never cut short, within a few time constants
  assert.ok(drainedAfter < 0.3, `drained ${(drainedAfter * 1000).toFixed(0)} ms after the last batch`);
});

test('a slowed stroke eases out print by print', () => {
  // four prints bunched in each batch (a network hiccup), three copies
  const msgs = [];
  for (let b = 0; b < 5; b++) {
    const pts = [];
    for (let i = 0; i < 4; i++) pts.push({ u: 0.2 + (b * 4 + i) * 0.02, v: 0.5 });
    msgs.push(encodeStroke(MOTIF, 10, BRUSH_W, b === 0 ? 0 : b === 4 ? 2 : 1, pts, { a: 1, m: 0, c: 3, f: 0.5, r: 0.3 }));
  }
  const { perFrame } = play(msgs, 60, 'b');
  const got = take();
  assert.equal(got.length, 20 * 3, 'all twenty prints with their copies');
  // never a whole bunch of four at once: at most two prints a frame
  assert.ok(Math.max(...perFrame) <= 2 * 3, 'max per frame ' + Math.max(...perFrame) / 3 + ' prints');
});

test('a stroke whose sender vanished still drains, and its slot frees', () => {
  const msgs = stroke(60, 6, { a: 1, m: 0, c: 1, f: 0.5 }).slice(0, 4);   // no last batch
  for (const m of msgs) brushTake({ ...m, id: 'gone' });
  let n = 0;
  while (brushPlaying() && n < 1000) { brushPlay(1 / 60); n++; }
  assert.ok(!brushPlaying(), 'freed');
  assert.ok(n / 60 > 3 && n / 60 < 4, `let go after ${(n / 60).toFixed(2)} s with nothing new`);
  let carry = 0, count = 0;
  for (const m of msgs) { const r = stampsFor(decodeStroke(m), carry); carry = r.carry; count += r.stamps.length; }
  assert.equal(take().length, count, 'every stamp it had, shown');
});

test('a new stroke from the same sender plays beside the one still draining', () => {
  const one = stroke(40, 6, { a: 1, m: 0, c: 1, f: 0.5 }), two = stroke(40, 6, { a: 1, m: 1, c: 1, f: 0.5 });
  for (const m of one) brushTake({ ...m, id: 's' });
  for (const m of two) brushTake({ ...m, id: 's' });
  while (brushPlaying()) brushPlay(1 / 60);
  const got = take();
  const ones = got.filter(g => g[4] === 0).length, twos = got.filter(g => g[4] === 1).length;
  assert.equal(ones + twos, got.length);
  assert.equal(ones, twos, 'both whole');
});
