// The Heartbeat layer's sound: one looping recording (audio/heartbeat.m4a),
// and the loudness the light reads from it. gpu/heartbeat.js drives it once
// a frame (heartSync) and reads the loudness of the moment being heard
// (heartRead); the envelope and the wash live there.
//
//   source -> level -> limiter -> trim -> pause gate -> the app's master -> out
//
// The light does not listen to the graph. When the track decodes, its
// loudness is worked out once, from the samples themselves (the light's
// envelope, below), and heartRead looks it up at the place in the track the
// listener is hearing now. So the light keeps beating with the sound turned
// all the way down or muted, and the flash never follows the Audio level
// slider up past 100% either, as when an analyser sat ahead of the level;
// and it reads the same on an engine that renders ahead of the speakers,
// where an analyser in the graph would be reading the future, and on one
// that sends no samples back at all. The limiter is the heartbeat's own (the app's
// master bus has none): it lets the level run to 400% and keep getting
// louder without the loudest beats clipping (see LIM_THRESHOLD).
//
// The track is a family of its own on Heart, the app's audio engine
// (js/heart/route.js, 'heartbeat'): built on ctxFor('heartbeat') and ending
// at masterFor('heartbeat'), as the atmosphere's recordings are
// (js/ambience.js), so it renders in an island of its own, ahead of the
// speakers, and plays through Heart's master into the app's master gain;
// the volume slider and the transport's pause gate reach it like every
// other voice. With Heart off for it, or a device that cannot run Heart,
// the same two calls answer with the app's own AudioContext and master gain
// (js/audio.js getContext and getMaster), and it plays there exactly as it
// did before Heart. Only with no shared context to hand at all does it make
// one of its own, straight to the speakers.
//
// A family builds on Heart only once Heart has started (route.js); one
// built before that is built natively and stays there. So the graph waits
// for the app's audio graph, which starts Heart, to settle (ensureAudioGraph,
// awaited once), however early the layer comes on, and is built in the
// first frame after.
//
// Nothing is made or fetched until the layer first comes on. The source is
// stopped (its place kept) while the layer is off, the scene is stopped, or
// the engine dozes, and starts again from that place.
//
// PORTABILITY: like gpu/sun.js's video element, this reaches the browser's
// audio directly; it belongs behind a platform hook when one is added. A
// worker engine has no AudioContext, and the layer stays silent and dark.
//
// Allocation per frame: none. A start makes one AudioBufferSourceNode, by
// Web Audio's design.

import { getContext, getMaster, sourceGate, ensureAudioGraph } from '../js/audio.js';
import { ctxFor, masterFor } from '../js/heart/route.js';
import { createGlobalFilter } from './global-filter.js';
import { createOutputGuard } from './output-guard.js';
import { chanGate, onChannelGates } from '../js/mixgate.js';
import { tapPeak } from '../js/util.js';

const TRACK_URL = 'audio/heartbeat.m4a';
// The RMS window: the generator's frame, 1/30 s of sound, whatever the
// display's rate. Its HEART_NORM (gpu/heartbeat.js) was measured on 30 fps
// frames; a 1/30 s window read at 60 or 120 Hz lands within 1% of it, where a
// window of one 60 Hz frame reads about 28% hotter and saturates the beat.
const GEN_FPS = 30;
// The light's envelope: the running sum of the track's squared mono
// down-mix, kept every ENV_HOP frames (about 0.75 MB for the 32 s track at
// 48 kHz), so the RMS of any window is two lookups, the few samples between
// each end and the hop before it, and a square root: exactly the sum over
// the window's samples, at most 30 squares a read however long the window.
const ENV_HOP = 16;
// The level's glide, seconds: a slider drag without zipper noise.
const LEVEL_TC = 0.03;

