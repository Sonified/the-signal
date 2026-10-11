// The word layer's scheduling, ported from v0/js/text.js with the DOM taken out
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
// Inside a broadcast room the choosing changes hands once more: the shared
// walk (its own section below) deals every word from the room's name and the
// room's clock, so every screen in the room lands on the same word at the
// same moment with nothing sent between them. Outside a room none of that
// runs and the words stay this screen's own dice rolls.
//
// v0 also carried an ink-centring hack: it measured a word's drawn pixels on a
// scratch canvas because centring an element by its CSS box left a couple of
// pixels of visual bias, which matters in the one place on screen a word sits
// dead centre in a ring of rings. The SDF text system in v1 gives every glyph
// an exact measured advance, so centring by the true advance box already
// lands the word correctly and the hack is dropped entirely.

import { S } from '../js/state.js';

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
// The word on screen's own times, from its life (wordLife, below), never
// from the sliders: the sliders are the next word's.
export function fadeInMs()  { return wordLife.fin; }
export function fadeOutMs() { return wordLife.fout; }
function dwellMs() { return wordLife.hold; }
// The variance is a per-word roll, not an oscillation: the set duration is
// the cap, and each word's fade lands anywhere from (1 - variance) of it up
// to the full value.
function fadeRoll(v) { return 1 - (v || 0) * Math.random(); }

export const wordState = {
  text: '',
  nextText: '',   // picked one word ahead, so the smoke recording (gpu/word-smoke.js) can prepare before it shows
  opacity: 0,
  peak: 0,
  phase: 1,
  progress: 1,
  age: 0,
  seed: 0,
  // this word's fade rolls, mirrored here for the broadcast (core/
  // broadcast.js sends them with the word, so a follower's fades match)
  fadeInMul: 1,
  fadeOutMul: 1,
  // the shared walk's step this word was dealt on, -1 for any other word
  // (the broadcast tags its word message with it, so a follower dealing the
  // same walk knows the word is one it already has)
  step: -1,
  // the words layer's first two-second rise, 0..1, already inside peak; kept
  // apart for Text > Panel (ui/screens/overlay.js), which has no peak of its own
  reveal: 0,
  color: new Float32Array(4),
  visible: false,
};
wordState.color.set(WHITE);

// ---------- the word's life ----------
// Everything about how a word comes and goes is fixed the moment it
// appears, here, and read from here until it has fully gone, its transition
// included: its fade in, time on screen and fade out (the Fade switches and
// this word's variance rolls already folded in), and its transition look
// each way, the effect, the lines' order and every dial the transitions
// (core/word-fx.js fxv) and the GPU dissolves (gpu/word-smoke.js,
// gpu/word-cloud.js) read. A change of settings, whether a preset, a
// journey's ramp, the performer, a drag or a broadcast's state, reaches the
// next word and never the one on screen.
//
// Read live, as they once were, a recall mid-word moved the finish line
// under the word. Shortened, the word was past its new end at once: its
// letters vanished with no fade while its smoke or cloud dissolve, barely
// begun, carried on as a tail still shaped like the word, and the next word
// arrived over it. Lengthened, a leaving word snapped back to holding, its
// crisp letters back on screen over its own smoke. A change of effect
// mid-transition did the same, the old effect's dissolve and the new one's
// letters both drawn. With the life fixed, the word on screen always ends
// exactly where it began meaning to, so its dissolve is done before the
// scheduler, which waits for the screen to clear, deals the next.
//
// Only the peak stays live: the opacity dip and the layer's first reveal
// shade the word without touching its clock.
//
// in and out are the Arrive and Leave copies of each dial (the Leave copy
// is S[name + 'Out']), a mirrored exit taking the arrival's, so a reader
// asks for one by name and side without knowing about the mirror. LOOK is
// every dial a transition reads; a new one joins the list.
const LOOK = [
  'textFxDist', 'textFxStagger', 'textFxTurb', 'textFxBlur', 'textFxEase', 'textFxWindDir',
  'textGatherSweep', 'textSmokeSpeed', 'textSmokeSoft', 'textSmokeLinger', 'textSmokeRadial',
  'textSmokeAccel', 'textSmokeEq', 'textSmokeSweep', 'textSmokeSweepSpeed'
];
export const wordLife = {
  fin: 0, hold: 0, fout: 0,          // ms, rolls and switches folded in
  fxIn: 'fade', fxOut: 'fade',       // the effect each way, the mirror resolved
  linesIn: false, linesOut: false,   // whether a block's lines move as one, each way
  linePause: 0,
  in: {}, out: {}
};

// The one capture, run by every way a word can appear (the pick, the walk,
// a relayed word, the performer's phrase), with that word's three rolls:
// fade in, fade out, time on screen. Writes in place; nothing allocates.
function bornWith(fi, fo, dw) {
  const L = wordLife;
  L.fin = S.textFadeInOn === false ? 0 : Math.max(0, S.textFadeInMs) * fi;
  L.hold = Math.max(0, S.textDwellMs) * dw;
  L.fout = S.textFadeOutOn === false ? 0 : Math.max(0, S.textFadeOutMs) * fo;
  const mirror = !!S.textFxMirror;
  L.fxIn = S.textFxIn;
  L.fxOut = mirror ? S.textFxIn : S.textFxOut;
  L.linesIn = !!S.textLinesTogether || !!S.textLinesTogetherIn;
  L.linesOut = !!S.textLinesTogether || !!S.textLinesTogetherOut;
  L.linePause = S.textLinePause;
  for (let i = 0; i < LOOK.length; i++) {
    const k = LOOK[i];
    L.in[k] = S[k];
    L.out[k] = mirror ? S[k] : S[k + 'Out'];
  }
  // mirrored for the broadcast (core/broadcast.js sends them with the word)
  wordState.fadeInMul = fi;
  wordState.fadeOutMul = fo;
}
bornWith(1, 1, 1);   // a full set of keys from the start, so the shape never changes

