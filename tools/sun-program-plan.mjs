// The Sun program as an exact machine plan: the gap explorer's exported
// PLAN (documents/sun-program-plan-*.txt) laid onto the caption-keyed
// record (solarmeditation renders/fullrecord: mosaic_times.json + plan.tsv),
// so every kept stretch is a run of keyed frames with its day master and
// frame within it, and every fade is placed as the explorer lays it out
// (tools/gap-explorer.html computePlan / layersAt / fadeNow):
//   the outgoing stretch's last n frames overlap the incoming one's first n;
//   overlap frame k of n weighs w = (k + 1) / (n + 1), a plain average
//   A x (1 - w) + B x w; the shown time is B's once w >= 0.5.
// The PLAN's times are to the minute: each is the keyed frame whose UTC
// starts with that minute (it must be exactly one). Prints each stretch's
// frame count against the PLAN's and exits 1 on any mismatch.
//
//   node tools/sun-program-plan.mjs [documents/sun-program-plan-2026-10-13.txt] [out.json]
//   SOLAR=~/GitHub/solarmeditation (default)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const txtPath = resolve(process.argv[2] || join(ROOT, 'documents/sun-program-plan-2026-10-13.txt'));
const outPath = resolve(process.argv[3] || txtPath.replace(/\.txt$/, '.json'));
const SOLAR = process.env.SOLAR || join(homedir(), 'GitHub/solarmeditation');
const FR = join(SOLAR, 'renders/fullrecord');
const MASTERS = join(SOLAR, 'renders/cache/master');

const txt = readFileSync(txtPath, 'utf8');
const die = m => { console.error('sun-program-plan: ' + m); process.exit(1); };

// ---- the export ----
const recLine = txt.split('\n').find(l => l.startsWith('record: ') && l.includes('→'));
const rm = recLine && recLine.match(/(\d{4}-\d\d-\d\d \d\d:\d\d) → (\d{4}-\d\d-\d\d \d\d:\d\d) UTC/);
if (!rm) die('no record span line');
const [recStart, recEnd] = [rm[1], rm[2]];
const progLine = txt.match(/^program: (\S+)\s+([\d,]+) fr/m);
const wantTotal = +progLine[2].replace(/,/g, '');
const planAt = txt.indexOf('\nPLAN');
if (planAt < 0) die('no PLAN section');
const J = [];
for (const l of txt.slice(planAt).split('\n')) {
  const m = l.match(/^(gaps? [\d–-]+) · (\d{4}-\d\d-\d\d \d\d:\d\d) → (\d{4}-\d\d-\d\d \d\d:\d\d) · (\d+) → (\d+) · (\d+)$/);
  if (m) J.push({ name: m[1], outLast: m[2], inFirst: m[3], lenOut: +m[4], lenIn: +m[5], fade: +m[6] });
}
if (!J.length) die('no junctions parsed');
const wantLen = [J[0].lenOut, ...J.map(j => j.lenIn)];
J.forEach((j, q) => { if (q > 0 && J[q - 1].lenIn !== j.lenOut) die('PLAN lengths disagree at ' + j.name); });

// ---- the keyed record ----
const times = JSON.parse(readFileSync(join(FR, 'mosaic_times.json'), 'utf8'));
const days = readFileSync(join(FR, 'plan.tsv'), 'utf8').split('\n').filter(l => l.startsWith('DAY\t'))
  .map(l => { const [, day, fp, n, off] = l.split('\t'); return { day, fp, n: +n, off: +off }; });
{ let o = 0; for (const d of days) { if (d.off !== o) die('plan.tsv offsets not contiguous at ' + d.day); o += d.n; }
  if (o !== times.length) die(`plan.tsv covers ${o} frames, mosaic_times.json has ${times.length}`); }
for (const d of days) d.master = join(MASTERS, `${d.day}_${d.fp}.mp4`);
// minute -> frames
const byMin = new Map();
times.forEach((t, i) => { const k = t.slice(0, 16).replace('T', ' '); (byMin.get(k) || byMin.set(k, []).get(k)).push(i); });
const at = min => { const v = byMin.get(min); if (!v || v.length !== 1) die(`minute ${min} matches ${v ? v.length : 0} keyed frames`); return v[0]; };
const dayOf = i => { let lo = 0, hi = days.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (days[m].off <= i) lo = m; else hi = m - 1; } return days[lo]; };

