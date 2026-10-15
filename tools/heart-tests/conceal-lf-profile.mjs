// The concealment's low end, measured (js/heart/conceal.js): realistic
// signals rendered through the real Drain and Conceal under dropout
// patterns, and for every stall what the low band did going in, during,
// and at the heal, so a dip or a thump is a number and not an impression.
//
//   node tools/heart-tests/conceal-lf-profile.mjs            the whole table
//   node tools/heart-tests/conceal-lf-profile.mjs quick      pure tone only
//   node tools/heart-tests/conceal-lf-profile.mjs cost       microseconds a quantum
//
// The signals: the raw 40 Hz tone (the primary case: Robert hears the dip
// and the whump with the strobe's AM off); the tone under a full-depth
// raised-cosine AM at a strobe whose rate drifts 3 +/- 2 Hz over 26 s, as
// the strobe does; and that under a music-like layer of partials and a
// little noise. The measures, all on the left channel (the right is the
// same signal here):
//
//   low band     a 4th-order low-pass at 70 Hz, on the output and on the
//                program as it would have played with no dropout (the
//                drain drops late frames, so the live frame n is always the
//                program's frame n); the dip is the output's RMS over a
//                window against the program's over the same window, in dB,
//                at its worst in the region. `short` is a window of one
//                tone cycle (25 ms), which sees a notch; `long` is a window
//                of one AM cycle (the tone cycle with no AM), which sees
//                the pulse's level and not its timing.
//   sub band     a 4th-order low-pass at 15 Hz: nothing of the program
//                lives there (the tone is 40 Hz; the AM is sidebands of
//                it), so energy there is a thump, reported as its peak in
//                dB against the program's low-band RMS.
//   step         the largest change from one frame to the next, the click
//                measure the tests use.
//
// Entry is 25 ms before a stall to 250 ms into it; during is the stall to
// the heal; the heal is 25 ms before the live sound starts fading in to
// the Return fade and 300 ms more. Each config's row is the worst over its
// events. profile() is exported for the tests (conceal.test.mjs).

import { performance } from 'node:perf_hooks';
import { Drain } from '../../js/heart/drain-worklet.js';
import { Conceal, FORWARD, PINGPONG } from '../../js/heart/conceal.js';
import { SharedRing, CHUNK, QUANTUM } from '../../js/heart/ring.js';

const TONE_HZ = 40, TONE_AMP = 0.5;

// The program, `seconds` long at `rate`, and the strobe's rate at any frame
// (for the long window; the tone cycle when there is no AM).
export function makeProgram(kind, rate, seconds) {
  const n = Math.ceil(seconds * rate), prog = new Float32Array(n);
  const am = kind !== 'tone', music = kind === 'music';
  let phi = 0;
  const strobeRate = f => 3 + 2 * Math.sin(2 * Math.PI * (f / rate) / 26);
  let seed = 99;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  let nz = 0;
  for (let f = 0; f < n; f++) {
    const t = f / rate;
    let v = TONE_AMP * Math.sin(2 * Math.PI * TONE_HZ * t);
    if (am) {
      v *= 0.5 * (1 - Math.cos(2 * Math.PI * phi));
      phi += strobeRate(f) / rate;
    }
    if (music) {
      // A few partials, each swelling at its own slow rate, and some
      // smoothed noise well under them.
      v += 0.12 * Math.sin(2 * Math.PI * 165 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.13 * t))
         + 0.10 * Math.sin(2 * Math.PI * 247 * t + 1) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.21 * t))
         + 0.08 * Math.sin(2 * Math.PI * 330 * t + 2) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.07 * t))
         + 0.05 * Math.sin(2 * Math.PI * 494 * t + 3);
      nz += 0.05 * (rnd() - nz);
      v += 0.4 * nz;
    }
    prog[f] = v;
  }
  return { prog, period: f => am ? rate / strobeRate(f) : rate / TONE_HZ };
}

