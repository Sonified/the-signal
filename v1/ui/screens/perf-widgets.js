// The small pieces the two performance windows share: the Performance
// window (ui/screens/performer.js, on P) and the Text window
// (ui/screens/textbank.js, on T). Both write every handle through the ramp
// engine (core/perform.js perfSet), so both need the same reading of where a
// control is headed, the same mini slider with its gliding pulse, the same
// small label line with its ramp glow, and the same local dropdown.
//
// Nothing in here holds a window's state. The dropdown's open menu lives in
// an object each window makes for itself with makeDropdown, so a menu open in
// one window is never shut or steered by the other. The format caches below
// are keyed by control id and hold only derived strings, so sharing them is
// safe. Hit and spring ids are plain names; each window draws inside its own
// ui scope, which keeps the same name in the two windows apart.
import { S } from '../../../js/state.js';
import { perfSet, perfTarget, perfRamping } from '../../core/perform.js';
import { COLOR, TYPE, W, MOTION } from '../theme.js';
import { ICON } from '../drawlist.js';

// ---------- colours: the mixer's pane, the theme's accent for what is live ----------
export function css(hex, a) {
  const n = parseInt(hex.slice(1, 7), 16), v = new Float32Array(4);
  v[0] = (n >> 16 & 255) / 255; v[1] = (n >> 8 & 255) / 255; v[2] = (n & 255) / 255;
  v[3] = a !== undefined ? a : hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
  return v;
}
export const C = {
  pane: css('#1a222c'), paneBorder: css('#2c3742'), bar: css('#171e27'), barLine: css('#29313b'),
  title: css('#bac5d1'),
  btnBg: css('#121820'), btnBorder: css('#222a33'), btnBorderHover: css('#3a4551'), btnInk: css('#8e9aaa'),
  closeHoverInk: css('#ff8a8a'), closeHoverBorder: css('#5a3a3a'),
  sectionInk: css('#5f6c7c'), faintLine: css('#ffffff08'),
  name: css('#d6e0e8'), nameOff: css('#8e9aaa'),
  cellLabel: css('#c0cad4'), value: css('#aebdcb'),
  rowAlt: css('#202a35'), rowRamp: css('#2f7edb', 0.11),
  rowLine: css('#ffffff', 0.07),
  track: css('#070b10'),
  field: css('#121820'), fieldBorder: css('#2a3440'), placeholder: css('#5f6c7c'),
  menu: css('#161d26'), menuHover: css('#ffffff', 0.05),
  goBorder: css('#31517e')
};

// ---------- sizes shared by the cells ----------
// A cell is a small label over a mini track, its readout at its right; a
// row of them wraps onto more lines, LINE_GAP apart, when it does not fit.
export const CELL_H = 34, CELL_GAP = 16, LINE_GAP = 2;
export const DD_BOX_H = 20, DD_ROW_H = 24, DD_MENU_MIN_W = 200;

