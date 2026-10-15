// Underrun concealment (js/heart/conceal.js) in the drain: a dry quantum
// plays the history ping-pong instead of silence, continuous going in and
// at the turnaround, fades out under the audio when it comes back, decays
// to silence on a long stall, never moves the clock, and allocates nothing.
// The low end's guarantees at the end are measured through the profile
// harness (conceal-lf-profile.mjs).
//
//   node tools/heart-tests/conceal.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Drain } from '../../js/heart/drain-worklet.js';
import { Conceal, FORWARD } from '../../js/heart/conceal.js';
import { SharedRing, makeControl, CHUNK, QUANTUM, PLAYED } from '../../js/heart/ring.js';
import { profile, PATTERNS } from './conceal-lf-profile.mjs';

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
  const c = new Conceal({ size: 1024, loop: 512, xfade: 0, hold: 1e9 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let f = 0;
  for (let q = 0; q < 4; q++) {
    for (let i = 0; i < QUANTUM; i++, f++) { L[i] = f; R[i] = -f; }
    c.wet(L, R);
  }
  // History holds frames 0..511; the last played is 511.
  const got = [];
  for (let q = 0; q < 10; q++) { c.dry(L, R); for (let i = 0; i < QUANTUM; i++) { got.push(L[i]); assert.ok(R[i] === -L[i], `right mirrors left at ${i}`); } }
  // Going in, it carries on the way the sound was going (511 to 512), and
  // eases into the reverse over the bridge (128 frames) without a step;
  // from there on it is the plain mirror, a frame a frame.
  assert.ok(Math.abs(got[0] - 512) < 1e-3, `first ${got[0]}`);
  let prev = 511;
  for (let i = 0; i < 128; i++) { assert.ok(Math.abs(got[i] - prev) < 1.1, `bridge step ${i}`); prev = got[i]; }
  for (let i = 129; i < got.length; i++) assert.equal(Math.abs(got[i] - got[i - 1]), 1, `step ${i}`);
  assert.ok(got.includes(0) && got.filter(v => v === 511).length > 0, 'turns at both ends');
});

