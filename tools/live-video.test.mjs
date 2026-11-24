// Live Video (core/camera.js, ui/camera-fit.js, core/schema-camera.js): the
// size's clamp; the panel's fit at phone, laptop and projector sizes, bottom
// right above the chrome's bottom row, with the camera's shape kept and the
// bottom row, the volume and the open drawer cleared; a hand on the panel's
// top left corner turned back into a size; the record of its own; that
// neither the switch nor the size ever lands in a preset snapshot or a
// Journey step, or is moved by a recall; and the switch and size riding the
// broadcast's state message (`cv`) out from a broadcaster and back into a
// follower, which shows them without touching its own.
//
//   node --test tools/live-video.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// the stand-ins for a browser (as tools/broadcast-livestream.test.mjs)
const noop = () => {};
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
const ls = new Map();
globalThis.localStorage ??= { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k), key: () => null, length: 0 };
globalThis.window ??= globalThis; globalThis.addEventListener ??= noop; globalThis.removeEventListener ??= noop; globalThis.dispatchEvent ??= () => true;
globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop });
globalThis.document ??= any; globalThis.requestAnimationFrame ??= noop;
globalThis.location ??= { search: '', hostname: 'localhost', href: 'http://localhost/' };
for (const k of ['AudioContext', 'Worker', 'BroadcastChannel', 'ResizeObserver', 'Image', 'Audio', 'OffscreenCanvas', 'MessageChannel', 'AudioWorkletNode', 'GainNode', 'OscillatorNode', 'MediaStream', 'IntersectionObserver', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'CustomEvent', 'FontFace', 'screen', 'visualViewport']) globalThis[k] ??= any;
// the modules' standing timers must not hold the test open
const realInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const t = realInterval(fn, ms); if (t && t.unref) t.unref(); return t; };

