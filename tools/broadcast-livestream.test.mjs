// The presentation's livestream broadcast (core/broadcast.js), driven
// through stand-in sockets with no relay: a session with watchers never
// dozes; the page's room for words, swings and drawing is its livestream
// session's, wherever that sits in the list; every state carries the slide
// video's place at its own `at`; the course changing, or a seek, sends a
// fresh state; a follower lands a late join on the room's place once, with
// no later correction while the course stays the same; a follower watching
// is moved once more on each pause, resume, rate, restart or seek, and
// holds or plays as the room; the show remote's duck and screen gate ride
// the state and the filters the snapshot, to watchers and late joiners
// alike. The key is a made-up stand-in.
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
  // a reconnect's re-seed does not move a viewer who has landed: the same
  // course, so the room's slide is where the first state's course puts it
  // (42 s in, 187 s since)
  fsock.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {}, at: roomNow(), sp: { f: 'a.mp4', t: 229, d: 300, r: 1, l: false } }));
  F.followSlideLand();
  assert.equal(seeks.length, 2, 'a later state on the same course moves nothing');
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

// ---------- what the iPad does, on every viewer ----------
// The show remote's duck and screen gate ride the state beside the snapshot;
// the filters ride the snapshot itself; a follower already watching is moved
// again on each change of the room's slide's course, once, and holds or
// plays its slide as the room's does.
const { S } = await import('../js/state.js');
const { byId } = await import('../core/schema.js');
const { createGlobalFilter, notifyGlobalFilter } = await import('../core/global-filter.js');

test('the duck and the screen gate ride the state, for watchers and late joiners alike', async () => {
  const s = sockFor('livestream');
  let n0 = states(s).length;
  assert.equal(states(s).pop().dk, undefined, 'no duck yet, none sent');
  B.broadcastDuck(0.3, 1.5);
  await wait(400);
  assert.equal(states(s).length, n0 + 1, 'the duck sent a state');
  assert.deepEqual(states(s).pop().dk, [0.3, 1.5], 'down to 0.3 over 1.5 s');
  B.broadcastDuck(1, 2);
  await wait(400);
  assert.deepEqual(states(s).pop().dk, [1, 2], 'and back up over 2 s');
  // the gate: live only, saved nowhere, so the receiver pokes
  n0 = states(s).length;
  S.screenGate = 0.2;
  B.broadcastPoke();
  await wait(400);
  assert.equal(states(s).length, n0 + 1);
  assert.equal(states(s).pop().gt, 0.2, 'the gate, below full');
  S.screenGate = 1;
  B.broadcastPoke();
  await wait(400);
  assert.equal(states(s).pop().gt, undefined, 'full: none sent');
});

test('the filters ride the snapshot', async () => {
  const s = sockFor('livestream');
  const n0 = states(s).length;
  byId('lpf').set(S, 500);
  byId('lpfRes').set(S, 6);
  byId('filterGlide').set(S, 120);
  await wait(400);
  assert.equal(states(s).length, n0 + 1, 'one state for the three');
  const snap = states(s).pop().snap;
  assert.equal(snap.lpfHz, S.lpfHz, 'the lowpass corner');
  assert.ok(S.lpfHz < 20000, 'closed: ' + S.lpfHz);
  assert.equal(snap.lpfRes, 6, 'its resonance');
  assert.equal(snap.filterGlideMs, 120, 'and its glide');
  byId('lpf').set(S, 1000); byId('lpfRes').set(S, 0); byId('filterGlide').set(S, 25);
  await wait(400);
});

// A follower that has been watching: its own copy of the module, with a
// stand-in slide voice, a record of its seeks, its play or hold and its duck.
function watcher(name, t0) {
  const W = { clock: t0, own: { t: 0, d: 300, r: 1, f: 'a.mp4', l: false, ready: true }, seeks: [], follows: [], ducks: [], sk: [], sock: null };
  return import('../core/broadcast.js?' + name).then(M => {
    W.M = M;
    M.initBroadcast(
      { intent: { follow: 'livestream' }, followUrl: r => r, open: (room, role, key, h) => { W.sock = { h, send() {}, close() {} }; return W.sock; } },
      { now: () => W.clock, isRunning: () => false, setRunning: noop, notify: noop, copy: noop, drawRoom: noop,
        slideInto: out => { Object.assign(out, W.own); return true; },
        // a seek's voice is not ready until it has loaded (gpu/slides.js)
        seekSlideTo: (f, file) => { W.seeks.push(f * 300); W.own.ready = false; },
        seekSlide: (f, file) => W.sk.push([f, file]),
        slideFollow: (file, play) => W.follows.push([file, play]),
        duck: (mul, sec) => W.ducks.push([mul, sec]) });
    // the room's clock is this screen's + 1000
    W.room = () => W.clock + 1000;
    W.sock.h.onMessage(JSON.stringify({ t: 'time', c: W.clock, s: W.clock + 1000 }));
    // a state sampled `ago` ms before it arrives
    W.state = (sp, extra, ago = 0) => W.sock.h.onMessage(JSON.stringify(Object.assign({ t: 'state', run: false, snap: {}, at: W.room() - ago, sp }, extra)));
    W.land = () => { M.followSlideLand(); M.followSlideLand(); };
    return W;
  });
}
const at = (t, o) => Object.assign({ f: 'a.mp4', t, d: 300, r: 1, l: false }, o);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg + ': ' + a + ' vs ' + b);

