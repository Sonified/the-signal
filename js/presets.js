import { S } from './state.js';
import { $ } from './dom.js';
import { saveSettings } from './settings.js';

// Presets are declarative and drive the real inputs, firing real events, so
// every readout, save hook and audio side effect behaves exactly as if the
// controls had been touched by hand.
export const PRESETS = {
  genus: {
    // Gamma 40: full-field square pulse, frame locked, held cyan with no walk
    // and no depth or brightness variance, so every cycle is the same full
    // swing. Tuned after the compositing fix, when a clean 40 finally rendered
    // as one. The motion lives in the rings, edge and words instead.
    inputs:{ freq:40, freqDrift:0, driftRate:60, depth:100, bright:100,
             depthVar:0, varPeriod:10, brightVar:0, brightVarPeriod:22,
             color:'#00ccff', colorWalk:0, walkPeriod:60,
             ringSpeed:0.5, ringFade:55, ringThick:3, ringThickVar:100,
             ringBrightVar:55, ringBrightPeriod:10,
             edgeCount:60, edgeSize:6, trailLen:1, edgeSpeed:4,
             edgeSpeedVar:50, edgeSpeedVarPeriod:22,
             edgeSizeVar:50, edgeSizeVarPeriod:18,
             textRate:2, textFreq:50, textRandom:100,
             textRestFreq:20, textRestSec:10, textRestVar:70,
             textDwell:1000, textFadeIn:410, textFadeOut:670,
             textOpacity:95, textOpacityVar:10, textOpacityVarPeriod:20, textSize:35,
             carrier:40, amRate:40, vol:100, toneVol:83,
             // The five shared pip controls address whichever voice is live,
             // and clickMode below selects chirp before these are applied, so
             // these are the chirp's values: -40 dB, a whisper under the tone.
             pipMs:4, clickVol:33, clickReverb:37, clickRevTime:0.5,
             clickModDepth:0, clickModRate:26,
             biDepth:60, biRate:1,
             harmVol:100, harmCount:9, harmBright:45, harmSpread:70,
             harmPanRate:0.45, harmReverb:35, shimDepth:57, shimRate:0.12 },
    selects:{ edgeDir:'both' },
    buttons:['wSq','sFull','aLink','lkOn','spLit','cwEach','hbFull','txLink','txSystem','biHard'],
    clickMode:'chirp',
    bilateral:false,
    sources:{ tone:true, click:true },
    harmonics:true,
    colorMode:'rotating',
    layers:{ lField:true, lRings:true, lCorners:true, lEdge:true, lText:true, lAudio:true },
    // The click's own values are kept alongside, so switching the voice back
    // to click lands on the full-level train rather than on the chirp's.
    state:{ duty:0.5,
            chirpLowHz:150, chirpHighHz:6000, chirpComp:1, chirpTilt:1.3,
            clickVol:1, clickReverb:0.53, clickRevTime:0.5,
            clickModDepth:0.18, clickModPeriod:26 }
  },
  // Focused and alert, but grounded. The only preset meant to be used before
  // work rather than instead of it, so it is built on two timescales doing two
  // different jobs.
  //
  // The fast one is 10 Hz, the alpha peak, and the choice is made by the
  // display as much as by the brain. Frame lock advances the phase by exactly
  // one Nth of a cycle per frame, so the waveform only reaches full depth when
  // N is even: an odd frame count never samples phase 0.5, which is where the
  // sine peaks. On a 60 Hz panel the even counts land on 30, 15, 10, 7.5, 6,
  // 5 -- and between 7.5 and 15 there is nothing but 10. This started at 12,
  // which is 5 frames at 60 Hz, odd, and reaches 90.5% of the depth it claims.
  // It looked fine at 120 Hz and wrong on every ordinary desktop.
  //
  // 15 Hz is the other even option and is more alerting, but it opens the
  // 15-25 Hz band this app already warns about on screen, which is the wrong
  // trade for the preset people will reach for most often. So 10 it is: still
  // clearly awake, a full octave above the 7.5 drowsy crossover the other
  // presets sit on, and clean on 60, 120 and 240 Hz alike. Drift is kept to
  // half a hertz so the band cannot wander somewhere alerting into somewhere
  // soft.
  //
  // The slow one is 0.1 Hz. Every variance period here -- depth, brightness,
  // ring brightness, edge, and the pip loudness -- is set to ten seconds, the
  // cardiac resonance frequency, six breaths a minute. That is the one claim
  // in this whole project the README calls well supported rather than
  // suggestive, and when the problem is overwhelm it is the part most likely
  // to be doing real work. So the field breathes at resonance underneath a
  // flicker that keeps you awake.
  //
  // Everything else follows from being used repeatedly, mid-day, by someone
  // who then has to go and think. Depth and brightness sit lower than the
  // meditative presets: less visual fatigue, and less photosensitive risk on a
  // preset people will reach for often. Sine rather than square, for the same
  // reason -- square buys sharper entrainment at a cost this one should not
  // pay. The hue is held rather than walking, because a walking hue is
  // something to watch and watching is not the point, and it is cool because
  // blue-enriched light is the evidence-backed alerting one. The carrier sits
  // at 160 Hz: an octave above the piano root so it stays consonant with the
  // music layer, and far clear of the 40 Hz reproduction floor the README
  // warns about.
  focus: {
    inputs:{ freq:10, freqDrift:0.5, driftRate:30,
             depth:55, depthVar:45, varPeriod:10,
             bright:65, brightVar:40, brightVarPeriod:10,
             color:'#2ad4ff', colorWalk:0,
             ringSpeed:0.8, ringFade:45, ringThick:2, ringThickVar:40,
             ringBrightVar:40, ringBrightPeriod:10,
             edgeCount:40, edgeSize:4, trailLen:1, edgeSpeed:3,
             edgeSpeedVar:30, edgeSpeedVarPeriod:10,
             edgeSizeVar:25, edgeSizeVarPeriod:10,
             carrier:160, amRate:10, vol:40,
             toneVol:72, clickVol:58, pipMs:5,
             clickReverb:35, clickRevTime:0.4,
             clickModDepth:45, clickModRate:10,
             biDepth:0, biRate:1,
             harmVol:52, harmCount:6, harmBright:35, harmSpread:55,
             harmPanRate:0.2, harmReverb:28, shimDepth:30, shimRate:0.1 },
    selects:{ edgeDir:'both' },
    // hbFull is named rather than assumed: Sleep confines the hue to a warm
    // arc, and a preset that inherits whichever band ran before it is not a
    // preset. This one holds a single cool hue, so it wants the whole wheel
    // available underneath it.
    buttons:['wSine','sFull','aLink','lkOn','cwTogether','hbFull'],
    sources:{ tone:true, click:true },
    harmonics:true,
    layers:{ lField:true, lRings:true, lCorners:true, lEdge:true, lAudio:true }
  },
  theta: {
    inputs:{ freq:7.5, freqDrift:1, driftRate:20, depth:60, bright:70,
             depthVar:0, brightVar:0, carrier:200, amRate:7.5, vol:35 },
    buttons:['wSine','sFull','aLink','hbFull'],
    sources:{ tone:true, click:false },
    harmonics:false,
    layers:{ lField:true, lAudio:true }
  },
  breath: {
    inputs:{ freq:7.5, freqDrift:0, depth:75, depthVar:70, varPeriod:10,
             bright:70, brightVar:55, brightVarPeriod:10,
             ringBrightVar:55, ringBrightPeriod:10, carrier:200, amRate:7.5, vol:35 },
    buttons:['wSine','sFull','aLink','hbFull'],
    sources:{ tone:true, click:false },
    harmonics:false,
    layers:{ lField:true, lRings:true, lAudio:true }
  },
  colorwalk: {
    inputs:{ freq:7.5, depth:80, freqDrift:1, driftRate:60,
             depthVar:80, varPeriod:10,
             brightVar:85, brightVarPeriod:22,
             bright:100, color:'#d400ff',
             ringSpeed:0.5, ringFade:55, ringThick:3, ringThickVar:100,
             ringBrightVar:55, ringBrightPeriod:10,
             edgeCount:60, edgeSize:6, trailLen:1, edgeSpeed:4,
             edgeSpeedVar:50, edgeSpeedVarPeriod:22,
             edgeSizeVar:50, edgeSizeVarPeriod:18,
             carrier:40, amRate:7.5, vol:50,
             toneVol:83, clickVol:84, pipMs:8,
             clickReverb:61, clickRevTime:0.5,
             clickModDepth:55, clickModRate:26,
             biDepth:0, biRate:1,
             harmVol:87, harmCount:9, harmBright:45, harmSpread:70,
             harmPanRate:0.45, harmReverb:35, shimDepth:57, shimRate:0.12,
             colorWalk:100, walkPeriod:60 },
    selects:{ edgeDir:'both' },
    buttons:['wSq','sFull','aLink','cwTogether','lkOn','biHard','hbFull'],
    sources:{ tone:true, click:true },
    harmonics:true,
    colorMode:'rotating',
    layers:{ lField:true, lRings:true, lCorners:true, lEdge:true, lAudio:true }
  },
  // identical, but the hue is held rather than walking
  magenta: {
    inputs:{ freq:7.5, depth:80, freqDrift:1, driftRate:60,
             depthVar:80, varPeriod:10,
             brightVar:85, brightVarPeriod:22,
             bright:100, color:'#d400ff',
             ringSpeed:0.5, ringFade:55, ringThick:3, ringThickVar:100,
             ringBrightVar:55, ringBrightPeriod:10,
             edgeCount:60, edgeSize:6, trailLen:1, edgeSpeed:4,
             edgeSpeedVar:50, edgeSpeedVarPeriod:22,
             edgeSizeVar:50, edgeSizeVarPeriod:18,
             carrier:40, amRate:7.5, vol:50,
             toneVol:83, clickVol:84, pipMs:8,
             clickReverb:61, clickRevTime:0.5,
             clickModDepth:55, clickModRate:26,
             biDepth:0, biRate:1,
             harmVol:87, harmCount:9, harmBright:45, harmSpread:70,
             harmPanRate:0.45, harmReverb:35, shimDepth:57, shimRate:0.12,
             colorWalk:0 },
    selects:{ edgeDir:'both' },
    buttons:['wSq','sFull','aLink','cwTogether','lkOn','biHard','hbFull'],
    sources:{ tone:true, click:true },
    harmonics:true,
    colorMode:'magenta',
    layers:{ lField:true, lRings:true, lCorners:true, lEdge:true, lAudio:true }
  }
  ,
  // Everything slowed, dimmed and warmed. The hue walk is confined to the arc
  // from magenta-red through amber: no part of it comes near the short
  // wavelengths that suppress melatonin, which is the one thing a light you
  // stare at before bed should not do. Slow enough that nothing in it asks for
  // attention, and the tone drops to a low carrier under a soft pulse.
  sleep: {
    inputs:{ freq:3, freqDrift:0.5, driftRate:60, depth:55, bright:45,
             depthVar:70, varPeriod:22, brightVar:70, brightVarPeriod:30,
             ringSpeed:0.25, ringFade:80, ringThick:2, ringThickVar:60,
             ringBrightVar:70, ringBrightPeriod:20,
             edgeCount:24, edgeSize:4, trailLen:2, edgeSpeed:1.4,
             edgeSpeedVar:60, edgeSpeedVarPeriod:30,
             edgeSizeVar:60, edgeSizeVarPeriod:26,
             colorWalk:100, walkPeriod:180,
             carrier:60, amRate:3, vol:40,
             toneVol:80, clickVol:0, pipMs:12,
             clickReverb:70, clickRevTime:3,
             harmVol:84, harmCount:6, harmBright:25, harmSpread:80,
             harmPanRate:0.2, harmReverb:55, shimDepth:35, shimRate:0.07 },
    selects:{ edgeDir:'both' },
    buttons:['wSine','sFull','aLink','cwTogether','lkOn','hbWarm'],
    sources:{ tone:true, click:false },
    harmonics:true,
    colorMode:'rotating',
    layers:{ lField:true, lRings:true, lCorners:true, lEdge:true, lAudio:true }
  }
};

