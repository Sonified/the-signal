// The app's own processors against their Rust ports, null-tested in node.
// js/worklet.js and js/fdn-worklet.js are plain JavaScript, so they can run
// here under a small stand-in for the AudioWorklet's global scope, a quantum
// at a time, exactly as the browser calls them; the Rust ports run on
// OfflineHeartContext. Same input, same params, same messages: the residual
// must be below −90 dBFS (spec §9). The browser bench (tools/null-test.html)
// repeats this against the real AudioWorkletNode; this catches a port that
// has drifted before anyone opens a page.
//
// Only constant params are used here (the stand-in has no automation), and
// the processors' inputs follow Chrome: a source connected but not yet
// started hands its input a channel of zeros, and one that has finished
// leaves it with no channels at all.
//
//   node --test tools/heart-tests/worklets-null.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeAudioBuffer } from './fake-audio.mjs';

globalThis.AudioBuffer ??= FakeAudioBuffer;
const { OfflineHeartContext } = await import('../../js/heart/heart.js');
const { makeWorklet } = await import('../../js/heart/route.js');
const WASM = readFileSync(new URL('../../js/heart/heart.wasm', import.meta.url));
const Q = 128;

// ---------- the worklet's global scope ----------
const processors = {};
globalThis.registerProcessor = (name, cls) => { processors[name] = cls; };
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.currentFrame = 0;
await import('../../js/worklet.js');
await import('../../js/fdn-worklet.js');

// Runs processor `name` for `frames` at `sr`: params held at `params`
// (others at their defaults), `msgs` delivered before the first quantum,
// `input` (a Float32Array, or null) as its one mono input from frame
// `start` (a whole quantum). Returns the sum of the outputs listed in
// `taps`, each up-mixed to stereo, as [L, R].
function runJs(name, { sr, frames, params = {}, msgs = [], input = null, start = 0, outputs = [2], taps = [0] }) {
  globalThis.sampleRate = sr;
  const P = processors[name];
  const proc = new P({});
  for (const m of msgs) proc.port.onmessage({ data: m });
  const blocks = {};
  for (const d of P.parameterDescriptors || []) {
    blocks[d.name] = new Float32Array([params[d.name] ?? d.defaultValue]);
  }
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const outs = outputs.map(ch => Array.from({ length: ch }, () => new Float32Array(Q)));
  for (let at = 0; at < frames; at += Q) {
    globalThis.currentFrame = at;
    globalThis.currentTime = at / sr;
    for (const o of outs) for (const c of o) c.fill(0);
    const k = at - start;
    const ins = !input || k >= input.length ? [[]]
      : k < 0 ? [[new Float32Array(Q)]]
      : [[input.subarray(k, k + Q).length === Q ? input.subarray(k, k + Q) : Float32Array.from({ length: Q }, (_, i) => input[k + i] || 0)]];
    proc.process(ins, outs, blocks);
    for (const t of taps) {
      const o = outs[t];
      for (let i = 0; i < Q && at + i < frames; i++) {
        L[at + i] += o[0][i];
        R[at + i] += o[o.length > 1 ? 1 : 0][i];
      }
    }
  }
  return [L, R];
}

// The same on Heart: the processor through OfflineHeartContext, its outputs
// in `taps` into the destination, the input from a buffer source.
async function runHeart(name, { sr, frames, params = {}, msgs = [], input = null, start = 0, options, taps = [0] }) {
  const ctx = await OfflineHeartContext.create({ numberOfChannels: 2, length: frames, sampleRate: sr, wasm: WASM });
  const node = makeWorklet(ctx, name, options);
  for (const [k, v] of Object.entries(params)) node.parameters.get(k).value = v;
  for (const m of msgs) node.port.postMessage(m);
  for (const t of taps) node.connect(ctx.destination, t);
  if (input) {
    const buf = new AudioBuffer({ numberOfChannels: 1, length: input.length, sampleRate: sr });
    buf.getChannelData(0).set(input);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(node);
    src.start(start / sr);
  }
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

function noise(n, level = 0.5, seed = 3) {
  let a = seed;
  return Float32Array.from({ length: n }, () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return level * (a / 2147483648 - 1);
  });
}

const dB = x => x > 0 ? 20 * Math.log10(x) : -Infinity;
function residual(a, b) {
  let peak = 0, level = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < a[c].length; i++) {
      peak = Math.max(peak, Math.abs(a[c][i] - b[c][i]));
      level = Math.max(level, Math.abs(a[c][i]));
    }
  }
  return { peak: dB(peak), level: dB(level) };
}