test('pause, resume, rate, restart, seek: each moves a watching follower once, to the laptop\'s place', async () => {
  const W = await watcher('course', 70000);
  // watching already, in step with the room
  W.own.t = 50; W.state(at(50)); W.land();
  assert.deepEqual(W.seeks, [], 'in step: nothing');
  assert.deepEqual(W.follows.pop(), ['a.mp4', true], 'plays as the room');
  W.clock += 5000; W.own.t = 55.1; W.state(at(55)); W.land();
  assert.deepEqual(W.seeks, [], 'the same course: nothing');

  // PAUSE: the laptop held at 56, the state reaching here 0.4 s later with
  // this copy run on past it
  W.clock += 1000; W.own.t = 56.6; W.state(at(56, { r: 0 }), null, 400); W.land();
  assert.equal(W.seeks.length, 1, 'a pause moves it once');
  near(W.seeks[0], 56, 'to where the laptop paused');
  assert.deepEqual(W.follows.pop(), ['a.mp4', false], 'and holds it');
  W.own.t = 56; W.own.r = 0;
  W.clock += 30000; W.own.t = 55; W.state(at(56, { r: 0 })); W.land();
  assert.equal(W.seeks.length, 1, 'held on: never again, however it has drifted');

  // RESUME: the laptop played on from 56 0.6 s before the state arrives
  W.own.t = 56; W.own.r = 1; W.own.ready = false;
  W.clock += 10000; W.state(at(56), null, 600); W.land();
  assert.equal(W.seeks.length, 2, 'a resume moves it');
  near(W.seeks[1], 56.6, 'to where the laptop has got to');
  assert.deepEqual(W.follows.pop(), ['a.mp4', true], 'and plays it');
  // its seek's voice came in 0.5 s late: the one second look, that far ahead
  W.clock += 1000; W.own.t = 57.1; W.own.ready = true; W.land();
  assert.equal(W.seeks.length, 3, 'the second and last look');
  near(W.seeks[2], 57.6 + 0.5, 'ahead by the lag');
  W.clock += 5000; W.own.t = 40; W.state(at(62.6), null, 0); W.land();
  assert.equal(W.seeks.length, 3, 'playing on: never again');

  // RATE: half speed from 63, this copy 0.5 s off
  W.clock += 1000; W.own.t = 63.5; W.state(at(63, { r: 0.5 })); W.land();
  assert.equal(W.seeks.length, 4, 'a new rate moves it');
  near(W.seeks[3], 63, 'to the laptop\'s place');
  W.own.t = 63; W.own.ready = true; W.land();
  assert.equal(W.seeks.length, 4, 'landed');
  W.clock += 4000; W.own.t = 10; W.state(at(65, { r: 0.5 })); W.land();
  assert.equal(W.seeks.length, 4, 'the same rate on: nothing');

  // RESTART: back to the top, the room 0.3 s in when the state left
  W.clock += 1000; W.state(at(0.3, { r: 0.5 })); W.land();
  assert.equal(W.seeks.length, 5, 'a restart moves it');
  near(W.seeks[4], 0.3, 'to the top');
  W.own.t = 0.3; W.own.ready = true; W.land();
  W.clock += 2000; W.own.t = 20; W.state(at(1.3, { r: 0.5 })); W.land();
  assert.equal(W.seeks.length, 5, 'on from the top: nothing');

  // SEEK: the iPad's tap goes as its own message at once, then the state
  // with the new place; this copy, already there, is not moved again
  W.sock.h.onMessage(JSON.stringify({ t: 'phase', sk: { f: 0.5, file: 'a.mp4' } }));
  assert.deepEqual(W.sk, [[0.5, 'a.mp4']], 'the seek itself');
  W.own.t = 150.1; W.clock += 1000; W.state(at(150, { r: 0.5 })); W.land();
  assert.equal(W.seeks.length, 5, 'already where the seek put it');
  // one whose seek fell behind is moved to the room's place, once
  W.sock.h.onMessage(JSON.stringify({ t: 'phase', sk: { f: 0.6, file: 'a.mp4' } }));
  W.own.t = 170; W.clock += 1000; W.state(at(180, { r: 0.5 })); W.land();
  assert.equal(W.seeks.length, 6, 'a seek that fell behind is landed');
  near(W.seeks[5], 180, 'on the room\'s place');
  W.own.t = 180; W.own.ready = true; W.land();
  W.clock += 2000; W.own.t = 100; W.state(at(181, { r: 0.5 })); W.land();
  assert.equal(W.seeks.length, 6, 'then left alone');

  // a new slide that plays starts with everyone's and is not moved
  W.own.f = 'b.mp4'; W.own.t = 0; W.own.r = 1;
  W.clock += 1000; W.state(at(0.6, { f: 'b.mp4' })); W.land();
  assert.equal(W.seeks.length, 6, 'a new slide: nothing');
  assert.deepEqual(W.follows.pop(), ['b.mp4', true]);
  // one that has played to its end is not held: this copy runs out too
  W.clock += 299000; W.own.t = 299.6; W.state(at(300, { f: 'b.mp4', r: 0 })); W.land();
  assert.equal(W.seeks.length, 6, 'an end: nothing');
  assert.deepEqual(W.follows.pop(), ['b.mp4', true], 'not held');
  // no slide in the room: let go
  W.state(undefined);
  assert.deepEqual(W.follows.pop(), ['', true], 'let go');
});

