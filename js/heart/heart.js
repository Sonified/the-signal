// HeartContext: the AudioContext the app's music code builds on when a
// family plays through Heart.
//
// It is a twin, not a wrapper. A module asks route.js for its context and
// gets either the native one or this, and from then on makes the same calls
// either way: createGain, connect, setTargetAtTime, start, stop. The node
// proxies (nodes.js) and params (params.js) turn those calls into commands
// for Heart's stages; this file holds the context itself, the shadow that
// answers param reads on the main thread, and OfflineHeartContext, which
// renders a graph on the page with no workers at all, for the null tests.
//
// The clock stays native. currentTime, state, resume and suspend are the
// native context's own, so every time the app computes from currentTime is
// a time on the clock the speakers play by, and Engine.frameAt maps it onto
// Heart's frames (spec 7.2). AudioBuffers stay native objects too: decoding
// and createBuffer forward to the native context, and a buffer is uploaded
// to Heart the first time a node is handed it.
import { Commands } from './protocol-gen.js';
import {
  HeartGraph, HeartGain, HeartConstantSource, HeartStereoPanner, HeartDelay, HeartBiquad,
  HeartOscillator, HeartBufferSource, HeartAnalyser, HeartConvolver, HeartProcessor, HeartMaster
} from './nodes.js';

const WASM_URL = new URL('./heart.wasm', import.meta.url).href;
// heart_init's roles (spec 5).
const ROLE = { combined: 0, island: 1, mix: 2, shadow: 3 };
// heart_port_ptr's kinds.
const PORT_MASTER = 2;
const QUANTUM = 128;
// The offline context renders this many frames per call into the engine.
const OFFLINE_CHUNK = QUANTUM * 64;

// ---------- the wasm ----------
// Each source is compiled once and the module kept, since a page makes a
// shadow and every offline context makes two instances of its own. A
// source is a URL, the wasm's bytes, or an already compiled module.
const modules = new Map();
export function heartModule(source = WASM_URL) {
  if (source instanceof WebAssembly.Module) return Promise.resolve(source);
  let m = modules.get(source);
  if (!m) {
    m = typeof source === 'string' || source instanceof URL
      ? fetch(source).then(res => {
          if (!res.ok) throw new Error(`Heart: ${source} answered ${res.status}`);
          return res.arrayBuffer();
        }).then(bytes => WebAssembly.compile(bytes))
      : WebAssembly.compile(source);
    m.catch(() => modules.delete(source));
    modules.set(source, m);
  }
  return m;
}

// One instance of heart.wasm on this thread, through its raw exports (spec
// 5). Memory can grow during any call, so every view of it is taken afresh
// and never kept across one.
class WasmStage {
  static async create(source, sampleRate, role, seed) {
    const instance = await WebAssembly.instantiate(await heartModule(source), {});
    return new WasmStage(instance.exports, sampleRate, role, seed);
  }
  constructor(x, sampleRate, role, seed) {
    this._x = x;
    if (x.heart_init(sampleRate, role, seed >>> 0) !== 1) {
      throw new Error(`Heart: heart_init refused role ${role} at ${sampleRate} Hz`);
    }
    // where heart_events writes the address of its bytes
    this._slot = x.heart_alloc(4);
  }
  get _memory() { return this._x.memory.buffer; }

  apply(bytes) {
    const n = bytes.length, x = this._x;
    if (!n) return;
    const p = x.heart_alloc(n);
    new Uint8Array(this._memory, p, n).set(bytes);
    x.heart_commands(p, n);
    x.heart_free(p, n);
  }
  upload(id, buf) {
    const channels = buf.numberOfChannels, n = buf.length;
    const p = this._x.heart_buffer_alloc(id, channels, n, buf.sampleRate);
    for (let c = 0; c < channels; c++) new Float32Array(this._memory, p + c * n * 4, n).set(buf.getChannelData(c));
  }
  free(id) { this._x.heart_buffer_free(id); }
  frame() { return this._x.heart_frame(); }
  now(frame) { this._x.heart_now(frame); }
  render(frames) { return this._x.heart_render(frames); }
  // The master port after a render: planar, left then right.
  master(frames) {
    const p = this._x.heart_port_ptr(PORT_MASTER, 0), m = this._memory;
    return [new Float32Array(m, p, frames), new Float32Array(m, p + frames * 4, frames)];
  }
  // The events since the last call, copied out, or null for none.
  events() {
    const n = this._x.heart_events(this._slot);
    if (!n) return null;
    const m = this._memory, at = new DataView(m).getUint32(this._slot, true);
    return new Uint8Array(m, at, n).slice();
  }
  paramValue(node, param, frame) { return this._x.heart_param_value(node, param, frame); }
  // heart_stats' eight counters, by name (heart/src/lib.rs).
  stats() {
    const at = this._x.heart_stats(), u32 = new Uint32Array(this._memory, at, 8);
    return {
      nodes: u32[0], renders: u32[1], skips: u32[2], cut: u32[3],
      rejected: u32[4], firstCut: u32[5], dropped: u32[6], rebuilds: u32[7]
    };
  }
}

