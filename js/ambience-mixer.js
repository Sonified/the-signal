// Floating mixer: every channel gets a fader and a post-fader meter -- the
// tone engine, the music, and one row per atmosphere recording.
import { S } from './state.js';
import { $ } from './dom.js';
import { saveSettings } from './settings.js';
import {
  AMBIENCE_SOURCES, normalizeAmbLayers, syncAmbLayers, ambLayerStatus, ambLayerPeak,
  startAmbDrift, stopAmbDrift, ambDriftTick, setAmbLayerLevel
} from './ambience.js';
import { enginePeaks } from './audio.js';
import { pianoPeak, bedPeak } from './piano.js';
import { cloudPeak } from './clouds.js';
import { ampToPos, ampToDb } from './util.js';

// The fixed channels: one row each for the tone engine and the music, paired
// with the source its meter reads. Tone, harmonics and pips come back from the
// worklet in one report because they leave it already mixed together.
const CHANNELS = [
  { fader: 'mixFund',   drawer: 'toneVol',  amp: () => S.toneVol,  db: true,  peak: () => enginePeaks().tone },
  { fader: 'mixHarm',   drawer: 'harmVol',  amp: () => S.harmVol,  db: true,  peak: () => enginePeaks().harm },
  // Click and chirp share one displayed level; read whichever mode is live.
  { fader: 'mixPulse',  drawer: 'clickVol', amp: () => S.clickMode === 'chirp' ? S.chirpVol : S.clickVol, db: true, peak: () => enginePeaks().pulse },
  { fader: 'mixPiano',  drawer: 'pianoVol', amp: () => S.pianoVol, db: false, peak: pianoPeak },
  { fader: 'mixClouds', drawer: 'cloudVol', amp: () => S.cloudVol, db: false, peak: cloudPeak },
  { fader: 'mixDrone',  drawer: 'bedVol',   amp: () => S.bedVol,   db: false, peak: bedPeak }
];

// One meter, twelve LEDs, -60 to 0 dBFS. The peak falls on its own 180 ms
// release so a pip that lands between two frames still reads.
const LEDS = 12;
function buildMeter(el) {
  const leds = Array.from({ length: LEDS }, () => {
    const led = document.createElement('span');
    led.className = 'amb-led'; el.append(led); return led;
  });
  return { leds, peak: 0, count: 0 };
}
function paintMeter(meter, level, dt) {
  meter.peak = Math.max(level, meter.peak * Math.exp(-dt / 180));
  const db = meter.peak > 0 ? 20 * Math.log10(meter.peak) : -Infinity;
  const count = Math.max(0, Math.min(LEDS, Math.ceil((db + 60) / 5)));
  if (meter.count === count) return;
  meter.leds.forEach((led, i) => led.classList.toggle('lit', i < count));
  meter.count = count;
}

// The drift (places crossfading, children coming and going) is scheduled in
// ambience.js, shared with v1, and every fade is written onto the audio clock
// when it begins, so a throttled timer can no longer make one jump. This
// window only ticks it and decides when to save.

