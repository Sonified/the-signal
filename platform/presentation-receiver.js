// The show remote's receiving end: Presence (this app, on the laptop) taking
// cues from the iPad's show controller (controller.html at the repo root). Off
// unless the page is opened with ?presentation (room 'show') or ?presentation=<room> (?remote, its first name, still works).
// Page thread only (main.js calls initPresentationReceiver outside worker mode): the
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
// controller.html keep), seeded once by opening the page with ?presentation&pw=<password>
// (pw, not key: a bare ?key= is the demo broadcast's own passphrase seed,
// platform/broadcast-socket.js, and would overwrite it). The pw parameter is
// wiped from the address bar once stored.
//
// App health uses transient {t:'word', k:'health', src, probe} requests on
// each route, answered at once on that route's status socket with
// {t:'word', k:'health', src, to, probe}. Health requests bypass command
// numbering and never edit settings. The dot says this page hears the iPad,
// even with its window behind another (which pauses its frames).
//
// COMMANDS (controller.html -> here), each {t:'word', src, n, k, ...}. The sender
// rides as src, never id: a ctl's id is the control's (the first build put
// the sender in id too, overwriting it, so every ctl was refused):
//   {k:'jump', i}       journeyJumpTo(i), i 0-based (the step already playing
//                       is left alone, as a digit key or MIDI note does)
//   {k:'next'}/{k:'prev'}  journeyStepBy(+1 / -1)
//   {k:'seek', f}       the playing cue tapped again: its slide video to
//                       share f (0..1) of its length (gpu/slides.js seekSlide);
//                       a broadcast's followers seek theirs too (core/broadcast.js
//                       broadcastSeek)
//   {k:'clean'}         the title tapped: the drawer and every window shut
//                       (main.js's clearScreen hook), only the playback left
//   {k:'hall', p, r}    a drawing cue: the hall's phase (solo, master, pairs,
//                       quads, halves, all) and round (1 or 2) named outright
//                       (core/brush.js brushShowPhase); only a screen opened
//                       conducting a hall (?hall=<name>&conduct=<key>) moves
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
//                         finaleSun,
//                         finaleWind
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
//                                                Breath Amount 0..67%. WIND,
//                                                beside SUN: the Sun's
//                                                Feedback Amount 0..83% and
//                                                Opacity 0..36%, the rings'
//                                                opacity 0..29% over the top
//                                                half, the flowers' 0..15%
//                                                over the top quarter)
//   {k:'duck', on, amt, dn, up}  the duck (gpu/slides.js setDuck, the
//                       heartbeat's setHeartDuck and the Sun hum's
//                       setHumDuck, the same multiplier): on, the slides',
//                       the heartbeat's and the hum's gains fall to
//                       (1 - amt) over dn seconds; off, back to full over
//                       up seconds
// The journey moves regardless of the Journey window or ACTIVE (a remote is
// opted into by its URL, so nothing else gates it).
//
// Controls save the live session and broadcast it through their schema
// setters, inside journeyPerformanceControl. That keeps them out of both
// the authoring recorder and the walk-wide manual holds, takes any current
// glide, and protects them from a later unrelated drawer save. Snapshot in
// the Journey window explicitly captures those live changes into a step.
// From the iPad a Speed move lasts until the next cue; vol, lpf and hpf are
// never held by a cue (core/journey.js), so they last until moved.
// The slides' own level (Master slide volume, slideVolume) is the laptop's
// and is never sent from here.
//
// STATUS (here -> controller.html): a second pair of sockets, this page the
// broadcaster of 'mirror-<room>-status', sends
//   {t:'state', k:'step', i, n, p, vp, sl, src, q}
// whenever any of it changes (polled 4x a second) and as each path opens:
// i the journey's current step (-1 none), n journeyCount(), p whether the
// walk plays, sl the faders' controls in the same units as above
// {vol: vol, rate: slideRate, lp: lpf, hp: hpf, lr: lpfRes, hr: hpfRes, fg: filterGlide, hm: heartMaster, mw: mwtsVolume, gt: screenGate, ch: finaleChoir, dr: finaleDrone, pn: finalePiano, am: finaleAmb, hu: finaleHum, su: finaleSun, wi: finaleWind, play, on} (play: what is actually happening, the
// live hold included), vp the slide video's place {t, d, r, f, l} (seconds in,
// its length, the rate it advances at, 0 when held; null with no video of
// known length; the iPad fills the playing cue with it, running on between
// reports at r; f is the actual file, l its loop setting), src/q this page's sender id and sequence.
// It goes as a 'state' rather than a 'word' so each relay keeps the latest
// and hands it to an iPad that joins late.

