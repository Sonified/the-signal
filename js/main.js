// Entry point: the requestAnimationFrame loop and the boot sequence.
import { S, WALK_STEP, WALK_DAMP, WALK_SWING, SKIP_KEY } from './state.js';
import { $, hint, panel } from './dom.js';
import { shape, hslToRgb } from './util.js';
import { setColorFromPicker, bandHue } from './color.js';
import { seedParticles, updateRings, updateParticles } from './sim.js';
import { initRenderer } from './renderer.js';
import { applySettings } from './settings.js';
import { initUI, updateReadouts, resize, syncAmbControls, toggle } from './ui.js';
import { ensureAudioGraph, warmDevice, audioOn, setAmRate, hasNode } from './audio.js';
import { initText, updateText } from './text.js';
import { initAmbMixer } from './ambience-mixer.js';
import { startStrobeWorker, strobeInWorker, syncWorkerInset, syncWorkerGuardSim, setWorkerGuardHandler, resetWorkerRefresh } from './strobe-bridge.js';
import { guard, guardStep, guardSimulate, guardMessage, guardSummary, guardReset } from './panel-guard.js';
import { displayListenScreen, displaySampleScreen, displaySummary, DISPLAY_CHANGED } from './display-watch.js';

let lastInset = -1;

// ---------- panel guard ----------
// js/panel-guard.js decides; this is v0's half of acting on it. A trip stops
// the session through the same toggle() the space bar and the play button
// use, so the audio, the music and the atmosphere all stop with it, then
// shows a card in the style of the opening safety notice. The card goes on a
// dismiss, on Escape, or on the next start; a start with the same setting
// simply trips again. With the strobe in its worker the step runs over there
// and the trip arrives through strobe-bridge.js, landing in the same place.
const guardEl = $('guard');
let guardShown = false;
function guardPause() {
  if (S.running) toggle();
  showGuardCard(guardMessage());
  console.warn('panel guard ' + guardSummary());
}
function showGuardCard(m) {
  $('guardTitle').textContent = m.title;
  $('guardBody').textContent = m.body;
  $('guardNote').textContent = m.note;
  $('guardNote').hidden = !m.note;
  guardEl.hidden = false;
  guardShown = true;
  // the opening line sits in the same place; it comes back when the card goes
  hint.classList.add('hide');
}
function hideGuard() {
  guardEl.hidden = true;
  guardShown = false;
  if (!S.running) hint.classList.remove('hide');
}
$('guardOk').addEventListener('click', hideGuard);
window.addEventListener('keydown', e => { if (guardShown && e.key === 'Escape') hideGuard(); });
setWorkerGuardHandler(guardPause);

// ---------- display tripwire ----------
// js/display-watch.js explains why: a window dragged onto another screen can
// keep being handed frames at the old screen's rate, and every safety number
// here is derived from that rate. So the screen's identity is read every
// frame, and on any change the refresh measurement, the frame lock's count
// and the panel guard's integrators are all thrown away (on the strobe
// worker's side too), and a running session stops through the same toggle a
// guard trip uses, with its own card. The next start measures the new screen
// from zero. The read is a handful of property reads and compares.
function displayPause() {
  const oldHz = S.refreshHz;
  S.frameTimes.length = 0;
  S.refreshHz = 0;
  S.framesPerCycle = 0;
  S.frameIdx = 0;
  S.lastT = null;
  guardReset();
  resetWorkerRefresh();
  // The pause-and-notice on a screen change is switched off by Robert's call
  // (2026-09-25): everything still re-measures from zero, and the panel
  // guard, judging by the new display, pauses on its own if the new panel is
  // at risk. Uncomment to bring the immediate pause back.
  // if (S.running) {
  //   toggle();
  //   showGuardCard(DISPLAY_CHANGED);
  // }
  console.warn('display changed: ' + displaySummary(oldHz, false));
}
displayListenScreen();
displaySampleScreen();

