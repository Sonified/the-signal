// localStorage persistence. Keys are unchanged from the single-file version so
// existing saved settings survive the refactor.
import { S, layers, STORE, SKIP_KEY, RENDER_BTNS, RENDER_MAP } from './state.js';
import { $, panel } from './dom.js';
import { setColorFromPicker } from './color.js';
import { applyEdgeDir } from './sim.js';

export function saveSettings() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      freq: S.freq, depth: S.depth, bright: S.bright, wave: S.wave, fieldShape: S.fieldShape,
      color: $('color').value,
      ringSpeedMul: S.ringSpeedMul, ringFade: S.ringFade, edgeCount: S.edgeCount,
      edgeSize: S.edgeSize, trailMul: S.trailMul, edgeSpeedMul: S.edgeSpeedMul,
      edgeDir: S.edgeDir, layers,
      depthVar: S.depthVar, varPeriod: S.varPeriod, panelOpen: S.panelOpen,
      freqDrift: S.freqDrift, driftPeriod: S.driftPeriod, perElementColor: S.perElementColor,
      frameLock: S.frameLock, walkPeriod: S.walkPeriod, brightVar: S.brightVar,
      brightVarPeriod: S.brightVarPeriod, colorWalk: S.colorWalk,
      ringBrightVar: S.ringBrightVar, ringBrightPeriod: S.ringBrightPeriod,
      edgeSpeedVar: S.edgeSpeedVar, edgeSpeedVarPeriod: S.edgeSpeedVarPeriod,
      edgeSizeVar: S.edgeSizeVar, edgeSizeVarPeriod: S.edgeSizeVarPeriod,
      carrierHz: S.carrierHz, amRate: S.amRate, volume: S.volume, amLinked: S.amLinked,
      toneOn: S.toneOn, clickOn: S.clickOn, toneVol: S.toneVol, clickVol: S.clickVol, pipMs: S.pipMs,
      harmOn: S.harmOn, harmVol: S.harmVol, harmCount: S.harmCount, harmBright: S.harmBright,
      harmSpread: S.harmSpread, harmPanRate: S.harmPanRate, harmReverb: S.harmReverb,
      shimDepth: S.shimDepth, shimRate: S.shimRate, clickReverb: S.clickReverb,
      clickRevTime: S.clickRevTime, clickModDepth: S.clickModDepth, clickModPeriod: S.clickModPeriod,
      biDepth: S.biDepth, biPeriod: S.biPeriod, biHardSwitch: S.biHardSwitch,
      rendererPref: S.rendererPref,
      audioOnBoot: $('lAudio').checked,
      skipWarning: localStorage.getItem(SKIP_KEY) === '1'
    }));
  } catch (e) { console.warn('settings save failed:', e); }
}

