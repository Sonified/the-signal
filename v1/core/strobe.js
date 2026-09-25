// The strobe core: a faithful, non-DOM port of the per-frame body of tick()
// in js/main.js. Everything here is pure state advance, no drawing and no
// reading of any element. The frame graph (v1/gpu/engine.js, wired by
// integration) calls stepStrobe(t) once per rAF, before the scene is built,
// and hands the returned lum and lit on to scene.update and the render call.
//
// v0 could split its work across a main thread and a strobe worker; v1 has
// no worker, so this is simply the worker's "not in a worker" path, taken
// every frame. Frame health, drift, frame lock, the eff* values and both
// colour walks all write the same S fields v0 does, so diagnostics screens
// and presets (lanes still to come) keep reading numbers that mean what they
// always meant. S.edgeInset is deliberately not touched here: v0 derived it
// from the drawer's DOM geometry, and in v1 that becomes the toolkit's job.

import { S, WALK_STEP, WALK_DAMP, WALK_SWING } from '../../js/state.js';
import { shape } from '../../js/util.js';
import { bandHue } from '../../js/color.js';
import { setAmRate, hasNode } from '../../js/audio.js';
import { updateRings, updateParticles } from '../../js/sim.js';

// Returned and mutated in place every call, so a frame that reads lum and lit
// never makes stepStrobe allocate to hand them over.
const result = { lum: 0, lit: false };
// The lit state of the frame a callback earlier, which is the frame on the
// display while the current callback's after-submit slot runs (see darkSlot).
let prevLit = false;

// js/util.js's hslToRgb, written into an existing array instead of returning
// a new one, and with its per-channel helper as a plain function rather than
// a closure built on every call. The colour walk runs it every frame, and v0's
// version left an array and a closure behind each time for the collector.
// Same maths, same rounding, so the walk lands on exactly the same colours.
function hueChannel(p, q, t) {
  t = ((t % 1) + 1) % 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslInto(out, h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); out[0] = v; out[1] = v; out[2] = v; return; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = Math.round(hueChannel(p, q, h + 1 / 3) * 255);
  out[1] = Math.round(hueChannel(p, q, h) * 255);
  out[2] = Math.round(hueChannel(p, q, h - 1 / 3) * 255);
}

// The frame-health windows (S.intervals, S.litLog) are plain arrays that the
// diagnostics read oldest first, so they stay plain arrays in that order. v0
// kept them with push and shift, and shift on a full window trims the array
// from the front, which leaves its backing store one slot short each time;
// every so often the next push then has to grow it again, a fresh copy of the
// whole window for the collector, once every few dozen frames, forever. Once
// a window is full it now keeps its length and its backing store: everything
// slides down one place in place and the newest value goes in the last slot.
function pushWindow(arr, v, max) {
  const n = arr.length;
  if (n < max) { arr.push(v); return; }
  // longer than the window (never in v1; guarded anyway): drop the oldest
  if (n > max) { arr.splice(0, n - max + 1); arr.push(v); return; }
  // A plain loop rather than copyWithin: V8's copyWithin is the generic
  // property-by-property builtin, which boxes every double it moves, while
  // this loop compiles to straight unboxed moves.
  for (let i = 1; i < max; i++) arr[i - 1] = arr[i];
  arr[max - 1] = v;
}

const frameT = new Float64Array(61);
let frameN = 0;

export function resetStrobeClock() {
  S.lastT = null;
}

// Forget the measured refresh rate entirely: the window of frame times, the
// rate itself and the frame lock's count. Called when the display changes
// (js/display-watch.js), because a rate measured on one panel says nothing
// about the next, and a frame lock still counting in the old one's frames is
// exactly how a 40 Hz strobe becomes 20 Hz on a slower screen. Until sixty new
// frames have been timed the frame lock runs free and the panel guard counts
// nothing, as at boot. The interval log is kept: it is a record for the
// diagnostics, and the change itself is worth seeing there.
export function resetRefreshMeasure() {
  frameN = 0;
  S.refreshHz = 0;
  S.framesPerCycle = 0;
  S.frameIdx = 0;
  S.achievedFreq = 0;
  lastDt = 0;
  S.lastT = null;
}

// A preset glides the strobe frequency over the same window the audio glides
// in (PRESET_GLIDE_S in js/audio.js), so a linked pulse stays locked to the
// field the whole way instead of the two parting for a second and a half.
// What glides is the effective frequency itself: from the value it had when
// the preset landed to whatever freq and drift now say, in a straight line.
// That carries a change of drift along with a change of frequency, and a
// second preset mid-glide simply starts from wherever the first has got to.
// The glide starts on the next frame's timestamp, since this module keeps
// time only by the frames it is handed.
let fGlideMs = 0, fGlideFrom = 0, fGlideT0 = -1;
export function glideStrobeFreq(sec) {
  if (!(sec > 0)) return;
  fGlideMs = sec * 1000;
  fGlideFrom = S.effFreq;
  fGlideT0 = -1;
}

