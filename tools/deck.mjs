// The talk's deck, from one file. documents/talk-deck.json holds the running
// order (a cue per line: id, the controller's label, the slide file or null,
// on/off); documents/talk-deck-steps.json holds every cue's Journey step (its
// whole scene) under the cue's id, kept whether the cue is on or off, so a cue
// switched off and on again comes back byte for byte. This tool writes the
// three places a cue must agree on, from those two files:
//   documents/tsc-2026-journey.json  the Journey (its top-level fields kept,
//                                    the on cues' steps in deck order)
//   controller.html  const CUES = [...]   the iPad's cue labels
//   controller.html  prefixes: [...]      each cue's preview (by file prefix,
//                                         platform/cue-previews.js)
//   core/slide-order.js              the videos in running order (the cues
//                                    that are on, then the ones off): the
//                                    order a Presentation screen downloads
//                                    them in (js/show-media.js)
//
//   node tools/deck.mjs list            the running order
//   node tools/deck.mjs build           validate, then write all three
//   node tools/deck.mjs off <cue> ...   pull cues out, then build
//   node tools/deck.mjs on <cue> ...    put cues back, then build
//   node tools/deck.mjs short | long    the 16-cue talk / the 27-cue talk
//   node tools/deck.mjs absorb          take an exported Journey's steps
//                                       (a browser export over the journey
//                                       file) back into the steps store
// A <cue> is its id (e.g. jvke) or its file's number (e.g. 210).
//
// Flags: --force builds although a file is missing from the media or preview
// manifest (the laptop will refuse to install such a Journey until the media
// manifest has it); --overwrite builds over a journey file changed since the
// last build (absorb it instead to keep its steps); --root <dir> works on a
// copy of the repository (the tests).
//
// All or nothing: everything is computed and checked first, then written.
// Node only, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DECK = 'documents/talk-deck.json';
const STEPS = 'documents/talk-deck-steps.json';
const JOURNEY = 'documents/tsc-2026-journey.json';
const MEDIA = 'documents/tsc-2026-media-manifest.json';
const PREVIEWS = 'slides/previews/144p-30fps/manifest.json';
const SLIDES_JS = 'core/schema-slides.js';
const PRESENTATION_JS = 'core/presentation.js';
const CONTROLLER = 'controller.html';
const ORDER_JS = 'core/slide-order.js';

class DeckError extends Error {}
const fail = msg => { throw new DeckError(msg); };
const rev = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

// ---------- reading ----------
function readText(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); }
  catch (e) { fail('cannot read ' + rel + ': ' + e.message); }
}
function readJson(root, rel) {
  const t = readText(root, rel);
  try { return JSON.parse(t); } catch (e) { fail(rel + ' is not valid JSON: ' + e.message); }
}

// SLIDE_FILES, read from the source (the module itself needs a browser).
function slideFiles(root) {
  const src = readText(root, SLIDES_JS);
  const m = /export const SLIDE_FILES = (\[[\s\S]*?\n\]);/.exec(src);
  if (!m) fail('SLIDE_FILES not found in ' + SLIDES_JS);
  const list = vm.runInNewContext('(' + m[1] + ')');
  return new Set(list.map(f => f[0]));
}

// core/presentation.js presentJourneyProblem, the laptop's own check before it
// installs the Journey. That module cannot be imported here (its imports need
// a browser), so the function's source is lifted out of it and run alone;
// failing that, a copy of the same check.
function journeyProblemCheck(root) {
  const src = readText(root, PRESENTATION_JS);
  const m = /export function presentJourneyProblem\(journey, manifest\) \{\n[\s\S]*?\n\}\n/.exec(src);
  if (m) {
    try {
      const fn = vm.runInNewContext('(' + m[0].replace(/^export /, '') + ')');
      if (typeof fn === 'function') return { fn, from: PRESENTATION_JS };
    } catch (e) { /* the copy below */ }
  }
  return {
    from: 'a copy in tools/deck.mjs (' + PRESENTATION_JS + ' could not be read)',
    fn(journey, manifest) {
      if (!journey || journey.ver !== 2 || !Array.isArray(journey.steps) || !journey.steps.length) return 'not an exported v2 Journey';
      const have = new Set(((manifest && manifest.videos) || []).map(v => v.file));
      for (const step of journey.steps) {
        const f = step && step.overrides && step.overrides.slideFile;
        if (f && f !== 'none' && !have.has(f)) return 'Journey video missing: ' + f;
      }
      return '';
    }
  };
}

