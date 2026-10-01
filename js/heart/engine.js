// Heart's transport: starts the engine on top of a running native
// AudioContext and gives the twin API (js/heart/heart.js) the one object it
// talks to (documents/heart-audio-engine.md, §7.1). Everything that moves
// audio or commands between threads starts here:
//
//   the pool        render workers, one heart.wasm stage each (pool.js,
//                   render-worker.js), stage 0 the mix or the combined stage
//   the rings       island → mix egress rings and the mix → drain final
//                   ring (ring.js), shared memory when the page is
//                   cross-origin isolated, messages when it is not
//   the drain       the 'heart-drain' AudioWorklet that plays the final ring
//                   into the native master and is the engine's clock
//                   (drain-worklet.js)
//   the buffers     AudioBuffers copied once into the stages that use them
//                   (buffers.js)
//
// Heart is an optimisation, never a dependency. If this device cannot run
// it (no wasm SIMD, heart.wasm missing, the worklet or a worker failing to
// start), startEngine says why in the console and resolves to null, and the
// caller keeps the native engine.
//
// The engine's time is frames from the moment the drain first plays. The
// drain posts the native frame F at which engine frame 0 played, and from
// then on frame n plays at native frame F + n exactly (§7.2), through any
// underrun, so frameAt and timeAt are one subtraction each. Until F arrives
// (a few milliseconds after start, or after the context first runs) they
// assume engine frame 0 plays at the next native quantum, which is right to
// within the time the first block takes to render.

import {
  QUANTUM, CHUNK, EGRESS_CHANNELS, PLAYED, UNDERRUNS, headOf, renderOf,
  makeRing, makeControl, transfer
} from './ring.js';
import { ROLE, defaultWorkers, planStages, Placement, spawnWorkers } from './pool.js';
import { createUploader } from './buffers.js';

const DRAIN_URL = new URL('./drain-worklet.js', import.meta.url).href;
const WORKER_URL = new URL('./render-worker.js', import.meta.url);
const WASM_URL = new URL('./heart.wasm', import.meta.url).href;

// The smallest module that uses a v128 instruction: a function returning
// i8x16.popcnt(i8x16.splat(0)). A browser without wasm SIMD fails to
// validate it, and heart.wasm, built with simd128, would fail to compile.
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,   // magic, version
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,         // type: () -> v128
  0x03, 0x02, 0x01, 0x00,                           // func 0 has type 0
  0x0a, 0x0a, 0x01, 0x08, 0x00,                     // code: one body, no locals
  0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b          // i32.const 0, i8x16.splat, i8x16.popcnt, end
]);

// Lookahead by default: SharedArrayBuffer wakes a worker the moment it can
// render; messages queue behind whatever else the threads are doing, so
// they get twice the margin.
const LOOKAHEAD_SAB = 0.045, LOOKAHEAD_MESSAGE = 0.09;
// An island's egress ring in message mode, in chunks (render-worker.js says
// why islands key on ring room there).
const ISLAND_CHUNKS = 3;
const START_TIMEOUT_MS = 10000;
const STATS_MS = 250;

// The mapping between native context time and engine frames.
export function timeMap(sampleRate, now) {
  let F = null;
  const start = () => F ?? Math.ceil(now() * sampleRate / QUANTUM) * QUANTUM;
  return {
    set(frame) { F = frame; },
    get known() { return F !== null; },
    frameAt: t => t * sampleRate - start(),
    timeAt: frame => (frame + start()) / sampleRate
  };
}

export async function startEngine(nativeCtx, opts = {}) {
  if (!WebAssembly.validate(SIMD_PROBE)) return stayNative('this browser has no wasm SIMD');
  let module;
  try { module = await compileHeart(opts.wasmUrl || WASM_URL); }
  catch (err) { return stayNative('heart.wasm did not compile', err); }
  try { await nativeCtx.audioWorklet.addModule(DRAIN_URL); }
  catch (err) { return stayNative('the drain worklet did not load', err); }
  const engine = { close() {} };
  try {
    await assemble(engine, nativeCtx, module, opts);
    return engine;
  } catch (err) {
    engine.close();
    return stayNative('a render stage did not start', err);
  }
}

function stayNative(why, err) {
  console.warn(`heart: staying on the native engine, ${why}`, err || '');
  return null;
}