// A glide must never dwell in the 15-25 Hz photosensitive band the app warns
// about (js/ui.js); a 7.5 to 40 Hz recall would otherwise sweep through it for
// almost half a second. So when the path crosses the band and neither end is
// inside it, the band is cut out of the path: the glide runs at an even pace
// over the rest and steps straight across the band in a single frame. When a
// preset's own start or target is inside the band, the glide is left as is,
// since being there is then the preset's choice, not a side effect.
const RISK_LO = 15, RISK_HI = 25;
function inRiskBand(hz) { return hz >= RISK_LO && hz <= RISK_HI; }
function glideSkippingRiskBand(from, to, f) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (inRiskBand(from) || inRiskBand(to) || lo >= RISK_LO || hi <= RISK_HI) {
    return from + (to - from) * f;
  }
  const dir = to > from ? 1 : -1;
  const d = (hi - lo - (RISK_HI - RISK_LO)) * f;   // distance travelled outside the band
  const edgeNear = dir > 0 ? RISK_LO : RISK_HI;
  const firstLeg = Math.abs(edgeNear - from);
  if (d < firstLeg) return from + dir * d;
  return (dir > 0 ? RISK_HI : RISK_LO) + dir * (d - firstLeg);
}

// How far past a count's halfway point the frame ratio has to go, as a
// fraction of the ratio, before frame lock changes count (see stepStrobe).
const FPC_HOLD = 0.02;

// The pieces of a frame's phase and its lit test, each written once. stepStrobe
// advances the real pattern through them, and nextFrameLit below runs the very
// same functions one frame ahead, so the prediction and the frame it predicts
// can only part if the settings themselves change in between.
//
// lockAdvance is one frame of frame lock: pick the frame count (holding the
// one it has until the ratio is clearly past a halfway point), carry the
// phase over if the count changed, and step the integer counter. It writes
// its answer into the two scratch numbers below rather than returning a pair.
let lkFpc = 0, lkIdx = 0;
function lockAdvance(fpcNow, idxNow, phaseNow, ratio) {
  let fpc = fpcNow;
  if (!(fpc >= 2) || Math.abs(ratio - fpc) > 0.5 + FPC_HOLD * ratio) {
    fpc = Math.max(2, Math.round(ratio));
  }
  let idx = idxNow;
  if (fpc !== fpcNow) idx = fpcNow ? Math.round(phaseNow * fpc) % fpc : 0;
  lkFpc = fpc;
  lkIdx = (idx + 1) % fpc;
}
// An odd frame count cannot split evenly, so the spare frame has to go one
// way or the other. Lit (2-lit-1-dark at 3 frames) reads as a bright field
// with a blink; dark (1-lit-2-dark) reads as a flash against a gap twice as
// long, which the eye registers as a far stronger pulse. The hundredth nudges
// the duty just past or just short of the middle sample so the choice is
// exact rather than a floating-point coin toss.
function lockDuty(fpc) {
  const spareLit = S.spareMode !== 'dark';
  return (fpc % 2) ? (Math.floor(fpc / 2) + (spareLit ? 0.01 : -0.01)) / fpc : 0.5;
}
function freePhase(phase, freq, dt) {
  phase += freq * dt;
  return phase - Math.floor(phase);
}
function isLit(lum) { return lum > 0.5; }

// The interval the next frame will most likely be shown after: the measured
// refresh when there is one, else the last frame's own, else a 60 Hz guess.
let lastDt = 0;
function nextDt() {
  if (S.refreshHz > 0) return 1 / S.refreshHz;
  return lastDt > 0 ? lastDt : 1 / 60;
}

