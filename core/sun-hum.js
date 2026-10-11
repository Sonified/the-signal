// The Sun layer's sound: the rotational hum beneath the light. 62.8 years of
// hourly solar wind speed as one looping tone (1 hour = 1 audio sample),
// lowpass-filtered, given a room and speed-scaled. This is
// meditatewiththesun.com's own engine (documents/sunaudio-site-reference.js,
// the site's SunAudio), ported to a module: the decode, the stitch, the seam
// smoothing, the buffer, the filter, the room's two ping-ponged convolvers,
// the output gate and the source handling are the site's, kept as they are,
// and the site's own header says the decode, stitch and seam mirror its
// listen page exactly, so keep them in sync with it. What is gone is the
// site's ?audiodebug overlay (it drew into the document) and its ?nohum
// switch, both diagnostics.
//
// Its own AudioContext, at the site's 48 kHz, not the app's shared one
// (js/audio.js getContext). One hour is one sample, so the hum's pitch IS
// the sample rate: on the app's context, at whatever rate the device came up
// with (often 44.1 kHz), every speed would sound about 8% low against the
// site's. The hum also plays whenever the Sun layer and its switch are on,
// whether or not the transport runs, where the app's master and pause gate
// close with the transport. And the site's output gate is driven by its own
// context's lifecycle (statechange opens and closes it, the first run's
// silent route kick, the device-change recycle), which it cannot own on a
// context the rest of the app suspends and resumes for its own reasons. The
// app's context is only listened to: when it starts running, a gesture has
// just woken the sound, and the hum spends that moment on its own unlock.
//
// Lazy: nothing is fetched or built until the hum is first asked to play.
// Every call is harmless where there is no AudioContext (the engine worker,
// which runs the schema's set() calls too; the page's copy makes the sound).
//
// PORTABILITY: like core/heartbeat.js, this reaches the browser's audio (and
// navigator.audioSession, matchMedia, an Audio element as the old phones'
// output) directly; it belongs behind a platform hook when one is added.
// It never touches the document.

import { getContext as appContext } from '../js/audio.js';

const DATA_URL = 'audio/solar_wind_speed_hourly.u16';
const HOURS_PER_YEAR = 8766;      // 365.25 * 24
const BIG_GAP_HOURS = 168;        // >= 7 days is a hole worth cutting
const SEAM_HALF = 4;              // splice de-click half-window, in samples

const G = globalThis;
const AC = G.AudioContext || G.webkitAudioContext;
const NAV = G.navigator;
const mq = q => { try { return !!(G.matchMedia && G.matchMedia(q).matches); } catch (e) { return false; } };

let values = null, hourOf = null; // the stitched series (see stitch())
let ctx = null, buffer = null, filter = null, master = null, outputGate = null;
let mediaOut = null;              // phone output path; see ensureCtx
let src = null, env = null;

let playing = false;
let cutoffTarget = 376;           // matches the sun face's resting x (~0.25)
let rate = 0.5;                   // resting rate = bottom of the sun-face drag
let anchorPos = 0, anchorTime = 0, pausedPos = 0;

// Phones get a smaller room: earbuds and tiny speakers smear long tails.
const COARSE = mq('(pointer: coarse)');

let volume = 0.9;                 // the hum's own gain, 0..2
let masterVol = 1;                // the app's Master volume, 0..1 (setMasterVolume)

let verbMix = COARSE ? 0.21 : 0.3;   // reverb wet/dry (30% drier on touch)
let verbOn = true;                  // the room
let verbSize = COARSE ? 1.75 : 3.5;  // tail seconds to -60 dB (half on touch)
let dry = null, wet = null, verbTimer = 0;
let verbSlots = null, verbActive = 0;   // two convolvers, crossfade-swapped
let lifecycleTimer = 0, outputOpen = false, outputEverOpened = false, routeKicked = false;

// The port's own state, around the site's: whether the layer wants the hum
// (play() before the data is in still counts), the data's one fetch, the
// app context's listener, and when the gate's last close lands.
let wanted = false, loading = null, loadFailed = false, unavailable = false;
let appCtxHooked = null, closeEndsAt = 0, openTimer = 0, onStateChange = null;
// The send into the app's master room (setHumRoom, setRoomSend below): the
// room's context and input as js/piano.js hands them over, the send level,
// and the bridge across the two contexts.
let roomCtx = null, roomIn = null, sendLevel = 0;
let bridgeOut = null, bridgeIn = null, sendGain = null, sendCtx = null, sendTo = null;

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