import { S } from '../js/state.js';
import { byId } from '../core/schema.js';
import { journeyJumpTo, journeyStepBy, journeyCount, journeyPlayIdx, journeyPlaying, journeyPerformanceControl } from '../core/journey.js';
import { idleWake } from '../core/idle.js';
import { broadcastSeek } from '../core/broadcast.js';
import { idleTouch } from '../js/idle-ahead.js';
import { setDuck, slidesLiveState, toggleSlidePlayLive, slidesProgress, seekSlide } from '../gpu/slides.js';
import { setHeartDuck } from '../core/heartbeat.js';
import { setHumDuck } from '../core/sun-hum.js';
import { brushShowPhase, brushConducting, brushPhase, brushRound, brushDealHold } from '../core/brush.js';
import { PRESENT_PASSWORD } from '../core/presentation.js';
import { ampToPos } from '../js/util.js';

const CLOUD = 'the-signal-broadcast.robertalexander-music.workers.dev';
const CTL_IDS = new Set(['vol', 'lpf', 'hpf', 'lpfRes', 'hpfRes', 'filterGlide', 'slideRate', 'slidePlay', 'slideRestart', 'slideXfade', 'heartMaster', 'mwtsVolume']);
// the hall's phases (broadcast-worker/src/groups.js PHASES, which the app
// never imports), the drawing cues' words
const HALL_PHASES = new Set(['solo', 'master', 'pairs', 'quads', 'halves', 'all']);
const STATUS_MS = 250;
const setLive = (c, value) => journeyPerformanceControl(c.id, () => c.set(S, value));
// The finale row's faders (and SUN and WIND beside SCREEN): per fader, the
// settings it moves together, each { key: the S key, which is also its
// control's id; top: its value at the fader's 100% (the finale's own);
// pos: the control's position for a value; bottom: its value where it
// starts (0, silent, when left out); from: where on the fader (0..1) it
// starts to move, held at bottom below that (0 when left out); ratio: true
// to lay it evenly in ratio, each doubling the same stretch, instead of
// linearly }. The first is the one reported back to the iPad.
const pct = a => a * 100;
const FINALE = {
  finaleChoir: [{ key: 'choirVol', top: 1.38, pos: pct }],
  finalePiano: [{ key: 'pianoVol', top: 1, pos: pct }],
  finaleAmb: [{ key: 'ambVol', top: 0.18, pos: pct }],
  finaleDrone: [{ key: 'bedVol', top: 0.55, pos: pct }, { key: 'toneVol', top: 0.19054607179632474, pos: ampToPos },
                { key: 'cloudVol', top: 1, pos: pct }],
  // the Sun hum's Speed, 1x at the bottom and 2x at the top, linear in the
  // control's own log setting (core/schema-sun.js: 0.5x..16x over 0..1, so
  // 1x is 0.2 and 2x 0.4), even in pitch: 1.41x halfway
  finaleHum: [{ key: 'sunHumRate', top: 0.4, bottom: 0.2, pos: a => a * 1000 }],
  // SUN, beside SCREEN: the video's baseline Speed 2x to 8x, even in ratio
  // as its own slider moves (core/schema-sun.js: log 1x..16x over 0..1000,
  // so 4x halfway), with Speed's variance 0 to 78%, Atmosphere's variance
  // (the Breath drawer's old Amount) 0 to 67%, and the Rotational hum's
  // Cutoff variance 0 to 94% and Reverb mix variance 0 to 72%
  finaleSun: [{ key: 'sunSpeed', top: 8, bottom: 2, ratio: true, pos: a => Math.log(a) / Math.log(16) * 1000 },
              { key: 'sunSpeedVar', top: 0.78, pos: pct }, { key: 'sunAtmoVar', top: 0.67, pos: pct },
              { key: 'sunHumCutoffVar', top: 0.94, pos: pct }, { key: 'sunHumVerbVar', top: 0.72, pos: pct }],
  // WIND, beside SUN: the Sun's Feedback Amount 0 to 83% and Opacity 0 to
  // 36% over the whole fader, the rings' opacity 0 to 29% over its top
  // half, the flowers' opacity 0 to 15% over its top quarter
  finaleWind: [{ key: 'sunFbAmt', top: 0.83, pos: pct }, { key: 'sunFbOpacity', top: 0.36, pos: pct },
               { key: 'ringOpacity', top: 0.29, from: 0.5, pos: pct },
               { key: 'flowerOpacity', top: 0.15, from: 0.75, pos: pct }]
};
// where a fader at u (0..1) puts one of its settings
const finaleValue = (e, u) => {
  const bottom = e.bottom || 0, from = e.from || 0;
  const w = Math.max(0, (u - from) / (1 - from));
  return e.ratio ? bottom * Math.pow(e.top / bottom, w) : bottom + w * (e.top - bottom);
};
// a fader's place, 0..100, read back from its first setting
const finalePos = id => {
  const e = FINALE[id][0], bottom = e.bottom || 0, from = e.from || 0, v = +S[e.key] || 0;
  const w = e.ratio ? (v > 0 ? Math.log(v / bottom) / Math.log(e.top / bottom) : 0) : (v - bottom) / (e.top - bottom);
  return Math.round(Math.max(0, Math.min(1, from + Math.max(0, Math.min(1, w)) * (1 - from))) * 1000) / 10;
};

