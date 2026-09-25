// The page's side of worker mode (see core/engine-thread.js). main.js calls
// startWorkerShell first thing at boot. With the Engine thread control on
// Main (the default), or where this browser cannot do it, it only records
// that and returns false, and main.js boots the engine on the page as it
// always has. With it on Worker it hands the whole engine to a module worker
// (v1/worker-entry.js) drawing into this canvas through an OffscreenCanvas,
// keeps the page as a thin shell, and returns true.
//
// The shell is what cannot leave the page:
//
//   the canvas element itself, and its input: pointer, wheel and key events
//   are caught here with the same guards web.js applies (focus and pointer
//   capture on a press, Space and the arrows kept from scrolling, the
//   gesture and context-menu guards) and posted to the worker as plain
//   copies, which its platform feeds into the same pooled queue;
//   its size, visibility and fullscreen state, posted as they change;
//
//   the truth about the display, which a worker cannot see: the screen's
//   identity, read every frame and posted when it changes (the display
//   tripwire, js/display-watch.js), and this page's own frame cadence, a
//   second clock the worker checks its own measured refresh against;
//
//   the sound: core/audio-shell.js runs the v0 audio modules here exactly as
//   main mode does, steered by the calls and settings records the worker
//   sends, and this file gives it a frame loop of its own (the drift and the
//   meters) and posts back the readings it produces;
//
//   storage: the worker starts from a copy of localStorage, and every write
//   it makes comes back here to be stored (and replayed into the sound);
//   another tab's write is applied here and forwarded;
//
//   and the handful of requests only a page can carry out: the clipboard,
//   fullscreen, the cursor, the fatal message, the profiler's file save and
//   its observers, and the console handles (signalProfile, signalGuard),
//   which are mirrored on this window and answer with promises.
//
// Start-up is a handshake, so a worker that cannot run the engine costs
// nothing but a moment. The worker loads the whole engine and asks for a
// WebGPU adapter first; only when it reports ready is the canvas transferred,
// which cannot be undone. If it fails, times out or never loads, it is
// dropped, the Engine thread control reads 'unavailable', and main.js boots
// on the page as usual, untouched.

import {
  GUARDED_KEYS, canvasOwnsKeys, guardGestures, watchCanvasSize, clipboardWrite,
  toggleFullscreen, fsElement, showMessage, watchLongTasks
} from './web.js';
import { createProfileHost } from './profile-web.js';
import { getContext } from '../../js/audio.js';
import { ENGINE_THREAD_KEY, engineThread, initEngineThread } from '../core/engine-thread.js';
import { createAudioShell } from '../core/audio-shell.js';
import { display, displayListenScreen, displaySampleScreen } from '../../js/display-watch.js';

// Long enough for a cold load of every engine module over a slow link.
const READY_TIMEOUT_MS = 15000;

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

