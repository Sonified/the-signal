// Where the Live Video panel sits and how big it is, as plain arithmetic, so
// the panel (platform/camera-panel.js) and its tests share one answer.
//
// The panel stands in the bottom left corner, the chrome's inset from both
// edges (LAYOUT.chromeInset, the chrome's EDGE), stepped right past the
// drawer while it is open (the same S.edgeInset the scene recentres on).
// That corner is the free one: the burger holds the top left on ordinary
// pages, the volume the top right, and the full-screen button the bottom
// right, on the livestream screen too.
//
// Its height is the size share of the screen's shorter side (core/camera.js
// says why), its width the camera's own shape times that, never stretched or
// cropped. Then it is kept clear of the corner controls: its right edge stops
// a chip's gap short of the full-screen button's column, and its top a gap
// below the burger's row (which also clears the volume, shorter, across the
// top). Whichever bound bites shrinks both sides together, so the shape
// holds. A screen too small to leave the panel a chip's height shows none.
import { LAYOUT, SPACE } from './theme.js';
import { CAM_SIZE_MIN, CAM_SIZE_MAX, camSizeClamp } from '../core/camera.js';

const EDGE = LAYOUT.chromeInset;
const CORNER = LAYOUT.chipH;    // the full-screen button, a chip square
const TOP = LAYOUT.burger;      // the burger's row
const GAP = SPACE.sm;           // the chrome's gap between chips
const MIN_H = LAYOUT.chipH;
// a camera that has not said its shape yet is taken as a laptop's
const DEF_ASPECT = 16 / 9;

const aspectOf = a => (typeof a === 'number' && a > 0 && Number.isFinite(a)) ? a : DEF_ASPECT;

// The largest width and height the corner allows on this screen.
const maxWOf = (vw, left) => vw - left - EDGE - (GAP + CORNER + EDGE);
const maxHOf = vh => vh - EDGE - (EDGE + TOP + GAP);

// Writes the panel's rect (css px, top left origin) into out and returns
// true, or returns false with out.w and out.h at 0 when there is no room.
// out is the caller's, kept from call to call, so this allocates nothing.
export function camFit(out, size, aspect, vw, vh, left) {
  const a = aspectOf(aspect);
  const l = left > 0 ? left : 0;
  const maxW = maxWOf(vw, l), maxH = maxHOf(vh);
  let h = camSizeClamp(size) * Math.min(vw, vh);
  let w = h * a;
  if (w > maxW) { w = maxW; h = w / a; }
  if (h > maxH) { h = maxH; w = h * a; }
  if (!(h >= MIN_H) || !(w > 0)) { out.x = l + EDGE; out.y = vh - EDGE; out.w = 0; out.h = 0; return false; }
  out.x = l + EDGE;
  out.y = vh - EDGE - h;
  out.w = w;
  out.h = h;
  return true;
}

// The size a hand on the panel's inner corner asks for: the corner pulled
// to handW wide and handH tall from the panel's fixed bottom left. The two
// heights they imply (the hand's own, and its width over the camera's shape)
// are averaged, so a drag along either axis, or both, grows or shrinks the
// panel smoothly and a hand that wanders off the diagonal does not jump it.
// Held to what this screen's corner allows, so the slider never claims a
// size the panel cannot show, and to the slider's own range.
export function camSizeForHand(handW, handH, aspect, vw, vh, left) {
  const a = aspectOf(aspect);
  const maxW = maxWOf(vw, left > 0 ? left : 0), maxH = maxHOf(vh);
  let h = (handH + handW / a) / 2;
  h = Math.min(h, maxH, maxW / a);
  const short = Math.min(vw, vh);
  if (!(short > 0)) return CAM_SIZE_MIN;
  const f = h / short;
  return camSizeClamp(f < CAM_SIZE_MIN ? CAM_SIZE_MIN : f > CAM_SIZE_MAX ? CAM_SIZE_MAX : f);
}
