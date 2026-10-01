// Dark-frame chores: the deferrable work that may allocate or stall (glyph
// rasterising, the settings write, the kaleidoscope's atlas build) waits for
// a moment when a stall would cost nothing anyone can see.
//
// Every frame's after-submit slot is idle main thread, but a stall there
// still makes the next frame miss its refresh, and the display then holds
// the frame just sent for one refresh more. Held over a lit frame that is an
// extra flash; held over a dark one it is a dark gap one refresh longer,
// which at 40 Hz nobody sees. So main.js hands choreRun whether this slot is
// such a dark slot (strobe.js darkSlot(): the frame just sent is dark, and
// when free-running the next one will be too; stopped, every slot is), and
// the chores run only then, round-robin, inside a shared budget.
//
// A pattern that is nearly all lit (a square wave at 90% duty, say) could
// otherwise starve them for good. So a chore that has not run for WAIT_CAP_MS
// runs anyway, on whatever slot comes next, with half the budget. That cap is
// also the worst delay any chore sees, which is what keeps the settings
// write and new glyphs prompt whatever the pattern.
//
// A chore is fn(budgetMs) -> more: do a bounded slice of work within
// budgetMs and return true while there is more to do. Chores are called on
// every eligible slot whether or not they said they had more, since new work
// (a glyph asked for, a save marked due) arrives without telling the
// scheduler; an idle chore's call is a cheap test and a return. The table is
// preallocated and walked by index, so a frame never allocates here.
//
// Asynchronous work that yields between slices (the kaleidoscope's atlas
// cleanup) can wait for a dark slot too, through choreYield(): a promise that
// the built-in 'resume' chore settles on the next eligible slot. Its
// continuation runs straight after the frame callback returns, still inside
// the same slot, so the pass that settles one ends there and leaves it the
// rest of the slot. When no frame loop is pumping chores (before the first
// frame, or never, outside v1) choreYield falls back to a zero timeout. A
// waiter parked just before the tab hides simply waits for it to show again,
// as a hidden tab's timers all but stop anyway.

const MAX_CHORES = 8;
export const CHORE_BUDGET_MS = 1.5;
export const WAIT_CAP_MS = 250;
// How long without a pump before choreYield stops trusting the loop to
// come back and uses a plain timeout instead.
const STALE_MS = 100;

const names = new Array(MAX_CHORES).fill('');
const fns = new Array(MAX_CHORES).fill(null);
const lastRan = new Float64Array(MAX_CHORES);
const runs = new Float64Array(MAX_CHORES);
const forcedRuns = new Float64Array(MAX_CHORES);
const more = new Uint8Array(MAX_CHORES);
let count = 0, next = 0;
let clock = null, lastPump = -Infinity;
// Set by the 'resume' chore when it settles a waiter (see choreYield).
let released = false;

// The clock the budget is measured on (platform.now), handed in by main.js
// so this file stays clear of the browser.
export function initChores(now) { clock = now; }

export function choreRegister(name, fn) {
  if (count >= MAX_CHORES) {
    console.warn('chores: table full, ' + name + ' runs never');
    return;
  }
  names[count] = name;
  fns[count] = fn;
  lastRan[count] = -Infinity;
  count++;
}

// Called once per frame, after the submit. t is the frame's rAF timestamp,
// dark says whether this slot is a safe one to stall in.
export function choreRun(t, dark) {
  if (count === 0 || !clock) return;
  lastPump = clock();
  const budget = dark ? CHORE_BUDGET_MS : CHORE_BUDGET_MS * 0.5;
  const start = lastPump;
  let k = 0;
  for (; k < count; k++) {
    const i = (next + k) % count;
    // a lit slot runs only the chores the cap says have waited long enough
    if (!dark && !(t - lastRan[i] >= WAIT_CAP_MS)) continue;
    const left = budget - (clock() - start);
    if (left <= 0) break;
    released = false;
    more[i] = fns[i](left) ? 1 : 0;
    lastRan[i] = t;
    runs[i]++;
    if (!dark) forcedRuns[i]++;
    if (released) { k++; break; }
  }
  // The next pass starts at the first chore this one did not reach, so a
  // chore the budget ran out before gets first claim next time.
  next = (next + k) % count;
}

// ---- waiting for a dark slot from async code ----
// Resolvers queued by choreYield. These are made while an atlas builds, a
// few dozen times per load, never per frame.
const waiters = [];
function resume() {
  if (waiters.length === 0) return false;
  waiters.shift()();
  released = true;
  return waiters.length > 0;
}
choreRegister('resume', resume);

function timeoutTick(r) { setTimeout(r, 0); }
function enqueue(r) { waiters.push(r); }
export function choreYield() {
  if (!clock || clock() - lastPump > STALE_MS) return new Promise(timeoutTick);
  return new Promise(enqueue);
}

// For the diagnostics text: each chore's runs, and how many of those the
// wait cap forced onto a lit slot. Runs on a click, so it may allocate.
export function choreSummary() {
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(names[i] + ' ' + runs[i] + (forcedRuns[i] ? ' (' + forcedRuns[i] + ' forced)' : '') + (more[i] ? ' busy' : ''));
  }
  return parts.join(', ') || 'none';
}
