// Controls, readouts, drawer, keyboard and the clipboard helpers.
import { S, layers, STORE, SKIP_KEY, GROUPS_KEY, RENDER_BTNS } from './state.js';
import { $, cv, hint, panel } from './dom.js';
import { bandName } from './util.js';
import { setColorFromPicker } from './color.js';
import { seedParticles, applyEdgeDir, seedTunnel } from './sim.js';
import { invalidateGradients } from './renderers/canvas2d.js';
import { saveSettings } from './settings.js';
import { applyPreset } from './presets.js';
import {
  setParam, applyLevel, applyAudioShape, applyHarmonics, applyReverbMix,
  rebuildClickIR, setAmRate, audioOn, audioOff, applyAudioGain,
  warmDevice, isDeviceWarm
} from './audio.js';

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
  if (S.refreshHz) {
    const spc = S.refreshHz/S.freq;
    $('spc').textContent = spc.toFixed(1);
    $('warn').textContent =
      spc < 4 ? 'few samples per cycle, waveform is getting steppy'
    : (S.freq >= 15 && S.freq <= 25) ? 'higher seizure-risk band' : '';
  }
}

// ---------- layout ----------
export function resize() {
  S.DPR = Math.min(window.devicePixelRatio || 1, 2);
  S.W = window.innerWidth; S.H = window.innerHeight;
  const wd = Math.max(1, Math.round(S.W * S.DPR)), hd = Math.max(1, Math.round(S.H * S.DPR));
  if (cv.width !== wd || cv.height !== hd) { cv.width = wd; cv.height = hd; }
  if (S.ctx) S.ctx.setTransform(S.DPR,0,0,S.DPR,0,0);
  if (S.renderer && S.renderer.resize) S.renderer.resize();
  document.documentElement.style.setProperty('--panelH', panel.offsetHeight + 'px');
  S.edgeInsetTarget = S.panelOpen ? panel.offsetWidth : 0;
}

// ---------- primary actions ----------
export function toggle() {
  // One press starts everything. The device wake still happens on this
  // gesture, so audio is held back briefly afterwards rather than fading in
  // underneath the wake transient.
  const cold = !isDeviceWarm();
  if (cold) warmDevice().then(() => { if ($('lAudio').checked) audioOn(); });
  S.running = !S.running;
  if (S.running) {
    if (!S.rings.length) seedTunnel(16);
    hint.classList.add('hide');
  } else hint.classList.remove('hide');
  applyAudioGain();
}

export function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}

