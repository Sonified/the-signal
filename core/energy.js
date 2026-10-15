// The energy profile, the engine thread's half: Render > Copy energy profile
// puts it on the clipboard with the page's half (platform/energy-page.js:
// the sound, the network, the CPU canary) after it.
//
// It is always counting, from the first frame, so a tap copies at once:
// iOS lets a page write the clipboard only from the tap itself, so there is
// no recording to start and come back to. Counting costs a clock read and a
// few additions a frame; the GPU readings (gpu/energy-probe.js) cost one
// promise every 30 frames and one small readback every two seconds.
//
// Time is split three ways: awake (the loop drawing), still (the loop
// resting on a still frame, main.js) and hidden (out of sight, the loop
// stopped). Everything per frame is per awake time, since nothing is drawn
// otherwise. The session is kept whole as totals and minute by minute for
// the last KEEP_ROWS minutes.
import { S, layers } from '../js/state.js';
import { perfLines } from './perf.js';

const MINUTE_MS = 60000;
const KEEP_ROWS = 120;

let clock = null;
let started = false, startT = 0, lastT = 0, minuteStart = 0;
let state = 'awake';          // 'awake' | 'still' | 'hidden'
let hides = 0;
const rows = [];
let cur = null, totals = null;

function newRow(i) {
  return {
    i, awake: 0, still: 0, hidden: 0,
    frames: 0, js: 0, jsMax: 0,
    gpuSum: 0, gpuN: 0, gpuMax: 0,
    litSum: 0, litN: 0, darkSum: 0, darkN: 0
  };
}

// The energy test's window (core/energy-test.js): while open, every frame
// and GPU reading lands in it as well, so a step's figures are its own.
let win = null;
export function energyWindowStart() { win = newRow(-2); win.t0 = clock(); }
export function energyWindowStop() { win = null; }
export function energyWindowTake() {
  if (!win) return null;
  win.awake = clock() - win.t0;
  const f = figures(win);
  win = null;
  return f;
}

function addTime(ms) {
  if (ms <= 0) return;
  cur[state] += ms;
  totals[state] += ms;
}

// Carries the clock up to now, closing every minute it passes on the way.
function advance(now) {
  while (now >= minuteStart + MINUTE_MS) {
    const end = minuteStart + MINUTE_MS;
    addTime(end - lastT);
    lastT = end;
    rows.push(cur);
    if (rows.length > KEEP_ROWS) rows.shift();
    cur = newRow(cur.i + 1);
    minuteStart = end;
  }
  addTime(now - lastT);
  lastT = now;
}

// main.js, once at boot: the clock (platform.now), and whether the page
// starts out of sight.
export function energyInit(now, hidden) {
  clock = now;
  startT = lastT = minuteStart = now();
  cur = newRow(0);
  totals = newRow(-1);
  state = hidden ? 'hidden' : 'awake';
  started = true;
}

// A change of state: the page hidden or shown, the loop resting or woken.
export function energyState(hidden, still) {
  if (!started) return;
  advance(clock());
  const next = hidden ? 'hidden' : still ? 'still' : 'awake';
  if (next === 'hidden' && state !== 'hidden') hides++;
  state = next;
}

// Every frame, at its end: when it started and when it ended.
export function energyFrame(t0, t1) {
  if (!started) return;
  advance(t1);
  const ms = t1 - t0;
  cur.frames++; totals.frames++;
  cur.js += ms; totals.js += ms;
  if (win) { win.frames++; win.js += ms; }
  if (ms > cur.jsMax) cur.jsMax = ms;
  if (ms > totals.jsMax) totals.jsMax = ms;
}

// The engine's sink (gpu/energy-probe.js calls these).
export const energySink = {
  gpuDone(ms) {
    if (!started) return;
    cur.gpuSum += ms; cur.gpuN++; totals.gpuSum += ms; totals.gpuN++;
    if (win) { win.gpuSum += ms; win.gpuN++; }
    if (ms > cur.gpuMax) cur.gpuMax = ms;
    if (ms > totals.gpuMax) totals.gpuMax = ms;
  },
  light(level, lit) {
    if (!started) return;
    if (lit) { cur.litSum += level; cur.litN++; totals.litSum += level; totals.litN++; }
    else { cur.darkSum += level; cur.darkN++; totals.darkSum += level; totals.darkN++; }
    if (win) { if (lit) { win.litSum += level; win.litN++; } else { win.darkSum += level; win.darkN++; } }
  }
};

// ---------- the text (on the tap, so free to allocate) ----------
const f1 = v => v.toFixed(1);
const pct = v => Math.round(v * 100) + '%';
const min1 = ms => (ms / MINUTE_MS).toFixed(1);
const pad = (v, n) => { const s = String(v); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };

