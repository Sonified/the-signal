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

// ---------- the frame's share: the hand first ----------
import { pendingWindow, shareFrame } from '../core/brush-order.js';

// A ring as core/brush.js keeps it (8 floats a stamp here, the sender at
// float 6), wrapped round its end, filled with `spec` in arrival order:
// each [who, key]. The frame's draw as gpu/brush.js runs it, with every
// atlas in unless `ready` says otherwise: the window, the bake order, the
// share. Returns what was drawn, by arrival number, and the order.
const F8 = 8, CAP = 65536;
function ringOf(spec) {
  const q = { buf: new Float32Array(CAP * F8), key: new Float64Array(CAP), seq: new Float64Array(CAP), cap: CAP, head: CAP - 1000, count: 0 };
  for (const [who, key] of spec) {
    const at = (q.head + q.count) % CAP;
    q.buf[at * F8 + 6] = who; q.key[at] = key; q.seq[at] = q.count; q.count++;
  }
  return q;
}
function frame(q, hand, due, { headMax = 16384, handMax = 4096, maxInst = 8192, ready = () => 1 } = {}) {
  const P = headMax + handMax;
  const pos = new Int32Array(P), idx = new Int32Array(P), key = new Float64Array(P), place = new Float64Array(P);
  const who = new Float64Array(P), seq = new Float64Array(P), mine = new Uint8Array(P), rdy = new Uint8Array(P);
  const out = new Int32Array(maxInst), gone = new Uint8Array(P), pri = new Uint8Array(P);
  const n0 = q.count < headMax ? q.count : headMax;
  const n = pendingWindow(q, F8, hand, headMax, handMax, pos);
  for (let e = 0; e < n; e++) {
    const at = (q.head + pos[e]) % CAP;
    idx[e] = e; key[e] = q.key[at]; who[e] = q.buf[at * F8 + 6]; seq[e] = q.seq[at]; mine[e] = who[e] === hand ? 1 : 0;
    rdy[e] = ready(seq[e]);
  }
  bakeOrder(idx, n, key, place, who, seq);
  const s = shareFrame(idx, n, n0, key, mine, rdy, due, maxInst, handMax, pri, out, gone);
  const rank = new Map();
  for (let jj = 0; jj < n; jj++) rank.set(idx[jj], jj);
  const arr = e => seq[e];
  return {
    n, n0,
    baked: Array.from(out.subarray(0, s.bake), arr), live: Array.from(out.subarray(s.bake, s.inst), arr),
    ranks: Array.from(out.subarray(0, s.inst), e => rank.get(e)),
    dueInOrder: Array.from(idx.subarray(0, n)).filter(e => key[e] <= due).map(arr),
    gone: Array.from(gone.subarray(0, n)).reduce((a, g, e) => (g ? a.concat(seq[e]) : a), [])
  };
}
const REPLAY = 100001, HAND = 0;

test('the hand draws on the frame it made its marks, however long the replay\'s line', () => {
  // 30,000 replayed stamps waiting, all due (let out a delay old), then the
  // hand's 40 newest, made this frame, a few more of the tape's after them
  const spec = [];
  for (let i = 0; i < 30000; i++) spec.push([REPLAY, 1000 + i * 0.01]);
  for (let i = 0; i < 40; i++) spec.push([HAND, 2000]);
  for (let i = 0; i < 500; i++) spec.push([REPLAY, 1300 + i * 0.01]);
  const q = ringOf(spec), handSeqs = spec.map((s, i) => (s[0] === HAND ? i : -1)).filter(i => i >= 0);
  const f = frame(q, HAND, 1950);
  assert.equal(f.n0, 16384, 'the head window as ever');
  assert.equal(f.n, 16384 + 40, 'and the hand\'s 40 from beyond it');
  // every one of the hand's drawn, live (they are not due yet), on top
  assert.deepEqual(f.live, handSeqs);
  // the replay takes the rest of the frame, and only by baking a prefix of
  // the due stamps in order: the trail's layering is the time order still
  assert.equal(f.baked.length, 8192 - 40);
  assert.deepEqual(f.baked, f.dueInOrder.slice(0, f.baked.length));
  assert.deepEqual(f.gone, [...f.baked].sort((a, b) => a - b), 'only what baked leaves the ring');
  // what is drawn is drawn in the bake order, back to front
  for (let i = 1; i < f.ranks.length; i++) assert.ok(f.ranks[i] > f.ranks[i - 1], 'drawn in order');

  // as it was: no place kept for the hand, and it drew nothing at all
  const before = frame(q, HAND, 1950, { handMax: 0 });
  assert.equal(before.live.length, 0, 'the old frame starved the hand');
  assert.equal(before.baked.length, 8192);
});

test('the hand\'s due marks behind the line stay live till the line reaches them, never baked out of turn', () => {
  // the hand's stamps are due, but 9000 older due ones are ahead of them:
  // baking the hand's now would put those older marks on top of it later
  const spec = [];
  for (let i = 0; i < 9000; i++) spec.push([REPLAY, 1000 + i * 0.01]);
  for (let i = 0; i < 30; i++) spec.push([HAND, 1500]);
  const f = frame(ringOf(spec), HAND, 1950);
  assert.equal(f.live.filter(s => s >= 9000).length, 30, 'all the hand\'s drawn, live');
  assert.ok(f.baked.every(s => s < 9000), 'none of the hand\'s baked ahead of the older');
  assert.deepEqual(f.baked, f.dueInOrder.slice(0, f.baked.length));
  // with room for everything, the hand's bake in their turn, as ever
  const g = frame(ringOf(spec.slice(5000)), HAND, 1950);
  assert.equal(g.baked.length, 4030);
  assert.deepEqual(g.baked, g.dueInOrder);
  assert.equal(g.live.length, 0);
});

test('a hand stamp from beyond the window never bakes; a stamp without its atlas holds the bake; a failed set\'s go', () => {
  const spec = [];
  for (let i = 0; i < 100; i++) spec.push([REPLAY, 1000 + i]);
  spec.push([HAND, 1200]);
  const f = frame(ringOf(spec), HAND, 5000, { headMax: 50 });
  assert.deepEqual(f.live, [100], 'beyond the window: drawn live');
  assert.equal(f.baked.length, 50, 'the window baked whole, the hand left for its turn');
  assert.ok(!f.gone.includes(100));
  // stamp 10's atlas not in: it and everything after wait (and draw live
  // once in), stamp 5's set failed: it goes, drawn nowhere
  const h = frame(ringOf(spec), HAND, 5000, { ready: s => (s === 10 ? 0 : s === 5 ? 2 : 1) });
  assert.deepEqual(h.baked, [0, 1, 2, 3, 4, 6, 7, 8, 9]);
  assert.ok(h.gone.includes(5) && !h.live.includes(5) && !h.live.includes(10));
  assert.equal(h.live.length, 101 - 11, 'the rest live, the hand\'s among them');
  // the reservation: never more than handMax of the hand's, its newest
  const many = [];
  for (let i = 0; i < 20; i++) many.push([HAND, 3000 + i]);
  for (let i = 0; i < 100; i++) many.push([REPLAY, 1000 + i * 0.1]);
  const k = frame(ringOf(many), HAND, 1050, { maxInst: 60, handMax: 8 });
  assert.equal(k.baked.length + k.live.length, 60);
  for (let s = 12; s < 20; s++) assert.ok(k.live.includes(s), 'the newest 8 of the hand\'s always drawn');
});
