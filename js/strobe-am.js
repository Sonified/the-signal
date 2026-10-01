// Vary with strobe, as a stage any voice can wear: a gain swung by the
// strobe's own flash, around 1 - depth/2 by depth/2, so at full depth the
// voice pulses from full to silence on every flash and at 0 the gain simply
// sits at 1. The drone, the choir and the clouds each put one of these in
// their path; the sequencer swings its own level chain from the same tap
// (strobeTap, js/piano.js).
//
// The swing is the flash itself, not an oscillator set to its rate. The
// strobe is one formula of time (v1/core/signal.js), and one AudioWorklet
// node ('strobe-signal', js/worklet.js) runs that formula sample by sample
// and puts out +1 lit, -1 dark; every stage taps that one node, so every
// pulse lands where the screen's flash does, at any wave, through any glide,
// for as long as the session runs. This file owns the node and keeps it told:
// whenever the signal changes (onSignal) it posts the formula's numbers, with
// the anchor moved onto the audio clock (below), and nothing in between.
//
// One node per context, in fact: a family playing through Heart builds on a
// context of its own (js/heart/route.js ctxFor), whose nodes cannot connect
// to a native one, so it is handed a strobe-signal node made there, which
// Heart runs from the same formula (heart/src/nodes/strobe_signal.rs). Every
// node hears every post, so the native stages and Heart's pulse as one.
//
// Until the engine's worklet module has loaded, a tap is a plain oscillator
// at the flash's rate and wave, as every stage used to be, so a stage built
// early still pulses; the shared timer moves it onto the node the moment the
// node can be made. The same timer follows the depth's variance for every
// live stage. Each target is written only when it has moved: a param handed
// a fresh setTarget every tick never settles.
//
// The same post goes to the engine itself (the 'genus' processor, js/
// audio.js's node), with one more thing: whether the pulse is linked to the
// visual (S.amLinked). Linked, the engine's tone, harmonics and pips take
// their phase from the formula too (worklet.js, flashAlign), so the main
// pulse is on the flash exactly as the stages are; free, it ignores the
// formula and runs at its own rate. One clock estimate (below) serves both,
// and the engine hears the formula on the same only-on-change rule, plus
// once more whenever the link is switched.
import { S } from './state.js';
import { getContext, glideParam, watchEngine } from './audio.js';
import { makeWorklet } from './heart/route.js';
import { scaledStrobeDepth } from './strobe-scale.js';
import { breath, breathState } from '../v1/core/variance.js';
import { every, clear } from './ticker.js';
import {
  signal, SIGNAL_ORIGIN, signalNow, steerSignal, setSignalShape, waveCode, onSignal, publishSignal
} from '../v1/core/signal.js';

// The strobe's flash rate as it is actually shown (the frame-locked rate
// when locked, drift included otherwise) and its waveform: what an early
// tap's stand-in oscillator follows, and what the signal is steered by when
// nothing else writes it (v0).
export const strobeHz = () => Math.max(0.1, (S.frameLock && S.achievedFreq) || S.effFreq || S.freq || 7.5);
export const strobeWave = () => (S.wave === 'sine' || S.wave === 'triangle' || S.wave === 'square' ? S.wave : 'sine');

const clamp01 = v => Math.max(0, Math.min(1, v || 0));
const live = new Set();     // the stages, for their depths
const taps = new Set();     // every tap on the flash: the stages' and the sequencer's
let timer = null;

// ---------- the audio clock ----------
// The signal's t is absolute milliseconds (v1/core/signal.js); the worklet's
// is this context's currentTime. The two are matched in real time, as Robert
// asked, with no allowance for output latency on either side: a sample is
// given the signal's value for the moment it is rendered, as a frame is
// given the value for the moment it is drawn. clockEst is the page's
// performance.now() at context time 0. currentTime moves in bursts, a
// callback's worth of audio at a time, so a single reading can sit up to a
// burst behind; the lowest reading is the one taken right as a burst lands,
// which is the truest, so it is the one kept. It is let rise by CLOCK_LEAK_MS
// a reading (fifty parts in a million at five readings a second, more than a
// sound card's crystal drifts by) so a clock that runs slow is followed too,
// and a reading more than CLOCK_JUMP_MS above it is a clock that stopped (a
// suspended context) and starts it afresh. The anchor is posted again when
// the estimate has moved by more than CLOCK_REPOST_MS, so the two clocks can
// never drift apart over a long session.
const CLOCK_LEAK_MS = 0.01, CLOCK_JUMP_MS = 250, CLOCK_REPOST_MS = 1;
let clockEst = NaN, clockPosted = NaN, clockCtx = null;
function sampleClock(ctx) {
  if (ctx.state !== 'running') return;
  const s = performance.now() - ctx.currentTime * 1000;
  clockEst = clockEst === clockEst && s - clockEst <= CLOCK_JUMP_MS ? Math.min(clockEst + CLOCK_LEAK_MS, s) : s;
}
// The context the estimate is of: the signal nodes' and the engine's, which
// all run on the one clock of the context js/audio.js makes, since a Heart
// context keeps the native one's clock (js/heart/heart.js). Taken afresh for
// a new context.
const clockOf = ctx => (ctx.isHeart && getContext()) || ctx;
function useClock(ctx) {
  if (clockCtx === ctx) return;
  clockCtx = ctx;
  clockEst = NaN; clockPosted = NaN;
  // a context that stops and starts again resumes its clock where it
  // stopped, so the match is taken afresh
  ctx.addEventListener('statechange', () => { if (clockCtx === ctx) clockEst = NaN; });
}

