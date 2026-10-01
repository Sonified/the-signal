// Heart's node proxies: the AudioNodes the app holds when it builds a graph
// on a HeartContext (js/heart/heart.js).
//
// A proxy holds no audio. It is a handle with the Web Audio surface the app
// already uses (connect, disconnect, params, start, stop, onended, a port)
// that turns every call into command records for the stage that owns the
// real node, and keeps just enough bookkeeping to make disconnect exact. The
// sound itself is made in Rust, in a worker, one lookahead ahead of the
// speakers.
//
// Three things here are Heart's own rather than Web Audio's, and each one
// has its section below: the graph every proxy of one engine shares
// (HeartGraph), edges that cross from an island's stage into the mix (cross
// edges), and nodes that exist once per stage that uses them (replicas).
import { Commands, forEachEvent, KINDS, ATTRS, ENUMS, PARAMS, EVENT_OPS, MESSAGES } from './protocol-gen.js';
import { registerBuffer } from './buffers.js';
import { HeartParam, finite, notNegative } from './params.js';

// Each egress ring carries this many stereo ports (spec 7.3).
const PORTS_PER_STAGE = 16;
// How long an analyser waits for the answer to one peak request before it
// asks again. Meters read at frame rate, faster than a request can make the
// round trip through a worker, so one request at a time is enough.
const PEAK_WAIT_MS = 200;

// Inputs and outputs per kind, as the Web Audio spec (and, for the
// processors, the app's AudioWorkletNode options) give them.
const IO = {
  gain: [1, 1], constant_source: [0, 1], stereo_panner: [1, 1], delay: [1, 1],
  biquad: [1, 1], oscillator: [0, 1], buffer_source: [0, 1], analyser: [1, 1],
  convolver: [1, 1], fdn: [1, 1], one_pole: [1, 1], strobe_signal: [0, 1],
  genus: [0, 3], master: [1, 0]
};

// The spec's channel rules per kind, where they differ from two channels,
// 'max', 'speakers'. Heart's buses are at most stereo.
const MAX_CHANNELS = 2;
const CLAMPED = { stereo_panner: true, convolver: true };
const channelDefaults = kind => ({
  count: 2,
  mode: kind === 'master' ? 'explicit' : CLAMPED[kind] ? 'clamped-max' : 'max',
  interpretation: 'speakers'
});

// The processors the app registers with audioWorklet, by the names it
// makes them with, and the Heart kind each one is.
export const PROCESSOR_KINDS = {
  'genus': 'genus', 'one-pole': 'one_pole', 'strobe-signal': 'strobe_signal', 'fdn-reverb': 'fdn'
};

// A replicable kind has one real node in every stage that uses it (spec
// 7.4). The strobe signal is a pure function of its last message and the
// frame clock, so a copy made late, told the latest message, agrees with
// the first copy exactly. It has no params and no inputs, which is what
// lets that one message stand for its whole history.
const REPLICABLE = { strobe_signal: true };

const domError = (msg, name) => new DOMException(msg, name);
const isIndex = (v, n) => Number.isInteger(v) && v >= 0 && v < n;

// ---------- the graph ----------
// Everything the proxies of one engine share: the id counter, the island
// numbers, the ports cross edges travel through, the event routing, and the
// encoder every command is written with. heart.js makes one per engine and
// every HeartContext on that engine, island or mix, hands it to its nodes.
export class HeartGraph {
  // clock: what currentTime is read from (the native context, or an
  // offline context's own clock). shadow: the main-thread param timelines
  // (heart.js Shadow), with write(fn) and value(node, param, frame).
  constructor(engine, clock, shadow) {
    this.engine = engine;
    this.clock = clock;
    this.shadow = shadow;
    // Stage 0 is the mix, or the one combined stage (spec 7.1).
    this.mixStage = engine.stages[0].id;
    this._nextId = 1;
    this._islands = new Map([['mix', 0]]);
    this._ports = new Map();
    // Who hears events. A source that has started is held strongly until
    // it ends, as a playing AudioScheduledSourceNode is never collected, so
    // an onended set on a source the app then lets go of still fires.
    // Analysers and processors are held weakly: they hear only while the
    // app still holds them.
    this._playing = new Map();
    this._heard = new Map();
    this._scratch = new Commands();
    // A proxy the app has let go of can never be addressed again, so its
    // real nodes are told so. Heart then frees each one as Web Audio would
    // collect it: once nothing feeds it and its tail has rung out.
    this._gone = new FinalizationRegistry(core => this._release(core));
    engine.on('events', (stage, u8) => this._dispatch(stage, u8));
    // The task the calls being made now belong to (below).
    this._task = null;
    // The shadow anchors each call at the present it lands on (heart.js).
    shadow.follow(() => this.present());
  }

  newId() { return this._nextId++; }

  islandId(name) {
    let id = this._islands.get(name);
    if (id === undefined) this._islands.set(name, id = this._islands.size);
    return id;
  }

  // A native time as the engine frame it lands on, moved up to the present
  // the way the spec moves every scheduled time (params.js says why).
  frame(t) {
    return this.engine.frameAt(Math.max(t, this.clock.currentTime));
  }

