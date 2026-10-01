// The rings (js/heart/ring.js): index math, wraparound, reads that straddle
// a chunk boundary, buffer reuse, the clock riding returned chunks, and a
// real two-thread SharedRing run with Atomics wake-ups.
//
//   node tools/heart-tests/ring.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  SharedRing, MessageRing, makeRing, openRing, CHUNK, QUANTUM,
  makeControl, bellOf, ringBell
} from '../../js/heart/ring.js';

// A sample that names its frame and channel, exact in f32.
const sample = (frame, c) => (frame % 1000003) + c * 0.25;

function writeFrames(ring, start, frames, channels) {
  const src = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) src[i] = sample(start + i, c);
    ring.write(c, src, 0, frames);
  }
  ring.commit(frames);
}

function checkFrames(ring, start, frames, channels) {
  const dst = new Float32Array(frames + 3);
  for (let c = 0; c < channels; c++) {
    ring.read(c, dst, 3, frames);
    for (let i = 0; i < frames; i++) {
      if (dst[3 + i] !== sample(start + i, c)) {
        assert.fail(`channel ${c} frame ${start + i}: got ${dst[3 + i]}, want ${sample(start + i, c)}`);
      }
    }
  }
}

const settle = () => new Promise(r => setTimeout(r, 1));

test('SharedRing: empty, full, and the one frame kept free', () => {
  const ring = openRing(SharedRing.describe(2, 1000), 'writer');
  assert.equal(ring.readable(), 0);
  assert.equal(ring.writable(), 1000);
  writeFrames(ring, 0, 1000, 2);
  assert.equal(ring.readable(), 1000);
  assert.equal(ring.writable(), 0);
  ring.release(1000);
  assert.equal(ring.readable(), 0);
  assert.equal(ring.writable(), 1000);
});

test('SharedRing: 512-frame writes, 128-frame reads, many laps of a ring that is no multiple of either', () => {
  const ring = openRing(SharedRing.describe(3, 1000), 'reader');
  let written = 0, read = 0;
  while (read < 50000) {
    while (ring.writable() >= CHUNK) { writeFrames(ring, written, CHUNK, 3); written += CHUNK; }
    assert.equal(ring.readable(), written - read);
    assert.equal(ring.readable() + ring.writable(), 1000);
    checkFrames(ring, read, QUANTUM, 3);
    ring.release(QUANTUM);
    read += QUANTUM;
  }
});

test('SharedRing: reads and writes at an offset, and zero, across the wrap', () => {
  const ring = new SharedRing(SharedRing.describe(2, 700));
  // Move the indices close to the end so the next chunk wraps.
  writeFrames(ring, 0, 600, 2);
  ring.release(600);
  const src = Float32Array.from({ length: 300 }, (_, i) => 1000 + i);
  ring.write(0, src, 0, 300, 50);       // frames 50..349 past the write index
  ring.zero(1, 400);
  ring.commit(400);
  const dst = new Float32Array(300);
  ring.read(0, dst, 0, 300, 50);
  assert.deepEqual(Array.from(dst), Array.from(src));
  ring.read(1, dst, 0, 300, 100);
  assert.ok(dst.every(v => v === 0));
});

test('MessageRing: chunks flow, reads straddle chunk boundaries, buffers are reused, the clock returns', async () => {
  const { writer: wd, reader: rd } = MessageRing.describe(2, 3 * CHUNK);
  const w = openRing(wd, 'writer'), r = openRing(rd, 'reader');
  assert.equal(w.slots, 3);
  let written = 0, read = 0, changes = 0;
  w.onchange = () => changes++;
  // An odd read size, so reads land everywhere inside a chunk and across
  // the boundary between two.
  const step = 384;
  while (read < 40 * CHUNK) {
    while (w.writable() >= CHUNK) { writeFrames(w, written, CHUNK, 2); written += CHUNK; }
    await settle();
    while (r.readable() >= step) {
      checkFrames(r, read, step, 2);
      r.clock = read + step;
      r.release(step);
      read += step;
    }
    await settle();
  }
  assert.equal(w.made, 3, 'never more chunks than slots');
  assert.ok(changes > 0);
  assert.equal(w.clock % step, 0);
  assert.ok(w.clock > 0 && w.clock <= read);
  w.close(); r.close();
});

test('MessageRing: only whole chunks commit', () => {
  const { writer, reader } = MessageRing.describe(1, CHUNK);
  const w = openRing(writer, 'writer');
  w.zero(0, 128);
  assert.throws(() => w.commit(128));
  w.close(); reader.port.close();
});

test('makeRing sizes a message ring in whole chunks', () => {
  const { writer, reader } = makeRing(false, 2, 2176 + CHUNK);
  assert.equal(writer.slots, 6);
  assert.equal(reader.slots, 6);
  writer.port.close(); reader.port.close();
});

test('SharedRing across two threads: a writer that sleeps on its bell, a reader that rings it', async () => {
  const desc = SharedRing.describe(2, 1500);
  const ctl = makeControl(1);
  const frames = 400 * CHUNK;
  const src = `
    import { workerData } from 'node:worker_threads';
    import { SharedRing, bellOf } from ${JSON.stringify(new URL('../../js/heart/ring.js', import.meta.url).href)};
    const { desc, ctl, frames, chunk } = workerData;
    const ring = new SharedRing(desc), buf = new Float32Array(chunk);
    for (let f = 0; f < frames; f += chunk) {
      for (;;) {
        const bell = Atomics.load(ctl, bellOf(0));
        if (ring.writable() >= chunk) break;
        Atomics.wait(ctl, bellOf(0), bell, 1000);
      }
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < chunk; i++) buf[i] = ((f + i) % 1000003) + c * 0.25;
        ring.write(c, buf, 0, chunk);
      }
      ring.commit(chunk);
    }`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(src)}`), {
    workerData: { desc, ctl, frames, chunk: CHUNK }
  });
  const ring = new SharedRing(desc);
  let read = 0, spins = 0;
  while (read < frames) {
    if (ring.readable() < QUANTUM) { if (++spins % 1000 === 0) await settle(); continue; }
    checkFrames(ring, read, QUANTUM, 2);
    ring.release(QUANTUM);
    ringBell(ctl, 0);
    read += QUANTUM;
  }
  await worker.terminate();
  assert.equal(read, frames);
});
