// One command that changes the talk's deck and puts the change everywhere:
// it runs tools/deck.mjs, checks the result, commits the deck's own files,
// pushes them to the live site, waits until the site serves them, and checks
// what it serves. After it says LIVE, a reload of the laptop's /presentation
// page and of the iPad's /controller page is all that is left; ?livestream
// viewers follow the laptop and need nothing.
//
//   node tools/deck-publish.mjs                 publish the deck as it stands
//   node tools/deck-publish.mjs off 210         pull a cue, then publish
//   node tools/deck-publish.mjs on 210          put it back, then publish
//   node tools/deck-publish.mjs short | long    the 16-cue / the 27-cue talk
//   node tools/deck-publish.mjs --dry ...       everything but the commit and
//                                               the push (says what it would do)
//   node tools/deck-publish.mjs --check         push nothing: is the live site
//                                               serving the committed deck?
// The words after the flags are tools/deck.mjs's own (off, on, short, long,
// build): see its header. Reordering is a line moved in
// documents/talk-deck.json, then this with no words.
//
// It commits ONLY the files tools/deck.mjs writes, by path, so other work
// in the tree stays where it is. It stops, having pushed nothing, when:
//   - the branch is not sun-layer (it never switches branches);
//   - the deck tool or a test refuses;
//   - a file the deck leans on has changes that are not committed (a new
//     video's list, manifest or code: that is a whole push, not this one);
//   - commits are waiting that are not on the site yet (they would ride
//     along; --with-waiting lets them);
//   - the site has never had the deck (its first push is a whole push).
// Node only, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://presence.now.audio';
const BRANCH = 'sun-layer';
// what tools/deck.mjs writes: the only files this commits
const OUT = ['documents/tsc-2026-journey.json', 'documents/talk-deck.json', 'documents/talk-deck-steps.json',
  'controller.html', 'core/slide-order.js'];
// what the build reads besides the deck: must already be committed (and so
// on the site), or the deck could name a video the site does not serve.
// Other uncommitted work (main.js and the rest) is no matter: only OUT is
// committed and pushed, so the site keeps the committed code.
const LEANS = ['core/schema-slides.js', 'documents/tsc-2026-media-manifest.json', 'slides/previews/144p-30fps/manifest.json',
  'tools/deck.mjs'];
const WAIT_MS = 8 * 60 * 1000, POLL_MS = 5000;

const args = process.argv.slice(2);
const dry = args.includes('--dry'), withWaiting = args.includes('--with-waiting'), checkOnly = args.includes('--check');
const deckArgs = args.filter(a => a !== '--dry' && a !== '--with-waiting' && a !== '--check');

