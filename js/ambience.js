// Each atmosphere recording has a fixed mixer channel on the main page.
import { S } from './state.js';
import {
  getContext, getMaster, createRoom, swapRoom, glideParam, glideEnd, continueGlide, holdParam
} from './audio.js';
import { layerGate, layerSoloChanged, onLayerGates } from './mixgate.js';

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
// The recorded places and children play from audio/ambience/seamless/: the
// same recordings rebuilt from the lossless trims in audio/source/
// trimmed_originals with an equal-power crossfade across the loop point
// (6 s for the ocean, 3 s for the rest). The first cuts were butt-spliced,
// so a loud swell at the end of a file dropped straight into a quiet start
// and some loops clicked. The rain loops were already smooth and stay put.
const AMB_DIR = 'audio/ambience/seamless/';
export const AMBIENCE_SOURCES = [
  ...WORLDS.map((w, i) => ({ id: w.id, name: names[i], path: (w.dir || AMB_DIR) + w.bed })),
  { id: 'kids-beach', name: 'Children · beach', path: AMB_DIR + 'kids-beach' },
  { id: 'kids-playground', name: 'Children · playground', path: AMB_DIR + 'kids-playground' }
];
export function normalizeAmbLayers(layers) {
  // Always expose the entire library, preserving saved levels where available.
  // `peak` is the level the drift brings this sound up to when it fades it in:
  // the recording's default until someone sets its fader by hand, and from
  // then on the last level they gave it (see setAmbLayerLevel).
  return AMBIENCE_SOURCES.map(source => {
    const saved = layers.find(l => l && l.source === source.id);
    const clamp = v => Math.max(0, Math.min(1, v));
    return { source: source.id, level: Number.isFinite(saved?.level) ? clamp(saved.level) : 0,
      peak: Number.isFinite(saved?.peak) && saved.peak > 0 ? clamp(saved.peak) : defaultPeak(source.id),
      muted: saved?.muted === true, solo: saved?.solo === true };
  });
}
function defaultPeak(id) {
  return id.startsWith('kids-') ? KIDS_LEVEL : DRIFT_LEVEL;
}
// A fader moved by hand. Any level above zero also becomes the sound's peak,
// so the next time the drift fades it in, it comes back up to where it was
// last set. Zero is a pull-down, not a new peak, or the sound could never
// return. Both mixers (v0's window, v1's screen) set levels through here.
export function setAmbLayerLevel(layer, level) {
  if (!layer) return;
  layer.level = level;
  if (level > 0) layer.peak = level;
}
const peakOf = layer => layer && layer.peak > 0 ? layer.peak : (layer ? defaultPeak(layer.source) : DRIFT_LEVEL);

const canOpus = (() => {
  const a = new Audio();
  return a.canPlayType('audio/ogg; codecs=opus') !== ''
      || a.canPlayType('audio/webm; codecs=opus') !== '';
})();
const EXT = canOpus ? '.opus' : '.mp3';

const cache = new Map();
let out = null, room = null, wet = null;
let running = false;
const mixVoices = new Map();
// One event object, dispatched again on every sync (a finished dispatch can
// be reused), rather than a fresh one five times a second while the drift runs.
let mixEvt = null;
const notifyMixer = () => window.dispatchEvent(mixEvt || (mixEvt = new Event('atmospherechange')));

// Mute and solo come from the mix gate, whose solo test spans the whole mix:
// a soloed fixed channel (the piano, say) silences every recording too.
function layerGain(layer) {
  return layerGate(layer) * layer.level;
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
  room = createRoom(ctx, () => S.ambRevTime, 2.0);
  wet = ctx.createGain();
  wet.gain.value = S.ambReverb;
  out.connect(room.input);
  room.output.connect(wet).connect(master);
  return out;
}
// Both glide: a straight line over a preset's transition, the usual short
// approach for a fader (see glideParam in audio.js).
export function applyAmbVol() {
  if (out) glideParam(out.gain, S.ambVol, 0.2);
}
export function applyAmbReverb() {
  if (wet) glideParam(wet.gain, S.ambReverb, 0.12);
}

