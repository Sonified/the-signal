// The variance: one law, written once, that every breathing setting in the
// app obeys. A variance takes a setting (the strobe's depth, the edge's
// speed, the choir's level) and eases it down from where it is set by up to
// its amount's share and back, once every period, never above the setting:
//
//   effective = set * (1 - amount * ½(1 - cos 2πφ))
//
// φ is the variance's own phase, 0 to 1 round its cycle, stepped by the
// time that passes over the period. At φ = 0 the setting stands in full; at
// φ = ½ it sits at set * (1 - amount), the deepest the amount allows. An
// amount of 0 is the setting exactly, with no trig spent on it.
//
// That is all this file is: the law (dipDepth, varied), the phase's step
// (stepPhase), and the breath, which is the law run on a clock of the
// caller's with a second way of moving on offer (breath). It imports
// nothing, so the v0 audio modules in js/ can share it with v1 as they are.
// Each engine keeps its own clock: the strobe core steps its phases on the
// frame's motion step (core/strobe.js, one table of them), the choir on its
// 10 Hz wander timer, the strobe-AM stages and the sequencer on the audio
// clock, and the click's dip per sample inside the worklet (js/worklet.js,
// which can import nothing and keeps its own copy of the line above).
//
// The Behavior toggle some voices carry picks between two ways the depth of
// the dip can move. Sinusoid, the default, is the law above. Walk drifts one
// cosine leg at a time, from where the last leg ended to a fresh random
// depth anywhere from none to the amount, one period a leg, never twice the
// same. A new speed takes over mid-leg from wherever the walk is, rather
// than making a long leg run out first, and a lowered amount takes effect at
// once, never left below the new floor.
//
// ---------- the drawer's side: three tiers ----------
// The rows a variance shows in the drawer come from one factory,
// varianceRows(owner, opts) in core/schema-variance.js, spread straight after
// the owner's own row (the drawer folds them out from under it by its
// chevron). It makes the amount and the period, tags them to the owner,
// takes the owner's section, and lights the owner's bar with the value as it
// plays (the owner's `effective`), shown only while the amount is above 0.
//
//   Defaults, the ninety-percent case: a 0-100% amount, a 1-60 s rate read
//   as '22s / cycle', labels '<name> variance' and '<name> var rate', the
//   amount's key the owner's id plus Var and the period's that plus Period.
//
//     ...varianceRows('edgeSpeed', {
//       name: 'Edge speed', amountDef: 50, periodDef: 22,
//       effective: S => S.effEdgeSpeed
//     }),
//
//   Options, for a variance that differs in a named way: its own keys
//   (amount, period, or a function of S for keys that move with a mode),
//   periodMin/periodMax/periodDef, exact labels, the Music drawers' house
//   style (music: true, '... variance speed' read in plain seconds), an
//   engine hook run after every write (apply), an On switch ahead of the
//   rows (on: true), the walk/sinusoid Behavior segment (mode: true), a rate
//   folded into the room clock's phase offset (room: true, or retime for any
//   other offset), a write filter (fit), and placement (parent, visible,
//   enabled).
//
//   The escape hatch: rows: { amount, period, on, mode } merges any fields
//   over the row the factory made, and extras: [...] folds further rows in
//   under the same chevron. An owner that already has its own effective
//   keeps it.
//
// ---------- adding a variance ----------
// The confetti's feedback Opacity was the first added this way, and the
// whole of it is four places, a line or a few each:
//   the rows, after the owner's (core/schema-confetti.js),
//     ...varianceRows('confFbOpacity', {
//       name: 'Opacity', periodMax: 120, parent: 'confFeedbackDrawer', enabled: layerOn,
//       effective: S => (S.effConfFbOpacity ?? S.confFbOpacity) * 100
//     }),
//   the state, where the layer's other fields are seeded and saved (its NUM
//   table: confFbOpacityVar and confFbOpacityVarPeriod),
//   the engine, one row in core/strobe.js's VARIANCES, which steps the phase
//   each frame and writes S.effConfFbOpacity,
//   and the renderer, reading that effective in place of the dial.
// An audio variance runs breath() on its voice's clock instead, and if the
// worker must see it, adds a row to core/audio-mirror.js's READBACKS.

// The shortest leg a walk takes, and the shortest cycle either shape runs,
// in seconds: a period at or near 0 still moves, just no faster than this.
export const MIN_LEG = 0.5;

// How deep the dip is at phase φ, as a share of the setting: 0 at the top
// of the cycle, the whole amount half way round.
export function dipDepth(amount, phase) {
  return amount * 0.5 * (1 - Math.cos(2 * Math.PI * phase));
}

// The setting as the variance plays it at phase φ. An amount of 0 (or
// anything falsy) hands the setting straight back.
export function varied(set, amount, phase) {
  return amount ? set * (1 - dipDepth(amount, phase)) : set;
}

