// Each atmosphere recording has a fixed mixer channel on the main page.
import { S } from './state.js';
import {
  getContext, getMaster, createRoom, swapRoom, glideParam, glideEnd, continueGlide, holdParam,
  sourceGate
} from './audio.js';
import { layerGate, layerSoloChanged, onLayerGates } from './mixgate.js';
import { every } from './ticker.js';
import { breath, breathState } from '../core/variance.js';
import { ctxFor, masterFor, makeWorklet } from './heart/route.js';

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
// The maxes a fresh setup starts from, where one has been dialled in by ear
// (the rest take the drift's own levels below). A max the viewer has set by
// hand is saved with the layer and always wins over these.
const DEFAULT_PEAKS = { morning: 0.40, 'kids-playground': 0.57 };
function defaultPeak(id) {
  if (DEFAULT_PEAKS[id] !== undefined) return DEFAULT_PEAKS[id];
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
let revIn = null, convFeed = null, algo = null, algoFeed = null, algoDead = false;
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

// The bus's gain is the atmosphere's level times v1's Music window trim
// (S.musAmb, 0 to 1, where 1 plays exactly the level; v0 never sets it, so
// unset reads as 1). The mixer's own master fader shows the level alone.
const perfTrim = v => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
const outLevel = () => S.ambVol * perfTrim(S.musAmb ?? 1);

// The atmosphere is built on the context route.js gives the ambience family:
// Heart's, rendered ahead in a worker, when ?heart= names it, else the
// native one (spec 12). Its clock is the native one either way, so every
// time below is still read from getContext(). Until audio.js has asked
// route.js to start Heart, route.js has no context to give, and the bus is
// built natively as it always was. Once the bus is built, every voice is
// made on the context it lives on, since a node cannot connect to another
// engine's: a bus begun natively while Heart was still starting stays
// native, as route.js says it should.
let outCtx = null;

function ensureOut() {
  if (out) return out;
  const ctx = ctxFor('ambience') || getContext(), master = masterFor('ambience') || getMaster();
  if (!ctx || !master) return null;
  outCtx = ctx;
  out = ctx.createGain();
  out.gain.value = outLevel();
  // The pause gate (audio.js) on the dry side, a gain of its own since the
  // bus's is the atmosphere's level, and on the room's input below, so a
  // pause stops the recordings at once and lets the room ring out.
  const gate = ctx.createGain();
  sourceGate(gate.gain);
  out.connect(gate).connect(master);
  // A parallel send rather than an insert. The field recording stays whole and
  // the room is added behind it, so turning this up moves the place further
  // off rather than washing it out -- the ocean heard from inside a cavern,
  // not an ocean with the detail smeared out of it.
  // The way into the room, whichever type plays it: the bus feeds revIn, and
  // revIn feeds the convolution room through convFeed or the algorithmic one
  // through its own feed (applyAmbRevType), both into wet.
  wet = ctx.createGain();
  wet.gain.value = S.ambReverb;
  wet.connect(master);
  revIn = ctx.createGain();
  sourceGate(revIn.gain);
  out.connect(revIn);
  convFeed = ctx.createGain();
  revIn.connect(convFeed);
  applyAmbRevType();
  if (!breatheTimer) breatheTimer = every(100, revBreathe);
  return out;
}
// Both glide: a straight line over a preset's transition, the usual short
// approach for a fader (see glideParam in audio.js).
export function applyAmbVol() {
  if (out) glideParam(out.gain, outLevel(), 0.2);
}
export function applyAmbReverb() {
  if (wet) glideParam(wet.gain, ambEffectiveReverb(), 0.12);
}

// Unlike the piano, the bed is always sounding, so there is never a quiet
// moment to swap an impulse in, and changing the buffer under a signal that
// is mid-tail steps the output. This used to duck the whole send, swap in the
// gap and bring it back, which was smooth but left the room briefly empty.
// The room is a pair of convolvers now (createRoom in audio.js), so the new
// impulse is crossfaded in under the old one's tail instead.
export function rebuildAmbIR() {
  if (revAlgoNow) algoTune(0.05); else swapRoom(room, 200);
}

// The Reverb type, as the music's (js/piano.js applyRevType): Convolution,
// the room above, or Algorithmic, the feedback delay network in
// fdn-worklet.js, whose decay is a number, so a new decay is heard as it
// moves rather than built and crossfaded in. Both are fed from revIn and both
// play into wet, so the level and the decay are the same settings either
// way. A change crossfades the feeds, not the outputs, so the old reverb's
// tail rings out under the new one; once it has, the old one's feed is
// unplugged and it falls idle. Each is made the first time it is chosen. On
// Heart the network is Heart's own twin, made in the ambience island
// (route.js makeWorklet); natively it is the module audio.js loads beside
// the engine's, and if that did not load the type stays on convolution.
// Unset is Algorithmic.
let revAlgoNow = false, revUnplug = null;
const wantAlgo = () => S.ambRevType !== 'conv';
const rev01 = v => Math.max(0, Math.min(1, +v || 0));

// The room's two variances, the music room's own (js/piano.js revBreathe):
// the level and the decay ease down from their settings by the amount's
// share and back, one cycle per their speed (unset reads as 20 s), stepped
// ten times a second on the ambience context's clock. The decay plays in
// half seconds under convolution, so the room builds a new impulse only
// when the dip crosses a step; the algorithmic one takes it as it moves.
// schema-audio.js reads the two effectives for the sliders' glowing bars.
const revLevelB = breathState(), revTimeB = breathState();
let effRevLevelDepth = 0, effRevTimeDepth = 0;
const revDecay = () => Math.max(1, S.ambRevTime * (1 - effRevTimeDepth));
const revSec = () => Math.round(revDecay() * 2) / 2;
export const ambEffectiveReverb = () => Math.max(0, S.ambReverb || 0) * (1 - effRevLevelDepth);
export const ambEffectiveRevTime = () => revAlgoNow ? revDecay() : revSec();
let breatheTimer = 0;
function revBreathe() {
  if (!outCtx) return;
  const now = outCtx.currentTime;
  const level0 = effRevLevelDepth, time0 = effRevTimeDepth, sec0 = revSec();
  effRevLevelDepth = breath(revLevelB, rev01(S.ambReverbVar), S.ambReverbPeriod, now, 'sine', 20);
  effRevTimeDepth = breath(revTimeB, rev01(S.ambRevTimeVar), S.ambRevTimePeriod, now, 'sine', 20);
  if (wet && effRevLevelDepth !== level0) glideParam(wet.gain, ambEffectiveReverb(), 0.25);
  if (revAlgoNow) { if (effRevTimeDepth !== time0) algoTune(0.25); }
  else if (room && revSec() !== sec0) swapRoom(room, 200);
}
// On Heart a gesture is heard about a lookahead after currentTime (js/piano.js
// lateBy), which the unplug waits on top.
const lateBy = ctx => ctx.presentTime === undefined ? 0 : Math.max(0, ctx.presentTime - ctx.currentTime);
function convRoom() {
  if (room) return room;
  room = createRoom(outCtx, () => revSec(), 2.0);
  room.output.connect(wet);
  convFeed.connect(room.input);
  return room;
}
function algoNode() {
  if (algo || algoDead) return algo;
  try {
    algo = makeWorklet(outCtx, 'fdn-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  } catch (e) {
    console.warn('ambience: algorithmic reverb unavailable, staying on convolution', e);
    algoDead = true;
    return null;
  }
  algoFeed = outCtx.createGain();
  algoFeed.gain.value = 0;
  revIn.connect(algoFeed);
  algo.connect(wet);
  return algo;
}
function algoTune(tc) {
  if (!algo) return;
  const p = algo.parameters;
  glideParam(p.get('decay'), revDecay(), tc);
  glideParam(p.get('damping'), rev01(S.ambRevDamp ?? 0.35), tc);
  glideParam(p.get('mod'), rev01(S.ambRevMod ?? 0.3), tc);
}
export function applyAmbRevType() {
  if (!revIn) return;
  const toAlgo = wantAlgo() && !!algoNode();
  if (!toAlgo) convRoom();
  if (toAlgo === revAlgoNow) return;
  revAlgoNow = toAlgo;
  const on = toAlgo ? algoFeed : convFeed, off = toAlgo ? convFeed : algoFeed;
  // the incoming reverb catches up on any decay it missed while idle
  if (toAlgo) algoTune(0.02); else swapRoom(room);
  clearTimeout(revUnplug);
  on.connect(toAlgo ? algo : room.input);
  glideParam(on.gain, 1, 0.05);
  glideParam(off.gain, 0, 0.05);
  // after the old tail has rung out, and after a transition's line has
  // carried its feed down, if one is running
  const ctx = getContext(), end = glideEnd();
  const wait = (end ? Math.max(0, end - ctx.currentTime) : 0) + S.ambRevTime + 1.5 + lateBy(outCtx);
  revUnplug = setTimeout(() => {
    revUnplug = null;
    try { off.disconnect(); } catch (e) {}
  }, wait * 1000);
}
// The algorithmic reverb's own two: its damping and its drift.
export function applyAmbRevShape() {
  algoTune(0.05);
}

// A voice is a looping source with its own gain, so two can overlap during a
// crossfade without either knowing about the other.
//
// On Heart, the start at currentTime and the fade in anchored there are
// both late by the render's lookahead, and both are moved on by the same
// amount (js/heart/nodes.js, late gestures), so the voice still begins
// exactly where its fade does, a lookahead later than natively.
function voice(buffer, level, fade) {
  const ctx = outCtx;
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
  // stopped once it is silent, however long a transition made the fade. On
  // Heart the fade is heard up to about 0.13 s later than it was written
  // (nodes.js, late gestures), which both margins here leave room for.
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

// Moves every glide's shown level along to now, so faders follow a fade
// with the drift off too (the drift's tick does this while it runs). Costs
// nothing when no glide is running.
export function advanceAmbGlides() {
  if (!glides.size) return;
  const ctx = getContext();
  if (!ctx) return;
  for (const layer of Array.from(glides.keys())) advanceGlide(layer, ctx.currentTime);
}

// A hand on the drift: fades one recording in to its max, or, if it is up
// or already on its way up, back out to silence, over the drift's own
// crossfade time. Where a fade is heading counts, not only where it is, so
// a second click mid-fade turns it round. Returns the fade's length.
export function toggleAmbLayerFade(layer) {
  if (!layer) return 0;
  const ctx = getContext();
  if (ctx) advanceGlide(layer, ctx.currentTime);
  const g = glides.get(layer);
  const heading = g ? g.to : layer.level;
  const sec = driftFadeS();
  glideAmbLayer(layer, heading > 1e-4 ? 0 : peakOf(layer), sec);
  return sec;
}

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
  // Heart's analyser sends back its peak, not the waveform (js/heart/nodes.js
  // HeartAnalyser); a native one has no peak() and is scanned as always.
  if (v.meter.peak) return v.meter.peak();
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
