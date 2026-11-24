// The presentation's livestream broadcast (core/broadcast.js), driven
// through stand-in sockets with no relay: a session with watchers never
// dozes; the page's room for words, swings and drawing is its livestream
// session's, wherever that sits in the list; every state carries the slide
// video's place at its own `at`; the course changing, or a seek, sends a
// fresh state; and a follower lands a late join on the room's place once,
// with no later correction. The key is a made-up stand-in.
//
//   node --test tools/broadcast-livestream.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// the stand-ins for a browser (as tools/presentation-gate.test.mjs)
const noop = () => {};
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
const ls = new Map();
globalThis.localStorage ??= { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k), key: () => null, length: 0 };
globalThis.window ??= globalThis; globalThis.addEventListener ??= noop; globalThis.removeEventListener ??= noop; globalThis.dispatchEvent ??= () => true;
globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop });
globalThis.document ??= any; globalThis.requestAnimationFrame ??= noop;
globalThis.location ??= { search: '', hostname: 'localhost', href: 'http://localhost/' };
for (const k of ['AudioContext', 'Worker', 'BroadcastChannel', 'ResizeObserver', 'Image', 'Audio', 'OffscreenCanvas', 'MessageChannel', 'AudioWorkletNode', 'GainNode', 'OscillatorNode', 'MediaStream', 'IntersectionObserver', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'CustomEvent', 'FontFace', 'screen', 'visualViewport']) globalThis[k] ??= any;
// the module's standing timers must not hold the test open
const realInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const t = realInterval(fn, ms); if (t && t.unref) t.unref(); return t; };

await import('../core/schema.js');
const { initStore } = await import('../core/store.js');
const mem = new Map();
initStore({ get: k => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v) });
const B = await import('../core/broadcast.js');

const KEY = 'not-the-real-key';
const wait = ms => new Promise(r => setTimeout(r, ms));

test('the doze: a watched session never dozes, an unwatched open one does', () => {
  const sock = {};
  assert.equal(B.sessionDozes({ status: 'live', sock, watchers: 0 }), true);
  assert.equal(B.sessionDozes({ status: 'live', sock, watchers: 3 }), false);
  assert.equal(B.sessionDozes({ status: 'wait', sock, watchers: 0 }), false, 'not connected');
  assert.equal(B.sessionDozes({ status: 'live', sock: null, watchers: 0 }), false, 'no socket');
  assert.equal(B.sessionDozes(null), false);
});

// The broadcaster: sockets that record what they are sent and let the test
// play the relay.
const opened = [];
let clock = 1000, slide = null, drawRooms = [];
B.initBroadcast(
  { intent: null, followUrl: r => '?follow=' + r,
    open: (room, role, key, h) => { const s = { room, role, key, h, sent: [], send(d) { this.sent.push(d); }, close() { this.closed = true; } }; opened.push(s); return s; } },
  { now: () => clock, isRunning: () => false, setRunning: noop, notify: noop, copy: noop,
    drawRoom: want => drawRooms.push(want ? want.room : ''),
    slideNow: () => slide ? Object.assign({}, slide) : null }
);
const states = s => s.sent.filter(d => typeof d === 'string' && d.startsWith('{"t":"state"')).map(d => JSON.parse(d));
const sockFor = room => opened.filter(s => s.room === room && s.role === 'broadcast' && !s.closed).pop();

test('the page\'s room is its livestream session\'s, wherever it sits', async () => {
  // Robert's own session, on and first in the list
  B.broadcastSetKey(KEY);
  const i = B.broadcastAdd('win');
  B.broadcastToggle(i);
  assert.equal(drawRooms[drawRooms.length - 1], 'win', 'alone, the first that is on');
  assert.equal(B.broadcastGoLive('livestream', KEY), true);
  assert.equal(drawRooms[drawRooms.length - 1], 'livestream', 'the livestream room, though second');
  assert.equal(B.broadcastName(0), 'win', 'the list untouched');
  assert.equal(B.broadcastActive(0), true, 'and win still on');
  assert.equal(B.broadcastName(1), 'Livestream');
  assert.equal(B.broadcastActive(1), true);
  assert.equal(sockFor('livestream').key, KEY);
});

test('every state carries the slide\'s place, stamped on the room clock', async () => {
  const s = sockFor('livestream');
  slide = { t: 42, d: 300, r: 1, f: 'a.mp4', l: false };
  s.h.onStatus('open');
  // settle the room clock: the room's time is this screen's + 5000
  s.h.onMessage(JSON.stringify({ t: 'time', c: clock, s: clock + 5000 }));
  s.h.onMessage(JSON.stringify({ t: 'count', n: 1 }));   // a watcher: the state goes at once
  const st = states(s).pop();
  assert.ok(st, 'a state went');
  assert.deepEqual(st.sp, { f: 'a.mp4', t: 42, d: 300, r: 1, l: false });
  assert.equal(st.at, clock + 5000, 'sampled at the same moment as at');
});

