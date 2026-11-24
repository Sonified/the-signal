// Mute followers (core/follow-mute.js): the broadcaster's switch is kept in
// its browser and rides the state message as fm; a follower's mute is
// memory only, reaches every listener (js/audio.js's master, Live Sound's
// player), and never touches the follower's saved volume.
//
//   node --test tools/follow-mute.test.mjs
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
const mem = new Map();
const { initStore } = await import('../core/store.js');
initStore({ get: k => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v) });
const fm = await import('../core/follow-mute.js');

test('the broadcaster\'s switch is off by default and kept', () => {
  assert.equal(fm.muteFollowersOn(), false);
  fm.setMuteFollowers(true);
  assert.equal(fm.muteFollowersOn(), true);
  assert.equal(localStorage.getItem('signal.broadcast.muteFollowers'), 'true');
  fm.setMuteFollowers(false);
});

test('a follower\'s mute reaches its listeners once per change', () => {
  const seen = [];
  fm.onFollowMute(on => seen.push(on));
  assert.equal(fm.followGain(), 1);
  fm.setFollowMuted(true);
  fm.setFollowMuted(true);
  assert.equal(fm.followGain(), 0);
  assert.equal(fm.followMuted(), true);
  fm.setFollowMuted(false);
  assert.deepEqual(seen, [true, false]);
  assert.equal(fm.followGain(), 1);
});

test('the wiring: fm sent, taken before the duck, released with the room; no saved volume written', () => {
  const b = fs.readFileSync(new URL('../core/broadcast.js', import.meta.url), 'utf8');
  assert.match(b, /fm: muteFollowersOn\(\) \? 1 : undefined/);
  assert.match(b, /setFollowMuted\(msg\.fm === 1\);\n\s*takeDuck\(/);
  assert.match(b, /function releaseLiveActs\(\) \{\n\s*setFollowMuted\(false\);/);
  assert.match(b, /\* followGain\(\);/, 'the duck carries the mute');
  const a = fs.readFileSync(new URL('../js/audio.js', import.meta.url), 'utf8');
  assert.equal((a.match(/S\.volume \* followGain\(\)/g) || []).length, 4, 'every master ramp is muted');
  assert.doesNotMatch(fs.readFileSync(new URL('../core/follow-mute.js', import.meta.url), 'utf8'), /S\.volume\s*=/);
  const c = fs.readFileSync(new URL('../ui/screens/chrome.js', import.meta.url), 'utf8');
  assert.equal((c.match(/if \(!followMuted\(\)\) drawVolume\(/g) || []).length, 2, 'no volume drawn while muted');
});
