// The platform: the only file in v1 that touches window, document, localStorage
// or DOM events (navigator.gpu is the one exception, and it lives in
// v1/gpu/engine.js). Everything above this layer works in CSS pixels and a
// small set of pooled input events; this is where those numbers come from,
// and where the handful of transient DOM writes v1 is allowed to make
// (a clipboard-fallback textarea, and the one fatal-message paragraph) live.
//
// It is also where images are decoded. loadImagePixels(url) fetches an image
// (url relative to the page base, which v1/index.html sets to the repo root),
// decodes it with createImageBitmap, and reads it back through a scratch
// OffscreenCanvas, resolving to { width, height, data } where data is the
// Uint8ClampedArray of straight-alpha RGBA rows. The GPU layer builds its
// own textures from that, so it never needs fetch or a canvas of its own.
//
// onStorage(fn) reports writes made by OTHER tabs or windows of the same
// origin (v0 included) to any localStorage key, as fn(key, newValue), where
// newValue is the stored string or null if the key was removed. A tab never
// hears its own writes. key is null when another tab cleared the whole
// store; that is passed on as it is and every listener here ignores it.

//
// A few pieces are exported on their own (the key and gesture guards, the
// clipboard, fullscreen, the fatal message and the long-task watch), because
// in worker mode the page keeps only a thin shell around the canvas
// (platform/worker-bridge.js) that needs exactly these, with the same
// behaviour, while the engine and this file's createPlatform are not used on
// the page at all.
import { createInputQueue } from './input-queue.js';
import { displayListenScreen, displaySampleScreen } from '../../js/display-watch.js';

export const GUARDED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

// The canvas is the only thing on this page that can hold focus, so keys
// count whether it has focus or nothing does. On a fresh load focus sits on
// the body until something is clicked, and requiring the canvas meant the
// space bar did nothing until then. The only element that can legitimately
// take keys away is the clipboard fallback's momentary textarea. meta/ctrl
// combinations are left alone so the browser's own shortcuts keep working.
export function canvasOwnsKeys(canvas) {
  const a = document.activeElement;
  return !a || a === canvas || a === document.body || a === document.documentElement;
}

// ---------- gesture guards ----------
export function guardGestures(canvas) {
  // No context menu over the field, except while developing locally, where
  // right-click Inspect is the fastest way into the console.
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  canvas.addEventListener('contextmenu', e => { if (!LOCAL) e.preventDefault(); });
  // Safari's pinch-zoom gesture events; harmless no-ops to register anywhere
  // that doesn't ship them.
  canvas.addEventListener('gesturestart', e => e.preventDefault());
  canvas.addEventListener('gesturechange', e => e.preventDefault());
  canvas.addEventListener('gestureend', e => e.preventDefault());
  // touch-action:none in the page CSS already keeps a double tap from zooming
  // on a compliant browser; this is the belt-and-suspenders fallback for the
  // ones that still fire it anyway.
  let lastTouchEnd = 0;
  canvas.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd < 350) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
}

// ---------- sizing ----------
// Reports the canvas's size as apply(pxW, pxH, dpr, cssW, cssH), unrounded,
// on every change the browser observes.
// devicePixelContentBoxSize reports the box the compositor actually paints
// in real device pixels, which is the only way to size a canvas without a
// fractional-DPR blur at zoom levels other than 100%. Where a browser
// doesn't report it (Safari, at the time of writing), contentBoxSize times
// devicePixelRatio is a frame less exact but never off by more than rounding.
export function watchCanvasSize(canvas, apply) {
  try {
    const ro = new ResizeObserver(entries => {
      const e = entries[0];
      const dpr = window.devicePixelRatio || 1;
      const cssW = e.contentRect.width, cssH = e.contentRect.height;
      const dpBox = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
      if (dpBox) {
        apply(dpBox.inlineSize, dpBox.blockSize, dpr, cssW, cssH);
      } else {
        const cbs = e.contentBoxSize
          ? (Array.isArray(e.contentBoxSize) ? e.contentBoxSize[0] : e.contentBoxSize)
          : null;
        const w = cbs ? cbs.inlineSize : e.contentRect.width;
        const h = cbs ? cbs.blockSize : e.contentRect.height;
        apply(w * dpr, h * dpr, dpr, cssW, cssH);
      }
    });
    ro.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    // A browser that throws on the device-pixel-content-box hint (Safari, at
    // the time of writing) needs its own observer entirely, not a branch
    // inside the callback above: the option is rejected at observe() time.
    const ro = new ResizeObserver(entries => {
      const e = entries[0];
      const dpr = window.devicePixelRatio || 1;
      const cssW = e.contentRect.width, cssH = e.contentRect.height;
      apply(cssW * dpr, cssH * dpr, dpr, cssW, cssH);
    });
    ro.observe(canvas);
  }
}

