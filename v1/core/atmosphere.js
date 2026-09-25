// The atmosphere mixer's own logic, ported out of js/ambience-mixer.js with
// every DOM line left behind: the drift scheduler that slowly crossfades
// between recorded places, the meters the mixer screen paints as twelve LEDs
// a channel, and the dynamic per-layer controls (one source's level, mute
// and solo) that the fixed schema-audio.js array has no room for since there
// are as many of them as js/ambience.js has recordings.
//
// Nothing here owns a frame loop. v0 drove the meters and the drift both off
// a DOM-side rAF and a setInterval; here the integrator calls stepAtmosphere
// once a frame instead, and this file decides for itself how much of that
// frame's worth of work is actually due.
import { S } from '../../js/state.js';
import {
  AMBIENCE_SOURCES, normalizeAmbLayers, syncAmbLayers, ambLayerStatus, ambLayerPeak,
  startAmbDrift, stopAmbDrift, ambDriftTick, setAmbLayerLevel
} from '../../js/ambience.js';
import { enginePeaks, setEngineMeters } from '../../js/audio.js';
import { pianoPeak, bedPeak, arpPeak } from '../../js/piano.js';
import { cloudPeak } from '../../js/clouds.js';
import { layerGate, applyMixGates } from '../../js/mixgate.js';
import { save, flush } from './store.js';

// ---------- worker mode ----------
// With the engine in a worker (core/engine-thread.js), the frame-side half of
// this module runs there, while the recordings, their analysers and the
// drift's audio-clock fades live on the page with the rest of the sound. The
// page's copy of this module then does all the real work (core/audio-shell.js
// steps it) and packs what the mixer shows into the mirror it posts: meter
// counts, each recording's status and, while the drift runs, the levels it
// has glided to (packAtmosphere, at the end of this file). The worker's copy
// runs remote: no analyser reads, no drift of its own, and the mixer shows
// what arrives (unpackAtmosphere). core/audio-link.js switches it on before
// initAtmosphere runs.
let remote = false;
let remoteMeters = false;        // what the worker's mixer last asked for
const remoteStatus = [];         // per layer, an index into STATUS_TEXT
export function setAtmosphereRemote(on) { remote = !!on; }
// Whether the worker's mixer is showing its meters, so the page should read them.
export const atmosphereMetersWanted = () => remoteMeters;

// js/ambience.js's status lines, so a status can cross as one number.
const STATUS_TEXT = ['', 'Loading…', 'Playing',
  'Could not load; previous recording still playing.', 'Could not load. Move this slider to retry.'];
function statusCode(text) {
  const i = STATUS_TEXT.indexOf(text);
  return i >= 0 ? i : text.startsWith('Could not') ? 4 : 0;
}
const statusOf = (i, layer) => remote ? STATUS_TEXT[remoteStatus[i] | 0] : ambLayerStatus(layer);

// ---------- layer bookkeeping ----------
// state.js seeds S.ambLayers with only the three recordings someone is most
// likely to want; the mixer always shows the whole library, with saved
// levels carried over onto it. store.js's load() should already have run
// this once (it is what js/settings.js's applySettings does today), so this
// is a safety net for whatever runs before that, not the primary path.
function ensureLayers(s) {
  if (!Array.isArray(s.ambLayers) || s.ambLayers.length !== AMBIENCE_SOURCES.length) {
    s.ambLayers = normalizeAmbLayers(s.ambLayers || []);
  }
  return s.ambLayers;
}
export const AMB_LAYER_COUNT = AMBIENCE_SOURCES.length;
export function ambienceSourceName(i) { return AMBIENCE_SOURCES[i].name; }

// Whether a layer is actually contributing to the mix right now: audible
// level, not muted, and either nothing anywhere in the mix is soloed (the six
// fixed channels included) or this is one of the solos.
export function layerActive(i, s = S) {
  const layer = ensureLayers(s)[i];
  if (!layer) return false;
  return layer.level > 0 && layerGate(layer) > 0;
}

// Loading / error / playing, straight from js/ambience.js's own bookkeeping
// for the voice behind this layer.
export function layerStatus(i, s = S) {
  const layer = ensureLayers(s)[i];
  return layer ? statusOf(i, layer) : '';
}

