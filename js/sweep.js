// A slow sweep for any AudioParam, played on the audio clock from the main
// thread. It is the click train's filter motion (lpfBlock in worklet.js)
// lifted out of the worklet so an ordinary Web Audio node can have it too:
// the same run of half-sweeps between the low end (position 0) and the high
// end (position 1), each eased by a raised cosine, one full down-and-up per
// period. Wander stretches or shrinks each half-sweep by up to one and a half
// octaves of time and lets each dip stop short of the floor, anywhere in the
// lower two thirds of the travel at full wander. Switching on starts at the
// top and heads down, and everything passes through the worklet's quarter
// second glide, so a toggle or a dial never steps.
//
// The motion is worked out here a few seconds ahead and written onto the
// param as short ramps, a breakpoint every twentieth to quarter of a second,
// topped up by a timer about once a second. The audio thread plays those
// ramps however unevenly the page runs, and if the timer ever falls behind
// the param simply holds where it got to until the next top-up picks it up.
//
// A changed setting re-plans from the first breakpoint that has not started
// playing: everything after it is cancelled and written again from the
// motion's state at that moment, which is kept beside each breakpoint for
// exactly this. The ramp already playing is never cut, since cancelling a
// ramp mid-flight snaps the param back to where that ramp began.
//
// Two domains. 'log' moves in log units and writes exponential ramps, so a
// frequency sweeps evenly in pitch, the way the worklet interpolates its
// cutoff; 'lin' moves and ramps in plain units, for a gain. Off glides to the
// neutral value handed to start() and then goes quiet: nothing is scheduled
// while it sits there.
//
// Nothing here allocates per breakpoint. The plan lives in fixed typed
// arrays, the settings are read into one reused object, and the only garbage
// is whatever the browser keeps for each automation event.

const LOOKAHEAD_S = 3;       // how far ahead of the audio clock the motion is written
const CADENCE_MS = 1000;     // how often the timer tops it up
const MARGIN_S = 0.05;       // breakpoints this close to now count as already playing
const STEP_MIN_S = 0.05;     // breakpoint spacing while the glide is catching up
const STEP_MAX_S = 0.25;     // and the widest spacing on a slow sweep
const SMOOTH_S = 0.25;       // the worklet's glide time constant
const CAP = 256;             // planned breakpoints held; a full lookahead needs well under 100

