// HeartParam: the AudioParam surface, its checks, frames on the wire, and
// value reads answered by the shadow.
// Run: node --test tools/heart-tests/c2-params.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

const h = await load();
const F32_MAX = 3.4028234663852886e38;

test('every method returns the param and sends one record to the stage and one to the shadow', () => {
  const { engine, shadow, ctx } = h.rig({ stages: 2, homes: { music: 1 } });
  const g = ctx.island('music').createGain(), p = g.gain;
  h.take(engine);
  const before = shadow.records().length;
  assert.equal(p.setValueAtTime(0.5, 1), p);
  assert.equal(p.linearRampToValueAtTime(1, 2), p);
  assert.equal(p.exponentialRampToValueAtTime(0.25, 3), p);
  assert.equal(p.setTargetAtTime(0, 4, 0.1), p);
  assert.equal(p.setValueCurveAtTime([0, 1, 0.5], 5, 2), p);
  assert.equal(p.cancelScheduledValues(6), p);
  assert.equal(p.cancelAndHoldAtTime(7), p);
  const ops = ['param_set', 'param_linear', 'param_exp', 'param_target', 'param_curve', 'param_cancel', 'param_cancel_hold'];
  const recs = h.take(engine);
  assert.deepEqual(recs.map(r => r.op), ops);
  assert.ok(recs.every(r => r.stage === 1 && r.node === g._id && r.param === 0));
  assert.deepEqual(shadow.records().slice(before).map(r => r.op), ops);
});

test('times become frames, tau and curve duration stay seconds, and the past is the present', () => {
  const { engine, clock, ctx } = h.rig({ F: 512 });
  const p = ctx.createGain().gain;
  clock.currentTime = 10;
  h.take(engine);
  p.setValueAtTime(1, 11);
  p.setTargetAtTime(0.5, 12, 0.3);
  p.setValueCurveAtTime(new Float32Array([1, 0]), 13, 0.75);
  p.linearRampToValueAtTime(0, 2);   // already past: moved up to currentTime, as the spec does
  const recs = h.take(engine);
  const frame = t => t * 48000 - 512;
  assert.equal(recs[0].time, frame(11));
  assert.deepEqual([recs[1].time, recs[1].tau], [frame(12), 0.3]);
  assert.deepEqual([recs[2].time, recs[2].duration, recs[2].values], [frame(13), 0.75, [1, 0]]);
  assert.equal(recs[3].time, frame(10));
});

test('value reads ask the shadow at the frame of currentTime; writes are setValueAtTime(v, now)', () => {
  const { engine, clock, shadow, ctx } = h.rig({ F: 64 });
  const f = ctx.createBiquadFilter();
  clock.currentTime = 3;
  shadow.answer = 1234;
  assert.equal(f.Q.value, 1234);
  assert.deepEqual(shadow.reads.at(-1), { node: f._id, param: 2, frame: 3 * 48000 - 64 });
  h.take(engine);
  f.frequency.value = 880;
  assert.deepEqual(h.take(engine).map(({ op, param, time, value }) => ({ op, param, time, value })),
    [{ op: 'param_set', param: 0, time: 3 * 48000 - 64, value: 880 }]);
});

test('Web Audio\'s argument checks', () => {
  const { engine, ctx } = h.rig();
  const p = ctx.createGain().gain;
  h.take(engine);
  assert.throws(() => p.exponentialRampToValueAtTime(0, 1), RangeError);
  assert.throws(() => p.setValueAtTime(1, -1), RangeError);
  assert.throws(() => p.linearRampToValueAtTime(1, -0.5), RangeError);
  assert.throws(() => p.setTargetAtTime(1, 0, -0.1), RangeError);
  assert.throws(() => p.setValueCurveAtTime([1, 0], 0, 0), RangeError);
  assert.throws(() => p.setValueCurveAtTime([1], 0, 1), { name: 'InvalidStateError' });
  assert.throws(() => p.setValueCurveAtTime([1, NaN], 0, 1), TypeError);
  assert.throws(() => p.setValueAtTime(NaN, 0), TypeError);
  assert.throws(() => { p.value = Infinity; }, TypeError);
  assert.throws(() => p.cancelScheduledValues(-1), RangeError);
  assert.throws(() => p.cancelAndHoldAtTime(-1), RangeError);
  assert.deepEqual(h.take(engine), [], 'a refused call sends nothing');
  p.exponentialRampToValueAtTime(-0.5, 1);   // negative is legal; only 0 is refused
  p.setTargetAtTime(1, 0, 0);                // a zero time constant jumps, and is legal
  assert.equal(h.take(engine).length, 2);
});

test('ranges from the protocol table, resolved per context and node', () => {
  const { ctx } = h.rig();
  const g = ctx.createGain().gain;
  assert.deepEqual([g.defaultValue, g.minValue, g.maxValue, g.automationRate], [1, -F32_MAX, F32_MAX, 'a-rate']);
  const f = ctx.createBiquadFilter();
  assert.deepEqual([f.frequency.minValue, f.frequency.maxValue, f.frequency.defaultValue], [0, 24000, 350]);
  assert.deepEqual([f.gain.minValue, f.gain.maxValue], [-1541, 1541]);
  const o = ctx.createOscillator();
  assert.deepEqual([o.frequency.minValue, o.frequency.maxValue], [-24000, 24000]);
  const d = ctx.createDelay(2.5);
  assert.deepEqual([d.delayTime.minValue, d.delayTime.maxValue], [0, 2.5]);
  assert.throws(() => ctx.createDelay(0), { name: 'NotSupportedError' });
  assert.throws(() => ctx.createDelay(200), { name: 'NotSupportedError' });
  const s = ctx.createBufferSource();
  assert.equal(s.playbackRate.automationRate, 'k-rate');
  assert.throws(() => { s.playbackRate.automationRate = 'a-rate'; }, { name: 'InvalidStateError' });
  assert.equal(ctx.createStereoPanner().pan.minValue, -1);
  assert.equal(ctx.createConstantSource().offset.defaultValue, 1);
});

test('enum attributes: type on filters and oscillators', () => {
  const { engine, ctx } = h.rig();
  const f = ctx.createBiquadFilter(), o = ctx.createOscillator();
  h.take(engine);
  f.type = 'highpass';
  f.type = 'bogus';            // ignored, as WebIDL ignores it
  o.type = 'triangle';
  assert.throws(() => { o.type = 'custom'; }, { name: 'InvalidStateError' });
  assert.deepEqual(h.take(engine).map(r => [r.node, r.attr, r.value]), [[f._id, 1, 1], [o._id, 1, 3]]);
  assert.deepEqual([f.type, o.type], ['highpass', 'triangle']);
});