const GENUS = { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 1] };
const CASES = [
  ['genus: the tone, free', 'genus', { params: { toneLevel: 0.6, carrier: 220, rate: 40 }, options: GENUS, outputs: [2, 2, 1], taps: [0, 2] }],
  ['genus: the pips and their send', 'genus', { params: { clickLevel: 0.8, clickSend: 0.5, carrier: 1200, rate: 12, pipMs: 5 }, options: GENUS, outputs: [2, 2, 1], taps: [0, 2] }],
  ['genus: the pips, dipping and bilateral', 'genus', { params: { clickLevel: 0.8, rate: 9, clickModDepth: 0.7, clickModRate: 2, biDepth: 1, biRate: 1.5, biHard: 0.4 }, options: GENUS, outputs: [2, 2, 1], taps: [0, 2] }],
  ['genus: linked to the flash', 'genus', {
    params: { toneLevel: 0.5, clickLevel: 0.5 }, options: GENUS, outputs: [2, 2, 1], taps: [0, 2],
    msgs: [{ signal: true, at: 0, p: 0.1, r0: 10, r1: 14, dur: 1.5, wave: 2, duty: 0.4, linked: true }]
  }],
  ['genus: a chirp table', 'genus', {
    params: { chirpLevel: 0.7, chirpSend: 0.3, rate: 6 }, options: GENUS, outputs: [2, 2, 1], taps: [0, 2],
    msgs: sr => [{ chirp: Float32Array.from({ length: Math.round(0.03 * sr) }, (_, i, n = Math.round(0.03 * sr)) =>
      Math.sin(2 * Math.PI * (600 + 4000 * i / n) * i / sr) * Math.sin(Math.PI * i / n)), sig: 'x', xf: 0.01 }]
  }],
  ['one-pole: a still cutoff', 'one-pole', { params: { frequency: 800 }, options: { outputChannelCount: [2] }, input: true }],
  ['strobe-signal: a square', 'strobe-signal', {
    options: { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] }, outputs: [1],
    msgs: [{ at: 0, p: 0, r0: 7.5, r1: 7.5, dur: 0, wave: 2, duty: 0.5, on: true }]
  }],
  ['strobe-signal: a sine, its rate ramping', 'strobe-signal', {
    options: { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] }, outputs: [1],
    msgs: [{ at: 0, p: 0.25, r0: 5, r1: 12, dur: 1.5, wave: 0, duty: 0.5, on: true }]
  }],
  ['strobe-signal: a square anchored in the past, off the sample grid', 'strobe-signal', {
    options: { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] }, outputs: [1],
    msgs: [{ at: -0.0371234, p: 0.37, r0: 13.1, r1: 13.1, dur: 0, wave: 2, duty: 0.3, on: true }]
  }],
  ['fdn-reverb: defaults', 'fdn-reverb', { options: { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, input: 'burst' }],
  ['fdn-reverb: short, dark, modulated', 'fdn-reverb', {
    params: { decay: 1.2, damping: 0.8, mod: 1 }, options: { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, input: 'burst'
  }],
  // Connected 19 quanta before its burst starts, as the bench's is: awake
  // from the connection, its lines drifting through the silence.
  ['fdn-reverb: a burst that starts late', 'fdn-reverb', {
    params: { mod: 1 }, options: { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, input: 'burst', start: 19 * Q
  }]
];

for (const sr of [48000, 44100]) {
  test(`the processors against their ports at ${sr / 1000} kHz`, async t => {
    for (const [label, name, c] of CASES) {
      await t.test(label, async () => {
        const frames = 2 * sr;
        const input = c.input === true ? noise(frames) : c.input === 'burst' ? noise(Math.round(0.2 * sr)) : null;
        const msgs = typeof c.msgs === 'function' ? c.msgs(sr) : c.msgs;
        const js = runJs(name, { ...c, sr, frames, input, msgs });
        const heart = await runHeart(name, { ...c, sr, frames, input, msgs });
        const r = residual(js, heart);
        t.diagnostic(`residual ${r.peak.toFixed(1)} dBFS against a signal of ${r.level.toFixed(1)}`);
        assert.ok(r.level > -60, 'there is a sound');
        assert.ok(r.peak < -90, `residual ${r.peak.toFixed(1)} dBFS`);
      });
    }
  });
}