// ---------- the shadow ----------
// A main-thread instance of heart.wasm in the shadow role, holding every
// node's param timelines and no audio. It hears every create, destroy and
// param command the stages hear, so `HeartParam.value` is the engine's own
// answer, worked out by the same Rust (principle 2), never a second
// version of the timeline in JS. Commands collect here and are applied at
// the end of the task, or at once when a value is read, so a read always
// sees every call made before it.
//
// Before each batch the shadow is told the present its calls landed on
// (follow; HeartGraph.present, the render horizon), so an automation call is
// anchored where it was placed: a ramp with nothing before it starts there,
// from the value the param holds, as Chrome starts it (heart/src/shadow.rs).
// The present is taken with the batch's first call, in the task that made
// it, so it is the one that task's calls were moved by.
export class Shadow {
  static async create(sampleRate, source) {
    const shadow = new Shadow();
    shadow.attach(await WasmStage.create(source, sampleRate, ROLE.shadow, 0));
    return shadow;
  }
  constructor() {
    this._stage = null;
    this._cmds = new Commands();
    this._queued = false;
    this._present = null;
    this._at = null;
  }
  // present() is the frame calls made now land on (HeartGraph hands it over).
  follow(present) { this._present = present; }
  attach(stage) {
    this._stage = stage;
    this._flush();
  }
  write(fn) {
    if (!this._queued) {
      this._queued = true;
      this._at = this._present && this._present();
      queueMicrotask(() => this._flush());
    }
    fn(this._cmds);
  }
  value(node, param, frame) {
    if (!this._stage) throw new Error('Heart: param values can be read once the context is ready (await ctx.ready)');
    this._flush();
    return this._stage.paramValue(node, param, frame);
  }
  _flush() {
    this._queued = false;
    if (!this._stage) return;
    const bytes = this._cmds.bytes();
    if (!bytes.length) return;
    if (this._at !== null) this._stage.now(this._at);
    this._stage.apply(bytes);
    this._cmds.reset();
  }
}

// ---------- contexts ----------
// One graph per engine, shared by every context on it, and each engine's
// contexts by island name, so island(name) always answers with the same one.
const graphs = new WeakMap();
const islands = new WeakMap();

export class HeartContext {
  // island: the name of the island this context's nodes live in ('music',
  // 'clouds', ...), or 'mix' for the shared buses and the master.
  constructor(engine, nativeCtx, shadow, island = 'mix') {
    let graph = graphs.get(engine);
    if (!graph) graphs.set(engine, graph = new HeartGraph(engine, nativeCtx, shadow));
    let named = islands.get(graph);
    if (!named) islands.set(graph, named = new Map());
    if (!named.has(island)) named.set(island, this);
    this._graph = graph;
    // The native context, whose clock and buffers this one uses. An offline
    // context hands in a stand-in of its own (OfflineClock, below).
    this._native = nativeCtx;
    this._islandName = island;
    this._islandId = graph.islandId(island);
    this._stage = island === 'mix' ? graph.mixStage : engine.stageFor(island);
  }

  get isHeart() { return true; }

  // The context for island `name` on the same engine, made on first ask.
  island(name) {
    const g = this._graph;
    return islands.get(g).get(name) || new HeartContext(g.engine, this._native, g.shadow, name);
  }
  // The context for the shared buses, which live in the mix.
  get mix() { return this.island('mix'); }

