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
// Handles are positive integers, so a caller's `if (!timer)` reads as it did
// with the browser's own. Where the worker cannot be made, or fails to load,
// the page's own setTimeout and setInterval stand in behind the same calls.
// Nothing is started until the first timer is asked for, so a module that
// imports this and never schedules (v1's engine worker, which has no sound)
// costs nothing.

const OP_AFTER = 0, OP_EVERY = 1, OP_CLEAR = 2;   // js/ticker-worker.js's ops

const timers = new Map();   // handle -> { fn, ms, every, native }
let nextHandle = 1;
// undefined until first asked for; null where the page's own timers stand in
let worker;

export function every(ms, fn) { return start(ms, fn, true); }
export function after(ms, fn) { return start(ms, fn, false); }

export function clear(handle) {
  const t = timers.get(handle);
  if (!t) return;
  timers.delete(handle);
  if (worker) worker.postMessage([OP_CLEAR, handle, 0]);
  else clearTimeout(t.native);   // clears an interval too, as both share one list
}

function start(ms, fn, every) {
  const handle = nextHandle++;
  const t = { fn, ms, every, native: 0 };
  timers.set(handle, t);
  arm(handle, t);
  return handle;
}

function arm(handle, t) {
  const w = clock();
  if (w) w.postMessage([t.every ? OP_EVERY : OP_AFTER, handle, t.ms]);
  else t.native = t.every ? setInterval(fire, t.ms, handle) : setTimeout(fire, t.ms, handle);
}

// A tick, from the worker or the stand-in. One cleared while its tick was
// already on the way finds nothing here and is dropped, so a cleared timer
// never runs, exactly as with clearTimeout.
function fire(handle) {
  const t = timers.get(handle);
  if (!t) return;
  if (!t.every) timers.delete(handle);
  t.fn();
}

function clock() {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./ticker-worker.js', import.meta.url));
    worker.onmessage = e => fire(e.data);
    worker.onerror = e => { e.preventDefault(); fallBack(); };
  } catch (e) {
    worker = null;
  }
  return worker;
}

// The worker could not load (a missing file, a policy that refuses it), so
// the timers it was handed never started. Each one still pending is armed
// again on the page's own timers, counting from now: a late first tick, once,
// rather than a scheduler that never wakes.
function fallBack() {
  if (!worker) return;
  try { worker.terminate(); } catch (e) {}
  worker = null;
  for (const [handle, t] of timers) arm(handle, t);
}
