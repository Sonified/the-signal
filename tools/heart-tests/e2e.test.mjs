// Heart end to end, in node, on the real heart.wasm: the twin API
// (js/heart/heart.js, nodes.js, params.js) building graphs on the real
// transport (engine.js, render-worker.js in worker_threads, the
// 'heart-drain' processor on a fake audio thread). Run in both modes
// (SharedArrayBuffer and messages) and both shapes (one combined worker; a
// mix and two islands, where every island edge crosses a port).
//
// Each scenario plays a short graph a few hundred milliseconds ahead and
// checks what the drain played against what the graph must make: exact
// values where they can be worked out, an OfflineHeartContext render of the
// same graph where they cannot, and the engine's events (ended, peak,
// processor messages), the shadow's param values, the ports cross edges
// open and close, buffer release, and every stage's own counters (no
// command rejected, no cycle cut). Last, route.js on a flag, and what it
// does when a stage dies under it.
//
//   node --expose-gc --test tools/heart-tests/e2e.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeBrowser, fakeContext, recorder, fake, wait, until, QUANTUM } from './fake-audio.mjs';

await installFakeBrowser();
fake.realWasm = true;
const BYTES = readFileSync(new URL('../../js/heart/heart.wasm', import.meta.url));
const WASM_URL = 'data:application/wasm;base64,' + BYTES.toString('base64');
const { startEngine } = await import('../../js/heart/engine.js');
const { HeartContext, Shadow, OfflineHeartContext } = await import('../../js/heart/heart.js');
const { registerBuffer } = await import('../../js/heart/buffers.js');

const SR = 48000;
// How far ahead a scenario is scheduled: past every stage's render head in
// either mode (message mode's lookahead is 90 ms, and an island runs up to
// three chunks beyond).
const AHEAD = 0.3;
const collect = async () => {
  for (let i = 0; i < 4; i++) { globalThis.gc?.(); await wait(10); }
};

// ---------- the rig ----------
async function boot(isolated, workers) {
  globalThis.crossOriginIsolated = isolated;
  const rec = recorder(40, SR);
  const native = fakeContext({ sampleRate: SR, onQuantum: rec.onQuantum });
  const engine = await startEngine(native, { workers, seed: 7, wasmUrl: WASM_URL });
  assert.ok(engine, 'the engine started');
  const shadow = await Shadow.create(SR, engine.module);
  const mix = new HeartContext(engine, native, shadow, 'mix');
  // F has reached the page, so frameAt is exact from here on.
  await until(() => native.F !== null && engine.frameAt(native.F / SR) === 0, 3000, 'F');
  return {
    engine, native, rec, mix,
    // The drain hears 'close' over its port, and lets its ring go, before
    // the ports are closed under it.
    async close() { engine.close(); await wait(30); native.stop(); }
  };
}

// A native time `ahead` seconds on whose engine frame is a whole number, so
// that sources start on a sample and their output can be read exactly.
function at({ engine, native }, ahead = AHEAD) {
  for (let frame = Math.ceil(engine.frameAt(native.currentTime + ahead)); ; frame++) {
    const t = engine.timeAt(frame);
    if (engine.frameAt(t) === frame) return { t, frame };
  }
}

// Waits until the drain has played up to `frame`.
const playedTo = (rig, frame) => until(() => rig.rec.frames > frame, 5000, `frame ${frame} to play`);

// The largest |a[i] - b[j]| over n frames from i0 and j0.
function maxDiff(a, i0, b, j0, n) {
  let d = 0;
  for (let k = 0; k < n; k++) d = Math.max(d, Math.abs(a[i0 + k] - b[j0 + k]));
  return d;
}

function ramp(n, f) {
  const buf = new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: SR });
  const x = buf.getChannelData(0);
  for (let i = 0; i < n; i++) x[i] = f(i);
  return buf;
}

// ---------- the scenarios ----------
async function constantThroughGain(rig) {
  const { mix, rec } = rig, { t, frame } = at(rig);
  const src = mix.createConstantSource(), g = mix.createGain();
  src.offset.value = 0.5;
  g.gain.value = 0.5;
  src.connect(g).connect(mix.destination);
  let ended = 0;
  src.onended = () => ended++;
  src.start(t);
  src.stop(t + 0.1);
  await until(() => ended, 3000, 'ended');
  await playedTo(rig, frame + 4800 + QUANTUM);
  assert.equal(rec.L[frame - 1], 0, 'nothing before the start');
  assert.equal(maxDiff(rec.L, frame, new Float32Array(4800).fill(0.25), 0, 4800), 0, 'left: 0.5 × 0.5');
  assert.equal(maxDiff(rec.R, frame, new Float32Array(4800).fill(0.25), 0, 4800), 0, 'right: up-mixed');
  assert.equal(rec.L[frame + 4800], 0, 'nothing from the stop on');
  assert.equal(ended, 1, 'ended once');
}

