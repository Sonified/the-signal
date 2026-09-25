// localStorage persistence. Keys are unchanged from the single-file version so
// existing saved settings survive the refactor.
import { S, layers, STORE, SKIP_KEY, RENDER_BTNS, RENDER_MAP } from './state.js';
import { $, panel } from './dom.js';
import { setColorFromPicker } from './color.js';
import { applyEdgeDir } from './sim.js';
import { chirpDurationMs } from './chirp.js';
import { ampToPos, ampToDb } from './util.js';
import { normalizeAmbLayers } from './ambience.js';
import { syncWorker } from './strobe-bridge.js';

// Drawer open state, applied in one place so every path agrees.
function setDrawer(open) {
  S.panelOpen = open;
  panel.classList.toggle('hidden', !open);
  $('burger').classList.toggle('open', open);
}

export function saveSettings() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      freq: S.freq, depth: S.depth, bright: S.bright, wave: S.wave, fieldShape: S.fieldShape,
      color: $('color').value,
      ringSpeedMul: S.ringSpeedMul, ringFade: S.ringFade, ringThick: S.ringThick, ringThickVar: S.ringThickVar, edgeCount: S.edgeCount,
      edgeSize: S.edgeSize, trailMul: S.trailMul, edgeSpeedMul: S.edgeSpeedMul,
      edgeDir: S.edgeDir, layers,
      textLinked: S.textLinked, textRateHz: S.textRateHz, textFreq: S.textFreq,
      textRandom: S.textRandom, textDwellMs: S.textDwellMs,
      textFadeInMs: S.textFadeInMs, textFadeOutMs: S.textFadeOutMs,
      textSize: S.textSize, textThemes: S.textThemes,
      textOpacity: S.textOpacity, textOpacityVar: S.textOpacityVar,
      textOpacityVarPeriod: S.textOpacityVarPeriod,
      textColorMode: S.textColorMode,
      musicOn: S.musicOn, pianoVol: S.pianoVol, bedVol: S.bedVol,
      bedLpfOn: S.bedLpfOn, bedLpfLo: S.bedLpfLo, bedLpfHi: S.bedLpfHi, bedLpfPeriod: S.bedLpfPeriod,
      bedLpfQ: S.bedLpfQ, bedLpfWander: S.bedLpfWander, bedLpfSlope: S.bedLpfSlope, bedDetune: S.bedDetune,
      bedRevOn: S.bedRevOn, bedRevLevel: S.bedRevLevel, bedVerbOn: S.bedVerbOn, bedVerbLo: S.bedVerbLo, bedVerbHi: S.bedVerbHi, bedVerbPeriod: S.bedVerbPeriod,
      bedVerbWander: S.bedVerbWander,
      pianoReverb: S.pianoReverb, pianoRevTime: S.pianoRevTime, pianoHP: S.pianoHP, musicRevOn: S.musicRevOn, bedOn: S.bedOn, pianoOn: S.pianoOn, arpOn: S.arpOn, arpVol: S.arpVol, arpRate: S.arpRate, arpWave: S.arpWave, arpAtk: S.arpAtk, arpDec: S.arpDec, arpOct: S.arpOct, arpRev: S.arpRev, arpSpread: S.arpSpread,
      arpSwOn: S.arpSwOn, arpSwLo: S.arpSwLo, arpSwHi: S.arpSwHi, arpSwPeriod: S.arpSwPeriod, arpSwWander: S.arpSwWander,
      pianoDensity: S.pianoDensity, pianoCentre: S.pianoCentre,
      pianoSpread: S.pianoSpread, pianoHold: S.pianoHold, pianoBass: S.pianoBass,
      pianoRubato: S.pianoRubato,
      cloudsOn: S.cloudsOn, cloudVol: S.cloudVol, cloudDensity: S.cloudDensity,
      cloudPhrase: S.cloudPhrase, cloudReverb: S.cloudReverb, cloudRevTime: S.cloudRevTime,
      ambOn: S.ambOn, ambVol: S.ambVol, ambDrift: S.ambDrift, ambDriftFadeS: S.ambDriftFadeS,
      ambReverb: S.ambReverb, ambRevTime: S.ambRevTime,
      ambLayers: S.ambLayers,
      pipTrimDb: S.pipTrimDb, biOn: S.biOn, chirpVol: S.chirpVol, chirpReverb: S.chirpReverb, chirpRevTime: S.chirpRevTime,
      chirpModDepth: S.chirpModDepth, chirpModPeriod: S.chirpModPeriod,
      clickMode: S.clickMode, chirpLowHz: S.chirpLowHz, chirpHighHz: S.chirpHighHz,
      chirpComp: S.chirpComp, chirpTilt: S.chirpTilt,
      pipLpfOn: S.pipLpfOn, pipLpfLo: S.pipLpfLo, pipLpfHi: S.pipLpfHi, pipLpfPeriod: S.pipLpfPeriod,
      pipLpfQ: S.pipLpfQ, pipLpfWander: S.pipLpfWander,
      textRestFreq: S.textRestFreq, textRestSec: S.textRestSec, textRestVar: S.textRestVar,
      depthVar: S.depthVar, varPeriod: S.varPeriod, panelOpen: S.panelOpen,
      freqDrift: S.freqDrift, driftPeriod: S.driftPeriod, perElementColor: S.perElementColor, colorMode: S.colorMode,
      frameLock: S.frameLock, spareMode: S.spareMode, walkPeriod: S.walkPeriod, brightVar: S.brightVar,
      brightVarPeriod: S.brightVarPeriod, colorWalk: S.colorWalk,
      hueLo: S.hueLo, hueSpan: S.hueSpan,
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
  // Every control that changes the strobe already ends by saving, so this is
  // the one place that is guaranteed to see all of them, presets included.
  // A no-op unless the strobe is running in its worker.
  syncWorker();
}

