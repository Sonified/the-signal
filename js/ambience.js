// Each atmosphere recording has a fixed mixer channel on the main page.
import { S } from './state.js';
import { getContext, getMaster } from './audio.js';

export const WORLDS = [
  { id: 'ocean',    bed: 'ocean-waves',    kids: 'kids-beach' },
  { id: 'shore',    bed: 'ocean-cliff',    kids: 'kids-beach' },
  { id: 'surf',     bed: 'ocean-surf',     kids: 'kids-beach' },
  { id: 'forest',   bed: 'forest-birds',   kids: 'kids-playground' },
  { id: 'woodland', bed: 'forest-wind',    kids: 'kids-playground' },
  { id: 'morning',  bed: 'forest-morning', kids: 'kids-playground' },
  { id: 'creek',    bed: 'creek',          kids: 'kids-playground' },
  { id: 'night',    bed: 'night-crickets', kids: null },
  { id: 'rain',     bed: 'rain/gentle',    kids: null, dir: 'audio/' },
  { id: 'downpour', bed: 'rain/steady',    kids: null, dir: 'audio/' },
  { id: 'eaves',    bed: 'rain/night',     kids: null, dir: 'audio/' }
];

const names = ['Ocean waves', 'Ocean cliff', 'Ocean surf', 'Forest birds', 'Forest wind',
  'Forest morning', 'Creek', 'Night crickets', 'Gentle rain', 'Steady rain', 'Rain on eaves'];
export const AMBIENCE_SOURCES = [
  ...WORLDS.map((w, i) => ({ id: w.id, name: names[i], path: (w.dir || 'audio/ambience/') + w.bed })),
  { id: 'kids-beach', name: 'Children · beach', path: 'audio/ambience/kids-beach' },
  { id: 'kids-playground', name: 'Children · playground', path: 'audio/ambience/kids-playground' }
];
export function normalizeAmbLayers(layers) {
  // Always expose the entire library, preserving saved levels where available.
  return AMBIENCE_SOURCES.map(source => {
    const saved = layers.find(l => l && l.source === source.id);
    return { source: source.id, level: Number.isFinite(saved?.level)
      ? Math.max(0, Math.min(1, saved.level)) : 0,
      muted: saved?.muted === true, solo: saved?.solo === true };
  });
}

const canOpus = (() => {
  const a = new Audio();
  return a.canPlayType('audio/ogg; codecs=opus') !== ''
      || a.canPlayType('audio/webm; codecs=opus') !== '';
})();
const EXT = canOpus ? '.opus' : '.mp3';

const cache = new Map();
let out = null, verb = null, wet = null;
let running = false;
const mixVoices = new Map();
const notifyMixer = () => window.dispatchEvent(new Event('atmospherechange'));

function layerGain(layer) {
  const soloing = S.ambLayers.some(l => l.solo);
  return layer.muted || (soloing && !layer.solo) ? 0 : layer.level;
}

async function buf(url) {
  if (cache.has(url)) return cache.get(url);
  const ctx = getContext();
  const job = fetch(url).then(r => {
    if (!r.ok) throw new Error(`Audio request failed: ${r.status}`);
    return r.arrayBuffer();
  }).then(data => ctx.decodeAudioData(data));
  cache.set(url, job);
  job.catch(() => cache.delete(url));
  return job;
}

// A decaying noise burst, the same serviceable room the piano uses.
function impulse(ctx, sec, decay) {
  const n = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/n, decay);
  }
  return b;
}

function ensureOut() {
  if (out) return out;
  const ctx = getContext(), master = getMaster();
  if (!ctx || !master) return null;
  out = ctx.createGain();
  out.gain.value = S.ambVol;
  out.connect(master);
  // A parallel send rather than an insert. The field recording stays whole and
  // the room is added behind it, so turning this up moves the place further
  // off rather than washing it out -- the ocean heard from inside a cavern,
  // not an ocean with the detail smeared out of it.
  verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, S.ambRevTime, 2.0);
  wet = ctx.createGain();
  wet.gain.value = S.ambReverb;
  out.connect(verb).connect(wet).connect(master);
  return out;
}
export function applyAmbVol() {
  if (out) out.gain.setTargetAtTime(S.ambVol, getContext().currentTime, 0.2);
}
export function applyAmbReverb() {
  if (wet) wet.gain.setTargetAtTime(S.ambReverb, getContext().currentTime, 0.12);
}