  // Heart's master bus, one per engine, in the mix.
  get destination() {
    const g = this._graph;
    return g.master || (g.master = new HeartMaster(this.mix));
  }

  // ---- the native clock ----
  get currentTime() { return this._native.currentTime; }
  // The context time a call made now lands at: currentTime, or Heart's
  // render horizon when that is further on (nodes.js, late gestures). Code
  // that waits on the clock for a gesture to finish reads its end from
  // here, since a gesture anchored at currentTime is heard this much later.
  get presentTime() {
    const g = this._graph;
    return g.engine.timeAt(g.present());
  }
  get sampleRate() { return this._native.sampleRate; }
  get state() { return this._native.state; }
  get audioWorklet() { return this._native.audioWorklet; }
  resume() { return this._native.resume(); }
  suspend() { return this._native.suspend(); }
  // statechange is the native context's; listeners go straight to it.
  addEventListener(...args) { return this._native.addEventListener(...args); }
  removeEventListener(...args) { return this._native.removeEventListener(...args); }

  // ---- buffers stay native ----
  decodeAudioData(...args) { return this._native.decodeAudioData(...args); }
  createBuffer(channels, length, sampleRate) { return this._native.createBuffer(channels, length, sampleRate); }

  // ---- nodes ----
  createGain() { return new HeartGain(this); }
  createConstantSource() { return new HeartConstantSource(this); }
  createStereoPanner() { return new HeartStereoPanner(this); }
  createDelay(maxDelayTime = 1) { return new HeartDelay(this, maxDelayTime); }
  createBiquadFilter() { return new HeartBiquad(this); }
  createOscillator() { return new HeartOscillator(this); }
  createBufferSource() { return new HeartBufferSource(this); }
  createAnalyser() { return new HeartAnalyser(this); }
  createConvolver() { return new HeartConvolver(this); }
  // What `new AudioWorkletNode(ctx, name, opts)` makes natively, for the
  // processors Heart has in Rust: 'genus', 'one-pole', 'strobe-signal' and
  // 'fdn-reverb'. route.js makeWorklet picks between the two.
  createProcessor(name, opts) { return new HeartProcessor(this, name, opts); }
}

// ---------- offline ----------
// The clock and buffer maker an offline context plays the native part with.
// Time is the frames rendered so far.
class OfflineClock {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'suspended';
    this.audioWorklet = null;
  }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
  createBuffer(channels, length, sampleRate) {
    return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
  }
  // decoded at this context's rate, as a native context decodes
  decodeAudioData(data) {
    return new OfflineAudioContext(1, 1, this.sampleRate).decodeAudioData(data);
  }
}

// The Engine interface (spec 7.1) over one combined stage on this thread,
// with frame 0 at time 0. Until the wasm is ready, commands and uploads wait
// in order; after that each one applies as it is sent.
class OfflineEngine {
  constructor(sampleRate) {
    this.mode = 'offline';
    this.sampleRate = sampleRate;
    this.output = null;
    this.stages = [{ id: 0, role: 'combined', islands: [] }];
    this._stage = null;
    this._waiting = [];
    this._uploaded = new Set();
    this._listeners = [];
  }
  frameAt(t) { return t * this.sampleRate; }
  timeAt(frame) { return frame / this.sampleRate; }
  // Nothing renders ahead of the page here: the next frame is the horizon.
  horizon() { return this._stage ? this._stage.frame() : 0; }
  stageFor() { return 0; }
  send(stage, bytes) { this._do(s => s.apply(bytes)); }
  ensureBuffer(id, stage, buf) {
    if (this._uploaded.has(id)) return true;
    this._uploaded.add(id);
    this._do(s => s.upload(id, buf));
    return true;
  }
  freeBuffer(id) {
    if (this._uploaded.delete(id)) this._do(s => s.free(id));
  }
  on(type, fn) { if (type === 'events') this._listeners.push(fn); }
  // The one stage's counters, as Engine.inspect gives them.
  async inspect() { return [{ stage: 0, ...this._stage.stats() }]; }

