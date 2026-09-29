// The Text window: the bank of phrases for live performance over broadcast,
// on the T key. It was the foot of the Performance window (ui/screens/
// performer.js) and now stands on its own, working just as it did there: a
// row per phrase, each an editable field with its own Go that sends it to
// the screen now and a small delete, a + Add under the list up to TEXT_MAX
// phrases, and under that the text timing strip, the two fade durations, the
// on-screen hold, and the arrive and leave effects.
//
// Every handle in the timing strip writes through the ramp engine
// (core/perform.js perfSet), never a control's set directly, so a change
// glides in over the interpolation time set on the Performance window's RAMP
// slider; shift held on the press lands it at once. The knob parks where it
// was sent, the fill shows the live value gliding over with its pulse, and
// the readout names the destination. The phrases themselves are
// perform.texts, edited on commit only, never per keystroke.
//
// The window is the Performance window's, shape for shape: the flat opaque
// #1a222c pane, a title bar that drags, edges that resize, its place, size
// and opacity remembered in the UI state record under its own 'textbank'
// slot, and a reload bringing it back open if it was left open. Its title
// bar carries its own WINDOW opacity slider, and it has no RAMP of its own.
// The phrase list takes whatever height the window has to spare and scrolls
// what does not fit, so a taller window shows more phrases; the timing strip
// sits at the window's foot.
import { byId } from '../../core/schema.js';
import { loadUiState, saveUiState } from '../../core/store.js';
import { perform, loadPerform, savePerform, triggerText, perfSet } from '../../core/perform.js';
import { makeTextState, TEXT_COMMIT, TEXT_EDITING, drawSwitch } from '../widgets.js';
import { COLOR, TYPE, W, MOTION } from '../theme.js';
import {
  C, CELL_H, DD_MENU_MIN_W, baseline, hslider, makeDropdown, ddInput, ddDraw, ddCell,
  sliderCell, fitRow, drawRow, cellLabelLine, targetPos
} from './perf-widgets.js';

// ---------- sizes ----------
const WIN_W_DEF = 560, WIN_H_DEF = 720, WIN_MIN_W = 420, WIN_MIN_H = 140;
const RADIUS_WIN = 9, BAR_H = 33, CLOSE_H = 22, CLOSE_PAD_X = 7;
// the resize grab bands: how far into and past the window an edge takes a
// press, and the corner's square
const GRAB_IN = 7, GRAB_OUT = 7, CORNER_GRAB = 16;
const PAD_X = 14, PAD_T = 6, PAD_B = 12;
// The title bar's window opacity slider, just right of the title: a
// micro-caps label, a readout slot, then the track. WIN_O_MIN is how faint
// the window may go and still be found again.
const WINO_TRACK_W = 90, BAR_RO_W = 30, BAR_LBL_GAP = 6, BAR_RO_GAP = 10;
const BAR_CLOSE_GAP = 14, BAR_TITLE_GAP = 20;
const WIN_O_DEF = 0.9, WIN_O_MIN = 0.2;
// The bank: a row per phrase, a Go and a delete on its right, at most
// TEXT_MAX rows. The list is never shorter than LIST_MIN_ROWS, whatever the
// window's height; below that the body scrolls as a whole.
const TROW_H = 34, FIELD_H = 26, GO_W = 38, DEL_W = 20, LIST_MIN_ROWS = 2, TEXT_MAX = 99;
const ADD_H = 28, HINT_H = 18;
// The timing strip's cells, and the room above them for the rule that
// parts the strip from the bank.
const SLIDER_MIN = 64, DD_MIN = 96, TIMING_W = 114, TIMING_TOP = 12;