// The line the mixer window prints along its bottom edge. '13 SOURCES' in
// v0 was a literal count typed into the string; here it is however many
// AMBIENCE_SOURCES actually holds, so the two can never drift apart.
export function mixerStatusText(s = S) {
  let loading = 0, failed = 0;
  const layers = ensureLayers(s);
  for (let i = 0; i < layers.length; i++) {
    const status = statusOf(i, layers[i]);
    if (status === 'Loading…') loading++;
    else if (status.startsWith('Could not')) failed++;
  }
  if (failed) return `${failed} recording failed · adjust its fader to retry`;
  if (loading) return `${loading} loading…`;
  if (!s.ambOn) return 'ATMOSPHERE OFF';
  if (!s.running) return 'STOPPED · press space to play';
  return `${AMBIENCE_SOURCES.length} SOURCES · POST-FADER METERS`;
}

// ---------- dynamic per-layer controls ----------
// One source's row is three Control-like objects: a 0-100 level fader and
// two toggles. Built once per index and handed back the same object on every
// call, since the toolkit hashes a control's id once at the call site and
// expects the same identity back, the same way schema-audio.js's static
// array is only ever built once.
const layerControlCache = [];
export function ambLayerControls(i) {
  const cached = layerControlCache[i];
  if (cached) return cached;
  const source = AMBIENCE_SOURCES[i];
  const entry = {
    level: {
      id: 'ambLevel-' + source.id, section: 'mixer', label: source.name, kind: 'slider',
      min: 0, max: 100, step: 1, def: 0,
      get: s => Math.round((ensureLayers(s)[i]?.level ?? 0) * 100),
      set: (s, pos) => { setAmbLayerLevel(ensureLayers(s)[i], pos / 100); syncAmbLayers(); save(); },
      // the readout is the position itself, so a typed level needs no parse
      format: s => String(Math.round((ensureLayers(s)[i]?.level ?? 0) * 100))
    },
    mute: {
      id: 'ambMute-' + source.id, section: 'mixer', label: 'Mute ' + source.name, kind: 'toggle',
      get: s => !!ensureLayers(s)[i]?.muted,
      set: (s, on) => { ensureLayers(s)[i].muted = !!on; applyMixGates(); save(); },
      format: s => ensureLayers(s)[i]?.muted ? 'M' : ''
    },
    solo: {
      id: 'ambSolo-' + source.id, section: 'mixer', label: 'Solo ' + source.name, kind: 'toggle',
      get: s => !!ensureLayers(s)[i]?.solo,
      // A recording's solo is a mix-wide solo, so every gate is re-applied,
      // the six fixed channels' as well as the recordings'.
      set: (s, on) => { ensureLayers(s)[i].solo = !!on; applyMixGates(); save(); },
      format: s => ensureLayers(s)[i]?.solo ? 'S' : ''
    }
  };
  layerControlCache[i] = entry;
  return entry;
}

// ---------- meters ----------
// One meter, twelve LEDs, -60 to 0 dBFS, the peak falling on its own 180 ms
// release so a pip that lands between two frames still reads. Identical maths
// to js/ambience-mixer.js's paintMeter; only the DOM classList write is gone.
const LEDS = 12;
function updateMeter(meter, level, dt) {
  meter.peak = Math.max(level, meter.peak * Math.exp(-dt / 180));
  const db = meter.peak > 0 ? 20 * Math.log10(meter.peak) : -Infinity;
  meter.count = Math.max(0, Math.min(LEDS, Math.ceil((db + 60) / 5)));
  return meter.count;
}

// The fixed channels' meters read the same sources js/ambience-mixer.js's
// CHANNELS table did, keyed by the mixer control id schema-audio.js gives
// each fader so a screen can go straight from one to the other.
const CHANNEL_PEAK_FNS = {
  mixFund:   () => enginePeaks().tone,
  mixHarm:   () => enginePeaks().harm,
  mixPulse:  () => enginePeaks().pulse,
  mixPiano:  pianoPeak,
  mixClouds: cloudPeak,
  mixDrone:  bedPeak,
  mixArp:    arpPeak
};
const channelMeters = {};
// Listed once so the per-frame meter step walks a fixed array instead of
// building one from Object.keys every frame.
const CHANNEL_IDS = Object.keys(CHANNEL_PEAK_FNS);
for (const id of CHANNEL_IDS) channelMeters[id] = { peak: 0, count: 0 };
const layerMeters = [];

