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
// The lookahead adapts (§7.3, adaptive lookahead). The drain grows it when
// it underruns and the page goes hidden, and eases it back after a steady
// stretch; the stages obey it chunk by chunk; this file picks the base for
// the device, tells the drain when the page hides, reads the result for the
// horizon, and says in the console what happened and why: a stall, which
// the cushion cures, or an overload, which it cannot.
//
// The engine's time is frames from the moment the drain first plays. The
// drain posts the native frame F at which engine frame 0 played, and from
// then on frame n plays at native frame F + n exactly (§7.2), through any
// underrun, so frameAt and timeAt are one subtraction each. Until F arrives
// (a few milliseconds after start, or after the context first runs) they
// assume engine frame 0 plays at the next native quantum, which is right to
// within the time the first block takes to render.

import {
  QUANTUM, CHUNK, EGRESS_CHANNELS, PLAYED, UNDERRUNS, LOOKAHEAD_NEXT, headOf, renderOf,
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

// The base lookahead, in seconds, where it starts and the least it eases
// back to. SharedArrayBuffer wakes a worker the moment it can render;
// messages queue behind whatever else the threads are doing, so they get
// twice the margin. A phone or tablet starts with a cushion: slower cores,
// a page thread busy with the visuals, and an OS quick to park a thread.
const LOOKAHEAD_SAB = 0.045, LOOKAHEAD_MESSAGE = 0.09;
const HANDHELD_SAB = 0.12, HANDHELD_MESSAGE = 0.18;
// The most it grows to. Scheduled music is booked at most 0.6 s ahead
// (the sequencer, §7.2), and the horizon is the lookahead plus a chunk or
// four; past 0.5 s those notes would land behind it and be heard late.
// Memory does not bind: only the final ring holds it, two channels, about
// 200 KB at 48 kHz.
const LOOKAHEAD_MAX = 0.5;
// Where it rises to the moment the page is hidden: nothing is interactive
// then, and that is when the OS slows our workers.
const LOOKAHEAD_HIDDEN = 0.3;
// How long it must stay visible and free of underruns before each halving.
const STEADY_SECONDS = 30;
// An island's egress ring in message mode, in chunks (render-worker.js says
// why islands key on ring room there).
const ISLAND_CHUNKS = 3;
const START_TIMEOUT_MS = 10000;
const STATS_MS = 250;
// A stage overloaded this many stats ticks running (a second) is told of,
// and not again for OVERLOAD_QUIET_MS.
const OVERLOAD_TICKS = 4, OVERLOAD_QUIET_MS = 30000;

// A phone or tablet. The primary pointer being coarse is the signal: it is
// true of every phone and tablet, iPads included (whose Safari calls itself
// a Mac), and false of a laptop with a touchscreen, whose primary pointer
// is still its trackpad. The user agent backs it up where matchMedia is
// missing. The core count is no help: browsers round or cap it for privacy,
// and plenty of desktops have few.
export function handheld(g = globalThis) {
  try { if (g.matchMedia?.('(pointer: coarse)').matches) return true; } catch (err) { /* no media queries */ }
  return /iPhone|iPad|iPod|Android/i.test(g.navigator?.userAgent || '');
}

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
  const toFrames = seconds => Math.ceil(seconds * sampleRate / QUANTUM) * QUANTUM;
  const small = opts.handheld ?? handheld();
  const lookahead = toFrames(opts.lookahead ?? (shared ? (small ? HANDHELD_SAB : LOOKAHEAD_SAB) : (small ? HANDHELD_MESSAGE : LOOKAHEAD_MESSAGE)));
  const maxAhead = Math.max(lookahead, toFrames(opts.maxLookahead ?? LOOKAHEAD_MAX));
  const policy = {
    base: lookahead,
    max: maxAhead,
    hidden: Math.min(maxAhead, Math.max(lookahead, toFrames(opts.hiddenLookahead ?? LOOKAHEAD_HIDDEN))),
    steady: Math.ceil((opts.steadySeconds ?? STEADY_SECONDS) * sampleRate / QUANTUM),
    startHidden: globalThis.document?.visibilityState === 'hidden'
  };
  const stages = planStages(opts.workers ?? defaultWorkers(globalThis.navigator?.hardwareConcurrency));
  const placement = new Placement(stages);
  const control = shared ? makeControl(stages.length, lookahead) : null;
  const seed = (opts.seed ?? Math.random() * 2 ** 32) >>> 0;
  const time = timeMap(sampleRate, () => ctx.currentTime);
  const listeners = new Map();
  const emit = (type, ...args) => { for (const fn of listeners.get(type) || []) fn(...args); };
  let closed = false, ticker = null, lastUnderruns = 0;

  // What message mode learns by post rather than reading shared memory.
  const heads = new Float64Array(stages.length);
  const renderMs = new Float64Array(stages.length);
  const drainNews = { underruns: 0, next: lookahead };

  // The final ring holds the most lookahead and the chunk being written, so
  // its room never binds before the clock however far the lookahead grows.
  // A SharedArrayBuffer cannot grow, so it is that size from the start, and
  // a message ring may make that many chunks (it makes them only as they
  // are first needed). An egress ring in SAB mode holds what it held before
  // the lookahead adapted: the desktop base, the island's chunk of lead and
  // a chunk more. At thirty-two channels, sizing it for the most would cost
  // 3.2 MB an island at 48 kHz, 12.8 MB for four; this way it is 410 KB an
  // island. Past the base an island is held by ring room a little ahead of
  // the mix, which loses nothing: the cushion that covers a stall is the
  // final ring's, whichever stage stalls.
  const finalRing = makeRing(shared, 2, maxAhead + CHUNK);
  const egress = stages.map(s => s.role !== ROLE.island ? null
    : makeRing(shared, EGRESS_CHANNELS, shared ? toFrames(LOOKAHEAD_SAB) + 2 * CHUNK : ISLAND_CHUNKS * CHUNK));

  const workers = [];
  const output = new AudioWorkletNode(ctx, 'heart-drain', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { stages: stages.length, control, ring: shared ? finalRing.reader : null, lookahead: policy }
  });
  if (!shared) output.port.postMessage({ type: 'ring', ring: finalRing.reader }, transfer(finalRing.reader));
  output.port.onmessage = e => {
    const d = e.data;
    if (d.type === 'start') time.set(d.F);
    else if (d.type === 'stats') drainNews.underruns = Math.max(drainNews.underruns, d.underruns);
    else if (d.type === 'lookahead') { drainNews.next = d.next; drainNews.underruns = Math.max(drainNews.underruns, d.underruns); }
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
  //
  // The lookahead read here is where it is going (LOOKAHEAD_NEXT), which a
  // rise reaches a chunk before the stages obey it, so a growth cannot carry
  // a stage past a horizon already handed out; after a shrink the stages'
  // own heads keep the horizon beyond what they rendered under the old one.
  const lead = stages.length === 1 ? 0 : shared ? CHUNK : ISLAND_CHUNKS * CHUNK;
  const aheadFrames = () => control ? Atomics.load(control, LOOKAHEAD_NEXT) : drainNews.next;
  function horizon() {
    const played = control ? Atomics.load(control, PLAYED) * QUANTUM : Math.max(0, time.frameAt(ctx.currentTime));
    let h = played + aheadFrames() + lead;
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
  // A chunk's real-time duration: a stage that takes this long to render
  // one cannot keep up, however much it renders ahead.
  const budgetMs = 1000 * CHUNK / sampleRate;
  const lookaheadNow = () => aheadFrames() / sampleRate;
  function stats() {
    const ms = stages.map(s => control ? Atomics.load(control, renderOf(s.id)) / 1000 : renderMs[s.id]);
    return {
      underruns: control ? Atomics.load(control, UNDERRUNS) : drainNews.underruns,
      fill: Math.max(0, renderedUntil() - ctx.currentTime),
      renderMs: ms,
      lookahead: lookaheadNow(),
      overloaded: ms.some(m => m >= budgetMs)
    };
  }

  // ---------- watching ----------
  // One timer, four times a second, for the life of the engine: it tells
  // 'stats' and 'underrun' to whoever listens, and says in the console when
  // the lookahead moved and when a stage cannot keep up.
  const stageName = s => s.role === ROLE.island ? `island ${s.id}` : s.role === ROLE.mix ? 'mix' : 'combined';
  const ms1 = v => v.toFixed(1);
  let saidAhead = lookahead, seenUnderruns = 0, overTicks = stages.map(() => 0), saidOverload = -Infinity;
  function watch(s) {
    const ahead = aheadFrames();
    // A rise is put down to underruns if there were new ones since the last
    // tick (the drain grows the moment it underruns), else to hiding.
    const fresh = s.underruns > seenUnderruns;
    seenUnderruns = s.underruns;
    if (ahead !== saidAhead) {
      const was = Math.round(1000 * saidAhead / sampleRate), now = Math.round(1000 * ahead / sampleRate);
      if (ahead > saidAhead) {
        const why = fresh ? `after ${s.underruns} underrun quanta` : hidden ? 'as the page hides' : 'raised';
        const over = stages.filter(st => s.renderMs[st.id] >= budgetMs).map(stageName);
        const kind = over.length ? `overload: ${over.join(', ')} cannot keep up, so more cushion will not help`
          : 'a stall: every stage renders well inside its budget, so the cushion covers it';
        const load = stages.map(st => `${stageName(st)} ${ms1(s.renderMs[st.id])}`).join(' · ');
        console.info(`[heart] lookahead ${was} → ${now} ms ${why}; ${kind}. ms a chunk (budget ${ms1(budgetMs)}): ${load}`);
      } else {
        console.info(`[heart] lookahead ${was} → ${now} ms, steady for ${opts.steadySeconds ?? STEADY_SECONDS} s`);
      }
      saidAhead = ahead;
    }
    // A stage whose smoothed render time stays at or over the budget for a
    // second is overloaded, not stalled: told once, then quiet a while.
    const over = [];
    stages.forEach(st => {
      overTicks[st.id] = s.renderMs[st.id] >= budgetMs ? overTicks[st.id] + 1 : 0;
      if (overTicks[st.id] >= OVERLOAD_TICKS) over.push(`${stageName(st)} at ${ms1(s.renderMs[st.id])} ms`);
    });
    const t = performance.now();
    if (over.length && t - saidOverload >= OVERLOAD_QUIET_MS) {
      saidOverload = t;
      console.warn(`[heart] overload: ${over.join(', ')} a chunk, over the ${ms1(budgetMs)} ms a chunk lasts; more lookahead cannot fix this, less work can`);
    }
  }
  function tick() {
    const s = stats();
    watch(s);
    if (s.underruns > lastUnderruns) { lastUnderruns = s.underruns; emit('underrun', s.underruns); }
    emit('stats', s);
  }
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }

  // The drain owns the lookahead; the page only tells it when it hides. In
  // message mode the horizon rises at once rather than waiting for the
  // drain's answer, as a batch sent meanwhile must allow for it.
  const doc = globalThis.document;
  let hidden = policy.startHidden;
  function onVisibility() {
    const now = doc.visibilityState === 'hidden';
    if (now === hidden || closed) return;
    hidden = now;
    if (hidden && !control) drainNews.next = Math.max(drainNews.next, policy.hidden);
    output.port.postMessage({ type: 'hidden', hidden });
  }
  doc?.addEventListener?.('visibilitychange', onVisibility);

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    doc?.removeEventListener?.('visibilitychange', onVisibility);
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
    // The lookahead now, in seconds: where the drain has set it going.
    lookahead: lookaheadNow,
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
  if (!closed) ticker = setInterval(tick, STATS_MS);
}
