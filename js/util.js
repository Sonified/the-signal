import { S } from './state.js';

export const hexToRgb = h => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function rgbToHsl(r, g, b) {
  r/=255; g/=255; b/=255;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d/(2-mx-mn) : d/(mx+mn);
  let h;
  if (mx === r)      h = ((g-b)/d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b-r)/d + 2) / 6;
  else               h = ((r-g)/d + 4) / 6;
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l*255); return [v,v,v]; }
  const q = l < 0.5 ? l*(1+s) : l + s - l*s;
  const p = 2*l - q;
  const f = t => {
    t = ((t % 1) + 1) % 1;
    if (t < 1/6) return p + (q-p)*6*t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q-p)*(2/3 - t)*6;
    return p;
  };
  return [Math.round(f(h+1/3)*255), Math.round(f(h)*255), Math.round(f(h-1/3)*255)];
}

export const bandName = f => f < 4 ? 'Delta' : f < 8 ? 'Theta' : f < 13 ? 'Alpha' : 'Beta';

export function smoothstep(e0, e1, x) {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2*t);
}

export function shape(p) {
  switch (S.wave) {
    case 'square':   return p < S.duty ? 1 : 0;
    case 'triangle': return p < .5 ? p*2 : 2 - p*2;
    default:         return .5 * (1 - Math.cos(2*Math.PI*p));
  }
}