// ---------- the nodes ----------
// The signal node of each context that has asked for one.
const sigNodes = new Map();
const sigMsg = { at: 0, p: 0, r0: 0, r1: 0, dur: 0, wave: 0, duty: 0.5, on: false };

// ---------- the engine ----------
// The genus node once js/audio.js has made it (watchEngine, below), and the
// link it was last told, so a switch is posted once. `steered` is whether
// this file has ever steered the signal itself (v0, or the page in worker
// mode before the engine's first word): the signal is only worth locking to
// once something has set it, by the strobe core or by that steer, and until
// then the engine runs free, as it always did.
let engNode = null, engLinked = null, steered = false;
const engMsg = { signal: true, at: 0, p: 0, r0: 0, r1: 0, dur: 0, wave: 0, duty: 0.5, linked: false };
const signalKnown = () => signal.driven || steered;

// The context's shared node, made the first time it can be (the engine's
// worklet module loaded, js/audio.js), or null until then.
function signalNode(ctx) {
  const had = sigNodes.get(ctx);
  if (had) return had;
  if (!ctx || !S.workletReady) return null;
  let n;
  try {
    n = makeWorklet(ctx, 'strobe-signal', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  } catch (e) { return null; }
  sigNodes.set(ctx, n);
  useClock(clockOf(ctx));
  postSignal();
  return n;
}

// The formula's numbers to the worklet, the anchor in context seconds: to
// every stages' node, and to the engine with the link (once the signal is
// known, above). Before the context has run (no estimate yet) a single
// reading stands in, and the timer posts again once there is a true one.
function postSignal() {
  const toEng = !!engNode && signalKnown();
  if (!clockCtx || (!sigNodes.size && !toEng)) return;
  sampleClock(clockCtx);
  let est = clockEst;
  if (!(est === est)) est = performance.now() - clockCtx.currentTime * 1000;
  else clockPosted = est;
  const at = (signal.at - SIGNAL_ORIGIN - est) / 1000;
  if (sigNodes.size) {
    sigMsg.at = at;
    sigMsg.p = signal.offset; sigMsg.r0 = signal.r0; sigMsg.r1 = signal.r1; sigMsg.dur = signal.dur;
    sigMsg.wave = signal.wave; sigMsg.duty = signal.duty; sigMsg.on = signal.on;
    for (const n of sigNodes.values()) n.port.postMessage(sigMsg);
  }
  if (toEng) {
    engMsg.at = at;
    engMsg.p = signal.offset; engMsg.r0 = signal.r0; engMsg.r1 = signal.r1; engMsg.dur = signal.dur;
    engMsg.wave = signal.wave; engMsg.duty = signal.duty;
    engMsg.linked = engLinked = !!S.amLinked;
    engNode.port.postMessage(engMsg);
  }
}
onSignal(postSignal);

// Nothing writes the signal (v0, which has no v1 strobe core; or the page
// in worker mode before the engine's first word): it is steered here from
// S, so the stages still pulse, and a linked engine still locks, at the
// flash's rate and wave, free-running.
function steerFromS() {
  steerSignal(signal, signalNow(), strobeHz());
  setSignalShape(signal, waveCode(S.wave), S.duty, S.running);
  steered = true;
  publishSignal();
}

// js/audio.js calls this when the engine's node is made and whenever the
// pulse rate is set (every switch of the link sets it). A new node is told
// the formula at once, steered first if nothing has set it; after that only
// a switch of the link is news, since the formula's own changes reach it
// through onSignal. The timer runs for as long as the engine exists, for
// the clock's re-posts and as the backstop for a link switched without a
// rate being set (a settings load).
watchEngine(n => {
  if (n !== engNode) {
    engNode = n; engLinked = null;
    useClock(clockOf(n.context));
    if (!timer) timer = every(200, track);
    if (!signal.driven) steerFromS();
    postSignal();
  } else if (engLinked !== !!S.amLinked) postSignal();
});

// ---------- taps ----------
// Connects the flash into `into` (an AudioNode on ctx: a stage's depth
// gain), +1 lit, -1 dark, from ctx's own node. Hand the tap back to
// untapStrobe when the voice goes.
export function strobeTap(ctx, into) {
  const tap = { ctx, into, src: null, osc: null, hz: 0 };
  const n = signalNode(ctx);
  if (n) { n.connect(into); tap.src = n; }
  else {
    // the stand-in until the node can be made (see the top)
    const osc = ctx.createOscillator();
    osc.type = strobeWave(); osc.frequency.value = tap.hz = strobeHz();
    osc.connect(into); osc.start();
    tap.osc = osc;
  }
  taps.add(tap);
  if (!timer) timer = every(200, track);
  return tap;
}

export function untapStrobe(tap) {
  if (!tap || !taps.delete(tap)) return;
  if (tap.src) try { tap.src.disconnect(tap.into); } catch (e) {}
  if (tap.osc) dropOsc(tap.osc);
  tap.src = null; tap.osc = null;
  if (!taps.size && !engNode && timer) { clear(timer); timer = null; }
}

function dropOsc(o) {
  try { o.stop(); } catch (e) {}
  try { o.disconnect(); } catch (e) {}
}

function track() {
  const ctx = getContext();
  if (!ctx) return;
  // nothing writes the signal: steer it here (steerFromS)
  if (!signal.driven) steerFromS();
  // a link switched with no rate set alongside it
  if (engNode && engLinked !== !!S.amLinked) postSignal();
  const native = signalNode(ctx);
  const hz = strobeHz(), wave = strobeWave();
  for (const tap of taps) {
    if (!tap.osc) continue;
    const n = tap.ctx === ctx ? native : signalNode(tap.ctx);
    if (n) {
      // the node is here: the stand-in hands over to it
      n.connect(tap.into); tap.src = n;
      dropOsc(tap.osc); tap.osc = null;
    } else {
      if (hz !== tap.hz) { tap.hz = hz; tap.osc.frequency.setTargetAtTime(hz, tap.ctx.currentTime, 0.05); }
      if (tap.osc.type !== wave) tap.osc.type = wave;
    }
  }
  if (clockCtx) {
    sampleClock(clockCtx);
    if (clockEst === clockEst && !(Math.abs(clockEst - clockPosted) <= CLOCK_REPOST_MS)) postSignal();
  }
  for (const am of live) applyDepth(am);
}

// The depth's own variance, the app's one law on the audio clock
// (v1/core/variance.js breath), sinusoid or walk by the voice's Behavior
// toggle. The dip multiplies the voice's set depth, so the pulse breathes
// between (1 - variance) of the slider and the full setting, never above it.
function wanderMul(am, now) {
  const amount = clamp01(am.varOf && am.varOf());
  const period = +(am.periodOf && am.periodOf()) || 0;
  return 1 - breath(am.w, amount, period, now, am.modeOf && am.modeOf());
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

// depthOf reads the voice's setting, 0..1; varOf, periodOf and modeOf,
// when given, its variance, variance speed and Behavior ('walk' for the
// random walk; anything else breathes the sinusoid). Wire the voice
// through am.node; am.apply() after a setting moves; am.stop() once the
// voice is torn down.
export function strobeAm(ctx, depthOf, varOf, periodOf, modeOf) {
  const node = ctx.createGain(), dg = ctx.createGain();
  const d = scaledStrobeDepth(clamp01(depthOf()));
  node.gain.value = 1 - d / 2; dg.gain.value = d / 2;
  dg.connect(node.gain);
  const tap = strobeTap(ctx, dg);
  const am = {
    node, dg, tap, depthOf, varOf, periodOf, modeOf, depth: d,
    w: breathState(),
    apply() { applyDepth(am); },
    stop() {
      live.delete(am);
      untapStrobe(tap);
      try { dg.disconnect(); node.disconnect(); } catch (e) {}
    }
  };
  live.add(am);
  return am;
}