// The pip filter's v0 sliders run 0-1000 on a log track (the low end of a
// frequency or a time wants the travel); S keeps real units. Shared with
// ui.js, which binds the inputs, so the mapping lives in one place.
export const LPF_LOG = { pipLpfLo: [40, 4000], pipLpfHi: [500, 18000],
                         pipLpfPeriod: [2, 300], pipLpfQ: [0.5, 6] };
export const lpfFromPos = (k, pos) => { const [a, b] = LPF_LOG[k]; return a * Math.pow(b / a, pos / 1000); };
export const lpfToPos = (k, v) => { const [a, b] = LPF_LOG[k]; return Math.round(1000 * Math.log(v / a) / Math.log(b / a)); };
export const fmtLpfHz = hz => hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + ' kHz' : Math.round(hz) + ' Hz';
export const fmtLpfSweep = sec => sec < 90 ? Math.round(sec) + 's'
  : Math.floor(sec / 60) + 'm ' + String(Math.round(sec % 60)).padStart(2, '0') + 's';

export function paintPipLpf() {
  $('pipLpfToggle').classList.toggle('on', S.pipLpfOn);
  $('pipLpfToggle').textContent = S.pipLpfOn ? 'On' : 'Off';
  for (const k of ['pipLpfLo', 'pipLpfHi', 'pipLpfPeriod', 'pipLpfQ']) $(k).value = lpfToPos(k, S[k]);
  $('pipLpfWander').value = Math.round(S.pipLpfWander * 100);
  $('pipLpfLoVal').textContent = fmtLpfHz(S.pipLpfLo);
  $('pipLpfHiVal').textContent = fmtLpfHz(S.pipLpfHi);
  $('pipLpfPeriodVal').textContent = fmtLpfSweep(S.pipLpfPeriod);
  $('pipLpfWanderVal').textContent = Math.round(S.pipLpfWander * 100);
  $('pipLpfQVal').textContent = S.pipLpfQ.toFixed(2);
}