function ensureCtx() {
  if (ctx) return;
  try { ctx = new AC({ sampleRate: 48000 }); }
  catch (e) { ctx = new AC(); }

  filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.707;
  filter.frequency.value = Math.min(cutoffTarget, 0.45 * ctx.sampleRate);

  // User volume and hardware lifecycle are deliberately separate. The
  // final gate is always born silent, then opens only after the browser's
  // output route is running; this prevents a live waveform/reverb tail from
  // being dropped onto a newly opened device at an arbitrary sample value.
  master = ctx.createGain();
  master.gain.value = volume * masterVol;
  outputGate = ctx.createGain();
  outputGate.gain.value = 0;
  onStateChange = () => {
    if (!ctx) return;
    if (ctx.state === 'running') {
      // First run ever: push one silent buffer straight to the destination
      // so the OS opens the route on nothing (the classic iOS pop guard).
      if (!routeKicked) {
        routeKicked = true;
        try {
          const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.05), ctx.sampleRate);
          const k = ctx.createBufferSource(); k.buffer = b; k.connect(ctx.destination); k.start();
        } catch (e) {}
      }
      openOutput();
    } else muteOutputNow();
  };
  ctx.addEventListener('statechange', onStateChange);

  // On phones, raw WebAudio obeys the ringer's SILENT SWITCH, and most
  // phones sit on silent, so the hum simply never sounds. Safari 17+
  // offers the clean opt-out: declare the page's audio "playback" via
  // navigator.audioSession and use the normal destination. Older touch
  // browsers get the fallback: the graph terminates in a stream feeding
  // an <audio> element, which counts as media playback.
  if (NAV && 'audioSession' in NAV) {
    try { NAV.audioSession.type = 'playback'; } catch (e) {}
    master.connect(outputGate).connect(ctx.destination);
  } else if (mq('(pointer: coarse)') && G.Audio && ctx.createMediaStreamDestination) {
    const msd = ctx.createMediaStreamDestination();
    master.connect(outputGate).connect(msd);
    mediaOut = new G.Audio();
    mediaOut.srcObject = msd.stream;
    mediaOut.setAttribute('playsinline', '');
  } else {
    master.connect(outputGate).connect(ctx.destination);
  }

  // A system-default output change can leave the AudioContext logically
  // running while its hardware route is rebuilt underneath it. Re-close
  // the final gate briefly for both the device-list signal and the newer
  // AudioContext sink signal. The handler is debounced because browsers may
  // emit both for one physical switch.
  if (!COARSE) {
    if (NAV && NAV.mediaDevices && NAV.mediaDevices.addEventListener)
      NAV.mediaDevices.addEventListener('devicechange', recycleOutput);
    if ('onsinkchange' in ctx) ctx.addEventListener('sinkchange', recycleOutput);
  }

  // The room, as a parallel path: the filtered hum splits into a dry leg
  // and a convolver leg, recombined equal-power at the master. The impulse
  // is synthesized (stereo shaped noise decaying to -60 dB at verbSize),
  // so no sample ever loads.
  //
  // TWO convolvers, ping-ponged: assigning a new buffer to a LIVE
  // ConvolverNode hard-resets its state, the tail truncates to silence
  // and the output steps, which pops. So a size change loads the new
  // impulse into the silent slot and crossfades; no audible node's
  // buffer is ever touched.
  dry = ctx.createGain();
  wet = ctx.createGain();
  // The graph is BORN in the room's current state, so no swell on load.
  const m0 = verbOn ? verbMix : 0;
  dry.gain.value = Math.cos(m0 * Math.PI / 2);
  wet.gain.value = Math.sin(m0 * Math.PI / 2);
  filter.connect(dry).connect(master);
  wet.connect(master);

  verbSlots = [0, 1].map((i) => {
    const conv = ctx.createConvolver();
    const g = ctx.createGain();
    g.gain.value = i === 0 ? 1 : 0;
    filter.connect(conv).connect(g).connect(wet);
    return { conv, g };
  });
  verbSlots[0].conv.buffer = makeImpulse(verbSize);
  verbActive = 0;

  if (values) buildBuffer();
  plugRoom();
}

