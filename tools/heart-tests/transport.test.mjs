// The whole transport, end to end, in node: the real js/heart/engine.js,
// render-worker.js (in worker_threads, through stage-harness.mjs and its
// fake heart.wasm) and the real 'heart-drain' processor, driven by a fake
// audio clock that runs a quantum every 128 frames of wall time. Run in
// both modes (SharedArrayBuffer and messages) and both shapes (mix with two
// islands, one combined worker).
//
// It checks what the transport promises: every quantum the drain plays is
// either silence (an underrun) or exactly engine frames F + n, with the
// islands' blocks reaching the mix in step; commands reach the right stage
// and its events come back tagged with it; buffers upload once, intact;
// the clock maps both ways; stats read sensibly; close() stops everything.
//
//   node tools/heart-tests/transport.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser, fakeContext as fakeAudio, wait, until } from './fake-audio.mjs';

await installFakeBrowser();
const { startEngine } = await import('../../js/heart/engine.js');

// Any valid module will do: the harness replaces instantiation.
const WASM_URL = 'data:application/wasm;base64,' + Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]).toString('base64');
const SR = 48000;

// The audio thread, checking every quantum the drain plays: silence (an
// underrun) or exactly engine frames n, n + 1, ... on the left.
function fakeContext() {
  const log = { quanta: 0, silent: 0, F: null, bad: [], rights: new Set() };
  const ctx = fakeAudio({
    sampleRate: SR,
    onQuantum(node, frame, L, R) {
      log.F = ctx.F;
      log.quanta++;
      if (L.every(v => v === 0) && R.every(v => v === 0) && frame !== 0) { log.silent++; return; }
      for (let i = 0; i < 128; i++) {
        if (L[i] !== frame + i) { log.bad.push(`frame ${frame + i} played ${L[i]}`); break; }
      }
      log.rights.add(R[0]);
    }
  });
  ctx.log = log;
  return ctx;
}

async function run(t, isolated, workers) {
  globalThis.crossOriginIsolated = isolated;
  const ctx = fakeContext();
  const engine = await startEngine(ctx, { workers, seed: 0, wasmUrl: WASM_URL });
  try {
    assert.ok(engine, 'the engine started');
    assert.equal(engine.mode, isolated ? 'sab' : 'message');
    assert.equal(engine.stages.length, workers);
    const events = [];
    engine.on('events', (stage, bytes) => events.push({ stage, bytes: Array.from(bytes) }));
    const statsSeen = [];
    engine.on('stats', s => statsSeen.push(s));

    // Commands: two batches in one task arrive as one, at the right stage.
    const last = workers - 1;
    engine.send(last, new Uint8Array([1, 2, 3, 4]));
    engine.send(last, new Uint8Array([5, 6, 7, 8]));
    engine.send(0, new Uint8Array([9, 9, 9, 9]));

    // A buffer: uploaded once, intact (1000 frames of 1 and 1000 of 2).
    const { registerBuffer } = await import('../../js/heart/buffers.js');
    const fakeBuffer = { numberOfChannels: 2, length: 1000, sampleRate: SR, getChannelData: c => new Float32Array(1000).fill(c + 1) };
    const id = registerBuffer(fakeBuffer);
    assert.equal(registerBuffer(fakeBuffer), id, 'the same buffer, the same id');
    assert.equal(engine.ensureBuffer(id, last), true);
    assert.equal(engine.ensureBuffer(id, last, fakeBuffer), true);
    assert.ok(engine.module instanceof WebAssembly.Module, 'the compiled module, for the shadow instance');

    // Let it play for a second and a half.
    await wait(1500);
    const log = ctx.log;
    assert.deepEqual(log.bad, [], 'every quantum played is the frames it should be');
    assert.ok(log.quanta > 300, `the drain played (${log.quanta} quanta)`);
    assert.ok(log.silent < log.quanta * 0.05, `few underruns (${log.silent} of ${log.quanta})`);
    // Right channel: the islands' seeds summed through the mix (1 + 2), or
    // the combined stage's 0.
    assert.deepEqual([...log.rights], [workers === 3 ? 3 : 0]);

    // One worker is one stage, so all three batches went to it as one.
    if (workers === 1) {
      assert.deepEqual(events.find(e => e.bytes[0] === 1)?.bytes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9]);
    } else {
      assert.deepEqual(events.find(e => e.stage === last && e.bytes[0] === 1)?.bytes, [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.deepEqual(events.find(e => e.stage === 0 && e.bytes[0] === 9)?.bytes, [9, 9, 9, 9]);
    }
    const uploads = events.filter(e => e.stage === last && e.bytes[0] === 0xb0);
    assert.equal(uploads.length, 1, 'uploaded once');
    const view = new DataView(new Uint8Array(uploads[0].bytes).buffer);
    assert.equal(view.getUint32(4, true), id);
    assert.equal(view.getFloat32(8, true), 3000);

    // The clock, both ways, once F has reached the page.
    await until(() => engine.frameAt(log.F / SR) === 0);
    assert.equal(engine.timeAt(SR), (log.F + SR) / SR);
    const s = engine.stats();
    assert.equal(s.renderMs.length, workers);
    assert.ok(s.fill > 0 && s.fill < 0.2, `fill ${s.fill}`);
    assert.ok(engine.renderedUntil() > ctx.currentTime);
    assert.equal(s.underruns, log.silent);
    assert.ok(statsSeen.length >= 4, 'stats were told');
    t.diagnostic(`${log.quanta} quanta played, ${log.silent} silent, fill ${(s.fill * 1000).toFixed(1)} ms`);
  } finally {
    engine?.close();
    // the drain hears 'close' over its port before the ports are closed
    await wait(20);
    ctx.stop();
  }
  const node = ctx.nodes[0];
  assert.equal(node.processor.process([], [[new Float32Array(128), new Float32Array(128)]]), false, 'the drain has stopped');
}

test('SAB mode, a mix and two islands', t => run(t, true, 3));
test('message mode, a mix and two islands', t => run(t, false, 3));
test('SAB mode, one combined worker', t => run(t, true, 1));
test('message mode, one combined worker', t => run(t, false, 1));
test('no wasm: null and the native engine stays', async () => {
  globalThis.crossOriginIsolated = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ctx = fakeContext();
    assert.equal(await startEngine(ctx, { wasmUrl: 'data:application/wasm;base64,AAAA' }), null);
    ctx.stop();
  } finally { console.warn = warn; }
});