// Unlike the piano, the bed is always sounding, so there is never a quiet
// moment to swap an impulse in, and changing the buffer under a signal that
// is mid-tail steps the output. This used to duck the whole send, swap in the
// gap and bring it back, which was smooth but left the room briefly empty.
// The room is a pair of convolvers now (createRoom in audio.js), so the new
// impulse is crossfaded in under the old one's tail instead.
export function rebuildAmbIR() {
  swapRoom(room, 200);
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
  glideParam(g.gain, level, fade / 3);
  return { s, g, meter, samples: new Float32Array(meter.fftSize) };
}
function fadeOut(v, fade) {
  if (!v) return;
  const ctx = getContext();
  // A glide may still have ramps queued into the future, and a target laid
  // among them would be pulled back up by the next one, so they go first.
  hold(v.g.gain, ctx.currentTime);
  glideParam(v.g.gain, 0, fade / 3);
  // stopped once it is silent, however long a transition made the fade
  const end = glideEnd();
  const wait = Math.max(fade + 2, end ? end - ctx.currentTime + 0.5 : 0);
  setTimeout(() => { try { v.s.stop(); } catch (e) {} }, wait * 1000);
}

// ---------- glides ----------
// A glide is a slow level change written onto the audio clock all at once,
// so it plays out smoothly however late or rarely the page gets to run. The
// drift used to walk each level along from a 5 Hz tick on the render loop, and
// when that loop stalled (a hidden tab, an occluded window, a busy machine)
// the level waited and then leapt to wherever the clock said it should be:
// a twelve second crossfade heard as a cut. Now the whole curve is scheduled
// on the gain the moment it starts, and the tick only reads it back so the
// fader on screen can follow.
//
// layer.level stays the logical level the mixer shows. A glide remembers the
// last value it wrote there, and if the level has since become anything else
// a person (or a preset, or another tab) has set it, so the glide steps aside
// and that layer is theirs again. Mute and solo still close the gate over a
// gliding layer; opening it again picks the glide back up where it has got to.
// Kept in a WeakMap rather than on the layer, so a glide is never saved.
const glides = new WeakMap();      // layer -> { from, to, t0, t1, shown }
const GLIDE_SEG_S = 0.25;          // breakpoint spacing of the scheduled curve
// and the most breakpoints one glide writes. Every event is inserted by a
// scan of the param's list, so a ten minute drift fade at 0.25 s was 2400
// ramps written in one go, a stall of several milliseconds each time a
// place changed. 96 straight segments follow the quarter sine to within
// about 0.00003 of full scale; glides up to 24 s (the default 12 s fade
// among them) keep the quarter second spacing exactly as before.
const GLIDE_SEG_MAX = 96;

// Equal power: rising layers follow a quarter sine, falling ones the matching
// quarter cosine, so a crossfade between two places holds its loudness
// instead of dipping in the middle the way a straight line of gain does.
function glideAt(g, t) {
  const f = (t - g.t0) / (g.t1 - g.t0);
  if (f >= 1) return g.to;
  if (f <= 0) return g.from;
  const e = g.to > g.from ? Math.sin(f * Math.PI / 2) : 1 - Math.cos(f * Math.PI / 2);
  return g.from + (g.to - g.from) * e;
}

// Freeze a gain where it is right now and drop everything queued after it,
// including a preset transition's ramp, which this replaces.
function hold(param, t) {
  holdParam(param, t);
}

// The whole remaining glide, as short linear segments on the curve. A glide
// that already started (a voice that finished loading late, a gate that just
// reopened) is met after a short approach rather than jumped to.
function scheduleGlide(param, g, now, approach) {
  hold(param, now);
  const start = now + approach;
  if (start >= g.t1) { param.linearRampToValueAtTime(g.to, start); return; }
  param.linearRampToValueAtTime(glideAt(g, start), start);
  const n = Math.max(1, Math.min(GLIDE_SEG_MAX, Math.ceil((g.t1 - start) / GLIDE_SEG_S)));
  for (let k = 1; k <= n; k++) {
    const t = start + (g.t1 - start) * k / n;
    param.linearRampToValueAtTime(glideAt(g, t), t);
  }
}

// Brings layer.level up to date with its glide, and retires the glide when it
// has landed or when someone else has moved the fader. Returns the glide
// still running, or null.
function advanceGlide(layer, now) {
  const g = glides.get(layer);
  if (!g) return null;
  if (layer.level !== g.shown) { glides.delete(layer); return null; }
  if (now >= g.t1) { layer.level = g.to; glides.delete(layer); return null; }
  layer.level = g.shown = glideAt(g, now);
  return g;
}

// Starts a glide of one layer's level to `to` over `seconds` of audio time.
// With no audio context yet there is nothing to hear, so the level is just
// set. The gain itself is scheduled by the next syncAmbLayers.
export function glideAmbLayer(layer, to, seconds) {
  if (!layer) return;
  const ctx = getContext();
  if (ctx) advanceGlide(layer, ctx.currentTime);
  if (!ctx || !(seconds > 0) || Math.abs(layer.level - to) < 1e-4) {
    glides.delete(layer); layer.level = to; return;
  }
  const t0 = ctx.currentTime;
  glides.set(layer, { from: layer.level, to, t0, t1: t0 + seconds, shown: layer.level });
}
export const ambLayerGliding = layer => glides.has(layer);