// A 4th-order Butterworth low-pass at `hz`, applied to `x` into a new array.
function lowpass(x, hz, rate) {
  const y = new Float32Array(x.length);
  const sections = [0.5412, 1.3066].map(Q => {
    const w = Math.tan(Math.PI * hz / rate), k = w * w, a0 = 1 + w / Q + k;
    return { b0: k / a0, b1: 2 * k / a0, b2: k / a0, a1: 2 * (k - 1) / a0, a2: (1 - w / Q + k) / a0, z1: 0, z2: 0 };
  });
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    for (const s of sections) {
      const o = s.b0 * v + s.z1;
      s.z1 = s.b1 * v - s.a1 * o + s.z2;
      s.z2 = s.b2 * v - s.a2 * o;
      v = o;
    }
    y[i] = v;
  }
  return y;
}

// Prefix sums of squares, for an RMS over any window in constant time.
function energy(x) {
  const e = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) e[i + 1] = e[i] + x[i] * x[i];
  return e;
}
const rmsAt = (e, at, win) => {
  const a = Math.max(0, at - (win >> 1)), b = Math.min(e.length - 1, a + win);
  return Math.sqrt((e[b] - e[a]) / Math.max(1, b - a));
};
const dB = x => 20 * Math.log10(Math.max(x, 1e-9));

// The worst of out/ref over [from, to) with window `win` (a function of the
// frame), only where the program itself is above a third of its loudest.
function worstDip(eOut, eRef, from, to, win, refPeak, step = 64) {
  let worst = Infinity;
  for (let f = Math.max(0, from); f < to && f < eOut.length - 1; f += step) {
    const w = win(f) | 0, r = rmsAt(eRef, f, w);
    if (r < 0.3 * refPeak) continue;
    const d = dB(rmsAt(eOut, f, w) / r);
    if (d < worst) worst = d;
  }
  return worst === Infinity ? 0 : worst;
}

function peakAbs(x, from, to) {
  let p = 0;
  for (let f = Math.max(0, from); f < to && f < x.length; f++) { const v = Math.abs(x[f]); if (v > p) p = v; }
  return p;
}

function maxStep(x, from, to) {
  let m = 0;
  for (let f = Math.max(1, from); f < to && f < x.length; f++) { const d = Math.abs(x[f] - x[f - 1]); if (d > m) m = d; }
  return m;
}