const { S } = await import('../js/state.js');
const { byId, SECTIONS } = await import('../core/schema.js');
const ST = await import('../core/store.js');
const mem = new Map();
ST.initStore({ get: k => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v) });
ST.load();
const C = await import('../core/camera.js');
const { camFit, camSizeForHand } = await import('../ui/camera-fit.js');
const { LAYOUT, SPACE } = await import('../ui/theme.js');
const P = await import('../core/presets.js');
const J = await import('../core/journey.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
const EDGE = LAYOUT.chromeInset, GAP = SPACE.sm;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
C.loadCam();

test('the size is held to 10% to 60%, a bad value is the default', () => {
  assert.equal(C.camSizeClamp(0.25), 0.25);
  assert.equal(C.camSizeClamp(0.01), C.CAM_SIZE_MIN);
  assert.equal(C.camSizeClamp(7), C.CAM_SIZE_MAX);
  for (const bad of [NaN, Infinity, -Infinity, '0.3', null, undefined, {}]) assert.equal(C.camSizeClamp(bad), C.CAM_SIZE_DEF, String(bad));
  assert.equal(C.camSizeClamp(0.33333), 0.333, 'three decimals, as the wire carries');
  assert.equal(C.CAM_SIZE_MIN, 0.1); assert.equal(C.CAM_SIZE_MAX, 0.6); assert.equal(C.CAM_SIZE_DEF, 0.25);
});

// The bottom row: the full-screen button (and the quick-bar chips, elsewhere
// than the livestream screen), a chip tall at the inset from the bottom.
const rowTop = vh => vh - EDGE - LAYOUT.chipH;
// The top row: the burger at the top left, the volume cluster at the top
// right; the burger's is the taller.
const topRowBottom = EDGE + LAYOUT.burger;

test('the fit on a laptop: a quarter of the height, the camera\'s shape, bottom right above the row', () => {
  const r = {};
  assert.equal(camFit(r, 0.25, 16 / 9, 1440, 900, 0), true);
  assert.ok(near(r.h, 225)); assert.ok(near(r.w, 400));
  assert.ok(near(r.x + r.w, 1440 - EDGE), 'right edge on the full-screen button\'s');
  assert.ok(near(r.y + r.h, rowTop(900) - GAP), 'a chip gap above the bottom row');
  assert.ok(near(r.x, 1440 - EDGE - 400)); assert.ok(near(r.y, 900 - EDGE - LAYOUT.chipH - GAP - 225));
  // the same share on a projector and a 4K screen: the same look
  camFit(r, 0.25, 16 / 9, 1920, 1080, 0); assert.ok(near(r.h, 270));
  camFit(r, 0.25, 16 / 9, 3840, 2160, 0); assert.ok(near(r.h / 2160, 0.25));
  // the open drawer, on the far side of a laptop, changes nothing
  camFit(r, 0.25, 16 / 9, 1440, 900, LAYOUT.drawerW);
  assert.ok(near(r.h, 225)); assert.ok(near(r.x + r.w, 1440 - EDGE));
  camFit(r, C.CAM_SIZE_MAX, 16 / 9, 1440, 900, LAYOUT.drawerW);
  assert.ok(near(r.h, 540), 'even at its largest: ' + r.h);
});

test('the fit on an upright phone is a share of its width, not its height', () => {
  const r = {};
  assert.equal(camFit(r, 0.25, 16 / 9, 390, 844, 0), true);
  assert.ok(near(r.h, 97.5), 'a quarter of the 390 px width: ' + r.h);
  assert.ok(near(r.w / r.h, 16 / 9));
  assert.ok(near(r.x + r.w, 390 - EDGE)); assert.ok(near(r.y + r.h, rowTop(844) - GAP));
});

test('a narrow window: the panel shrinks to keep clear of the open drawer\'s edge', () => {
  const r = {};
  camFit(r, C.CAM_SIZE_MAX, 16 / 9, 800, 600, 0);
  const wide = r.w;
  assert.ok(near(r.h, 360));
  camFit(r, C.CAM_SIZE_MAX, 16 / 9, 800, 600, LAYOUT.drawerW);
  assert.ok(r.w < wide, 'smaller beside the drawer');
  assert.ok(near(r.x, LAYOUT.drawerW + EDGE), 'its left edge the inset from the drawer\'s');
  assert.ok(near(r.w / r.h, 16 / 9), 'its shape kept');
  assert.ok(near(r.x + r.w, 800 - EDGE), 'still on the right');
});

test('at every size, screen and camera shape: the shape kept, the rows, volume and drawer clear', () => {
  const screens = [[1440, 900], [1920, 1080], [3840, 2160], [1280, 800], [800, 600], [390, 844], [844, 390], [360, 640], [768, 1024], [1024, 768], [320, 568], [568, 320]];
  const shapes = [16 / 9, 4 / 3, 1, 9 / 16, 3 / 4];
  const sizes = [C.CAM_SIZE_MIN, 0.2, C.CAM_SIZE_DEF, 0.4, C.CAM_SIZE_MAX];
  const r = {};
  for (const [vw, vh] of screens) for (const a of shapes) for (const f of sizes) for (const left of [0, LAYOUT.drawerW]) {
    const tag = vw + 'x' + vh + ' a' + a.toFixed(2) + ' f' + f + ' left' + left;
    if (!camFit(r, f, a, vw, vh, left)) {
      assert.equal(r.w, 0, tag); assert.equal(r.h, 0, tag);
      continue;
    }
    assert.ok(near(r.w / r.h, a, 1e-9), 'shape kept ' + tag);
    assert.ok(r.h <= f * Math.min(vw, vh) + 1e-9, 'never past its share ' + tag);
    assert.ok(r.h >= LAYOUT.chipH, 'at least a chip tall ' + tag);
    // its right edge on the full-screen button's, its bottom a gap above the row
    assert.ok(near(r.x + r.w, vw - EDGE), 'right edge lined up ' + tag);
    assert.ok(near(r.y + r.h, rowTop(vh) - GAP), 'above the bottom row ' + tag);
    // the volume cluster and the burger: the whole top row, by a gap
    assert.ok(r.y >= topRowBottom + GAP - 1e-9, 'clear of the volume and the burger ' + tag);
    // the open drawer's edge, by the inset
    assert.ok(r.x >= left + EDGE - 1e-9, 'clear of the drawer ' + tag);
  }
  // with room to spare, it is exactly its share
  camFit(r, 0.4, 4 / 3, 1920, 1080, 0);
  assert.ok(near(r.h, 432));
});

test('a screen with no room shows no panel; an unknown shape is a laptop camera\'s', () => {
  const r = {};
  assert.equal(camFit(r, 0.6, 16 / 9, 80, 160, 0), false);
  assert.equal(r.w, 0);
  // the drawer filling a phone leaves no room beside it
  assert.equal(camFit(r, 0.25, 16 / 9, 390, 844, LAYOUT.drawerW), false);
  for (const a of [0, NaN, -1, undefined]) {
    camFit(r, 0.25, a, 1440, 900, 0);
    assert.ok(near(r.w / r.h, 16 / 9), String(a));
  }
});

test('a hand on the top left corner: up and left grows it, held to what fits', () => {
  // the corner where it is gives back the size it is at
  const r = {};
  for (const f of [0.1, 0.25, 0.5]) {
    camFit(r, f, 16 / 9, 1440, 900, 0);
    assert.ok(near(camSizeForHand(r.x, r.y, 16 / 9, 1440, 900, 0), f, 0.001), 'round trip ' + f);
  }
  camFit(r, 0.25, 16 / 9, 1440, 900, 0);
  const base = camSizeForHand(r.x, r.y, 16 / 9, 1440, 900, 0);
  // up alone, or left alone, both grow it; down and right both shrink it
  assert.ok(camSizeForHand(r.x, r.y - 60, 16 / 9, 1440, 900, 0) > base, 'up');
  assert.ok(camSizeForHand(r.x - 100, r.y, 16 / 9, 1440, 900, 0) > base, 'left');
  assert.ok(camSizeForHand(r.x - 100, r.y - 60, 16 / 9, 1440, 900, 0) > base, 'up and left');
  assert.ok(camSizeForHand(r.x, r.y + 60, 16 / 9, 1440, 900, 0) < base, 'down');
  assert.ok(camSizeForHand(r.x + 100, r.y, 16 / 9, 1440, 900, 0) < base, 'right');
  // far past the top left: the slider's top on a laptop
  assert.equal(camSizeForHand(-9999, -9999, 16 / 9, 1440, 900, 0), C.CAM_SIZE_MAX);
  // on an upright phone only what the width allows, never more than the panel shows
  const ph = camSizeForHand(-9999, -9999, 16 / 9, 390, 844, 0);
  camFit(r, ph, 16 / 9, 390, 844, 0);
  assert.ok(near(r.h, ph * 390, 0.5), 'the panel shows the size the slider says: ' + ph);
  assert.ok(ph < C.CAM_SIZE_MAX);
  // beside the drawer on a narrow window, only what clears it
  const nd = camSizeForHand(-9999, -9999, 16 / 9, 800, 600, LAYOUT.drawerW);
  camFit(r, nd, 16 / 9, 800, 600, LAYOUT.drawerW);
  assert.ok(near(r.h, nd * 600, 0.5), 'the drawer\'s bound: ' + nd);
  // dragged past its own fixed corner: the bottom of the range
  assert.equal(camSizeForHand(1500, 950, 16 / 9, 1440, 900, 0), C.CAM_SIZE_MIN);
});

test('the drawer\'s Live Video section: On, Camera, Size; a slider formats by position', () => {
  const sec = SECTIONS.find(s => s.id === 'camera');
  assert.ok(sec, 'the section is in the schema');
  assert.equal(sec.title, 'Live Video');
  assert.equal(sec.visible(S), false, 'hidden where no camera can be opened (a test, the worker)');
  const on = byId('camOn'), dev = byId('camDevice'), size = byId('camSize');
  assert.equal(on.kind, 'toggle'); assert.equal(dev.kind, 'segment'); assert.equal(size.kind, 'slider');
  assert.equal(typeof size.formatAt, 'function'); assert.equal(size.format, undefined, 'formatAt only');
  assert.equal(size.formatAt(25), '25%');
  assert.equal(size.min, 10); assert.equal(size.max, 60); assert.equal(size.def, 25);
  assert.equal(dev.options[0].label, 'Default camera');
});

test('the switch and the size save to their own record and come back', async () => {
  byId('camSize').set(S, 40);
  byId('camOn').set(S, true);
  assert.equal(S.camSize, 0.4); assert.equal(S.camOn, true);
  assert.equal(byId('camSize').get(S), 40);
  await wait(120);   // store.js saveKey's short deferral
  const rec = JSON.parse(mem.get('signal.v1.camera'));
  assert.deepEqual(rec, { camOn: true, camSize: 0.4, camDevice: '' });
  S.camOn = false; S.camSize = 0.1;
  C.loadCam();
  assert.equal(S.camOn, true); assert.equal(S.camSize, 0.4);
  // a damaged record starts off at the default
  mem.set('signal.v1.camera', '{"camOn":"yes","camSize":"big"}');
  C.loadCam();
  assert.equal(S.camOn, false); assert.equal(S.camSize, C.CAM_SIZE_DEF);
  byId('camSize').set(S, 40); byId('camOn').set(S, true);
});

test('never in a preset snapshot, never in a Journey step, never moved by a recall', () => {
  for (const id of ['camOn', 'camDevice', 'camSize']) assert.equal(P.machineControl(byId(id)), true, id + ' is this machine\'s');
  const hasCam = o => Object.keys(o).some(k => /^cam/.test(k)) || (o.v1extra && Object.keys(o.v1extra).some(k => /^cam/.test(k)));
  assert.equal(hasCam(ST.snapshot()), false, 'not in a preset snapshot');
  assert.equal(hasCam(JSON.parse(JSON.stringify(ST.wireSettings()))), false, 'not in the broadcast snapshot');
  // a recall of a snapshot taken with the camera off and small leaves it on and large
  const snap = ST.snapshot();
  snap.camOn = false; snap.camSize = 0.1;
  P.replayLive(() => ST.applySnapshot(snap));
  assert.equal(S.camOn, true); assert.equal(S.camSize, 0.4);
  // a step taken now holds neither, and a step cannot be told to hold one
  const i = J.journeyAddStep();
  assert.ok(i >= 0);
  const st = J.journeyStepAt(i);
  for (const id of ['camOn', 'camDevice', 'camSize']) assert.equal(id in st.overrides, false, id + ' in a step');
  J.journeySetOverride(i, 'camOn', false);
  J.journeySetOverride(i, 'camSize', 10);
  assert.equal('camOn' in st.overrides, false); assert.equal('camSize' in st.overrides, false);
  assert.equal(S.camOn, true); assert.equal(S.camSize, 0.4);
});

// The broadcast: a broadcaster's state carries cv; a follower takes it.
const B = await import('../core/broadcast.js');
const opened = [];
B.initBroadcast(
  { intent: null, followUrl: r => '?follow=' + r,
    open: (room, role, key, h) => { const s = { room, role, key, h, sent: [], send(d) { this.sent.push(d); }, close() { this.closed = true; } }; opened.push(s); return s; } },
  { now: () => 1000, isRunning: () => false, setRunning: noop, notify: noop, copy: noop, drawRoom: noop, slideNow: () => null }
);
const states = s => s.sent.filter(d => typeof d === 'string' && d.startsWith('{"t":"state"')).map(d => JSON.parse(d));

test('the broadcaster sends the switch and the size beside the snapshot', async () => {
  B.broadcastSetKey('not-the-real-key');
  B.broadcastToggle(B.broadcastAdd('cam-test'));
  const s = opened.filter(x => x.room === 'cam-test').pop();
  s.h.onStatus('open');
  s.h.onMessage(JSON.stringify({ t: 'count', n: 1 }));
  let st = states(s).pop();
  assert.ok(st, 'a state went');
  assert.deepEqual(st.cv, { on: 1, sz: 0.4 });
  assert.equal('camOn' in st.snap || 'camSize' in st.snap, false, 'beside it, not in it');
  // a change of either sends a fresh state, with no settings save
  const n0 = states(s).length;
  C.camSetSize(0.3);
  await wait(400);
  assert.equal(states(s).length, n0 + 1, 'the size sent');
  assert.deepEqual(states(s).pop().cv, { on: 1, sz: 0.3 });
  C.camSetOn(false);
  await wait(400);
  assert.deepEqual(states(s).pop().cv, { on: 0, sz: 0.3 });
});

test('a follower shows the broadcaster\'s switch and size, its own untouched', async () => {
  const F = await import('../core/broadcast.js?follower');
  let fs = null;
  F.initBroadcast(
    { intent: { follow: 'cam-test' }, followUrl: r => r, open: (room, role, key, h) => { fs = { h, send() {}, close() {} }; return fs; } },
    { now: () => 1000, isRunning: () => false, setRunning: noop, notify: noop, copy: noop, drawRoom: noop }
  );
  C.setCamRole(C.ROLE_FOLLOW, null);
  const ownOn = S.camOn, ownSize = S.camSize, ownRec = mem.get('signal.v1.camera');
  let heard = 0;
  C.onCamChange(() => heard++);
  fs.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {}, cv: { on: 1, sz: 0.5 } }));
  assert.equal(C.camShownOn(), true); assert.equal(C.camShownSize(), 0.5);
  assert.ok(heard > 0, 'the panel hears it');
  fs.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {}, cv: { on: 1, sz: 99 } }));
  assert.equal(C.camShownSize(), C.CAM_SIZE_MAX, 'held to the range');
  // a broadcaster from before Live Video sends no cv: off, the size kept
  fs.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {} }));
  assert.equal(C.camShownOn(), false); assert.equal(C.camShownSize(), C.CAM_SIZE_MAX);
  fs.h.onMessage(JSON.stringify({ t: 'state', run: false, snap: {}, cv: { on: 1, sz: 0.2 } }));
  assert.equal(C.camShownOn(), true);
  // the broadcast ending takes the panel away
  fs.h.onMessage(JSON.stringify({ t: 'end' }));
  assert.equal(C.camShownOn(), false);
  await wait(120);
  assert.equal(S.camOn, ownOn); assert.equal(S.camSize, ownSize);
  assert.equal(mem.get('signal.v1.camera'), ownRec, 'its own record untouched');
  // a follower never opens a camera, whatever its own switch says
  assert.equal(C.camAvailable(), false);
});