// ---------- main loop ----------
function tick(t) {
  requestAnimationFrame(tick);

  // first, so a frame on a new screen never runs on the old screen's numbers
  if (displaySampleScreen()) displayPause();

  if (S.lastT === null) S.lastT = t;
  let dt = (t - S.lastT)/1000; S.lastT = t;

  // With the strobe in its worker, this loop is only the UI's: words, readouts
  // and the drawer inset. Frame health, phase and drawing all happen on the
  // other side and arrive here through strobe-bridge.js, so the measurements
  // below would be describing the wrong thread and are left to the worker.
  const inWorker = strobeInWorker();

  // a start (with the card still up) puts the guard's card away
  if (guardShown && S.running) hideGuard();

  // frame-health tracking: a dropped frame is a lost luminance sample,
  // which is exactly what an uneven strobe looks like
  if (!inWorker && dt > 0 && dt < 0.25) {
    S.intervals.push(dt*1000);
    if (S.intervals.length > 180) S.intervals.shift();
    if (S.refreshHz) {
      const expected = 1000/S.refreshHz;
      if (dt*1000 > expected*1.5) S.dropCount++;
    }
  }

  S.frameTimes.push(t);
  if (S.frameTimes.length > 60) {
    if (!inWorker) {
      const span = (S.frameTimes[S.frameTimes.length-1] - S.frameTimes[0]) / 1000;
      S.refreshHz = (S.frameTimes.length-1) / span;
    }
    S.frameTimes = S.frameTimes.slice(-30);

    if (S.intervals.length > 20) {
      const sorted = S.intervals.slice().sort((a,b) => a-b);
      const med = sorted[sorted.length>>1];
      const worst = sorted[sorted.length-1];
      $('hz').textContent = S.refreshHz.toFixed(1) + ' Hz';
      $('jitter').textContent = `${med.toFixed(1)} / ${worst.toFixed(1)} ms`;
      $('drops').textContent = S.dropCount;
      $('drops').style.color = S.dropCount > 3 ? '#e0a44c' : '';
    }
    updateReadouts();
  }

  if (dt > 0.25) dt = 0;          // tab-switch guard

  // Track the drawer's real rendered edge while it is animating rather than
  // running a second easing curve alongside the CSS one. Two different curves
  // never stay in step; reading the rect is exact by construction. The read is
  // confined to the animation window so it costs nothing the rest of the time.
  if (S.panelAnimating) {
    S.edgeInset = Math.max(0, Math.min(S.W, panel.getBoundingClientRect().right));
  } else {
    S.edgeInset = S.edgeInsetTarget;
  }

  // The drawer pushes the whole composition right, and anything centred in the
  // field has to move with it rather than with the window. The word layer and
  // the opening line are both DOM above the canvas, so neither gets the
  // renderer's recentring for free. Done here, where the inset is computed, so
  // there is one owner rather than each layer tracking it separately.
  // Published as a custom property rather than written to `left`: both layers
  // centre themselves in CSS from it, and an inline `left` would beat that rule
  // and pin them to the drawer's edge instead. Set on the two elements, not on
  // the root: a property on the root invalidates style for the whole page on
  // every frame of the drawer's slide, and only these read it (the panel
  // guard's card centres the same way).
  if (S.edgeInset !== lastInset) {
    lastInset = S.edgeInset;
    const off = S.edgeInset + 'px';
    hint.style.setProperty('--edge-inset', off);
    $('word').style.setProperty('--edge-inset', off);
    guardEl.style.setProperty('--edge-inset', off);
    syncWorkerInset();
  }

  if (inWorker) {
    // S.phase, S.lastPhase, S.rgb and S.effFreq were written by the worker's
    // last frame message, so the audio link and the word layer read them
    // exactly as they would have from the loop below.
    if (S.amLinked && hasNode() && Math.abs(S.effFreq - S.lastAmSet) > 0.01) {
      setAmRate(S.effFreq); S.lastAmSet = S.effFreq;
    }
    updateText(t, dt);
    return;
  }

  S.lastPhase = S.phase;
  if (S.running) { S.driftPhase += dt / S.driftPeriod; S.driftPhase -= Math.floor(S.driftPhase); }
  // Each of the slow modulations below costs a cos or a sin per frame, and at
  // zero variance that trig computes a multiplier of exactly one. So each one
  // is skipped when its amount is zero; the accumulators still advance, so
  // turning a variance up mid-session picks it up where it would have been.
  S.effFreq = S.freqDrift
    ? Math.max(0.1, S.freq + S.freqDrift * Math.sin(2*Math.PI*S.driftPhase))
    : Math.max(0.1, S.freq);

  // a linked audio pulse has to ride the drift too, or the two come apart
  if (S.amLinked && hasNode() && Math.abs(S.effFreq - S.lastAmSet) > 0.01) {
    setAmRate(S.effFreq); S.lastAmSet = S.effFreq;
  }

  if (S.running) {
    if (S.frameLock && S.refreshHz > 0) {
      const fpc = Math.max(2, Math.round(S.refreshHz / S.effFreq));
      if (fpc !== S.framesPerCycle) { S.framesPerCycle = fpc; S.frameIdx = 0; }
      S.achievedFreq = S.refreshHz / S.framesPerCycle;
      // an integer counter, not an accumulator: adding 1/3 repeatedly drifts
      // in floating point and the cycle boundary lands on a different frame
      S.frameIdx = (S.frameIdx + 1) % S.framesPerCycle;
      S.phase = S.frameIdx / S.framesPerCycle;
      // An odd frame count cannot split evenly, so the spare frame has to go
      // one way or the other. Lit (2-lit-1-dark at 3 frames) reads as a bright
      // field with a blink; dark (1-lit-2-dark) reads as a flash against a gap
      // twice as long, which the eye registers as a far stronger pulse. The
      // hundredth nudges the duty just past or just short of the middle
      // sample so the choice is exact rather than a floating-point coin toss.
      const spareLit = S.spareMode !== 'dark';
      S.duty = (fpc % 2) ? (Math.floor(fpc / 2) + (spareLit ? 0.01 : -0.01)) / fpc : 0.5;
    } else {
      S.framesPerCycle = 0;
      S.achievedFreq   = S.effFreq;
      S.phase += S.effFreq*dt;
    }
    S.phase -= Math.floor(S.phase);
    S.varPhase += (dt / S.varPeriod); S.varPhase -= Math.floor(S.varPhase);
  }
  // 0 at the top of the cycle, so depth starts at its full set value
  S.effDepth = S.depthVar
    ? S.depth * (1 - S.depthVar * 0.5 * (1 - Math.cos(2*Math.PI*S.varPhase)))
    : S.depth;

  if (S.running) {
    S.brightVarPhase  += (dt / S.brightVarPeriod); S.brightVarPhase  -= Math.floor(S.brightVarPhase);
    S.ringBrightPhase += (dt / S.ringBrightPeriod); S.ringBrightPhase -= Math.floor(S.ringBrightPhase);
  }
  S.effBright = S.brightVar
    ? S.bright * (1 - S.brightVar * 0.5 * (1 - Math.cos(2*Math.PI*S.brightVarPhase)))
    : S.bright;

  if (S.running) {
    S.edgeSpeedVarPhase += dt / S.edgeSpeedVarPeriod; S.edgeSpeedVarPhase -= Math.floor(S.edgeSpeedVarPhase);
    S.edgeSizeVarPhase  += dt / S.edgeSizeVarPeriod;  S.edgeSizeVarPhase  -= Math.floor(S.edgeSizeVarPhase);
  }
  S.effEdgeSpeed = S.edgeSpeedVar
    ? S.edgeSpeedMul * (1 - S.edgeSpeedVar * 0.5*(1 - Math.cos(2*Math.PI*S.edgeSpeedVarPhase)))
    : S.edgeSpeedMul;
  S.effEdgeSize  = S.edgeSizeVar
    ? S.edgeSize     * (1 - S.edgeSizeVar  * 0.5*(1 - Math.cos(2*Math.PI*S.edgeSizeVarPhase)))
    : S.edgeSize;

  S.effRingBright = S.ringBrightVar
    ? S.bright * (1 - S.ringBrightVar * 0.5 * (1 - Math.cos(2*Math.PI*S.ringBrightPhase)))
    : S.bright;

  if (S.perElementColor && S.colorWalk > 0 && S.running) {
    for (let i = 0; i < 4; i++) {
      S.cornerHv[i] += (Math.random() - 0.5) * WALK_STEP * dt;
      S.cornerHv[i] *= WALK_DAMP;
      if (S.cornerHv[i] >  1) S.cornerHv[i] =  1;
      if (S.cornerHv[i] < -1) S.cornerHv[i] = -1;
      S.cornerHue[i] += (1 + S.cornerHv[i] * WALK_SWING) * S.colorWalk * dt / S.walkPeriod;
      S.cornerHue[i] -= Math.floor(S.cornerHue[i]);
    }
  }
  if (S.colorWalk > 0 && S.running) {
    S.hueVel += (Math.random() - 0.5) * WALK_STEP * dt;
    S.hueVel *= WALK_DAMP;
    if (S.hueVel >  1) S.hueVel =  1;
    if (S.hueVel < -1) S.hueVel = -1;
    S.hue += (1 + S.hueVel * WALK_SWING) * S.colorWalk * dt / S.walkPeriod;
    S.hue -= Math.floor(S.hue);
    S.rgb = hslToRgb(bandHue(S.hue), S.hueSat, S.hueLight);   // lightness held, so apparent brightness is steady
  }
  const lum = S.running ? shape(S.phase) : 0;
  if (S.running) { S.litLog.push(lum > 0.5 ? 1 : 0); if (S.litLog.length > 120) S.litLog.shift(); }

  // The panel guard watches the level this frame is about to show; a trip
  // stops the session before the next one.
  if (guardStep(t, lum)) guardPause();

  const ts = t/1000;
  updateRings(dt, ts);
  updateParticles(dt);

  updateText(t, dt);

  if (S.renderer) S.renderer.draw(lum);
}

