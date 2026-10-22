// The backing machinery the centre word and the hint share
// (ui/screens/overlay-word.js and overlay-hint.js): the shade record their
// drawWord passes carry, the panel's measures and pills, the fade envelope
// step, and the ghost that lets a backing outlive its text.
//
// The word's backing (Text > Shadow, Shadow blur, Panel), for letters that
// have to hold their own over a busy scene. Both are black, both sit under
// the letters, and both are off at 0, so a first visit looks as it always
// has. The shadow is each letter again, directly behind itself: it darkens
// what shows through a soft or faint letter and haloes its edge. The panel is
// a rounded block filled in behind the letters as they arrive. Each is its
// own pass of text-atlas's drawWord with this record as its shade, through
// the very letterFx the word itself goes through, so neither can drift from
// a transition; the record is reused every frame, never rebuilt.
import { STRIDE } from './drawlist.js';

export const SHADE_INK = new Float32Array([0, 0, 0, 1]);
const PANEL_FILL = new Float32Array([0, 0, 0, 1]);
export const shade = {
  alpha: 0, soft: 0, dilate: 0, measure: false,
  ax0: 0, ay0: 0, ax1: 0, ay1: 0,
  dx0: 0, dy0: 0, dx1: 0, dy1: 0
};
// Softness the shadow always carries, so even behind an opaque letter it
// reaches past the glyph's edge. The shadow is drawn from the atlas's far
// copies (gpu/text-atlas.js FAR_RANGE), whose field reaches 44 of 64 atlas
// px past the ink; the glyph shader lets dilation and softness together use
// 0.9 of that, about 0.62 em at any size, dilation first. Shadow size grows
// the outline by up to SHADOW_SIZE_EM, and Shadow blur softens the grown
// edge by up to SHADOW_SOFT_CAP_EM, both at once inside that reach, so
// neither slider ever runs into the other's share. The blur's travel is
// spread from the spread to its cap, so every step of it softens the shadow
// further; a word too small to have any headroom past the spread gets none,
// never a negative.
const SHADOW_SPREAD = 1.5;
const SHADOW_SOFT_CAP_EM = 0.3;
const SHADOW_SIZE_EM = 0.3;
// The panel's margin past the letters: Panel size runs it from a sliver to
// the full pad; the corner radius rides the pad so a small panel squares
// off rather than swallowing itself in its own corners. Soft edges swap the
// hard rect for the shader's Gaussian of the same box (shadeRect's
// erf shadow, already black), up to half an em of blur; the pad grows by
// half the blur so the softened edge stays centred where the hard one was.
const PANEL_PAD_EM = 0.6, PANEL_PAD_MIN_EM = 0.08, PANEL_RADIUS_EM = 0.35;
const PANEL_SOFT_MAX_EM = 1.5;

