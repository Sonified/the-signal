// The drain (js/heart/drain-worklet.js, its Drain class) and the time map
// (js/heart/engine.js, timeMap): F, underruns that never shift the mapping,
// late frames dropped, the wake-ups it rings, and the clock it hands back.
//
//   node tools/heart-tests/drain.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Drain } from '../../js/heart/drain-worklet.js';
import { timeMap } from '../../js/heart/engine.js';
import {
  SharedRing, MessageRing, openRing, CHUNK, QUANTUM,
  makeControl, PLAYED, UNDERRUNS, bellOf, wakeOf
} from '../../js/heart/ring.js';

// Engine frame f carries the value f on the left and -f on the right.
function writeChunk(ring, start) {
  const src = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) src[i] = start + i;
  ring.write(0, src, 0, CHUNK);
  for (let i = 0; i < CHUNK; i++) src[i] = -(start + i);
  ring.write(1, src, 0, CHUNK);
  ring.commit(CHUNK);
}

// Port messages land on a later turn of the event loop, not a fixed time.
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 0));
  }
}

test('drain: F at the first quantum with audio, and engine frame n plays at F + n through underruns', () => {
  const ring = new SharedRing(SharedRing.describe(2, 4096));
  const ctl = makeControl(2);
  const posts = [];
  const drain = new Drain({ control: ctl, stages: 2, post: m => posts.push({ ...m }) });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let native = 640 * QUANTUM;

  // Nothing yet: silence, and the clock has not started.
  drain.play(L, R, native); native += QUANTUM;
  assert.ok(L.every(v => v === 0));
  assert.equal(posts.length, 0);
  assert.equal(Atomics.load(ctl, PLAYED), 0);

  // A writer that keeps pace (a chunk every four quanta) but stalls now and
  // then for longer than the ring holds, and then catches up as fast as the
  // ring allows, so frames arrive late. The drain plays a quantum per step
  // regardless.
  let written = 0, played = 0, silent = 0;
  const F = native;
  writeChunk(ring, 0); written = CHUNK;
  for (let step = 0; step < 4000; step++) {
    const stalled = step % 500 >= 200 && step % 500 < 260;
    const catchingUp = step % 500 >= 260 && step % 500 < 300;
    if (!stalled && (catchingUp || step % 4 === 0)) {
      while (ring.writable() >= CHUNK) { writeChunk(ring, written); written += CHUNK; if (!catchingUp) break; }
    }
    drain.play(L, R, native);
    native += QUANTUM;
    const frame = played * QUANTUM;   // the engine frame this quantum must carry, or silence
    if (L[0] === 0 && R[0] === 0 && frame !== 0) {
      silent++;
      assert.ok(L.every(v => v === 0) && R.every(v => v === 0));
    } else {
      for (let i = 0; i < QUANTUM; i++) {
        if (L[i] !== frame + i || R[i] !== -(frame + i)) assert.fail(`quantum ${played}: frame ${frame + i} played as ${L[i]}`);
      }
    }
    played++;
  }
  assert.deepEqual(posts[0], { type: 'start', F });
  assert.equal(posts.length, 1, 'shared mode posts nothing but F');
  assert.equal(Atomics.load(ctl, PLAYED), played);
  assert.ok(silent > 0, 'the schedule did starve it');
  assert.equal(Atomics.load(ctl, UNDERRUNS), silent);
  assert.equal(drain.underruns, silent);
});

test('drain: rings a waiting stage when the clock reaches its count, once', () => {
  const ring = new SharedRing(SharedRing.describe(2, 4096));
  const ctl = makeControl(3);
  const drain = new Drain({ control: ctl, stages: 3, post: () => {} });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  for (let k = 0; k < 4; k++) writeChunk(ring, k * CHUNK);
  Atomics.store(ctl, wakeOf(2), 3);
  drain.play(L, R, 0);
  drain.play(L, R, 0);
  assert.equal(Atomics.load(ctl, bellOf(2)), 0);
  drain.play(L, R, 0);
  assert.equal(Atomics.load(ctl, bellOf(2)), 1);
  assert.equal(Atomics.load(ctl, wakeOf(2)), -1);
  assert.equal(Atomics.load(ctl, bellOf(1)), 0, 'a stage that asked for nothing is left asleep');
  drain.play(L, R, 0);
  assert.equal(Atomics.load(ctl, bellOf(2)), 1, 'once');
});

test('drain, message mode: chunks go back with the clock, stats every quarter second', async () => {
  const { writer, reader } = MessageRing.describe(2, 4 * CHUNK);
  const w = openRing(writer, 'writer');
  const posts = [];
  const drain = new Drain({ post: m => posts.push({ ...m }) });
  drain.attach(openRing(reader, 'reader'));
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  const r = drain.ring;
  let written = 0;
  // The writer fills whatever has come back while the reader waits.
  const fed = () => {
    while (w.writable() >= CHUNK) { writeChunk(w, written); written += CHUNK; }
    return r.readable() >= QUANTUM;
  };
  try {
    for (let q = 0; q < 400; q++) {
      await until(fed);
      drain.play(L, R, 0);
      assert.equal(L[5], q * QUANTUM + 5);
      assert.equal(R[5], -(q * QUANTUM + 5));
    }
    // The hundredth chunk was emptied by the four hundredth quantum, and
    // carried the clock as it stood after it.
    await until(() => w.clock === 400 * QUANTUM);
    assert.equal(w.made, 4, 'never more chunks than slots');
    const stats = posts.filter(p => p.type === 'stats');
    assert.equal(stats.length, 4);
    assert.deepEqual(stats[0], { type: 'stats', played: 96, underruns: 0 });
  } finally {
    drain.close();
    w.close();
  }
});

test('time map: an estimate until F, then exact, and frameAt inverts timeAt', () => {
  let now = 1.0;
  const sr = 48000, t = timeMap(sr, () => now);
  assert.equal(t.known, false);
  assert.equal(t.frameAt(1.0), 0);                 // frame 0 plays at the next quantum
  now = 1.001;
  assert.equal(t.frameAt(now + 0.5) + Math.ceil(now * sr / QUANTUM) * QUANTUM, (now + 0.5) * sr);
  t.set(48128);
  assert.equal(t.known, true);
  assert.equal(t.frameAt(48128 / sr), 0);
  assert.equal(t.timeAt(0), 48128 / sr);
  for (const f of [0, 1, 127, 4800.5, 1e9]) assert.ok(Math.abs(t.frameAt(t.timeAt(f)) - f) < 1e-6);
  now = 99;   // once F is known the clock no longer matters
  assert.equal(t.timeAt(48000), (48000 + 48128) / sr);
});