// ---------- boot ----------
// Console handle for the panel guard, and its test switch. With no 60 Hz
// display to hand, signalGuard.simulate(60) makes the guard model one (see
// js/panel-guard.js); simulate(0) goes back to the real display. Setting
// localStorage 'signal_guard_test' to a refresh rate ('60', or '1' for 60)
// does the same from boot.
function simulateGuard(hz) {
  guardSimulate(hz);
  syncWorkerGuardSim(hz);
  return guard.simHz ? 'simulating a ' + guard.simHz + ' Hz display' : 'measuring the real display';
}
window.signalGuard = { simulate: simulateGuard, get state() { return guard; } };
{
  let v = null;
  try { v = localStorage.getItem('signal_guard_test'); } catch {}
  const hz = v === '1' ? 60 : parseFloat(v);
  if (hz > 0) simulateGuard(hz);
}

initUI();
applySettings();
syncAmbControls();
initAmbMixer();
// after applySettings, so the restored theme selection is what the first pool
// build sees, and after initUI, so the chip builder is already listening
initText($('word'));

if (localStorage.getItem(SKIP_KEY) === '1') {
  $('gate').remove();
  // With no gate there is no early click to wake the device on, so the first
  // pointer or key event has to do it. Registered ahead of every other
  // handler so the wake happens before anything asks for sound.
  const early = () => {
    warmDevice();
    window.removeEventListener('pointerdown', early, true);
  };
  window.addEventListener('pointerdown', early, true);
}

// audio can't start without a gesture, so resume a remembered session
// on whatever the first interaction happens to be
function resumeAudioOnce() {
  warmDevice();
  if ($('lAudio').checked && !S.audioEnabled) audioOn();
  window.removeEventListener('pointerdown', resumeAudioOnce);
  window.removeEventListener('keydown', resumeAudioOnce);
}
window.addEventListener('pointerdown', resumeAudioOnce);
window.addEventListener('keydown', resumeAudioOnce);

resize();
S.edgeInset = S.edgeInsetTarget;        // no slide-in on a page that loads with the drawer already open
ensureAudioGraph();                     // compile the worklet now, while nothing is playing
setColorFromPicker($('color').value);   // seeds hue/sat/light for the walk
seedParticles(S.edgeCount);
updateReadouts();
// The loop starts immediately; it simply draws nothing until the backend
// resolves, which takes a frame or two at most.
// With the worker flag off, startStrobeWorker answers false synchronously and
// initRenderer runs exactly where it always did. With it on, the answer comes
// once the worker has loaded and taken the canvas, or false if it could not,
// and in that case the main-thread renderer starts as the fallback.
startStrobeWorker(inWorker => { if (!inWorker) initRenderer(); });
requestAnimationFrame(tick);