export function togglePanel(force) {
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

  // Two surfaces control one setting: the drawer pair and the quick toggle in
  // the corner. Both route through here so they can never disagree.
  function setWalkMode(each) {
    S.perElementColor = each;
    ['cwTogether','cwEach'].forEach(id => $(id).classList.remove('on'));
    $(each ? 'cwEach' : 'cwTogether').classList.add('on');
    $('cqSingle').classList.toggle('on', !each);
    $('cqMulti').classList.toggle('on', each);
    invalidateGradients();             // corners swap colour source, so rebuild
    saveSettings();
  }
  $('cwTogether').onclick = e => { setWalkMode(false); e.currentTarget.blur(); };
  $('cwEach').onclick     = e => { setWalkMode(true);  e.currentTarget.blur(); };
  $('cqSingle').onclick   = e => { setWalkMode(false); e.currentTarget.blur(); };
  $('cqMulti').onclick    = e => { setWalkMode(true);  e.currentTarget.blur(); };

  $('walkPeriod').addEventListener('input', e => {
    S.walkPeriod = +e.target.value; $('walkPerVal').textContent = S.walkPeriod; saveSettings();
  });
  $('colorWalk').addEventListener('input', e => { S.colorWalk = +e.target.value/100; updateReadouts(); saveSettings(); });
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

  [['lField','field'],['lRings','rings'],['lCorners','corners'],['lEdge','edge']].forEach(([id,key]) => {
    const box = $(id);
    box.addEventListener('change', () => {
      layers[key] = box.checked;
      box.closest('.lay').classList.toggle('on', box.checked);
      saveSettings();
    });
  });

  $('lAudio').addEventListener('change', e => {
    e.target.closest('.lay').classList.toggle('on', e.target.checked);
    if (e.target.checked) audioOn(); else audioOff();   // audioOn resolves on its own
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
    S.clickModDepth = +e.target.value/100; $('clickModVal').textContent = e.target.value;
    applyHarmonics(); saveSettings();
  });
  $('clickModRate').addEventListener('input', e => {
    S.clickModPeriod = +e.target.value; $('clickModRateVal').textContent = S.clickModPeriod;
    applyHarmonics(); saveSettings();
  });
  $('clickRevTime').addEventListener('input', e => {
    S.clickRevTime = +e.target.value; $('clickRevTimeVal').textContent = S.clickRevTime.toFixed(1);
    rebuildClickIR(); saveSettings();
  });
  $('clickReverb').addEventListener('input', e => {
    S.clickReverb = +e.target.value/100; $('clickRevVal').textContent = e.target.value;
    applyReverbMix(); applyLevel('clickSend'); saveSettings();
  });
  $('pipMs').addEventListener('input', e => {
    S.pipMs = +e.target.value;
    $('pipVal').textContent = S.pipMs.toFixed(1);
    setParam('pipMs', S.pipMs);
    saveSettings();
  });
  function setHarm(on) {
    S.harmOn = on;
    $('harmToggle').textContent = on ? 'On' : 'Off';
    $('harmToggle').classList.toggle('on', on);
    $('harmToggle').blur();
    applyLevel('harmLevel', 0.3); saveSettings();
  }
  $('harmToggle').onclick = () => setHarm(!S.harmOn);

  $('harmVol').addEventListener('input', e => {
    S.harmVol = +e.target.value/100; $('harmVolVal').textContent = e.target.value;
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
    S.toneVol = +e.target.value/100; $('toneVolVal').textContent = e.target.value;
    applyLevel('toneLevel'); saveSettings();
  });
  $('clickVol').addEventListener('input', e => {
    S.clickVol = +e.target.value/100; $('clickVolVal').textContent = e.target.value;
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
    btn.classList.toggle('on', which === 'tone' ? S.toneOn : S.clickOn);
    btn.blur();
    applyAudioShape();
    saveSettings();
  }
  $('aTone').onclick  = e => toggleAudioSource('tone',  e.currentTarget);
  $('aClick').onclick = e => toggleAudioSource('click', e.currentTarget);

  function setAmMode(linked, btn) {
    S.amLinked = linked;
    ['aFree','aLink'].forEach(id => $(id).classList.remove('on'));
    btn.classList.add('on');
    btn.blur();
    $('amRate').disabled = linked;
    setAmRate(linked ? S.freq : S.amRate);
    $('amVal').textContent = (linked ? S.freq : S.amRate).toFixed(1);
    saveSettings();
  }
  $('aFree').onclick = e => setAmMode(false, e.target);
  $('aLink').onclick = e => setAmMode(true,  e.target);

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

  cv.addEventListener('click', toggle);

  $('fsBtn').onclick = e => { e.stopPropagation(); toggleFullscreen(); $('fsBtn').blur(); };
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    document.body.classList.toggle('fs', on);
    $('fsBtn').title = on ? 'Exit full screen (F)' : 'Full screen (F)';
    setTimeout(resize, 60);
  });

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
  let idleTimer = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!S.panelOpen) document.body.classList.add('idle');
    }, 2200);
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

  window.addEventListener('keydown', e => {
    // space always starts and stops, whatever happens to be focused
    if (e.code === 'Space') { e.preventDefault(); toggle(); return; }
    // Enter is a primary action too, so it works regardless of what has focus
    if (e.key === 'Enter') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === '`' || e.key === '~') { e.preventDefault(); togglePanel(); }
    if (e.key.toLowerCase() === 'h') togglePanel();
    if (e.key.toLowerCase() === 'f') toggleFullscreen();
    if (e.key === 'Escape') togglePanel(false);
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
      varianceSecondsPerCycle: S.varPeriod,
      frameLock: S.frameLock,
      brightness: +S.bright.toFixed(2),
      color: $('color').value,
      waveform: S.wave,
      squareDuty: +S.duty.toFixed(2),
      fieldShape: S.fieldShape,
      ringSpread: S.ringSpeedMul,
      ringFadeIn: +S.ringFade.toFixed(2),
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
      layers: { ...layers, audio: $('lAudio').checked },
      audio: {
        carrierHz: S.carrierHz,
        pulseRateHz: S.amLinked ? S.freq : S.amRate,
        pulseLinkedToVisual: S.amLinked,
        volume: +S.volume.toFixed(2),
        toneOn: S.toneOn, toneLevel: +S.toneVol.toFixed(2),
        clickOn: S.clickOn, clickLevel: +S.clickVol.toFixed(2),
        pipWidthMs: S.pipMs,
        clickReverb: +S.clickReverb.toFixed(2),
        clickReverbSeconds: S.clickRevTime,
        bilateralDepth: +S.biDepth.toFixed(2), bilateralSecondsPerPass: S.biPeriod,
        bilateralShape: S.biHardSwitch ? 'switch' : 'sweep',
        clickLoudnessVariance: +S.clickModDepth.toFixed(2), clickLoudnessVarSecondsPerCycle: S.clickModPeriod,
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
      `renderer        ${S.renderer ? S.renderer.name : 'none'}  (preference: ${S.rendererPref})`,
      `viewport        ${S.W} x ${S.H} css px @ DPR ${S.DPR}`,
      `screen          ${screen.width} x ${screen.height}`,
      ``,
      `requested freq  ${S.freq.toFixed(1)} Hz  (${bandName(S.freq)})`,
      `frame pattern   ${S.litLog.join('') || '(not running)'}`,
      `frame lock      ${S.frameLock ? 'ON, achieving ' + S.achievedFreq.toFixed(2) + ' Hz at ' + S.framesPerCycle + ' frames/cycle' : 'off'}`,
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
