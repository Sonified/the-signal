// The gap explorer's own plan functions, pulled out of the page and run on
// a record's real times: which gaps merge (islands, Robert's spans, Auto
// bridges) and what Dynamic gives each junction.
//   node tools/gap-explorer-merge-check.mjs [keyed|twoyear|fullrecord] [--auto] [--cap 360] [--list]
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const rec = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'keyed';
const AUTO = args.includes('--auto'), LIST = args.includes('--list');
const CAP = +(args[args.indexOf('--cap') + 1] || 0) || 360;
const html = readFileSync(new URL('./gap-explorer.html', import.meta.url), 'utf8');
const times = JSON.parse(readFileSync(new URL('../sun-video/' + rec + '/mosaic_times.json', import.meta.url), 'utf8'));
const grab = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); return html.slice(a, b); };
const spans = html.slice(html.indexOf('const SPANS_UTC = '), html.indexOf('let SPANS = [];'));
const src = [
  `const MAX_FADE = ${CAP}; const planCap = () => MAX_FADE; const ISLAND = 30; const GAP_MS = 45 * 60 * 1000;`,
  spans,
  `const st = { islands: true, auto: ${AUTO}, policy: 'dynamic', keep: 0 }; const pins = {}; const keyOf = () => 'x';`,
  "const keepMin = () => (st.keep > 0 ? st.keep : 2 * MAX_FADE);",
  "const NF = times.length; const ms = Float64Array.from(times, t => Date.parse(t));",
  "const firstFrom = t => { let lo = 0, hi = NF; while (lo < hi) { const m = (lo + hi) >> 1; if (ms[m] < t) lo = m + 1; else hi = m; } return lo; };",
  "const SPANS = SPANS_UTC.map(([a, b]) => [firstFrom(Date.parse(a)), firstFrom(Date.parse(b))]);",
  "const segStart = [0]; for (let i = 1; i < NF; i++) if (ms[i] - ms[i - 1] > GAP_MS) segStart.push(i); const S = segStart.length;",
  "const segLen = segStart.map((s, j) => (j + 1 < S ? segStart[j + 1] : NF) - s);",
  grab('  const mostOf =', '  // Pins clamped'), grab('  function clampPins', '  // What an override'),
  grab('  const fadeScore', '  // A check that'),
  grab('  function piecesFor', '  // Piece j starts'),
  "const { pst, len, rec, merged } = piecesFor(false); const f = dynamicFades(len, clampPins(len, rec.map(() => -1)));",
  "const kept = len.reduce((a, b) => a + b, 0), over = f.reduce((a, b) => a + b, 0), prog = kept - over;",
  "const groups = {}; for (const g in merged) (groups[merged[g]] = groups[merged[g]] || []).push(+g);",
  "if (LIST) rec.forEach((r, q) => { const all = [r, ...(groups[r] || [])].sort((a, b) => a - b); const name = all.length > 1 ? 'gaps ' + (all[0] + 1) + '-' + (all[all.length - 1] + 1) : 'gap ' + (r + 1); console.log(name.padEnd(12), times[segStart[r + 1] - 1].slice(0, 10), 'stretches', String(len[q]).padStart(5), '->', String(len[q + 1]).padStart(5), ' fade', f[q]); });",
  "const clock = n => Math.floor(n / 1800) + ':' + String(Math.round(n / 30 % 60)).padStart(2, '0');",
  "console.log(`${RECORD}${AUTO ? ' auto' : ''} cap ${MAX_FADE}: ${segStart.length - 1} gaps -> ${f.length} junctions, ${[...f].filter(x => x === MAX_FADE).length} at ${MAX_FADE}, ${[...f].filter(x => x === 0).length} hard; keeps ${kept} of ${NF} frames; program ${clock(prog)} (straight ${clock(NF)})`);"
].join('\n');
new Function('times', 'RECORD', 'AUTO', 'LIST', src)(times, rec, AUTO, LIST);