  // ---------- late gestures ----------
  // A stage renders ahead of the clock, so a call anchored at currentTime
  // reaches it behind its head, where a stage can only move it up to the
  // head. The app's gestures are an anchor and a short ramp (glideParam,
  // the pause gate, a room's crossfade), and moving the anchor alone would
  // shorten each one by the stage's lead, or turn it into a step.
  //
  // So a late gesture is moved whole. The first call to a param, or to a
  // source's start and stop, that lands behind the render horizon sets that
  // owner's lateness Δ = horizon − time, and it and every later call to the
  // same owner in the same task are moved on by Δ: the gesture keeps its
  // shape exactly and is heard Δ late, about a lookahead. A call ahead of
  // the horizon (music planned ahead) is untouched unless an earlier call to
  // its owner in the same task was late. A new node's first value is not a
  // gesture and makes nothing late (initial, below). Attributes and
  // connections are not times and land at a stage's head, and processor
  // messages are never moved: their anchors are points on a formula (the
  // strobe's fold, below, is their own answer to the horizon).
  //
  // A task is the run of code up to the next microtask checkpoint, which is
  // also how far one command batch reaches. The horizon is read once per
  // task, so every gesture anchored at currentTime in one task (a room's two
  // sides, every source gate at a pause) is moved by the same Δ and they
  // stay together.
  task() {
    if (!this._task) {
      this._task = { present: NaN };
      queueMicrotask(() => { this._task = null; });
    }
    return this._task;
  }

  // The engine frame a call made now lands on: Engine.horizon (no stage will
  // have rendered past it when this task's batch arrives), or currentTime's
  // frame on an engine with nothing rendered ahead. Param values are read
  // here, as Chrome reads the value its renderer computed last, so an
  // anchor taken from `.value` is the value where its gesture lands.
  present() {
    const task = this.task();
    if (task.present !== task.present) {
      task.present = Math.max(this.engine.frameAt(this.clock.currentTime), this.engine.horizon());
    }
    return task.present;
  }

  // Frame f of a call to `owner` (a HeartParam, or a source for its start
  // and stop), moved on by the owner's lateness in this task, if it has
  // one, or if this call is the one that makes it late. A gesture's
  // lateness is how far its first point lies behind the present, and a
  // param's initial value in this task (initial, below) is the first point
  // of any late gesture that follows it, so the gesture is moved from there
  // and keeps the shape it was written with from that value on.
  shift(owner, f) {
    const task = this.task();
    if (owner._lateIn !== task) {
      const h = this.present();
      if (!(f < h)) return f;
      owner._lateIn = task;
      owner._lateBy = h - (owner._initIn === task ? Math.min(f, owner._initAt) : f);
    }
    return f + owner._lateBy;
  }

  // A param's initial value: the first call to a param of a node made in
  // this task, a setValueAtTime (the `.value` setter, most often) at frame
  // f behind the present. The node has played nothing yet, so the value
  // lands at the present without making the param late: the calls after it
  // that were booked ahead keep their true times. It is remembered, so a
  // late call after it in the same task is moved from it (shift, above).
  initial(owner, f) {
    owner._initIn = this.task();
    owner._initAt = f;
  }

  // Writes records with fn(commands) and queues them for one stage. The
  // engine batches per microtask; it is handed its own copy, since the
  // encoder here is reused for the next call.
  send(stage, fn) {
    const c = this._scratch;
    c.reset();
    fn(c);
    this.engine.send(stage, c.bytes().slice());
  }

  adopt(node) { this._gone.register(node, node._core); }
  hear(node) { this._heard.set(node._id, new WeakRef(node)); }
  play(node) { this._playing.set(node._id, node); }

  _release(core) {
    for (const real of core.reals.values()) {
      for (const e of real.edges) if (e.via) this.closePort(real.stage, e.via);
      this.send(real.stage, c => c.destroy(core.id));
    }
    this.shadow.write(c => c.destroy(core.id));
    this._heard.delete(core.id);
  }

  // The engine's raw event bytes, routed to the proxy each record names.
  _dispatch(stage, u8) {
    forEachEvent(u8, (op, id, dv, at) => {
      if (op === EVENT_OPS.stats) return;
      if (op === EVENT_OPS.log) { log(stage, id, dv.getUint32(at, true), dv.getUint32(at + 4, true)); return; }
      const node = this._playing.get(id) || this._heard.get(id)?.deref();
      if (!node) return;
      if (op === EVENT_OPS.ended) {
        this._playing.delete(id);
        node._ended();
      } else if (op === EVENT_OPS.peak) {
        node._peak(dv.getFloat32(at, true));
      } else if (op === EVENT_OPS.port) {
        node._portEvent(dv, at + 4, dv.getUint32(at, true));
      }
    });
  }

