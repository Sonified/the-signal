// Connection bookkeeping on one stage: connect, its return values and
// checks, and every disconnect overload sending exactly what undoes it.
// Run: node --test tools/heart-tests/c2-connect.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

const h = await load();
const ops = recs => recs.map(r => r.op);

test('connect returns the target node, and nothing for a param', () => {
  const { engine, ctx } = h.rig();
  const a = ctx.createGain(), b = ctx.createGain(), c = ctx.createGain();
  h.take(engine);
  assert.equal(a.connect(b), b);
  assert.equal(a.connect(b).connect(c), c);   // chains, as room.output.connect(wet).connect(master)
  assert.equal(a.connect(c.gain), undefined);
  const recs = h.take(engine);
  assert.deepEqual(ops(recs), ['connect', 'connect', 'connect_param']);
  assert.deepEqual(recs[2], { stage: 0, op: 'connect_param', node: a._id, output: 0, target: c._id, param: 0 });
});

test('creating a node sends create to its stage and to the shadow, with its options', () => {
  const { engine, shadow, ctx } = h.rig();
  const d = ctx.createDelay(0.5);
  const [rec] = h.take(engine);
  assert.equal(rec.op, 'create');
  assert.equal(rec.node, d._id);
  assert.equal(rec.kind, 4);
  assert.equal(rec.opts[0], 0.5);
  assert.ok(shadow.records().some(r => r.op === 'create' && r.node === d._id));
});

test('the same connection twice is one connection', () => {
  const { engine, ctx } = h.rig();
  const a = ctx.createGain(), b = ctx.createGain();
  h.take(engine);
  a.connect(b); a.connect(b); a.connect(b.gain); a.connect(b.gain);
  assert.deepEqual(ops(h.take(engine)), ['connect', 'connect_param']);
});

test('disconnect() takes everything', () => {
  const { engine, ctx } = h.rig();
  const a = ctx.createGain(), b = ctx.createGain(), c = ctx.createGain();
  a.connect(b); a.connect(c.gain);
  h.take(engine);
  a.disconnect();
  assert.deepEqual(h.take(engine), [{ stage: 0, op: 'disconnect_all', node: a._id }]);
  a.disconnect();   // nothing left: no error, nothing sent
  assert.deepEqual(h.take(engine), []);
});

test('disconnect(node) leaves the other edges alone', () => {
  const { engine, ctx } = h.rig();
  const a = ctx.createGain(), b = ctx.createGain(), c = ctx.createGain();
  a.connect(b); a.connect(c);
  h.take(engine);
  a.disconnect(b);
  assert.deepEqual(h.take(engine), [{ stage: 0, op: 'disconnect_node', node: a._id, target: b._id }]);
  assert.throws(() => a.disconnect(b), { name: 'InvalidAccessError' });
});

test('disconnect(node, output) and (node, output, input) put back the edges they must keep', () => {
  const { engine, ctx } = h.rig();
  const genus = ctx.createProcessor('genus'), g = ctx.createGain(), other = ctx.createGain();
  genus.connect(g, 0); genus.connect(g, 1); genus.connect(other, 2);
  h.take(engine);
  genus.disconnect(g, 0);
  assert.deepEqual(h.take(engine), [
    { stage: 0, op: 'disconnect_node', node: genus._id, target: g._id },
    { stage: 0, op: 'connect', node: genus._id, output: 1, target: g._id, input: 0 }
  ]);
  genus.disconnect(g, 1, 0);
  assert.deepEqual(ops(h.take(engine)), ['disconnect_node']);
  assert.throws(() => genus.disconnect(g, 1), { name: 'InvalidAccessError' });
  assert.throws(() => genus.disconnect(g, 3), { name: 'IndexSizeError' });
  assert.throws(() => genus.disconnect(other, 2, 1), { name: 'IndexSizeError' });
});

