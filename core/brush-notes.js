// Brush notes, the pure half: every drawing hand is a small bell, and the
// field is five horizontal bands with a note of that hand's own on each of
// the four lines between them. When a stroke's path crosses a line the
// hand rings that line's note, as a bell, a note or both (js/brush-bells.js
// sounds it; core/brush.js watches the strokes). Starting a stroke rings
// nothing: a sweep from the bottom to the top crosses all four lines and
// plays the hand's four notes.
//
// The scale: major scale degrees 1 2 3 5 7 8 9 10 12 14 15, one shape
// (1, 2, 3, 5, 7) over two octaves and the double octave's root, eleven
// pitches from ROOT_HZ. The root is the music's own, two octaves above the
// piano's sounding root (js/piano.js ARP_ROOT_HZ, 79.5 Hz, the 40 Hz
// carrier's family), and the degree set is the music's (semitones 0 2 4 7
// 11 in every octave), so every brush note lands on the show's scale
// rather than beside it. Each hand is dealt four of
// the eleven, ascending, one for each line from the bottom up, and a bell
// of its own (a whole number FM ratio, so it rings in tune, and its index
// and decay jittered about one bell patch),
// both seeded from the hand's room identity (its sticky id, the
// broadcaster's own for the broadcasting screen), so every screen rings the
// same bell at the same notes for the same person, through a reconnect.
// Hands may share notes; some will.
//
// The bands are read off the wire's unit square (v down, 0 to 1, over the
// field's centred square), so every screen agrees: band 0 the bottom fifth,
// band 4 the top, line k between bands k and k + 1 (line 0 the lowest
// note). A line is crossed once: a path must go HYST past it before it
// counts as across, so a hand resting on a line does not ring it over and
// over.

export const ROOT_HZ = 318;          // 79.5 Hz x 4: the music's root, in the old C4 register
export const DEGREES = [1, 2, 3, 5, 7, 8, 9, 10, 12, 14, 15];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const BANDS = 5, LINES = BANDS - 1, HYST = 0.02;

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

// The hand's four degrees, ascending, one per line: four of the eleven, by
// its seed.
export function notesFor(seed) {
  const r = rng(seed ^ 0x5bd1e995);
  const pool = DEGREES.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return pool.slice(0, LINES).sort((a, b) => a - b);
}

// The hand's bell: an FM pair about a bell patch, each a little its own. The
// ratio is a whole number (2, 3 or 4), so every partial is a harmonic of the
// note and the bell rings in tune, as a glockenspiel's bar does rather than
// a church bell's; a bright index that falls away fast, a decay near two
// seconds, no detune.
const RATIOS = [2, 3, 4];
export function bellFor(seed) {
  const r = rng(seed ^ 0x27d4eb2f);
  return {
    ratio: RATIOS[Math.floor(r() * RATIOS.length)],
    index: 1.2 + 1.2 * r(),
    decay: 1.4 + 1.0 * r(),
    modDecay: 0.15 + 0.2 * r()
  };
}

// The shape of the strike's carrier (schema-brush brushWave, js/brush-bells.js
// fmPair). Sine is the voice as it always was; the other three give the same
// FM pair a harder edge before the modulation even speaks. Each shape carries
// a gain beside it, rough loudness matching between them, so a change of
// waveform is a change of colour rather than of level: the numbers are the
// sequencer's own (js/piano.js ARP_WAVE_GAIN), kept the same here so the two
// instruments agree about how loud a sawtooth is.
export const BRUSH_WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
export const BRUSH_WAVE_GAIN = { sine: 1, triangle: 0.85, sawtooth: 0.42, square: 0.34 };
// Whatever a record or a stale setting holds, read as one of the four; a
// name the table does not know is the default sine.
export const waveOf = v => (typeof v === 'string' && BRUSH_WAVE_GAIN[v] ? v : 'sine');

// A note's shape, new for every strike (rand is Math.random on the page):
// its whole length drawn between lo and hi seconds, in either order, and an
// ADSR cut to fit it. A quick attack (1 to 4 % of the length, 3 to 30 ms),
// a decay over 15 to 35 % to a sustain of 35 to 70 % of the peak, held,
// then a release over the last 25 to 45 %; attack, decay and release
// together never pass the length.
export function noteShape(lo, hi, rand) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const len = a + (b - a) * rand();
  const attack = Math.max(0.003, Math.min(0.03, len * (0.01 + 0.03 * rand())));
  const decay = len * (0.15 + 0.2 * rand());
  const sustain = 0.35 + 0.35 * rand();
  const release = len * (0.25 + 0.2 * rand());
  return { len, attack, decay, sustain, release };
}

// The band a point lies in (0 bottom .. 4 top), by v (0 top .. 1 bottom).
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
