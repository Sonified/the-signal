// The ambience family on Heart (spec 12): js/ambience.js itself, built on
// whatever route.js hands it, three ways.
//
//   off      no flag: the native context and volGain, as it always was
//   late     a Heart context whose stages render a lookahead ahead (the C2
//            rig): everything lives in the ambience island, only the two
//            buses cross into the mix (through one shared port), and
//            every gesture (a voice's start and fade in, a drift glide's
//            49 breakpoints, a fade out) is moved on by one lateness and
//            keeps its shape
//   offline  an OfflineHeartContext on the real heart.wasm: a recording
//            plays through the bus at the level the sums say, and its
//            meter reads the analyser's peak
//
// js/audio.js is the real one, on a fake native context, so the shared
// helpers (glideParam, holdParam, createRoom, the pause gate) are the ones
// the app runs. route.js is the real one too; ambience.js alone sees a thin
// wrapper over it, which answers 'ambience' with the context a test names.
// Each scenario imports its own copy of ambience.js (a query on the URL),
// since the module builds its bus once.
// Run: node --test tools/heart-tests/family-ambience.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { load } from './c2-harness.mjs';
import { FakeAudioBuffer } from './fake-audio.mjs';
import { KINDS } from '../../js/heart/protocol-gen.js';

const WASM = new URL('../../js/heart/heart.wasm', import.meta.url);
const noWasm = !existsSync(WASM) && 'js/heart/heart.wasm is not built yet';
const AMB = new URL('../../js/ambience.js', import.meta.url).href;
const ROUTE = new URL('../../js/heart/route.js', import.meta.url).href;

// ---------- route.js, as ambience.js sees it ----------
const STUB = 'data:text/javascript,' + encodeURIComponent(`
import * as real from '${ROUTE}';
const pick = f => f === 'ambience' ? globalThis.__ambienceRoute : null;
export const ctxFor = f => pick(f) ? pick(f).ctx : real.ctxFor(f);
export const masterFor = f => pick(f) ? pick(f).master : real.masterFor(f);
export const makeWorklet = (ctx, name, opts) => real.makeWorklet(ctx, name, opts);
`);
registerHooks({
  resolve(spec, context, next) {
    if (spec === './heart/route.js' && context.parentURL?.split('?')[0] === AMB) return { url: STUB, shortCircuit: true };
    return next(spec, context);
  }
});
const ambience = tag => import(`${AMB}?${tag}`);

// ---------- just enough page ----------
globalThis.window ??= globalThis;
globalThis.document ??= { getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.dispatchEvent ??= () => true;
globalThis.Audio ??= class { canPlayType() { return ''; } };
globalThis.AudioBuffer ??= FakeAudioBuffer;
// Every recording is a second of DC at 0.5, so a level can be read off the output.
const DC = 0.5;
function dcBuffer(sampleRate = 48000) {
  const b = new FakeAudioBuffer({ numberOfChannels: 2, length: sampleRate, sampleRate });
  b.getChannelData(0).fill(DC); b.getChannelData(1).fill(DC);
  return b;
}
const netFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => String(url).startsWith('audio/')
  ? Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
  : netFetch(url, ...rest);

// ---------- the native context, faked ----------
// Its clock is whichever a scenario points `clock.now` at, so audio.js's
// audioCtx.currentTime and a Heart context's agree, as they do in the app.
const clock = { now: { currentTime: 1 } };
class FakeParam {
  constructor(v = 1) { this.value = v; this.minValue = -1e9; this.maxValue = 1e9; this.calls = []; }
  setValueAtTime(v, t) { this.value = v; this.calls.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.calls.push(['linear', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); return this; }
  setTargetAtTime(v, t, tc) { this.calls.push(['target', v, t, tc]); return this; }
  setValueCurveAtTime(...a) { this.calls.push(['curve', ...a]); return this; }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; }
  cancelAndHoldAtTime(t) { this.calls.push(['hold', t]); return this; }
}
class FakeNode {
  constructor(ctx, kind) { Object.assign(this, { context: ctx, kind, outs: new Set() }); ctx.made?.push(this); }
  connect(to) { this.outs.add(to); return to; }
  disconnect(to) { if (to) this.outs.delete(to); else this.outs.clear(); }
}
class FakeNative {
  constructor() {
    this.made = [];
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = new FakeNode(this, 'destination');
    this.audioWorklet = { addModule: async () => {} };
  }
  get currentTime() { return clock.now.currentTime; }
  addEventListener() {}
  resume() { return Promise.resolve(); }
  createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return n; }
  createConvolver() { const n = new FakeNode(this, 'convolver'); n.buffer = null; return n; }
  createAnalyser() {
    const n = new FakeNode(this, 'analyser');
    n.fftSize = 2048;
    n.getFloatTimeDomainData = a => a.fill(-0.125);   // negative, so the scan's |x| shows
    return n;
  }
  createBufferSource() {
    const n = new FakeNode(this, 'buffer_source');
    Object.assign(n, { starts: [], stops: [], buffer: null, loop: false });
    n.start = (when, offset) => n.starts.push([when, offset]);
    n.stop = when => n.stops.push(when);
    return n;
  }
  createBuffer(c, l, sr) { return new FakeAudioBuffer({ numberOfChannels: c, length: l, sampleRate: sr }); }
  decodeAudioData() { return Promise.resolve(dcBuffer(this.sampleRate)); }
}
globalThis.AudioContext = FakeNative;
globalThis.AudioWorkletNode = class extends FakeNode {
  constructor(ctx, name) {
    super(ctx, name);
    this.port = { postMessage() {}, onmessage: null };
    const ps = {};
    this.parameters = { get: n => (ps[n] ??= new FakeParam(0)) };
  }
};

