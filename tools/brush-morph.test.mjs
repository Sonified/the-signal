// The brush's morph from shapes to particles, its two seams with no GPU in
// them: each tile's average colour, measured from a finished atlas
// (gpu/atlas-bake.js tileTints), and Auto's sweep (core/brush-morph.js).
//
//   node --test tools/brush-morph.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { tileTints, atlasLayout, MOTIFS, GRID } from '../gpu/atlas-bake.js';
import { stepBrushMorph, brushMorphNow, morphAt, morphPhaseOf, MORPH_HALF_PERIOD, brushParticleBrightNow, PART_BRIGHT_LO, PART_BRIGHT_HI } from '../core/brush-morph.js';
import { S } from '../js/state.js';
import { particleLight, packFrameUniforms, RIBBON_LIGHT, LONE_LIGHT } from '../gpu/brush.js';
import { BRUSH_WGSL } from '../gpu/brush.wgsl.js';
import { SPACING_SHARE, CONTINUITY_MAX } from '../core/brush-stamps.js';

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

test('the particles\' brightness: 1 unset, held to a quarter and four times', () => {
  delete S.brushParticleBright; assert.equal(brushParticleBrightNow(), 1);
  S.brushParticleBright = 2.5; assert.equal(brushParticleBrightNow(), 2.5);
  S.brushParticleBright = 9; assert.equal(brushParticleBrightNow(), PART_BRIGHT_HI);
  S.brushParticleBright = 0; assert.equal(brushParticleBrightNow(), PART_BRIGHT_LO);
  S.brushParticleBright = NaN; assert.equal(brushParticleBrightNow(), 1);
  S.brushParticleBright = 1;
});

// the particle's glow as brush.wgsl.js draws it, d its distance over its reach
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const glow = d => (Math.exp(-d * d * 40) + 0.35 * Math.exp(-d * d * 6)) * (1 - ss(0.9, 1, d));

test('a ribbon of particles stands at its colour, at any Continuity, never adding up to white', () => {
  // a straight ribbon of stamps every span of the side, each glowing to 0.3
  // of the side: the light on its line, at a stamp and between two
  for (const C of [1, 2, 3, 5, 10, CONTINUITY_MAX]) {
    const span = SPACING_SHARE / C, e = particleLight(span);
    for (const at of [0, 0.5]) {
      let L = 0;
      for (let k = -2000; k <= 2000; k++) { const d = Math.abs((k + at) * span) / 0.3; if (d < 1) L += glow(d) * e; }
      assert.ok(Math.abs(L - RIBBON_LIGHT) < 0.02, `${C}x: the ribbon at ${L.toFixed(3)}`);
      // Particle brightness scales it: a quarter dim, four times past white
      assert.ok(L * 0.25 < 0.2 && L * 4 > 2.5);
    }
  }
  // a print, or a ribbon too sparse to share, is one light
  assert.equal(particleLight(0), LONE_LIGHT);
  assert.equal(particleLight(10), LONE_LIGHT);
  assert.ok(glow(0) * LONE_LIGHT < 1, 'a lone particle\'s centre just under white');
});

test('the frame\'s uniforms carry the morph and the particles\' brightness where the shader reads them', () => {
  const uni = new Float32Array(8);
  S.brushMorph = 0.4; S.brushParticleBright = 0.25;
  packFrameUniforms(uni, 1000, 500, { innerUV: 0.1, halfTexel: 0.001 });
  assert.ok(close(uni[0], 0.002) && close(uni[1], 0.004));
  assert.ok(close(uni[2], 0.4), 'the morph, view.z');
  assert.equal(uni[3], 0.25, 'the brightness, view.w');
  assert.ok(close(uni[4], 0.1) && close(uni[5], 0.001));
  S.brushParticleBright = 4; packFrameUniforms(uni, 1000, 500, { innerUV: 0.1, halfTexel: 0.001 });
  assert.equal(uni[3], 4, 'a new value lands on the next pack');
  // the struct's first vec4 is view, and the particle's light reads view.w
  assert.match(BRUSH_WGSL, /struct BU \{\s*view: vec4f,/);
  assert.match(BRUSH_WGSL, /out\.light = b\.w \* bu\.view\.w;/);
  assert.match(BRUSH_WGSL, /in\.tint \* \(g \* in\.light\)/);
  S.brushMorph = 0; S.brushParticleBright = 1;
});
