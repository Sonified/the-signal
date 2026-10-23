// Brush notes (core/brush-notes.js, core/brush.js): the scale, each hand's
// seeded notes and bell, and the band crossings that strike them.
//
//   node --test tools/brush-notes.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEGREES, degreeHz, degreeSemis, ROOT_HZ, seedOf, notesFor, bellFor, noteShape, bandAt, nextBand, HYST } from '../core/brush-notes.js';
import { S } from '../js/state.js';
import { brushField, setBrushBell, setBrushStarted, setBrushHall, brushTake, brushPlay, brushPlaying, brushQueueDrop, brushQueue, setBrushClock } from '../core/brush.js';
import { encodeStroke, timesToQ, MOTIF } from '../touch/strokes.js';
import { BRUSH_W } from '../core/brush-stamps.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('the eleven pitches: 1 2 3 5 7 over two octaves and the double octave, from the music\'s root', () => {
  assert.deepEqual(DEGREES, [1, 2, 3, 5, 7, 8, 9, 10, 12, 14, 15]);
  assert.deepEqual(DEGREES.map(degreeSemis), [0, 2, 4, 7, 11, 12, 14, 16, 19, 23, 24]);
  // the root is the music's own: two octaves above the piano's sounding
  // root (js/piano.js ARP_ROOT_HZ, 79.5 Hz), so every degree lands on the
  // show's scale
  assert.ok(close(degreeHz(1), ROOT_HZ) && close(ROOT_HZ, 79.5 * 4, 1e-9), "the music's root");
  // degree d + 7 is d's octave, 15 the double octave
  for (const d of [1, 2, 3, 5, 7]) assert.ok(close(degreeHz(d + 7), 2 * degreeHz(d)), `${d} and ${d + 7}`);
  assert.ok(close(degreeHz(15), 4 * ROOT_HZ));
  assert.ok(close(degreeHz(5), ROOT_HZ * Math.pow(2, 7 / 12)), 'the fifth');
});

test('each hand: four of the eleven, ascending, the same for the same identity, its own bell', () => {
  for (const id of [1, 2, 3, 17, -1, 0]) {
    const n = notesFor(seedOf(id));
    assert.equal(n.length, 4);
    assert.equal(new Set(n).size, 4);
    assert.deepEqual(n, [...n].sort((a, b) => a - b));
    assert.ok(n.every(d => DEGREES.includes(d)));
    assert.deepEqual(notesFor(seedOf(id)), n, 'deterministic');
    assert.deepEqual(bellFor(seedOf(id)), bellFor(seedOf(id)));
  }
  assert.notDeepEqual(bellFor(seedOf(1)), bellFor(seedOf(2)), 'a bell of its own');
  for (let id = 0; id < 40; id++) {
    const b = bellFor(seedOf(id));
    assert.ok([2, 3, 4].includes(b.ratio), 'a whole number ratio: in tune');
    assert.ok(b.decay > 1.3 && b.decay < 2.5 && b.index >= 1.2 && b.index <= 2.4);
  }
  assert.equal(seedOf(7), seedOf('7'), 'a number and its string name the same hand');
});

test('the bands: five, bottom fifth lowest, each entered once, a boundary held by its margin', () => {
  assert.deepEqual([0.95, 0.7, 0.5, 0.3, 0.1].map(bandAt), [0, 1, 2, 3, 4]);
  // a path from the bottom to the top and back, rung at each entry
  const rung = [];
  let b = -1;
  const walk = v => { const nb = nextBand(b, v); if (nb !== b) rung.push(nb); b = nb; };
  for (let v = 0.99; v >= 0.01; v -= 0.005) walk(v);
  for (let v = 0.01; v <= 0.99; v += 0.005) walk(v);
  assert.deepEqual(rung, [0, 1, 2, 3, 4, 3, 2, 1, 0]);
  // jitter on the 0.8 boundary, within the margin: one entry, no more
  b = nextBand(-1, 0.85);
  const seen = [b];
  for (let i = 0; i < 50; i++) { const nb = nextBand(b, 0.8 + (i % 2 ? 1 : -1) * HYST * 0.6); if (nb !== b) seen.push(nb); b = nb; }
  assert.deepEqual(seen, [0], 'held');
  // past the margin it goes
  assert.equal(nextBand(0, 0.8 - HYST - 0.001), 1);
  // a jump of two bands goes at once
  assert.equal(nextBand(0, 0.5), 2);
});

