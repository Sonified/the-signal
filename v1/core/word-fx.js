// How the centre word arrives and leaves.
//
// The word is still while it can be read. Everything here happens inside the
// fade in and fade out times: the letters condense out of the air, land, hold
// perfectly still for the time on screen, then let go. The layer exists so the
// eye can catch a word without chasing it, and a word that moved while it was
// legible would undo that.
//
// Each letter is worked out on its own. Its position in the word gives it an
// order, stagger spreads those orders across the transition so the letters
// arrive one after another rather than all at once, and the eased result is a
// single dissolve amount d: 0 is the letter in place, 1 is the letter gone.
// Every effect is just a mapping from d to an offset, scale, rotation, opacity
// and softness, so a new effect is one more case in letterFx().
//
// Arriving eases out (fast gather, slow landing) and leaving eases in (a slow
// release that picks up speed), the shape of a cloud forming and dispersing.
//
// Softness blurs the letter by widening the edge of its distance field, which
// the SDF range caps at a few pixels, so Blur also lays a larger, fainter,
// fully blurred copy underneath each moving letter. That ghost is what reads
// as haze.
//
// Cloud hands the whole word to the GPU (gpu/word-cloud.js): a density
// field of smoke and per-pixel ink that exchange material through one
// formation mask, so strokes condense out of the mist and erode back into
// it. The letters here go invisible for the transition (the smoke system
// draws the ink), and drawWord's records give that system the quads and
// atlas cells to draw it from.
//
// Nothing here allocates: letterFx writes into the caller's scratch array and
// reads everything else from S and wordState.

import { S } from '../../js/state.js';
import { wordState } from './words.js';

export const FX_NAMES = { fade: 'Fade', gather: 'Gather', wind: 'Wind', cloud: 'Cloud', smoke: 'Smoke' };

// Arrive and Leave each have their own copy of the transition settings, the
// Leave copy under the same name plus 'Out'. A mirrored exit leaves the way
// it came, so it reads the arrival's.
// Whether a multi-line block's lines move as one rather than one after
// another: Fade lines together does it both ways; the Fade out block's own
// switch does it for departures alone.
export function linesTogether(leaving) {
  return !!S.textLinesTogether || (leaving ? !!S.textLinesTogetherOut : !!S.textLinesTogetherIn);
}

// Line pause: the rest between one line visibly finishing and the next
// visibly beginning. Each line owns a window of the fade, but the eased
// ends of that window show nothing: an arrival's last letter spends the end
// of its clock settling by amounts too small to see, a departure's first
// letter the start of its clock barely stirring. The lines used to sit end
// to end on their windows, so that dead tail read as a pause between every
// pair of lines, longer the longer the fade and the harder the ease.
// Now at 0 the windows overlap by exactly the tail, so the next line starts
// as the last one lands; at 1 they rest a whole window apart.
//
// The tail, as a share of a line's window: its letters' own clocks fill
// the (1 - st) left after the stagger (or the smoke's sweep) spreads their
// starts, and a letter's d = u^k (or (1 - u)^k) is within LINE_TAIL_D of
// done for the last (or first) LINE_TAIL_D^(1/k) of its clock.
const LINE_TAIL_D = 0.1;
export function lineStep(st, k) {
  const v = S.textLinePause;
  const g = v > 0 ? (v < 1 ? v : 1) : 0;
  const s = st > 0 ? (st < 0.9 ? st : 0.9) : 0;
  return 1 - (1 - s) * Math.pow(LINE_TAIL_D, 1 / Math.max(1, k)) + g;
}
// Line k's own progress, 0..1. a is lineStep: line starts sit a windows
// apart, so n lines span 1 + (n - 1) a windows of the fade. a = 1 is the
// old end-to-end clock, prog n - k. The smoke's shaders run the same sum
// (word-smoke.wgsl.js, a in m8.w).
export function lineProgress(prog, k, n, a) {
  return clamp01(prog * (1 + (n - 1) * a) - k * a);
}

export function fxv(name, leaving) { return leaving && !S.textFxMirror ? S[name + 'Out'] : S[name]; }

// The smoke recording's scoreboard. gpu/word-smoke.js writes readyText
// (which word it holds a finished recording for); letterFx latches playing
// once per phase, at the phase's first frame, so the choice between the
// recording and the plain-fade fallback is made exactly once and never
// flips mid-transition — a recording that finishes late waits for the next
// phase rather than jumping in. Latching here, not in the smoke module,
// because the overlay builds its letters before the engine updates, and
// both must agree within the same frame.
export const smokeState = { readyText: '', readyDep: '', playing: false };
let smokeLatchSeed = -1, smokeLatchPhase = -1;