export function applySettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { s = {}; }
  if (!s || !Object.keys(s).length) return;

  if (typeof s.freq === 'number')   { S.freq = s.freq; $('freq').value = S.freq; }
  if (typeof s.depth === 'number')  { S.depth = s.depth; $('depth').value = Math.round(S.depth*100); }
  if (typeof s.bright === 'number') { S.bright = s.bright; $('bright').value = Math.round(S.bright*100); }
  if (s.color) { $('color').value = s.color; setColorFromPicker(s.color); }
  if (typeof s.ringSpeedMul === 'number') { S.ringSpeedMul = s.ringSpeedMul; $('ringSpeed').value = S.ringSpeedMul; }
  if (typeof s.ringFade === 'number')     { S.ringFade = s.ringFade; $('ringFade').value = Math.round(S.ringFade*100); }
  if (typeof s.edgeCount === 'number')    { S.edgeCount = s.edgeCount; $('edgeCount').value = S.edgeCount; }
  if (typeof s.edgeSize === 'number')     { S.edgeSize = s.edgeSize; $('edgeSize').value = S.edgeSize; }
  if (typeof s.trailMul === 'number')     { S.trailMul = s.trailMul; $('trailLen').value = S.trailMul; }
  if (typeof s.edgeSpeedMul === 'number') { S.edgeSpeedMul = s.edgeSpeedMul; $('edgeSpeed').value = S.edgeSpeedMul; }
  if (typeof s.frameLock === 'boolean') {
    S.frameLock = s.frameLock;
    ['lkOff','lkOn'].forEach(id => $(id).classList.remove('on'));
    $(S.frameLock ? 'lkOn' : 'lkOff').classList.add('on');
  }
  if (typeof s.freqDrift === 'number')    { S.freqDrift = s.freqDrift; $('freqDrift').value = S.freqDrift; }
  if (typeof s.driftPeriod === 'number')  { S.driftPeriod = s.driftPeriod; $('driftRate').value = S.driftPeriod; }
  if (typeof s.depthVar === 'number')     { S.depthVar = s.depthVar; $('depthVar').value = Math.round(S.depthVar*100); }
  if (typeof s.varPeriod === 'number')    { S.varPeriod = s.varPeriod; $('varPeriod').value = S.varPeriod; }
  if (typeof s.brightVar === 'number')    { S.brightVar = s.brightVar; $('brightVar').value = Math.round(S.brightVar*100); }
  if (typeof s.brightVarPeriod === 'number') { S.brightVarPeriod = s.brightVarPeriod; $('brightVarPeriod').value = S.brightVarPeriod; }
  if (typeof s.colorWalk === 'number')    { S.colorWalk = s.colorWalk; $('colorWalk').value = Math.round(S.colorWalk*100); }
  if (typeof s.walkPeriod === 'number')   { S.walkPeriod = s.walkPeriod; $('walkPeriod').value = S.walkPeriod; $('walkPerVal').textContent = S.walkPeriod; }
  if (typeof s.perElementColor === 'boolean') {
    S.perElementColor = s.perElementColor;
    ['cwTogether','cwEach'].forEach(id => $(id).classList.remove('on'));
    $(S.perElementColor ? 'cwEach' : 'cwTogether').classList.add('on');
    // the corner quick-toggle shows the same setting, so it restores with it
    $('cqSingle').classList.toggle('on', !S.perElementColor);
    $('cqMulti').classList.toggle('on', S.perElementColor);
  }
  if (typeof s.ringBrightVar === 'number')    { S.ringBrightVar = s.ringBrightVar; $('ringBrightVar').value = Math.round(S.ringBrightVar*100); }
  if (typeof s.ringBrightPeriod === 'number') { S.ringBrightPeriod = s.ringBrightPeriod; $('ringBrightPeriod').value = S.ringBrightPeriod; }
  if (typeof s.edgeSpeedVar === 'number')       { S.edgeSpeedVar = s.edgeSpeedVar; $('edgeSpeedVar').value = Math.round(S.edgeSpeedVar*100); }
  if (typeof s.edgeSpeedVarPeriod === 'number') { S.edgeSpeedVarPeriod = s.edgeSpeedVarPeriod; $('edgeSpeedVarPeriod').value = S.edgeSpeedVarPeriod; }
  if (typeof s.edgeSizeVar === 'number')        { S.edgeSizeVar = s.edgeSizeVar; $('edgeSizeVar').value = Math.round(S.edgeSizeVar*100); }
  if (typeof s.edgeSizeVarPeriod === 'number')  { S.edgeSizeVarPeriod = s.edgeSizeVarPeriod; $('edgeSizeVarPeriod').value = S.edgeSizeVarPeriod; }
  if (s.panelOpen) { S.panelOpen = true; panel.classList.remove('hidden'); $('burger').classList.add('open'); }
  if (s.edgeDir) { S.edgeDir = s.edgeDir; $('edgeDir').value = S.edgeDir; applyEdgeDir(); }
  if (typeof s.carrierHz === 'number')    { S.carrierHz = s.carrierHz; $('carrier').value = S.carrierHz; $('carrVal').textContent = S.carrierHz; }
  if (typeof s.amRate === 'number')       { S.amRate = s.amRate; $('amRate').value = S.amRate; }
  if (typeof s.volume === 'number')       { S.volume = s.volume; $('vol').value = Math.round(S.volume*100); $('volVal').textContent = Math.round(S.volume*100); }

  if (s.wave) {
    S.wave = s.wave;
    const map = { sine:'wSine', triangle:'wTri', square:'wSq' };
    ['wSine','wTri','wSq'].forEach(id => $(id).classList.toggle('on', id === map[S.wave]));
  }
  if (s.fieldShape) {
    S.fieldShape = s.fieldShape;
    const map = { circle:'sCircle', panel:'sPanel', full:'sFull' };
    ['sCircle','sPanel','sFull'].forEach(id => $(id).classList.toggle('on', id === map[S.fieldShape]));
  }
  // Deliberately ignoring any stored renderer choice. The GPU backends are
  // unfinished (their edge layer draws one rounded capsule per segment, which
  // reads as beads on a string) and a stale preference silently put people
  // back on them. Canvas2D is the only verified path.
  if (false && s.rendererPref && RENDER_MAP[s.rendererPref]) {
    S.rendererPref = s.rendererPref;
    RENDER_BTNS.forEach(id => $(id).classList.toggle('on', id === RENDER_MAP[S.rendererPref]));
  }
  if (s.layers) {
    Object.assign(layers, s.layers);
    [['lField','field'],['lRings','rings'],['lCorners','corners'],['lEdge','edge']].forEach(([id,key]) => {
      $(id).checked = !!layers[key];
      $(id).closest('.lay').classList.toggle('on', !!layers[key]);
    });
  }

  // migrate the older exclusive setting if it is still on disk
  if (s.audioShape) { S.toneOn = s.audioShape === 'tone'; S.clickOn = s.audioShape === 'clicks'; }
  if (typeof s.harmOn === 'boolean') { S.harmOn = s.harmOn; $('harmToggle').textContent = S.harmOn?'On':'Off'; $('harmToggle').classList.toggle('on', S.harmOn); }
  if (typeof s.harmVol === 'number')     { S.harmVol = s.harmVol; $('harmVol').value = Math.round(S.harmVol*100); $('harmVolVal').textContent = Math.round(S.harmVol*100); }
  if (typeof s.harmCount === 'number')   { S.harmCount = s.harmCount; $('harmCount').value = S.harmCount; $('harmCountVal').textContent = S.harmCount; }
  if (typeof s.harmBright === 'number') {
    // stored values above 1 are from the old 0.1-4 rolloff scale, before the
    // slider became a 0-1 brightness; they would send a negative exponent
    S.harmBright = s.harmBright > 1 ? 0.7 : s.harmBright;
    $('harmBright').value = Math.round(S.harmBright*100);
    $('harmBrightVal').textContent = Math.round(S.harmBright*100);
  }
  if (typeof s.harmSpread === 'number')  { S.harmSpread = s.harmSpread; $('harmSpread').value = Math.round(S.harmSpread*100); $('harmSpreadVal').textContent = Math.round(S.harmSpread*100); }
  if (typeof s.harmPanRate === 'number') { S.harmPanRate = s.harmPanRate; $('harmPanRate').value = S.harmPanRate; $('harmPanVal').textContent = S.harmPanRate.toFixed(2); }
  if (typeof s.biDepth === 'number')  { S.biDepth = s.biDepth; $('biDepth').value = Math.round(S.biDepth*100); $('biDepthVal').textContent = Math.round(S.biDepth*100); }
  if (typeof s.biPeriod === 'number') { S.biPeriod = s.biPeriod; $('biRate').value = S.biPeriod; $('biRateVal').textContent = S.biPeriod.toFixed(1); }
  if (typeof s.biHardSwitch === 'boolean') { S.biHardSwitch = s.biHardSwitch; ['biHard','biSoft'].forEach(id=>$(id).classList.remove('on')); $(S.biHardSwitch?'biHard':'biSoft').classList.add('on'); }
  if (typeof s.clickModDepth === 'number') { S.clickModDepth = s.clickModDepth; $('clickModDepth').value = Math.round(S.clickModDepth*100); $('clickModVal').textContent = Math.round(S.clickModDepth*100); }
  if (typeof s.clickModPeriod === 'number') { S.clickModPeriod = s.clickModPeriod; $('clickModRate').value = S.clickModPeriod; $('clickModRateVal').textContent = S.clickModPeriod; }
  if (typeof s.clickRevTime === 'number') { S.clickRevTime = s.clickRevTime; $('clickRevTime').value = S.clickRevTime; $('clickRevTimeVal').textContent = S.clickRevTime.toFixed(1); }
  if (typeof s.clickReverb === 'number') { S.clickReverb = s.clickReverb; $('clickReverb').value = Math.round(S.clickReverb*100); $('clickRevVal').textContent = Math.round(S.clickReverb*100); }
  if (typeof s.shimDepth === 'number') { S.shimDepth = s.shimDepth; $('shimDepth').value = Math.round(S.shimDepth*100); $('shimDepthVal').textContent = Math.round(S.shimDepth*100); }
  if (typeof s.shimRate === 'number')  { S.shimRate = s.shimRate; $('shimRate').value = S.shimRate; $('shimRateVal').textContent = S.shimRate.toFixed(2); }
  if (typeof s.harmReverb === 'number')  { S.harmReverb = s.harmReverb; $('harmReverb').value = Math.round(S.harmReverb*100); $('harmRevVal').textContent = Math.round(S.harmReverb*100); }
  if (typeof s.pipMs === 'number') { S.pipMs = s.pipMs; $('pipMs').value = S.pipMs; $('pipVal').textContent = S.pipMs.toFixed(1); }
  if (typeof s.toneVol  === 'number') { S.toneVol  = s.toneVol;  $('toneVol').value  = Math.round(S.toneVol*100);  $('toneVolVal').textContent  = Math.round(S.toneVol*100); }
  if (typeof s.clickVol === 'number') { S.clickVol = s.clickVol; $('clickVol').value = Math.round(S.clickVol*100); $('clickVolVal').textContent = Math.round(S.clickVol*100); }
  if (typeof s.toneOn  === 'boolean') S.toneOn  = s.toneOn;
  if (typeof s.clickOn === 'boolean') S.clickOn = s.clickOn;
  $('aTone').classList.toggle('on', S.toneOn);
  $('aClick').classList.toggle('on', S.clickOn);
  S.amLinked = !!s.amLinked;
  ['aFree','aLink'].forEach(id => $(id).classList.remove('on'));
  $(S.amLinked ? 'aLink' : 'aFree').classList.add('on');
  $('amRate').disabled = S.amLinked;
  $('amVal').textContent = (S.amLinked ? S.freq : S.amRate).toFixed(1);

  // audio needs a user gesture, so remember the preference but don't autostart
  if (s.audioOnBoot) {
    $('lAudio').checked = true;
    $('lAudio').closest('.lay').classList.add('on');
  }
}
