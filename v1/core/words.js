// The word layer's scheduling, ported from js/text.js with the DOM taken out
// from underneath it. v0 kept a live element and wrote its opacity and text
// content straight to the page; v1 has no element to write to, so this file
// only keeps score, once per frame, into wordState, and whatever draws the
// centre-screen word each frame reads it from there.
//
// The scheduling itself is unchanged: fires() rolls one chance per tick at
// showing a word, pick() never repeats the word that just left, maybeRest()
// occasionally stretches the gap between words, and the fade shape is fade in,
// hold, fade out, added rather than nested, exactly as v0 does it and for the
// same reason (a short hold should not eat the fade times).
//
// v0 also carried an ink-centring hack: it measured a word's drawn pixels on a
// scratch canvas because centring an element by its CSS box left a couple of
// pixels of visual bias, which matters in the one place on screen a word sits
// dead centre in a ring of rings. The SDF text system in v1 gives every glyph
// an exact measured advance, so centring by the true advance box already
// lands the word correctly and the hack is dropped entirely.

import { S } from '../../js/state.js';

// v0's white-mode ink for the word layer. Kept as its own constant rather than
// reached for out of theme.js, because it is specifically the value v0 shipped
// with and changing it is a design decision, not a porting one.
const WHITE = new Float32Array([242 / 255, 246 / 255, 251 / 255, 1]);

const REVEAL_MS = 2000;

// The one object this module hands outward. It is written into every frame,
// never replaced, so whatever draws the word can hold a reference to it once.
// opacity is the finished figure, fades included, for anything that wants the
// word as one number. The transitions (core/word-fx.js) want the parts
// instead: peak is the opacity with no fade applied, phase says which stretch
// of its life the word is in (0 arriving, 1 holding, 2 leaving), progress runs
// 0 to 1 across that stretch, age is ms since the word appeared, and seed is
// rolled once per word so each one scatters its own way.
// The Fade in and Fade out switches: off, the word just appears or goes,
// and the time slider keeps its value for when the switch comes back on.
export function fadeInMs()  { return S.textFadeInOn  === false ? 0 : Math.max(0, S.textFadeInMs); }
export function fadeOutMs() { return S.textFadeOutOn === false ? 0 : Math.max(0, S.textFadeOutMs); }

export const wordState = {
  text: '',
  nextText: '',   // picked one word ahead, so the smoke recording (gpu/word-smoke.js) can prepare before it shows
  opacity: 0,
  peak: 0,
  phase: 1,
  progress: 1,
  age: 0,
  seed: 0,
  color: new Float32Array(4),
  visible: false,
};
wordState.color.set(WHITE);

let words = [];       // [word, ...themeKeys] rows from js/words.js
let pool = [];         // rows currently allowed by S.textThemes
let loaded = false;
let loadedCbs = [];

let current = '';
let nextPick = '';
let shownAt = 0;
let showing = false;
let restUntil = 0;      // ms timestamp the current rest ends
let rateAcc = 0;         // own-rate tick accumulator, unlinked mode
let schedPhase = 0;      // deterministic slot accumulator
let lastIdx = -1;
let revealStart = -1;

// Registers a callback for when the word list finishes loading. If it has
// already loaded, the callback runs right away rather than being dropped;
// this stands in for v0's 'wordsloaded' CustomEvent, which had nothing to
// dispatch it on here.
export function onWordsLoaded(fn) {
  if (loaded) fn();
  else loadedCbs.push(fn);
}

// Dynamic for the same reason v0 kept it dynamic: a large word table should
// never hold up first paint, and a missing or broken list should degrade to
// "no words" rather than take the app down with it.
export function initWords() {
  import('../../js/words.js').then(m => {
    words = m.WORDS || [];
    loaded = true;
    rebuildWordPool();
    const cbs = loadedCbs;
    loadedCbs = [];
    for (let i = 0; i < cbs.length; i++) cbs[i]();
  }).catch(err => {
    console.error('word list failed to load', err);
  });
}

// The theme filter is resolved once into a flat pool rather than tested per
// tick, so picking a word stays a single random index no matter how many
// themes happen to be switched off.
export function rebuildWordPool() {
  const on = S.textThemes;
  pool = (!on || !Object.keys(on).length)
    ? words.slice()
    : words.filter(row => {
        for (let i = 1; i < row.length; i++) if (on[row[i]]) return true;
        return false;
      });
  lastIdx = -1;
  nextPick = pick();
  wordState.nextText = nextPick;
}

export function poolSize() { return pool.length; }

function pick() {
  if (!pool.length) return '';
  if (pool.length === 1) return pool[0][0];
  let i = (Math.random() * pool.length) | 0;
  if (i === lastIdx) i = (i + 1) % pool.length; // never the same word twice running
  lastIdx = i;
  return pool[i][0];
}

