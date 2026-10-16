// Regenerates the <link rel="modulepreload"> block in index.html.
//
// The app is served unbundled, so without hints the browser discovers the
// module graph level by level: main.js arrives, then its imports, then
// theirs — five serial round trips before boot() can run (and with the
// site's revalidate-on-every-load caching, returning visitors pay the same
// waterfall in 304s). Listing every statically reachable module in the HTML
// lets the browser fetch the whole graph in one wave, in parallel with
// main.js itself.
//
// Run after adding or moving modules:   node tools/modulepreload.mjs
// It walks the static imports from the three entry points index.html loads
// and rewrites the block between the MODULEPRELOAD markers in place.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRIES = ['main.js', 'platform/settings-file.js', 'platform/midi-in.js'];

// Static import/export-from specifiers only: dynamic import() loads stay
// lazy on purpose (they are lazy in the app for a reason).
const RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]/g;

const seen = new Set();
function walk(rel) {
  rel = rel.split(path.sep).join('/');
  if (seen.has(rel)) return;
  seen.add(rel);
  let src;
  try { src = fs.readFileSync(path.join(root, rel), 'utf8'); }
  catch { console.warn('  (unreadable, skipped: ' + rel + ')'); return; }
  RE.lastIndex = 0;
  for (let m; (m = RE.exec(src));) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    walk(path.normalize(path.join(path.dirname(rel), spec)));
  }
}
ENTRIES.forEach(walk);

// The entry points are already <script> tags in the HTML; everything else
// becomes a hint, sorted so the diff is stable run to run.
const hints = [...seen].filter(f => !ENTRIES.includes(f)).sort();
const block = hints.map(f => '<link rel="modulepreload" href="' + f + '">').join('\n');

const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const open = '<!-- MODULEPRELOAD (generated: node tools/modulepreload.mjs) -->';
const close = '<!-- /MODULEPRELOAD -->';
const a = html.indexOf(open), b = html.indexOf(close);
if (a < 0 || b < 0) { console.error('markers not found in index.html'); process.exit(1); }
fs.writeFileSync(htmlPath, html.slice(0, a + open.length) + '\n' + block + '\n' + html.slice(b));
console.log('wrote ' + hints.length + ' modulepreload hints into index.html');
