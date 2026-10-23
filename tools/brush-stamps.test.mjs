// The brush's pure parts (core/brush-stamps.js) and its one guarantee: a
// stroke drawn here and the same stroke arriving from the hall stamp the
// very same figure (core/brush.js, through touch/strokes.js's wire).
//
//   node --test tools/brush-stamps.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stampCopies, walkBatch, walkSegment, stampsFor, fieldSquare, brushSpacing, brushSide, BRUSH_W,
  fadeSeconds, fadeHalfLife, fadeLabel, fadeFromText, FADE_HALVINGS,
  SPACING_SHARE, rateContinuous, printsPerSecond, rateLabel
} from '../core/brush-stamps.js';
import { encodeStroke, decodeStroke, MOTIF, QUANT } from '../touch/strokes.js';
import { S } from '../js/state.js';
import { brushField, brushTake, setBrushHall, setBrushBroadcast, brushQueue, brushQueueDrop, STAMP_FLOATS, brushPlay, brushPlaying, setBrushClock } from '../core/brush.js';

// the receiver's clock, moved by drain()
let fakeNow = 1e6;
setBrushClock(() => fakeNow);

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
  assert.ok(close(sp, brushSide(BRUSH_W) * SPACING_SHARE));
  // continuous means dense: neighbours overlap by at least nine tenths
  assert.ok(SPACING_SHARE <= 0.1);
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

// The queue's contents as plain numbers, then emptied, once every remote
// stroke has played out (core/brush.js brushPlay).
function drain() {
  for (let i = 0; i < 2000 && brushPlaying(); i++) { fakeNow += 1000 / 60; brushPlay(1 / 60); }
  const q = brushQueue, out = [];
  for (let i = 0; i < q.count; i++) {
    const o = ((q.head + i) % q.cap) * STAMP_FLOATS;
    // the figure: everything but who drew it (the last field, which
    // core/brush-order.js reads; a remote copy names its sender)
    out.push(Array.from(q.buf.subarray(o, o + STAMP_FLOATS - 1)));
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

test('the conductor\'s phase row: shown only to a joined conductor, lit by the hall, never saved', async () => {
  // the schema's file pulls in the store and, through it, v0's page modules:
  // the journey sim's stand-ins for a browser (tools/journey-sim.test.mjs)
  const noop = () => {};
  const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
  const mem = new Map();
  globalThis.localStorage ??= { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), key: () => null, length: 0 };
  globalThis.window ??= globalThis; globalThis.addEventListener ??= noop; globalThis.removeEventListener ??= noop; globalThis.dispatchEvent ??= () => true;
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop });
  globalThis.document ??= any; globalThis.requestAnimationFrame ??= noop;
  globalThis.location ??= { search: '', hostname: 'localhost', href: 'http://localhost/' };
  for (const k of ['AudioContext', 'Worker', 'BroadcastChannel', 'ResizeObserver', 'Image', 'Audio', 'OffscreenCanvas', 'MessageChannel', 'AudioWorkletNode', 'GainNode', 'OscillatorNode', 'MediaStream', 'IntersectionObserver', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'CustomEvent', 'FontFace', 'screen', 'visualViewport']) globalThis[k] ??= any;
  // the schema first, the order the app loads it in (its files import each other)
  const { byId } = await import('../core/schema.js');
  const { brushStateOf } = await import('../core/schema-brush.js');
  const { brushHallState } = await import('../core/brush.js');
  // (the Rate row's one formatter and its typed readout, from the same schema)
  const rate = byId('brushRate');
  assert.equal(rate.formatAt(0), '1 /s');
  assert.equal(rate.formatAt(99), '60 /s');
  assert.equal(rate.formatAt(100), 'Frame rate');
  assert.equal(rate.parse(null, '60 /s'), 99);
  assert.equal(rate.parse(null, '1'), 0);
  assert.equal(rate.parse(null, 'Frame rate'), 100);
  const row = byId('brushPhase');
  assert.deepEqual(row.options.map(o => o.value), ['solo', 'master', 'pairs', 'quads', 'halves', 'all']);
  assert.deepEqual(row.options.map(o => o.label), ['Alone', 'Master', 'Pairs', 'Fours', 'Halves', 'Together']);
  assert.equal(row.def, undefined, 'no reset to Alone from a click on its name');
  const asked = [];
  const link = { send() {}, peers: new Set(), phase: 'solo', conduct: false, setPhase: p => asked.push(p) };
  setBrushHall(null);
  assert.equal(row.visible(S), false, 'no hall, no row');
  setBrushHall(link, 'show');
  brushHallState('joined');
  assert.equal(row.visible(S), false, 'a member sees no row');
  link.conduct = true;
  assert.equal(row.visible(S), true);
  brushHallState('joining');
  assert.equal(row.visible(S), false, 'hidden while reconnecting');
  brushHallState('joined');
  // a click only asks; the light follows what the hall says
  row.set(S, 'pairs');
  assert.deepEqual(asked, ['pairs']);
  assert.equal(row.get(S), 'solo');
  link.phase = 'quads';          // the hall's group message, or /touch/'s conductor
  assert.equal(row.get(S), 'quads');
  assert.ok(!('brushPhase' in brushStateOf(S)), 'not in the saved record');
  setBrushHall(null);
});

