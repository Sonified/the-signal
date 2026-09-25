// Controls, readouts, drawer, keyboard and the clipboard helpers.
import { S, layers, STORE, SKIP_KEY, GROUPS_KEY, RENDER_BTNS } from './state.js';
import { $, cv, hint, panel } from './dom.js';
import { bandName, posToAmp, ampToPos, ampToDb} from './util.js';
import { setColorFromPicker } from './color.js';
import { seedParticles, applyEdgeDir, seedTunnel } from './sim.js';
import { invalidateGradients } from './renderers/canvas2d.js';
import { saveSettings, paintPipLpf, lpfFromPos } from './settings.js';
import { strobeInWorker, syncWorker, WORKER_FLAG } from './strobe-bridge.js';
import { applyPreset } from './presets.js';
import { pianoOn, pianoOff, applyPianoReverb, applyPianoHP, rebuildPianoIR, applyBedVol, pianoAvailable } from './piano.js';
import { cloudsOn, cloudsOff, applyCloudReverb } from './clouds.js';
import { ambienceOn, ambienceOff, applyAmbVol, applyAmbReverb, rebuildAmbIR } from './ambience.js';
import { rebuildPool, poolSize, recentreWord, THEMES as WORD_THEMES } from './text.js';
import { chirpDurationMs } from './chirp.js';
import {
  setParam, applyLevel, applyAudioShape, applyHarmonics, applyReverbMix,
  rebuildClickIR, setAmRate, audioOn, audioOff, applyAudioGain,
  warmDevice, isDeviceWarm, refreshChirp, setPipShape, applyPipLpf} from './audio.js';

// ---------- readouts ----------
export function updateReadouts() {
  $('freqVal').textContent = S.freq.toFixed(1);
  $('depthVal').textContent = Math.round(S.depth*100);
  $('brightVal').textContent = Math.round(S.bright*100);
  $('ringVal').textContent = S.ringSpeedMul.toFixed(1);
  $('ringFadeVal').textContent = Math.round(S.ringFade*100);
  $('edgeVal').textContent = S.edgeCount;
  $('edgeSizeVal').textContent = S.edgeSize.toFixed(1);
  $('trailVal').textContent = S.trailMul.toFixed(1);
  $('edgeSpeedVal').textContent = S.edgeSpeedMul.toFixed(1);
  $('edgeSpeedVarVal').textContent = Math.round(S.edgeSpeedVar*100);
  $('edgeSpeedVarRateVal').textContent = S.edgeSpeedVarPeriod;
  $('edgeSizeVarVal').textContent = Math.round(S.edgeSizeVar*100);
  $('edgeSizeVarRateVal').textContent = S.edgeSizeVarPeriod;
  $('driftVal').textContent = S.freqDrift.toFixed(1);
  $('driftRateVal').textContent = S.driftPeriod;
  $('depthVarVal').textContent = Math.round(S.depthVar*100);
  $('varRateVal').textContent = S.varPeriod;
  $('brightVarVal').textContent = Math.round(S.brightVar*100);
  $('brightVarRateVal').textContent = S.brightVarPeriod;
  $('ringBrightVarVal').textContent = Math.round(S.ringBrightVar*100);
  $('ringBrightRateVal').textContent = S.ringBrightPeriod;
  $('walkVal').textContent = S.colorWalk === 0 ? 'off' : Math.round(S.colorWalk*100) + '%';
  $('band').textContent = bandName(S.freq);
  $('lockVal').textContent = S.frameLock
    ? (S.framesPerCycle ? S.achievedFreq.toFixed(2) + ' Hz · ' + S.framesPerCycle + ' fr' : 'on')
    : 'off';
  $('spareVal').textContent = S.spareMode;
  if (S.refreshHz) {
    const spc = S.refreshHz/S.freq;
    $('spc').textContent = spc.toFixed(1);
    // An odd frame count never samples phase 0.5, which is where the waveform
    // peaks, so the flicker quietly falls short of the depth the slider claims
    // -- 5 frames reaches 90.5%, 3 frames only 75%. Nothing else on screen says
    // so: the achieved frequency is exactly right, which is what makes it easy
    // to miss. On a 60 Hz panel this is every rate between 7.5 and 15 except 10.
    const oddFrames = S.frameLock && S.framesPerCycle > 2 && S.framesPerCycle % 2;
    $('warn').textContent =
      spc < 4 ? 'few samples per cycle, waveform is getting steppy'
    : (S.freq >= 15 && S.freq <= 25) ? 'higher seizure-risk band'
    : oddFrames ? S.framesPerCycle + ' frames per cycle is odd, so the flicker never reaches full depth'
    : '';
  }
}

// ---------- layout ----------
export function resize() {
  S.DPR = Math.min(window.devicePixelRatio || 1, 2);
  S.W = window.innerWidth; S.H = window.innerHeight;
  // A canvas handed to the strobe worker refuses to be resized from here, and
  // writing its width throws. The worker sizes it on its own side from the
  // same three numbers, which the sync below carries across.
  if (!strobeInWorker()) {
    const wd = Math.max(1, Math.round(S.W * S.DPR)), hd = Math.max(1, Math.round(S.H * S.DPR));
    if (cv.width !== wd || cv.height !== hd) { cv.width = wd; cv.height = hd; }
    if (S.ctx) S.ctx.setTransform(S.DPR,0,0,S.DPR,0,0);
    if (S.renderer && S.renderer.resize) S.renderer.resize();
  }
  document.documentElement.style.setProperty('--panelH', panel.offsetHeight + 'px');
  S.edgeInsetTarget = S.panelOpen ? panel.offsetWidth : 0;
  syncWorker();
}

export function syncAmbControls() {
  const on = S.ambOn;
  $('amOn').classList.toggle('on', on);
  $('amOff').classList.toggle('on', !on);
  $('ambOnVal').textContent = on ? 'on' : 'off';
  $('ambQuick').textContent = 'atmosphere: ' + (on ? 'on' : 'off');
  document.querySelectorAll('.amb-ctl').forEach(el => { el.hidden = !on; });
}

// ---------- primary actions ----------
// Assigned when the UI is wired. Declared out here so toggle(), which the
// keyboard handler calls directly, can keep the play glyph in step.
let syncTransport = () => {};
let setColorMode  = () => {};

// First start only. Afterwards the canvas is plain and opaque, and the space
// bar is an instant stop and start rather than a two second swell.
let fieldRevealed = false;
function revealField() {
  if (fieldRevealed) return;
  fieldRevealed = true;
  cv.classList.add('lit');
  setTimeout(() => { cv.classList.remove('lit'); cv.style.opacity = '1'; cv.style.transition = 'none'; }, 2100);
}

// Three surfaces show the same switch: the corner toggle, the layers checkbox
// and the pair at the top of the Text section. They all render from here, and
// they all write through the checkbox, so none of them can disagree.
let setClickStep = () => {};
let setVisualMode = () => {};

// The pip trim ladder. Each step is a decibel offset from whatever the level
// fader says, so 'normal' is always the user's own setting and a trip through
// loud and back lands exactly where it started. 6 dB is a doubling or halving
// of amplitude, which is close to what people mean by half again as loud.
export const CLICK_STEPS = [
  ['loud',     6],
  ['normal',   0],
  ['gentle',  -6],
  ['whisper',-12],
  ['off',   null]        // null means the source switch goes off, not a trim
];

// Derived, never stored, so a combination set by hand in the drawer still reads
// honestly instead of showing a stale label.
export function clickStepNow() {
  if (!$('aClick').classList.contains('on')) return 'off';
  const row = CLICK_STEPS.find(r => r[1] === S.pipTrimDb);
  return row ? row[0] : 'normal';
}
// Six shorthand arrangements of the four visual layers. Like every other corner
// toggle this drives the layer checkboxes rather than the state, so the drawer
// and the corner can never disagree, and the label is derived from whatever the
// checkboxes actually say. A set the cycle cannot produce reads as 'custom'
// instead of showing a stale mode.
export const VISUAL_MODES = [
  ['full',        { field:true,  rings:true,  corners:true,  edge:true  }],
  // The corner glows are driven by shape(S.phase), the strobe waveform itself,
  // so they pulse whether or not the field layer is drawing. Leaving them on
  // here made 'strobe off' a lie. Anything the strobe drives goes off together.
  ['strobe off',  { field:false, rings:true,  corners:false, edge:true  }],
  ['strobe only', { field:true,  rings:false, corners:true,  edge:false }],
  ['rings only',  { field:false, rings:true,  corners:false, edge:false }],
  ['edge only',   { field:false, rings:false, corners:false, edge:true  }],
  ['off',         { field:false, rings:false, corners:false, edge:false }]
];
const LAYER_BOX = { field:'lField', rings:'lRings', corners:'lCorners', edge:'lEdge' };

export function visualModeNow() {
  for (const [name, want] of VISUAL_MODES) {
    if (Object.keys(want).every(k => !!S.layers[k] === want[k])) return name;
  }
  return 'custom';
}
export function syncVisualQuick() {
  $('visualQuick').textContent = 'visual: ' + visualModeNow();
}

export function syncAudioQuick() {
  $('clickQuick').textContent = 'click: ' + clickStepNow();
  $('toneQuick').textContent  = 'tone: '  + (S.toneOn ? 'on' : 'off');
}

export function syncTextQuick() {
  const on = !!S.layers.text;
  $('textQuick').textContent = 'text: ' + (on ? 'on' : 'off');
  $('txOn').classList.toggle('on', on);
  $('txOff').classList.toggle('on', !on);
  $('textOnVal').textContent = on ? 'on' : 'off';
}

