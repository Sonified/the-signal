// Video broadcast test: wires the pieces together.
//
// net.js carries packets through the relay, capture.js turns my camera into
// packets, receive.js turns other people's packets back into pictures, and
// scene.js stands those pictures as panels in a 3D space. This file owns the
// page: the room, the controls (every one remembered), the camera button and
// the numbers, which it refreshes twice a second.

import { unpack, KIND_VIDEO, codecById } from './wire.js';
import { connect } from './net.js';
import { listCodecs, createCapture } from './capture.js';
import { createReceiver } from './receive.js';
import { createScene } from './scene.js';

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- settings

const STORE_KEY = 'vbt.v1';
const SIZES = ['160x120', '320x240', '480x360', '640x480', '960x720', '1280x720'];
const RATES = [5, 10, 15, 24, 30];
const KEYS = [1, 2, 5, 10];
const KBPS_MIN = 30, KBPS_MAX = 4000;

const DEFAULTS = {
  room: '',
  size: '320x240',
  fps: 15,
  kbps: 150,
  codec: null,       // a wire id; null until this device's choices are known
  keyEvery: 2,
  distance: 2.5,
  width: 1.0,
  echo: false,
  hidden: false
};

function load() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  const s = { ...DEFAULTS, ...saved };
  if (!SIZES.includes(s.size)) s.size = DEFAULTS.size;
  if (!RATES.includes(+s.fps)) s.fps = DEFAULTS.fps;
  s.fps = +s.fps;
  s.kbps = clamp(+s.kbps || DEFAULTS.kbps, KBPS_MIN, KBPS_MAX);
  if (!KEYS.includes(+s.keyEvery)) s.keyEvery = DEFAULTS.keyEvery;
  s.keyEvery = +s.keyEvery;
  s.distance = clamp(+s.distance || DEFAULTS.distance, 0.5, 10);
  s.width = clamp(+s.width || DEFAULTS.width, 0.2, 4);
  s.echo = !!s.echo;
  s.hidden = !!s.hidden;
  s.codec = Number.isInteger(s.codec) ? s.codec : null;
  s.room = cleanRoom(s.room || '');
  return s;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* private mode: settings just won't stick */ }
}

const S = load();

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function sendSettings() {
  const [w, h] = S.size.split('x').map(Number);
  return { width: w, height: h, fps: S.fps, bitrate: Math.round(S.kbps * 1000), codec: S.codec, keyEvery: S.keyEvery };
}

// ---------------------------------------------------------------- the room

// Six letters and digits, leaving out the ones that look alike (i l o 0 1).
const ROOM_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomRoom() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  let r = '';
  for (const n of a) r += ROOM_CHARS[n % ROOM_CHARS.length];
  return r;
}

function cleanRoom(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '').slice(0, 32);
}

function roomFromUrl() {
  try { return cleanRoom(new URL(location.href).searchParams.get('room') || ''); } catch (e) { return ''; }
}

function setUrlRoom(room) {
  try {
    const u = new URL(location.href);
    u.searchParams.set('room', room);
    history.replaceState(null, '', u.toString());
  } catch (e) { /* leave the address as it is */ }
}

function pageLink() {
  const u = new URL(location.href);
  u.hash = '';
  u.searchParams.set('room', S.room);
  return u.toString();
}

S.room = roomFromUrl() || S.room || randomRoom();
setUrlRoom(S.room);
save();

// ---------------------------------------------------------------- the pieces

let net = null;
let netGen = 0;
let everOpen = false;
const peers = new Set();     // ids of the other people here

const rx = createReceiver({
  now: () => (net ? net.now() : performance.now()),
  onNeedKey(id) { if (net) net.sendJSON({ t: 'key', to: id }); }
});

let camState = 'off';
const cap = createCapture({
  now: () => (net ? net.now() : performance.now()),
  send: buf => (net ? net.send(buf) : false),
  onState(text) { camState = String(text || 'off'); showCamera(); }
});

