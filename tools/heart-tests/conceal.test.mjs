// Underrun concealment (js/heart/conceal.js) in the drain: a dry quantum
// plays the history ping-pong instead of silence, continuous going in and
// at the turnaround, fades out under the audio when it comes back, decays
// to silence on a long stall, never moves the clock, and allocates nothing.
//
//   node tools/heart-tests/conceal.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Drain } from '../../js/heart/drain-worklet.js';
import { Conceal } from '../../js/heart/conceal.js';
import { SharedRing, makeControl, CHUNK, QUANTUM, PLAYED } from '../../js/heart/ring.js';

const sine = f => Math.sin(f * 0.01);

function writeChunk(ring, start) {
  const src = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) src[i] = sine(start + i);
  ring.write(0, src, 0, CHUNK);
  for (let i = 0; i < CHUNK; i++) src[i] = -sine(start + i);
  ring.write(1, src, 0, CHUNK);
  ring.commit(CHUNK);
}

test('conceal: a ping-pong of the history, continuous going in and at each turn', () => {
  const c = new Conceal({ size: 512, xfade: 0, hold: 1e9 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let f = 0;
  for (let q = 0; q < 4; q++) {
    for (let i = 0; i < QUANTUM; i++, f++) { L[i] = f; R[i] = -f; }
    c.wet(L, R);
  }
  // History holds frames 0..511; the last played is 511.
  const got = [];
  for (let q = 0; q < 10; q++) { c.dry(L, R); for (let i = 0; i < QUANTUM; i++) { got.push(L[i]); assert.equal(R[i], -L[i]); } }
  assert.deepEqual(got.slice(0, 3), [510, 509, 508]);
  for (let i = 1; i < got.length; i++) assert.equal(Math.abs(got[i] - got[i - 1]), 1, `step ${i}`);
  assert.ok(got.includes(0) && got.filter(v => v === 511).length > 0, 'turns at both ends');
});

test('conceal: a crossfaded turn blends the pass going back into the pass coming forward', () => {
  const c = new Conceal({ size: 512, xfade: 64, hold: 1e9 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let f = 0;
  for (let q = 0; q < 4; q++) {
    for (let i = 0; i < QUANTUM; i++, f++) { L[i] = f; R[i] = -f; }
    c.wet(L, R);
  }
  const got = [];
  for (let q = 0; q < 12; q++) { c.dry(L, R); got.push(...L); }
  // Going in, as without a crossfade: the mirror of what was just played.
  assert.deepEqual(got.slice(0, 3), [510, 509, 508]);
  // The two heads cross halfway: the oldest 64 frames are met at their
  // middle (frame 32), each head at the normal rate. Blending two ramps
  // going opposite ways steepens the sum a little, never to a jump.
  assert.ok(Math.abs(Math.min(...got) - 32) < 0.01, `crossed at ${Math.min(...got)}`);
  for (let i = 1; i < got.length; i++) assert.ok(Math.abs(got[i] - got[i - 1]) < 1.5, `step ${i}`);
  // And it does come back up: the pass coming forward.
  const low = got.indexOf(Math.min(...got));
  assert.ok(got[low + 100] > got[low] + 50);
});

test('conceal: Crossfade 0 is a hard turn, and a new length applies from the next stall', () => {
  const c = new Conceal({ size: 512, xfade: 64 });
  c.setXfade(0);
  assert.equal(c.xfade, 0);
  c.setXfade(1e6);
  assert.equal(c.xfade, 128, 'no more than a quarter of the history');
});

test('conceal: fades out under the returning audio, then records again', () => {
  const c = new Conceal({ size: 512, hold: 1e9 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  for (let q = 0; q < 4; q++) { L.fill(0.5); R.fill(0.5); c.wet(L, R); }
  c.dry(L, R);
  assert.ok(L.every(v => v === 0.5));
  L.fill(1); R.fill(1);
  c.wet(L, R);
  // Equal power: a·1 + b·0.5, from mostly concealment to all audio.
  assert.ok(Math.abs(L[0] - 0.5) < 0.02);
  assert.ok(Math.abs(L[QUANTUM - 1] - 1) < 0.02);
  assert.equal(c.active, false);
  L.fill(0.25); R.fill(0.25);
  c.wet(L, R);
  assert.ok(L.every(v => v === 0.25), 'audio passes untouched once faded');
});

test('conceal: a long stall decays to silence, and the audio fades back in', () => {
  const c = new Conceal({ size: 256, hold: 256, decay: 256 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  for (let q = 0; q < 2; q++) { L.fill(0.5); R.fill(0.5); c.wet(L, R); }
  for (let q = 0; q < 6; q++) c.dry(L, R);
  assert.ok(L.every(v => v === 0), 'silent after hold + decay');
  L.fill(1); R.fill(1);
  c.wet(L, R);
  assert.ok(L[0] < 0.05 && Math.abs(L[QUANTUM - 1] - 1) < 0.02, 'fades in from silence');
});

test('conceal: nothing to turn over at the very start is silence', () => {
  const c = new Conceal({ size: 256 });
  const L = new Float32Array(QUANTUM).fill(9), R = new Float32Array(QUANTUM).fill(9);
  c.dry(L, R);
  assert.ok(L.every(v => v === 0) && R.every(v => v === 0));
});

test('drain with concealment: no silent quantum through a stall, the clock and the late frames as before', () => {
  const ring = new SharedRing(SharedRing.describe(2, 4096));
  const ctl = makeControl(1);
  const drain = new Drain({ control: ctl, stages: 1, post: () => {}, conceal: 24000 });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let written = 0;
  for (let k = 0; k < 4; k++) { writeChunk(ring, written); written += CHUNK; }
  const perChunk = CHUNK / QUANTUM;
  let prev = null, maxJump = 0, quanta = 0;
  // Keep pace, then stall for 20 quanta, then catch up.
  for (let q = 0; q < 200; q++) {
    const stalled = q >= 60 && q < 80;
    if (!stalled && q % perChunk === 0) {
      while (written < (drain.played + 1) * QUANTUM + 4 * CHUNK && ring.writable() >= CHUNK) { writeChunk(ring, written); written += CHUNK; }
    }
    drain.play(L, R, 0);
    quanta++;
    if (q > 4) assert.ok(L.some(v => v !== 0), `quantum ${q} is not silent`);
    for (let i = 0; i < QUANTUM; i++) {
      if (prev !== null) maxJump = Math.max(maxJump, Math.abs(L[i] - prev));
      prev = L[i];
    }
  }
  assert.ok(drain.underruns > 0, 'the stall underran');
  assert.equal(Atomics.load(ctl, PLAYED), quanta, 'every quantum counted');
  // The sine moves 0.01 a frame; nothing jumps by much more than a crossfade
  // between two unrelated points of it could.
  assert.ok(maxJump < 0.1, `largest step ${maxJump}`);
});

test('drain without concealment still plays silence', () => {
  const ring = new SharedRing(SharedRing.describe(2, 4096));
  const drain = new Drain({ post: () => {} });
  drain.attach(ring);
  writeChunk(ring, 0);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  for (let q = 0; q < CHUNK / QUANTUM; q++) drain.play(L, R, 0);
  drain.play(L, R, 0);
  assert.ok(L.every(v => v === 0));
});

test('simulated underrun: gaps where the pattern says, frames still on time, nothing learned', () => {
  const ring = new SharedRing(SharedRing.describe(2, 4096));
  const ctl = makeControl(1);
  const drain = new Drain({ control: ctl, stages: 1, post: () => {} });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let written = 0;
  const feed = () => { while (written < (drain.played + 1) * QUANTUM + 4 * CHUNK && ring.writable() >= CHUNK) { writeChunk(ring, written); written += CHUNK; } };
  feed();
  drain.play(L, R, 0);
  // Gap 3, sound 2, gap 1.
  drain.simulate(Int32Array.from([3, 2, 1]));
  const silent = [];
  for (let q = 0; q < 10; q++) {
    feed();
    const at = drain.played * QUANTUM;
    drain.play(L, R, 0);
    const quiet = L.every(v => v === 0);
    silent.push(quiet);
    if (!quiet) assert.ok(Math.abs(L[0] - sine(at)) < 1e-6, `quantum ${q} plays engine frame ${at}`);
  }
  assert.deepEqual(silent, [true, true, true, false, false, true, false, false, false, false]);
  assert.equal(drain.underruns, 0);
  assert.equal(Atomics.load(ctl, PLAYED), 11);
});

test('conceal: many dropouts in a row never jump, so nothing clicks', () => {
  const ring = new SharedRing(SharedRing.describe(2, 8192));
  const drain = new Drain({ post: () => {}, conceal: 24000, xfade: 480 });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let written = 0;
  const feed = () => { while (written < (drain.played + 1) * QUANTUM + 8 * CHUNK && ring.writable() >= CHUNK) { writeChunk(ring, written); written += CHUNK; } };
  feed();
  for (let q = 0; q < 200; q++) { feed(); drain.play(L, R, 0); }
  // Thirty dropouts, gaps and sound between each up to 20 quanta, at random
  // but the same random every run.
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pattern = [];
  for (let i = 0; i < 59; i++) pattern.push(1 + Math.floor(rnd() * 20));
  drain.simulate(Int32Array.from(pattern));
  let prev = L[QUANTUM - 1], maxJump = 0, at = 0;
  for (let q = 0; q < 900; q++) {
    feed();
    drain.play(L, R, 0);
    for (let i = 0; i < QUANTUM; i++) {
      const d = Math.abs(L[i] - prev);
      if (d > maxJump) { maxJump = d; at = q * QUANTUM + i; }
      prev = L[i];
    }
  }
  // The sine moves at most 0.01 a frame; two of it crossfading, a little more.
  assert.ok(maxJump < 0.05, `largest step ${maxJump.toFixed(3)} at frame ${at}`);
});
