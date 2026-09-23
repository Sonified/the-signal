import { S, HUE_STEPS, WALK_STEP, WALK_DAMP, WALK_SWING } from './state.js';
import { hexToRgb, rgbToHsl, hslToRgb } from './util.js';

// Per-element walking would build a color string per ring, per particle, per
// frame. Instead hues are quantised into a prebuilt palette of ready-made
// strings, so the draw loop only ever indexes an array.
// The guard compares the two numbers it depends on rather than a string built
// from them. This runs on every frame and the answer is almost always "no,
// nothing changed"; formatting two floats and concatenating them to find that
// out allocated three strings per frame to throw all three away.
let satSeen = NaN, lightSeen = NaN;

export function ensurePalette() {
  if (S.hueSat === satSeen && S.hueLight === lightSeen && S.huePalette.length) return;
  satSeen = S.hueSat; lightSeen = S.hueLight;
  S.paletteKey = S.hueSat.toFixed(3) + '|' + S.hueLight.toFixed(3);
  S.huePalette.length = 0;
  for (let i = 0; i < HUE_STEPS; i++) {
    const c = hslToRgb(i/HUE_STEPS, S.hueSat, S.hueLight);
    S.huePalette.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
}

// Fold a full turn of the wheel into a narrower band.
//
// The walk accumulator still runs 0 to 1 and still moves in one direction, so
// nothing about the pacing changes. What changes is where it lands: a triangle
// maps the turn onto the band and back again, so the colour drifts to the far
// end of the range and returns rather than jumping when the accumulator wraps.
// Clamping the hue directly would have parked it at an edge instead.
export function bandHue(h) {
  if (S.hueSpan >= 1) return h;
  const tri = 1 - Math.abs(2 * h - 1);
  return (S.hueLo + S.hueSpan * tri + 1) % 1;
}

export const hueStr = h => S.huePalette[(bandHue(h) * HUE_STEPS | 0) % HUE_STEPS];

// shared damped random walk, applied in place so nothing allocates
export function walkHue(o, dt) {
  o.hv += (Math.random() - 0.5) * WALK_STEP * dt;
  o.hv *= WALK_DAMP;
  if (o.hv >  1) o.hv =  1;
  if (o.hv < -1) o.hv = -1;
  o.hue += (1 + o.hv * WALK_SWING) * S.colorWalk * dt / S.walkPeriod;
  o.hue -= Math.floor(o.hue);
}

export function setColorFromPicker(hex) {
  S.rgb = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(S.rgb[0], S.rgb[1], S.rgb[2]);
  S.hue = h; S.hueSat = s; S.hueLight = l;
}