// An island's chain into the mix, against the same graph rendered offline.
async function islandChainMatchesOffline(rig) {
  const { mix, rec, engine } = rig, { t, frame } = at(rig);
  const build = (ctx, t0) => {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), p = ctx.createStereoPanner();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t0);
    o.frequency.exponentialRampToValueAtTime(880, t0 + 0.2);
    f.frequency.value = 1200;
    f.Q.value = 3;
    p.pan.setValueAtTime(-0.5, t0);
    p.pan.linearRampToValueAtTime(0.5, t0 + 0.2);
    o.connect(f).connect(p).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + 0.25);
    return { o, p };
  };
  const { o, p } = build(mix.island('music'), t);
  let ended = false;
  o.onended = () => { ended = true; };

  // Offline, on the same sub-quantum position, so k-rate and block-wise
  // work fall on the same frames.
  let off = 2 * QUANTUM + frame % QUANTUM;
  while ((off / SR) * SR !== off) off += QUANTUM;
  const n = 0.25 * SR + QUANTUM;
  const ctx = await OfflineHeartContext.create({ numberOfChannels: 2, length: off + n, sampleRate: SR, wasm: BYTES });
  build(ctx, off / SR);
  const want = await ctx.startRendering();

  await until(() => ended, 3000, 'ended');
  await playedTo(rig, frame + n);
  const dL = maxDiff(rec.L, frame, want.getChannelData(0), off, n);
  const dR = maxDiff(rec.R, frame, want.getChannelData(1), off, n);
  assert.ok(Math.max(...want.getChannelData(0).subarray(off, off + n).map(Math.abs)) > 0.05, 'it made a sound');
  assert.ok(dL < 1e-6 && dR < 1e-6, `live equals offline (left ${dL}, right ${dR})`);

  // The cross edge's port closes with its last edge, and is free again.
  const ports = mix._graph._ports.get(p._stage);
  if (engine.stages.length > 1) {
    assert.equal(ports.open.size, 1, 'one port open');
    p.disconnect();
    assert.equal(ports.open.size, 0, 'closed');
    assert.equal(ports.free.length, 16, 'and free');
  } else {
    assert.equal(ports, undefined, 'one stage: no ports');
  }
}

async function bufferSourceExact(rig) {
  const { mix, rec, engine } = rig, { t, frame } = at(rig);
  const clouds = mix.island('clouds');
  const N = 2400;
  let id, ended = false;
  (() => {
    const buf = ramp(N, i => (i + 1) / N);
    id = registerBuffer(buf);
    const src = clouds.createBufferSource(), g = clouds.createGain();
    src.buffer = buf;
    src.connect(g).connect(mix.destination);
    src.onended = () => { ended = true; };
    src.start(t);
  })();
  await until(() => ended, 3000, 'ended');
  await playedTo(rig, frame + N + QUANTUM);
  const want = ramp(N, i => (i + 1) / N).getChannelData(0);
  assert.equal(maxDiff(rec.L, frame, want, 0, N), 0, 'the samples, exactly');
  assert.equal(maxDiff(rec.R, frame, want, 0, N), 0);
  assert.equal(rec.L[frame + N], 0, 'and then silence');

  // Let go of, the buffer is freed on the stage that held it (seen only
  // when node can be made to collect).
  if (!globalThis.gc) return;
  const stage = engine.stageFor('clouds');
  await collect();
  await until(() => fake.posted.some(p => p.msg.type === 'free' && p.msg.id === id), 3000, 'the free');
  const frees = fake.posted.filter(p => p.msg.type === 'free' && p.msg.id === id);
  assert.equal(frees.length, 1, 'freed once');
  assert.match(frees[0].name, new RegExp(` ${stage}$`), `on stage ${stage}`);
}

// A room in the mix fed from an island; then a new impulse, and the old
// one freed.
async function convolverRoom(rig) {
  const { mix, rec } = rig;
  const room = mix.createConvolver();
  room.normalize = false;
  const first = ramp(256, i => i === 0 ? 1 : i === 100 ? 0.5 : 0);
  room.buffer = first;
  room.connect(mix.destination);
  const ambience = mix.island('ambience');

  const play = async (level, expect) => {
    const { t, frame } = at(rig);
    const src = ambience.createConstantSource();
    src.offset.value = level;
    src.connect(room);
    src.start(t);
    src.stop(t + 0.1);
    await playedTo(rig, frame + 4800 + 512);
    for (const [from, to, v] of expect) {
      const d = maxDiff(rec.L, frame + from, new Float32Array(to - from).fill(v), 0, to - from);
      assert.ok(d < 1e-6, `frames ${from} to ${to} are ${v} (off by ${d})`);
    }
  };
  await play(0.25, [[0, 100, 0.25], [100, 4800, 0.375], [4800, 4900, 0.125], [4900, 5200, 0]]);

  const firstId = registerBuffer(first);
  room.buffer = ramp(64, i => i === 0 ? 0.5 : 0);
  await until(() => fake.posted.some(p => p.msg.type === 'free' && p.msg.id === firstId), 2000, 'the old impulse freed');
  await play(0.5, [[0, 4800, 0.25], [4800, 5200, 0]]);
}

