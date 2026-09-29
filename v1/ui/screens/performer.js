// The Performance window: live performance over broadcast, on the P key. One
// pane holds the visual instrument: the interpolation time and the window's
// own opacity as two compact sliders in the title bar beside its name (the
// opacity first), then a dense row per visual layer with its main handles.
// The bank of text phrases and the text timing strip that used to sit under
// the layers are a window of their own now, on the T key
// (ui/screens/textbank.js); they ride this window's interpolation time all
// the same. Every handle in here writes through the ramp engine
// (core/perform.js perfSet), never a control's set directly, so a change
// glides in over the interpolation time instead of landing at once; the one
// exception is the interpolation slider itself, which is the time and so is
// always immediate (the window opacity is chrome, not performance, and is
// immediate too). A row whose value is mid-glide wears the accent on its
// label, the ramp glow.
//
// The window is the mixer's, shape for shape (ui/screens/mixer.js): the flat
// opaque #1a222c pane, a title bar that drags, edges that resize, a body
// that scrolls whatever does not fit, its place and size remembered in the
// UI state record under its own 'performer' slot, and a reload bringing it
// back open if it was left open. The slider, the label line, the dropdown
// and the row fitting it shares with the Text window live in
// ui/screens/perf-widgets.js; the dropdown's open menu is this window's own.
//
// Every control id in the layer rows is looked up once through the schema's
// byId at module load; an id the schema does not know is dropped silently,
// so a renamed control costs a handle, never a broken row.
import { byId } from '../../core/schema.js';
import { S } from '../../../js/state.js';
import { loadUiState, saveUiState } from '../../core/store.js';
import { perform, loadPerform, savePerform, setRampS, perfSet, perfRamping, perfLayer, perfLayerLevel } from '../../core/perform.js';
import { drawSwitch } from '../widgets.js';
import { COLOR, TYPE, W, MOTION } from '../theme.js';
import {
  css, C, CELL_H, baseline, hslider, targetPos, effectivePos, unitOf, posOf, fmtAt,
  makeDropdown, ddInput, ddDraw, ddCell, cellLabelLine, fitRow, drawRow, DD_BOX_H
} from './perf-widgets.js';

// ---------- sizes ----------
const WIN_W_DEF = 920, WIN_H_DEF = 720, WIN_MIN_W = 560, WIN_MIN_H = 360;
const RADIUS_WIN = 9, BAR_H = 33, BAR_GAP = 9, CLOSE_H = 22, CLOSE_PAD_X = 7;
// the resize grab bands: how far into and past the window an edge takes a
// press, and the corner's square
const GRAB_IN = 7, GRAB_OUT = 7, CORNER_GRAB = 16;
const PAD_X = 14, PAD_B = 12;
const RAMP_MAX = 60;
// The ramp slider's taper: an exponential curve through 0, so the short
// times a performance mostly lives in get most of the travel. RAMP_CURVE 4
// gives 0 to 5 s about the first 42% of the track and 1 to 20 s over half
// of it, while 60 s still sits at the far end. It snaps to whole seconds.
const RAMP_CURVE = 4, RAMP_EK = Math.exp(RAMP_CURVE) - 1;
function rampToU(v) { return v <= 0 ? 0 : Math.log(1 + (v / RAMP_MAX) * RAMP_EK) / RAMP_CURVE; }
function uToRamp(u) {
  const v = RAMP_MAX * (Math.exp(RAMP_CURVE * (u < 0 ? 0 : u > 1 ? 1 : u)) - 1) / RAMP_EK;
  // whole seconds: 0 (cut), 1, 2 ... 60
  const r = Math.round(v);
  return r > RAMP_MAX ? RAMP_MAX : r;
}
// The title bar's two sliders, just right of the title, the window opacity
// first: a micro-caps label, a readout slot, then the track. WIN_O_MIN is how faint
// the window may go and still be found again.
const RAMP_TRACK_W = 110, WINO_TRACK_W = 90, BAR_RO_W = 30;
const BAR_GROUP_GAP = 22, BAR_CLOSE_GAP = 14, BAR_TITLE_GAP = 20;
const WIN_O_DEF = 0.9, WIN_O_MIN = 0.2;
// A layer's row: the switch and name in a fixed left column, then the cells,
// on one line when they fit and wrapping onto more lines when they do not
// (see fitRow). Slider cells place their compact label before the track and
// their readout after it, all on one line.
const NAME_W = 88, SW_W = 30, SW_H = 16;
const BLOCK_PAD = 1;
// How far an off layer's row recedes: the black laid over its band, and how
// much its name and its handles give up (0.72 leaves the handles at 28%).
const OFF_SHADE = 0.22, OFF_NAME_DIM = 0.55, OFF_HANDLE_DIM = 0.72;
// A layer row's height. Its controls sit on one line with their labels
// beside them, so the row can run tighter than the Text window's CELL_H,
// which carries a label line over each control.
const ROW_H = 30;
// Slider cells grow by a fifth of their track (the readout beside it keeps
// its width), so each bar itself is 20% longer.
// DD_W fits the kaleidoscope's 'Set 12' with its chevron, no more.
const SLIDER_W = 138, STD_W = 100, COLOR_W = 205, DD_W = 92;
// The four shared columns' readouts are short (100%, 0.25×, 22.5Hz), so
// their value slot is tighter than a labelled slider's, closing the gap
// between columns without shortening the tracks.
const STD_VALUE_W = 32;
const PERF_CELL_GAP = 8, INLINE_VALUE_W = 42, INLINE_GAP = 7, INLINE_MIN_TRACK = 34;
// the shared columns' bar length, which every labelled slider matches
const STD_TRACK = STD_W - STD_VALUE_W - INLINE_GAP;
const PRESET_W = 284, CHOICE_W = 270, TOGGLE_W = 92;
const GRID_HEAD_H = 14, GRID_LABELS = ['OPACITY', 'SPEED', 'PULSE', 'CENTER FADE'];
// Each of the four shared columns wears its own colour, its header and every
// slider under it, so opacity, speed, pulse and centre fade can be told apart
// at a glance down the whole stack: blue, amber, magenta, green.
const GRID_TINTS = [css('#7fb2ff'), css('#ffb14a'), css('#ff6fcf'), css('#4fd6a0')];
const SWATCH = 15, SWATCH_GAP = 5;
// The floors, for a cell squeezed alone on its line: a slider keeps room
// for its longest compact label (CTR FD) and a usable track, its readout clipping
// away first; the colour keeps five swatches; a dropdown keeps a few
// characters and its chevron.
const SLIDER_MIN = 64, COLOR_MIN = 5 * SWATCH + 4 * SWATCH_GAP, DD_MIN = 96;