// A drag of `frames` frames at `dt` ms, wobbling right and down, sent to a
// fake hall; returns the local queue and the messages.
function drag(frames, dt, rate) {
  S.brushCopies = 3; S.brushMotif = 4; S.kaleidoSet = 2; S.brushFade = 0.6; S.brushRate = rate;
  const sent = [];
  setBrushHall({ send: m => sent.push(JSON.parse(JSON.stringify(m))), peers: new Set(), phase: 'solo', conduct: false }, 'test');
  drain();
  const W = 1280, H = 720;
  let t = 0, x = 400, y = 200;
  brushField(true, false, false, x, y, W, H, 0, t);
  for (let f = 1; f <= frames; f++) {
    t += dt;
    x = 400 + f * 3 + Math.sin(f * 0.2) * 6; y = 200 + f * 2;
    brushField(true, false, false, x, y, W, H, 0, t);
  }
  brushField(true, true, false, x, y, W, H, 0, t + dt);
  setBrushHall(null);
  return { local: drain(), sent };
}

test('Rate at the top is Frame rate: continuous and dense; r 1 or absent draws the same', () => {
  assert.equal(rateLabel(1), 'Frame rate');
  assert.ok(rateContinuous(1) && rateContinuous(undefined) && !rateContinuous(0.99));
  const { local, sent } = drag(120, 16.7, 1);
  // about one stamp (of three copies) every SPACING_SHARE of the motif's side
  // (a chord across a corner of the path is a hair shorter than the arc)
  const sp = brushSide(BRUSH_W) * SPACING_SHARE;
  assert.ok(local.length / 3 > 100, 'many stamps');
  for (let i = 3; i < local.length; i += 3) {
    const d = Math.hypot(local[i][0] - local[i - 3][0], local[i][1] - local[i - 3][1]);
    assert.ok(d <= sp + 1e-6 && d >= sp * 0.9, 'gap ' + i / 3 + ' ' + d / sp);
  }
  for (const m of sent) assert.equal(m.r, 1);
  for (const m of sent) brushTake({ ...m, id: 4 });
  assert.deepEqual(drain(), local, 'remote with r 1');
  for (const m of sent) { const o = { ...m, id: 5 }; delete o.r; brushTake(o); }
  assert.deepEqual(drain(), local, 'remote with no r (an old stroke)');
});

test('Rate slowed: separate prints at the rate, every point a print, the same on both sides', () => {
  assert.equal(rateLabel(0), '1 /s');
  assert.equal(rateLabel(0.99), '60 /s');
  assert.equal(rateLabel(1), 'Frame rate');
  assert.ok(close(printsPerSecond(0.99), 60, 1e-9) && close(printsPerSecond(0), 1));
  // the 8 to 60 band has as much travel as 1 to 8
  const at = p => 0.99 * Math.log(p) / Math.log(60);
  assert.ok(Math.abs((at(60) - at(8)) - (at(8) - at(1))) < 0.1);

  // three seconds of drag at 2 prints a second-ish
  const r = 0.17, pps = printsPerSecond(r);
  const { local, sent } = drag(180, 16.7, r);
  const prints = local.length / 3;
  // the first at the down point, then one each 1/pps of a second
  assert.ok(prints >= Math.floor(3 * pps) - 1 && prints <= Math.ceil(3 * pps) + 2, prints + ' prints at ' + pps.toFixed(2) + '/s');
  // far sparser than continuous
  assert.ok(prints < 12);
  // the wire's points are exactly the prints
  let pts = 0;
  for (const m of sent) { assert.equal(m.r, r); assert.ok(decodeStroke(m)); pts += m.p.length / 2; }
  assert.equal(pts, prints);
  for (const m of sent) brushTake({ ...m, id: 9 });
  assert.deepEqual(drain(), local);
  // decode judges r like the others
  const good = sent[0];
  for (const bad of [-0.1, 1.5, '0.5', null, NaN]) assert.equal(decodeStroke({ ...good, r: bad }), null, String(bad));
  assert.equal(decodeStroke({ ...good, r: 0 }).r, 0);
});

