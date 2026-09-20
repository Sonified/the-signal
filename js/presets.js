import { S } from './state.js';
import { $ } from './dom.js';
import { saveSettings } from './settings.js';

// Presets are declarative and drive the real inputs, firing real events, so
// every readout, save hook and audio side effect behaves exactly as if the
// controls had been touched by hand.
export const PRESETS = {
  genus: {
    // A clean stimulus. Every variance is zeroed and the decorative layers are
    // switched off, because anything still lit during the dark frames fills in
    // the very gaps that make the flicker. Contrast is the whole mechanism.
    inputs:{ freq:40, freqDrift:0, depth:100, bright:100,
             depthVar:0, brightVar:0, ringBrightVar:0,
             edgeSpeedVar:0, edgeSizeVar:0, colorWalk:0,
             carrier:10000, pipMs:1, amRate:40, vol:35, clickVol:95 },
    buttons:['wSq','sFull','aLink','lkOn','cwTogether','hbFull'],
    sources:{ tone:false, click:true },
    harmonics:false,          // a pad would light the dark frames and kill the contrast
    layers:{ lField:true, lRings:false, lCorners:false, lEdge:false, lAudio:true }
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
  saveSettings();
}
