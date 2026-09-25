// The platform inside the engine worker (worker mode, see
// core/engine-thread.js): the same Platform object platform/web.js builds,
// member for member, so main.js and everything under it run unchanged. The
// difference is where the facts come from. A worker has no document, no
// window and no localStorage, so the page's shell (platform/worker-bridge.js)
// posts them across and this file turns each message back into what web.js
// would have produced:
//
//   input arrives as plain copies of the DOM events and goes into the same
//   pooled queue web.js fills (input-queue.js), so the engine sees identical
//   InputEvents; their timeStamps are moved onto this thread's clock;
//
//   the canvas is an OffscreenCanvas the page transferred, sized from the
//   page's own ResizeObserver readings;
//
//   storage is a copy of the page's localStorage taken at start, kept current
//   with this worker's own writes and other tabs' (forwarded), and every
//   write is posted back for the page to store;
//
//   the clipboard, fullscreen, the cursor and the fatal message are requests
//   the page carries out; images are decoded here, against the page's base
//   URL (v1/index.html sets it to the repo root);
//
//   the screen's identity, which a worker cannot read, arrives whenever the
//   page sees it change, and pollDisplay() reports that once, on the next
//   frame, just as web.js's reports its own reading; the page's frame
//   cadence arrives about once a second for the second clock
//   (js/display-watch.js).
//
// createWorkerPlatform also builds the profiler's host (the worker twin of
// platform/profile-web.js). Its observers run on the page, where the
// browser's performance entries are, and arrive here as notes; the console
// handles it exposes are mirrored on the page's window by the bridge, so
// signalProfile and signalGuard work from the page's console too.
//
// post(msg, transfer) posts to the page. The worker's entry module routes
// every message from the page to handle().

import { createInputQueue } from './input-queue.js';
import { loadImagePixels } from './web.js';
import { displayUpdate, displayPageClock } from '../../js/display-watch.js';

