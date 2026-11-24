// Presentation mode's gate and its TSC 2026 Journey install
// (core/presentation.js): the gate asks the relay through the login hook and
// holds no password of its own, a browser holding the show's login is
// unlocked, the install runs once per export revision, the slides are
// checked against the manifest. Also the livestream room a presentation
// page broadcasts to (core/broadcast.js livestreamRoomFor). The password
// used here is a made-up stand-in; the real one is the relay's alone.
//
//   node --test tools/presentation-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// the store pulls in v0's page modules: the journey sim's stand-ins for a
// browser (tools/journey-sim.test.mjs), and the schema first, the order the
// app loads it in
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
const presentation = await import('../core/presentation.js');
const {
  presentUnlocked, presentTry, presentAsk, setPresentAuth, presentInstall, presentRevision,
  presentJourneyProblem, setPresentFetch, JOURNEY_TITLE, PRESENT_WRONG, PRESENT_DOWN
} = presentation;
const { livestreamRoomFor, LIVE_ROOM } = await import('../core/broadcast.js');
const { LIVESTREAM_ROOM } = await import('../platform/broadcast-socket.js');

const mem = new Map();
initStore({ get: k => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v) });

const journeyText = fs.readFileSync(new URL('../documents/tsc-2026-journey.json', import.meta.url), 'utf8');
const manifestText = fs.readFileSync(new URL('../documents/tsc-2026-media-manifest.json', import.meta.url), 'utf8');

const FAKE = 'not-the-real-password';

test('the gate holds no password of its own', () => {
  for (const k of ['PRESENT_PASSWORD', 'presentPasswordOk', 'presentUnlock']) assert.equal(presentation[k], undefined, k);
  for (const f of ['../core/presentation.js', '../platform/presentation-receiver.js', '../core/schema-visual.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /PRESENT_PASSWORD|presentPasswordOk/, f);
  }
});

test('no hook: nothing is logged in, and a try reads as no relay answering', async () => {
  assert.equal(presentUnlocked(), false);
  assert.equal(await presentTry(FAKE), 'down');
  assert.equal(presentAsk.msg, PRESENT_DOWN);
  assert.equal(presentUnlocked(), false);
});

test('a browser holding the show\'s login is unlocked with no question', () => {
  let held = '';
  setPresentAuth({ loggedIn: () => !!held, login: async () => 'no' });
  assert.equal(presentUnlocked(), false);
  held = FAKE;
  assert.equal(presentUnlocked(), true);
  setPresentAuth(null);
  assert.equal(presentUnlocked(), false);
});

test('a typed password goes to the relay: no, down, then ok', async () => {
  const sent = [];
  let answer = 'no';
  setPresentAuth({ loggedIn: () => false, login: async pw => { sent.push(pw); return answer; } });
  assert.equal(await presentTry('wrong'), 'no');
  assert.equal(presentAsk.msg, PRESENT_WRONG);
  assert.ok(presentAsk.msgUntil > Date.now());
  assert.equal(presentUnlocked(), false);
  answer = 'down';
  assert.equal(await presentTry(FAKE), 'down');
  assert.equal(presentAsk.msg, PRESENT_DOWN);
  // an empty one never reaches the relay
  assert.equal(await presentTry('   '), 'no');
  assert.deepEqual(sent, ['wrong', FAKE], 'sent exactly as typed');
  // a hook that throws or rejects is no relay answering
  setPresentAuth({ loggedIn: () => false, login: () => { throw new Error('x'); } });
  assert.equal(await presentTry(FAKE), 'down');
  setPresentAuth({ loggedIn: () => false, login: () => Promise.reject(new Error('x')) });
  assert.equal(await presentTry(FAKE), 'down');
  setPresentAuth({ loggedIn: () => false, login: async () => 'ok' });
  assert.equal(await presentTry(FAKE), 'ok');
  assert.equal(presentAsk.checking, false);
  setPresentAuth(null);
  assert.equal(presentUnlocked(), true, 'unlocked in this tab from then on');
});

test('the livestream room: the show streams to livestream, a rehearsal to its own', () => {
  assert.equal(LIVE_ROOM, LIVESTREAM_ROOM, 'the broadcaster\'s room is the viewers\' default');
  assert.equal(livestreamRoomFor('show'), 'livestream');
  assert.equal(livestreamRoomFor(''), 'livestream');
  assert.equal(livestreamRoomFor(undefined), 'livestream');
  assert.equal(livestreamRoomFor('rehearsal'), 'livestream-rehearsal');
  assert.equal(livestreamRoomFor('Rehearsal'), 'livestream-rehearsal');
  assert.equal(livestreamRoomFor('a--b'), 'livestream-a-b');
  // ROOM_MAX (24), no dash left hanging at the cut
  assert.equal(livestreamRoomFor('a-very-long-rehearsal-room-name'), 'livestream-a-very-long-r');
  assert.equal(livestreamRoomFor('abcdefghijkl-xyz'), 'livestream-abcdefghijkl');
  for (const r of ['x', 'rehearsal', 'a-very-long-rehearsal-room-name', 'tsc-2026', 'Ünïcode room']) {
    const out = livestreamRoomFor(r);
    assert.match(out, /^livestream-[a-z0-9]+(-[a-z0-9]+)*$/, r);
    assert.ok(out.length <= 24, r);
  }
});

test('the revision is the standalone site\'s, from the same bytes', async () => {
  assert.equal(await presentRevision(journeyText), createHash('sha256').update(journeyText).digest('hex').slice(0, 16));
});

test('the tracked Journey passes the manifest check; a missing slide is refused', () => {
  const j = JSON.parse(journeyText), m = JSON.parse(manifestText);
  assert.equal(presentJourneyProblem(j, m), '');
  const bad = JSON.parse(journeyText);
  bad.steps[0].overrides = Object.assign({}, bad.steps[0].overrides, { slideFile: 'nope.mp4' });
  assert.match(presentJourneyProblem(bad, m), /missing: nope\.mp4/);
  assert.ok(presentJourneyProblem({ ver: 1, steps: [] }, m));
});

test('the install: once per revision, never twice, again for a new export', async () => {
  const imported = [];
  let text = journeyText;
  setPresentFetch(async url => (url.endsWith('journey.json') ? text : manifestText),
    (title, raw) => { imported.push([title, raw.steps.length]); return imported.length - 1; });
  assert.equal(await presentInstall(), 'installed');
  assert.deepEqual(imported, [[JOURNEY_TITLE, JSON.parse(journeyText).steps.length]]);
  assert.equal(await presentInstall(), 'present', 'switched on again: nothing new');
  assert.equal(imported.length, 1);
  // two at once share the one install
  const [a, b] = await Promise.all([presentInstall(), presentInstall()]);
  assert.deepEqual([a, b], ['present', 'present']);
  // a changed export installs once more
  text = journeyText.replace('}', ', "x": 1}');
  assert.equal(await presentInstall(), 'installed');
  assert.equal(imported.length, 2);
  // a failing fetch installs nothing and says so
  setPresentFetch(async () => { throw new Error('offline'); }, () => 0);
  assert.equal(await presentInstall(), 'failed');
});
