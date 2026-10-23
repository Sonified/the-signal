// The show's playback, its pure half (core/brush-replay.js): the tape
// planned into one pass on its common timeline, squeezed to fit, and each
// batch's point times laid on this screen's clock at the pass's scale.
//
//   node --test tools/brush-replay.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { planPass, retime, LOOP_MS, LOOP_REST_MS, REPLAY_ID } from '../core/brush-replay.js';
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
