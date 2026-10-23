// The standing playback (platform/tape-replay.js): the ?replay= path held
// to a file under tapes/, a fetched tape's entries found, and the tape
// handed to the brush's own loop (core/brush.js brushReplay) in real time,
// never squeezed as the show's cue 24 is. The archived tape in tapes/ is
// planned too, so a change that squeezed it would show here.
//
// Its pace (Replay speed, live), its pause (brushReplayHold, the page's
// Space and tap) and Replay size are driven here through the brush itself.
//
//   node --test tools/tape-replay.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tapePath, tapeEntries, startTapeReplay, REAL_TIME } from '../platform/tape-replay.js';
import { planPass, LOOP_MS, LOOP_REST_MS } from '../core/brush-replay.js';
import { brushTapeCount, brushReplaying, brushReplay, brushReplayHold, brushPlay, brushPlaying, brushQueue, brushQueueDrop, setBrushClock, brushPlayReset, STAMP_FLOATS } from '../core/brush.js';
import { brushSide } from '../core/brush-stamps.js';
import { S } from '../js/state.js';
import { encodeStroke, MOTIF } from '../touch/strokes.js';

const ARCHIVE = 'tapes/win-1792736009664-n58524.json';

test('tapePath: only a file under tapes/ on this site', () => {
  assert.equal(tapePath(ARCHIVE), ARCHIVE);
  assert.equal(tapePath('tapes/a/b.json'), 'tapes/a/b.json');
  for (const bad of [null, undefined, '', 'tapes/', 'tapes/x.js', '/tapes/x.json', 'https://evil.example/tapes/x.json',
                     '//evil.example/tapes/x.json', 'tapes/../main.json', 'tapes/./x.json', 'other/x.json',
                     'tapes/x.json?y', 'tapes/x y.json', 'tapes\\x.json'])
    assert.equal(tapePath(bad), '', String(bad));
});

test('tapeEntries: an archive, a bare array, or nothing', () => {
  const e = [{ at: 0, id: 1, s: {} }];
  assert.equal(tapeEntries({ room: 'r', entries: e }), e);
  assert.equal(tapeEntries(e), e);
  assert.equal(tapeEntries({ entries: [] }), null);
  assert.equal(tapeEntries({}), null);
  assert.equal(tapeEntries(null), null);
});

let now = 7e6;
setBrushClock(() => now);
const stroke = (u, d, t0) => encodeStroke(MOTIF, 200, 50, d, [{ u, v: 0.4 }, { u: u + 0.05, v: 0.45 }, { u: u + 0.1, v: 0.5 }],
  { a: 1, m: 3, c: 1, f: 0.5, q: [t0, 30, 30] });
const ok = doc => async () => ({ ok: true, json: async () => doc });

test('a fetched tape loops through the brush in real time, a 2-minute drawing taking its 2 minutes', async () => {
  brushPlayReset();
  brushQueueDrop(brushQueue.count);
  // one stroke at the start, one two minutes on: a squeeze would bring the
  // second inside the show's 45 s
  const entries = [{ at: 1000, id: 1, s: stroke(0.2, 0, 1000) }, { at: 1060, id: 1, s: stroke(0.3, 2, 1060) },
                   { at: 121000, id: 2, s: stroke(0.6, 0, 121000) }, { at: 121060, id: 2, s: stroke(0.7, 2, 121060) }];
  assert.equal(await startTapeReplay('tapes/t.json', ok({ entries })), 4);
  assert.ok(brushReplaying());
  assert.equal(brushTapeCount(), 4);
  const seen = () => { const n = brushQueue.count; brushQueueDrop(n); return n; };
  for (let t = 0; t < 5000; t += 16) { now += 16; brushPlay(0.016); }
  assert.ok(seen() > 0, 'the first stroke plays at once');
  for (let t = 0; t < 60000; t += 50) { now += 50; brushPlay(0.05); }
  assert.equal(seen(), 0, 'a minute in, the second stroke is still a minute off');
  for (let t = 0; t < 65000; t += 50) { now += 50; brushPlay(0.05); }
  assert.ok(seen() > 0, 'two minutes in, it plays');
  assert.ok(brushPlaying(), 'and the loop goes on');
  brushReplay(false);
});

test('a fetch that fails is tried again; a tape with nothing in it plays nothing', async () => {
  let n = 0;
  const flaky = async () => (++n < 2 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ entries: [{ at: 0, id: 1, s: stroke(0.5, 0, 0) }] }) });
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realTimeout(fn, 0);
  try { assert.equal(await startTapeReplay(ARCHIVE, flaky), 1); } finally { globalThis.setTimeout = realTimeout; }
  assert.equal(n, 2);
  brushReplay(false);
  assert.equal(await startTapeReplay(ARCHIVE, ok({ entries: [] })), 0);
  assert.equal(await startTapeReplay('../x.json', ok({ entries: [{}] })), 0);
  assert.ok(!brushReplaying());
});

