// The frame profiler: records every frame for a set time (30 s unless asked
// otherwise), finds the dropped ones, says what was happening around each,
// and hands back one JSON report. Started and stopped from the Profile chip
// at the foot of the drawer, or from the console as window.signalProfile.
//
// It exists because a dropped strobe frame is a held image: the previous
// frame stays on screen for an extra refresh, which on a 40 Hz strobe reads
// as a black or white blink. Frame timings alone cannot say why a frame was
// held, so this lines each late frame up against everything that could have
// held it: the frame's own CPU phases, when the GPU finished it, the GPU
// passes' own durations, the JS heap (a drop there is a collection), a
// collection sentinel, the browser's long-animation-frame and long-task
// entries, input events, visibility, audio and errors.
//
// Recording has to cost next to nothing, or it would cause what it measures.
// Every per-frame number goes by index into typed arrays sized for the whole
// recording when it starts (seconds x FPS_CAP frames), so recording a frame
// allocates nothing here. What the browser forces on it (a promise or two
// from the GPU readbacks in engine.js, one small object from each
// performance.memory read) is a few hundred bytes a frame, and only while
// recording. All the analysis, the strings and the JSON happen after the
// recording stops, where allocating is fine.
//
// The browser-only pieces (heap reads, observers, file saving, window) come
// from v1/platform/profile-web.js, so this file stays pure logic.
import { S, layers } from '../../js/state.js';
import { getContext } from '../../js/audio.js';
import { buildDiagnostics } from './diagnostics.js';
import { presetTransitionCount } from './presets.js';

const DEFAULT_SECONDS = 30;
const MAX_SECONDS = 600;
const FPS_CAP = 250;              // frames of room per recorded second
const PRESET_WINDOW_MS = 1600;    // a preset's glide (1.5 s) plus a little
const EVENT_MAX = 4000;           // cap on each event list
const GC_MAX = 4096;

// Per-frame flags. main.js passes the first eight; the rest are set here.
export const PF_LIT = 1, PF_RUNNING = 2, PF_DRAWER = 4, PF_MIXER = 8,
  PF_DIRECT = 16, PF_CAPTURE = 32, PF_UI_SKIPPED = 64, PF_GLASS = 128;
const PF_PRESET = 256, PF_GC = 512, PF_HIDDEN = 1024;
const FLAG_NAMES = ['lit', 'running', 'drawerOpen', 'mixerOpen', 'directPath', 'blurCapture',
  'uiBuildSkipped', 'glassOnScreen', 'presetTransition', 'gcSentinelCollected', 'hidden'];

// The profiler's public state. The engine reads n and gen while recording
// (the index of the frame being built, and which recording it belongs to)
// and calls gpuDone / gpuPasses back with its results, so this object is
// also the sink handed to engine.profileBegin.
export const prof = {
  recording: false,
  building: false,
  n: 0,
  gen: 0,
  drops: 0,
  seconds: DEFAULT_SECONDS,
  gpuTiming: false,
  report: null,
  json: '',
  copied: 0,          // 1 copied, -1 the clipboard refused, 0 not tried
  status: '',         // the drawer's one line, rebuilt only when it changes
  gpuDone(gen, i, ms) {
    if (gen === prof.gen && i >= 0 && i < cap) gDone[i] = ms;
  },
  gpuPasses(gen, i, main, fin, blur, comp) {
    if (gen !== prof.gen || i < 0 || i >= cap) return;
    gMain[i] = main; gFinal[i] = fin; gBlur[i] = blur; gComp[i] = comp;
  }
};

let host = null, platform = null, engine = null;

// ---------- the per-frame arrays ----------
let cap = 0;
let T, IV, pIn, pSim, pUi, pRen, pPost, gDone, gMain, gFinal, gBlur, gComp, hUsed, hTotal, PH, FIDX, FLAGS, LAY;
function ensureCapacity(need) {
  if (cap >= need) return;
  cap = need;
  T = new Float64Array(cap); IV = new Float32Array(cap);
  pIn = new Float32Array(cap); pSim = new Float32Array(cap); pUi = new Float32Array(cap);
  pRen = new Float32Array(cap); pPost = new Float32Array(cap);
  gDone = new Float32Array(cap); gMain = new Float32Array(cap); gFinal = new Float32Array(cap);
  gBlur = new Float32Array(cap); gComp = new Float32Array(cap);
  hUsed = new Float64Array(cap); hTotal = new Float64Array(cap);
  PH = new Float32Array(cap); FIDX = new Int16Array(cap);
  FLAGS = new Uint16Array(cap); LAY = new Uint16Array(cap);
}
const heapTmp = new Float64Array(2);