// Stops every glide where it has got to; the levels stay put.
export function haltAmbGlides() {
  const ctx = getContext();
  for (const layer of S.ambLayers) {
    if (ctx) advanceGlide(layer, ctx.currentTime);
    glides.delete(layer);
  }
}

// One voice's gain: either its glide, scheduled once on the audio clock, or
// the plain level approached over 0.12 s as always (or, inside a preset's
// transition, a straight line over its window). A glide already on the
// gain is left alone, so the 5 Hz syncs during a fade never fight it.
function applyGain(slot, glide, gate, level, now, approach) {
  const p = slot.v.g.gain;
  if (glide && gate) {
    if (slot.glideOn === glide) return;
    slot.glideOn = glide;
    scheduleGlide(p, glide, now, approach);
    return;
  }
  if (slot.glideOn) { hold(p, now); slot.glideOn = null; slot.applied = NaN; }
  // Every sync re-applies every voice, and syncs come thick: each tick of a
  // level fader's drag, and five a second while the drift is moving. Each
  // re-apply was a setTargetAtTime on every recording's gain, a dozen
  // automation events a sync on voices whose level had not moved at all, each
  // one taking the parameter's lock against the audio thread. A voice already
  // heading for this level is left alone. Inside a preset's transition the
  // call still goes through, so the transition's straight line is laid down.
  if (level === slot.applied && !glideEnd()) return;
  slot.applied = level;
  glideParam(p, level, 0.12);
}

// Manual layers share the atmosphere bus, reverb and main transport. Each
// channel owns its pending load so stale requests cannot resurrect removed audio.
export function syncAmbLayers() {
  // A recording's solo coming on or off moves the six fixed channels' gates
  // as well; this re-applies them only when that answer actually changed.
  layerSoloChanged();
  // Glides advance even while the atmosphere is off, so the faders keep
  // showing where the drift has got to.
  const ctx = getContext();
  const now = ctx ? ctx.currentTime : 0;
  // A recording that has to load arrives after a preset's transition has
  // closed; this is the window it belongs to.
  const end = glideEnd();
  for (const layer of S.ambLayers) advanceGlide(layer, now);
  if (!running) { notifyMixer(); return; }
  for (const [layer, slot] of mixVoices) {
    if (S.ambLayers.includes(layer)) continue;
    slot.request++;
    if (slot.v) fadeOut(slot.v, 0.35);
    mixVoices.delete(layer);
  }
  for (const layer of S.ambLayers) {
    const glide = glides.get(layer) || null;
    const gate = layerGate(layer);
    const level = gate * layer.level;
    // A layer gliding up from silence needs its recording loaded before its
    // level leaves zero, and one gliding down keeps it until it lands.
    const wanted = glide ? gate * Math.max(layer.level, glide.to) : level;
    let slot = mixVoices.get(layer);
    if (!slot) { slot = { request: 0, v: null, source: null, pending: null, error: '', glideOn: null, applied: NaN }; mixVoices.set(layer, slot); }
    if (slot.v) applyGain(slot, glide, gate, level, now, 0.15);
    if (slot.source === layer.source && slot.v) {
      if (slot.pending) { slot.request++; slot.pending = null; }
      slot.error = '';
      continue;
    }
    if (wanted === 0) {
      slot.request++; slot.pending = null; slot.error = '';
      if (slot.v) { fadeOut(slot.v, 0.35); slot.v = null; slot.source = null; slot.glideOn = null; }
      continue;
    }
    if (slot.pending === layer.source) continue;
    const source = AMBIENCE_SOURCES.find(s => s.id === layer.source);
    if (!source) continue;
    const request = ++slot.request;
    slot.pending = source.id; slot.error = '';
    buf(source.path + EXT).then(b => continueGlide(end, () => {
      if (!running || mixVoices.get(layer) !== slot || slot.request !== request) return;
      const old = slot.v;
      slot.v = voice(b, layerGain(layer), 0.6);
      slot.glideOn = null; slot.applied = NaN;
      // A glide that was waiting on this load takes the new voice over from
      // its first moment, met over the same 0.6 s a fresh voice fades in on.
      const c = getContext(), g = advanceGlide(layer, c.currentTime);
      if (g && layerGate(layer)) applyGain(slot, g, 1, 0, c.currentTime, 0.6);
      slot.source = source.id; slot.pending = null;
      if (old) fadeOut(old, 0.6);
      notifyMixer();
    })).catch(() => {
      if (mixVoices.get(layer) !== slot || slot.request !== request) return;
      slot.pending = null;
      slot.error = slot.v ? 'Could not load; previous recording still playing.' : 'Could not load. Move this slider to retry.';
      notifyMixer();
    });
  }
  notifyMixer();
}