function openRoom() {
  if (net) { try { net.close(); } catch (e) { /* already gone */ } }
  for (const p of [...rx.panels()]) rx.drop(p.id);
  for (const id of peers) rx.drop(id);
  peers.clear();
  everOpen = false;
  const gen = ++netGen;
  const live = () => gen === netGen;
  net = connect({
    room: S.room,
    onHello(me, ids) {
      if (!live()) return;
      const now = new Set((ids || []).filter(id => id !== me));
      for (const id of peers) if (!now.has(id)) rx.drop(id);
      // After a reconnect I have a new id, so my old echo panel goes too.
      for (const p of [...rx.panels()]) if (!now.has(p.id) && p.id !== me) rx.drop(p.id);
      peers.clear();
      for (const id of now) peers.add(id);
      cap.forceKey();
      refresh();
    },
    onPeer(id, on) {
      if (!live()) return;
      if (on) { peers.add(id); cap.forceKey(); }
      else { peers.delete(id); rx.drop(id); }
      refresh();
    },
    onPacket(buf) {
      if (!live()) return;
      const p = unpack(buf);
      if (p && p.kind === KIND_VIDEO) rx.push(p);
    },
    onMessage(msg) {
      if (!live() || !msg) return;
      if (msg.t === 'key' && (msg.to == null || (net.id && msg.to === net.id))) cap.forceKey();
    },
    onStatus(text) {
      if (!live()) return;
      if (text === 'open') everOpen = true;
      refresh();
    }
  });
  net.setEcho(S.echo);
}

// ---------------------------------------------------------------- the 3D view

let scene = null;
let sceneError = '';
const canvas = $('view');

createScene(canvas).then(sc => {
  scene = sc;
  scene.set({ distance: S.distance, size: S.width });
  scene.resize();
  refresh();
}).catch(err => {
  sceneError = (err && err.message) || 'This browser cannot show the 3D view.';
  canvas.style.display = 'none';
  $('noviewText').textContent = sceneError + ' Sending and the numbers still work.';
  $('noview').classList.add('show');
  refresh();
});

function onResize() { if (scene) { try { scene.resize(); } catch (e) { /* next draw tries again */ } } }
addEventListener('resize', onResize);
if (window.visualViewport) visualViewport.addEventListener('resize', onResize);

let drawFailed = false;
function frame() {
  requestAnimationFrame(frame);
  if (!scene || scene.lost) return;
  try { scene.draw(rx.panels()); } catch (e) {
    if (!drawFailed) { drawFailed = true; console.error('scene.draw', e); }
  }
}

// ---------------------------------------------------------------- formats

let codecs = [];             // [{ id, name }] this device can send now
let codecsSeq = 0;
let codecsReady = Promise.resolve();

function refreshCodecs() {
  const seq = ++codecsSeq;
  const sel = $('codec');
  codecsReady = (async () => {
    let list = [];
    try {
      const { width, height, fps, bitrate } = sendSettings();
      list = await listCodecs({ width, height, fps, bitrate });
    } catch (e) { list = []; }
    if (seq !== codecsSeq) return;
    codecs = Array.isArray(list) ? list : [];
    sel.replaceChildren();
    if (!codecs.length) {
      const o = document.createElement('option');
      o.textContent = 'None this device can send at this size and rate';
      sel.append(o);
      sel.disabled = true;
      S.codec = null;
      save();
      return;
    }
    sel.disabled = false;
    for (const c of codecs) {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.name;
      sel.append(o);
    }
    if (!codecs.some(c => c.id === S.codec)) {
      const h264 = codecs.find(c => c.name === 'H.264');
      S.codec = (h264 || codecs[0]).id;
    }
    sel.value = String(S.codec);
    save();
  })();
  return codecsReady;
}

function codecName(id) {
  const c = codecs.find(x => x.id === id) || codecById(id);
  return c ? c.name : '…';
}

// ---------------------------------------------------------------- camera

let applyChain = Promise.resolve();
let startedWith = '';

function applySending() {
  if (!cap.running) return;
  applyChain = applyChain.then(async () => {
    if (!cap.running || S.codec == null) return;
    const s = sendSettings();
    if (JSON.stringify(s) === startedWith) return;   // nothing new to tell the camera
    startedWith = JSON.stringify(s);
    await cap.apply(s);
  }).catch(e => { camMessage(plainError(e)); });
}

function plainError(e) {
  const m = (e && e.message) || String(e || '');
  return m || 'Something went wrong with the camera.';
}

function camMessage(text) { $('camMsg').textContent = text || ''; }

