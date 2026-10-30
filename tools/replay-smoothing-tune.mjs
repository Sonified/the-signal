// Replay smoothing, tuned from a real tape (core/brush-smooth.js): what the
// drawn points look like (how often they come, how noisy they are, how fast
// the hands move), then the One Euro filter's settings and Auto's factor
// searched for the knee between a smooth pen and a faithful one.
//
//   node tools/replay-smoothing-tune.mjs [tape.json] [--strokes N]
//
// Every stroke is run batch by batch through the very smoothBatch the
// playback uses, at the Replay speed's slowest (0.05x, scale 20), where the
// ticking showed. Two numbers for each setting, both on the stroke's own
// drawing time:
//
//   lag     RMS distance between the smoothed pen and the drawn polyline
//           (as the brush plays it unsmoothed) at the same moment, in
//           unit-square units, and as a share of a mark's side (brushSide
//           of the tape's typical width): what the smoothing costs.
//   accel   RMS acceleration of the pen as it is played (the polyline of
//           its output points, straight and even between them, as
//           timelineAt reads it), unit-square sides a second squared: a
//           corner is a sudden change of velocity, so this is how much the
//           pen ticks. The unsmoothed reference is the drawn polyline's.
//
// The knee is the point of the settings' Pareto front (lower lag, lower
// accel) farthest below the straight line between its two ends, both axes
// scaled to the front's own range: past it, each step smoother costs more
// lag than the one before.

import { readFileSync } from 'node:fs';
import { decodeStroke, MOTIF } from '../touch/strokes.js';
import { brushSide } from '../core/brush-stamps.js';
import { smoothBatch, smoothState, smoothOut, smoothParams, SUB_MAX, SETTLE_MAX } from '../core/brush-smooth.js';

const args = process.argv.slice(2);
const nIdx = args.indexOf('--strokes');
const tapePath = args.find((a, i) => !a.startsWith('--') && i !== nIdx + 1) || new URL('../tapes/win-1792736009664-n58524.json', import.meta.url).pathname;
const SAMPLE = nIdx >= 0 ? +args[nIdx + 1] : 400;
const SCALE = 20;   // 0.05x

// ---------- the strokes ----------
const tape = JSON.parse(readFileSync(tapePath, 'utf8'));
const strokes = [];          // { batches: [{ T, U, V, d }], t, u, v, w }
const open = new Map();
let prints = 0, untimed = 0;
for (const e of tape.entries || []) {
  const s = e && e.s && decodeStroke(e.s);
  if (!s || s.k !== MOTIF) continue;
  if (!s.times) { untimed++; continue; }
  if (s.r < 1) { prints++; continue; }   // prints are never smoothed
  let st = open.get(e.id);
  if (st && s.d === 0) { strokes.push(st); st = null; }
  if (!st) {
    if (s.d !== 0) continue;               // joined mid-stroke: its start is not on the tape
    st = { batches: [], t: [], u: [], v: [], w: s.w };
    open.set(e.id, st);
  }
  const b = { T: s.times, U: s.points.map(p => p.u), V: s.points.map(p => p.v), d: s.d };
  st.batches.push(b);
  for (let j = s.d === 0 ? 0 : 1; j < b.T.length; j++) { st.t.push(b.T[j]); st.u.push(b.U[j]); st.v.push(b.V[j]); }
  if (s.d === 2) { strokes.push(st); open.delete(e.id); }
}
for (const st of open.values()) strokes.push(st);

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const fmt = (x, d = 3) => Number(x.toPrecision(d));

