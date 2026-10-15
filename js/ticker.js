// The schedulers' clock. The piano's player, the arp's and the bed's pumps,
// the clouds, the choir's wander, the sweeps and the strobe's tracker all
// plan sound a little way ahead on the audio clock and come back on a timer
// to plan more. A hidden page's own timers can be throttled hard (to once a
// second or slower, and a locked phone is harsher still), which starves that
// planning the moment the screen locks or the tab goes behind another. A
// dedicated worker's timers are left nearly alone, so the timers live in one
// tiny worker (js/ticker-worker.js) and only their ticks come here, where the
// callbacks run exactly as they did from setTimeout and setInterval. The
// same callbacks, a different clock.
//
//   every(ms, fn)   runs fn every ms, like setInterval; returns a handle
//   after(ms, fn)   runs fn once after ms, like setTimeout; returns a handle
//   clear(handle)   stops either; a spent or unknown handle is ignored
//
// Either takes { real: true } for a timer that must keep the real clock
// through a walk (the rest check, the idle driver itself).
//
// Handles are positive integers, so a caller's `if (!timer)` reads as it did
// with the browser's own. Where the worker cannot be made, or fails to load,
// the page's own setTimeout and setInterval stand in behind the same calls.
// Nothing is started until the first timer is asked for, so a module that
// imports this and never schedules (v1's engine worker, which has no sound)
// costs nothing.
//
// The walk (render ahead on idle, js/idle-ahead.js and
// documents/idle-render-ahead.md). The planners are deterministic given
// their clock, so to plan the sound N seconds ahead their timers are fired
// N seconds early, in the order they would really have fired, while the
// Heart clock reads the virtual time (js/heart/nodes.js now, through
// walkAhead below):
//
//   hold()        stops every timer but the real ones firing on the real
//                 clock; each keeps the moment it was next due
//   walk(toMs)    a discrete-event simulation up to toMs (page time): the
//                 earliest held timer due fires with the virtual clock read
//                 as its due time, an `every` is re-due its period later, an
//                 `after` is spent, and a timer made inside the walk is due
//                 its delay past the virtual now and joins it. Ties fire in
//                 the order the timers were made. Returns how many fired.
//   release()     arms every held timer for its post-walk due, so the
//                 cadence carries on seamlessly where the walk left it
//   shift(ms)     pulls every held due (and the frontier) ms earlier, after
//                 a forward skip has moved the heard clock the same way
//   walkAhead()   seconds the virtual clock is past the real one; non-zero
//                 only while a walked timer runs
//   held()        whether hold() is in force
//
// A tick from an arming that hold or a re-arm has since replaced must not
// run, so every arming carries a generation and a tick posts it back
// ([op, id, ms, first, gen] out, [id, gen] in; js/ticker-worker.js); a tick
// with a stale generation, or one landing while its timer is held, is
// dropped.

const OP_AFTER = 0, OP_EVERY = 1, OP_CLEAR = 2;   // js/ticker-worker.js's ops

const timers = new Map();   // handle -> { fn, ms, every, real, native, due, gen }
let nextHandle = 1;
// undefined until first asked for; null where the page's own timers stand in
let worker;
// The walk's state: whether the timers are held, whether a walk is running,
// the virtual now while one is (page ms), and the furthest a walk has
// reached while held.
let holding = false, walking = false, virtualNow = 0, frontier = 0;
// A walk is a planning burst, not a loop to live in; past this it is a bug.
const WALK_MOST = 100000;
// A timer made just after hold() is due the moment the hold was taken plus
// its delay, give or take the microseconds between the two calls; a tick
// due exactly at a walk's target must not miss it by that sliver. Far below
// any planner's cadence, so nothing fires early enough to matter.
const WALK_GRACE = 1;

export function every(ms, fn, opts) { return start(ms, fn, true, opts); }
export function after(ms, fn, opts) { return start(ms, fn, false, opts); }

export function clear(handle) {
  const t = timers.get(handle);
  if (!t) return;
  timers.delete(handle);
  if (worker) worker.postMessage([OP_CLEAR, handle, 0]);
  else clearTimeout(t.native);   // clears an interval too, as both share one list
}

function start(ms, fn, every, opts) {
  const handle = nextHandle++;
  const real = !!(opts && opts.real);
  const now = performance.now();
  // Where the timer is next due: made inside a walk, its delay past the
  // virtual now; made merely held, past the frontier already planned (never
  // the past); otherwise past now, as ever.
  const from = walking ? virtualNow : holding && !real ? Math.max(now, frontier) : now;
  const t = { fn, ms, every, real, native: 0, due: from + ms, gen: 0 };
  timers.set(handle, t);
  if (real || !holding) arm(handle, t);
  return handle;
}

