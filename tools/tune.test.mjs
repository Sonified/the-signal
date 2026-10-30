// Fine tuning (core/tune.js): cents to a rate, the knobs' range, and the
// loop arithmetic that keeps a retuned recording's schedule on the audio it
// really has: one pass of the drone's crossfading looper at any rate, a
// mid-loop change of rate re-planned from where the pass has got to, a
// cloud pad's early end, the redirectable fades, and the four settings'
// round trip through the store with their clamp.
//
//   node --test tools/tune.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TUNE_MAX, TUNE_TC, TUNE_END_MARGIN, clampCents, centsRatio, formatCents,
  playhead, posAt, retune, endsAt, planPass, endInTime, replanPasses,
  fadePoints, fadeValue, layFade
} from '../core/tune.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const UP = centsRatio(100), DOWN = centsRatio(-100);

test('cents: a semitone each way, exactly 1 at 0, whole cents, readout', () => {
  assert.equal(centsRatio(0), 1);
  assert.ok(close(UP, Math.pow(2, 1 / 12)) && close(DOWN, Math.pow(2, -1 / 12)));
  assert.ok(close(centsRatio(1200), 2));
  assert.equal(clampCents(250), TUNE_MAX);
  assert.equal(clampCents(-250), -TUNE_MAX);
  assert.equal(clampCents(12.6), 13);
  for (const bad of [NaN, Infinity, '30', null, undefined]) assert.equal(clampCents(bad), 0);
  assert.equal(formatCents(0), '0 cents');
  assert.equal(formatCents(37), '+37 cents');
  assert.equal(formatCents(-100), '-100 cents');
});

// The drone's numbers (audio/music/manifest.json): loop 2..32, crossfade 3.
const LS = 2, LE = 32, XF = 3;

test('a pass at rate 1 is the schedule the drone always had', () => {
  const p = planPass(10, LS, LE, XF, 1);
  assert.equal(p.stopAt, 10 + (LE - LS));
  assert.equal(p.fadeAt, 10 + (LE - LS) - XF);
});

test('a pass at any rate ends exactly when its audio does, the next starting with its fade', () => {
  for (const c of [-100, -37, 0, 1, 50, 100]) {
    const r = centsRatio(c), p = planPass(0, LS, LE, XF, r);
    // the playhead reaches the loop end just as the pass stops: never cut, never a gap
    assert.ok(close(posAt(playhead(0, LS, r), p.stopAt), LE, 1e-9), `${c} cents`);
    assert.ok(close(p.stopAt - p.fadeAt, XF), 'the crossfade keeps its length');
    // the next pass, booked at the fade, overlaps the last XF seconds of this one's audio
    const next = planPass(p.fadeAt, LS, LE, XF, r);
    assert.ok(next.stopAt > p.stopAt);
  }
  assert.ok(planPass(0, LS, LE, XF, UP).stopAt < 30 && planPass(0, LS, LE, XF, DOWN).stopAt > 30);
});

test('a playhead follows a change of rate from where it is, the glide booked tc later', () => {
  const h = playhead(0, LS, 1);
  assert.equal(posAt(h, 10), 12);
  retune(h, 10, UP);
  // anchored at the glide's equivalent instant
  assert.ok(close(h.t, 10 + TUNE_TC) && close(h.pos, 12 + TUNE_TC));
  assert.ok(close(posAt(h, 20), 12 + TUNE_TC + (20 - 10 - TUNE_TC) * UP));
  assert.ok(close(endsAt(h, LE), h.t + (LE - h.pos) / UP));
  // a source not yet begun simply starts at the new rate
  const later = playhead(50, LS, 1);
  retune(later, 10, DOWN);
  assert.equal(later.t, 50); assert.equal(later.pos, LS); assert.equal(later.rate, DOWN);
  assert.ok(close(endsAt(later, LE), planPass(50, LS, LE, XF, DOWN).stopAt));
});

// A pass as js/piano.js books it, and the passes the looper keeps ahead.
function pass(at, rate) {
  const p = planPass(at, LS, LE, XF, rate);
  return { at, end: LE, fadeAt: p.fadeAt, stopAt: p.stopAt, h: playhead(at, LS, rate) };
}
function booked(rate, from, n) {
  const out = [];
  let at = from;
  for (let i = 0; i < n; i++) { const p = pass(at, rate); out.push(p); at = p.fadeAt; }
  return out;
}