export function stepStrobe(t) {
  if (S.lastT === null) S.lastT = t;
  let dt = (t - S.lastT) / 1000;
  S.lastT = t;

  // frame-health tracking: a dropped frame is a lost luminance sample, which
  // is exactly what an uneven strobe looks like
  if (dt > 0 && dt < 0.25) {
    pushWindow(S.intervals, dt * 1000, 180);
    if (S.refreshHz) {
      const expected = 1000 / S.refreshHz;
      if (dt * 1000 > expected * 1.5) S.dropCount++;
    }
  }

  // The refresh-rate window. v0 kept it in S.frameTimes, which nothing in v1
  // reads, so here it is a fixed typed array: trimming a plain array back to
  // thirty let V8 shrink its storage, and the next thirty pushes grew it again.
  frameT[frameN++] = t;
  if (frameN > 60) {
    const span = (frameT[frameN - 1] - frameT[0]) / 1000;
    S.refreshHz = (frameN - 1) / span;
    // keep the newest 30, as v0's slice(-30) did
    frameT.copyWithin(0, frameN - 30, frameN);
    frameN = 30;
  }

  if (dt > 0.25) dt = 0;          // tab-switch guard

  S.lastPhase = S.phase;
  if (S.running) { S.driftPhase += dt / S.driftPeriod; S.driftPhase -= Math.floor(S.driftPhase); }
  // Each of the slow modulations below costs a cos or a sin per frame, and at
  // zero variance that trig computes a multiplier of exactly one. So each one
  // is skipped when its amount is zero; the accumulators still advance, so
  // turning a variance up mid-session picks it up where it would have been.
  let eff = S.freqDriftOn !== false && S.freqDrift
    ? Math.max(0.1, S.freq + S.freqDrift * Math.sin(2 * Math.PI * S.driftPhase))
    : Math.max(0.1, S.freq);
  if (fGlideMs > 0) {
    if (fGlideT0 < 0) fGlideT0 = t;
    const f = (t - fGlideT0) / fGlideMs;
    if (f >= 1) fGlideMs = 0;
    else eff = glideSkippingRiskBand(fGlideFrom, eff, f);
  }
  S.effFreq = eff;

  // a linked audio pulse has to ride the drift too, or the two come apart
  if (S.amLinked && hasNode() && Math.abs(S.effFreq - S.lastAmSet) > 0.01) {
    setAmRate(S.effFreq); S.lastAmSet = S.effFreq;
  }

  if (S.running) {
    if (S.frameLock && S.refreshHz > 0) {
      // The frame count is the nearest whole number of frames per cycle, but
      // it only moves off the one it has once the ratio is clearly past the
      // halfway point. refreshHz is re-measured every thirty frames, and one
      // dropped frame in its window reads about 1.7% slow, so a ratio sitting
      // near a half (40 Hz on a 100 or 180 Hz display is 2.5 and 4.5 exactly)
      // would otherwise flip between two counts on measurement noise alone,
      // and each flip jumps the achieved frequency, which is seen as flicker.
      // 2% of the ratio covers that noise and is small enough that a real
      // change (144 Hz at 40, a ratio of 3.6) still settles on the count
      // rounding gives it.
      // A new frame count keeps the cycle's phase rather than restarting it
      // (lockAdvance). Restarting cut the running cycle short, which a single
      // step between two frequencies hid, but a glide passes through every
      // count on the way (sixteen frames down to three, say) and would cut a
      // dozen cycles short in a row. Carrying the phase over lets the lock
      // just follow. The frame index is an integer counter, not an
      // accumulator: adding 1/3 repeatedly drifts in floating point and the
      // cycle boundary lands on a different frame.
      lockAdvance(S.framesPerCycle, S.frameIdx, S.phase, S.refreshHz / S.effFreq);
      S.framesPerCycle = lkFpc;
      S.frameIdx = lkIdx;
      S.achievedFreq = S.refreshHz / lkFpc;
      S.phase = lkIdx / lkFpc;
      S.duty = lockDuty(lkFpc);
    } else {
      S.framesPerCycle = 0;
      S.achievedFreq = S.effFreq;
      S.phase = freePhase(S.phase, S.effFreq, dt);
    }
    S.phase -= Math.floor(S.phase);
    S.varPhase += (dt / S.varPeriod); S.varPhase -= Math.floor(S.varPhase);
  }
  // 0 at the top of the cycle, so depth starts at its full set value
  S.effDepth = S.depthVarOn !== false && S.depthVar
    ? S.depth * (1 - S.depthVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.varPhase)))
    : S.depth;

  if (S.running) {
    S.brightVarPhase += (dt / S.brightVarPeriod); S.brightVarPhase -= Math.floor(S.brightVarPhase);
    S.ringBrightPhase += (dt / S.ringBrightPeriod); S.ringBrightPhase -= Math.floor(S.ringBrightPhase);
  }
  S.effBright = S.brightVarOn !== false && S.brightVar
    ? S.bright * (1 - S.brightVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.brightVarPhase)))
    : S.bright;

  if (S.running) {
    S.edgeSpeedVarPhase += dt / S.edgeSpeedVarPeriod; S.edgeSpeedVarPhase -= Math.floor(S.edgeSpeedVarPhase);
    S.edgeSizeVarPhase += dt / S.edgeSizeVarPeriod; S.edgeSizeVarPhase -= Math.floor(S.edgeSizeVarPhase);
  }
  S.effEdgeSpeed = S.edgeSpeedVar
    ? S.edgeSpeedMul * (1 - S.edgeSpeedVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.edgeSpeedVarPhase)))
    : S.edgeSpeedMul;
  S.effEdgeSize = S.edgeSizeVar
    ? S.edgeSize * (1 - S.edgeSizeVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.edgeSizeVarPhase)))
    : S.edgeSize;

  S.effRingBright = S.ringBrightVar
    ? S.bright * (1 - S.ringBrightVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.ringBrightPhase)))
    : S.bright;

  if (S.perElementColor && S.colorWalk > 0 && S.running) {
    for (let i = 0; i < 4; i++) {
      S.cornerHv[i] += (Math.random() - 0.5) * WALK_STEP * dt;
      S.cornerHv[i] *= WALK_DAMP;
      if (S.cornerHv[i] > 1) S.cornerHv[i] = 1;
      if (S.cornerHv[i] < -1) S.cornerHv[i] = -1;
      S.cornerHue[i] += (1 + S.cornerHv[i] * WALK_SWING) * S.colorWalk * dt / S.walkPeriod;
      S.cornerHue[i] -= Math.floor(S.cornerHue[i]);
    }
  }
  if (S.colorWalk > 0 && S.running) {
    S.hueVel += (Math.random() - 0.5) * WALK_STEP * dt;
    S.hueVel *= WALK_DAMP;
    if (S.hueVel > 1) S.hueVel = 1;
    if (S.hueVel < -1) S.hueVel = -1;
    S.hue += (1 + S.hueVel * WALK_SWING) * S.colorWalk * dt / S.walkPeriod;
    S.hue -= Math.floor(S.hue);
    // lightness held, so apparent brightness is steady. Written into S.rgb in
    // place, as v0's strobe worker does; nothing holds S.rgb by identity.
    hslInto(S.rgb, bandHue(S.hue), S.hueSat, S.hueLight);
  }
  const lum = S.running ? shape(S.phase) : 0;
  const lit = isLit(lum);
  if (S.running) pushWindow(S.litLog, lit ? 1 : 0, 120);
  lastDt = dt;

  const ts = t / 1000;
  updateRings(dt, ts);
  updateParticles(dt);

  prevLit = result.lit;
  result.lum = lum;
  result.lit = lit;
  return result;
}