  // ---------- cross edges ----------
  // An island renders on its own stage and the mix on another, so an edge
  // from an island node into a mix node cannot be a plain connection. It
  // leaves the island through an Egress node on one of the stage's sixteen
  // stereo ports, and enters the mix through an Ingress node reading that
  // port, which connects to the target (spec 7.4).
  //
  // One port serves every edge from a stage into the same input of the same
  // mix node: the egress sums them, and a sum taken there is the sum the
  // target's input would have taken, so the island's whole output into the
  // master costs one port however many buses feed it. The port counts the
  // edges riding it and closes when the last one goes, so a disconnect
  // undoes exactly what its connect made and the port is free again.
  openPort(stage, to, input, island, describe) {
    let s = this._ports.get(stage);
    if (!s) {
      // popped from the end, so the lowest free port is taken first
      s = { free: Array.from({ length: PORTS_PER_STAGE }, (_, i) => PORTS_PER_STAGE - 1 - i), open: new Map() };
      this._ports.set(stage, s);
    }
    const key = to + ':' + input;
    let p = s.open.get(key);
    if (!p) {
      if (!s.free.length) {
        throw new Error(`Heart: ${describe()}: stage ${stage} has used all ${PORTS_PER_STAGE} of its ports into the mix`);
      }
      const port = s.free.pop();
      p = { key, port, egress: this.newId(), ingress: this.newId(), refs: 0 };
      s.open.set(key, p);
      this.send(stage, c => c.create(p.egress, KINDS.egress, island, [port]));
      this.send(this.mixStage, c => {
        c.create(p.ingress, KINDS.ingress, 0, [port, stage]);
        c.connect(p.ingress, 0, to, input);
      });
    }
    p.refs++;
    return p;
  }

  closePort(stage, p) {
    if (--p.refs > 0) return;
    const s = this._ports.get(stage);
    s.open.delete(p.key);
    s.free.push(p.port);
    this.send(stage, c => c.destroy(p.egress));
    this.send(this.mixStage, c => {
      c.disconnectAll(p.ingress);
      c.destroy(p.ingress);
    });
  }
}

// What a stage tells the page (protocol.json enums.log_code), said in the
// console, since each one is a mistake that would otherwise only be heard.
function log(stage, node, code, value) {
  if (code === ENUMS.log_code.cycle_cut) {
    if (value) {
      console.warn(`Heart: stage ${stage}: ${value} node${value === 1 ? '' : 's'} in a cycle with no DelayNode ` +
        `play silence (the first is node ${node}); the Web Audio spec allows a cycle only through a delay`);
    } else {
      console.warn(`Heart: stage ${stage}: the cycle through node ${node} is gone, and its nodes play again`);
    }
  } else {
    console.warn(`Heart: stage ${stage} logged code ${code} (${value}) for node ${node}`);
  }
}

// ---------- nodes ----------
// One real node in one stage, and the edges the app made from it there.
// An edge is { output, to, input, param, via }: from `output` to input
// `input` of node `to`, or to its param `param` when that is 0 or more.
// `via` is the port a cross edge rides (above), null otherwise. Edges hold
// ids, never proxies, so a target the app lets go of can still be collected.
const makeReal = stage => ({ stage, edges: [] });

export class HeartNode extends EventTarget {
  // ctx: the HeartContext making the node. kind: its protocol kind name.
  // opts: create's positional options (protocol.json kind_options).
  constructor(ctx, kind, opts = []) {
    super();
    const g = ctx._graph;
    this._ctx = ctx;
    this._graph = g;
    this._kind = kind;
    this._opts = opts;
    this._id = g.newId();
    // The task the node was made in, for its params' first values (params.js).
    this._born = g.task();
    this._island = ctx._islandId;
    this._stage = ctx._stage;
    this._cfg = channelDefaults(kind);
    this._cfgSent = false;
    // A replicable node has no real node until a stage uses it, and keeps
    // what it has been told, the latest message of each type, for a replica
    // made later to catch up on.
    this._replicable = !!REPLICABLE[kind];
    this._log = this._replicable ? new Map() : null;
    // What the finaliser needs, kept apart from the proxy so holding it
    // never keeps the proxy alive.
    this._core = { id: this._id, reals: new Map() };
    if (!this._replicable) this._real(this._stage);
    g.shadow.write(c => c.create(this._id, KINDS[kind], this._island, opts));
    this._params = (PARAMS[kind] || []).map((spec, i) => new HeartParam(this, i, spec));
    g.adopt(this);
  }

  get context() { return this._ctx; }
  get numberOfInputs() { return IO[this._kind][0]; }
  get numberOfOutputs() { return IO[this._kind][1]; }

  // ---- channels ----
  get channelCount() { return this._cfg.count; }
  set channelCount(n) {
    if (!(Number.isInteger(n) && n >= 1 && n <= MAX_CHANNELS)) {
      throw domError(`${this._describe()}: channelCount ${n} is not supported (Heart buses are mono or stereo)`,
        'NotSupportedError');
    }
    this._cfg.count = n;
    this._sendChannels();
  }
  get channelCountMode() { return this._cfg.mode; }
  set channelCountMode(mode) {
    // an enum attribute set to a value outside its enum is ignored (WebIDL)
    if (!Object.hasOwn(ENUMS.channel_count_mode, mode)) return;
    if (CLAMPED[this._kind] && mode === 'max') {
      throw domError(`${this._describe()}: channelCountMode cannot be 'max'`, 'NotSupportedError');
    }
    this._cfg.mode = mode;
    this._sendChannels();
  }
  get channelInterpretation() { return this._cfg.interpretation; }
  set channelInterpretation(v) {
    if (!Object.hasOwn(ENUMS.channel_interpretation, v)) return;
    this._cfg.interpretation = v;
    this._sendChannels();
  }
  _sendChannels() {
    this._cfgSent = true;
    this._sendAll((c, id) => this._writeChannels(c, id));
  }
  _writeChannels(c, id) {
    const { count, mode, interpretation } = this._cfg;
    c.channels(id, count, ENUMS.channel_count_mode[mode], ENUMS.channel_interpretation[interpretation]);
  }