// ---------- what the data is ----------
const gaps = [], speeds = [], perBatch = [], widths = [];
let resid2 = 0, residN = 0;
for (const st of strokes) {
  widths.push(st.w);
  for (const b of st.batches) perBatch.push(b.T.length - (b.d === 0 ? 0 : 1));
  const { t, u, v } = st;
  for (let i = 1; i < t.length; i++) {
    const g = t[i] - t[i - 1];
    gaps.push(g);
    if (g > 0 && g < 100) speeds.push(Math.hypot(u[i] - u[i - 1], v[i] - v[i - 1]) / g * 1000);
  }
  // noise: residual of each point from a quadratic in time fitted to the
  // 7 around it (dof-corrected), where the points come evenly (no gap over
  // 40 ms, none at one time): the hand's curve is smooth at that scale, so
  // what a quadratic cannot follow is the sensor's and the grid's scatter
  for (let i = 3; i + 3 < t.length; i++) {
    let ok = true;
    for (let k = i - 2; k <= i + 3; k++) { const g = t[k] - t[k - 1]; if (!(g > 0 && g <= 40)) ok = false; }
    if (!ok) continue;
    for (const P of [u, v]) {
      // least squares a + b x + c x^2 over x = t - t[i]
      let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, Y0 = 0, Y1 = 0, Y2 = 0;
      for (let k = i - 3; k <= i + 3; k++) {
        const x = t[k] - t[i], y = P[k], x2 = x * x;
        S0++; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2; Y0 += y; Y1 += x * y; Y2 += x2 * y;
      }
      const det = S0 * (S2 * S4 - S3 * S3) - S1 * (S1 * S4 - S3 * S2) + S2 * (S1 * S3 - S2 * S2);
      if (!(Math.abs(det) > 0)) continue;
      const a = (Y0 * (S2 * S4 - S3 * S3) - S1 * (Y1 * S4 - S3 * Y2) + S2 * (Y1 * S3 - S2 * Y2)) / det;
      const r = P[i] - a;
      resid2 += r * r * 7 / 4; residN++;
    }
  }
}
gaps.sort((a, b) => a - b); speeds.sort((a, b) => a - b); perBatch.sort((a, b) => a - b); widths.sort((a, b) => a - b);
const side = brushSide(pct(widths, 0.5));
const noise = Math.sqrt(resid2 / residN);
const zeroGaps = gaps.filter(g => g === 0).length / gaps.length;
console.log('tape: ' + strokes.length + ' strokes, ' + gaps.length + ' point gaps (' + prints + ' print batches, ' + untimed + ' untimed, left out)');
console.log('gap ms: p10 ' + pct(gaps, 0.1) + ', median ' + pct(gaps, 0.5) + ', p90 ' + pct(gaps, 0.9) + ', p99 ' + pct(gaps, 0.99) +
  '; ' + fmt(zeroGaps * 100, 2) + '% at one ms; about ' + Math.round(1000 / pct(gaps, 0.5)) + ' points a second; ' + pct(perBatch, 0.5) + ' new points a batch');
console.log('speed (sides/s): p10 ' + fmt(pct(speeds, 0.1)) + ', median ' + fmt(pct(speeds, 0.5)) + ', p90 ' + fmt(pct(speeds, 0.9)));
console.log('noise: ' + fmt(noise) + ' sides RMS (' + fmt(noise * 4096, 2) + ' wire steps, ' + fmt(noise / side * 100, 2) + '% of a mark\'s side ' + fmt(side) + ')');

// ---------- the simulation ----------
// a fixed sample of strokes with some length to them
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const long = strokes.filter(s => s.t.length >= 20);
for (let i = long.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [long[i], long[j]] = [long[j], long[i]]; }
const sample = long.slice(0, SAMPLE);