// The limiter: a DynamicsCompressorNode set up as a near-brickwall (on Heart,
// its twin, Chrome's own compressor ported line for line, so everything
// below holds on either engine). The track
// peaks at -0.5 dBFS with a mean of -21.4 dB, so any level past about 106%
// would clip its loudest beats while the rest of it has 20 dB to spare; the
// limiter holds those beats down and lets everything else grow.
//
// Hard knee (0 dB) and ratio 20: above the threshold every 20 dB in is 1 dB
// out. Attack 3 ms: the node delays the sound by a fixed 6 ms and looks
// ahead, so a 3 ms attack has the gain down before a thump reaches the
// output, and a thump's low cycles (about 20 ms each) cannot slip past it.
// That delay puts the sound 6 ms behind the light (the light reads the
// source's own place, ahead of it), well inside what the eye and ear take as
// together.
// Release 0.25 s: long against those 20 ms cycles, so the gain holds through
// the body of a beat instead of riding each cycle and distorting it, yet
// short against the second or so between beats, so it lets go in the quiet
// and the next beat finds it open. The heard result is a beat that grows
// fuller and louder in its body as the level rises, with no audible pump.
//
// The makeup-gain trap. The Web Audio spec has the node apply a fixed makeup
// gain after compressing, whatever the input: (1 / curve(1.0)) ^ 0.6, the
// curve being the static one above. With knee 0 a full-scale input comes out
// of the curve at T + (0 - T) / ratio = 0.95 T dB, so the makeup is
// -0.6 * 0.95 T dB. At T = -3 dB that is +1.71 dB, and the trim gain after
// the node takes it back off (x0.821), so below the threshold the node is
// unity and the sound at 100% and under is the sound it always was.
//
// The arithmetic, peak in (track's -0.5 dBFS times the level) to peak out:
//   80%:  -2.44 dBFS in, -2.97 out (the loudest beat trimmed 0.5 dB)
//   100%: -0.50 dBFS in, -2.88 out
//   200%: +5.52 dBFS in, -2.57 out
//   400%: +11.54 dBFS in, -3 + 14.54 / 20 = -2.27 dBFS out
// Without the trim 400% would land at -0.56 dBFS, too close to clipping
// once attack overshoot is counted; with it there are 2.27 dB of headroom.
const LIM_THRESHOLD = -3;
const LIM_RATIO = 20;
const LIM_ATTACK = 0.003;
const LIM_RELEASE = 0.25;
const LIM_TRIM = Math.pow(10, 0.6 * LIM_THRESHOLD * (1 - 1 / LIM_RATIO) / 20);

let ctx = null, ownCtx = false, unavailable = false;
let level = null;
// The Levels window's meter: a tap at the very end of the chain, after the
// limiter and the pause gate, so it reads what is heard (heartPeak).
let meterTap = null;
let buffer = null, loading = false, loadFailed = false;
// The light's envelope (ENV_HOP): energy[k] is the sum of the squared mono
// down-mix over the track's first k hops; total the whole track's; frames
// its length and win the RMS window, in the track's frames; chL and chR its
// samples (chR null for a mono track).
let energy = null, total = 0, frames = 0, win = 0, chL = null, chR = null;
// The place in the track: where the source was at anchorT (audio clock,
// seconds), moving at rate (the Speed setting) since. Each is a time the
// listener hears it (placeNow): on Heart a start or a speed change lands a
// lookahead after currentTime, so until then the place before it still
// plays, kept in prev* (hasPrev), and before heardFrom, the moment the
// source's start is heard, nothing of it plays yet.
let src = null, offset = 0, anchorT = 0, anchorPos = 0, rate = 1;
let prevT = 0, prevPos = 0, prevRate = 1, hasPrev = false, heardFrom = 0;
let resumeArmed = true, lastLevel = -1;
// heartRead's results, read straight off the module (no object per frame).
let readT = -1;
export let heartRms = 0, heartDt = 0;

function warn(msg, e) {
  console.warn('heartbeat: ' + msg + (e ? ': ' + (e && e.message ? e.message : e) : ''));
}

// The app's audio graph has settled (built, or failed): Heart has started,
// or will not, and route.js answers for good.
let graphSettled = false, graphAsked = false;

function ensureGraph() {
  if (ctx) return true;
  if (unavailable) return false;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC && !getContext()) {
    unavailable = true;
    warn('no AudioContext on this thread (worker engine); the Heartbeat layer needs the page engine');
    return false;
  }
  if (!graphSettled) {
    if (!graphAsked) {
      graphAsked = true;
      const done = () => { graphSettled = true; };
      Promise.resolve(ensureAudioGraph()).then(done, done);
    }
    return false;
  }
  // The family's context and master: Heart's when it plays there, else the
  // app's native pair; and only with neither a context of its own.
  const routed = ctxFor('heartbeat');
  ctx = routed || getContext();
  if (!ctx) {
    try { ctx = new AC({ latencyHint: 'playback' }); ownCtx = true; }
    catch (e) { unavailable = true; warn('could not make an AudioContext', e); return false; }
  }
  level = ctx.createGain();
  level.gain.value = 0;
  // The limiter and its makeup trim, after the level so it is the level
  // that drives them, and before the gate (LIM_THRESHOLD above).
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIM_THRESHOLD;
  limiter.knee.value = 0;
  limiter.ratio.value = LIM_RATIO;
  limiter.attack.value = LIM_ATTACK;
  limiter.release.value = LIM_RELEASE;
  const trim = ctx.createGain();
  trim.gain.value = LIM_TRIM;
  level.connect(limiter);
  limiter.connect(trim);
  const master = ownCtx ? null : routed ? masterFor('heartbeat') : getMaster();
  if (master) {
    const gate = ctx.createGain();
    sourceGate(gate.gain);
    trim.connect(gate);
    gate.connect(master);
    meterTap = tapAfter(gate);
  } else {
    // a context of its own: the app's global Lowpass and Highpass
    // (core/global-filter.js) and its output guard (core/output-guard.js)
    // go on here, as js/audio.js's master carries them for the usual path
    // above
    const gf = createGlobalFilter(ctx);
    const guard = createOutputGuard(ctx);
    trim.connect(gf.input);
    gf.output.connect(guard.input);
    guard.output.connect(ctx.destination);
    meterTap = tapAfter(trim);
  }
  return true;
}