  // ---- connect ----
  // Returns the target node, so connections chain, and nothing for a param,
  // exactly as AudioNode.connect does.
  connect(target, output = 0, input = 0) {
    this._checkOutput(output);
    if (target instanceof HeartParam) {
      const owner = target._node;
      this._checkGraph(owner);
      this._link(owner, output, 0, target._index, target);
      return undefined;
    }
    this._checkNode(target);
    this._checkGraph(target);
    if (!isIndex(input, target.numberOfInputs)) {
      throw domError(`${target._describe()} has no input ${input}`, 'IndexSizeError');
    }
    this._link(target, output, input, -1, null);
    return target;
  }

  _link(target, output, input, param, prm) {
    // A replicable node connects through its copy in the target's stage,
    // made on first use, so its edges never cross stages.
    const stage = this._replicable ? target._stage : this._stage;
    const real = this._real(stage);
    // Connecting the same pair twice is one connection (spec).
    if (real.edges.some(e => e.output === output && e.to === target._id && e.input === input && e.param === param)) return;
    let via = null;
    if (stage !== target._stage) {
      if (prm || target._stage !== this._graph.mixStage) {
        const what = prm ? `param ${prm._name} of ${target._describe()}` : target._describe();
        throw new Error(`Heart: cannot connect ${this._describe()} to ${what}. ` +
          'An edge between stages must go from an island into a node input in the mix.');
      }
      via = this._graph.openPort(real.stage, target._id, input, this._island,
        () => `connecting ${this._describe()} to ${target._describe()}`);
    }
    const e = { output, to: target._id, input, param, via };
    real.edges.push(e);
    this._graph.send(real.stage, c => this._writeEdge(c, e));
  }

  _writeEdge(c, e) {
    if (e.via) c.connect(this._id, e.output, e.via.egress, 0);
    else if (e.param >= 0) c.connectParam(this._id, e.output, e.to, e.param);
    else c.connect(this._id, e.output, e.to, e.input);
  }

  // ---- disconnect ----
  // Every overload the spec has: none (everything), an output index, a node,
  // a node and output, a node, output and input, a param, a param and
  // output. Naming a destination this node does not feed is an error, as it
  // is in Web Audio; the app wraps those calls in try.
  disconnect(dest, output, input) {
    if (dest === undefined) { this._unlink(() => true); return; }
    if (typeof dest === 'number') {
      this._checkOutput(dest);
      this._unlink(e => e.output === dest, dest);
      return;
    }
    if (output !== undefined) this._checkOutput(output);
    let found;
    if (dest instanceof HeartParam) {
      const to = dest._node._id, p = dest._index;
      found = this._unlink(e => e.to === to && e.param === p && (output === undefined || e.output === output));
    } else {
      this._checkNode(dest);
      if (input !== undefined && !isIndex(input, dest.numberOfInputs)) {
        throw domError(`${dest._describe()} has no input ${input}`, 'IndexSizeError');
      }
      found = this._unlink(e => e.param < 0 && e.to === dest._id &&
        (output === undefined || e.output === output) && (input === undefined || e.input === input));
    }
    if (!found) {
      throw domError(`${this._describe()} is not connected to that destination`, 'InvalidAccessError');
    }
  }

  // Removes the edges `pick` chooses from every real node behind the proxy.
  // The wire's disconnects are coarser than the spec's overloads (all
  // edges, one output, everything into one node or one param), so the
  // coarse one is sent and the edges it took that were meant to stay are
  // connected again in the same batch, which the stage applies as one.
  // `output` is set for the output-index overload, which the wire has as is.
  _unlink(pick, output) {
    let found = false;
    for (const real of this._core.reals.values()) {
      const gone = real.edges.filter(pick);
      if (!gone.length) continue;
      found = true;
      real.edges = real.edges.filter(e => !gone.includes(e));
      const kept = real.edges, id = this._id;
      this._graph.send(real.stage, c => {
        if (!kept.length) { c.disconnectAll(id); return; }
        if (output !== undefined) { c.disconnectOutput(id, output); return; }
        const done = new Set();
        for (const e of gone) {
          const end = endpoint(e);
          if (done.has(end)) continue;
          done.add(end);
          if (e.param >= 0) c.disconnectParam(id, e.to, e.param);
          else c.disconnectNode(id, e.via ? e.via.egress : e.to);
          for (const k of kept) if (endpoint(k) === end) this._writeEdge(c, k);
        }
      });
      for (const e of gone) if (e.via) this._graph.closePort(real.stage, e.via);
    }
    return found;
  }

