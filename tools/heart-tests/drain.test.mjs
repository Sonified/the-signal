// The drain (js/heart/drain-worklet.js, its Drain class) and the time map
// (js/heart/engine.js, timeMap): F, underruns that never shift the mapping,
// late frames dropped, the wake-ups it rings, and the clock it hands back.
// Then the lookahead it steers (§7.3, adaptive lookahead), quantum by
// quantum: a run of underruns doubles it once, a rise is announced at once
// and obeyed a chunk later with every bell rung, a steady stretch halves it
// back to the base and no further, hiding raises it and holds it, and a
// stage that obeys it stops underrunning once it has grown past its stalls.
//
//   node tools/heart-tests/drain.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Drain } from '../../js/heart/drain-worklet.js';
import { timeMap } from '../../js/heart/engine.js';
import {
  SharedRing, MessageRing, openRing, CHUNK, QUANTUM,
  makeControl, PLAYED, UNDERRUNS, LOOKAHEAD, LOOKAHEAD_NEXT, bellOf, wakeOf
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

// ---------- the lookahead ----------
// A drain with a policy over a shared ring, and a quantum that checks the
// time map as it plays: silence, or exactly engine frames played × 128 on.
function steered(policy, stages = 3) {
  const ctl = makeControl(stages, policy.base);
  const ring = new SharedRing(SharedRing.describe(2, policy.max + CHUNK));
  const drain = new Drain({ control: ctl, stages, post: () => {}, lookahead: policy });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  const rig = { ctl, ring, drain, written: 0, silent: 0 };
  rig.play = () => {
    const frame = drain.played * QUANTUM;
    drain.play(L, R, 0);
    if (L[0] === 0 && R[0] === 0 && frame !== 0) { rig.silent++; return false; }
    for (let i = 0; i < QUANTUM; i++) {
      if (L[i] !== frame + i || R[i] !== -(frame + i)) assert.fail(`frame ${frame + i} played as ${L[i]}`);
    }
    return true;
  };
  // A stage that obeys the lookahead: renders while the next chunk ends
  // within played + LOOKAHEAD and the ring has room.
  rig.render = () => {
    const limit = () => Atomics.load(ctl, PLAYED) * QUANTUM + Atomics.load(ctl, LOOKAHEAD);
    while (ring.writable() >= CHUNK && rig.written + CHUNK <= limit()) { writeChunk(ring, rig.written); rig.written += CHUNK; }
  };
  return rig;
}

test('lookahead: a run of underruns doubles it once, announced at once and obeyed a chunk later, up to the most', () => {
  const rig = steered({ base: 2048, max: 8192, hidden: 4096, steady: 100000 });
  const { ctl, drain } = rig;
  writeChunk(rig.ring, 0); rig.written = CHUNK;
  for (let q = 0; q < 4; q++) assert.ok(rig.play(), 'the first chunk plays');
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 2048);

  // The ring is dry: silence, and the rise is announced at once.
  assert.equal(rig.play(), false);
  assert.equal(Atomics.load(ctl, LOOKAHEAD_NEXT), 4096, 'announced');
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 2048, 'not yet obeyed');
  const bells = [0, 1, 2].map(s => Atomics.load(ctl, bellOf(s)));
  rig.play(); rig.play();
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 2048, 'still not');
  assert.equal(Atomics.load(ctl, LOOKAHEAD_NEXT), 4096, 'one run, one doubling');
  rig.play();
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 4096, 'obeyed a chunk (four quanta) after the underrun');
  assert.deepEqual([0, 1, 2].map(s => Atomics.load(ctl, bellOf(s)) - bells[s]), [1, 1, 1], 'every stage woken');
  rig.play();
  assert.equal(Atomics.load(ctl, LOOKAHEAD_NEXT), 4096, 'a run that goes on grows it no further');

  // Audio again, then a second run: 8192; a third: still 8192, the most.
  rig.render();
  while (rig.play());
  assert.equal(Atomics.load(ctl, LOOKAHEAD_NEXT), 8192);
  for (let q = 0; q < 4; q++) rig.play();
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 8192);
  rig.render();
  while (rig.play());
  for (let q = 0; q < 8; q++) rig.play();
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 8192, 'capped');
  assert.equal(Atomics.load(ctl, UNDERRUNS), drain.underruns);
});

