// The Sun layer's sound: the rotational hum beneath the light. 62.8 years of
// hourly solar wind speed as one looping tone (1 hour = 1 audio sample),
// lowpass-filtered, given a room and speed-scaled. This is
// meditatewiththesun.com's own engine (documents/sunaudio-site-reference.js,
// the site's SunAudio), ported to a module: the decode, the stitch, the seam
// smoothing, the buffer, the filter and the source handling are the site's,
// kept as they are, and the site's own header says the decode, stitch and
// seam mirror its listen page exactly, so keep them in sync with it. What is
// gone is the site's ?audiodebug overlay (it drew into the document), its
// ?nohum switch, both diagnostics, and (below) its own context and room.
//
// It plays as a music voice, on the music family's context and into its
// master (js/heart/route.js: Heart's music island by default, the app's own
// context under ?heart=off), so it is mixed, paused and woken like the
// piano. The family master runs into js/audio.js's volGain, so the app's
// Master volume, the global Lowpass and Highpass, the transport's ramps and
// the pause gate all reach it there, and the hum keeps no copy of any of
// them. Its room is the music's own, the reverb every music voice shares
// (js/room.js), which is built as the app's audio comes up, whatever the
// Music switch says, and hands itself over (setHumBus); only in the moment
// before that does the hum play dry.
//
// The site plays at 48 kHz, and one hour is one sample, so the hum's pitch IS
// the sample rate: played at the app's rate (often 44.1 kHz) every speed
// would sound about 8% low against the site's. So the buffer is made at
// 48 kHz whatever the context runs at, and the source resamples it: native
// Web Audio does, and so does Heart (heart/src/nodes/buffer_source.rs, whose
// rate is playbackRate times buffer rate over context rate). Every time and
// rate here is therefore in the site's own 48 kHz terms.
//
// Lazy: nothing is fetched or built until the hum is first asked to play.
// Every call is harmless where there is no AudioContext (the engine worker,
// which runs the schema's set() calls too; the page's copy makes the sound).
//
// PORTABILITY: like core/heartbeat.js, this reaches the browser's audio
// directly; it belongs behind a platform hook when one is added. It never
// touches the document.

import { S } from '../js/state.js';
import { getContext, getMaster, sourceGate, ensureAudioGraph } from '../js/audio.js';
import { ctxFor } from '../js/heart/route.js';
import { meterTap, tapPeak } from '../js/util.js';

const DATA_URL = 'audio/solar_wind_speed_hourly.u16';
const HOURS_PER_YEAR = 8766;      // 365.25 * 24
const BIG_GAP_HOURS = 168;        // >= 7 days is a hole worth cutting
const SEAM_HALF = 4;              // splice de-click half-window, in samples
const SITE_RATE = 48000;          // the site's context rate, and the buffer's (above)

const G = globalThis;
const AC = G.AudioContext || G.webkitAudioContext;

let values = null, hourOf = null; // the stitched series (see stitch())
// The graph, on `ctx` (the music family's context, see familyCtx): the
// source and its envelope, the site's filter, the swell that brings the hum
// in, the channel gain (its volume and the mix gate), the pause gate, the
// meter's tap, and the dry and wet legs.
let ctx = null, buffer = null, filter = null, swell = null, chan = null, pgate = null;
let tap = null, dry = null, wet = null;
let src = null, env = null;

let playing = false, everPlayed = false;
let cutoffTarget = 376;           // matches the sun face's resting x (~0.25)
let rate = 0.5;                   // resting rate = bottom of the sun-face drag
let anchorPos = 0, anchorTime = 0, pausedPos = 0;

let volume = 0.9;                 // the hum's own gain, 0..2
let gate = 1;                     // the mix gate's mute and solo, 0 or 1 (setGate)
let duckMul = 1;                  // the show remote's Duck, 0..1 (setHumDuck)
let mwtsMul = 1;                  // the MWTS master, 0..1 (setMwts)
let verbMix = 0.3;                // wet/dry into the music room (setReverbMix)