  // ---- the wire ----
  // The real node in `stage`, made now if it is a replica not yet there.
  // A late replica is told its channel rules and its latest messages.
  _real(stage) {
    let r = this._core.reals.get(stage);
    if (r) return r;
    r = makeReal(stage);
    this._core.reals.set(stage, r);
    this._graph.send(stage, c => {
      c.create(this._id, KINDS[this._kind], this._island, this._opts);
      if (this._cfgSent) this._writeChannels(c, this._id);
      if (this._replicable) for (const bytes of this._log.values()) c.message(this._id, bytes);
    });
    return r;
  }

  // One record to every real node (a replicable node has several, all
  // under the one id), written by fn(commands, id).
  _sendAll(fn) {
    for (const real of this._core.reals.values()) this._graph.send(real.stage, c => fn(c, this._id));
  }
  // The same, and to the shadow: everything a param's timeline hears.
  _sendParam(fn) {
    this._sendAll(fn);
    this._graph.shadow.write(c => fn(c, this._id));
  }
  // A processor message, logged first on a replicable node (see _log).
  _message(bytes) {
    if (this._replicable) this._log.set(new DataView(bytes.buffer).getUint32(0, true), bytes);
    this._sendAll((c, id) => c.message(id, bytes));
  }

  // ---- checks ----
  _describe() { return `${this._kind}#${this._id} (${this._ctx._islandName})`; }
  _checkOutput(o) {
    if (!isIndex(o, this.numberOfOutputs)) {
      throw domError(`${this._describe()} has no output ${o}`, 'IndexSizeError');
    }
  }
  _checkNode(n) {
    if (!(n instanceof HeartNode)) {
      throw domError(`${this._describe()} can only connect to Heart nodes and params. ` +
        'A Heart family reaches the native graph through masterFor(family).', 'InvalidAccessError');
    }
  }
  _checkGraph(n) {
    if (n._graph !== this._graph) {
      throw domError(`${this._describe()} and ${n._describe()} belong to different engines`, 'InvalidAccessError');
    }
  }
}

// What a wire disconnect reaches: one param, or one node (the port's egress
// for a cross edge).
const endpoint = e => e.param >= 0 ? 'p' + e.to + ':' + e.param : 'n' + (e.via ? e.via.egress : e.to);

// The params of a node by name, for the getters below.
const param = (node, name) => node._params.find(p => p._name === name);

// ---------- the standard nodes ----------
export class HeartGain extends HeartNode {
  constructor(ctx) { super(ctx, 'gain'); }
  get gain() { return this._params[0]; }
}

export class HeartStereoPanner extends HeartNode {
  constructor(ctx) { super(ctx, 'stereo_panner'); }
  get pan() { return this._params[0]; }
}

export class HeartDelay extends HeartNode {
  constructor(ctx, maxDelayTime = 1) {
    finite(maxDelayTime, 'maxDelayTime');
    if (!(maxDelayTime > 0 && maxDelayTime < 180)) {
      throw new DOMException(`maxDelayTime ${maxDelayTime} must be above 0 and below 180`, 'NotSupportedError');
    }
    super(ctx, 'delay', [maxDelayTime]);
  }
  // delayTime's upper bound (params.js reads it while making the param)
  get _maxDelayTime() { return this._opts[0]; }
  get delayTime() { return this._params[0]; }
}

export class HeartBiquad extends HeartNode {
  constructor(ctx) {
    super(ctx, 'biquad', [ENUMS.biquad_type.lowpass]);
    this._type = 'lowpass';
  }
  get frequency() { return param(this, 'frequency'); }
  get detune() { return param(this, 'detune'); }
  get Q() { return param(this, 'Q'); }
  get gain() { return param(this, 'gain'); }
  get type() { return this._type; }
  set type(t) {
    if (!Object.hasOwn(ENUMS.biquad_type, t)) return;
    this._type = t;
    this._sendAll((c, id) => c.attr(id, ATTRS.type, ENUMS.biquad_type[t]));
  }
}

// The peak meter. Heart's analyser keeps the last fftSize frames and, when
// asked, answers with the loudest |x| among them, which is all the app ever
// reads from one (util.js tapPeak, ambience.js's meters).
export class HeartAnalyser extends HeartNode {
  constructor(ctx) {
    super(ctx, 'analyser', [2048]);
    this._fft = 2048;
    this._latest = 0;
    this._askedAt = -Infinity;
    this._graph.hear(this);
  }
  get fftSize() { return this._fft; }
  set fftSize(n) {
    if (!(Number.isInteger(n) && n >= 32 && n <= 32768 && (n & (n - 1)) === 0)) {
      throw new DOMException(`fftSize ${n} must be a power of two from 32 to 32768`, 'IndexSizeError');
    }
    this._fft = n;
    this._sendAll((c, id) => c.attr(id, ATTRS.fftSize, n));
  }
  get frequencyBinCount() { return this._fft / 2; }

