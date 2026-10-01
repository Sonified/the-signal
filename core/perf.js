// Frame-cost instrumentation, off unless localStorage 'signal_perf' is '1'.
// main.js reads that flag once at boot (through the platform) and, when it is
// off, never calls anything here, so the switch costs nothing in normal use.
//
// v0 taught the lesson this exists for: a strobe can flash while every
// per-frame JS timing looks clean, because the lost frame was spent somewhere
// the timings never looked (presentation, a GPU pass, a collector pause).
// So this records the CPU phases of every frame, which path the engine took
// (straight to the swap chain or via sceneTex, with or without a blur
// capture), the GPU pass times when the adapter offers timestamp queries,
// and every long frame of the session with the time it happened, so a stall
// that comes back on a steady period shows up as a steady spacing even when
// it falls outside the last 180 frames the raw interval list keeps.
//
// Everything is typed arrays written in place. Turning the numbers into text
// happens only in perfLines(), on the Copy diagnostics click, where
// allocating is fine.

const N = 180;                 // rolling window, frames
const PHASES = 6;
const PHASE_NAMES = ['input', 'sim', 'ui build', 'render', 'after render', 'whole frame'];
const LONG_KEEP = 10;          // long frames remembered for the whole session
const MEDIAN_EVERY = 60;       // frames between median refreshes

export const perf = { on: false };

const phaseMs = new Float32Array(PHASES * N);
const directRing = new Uint8Array(N);
const captureRing = new Uint8Array(N);
const skipRing = new Uint8Array(N);
let head = 0, filled = 0;

let gpu = null;

// frame intervals, for the long-frame log
const intervals = new Float32Array(N);
const sortScratch = new Float32Array(N);
let ivHead = 0, ivFilled = 0, lastT = -1, sinceMedian = 0, median = 0;
let longCount = 0, worstMs = 0, worstAt = 0;
const longAt = new Float64Array(LONG_KEEP);
const longMs = new Float32Array(LONG_KEEP);
let longHead = 0, longFilled = 0;

export function perfAttachGpu(g) { gpu = g; }

// Called first thing in a frame with its rAF timestamp. A frame whose
// interval runs past one and a half times the recent median is a long frame:
// at 120 Hz with a 2-lit-1-dark pattern that is a held frame the eye can
// catch. Tab switches (a second or more) are not stalls and are skipped.
export function perfFrameStart(t) {
  if (lastT >= 0) {
    const iv = t - lastT;
    if (iv > 0 && iv < 1000) {
      intervals[ivHead] = iv;
      ivHead = (ivHead + 1) % N;
      if (ivFilled < N) ivFilled++;
      if (++sinceMedian >= MEDIAN_EVERY || median === 0) {
        sinceMedian = 0;
        if (ivFilled >= 30) median = medianOf(intervals, ivFilled);
      }
      if (median > 0 && iv > median * 1.5) {
        longCount++;
        longAt[longHead] = t;
        longMs[longHead] = iv;
        longHead = (longHead + 1) % LONG_KEEP;
        if (longFilled < LONG_KEEP) longFilled++;
        if (iv > worstMs) { worstMs = iv; worstAt = t; }
      }
    }
  }
  lastT = t;
}

// Sorts a copy in place in a scratch array that already exists; unused slots
// are pushed to the end so only the live samples decide the middle.
function medianOf(src, count) {
  for (let i = 0; i < N; i++) sortScratch[i] = i < count ? src[i] : Infinity;
  sortScratch.sort();
  return sortScratch[count >> 1];
}

// One frame's worth of CPU phases (ms) and what the engine did with it.
export function perfRecord(input, sim, ui, render, post, total, direct, capture, skipped) {
  const o = head * PHASES;
  phaseMs[o] = input; phaseMs[o + 1] = sim; phaseMs[o + 2] = ui;
  phaseMs[o + 3] = render; phaseMs[o + 4] = post; phaseMs[o + 5] = total;
  directRing[head] = direct ? 1 : 0;
  captureRing[head] = capture ? 1 : 0;
  skipRing[head] = skipped ? 1 : 0;
  head = (head + 1) % N;
  if (filled < N) filled++;
}

// ---- text, on demand only ----

const f2 = v => v.toFixed(2);
const pad = (s, n) => (s + '                ').slice(0, n);

// The extra diagnostics lines, or none when perf mode is off. Appended to the
// frame section of Copy diagnostics.
export function perfLines() {
  if (!perf.on) return [];
  const out = [];
  out.push(`perf mode       signal_perf on, last ${filled} frames`);
  out.push(`cpu ms          p50 / p95 / max`);
  const col = [];
  for (let p = 0; p < PHASES; p++) {
    col.length = 0;
    for (let i = 0; i < filled; i++) col.push(phaseMs[i * PHASES + p]);
    col.sort((a, b) => a - b);
    const q = x => col.length ? col[Math.min(col.length - 1, Math.floor(col.length * x))] : 0;
    out.push(`  ${pad(PHASE_NAMES[p], 14)}${f2(q(0.5))} / ${f2(q(0.95))} / ${f2(col[col.length - 1] || 0)}`);
  }
  let direct = 0, capture = 0, skipped = 0;
  for (let i = 0; i < filled; i++) { direct += directRing[i]; capture += captureRing[i]; skipped += skipRing[i]; }
  out.push(`render path     direct ${direct}   via sceneTex ${filled - direct}   blur captures ${capture}   ui build skipped ${skipped}`);
  if (!gpu || !gpu.supported) {
    out.push(`gpu ms          timestamp-query not offered by this adapter`);
  } else if (!gpu.samples) {
    out.push(`gpu ms          no sample read back yet`);
  } else {
    const parts = [];
    if (gpu.directSamples) parts.push(`direct pass ${f2(gpu.directMs)} (max ${f2(gpu.directMax)})`);
    if (gpu.samples > gpu.directSamples) {
      parts.push(`scene ${f2(gpu.sceneMs)} (max ${f2(gpu.sceneMax)})`);
      parts.push(`final ${f2(gpu.finalMs)} (max ${f2(gpu.finalMax)})`);
    }
    parts.push(gpu.blurSamples ? `blur ${f2(gpu.blurMs)} (max ${f2(gpu.blurMax)})` : 'blur not sampled');
    out.push(`gpu ms          ${parts.join('   ')}   (${gpu.samples} samples)`);
  }
  out.push(`long frames     ${longCount} this session (> 1.5x median ${f2(median)} ms)` +
           (longCount ? `, worst ${worstMs.toFixed(1)} ms at ${(worstAt / 1000).toFixed(1)} s` : ''));
  if (longFilled) {
    const at = [], gaps = [];
    for (let k = 0; k < longFilled; k++) {
      const i = (longHead - longFilled + k + LONG_KEEP) % LONG_KEEP;
      at.push(`${(longAt[i] / 1000).toFixed(1)} s ${longMs[i].toFixed(1)} ms`);
      if (k > 0) {
        const prev = (i - 1 + LONG_KEEP) % LONG_KEEP;
        gaps.push(`${((longAt[i] - longAt[prev]) / 1000).toFixed(1)} s`);
      }
    }
    out.push(`  latest        ${at.join(', ')}`);
    if (gaps.length) out.push(`  spacing       ${gaps.join(', ')}`);
  }
  return out;
}
