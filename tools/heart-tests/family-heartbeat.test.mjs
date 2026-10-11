// The heartbeat family on Heart (spec 12): core/heartbeat.js itself, built
// on an OfflineHeartContext on the real heart.wasm.
//
//   waits    nothing is built until the app's audio graph (which starts
//            Heart) has settled, so the graph cannot land natively for
//            having come on early
//   plays    the track through level, Heart's DynamicsCompressor, the trim
//            and the gate into Heart's master, at the level the limiter's
//            arithmetic says, with no command refused
//   light    heartRead's RMS is the track's own over the 1/30 s ending at
//            the place heard at currentTime: after a start, after a Speed
//            change, and nothing before a start that Heart has not yet
//            played (a start lands at presentTime, the render horizon)
//
// js/audio.js, route.js and mixgate.js are stood in for (only what the
// module asks of them); everything else is real.
// Run: node --test tools/heart-tests/family-heartbeat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { FakeAudioBuffer } from './fake-audio.mjs';

const WASM_URL = new URL('../../js/heart/heart.wasm', import.meta.url);
const skip = !existsSync(WASM_URL) && 'js/heart/heart.wasm is not built yet';
const HB = new URL('../../core/heartbeat.js', import.meta.url).href;
const SR = 48000;

const stub = src => 'data:text/javascript,' + encodeURIComponent(src);
const STUBS = {
  '../js/audio.js': stub(`
    const H = () => globalThis.__hb;
    export const getContext = () => H().native;
    export const getMaster = () => H().nativeMaster;
    export function sourceGate(prm) { prm.value = 1; }
    export const ensureAudioGraph = () => H().graph;
  `),
  '../js/heart/route.js': stub(`
    const H = () => globalThis.__hb;
    export const ctxFor = f => f === 'heartbeat' ? H().heart : null;
    export const masterFor = f => f === 'heartbeat' ? H().heart.destination : null;
  `),
  '../js/mixgate.js': stub(`
    export const chanGate = () => 1;
    export function onChannelGates() {}
  `)
};
registerHooks({
  resolve(spec, context, next) {
    if (STUBS[spec] && context.parentURL?.split('?')[0] === HB) return { url: STUBS[spec], shortCircuit: true };
    return next(spec, context);
  }
});

globalThis.window ??= globalThis;
globalThis.AudioBuffer ??= FakeAudioBuffer;
globalThis.document ??= { getElementById: () => null, querySelector: () => null, addEventListener() {} };
// A page has one (the module takes its absence for a worker engine); it is
// never constructed here, the shared context being Heart's.
globalThis.AudioContext ??= class {};

// The track: a beat a second, a 50 Hz thump decaying over 80 ms, louder on
// the left, so its RMS moves and its down-mix is not one channel's.
const TRACK_S = 4;
function track() {
  const b = new FakeAudioBuffer({ numberOfChannels: 2, length: TRACK_S * SR, sampleRate: SR });
  const L = b.getChannelData(0), R = b.getChannelData(1);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR, beat = Math.exp(-(t % 1) / 0.08) * Math.sin(2 * Math.PI * 50 * t);
    L[i] = 0.5 * beat; R[i] = 0.3 * beat;
  }
  return b;
}
let fetched = 0;
globalThis.fetch = async url => {
  assert.equal(String(url), 'audio/heartbeat.m4a');
  fetched++;
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
};

// The RMS of the track's down-mix over `span` frames ending at frame `end`,
// looping, summed straight from the samples.
function rmsAt(b, end, span) {
  const L = b.getChannelData(0), R = b.getChannelData(1), n = b.length;
  let s = 0;
  const from = Math.floor(end - span), to = Math.floor(end);
  for (let i = from; i < to; i++) {
    const j = ((i % n) + n) % n, x = 0.5 * (L[j] + R[j]);
    s += x * x;
  }
  return Math.sqrt(s / (to - from));
}

const settle = () => new Promise(r => setTimeout(r, 0));

