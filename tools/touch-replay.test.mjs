// The replay's pure half (documents/touch-foundation.md): the scheduler
// that turns a hall's tape into the two movements - each drawer alone,
// compressed to a slot, then everyone on the common timeline.
//
//   node --test tools/touch-replay.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { planReplay, SOLO_MS, TOGETHER_MS } from '../touch/replay.js';
import { encodeStroke } from '../touch/strokes.js';

// a tape entry as the worker stores it: { at, id, s }
const stroke = (h = 200) => encodeStroke(0, h, 20, 1, [{ u: 0.4, v: 0.4 }, { u: 0.6, v: 0.6 }]);
const entry = (at, id, s = stroke()) => ({ at, id, s });

test('an empty or missing tape plans nothing', () => {
  assert.deepEqual(planReplay([]), { members: [], together: [] });
  assert.deepEqual(planReplay(undefined), { members: [], together: [] });
});

test('one short session plays at the pace the hand drew it (scale caps at 1)', () => {
  const plan = planReplay([entry(500, 1), entry(1500, 1), entry(3500, 1)], { soloMs: 12000 });
  assert.equal(plan.members.length, 1);
  assert.equal(plan.members[0].id, 1);
  assert.deepEqual(plan.members[0].plan.map(p => p.tMs), [0, 1000, 3000]);
  // the hue rides the first stroke
  assert.equal(plan.members[0].hue, 200);
});

test('one long session compresses to fit its slot', () => {
  const plan = planReplay([entry(0, 1), entry(6000, 1), entry(24000, 1)], { soloMs: 12000 });
  assert.deepEqual(plan.members[0].plan.map(p => p.tMs), [0, 3000, 12000]);
});

test('a single-batch session lands at zero rather than dividing by it', () => {
  const plan = planReplay([entry(7000, 3)], { soloMs: 12000 });
  assert.deepEqual(plan.members[0].plan.map(p => p.tMs), [0]);
});

test('several drawers: id order, each slot its own compression, own zero', () => {
  const plan = planReplay([
    entry(0, 2), entry(24000, 2),            // 24 s of drawer 2
    entry(30000, 1), entry(33000, 1)         // 3 s of drawer 1, later on the tape
  ], { soloMs: 12000 });
  assert.deepEqual(plan.members.map(m => m.id), [1, 2]);
  assert.deepEqual(plan.members[0].plan.map(p => p.tMs), [0, 3000]);    // natural pace
  assert.deepEqual(plan.members[1].plan.map(p => p.tMs), [0, 12000]);   // halved
});

test('the second movement scales the common timeline, offsets kept', () => {
  const plan = planReplay([
    entry(0, 1), entry(30000, 2), entry(90000, 1)
  ], { togetherMs: 45000 });
  assert.deepEqual(plan.together.map(p => p.tMs), [0, 15000, 45000]);
  // a tape shorter than the span plays as it happened
  const quick = planReplay([entry(100, 1), entry(2100, 2)], { togetherMs: 45000 });
  assert.deepEqual(quick.together.map(p => p.tMs), [0, 2000]);
});

test('malformed entries are skipped, never scheduled', () => {
  const bad = stroke();
  const plan = planReplay([
    entry(0, 1),
    { at: 100, id: 1, s: { ...bad, w: 0 } },     // decodeStroke refuses it
    { at: 200, id: 1, s: null },
    { id: 1, s: stroke() },                      // no time
    { at: 300, s: stroke() },                    // no drawer
    { at: 'soon', id: 1, s: stroke() },
    null,
    entry(1000, 1),
    { at: 50, id: 9, s: { t: 'nope' } }          // a drawer of nothing but noise
  ]);
  assert.deepEqual(plan.members.map(m => m.id), [1]);
  assert.equal(plan.members[0].plan.length, 2);
  assert.equal(plan.together.length, 2);
});

test('the defaults are the installation lengths', () => {
  assert.equal(SOLO_MS, 12000);
  assert.equal(TOGETHER_MS, 45000);
});