// One run: the drain plays `program` through `pattern` (quanta: gap, sound,
// gap, ...) with the concealment set as given. Returns the per-event
// measures, their worst, the output, and the cost per quantum.
export function profile({ kind = 'tone', rate = 48000, mode = FORWARD, wash = 0, quantize = true, xfade = 0.05,
  ret = 0.75, loop = 0.5, washRise = 1.5, washDecay = 4, pattern = [75], warm = 4, tail = 6, program = null, strobeTold = true } = {}) {
  const patternFrames = pattern.reduce((a, b) => a + b, 0) * QUANTUM;
  const seconds = warm + patternFrames / rate + tail;
  const { prog, period } = program || makeProgram(kind, rate, seconds);
  const ring = new SharedRing(SharedRing.describe(2, 1 << 15));
  const ahead = Math.round(0.05 * rate);
  const drain = new Drain({ post: () => {}, conceal: Math.round(2.5 * rate), concealSet: {
    loop: Math.round(loop * rate), xfade: Math.round(xfade * rate), mode, quantize, wash,
    washRise: Math.round(washRise * rate), washDecay, ret: Math.round(ret * rate), hold: 3 * rate, rate } });
  drain.attach(ring);
  const c = drain.conceal;
  const src = new Float32Array(CHUNK);
  let written = 0;
  const feed = () => {
    while (written < (drain.played + 1) * QUANTUM + ahead && ring.writable() >= CHUNK) {
      for (let i = 0; i < CHUNK; i++) src[i] = written + i < prog.length ? prog[written + i] : 0;
      ring.write(0, src, 0, CHUNK); ring.write(1, src, 0, CHUNK); ring.commit(CHUNK); written += CHUNK;
    }
  };
  const total = Math.floor(prog.length / QUANTUM), out = new Float32Array(total * QUANTUM);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  const events = [];
  const starts = [];
  const start0 = c.start.bind(c);
  c.start = () => { starts.push(drain.played * QUANTUM); start0(); };
  const warmQ = Math.round(warm * rate / QUANTUM);
  const tell = () => c.setPeriods(rate / TONE_HZ, strobeTold ? period(drain.played * QUANTUM) : 0);
  let wasOut = 0, busy = 0, busyN = 0, busyMax = 0;
  for (let q = 0; q < total; q++) {
    if (q === warmQ) drain.simulate(Int32Array.from(pattern));
    if (q % 187 === 0) tell();
    feed();
    const t0 = performance.now();
    drain.play(L, R, 0);
    const dt = performance.now() - t0;
    if (c.active || c.room.awake) { busy += dt; busyN++; if (dt > busyMax) busyMax = dt; }
    out.set(L, q * QUANTUM);
    if (c.out > 0 && wasOut === 0) events.push({ start: starts[starts.length - 1], heal: (q + 1) * QUANTUM - c.out, ret: c.ret });
    wasOut = c.out;
  }
  // The measures.
  const loOut = lowpass(out, 70, rate), loRef = lowpass(prog, 70, rate);
  const subOut = lowpass(out, 15, rate), subRef = lowpass(prog, 15, rate);
  const eOut = energy(loOut), eRef = energy(loRef);
  const tone = Math.round(rate / TONE_HZ);
  const level = rmsAt(eRef, prog.length >> 1, prog.length - 2);
  let refPeak = 0;
  for (let f = tone; f < prog.length - tone; f += 64) refPeak = Math.max(refPeak, rmsAt(eRef, f, tone));
  const ms = x => Math.round(x / 1000 * rate);
  const shortWin = () => tone, longWin = f => Math.max(tone, Math.round(period(f)));
  const floorSub = dB(peakAbs(subRef, 0, prog.length) / level);
  const refStep = maxStep(prog, 0, prog.length);
  for (const ev of events) {
    const s = ev.start, h = ev.heal, end = h + ev.ret + ms(300);
    ev.entryDip = worstDip(eOut, eRef, s - ms(25), s + ms(250), shortWin, refPeak);
    ev.entryWhump = dB(peakAbs(subOut, s - ms(25), s + ms(250)) / level);
    ev.duringDip = worstDip(eOut, eRef, s, h, longWin, refPeak);
    ev.healDipShort = worstDip(eOut, eRef, h - ms(25), end, shortWin, refPeak);
    ev.healDipLong = worstDip(eOut, eRef, h - ms(25), end, longWin, refPeak);
    ev.healWhump = dB(peakAbs(subOut, h - ms(25), end) / level);
    ev.step = maxStep(out, s - 1, end);
  }
  const worst = { entryDip: 0, entryWhump: -Infinity, duringDip: 0, healDipShort: 0, healDipLong: 0, healWhump: -Infinity, step: 0 };
  for (const ev of events) {
    for (const k of ['entryDip', 'duringDip', 'healDipShort', 'healDipLong']) worst[k] = Math.min(worst[k], ev[k]);
    for (const k of ['entryWhump', 'healWhump', 'step']) worst[k] = Math.max(worst[k], ev[k]);
  }
  return { events, worst, out, prog, floorSub, refStep, level, cost: { mean: busyN ? 1000 * busy / busyN : 0, max: 1000 * busyMax } };
}

export const PATTERNS = {
  'one 200 ms': [75],
  '14 x 200 ms': (() => { const p = []; for (let i = 0; i < 14; i++) { if (i) p.push(75); p.push(75); } return p; })(),
  'one 600 ms': [225]
};

