// Cross edges (spec 7.4): an island node feeding a mix node goes out
// through an egress port and in through an ingress, one port per mix input
// per stage, counted, recycled, and refused where the spec refuses it.
// Run: node --test tools/heart-tests/c2-cross.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

const h = await load();
const KIND = { egress: 14, ingress: 15 };
// stage 0 the mix; music and drone share stage 1; clouds on stage 2
const setup = () => {
  const r = h.rig({ stages: 3, homes: { music: 1, drone: 1, clouds: 2 } });
  return { ...r, music: r.ctx.island('music'), drone: r.ctx.island('drone'), clouds: r.ctx.island('clouds') };
};

test('an island node into the master opens a port: egress in the island, ingress in the mix', () => {
  const { engine, ctx, music } = setup();
  const master = ctx.destination, dry = music.createGain();
  h.take(engine);
  assert.equal(dry.connect(master), master);
  const recs = h.take(engine);
  const egress = recs.find(r => r.op === 'create' && r.kind === KIND.egress);
  const ingress = recs.find(r => r.op === 'create' && r.kind === KIND.ingress);
  assert.equal(egress.stage, 1);
  assert.equal(egress.opts[0], 0);                 // port 0
  assert.equal(ingress.stage, 0);
  assert.deepEqual(ingress.opts.slice(0, 2), [0, 1]); // port 0 of stage 1
  assert.ok(recs.some(r => r.stage === 0 && r.op === 'connect' && r.node === ingress.node && r.target === master._id));
  assert.ok(recs.some(r => r.stage === 1 && r.op === 'connect' && r.node === dry._id && r.target === egress.node && r.input === 0));
});

test('edges from one stage into one mix input share a port; another stage gets its own', () => {
  const { engine, ctx, music, drone, clouds } = setup();
  const master = ctx.destination;
  const a = music.createGain(), b = music.createGain(), c = drone.createGain(), d = clouds.createGain();
  a.connect(master);
  h.take(engine);
  b.connect(master); c.connect(master);   // drone lives on stage 1 too
  const shared = h.take(engine);
  assert.ok(!shared.some(r => r.op === 'create'), 'no new port for the same stage and input');
  assert.equal(shared.length, 2);
  assert.ok(shared.every(r => r.op === 'connect' && r.stage === 1));
  d.connect(master);
  const egress = h.take(engine).find(r => r.op === 'create' && r.kind === KIND.egress);
  assert.equal(egress.stage, 2);
  assert.equal(egress.opts[0], 0);   // stage 2 has its own sixteen
});

test('the port closes with its last edge, exactly, and is reused', () => {
  const { engine, ctx, music } = setup();
  const master = ctx.destination, a = music.createGain(), b = music.createGain();
  const bus = ctx.createGain();   // a second mix input: a second port
  h.take(engine);
  a.connect(master); b.connect(master); a.connect(bus);
  const made = h.take(engine).filter(r => r.op === 'create');
  const [e0, i0, e1, i1] = made.map(r => r.node);
  assert.deepEqual(made.map(r => r.opts[0]), [0, 0, 1, 1]);

  a.disconnect(master);   // a still feeds bus through port 1
  assert.deepEqual(h.take(engine), [
    { stage: 1, op: 'disconnect_node', node: a._id, target: e0 }
  ]);
  b.disconnect();         // the last edge on port 0
  assert.deepEqual(h.take(engine), [
    { stage: 1, op: 'disconnect_all', node: b._id },
    { stage: 1, op: 'destroy', node: e0 },
    { stage: 0, op: 'disconnect_all', node: i0 },
    { stage: 0, op: 'destroy', node: i0 }
  ]);
  b.connect(master);      // port 0 is free again
  const again = h.take(engine).find(r => r.op === 'create' && r.kind === KIND.egress);
  assert.equal(again.opts[0], 0);
  assert.ok(again.node !== e0, 'ids are never reused');
  a.disconnect(bus);
  const closed = h.take(engine);
  assert.ok(closed.some(r => r.op === 'destroy' && r.node === e1));
  assert.ok(closed.some(r => r.op === 'destroy' && r.node === i1));
});

test('two outputs of one node into one port: disconnecting one keeps the other', () => {
  const { engine, ctx } = setup();
  const genus = ctx.island('genus');   // placed by the fake on stage 1
  const g = genus.createProcessor('genus'), master = ctx.destination;
  g.connect(master, 0); g.connect(master, 1);
  const egress = h.take(engine).find(r => r.kind === KIND.egress).node;
  g.disconnect(master, 0);
  assert.deepEqual(h.take(engine), [
    { stage: 1, op: 'disconnect_node', node: g._id, target: egress },
    { stage: 1, op: 'connect', node: g._id, output: 1, target: egress, input: 0 }
  ]);
});

test('islands on one stage connect directly', () => {
  const { engine, music, drone } = setup();
  const a = music.createGain(), b = drone.createGain();
  h.take(engine);
  a.connect(b);
  assert.deepEqual(h.take(engine), [{ stage: 1, op: 'connect', node: a._id, output: 0, target: b._id, input: 0 }]);
});

test('edges the spec forbids throw, naming both nodes, and send nothing', () => {
  const { engine, ctx, music, clouds } = setup();
  const a = music.createGain(), c = clouds.createGain(), m = ctx.createGain();
  h.take(engine);
  assert.throws(() => a.connect(c), e => /gain#\d+ \(music\).*gain#\d+ \(clouds\)/.test(e.message));
  assert.throws(() => a.connect(m.gain), e => /param gain of gain#\d+ \(mix\)/.test(e.message));
  assert.throws(() => m.connect(a), e => /\(mix\).*\(music\)/.test(e.message));
  assert.deepEqual(h.take(engine), []);
});

test('sixteen ports per stage, and a clear error for the seventeenth', () => {
  const { ctx, music } = setup();
  const src = music.createGain();
  for (let i = 0; i < 16; i++) src.connect(ctx.createGain());
  assert.throws(() => src.connect(ctx.createGain()), /stage 1 has used all 16 of its ports/);
});

test('with one combined stage nothing ever crosses', () => {
  const { engine, ctx } = h.rig({ stages: 1 });
  const g = ctx.island('music').createGain(), master = ctx.destination;
  h.take(engine);
  g.connect(master);
  assert.deepEqual(h.take(engine).map(r => r.op), ['connect']);
});