// The resting screen's hint, handed to the smoke on each start from it
// (ui/screens/overlay.js). The overlay lays the hint's letters
// out here itself, in the same 12-float layout as wordLetters, because only
// it knows where the hint sits; a letter's slot 9 is its ink (0 the main
// line's colour, 1 the sub-lines'). req is the handshake: the overlay sets it
// and stops drawing the hint in the same frame, and gpu/word-smoke.js
// clears it when it takes the letters into the live field. Sized to the
// smoke's own letter buffer (SMOKE_LETTERS in gpu/word-smoke.wgsl.js),
// which is larger than a word's because the hint runs to about 90 letters.
export const smokeHint = {
  req: false, count: 0, seed: 0, data: new Float32Array(128 * 12),
  peak: 1, size: 19, cx: 0, cy: 0, colA: null, colB: null,
  // the release: word-smoke drives the front while the overlay keeps the
  // letters ahead of it crisp; finishReq (overlay) asks for the rest at once
  releasing: false, frontX: 0, finishReq: false
};

// The hint's left-to-right front, shared by its smoke out (gpu/word-smoke.js)
// and its sweep in (ui/screens/overlay.js) so the two feel related: the
// share of the transition the front spends crossing the ink. Render > Hint
// sweep (S.hintSweep) is a speed multiplier on the front the words' Leave
// sweep draws at its default speed, where the front spends 0.49 of the fade
// crossing (0.85 - 0.72 x 0.5, see word-smoke's update), so the hint's share
// is that over the multiplier, and 2x crosses in half the time.
const HINT_SWEEP_SHARE = 0.49;
export function hintSweepShare() {
  const mul = Math.max(0.1, S.hintSweep ?? 2);
  return Math.max(0.1, Math.min(0.9, HINT_SWEEP_SHARE / mul));
}

// This frame's letters as drawn, 12 floats each (three vec4s, the layout the
// cloud shader reads): cx cy hw hh (centre and half size, css px), u0 v0 u1 v1
// (atlas cell), rotation, cloud dissolve (0 for none), cumulative share of the
// word's quad area (filled in by the cloud layer), and +1 leaving / -1 arriving.
// seed is the word's own, so the cloud knows when to reseed its particles.
export const MAX_CLOUD_LETTERS = 72;   // an affirmation phrase runs to ~62 letters
export const wordLetters = { count: 0, seed: 0, data: new Float32Array(MAX_CLOUD_LETTERS * 12) };

const TAU = Math.PI * 2;

