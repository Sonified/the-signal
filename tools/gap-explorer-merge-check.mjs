// The gap explorer's own plan functions, pulled out of the page and run on
// the keyed cut's real times: which gaps merge (islands, Robert's spans) and
// what Dynamic gives each junction. node tools/gap-explorer-merge-check.mjs
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./gap-explorer.html', import.meta.url), 'utf8');
const times = JSON.parse(readFileSync(new URL('../sun-video/keyed/mosaic_times.json', import.meta.url), 'utf8'));
const grab = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); return html.slice(a, b); };
const src = [
  "const MAX_FADE = 360; const ISLAND = 30; const SPANS = [[3999, 4236], [4985, 5200], [9564, 9763]]; const GAP_MS = 45 * 60 * 1000;",
  "const st = { islands: true, policy: 'dynamic' }; const pins = {}; const keyOf = () => 'x';",
  "const NF = times.length; const ms = Float64Array.from(times, t => Date.parse(t));",
  "const segStart = [0]; for (let i = 1; i < NF; i++) if (ms[i] - ms[i - 1] > GAP_MS) segStart.push(i); const S = segStart.length;",
  "const segLen = segStart.map((s, j) => (j + 1 < S ? segStart[j + 1] : NF) - s);",
  grab('  const mostOf =', '  // Pins clamped'), grab('  function clampPins', '  // What an override'),
  grab('  const fadeScore', '  // A check that'),
  grab('  function piecesFor', '  // Piece j starts'),
  "const { pst, len, rec, merged } = piecesFor(false); const f = dynamicFades(len, clampPins(len, rec.map(() => -1)));",
  "for (let q = 0; q < 9; q++) console.log('junction', q, 'gap', rec[q] + 1, 'pieces', len[q], '→', len[q + 1], 'fade', f[q]);",
  "console.log('merged into:', JSON.stringify(Object.fromEntries(Object.entries(merged).map(([g, r]) => [+g + 1, r + 1]))));",
  "console.log('hard cuts left:', [...f].filter(x => x === 0).length, 'of', f.length, ' at 180:', [...f].filter(x => x === 180).length);"
].join('\n');
new Function('times', src)(times);