// One strobe signal heard on two islands: one side added, the other taken
// away, so the master is exactly zero while the replicas agree to the bit.
async function strobeReplicas(rig) {
  const { mix, rec, native, engine } = rig;
  const sig = mix.createProcessor('strobe-signal');
  const a = mix.island('music').createGain(), b = mix.island('clouds').createGain();
  b.gain.value = -1;
  sig.connect(a).connect(mix.destination);
  sig.connect(b).connect(mix.destination);
  if (engine.stages.length > 1) assert.equal(sig._core.reals.size, 2, 'a replica on each island stage');

  const t0 = native.currentTime;
  sig.port.postMessage({ at: t0, p: 0, r0: 6, r1: 6, dur: 0, wave: 0, duty: 0.5, on: true });
  await wait(150);
  // A second change, a ramp of the rate, mid-flight.
  sig.port.postMessage({ at: native.currentTime, p: 0.3, r0: 6, r1: 11, dur: 0.4, wave: 2, duty: 0.4, on: true });
  const { t, frame } = at(rig, 0.6);
  b.gain.setValueAtTime(0, t);
  await playedTo(rig, frame + SR / 4);

  const from = Math.floor(engine.frameAt(t0));
  let worst = 0;
  for (let k = from; k < frame; k++) worst = Math.max(worst, Math.abs(rec.L[k]), Math.abs(rec.R[k]));
  assert.equal(worst, 0, 'the replicas agree on every frame');
  const after = rec.L.subarray(frame, frame + SR / 4);
  assert.ok(Math.min(...after) < -0.9 && Math.max(...after) > 0.9, 'and the signal flickers');
  b.gain.setValueAtTime(-1, at(rig).t);
}

async function genusTalks(rig) {
  const { mix, rec } = rig;
  const gen = mix.island('genus').createProcessor('genus', {
    numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 1]
  });
  const peaks = [], acks = [];
  gen.port.onmessage = e => {
    if (e.data.peaks) peaks.push({ ...e.data });
    if (e.data.chirpAck !== undefined) acks.push(e.data.chirpAck);
  };
  const { t, frame } = at(rig);
  gen.parameters.get('toneLevel').setValueAtTime(0.3, t);
  gen.connect(mix.destination, 0);
  gen.port.postMessage({ chirp: new Float32Array(64).fill(0.1), sig: 'table-a', xf: 0.03 });
  await until(() => acks.includes('table-a'), 3000, 'the chirp table acknowledged');
  await until(() => peaks.some(p => p.tone > 0), 3000, 'a tone peak');
  await playedTo(rig, frame + SR / 4);
  const heard = rec.L.subarray(frame, frame + SR / 4);
  assert.ok(Math.max(...heard.map(Math.abs)) > 0.05, 'the tone plays');
  gen.parameters.get('toneLevel').setValueAtTime(0, at(rig).t);
  gen.disconnect();
}

async function analyserPeak(rig) {
  const { mix } = rig;
  const music = mix.island('music');
  const src = music.createConstantSource(), an = music.createAnalyser();
  src.offset.value = -0.625;
  src.connect(an);
  src.start(at(rig).t);
  await until(() => an.peak() === 0.625, 3000, 'the peak');
  const arr = new Float32Array(32);
  an.getFloatTimeDomainData(arr);
  assert.equal(arr[0], 0.625);
  src.stop();
}

async function shadowValues(rig) {
  const { mix, native } = rig;
  const g = mix.island('music').createGain();
  // Nothing before it: the ramp starts where the call lands, the present
  // (a render horizon past currentTime), from the value held; and values
  // are read at the present too (nodes.js, late gestures).
  const t0 = native.currentTime;
  g.gain.linearRampToValueAtTime(0, t0 + 1);
  const p0 = mix.presentTime;
  assert.ok(p0 > t0, 'the present is ahead of the clock');
  await wait(300);
  const v = g.gain.value, p1 = mix.presentTime;
  assert.ok(Math.abs(v - (1 - (p1 - p0) / (t0 + 1 - p0))) < 1e-3, `${v} at ${p1 - p0} s in`);
  g.gain.cancelAndHoldAtTime(native.currentTime);
  const held = g.gain.value;
  await wait(50);
  assert.equal(g.gain.value, held, 'held');
  g.gain.setTargetAtTime(2, native.currentTime, 0.05);
  await wait(400);
  assert.ok(Math.abs(g.gain.value - 2) < 1e-3, `approached its target (${g.gain.value})`);
}