// ---------- the controls, verified once at load ----------
// A cell for a control the schema knows; null, dropped by the filters below,
// for one it does not. k is a stable index for hit and spring ids. w is the
// natural width, min the floor a squeezed cell stops at; dw the width it is
// drawn at, ln its line and ox its x on that line (all set by fitRow); lw
// the label's measured width, taken once.
let cellSeq = 0;
function cell(id, label, kind, w, group) {
  const c = typeof id === 'string' ? byId(id) : id;
  if (!c) return null;
  kind = kind || 'slider';
  w = w || SLIDER_W;
  const floor = kind === 'color' ? COLOR_MIN : kind === 'dd' ? DD_MIN : SLIDER_MIN;
  return { c, label, kind, w, min: Math.min(w, floor), dw: w, ln: 0, ox: 0, lw: -1, k: cellSeq++, group: group || '' };
}
// A cell pulled in toward the one before it by -px (fitRow's lead): the strobe's
// two dropdowns tuck into the room the Rate slider's short readout leaves.
function leadIn(cel, px) { if (cel) cel.lead = px; return cel; }
function stdCell(id) {
  const c = cell(id, '', 'slider', STD_W);
  if (c) c.vw = STD_VALUE_W;
  return c;
}
function emptyCell() {
  return { c: null, label: '', kind: 'empty', w: STD_W, min: STD_W, dw: STD_W,
    ln: 0, ox: 0, lw: 0, k: cellSeq++, group: '' };
}
function makeLayer(toggleId, name, cells) {
  const t = byId(toggleId);
  if (!t) return null;
  // the first four cells are the shared columns, each in its column's colour
  for (let i = 0; i < cells.length && i < GRID_TINTS.length; i++) if (cells[i]) cells[i].tint = GRID_TINTS[i];
  const row = { t, name, cells: cells.filter(Boolean), cellGap: PERF_CELL_GAP,
    fitW: -1, fitOver: false, linesH: ROW_H, cellH: ROW_H, k: cellSeq++ };
  for (const cel of row.cells) cel.row = row;
  // the first shared column is the layer's opacity, which its switch fades
  // through (perform.js perfLayer)
  const first = cells[0];
  if (first && first.kind === 'slider') { row.op = first; first.opOf = row; }
  row.shownOn = true; row.fadeLevel = undefined;
  return row;
}
// The strobe is the field layer; each other row's toggle is its layers-section
// switch from its own schema file. A layer's Pulse cell is its link to the
// strobe, so opacity can breathe with the flashes from right here. Every row
// leads with the same four columns: Opacity, Speed, Pulse, Center fade. An absent parameter
// gets an empty cell so every control stays under the same header. The strobe
// and fireworks use brightness for OP. Longer drawer labels stay untouched.
// The strobe's rate presets and colours as dropdowns. Neither is a control
// with options of its own, so each is a stand-in the dropdown can read: the
// real control's id (perfSet writes through to it, so a pick glides like any
// other change, and the ramp glow follows the real control), its get and
// format (the box names the actual value when it sits between the choices),
// and the choices themselves. The colour menu shows a swatch beside each
// name, and its box one of the colour now.
const RATE_MENU_HZ = [1, 2, 3, 4.5, 6, 8, 10, 40];
const TYPE_DD_W = 76, PRESET_DD_W = 62, COLOR_DD_W = 46, PART_DD_W = 96;
const FREQ = byId('freq'), COLOR_CTL = byId('color');
const RATE_MENU = FREQ && {
  id: FREQ.id, get: FREQ.get, format: FREQ.format,
  options: RATE_MENU_HZ.map(v => ({ value: v, label: v + ' Hz' }))
};
const SWATCHES = [
  ['#d400ff', 'Violet'], ['#b455ff', 'Purple'], ['#6ea8fe', 'Sky'], ['#00ccff', 'Cyan'],
  ['#00ffa2', 'Mint'], ['#4ad9a0', 'Jade'], ['#ffb13b', 'Amber'], ['#ff7ad9', 'Pink'],
  ['#ff5a5a', 'Red'], ['#ffffff', 'White']
];
const nowRgba = new Float32Array(4);
const COLOR_MENU = COLOR_CTL && {
  id: COLOR_CTL.id, get: COLOR_CTL.get, format: s => String(COLOR_CTL.get(s)).toUpperCase(),
  options: SWATCHES.map(([hex, name]) => ({ value: hex, label: name })),
  swatches: SWATCHES.map(([hex]) => css(hex)),
  // the box shows only the colour's dot; the open menu still names each one
  swatchOnly: true,
  swatch: () => {
    nowRgba[0] = S.rgb[0] / 255; nowRgba[1] = S.rgb[1] / 255; nowRgba[2] = S.rgb[2] / 255; nowRgba[3] = 1;
    return nowRgba;
  }
};
const LAYERS = [
  // The strobe leads with its field opacity, which dims the field alone
  // (Brightness is the flash signal every layer rides, so it stays in the
  // drawer). The fireworks have no opacity of their own; their brightness
  // stands in for it.
  makeLayer('lField', 'Strobe', [
    stdCell('fieldOpacity'), stdCell('freq'), stdCell('depth'), stdCell('fieldFade'),
    cell('depthVar', 'Var'),
    cell('varPeriod', 'Rate'),
    leadIn(cell(RATE_MENU, '', 'dd', PRESET_DD_W), -8),
    cell(COLOR_MENU, '', 'dd', COLOR_DD_W)
  ]),
  makeLayer('lEdge', 'Edge', [
    stdCell('edgeOpacity'), stdCell('edgeSpeed'), stdCell('edgePulse'), emptyCell(),
    cell('edgeFb', 'FB'),
    cell('edgeFbStream', 'STRM'),
    cell('edgeFbTwist', 'TWST')
  ]),
  // Corners have no Center Fade; Size and their look (Type) sit to the right.
  makeLayer('lCorners', 'Corner', [
    stdCell('cornerOpacity'), stdCell('cornerSpeed'), stdCell('cornerPulse'), emptyCell(),
    cell('cornerSize', 'SZ'),
    cell('cornerType', '', 'dd', TYPE_DD_W)
  ]),
  makeLayer('lRings', 'Rings', [
    stdCell('ringOpacity'), stdCell('ringSpeed'), stdCell('ringPulse'), stdCell('ringFade'),
    cell('ringDensity', 'DENS')
  ]),
  makeLayer('lKaleido', 'Kaleid', [
    stdCell('kaleidoOpacity'), stdCell('kaleidoSpeed'), stdCell('kaleidoPulse'), stdCell('kaleidoFade'),
    cell('kaleidoSet', '', 'dd', DD_W)
  ]),
  makeLayer('lFlowers', 'Flower', [
    stdCell('flowerOpacity'), stdCell('flowerSpeed'), stdCell('flowerPulse'), stdCell('flowerFade')
  ]),
  makeLayer('lParticles', 'Partic', [
    stdCell('partOpacity'), stdCell('partSpeed'), stdCell('partPulse'), stdCell('partFade'),
    cell('partRate', 'BIRTH'),
    cell('partFbOpacity', 'FB OP'),
    cell('partColor', '', 'dd', PART_DD_W)
  ]),
  makeLayer('lConfetti', 'Confet', [
    stdCell('confOpacity'), stdCell('confSpeed'), stdCell('confFbPulse'), stdCell('confFade'),
    cell('confFeedback', 'FB'),
    cell('confFbStream', 'STRM'),
    cell('confFbTwist', 'TWST'),
    cell('confFbTwistVarOn', 'VAR', 'toggle', TOGGLE_W)
  ])
  // The sound controls live in the Music window (music.js, on M).
  // Fireworks are out of the performance window for now; the row is kept
  // here to bring back.
  // makeLayer('lFireworks', 'Firewk', [
  //   stdCell('fwBright'), stdCell('fwSpeed'), emptyCell(), emptyCell(),
  //   cell('fwRate', 'DENS'),
  //   cell('fwSize', 'SZ')
  // ])
  // The text layer's own row lives in the Text window (textbank.js, on T),
  // with the phrase bank and the fades, so every text control is in one place.
].filter(Boolean);