// ---------- small helpers ----------
const lm = { ascent: 0, descent: 0 };
export function baseline(ui, cy, size) {
  ui.text.lineMetrics(size, lm);
  return cy + (lm.ascent - lm.descent) / 2;
}
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ---------- reading and writing through the ramp engine ----------
// Shift held on the press skips the ramp: perfSet's now flag, so the value
// lands at once however long the interpolation time is set.
// Where a handle sits is where it is headed: the handle parks where the
// operator sent it (the engine's target while a glide is in flight, the live
// value otherwise), and the fill behind it slides its way over. The readout
// stays live too, so mid-glide the number can be watched arriving while the
// knob already stands at the goal.
export function targetPos(c) {
  const v = perfTarget(c.id);
  return v === undefined ? c.get(S) : v;
}
export function effectivePos(c) {
  if (typeof c.effective !== 'function') return undefined;
  const v = c.effective(S);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
// Formatted from the control's own format on change only, never per frame.
// A position the control is not at yet, in the control's own words. Its
// format reads the live state, so the live readout is reused with its number
// swapped for the target's, at the same number of decimals, keeping the
// sign and unit around it. A readout with no number in it that tracks the
// position (a word like 'none' at the ends) falls back to the bare position
// at the step's decimals. One cached string per control, rebuilt only when
// the target or the live readout changes.
const atCache = new Map();
const NUM_RE = /[-+]?\d+(?:\.\d+)?/;
export function fmtAt(c, pos) {
  const live = fmt(c);
  if (typeof pos !== 'number' || pos === c.get(S)) return live;
  let e = atCache.get(c.id);
  if (!e) { e = { pos: NaN, live: '', text: '' }; atCache.set(c.id, e); }
  if (pos === e.pos && live === e.live) return e.text;
  e.pos = pos; e.live = live;
  const m = NUM_RE.exec(live), lp = c.get(S);
  const dec = m && m[0].indexOf('.') >= 0 ? m[0].length - m[0].indexOf('.') - 1 : 0;
  // The readout's number is the position when it is the position rounded to
  // the decimals it prints: mid-glide the position carries more of them
  // (7.4321 Hz shown as 7.4), which an exact match took for a number that
  // is not the position, dropping the unit until the glide landed.
  if (m && typeof lp === 'number' && Math.abs(parseFloat(m[0]) - lp) <= 0.5 * Math.pow(10, -dec) + 1e-6 + Math.abs(lp) * 1e-3) {
    let n = pos.toFixed(dec);
    if (m[0][0] === '+' && pos > 0) n = '+' + n;
    e.text = live.slice(0, m.index) + n + live.slice(m.index + m[0].length);
  } else {
    const st = c.step || 0, sd = st && st < 1 ? String(st).split('.')[1].length : 0;
    e.text = pos.toFixed(sd);
  }
  return e.text;
}
const fmtCache = new Map();
export function fmt(c) {
  let e = fmtCache.get(c.id);
  if (!e) { e = { pos: NaN, text: '' }; fmtCache.set(c.id, e); }
  const pos = c.get(S);
  if (pos !== e.pos) { e.pos = pos; e.text = c.format ? c.format(S) : String(pos); }
  return e.text;
}

// Position to track fraction and back, honouring a log taper (the risk-band
// tapers stay the control's business: only positions pass through here).
// The performance Strobe rate has its own denser live range: it tops out at
// 40 Hz and maps logarithmically so 1 to 10 Hz receives most of the fader.
export function unitOf(c, pos) {
  const lo = c.id === 'freq' ? 0.5 : c.min;
  const hi = c.id === 'freq' ? 40 : c.max;
  const log = c.id === 'freq' || c.taper === 'log';
  if (log && lo > 0 && hi > lo) {
    const u = Math.log(pos / lo) / Math.log(hi / lo);
    return !(u > 0) ? 0 : u > 1 ? 1 : u;
  }
  return clamp01((pos - lo) / ((hi - lo) || 1));
}
export function posOf(c, u) {
  const lo = c.id === 'freq' ? 0.5 : c.min;
  const hi = c.id === 'freq' ? 40 : c.max;
  const log = c.id === 'freq' || c.taper === 'log';
  let v = log && lo > 0 && hi > lo
    ? lo * Math.pow(hi / lo, u)
    : lo + u * (hi - lo);
  const st = c.step || 0;
  if (v < lo) v = lo; else if (v > hi) v = hi;
  if (st) {
    let p = 1;
    for (let d = 0; d < 6 && Math.abs(Math.round(st * p) - st * p) > 1e-9; d++) p *= 10;
    v = Math.round(Math.round(v / st) * st * p) / p;
    if (v < lo) v = lo; else if (v > hi) v = hi;
  }
  return v;
}

// ---------- the mini slider ----------
// The journey window's hslider: a press jumps it there and dragging follows.
// u is where the knob stands (the target), lu how far the fill reaches (the
// live value), so mid-glide the fill slides up to a knob already parked at
// the goal; under the hand both are the pointer's place. Returns the new
// place 0..1 while pressed, or -1 when untouched.
// While a control is gliding its fill breathes a little lighter, a slow
// pulse toward white, and settles back to the plain accent as it lands.
// glow is 0..1, sprung by the caller so the pulse eases out rather than
// cutting off; the colour is mixed into one scratch array, never allocated.
const PULSE_HZ = 1.4, PULSE_LIFT = 0.62;
const fillMix = new Float32Array(4), varianceMix = new Float32Array(4);
// tint, when given, is the slider's own colour in place of the accent, so a
// column of like controls can be told apart at a glance.
export function hslider(ui, id, x, cy, w, u, lu, big, glow, varianceU, tint) {
  const acc = tint || COLOR.accent;
  ui.interact(id, x - 6, cy - 10, w + 12, 20, false);
  const lit = ui.hover || (ui.pressed && ui.activeId === id);
  if (lit) ui.setCursorHint('ew-resize');
  let nu = -1;
  if (ui.pressed && ui.activeId === id) nu = clamp01((ui.pointerX - x) / w);
  // The knob follows the pointer mid-drag; the fill never does. It always
  // shows the live value, so during a drag it is seen chasing the knob at
  // the interpolation's own pace rather than leaping there and snapping
  // back when the glide begins. An immediate change (shift, ramp at cut)
  // moves the live value itself, so the fill lands with it.
  const s = nu >= 0 ? nu : u, f = lu;
  const dl = ui.dl, th = big ? 5 : 3;
  dl.rect(x, cy - th / 2, w, th, th / 2, C.track, 0, null, 0, 0);
  if (f > 0) {
    let fill = acc;
    if (glow > 0.002) {
      const beat = 0.5 - 0.5 * Math.cos(ui.t * 0.001 * PULSE_HZ * 2 * Math.PI);
      const k = glow * PULSE_LIFT * (0.3 + 0.7 * beat);
      const a = acc;
      fillMix[0] = a[0] + (1 - a[0]) * k; fillMix[1] = a[1] + (1 - a[1]) * k;
      fillMix[2] = a[2] + (1 - a[2]) * k; fillMix[3] = a[3];
      fill = fillMix;
    }
    dl.rect(x, cy - th / 2, w * f, th, th / 2, fill, 0, null, 0, 0);
  }
  if (typeof varianceU === 'number' && Number.isFinite(varianceU)) {
    const vu = clamp01(varianceU);
    const beat = 0.5 - 0.5 * Math.cos(ui.t * 0.001 * PULSE_HZ * 2 * Math.PI);
    const k = 0.28 + 0.22 * beat, a = acc;
    varianceMix[0] = a[0] + (1 - a[0]) * k; varianceMix[1] = a[1] + (1 - a[1]) * k;
    varianceMix[2] = a[2] + (1 - a[2]) * k; varianceMix[3] = a[3];
    dl.rect(x, cy - th / 2, Math.max(th, w * vu), th, th / 2, varianceMix, 0, null, 7, 0.45);
  }
  const kr = (big ? 6 : 4.5) + (lit ? 1.5 : 0);
  dl.rect(x + w * s - kr, cy - kr, kr * 2, kr * 2, kr, lit ? C.name : acc, 0, null, 0, 0);
  return nu;
}

// ---------- the dropdown, local to each window ----------
// A compact box that opens a floating menu, drawn after the whole body so it
// sits over the rows below, its input taken at the top of the frame from
// where it stood last frame so its rows win any press over what they cover.
// One is open at a time in a window. widgets.js's select is not used here
// because its popup shares state with the drawer's, and the drawer's input
// pass would shut this window's menu whenever both were up; for the same
// reason each window makes its own state here and passes it in.
export function makeDropdown() {
  return {
    ctrl: null, labels: null, swatches: null, n: 0, index: 0, hover: -1, drawn: false,
    x: 0, y: 0, w: 0, boxX: 0, boxY: 0, boxW: 0, boxH: 0
  };
}
export function ddInput(ui, dd) {
  dd.hover = -1;
  if (!dd.ctrl) return;
  const x = dd.x, y = dd.y, w = dd.w, n = dd.n;
  for (let i = 0; i < n; i++) {
    ui.interact(ui.idx('perf.ddRow', i), x, y + i * DD_ROW_H, w, DD_ROW_H, false);
    if (ui.hover) { dd.hover = i; ui.setCursorHint('pointer'); }
    if (ui.clicked) {
      const c = dd.ctrl, opt = c.options[i];
      if (opt && opt.value !== targetPos(c)) perfSet(c.id, opt.value, ui.pointerShift);
      dd.ctrl = null;
      return;
    }
  }
  // a press anywhere off the menu and its box shuts it; that press still
  // lands where it was aimed, as a browser's select behaves
  if (ui._downEvent) {
    const px = ui._downX, py = ui._downY;
    const inList = px >= x && px < x + w && py >= y && py < y + n * DD_ROW_H;
    const inBox = px >= dd.boxX && px < dd.boxX + dd.boxW && py >= dd.boxY && py < dd.boxY + dd.boxH;
    if (!inList && !inBox) dd.ctrl = null;
  }
}
export function ddDraw(ui, dd) {
  if (!dd.ctrl || !dd.drawn) return;
  const dl = ui.dl, x = dd.x, y = dd.y, w = dd.w, n = dd.n;
  dl.rect(x, y, w, n * DD_ROW_H, 6, C.menu, 1, C.paneBorder, 12, 0.4);
  for (let i = 0; i < n; i++) {
    const oy = y + i * DD_ROW_H;
    if (i === dd.hover) dl.rect(x + 1, oy + 1, w - 2, DD_ROW_H - 2, 5, C.menuHover, 0, null, 0, 0);
    const sel = i === dd.index;
    let tx = x + 10;
    if (dd.swatches) {
      dl.rect(x + 10, oy + (DD_ROW_H - 12) / 2, 12, 12, 6, dd.swatches[i], 1, C.faintLine, 0, 0);
      tx += 20;
    }
    ui.text.draw(dl, dd.labels[i], tx, baseline(ui, oy + DD_ROW_H / 2, TYPE.xs), TYPE.xs,
      sel ? W.semibold : W.regular, sel ? COLOR.accent : C.name, 0, 0.02, 1);
    if (sel) dl.icon(ICON.CHECK, x + w - 22, oy + (DD_ROW_H - 12) / 2, 12, 12, COLOR.accent, 1.6, 0);
  }
}
const ddLabelCache = new Map();
function labelsOf(c) {
  let l = ddLabelCache.get(c.id);
  if (!l) {
    l = new Array(c.options.length);
    for (let i = 0; i < c.options.length; i++) l[i] = c.options[i].label;
    ddLabelCache.set(c.id, l);
  }
  return l;
}
// The option the control is at, or -1 when it sits between them (a rate
// dragged to 7.3 with a menu of presets), matched case-blind for strings so
// a hex colour matches however it was written.
function optIndex(c) {
  let v = targetPos(c);
  if (typeof v === 'string') v = v.toLowerCase();
  const o = c.options;
  for (let i = 0; i < o.length; i++) {
    const ov = typeof o[i].value === 'string' ? o[i].value.toLowerCase() : o[i].value;
    if (ov === v) return i;
  }
  return -1;
}

// ---------- the cells ----------
// A cell is { c, label, kind, w, min, dw, ln, ox, lw, k }: c the schema
// control, w its natural width and min the floor a squeezed cell stops at,
// dw the width it is drawn at, ln its line and ox its x on that line (all
// set by fitRow), lw the label's measured width, taken once, and k a stable
// index for hit and spring ids, unique within its window.
//
// Every cell starts with the same small label line: the name in the quiet
// grey, or in the accent while the engine is still gliding that control (the
// ramp glow), and for a slider the live readout at the right. The readout
// is clipped to the room the label leaves it, so a squeezed cell loses its
// number from the left before the label or the track give anything up.
export function cellLabelLine(ui, cel, x, top, readout) {
  const dl = ui.dl;
  const ramping = perfRamping(cel.c.id);
  ui.text.draw(dl, cel.label, x, top + 9, TYPE.micro, W.semibold,
    ramping ? COLOR.accent : C.cellLabel, 0, 0.08, 1);
  if (readout) {
    if (cel.lw < 0) cel.lw = ui.text.measure(cel.label, TYPE.micro, W.semibold) + cel.label.length * TYPE.micro * 0.08;
    const rx = x + cel.lw + 6;
    dl.pushClip(rx, top, Math.max(0, x + cel.dw - rx), 14);
    ui.text.draw(dl, readout, x + cel.dw, top + 9, TYPE.micro, W.regular, C.value, 2, 0, 1);
    dl.popClip();
  }
}
export function sliderCell(ui, cel, x, top) {
  const c = cel.c;
  const tgt = targetPos(c), live = c.get(S);
  const effective = effectivePos(c);
  const sid = ui.idx('perf.sl', cel.k);
  const glow = ui.spring(ui.idx('perf.slGlow', cel.k), perfRamping(c.id) ? 1 : 0, MOTION.fade);
  const u = hslider(ui, sid, x, top + 24, cel.dw,
    unitOf(c, typeof tgt === 'number' ? tgt : live), unitOf(c, live), false, glow,
    effective === undefined ? undefined : unitOf(c, effective));
  if (u >= 0) {
    const np = posOf(c, u);
    if (np !== tgt) perfSet(c.id, np, ui.pointerShift);
  }
  // The readout names where the control is going, the moment it is grabbed
  // or dragged, not where the glide has got to: the fill shows that. Drawn
  // after the slider so a drag this frame is already in it.
  cellLabelLine(ui, cel, x, top, fmtAt(c, targetPos(c)));
}
// fitMenu sizes the open menu to its longest option (the swatch, text and
// check mark with their padding) instead of the DD_MENU_MIN_W floor.
export function ddCell(ui, dd, cel, x, top, fitMenu) {
  const c = cel.c, dl = ui.dl;
  cellLabelLine(ui, cel, x, top, null);
  const bx = x, by = top + 13, bw = cel.dw, bh = DD_BOX_H;
  const wasOpen = dd.ctrl === c;
  let open = wasOpen;
  // the box scrolled out from under its menu: shut it rather than let it drift
  if (open && (Math.abs(by - dd.boxY) > 0.5 || Math.abs(bx - dd.boxX) > 0.5)) open = false;
  ui.interact(ui.idx('perf.dd', cel.k), bx, by, bw, bh, false);
  const hover = ui.hover;
  if (hover) ui.setCursorHint('pointer');
  if (ui.clicked) open = !open;
  const labels = labelsOf(c), idx = optIndex(c);
  dl.rect(bx, by, bw, bh, 5, C.field, 1, hover || open ? C.btnBorderHover : C.fieldBorder, 0, 0);
  dl.pushClip(bx + 4, by, bw - 24, bh);
  // between options the box names the value itself rather than a wrong one
  let tx = bx + 8;
  if (c.swatch) {
    dl.rect(bx + 7, by + (bh - 11) / 2, 11, 11, 5.5, c.swatch(), 1, C.faintLine, 0, 0);
    tx += 17;
  }
  // a swatch-only box (swatchOnly) shows just its colour dot, no name
  if (!c.swatchOnly) {
    const shown = idx >= 0 ? labels[idx] : (c.format ? fmt(c) : '');
    ui.text.draw(dl, shown, tx, baseline(ui, by + bh / 2, TYPE.xs), TYPE.xs, W.regular, C.name, 0, 0, 1);
  }
  dl.popClip();
  dl.icon(ICON.CHEVRON, bx + bw - 17, by + (bh - 12) / 2, 12, 12, C.cellLabel, 1.6, 0);
  if (open) {
    const n = labels.length, listH = n * DD_ROW_H;
    let ly = by + bh + 2;
    if (ly + listH > ui.height - 8 && by - 2 - listH >= 8) ly = by - 2 - listH;
    dd.ctrl = c; dd.labels = labels; dd.swatches = c.swatches || null; dd.n = n; dd.index = idx;
    if (fitMenu && !(cel.menuW > 0)) {
      let widest = 0;
      for (let i = 0; i < n; i++) widest = Math.max(widest, ui.text.measure(labels[i], TYPE.xs, W.semibold) + labels[i].length * TYPE.xs * 0.02);
      cel.menuW = Math.ceil(10 + (c.swatches ? 20 : 0) + widest + 10 + 12 + 10);
    }
    dd.w = fitMenu ? Math.max(bw, cel.menuW) : Math.max(bw, DD_MENU_MIN_W);
    // a menu wider than its box keeps its right edge on screen
    dd.x = Math.max(8, Math.min(bx, ui.width - 8 - dd.w));
    dd.y = ly;
    dd.boxX = bx; dd.boxY = by; dd.boxW = bw; dd.boxH = bh;
    dd.drawn = true;
    if (!wasOpen) dd.hover = -1;
  } else if (wasOpen) dd.ctrl = null;
}

// fitRow lays a row's cells out for a row availW wide: one line at their
// natural widths when they all fit, and otherwise flowing left to right onto
// further lines, the first cell first as the rows are ordered, so a longer
// window grows taller instead of cramped. A cell is squeezed only when it is
// alone on its line and still wider than availW: it takes the full width,
// never under its floor, and only when the floor itself overflows does the
// row clip at the padding (fitOver). Each cell keeps its line and its x on
// that line (ln, ox) and its drawn width dw; the row keeps its line count
// and the height they take (linesH). All of it is kept on the row and redone
// only when availW changes, so a steady window does no fitting at all.
export function fitRow(row, availW) {
  if (row.fitW === availW) return;
  row.fitW = availW;
  const cells = row.cells, n = cells.length;
  const cellGap = typeof row.cellGap === 'number' ? row.cellGap : CELL_GAP;
  let ln = 0, cx = 0;
  row.fitOver = false;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    // a cell may pull in toward the one before it (lead, negative), into
    // room that cell's readout leaves empty; never at the start of a line.
    // nl asks for a line of its own whatever the room.
    if (cx > 0 && c.lead) cx = Math.max(0, cx + c.lead);
    if (cx > 0 && (c.nl || cx + c.w > availW)) { ln++; cx = 0; }
    c.ln = ln; c.ox = cx;
    c.dw = cx === 0 && c.w > availW ? Math.max(c.min, availW) : c.w;
    if (c.dw > availW) row.fitOver = true;
    cx += c.dw + cellGap;
  }
  // a row may set its own line height (cellH); the Text window's rows keep
  // CELL_H, for their label line over the control
  const ch = row.cellH || CELL_H;
  const lines = n > 0 ? ln + 1 : 1;
  row.linesH = lines * ch + (lines - 1) * LINE_GAP;
}
// drawRow draws a fitted row, each cell through the window's own drawCell,
// which knows the kinds of cell that window holds.
export function drawRow(ui, row, x0, top, availW, drawCell) {
  const cells = row.cells;
  if (row.fitOver) ui.dl.pushClip(x0, top - 2, availW, row.linesH + 4);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    drawCell(ui, c, x0 + c.ox, top + c.ln * ((row.cellH || CELL_H) + LINE_GAP));
  }
  if (row.fitOver) ui.dl.popClip();
}
