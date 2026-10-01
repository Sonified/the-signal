// Replicable nodes (spec 7.4): the strobe signal has one real node per
// stage that uses it, made on first use, caught up from the message log,
// and told every message after.
// Run: node --test tools/heart-tests/c2-replica.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

const h = await load();
const signalAt = (rec, sr = 48000) => new DataView(rec.bytes.buffer).getFloat64(4, true);

test('a replica is made in each stage that uses it, and replays the latest message', () => {
  const { engine, shadow, ctx } = h.rig({ stages: 3, homes: { music: 1, clouds: 2 } });
  const music = ctx.island('music'), clouds = ctx.island('clouds');
  const sig = music.createProcessor('strobe-signal');
  const a = music.createGain(), b = music.createGain(), c = clouds.createGain();
  h.take(engine);
  assert.ok(shadow.records().some(r => r.op === 'create' && r.node === sig._id && r.kind === 12));

  sig.port.postMessage({ at: 1, p: 0.25, r0: 7.5, r1: 7.5, dur: 0, wave: 2, duty: 0.5, on: true });
  sig.port.postMessage({ at: 2, p: 0.5, r0: 8, r1: 8, dur: 0, wave: 2, duty: 0.5, on: true });
  assert.deepEqual(h.take(engine), [], 'no replica yet, so nothing is sent; the log keeps it');

  sig.connect(a.gain);
  let recs = h.take(engine);
  assert.deepEqual(recs.map(r => [r.stage, r.op]), [[1, 'create'], [1, 'message'], [1, 'connect_param']]);
  assert.equal(signalAt(recs[1]), 2 * 48000, 'only the latest message, its at as a frame');

  sig.connect(b);            // same stage: the same replica
  assert.deepEqual(h.take(engine).map(r => r.op), ['connect']);

  sig.connect(c);            // a stage of its own: a new replica, no port
  recs = h.take(engine);
  assert.deepEqual(recs.map(r => [r.stage, r.op]), [[2, 'create'], [2, 'message'], [2, 'connect']]);
  assert.equal(recs[0].node, sig._id, 'every replica answers to the one id');

  sig.port.postMessage({ at: 3, p: 0, r0: 9, r1: 9, dur: 0, wave: 0, duty: 0.5, on: false });
  assert.deepEqual(h.take(engine).map(r => [r.stage, r.op]), [[1, 'message'], [2, 'message']]);

  sig.disconnect(c);         // only the clouds replica had that edge
  assert.deepEqual(h.take(engine).map(r => [r.stage, r.op]), [[2, 'disconnect_all']]);
  sig.disconnect();
  assert.deepEqual(h.take(engine).map(r => [r.stage, r.op]), [[1, 'disconnect_all']]);
});

test('a replica made late is told its channel rules too', () => {
  const { engine, ctx } = h.rig({ stages: 2, homes: { music: 1 } });
  const sig = ctx.createProcessor('strobe-signal');
  sig.channelCount = 1;
  sig.channelCountMode = 'explicit';
  const g = ctx.island('music').createGain();
  h.take(engine);
  sig.connect(g);
  assert.deepEqual(h.take(engine).map(r => r.op), ['create', 'channels', 'connect']);
});

test('strobe-signal messages carry the formula as the worklet read it', () => {
  const { engine, ctx } = h.rig({ F: 1000 });
  const sig = ctx.createProcessor('strobe-signal'), g = ctx.createGain();
  sig.connect(g);
  h.take(engine);
  sig.port.postMessage({ at: -0.5, p: 0.1, r0: 7, r1: 8, dur: 2, wave: 3.7, duty: 0.4, on: 1 });
  const [rec] = h.take(engine);
  const v = new DataView(rec.bytes.buffer);
  assert.equal(rec.bytes.length, 4 + 8 * 8);
  assert.equal(v.getUint32(0, true), 1);
  const f = i => v.getFloat64(4 + 8 * i, true);
  assert.equal(f(0), -0.5 * 48000 - 1000, 'an anchor in the past stays in the past');
  assert.deepEqual([f(1), f(2), f(3), f(4), f(5), f(6), f(7)], [0.1, 7, 8, 2, 3, 0.4, 1]);
});

test('on more than one stage, a message is folded forward past every stage\'s horizon', () => {
  // Rendered up to 2 s; the message is anchored at 1 s, its rate ramping
  // from 7.5 to 8.5 Hz over 2 s. One second on, it has done 7.75 cycles
  // (7.5 + 1 / 4), so its phase there is 0.25 + 7.75 = 8, 0 mod 1, its rate
  // 8 Hz, and one second of the ramp is left.
  const { engine, ctx } = h.rig({ stages: 3, homes: { music: 1, clouds: 2 }, horizon: 96000 - 0.5 });
  const sig = ctx.createProcessor('strobe-signal');
  sig.connect(ctx.island('music').createGain());
  sig.connect(ctx.island('clouds').createGain());
  h.take(engine);
  sig.port.postMessage({ at: 1, p: 0.25, r0: 7.5, r1: 8.5, dur: 2, wave: 2, duty: 0.5, on: true });
  const recs = h.take(engine);
  assert.deepEqual(recs.map(r => r.stage), [1, 2]);
  assert.deepEqual(recs[0].bytes, recs[1].bytes, 'every replica hears the same numbers');
  const v = new DataView(recs[0].bytes.buffer), f = i => v.getFloat64(4 + 8 * i, true);
  assert.deepEqual([f(0), f(1), f(2), f(3), f(4)], [96000, 0, 8, 8.5, 1]);
  // An anchor already beyond the horizon is left as it is.
  sig.port.postMessage({ at: 3, p: 0.5, r0: 9, r1: 9, dur: 0, wave: 2, duty: 0.5, on: true });
  const [later] = h.take(engine);
  assert.equal(new DataView(later.bytes.buffer).getFloat64(4, true), 3 * 48000);
});

test('the fold is the same law: the phase agrees at every later moment', () => {
  const law = (p, r0, r1, dur, tau) => {
    const c = tau <= 0 || !(dur > 0) ? r0 * tau
      : tau < dur ? r0 * tau + (r1 - r0) * tau * tau / (2 * dur)
      : (r0 + r1) * 0.5 * dur + r1 * (tau - dur);
    const x = p + c;
    return x - Math.floor(x);
  };
  for (const [p, r0, r1, dur, delta] of [[0.3, 7, 12, 1.5, 0.4], [0.3, 7, 12, 1.5, 2], [0.9, 40, 40, 0, 0.123]]) {
    const [p2, r02, r12, dur2] = h.foldSignal(p, r0, r1, dur, delta);
    for (const tau of [0, 0.01, 0.5, 1.2, 3]) {
      const d = Math.abs(law(p, r0, r1, dur, delta + tau) - law(p2, r02, r12, dur2, tau));
      assert.ok(Math.min(d, 1 - d) < 1e-9, `fold by ${delta} s, ${tau} s on: ${d}`);
    }
  }
});
