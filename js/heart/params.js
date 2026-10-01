// HeartParam: an AudioParam whose timeline lives in Heart.
//
// It has the whole AudioParam surface, so the app's automation code
// (glideParam, anchorParam, the sweeps, the choir's cosine) runs on it
// unchanged. Every call becomes one command record for the node's stage and
// the same record for the shadow (js/heart/heart.js), the main thread's own
// copy of the engine that keeps nothing but param timelines. The timeline's
// math is written once, in Rust (heart/src/param.rs): a `value` read asks the
// shadow what that one law says the param holds right now, and nothing here
// ever works a ramp out for itself.
//
// Times arrive in seconds on the native context's clock, the clock the app
// already schedules by, and leave as engine frames (Engine.frameAt). A time
// earlier than currentTime is moved up to currentTime first, which is what
// the Web Audio spec does with every automation time. A setTargetAtTime's
// time constant and a curve's duration are lengths, not moments, and stay in
// seconds.
//
// A stage renders ahead of currentTime, so a gesture anchored there (an
// anchor and a short ramp) would reach it already begun. Such a gesture is
// moved whole instead: the first call to a param that lands behind the
// render horizon sets its lateness, and that call and every later one to
// the same param in the same task are moved on by it (nodes.js, HeartGraph,
// late gestures). A new node's first value is not a gesture: it lands at the
// present and leaves later calls on their own times (setValueAtTime says
// how). Each call is worked out once and the one record goes to
// the stage and the shadow alike, so the shadow holds the timeline that
// plays, and `value` is read where a call made now would land.

// f32's largest value, the bound the spec gives an unbounded param.
const F32_MAX = 3.4028234663852886e38;

// Arguments are checked as Web Audio checks them, before anything is sent,
// so a call the browser would refuse is refused here too and the timeline
// never holds an event a native context would not.
export function finite(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`HeartParam: ${what} must be a finite number (got ${v})`);
  }
  return v;
}
export function notNegative(t, what) {
  finite(t, what);
  if (t < 0) throw new RangeError(`HeartParam: ${what} must not be negative (got ${t})`);
  return t;
}

// A bound from the protocol's param table. Most are plain numbers; the rest
// depend on the context or the node: 'max' is f32's largest, 'nyquist' half
// the sample rate, 'maxDelayTime' the delay's own creation option.
function bound(b, node) {
  if (typeof b === 'number') return b;
  const neg = b[0] === '-', name = neg ? b.slice(1) : b;
  const v = name === 'max' ? F32_MAX
    : name === 'nyquist' ? node.context.sampleRate / 2
    : name === 'maxDelayTime' ? node._maxDelayTime
    : NaN;
  return neg ? -v : v;
}

export class HeartParam {
  // node: the HeartNode this param belongs to. index: its place in the
  // kind's param list, which is its id on the wire. spec: the protocol's
  // [name, default, min, max, rate] for it.
  constructor(node, index, spec) {
    const [name, def, min, max, rate] = spec;
    this._node = node;
    this._index = index;
    this._name = name;
    this._default = Math.fround(def);
    this._min = Math.fround(bound(min, node));
    this._max = Math.fround(bound(max, node));
    this._rate = rate === 'k' ? 'k-rate' : 'a-rate';
    // No call has reached this param yet (setValueAtTime says why it counts).
    this._fresh = true;
  }

  get defaultValue() { return this._default; }
  get minValue() { return this._min; }
  get maxValue() { return this._max; }

  // Each param keeps the rate the spec gives it. Heart renders it that way
  // and does not switch, so asking for the other one is refused rather than
  // quietly ignored.
  get automationRate() { return this._rate; }
  set automationRate(rate) {
    if (rate === this._rate) return;
    throw new DOMException(`HeartParam ${this._name}: the automation rate is fixed at ${this._rate}`,
      'InvalidStateError');
  }

  // The intrinsic value from the shadow's timeline, at the present a call
  // made now lands on: what the spec's `value` getter returns, read where
  // Heart's renderer stands, as Chrome's is read where its renderer stands.
  // An anchor taken from it (audio.js anchorParam) is then exactly the value
  // its gesture starts from.
  get value() {
    const g = this._node._graph;
    return g.shadow.value(this._node._id, this._index, g.present());
  }
  // The spec defines the setter as setValueAtTime(v, currentTime).
  set value(v) {
    this.setValueAtTime(v, this._node._graph.clock.currentTime);
  }