// The music room (js/room.js), handed over by setHumBus: its context and
// its input, and whether the wet leg plays into it yet.
let roomCtx = null, roomIn = null, roomPlugged = false;

// Whether the layer wants the hum (play() before the data is in still
// counts), and the data's one fetch.
let wanted = false, loading = null, loadFailed = false;

function warn(msg, e) {
  console.warn('sun hum: ' + msg + (e ? ': ' + (e && e.message ? e.message : e) : ''));
}

// ---- decode (identical to the site's app.js) ----

function readHeader(buf) {
  const dv = new DataView(buf);
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(dv.getUint8(i));
  if (magic !== 'SOLARHUM') throw new Error('bad magic: ' + magic);
  return {
    code:   dv.getUint8(8),
    count:  dv.getUint32(20, true),
    scale:  dv.getFloat32(24, true),
    offset: dv.getFloat32(28, true),
  };
}

function decodeU16(buf, h) {
  const q = new Uint16Array(buf, 32, h.count);
  const cs = Math.round(h.scale * 10000);
  const co = Math.round(h.offset * 10000);
  const out = new Float32Array(h.count);
  for (let i = 0; i < h.count; i++)
    out[i] = q[i] === 0xffff ? NaN : (co + q[i] * cs) / 10000;
  return out;
}

function stitch(speeds) {
  const n = speeds.length;
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(speeds[i])) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) throw new Error('no valid samples');

  let kept = 0, prev = -1;
  for (let i = first; i <= last; i++) {
    if (Number.isNaN(speeds[i])) continue;
    const gap = prev < 0 ? 0 : i - prev - 1;
    if (gap > 0 && gap < BIG_GAP_HOURS) kept += gap;
    kept++;
    prev = i;
  }

  const vals = new Float32Array(kept), hrs = new Uint32Array(kept);
  let k = 0;
  prev = -1;
  for (let i = first; i <= last; i++) {
    if (Number.isNaN(speeds[i])) continue;
    const gap = prev < 0 ? 0 : i - prev - 1;
    if (gap > 0 && gap < BIG_GAP_HOURS) {
      const a = speeds[prev], step = (speeds[i] - a) / (gap + 1);
      for (let j = 1; j <= gap; j++) {
        vals[k] = a + step * j;
        hrs[k] = prev + j;
        k++;
      }
    }
    vals[k] = speeds[i];
    hrs[k] = i;
    k++;
    prev = i;
  }
  return { vals, hrs };
}

// ---- audio graph ----

// The music family's context: the one the music room was built on, once
// js/room.js has handed it over (setHumBus), so the wet leg can always reach
// that room; until then the family's own (js/heart/route.js), and the app's
// native context when no family plays on Heart. Its master follows the
// context, so the two always belong to the same engine.
const familyCtx = () => roomCtx || ctxFor('music') || getContext();
const masterOf = c => c && c.isHeart ? c.destination : getMaster();

// "Now" for anything scheduled: on Heart a stage renders ahead of the
// clock, and a call anchored at currentTime is heard from presentTime, a
// lookahead later (js/heart/nodes.js, late gestures). Reading the present
// keeps the source's start ahead of the render horizon and every anchor on
// the clock its sound is actually heard by. Natively it is currentTime.
const now = () => ctx.presentTime ?? ctx.currentTime;

