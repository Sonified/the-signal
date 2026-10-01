// Late gestures (nodes.js, HeartGraph): a call that lands behind the render
// horizon moves its whole gesture on by its lateness, per param and per
// source, per task, and the shadow holds the moved timeline.
// Run: node --test tools/heart-tests/c2-late.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { load } from './c2-harness.mjs';

const h = await load();
const WASM = new URL('../../js/heart/heart.wasm', import.meta.url);
const skip = !existsSync(WASM) && 'js/heart/heart.wasm is not built yet';

const SR = 48000, NOW = 10, LEAD = 3200;
const fr = t => t * SR;
// The next task: every microtask queued so far has run.
const nextTask = () => new Promise(resolve => setImmediate(resolve));
// A rig at NOW with the horizon LEAD frames ahead, built a task before the
// calls under test so the nodes are not new in it.
async function lateRig(opts = {}) {
  const r = h.rig({ stages: 2, homes: { music: 1 }, now: NOW, horizon: fr(NOW) + LEAD, ...opts });
  r.music = r.ctx.island('music');
  return r;
}
const times = recs => recs.map(r => [r.op, r.time]);

test('an anchor and a ramp at currentTime move whole, and the late cancel holds', async () => {
  const { engine, shadow, music } = await lateRig();
  const p = music.createGain().gain;
  await nextTask();
  h.take(engine);
  const before = shadow.records().length;
  p.cancelScheduledValues(NOW);
  p.setValueAtTime(0.8, NOW);
  p.linearRampToValueAtTime(0, NOW + 0.12);
  const H = fr(NOW) + LEAD;
  const want = [['param_cancel_hold', H], ['param_set', H], ['param_linear', fr(NOW + 0.12) + LEAD]];
  assert.deepEqual(times(h.take(engine)), want);
  assert.deepEqual(times(shadow.records().slice(before)), want, 'the shadow hears the same moved times');
});

test('a mixed batch: the future stays put, the late moves, each owner by its own lateness', async () => {
  const { engine, music } = await lateRig();
  const a = music.createGain().gain, b = music.createGain().gain;
  const src = music.createConstantSource(), later = music.createConstantSource();
  await nextTask();
  h.take(engine);
  const H = fr(NOW) + LEAD;
  a.setValueAtTime(1, NOW + 1);               // planned ahead: untouched
  a.setTargetAtTime(0.5, NOW + 0.02, 0.05);   // late by LEAD − 960 frames, which a's later calls keep
  a.setValueAtTime(0.25, NOW + 2);
  b.setTargetAtTime(0.3, NOW + 3, 0.1);       // another param, ahead: untouched
  src.start(NOW);                             // a source started now goes with its envelope
  src.stop(NOW + 0.5);                        // and its stop with its start
  later.start(NOW + 1.5);                     // music booked ahead: untouched
  const d = H - fr(NOW + 0.02);
  assert.deepEqual(h.take(engine).map(r => [r.op, r.node, r.time ?? r.when]), [
    ['param_set', a._node._id, fr(NOW + 1)],
    ['param_target', a._node._id, H],
    ['param_set', a._node._id, fr(NOW + 2) + d],
    ['param_target', b._node._id, fr(NOW + 3)],
    ['start', src._id, H],
    ['stop', src._id, fr(NOW + 0.5) + LEAD],
    ['start', later._id, fr(NOW + 1.5)]
  ]);
});

test('each task has its own lateness, read from the horizon once per task', async () => {
  const { engine, clock, music } = await lateRig();
  const p = music.createGain().gain, q = music.createGain().gain;
  await nextTask();
  h.take(engine);
  p.setValueAtTime(1, NOW);
  engine.horizon = () => fr(NOW) + 9999;      // moves mid-task: this task keeps the horizon it read
  q.setValueAtTime(1, NOW);
  p.linearRampToValueAtTime(0, NOW + 0.1);
  assert.deepEqual(times(h.take(engine)),
    [['param_set', fr(NOW) + LEAD], ['param_set', fr(NOW) + LEAD], ['param_linear', fr(NOW + 0.1) + LEAD]]);
  await nextTask();
  clock.currentTime = NOW + 0.05;
  const H2 = fr(NOW) + 9999;
  p.setValueAtTime(1, NOW + 0.05);
  p.linearRampToValueAtTime(0, NOW + 0.15);
  assert.deepEqual(times(h.take(engine)), [['param_set', H2], ['param_linear', fr(NOW + 0.15) + (H2 - fr(NOW + 0.05))]]);
});

