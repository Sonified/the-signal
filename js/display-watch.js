// The display tripwire and the second clock: two checks that stop the strobe
// when the app can no longer be sure which screen it is on, or how fast that
// screen refreshes.
//
// Everything that keeps the strobe safe (the frame lock, the panel guard's
// polarity maths) starts from one number, the refresh rate, and that number is
// worked out from the requestAnimationFrame cadence. That cadence is not
// always the truth. Dragged from a 120 Hz built-in panel to a 60 Hz external
// one, a window's frame callbacks on macOS can keep arriving at the old rate
// for a while, and a worker's callbacks driving an OffscreenCanvas can keep
// doing so indefinitely. The guard then sees a balanced 40 Hz at 120 while the
// real 60 Hz panel shows every other frame of the 1-0-0 pattern, a 20 Hz
// strobe in the photosensitive band, possibly leaning on one polarity where no
// integrator can see it. That happened once. These two checks make sure it
// can never happen silently again.
//
// The tripwire. Every frame the page reads the screen's identity (its size,
// the device pixel ratio, where its usable area sits on the desktop, and a
// count of the browser's own screen change events) and compares it with the
// last frame's. Any difference at all means the window may be on a different
// panel, so the surface pauses exactly as a panel guard trip does, shows
// DISPLAY_CHANGED, and throws away every refresh measurement and the guard's
// integrators, so the next start measures the new display from zero. A
// browser zoom changes the pixel ratio and trips it too, which is the right
// side to err on.
//
// The second clock (v1's worker mode only). The engine's frames come from the
// worker's callbacks, the very clock that can go stale, so the page's shell,
// whose callbacks follow the window, measures its own cadence (a rolling
// median over sixty intervals) and posts it across about once a second. The
// worker compares the two. While they disagree by more than CLOCK_TOL the
// guard is told to trust the slower one, and if they go on disagreeing for
// CLOCK_HOLD_MS while the strobe runs, the surface pauses with the message
// from clockMessage(). Nothing trips while the page is hidden (its callbacks
// stop, so its clock goes stale), nor in the first CLOCK_GRACE_MS after a
// start or a display change, while both measurements are still settling.
//
// Pure logic over plain numbers, like js/panel-guard.js, apart from
// displaySampleScreen and displayListenScreen, which read the real screen and
// are only ever called on a page (v0's js/main.js, v1's platform files). Every
// per-frame function here allocates nothing.

// The two clocks may differ by this fraction of the slower before they are
// said to disagree. A dropped frame in the engine's sixty-frame window reads
// under 2% slow, and every real mismatch between common panels (60, 90, 100,
// 120, 144, 165) is at least a fifth apart, so 15% separates the two cleanly.
export const CLOCK_TOL = 0.15;
// How long a disagreement must last, continuously, before the strobe stops.
export const CLOCK_HOLD_MS = 2000;
// No verdict this soon after a start or a display change.
export const CLOCK_GRACE_MS = 2000;
// The page's reading counts only while it is this fresh; it arrives about
// once a second while the page is visible, and not at all while it is hidden.
const CLOCK_STALE_MS = 2500;

// Live state, read by diagnostics. Written in place only.
export const display = {
  w: 0, h: 0, dpr: 0, left: 0, top: 0, gen: 0,   // the screen, as last read
  known: false,        // an identity has been read at all
  changes: 0,          // changes seen this session
  pageHz: 0,           // the page's own frame cadence (worker mode), 0 when unknown
  engineHz: 0,         // the engine's measured refresh at the last check
  trustHz: 0,          // > 0 while the clocks disagree: the slower one, for the guard
  conflicts: 0,        // clock-conflict pauses this session
  tripEngineHz: 0, tripPageHz: 0
};

// ---------- the tripwire ----------

// Record the screen's identity. True when it differs from the last one
// recorded; the very first call only sets the baseline and answers false.
export function displayUpdate(w, h, dpr, left, top, gen) {
  if (!display.known) {
    display.known = true;
    display.w = w; display.h = h; display.dpr = dpr;
    display.left = left; display.top = top; display.gen = gen;
    return false;
  }
  if (w === display.w && h === display.h && dpr === display.dpr &&
      left === display.left && top === display.top && gen === display.gen) return false;
  display.w = w; display.h = h; display.dpr = dpr;
  display.left = left; display.top = top; display.gen = gen;
  display.changes++;
  return true;
}