const h = await load();
const { S } = await import('../../js/state.js');
const audio = await import('../../js/audio.js');
await audio.ensureAudioGraph();
const native = audio.getContext();

const SR = 48000, NOW = 10, LEAD = 3200;
const fr = t => t * SR;
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One recording up (the ocean), the rest down, the session running.
function setScene(amb, level) {
  S.ambLayers = amb.normalizeAmbLayers([]);
  for (const l of S.ambLayers) { l.level = 0; l.muted = false; l.solo = false; }
  S.running = true; S.audioEnabled = true;
  S.ambVol = 0.8; S.musAmb = 1; S.ambReverb = 0; S.ambRevTime = 4.5;
  const ocean = S.ambLayers.find(l => l.source === 'ocean');
  ocean.level = level;
  return ocean;
}

test('the graph built on the fake native context', () => {
  assert.ok(native instanceof FakeNative);
  assert.equal(S.workletReady, true);
});

test('no flag: the native context and volGain, exactly as before', async () => {
  globalThis.__ambienceRoute = null;
  clock.now = { currentTime: 1 };
  const amb = await ambience('off');
  const ocean = setScene(amb, 0.5);
  const before = native.made.length;
  assert.equal(await amb.ambienceOn(), true);
  await tick();
  const made = native.made.slice(before);
  assert.ok(made.length > 0 && made.every(n => n.context === native), 'every node on the native context');
  assert.ok(made.some(n => n.kind === 'gain' && n.outs.has(audio.getMaster())), 'the buses play into volGain');
  const src = made.find(n => n.kind === 'buffer_source');
  assert.ok(src, 'the ocean is playing');
  assert.equal(src.starts[0][0], 1, 'started at currentTime');
  assert.ok(src.starts[0][1] >= 0 && src.starts[0][1] < 1, 'from a random offset');
  const g = made.find(n => n.kind === 'gain' && n.outs.has(made.find(m => m.kind === 'analyser')));
  const [op, v, t, tc] = g.gain.calls.at(-1);
  assert.deepEqual([op, v, t], ['target', 0.5, 1], 'faded in from currentTime');
  assert.ok(Math.abs(tc - 0.2) < 1e-12, 'over 0.6 s');
  assert.equal(amb.ambLayerPeak(ocean), 0.125, 'the meter scans the native waveform');
  amb.ambienceOff();
});