// The mix gate re-syncs the recordings whenever any mute or solo changes.
onLayerGates(syncAmbLayers);

export function ambLayerStatus(layer) {
  const slot = mixVoices.get(layer);
  return slot?.error || (slot?.pending ? 'Loading…' : slot?.v && layerGain(layer) > 0 ? 'Playing' : '');
}

// Post-fader signal, before the shared atmosphere/master gain.
export function ambLayerPeak(layer) {
  const v = mixVoices.get(layer)?.v;
  if (!running || !v || !S.running || !S.audioEnabled || getContext()?.state !== 'running') return 0;
  const x = v.samples;
  v.meter.getFloatTimeDomainData(x);
  let peak = 0;   // indexed, as tapPeak in util.js, for the same reason
  for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > peak) peak = a; }
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

// ---------- drift ----------
// An unattended hand on the mixer, shared by v0's mixer window and v1: every
// so often the atmosphere crossfades to a different recorded place and
// settles there a while before moving on. Each fade is a glide, so it is
// scheduled on the audio clock and sounds the same however unevenly the
// caller's tick arrives; the tick only decides when the next move is due.
//
// The children ride alongside the places. While drift runs they come and go:
// a visit and an absence alternate. A visit lasts 60 to 180 s; how long an
// absence lasts follows Children (S.ambKidsFreq, the share of the time they
// are there): at its default of two thirds, 30 to 90 s, as it always was,
// shorter above it and longer below, until at 100% they never leave and at
// 0 never come. A visit brings one track only, the one the current
// place names in its `kids` field (the beach for the ocean places, the
// playground inland); night and rain name none, so there the children
// already playing stay, and a visit that starts there brings one of the two
// at random (kidsFor). Children are never silenced by the place alone. They sit well back, at 0.4 of the
// place's own drift level, and fade over ten seconds. If the drift moves to a
// place whose children differ, the visit ends and they fade out with the
// crossfade. At the default every visit is followed by at least 30 s of
// absence, longer than any fade, so one track has always gone before the
// other can arrive; turned high, a change of place can crossfade the two.
const DRIFT_IDS = WORLDS.map(w => w.id);
const KIDS_IDS = [...new Set(WORLDS.map(w => w.kids).filter(Boolean))];
export const DRIFT_LEVEL = 0.55;
// The crossfade between places, in seconds, set by the Drift transition
// control (S.ambDriftFadeS); 12 s when unset or out of range.
const driftFadeS = () => {
  const v = S.ambDriftFadeS;
  return typeof v === 'number' && v >= 1 && v <= 600 ? v : 12;
};
const DWELL_MIN_MS = 45000, DWELL_SPAN_MS = 45000;
const KIDS_LEVEL = DRIFT_LEVEL * 0.4;
const KIDS_FADE_S = 10;
const KIDS_VISIT_MIN_MS = 60000, KIDS_VISIT_SPAN_MS = 120000;     // visits 60-180 s
const KIDS_AWAY_MIN_MS = 30000, KIDS_AWAY_SPAN_MS = 60000;        // absences 30-90 s
const kidsVisitPeriod = () => KIDS_VISIT_MIN_MS + Math.random() * KIDS_VISIT_SPAN_MS;
// The children for a place: its own track, or for a place with none, the
// ones already there, else either at random.
function kidsFor(worldId, current) {
  const w = WORLDS.find(x => x.id === worldId);
  if (w && w.kids) return w.kids;
  return current || KIDS_IDS[Math.floor(Math.random() * KIDS_IDS.length)];
}
const kidsShare = () => {
  const v = S.ambKidsFreq;
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : 2 / 3;
};
// The absence that gives the visits their share: 2 (1 - f) / f times the
// 30-90 s draw, since the visits average 120 s and the absences 60 at 2/3.
const kidsPeriod = () => {
  const f = kidsShare();
  if (f <= 0 || f >= 1) return 0;
  return (KIDS_AWAY_MIN_MS + Math.random() * KIDS_AWAY_SPAN_MS) * 2 * (1 - f) / f;
};

// world: where the drift is going or has settled; dwellUntil: 0 while the
// crossfade is still sounding; kids: the current visit or absence.
let drift = null;

