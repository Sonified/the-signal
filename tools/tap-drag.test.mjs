// The field's tap-or-drag discriminator (core/tap-drag.js): a press is a
// tap unless it travels past meditatewiththesun.com's 14 px, and a drag's
// release never taps.
//
//   node --test tools/tap-drag.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTapDrag, tapDragStep, TAP_SLOP_PX,
  TD_NONE, TD_PENDING, TD_START, TD_MOVE, TD_TAP, TD_END, TD_CANCEL
} from '../core/tap-drag.js';

// Runs [type, x, y] steps on a fresh state; returns the results.
function run(steps) {
  const st = createTapDrag();
  return steps.map(([type, x, y]) => tapDragStep(st, type, x, y));
}

test('the threshold is the sun page\'s', () => assert.equal(TAP_SLOP_PX, 14));

test('a tap: down and up in place', () => {
  assert.deepEqual(run([['down', 100, 100], ['up', 100, 100]]), [TD_PENDING, TD_TAP]);
});

test('jitter under the threshold is still a tap', () => {
  assert.deepEqual(run([['down', 100, 100], ['move', 106, 97], ['move', 91, 108], ['move', 109, 109], ['up', 104, 103]]),
    [TD_PENDING, TD_PENDING, TD_PENDING, TD_PENDING, TD_TAP]);
  // exactly at the threshold is not past it
  assert.deepEqual(run([['down', 0, 0], ['move', 14, 0], ['up', 14, 0]]), [TD_PENDING, TD_PENDING, TD_TAP]);
});

test('a drag: past the threshold it starts, moves, and its release is no tap', () => {
  const st = createTapDrag();
  assert.equal(tapDragStep(st, 'down', 50, 60), TD_PENDING);
  assert.equal(tapDragStep(st, 'move', 60, 60), TD_PENDING);
  assert.equal(tapDragStep(st, 'move', 65, 61), TD_START);
  // the stroke is drawn from where the press went down
  assert.deepEqual([st.x0, st.y0], [50, 60]);
  assert.equal(tapDragStep(st, 'move', 120, 90), TD_MOVE);
  // coming back near the start keeps it a drag
  assert.equal(tapDragStep(st, 'move', 51, 60), TD_MOVE);
  assert.equal(tapDragStep(st, 'up', 50, 60), TD_END);
});

test('a slow drag crosses the threshold a pixel at a time', () => {
  const steps = [['down', 0, 0]];
  for (let x = 1; x <= 40; x++) steps.push(['move', x, 0]);
  steps.push(['up', 40, 0]);
  const r = run(steps);
  assert.equal(r.indexOf(TD_START), 15);           // the move to 15 px, the first past 14
  assert.ok(r.slice(1, 15).every(v => v === TD_PENDING));
  assert.ok(r.slice(16, 41).every(v => v === TD_MOVE));
  assert.equal(r[r.length - 1], TD_END);
});

test('a flick between two frames: the release frame\'s move counts', () => {
  assert.deepEqual(run([['down', 0, 0], ['move', 80, 30], ['up', 80, 30]]), [TD_PENDING, TD_START, TD_END]);
});

test('a cancel ends cleanly with no tap, drag or not', () => {
  assert.deepEqual(run([['down', 0, 0], ['cancel', 0, 0]]), [TD_PENDING, TD_CANCEL]);
  assert.deepEqual(run([['down', 0, 0], ['move', 30, 0], ['cancel', 30, 0]]), [TD_PENDING, TD_START, TD_CANCEL]);
});

test('nothing pressed, nothing happens; the state is ready for the next press', () => {
  const st = createTapDrag();
  assert.equal(tapDragStep(st, 'move', 5, 5), TD_NONE);
  assert.equal(tapDragStep(st, 'up', 5, 5), TD_NONE);
  tapDragStep(st, 'down', 0, 0); tapDragStep(st, 'move', 50, 0); tapDragStep(st, 'up', 50, 0);
  assert.equal(tapDragStep(st, 'down', 0, 0), TD_PENDING);
  assert.equal(tapDragStep(st, 'up', 0, 0), TD_TAP);
});