// ---------- the timing controls, verified once at load ----------
// A cell for a control the schema knows; null, dropped by the filter below,
// for one it does not, so a renamed control costs a handle, never the strip.
let cellSeq = 0;
function cell(id, label, kind, w) {
  const c = byId(id);
  if (!c) return null;
  return { c, label, kind, w, min: Math.min(w, kind === 'dd' ? DD_MIN : SLIDER_MIN), dw: w, ln: 0, ox: 0, lw: -1, k: cellSeq++ };
}
// The text layer's own row, moved here from the Performance window: its
// switch, its opacity and where its words come from, above the phrase bank.
// Every one goes through perfSet like the rest; the switch and the source
// land at once, as switches do.
const LAYER_SW_W = 30, LAYER_SW_H = 16, TOGGLE_W = 76, CHOICE_W = 270, LAYER_GAP = 10;
const LAYER = {
  cells: [
    cell('lText', 'TEXT', 'toggle', TOGGLE_W),
    cell('textOpacity', 'OPACITY', 'slider', TIMING_W),
    cell('textMode', 'SOURCE', 'choices', CHOICE_W)
  ].filter(Boolean),
  fitW: -1, fitOver: false, linesH: CELL_H
};
const TIMING = {
  cells: [
    cell('textFadeIn', 'FADE IN', 'slider', TIMING_W),
    cell('textFadeOut', 'FADE OUT', 'slider', TIMING_W),
    cell('textDwell', 'HOLD', 'slider', TIMING_W),
    cell('textFxIn', 'ARRIVE', 'dd', DD_MENU_MIN_W),
    cell('textFxOut', 'LEAVE', 'dd', DD_MENU_MIN_W)
  ].filter(Boolean),
  fitW: -1, fitOver: false, linesH: CELL_H
};
// this window's own open menu, never the Performance window's
const dd = makeDropdown();
function toggleCell(ui, cel, x, top) {
  const c = cel.c, dl = ui.dl, on = !!targetPos(c);
  cellLabelLine(ui, cel, x, top, null);
  const y = top + 16, id = ui.idx('tb.toggle', cel.k);
  ui.interact(id, x - 3, y - 3, cel.dw + 6, LAYER_SW_H + 6, false);
  if (ui.hover) ui.setCursorHint('pointer');
  if (ui.clicked) perfSet(c.id, !on, true);
  const a = ui.spring(ui.idx('tb.toggleA', cel.k), on ? 1 : 0, MOTION.hover);
  drawSwitch(ui, x, y, LAYER_SW_W, LAYER_SW_H, a, on);
  ui.text.draw(dl, on ? 'On' : 'Off', x + LAYER_SW_W + 8, baseline(ui, y + LAYER_SW_H / 2, TYPE.xs),
    TYPE.xs, W.regular, on ? C.name : C.nameOff, 0, 0, 1);
}
function choicesCell(ui, cel, x, top) {
  const c = cel.c, dl = ui.dl, options = c.options || [];
  cellLabelLine(ui, cel, x, top, null);
  if (!options.length) return;
  const gap = 4, y = top + 14, h = 19;
  const bw = (cel.dw - gap * (options.length - 1)) / options.length;
  const target = targetPos(c);
  for (let i = 0; i < options.length; i++) {
    const bx = x + i * (bw + gap), option = options[i];
    const id = ui.idx('tb.choice', cel.k * 16 + i);
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
function drawCell(ui, cel, x, top) {
  if (cel.kind === 'dd') ddCell(ui, dd, cel, x, top);
  else if (cel.kind === 'toggle') toggleCell(ui, cel, x, top);
  else if (cel.kind === 'choices') choicesCell(ui, cel, x, top);
  else sliderCell(ui, cel, x, top);
}

// placed says x and y hold a real position, as the mixer's does: a window
// dragged partly off the left edge has a legitimate negative x. winO is the
// whole window's opacity, set from the title bar.
export const textbank = {
  open: false, placed: false, x: 0, y: 0, w: WIN_W_DEF, h: WIN_H_DEF, winO: WIN_O_DEF,
  rx: 0, ry: 0, rw: 0, rh: 0,   // where it was drawn last frame (rw 0: not showing), for stacking
  grabX: 0, grabY: 0, grabW: 0, grabH: 0, dragging: false, resizing: false, resizingH: false, resizingC: false
};

// ---------- persistence, the mixer's pattern in a 'textbank' slot ----------
// A reload brings the window back as it was left: open or shut, where it
// sat, how big it was and how see-through it was.
let restored = false;
const saved = { open: false, placed: false, x: 0, y: 0, w: 0, h: 0, winO: WIN_O_DEF };
// true while the hand is on the opacity slider (set in barSlider)
let winOHeld = false;
function clampWinO(v) { return v < WIN_O_MIN ? WIN_O_MIN : v > 1 ? 1 : v; }
function round2(v) { return Math.round(v * 100) / 100; }
function restore() {
  restored = true;
  const all = loadUiState();
  const m = all && all.textbank && typeof all.textbank === 'object' ? all.textbank : null;
  textbank.open = false;
  if (m) {
    textbank.open = m.open === true;
    if (m.placed && Number.isFinite(m.x) && Number.isFinite(m.y)) { textbank.placed = true; textbank.x = m.x; textbank.y = m.y; }
    if (Number.isFinite(m.width)) textbank.w = m.width;
    if (Number.isFinite(m.height)) textbank.h = m.height;
    if (Number.isFinite(m.winO)) textbank.winO = clampWinO(m.winO);
  }
  // The set list and ramp time come with the window the first time it is
  // asked for, in case main has not pulled them in yet; a record already
  // loaded is left exactly as it is.
  if (!perform.texts) loadPerform();
  remember();
}
function remember() {
  saved.open = textbank.open; saved.placed = textbank.placed;
  saved.x = Math.round(textbank.x); saved.y = Math.round(textbank.y);
  saved.w = Math.round(textbank.w); saved.h = Math.round(textbank.h);
  saved.winO = round2(textbank.winO);
}
// Held off while a drag of any kind is under way (the opacity slider
// included), so the record is written once on release, not per frame.
function persist() {
  if (textbank.dragging || textbank.resizing || textbank.resizingH || textbank.resizingC || winOHeld) return;
  if (saved.open === textbank.open && saved.placed === textbank.placed &&
      saved.x === Math.round(textbank.x) && saved.y === Math.round(textbank.y) &&
      saved.w === Math.round(textbank.w) && saved.h === Math.round(textbank.h) &&
      saved.winO === round2(textbank.winO)) return;
  remember();
  saveUiState({ textbank: { open: saved.open, placed: saved.placed, x: saved.x, y: saved.y,
    width: saved.w, height: saved.h, winO: saved.winO } });
}

// per-frame layout scalars, module level as the mixer keeps them
let bodyX = 0, bodyW = 0, viewTop = 0, viewBot = 0;
function off(top, h) { return top + h < viewTop || top > viewBot; }

// ---------- the title bar's opacity slider ----------
// The window's own opacity, immediate (it is chrome, not performance) and
// kept with the window's geometry. Laid just after the title, never past
// rightX, the close button's left edge less its gap: when room is short the
// label goes first, then the slider, so neither the title nor the close
// button is ever overlapped.
const PCT_TEXT = new Array(101);
for (let i = 0; i <= 100; i++) PCT_TEXT[i] = i + '%';
const TITLE = 'TEXT';
let titleW = -1, winOLblW = 0;
function capsW(ui, str, size, track) {
  return ui.text.measure(str, size, W.semibold) + str.length * size * track;
}
function barSlider(ui, titleX, rightX, cy) {
  if (titleW < 0) {
    titleW = capsW(ui, TITLE, 11, 0.13);
    winOLblW = capsW(ui, 'WINDOW', TYPE.micro, 0.08);
  }
  winOHeld = false;
  const leftX = titleX + titleW + BAR_TITLE_GAP;
  const slot = BAR_RO_W + BAR_RO_GAP;
  const bare = slot + WINO_TRACK_W, full = bare + winOLblW + BAR_LBL_GAP;
  const room = rightX - leftX;
  if (bare > room) return;
  const showLabel = full <= room;
  const tx = leftX + (showLabel ? winOLblW + BAR_LBL_GAP : 0) + slot;
  const wu = (textbank.winO - WIN_O_MIN) / (1 - WIN_O_MIN);
  const nu = hslider(ui, ui.id('tb.winO'), tx, cy, WINO_TRACK_W, wu, wu, false);
  if (ui.hover || ui.pressed) overBtn = true;
  if (nu >= 0) {
    winOHeld = true;
    textbank.winO = clampWinO(round2(WIN_O_MIN + nu * (1 - WIN_O_MIN)));
  }
  const dl = ui.dl, roR = tx - BAR_RO_GAP, base = baseline(ui, cy, TYPE.micro);
  ui.text.draw(dl, PCT_TEXT[Math.round(textbank.winO * 100)], roR, base, TYPE.micro, W.regular, C.value, 2, 0, 1);
  if (showLabel) {
    ui.text.draw(dl, 'WINDOW', roR - BAR_RO_W - BAR_LBL_GAP - winOLblW, base, TYPE.micro, W.semibold,
      C.sectionInk, 0, 0.08, 1);
  }
}

// ---------- the text bank ----------
// perform.texts, a phrase per row. Edits land in the record on commit, never
// per keystroke; Go fires triggerText for that row.
const tEdit = makeTextState(200, 'a phrase to send');
let editIdx = -1;
function textRow(ui, texts, i, top) {
  const dl = ui.dl;
  const fy = top + (TROW_H - FIELD_H) / 2;
  const delX = bodyX + bodyW - DEL_W;
  const goX = delX - 8 - GO_W;
  const fw = goX - 10 - bodyX;
  if (tEdit.active && editIdx === i) {
    const st = ui.textField('tb.textEdit', bodyX, fy, fw, FIELD_H, tEdit, TYPE.sm, 0);
    if (st === TEXT_COMMIT && tEdit.text !== texts[i]) { texts[i] = tEdit.text; savePerform(); }
    if (st !== TEXT_EDITING) editIdx = -1;
  } else {
    const id = ui.idx('tb.textBox', i);
    ui.interact(id, bodyX, fy, fw, FIELD_H, false);
    const hover = ui.hover;
    if (hover) ui.setCursorHint('text');
    if (ui.clicked) { editIdx = i; ui.textBegin(tEdit, texts[i], false, false); }
    dl.rect(bodyX, fy, fw, FIELD_H, 5, C.field, 1, hover ? C.btnBorderHover : C.fieldBorder, 0, 0);
    dl.pushClip(bodyX + 4, fy, fw - 8, FIELD_H);
    const base = baseline(ui, top + TROW_H / 2, TYPE.sm);
    if (texts[i]) ui.text.draw(dl, texts[i], bodyX + 9, base, TYPE.sm, W.regular, C.name, 0, 0, 1);
    else ui.text.draw(dl, 'empty', bodyX + 9, base, TYPE.sm, W.regular, C.placeholder, 0, 0, 1);
    dl.popClip();
  }
  // Go: send this phrase to the screen now
  const gid = ui.idx('tb.go', i);
  ui.interact(gid, goX, fy, GO_W, FIELD_H, false);
  const gh = ui.hover;
  if (gh) ui.setCursorHint('pointer');
  if (ui.clicked) triggerText(i);
  dl.rect(goX, fy, GO_W, FIELD_H, 5, COLOR.accentSoft, 1, gh ? COLOR.accent : C.goBorder, 0, 0);
  ui.text.draw(dl, 'Go', goX + GO_W / 2, baseline(ui, top + TROW_H / 2, TYPE.xs), TYPE.xs, W.semibold, COLOR.accent, 1, 0.02, 1);
  // the small delete; the list changed, so the rest of the rows wait a frame
  const did = ui.idx('tb.textDel', i);
  ui.interact(did, delX, fy, DEL_W, FIELD_H, false);
  const dh = ui.hover;
  if (dh) ui.setCursorHint('pointer');
  ui.text.draw(dl, '×', delX + DEL_W / 2, baseline(ui, top + TROW_H / 2, 15), 15, W.regular,
    dh ? C.closeHoverInk : C.sectionInk, 1, 0, 1);
  if (ui.clicked) {
    texts.splice(i, 1);
    savePerform();
    if (editIdx === i) { tEdit.active = false; editIdx = -1; }
    else if (editIdx > i) editIdx--;
    return true;
  }
  return false;
}
// The body, top to bottom: the hint, the list, + Add right under the last
// phrase, then the timing strip at the window's foot. The list takes the
// height the rest leaves over (bodyH is the body's visible height), shrinks
// to its rows when they are fewer, and scrolls itself when they are more.
function textBank(ui, bodyH) {
  const texts = perform.texts || null;
  const n = texts ? texts.length : 0;
  fitRow(TIMING, bodyW);
  fitRow(LAYER, bodyW);
  const timingH = TIMING.cells.length ? TIMING.linesH + TIMING_TOP : 0;
  const layerH = LAYER.cells.length ? LAYER.linesH + LAYER_GAP : 0;
  const listNat = n > 0 ? n * TROW_H + 4 : 0;
  const spare = Math.max(Math.min(listNat, LIST_MIN_ROWS * TROW_H + 4),
    Math.floor(bodyH - PAD_T - layerH - HINT_H - (ADD_H + 6) - timingH - PAD_B));
  const listH = texts && n > 0 ? Math.min(listNat, spare) : 0;
  ui.spacer(PAD_T);
  // the layer's own row: on or off, opacity, and the words' source
  if (layerH) {
    const top = ui.cursorY;
    ui.spacer(layerH);
    if (!off(top, layerH)) drawRow(ui, LAYER, bodyX, top, bodyW, drawCell);
  }
  // the hint, once, above the list
  {
    const top = ui.cursorY;
    ui.spacer(HINT_H);
    if (!off(top, HINT_H)) {
      ui.text.draw(ui.dl, 'one phrase per row · a / in the text breaks the line · Go sends it now',
        bodyX, baseline(ui, top + HINT_H / 2, TYPE.micro), TYPE.micro, W.regular, C.sectionInk, 0, 0.04, 1);
    }
  }
  if (listH > 0) {
    // the bank's own scroll, so a long set list never buries the timing strip
    const listTop = ui.cursorY;
    const lo = Math.max(listTop, viewTop), hi = Math.min(listTop + listH, viewBot);
    ui.scroll('tb.texts', listH);
    ui.spacer(2);
    for (let i = 0; i < n; i++) {
      const top = ui.cursorY;
      ui.spacer(TROW_H);
      if (top + TROW_H < lo || top > hi) continue;
      if (textRow(ui, texts, i, top)) break;
    }
    ui.spacer(2);
    ui.endScroll();
  }
  // + Add, up to the cap
  {
    const top = ui.cursorY;
    ui.spacer(ADD_H + 6);
    if (!off(top, ADD_H) && texts && n < TEXT_MAX) {
      const id = ui.id('tb.add');
      ui.interact(id, bodyX, top + 2, bodyW, ADD_H, false);
      const hover = ui.hover;
      if (hover) ui.setCursorHint('pointer');
      if (ui.clicked) { texts.push(''); savePerform(); }
      ui.dl.rect(bodyX, top + 2, bodyW, ADD_H, 5, C.btnBg, 1, hover ? C.btnBorderHover : C.btnBorder, 0, 0);
      ui.text.draw(ui.dl, '+  Add', bodyX + bodyW / 2, baseline(ui, top + 2 + ADD_H / 2, TYPE.xs),
        TYPE.xs, W.regular, hover ? C.name : C.btnInk, 1, 0.04, 1);
    }
  }
  // what the list did not take, so the strip sits at the foot
  if (spare > listH) ui.spacer(spare - listH);
  // the timing strip: the fades, the hold, and the two effects, all through
  // perfSet like every handle in the Performance window
  if (TIMING.cells.length) {
    const top = ui.cursorY;
    ui.spacer(timingH);
    if (!off(top, timingH)) {
      ui.dl.rect(bodyX, top + 3, bodyW, 1, 0, C.faintLine, 0, null, 0, 0);
      drawRow(ui, TIMING, bodyX, top + TIMING_TOP, bodyW, drawCell);
    }
  }
  ui.spacer(PAD_B);
}

// The height the window's contents ask for at width winW: the body's fixed
// parts plus every phrase row at full height.
function naturalH(winW) {
  const n = perform.texts ? perform.texts.length : 0;
  fitRow(TIMING, winW - 2 - PAD_X * 2);
  fitRow(LAYER, winW - 2 - PAD_X * 2);
  const timingH = TIMING.cells.length ? TIMING.linesH + TIMING_TOP : 0;
  const layerH = LAYER.cells.length ? LAYER.linesH + LAYER_GAP : 0;
  return BAR_H + 2 + PAD_T + layerH + HINT_H + (n > 0 ? n * TROW_H + 4 : 0) + ADD_H + 6 + timingH + PAD_B;
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
// floating windows 1, so an open text window holds at full strength.
export function drawTextbank(ui, app, fade = 1) {
  if (!restored) restore();
  persist();
  const open = ui.spring('textbank.open', textbank.open ? 1 : 0, MOTION.panel);
  const o = open * fade;
  if (o < 0.002) { textbank.rw = 0; winOHeld = false; return; }
  const width = app.width, height = app.height;

  const maxW = Math.max(320, width - 24), minW = Math.min(WIN_MIN_W, maxW);
  const winW = Math.max(minW, Math.min(textbank.w, maxW));
  const maxH = Math.max(BAR_H + 120, height - 24), minH = Math.min(WIN_MIN_H, maxH);
  // The window is as tall as what it holds: it opens snug around the hint,
  // the rows, + Add and the timing strip, and grows a row at a time as
  // phrases are added. textbank.h, the bottom edge's drag, is only a ceiling:
  // past it the list scrolls instead of the window growing.
  const winH = Math.max(minH, Math.min(naturalH(winW), textbank.h, maxH));
  // first showing: against the right edge, a little down from the top, so it
  // stays clear of the Performance window centred on the screen
  if (!textbank.placed) {
    textbank.placed = true;
    textbank.x = Math.max(12, width - winW - 24);
    textbank.y = Math.max(12, Math.min(48, height - winH - 12));
  }
  // keep the title bar reachable after any resize
  textbank.x = Math.max(12 - winW + 80, Math.min(textbank.x, width - 80));
  textbank.y = Math.max(12, Math.min(textbank.y, height - BAR_H - 12));
  const x = textbank.x, y = textbank.y + (1 - open) * 16;   // slides on open and shut only
  textbank.rx = x; textbank.ry = y; textbank.rw = winW; textbank.rh = winH;
  const dl = ui.dl;

  ui.pushScope(ui.id('textbank'));
  // the whole window, chrome and body, at the opacity its title bar sets
  dl.pushAlpha(o * textbank.winO);
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
  if (barHit(ui, 'tb.close', closeX, cy - CLOSE_H / 2, closeW, CLOSE_H)) textbank.open = false;
  dl.rect(closeX, cy - CLOSE_H / 2, closeW, CLOSE_H, 6, C.btnBg, 1,
    btnHover ? C.closeHoverBorder : C.btnBorder, 0, 0);
  ui.text.draw(dl, '×', closeX + closeW / 2, baseline(ui, cy, 18), 18, W.regular,
    btnHover ? C.closeHoverInk : C.btnInk, 1, 0, 1);
  // the window opacity, just right of the title, laid before the drag below
  // so it takes its presses first and sets overBtn to keep the grab cursor
  // off it
  barSlider(ui, x + 1 + 13, closeX - BAR_CLOSE_GAP, cy);

  // ---- lower right corner: both at once ----
  // Run first, so where it overlaps the two edges below it wins the press.
  // The edges and the corner reach GRAB_OUT past the window and GRAB_IN into
  // it, a wide enough band to find without hunting for a hairline.
  ui.interact(ui.id('tb.resizeC'), x + winW - CORNER_GRAB, y + winH - CORNER_GRAB,
    CORNER_GRAB + GRAB_OUT, CORNER_GRAB + GRAB_OUT, false);
  if (ui.pressed) {
    if (!textbank.resizingC) {
      textbank.resizingC = true;
      textbank.grabW = ui.pointerX - (x + winW); textbank.grabH = ui.pointerY - (y + winH);
    }
    textbank.w = Math.max(minW, Math.min(ui.pointerX - textbank.grabW - x, maxW));
    textbank.h = Math.max(minH, Math.min(ui.pointerY - textbank.grabH - y, maxH));
    ui.setCursorHint('nwse-resize');
  } else {
    if (textbank.resizingC) { textbank.w = winW; textbank.h = winH; }
    textbank.resizingC = false;
    if (ui.hover) { ui.setCursorHint('nwse-resize'); overBtn = true; }
  }
  // The edges' bands overlap the corner's square, and the last cursor hint
  // set wins, so over the corner the edges below leave the cursor alone.
  const cornerHot = ui.hover || textbank.resizingC;
  // the grip: three dots on the diagonal, so the corner says it can be pulled
  for (let g = 0; g < 3; g++) {
    const gx = x + winW - 6 - g * 4, gy = y + winH - 6;
    for (let h2 = 0; h2 <= g; h2++) dl.rect(gx + h2 * 4 - 1, gy - h2 * 4 - 1, 2, 2, 1, C.cellLabel, 0, null, 0, 0);
  }

  // ---- right edge: horizontal resize ----
  ui.interact(ui.id('tb.resize'), x + winW - GRAB_IN, y, GRAB_IN + GRAB_OUT, winH, false);
  if (ui.pressed) {
    if (!textbank.resizing) { textbank.resizing = true; textbank.grabW = ui.pointerX - (x + winW); }
    textbank.w = Math.max(minW, Math.min(ui.pointerX - textbank.grabW - x, maxW));
    ui.setCursorHint('ew-resize');
  } else {
    if (textbank.resizing) textbank.w = winW;
    textbank.resizing = false;
    if (ui.hover && !cornerHot) { ui.setCursorHint('ew-resize'); overBtn = true; }
  }

  // ---- bottom edge: vertical resize ----
  ui.interact(ui.id('tb.resizeH'), x, y + winH - GRAB_IN, winW, GRAB_IN + GRAB_OUT, false);
  if (ui.pressed) {
    if (!textbank.resizingH) { textbank.resizingH = true; textbank.grabH = ui.pointerY - (y + winH); }
    textbank.h = Math.max(minH, Math.min(ui.pointerY - textbank.grabH - y, maxH));
    ui.setCursorHint('ns-resize');
  } else {
    if (textbank.resizingH) textbank.h = winH;
    textbank.resizingH = false;
    if (ui.hover && !cornerHot) { ui.setCursorHint('ns-resize'); overBtn = true; }
  }

  // ---- title bar drag, the offset taken on press so the window never jumps ----
  ui.interact(ui.id('tb.drag'), x, y, winW, BAR_H, false);
  if (ui.pressed) {
    if (!textbank.dragging) { textbank.dragging = true; textbank.grabX = ui.pointerX - textbank.x; textbank.grabY = ui.pointerY - textbank.y; }
    textbank.x = ui.pointerX - textbank.grabX; textbank.y = ui.pointerY - textbank.grabY;
    ui.setCursorHint('grabbing');
  } else {
    textbank.dragging = false;
    if (ui.hover && !overBtn) ui.setCursorHint('grab');
  }

  // ---- body ----
  const cx0 = ui.cursorX, cy0 = ui.cursorY, cw0 = ui.regionW;
  const bodyTop = y + BAR_H + 1, bodyH = winH - BAR_H - 2;
  viewTop = bodyTop; viewBot = bodyTop + bodyH;
  ui.setCursor(x + 1, bodyTop, winW - 2);
  ui.scroll('tb.body', bodyH);
  bodyX = ui.cursorX + PAD_X; bodyW = ui.regionW - PAD_X * 2;

  textBank(ui, bodyH);

  ui.endScroll();
  ui.setCursor(cx0, cy0, cw0);

  // a menu whose box was not drawn this frame (its row scrolled away) is
  // dropped; a live one is painted here, over everything the body drew
  if (dd.ctrl && !dd.drawn) dd.ctrl = null;
  ddDraw(ui, dd);

  // clicks on empty pane stop here instead of reaching the drawer or field
  ui.interact(ui.id('tb.backstop'), x, y, winW, winH, false);
  dl.popAlpha();
  ui.popScope();
}
