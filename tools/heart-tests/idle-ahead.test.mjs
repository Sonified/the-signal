// Render ahead on idle, the engine's half end to end (§7.6), in node on
// the real heart.wasm, SAB mode (idle never runs without shared memory),
// both shapes: the heads stop at the page's limit; with the cushion grown
// the stages wake a few times a second instead of once a chunk (the
// cadence measurement, via the WAKES slots); and the ordering guarantee: a
// forward skip and a gate ramp anchored at the native now in the SAME task
// land the ramp at the fresh horizon, the base lookahead past the skip,
// never at the stale frontier seconds ahead. The same for a value written
// mid-gulp. Everything is recorded by the drain's own count (played), not
// native frame minus F: after a jump the two differ by the lead.
//
//   node --test tools/heart-tests/idle-ahead.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeBrowser, fakeContext, fake, wait, until, QUANTUM } from './fake-audio.mjs';

await installFakeBrowser();
fake.realWasm = true;
const BYTES = readFileSync(new URL('../../js/heart/heart.wasm', import.meta.url));
const WASM_URL = 'data:application/wasm;base64,' + BYTES.toString('base64');
const { startEngine } = await import('../../js/heart/engine.js');
const { HeartContext, Shadow } = await import('../../js/heart/heart.js');
const { CHUNK } = await import('../../js/heart/ring.js');

const SR = 48000;
const BASE = Math.ceil(0.3 * SR / QUANTUM) * QUANTUM;   // the default SAB base

// A recording indexed by the drain's count: engine frame (played - 1) * 128
// is the quantum just handed over.
function recByPlayed(seconds = 30) {
  const n = Math.ceil(seconds * SR);
  const rec = { L: new Float32Array(n), frames: 0, written: new Uint8Array(Math.ceil(n / QUANTUM)) };
  rec.onQuantum = (node, _frame, l) => {
    const at = (node.processor.drain.played - 1) * QUANTUM;
    if (at < 0 || at + QUANTUM > n) return;
    rec.L.set(l, at);
    rec.written[at / QUANTUM] = 1;
    rec.frames = Math.max(rec.frames, at + QUANTUM);
  };
  return rec;
}

// Where the jump really landed: a jump leaves the frames it skipped
// unwritten in a played-indexed recording, so the landing is the first
// written quantum at or after the page's estimate, which can be a few
// quanta off (the drain applies the jump a port trip later).
function landingAt(rec, skipFrame) {
  let q = Math.max(0, Math.floor(skipFrame / QUANTUM) - 8);
  while (q < rec.written.length && !rec.written[q]) q++;
  return q * QUANTUM;
}

async function boot(workers) {
  globalThis.crossOriginIsolated = true;
  const rec = recByPlayed();
  const native = fakeContext({ sampleRate: SR, onQuantum: rec.onQuantum });
  const engine = await startEngine(native, { workers, seed: 7, wasmUrl: WASM_URL });
  assert.ok(engine, 'the engine started');
  assert.equal(engine.mode, 'sab');
  const shadow = await Shadow.create(SR, engine.module);
  const mix = new HeartContext(engine, native, shadow, 'mix');
  await until(() => native.F !== null && engine.frameAt(native.F / SR) === 0, 3000, 'F');
  return { engine, native, rec, mix, async close() { engine.close(); await wait(30); native.stop(); } };
}

// Lifts the cushion to `sec` with the limit `limitSec` past the heard now,
// as the idle driver does (js/idle-ahead.js drive), and waits for the
// stages to have gulped at least `fillSec` of it AND for the drain to have
// played past the source's own late-shifted start: a jump taken inside the
// session's silent lead-in would crossfade from that silence and read as a
// fall where there is none.
async function lift(rig, sec, limitSec, fillSec) {
  const { engine, rec } = rig;
  engine.setIdle(sec + 0.5, Math.floor(engine.frameAt(engine.heardNow() + limitSec)));
  await until(() => engine.cushion() >= fillSec, 8000, `a ${fillSec} s cushion (at ${engine.cushion().toFixed(2)})`);
  await until(() => rec.frames > 0.8 * SR && Math.abs(rec.L[rec.frames - 1] - 0.25) < 1e-3, 8000, 'the source to be heard');
}

// Past the jump's own 8-quanta crossfade, where the landing is clean.
const XF = 8 * QUANTUM;

const sum = a => a.reduce((x, y) => x + y, 0);