// the drawn polyline at time x, as timelineAt plays it
function rawAt(st, x, c) {
  const t = st.t;
  while (c.i + 1 < t.length && t[c.i + 1] <= x) c.i++;
  const i = c.i;
  if (i + 1 >= t.length || x <= t[i]) { c.u = st.u[i]; c.v = st.v[i]; return; }
  const k = (x - t[i]) / (t[i + 1] - t[i]);
  c.u = st.u[i] + (st.u[i + 1] - st.u[i]) * k; c.v = st.v[i] + (st.v[i + 1] - st.v[i]) * k;
}
// RMS acceleration of a polyline played straight and even between its points
function accelOf(t, u, v, n, acc) {
  for (let k = 1; k + 1 < n; k++) {
    const h0 = t[k] - t[k - 1], h1 = t[k + 1] - t[k];
    if (!(h0 > 0 && h1 > 0)) continue;
    const au = ((u[k + 1] - u[k]) / h1 - (u[k] - u[k - 1]) / h0) / ((h0 + h1) / 2) * 1e6;
    const av = ((v[k + 1] - v[k]) / h1 - (v[k] - v[k - 1]) / h0) / ((h0 + h1) / 2) * 1e6;
    const w = (h0 + h1) / 2;
    acc.s += (au * au + av * av) * w; acc.w += w;
  }
}
const ot = [], ou = [], ov = [];
function run(mode, setMs = 0) {
  const lag = { s: 0, w: 0 }, acc = { s: 0, w: 0 };
  let joints = 0, maxBatch = 0, outPts = 0;
  for (const st of sample) {
    const S = smoothState();
    ot.length = ou.length = ov.length = 0;
    for (const b of st.batches) {
      const n = smoothBatch(mode, setMs, b.T, b.U, b.V, b.T.length, b.d, SCALE, S, b.d === 2);
      if (n > maxBatch) maxBatch = n;
      if (b.d !== 0 && ot.length && (smoothOut.u[0] !== ou[ou.length - 1] || smoothOut.v[0] !== ov[ov.length - 1])) joints++;
      for (let j = b.d === 0 || !ot.length ? 0 : 1; j < n; j++) { ot.push(smoothOut.t[j]); ou.push(smoothOut.u[j]); ov.push(smoothOut.v[j]); }
    }
    outPts += ot.length;
    const c = { i: 0, u: 0, v: 0 };
    for (let k = 1; k < ot.length; k++) {
      rawAt(st, ot[k], c);
      const w = ot[k] - ot[k - 1], d2 = (ou[k] - c.u) ** 2 + (ov[k] - c.v) ** 2;
      lag.s += d2 * w; lag.w += w;
    }
    accelOf(ot, ou, ov, ot.length, acc);
  }
  return { lag: Math.sqrt(lag.s / lag.w), accel: Math.sqrt(acc.s / acc.w), joints, maxBatch, outPts };
}
const rawAcc = { s: 0, w: 0 };
let rawPts = 0;
for (const st of sample) { accelOf(st.t, st.u, st.v, st.t.length, rawAcc); rawPts += st.t.length; }
const rawAccel = Math.sqrt(rawAcc.s / rawAcc.w);
console.log('sample: ' + sample.length + ' strokes, played at 0.05x; drawn polyline accel ' + fmt(rawAccel) + ' sides/s^2');

function knee(rows) {
  const front = rows.filter(r => !rows.some(o => o !== r && o.lag <= r.lag && o.accel <= r.accel && (o.lag < r.lag || o.accel < r.accel)))
    .sort((a, b) => a.lag - b.lag);
  const a = front[0], z = front[front.length - 1];
  const nx = r => (r.lag - a.lag) / (z.lag - a.lag || 1), ny = r => (r.accel - z.accel) / (a.accel - z.accel || 1);
  let best = a, bd = -Infinity;
  for (const r of front) { const d = (1 - nx(r)) - ny(r); if (d > bd) { bd = d; best = r; } }   // below the chord ny = 1 - nx
  return { best, front };
}
const line = r => 'lag ' + fmt(r.lag) + ' (' + fmt(r.lag / side * 100, 2) + '% of a mark), accel ' + fmt(r.accel) + ' (' + fmt(r.accel / rawAccel * 100, 2) + '% of drawn)';

// ---------- Auto ----------
const autoRows = [];
for (const f of [0.1, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 5]) {
  smoothParams.autoFactor = f;
  autoRows.push(Object.assign({ f }, run(1)));
}
const ak = knee(autoRows);
console.log('Auto front: ' + ak.front.map(r => r.f + ':' + fmt(r.lag / side * 100, 2) + '%/' + fmt(r.accel / rawAccel * 100, 2) + '%').join('  '));
console.log('Auto knee: factor ' + ak.best.f + ', ' + line(ak.best));

// ---------- One Euro ----------
const euroRows = [];
smoothParams.euroDHz = 1;
for (const m of [0.25, 0.5, 1, 2, 3, 5, 8, 12]) {
  for (const b of [0, 1, 3, 10, 30, 100]) {
    smoothParams.euroMinHz = m; smoothParams.euroBeta = b;
    euroRows.push(Object.assign({ m, b }, run(3)));
  }
}
const ek = knee(euroRows);
console.log('1€ front: ' + ek.front.map(r => r.m + '/' + r.b + ':' + fmt(r.lag / side * 100, 2) + '%/' + fmt(r.accel / rawAccel * 100, 2) + '%').join('  '));
console.log('1€ knee: min cutoff ' + ek.best.m + ' Hz, beta ' + ek.best.b + ', d cutoff 1 Hz, ' + line(ek.best));

// ---------- the bounds ----------
const r = ek.best;
console.log('points: ' + fmt(r.outPts / rawPts) + 'x the drawn at 0.05x, at most ' + r.maxBatch + ' a batch (cap ' + (SUB_MAX + SETTLE_MAX + 1) + '); joints off by any: ' + (r.joints + ak.best.joints));