// Post-fader signal for one fixed channel, before the meter's own release.
export function channelPeak(id) {
  const fn = CHANNEL_PEAK_FNS[id];
  return fn ? fn() : 0;
}
// The current LED count (0-12) for a fixed channel or a source layer, as of
// the last stepAtmosphere call. Reading these never itself advances the
// release; only stepAtmosphere does, so the mixer screen can poll them as
// often as it draws without double-decaying the peak.
export function meterCount(id) { return channelMeters[id] ? channelMeters[id].count : 0; }
export function layerMeterCount(i) { return layerMeters[i] ? layerMeters[i].count : 0; }

// ---------- drift ----------
// An unattended hand on the mixer: every so often the atmosphere crossfades
// to a different recorded place and settles there a while before moving on,
// with the children coming and going alongside. The scheduler itself lives in
// js/ambience.js, shared with v0, and writes every fade onto the audio clock
// the moment it begins, so a stalled or throttled frame loop can delay when
// the next move starts but can no longer make a fade jump. What stays here is
// the ~5 Hz tick that drives it and v1's saving policy.
const DRIFT_TICK_MS = 200;          // ~5 Hz, the same cadence v0's setInterval ran
const DRIFT_SAVE_DEBOUNCE_MS = 2000;

let driftActive = false;
let driftSaveTimer = null;
let lastDriftTick = 0;
// Worker mode, page side: the drift runs here but the settings are written
// by the worker, so each move is handed to this hook (which posts it across)
// instead of being saved here; the worker's copy runs noteDrift on it.
let driftHook = null;
export function setDriftHook(fn) { driftHook = fn; }

function driftTick() {
  const moved = ambDriftTick();
  if (driftHook) { if (moved) driftHook(moved); return; }
  noteDrift(moved);
}

// The saving policy for one tick's outcome ('moving', 'landed' or '').
export function noteDrift(moved) {
  // A crossfade runs this tick at ~5 Hz for twelve seconds. Saving on
  // every one of those is sixty synchronous writes for a fade whose only
  // durable fact is where it lands, so the write trails the motion by two
  // seconds instead of chasing it, and the landing itself is flushed
  // immediately rather than left to the trailing debounce. flush() writes
  // only what save() has marked, so the landing is marked first.
  if (moved === 'landed') { clearTimeout(driftSaveTimer); driftSaveTimer = null; save(); flush(); }
  else if (moved === 'moving' && !driftSaveTimer) {
    driftSaveTimer = setTimeout(() => { driftSaveTimer = null; save(); }, DRIFT_SAVE_DEBOUNCE_MS);
  }
}

export function startDrift() {
  if (driftActive) return;
  driftActive = true;
  if (remote) return;
  ensureLayers(S);
  startAmbDrift();
  lastDriftTick = 0;
}
export function stopDrift() {
  driftActive = false;
  if (!remote) stopAmbDrift();
  clearTimeout(driftSaveTimer); driftSaveTimer = null;
}

// Called once at boot, after store.js's load() has restored S.ambDrift, so a
// saved session that had drift running comes back with it running.
export function initAtmosphere(s = S) {
  ensureLayers(s);
  if (s.ambDrift) startDrift();
}