export function unit(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }
export function smooth01(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

// The hint's panel box: a hard rect, or a feathered slab. Word panels use
// the same padding and softness, with per-letter opacity in TextPanel.
function panelBox(dl, x0, y0, x1, y1, padX, padY, radius, blur) {
  if (blur >= 1) {
    dl.slab(x0 - padX, y0 - padY, x1 - x0 + 2 * padX, y1 - y0 + 2 * padY, radius, blur, 1);
  } else {
    dl.rect(x0 - padX, y0 - padY, x1 - x0 + 2 * padX, y1 - y0 + 2 * padY, radius, PANEL_FILL, 0, null, 0, 0);
  }
}
// The panel's measures at one text size (Panel size and Soft edges, 0..1),
// into this record, reused every frame. Shared by the word and the hint.
export const pm = { blur: 0, pad: 0, radius: 0 };
export function panelMetrics(size, sizeAmt, soft) {
  pm.blur = soft * PANEL_SOFT_MAX_EM * size;
  pm.pad = (PANEL_PAD_MIN_EM + sizeAmt * (PANEL_PAD_EM - PANEL_PAD_MIN_EM)) * size + pm.blur * 0.5;
  pm.radius = pm.pad * (PANEL_RADIUS_EM / PANEL_PAD_EM);
}
// One line's pill at pm's measures. With neighbours above or below, the
// vertical pad stops at the line's own slot (slotH, its distance to them;
// Infinity for a line alone, which keeps the full pad), so the pills stay
// apart instead of stacking dark on dark where they'd overlap.
export function linePill(dl, x0, y0, x1, y1, slotH) {
  if (!(x1 > x0) || !(y1 > y0)) return;
  const padY = Math.min(pm.pad, Math.max(1, (slotH - (y1 - y0)) * 0.5));
  panelBox(dl, x0, y0, x1, y1, pm.pad, padY, Math.min(pm.radius, (y1 - y0) * 0.5 + padY), pm.blur);
}

// shade set up for a measure pass: nothing drawn, both bounds emptied
function shadeBounds() {
  shade.ax0 = shade.ay0 = shade.dx0 = shade.dy0 = Infinity;
  shade.ax1 = shade.ay1 = shade.dx1 = shade.dy1 = -Infinity;
}
export function shadeMeasure() {
  shade.alpha = 0; shade.soft = 0; shade.dilate = 0; shade.measure = true;
  shadeBounds();
}
// shade set up for a shadow pass at one text size (Shadow blur and size, 0..1)
export function shadeShadow(alpha, blur, sizeAmt, size) {
  shade.alpha = alpha; shade.measure = false;
  shade.soft = SHADOW_SPREAD + blur * Math.max(0, SHADOW_SOFT_CAP_EM * size - SHADOW_SPREAD);
  // Shadow size grows each dark letter's outline outward, the same
  // distance past every edge, and the blur then softens that grown edge.
  shade.dilate = sizeAmt * SHADOW_SIZE_EM * size;
}

// One fade envelope's step. leaving is the text's own going (the word's
// phase 2, the hint's release or yielding): with a Fade out set the
// envelope sinks over it from that moment.
export function stepEnv(env, onStage, leaving, dt, inMs, outMs) {
  if (!onStage) return 0;
  if (leaving && outMs > 0) return Math.max(0, env - dt / outMs);
  return inMs > 0 ? Math.min(1, env + dt / inMs) : 1;
}

// A backing outliving its text. Drawn live, the shadow is each letter again
// at that letter's own opacity and the panel rides the word's fade and the
// letters shown, so either can only last as long as the letters do,
// whatever its Fade out says. So every frame the text is up and not yet
// leaving, each pass's draw records are copied out (snap); the frame it
// starts leaving (or vanishes, or its switch goes off) that copy becomes
// the ghost, frozen at rest, and is replayed under everything at a level
// sinking from 1 over the effect's own Fade out, the text gone or not. The
// live pass steps aside meanwhile, its envelope back at 0, so the next
// text's backing rises from nothing while the last one's fades. Two buffers
// each, swapped as a ghost starts, so a new text's snaps never overwrite a
// ghost still on screen. At Fade out 0 nothing is kept and the backing
// follows the text as before.
export function makeGhost() {
  return { snap: new Float32Array(64 * STRIDE), snapN: 0, fresh: false,
           ghost: new Float32Array(64 * STRIDE), ghostN: 0, level: 0 };
}
export function ghostSnap(g, dl, from) {
  const n = dl.count - from;
  if (n * STRIDE > g.snap.length) g.snap = new Float32Array(n * STRIDE * 2);
  g.snap.set(dl.data.subarray(from * STRIDE, dl.count * STRIDE));
  g.snapN = n; g.fresh = true;
}
// going: the text is leaving or gone, or this effect is off
export function ghostStep(g, going, dt, outMs) {
  if (going && g.fresh) {
    g.fresh = false;
    if (outMs > 0 && g.snapN > 0) {
      const b = g.ghost; g.ghost = g.snap; g.snap = b;
      g.ghostN = g.snapN; g.snapN = 0; g.level = 1;
      return;
    }
  }
  // still up: this frame's live pass snaps afresh, or there is nothing to keep
  if (!going) g.fresh = false;
  if (g.level > 0) g.level = outMs > 0 ? Math.max(0, g.level - dt / outMs) : 0;
}
export function ghostDraw(g, dl) {
  if (g.level <= 0.002) return;
  dl.pushAlpha(g.level);
  dl.replay(g.ghost, g.ghostN);
  dl.popAlpha();
}