// ---------- recording state ----------
let layerKeys = [];
let dropMs = 0;                       // live threshold, 1.5 refresh intervals
let lastPresetCount = 0, presetT = -1e9;
let hidden = false;
let startT = 0, startInfo = null, endInfo = null, stopReason = '';
let observers = null;
let loafs = [], longtasks = [], inputEvents = [], notes = [], audioSamples = [];
let shownSec = -1, shownDrops = -1;

// A collection sentinel: an object nothing refers to, registered with a
// FinalizationRegistry. When a collection frees it, the registry's callback
// runs (as a task of its own, shortly after), notes the time and plants the
// next one. It needs no browser flag, unlike the heap figures. V8 treats
// such weakly held objects as live through its quick minor collections, so
// this mostly counts the larger (mark-compact) ones; the held value is the
// recording's gen, so a sentinel left over from an earlier recording is
// never counted in a later one.
const gcReg = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(onCollected) : null;
const gcTimes = new Float64Array(GC_MAX);
let gcN = 0, gcFlag = false;
function plantSentinel() { if (gcReg) gcReg.register({}, prof.gen); }
function onCollected(gen) {
  if (!prof.recording || gen !== prof.gen) return;
  gcFlag = true;
  if (gcN < GC_MAX) gcTimes[gcN++] = host.now();
  plantSentinel();
}

// What the observers and listeners hand in while recording.
const sink = {
  loaf(o) { if (loafs.length < EVENT_MAX) loafs.push(o); },
  longtask(o) { if (longtasks.length < EVENT_MAX) longtasks.push(o); },
  event(o) { if (inputEvents.length < EVENT_MAX) inputEvents.push(o); },
  note
};
// A note from elsewhere in the app (the panel guard's trips), kept with the
// recording's other notes; outside a recording it is dropped, as they are.
export function profNote(kind, detail) { note(kind, detail); }
function note(kind, detail) {
  if (!prof.recording && !prof.building) return;
  if (kind === 'visibility') hidden = detail === 'hidden';
  if (notes.length < EVENT_MAX) notes.push({ t: host.now(), kind, detail: String(detail) });
}

function audioSnapshot() {
  const c = getContext();
  if (!c) return { context: 'not created yet' };
  return {
    state: c.state, sampleRate: c.sampleRate,
    baseLatencyMs: typeof c.baseLatency === 'number' ? r2(c.baseLatency * 1000) : null,
    outputLatencyMs: typeof c.outputLatency === 'number' ? r2(c.outputLatency * 1000) : null,
    currentTime: r2(c.currentTime)
  };
}

// ---------- wiring ----------
export function initProfiler(profileHost, plat, eng) {
  host = profileHost; platform = plat; engine = eng;
  eng.onDeviceLost(msg => note('device lost', msg));
  if (eng.onGpuError) eng.onGpuError(msg => note('gpu error', msg));
  host.expose('signalProfile', {
    start: seconds => { const ok = profStart(seconds); return ok ? 'recording ' + prof.seconds + ' s' : 'already recording'; },
    stop: () => { profStop(); return 'stopped'; },
    report: () => prof.report,
    save: () => profSave(),
    copy: () => profCopy(),
    get recording() { return prof.recording; },
    get drops() { return prof.drops; }
  });
}

// ---------- start, stop ----------
export function profToggle() {
  if (prof.recording) profStop();
  else if (!prof.building) profStart(DEFAULT_SECONDS);
}

export function profStart(seconds) {
  if (!host || prof.recording || prof.building) return false;
  let sec = Number(seconds);
  if (!(sec > 0)) sec = DEFAULT_SECONDS;
  sec = Math.min(MAX_SECONDS, Math.max(1, sec));
  ensureCapacity(Math.ceil(sec * FPS_CAP) + 240);
  gDone.fill(-1); gMain.fill(-1); gFinal.fill(-1); gBlur.fill(-1); gComp.fill(-1);

  prof.gen++;
  prof.n = 0; prof.drops = 0; prof.seconds = sec;
  prof.report = null; prof.json = ''; prof.copied = 0;
  loafs = []; longtasks = []; inputEvents = []; notes = []; audioSamples = [];
  gcN = 0; gcFlag = false;
  layerKeys = Object.keys(layers).slice(0, 16);
  dropMs = S.refreshHz > 0 ? 1500 / S.refreshHz : 0;
  lastPresetCount = presetTransitionCount(); presetT = -1e9;
  hidden = host.hidden();
  shownSec = -1; shownDrops = -1;
  stopReason = '';
  startT = host.now();
  host.requestHints();
  startInfo = {
    iso: host.nowISO(), perfNow: startT,
    audio: audioSnapshot(),
    strobeDropCount: S.dropCount,
    diagnostics: buildDiagnostics(platform.env()).split('\n')
  };
  prof.gpuTiming = engine.profileBegin(prof);
  observers = host.observe(sink, getContext());
  plantSentinel();
  prof.recording = true;
  prof.status = 'Recording 0 s';
  console.log('[profile] recording ' + sec + ' s. Stop early with signalProfile.stop() or the Profile chip.');
  return true;
}

