// Brush notes, the pure half: every drawing hand is a small bell, and the
// field is four horizontal bands, each a note of that hand's own. When a
// stroke's path enters a band the hand's bell rings at its note there
// (js/brush-bells.js sounds it; core/brush.js watches the strokes).
//
// The scale: major scale degrees 1 2 3 5 7 8 9 10 12 14 15, one shape
// (1, 2, 3, 5, 7) over two octaves and the double octave's root, eleven
// pitches from C4 (ROOT_HZ, constant for now). Each hand is dealt four of
// the eleven, ascending, one for each band from the bottom up, and a bell
// of its own (the FM ratio, index and decay jittered about one bell patch),
// both seeded from the hand's room identity (its sticky id, the
// broadcaster's own for the broadcasting screen), so every screen rings the
// same bell at the same notes for the same person, through a reconnect.
// Hands may share notes; some will.
//
// The bands are read off the wire's unit square (v down, 0 to 1, over the
// field's centred square), so every screen agrees: band 0 the bottom
// quarter (the lowest note), band 3 the top. A band is entered once: a path
// must go HYST past a boundary before it counts as across, so a hand
// resting on a line does not ring it over and over.

export const ROOT_HZ = 261.6256;     // C4
export const DEGREES = [1, 2, 3, 5, 7, 8, 9, 10, 12, 14, 15];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const BANDS = 4, HYST = 0.02;

// A major scale degree (1 the root, 8 its octave, 15 the double octave)
// in semitones above the root, and in Hz.
export function degreeSemis(d) {
  const k = d - 1, oct = Math.floor(k / 7);
  return MAJOR[k - oct * 7] + 12 * oct;
}
export function degreeHz(d) { return ROOT_HZ * Math.pow(2, degreeSemis(d) / 12); }

// A 32-bit seed from an identity (a number or a string), FNV-1a.
export function seedOf(id) {
  const s = String(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The hand's four degrees, ascending: four of the eleven, by its seed.
export function notesFor(seed) {
  const r = rng(seed ^ 0x5bd1e995);
  const pool = DEGREES.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return pool.slice(0, BANDS).sort((a, b) => a - b);
}

// The hand's bell: an FM pair about a bell patch (an inharmonic ratio near
// 3.5, a bright index that falls away fast, a decay near two seconds), each
// a little its own.
export function bellFor(seed) {
  const r = rng(seed ^ 0x27d4eb2f);
  return {
    ratio: 3.5 * (0.94 + 0.12 * r()),
    index: 2.2 + 1.6 * r(),
    decay: 1.4 + 1.0 * r(),
    modDecay: 0.18 + 0.2 * r(),
    detune: (r() - 0.5) * 8          // cents
  };
}

// The band a point lies in (0 bottom .. 3 top), by v (0 top .. 1 bottom).
export function bandAt(v) {
  const b = BANDS - 1 - Math.floor((v < 0 ? 0 : v >= 1 ? 0.999999 : v) * BANDS);
  return b;
}
// The band after a point, from the band the path was in (-1 at its start):
// a new band only once v is HYST past the boundary into it.
export function nextBand(cur, v) {
  const b = bandAt(v);
  if (cur < 0 || b === cur) return cur < 0 ? b : cur;
  // the boundary between cur and the next band toward b, in v
  const edge = b > cur ? (BANDS - cur - 1) / BANDS : (BANDS - cur) / BANDS;
  const past = b > cur ? edge - v : v - edge;
  return past >= HYST || Math.abs(b - cur) > 1 ? b : cur;
}
