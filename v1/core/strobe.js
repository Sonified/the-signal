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
import { strobeScale } from '../../js/strobe-scale.js';
import { shape } from '../../js/util.js';
import { bandHue } from '../../js/color.js';
import { setAmRate, hasNode } from '../../js/audio.js';
import { updateRings, updateParticles } from '../../js/sim.js';
import { motionStep, motionScale, winding } from './motion.js';
import { roomPhase, roomPhaseState } from './room-clock.js';
import { GAP_MS, stepWakeRamp, wakeRamp } from './wake.js';

// Returned and mutated in place every call, so a frame that reads lum and lit
// never makes stepStrobe allocate to hand them over.
const result = { lum: 0, lit: false };
// The lit state of the frame a callback earlier, which is the frame on the
// display while the current callback's after-submit slot runs (see darkSlot).
let prevLit = false;
// The flowers' pulse variance's room bookkeeping (see stepStrobe).
const flowerPulseRoom = roomPhaseState();
const flowerOpacityRoom = roomPhaseState();

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

// The strobe's half of a wake (core/wake.js), run by main.js at the top of a
// resume frame, before stepStrobe. The frame's own dt goes to zero (the
// clock is reset, so nothing advances and the absence is not logged as a
// dropped frame), and a preset's frequency glide carries on from where it
// was rather than finishing in one frame. The refresh-rate window starts
// over from this frame, keeping the rate it has: a window that straddled
// the absence would measure a thirty-second gap as part of sixty frames, a
// refresh rate of about 2 Hz, and frame lock would fall to its floor of two
// frames per cycle, a flash on every other frame, 30 Hz on a 60 Hz panel,
// with the panel guard blind to it (it counts nothing below 20 Hz). And,
// while following a broadcast, the next beacon sync, when one comes, lands
// on the broadcaster's phases in a single step rather than gliding onto
// them (applySync).
export function strobeResume(away) {
  S.lastT = null;
  frameN = 0;
  if (fGlideMs > 0 && fGlideT0 >= 0) fGlideT0 += away;
  if (syncOn) syncSnap = true;
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
// Exported for the journey (core/journey.js), whose ramps move the Frequency
// slider itself over many seconds and take the same path, band cut out.
const RISK_LO = 15, RISK_HI = 25;
function inRiskBand(hz) { return hz >= RISK_LO && hz <= RISK_HI; }
export function glideSkippingRiskBand(from, to, f) {
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

// ---------- broadcast phase sync ----------
// A followed broadcast can align this screen's strobe with the broadcaster's
// (core/broadcast.js): every couple of seconds a beacon arrives saying "at
// shared-clock time `at` my phase was p, at frequency f, and the variability
// phases were these". The shared clock is the relay room's own (both sides
// measure their offset to it NTP-style; broadcast.js hands the offset in), so
// the beacon can be extrapolated to this frame's own timestamp and compared
// with where this tab actually is.
//
// Corrections are gentle, never jumps. Free-running, the phase error is bled
// off at SYNC_RATE per second, which bends the effective frequency by at most
// half the error rate, well under anything the eye reads as a tempo change.
// Under frame lock the phase can only sit on whole frame indices, so the
// correction is a whole-frame nudge of the counter, at most one every
// NUDGE_CYCLES cycles, and only once the error is clearly more than half a
// frame. The slow variability phases slew the same way; their targets run on
// each one's own period, so a beacon stays a good target for seconds.
//
// A beacon older than SYNC_STALE_S is not chased (the broadcast paused, or
// the link dropped): the strobe holds its own time until a fresh one lands.
// The broadcaster itself never corrects; it is the reference.
//
// Gliding is for small errors. A variability phase more than SYNC_SNAP_ERR
// of a cycle out is set onto its target in one step instead: the frequency
// drift's phase gliding half a cycle in a couple of seconds would sweep the
// flash rate across its whole drift range at speed, where one step is a
// single change of rate. The strobe's own phase keeps its glide at any
// error, since the wrapped error caps that correction at half a cycle bled
// off slowly, a bend of well under half a hertz. After a wake (strobeResume)
// everything snaps once, strobe phase and frame index included, on the first
// fresh beacon: the room kept moving while this screen was away, and the
// viewer is best served by landing at its now in one blink.
const SYNC_RATE = 0.8;
const NUDGE_CYCLES = 3;
const SYNC_STALE_S = 8;
const SYNC_SNAP_ERR = 0.25;
let syncOn = false;
let syncSnap = false;                    // the next applied beacon lands in one step (a wake)
let clockOff = NaN;                      // shared-clock ms minus this tab's rAF ms
let syncAt = 0;                          // shared-clock ms the beacon was true at
let syncP = 0, syncF = 0;                // strobe phase and frequency then
let syncDP = 0, syncVP = 0, syncBP = 0, syncRP = 0, syncSP = 0, syncZP = 0;
let nudgeHold = 0;                       // frames until the next frame-lock nudge may run

export function setStrobeClockOffset(off) { clockOff = off; }
export function setStrobeSyncTarget(at, p, f, dp, vp, bp, rp, sp, zp) {
  syncAt = at; syncP = p; syncF = f;
  syncDP = dp; syncVP = vp; syncBP = bp; syncRP = rp; syncSP = sp; syncZP = zp;
  syncOn = true;
}
export function clearStrobeSync() { syncOn = false; syncSnap = false; }

const frac = x => x - Math.floor(x);
// shortest way round the circle, in [-0.5, 0.5)
function phaseErr(target, cur) { const e = (target - cur) % 1; return e - Math.round(e); }
function slewTo(cur, target, k) { return frac(cur + phaseErr(target, cur) * k); }
// A variability phase's pull: the glide above, or one step onto the target
// after a wake or past SYNC_SNAP_ERR.
function pullTo(cur, target, k) {
  const e = phaseErr(target, cur);
  if (syncSnap || e > SYNC_SNAP_ERR || e < -SYNC_SNAP_ERR) return frac(target);
  return frac(cur + e * k);
}

function applySync(t, dt) {
  if (isNaN(clockOff)) return;
  const el = (t + clockOff - syncAt) / 1000;   // seconds since the beacon was true
  if (el < 0 || el > SYNC_STALE_S) return;
  const k = Math.min(1, dt * SYNC_RATE);
  S.driftPhase        = pullTo(S.driftPhase,        syncDP + el / S.driftPeriod, k);
  S.varPhase          = pullTo(S.varPhase,          syncVP + el / S.varPeriod, k);
  S.brightVarPhase    = pullTo(S.brightVarPhase,    syncBP + el / S.brightVarPeriod, k);
  S.ringBrightPhase   = pullTo(S.ringBrightPhase,   syncRP + el / S.ringBrightPeriod, k);
  S.edgeSpeedVarPhase = pullTo(S.edgeSpeedVarPhase, syncSP + el / S.edgeSpeedVarPeriod, k);
  S.edgeSizeVarPhase  = pullTo(S.edgeSizeVarPhase,  syncZP + el / S.edgeSizeVarPeriod, k);
  const pt = syncP + el * syncF;
  if (syncSnap) {
    // the wake's one step: the frame index to the one nearest the target
    // under frame lock, the phase itself running free
    syncSnap = false;
    if (S.frameLock && S.refreshHz > 0 && S.framesPerCycle >= 2) {
      S.frameIdx = Math.round(frac(pt) * S.framesPerCycle) % S.framesPerCycle;
      nudgeHold = S.framesPerCycle * NUDGE_CYCLES;
    } else {
      S.phase = frac(pt);
    }
    return;
  }
  if (S.frameLock && S.refreshHz > 0 && S.framesPerCycle >= 2) {
    if (nudgeHold > 0) nudgeHold--;
    const err = phaseErr(pt, S.phase);
    if (nudgeHold <= 0 && Math.abs(err) > 0.75 / S.framesPerCycle) {
      S.frameIdx = (S.frameIdx + (err > 0 ? 1 : S.framesPerCycle - 1)) % S.framesPerCycle;
      nudgeHold = S.framesPerCycle * NUDGE_CYCLES;
    }
  } else {
    S.phase = slewTo(S.phase, pt, k);
  }
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
// The level the flicker actually shows for a shape value. Running, the shape
// itself. Winding down after a pause, the flicker keeps its frequency and
// its phase keeps advancing at the normal rate, and only its depth eases
// toward the paused look (a steady 1) with the motion scale. Slowing the
// frequency instead would sweep the flicker down through the low Hz, which
// is a photosensitivity risk; fading its depth never passes through any
// rate it was not already at.
//
// The wake ramp (core/wake.js) enters here the same way, as a second factor
// on that depth: for RAMP_S after a resume the flicker comes up from a
// steady level to its set depth, whatever the wind-down is doing. This
// function and flickerLevel below are the one door every strobing layer's
// flicker passes through (the field and the layers through lum, the corners
// and the edge through flickerLevel), so the ramp covers all of them and
// multiplies into their own depths rather than replacing any.
function flickerLum(l) {
  const k = (S.running ? 1 : motionScale()) * wakeRamp();
  return k === 1 ? l : 1 + (l - 1) * k;
}

// Whether any flicker shows at all. Running, yes. Paused, only while the
// wind-down is coasting AND the viewer has not asked pause to stop the
// flicker at once (S.pauseFlickerStop, on by default): someone who pauses
// because the flashing is too much must see it end on that frame. The
// checkbox gates only the flicker; the motion keeps coasting either way.
function flickerShows() {
  return S.running || (winding() && S.pauseFlickerStop === false);
}

// How much of the flicker shows this frame, 0 to 1, for anything that
// strobes on its own phase rather than through lum (the corner glows in
// gpu/scene-data.js). Running it is 1; winding down with Pause stops
// flicker off it is the motion scale, the same fade flickerLum applies to
// the field; otherwise 0, a steady level, so pausing quiets every strobing
// element together. Either way the wake ramp multiplies in, as it does in
// flickerLum.
export function flickerLevel() {
  if (S.running) return wakeRamp();
  return winding() && S.pauseFlickerStop === false ? motionScale() * wakeRamp() : 0;
}

// The interval the next frame will most likely be shown after: the measured
// refresh when there is one, else the last frame's own, else a 60 Hz guess.
let lastDt = 0;
function nextDt() {
  if (S.refreshHz > 0) return 1 / S.refreshHz;
  return lastDt > 0 ? lastDt : 1 / 60;
}

export function stepStrobe(t) {
  stepWakeRamp(t);
  if (S.lastT === null) S.lastT = t;
  let dt = (t - S.lastT) / 1000;
  S.lastT = t;

  // frame-health tracking: a dropped frame is a lost luminance sample, which
  // is exactly what an uneven strobe looks like
  if (dt > 0 && dt * 1000 <= GAP_MS) {
    pushWindow(S.intervals, dt * 1000, 180);
    if (S.refreshHz) {
      const expected = 1000 / S.refreshHz;
      if (dt * 1000 > expected * 1.5) S.dropCount++;
    }
  }

  // The refresh-rate window. v0 kept it in S.frameTimes, which nothing in v1
  // reads, so here it is a fixed typed array: trimming a plain array back to
  // thirty let V8 shrink its storage, and the next thirty pushes grew it again.
  // An absence starts the window over (strobeResume says why); main.js does
  // that on every resume frame already, and this catches any it did not.
  if (dt * 1000 > GAP_MS) frameN = 0;
  frameT[frameN++] = t;
  if (frameN > 60) {
    const span = (frameT[frameN - 1] - frameT[0]) / 1000;
    S.refreshHz = (frameN - 1) / span;
    // keep the newest 30, as v0's slice(-30) did
    frameT.copyWithin(0, frameN - 30, frameN);
    frameN = 30;
  }

  if (dt * 1000 > GAP_MS) dt = 0; // an absence advances nothing (core/wake.js)

  // A followed broadcast's corrections land before this frame advances, on
  // the accumulators as the last frame left them; the ordinary steps below
  // then move everything forward as they always do.
  if (syncOn && S.running && dt > 0) applySync(t, dt);

  S.lastPhase = S.phase;
  // The pause wind-down (core/motion.js): flick is whether the flicker is
  // still showing, running or winding down; md is this frame's step for
  // everything that moves, dt while running and easing to 0 after a pause.
  // The flicker's own phase always steps by the full dt (see flickerLum).
  const flick = S.running || winding();
  const md = motionStep(dt);
  if (flick) { S.driftPhase += md / S.driftPeriod; S.driftPhase -= Math.floor(S.driftPhase); }
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

  if (flick) {
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
    S.varPhase += (md / S.varPeriod); S.varPhase -= Math.floor(S.varPhase);
  }
  // 0 at the top of the cycle, so depth starts at its full set value
  S.effDepth = S.depthVarOn !== false && S.depthVar
    ? S.depth * (1 - S.depthVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.varPhase)))
    : S.depth;
  S.effDepth *= strobeScale();

  if (flick) {
    S.brightVarPhase += (md / S.brightVarPeriod); S.brightVarPhase -= Math.floor(S.brightVarPhase);
    S.ringBrightPhase += (md / S.ringBrightPeriod); S.ringBrightPhase -= Math.floor(S.ringBrightPhase);
  }
  S.effBright = S.brightVarOn !== false && S.brightVar
    ? S.bright * (1 - S.brightVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.brightVarPhase)))
    : S.bright;

  if (flick) {
    S.edgeSpeedVarPhase += md / S.edgeSpeedVarPeriod; S.edgeSpeedVarPhase -= Math.floor(S.edgeSpeedVarPhase);
    S.ringSpeedVarPhase += md / (S.ringSpeedVarPeriod || 20); S.ringSpeedVarPhase -= Math.floor(S.ringSpeedVarPhase);
    S.edgeSizeVarPhase += md / S.edgeSizeVarPeriod; S.edgeSizeVarPhase -= Math.floor(S.edgeSizeVarPhase);
  }
  S.effEdgeSpeed = S.edgeSpeedVar
    ? S.edgeSpeedMul * (1 - S.edgeSpeedVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.edgeSpeedVarPhase)))
    : S.edgeSpeedMul;
  // The rings' Speed breathes the same way (js/sim.js reads the effective
  // in place of the dial while the variance is up).
  S.effRingSpeedMul = S.ringSpeedVar
    ? S.ringSpeedMul * (1 - S.ringSpeedVar * 0.5 * (1 - Math.cos(2 * Math.PI * (S.ringSpeedVarPhase || 0))))
    : S.ringSpeedMul;
  S.effEdgeSize = S.edgeSizeVar
    ? S.edgeSize * (1 - S.edgeSizeVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.edgeSizeVarPhase)))
    : S.edgeSize;

  // The Ring opacity dial scales the whole layer under the variance, so the
  // dips breathe inside whatever level the viewer set.
  const ringBase = S.bright * (S.ringOpacity ?? 1);
  S.effRingBright = S.ringBrightVar
    ? ringBase * (1 - S.ringBrightVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.ringBrightPhase)))
    : ringBase;

  // The flowers' Pulse with strobe breathes the same way (gpu/flowers.js
  // reads effFlowerPulse in place of the dial while the variance is up).
  // It rides no beacon, unlike the six above: in a broadcast room it is
  // pulled onto the room clock instead (core/room-clock.js), a no-op
  // outside one.
  if (flick) {
    const fpPeriod = S.flowerPulsePeriod || 10;
    S.flowerPulsePhase = (S.flowerPulsePhase || 0) + md / fpPeriod;
    S.flowerPulsePhase -= Math.floor(S.flowerPulsePhase);
    S.flowerPulsePhase = roomPhase(flowerPulseRoom, S.flowerPulsePhase, t, md, fpPeriod, S.flowerPulsePeriodOff || 0);
  }
  S.effFlowerPulse = S.flowerPulseVar
    ? S.flowerPulse * (1 - S.flowerPulseVar * 0.5 * (1 - Math.cos(2 * Math.PI * (S.flowerPulsePhase || 0))))
    : S.flowerPulse;

  // The flowers' Opacity breathes the same way (gpu/flowers.js reads
  // effFlowerOpacity in place of the dial while the variance is up), on a
  // clock of its own, and in a room pulled onto the room clock likewise.
  if (flick) {
    const foPeriod = S.flowerOpacityPeriod || 10;
    S.flowerOpacityPhase = (S.flowerOpacityPhase || 0) + md / foPeriod;
    S.flowerOpacityPhase -= Math.floor(S.flowerOpacityPhase);
    S.flowerOpacityPhase = roomPhase(flowerOpacityRoom, S.flowerOpacityPhase, t, md, foPeriod, S.flowerOpacityPeriodOff || 0);
  }
  S.effFlowerOpacity = S.flowerOpacityVar
    ? S.flowerOpacity * (1 - S.flowerOpacityVar * 0.5 * (1 - Math.cos(2 * Math.PI * (S.flowerOpacityPhase || 0))))
    : S.flowerOpacity;

  if (S.perElementColor && S.colorWalk > 0 && flick) {
    for (let i = 0; i < 4; i++) {
      S.cornerHv[i] += (Math.random() - 0.5) * WALK_STEP * md;
      S.cornerHv[i] *= WALK_DAMP;
      if (S.cornerHv[i] > 1) S.cornerHv[i] = 1;
      if (S.cornerHv[i] < -1) S.cornerHv[i] = -1;
      S.cornerHue[i] += (1 + S.cornerHv[i] * WALK_SWING) * S.colorWalk * md / S.walkPeriod;
      S.cornerHue[i] -= Math.floor(S.cornerHue[i]);
    }
  }
  if (S.colorWalk > 0 && flick) {
    S.hueVel += (Math.random() - 0.5) * WALK_STEP * md;
    S.hueVel *= WALK_DAMP;
    if (S.hueVel > 1) S.hueVel = 1;
    if (S.hueVel < -1) S.hueVel = -1;
    S.hue += (1 + S.hueVel * WALK_SWING) * S.colorWalk * md / S.walkPeriod;
    S.hue -= Math.floor(S.hue);
    // lightness held, so apparent brightness is steady. Written into S.rgb in
    // place, as v0's strobe worker does; nothing holds S.rgb by identity.
    hslInto(S.rgb, bandHue(S.hue), S.hueSat, S.hueLight);
  }
  // Paused, the field holds steady and lit rather than fading to black, so
  // pressing space shows the strobe layer at rest instead of hiding it. A
  // steady level is perfectly balanced, so the panel guard reads it as safe.
  // Winding down with Pause stops flicker off, the flicker fades into that
  // steady level (flickerLum); with it on (the default) the level is 1 from
  // the first paused frame and only the motion coasts.
  // The panel guard stops watching at the pause, as it always has (it resets
  // its integrators the moment S.running goes false). That stays safe: the
  // leftover flicker lasts at most the wind-down's five seconds with its
  // depth falling as the square, a small fraction of the tens of seconds of
  // imbalance the guard trips on, and a stop the guard itself makes skips
  // the wind-down entirely (motionHalt in main.js). The lit log stays a
  // record of running frames only.
  const lum = flickerShows() ? flickerLum(shape(S.phase)) : 1;
  const lit = isLit(lum);
  if (S.running) pushWindow(S.litLog, lit ? 1 : 0, 120);
  lastDt = dt;

  // The ring and edge sims (js/sim.js, shared with v0) return early unless
  // S.running, so while winding down they are handed the scaled step with
  // S.running raised for just the two calls and put straight back. Nothing
  // else runs in between, so nothing else can see it.
  const ts = t / 1000;
  if (S.running) {
    updateRings(dt, ts);
    updateParticles(dt);
  } else if (md > 0) {
    // finally, so a throw in either can never leave the strobe running
    S.running = true;
    try { updateRings(md, ts); updateParticles(md); } finally { S.running = false; }
  }

  prevLit = result.lit;
  result.lum = lum;
  result.lit = lit;
  return result;
}