test('the heartbeat waits for Heart, plays through it, and its light reads the heard place', { skip }, async () => {
  const { OfflineHeartContext } = await import('../../js/heart/heart.js');
  const ctx = await OfflineHeartContext.create({ numberOfChannels: 2, length: SR, sampleRate: SR, wasm: readFileSync(WASM_URL) });
  const buf = track();
  ctx.decodeAudioData = async () => buf;
  let release;
  globalThis.__hb = { heart: ctx, native: null, nativeMaster: null, graph: new Promise(r => { release = r; }) };
  const hb = await import(`${HB}?offline`);

  // Until the audio graph settles, nothing is built or fetched.
  assert.equal(hb.heartSync(true, 1, 1), false);
  await settle();
  assert.equal(fetched, 0, 'nothing fetched while Heart may still be starting');
  release();
  await settle();
  assert.equal(hb.heartSync(true, 1, 1), false, 'built now, the track still decoding');
  assert.equal(fetched, 1);
  await settle(); await settle();
  // Decoded: the source starts at the present (0 on a fresh offline context).
  hb.heartSync(true, 1, 1);
  hb.heartRead();
  assert.equal(hb.heartDt, 0, 'the first read after a start');

  const out = await ctx.startRendering();
  const [stats] = await ctx.inspect();
  assert.equal(stats.rejected, 0, 'no command refused');
  // Under the threshold at 100%: the track, 6 ms late, times the limiter's
  // makeup and the trim that takes it back off (unity), at a settled moment.
  const L = out.getChannelData(0), at = Math.round(0.9 * SR), pre = Math.floor(0.006 * SR);
  for (let i = at; i < at + 256; i++) {
    assert.ok(Math.abs(L[i] - buf.getChannelData(0)[i - pre]) < 2e-3, `frame ${i}: ${L[i]} against ${buf.getChannelData(0)[i - pre]}`);
  }

  // The light, at currentTime 1 s (the offline clock, set by hand from here).
  const clock = ctx._clock, win = Math.round(SR / 30);
  clock.currentTime = 0.5;
  hb.heartRead();
  clock.currentTime = 0.75;
  hb.heartRead();
  assert.ok(Math.abs(hb.heartDt - 0.25) < 1e-12, 'the clock step');
  assert.ok(Math.abs(hb.heartRms - rmsAt(buf, 0.75 * SR, win)) < 1e-6, `rms ${hb.heartRms}`);

  // A Speed of 2 from where it is heard (presentTime: 1 s, the frames
  // rendered), so at 0.9 the old rate still plays, and at 1.25 the place is
  // 1 + 0.25 · 2 and the window holds 2/30 s of the track.
  hb.heartSync(true, 1, 2);
  clock.currentTime = 0.9;
  hb.heartRead();
  assert.ok(Math.abs(hb.heartRms - rmsAt(buf, 0.9 * SR, win)) < 1e-6, 'the old rate until the change is heard');
  clock.currentTime = 1.25;
  hb.heartRead();
  assert.ok(Math.abs(hb.heartRms - rmsAt(buf, 1.5 * SR, 2 * win)) < 1e-6, `rms at speed 2: ${hb.heartRms}`);

  // Paused and started again with the clock at 0.95 (Heart a lookahead
  // ahead of it): the stop and the start both land at presentTime, still
  // 1 s, so the place kept is 1 s, and there is nothing to read until the
  // start is heard.
  await settle();
  clock.currentTime = 0.95;
  hb.heartPause();
  hb.heartSync(true, 1, 2);
  hb.heartRead();
  assert.equal(hb.heartRms, 0, 'not heard yet');
  clock.currentTime = 1.1;
  hb.heartRead();
  assert.equal(hb.heartDt, 0, 'the first read once heard');
  clock.currentTime = 1.2;
  hb.heartRead();
  // heard from 1 s, from the place 1 s, at speed 2: 1 + 0.2 · 2
  assert.ok(Math.abs(hb.heartRms - rmsAt(buf, 1.4 * SR, 2 * win)) < 1e-6, `rms after the restart: ${hb.heartRms}`);
  assert.equal((await ctx.inspect())[0].rejected, 0);
});
