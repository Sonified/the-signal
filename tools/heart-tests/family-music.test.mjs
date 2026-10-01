// The music family on Heart: js/piano.js builds the notes, the drone, the
// sequencer and the shared room (convolution or the FDN) on the context
// route.js hands it, the choir and the layers build on the bus piano.js
// hands them, and the family ends at that context's master. Here route.js is
// a stand-in. With music not flagged, the build is checked to be the native
// one it always was. Flagged, a piano gesture and a sequencer bar (with the
// drone, the one-pole, the FDN, the line rooms and the strobe pulse) are
// rendered on an island of an OfflineHeartContext on the real heart.wasm,
// from stub samples. And on a fake engine whose horizon runs a lookahead
// ahead of the clock, the times that must not move (spec 6.1, late
// gestures) are checked record by record: the drone's passes and their
// fades, a detune swap, the sweep's anchor, the notes, a morph's second tone
// and its stop. Skips the renders until js/heart/heart.wasm is built.
// Run: node --test tools/heart-tests/family-music.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

const WASM = new URL('../../js/heart/heart.wasm', import.meta.url);
const skip = !existsSync(WASM) && 'js/heart/heart.wasm is not built yet';
const SR = 48000;

// ---------- route.js, stood in for ----------
// As in family-genus.test.mjs: answers from globalThis.__route, whose
// `heart` maps each family on Heart to its context.
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
// The schedulers' timers (js/ticker.js, on setInterval where there is no
// Worker) run for the session, as on a page: the strobe's tracker never
// stops once the engine exists. Unref'd, so the test's process still ends.
const setIntervalOwn = globalThis.setInterval;
globalThis.setInterval = (...args) => setIntervalOwn(...args).unref();
globalThis.window ??= globalThis;
globalThis.document ??= { getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.Audio ??= class { canPlayType() { return 'probably'; } };
class FakeAudioBuffer {
  constructor({ numberOfChannels = 1, length, sampleRate }) {
    Object.assign(this, { numberOfChannels, length, sampleRate, duration: length / sampleRate });
    this._data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this._data[c]; }
  copyToChannel(src, c, at = 0) { this._data[c].set(src, at); }
}
globalThis.AudioBuffer ??= FakeAudioBuffer;

// Every recording the music asks for decodes to the same stub: a second and
// a half of a fading 220 Hz tone. The drone's manifest is cut to fit it.
const DRONE = { versions: [{ id: 152, file: 'a' }, { id: 188, file: 'b' }], loopStart: 0.25, loopEnd: 1.5 };
globalThis.fetch = async url => String(url).endsWith('manifest.json')
  ? { ok: true, json: async () => DRONE }
  : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
function stubBuffer() {
  const b = new FakeAudioBuffer({ numberOfChannels: 2, length: SR * 1.5, sampleRate: SR });
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR) * Math.exp(-i / SR);
  }
  return b;
}

