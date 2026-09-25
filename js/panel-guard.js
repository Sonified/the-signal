// The panel guard: pauses the strobe before it can hurt an LCD.
//
// An LCD never holds a pixel at one voltage. It flips the drive polarity on
// every refresh, plus on one, minus on the next, so that over any two frames
// the liquid crystal sees no net DC. A steady image is balanced by
// construction. A strobe need not be: at 40 Hz on a 60 Hz panel the frame
// lock settles on two frames per cycle (a 30 Hz strobe), lit then dark, lit
// then dark, and every lit frame lands on the same polarity. The panel's
// inversion is defeated, a DC bias builds up in the cell, ions drift, and the
// monitor goes on flickering by itself after the app is closed. That has
// happened to a real external display, and it must never happen to a viewer's.
//
// So this module watches what the screen is actually asked to show and on
// which half of its refresh cycle. Two leaky integrators run per displayed
// refresh: one of light signed by refresh parity (plus on even, minus on odd)
// and one of light unsigned. Their ratio, the imbalance, is 1.0 for a perfect
// lit/dark alternation and 0 for anything balanced. An odd number of frames
// per cycle is always balanced, because the pattern repeats every two cycles
// with its parity flipped and the halves cancel exactly. Sine is balanced at
// every even count from four up. Square and triangle are balanced at
// multiples of four and leave a remainder at counts two more than one: square
// reads 1/3 at six and 1/5 at ten, triangle about 0.1 at six.
// Free mode near half the refresh rate beats slowly between the two
// polarities, and the integrators average a beat away once it is faster than
// their time constant.
//
// Parity is counted in display refreshes, not in callbacks: each callback
// advances the count by round(dt / T), T being the measured refresh interval,
// and the frame that was on screen is credited for every refresh it was held
// through. A dropped callback therefore holds the previous frame across two
// refreshes, one of each polarity, which is exactly what the panel saw, rather
// than flipping every later frame onto the other half.
//
// This file is pure logic over S: no DOM, no storage, no window, so v0's main
// thread, v0's strobe worker and v1 all run the same copy. Each surface calls
// guardStep(t, lum) once per frame with the strobe level it is about to draw,
// and when that returns true it stops the strobe exactly as the viewer's own
// stop does and shows guardMessage(). guardStep allocates nothing and costs a
// few multiplies; the message is built only on the frame that trips.
//
// Testing without a 60 Hz display: guardSimulate(hz) makes the guard model a
// display refreshing at `hz` instead of the real one. It replays the frame
// lock exactly as js/main.js and v1/core/strobe.js would run it at that rate
// (frames per cycle, spare frame, waveform, depth) against a virtual refresh
// clock, and feeds that into the same integrators, so the whole path from
// measurement to pause to message is exercised. Each surface exposes it in
// the console as window.signalGuard.simulate(60), with simulate(0) to go back
// to measuring the real display, and signalGuard.state to read the live
// numbers. localStorage 'signal_guard_test' set to a refresh rate ('60', or
// '1' for 60) turns the simulation on at boot. The simulation exists because
// on a 120 Hz display no setting reaches two frames per cycle: that needs a
// strobe above 48 Hz, and the slider stops at 45.
import { S, layers } from './state.js';

// Time constant of both integrators, seconds. 15 s sits between the two
// things it has to separate. A beat between free-running phase and half the
// refresh rate is attenuated by 1 / sqrt(1 + (2 pi f tau)^2): at 15 s a beat
// of 0.1 Hz (five seconds on each polarity) reads about 0.1, well under the
// trip level, while DC held for tens of seconds, which is the timescale on
// which ions in the cell actually drift, reads close to its full value.
// Detection of a steady bad pattern is not delayed by it at all: both
// integrators start from zero together, so their ratio is right within a few
// frames.
export const GUARD_TAU_S = 15;

// Trip level for the imbalance. A full lit/dark alternation reads 1.0, and
// with depth d (dark frames at 1 - d of lit) it reads d / (2 - d), so 0.25 is
// crossed at depth 0.4 and above. The worst patterns that are otherwise
// acceptable read below it: triangle at six frames per cycle 0.11, square at
// ten 0.2. Square at six (a 10 Hz square on 60 Hz) reads 0.33 and trips,
// which is right: a third of its light is net DC.
export const GUARD_TRIP = 0.25;

