// The show's playback, its pure half (core/brush-replay.js): the tape
// planned into one pass on its common timeline, squeezed to fit, and each
// batch's point times laid on this screen's clock at the pass's scale.
//
//   node --test tools/brush-replay.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { planPass, retime, LOOP_MS, LOOP_REST_MS, REPLAY_ID, ROOM_HANDS, ROOM_WINDOW_MS, roomLeaves, endMotion, fadeTail, REST_MS } from '../core/brush-replay.js';
import { encodeStroke, decodeStroke, MOTIF } from '../touch/strokes.js';

const motif = (d, q) => encodeStroke(MOTIF, 200, 50, d, [{ u: 0.4, v: 0.4 }, { u: 0.5, v: 0.5 }, { u: 0.6, v: 0.6 }],
  Object.assign({ a: 1, m: 3, c: 6, f: 0.5 }, q ? { q } : {}));
const entry = (at, id, s = motif(1)) => ({ at, id, s });

test('an empty or missing tape plans an empty pass', () => {
  assert.deepEqual(planPass([]), { steps: [], scale: 1, ms: 0 });
  assert.deepEqual(planPass(undefined), { steps: [], scale: 1, ms: 0 });
});

test('a short drawing plays at the pace it was drawn, then rests', () => {
  const p = planPass([entry(500, 1), entry(1500, 2), entry(3500, 1)]);
  assert.equal(p.scale, 1);
  assert.deepEqual(p.steps.map(s => s.tMs), [0, 1000, 3000]);
  assert.deepEqual(p.steps.map(s => s.id), [1, 2, 1]);
  assert.equal(p.ms, 3000 + LOOP_REST_MS);
});

test('a long drawing is squeezed into the loop, everyone on one timeline', () => {
  const span = LOOP_MS * 10;
  const p = planPass([entry(0, 1), entry(span / 2, 2), entry(span, 3)]);
  assert.equal(p.scale, 0.1);
  assert.deepEqual(p.steps.map(s => s.tMs), [0, LOOP_MS / 2, LOOP_MS]);
  assert.equal(p.ms, LOOP_MS + LOOP_REST_MS);
});

test('entries without a time, a drawer or a stroke are skipped', () => {
  const p = planPass([{ at: 1, s: motif(0) }, { id: 1, s: motif(0) }, { at: 2, id: 1 }, null, entry(10, 4)]);
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].id, 4);
});

// Where the pass begins: the room arriving (more than three drawers inside
// ROOM_WINDOW_MS), or the whole marked tape when it never does.
const ats = p => p.steps.map(s => s.tMs / p.scale);

test('the room arrives at four hands inside a minute and a half', () => {
  assert.equal(ROOM_HANDS, 4);
  assert.equal(ROOM_WINDOW_MS, 90000);
});

test('one drawer alone plays the whole marked tape', () => {
  const tape = [];
  for (let i = 0; i < 40; i++) tape.push(entry(i * 5000, 1));
  const p = planPass(tape);
  assert.equal(p.steps.length, 40);
  assert.equal(p.skipped, 0);
  assert.equal(p.drawers, 0);
  assert.equal(p.steps[0].tMs, 0);
});

test('three drawers interleaved (Robert testing) still play the whole tape', () => {
  const tape = [];
  for (let i = 0; i < 60; i++) tape.push(entry(i * 1000, 1 + (i % 3)));
  const p = planPass(tape);
  assert.equal(p.steps.length, 60);
  assert.equal(p.skipped, 0);
  assert.equal(p.drawers, 0);
});

