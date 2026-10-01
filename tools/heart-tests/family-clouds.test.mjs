// The clouds family on Heart: js/clouds.js itself, loaded in node, its pads
// rendered on an OfflineHeartContext from stand-in recordings. Its import of
// route.js is pointed at a stand-in that answers ctxFor('clouds') and
// masterFor('clouds') with the offline context's clouds island, as the real
// route.js does under ?heart=clouds; everything else is the app's own code
// (audio.js's room and pause gate, strobe-am.js, util.js's meter). It skips
// until js/heart/heart.wasm has been built (heart/build.sh).
// Run: node --test tools/heart-tests/family-clouds.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { FakeAudioBuffer, wait } from './fake-audio.mjs';

const WASM = new URL('../../js/heart/heart.wasm', import.meta.url);
const skip = !existsSync(WASM) && 'js/heart/heart.wasm is not built yet';
const SR = 48000;

// Just enough page for js/audio.js and the clouds to load in node.
globalThis.window ??= globalThis;
globalThis.document ??= { getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.AudioBuffer ??= FakeAudioBuffer;
globalThis.Audio = class { canPlayType() { return 'probably'; } };
// The schedulers' ticker gets a worker that never ticks, so nothing runs
// behind the test's back (the clouds' next step, the strobe stages'
// tracker). No other worker can be made, so audio.js builds the room's
// impulse on this thread, as it does wherever its worker will not load.
globalThis.Worker = class {
  constructor(url) { if (!String(url).includes('ticker-worker')) throw new Error('no workers here'); }
  postMessage() {}
  terminate() {}
};
// The recordings: every fetch answers with a few bytes, which the stand-in
// decoder below ignores.
globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(8) });

// clouds.js's route.js, with the clouds' context and master taken from
// globalThis.__cloudsOnHeart once a test sets it, and everything else the
// real module's.
const ROUTE = new URL('../../js/heart/route.js', import.meta.url).href;
const STAND_IN = 'data:text/javascript,' + encodeURIComponent(
  `import * as real from ${JSON.stringify(ROUTE)};
   export * from ${JSON.stringify(ROUTE)};
   const on = () => globalThis.__cloudsOnHeart;
   export const ctxFor = f => f === 'clouds' && on() ? on().ctx : real.ctxFor(f);
   export const masterFor = f => f === 'clouds' && on() ? on().ctx.destination : real.masterFor(f);`);
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(spec, context, next) {
     if (spec === './heart/route.js' && (context.parentURL || '').endsWith('/js/clouds.js')) {
       return { url: ${JSON.stringify(STAND_IN)}, shortCircuit: true };
     }
     return next(spec, context);
   }`));

const { OfflineHeartContext } = await import('../../js/heart/heart.js');
const { S } = await import('../../js/state.js');
const clouds = await import('../../js/clouds.js');

// A stand-in recording: 14 s of a 1 kHz sine, which the pads' highpass
// (934 Hz) passes and their lowpass envelope opens onto.
function padRecording() {
  const b = new FakeAudioBuffer({ numberOfChannels: 1, length: 14 * SR, sampleRate: SR });
  const x = b.getChannelData(0);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / SR);
  return b;
}
const rms = (x, t0, t1) => {
  let s = 0;
  const a = Math.round(t0 * SR), b = Math.round(t1 * SR);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};

test('with no audio graph yet, the clouds wait rather than throw', async () => {
  assert.equal(await clouds.loadClouds(), false);
  assert.equal(await clouds.cloudsOn(), false);
  assert.equal(clouds.cloudsReady(), false);
});

test('pads render on the clouds island and keep their booked time', { skip }, async () => {
  S.cloudStrobeAm = 0;
  S.cloudPhrase = 1;            // a falling figure: several pads booked in one task
  S.cloudDensity = 1;
  S.workletReady = true;        // the strobe stage taps a Heart strobe-signal node
  const seconds = 7;
  const offline = await OfflineHeartContext.create({
    numberOfChannels: 2, length: seconds * SR, sampleRate: SR, wasm: readFileSync(WASM), seed: 1
  });
  const ctx = offline.island('clouds');
  const recording = padRecording();
  let decoded = 0;
  ctx.decodeAudioData = async () => { decoded++; return recording; };
  globalThis.__cloudsOnHeart = { ctx };

  assert.equal(await clouds.cloudsOn(), true);
  assert.equal(decoded, 8, 'every recording decoded through the family context');
  assert.ok(clouds.cloudsReady());
  // the room's first impulse is built off the clock and faded in from empty
  await wait(400);
  clouds.cloudsOff();

  const out = await offline.startRendering();
  const [st] = await offline.inspect();
  assert.equal(st.rejected, 0, 'no command refused');
  assert.equal(st.cut, 0, 'no cycle cut');
  for (const c of [0, 1]) {
    const x = out.getChannelData(c);
    let peak = 0, early = 0;
    for (let i = 0; i < x.length; i++) {
      assert.ok(Number.isFinite(x[i]), `channel ${c} frame ${i} is not finite`);
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
      if (i < 0.5 * SR && a > early) early = a;
    }
    assert.ok(peak > 1e-3 && peak < 1, `channel ${c}: peak ${peak}`);
    // cloudsOn books the first pad half a second on, and nothing sounds before it
    assert.ok(early < 1e-6, `channel ${c}: ${early} before the first pad`);
    // the attack opens over 1.23 s: its first fifth of a second is far below its top
    assert.ok(rms(x, 0.5, 0.7) * 4 < rms(x, 1.5, 1.8), `channel ${c}: no attack`);
  }
});