  // The latest peak the engine reported, 0 until the first arrives. Each
  // read asks for the next one, unless an ask is already on its way, so a
  // meter read at frame rate always shows the freshest answer.
  peak() {
    const now = performance.now();
    if (now - this._askedAt > PEAK_WAIT_MS) {
      this._askedAt = now;
      this._sendAll((c, id) => c.peakRequest(id));
    }
    return this._latest;
  }
  _peak(v) {
    this._latest = v;
    this._askedAt = -Infinity;
  }

  // A stand-in, not the waveform: Heart never sends samples back, so this
  // fills the array with the latest peak, a constant. A caller that scans
  // the array for its largest |x| (tapPeak) gets exactly the peak, which is
  // what every caller in the app does with it.
  getFloatTimeDomainData(arr) {
    arr.fill(this.peak());
  }
}

export class HeartConvolver extends HeartNode {
  constructor(ctx) {
    super(ctx, 'convolver');
    this._buffer = null;
    this._normalize = true;
  }
  // A new impulse replaces the old one, which is freed on this node's
  // stages at once: a room rebuilds its impulse for every change of decay,
  // and the old one is never named again. A stage keeps it while another
  // node there still plays it, and a later use uploads it afresh
  // (buffers.js).
  get buffer() { return this._buffer; }
  set buffer(buf) {
    const old = this._buffer;
    sendBuffer(this, buf);
    this._buffer = buf;
    if (old && old !== buf) {
      const stages = [...this._core.reals.values()].map(r => r.stage);
      this._graph.engine.freeBuffer(registerBuffer(old), stages);
    }
  }
  // Read when a buffer is set, as the spec says, so it goes first.
  get normalize() { return this._normalize; }
  set normalize(on) {
    this._normalize = !!on;
    this._sendAll((c, id) => c.attr(id, ATTRS.normalize, on ? 1 : 0));
  }
}

// An AudioBuffer stays a native object. Handed to a node, it is registered
// (once, by C1's buffer registry), uploaded to the node's stage if that
// stage does not hold it yet, and then named on the wire by its id. The
// buffer is passed along too, for an engine that uploads it itself (the
// offline one, heart.js). null, the empty buffer, travels as -1.
function sendBuffer(node, buf) {
  if (buf === null) {
    node._sendAll((c, id) => c.attr(id, ATTRS.buffer, -1));
    return;
  }
  if (!buf || typeof buf.getChannelData !== 'function') {
    throw new TypeError(`${node._describe()}: buffer must be an AudioBuffer or null`);
  }
  const bufferId = registerBuffer(buf);
  for (const real of node._core.reals.values()) node._graph.engine.ensureBuffer(bufferId, real.stage, buf);
  node._sendAll((c, id) => c.attr(id, ATTRS.buffer, bufferId));
}

// ---------- sources ----------
// What AudioScheduledSourceNode adds: start, stop and the ended event.
// Starting puts the source on the graph's playing list, which holds it
// until the engine reports it ended (see HeartGraph).
//
// A source's start and stop are a timeline of their own, moved as a late
// gesture is (HeartGraph, late gestures). A voice started at currentTime
// wears an envelope anchored at the same moment (a cloud's attack, an
// ambience voice's fade in), and the envelope is moved by the same Δ, so the
// voice begins exactly where its envelope does, as it would natively; were
// the start left at the stage's head, the attack would have passed before
// the voice sounded. The stop goes with its start, so a take's length and
// its fade out (the bed's passes) stay together too.
class HeartSource extends HeartNode {
  constructor(ctx, kind, opts) {
    super(ctx, kind, opts);
    this._started = false;
    this._onended = null;
  }
  get onended() { return this._onended; }
  set onended(fn) { this._onended = typeof fn === 'function' ? fn : null; }

  start(when = 0) { this._start(when, 0, -1); }
  _start(when, offset, duration) {
    notNegative(when, 'when');
    if (this._started) throw new DOMException(`${this._describe()} has already been started`, 'InvalidStateError');
    this._started = true;
    const g = this._graph, f = g.shift(this, g.frame(when));
    this._sendAll((c, id) => c.start(id, f, offset, duration));
    g.play(this);
  }
  stop(when = 0) {
    notNegative(when, 'when');
    if (!this._started) throw new DOMException(`${this._describe()} has not been started`, 'InvalidStateError');
    const g = this._graph, f = g.shift(this, g.frame(when));
    this._sendAll((c, id) => c.stop(id, f));
  }
  _ended() {
    const ev = new Event('ended');
    this.dispatchEvent(ev);
    if (this._onended) this._onended.call(this, ev);
  }
}

export class HeartConstantSource extends HeartSource {
  constructor(ctx) { super(ctx, 'constant_source'); }
  get offset() { return this._params[0]; }
}

export class HeartOscillator extends HeartSource {
  constructor(ctx) {
    super(ctx, 'oscillator', [ENUMS.oscillator_type.sine]);
    this._type = 'sine';
  }
  get frequency() { return param(this, 'frequency'); }
  get detune() { return param(this, 'detune'); }
  get type() { return this._type; }
  set type(t) {
    if (t === 'custom') {
      throw new DOMException(`${this._describe()}: a custom wave is not supported`, 'InvalidStateError');
    }
    if (!Object.hasOwn(ENUMS.oscillator_type, t)) return;
    this._type = t;
    this._sendAll((c, id) => c.attr(id, ATTRS.type, ENUMS.oscillator_type[t]));
  }
}