// Streaming compiles as it downloads, but only when the server sends the
// wasm MIME type; anything else falls back to compiling the whole file.
async function compileHeart(url) {
  if (WebAssembly.compileStreaming) {
    try { return await WebAssembly.compileStreaming(fetch(url)); } catch (err) { /* fall through */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return WebAssembly.compile(await res.arrayBuffer());
}

// Builds every part, fills in `engine` (so a failure part way can still
// close what was made) and resolves once every stage has said it is ready.
async function assemble(engine, ctx, module, opts) {
  const shared = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  const sampleRate = ctx.sampleRate;
  const lookahead = Math.ceil((opts.lookahead ?? (shared ? LOOKAHEAD_SAB : LOOKAHEAD_MESSAGE)) * sampleRate / QUANTUM) * QUANTUM;
  const stages = planStages(opts.workers ?? defaultWorkers(globalThis.navigator?.hardwareConcurrency));
  const placement = new Placement(stages);
  const control = shared ? makeControl(stages.length) : null;
  const seed = (opts.seed ?? Math.random() * 2 ** 32) >>> 0;
  const time = timeMap(sampleRate, () => ctx.currentTime);
  const listeners = new Map();
  const emit = (type, ...args) => { for (const fn of listeners.get(type) || []) fn(...args); };
  let closed = false, ticker = null, lastUnderruns = 0;

  // What message mode learns by post rather than reading shared memory.
  const heads = new Float64Array(stages.length);
  const renderMs = new Float64Array(stages.length);
  const drainNews = { underruns: 0 };

  // The final ring holds the lookahead and the chunk being written. An
  // egress ring in SAB mode holds the island's lead (a chunk past the
  // lookahead) and a chunk more, so ring room never binds before the clock.
  const finalRing = makeRing(shared, 2, lookahead + CHUNK);
  const egress = stages.map(s => s.role !== ROLE.island ? null
    : makeRing(shared, EGRESS_CHANNELS, shared ? lookahead + 2 * CHUNK : ISLAND_CHUNKS * CHUNK));

  const workers = [];
  const output = new AudioWorkletNode(ctx, 'heart-drain', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { stages: stages.length, control, ring: shared ? finalRing.reader : null }
  });
  if (!shared) output.port.postMessage({ type: 'ring', ring: finalRing.reader }, transfer(finalRing.reader));
  output.port.onmessage = e => {
    const d = e.data;
    if (d.type === 'start') time.set(d.F);
    else if (d.type === 'stats') drainNews.underruns = d.underruns;
  };
  output.onprocessorerror = () => { console.warn('heart: the drain stopped'); emit('error', -1, 'drain'); };

  // ---------- commands ----------
  // Batches for a stage are gathered over the current task and posted once,
  // as one buffer of our own, transferred, so the caller keeps its bytes.
  const queued = stages.map(() => []);
  let flushing = false;
  function send(stageId, bytes) {
    if (closed) return;
    if (!queued[stageId]) throw new RangeError(`heart: no stage ${stageId}`);
    queued[stageId].push(bytes);
    if (!flushing) { flushing = true; queueMicrotask(flush); }
  }
  function flush() {
    flushing = false;
    if (closed) return;
    for (let s = 0; s < queued.length; s++) {
      const q = queued[s];
      if (!q.length) continue;
      let total = 0;
      for (const b of q) total += b.byteLength;
      const batch = new Uint8Array(total);
      let at = 0;
      for (const b of q) { batch.set(b, at); at += b.byteLength; }
      q.length = 0;
      workers[s].postMessage({ type: 'commands', bytes: batch }, [batch.buffer]);
    }
  }

  // A free goes out behind every command already sent, so a node switched
  // away from the buffer in the same task lets go of it first (buffers.js).
  const uploader = createUploader({
    shared,
    stages: stages.length,
    post(s, msg, xfer) {
      if (msg.type === 'free') flush();
      workers[s].postMessage(msg, xfer);
    }
  });

  // ---------- reading the engine ----------
  const headFrame = s => control ? Atomics.load(control, headOf(s)) * QUANTUM : heads[s];
  const renderedUntil = (stageId = 0) => time.timeAt(headFrame(stageId));

  // The engine frame that no stage will have rendered past by the time a
  // batch sent now is applied. A stage renders no further than the drain's
  // clock plus the lookahead, and an island a little further: a chunk with
  // the shared clock, or as many chunks as its egress ring holds without it.
  // A chunk more covers the batch's trip to the worker. Anything anchored
  // here or later lands on the same frame on every stage, which is what
  // keeps replicas of one node in step (nodes.js, the strobe signal).
  const lead = stages.length === 1 ? 0 : shared ? CHUNK : ISLAND_CHUNKS * CHUNK;
  function horizon() {
    const played = control ? Atomics.load(control, PLAYED) * QUANTUM : Math.max(0, time.frameAt(ctx.currentTime));
    let h = played + lookahead + lead;
    for (const st of stages) h = Math.max(h, headFrame(st.id));
    return h + CHUNK;
  }

  // Each stage's own counters (lib.rs heart_stats) and memory, asked for and
  // answered over its port: for tests and for a look under the hood.
  const asked = new Map();
  let nextAsk = 1;
  function inspect() {
    const ask = nextAsk++;
    return new Promise(resolve => {
      const answers = [];
      asked.set(ask, a => {
        answers[a.stage] = a;
        if (answers.filter(Boolean).length === stages.length) { asked.delete(ask); resolve(answers); }
      });
      for (const w of workers) w.postMessage({ type: 'inspect', ask });
    });
  }
  function stats() {
    return {
      underruns: control ? Atomics.load(control, UNDERRUNS) : drainNews.underruns,
      fill: Math.max(0, renderedUntil() - ctx.currentTime),
      renderMs: stages.map(s => control ? Atomics.load(control, renderOf(s.id)) / 1000 : renderMs[s.id])
    };
  }
  // 'stats' and 'underrun' are told from one timer, run only while someone
  // listens.
  function tick() {
    const s = stats();
    if (s.underruns > lastUnderruns) { lastUnderruns = s.underruns; emit('underrun', s.underruns); }
    emit('stats', s);
  }
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    if ((type === 'stats' || type === 'underrun') && !ticker && !closed) ticker = setInterval(tick, STATS_MS);
    return () => listeners.get(type)?.delete(fn);
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    for (const w of workers) w.terminate();
    uploader.close();
    output.port.postMessage({ type: 'close' });
    output.disconnect();
    output.port.onmessage = null;
    listeners.clear();
  }

  Object.assign(engine, {
    mode: shared ? 'sab' : 'message',
    sampleRate,
    // The compiled heart.wasm, so the page's shadow instance (route.js)
    // need not fetch and compile it a second time.
    module,
    output,
    stages,
    frameAt: time.frameAt,
    timeAt: time.timeAt,
    renderedUntil,
    horizon,
    stageFor: island => placement.stageFor(island),
    weigh: (island, w) => placement.weigh(island, w),
    send,
    ensureBuffer: (id, stageId, audioBuffer) => uploader.ensure(id, stageId, audioBuffer),
    freeBuffer: (id, stageIds) => uploader.free(id, stageIds),
    on,
    stats,
    inspect,
    close
  });

  // ---------- the stages ----------
  workers.push(...spawnWorkers(stages, WORKER_URL));
  let waiting = stages.length;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), START_TIMEOUT_MS);
    const failed = (stage, message) => {
      if (waiting > 0) { clearTimeout(timer); reject(new Error(`stage ${stage}: ${message}`)); return; }
      console.warn(`heart: stage ${stage} stopped`, message);
      emit('error', stage, message);
    };
    stages.forEach((s, i) => {
      const w = workers[i];
      w.onmessage = e => {
        const d = e.data;
        if (d.type === 'events') emit('events', d.stage, d.bytes);
        else if (d.type === 'head') { heads[d.stage] = d.frame; renderMs[d.stage] = d.renderMs; }
        else if (d.type === 'inspect') asked.get(d.ask)?.(d);
        else if (d.type === 'ready') { if (--waiting === 0) { clearTimeout(timer); resolve(); } }
        else if (d.type === 'error') failed(d.stage, d.message);
      };
      w.onerror = e => { e.preventDefault(); failed(s.id, e.message || 'worker error'); };
      const out = s.id === 0 ? finalRing.writer : egress[s.id].writer;
      const ins = s.role !== ROLE.mix ? []
        : stages.filter(t => t.role === ROLE.island).map(t => ({ stage: t.id, ring: egress[t.id].reader }));
      w.postMessage({
        type: 'init', module, stage: s.id, role: s.role, seed: (seed + s.id) >>> 0,
        sampleRate, chunk: CHUNK, lookahead, control, out, ins
      }, [...transfer(out), ...ins.flatMap(i => transfer(i.ring))]);
    });
  });
}
