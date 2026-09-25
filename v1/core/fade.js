// The tunnel rings' radial fade, shared by every layer that flies out from
// the centre (rings, flowers, kaleidoscope, particles), so one "Fade in"
// setting means the same thing everywhere.
//
// k is the normalised radius: 0 at the vanishing point, 1 at the rim.
// f is the fade-in amount, 0..1 (the slider's percent / 100). At 0 there is
// no fade in at all. Higher values stretch the ease further out from the
// centre and sharpen its curve (the exponent 1 + 2f), exactly as the rings
// have always done. The fade out over the last 28% to the rim is fixed.

import { smoothstep } from '../../js/util.js';

export const RADIAL_FADE_OUT_K = 0.72;

export function radialFadeIn(f, k) {
  if (f < 0.01) return 1;
  return Math.pow(smoothstep(0, f * 0.98, k), 1 + f * 2);
}

export function radialFadeOut(k) {
  return k < RADIAL_FADE_OUT_K ? 1 : Math.max(0, (1 - k) / (1 - RADIAL_FADE_OUT_K));
}

export function radialFade(f, k) {
  return radialFadeIn(f, k) * radialFadeOut(k);
}

// The same curve in WGSL, for layers whose alpha is computed on the GPU.
// Paste into a shader module and call radialFade(f, k).
export const RADIAL_FADE_WGSL = /* wgsl */`
fn radialFadeIn(f: f32, k: f32) -> f32 {
  if (f < 0.01) { return 1.0; }
  return pow(smoothstep(0.0, f * 0.98, k), 1.0 + f * 2.0);
}
fn radialFadeOut(k: f32) -> f32 {
  if (k < ${RADIAL_FADE_OUT_K}) { return 1.0; }
  return max(0.0, (1.0 - k) / ${(1 - RADIAL_FADE_OUT_K).toFixed(4)});
}
fn radialFade(f: f32, k: f32) -> f32 { return radialFadeIn(f, k) * radialFadeOut(k); }
`;
