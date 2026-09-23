// The main thread's half of the strobe worker.
//
// Off by default. With the flag unset nothing in this file does anything, and
// every export is a cheap no-op, so the main-thread path runs exactly as it
// always has. To try it:
//
//   localStorage.setItem('signal_worker', '1')   then reload
//   localStorage.removeItem('signal_worker')     then reload, to go back
//
// When it is on, the worker owns phase, the frame lock, the simulation and the
// draw. This side keeps everything else, and its job is two small currents:
// settings flow out as snapshots whenever one changes, and three numbers per
// frame flow back so that the word layer and the audio's AM link keep reading
// S.phase, S.lastPhase, S.rgb and S.effFreq as though nothing had moved.
import { S, layers } from './state.js';
import { $, cv } from './dom.js';

const FLAG = 'signal_worker';
// The drawer's Strobe thread buttons read and write the same key, so the two
// can never drift apart over a typo.
export const WORKER_FLAG = FLAG;

let worker = null;          // set only once the worker has taken the canvas
let note = '';

export const strobeInWorker = () => worker !== null;
// Appended to the renderer name when the flag was asked for but could not be
// honoured, so a silent fallback is still visible in the drawer.
export const strobeNote = () => note;

// Everything the worker's tick, sim.js and canvas2d.js read from S that the UI
// can change. The rest of what they read is state the worker produces itself
// (phases, accumulators, rings, particles, the walked hue) and must never be
// overwritten from here. The list follows saveSettings' own enumeration,
// filtered to what the strobe touches, plus the geometry saveSettings never
// needed to store.
const SYNC_KEYS = [
  'freq', 'depth', 'bright', 'wave', 'fieldShape', 'running', 'frameLock', 'spareMode',
  'freqDrift', 'driftPeriod',
  'depthVar', 'varPeriod', 'brightVar', 'brightVarPeriod',
  'ringBrightVar', 'ringBrightPeriod',
  'edgeSpeedVar', 'edgeSpeedVarPeriod', 'edgeSizeVar', 'edgeSizeVarPeriod',
  'ringSpeedMul', 'ringFade', 'ringThick', 'ringThickVar',
  'edgeCount', 'edgeSize', 'trailMul', 'edgeSpeedMul', 'edgeDir',
  'colorWalk', 'colorMode', 'perElementColor', 'hueSat', 'hueLight',
  'hueLo', 'hueSpan', 'walkPeriod',
  'W', 'H', 'DPR', 'edgeInset'
];

// The hue belongs to whoever last changed it. While the walk runs, that is the
// worker, and its colour comes back every frame; the only time this side has
// something newer is right after the picker or a preset has written S.rgb. So
// the colour is sent only when S.rgb disagrees with what the worker last
// reported, and otherwise left alone. Sending it every time would snap the
// walk back a frame on every slider move.
let reportedRgb = -1;
const packRgb = () => (S.rgb[0] << 16) | (S.rgb[1] << 8) | S.rgb[2];

function snapshot(full) {
  const s = {};
  for (const k of SYNC_KEYS) s[k] = S[k];
  s.layers = { ...layers };
  const packed = packRgb();
  if (full || packed !== reportedRgb) {
    s.rgb = [S.rgb[0], S.rgb[1], S.rgb[2]];
    s.hue = S.hue;
    reportedRgb = packed;
  }
  return s;
}

// Called from saveSettings, from resize and from the start/stop toggle, which
// between them are every place the strobe's inputs change. Posting a flat
// object of forty numbers is far cheaper than the JSON.stringify and
// localStorage write that saveSettings was already doing at the same moment.
export function syncWorker() {
  if (worker) worker.postMessage({ t: 'state', state: snapshot(false) });
}

// The drawer inset changes on every frame of the panel animation and nothing
// else changes with it, so it gets its own one-number message instead of a
// full snapshot at 120 Hz.
export function syncWorkerInset() {
  if (worker) worker.postMessage({ t: 'inset', edgeInset: S.edgeInset });
}

function onMessage(e) {
  const m = e.data;
  if (m.t === 'frame') {
    // Written into the objects that are already there, so the text layer and
    // the readouts see the worker's clock through the same fields as before.
    S.lastPhase = m.lastPhase;
    S.phase = m.phase;
    S.effFreq = m.effFreq;
    reportedRgb = m.rgb;
    S.rgb[0] = (m.rgb >> 16) & 255; S.rgb[1] = (m.rgb >> 8) & 255; S.rgb[2] = m.rgb & 255;
  } else if (m.t === 'diag') {
    S.refreshHz = m.refreshHz;
    S.dropCount = m.dropCount;
    S.duty = m.duty;
    S.achievedFreq = m.achievedFreq;
    S.framesPerCycle = m.framesPerCycle;
    S.intervals = m.intervals;
    S.litLog = m.litLog;
  } else if (m.t === 'started') {
    $('rendName').textContent = (m.name || 'none available') + ' (worker)';
  }
}

// Returns through `done(true)` once the worker owns the canvas, or `done(false)`
// if the flag is off or anything stood in the way, in which case the caller
// starts the ordinary main-thread renderer and nothing has been lost.
//
// The canvas is not handed over until the worker has said hello. A module
// worker that fails to load or parse reports that asynchronously, and
// transferControlToOffscreen cannot be undone: a canvas given away on the
// optimistic assumption would leave the fallback with nothing to draw on.
export function startStrobeWorker(done) {
  let want = false;
  try { want = localStorage.getItem(FLAG) === '1'; } catch {}
  if (!want) { done(false); return; }
  // The worker only knows how to draw Canvas2D. With a GPU renderer chosen,
  // that choice wins and the strobe stays on the main thread, said out loud
  // in the renderer readout rather than silently ignored.
  if (S.rendererPref !== 'canvas2d') {
    note = ' (worker needs Canvas2D)';
    done(false); return;
  }

  const fail = why => {
    console.warn('strobe worker unavailable, drawing on the main thread:', why);
    note = ' (worker unavailable)';
    done(false);
  };
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' ||
      typeof cv.transferControlToOffscreen !== 'function') {
    fail('no OffscreenCanvas transfer'); return;
  }

  let w;
  try { w = new Worker(new URL('./strobe-worker.js', import.meta.url), { type: 'module' }); }
  catch (err) { fail(err); return; }

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true; w.terminate(); fail('no answer from the worker');
  }, 3000);
  w.onerror = err => {
    if (settled) { console.error('strobe worker error:', err.message || err); return; }
    settled = true; clearTimeout(timer); w.terminate(); fail(err.message || 'failed to load');
  };
  w.onmessage = e => {
    if (settled || e.data?.t !== 'hello') return;
    settled = true; clearTimeout(timer);
    let off;
    try { off = cv.transferControlToOffscreen(); }
    catch (err) { w.terminate(); fail(err); return; }
    worker = w;
    worker.onmessage = onMessage;
    worker.postMessage({ t: 'init', canvas: off, state: snapshot(true) }, [off]);
    done(true);
  };
}