// How long the imbalance must stay above the trip level, continuously, before
// the strobe is paused. Long enough that a slider dragged through a bad value
// never trips, short enough that the panel sees seconds of DC, not minutes.
export const GUARD_HOLD_MS = 2500;

// Nothing is judged in the first moments after a start or a setting change.
// The refresh rate is not measured until about sixty frames have passed (the
// frame lock runs free until then), and the ratio of two sums a few frames
// old is noise. This also keeps a slow free-mode beat's first half period,
// which reads high before the other half arrives, from counting.
export const GUARD_WARM_MS = 1500;

// Below this mean level (0 to 1, the field's own level) the field is not
// really lit and there is nothing to protect.
const MIN_LIGHT = 0.02;

// The strobe frequency slider's range (index.html #freq), so the suggestions
// are always values the viewer can actually set.
const FREQ_MIN = 0.5, FREQ_MAX = 45;

// Live state, read by diagnostics and the surfaces. Written in place only.
export const guard = {
  imbalance: 0,       // |signed| / total, live
  meanLight: 0,       // total / refreshes, 0 to 1
  tripped: false,     // latched from a trip until the strobe next starts
  trips: 0,           // trips this session
  simHz: 0,           // > 0 while simulating a display at that refresh rate
  trustHz: 0,         // > 0: the refresh rate to judge by instead of S.refreshHz (js/display-watch.js)
  hz: 0,              // the refresh rate the integrators are running at
  noticeOpen: false,  // the surface's notice is showing (v1 reads it; v0 keeps its own)
  // what the display and the strobe were doing when it tripped, for the message
  tripHz: 0, tripFreq: 0, tripAchieved: 0, tripFpc: 0, tripLock: false, tripImbalance: 0
};

let signed = 0, total = 0, norm = 0;
let decay1 = 0, decayHz = 0;         // exp(-T / tau) for one refresh, cached per rate
let lastT = -1;
let prevLight = 0, prevParity = 0, havePrev = false;
let sinceReset = 0, overMs = 0;
let wasRunning = false;
// The settings whose change starts the measurement afresh: the viewer's own
// choices, so a slider dragged off a bad value is judged on the new one alone.
// The frame count is deliberately not among them. Drift, a preset's glide or
// a refresh measurement near a half can move it on their own, and a pattern
// that spends half its time on two frames per cycle is still leaning on one
// polarity; resetting on every such move would hide exactly that.
let kFreq = -1, kLock = false, kWave = '', kSpare = '', kSim = -1;
// The refresh rate the integrators have been counting at. A change of more
// than a tenth (a window moved to another panel, or the second clock in
// js/display-watch.js overruling the first) starts everything afresh: the
// parity counted at the old rate says nothing about the new one, and a
// verdict reached on one display must never carry over to the next. The new
// rate has to hold for HZ_JUMP_HOLD_MS first: a burst of dropped frames can
// pull one thirty-frame measurement down by a tenth for a moment, and a reset
// on every such dip would keep the integrators from ever reaching a verdict
// on a session that stutters often. A real change of display stays changed.
const HZ_JUMP = 0.1, HZ_JUMP_HOLD_MS = 600;
let kHz = 0, jumpMs = 0;
// the virtual display used by guardSimulate
let vAcc = 0, vCount = 0, vIdx = 0, vFpc = 0, vPhase = 0;

function resetMeasure() {
  signed = 0; total = 0; norm = 0;
  havePrev = false; prevLight = 0;
  sinceReset = 0; overMs = 0;
  vAcc = 0; vIdx = 0; vPhase = 0;
  guard.imbalance = 0; guard.meanLight = 0;
}

// Forget everything: the integrators, the trip and the rate they were
// counting at. The surfaces call this when the display changes, together
// with the strobe core's own refresh reset, so the guard judges the new
// display on its own frames alone.
export function guardReset() {
  resetMeasure();
  guard.tripped = false;
  guard.hz = 0;
  kHz = 0; jumpMs = 0; lastT = -1;
  prevParity = 0;
}

// Pretend the display refreshes at `hz` (0 to measure the real one again).
export function guardSimulate(hz) {
  guard.simHz = hz > 0 ? +hz : 0;
  vFpc = 0;
  resetMeasure();
}