export function initPresentationReceiver(hooks = {}) {
  if (typeof location === 'undefined' || typeof WebSocket === 'undefined') return;
  const P = new URLSearchParams(location.search);
  // ?presentation makes this tab the controller's receiving end; ?remote,
  // the flag's first name, still opens the door for old links and docs.
  const FLAG = P.has('presentation') ? 'presentation' : P.has('remote') ? 'remote' : '';
  if (!FLAG) return;
  document.title = '🌞 TSC 2026';
  // The hands wait in the wings: a presentation screen holds the brush deal
  // (its own hand and the room's) until the first drawing cue lifts it
  // (core/brush.js brushShowPhase), so nothing of the brushes shows before
  // cue 17, however Show brushes was left.
  brushDealHold(true);
  let room = (P.get(FLAG) || 'show').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^mirror-/, '') || 'show';
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
    const qs = P.toString().replace(new RegExp('(^|&)' + FLAG + '=(?=&|$)'), '$1' + FLAG);
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (e) {}
  }
  // No URL password needed: the presentation's own password (the drawer's
  // gate, core/presentation.js) is the relay's too, so the receiver carries
  // it itself. ?pw= stays as an override should the relay's ever differ.
  if (!KEY) KEY = PRESENT_PASSWORD;
  // A one-off check, for a clear console line; the sockets retry regardless.
  fetch('https://' + relay + '/auth', { method: 'POST', body: KEY }).then(r => {
    if (r.status === 403) console.warn('[presentation-receiver] the relay refused the password; reopen with ?presentation&pw=<password>');
  }, () => {});
  console.log('[presentation-receiver] following ' + CMD_ROOM + ', status to ' + STATUS_ROOM + ' (cloud + local ' + local + ')');

  const bases = [{ name: 'cloud', base: 'wss://' + relay }, { name: 'local', base: 'ws://' + local }];

  // ---------- one reconnecting socket per path and room ----------
  function socket(base, name, roomName, role, onMsg, onOpen) {
    const s = { ws: null, retry: 2000, name };
    const openIt = () => {
      try { s.ws = new WebSocket(base + '/room/' + roomName + '?role=' + role + '&key=' + encodeURIComponent(KEY)); }
      catch (e) { setTimeout(openIt, s.retry); return; }
      s.ws.onopen = () => { s.retry = 2000; console.log('[presentation-receiver] ' + name + ' ' + role + ' ' + roomName + ' open'); if (onOpen) onOpen(s); };
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
    // "Can you hear me?" is answered at once, on the same route's status
    // socket: the dot means this page hears the iPad, whether or not its
    // window is in front drawing frames.
    if (m.k === 'health') {
      if (typeof m.src !== 'string' || typeof m.probe !== 'string' || m.src.length > 128 || m.probe.length > 128) return;
      const reply = statusSocks.find(s => s.name === path.name);
      if (reply) reply.send(JSON.stringify({ t: 'word', k: 'health', src: SID, to: m.src, probe: m.probe }));
      return;
    }
    const id = String(m.src || ''), n = +m.n || 0;
    if (n <= (lastN.get(id) || 0)) return;   // the other path's copy
    lastN.set(id, n);
    if (m.k === 'ctl' && m.id === 'mwtsVolume') console.log('[presentation-receiver] MWTS fader -> mwtsVolume ' + m.v + '%');
    // an audio touch before the remote's commands (js/idle-ahead.js)
    idleTouch('the show remote');
    try { act(m); } catch (err) { console.warn('[presentation-receiver] ' + m.k + ' failed:', err); }
    idleWake('show remote');
    pollStatus();
  }
  // the Speed fader is at 0 and has stopped the slide itself
  let speedStopped = false;
  function act(m) {
    if (m.k === 'jump') {
      // a cue past the journey's end plays the newest step there is: the
      // drawing cues (17 on) jump to steps authored as the show grows, and
      // an unwritten one falls back to the last that exists
      const i = m.i | 0;
      if (i >= 0 && journeyCount() > 0) journeyJumpTo(Math.min(i, journeyCount() - 1));
    }
    else if (m.k === 'clean') { if (hooks.clearScreen) hooks.clearScreen(); }
    else if (m.k === 'seek') {
      // the room's followers go to the same place in the same video
      const pr = slidesProgress();
      seekSlide(+m.f);
      if (pr) broadcastSeek(+m.f, pr.f);
    }
    else if (m.k === 'next') journeyStepBy(1);
    else if (m.k === 'prev') journeyStepBy(-1);
    // a drawing cue: the hall's phase and round, named outright (core/brush.js
    // brushShowPhase; nothing moves unless this screen conducts a hall, and
    // the hall's answer is what lights the chips and the iPad's cue)
    else if (m.k === 'hall') { if (HALL_PHASES.has(m.p)) brushShowPhase(m.p, m.r === 2 ? 2 : 1); }
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
        for (const e of FINALE[m.id]) {
          const c = byId(e.key);
          if (c) setLive(c, e.pos(finaleValue(e, u)));
        }
        return;
      }
      if (!CTL_IDS.has(m.id)) return;
      const c = byId(m.id);
      if (!c) return;
      if (c.kind === 'action') journeyPerformanceControl(c.id, () => { if (c.act) c.act(S); else c.set(S, 1); });
      else if (m.id === 'slidePlay') {
        // PLAY / PAUSE mean exactly that: Play on S, and a live hold on the
        // slide on screen (gpu/slides.js: 1 playing, 2 paused or ended)
        // that says otherwise flipped to agree.
        const on = !!m.v;
        setLive(c, on);
        const st = slidesLiveState();
        if ((on && st === 2) || (!on && st === 1)) toggleSlidePlayLive();
      }
      else if (c.kind === 'toggle') setLive(c, !!m.v);
      else if (m.id === 'slideRate') {
        // 0 is a stop, not a slow: the slide is held paused live (as the
        // Journey window's slide button does) and let go again when the
        // fader leaves the bottom. A cue change clears the hold by itself
        // (gpu/slides.js), so the next cue plays as authored.
        const v = Math.max(0, Math.min(c.max, Math.round(+m.v)));
        if (!isFinite(v)) return;
        setLive(c, v);
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
        setLive(c, Math.round(u * u * 100000) / 1000);
      }
      else {
        const v = +m.v;
        if (!isFinite(v)) return;
        // Use the control's step: resonance arrives in half dB, not whole dB.
        const step = c.step > 0 ? c.step : 0;
        const clamped = Math.max(c.min, Math.min(c.max, v));
        const snapped = step ? c.min + Math.round((clamped - c.min) / step) * step : clamped;
        setLive(c, Math.max(c.min, Math.min(c.max, snapped)));
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
      // the hall this screen conducts: its phase and round, lighting the
      // iPad's drawing cues; null (the cues dim) while it conducts none
      hall: brushConducting() ? { p: brushPhase(), r: brushRound() } : null,
      vp: pr ? { t: Math.round(pr.t * 100) / 100, d: Math.round(pr.d * 100) / 100, r: Math.round(pr.r * 1000) / 1000,
        f: pr.f || S.slideFile, l: pr.l === true } : null,
      sl: { rate: speedStopped && slidesLiveState() === 2 ? 0 : get('slideRate'), vol: Math.round(Math.sqrt(Math.max(0, Math.min(1, +S.volume || 0))) * 1000) / 10, lp: get('lpf'), hp: get('hpf'), lr: get('lpfRes'), hr: get('hpfRes'), fg: get('filterGlide'), hm: get('heartMaster'), mw: get('mwtsVolume'),
            gt: Math.round(Math.max(0, Math.min(1, +S.screenGate)) * 1000) / 10,
            ch: finalePos('finaleChoir'), dr: finalePos('finaleDrone'), pn: finalePos('finalePiano'), am: finalePos('finaleAmb'), hu: finalePos('finaleHum'), su: finalePos('finaleSun'), wi: finalePos('finaleWind'),
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