export async function startWorkerShell(canvas) {
  const wanted = read(ENGINE_THREAD_KEY) === '1' ? 'worker' : 'main';
  const capable = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
    !!canvas && typeof canvas.transferControlToOffscreen === 'function';
  initEngineThread('main', wanted, capable, v => write(ENGINE_THREAD_KEY, v));
  if (wanted !== 'worker' || !capable) return false;

  const longTasks = watchLongTasks();
  const env = () => ({ userAgent: navigator.userAgent, screenW: screen.width, screenH: screen.height,
                       longTasks: longTasks() });
  const cssW = canvas.clientWidth || window.innerWidth;
  const cssH = canvas.clientHeight || window.innerHeight;
  const dpr0 = window.devicePixelRatio || 1;
  const size0 = { w: cssW, h: cssH, pw: Math.max(1, Math.round(cssW * dpr0)), ph: Math.max(1, Math.round(cssH * dpr0)), dpr: dpr0 };

  const storage = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) storage[k] = localStorage.getItem(k);
    }
  } catch {}

  let worker = null;
  try {
    worker = new Worker(new URL('../worker-entry.js', import.meta.url), { type: 'module' });
  } catch (e) {
    return unavailable('could not start a module worker (' + (e && e.message || e) + ')');
  }

  let why = await new Promise(resolve => {
    const timer = setTimeout(() => done('it did not report ready in time'), READY_TIMEOUT_MS);
    function done(reason) {
      clearTimeout(timer);
      worker.onmessage = null; worker.onerror = null;
      resolve(reason);
    }
    worker.onmessage = e => {
      const d = e.data;
      if (d && d.k === 'ready') done('');
      else if (d && d.k === 'fail') done(d.why || 'it could not start the engine');
    };
    worker.onerror = e => { if (e && e.preventDefault) e.preventDefault(); done((e && e.message) || 'its script failed to load'); };
    let entryTypes = [];
    try { entryTypes = (PerformanceObserver.supportedEntryTypes || []).slice(); } catch {}
    worker.postMessage({ k: 'hello', init: {
      storage, baseURI: document.baseURI, width: cssW, height: cssH, dpr: dpr0,
      hidden: document.hidden, fullscreen: !!fsElement(), env: env(), entryTypes,
      display: readDisplay()
    } });
  });
  // The sound's shell is made before the canvas goes over, so that if it
  // fails the page still has its canvas and boots on the main thread.
  let shell = null;
  if (!why) {
    try { shell = createAudioShell({ get: read }); }
    catch (e) { why = 'the page could not start its audio shell (' + (e && e.message || e) + ')'; }
  }
  if (why) {
    try { worker.terminate(); } catch {}
    return unavailable(why);
  }

  runShell(canvas, worker, shell, size0, env);
  return true;
}

// The screen's identity as a message body, read fresh. Used at hello and on
// each change, never per frame.
function readDisplay() {
  displaySampleScreen();
  return { w: display.w, h: display.h, dpr: display.dpr, left: display.left, top: display.top, gen: display.gen };
}

function unavailable(why) {
  engineThread.available = false;
  console.warn('[engine] the engine worker is unavailable here, running on the main thread: ' + why);
  return false;
}