test('the course changing sends a fresh state; the same course does not', async () => {
  const s = sockFor('livestream');
  const n0 = states(s).length;
  clock += 2000; slide = { t: 44, d: 300, r: 1, f: 'a.mp4', l: false };
  await wait(2300);   // one beacon tick: same course, nothing owed
  assert.equal(states(s).length, n0, 'played on: no state');
  slide = { t: 44, d: 300, r: 0, f: 'a.mp4', l: false };   // held live, no setting moved
  await wait(2600);   // the tick, then the send's own short delay
  assert.equal(states(s).length, n0 + 1, 'paused: a state');
  assert.equal(states(s).pop().sp.r, 0);
  // a Restart saves nothing and keeps the course: the jump itself owes a state
  slide = { t: 0, d: 300, r: 0, f: 'a.mp4', l: false };
  await wait(2600);
  assert.equal(states(s).length, n0 + 2, 'a jump: a state');
  assert.equal(states(s).pop().sp.t, 0);
});

test('a seek sends a state, so the relay\'s kept copy has the new place', async () => {
  const s = sockFor('livestream');
  const n0 = states(s).length;
  slide = { t: 150, d: 300, r: 0, f: 'a.mp4', l: false };
  B.broadcastSeek(0.5, 'a.mp4');
  await wait(400);
  assert.ok(s.sent.some(d => typeof d === 'string' && d.includes('"sk"')), 'the seek itself went');
  assert.equal(states(s).length, n0 + 1, 'and a state after it');
  assert.equal(states(s).pop().sp.t, 150);
});

// The follower: a second copy of the module (its own state), following the
// room, with a stand-in for its own slide voice.
const F = await import('../core/broadcast.js?follower');
let fclock = 50000;
const own = { t: 0, d: 300, r: 1, f: 'a.mp4', l: false, ready: true };
let ownOk = true;
const seeks = [];
let fsock = null;
F.initBroadcast(
  { intent: { follow: 'livestream' }, followUrl: r => r,
    open: (room, role, key, h) => { fsock = { h, send() {}, close() {} }; return fsock; } },
  { now: () => fclock, isRunning: () => false, setRunning: noop, notify: noop, copy: noop, drawRoom: noop,
    slideInto: out => { if (!ownOk) return false; Object.assign(out, own); return true; },
    seekSlideTo: (f, file) => { seeks.push([f, file]); } }
);
// this screen's clock + 9000 is the room's
fsock.h.onMessage(JSON.stringify({ t: 'time', c: fclock, s: fclock + 9000 }));
const roomNow = () => fclock + 9000;

test('a late joiner lands where the room is, after the tap, once', () => {
  F.holdFollowJoin();
  // the relay's kept state: made three minutes ago, the slide 42 s in then
  fsock.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {}, at: roomNow() - 180000,
    sp: { f: 'a.mp4', t: 42, d: 300, r: 1, l: false } }));
  F.followSlideLand();
  assert.equal(seeks.length, 0, 'nothing before the join tap');
  F.followJoin();
  // its own copy still loading: nothing yet
  ownOk = false; F.followSlideLand(); assert.equal(seeks.length, 0, 'waits for its own copy');
  ownOk = true; own.t = 0; own.ready = false;
  F.followSlideLand();
  assert.equal(seeks.length, 1, 'seeks once its copy knows its length');
  assert.equal(seeks[0][1], 'a.mp4');
  assert.ok(Math.abs(seeks[0][0] * 300 - 222) < 1e-6, 'to 42 + 180 = 222 s: ' + seeks[0][0] * 300);
  // the seek's voice still loading: no second look yet
  F.followSlideLand(); assert.equal(seeks.length, 1);
  // it plays, but came in 0.8 s behind (its load): one last seek, that far ahead
  fclock += 2000; own.t = 222 + 2 - 0.8; own.ready = true;
  F.followSlideLand();
  assert.equal(seeks.length, 2, 'a second and last seek');
  // the room is at 224 now; the reload will come in 0.8 s late again, so 224.8
  assert.ok(Math.abs(seeks[1][0] * 300 - (224 + 0.8)) < 1e-6, 'ahead by the lag: ' + seeks[1][0] * 300);
  // and never again, however far it drifts
  fclock += 5000; own.t = 10;
  F.followSlideLand(); F.followSlideLand();
  assert.equal(seeks.length, 2, 'no correction after landing');
  // a reconnect's re-seed does not move a viewer who has landed
  fsock.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {}, at: roomNow(), sp: { f: 'a.mp4', t: 200, d: 300, r: 1, l: false } }));
  F.followSlideLand();
  assert.equal(seeks.length, 2, 'a later state moves nothing');
});

test('a joiner already there, or a room with no slide, is never moved', async () => {
  for (const [name, sp, ownT] of [['no slide in the room', undefined, 0], ['already within the tolerance', { f: 'a.mp4', t: 10, d: 300, r: 1, l: false }, 10.1]]) {
    const G = await import('../core/broadcast.js?' + encodeURIComponent(name));
    const moved = [];
    let gs = null;
    const t0 = 1000;
    G.initBroadcast(
      { intent: { follow: 'livestream' }, followUrl: r => r, open: (room, role, key, h) => { gs = { h, send() {}, close() {} }; return gs; } },
      { now: () => t0, isRunning: () => false, setRunning: noop, notify: noop, copy: noop, drawRoom: noop,
        slideInto: out => { Object.assign(out, { t: ownT, d: 300, r: 1, f: 'a.mp4', l: false, ready: true }); return true; },
        seekSlideTo: f => moved.push(f) }
    );
    gs.h.onMessage(JSON.stringify({ t: 'time', c: t0, s: t0 }));
    gs.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {}, at: t0, sp }));
    G.followSlideLand(); G.followSlideLand();
    assert.deepEqual(moved, [], name);
  }
});
