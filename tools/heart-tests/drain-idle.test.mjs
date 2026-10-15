// Render ahead on idle, the drain's half (js/heart/drain-worklet.js §7.6):
// the idle lift rises past policy.max up to idleMax and the steady
// step-down never shrinks it; an underrun under the lift is counted but
// neither learned from nor grown on; a drop is acked; and the forward jump
// moves the clock by exactly its quanta, drops the frames jumped over,
// plays the frame after them when its moment falls due, and crossfades
// from the continuation that would have played.
//
//   node --test tools/heart-tests/drain-idle.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Drain } from '../../js/heart/drain-worklet.js';
import {
  SharedRing, CHUNK, QUANTUM, makeControl, PLAYED, UNDERRUNS, LOOKAHEAD
} from '../../js/heart/ring.js';

// Engine frame f carries f/1000 on the left and -f/1000 on the right, and
// every chunk is labelled with its start, as the stages label theirs.
const val = f => f / 1000;
function writeChunk(ring, start) {
  const src = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) src[i] = val(start + i);
  ring.write(0, src, 0, CHUNK);
  for (let i = 0; i < CHUNK; i++) src[i] = -val(start + i);
  ring.write(1, src, 0, CHUNK);
  ring.commit(CHUNK, start);
}

// Keeps the ring topped up to `aheadOf` frames past the drain's clock, like
// stages that always keep pace. Returns the new head.
function top(ring, drain, head, aheadOf) {
  while (head < drain.played * QUANTUM + aheadOf && ring.writable() >= CHUNK) {
    writeChunk(ring, head);
    head += CHUNK;
  }
  return head;
}

const BASE = 4 * CHUNK;            // 2048 frames
const MAX = 8 * CHUNK;
const IDLE_MAX = 64 * CHUNK;       // 32768 frames
const policy = () => ({ base: BASE, max: MAX, hidden: BASE, fullscreen: 0, steady: 12, grow: 1.5 });

function rig() {
  const ring = new SharedRing(SharedRing.describe(2, 128 * CHUNK));
  const ctl = makeControl(1, BASE);
  const posts = [];
  const drain = new Drain({
    control: ctl, stages: 1, post: m => posts.push(JSON.parse(JSON.stringify(m))),
    lookahead: { ...policy(), idleMax: IDLE_MAX }
  });
  drain.attach(ring);
  return { ring, ctl, posts, drain, L: new Float32Array(QUANTUM), R: new Float32Array(QUANTUM) };
}

test('the idle lift rises past policy.max and survives the steady step-down', () => {
  const { ring, ctl, drain, L, R } = rig();
  let head = top(ring, drain, 0, BASE);
  const lift = 24 * CHUNK;          // past MAX, under IDLE_MAX
  drain.setIdle(lift);
  assert.equal(drain.next, lift, 'the rise aims past policy.max');
  // Play ten steady seconds' worth of quanta with the ring kept full.
  for (let q = 0; q < 200; q++) {
    head = top(ring, drain, head, lift + CHUNK);
    drain.play(L, R, q * QUANTUM);
  }
  assert.equal(drain.target, lift, 'the steady stretch never steps below the lift');
  assert.equal(Atomics.load(ctl, LOOKAHEAD), lift);
  assert.equal(drain.underruns, 0);
});

test('an underrun under the lift is counted, not learned from, not grown on', () => {
  const { ring, drain, L, R } = rig();
  let head = top(ring, drain, 0, BASE);
  const lift = 16 * CHUNK;
  drain.setIdle(lift);
  for (let q = 0; q < 40; q++) {   // fill and play a while
    head = top(ring, drain, head, lift + CHUNK);
    drain.play(L, R, q * QUANTUM);
  }
  // The stages stop (asked to sleep too long, say): the ring runs dry.
  const before = { bad: drain.bad, learned: drain.learned, next: drain.next };
  while (ring.readable() >= QUANTUM) drain.play(L, R, 0);
  for (let q = 0; q < 8; q++) drain.play(L, R, 0);
  assert.ok(drain.underruns >= 8, 'the dry quanta are counted');
  assert.equal(drain.bad, before.bad, 'nothing is learned under the lift');
  assert.equal(drain.learned, before.learned);
  assert.equal(drain.next, before.next, 'nothing is grown under the lift');
});