function runShell(canvas, worker, shell, size0, env) {
  const off = canvas.transferControlToOffscreen();
  worker.postMessage({ k: 'canvas', canvas: off, size: size0 }, [off]);
  const send = msg => worker.postMessage(msg);

  // ---------- input ----------
  // Copies with the DOM event's own field names, which is what the worker's
  // input queue reads; times go on the absolute clock so the worker can move
  // them onto its own.
  const T0 = performance.timeOrigin;
  const pointerCopy = e => ({
    clientX: e.clientX, clientY: e.clientY, button: e.button, pointerId: e.pointerId,
    pointerType: e.pointerType, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey,
    metaKey: e.metaKey, timeStamp: e.timeStamp + T0
  });
  const keyCopy = e => ({
    key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey,
    metaKey: e.metaKey, timeStamp: e.timeStamp + T0
  });

  canvas.addEventListener('pointerdown', e => {
    canvas.focus();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    // The first gesture wakes the sound here, inside the gesture itself.
    shell.wake();
    send({ k: 'in', t: 'down', e: pointerCopy(e) });
  });
  canvas.addEventListener('pointermove', e => send({ k: 'in', t: 'move', e: pointerCopy(e) }));
  canvas.addEventListener('pointerup', e => send({ k: 'in', t: 'up', e: pointerCopy(e) }));
  canvas.addEventListener('pointercancel', e => send({ k: 'in', t: 'cancel', e: pointerCopy(e) }));
  canvas.addEventListener('pointerleave', e => send({ k: 'in', t: 'leave', e: pointerCopy(e) }));
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const c = pointerCopy(e);
    c.deltaX = e.deltaX; c.deltaY = e.deltaY; c.deltaMode = e.deltaMode;
    send({ k: 'in', t: 'wheel', e: c });
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (!canvasOwnsKeys(canvas)) return;
    if (!e.metaKey && !e.ctrlKey && GUARDED_KEYS.has(e.code)) e.preventDefault();
    shell.wake();
    send({ k: 'in', t: 'key', e: keyCopy(e) });
  });
  window.addEventListener('keyup', e => {
    if (!canvasOwnsKeys(canvas)) return;
    send({ k: 'in', t: 'keyup', e: keyCopy(e) });
  });
  guardGestures(canvas);

  // ---------- size, visibility, fullscreen ----------
  watchCanvasSize(canvas, (pxW, pxH, dpr, w, h) => send({
    k: 'size', w, h, pw: Math.max(1, Math.round(pxW)), ph: Math.max(1, Math.round(pxH)), dpr
  }));
  document.addEventListener('visibilitychange', () => send({ k: 'vis', visible: !document.hidden }));
  const fsChanged = () => send({ k: 'fs', active: !!fsElement() });
  document.addEventListener('fullscreenchange', fsChanged);
  document.addEventListener('webkitfullscreenchange', fsChanged);

  // ---------- another tab's writes ----------
  // Applied to the sound here and to the engine's copy in the worker.
  window.addEventListener('storage', e => {
    let local = true;
    try { local = e.storageArea === localStorage; } catch {}
    if (!local) return;
    if (e.key !== null) shell.storageChanged(e.key, e.newValue);
    send({ k: 'storage', key: e.key, value: e.newValue });
  });

  // ---------- the profiler's page half, and the console ----------
  const profHost = createProfileHost();
  let observers = null;
  const profSink = {
    loaf: o => send({ k: 'prof', kind: 'loaf', o }),
    longtask: o => send({ k: 'prof', kind: 'longtask', o }),
    event: o => send({ k: 'prof', kind: 'event', o }),
    note: (kind, detail) => send({ k: 'prof', kind: 'note', note: kind, detail: String(detail) })
  };
  let callSeq = 0;
  const calls = new Map();
  function consoleCall(name, member, args) {
    return new Promise((resolve, reject) => {
      const id = ++callSeq;
      calls.set(id, { resolve, reject });
      try { send({ k: 'call', id, name, member, args }); }
      catch (e) { calls.delete(id); reject(e); }
    });
  }
  function exposeProxy(d) {
    const api = {};
    for (const m of d.methods) api[m] = (...args) => consoleCall(d.name, m, args);
    for (const g of d.getters) Object.defineProperty(api, g, { get: () => consoleCall(d.name, g, null), enumerable: true });
    profHost.expose(d.name, api);
  }
  const reply = (id, ok, error) => send({ k: 'done', id, ok, error: error || '' });
  // The profiler's report reads the AudioContext itself, which in worker mode
  // lives here, so the page's audio facts ride along with its system facts.
  function sysInfo() {
    const c = getContext();
    const pageAudio = !c ? { context: 'not created yet' } : {
      state: c.state, sampleRate: c.sampleRate,
      baseLatencyMs: typeof c.baseLatency === 'number' ? Math.round(c.baseLatency * 100000) / 100 : null,
      outputLatencyMs: typeof c.outputLatency === 'number' ? Math.round(c.outputLatency * 100000) / 100 : null
    };
    return Object.assign(profHost.sysInfo(), { pageAudio });
  }

  // ---------- from the worker ----------
  worker.onmessage = e => {
    const d = e.data;
    // The audio link's calls travel as a bare array.
    if (Array.isArray(d)) { shell.runCalls(d); return; }
    switch (d.k) {
      case 'store':
        write(d.key, d.value);
        shell.storageChanged(d.key, d.value);
        break;
      case 'cursor': canvas.style.cursor = d.kind; break;
      case 'clip':
        clipboardWrite(d.text).then(() => reply(d.id, true), err => reply(d.id, false, err && err.message));
        break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'message':
        // An engine that never drew a frame puts the choice back to the main
        // thread, so the next load does not end up here again.
        if (!d.booted) write(ENGINE_THREAD_KEY, '0');
        showMessage(d.text);
        break;
      case 'env?': send({ k: 'env', env: env() }); break;
      case 'sys?':
        profHost.requestHints();
        send({ k: 'sys', sys: sysInfo() });
        // the client hints arrive a moment later; send the facts again with them
        setTimeout(() => send({ k: 'sys', sys: sysInfo() }), 300);
        break;
      case 'observe':
        if (d.on && !observers) observers = profHost.observe(profSink, getContext());
        else if (!d.on && observers) { observers.stop(); observers = null; }
        break;
      case 'download': profHost.download(d.filename, d.text); break;
      case 'expose': exposeProxy(d); break;
      case 'ret': {
        const c = calls.get(d.id);
        if (!c) break;
        calls.delete(d.id);
        if (d.ok) c.resolve(d.value); else c.reject(new Error(d.error));
        break;
      }
    }
  };
  // An uncaught error inside the worker does not stop it (the frame loop
  // asks for its next frame before running each one, as on the page); the
  // worker's own console already shows it, so nothing more is done here.

  // ---------- the display tripwire and the second clock ----------
  // A worker's frame callbacks can go on arriving at the old display's rate
  // after the window moves to another (macOS does this), and the worker has
  // no screen to look at. This page's callbacks follow the window, so the
  // page watches for it. The screen's identity is read every frame and posted
  // the moment it changes; the worker then pauses and starts measuring again.
  // And the page times its own frames, a rolling window of the last sixty
  // intervals whose median goes over about once a second, for the worker to
  // hold its own measured refresh against (js/display-watch.js clockCheck).
  // The window and its sorting scratch are allocated once; a frame costs a
  // few property reads and a store. The median, and the message it rides in,
  // happen once a second.
  displayListenScreen();
  send({ k: 'display', w: display.w, h: display.h, dpr: display.dpr, left: display.left, top: display.top, gen: display.gen });
  const CLOCK_N = 60;
  const iv = new Float64Array(CLOCK_N), ivSorted = new Float64Array(CLOCK_N);
  let ivN = 0, ivI = 0, lastLoopT = -1, lastClockT = -1;
  function pageClock(t) {
    const d = lastLoopT < 0 ? 0 : t - lastLoopT;
    lastLoopT = t;
    if (d > 0 && d < 250) {
      iv[ivI] = d; ivI = (ivI + 1) % CLOCK_N;
      if (ivN < CLOCK_N) ivN++;
    }
    if (ivN < CLOCK_N || (lastClockT >= 0 && t - lastClockT < 1000)) return;
    lastClockT = t;
    ivSorted.set(iv);
    ivSorted.sort();
    const med = (ivSorted[CLOCK_N / 2 - 1] + ivSorted[CLOCK_N / 2]) / 2;
    if (med > 0) send({ k: 'clock', hz: 1000 / med });
  }

  // ---------- the sound's frame loop ----------
  // The strobe's frames are the worker's now; this loop steps the
  // atmosphere's drift and meters and posts the readings back, and carries
  // the tripwire and the second clock above. Like the engine's, it stops
  // while the page is hidden, so the page's clock goes quiet and the worker
  // stops judging by it.
  function loop(t) {
    requestAnimationFrame(loop);
    if (displaySampleScreen()) {
      // the old screen's intervals describe the old screen
      ivN = 0; ivI = 0; lastClockT = -1;
      send({ k: 'display', w: display.w, h: display.h, dpr: display.dpr, left: display.left, top: display.top, gen: display.gen });
    }
    pageClock(t);
    const m = shell.tick(t);
    if (m) worker.postMessage(m);
  }
  requestAnimationFrame(loop);

  try { canvas.focus({ preventScroll: true }); } catch (e) {}
}