// ---------- the transport: the packet, and the safety rule ----------
const W = await import('../platform/camera-wire.js');
const T = await import('../platform/camera-transport.js');

test('a packet round trips: header, description and frame', () => {
  const data = new Uint8Array([9, 8, 7, 6, 5]), desc = new Uint8Array([1, 2, 3]);
  const buf = W.pack({ key: true, seq: 4000000000, t: 1732400000123.5, width: 640, height: 360, codec: 0, fps: 15 }, data, desc);
  assert.equal(buf.byteLength, W.HEADER + 3 + 5);
  const p = W.unpack(buf);
  assert.equal(p.kind, W.KIND_VIDEO); assert.equal(p.key, true); assert.equal(p.from, 0);
  assert.equal(p.seq, 4000000000); assert.equal(p.t, 1732400000123.5);
  assert.equal(p.width, 640); assert.equal(p.height, 360); assert.equal(p.codec, 0); assert.equal(p.fps, 15);
  assert.deepEqual([...p.desc], [1, 2, 3]); assert.deepEqual([...p.data], [9, 8, 7, 6, 5]);
  // a delta: no description, not a key
  const q = W.unpack(W.pack({ key: false, seq: 1, t: 2, width: 640, height: 360, codec: 1, fps: 15 }, data));
  assert.equal(q.key, false); assert.equal(q.desc, null); assert.deepEqual([...q.data], [9, 8, 7, 6, 5]);
  assert.equal(W.codecById(0).name, 'H.264'); assert.equal(W.codecById(1).name, 'VP8');
  // the relay's id, written into bytes 2-3, reads back as the sender
  const r = new Uint8Array(buf.slice(0)); new DataView(r.buffer).setUint16(2, 7, true);
  assert.equal(W.unpack(r.buffer).from, 7);
  // too short, or a description longer than the packet: not a packet
  assert.equal(W.unpack(new ArrayBuffer(10)), null);
  const bad = new Uint8Array(W.HEADER); new DataView(bad.buffer).setUint16(22, 99, true);
  assert.equal(W.unpack(bad.buffer), null);
  assert.equal(W.unpack('not a buffer'), null);
});