test('on Heart: one island, two cross edges, and every late gesture moved whole', async () => {
  const r = h.rig({ stages: 2, homes: { ambience: 1 }, now: NOW, horizon: fr(NOW) + LEAD });
  const { engine } = r;
  r.clock.createBuffer = (c, l, sr) => new FakeAudioBuffer({ numberOfChannels: c, length: l, sampleRate: sr });
  // the horizon a lookahead past the clock, wherever the clock is
  engine.horizon = () => fr(r.clock.currentTime) + LEAD;
  globalThis.__ambienceRoute = { ctx: r.ctx.island('ambience'), master: r.ctx.destination };
  clock.now = r.clock;
  const H = fr(NOW) + LEAD;

  const amb = await ambience('late');
  const ocean = setScene(amb, 0.5);
  const nativeBefore = native.made.length;
  assert.equal(await amb.ambienceOn(), true);
  await tick();
  let recs = h.take(engine);
  assert.equal(native.made.length, nativeBefore, 'nothing made natively');
  const creates = recs.filter(x => x.op === 'create');
  const ports = creates.filter(x => x.kind === KINDS.egress || x.kind === KINDS.ingress);
  assert.ok(creates.filter(x => x.kind !== KINDS.ingress && x.kind !== KINDS.master).every(x => x.stage === 1),
    'every ambience node is in its island');
  // The dry bus and the room's return both go to the master's one input,
  // so they share one port: one egress in the island, one ingress in the mix.
  assert.deepEqual(ports.map(x => [x.kind, x.stage]), [[KINDS.egress, 1], [KINDS.ingress, 0]]);
  assert.equal(recs.filter(x => x.op === 'connect' && x.stage === 1 && x.target === ports[0].node).length, 2,
    'two cross edges into it: the dry bus and the room\'s return');
  assert.ok(!recs.some(x => x.op === 'connect_param'), 'nothing feeds a param');

  // The voice: its start and its fade in move by the same Δ, and the gain
  // is born at 0 where it is made.
  const src = creates.find(x => x.kind === KINDS.buffer_source);
  const start = recs.find(x => x.op === 'start' && x.node === src.node);
  assert.equal(start.time, H, 'started a lookahead late');
  assert.ok(start.offset >= 0 && start.offset < 1);
  const fadeIn = recs.find(x => x.op === 'param_target' && Math.abs(x.value - 0.5) < 1e-6);
  assert.equal(fadeIn.time, H, 'faded in from where it starts');
  assert.ok(Math.abs(fadeIn.tau - 0.2) < 1e-12);
  const voiceGain = fadeIn.node;
  assert.deepEqual(recs.filter(x => x.op === 'param_set' && x.node === voiceGain).map(x => [x.time, x.value]),
    [[fr(NOW), 0], [H, 0]], 'born at 0, then the moved anchor');

  // A drift glide, written whole: one held anchor and 49 breakpoints, all
  // on their true times plus the same Δ, so the equal-power curve keeps its
  // shape exactly.
  amb.glideAmbLayer(ocean, 0, 12);
  amb.syncAmbLayers();
  recs = h.take(engine).filter(x => x.node === voiceGain);
  assert.deepEqual(recs.slice(0, 2).map(x => [x.op, x.time]), [['param_cancel_hold', H], ['param_set', H]]);
  const ramps = recs.slice(2);
  assert.ok(ramps.every(x => x.op === 'param_linear'));
  const start0 = NOW + 0.15, n = Math.ceil((NOW + 12 - start0) / 0.25);
  assert.equal(ramps.length, n + 1);
  ramps.forEach((x, k) => {
    const t = k === 0 ? start0 : start0 + (NOW + 12 - start0) * k / n;
    assert.ok(Math.abs(x.time - (fr(t) + LEAD)) < 1e-6, `breakpoint ${k} moved by Δ`);
  });
  assert.equal(ramps.at(-1).value, 0);
  // The 5 Hz syncs while it runs leave it alone.
  amb.syncAmbLayers();
  assert.equal(h.take(engine).filter(x => x.node === voiceGain).length, 0);

  // The meter reads the analyser's peak, and asks for the next one.
  const meter = creates.find(x => x.kind === KINDS.analyser);
  engine.emit(1, h.eventBytes([{ op: 'peak', node: meter.node, value: 0.3 }]));
  assert.ok(Math.abs(amb.ambLayerPeak(ocean) - 0.3) < 1e-6);
  assert.ok(h.take(engine).some(x => x.op === 'peak_request' && x.node === meter.node));

  // Off: the fade out moves by Δ, and the stop, 2.35 s on, lands long after
  // it has gone to silence, however late each one is.
  await tick();
  let fadeOut;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    amb.ambienceOff();
    recs = h.take(engine).filter(x => x.node === voiceGain);
    fadeOut = recs.find(x => x.op === 'param_target');
    assert.equal(fadeOut.time, H);
    assert.equal(fadeOut.value, 0);
    await tick();
    r.clock.currentTime = NOW + 2.35;
    mock.timers.tick(2350);
  } finally {
    mock.timers.reset();
  }
  const stop = h.take(engine).find(x => x.op === 'stop' && x.node === src.node);
  assert.ok(stop, 'stopped');
  assert.ok((stop.time - fadeOut.time) / SR / fadeOut.tau > 15, 'more than fifteen time constants after the fade began');
});

test('offline on heart.wasm: a recording plays at its level, and its meter reads the peak', { skip: noWasm }, async () => {
  const off = await h.OfflineHeartContext.create({
    numberOfChannels: 2, length: 2 * SR, sampleRate: SR, wasm: readFileSync(WASM)
  });
  globalThis.__ambienceRoute = { ctx: off.island('ambience'), master: off.destination };
  clock.now = off._clock;
  const amb = await ambience('offline');
  const ocean = setScene(amb, 0.5);
  assert.equal(await amb.ambienceOn(), true);
  await tick();
  await sleep(100);   // the room's impulse, handed over in an idle slot
  const out = await off.startRendering();
  // DC 0.5 × the ocean's 0.5 × the bus's 0.8, faded in on τ = 0.2 s
  const x = out.getChannelData(0), end = x[x.length - 1];
  assert.ok(Math.abs(end - DC * 0.5 * 0.8) < 1e-3, `the bus plays at its level (${end})`);
  const tAt = 0.2 * SR, want = DC * 0.5 * 0.8 * (1 - Math.exp(-1));
  assert.ok(Math.abs(x[tAt] - want) < 2e-3, `the fade in has its shape (${x[tAt]} against ${want})`);
  const [stats] = await off.inspect();
  assert.equal(stats.rejected, 0, 'no command refused');
  assert.equal(stats.cut, 0, 'no cycle cut');
  // A read asks for the peak, which the stage answers from its last frames.
  amb.ambLayerPeak(ocean);
  off._engine.drainEvents();
  const peak = amb.ambLayerPeak(ocean);
  assert.ok(Math.abs(peak - DC * 0.5) < 1e-3, `the meter reads the post-fader peak (${peak})`);
  amb.ambienceOff();
});