// placed says x and y hold a real position, as the mixer's does: a window
// dragged partly off the left edge has a legitimate negative x. winO is the
// whole window's opacity, set from the title bar.
export const performer = {
  open: false, placed: false, x: 0, y: 0, w: WIN_W_DEF, h: WIN_H_DEF, winO: WIN_O_DEF,
  rx: 0, ry: 0, rw: 0, rh: 0,   // where it was drawn last frame (rw 0: not showing), for stacking
  grabX: 0, grabY: 0, grabW: 0, grabH: 0, dragging: false, resizing: false, resizingH: false, resizingC: false
};

// ---------- persistence, the mixer's pattern in a 'performer' slot ----------
// A reload brings the window back as it was left: open or shut, where it
// sat, how big it was and how see-through it was.
let restored = false;
const saved = { open: false, placed: false, x: 0, y: 0, w: 0, h: 0, winO: WIN_O_DEF };
// true while the hand is on the opacity slider (set in barSliders)
let winOHeld = false;
function clampWinO(v) { return v < WIN_O_MIN ? WIN_O_MIN : v > 1 ? 1 : v; }
function round2(v) { return Math.round(v * 100) / 100; }
function restore() {
  restored = true;
  const all = loadUiState();
  const m = all && all.performer && typeof all.performer === 'object' ? all.performer : null;
  // a reload brings the window back as it was left, open or shut
  performer.open = false;
  if (m) {
    performer.open = m.open === true;
    if (m.placed && Number.isFinite(m.x) && Number.isFinite(m.y)) { performer.placed = true; performer.x = m.x; performer.y = m.y; }
    if (Number.isFinite(m.width)) performer.w = m.width;
    if (Number.isFinite(m.height)) performer.h = m.height;
    if (Number.isFinite(m.winO)) performer.winO = clampWinO(m.winO);
  }
  // The ramp time (and the set list the Text window keeps) come with the
  // window the first time it is asked for, in case main has not pulled them
  // in yet; a record already loaded is left exactly as it is.
  if (!perform.texts) loadPerform();
  remember();
}
function remember() {
  saved.open = performer.open; saved.placed = performer.placed;
  saved.x = Math.round(performer.x); saved.y = Math.round(performer.y);
  saved.w = Math.round(performer.w); saved.h = Math.round(performer.h);
  saved.winO = round2(performer.winO);
}
// Held off while a drag of any kind is under way (the opacity slider
// included), so the record is written once on release, not per frame.
function persist() {
  if (performer.dragging || performer.resizing || performer.resizingH || performer.resizingC || winOHeld) return;
  if (saved.open === performer.open && saved.placed === performer.placed &&
      saved.x === Math.round(performer.x) && saved.y === Math.round(performer.y) &&
      saved.w === Math.round(performer.w) && saved.h === Math.round(performer.h) &&
      saved.winO === round2(performer.winO)) return;
  remember();
  saveUiState({ performer: { open: saved.open, placed: saved.placed, x: saved.x, y: saved.y,
    width: saved.w, height: saved.h, winO: saved.winO } });
}