test('broadcast: one encode reaches hall and followers alike; a follower draws the stroke, not its own settings', () => {
  S.brushCopies = 7; S.brushMotif = 11; S.kaleidoSet = 4; S.brushFade = 0.8; S.brushRate = 1;
  const hall = [], bc = [];
  let watching = true, touched = 0;
  setBrushHall({ send: m => hall.push(m), peers: new Set(), phase: 'solo', conduct: false }, 'test');
  setBrushBroadcast({ wanted: () => watching, send: m => bc.push(m), touch: () => touched++ });
  drain();
  let t = 0;
  brushField(true, false, false, 300, 300, 1280, 720, 0, t);
  for (let f = 1; f <= 40; f++) { t += 16.7; brushField(true, false, false, 300 + f * 6, 300 + f * 3, 1280, 720, 0, t); }
  brushField(true, true, false, 540, 420, 1280, 720, 0, t + 16.7);
  const local = drain();
  assert.equal(touched, 1, 'the stroke woke a resting broadcast once');
  assert.ok(bc.length >= 3);
  // the very same message objects, built once, went both ways
  assert.equal(bc.length, hall.length);
  bc.forEach((m, i) => assert.equal(m, hall[i]));
  // a follower with other Brush settings entirely
  S.brushCopies = 1; S.brushMotif = 0; S.kaleidoSet = 9; S.brushRate = 0.1; S.brushFade = 0;
  for (const m of bc) brushTake(JSON.parse(JSON.stringify(m)), 'broadcast');
  assert.deepEqual(drain(), local);
  // nobody watching: nothing goes to the broadcast, the hall still hears it
  watching = false; hall.length = 0; bc.length = 0;
  S.brushCopies = 7; S.brushRate = 1;
  brushField(true, false, false, 300, 300, 1280, 720, 0, 2000);
  brushField(true, false, false, 380, 300, 1280, 720, 0, 2100);
  brushField(true, true, false, 400, 300, 1280, 720, 0, 2200);
  drain();
  assert.equal(bc.length, 0);
  assert.ok(hall.length > 0);
  setBrushHall(null); setBrushBroadcast(null);
});

test('the conductor sends the room\'s settings and the deal; a hand\'s tile draws from the hand\'s own set', async () => {
  const B = await import('../core/brush.js');
  const sent = [];
  const link = { send: m => sent.push(m), peers: new Set(), phase: 'solo', round: 1, conduct: true, you: 1, stream: 20, smooth: 30, hand: null, setPhase() {}, next() {} };
  setBrushHall(link, 'show');
  B.brushHallState('joined');
  S.brushStream = 25; S.brushSmooth = 40; S.brushDeal = true; S.brushDealN = 4; S.kaleidoSet = 3;
  // the atlas not in yet: the room goes, the deal waits and asks for the atlas
  B.brushAtlas.ready = false;
  B.brushPlay(0);
  assert.deepEqual(sent.map(m => m.t), ['room']);
  assert.deepEqual([sent[0].ms, sent[0].sm], [25, 40]);
  assert.equal(B.brushAtlas.want, 3);
  // in: the deal goes, the set's painted tiles in sheet order
  Object.assign(B.brushAtlas, { ready: true, set: 3, count: 3 });
  B.brushAtlas.tiles.set([2, 5, 9]);
  B.brushPlay(0);
  assert.deepEqual(sent[1], { t: 'brushes', on: 1, n: 4, a: 3, tiles: [2, 5, 9] });
  B.brushPlay(0);
  assert.equal(sent.length, 2, 'nothing again while nothing changed');
  // the hall's wipe tells the deal off: said again
  B.brushHallHand(null);
  B.brushPlay(0);
  assert.equal(sent[2].t, 'brushes');
  // a hand dealt from set 7: a tap on its second button, then a stroke
  link.hand = { on: 1, a: 7, tiles: [11, 30] };
  B.brushHallHand(link.hand);
  B.brushPickHand(1);
  assert.equal(S.brushMotif, 30);
  assert.ok(B.brushHandPicked(1) && !B.brushHandPicked(0));
  sent.length = 0;
  brushField(true, false, false, 300, 300, 1280, 720, 0, 5000);
  brushField(true, false, false, 360, 300, 1280, 720, 0, 5050);
  brushField(true, true, false, 380, 300, 1280, 720, 0, 5100);
  const strokes = sent.filter(m => m.t === 's');
  assert.ok(strokes.length && strokes.every(m => m.a === 7 && m.m === 30), 'drawn from the hand');
  drain();
  // the atlas picker's own pick lets the hand's go
  B.brushPickAtlas();
  assert.ok(!B.brushHandPicked(1));
  S.brushDeal = false;
  setBrushHall(null);
});