for (const workers of [1, 3]) {
  const shape = workers === 1 ? 'one combined worker' : 'a mix and two islands';

  test(`heads stop at the limit, and an idle stage sleeps between gulps: ${shape}`, async t => {
    const rig = await boot(workers);
    const { engine, mix } = rig;
    try {
      // Something to render: a quiet constant into the master.
      const src = mix.createConstantSource(), g = mix.createGain();
      src.offset.value = 0.5;
      g.gain.value = 0.5;
      src.connect(g).connect(mix.destination);
      src.start(engine.timeAt(0));

      // The base cadence first: a stage at base wakes about once a chunk.
      await wait(300);
      const w0 = engine.wakes();
      await wait(1000);
      const w1 = engine.wakes();
      const baseRate = (sum(w1) - sum(w0)) / w1.length;

      // The lift, with a limit that binds first: the heads stop at it. The
      // limit sits 0.8 s out and this phase stays well inside it, since no
      // walk moves it on here as the driver's would.
      const limit = Math.floor(engine.frameAt(engine.heardNow() + 0.8));
      engine.setIdle(2.5, limit);
      await wait(450);
      let frames = (await engine.inspect()).map(s => s.frame);
      for (const f of frames) assert.ok(f <= limit + CHUNK, `a head stopped at the limit (${f} vs ${limit})`);
      const held = frames;
      await wait(150);
      frames = (await engine.inspect()).map(s => s.frame);
      assert.deepEqual(frames, held, 'and stayed there');

      // The limit moved on (the next walk): the stages gulp against the
      // clock and sleep between gulps, far below the base cadence.
      engine.setIdle(2.5, Math.floor(engine.frameAt(engine.heardNow() + 12)));
      await until(() => engine.cushion() >= 1.6, 8000, 'the cushion to refill');
      const w2 = engine.wakes();
      await wait(1500);
      const w3 = engine.wakes();
      const idleRate = (sum(w3) - sum(w2)) / w3.length / 1.5;
      t.diagnostic(`wakes a second a stage: ${baseRate.toFixed(1)} at base, ${idleRate.toFixed(1)} with a 2 s cushion`);
      assert.ok(baseRate > 20, `the base cadence is per chunk (${baseRate.toFixed(1)}/s)`);
      assert.ok(idleRate < baseRate / 3 && idleRate < 30, `an idle stage sleeps between gulps (${idleRate.toFixed(1)}/s)`);
      assert.equal(engine.stats().underruns, 0, 'no underrun through the lift');
    } finally { await rig.close(); }
  });

  test(`the ordering guarantee: a skip and the pause's gate in one task land at the fresh horizon: ${shape}`, async t => {
    const rig = await boot(workers);
    const { engine, native, rec, mix } = rig;
    try {
      const src = mix.createConstantSource(), g = mix.createGain();
      src.offset.value = 0.5;
      g.gain.value = 0.5;
      src.connect(g).connect(mix.destination);
      src.start(engine.timeAt(0));
      await lift(rig, 2, 12, 1.5);

      // One task, as applyAudioGain does after idleTouch: the skip, then the
      // gate anchored at the native now (a late gesture, moved whole).
      const jumped = engine.skipAhead('the test pauses');
      assert.ok(jumped > 1, `the cushion was worth jumping (${jumped.toFixed(2)} s)`);
      const skipFrame = Math.round(engine.frameAt(engine.heardNow()) / QUANTUM) * QUANTUM;
      const t0 = native.currentTime;
      g.gain.setValueAtTime(g.gain.value, t0);
      g.gain.linearRampToValueAtTime(0, t0 + 0.12);

      await until(() => rec.frames > skipFrame + BASE + 4 * CHUNK + 0.2 * SR, 8000, 'the gate to play out');
      // Still sounding where the jump landed; the gate starts within the
      // base window past it, and is silent by its end plus the ramp.
      const landing = landingAt(rec, skipFrame);
      // Base + two chunks, the spec's window, plus two quanta: the limit
      // and the landing each round to whole quanta.
      const windowEnd = landing + BASE + 2 * CHUNK + 2 * QUANTUM;
      assert.ok(Math.abs(rec.L[landing + XF] - 0.25) < 1e-3, `sounding at the skip's landing (${rec.L[landing + XF]})`);
      let fallAt = -1;
      for (let f = landing + XF; f < windowEnd + 0.13 * SR; f++) {
        if (rec.L[f] < 0.2499) { fallAt = f; break; }
      }
      assert.ok(fallAt >= 0, 'the gate was heard');
      assert.ok(fallAt >= landing, 'never before the skip target');
      assert.ok(fallAt <= windowEnd, `at the fresh horizon, not the stale frontier (${fallAt - landing} frames past the skip, window ${windowEnd - landing})`);
      const quiet = fallAt + Math.ceil(0.13 * SR);
      assert.ok(Math.abs(rec.L[quiet]) < 1e-3, `silent once the ramp is done (${rec.L[quiet]})`);
      t.diagnostic(`skipped ${jumped.toFixed(2)} s; the gate fell ${((fallAt - landing) / SR * 1000).toFixed(0)} ms past the skip (base ${(BASE / SR * 1000).toFixed(0)} ms)`);
    } finally { await rig.close(); }
  });

  test(`a settings write mid-gulp lands at the fresh horizon too: ${shape}`, async () => {
    const rig = await boot(workers);
    const { engine, rec, mix } = rig;
    try {
      const src = mix.createConstantSource(), g = mix.createGain();
      src.offset.value = 0.5;
      g.gain.value = 0.5;
      src.connect(g).connect(mix.destination);
      src.start(engine.timeAt(0));
      await lift(rig, 2, 12, 1.5);

      // Mid-gulp: no waiting for anything to settle. The skip, then the
      // value, anchored at the Heart now (the .value setter).
      const jumped = engine.skipAhead('a setting');
      assert.ok(jumped > 1);
      const skipFrame = Math.round(engine.frameAt(engine.heardNow()) / QUANTUM) * QUANTUM;
      g.gain.value = 0.1;

      await until(() => rec.frames > skipFrame + BASE + 4 * CHUNK, 8000, 'the write to play out');
      const landing = landingAt(rec, skipFrame);
      const windowEnd = landing + BASE + 2 * CHUNK + 2 * QUANTUM;
      let moved = -1;
      for (let f = landing; f < windowEnd + CHUNK; f++) {
        if (Math.abs(rec.L[f] - 0.05) < 1e-3) { moved = f; break; }
      }
      assert.ok(moved >= 0, 'the new value was heard');
      assert.ok(moved <= windowEnd, `at the fresh horizon (${moved - landing} frames past the skip, window ${windowEnd - landing})`);
    } finally { await rig.close(); }
  });
}
