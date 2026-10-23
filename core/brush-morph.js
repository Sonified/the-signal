// The brush's morph from its shapes to particles: S.brushMorph, 0 every
// stamp drawn as its atlas tile (the brush as it always was), 1 every stamp
// a small glowing particle, light in its tile's own hue, between them each
// stamp both at once, the shape at 1 - m and the particle at m
// (gpu/brush.wgsl.js). The swirl is the stamps either way: the same places,
// the same walk, only how each is drawn moves. Every stamp drawn from now on
// takes the value of its own frame, the visitor's and the playback's alike;
// a mark already in the trail stays as it was drawn and fades out as ever.
//
// Auto (S.brushMorphAuto) sweeps it for the hand: shapes to particles in
// MORPH_HALF_PERIOD seconds, back in as many again, round and round, on a
// cosine, so it eases into each end and never jumps. Switched on, the sweep
// sets out from wherever the value stands, rising; moved by hand (the
// standing playback's slider, ui/screens/morph.js, or the drawer's row,
// core/schema-brush.js) it is switched off and the value stays where the
// hand left it. The value and the switch are the hand's own, in the brush
// record (core/schema-brush.js), so a reload comes back to them.

import { S } from '../js/state.js';

// Auto's half period, seconds: shapes to particles, or back.
export const MORPH_HALF_PERIOD = 10;

const TAU = Math.PI * 2;
// A long frame (the tab coming back) moves the sweep a quarter second at most.
const MAX_STEP = 0.25;

let phase = 0, swept = false;

const clamp01 = v => (v > 0 ? (v < 1 ? v : 1) : 0);

// The sweep's value at a phase (radians): 0 at 0, 1 at pi.
export function morphAt(p) { return 0.5 - 0.5 * Math.cos(p); }
// The phase on the rising half where the sweep reads v.
export function morphPhaseOf(v) { return Math.acos(1 - 2 * clamp01(v)); }

// How bright the particles shine (S.brushParticleBright, the drawer's
// Particle brightness): a multiple of their light, 0.25 to 4, 1 the
// default. The shapes never feel it.
export const PART_BRIGHT_LO = 0.25, PART_BRIGHT_HI = 4;
export function brushParticleBrightNow() {
  const v = S.brushParticleBright;
  return typeof v === 'number' && v === v ? (v < PART_BRIGHT_LO ? PART_BRIGHT_LO : v > PART_BRIGHT_HI ? PART_BRIGHT_HI : v) : 1;
}

// The value the brush draws with this frame.
export function brushMorphNow() {
  const v = S.brushMorph;
  return typeof v === 'number' && v === v ? clamp01(v) : 0;
}

// Once a frame, dt in seconds: while Auto is on, the sweep moves on and the
// value follows it (so the slider shows it travel). Nothing is saved: the
// value saved is the one the hand last set, and a reload's sweep sets out
// from there.
export function stepBrushMorph(dt) {
  if (S.brushMorphAuto !== true) { swept = false; return; }
  if (!swept) { swept = true; phase = morphPhaseOf(brushMorphNow()); }
  const step = dt > 0 ? (dt < MAX_STEP ? dt : MAX_STEP) : 0;
  phase = (phase + Math.PI * step / MORPH_HALF_PERIOD) % TAU;
  S.brushMorph = morphAt(phase);
}