// Served from a dev machine rather than the public site.
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);

export function toggle() {
  // One press starts everything. The device wake still happens on this
  // gesture, so audio is held back briefly afterwards rather than fading in
  // underneath the wake transient.
  const cold = !isDeviceWarm();
  if (cold) warmDevice().then(() => { if ($('lAudio').checked) audioOn(); });
  S.running = !S.running;
  // Drops the chrome's backdrop blurs for the duration of the run. Blurring a
  // backdrop that changes every frame re-reads and re-blurs the canvas 120
  // times a second, which is what was stealing presents out of the strobe.
  document.body.classList.toggle('running', S.running);
  if (S.running) {
    if (!S.rings.length) seedTunnel(16);
    hint.classList.add('hide');
    revealField();
    // Megabytes of samples are fetched on the first press, never at page load,
    // so someone who reads the notice and leaves downloads nothing.
    if (S.musicOn) { pianoOn(); if (S.cloudsOn) cloudsOn(); }
    if (S.ambOn)   ambienceOn();
  } else {
    hint.classList.remove('hide');
    pianoOff(); cloudsOff(); ambienceOff();
  }
  // Start and stop is the one strobe input that never passes through
  // saveSettings, so it tells the worker itself. The worker seeds its own
  // tunnel on the transition, the same way the line above does for this side.
  syncWorker();
  applyAudioGain();
  syncTransport();
}

// Full screen answers to three different vocabularies. Chrome, Firefox and
// desktop Safari take the standard names; iPadOS Safari only answers to the
// webkit-prefixed ones; iPhone Safari has no element full-screen API at all.
// The old call was a single optional-chained `requestFullscreen?.()`, so on
// every one of those phones the button quietly did nothing and read as broken
// rather than as unavailable.
const FS_REQUEST = ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen'];
const FS_EXIT    = ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen'];

export function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

export function fullscreenAvailable() {
  const el = document.documentElement;
  if (!FS_REQUEST.some(m => typeof el[m] === 'function')) return false;
  // `false` here is a real refusal (a sandboxed frame, a permissions policy);
  // undefined just means the browser never shipped the standard flag.
  const flag = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
  return flag !== false;
}

// A home-screen launch already runs without browser chrome, so the field is
// full screen before the button is ever pressed and there is nothing to toggle.
export function isStandalone() {
  return navigator.standalone === true ||
         !!window.matchMedia?.('(display-mode: standalone)').matches ||
         !!window.matchMedia?.('(display-mode: fullscreen)').matches;
}

export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac; the touch points give it away.
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

// Returns false when the browser has no way to do this, so the caller can say
// so instead of leaving a dead control.
export function toggleFullscreen() {
  if (!fullscreenAvailable()) return false;
  const el = document.documentElement;
  try {
    if (!fsElement()) {
      const m = FS_REQUEST.find(n => typeof el[n] === 'function');
      // The standard call returns a promise that rejects when the gesture has
      // expired; the prefixed one returns nothing and takes no options.
      const r = m === 'requestFullscreen' ? el[m]({ navigationUI: 'hide' }) : el[m]();
      Promise.resolve(r).catch(() => {});
    } else {
      const m = FS_EXIT.find(n => typeof document[n] === 'function');
      if (m) Promise.resolve(document[m]()).catch(() => {});
    }
  } catch { return false; }
  return true;
}

export function togglePanel(force) {
  const t = $('tip'); if (t) t.classList.remove('show');
  const willOpen = force !== undefined ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willOpen);
  $('burger').classList.toggle('open', willOpen);
  S.panelOpen = willOpen;
  S.edgeInsetTarget = willOpen ? panel.offsetWidth : 0;

  S.panelAnimating = true;
  clearTimeout(S.panelAnimTimer);
  // fallback in case transitionend never fires (interrupted toggle, reduced motion)
  S.panelAnimTimer = setTimeout(() => { S.panelAnimating = false; }, 450);

  saveSettings();
}

// ---------- main-thread stalls ----------
// Everything else in the diagnostics describes intent: what phase the loop
// meant to show and when its callback happened to run. Those numbers looked
// perfect while the screen was visibly dropping frames, because a present lost
// in the compositor never shows up as a late callback. A long task is a
// different and more honest signal: the main thread was busy for 50 ms or more
// and nothing else on it could run. With the strobe in its worker these no
// longer touch the frames, but they still say what the UI is costing.
//
// The ground truth for presented versus dropped frames is outside the page:
// Chrome DevTools > Performance, record, and read the Frames track, where a
// dropped or partially presented frame is marked as such. chrome://gpu shows
// whether the canvas was promoted to an overlay plane (look for overlay and
// low-latency canvas lines), which is what desynchronized:true is asking for.
const LONG_TASK_WINDOW = 5000;
const longTasks = [];               // [startTime, duration], oldest first
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push([entry.startTime, entry.duration]);
    const cutoff = performance.now() - LONG_TASK_WINDOW;
    while (longTasks.length && longTasks[0][0] < cutoff) longTasks.shift();
  }).observe({ type: 'longtask', buffered: true });
} catch (e) { /* no longtask support; the line reads as unavailable */ }
const longTaskSupported = typeof PerformanceObserver === 'function' &&
  (PerformanceObserver.supportedEntryTypes || []).includes('longtask');

function longTaskSummary() {
  if (!longTaskSupported) return 'unavailable in this browser';
  const cutoff = performance.now() - LONG_TASK_WINDOW;
  while (longTasks.length && longTasks[0][0] < cutoff) longTasks.shift();
  let worst = 0;
  for (const [, dur] of longTasks) if (dur > worst) worst = dur;
  return `${longTasks.length}, worst ${Math.round(worst)} ms`;
}

// ---------- clipboard ----------
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); cb(); } catch (e) {}
  ta.remove();
}