test('a future cancel is a cancel, and a call with nothing late before it is untouched', async () => {
  const { engine, music } = await lateRig();
  const p = music.createGain().gain;
  await nextTask();
  h.take(engine);
  p.cancelScheduledValues(NOW + 1);
  p.setValueAtTime(1, NOW + 1);
  assert.deepEqual(times(h.take(engine)), [['param_cancel', fr(NOW + 1)], ['param_set', fr(NOW + 1)]]);
});

test('a node made in this task is born with its first value; an older one is not', async () => {
  const { engine, music } = await lateRig();
  const old = music.createGain();
  await nextTask();
  const g = music.createGain();
  h.take(engine);
  g.gain.value = 0.25;
  g.gain.value = 0.5;
  old.gain.value = 0.75;
  const H = fr(NOW) + LEAD;
  assert.deepEqual(h.take(engine).map(r => [r.node, r.time, r.value]), [
    [g._id, fr(NOW), 0.25],                   // from the node's first frame
    [g._id, H, 0.25],                         // and where its gesture lands
    [g._id, H, 0.5],
    [old._id, H, 0.75]
  ]);
});

test('a new node\'s first value makes nothing late: what is booked ahead after it keeps its time', async () => {
  const { engine, shadow, music } = await lateRig();
  const g = music.createGain(), o = music.createOscillator();
  h.take(engine);
  const before = shadow.records().length;
  const H = fr(NOW) + LEAD;
  // The bed's pass: born silent, its fades booked against a start ahead.
  g.gain.value = 0;
  g.gain.setValueCurveAtTime([0, 1], NOW + 0.5, 0.2);
  g.gain.setValueCurveAtTime([1, 0], NOW + 2, 0.2);
  // A line's tone: born at its root, its notes booked ahead.
  o.frequency.value = 110;
  o.frequency.setTargetAtTime(220, NOW + 0.1, 0.006);
  const want = [
    ['param_set', g._id, fr(NOW)],            // from the node's first frame
    ['param_set', g._id, H],                  // and at the present
    ['param_curve', g._id, fr(NOW + 0.5)],
    ['param_curve', g._id, fr(NOW + 2)],
    ['param_set', o._id, fr(NOW)],
    ['param_set', o._id, H],
    ['param_target', o._id, fr(NOW + 0.1)]
  ];
  const at = recs => recs.map(r => [r.op, r.node, r.time ?? r.when]);
  assert.deepEqual(at(h.take(engine)), want);
  assert.deepEqual(at(shadow.records().slice(before)), want, 'the shadow hears the same times');
});

test('a new node\'s first value then a late gesture: the gesture moves whole, from the value', async () => {
  const { engine, shadow, music } = await lateRig();
  const g = music.createGain(), v = music.createGain(), src = music.createConstantSource();
  h.take(engine);
  const before = shadow.records().length;
  const H = fr(NOW) + LEAD;
  // A short fade in written from currentTime: it keeps its 50 ms, from the
  // present, and what follows it in the task moves with it.
  g.gain.value = 0;
  g.gain.linearRampToValueAtTime(1, NOW + 0.05);
  g.gain.setValueAtTime(0.5, NOW + 1);
  // An ambience voice: born at 0, a fade in and a start at currentTime,
  // moved by the same Δ.
  v.gain.value = 0;
  v.gain.setTargetAtTime(0.5, NOW, 0.2);
  src.start(NOW);
  const want = [
    ['param_set', g._id, fr(NOW)],
    ['param_set', g._id, H],
    ['param_linear', g._id, fr(NOW + 0.05) + LEAD],
    ['param_set', g._id, fr(NOW + 1) + LEAD],
    ['param_set', v._id, fr(NOW)],
    ['param_set', v._id, H],
    ['param_target', v._id, H],
    ['start', src._id, H]
  ];
  const at = recs => recs.map(r => [r.op, r.node, r.time ?? r.when]);
  assert.deepEqual(at(h.take(engine)), want);
  assert.deepEqual(at(shadow.records().slice(before)), want.filter(x => x[0] !== 'start'),
    'the shadow hears the same param times');
});

