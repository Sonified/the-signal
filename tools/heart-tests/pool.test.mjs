// The pool (js/heart/pool.js): worker counts, stage roles, island placement.
//
//   node tools/heart-tests/pool.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE, defaultWorkers, planStages, Placement } from '../../js/heart/pool.js';

test('worker count: one combined worker on two cores or fewer, else islands clamp(cores - 2, 1, 4) plus the mix', () => {
  const want = { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 16: 5 };
  for (const [cores, n] of Object.entries(want)) assert.equal(defaultWorkers(+cores), n, `${cores} cores`);
  assert.equal(defaultWorkers(undefined), 1, 'unknown core count plays safe');
});

test('stages: stage 0 is the combined stage or the mix, the rest islands', () => {
  assert.deepEqual(planStages(1), [{ id: 0, role: ROLE.combined, islands: [] }]);
  const five = planStages(5);
  assert.equal(five.length, 5);
  assert.equal(five[0].role, ROLE.mix);
  assert.ok(five.slice(1).every((s, i) => s.role === ROLE.island && s.id === i + 1));
});

test('placement: one worker puts every island on stage 0', () => {
  const p = new Placement(planStages(1));
  for (const island of ['music', 'clouds', 'genus']) assert.equal(p.stageFor(island), 0);
  assert.deepEqual(p.stages[0].islands, ['music', 'clouds', 'genus']);
});

test('placement: greedy by weight, stable, never on the mix', () => {
  const stages = planStages(3);           // mix + islands 1, 2
  const p = new Placement(stages);
  p.weigh('music', 3);
  assert.equal(p.stageFor('music'), 1);   // both empty: the lowest id
  assert.equal(p.stageFor('clouds'), 2);  // 3 against 0
  assert.equal(p.stageFor('ambience'), 2);// 3 against 1
  assert.equal(p.stageFor('genus'), 2);   // 3 against 2
  assert.equal(p.stageFor('choir'), 1);   // 3 against 3: the lowest id
  assert.equal(p.stageFor('music'), 1, 'stable');
  assert.equal(p.stageFor('clouds'), 2, 'stable');
  assert.deepEqual(stages[1].islands, ['music', 'choir']);
  assert.deepEqual(stages[2].islands, ['clouds', 'ambience', 'genus']);
  assert.deepEqual(stages[0].islands, []);
});

test('placement: a weight given after placement moves nothing but counts for later islands', () => {
  const p = new Placement(planStages(3));
  assert.equal(p.stageFor('a'), 1);
  assert.equal(p.stageFor('b'), 2);
  p.weigh('b', 10);
  assert.equal(p.stageFor('b'), 2);
  assert.equal(p.stageFor('c'), 1);
  assert.equal(p.stageFor('d'), 1);
});
