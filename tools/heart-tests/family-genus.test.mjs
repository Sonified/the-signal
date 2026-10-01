// The genus family on Heart: js/audio.js builds the pulse engine, its three
// source gates, the harmonics' room and the pips' room on the context
// route.js hands it, and ends at that context's master. Here route.js is a
// stand-in that hands genus an island of an OfflineHeartContext, so the
// graph audio.js really builds is rendered for a second on the real
// heart.wasm; and, with genus not flagged, the same build is checked to be
// the native one it always was. Skips until js/heart/heart.wasm is built.
// Run: node --test tools/heart-tests/family-genus.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

const WASM = new URL('../../js/heart/heart.wasm', import.meta.url);
const skip = !existsSync(WASM) && 'js/heart/heart.wasm is not built yet';

// ---------- route.js, stood in for ----------
// The real one starts the engine's workers; this one answers from
// globalThis.__route, which each test fills in: `heart` is the families on
// Heart, by name to their context, and `engine` what heartEngine gives.
const ROUTE = `
const R = () => globalThis.__route;
export const FAMILIES = ['music', 'clouds', 'ambience', 'genus'];
export function startHeart(ctx, master) { R().native = ctx; R().master = master; return Promise.resolve(R().engine || null); }
export const ctxFor = f => R().heart[f] || R().native;
export const masterFor = f => R().heart[f] ? R().heart[f].destination : R().master;
export const makeWorklet = (ctx, name, opts) => ctx && ctx.isHeart ? ctx.createProcessor(name, opts) : new AudioWorkletNode(ctx, name, opts);
export const heartEngine = () => R().engine || null;
export const heartOn = f => !!R().heart[f];
export const parseHeartFlag = () => new Set(Object.keys(R().heart));
`;
const STUB = 'data:text/javascript,' + encodeURIComponent(ROUTE);
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  return r.url.endsWith('/js/heart/route.js') ? { url: ${JSON.stringify(STUB)}, shortCircuit: true } : r;
}`));

// ---------- just enough page ----------
globalThis.window ??= globalThis;
globalThis.document ??= { getElementById: () => null, querySelector: () => null, addEventListener() {} };
class FakeAudioBuffer {
  constructor({ numberOfChannels = 1, length, sampleRate }) {
    Object.assign(this, { numberOfChannels, length, sampleRate, duration: length / sampleRate });
    this._data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this._data[c]; }
  copyToChannel(src, c, at = 0) { this._data[c].set(src, at); }
}
globalThis.AudioBuffer ??= FakeAudioBuffer;

// A native AudioContext that only records: what it makes and what connects
// to what. The clock stands at 0, as the offline context's does.
class FakeParam {
  constructor(v = 1, min = -3.4e38, max = 3.4e38) { Object.assign(this, { value: v, minValue: min, maxValue: max }); }
  cancelScheduledValues() { return this; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
}
class FakeNode {
  constructor(ctx, kind) { Object.assign(this, { context: ctx, kind, wires: [] }); ctx.made.push(this); }
  connect(to, output = 0) { this.wires.push({ to, output }); return to; }
  disconnect() { this.wires = []; }
}
class FakeContext {
  constructor() {
    Object.assign(this, { currentTime: 0, sampleRate: 48000, state: 'running', made: [] });
    this.destination = new FakeNode(this, 'destination');
    this.audioWorklet = { addModule: async () => {} };
  }
  addEventListener() {}
  resume() { return Promise.resolve(); }
  createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return n; }
  createConvolver() { const n = new FakeNode(this, 'convolver'); n.buffer = null; return n; }
  createBuffer(ch, len, sr) { return new FakeAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr }); }
}
globalThis.AudioContext = FakeContext;
globalThis.AudioWorkletNode = class extends FakeNode {
  constructor(ctx, name, opts) {
    super(ctx, 'worklet');
    Object.assign(this, { name, opts, posts: [] });
    this.parameters = new Map(['rate', 'carrier', 'pipMs', 'amDepth', 'toneLevel', 'clickLevel', 'chirpLevel',
      'harmLevel', 'clickSend', 'chirpSend'].map(n => [n, new FakeParam(0, 0, 20000)]));
    this.port = { postMessage: m => this.posts.push(m), onmessage: null };
  }
};

const { S } = await import('../../js/state.js');
const settle = ms => new Promise(r => setTimeout(r, ms));

test('flag off: the genus graph is the native one, ending at volGain', async () => {
  globalThis.__route = { heart: {}, engine: null };
  const audio = await import('../../js/audio.js?native');
  await audio.ensureAudioGraph();
  const native = globalThis.__route.native, volGain = globalThis.__route.master;
  assert.ok(native instanceof FakeContext);
  const node = native.made.find(n => n.kind === 'worklet');
  assert.equal(node.name, 'genus');
  assert.deepEqual(node.opts, { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 1] });
  assert.deepEqual(node.wires.map(w => w.output), [0, 1, 2], 'one gate per output');
  assert.ok(node.wires.every(w => w.to.context === native), 'every gate is native');
  const intoMaster = native.made.filter(n => n.wires.some(w => w.to === volGain));
  // tone gate, harmonics dry and wet, the pips' wet return
  assert.equal(intoMaster.length, 4);
  assert.ok(native.made.every(n => n.context === native));
  await settle(400);   // let the impulses land before the next test
});

test('flag on: genus builds on its island, renders a second, meters and acks', { skip }, async () => {
  const { OfflineHeartContext } = await import('../../js/heart/heart.js');
  const off = await OfflineHeartContext.create({
    numberOfChannels: 2, length: 48000, sampleRate: 48000, wasm: readFileSync(WASM), seed: 7
  });
  const island = off.island('genus');
  globalThis.__route = { heart: { genus: island }, engine: { sampleRate: 48000 } };
  const audio = await import('../../js/audio.js?heart');
  await audio.ensureAudioGraph();
  assert.ok(S.workletReady);

  let node = null;
  audio.watchEngine(n => { node = n; });
  assert.ok(node && node.context === island, 'the engine is a Heart processor on the genus island');
  const heard = [];
  const own = node.port.onmessage;
  node.port.onmessage = e => { heard.push(e.data); own(e); };

  // The impulses are built on timers here (no Worker in node) and placed in
  // idle slots that fall back to timers too.
  await settle(600);
  assert.equal(off._engine._uploaded.size, 2, 'both rooms have their impulse');

  Object.assign(S, { audioEnabled: true, running: true, clickMode: 'click', clickOn: true, toneOn: true, harmOn: true });
  audio.applyAudioShape();
  audio.pipDipRead();

  const buf = await off.startRendering();
  const [l, r] = [buf.getChannelData(0), buf.getChannelData(1)];
  let peak = 0;
  for (let i = 0; i < l.length; i++) {
    assert.ok(Number.isFinite(l[i]) && Number.isFinite(r[i]), `sample ${i} is finite`);
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  }
  assert.ok(peak > 0.01 && peak < 4, `the family sounds (peak ${peak})`);

  const [stats] = await off.inspect();
  assert.equal(stats.rejected, 0, 'no command refused');
  assert.equal(stats.cut, 0, 'no cycle cut');

  assert.ok(heard.some(d => d.peaks), 'the meters report');
  assert.ok(audio.enginePeaks().tone > 0, 'and enginePeaks reads them');
  assert.ok(heard.some(d => typeof d.chirpAck === 'string' && d.chirpAck.startsWith('48000:')), 'the chirp table is acknowledged');
  assert.ok(heard.some(d => d.dip !== undefined), 'the dip reports while watched');
});