// This frame's field level from the last stepStrobe, 0 to 1, for chrome that
// pulses along with the field (the Strobe scale's bar). lum is the raw wave
// shape; the depth, which carries the Strobe scale, is applied the same way
// gpu/scene-data.js lights the field. Steady 1 while stopped.
export function strobeLum() {
  const l = Math.min(1, Math.max(0, result.lum)), d = S.effDepth || 0;
  return 1 - d + d * l;
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
// Stopped, nothing is lit. Winding down, the flicker still runs at its
// rate, so it is predicted the same way at this frame's depth (flickerLum);
// the next frame's depth is a touch shallower, which can only mistime a
// chore, as a late frame can.
export function nextFrameLit() {
  if (!flickerShows()) return false;
  if (S.frameLock && S.refreshHz > 0) {
    lockAdvance(S.framesPerCycle, S.frameIdx, S.phase, S.refreshHz / S.effFreq);
    const duty = S.duty;
    S.duty = lockDuty(lkFpc);
    const lit = isLit(flickerLum(shape(lkIdx / lkFpc)));
    S.duty = duty;
    return lit;
  }
  return isLit(flickerLum(shape(freePhase(S.phase, S.effFreq, nextDt()))));
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
// every slot rather than waiting for the dark ones. Winding down after a
// pause the flicker is still showing, so that counts as running until the
// wind-down ends.
const CHORE_GUARD_HZ = 20;
export function darkSlot() {
  if (!flickerShows()) return true;
  if ((S.effFreq || S.freq) < CHORE_GUARD_HZ) return true;
  if (prevLit) return false;
  if (S.frameLock && S.refreshHz > 0) return true;
  return !nextFrameLit();
}
