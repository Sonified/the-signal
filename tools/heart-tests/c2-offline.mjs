// OfflineHeartContext on the real heart.wasm: a smoke test of the whole
// twin path in node (commands, render, the master port, the shadow). It
// skips until js/heart/heart.wasm has been built (heart/build.sh). The
// null-test bench (spec 9) is the real measure; this only says the pipes
// are joined.
// Run: node --test tools/heart-tests/c2-offline.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { load } from './c2-harness.mjs';

const WASM = new URL('../../js/heart/heart.wasm', import.meta.url);
const skip = !existsSync(WASM) && 'js/heart/heart.wasm is not built yet';
const h = await load();

// node has no AudioBuffer; a plain one is enough for the context to fill
globalThis.AudioBuffer ??= class {
  constructor({ numberOfChannels, length, sampleRate }) {
    Object.assign(this, { numberOfChannels, length, sampleRate, duration: length / sampleRate });
    this._data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this._data[c]; }
};

const make = (length, channels = 2) => h.OfflineHeartContext.create({
  numberOfChannels: channels, length, sampleRate: 48000, wasm: readFileSync(WASM)
});

test('a constant source through a gain reaches the master', { skip }, async () => {
  const ctx = await make(1000);
  const src = ctx.createConstantSource(), g = ctx.createGain();
  src.offset.value = 0.5;
  g.gain.value = 0.5;
  src.connect(g).connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  for (const c of [0, 1]) {
    const x = out.getChannelData(c);
    assert.ok(Math.abs(x[0] - 0.25) < 1e-6 && Math.abs(x[999] - 0.25) < 1e-6, `channel ${c}: ${x[0]}, ${x[999]}`);
  }
});

test('param values come from the shadow\'s timeline', { skip }, async () => {
  const ctx = await make(128);
  const p = ctx.createGain().gain;
  assert.equal(p.value, 1);
  p.value = 0.25;
  assert.equal(p.value, Math.fround(0.25));
  p.linearRampToValueAtTime(1, 1);
  assert.equal(p.value, Math.fround(0.25), 'currentTime is 0, the ramp has not begun');
});

test('a mono context takes the down-mix of the stereo master', { skip }, async () => {
  const ctx = await make(256, 1);
  const src = ctx.createConstantSource(), pan = ctx.createStereoPanner();
  pan.pan.value = 1;   // all of it to the right: the mono mix is half
  src.connect(pan).connect(ctx.destination);
  src.start();
  const x = (await ctx.startRendering()).getChannelData(0);
  assert.ok(Math.abs(x[100] - 0.5) < 1e-6, `${x[100]}`);
});