// The light the field puts out for this strobe level, as the renderers draw
// it (js/renderers/canvas2d.js drawField, v1/gpu/scene-data.js): the envelope
// every strobing layer follows. Nothing strobing on screen reads as dark.
function lightOf(lum) {
  if (!(layers.field || layers.corners || layers.flowers || layers.kaleido || layers.particles)) return 0;
  const d = S.effDepth;
  return S.effBright * (1 - d + d * lum);
}

// js/util.js shape(), with the duty passed in rather than read from S, so
// the simulated display can use its own frame count's duty.
function shapeAt(p, duty) {
  if (S.wave === 'square') return p < duty ? 1 : 0;
  if (S.wave === 'triangle') return p < 0.5 ? p * 2 : 2 - p * 2;
  return 0.5 * (1 - Math.cos(2 * Math.PI * p));
}

// Credit `light` to n refreshes starting on parity `par` (0 even, 1 odd).
// Within a run of n the signs alternate, so only an odd run leaves a net.
function accumulate(light, par, n, hz) {
  if (hz !== decayHz) { decayHz = hz; decay1 = Math.exp(-1 / (hz * GUARD_TAU_S)); }
  const dec = n === 1 ? decay1 : Math.pow(decay1, n);
  signed = signed * dec + ((n & 1) ? (par ? -light : light) : 0);
  total = total * dec + light * n;
  norm = norm * dec + n;
}

// One simulated refresh at simHz: the frame lock exactly as the strobe core
// runs it, one frame per refresh, no drops.
function simRefresh(hz) {
  let p;
  let duty = 0.5;
  if (S.frameLock) {
    const fpc = Math.max(2, Math.round(hz / S.effFreq));
    if (fpc !== vFpc) { vFpc = fpc; vIdx = 0; }
    vIdx = (vIdx + 1) % fpc;
    p = vIdx / fpc;
    if (fpc & 1) duty = (Math.floor(fpc / 2) + (S.spareMode !== 'dark' ? 0.01 : -0.01)) / fpc;
  } else {
    vFpc = 0;
    vPhase += S.effFreq / hz; vPhase -= Math.floor(vPhase);
    p = vPhase;
  }
  vCount = (vCount + 1) & 1;
  accumulate(lightOf(shapeAt(p, duty)), vCount, 1, hz);
}

// Once per frame, with the strobe level this frame draws. Returns true on the
// one frame that trips; the caller pauses and shows guardMessage().
export function guardStep(t, lum) {
  if (!S.running) { wasRunning = false; lastT = -1; overMs = 0; return false; }
  if (!wasRunning) {
    wasRunning = true;
    guard.tripped = false;
    resetMeasure();
  }

  let dtMs = lastT < 0 ? 0 : t - lastT;
  lastT = t;
  // A long gap (tab hidden, a breakpoint) loses track of the parity, so the
  // measurement starts over rather than guess.
  if (dtMs > 250) { resetMeasure(); dtMs = 0; }

  const sim = guard.simHz;
  if (S.freq !== kFreq || S.frameLock !== kLock ||
      S.wave !== kWave || S.spareMode !== kSpare || sim !== kSim) {
    kFreq = S.freq; kLock = S.frameLock;
    kWave = S.wave; kSpare = S.spareMode; kSim = sim;
    resetMeasure();
  }

  if (sim) {
    vAcc += dtMs * sim / 1000;
    let n = Math.floor(vAcc);
    vAcc -= n;
    if (n > 16) n = 16;               // a stall; the gap guard above catches worse
    for (let i = 0; i < n; i++) simRefresh(sim);
  } else {
    // Nothing is counted until the refresh rate has been measured, and a
    // repeated timestamp showed nothing new. While the two clocks disagree
    // (worker mode), the slower one is the rate judged by.
    const hz = guard.trustHz > 0 ? guard.trustHz : S.refreshHz;
    if (!(hz > 20)) return false;
    if (kHz > 0 && Math.abs(hz - kHz) > HZ_JUMP * kHz) {
      jumpMs += dtMs;
      if (jumpMs >= HZ_JUMP_HOLD_MS) {
        resetMeasure();
        guard.tripped = false;
        kHz = hz; jumpMs = 0;
      }
    } else {
      kHz = hz; jumpMs = 0;
    }
    guard.hz = hz;
    if (havePrev && dtMs <= 0) return false;
    const light = lightOf(lum);
    if (havePrev) {
      // The previous frame stayed on screen from its refresh until this one:
      // n refreshes, the first on its own parity.
      let n = Math.round(dtMs * hz / 1000);
      if (n < 1) n = 1;
      accumulate(prevLight, prevParity, n, hz);
      prevParity ^= n & 1;
    } else {
      prevParity = 0; havePrev = true;
    }
    prevLight = light;
  }

  sinceReset += dtMs;
  const imb = total > 1e-6 ? Math.abs(signed) / total : 0;
  const mean = norm > 0 ? total / norm : 0;
  guard.imbalance = imb;
  guard.meanLight = mean;

  if (guard.tripped) return false;
  if (sinceReset > GUARD_WARM_MS && mean > MIN_LIGHT && imb > GUARD_TRIP) overMs += dtMs;
  else overMs = 0;
  if (overMs <= GUARD_HOLD_MS) return false;

  guard.tripped = true;
  guard.trips++;
  guard.tripImbalance = imb;
  guard.tripLock = !!S.frameLock;
  guard.tripFreq = S.freq;
  if (sim) {
    guard.tripHz = sim;
    guard.tripFpc = vFpc;
    guard.tripAchieved = S.frameLock && vFpc ? sim / vFpc : S.effFreq;
  } else {
    // the rate actually judged by, so the message's safe rates are worked
    // out for the display the verdict was reached on
    guard.tripHz = guard.hz;
    guard.tripFpc = S.framesPerCycle;
    guard.tripAchieved = S.achievedFreq;
  }
  return true;
}