test('a follower ducks with the room, and a late joiner during a duck gets it', async () => {
  const W = await watcher('duck', 1000);
  W.state(undefined);
  assert.deepEqual(W.ducks, [], 'no duck sent: nothing');
  W.state(undefined, { dk: [0.3, 1.5] });
  assert.deepEqual(W.ducks, [[0.3, 1.5]], 'down, as the laptop');
  W.state(undefined, { dk: [0.3, 1.5] }); W.state(undefined, { dk: [0.3, 1.5] });
  assert.equal(W.ducks.length, 1, 'later states leave it on its way');
  W.state(undefined, { dk: [1, 2] });
  assert.deepEqual(W.ducks.pop(), [1, 2], 'and back up, over its own seconds');
  // a late joiner: the relay's kept state, made while the duck is down
  const L = await watcher('duck-late', 1000);
  L.state(undefined, { dk: [0.25, 0.8] });
  assert.deepEqual(L.ducks, [[0.25, 0.8]], 'joins ducked');
  // the room ends: nobody is left ducked, black or holding a slide
  S.screenGate = 0.4;
  L.sock.h.onMessage('{"t":"end"}');
  assert.deepEqual(L.ducks.pop(), [1, undefined], 'unducked');
  assert.equal(S.screenGate, 1, 'the gate open');
  assert.deepEqual(L.follows.pop(), ['', true], 'the slide let go');
});

test('a follower takes the gate, and a late joiner the filters', async () => {
  const W = await watcher('gate', 1000);
  W.state(undefined, { gt: 0.2 });
  assert.equal(S.screenGate, 0.2, 'the room\'s gate');
  W.state(undefined);
  assert.equal(S.screenGate, 1, 'none sent: full');
  // the relay's kept state carries the filters in its snapshot
  const L = await watcher('filters', 1000);
  S.lpfHz = 20000; S.hpfHz = 20; S.lpfRes = 0; S.filterGlideMs = 25;
  L.state(undefined, { snap: { lpfHz: 800, hpfHz: 60, lpfRes: 6, hpfRes: 3, filterGlideMs: 120 } });
  assert.equal(S.lpfHz, 800); assert.equal(S.hpfHz, 60);
  assert.equal(S.lpfRes, 6); assert.equal(S.hpfRes, 3);
  assert.equal(S.filterGlideMs, 120);
  // and glides no faster than a send window's third (a follower set the
  // floor), whatever Filter interpolation says; slower stays its own
  const calls = [];
  const param = () => ({ value: 0, setTargetAtTime(v, t, tc) { calls.push(tc); }, cancelScheduledValues() {}, setValueAtTime() { calls.push(0); } });
  createGlobalFilter({ currentTime: 0, createBiquadFilter: () => ({ frequency: param(), Q: param(), connect() {} }) });
  S.filterGlideMs = 0; calls.length = 0; notifyGlobalFilter();
  assert.ok(calls.length && calls.every(tc => Math.abs(tc - 0.25 / 3) < 1e-9), 'a jump glides on the floor: ' + calls);
  S.filterGlideMs = 120; calls.length = 0; notifyGlobalFilter();
  assert.ok(calls.every(tc => Math.abs(tc - 0.12) < 1e-9), 'a slower glide its own: ' + calls);
  S.lpfHz = 20000; S.hpfHz = 20; S.lpfRes = 0; S.hpfRes = 0; S.filterGlideMs = 25;
});
