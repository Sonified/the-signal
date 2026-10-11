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
// App health uses transient {t:'word', k:'health', src, probe} requests on
// each route. initShowRemote returns a callback main.js runs after a completed
// frame; it replies on that route's status socket with {t:'word', k:'health',
// src, to, probe}. Health requests bypass command numbering and never edit
// settings. This checks the frame loop as well as the relay connection.
//
// COMMANDS (show.html -> here), each {t:'word', src, n, k, ...}. The sender
// rides as src, never id: a ctl's id is the control's (the first build put
// the sender in id too, overwriting it, so every ctl was refused):
//   {k:'jump', i}       journeyJumpTo(i), i 0-based (the step already playing
//                       is left alone, as a digit key or MIDI note does)
//   {k:'next'}/{k:'prev'}  journeyStepBy(+1 / -1)
//   {k:'seek', f}       the playing cue tapped again: its slide video to
//                       share f (0..1) of its length (gpu/slides.js seekSlide)
//   {k:'clean'}         the title tapped: the drawer and every window shut
//                       (main.js's clearScreen hook), only the playback left
//   {k:'ctl', id, v}    a control, by schema id, v in the CONTROL'S OWN
//                       position units, exactly what byId(id).set takes:
//                         vol          0..100   the FADER's position, on a
//                                                squared taper into the app's
//                                                Master volume (the slides,
//                                                the music and the Sun's hum):
//                                                gain = (v/100)^2, so 50 is
//                                                -12 dB, 25 is -24 dB, 100 is
//                                                0 dB. The control itself and
//                                                the drawer stay linear; only
//                                                this fader is curved.
//                         lpf          0..1000  (global Lowpass, log 20 Hz..
//                                                20 kHz, 1000 open)
//                         hpf          0..1000  (global Highpass, same taper,
//                                                0 open)
//                         lpfRes       0..24    (the Lowpass's resonance, dB
//                         hpfRes       0..24     of peak at the corner, 0
//                                                flat; the gear's Filters)
//                         filterGlide  0..200   (ms, the four's exponential
//                                                smooth's time constant, 0 a
//                                                jump; the gear's Filters)
//                         slideRate    0..1000  (500 = 1x; log 0.25x..2x).
//                                                The iPad only sends 0..500
//                                                (1x at the top), and 0
//                                                STOPS the slide (a live
//                                                hold, nothing recorded);
//                                                anything above lets it go.
//                         slidePlay    true (PLAY) / false (PAUSE),
//                                      each idempotent: it also lets go a
//                                      live hold (the Journey window's
//                                      button, a walk pause) that disagrees
//                         slideRestart (v ignored)
//                         slideXfade   0..1000  (hundredths of a second, 0 a cut)
//                         heartMaster  0..100   (the Heartbeat's Master, %:
//                                                its sound and its flash
//                                                together, core/schema-
//                                                heartbeat.js; a cue that
//                                                holds it sets it again)
//                         mwtsVolume   0..100   (meditatewiththesun.com's
//                                                Master volume, %: the phones
//                                                following the broadcast,
//                                                core/schema-sun.js)
//                         screenGate   0..100   (the screen gate, %: the
//                                                room's picture's master
//                                                brightness, 0 black; NOT a
//                                                schema control, it sets
//                                                S.screenGate directly, live
//                                                only, gpu/engine.js drawGate)
//                         finaleDrone, 0..100   (the finale row's faders,
//                         finalePiano,           see FINALE below: each lays
//                         finaleChoir,           its 0..100% linearly onto
//                         finaleAmb,             one or more levels, 100 =
//                         finaleHum,
//                         finaleSun
//                                                the finale's own level, 0
//                                                silent; set through their
//                                                controls, so their variance
//                                                rides them. DRONE: Drone
//                                                level, the tone's Level and
//                                                Clouds level. PIANO: Piano
//                                                level. CHOIR: Choir level.
//                                                AMBIENCE: Ambience level.
//                                                HUM: the Sun hum's Speed,
//                                                1x at 0, 2x at 100. SUN,
//                                                beside SCREEN: the Sun's
//                                                Speed 2x..8x (4x halfway),
//                                                its variance 0..78% and the
//                                                Breath Amount 0..67%)
//   {k:'duck', on, amt, dn, up}  the duck (gpu/slides.js setDuck, the
//                       heartbeat's setHeartDuck and the Sun hum's
//                       setHumDuck, the same multiplier): on, the slides',
//                       the heartbeat's and the hum's gains fall to
//                       (1 - amt) over dn seconds; off, back to full over
//                       up seconds
// The journey moves regardless of the Journey window or ACTIVE (a remote is
// opted into by its URL, so nothing else gates it).
//
// A control is set straight through its schema setter (which saves, and so
// reaches the store and the demo broadcast as a drawer move does) but NOT
// through journeyManualOverride as the drawer's widgets are: with the
// Journey window open that would record the fader into the playing cue for
// good, and with it closed it would pin the control for the rest of the
// walk, so every later cue's own speed (each cue resets it) would be
// ignored. From the iPad a Speed move lasts until the next cue; vol, lpf and
// hpf are never held by a cue (core/journey.js), so they last until moved.
// The slides' own level (Master slide volume, slideVolume) is the laptop's
// and is never sent from here.
//
// STATUS (here -> show.html): a second pair of sockets, this page the
// broadcaster of 'mirror-<room>-status', sends
//   {t:'state', k:'step', i, n, p, vp, sl, src, q}
// whenever any of it changes (polled 4x a second) and as each path opens:
// i the journey's current step (-1 none), n journeyCount(), p whether the
// walk plays, sl the faders' controls in the same units as above
// {vol: vol, rate: slideRate, lp: lpf, hp: hpf, lr: lpfRes, hr: hpfRes, fg: filterGlide, hm: heartMaster, mw: mwtsVolume, gt: screenGate, ch: finaleChoir, dr: finaleDrone, pn: finalePiano, am: finaleAmb, hu: finaleHum, su: finaleSun, play, on} (play: what is actually happening, the
// live hold included), vp the slide video's place {t, d, r, f, l} (seconds in,
// its length, the rate it advances at, 0 when held; null with no video of
// known length; the iPad fills the playing cue with it, running on between
// reports at r; f is the actual file, l its loop setting), src/q this page's sender id and sequence.
// It goes as a 'state' rather than a 'word' so each relay keeps the latest
// and hands it to an iPad that joins late.