// A native AudioContext that only records what it makes and what connects
// to what, with every node and param the music touches.
class FakeParam {
  constructor(v = 1) { this.value = v; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  setValueCurveAtTime() { return this; }
}
class FakeNode {
  constructor(ctx, kind, params = []) {
    Object.assign(this, { context: ctx, kind, wires: [], started: [] });
    for (const p of params) this[p] = new FakeParam();
    ctx.made.push(this);
  }
  connect(to, output = 0) { this.wires.push({ to, output }); return to instanceof FakeParam ? undefined : to; }
  disconnect() { this.wires = []; }
  start(when = 0) { this.started.push(when); }
  stop() {}
}
class FakeContext {
  constructor() {
    Object.assign(this, { currentTime: 0, sampleRate: SR, state: 'running', made: [] });
    this.destination = new FakeNode(this, 'destination');
    this.audioWorklet = { addModule: async () => {} };
  }
  addEventListener() {}
  resume() { return Promise.resolve(); }
  createGain() { return new FakeNode(this, 'gain', ['gain']); }
  createConvolver() { const n = new FakeNode(this, 'convolver'); n.buffer = null; return n; }
  createBiquadFilter() { return new FakeNode(this, 'biquad', ['frequency', 'Q', 'detune', 'gain']); }
  createAnalyser() { const n = new FakeNode(this, 'analyser'); n.fftSize = 2048; n.getFloatTimeDomainData = a => a.fill(0); return n; }
  createBufferSource() { return new FakeNode(this, 'buffer_source', ['playbackRate', 'detune']); }
  createOscillator() { return new FakeNode(this, 'oscillator', ['frequency', 'detune']); }
  createConstantSource() { return new FakeNode(this, 'constant_source', ['offset']); }
  createStereoPanner() { return new FakeNode(this, 'stereo_panner', ['pan']); }
  createDelay() { return new FakeNode(this, 'delay', ['delayTime']); }
  createBuffer(ch, len, sr) { return new FakeAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr }); }
  async decodeAudioData() { return stubBuffer(); }
}
globalThis.AudioContext = FakeContext;
globalThis.AudioWorkletNode = class extends FakeNode {
  constructor(ctx, name, opts) {
    super(ctx, 'worklet');
    Object.assign(this, { name, opts, posts: [] });
    this.parameters = new Map(['rate', 'carrier', 'pipMs', 'amDepth', 'toneLevel', 'clickLevel', 'chirpLevel',
      'harmLevel', 'clickSend', 'chirpSend', 'decay', 'damping', 'mod', 'frequency'].map(n => [n, new FakeParam(0)]));
    this.port = { postMessage: m => this.posts.push(m), onmessage: null };
  }
};

const { S } = await import('../../js/state.js');
const settle = ms => new Promise(r => setTimeout(r, ms));
const nextTask = () => new Promise(r => setImmediate(r));

// audio.js is the one every piano.js copy below shares, so its native graph
// (genus, never flagged here) is built once.
globalThis.__route = { heart: {}, engine: null };
const audio = await import('../../js/audio.js');
await audio.ensureAudioGraph();
const native = globalThis.__route.native, volGain = globalThis.__route.master;
await settle(300);

// The music as each test wants it: the transport running, every voice off
// but those named.
function music(on) {
  Object.assign(S, {
    audioEnabled: true, running: true, pianoOn: false, pianoFreePlay: undefined, bedOn: false, arpOn: false,
    choirOn: false, musicRevType: 'conv', bedLpfOn: false, bedVerbOn: false, arpSwOn: false, arpStrobeAm: 0
  }, on);
  for (const q of S.seqs) { q.morphWave = 0; q.morphMix = 0; }
}