const say = s => console.log(s);
const stop = msg => { console.error('\nSTOPPED, nothing pushed: ' + msg); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rev = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const node = (...a) => spawnSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function live(rel, method = 'GET') {
  const r = await fetch(SITE + '/' + rel.split('/').map(encodeURIComponent).join('/') + (method === 'GET' ? '?t=' + Date.now() : ''),
    { method, cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  return { status: r.status, text: method === 'GET' ? await r.text() : '', length: +r.headers.get('content-length') };
}

// ---- 1. the branch ----
const branch = git('branch', '--show-current');
if (branch !== BRANCH) stop('this is branch "' + branch + '", not ' + BRANCH + '.');

if (!checkOnly) {
// ---- 2. the deck ----
const built = node('tools/deck.mjs', ...(deckArgs.length ? deckArgs : ['build']));
process.stdout.write(built.stdout || '');
if (built.status !== 0) { process.stderr.write(built.stderr || ''); stop('tools/deck.mjs refused (above).'); }

// ---- 3. the tests ----
for (const t of [['tools/deck.test.mjs'], ['--test', 'tools/presentation-gate.test.mjs'], ['--test', 'tools/presentation-reinstall.test.mjs']]) {
  const r = node(...t);
  if (r.status !== 0) { process.stdout.write((r.stdout || '').slice(-3000)); process.stderr.write((r.stderr || '').slice(-1500)); stop(t[t.length - 1] + ' failed (above).'); }
}
say('\nTests pass (deck, gate, reinstall).');

// ---- 4. what must already be on the site ----
const dirtyLeans = git('status', '--porcelain', '--', ...LEANS);
if (dirtyLeans) stop('these have changes that are not committed, and the deck leans on them:\n' + dirtyLeans +
  '\nThat is a whole push of the tree, not a deck change.');
try { git('fetch', '-q', 'origin'); } catch (e) { stop('could not reach GitHub (git fetch): ' + String(e.message).split('\n')[0]); }
const waiting = git('log', '--oneline', 'origin/main..HEAD');
if (waiting && !withWaiting) stop('these commits are not on the site yet and would ride along:\n' + waiting + '\n(--with-waiting pushes them too.)');
const first = await live('core/slide-order.js').catch(e => ({ status: 0, text: String(e.message) }));
if (first.status !== 200 || !/export const SLIDE_ORDER/.test(first.text)) {
  stop(first.status ? 'the site has not had the deck yet (' + SITE + '/core/slide-order.js answers ' + first.status + '). Its first push is a whole push of the tree.'
    : 'could not reach ' + SITE + ' (' + first.text + ').');
}

// ---- 5. commit and push ----
const deck = JSON.parse(read('documents/talk-deck.json'));
const on = deck.cues.filter(c => c.on);
const journeyText = read('documents/tsc-2026-journey.json');
if (rev(journeyText) !== deck.built) stop('documents/tsc-2026-journey.json is not the one the deck last built. Run node tools/deck.mjs build and look at what it says.');
const changed = git('status', '--porcelain', '--', ...OUT);
const message = 'The talk\'s deck, published by tools/deck-publish.mjs: ' + on.length + ' cues, ' + on.map(c => c.label).join(', ') +
  '. Written by tools/deck.mjs from documents/talk-deck.json (the Journey, the controller\'s cue list and previews, the download order).';
if (dry) {
  say('\nDRY RUN. Would commit ' + (changed ? 'these:\n' + changed : 'nothing (the deck\'s files are as committed)') +
    '\nthen push ' + BRANCH + ' to origin and to origin main, and wait for ' + SITE + ' to serve deck ' + deck.built + '.');
  process.exit(0);
}
if (changed) {
  git('add', '--', ...OUT);
  git('commit', '-q', '-m', message, '--only', '--', ...OUT);
  say('Committed: ' + git('log', '--oneline', '-1').slice(0, 100));
} else say('The deck\'s files are as committed already: nothing new to commit.');
try {
  git('push', '-q', 'origin', BRANCH);
  git('push', '-q', 'origin', BRANCH + ':main');
} catch (e) {
  console.error('\nThe commit is made but the PUSH FAILED: ' + String(e.stderr || e.message).trim().split('\n').slice(-3).join(' | ') +
    '\nNothing is on the site. Fix the push (never force it) and run this again.');
  process.exit(1);
}
say('Pushed. Waiting for ' + SITE + ' to serve it (usually a minute or two)...');
}
const deck = JSON.parse(read('documents/talk-deck.json'));
const on = deck.cues.filter(c => c.on);

// ---- 6. wait until the site serves this deck, then check all of it ----
const t0 = Date.now();
let seen = '';
for (;;) {
  try {
    const d = await live('documents/talk-deck.json');
    if (d.status === 200) { seen = JSON.parse(d.text).built || ''; if (seen === deck.built) break; }
  } catch (e) { /* try again */ }
  if (Date.now() - t0 > WAIT_MS) {
    console.error('\nNOT LIVE after ' + Math.round(WAIT_MS / 60000) + ' minutes: the site still serves deck ' + (seen || '(none)') + ', not ' + deck.built +
      '.\nThe push went out; look at the Cloudflare Pages build for presence-generator. Do not reload the laptop or the iPad yet.');
    process.exit(1);
  }
  await sleep(POLL_MS);
}
const problems = [];
const [j, c, o, m] = await Promise.all([live('documents/tsc-2026-journey.json'), live('controller.html'), live('core/slide-order.js'), live('main.js')]);
if (rev(j.text) !== deck.built) problems.push('the Journey the site serves is not this deck\'s');
// (Cloudflare adds its own script to served HTML, so the cue list and the
// previews are compared, not the whole page)
{
  const lit = html => [/^  const CUES = \[[\s\S]*?\];$/m, /^        prefixes: \[[^\n]*\],$/m].map(re => (re.exec(html) || [''])[0]);
  const want = lit(read('controller.html')), got = lit(c.text);
  if (!want[0] || got[0] !== want[0]) problems.push('the controller page the site serves has another cue list');
  if (got[1] !== want[1]) problems.push('the controller page the site serves has other previews');
}
if (o.text !== read('core/slide-order.js')) problems.push('the download order the site serves is not this deck\'s');
if (!/presentInstall\(\)\.then/.test(m.text)) problems.push('the site\'s page does not install the Journey at load: after reloading the laptop, also switch Settings > Presentation mode off and on');
const manifest = JSON.parse(read('documents/tsc-2026-media-manifest.json'));
const bytes = new Map(manifest.videos.map(v => [v.file, v.bytes]));
await Promise.all(on.filter(c => c.file).map(async c => {
  try {
    const h = await live('slides/' + c.file, 'HEAD');
    if (h.status !== 200) problems.push('cue "' + c.label + '": its video answers ' + h.status);
    else if (h.length !== bytes.get(c.file)) problems.push('cue "' + c.label + '": its video is ' + h.length + ' bytes on the site, ' + bytes.get(c.file) + ' in the manifest');
  } catch (e) { problems.push('cue "' + c.label + '": its video could not be reached (' + e.message + ')'); }
}));
const took = Math.round((Date.now() - t0) / 1000);
if (problems.length) {
  console.error('\nLIVE after ' + took + ' s, BUT:\n' + problems.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}
say('\nLIVE after ' + took + ' s: ' + on.length + ' cues, every video answering, deck ' + deck.built + '.\n' +
  'Now reload two pages, in either order:\n' +
  '  the laptop:  ' + SITE + '/presentation\n' +
  '  the iPad:    ' + SITE + '/controller\n' +
  'Then tap cue 1: the iPad should read "cue 1 of ' + on.length + '". Viewers on ?livestream need nothing.');