export function initAmbMixer() {
  S.ambLayers = normalizeAmbLayers(S.ambLayers);
  const win = $('ambMixerWindow'), bar = $('ambMixerBar');
  const rows = new Map();
  let driftTimer = null, driftSaveTimer = null;
  // A hidden tab keeps drifting (the audio plays on), but it does not save
  // while nobody can see it: every one of those saves rewrites the whole
  // shared settings object, and a forgotten background tab doing that every
  // few seconds overwrites whatever the viewer is doing in another tab. The
  // save is remembered instead, and made once when the tab is seen again.
  let driftSaveOwed = false;
  function driftSave() {
    if (document.hidden) { driftSaveOwed = true; return; }
    driftSaveOwed = false;
    saveSettings();
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && driftSaveOwed) driftSave();
  });

  function driftTick() {
    const moved = ambDriftTick();
    // A crossfade is twelve seconds of this tick at 5 Hz, and every one of
    // those used to serialise the whole settings object and write it to
    // localStorage: sixty synchronous disk round trips, on the main thread,
    // while the strobe is trying to present. What is actually worth saving
    // is where the fade ends up, so the write trails the motion instead of
    // following it, and the landing is written exactly.
    if (moved === 'landed') { clearTimeout(driftSaveTimer); driftSaveTimer = null; driftSave(); }
    else if (moved !== 'moving') return;
    else if (document.hidden) driftSaveOwed = true;
    else if (!driftSaveTimer) {
      driftSaveTimer = setTimeout(() => { driftSaveTimer = null; driftSave(); }, 2000);
    }
  }
  function startDrift() {
    if (driftTimer) return;
    startAmbDrift();
    driftTimer = setInterval(driftTick, 200);
  }
  function stopDrift() {
    clearInterval(driftTimer); driftTimer = null;
    stopAmbDrift();
    clearTimeout(driftSaveTimer); driftSaveTimer = null; driftSaveOwed = false;
  }
  const WINDOW_KEY = 'signal.atmosphere.window.v1';
  let layout = { open: true, x: null, y: 80, width: 500, version: 3 };
  try { Object.assign(layout, JSON.parse(localStorage.getItem(WINDOW_KEY) || '{}')); } catch {}
  if (!layout.version || layout.version < 3) { layout.width = 500; layout.version = 3; }
  let frame = 0, lastFrame = 0, resizeTimer;
  const saveWindow = () => { try { localStorage.setItem(WINDOW_KEY, JSON.stringify(layout)); } catch {} };
  // The filled part of a track is painted from --position, and the browser
  // never sets it for us, so it has to be written after every move -- including
  // the ones the input made itself while being dragged. Guarded on the property
  // rather than on the value, so repainting a still fader is free.
  // Read from the track's own range, not from the raw value: the reverb send
  // runs to 150, and treating its value as a percentage drew the fill well
  // ahead of the handle.
  const fill = input => {
    const min = +input.min || 0, max = +input.max || 100;
    const pos = `${(((input.value - min) / (max - min)) * 100).toFixed(2)}%`;
    if (input.style.getPropertyValue('--position') !== pos) input.style.setProperty('--position', pos);
  };

  // Resolved once. Everything below runs on the meter clock, and asking the
  // document for the same sixteen elements by name several times a second is
  // work it should not have to repeat for nodes that never move.
  const masterFader = $('ambMixerMaster'), masterValue = $('ambMixerMasterValue');
  const reverbFader = $('ambMixerReverb'), reverbValue = $('ambMixerReverbValue');
  for (const channel of CHANNELS) {
    channel.input = $(channel.fader);
    channel.readout = $(channel.fader + 'Val');
  }
  // Writing a property the same value it already holds still costs a style
  // recalc, and the master pair was doing exactly that on every repaint while
  // nothing about them had changed. The per-channel faders already guarded;
  // now everything here does.
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const setPos = (input, pos) => {
    if (+input.value !== pos) input.value = pos;
    fill(input);
  };

  function paintFader(channel, pos, text) {
    setPos(channel.input, pos);
    setText(channel.readout, text);
  }
  function paintMaster() {
    const master = Math.round(S.ambVol * 100);
    setPos(masterFader, master);
    setText(masterValue, String(master));
    const reverb = Math.round(S.ambReverb * 100);
    setPos(reverbFader, reverb);
    setText(reverbValue, String(reverb));

    for (const channel of CHANNELS) {
      const amp = channel.amp();
      if (channel.db) paintFader(channel, ampToPos(amp), ampToDb(amp));
      else paintFader(channel, Math.round(amp * 100), String(Math.round(amp * 100)));
    }
  }
  function paintStatus() {
    let loading = 0, failed = 0;
    const soloing = S.ambLayers.some(layer => layer.solo);
    for (const [layer, row] of rows) {
      const status = ambLayerStatus(layer);
      const pending = status === 'Loading…', error = status.startsWith('Could not');
      row.el.classList.toggle('loading', pending);
      row.el.classList.toggle('error', error);
      row.el.classList.toggle('active', layer.level > 0 && !layer.muted && (!soloing || layer.solo));
      row.el.classList.toggle('silenced', layer.muted || (soloing && !layer.solo));
      row.mute.setAttribute('aria-pressed', String(layer.muted));
      row.solo.setAttribute('aria-pressed', String(layer.solo));
      row.el.title = pending || error ? status : '';
      loading += pending; failed += error;
      // Drift moves these levels from outside the slider's own input event,
      // so the fader has to be told rather than just trusted.
      const shown = Math.round(layer.level * 100);
      if (+row.slider.value !== shown) {
        row.slider.value = shown; fill(row.slider);
        row.value.textContent = String(shown);
      }
    }
    win.classList.toggle('enabled', S.ambOn);
    $('ambMixerPower').textContent = S.ambOn ? 'on' : 'off';
    $('ambMixerPower').setAttribute('aria-pressed', String(S.ambOn));
    $('ambMixerStatus').textContent = failed ? `${failed} recording failed · adjust its fader to retry`
      : loading ? `${loading} loading…` : !S.ambOn ? 'ATMOSPHERE OFF'
      : !S.running ? 'STOPPED · press space to play' : '13 SOURCES · POST-FADER METERS';
    paintMaster();
  }

  for (const channel of CHANNELS) channel.meter = buildMeter($(channel.fader + 'Meter'));

  const wrap = $('ambLayers');
  wrap.replaceChildren();
  for (const layer of S.ambLayers) {
    const source = AMBIENCE_SOURCES.find(s => s.id === layer.source);
    const el = document.createElement('div');
    el.className = 'amb-layer';
    const label = document.createElement('label');
    label.htmlFor = `ambLevel-${source.id}`;
    label.textContent = source.name;
    const makeSwitch = (key, text, name) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `amb-${key}`;
      button.textContent = text;
      button.setAttribute('aria-label', `${name} ${source.name}`);
      button.title = `${name} ${source.name}`;
      button.onclick = () => {
        layer[key] = !layer[key];
        syncAmbLayers(); saveSettings();
      };
      return button;
    };
    const mute = makeSwitch('muted', 'M', 'Mute');
    const solo = makeSwitch('solo', 'S', 'Solo');
    const slider = document.createElement('input');
    slider.id = label.htmlFor;
    slider.type = 'range'; slider.min = 0; slider.max = 100; slider.step = 1;
    slider.value = Math.round(layer.level * 100);
    slider.setAttribute('aria-label', `${source.name} volume`);
    fill(slider);
    const meter = document.createElement('div');
    meter.className = 'amb-meter';
    meter.setAttribute('aria-hidden', 'true');
    meter.title = 'Post-fader signal · −60 to 0 dBFS';
    const readout = buildMeter(meter);
    const value = document.createElement('output');
    value.htmlFor = slider.id;
    value.textContent = slider.value;
    rows.set(layer, { el, meter: readout, mute, solo, slider, value });
    slider.oninput = () => {
      setAmbLayerLevel(layer, +slider.value / 100);
      value.textContent = slider.value;
      fill(slider); syncAmbLayers(); saveSettings();
    };
    el.append(label, mute, solo, slider, value, meter);
    wrap.append(el);
  }

  // Sixty-six milliseconds, about fifteen a second. The old gate was thirty a
  // second, which is a repaint rate for something you read rather than watch:
  // a meter is a glance, not an animation, and every one of those repaints was
  // landing on the same thread as the strobe. The cost is that a very short
  // pip can now fall between two samples of the analyser; the 180 ms peak
  // release is what carries it, and that is why it is there.
  const METER_MS = 66;
  function drawMeters(time) {
    if (win.hidden) { frame = 0; return; }
    const dt = Math.min(200, time - (lastFrame || time));
    if (dt >= METER_MS || !lastFrame) {
      lastFrame = time;
      paintMaster();
      for (const channel of CHANNELS) paintMeter(channel.meter, channel.peak(), dt);
      for (const [layer, row] of rows) paintMeter(row.meter, ambLayerPeak(layer), dt);
    }
    frame = requestAnimationFrame(drawMeters);
  }
  // The clamp is separated from the commit because a drag needs the first
  // without the second: it has to know where the window is allowed to go
  // twelve hundred times a minute, but it only writes left/top once, at the
  // end. Taking the size as arguments means a drag can measure the window
  // once on pointerdown instead of asking for its rectangle on every move.
  const clampTo = (x, y, w, h) => [
    Math.max(12, Math.min(x, innerWidth - w - 12)),
    Math.max(12, Math.min(y, innerHeight - h - 12))
  ];
  function clampWindow() {
    const rect = win.getBoundingClientRect();
    const x = Number.isFinite(layout.x) ? layout.x : innerWidth - rect.width - 24;
    const y = Number.isFinite(layout.y) ? layout.y : 80;
    [layout.x, layout.y] = clampTo(x, y, rect.width, rect.height);
    win.style.left = `${layout.x}px`;
    win.style.top = `${layout.y}px`;
    win.style.right = 'auto';
  }
  function setOpen(open) {
    layout.open = open;
    win.hidden = !open;
    $('ambQuick').setAttribute('aria-expanded', String(open));
    if (open) {
      win.style.width = `${Number.isFinite(layout.width) ? Math.max(320, layout.width) : 500}px`;
      clampWindow(); paintStatus();
      lastFrame = 0;
      if (!frame) frame = requestAnimationFrame(drawMeters);
    } else {
      cancelAnimationFrame(frame); frame = 0;
    }
    saveWindow();
  }
  // A small word under the button, on its own timer. Kept in the DOM and faded
  // rather than added and removed, so the transition has something to run on.
  let copyTimer = null, toastTimer = null;
  function toast(text) {
    const el = $('ambMixerToast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  $('ambMixerClose').onclick = () => { setOpen(false); $('ambQuick').focus(); };
  $('ambMixerOpen').onclick = () => $('ambQuick').click();
  $('ambMixerCopy').onclick = () => {
    const settings = {
      atmosphere: {
        enabled: S.ambOn,
        masterLevel: Math.round(S.ambVol * 100),
        reverbLevel: Math.round(S.ambReverb * 100),
        layers: S.ambLayers.map(layer => {
          const source = AMBIENCE_SOURCES.find(item => item.id === layer.source);
          return {
            id: layer.source,
            source: source ? source.name : layer.source,
            level: Math.round(layer.level * 100),
            muted: layer.muted,
            solo: layer.solo
          };
        })
      }
    };
    const text = JSON.stringify(settings, null, 2);
    const done = () => {
      const button = $('ambMixerCopy');
      button.classList.add('copied');
      button.blur();
      toast('settings copied');
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => button.classList.remove('copied'), 1400);
    };
    const fallback = () => {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(field); field.select();
      try { document.execCommand('copy'); } finally { field.remove(); }
      done();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  };
  window.addEventListener('openatmospheremixer', () => { setOpen(true); $('ambMixerClose').focus(); });
  window.addEventListener('keydown', e => {
    const typing = e.target.matches?.('input:not([type="range"]), textarea, select, [contenteditable="true"]');
    if (e.key.toLowerCase() === 'm' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !typing) {
      e.preventDefault();
      setOpen(win.hidden);
      return;
    }
    if (e.key === 'Escape' && !win.hidden) {
      e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); $('ambQuick').focus();
    }
  }, true);
  $('ambMixerPower').onclick = () => $(S.ambOn ? 'amOff' : 'amOn').click();
  // The label stays 'drift' either way; the lit state is the blue. A button
  // that rewrites itself changes width, and this one lives in a drag handle.
  const paintDrift = () => $('ambMixerDrift').setAttribute('aria-pressed', String(S.ambDrift));
  $('ambMixerDrift').onclick = e => {
    S.ambDrift = !S.ambDrift;
    paintDrift();
    if (S.ambDrift) startDrift(); else stopDrift();
    saveSettings();
    e.currentTarget.blur();
  };
  paintDrift();
  if (S.ambDrift) startDrift();
  $('ambMixerMaster').oninput = e => {
    fill(e.target);
    $('ambVol').value = e.target.value;
    $('ambVol').dispatchEvent(new Event('input'));
  };
  $('ambMixerReverb').oninput = e => {
    fill(e.target);
    $('ambReverb').value = e.target.value;
    $('ambReverb').dispatchEvent(new Event('input'));
  };
  $('ambVol').addEventListener('input', paintMaster);
  $('ambReverb').addEventListener('input', paintMaster);
  // Each channel fader drives the drawer's own slider and lets that one's
  // handler do the work, so there is one path into the audio per control.
  for (const channel of CHANNELS) {
    $(channel.fader).oninput = e => {
      fill(e.target);
      $(channel.drawer).value = e.target.value;
      $(channel.drawer).dispatchEvent(new Event('input'));
    };
  }

  // Dragging used to write left and top on every pointermove. Those are layout
  // properties: each move restyled the window, laid it out again, and repainted
  // it along with its shadow, all on the thread the strobe presents from, at
  // pointer rate. A translate is none of those things. The window is promoted
  // to its own layer on pointerdown, moved by a matrix for the duration, and
  // the result is committed back to left/top at the end so nothing downstream
  // -- the clamp, the resize observer, the saved layout -- has to know that a
  // drag happened at all.
  let drag = null;
  bar.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const rect = win.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: layout.x, top: layout.y,
             w: rect.width, h: rect.height, nx: layout.x, ny: layout.y };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging'); win.classList.add('dragging');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = clampTo(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y, drag.w, drag.h);
    drag.nx = x; drag.ny = y;
    win.style.transform = `translate(${(x - drag.left).toFixed(1)}px, ${(y - drag.top).toFixed(1)}px)`;
  });
  const endDrag = e => {
    if (!drag) return;
    // Committed and cleared together, so the browser never sees a frame where
    // one has landed and the other has not.
    layout.x = drag.nx; layout.y = drag.ny;
    win.style.transform = '';
    win.style.left = `${layout.x}px`;
    win.style.top = `${layout.y}px`;
    win.style.right = 'auto';
    drag = null;
    bar.classList.remove('dragging'); win.classList.remove('dragging');
    if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    saveWindow();
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  // Both of these commit left/top, which a drag deliberately is not doing yet,
  // so neither is allowed to run while the pointer is down.
  if (window.ResizeObserver) new ResizeObserver(() => {
    if (win.hidden || drag) return;
    layout.width = Math.round(win.getBoundingClientRect().width);
    clampWindow(); clearTimeout(resizeTimer); resizeTimer = setTimeout(saveWindow, 250);
  }).observe(win);
  window.addEventListener('resize', () => { if (!win.hidden && !drag) clampWindow(); });
  window.addEventListener('atmospherechange', paintStatus);
  setOpen(layout.open);
}