let words = [];       // [word, ...themeKeys] rows from js/words.js
let affirmations = []; // [phrase] rows, same shape so pick() reads either pool
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
let goneAt = -1;         // ms timestamp the last word finished leaving (-1: none yet), for the Phrase gap
// -1 is the ordinary repeating scheduler. A Journey sets this to the number
// of phrases in its step; each shown phrase consumes one, and zero leaves the
// scheduler silent until another step starts a sequence or the user changes
// the Text source.
let oneShotRemaining = -1;

// Whether the scheduler is the ordinary repeating one, rather than a
// Journey's one-shot sequence or the silence after it. The broadcast sends
// this with its state (core/broadcast.js), since a follower's walk must fall
// quiet exactly when the broadcaster's scheduler stops dealing on its own.
export function wordsRepeating() { return oneShotRemaining === -1; }

// The Phrase gap (Custom only): a set number of seconds between one phrase
// leaving and the next arriving, in place of the scheduler's roll and rests.
// -1 when it is on Auto, or the source is not Custom, and the roll runs.
function phraseGapMs() {
  return S.textMode === 'custom' && S.textPhraseGap >= 0 ? S.textPhraseGap * 1000 : -1;
}

// Listeners for the moment a word (or phrase) appears: the journey's piano
// trigger plays a gesture on it (core/journey.js). Fired once per word, on
// the tick it is chosen, never per frame; the list is read in place.
const appearCbs = [];
export function onWordAppear(fn) { appearCbs.push(fn); }

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
  Promise.all([
    import('../js/words.js'),
    // its absence degrades to an empty affirmations pool, never a crash
    import('../js/affirmations.js').catch(() => ({}))
  ]).then(([m, af]) => {
    words = m.WORDS || [];
    affirmations = (af.AFFIRMATIONS || []).map(a => [a]);
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
//
// The shared walk leans on this pool being built identically on every screen
// in a room: it indexes into it by position. It is, given the same settings.
// The word and affirmation tables are static arrays in a fixed order,
// filter() keeps that order, the theme test reads only which keys are on
// (never the order they were set in), and the Custom split is plain string
// work. What it cannot guarantee is the same table on both ends: a follower
// served a different build of js/words.js than the broadcaster would deal
// different words from the same positions.
export function rebuildWordPool() {
  // Affirmations are their own pool, whole phrases with no theme filter;
  // the themes only carve up the individual-words pool. Custom is the
  // viewer's own phrases (or a journey step's), typed as one line with a
  // '|' between them, each phrase a row of its own in the same shape.
  const on = S.textThemes;
  const prev = pool;
  pool = S.textMode === 'breath'
    ? []
    : S.textMode === 'custom'
    ? customRows(S.textCustomText)
    : S.textMode === 'affirmations'
    ? affirmations.slice()
    : (!on || !Object.keys(on).length)
    ? words.slice()
    : words.filter(row => {
        for (let i = 1; i < row.length; i++) if (on[row[i]]) return true;
        return false;
      });
  // A recall rebuilds the pool every time (core/presets.js replayLive),
  // whether or not it touched the Text source. When the rebuilt pool holds
  // the very same phrases in the same order the deal simply carries on: the
  // shuffle's place, the walk's cached step and the word already picked to
  // come next all still hold. That last matters most, since the smoke has
  // been recording that word's arrival (gpu/word-smoke.js), and a fresh pick
  // threw the recording away and sent the next word in as a plain fade.
  if (nextPick && samePhrases(prev, pool)) { oneShotRemaining = -1; return; }
  lastIdx = -1;
  order.length = 0;   // a fresh pool deals a fresh cycle
  walkEvalN = NaN;     // and the walk re-reads its word from the new pool
  walkOrderCycle = NaN;
  oneShotRemaining = -1;
  nextPick = pick();
  wordState.nextText = nextPick;
}

// Whether two pools deal the same phrases in the same positions. Runs only
// when the pool is rebuilt, never per frame.
function samePhrases(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0]) return false;
  return true;
}

// The Custom source's phrases, split on '|', trimmed, empties dropped. A '/'
// inside a phrase is a forced line break: its segments are trimmed, empties
// dropped, and joined by '\n', which the text layout (gpu/text-atlas.js's
// phrase) takes as a hard break before any wrapping of its own. So
// "Welcome to / this experience | Breathe in" is two phrases, the first on
// two lines. Runs only when the pool is rebuilt, never per frame.
function customRows(str) {
  const out = [];
  if (typeof str !== 'string') return out;
  const parts = str.split('|');
  for (let i = 0; i < parts.length; i++) {
    const segs = parts[i].split('/');
    let p = '';
    for (let j = 0; j < segs.length; j++) {
      const s = segs[j].replace(/\s+/g, ' ').trim();
      if (s) p = p ? p + '\n' + s : s;
    }
    if (p) out.push([p]);
  }
  return out;
}

export function poolSize() { return pool.length; }

// The walk is a shuffled cycle, not independent rolls: the whole pool is
// dealt in random order and consumed to the end before any word can come
// again: every word (or affirmation) appears exactly once per cycle. Each
// new deal is its own shuffle, and the seam is guarded so the first word
// of a cycle never repeats the last word of the one before.
let order = [];
let orderAt = 0;