// The pieces report trouble in lowercase fragments; show them as sentences.
function sentence(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

async function toggleCamera() {
  if (cap.running || camState === 'on' || camState === 'starting') {
    try { cap.stop(); } catch (e) { /* already stopped */ }
    camState = 'off';
    showCamera();
    return;
  }
  camMessage('');
  $('camera').disabled = true;
  try {
    await codecsReady;
    if (S.codec == null) {
      camMessage('This device cannot send video in any of the formats at this size and rate. Try a smaller picture size.');
      return;
    }
    const s = sendSettings();
    startedWith = JSON.stringify(s);
    await cap.start(s);
    // A setting changed while the camera was starting: catch up.
    if (cap.running && JSON.stringify(sendSettings()) !== startedWith) applySending();
  } catch (e) {
    camMessage(plainError(e));
  } finally {
    $('camera').disabled = false;
    showCamera();
  }
}

function showCamera() {
  const btn = $('camera');
  const on = cap.running || camState === 'on';
  const starting = camState === 'starting';
  btn.textContent = starting ? 'Starting camera…' : on ? 'Turn camera off' : 'Turn camera on';
  btn.classList.toggle('on', on || starting);
  if (camState.startsWith('error')) {
    camMessage(sentence(camState.replace(/^error:\s*/, '')) || 'The camera could not start.');
  } else if (camState === 'on') {
    camMessage('');
  }
  const box = $('preview');
  const v = cap.preview;
  // The preview goes on the page, and is shown, from the moment the camera
  // is asked for: an iPhone may not run a video that is off the page or
  // hidden, and the camera's frames are read from this very element.
  if (v) {
    v.setAttribute('playsinline', '');
    v.playsInline = true;
    v.muted = true;
    if (v.parentNode !== box) box.replaceChildren(v);
  }
  box.classList.toggle('show', !!v && (on || starting));
}

// ---------------------------------------------------------------- controls

function kbpsFromPos(pos) {
  const k = KBPS_MIN * Math.pow(KBPS_MAX / KBPS_MIN, pos / 1000);
  const step = k < 100 ? 1 : k < 1000 ? 5 : 50;
  return clamp(Math.round(k / step) * step, KBPS_MIN, KBPS_MAX);
}
function posFromKbps(k) {
  return Math.round(1000 * Math.log(k / KBPS_MIN) / Math.log(KBPS_MAX / KBPS_MIN));
}
function fmtRate(k) {
  if (k == null || !isFinite(k)) return '…';
  if (k >= 1000) return `${Number((k / 1000).toFixed(2))} Mbps`;
  return `${Math.round(k)} kbps`;
}
function fmtM(v) { return `${(+v).toFixed(1)} m`; }
function sizeText(s) { return s.replace('x', '×'); }

function initControls() {
  $('room').value = S.room;
  $('size').value = S.size;
  $('fps').value = String(S.fps);
  $('rate').value = String(posFromKbps(S.kbps));
  $('rateOut').textContent = fmtRate(S.kbps);
  $('keyEvery').value = String(S.keyEvery);
  $('distance').value = String(S.distance);
  $('distanceOut').textContent = fmtM(S.distance);
  $('width').value = String(S.width);
  $('widthOut').textContent = fmtM(S.width);
  $('echo').checked = S.echo;
  showHidden();
  showLink();

  $('room').addEventListener('change', () => {
    const r = cleanRoom($('room').value);
    if (!r) { $('room').value = S.room; return; }
    $('room').value = r;
    if (r === S.room) return;
    S.room = r;
    save();
    setUrlRoom(r);
    showLink();
    openRoom();
    refresh();
  });
  $('room').addEventListener('keydown', e => { if (e.key === 'Enter') $('room').blur(); });

  // Size, rate and data rate can change which formats this device offers,
  // so the choices are checked again before the camera is retuned.
  $('size').addEventListener('change', () => { S.size = $('size').value; save(); refreshCodecs().then(applySending); });
  $('fps').addEventListener('change', () => { S.fps = +$('fps').value; save(); refreshCodecs().then(applySending); });
  $('rate').addEventListener('input', () => {
    S.kbps = kbpsFromPos(+$('rate').value);
    $('rateOut').textContent = fmtRate(S.kbps);
    save();
  });
  // The camera is retuned when the slider is let go, not on every step of a drag.
  $('rate').addEventListener('change', () => {
    S.kbps = kbpsFromPos(+$('rate').value);
    $('rateOut').textContent = fmtRate(S.kbps);
    save();
    refreshCodecs().then(applySending);
  });
  $('codec').addEventListener('change', () => {
    const id = parseInt($('codec').value, 10);
    if (!Number.isInteger(id)) return;
    S.codec = id; save(); applySending();
  });
  $('keyEvery').addEventListener('change', () => { S.keyEvery = +$('keyEvery').value; save(); applySending(); });

  $('distance').addEventListener('input', () => {
    S.distance = +$('distance').value;
    $('distanceOut').textContent = fmtM(S.distance);
    save();
    if (scene) scene.set({ distance: S.distance, size: S.width });
  });
  $('width').addEventListener('input', () => {
    S.width = +$('width').value;
    $('widthOut').textContent = fmtM(S.width);
    save();
    if (scene) scene.set({ distance: S.distance, size: S.width });
  });

  $('echo').addEventListener('change', () => {
    S.echo = $('echo').checked;
    save();
    if (net) net.setEcho(S.echo);
    if (!S.echo && net && net.id) rx.drop(net.id);
    refresh();
  });

  $('camera').addEventListener('click', toggleCamera);
  $('toggle').addEventListener('click', () => { S.hidden = !S.hidden; save(); showHidden(); });
  $('copyLink').addEventListener('click', () => copyText(pageLink(), $('copyLink'), 'Copy link'));
  $('copyResults').addEventListener('click', () => copyText(resultsText(), $('copyResults'), 'Copy results'));
}

function showHidden() {
  document.body.classList.toggle('hidden', S.hidden);
  $('toggle').textContent = S.hidden ? 'Show controls' : 'Hide controls';
}

function showLink() { $('link').textContent = pageLink(); }

// ---------------------------------------------------------------- the numbers

const dash = '…';
const ok = v => v != null && isFinite(v);
const ms = v => (ok(v) ? `${Math.round(v)} ms` : dash);
const whole = v => (ok(v) ? String(Math.round(v)) : dash);
const kbpsOf = bytesPerSecond => (ok(bytesPerSecond) ? `${Math.round(bytesPerSecond * 8 / 1000)} kbps` : dash);
const kbOf = bytes => (ok(bytes) ? (bytes < 10240 && bytes > 0 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes / 1024)} KB`) : dash);
const dims = (w, h) => (ok(w) && ok(h) && w > 0 && h > 0 ? `${w}×${h}` : dash);
const kbpsVal = v => (ok(v) ? `${Math.round(v)} kbps` : dash);

function statusWords(st) {
  if (st === 'open') return 'Connected';
  if (st === 'connecting' && !everOpen) return 'Connecting…';
  return 'Reconnecting…';
}

// The numbers as groups of plain lines: drawn on the page and copied as text.
function numberGroups() {
  const groups = [];
  const n = net ? safe(() => net.stats()) : null;

  groups.push({
    title: 'Connection',
    lines: n ? [
      statusWords(n.status),
      `People here: ${whole(n.people)}`,
      `Round trip to the relay: ${ms(n.rtt)}`,
      `Waiting to go out: ${kbOf(n.buffered)}`,
      `Total arriving: ${kbpsOf(n.downBytes)}`,
      `Total leaving: ${kbpsOf(n.upBytes)}`
    ] : ['Connecting…']
  });

  if (cap.running) {
    const c = safe(() => cap.stats()) || {};
    groups.push({
      title: 'Sending',
      lines: [
        `Sending ${dims(c.width, c.height)} at ${whole(c.fps)} a second, ${kbpsVal(c.kbps)}, ${c.codec || dash}`,
        `Time to pack each picture: ${ms(c.encodeMs)}`,
        `Camera is giving ${dims(c.cameraWidth, c.cameraHeight)} at ${whole(c.cameraFps)} a second`,
        `Full pictures sent: ${whole(c.keyframes)}`,
        `Pictures skipped (device too busy): ${whole(c.dropped)}`,
        `Pictures refused (link too slow): ${whole(c.refused)}`
      ]
    });
  } else {
    groups.push({ title: 'Sending', lines: ['Camera is off'] });
  }

  const me = net && net.id ? net.id : null;   // 0 while not connected
  const ids = new Set(peers);
  for (const p of rx.panels()) ids.add(p.id);
  if (S.echo && me != null) ids.add(me);
  const sorted = [...ids].sort((a, b) => (a === me ? -1 : b === me ? 1 : a - b));
  if (!sorted.length) groups.push({ title: 'Receiving', lines: ['Nobody else here yet'] });
  for (const id of sorted) {
    const title = id === me ? 'My own picture, back from the relay' : `Person ${id}`;
    const r = safe(() => rx.stats(id));
    if (!r) { groups.push({ title, lines: ['No pictures arriving yet'] }); continue; }
    const lines = [
      `${dims(r.width, r.height)} at ${whole(r.fps)} a second, ${kbpsVal(r.kbps)}, ${r.codec || dash}`,
      `Delay, camera to here: ${ms(r.delayMs)} (worst ${whole(r.delayMaxMs)})`,
      `Time to unpack each picture: ${ms(r.decodeMs)}`,
      `Stumbles (had to wait for a full picture): ${whole(r.gaps)}`,
      `Waiting to be unpacked: ${whole(r.queue)}`
    ];
    if (r.error) lines.push({ text: `Problem: ${sentence(r.error)}`, bad: true });
    groups.push({ title, lines });
  }

  let view;
  if (sceneError) view = { text: `Not available: ${sceneError}`, bad: true };
  else if (!scene) view = 'Starting…';
  else if (scene.lost) view = { text: 'The 3D view stopped. Reload the page.', bad: true };
  else view = `Pictures reach the screen: ${scene.uploadPath === 'direct' ? 'directly' : 'by way of a copy (slower)'}`;
  groups.push({ title: '3D view', lines: [view] });

  return groups;
}

function safe(f) { try { return f(); } catch (e) { return null; } }

function refresh() {
  const box = $('numbers');
  const out = [];
  for (const g of numberGroups()) {
    const d = document.createElement('div');
    d.className = 'g';
    const t = document.createElement('p');
    t.className = 'gt';
    t.textContent = g.title;
    d.append(t);
    for (const l of g.lines) {
      const p = document.createElement('p');
      p.className = 'ln' + (typeof l === 'object' && l.bad ? ' bad' : '');
      p.textContent = typeof l === 'object' ? l.text : l;
      d.append(p);
    }
    out.push(d);
  }
  box.replaceChildren(...out);
}

// ---------------------------------------------------------------- copy results

function deviceWords() {
  const ua = navigator.userAgent || '';
  let browser = 'a browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let where = 'an unknown device';
  if (/iPhone/.test(ua)) where = 'iPhone';
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) where = 'iPad';
  else if (/Android/.test(ua)) where = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) where = 'Mac';
  else if (/Windows/.test(ua)) where = 'Windows';
  else if (/Linux|CrOS/.test(ua)) where = 'Linux';
  return `${browser} on ${where}`;
}

function resultsText() {
  const L = [];
  L.push('Video broadcast test');
  L.push(`When: ${new Date().toLocaleString()}`);
  L.push(`This device: ${deviceWords()}`);
  L.push(`Screen: ${screen.width}×${screen.height}, ${devicePixelRatio || 1}× sharpness`);
  L.push(`Room: ${S.room}`);
  L.push(`Link: ${pageLink()}`);
  L.push(`My number in the room: ${net && net.id ? net.id : dash}`);
  L.push('');
  L.push('Settings');
  L.push(`  Camera: ${cap.running ? 'on' : 'off'}`);
  L.push(`  Picture size: ${sizeText(S.size)}`);
  L.push(`  Pictures a second: ${S.fps}`);
  L.push(`  Data rate: ${fmtRate(S.kbps)}`);
  L.push(`  Format: ${S.codec == null ? 'none available' : codecName(S.codec)}`);
  L.push(`  Full picture every: ${S.keyEvery} ${S.keyEvery === 1 ? 'second' : 'seconds'}`);
  L.push(`  Distance: ${fmtM(S.distance)}`);
  L.push(`  Panel width: ${fmtM(S.width)}`);
  L.push(`  My own picture through the relay: ${S.echo ? 'on' : 'off'}`);
  L.push(`  Formats this device can send: ${codecs.length ? codecs.map(c => c.name).join(', ') : 'none'}`);
  for (const g of numberGroups()) {
    L.push('');
    L.push(g.title);
    for (const l of g.lines) L.push('  ' + (typeof l === 'object' ? l.text : l));
  }
  const msg = $('camMsg').textContent;
  if (msg) { L.push(''); L.push(`Camera message: ${msg}`); }
  return L.join('\n');
}

async function copyText(text, btn, label) {
  let done = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      done = true;
    }
  } catch (e) { done = false; }
  if (!done) {
    // Older route: select a hidden text box and copy from it.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    try { done = document.execCommand('copy'); } catch (e) { done = false; }
    ta.remove();
  }
  btn.textContent = done ? 'Copied' : 'Could not copy';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = label; }, 1500);
}

// ---------------------------------------------------------------- start

initControls();
showCamera();
openRoom();
refreshCodecs();
refresh();
setInterval(refresh, 500);
requestAnimationFrame(frame);
