// The morph's own slider on the standing playback's page (main.js
// replayTape, ?replay=<tape>&draw): the brush's every stamp from its shape
// to a small glowing particle in the shape's own colour (core/brush-morph.js),
// Shapes at the left end, Particles at the right, and under it an AUTO box
// that sweeps it between the two and back. Centred on the visible field (the
// drawer's inset taken off) toward the bottom, above where the dealt hand's
// row sits (ui/screens/hand.js), on a quiet backing of its own so it reads
// over whatever is drawn. It comes and goes with the chrome (main.js
// chromeAwake): up while the pointer has moved lately or rests on it, then
// faded out with the chrome's own spring, alpha, and taking no presses once
// gone, so a tap on the faded field still reaches the field.
//
// The same value as the drawer's Brush rows (core/schema-brush.js
// brushMorph, brushMorphAuto): moving the slider switches Auto off, and
// either change is saved in the brush record.

import { S } from '../../js/state.js';
import { saveBrush } from '../../core/store.js';
import { brushMorphNow } from '../../core/brush-morph.js';
import { touchAware, RO_PLAIN } from '../widgets.js';
import { COLOR, RADIUS, LAYOUT, MOTION, TYPE, W, TRACK, SPACE } from '../theme.js';

const PANEL_W = 300, PAD = 12, BOX = 13, ROW_H = 22, ABOVE = 12, EDGE = 16;
// where the dealt hand's row stands (hand.js SIDE_MOUSE, SIDE_TOUCH)
const HAND_MOUSE = 46, HAND_TOUCH = 56;
const BACK = new Float32Array([0, 0, 0, 0.5]);
const AUTO = 'AUTO';

export function drawMorph(ui, dl, width, height, alpha) {
  if (alpha < 0.01) return;
  const inset = S.edgeInset || 0;
  const panelW = Math.max(160, Math.min(PANEL_W, width - inset - 2 * EDGE));
  const x = inset + (width - inset - panelW) / 2;
  ui.text.lineMetrics(TYPE.sm, ui._lm);
  const sliderH = ui._lm.ascent + ui._lm.descent + SPACE.xxs + touchAware(ui, 18);
  const boxRowH = touchAware(ui, ROW_H);
  const panelH = PAD + sliderH + boxRowH + PAD - SPACE.xs;
  const hand = ui.pointerType === 'touch' ? HAND_TOUCH : HAND_MOUSE;
  const y = height - LAYOUT.chromeInset - LAYOUT.chipH - ABOVE - hand - ABOVE - panelH;

  dl.pushAlpha(alpha);
  dl.rect(x, y, panelW, panelH, RADIUS.md, BACK, 1, COLOR.lineSoft, 0, 0);

  // the slider, laid where the panel wants it; the layout's cursor is put
  // back after, so nothing else built this frame lands anywhere new
  const cx0 = ui.cursorX, cy0 = ui.cursorY, cw0 = ui.regionW;
  ui.setCursor(x + PAD, y + PAD, panelW - 2 * PAD);
  const nv = ui.slider('morph.slider', 'Shapes', brushMorphNow(), 'Particles', 0.02, undefined, false, RO_PLAIN);
  ui.setCursor(cx0, cy0, cw0);
  if (nv >= 0) { S.brushMorph = nv; S.brushMorphAuto = false; saveBrush(); }

  // AUTO: a box and its word, centred under the slider, the pair one target
  const on = S.brushMorphAuto === true;
  const labelW = ui.text.measure(AUTO, TYPE.xs, W.semibold) * (1 + TRACK.caps);
  const pairW = BOX + SPACE.sm + labelW;
  const by = y + PAD + sliderH;
  const bx = x + (panelW - pairW) / 2;
  const id = ui.id('morph.auto');
  ui.dragHold = 0;
  ui.interact(id, bx - SPACE.sm, by, pairW + 2 * SPACE.sm, boxRowH, false);
  if (ui.hover) ui.setCursorHint('pointer');
  if (ui.clicked) { S.brushMorphAuto = !on; saveBrush(); }
  const hover = ui.spring(id, ui.hover ? 1 : 0, MOTION.hover);
  const onA = ui.spring(ui.idx('morph.auto', 1), S.brushMorphAuto === true ? 1 : 0, MOTION.hover);
  const boxY = by + (boxRowH - BOX) / 2;
  dl.rect(bx, boxY, BOX, BOX, RADIUS.xs, hover > 0.5 ? COLOR.wellHi : COLOR.well,
          1, onA > 0.5 ? COLOR.accent : COLOR.lineStrong, 0, 0);
  if (onA > 0.01) {
    const s = (BOX - 6) * onA;
    dl.pushAlpha(onA);
    dl.rect(bx + (BOX - s) / 2, boxY + (BOX - s) / 2, s, s, 2, COLOR.accent, 0, null, 0, 0);
    dl.popAlpha();
  }
  ui.text.lineMetrics(TYPE.xs, ui._lm);
  const base = by + boxRowH / 2 + (ui._lm.ascent - ui._lm.descent) / 2;
  ui.text.draw(dl, AUTO, bx + BOX + SPACE.sm, base, TYPE.xs, W.semibold, onA > 0.5 ? COLOR.ink : COLOR.inkDim, 0, TRACK.caps, 1);
  dl.popAlpha();
}
