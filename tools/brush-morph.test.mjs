// The brush's morph from shapes to particles, its two seams with no GPU in
// them: each tile's average colour, measured from a finished atlas
// (gpu/atlas-bake.js tileTints), and Auto's sweep (core/brush-morph.js).
//
//   node --test tools/brush-morph.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { tileTints, atlasLayout, MOTIFS, GRID } from '../gpu/atlas-bake.js';
import { stepBrushMorph, brushMorphNow, morphAt, morphPhaseOf, MORPH_HALF_PERIOD } from '../core/brush-morph.js';
import { S } from '../js/state.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// a tiny atlas: 4 px tiles round a 2 px motif, 32 px square, premultiplied
const L = atlasLayout(4, 1, 1, true);
function paint(out, t, x, y, r, g, b, a) {
  const i = (((((t / GRID) | 0) * L.tile) + y) * L.atlas + (t % GRID) * L.tile + x) * 4;
  const k = a / 255;
  out[i] = Math.round(r * k); out[i + 1] = Math.round(g * k); out[i + 2] = Math.round(b * k); out[i + 3] = a;
}

test('tints: a tile\'s straight average colour, weighted by its alpha', () => {
  const out = new Uint8Array(L.atlas * L.atlas * 4);
  // tile 0: solid red over its whole tile
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) paint(out, 0, x, y, 255, 0, 0, 255);
  // tile 9: its left half opaque blue, its right half faint green (a third)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    if (x < 2) paint(out, 9, x, y, 0, 0, 255, 255); else paint(out, 9, x, y, 0, 255, 0, 85);
  }
  const into = tileTints(out, L, new Float32Array(MOTIFS * 4));
  assert.deepEqual([...into.subarray(0, 4)], [1, 0, 0, 1]);
  // three parts blue to one green, by alpha
  assert.ok(close(into[36], 0));
  assert.ok(close(into[37], 0.25, 0.01), 'green ' + into[37]);
  assert.ok(close(into[38], 0.75, 0.01), 'blue ' + into[38]);
  assert.equal(into[39], 1);
  // an empty tile is white
  assert.deepEqual([...into.subarray(4, 8)], [1, 1, 1, 1]);
  for (let i = 0; i < into.length; i++) assert.ok(into[i] >= 0 && into[i] <= 1);
});

test('auto: shapes to particles in the half period, back in another, on a cosine', () => {
  assert.equal(MORPH_HALF_PERIOD, 10);
  S.brushMorph = 0; S.brushMorphAuto = true;
  const at = [];
  for (let f = 0; f < 60 * 20; f++) { stepBrushMorph(1 / 60); if (f % 60 === 59) at.push(brushMorphNow()); }
  // a second in a tenth of the way, mid way at 5 s, the far end at 10 s, home at 20
  assert.ok(close(at[0], morphAt(Math.PI / 10), 1e-6));
  assert.ok(close(at[4], 0.5, 1e-6));
  assert.ok(close(at[9], 1, 1e-6));
  assert.ok(close(at[19], 0, 1e-6));
  // no frame jumps: the steepest step is pi / 2 / half period a second
  S.brushMorph = 0.3;
  S.brushMorphAuto = false; stepBrushMorph(1 / 60);
  assert.equal(S.brushMorph, 0.3, 'off: the value stays where the hand left it');
  S.brushMorphAuto = true; stepBrushMorph(0);
  assert.ok(close(S.brushMorph, 0.3), 'on: the sweep sets out from where it stands');
  let prev = S.brushMorph;
  for (let f = 0; f < 600; f++) {
    stepBrushMorph(1 / 60);
    assert.ok(Math.abs(S.brushMorph - prev) <= Math.PI / 2 / MORPH_HALF_PERIOD / 60 + 1e-9);
    prev = S.brushMorph;
  }
  // a long frame moves it a quarter second at most
  const before = morphPhaseOf(S.brushMorph);
  S.brushMorphAuto = false; stepBrushMorph(0); S.brushMorphAuto = true;
  stepBrushMorph(30);
  assert.ok(Math.abs(S.brushMorph - morphAt(before + Math.PI * 0.25 / MORPH_HALF_PERIOD)) < 1e-9);
  S.brushMorphAuto = false;
});

test('the value drawn is held to 0..1', () => {
  S.brushMorph = 2; assert.equal(brushMorphNow(), 1);
  S.brushMorph = -1; assert.equal(brushMorphNow(), 0);
  S.brushMorph = NaN; assert.equal(brushMorphNow(), 0);
  S.brushMorph = 0;
});
