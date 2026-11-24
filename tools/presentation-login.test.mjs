// The presentation page's one login (platform/presentation-login.js): the
// room the URL names, the two relays' /auth addresses, the verdict from
// their answers, the boot's choice for each case, and the check itself
// against stand-in relays. The password is a made-up stand-in.
//
//   node --test tools/presentation-login.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presentationRoom, authUrls, loginVerdict, loginStart, checkPassword, PW_KEY
} from '../platform/presentation-login.js';
import { RELAY_HOST } from '../platform/broadcast-socket.js';

const FAKE = 'not-the-real-password';

test('the login is kept where the controller keeps it', () => assert.equal(PW_KEY, 'mirror.pw'));

test('the room the URL names, as the receiver always read it', () => {
  assert.deepEqual(presentationRoom('?presentation'), { flag: 'presentation', room: 'show' });
  assert.deepEqual(presentationRoom('?presentation='), { flag: 'presentation', room: 'show' });
  assert.deepEqual(presentationRoom('?presentation=Rehearsal'), { flag: 'presentation', room: 'rehearsal' });
  assert.deepEqual(presentationRoom('?presentation=mirror-x'), { flag: 'presentation', room: 'x' });
  assert.deepEqual(presentationRoom('?remote=a b'), { flag: 'remote', room: 'a-b' });
  assert.equal(presentationRoom('?presentation=' + 'x'.repeat(60)).room.length, 40);
  for (const s of ['', '?livestream', '?follow=x', '?event=WIN2026', undefined]) assert.equal(presentationRoom(s), null, String(s));
});

test('the relays asked: the cloud and the laptop\'s own, or as the URL says', () => {
  assert.deepEqual(authUrls('?presentation'), ['https://' + RELAY_HOST + '/auth', 'http://localhost:8800/auth']);
  assert.deepEqual(authUrls('?presentation&relay=localhost:8787&relaylocal=mac.local:8800'),
    ['http://localhost:8787/auth', 'http://mac.local:8800/auth']);
  assert.deepEqual(authUrls('?relay=localhost:8800'), ['http://localhost:8800/auth'], 'one relay named twice is asked once');
});

test('the verdict: any ok, else any no, else down', () => {
  assert.equal(loginVerdict(['ok', 'no']), 'ok');
  assert.equal(loginVerdict(['down', 'ok']), 'ok');
  assert.equal(loginVerdict(['no', 'down']), 'no');
  assert.equal(loginVerdict(['down', 'down']), 'down');
  assert.equal(loginVerdict([]), 'down');
});

test('the boot\'s decision table', () => {
  assert.equal(loginStart(FAKE, 'ok'), 'go', 'held and accepted');
  assert.equal(loginStart(FAKE, 'no'), 'ask', 'held and refused');
  assert.equal(loginStart('', 'ok'), 'ask', 'none held');
  assert.equal(loginStart(FAKE, 'down'), 'go', 'relays unreachable, one held: opens offline');
  assert.equal(loginStart('', 'down'), 'ask', 'relays unreachable, none held');
});

// A stand-in fetch: each URL answers a status, throws (unreachable), or
// never answers until the check's timeout aborts it.
function relays(map) {
  const seen = [];
  const fetchFn = (url, init) => {
    seen.push([url, init.method, init.body]);
    const a = map[url];
    if (a === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    if (a === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    return new Promise(r => setTimeout(() => r({ status: a }), a === 200 ? 5 : 1));
  };
  return { fetchFn, seen };
}
const [CLOUD, LOCAL] = authUrls('?presentation');

test('the check: either relay accepting is enough', async () => {
  let r = relays({ [CLOUD]: 200, [LOCAL]: 'throw' });
  assert.equal(await checkPassword(FAKE, [CLOUD, LOCAL], r.fetchFn), 'ok');
  assert.deepEqual(r.seen[0], [CLOUD, 'POST', FAKE], 'the password goes as the POST body');
  r = relays({ [CLOUD]: 403, [LOCAL]: 200 });
  assert.equal(await checkPassword(FAKE, [CLOUD, LOCAL], r.fetchFn), 'ok', 'the local relay alone (no internet)');
});

test('the check: a refusal with no acceptance is no', async () => {
  const r = relays({ [CLOUD]: 403, [LOCAL]: 'throw' });
  assert.equal(await checkPassword(FAKE, [CLOUD, LOCAL], r.fetchFn), 'no');
});

test('the check: nothing answering is down, never a refusal', async () => {
  let r = relays({ [CLOUD]: 'throw', [LOCAL]: 'throw' });
  assert.equal(await checkPassword(FAKE, [CLOUD, LOCAL], r.fetchFn), 'down');
  r = relays({ [CLOUD]: 'hang', [LOCAL]: 'throw' });
  assert.equal(await checkPassword(FAKE, [CLOUD, LOCAL], r.fetchFn, 30), 'down', 'a relay that never answers times out');
  r = relays({ [CLOUD]: 503, [LOCAL]: 'throw' });
  assert.equal(await checkPassword(FAKE, [CLOUD, LOCAL], r.fetchFn), 'down', 'a server error is no answer');
});