test('mid-loop, the rate going up: the sounding pass ends early by its audio, the next comes in over the same window', () => {
  const passes = booked(1, 0, 4);              // 0, 27, 54, 81
  const t = 10;
  for (const p of passes) retune(p.h, t, UP);
  const plan = replanPasses(passes, t);
  assert.deepEqual(plan.drop, passes.slice(1), 'every pass not yet begun is booked again');
  assert.equal(plan.early.length, 1);
  const e = plan.early[0];
  // where the audio truly runs out at the new speed
  const audioEnd = 10 + TUNE_TC + (LE - (12 + TUNE_TC)) / UP;
  assert.ok(close(e.to, audioEnd - TUNE_END_MARGIN, 1e-9));
  assert.ok(e.to < passes[0].stopAt, 'earlier than its old booking: no cut-off mid-fade');
  assert.ok(close(e.to - e.from, XF), 'the crossfade keeps its length');
  assert.ok(close(plan.nextAt, e.from) && close(plan.nextFade, XF));
  // the next pass, booked from there at the new rate, again ends on its audio
  const n = planPass(plan.nextAt, LS, LE, XF, UP);
  assert.ok(close(posAt(playhead(plan.nextAt, LS, UP), n.stopAt), LE));
});

test('mid-loop, the rate going down: the sounding pass keeps its fade, the next starts exactly where it was booked', () => {
  const passes = booked(1, 0, 4);
  const t = 10;
  for (const p of passes) retune(p.h, t, DOWN);
  const plan = replanPasses(passes, t);
  assert.equal(plan.early.length, 0, 'it has audio to spare');
  assert.equal(plan.nextAt, 27);
  assert.equal(plan.nextFade, XF);
  assert.equal(plan.drop.length, 3);
});

test('a change late in the fade: the outgoing pass is ended inside its audio from now', () => {
  // pass A (0..30) is fading from 27, B began at 27; at 29.5 the rate jumps up
  const [A, B, C] = booked(1, 0, 3);
  const t = 29.5;
  for (const p of [A, B, C]) retune(p.h, t, UP);
  const plan = replanPasses([A, B, C], t);
  assert.deepEqual(plan.drop, [C]);
  const ea = plan.early.find(e => e.pass === A);
  assert.ok(ea, 'A would run out before 30');
  assert.equal(ea.from, t, 'no room left for a full fade: from now');
  assert.ok(ea.to <= endsAt(A.h, LE) && ea.to > t);
  // B, the newest sounding pass, ends early too and the next is planned off it
  const eb = plan.early.find(e => e.pass === B);
  assert.ok(eb && close(plan.nextAt, eb.from));
});

test('a change before the run has begun: every pass dropped, the first booked again as it was', () => {
  const passes = booked(1, 5, 4);              // the drone just switched on, its first pass due at 5
  const plan = replanPasses(passes, 4.97);
  assert.deepEqual(plan.drop, passes);
  assert.equal(plan.first, passes[0]);
  assert.equal(plan.nextAt, 5, 'it still begins when it was going to');
  assert.equal(plan.early.length, 0);
});

test('a cloud pad: early fade over its release only when the audio would run out first', () => {
  // a 15 s pad resampled up a fourth, its envelope booked at 0 as
  // js/clouds.js books it: 11 s, or what the file has left less 0.3 s
  const rate = Math.pow(2, 5 / 12), len = Math.min(11, 15 / rate - 0.3), R = 6.5;
  const h = playhead(0, 0, rate);
  assert.ok(endsAt(h, 15) > len, 'fits as booked');
  retune(h, 4, rate * UP);
  // at rate x UP the 15 s file lasts 15 / (1.335 x 1.059) = 10.6 s: it must close by then
  const w = endInTime(h, 15, len, 4, R);
  assert.ok(w && close(w.to, endsAt(h, 15) - TUNE_END_MARGIN));
  assert.ok(close(w.from, w.to - R), 'over its own release where there is room');
  // a low pad has audio to spare whatever the knob does
  const low = playhead(0, 0, 1);
  retune(low, 4, UP);
  assert.equal(endInTime(low, 15, len, 4, R), null);
});