// Unlike the piano, the bed is always sounding, so there is never a quiet
// moment to swap an impulse in. Changing the buffer under a signal that is
// mid-tail steps the output. So duck the send first, swap in the gap, and
// bring it back: the room changes shape without a click.
let irTimer = null;
export function rebuildAmbIR() {
  if (!verb || !wet) return;
  clearTimeout(irTimer);
  const ctx = getContext();
  wet.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  irTimer = setTimeout(() => {
    const c = getContext();
    if (!verb || !wet || !c) return;
    verb.buffer = impulse(c, S.ambRevTime, 2.0);
    wet.gain.setTargetAtTime(S.ambReverb, c.currentTime, 0.25);
  }, 320);
}

// A voice is a looping source with its own gain, so two can overlap during a
// crossfade without either knowing about the other.
function voice(buffer, level, fade) {
  const ctx = getContext();
  const g = ctx.createGain();
  g.gain.value = 0;
  const s = ctx.createBufferSource();
  s.buffer = buffer; s.loop = true;
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  s.connect(g); g.connect(meter); meter.connect(ensureOut());
  s.start(ctx.currentTime, Math.random() * buffer.duration);   // never the same entry twice
  g.gain.setTargetAtTime(level, ctx.currentTime, fade / 3);
  return { s, g, meter, samples: new Float32Array(meter.fftSize) };
}
function fadeOut(v, fade) {
  if (!v) return;
  const ctx = getContext();
  v.g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
  setTimeout(() => { try { v.s.stop(); } catch (e) {} }, (fade + 2) * 1000);
}

// Manual layers share the atmosphere bus, reverb and main transport. Each
// channel owns its pending load so stale requests cannot resurrect removed audio.
export function syncAmbLayers() {
  if (!running) { notifyMixer(); return; }
  for (const [layer, slot] of mixVoices) {
    if (S.ambLayers.includes(layer)) continue;
    slot.request++;
    if (slot.v) fadeOut(slot.v, 0.35);
    mixVoices.delete(layer);
  }
  for (const layer of S.ambLayers) {
    const level = layerGain(layer);
    let slot = mixVoices.get(layer);
    if (!slot) { slot = { request: 0, v: null, source: null, pending: null, error: '' }; mixVoices.set(layer, slot); }
    if (slot.v) slot.v.g.gain.setTargetAtTime(level, getContext().currentTime, 0.12);
    if (slot.source === layer.source && slot.v) {
      if (slot.pending) { slot.request++; slot.pending = null; }
      slot.error = '';
      continue;
    }
    if (level === 0) {
      slot.request++; slot.pending = null; slot.error = '';
      if (slot.v) { fadeOut(slot.v, 0.35); slot.v = null; slot.source = null; }
      continue;
    }
    if (slot.pending === layer.source) continue;
    const source = AMBIENCE_SOURCES.find(s => s.id === layer.source);
    if (!source) continue;
    const request = ++slot.request;
    slot.pending = source.id; slot.error = '';
    buf(source.path + EXT).then(b => {
      if (!running || mixVoices.get(layer) !== slot || slot.request !== request) return;
      const old = slot.v;
      slot.v = voice(b, layerGain(layer), 0.6);
      slot.source = source.id; slot.pending = null;
      if (old) fadeOut(old, 0.6);
      notifyMixer();
    }).catch(() => {
      if (mixVoices.get(layer) !== slot || slot.request !== request) return;
      slot.pending = null;
      slot.error = slot.v ? 'Could not load; previous recording still playing.' : 'Could not load. Move this slider to retry.';
      notifyMixer();
    });
  }
  notifyMixer();
}

export function ambLayerStatus(layer) {
  const slot = mixVoices.get(layer);
  return slot?.error || (slot?.pending ? 'Loading…' : slot?.v && layerGain(layer) > 0 ? 'Playing' : '');
}

// Post-fader signal, before the shared atmosphere/master gain.
export function ambLayerPeak(layer) {
  const v = mixVoices.get(layer)?.v;
  if (!running || !v || !S.running || !S.audioEnabled || getContext()?.state !== 'running') return 0;
  v.meter.getFloatTimeDomainData(v.samples);
  let peak = 0;
  for (const sample of v.samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

export async function ambienceOn() {
  if (!getContext() || running || !ensureOut()) return false;
  running = true;
  syncAmbLayers();
  return true;
}
export function ambienceOff() {
  running = false;
  for (const slot of mixVoices.values()) {
    slot.request++;
    if (slot.v) fadeOut(slot.v, 0.35);
  }
  mixVoices.clear();
  notifyMixer();
}
