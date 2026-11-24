// A reload of the ?presentation page brings the published deck in
// (main.js calls core/presentation.js presentInstall after the login, with
// core/journey.js journeyInstall as its importer): a new export installs and
// is current, the same one again is left alone, an EARLIER one put back
// installs again (a deck switched off and on, or short after long), and each
// install replaces the copy the one before it left, so the library does not
// fill with copies. A journey made by hand is never replaced.
//
//   node --test tools/presentation-reinstall.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// the browser stand-ins tools/presentation-gate.test.mjs loads the store with
const noop = () => {};
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
const ls = new Map();
globalThis.localStorage ??= { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k), key: () => null, length: 0 };
globalThis.window ??= globalThis; globalThis.addEventListener ??= noop; globalThis.removeEventListener ??= noop; globalThis.dispatchEvent ??= () => true;
globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop });
globalThis.document ??= any; globalThis.requestAnimationFrame ??= noop;
globalThis.location ??= { search: '', hostname: 'localhost', href: 'http://localhost/' };
for (const k of ['AudioContext', 'Worker', 'BroadcastChannel', 'ResizeObserver', 'Image', 'Audio', 'OffscreenCanvas', 'MessageChannel', 'AudioWorkletNode', 'GainNode', 'OscillatorNode', 'MediaStream', 'IntersectionObserver', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'CustomEvent', 'FontFace', 'screen', 'visualViewport']) globalThis[k] ??= any;
await import('../core/schema.js');
const { initStore } = await import('../core/store.js');
const { presentInstall, setPresentFetch, JOURNEY_TITLE } = await import('../core/presentation.js');
const { journeyInstall, journeyNew, journeyCount } = await import('../core/journey.js');

const mem = new Map();
initStore({ get: k => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v) });
const settle = () => new Promise(r => setTimeout(r, 120));   // saveKey's own delay
const library = () => JSON.parse(mem.get('signal.journeys.v1'));

const longText = fs.readFileSync(new URL('../documents/tsc-2026-journey.json', import.meta.url), 'utf8');
const manifestText = fs.readFileSync(new URL('../documents/tsc-2026-media-manifest.json', import.meta.url), 'utf8');
const long = JSON.parse(longText);
// a second deck: the same Journey with its last video step pulled
const cut = long.steps.length - 3;
const shortText = JSON.stringify({ ...long, steps: long.steps.filter((s, i) => i !== cut) }, null, 1);

test('a reload installs a new deck, leaves the same one, and takes an earlier one back', async () => {
  let text = longText;
  setPresentFetch(async url => (url.endsWith('journey.json') ? text : manifestText), journeyInstall);
  // a journey of the viewer's own, there before any install
  journeyNew('My own');
  await settle();
  const before = library().items.length;

  assert.equal(await presentInstall(), 'installed');
  await settle();
  let lib = library();
  assert.equal(lib.items.length, before + 1, 'the first install adds one journey');
  const mine = lib.items.find(it => it.id === lib.cur);
  assert.equal(mine.title, JOURNEY_TITLE);
  assert.equal(journeyCount(), long.steps.length, 'and it is the current one');

  assert.equal(await presentInstall(), 'present', 'the same deck again: left alone');
  await settle();
  assert.equal(library().items.length, before + 1);

  text = shortText;
  assert.equal(await presentInstall(), 'installed', 'a changed deck installs');
  await settle();
  lib = library();
  assert.equal(lib.items.length, before + 1, 'in place of the last copy, not beside it');
  assert.equal(lib.items.find(it => it.id === lib.cur).title, JOURNEY_TITLE, 'under the same plain title');
  assert.equal(journeyCount(), long.steps.length - 1);

  text = longText;
  assert.equal(await presentInstall(), 'installed', 'the earlier deck put back installs again');
  await settle();
  lib = library();
  assert.equal(lib.items.length, before + 1);
  assert.equal(journeyCount(), long.steps.length);
  assert.ok(lib.items.some(it => it.title === 'My own'), 'the viewer\'s own journey is still there');
  // every journey still listed has its record, and no record is left over
  const kept = [...mem.keys()].filter(k => /\.j\d+$/.test(k) && mem.get(k) !== 'null');
  assert.equal(kept.length, lib.items.length, 'no orphaned journey records in storage');
});

test('a copy renamed by hand is the viewer\'s now: the next install leaves it', async () => {
  const lib0 = library();
  // rename the installed copy in storage's own terms: its title no longer matches the kept one
  const { journeyRenameAt } = await import('../core/journey.js');
  const at = lib0.items.findIndex(it => it.id === lib0.cur);
  journeyRenameAt(at, 'Kept by hand');
  await settle();
  setPresentFetch(async url => (url.endsWith('journey.json') ? shortText : manifestText), journeyInstall);
  assert.equal(await presentInstall(), 'installed');
  await settle();
  const lib = library();
  assert.equal(lib.items.length, lib0.items.length + 1, 'added beside it');
  assert.ok(lib.items.some(it => it.title === 'Kept by hand'));
});

test('a deck marked only by older code installs once more (it mends a cue left on the wrong video)', async () => {
  // what a browser holds after older code installed this revision: the
  // per-revision marker and no last-revision key
  const { presentRevision } = await import('../core/presentation.js');
  const rev = await presentRevision(shortText);
  const fresh = await import('../core/presentation.js?older');
  mem.set('signal.presentationJourney.' + rev, JSON.stringify('1'));
  mem.delete('signal.presentationJourney.last');
  fresh.setPresentFetch(async url => (url.endsWith('journey.json') ? shortText : manifestText), journeyInstall);
  assert.equal(await fresh.presentInstall(), 'installed');
  await settle();
  assert.equal(JSON.parse(mem.get('signal.presentationJourney.last')), rev, 'and now this code has marked it');
  assert.equal(await fresh.presentInstall(), 'present');
});

test('a page older than the deck imports nothing, marks nothing, and reloads once', async () => {
  const { JOURNEY_STALE } = await import('../core/journey.js');
  const unknown = JSON.parse(longText);
  unknown.steps[1].overrides.slideFile = '999_A_Video_This_Page_Never_Heard_Of.mp4';
  const before = library().items.length;
  assert.equal(journeyInstall(JOURNEY_TITLE, unknown), JOURNEY_STALE);
  await settle();
  assert.equal(library().items.length, before, 'nothing imported');

  const stale = await import('../core/presentation.js?stale');
  const text = JSON.stringify(unknown, null, 1);
  // the manifest lists it (the site is current; only this page is old)
  const m = JSON.parse(manifestText);
  m.videos.push({ file: unknown.steps[1].overrides.slideFile, bytes: 1, sha256: '0' });
  const ss = new Map();
  globalThis.sessionStorage = { getItem: k => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, String(v)) };
  let reloads = 0;
  const loc = globalThis.location;
  globalThis.location = { ...loc, reload: () => { reloads++; } };
  try {
    stale.setPresentFetch(async url => (url.endsWith('journey.json') ? text : JSON.stringify(m)), journeyInstall);
    assert.equal(await stale.presentInstall(), 'stale');
    assert.equal(reloads, 1, 'reloaded for the new code');
    assert.equal(await stale.presentInstall(), 'stale');
    assert.equal(reloads, 1, 'and only once: no loop if the site itself is behind');
    const rev = await stale.presentRevision(text);
    assert.equal(mem.get('signal.presentationJourney.' + rev), undefined, 'not marked installed');
  } finally { globalThis.location = loc; }
});