test('a note\'s shape: its length between the two, in either order, its ADSR inside it', () => {
  let x = 0.123;
  const rand = () => (x = (x * 9301 + 0.49297) % 1);
  for (const [lo, hi] of [[0.5, 2], [2, 0.5], [0.1, 0.1], [0.1, 3], [3, 3]]) {
    for (let i = 0; i < 200; i++) {
      const n = noteShape(lo, hi, rand);
      assert.ok(n.len >= Math.min(lo, hi) - 1e-9 && n.len <= Math.max(lo, hi) + 1e-9, 'length in range');
      assert.ok(n.attack >= 0.003 && n.attack <= 0.03, 'a quick attack');
      assert.ok(n.attack + n.decay + n.release < n.len, 'the envelope fits');
      assert.ok(n.sustain >= 0.35 && n.sustain <= 0.7);
    }
  }
});

test('no hand row before the screen is started', async () => {
  const B = await import('../core/brush.js');
  setBrushHall(null);
  S.brushDeal = true; S.brushDealN = 4;
  assert.equal(B.brushHand(), null);
  S.brushDeal = false;
});

test('strokes strike at each line: the hand at once, a remote one as it plays, nothing before the start or with both off', () => {
  let now = 1e6;
  setBrushClock(() => now);
  const struck = [];
  setBrushBell((seed, degree) => struck.push([seed, degree]));
  setBrushHall(null);
  S.brushCopies = 1; S.brushMotif = 0; S.kaleidoSet = 1; S.brushFade = 0.5; S.brushRate = 1;
  const drag = t0 => {
    // from the bottom of the field to the top, on a 1000 x 1000 canvas
    brushField(true, false, false, 500, 990, 1000, 1000, 0, t0);
    for (let i = 1; i <= 60; i++) brushField(true, false, false, 500, 990 - i * 16, 1000, 1000, 0, t0 + i * 16);
    brushField(true, true, false, 500, 20, 1000, 1000, 0, t0 + 61 * 16);
  };
  S.brushNotes = true;
  drag(0);
  assert.equal(struck.length, 0, 'not before the screen is started');
  setBrushStarted();
  drag(2000);
  const mine = notesFor(seedOf(0));
  assert.deepEqual(struck.map(s => s[1]), mine, 'bottom to top: the hand\'s four notes in turn');
  // a remote stroke, the same path, from member 7: struck as it plays
  struck.length = 0;
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push({ u: 0.5, v: 0.99 - i * 0.016 });
  const ts = pts.map((_, i) => 5000 + i * 16);
  brushTake({ ...encodeStroke(MOTIF, 10, BRUSH_W, 2 * 0, pts, { a: 1, m: 0, c: 1, f: 0.5, q: timesToQ(ts) }), d: 2, id: 7 });
  assert.equal(struck.length, 0, 'nothing until it plays');
  for (let i = 0; i < 400 && brushPlaying(); i++) { now += 16; brushPlay(0.016); }
  assert.deepEqual(struck.map(s => s[1]), notesFor(seedOf(7)));
  assert.ok(struck.every(s => s[0] === seedOf(7)), 'member 7s own bell');
  // the start rings nothing: a stroke within one band is silent
  struck.length = 0;
  brushField(true, false, false, 500, 500, 1000, 1000, 0, 7000);
  for (let i = 1; i <= 10; i++) brushField(true, false, false, 500 + i * 10, 500, 1000, 1000, 0, 7000 + i * 16);
  brushField(true, true, false, 600, 500, 1000, 1000, 0, 7000 + 11 * 16);
  assert.equal(struck.length, 0, 'no line crossed');
  // Brush notes alone strikes too
  S.brushNotes = false; S.brushTones = true;
  drag(8000);
  assert.deepEqual(struck.map(s => s[1]), mine);
  // both off: silence
  struck.length = 0;
  S.brushTones = false;
  drag(9000);
  assert.equal(struck.length, 0);
  brushQueueDrop(brushQueue.count);
});
