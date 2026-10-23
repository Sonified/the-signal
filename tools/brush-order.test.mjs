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

// ---------- baking on the timeline ----------
import { bakeOrder, turnPlace } from '../core/brush-order.js';

// One screen's view of two hands stamping the same pixel: each stamp is
// (who, drawn at, on its sender's clock); this screen sees its own at once
// and the other's `lag` ms later (its playback maps it back to the time it
// was drawn, here exactly, as the min offset does for a steady link). Every
// frame the screen bakes what is a delay old, in bakeOrder, and draws the
// rest live over the trail in the same order; what shows at the pixel is
// the last stamp drawn. Returns the pixel's owner per frame.
function screen(stamps, me, lag, delay, frames, dt) {
  const trail = { top: null };
  const pending = [];
  const baked = [], shown = [], arrivedTop = [];
  let seq = 0, latest = null;
  for (let f = 0; f < frames; f++) {
    const now = f * dt;
    for (const s of stamps) {
      const arrives = s.who === me ? s.t : s.t + lag;
      if (arrives > now - dt && arrives <= now) {
        pending.push({ who: s.who, key: s.t, seq: seq++ });
        if (!latest || s.t >= latest.t) latest = s;
      }
    }
    const n = pending.length;
    const idx = new Int32Array(n), key = new Float64Array(n), place = new Float64Array(n), who = new Float64Array(n), sq = new Float64Array(n);
    pending.forEach((p, i) => { idx[i] = i; key[i] = p.key; who[i] = p.who; sq[i] = p.seq; place[i] = turnPlace(p.who, [1, 2], 2, Math.floor(now / 1000)); });
    bakeOrder(idx, n, key, place, who, sq);
    const keep = [];
    let live = null;
    for (const i of idx) {
      if (pending[i].key <= now - delay) trail.top = pending[i].who;   // baked in order: the last baked is on top
      else { keep.push(pending[i]); live = pending[i].who; }           // live in order: the last drawn is on top
    }
    pending.length = 0; pending.push(...keep);
    baked.push(trail.top);
    shown.push(live !== null ? live : trail.top);
    arrivedTop.push(latest ? latest.who : null);
  }
  return { baked, shown, arrivedTop };
}

test('two hands over one spot: the later drawing is on top, the same on every screen, never by arrival', () => {
  // A (1) and B (2) stamp the same pixel in alternating frames for 3 s,
  // each screen seeing the other's stamps 45 ms late
  const dt = 1000 / 60, stamps = [];
  for (let f = 0; f < 180; f++) stamps.push({ who: f % 2 ? 2 : 1, t: f * dt });
  const delay = 60;
  const A = screen(stamps, 1, 45, delay, 200, dt), B = screen(stamps, 2, 45, delay, 200, dt);
  for (let f = 0; f < 200; f++) {
    // the trail: identical on both screens every frame, and its top the
    // last stamp drawn a delay ago, whoever's it was and whenever it came
    assert.equal(A.baked[f], B.baked[f], `frame ${f}: both screens' trails agree`);
    let want = null;
    for (const s of stamps) if (s.t <= f * dt - delay) want = s.who;
    assert.equal(A.baked[f], want, `frame ${f}: the trail's top is the later drawing`);
    // on screen, the newest stamp this screen has, by drawing time
    assert.equal(A.shown[f], A.arrivedTop[f], `frame ${f}: A shows the latest drawn it has`);
    assert.equal(B.shown[f], B.arrivedTop[f], `frame ${f}: B shows the latest drawn it has`);
  }
  // once the hands stop, both screens settle on the same pixel for good
  assert.equal(A.shown[199], B.shown[199]);
  assert.equal(A.shown[199], stamps[stamps.length - 1].who);
});

test('baking order: by time, then this second\'s turn, sender, seq', () => {
  const key = Float64Array.from([10, 5, 10, 10, 5]);
  const who = Float64Array.from([2, 1, 1, 2, 2]);
  const seq = Float64Array.from([0, 1, 2, 3, 4]);
  const place = Float64Array.from([...who].map(w => turnPlace(w, [1, 2], 2, 0)));   // second 0: 1 in front
  const idx = Int32Array.from([0, 1, 2, 3, 4]);
  bakeOrder(idx, 5, key, place, who, seq);
  // time 5: 2's (behind) then 1's (front, on top); time 10: 2's in seq order, then 1's
  assert.deepEqual(Array.from(idx), [4, 1, 0, 3, 2]);
  // the next second the turn flips
  const place1 = Float64Array.from([...who].map(w => turnPlace(w, [1, 2], 2, 1)));
  const idx1 = Int32Array.from([0, 1, 2, 3, 4]);
  bakeOrder(idx1, 5, key, place1, who, seq);
  assert.deepEqual(Array.from(idx1), [1, 4, 2, 0, 3]);
});