// One tick is one chance at a word. The deterministic slot accumulator crosses
// 1 exactly every 1/appearance ticks, dead regular; appearance variance blends
// that certainty toward an independent coin flip of the same long-run rate.
function fires() {
  const f = S.textFreq;
  if (f <= 0) return false;
  schedPhase += f;
  let det = 0;
  if (schedPhase >= 1) { schedPhase -= 1; det = 1; }
  const p = (1 - S.textRandom) * det + S.textRandom * f;
  return Math.random() < p;
}

// Rolled once per word, as the word leaves. Variance only ever shortens the
// rest, never lengthens it past the slider, the same shape every other
// variance control in the app uses.
function maybeRest(t) {
  if (S.textRestFreq <= 0) return;
  if (Math.random() >= S.textRestFreq) return;
  const span = S.textRestSec * (1 - S.textRestVar * Math.random());
  restUntil = t + Math.max(0.1, span) * 1000;
}

function hide() {
  showing = false;
  wordState.visible = false;
  wordState.opacity = 0;
  wordState.peak = 0;
}

export function stepWords(t, dt) {
  if (!S.layers.text || !S.running) {
    if (showing || wordState.opacity > 0) hide();
    rateAcc = 0;
    return;
  }

  // A rest stops the roll entirely rather than suppressing its result, so the
  // deterministic slot picks up where it left off instead of firing the
  // instant the pause ends.
  if (revealStart < 0) revealStart = t;
  const resting = t < restUntil;

  // Tick source. Linked to the strobe by default, so words land on the pulse
  // rather than beside it; otherwise a free-running rate of its own.
  let ticks = 0;
  if (S.textLinked) {
    if (S.phase < S.lastPhase) ticks = 1; // the cycle just wrapped
  } else {
    rateAcc += dt * S.textRateHz;
    while (rateAcc >= 1) { rateAcc -= 1; ticks++; }
    if (ticks > 4) ticks = 4; // a long stall is not a burst
  }

  for (let i = 0; i < ticks && !resting; i++) {
    const want = fires();
    // A word still on screen holds its slot. The next one waits for a later
    // tick rather than cutting this one short, so nothing ever half-appears.
    if (want && !showing) {
      const w = nextPick || pick();
      if (w) {
        current = w; shownAt = t; showing = true;
        wordState.text = w;
        wordState.visible = true;
        wordState.seed = Math.random() * 1000;
        nextPick = pick();
        wordState.nextText = nextPick;
      }
    }
  }

  if (!showing) { if (wordState.opacity !== 0) hide(); return; }

  // In system mode the word takes the strobe's own colour, the single hue the
  // field and the whole tunnel are driven from. There is no one ring colour to
  // match under the per-element walk; the strobe hue is the thing they are all
  // variations of.
  // Brighten slides that colour toward white, 0 the strobe's own, 1 white.
  if (S.textColorMode === 'system') {
    const b = Math.max(0, Math.min(1, S.textBrighten || 0));
    wordState.color[0] = S.rgb[0] / 255 + (1 - S.rgb[0] / 255) * b;
    wordState.color[1] = S.rgb[1] / 255 + (1 - S.rgb[1] / 255) * b;
    wordState.color[2] = S.rgb[2] / 255 + (1 - S.rgb[2] / 255) * b;
    wordState.color[3] = 1;
  } else {
    wordState.color.set(WHITE);
  }

  // Peak opacity dips from the set value and back, the same shape every other
  // variance in the app uses, so a word never reads brighter than the slider.
  if (S.textOpacityVarPeriod > 0) {
    S.textOpacityPhase += dt / S.textOpacityVarPeriod;
    S.textOpacityPhase -= Math.floor(S.textOpacityPhase);
  }
  const opDip = 0.5 * (1 - Math.cos(2 * Math.PI * S.textOpacityPhase));
  const reveal = revealStart < 0 ? 0 : Math.min(1, (t - revealStart) / REVEAL_MS);
  const peak = S.textOpacity * (1 - S.textOpacityVar * opDip) * reveal;

  // The two times add rather than compete: fade up, hold for the set time,
  // fade back down. Folding the fades inside the hold would mean a 1s fade
  // could never happen at a 100ms hold, the opposite of what the sliders say.
  const hold = Math.max(0, S.textDwellMs);
  const fin = fadeInMs();
  const fout = fadeOutMs();
  const total = fin + hold + fout;
  const age = t - shownAt;

  let o;
  if (age >= total) { hide(); maybeRest(t); return; }
  else if (age < fin) { o = fin > 0 ? age / fin : 1; wordState.phase = 0; wordState.progress = o; }
  else if (age > fin + hold) {
    o = fout > 0 ? (total - age) / fout : 1;
    wordState.phase = 2; wordState.progress = 1 - o;
  }
  else { o = 1; wordState.phase = 1; wordState.progress = 1; }

  wordState.age = age;
  wordState.peak = peak;
  wordState.opacity = o * peak;
}