function tapAfter(node) {
  const a = ctx.createAnalyser();
  a.fftSize = 1024;
  node.connect(a);
  return { analyser: a, samples: new Float32Array(a.fftSize) };
}

// The output peak, 0..1+, for the Levels window's meter; 0 while stopped.
export const heartPeak = () => src ? tapPeak(meterTap) : 0;

function load() {
  if (buffer || loading || loadFailed) return;
  loading = true;
  fetch(TRACK_URL)
    .then(r => {
      if (!r.ok) throw new Error('request failed: ' + r.status);
      return r.arrayBuffer();
    })
    .then(data => ctx.decodeAudioData(data))
    .then(b => { buildEnvelope(b); buffer = b; loading = false; })
    .catch(e => { loading = false; loadFailed = true; warn('the track could not load; the layer stays silent', e); });
}

// The light's envelope, made once as the track decodes: the running sum of
// its squared mono down-mix, hop by hop (ENV_HOP). The down-mix is the one
// an AnalyserNode takes, ½(L + R), which is what HEART_NORM was measured
// on. One pass over the samples, a few milliseconds for the whole track,
// and nothing after it.
function buildEnvelope(b) {
  const n = b.length, hops = Math.ceil(n / ENV_HOP);
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : null;
  const e = new Float64Array(hops + 1);
  let sum = 0;
  for (let k = 0; k < hops; k++) {
    const end = Math.min(n, (k + 1) * ENV_HOP);
    let s = 0;
    for (let i = k * ENV_HOP; i < end; i++) {
      const x = R ? 0.5 * (L[i] + R[i]) : L[i];
      s += x * x;
    }
    sum += s;
    e[k + 1] = sum;
  }
  energy = e; total = sum; frames = n; chL = L; chR = R;
  win = Math.round(b.sampleRate / GEN_FPS);
}

function square(i) {
  const x = chR ? 0.5 * (chL[i] + chR[i]) : chL[i];
  return x * x;
}

// The energy from the loop's start up to frame p of the track, on any lap
// (the loop's whole laps count in, before or after). Between two frames, as
// at a Speed other than 1, the frame p falls in counts in by its fraction.
function energyAt(p) {
  const lap = Math.floor(p / frames);
  p -= lap * frames;
  let i = Math.floor(p);
  if (i >= frames) i = frames - 1;
  const k = Math.floor(i / ENV_HOP);
  let e = lap * total + energy[k];
  for (let j = k * ENV_HOP; j < i; j++) e += square(j);
  return e + (p - i) * square(i);
}

// When a call made now is heard: currentTime on a native context; on Heart
// the render horizon (HeartContext.presentTime), where a start, a stop or a
// rate change made now lands and is heard.
const placeNow = () => ctx.presentTime !== undefined ? ctx.presentTime : ctx.currentTime;

// The context may be suspended (no gesture yet, or the system took it);
// resume() is asked once per arm: the layer switching on, or the page or
// the engine waking (heartArm). A refusal waits for the next of those.
function tryResume() {
  if (!resumeArmed || ctx.state === 'running' || ctx.state === 'closed') return;
  resumeArmed = false;
  let p = null;
  try { p = ctx.resume(); } catch (e) { warn('resume() was refused', e); return; }
  if (p && p.catch) p.catch(e => warn('resume() was refused', e));
}

function startSource() {
  src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rate;
  src.connect(level);
  const pos = buffer.duration > 0 ? offset % buffer.duration : 0;
  const at = placeNow();
  src.start(at, pos);
  anchorT = at; anchorPos = pos; heardFrom = at; hasPrev = false;
  readT = -1;
}