test('a fourth drawer joining starts the pass at the earliest batch of its window', () => {
  // Robert's three devices for ten minutes, one batch every 10 s
  const tape = [];
  for (let t = 0; t <= 600000; t += 10000) tape.push(entry(t, 1 + ((t / 10000) % 3)));
  const before = tape.length;
  // a fourth hand at T, then everyone together
  const T = 605000;
  tape.push(entry(T, 9));
  for (let t = T + 1000; t < T + 30000; t += 1000) tape.push(entry(t, 1 + (t % 5)));
  const p = planPass(tape);
  // the window ending at T reaches back to T - 90 s: batches from 520000 on
  const first = tape.findIndex(e => e.at >= T - ROOM_WINDOW_MS);
  assert.equal(tape[first].at, 520000);
  assert.equal(p.skipped, first);
  assert.equal(p.drawers, 4);
  assert.equal(p.steps.length, tape.length - first);
  assert.equal(p.steps[0].tMs, 0);
  assert.deepEqual(p.steps.map(s => s.id), tape.slice(first).map(e => e.id));
  assert.ok(first < before && first > 0);
  // the window is closed: a batch exactly 90 s before the fourth hand counts
  const edge = planPass([entry(0, 1), entry(1000, 2), entry(2000, 3), entry(90000, 4)]);
  assert.equal(edge.skipped, 0);
  assert.equal(edge.drawers, 4);
  const past = planPass([entry(0, 1), entry(1000, 2), entry(2000, 3), entry(90001, 4)]);
  assert.equal(past.drawers, 0);
});

test('four drawers never inside one window play the whole tape', () => {
  // each drawer's batches sit 100 s apart from the next drawer's
  const tape = [];
  for (let d = 0; d < 6; d++) for (let k = 0; k < 5; k++) tape.push(entry(d * 100000 + k * 1000, 1 + (d % 4)));
  // and pairs that overlap but never reach four
  tape.push(entry(700000, 1), entry(700500, 2), entry(701000, 3));
  const p = planPass(tape);
  assert.equal(p.skipped, 0);
  assert.equal(p.drawers, 0);
  assert.equal(p.steps.length, tape.length);
});

test('a re-plan after more batches arrive finds the same start', () => {
  const tape = [];
  for (let t = 0; t < 300000; t += 5000) tape.push(entry(t, 1 + ((t / 5000) % 2)));
  tape.push(entry(300000, 3), entry(310000, 4), entry(320000, 5));
  const a = planPass(tape);
  assert.ok(a.skipped > 0);
  const start = a.steps[0];
  for (let t = 330000; t < 900000; t += 2000) tape.push(entry(t, 1 + (t % 7)));
  const b = planPass(tape);
  assert.equal(b.skipped, a.skipped);
  assert.equal(b.steps[0].s, start.s);
  assert.equal(b.steps.length, tape.length - a.skipped);
  assert.deepEqual(ats(b).slice(0, a.steps.length).map(Math.round), ats(a).map(Math.round));
});

test('retime: the batch ends at base, its points closer by the scale, under the replay key', () => {
  // drawn at 10000, +40, +60 on the sender's clock
  const s = motif(1, [10000, 40, 60]);
  const m = retime({ id: 7, s }, 50000.4, 0.5);
  assert.equal(m.id, REPLAY_ID + 7);
  assert.deepEqual(m.q, [49950, 20, 30]);
  const d = decodeStroke(m);
  assert.ok(d, 'still a valid stroke');
  assert.deepEqual(d.times, [49950, 49970, 50000]);
  // the tape's own copy is untouched
  assert.deepEqual(s.q, [10000, 40, 60]);
});

test('retime: rounding never drifts and gaps stay whole and non-negative', () => {
  const s = motif(1, [1000, 16, 17]);
  const m = retime({ id: 1, s }, 9000, 0.03);
  const d = decodeStroke(m);
  assert.ok(d);
  assert.equal(d.times[2], 9000);
  for (const g of m.q.slice(1)) assert.ok(Number.isInteger(g) && g >= 0);
});

test('retime: a stroke with no times plays on the glide', () => {
  const m = retime({ id: 2, s: motif(0) }, 5000, 0.2);
  assert.equal(m.q, undefined);
  assert.ok(decodeStroke(m));
});

test('real time (the standing playback): a tape longer than the loop keeps scale 1 and its whole length', () => {
  const span = LOOP_MS * 10;
  const p = planPass([entry(0, 1), entry(span / 2, 2), entry(span, 3)], Infinity);
  assert.equal(p.scale, 1);
  assert.deepEqual(p.steps.map(s => s.tMs), [0, span / 2, span]);
  assert.equal(p.ms, span + LOOP_REST_MS);
  // the show's own pass of the same tape is still squeezed
  assert.equal(planPass([entry(0, 1), entry(span / 2, 2), entry(span, 3)]).scale, 0.1);
});

test('real time: retime at scale 1 keeps every point gap as drawn', () => {
  const m = retime({ id: 3, s: motif(1, [10000, 40, 60]) }, 70000, 1);
  assert.deepEqual(m.q, [69900, 40, 60]);
});

