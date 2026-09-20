// The ambience layer.
//
// One place at a time. It settles somewhere, stays a few minutes, then drifts
// to somewhere else over a long crossfade, because a sudden cut from a forest
// to an ocean is an edit and the whole point is that nothing here edits.
//
// Children are a separate element rather than part of a bed, and which
// recording is used depends on where you are: the beach crowd belongs on a
// shore, the playground belongs inland. They arrive quietly and in the
// background, the way you hear them in life before you notice them.
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

const canOpus = (() => {
  const a = new Audio();
  return a.canPlayType('audio/ogg; codecs=opus') !== ''
      || a.canPlayType('audio/webm; codecs=opus') !== '';
})();
const EXT = canOpus ? '.opus' : '.mp3';
const urlFor = w => (w.dir || 'audio/ambience/') + w.bed + EXT;
const kidUrl = k => 'audio/ambience/' + k + EXT;

const cache = new Map();
let out = null, running = false, current = null, kidVoice = null;
let dwellTimer = null, kidTimer = null;

async function buf(url) {
  if (cache.has(url)) return cache.get(url);
  const ctx = getContext();
  const b = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  cache.set(url, b);
  return b;
}

function ensureOut() {
  if (out) return out;
  const ctx = getContext(), master = getMaster();
  if (!ctx || !master) return null;
  out = ctx.createGain();
  out.gain.value = S.ambVol;
  out.connect(master);
  return out;
}
export function applyAmbVol() {
  if (out) out.gain.setTargetAtTime(S.ambVol, getContext().currentTime, 0.2);
}

// A voice is a looping source with its own gain, so two can overlap during a
// crossfade without either knowing about the other.
function voice(buffer, level, fade) {
  const ctx = getContext();
  const g = ctx.createGain();
  g.gain.value = 0;
  const s = ctx.createBufferSource();
  s.buffer = buffer; s.loop = true;
  s.connect(g); g.connect(ensureOut());
  s.start(ctx.currentTime, Math.random() * buffer.duration);   // never the same entry twice
  g.gain.setTargetAtTime(level, ctx.currentTime, fade / 3);
  return { s, g };
}
function fadeOut(v, fade) {
  if (!v) return;
  const ctx = getContext();
  v.g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
  setTimeout(() => { try { v.s.stop(); } catch (e) {} }, (fade + 2) * 1000);
}

async function goTo(world) {
  if (!running) return;
  const b = await buf(urlFor(world)).catch(() => null);
  if (!b || !running) return;
  const fade = S.ambXfade;
  const prev = current;
  current = { world, v: voice(b, 1, fade) };
  if (prev) fadeOut(prev.v, fade);
  scheduleKids();
}

// Children come and go on their own clock, always well under the bed.
function scheduleKids() {
  clearTimeout(kidTimer);
  if (kidVoice) { fadeOut(kidVoice, 14); kidVoice = null; }
  const w = current && current.world;
  if (!w || !w.kids || S.ambKids <= 0) return;
  const wait = (40 + Math.random() * 120) / Math.max(0.05, S.ambKids);
  kidTimer = setTimeout(async () => {
    if (!running || !current || current.world !== w) return;
    const b = await buf(kidUrl(w.kids)).catch(() => null);
    if (!b || !running) return;
    kidVoice = voice(b, S.ambKidLevel, 18);
    // they wander off again after a while, and the next arrival is re-rolled
    setTimeout(() => {
      if (kidVoice) { fadeOut(kidVoice, 20); kidVoice = null; }
      scheduleKids();
    }, (60 + Math.random() * 120) * 1000);
  }, wait * 1000);
}

function scheduleDrift() {
  clearTimeout(dwellTimer);
  const mins = S.ambDwell * (0.7 + Math.random() * 0.6);
  dwellTimer = setTimeout(() => {
    if (!running) return;
    const pool = WORLDS.filter(w => !current || w.id !== current.world.id);
    goTo(pool[(Math.random() * pool.length) | 0]);
    scheduleDrift();
  }, mins * 60 * 1000);
}

export async function ambienceOn() {
  const ctx = getContext();
  if (!ctx || running) return false;
  running = true;
  if (!ensureOut()) { running = false; return false; }
  const start = WORLDS[(Math.random() * WORLDS.length) | 0];
  await goTo(start);
  scheduleDrift();
  return true;
}
export function ambienceOff() {
  running = false;
  clearTimeout(dwellTimer); clearTimeout(kidTimer);
  if (current) { fadeOut(current.v, 4); current = null; }
  if (kidVoice) { fadeOut(kidVoice, 4); kidVoice = null; }
}
export const ambienceWhere = () => current ? current.world.id : null;