export function profStop() { stopRecording('stopped early'); }

function stopRecording(reason) {
  if (!prof.recording) return;
  prof.recording = false;
  prof.building = true;
  stopReason = reason;
  engine.profileEnd();
  endInfo = { perfNow: host.now(), audio: audioSnapshot(), strobeDropCount: S.dropCount };
  prof.status = 'Building report...';
  // A short wait before building, so the GPU results and the browser's
  // long-animation-frame entries for the last few frames (both arrive late)
  // are in. The observers keep listening until then.
  host.after(500, finalize);
}

function finalize() {
  if (observers) { observers.stop(); }
  let rep = null;
  try {
    rep = buildReport();
    prof.report = rep;
    prof.json = JSON.stringify(rep);
  } catch (e) {
    console.warn('[profile] building the report failed', e);
  }
  prof.building = false;
  if (!rep) { prof.status = 'Report failed, see console'; return; }
  logSummary(rep);
  setDoneStatus();
  platform.clipboardWrite(prof.json).then(
    () => { prof.copied = 1; setDoneStatus(); console.log('[profile] full JSON report copied to the clipboard (' + Math.round(prof.json.length / 1024) + ' KB).'); },
    () => { prof.copied = -1; setDoneStatus(); console.log('[profile] the clipboard refused (page not focused?). Use the drawer\'s Copy chip, signalProfile.copy(), or copy(signalProfile.report()) here.'); }
  );
}

function setDoneStatus() {
  const s = prof.report ? prof.report.summary : null;
  if (!s) return;
  prof.status = s.drops.total + ' dropped' +
    (prof.copied === 1 ? '  ·  copied' : prof.copied === -1 ? '  ·  not copied' : '');
}

export function profSave() {
  if (!prof.json) return false;
  const stamp = (prof.report && prof.report.created ? prof.report.created : host.nowISO()).replace(/[:.]/g, '-');
  host.download('the-signal-profile-' + stamp + '.json', prof.json);
  return true;
}

export function profCopy() {
  if (!prof.json) return Promise.resolve(false);
  return platform.clipboardWrite(prof.json).then(
    () => { prof.copied = 1; setDoneStatus(); return true; },
    () => { prof.copied = -1; setDoneStatus(); return false; });
}

// ---------- the frame ----------
// Called once at the very end of every frame while recording, with the
// frame's rAF timestamp, its CPU phases (ms) and main.js's PF_* flags.
// Writes by index only.
export function profFrame(t, input, sim, ui, render, post, flags) {
  if (!prof.recording) return;
  const i = prof.n;
  if (i >= cap) { stopRecording('buffer full'); return; }
  if (i === 0) startT = t;
  T[i] = t;
  const iv = i > 0 ? t - T[i - 1] : 0;
  IV[i] = iv;
  pIn[i] = input; pSim[i] = sim; pUi[i] = ui; pRen[i] = render; pPost[i] = post;
  PH[i] = S.phase;
  FIDX[i] = S.frameLock ? S.frameIdx : -1;

  const pc = presetTransitionCount();
  if (pc !== lastPresetCount) { lastPresetCount = pc; presetT = t; }
  if (t - presetT < PRESET_WINDOW_MS) flags |= PF_PRESET;
  if (gcFlag) { gcFlag = false; flags |= PF_GC; }
  if (hidden) flags |= PF_HIDDEN;
  FLAGS[i] = flags;

  let m = 0;
  for (let k = 0; k < layerKeys.length; k++) if (layers[layerKeys[k]]) m |= 1 << k;
  LAY[i] = m;

  host.readHeap(heapTmp);
  hUsed[i] = heapTmp[0]; hTotal[i] = heapTmp[1];

  if (dropMs === 0 && S.refreshHz > 0) dropMs = 1500 / S.refreshHz;
  if (i > 0 && dropMs > 0 && iv > dropMs && iv < 1000 && !hidden) prof.drops++;
  prof.n = i + 1;

  // The drawer's line changes once a second or on a drop, never per frame.
  const el = t - startT, sec = (el / 1000) | 0;
  if (sec !== shownSec || prof.drops !== shownDrops) {
    shownSec = sec; shownDrops = prof.drops;
    prof.status = 'Recording ' + sec + ' s  ·  ' + prof.drops + ' dropped';
    if (audioSamples.length < MAX_SECONDS) { const a = audioSnapshot(); a.t = r2(el); audioSamples.push(a); }
  }
  if (el >= prof.seconds * 1000) stopRecording('completed');
}