export function applyPreset(name) {
  const P = PRESETS[name];
  if (!P) return;

  // The click and chirp share five controls. Select the requested voice before
  // applying its values so a Gamma click level cannot land in the chirp slot.
  if (P.clickMode && P.clickMode !== S.clickMode) {
    $(P.clickMode === 'click' ? 'cmClick' : 'cmChirp').click();
  }

  for (const [id, val] of Object.entries(P.inputs || {})) {
    const el = $(id);
    if (!el) continue;
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  for (const [id, val] of Object.entries(P.selects || {})) {
    const el = $(id);
    if (!el) continue;
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // layer checkboxes and the two audio sources are toggles, so they are only
  // clicked when they are not already where the preset wants them
  for (const [id, want] of Object.entries(P.layers || {})) {
    const el = $(id);
    if (el && el.checked !== want) el.click();
  }
  (P.buttons || []).forEach(id => { const el = $(id); if (el) el.click(); });
  if (typeof P.bilateral === 'boolean' && S.biOn !== P.bilateral) $('biToggle').click();
  // the harmonics switch is a toggle button, not an input, so it only gets
  // clicked when it is not already where the preset wants it
  if (typeof P.harmonics === 'boolean' && S.harmOn !== P.harmonics) $('harmToggle').click();
  if (P.colorMode) {
    S.colorMode = P.colorMode;
    $('colorQuick').textContent = 'color: ' + P.colorMode;
  }
  if (P.sources) {
    if (S.toneOn  !== P.sources.tone)  $('aTone').click();
    if (S.clickOn !== P.sources.click) $('aClick').click();
  }
  if (P.state) Object.assign(S, P.state);
  saveSettings();
}