// What can drive a variance's dip, for the ones that choose (the rings'
// Speed and Opacity; the sun's own carry the same three): the variance's own
// clock (Time), the strobe's wave, or the sun's breath. An unknown or missing
// value is Time, the dip as it always was.
export const DRIVES = ['time', 'strobe', 'breath'];
export const driveOf = v => DRIVES.indexOf(v) >= 0 ? v : 'time';

// The setting as the variance plays it when a chosen driver leads. The law is
// the same for every driver, set * (1 - amount * (1 - d)), d from 0 (the
// driver at its bottom) to 1 (at its top, the setting in full): Time's d is
// the cosine, 0.5 + 0.5 cos 2πφ, which is varied() above to the letter (so
// Time calls it); the strobe's d is lum, its raw wave, 1 lit to 0 dark; the
// breath's is the sun's breath, 0 full exhale to 1 full inhale, and while no
// breath runs (the Sun layer off, so none is published) it is 1 and the
// setting holds. Either is clamped to 0..1, so the dip never goes above the
// setting.
export function variedBy(drive, set, amount, phase, lum, breathPos) {
  if (!amount || drive !== 'strobe' && drive !== 'breath') return varied(set, amount, phase);
  let d = drive === 'strobe' ? lum : breathPos;
  d = typeof d !== 'number' || d !== d ? 1 : d > 1 ? 1 : d < 0 ? 0 : d;
  return set * (1 - amount * (1 - d));
}

// A phase moved on by dt over the period, kept in 0 to 1.
export function stepPhase(phase, dt, period) {
  phase += dt / period;
  return phase - Math.floor(phase);
}

// ---------- the breath: the law on a clock, sinusoid or walk ----------
// One variance's running state: the sinusoid's phase and the clock time it
// was last stepped at (-1 before its first step), and the walk's current
// leg, from `from` to `to` (depths, 0 to the amount) over `dur` seconds
// from t0, laid with the setting `period`.
export function breathState() {
  return { phase: 0, at: -1, from: 0, to: 0, t0: 0, dur: MIN_LEG, period: -1 };
}

// Back to the top of the cycle, the setting in full, from now.
export function resetBreath(b, now) {
  b.phase = 0; b.at = now;
  b.from = 0; b.to = 0; b.t0 = now - MIN_LEG; b.dur = MIN_LEG; b.period = -1;
}

// The bottom of the cycle instead: the deepest dip the amount allows, from
// which a sinusoid rises over half a period and a walk drifts off toward its
// first random depth. With the amount at 0 it is resetBreath exactly.
export function resetBreathLow(b, now, amount) {
  b.phase = 0.5; b.at = now;
  b.from = amount; b.to = amount; b.t0 = now - MIN_LEG; b.dur = MIN_LEG; b.period = -1;
}

const ease01 = x => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));
const legAt = (b, now) => b.from + (b.to - b.from) * ease01((now - b.t0) / b.dur);

// The dip's depth now, 0 to the amount, for a variance whose clock reads
// `now` seconds: stepped from the last call by the time between, so the
// caller's own clock (and its holding still) is the variance's. period is
// the setting as read; one that is not a number reads as `fallback`, and
// either way no shorter than MIN_LEG. mode 'walk' walks; anything else
// breathes the sinusoid. An amount of 0 holds the state at the top of its
// cycle and returns 0. Multiply the setting by (1 - the depth).
export function breath(b, amount, period, now, mode, fallback = 0) {
  if (!(amount > 0)) { resetBreath(b, now); return 0; }
  const p = Math.max(MIN_LEG, +period || fallback);
  if (mode === 'walk') {
    if (b.period !== -1 && b.period !== period) {
      b.from = legAt(b, now); b.t0 = now; b.dur = p;
    }
    b.period = period;
    if (now - b.t0 >= b.dur) {
      b.from = b.to; b.to = Math.random() * amount; b.t0 = now; b.dur = p;
    }
    return Math.min(legAt(b, now), amount);
  }
  return dipDepth(amount, stepBreath(b, now, p));
}

// The sinusoid's phase alone, stepped on the caller's clock the way breath()
// steps it and held at the top of the cycle (0) while the amount is 0, for
// a swing that rides the same clock but not the dip: the sequencer's pan,
// which swings both ways about its setting on sin 2πφ.
export function breathPhase(b, amount, period, now, fallback = 0) {
  if (!(amount > 0)) { resetBreath(b, now); return 0; }
  return stepBreath(b, now, Math.max(MIN_LEG, +period || fallback));
}

function stepBreath(b, now, p) {
  if (!(b.at >= 0)) { b.phase = 0; b.at = now; }
  b.phase = stepPhase(b.phase, now - b.at, p);
  b.at = now;
  return b.phase;
}