test('a drop of the lift drains at once and is acked', () => {
  const { drain, ring, posts, L, R } = rig();
  let head = top(ring, drain, 0, BASE);
  drain.play(L, R, 0);
  drain.setIdle(20 * CHUNK);
  assert.equal(drain.next, 20 * CHUNK);
  // Obey the rise (RISE_DELAY quanta on), with the ring kept full.
  for (let q = 0; q < 8; q++) { head = top(ring, drain, head, 21 * CHUNK); drain.play(L, R, 0); }
  assert.equal(drain.target, 20 * CHUNK);
  posts.length = 0;
  drain.setIdle(10 * CHUNK);
  assert.equal(drain.target, 10 * CHUNK, 'down at once, by draining');
  assert.equal(posts.filter(m => m.type === 'idled').length, 1, 'the drop is acked');
  drain.setIdle(0);
  assert.equal(drain.target, BASE, 'the lift gone, the floor is the base again');
  assert.equal(posts.filter(m => m.type === 'idled').length, 2);
  assert.equal(drain.underruns, 0);
});

test('a jump moves the clock by exactly its quanta, drops the gap, crossfades, and ends the lift', () => {
  const { ring, ctl, drain, posts, L, R } = rig();
  let head = top(ring, drain, 0, BASE);
  const lift = 24 * CHUNK;
  drain.setIdle(lift);
  for (let q = 0; q < 16; q++) {
    head = top(ring, drain, head, lift + CHUNK);
    drain.play(L, R, q * QUANTUM);
  }
  // The cushion is grown: the ring holds ~lift frames past the clock. Jump
  // to a frame the base short of the head, as the page would.
  const before = drain.played;
  const target = Math.floor((head - BASE) / QUANTUM);
  const jump = target - before;
  assert.ok(jump > 50, `the cushion was worth jumping (${jump} quanta)`);
  posts.length = 0;
  drain.jump(jump);
  assert.equal(drain.played, before + jump, 'the clock moved by exactly the jump');
  assert.equal(Atomics.load(ctl, PLAYED), before + jump, 'and was published at once');
  assert.equal(drain.idle, 0, 'the lift ends with the jump');
  assert.deepEqual(posts.map(m => m.type), ['idled', 'jumped']);
  assert.equal(posts[1].quanta, jump);

  // The continuation that would have played, for checking the crossfade.
  const oldFrom = before * QUANTUM;
  const newFrom = drain.played * QUANTUM;
  const xf = 8 * QUANTUM;
  let at = 0, maxStep = 0, prev = val(oldFrom - 1);
  for (let q = 0; q < 12; q++) {
    head = top(ring, drain, head, BASE);
    drain.play(L, R, 0);
    for (let i = 0; i < QUANTUM; i++, at++) {
      const f = newFrom + at;
      if (at < xf) {
        const x = (at + 0.5) / xf * Math.PI / 2;
        const want = Math.sin(x) * val(f) + Math.cos(x) * val(oldFrom + at);
        assert.ok(Math.abs(L[i] - want) < 1e-5, `crossfade frame ${at}: ${L[i]} vs ${want}`);
      } else {
        assert.equal(L[i], Math.fround(val(f)), `frame ${at} plays the ring exactly`);
        assert.equal(R[i], Math.fround(-val(f)));
      }
      maxStep = Math.max(maxStep, Math.abs(L[i] - prev));
      prev = L[i];
    }
  }
  assert.equal(drain.underruns, 0, 'no quantum went dry through the jump');
  // The test signal is a ramp, so the jump spans a value gap of
  // val(jump * QUANTUM); the crossfade spreads it over its length, moving
  // at most about pi/2 * gap / xf a frame. Anything near the whole gap in
  // one frame would be the splice clicking.
  const gap = val(jump * QUANTUM);
  assert.ok(maxStep < gap * 2.5 / xf, `largest step ${maxStep} against the crossfade's ${(gap * Math.PI / 2 / xf).toFixed(4)}`);
});
