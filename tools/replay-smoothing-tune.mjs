// Replay smoothing, tuned from a real tape (core/brush-smooth.js): what the
// drawn points look like (how often they come, how noisy they are, how fast
// the hands move), then the One Euro filter's settings and Auto's factor
// searched for the knee between a smooth pen and a faithful one.
//
//   node tools/replay-smoothing-tune.mjs [tape.json] [--strokes N]
//
// Every stroke is run batch by batch through the very smoothBatch the
// playback uses, at the Replay speed's slowest (0.05x, scale 20), where the
// ticking showed. For each setting, on the stroke's own drawing time:
//
//   off the line  RMS distance from the smoothed pen to the drawn polyline
//                 wherever along it (its shape), in unit-square sides and
//                 as a share of a mark's side (brushSide of the tape's
//                 typical width): what the smoothing costs. In a playback
//                 nothing shows how late the pen is, only where it goes.
//   lag           the same at equal moments, printed beside it.
//   accel         RMS acceleration of the pen as it is seen (its points
//                 played straight and even between them, as timelineAt
//                 reads them, looked at once a frame of a 60 Hz screen):
//                 a corner is a whole change of velocity inside one frame,
//                 the tick. The reference is the drawn polyline's own.
//
// Two picks from each Pareto front (less off the line, less accel): the
// knee, the point farthest below the straight line between the front's
// ends with both axes scaled to its range, past which each step smoother
// costs more fidelity than the one before; and the smoothest point that
// stays within the drawing's own scatter (a slow hand's residual, which is
// the sensor's), since straying less than the points already stray from
// the hand's true path is no loss. Takes about 20 s.

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
const resid = [];   // [speed, squared residual a axis]
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
  // 40 ms, none at one time), sorted by the pen's speed there. A slow hand's
  // curve is smooth at that scale, so what a quadratic cannot follow there
  // is the sensor's and the wire grid's scatter; a fast one's residual is
  // mostly the curve itself turning faster than a quadratic can.
  for (let i = 3; i + 3 < t.length; i++) {
    let ok = true;
    for (let k = i - 2; k <= i + 3; k++) { const g = t[k] - t[k - 1]; if (!(g > 0 && g <= 40)) ok = false; }
    if (!ok) continue;
    const sp = Math.hypot(u[i + 3] - u[i - 3], v[i + 3] - v[i - 3]) / (t[i + 3] - t[i - 3]) * 1000;
    let r2 = 0;
    for (const P of [u, v]) {
      // least squares a + b x + c x^2 over x = t - t[i]
      let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, Y0 = 0, Y1 = 0, Y2 = 0;
      for (let k = i - 3; k <= i + 3; k++) {
        const x = t[k] - t[i], y = P[k], x2 = x * x;
        S0++; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2; Y0 += y; Y1 += x * y; Y2 += x2 * y;
      }
      const det = S0 * (S2 * S4 - S3 * S3) - S1 * (S1 * S4 - S3 * S2) + S2 * (S1 * S3 - S2 * S2);
      if (!(Math.abs(det) > 0)) { r2 = NaN; break; }
      const a = (Y0 * (S2 * S4 - S3 * S3) - S1 * (Y1 * S4 - S3 * Y2) + S2 * (Y1 * S3 - S2 * Y2)) / det;
      r2 += (P[i] - a) ** 2 * 7 / 4 / 2;   // per axis
    }
    if (r2 === r2) resid.push([sp, r2]);
  }
}
gaps.sort((a, b) => a - b); speeds.sort((a, b) => a - b); perBatch.sort((a, b) => a - b); widths.sort((a, b) => a - b);
const side = brushSide(pct(widths, 0.5));
resid.sort((a, b) => a[0] - b[0]);
const rmsOf = (lo, hi) => { let a = 0, n = 0; for (let i = Math.floor(lo * resid.length); i < Math.floor(hi * resid.length); i++) { a += resid[i][1]; n++; } return Math.sqrt(a / n); };
const noiseSlow = rmsOf(0, 0.25), noiseMid = rmsOf(0.25, 0.75), noiseFast = rmsOf(0.75, 1);
const spAt = p => resid[Math.floor(p * (resid.length - 1))][0];
const zeroGaps = gaps.filter(g => g === 0).length / gaps.length;
console.log('tape: ' + strokes.length + ' strokes, ' + gaps.length + ' point gaps (' + prints + ' print batches, ' + untimed + ' untimed, left out)');
console.log('gap ms: p10 ' + pct(gaps, 0.1) + ', median ' + pct(gaps, 0.5) + ', p90 ' + pct(gaps, 0.9) + ', p99 ' + pct(gaps, 0.99) +
  '; ' + fmt(zeroGaps * 100, 2) + '% at one ms; about ' + Math.round(1000 / pct(gaps, 0.5)) + ' points a second; ' + pct(perBatch, 0.5) + ' new points a batch');
