// The word layer.
//
// Words blink in the centre the way a speed reader presents them: no motion, no
// tracking, the eye stays put and the word simply arrives. That is the point.
// Reading a moving word is a mind task; catching a word that is already there
// is not, and the whole layer exists to drop attention out of the head.
//
// It lives in the DOM rather than on the canvas. The renderer's hot loop is
// allocation-free on purpose, and measuring and filling text every frame would
// put string work straight back into it. One absolutely positioned element with
// an opacity write costs nothing by comparison, and the browser's own text
// rasteriser is sharper than anything worth writing here.
import { S } from './state.js';

let el = null;
let words = [];                 // [word, ...themeKeys] rows from words.js
let pool = [];                  // the rows currently allowed by the theme filter
export let THEMES = {};
export let loaded = false;

let current = '';
let shownAt = 0;                // ms timestamp this word appeared
let showing = false;
let lastOpacity = -1;
let lastShift = null;
let lastCol = '';

// Centring a line of text centres its ADVANCE box, not its ink. Letter spacing
// hangs a trailing gap off the last glyph, and the left and right side bearings
// of the first and last letters are rarely equal, so the visible word lands a
// couple of pixels off the mark and by a different amount for every word. That
// is small, but this word sits in the dead centre of a set of concentric rings,
// which is the one place on screen where a two pixel bias is legible.
//
// So the ink is measured rather than assumed: the word is drawn once to a
// scratch canvas in the same font, the lit columns are scanned for their true
// extent, and the element is nudged by whatever the difference turns out to be.
// It runs once per new word and is cached, never in the frame loop.
const inkCache = new Map();
let measCv = null, measCtx = null;