// ---------- clipboard ----------
export function clipboardWrite(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Older WebKit and any page not in a secure context lose the async API;
  // the textarea is created, used and removed within the same turn, so it
  // never becomes a second piece of on-screen DOM.
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try {
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy failed'));
    } catch (err) {
      document.body.removeChild(ta);
      reject(err);
    }
  });
}

// ---------- fullscreen ----------
// Ported from js/ui.js: the same three-name fallback chain, because a
// plain optional-chained requestFullscreen quietly does nothing on the
// browsers that only ship the prefixed form.
const FS_REQUEST = ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen'];
const FS_EXIT = ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen'];

export function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function fullscreenAvailable() {
  const el = document.documentElement;
  if (!FS_REQUEST.some(m => typeof el[m] === 'function')) return false;
  const flag = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
  return flag !== false;
}
export function toggleFullscreen() {
  if (!fullscreenAvailable()) return false;
  const el = document.documentElement;
  try {
    if (!fsElement()) {
      const m = FS_REQUEST.find(n => typeof el[n] === 'function');
      const r = m === 'requestFullscreen' ? el[m]({ navigationUI: 'hide' }) : el[m]();
      Promise.resolve(r).catch(() => {});
    } else {
      const m = FS_EXIT.find(n => typeof document[n] === 'function');
      if (m) Promise.resolve(document[m]()).catch(() => {});
    }
  } catch { return false; }
  return true;
}

// ---------- fatal message ----------
// The one other allowed DOM write: used only when WebGPU itself is
// unavailable, so there is nothing left for the canvas to draw with.
export function showMessage(text) {
  document.body.innerHTML = '';
  const div = document.createElement('div');
  div.textContent = text;
  div.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:#000;color:#8b97a3;font:15px ui-sans-serif,-apple-system,system-ui,sans-serif;' +
    'text-align:center;padding:24px;box-sizing:border-box;';
  document.body.appendChild(div);
}

// ---------- image decoding ----------
// Straight alpha and no colour conversion on the way in: callers that
// clean or premultiply the pixels want the file's own numbers. The 2D
// canvas stores premultiplied internally, so the lowest-alpha texels come
// back slightly quantised; nothing that reads this depends on those.
export async function loadImagePixels(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('image fetch failed (' + res.status + '): ' + url);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const w = bmp.width, h = bmp.height;
  let cv;
  if (typeof OffscreenCanvas === 'function') {
    cv = new OffscreenCanvas(w, h);
  } else {
    cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
  }
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) { if (bmp.close) bmp.close(); throw new Error('no 2d context to decode ' + url); }
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

// Main-thread long tasks over the last five seconds, for diagnostics. The
// strobe's rAF intervals cannot see a stall on this thread that happens
// between frames; this can. Chrome only; elsewhere it reads unavailable.
// Returns the summary function; the observer starts at the call.
export function watchLongTasks() {
  const longTasks = [];
  let longTaskSupported = false;
  try {
    longTaskSupported = typeof PerformanceObserver === 'function' &&
      (PerformanceObserver.supportedEntryTypes || []).includes('longtask');
    if (longTaskSupported) {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) longTasks.push(e.startTime + e.duration, e.duration);
      }).observe({ type: 'longtask', buffered: true });
    }
  } catch (e) { longTaskSupported = false; }
  function longTaskSummary() {
    if (!longTaskSupported) return 'unavailable';
    const cutoff = performance.now() - 5000;
    let n = 0, worst = 0;
    for (let i = 0; i < longTasks.length; i += 2) {
      if (longTasks[i] < cutoff) continue;
      n++; if (longTasks[i + 1] > worst) worst = longTasks[i + 1];
    }
    // trim what is out of the window so the list never grows unbounded
    let k = 0;
    while (k < longTasks.length && longTasks[k] < cutoff) k += 2;
    if (k) longTasks.splice(0, k);
    return n + ', worst ' + Math.round(worst) + ' ms';
  }
  return longTaskSummary;
}