export class HeartBufferSource extends HeartSource {
  constructor(ctx) {
    super(ctx, 'buffer_source');
    this._buffer = null;
    this._loop = false;
    this._loopStart = 0;
    this._loopEnd = 0;
  }
  get playbackRate() { return param(this, 'playbackRate'); }
  get detune() { return param(this, 'detune'); }

  // Once set to a buffer, it stays that buffer (spec).
  get buffer() { return this._buffer; }
  set buffer(buf) {
    if (buf && this._buffer) {
      throw new DOMException(`${this._describe()} already has a buffer`, 'InvalidStateError');
    }
    sendBuffer(this, buf);
    this._buffer = buf;
  }
  get loop() { return this._loop; }
  set loop(on) {
    this._loop = !!on;
    this._sendAll((c, id) => c.attr(id, ATTRS.loop, on ? 1 : 0));
  }
  get loopStart() { return this._loopStart; }
  set loopStart(t) {
    this._loopStart = finite(t, 'loopStart');
    this._sendAll((c, id) => c.attr(id, ATTRS.loopStart, t));
  }
  get loopEnd() { return this._loopEnd; }
  set loopEnd(t) {
    this._loopEnd = finite(t, 'loopEnd');
    this._sendAll((c, id) => c.attr(id, ATTRS.loopEnd, t));
  }

  // offset and duration are positions in the buffer, in seconds, not times
  // on the clock, so only `when` becomes a frame. No duration is -1.
  start(when = 0, offset = 0, duration) {
    notNegative(offset, 'offset');
    if (duration !== undefined) notNegative(duration, 'duration');
    this._start(when, offset, duration === undefined ? -1 : duration);
  }
}

// The destination: Heart's master bus, in the mix. Its output is the final
// ring, which the drain plays into the native master gain.
export class HeartMaster extends HeartNode {
  constructor(ctx) { super(ctx, 'master'); }
  get maxChannelCount() { return MAX_CHANNELS; }
}

// ---------- processors ----------
// The app's AudioWorklet processors, ported to Rust (spec 6.3). The kind
// fixes its own inputs, outputs and channel counts, which are the ones the
// app makes them with, so the node options are not needed.
export class HeartProcessor extends HeartNode {
  constructor(ctx, name) {
    const kind = PROCESSOR_KINDS[name];
    if (!kind) {
      throw new DOMException(`Heart has no processor named '${name}'`, 'InvalidStateError');
    }
    super(ctx, kind);
    this._parameters = new Map(this._params.map(p => [p._name, p]));
    const Codec = CODECS[kind];
    this._port = new HeartPort(this, Codec ? new Codec(this) : null);
    if (Codec) this._graph.hear(this);
  }
  get parameters() { return this._parameters; }
  get port() { return this._port; }
  _portEvent(dv, at, len) { this._port._receive(dv, at, len); }
}

// A processor's port: postMessage in, onmessage out, each message turned
// into its wire bytes and back by the processor's codec. Messages arrive as
// {data} objects, as a MessagePort delivers them.
class HeartPort {
  constructor(node, codec) {
    this._node = node;
    this._codec = codec;
    this.onmessage = null;
  }
  // The transfer list is accepted and not needed: the message is copied
  // into the command batch either way.
  postMessage(msg) {
    const bytes = this._codec && this._codec.encode(msg);
    if (bytes) this._node._message(bytes);
  }
  _receive(dv, at, len) {
    const ev = this._codec && this._codec.decode(dv, at, len);
    if (ev && typeof this.onmessage === 'function') this.onmessage(ev);
  }
}

// ---------- port messages ----------
// protocol.json processor_messages: a u32 type, then the fields,
// little-endian and unpadded. Every `at` is a native time sent as an engine
// frame. It is the anchor of a formula, so it may lie in the past, and is
// sent as it is rather than moved up to the present.
//
// The numbers are coerced here as the JS processors coerce them as they
// read a message (+x || 0, x | 0, !!x), so the Rust ports receive exactly
// what the JS ones went on to use.
function pack(type, nums, tail = 0) {
  const bytes = new Uint8Array(4 + nums.length * 8 + tail);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, type, true);
  for (let i = 0; i < nums.length; i++) v.setFloat64(4 + i * 8, nums[i], true);
  return { bytes, v, end: 4 + nums.length * 8 };
}
const num = x => +x || 0;
const flag = x => x ? 1 : 0;

const SIGNAL_IN = MESSAGES.strobe_signal_in, GENUS_IN = MESSAGES.genus_in, GENUS_OUT = MESSAGES.genus_out;