  setValueAtTime(value, startTime) {
    finite(value, 'value');
    notNegative(startTime, 'startTime');
    const g = this._node._graph, f = g.frame(startTime);
    // A node made in this task has played nothing yet, so the first value
    // one of its params is given, behind the present, is the value it is
    // born with, as it is natively, and not a gesture. It is sent where it
    // falls, which a stage lands on the node's first frame, so a processor
    // or a gain spliced into a sounding path never plays the default; and
    // at the present, where a late gesture after it starts from it. It
    // makes the param late for nothing after it (HeartGraph.initial): a
    // fade or a note booked ahead against the node keeps its true time.
    if (this._fresh && this._node._born === g.task() && f < g.present()) {
      g.initial(this, f);
      this._send((c, id) => c.paramSet(id, this._index, f, value));
      this._send((c, id) => c.paramSet(id, this._index, g.present(), value));
      return this;
    }
    const at = g.shift(this, f);
    this._send((c, id) => c.paramSet(id, this._index, at, value));
    return this;
  }

  linearRampToValueAtTime(value, endTime) {
    finite(value, 'value');
    notNegative(endTime, 'endTime');
    const f = this._frame(endTime);
    this._send((c, id) => c.paramLinear(id, this._index, f, value));
    return this;
  }

  // The spec refuses only an exact zero: a negative target is legal, and an
  // exponential ramp between values of different signs holds instead.
  exponentialRampToValueAtTime(value, endTime) {
    finite(value, 'value');
    if (Math.fround(value) === 0) {
      throw new RangeError(`HeartParam ${this._name}: an exponential ramp cannot reach 0`);
    }
    notNegative(endTime, 'endTime');
    const f = this._frame(endTime);
    this._send((c, id) => c.paramExp(id, this._index, f, value));
    return this;
  }

  setTargetAtTime(target, startTime, timeConstant) {
    finite(target, 'target');
    notNegative(startTime, 'startTime');
    notNegative(timeConstant, 'timeConstant');
    const f = this._frame(startTime);
    this._send((c, id) => c.paramTarget(id, this._index, f, target, timeConstant));
    return this;
  }

  setValueCurveAtTime(values, startTime, duration) {
    const curve = Float32Array.from(values);
    if (curve.length < 2) {
      throw new DOMException(`HeartParam ${this._name}: a value curve needs at least two points`,
        'InvalidStateError');
    }
    for (let i = 0; i < curve.length; i++) finite(curve[i], 'every curve value');
    notNegative(startTime, 'startTime');
    finite(duration, 'duration');
    if (!(duration > 0)) throw new RangeError(`HeartParam ${this._name}: duration must be positive (got ${duration})`);
    const f = this._frame(startTime);
    this._send((c, id) => c.paramCurve(id, this._index, f, duration, curve));
    return this;
  }

  // A cancel at currentTime leaves alone what has already played. Moved on
  // to the horizon it would also take away the rest of a ramp the stage has
  // still to render before then, and the param would fall back to where
  // that ramp began and step at the anchor. So a late cancel holds instead:
  // the timeline runs on unchanged up to the moved time and stops there,
  // which is what the native one does with the played past.
  cancelScheduledValues(cancelTime) {
    notNegative(cancelTime, 'cancelTime');
    const g = this._node._graph, f = g.frame(cancelTime), at = g.shift(this, f);
    if (f < g.present()) this._send((c, id) => c.paramCancelHold(id, this._index, at));
    else this._send((c, id) => c.paramCancel(id, this._index, at));
    return this;
  }

  cancelAndHoldAtTime(cancelTime) {
    notNegative(cancelTime, 'cancelTime');
    const f = this._frame(cancelTime);
    this._send((c, id) => c.paramCancelHold(id, this._index, f));
    return this;
  }

  // A time in native seconds as the engine frame it lands on: moved up to
  // currentTime, then on by the param's lateness (see the top).
  _frame(t) {
    const g = this._node._graph;
    return g.shift(this, g.frame(t));
  }

  // One record to every real node behind the proxy, and one to the shadow.
  _send(write) {
    this._fresh = false;
    this._node._sendParam(write);
  }
}