export function createPlatform(canvas) {
  const resizeCbs = [];
  const visCbs = [];
  const storageCbs = [];

  // ---------- pooled input events ----------
  // The ring of reused event objects and the queue pollInput drains live in
  // input-queue.js, shared with the engine worker's platform so both hand the
  // engine events made by the same code.
  const q = createInputQueue();
  const pollInput = q.pollInput;

  // ---------- pointer ----------
  canvas.addEventListener('pointerdown', e => {
    canvas.focus();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    q.pointer('down', e);
  });
  canvas.addEventListener('pointermove', e => q.pointer('move', e));
  canvas.addEventListener('pointerup', e => q.pointer('up', e));
  canvas.addEventListener('pointercancel', e => q.pointer('cancel', e));
  canvas.addEventListener('pointerleave', e => q.pointer('leave', e));

  // ---------- wheel ----------
  // passive:false so preventDefault actually stops the page scrolling or the
  // trackpad pinch-zooming; the one surface never moves under its own input.
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    q.wheel(e, platform.width, platform.height);
  }, { passive: false });

  // ---------- keyboard ----------
  // (canvasOwnsKeys above says when a key belongs to the canvas.)
  const ownsKeys = () => canvasOwnsKeys(canvas);
  window.addEventListener('keydown', e => {
    if (!ownsKeys()) return;
    if (!e.metaKey && !e.ctrlKey && GUARDED_KEYS.has(e.code)) e.preventDefault();
    q.key('key', e);
  });
  window.addEventListener('keyup', e => {
    if (!ownsKeys()) return;
    q.key('keyup', e);
  });

  guardGestures(canvas);

  // ---------- sizing ----------
  // (watchCanvasSize above says where the numbers come from.)
  let cssW = canvas.clientWidth || window.innerWidth;
  let cssH = canvas.clientHeight || window.innerHeight;

  function applySize(pxW, pxH, dpr) {
    pxW = Math.max(1, Math.round(pxW));
    pxH = Math.max(1, Math.round(pxH));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW; canvas.height = pxH;
    }
    platform.dpr = dpr;
    platform.width = cssW;
    platform.height = cssH;
    for (let i = 0; i < resizeCbs.length; i++) resizeCbs[i](cssW, cssH, dpr);
  }

  // The first, synchronous measurement happens at the bottom of this
  // function, once `platform` exists for applySize to write into.

  watchCanvasSize(canvas, (pxW, pxH, dpr, w, h) => { cssW = w; cssH = h; applySize(pxW, pxH, dpr); });

  // ---------- visibility ----------
  document.addEventListener('visibilitychange', () => {
    const visible = !document.hidden;
    for (let i = 0; i < visCbs.length; i++) visCbs[i](visible);
  });

  // ---------- storage ----------
  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }
  // The 'storage' event fires in every other document of this origin when a
  // key changes, and never in the one that made the change. sessionStorage
  // raises the same event; only localStorage is ours.
  window.addEventListener('storage', e => {
    let local = true;
    try { local = e.storageArea === localStorage; } catch {}
    if (!local) return;
    for (let i = 0; i < storageCbs.length; i++) storageCbs[i](e.key, e.newValue);
  });

  // The chrome asks every frame it is drawn (to pick the expand or contract
  // icon), so the answer is kept from the change events rather than read off
  // the document each time.
  let fsActive = !!fsElement();
  const fsChanged = () => { fsActive = !!fsElement(); };
  document.addEventListener('fullscreenchange', fsChanged);
  document.addEventListener('webkitfullscreenchange', fsChanged);
  function fullscreenActive() { return fsActive; }

  const longTaskSummary = watchLongTasks();

  // ---------- the display tripwire ----------
  // pollDisplay() reads the screen's identity once a frame and answers true
  // when it differs from the last frame's (js/display-watch.js), so main.js
  // can stop the strobe the moment the window lands on another panel.
  // Property reads and number compares only.
  displayListenScreen();
  displaySampleScreen();

  const platform = {
    canvas,
    // Facts about the host that diagnostics print. Kept here so core never
    // reads navigator or screen itself.
    env: () => ({ userAgent: navigator.userAgent, screenW: screen.width, screenH: screen.height,
                  nowISO: new Date().toISOString(), longTasks: longTaskSummary() }),
    dpr: 1, width: 0, height: 0,
    onResize(fn) { resizeCbs.push(fn); },
    pollInput,
    pollDisplay: displaySampleScreen,
    now: () => performance.now(),
    setCursor(kind) { if (canvas.style.cursor !== kind) canvas.style.cursor = kind; },
    storage: { get: storageGet, set: storageSet },
    onStorage(fn) { storageCbs.push(fn); },
    clipboardWrite,
    onVisibility(fn) { visCbs.push(fn); },
    fullscreen: { toggle: toggleFullscreen, active: fullscreenActive },
    message: showMessage,
    loadImagePixels
  };
  // Measured synchronously once, so the engine has real device-pixel
  // dimensions to configure the canvas with before the first (asynchronous)
  // ResizeObserver callback ever fires.
  const dpr0 = window.devicePixelRatio || 1;
  applySize(cssW * dpr0, cssH * dpr0, dpr0);
  // Take focus up front too, so the canvas is the focused element from the
  // first frame and keyboard focus rings behave from the start.
  try { canvas.focus({ preventScroll: true }); } catch (e) {}

  return platform;
}
