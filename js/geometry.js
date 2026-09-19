import { S } from './state.js';

// Everything is composed inside the area the drawer leaves visible, so opening
// the panel recentres the tunnel rather than pushing it off behind the panel.
export const visW  = () => S.W - S.edgeInset;
export const visCx = () => S.edgeInset + (S.W - S.edgeInset)/2;

// ---------- perimeter mapping for the edge layer ----------
// u in 0..1 walks clockwise around the viewport rectangle
// Writes into module-level scratch instead of returning a new array. This is
// called thousands of times per frame; allocating here was producing enough
// garbage to trigger a GC pause roughly every 140ms, which showed up as a
// periodic 30-50ms stall in the strobe. `px`/`py` are live module bindings, so
// importers read the updated value without anything being returned or boxed.
export let px = 0, py = 0;

export function perimeterPoint(u) {
  const L = S.edgeInset;               // left edge, pushed in when the drawer is open
  const W = S.W, H = S.H;
  const w = W - L;
  const per = 2*(w+H);
  let d = (((u % 1) + 1) % 1) * per;   // wrap negatives, trails run backwards
  if (d < w)      { px = L + d; py = 0;     return; }
  d -= w;
  if (d < H)      { px = W;     py = d;     return; }
  d -= H;
  if (d < w)      { px = W - d; py = H;     return; }
  d -= w;
  px = L; py = H - d;
}