function main(quick) {
  const kinds = quick ? ['tone'] : ['tone', 'am', 'music'];
  const rates = quick ? [48000] : [48000, 44100];
  const f1 = x => (x > 0 ? '+' : '') + x.toFixed(1);
  console.log('signal  rate   mode      wash  quant  pattern      | entry dip  entry thump | during dip | heal dip short/long  heal thump | step   | us/quantum mean/max');
  for (const rate of rates) for (const kind of kinds) for (const mode of [0, FORWARD]) for (const wash of [0, 0.6]) for (const quantize of [true, false]) for (const [name, pattern] of Object.entries(PATTERNS)) {
    if (rate !== 48000 && (kind !== 'tone' || name !== '14 x 200 ms')) continue;
    const r = profile({ kind, rate, mode, wash, quantize, pattern });
    const w = r.worst;
    console.log(`${kind.padEnd(7)} ${rate} ${(mode === FORWARD ? 'forward' : 'ping-pong').padEnd(9)} ${String(wash).padEnd(5)} ${(quantize ? 'on' : 'off').padEnd(6)} ${name.padEnd(12)} | ${f1(w.entryDip).padStart(6)} dB  ${f1(w.entryWhump).padStart(6)} dB   | ${f1(w.duringDip).padStart(6)} dB  | ${f1(w.healDipShort).padStart(6)} / ${f1(w.healDipLong).padStart(6)} dB  ${f1(w.healWhump).padStart(6)} dB | ${w.step.toFixed(4)} | ${r.cost.mean.toFixed(0)} / ${r.cost.max.toFixed(0)}`);
  }
  const ref = profile({ kind: 'tone', pattern: [1] });
  console.log(`\nfloor: the program's own sub band peaks at ${f1(ref.floorSub)} dB, its largest step is ${ref.refStep.toFixed(4)}`);
}

// The cost on the audio thread, in microseconds a quantum: a stall's
// quantum (the loop, the wash on and off), a heal's, a wet quantum between
// stalls (the crossover following the sound, the room asleep), and the one
// search, a stall's start with the tone's phase measured. Each is the mean
// of many after a warm-up, so the JIT's first runs are not counted.
function cost(rate = 48000) {
  const { prog } = makeProgram('music', rate, 6);
  const make = wash => new Conceal({ size: Math.round(2.5 * rate), loop: Math.round(0.5 * rate), xfade: Math.round(0.05 * rate),
    mode: PINGPONG, wash, washRise: Math.round(1.5 * rate), washDecay: 4, ret: Math.round(0.75 * rate), hold: 3 * rate, rate });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  const fill = f => { for (let i = 0; i < QUANTUM; i++) L[i] = R[i] = prog[(f + i) % prog.length]; };
  const time = (label, c, prep, body, reps = 2000) => {
    let f = 0;
    for (let q = 0; q < 2000; q++, f += QUANTUM) { fill(f); c.wet(L, R); }
    prep(c);
    for (let q = 0; q < 200; q++, f += QUANTUM) body(c, f);
    const t0 = performance.now();
    for (let q = 0; q < reps; q++, f += QUANTUM) body(c, f);
    console.log(`${label.padEnd(44)} ${(1000 * (performance.now() - t0) / reps).toFixed(1)} us`);
  };
  for (const wash of [0, 0.6]) {
    const c = make(wash);
    c.setPeriods(rate / TONE_HZ, 0);
    time(`stall quantum, wash ${wash}`, c, () => {}, (c, f) => c.dry(L, R));
    time(`heal quantum, wash ${wash}`, c, c => { c.dry(L, R); }, (c, f) => { fill(f); if (!c.active) c.dry(L, R); else c.wet(L, R); });
    time(`wet quantum between stalls, wash ${wash}`, c, () => {}, (c, f) => { fill(f); c.wet(L, R); });
  }
  const c = make(0);
  c.setPeriods(rate / TONE_HZ, 0);
  time('a stall starting (the phase measured)', c, () => {}, (c, f) => { fill(f); c.wet(L, R); c.start(); c.active = false; c.out = 0; });
  time('the phase alone', c, () => {}, (c, f) => { c.phase(); }, 5000);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  if (process.argv.includes('cost')) cost(); else main(process.argv.includes('quick'));
}
