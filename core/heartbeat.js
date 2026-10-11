// The Heartbeat layer's sound: one looping recording (audio/heartbeat.m4a)
// and the analyser the light reads it through. gpu/heartbeat.js drives it
// once a frame (heartSync) and reads the samples the frame just heard
// (heartRead); the envelope and the wash live there.
//
//   source -> analyser -> level -> limiter -> trim -> pause gate
//          -> the app's master -> out
//
// The analyser sits ahead of the level, so the light keeps beating with the
// sound turned all the way down, and the flash never follows the Audio level
// slider up past 100% either. The limiter is the heartbeat's own (the app's
// master bus has none): it lets the level run to 400% and keep getting
// louder without the loudest beats clipping (see LIM_THRESHOLD). The track plays on the app's own
// AudioContext (js/audio.js getContext, the one the engine, the piano and
// the atmosphere share) and into its master gain, as the atmosphere's
// recordings do (js/ambience.js), so the volume slider and the transport's
// pause gate reach it like every other voice. Only with no shared context to
// hand does it make one of its own, straight to the speakers.
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

import { getContext, getMaster, sourceGate } from '../js/audio.js';
import { createGlobalFilter } from './global-filter.js';

const TRACK_URL = 'audio/heartbeat.m4a';
// The RMS window: the generator's frame, 1/30 s of sound, whatever the
// display's rate. Its HEART_NORM (gpu/heartbeat.js) was measured on 30 fps
// frames; a 1/30 s window read at 60 or 120 Hz lands within 1% of it, where a
// window of one 60 Hz frame reads about 28% hotter and saturates the beat.
const GEN_FPS = 30;
// The level's glide, seconds: a slider drag without zipper noise.
const LEVEL_TC = 0.03;

// The limiter: a DynamicsCompressorNode set up as a near-brickwall. The track
// peaks at -0.5 dBFS with a mean of -21.4 dB, so any level past about 106%
// would clip its loudest beats while the rest of it has 20 dB to spare; the
// limiter holds those beats down and lets everything else grow.
//
// Hard knee (0 dB) and ratio 20: above the threshold every 20 dB in is 1 dB
// out. Attack 3 ms: the node delays the sound by a fixed 6 ms and looks
// ahead, so a 3 ms attack has the gain down before a thump reaches the
// output, and a thump's low cycles (about 20 ms each) cannot slip past it.
// That delay puts the sound 6 ms behind the light (the analyser reads ahead
// of it), well inside what the eye and ear take as together.
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
let analyser = null, level = null, samples = null, win = 0;
let buffer = null, loading = false, loadFailed = false;
let src = null, startedAt = 0, offset = 0;
let resumeArmed = true, lastLevel = -1;
// heartRead's results, read straight off the module (no object per frame).
let readT = -1;
export let heartRms = 0, heartDt = 0;

function warn(msg, e) {
  console.warn('heartbeat: ' + msg + (e ? ': ' + (e && e.message ? e.message : e) : ''));
}

function ensureGraph() {
  if (ctx) return true;
  if (unavailable) return false;
  ctx = getContext();
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) {
      unavailable = true;
      warn('no AudioContext on this thread (worker engine); the Heartbeat layer needs the page engine');
      return false;
    }
    try { ctx = new AC({ latencyHint: 'playback' }); ownCtx = true; }
    catch (e) { unavailable = true; warn('could not make an AudioContext', e); return false; }
  }
  win = Math.round(ctx.sampleRate / GEN_FPS);
  let fft = 2048;
  while (fft < win && fft < 32768) fft *= 2;
  if (win > fft) win = fft;
  analyser = ctx.createAnalyser();
  analyser.fftSize = fft;
  analyser.smoothingTimeConstant = 0;
  samples = new Float32Array(fft);
  level = ctx.createGain();
  level.gain.value = 0;
  analyser.connect(level);
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
  const master = ownCtx ? null : getMaster();
  if (master) {
    const gate = ctx.createGain();
    sourceGate(gate.gain);
    trim.connect(gate);
    gate.connect(master);
  } else {
    // a context of its own: the app's global Lowpass and Highpass
    // (core/global-filter.js) go on here, as js/audio.js's master carries
    // them for the usual path above
    const gf = createGlobalFilter(ctx);
    trim.connect(gf.input);
    gf.output.connect(ctx.destination);
  }
  return true;
}

function load() {
  if (buffer || loading || loadFailed) return;
  loading = true;
  fetch(TRACK_URL)
    .then(r => {
      if (!r.ok) throw new Error('request failed: ' + r.status);
      return r.arrayBuffer();
    })
    .then(data => ctx.decodeAudioData(data))
    .then(b => { buffer = b; loading = false; })
    .catch(e => { loading = false; loadFailed = true; warn('the track could not load; the layer stays silent', e); });
}

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
  src.connect(analyser);
  const at = buffer.duration > 0 ? offset % buffer.duration : 0;
  src.start(ctx.currentTime, at);
  startedAt = ctx.currentTime - at;
  readT = -1;
}

// Stops the source where it is, keeping its place for the next start.
export function heartPause() {
  if (!src) return;
  if (buffer && buffer.duration > 0) offset = (ctx.currentTime - startedAt) % buffer.duration;
  try { src.stop(); } catch (e) {}
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
export function heartSync(play, gain) {
  if (!ensureGraph()) return false;
  load();
  if (!play) { heartPause(); return false; }
  tryResume();
  if (gain !== lastLevel) {
    lastLevel = gain;
    level.gain.setTargetAtTime(gain, ctx.currentTime, LEVEL_TC);
  }
  if (!buffer) return false;
  if (!src) startSource();
  return ctx.state === 'running';
}

// The latest 1/30 s of sound: its RMS (the analyser's mono down-mix) into
// heartRms, and the audio clock's step since the last read into heartDt (0
// on the first read after a start, or a clock that has not moved).
export function heartRead() {
  heartRms = 0; heartDt = 0;
  if (!src || !analyser) return;
  const now = ctx.currentTime;
  if (readT >= 0) heartDt = now - readT;
  readT = now;
  if (!(heartDt > 0)) { heartDt = 0; return; }
  analyser.getFloatTimeDomainData(samples);
  const end = samples.length;
  let sum = 0;
  for (let i = end - win; i < end; i++) sum += samples[i] * samples[i];
  heartRms = Math.sqrt(sum / win);
}