import { S } from '../js/state.js';
import { byId } from '../core/schema.js';
import { journeyJumpTo, journeyStepBy, journeyCount, journeyPlayIdx, journeyPlaying, journeyStepAt } from '../core/journey.js';
import { idleWake } from '../core/idle.js';
import { setDuck, slidesLiveState, toggleSlidePlayLive, slidesProgress, seekSlide } from '../gpu/slides.js';
import { setHeartDuck } from '../core/heartbeat.js';
import { setHumDuck } from '../core/sun-hum.js';
import { slideRateFromPos, slideElementRate } from '../core/slide-rate.js';
import { ampToPos } from '../js/util.js';

const CLOUD = 'the-signal-broadcast.robertalexander-music.workers.dev';
const CTL_IDS = new Set(['vol', 'lpf', 'hpf', 'lpfRes', 'hpfRes', 'filterGlide', 'slideRate', 'slidePlay', 'slideRestart', 'slideXfade', 'heartMaster', 'mwtsVolume']);
const STATUS_MS = 250;
// The finale row's faders: per fader, the levels it moves together, each
// [S key = control id, its value at the fader's 100% (the finale preset's
// own), the control's position for a value, its value at the fader's 0
// (silent when left out), true to lay it evenly in ratio (each doubling
// the same stretch) instead of linearly]. The first is the one reported
// back to the iPad.
const FINALE = {
  finaleChoir: [['choirVol', 1.38, a => a * 100]],
  finalePiano: [['pianoVol', 1, a => a * 100]],
  finaleAmb: [['ambVol', 0.18, a => a * 100]],
  finaleDrone: [['bedVol', 0.55, a => a * 100], ['toneVol', 0.19054607179632474, ampToPos],
                ['cloudVol', 1, a => a * 100]],
  // the Sun hum's Speed, 1x at the bottom and 2x at the top, linear in the
  // control's own log setting (core/schema-sun.js: 0.5x..16x over 0..1, so
  // 1x is 0.2 and 2x 0.4), even in pitch: 1.41x halfway
  finaleHum: [['sunHumRate', 0.4, a => a * 1000, 0.2]],
  // SUN, beside SCREEN: the video's baseline Speed 2x to 8x, even in ratio
  // as its own slider moves (core/schema-sun.js: log 1x..16x over 0..1000,
  // so 4x halfway), with Speed's variance 0 to 78% and the Breath's Amount
  // 0 to 67%
  finaleSun: [['sunSpeed', 8, a => Math.log(a) / Math.log(16) * 1000, 2, true],
              ['sunSpeedVar', 0.78, a => a * 100], ['sunBreathAmt', 0.67, a => a * 100]]
};
// a fader's place, 0..100, from its first level
const finalePos = id => {
  const [key, top, , bottom = 0, ratio] = FINALE[id][0];
  const v = +S[key] || 0;
  const u = ratio ? (v > 0 ? Math.log(v / bottom) / Math.log(top / bottom) : 0) : (v - bottom) / (top - bottom);
  return Math.round(Math.max(0, Math.min(1, u)) * 1000) / 10;
};

