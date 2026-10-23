// The brush's pure parts (core/brush-stamps.js) and its one guarantee: a
// stroke drawn here and the same stroke arriving from the hall stamp the
// very same figure (core/brush.js, through touch/strokes.js's wire).
//
//   node --test tools/brush-stamps.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stampCopies, walkBatch, walkSegment, stampsFor, fieldSquare, brushSpacing, brushSide, BRUSH_W,
  fadeSeconds, fadeHalfLife, fadeLabel, fadeFromText, FADE_HALVINGS
} from '../core/brush-stamps.js';
import { encodeStroke, decodeStroke, MOTIF, QUANT } from '../touch/strokes.js';
import { S } from '../js/state.js';
import { brushField, brushTake, setBrushHall, brushQueue, brushQueueDrop, STAMP_FLOATS } from '../core/brush.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('copies: evenly spaced about the centre, the sprite turned with each', () => {
  for (const c of [1, 2, 3, 6, 24]) {
    const got = [];
    stampCopies(0.8, 0.35, c, (u, v, angle, copy) => got.push({ u, v, angle, copy }));
    assert.equal(got.length, c);
    const r0 = Math.hypot(0.8 - 0.5, 0.35 - 0.5), a0 = Math.atan2(0.35 - 0.5, 0.8 - 0.5);
    got.forEach((s, i) => {
      assert.equal(s.copy, i);
      assert.ok(close(s.angle, 2 * Math.PI * i / c), `angle of copy ${i} of ${c}`);
      // the same distance from the centre, turned by exactly the copy's angle
      assert.ok(close(Math.hypot(s.u - 0.5, s.v - 0.5), r0), `radius of copy ${i}`);
      const a = Math.atan2(s.v - 0.5, s.u - 0.5);
      const d = ((a - a0 - s.angle) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
      assert.ok(close(d, 0), `position angle of copy ${i}`);
    });
    assert.deepEqual([got[0].u, got[0].v, got[0].angle], [0.8, 0.35, 0]);
  }
  // the centre itself stays put in every copy
  const mid = [];
  stampCopies(0.5, 0.5, 5, (u, v) => mid.push([u, v]));
  for (const [u, v] of mid) assert.ok(close(u, 0.5) && close(v, 0.5));
});

test('the centre follows the drawer: the square sits in the visible field', () => {
  const o = {};
  assert.deepEqual(fieldSquare(1200, 800, 0, o), { cx: 600, cy: 400, side: 800 });
  // a drawer 300 wide: the field is 900 wide, its centre 750 in, the square still 800
  assert.deepEqual(fieldSquare(1200, 800, 300, o), { cx: 750, cy: 400, side: 800 });
  // a drawer 600 wide: the field is 600 wide, so is the square
  assert.deepEqual(fieldSquare(1200, 800, 600, o), { cx: 900, cy: 400, side: 600 });
  // portrait
  assert.deepEqual(fieldSquare(400, 900, 0, o), { cx: 200, cy: 450, side: 400 });
});

test('stamps land every spacing of path, however the path is cut', () => {
  const sp = brushSpacing(BRUSH_W);
  assert.ok(close(sp, brushSide(BRUSH_W) * 0.25));
  const line = [];
  for (let i = 0; i <= 40; i++) line.push({ u: 0.2 + i * 0.01, v: 0.3 + i * 0.004 });
  const whole = stampsFor({ points: line, d: 0, w: BRUSH_W, c: 1 }, 0).stamps;
  const len = Math.hypot(0.4, 0.16);
  assert.equal(whole.length, 1 + Math.floor(len / sp + 1e-9));
  for (let i = 1; i < whole.length; i++) {
    const d = Math.hypot(whole[i].u - whole[i - 1].u, whole[i].v - whole[i - 1].v);
    assert.ok(close(d, sp, 1e-9), `gap ${i}`);
  }
  // the same line in batches of uneven size, each starting at the last's
  // final point, the carry handed on: identical stamps, bit for bit
  for (const cuts of [[5], [1, 2, 3], [17, 3, 11], [1, 1, 1, 1, 1, 1, 30]]) {
    const out = [];
    let at = 0, carry = 0, d = 0;
    for (const n of [...cuts, 999]) {
      const end = Math.min(line.length - 1, at + n);
      const r = stampsFor({ points: line.slice(at, end + 1), d, w: BRUSH_W, c: 1 }, carry);
      out.push(...r.stamps); carry = r.carry; d = 1; at = end;
      if (at === line.length - 1) break;
    }
    assert.deepEqual(out, whole, 'cuts ' + cuts);
  }
  // a zero-length segment changes nothing
  assert.equal(walkSegment(0.3, 0.3, 0.3, 0.3, 0.01, sp, 3, () => assert.fail('no stamp')), 0.01);
  // copies multiply the stamps and keep their order: each stamp's copies together
  const six = stampsFor({ points: line, d: 0, w: BRUSH_W, c: 6 }, 0).stamps;
  assert.equal(six.length, whole.length * 6);
  six.forEach((s, i) => assert.equal(s.copy, i % 6));
});

