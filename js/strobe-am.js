// Vary with strobe, as a stage any voice can wear: a gain swung by an
// oscillator at the strobe's flash rate and in its waveform, around
// 1 - depth/2 by depth/2, so at full depth the voice pulses from full to
// silence on every flash and at 0 the gain simply sits at 1. The sequencer
// builds its own inside its level chain (js/piano.js); the drone, the choir
// and the clouds each put one of these in their path.
//
// One shared timer follows the flash rate as it drifts, and its shape, for
// every live stage. Each target is written only when it has moved: a param
// handed a fresh setTarget every tick never settles.
import { S } from './state.js';
import { getContext, glideParam } from './audio.js';
import { scaledStrobeDepth } from './strobe-scale.js';

// The strobe's flash rate as it is actually shown (the frame-locked rate
// when locked, drift included otherwise) and its waveform.
export const strobeHz = () => Math.max(0.1, (S.frameLock && S.achievedFreq) || S.effFreq || S.freq || 7.5);
export const strobeWave = () => (S.wave === 'sine' || S.wave === 'triangle' || S.wave === 'square' ? S.wave : 'sine');

const clamp01 = v => Math.max(0, Math.min(1, v || 0));
const live = new Set();
let timer = null;

function track() {
  const ctx = getContext();
  if (!ctx) return;
  const hz = strobeHz(), wave = strobeWave();
  for (const am of live) {
    if (hz !== am.hz) { am.hz = hz; am.lfo.frequency.setTargetAtTime(hz, ctx.currentTime, 0.05); }
    if (am.lfo.type !== wave) am.lfo.type = wave;
    applyDepth(am);
  }
}

// The depth's own wander, the shape every variance in the app walks
// (js/choir.js): one cosine leg at a time, from where the last ended to a
// random dip between 0 and the variance, `period` seconds a leg, stepped
// by the shared timer above. The dip multiplies the voice's set depth, so
// the pulse breathes between (1 - variance) of the slider and the full
// setting, never above it.
const MIN_LEG = 0.5;
const cos01 = x => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));

function wanderMul(am, now) {
  const amount = clamp01(am.varOf && am.varOf());
  const w = am.w;
  if (!(amount > 0)) {
    w.from = 0; w.to = 0; w.t0 = now - MIN_LEG; w.dur = MIN_LEG; w.period = -1;
    return 1;
  }
  const period = +(am.periodOf && am.periodOf()) || 0;
  const legDur = Math.max(MIN_LEG, period);
  // a new speed takes over from wherever the wander is, rather than making
  // a long leg run out first
  if (w.period !== -1 && w.period !== period) {
    w.from = w.from + (w.to - w.from) * cos01((now - w.t0) / w.dur);
    w.t0 = now; w.dur = legDur;
  }
  w.period = period;
  if (now - w.t0 >= w.dur) {
    w.from = w.to; w.to = Math.random() * amount; w.t0 = now; w.dur = legDur;
  }
  // a lowered variance takes effect at once, never left below the new floor
  const leg = w.from + (w.to - w.from) * cos01((now - w.t0) / w.dur);
  return 1 - Math.min(leg, amount);
}

function applyDepth(am) {
  const ctx = getContext();
  const mul = ctx ? wanderMul(am, ctx.currentTime) : 1;
  const v = scaledStrobeDepth(clamp01(am.depthOf()) * mul);
  if (v === am.depth) return;
  am.depth = v;
  glideParam(am.node.gain, 1 - v / 2, 0.05);
  glideParam(am.dg.gain, v / 2, 0.05);
}

export function refreshStrobeAm() {
  for (const am of live) applyDepth(am);
}

// The depth actually playing, wander included, in the dial's own 0..1: the
// varied slider's glowing readout (the schema's `effective`). Reading steps
// the same wander the audio walks, so the glow and the gain always agree.
export function strobeAmEffective(am) {
  if (!am) return undefined;
  const ctx = getContext();
  if (!ctx) return undefined;
  return clamp01(am.depthOf()) * wanderMul(am, ctx.currentTime);
}

// depthOf reads the voice's setting, 0..1; varOf and periodOf, when given,
// its variance and variance speed. Wire the voice through am.node;
// am.apply() after a setting moves; am.stop() once the voice is torn down.
export function strobeAm(ctx, depthOf, varOf, periodOf) {
  const node = ctx.createGain();
  const lfo = ctx.createOscillator(), dg = ctx.createGain();
  const d = scaledStrobeDepth(clamp01(depthOf()));
  node.gain.value = 1 - d / 2; dg.gain.value = d / 2;
  lfo.type = strobeWave(); lfo.frequency.value = strobeHz();
  lfo.connect(dg); dg.connect(node.gain); lfo.start();
  const am = {
    node, lfo, dg, depthOf, varOf, periodOf, depth: d, hz: lfo.frequency.value,
    w: { from: 0, to: 0, t0: 0, dur: MIN_LEG, period: -1 },
    apply() { applyDepth(am); },
    stop() {
      live.delete(am);
      try { lfo.stop(); } catch (e) {}
      try { lfo.disconnect(); dg.disconnect(); node.disconnect(); } catch (e) {}
      if (!live.size && timer) { clearInterval(timer); timer = null; }
    }
  };
  live.add(am);
  if (!timer) timer = setInterval(track, 200);
  return am;
}