// ---------- analysis, after the recording ----------
function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0; }
function stats(values) {
  const s = values.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i];
  return { n: s.length, mean: r2(sum / s.length), p50: r2(pct(s, 0.5)), p95: r2(pct(s, 0.95)), p99: r2(pct(s, 0.99)), max: r2(s[s.length - 1]) };
}
function column(arr, n, keep) {
  const out = [];
  for (let i = 0; i < n; i++) if (!keep || keep(arr[i], i)) out.push(arr[i]);
  return out;
}
function cpuOf(i) { return pIn[i] + pSim[i] + pUi[i] + pRen[i] + pPost[i]; }
function layerNames(mask) {
  const out = [];
  for (let k = 0; k < layerKeys.length; k++) if (mask & (1 << k)) out.push(layerKeys[k]);
  return out;
}
function flagNames(f) {
  const out = [];
  for (let k = 0; k < FLAG_NAMES.length; k++) if (f & (1 << k)) out.push(FLAG_NAMES[k]);
  return out;
}
function scriptMsOf(entry) {
  let s = 0;
  for (let k = 0; k < entry.scripts.length; k++) s += entry.scripts[k].duration;
  return s;
}
function overlapping(list, a, b) {
  const out = [];
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    if (e.start < b && e.start + e.duration > a) out.push(e);
  }
  return out;
}