// ---------- wiring ----------
export function initUI() {
  window.addEventListener('resize', resize);

  // Every mutation point calls saveSettings() directly. The delegated
  // document-level listeners further down are a backstop only -- relying on
  // delegation alone silently lost settings when a handler stopped propagation.
  $('freq').addEventListener('input', e => {
    S.freq = +e.target.value;
    if (S.amLinked) { setAmRate(S.freq); $('amVal').textContent = S.freq.toFixed(1); }
    updateReadouts(); saveSettings();
  });
  $('depth').addEventListener('input', e => { S.depth = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('bright').addEventListener('input', e => { S.bright = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('color').addEventListener('input', e => { setColorFromPicker(e.target.value); saveSettings(); });
  $('ringSpeed').addEventListener('input', e => { S.ringSpeedMul = +e.target.value; updateReadouts(); saveSettings(); });
  $('edgeCount').addEventListener('input', e => { S.edgeCount = +e.target.value; seedParticles(S.edgeCount); updateReadouts(); saveSettings(); });
  $('ringThick').addEventListener('input', e => {
    S.ringThick = +e.target.value; $('ringThickVal').textContent = S.ringThick.toFixed(1);
    saveSettings();
  });
  $('ringThickVar').addEventListener('input', e => {
    S.ringThickVar = +e.target.value/100; $('ringThickVarVal').textContent = e.target.value;
    // existing rings keep the factor they were born with, so a change only
    // shows as new rings arrive; reseeding would make the whole tunnel jump
    saveSettings();
  });
  $('ringFade').addEventListener('input', e => { S.ringFade = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('edgeSize').addEventListener('input', e => { S.edgeSize = +e.target.value; updateReadouts(); saveSettings(); });
  $('trailLen').addEventListener('input', e => { S.trailMul = +e.target.value; updateReadouts(); saveSettings(); });
  $('ringBrightVar').addEventListener('input', e => { S.ringBrightVar = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('ringBrightPeriod').addEventListener('input', e => { S.ringBrightPeriod = +e.target.value; updateReadouts(); saveSettings(); });
  $('brightVar').addEventListener('input', e => { S.brightVar = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('brightVarPeriod').addEventListener('input', e => { S.brightVarPeriod = +e.target.value; updateReadouts(); saveSettings(); });

  $('presetSel').addEventListener('change', e => {
    const v = e.target.value;
    if (v) applyPreset(v);
    e.target.value = '';        // reset so the same preset can be re-applied
    e.target.blur();
  });

  function setFrameLock(on, btn) {
    S.frameLock = on;
    ['lkOff','lkOn'].forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on'); btn.blur();
    updateReadouts(); saveSettings();
  }
  $('lkOff').onclick = e => setFrameLock(false, e.currentTarget);
  $('lkOn').onclick  = e => setFrameLock(true,  e.currentTarget);

  // Which way the odd frame goes. Takes effect on the next cycle; no reload,
  // since it is just a different duty for the same lock.
  function setSpare(mode, btn) {
    S.spareMode = mode;
    ['spLit','spDark'].forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on'); btn.blur();
    updateReadouts(); saveSettings();
  }
  $('spLit').onclick  = e => setSpare('lit',  e.currentTarget);
  $('spDark').onclick = e => setSpare('dark', e.currentTarget);

  // Two surfaces control one setting: the drawer pair and the quick toggle in
  // the corner. Both route through here so they can never disagree.
  // Two surfaces control one setting: the drawer pair and the corner toggle.
  // Both route through here so they can never disagree.
  function setWalkMode(each) {
    S.perElementColor = each;
    markWalkButtons(each);
    syncColorLabel();
    invalidateGradients();             // corners swap color source, so rebuild
    saveSettings();
  }
  $('cwTogether').onclick = e => { setWalkMode(false); e.currentTarget.blur(); };
  $('cwEach').onclick     = e => { setWalkMode(true);  e.currentTarget.blur(); };

  // Three color modes, cycled by one button. Each is shorthand for settings
  // that already exist in the drawer, so nothing here is new state.
  //   rotating  the whole field shares one hue, walking the wheel
  //   multi     every element walks the wheel on its own
  //   magenta   the signature hue, held still
  const COLOR_MODES = ['rotating', 'multi', 'magenta'];

  function markWalkButtons(each) {
    ['cwTogether','cwEach'].forEach(id => $(id).classList.remove('on'));
    $(each ? 'cwEach' : 'cwTogether').classList.add('on');
  }
  // The label is derived rather than stored, so the drawer controls and the
  // corner toggle can never drift apart no matter which one was touched.
  function syncColorLabel() {
    S.colorMode = S.colorWalk <= 0 ? 'magenta'
                : S.perElementColor ? 'multi' : 'rotating';
    $('colorQuick').textContent = 'color: ' + S.colorMode;
  }

  // Magenta means the hue is held, which means the walk goes to zero. Without
  // somewhere to put the old amount that is destructive: set the walk to 40%,
  // touch the corner toggle twice, and the 40 is gone for good and comes back
  // as 100. So the last non-zero amount is kept here and handed back when the
  // cycle returns to a walking mode.
  let lastWalk = 1;

  setColorMode = function (mode) {
    if (S.colorWalk > 0) lastWalk = S.colorWalk;
    S.perElementColor = mode === 'multi';
    markWalkButtons(S.perElementColor);

    const walkIn = $('colorWalk');
    walkIn.value = mode === 'magenta' ? 0 : Math.round((lastWalk || 1) * 100);
    walkIn.dispatchEvent(new Event('input', { bubbles: true }));

    if (mode === 'magenta') {
      const col = $('color');
      col.value = '#d400ff';
      col.dispatchEvent(new Event('input', { bubbles: true }));
    }
    invalidateGradients();
    syncColorLabel();
    saveSettings();
  };

  $('colorQuick').onclick = e => {
    const i = COLOR_MODES.indexOf(S.colorMode);
    setColorMode(COLOR_MODES[(i + 1) % COLOR_MODES.length]);
    e.currentTarget.blur();
  };

  // Three named arcs. Warm runs from magenta-red round through amber and stops
  // short of green, so nothing in it is anywhere near the blue that suppresses
  // melatonin. Cool is the mirror of it, for contrast rather than for sleep.
  const HUE_BANDS = { full: [0, 1, 'full wheel'], warm: [0.93, 0.19, 'warm'], cool: [0.45, 0.25, 'cool'] };
  function setHueBand(name) {
    const b = HUE_BANDS[name] || HUE_BANDS.full;
    S.hueLo = b[0]; S.hueSpan = b[1];
    $('hueBandVal').textContent = b[2];
    ['hbFull','hbWarm','hbCool'].forEach(id => $(id).classList.remove('on'));
    $({ full:'hbFull', warm:'hbWarm', cool:'hbCool' }[name] || 'hbFull').classList.add('on');
    invalidateGradients();
    saveSettings();
  }
  $('hbFull').onclick = e => { setHueBand('full'); e.currentTarget.blur(); };
  $('hbWarm').onclick = e => { setHueBand('warm'); e.currentTarget.blur(); };
  $('hbCool').onclick = e => { setHueBand('cool'); e.currentTarget.blur(); };

  $('walkPeriod').addEventListener('input', e => {
    S.walkPeriod = +e.target.value; $('walkPerVal').textContent = S.walkPeriod; saveSettings();
  });
  $('colorWalk').addEventListener('input', e => { S.colorWalk = +e.target.value/100; updateReadouts(); syncColorLabel(); saveSettings(); });
  $('freqDrift').addEventListener('input', e => { S.freqDrift = +e.target.value; updateReadouts(); saveSettings(); });
  $('driftRate').addEventListener('input', e => { S.driftPeriod = +e.target.value; updateReadouts(); saveSettings(); });
  $('depthVar').addEventListener('input', e => { S.depthVar = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('varPeriod').addEventListener('input', e => { S.varPeriod = +e.target.value; updateReadouts(); saveSettings(); });
  $('edgeSpeedVar').addEventListener('input', e => { S.edgeSpeedVar = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('edgeSpeedVarPeriod').addEventListener('input', e => { S.edgeSpeedVarPeriod = +e.target.value; updateReadouts(); saveSettings(); });
  $('edgeSizeVar').addEventListener('input', e => { S.edgeSizeVar = +e.target.value/100; updateReadouts(); saveSettings(); });
  $('edgeSizeVarPeriod').addEventListener('input', e => { S.edgeSizeVarPeriod = +e.target.value; updateReadouts(); saveSettings(); });
  $('edgeSpeed').addEventListener('input', e => { S.edgeSpeedMul = +e.target.value; updateReadouts(); saveSettings(); });
  $('edgeDir').addEventListener('change', e => { S.edgeDir = e.target.value; applyEdgeDir(); saveSettings(); });

  // ---- music and ambience -------------------------------------------------
  // Both are heavy layers that fetch megabytes on demand, so they start only
  // when asked and their controls hide when they are off, like every other
  // section in this drawer.
  function paintMusic() {
    const on = S.musicOn;
    $('muOn').classList.toggle('on', on);
    $('muOff').classList.toggle('on', !on);
    $('musicOnVal').textContent = on ? 'on' : 'off';
    $('musicQuick').textContent = 'music: ' + (on ? 'on' : 'off');
    document.querySelectorAll('.music-ctl').forEach(el => { el.hidden = !on; });
  }
  function setMusic(on) {
    S.musicOn = on;
    paintMusic();
    if (on) { pianoOn(); if (S.cloudsOn) cloudsOn(); } else { pianoOff(); cloudsOff(); }
    saveSettings();
  }
  $('muOn').onclick  = e => { setMusic(true);  e.currentTarget.blur(); };
  $('muOff').onclick = e => { setMusic(false); e.currentTarget.blur(); };
  $('musicQuick').onclick = e => { e.stopPropagation(); setMusic(!S.musicOn); e.currentTarget.blur(); };

  function setAmb(on) {
    S.ambOn = on;
    syncAmbControls();
    if (on && S.running) ambienceOn(); else ambienceOff();
    saveSettings();
  }
  $('amOn').onclick  = e => { setAmb(true);  e.currentTarget.blur(); };
  $('amOff').onclick = e => { setAmb(false); e.currentTarget.blur(); };
  $('ambQuick').onclick = e => {
    e.stopPropagation();
    togglePanel(false);
    window.dispatchEvent(new Event('openatmospheremixer'));
    e.currentTarget.blur();
  };

  const bind = (id, key, fmt, after) => $(id).addEventListener('input', e => {
    S[key] = fmt(+e.target.value);
    $(id + 'Val').textContent = e.target.value;
    if (after) after();
    saveSettings();
  });
  bind('pianoVol',  'pianoVol',  v => v/100);
  bind('bedVol',    'bedVol',    v => v/100, applyBedVol);
  bind('ambVol',    'ambVol',    v => v/100, applyAmbVol);
  $('ambReverb').addEventListener('input', e => {
    S.ambReverb = +e.target.value/100; $('ambRevVal').textContent = e.target.value;
    applyAmbReverb(); saveSettings();
  });
  $('ambRevTime').addEventListener('input', e => {
    S.ambRevTime = +e.target.value; $('ambRevTimeVal').textContent = S.ambRevTime.toFixed(1);
    rebuildAmbIR(); saveSettings();
  });
  bind('pianoDensity','pianoDensity', v => v/100);
  bind('pianoSpread','pianoSpread', v => v/100);
  bind('pianoHold', 'pianoHold', v => v/100);
  bind('pianoRubato', 'pianoRubato', v => v/100);
  bind('pianoBass', 'pianoBass', v => v);
  $('pianoReverb').addEventListener('input', e => {
    S.pianoReverb = +e.target.value/100; $('pianoRevVal').textContent = e.target.value;
    applyPianoReverb(); saveSettings();
  });
  $('pianoHP').addEventListener('input', e => {
    S.pianoHP = +e.target.value;
    $('pianoHPVal').textContent = S.pianoHP <= 20 ? 'off' : S.pianoHP + ' Hz';
    applyPianoHP(); saveSettings();
  });
  $('pianoRevTime').addEventListener('input', e => {
    S.pianoRevTime = +e.target.value; $('pianoRevTimeVal').textContent = S.pianoRevTime.toFixed(1);
    rebuildPianoIR(); saveSettings();
  });
  $('pianoCentre').addEventListener('input', e => {
    S.pianoCentre = +e.target.value;
    const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    $('pianoCentreVal').textContent = N[S.pianoCentre%12] + (Math.floor(S.pianoCentre/12)-1);
    saveSettings();
  });

  // ---- clouds ------------------------------------------------------------
  bind('cloudVol',     'cloudVol',     v => v/100);
  bind('cloudDensity', 'cloudDensity', v => v/100);
  bind('cloudPhrase',  'cloudPhrase',  v => v/100);
  $('cloudReverb').addEventListener('input', e => {
    S.cloudReverb = +e.target.value/100; $('cloudRevVal').textContent = e.target.value;
    applyCloudReverb(); saveSettings();
  });
  function paintClouds() {
    const on = S.cloudsOn;
    $('clOn').classList.toggle('on', on);
    $('clOff').classList.toggle('on', !on);
    $('cloudsOnVal').textContent = on ? 'on' : 'off';
    document.querySelectorAll('.cloud-ctl').forEach(el => { el.hidden = !on; });
  }
  function setClouds(on) {
    S.cloudsOn = on;
    paintClouds();
    // only actually sounds while the music layer as a whole is running
    if (on && S.musicOn && S.running) cloudsOn(); else cloudsOff();
    saveSettings();
  }
  $('clOn').onclick  = e => { setClouds(true);  e.currentTarget.blur(); };
  $('clOff').onclick = e => { setClouds(false); e.currentTarget.blur(); };
  paintClouds();

  // ---- words -------------------------------------------------------------
  function setTextSource(linked) {
    S.textLinked = linked;
    $('txLink').classList.toggle('on', linked);
    $('txFree').classList.toggle('on', !linked);
    $('textLinkVal').textContent = linked ? 'strobe' : 'own rate';
    saveSettings();
  }
  $('txLink').onclick = e => { setTextSource(true);  e.currentTarget.blur(); };
  $('txFree').onclick = e => { setTextSource(false); e.currentTarget.blur(); };

  $('textRate').addEventListener('input', e => {
    S.textRateHz = +e.target.value; $('textRateVal').textContent = S.textRateHz.toFixed(1); saveSettings();
  });
  $('textFreq').addEventListener('input', e => {
    S.textFreq = +e.target.value/100; $('textFreqVal').textContent = Math.round(S.textFreq*100); saveSettings();
  });
  $('textRandom').addEventListener('input', e => {
    S.textRandom = +e.target.value/100; $('textRandVal').textContent = Math.round(S.textRandom*100); saveSettings();
  });
  $('textRestFreq').addEventListener('input', e => {
    S.textRestFreq = +e.target.value/100; $('textRestFreqVal').textContent = Math.round(S.textRestFreq*100); saveSettings();
  });
  $('textRestSec').addEventListener('input', e => {
    S.textRestSec = +e.target.value; $('textRestSecVal').textContent = S.textRestSec; saveSettings();
  });
  $('textRestVar').addEventListener('input', e => {
    S.textRestVar = +e.target.value/100; $('textRestVarVal').textContent = Math.round(S.textRestVar*100); saveSettings();
  });
  $('textDwell').addEventListener('input', e => {
    S.textDwellMs = +e.target.value; $('textDwellVal').textContent = S.textDwellMs; saveSettings();
  });
  $('textFadeIn').addEventListener('input', e => {
    S.textFadeInMs = +e.target.value; $('textFadeInVal').textContent = S.textFadeInMs; saveSettings();
  });
  $('textFadeOut').addEventListener('input', e => {
    S.textFadeOutMs = +e.target.value; $('textFadeOutVal').textContent = S.textFadeOutMs; saveSettings();
  });
  function setTextColorMode(mode) {
    S.textColorMode = mode;
    $('txWhite').classList.toggle('on', mode === 'white');
    $('txSystem').classList.toggle('on', mode === 'system');
    $('textColorVal').textContent = mode === 'system' ? 'match the strobe' : 'white';
    saveSettings();
  }
  $('txWhite').onclick  = e => { setTextColorMode('white');  e.currentTarget.blur(); };
  $('txSystem').onclick = e => { setTextColorMode('system'); e.currentTarget.blur(); };

  $('textOpacity').addEventListener('input', e => {
    S.textOpacity = +e.target.value/100; $('textOpacityVal').textContent = Math.round(S.textOpacity*100); saveSettings();
  });
  $('textOpacityVar').addEventListener('input', e => {
    S.textOpacityVar = +e.target.value/100; $('textOpacityVarVal').textContent = Math.round(S.textOpacityVar*100); saveSettings();
  });
  $('textOpacityVarPeriod').addEventListener('input', e => {
    S.textOpacityVarPeriod = +e.target.value; $('textOpacityVarRateVal').textContent = S.textOpacityVarPeriod; saveSettings();
  });
  $('textSize').addEventListener('input', e => {
    S.textSize = +e.target.value;
    $('textSizeVal').textContent = S.textSize;
    $('word').style.fontSize = S.textSize + 'px';
    recentreWord();                    // ink offset scales with the font size
    saveSettings();
  });

  // Theme chips are built from the list itself rather than hard coded, so the
  // drawer can never fall out of step with what the word file actually carries.
  function paintPool() {
    const n = poolSize();
    $('textPoolVal').textContent = n ? n.toLocaleString() + ' words' : 'none';
  }
  function buildThemes() {
    const box = $('textThemes');
    box.textContent = '';
    const keys = Object.keys(WORD_THEMES);
    // No keys at all means "never chosen", which reads as everything on. That is
    // different from every key present and false, which is a deliberate None and
    // has to stay empty. Testing for keys rather than for any true value is what
    // keeps those two apart.
    const virgin = !Object.keys(S.textThemes).length;
    keys.forEach(k => {
      const b = document.createElement('button');
      b.textContent = WORD_THEMES[k];
      b.dataset.theme = k;
      b.classList.toggle('on', virgin || !!S.textThemes[k]);
      b.onclick = ev => {
        ev.stopPropagation();
        // The first touch of all turns a blanket "everything" into an explicit
        // set, so it subtracts one theme rather than soloing it. Once the set is
        // explicit, including an explicit None, a click is just a click.
        if (!Object.keys(S.textThemes).length) keys.forEach(x => S.textThemes[x] = true);
        S.textThemes[k] = !S.textThemes[k];
        b.classList.toggle('on', S.textThemes[k]);
        rebuildPool(); paintPool(); saveSettings();
        ev.currentTarget.blur();
      };
      box.appendChild(b);
    });
    paintPool();
  }
  function setAllThemes(on) {
    Object.keys(WORD_THEMES).forEach(k => S.textThemes[k] = on);
    [...$('textThemes').children].forEach(b => b.classList.toggle('on', on));
    rebuildPool(); paintPool(); saveSettings();
  }
  $('txAllOn').onclick  = e => { setAllThemes(true);  e.currentTarget.blur(); };
  $('txAllOff').onclick = e => { setAllThemes(false); e.currentTarget.blur(); };
  document.addEventListener('wordsloaded', buildThemes);

  [['lField','field'],['lRings','rings'],['lCorners','corners'],['lEdge','edge'],['lText','text']].forEach(([id,key]) => {
    const box = $(id);
    box.addEventListener('change', () => {
      layers[key] = box.checked;
      box.closest('.lay').classList.toggle('on', box.checked);
      if (key === 'text') syncTextQuick(); else syncVisualQuick();
      saveSettings();
    });
  });

  // The corner toggle is the same switch as the Text layer checkbox, so it goes
  // through the checkbox rather than setting the layer itself. One owner.
  $('textQuick').onclick = e => {
    e.stopPropagation();
    $('lText').click();
    e.currentTarget.blur();
  };
  setVisualMode = function (name) {
    const row = VISUAL_MODES.find(r => r[0] === name);
    if (!row) return;
    for (const [key, want] of Object.entries(row[1])) {
      const box = $(LAYER_BOX[key]);
      if (box.checked !== want) box.click();
    }
    syncVisualQuick();
  paintMusic();
  syncAmbControls();
    saveSettings();
  };
  $('visualQuick').onclick = e => {
    e.stopPropagation();
    const now = visualModeNow();
    const i = VISUAL_MODES.findIndex(r => r[0] === now);
    setVisualMode(VISUAL_MODES[(i + 1) % VISUAL_MODES.length][0]);
    e.currentTarget.blur();
  };

  $('toneQuick').onclick = e => {
    e.stopPropagation();
    $('aTone').click();          // one owner: the drawer switch
    e.currentTarget.blur();
  };

  setClickStep = function (name) {
    const row = CLICK_STEPS.find(r => r[0] === name) || CLICK_STEPS[1];
    const wantOn = row[1] !== null;
    if (wantOn) S.pipTrimDb = row[1];
    if ($('aClick').classList.contains('on') !== wantOn) $('aClick').click();
    else { applyLevel('clickLevel'); applyLevel('clickSend'); }
    syncAudioQuick();
    saveSettings();
  };

  $('clickQuick').onclick = e => {
    e.stopPropagation();
    const i = CLICK_STEPS.findIndex(r => r[0] === clickStepNow());
    setClickStep(CLICK_STEPS[(i + 1) % CLICK_STEPS.length][0]);
    e.currentTarget.blur();
  };

  const setWords = want => { if ($('lText').checked !== want) $('lText').click(); };
  $('txOn').onclick  = e => { setWords(true);  e.currentTarget.blur(); };
  $('txOff').onclick = e => { setWords(false); e.currentTarget.blur(); };

  $('lAudio').addEventListener('change', e => {
    e.target.closest('.lay').classList.toggle('on', e.target.checked);
    if (e.target.checked) audioOn(); else audioOff();   // audioOn resolves on its own
    syncAudioQuick();
    saveSettings();
  });

  $('carrier').addEventListener('input', e => {
    S.carrierHz = +e.target.value;
    $('carrVal').textContent = S.carrierHz;
    setParam('carrier', S.carrierHz);
    saveSettings();
  });
  $('amRate').addEventListener('input', e => {
    S.amRate = +e.target.value;
    $('amVal').textContent = S.amRate.toFixed(1);
    if (!S.amLinked) { S.amLinked = false; setAmRate(S.amRate); }
    saveSettings();
  });
  function setBilateral(on) {
    S.biOn = on;
    $('biToggle').textContent = on ? 'On' : 'Off';
    $('biToggle').classList.toggle('on', on);
    $('biToggle').blur();
    document.querySelectorAll('.bi-only').forEach(el => { el.hidden = !on; });
    setParam('biDepth', on ? S.biDepth : 0, 0.05);
    saveSettings();
  }
  $('biToggle').onclick = () => setBilateral(!S.biOn);

  $('biDepth').addEventListener('input', e => {
    S.biDepth = +e.target.value/100; $('biDepthVal').textContent = e.target.value;
    applyHarmonics(); saveSettings();
  });
  $('biRate').addEventListener('input', e => {
    S.biPeriod = +e.target.value; $('biRateVal').textContent = S.biPeriod.toFixed(1);
    applyHarmonics(); saveSettings();
  });
  function setBiShape(hard, btn) {
    S.biHardSwitch = hard;
    ['biHard','biSoft'].forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on'); btn.blur();
    applyHarmonics(); saveSettings();
  }
  $('biHard').onclick = e => setBiShape(true,  e.currentTarget);
  $('biSoft').onclick = e => setBiShape(false, e.currentTarget);

  $('clickModDepth').addEventListener('input', e => {
    pipSet('modDep', +e.target.value/100); $('clickModVal').textContent = e.target.value;
    applyHarmonics(); saveSettings();
  });
  $('clickModRate').addEventListener('input', e => {
    pipSet('modPer', +e.target.value); $('clickModRateVal').textContent = pipGet('modPer');
    applyHarmonics(); saveSettings();
  });
  $('clickRevTime').addEventListener('input', e => {
    pipSet('revTime', +e.target.value); $('clickRevTimeVal').textContent = pipGet('revTime').toFixed(1);
    rebuildClickIR(); saveSettings();
  });
  $('clickReverb').addEventListener('input', e => {
    pipSet('reverb', +e.target.value/100); $('clickRevVal').textContent = e.target.value;
    applyReverbMix(); applyLevel('clickSend'); saveSettings();
  });
  $('pipMs').addEventListener('input', e => {
    S.pipMs = +e.target.value;
    $('pipVal').textContent = S.pipMs.toFixed(1);
    setParam('pipMs', S.pipMs);
    saveSettings();
  });
  // Two shapes for the pip train, each with its own controls. Only the ones
  // that apply to the active shape are shown, so the section never offers a
  // dial that does nothing.
  // Five controls are shared between the two shapes but each shape stores its
  // own value for all five. The DOM element is one; which state key it points at
  // is decided by the mode. That is why moving a chirp dial cannot reach a click
  // value: they are different properties, and only one is addressed at a time.
  const PIP_KEYS = {
    vol:     ['clickVol',        'chirpVol'],
    reverb:  ['clickReverb',     'chirpReverb'],
    revTime: ['clickRevTime',    'chirpRevTime'],
    modDep:  ['clickModDepth',   'chirpModDepth'],
    modPer:  ['clickModPeriod',  'chirpModPeriod']
  };
  const pipKey = which => PIP_KEYS[which][S.clickMode === 'chirp' ? 1 : 0];
  const pipGet = which => S[pipKey(which)];
  const pipSet = (which, v) => { S[pipKey(which)] = v; };

  // Repaints the five shared controls from whichever set is live.
  function paintPipControls() {
    const word = S.clickMode === 'chirp' ? 'Chirp' : 'Click';
    document.querySelectorAll('.pipword').forEach(el => { el.textContent = word; });
    $('clickVol').value      = ampToPos(pipGet('vol'));          $('clickVolVal').textContent     = ampToDb(pipGet('vol'));
    $('clickReverb').value   = Math.round(pipGet('reverb')*100); $('clickRevVal').textContent     = Math.round(pipGet('reverb')*100);
    $('clickRevTime').value  = pipGet('revTime');                $('clickRevTimeVal').textContent = pipGet('revTime').toFixed(1);
    $('clickModDepth').value = Math.round(pipGet('modDep')*100); $('clickModVal').textContent     = Math.round(pipGet('modDep')*100);
    $('clickModRate').value  = pipGet('modPer');                 $('clickModRateVal').textContent = pipGet('modPer');
  }

  const TILT_NAMES = [[0,'white'],[0.5,'bright'],[1,'pink'],[1.25,'warm'],[1.5,'dark']];
  const tiltName = v => {
    let best = TILT_NAMES[0];
    for (const t of TILT_NAMES) if (Math.abs(t[0] - v) < Math.abs(best[0] - v)) best = t;
    return best[1];
  };
  function paintChirpLen() {
    $('chirpLenVal').textContent = chirpDurationMs(S.chirpLowHz, S.chirpHighHz).toFixed(1);
  }
  function setClickMode(mode) {
    // The drawer updates at once; the sound crossfades from one shape's voice
    // to the other's, which setPipShape owns.
    $('cmClick').classList.toggle('on', mode === 'click');
    $('cmChirp').classList.toggle('on', mode === 'chirp');
    $('clickModeVal').textContent = mode;
    S.clickMode = mode;
    paintPipVisibility();
    paintPipControls();
    paintChirpLen();
    setPipShape(mode);
    saveSettings();
  }
  $('cmClick').onclick = e => { setClickMode('click'); e.currentTarget.blur(); };
  $('cmChirp').onclick = e => { setClickMode('chirp'); e.currentTarget.blur(); };
  // Paint from the real state at init. Doing it in the markup would mean two
  // places to keep in step, and a first visit has no saved settings to restore
  // from, so the labels would sit at whatever was hardcoded.
  paintPipControls();
  paintChirpLen();
  paintHarmLock();
  paintPipVisibility();
  syncVisualQuick();
  $('cmClick').classList.toggle('on', S.clickMode === 'click');
  $('cmChirp').classList.toggle('on', S.clickMode === 'chirp');
  $('clickModeVal').textContent = S.clickMode;

  $('chirpLow').addEventListener('input', e => {
    S.chirpLowHz = +e.target.value; $('chirpLowVal').textContent = S.chirpLowHz;
    refreshChirp(); paintChirpLen(); saveSettings();
  });
  $('chirpHigh').addEventListener('input', e => {
    S.chirpHighHz = +e.target.value; $('chirpHighVal').textContent = S.chirpHighHz;
    refreshChirp(); paintChirpLen(); saveSettings();
  });
  $('chirpComp').addEventListener('input', e => {
    S.chirpComp = +e.target.value/100; $('chirpCompVal').textContent = Math.round(S.chirpComp*100);
    refreshChirp(); saveSettings();
  });
  $('chirpTilt').addEventListener('input', e => {
    S.chirpTilt = +e.target.value/100; $('chirpTiltVal').textContent = tiltName(S.chirpTilt);
    refreshChirp(); saveSettings();
  });

  // The lowpass sweep over the whole train, click or chirp alike.
  $('pipLpfToggle').onclick = e => {
    S.pipLpfOn = !S.pipLpfOn;
    paintPipLpf(); paintPipVisibility();
    applyPipLpf(); saveSettings();
    e.currentTarget.blur();
  };
  for (const k of ['pipLpfLo', 'pipLpfHi', 'pipLpfPeriod', 'pipLpfQ']) {
    $(k).addEventListener('input', e => {
      S[k] = lpfFromPos(k, +e.target.value);
      paintPipLpf(); applyPipLpf(); saveSettings();
    });
  }
  $('pipLpfWander').addEventListener('input', e => {
    S.pipLpfWander = +e.target.value / 100;
    paintPipLpf(); applyPipLpf(); saveSettings();
  });
  paintPipLpf();

  function setHarm(on) {
    S.harmOn = on;
    $('harmToggle').textContent = on ? 'On' : 'Off';
    $('harmToggle').classList.toggle('on', on);
    $('harmToggle').blur();
    paintHarmLock();
    applyLevel('harmLevel', 0.3);
    syncAudioQuick();
    saveSettings();
  }
  $('harmToggle').onclick = () => setHarm(!S.harmOn);

  $('harmVol').addEventListener('input', e => {
    S.harmVol = posToAmp(+e.target.value); $('harmVolVal').textContent = ampToDb(S.harmVol);
    applyLevel('harmLevel'); saveSettings();
  });
  $('harmCount').addEventListener('input', e => {
    S.harmCount = +e.target.value; $('harmCountVal').textContent = S.harmCount;
    applyHarmonics(); saveSettings();
  });
  $('harmBright').addEventListener('input', e => {
    S.harmBright = +e.target.value/100; $('harmBrightVal').textContent = e.target.value;
    applyHarmonics(); saveSettings();
  });
  $('harmSpread').addEventListener('input', e => {
    S.harmSpread = +e.target.value/100; $('harmSpreadVal').textContent = e.target.value;
    applyHarmonics(); saveSettings();
  });
  $('harmPanRate').addEventListener('input', e => {
    S.harmPanRate = +e.target.value; $('harmPanVal').textContent = S.harmPanRate.toFixed(2);
    applyHarmonics(); saveSettings();
  });
  $('shimDepth').addEventListener('input', e => {
    S.shimDepth = +e.target.value/100; $('shimDepthVal').textContent = e.target.value;
    applyHarmonics(); saveSettings();
  });
  $('shimRate').addEventListener('input', e => {
    S.shimRate = +e.target.value; $('shimRateVal').textContent = S.shimRate.toFixed(2);
    applyHarmonics(); saveSettings();
  });
  $('harmReverb').addEventListener('input', e => {
    S.harmReverb = +e.target.value/100; $('harmRevVal').textContent = e.target.value;
    applyReverbMix(); saveSettings();
  });

  $('toneVol').addEventListener('input', e => {
    S.toneVol = posToAmp(+e.target.value); $('toneVolVal').textContent = ampToDb(S.toneVol);
    applyLevel('toneLevel'); saveSettings();
  });
  $('clickVol').addEventListener('input', e => {
    pipSet('vol', posToAmp(+e.target.value)); $('clickVolVal').textContent = ampToDb(pipGet('vol'));
    applyLevel('clickLevel'); applyLevel('clickSend'); saveSettings();
  });
  $('vol').addEventListener('input', e => {
    S.volume = +e.target.value/100;
    $('volVal').textContent = Math.round(S.volume*100);
    applyAudioGain();
    saveSettings();
  });

  // Independent, not exclusive: either, both, or neither. Both together is the
  // useful case, since a click train carries the sharp onsets and the tone
  // carries the body.
  function toggleAudioSource(which, btn) {
    if (which === 'tone') S.toneOn = !S.toneOn; else S.clickOn = !S.clickOn;
    const on = which === 'tone' ? S.toneOn : S.clickOn;
    btn.classList.toggle('on', on);
    btn.textContent = on ? 'On' : 'Off';
    btn.blur();
    if (which === 'tone') paintHarmLock(); else paintPipVisibility();
    applyAudioShape();
    syncAudioQuick();
    saveSettings();
  }

  // One rule for the whole harmonics section. The controls are only on screen
  // when they can actually make a sound, which means harmonics on AND the tone
  // on, since harmonics are the tone's overtones rather than a source of their
  // own. With the tone off the header itself reads as unavailable, so it is
  // clear why the switch is not doing anything.
  // One place decides what the Click train section shows. Three conditions stack:
  // the source has to be on at all, and a row that belongs to one shape only
  // appears when that shape is selected. Spreading this across the mode switch,
  // the init paint and the settings restore is how the labels drifted last time.
  function paintPipVisibility() {
    const live = S.clickOn;
    const chirp = S.clickMode === 'chirp';
    document.querySelectorAll('.pip-ctl').forEach(el => {
      const only = el.classList.contains('chirp-only') ? 'chirp'
                 : el.classList.contains('click-only') ? 'click' : null;
      el.hidden = !live || (only !== null && only !== (chirp ? 'chirp' : 'click'))
               || (el.classList.contains('lpf-ctl') && !S.pipLpfOn);
    });
  }

  function paintHarmLock() {
    const toneOff = !S.toneOn;
    document.querySelectorAll('.tone-ctl').forEach(el => { el.hidden = toneOff; });
    $('harmToggle').closest('.subhead').classList.toggle('locked', toneOff);
    const live = S.harmOn && S.toneOn;
    document.querySelectorAll('.harm-ctl').forEach(el => { el.hidden = !live; });
  }
  $('aTone').onclick  = e => toggleAudioSource('tone',  e.currentTarget);
  $('aClick').onclick = e => toggleAudioSource('click', e.currentTarget);

  function setAmMode(linked, btn) {
    S.amLinked = linked;
    ['aFree','aLink'].forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on');
    btn.blur();
    $('amRate').disabled = linked;
    $('amRate').closest('.ctl').classList.toggle('locked', linked);
    if (!linked) hideTip();
    setAmRate(linked ? S.freq : S.amRate);
    $('amVal').textContent = (linked ? S.freq : S.amRate).toFixed(1);
    saveSettings();
  }
  $('aFree').onclick = e => setAmMode(false, e.target);
  $('aLink').onclick = e => setAmMode(true,  e.target);
  // Initial paint. setAmMode only ran on a click, so on a fresh visit the slider
  // was linked in behaviour but live to the touch, which is the worst of both.
  $('amRate').disabled = S.amLinked;
  $('amRate').closest('.ctl').classList.toggle('locked', S.amLinked);
  $('aLink').classList.toggle('on', S.amLinked);
  $('aFree').classList.toggle('on', !S.amLinked);

  function pick(group, val, btn, setter) {
    setter(val);
    group.forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on');
    btn.blur();
    saveSettings();
  }
  const waveBtns = ['wSine','wTri','wSq'];
  $('wSine').onclick = e => pick(waveBtns,'sine',e.target, v => S.wave=v);
  $('wTri').onclick  = e => pick(waveBtns,'triangle',e.target, v => S.wave=v);
  $('wSq').onclick   = e => pick(waveBtns,'square',e.target, v => S.wave=v);

  const shapeBtns = ['sCircle','sPanel','sFull'];
  $('sCircle').onclick = e => pick(shapeBtns,'circle',e.target, v => S.fieldShape=v);
  $('sPanel').onclick  = e => pick(shapeBtns,'panel', e.target, v => S.fieldShape=v);
  $('sFull').onclick   = e => pick(shapeBtns,'full',  e.target, v => S.fieldShape=v);

  // Renderer choice. A canvas can only ever produce one context kind, so
  // switching backends means starting the page over.
  function pickRenderer(val, btn) {
    if (val === S.rendererPref) { btn.blur(); return; }
    S.rendererPref = val;
    RENDER_BTNS.forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on');
    btn.blur();
    saveSettings();
    location.reload();
  }
  $('rAuto').onclick = e => pickRenderer('auto',     e.target);
  $('rGPU').onclick  = e => pickRenderer('webgpu',   e.target);
  $('rGL').onclick   = e => pickRenderer('webgl2',   e.target);
  $('r2D').onclick   = e => pickRenderer('canvas2d', e.target);

  // Strobe thread. Lives in localStorage rather than the settings blob because
  // the bridge has to read it before anything else loads, and a canvas can be
  // handed to a worker only once, so like the renderer it means starting over.
  // The lit button shows the choice; the renderer readout says what is live.
  const THREAD_BTNS = ['thMain', 'thWorker'];
  const workerWanted = () => localStorage.getItem(WORKER_FLAG) === '1';
  THREAD_BTNS.forEach(id => $(id).classList.toggle('on', id === (workerWanted() ? 'thWorker' : 'thMain')));
  function pickThread(worker, btn) {
    if (worker === workerWanted()) { btn.blur(); return; }
    if (worker) localStorage.setItem(WORKER_FLAG, '1'); else localStorage.removeItem(WORKER_FLAG);
    THREAD_BTNS.forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on');
    btn.blur();
    location.reload();
  }
  $('thMain').onclick   = e => pickThread(false, e.target);
  $('thWorker').onclick = e => pickThread(true,  e.target);

  // With the drawer open, a tap on the field puts the drawer away rather than
  // starting or stopping. On a phone the drawer covers most of the screen and
  // there is no Escape key, so the tap that plainly means "put this away" was
  // landing on the transport instead and stopping the session.
  //
  // Hung off pointerdown, not click: iOS synthesises a click only on elements
  // it considers interactive, and a bare canvas is not one, so a dismissal
  // waiting on click would be exactly the tap that never arrives. The flag is
  // set fresh on every pointerdown, so a click that never comes cannot leave it
  // armed and swallow a later one.
  let swallowFieldClick = false;
  cv.addEventListener('pointerdown', () => {
    swallowFieldClick = S.panelOpen;
    if (S.panelOpen) togglePanel(false);
  });
  cv.addEventListener('click', () => {
    if (swallowFieldClick) { swallowFieldClick = false; return; }
    toggle();
  });

  const fsBtn = $('fsBtn');

  // A home-screen launch is already chromeless, so the control has no job left
  // and is taken out of the corner row rather than sitting there inert.
  if (isStandalone()) fsBtn.hidden = true;
  else if (!fullscreenAvailable()) {
    // Kept clickable on purpose. A button that explains why it cannot do the
    // thing is better than one that is hidden (where did it go) or one that is
    // pressed and answers with nothing, which is what this was doing.
    fsBtn.classList.add('unavailable');
    fsBtn.title = isIOS
      ? 'Full screen is not available in iPhone Safari \u2014 add to Home Screen instead'
      : 'Full screen is not available in this browser';
  }

  fsBtn.onclick = e => {
    e.stopPropagation();
    if (!toggleFullscreen()) showFsHint(fsBtn);
    fsBtn.blur();
  };

  function syncFsBtn() {
    const on = !!fsElement();
    document.body.classList.toggle('fs', on);
    fsBtn.title = on ? 'Exit full screen (F)' : 'Full screen (F)';
    setTimeout(resize, 60);
  }
  // iPadOS Safari fires only the prefixed event, so both are listened for.
  document.addEventListener('fullscreenchange', syncFsBtn);
  document.addEventListener('webkitfullscreenchange', syncFsBtn);

  const burger = $('burger');

  panel.addEventListener('transitionend', e => {
    if (e.propertyName === 'transform' && e.target === panel) {
      S.panelAnimating = false;
      clearTimeout(S.panelAnimTimer);
    }
  });

  // <details> flips instantly and drops its content from the box tree, so a
  // closing transition never gets a chance to run. Opening is driven by adding
  // the class a frame after the element opens; closing keeps the element open
  // until the transition finishes.
  // Which sections were left open is part of how the drawer is set up, so it is
  // remembered alongside every other setting rather than resetting each load.
  let openGroups = null;
  try { openGroups = JSON.parse(localStorage.getItem(GROUPS_KEY) || 'null'); } catch (e) {}

  function saveGroups() {
    const open = [...document.querySelectorAll('details.grp')]
      .filter(d => d.classList.contains('expanded'))
      .map(d => d.querySelector('summary').textContent.trim());
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(open)); } catch (e) {}
  }

  document.querySelectorAll('details.grp').forEach(d => {
    if (openGroups) {
      const want = openGroups.includes(d.querySelector('summary').textContent.trim());
      d.open = want;
      d.classList.toggle('expanded', want);
    }
    if (d.open) d.classList.add('expanded');
    let busy = false;
    d.querySelector('summary').addEventListener('click', e => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      if (d.open) {
        d.classList.remove('expanded');
        saveGroups();
        setTimeout(() => { d.open = false; busy = false; }, 340);
      } else {
        d.open = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          d.classList.add('expanded');
          busy = false;
          saveGroups();          // only once the class is on, or it reads as shut
        }));
      }
    });
  });

  // Idle fade for the two chrome buttons. Never while the drawer is open, since
  // the burger is also the way back out of it.
  // Everything that fades, so the pointer resting on one can be told from the
  // pointer resting on the canvas: aiming at a control is not idleness, and
  // fading out from under a cursor that is about to click is maddening.
  const CHROME = ['#burger', '#fsBtn', '#colorQuick', '#textQuick', '#clickQuick',
    '#toneQuick', '#visualQuick', '#musicQuick', '#ambQuick', '#transport'];
  const HOVERED = CHROME.map(sel => `${sel}:hover`).join(',');
  const IDLE_MS = 1000;
  let idleTimer = null;
  function sleep() {
    if (S.panelOpen) return;
    // Still under the pointer: look again in a moment instead of hiding it.
    if (document.querySelector(HOVERED)) { idleTimer = setTimeout(sleep, IDLE_MS); return; }
    document.body.classList.add('idle');
  }
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(sleep, IDLE_MS);
  }
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake);
  wake();

  // no stopPropagation here: the canvas listener is bound to the canvas itself,
  // and swallowing these clicks also swallowed the save-on-change handler
  burger.addEventListener('click', () => { togglePanel(); burger.blur(); wake(); });

  // Nothing in the panel may keep focus, or it eats the spacebar. Sliders are
  // blurred on pointerup rather than on input, so a drag is never interrupted;
  // the deferred blur lets the control's own change event fire first.
  const blurSoon = el => setTimeout(() => { try { el.blur(); } catch (err) {} }, 0);

  document.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON') e.target.blur();
  });
  document.addEventListener('pointerup', e => {
    const el = e.target;
    // select is deliberately excluded: blurring here closes the native dropdown
    // before a choice can be made. It blurs on change instead.
    if (el instanceof Element && el.matches('input[type=range], button')) blurSoon(el);
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el instanceof Element && el.matches('input, select')) blurSoon(el);
  });

  // ---- tooltip -----------------------------------------------------------
  // A disabled input fires no pointer events of its own, so the row around it
  // is what listens. Hidden on leave, on drawer close and on scroll, because a
  // tooltip that outlives its target is worse than no tooltip.
  const tip = $('tip');
  let tipFor = null;
  function showTip(el, text) {
    tipFor = el;
    tip.textContent = text;
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    tip.style.left = Math.round(r.left) + 'px';
    tip.style.top  = Math.round(r.top - tip.offsetHeight - 8) + 'px';
  }
  function hideTip() { tipFor = null; tip.classList.remove('show'); tip.classList.remove('wide'); }
  window.addEventListener('scroll', hideTip, true);

  // The one tooltip that has to survive a tap rather than a hover, and the one
  // long enough to need wrapping, so it is clamped into the viewport instead of
  // running off the right edge from a button that sits in the corner.
  let fsHintTimer = null;
  function showFsHint(el) {
    tipFor = el;
    tip.textContent = isIOS
      ? 'iPhone Safari has no full-screen mode. Tap Share, then \u201cAdd to Home Screen\u201d \u2014 opening it from there runs it full screen.'
      : 'This browser does not offer full screen.';
    tip.classList.add('show', 'wide');
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top  = Math.round(Math.max(8, r.top - tip.offsetHeight - 8)) + 'px';
    clearTimeout(fsHintTimer);
    fsHintTimer = setTimeout(hideTip, 6000);
  }

  const amRow = $('amRate').closest('.ctl');
  amRow.addEventListener('pointerenter', () => {
    if (S.amLinked) showTip(amRow, 'Linked to visual (' + S.freq.toFixed(1) + ' Hz)');
  });
  amRow.addEventListener('pointerleave', hideTip);

  window.addEventListener('keydown', e => {
    // Nothing on the keyboard reaches the experience while the safety notice is
    // still up. The space bar was starting the session behind it and the tilde
    // was opening the drawer behind it, both of which skip the one screen that
    // is not allowed to be skipped.
    //
    // The one exception is Enter on a local server, where the notice is a speed
    // bump in a reload-heavy afternoon rather than a safety screen. On the real
    // site it still has to be dismissed deliberately, on the button.
    if (document.getElementById('gate')) {
      if (e.key === 'Enter' && IS_LOCAL) { e.preventDefault(); $('gateBtn').click(); }
      return;
    }
    // Let recording selectors handle their native keyboard navigation.
    if (e.target.tagName === 'SELECT') return;
    // space always starts and stops, whatever happens to be focused
    if (e.code === 'Space') { e.preventDefault(); toggle(); return; }
    // Enter is a primary action too, so it works regardless of what has focus
    if (e.key === 'Enter') { e.preventDefault(); toggleFullscreen(); return; }
    // The drawer and full screen shortcuts sit above the focus guard for the
    // same reason Space and Enter do. Leaving full screen hands focus back to
    // whatever held it before, often a slider, and a guarded key would then be
    // swallowed with no way to tell from the outside why the app went deaf.
    // Nothing here types text, so no letter or backtick can ever be input.
    if (e.key === '`' || e.key === '~') { e.preventDefault(); togglePanel(); return; }
    if (e.key.toLowerCase() === 'h') { togglePanel(); return; }
    if (e.key.toLowerCase() === 'f') { toggleFullscreen(); return; }
    // Both go through the same buttons the pointer uses, so the corner toggles,
    // the drawer controls and the keyboard can never disagree about state.
    if (e.key.toLowerCase() === 't') { $('lText').click(); return; }
    if (e.key.toLowerCase() === 'c') { $('colorQuick').click(); return; }
    if (e.key === 'Escape') { togglePanel(false); return; }
  });

  // rAF throttles in background tabs, so stop rather than drift
  // Audio keeps running when the tab is hidden, deliberately. The visuals stop
  // on their own because the browser freezes requestAnimationFrame, and resume
  // on their own when it unfreezes, so nothing here should touch `running`.
  // The only thing needed is discarding the elapsed time, or the first frame
  // back arrives carrying the entire absence as one enormous delta.
  document.addEventListener('visibilitychange', () => {
    S.lastT = null;
  });

  // ---- transport cluster, upper right -------------------------------------
  // Three surfaces onto settings that already exist: the play ring drives the
  // same toggle as the spacebar, the speaker drives the Audio layer checkbox,
  // and the track drives the Volume slider. Everything routes through the
  // existing controls so the drawer and the corner can never disagree.
  const tpVol  = $('tpVol');
  const vbody  = tpVol.querySelector('.vbody');
  const volIn  = $('vol');

  syncTransport = function () {
    $('tpPlay').textContent = S.running ? '\u275A\u275A' : '\u25B6';
    $('tpPlay').classList.toggle('showplay', !S.running);
    const muted = !$('lAudio').checked;
    tpVol.classList.toggle('muted', muted);
    tpVol.style.setProperty('--v', (+volIn.value / 100).toFixed(3));
  };

  $('tpPlay').onclick = e => { toggle(); syncTransport(); e.currentTarget.blur(); };

  tpVol.querySelector('.vmute').onclick = e => {
    $('lAudio').click();                 // the layer toggle owns audio on/off
    syncTransport();
    e.currentTarget.blur();
  };

  function dragVol(e) {
    const r = vbody.querySelector('.vtrack').getBoundingClientRect();
    const v = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    volIn.value = Math.round(v * 100);
    volIn.dispatchEvent(new Event('input', { bubbles: true }));
    syncTransport();
  }
  vbody.addEventListener('pointerdown', e => {
    vbody.setPointerCapture(e.pointerId);
    dragVol(e);
  });
  vbody.addEventListener('pointermove', e => {
    if (vbody.hasPointerCapture(e.pointerId)) dragVol(e);
  });
  vbody.addEventListener('pointerup', e => vbody.releasePointerCapture(e.pointerId));

  volIn.addEventListener('input', syncTransport);
  $('lAudio').addEventListener('change', syncTransport);
  syncTransport();

  window.addEventListener('beforeunload', audioOff);

  // save on any control change
  document.addEventListener('input',  saveSettings);
  document.addEventListener('change', saveSettings);
  document.addEventListener('click', e => { if (e.target.tagName === 'BUTTON') saveSettings(); });

  $('copyParams').onclick = e => {
    e.stopPropagation();
    const params = {
      frequencyHz: S.freq,
      depth: +S.depth.toFixed(2),
      frequencyDriftHz: S.freqDrift,
      driftSecondsPerCycle: S.driftPeriod,
      depthVariance: +S.depthVar.toFixed(2),
      brightnessVariance: +S.brightVar.toFixed(2),
      brightnessVarSecondsPerCycle: S.brightVarPeriod,
      colorWalk: +S.colorWalk.toFixed(2),
      colorWalkPerElement: S.perElementColor,
      colorWalkSecondsPerLap: S.walkPeriod,
      hueRange: S.hueSpan >= 1 ? 'full' : (S.hueLo > 0.9 || S.hueLo < 0.2 ? 'warm' : 'cool'),
      varianceSecondsPerCycle: S.varPeriod,
      frameLock: S.frameLock,
      spareFrame: S.spareMode,
      brightness: +S.bright.toFixed(2),
      color: $('color').value,
      waveform: S.wave,
      squareDuty: +S.duty.toFixed(2),
      fieldShape: S.fieldShape,
      ringSpread: S.ringSpeedMul,
      ringFadeIn: +S.ringFade.toFixed(2),
      ringLineThickness: S.ringThick,
      ringLineThicknessVariance: +S.ringThickVar.toFixed(2),
      ringBrightnessVariance: +S.ringBrightVar.toFixed(2),
      ringBrightVarSecondsPerCycle: S.ringBrightPeriod,
      edgeDensity: S.edgeCount,
      edgeSize: S.edgeSize,
      trailLength: S.trailMul,
      edgeSpeed: S.edgeSpeedMul,
      edgeSpeedVariance: +S.edgeSpeedVar.toFixed(2),
      edgeSpeedVarSecondsPerCycle: S.edgeSpeedVarPeriod,
      edgeSizeVariance: +S.edgeSizeVar.toFixed(2),
      edgeSizeVarSecondsPerCycle: S.edgeSizeVarPeriod,
      edgeRotation: S.edgeDir,
      text: {
        blinkSource: S.textLinked ? 'strobe' : 'own rate',
        ownBlinkRateHz: S.textRateHz,
        appearance: +S.textFreq.toFixed(2),
        appearanceVariance: +S.textRandom.toFixed(2),
        restFrequency: +S.textRestFreq.toFixed(2),
        restSeconds: S.textRestSec,
        restVariance: +S.textRestVar.toFixed(2),
        timeOnScreenMs: S.textDwellMs,
        fadeInMs: S.textFadeInMs,
        fadeOutMs: S.textFadeOutMs,
        wordSizePx: S.textSize,
        wordColor: S.textColorMode,
        opacity: +S.textOpacity.toFixed(2),
        opacityVariance: +S.textOpacityVar.toFixed(2),
        opacityVarSecondsPerCycle: S.textOpacityVarPeriod,
        themes: Object.keys(S.textThemes).filter(k => S.textThemes[k]),
        poolSize: poolSize()
      },
      layers: { ...layers, audio: $('lAudio').checked },
      audio: {
        carrierHz: S.carrierHz,
        pulseRateHz: S.amLinked ? S.freq : S.amRate,
        pulseLinkedToVisual: S.amLinked,
        volume: +S.volume.toFixed(2),
        toneOn: S.toneOn, toneLevel: +S.toneVol.toFixed(2),
        clickOn: S.clickOn,
        clickMode: S.clickMode,
        pipWidthMs: S.pipMs,
        chirpLowHz: S.chirpLowHz, chirpHighHz: S.chirpHighHz,
        chirpDelayCompensation: +S.chirpComp.toFixed(2),
        chirpSpectralTilt: +S.chirpTilt.toFixed(2),
        chirpLengthMs: +chirpDurationMs(S.chirpLowHz, S.chirpHighHz).toFixed(2),
        click: { level: +S.clickVol.toFixed(2), reverb: +S.clickReverb.toFixed(2),
                 reverbSeconds: S.clickRevTime,
                 loudnessVariance: +S.clickModDepth.toFixed(2),
                 loudnessVarSecondsPerCycle: S.clickModPeriod },
        chirp: { level: +S.chirpVol.toFixed(2), reverb: +S.chirpReverb.toFixed(2),
                 reverbSeconds: S.chirpRevTime,
                 loudnessVariance: +S.chirpModDepth.toFixed(2),
                 loudnessVarSecondsPerCycle: S.chirpModPeriod },
        bilateralOn: S.biOn,
        bilateralDepth: +S.biDepth.toFixed(2), bilateralSecondsPerPass: S.biPeriod,
        bilateralShape: S.biHardSwitch ? 'switch' : 'sweep',
        harmonics: { on: S.harmOn, level: +S.harmVol.toFixed(2), count: S.harmCount,
                     brightness: +S.harmBright.toFixed(2), stereoSpread: +S.harmSpread.toFixed(2),
                     panRateHz: S.harmPanRate, reverb: +S.harmReverb.toFixed(2),
                     shimmerDepth: +S.shimDepth.toFixed(2), shimmerRateHz: S.shimRate },
        amplitudeRange: '100% to 50%'
      },
      display: { measuredHz: S.refreshHz ? +S.refreshHz.toFixed(1) : null,
                 samplesPerCycle: S.refreshHz ? +(S.refreshHz/S.freq).toFixed(1) : null },
      renderer: { active: S.renderer ? S.renderer.name : null, preference: S.rendererPref }
    };
    const text = JSON.stringify(params, null, 2);
    const done = () => {
      const b = $('copyParams');
      b.textContent = 'Copied';
      b.classList.add('done');
      setTimeout(() => { b.textContent = 'Copy parameters'; b.classList.remove('done'); }, 1400);
      b.blur();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  };

  $('copyDiag').onclick = e => {
    e.stopPropagation();
    const d = S.intervals.slice().sort((a,b) => a-b);
    const q = p => d.length ? d[Math.min(d.length-1, Math.floor(d.length*p))] : 0;
    const med = q(0.5);

    // how many whole frames each strobe cycle actually lasted; uneven counts
    // here are what a stutter looks like even when every frame arrived on time
    const fpc = S.refreshHz && S.freq ? S.refreshHz/S.freq : 0;

    const lines = [
      `Open Focus frame diagnostics`,
      `time            ${new Date().toISOString()}`,
      `userAgent       ${navigator.userAgent}`,
      `renderer        ${S.renderer ? S.renderer.name : strobeInWorker() ? 'Canvas2D' : 'none'}  (preference: ${S.rendererPref})`,
      `viewport        ${S.W} x ${S.H} css px @ DPR ${S.DPR}`,
      `screen          ${screen.width} x ${screen.height}`,
      // Which thread's requestAnimationFrame the intervals below came from. In
      // the worker they are the strobe's own cadence; on main they are the
      // cadence of a thread that is also running every piece of the UI.
      `frame source    ${strobeInWorker() ? 'worker' : 'main'}`,
      ``,
      `requested freq  ${S.freq.toFixed(1)} Hz  (${bandName(S.freq)})`,
      `frame pattern   ${S.litLog.join('') || '(not running)'}`,
      `frame lock      ${S.frameLock ? 'ON, achieving ' + S.achievedFreq.toFixed(2) + ' Hz at ' + S.framesPerCycle + ' frames/cycle'
                        + (S.framesPerCycle % 2 ? ', spare frame ' + S.spareMode : '') : 'off'}`,
      `measured refresh${S.refreshHz ? ' ' + S.refreshHz.toFixed(2) + ' Hz' : ' -'}`,
      `frames/cycle    ${fpc ? fpc.toFixed(3) : '-'}  ${fpc && Number.isInteger(+fpc.toFixed(3)) ? '(divides evenly)' : '(does not divide evenly)'}`,
      ``,
      `frame intervals over last ${d.length} frames:`,
      `  median        ${med.toFixed(2)} ms`,
      `  p95           ${q(0.95).toFixed(2)} ms`,
      `  p99           ${q(0.99).toFixed(2)} ms`,
      `  worst         ${(d[d.length-1]||0).toFixed(2)} ms`,
      `  best          ${(d[0]||0).toFixed(2)} ms`,
      `  spread        ${((d[d.length-1]||0) - (d[0]||0)).toFixed(2)} ms`,
      `  dropped       ${S.dropCount}  (interval > 1.5x median)`,
      `main-thread long tasks (5s)  ${longTaskSummary()}`,
      ``,
      `active layers   ${Object.entries(layers).filter(([,v])=>v).map(([k])=>k).join(', ') || 'none'}`,
      `audio           ${$('lAudio').checked ? S.carrierHz + ' Hz carrier' : 'off'}`,
      `audio pips      ${S.pipMs} ms at ${S.carrierHz} Hz`,
      `edge density    ${S.edgeCount}   trail ${S.trailMul}x   size ${S.edgeSize}x   speed ${S.edgeSpeedMul}x   dir ${S.edgeDir}`,
      `ring spread     ${S.ringSpeedMul}x   fade in ${Math.round(S.ringFade*100)}%`,
      ``,
      `raw intervals (ms, chronological):`,
      S.intervals.map(x => x.toFixed(1)).join(' ')
    ];
    const text = lines.join('\n');
    const b = $('copyDiag');
    const done = () => {
      b.textContent = 'Copied';
      b.classList.add('done');
      setTimeout(() => { b.textContent = 'Copy diagnostics'; b.classList.remove('done'); }, 1400);
      b.blur();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  };

  $('resetWarn').onclick = e => {
    e.stopPropagation();
    try { localStorage.removeItem(STORE); localStorage.removeItem(SKIP_KEY); localStorage.removeItem(SKIP_KEY + '.seen'); localStorage.removeItem(GROUPS_KEY); } catch (err) {}
    location.reload();
  };

  // The warning is unskippable the first time a browser sees this page: the
  // opt-out only appears once someone has already read it and come back. A
  // full-field flicker is not something to let a first-time visitor click past.
  const SEEN_KEY = SKIP_KEY + '.seen';
  let seenBefore = false;
  try { seenBefore = localStorage.getItem(SEEN_KEY) === '1'; } catch (e) {}
  if (!seenBefore) {
    const row = document.querySelector('#gate .skip');
    if (row) row.remove();
  }

  $('gateBtn').onclick = () => {
    warmDevice();            // wake the device here, minutes before anything plays
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
    const skipBox = $('gateSkip');
    if (skipBox && skipBox.checked) {
      try { localStorage.setItem(SKIP_KEY, '1'); } catch (e) {}
    }
    $('gate').remove();
    resize();
  };
}