  attach(stage) {
    this._stage = stage;
    for (const job of this._waiting) job(stage);
    this._waiting = null;
  }
  _do(job) {
    if (this._waiting) this._waiting.push(job); else job(this._stage);
  }
  render(frames) { this._stage.render(frames); }
  master(frames) { return this._stage.master(frames); }
  drainEvents() {
    const u8 = this._stage.events();
    if (u8) for (const fn of this._listeners) fn(0, u8);
  }
}

// OfflineAudioContext's twin: the same graph, rendered on this page by its
// own heart.wasm in the combined role, no workers and no drain. The null
// test bench (spec 9) runs one scenario on this and on a native
// OfflineAudioContext and subtracts.
//
//   const ctx = await OfflineHeartContext.create(2, 48000, 48000);
//   scenario(ctx);
//   const buffer = await ctx.startRendering();
//
// Nodes can be made as soon as the context is constructed, and their
// commands wait for the wasm; only reading a param's value has to wait for
// `ready`, which `create` awaits. Options as an object take `seed` (for the
// DSP's randomness, spec 6.4) and `wasm` (a URL, bytes or a compiled module).
export class OfflineHeartContext extends HeartContext {
  constructor(channels, length, sampleRate) {
    const o = typeof channels === 'object' && channels !== null
      ? channels : { numberOfChannels: channels, length, sampleRate };
    const ch = o.numberOfChannels ?? 1, len = o.length, sr = o.sampleRate;
    if (!(ch === 1 || ch === 2)) throw new DOMException(`Heart renders mono or stereo, not ${ch} channels`, 'NotSupportedError');
    if (!(Number.isInteger(len) && len > 0)) throw new DOMException(`length ${len} must be a positive integer`, 'NotSupportedError');
    if (!(sr >= 3000 && sr <= 768000)) throw new DOMException(`sampleRate ${sr} is out of range`, 'NotSupportedError');
    const clock = new OfflineClock(sr), engine = new OfflineEngine(sr), shadow = new Shadow();
    super(engine, clock, shadow, 'mix');
    this.length = len;
    this._channels = ch;
    this._clock = clock;
    this._engine = engine;
    this._rendered = false;
    this.ready = (async () => {
      const [combined, timelines] = await Promise.all([
        WasmStage.create(o.wasm, sr, ROLE.combined, o.seed ?? 1),
        WasmStage.create(o.wasm, sr, ROLE.shadow, 0)
      ]);
      engine.attach(combined);
      shadow.attach(timelines);
      return this;
    })();
  }

  static async create(...args) {
    return new OfflineHeartContext(...args).ready;
  }

  // The stage's own counters after a render (heart/src/lib.rs heart_stats),
  // as Engine.inspect gives them: a command the stage refused shows here as
  // `rejected`, which tells a fault of the wire from a fault of the sound.
  inspect() { return this._engine.inspect(); }

  // Renders all `length` frames, synchronously once the wasm is in, into a
  // native AudioBuffer. The master is stereo; a mono context takes the
  // spec's down-mix of it, (L + R) / 2. Events (ended, peaks, port
  // messages) are delivered between chunks, with currentTime at the end of
  // the chunk they came from.
  async startRendering() {
    await this.ready;
    if (this._rendered) throw new DOMException('this context has already rendered', 'InvalidStateError');
    this._rendered = true;
    const len = this.length, sr = this.sampleRate, clock = this._clock, engine = this._engine;
    const out = new AudioBuffer({ numberOfChannels: this._channels, length: len, sampleRate: sr });
    const outL = out.getChannelData(0), outR = this._channels === 2 ? out.getChannelData(1) : null;
    clock.state = 'running';
    for (let done = 0; done < len;) {
      const n = Math.min(OFFLINE_CHUNK, Math.ceil((len - done) / QUANTUM) * QUANTUM);
      const k = Math.min(n, len - done);
      engine.render(n);
      const [l, r] = engine.master(n);
      if (outR) {
        outL.set(l.subarray(0, k), done);
        outR.set(r.subarray(0, k), done);
      } else {
        for (let i = 0; i < k; i++) outL[done + i] = 0.5 * (l[i] + r[i]);
      }
      done += k;
      clock.currentTime = done / sr;
      engine.drainEvents();
    }
    clock.state = 'closed';
    return out;
  }
}