// Page side only. Counts the browser's own screen change events (Chrome fires
// one on window.screen when its attributes change), so a change the polled
// numbers happen to miss still registers. Call once.
let screenGen = 0;
export function displayListenScreen() {
  try {
    if (typeof screen !== 'undefined' && screen && typeof screen.addEventListener === 'function') {
      screen.addEventListener('change', () => { screenGen++; });
    }
  } catch {}
}

// Page side only. Reads the real screen and records it; true on a change.
// availLeft and availTop are Chrome's, and are where this screen's usable
// area sits on the whole desktop, so they tell two identical panels apart.
// Property reads only, nothing allocated.
export function displaySampleScreen() {
  if (typeof screen === 'undefined' || !screen) return false;
  const s = screen;
  const dpr = globalThis.devicePixelRatio || 1;
  return displayUpdate(s.width, s.height, dpr, +s.availLeft || 0, +s.availTop || 0, screenGen);
}

// ---------- the second clock ----------

let pageAt = -1;          // when the page's reading arrived, on the engine's clock
let changeT = -1;         // when the last display change was acted on
let startT = -1, wasRunning = false, lastT = -1, overMs = 0, tripped = false;

// The page's cadence, as it arrives (worker mode), stamped with `now` on the
// engine thread's clock.
export function displayPageClock(hz, now) {
  display.pageHz = hz > 0 ? hz : 0;
  pageAt = display.pageHz ? now : -1;
}

// A display change was acted on at `t`: the page's old reading describes the
// old screen, and the grace period starts again.
export function displayChanged(t) {
  display.pageHz = 0; pageAt = -1;
  display.trustHz = 0;
  changeT = t; overMs = 0;
}

// Once per frame in worker mode, after the engine's refresh has been measured
// and before the panel guard runs. Keeps display.trustHz current and answers
// true on the one frame a disagreement has lasted CLOCK_HOLD_MS.
export function clockCheck(t, engineHz, running, visible) {
  const dt = lastT < 0 ? 0 : t - lastT;
  lastT = t;
  display.engineHz = engineHz;

  const pageHz = display.pageHz;
  const fresh = pageAt >= 0 && t - pageAt < CLOCK_STALE_MS && pageHz > 0;
  const lo = engineHz < pageHz ? engineHz : pageHz;
  const apart = fresh && engineHz > 0 && Math.abs(engineHz - pageHz) > CLOCK_TOL * lo;
  display.trustHz = apart ? lo : 0;

  if (!running) { wasRunning = false; overMs = 0; tripped = false; return false; }
  if (!wasRunning) { wasRunning = true; startT = t; overMs = 0; tripped = false; }
  if (tripped) return false;
  const settling = t - startT < CLOCK_GRACE_MS || (changeT >= 0 && t - changeT < CLOCK_GRACE_MS);
  if (!apart || !visible || settling || dt > 250) { overMs = 0; return false; }
  overMs += dt;
  if (overMs <= CLOCK_HOLD_MS) return false;
  tripped = true;
  display.conflicts++;
  display.tripEngineHz = engineHz;
  display.tripPageHz = pageHz;
  return true;
}

// ---------- the messages ----------
// Shaped like panel-guard.js's guardMessage(), so each surface shows them in
// the same card.

export const DISPLAY_CHANGED = {
  title: 'Paused: the display changed',
  body: 'Different screens refresh differently, and this strobe must be re-checked. Press start to continue.',
  note: ''
};

// Built once, on the frame that trips.
export function clockMessage() {
  return {
    title: 'Paused: the display\'s real refresh rate can\'t be confirmed',
    body: 'The strobe\'s clock reads ' + Math.round(display.tripEngineHz) + ' Hz and the window\'s reads ' +
      Math.round(display.tripPageHz) + ' Hz, so there is no way to be sure what this screen is showing. ' +
      'Press start to measure again.',
    note: 'If this keeps happening, set Render > Engine thread to Main.'
  };
}

// One line for diagnostics: both clocks and the screen as last read.
export function displaySummary(engineHz, worker) {
  const f = x => (x > 0 ? x.toFixed(2) + ' Hz' : '-');
  const id = display.known
    ? display.w + ' x ' + display.h + ' @ DPR ' + display.dpr + ', at ' + display.left + ',' + display.top
    : 'not read yet';
  return 'engine ' + f(engineHz) + ', page ' + (worker ? f(display.pageHz) : '(same thread)') +
    (display.trustHz ? ', guard trusting ' + f(display.trustHz) : '') +
    '  screen ' + id + '  (' + display.changes + ' change' + (display.changes === 1 ? '' : 's') +
    (display.conflicts ? ', ' + display.conflicts + ' clock pause' + (display.conflicts === 1 ? '' : 's') : '') + ')';
}