export function applySettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { s = {}; }
  // A first visit has nothing stored, so the drawer stays shut. The markup
  // already ships it closed; stating it here means no startup path can leave a
  // new arrival looking at the control panel instead of the field.
  if (!s || !Object.keys(s).length) { setDrawer(false); return; }

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
  // Anything else saved here (an old 'alt') falls through to the default.
  if (s.spareMode === 'lit' || s.spareMode === 'dark') {
    S.spareMode = s.spareMode;
    ['spLit','spDark'].forEach(id => $(id).classList.remove('on'));
    $(S.spareMode === 'dark' ? 'spDark' : 'spLit').classList.add('on');
  }
  if (typeof s.freqDrift === 'number')    { S.freqDrift = s.freqDrift; $('freqDrift').value = S.freqDrift; }
  if (typeof s.driftPeriod === 'number')  { S.driftPeriod = s.driftPeriod; $('driftRate').value = S.driftPeriod; }
  if (typeof s.depthVar === 'number')     { S.depthVar = s.depthVar; $('depthVar').value = Math.round(S.depthVar*100); }
  if (typeof s.varPeriod === 'number')    { S.varPeriod = s.varPeriod; $('varPeriod').value = S.varPeriod; }
  if (typeof s.brightVar === 'number')    { S.brightVar = s.brightVar; $('brightVar').value = Math.round(S.brightVar*100); }
  if (typeof s.brightVarPeriod === 'number') { S.brightVarPeriod = s.brightVarPeriod; $('brightVarPeriod').value = S.brightVarPeriod; }
  if (typeof s.colorWalk === 'number')    { S.colorWalk = s.colorWalk; $('colorWalk').value = Math.round(S.colorWalk*100); }
  if (typeof s.hueLo === 'number')   S.hueLo = s.hueLo;
  if (typeof s.hueSpan === 'number') S.hueSpan = s.hueSpan;
  {
    const name = S.hueSpan >= 1 ? 'full' : (S.hueLo > 0.9 || S.hueLo < 0.2 ? 'warm' : 'cool');
    const lbl = { full:'full wheel', warm:'warm', cool:'cool' }[name];
    if ($('hueBandVal')) {
      $('hueBandVal').textContent = lbl;
      ['hbFull','hbWarm','hbCool'].forEach(id => $(id) && $(id).classList.remove('on'));
      const b = $({ full:'hbFull', warm:'hbWarm', cool:'hbCool' }[name]);
      if (b) b.classList.add('on');
    }
  }
  if (typeof s.walkPeriod === 'number')   { S.walkPeriod = s.walkPeriod; $('walkPeriod').value = S.walkPeriod; $('walkPerVal').textContent = S.walkPeriod; }
  if (typeof s.perElementColor === 'boolean') {
    S.perElementColor = s.perElementColor;
    ['cwTogether','cwEach'].forEach(id => $(id).classList.remove('on'));
    $(S.perElementColor ? 'cwEach' : 'cwTogether').classList.add('on');
  }
  if (typeof s.colorMode === 'string') {
    // the corner toggle is a shorthand for other settings, so it only needs its
    // own label restored; the settings it drives restore on their own
    // 'single' was retired when the cycle became rotating / multi / magenta.
    S.colorMode = s.colorMode === 'single' ? 'magenta' : s.colorMode;
    $('colorQuick').textContent = 'color: ' + S.colorMode;
  }
  if (typeof s.ringThick === 'number')    { S.ringThick = s.ringThick; $('ringThick').value = S.ringThick; $('ringThickVal').textContent = S.ringThick.toFixed(1); }
  if (typeof s.ringThickVar === 'number') { S.ringThickVar = s.ringThickVar; $('ringThickVar').value = Math.round(S.ringThickVar*100); $('ringThickVarVal').textContent = Math.round(S.ringThickVar*100); }
  if (typeof s.ringBrightVar === 'number')    { S.ringBrightVar = s.ringBrightVar; $('ringBrightVar').value = Math.round(S.ringBrightVar*100); }
  if (typeof s.ringBrightPeriod === 'number') { S.ringBrightPeriod = s.ringBrightPeriod; $('ringBrightPeriod').value = S.ringBrightPeriod; }
  if (typeof s.edgeSpeedVar === 'number')       { S.edgeSpeedVar = s.edgeSpeedVar; $('edgeSpeedVar').value = Math.round(S.edgeSpeedVar*100); }
  if (typeof s.edgeSpeedVarPeriod === 'number') { S.edgeSpeedVarPeriod = s.edgeSpeedVarPeriod; $('edgeSpeedVarPeriod').value = S.edgeSpeedVarPeriod; }
  if (typeof s.edgeSizeVar === 'number')        { S.edgeSizeVar = s.edgeSizeVar; $('edgeSizeVar').value = Math.round(S.edgeSizeVar*100); }
  if (typeof s.edgeSizeVarPeriod === 'number')  { S.edgeSizeVarPeriod = s.edgeSizeVarPeriod; $('edgeSizeVarPeriod').value = S.edgeSizeVarPeriod; }
  setDrawer(!!s.panelOpen);
  if (s.edgeDir) { S.edgeDir = s.edgeDir; $('edgeDir').value = S.edgeDir; applyEdgeDir(); }
  if (typeof s.carrierHz === 'number')    { S.carrierHz = s.carrierHz; $('carrier').value = S.carrierHz; $('carrVal').textContent = S.carrierHz; }
  if (typeof s.amRate === 'number')       { S.amRate = s.amRate; $('amRate').value = S.amRate; }
  if (typeof s.amLinked === 'boolean') S.amLinked = s.amLinked;
  $('amRate').disabled = S.amLinked;
  $('amRate').closest('.ctl').classList.toggle('locked', S.amLinked);
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
  // The stored renderer choice is honoured again, so the GPU backends can be
  // A/B'd by eye against Canvas2D. They are still experimental: their edge
  // layer draws one rounded capsule per segment, which reads as beads on a
  // string, and the drawer label says so. Canvas2D stays the default, so a
  // first visit never lands on them.
  if (s.rendererPref && RENDER_MAP[s.rendererPref]) {
    S.rendererPref = s.rendererPref;
    RENDER_BTNS.forEach(id => $(id).classList.toggle('on', id === RENDER_MAP[S.rendererPref]));
  }
  if (s.layers) {
    Object.assign(layers, s.layers);
    [['lField','field'],['lRings','rings'],['lCorners','corners'],['lEdge','edge'],['lText','text']].forEach(([id,key]) => {
      $(id).checked = !!layers[key];
      $(id).closest('.lay').classList.toggle('on', !!layers[key]);
    });
  }
  // kept in step without importing ui.js back into here, which would make a cycle
  {
    const M = [['full',[1,1,1,1]],['strobe off',[0,1,0,1]],['strobe only',[1,0,1,0]],
               ['rings only',[0,1,0,0]],['edge only',[0,0,0,1]],['off',[0,0,0,0]]];
    const cur = [layers.field, layers.rings, layers.corners, layers.edge].map(v => v ? 1 : 0);
    const hit = M.find(([, w]) => w.every((v, i) => v === cur[i]));
    $('visualQuick').textContent = 'visual: ' + (hit ? hit[0] : 'custom');
  }
  const wordsOn = !!layers.text;
  $('textQuick').textContent = 'text: ' + (wordsOn ? 'on' : 'off');
  $('txOn').classList.toggle('on', wordsOn);
  $('txOff').classList.toggle('on', !wordsOn);
  $('textOnVal').textContent = wordsOn ? 'on' : 'off';

  // Word layer. The theme chips are built later, once the list has loaded, and
  // they read S.textThemes at that point, so only the plain controls are
  // touched here.
  if (typeof s.textLinked === 'boolean') {
    S.textLinked = s.textLinked;
    $('txLink').classList.toggle('on', S.textLinked);
    $('txFree').classList.toggle('on', !S.textLinked);
    $('textLinkVal').textContent = S.textLinked ? 'strobe' : 'own rate';
  }
  if (typeof s.textRateHz === 'number')  { S.textRateHz = s.textRateHz; $('textRate').value = S.textRateHz; $('textRateVal').textContent = S.textRateHz.toFixed(1); }
  if (typeof s.textFreq === 'number')    { S.textFreq = s.textFreq; $('textFreq').value = Math.round(S.textFreq*100); $('textFreqVal').textContent = Math.round(S.textFreq*100); }
  if (typeof s.textRandom === 'number')  { S.textRandom = s.textRandom; $('textRandom').value = Math.round(S.textRandom*100); $('textRandVal').textContent = Math.round(S.textRandom*100); }
  if (typeof s.textDwellMs === 'number') { S.textDwellMs = s.textDwellMs; $('textDwell').value = S.textDwellMs; $('textDwellVal').textContent = S.textDwellMs; }
  // one fade slider became two; an old save seeds both
  if (typeof s.textFadeMs === 'number') { S.textFadeInMs = S.textFadeOutMs = s.textFadeMs; }
  if (typeof s.textFadeInMs === 'number')  { S.textFadeInMs = s.textFadeInMs; }
  if (typeof s.textFadeOutMs === 'number') { S.textFadeOutMs = s.textFadeOutMs; }
  $('textFadeIn').value = S.textFadeInMs;   $('textFadeInVal').textContent = S.textFadeInMs;
  $('textFadeOut').value = S.textFadeOutMs; $('textFadeOutVal').textContent = S.textFadeOutMs;
  if (typeof s.textSize === 'number')    { S.textSize = s.textSize; $('textSize').value = S.textSize; $('textSizeVal').textContent = S.textSize; }
  if (typeof s.textRestFreq === 'number') { S.textRestFreq = s.textRestFreq; $('textRestFreq').value = Math.round(S.textRestFreq*100); $('textRestFreqVal').textContent = Math.round(S.textRestFreq*100); }
  if (typeof s.textRestSec === 'number')  { S.textRestSec = s.textRestSec; $('textRestSec').value = S.textRestSec; $('textRestSecVal').textContent = S.textRestSec; }
  if (typeof s.textRestVar === 'number')  { S.textRestVar = s.textRestVar; $('textRestVar').value = Math.round(S.textRestVar*100); $('textRestVarVal').textContent = Math.round(S.textRestVar*100); }
  if (typeof s.textOpacity === 'number')    { S.textOpacity = s.textOpacity; $('textOpacity').value = Math.round(S.textOpacity*100); $('textOpacityVal').textContent = Math.round(S.textOpacity*100); }
  if (typeof s.textOpacityVar === 'number') { S.textOpacityVar = s.textOpacityVar; $('textOpacityVar').value = Math.round(S.textOpacityVar*100); $('textOpacityVarVal').textContent = Math.round(S.textOpacityVar*100); }
  if (typeof s.textOpacityVarPeriod === 'number') { S.textOpacityVarPeriod = s.textOpacityVarPeriod; $('textOpacityVarPeriod').value = S.textOpacityVarPeriod; $('textOpacityVarRateVal').textContent = S.textOpacityVarPeriod; }
  if (s.textColorMode === 'white' || s.textColorMode === 'system') {
    S.textColorMode = s.textColorMode;
    $('txWhite').classList.toggle('on', S.textColorMode === 'white');
    $('txSystem').classList.toggle('on', S.textColorMode === 'system');
    $('textColorVal').textContent = S.textColorMode === 'system' ? 'match the strobe' : 'white';
  }
  if (s.textThemes && typeof s.textThemes === 'object') S.textThemes = { ...s.textThemes };
  $('word').style.fontSize = S.textSize + 'px';

  // music and ambience
  const num = (k, f) => { if (typeof s[k] === 'number') S[k] = s[k]; if (f) f(); };
  if (typeof s.musicOn === 'boolean') S.musicOn = s.musicOn;
  if (typeof s.cloudsOn === 'boolean') S.cloudsOn = s.cloudsOn;
  if (typeof s.ambOn   === 'boolean') S.ambOn   = s.ambOn;
  if (typeof s.ambDrift === 'boolean') S.ambDrift = s.ambDrift;
  if (Array.isArray(s.ambLayers)) S.ambLayers = normalizeAmbLayers(s.ambLayers);
  ['pianoVol','bedVol','pianoReverb','pianoRevTime','pianoHP','arpVol','arpRate','arpAtk','arpDec','arpOct','arpRev','arpSpread','arpSwLo','arpSwHi','arpSwPeriod','arpSwWander','pianoDensity','pianoCentre',
   'pianoSpread','pianoHold','pianoRubato','pianoBass','ambVol','ambReverb','ambRevTime','ambDriftFadeS',
   'cloudVol','cloudDensity','cloudPhrase','cloudReverb','cloudRevTime'].forEach(k => num(k));
  {
    const pc = (id, v) => { const e = $(id); if (e) e.value = v; };
    const tx = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    pc('pianoVol', Math.round(S.pianoVol*100));       tx('pianoVolVal', Math.round(S.pianoVol*100));
    pc('bedVol', Math.round(S.bedVol*100));           tx('bedVolVal', Math.round(S.bedVol*100));
    pc('pianoReverb', Math.round(S.pianoReverb*100)); tx('pianoRevVal', Math.round(S.pianoReverb*100));
    pc('pianoRevTime', S.pianoRevTime);               tx('pianoRevTimeVal', S.pianoRevTime.toFixed(1));
    pc('pianoHP', S.pianoHP);                         tx('pianoHPVal', S.pianoHP <= 20 ? 'off' : S.pianoHP + ' Hz');
    pc('pianoDensity', Math.round(S.pianoDensity*100)); tx('pianoDensityVal', Math.round(S.pianoDensity*100));
    const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    pc('pianoCentre', S.pianoCentre);                 tx('pianoCentreVal', N[S.pianoCentre%12]+(Math.floor(S.pianoCentre/12)-1));
    pc('pianoSpread', Math.round(S.pianoSpread*100)); tx('pianoSpreadVal', Math.round(S.pianoSpread*100));
    pc('pianoHold', Math.round(S.pianoHold*100));     tx('pianoHoldVal', Math.round(S.pianoHold*100));
    pc('pianoRubato', Math.round(S.pianoRubato*100)); tx('pianoRubatoVal', Math.round(S.pianoRubato*100));
    pc('pianoBass', S.pianoBass);                     tx('pianoBassVal', S.pianoBass);
    pc('ambVol', Math.round(S.ambVol*100));           tx('ambVolVal', Math.round(S.ambVol*100));
    pc('ambReverb', Math.round(S.ambReverb*100));     tx('ambRevVal', Math.round(S.ambReverb*100));
    pc('ambRevTime', S.ambRevTime);                   tx('ambRevTimeVal', S.ambRevTime.toFixed(1));
    pc('cloudVol', Math.round(S.cloudVol*100));       tx('cloudVolVal', Math.round(S.cloudVol*100));
    pc('cloudDensity', Math.round(S.cloudDensity*100)); tx('cloudDensityVal', Math.round(S.cloudDensity*100));
    pc('cloudPhrase', Math.round(S.cloudPhrase*100)); tx('cloudPhraseVal', Math.round(S.cloudPhrase*100));
    pc('cloudReverb', Math.round(S.cloudReverb*100)); tx('cloudRevVal', Math.round(S.cloudReverb*100));
  }

  // migrate the older exclusive setting if it is still on disk
  if (s.audioShape) { S.toneOn = s.audioShape === 'tone'; S.clickOn = s.audioShape === 'clicks'; }
  if (typeof s.harmOn === 'boolean') { S.harmOn = s.harmOn; $('harmToggle').textContent = S.harmOn?'On':'Off'; $('harmToggle').classList.toggle('on', S.harmOn); }
  if (typeof s.harmVol === 'number')     { S.harmVol = s.harmVol; }
  $('harmVol').value = ampToPos(S.harmVol); $('harmVolVal').textContent = ampToDb(S.harmVol);
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
  if (typeof s.clickModDepth === 'number')  S.clickModDepth  = s.clickModDepth;
  if (typeof s.clickModPeriod === 'number') S.clickModPeriod = s.clickModPeriod;
  if (typeof s.clickRevTime === 'number')   S.clickRevTime   = s.clickRevTime;
  if (typeof s.clickReverb === 'number')    S.clickReverb    = s.clickReverb;
  if (typeof s.clickVol === 'number')       S.clickVol       = s.clickVol;
  if (typeof s.chirpModDepth === 'number')  S.chirpModDepth  = s.chirpModDepth;
  if (typeof s.chirpModPeriod === 'number') S.chirpModPeriod = s.chirpModPeriod;
  if (typeof s.pipLpfOn === 'boolean')     S.pipLpfOn     = s.pipLpfOn;
  for (const k of ['pipLpfLo','pipLpfHi','pipLpfPeriod','pipLpfQ','pipLpfWander'])
    if (typeof s[k] === 'number') S[k] = s[k];
  if (typeof s.bedLpfOn === 'boolean')  S.bedLpfOn  = s.bedLpfOn;
  if (typeof s.bedVerbOn === 'boolean') S.bedVerbOn = s.bedVerbOn;
  if (typeof s.bedRevOn === 'boolean') S.bedRevOn = s.bedRevOn;
  if (typeof s.arpOn === 'boolean') S.arpOn = s.arpOn;
  if (typeof s.musicRevOn === 'boolean') S.musicRevOn = s.musicRevOn;
  if (typeof s.bedOn === 'boolean') S.bedOn = s.bedOn;
  if (typeof s.pianoOn === 'boolean') S.pianoOn = s.pianoOn;
  if (typeof s.arpSwOn === 'boolean') S.arpSwOn = s.arpSwOn;
  if (['sine', 'triangle', 'sawtooth', 'square'].includes(s.arpWave)) S.arpWave = s.arpWave;
  if (typeof s.bedRevLevel === 'number') S.bedRevLevel = s.bedRevLevel;
  for (const k of ['bedLpfLo','bedLpfHi','bedLpfPeriod','bedLpfQ','bedLpfWander','bedLpfSlope','bedDetune',
                   'bedVerbLo','bedVerbHi','bedVerbPeriod','bedVerbWander'])
    if (typeof s[k] === 'number') S[k] = s[k];
  if (typeof s.shimDepth === 'number') { S.shimDepth = s.shimDepth; $('shimDepth').value = Math.round(S.shimDepth*100); $('shimDepthVal').textContent = Math.round(S.shimDepth*100); }
  if (typeof s.shimRate === 'number')  { S.shimRate = s.shimRate; $('shimRate').value = S.shimRate; $('shimRateVal').textContent = S.shimRate.toFixed(2); }
  if (typeof s.harmReverb === 'number')  { S.harmReverb = s.harmReverb; $('harmReverb').value = Math.round(S.harmReverb*100); $('harmRevVal').textContent = Math.round(S.harmReverb*100); }
  if (typeof s.pipMs === 'number') { S.pipMs = s.pipMs; $('pipMs').value = S.pipMs; $('pipVal').textContent = S.pipMs.toFixed(1); }
  if (typeof s.toneVol  === 'number') { S.toneVol  = s.toneVol; }
  $('toneVol').value = ampToPos(S.toneVol); $('toneVolVal').textContent = ampToDb(S.toneVol);
  if (typeof s.toneOn  === 'boolean') S.toneOn  = s.toneOn;
  if (typeof s.clickOn === 'boolean') S.clickOn = s.clickOn;
  $('aTone').classList.toggle('on', S.toneOn);   $('aTone').textContent  = S.toneOn  ? 'On' : 'Off';
  if (typeof s.chirpLowHz === 'number')  { S.chirpLowHz = s.chirpLowHz; }
  if (typeof s.chirpHighHz === 'number') { S.chirpHighHz = s.chirpHighHz; }
  if (typeof s.chirpComp === 'number')   { S.chirpComp = s.chirpComp; }
  if (typeof s.chirpTilt === 'number')   { S.chirpTilt = s.chirpTilt; }
  if (typeof s.chirpVol === 'number')     { S.chirpVol = s.chirpVol; }
  if (typeof s.chirpReverb === 'number')  { S.chirpReverb = s.chirpReverb; }
  if (typeof s.chirpRevTime === 'number') { S.chirpRevTime = s.chirpRevTime; }
  if (typeof s.biOn === 'boolean') S.biOn = s.biOn;
  $('biToggle').textContent = S.biOn ? 'On' : 'Off';
  $('biToggle').classList.toggle('on', S.biOn);
  document.querySelectorAll('.bi-only').forEach(el => { el.hidden = !S.biOn; });
  if (s.clickMode === 'click' || s.clickMode === 'chirp') S.clickMode = s.clickMode;
  $('chirpLow').value = S.chirpLowHz;   $('chirpLowVal').textContent = S.chirpLowHz;
  $('chirpHigh').value = S.chirpHighHz; $('chirpHighVal').textContent = S.chirpHighHz;
  $('chirpComp').value = Math.round(S.chirpComp*100); $('chirpCompVal').textContent = Math.round(S.chirpComp*100);
  $('chirpTilt').value = Math.round(S.chirpTilt*100);
  // both of these are derived rather than stored, so they have to be recomputed
  // here or the drawer shows the markup defaults after a reload
  $('chirpTiltVal').textContent =
    [[0,'white'],[0.5,'bright'],[1,'pink'],[1.25,'warm'],[1.5,'dark']]
      .reduce((a,b) => Math.abs(b[0]-S.chirpTilt) < Math.abs(a[0]-S.chirpTilt) ? b : a)[1];
  $('chirpLenVal').textContent = chirpDurationMs(S.chirpLowHz, S.chirpHighHz).toFixed(1);
  $('cmClick').classList.toggle('on', S.clickMode === 'click');
  $('cmChirp').classList.toggle('on', S.clickMode === 'chirp');
  $('clickModeVal').textContent = S.clickMode;
  // Every section's visibility is painted here, together, AFTER toneOn, clickOn,
  // harmOn and clickMode have all been restored. Painting it earlier is how the
  // tone controls came back on screen after a reload with the tone switched off:
  // the paint ran thirty lines before the value it depends on was read.
  document.querySelectorAll('.tone-ctl').forEach(el => { el.hidden = !S.toneOn; });
  $('harmToggle').closest('.subhead').classList.toggle('locked', !S.toneOn);
  document.querySelectorAll('.harm-ctl').forEach(el => { el.hidden = !(S.harmOn && S.toneOn); });
  document.querySelectorAll('.pip-ctl').forEach(el => {
    const only = el.classList.contains('chirp-only') ? 'chirp'
               : el.classList.contains('click-only') ? 'click' : null;
    el.hidden = !S.clickOn || (only !== null && only !== S.clickMode)
             || (el.classList.contains('lpf-ctl') && !S.pipLpfOn);
  });
  paintPipLpf();
  // the shared five read whichever set the restored mode points at
  {
    const c = S.clickMode === 'chirp';
    const word = c ? 'Chirp' : 'Click';
    document.querySelectorAll('.pipword').forEach(el => { el.textContent = word; });
    const vol = c ? S.chirpVol : S.clickVol, rev = c ? S.chirpReverb : S.clickReverb;
    const rt  = c ? S.chirpRevTime : S.clickRevTime;
    const md  = c ? S.chirpModDepth : S.clickModDepth, mp = c ? S.chirpModPeriod : S.clickModPeriod;
    $('clickVol').value      = ampToPos(vol);       $('clickVolVal').textContent     = ampToDb(vol);
    $('clickReverb').value   = Math.round(rev*100); $('clickRevVal').textContent     = Math.round(rev*100);
    $('clickRevTime').value  = rt;                  $('clickRevTimeVal').textContent = rt.toFixed(1);
    $('clickModDepth').value = Math.round(md*100);  $('clickModVal').textContent     = Math.round(md*100);
    $('clickModRate').value  = mp;                  $('clickModRateVal').textContent = mp;
  }

  $('aClick').classList.toggle('on', S.clickOn); $('aClick').textContent = S.clickOn ? 'On' : 'Off';
  // same derivation the corner button uses, inlined so settings.js does not have
  // to import ui.js and make a cycle
  if (typeof s.pipTrimDb === 'number') S.pipTrimDb = s.pipTrimDb;
  {
    const names = { 6:'loud', 0:'normal', '-6':'gentle', '-12':'whisper' };
    $('clickQuick').textContent = 'click: ' + (S.clickOn ? (names[S.pipTrimDb] || 'normal') : 'off');
    $('toneQuick').textContent  = 'tone: '  + (S.toneOn ? 'on' : 'off');
  }
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
