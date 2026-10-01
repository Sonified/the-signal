// A browser's audio, faked in node, for the tests that run Heart's real
// transport (transport.test.mjs, with a JavaScript stand-in for the wasm)
// and the whole engine end to end (e2e.test.mjs, with the real heart.wasm).
// Not a test itself.
//
//   installFakeBrowser()   registers 'heart-drain' the way an AudioWorklet
//                          would, and gives the page AudioWorkletNode,
//                          Worker (each one a worker_thread running
//                          stage-harness.mjs) and AudioBuffer
//                          and a fetch that reads file: URLs, as a page
//                          fetches heart.wasm from its server
//   fakeContext(opts)      a native AudioContext whose audio thread is a
//                          timer: every millisecond it plays as many quanta
//                          as wall time is owed, through every drain made
//                          on it, and hands each one to opts.onQuantum
//
// The harness swaps heart.wasm for its JavaScript stand-in unless
// `fake.realWasm` is set before the engine starts its workers.

import { Worker as NodeWorker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';

export const QUANTUM = 128;
const HARNESS = new URL('./stage-harness.mjs', import.meta.url);

export const fake = {
  // Whether new workers instantiate the real heart.wasm.
  realWasm: false,
  // Every message the page posts to a worker, as { name, msg }.
  posted: []
};

// node has no AudioBuffer; this is the part of one Heart and the tests use.
export class FakeAudioBuffer {
  constructor({ numberOfChannels = 1, length, sampleRate }) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this._data[c]; }
  copyToChannel(src, c, at = 0) { this._data[c].set(src, at); }
}

const processors = {};
let nextPort = null, installed = false;

export async function installFakeBrowser() {
  if (installed) return;
  installed = true;
  globalThis.registerProcessor = (name, cls) => { processors[name] = cls; };
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = nextPort; } };
  globalThis.AudioBuffer ??= FakeAudioBuffer;
  const netFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    const u = String(url);
    if (!u.startsWith('file:')) return netFetch(url, ...rest);
    const type = u.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    return new Response(await readFile(new URL(u)), { headers: { 'content-type': type } });
  };

  // A worklet node runs its processor on our fake audio thread, which is
  // this thread, so its port is one end of a real MessageChannel.
  globalThis.AudioWorkletNode = class {
    constructor(ctx, name, options) {
      const { port1, port2 } = new MessageChannel();
      this.port = port1;
      nextPort = port2;
      this.processor = new processors[name](options);
      this.alive = true;
      this.onprocessorerror = null;
      ctx.nodes.push(this);
    }
    connect() {}
    disconnect() {}
  };

  globalThis.Worker = class {
    constructor(url, opts) {
      this.name = opts?.name || '';
      this.w = new NodeWorker(HARNESS, { workerData: { url: String(url), real: fake.realWasm } });
      this.w.on('message', data => this.onmessage && this.onmessage({ data }));
      this.w.on('error', err => this.onerror && this.onerror({ message: err.stack || err.message, preventDefault() {} }));
    }
    postMessage(msg, transfer) {
      fake.posted.push({ name: this.name, msg });
      this.w.postMessage(msg, transfer);
    }
    terminate() { this.w.terminate(); }
  };

  await import('../../js/heart/drain-worklet.js');
}

// The audio thread. `base` is the native frame the context starts at, so
// that F (the native frame of engine frame 0) is never zero by accident.
// onQuantum(drainNode, engineFrame, L, R) hears every quantum a drain plays
// once it has started; the arrays are reused, so copy what you keep.
export function fakeContext({ sampleRate = 48000, base = 4800 * QUANTUM, onQuantum = null } = {}) {
  const ctx = {
    sampleRate,
    currentTime: base / sampleRate,
    state: 'running',
    nodes: [],
    F: null,
    audioWorklet: { addModule: async () => {} },
    createBuffer: (numberOfChannels, length, sr) => new AudioBuffer({ numberOfChannels, length, sampleRate: sr }),
    resume: async () => {},
    suspend: async () => {},
    addEventListener() {},
    removeEventListener() {}
  };
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  const t0 = performance.now();
  let q = 0;
  const timer = setInterval(() => {
    const due = Math.floor((performance.now() - t0) / 1000 * sampleRate / QUANTUM);
    for (; q < due; q++) {
      const now = base + q * QUANTUM;
      globalThis.currentFrame = now;
      ctx.currentTime = now / sampleRate;
      for (const n of ctx.nodes) {
        if (!n.alive) continue;
        n.alive = n.processor.process([], [[L, R]]);
        if (!n.processor.drain.started) continue;
        if (ctx.F === null) ctx.F = now;
        if (onQuantum) onQuantum(n, now - ctx.F, L, R);
      }
    }
  }, 1);
  // Stops the audio thread and closes the drains' ports, which would
  // otherwise keep node running.
  ctx.stop = () => {
    clearInterval(timer);
    for (const n of ctx.nodes) { n.port.close(); n.processor.port.close(); }
  };
  return ctx;
}

// A recording of everything the drains play, by engine frame.
export function recorder(seconds = 10, sampleRate = 48000) {
  const n = Math.ceil(seconds * sampleRate);
  const rec = { L: new Float32Array(n), R: new Float32Array(n), frames: 0 };
  rec.onQuantum = (node, frame, l, r) => {
    if (frame + QUANTUM > n) return;
    rec.L.set(l, frame);
    rec.R.set(r, frame);
    rec.frames = Math.max(rec.frames, frame + QUANTUM);
  };
  return rec;
}

export const wait = ms => new Promise(r => setTimeout(r, ms));
export async function until(cond, ms = 3000, what = 'a condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(2);
  }
}
