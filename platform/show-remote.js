// The show remote's receiving end: Presence (this app, on the laptop) taking
// cues from the iPad's show controller (show.html at the repo root). Off
// unless the page is opened with ?remote (room 'show') or ?remote=<room>.
// Page thread only (main.js calls initShowRemote outside worker mode): the
// journey and the Slides layer both live on the page engine.
//
// TRANSPORT: the mirror test's (remote.html), lifted. Two paths at once, the
// Cloudflare relay (broadcast-worker/) and the laptop's own local relay
// (tools/mirror-local.mjs on localhost:8800), each reconnecting with backoff
// and pinging every 20 s. The iPad is the broadcaster of the relay room
// 'mirror-<room>'; this page follows it. Every command is a 'word' numbered
// by its sender (src, n), so whichever path delivers a copy first acts and
// the other copy is dropped. Mirror rooms need the password for both roles:
// it is read from localStorage 'mirror.pw' (the same key remote.html and
// show.html keep), seeded once by opening the page with ?remote&pw=<password>
// (pw, not key: a bare ?key= is the demo broadcast's own passphrase seed,
// platform/broadcast-socket.js, and would overwrite it). The pw parameter is
// wiped from the address bar once stored.
//
// COMMANDS (show.html -> here), each {t:'word', src, n, k, ...}. The sender
// rides as src, never id: a ctl's id is the control's (the first build put
// the sender in id too, overwriting it, so every ctl was refused):
//   {k:'jump', i}       journeyJumpTo(i), i 0-based (the step already playing
//                       is left alone, as a digit key or MIDI note does)
//   {k:'next'}/{k:'prev'}  journeyStepBy(+1 / -1)
//   {k:'ctl', id, v}    a Slides control, by schema id, v in the CONTROL'S
//                       OWN position units, exactly what byId(id).set takes:
//                         slideVolume  0..100   (percent)
//                         slideRate    0..1000  (500 = 1x; log 0.25x..2x)
//                         slideLP      0..1000  (log 20 Hz..20 kHz, 1000 open)
//                         slideHP      0..1000  (log 20 Hz..20 kHz, 0 open)
//                         slidePlay    true (PLAY) / false (PAUSE),
//                                      each idempotent: it also lets go a
//                                      live hold (the Journey window's
//                                      button, a walk pause) that disagrees
//                         slideRestart (v ignored)
//                         slideXfade   0..300   (hundredths of a second, 0 a cut)
//   {k:'duck', on, amt, dn, up}  the slides' duck (gpu/slides.js setDuck):
//                       on, the slides' gain falls to (1 - amt) over dn
//                       seconds; off, back to full over up seconds
// The journey moves regardless of the Journey window or ACTIVE (a remote is
// opted into by its URL, so nothing else gates it).
//
// A control is set straight through its schema setter (which saves, and so
// reaches the store and the demo broadcast as a drawer move does) but NOT
// through journeyManualOverride as the drawer's widgets are: with the
// Journey window open that would record the fader into the playing cue for
// good, and with it closed it would pin the control for the rest of the
// walk, so every later cue's own volume, speed and filters (each cue resets
// them) would be ignored. From the iPad a move lasts until the next cue.
//
// STATUS (here -> show.html): a second pair of sockets, this page the
// broadcaster of 'mirror-<room>-status', sends
//   {t:'state', k:'step', i, n, p, sl, src, q}
// whenever any of it changes (polled 4x a second) and as each path opens:
// i the journey's current step (-1 none), n journeyCount(), p whether the
// walk plays, sl the Slides controls in the same units as above
// {vol, rate, lp, hp, play, on} (play: what is actually happening, the
// live hold included), src/q this page's sender id and sequence.
// It goes as a 'state' rather than a 'word' so each relay keeps the latest
// and hands it to an iPad that joins late.

import { S } from '../js/state.js';
import { byId } from '../core/schema.js';
import { journeyJumpTo, journeyStepBy, journeyCount, journeyPlayIdx, journeyPlaying } from '../core/journey.js';
import { idleWake } from '../core/idle.js';
import { setDuck, slidesLiveState, toggleSlidePlayLive } from '../gpu/slides.js';

const CLOUD = 'the-signal-broadcast.robertalexander-music.workers.dev';
const CTL_IDS = new Set(['slideVolume', 'slideRate', 'slideLP', 'slideHP', 'slidePlay', 'slideRestart', 'slideXfade']);
const STATUS_MS = 250;

