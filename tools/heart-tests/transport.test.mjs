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
// Then the adaptive lookahead (§7.3), on the same rig. A stage is stalled,
// longer than the lookahead, again and again: the stalls underrun, each
// grows the lookahead, until a stall no longer underruns; every quantum
// played is still exactly its engine frames, so the time map never moved;
// a steady stretch brings it back to the base; hiding the page raises it to
// the hidden floor and holds it there. And a stage made too slow to keep
// up is told apart from a stall: reported as an overload, once.
//
//   node tools/heart-tests/transport.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser, fakeContext as fakeAudio, wait, until } from './fake-audio.mjs';

await installFakeBrowser();
const { startEngine } = await import('../../js/heart/engine.js');

// A page that can hide.
const doc = new EventTarget();
doc.visibilityState = 'visible';
globalThis.document = doc;
function setVisibility(state) {
  doc.visibilityState = state;
  doc.dispatchEvent(new Event('visibilitychange'));
}

// The fake heart's two levers (stage-harness.mjs): a stall of `ms` where
// the batch lands, and a cost of `ms` on every render from then on.
const stall = (engine, stage, ms) => engine.send(stage, new Uint8Array([0xf5, ms & 255, ms >> 8]));
const cost = (engine, stage, ms) => engine.send(stage, new Uint8Array([0xf6, ms]));

// Every console line of one kind, kept rather than printed.
function capture(kind) {
  const lines = [], was = console[kind];
  console[kind] = (...args) => lines.push(args.join(' '));
  lines.restore = () => { console[kind] = was; };
  return lines;
}

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
    assert.ok(s.fill > 0 && s.fill <= s.lookahead + 2 * 512 / SR, `fill ${s.fill} against a lookahead of ${s.lookahead}`);
    assert.equal(s.lookahead, engine.lookahead());
    assert.equal(s.overloaded, false);
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
// The base as the engine rounds it, to whole quanta.
const baseFor = isolated => Math.ceil((isolated ? 0.045 : 0.09) * SR / 128) * 128 / SR;

async function adapts(t, isolated, workers) {
  globalThis.crossOriginIsolated = isolated;
  const ctx = fakeContext();
  const infos = capture('info');
  const engine = await startEngine(ctx, { workers, seed: 0, wasmUrl: WASM_URL, handheld: false, steadySeconds: 1 });
  try {
    const base = baseFor(isolated), log = ctx.log, last = workers - 1;
    assert.equal(engine.lookahead(), base, 'starts at the desktop base');
    await wait(300);

    // Stalls of 200 ms on the last stage (an island, or the combined
    // stage), until one no longer underruns.
    const perStall = [];
    for (let k = 0; k < 8 && perStall.at(-1) !== 0; k++) {
      const before = log.silent;
      stall(engine, last, 200);
      await wait(500);
      perStall.push(log.silent - before);
    }
    t.diagnostic(`silent quanta per stall: ${perStall.join(', ')}; lookahead now ${(engine.lookahead() * 1000).toFixed(0)} ms`);
    assert.ok(perStall[0] > 0, 'the first stall underran');
    assert.equal(perStall.at(-1), 0, 'growth stopped the underruns');
    assert.ok(engine.lookahead() > base, `grown (${engine.lookahead()})`);
    assert.ok(infos.some(l => l.startsWith('[heart] lookahead') && l.includes('a stall')), infos.join('\n'));
    assert.deepEqual(log.bad, [], 'every quantum played is exactly its engine frames: the time map never moved');

    // A steady stretch (a second here) at a time eases it back to the base.
    await until(() => engine.lookahead() === base, 8000, 'the lookahead back at the base');
    assert.deepEqual(log.bad, [], 'shrinking dropped nothing and moved nothing');
    assert.equal(engine.stats().lookahead, base);

    // Hidden: up to the floor at once, and held there past a stretch.
    setVisibility('hidden');
    await until(() => engine.lookahead() >= 0.3, 1000, 'the hidden floor');
    await wait(1500);
    assert.ok(engine.lookahead() >= 0.3, 'held while hidden');
    await until(() => infos.some(l => l.includes('as the page hides')), 1000, 'the hidden rise told');
    setVisibility('visible');
    await until(() => engine.lookahead() < 0.3, 4000, 'easing back once visible');
    assert.deepEqual(log.bad, []);
  } finally {
    infos.restore();
    setVisibility('visible');
    engine?.close();
    await wait(20);
    ctx.stop();
  }
}

async function overload(t, isolated, workers) {
  globalThis.crossOriginIsolated = isolated;
  const ctx = fakeContext();
  const infos = capture('info'), warns = capture('warn');
  const engine = await startEngine(ctx, { workers, seed: 0, wasmUrl: WASM_URL, handheld: false });
  try {
    await wait(200);
    // 14 ms to render a chunk that lasts 10.7.
    const victim = workers === 1 ? 0 : 1, name = workers === 1 ? 'combined' : 'island 1';
    cost(engine, victim, 14);
    await until(() => warns.some(w => w.startsWith('[heart] overload')), 5000, 'the overload warning');
    const said = warns.filter(w => w.startsWith('[heart] overload'));
    const ms = Number(said[0].match(new RegExp(`${name} at (\\d+\\.\\d) ms`))?.[1]);
    assert.ok(ms >= 10.7, `names ${name} and its render time over the budget: ${said[0]}`);
    assert.ok(!said[0].includes(workers === 1 ? 'island' : 'mix'), 'only the overloaded stage is named');
    assert.equal(engine.stats().overloaded, true);
    assert.ok(infos.some(l => l.includes('overload: ' + name)), `a growth called it an overload:\n${infos.join('\n')}`);
    await wait(1200);
    assert.equal(warns.filter(w => w.startsWith('[heart] overload')).length, 1, 'said once, then quiet');
    cost(engine, victim, 0);
    await until(() => !engine.stats().overloaded, 3000, 'the overload to pass');
    assert.deepEqual(ctx.log.bad, [], 'the time map held through it');
    t.diagnostic(said[0]);
  } finally {
    infos.restore();
    warns.restore();
    engine?.close();
    await wait(20);
    ctx.stop();
  }
}

for (const [isolated, workers] of [[true, 3], [false, 3], [true, 1], [false, 1]]) {
  const mode = `${isolated ? 'SAB' : 'message'} mode, ${workers === 1 ? 'one combined worker' : 'a mix and two islands'}`;
  test(`lookahead adapts: ${mode}`, t => adapts(t, isolated, workers));
  test(`overload told apart: ${mode}`, t => overload(t, isolated, workers));
}

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