// per-frame layout scalars, module level as the mixer keeps them
let bodyX = 0, bodyW = 0, viewTop = 0, viewBot = 0;
// the window's height with every row showing, measured each frame
let fitH = 0;
function off(top, h) { return top + h < viewTop || top > viewBot; }

// ---------- the dropdown ----------
// This window's own open menu (ui/screens/perf-widgets.js makeDropdown), so
// a menu open here is never shut or steered by the Text window's.
const dd = makeDropdown();

// ---------- the cells ----------
// The sliders and the dropdown are shared with the Text window; the colour,
// the rate presets, the choices and the toggle are this window's alone.

function choicesCell(ui, cel, x, top) {
  const c = cel.c, dl = ui.dl, options = c.options || [];
  cellLabelLine(ui, cel, x, top, null);
  if (!options.length) return;
  const gap = 4, h = 19, y = cel.label ? top + 14 : top + (ROW_H - h) / 2;
  const bw = (cel.dw - gap * (options.length - 1)) / options.length;
  const target = targetPos(c);
  for (let i = 0; i < options.length; i++) {
    const bx = x + i * (bw + gap), option = options[i];
    const id = ui.idx('perf.choice', cel.k * 16 + i);
    ui.interact(id, bx, y, bw, h, false);
    const hover = ui.hover, selected = target === option.value;
    if (hover) ui.setCursorHint('pointer');
    if (ui.clicked && !selected) perfSet(c.id, option.value, true);
    dl.rect(bx, y, bw, h, 4, selected ? COLOR.accentSoft : C.btnBg, 1,
      selected ? COLOR.accent : hover ? C.btnBorderHover : C.btnBorder, 0, 0);
    ui.text.draw(dl, option.label, bx + bw / 2, baseline(ui, y + h / 2, TYPE.micro),
      TYPE.micro, W.semibold, selected ? COLOR.accent : C.cellLabel, 1, 0, 1);
  }
}
function toggleCell(ui, cel, x, top) {
  // One inline line like the sliders: the label, then the switch and its
  // On/Off, all centred on the row.
  const c = cel.c, dl = ui.dl, on = !!targetPos(c);
  const cy = top + ROW_H / 2, y = cy - SW_H / 2, id = ui.idx('perf.toggle', cel.k);
  const labelW = cel.label ? ui.text.measure(cel.label, TYPE.micro, W.semibold) : 0;
  const sx = x + (cel.label ? labelW + INLINE_GAP : 0);
  // Sized to what it draws (label, switch, and the wider of On and Off), not
  // a slider's width: the extra reserve wrapped the row long before the
  // window's edge reached anything. Measured on the first draw; the row
  // refits once for it.
  if (cel.offW === undefined) cel.offW = ui.text.measure('Off', TYPE.xs, W.regular);
  const want = Math.ceil((sx - x) + SW_W + 8 + cel.offW);
  if (cel.w !== want) {
    cel.w = want;
    if (cel.min > want) cel.min = want;
    if (cel.row) cel.row.fitW = -1;
  }
  ui.interact(id, x - 3, y - 3, cel.dw + 6, SW_H + 6, false);
  if (ui.hover) ui.setCursorHint('pointer');
  if (ui.clicked) perfSet(c.id, !on, ui.pointerShift);
  if (cel.label) ui.text.draw(dl, cel.label, x, baseline(ui, cy, TYPE.micro), TYPE.micro, W.semibold,
    perfRamping(c.id) ? COLOR.accent : C.cellLabel, 0, 0.08, 1);
  const a = ui.spring(ui.idx('perf.toggleA', cel.k), on ? 1 : 0, MOTION.hover);
  drawSwitch(ui, sx, y, SW_W, SW_H, a, on);
  ui.text.draw(dl, on ? 'On' : 'Off', sx + SW_W + 8, baseline(ui, cy, TYPE.xs),
    TYPE.xs, W.regular, on ? C.name : C.nameOff, 0, 0, 1);
}
function drawCell(ui, cel, x, top) {
  if (cel.kind === 'empty') return;
  // ddCell leaves 13px over its box for a label line; this window's
  // dropdowns have none, so the box is lifted to sit centred on the row
  // with the inline sliders beside it.
  if (cel.kind === 'dd') ddCell(ui, dd, cel, x, top + (ROW_H - DD_BOX_H) / 2 - 13, true);
  else if (cel.kind === 'choices') choicesCell(ui, cel, x, top);
  else if (cel.kind === 'toggle') toggleCell(ui, cel, x, top);
  else inlineSliderCell(ui, cel, x, top);
}