test('the relay room is the livestream room with cam- before it', () => {
  assert.equal(T.camRelayRoom('livestream'), 'cam-livestream');
  assert.equal(T.camRelayRoom('livestream-rehearsal'), 'cam-livestream-rehearsal');
  assert.equal(T.camRelayRoom('a b/c'), 'cam-a-b-c');
  assert.ok(T.camRelayRoom('x'.repeat(100)).length <= 64);
});

// stand-in sockets that only count and record
const sockets = [];
class FakeSocket { constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); } send(d) { this.sent.push(d); } close() { this.closed = true; this.readyState = 3; } }
globalThis.WebSocket = FakeSocket;
const settle = () => new Promise(r => setTimeout(r, 50));
const warns = [];
const realWarn = console.warn;

test('Live Video off: nothing connects, on either side', async () => {
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    // a follower whose broadcaster's camera is off: watching connects nothing
    C.setCamRole(C.ROLE_FOLLOW, null);
    C.takeCamWire(null);
    globalThis.VideoDecoder = function () {}; globalThis.EncodedVideoChunk = function () {};
    const got = [];
    T.cameraWatch('livestream', s => got.push(s));
    await settle();
    assert.equal(sockets.length, 0, 'no socket while off');
    // a state that keeps it off, or a size change while off, still nothing
    C.takeCamWire({ on: 0, sz: 0.4 });
    await settle();
    assert.equal(sockets.length, 0);
    // the presenter's switch off: no camera stream to send, and a send asked
    // for anyway with the switch off is refused
    C.setCamRole(C.ROLE_PRESENT, null);
    S.camOn = false;
    T.cameraSend({ getTracks: () => [] }, 'livestream', '');
    await settle();
    assert.equal(sockets.length, 0, 'no sender while off');
    assert.equal(T.cameraSending(), false);
  } finally { console.warn = realWarn; }
});

