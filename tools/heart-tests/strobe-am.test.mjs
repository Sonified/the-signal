// js/strobe-am.js keeps one strobe-signal node per context: the native
// families tap a native AudioWorkletNode, a Heart family a Heart processor
// made on its own context, and every node hears every post of the formula.
// Run: node --test tools/heart-tests/strobe-am.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

// Just enough page for js/audio.js and its imports to load in node.
globalThis.window ??= globalThis;
globalThis.document ??= { getElementById: () => null, querySelector: () => null, addEventListener() {} };

// A native AudioWorkletNode that notes what it is made, told and wired to.
const made = [];
globalThis.AudioWorkletNode = class {
  constructor(ctx, name, opts) {
    Object.assign(this, { context: ctx, name, opts, posts: [], wires: new Set() });
    this.port = { postMessage: m => this.posts.push({ ...m }) };
    made.push(this);
  }
  connect(to) { this.wires.add(to); return to; }
  disconnect(to) { this.wires.delete(to); }
};
const nativeCtx = {
  currentTime: 1, sampleRate: 48000, state: 'running', addEventListener() {},
  createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} })
};

const h = await load();
const { S } = await import('../../js/state.js');
const { strobeTap, untapStrobe } = await import('../../js/strobe-am.js');
const { publishSignal } = await import('../../core/signal.js');
S.workletReady = true;

test('one node per context, native and Heart, and every one hears the formula', () => {
  const { engine, clock, ctx } = h.rig({ stages: 2, homes: { music: 1 } });
  clock.addEventListener = () => {};   // the native clock a Heart context forwards to
  const music = ctx.island('music');
  const nIn = nativeCtx.createGain(), nIn2 = nativeCtx.createGain(), hIn = music.createGain();
  h.take(engine);

  const a = strobeTap(nativeCtx, nIn), b = strobeTap(nativeCtx, nIn2);
  assert.equal(made.length, 1, 'one native node for the native context');
  assert.equal(made[0].name, 'strobe-signal');
  assert.equal(a.src, made[0]);
  assert.equal(b.src, made[0]);
  assert.ok(made[0].wires.has(nIn) && made[0].wires.has(nIn2));

  const c = strobeTap(music, hIn);
  assert.equal(made.length, 1, 'the Heart family is not handed a native node');
  assert.ok(c.src instanceof h.HeartProcessor, 'a Heart processor, made on the family\'s context');
  const sent = h.take(engine);
  const node = c.src._id;
  assert.ok(sent.some(r => r.op === 'create' && r.node === node && r.stage === 1), 'made in the stage it feeds');
  assert.ok(sent.some(r => r.op === 'connect' && r.node === node && r.target === hIn._id), 'wired into the stage');

  const posted = made[0].posts.length;
  publishSignal();
  assert.equal(made[0].posts.length, posted + 1, 'the native node hears the post');
  assert.ok(h.take(engine).some(r => r.op === 'message' && r.node === node), 'and so does the Heart one');

  untapStrobe(c);
  assert.ok(h.take(engine).some(r => r.node === node && r.op.startsWith('disconnect')), 'the Heart tap lets go');
  untapStrobe(a); untapStrobe(b);
  assert.ok(!made[0].wires.size, 'the native taps let go');
});