// Whether the frame after the one stepStrobe just produced will be lit, asked
// after stepStrobe in the same rAF. It replays the next step through the same
// lockAdvance, lockDuty, freePhase, shape and isLit, and writes nothing into
// S that outlives the call. Frame lock needs no clock at all: the next frame
// is the next integer index, with the count and the spare-frame duty the next
// step would choose. shape() reads S.duty, so the next step's duty is put in
// for the one call and the current one put straight back. Free-running, the
// phase moves by effFreq over one expected frame interval, so a late frame
// can land elsewhere; a wrong guess only mistimes a chore (core/chores.js).
// Stopped, nothing is lit.
export function nextFrameLit() {
  if (!S.running) return false;
  if (S.frameLock && S.refreshHz > 0) {
    lockAdvance(S.framesPerCycle, S.frameIdx, S.phase, S.refreshHz / S.effFreq);
    const duty = S.duty;
    S.duty = lockDuty(lkFpc);
    const lit = isLit(shape(lkIdx / lkFpc));
    S.duty = duty;
    return lit;
  }
  return isLit(shape(freePhase(S.phase, S.effFreq, nextDt())));
}

// Whether the slot after this frame's submit is a safe place to stall, which
// is what core/chores.js actually asks. What a stall stretches is not the
// frame just submitted: a canvas presents when the frame's work finishes,
// so a chore that overruns makes the JUST-SUBMITTED frame miss its refresh,
// and what the display holds for that extra refresh is the frame already ON
// SCREEN, the one submitted a callback earlier. So the frame that must be
// dark is the PREVIOUS one. A lit previous frame held over is a widened
// flash, the one visible failure; a lit current frame merely arrives one
// refresh late on a stall, a rare single-frame phase slip, which is far
// less visible than a widened flash. Under frame lock the index advances
// per frame drawn, so nothing is ever skipped, only late. Free-running the
// clock moves on and a missed callback skips its sample outright, so there
// the next sample must be dark as well or a whole flash could be lost.
// Stopped, there is no strobe to disturb, so every slot is safe. So is a
// slow strobe: below CHORE_GUARD_HZ a flash spans many refreshes, and one
// held a refresh longer is a sliver of it nobody sees, so the chores get
// every slot rather than waiting for the dark ones.
const CHORE_GUARD_HZ = 20;
export function darkSlot() {
  if (!S.running) return true;
  if ((S.effFreq || S.freq) < CHORE_GUARD_HZ) return true;
  if (prevLit) return false;
  if (S.frameLock && S.refreshHz > 0) return true;
  return !nextFrameLit();
}
