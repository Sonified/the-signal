// The dealt hand: when the hall has dealt this screen its brushes
// (core/brush.js brushHand; broadcast-worker/src/deal.js), a row of
// buttons, one per tile, centred on the visible field toward the bottom,
// above the quick bar's row (where it sits, or sat before a follower's was
// hidden). Each shows its tile's thumbnail, sampled from the UI renderer's
// picture (the hand's set's atlas, asked for each frame the row is drawn);
// a tap makes it the brush's shape, and the one in hand is ringed. A quick
// palette, not a lock: the drawer's picker still picks any tile. The row
// sizes to the hand actually dealt (a late joiner's may be short), and
// stays down while the drawer is open, whose picker wants the picture.
//
// live false paints it only, for the frames main.js builds no UI on; a
// touch brings the build back, which is when it takes the press.

import { S } from '../../js/state.js';
import { brushHand, brushPickHand, brushHandPicked, brushAtlas } from '../../core/brush.js';
import { COLOR, RADIUS, LAYOUT, MOTION } from '../theme.js';

const SIDE_MOUSE = 46, SIDE_TOUCH = 56, GAP = 10, INSET = 4, ABOVE = 12;
const BACK = new Float32Array([0, 0, 0, 0.5]);

export function drawHand(ui, dl, width, height, live) {
  const h = brushHand();
  if (!h || S.panelOpen) return;
  brushAtlas.want = h.a;
  const a = brushAtlas, ready = a.ready && a.set === h.a;
  const n = h.tiles.length;
  const side = ui.pointerType === 'touch' ? SIDE_TOUCH : SIDE_MOUSE;
  const inset = S.edgeInset || 0;
  const rowW = n * side + (n - 1) * GAP;
  let x = inset + (width - inset - rowW) / 2;
  const y = height - LAYOUT.chromeInset - LAYOUT.chipH - ABOVE - side;
  const k = 1 / 8;
  for (let i = 0; i < n; i++, x += side + GAP) {
    const t = h.tiles[i];
    let hover = 0;
    if (live) {
      const id = ui.idx('hand.tile', i);
      ui.dragHold = 0;
      ui.interact(id, x, y, side, side, false);
      if (ui.hover) ui.setCursorHint('pointer');
      if (ui.clicked) brushPickHand(i);
      hover = ui.spring(id, ui.hover ? 1 : 0, MOTION.hover);
    }
    const on = brushHandPicked(i);
    dl.rect(x, y, side, side, RADIUS.md, on ? COLOR.accentSoft : hover > 0.5 ? COLOR.wellHi : BACK,
            on ? 2 : 1, on ? COLOR.accent : COLOR.lineSoft, 0, 0);
    if (ready) {
      const u0 = (t % 8) * k + a.padUV, v0 = ((t / 8) | 0) * k + a.padUV;
      dl.image(x + INSET, y + INSET, side - 2 * INSET, side - 2 * INSET, u0, v0, u0 + a.innerUV, v0 + a.innerUV, 1);
    }
  }
}