console.log('speed (sides/s): p10 ' + fmt(pct(speeds, 0.1)) + ', median ' + fmt(pct(speeds, 0.5)) + ', p90 ' + fmt(pct(speeds, 0.9)));
const nz = x => fmt(x, 2) + ' (' + fmt(x * 4096, 2) + ' steps, ' + fmt(x / side * 100, 2) + '%)';
console.log('scatter a axis RMS, sides (wire steps, share of a mark\'s side ' + fmt(side) + '): slowest quarter (under ' + fmt(spAt(0.25), 2) + '/s) ' + nz(noiseSlow) +
  ', middle half ' + nz(noiseMid) + ', fastest quarter (over ' + fmt(spAt(0.75), 2) + '/s) ' + nz(noiseFast) + '; the grid alone is 0.29 steps');

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
// The pen's RMS acceleration as it is seen: a polyline played straight and
// even between its points (as timelineAt reads it), looked at once a frame
// of a 60 Hz screen at 0.05x (FRAME ms of drawing time), the acceleration
// from each three looks in a row. A corner in the drawn line is a whole
// change of velocity inside one frame, which is the tick; the same change
// eased over tau shows as Δv / tau spread over tau / FRAME frames.
const FRAME = 1000 / 60 / SCALE;
function lineAt(t, u, v, c, x) {
  while (c.i + 1 < t.length && t[c.i + 1] <= x) c.i++;
  const i = c.i;
  if (i + 1 >= t.length || x <= t[i]) { c.u = u[i]; c.v = v[i]; return; }
  const k = (x - t[i]) / (t[i + 1] - t[i]);
  c.u = u[i] + (u[i + 1] - u[i]) * k; c.v = v[i] + (v[i + 1] - v[i]) * k;
}
function accelOf(t, u, v, t1, acc) {
  const c = { i: 0, u: 0, v: 0 };
  let pu = NaN, pv = NaN, qu = NaN, qv = NaN;
  for (let x = t[0]; x <= t1; x += FRAME) {
    lineAt(t, u, v, c, x);
    if (qu === qu) {
      const au = (c.u - 2 * pu + qu) / (FRAME * FRAME) * 1e6, av = (c.v - 2 * pv + qv) / (FRAME * FRAME) * 1e6;
      acc.s += au * au + av * av; acc.w++;
    }
    qu = pu; qv = pv; pu = c.u; pv = c.v;
  }
}
// How far a point lies from the drawn polyline, wherever along it (the
// line's shape, not its timing), searching its segments near index i.
function offLine(st, i, pu, pv) {
  let best = Infinity;
  const lo = Math.max(0, i - 12), hi = Math.min(st.t.length - 1, i + 12);
  for (let k = lo; k < hi; k++) {
    const au = st.u[k], av = st.v[k], du = st.u[k + 1] - au, dv = st.v[k + 1] - av, L = du * du + dv * dv;
    let f = L > 0 ? ((pu - au) * du + (pv - av) * dv) / L : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const d = (pu - au - du * f) ** 2 + (pv - av - dv * f) ** 2;
    if (d < best) best = d;
  }
  return best;
}
const ot = [], ou = [], ov = [];
function run(mode, setMs = 0) {
  const lag = { s: 0, w: 0 }, shape = { s: 0, w: 0 }, acc = { s: 0, w: 0 };
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
      lineAt(st.t, st.u, st.v, c, ot[k]);
      const w = ot[k] - ot[k - 1];
      lag.s += ((ou[k] - c.u) ** 2 + (ov[k] - c.v) ** 2) * w; lag.w += w;
      shape.s += offLine(st, c.i, ou[k], ov[k]) * w; shape.w += w;
    }
    accelOf(ot, ou, ov, ot[ot.length - 1], acc);
  }
  return { lag: Math.sqrt(lag.s / lag.w), shape: Math.sqrt(shape.s / shape.w), accel: Math.sqrt(acc.s / acc.w), joints, maxBatch, outPts };
}
const rawAcc = { s: 0, w: 0 };
let rawPts = 0;
for (const st of sample) { accelOf(st.t, st.u, st.v, st.t[st.t.length - 1], rawAcc); rawPts += st.t.length; }
const rawAccel = Math.sqrt(rawAcc.s / rawAcc.w);
console.log('sample: ' + sample.length + ' strokes at 0.05x; the drawn line, looked at a frame at a time, accelerates ' + fmt(rawAccel) + ' sides/s^2 RMS');

