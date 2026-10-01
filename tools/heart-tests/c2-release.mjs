// A proxy the app lets go of is destroyed on its stage and in the shadow,
// and gives back the ports its cross edges held; a started source is held
// until it ends. Needs a forced collection:
// Run: node --expose-gc --test tools/heart-tests/c2-release.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

const h = await load();
const collect = async () => {
  for (let i = 0; i < 4; i++) { globalThis.gc(); await new Promise(r => setTimeout(r, 10)); }
};
const skip = !globalThis.gc && 'run with node --expose-gc';

test('a dropped node is destroyed, and its port closes', { skip }, async () => {
  const { engine, shadow, ctx } = h.rig({ stages: 2, homes: { music: 1 } });
  const master = ctx.destination;
  let id;
  (() => {
    const bus = ctx.island('music').createGain();
    id = bus._id;
    bus.connect(master);
  })();
  h.take(engine);
  await collect();
  const recs = h.take(engine);
  assert.ok(recs.some(r => r.stage === 1 && r.op === 'destroy' && r.node === id), 'the node');
  assert.equal(recs.filter(r => r.op === 'destroy').length, 3, 'the node, its egress and the ingress');
  assert.ok(shadow.records().some(r => r.op === 'destroy' && r.node === id));
});

test('a started source lives until its ended event', { skip }, async () => {
  const { engine, ctx } = h.rig();
  let id, ended = false;
  (() => {
    const s = ctx.createOscillator();
    id = s._id;
    s.onended = () => { ended = true; };
    s.start();
  })();
  h.take(engine);
  await collect();
  assert.ok(!h.take(engine).some(r => r.op === 'destroy'), 'still playing, still held');
  engine.emit(0, h.eventBytes([{ op: 'ended', node: id }]));
  assert.ok(ended);
  await collect();
  assert.ok(h.take(engine).some(r => r.op === 'destroy' && r.node === id));
});

test('a convolver handed a new impulse frees the old one on its stage', () => {
  const { engine, ctx } = h.rig({ stages: 2, homes: { ambience: 1 } });
  const room = ctx.island('ambience').createConvolver();
  const ir = n => ({ numberOfChannels: 1, length: n, sampleRate: 48000, getChannelData: () => new Float32Array(n) });
  const a = ir(64), b = ir(32);
  room.buffer = a;
  assert.deepEqual(engine.freed, [], 'nothing to free the first time');
  room.buffer = b;
  room.buffer = b;
  assert.deepEqual(engine.freed, [{ id: h.registerBuffer(a), stages: [1] }], 'the old impulse, once, on the node\'s stage');
});