// ---------- the integrator's one call per frame ----------
// Advances the meters and the drift scheduler (gated to ~5 Hz internally,
// since crossfading has no reason to recompute every 60th of a second). t is
// the same rAF timestamp, in milliseconds, that strobe.stepStrobe(t) receives.
//
// The meters are gated too. Each read copies and scans 1024 samples from
// every analyser tap, up to sixteen of them, and at 120 Hz that
// was two million samples a second on the strobe's thread for LEDs nobody can
// follow that fast. The release formula is time-correct at any cadence, and
// a tap's window is 1024 samples (21 ms at 48 kHz), so as long as reads land
// no more than about that far apart every sample is still seen and no pip can
// slip between two of them. So a frame skips the read only when the next
// frame will still land inside that span: every other frame at 120 Hz, every
// third at 144, and every frame at 90 Hz and below, exactly as before.
//
// meters false (the mixer window is shut) skips every meter: nearly twenty
// analyser reads a frame that nobody would see. The meters are zeroed on the
// way out, so reopening the window starts them from silence rather than
// from a stale reading decaying away, and the worklet is told to stop posting
// its engine peaks, which are otherwise a message every 20 ms.
const METER_SPAN_MS = 20;
let lastMeterT = 0, lastStepT = 0, metersWereOn = true;
function zeroMeters() {
  for (let i = 0; i < CHANNEL_IDS.length; i++) { const m = channelMeters[CHANNEL_IDS[i]]; m.peak = 0; m.count = 0; }
  for (let i = 0; i < layerMeters.length; i++) if (layerMeters[i]) { layerMeters[i].peak = 0; layerMeters[i].count = 0; }
}
export function stepAtmosphere(t, meters = true) {
  // Remote (worker mode, worker side): only note whether the meters are
  // wanted; the page reads them and the drift runs there.
  if (remote) {
    if (meters !== remoteMeters) { remoteMeters = meters; if (!meters) zeroMeters(); }
    return;
  }
  if (meters !== metersWereOn) {
    metersWereOn = meters;
    setEngineMeters(meters);
    if (!meters) zeroMeters();
    lastMeterT = 0;
  }
  const frameMs = lastStepT ? t - lastStepT : 0;
  lastStepT = t;
  if (meters && (!lastMeterT || t - lastMeterT + frameMs > METER_SPAN_MS)) {
    const dt = lastMeterT ? Math.min(200, t - lastMeterT) : 16;
    lastMeterT = t;

    for (let i = 0; i < CHANNEL_IDS.length; i++) {
      const id = CHANNEL_IDS[i];
      updateMeter(channelMeters[id], channelPeak(id), dt);
    }
    const layers = ensureLayers(S);
    for (let i = 0; i < layers.length; i++) {
      if (!layerMeters[i]) layerMeters[i] = { peak: 0, count: 0 };
      updateMeter(layerMeters[i], ambLayerPeak(layers[i]), dt);
    }
  }

  if (driftActive && t - lastDriftTick >= DRIFT_TICK_MS) {
    lastDriftTick = t;
    driftTick();
  }
}

// ---------- the mirror, worker mode ----------
// The slots packAtmosphere fills: one meter count per fixed channel, then a
// meter count, a level and a status per recording.
export const ATMOSPHERE_SLOTS = CHANNEL_IDS.length + AMB_LAYER_COUNT * 3;

// Page side: writes this module's meters, levels and statuses into out from
// index at, and returns the index after the last slot written.
export function packAtmosphere(out, at) {
  for (let i = 0; i < CHANNEL_IDS.length; i++) out[at++] = channelMeters[CHANNEL_IDS[i]].count;
  const layers = ensureLayers(S);
  for (let i = 0; i < AMB_LAYER_COUNT; i++) {
    const layer = layers[i], m = layerMeters[i];
    out[at++] = m ? m.count : 0;
    out[at++] = layer ? layer.level : 0;
    out[at++] = layer ? statusCode(ambLayerStatus(layer)) : 0;
  }
  return at;
}

// Worker side: the reverse. The levels are taken only when `levels` is true
// (the drift is moving them on the page); otherwise the worker's own levels,
// which the viewer's faders set, stay as they are.
export function unpackAtmosphere(src, at, levels) {
  for (let i = 0; i < CHANNEL_IDS.length; i++) channelMeters[CHANNEL_IDS[i]].count = src[at++];
  const layers = ensureLayers(S);
  for (let i = 0; i < AMB_LAYER_COUNT; i++) {
    if (!layerMeters[i]) layerMeters[i] = { peak: 0, count: 0 };
    layerMeters[i].count = src[at++];
    const level = src[at++];
    if (levels && layers[i]) layers[i].level = level;
    remoteStatus[i] = src[at++];
  }
  return at;
}
