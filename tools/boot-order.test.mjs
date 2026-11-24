// The page's boot order, checked. main.js's own imports are loaded one by one
// in the order written, as the browser evaluates them, with the same browser
// stand-ins the camera tests use. An import loop entered from the wrong end
// reads a value before it is made ("Cannot access X before initialization")
// and the page dies at boot: v1.73 did, through Live Video's import sitting
// early in main.js. Run: node --test tools/boot-order.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const noop = () => {};
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
const ls = new Map();
globalThis.localStorage ??= { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k), key: () => null, length: 0 };
globalThis.window ??= globalThis; globalThis.addEventListener ??= noop; globalThis.removeEventListener ??= noop; globalThis.dispatchEvent ??= () => true;
globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop });
globalThis.document ??= any; globalThis.requestAnimationFrame ??= noop;
globalThis.location ??= { search: '', hostname: 'localhost', href: 'http://localhost/' };
for (const k of ['AudioContext', 'Worker', 'BroadcastChannel', 'ResizeObserver', 'Image', 'Audio', 'OffscreenCanvas', 'MessageChannel', 'AudioWorkletNode', 'GainNode', 'OscillatorNode', 'MediaStream', 'IntersectionObserver', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'CustomEvent', 'FontFace', 'screen', 'visualViewport']) globalThis[k] ??= any;
// the modules' standing timers must not hold the test open
const realInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const t = realInterval(fn, ms); if (t && t.unref) t.unref(); return t; };

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test("main.js's imports all load, in the page's order", async () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const specs = [...src.matchAll(/^import [^;]*? from '(\.\/[^']+)';/gms)].map(m => m[1]);
  assert.ok(specs.length > 50, 'found main.js imports');
  for (const s of specs) {
    try { await import(pathToFileURL(path.join(ROOT, s)).href); }
    catch (e) { assert.fail(s + ' failed to load: ' + e.message); }
  }
});