test('conceal: a crossfaded turn blends the pass going back into the pass coming forward', () => {
  const c = new Conceal({ size: 1024, loop: 512, xfade: 64, hold: 1e9 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let f = 0;
  for (let q = 0; q < 4; q++) {
    for (let i = 0; i < QUANTUM; i++, f++) { L[i] = f; R[i] = -f; }
    c.wet(L, R);
  }
  const got = [];
  for (let q = 0; q < 12; q++) { c.dry(L, R); got.push(...L); }
  // Going in, it carries on the way the sound was going, then turns.
  assert.ok(Math.abs(got[0] - 512) < 1e-3, `first ${got[0]}`);
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
  c.configure({ xfade: 0 });
  assert.equal(c.xfade, 0);
  c.configure({ xfade: 1e6 });
  assert.equal(c.xfade, 128, 'no more than a quarter of the history');
});

test('conceal: fades out under the returning audio, then records again', () => {
  const c = new Conceal({ size: 512, hold: 1e9, ret: 128 });
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
  const c = new Conceal({ size: 256, hold: 256, decay: 256, ret: 128 });
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

// A 40 Hz tone at 48 kHz: 1200 frames a cycle.
const tone = f => 0.8 * Math.sin(2 * Math.PI * f / 1200);

test('forward loop: a steady tone carries straight on through a stall, as if nothing happened', () => {
  const c = new Conceal({ size: 120000, loop: 24000, xfade: 2400, mode: FORWARD, hold: 1e9 });
  c.setPeriods(1200, 16000);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let f = 0;
  for (let q = 0; q < 600; q++) { for (let i = 0; i < QUANTUM; i++, f++) L[i] = R[i] = tone(f); c.wet(L, R); }
  // Three seconds of stall: many loops, many seams.
  let worst = 0;
  for (let q = 0; q < 1100; q++) {
    c.dry(L, R);
    for (let i = 0; i < QUANTUM; i++, f++) worst = Math.max(worst, Math.abs(L[i] - tone(f)));
  }
  assert.ok(worst < 1e-4, `strays from the tone by ${worst}`);
  // And the sound comes back on the same tone: no dip, no bump.
  for (let q = 0; q < 40; q++) {
    for (let i = 0; i < QUANTUM; i++) L[i] = R[i] = tone(f + i);
    c.wet(L, R);
    for (let i = 0; i < QUANTUM; i++, f++) worst = Math.max(worst, Math.abs(L[i] - tone(f)));
  }
  assert.ok(worst < 1e-4, `the return strays by ${worst}`);
});

test('forward loop: the length fits whole cycles of the tone and the strobe', () => {
  const c = new Conceal({ size: 120000, loop: 24000, mode: FORWARD });
  c.setPeriods(1200, 16000);       // 40 Hz and 3 Hz
  assert.equal(c.fit(100000), 48000, 'half a second fits neither the strobe; a second fits both');
  c.setPeriods(1200, 0);
  assert.equal(c.fit(100000), 24000, 'the tone alone: the Loop length is already whole cycles');
  c.setPeriods(0, 0);
  assert.equal(c.fit(100000), 24000);
});

test('forward loop: music going in and at the seams never jumps', () => {
  const ring = new SharedRing(SharedRing.describe(2, 8192));
  const drain = new Drain({ post: () => {}, conceal: 24000, concealSet: { loop: 6000, xfade: 480, mode: FORWARD } });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let written = 0;
  const feed = () => { while (written < (drain.played + 1) * QUANTUM + 8 * CHUNK && ring.writable() >= CHUNK) { writeChunk(ring, written); written += CHUNK; } };
  feed();
  for (let q = 0; q < 200; q++) { feed(); drain.play(L, R, 0); }
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pattern = [];
  for (let i = 0; i < 59; i++) pattern.push(1 + Math.floor(rnd() * 20));
  drain.simulate(Int32Array.from(pattern));
  let prev = L[QUANTUM - 1], maxJump = 0;
  for (let q = 0; q < 900; q++) {
    feed();
    drain.play(L, R, 0);
    for (let i = 0; i < QUANTUM; i++) { maxJump = Math.max(maxJump, Math.abs(L[i] - prev)); prev = L[i]; }
  }
  assert.ok(maxJump < 0.05, `largest step ${maxJump.toFixed(3)}`);
});

test('quantize repair: a short dropout plays a whole loop before the sound comes back', () => {
  const c = new Conceal({ size: 8192, loop: 1024, xfade: 0, mode: FORWARD, quantize: true, hold: 1e9, ret: 128 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  for (let q = 0; q < 40; q++) { L.fill(0.5); R.fill(0.5); c.wet(L, R); }
  c.dry(L, R);                      // one quantum dry
  let held = QUANTUM;
  for (let q = 0; q < 20; q++) {
    L.fill(9); R.fill(9);           // the sound is back, marked 9
    c.wet(L, R);
    const first9 = L.findIndex(v => v > 1);
    if (first9 < 0) { held += QUANTUM; continue; }
    held += first9;
    break;
  }
  // 1024 frames of loop, then the return fade's first frames are mostly loop.
  assert.ok(held >= 1024 && held < 1024 + 2 * QUANTUM, `held ${held}`);
});

// The wash takes only what is above the crossover: a 500 Hz tone turns to
// the room over Wash rise, while the 40 Hz tone (four times the tone's
// frequency is 160 Hz) stays dry and at full level, so the room's low end
// never cancels it. The 40 Hz check used to be the other way round, before
// the low end was kept out of the room.
const high = f => 0.8 * Math.sin(2 * Math.PI * f / 96);
for (const [name, sig, wet] of [['500 Hz tone turns to the room', high, true], ['40 Hz tone stays dry', tone, false]]) {
  test(`wash: ${name} over Wash rise, then the room rings out and sleeps`, () => {
    const make = wash => new Conceal({ size: 120000, loop: 24000, xfade: 2400, mode: FORWARD, hold: 1e9, wash, washRise: 48000, washDecay: 2 });
    const a = make(1), b = make(0);
    a.setPeriods(1200, 0); b.setPeriods(1200, 0);
    const La = new Float32Array(QUANTUM), Ra = new Float32Array(QUANTUM), Lb = new Float32Array(QUANTUM), Rb = new Float32Array(QUANTUM);
    let f = 0;
    for (let q = 0; q < 300; q++) {
      for (let i = 0; i < QUANTUM; i++, f++) La[i] = Ra[i] = Lb[i] = Rb[i] = sig(f);
      a.wet(La, Ra); b.wet(Lb, Rb);
    }
    // How far the washed stall is from the dry one, early and once risen.
    const diff = (quanta, each = null) => {
      let d = 0;
      for (let q = 0; q < quanta; q++) {
        a.dry(La, Ra); b.dry(Lb, Rb);
        for (let i = 0; i < QUANTUM; i++) { d = Math.max(d, Math.abs(La[i] - Lb[i])); if (each) each(La[i], Lb[i]); }
      }
      return d;
    };
    const early = diff(8);            // the first 21 ms
    diff(400);                        // past the second of rise
    let ea = 0, eb = 0;
    const late = diff(20, (x, y) => { ea += x * x; eb += y * y; });
    assert.ok(early < 0.05, `early ${early}`);
    if (wet) assert.ok(late > 0.3, `late ${late}`);
    else {
      // The split is a one-pole, so the dry low end is a few degrees
      // behind the dry stall's; its level is what must hold.
      const level = 10 * Math.log10(ea / eb);
      assert.ok(Math.abs(level) < 0.5, `low end ${level.toFixed(2)} dB off: it should stay dry and at full level`);
    }
    // The sound comes back: the room still rings under it a while, then sleeps.
    for (let q = 0; q < 40; q++) { La.fill(0); Ra.fill(0); a.wet(La, Ra); }
    assert.ok(a.room.awake && La.some(v => v !== 0), 'rings under the returning sound');
    for (let q = 0; q < 48000 * 3 / QUANTUM; q++) { La.fill(0); Ra.fill(0); a.wet(La, Ra); }
    assert.equal(a.room.awake, false, 'asleep once rung out');
    assert.ok(La.every(v => v === 0));
  });
}

test('wash: many dropouts with the room on never jump', () => {
  const ring = new SharedRing(SharedRing.describe(2, 8192));
  const drain = new Drain({ post: () => {}, conceal: 24000, concealSet: { loop: 6000, xfade: 480, mode: FORWARD, wash: 0.8, washRise: 4800 } });
  drain.attach(ring);
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  let written = 0;
  const feed = () => { while (written < (drain.played + 1) * QUANTUM + 8 * CHUNK && ring.writable() >= CHUNK) { writeChunk(ring, written); written += CHUNK; } };
  feed();
  for (let q = 0; q < 200; q++) { feed(); drain.play(L, R, 0); }
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pattern = [];
  for (let i = 0; i < 59; i++) pattern.push(1 + Math.floor(rnd() * 40));
  drain.simulate(Int32Array.from(pattern));
  let prev = L[QUANTUM - 1], maxJump = 0, peak = 0;
  for (let q = 0; q < 2000; q++) {
    feed();
    drain.play(L, R, 0);
    for (let i = 0; i < QUANTUM; i++) { maxJump = Math.max(maxJump, Math.abs(L[i] - prev)); prev = L[i]; peak = Math.max(peak, Math.abs(L[i])); }
  }
  assert.ok(maxJump < 0.05, `largest step ${maxJump.toFixed(3)}`);
  assert.ok(peak < 2, `peak ${peak.toFixed(2)}`);
});

test('return fade: its own length, however short the crossfade', () => {
  const c = new Conceal({ size: 120000, loop: 24000, xfade: 480, mode: FORWARD, hold: 1e9, ret: 36000 });
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
  for (let q = 0; q < 400; q++) { L.fill(0.5); R.fill(0.5); c.wet(L, R); }
  c.dry(L, R);
  let q = 0;
  while (c.active) { L.fill(0); R.fill(0); c.wet(L, R); q++; }
  assert.equal(q, Math.ceil(36000 / QUANTUM), 'the fade back lasts the Return fade');
});

// Robert's case: Quantize repair, 14 dropouts of 200 ms with 200 ms between,
// a forward loop over the 40 Hz tone, the wash on. A dropout landing in
// the return fade used to start its stall a step away from what was heard
// (0.05 on a tone that moves 0.003 a frame: a click) and dry again (the
// raw sound pushing back in).
for (const mode of [0, FORWARD]) for (const wash of [0, 0.6]) {
  test(`quantized dropouts landing in the return fade: no click (${mode === FORWARD ? 'forward' : 'ping-pong'}, wash ${wash})`, () => {
    const ring = new SharedRing(SharedRing.describe(2, 1 << 15));
    const ahead = 2400;
    const drain = new Drain({ post: () => {}, lookahead: { base: ahead, max: 24000, hidden: ahead, fullscreen: ahead, steady: 11250, grow: 1.5 },
      conceal: 120000, concealSet: { loop: 24000, xfade: 2400, mode, quantize: true, wash, washRise: 72000, washDecay: 4, ret: 36000, hold: 144000, rate: 48000 } });
    drain.conceal.setPeriods(1200, 16000);
    drain.attach(ring);
    const src = new Float32Array(CHUNK);
    let written = 0;
    const feed = () => { for (let k = 0; k < 2 && written < (drain.played + 1) * QUANTUM + Math.max(ahead, drain.target) && ring.writable() >= CHUNK; k++) {
      for (let i = 0; i < CHUNK; i++) src[i] = 0.5 * tone(written + i) / 0.8;
      ring.write(0, src, 0, CHUNK); ring.write(1, src, 0, CHUNK); ring.commit(CHUNK); written += CHUNK; } };
    const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
    for (let q = 0; q < 1000; q++) { feed(); drain.play(L, R, 0); }
    const pattern = [];
    for (let i = 0; i < 14; i++) { if (i) pattern.push(75); pattern.push(75); }
    drain.simulate(Int32Array.from(pattern));
    let prev = L[QUANTUM - 1], worst = 0;
    for (let q = 0; q < 3000; q++) {
      feed();
      drain.play(L, R, 0);
      for (let i = 0; i < QUANTUM; i++) { worst = Math.max(worst, Math.abs(L[i] - prev)); prev = L[i]; }
    }
    // The tone alone moves at most 0.0026 a frame. A ping-pong's turns blend
    // a copy going forward with one going back, which steepens the sum by
    // a third or so; the room adds a little texture. A click was 0.05.
    const most = wash ? 0.008 : mode === FORWARD ? 0.0027 : 0.004;
    assert.ok(worst < most, `largest step ${worst.toFixed(4)}`);
  });
}

// The low end, measured (conceal-lf-profile.mjs): the raw 40 Hz tone through
// Robert's burst, both modes, with and without the wash, quantized and not,
// at both sample rates. The low band's level holds through the entry, the
// stall and the heal, and nothing thumps below it (the floor, the tone's
// own leak into the sub band, is -31 dB; what is left above it is the
// wash's dry step going in, over the 10 ms bridge). Before the ping-pong
// kept the tone in phase and the wash kept out of the low end, the heal
// dipped 32 dB (ping-pong) and 17 dB (the wash), and the wash's entry
// thumped 20 dB above the floor.
for (const rate of [48000, 44100]) for (const mode of [0, FORWARD]) for (const wash of [0, 0.6]) for (const quantize of [true, false]) {
  test(`low end holds: 40 Hz tone, ${mode === FORWARD ? 'forward' : 'ping-pong'}, wash ${wash}, quantize ${quantize ? 'on' : 'off'}, ${rate} Hz`, () => {
    const { worst } = profile({ kind: 'tone', rate, mode, wash, quantize, pattern: PATTERNS['14 x 200 ms'] });
    for (const k of ['entryDip', 'duringDip', 'healDipShort', 'healDipLong']) assert.ok(worst[k] > -1.5, `${k} ${worst[k].toFixed(1)} dB`);
    for (const k of ['entryWhump', 'healWhump']) assert.ok(worst[k] < -22, `${k} ${worst[k].toFixed(1)} dB`);
    assert.ok(worst.step < 0.005, `step ${worst.step.toFixed(4)}`);
  });
}

// With the strobe's AM on the tone, and music over it, a forward loop keeps
// the pulse's level through the burst, the wash on: its low end used to
// dip 8 dB.
for (const kind of ['am', 'music']) {
  test(`low end holds: forward loop, ${kind}, wash 0.6`, () => {
    const { worst } = profile({ kind, mode: FORWARD, wash: 0.6, quantize: false, pattern: PATTERNS['14 x 200 ms'] });
    assert.ok(worst.duringDip > -2.5 && worst.healDipLong > -2.5, `during ${worst.duringDip.toFixed(1)} dB, heal ${worst.healDipLong.toFixed(1)} dB`);
  });
}

// A quantized burst is not one long stall: the sound keeps coming back
// into it, so `hold` counts the ring dry in a row and the loop never fades
// to silence in the middle of the burst (it did at 44.1 kHz, 2.6 s of it).
test('a quantized burst never goes silent', () => {
  const { out } = profile({ kind: 'tone', rate: 44100, mode: 0, wash: 0, quantize: true, pattern: PATTERNS['14 x 200 ms'] });
  let quiet = 0, worst = 0;
  for (let f = 44100; f < out.length; f++) { if (Math.abs(out[f]) < 1e-4) { if (++quiet > worst) worst = quiet; } else quiet = 0; }
  assert.ok(worst < 200, `silent for ${worst} frames`);
});