// The buffer IS the series, mean-removed, seams smoothed, peak-normalized.
// Split from ensureCtx so a gesture can PRIME the context before the data
// has arrived; the buffer joins the graph the moment both exist.
function buildBuffer() {
  const n = values.length;
  buffer = ctx.createBuffer(1, n, ctx.sampleRate);
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

function makeImpulse(seconds) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.round(seconds * sr));
  const ir = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++)
      d[i] = (Math.random() * 2 - 1) * Math.pow(0.001, i / len);
  }
  return ir;
}

function hold(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
  }
}

function muteOutputNow() {
  if (!ctx || !outputGate) return;
  outputOpen = false;
  const t = ctx.currentTime;
  // a step to zero from a live signal is itself a click; 5ms is
  // inaudible as a fade and silent as an edge. hold() pins the LIVE
  // automated value (Safari's gain.value can report the stale set value).
  hold(outputGate.gain, t);
  outputGate.gain.linearRampToValueAtTime(0, t + 0.005);
  closeEndsAt = t + 0.005;
}

function closeOutput(seconds = 0.035) {
  if (!ctx || !outputGate) return;
  outputOpen = false;
  const t = ctx.currentTime;
  hold(outputGate.gain, t);
  outputGate.gain.linearRampToValueAtTime(0, t + seconds);
  closeEndsAt = t + seconds;
}

function openOutput() {
  if (!ctx || !outputGate || !playing || ctx.state !== 'running' || outputOpen)
    return;
  clearTimeout(lifecycleTimer);
  const firstOpen = !outputEverOpened;
  outputOpen = true;
  outputEverOpened = true;
  const t = ctx.currentTime;
  // PHONES: a quarter second of enforced silence first; the start click
  // is the phone output waking up, and its 1.15s rise is untouched.
  // DESKTOP: the visit's first sound swells over a second. A resume is
  // quicker but still a swell, not a switch: 0.18s read as a click of
  // the hum coming back, and this is a room you sit in.
  const wait = COARSE ? 0.25 : 0;
  const rise = COARSE ? 1.15 : (firstOpen ? 1.0 : 0.4);
  outputGate.gain.cancelScheduledValues(t);
  outputGate.gain.setValueAtTime(0.0001, t);
  outputGate.gain.setValueAtTime(0.0001, t + wait);
  outputGate.gain.exponentialRampToValueAtTime(1, t + wait + rise);
}

// openOutput starts from a set 0.0001, which is only silent once a close has
// landed: opened mid-close, the ringing tail would step from wherever the
// close had reached. So a play that comes while the gate is still closing
// waits out the close first. (The site never pauses through the gate; this
// app's switches do.)
function openOutputAfterClose() {
  clearTimeout(openTimer);
  const left = ctx ? closeEndsAt - ctx.currentTime : 0;
  if (left > 0) openTimer = setTimeout(openOutput, left * 1000 + 10);
  else openOutput();
}

// The wet/dry pair always move together, equal-power, and always by
// APPROACH rather than assignment: `tau` is the time constant, ~0.03 for a
// fader (instant to the hand) and ~0.25 for the room being switched on or
// off, three quarters of a second of swell, so the walls arrive and leave
// rather than blinking. Off is simply mix 0: the tail that is already in
// the air rides its own decay out instead of being cut.
function applyVerb(tau) {
  if (!dry || !ctx) return;
  const m = verbOn ? verbMix : 0;
  const t = ctx.currentTime;
  dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), t, tau);
  wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), t, tau);
}

function recycleOutput() {
  if (!ctx || !outputGate || !playing) return;
  closeOutput(0.025);
  clearTimeout(lifecycleTimer);
  lifecycleTimer = setTimeout(() => {
    if (!ctx) return;
    if (ctx.state === 'running') openOutput();
    else ctx.resume().then(openOutput).catch(() => {});
  }, 80);
}

const latency = () => ctx.outputLatency || ctx.baseLatency || 0;
const dur = () => buffer.length / ctx.sampleRate;

