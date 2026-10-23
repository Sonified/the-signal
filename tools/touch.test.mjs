// The group touch foundation's pure parts (documents/touch-foundation.md):
// the hall's pairing and the stroke wire format.
//
//   node --test tools/touch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { pairGroups } from '../broadcast-worker/src/index.js';
import { encodeStroke, decodeStroke, BRUSHES, QUANT } from '../touch/strokes.js';

test('pairing: adjacent twos, an odd joiner folds into the last pair as a trio', () => {
  assert.deepEqual(pairGroups([]), []);
  assert.deepEqual(pairGroups([7]), [[7]]);
  assert.deepEqual(pairGroups([2, 1]), [[1, 2]]);
  assert.deepEqual(pairGroups([3, 1, 2]), [[1, 2, 3]]);
  assert.deepEqual(pairGroups([4, 2, 3, 1]), [[1, 2], [3, 4]]);
  assert.deepEqual(pairGroups([5, 4, 3, 2, 1]), [[1, 2], [3, 4, 5]]);
  // deterministic from the ids alone: any arrival order pairs the same
  assert.deepEqual(pairGroups([9, 12, 3, 30]), pairGroups([30, 3, 12, 9]));
});

test('strokes: the wire round-trips exactly to the quantum', () => {
  const pts = [{ u: 0, v: 1 }, { u: 0.25, v: 0.5 }, { u: 1 / 3, v: 0.9991 }];
  const msg = encodeStroke(2, 212, 22, 1, pts);
  assert.equal(msg.t, 's');
  const back = decodeStroke(msg);
  assert.ok(back);
  assert.equal(back.k, 2);
  assert.equal(back.h, 212);
  assert.equal(back.w, 22);
  assert.equal(back.d, 1);
  assert.equal(back.points.length, pts.length);
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Math.abs(back.points[i].u - pts[i].u) <= 0.5 / QUANT, `u ${i}`);
    assert.ok(Math.abs(back.points[i].v - pts[i].v) <= 0.5 / QUANT, `v ${i}`);
  }
  // a relayed copy survives JSON and the hall's id stamp
  const relayed = JSON.parse(JSON.stringify({ ...msg, id: 4 }));
  assert.ok(decodeStroke(relayed));
});

test('strokes: whatever a member said, malformed never draws', () => {
  const good = encodeStroke(0, 0, 1, 0, [{ u: 0.5, v: 0.5 }]);
  assert.ok(decodeStroke(good));
  for (const bad of [
    null, {}, { t: 's' },
    { ...good, k: BRUSHES.length },        // no such brush
    { ...good, k: -1 },
    { ...good, h: 360 },
    { ...good, w: 0 },
    { ...good, w: 101 },
    { ...good, d: 3 },
    { ...good, p: [1, 2, 3] },             // an odd coordinate
    { ...good, p: [] },
    { ...good, p: [QUANT + 1, 0] },        // out of the square
    { ...good, p: [-1, 0] },
    { ...good, p: 'nope' }
  ]) assert.equal(decodeStroke(bad), null, JSON.stringify(bad && bad.p !== undefined ? bad.p : bad));
});