test('an older node\'s late gesture still moves whole, and what follows it', async () => {
  const { engine, music } = await lateRig();
  const old = music.createGain();
  await nextTask();
  h.take(engine);
  const H = fr(NOW) + LEAD;
  old.gain.value = 0;                         // a gesture: late, so its param is
  old.gain.setValueCurveAtTime([0, 1], NOW + 0.5, 0.2);
  assert.deepEqual(times(h.take(engine)), [['param_set', H], ['param_curve', fr(NOW + 0.5) + LEAD]]);
});

test('on the real shadow, a new node holds its first value, then plays its fade on its true time', { skip }, async () => {
  const shadow = await h.Shadow.create(SR, readFileSync(WASM));
  const { engine, clock, music } = await lateRig({ shadow });
  const g = music.createGain().gain;
  g.value = 0.25;
  g.linearRampToValueAtTime(0.25, NOW + 0.5);
  g.linearRampToValueAtTime(0.75, NOW + 1.5);
  assert.equal(g.value, 0.25, 'its first value at the present');
  await nextTask();
  // A second on, at the middle of the ramp booked ahead: it was not moved.
  clock.currentTime = NOW + 1 - LEAD / SR;
  engine.horizon = () => fr(NOW + 1);
  assert.ok(Math.abs(g.value - 0.5) < 1e-6, `half way up on its true time (${g.value})`);
});

test('value reads ask the shadow at the present; presentTime is the horizon', async () => {
  const { shadow, ctx, music } = await lateRig();
  const p = music.createGain().gain;
  void p.value;
  assert.equal(shadow.reads.at(-1).frame, fr(NOW) + LEAD);
  assert.equal(ctx.presentTime, NOW + LEAD / SR);
});

test('an engine with nothing ahead (offline) moves nothing', async () => {
  const { engine, music } = await lateRig({ horizon: 0 });
  const p = music.createGain().gain;
  await nextTask();
  h.take(engine);
  p.cancelScheduledValues(NOW);
  p.setValueAtTime(1, NOW);
  p.linearRampToValueAtTime(0, NOW + 0.1);
  assert.deepEqual(times(h.take(engine)),
    [['param_cancel', fr(NOW)], ['param_set', fr(NOW)], ['param_linear', fr(NOW + 0.1)]]);
});

test('on the real shadow, a pause gate re-anchored mid-ramp is continuous', { skip }, async () => {
  const shadow = await h.Shadow.create(SR, readFileSync(WASM));
  const { engine, clock, music } = await lateRig({ shadow });
  const gate = music.createGain().gain;
  gate.value = 1;
  await nextTask();
  const anchor = t => { const v = gate.value; gate.cancelScheduledValues(t); gate.setValueAtTime(v, t); };
  // The pause: down over 0.12 s from where it lands.
  anchor(NOW);
  gate.linearRampToValueAtTime(0, NOW + 0.12);
  assert.equal(gate.value, 1, 'read where the gesture lands, it has not begun');
  await nextTask();
  // 50 ms on, a resume, with the horizon 50 ms on too.
  clock.currentTime = NOW + 0.05;
  engine.horizon = () => fr(NOW + 0.05) + LEAD;
  const mid = gate.value;
  assert.ok(Math.abs(mid - (1 - 0.05 / 0.12)) < 1e-6, `the pause's ramp is where it should be (${mid})`);
  anchor(NOW + 0.05);
  assert.equal(gate.value, mid, 'the anchor holds the value it was taken from: no step');
  gate.linearRampToValueAtTime(1, NOW + 0.17);
  await nextTask();
  clock.currentTime = NOW + 0.11;
  engine.horizon = () => fr(NOW + 0.11) + LEAD;
  assert.ok(Math.abs(gate.value - (mid + (1 - mid) * 0.5)) < 1e-6, `half way back up (${gate.value})`);
});