function buildReport() {
  const n = prof.n;
  const base = n ? T[0] : startT;
  const rel = v => r2(v - base);
  const durationMs = n > 1 ? T[n - 1] - T[0] : 0;

  // the refresh interval, as the median of every counted interval
  const good = i => i > 0 && IV[i] > 0 && IV[i] < 1000 && !(FLAGS[i] & PF_HIDDEN) && !(FLAGS[i - 1] & PF_HIDDEN);
  const ivs = [];
  for (let i = 1; i < n; i++) if (good(i)) ivs.push(IV[i]);
  const ivSorted = ivs.slice().sort((a, b) => a - b);
  const refreshMs = pct(ivSorted, 0.5) || (S.refreshHz ? 1000 / S.refreshHz : 16.67);
  const dropThreshold = refreshMs * 1.5;

  // heap: every step down between two samples is a collection that freed
  // more than was allocated since the last reading
  let heapChanges = 0, heapDrops = 0, freed = 0, grown = 0;
  const heapDropAt = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    if (hUsed[i] < 0 || hUsed[i - 1] < 0) continue;
    const d = hUsed[i] - hUsed[i - 1];
    if (d !== 0) heapChanges++;
    if (d < 0) { heapDrops++; freed -= d; heapDropAt[i] = -d; } else grown += d;
  }
  const heapAvailable = n > 0 && hUsed[0] >= 0;
  const heapPrecise = heapChanges > 2;
  const gcSentinel = [];
  for (let k = 0; k < gcN; k++) gcSentinel.push(rel(gcTimes[k]));

  // ---- the drops ----
  const drops = [];
  const byClass = { 'probable GC': 0, 'main-thread overrun': 0, 'GPU/compositor': 0, 'unknown': 0 };
  let heldLit = 0, heldDark = 0, missedTotal = 0;
  for (let i = 1; i < n; i++) {
    if (!good(i) || IV[i] <= dropThreshold) continue;
    const prev = i - 1, a = T[prev], b = T[i];
    const iv = IV[i];
    const missed = Math.max(1, Math.round(iv / refreshMs) - 1);
    missedTotal += missed;
    const heldIsLit = !!(FLAGS[prev] & PF_LIT);
    if (heldIsLit) heldLit++; else heldDark++;

    const lo = overlapping(loafs, a, b);
    let scriptMs = 0, blockingMs = 0;
    const loafOut = [];
    for (const e of lo) {
      const sm = scriptMsOf(e);
      scriptMs += sm;
      if (e.blockingDuration > blockingMs) blockingMs = e.blockingDuration;
      loafOut.push({
        start: rel(e.start), duration: r2(e.duration), blockingDuration: r2(e.blockingDuration),
        renderStart: e.renderStart ? rel(e.renderStart) : 0,
        styleAndLayoutStart: e.styleAndLayoutStart ? rel(e.styleAndLayoutStart) : 0,
        scriptMs: r2(sm),
        scripts: e.scripts.map(s => ({ sourceURL: s.sourceURL, function: s.sourceFunctionName, invoker: s.invoker, duration: r2(s.duration) }))
      });
    }
    const lt = overlapping(longtasks, a, b);
    let longTaskMs = 0;
    for (const e of lt) longTaskMs += e.duration;
    const ev = overlapping(inputEvents, a, b);

    // A heap reading refreshes at most every 50 ms even with precise
    // readings on, so a collection inside this gap can show up a few frames
    // later; the window runs 80 ms past the late frame.
    let heapDrop = 0;
    for (let j = prev; j < n && T[j] <= b + 80; j++) if (heapDropAt[j] > heapDrop) heapDrop = heapDropAt[j];
    // The sentinel's callback runs a task or so after the collection.
    let gcCb = false;
    for (let k = 0; k < gcN; k++) if (gcTimes[k] >= a && gcTimes[k] <= b + 100) { gcCb = true; break; }
    const nts = [];
    for (const x of notes) if (x.t >= a - 20 && x.t <= b + 20) nts.push({ t: rel(x.t), kind: x.kind, detail: x.detail });

    const cpuPrev = cpuOf(prev);
    const gpuDonePrev = gDone[prev], gpuMainPrev = gMain[prev];
    const gcEvidence = heapDrop > 0 || gcCb;
    const scriptHeavy = scriptMs > refreshMs * 0.5 || longTaskMs > 0;
    const cpuOver = cpuPrev > refreshMs * 0.85;
    const gpuSlow = gpuDonePrev > refreshMs * 1.5 || gpuMainPrev > refreshMs * 0.8;
    const why = [];
    if (cpuOver) why.push('frame ' + prev + ' took ' + cpuPrev.toFixed(1) + ' ms of CPU against a ' + refreshMs.toFixed(1) + ' ms refresh');
    if (scriptMs > 0) why.push('long animation frame with ' + scriptMs.toFixed(1) + ' ms of script');
    if (longTaskMs > 0) why.push('long task ' + longTaskMs.toFixed(1) + ' ms');
    if (heapDrop > 0) why.push('heap fell ' + (heapDrop / 1024).toFixed(0) + ' KB');
    if (gcCb) why.push('collection sentinel freed');
    if (gpuSlow) why.push('GPU finished frame ' + prev + ' after ' + (gpuDonePrev >= 0 ? gpuDonePrev.toFixed(1) : '?') + ' ms' + (gpuMainPrev >= 0 ? ', main pass ' + gpuMainPrev.toFixed(2) + ' ms' : ''));
    if (!cpuOver && !scriptHeavy) why.push((iv - cpuPrev).toFixed(1) + ' ms of the gap was outside the frame callback');
    let cls;
    if (gcEvidence && !scriptHeavy) cls = 'probable GC';
    else if (cpuOver || scriptHeavy) cls = 'main-thread overrun';
    else if (gpuSlow) cls = 'GPU/compositor';
    else cls = 'unknown';
    byClass[cls]++;

    drops.push({
      frame: i, at: rel(b), atS: r2((b - base) / 1000),
      intervalMs: r2(iv), missedRefreshes: missed, class: cls, why,
      heldImage: heldIsLit ? 'lit' : 'dark', nextImage: (FLAGS[i] & PF_LIT) ? 'lit' : 'dark',
      strobe: { frameIdxHeld: FIDX[prev], phaseHeld: r3(PH[prev]), frameIdxNext: FIDX[i], phaseNext: r3(PH[i]) },
      cpuPrevFrame: { input: r2(pIn[prev]), sim: r2(pSim[prev]), uiBuild: r2(pUi[prev]), render: r2(pRen[prev]), afterSubmit: r2(pPost[prev]), total: r2(cpuPrev) },
      cpuThisFrame: r2(cpuOf(i)),
      gpu: {
        doneMsPrev: r2(gDone[prev]), doneMsThis: r2(gDone[i]),
        mainPassMsPrev: r2(gMain[prev]), finalPassMsPrev: r2(gFinal[prev]),
        blurMsPrev: r2(gBlur[prev]), computeMsPrev: r2(gComp[prev])
      },
      heapDropKB: r2(heapDrop / 1024), gcSentinel: gcCb,
      loaf: loafOut, longTasks: lt.map(e => ({ start: rel(e.start), duration: r2(e.duration), attribution: e.attribution })),
      inputEvents: ev.map(e => ({ name: e.name, start: rel(e.start), duration: e.duration })),
      notes: nts,
      context: { layers: layerNames(LAY[prev]), flags: flagNames(FLAGS[prev]) }
    });
  }

  // ---- the worst frames, whether or not they counted as drops ----
  const order = [];
  for (let i = 1; i < n; i++) if (good(i)) order.push(i);
  order.sort((x, y) => IV[y] - IV[x]);
  const worst = order.slice(0, 20).map(i => ({
    frame: i, atS: r2((T[i] - base) / 1000), intervalMs: r2(IV[i]),
    cpuPrevMs: r2(cpuOf(i - 1)), uiBuildPrevMs: r2(pUi[i - 1]), renderPrevMs: r2(pRen[i - 1]),
    gpuDonePrevMs: r2(gDone[i - 1]), held: (FLAGS[i - 1] & PF_LIT) ? 'lit' : 'dark',
    heapDropKB: r2(heapDropAt[i] / 1024), flags: flagNames(FLAGS[i - 1]).join(' ')
  }));

  const valid = v => v >= 0;
  const cpuTotals = [];
  for (let i = 0; i < n; i++) cpuTotals.push(cpuOf(i));
  const durS = durationMs / 1000;

  const summary = {
    durationS: r2(durS),
    frames: n,
    stopReason,
    refreshMs: r3(refreshMs),
    measuredRefreshHz: r2(1000 / refreshMs),
    strobeRefreshHz: r2(S.refreshHz || 0),
    dropThresholdMs: r2(dropThreshold),
    frameIntervalMs: stats(ivs),
    drops: {
      total: drops.length,
      perMinute: durS > 0 ? r2(drops.length / (durS / 60)) : 0,
      missedRefreshes: missedTotal,
      byClass,
      heldImageLit: heldLit, heldImageDark: heldDark,
      strobeCounterDuringRecording: endInfo && startInfo ? endInfo.strobeDropCount - startInfo.strobeDropCount : null
    },
    cpuMs: {
      input: stats(column(pIn, n)), sim: stats(column(pSim, n)), uiBuild: stats(column(pUi, n)),
      render: stats(column(pRen, n)), afterSubmit: stats(column(pPost, n)), total: stats(cpuTotals)
    },
    gpuMs: {
      doneLatency: stats(column(gDone, n, valid)),
      mainPass: stats(column(gMain, n, valid)),
      finalPass: stats(column(gFinal, n, valid)),
      blurCapture: stats(column(gBlur, n, valid)),
      particleCompute: stats(column(gComp, n, valid)),
      passTiming: prof.gpuTiming ? 'timestamp-query' : 'unavailable on this adapter'
    },
    gc: {
      heapAvailable, heapPrecise,
      heapDrops, heapFreedMB: r2(freed / 1048576),
      allocationMBperS: heapPrecise && durS > 0 ? r2(grown / 1048576 / durS) : null,
      heapUsedMBStart: heapAvailable ? r2(hUsed[0] / 1048576) : null,
      heapUsedMBEnd: heapAvailable && n ? r2(hUsed[n - 1] / 1048576) : null,
      sentinelCollections: gcN,
      estimate: heapPrecise ? Math.max(heapDrops, gcN) : gcN,
      dropsWithGcEvidence: drops.filter(d => d.heapDropKB > 0 || d.gcSentinel).length
    },
    observed: {
      longAnimationFrames: loafs.length, longTasks: longtasks.length,
      slowInputEvents: inputEvents.length, notes: notes.length,
      available: observers ? observers.has : null
    }
  };

  const howToRead = [
    'Times are ms from the first recorded frame unless named otherwise. -1 means not measured.',
    'A drop is a frame interval over 1.5x the measured refresh interval. The image on screen during it was the previous frame\'s, held for missedRefreshes extra refreshes: heldImage says whether that was a lit or a dark strobe frame.',
    'cpuPrevFrame is the work of the frame whose successor came late (main.js phases). "outside the frame callback" time is main-thread work between frames, or the compositor/GPU holding the next rAF back.',
    'Classes: probable GC (heap fell or the collection sentinel was freed, with little script time); main-thread overrun (the frame or a long task ran past the refresh); GPU/compositor (CPU on time but the GPU finished late); unknown (none of those seen).',
    heapPrecise
      ? 'Heap readings were precise (they changed during the recording). Chrome still refreshes them at most every 50 ms, so a heap drop is placed to within a few frames.'
      : 'Heap readings did not change: Chrome buckets performance.memory and refreshes it only every 20 minutes unless launched with --enable-precise-memory-info, so heap-based GC detection saw nothing. Relaunch Chrome with that flag for real heap data.',
    'The collection sentinel is a FinalizationRegistry object; V8 keeps it through minor (scavenge) collections, so it mostly counts major ones. Its callback runs a task after the collection.',
    'gpu.doneMsPrev (and frames.gpuDone) is submit to queue.onSubmittedWorkDone() resolution as seen by the main thread, so a busy main thread inflates it too. Pass times come from timestamp queries, which Chrome rounds to 100 us unless WebGPU Developer Features is enabled in chrome://flags.',
    'Long animation frame and long task entries only exist for frames or tasks over 50 ms, so shorter overruns show only in the CPU phases.',
    'Reverb impulse rebuilds are private to js/audio.js and are not flagged; if one caused a long frame, a long animation frame entry names audio.js as the script.',
    'The profiler itself allocates a few hundred bytes a frame while recording (GPU readback promises, the performance.memory object).'
  ];

  const snapLayers = {};
  for (const k of Object.keys(layers)) snapLayers[k] = layers[k];
  const system = host.sysInfo();
  system.measuredRefreshHz = r2(1000 / refreshMs);
  system.strobeRefreshHz = r2(S.refreshHz || 0);
  system.canvas = {
    cssWidth: platform.width, cssHeight: platform.height, dpr: platform.dpr,
    pixelWidth: engine.pixelWidth, pixelHeight: engine.pixelHeight
  };

  const frames = {
    fields: ['t', 'interval', 'input', 'sim', 'uiBuild', 'render', 'afterSubmit', 'gpuDone', 'gpuMain', 'gpuFinal',
      'gpuBlur', 'gpuCompute', 'heapUsedMB', 'heapTotalMB', 'phase', 'frameIdx', 'flags', 'layers'],
    flagBits: FLAG_NAMES,
    layerBits: layerKeys.slice(),
    t: [], interval: [], input: [], sim: [], uiBuild: [], render: [], afterSubmit: [],
    gpuDone: [], gpuMain: [], gpuFinal: [], gpuBlur: [], gpuCompute: [],
    heapUsedMB: [], heapTotalMB: [], phase: [], frameIdx: [], flags: [], layers: []
  };
  const mb = v => v < 0 ? -1 : Math.round(v / 1048.576) / 1000;
  for (let i = 0; i < n; i++) {
    frames.t.push(rel(T[i])); frames.interval.push(r2(IV[i]));
    frames.input.push(r2(pIn[i])); frames.sim.push(r2(pSim[i])); frames.uiBuild.push(r2(pUi[i]));
    frames.render.push(r2(pRen[i])); frames.afterSubmit.push(r2(pPost[i]));
    frames.gpuDone.push(r2(gDone[i])); frames.gpuMain.push(r2(gMain[i])); frames.gpuFinal.push(r2(gFinal[i]));
    frames.gpuBlur.push(r2(gBlur[i])); frames.gpuCompute.push(r2(gComp[i]));
    frames.heapUsedMB.push(mb(hUsed[i])); frames.heapTotalMB.push(mb(hTotal[i]));
    frames.phase.push(r3(PH[i])); frames.frameIdx.push(FIDX[i]); frames.flags.push(FLAGS[i]); frames.layers.push(LAY[i]);
  }

  return {
    kind: 'The Signal v1 frame profile',
    version: 1,
    created: startInfo ? startInfo.iso : host.nowISO(),
    howToRead,
    summary,
    drops,
    worstFrames: worst,
    system,
    gpu: engine.gpuInfo || null,
    audio: { start: startInfo ? startInfo.audio : null, end: endInfo ? endInfo.audio : null, samples: audioSamples },
    settings: {
      layers: snapLayers,
      strobe: {
        running: S.running, freq: S.freq, effFreq: r2(S.effFreq), frameLock: S.frameLock,
        framesPerCycle: S.framesPerCycle, spareMode: S.spareMode, achievedFreq: r2(S.achievedFreq || 0), duty: r3(S.duty || 0)
      },
      diagnosticsAtStart: startInfo ? startInfo.diagnostics : null
    },
    events: {
      longAnimationFrames: loafs.map(e => ({
        start: rel(e.start), duration: r2(e.duration), blockingDuration: r2(e.blockingDuration),
        renderStart: e.renderStart ? rel(e.renderStart) : 0, styleAndLayoutStart: e.styleAndLayoutStart ? rel(e.styleAndLayoutStart) : 0,
        scripts: e.scripts.map(s => ({ sourceURL: s.sourceURL, function: s.sourceFunctionName, invoker: s.invoker,
          invokerType: s.invokerType, start: rel(s.start), duration: r2(s.duration),
          forcedStyleAndLayout: r2(s.forcedStyleAndLayoutDuration), pause: r2(s.pauseDuration) }))
      })),
      longTasks: longtasks.map(e => ({ start: rel(e.start), duration: r2(e.duration), attribution: e.attribution })),
      slowInputEvents: inputEvents.map(e => ({ name: e.name, start: rel(e.start), duration: e.duration,
        processingMs: r2(e.processingEnd - e.processingStart) })),
      notes: notes.map(x => ({ t: rel(x.t), kind: x.kind, detail: x.detail })),
      gcSentinel
    },
    frames
  };
}

