// Entry point: the requestAnimationFrame loop and the boot sequence.
import { S, WALK_STEP, WALK_DAMP, WALK_SWING, SKIP_KEY } from './state.js';
import { $, hint, panel } from './dom.js';
import { shape, hslToRgb } from './util.js';
import { setColorFromPicker } from './color.js';
import { seedParticles, updateRings, updateParticles } from './sim.js';
import { initRenderer } from './renderer.js';
import { applySettings } from './settings.js';
import { initUI, updateReadouts, resize } from './ui.js';
import { ensureAudioGraph, warmDevice, audioOn, setAmRate, hasNode } from './audio.js';
import { initText, updateText } from './text.js';

let lastInset = -1;

// ---------- main loop ----------
function tick(t) {
  requestAnimationFrame(tick);

  if (S.lastT === null) S.lastT = t;
  let dt = (t - S.lastT)/1000; S.lastT = t;

  // frame-health tracking: a dropped frame is a lost luminance sample,
  // which is exactly what an uneven strobe looks like
  if (dt > 0 && dt < 0.25) {
    S.intervals.push(dt*1000);
    if (S.intervals.length > 180) S.intervals.shift();
    if (S.refreshHz) {
      const expected = 1000/S.refreshHz;
      if (dt*1000 > expected*1.5) S.dropCount++;
    }
  }

  S.frameTimes.push(t);
  if (S.frameTimes.length > 60) {
    const span = (S.frameTimes[S.frameTimes.length-1] - S.frameTimes[0]) / 1000;
    S.refreshHz = (S.frameTimes.length-1) / span;
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
  if (S.edgeInset !== lastInset) {
    lastInset = S.edgeInset;
    const off = S.edgeInset + 'px';
    hint.style.left = off;
    $('word').style.left = off;
  }

  S.lastPhase = S.phase;
  if (S.running) { S.driftPhase += dt / S.driftPeriod; S.driftPhase -= Math.floor(S.driftPhase); }
  S.effFreq = Math.max(0.1, S.freq + S.freqDrift * Math.sin(2*Math.PI*S.driftPhase));

  // a linked audio pulse has to ride the drift too, or the two come apart
  if (S.amLinked && hasNode() && Math.abs(S.effFreq - S.lastAmSet) > 0.01) {
    setAmRate(S.effFreq); S.lastAmSet = S.effFreq;
  }

  if (S.running) {
    if (S.frameLock && S.refreshHz > 0) {
      const fpc = Math.max(2, Math.round(S.refreshHz / S.effFreq));
      // An odd frame count cannot split evenly. 2-lit-1-dark reads as "mostly
      // on with a blink"; 1-lit-2-dark reads as an actual flash, so the spare
      // frame goes dark.
      S.duty = (fpc % 2) ? (Math.floor(fpc / 2) + 0.01) / fpc : 0.5;
      if (fpc !== S.framesPerCycle) { S.framesPerCycle = fpc; S.frameIdx = 0; }
      S.achievedFreq = S.refreshHz / S.framesPerCycle;
      // an integer counter, not an accumulator: adding 1/3 repeatedly drifts
      // in floating point and the cycle boundary lands on a different frame
      S.frameIdx = (S.frameIdx + 1) % S.framesPerCycle;
      S.phase = S.frameIdx / S.framesPerCycle;
    } else {
      S.framesPerCycle = 0;
      S.achievedFreq   = S.effFreq;
      S.phase += S.effFreq*dt;
    }
    S.phase -= Math.floor(S.phase);
    S.varPhase += (dt / S.varPeriod); S.varPhase -= Math.floor(S.varPhase);
  }
  // 0 at the top of the cycle, so depth starts at its full set value
  const varDip = 0.5 * (1 - Math.cos(2*Math.PI*S.varPhase));
  S.effDepth = S.depth * (1 - S.depthVar * varDip);

  if (S.running) {
    S.brightVarPhase  += (dt / S.brightVarPeriod); S.brightVarPhase  -= Math.floor(S.brightVarPhase);
    S.ringBrightPhase += (dt / S.ringBrightPeriod); S.ringBrightPhase -= Math.floor(S.ringBrightPhase);
  }
  const brightDip = 0.5 * (1 - Math.cos(2*Math.PI*S.brightVarPhase));
  S.effBright = S.bright * (1 - S.brightVar * brightDip);

  if (S.running) {
    S.edgeSpeedVarPhase += dt / S.edgeSpeedVarPeriod; S.edgeSpeedVarPhase -= Math.floor(S.edgeSpeedVarPhase);
    S.edgeSizeVarPhase  += dt / S.edgeSizeVarPeriod;  S.edgeSizeVarPhase  -= Math.floor(S.edgeSizeVarPhase);
  }
  S.effEdgeSpeed = S.edgeSpeedMul * (1 - S.edgeSpeedVar * 0.5*(1 - Math.cos(2*Math.PI*S.edgeSpeedVarPhase)));
  S.effEdgeSize  = S.edgeSize     * (1 - S.edgeSizeVar  * 0.5*(1 - Math.cos(2*Math.PI*S.edgeSizeVarPhase)));

  const ringDip = 0.5 * (1 - Math.cos(2*Math.PI*S.ringBrightPhase));
  S.effRingBright = S.bright * (1 - S.ringBrightVar * ringDip);

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
    S.rgb = hslToRgb(S.hue, S.hueSat, S.hueLight);      // lightness held, so apparent brightness is steady
  }
  const lum = S.running ? shape(S.phase) : 0;
  if (S.running) { S.litLog.push(lum > 0.5 ? 1 : 0); if (S.litLog.length > 120) S.litLog.shift(); }

  const ts = t/1000;
  updateRings(dt, ts);
  updateParticles(dt);

  updateText(t, dt);

  if (S.renderer) S.renderer.draw(lum);
}

// ---------- boot ----------
initUI();
applySettings();
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
initRenderer();
requestAnimationFrame(tick);