test('replay size: a stroke drawn at w 50 plays at 100 at 2x, held to the wire\'s 1 to 100', () => {
  const s = motif(1, [1000, 20, 20]);
  assert.equal(s.w, 50);
  assert.equal(retime({ id: 1, s }, 5000, 1).w, 50, 'as drawn by default');
  assert.equal(retime({ id: 1, s }, 5000, 1, 2).w, 100);
  assert.equal(retime({ id: 1, s }, 5000, 1, 4).w, 100, 'held at the top');
  assert.equal(retime({ id: 1, s }, 5000, 1, 0.25).w, 13);
  assert.equal(retime({ id: 1, s: Object.assign({}, s, { w: 2 }) }, 5000, 1, 0.25).w, 1, 'never under 1');
  assert.ok(decodeStroke(retime({ id: 1, s }, 5000, 1, 2)));
  assert.equal(s.w, 50, 'the tape\'s own copy untouched');
});

test('replay speed: the gaps at the pass\'s scale over the speed, 0.5x twice as far apart, 2x half', () => {
  const s = motif(1, [10000, 40, 60]);
  assert.deepEqual(retime({ id: 1, s }, 50000, 1 / 0.5).q, [49800, 80, 120]);
  assert.deepEqual(retime({ id: 1, s }, 50000, 1 / 2).q, [49950, 20, 30]);
});

test('trim event: the pass ends where the room leaves, off plays whole, solo untouched', () => {
  // four hands dense for 60 s, then one straggler on to 400 s
  const tape = [];
  for (let t = 0; t <= 60000; t += 500) tape.push({ at: t, id: 1 + ((t / 500) % 4), s: { t: 's' } });
  for (let t = 70000; t <= 400000; t += 5000) tape.push({ at: t, id: 9, s: { t: 's' } });
  const whole = planPass(tape, Infinity, 0, false);
  assert.equal(whole.steps.length, tape.length);
  assert.equal(whole.trimmed, 0);
  const cut = planPass(tape, Infinity, 0, true);
  assert.ok(cut.trimmed > 0, 'the stragglers are cut');
  // the cut breathes at most the leave window past the last crowded batch (60 s)
  const endT = cut.steps[cut.steps.length - 1].tMs;
  assert.ok(endT >= 60000 && endT <= 60000 + 15000, 'ends within the leave window of the cliff, got ' + endT);
  // a solo tape (room never arrives) plays whole even with trim on
  const solo = [];
  for (let t = 0; t <= 100000; t += 1000) solo.push({ at: t, id: 1, s: { t: 's' } });
  const sp = planPass(solo, Infinity, 0, true);
  assert.equal(sp.steps.length, solo.length);
  assert.equal(sp.trimmed, 0);
});

// A line across at v 0.5, u from `u0` by `du` a point, the points `gap` ms
// apart from t0, as batches of `per` new points (each later one led by its
// joint, as the hand's are), the last d 2.
function line(u0, du, n, t0, gap, per = 3, extra = {}) {
  const out = [];
  let i = 0;
  while (i < n) {
    const from = i === 0 ? 0 : i - 1, to = Math.min(n, i + per);
    const pts = [], ts = [];
    for (let j = from; j < to; j++) { pts.push({ u: u0 + du * j, v: 0.5 }); ts.push(t0 + gap * j); }
    const q = ts.map((t, k) => k ? t - ts[k - 1] : t);
    const d = to >= n ? 2 : i === 0 ? 0 : 1;
    out.push(encodeStroke(MOTIF, 200, 50, d, pts, Object.assign({ a: 1, m: 3, c: 6, f: 0.5, q }, extra)));
    i = to;
  }
  return out;
}

test('fade down: endMotion reads the way and pace of the last few points, joints left out', () => {
  const b = line(0.3, 0.02, 9, 1000, 20);
  const e = endMotion(b);
  assert.ok(e);
  assert.ok(Math.abs(e.vu - 0.001) < 2e-5, 'a fiftieth of the field per 20 ms, got ' + e.vu);
  assert.equal(e.vv, 0);
  assert.equal(e.gap, 20);
  assert.equal(endMotion(b, REST_MS), null, 'a hand held still before lifting gets no tail');
  assert.equal(endMotion(b, REST_MS - 1) !== null, true);
  // a last batch of only its joint repeats the point before and counts once
  const only = encodeStroke(MOTIF, 200, 50, 2, [{ u: 0.3 + 0.02 * 8, v: 0.5 }], { a: 1, m: 3, c: 6, f: 0.5, q: [1160] });
  b[b.length - 1].d = 1;
  assert.equal(endMotion(b.concat([only])).gap, 20);
});