// The readable version, for the console.
function logSummary(rep) {
  const s = rep.summary, d = s.drops, g = s.gc, iv = s.frameIntervalMs || {};
  const c = d.byClass;
  console.log('%c[profile] ' + s.durationS + ' s, ' + s.frames + ' frames at ' + s.measuredRefreshHz + ' Hz (' + s.refreshMs + ' ms). ' +
    d.total + ' dropped (' + d.perMinute + '/min, ' + d.missedRefreshes + ' refreshes missed): ' +
    c['probable GC'] + ' probable GC, ' + c['main-thread overrun'] + ' main-thread, ' + c['GPU/compositor'] + ' GPU/compositor, ' +
    c.unknown + ' unknown. Held image lit ' + d.heldImageLit + ', dark ' + d.heldImageDark + '.', 'font-weight:bold');
  console.log('[profile] frame interval ms  p50 ' + iv.p50 + '  p95 ' + iv.p95 + '  p99 ' + iv.p99 + '  max ' + iv.max +
    '   cpu per frame p95 ' + (s.cpuMs.total ? s.cpuMs.total.p95 : '-') + ' max ' + (s.cpuMs.total ? s.cpuMs.total.max : '-') +
    '   gpu done p95 ' + (s.gpuMs.doneLatency ? s.gpuMs.doneLatency.p95 : '-'));
  console.log('[profile] GC: ' + (g.heapAvailable ? g.heapDrops + ' heap drops (' + (g.heapPrecise ? 'precise, ~' + g.allocationMBperS + ' MB/s allocated' : 'bucketed, readings frozen') + '), ' : 'no heap readings, ') +
    g.sentinelCollections + ' sentinel collections, ' + g.dropsWithGcEvidence + ' drops with GC evidence.');
  if (g.heapAvailable && !g.heapPrecise) {
    console.log('[profile] tip: Chrome buckets performance.memory and refreshes it only every 20 minutes. Quit Chrome fully and relaunch with ' +
      '--enable-precise-memory-info (macOS: open -a "Google Chrome" --args --enable-precise-memory-info) for real heap drops.');
  }
  if (rep.drops.length) {
    console.table(rep.drops.slice(0, 50).map(x => ({
      atS: x.atS, intervalMs: x.intervalMs, missed: x.missedRefreshes, held: x.heldImage, class: x.class,
      cpuPrev: x.cpuPrevFrame.total, uiBuild: x.cpuPrevFrame.uiBuild, render: x.cpuPrevFrame.render,
      gpuDone: x.gpu.doneMsPrev, heapDropKB: x.heapDropKB, gc: x.gcSentinel,
      loafScriptMs: x.loaf.reduce((a, l) => a + l.scriptMs, 0), why: x.why.join('; ')
    })));
  }
  console.log('[profile] worst frames:');
  console.table(rep.worstFrames.slice(0, 15));
  console.log('[profile] full report: signalProfile.report()  ·  save it: signalProfile.save()  ·  copy it: signalProfile.copy()');
}
