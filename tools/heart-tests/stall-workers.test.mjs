// The drawer's Simulate underrun with Stall the workers on (js/heart/
// engine.js stallWorkers, js/heart/render-worker.js stall): every render
// worker stops dead for the gap, so the ring runs dry for real. A stall
// shorter than the cushion is absorbed and nothing is missed; one longer
// than it is heard, counted as underruns like any other, and the cushion
// grows from it. Both transports (SharedArrayBuffer and messages), one
// worker and three.
//
//   node tools/heart-tests/stall-workers.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser, fakeContext as fakeAudio, wait } from './fake-audio.mjs';

await installFakeBrowser();
const { startEngine } = await import('../../js/heart/engine.js');
const doc = new EventTarget();
doc.visibilityState = 'visible';
doc.fullscreenElement = null;
globalThis.document = doc;

const WASM_URL = 'data:application/wasm;base64,' + Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]).toString('base64');
const SR = 48000;

for (const isolated of [true, false]) for (const workers of [1, 3]) {
  test(`stall the workers: absorbed under the cushion, a real underrun past it (${isolated ? 'SAB' : 'message'} mode, ${workers} worker${workers > 1 ? 's' : ''})`, async () => {
    globalThis.crossOriginIsolated = isolated;
    let silent = 0;
    const ctx = fakeAudio({ sampleRate: SR, onQuantum(node, frame, L) { if (frame !== 0 && L.every(v => v === 0)) silent++; } });
    const engine = await startEngine(ctx, { workers, seed: 0, wasmUrl: WASM_URL, conceal: false, handheld: false, lookahead: 0.3 });
    try {
      await wait(1000);
      const before = engine.stats().underruns, silentBefore = silent;
      // Well inside the 300 ms cushion: nothing is missed.
      engine.stallWorkers(100);
      await wait(800);
      assert.equal(silent - silentBefore, 0, 'a short stall is absorbed');
      // Past it: the ring runs dry for real, the drain counts it, and the
      // cushion grows from it.
      const ahead = engine.lookahead();
      engine.stallWorkers(700);
      await wait(1500);
      assert.ok(silent - silentBefore > 0, `a long stall is heard (${silent - silentBefore} quanta dry)`);
      assert.ok(engine.stats().underruns > before, 'counted as underruns');
      assert.ok(engine.lookahead() > ahead, `the cushion grew (${ahead} to ${engine.lookahead()} s)`);
    } finally {
      engine.close();
      ctx.stop();
    }
  });
}