function buildGraph() {
  if (ctx) return;
  const c = familyCtx(), master = masterOf(c);
  if (!c || !master) return;
  ctx = c;

  filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.707;
  filter.frequency.value = Math.min(cutoffTarget, 0.45 * ctx.sampleRate);

  // The swell the hum comes in on (startPlaying): the site's output gate
  // opened over a second the visit's first time and 0.4 s on each later
  // play, and the switch keeps that feel. Born silent.
  swell = ctx.createGain();
  swell.gain.value = 0;
  // The hum's channel: its volume times the mix gate and the Duck
  // (setVolume, setGate, setHumDuck), ahead of the split, so a mute, a solo
  // or a duck reaches the room's feed too.
  chan = ctx.createGain();
  chan.gain.value = chanLevel();
  // The pause gate (js/audio.js), ahead of the split as well, so a pause
  // stops the hum reaching the speakers and the room alike while the room
  // rings on, and the meter falls silent with it.
  pgate = ctx.createGain();
  sourceGate(pgate.gain);
  filter.connect(swell).connect(chan).connect(pgate);

  // The Levels window's meter (humPeak): post-fader, post-gate, post-duck
  // and pre-room, the point the music's own meters read (js/util.js meterTap),
  // feeding the dry and wet legs.
  dry = ctx.createGain();
  wet = ctx.createGain();
  tap = meterTap(ctx, dry, wet);
  pgate.connect(tap.analyser);
  // The graph is BORN in the mix's current state, so no swell on load; with
  // no room yet it is all dry (applyVerb).
  const m0 = roomPlugged ? verbMix : 0;
  dry.gain.value = Math.cos(m0 * Math.PI / 2);
  wet.gain.value = Math.sin(m0 * Math.PI / 2);
  dry.connect(master);

  if (values) buildBuffer();
  plugRoom();
}

// The wet leg into the music room, once the room exists on this context.
// The room's input carries no gate of its own (js/room.js): the hum's
// pause gate, ahead of the split, is the one that closes its feed on a
// pause, while the room rings on. Arriving, the mix
// crossfades from all dry to its setting, as a room switched on does.
function plugRoom() {
  if (!wet || roomPlugged || !roomIn || roomCtx !== ctx) return;
  wet.connect(roomIn);
  roomPlugged = true;
  applyVerb(0.25);
}

// Let go of the graph: the source stops (its place kept), and the legs
// leave the master and the room. The pause gate keeps its registration in
// audio.js, harmlessly, on a gain nothing plays through any more.
function teardown() {
  if (!ctx) return;
  if (src) stopSource();
  playing = false;
  for (const n of [dry, wet, pgate, chan, swell, filter]) {
    try { n && n.disconnect(); } catch (e) {}
  }
  ctx = null; buffer = null; filter = null; swell = null; chan = null; pgate = null;
  tap = null; dry = null; wet = null; src = null; env = null;
  roomPlugged = false;
}

// The channel's level: the hum's volume, its mix gate, the Duck and MWTS.
const chanLevel = () => volume * gate * duckMul * mwtsMul;

function hold(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
  }
}

// The wet/dry pair always move together, equal-power, and always by
// APPROACH rather than assignment: `tau` is the time constant, ~0.03 for a
// fader (instant to the hand) and ~0.25 for the room arriving, three
// quarters of a second of swell, so the walls arrive rather than blink.
// Until the music room exists the hum is all dry: the mix's wet share
// waits for somewhere to go.
function applyVerb(tau) {
  if (!dry || !ctx) return;
  const m = roomPlugged ? verbMix : 0;
  const t = now();
  dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), t, tau);
  wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), t, tau);
}

const latency = () => ctx.outputLatency || ctx.baseLatency || 0;
const dur = () => buffer.length / buffer.sampleRate;

function currentPos() {
  if (!playing || !src) return pausedPos;
  let p = anchorPos + (now() - anchorTime) * rate;
  return p % dur();
}

function startSource(offsetSec) {
  src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rate;
  env = ctx.createGain();
  env.gain.value = 0;
  src.connect(env).connect(filter);
  // The lead is the whole game. A 10ms lead is shorter than the main
  // thread can stall for right after the graph and the buffer have been
  // built, and a start time that lands in the PAST makes the browser begin
  // instantly with the fade-in already elapsed, so the first sample arrives
  // at full amplitude: the click. 80ms is imperceptible as latency and
  // safely past any render quantum. Read the clock as late as possible,
  // after the nodes exist.
  const at = now() + 0.08;
  src.start(at, offsetSec % dur());
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(1, at + 0.04);    // a fade, not an edge
  anchorPos = offsetSec;
  anchorTime = at + latency();
  return at;
}

