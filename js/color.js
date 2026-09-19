import { S, HUE_STEPS, WALK_STEP, WALK_DAMP, WALK_SWING } from './state.js';
import { hexToRgb, rgbToHsl, hslToRgb } from './util.js';

// Per-element walking would build a colour string per ring, per particle, per
// frame. Instead hues are quantised into a prebuilt palette of ready-made
// strings, so the draw loop only ever indexes an array.
export function ensurePalette() {
  const key = S.hueSat.toFixed(3) + '|' + S.hueLight.toFixed(3);
  if (key === S.paletteKey) return;
  S.paletteKey = key;
  S.huePalette.length = 0;
  for (let i = 0; i < HUE_STEPS; i++) {
    const c = hslToRgb(i/HUE_STEPS, S.hueSat, S.hueLight);
    S.huePalette.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
}

export const hueStr = h => S.huePalette[(h * HUE_STEPS | 0) % HUE_STEPS];

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