export function initShowRemote() {
  if (typeof location === 'undefined' || typeof WebSocket === 'undefined') return;
  const P = new URLSearchParams(location.search);
  if (!P.has('remote')) return;
  let room = (P.get('remote') || 'show').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^mirror-/, '') || 'show';
  room = room.slice(0, 40);
  const CMD_ROOM = 'mirror-' + room, STATUS_ROOM = 'mirror-' + room + '-status';
  const relay = P.get('relay') || CLOUD;
  const local = P.get('relaylocal') || 'localhost:8800';

  let KEY = '';
  try { KEY = localStorage.getItem('mirror.pw') || ''; } catch (e) {}
  const pw = P.get('pw');
  if (pw) {
    KEY = pw;
    try { localStorage.setItem('mirror.pw', pw); } catch (e) {}
    P.delete('pw');
    const qs = P.toString().replace(/(^|&)remote=(?=&|$)/, '$1remote');
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (e) {}
  }
  if (!KEY) {
    console.warn('[show-remote] no password: open once with ?remote&pw=<password> (the mirror password)');
    return;
  }
  // A one-off check, for a clear console line; the sockets retry regardless.
  fetch('https://' + relay + '/auth', { method: 'POST', body: KEY }).then(r => {
    if (r.status === 403) console.warn('[show-remote] the relay refused the password; reopen with ?remote&pw=<password>');
  }, () => {});
  console.log('[show-remote] following ' + CMD_ROOM + ', status to ' + STATUS_ROOM + ' (cloud + local ' + local + ')');

  const bases = [{ name: 'cloud', base: 'wss://' + relay }, { name: 'local', base: 'ws://' + local }];

  // ---------- one reconnecting socket per path and room ----------
  function socket(base, name, roomName, role, onMsg, onOpen) {
    const s = { ws: null, retry: 2000, name };
    const openIt = () => {
      try { s.ws = new WebSocket(base + '/room/' + roomName + '?role=' + role + '&key=' + encodeURIComponent(KEY)); }
      catch (e) { setTimeout(openIt, s.retry); return; }
      s.ws.onopen = () => { s.retry = 2000; console.log('[show-remote] ' + name + ' ' + role + ' ' + roomName + ' open'); if (onOpen) onOpen(s); };
      s.ws.onclose = () => { setTimeout(openIt, s.retry); s.retry = Math.min(s.retry * 2, 15000); };
      s.ws.onmessage = e => {
        if (typeof e.data !== 'string' || e.data === 'pong') return;
        let m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m && onMsg) onMsg(m, s);
      };
    };
    s.send = text => { if (s.ws && s.ws.readyState === 1) { try { s.ws.send(text); } catch (e) {} } };
    openIt();
    return s;
  }
  const all = [];
  setInterval(() => { for (const s of all) s.send('ping'); }, 20000);

  // ---------- commands in ----------
  const lastN = new Map();   // sender id -> highest n acted on
  function take(m) {
    if (m.t !== 'word' || typeof m.k !== 'string') return;
    const id = String(m.src || ''), n = +m.n || 0;
    if (n <= (lastN.get(id) || 0)) return;   // the other path's copy
    lastN.set(id, n);
    try { act(m); } catch (err) { console.warn('[show-remote] ' + m.k + ' failed:', err); }
    idleWake('show remote');
    pollStatus();
  }
  function act(m) {
    if (m.k === 'jump') { const i = m.i | 0; if (i >= 0) journeyJumpTo(i); }
    else if (m.k === 'next') journeyStepBy(1);
    else if (m.k === 'prev') journeyStepBy(-1);
    else if (m.k === 'ctl') {
      if (!CTL_IDS.has(m.id)) return;
      const c = byId(m.id);
      if (!c) return;
      if (c.kind === 'action') { if (c.act) c.act(S); else c.set(S, 1); }
      else if (m.id === 'slidePlay') {
        // PLAY / PAUSE mean exactly that: Play on S, and a live hold on the
        // slide on screen (gpu/slides.js: 1 playing, 2 paused or ended)
        // that says otherwise flipped to agree.
        const on = !!m.v;
        c.set(S, on);
        const st = slidesLiveState();
        if ((on && st === 2) || (!on && st === 1)) toggleSlidePlayLive();
      }
      else if (c.kind === 'toggle') c.set(S, !!m.v);
      else {
        const v = +m.v;
        if (!isFinite(v)) return;
        c.set(S, Math.max(c.min, Math.min(c.max, Math.round(v))));
      }
    } else if (m.k === 'duck') {
      const amt = Math.max(0, Math.min(1, +m.amt || 0));
      const sec = m.on ? +m.dn : +m.up;
      setDuck(m.on ? 1 - amt : 1, isFinite(sec) && sec >= 0 ? sec : 0.2);
    }
  }
  for (const b of bases) all.push(socket(b.base, b.name, CMD_ROOM, 'follow', take, null));

  // ---------- status out ----------
  const SID = Math.random().toString(36).slice(2, 10);
  let q = 0, lastSig = '';
  const get = id => { const c = byId(id); return c && c.get ? c.get(S) : null; };
  const playingNow = () => { const st = slidesLiveState(); return st ? st === 1 : !!get('slidePlay'); };
  function statusMsg() {
    return {
      t: 'state', k: 'step',
      i: journeyPlayIdx(), n: journeyCount(), p: journeyPlaying(),
      sl: { vol: get('slideVolume'), rate: get('slideRate'), lp: get('slideLP'), hp: get('slideHP'),
            play: playingNow(), on: !!(S.layers && S.layers.slides) }
    };
  }
  function sendStatus(only) {
    const m = statusMsg();
    m.src = SID; m.q = ++q;
    const text = JSON.stringify(m);
    for (const s of only ? [only] : statusSocks) s.send(text);
  }
  function pollStatus() {
    const sig = JSON.stringify(statusMsg());
    if (sig === lastSig) return;
    lastSig = sig;
    sendStatus(null);
  }
  const statusSocks = [];
  for (const b of bases) {
    const s = socket(b.base, b.name, STATUS_ROOM, 'broadcast', null, sk => sendStatus(sk));
    statusSocks.push(s); all.push(s);
  }
  setInterval(pollStatus, STATUS_MS);
}