// Performance sliders are one compact horizontal sentence: short label,
// track, then a fixed right-aligned value. Nothing is stacked above the
// track, and neither the track nor its neighbours move as the value changes.
// Drawer readouts can contain explanatory tails (Particle Speed includes its
// resulting flight time); Performance keeps only the immediate setting.
function compactSliderValue(c, pos) {
  let value = fmtAt(c, pos);
  const extra = value.indexOf(' · ');
  if (extra >= 0) value = value.slice(0, extra);
  value = value.replace(' / cycle', '').replace(' / min', '/m').replace(/ (s|Hz|×|%)/g, '$1');
  // a number with words after it ('+0.25 clockwise', '-0.40 in') keeps just
  // the signed number, which already says the direction, so every readout
  // fits the grid's narrow number column
  value = value.replace(/^([-+]?\d+(?:\.\d+)?[a-z%×/]*)\s+[a-z].*$/i, '$1');
  if (!/[-+]?\d/.test(value) && typeof pos === 'number') {
    if (c.min === 0 && c.max === 100) return Math.round(pos) + '%';
    const step = c.step || 1, decimals = step < 1 ? Math.min(2, (String(step).split('.')[1] || '').length) : 0;
    return pos.toFixed(decimals);
  }
  return value;
}
function inlineSliderCell(ui, cel, x, top) {
  const c = cel.c, live = c.get(S);
  let tgt = targetPos(c), fill = live;
  // A layer's opacity follows its switch: the fill runs down with a
  // fade-out and sits empty while the layer is off, the handle staying at
  // the level it will come back to.
  const L = cel.opOf;
  if (L) {
    if (L.fadeLevel !== undefined) tgt = L.fadeLevel;
    else if (!L.shownOn) fill = c.min ?? 0;
  }
  const labelW = ui.text.measure(cel.label, TYPE.micro, W.semibold);
  // A labelled slider is sized to its own label: the label, then exactly the
  // shared columns' bar and readout, so the cells right of the grid keep the
  // grid's rhythm instead of a fixed width that left short labels with a
  // longer bar and a wider gap. Measured on the first draw; the row refits
  // once for it.
  if (cel.label) {
    // the grid's own number column too (STD_VALUE_W), not the wider inline
    // one: that mismatch is what left every cell right of the grid carrying
    // ten spare pixels and a shorter bar
    if (!cel.vw) cel.vw = STD_VALUE_W;
    const want = Math.ceil(labelW + INLINE_GAP + STD_TRACK + INLINE_GAP + cel.vw);
    if (cel.w !== want) {
      cel.w = want;
      if (cel.min > want) cel.min = want;
      if (cel.row) cel.row.fitW = -1;
    }
  }
  const tx = x + (cel.label ? labelW + INLINE_GAP : 0);
  const valueX = x + cel.dw;
  const trackRight = valueX - (cel.vw || INLINE_VALUE_W) - INLINE_GAP;
  const tw = Math.max(INLINE_MIN_TRACK, trackRight - tx), cy = top + ROW_H / 2;
  const sid = ui.idx('perf.sl', cel.k);
  const glow = ui.spring(ui.idx('perf.slGlow', cel.k), perfRamping(c.id) ? 1 : 0, MOTION.fade);
  const effective = effectivePos(c);
  const u = hslider(ui, sid, tx, cy, tw,
    unitOf(c, typeof tgt === 'number' ? tgt : live), unitOf(c, fill), false, glow,
    effective === undefined ? undefined : unitOf(c, effective), cel.tint);
  if (u >= 0) {
    const np = posOf(c, u);
    if (np !== tgt) perfSet(c.id, np, ui.pointerShift);
  }

  const ramping = perfRamping(c.id), base = baseline(ui, cy, TYPE.micro);
  ui.text.draw(ui.dl, cel.label, x, base, TYPE.micro, W.semibold,
    ramping ? COLOR.accent : C.cellLabel, 0, 0.08, 1);
  ui.text.draw(ui.dl, compactSliderValue(c, L && L.fadeLevel !== undefined ? L.fadeLevel : targetPos(c)), trackRight + INLINE_GAP, base,
    TYPE.micro, W.regular, C.value, 0, 0, 1);
}

