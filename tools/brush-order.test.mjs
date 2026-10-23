// Who is in front where two hands overlap (core/brush-order.js): the front
// turns once a second, one sender's own stamps keep their order.
//
//   node --test tools/brush-order.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { frameOrder, noteSender, forgetIdle, activeSenders, resetSenders } from '../core/brush-order.js';

const order = (who, ids, sec) => {
  const n = who.length;
  const out = new Int32Array(n), rank = new Int32Array(n), tally = new Int32Array(ids.length + 2);
  return Array.from(frameOrder(who, n, ids, ids.length, sec, out, rank, tally)).map(i => who[i] + ':' + i);
};

test('the same stamps in the same second: the same order, the front last, each sender\'s in turn', () => {
  const who = [7, 3, 7, 3, 3, 7], ids = [3, 7];
  const a = order(who, ids, 1000), b = order(who, ids, 1000.9);
  assert.deepEqual(a, b);
  // second 1000: 1000 % 2 = 0, so 3 is in front and goes in last
  assert.deepEqual(a, ['7:0', '7:2', '7:5', '3:1', '3:3', '3:4']);
});

test('across the second boundary the front changes', () => {
  const who = [7, 3, 7, 3], ids = [3, 7];
  assert.deepEqual(order(who, ids, 1001), ['3:1', '3:3', '7:0', '7:2']);
  assert.notDeepEqual(order(who, ids, 1001), order(who, ids, 1002));
  // three senders take turns, the rest behind in rotation
  const three = [1, 2, 3], ids3 = [1, 2, 3];
  // back to front: the one furthest behind in rotation, then the next, the front last
  assert.deepEqual(order(three, ids3, 0), ['3:2', '2:1', '1:0']);
  assert.deepEqual(order(three, ids3, 3), order(three, ids3, 0), 'every count seconds round again');
  assert.equal(order(three, ids3, 0).pop(), '1:0');
  assert.equal(order(three, ids3, 1).pop(), '2:1');
  assert.equal(order(three, ids3, 2).pop(), '3:2');
  // just behind the front: the one after it in rotation
  assert.deepEqual(order(three, ids3, 1), ['1:0', '3:2', '2:1']);
});

test('a single sender is untouched; one not yet noted goes to the back', () => {
  assert.deepEqual(order([5, 5, 5], [5], 77), ['5:0', '5:1', '5:2']);
  assert.deepEqual(order([9, 5, 9], [5], 77), ['9:0', '9:2', '5:1']);
});

test('the active senders: ascending, kept through the next second, then let go', () => {
  resetSenders();
  noteSender(7, 10); noteSender(-1, 10); noteSender(3, 10); noteSender(7, 10);
  assert.deepEqual(Array.from(activeSenders.ids.subarray(0, activeSenders.n)), [-1, 3, 7]);
  noteSender(3, 11);
  forgetIdle(11);
  assert.equal(activeSenders.n, 3, 'last second still counts');
  forgetIdle(12);
  assert.deepEqual(Array.from(activeSenders.ids.subarray(0, activeSenders.n)), [3]);
});
