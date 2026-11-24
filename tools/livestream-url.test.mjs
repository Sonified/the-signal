// The URL's follow and the livestream screen (platform/broadcast-socket.js
// followIntent): ?livestream follows room "livestream", ?livestream=<room>
// another, an explicit ?follow= wins the room, and ?presentation alone is
// neither. Also checks that index.html's inline copy (the join gate, not a
// module) reads the same room.
//
//   node --test tools/livestream-url.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { followIntent, LIVESTREAM_ROOM } from '../platform/broadcast-socket.js';

test('the default room is "livestream"', () => assert.equal(LIVESTREAM_ROOM, 'livestream'));

test('bare ?livestream follows room livestream on the livestream screen', () => {
  assert.deepEqual(followIntent('?livestream'), { follow: 'livestream', livestream: true });
  // with an empty value too
  assert.deepEqual(followIntent('?livestream='), { follow: 'livestream', livestream: true });
});

test('?livestream=<room> follows that room', () => {
  assert.deepEqual(followIntent('?livestream=rehearsal'), { follow: 'rehearsal', livestream: true });
});

test('?follow=<room> alone is a plain follower', () => {
  assert.deepEqual(followIntent('?follow=x'), { follow: 'x', livestream: false });
});

test('both: ?follow= wins the room, the screen is still the livestream one', () => {
  assert.deepEqual(followIntent('?livestream&follow=x'), { follow: 'x', livestream: true });
  assert.deepEqual(followIntent('?follow=x&livestream=y'), { follow: 'x', livestream: true });
  // an empty ?follow= names no room, so the livestream's stands
  assert.deepEqual(followIntent('?follow=&livestream'), { follow: 'livestream', livestream: true });
});

test('neither: no room, not the livestream screen', () => {
  for (const s of ['', '?', '?event=WIN2026', '?draw&replay=x', undefined]) {
    assert.deepEqual(followIntent(s), { follow: '', livestream: false }, String(s));
  }
});

test('?presentation alone is not a livestream', () => {
  for (const s of ['?presentation', '?presentation=rehearsal', '?presentation&pw=x', '?remote']) {
    assert.deepEqual(followIntent(s), { follow: '', livestream: false }, s);
  }
});

test('index.html\'s gate reads the same room', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const m = /const follow = (q\.get\('follow'\)[^\n]*);/.exec(html);
  assert.ok(m, 'the gate\'s follow line is in index.html');
  const gateFollow = new Function('q', 'return ' + m[1] + ';');
  for (const s of ['?livestream', '?livestream=', '?livestream=rehearsal', '?follow=x', '?livestream&follow=x',
                   '?follow=&livestream', '', '?presentation', '?event=WIN2026']) {
    assert.equal(gateFollow(new URLSearchParams(s)), followIntent(s).follow, s);
  }
});