export function createSweep({ domain, read }) {
  const log = domain === 'log';
  // how far behind its target the glide can be before breakpoints tighten,
  // and how close to neutral counts as having arrived there
  const CATCH = log ? 0.1 : 0.05;
  const SETTLE = log ? 0.005 : 0.002;
  const cfg = { on: false, lo: 0, hi: 1, period: 60, wander: 0 };

  // The plan: one breakpoint per slot, as a ring, with the motion's state at
  // that breakpoint so a re-plan can resume from any of them.
  const bT = new Float64Array(CAP), bY = new Float64Array(CAP);
  const bFrom = new Float64Array(CAP), bTo = new Float64Array(CAP);
  const bU = new Float64Array(CAP), bMul = new Float64Array(CAP);
  const bOn = new Uint8Array(CAP);
  let head = 0, count = 0;

  let ctx = null, prm = null, timer = null, updateQueued = false;
  let neutral = 0, yN = 0, loY = 0, hiY = 1;
  // The live motion, always equal to the newest breakpoint in the plan. These
  // are the worklet's lpfFrom, lpfTo, lpfU, lpfMul, lpfWasOn and lpfLog, plus
  // t, the audio-clock time the state belongs to.
  let from = 1, to = 0, u = 0, mul = 1, wasOn = false, y = 0, t = 0;

  function readCfg() {
    read(cfg);
    cfg.on = !!cfg.on;
    if (!(cfg.period >= 0.5)) cfg.period = 0.5;
    cfg.wander = cfg.wander > 0 ? Math.min(1, cfg.wander) : 0;
    loY = log ? Math.log(Math.max(1e-3, cfg.lo)) : cfg.lo;
    hiY = log ? Math.log(Math.max(1e-3, cfg.hi)) : cfg.hi;
  }
  const out = v => v === yN ? neutral : (log ? Math.exp(v) : v);
  // where a dip bottoms out, as in the worklet's lpfFloor
  const floorPos = w => w > 0 ? Math.random() * 0.66 * w : 0;
  const posY = () => {
    const e = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, u));
    return loY + (hiY - loY) * (from + (to - from) * e);
  };
  // Where the glide is heading right now, without moving anything: used only
  // to decide how closely the next breakpoint should follow.
  const targetNow = () => !cfg.on ? yN : (wasOn ? posY() : hiY);

  // One step of lpfBlock. The worklet drops the fraction of a block that
  // overshoots a turnaround, which at 128 samples is nothing; at these step
  // sizes it would shorten every half-sweep, so the overshoot is carried into
  // the next one instead.
  function advance(dt) {
    const on = cfg.on;
    if (on && !wasOn) { from = 1; to = floorPos(cfg.wander); u = 0; mul = 1; }
    wasOn = on;
    let target = yN;
    if (on) {
      let half = 0.5 * cfg.period * mul;
      u += dt / half;
      while (u >= 1) {
        const over = (u - 1) * half;
        from = to;
        to = from > 0.5 ? floorPos(cfg.wander) : 1;
        mul = Math.pow(2, (Math.random() * 2 - 1) * 1.5 * cfg.wander);
        half = 0.5 * cfg.period * mul;
        u = over / half;
      }
      target = posY();
    }
    y += (target - y) * (1 - Math.exp(-dt / SMOOTH_S));
    t += dt;
  }

  function push() {
    const i = (head + count) % CAP;
    bT[i] = t; bY[i] = y; bFrom[i] = from; bTo[i] = to; bU[i] = u; bMul[i] = mul;
    bOn[i] = wasOn ? 1 : 0;
    count++;
  }
  function restore(i) {
    t = bT[i]; y = bY[i]; from = bFrom[i]; to = bTo[i]; u = bU[i]; mul = bMul[i];
    wasOn = bOn[i] === 1;
  }
  // Forgets breakpoints the audio clock has passed, keeping the newest of
  // them, which is where the motion stands if nothing later was planned.
  function expire(now) {
    while (count > 1 && bT[(head + 1) % CAP] <= now) { head = (head + 1) % CAP; count--; }
  }
  const settledOff = () => !cfg.on && y === yN;

  // Writes breakpoints from the live state until the plan reaches `until`.
  function plan(until) {
    while (count < CAP && t < until) {
      if (settledOff()) return;
      let dt = Math.min(STEP_MAX_S, Math.max(STEP_MIN_S, cfg.period * mul / 24));
      if (cfg.on !== wasOn || Math.abs(targetNow() - y) > CATCH) dt = STEP_MIN_S;
      advance(dt);
      // arrived back at neutral: land on it exactly and stop writing
      if (!cfg.on && Math.abs(y - yN) < SETTLE) y = yN;
      const v = out(y);
      if (log) prm.exponentialRampToValueAtTime(v, t);
      else prm.linearRampToValueAtTime(v, t);
      push();
    }
  }

  // The plan has run out behind the clock (or there never was one), so the
  // param is holding still. A fresh anchor a moment ahead, at the value it is
  // holding, gives the next ramp somewhere to start from; without it the ramp
  // would be measured from a breakpoint in the past and jump.
  function anchorIfLapsed(now) {
    if (count > 0 && t > now + MARGIN_S) return;
    t = now + MARGIN_S;
    prm.setValueAtTime(out(y), t);
    push();
  }

  function tick() {
    if (!prm) return;
    readCfg();
    const now = ctx.currentTime;
    expire(now);
    if (settledOff()) return;
    anchorIfLapsed(now);
    plan(now + LOOKAHEAD_S);
  }

  // Lets go. The param keeps whatever was already written, which is fine
  // for its only caller, whose node is faded out and dropped.
  function stop() {
    clearInterval(timer); timer = null;
    prm = null; ctx = null; count = 0;
  }

  return {
    // Starts driving `param`, which the caller has just created holding
    // `neutralValue`: the filter wide open, the send at its usual level.
    start(context, param, neutralValue) {
      stop();
      ctx = context; prm = param;
      neutral = neutralValue; yN = log ? Math.log(neutralValue) : neutralValue;
      head = 0; count = 0;
      from = 1; to = 0; u = 0; mul = 1; wasOn = false; y = yN; t = 0;
      tick();
      timer = setInterval(tick, CADENCE_MS);
    },
    stop,
    // A setting moved: keep what is playing, re-plan the rest. Deferred to
    // the end of the current task, so a preset (or another tab's settings)
    // that moves five of a sweep's dials in one go re-plans it once, from
    // the settings as they finally land, instead of cancelling and writing
    // three seconds of ramps five times over. The ramps written are the
    // same ones the last of those five would have written.
    update() {
      if (!prm || updateQueued) return;
      updateQueued = true;
      queueMicrotask(replan);
    }
  };

  function replan() {
    updateQueued = false;
    if (!prm) return;
    readCfg();
    const now = ctx.currentTime;
    expire(now);
    for (let k = 0; k < count; k++) {
      const i = (head + k) % CAP;
      if (bT[i] > now + MARGIN_S) {
        // bT[i] may be the end of the ramp now playing, so it stays; the
        // next breakpoint is at least STEP_MIN_S later, so cancelling from
        // just after it takes only what has not begun
        prm.cancelScheduledValues(bT[i] + 0.001);
        restore(i);
        count = k + 1;
        break;
      }
    }
    if (settledOff()) return;
    anchorIfLapsed(now);
    plan(now + LOOKAHEAD_S);
  }
}