function stopSource() {
  if (!src) return;
  const t = now();
  pausedPos = currentPos();
  const s = src, e = env;
  src = null; env = null;
  e.gain.cancelScheduledValues(t);
  e.gain.setValueAtTime(e.gain.value, t);
  e.gain.linearRampToValueAtTime(0, t + 0.02);
  try { s.stop(t + 0.05); } catch (err) { /* already stopped */ }
  s.onended = () => { try { e.disconnect(); } catch (err) {} };
}

// The source, and the swell it comes in on: the visit's first sound swells
// over a second, a later play over 0.4 s, a swell and not a switch, since
// this is a room you sit in. From a set 0.0001 at the source's own start.
function sound() {
  const at = startSource(pausedPos);
  const rise = everPlayed ? 0.4 : 1.0;
  everPlayed = true;
  swell.gain.cancelScheduledValues(now());
  swell.gain.setValueAtTime(0.0001, at);
  swell.gain.exponentialRampToValueAtTime(1, at + rise);
}

// The site's play(), once the data and the graph are in. Waking the context
// is the app's (js/audio.js, on the viewer's gestures); a hum asked for
// while it sleeps is armed and starts the moment it runs.
//
// THE CLICK: starting the source on a suspended context schedules its
// fade-in against a FROZEN clock. When the browser finally resumes,
// currentTime leaps past those times, the envelope is already at 1, and the
// very first audible sample lands at full amplitude on an arbitrary point of
// the waveform: a pop. So the source waits until the context is genuinely
// running.
let armedOn = null;
function startPlaying() {
  if (!values || playing) return;
  buildGraph();
  if (!ctx) return;
  if (!buffer) buildBuffer();     // the graph may have been built dataless
  playing = true;
  if (ctx.state === 'running') { sound(); return; }
  if (armedOn === ctx) return;
  const c = armedOn = ctx;
  const armed = () => {
    if (c !== ctx || c.state !== 'running') return;
    c.removeEventListener('statechange', armed);
    armedOn = null;
    if (playing && !src) sound();
  };
  c.addEventListener('statechange', armed);
}

// The buffer IS the series, mean-removed, seams smoothed, peak-normalized.
// Made at the site's 48 kHz whatever the context's rate (see the top), and
// an AudioBuffer belongs to no context, so a graph rebuilt on another one
// (setHumBus) plays the same buffer. Split from buildGraph so the graph can
// stand before the data has arrived; the buffer joins it once both exist.
function buildBuffer() {
  const n = values.length;
  buffer = ctx.createBuffer(1, n, SITE_RATE);
  const ch = buffer.getChannelData(0);

  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  for (let i = 0; i < n; i++) ch[i] = values[i] - mean;

  // Cancel each dropped-gap step with an additive raised-cosine correction
  // (see the site's app.js for the full story). Deltas read before any
  // correction lands.
  const seamAt = [], seamDelta = [];
  for (let b = 1; b < n; b++) {
    if (hourOf[b] === hourOf[b - 1] + 1) continue;
    seamAt.push(b);
    seamDelta.push((ch[b] - ch[b - 1]) * 0.5);
  }
  for (let s = 0; s < seamAt.length; s++) {
    const b = seamAt[s], half = seamDelta[s];
    for (let j = 0; j < SEAM_HALF; j++) {
      const g = 0.5 * (1 + Math.cos(Math.PI * (j + 0.5) / SEAM_HALF));
      if (b - 1 - j >= 0) ch[b - 1 - j] += half * g;
      if (b + j < n) ch[b + j] -= half * g;
    }
  }

  let peak = 1e-12;
  for (let i = 0; i < n; i++) {
    const a = ch[i] < 0 ? -ch[i] : ch[i];
    if (a > peak) peak = a;
  }
  const k = 1 / peak;
  for (let i = 0; i < n; i++) ch[i] *= k;
}

