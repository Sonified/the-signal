// Render ahead on idle, the drain's half (js/heart/drain-worklet.js §7.6):
// the idle lift rises past policy.max up to idleMax and the steady
// step-down never shrinks it; an underrun under the lift is counted but
// neither learned from nor grown on; a drop is acked; and the forward jump
// moves the clock by exactly its quanta, drops the frames jumped over,
// plays the frame after them when its moment falls due, and crossfades
// from the continuation that would have played: equal power over FADE_S,
// or the jump's own length when that is shorter; a second jump restarts the
// fade, and an underrun or a rest drops it.
//
//   node --test tools/heart-tests/drain-idle.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Drain, FADE_S } from '../../js/heart/drain-worklet.js';
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
const SR = 48000;
const FADE = Math.round(FADE_S * SR);   // 24000 frames

function rig(idleMax = IDLE_MAX) {
  const ring = new SharedRing(SharedRing.describe(2, 128 * CHUNK));
  const ctl = makeControl(1, BASE);
  const posts = [];
  const drain = new Drain({
    control: ctl, stages: 1, post: m => posts.push(JSON.parse(JSON.stringify(m))), rate: SR,
    lookahead: { ...policy(), idleMax }
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

test('a jump moves the clock by exactly its quanta, drops the gap, crossfades over its own length when that is under the fade, and ends the lift', () => {
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
  assert.ok(jump * QUANTUM < FADE, 'a jump shorter than the fade');
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
  // Never past the jump: the old continuation stops short of the frames
  // that play as the new stream.
  const xf = jump * QUANTUM;
  assert.equal(drain.xfLen, xf, 'the fade is the jump\'s own length');
  let at = 0, maxStep = 0, prev = val(oldFrom - 1);
  for (let q = 0; q < jump + 12; q++) {
    head = top(ring, drain, head, BASE);
    drain.play(L, R, 0);
    for (let i = 0; i < QUANTUM; i++, at++) {
      const f = newFrom + at;
      if (at < xf) {
        const x = (at + 0.5) / xf * Math.PI / 2;
        assert.ok(oldFrom + at < newFrom, 'the old continuation never reaches the new frames');
        const want = Math.sin(x) * val(f) + Math.cos(x) * val(oldFrom + at);
        assert.ok(Math.abs(L[i] - want) < 1e-4, `crossfade frame ${at}: ${L[i]} vs ${want}`);
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
  // at most about pi/2 * gap / xf a frame, on top of the ramp's own slope
  // under gains summing to at most sqrt 2. Anything near the whole gap in
  // one frame would be the splice clicking.
  const gap = val(jump * QUANTUM);
  const bound = 1.1 * (gap * Math.PI / 2 / xf + Math.SQRT2 * val(1));
  assert.ok(maxStep < bound, `largest step ${maxStep} against the crossfade's ${bound.toFixed(4)}`);
});

// A second signal for the fade's envelope: the left is the ramp, the right
// a constant 1, so each frame gives two equations, R = a + b and
// L = a new + b old, and the two gains (a for the new stream, b for the old)
// can be read straight back out of the output.
function writeEnvChunk(ring, start) {
  const src = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) src[i] = val(start + i);
  ring.write(0, src, 0, CHUNK);
  src.fill(1);
  ring.write(1, src, 0, CHUNK);
  ring.commit(CHUNK, start);
}
function topEnv(ring, drain, head, aheadOf) {
  while (head < drain.played * QUANTUM + aheadOf && ring.writable() >= CHUNK) {
    writeEnvChunk(ring, head);
    head += CHUNK;
  }
  return head;
}

// A lifted cushion of `lift` frames, played a while: returns the rig and
// the head.
function grown(lift) {
  const r = rig(lift);
  let head = topEnv(r.ring, r.drain, 0, BASE);
  r.drain.setIdle(lift);
  for (let q = 0; q < 16; q++) {
    head = topEnv(r.ring, r.drain, head, lift + CHUNK);
    r.drain.play(r.L, r.R, q * QUANTUM);
  }
  return { ...r, head };
}

test('a jump of seconds blends over FADE_S, equal power, then plays the ring exactly', () => {
  const lift = 120 * CHUNK;         // 61440 frames, 1.28 s
  let { ring, drain, L, R, head } = grown(lift);
  const before = drain.played;
  const jump = Math.floor((head - BASE) / QUANTUM) - before;
  assert.ok(jump * QUANTUM > 2 * FADE, `the jump is well past the fade (${(jump * QUANTUM / SR).toFixed(2)} s)`);
  drain.jump(jump);
  assert.equal(drain.played, before + jump, 'the fade moves no clock');
  assert.equal(drain.xfLen, FADE, 'the fade is FADE_S long');
  const oldFrom = before * QUANTUM, newFrom = drain.played * QUANTUM;
  const quanta = Math.ceil(FADE / QUANTUM) + 8;
  const points = [0, Math.floor(FADE / 4), FADE / 2, Math.floor(3 * FADE / 4), FADE - 1];
  let at = 0, checked = 0;
  for (let q = 0; q < quanta; q++) {
    head = topEnv(ring, drain, head, BASE);
    drain.play(L, R, 0);
    for (let i = 0; i < QUANTUM; i++, at++) {
      const nv = val(newFrom + at), ov = val(oldFrom + at);
      if (at < FADE) {
        const x = (at + 0.5) / FADE * Math.PI / 2;
        const want = Math.sin(x) * nv + Math.cos(x) * ov;
        assert.ok(Math.abs(L[i] - want) < 1e-4, `fade frame ${at}: ${L[i]} vs ${want}`);
        if (points.includes(at)) {
          // The gains, read back: a + b = R, a nv + b ov = L.
          const a = (L[i] - R[i] * ov) / (nv - ov), b = R[i] - a;
          assert.ok(Math.abs(a - Math.sin(x)) < 1e-3, `new gain at ${at}: ${a} vs ${Math.sin(x)}`);
          assert.ok(Math.abs(b - Math.cos(x)) < 1e-3, `old gain at ${at}: ${b} vs ${Math.cos(x)}`);
          assert.ok(Math.abs(a * a + b * b - 1) < 2e-3, `equal power at ${at}: ${a * a + b * b}`);
          checked++;
        }
      } else {
        assert.equal(L[i], Math.fround(nv), `frame ${at} plays the ring exactly`);
        assert.equal(R[i], 1);
      }
    }
  }
  assert.equal(checked, points.length);
  assert.equal(drain.underruns, 0);
});

test('a second jump mid-fade restarts the fade from the raw old continuation', () => {
  const lift = 120 * CHUNK;
  let { ring, drain, L, R, head } = grown(lift);
  const first = Math.floor((head - 2 * BASE) / QUANTUM) - drain.played;
  drain.jump(first);
  // A third of the way into the first fade.
  const mid = Math.floor(FADE / 3 / QUANTUM);
  for (let q = 0; q < mid; q++) { head = topEnv(ring, drain, head, BASE * 3); drain.play(L, R, 0); }
  assert.ok(drain.xfAt > 0 && drain.xfAt < drain.xfLen, 'mid-fade');
  // Let the stages run on far enough to jump again past the fade.
  drain.setIdle(lift);
  head = topEnv(ring, drain, head, lift);
  const before = drain.played;
  const second = Math.floor((head - BASE) / QUANTUM) - before;
  assert.ok(second * QUANTUM > FADE, 'the second jump is longer than the fade');
  drain.jump(second);
  assert.equal(drain.xfAt, 0, 'the fade starts over');
  assert.equal(drain.xfLen, FADE);
  head = topEnv(ring, drain, head, BASE);
  drain.play(L, R, 0);
  const oldFrom = before * QUANTUM, newFrom = drain.played * QUANTUM - QUANTUM;
  for (let i = 0; i < QUANTUM; i++) {
    const x = (i + 0.5) / FADE * Math.PI / 2;
    // The old stream is the ring as it stood, not the first fade's blend.
    const want = Math.sin(x) * val(newFrom + i) + Math.cos(x) * val(oldFrom + i);
    assert.ok(Math.abs(L[i] - want) < 1e-4, `frame ${i}: ${L[i]} vs ${want}`);
    assert.ok(Math.abs(R[i] - (Math.sin(x) + Math.cos(x))) < 1e-5, 'one fade, two gains');
  }
});

test('an underrun mid-fade drops the fade: the ring plays exactly once it is back', () => {
  const lift = 120 * CHUNK;
  let { ring, drain, L, R, head } = grown(lift);
  const jump = Math.floor((head - BASE) / QUANTUM) - drain.played;
  drain.jump(jump);
  for (let q = 0; q < 8; q++) { head = topEnv(ring, drain, head, BASE); drain.play(L, R, 0); }
  assert.ok(drain.xfAt > 0 && drain.xfAt < drain.xfLen, 'mid-fade');
  // The stages stall: the ring runs dry.
  while (ring.readable() >= QUANTUM) drain.play(L, R, 0);
  drain.play(L, R, 0);
  assert.ok(drain.underruns > 0, 'it went dry');
  assert.equal(drain.xfLen, 0, 'the fade is dropped');
  // Back: the late frames are dropped by the debt, and what plays is the
  // ring, unblended.
  head = Math.max(head, drain.played * QUANTUM);
  head -= head % CHUNK;
  head = topEnv(ring, drain, head, BASE);
  for (let q = 0; q < 24; q++) { head = topEnv(ring, drain, head, BASE); drain.play(L, R, 0); }
  const f = (drain.played - 1) * QUANTUM;
  for (let i = 0; i < QUANTUM; i++) {
    assert.equal(L[i], Math.fround(val(f + i)));
    assert.equal(R[i], 1);
  }
});

test('a rest mid-fade drops the fade', () => {
  const lift = 120 * CHUNK;
  let { ring, drain, L, R, head } = grown(lift);
  const jump = Math.floor((head - BASE) / QUANTUM) - drain.played;
  drain.jump(jump);
  for (let q = 0; q < 4; q++) { head = topEnv(ring, drain, head, BASE); drain.play(L, R, 0); }
  assert.ok(drain.xfAt > 0 && drain.xfAt < drain.xfLen, 'mid-fade');
  drain.setResting(true);
  assert.equal(drain.xfLen, 0, 'resting drops it');
  drain.play(L, R, 0);
  drain.setResting(false);
  assert.equal(drain.xfLen, 0, 'and waking does not bring it back');
});