async function droppedNodesAreFreed(rig) {
  const { mix, engine } = rig;
  if (!globalThis.gc) return;      // run with --expose-gc to see it
  const before = await engine.inspect();
  (() => {
    const music = mix.island('music');
    let prev = music.createGain();
    for (let i = 0; i < 49; i++) { const g = music.createGain(); prev.connect(g); prev = g; }
  })();
  await wait(50);
  const made = await engine.inspect();
  const stage = engine.stageFor('music');
  assert.equal(made[stage].nodes, before[stage].nodes + 50);
  await collect();
  let after;
  for (let tries = 0; tries < 50; tries++) {
    after = await engine.inspect();
    if (after[stage].nodes <= before[stage].nodes) break;
    await wait(20);
  }
  assert.ok(after[stage].nodes <= before[stage].nodes, `freed (${before[stage].nodes} → ${made[stage].nodes} → ${after[stage].nodes})`);
}

const SCENARIOS = [
  ['a constant source and a gain into the destination', constantThroughGain],
  ['oscillator, biquad and panner on an island, the same as offline', islandChainMatchesOffline],
  ['a buffer source plays its samples exactly, and its buffer is freed', bufferSourceExact],
  ['a convolver room in the mix, and a new impulse', convolverRoom],
  ['one strobe signal on two islands agrees to the bit', strobeReplicas],
  ['genus plays, reports its peaks and acknowledges a chirp table', genusTalks],
  ['an analyser\'s peak comes back', analyserPeak],
  ['param values come from the shadow', shadowValues],
  ['nodes the page lets go of are freed', droppedNodesAreFreed]
];

for (const [isolated, workers] of [[true, 1], [false, 1], [true, 3], [false, 3]]) {
  const mode = `${isolated ? 'SAB' : 'message'} mode, ${workers === 1 ? 'one combined worker' : 'a mix and two islands'}`;
  test(mode, async t => {
    const rig = await boot(isolated, workers);
    const warn = console.warn, warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      for (const [name, run] of SCENARIOS) await t.test(name, () => run(rig));
      const stages = await rig.engine.inspect();
      for (const s of stages) {
        assert.equal(s.rejected, 0, `stage ${s.stage} rejected no command`);
        assert.equal(s.cut, 0, `stage ${s.stage} cut no cycle`);
      }
      const st = rig.engine.stats();
      t.diagnostic(`underruns ${st.underruns}, render ${st.renderMs.map(ms => ms.toFixed(2)).join(' / ')} ms a chunk`);
      assert.deepEqual(warned, [], 'nothing said in the console');
    } finally {
      console.warn = warn;
      await rig.close();
    }
  });
}

test('route.js: flagged families get Heart, and a stage that dies sends the unbuilt ones native', async () => {
  globalThis.crossOriginIsolated = true;
  globalThis.location = { search: '?heart=music,clouds' };
  const native = fakeContext({ sampleRate: SR });
  const master = { connected: [] };
  const route = await import('../../js/heart/route.js');
  const warn = console.warn, warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  let engine;
  try {
    engine = await route.startHeart(native, master);
    assert.ok(engine, 'started on the flag');
    assert.equal(await route.startHeart(native, master), engine, 'once');
    assert.equal(route.ctxFor('genus'), native, 'an unflagged family plays natively');
    const music = route.ctxFor('music');
    assert.ok(music.isHeart && route.heartOn('clouds'));
    assert.equal(route.masterFor('music'), music.destination);

    // A stage fails after start: an upload it refuses (no channels) is a
    // failure inside the worker, reported back as an 'error'.
    const last = engine.stages.length - 1;
    engine.ensureBuffer(999999, last, { numberOfChannels: 0, length: 0, sampleRate: SR, getChannelData() {} });
    await until(() => warned.some(w => w.includes('failed')), 3000, 'the failure');
    assert.equal(route.ctxFor('music'), music, 'music had been built on Heart, and stays');
    assert.equal(route.ctxFor('clouds'), native, 'clouds had not, and goes native');
    assert.equal(route.masterFor('clouds'), master);
    assert.ok(warned.some(w => w.includes('music already built on Heart')), warned.join('\n'));
  } finally {
    console.warn = warn;
    delete globalThis.location;
    engine?.close();
    await wait(30);
    native.stop();
  }
});