// ---------- the title bar's sliders ----------
// Interpolation, the one immediate performance control: how long every other
// change in this window takes to glide in. 0 is a hard cut. Saved once the
// hand lets go, not per drag frame. Beside it the window's own opacity,
// immediate as well, kept with the window's geometry.
const rampTexts = new Map();
function fmtRamp(v) {
  let t = rampTexts.get(v);
  if (t === undefined) {
    if (rampTexts.size > 200) rampTexts.clear();
    t = v <= 0 ? 'cut' : Math.round(v) + 's';
    rampTexts.set(v, t);
  }
  return t;
}
// The window opacity's readout, one string per whole percent, made once.
const PCT_TEXT = new Array(101);
for (let i = 0; i <= 100; i++) PCT_TEXT[i] = i + '%';
let rampDirty = false;
// Measured once, on the first frame that draws the bar.
const TITLE = 'PERFORMANCE', WIN_O_LABEL = 'WINDOW OP';
let titleW = -1, rampLblW = 0, winOLblW = 0;
function capsW(ui, str, size, track) {
  return ui.text.measure(str, size, W.semibold) + str.length * size * track;
}
// One bar slider, read as one phrase the way a row's sliders are: its caps
// label (when shown) snug against the track's left end, the track from tx,
// and the readout just past its right end, the space between groups kept
// wider than any gap inside one.
function barLabels(ui, label, lblW, readout, tx, trackW, cy, showLabel) {
  const dl = ui.dl, base = baseline(ui, cy, TYPE.micro);
  ui.text.draw(dl, readout, tx + trackW + INLINE_GAP, base, TYPE.micro, W.regular, C.value, 0, 0, 1);
  if (showLabel) {
    ui.text.draw(dl, label, tx - INLINE_GAP - lblW, base, TYPE.micro, W.semibold,
      C.sectionInk, 0, 0.08, 1);
  }
}
// Lays the two bar sliders out left to right just after the title (which
// starts at titleX), the window opacity first and the ramp after it, never
// past rightX, the close button's left edge less its gap. When room is short
// the labels go first, then the ramp, then the opacity, so the one nearest
// the title is the last to leave and neither the title nor the close button
// is ever overlapped.
function barSliders(ui, titleX, rightX, cy) {
  if (titleW < 0) {
    titleW = capsW(ui, TITLE, 11, 0.13);
    rampLblW = capsW(ui, 'RAMP', TYPE.micro, 0.08);
    winOLblW = capsW(ui, WIN_O_LABEL, TYPE.micro, 0.08);
  }
  const leftX = titleX + titleW + BAR_TITLE_GAP;
  const slot = INLINE_GAP + BAR_RO_W;
  const rampBare = RAMP_TRACK_W + slot, winOBare = WINO_TRACK_W + slot;
  const rampFull = rampBare + rampLblW + INLINE_GAP, winOFull = winOBare + winOLblW + INLINE_GAP;
  const room = rightX - leftX;
  let showLabels = true, showWinO = true, showRamp = true;
  if (winOFull + BAR_GROUP_GAP + rampFull > room) {
    showLabels = false;
    if (winOBare + BAR_GROUP_GAP + rampBare > room) {
      showRamp = false;
      showLabels = winOFull <= room;
      if (winOBare > room) showWinO = false;
    }
  }
  const rampId = ui.id('perf.ramp'), winOId = ui.id('perf.winO');
  // the ramp's record is written once its hand lets go, whether or not the
  // slider is still showing
  if (rampDirty && ui.activeId !== rampId) { savePerform(); rampDirty = false; }
  winOHeld = false;
  let gx = leftX;
  if (showWinO) {
    const tx = gx + (showLabels ? winOLblW + INLINE_GAP : 0);
    const wu = (performer.winO - WIN_O_MIN) / (1 - WIN_O_MIN);
    const nu = hslider(ui, winOId, tx, cy, WINO_TRACK_W, wu, wu, false);
    if (ui.hover || ui.pressed) overBtn = true;
    if (nu >= 0) {
      winOHeld = true;
      performer.winO = clampWinO(round2(WIN_O_MIN + nu * (1 - WIN_O_MIN)));
    }
    barLabels(ui, WIN_O_LABEL, winOLblW, PCT_TEXT[Math.round(performer.winO * 100)], tx, WINO_TRACK_W, cy, showLabels);
    gx = tx + WINO_TRACK_W + slot + BAR_GROUP_GAP;
  }
  if (showRamp) {
    const tx = gx + (showLabels ? rampLblW + INLINE_GAP : 0);
    const v = typeof perform.rampS === 'number' ? perform.rampS : 0;
    const ru = rampToU(v);
    const u = hslider(ui, rampId, tx, cy, RAMP_TRACK_W, ru, ru, false);
    if (ui.hover || ui.pressed) overBtn = true;
    if (u >= 0) {
      const nv = uToRamp(u);
      if (nv !== v) { setRampS(nv); rampDirty = true; }
    }
    barLabels(ui, 'RAMP', rampLblW, fmtRamp(v), tx, RAMP_TRACK_W, cy, showLabels);
  }
}

// ---------- a layer's block ----------
function gridHeader(ui) {
  const top = ui.cursorY;
  ui.spacer(GRID_HEAD_H);
  if (off(top, GRID_HEAD_H)) return;
  const x0 = bodyX + NAME_W;
  const trackW = STD_W - STD_VALUE_W - INLINE_GAP;
  for (let i = 0; i < GRID_LABELS.length; i++) {
    const x = x0 + i * (STD_W + PERF_CELL_GAP);
    ui.text.draw(ui.dl, GRID_LABELS[i], x + trackW / 2,
      baseline(ui, top + GRID_HEAD_H / 2, TYPE.micro), TYPE.micro, W.semibold,
      GRID_TINTS[i], 1, 0.08, 1);
  }
}