test('fade down: the tail carries on along the line at its pace, after the real end, on this clock', () => {
  const b = line(0.3, 0.02, 9, 1000, 20), last = b[b.length - 1];
  const step = { id: 4, s: last, end: endMotion(b) };
  const plain = retime(step, 50000, 1);
  const m = retime(step, 50000, 1, 1, 0, 100);
  assert.equal(m.fe, 50000, 'the real end is where the batch ends');
  assert.equal(m.fd, 100);
  assert.equal(m.q.length, plain.q.length + 5, '100 ms of tail at 20 ms a point');
  assert.deepEqual(m.q.slice(plain.q.length), [20, 20, 20, 20, 20]);
  const d = decodeStroke(m);
  assert.ok(d, 'still a valid stroke');
  assert.equal(d.times[d.times.length - 1], 50100);
  const endU = d.points[d.points.length - 1].u, realU = d.points[plain.q.length - 1].u;
  assert.ok(Math.abs(endU - realU - 0.1) < 0.002, 'a tenth further along, got ' + (endU - realU));
  assert.equal(d.points[d.points.length - 1].v, 0.5);
  // the tape's own copy is untouched
  assert.equal(last.p.length, plain.p.length);
  // at 0.5x (scale 2) the same tail, twice as long on this clock
  const slow = retime(step, 50000, 2, 1, 50, 100);
  assert.equal(slow.fd, 200);
  assert.equal(slow.fu, 100);
  assert.deepEqual(slow.q.slice(plain.q.length), [40, 40, 40, 40, 40]);
  // off, or a batch that is not the stroke's last, gets none
  assert.deepEqual(retime(step, 50000, 1, 1, 0, 0), plain);
  assert.equal(retime(Object.assign({}, step, { s: b[0] }), 50000, 1, 1, 0, 100).fe, undefined);
});

test('fade down: the tail stops at the field\'s edge, and a still or print stroke gets what falls inside', () => {
  const b = line(0.8, 0.04, 5, 1000, 20), last = b[b.length - 1];
  const m = retime({ id: 1, s: last, end: endMotion(b) }, 9000, 1, 1, 0, 2000);
  assert.ok(decodeStroke(m), 'every point inside the square');
  assert.ok(m.p.length / 2 - last.p.length / 2 < 10, 'stopped at the edge');
  // a line that barely moves adds nothing
  const still = retime({ id: 1, s: last, end: { vu: 1e-9, vv: 0, gap: 20 } }, 9000, 1, 1, 0, 100);
  assert.equal(still.p.length, last.p.length);
  // prints: one at each print interval inside the tail, none when the first falls past it
  const pr = fadeTail({ p: [2048, 2048], q: [1000] }, { vu: 0.0001, vv: 0, gap: 300, prints: true }, 1000, 1000, 1);
  assert.deepEqual(pr.q, [1000, 300, 300, 300]);
  const none = fadeTail({ p: [2048, 2048], q: [1000] }, { vu: 0.0001, vv: 0, gap: 300, prints: true }, 200, 1000, 1);
  assert.deepEqual(none.q, [1000]);
});

test('fade down: the pass gives a finished stroke its end, but not one whose hand rested before lifting', () => {
  const b = line(0.3, 0.02, 9, 1000, 20);
  const tape = b.map(s => { let t = 0; for (const x of s.q) t += x; return { at: t + 50, id: 1, s }; });
  const p = planPass(tape, Infinity, 0);
  assert.ok(p.steps[p.steps.length - 1].end, 'the d 2 step carries how it ended');
  assert.equal(p.steps[0].end, undefined);
  tape[tape.length - 1] = Object.assign({}, tape[tape.length - 1], { at: tape[tape.length - 1].at + 400 });
  assert.equal(planPass(tape, Infinity, 0).steps.at(-1).end, undefined);
});
