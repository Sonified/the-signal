// The energy test: the Run energy test chip (ui/screens/chrome.js, beside
// Copy energy profile) takes the experience as it is set, changes one thing
// at a time, measures each, puts it back, and keeps a table of what every
// change saved. It answers which layer the GPU is spending on without
// anyone switching things by hand.
//
// The steps: everything as set; each layer that is on, switched off; Trail
// res at 50%; Pixel density at 2x where the screen draws above it; and
// everything as set again, so drift (the phone warming, a scene that
// changes by itself) shows as the two baselines disagreeing. Each step
// gives the change SETTLE_MS to land (a layer's fade, its trails clearing)
// and then measures for MEASURE_MS through core/energy.js's window, with
// the GPU sampled faster meanwhile. Nothing is saved: the changes are made
// to S directly and undone at the end of their step, or at once when the
// test is stopped (a tap on the chip, or the page going out of sight).
//
// iOS lets a page write the clipboard only from a tap, so the results wait
// for one: the chip turns into Copy test results.
import { S, layers } from '../js/state.js';
import { energyWindowStart, energyWindowStop, energyWindowTake } from './energy.js';

const SETTLE_MS = 3000;
const MEASURE_MS = 9000;
const SAID_MS = 2500;

let hooks = null;             // { fast(on), screenDpr() } from main.js
let steps = null, idx = -1, phase = '', phaseT = 0;
let results = [];
let status = 'idle';          // 'idle' | 'running' | 'done'
let stopped = false, copied = 0, copiedAt = -Infinity;

export function energyTestInit(h) { hooks = h; }
export const energyTestRunning = () => status === 'running';

function buildSteps() {
  const list = [{ name: 'everything as set', base: true }];
  for (const k of Object.keys(layers)) {
    if (layers[k] !== true) continue;
    list.push({ name: k + ' off', apply() { layers[k] = false; }, undo() { layers[k] = true; } });
  }
  if (S.fbResScale !== 0.5) {
    const was = S.fbResScale;
    list.push({ name: 'trail res 50%', apply() { S.fbResScale = 0.5; }, undo() { S.fbResScale = was; } });
  }
  if ((hooks.screenDpr() || 1) > 2 && !(S.dprCap > 0 && S.dprCap <= 2)) {
    const was = S.dprCap;
    list.push({ name: 'pixel density 2x', apply() { S.dprCap = 2; }, undo() { S.dprCap = was; } });
  }
  list.push({ name: 'everything as set, again', base: true });
  return list;
}

function begin(now) {
  idx++;
  if (idx >= steps.length) { finish(); return; }
  const st = steps[idx];
  if (st.apply) st.apply();
  phase = 'settle';
  phaseT = now;
}

function finish() {
  energyWindowStop();
  hooks.fast(false);
  status = results.length ? 'done' : 'idle';
}

// main.js, every frame.
export function energyTestTick(now) {
  if (status !== 'running') return;
  if (phase === 'settle') {
    if (now - phaseT < SETTLE_MS) return;
    phase = 'measure';
    phaseT = now;
    energyWindowStart();
    return;
  }
  if (now - phaseT < MEASURE_MS) return;
  const st = steps[idx];
  results.push({ name: st.name, base: !!st.base, f: energyWindowTake() });
  if (st.undo) st.undo();
  begin(now);
}

// Puts the step in hand back and keeps what was measured so far.
export function energyTestStop() {
  if (status !== 'running') return;
  const st = steps[idx];
  if (st && st.undo) st.undo();
  stopped = true;
  finish();
}

// The chip's tap: start, stop, or (with results waiting) copy, which the
// caller does; this says which.
export function energyTestTap(now) {
  if (status === 'running') { energyTestStop(); return 'stopped'; }
  if (status === 'done') return 'copy';
  steps = buildSteps();
  idx = -1; results = []; stopped = false; copied = 0;
  status = 'running';
  hooks.fast(true);
  begin(now);
  return 'started';
}

// How the copy went: done, the chip goes back to Run energy test.
export function energyTestCopied(ok) {
  copied = ok ? 1 : -1;
  copiedAt = performance.now();
  if (ok) status = 'idle';
}

export function energyTestLabel(now) {
  if (status === 'running') {
    const left = Math.max(0, Math.ceil(((phase === 'settle' ? SETTLE_MS + MEASURE_MS : MEASURE_MS) - (now - phaseT)) / 1000));
    return (idx + 1) + '/' + steps.length + ' ' + steps[idx].name + ', ' + left + 's (tap stops)';
  }
  if (performance.now() - copiedAt < SAID_MS && copied) return copied > 0 ? 'Test results copied' : 'Copy refused, try again';
  if (status === 'done') return 'Copy test results';
  return 'Run energy test';
}

// ---------- the table (on the tap) ----------
const pad = (v, n) => { const s = String(v); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const padR = (v, n) => { const s = String(v); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

export function energyTestText() {
  if (!results.length) return '';
  const bases = results.filter(r => r.base && r.f && r.f.gpuPer >= 0).map(r => r.f.gpuPer);
  const base = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : -1;
  const baseJs = (() => {
    const b = results.filter(r => r.base && r.f && r.f.frames > 0);
    return b.length ? b.reduce((a, r) => a + r.f.jsPer, 0) / b.length : -1;
  })();
  const lines = [
    `Presence energy test${stopped ? ' (stopped early)' : ''}: one change at a time, ${SETTLE_MS / 1000} s to settle, ${MEASURE_MS / 1000} s measured, then put back`,
    `  gpu ms = submit to work done a frame; saved = against the mean of the two "everything as set" rows`,
    `  ${padR('step', 26)}   fps   js ms  gpu ms  gpu saved  light  samples`
  ];
  for (const r of results) {
    const f = r.f;
    if (!f) continue;
    const saved = base > 0 && f.gpuPer >= 0 && !r.base ? Math.round(100 * (base - f.gpuPer) / base) + '%' : '-';
    lines.push('  ' + padR(r.name, 26) + ' ' + [
      pad(f.fps.toFixed(1), 5), pad(f.jsPer.toFixed(2), 7), pad(f.gpuPer >= 0 ? f.gpuPer.toFixed(2) : '-', 7),
      pad(saved, 10), pad(f.light >= 0 ? Math.round(f.light * 100) + '%' : '-', 6), pad(f.gpuN + '/' + f.lightN, 8)
    ].join(' '));
  }
  if (bases.length === 2) lines.push(`  baseline drift  gpu ${bases[0].toFixed(2)} then ${bases[1].toFixed(2)} ms${baseJs >= 0 ? ', frame JS ' + baseJs.toFixed(2) + ' ms on average' : ''}`);
  return lines.join('\n');
}