// Arms the clock for the timer: its first tick `first` ms from now (its own
// period when not said), then its period. A fresh generation makes any tick
// of an earlier arming stale.
function arm(handle, t, first = -1) {
  const gen = ++t.gen;
  const w = clock();
  if (w) {
    if (t.every) w.postMessage([OP_EVERY, handle, t.ms, first, gen]);
    else w.postMessage([OP_AFTER, handle, first >= 0 ? first : t.ms, -1, gen]);
  } else {
    clearTimeout(t.native);
    if (!t.every) t.native = setTimeout(fire, first >= 0 ? first : t.ms, handle, gen);
    else if (first < 0) t.native = setInterval(fire, t.ms, handle, gen);
    else t.native = setTimeout(() => {
      fire(handle, gen);
      if (timers.get(handle) === t && t.gen === gen) t.native = setInterval(fire, t.ms, handle, gen);
    }, first);
  }
}

// A tick, from the worker or the stand-in. One cleared while its tick was
// already on the way finds nothing here and is dropped, so a cleared timer
// never runs, exactly as with clearTimeout; one from an arming since
// replaced, or landing while its timer is held, the same.
function fire(handle, gen) {
  const t = timers.get(handle);
  if (!t) return;
  if (gen !== undefined && gen !== t.gen) return;
  if (holding && !t.real) return;
  if (!t.every) timers.delete(handle);
  else t.due = performance.now() + t.ms;
  lastTick.ms = t.ms; lastTick.name = t.fn.name || '(anonymous)'; lastTick.at = performance.now();
  t.fn();
}

// ---------- the walk ----------

export function held() { return holding; }

export function walkAhead() {
  return walking ? Math.max(0, (virtualNow - performance.now()) / 1000) : 0;
}

export function hold() {
  if (holding) return;
  holding = true;
  frontier = performance.now();
  for (const [handle, t] of timers) {
    if (t.real) continue;
    t.gen++;   // a tick already on its way is stale
    if (worker) worker.postMessage([OP_CLEAR, handle, 0]);
    else { clearTimeout(t.native); t.native = 0; }
  }
}

export function walk(toMs) {
  if (!holding || walking) return 0;
  walking = true;
  let fired = 0;
  while (fired < WALK_MOST) {
    // The earliest held timer due by toMs; a tie goes to the one made
    // first, which is the one met first (insertion order, and an `every`
    // keeps its place when it is re-due).
    let best = null, at = 0;
    for (const [handle, t] of timers) {
      if (t.real || t.due > toMs + WALK_GRACE) continue;
      if (!best || t.due < best.due) { best = t; at = handle; }
    }
    if (!best) break;
    virtualNow = best.due;
    if (best.every) best.due += best.ms;
    else timers.delete(at);
    fired++;
    lastTick.ms = best.ms; lastTick.name = best.fn.name || '(anonymous)'; lastTick.at = performance.now();
    best.fn();
  }
  walking = false;
  if (toMs > frontier) frontier = toMs;
  return fired;
}

export function release() {
  if (!holding) return;
  holding = false;
  const now = performance.now();
  for (const [handle, t] of timers) {
    if (t.real) continue;
    arm(handle, t, Math.max(0, t.due - now));
  }
}

export function shift(ms) {
  frontier -= ms;
  const now = performance.now();
  for (const [handle, t] of timers) {
    if (t.real) continue;
    t.due -= ms;
    if (!holding) arm(handle, t, Math.max(0, t.due - now));
  }
}

// ---------- the clock ----------

// The timer that fired last: its period, its function's name and when it
// ran. Written in place, three stores a tick, and read only by Confetti's
// opt-in diagnostic (gpu/confetti.js, ?confdiag=1), which reports it beside a
// sudden loss of pieces to see whether a periodic job lines up with it.
export const lastTick = { ms: 0, name: '', at: -1 };

function clock() {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./ticker-worker.js', import.meta.url));
    worker.onmessage = e => { const d = e.data; if (Array.isArray(d)) fire(d[0], d[1]); else fire(d); };
    worker.onerror = e => { e.preventDefault(); fallBack(); };
  } catch (e) {
    worker = null;
  }
  return worker;
}

// The worker could not load (a missing file, a policy that refuses it), so
// the timers it was handed never started. Each one still pending is armed
// again on the page's own timers, counting from its own due, once, rather
// than a scheduler that never wakes. Held timers stay held; release arms
// them here like any other.
function fallBack() {
  if (!worker) return;
  try { worker.terminate(); } catch (e) {}
  worker = null;
  const now = performance.now();
  for (const [handle, t] of timers) {
    if (holding && !t.real) continue;
    arm(handle, t, Math.max(0, t.due - now));
  }
}