function currentPos() {
  if (!playing || !src) return pausedPos;
  let p = anchorPos + (ctx.currentTime - anchorTime) * rate;
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
  // thread can stall for right after ensureCtx() has synthesised the
  // reverb and built the buffer, and a start time that lands in the
  // PAST makes the browser begin instantly with the fade-in already
  // elapsed, so the first sample arrives at full amplitude: the click.
  // 80ms is imperceptible as latency and safely past any render quantum.
  // Read currentTime as late as possible, after the nodes exist.
  const at = ctx.currentTime + 0.08;
  src.start(at, offsetSec % dur());
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(1, at + 0.04);    // a fade, not an edge
  anchorPos = offsetSec;
  anchorTime = at + latency();
}

function stopSource() {
  if (!src) return;
  const now = ctx.currentTime;
  pausedPos = currentPos();
  const s = src, e = env;
  src = null; env = null;
  e.gain.cancelScheduledValues(now);
  e.gain.setValueAtTime(e.gain.value, now);
  e.gain.linearRampToValueAtTime(0, now + 0.02);
  try { s.stop(now + 0.05); } catch (err) { /* already stopped */ }
  s.onended = () => { try { e.disconnect(); } catch (err) {} };
}

// The site's play(), once the data is in. If the browser refuses the
// unlock, `playing` still goes true: the SOURCE is armed and simply waits,
// silent, on the suspended context; every later unlock() can open the gates
// mid-flight. (Never gate retries on a resume() promise: Safari leaves it
// PENDING rather than rejecting, which once wedged the site.)
function startPlaying() {
  if (!values || playing) return;
  ensureCtx();
  if (!buffer) buildBuffer();     // ctx may have been primed dataless
  playing = true;
  unlock();
  if (ctx.state === 'running') {
    startSource(pausedPos);
    openOutputAfterClose();
    return;
  }
  // THE CLICK: starting the source on a suspended context schedules
  // its fade-in against a FROZEN clock. When the browser finally
  // resumes, currentTime leaps past those times, the envelope is
  // already at 1, and the very first audible sample lands at full
  // amplitude on an arbitrary point of the waveform: a pop. So the
  // source waits here until the context is genuinely running.
  const armed = () => {
    if (!playing || src || !ctx || ctx.state !== 'running') return;
    startSource(pausedPos);
    openOutputAfterClose();
  };
  ctx.addEventListener('statechange', armed);
  ctx.resume().then(armed).catch(() => {});
  hookGesture();
}

// A wanted hum on a suspended context also listens for the page's first
// gesture directly (pointer or key, capture, once each): with the app's own
// audio off, no other context ever runs to ride, and the viewer's first
// touch anywhere is the blessing the browser wants. Removed as soon as the
// context runs; harmless where there is no window (PORTABILITY: globalThis,
// as above).
let gestureHooked = false;
function hookGesture() {
  const w = globalThis;
  if (gestureHooked || !w.addEventListener || !ctx) return;
  gestureHooked = true;
  const bless = () => {
    w.removeEventListener('pointerdown', bless, true);
    w.removeEventListener('keydown', bless, true);
    gestureHooked = false;
    if (wanted && ctx && ctx.state !== 'running') unlock();
  };
  w.addEventListener('pointerdown', bless, true);
  w.addEventListener('keydown', bless, true);
}