test('a follower connects while the broadcaster\'s camera is on, and lets go when it goes off or ends', async () => {
  C.setCamRole(C.ROLE_FOLLOW, null);
  const got = [];
  T.cameraWatch('livestream', s => got.push(s));
  C.takeCamWire({ on: 1, sz: 0.25 });
  await settle();
  assert.equal(sockets.length, 1, 'one socket');
  assert.ok(sockets[0].url.includes('/room/cam-livestream?who='), sockets[0].url);
  assert.ok(sockets[0].url.startsWith('wss://the-signal-video-test.'), 'the deployed video relay');
  assert.equal(T.cameraReceiving(), true);
  C.takeCamWire({ on: 0, sz: 0.25 });
  assert.equal(sockets[0].closed, true, 'closed the moment it goes off');
  assert.equal(T.cameraReceiving(), false);
  assert.equal(got[got.length - 1], null, 'the panel told it went');
  // on again, then the broadcast ends
  C.takeCamWire({ on: 1, sz: 0.25 });
  await settle();
  assert.equal(sockets.length, 2);
  C.takeCamWire(null);
  assert.equal(sockets[1].closed, true, 'closed when the broadcast ends');
  T.cameraUnwatch();
});

test('no WebCodecs: one warning, no socket, no panel, nothing thrown', async () => {
  const n = sockets.length;
  delete globalThis.VideoDecoder; delete globalThis.VideoEncoder;
  warns.length = 0;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    C.setCamRole(C.ROLE_FOLLOW, null);
    const got = [];
    T.cameraWatch('livestream', s => got.push(s));
    C.takeCamWire({ on: 1, sz: 0.25 });
    await settle();
    assert.equal(sockets.length, n, 'the receiver connects nothing');
    assert.equal(got.filter(Boolean).length, 0, 'no stream for the panel');
    C.takeCamWire(null);
    T.cameraUnwatch();
    C.setCamRole(C.ROLE_PRESENT, null);
    S.camOn = true;
    T.cameraSend({ getTracks: () => [] }, 'livestream', '');
    await settle();
    assert.equal(sockets.length, n, 'the sender connects nothing');
    T.cameraStopSending();
    S.camOn = false;
    assert.equal(warns.filter(w => w.includes('cannot unpack video')).length, 1, 'one warning for the receiver: ' + warns.join(' | '));
    assert.equal(warns.filter(w => w.includes('cannot pack video')).length, 1, 'one for the sender');
  } finally { console.warn = realWarn; }
});