function inkOffset(word, size) {
  const key = word + '|' + size;
  const hit = inkCache.get(key);
  if (hit !== undefined) return hit;

  if (!measCv) {
    measCv = document.createElement('canvas');
    measCtx = measCv.getContext('2d', { willReadFrequently: true });
  }
  const cs = getComputedStyle(el);
  const w = Math.ceil(size * (word.length + 4)), h = Math.ceil(size * 2);
  if (measCv.width !== w || measCv.height !== h) { measCv.width = w; measCv.height = h; }

  measCtx.clearRect(0, 0, w, h);
  measCtx.letterSpacing = cs.letterSpacing;
  measCtx.font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`;
  measCtx.textAlign = 'center';
  measCtx.textBaseline = 'middle';
  measCtx.fillStyle = '#fff';
  measCtx.fillText(word, w / 2, h / 2);

  const d = measCtx.getImageData(0, 0, w, h).data;
  let lo = -1, hi = -1;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (d[((y * w + x) << 2) + 3] > 40) { if (lo < 0) lo = x; hi = x; break; }
    }
  }
  // (ink centre - box centre); the element moves by the negative of it
  const off = lo < 0 ? 0 : ((lo + hi) / 2) - w / 2;
  inkCache.set(key, off);
  return off;
}

// The canvas fades up over two seconds on the first start, but the words are a
// DOM layer above it, so that fade does not reach them. They get their own, of
// the same length, started from the first running frame. First start only:
// after that the space bar is an instant stop and start.
const REVEAL_MS = 2000;
let revealStart = -1;

let restUntil = 0;              // ms timestamp the current rest ends
let rateAcc = 0;                // own-rate tick accumulator, unlinked mode
let schedPhase = 0;             // deterministic slot accumulator
let lastIdx = -1;

export function initText(node) {
  el = node;
  // Dynamic so a large table never blocks first paint, and so a missing or
  // broken list degrades to "no words" instead of taking the whole app down.
  import('./words.js').then(m => {
    THEMES = m.THEMES || {};
    words  = m.WORDS  || [];
    loaded = true;
    rebuildPool();
    document.dispatchEvent(new CustomEvent('wordsloaded'));
  }).catch(err => {
    console.error('word list failed to load', err);
  });
}

// The theme filter is resolved once into a flat pool rather than tested per
// tick, so picking a word is a single random index no matter how many themes
// are switched off.
export function rebuildPool() {
  const on = S.textThemes;
  pool = (!on || !Object.keys(on).length)
    ? words.slice()
    : words.filter(row => {
        for (let i = 1; i < row.length; i++) if (on[row[i]]) return true;
        return false;
      });
  lastIdx = -1;
}

export function poolSize() { return pool.length; }

// Called when the word size changes: the ink offset scales with the font, so
// the word on screen needs re-measuring at the new size.
// The nudge is published as --ink rather than written straight to `transform`,
// because the stylesheet now also uses that property to centre the element and
// two owners of one property means whoever writes last wins.
export function recentreWord() {
  if (!el || !current) return;
  lastShift = -inkOffset(current, S.textSize);
  el.style.setProperty('--ink', lastShift.toFixed(2) + 'px');
}

function pick() {
  if (!pool.length) return '';
  if (pool.length === 1) return pool[0][0];
  let i = (Math.random() * pool.length) | 0;
  if (i === lastIdx) i = (i + 1) % pool.length;   // never the same word twice running
  lastIdx = i;
  return pool[i][0];
}

// One tick is one chance at a word. The deterministic slot accumulator crosses
// 1 exactly every 1/appearance ticks, so 50% is every other tick and 10% every
// tenth, dead regular. Appearance variance blends that certainty toward an
// independent coin flip of the same long-run rate, so 10% appearance at 100%
// variance is "about one tick in ten, but never predictable which", and the
// average spacing is the same at either end of the dial.
function fires() {
  const f = S.textFreq;
  if (f <= 0) return false;
  schedPhase += f;
  let det = 0;
  if (schedPhase >= 1) { schedPhase -= 1; det = 1; }
  const p = (1 - S.textRandom) * det + S.textRandom * f;
  return Math.random() < p;
}

function hide() {
  showing = false;
  if (lastOpacity !== 0) { el.style.opacity = '0'; lastOpacity = 0; }
}

// Rolled once per word, as the word leaves. Variance only ever shortens, the
// same way depth and brightness variance do: the slider is the longest a rest
// can be, and turning variance up spreads the actual pauses down from it. A
// control that could overshoot its own setting would make the dial a suggestion
// rather than a ceiling.
function maybeRest(t) {
  if (S.textRestFreq <= 0) return;
  if (Math.random() >= S.textRestFreq) return;
  const span = S.textRestSec * (1 - S.textRestVar * Math.random());
  restUntil = t + Math.max(0.1, span) * 1000;
}

export function updateText(t, dt) {
  if (!el) return;

  if (!S.layers.text || !S.running) {
    if (showing || lastOpacity > 0) hide();
    rateAcc = 0;
    return;
  }

  // A rest stops the roll entirely rather than just suppressing its result, so
  // the deterministic slot picks up where it left off instead of firing the
  // instant the pause ends.
  if (revealStart < 0) revealStart = t;
  const resting = t < restUntil;

  // Tick source. Linked to the strobe by default, so words land on the pulse
  // rather than beside it; otherwise a free-running rate of its own.
  let ticks = 0;
  if (S.textLinked) {
    if (S.phase < S.lastPhase) ticks = 1;          // the cycle just wrapped
  } else {
    rateAcc += dt * S.textRateHz;
    while (rateAcc >= 1) { rateAcc -= 1; ticks++; }
    if (ticks > 4) ticks = 4;                      // a long stall is not a burst
  }

  for (let i = 0; i < ticks && !resting; i++) {
    const want = fires();
    // A word still on screen holds its slot. The next one waits for a later
    // tick rather than cutting this one short, so nothing ever half-appears.
    if (want && !showing) {
      const w = pick();
      if (w) {
        current = w; shownAt = t; showing = true;
        el.textContent = w;
        const shift = -inkOffset(w, S.textSize);
        if (shift !== lastShift) {
          lastShift = shift;
          el.style.setProperty('--ink', shift.toFixed(2) + 'px');
        }
      }
    }
  }

  if (!showing) { if (lastOpacity !== 0) hide(); return; }

  // In system mode the word takes the strobe's own color, which is the single
  // hue the field and the whole tunnel are driven from. The per-element walk
  // gives every ring its own hue, so there is no one ring color to match; the
  // strobe hue is the thing they are all variations of. Only written when it
  // actually changes, and only while a word is up.
  if (S.textColorMode === 'system') {
    const c = 'rgb(' + (S.rgb[0]|0) + ',' + (S.rgb[1]|0) + ',' + (S.rgb[2]|0) + ')';
    if (c !== lastCol) { el.style.color = c; lastCol = c; }
  } else if (lastCol) {
    el.style.color = ''; lastCol = '';
  }

  // Peak opacity dips from the set value and back, the same shape every other
  // variance in the app uses, so a word never reads brighter than the slider.
  if (S.textOpacityVarPeriod > 0) {
    S.textOpacityPhase += dt / S.textOpacityVarPeriod;
    S.textOpacityPhase -= Math.floor(S.textOpacityPhase);
  }
  const opDip  = 0.5 * (1 - Math.cos(2*Math.PI*S.textOpacityPhase));
  const reveal = revealStart < 0 ? 0 : Math.min(1, (t - revealStart) / REVEAL_MS);
  const peak   = S.textOpacity * (1 - S.textOpacityVar * opDip) * reveal;

  // The two times add rather than compete: fade up, hold for the set time, fade
  // back down. Folding the fades inside the hold would mean a 1s fade could
  // never happen at a 100ms hold, which is the opposite of what the two sliders
  // say they do.
  const hold = Math.max(0, S.textDwellMs);
  const fin  = Math.max(0, S.textFadeInMs);
  const fout = Math.max(0, S.textFadeOutMs);
  const total = fin + hold + fout;
  const age  = t - shownAt;

  let o;
  if (age >= total)           { hide(); maybeRest(t); return; }
  else if (age < fin)         o = fin > 0 ? age / fin : 1;
  else if (age > fin + hold)  o = fout > 0 ? (total - age) / fout : 1;
  else                        o = 1;
  o *= peak;

  // written only on change: a style write that sets the same value still costs
  // a style recalc, and this runs on every frame
  if (Math.abs(o - lastOpacity) > 0.004) { el.style.opacity = o.toFixed(3); lastOpacity = o; }
}
