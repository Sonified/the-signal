// The Heartbeat layer's sound: one looping recording (audio/heartbeat.m4a)
// and the analyser the light reads it through. gpu/heartbeat.js drives it
// once a frame (heartSync) and reads the samples the frame just heard
// (heartRead); the envelope and the wash live there.
//
//   source -> analyser -> level -> pause gate -> the app's master -> out
//
// The analyser sits ahead of the level, so the light keeps beating with the
// sound turned all the way down. The track plays on the app's own
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

const TRACK_URL = 'audio/heartbeat.m4a';
// The RMS window: the generator's frame, 1/30 s of sound, whatever the
// display's rate. Its HEART_NORM (gpu/heartbeat.js) was measured on 30 fps
// frames; a 1/30 s window read at 60 or 120 Hz lands within 1% of it, where a
// window of one 60 Hz frame reads about 28% hotter and saturates the beat.
const GEN_FPS = 30;
// The level's glide, seconds: a slider drag without zipper noise.
const LEVEL_TC = 0.03;

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
  const master = ownCtx ? null : getMaster();
  if (master) {
    const gate = ctx.createGain();
    sourceGate(gate.gain);
    level.connect(gate);
    gate.connect(master);
  } else {
    level.connect(ctx.destination);
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