function layerOf(id) {
  const layers = S.ambLayers;
  for (let i = 0; i < layers.length; i++) if (layers[i].source === id) return layers[i];
  return undefined;
}
function anyGliding(ids) {
  for (let i = 0; i < ids.length; i++) if (glides.has(layerOf(ids[i]))) return true;
  return false;
}

function crossfadeWorld() {
  const current = drift.world;
  let next = DRIFT_IDS[Math.floor(Math.random() * DRIFT_IDS.length)];
  if (DRIFT_IDS.length > 1) while (next === current) next = DRIFT_IDS[Math.floor(Math.random() * DRIFT_IDS.length)];
  drift.world = next; drift.dwellUntil = 0;
  for (let i = 0; i < DRIFT_IDS.length; i++) {
    const id = DRIFT_IDS[i];
    glideAmbLayer(layerOf(id), id === next ? peakOf(layerOf(id)) : 0, driftFadeS());
  }
  // Children who do not belong in the new place leave with the old one, on
  // their own fade rather than the place's, so a long place crossfade can
  // never keep one children's track sounding into the next visit.
  const k = drift.kids, kids = kidsFor(next, k.id);
  if (k.present && k.id && k.id !== kids && kidsShare() < 1) {
    glideAmbLayer(layerOf(k.id), 0, KIDS_FADE_S);
    k.present = false; k.id = null; k.until = Date.now() + kidsPeriod();
  }
}

// At either end of Children the schedule steps aside: 0 sends any visit
// home at once, and 100% keeps the current place's children in, following
// the drift from place to place. Both take effect on the next tick.
function kidsTick(now) {
  const k = drift.kids, f = kidsShare();
  if (f <= 0) {
    if (k.present) { if (k.id) glideAmbLayer(layerOf(k.id), 0, KIDS_FADE_S); k.present = false; k.id = null; }
    k.until = now;
    return;
  }
  if (f >= 1) {
    const want = kidsFor(drift.world, k.present ? k.id : null);
    if (!k.present || k.id !== want) {
      if (k.present && k.id) glideAmbLayer(layerOf(k.id), 0, KIDS_FADE_S);
      k.present = true; k.id = want;
      if (want) glideAmbLayer(layerOf(want), peakOf(layerOf(want)), KIDS_FADE_S);
    }
    if (k.until < now) k.until = now + kidsVisitPeriod();
    return;
  }
  if (now < k.until) return;
  if (k.present) {
    if (k.id) glideAmbLayer(layerOf(k.id), 0, KIDS_FADE_S);
    k.present = false; k.id = null;
  } else {
    k.present = true;
    k.id = kidsFor(drift.world, null);
    if (k.id) glideAmbLayer(layerOf(k.id), peakOf(layerOf(k.id)), KIDS_FADE_S);
  }
  k.until = now + (k.present ? kidsVisitPeriod() : kidsPeriod());
}

export function startAmbDrift() {
  if (drift) return;
  drift = { world: null, dwellUntil: 0, moving: false,
            kids: { present: false, id: null, until: Date.now() + kidsPeriod() } };
  crossfadeWorld();
  // Drift starts in an absence, so any children left up from before go now.
  for (let i = 0; i < KIDS_IDS.length; i++) glideAmbLayer(layerOf(KIDS_IDS[i]), 0, KIDS_FADE_S);
  drift.moving = true;
  syncAmbLayers();
}

// Every glide stops where it has got to, and the children become an ordinary
// recording again, on their own fader.
export function stopAmbDrift() {
  if (!drift) return;
  drift = null;
  haltAmbGlides();
  syncAmbLayers();
}
export const ambDriftOn = () => !!drift;

// The caller's periodic tick, a few times a second. Returns 'moving' while any
// drift fade is sounding, 'landed' on the tick the last one finishes (the
// moment worth saving), and '' otherwise.
export function ambDriftTick() {
  if (!drift) return '';
  const ctx = getContext();
  if (ctx) for (const layer of S.ambLayers) advanceGlide(layer, ctx.currentTime);
  const now = Date.now();
  if (!drift.dwellUntil) {
    if (!anyGliding(DRIFT_IDS)) drift.dwellUntil = now + DWELL_MIN_MS + Math.random() * DWELL_SPAN_MS;
  } else if (now >= drift.dwellUntil) {
    crossfadeWorld();
  }
  kidsTick(now);
  const was = drift.moving;
  drift.moving = anyGliding(DRIFT_IDS) || anyGliding(KIDS_IDS);
  if (!drift.moving && !was) return '';
  syncAmbLayers();
  return drift.moving ? 'moving' : 'landed';
}