// The strobe signal hears one message, the formula's numbers.
//
// Its replicas (one per stage that uses it) agree to the bit only if a
// message lands on the same frame on each of them, and a message lands at
// its anchor when the anchor is still ahead of the stage, at once when it
// has passed (heart/src/nodes/strobe_signal.rs). So on an engine of more
// than one stage the formula is folded forward to an anchor beyond every
// stage's horizon (Engine.horizon): the same law, the same phase at every
// moment from there on, written from a later point on it. With
// Δ = at' − at in seconds:
//
//   p'  = p + cycles(Δ), mod 1        the phase there
//   r0' = rate(Δ)                     the rate there
//   dur' = dur − Δ, r1 the same       what is left of the ramp, or, once
//                                     it is over, a steady r1
//
// which v1/core/signal.js's cyclesAt confirms: the cycles from at' on are
// r0'τ + (r1 − r0')τ²/2dur', the old formula's cycles less those it had
// done by Δ. Every replica, made now or later, hears the folded message, so
// they all change on the same frame. A single stage needs no fold, and the
// offline context, with nothing rendered ahead, gets the numbers as they are.
class StrobeSignalCodec {
  constructor(node) { this._engine = node._graph.engine; }
  encode(d) {
    if (!d) return null;
    const e = this._engine;
    let at = e.frameAt(num(d.at)), p = num(d.p), r0 = num(d.r0), r1 = num(d.r1), dur = num(d.dur);
    if (e.stages.length > 1) {
      const to = Math.ceil(e.horizon());
      if (at < to) [at, p, r0, r1, dur] = [to, ...foldSignal(p, r0, r1, dur, (to - at) / e.sampleRate)];
    }
    return pack(SIGNAL_IN.signal, [at, p, r0, r1, dur, d.wave | 0, +d.duty, flag(d.on)]).bytes;
  }
  decode() { return null; }
}

// The formula's numbers `delta` seconds after its anchor: [p, r0, r1, dur].
// cycles is v1/core/signal.js cyclesAt (and the Rust port's cycles_at).
export function foldSignal(p, r0, r1, dur, delta) {
  let cycles, rate;
  if (!(dur > 0)) { cycles = r0 * delta; rate = r0; }
  else if (delta < dur) {
    cycles = r0 * delta + (r1 - r0) * delta * delta / (2 * dur);
    rate = r0 + (r1 - r0) * delta / dur;
    dur -= delta;
  } else {
    cycles = (r0 + r1) * 0.5 * dur + r1 * (delta - dur);
    rate = r1;
    dur = 0;
  }
  const phase = p + cycles;
  return [phase - Math.floor(phase), rate, r1, dur];
}

// The genus engine hears four (the signal, meters on or off, dip watching,
// a chirp table) and says three (peaks, the dip, a chirp table's ack).
class GenusCodec {
  constructor(node) {
    this._graph = node._graph;
    // A chirp table is signed with a string (audio.js chirpSignature) and
    // acknowledged with the same string. The wire carries a number, so each
    // string gets one here, and the ack is turned back into the string. The
    // last few are enough: only the newest table is ever waited on. 0 is no
    // signature, which the processor acknowledges as true.
    this._sigs = new Map();
    this._names = new Map();
    this._nextSig = 1;
    // Peaks arrive fifty times a second, so their message is one object,
    // refilled, as the JS processor reused its own; the app copies the
    // three numbers out as each one lands.
    this._peaks = { data: { peaks: true, tone: 0, pulse: 0, harm: 0 } };
  }
  encode(d) {
    if (!d) return null;
    if (d.signal) {
      const at = this._graph.engine.frameAt(num(d.at));
      return pack(GENUS_IN.signal, [at, num(d.p), num(d.r0), num(d.r1), num(d.dur), d.wave | 0, +d.duty, flag(d.linked)]).bytes;
    }
    if (d.meters !== undefined) return pack(GENUS_IN.meters, [flag(d.meters)]).bytes;
    if (d.dipWatch !== undefined) return pack(GENUS_IN.dipWatch, [flag(d.dipWatch)]).bytes;
    if (d.chirp) {
      const table = d.chirp, n = table.length;
      const { bytes, v, end } = pack(GENUS_IN.chirp, [this._sig(d.sig), +d.xf], 4 + 4 * n);
      v.setUint32(end, n, true);
      for (let i = 0; i < n; i++) v.setFloat32(end + 4 + 4 * i, table[i], true);
      return bytes;
    }
    return null;
  }
  decode(v, at) {
    const type = v.getUint32(at, true);
    if (type === GENUS_OUT.peaks) {
      const m = this._peaks.data;
      m.tone = v.getFloat32(at + 4, true);
      m.pulse = v.getFloat32(at + 8, true);
      m.harm = v.getFloat32(at + 12, true);
      return this._peaks;
    }
    if (type === GENUS_OUT.dip) return { data: { dip: v.getFloat32(at + 4, true) } };
    if (type === GENUS_OUT.chirpAck) {
      const n = v.getFloat64(at + 4, true);
      return { data: { chirpAck: n === 0 ? true : this._names.get(n) } };
    }
    return null;
  }
  _sig(s) {
    if (s === undefined) return 0;
    let n = this._sigs.get(s);
    if (n === undefined) {
      n = this._nextSig++;
      this._sigs.set(s, n);
      this._names.set(n, s);
      if (this._sigs.size > 16) {
        const [old, oldN] = this._sigs.entries().next().value;
        this._sigs.delete(old);
        this._names.delete(oldN);
      }
    }
    return n;
  }
}

const CODECS = { genus: GenusCodec, strobe_signal: StrobeSignalCodec };
