// tools/deck.mjs on a copy of the repository's deck files (a temporary
// directory), never the tree itself: short reproduces HEAD's Journey and the
// controller's two lists exactly; long is the 27-cue talk in its order; a cue
// switched off and on comes back byte for byte; a bad anchor writes nothing.
//   node tools/deck.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, controllerArrays } from './deck.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['documents/talk-deck.json', 'documents/talk-deck-steps.json', 'documents/tsc-2026-journey.json',
  'documents/tsc-2026-media-manifest.json', 'slides/previews/144p-30fps/manifest.json', 'controller.html',
  'core/schema-slides.js', 'core/presentation.js'];
const J = 'documents/tsc-2026-journey.json', C = 'controller.html', D = 'documents/talk-deck.json';
const dirs = [];
function copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-test-'));
  dirs.push(dir);
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(repo, f), path.join(dir, f));
  }
  return dir;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const head = f => execFileSync('git', ['show', 'HEAD:' + f], { cwd: repo, maxBuffer: 64 << 20 }).toString();
const quiet = (argv, dir) => run(argv.concat('--force'), dir);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok', name); };

const LONG = ['Intro Slide', 'Harmonica', 'Heartbeat', 'Audification Explained', 'Nightingale', 'Shepard Tone',
  "Shepard's Rise", 'Earthquake', 'Rotating Sun', 'Spherical Harmonics — hum along!', 'UM X Class', 'HARP Trailer',
  'HARP Interface', 'ANOM Solar', "Mother's Day CME", 'MMS Reconnection', 'ANOM Jupiter', 'Voyager Jupiter Bow Shock',
  'E13 HCS Crossing', 'ANOM Solar 2', 'WISPR CME', 'Touching the Sun', 'SDO/AIA Audification', 'JVKE Golden Hour',
  'Ed Mitchell VR', 'QR + Sun 🌞', 'Guided Meditation 🎵🌞🎵'];

test('short reproduces HEAD exactly (Journey, CUES, prefixes)', () => {
  const dir = copy();
  quiet(['long'], dir);
  quiet(['short'], dir);
  const headJ = head(J);
  assert.deepEqual(JSON.parse(read(dir, J)), JSON.parse(headJ));
  assert.equal(read(dir, J), headJ, 'byte for byte, so its revision is the one already installed');
  const a = controllerArrays(read(dir, C)), b = controllerArrays(head(C));
  assert.deepEqual(a.cues, b.cues);
  assert.deepEqual(a.prefixes, b.prefixes);
});

test('long is the 27 cues in order, the new ones cloned with their own file', () => {
  const dir = copy();
  quiet(['long'], dir);
  const j = JSON.parse(read(dir, J)), a = controllerArrays(read(dir, C));
  assert.equal(j.steps.length, 27);
  assert.deepEqual(a.cues, LONG);
  const deck = JSON.parse(read(dir, D)), on = deck.cues.filter(c => c.on);
  assert.deepEqual(on.map(c => c.label), LONG);
  on.forEach((c, i) => assert.equal(j.steps[i].overrides.slideFile, c.file || 'none', c.id));
  // the journey's own fields unchanged
  const hj = JSON.parse(head(J));
  for (const k of Object.keys(hj)) if (k !== 'steps') assert.deepEqual(j[k], hj[k], k);
  // the 16 old steps unchanged, wherever they now sit
  const old = hj.steps.map(s => JSON.stringify(s));
  for (const s of old) assert.ok(j.steps.some(t => JSON.stringify(t) === s));
  assert.ok(a.prefixes.length <= 27);
});

test('off then on brings the same step back byte for byte', () => {
  const dir = copy();
  quiet(['long'], dir);
  const before = read(dir, J), html = read(dir, C), jv = JSON.parse(before).steps[23];
  quiet(['off', '210'], dir);
  const mid = JSON.parse(read(dir, J));
  assert.equal(mid.steps.length, 26);
  assert.ok(!mid.steps.some(s => s.overrides.slideFile.startsWith('210_')));
  assert.ok(!controllerArrays(read(dir, C)).cues.includes('JVKE Golden Hour'));
  quiet(['on', 'jvke'], dir);
  assert.equal(read(dir, J), before);
  assert.equal(read(dir, C), html);
  assert.equal(JSON.stringify(JSON.parse(read(dir, J)).steps[23]), JSON.stringify(jv));
});

test('a bad anchor writes nothing', () => {
  const dir = copy();
  quiet(['long'], dir);
  const snap = FILES.map(f => read(dir, f));
  // the CUES literal twice
  const html = read(dir, C);
  fs.writeFileSync(path.join(dir, C), html.replace('  const CUES = [', '  const CUES = [\'x\'];\n  const CUES = ['));
  const twice = read(dir, C);
  assert.throws(() => quiet(['off', 'jvke'], dir), /found 2 times/);
  assert.equal(read(dir, C), twice);
  FILES.forEach((f, i) => { if (f !== C) assert.equal(read(dir, f), snap[i], f); });
  // the prefixes literal gone
  fs.writeFileSync(path.join(dir, C), html.replace('        prefixes: [', '        prefix: ['));
  assert.throws(() => quiet(['off', 'jvke'], dir), /found 0 times/);
  FILES.forEach((f, i) => { if (f !== C) assert.equal(read(dir, f), snap[i], f); });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'documents')).filter(f => f.endsWith('.deck-tmp')), []);
});

test('a missing file stops the build without --force, and a hand-edited Journey is not overwritten', () => {
  const dir = copy();
  quiet(['long'], dir);
  const deck = JSON.parse(read(dir, D));
  deck.cues.find(c => c.id === 'jvke').file = 'nope.mp4';
  fs.writeFileSync(path.join(dir, D), JSON.stringify(deck));
  const j = read(dir, J);
  assert.throws(() => run(['build', '--force'], dir), /not in SLIDE_FILES/);
  assert.equal(read(dir, J), j);
  const dir2 = copy();
  quiet(['long'], dir2);
  const edited = JSON.parse(read(dir2, J));
  edited.steps[0].text = 'edited in the browser';
  fs.writeFileSync(path.join(dir2, J), JSON.stringify(edited, null, 1));
  assert.throws(() => quiet(['off', 'jvke'], dir2), /changed since the deck last built it/);
  quiet(['absorb'], dir2);
  assert.equal(JSON.parse(read(dir2, 'documents/talk-deck-steps.json')).intro.text, 'edited in the browser');
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(passed + ' passed');