test('lookahead: a steady stretch halves it back to the base and no further; hidden raises it and holds it', () => {
  const steady = 500;
  const rig = steered({ base: 2048, max: 8192, hidden: 4096, steady });
  const { ctl, drain } = rig;
  const run = quanta => { for (let q = 0; q < quanta; q++) { rig.render(); assert.ok(rig.play(), `quantum ${drain.played} played`); } };
  // Grown to 8192 by two stalls.
  rig.render();
  for (const _ of [1, 2]) { while (rig.play()); for (let q = 0; q < 4; q++) rig.play(); run(4); }
  rig.render();
  while (rig.play());
  for (let q = 0; q < 4; q++) rig.play();
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 8192);
  const silent = rig.silent;

  run(steady - 10);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 8192, 'not before the stretch is over');
  run(10);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 4096, 'halved');
  assert.equal(Atomics.load(ctl, LOOKAHEAD_NEXT), 4096);
  run(steady);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 2048, 'halved again, to the base');
  run(3 * steady);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 2048, 'never below the base');
  assert.equal(rig.silent, silent, 'shrinking dropped nothing: every quantum played its frames');

  // Hidden: up to the floor at once (obeyed a chunk on), and held there.
  drain.setHidden(true);
  assert.equal(Atomics.load(ctl, LOOKAHEAD_NEXT), 4096);
  run(4);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 4096);
  run(3 * steady);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 4096, 'never shrinks while hidden');
  // Visible again: a whole stretch first, then down.
  drain.setHidden(false);
  run(steady - 1);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 4096);
  run(1);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 2048);
  // An underrun starts the stretch over.
  drain.setHidden(true); run(4); drain.setHidden(false);
  run(steady - 50);
  while (rig.play());                        // a stall: grows to 8192
  for (let q = 0; q < 4; q++) rig.play();
  run(steady - 1);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 8192, 'the underrun restarted the stretch');
  run(1);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 4096);
});

test('lookahead: a stage that stalls longer than the lookahead underruns until it has grown past the stall, and the time map never moves', () => {
  // Stalls of 40 quanta (5120 frames, 107 ms at 48 kHz) every 400, against
  // a base of 1024 frames: it grows 1024, 2048, 4096, 8192 and then holds.
  const rig = steered({ base: 1024, max: 16384, hidden: 8192, steady: 1e9 });
  const { ctl } = rig;
  const perStall = [];
  let before = 0;
  for (let q = 0; q < 4000; q++) {
    const stalled = q % 400 >= 200 && q % 400 < 240;
    if (!stalled) rig.render();
    rig.play();
    if (q % 400 === 399) { perStall.push(rig.silent - before); before = rig.silent; }
  }
  assert.ok(perStall[0] > 0, `the first stall underran (${perStall})`);
  assert.equal(Atomics.load(ctl, LOOKAHEAD), 8192, 'grown to the first doubling past the stall');
  assert.deepEqual(perStall.slice(-4), [0, 0, 0, 0], `once grown, stalls no longer underrun (${perStall})`);
});

test('lookahead, message mode: every change is posted, and the lookahead rides the chunks back to the mix', async () => {
  const { writer, reader } = MessageRing.describe(2, 8 * CHUNK);
  const w = openRing(writer, 'writer');
  const posts = [];
  const drain = new Drain({ post: m => posts.push({ ...m }), lookahead: { base: 1024, max: 4096, hidden: 2048, steady: 1e9 } });
  drain.attach(openRing(reader, 'reader'));
  const r = drain.ring;
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let written = 0;
  const feed = async chunks => {
    for (let k = 0; k < chunks; k++) { await until(() => w.writable() >= CHUNK); writeChunk(w, written); written += CHUNK; }
    await until(() => r.readable() >= chunks * CHUNK);
  };
  try {
    await feed(1);
    for (let q = 0; q < 4; q++) drain.play(L, R, 0);
    drain.play(L, R, 0);                                   // dry: an underrun
    assert.deepEqual(posts.at(-1), { type: 'lookahead', next: 2048, target: 1024, underruns: 1 });
    for (let q = 0; q < 3; q++) drain.play(L, R, 0);
    assert.deepEqual(posts.at(-1), { type: 'lookahead', next: 2048, target: 2048, underruns: 4 });
    // The next chunk the drain empties carries 2048 back to the writer.
    await feed(3);
    for (let q = 0; q < 8; q++) drain.play(L, R, 0);
    await until(() => w.ahead === 2048);
    drain.setHidden(true);
    assert.equal(posts.at(-1).next, 2048, 'already at the hidden floor: no rise');
    assert.equal(posts.filter(p => p.type === 'lookahead').length, 2);
  } finally {
    drain.close();
    w.close();
  }
});