function layerBlock(ui, L, index) {
  const availW = bodyW - NAME_W;
  fitRow(L, availW);
  const h = BLOCK_PAD * 2 + L.linesH;
  const top = ui.cursorY;
  ui.spacer(h);
  if (off(top, h)) return;
  const dl = ui.dl;
  // Alternating full-width bands keep a wide row visually connected from
  // its layer name through its last control. A control still travelling
  // through its performance ramp gets a quiet accent wash until it settles.
  let ramping = false;
  for (let i = 0; i < L.cells.length && !ramping; i++) {
    const c = L.cells[i].c;
    if (c) ramping = perfRamping(c.id);
  }
  const bandX = bodyX - PAD_X, bandW = bodyW + PAD_X * 2;
  if (index & 1) dl.rect(bandX, top, bandW, h, 0, C.rowAlt, 0, null, 0, 0);
  if (ramping) dl.rect(bandX, top, bandW, h, 0, C.rowRamp, 0, null, 0, 0);
  if (index > 0) dl.rect(bandX, top, bandW, 1, 0, C.rowLine, 0, null, 0, 0);
  // a layer fading out already reads as off
  L.fadeLevel = perfLayerLevel(L.t.id);
  const on = L.fadeLevel === undefined && !!targetPos(L.t);
  L.shownOn = on;
  // the switch, through perfSet on the layer's own toggle id
  const swY = top + BLOCK_PAD + (ROW_H - SW_H) / 2;
  const hid = ui.idx('perf.lsw', L.k);
  ui.interact(hid, bodyX - 4, swY - 6, SW_W + 12, SW_H + 12, false);
  if (ui.hover) ui.setCursorHint('pointer');
  // fades over the ramp time through the layer's opacity; shift-click cuts
  if (ui.clicked) perfLayer(L.t.id, L.op ? L.op.c.id : null, !on, ui.pointerShift);
  const onA = ui.spring(ui.idx('perf.lswA', L.k), on ? 1 : 0, MOTION.hover);
  // An off row reads as off at a glance: its band shaded darker, its name
  // and its handles dimmed well down, all eased on the switch's own spring
  // so turning a layer on or off fades the row rather than snapping it.
  const dim = 1 - onA;
  if (dim > 0.002) {
    const sh = ui.scratch0;
    sh[0] = 0; sh[1] = 0; sh[2] = 0; sh[3] = OFF_SHADE * dim;
    dl.rect(bandX, top + (index > 0 ? 1 : 0), bandW, h - (index > 0 ? 1 : 0), 0, sh, 0, null, 0, 0);
  }
  drawSwitch(ui, bodyX, swY, SW_W, SW_H, onA, on);
  ui.text.draw(dl, L.name, bodyX + SW_W + 10, baseline(ui, top + BLOCK_PAD + ROW_H / 2, TYPE.sm),
    TYPE.sm, W.semibold, on ? C.name : C.nameOff, 0, 0.02, 1 - OFF_NAME_DIM * dim);
  // the handles stay live while the layer is off, only dimmed, so a scene
  // can be set up in the dark and switched on ready
  const handleA = 1 - OFF_HANDLE_DIM * dim;
  if (handleA < 0.998) dl.pushAlpha(handleA);
  drawRow(ui, L, bodyX + NAME_W, top + BLOCK_PAD, availW, drawCell);
  if (handleA < 0.998) dl.popAlpha();
}

// ---------- the window ----------
let btnHover = false, overBtn = false;
function barHit(ui, name, x, y, w, h) {
  ui.interact(ui.id(name), x, y, w, h, false);
  btnHover = ui.hover;
  if (ui.hover) { ui.setCursorHint('pointer'); overBtn = true; }
  return ui.clicked;
}

