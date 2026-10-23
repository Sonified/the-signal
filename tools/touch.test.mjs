// The group touch foundation's pure parts (documents/touch-foundation.md):
// the hall's phases, groups and routes, and the stroke wire format.
//
//   node --test tools/touch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { pairGroups, phaseGroups, routes, PHASES, CONDUCTOR_HEARS_GROUPS } from '../broadcast-worker/src/index.js';
import { encodeStroke, decodeStroke, BRUSHES, QUANT, MOTIF } from '../touch/strokes.js';
import { planReplay } from '../touch/replay.js';

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

// ---------- the phases ----------

const range = n => Array.from({ length: n }, (_, i) => i + 1);
const shuffle = (a, seed) => {   // deterministic, so a failure reproduces
  const b = [...a];
  let x = seed;
  for (let i = b.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

// the sizes each phase must produce for a roster of n
function expectedSizes(phase, n) {
  if (phase === 'solo' || phase === 'master') return Array(n).fill(1);
  if (phase === 'all') return [n];
  if (phase === 'halves') return n < 2 ? [n] : [Math.floor(n / 2), n - Math.floor(n / 2)];
  const size = phase === 'pairs' ? 2 : 4;
  if (n < size) return [n];
  const sizes = Array(Math.floor(n / size)).fill(size);
  sizes[sizes.length - 1] += n % size;
  return sizes;
}

test('phases: the conductor order', () => {
  assert.deepEqual(PHASES, ['solo', 'master', 'pairs', 'quads', 'halves', 'all']);
});

test('groups: every phase, rosters 1..13 - coverage, no id twice, sizes, order', () => {
  for (const phase of PHASES) {
    assert.deepEqual(phaseGroups(phase, []), [], `${phase} empty`);
    for (let n = 1; n <= 13; n++) {
      // ids in joining order, with gaps (leavers) so nothing leans on 1..n
      const ids = range(n).map(i => i * 3 + 2);
      const groups = phaseGroups(phase, ids);
      const flat = groups.flat();
      const where = `${phase} n=${n}`;
      assert.equal(flat.length, n, `${where}: every id placed once`);
      assert.equal(new Set(flat).size, n, `${where}: no id in two groups`);
      assert.deepEqual([...flat].sort((x, y) => x - y), ids, `${where}: exactly the roster`);
      // order: joining order within and across groups (the flattened list
      // is the roster ascending)
      assert.deepEqual(flat, ids, `${where}: joining order`);
      assert.deepEqual(groups.map(g => g.length), expectedSizes(phase, n), `${where}: sizes`);
      for (const g of groups) assert.ok(g.length > 0, `${where}: no empty group`);
      // deterministic from the ids alone, whatever order they arrive in
      for (const seed of [1, 7, 42]) {
        assert.deepEqual(phaseGroups(phase, shuffle(ids, seed)), groups, `${where}: shuffled ${seed}`);
      }
    }
  }
});

test('groups: the spec, spelled out', () => {
  assert.deepEqual(phaseGroups('quads', range(9)), [[1, 2, 3, 4], [5, 6, 7, 8, 9]]);
  assert.deepEqual(phaseGroups('quads', range(11)), [[1, 2, 3, 4], [5, 6, 7, 8, 9, 10, 11]]);
  assert.deepEqual(phaseGroups('quads', range(3)), [[1, 2, 3]]);
  assert.deepEqual(phaseGroups('halves', range(7)), [[1, 2, 3], [4, 5, 6, 7]]);
  assert.deepEqual(phaseGroups('halves', range(1)), [[1]]);
  assert.deepEqual(phaseGroups('pairs', range(5)), pairGroups(range(5)));
  // quads sizes stay 4..7 once the roster reaches 4
  for (let n = 4; n <= 40; n++) {
    for (const g of phaseGroups('quads', range(n))) assert.ok(g.length >= 4 && g.length <= 7, `quads n=${n}`);
  }
  // an unknown phase is solo
  assert.deepEqual(phaseGroups('nope', [2, 1]), [[1], [2]]);
});

// routes(phase, ids, conductors): id -> { to, with }
const toOf = (r, id) => r.get(id).to;
const withOf = (r, id) => r.get(id).with;

test('routes: solo reaches nobody, conductor included', () => {
  const r = routes('solo', [1, 2, 3, 4], [1]);
  for (const id of [1, 2, 3, 4]) {
    assert.deepEqual(toOf(r, id), []);
    assert.deepEqual(withOf(r, id), [id]);
  }
});

test('routes: master - the conductor reaches everyone, members reach nobody', () => {
  const r = routes('master', [1, 2, 3, 4, 5], [3]);
  assert.deepEqual(toOf(r, 3), [1, 2, 4, 5]);
  for (const id of [1, 2, 4, 5]) {
    assert.deepEqual(toOf(r, id), [], `member ${id} relays to nobody`);
    assert.deepEqual(withOf(r, id), [id, 3].sort((x, y) => x - y), `member ${id} hears the conductor`);
  }
  assert.deepEqual(withOf(r, 3), [3]);   // nobody reaches the conductor
  // no conductor present: master is everyone alone
  const empty = routes('master', [1, 2], []);
  assert.deepEqual(toOf(empty, 1), []);
  assert.deepEqual(toOf(empty, 2), []);
});

test('routes: pairs, quads, halves - drawers in their groups, the conductor apart', () => {
  assert.equal(CONDUCTOR_HEARS_GROUPS, false);
  // conductor id 1 joined first; the drawers 2..8 group without it
  const ids = range(8), cond = [1], drawers = ids.slice(1);
  for (const phase of ['pairs', 'quads', 'halves']) {
    const r = routes(phase, ids, cond);
    assert.deepEqual(toOf(r, 1), [], `${phase}: the conductor reaches nobody`);
    assert.deepEqual(withOf(r, 1), [1], `${phase}: the conductor hears nobody`);
    for (const g of phaseGroups(phase, drawers)) {
      for (const id of g) {
        assert.deepEqual(toOf(r, id), g.filter(x => x !== id), `${phase}: ${id} to its group`);
        assert.deepEqual(withOf(r, id), g, `${phase}: ${id} told its group`);
      }
    }
  }
  // the flip: the conductor hears every drawer, and still reaches nobody
  const heard = routes('quads', ids, cond, { conductorHears: true });
  assert.deepEqual(withOf(heard, 1), ids);
  assert.deepEqual(toOf(heard, 1), []);
  // seven drawers (2..8) make one group of seven under quads
  assert.deepEqual(toOf(heard, 2), [1, 3, 4, 5, 6, 7, 8]);
});

test('routes: all - everyone reaches everyone, the conductor too', () => {
  const ids = [2, 5, 9, 11];
  const r = routes('all', ids, [9]);
  for (const id of ids) {
    assert.deepEqual(toOf(r, id), ids.filter(x => x !== id));
    assert.deepEqual(withOf(r, id), ids);
  }
});

test('routes: every phase, rosters 1..13 - nobody relays to itself, with matches to', () => {
  for (const phase of PHASES) {
    for (let n = 1; n <= 13; n++) {
      const ids = range(n);
      for (const cond of [[], [1], [n]]) {
        const r = routes(phase, ids, cond);
        assert.equal(r.size, n);
        for (const id of ids) {
          assert.ok(!toOf(r, id).includes(id), `${phase} n=${n}: ${id} to itself`);
          assert.ok(withOf(r, id).includes(id));
          // with = me plus exactly those whose to names me
          const senders = ids.filter(x => toOf(r, x).includes(id));
          assert.deepEqual(withOf(r, id), [id, ...senders].sort((x, y) => x - y), `${phase} n=${n} with ${id}`);
        }
      }
    }
  }
});

// ---------- the motif brush ----------

const motifPts = [{ u: 0.5, v: 0.5 }, { u: 0.6, v: 0.4 }];
const motif = (extras = { a: 3, m: 17, c: 8, f: 0.35 }) => encodeStroke(MOTIF, 200, 30, 0, motifPts, extras);

test('motif: appended as the fifth brush, the first four in place', () => {
  assert.equal(MOTIF, 4);
  assert.deepEqual(BRUSHES.map(b => b.id), ['ink', 'ribbon', 'orbs', 'spark', 'motif']);
});

test('motif: the wire carries a, m, c, f and decodes them', () => {
  const msg = motif();
  assert.deepEqual([msg.a, msg.m, msg.c, msg.f], [3, 17, 8, 0.35]);
  const back = decodeStroke(JSON.parse(JSON.stringify({ ...msg, id: 6 })));
  assert.ok(back);
  assert.equal(back.k, MOTIF);
  assert.deepEqual([back.a, back.m, back.c, back.f], [3, 17, 8, 0.35]);
  // the edges of every range
  for (const ex of [
    { a: 1, m: 0, c: 1, f: 0 },
    { a: 99, m: 63, c: 24, f: 1 }
  ]) assert.ok(decodeStroke(motif(ex)), JSON.stringify(ex));
  // only the four extras are copied onto the message
  const extra = encodeStroke(MOTIF, 0, 1, 0, motifPts, { a: 1, m: 0, c: 1, f: 0, z: 9 });
  assert.equal(extra.z, undefined);
});

test('motif: missing or out of range refuses the stroke', () => {
  const good = motif();
  const drop = f => { const o = { ...good }; delete o[f]; return o; };
  for (const bad of [
    drop('a'), drop('m'), drop('c'), drop('f'),
    { ...good, a: 0 }, { ...good, a: 100 }, { ...good, a: 2.5 }, { ...good, a: '3' },
    { ...good, m: -1 }, { ...good, m: 64 }, { ...good, m: 1.5 }, { ...good, m: null },
    { ...good, c: 0 }, { ...good, c: 25 }, { ...good, c: 4.2 },
    { ...good, f: -0.01 }, { ...good, f: 1.01 }, { ...good, f: NaN }, { ...good, f: '0.5' }, { ...good, f: null },
    encodeStroke(MOTIF, 200, 30, 0, motifPts)   // no extras at all
  ]) assert.equal(decodeStroke(bad), null, JSON.stringify(bad));
});

test('motif: other brushes decode as before, extras or not', () => {
  for (let k = 0; k < MOTIF; k++) {
    const plain = encodeStroke(k, 100, 10, 1, motifPts);
    assert.deepEqual(Object.keys(plain), ['t', 'k', 'h', 'w', 'd', 'p']);
    const a = decodeStroke(plain);
    assert.deepEqual(Object.keys(a), ['k', 'h', 'w', 'd', 'points']);
    // stray or broken extras on a non-motif stroke are ignored, not judged
    const b = decodeStroke({ ...plain, a: 500, m: -3, c: 'x', f: 9 });
    assert.deepEqual(b, a);
  }
});

test('motif: a tape entry carrying the extras replays', () => {
  const { members } = planReplay([{ at: 0, id: 2, s: motif() }, { at: 10, id: 2, s: motif({ a: 3 }) }]);
  assert.equal(members.length, 1);
  assert.equal(members[0].plan.length, 1);   // the one missing m, c, f is skipped
  assert.equal(members[0].plan[0].stroke.m, 17);
});