test('fades: the segments a fade lays are the values it reports, and a redirect starts where the sound is', () => {
  const f = { from: 1, t0: 10, t1: 13, shape: 'power' };
  assert.equal(fadeValue(null, 5), 1);
  assert.equal(fadeValue(f, 9), 1);
  assert.equal(fadeValue(f, 14), 0);
  assert.ok(close(fadeValue(f, 13 - 1e-9), 0, 1e-6));
  for (const [t, v] of fadePoints(1, 10, 13)) assert.ok(close(fadeValue(f, t), v, 1e-12));
  assert.ok(close(fadeValue(f, 11.5), Math.cos(Math.PI / 4), 0.02), 'equal power at the middle');
  // a fake param records what is laid on it
  const log = [];
  const param = {
    cancelScheduledValues: t => log.push(['cancel', t]),
    setValueAtTime: (v, t) => log.push(['set', v, t]),
    linearRampToValueAtTime: (v, t) => log.push(['ramp', v, t])
  };
  const g = layFade(param, f, 11.5, 11.5, 12.5, 'power');
  assert.deepEqual(log[0], ['cancel', 11.5]);
  assert.equal(log[1][0], 'set');
  assert.ok(close(log[1][1], fadeValue(f, 11.5)), 'cut from the value reached, no jump');
  assert.ok(close(log.at(-1)[1], 0, 1e-12));
  assert.equal(log.at(-1)[2], 12.5);
  assert.ok(close(g.from, fadeValue(f, 11.5)));
});

test('the four rows, and the settings riding the store, held to the range at restore', async () => {
  // the schema and the store, with the page's globals stood in for as the
  // journey suites do (tools/journey-remote-snapshot.test.mjs)
  const noop = () => {};
  const mem = new Map();
  globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.addEventListener = globalThis.removeEventListener = noop;
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
  const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
  globalThis.document = any;
  for (const k of ['AudioContext', 'Worker', 'BroadcastChannel', 'ResizeObserver', 'Image', 'WebSocket', 'Audio', 'OffscreenCanvas', 'MessageChannel', 'AudioWorkletNode', 'GainNode', 'OscillatorNode', 'MediaStream', 'IntersectionObserver', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'EventTarget', 'FontFace', 'fetch', 'screen', 'visualViewport']) globalThis[k] ??= any;
  globalThis.location = { search: '', hostname: 'localhost', href: 'http://localhost/' };
  globalThis.requestAnimationFrame = noop;
  globalThis.dispatchEvent = () => true;
  const log = console.log; console.log = noop;
  const { S } = await import('../js/state.js');
  const { byId } = await import('../core/schema.js');
  const { machineControl } = await import('../core/presets.js');
  const store = await import('../core/store.js');
  console.log = log;
  store.initStore({ get: k => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) });
  const rows = { pianoTune: 'musicPianoDrawer', bedTune: 'musicDroneDrawer', cloudTune: 'musicCloudsDrawer', choirTune: 'musicChoirDrawer' };
  for (const [id, parent] of Object.entries(rows)) {
    const c = byId(id);
    assert.ok(c, id);
    assert.equal(c.parent, parent);
    assert.deepEqual([c.min, c.max, c.step, c.def], [-100, 100, 1, 0]);
    assert.equal(typeof c.formatAt, 'function'); assert.equal(c.format, undefined, 'formatAt only');
    assert.deepEqual([c.formatAt(0), c.formatAt(5), c.formatAt(-100)], ['0 cents', '+5 cents', '-100 cents']);
    assert.equal(machineControl(c), false, 'a scene setting');
  }
  for (const k of ['pianoTune', 'bedTune', 'cloudTune', 'choirTune']) assert.equal(S[k], 0, `${k} defaults to no adjustment`);
  Object.assign(S, { pianoTune: 12, bedTune: -40, cloudTune: 100, choirTune: -7 });
  const snap = store.snapshot();
  assert.deepEqual([snap.pianoTune, snap.bedTune, snap.cloudTune, snap.choirTune], [12, -40, 100, -7]);
  const wire = JSON.parse(JSON.stringify(store.wireSettings()));
  assert.equal(wire.bedTune, -40, 'the broadcast carries them: a scene setting, not the machine\'s');
  Object.assign(S, { pianoTune: 0, bedTune: 0, cloudTune: 0, choirTune: 0 });
  store.applySnapshot({ ...snap, pianoTune: 900, bedTune: -12.4, cloudTune: 'x', choirTune: NaN });
  assert.equal(S.pianoTune, 100);
  assert.equal(S.bedTune, -12);
  assert.equal(S.cloudTune, 0, 'not a number: left where it was');
  assert.equal(S.choirTune, 0);
});
