// A node worker_threads stand-in for a browser worker running
// js/heart/render-worker.js. By default it swaps heart.wasm for the
// JavaScript stand-in below, so transport.test.mjs can run the real
// transport end to end without the Rust; with workerData.real set it leaves
// the real heart.wasm in place (e2e.test.mjs). Not a test itself.
//
// The fake heart keeps the ABI of documents/heart-audio-engine.md §5 and
// renders signals that make every mistake visible:
//
//   island    egress port 0: left = the engine frame, right = its seed
//             (the engine's seed plus the stage id, so the stage id when the
//             test seeds 0)
//   mix       checks that every ingress it was asked for holds exactly the
//             frames it is about to render; master left = the frame (NaN if
//             any ingress was out of step), right = the sum of the
//             ingresses' right channels
//   combined  master left = the frame, right = 0
//
// Every command batch comes back as an event, byte for byte, and every
// uploaded buffer as an event [0xB0B0, id, f32 sum of its samples]. Command
// batches also grow the memory, so the transport's re-viewing is exercised.
//
// Two batches also act on the stage, for the lookahead tests: [0xF5, lo, hi]
// stalls it where it lands, holding the worker busy for lo + 256·hi ms, as
// an OS that parks the thread would; [0xF6, ms] makes every render from then
// on take that long (0 to stop), a stage too heavy to keep up.

import { parentPort, workerData } from 'node:worker_threads';

function fakeHeart() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 8192 });
  const CH = 512;
  let top = 64, role = 0, seed = 0, frame = 0;
  let egress = 0, master = 0, upload = null, cost = 0;
  const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
  const ingress = new Map(), asked = [], pending = [];
  const alloc = bytes => {
    const at = top;
    top += (bytes + 15) & ~15;
    const pages = Math.ceil(top / 65536) - memory.buffer.byteLength / 65536;
    if (pages > 0) memory.grow(pages);
    return at;
  };
  return {
    memory,
    heart_init(sampleRate, r, s) {
      role = r; seed = s;
      egress = alloc(8 * CH); master = alloc(8 * CH);
      for (let st = 1; st <= 4; st++) ingress.set(st * 16, alloc(8 * CH));
      return 1;
    },
    heart_alloc: alloc,
    heart_free() {},
    heart_commands(ptr, len) {
      const bytes = new Uint8Array(memory.buffer, ptr, len).slice();
      pending.push(bytes);
      if (bytes[0] === 0xf5) busy(bytes[1] + 256 * bytes[2]);
      if (bytes[0] === 0xf6) cost = bytes[1];
      alloc(70000);
    },
    heart_buffer_alloc(id, channels, frames) {
      const at = alloc(4 * channels * frames);
      upload = { id, at, n: channels * frames };
      return at;
    },
    heart_render(frames) {
      if (cost) busy(cost);
      if (upload) {
        const m = new Float32Array(memory.buffer, upload.at, upload.n);
        let sum = 0;
        for (const v of m) sum += v;
        const ev = new DataView(new ArrayBuffer(12));
        ev.setUint32(0, 0xb0b0, true); ev.setUint32(4, upload.id, true); ev.setFloat32(8, sum, true);
        pending.push(new Uint8Array(ev.buffer));
        upload = null;
      }
      const m = new Float32Array(memory.buffer);
      if (role === 1) {
        for (let i = 0; i < frames; i++) { m[egress / 4 + i] = frame + i; m[egress / 4 + CH + i] = seed; }
      } else if (role === 2) {
        let inStep = true, right = 0;
        for (const key of asked) {
          const a = ingress.get(key) / 4;
          for (let i = 0; i < frames; i++) if (m[a + i] !== frame + i) inStep = false;
          right += m[a + CH];
        }
        asked.length = 0;
        for (let i = 0; i < frames; i++) { m[master / 4 + i] = inStep ? frame + i : NaN; m[master / 4 + CH + i] = right; }
      } else {
        for (let i = 0; i < frames; i++) { m[master / 4 + i] = frame + i; m[master / 4 + CH + i] = 0; }
      }
      frame += frames;
      return frame;
    },
    heart_port_ptr(kind, port) {
      if (kind === 0) return role === 1 && port === 0 ? egress : 0;
      if (kind === 1) {
        const at = role === 2 ? ingress.get(port) : 0;
        if (at) asked.push(port);
        return at || 0;
      }
      return role !== 1 ? master : 0;
    },
    heart_events(ptrOut) {
      if (!pending.length) return 0;
      const len = pending.reduce((n, b) => n + b.length, 0), at = alloc(len);
      const u8 = new Uint8Array(memory.buffer);
      let k = at;
      for (const b of pending) { u8.set(b, k); k += b.length; }
      pending.length = 0;
      new Uint32Array(memory.buffer)[ptrOut >> 2] = at;
      return len;
    },
    heart_frame() { return frame; }
  };
}

if (!workerData.real) WebAssembly.instantiate = async () => ({ exports: fakeHeart() });

// The worker's global scope, as render-worker.js expects it. Messages that
// arrive before the module has loaded wait for it.
globalThis.self = globalThis;
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
const early = [];
parentPort.on('message', data => globalThis.onmessage ? globalThis.onmessage({ data }) : early.push(data));
await import(workerData.url);
for (const data of early) globalThis.onmessage({ data });