// the knee on the line's shape: in a playback nothing shows how late the
// pen is, only where its line goes (lag is printed beside it)
function knee(rows) {
  const front = rows.filter(r => !rows.some(o => o !== r && o.shape <= r.shape && o.accel <= r.accel && (o.shape < r.shape || o.accel < r.accel)))
    .sort((a, b) => a.shape - b.shape);
  const a = front[0], z = front[front.length - 1];
  const nx = r => (r.shape - a.shape) / (z.shape - a.shape || 1), ny = r => (r.accel - z.accel) / (a.accel - z.accel || 1);
  let best = a, bd = -Infinity;
  for (const r of front) { const d = (1 - nx(r)) - ny(r); if (d > bd) { bd = d; best = r; } }   // below the chord ny = 1 - nx
  // and the smoothest that keeps to the line within the drawing's own
  // scatter (a slow hand's, where it is the sensor's): straying less than
  // the points already stray from the hand's true path is no loss
  let within = front[0];
  for (const r of front) if (r.shape <= noiseSlow && r.accel < within.accel) within = r;
  return { best, front, within };
}
const line = r => 'off the line ' + fmt(r.shape, 2) + ' (' + fmt(r.shape / side * 100, 2) + '% of a mark), lag ' + fmt(r.lag, 2) + ' (' + fmt(r.lag / side * 100, 2) + '%), accel ' + fmt(r.accel) + ' (' + fmt(r.accel / rawAccel * 100, 2) + '% of drawn)';

// ---------- Auto ----------
const autoRows = [];
for (const f of [0.1, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 5]) {
  smoothParams.autoFactor = f;
  autoRows.push(Object.assign({ f }, run(1)));
}
const ak = knee(autoRows);
console.log('Auto front: ' + ak.front.map(r => r.f + ':' + fmt(r.shape / side * 100, 2) + '%/' + fmt(r.accel / rawAccel * 100, 2) + '%').join('  '));
console.log('Auto knee: factor ' + ak.best.f + ', ' + line(ak.best));
console.log('Auto within the scatter: factor ' + ak.within.f + ', ' + line(ak.within));

// ---------- One Euro ----------
const euroRows = [];
smoothParams.euroDHz = 1;
for (const m of [0.5, 1, 2, 3, 4, 5, 6, 8, 12]) {
  for (const b of [0, 0.5, 1, 2, 4, 8, 16, 32]) {
    smoothParams.euroMinHz = m; smoothParams.euroBeta = b;
    euroRows.push(Object.assign({ m, b }, run(3)));
  }
}
const ek = knee(euroRows);
console.log('1€ front: ' + ek.front.map(r => r.m + '/' + r.b + ':' + fmt(r.shape / side * 100, 2) + '%/' + fmt(r.accel / rawAccel * 100, 2) + '%').join('  '));
console.log('1€ knee: min cutoff ' + ek.best.m + ' Hz, beta ' + ek.best.b + ', d cutoff 1 Hz, ' + line(ek.best));
// what beta buys at the knee's min cutoff: the line at speed kept closer
// for a little less smoothness
console.log('1€ beta at ' + ek.best.m + ' Hz: ' + euroRows.filter(r => r.m === ek.best.m).map(r => r.b + ':' + fmt(r.shape / side * 100, 2) + '%/' + fmt(r.accel / rawAccel * 100, 2) + '%').join('  '));
console.log('1€ within the scatter: min cutoff ' + ek.within.m + ' Hz, beta ' + ek.within.b + ', ' + line(ek.within));

// ---------- the bounds ----------
const r = ek.best;
console.log('points: ' + fmt(r.outPts / rawPts) + 'x the drawn at 0.05x, at most ' + r.maxBatch + ' a batch (cap ' + (SUB_MAX + SETTLE_MAX + 1) + '); joints off by any: ' + (r.joints + ak.best.joints));
