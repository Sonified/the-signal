// Where the Live Video panel sits and how big it is, as plain arithmetic, so
// the panel (platform/camera-panel.js) and its tests share one answer.
//
// The panel stands in the bottom right corner, where a video player or a
// video call puts a picture, stacked straight above the chrome's bottom row:
// its right edge lines up with the full-screen button's (LAYOUT.chromeInset
// from the right, the chrome's EDGE), and its bottom sits one chip gap
// (SPACE.sm) above the top of that row (a chip tall, LAYOUT.chipH, at EDGE
// from the bottom). That row is the full-screen button alone on the
// livestream screen and the button with the quick-bar chips everywhere else,
// so the panel clears both the same way.
//
// Its height is the size share of the screen's shorter side (core/camera.js
// says why), its width the camera's own shape times that, never stretched or
// cropped. Then it is kept clear of everything else on screen: its top a gap
// below the top row (the volume cluster at the top right, the burger at the
// top left; the burger's row, LAYOUT.burger, is the taller of the two), and
// its left edge EDGE short of the open drawer's edge (S.edgeInset, handed in
// as left). Whichever bound bites shrinks both sides together, so the shape
// holds. A screen too small to leave the panel a chip's height shows none.
import { LAYOUT, SPACE } from './theme.js';
import { CAM_SIZE_MIN, CAM_SIZE_MAX, camSizeClamp } from '../core/camera-size.js';

const EDGE = LAYOUT.chromeInset;
const ROW = LAYOUT.chipH;       // the bottom row: the full-screen button and the quick-bar chips
const TOP = LAYOUT.burger;      // the top row: the burger, and the volume cluster beside it in height
const GAP = SPACE.sm;           // the chrome's gap between chips
const MIN_H = LAYOUT.chipH;
// a camera that has not said its shape yet is taken as a laptop's
const DEF_ASPECT = 16 / 9;

const aspectOf = a => (typeof a === 'number' && a > 0 && Number.isFinite(a)) ? a : DEF_ASPECT;

// The fixed corner the panel grows from: its right edge and its bottom.
export const camRightOf = vw => vw - EDGE;
export const camBottomOf = vh => vh - EDGE - ROW - GAP;

// The largest width and height the screen allows the panel.
const maxWOf = (vw, left) => camRightOf(vw) - (left + EDGE);
const maxHOf = vh => camBottomOf(vh) - (EDGE + TOP + GAP);

// Writes the panel's rect (css px, top left origin) into out and returns
// true, or returns false with out.w and out.h at 0 when there is no room.
// left is the open drawer's width (0 shut). out is the caller's, kept from
// call to call, so this allocates nothing.
export function camFit(out, size, aspect, vw, vh, left) {
  const a = aspectOf(aspect);
  const l = left > 0 ? left : 0;
  const maxW = maxWOf(vw, l), maxH = maxHOf(vh);
  let h = camSizeClamp(size) * Math.min(vw, vh);
  let w = h * a;
  if (w > maxW) { w = maxW; h = w / a; }
  if (h > maxH) { h = maxH; w = h * a; }
  if (!(h >= MIN_H) || !(w > 0)) { out.x = camRightOf(vw); out.y = camBottomOf(vh); out.w = 0; out.h = 0; return false; }
  out.x = camRightOf(vw) - w;
  out.y = camBottomOf(vh) - h;
  out.w = w;
  out.h = h;
  return true;
}

// The size a hand on the panel's inner corner (its top left) asks for, with
// that corner at (cornerX, cornerY): the panel then reaches from there to its
// fixed bottom right, so a drag up and to the left grows it and down and to
// the right shrinks it. The two heights that corner implies (its height, and
// its width over the camera's shape) are averaged, so a drag along either
// axis, or both, moves the size smoothly and a hand that wanders off the
// diagonal does not jump it. Held to what this screen allows, so the slider
// never claims a size the panel cannot show, and to the slider's own range.
export function camSizeForHand(cornerX, cornerY, aspect, vw, vh, left) {
  const a = aspectOf(aspect);
  const maxW = maxWOf(vw, left > 0 ? left : 0), maxH = maxHOf(vh);
  const handW = camRightOf(vw) - cornerX, handH = camBottomOf(vh) - cornerY;
  let h = (handH + handW / a) / 2;
  h = Math.min(h, maxH, maxW / a);
  const short = Math.min(vw, vh);
  if (!(short > 0)) return CAM_SIZE_MIN;
  const f = h / short;
  return camSizeClamp(f < CAM_SIZE_MIN ? CAM_SIZE_MIN : f > CAM_SIZE_MAX ? CAM_SIZE_MAX : f);
}