// Stops the source where it is, keeping its place for the next start: the
// place as it stands when the stop is heard.
export function heartPause() {
  if (!src) return;
  const at = placeNow();
  if (buffer && buffer.duration > 0) offset = (anchorPos + (at - anchorT) * rate) % buffer.duration;
  try { src.stop(at); } catch (e) {}
  src.disconnect();
  src = null;
  readT = -1;
}

// Lets the next frame ask the context to resume.
export function heartArm() { resumeArmed = true; }

// Whether the layer can make sound at all on this thread.
export const heartUnavailable = () => unavailable || loadFailed;

// Once a frame while the layer is on: loads the track the first time,
// resumes the context when armed, plays or pauses the source, and sets the
// heard level. Returns whether a source is playing on a running clock.
// The show remote's Duck (platform/show-remote.js, the slides' setDuck
// pattern): a multiplier on the heartbeat's level alone. It glides the live
// gain at once, so it works while the frame loop rests, and heartSync keeps
// honouring it on every later set. Not saved: a reload is unducked.
let duckMul = 1;
// The mix gate (js/mixgate.js): 1 open, 0 while a mute or another channel's
// solo holds the heartbeat, on the level as the duck is. Only the sound: the
// light reads the track itself, so it keeps beating through it.
let gateMul = 1;
const heard = () => lastLevel >= 0 ? lastLevel * duckMul * gateMul : 0;
export function setHeartDuck(mul, seconds) {
  duckMul = typeof mul === 'number' && mul === mul ? (mul < 0 ? 0 : mul > 1 ? 1 : mul) : 1;
  if (!level || !ctx) return;
  const sec = typeof seconds === 'number' && seconds >= 0 && seconds <= 10 ? seconds : 0.2;
  level.gain.setTargetAtTime(heard(), ctx.currentTime, Math.max(0.003, sec / 3));
}
onChannelGates(() => {
  const g = chanGate('heart');
  if (g === gateMul) return;
  gateMul = g;
  if (level && ctx) level.gain.setTargetAtTime(heard(), ctx.currentTime, LEVEL_TC);
});

export function heartSync(play, gain, speed = 1) {
  if (!ensureGraph()) return false;
  load();
  if (!play) { heartPause(); return false; }
  // Speed: a new rate takes effect where it is heard, the place so far
  // counted at the old one, so a pause still keeps the true place in the
  // track; until then the old rate is still what plays (prev*).
  if (speed !== rate) {
    if (src) {
      const at = placeNow();
      prevT = anchorT; prevPos = anchorPos; prevRate = rate; hasPrev = true;
      anchorPos += (at - anchorT) * rate; anchorT = at;
      src.playbackRate.setValueAtTime(speed, at);
    }
    rate = speed;
  }
  tryResume();
  if (gain !== lastLevel) {
    lastLevel = gain;
    gateMul = chanGate('heart');
    level.gain.setTargetAtTime(heard(), ctx.currentTime, LEVEL_TC);
  }
  if (!buffer) return false;
  if (!src) startSource();
  return ctx.state === 'running';
}

// The latest 1/30 s of sound: its RMS (the mono down-mix, as an analyser
// read it) into heartRms, and the audio clock's step since the last read
// into heartDt (0 on the first read after a start, or a clock that has not
// moved).
//
// The 1/30 s is of sound as heard, ending at the place the listener is
// hearing now: the track's place at currentTime, which on Heart, as on a
// native context, is the clock the speakers play by. At a Speed other than
// 1 that 1/30 s holds rate/30 s of the track, as the analyser's window did.
// Before the source's start is heard (on Heart, a lookahead after it was
// asked for) there is nothing to read yet, and the first read after it is
// the first after a start.
export function heartRead() {
  heartRms = 0; heartDt = 0;
  if (!src || !energy) return;
  const now = ctx.currentTime;
  if (now < heardFrom) { readT = -1; return; }
  if (readT >= 0) heartDt = now - readT;
  readT = now;
  if (!(heartDt > 0)) { heartDt = 0; return; }
  const late = hasPrev && now < anchorT;
  const r = late ? prevRate : rate;
  const pos = late ? prevPos + (now - prevT) * prevRate : anchorPos + (now - anchorT) * rate;
  const end = pos * buffer.sampleRate, span = win * r;
  const ms = (energyAt(end) - energyAt(end - span)) / span;
  heartRms = ms > 0 ? Math.sqrt(ms) : 0;
}
