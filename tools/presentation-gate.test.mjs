// Presentation mode's gate and its TSC 2026 Journey install
// (core/presentation.js): the password, the unlock kept on the device, the
// install once per export revision, the slides checked against the manifest.
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
const {
  presentPasswordOk, presentUnlocked, presentUnlock, presentInstall, presentRevision,
  presentJourneyProblem, setPresentFetch, JOURNEY_TITLE, PRESENT_PASSWORD
} = await import('../core/presentation.js');

const mem = new Map();
initStore({ get: k => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v) });

const journeyText = fs.readFileSync(new URL('../documents/tsc-2026-journey.json', import.meta.url), 'utf8');
const manifestText = fs.readFileSync(new URL('../documents/tsc-2026-media-manifest.json', import.meta.url), 'utf8');

test('the password: solarmax, forgiving of case and spaces, nothing else', () => {
  assert.equal(PRESENT_PASSWORD, 'solarmax');
  for (const ok of ['solarmax', ' SolarMax ', 'SOLARMAX']) assert.ok(presentPasswordOk(ok), ok);
  for (const bad of ['', 'solar max', 'solarmax1', 'presence', null, undefined, 5]) assert.ok(!presentPasswordOk(bad), String(bad));
});

test('the unlock is kept on the device', async () => {
  assert.equal(presentUnlocked(), false);
  presentUnlock();
  assert.equal(presentUnlocked(), true, 'at once, in this tab');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(mem.get('signal.v1.presentUnlock'), '"1"', 'and written to storage');
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