// The site's load(): the series, decoded and stitched, fetched once.
function load() {
  if (values) return Promise.resolve();
  if (!loading) {
    loading = fetch(DATA_URL)
      .then(res => {
        if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buf => {
        const h = readHeader(buf);
        if (h.code !== 2) throw new Error('expected u16 format code 2, got ' + h.code);
        const s = stitch(decodeU16(buf, h));
        values = s.vals;
        hourOf = s.hrs;
      })
      .catch(e => { loadFailed = true; warn('the solar wind data could not load; the hum stays silent', e); });
  }
  return loading;
}

// ---- public face ----

// Whether this thread can make the hum at all (an engine worker has no
// AudioContext; the page's copy of the schema makes the sound there).
export const humAvailable = () => !!AC && !loadFailed;
export const humPlaying = () => playing;

/** Fetch the data and build the graph on the music family's context. The
    app's audio graph is asked for first (js/audio.js ensureAudioGraph, which
    needs no gesture), since it is what starts Heart: a graph built before
    the engine has settled would be built natively. Resolves once both are
    in. */
export function ensure() {
  if (!AC || loadFailed) return Promise.resolve();
  return Promise.all([load(), ensureAudioGraph()]).then(() => { buildGraph(); });
}

/** Start (or keep) the hum. Lazy: the first call fetches the data and
    builds the graph, and the hum starts the moment both are in, if it is
    still wanted then. It is heard while the transport runs, like every
    music voice: the pause gate closes on it, and it plays on, silent,
    underneath. */
export function play() {
  if (!AC) return;
  wanted = true;
  if (playing) return;
  ensure().then(() => { if (wanted) startPlaying(); });
}

/** Stop the hum: the source fades out as the site's pause does, and the
    room's tail rings out in the music room. The place in the series is kept
    for the next play. */
export function pause() {
  wanted = false;
  if (!playing) return;
  playing = false;
  stopSource();
}

/** Ramp the hum to silence, room feed and all, for the moments before a
    page reload. What is already in the room is the room's. */
export function hush(seconds = 0.12) {
  if (!swell) return;
  const t = now();
  hold(swell.gain, t);
  swell.gain.linearRampToValueAtTime(0, t + seconds);
}

/** Raw buffer playback rate, in the site's 48 kHz terms (the buffer is
    48 kHz on any context). 1 hour of sun = 1 sample, so a rate of 1 is
    ~5.48 years per second. */
export function setRate(r) {
  if (r === rate) return;
  if (playing && src) {
    anchorPos = currentPos();
    anchorTime = now() + latency();
    src.playbackRate.setValueAtTime(r, now());
  }
  rate = r;
}

/** Data-time velocity. 1 yr/s = playbackRate 0.183. */
export function setYearsPerSecond(yps) {
  setRate((yps * HOURS_PER_YEAR) / SITE_RATE);
}

// The Cutoff setting's map, the site's: 0 to 1 over 100 Hz to 10 kHz,
// logarithmic. Here rather than in the schema so the Cutoff's variance
// (core/sun-hum-vary.js, which moves it many times a second) can reach it
// without importing the schema's ring.
export const CUTOFF_LO = 100, CUTOFF_HI = 10000;
export const cutoffHz = v => CUTOFF_LO * Math.pow(CUTOFF_HI / CUTOFF_LO, v);

// The filter's corner, approached with time constant tau: 10 ms for a hand
// on the slider, and the time since its last push for the variance, so a
// push every frame or every timer tick glides from one to the next.
export function setCutoffHz(hz, tau = 0.01) {
  if (hz === cutoffTarget) return;
  cutoffTarget = hz;
  if (filter)
    filter.frequency.setTargetAtTime(
      Math.min(hz, 0.45 * ctx.sampleRate), now(), tau);
}

/** The hum's own volume, 0..2: above 1 the gain simply boosts past the
    source's own level (the tone is a smooth rumble with headroom, so a
    clean 2x). Smoothed so slider drags never zipper. The app's Master
    volume is not in it: the family master plays through that already. */
export function setVolume(v) {
  if (v === volume) return;
  volume = v;
  if (chan) chan.gain.setTargetAtTime(chanLevel(), now(), 0.02);
}

/** The MWTS master (the controller's MWTS fader, S.mwtsVolume): a
    multiplier, 0..1, on the hum's whole contribution, the same ride as the
    Duck's. It is a shared sun field, so the broadcast carries it and every
    follower's hum fades with the room's phones. */
export function setMwts(v) {
  v = typeof v === 'number' && v === v ? (v < 0 ? 0 : v > 1 ? 1 : v) : 1;
  if (v === mwtsMul) return;
  mwtsMul = v;
  if (chan) chan.gain.setTargetAtTime(chanLevel(), now(), 0.02);
}

/** The mix gate (js/mixgate.js), 1 open or 0 closed by a mute or another
    channel's solo: a multiplier on the hum's own level, its feed into the
    room included. */
export function setGate(g) {
  if (g === gate) return;
  gate = g;
  if (chan) chan.gain.setTargetAtTime(chanLevel(), now(), 0.02);
}

/** The controller's Duck (platform/presentation-receiver.js, the slides' setDuck
    and the heartbeat's setHeartDuck pattern): a multiplier, 0..1, on the
    hum's whole contribution, dry and room feed alike, since it rides the
    channel ahead of the split; what is already in the room decays on its
    own. It glides the live gain at once, an exponential approach whose time
    constant is seconds / 3 (default 0.2 s), and every later setVolume and
    setGate keeps honouring it. Not saved: a reload is unducked. */
export function setHumDuck(mul, seconds) {
  duckMul = typeof mul === 'number' && mul === mul ? (mul < 0 ? 0 : mul > 1 ? 1 : mul) : 1;
  if (!chan || !ctx) return;
  const sec = typeof seconds === 'number' && seconds >= 0 && seconds <= 10 ? seconds : 0.2;
  chan.gain.setTargetAtTime(chanLevel(), now(), Math.max(0.003, sec / 3));
}

/** The hum's peak, 0..1+, for the Levels window's meter: post-fader,
    post-gate, post-duck, pre-room: what is heard. A suspended context keeps returning the last block
    it rendered, so the transport decides whether there is anything to show,
    as it does for the music's meters. */
export function humPeak() {
  if (!tap || !playing || !S.running || !S.audioEnabled || getContext()?.state !== 'running') return 0;
  return tapPeak(tap);
}

/** Wet/dry into the music room, 0..1, crossfaded equal-power so loudness
    holds steady: at 1 the hum is all room, no dry left. The Reverb mix
    setting; cheap when unchanged, so its variance can set it many times a
    second, tau then the time since its last push (core/sun-hum-vary.js).
    Until the room exists the hum plays dry and the mix waits (applyVerb). */
export function setReverbMix(m, tau = 0.03) {
  if (m === verbMix) return;
  verbMix = m;
  applyVerb(tau);
}

/** The music room, from js/room.js as it is built (and rebuilt): its context
    and its input. On the context the hum already plays on, the wet leg
    plugs in. On another (the hum built first, on a context the room did
    not end up on), the hum moves to the room's: its graph and buffer are
    rebuilt there, and a playing hum carries on from its place. */
export function setHumBus(c, revIn) {
  roomCtx = c; roomIn = revIn;
  if (!ctx) return;
  if (ctx === c) { plugRoom(); return; }
  const was = playing;
  teardown();
  buildGraph();
  if (was && wanted) startPlaying();
}

/** Tear the whole graph down. The context is the music family's and stays;
    the decoded series is kept, so a later play() rebuilds without fetching
    again. */
export function dispose() {
  wanted = false;
  const c = ctx;
  if (!c) return;
  if (playing) { playing = false; stopSource(); }
  hush(0.12);
  // after the hush has landed, so nothing is cut mid-wave
  setTimeout(() => { if (ctx === c && !wanted) { teardown(); pausedPos = 0; } }, 160);
}