export function createWorkerPlatform(init, post) {
  const resizeCbs = [], visCbs = [], storageCbs = [];
  const q = createInputQueue();

  // The page reports event times on the shared absolute clock (its time
  // origin plus the event's timeStamp); this thread's performance.now()
  // counts from its own origin.
  const originShift = performance.timeOrigin;

  // ---------- storage ----------
  const store = new Map();
  for (const k in init.storage) store.set(k, init.storage[k]);
  let beforeWrite = null;
  function storageGet(key) {
    return store.has(key) ? store.get(key) : null;
  }
  function storageSet(key, value) {
    value = String(value);
    store.set(key, value);
    // Whatever the audio link has not yet sent goes first, so the page never
    // replays a record that already holds a move it has not heard about.
    if (beforeWrite) beforeWrite();
    post({ k: 'store', key, value });
  }

  // ---------- requests the page answers ----------
  let seq = 0;
  const pending = new Map();
  function request(msg) {
    return new Promise((resolve, reject) => {
      msg.id = ++seq;
      pending.set(msg.id, { resolve, reject });
      post(msg);
    });
  }
  function settle(d) {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) p.resolve(d.value); else p.reject(new Error(d.error || 'failed on the page'));
  }

  let fsActive = !!init.fullscreen;
  let visible = !init.hidden;
  let envCache = init.env || {};
  let sysCache = init.sys || null;
  let lastCursor = '';
  let framesStarted = false;
  // The screen as the page read it at hello is the baseline; a later report
  // that differs from it leaves a change for pollDisplay to hand over.
  let displayPending = false;
  const d0 = init.display;
  if (d0) displayUpdate(d0.w, d0.h, d0.dpr, d0.left, d0.top, d0.gen);

  const platform = {
    canvas: null,
    // The page's host facts, as of its last report (they are refreshed on
    // every call, for the next one), stamped with this moment and this thread.
    env: () => {
      post({ k: 'env?' });
      return Object.assign({}, envCache, { nowISO: new Date().toISOString(), frameSource: 'worker' });
    },
    dpr: init.dpr || 1, width: init.width || 0, height: init.height || 0,
    onResize(fn) { resizeCbs.push(fn); },
    pollInput() { framesStarted = true; return q.pollInput(); },
    pollDisplay() {
      if (!displayPending) return false;
      displayPending = false;
      return true;
    },
    now: () => performance.now(),
    setCursor(kind) {
      if (kind === lastCursor) return;
      lastCursor = kind;
      post({ k: 'cursor', kind });
    },
    storage: { get: storageGet, set: storageSet },
    onStorage(fn) { storageCbs.push(fn); },
    clipboardWrite: text => request({ k: 'clip', text }),
    onVisibility(fn) { visCbs.push(fn); },
    fullscreen: {
      toggle() { post({ k: 'fullscreen' }); return true; },
      active: () => fsActive
    },
    // Before the first frame, a fatal message means this engine never
    // started; the page then also puts the choice back to the main thread,
    // so a reload cannot land in the same dead end.
    message: text => post({ k: 'message', text, booted: framesStarted }),
    loadImagePixels: url => loadImagePixels(new URL(url, init.baseURI).href)
  };

  function applySize(d) {
    const c = platform.canvas;
    if (c && (c.width !== d.pw || c.height !== d.ph)) { c.width = d.pw; c.height = d.ph; }
    platform.dpr = d.dpr;
    platform.width = d.w;
    platform.height = d.h;
    for (let i = 0; i < resizeCbs.length; i++) resizeCbs[i](d.w, d.h, d.dpr);
  }

  // ---------- the profiler's host ----------
  const perf = performance;
  const heapSupported = !!(perf.memory && typeof perf.memory.usedJSHeapSize === 'number');
  const pageTypes = init.entryTypes || [];
  let sink = null;
  const exposed = new Map();

  const profileHost = {
    heapSupported,
    readHeap(out) {
      if (!heapSupported) { out[0] = -1; out[1] = -1; return; }
      const m = perf.memory;
      out[0] = m.usedJSHeapSize;
      out[1] = m.totalJSHeapSize;
    },
    // The page's system facts (screen, window, client hints) are asked for
    // when a recording starts and are there by the time its report is built.
    requestHints() { post({ k: 'sys?' }); },
    sysInfo: () => Object.assign({}, sysCache || {}, { engineThread: 'worker' }),
    // The page runs the observers and its window listeners and posts each
    // entry here; this thread's own console warnings and errors are caught
    // here, as profile-web.js does on the page.
    observe(s, audioCtx) {
      sink = s;
      post({ k: 'observe', on: true });
      const onError = e => s.note('error', (e.message || 'error') + (e.filename ? ' at ' + e.filename + ':' + e.lineno : '') + ' (worker)');
      const onRejection = e => { const r = e.reason; s.note('unhandledrejection', (r && r.message ? r.message : String(r)) + ' (worker)'); };
      self.addEventListener('error', onError);
      self.addEventListener('unhandledrejection', onRejection);
      const ce = console.error, cw = console.warn;
      console.error = function () { try { s.note('console.error', fmtArgs(arguments)); } catch {} return ce.apply(console, arguments); };
      console.warn = function () { try { s.note('console.warn', fmtArgs(arguments)); } catch {} return cw.apply(console, arguments); };
      return {
        has: {
          loaf: pageTypes.includes('long-animation-frame'),
          longtask: pageTypes.includes('longtask'),
          event: pageTypes.includes('event')
        },
        stop() {
          post({ k: 'observe', on: false });
          self.removeEventListener('error', onError);
          self.removeEventListener('unhandledrejection', onRejection);
          console.error = ce; console.warn = cw;
          sink = null;
        }
      };
    },
    download(filename, text) { post({ k: 'download', filename, text }); },
    // Set on this worker's global, and mirrored on the page's window: each
    // method there forwards its call here and answers with a promise.
    expose(name, api) {
      try { self[name] = api; } catch {}
      exposed.set(name, api);
      const methods = [], getters = [];
      const desc = Object.getOwnPropertyDescriptors(api);
      for (const key in desc) {
        if (typeof desc[key].value === 'function') methods.push(key);
        else getters.push(key);
      }
      post({ k: 'expose', name, methods, getters });
    },
    after: (ms, fn) => setTimeout(fn, ms),
    hidden: () => !visible,
    now: () => performance.now(),
    nowISO: () => new Date().toISOString()
  };

  function fmtArgs(args) {
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      parts.push(a && a.message ? a.message : typeof a === 'object' ? safeJson(a) : String(a));
    }
    return parts.join(' ').slice(0, 500);
  }
  function safeJson(o) { try { return JSON.stringify(o); } catch { return String(o); } }

  // A console call made on the page, run here; the answer goes back as a
  // structured clone, or as text when it will not clone.
  async function consoleCall(d) {
    let ok = true, value;
    try {
      const api = exposed.get(d.name);
      if (!api) throw new Error(d.name + ' is not available');
      const m = api[d.member];
      value = typeof m === 'function' ? await m.apply(api, d.args || []) : m;
    } catch (e) { ok = false; value = e && e.message ? e.message : String(e); }
    try { post({ k: 'ret', id: d.id, ok, value, error: ok ? '' : value }); }
    catch (e) { post({ k: 'ret', id: d.id, ok, value: String(value), error: ok ? '' : String(value) }); }
  }

  // ---------- messages from the page ----------
  function handle(d) {
    switch (d.k) {
      case 'in': {
        const e = d.e;
        e.timeStamp -= originShift;
        const t = d.t;
        if (t === 'wheel') q.wheel(e, platform.width, platform.height);
        else if (t === 'key' || t === 'keyup') q.key(t, e);
        else q.pointer(t, e);
        break;
      }
      case 'size': applySize(d); break;
      case 'vis':
        visible = d.visible;
        for (let i = 0; i < visCbs.length; i++) visCbs[i](visible);
        break;
      case 'fs': fsActive = d.active; break;
      case 'display':
        if (displayUpdate(d.w, d.h, d.dpr, d.left, d.top, d.gen)) displayPending = true;
        break;
      case 'clock': displayPageClock(d.hz, performance.now()); break;
      case 'storage':
        if (d.key === null) break;
        if (d.value === null) store.delete(d.key); else store.set(d.key, d.value);
        for (let i = 0; i < storageCbs.length; i++) storageCbs[i](d.key, d.value);
        break;
      case 'env': envCache = d.env; break;
      case 'sys': sysCache = d.sys; break;
      case 'done': settle(d); break;
      case 'call': consoleCall(d); break;
      case 'prof':
        if (!sink) break;
        if (d.kind === 'note') sink.note(d.note, d.detail);
        else if (sink[d.kind]) sink[d.kind](d.o);
        break;
    }
  }

  // The transferred canvas, and the page's measurement of it at that moment.
  function attach(canvas, size) {
    platform.canvas = canvas;
    applySize(size);
  }

  return {
    platform, profileHost, handle, attach,
    setBeforeWrite(fn) { beforeWrite = fn; }
  };
}