test('the wire: a motif stroke round-trips with its four fields', () => {
  const msg = encodeStroke(MOTIF, 42, BRUSH_W, 0, [{ u: 0.25, v: 0.75 }, { u: 0.5, v: 0.5 }], { a: 7, m: 13, c: 6, f: 0.5 });
  const back = decodeStroke(JSON.parse(JSON.stringify({ ...msg, id: 3 })));
  assert.ok(back);
  assert.equal(back.k, MOTIF);
  assert.deepEqual([back.a, back.m, back.c, back.f, back.w, back.d], [7, 13, 6, 0.5, BRUSH_W, 0]);
  assert.deepEqual(back.points, [{ u: 0.25, v: 0.75 }, { u: 0.5, v: 0.5 }]);
});

// The queue's contents as plain numbers, then emptied.
function drain() {
  const q = brushQueue, out = [];
  for (let i = 0; i < q.count; i++) {
    const o = ((q.head + i) % q.cap) * STAMP_FLOATS;
    out.push(Array.from(q.buf.subarray(o, o + STAMP_FLOATS)));
  }
  brushQueueDrop(q.count);
  return out;
}

test('local and remote: the same messages stamp the same figure', () => {
  S.brushCopies = 5; S.brushMotif = 9; S.kaleidoSet = 3; S.brushFade = 0.4;
  const sent = [];
  setBrushHall({ send: m => sent.push(JSON.parse(JSON.stringify(m))), peers: new Set(), phase: 'solo', conduct: false }, 'test');
  drain();
  // a wobbly drag over 80 frames on a 1280 x 720 canvas with the drawer half
  // open, a tap's worth of travel first, then the release
  const W = 1280, H = 720, inset = 160;
  let t = 1000, x = 700, y = 300;
  brushField(true, false, false, x, y, W, H, inset, t);
  for (let f = 1; f <= 80; f++) {
    t += 16.7;
    x = 700 + f * 4 + Math.sin(f * 0.3) * 9;
    y = 300 + f * 1.5 + Math.cos(f * 0.21) * 7;
    brushField(true, false, false, x, y, W, H, inset, t);
  }
  t += 16.7;
  const tapped = brushField(true, true, false, x + 2, y + 1, W, H, inset, t);
  assert.equal(tapped, false, 'a stroke is no tap');
  const local = drain();
  assert.ok(local.length > 50, 'the stroke stamped');
  assert.equal(local.length % 5, 0, 'every stamp has its five copies');
  // the first stamp is where the press went down, not where it became a drag
  const sq = fieldSquare(W, H, inset, {});
  const u0 = Math.round(((700 - sq.cx) / sq.side + 0.5) * QUANT) / QUANT;
  assert.ok(Math.abs(local[0][0] - u0) < 1e-6, 'starts at the down point');
  // it went out in batches: a first, continuations, a last
  assert.ok(sent.length >= 3);
  assert.equal(sent[0].d, 0);
  assert.equal(sent[sent.length - 1].d, 2);
  for (const m of sent) {
    assert.ok(decodeStroke(m), 'every batch decodes');
    assert.deepEqual([m.k, m.a, m.m, m.c, m.w], [MOTIF, 3, 9, 5, BRUSH_W]);
  }
  // across the hall, stamped with the sender's id
  setBrushHall(null);
  for (const m of sent) brushTake({ ...m, id: 7 });
  const remote = drain();
  assert.deepEqual(remote, local);
  // two senders interleaved still each draw their own stroke whole
  for (let i = 0; i < sent.length; i++) { brushTake({ ...sent[i], id: 1 }); brushTake({ ...sent[i], id: 2 }); }
  const both = drain();
  assert.equal(both.length, local.length * 2);
  // other brushes and malformed messages draw nothing
  brushTake({ t: 's', k: 0, h: 10, w: 20, d: 0, p: [10, 10] });
  brushTake({ ...sent[0], m: 64 });
  brushTake(null);
  assert.equal(drain().length, 0);
});

test('a plain tap on the field is a tap and stamps nothing', () => {
  drain();
  brushField(true, false, false, 500, 400, 1280, 720, 0, 0);
  brushField(true, false, false, 505, 403, 1280, 720, 0, 16);
  assert.equal(brushField(true, true, false, 506, 404, 1280, 720, 0, 33), true);
  assert.equal(drain().length, 0);
  // and a cancelled drag ends without one
  brushField(true, false, false, 500, 400, 1280, 720, 0, 50);
  brushField(true, false, false, 560, 400, 1280, 720, 0, 66);
  assert.equal(brushField(true, true, true, 570, 400, 1280, 720, 0, 83), false);
  assert.ok(drain().length > 0);
});

test('fade: 1 s to a minute, the half-life a fifth of it', () => {
  assert.equal(fadeLabel(0), '1 s');
  assert.equal(fadeLabel(1), '1 min');
  assert.ok(close(fadeSeconds(0), 1) && close(fadeSeconds(1), 60, 1e-9));
  assert.ok(close(fadeHalfLife(1), 60 / FADE_HALVINGS, 1e-9));
  for (let p = 0; p <= 100; p += 7) assert.ok(close(fadeFromText(String(fadeSeconds(p / 100))), p / 100, 1e-9));
  assert.ok(close(fadeFromText('1 min'), 1, 1e-12));
  assert.ok(Number.isNaN(fadeFromText('soon')));
});