// ---------- the message (built once, on a trip) ----------

function fmtHz(x) {
  if (x >= 10 && Math.abs(x - Math.round(x)) < 0.05) return String(Math.round(x));
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Strobe frequencies that are balanced on a display at `hz`: refresh / k for
// odd k, which the frame lock reproduces exactly and which cancel over every
// two cycles whatever the waveform, depth or spare frame. The nearest three
// to `target` within the slider's range, highest first. Rates in the 15-25 Hz
// photosensitive band the app warns about are never suggested.
export function safeRates(hz, target) {
  const c = [];
  for (let k = 3; k < 400; k += 2) {
    const f = hz / k;
    if (f < FREQ_MIN) break;
    if (f <= FREQ_MAX && (f < 15 || f > 25)) c.push(f);
  }
  c.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  return c.slice(0, 3).sort((a, b) => b - a);
}

function joinOr(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1];
}

// Title, body and an optional note, from the numbers recorded at the trip.
// The trip fields can also be written by a surface that did not run the
// step itself (v0's main thread, when the strobe lives in its worker).
export function guardMessage() {
  // A measured rate reads a little under the panel's nominal one (59.7 for a
  // 60 Hz screen), so it is shown, and the suggestions are worked out, from
  // the nearest whole number.
  const hz = Math.round(guard.tripHz);
  const hzTxt = String(hz);
  const safe = safeRates(hz, guard.tripFreq).map(fmtHz);
  let body = 'This screen refreshes at ' + hzTxt + ' Hz, and at this strobe setting every flash lands on the same half of its refresh cycle. ' +
    'On some LCD screens that can leave a flicker that lingers after the app is closed.';
  const hi = hz >= 110;
  if (safe.length) body += ' Try ' + joinOr(safe) + ' Hz' + (hi ? '.' : ', or use a 120 Hz display.');
  else body += hi ? ' Try a slower strobe setting.' : ' Try a slower strobe setting, or use a 120 Hz display.';
  let note = '';
  const want = guard.tripFreq, got = guard.tripAchieved;
  if (guard.tripLock && got > 0 && Math.abs(got - want) > Math.max(0.5, want * 0.05)) {
    note = fmtHz(want) + ' Hz is running as ' + fmtHz(got) + ' Hz on this screen.';
  }
  return { title: 'Paused to protect your display', body, note };
}

// One line for logs and profiler notes.
export function guardSummary() {
  return 'paused: imbalance ' + guard.tripImbalance.toFixed(2) + ' at ' + guard.tripHz.toFixed(1) + ' Hz refresh, ' +
    fmtHz(guard.tripFreq) + ' Hz set, ' + fmtHz(guard.tripAchieved) + ' Hz achieved' +
    (guard.tripLock ? ', ' + guard.tripFpc + ' frames/cycle' : ', frame lock off') +
    (guard.simHz ? ' (simulated display)' : '');
}