// ---------- the deck file ----------
// Written with one cue per line, so a reorder is moving a line.
export function deckText(deck) {
  const lines = ['{'];
  const keys = Object.keys(deck).filter(k => k !== 'cues');
  for (const k of keys) {
    const v = deck[k];
    if (k === 'about' && Array.isArray(v)) {
      lines.push(' "about": [');
      v.forEach((s, i) => lines.push('  ' + JSON.stringify(s) + (i < v.length - 1 ? ',' : '')));
      lines.push(' ],');
    } else if (k === 'sets' && v && typeof v === 'object') {
      lines.push(' "sets": {');
      const names = Object.keys(v);
      names.forEach((n, i) => lines.push('  ' + JSON.stringify(n) + ': ' + JSON.stringify(v[n]).replace(/","/g, '", "') + (i < names.length - 1 ? ',' : '')));
      lines.push(' },');
    } else lines.push(' ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',');
  }
  lines.push(' "cues": [');
  deck.cues.forEach((c, i) => {
    const o = { id: c.id, label: c.label, file: c.file ?? null };
    if (c.preview !== undefined) o.preview = c.preview;
    o.on = c.on;
    for (const k of Object.keys(c)) if (!(k in o)) o[k] = c[k];
    const body = Object.entries(o).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ');
    lines.push('  {' + body + '}' + (i < deck.cues.length - 1 ? ',' : ''));
  });
  lines.push(' ]', '}', '');
  return lines.join('\n');
}

function checkDeck(deck, store) {
  if (!deck || !Array.isArray(deck.cues) || !deck.cues.length) fail(DECK + ': no cues');
  const ids = new Set();
  for (const c of deck.cues) {
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) fail(DECK + ': a cue id must be lower-case letters, digits and dashes: ' + JSON.stringify(c && c.id));
    if (ids.has(c.id)) fail(DECK + ': the id ' + c.id + ' is used twice');
    ids.add(c.id);
    if (typeof c.label !== 'string' || !c.label.trim() || /[\u0000-\u001f]|<\/script/i.test(c.label)) fail(DECK + ': cue ' + c.id + ' needs a plain one-line label');
    if (c.file !== null && c.file !== undefined && (typeof c.file !== 'string' || !c.file || c.file === 'none')) fail(DECK + ': cue ' + c.id + ': file must be a file name or null');
    if (c.preview !== undefined && c.preview !== null && (typeof c.preview !== 'string' || !c.preview || /['"\\\n]/.test(c.preview))) fail(DECK + ': cue ' + c.id + ': bad preview');
    if (typeof c.on !== 'boolean') fail(DECK + ': cue ' + c.id + ': on must be true or false');
    const st = store[c.id];
    if (!st || typeof st !== 'object' || !st.overrides || typeof st.overrides !== 'object') fail(STEPS + ': no step for cue ' + c.id);
  }
  for (const id of Object.keys(store)) if (!ids.has(id)) fail(STEPS + ': a step for ' + id + ', which is no cue in ' + DECK);
  if (deck.sets) for (const [n, list] of Object.entries(deck.sets)) {
    if (!Array.isArray(list)) fail(DECK + ': set ' + n + ' must be a list of ids');
    for (const id of list) if (!ids.has(id)) fail(DECK + ': set ' + n + ' names ' + id + ', which is no cue');
  }
  if (!deck.cues.some(c => c.on)) fail(DECK + ': every cue is off');
}

// ---------- the controller's two literals ----------
const jsStr = s => s.includes("'") && !s.includes('"') ? '"' + s.replace(/\\/g, '\\\\') + '"'
  : "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
function cuesLiteral(labels) {
  // wrapped as the page has it: at most 120 columns, continuation lines
  // indented four
  const items = labels.map(jsStr);
  const lines = [];
  let line = '  const CUES = [';
  items.forEach((it, i) => {
    const piece = it + (i < items.length - 1 ? ',' : '];');
    const fresh = line === '  const CUES = [' || line === '    ';
    if (!fresh && (line + ' ' + piece).length > 120) { lines.push(line); line = '    ' + piece; }
    else line += (fresh ? '' : ' ') + piece;
  });
  lines.push(line);
  return lines.join('\n');
}
const prefixesLiteral = list => '        prefixes: [' + list.map(p => p === null ? 'null' : jsStr(p)).join(', ') + '],';
const CUES_RE = /^  const CUES = \[[^\n]*(?:\n(?!  \S)[^\n]*)*?\];$/gm;
const PREFIX_RE = /^        prefixes: \[[^\n]*\],$/gm;
export function controllerArrays(html) {
  const c = html.match(CUES_RE), p = html.match(PREFIX_RE);
  if (!c || c.length !== 1) fail(CONTROLLER + ': the "  const CUES = [...];" anchor was found ' + (c ? c.length : 0) + ' times, not once');
  if (!p || p.length !== 1) fail(CONTROLLER + ': the "        prefixes: [...]," anchor was found ' + (p ? p.length : 0) + ' times, not once');
  const cues = vm.runInNewContext('(' + c[0].replace(/^\s*const CUES = /, '').replace(/;$/, '') + ')');
  const prefixes = vm.runInNewContext('(' + p[0].replace(/^\s*prefixes: /, '').replace(/,$/, '') + ')');
  // (plain arrays of this realm, not the sandbox's)
  return { cues: [...cues], prefixes: [...prefixes] };
}
function rewriteController(html, labels, prefixes) {
  controllerArrays(html);   // both anchors, exactly once, or fail
  return html.replace(CUES_RE, () => cuesLiteral(labels)).replace(PREFIX_RE, () => prefixesLiteral(prefixes));
}

// The preview a cue's thumbnail shows. platform/cue-previews.js takes, for a
// prefix p, the FIRST preview whose source starts with p + '_'; this finds the
// shortest prefix (cut at an underscore) that lands on the cue's own file.
function previewPrefix(file, sources) {
  const parts = file.split('_');
  let any = null;
  for (let k = 1; k < parts.length; k++) {
    const p = parts.slice(0, k).join('_');
    const first = sources.find(s => s.startsWith(p + '_'));
    if (first === file) return { prefix: p };
    if (!any && sources.includes(file) && file.startsWith(p + '_')) any = { prefix: p, shadow: first };
  }
  if (any) return any;
  return { prefix: parts.length > 1 ? parts[0] : null, missing: true };
}

// The videos in the talk's running order, as a module js/show-media.js
// imports: the cues that are on, in deck order, then the ones switched off.
// A file two cues share is named once, at its first place.
export function orderText(deck) {
  const files = [];
  for (const c of deck.cues.filter(c => c.on).concat(deck.cues.filter(c => !c.on))) {
    if (c.file && !files.includes(c.file)) files.push(c.file);
  }
  return '// GENERATED by tools/deck.mjs from documents/talk-deck.json. Do not edit:\n' +
    '// the next build writes it again. The slide videos in the talk\'s running\n' +
    '// order (the cues that are on, then the ones switched off): the order a\n' +
    '// Presentation screen downloads them in (js/show-media.js).\n' +
    'export const SLIDE_ORDER = [\n' + files.map(f => '  ' + JSON.stringify(f)).join(',\n') + '\n];\n';
}
function readTextOr(root, rel, or) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { return or; }
}

// ---------- the build ----------
export function plan(root, deck, store, { force = false, overwrite = false } = {}) {
  checkDeck(deck, store);
  const errors = [], warnings = [];
  const slideOk = slideFiles(root);
  const media = readJson(root, MEDIA);
  const mediaOk = new Set((media.videos || []).map(v => v.file));
  const previews = readJson(root, PREVIEWS);
  // the same filter platform/cue-previews.js applies
  const sources = (previews.videos || []).filter(v => v.file && !/[/\\]/.test(v.file) && v.poster && !/[/\\]/.test(v.poster)).map(v => v.source);
  const on = deck.cues.filter(c => c.on);
  const prefixes = [], missMedia = [], missPreview = [];
  for (const c of on) {
    if (c.file) {
      if (!slideOk.has(c.file)) errors.push({ hard: true, msg: c.id + ': ' + c.file + ' is not in SLIDE_FILES (' + SLIDES_JS + '); the laptop would play no slide' });
      if (!mediaOk.has(c.file)) missMedia.push(c.file);
      if (!sources.includes(c.file)) missPreview.push(c.file);
    }
    if (c.preview !== undefined) {
      if (c.preview !== null && !sources.some(s => s.startsWith(c.preview + '_'))) warnings.push(c.id + ': its preview ' + c.preview + ' matches no preview');
      prefixes.push(c.preview);
    } else if (c.file) {
      const r = previewPrefix(c.file, sources);
      if (r.shadow) warnings.push(c.id + ': no prefix reaches ' + c.file + ' alone; its poster shows ' + r.shadow + ' (the moving preview follows the real file)');
      prefixes.push(r.prefix);
    } else prefixes.push(null);
  }
  // the page gives cues past the list's end no preview: trailing empties go
  while (prefixes.length && prefixes[prefixes.length - 1] === null) prefixes.pop();

  const journeyText = readText(root, JOURNEY);
  let journey;
  try { journey = JSON.parse(journeyText); } catch (e) { fail(JOURNEY + ' is not valid JSON'); }
  const out = {};
  for (const k of Object.keys(journey)) out[k] = k === 'steps' ? null : journey[k];
  out.steps = on.map(c => {
    const st = JSON.parse(JSON.stringify(store[c.id]));
    st.overrides.slideFile = c.file || 'none';
    return st;
  });
  // one line per manifest, each file named in full
  if (missMedia.length) errors.push({ msg: missMedia.length + ' not in the media manifest (' + MEDIA + '): ' + missMedia.join(' | ') });
  if (missPreview.length) errors.push({ msg: missPreview.length + ' with no preview in ' + PREVIEWS + ': ' + missPreview.join(' | ') });
  const newJourney = JSON.stringify(out, null, 1);
  const check = journeyProblemCheck(root);
  const problem = check.fn(out, media);
  if (problem) errors.push({ msg: 'the laptop would refuse this Journey (presentJourneyProblem): ' + problem });

  const html = readText(root, CONTROLLER);
  const newHtml = rewriteController(html, on.map(c => c.label), prefixes);

  if (deck.built && rev(journeyText) !== deck.built && journeyText !== newJourney && !overwrite) {
    fail(JOURNEY + ' was changed since the deck last built it (a Journey exported from the browser?).\n' +
      '  node tools/deck.mjs absorb   takes its steps into the deck (keeps the edits)\n' +
      '  --overwrite                  builds over it (loses them)');
  }
  const hard = errors.filter(e => e.hard), soft = errors.filter(e => !e.hard);
  if (hard.length || (soft.length && !force)) {
    fail('build stopped, nothing written:\n' + errors.map(e => '  ERROR ' + e.msg).join('\n') +
      (hard.length ? '' : '\n  (--force builds anyway; the laptop will not install the Journey until the media manifest lists every file)'));
  }
  const nextDeck = { ...deck, built: rev(newJourney) };
  return {
    on, prefixes, warnings, forced: soft.map(e => e.msg), checkFrom: check.from,
    writes: [
      [JOURNEY, newJourney, journeyText],
      [CONTROLLER, newHtml, html],
      [ORDER_JS, orderText(deck), readTextOr(root, ORDER_JS, null)],
      [DECK, deckText(nextDeck), readText(root, DECK)]
    ],
    drawCount: countDraw(html)
  };
}

function countDraw(html) {
  const m = /const DRAW = \[([\s\S]*?)\n  \];/.exec(html);
  return m ? (m[1].match(/\{ label: /g) || []).length : 0;
}

// Every file to a temporary beside it first, then all renamed: nothing is
// half written, and a failure before the renames leaves everything as it was.
export function writeAll(root, writes) {
  const changed = writes.filter(([, text, old]) => text !== old);
  const tmps = [];
  try {
    for (const [rel, text] of changed) {
      const tmp = path.join(root, rel) + '.deck-tmp';
      fs.writeFileSync(tmp, text);
      tmps.push([tmp, path.join(root, rel)]);
    }
  } catch (e) {
    for (const [tmp] of tmps) try { fs.unlinkSync(tmp); } catch (_) {}
    fail('could not write (' + e.message + '); nothing changed');
  }
  for (const [tmp, to] of tmps) fs.renameSync(tmp, to);
  return changed.map(w => w[0]);
}

function loadDeck(root) { return { deck: readJson(root, DECK), store: readJson(root, STEPS) }; }

function findCues(deck, arg) {
  const exact = deck.cues.filter(c => c.id === arg);
  if (exact.length) return exact;
  const byFile = deck.cues.filter(c => c.file && c.file.startsWith(arg + '_'));
  if (byFile.length === 1) return byFile;
  if (byFile.length > 1) fail(arg + ' is more than one cue: ' + byFile.map(c => c.id).join(', ') + '. Use the id.');
  const byId = deck.cues.filter(c => c.id.startsWith(arg));
  if (byId.length === 1) return byId;
  fail('no single cue matches ' + JSON.stringify(arg) + (byId.length ? ' (could be ' + byId.map(c => c.id).join(', ') + ')' : '') + '. node tools/deck.mjs list shows them.');
}

function listing(deck) {
  const lines = [];
  let n = 0;
  for (const c of deck.cues) {
    const num = c.on ? String(++n).padStart(3) : '  -';
    lines.push(num + '  ' + (c.on ? 'on ' : 'off') + '  ' + c.id.padEnd(20) + ' ' + c.label.padEnd(34) + ' ' + (c.file || '(no video)'));
  }
  return lines.join('\n');
}

function summary(p, written) {
  const lines = ['', 'The iPad will show:'];
  p.on.forEach((c, i) => lines.push(String(i + 1).padStart(4) + '  ' + c.label +
    (c.file ? '' : '   (no video' + (c.preview ? '; the iPad shows the ' + c.preview + ' preview' : '') + ')')));
  if (p.drawCount) lines.push(String(p.on.length + 1).padStart(4) + '-' + (p.on.length + p.drawCount) + '  the ' + p.drawCount + ' drawing cues (unchanged; they land on step ' + p.on.length + ', the last)');
  for (const w of p.warnings) lines.push('WARNING ' + w);
  for (const f of p.forced) lines.push('FORCED  ' + f);
  if (p.forced.length) lines.push('FORCED: the laptop will NOT install this Journey until the media manifest lists every file. Rebuild once it does.');
  lines.push('', p.on.length + ' steps, ' + p.on.length + ' cues (+' + p.drawCount + ' drawing). ' +
    (written.length ? 'Wrote ' + written.join(', ') + '.' : 'Nothing changed.'));
  lines.push('Check: ' + p.checkFrom + '.');
  return lines.join('\n');
}

// One command: returns the text to print. Throws DeckError on a refusal.
export function run(argv, rootIn) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  let root = rootIn;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') { root = path.resolve(argv[++i] || fail('--root needs a directory')); continue; }
    if (!argv[i].startsWith('--')) args.push(argv[i]);
  }
  for (const f of flags) if (!['--force', '--overwrite', '--root'].includes(f)) fail('unknown flag ' + f);
  const opts = { force: flags.has('--force'), overwrite: flags.has('--overwrite') };
  const [cmd, ...rest] = args;
  const { deck, store } = loadDeck(root);
  const build = (d, s = store, extra = []) => {
    const p = plan(root, d, s, opts);
    if (s !== store) p.writes.push([STEPS, JSON.stringify(s, null, 1), readText(root, STEPS)]);
    const written = writeAll(root, p.writes);
    return extra.concat(summary(p, written)).join('\n');
  };
  if (cmd === 'list') { checkDeck(deck, store); return listing(deck); }
  if (cmd === 'build') return build(deck);
  if (cmd === 'on' || cmd === 'off') {
    if (!rest.length) fail('which cue? e.g. node tools/deck.mjs ' + cmd + ' 210');
    const d = JSON.parse(JSON.stringify(deck));
    const notes = [];
    for (const a of rest) for (const c of findCues(d, a)) { c.on = cmd === 'on'; notes.push(cmd + ': ' + c.id + ' (' + c.label + ')'); }
    return build(d, store, notes);
  }
  if (cmd === 'short' || cmd === 'long') {
    const set = deck.sets && deck.sets[cmd];
    if (!Array.isArray(set)) fail(DECK + ' has no set named ' + cmd);
    const d = JSON.parse(JSON.stringify(deck));
    for (const c of d.cues) c.on = set.includes(c.id);
    // the set's own order is the deck's: a set never reorders the lines
    const order = d.cues.filter(c => c.on).map(c => c.id);
    if (order.join() !== set.join()) fail('set ' + cmd + ' lists its cues in another order than the deck: ' + set.join(', '));
    return build(d, store, [cmd + ': ' + set.length + ' cues on']);
  }
  if (cmd === 'absorb') {
    const j = readJson(root, JOURNEY);
    const on = deck.cues.filter(c => c.on);
    if (!Array.isArray(j.steps) || j.steps.length !== on.length) fail(JOURNEY + ' has ' + (j.steps ? j.steps.length : 0) + ' steps but the deck has ' + on.length + ' cues on; set the deck to match it first');
    const d = JSON.parse(JSON.stringify(deck)), s = JSON.parse(JSON.stringify(store)), notes = [];
    d.cues.filter(c => c.on).forEach((c, i) => {
      const st = j.steps[i], f = st.overrides && st.overrides.slideFile;
      if (typeof f === 'string' && f !== (c.file || 'none')) { c.file = f === 'none' ? null : f; notes.push('absorb: ' + c.id + ' now plays ' + f); }
      s[c.id] = st;
    });
    d.built = rev(readText(root, JOURNEY));
    notes.push('absorb: ' + on.length + ' steps taken into ' + STEPS);
    return build(d, s, notes);
  }
  fail('usage: node tools/deck.mjs list | build | off <cue>... | on <cue>... | short | long | absorb  [--force] [--overwrite]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(run(process.argv.slice(2), fileURLToPath(new URL('..', import.meta.url)))); }
  catch (e) {
    if (e instanceof DeckError) { console.error(e.message); process.exit(1); }
    throw e;
  }
}