test('disconnect(param) and (param, output)', () => {
  const { engine, ctx } = h.rig();
  const genus = ctx.createProcessor('genus'), g = ctx.createGain(), k = ctx.createGain();
  genus.connect(g.gain, 0); genus.connect(g.gain, 1); genus.connect(k);
  h.take(engine);
  genus.disconnect(g.gain, 1);
  assert.deepEqual(h.take(engine), [
    { stage: 0, op: 'disconnect_param', node: genus._id, target: g._id, param: 0 },
    { stage: 0, op: 'connect_param', node: genus._id, output: 0, target: g._id, param: 0 }
  ]);
  genus.disconnect(g.gain);
  assert.deepEqual(ops(h.take(engine)), ['disconnect_param']);
  assert.throws(() => genus.disconnect(g.gain), { name: 'InvalidAccessError' });
});

test('disconnect(output) is the wire\'s own disconnect_output', () => {
  const { engine, ctx } = h.rig();
  const genus = ctx.createProcessor('genus'), a = ctx.createGain(), b = ctx.createGain();
  genus.connect(a, 0); genus.connect(b, 0); genus.connect(b, 1);
  h.take(engine);
  genus.disconnect(0);
  assert.deepEqual(h.take(engine), [{ stage: 0, op: 'disconnect_output', node: genus._id, output: 0 }]);
  genus.disconnect(1);   // the last edge: all of them
  assert.deepEqual(ops(h.take(engine)), ['disconnect_all']);
  assert.throws(() => genus.disconnect(3), { name: 'IndexSizeError' });
});

test('connect checks outputs, inputs and what it is handed', () => {
  const { ctx } = h.rig();
  const a = ctx.createGain(), osc = ctx.createOscillator();
  assert.throws(() => a.connect(a, 1), { name: 'IndexSizeError' });
  assert.throws(() => a.connect(a, 0, 1), { name: 'IndexSizeError' });
  assert.throws(() => a.connect(osc), { name: 'IndexSizeError' });   // a source has no input
  assert.throws(() => a.connect({ connect() {} }), { name: 'InvalidAccessError' });
  const other = h.rig().ctx.createGain();
  assert.throws(() => a.connect(other), { name: 'InvalidAccessError' });
});

test('numberOfInputs and numberOfOutputs follow the kind', () => {
  const { ctx } = h.rig();
  const io = n => [n.numberOfInputs, n.numberOfOutputs];
  assert.deepEqual(io(ctx.createGain()), [1, 1]);
  assert.deepEqual(io(ctx.createBufferSource()), [0, 1]);
  assert.deepEqual(io(ctx.createProcessor('genus')), [0, 3]);
  assert.deepEqual(io(ctx.createProcessor('strobe-signal')), [0, 1]);
  assert.deepEqual(io(ctx.destination), [1, 0]);
  assert.throws(() => ctx.createProcessor('nope'), { name: 'InvalidStateError' });
});

test('channel setters send the channels command and keep the spec\'s rules', () => {
  const { engine, ctx } = h.rig();
  const g = ctx.createGain(), pan = ctx.createStereoPanner();
  h.take(engine);
  g.channelCount = 1;
  g.channelCountMode = 'explicit';
  g.channelInterpretation = 'discrete';
  g.channelCountMode = 'nonsense';   // ignored, as WebIDL ignores a bad enum
  const recs = h.take(engine);
  assert.deepEqual(recs.at(-1), { stage: 0, op: 'channels', node: g._id, count: 1, mode: 2, interpretation: 1 });
  assert.equal(recs.length, 3);
  assert.equal(g.channelCountMode, 'explicit');
  assert.throws(() => { g.channelCount = 3; }, { name: 'NotSupportedError' });
  assert.throws(() => { pan.channelCountMode = 'max'; }, { name: 'NotSupportedError' });
  assert.equal(pan.channelCountMode, 'clamped-max');
  assert.equal(ctx.destination.channelCountMode, 'explicit');
});

test('nodes made by every island context share one id counter and one master', () => {
  const { ctx } = h.rig({ stages: 3, homes: { music: 1, clouds: 2 } });
  const music = ctx.island('music'), clouds = ctx.island('clouds');
  assert.equal(ctx.island('music'), music);
  assert.equal(music.mix, ctx);
  assert.equal(music.destination, clouds.destination);
  const ids = [music.createGain()._id, clouds.createGain()._id, ctx.createGain()._id];
  assert.equal(new Set(ids).size, 3);
  assert.equal(music.isHeart, true);
});