// A row's numbers, per awake time. light is the mean over every sample,
// lit and dark alike, which is what the screen showed on average.
function figures(r) {
  const awake = r.awake;
  const lightN = r.litN + r.darkN;
  return {
    fps: awake > 0 ? r.frames / (awake / 1000) : 0,
    jsPer: r.frames ? r.js / r.frames : 0,
    jsBusy: awake > 0 ? r.js / awake : 0,
    gpuPer: r.gpuN ? r.gpuSum / r.gpuN : -1,
    light: lightN ? (r.litSum + r.darkSum) / lightN : -1,
    lit: r.litN ? r.litSum / r.litN : -1,
    dark: r.darkN ? r.darkSum / r.darkN : -1,
    lightN, frames: r.frames, gpuN: r.gpuN
  };
}

const DENSITY = { 0: 'Native', 2: '2x', 1.5: '1.5x', 1: '1x' };

export function buildEnergy(env, engine, platform) {
  if (!started) return 'Presence energy profile: not started';
  advance(clock());
  const all = figures(totals);
  const px = engine.pixelWidth * engine.pixelHeight;
  const a = engine.gpuInfo && engine.gpuInfo.adapter;
  const on = Object.entries(layers).filter(([, v]) => v).map(([k]) => k);
  const lines = [
    `Presence energy profile`,
    `time            ${env.nowISO}`,
    `session         ${min1(clock() - startT)} min since load: awake ${min1(totals.awake)}, still ${min1(totals.still)}, hidden ${min1(totals.hidden)} (${hides} hide${hides === 1 ? '' : 's'})`,
    `userAgent       ${env.userAgent}`,
    `screen          ${env.screenW} x ${env.screenH}, viewport ${S.W} x ${S.H} css px`,
    `density         screen ${platform.screenDpr || S.DPR}x, drawing ${+S.DPR.toFixed(2)}x (Pixel density ${DENSITY[S.dprCap] || S.dprCap})`,
    `canvas          ${engine.pixelWidth} x ${engine.pixelHeight} = ${(px / 1e6).toFixed(2)} Mpx`,
    `engine thread   ${env.frameSource || 'main'}`,
    `gpu adapter     ${a ? [a.vendor, a.architecture, a.description].filter(Boolean).join(' / ') || '(not told)' : '-'}`,
    `gpu timestamps  ${engine.gpuInfo && engine.gpuInfo.timestampQuery ? 'yes' : 'no'} (gpu done below is submit to work done, either way)`,
    `refresh         ${S.refreshHz ? f1(S.refreshHz) + ' Hz measured' : '-'}`,
    `strobe          ${S.running ? 'running' : 'stopped'}, ${f1(S.freq)} Hz, frame lock ${S.frameLock ? 'on' : 'off'}`,
    `layers          ${on.join(', ') || 'none'}`,
    `trail res       ${S.fbResScale === 1 ? 'Full' : Math.round(S.fbResScale * 100) + '%'}, edge count ${S.edgeCount}`,
    ``,
    `session, per awake time`,
    `  fps           ${f1(all.fps)}`,
    `  frame JS      ${all.jsPer.toFixed(2)} ms a frame, worst frame ${f1(totals.jsMax)} ms`,
    `  engine thread ${pct(all.jsBusy)} busy with frames (${env.frameSource === 'worker' ? 'its own worker' : 'the page\'s main thread, shared with the page'}); the CPU by thread goes on in the page half`,
    `  gpu done      ${all.gpuPer >= 0 ? all.gpuPer.toFixed(2) + ' ms a frame (' + totals.gpuN + ' samples), worst ' + f1(totals.gpuMax) + ' ms' : 'no samples'}`,
    `  surface fill  ${(px * all.fps / 1e6).toFixed(0)} Mpx/s (canvas x fps, before layers stack)`,
    `  screen light  ${all.light >= 0 ? pct(all.light) + ' of full white (lit frames ' + pct(all.lit < 0 ? 0 : all.lit) + ', dark ' + pct(all.dark < 0 ? 0 : all.dark) + '; ' + all.lightN + ' samples)' : 'no samples'}`,
    `                (mean linear subpixel level of the picture under the controls; an OLED screen spends by it)`,
    ...perfLines(),
    ``,
    `per minute (s awake / still / hidden; the rest per awake time)`,
    `  min  awake still hidden    fps  js ms  js %  gpu ms  light   lit  dark`
  ];
  const show = rows.concat([cur]);
  for (const r of show) {
    const g = figures(r);
    lines.push('  ' + [
      pad(r.i, 3), pad(Math.round(r.awake / 1000), 6), pad(Math.round(r.still / 1000), 5), pad(Math.round(r.hidden / 1000), 6),
      pad(r.awake > 0 ? f1(g.fps) : '-', 6), pad(r.frames ? g.jsPer.toFixed(2) : '-', 6), pad(r.awake > 0 ? pct(g.jsBusy) : '-', 5),
      pad(g.gpuPer >= 0 ? g.gpuPer.toFixed(2) : '-', 7), pad(g.light >= 0 ? pct(g.light) : '-', 6),
      pad(g.lit >= 0 ? pct(g.lit) : '-', 5), pad(g.dark >= 0 ? pct(g.dark) : '-', 5)
    ].join(' '));
  }
  return lines.join('\n');
}