// When the app's own context starts running, a gesture has just woken the
// sound (main.js's first tap, the worker shell's): the hum's unlock rides
// it. Hooked once per app context, the first time the hum is wanted; at boot
// the app's graph may not be built yet, so a wanted hum looks again for a
// while (half a second apart, for about half a minute).
let hookTries = 0, hookTimer = 0;
function hookAppContext() {
  const a = appContext();
  if (!a) {
    if (wanted && !hookTimer && hookTries < 60) {
      hookTries++;
      hookTimer = setTimeout(() => { hookTimer = 0; hookAppContext(); }, 500);
    }
    return;
  }
  if (a === appCtxHooked) return;
  appCtxHooked = a;
  a.addEventListener('statechange', () => { if (a.state === 'running' && wanted) unlock(); });
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
export const humAvailable = () => !!AC && !unavailable && !loadFailed;
export const humPlaying = () => playing;

/** Fetch the data and build the graph (the site's load + prime): the
    context is born suspended with its gate silent, so this is safe with no
    gesture, and a press that lands mid-download still spends its
    activation. Resolves once the data is in. */
export function ensure() {
  if (!AC || unavailable || loadFailed) return Promise.resolve();
  try { ensureCtx(); }
  catch (e) { unavailable = true; warn('could not make an AudioContext', e); return Promise.resolve(); }
  return load();
}

/** Nudge the browser's gates. Idempotent and safe on EVERY gesture:
    a refused resume just stays pending; a blessed one starts sound. */
export function unlock() {
  if (!ctx) return;
  // The resolved resume() is the one signal every browser agrees on,
  // so don't lean on statechange alone for the first fade.
  if (ctx.state !== 'running') ctx.resume().then(openOutputAfterClose).catch(() => {});
  if (mediaOut && mediaOut.paused) mediaOut.play().catch(() => {});
}

/** Start (or keep) the hum. Lazy: the first call fetches the data and
    builds the graph, and the hum starts the moment both are in, if it is
    still wanted then. */
export function play() {
  if (!AC) return;
  wanted = true;
  hookAppContext();
  if (playing) { unlock(); return; }
  const p = ensure();
  unlock();
  p.then(() => { if (wanted) startPlaying(); });
}

/** Stop the hum through the output gate: the source fades out as the
    site's pause does, and the gate closes over the resume swell's own 0.4 s,
    so the room's tail ebbs rather than ringing on unheard. The place in
    the series is kept for the next play. */
export function pause() {
  wanted = false;
  if (!playing) return;
  playing = false;
  stopSource();
  clearTimeout(openTimer);
  closeOutput(0.4);
}

/** Ramp the FINAL output gate to silence, source, reverb tail and all,
    for the moments before a page reload. */
export function hush(seconds = 0.12) {
  closeOutput(seconds);
}

/** Raw buffer playback rate. 1 hour of sun = 1 sample, so at 48k a
    rate of 1 is ~5.48 years per second. */
export function setRate(r) {
  if (r === rate) return;
  if (playing && src) {
    anchorPos = currentPos();
    anchorTime = ctx.currentTime + latency();
    src.playbackRate.setValueAtTime(r, ctx.currentTime);
  }
  rate = r;
}

/** Data-time velocity. 1 yr/s at 48k = playbackRate 0.183. */
export function setYearsPerSecond(yps) {
  const sr = ctx ? ctx.sampleRate : 48000;
  setRate((yps * HOURS_PER_YEAR) / sr);
}

// The Cutoff setting's map, the site's: 0 to 1 over 100 Hz to 10 kHz,
// logarithmic. Here rather than in the schema so the renderer (gpu/sun.js,
// whose Cutoff variance moves it every frame) and the page's end of the
// worker link can reach it without importing the schema's ring.
export const CUTOFF_LO = 100, CUTOFF_HI = 10000;
export const cutoffHz = v => CUTOFF_LO * Math.pow(CUTOFF_HI / CUTOFF_LO, v);

export function setCutoffHz(hz) {
  if (hz === cutoffTarget) return;
  cutoffTarget = hz;
  if (filter)
    filter.frequency.setTargetAtTime(
      Math.min(hz, 0.45 * ctx.sampleRate), ctx.currentTime, 0.01);
}

/** Master volume, 0..2: above 1 the gain simply boosts past the source's
    own level (the tone is a smooth rumble with headroom, so a clean 2x).
    Smoothed so slider drags never zipper. */
export function setVolume(v) {
  if (v === volume) return;
  volume = v;
  if (master) master.gain.setTargetAtTime(volume * masterVol, ctx.currentTime, 0.02);
}

/** The app's Master volume, 0..1, scaling the hum's own volume. The hum
    keeps its own context (see the top of this file), so it follows the
    master's level here rather than playing through the master's gain,
    which also closes with the transport and the Audio layer's switch. */
export function setMasterVolume(v) {
  if (v === masterVol) return;
  masterVol = v;
  if (master) master.gain.setTargetAtTime(volume * masterVol, ctx.currentTime, 0.02);
}

/** Wet/dry, 0..1, crossfaded equal-power so loudness holds steady. */
export function setReverbMix(m) {
  verbMix = m;
  applyVerb(0.03);
}

/** The room, on or off. Never a cut: the wet leg swells in or ebbs out
    over about three quarters of a second, equal-power against the dry. */
export function setReverbEnabled(on) {
  verbOn = !!on;
  applyVerb(0.25);
}

// ---- the send to the app's master room ----
// The hum plays on a context of its own (see the top of this file), and a
// node can only connect to nodes on its own context, so the hum reaches the
// music's room (js/piano.js, the room every music voice feeds) across a
// bridge: the hum's final output, after its volume, its own room and its
// output gate, also goes into a media stream, which the room's context
// takes back in as a source and feeds through the send's gain into the
// room's input. The bridge adds a few tens of milliseconds, nothing in a
// reverb's tail. It is built the first time the send rises above 0 with
// both ends there, and rebuilt if the music's graph is (setHumRoom again).
// The room's input carries the music's pause gate, so the send sounds while
// the transport runs, as every music voice's does.

/** The music's room, handed over by js/piano.js whenever it builds it, as
    the clouds' is (setCloudBus). */
export function setHumRoom(c, input) {
  roomCtx = c; roomIn = input;
  plugRoom();
}

/** The send's level, 0..1. Smoothed; cheap when unchanged, so the
    Reverb mix's variance can set it every frame. */
export function setRoomSend(v) {
  if (v === sendLevel) return;
  sendLevel = v;
  plugRoom();
}

function plugRoom() {
  if (sendGain) sendGain.gain.setTargetAtTime(sendLevel, sendCtx.currentTime, 0.03);
  if (!(sendLevel > 0) || !ctx || !outputGate || !roomCtx || !roomIn) return;
  if (!ctx.createMediaStreamDestination || !roomCtx.createMediaStreamSource) return;
  try {
    if (!bridgeOut) {
      bridgeOut = ctx.createMediaStreamDestination();
      outputGate.connect(bridgeOut);
    }
    if (sendCtx !== roomCtx) {
      if (bridgeIn) { try { bridgeIn.disconnect(); sendGain.disconnect(); } catch (e) {} }
      sendCtx = roomCtx; sendTo = null;
      bridgeIn = roomCtx.createMediaStreamSource(bridgeOut.stream);
      sendGain = roomCtx.createGain();
      sendGain.gain.value = sendLevel;
      bridgeIn.connect(sendGain);
    }
    if (sendTo !== roomIn) {
      if (sendTo) try { sendGain.disconnect(); } catch (e) {}
      sendGain.connect(roomIn);
      sendTo = roomIn;
    }
  } catch (e) { warn('could not reach the master room', e); }
}

/** Tail length in seconds. Debounced, then swapped by loading the idle
    convolver and crossfading (see the graph comment in ensureCtx). */
export function setReverbSize(seconds) {
  verbSize = seconds;
  if (!verbSlots) return;
  clearTimeout(verbTimer);
  verbTimer = setTimeout(() => {
    if (!ctx) return;
    const from = verbSlots[verbActive];
    const to = verbSlots[1 - verbActive];
    to.conv.buffer = makeImpulse(verbSize);   // silent slot: safe to touch
    const t = ctx.currentTime;
    from.g.gain.setTargetAtTime(0, t, 0.05);
    to.g.gain.setTargetAtTime(1, t, 0.05);
    verbActive = 1 - verbActive;
  }, 120);
}

/** Tear the whole graph down: the gate closes, and once it has the
    context is closed and every node let go. The decoded series is kept,
    so a later play() rebuilds without fetching again. */
export function dispose() {
  wanted = false;
  if (!ctx) return;
  if (playing) { playing = false; stopSource(); }
  closeOutput(0.12);
  clearTimeout(lifecycleTimer); clearTimeout(openTimer); clearTimeout(verbTimer);
  const c = ctx, m = mediaOut;
  if (NAV && NAV.mediaDevices && NAV.mediaDevices.removeEventListener)
    NAV.mediaDevices.removeEventListener('devicechange', recycleOutput);
  try { c.removeEventListener('statechange', onStateChange); } catch (e) {}
  if (bridgeIn) { try { bridgeIn.disconnect(); sendGain.disconnect(); } catch (e) {} }
  bridgeOut = null; bridgeIn = null; sendGain = null; sendCtx = null; sendTo = null;
  ctx = null; buffer = null; filter = null; master = null; outputGate = null;
  mediaOut = null; src = null; env = null; dry = null; wet = null;
  verbSlots = null; verbActive = 0; onStateChange = null;
  outputOpen = false; outputEverOpened = false; routeKicked = false;
  pausedPos = 0; closeEndsAt = 0;
  setTimeout(() => {
    if (m) { try { m.pause(); m.srcObject = null; } catch (e) {} }
    c.close().catch(() => {});
  }, 160);
}