// Custom phrases are the one exception: they were written as a sequence
// (often a journey step's script), so they are dealt in the order typed,
// every cycle, with no shuffle and no seam guard.
function reshuffle(avoid) {
  order.length = pool.length;
  for (let i = 0; i < pool.length; i++) order[i] = i;
  orderAt = 0;
  if (S.textMode === 'custom') return;
  for (let i = order.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  if (order.length > 1 && order[0] === avoid) {
    const k = 1 + ((Math.random() * (order.length - 1)) | 0);
    const t = order[0]; order[0] = order[k]; order[k] = t;
  }
  orderAt = 0;
}

function pick() {
  if (!pool.length) return '';
  if (orderAt >= order.length) reshuffle(lastIdx);
  lastIdx = order[orderAt++];
  return pool[lastIdx][0];
}

// One tick is one chance at a word. The deterministic slot accumulator crosses
// 1 exactly every 1/appearance ticks, dead regular; appearance variance blends
// that certainty toward an independent coin flip of the same long-run rate.
function fires() {
  // By frame: the slider is a chance per tick, so a faster strobe means more
  // words. By time: the words-per-minute dial is converted to the same
  // per-tick fraction against the live tick rate, so the pace holds at any
  // frequency; the accumulator and variance below treat both alike.
  let f;
  if (S.textAppearMode === 'time') {
    const tick = Math.max(0.1, S.textLinked ? S.effFreq : S.textRateHz);
    f = Math.min(1, (S.textAppearPerMin || 10) / 60 / tick);
  } else {
    f = S.textFreq;
  }
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

// A journey step (core/journey.js) wants its text on screen now rather than
// on the scheduler's next roll. Any rest is waived. A word already up starts
// leaving at once: it enters its fade-out at the opacity it already has, so
// nothing pops, and the next word shows the moment it is gone. With the words
// layer off or the session stopped the ask stands until the words run again.
// lastT is the words' own clock, the t of the latest stepWords, since a call
// can come from anywhere in the frame (the journey's step, the window's text
// field) and this module keeps no other time.
let forceNext = false, lastT = 0;
export function wordNow() {
  forceNext = true;
  restUntil = 0;
  cutShort();
}

// A Journey step's Custom text, from its first phrase through its last,
// exactly once. Re-entering the step deals the Custom pool from the start.
export function wordSequenceOnce() {
  oneShotRemaining = pool.length;
  order.length = 0;
  orderAt = 0;
  nextPick = oneShotRemaining > 0 ? pick() : '';
  wordState.nextText = nextPick;
  forceNext = oneShotRemaining > 0;
  restUntil = 0;
  goneAt = -1;
  cutShort();
}

// Moving to another Journey step cancels any phrases the previous step had
// not reached yet. A phrase already visible completes its own fade.
export function cancelWordSequenceOnce() {
  oneShotRemaining = 0;
  forceNext = false;
  nextPick = '';
  wordState.nextText = '';
}
// A word already up starts leaving at once: it enters its fade-out at the
// opacity it already has, so nothing pops. Shared by wordNow and the
// broadcast's remote word below.
function cutShort() {
  if (!showing) return;
  const fin = fadeInMs(), fout = fadeOutMs(), hold = dwellMs();
  const age = lastT - shownAt;
  if (age < fin + hold) {
    const o = age < fin ? (fin > 0 ? age / fin : 1) : 1;
    shownAt = lastT - (fin + hold + fout - o * fout);
  }
}

// ---------- following a broadcast's words ----------
// A follower shows the broadcaster's exact words: the first remote word to
// arrive (core/broadcast.js) switches this scheduler to remote, where it
// stops picking from its own pool and shows only what it is handed, each
// word with the broadcaster's own seed and fade rolls, so the transitions
// dissolve the same way on every screen. The fade and opacity machinery in
// stepWords runs unchanged; only the choosing is remote. setWordsRemote(
// false) hands the scheduler back when the broadcast ends or dies.
//
// k is the shared walk's step the broadcaster dealt the word on, or -1 for a
// word it chose any other way. The broadcast only hands one over with a step
// while this side's own walk is not yet running (its clock still settling);
// remembering the step then keeps the walk, once it starts, from dealing the
// same word a second time.
let remote = false;
const pendingRemote = { has: false, w: '', seed: 0, fi: 1, fo: 1, k: -1 };
export function setWordsRemote(on) {
  remote = !!on;
  if (!remote) pendingRemote.has = false;
}
export function remoteWord(w, seed, fi, fo, k) {
  if (typeof w !== 'string' || !w) return;
  remote = true;
  pendingRemote.w = w.slice(0, STEP_MAX_REMOTE);
  pendingRemote.seed = Number.isFinite(seed) ? seed : Math.random() * 1000;
  pendingRemote.fi = Number.isFinite(fi) && fi > 0 && fi <= 1 ? fi : 1;
  pendingRemote.fo = Number.isFinite(fo) && fo > 0 && fo <= 1 ? fo : 1;
  pendingRemote.k = Number.isFinite(k) && k >= 0 ? k : -1;
  pendingRemote.has = true;
  restUntil = 0;
  cutShort();
}
const STEP_MAX_REMOTE = 300;

// ---------- the performer's phrase ----------
// The live-performance menu (core/perform.js) fires one exact phrase now, a
// LOCAL one-shot: no pool, no roll, and the scheduler is never flipped to
// remote. Like wordNow, any rest is waived and the word already up starts
// leaving through its fade at once; like the Custom source, a '/' inside the
// phrase is a forced line break, the same transform customRows runs, so the
// text layout (gpu/text-atlas.js) takes the '\n' as a hard break. The phrase
// shows whatever the Text source is set to, since it never touches the pool,
// and once it has had its dwell and fade the ordinary scheduler carries on
// as though it had picked it.
const pendingLocal = { has: false, w: '' };
export function triggerPhrase(text) {
  if (typeof text !== 'string') return;
  const segs = text.slice(0, STEP_MAX_REMOTE).split('/');
  let w = '';
  for (let j = 0; j < segs.length; j++) {
    const s = segs[j].replace(/\s+/g, ' ').trim();
    if (s) w = w ? w + '\n' + s : s;
  }
  if (!w) return;
  pendingLocal.w = w;
  pendingLocal.has = true;
  restUntil = 0;
  cutShort();
}

// The performer's phrase goes up the moment the screen is clear, exactly as
// a picked word does: a fresh seed and fresh fade rolls of its own, and the
// appear listeners fire (the journey's piano, and the broadcast, which
// mirrors it to followers through that hook). nextPick is left alone: the
// scheduler's next word is still the next word.
function showLocal(t) {
  const p = pendingLocal;
  p.has = false;
  wdiag('performer phrase', p.w);
  current = p.w; shownAt = t; showing = true;
  bornWith(fadeRoll(S.textFadeInVar), fadeRoll(S.textFadeOutVar), fadeRoll(S.textDwellVar));
  wordState.text = p.w;
  wordState.visible = true;
  wordState.seed = Math.random() * 1000;
  wordState.step = -1;
  forceNext = false;
  for (let k = 0; k < appearCbs.length; k++) appearCbs[k](p.w);
}

// ---------- the breath ----------
// The Breath source has no pool and no roll: it follows the sun's breath
// (gpu/sun.js publishes S.effSunBreathIn, true while inhaling). Each time
// the breath turns, "inhaling" or "exhaling" goes up the Appearance delay
// later, through the performer's path above, so the word on screen leaves
// through its fade and the new one arrives with the usual fades and hold.
// Switched to mid-breath it waits for the next turn, so a word never lands
// partway through. With the Sun layer off there is no breath, and no word.
let breathWasIn = null;   // the breath's direction last frame, null before the first
let breathDueAt = -1;     // ms the pending word goes up, -1 none
let breathWord = '';
function breathTick(t) {
  const inh = S.effSunBreathIn;
  if (typeof inh !== 'boolean') { breathWasIn = null; breathDueAt = -1; return; }
  if (breathWasIn !== null && inh !== breathWasIn) {
    breathWord = inh ? 'inhaling' : 'exhaling';
    breathDueAt = t + Math.max(0, S.textBreathDelay || 0) * 1000;
    wordState.nextText = breathWord;
  }
  breathWasIn = inh;
  if (breathDueAt >= 0 && t >= breathDueAt) {
    breathDueAt = -1;
    triggerPhrase(breathWord);
    // the word after this one, for the smoke to record its arrival
    wordState.nextText = breathWord === 'inhaling' ? 'exhaling' : 'inhaling';
  }
}

// The remote word goes up the moment the screen is clear, as a forced local
// word does. No pool, no roll: the broadcaster's scheduler already decided.
function showRemote(t) {
  const p = pendingRemote;
  p.has = false;
  wdiag('remote (followed broadcast)', p.w);
  current = p.w; shownAt = t; showing = true;
  bornWith(p.fi, p.fo, 1);
  wordState.text = p.w;
  wordState.visible = true;
  wordState.seed = p.seed;
  wordState.step = p.k;
  if (p.k >= 0) walkShown = p.k;
  nextPick = '';
  wordState.nextText = '';
  forceNext = false;
  for (let k = 0; k < appearCbs.length; k++) appearCbs[k](p.w);
}

// Puts the next word up at t: the body of the tick loop's show, shared with
// the forced show above. Returns whether a word was there to show.
function showWord(t) {
  if (oneShotRemaining === 0) return false;
  const w = nextPick || pick();
  if (!w) return false;
  wdiag(forceNext ? 'forced (wordNow)' : oneShotRemaining > 0 ? 'journey one-shot' : 'roll', w);
  current = w; shownAt = t; showing = true;
  bornWith(fadeRoll(S.textFadeInVar), fadeRoll(S.textFadeOutVar), fadeRoll(S.textDwellVar));
  wordState.text = w;
  wordState.visible = true;
  wordState.seed = Math.random() * 1000;
  wordState.step = -1;
  if (oneShotRemaining > 0) {
    oneShotRemaining--;
    nextPick = oneShotRemaining > 0 ? pick() : '';
  } else nextPick = pick();
  wordState.nextText = nextPick;
  forceNext = false;
  for (let k = 0; k < appearCbs.length; k++) appearCbs[k](w);
  return true;
}

// ---------- the shared walk ----------
// Inside a broadcast room every screen, broadcaster and followers alike,
// deals the words itself, and they all deal the same ones at the same
// moments, forever, with no message between them: the broadcaster's socket
// can doze and the room can hibernate and the words carry on everywhere.
// Two things make that possible. The seed is the room's name, hashed, which
// both ends already know (the broadcaster's session room, the follower's
// ?follow= room). The clock is the room's own, the shared clock the phase
// beacons already run on: shared ms = this tab's rAF ms + the offset the time
// probes measured (core/broadcast.js hands it in). While dozing, each screen
// keeps the last offset it measured and drifts only by its own crystal,
// which at word cadence is nothing.
//
// Nothing here is a sequence. Shared time is cut into steps of stepMs
// counted from epoch zero, and everything about step n (its word, whether a
// rest silences it, where in the step it starts, its fade and dwell rolls,
// its dissolve seed) is a pure hash of the seed, n and a tag naming the
// quantity, so each quantity draws from its own independent stream. A screen
// joining mid-stream computes the step it is in and lands on the same word
// as everyone else without replaying anything. stepMs comes from the word
// settings, which ride the broadcast's snapshot, so once a follower has
// synced them both ends cut time at the same boundaries.
//
// Until the clock settles (no probe answered yet, the offset NaN) the walk
// stands aside and the scheduler behaves exactly as it does outside a room.
let walkRoom = '';        // '' outside a room: the walk never runs
let walkSeed = 0;
let walkClock = NaN;      // shared ms minus this tab's rAF ms
let walkShown = -1;       // the last step whose word went up here
// Which purpose each hash serves. Distinct constants, so each quantity is
// its own stream even for the same step.
const TAG_SHUFFLE = 0x5348, TAG_JITTER = 0x4a49, TAG_REST = 0x5245, TAG_REST_LEN = 0x524c;
const TAG_FADE_IN = 0x4649, TAG_FADE_OUT = 0x464f, TAG_DWELL = 0x4457, TAG_SEED = 0x5345;
const WALK_MIN_STEP_MS = 50;
// A rest is found by looking back over the steps that could still be
// silencing this one; the cap only matters for absurd settings (a
// minute-long rest at a very fast pace), where it shortens the rest.
const WALK_LOOKBACK_MAX = 512;

// splitmix32's finaliser: a small integer hash with full avalanche, all
// 32-bit integer maths, no allocation.
function mix32(x) {
  x = (x + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

// A uniform number in [0, 1) for (step or cycle n, index i, purpose tag).
// Step numbers pass 2^32 at short steps, so n is fed in as its low and high
// words; a double holds the integer exactly, and >>> 0 takes it modulo 2^32.
function walkU(n, i, tag) {
  let h = mix32(walkSeed ^ tag);
  h = mix32(h ^ (n >>> 0));
  h = mix32(h ^ (Math.floor(n / 4294967296) >>> 0));
  h = mix32(h ^ i);
  return h / 4294967296;
}

// FNV-1a over the room name, finished through mix32. Runs when the room
// changes, never per frame.
function roomSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return mix32(h >>> 0);
}

// The room this screen is in, or '' for none (core/broadcast.js decides:
// a broadcaster's first active session, a follower's followed room once the
// broadcaster says it is dealing). The same name again changes nothing, so
// the follower can say it on every state message.
export function setWordWalk(room) {
  const r = typeof room === 'string' ? room : '';
  if (r === walkRoom) return;
  walkRoom = r;
  walkSeed = r ? roomSeed(r) : 0;
  walkShown = -1;
  walkEvalN = NaN;
  walkOrderCycle = NaN;
}
export function setWordWalkClock(off) { walkClock = Number.isFinite(off) ? off : NaN; }
export function wordWalkRunning() { return walkRoom !== '' && walkClock === walkClock; }

// The Opacity var rate's standing offset, the word's own copy of what
// core/room-clock.js's retimeRoomPhase does for the visual layers' swings.
// While the walk runs, the opacity dip's phase is derived off the room's
// clock (stepWords), and epoch zero alone at a new period lands somewhere
// else in the cycle entirely. So the rate's set() (schema-visual.js) calls
// this first, with the period before the write and the one being written,
// in seconds, and it chooses S.textOpacityVarPeriodOff (0 to 1, saved and
// sent with the text settings) so the derived phase at this instant is the
// one the old period gave:
//
//   offNew = (shared / oldPeriod + offOld) - (shared / newPeriod), mod 1
//
// It lives here rather than in room-clock.js because the dip reads the
// walk's clock and the walk's gate, not the room clock's: the same offset
// value, but the walk decides when a room is running for the words, and
// the retime has to agree with the derivation on that. The shared ms is
// performance.now plus walkClock, the timeline the frame's rAF t is on, so
// the moment this derives at and the frames that follow read the one clock.
// A drag retimes on every step and the steps telescope. Outside a running
// walk it does nothing: the accumulator carries the dip there and never
// jumps. A follower's replay calls the rate's set() with the new rate
// already on S, so this sees no change and the offset stays as it arrived;
// a glide the broadcast hands a follower (perform.js perfFollowGlide) does
// step the rate here, and retiming each step keeps the follower's dip
// smooth through it, with the landing state then truing the offset to the
// broadcaster's.
export function retimeWordOpacity(S, oldPeriodS, newPeriodS) {
  if (oldPeriodS === newPeriodS) return;
  carryWordOpacity(S, 'textOpacityVarPeriodOff', oldPeriodS, S.textOpacityVarPeriodOff, newPeriodS);
}

// The same fold with the old pair named outright, the words' twin of
// room-clock.js's carryRoomPhase and shaped like it (offKey is always
// textOpacityVarPeriodOff), so a snapshot recall (core/presets.js
// recallSnapshot) can hand in the period and offset from before the recall
// wrote the preset's own over them. An unchanged period still writes, which
// puts back the offset the dip was running on in place of the preset's stale
// one. Outside a running walk it does nothing and the offset stays as loaded.
export function carryWordOpacity(S, offKey, oldPeriodS, oldOff, newPeriodS) {
  if (!wordWalkRunning()) return;
  if (!(oldPeriodS > 0) || !(newPeriodS > 0)) return;
  const ms = performance.now() + walkClock;
  const oldMs = oldPeriodS * 1000, newMs = newPeriodS * 1000;
  let o = (ms % oldMs) / oldMs + (typeof oldOff === 'number' && oldOff === oldOff ? oldOff : 0) - (ms % newMs) / newMs;
  o -= Math.floor(o);
  S[offKey] = o;
}

// ---- the plan: step length from the settings ----
// Recomputed every frame the walk runs, since a setting can move at any
// time; it is a dozen reads and some arithmetic.
//
// The local scheduler rolls a chance per tick and lets a word on screen hold
// its slot. With no variance that is dead regular: a word goes up on every
// firing tick that finds the screen clear, so words start every
// (floor(life / slot) + 1) slots, slot being the time between firing ticks.
// That is exactly this step length at Appearance variance 0. With variance
// the local wait after a word is a coin flip per tick, averaging one slot,
// so the steps stretch toward life + slot as the variance rises and each
// word starts at a hashed point inside its step's slack: the same long-run
// pace, spread evenly rather than geometrically, and never a word crossing
// into the next step.
//
// What cannot be reproduced: linked to the strobe, local ticks are the
// strobe's own cycle wraps, which drift with the frequency drift and glides
// and are quantised to each screen's refresh rate under frame lock, so no two
// screens wrap together. The walk times linked ticks from the set frequency
// (S.freq) instead, which is the drifting rate's average. Words land beside
// the pulse rather than on it.
let planStep = 0, planRandom = 0, planGap = false;
let planFin = 0, planHold = 0, planFout = 0;
function walkPlan() {
  planFin = S.textFadeInOn === false ? 0 : Math.max(0, S.textFadeInMs);
  planHold = Math.max(0, S.textDwellMs);
  planFout = S.textFadeOutOn === false ? 0 : Math.max(0, S.textFadeOutMs);
  const life = planFin + planHold + planFout;
  const gap = phraseGapMs();
  planGap = gap >= 0;
  if (planGap) {
    // the Phrase gap: each phrase the gap after the last one's full life
    planRandom = 0;
    planStep = Math.max(WALK_MIN_STEP_MS, life + gap);
  } else {
    const tick = Math.max(0.1, S.textLinked ? S.freq : S.textRateHz);
    const f = S.textAppearMode === 'time'
      ? Math.min(1, (S.textAppearPerMin || 10) / 60 / tick)
      : Math.min(1, S.textFreq);
    if (!(f > 0)) return false;
    const slot = 1000 / tick / f;
    const det = (Math.floor(life / slot) + 1) * slot;
    planRandom = Math.max(0, Math.min(1, S.textRandom || 0));
    planStep = Math.max(WALK_MIN_STEP_MS, det + planRandom * (life + slot - det));
  }
  return planStep > 0 && planStep < Infinity;
}

// ---- one step, as pure functions ----
// walkTiming(m) leaves step m's start (shared ms), life and rolls in these.
// The rolls are fadeRoll's shape: variance only shortens.
let tmStart = 0, tmLife = 0, tmFi = 1, tmFo = 1, tmDw = 1;
function walkTiming(m) {
  tmFi = 1 - (S.textFadeInVar || 0) * walkU(m, 0, TAG_FADE_IN);
  tmFo = 1 - (S.textFadeOutVar || 0) * walkU(m, 0, TAG_FADE_OUT);
  tmDw = 1 - (S.textDwellVar || 0) * walkU(m, 0, TAG_DWELL);
  tmLife = planFin * tmFi + planHold * tmDw + planFout * tmFo;
  tmStart = m * planStep + planRandom * walkU(m, 0, TAG_JITTER) * Math.max(0, planStep - tmLife);
}

// maybeRest, stateless: every step rolls the rest chance as though its word
// were leaving, and a rest that fires silences each later step starting
// before the word's end plus the rest's span. Step n is silent if any step
// that could still reach it rolled such a rest. One difference from local
// play: locally a rest is only rolled by a word that actually showed, so two
// rests never run back to back, whereas here a step silenced by one rest can
// roll another. At the default rest chance (4%) that is rare, and it would
// take replaying history to rule out.
function walkSilent(n, startN) {
  if (planGap || !(S.textRestFreq > 0)) return false;
  const restMax = Math.max(0.1, S.textRestSec || 0) * 1000;
  let k = Math.ceil((planFin + planHold + planFout + restMax) / planStep);
  if (k > WALK_LOOKBACK_MAX) k = WALK_LOOKBACK_MAX;
  for (let j = 1; j <= k; j++) {
    const m = n - j;
    if (walkU(m, 0, TAG_REST) >= S.textRestFreq) continue;
    walkTiming(m);
    const span = Math.max(0.1, S.textRestSec * (1 - (S.textRestVar || 0) * walkU(m, 0, TAG_REST_LEN))) * 1000;
    if (startN < tmStart + tmLife + span) return true;
  }
  return false;
}

// The word for step n. The local walk deals the whole pool in a fresh
// shuffle per cycle; here cycle c is steps c*N to c*N+N-1 and its shuffle is
// a Fisher-Yates driven by hashes of c, so any step's word is one lookup
// once its cycle is dealt, and a cycle is dealt once (on the step boundary
// that enters it), not per frame. The seam guard (a cycle never opens on the
// word the last one closed on) needs the previous cycle's last word, which
// Fisher-Yates fixes on its very first swap and never touches again, so it is
// one hash; the guard swaps positions 0 and 1 so that last slot stays
// untouched. A silent step still uses up its word, so a rest skips words
// rather than delaying them. Custom phrases keep their typed order, as they
// do locally, and a two-word pool simply alternates, which is what the seam
// guard forces locally too.
let walkOrder = new Int32Array(0);
let walkOrderCycle = NaN, walkOrderN = 0;
function walkIndex(n) {
  const N = pool.length;
  if (S.textMode === 'custom') return n % N;
  if (N === 1) return 0;
  if (N === 2) return (n + walkSeed) % 2;
  const c = Math.floor(n / N);
  if (c !== walkOrderCycle || N !== walkOrderN) {
    // grows only when the pool does, on a step boundary
    if (walkOrder.length < N) walkOrder = new Int32Array(N);
    for (let i = 0; i < N; i++) walkOrder[i] = i;
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(walkU(c, i, TAG_SHUFFLE) * (i + 1));
      const t = walkOrder[i]; walkOrder[i] = walkOrder[j]; walkOrder[j] = t;
    }
    const prevLast = Math.floor(walkU(c - 1, N - 1, TAG_SHUFFLE) * N);
    if (walkOrder[0] === prevLast) { walkOrder[0] = walkOrder[1]; walkOrder[1] = prevLast; }
    walkOrderCycle = c;
    walkOrderN = N;
  }
  return walkOrder[n - c * N];
}

// Everything about the current step, worked out once as the step begins (or
// when the step length, the plan's times or the pool changes), so the
// frame's own check is a few comparisons. The times are in the check because
// they are the step's life (walkEvalEnd here, and the word's own life once
// it is dealt): a fade moved without moving the step length must reach both,
// or the two would part.
let walkEvalN = NaN, walkEvalStepMs = 0, walkEvalStart = 0, walkEvalEnd = 0;
let walkEvalFi = 1, walkEvalFo = 1, walkEvalDw = 1, walkEvalSeed = 0;
let walkEvalText = '', walkEvalNext = '', walkEvalSilent = true;
let walkEvalFin = 0, walkEvalHold = 0, walkEvalFout = 0;
function walkEval(n) {
  walkEvalN = n;
  walkEvalStepMs = planStep;
  walkEvalFin = planFin; walkEvalHold = planHold; walkEvalFout = planFout;
  walkTiming(n);
  walkEvalStart = tmStart;
  walkEvalEnd = tmStart + tmLife;
  walkEvalFi = tmFi; walkEvalFo = tmFo; walkEvalDw = tmDw;
  walkEvalSeed = walkU(n, 0, TAG_SEED) * 1000;
  walkEvalText = pool.length ? pool[walkIndex(n)][0] : '';
  walkEvalNext = pool.length ? pool[walkIndex(n + 1)][0] : '';
  walkEvalSilent = walkSilent(n, walkEvalStart);
}

// The walk's turn this frame. A step's word goes up whenever the screen is
// clear during its life, not only at its first instant, and at its true age:
// a screen that arrives mid-word (a follower joining, or one coming clear of
// a relayed word or a performer's phrase) shows it exactly where every other
// screen has it, fade included. A word on screen is never cut for it; the
// step simply goes by, as a local word holds its slot.
// The walk joined afresh at this local ms: a change of the step length or
// the fade times re-maps the whole shared schedule (planStep divides an
// epoch clock, so the step index lands anywhere), and without a seam every
// re-map dealt a "new" word back-dated into the middle of its fade, one
// per notch of a dragged Dwell or Fade slider: words popping in, far too
// fast. So a re-map works like the session's start: the word up finishes
// the life it was born with, nothing back-dated goes up, and the walk joins
// at the first step that begins after the change, on every screen alike,
// since followers re-map on the same settings at the same moment.
let walkJoinAt = 0;

function walkTick(t) {
  if (!walkPlan()) return;
  const shared = t + walkClock;
  const n = Math.floor(shared / planStep);
  const remap = walkEvalStepMs !== 0 && (planStep !== walkEvalStepMs ||
      planFin !== walkEvalFin || planHold !== walkEvalHold || planFout !== walkEvalFout);
  if (remap) walkJoinAt = t;
  if (n !== walkEvalN || remap) walkEval(n);
  // The word the walk deals next, for the smoke to record its arrival
  // (gpu/word-smoke.js): this step's, if it has yet to go up, otherwise the
  // next step's. Kept current every frame rather than only as a word goes
  // up, so a recall that rebuilds the pool, or a step the screen was too
  // busy to take, never leaves the recording on a word the walk will not
  // show.
  wordState.nextText = n === walkShown || walkEvalSilent ? walkEvalNext : walkEvalText;
  if (showing || walkEvalSilent || !walkEvalText || n === walkShown) return;
  if (shared < walkEvalStart || shared >= walkEvalEnd) return;
  // the start's quiet: a step already under way when the experience started
  // (its fade began inside the quiet, or before this screen was live at
  // all) is passed over, and the walk joins at the first step after it
  if (startQuiet && t - (shared - walkEvalStart) < startQuiet) return;
  if (walkJoinAt && t - (shared - walkEvalStart) < walkJoinAt) return;
  wdiag('walk step', walkEvalText);
  current = walkEvalText; shownAt = t - (shared - walkEvalStart); showing = true;
  // The life is the step's own: the plan's times (walkPlan read them from
  // the settings this very frame) under the step's hashed rolls, so it is
  // the life walkTiming worked the step out with, and every screen holding
  // the same settings fixes the same one.
  bornWith(walkEvalFi, walkEvalFo, walkEvalDw);
  wordState.text = current;
  wordState.visible = true;
  wordState.seed = walkEvalSeed;
  wordState.step = n;
  wordState.nextText = walkEvalNext;
  walkShown = n;
  for (let k = 0; k < appearCbs.length; k++) appearCbs[k](current);
}

// A wake (core/wake.js): every due-time this scheduler keeps moves on by
// the time spent away, so a word mid-fade carries on from the same point, a
// rest keeps what it had left, and nothing that came due while away fires
// now. The one exception is a word inside a running shared walk: that is
// the room's time, which kept moving, so the word ages by it and the walk
// deals whatever step the room is on now (walkTick), at its true age.
// Everything else here counts ticks or dt, which a resume frame holds.
export function wordsResume(away) {
  if (!(away > 0)) return;
  if (showing && !wordWalkRunning()) shownAt += away;
  if (restUntil > lastT) restUntil += away;
  if (revealStart >= 0) revealStart += away;
  if (goneAt >= 0) goneAt += away;
  if (breathDueAt >= 0) breathDueAt += away;
}

// A session's first moments are quiet: no word for at least this long after
// the experience starts (play pressed, or the text layer switched on), so
// the scene opens clean and the first word arrives by the ordinary rolls
// (or, on the shared walk, with the first step that begins after the quiet)
// rather than always being there at once.
const START_QUIET_MS = 1000;
let startQuiet = 0;
let wasLive = false;
// ?worddiag=1 in the page's address: one console line as the session goes
// live and one each time a word goes up, naming the path that put it there
// and the seconds since the session started, so a word arriving at once on
// a real screen says which door it came through. Page mode only; one
// boolean test when off.
const WDIAG = (() => { try { return /[?&]worddiag=1(&|$)/.test(location.search); } catch (e) { return false; } })();
let liveAt = 0;
function wdiag(path, text) {
  if (WDIAG) console.log('[worddiag] ' + path + ' at ' + ((lastT - liveAt) / 1000).toFixed(2) + 's: "' + String(text).slice(0, 40) + '"');
}

export function stepWords(t, dt) {
  lastT = t;
  if (!S.layers.text || !S.running) {
    if (showing || wordState.opacity > 0) hide();
    rateAcc = 0;
    goneAt = -1;   // a restart's first phrase comes on the next tick, not a gap after the last
    wasLive = false;
    breathWasIn = null; breathDueAt = -1;
    return;
  }
  if (!wasLive) {
    // the start's quiet second: the roll waits through a rest (which also
    // starts the deterministic slot afresh), and the walk holds below
    wasLive = true;
    liveAt = t;
    if (WDIAG) console.log('[worddiag] session live, quiet until +' + (START_QUIET_MS / 1000) + 's');
    startQuiet = t + START_QUIET_MS;
    schedPhase = 0;
    if (restUntil < startQuiet) restUntil = startQuiet;
  }

  // A rest stops the roll entirely rather than suppressing its result, so the
  // deterministic slot picks up where it left off instead of firing the
  // instant the pause ends.
  if (revealStart < 0) revealStart = t;

  // The Phrase gap is read outside the branches: the leave logic further
  // down (maybeRest) checks it whichever way the word was chosen.
  const gap = phraseGapMs();
  // The Breath source deals here, ahead of the performer's phrase it rides
  // on; following a broadcast, the broadcaster's breath words arrive relayed.
  const breathing = S.textMode === 'breath';
  if (breathing && !remote) breathTick(t);
  else { breathWasIn = null; breathDueAt = -1; }
  // The performer's phrase, ahead of the pool pick and outside the remote
  // switch: it shows the moment the screen is clear, no rest in between,
  // whichever way this scheduler is running.
  if (pendingLocal.has && !showing) { restUntil = 0; showLocal(t); }
  if (remote) {
    // Following a broadcast: the choosing is the broadcaster's. The word it
    // sent goes up the moment the screen is clear; no roll, no rests. A
    // relayed word always wins: it is the broadcaster choosing live (a
    // performer's phrase, a Journey's), and it cuts the walk's word short on
    // arrival (remoteWord). With none waiting, the shared walk deals the
    // same words the broadcaster's own walk does, which is what carries the
    // words on while the broadcaster's socket dozes.
    if (pendingRemote.has && !showing) showRemote(t);
    else if (wordWalkRunning()) walkTick(t);
  } else if (breathing) {
    // Breath: breathTick above is the whole scheduler; no roll, no walk.
  } else if (wordWalkRunning() && oneShotRemaining === -1 && !forceNext) {
    // Broadcasting: the shared walk takes the place of the roll, so this
    // screen deals exactly what its followers deal. A Journey's one-shot
    // sequence, and a wordNow, still run through the ordinary path below
    // and reach followers as relayed words. A broadcaster with several
    // sessions active at once shows its first session's walk; its other
    // rooms' followers share their own room's walk among themselves, but
    // cannot match this screen, which can show only one word at a time.
    walkTick(t);
  } else {
    // A word asked for by wordNow shows on the first tick the screen is clear,
    // whatever the roll would have said: the word it cut short has finished
    // leaving (or there was none), and no rest is taken in between.
    if (forceNext && !showing) { restUntil = 0; showWord(t); }
    const resting = t < restUntil;

    // Tick source. Linked to the strobe by default, so words land on the pulse
    // rather than beside it; otherwise a free-running rate of its own.
    let ticks = 0;
    if (S.textLinked) {
      // The cycle just wrapped: the phase came round past 1. A phase that
      // went back instead is a pin, not a wrap (core/strobe.js: frame lock
      // picking the counter up from the signal on a start or a wake, a
      // follower's snap onto the broadcaster), and it reads the same as a
      // wrap from the two numbers alone. So the way round from the last
      // phase must be about what the strobe's rate covers in this frame;
      // twice that plus a quarter cycle allows for a rate on the move and
      // frame lock carrying the phase across a change of count. That turns
      // a step back away at any rate where one stray tick would show; only
      // a strobe so fast that a frame covers most of a cycle could still
      // let one through, and there one chance more among dozens a second is
      // nothing.
      if (S.phase < S.lastPhase &&
          S.phase + 1 - S.lastPhase <= 2 * (S.achievedFreq || S.effFreq) * dt + 0.25) ticks = 1;
    } else {
      rateAcc += dt * S.textRateHz;
      while (rateAcc >= 1) { rateAcc -= 1; ticks++; }
      if (ticks > 4) ticks = 4; // a long stall is not a burst
    }

    // With a Phrase gap set, the roll and the rests are out of it: the next
    // phrase arrives exactly the gap after the last one finished leaving (at
    // 0, the frame after it has gone), and the first, with none gone before
    // it, on the next tick. On Auto the roll decides, as it always has.
    if (gap >= 0) {
      if (!showing && (goneAt < 0 ? ticks > 0 : t - goneAt >= gap)) showWord(t);
    } else {
      for (let i = 0; i < ticks && !resting; i++) {
        const want = fires();
        // A word still on screen holds its slot. The next one waits for a later
        // tick rather than cutting this one short, so nothing ever half-appears.
        if (want && !showing) showWord(t);
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
  // In a room the dip's phase is read off the shared clock instead of
  // accumulated, so every screen's word dims together: the shared ms over
  // the period plus the rate's standing offset, which a change of rate is
  // folded into (retimeWordOpacity, with the walk above) so the dip carries on from where
  // it is rather than jumping to where the new period alone would put it.
  if (S.textOpacityVarPeriod > 0) {
    if (wordWalkRunning()) {
      const pMs = S.textOpacityVarPeriod * 1000;
      S.textOpacityPhase = ((t + walkClock) % pMs) / pMs + (S.textOpacityVarPeriodOff || 0);
    } else {
      S.textOpacityPhase += dt / S.textOpacityVarPeriod;
    }
    S.textOpacityPhase -= Math.floor(S.textOpacityPhase);
  }
  const opDip = 0.5 * (1 - Math.cos(2 * Math.PI * S.textOpacityPhase));
  const reveal = revealStart < 0 ? 0 : Math.min(1, (t - revealStart) / REVEAL_MS);
  const peak = S.textOpacity * (1 - S.textOpacityVar * opDip) * reveal;

  // The two times add rather than compete: fade up, hold for the set time,
  // fade back down. Folding the fades inside the hold would mean a 1s fade
  // could never happen at a 100ms hold, the opposite of what the sliders say.
  const hold = dwellMs();
  const fin = fadeInMs();
  const fout = fadeOutMs();
  const total = fin + hold + fout;
  const age = t - shownAt;

  let o;
  // A word leaving because wordNow cut it short takes no rest after it: the
  // word asked for is next, on the following tick. Nor does one under a
  // Phrase gap, which counts from the moment the word was due to be gone
  // rather than the frame that noticed, so the gap holds at any frame rate.
  if (age >= total) { goneAt = shownAt + total; hide(); if (!forceNext && gap < 0) maybeRest(t); return; }
  else if (age < fin) { o = fin > 0 ? age / fin : 1; wordState.phase = 0; wordState.progress = o; }
  else if (age > fin + hold) {
    o = fout > 0 ? (total - age) / fout : 1;
    wordState.phase = 2; wordState.progress = 1 - o;
  }
  else { o = 1; wordState.phase = 1; wordState.progress = 1; }

  wordState.age = age;
  wordState.peak = peak;
  wordState.reveal = reveal;
  wordState.opacity = o * peak;
}