// fade is the chrome's pass-through, as the mixer takes it; main hands the
// floating windows 1, so an open performer holds at full strength.
export function drawPerformer(ui, app, fade = 1) {
  if (!restored) restore();
  persist();
  const open = ui.spring('perf.open', performer.open ? 1 : 0, MOTION.panel);
  const o = open * fade;
  if (o < 0.002) { performer.rw = 0; winOHeld = false; return; }
  const width = app.width, height = app.height;

  const maxW = Math.max(320, width - 24), minW = Math.min(WIN_MIN_W, maxW);
  const winW = Math.max(minW, Math.min(performer.w, maxW));
  // The window is never taller than its rows (last frame's measure, 0
  // before the first one): the saved or default height is a ceiling, so it
  // opens fitted and a drag down past the last row stops there.
  let maxH = Math.max(BAR_H + 120, height - 24);
  if (fitH > 0) maxH = Math.min(maxH, fitH);
  const minH = Math.min(WIN_MIN_H, maxH);
  const winH = Math.max(minH, Math.min(performer.h, maxH));
  // first showing: centred, a little down from the top
  if (!performer.placed) {
    performer.placed = true;
    performer.x = Math.max(12, (width - winW) / 2);
    performer.y = Math.max(12, Math.min(48, height - winH - 12));
  }
  // keep the title bar reachable after any resize
  performer.x = Math.max(12 - winW + 80, Math.min(performer.x, width - 80));
  performer.y = Math.max(12, Math.min(performer.y, height - BAR_H - 12));
  const x = performer.x, y = performer.y + (1 - open) * 16;   // slides on open and shut only
  performer.rx = x; performer.ry = y; performer.rw = winW; performer.rh = winH;
  const dl = ui.dl;

  ui.pushScope(ui.id('perf'));
  // the whole window, chrome and body, at the opacity its title bar sets
  dl.pushAlpha(o * performer.winO);
  overBtn = false;

  // the open menu's rows, from last frame's rect, claim their presses before
  // anything else in the window can
  ddInput(ui, dd);
  dd.drawn = false;

  // ---- pane and header ----
  dl.rect(x, y, winW, winH, RADIUS_WIN, C.pane, 1, C.paneBorder, 10, 0.35);
  dl.pushClip(x + 1, y + 1, winW - 2, BAR_H - 1);
  dl.rect(x + 1, y + 1, winW - 2, BAR_H + RADIUS_WIN, RADIUS_WIN - 1, C.bar, 0, null, 0, 0);
  dl.popClip();
  dl.rect(x + 1, y + BAR_H, winW - 2, 1, 0, C.barLine, 0, null, 0, 0);
  const cy = y + 1 + (BAR_H - 1) / 2;
  ui.text.draw(dl, TITLE, x + 1 + 13, baseline(ui, cy, 11), 11, W.semibold, C.title, 0, 0.13, 1);

  const closeW = ui.text.measure('×', 18, W.regular) + CLOSE_PAD_X * 2 + 2;
  const closeX = x + winW - 1 - 8 - closeW;
  if (barHit(ui, 'perf.close', closeX, cy - CLOSE_H / 2, closeW, CLOSE_H)) performer.open = false;
  dl.rect(closeX, cy - CLOSE_H / 2, closeW, CLOSE_H, 6, C.btnBg, 1,
    btnHover ? C.closeHoverBorder : C.btnBorder, 0, 0);
  ui.text.draw(dl, '×', closeX + closeW / 2, baseline(ui, cy, 18), 18, W.regular,
    btnHover ? C.closeHoverInk : C.btnInk, 1, 0, 1);
  // the window opacity and the ramp, just right of the title, laid before
  // the drag below so they take their presses first and set overBtn to keep
  // the grab cursor off them
  barSliders(ui, x + 1 + 13, closeX - BAR_CLOSE_GAP, cy);

  // ---- lower right corner: both at once ----
  // Run first, so where it overlaps the two edges below it wins the press.
  // The edges and the corner reach GRAB_OUT past the window and GRAB_IN into
  // it, a wide enough band to find without hunting for a hairline.
  ui.interact(ui.id('perf.resizeC'), x + winW - CORNER_GRAB, y + winH - CORNER_GRAB,
    CORNER_GRAB + GRAB_OUT, CORNER_GRAB + GRAB_OUT, false);
  if (ui.pressed) {
    if (!performer.resizingC) {
      performer.resizingC = true;
      performer.grabW = ui.pointerX - (x + winW); performer.grabH = ui.pointerY - (y + winH);
    }
    performer.w = Math.max(minW, Math.min(ui.pointerX - performer.grabW - x, maxW));
    performer.h = Math.max(minH, Math.min(ui.pointerY - performer.grabH - y, maxH));
    ui.setCursorHint('nwse-resize');
  } else {
    if (performer.resizingC) { performer.w = winW; performer.h = winH; }
    performer.resizingC = false;
    if (ui.hover) { ui.setCursorHint('nwse-resize'); overBtn = true; }
  }
  // The edges' bands overlap the corner's square, and the last cursor hint
  // set wins, so over the corner the edges below leave the cursor alone.
  const cornerHot = ui.hover || performer.resizingC;
  // the grip: three dots on the diagonal, so the corner says it can be pulled
  for (let g = 0; g < 3; g++) {
    const gx = x + winW - 6 - g * 4, gy = y + winH - 6;
    for (let h2 = 0; h2 <= g; h2++) dl.rect(gx + h2 * 4 - 1, gy - h2 * 4 - 1, 2, 2, 1, C.cellLabel, 0, null, 0, 0);
  }

  // ---- right edge: horizontal resize ----
  ui.interact(ui.id('perf.resize'), x + winW - GRAB_IN, y, GRAB_IN + GRAB_OUT, winH, false);
  if (ui.pressed) {
    if (!performer.resizing) { performer.resizing = true; performer.grabW = ui.pointerX - (x + winW); }
    performer.w = Math.max(minW, Math.min(ui.pointerX - performer.grabW - x, maxW));
    ui.setCursorHint('ew-resize');
  } else {
    if (performer.resizing) performer.w = winW;
    performer.resizing = false;
    if (ui.hover && !cornerHot) { ui.setCursorHint('ew-resize'); overBtn = true; }
  }

  // ---- bottom edge: vertical resize ----
  ui.interact(ui.id('perf.resizeH'), x, y + winH - GRAB_IN, winW, GRAB_IN + GRAB_OUT, false);
  if (ui.pressed) {
    if (!performer.resizingH) { performer.resizingH = true; performer.grabH = ui.pointerY - (y + winH); }
    performer.h = Math.max(minH, Math.min(ui.pointerY - performer.grabH - y, maxH));
    ui.setCursorHint('ns-resize');
  } else {
    if (performer.resizingH) performer.h = winH;
    performer.resizingH = false;
    if (ui.hover && !cornerHot) { ui.setCursorHint('ns-resize'); overBtn = true; }
  }

  // ---- title bar drag, the offset taken on press so the window never jumps ----
  ui.interact(ui.id('perf.drag'), x, y, winW, BAR_H, false);
  if (ui.pressed) {
    if (!performer.dragging) { performer.dragging = true; performer.grabX = ui.pointerX - performer.x; performer.grabY = ui.pointerY - performer.y; }
    performer.x = ui.pointerX - performer.grabX; performer.y = ui.pointerY - performer.grabY;
    ui.setCursorHint('grabbing');
  } else {
    performer.dragging = false;
    if (ui.hover && !overBtn) ui.setCursorHint('grab');
  }

  // ---- body ----
  const cx0 = ui.cursorX, cy0 = ui.cursorY, cw0 = ui.regionW;
  const bodyTop = y + BAR_H + 1, bodyH = winH - BAR_H - 2;
  viewTop = bodyTop; viewBot = bodyTop + bodyH;
  ui.setCursor(x + 1, bodyTop, winW - 2);
  ui.scroll('perf.body', bodyH);
  const contentTop = ui.cursorY;
  bodyX = ui.cursorX + PAD_X; bodyW = ui.regionW - PAD_X * 2;
  gridHeader(ui);
  for (let i = 0; i < LAYERS.length; i++) layerBlock(ui, LAYERS[i], i);

  ui.spacer(PAD_B);
  fitH = BAR_H + 2 + Math.ceil(ui.cursorY - contentTop);
  ui.endScroll();
  ui.setCursor(cx0, cy0, cw0);

  // a menu whose box was not drawn this frame (its row scrolled away) is
  // dropped; a live one is painted here, over everything the body drew
  if (dd.ctrl && !dd.drawn) dd.ctrl = null;
  ddDraw(ui, dd);

  // clicks on empty pane stop here instead of reaching the drawer or field
  ui.interact(ui.id('perf.backstop'), x, y, winW, winH, false);
  dl.popAlpha();
  ui.popScope();
}