export function initShowRemote(hooks = {}) {
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
  const healthRequests = new Map();
  function take(m, path) {
    if (m.t !== 'word' || typeof m.k !== 'string') return;
    // Keep route-specific probes outside command deduplication and authoring.
    // Reply only after main.js finishes a frame, so a stalled frame loop cannot
    // look healthy just because its WebSocket callbacks still work.
    if (m.k === 'health') {
      if (typeof m.src !== 'string' || typeof m.probe !== 'string' || m.src.length > 128 || m.probe.length > 128) return;
      healthRequests.set(path.name + ':' + m.src, { path: path.name, to: m.src, probe: m.probe });
      idleWake('show remote health');
      return;
    }
    const id = String(m.src || ''), n = +m.n || 0;
    if (n <= (lastN.get(id) || 0)) return;   // the other path's copy
    lastN.set(id, n);
    if (m.k === 'ctl' && m.id === 'mwtsVolume') console.log('[show-remote] MWTS fader -> mwtsVolume ' + m.v + '%');
    try { act(m); } catch (err) { console.warn('[show-remote] ' + m.k + ' failed:', err); }
    idleWake('show remote');
    pollStatus();
  }
  // the Speed fader is at 0 and has stopped the slide itself
  let speedStopped = false;
  function act(m) {
    if (m.k === 'jump') { const i = m.i | 0; if (i >= 0) journeyJumpTo(i); }
    else if (m.k === 'clean') { if (hooks.clearScreen) hooks.clearScreen(); }
    else if (m.k === 'seek') seekSlide(+m.f);
    else if (m.k === 'next') journeyStepBy(1);
    else if (m.k === 'prev') journeyStepBy(-1);
    else if (m.k === 'ctl') {
      if (m.id === 'screenGate') {
        // not a schema control: live only, never saved (js/state.js)
        const v = +m.v;
        if (isFinite(v)) S.screenGate = Math.max(0, Math.min(1, v / 100));
        return;
      }
      if (FINALE[m.id]) {
        // linear onto each of its levels: 0 silent (or its own bottom), 100
        // the finale's own; each level's variance multiplies whatever this
        // sets
        const v = +m.v;
        if (!isFinite(v)) return;
        const u = Math.max(0, Math.min(100, v)) / 100;
        for (const [key, top, toPos, bottom = 0, ratio] of FINALE[m.id]) {
          const c = byId(key);
          if (c) c.set(S, toPos(ratio ? bottom * Math.pow(top / bottom, u) : bottom + u * (top - bottom)));
        }
        return;
      }
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
      else if (m.id === 'slideRate') {
        // 0 is a stop, not a slow: the slide is held paused live (as the
        // Journey window's slide button does) and let go again when the
        // fader leaves the bottom. A cue change clears the hold by itself
        // (gpu/slides.js), so the next cue plays as authored.
        const v = Math.max(0, Math.min(c.max, Math.round(+m.v)));
        if (!isFinite(v)) return;
        c.set(S, v);
        if (v === 0) {
          if (slidesLiveState() === 1) { toggleSlidePlayLive(); speedStopped = true; }
        } else if (speedStopped) {
          speedStopped = false;
          if (slidesLiveState() === 2) toggleSlidePlayLive();
        }
      }
      else if (m.id === 'vol') {
        // the fader's squared taper (see the table above). The control's own
        // position is not rounded to a whole percent here: at the quiet end
        // whole percents would step in chunks of several dB.
        const v = +m.v;
        if (!isFinite(v)) return;
        const u = Math.max(0, Math.min(1, v / 100));
        c.set(S, Math.round(u * u * 100000) / 1000);
      }
      else {
        const v = +m.v;
        if (!isFinite(v)) return;
        // Use the control's step: resonance arrives in half dB, not whole dB.
        const step = c.step > 0 ? c.step : 0;
        const clamped = Math.max(c.min, Math.min(c.max, v));
        const snapped = step ? c.min + Math.round((clamped - c.min) / step) * step : clamped;
        c.set(S, Math.max(c.min, Math.min(c.max, snapped)));
      }
    } else if (m.k === 'duck') {
      const amt = Math.max(0, Math.min(1, +m.amt || 0));
      const sec = m.on ? +m.dn : +m.up;
      const mul = m.on ? 1 - amt : 1, dur = isFinite(sec) && sec >= 0 ? sec : 0.2;
      setDuck(mul, dur);
      setHeartDuck(mul, dur);
      setHumDuck(mul, dur);
    }
  }
  for (const b of bases) all.push(socket(b.base, b.name, CMD_ROOM, 'follow', take, null));

  // ---------- status out ----------
  const SID = Math.random().toString(36).slice(2, 10);
  let q = 0, lastSig = '';
  const get = id => { const c = byId(id); return c && c.get ? c.get(S) : null; };
  const playingNow = () => { const st = slidesLiveState(); return st ? st === 1 : !!get('slidePlay'); };
  function statusMsg() {
    const pr = slidesProgress();
    return {
      t: 'state', k: 'step',
      i: journeyPlayIdx(), n: journeyCount(), p: journeyPlaying(),
      // Lets a controller distinguish pre-command reports from replies.
      ack: Object.fromEntries(lastN),
      cv: Array.from({ length: journeyCount() }, (_, i) => {
        const o = journeyStepAt(i)?.overrides || {};
        const rate = slideElementRate(slideRateFromPos(o.slideRate ?? get('slideRate')));
        return { f: o.slideFile ?? S.slideFile, r: rate,
          p: o.slidePlay ?? S.slidePlay !== false, l: o.slideLoop ?? S.slideLoop === true };
      }),
      vp: pr ? { t: Math.round(pr.t * 100) / 100, d: Math.round(pr.d * 100) / 100, r: Math.round(pr.r * 1000) / 1000,
        f: pr.f || S.slideFile, l: pr.l === true } : null,
      sl: { rate: speedStopped && slidesLiveState() === 2 ? 0 : get('slideRate'), vol: Math.round(Math.sqrt(Math.max(0, Math.min(1, +S.volume || 0))) * 1000) / 10, lp: get('lpf'), hp: get('hpf'), lr: get('lpfRes'), hr: get('hpfRes'), fg: get('filterGlide'), hm: get('heartMaster'), mw: get('mwtsVolume'),
            gt: Math.round(Math.max(0, Math.min(1, +S.screenGate)) * 1000) / 10,
            ch: finalePos('finaleChoir'), dr: finalePos('finaleDrone'), pn: finalePos('finalePiano'), am: finalePos('finaleAmb'), hu: finalePos('finaleHum'), su: finalePos('finaleSun'),
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
  return () => {
    for (const request of healthRequests.values()) {
      const socket = statusSocks.find(s => s.name === request.path);
      if (socket) socket.send(JSON.stringify({ t: 'word', k: 'health', src: SID, to: request.to, probe: request.probe }));
    }
    healthRequests.clear();
  };
}
