// A late joiner's slide (core/slide-sync.js): where the broadcaster's video is
// some time after a state message sampled it, at 1x and other rates, paused,
// after a seek, ended and looping; how far off a follower is, the shorter way
// round a loop; when the video's course has changed so a fresh state is
// owed; and what is taken from the wire.
//
//   node --test tools/slide-join.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { slidePosition, slideOffset, slideCourseSame, slideSample, slideChanged, slideEnded } from '../core/slide-sync.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ': ' + a + ' vs ' + b);
const sp = o => Object.assign({ f: 'a.mp4', t: 10, d: 100, r: 1, l: false }, o);

test('playing at 1x: on by the time since', () => {
  near(slidePosition(sp(), 0), 10, 'at once');
  near(slidePosition(sp(), 5), 15, 'five seconds on');
  // a copy the relay kept three minutes ago
  near(slidePosition(sp(), 180), 100, 'held at its end, not past it');
  near(slidePosition(sp({ t: 0, d: 600 }), 180), 180, 'minutes later, still right');
});

test('another rate', () => {
  near(slidePosition(sp({ r: 0.5 }), 10), 15, 'half speed');
  near(slidePosition(sp({ r: 2 }), 10), 30, 'double speed');
  near(slidePosition(sp({ r: 0.0625 }), 16), 11, 'the element\'s floor');
});

test('paused or held (rate 0): it stays where it is', () => {
  near(slidePosition(sp({ r: 0 }), 600), 10, 'paused');
  near(slidePosition(sp({ r: -1 }), 600), 10, 'never backwards');
});

test('sought: the new sample is the new start', () => {
  // the seek's state carries the place it went to; playing on from there
  near(slidePosition(sp({ t: 70 }), 4), 74, 'after a seek');
  // a seek's voice still loading reports rate 0 at its target
  near(slidePosition(sp({ t: 70, r: 0 }), 4), 70, 'while it loads');
});

test('ended: held at the end', () => {
  near(slidePosition(sp({ t: 100, r: 0 }), 60), 100, 'ended');
  near(slidePosition(sp({ t: 98 }), 60), 100, 'runs to its end and stops');
});

test('looped: round its length', () => {
  near(slidePosition(sp({ l: true }), 95), 5, 'once round');
  near(slidePosition(sp({ l: true }), 395), 5, 'four times round');
  near(slidePosition(sp({ l: true, r: 0, t: 40 }), 999), 40, 'a held loop stays');
});

test('a length not known yet: on by the time, unclamped', () => {
  near(slidePosition(sp({ d: NaN }), 200), 210, 'no length');
});

test('the offset, the shorter way round a loop', () => {
  near(slideOffset(50, 40, 100, false), 10, 'plain, behind');
  near(slideOffset(40, 50, 100, false), -10, 'plain, ahead');
  near(slideOffset(1, 99, 100, true), 2, 'just past the top, behind');
  near(slideOffset(99, 1, 100, true), -2, 'just before the end, ahead');
  near(slideOffset(1, 99, 100, false), -98, 'no loop, no wrap');
});

test('the course: what owes a fresh state', () => {
  const a = sp();
  assert.ok(slideCourseSame(a, sp({ t: 55 })), 'played on: the same course');
  assert.ok(slideCourseSame(a, sp({ r: 1.0005 })), 'a rate within the element\'s own threshold');
  assert.ok(!slideCourseSame(a, sp({ r: 0 })), 'paused');
  assert.ok(!slideCourseSame(a, sp({ r: 0.5 })), 'a new rate');
  assert.ok(!slideCourseSame(a, sp({ f: 'b.mp4' })), 'a new slide');
  assert.ok(!slideCourseSame(a, sp({ l: true })), 'loop switched');
  assert.ok(!slideCourseSame(a, sp({ d: 120 })), 'a new length (a new voice)');
  assert.ok(!slideCourseSame(a, null), 'the slide gone');
  assert.ok(!slideCourseSame(null, a), 'a slide come');
  assert.ok(slideCourseSame(null, null), 'none either side');
  assert.ok(slideCourseSame(sp({ d: NaN }), sp({ d: NaN })), 'lengths both unknown');
});