// A per-letter random number that stays the same for the life of one word, so
// a letter follows one path instead of jittering to a new one every frame.
function hash(a) {
  const x = Math.sin(a * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// out: [dx, dy, scale, rotation, alpha, soft, ghost, cloud]
//   dx, dy    css px offset of the letter's centre
//   scale     about the letter's own centre
//   rotation  radians
//   alpha     multiplies the word's own opacity
//   soft      edge blur in css px
//   ghost     0..1 strength of the blurred halo copy underneath
//   cloud     the particles' dissolve amount, 0 when they are not in play
// relX, relY: the letter's centre relative to the word's centre, css px.
// Which wrapped line the letters being drawn belong to: the overlay sets
// this before each line's drawWord call. With Fade lines together off, a
// block's lines run one after another, each on its own compressed clock.
export const lineCtx = { k: 0, n: 1 };

export function letterFx(i, n, relX, relY, wordW, size, out) {
  out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 0; out[4] = 1; out[5] = 0; out[6] = 0; out[7] = 0;
  const ph = wordState.phase;
  if (ph === 1) return;
  const leaving = ph === 2;
  const fx = leaving ? (S.textFxMirror ? S.textFxIn : S.textFxOut) : S.textFxIn;

  // Leaving rolls its own randoms, so even a mirrored exit takes a new path
  // back into the cloud rather than retracing the arrival exactly.
  const seed = wordState.seed + (leaving ? 517.3 : 0) + i * 7.31;
  const h0 = hash(seed), h1 = hash(seed + 1.7), h2 = hash(seed + 3.1), h3 = hash(seed + 4.9);
  const turb = fxv('textFxTurb', leaving);

  // 0 degrees blows to the right, 90 straight up (screen y runs down).
  const dir = -fxv('textFxWindDir', leaving) * Math.PI / 180;
  const wx = Math.cos(dir), wy = Math.sin(dir);

  // Order: gather and cloud condense in no particular order, wind peels the letters
  // off the upwind side first, fade reads left to right. Turbulence roughs up
  // whichever order the effect chose.
  // Gather can instead sweep left to right, Stagger setting how long its
  // front takes to cross the word.
  const sweep = fx === 'gather' && fxv('textGatherSweep', leaving);
  let ord;
  if ((fx === 'gather' && !sweep) || fx === 'cloud') ord = h0;
  else if (fx === 'wind') ord = wordW > 0 ? 0.5 + (relX * wx + relY * wy) / wordW : 0;
  else ord = n > 1 ? i / (n - 1) : 0;
  ord = clamp01(ord + (h3 - 0.5) * turb * 0.4);

  const st = Math.min(0.9, fxv('textFxStagger', leaving));
  const k = 1 + 3 * fxv('textFxEase', leaving);
  let prog = wordState.progress;
  if (lineCtx.n > 1 && !linesTogether(leaving)) prog = lineProgress(prog, lineCtx.k, lineCtx.n, lineStep(st, k));
  const u = clamp01((prog - st * ord) / (1 - st));
  const d = leaving ? Math.pow(u, k) : Math.pow(1 - u, k);

  // The whole-word effects own their letters for the ENTIRE phase and are
  // dispatched before the d-is-zero early-out below. That early-out means
  // "this letter has landed, draw it crisp", which is right for the
  // per-letter effects and a catastrophe for these two: a staggered letter
  // whose own clock finishes early would come in hard over the smoke or
  // cloud still forming around it — a second word on top of the first.
  if (fx === 'smoke') {
    // Recorded dissolution (gpu/word-smoke.js): the composite draws the
    // word; the letters here stand aside. No recording ready for this word
    // at the phase's first frame means the plain fade, the deadline rule
    // the effect was specified with.
    if (wordState.seed !== smokeLatchSeed || ph !== smokeLatchPhase) {
      smokeLatchSeed = wordState.seed; smokeLatchPhase = ph;
      // departures are simulated live and never miss; only arrivals
      // depend on a finished recording
      smokeState.playing = ph === 2 || smokeState.readyText === wordState.text;
    }
    if (smokeState.playing) { out[4] = 0; out[7] = d; }
    else { out[4] = 1 - d; }
    return;
  }
  if (fx === 'cloud') {
    // The smoke system (gpu/word-cloud.js) draws the word itself during a
    // cloud transition, per pixel through its formation mask.
    out[4] = 0;
    out[7] = d;
    return;
  }

  if (d <= 0) return;

  const D = fxv('textFxDist', leaving) * size;
  // a slow wander on top of the path, so a cloud of letters never moves as
  // one rigid piece
  const wob = turb * size * 0.25 * d;
  const age = wordState.age;
  const wobX = wob * Math.sin(age * 0.0021 + h0 * TAU);
  const wobY = wob * Math.cos(age * 0.0017 + h1 * TAU);

  if (fx === 'gather') {
    // The cloud hangs above the word, so the letters drift down, grow to
    // size and settle into place; a mirrored exit lifts them back up into it.
    const a = h1 * TAU + d * turb * 2.5;             // a little swirl on the way
    const r = D * (0.45 + 0.55 * h2) * d;
    out[0] = Math.cos(a) * r + wobX;
    out[1] = Math.sin(a) * r * 0.6 - D * 0.6 * d + wobY;
    out[2] = 1 - 0.85 * d;
    out[3] = (h3 - 0.5) * turb * 2.4 * d;
    out[4] = 1 - d * d;
  } else if (fx === 'wind') {
    // Arriving blows in from upwind and leaving carries on downwind, so a
    // word that comes and goes on the wind is one continuous current.
    const sgn = leaving ? 1 : -1;
    const along = sgn * D * 2 * d * (0.7 + 0.6 * h1);
    const curl = D * 0.6 * turb * d * Math.sin(d * (3 + 4 * h2) + h0 * TAU);
    out[0] = wx * along - wy * curl + wobX;
    out[1] = wy * along + wx * curl + wobY;
    out[2] = 1 + 0.35 * d * h2;
    out[3] = sgn * d * turb * 3 * (h3 - 0.3);
    out[4] = 1 - d * d;
  } else {
    out[4] = 1 - d;
  }

  const blur = fxv('textFxBlur', leaving);
  out[5] = blur * d * size * 0.15;
  out[6] = blur * d;
}