// ---- stretches: record start .. first out, each in .. next out, last in .. record end ----
const bounds = [[recStart, J[0].outLast], ...J.map((j, q) => [j.inFirst, q + 1 < J.length ? J[q + 1].outLast : recEnd])];
let bad = 0;
const stretches = bounds.map(([a, b], s) => {
  const first = at(a), last = at(b), frames = last - first + 1;
  const ok = frames === wantLen[s];
  if (!ok) bad++;
  console.log(`stretch ${String(s).padStart(2)}  ${times[first]} .. ${times[last]}  ${String(frames).padStart(5)} frames  PLAN ${String(wantLen[s]).padStart(5)}  ${ok ? 'ok' : 'MISMATCH ' + (frames - wantLen[s])}`);
  // split into day masters
  const pieces = [];
  for (let i = first; i <= last;) {
    const d = dayOf(i), to = Math.min(last, d.off + d.n - 1);
    if (!existsSync(d.master)) die('missing master ' + d.master);
    pieces.push({ day: d.day, master: d.master, from: i - d.off, to: to - d.off, frames: to - i + 1 });
    i = to + 1;
  }
  return { first, last, firstUtc: times[first], lastUtc: times[last], frames, pieces };
});
const fades = J.map(j => j.fade);
fades.forEach((n, q) => {
  if (n > stretches[q].frames || n > stretches[q + 1].frames) die(`fade ${q} (${n}) longer than a stretch`);
  if ((q > 0 ? fades[q - 1] : 0) + n > stretches[q].frames) die(`stretch ${q} cannot hold its two fades`);
});
const kept = stretches.reduce((x, s) => x + s.frames, 0), over = fades.reduce((x, n) => x + n, 0), total = kept - over;
console.log(`kept ${kept}, overlap ${over}, program ${total} (PLAN ${wantTotal})`);
if (bad) die(bad + ' stretch count(s) differ from the PLAN: stopping');
if (total !== wantTotal) die('program total differs from the PLAN');

// ---- the program: piece j starts at P[j]; fade q covers [P[q+1], P[q+1] + n) ----
const P = [0];
for (let j = 1; j < stretches.length; j++) P.push(P[j - 1] + stretches[j - 1].frames - fades[j - 1]);
const junctions = J.map((j, q) => ({
  name: j.name, fade: fades[q],
  outLastUtc: times[stretches[q].last], inFirstUtc: times[stretches[q + 1].first],
  start: P[q + 1], end: P[q + 1] + fades[q] - 1,        // program frames, inclusive
  outFrom: stretches[q].last - fades[q] + 1,             // keyed frame of A at k = 0
  inFrom: stretches[q + 1].first                         // keyed frame of B at k = 0
}));
// Program frame -> layers, written out as runs so the renderer streams it:
// {a: keyed frame, n} plain runs, {a, b, n, fade} overlap runs.
const runs = [];
stretches.forEach((s, j) => {
  const head = j > 0 ? fades[j - 1] : 0, tail = j < fades.length ? fades[j] : 0;
  if (s.frames - head - tail > 0) runs.push({ a: s.first + head, n: s.frames - head - tail });
  if (tail) runs.push({ a: s.last - tail + 1, b: stretches[j + 1].first, n: tail, fade: j });
});
if (runs.reduce((x, r) => x + r.n, 0) !== total) die('runs do not add up');

const out = {
  source: { plan: txtPath.replace(ROOT, ''), record: recLine.replace(/^record: /, ''), keyed: join(FR, 'mosaic_times.json'), planTsv: join(FR, 'plan.tsv'), masters: MASTERS },
  blend: 'plain average in display values: overlap frame k of n is A x (1 - w) + B x w, w = (k + 1) / (n + 1); time shown is B\'s once w >= 0.5',
  fps: 30, width: 3072, height: 2048,
  kept, overlap: over, total,
  stretches, fades, junctions, runs,
  firstUtc: times[stretches[0].first], lastUtc: times[stretches[stretches.length - 1].last]
};
writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
console.log('wrote ' + outPath.replace(ROOT, ''));