test('flag off: the music family builds natively and ends at volGain', async () => {
  globalThis.__route.heart = {};
  native.currentTime = 0;
  music({ pianoOn: true, musicRevType: 'algo' });
  const from = native.made.length;
  const piano = await import('../../js/piano.js?native');
  assert.ok(await piano.pianoOn(), 'the piano starts');
  piano.pianoGesture();
  const made = native.made.slice(from);
  assert.ok(made.length > 10 && made.every(n => n.context === native), 'every node is native');
  const intoMaster = made.filter(n => n.wires.some(w => w.to === volGain));
  assert.equal(intoMaster.length, 2, 'the dry bus and the room\'s wet return, as ever');
  const fdn = made.find(n => n.name === 'fdn-reverb');
  assert.ok(fdn, 'the algorithmic room is a native AudioWorkletNode');
  assert.deepEqual(fdn.opts, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  const notes = made.filter(n => n.kind === 'buffer_source');
  assert.ok(notes.length >= 1 && notes.every(n => n.started.length === 1 && n.started[0] > 0), 'notes are struck ahead');
  piano.pianoOff();
});

// One second of the family on an island of an offline context.
async function renderOn(build) {
  const { OfflineHeartContext } = await import('../../js/heart/heart.js');
  const off = await OfflineHeartContext.create({
    numberOfChannels: 2, length: SR, sampleRate: SR, wasm: readFileSync(WASM), seed: 5
  });
  globalThis.__route.heart = { music: off.island('music') };
  native.currentTime = 0;
  const piano = await build();
  let buf;
  try { buf = await off.startRendering(); } finally { piano.pianoOff(); }
  const [l, r] = [buf.getChannelData(0), buf.getChannelData(1)];
  let peak = 0;
  for (let i = 0; i < l.length; i++) {
    assert.ok(Number.isFinite(l[i]) && Number.isFinite(r[i]), `sample ${i} is finite`);
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  }
  const [stats] = await off.inspect();
  assert.equal(stats.rejected, 0, 'no command refused');
  assert.equal(stats.cut, 0, 'no cycle cut');
  return { off, peak };
}

test('flag on: a piano gesture plays on the music island', { skip }, async () => {
  const { off, peak } = await renderOn(async () => {
    music({ pianoOn: true });
    const piano = await import('../../js/piano.js?gesture');
    assert.ok(await piano.pianoOn(), 'the piano starts');
    await settle(300);    // the room's impulse lands (built on timers here)
    piano.pianoGesture();
    assert.equal(typeof piano.pianoPeak(), 'number', 'the meter reads');
    return piano;
  });
  assert.ok(off._engine._uploaded.size >= 2, 'the samples and the room\'s impulse are uploaded');
  assert.ok(peak > 0.01 && peak < 4, `the piano sounds (peak ${peak})`);
});

test('flag on: a sequencer bar with the drone, the FDN and the strobe pulse', { skip }, async () => {
  const { peak } = await renderOn(async () => {
    music({ arpOn: true, bedOn: true, bedLpfOn: true, bedLpfSlope: 6, musicRevType: 'algo', arpStrobeAm: 0.5 });
    const piano = await import('../../js/piano.js?bar');
    assert.ok(await piano.pianoOn(), 'the music starts');
    await settle(300);
    return piano;
  });
  assert.ok(peak > 0.01 && peak < 4, `the sequencer and the drone sound (peak ${peak})`);
});

// ---------- behind a lookahead ----------
// A fake engine (tools/heart-tests/c2-harness.mjs) with music on its own
// stage and every stage's horizon LEAD frames ahead of the clock, so every
// call anchored at currentTime is late by LEAD and moves (spec 6.1). The
// fixes in piano.js keep the music booked ahead where it was booked.
test('flag on, a lookahead ahead: the drone, the notes and a morph keep their times', async () => {
  const { load } = await import('./c2-harness.mjs');
  const { KINDS } = await import('../../js/heart/protocol-gen.js');
  const h = await load();
  const NOW = 10, LEAD = 6000;
  const { engine, ctx } = h.rig({ stages: 2, homes: { music: 1 }, now: NOW, horizon: NOW * SR + LEAD });
  const island = ctx.island('music');
  globalThis.__route.heart = { music: island };
  native.currentTime = NOW;     // glideParam's clock, the one the rig's shares
  const H = NOW * SR + LEAD, present = island.presentTime;
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1, `${what}: ${a} is not ${b}`);

  music({ arpOn: true, bedOn: true, bedLpfOn: true, bedDetune: 152 });
  S.seqs[0].morphWave = 2;           // line 1 morphing in from a triangle
  S.seqs[0].morphMix = 0.5;
  const piano = await import('../../js/piano.js?late');
  // a failed check still stops the music, so its timers let the process end
  try {
    assert.ok(await piano.pianoOn(), 'the music starts');
    const recs = h.take(engine);

    // one island: the music builds in its stage; the mix holds only the
    // master and the one port both the dry bus and the wet return ride in on
    const kindOf = new Map(recs.filter(r => r.op === 'create').map(r => [r.node, r.kind]));
    const mixKinds = recs.filter(r => r.op === 'create' && r.stage === 0).map(r => r.kind);
    assert.deepEqual(mixKinds.filter(k => k !== KINDS.master), [KINDS.ingress], 'one port into the mix');
    assert.equal(recs.filter(r => r.op === 'create' && r.kind === KINDS.egress).length, 1);
    assert.ok(recs.filter(r => r.op === 'connect_param').every(r => r.stage === 1), 'every param edge is in the island');

    // the drone's passes: the first starts just after the present, unmoved,
    // and its fade out meets the next pass's fade in exactly
    const passes = recs.filter(r => r.op === 'start' && kindOf.get(r.node) === KINDS.buffer_source);
    assert.ok(passes.length >= 2, 'the intro and a pass are booked');
    near(passes[0].time, (present + 0.05) * SR, 'the first pass starts a moment after the present');
    const gainOf = src => recs.find(r => r.op === 'connect' && r.node === src.node).target;
    const curves = g => recs.filter(r => r.op === 'param_curve' && r.node === g);
    const [out0] = curves(gainOf(passes[0]));
    const [in1, out1] = curves(gainOf(passes[1]));
    assert.equal(in1.time, out0.time, 'the first crossfade is aligned');
    assert.equal(in1.time, passes[1].time, 'a pass fades in as it starts');
    assert.ok(out0.time > passes[0].time && out1.time > in1.time);
    const stop0 = recs.find(r => r.op === 'stop' && r.node === passes[0].node);
    near(stop0.time, out0.time + out0.duration * SR, 'the first pass stops as its fade ends');

    // the cutoff is born at its first value (from the node's first frame and
    // at the present, spec 6.1), then the sweep's anchor, a moment after the
    // present, and nothing behind it
    const cut = recs.find(r => r.op === 'create' && r.kind === KINDS.constant_source).node;
    const cutTimes = recs.filter(r => r.node === cut && r.op.startsWith('param')).map(r => r.time);
    assert.deepEqual(cutTimes.slice(0, 2), [NOW * SR, H], 'the cutoff\'s first value');
    assert.ok(cutTimes.length > 4 && cutTimes.slice(1).every(t => t >= H - 1), 'the cutoff\'s plan is never late');
    near(cutTimes[2], (present + 0.05) * SR, 'the sweep anchors a moment after the present');

    // the notes: the first a tenth of a second after the present, unmoved,
    // and the morph's second tone handed the same pitches at the same times
    const oscs = recs.filter(r => r.op === 'create' && r.kind === KINDS.oscillator && r.stage === 1).map(r => r.node);
    const pitch = o => recs.filter(r => r.node === o && r.op === 'param_target' && r.param === 0);
    const [o1, o2] = oscs.filter(o => pitch(o).length);
    assert.ok(o1 && o2, 'the line\'s tone and the morph\'s second tone');
    near(pitch(o1)[0].time, (present + 0.1) * SR, 'the first note is a tenth of a second after the present');
    assert.deepEqual(pitch(o2).map(r => r.time), pitch(o1).map(r => r.time), 'both tones play every note together');

    // the morph lands: the second tone's fade is heard from the present, and
    // its stop is a quarter second after that
    await nextTask();
    S.seqs[0].morphWave = 0;
    piano.applySeqs();
    const after = h.take(engine);
    const stop2 = after.find(r => r.op === 'stop' && r.node === o2);
    near(stop2.time, (present + 0.25) * SR, 'the second tone stops a quarter second after the present');
    const m2 = recs.find(r => r.op === 'connect' && r.node === o2).target;
    const fade = after.find(r => r.op === 'param_target' && r.node === m2);
    assert.equal(fade.value, 0);
    near(stop2.time - fade.time, 0.25 * SR, 'its fade has the whole quarter second');

    // a detune swap: the old run's fade out, the new run's fade in and the new
    // pass all start together, a moment after the present
    await nextTask();
    S.bedDetune = 188;
    await piano.applyBedDetune();
    const swap = h.take(engine);
    const fades = swap.filter(r => r.op === 'param_target' && (r.value === 0 || r.value === 1) && r.tau === 1);
    assert.equal(fades.length, 2, 'one fade out, one fade in');
    assert.equal(fades[0].time, fades[1].time, 'the swap\'s fades are aligned');
    near(fades[0].time, (present + 0.05) * SR, 'a moment after the present');
    const pass = swap.find(r => r.op === 'start');
    assert.equal(pass.time, fades[0].time, 'the new pass starts with them');
  } finally {
    piano.pianoOff();
    S.seqs[0].morphMix = 0;
  }
});