test('the archived tape plans in real time: unsqueezed, the creation at its own length', () => {
  const doc = JSON.parse(fs.readFileSync(new URL('../' + ARCHIVE, import.meta.url), 'utf8'));
  const entries = tapeEntries(doc);
  const p = planPass(entries, REAL_TIME);
  assert.equal(p.scale, 1);
  assert.ok(p.drawers > 0, 'it starts where the room arrived');
  const span = p.steps[p.steps.length - 1].tMs;
  assert.equal(p.ms, span + LOOP_REST_MS);
  assert.ok(span > LOOP_MS, 'longer than the show\'s squeeze');
  console.log('# the archived creation runs ' + (span / 60000).toFixed(2) + ' min a pass, from batch ' + p.skipped);
});

// A two-stroke tape: drawer 1 at its start, drawer 2 two minutes on.
const twoStrokes = () => [{ at: 1000, id: 1, s: stroke(0.2, 0, 1000) }, { at: 1060, id: 1, s: stroke(0.3, 2, 1060) },
                          { at: 121000, id: 2, s: stroke(0.6, 0, 121000) }, { at: 121060, id: 2, s: stroke(0.7, 2, 121060) }];
// the moment (s from the start) the second drawer's first stamp appears,
// stepping frame by frame, with `during(t)` called each frame
async function secondAt(during = () => {}) {
  brushPlayReset();
  brushQueueDrop(brushQueue.count);
  await startTapeReplay('tapes/t.json', ok({ entries: twoStrokes() }));
  const F = STAMP_FLOATS;
  let t = 0;
  for (; t < 400000; t += 20) {
    now += 20; during(t); brushPlay(0.02);
    const q = brushQueue;
    let hit = false;
    for (let i = 0; i < q.count; i++) if (q.buf[((q.head + i) % q.cap) * F + 6] === 100002) hit = true;
    brushQueueDrop(q.count);
    if (hit) break;
  }
  brushReplay(false);
  // the strokes still playing out leave before the next case
  for (let k = 0; k < 500; k++) { now += 20; brushPlay(0.02); brushQueueDrop(brushQueue.count); }
  return t / 1000;
}

test('Replay speed: 0.5x takes the two minutes in four, 2x in one; 1x is real time', async () => {
  try {
    S.brushReplaySpeed = 1;
    const real = await secondAt();
    S.brushReplaySpeed = 0.5;
    const slow = await secondAt();
    S.brushReplaySpeed = 2;
    const fast = await secondAt();
    assert.ok(Math.abs(real - 120) < 1, 'real ' + real);
    assert.ok(Math.abs(slow - 240) < 1, 'slow ' + slow);
    assert.ok(Math.abs(fast - 60) < 1, 'fast ' + fast);
  } finally { S.brushReplaySpeed = 1; }
});

test('Replay speed moved mid-pass changes the pace from where the pass stands', async () => {
  try {
    S.brushReplaySpeed = 1;
    // a minute at 1x, then 2x for the second minute's worth: 60 + 30
    const t = await secondAt(ms => { if (ms === 60000) S.brushReplaySpeed = 2; });
    assert.ok(Math.abs(t - 90) < 1, 'at ' + t);
  } finally { S.brushReplaySpeed = 1; }
});

test('a hold stops the pass where it stands and letting go carries on from there', async () => {
  // held from 30 s to 130 s: the second stroke comes 100 s late, not replanned
  const t = await secondAt(ms => { if (ms === 30000) brushReplayHold(true); if (ms === 130000) brushReplayHold(false); });
  assert.ok(Math.abs(t - 220) < 1, 'at ' + t);
});

test('Replay size: replayed stamps at the scaled width, a live stroke never', async () => {
  try {
    S.brushReplaySize = 2;
    brushPlayReset();
    brushQueueDrop(brushQueue.count);
    await startTapeReplay('tapes/t.json', ok({ entries: twoStrokes() }));
    let side = 0;
    for (let k = 0; k < 300 && !side; k++) {
      now += 20; brushPlay(0.02);
      if (brushQueue.count) side = brushQueue.buf[brushQueue.head * STAMP_FLOATS + 3];
      brushQueueDrop(brushQueue.count);
    }
    brushReplay(false);
    assert.ok(Math.abs(side - brushSide(100)) < 1e-6, 'drawn at w 100: ' + side);
  } finally { S.brushReplaySize = 1; }
});