test('from the wire: malformed is nothing', () => {
  assert.deepEqual(slideSample({ f: 'a.mp4', t: 3, d: 9, r: 1, l: true }), { f: 'a.mp4', t: 3, d: 9, r: 1, l: true });
  assert.ok(Number.isNaN(slideSample({ f: 'a.mp4', t: 3, r: 1 }).d), 'no length: NaN');
  for (const bad of [null, undefined, 5, 'x', {}, { f: '', t: 1, r: 1 }, { f: 'a', t: 'x', r: 1 }, { f: 'a', t: 1 }, { f: 'a', t: NaN, r: 1 }]) {
    assert.equal(slideSample(bad), null, JSON.stringify(bad));
  }
});

test('a watching follower is moved on a change of course, never on the same one', () => {
  const T = 0.25, a = sp(), at = 1000;
  // the same course, played on: a later state lands where a's course says
  assert.ok(!slideChanged(a, at, sp({ t: 15 }), at + 5000, T), 'played on');
  assert.ok(!slideChanged(a, at, sp({ t: 15.2 }), at + 5000, T), 'within the tolerance');
  assert.ok(!slideChanged(a, at, sp({ t: 15 }), at + 5000, T) && !slideChanged(sp({ t: 15 }), at + 5000, sp({ t: 20 }), at + 10000, T), 'and again');
  // the same slide, a new course
  assert.ok(slideChanged(a, at, sp({ t: 15, r: 0 }), at + 5000, T), 'paused');
  assert.ok(slideChanged(sp({ r: 0 }), at, sp({ t: 10, r: 1 }), at + 5000, T), 'resumed');
  assert.ok(slideChanged(a, at, sp({ t: 15, r: 0.5 }), at + 5000, T), 'a new rate');
  assert.ok(slideChanged(a, at, sp({ t: 0.3 }), at + 5000, T), 'restarted: a jump');
  assert.ok(slideChanged(a, at, sp({ t: 70 }), at + 5000, T), 'sought: a jump');
  assert.ok(slideChanged(sp({ r: 0 }), at, sp({ r: 0, t: 40 }), at + 5000, T), 'a held slide sought');
  // a new slide that plays starts with everyone's; one held is landed on
  assert.ok(!slideChanged(a, at, sp({ f: 'b.mp4', t: 1 }), at + 5000, T), 'a new slide playing');
  assert.ok(!slideChanged(null, NaN, sp({ f: 'b.mp4', t: 1 }), at, T), 'the first sample of one');
  assert.ok(slideChanged(a, at, sp({ f: 'b.mp4', t: 0, r: 0 }), at + 5000, T), 'a new slide held');
  // nothing to land, or nothing to hold
  assert.ok(!slideChanged(a, at, null, at + 5000, T), 'the slide gone');
  assert.ok(!slideChanged(a, at, sp({ t: 100, r: 0 }), at + 5000, T), 'played to its end');
  // no shared moment on either side: only a course change counts
  assert.ok(!slideChanged(a, NaN, sp({ t: 70 }), at, T), 'no clock, no jump');
  assert.ok(slideChanged(a, NaN, sp({ r: 0 }), at, T), 'no clock, still a pause');
});

test('ended is the end of a slide that does not loop', () => {
  assert.ok(slideEnded(sp({ t: 100, r: 0 })));
  assert.ok(!slideEnded(sp({ t: 99, r: 0 })), 'paused near it');
  assert.ok(!slideEnded(sp({ t: 100, r: 0, l: true })), 'a loop never ends');
  assert.ok(!slideEnded(sp({ t: 100, d: NaN })), 'no length');
  assert.ok(!slideEnded(null));
});
