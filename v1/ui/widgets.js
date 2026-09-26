// The widget set: slider, segment, toggle, button, iconButton, tooltip, and
// ui.control, the schema dispatcher. Every function here is installed onto a
// UI instance by installWidgets(ui), called once from imgui.js's
// constructor, so screens only ever see them as ui.slider(...), ui.button(...)
// and so on. Splitting the file this way (imgui.js: layout and the
// hot/active/focus machine; widgets.js: what gets drawn and how it responds)
// keeps the state machine in one place and the look in another, which is
// where most of the tuning happens.
//
// Every widget follows the same shape: claim a rect from the layout
// (ui.nextRect, or explicit coordinates for iconButton), run ui.interact to
// get this frame's hover/press/click, spring the parts that move, draw with
// theme colours and lane B's text object, and return whatever changed. None
// of that allocates: strings are cached where they would otherwise be
// rebuilt every frame (a segment's label array, a schema control's formatted
// readout), and every colour blend writes into one of ui's three scratch
// Float32Array(4) slots rather than building a new array.
//
// The motion rule: a spring animates state, never layout. Its target is
// always something the widget means (hover, press, focus, on/off, open or
// closed, a value, which option is selected expressed relative to the
// widget's own rect), never a screen position such as rx, ry or an absolute
// x/y. Every drawn position is then computed fresh each frame as the current
// rect plus the animated relative amount, so when the whole widget moves
// (the drawer sliding open or shut, a scroll, a group opening above it) it
// moves rigidly with zero lag, and only a change of state ever animates.
// segment()'s selection highlight is the worked example.
//
//   ui.slider(id, label, value01, formatted, step01, def01, disabled, readout) -> new value01 | -1
//     value01/step01/def01 are all normalized 0..1; a schema slider (through
//     ui.control) computes them from min/max/step/def, so the widget itself
//     never has to know a control's real units. step01 sizes the Alt+wheel
//     notch and the arrow-key nudge (default 0.02 if omitted); def01, if
//     given, is where a double-click on the track resets to. readout is one
//     of the exported RO_* constants: RO_PLAIN (the default) just prints
//     `formatted`; RO_CLICK also makes that text a small click target of its
//     own, clear of the track, with a pointer cursor and a hover underline,
//     and a click on it (or Enter while the slider has keyboard focus) sets
//     ui.sliderReadoutClicked for the caller; RO_HIDDEN leaves the readout
//     undrawn because the caller has a text field up in its place.
//
// A schema slider's readout is typeable. ui.control passes RO_CLICK, and a
// click opens a ui.textField over the readout, right-aligned where the text
// was, seeded with the number as displayed and all selected. The typed text
// is in the DISPLAYED units, so it goes through the control's parse(S, text)
// when it has one (a dB readout on a position fader, a note name) and is
// otherwise read as the position itself. Enter or a press elsewhere commits,
// Escape cancels, and input that does not parse cancels too. The result is
// clamped, snapped to step and handed to set() like any drag. Only one
// readout is open at a time.
//
// A control with taper: 'log' maps its position logarithmically onto the
// track (value01 = ln(pos/min) / ln(max/min)) so the low end gets the travel,
// while positions, presets and saved settings stay in the control's own
// units. Its Alt+wheel and arrow-key notch is a fixed 1/100 of travel.
//
// No widget takes plain wheel input. A settings list is a scroll region
// packed with sliders, and a wheel that changed whatever slider happened to
// pass under the pointer made the list impossible to scroll, so the wheel
// always belongs to the enclosing ui.scroll. The one exception is the
// slider's fine nudge, which needs Alt/Option held (see slider()).
//   ui.segment(id, labels, index, disabled) -> new index
//   ui.toggle(id, label, on, disabled) -> new on
//   ui.button(id, label, variant, disabled) -> clicked   variant: 'chip'|'primary'|'ghost'
//   ui.iconButton(id, icon, x, y, size, disabled) -> clicked  // ICON.* id from drawlist.js, explicit rect
//   ui.tooltip(str)   // call right after the widget it describes; anchors to
//                      // that widget's rect, shows after a 450 ms hover hold
//   ui.tooltipAt(id, x, y, w, h, hovered, str)   // the same for an explicit
//                      // rect; call every frame for that id, hovered or not
//   ui.control(ctrl, S) -> changed (bool)   // dispatch by ctrl.kind; see imgui.js's
//                                            // header for why S is a second argument
//
// Text entry, a general single-line field (the drawer's preset names use it;
// so can any readout a screen wants to make typeable):
//   makeTextState(maxLen, placeholder) -> st
//     Exported from this file. One small state object per place that edits
//     text, made once and reused for every edit there. The typed string
//     lives in st.text and is rebuilt only on a keystroke, never per frame.
//     placeholder (optional) is drawn faint while the text is empty.
//   ui.textBegin(st, initial, selectAll, numeric)
//     Starts an edit and takes keyboard focus. initial seeds st.text, with
//     the caret at its end. selectAll selects the whole seed so the first
//     keystroke replaces it. numeric accepts only digits, one leading minus
//     and one decimal point (a typed comma is taken as the point).
//   ui.textField(id, x, y, w, h, st, size, align) -> status
//     Call every frame while st.active; explicit rect, drawn as a pill with
//     an accent edge. size defaults to TYPE.xs; align is 0 left (default),
//     1 centre or 2 right, applied while the text fits (a longer text scrolls
//     to keep the caret in view). status is one of the exported constants:
//       TEXT_IDLE      st is not active; nothing drawn
//       TEXT_EDITING   still editing
//       TEXT_COMMIT    Enter, a press anywhere outside the field, or focus
//                      leaving it (Tab). st.text is the committed string,
//                      untrimmed, for the caller to trim or parse.
//       TEXT_CANCEL    Escape, or a field that went undrawn for a frame
//                      while active (its row or screen went away with no
//                      press or key to close it), which is dropped rather
//                      than left to reappear half-typed. Ignore st.text.
//     After a commit or cancel st.active is false and nothing is drawn that
//     frame. Keys: printable characters, Backspace, Delete, Left and Right,
//     Home and End (Up and Down do the same), Cmd or Ctrl+A to select all,
//     Cmd+Left/Right and Cmd+Backspace as on the Mac. A click places the
//     caret, a double-click selects all. The caret blinks off the clock, not
//     a spring. Not supported: IME composition, paste, drag selection.
//     While a field holds focus ui.textEditing is true (see imgui.js), so the
//     app can keep its global shortcuts off the keyboard.
//
// `disabled` (every raw widget's trailing argument, defaulting to false) is
// what makes a widget dim-and-inert rather than just dim: it is threaded
// straight into ui.interact, which with disabled=true never sets hot or
// active and never claims the pointer down under it, so a disabled slider
// cannot be dragged even though it is still drawn. ui.control derives it
// from ctrl.enabled(S) and also wraps the call in a dl.pushAlpha/popAlpha so
// the row reads as unavailable, matching v0's `.ctl.locked`.

import { COLOR, SPACE, RADIUS, TYPE, TRACK, W, MOTION, HIT } from './theme.js';
import { ICON } from './drawlist.js';

const TOOLTIP_DELAY_MS = 450;
const TOOLTIP_MAX_W = 260;
const BTN_H_MIN = 30;
const SEG_H = 30;
const SWITCH_W = 34, SWITCH_H = 18;

// One-time-per-control caches, keyed by the schema Control's stable id
// string (looked up once per control per frame, a Map.get on a string that
// already exists is not the "building a string" the no-allocation rule is
// about). Populated lazily and never rebuilt once warm.
const segmentLabelCache = new Map(); // ctrl.id -> string[] of option labels
const formatCache = new Map();       // ctrl.id -> { pos, text }

export function touchAware(ui, base) {
  return ui.pointerType === 'touch' ? Math.max(HIT.touch, base) : Math.max(HIT.mouse, base);
}

function centerBaseline(ui, y, h, size) {
  ui.text.lineMetrics(size, ui._lm);
  return y + h / 2 + (ui._lm.ascent - ui._lm.descent) / 2;
}

export function installWidgets(ui) {
  ui.slider = slider;
  ui.segment = segment;
  ui.select = select;
  ui.toggle = toggle;
  ui.button = button;
  ui.iconButton = iconButton;
  ui.tooltip = tooltip;
  ui.tooltipAt = tooltipAt;
  ui.control = control;
  ui.textBegin = textBegin;
  ui.textField = textField;
  // slider()'s readout report, written by every slider call and read by its
  // caller straight after (see the header). Declared here, once, so the
  // object's shape never changes in the frame loop.
  ui.sliderReadoutClicked = false;
  ui.sliderReadoutW = 0;       // width of the readout text, when clickable
  ui.sliderNudge = 0;         // -1 or 1 when the change came from Alt+wheel or an arrow key
}

// ---------------- slider ----------------

export const RO_PLAIN = 0, RO_CLICK = 1, RO_HIDDEN = 2;
// How far the readout's hit rect reaches past its text: left, and above the
// label line. Below, it stops a pixel short of the track so a drag that
// starts on the track can never land on the readout instead.
const RO_PAD_X = 6, RO_PAD_Y = 3;

function slider(id, label, value01, formatted, step01, def01, disabled, readout) {
  const ui = this;
  const step = step01 === undefined ? 0.02 : step01;
  const nid = ui.id(id);
  const focused = disabled ? false : ui.registerFocusable(nid);
  const clickable = readout === RO_CLICK && !disabled && !!formatted;

  ui.text.lineMetrics(TYPE.sm, ui._lm);
  const labelH = ui._lm.ascent + ui._lm.descent;
  const trackAreaH = touchAware(ui, 18);
  const gap = SPACE.xxs + 2;
  ui.nextRect(labelH + gap + trackAreaH);
  const rx = ui.rx, ry = ui.ry, rw = ui.rw;

  const trackY0 = ry + labelH + gap;
  const trackCY = trackY0 + trackAreaH / 2;
  const trackH = 3;

  // The readout's own hit rect, run before the track's interact because
  // interact overwrites ui.hover and friends, which the track code below
  // reads. The two rects never overlap, so neither can steal the other's press.
  ui.sliderReadoutClicked = false;
  ui.sliderNudge = 0;
  let roW = 0, roHover = false;
  if (clickable) {
    roW = ui.text.measure(formatted, TYPE.sm, W.regular);
    const hy = ry - RO_PAD_Y;
    ui.interact(combine2(nid, 14), rx + rw - roW - RO_PAD_X, hy, roW + RO_PAD_X, trackY0 - 1 - hy, false);
    roHover = ui.hover;
    if (roHover) ui.setCursorHint('pointer');
    if (ui.clicked) ui.sliderReadoutClicked = true;
  }
  ui.sliderReadoutW = roW;
  labelHit(ui, nid, label, rx, ry - RO_PAD_Y, trackY0 - 1 - (ry - RO_PAD_Y), rw - roW - RO_PAD_X * 2, disabled);

  // An indented (child) row still takes presses from the column's left edge;
  // a press left of the track reads as 0%, exactly as one past its start does.
  ui.interact(nid, rx - ui.rIndent, trackY0, rw + ui.rIndent, trackAreaH, !!disabled);
  const hover = ui.hover, dbl = ui.dbl;
  if (hover) ui.setCursorHint('ew-resize');
  if (focused && ui.focusVisible) ui._focusRing(rx, trackY0, rw, trackAreaH, RADIUS.xs);

  let value = value01;
  if (!disabled) {
    let st = sliderDrag.get(nid);
    if (!st) { st = { mode: '', anchorX: 0, base: 0, wasPressed: false }; sliderDrag.set(nid, st); }

    // A touch press starts 'pending': the value does not jump until the
    // toolkit knows the finger is moving sideways (ui.slopPending clears
    // with the press still ours) or has lifted as a tap. A mostly vertical
    // move instead hands the press to the enclosing scroll inside
    // ui.interact, and this slider simply stops seeing it. Mouse and pen
    // decide 'rel' or 'abs' on the down, as before.
    const knobHitR = Math.max(10, trackAreaH / 2);
    const justPressed = ui.pressed && ui.activeId === nid && !st.wasPressed;
    if (justPressed) {
      st.anchorX = ui.pointerX;
      st.base = value01;
      if (ui.slopPending) {
        st.mode = 'pending';
      } else {
        st.mode = Math.abs(st.anchorX - (rx + st.base * rw)) <= knobHitR ? 'rel' : 'abs';
        if (st.mode === 'abs') value = clamp01((ui.pointerX - rx) / rw);
      }
    } else if (ui.pressed && ui.activeId === nid) {
      if (st.mode === 'pending' && !ui.slopPending) {
        st.mode = Math.abs(st.anchorX - (rx + st.base * rw)) <= knobHitR ? 'rel' : 'abs';
      }
      if (st.mode === 'abs') {
        value = clamp01((ui.pointerX - rx) / rw);
      } else {
        const dx = ui.pointerX - st.anchorX;
        const shiftHeld = ui.keyCount > 0 && anyShift(ui);
        value = clamp01(st.base + (dx / rw) * (shiftHeld ? 0.1 : 1));
      }
    } else if (ui.released && st.mode === 'pending') {
      // a touch tap that never travelled: jump to it unless it was on the knob
      if (Math.abs(st.anchorX - (rx + st.base * rw)) > knobHitR) value = clamp01((st.anchorX - rx) / rw);
    }
    if (!ui.pressed) st.mode = '';
    st.wasPressed = ui.pressed;

    if (dbl && def01 !== undefined) value = def01;

    // Fine adjust: Alt/Option + wheel over the slider nudges it one step per
    // frame of wheel input. Plain wheel is left for the enclosing scroll
    // region, which claims it in endScroll after this slider has run.
    if (hover && ui.wheelAlt && ui.wheelDY !== 0 && !ui._wheelConsumed) {
      ui.sliderNudge = ui.wheelDY > 0 ? -1 : 1;
      value = clamp01(value01 + ui.sliderNudge * step);
      ui._wheelConsumed = true;
      ui._unsettled = true;
    }

    // sliderNudge tells a caller that snaps to a step (ui.control) that this
    // change was a notch, so a notch smaller than one step, which snapping
    // would round straight back, still moves the value by one step.
    if (focused) {
      for (let i = 0; i < ui.keyCount; i++) {
        if (!ui.keyIsDown(i)) continue;
        const c = ui.keyCode(i), fine = ui.keyShift(i) ? 0.1 : 1;
        if (c === 'ArrowLeft' || c === 'ArrowDown') { value = clamp01(value01 - step * fine); ui.sliderNudge = -1; }
        else if (c === 'ArrowRight' || c === 'ArrowUp') { value = clamp01(value01 + step * fine); ui.sliderNudge = 1; }
        else if ((c === 'Enter' || c === 'NumpadEnter') && clickable) ui.sliderReadoutClicked = true;
      }
    }
  }

  const changed = !disabled && value !== value01;

  // ---- draw ----
  const labelColor = disabled ? COLOR.inkFaint : COLOR.inkDim;
  const baseline1 = ry + ui._lm.ascent;
  ui.text.draw(ui.dl, label, rx, baseline1, TYPE.sm, W.regular, labelColor, 0, TRACK.ui, 1);
  if (readout !== RO_HIDDEN) {
    ui.text.draw(ui.dl, formatted, rx + rw, baseline1, TYPE.sm, W.regular, disabled ? COLOR.inkDim : COLOR.ink, 2, TRACK.tight, 1);
  }
  // A clickable readout says so on hover with a hairline under the text,
  // faded in and out on the hover state and placed fresh from this frame's rect.
  if (clickable) {
    const ua = ui.spring(combine2(nid, 15), roHover ? 1 : 0, MOTION.hover);
    if (ua > 0.01) {
      ui.scratch2[0] = COLOR.inkDim[0]; ui.scratch2[1] = COLOR.inkDim[1];
      ui.scratch2[2] = COLOR.inkDim[2]; ui.scratch2[3] = COLOR.inkDim[3] * ua;
      ui.dl.rect(rx + rw - roW, baseline1 + 2.5, roW, 1, 0.5, ui.scratch2, 0, null, 0, 0);
    }
  }

  ui.dl.rect(rx, trackCY - trackH / 2, rw, trackH, trackH / 2, COLOR.well, 0, null, 0, 0);
  const shown = changed ? value : value01;
  const fillW = Math.max(trackH, rw * shown);
  ui.dl.rect(rx, trackCY - trackH / 2, fillW, trackH, trackH / 2, COLOR.accent, 0, null, disabled ? 0 : 6, 0.35);

  const pressA = disabled ? 0 : ui.spring(combine2(nid, 0), ui.pressed ? 1 : 0, MOTION.press);
  const hoverA = disabled ? 0 : ui.spring(combine2(nid, 1), hover ? 1 : 0, MOTION.hover);
  const knobR = 5 + 3 * hoverA + 2 * pressA;
  const knobX = rx + shown * rw;
  ui.dl.rect(knobX - knobR, trackCY - knobR, knobR * 2, knobR * 2, knobR, COLOR.accent, 0, null, disabled ? 0 : 8, 0.4 * pressA + 0.15);

  ui._lastId = nid; ui._lastX = rx; ui._lastY = ry; ui._lastW = rw; ui._lastH = labelH + gap + trackAreaH; ui._lastHover = hover;

  return changed ? value : -1;
}

const sliderDrag = new Map();

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function anyShift(ui) { for (let i = 0; i < ui.keyCount; i++) if (ui.keyShift(i)) return true; return false; }
// Folded to 31 bits like imgui.js's ids, so a derived spring or hit id stays
// a small integer and never has to be boxed on its way into a Map.
function combine2(a, b) { return ((a ^ Math.imul(b, 0x9e3779b1)) << 1) >> 1; }

// A control's name is also its reset: a click on the label text sets
// ui.labelClicked, and ui.control puts the value back to the schema's def.
// The hit is the text itself, not the whole line, so it never sits under
// a readout.
function labelHit(ui, nid, label, x, y, h, maxW, disabled) {
  const w = Math.min(maxW, ui.text.measure(label, TYPE.sm, W.regular));
  ui.interact(combine2(nid, 16), x, y, w, h, !!disabled);
  if (ui.hover) ui.setCursorHint('pointer');
  if (ui.clicked) ui.labelClicked = true;
}

// ---------------- segment ----------------

const segWidest = new WeakMap();   // label array -> width of its widest label

function segment(id, labels, index, disabled) {
  const ui = this;
  const nid = ui.id(id);
  const focused = disabled ? false : ui.registerFocusable(nid);
  const n = labels.length;

  ui.peek();
  const availW = ui.pw;
  ui.text.lineMetrics(TYPE.sm, ui._lm);
  // The widest label decides the wrap. Screens pass the same label array
  // every frame (ui.control caches one per control), so it is measured once
  // per array rather than once per frame.
  let widest = segWidest.get(labels);
  if (widest === undefined) {
    widest = 0;
    for (let i = 0; i < n; i++) {
      const w = ui.text.measure(labels[i], TYPE.sm, W.regular);
      if (w > widest) widest = w;
    }
    segWidest.set(labels, widest);
  }
  const singleColW = availW / n;
  const wrap = n > 2 && (widest + SPACE.md * 2) > singleColW;
  const row0 = wrap ? Math.ceil(n / 2) : n;
  const rows = wrap ? 2 : 1;
  const rh = touchAware(ui, SEG_H);
  const totalH = rows * rh + (rows - 1) * SPACE.xxs;

  ui.nextRect(totalH);
  const rx = ui.rx, ry = ui.ry, rw = ui.rw;

  ui.dl.rect(rx, ry, rw, totalH, RADIUS.pill, COLOR.well, 0, null, 0, 0);

  let newIndex = index;
  let selX = rx, selY = ry, selW = rw / row0, selH = rh;

  for (let i = 0; i < n; i++) {
    const r = wrap && i >= row0 ? 1 : 0;
    const cols = r === 0 ? row0 : (n - row0);
    const colIdx = r === 0 ? i : i - row0;
    const colW = rw / cols;
    const cx = rx + colIdx * colW;
    const cy = ry + r * (rh + SPACE.xxs);

    const iid = ui.idx(id, i);
    ui.interact(iid, cx, cy, colW, rh, !!disabled);
    if (ui.hover) ui.setCursorHint('pointer');
    if (ui.clicked) newIndex = i;

    if (i === index) { selX = cx; selY = cy; selW = colW; selH = rh; }

    const baseline = centerBaseline(ui, cy, rh, TYPE.sm);
    const isSel = i === newIndex;
    const hoverA = ui.spring(combine2(iid, 2), ui.hover && !isSel ? 1 : 0, MOTION.hover);
    if (hoverA > 0.001) {
      ui.scratch0[0] = COLOR.hover[0]; ui.scratch0[1] = COLOR.hover[1];
      ui.scratch0[2] = COLOR.hover[2]; ui.scratch0[3] = COLOR.hover[3] * hoverA;
      ui.dl.rect(cx, cy, colW, rh, RADIUS.pill, ui.scratch0, 0, null, 0, 0);
    }
    ui.text.draw(ui.dl, labels[i], cx + colW / 2, baseline, TYPE.sm, isSel ? W.semibold : W.regular,
      isSel ? COLOR.accent : COLOR.inkDim, 1, TRACK.ui, 1);
  }

  // The selection highlight springs only along the row, and only in the
  // segment's own frame: its left edge and width are springed as fractions
  // of the segment's width, then placed at this frame's rx. Springing the
  // absolute screen position (as this used to) made the highlight chase the
  // whole row whenever the row itself moved (the drawer scrolling or sliding
  // in, a group opening above it), so it trailed behind the menu. Keeping it
  // relative means only a change of selection animates, and a resize never
  // does. There is no vertical spring: y is the selected option's row this
  // frame, so in a wrapped two-row segment a selection that changes rows
  // snaps to the new row and slides only horizontally. The first spring()
  // call for an id seeds it at its target (see anim.js), so a segment that
  // just appeared shows its highlight in place rather than sliding in from 0.
  const invW = rw > 0 ? 1 / rw : 0;
  const fracX = ui.spring(combine2(nid, 3), (selX - rx) * invW, MOTION.panel);
  const fracW = ui.spring(combine2(nid, 5), selW * invW, MOTION.panel);
  ui.dl.rect(rx + fracX * rw, selY, fracW * rw, selH, RADIUS.pill, COLOR.accentSoft, 1, COLOR.accent, 0, 0);

  if (focused && ui.focusVisible) ui._focusRing(rx, ry, rw, totalH, RADIUS.pill);

  ui._lastId = nid; ui._lastX = rx; ui._lastY = ry; ui._lastW = rw; ui._lastH = totalH;
  ui._lastHover = ui.pointerX >= rx && ui.pointerX < rx + rw && ui.pointerY >= ry && ui.pointerY < ry + totalH;

  return newIndex;
}

// ---------------- select (dropdown) ----------------
// A single-choice segment whose options are too long to sit side by side
// (a schema segment with dropdown: true). The label sits on its own line,
// with the control's readout at the right as a slider's does; under it, a
// box shows the current choice and a chevron. A click on the box opens the
// options as a list right beneath it, in the layout, so the rows below move
// down rather than being covered, and it can never be clipped by the
// drawer's scroll. Picking an option, or clicking the box again, shuts it.
// Focused: Enter or Space opens and shuts, the arrows step the choice.
const selectOpen = new Set();
const SELECT_ROW_H = 28;

function select(id, label, labels, index, readout, disabled) {
  const ui = this;
  const nid = ui.id(id);
  const focused = disabled ? false : ui.registerFocusable(nid);
  const n = labels.length;
  let open = !disabled && selectOpen.has(nid);

  ui.text.lineMetrics(TYPE.sm, ui._lm);
  const labelH = ui._lm.ascent + ui._lm.descent;
  const gap = SPACE.xxs + 2;
  const boxH = touchAware(ui, SEG_H), rowH = touchAware(ui, SELECT_ROW_H);
  const totalH = labelH + gap + boxH + (open ? SPACE.xxs + n * rowH : 0);
  ui.nextRect(totalH);
  const rx = ui.rx, ry = ui.ry, rw = ui.rw;
  const by = ry + labelH + gap;

  let newIndex = index;
  labelHit(ui, nid, label, rx, ry, labelH, rw / 2, disabled);
  ui.interact(nid, rx, by, rw, boxH, !!disabled);
  const boxHover = ui.hover;
  if (boxHover) ui.setCursorHint('pointer');
  if (ui.clicked) open = !open;
  if (focused) {
    for (let i = 0; i < ui.keyCount; i++) {
      if (!ui.keyIsDown(i)) continue;
      const c = ui.keyCode(i);
      if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') open = !open;
      else if (c === 'ArrowDown' || c === 'ArrowRight') newIndex = Math.min(n - 1, newIndex + 1);
      else if (c === 'ArrowUp' || c === 'ArrowLeft') newIndex = Math.max(0, newIndex - 1);
    }
  }

  // ---- label line ----
  const baseline1 = ry + ui._lm.ascent;
  ui.text.draw(ui.dl, label, rx, baseline1, TYPE.sm, W.regular, disabled ? COLOR.inkFaint : COLOR.inkDim, 0, TRACK.ui, 1);
  if (readout) ui.text.draw(ui.dl, readout, rx + rw, baseline1, TYPE.sm, W.regular, disabled ? COLOR.inkDim : COLOR.ink, 2, TRACK.tight, 1);

  // ---- the box ----
  const hv = ui.spring(combine2(nid, 1), boxHover ? 1 : 0, MOTION.hover);
  ui.dl.rect(rx, by, rw, boxH, RADIUS.sm, COLOR.well, 1, hv > 0.5 || open ? COLOR.lineStrong : COLOR.line, 0, 0);
  ui.text.draw(ui.dl, labels[newIndex], rx + SPACE.md, centerBaseline(ui, by, boxH, TYPE.sm), TYPE.sm, W.regular,
    COLOR.ink, 0, TRACK.ui, 1);
  const rot = ui.spring(combine2(nid, 2), open ? Math.PI : 0, MOTION.hover);
  const cs = 14;
  ui.dl.icon(ICON.CHEVRON, rx + rw - SPACE.md - cs, by + (boxH - cs) / 2, cs, cs, COLOR.inkDim, 1.6, rot);
  if (focused && ui.focusVisible) ui._focusRing(rx, by, rw, boxH, RADIUS.sm);

  // ---- the list ----
  if (open) {
    const ly = by + boxH + SPACE.xxs;
    ui.dl.rect(rx, ly, rw, n * rowH, RADIUS.sm, COLOR.well, 1, COLOR.line, 0, 0);
    for (let i = 0; i < n; i++) {
      const oy = ly + i * rowH;
      const iid = ui.idx(id, 100 + i);
      ui.interact(iid, rx, oy, rw, rowH, false);
      if (ui.hover) {
        ui.setCursorHint('pointer');
        ui.dl.rect(rx + 1, oy + 1, rw - 2, rowH - 2, RADIUS.sm, COLOR.hover, 0, null, 0, 0);
      }
      if (ui.clicked) { newIndex = i; open = false; }
      const sel = i === newIndex;
      ui.text.draw(ui.dl, labels[i], rx + SPACE.md, centerBaseline(ui, oy, rowH, TYPE.sm), TYPE.sm,
        sel ? W.semibold : W.regular, sel ? COLOR.accent : COLOR.inkDim, 0, TRACK.ui, 1);
      if (sel) ui.dl.icon(ICON.CHECK, rx + rw - SPACE.md - cs, oy + (rowH - cs) / 2, cs, cs, COLOR.accent, 1.6, 0);
    }
  }

  // A press anywhere outside the box and its list shuts it. The press is not
  // taken: whatever it landed on still gets it, as a browser's select does.
  if (open && ui._downEvent) {
    const dx = ui._downX, dy = ui._downY;
    if (dx < rx || dx >= rx + rw || dy < by || dy >= ry + totalH) open = false;
  }
  if (open) selectOpen.add(nid); else selectOpen.delete(nid);
  ui._lastId = nid; ui._lastX = rx; ui._lastY = ry; ui._lastW = rw; ui._lastH = totalH;
  ui._lastHover = ui.pointerX >= rx && ui.pointerX < rx + rw && ui.pointerY >= by && ui.pointerY < ry + totalH;
  return newIndex;
}

// ---------------- toggle ----------------

// A parent toggle's label is cached upper-cased once; labels never change.
const capsLabelCache = new Map();
function capsLabel(ctrl) {
  let s = capsLabelCache.get(ctrl.id);
  if (s === undefined) { s = ctrl.label.toUpperCase(); capsLabelCache.set(ctrl.id, s); }
  return s;
}

// `heading` draws the label as a small section head (caps come from the
// caller, the weight and tracking here), for a toggle whose children nest
// beneath it.
function toggle(id, label, on, disabled, heading) {
  const ui = this;
  const nid = ui.id(id);
  const focused = disabled ? false : ui.registerFocusable(nid);
  const h = touchAware(ui, 30);
  ui.nextRect(h);
  const rx = ui.rx, ry = ui.ry, rw = ui.rw;

  // the whole line is the hit area, including an indented row's gutter
  ui.interact(nid, rx - ui.rIndent, ry, rw + ui.rIndent, h, !!disabled);
  if (ui.hover) ui.setCursorHint('pointer');
  const newOn = (!disabled && ui.clicked) ? !on : on;

  const baseline = centerBaseline(ui, ry, h, TYPE.sm);
  // The label stays dim whatever the state, like every other control label,
  // so no row outshines the section header above it; the switch shows on/off.
  ui.text.draw(ui.dl, label, rx, baseline, TYPE.sm, heading ? W.bold : W.regular,
    disabled ? COLOR.inkFaint : heading ? COLOR.inkHead : COLOR.inkDim, 0, heading ? TRACK.caps : TRACK.ui, 1);

  const onA = ui.spring(combine2(nid, 6), newOn ? 1 : 0, MOTION.hover);
  drawSwitch(ui, rx + rw - SWITCH_W, ry + h / 2 - SWITCH_H / 2, SWITCH_W, SWITCH_H, onA, newOn);

  if (focused && ui.focusVisible) ui._focusRing(rx, ry, rw, h, RADIUS.sm);

  ui._lastId = nid; ui._lastX = rx; ui._lastY = ry; ui._lastW = rw; ui._lastH = h; ui._lastHover = ui.hover;
  return newOn;
}

// The switch itself, a pill track with a round knob, shared by toggle() and
// the on/off switch a group header can carry (imgui.js group()), so the two
// always look alike. The caller owns the spring: onA is the animated on/off
// amount (0 off, 1 on) and on the state it is heading for, which picks the
// border colour at once while the fill and knob travel. x and y are the
// track's top left, fresh each frame, so the switch moves rigidly with
// whatever holds it. Writes scratch0 and scratch1.
export function drawSwitch(ui, x, y, w, h, onA, on) {
  mix4(ui.scratch0, COLOR.well, COLOR.accentSoft, onA);
  ui.dl.rect(x, y, w, h, h / 2, ui.scratch0, 1, on ? COLOR.accent : COLOR.lineSoft, 0, 0);
  const knobR = h / 2 - 2;
  const knobX = x + h / 2 + onA * (w - h);
  mix4(ui.scratch1, COLOR.inkDim, COLOR.accent, onA);
  ui.dl.rect(knobX - knobR, y + h / 2 - knobR, knobR * 2, knobR * 2, knobR, ui.scratch1, 0, null, onA > 0.5 ? 5 : 0, 0.3 * onA);
}

function mix4(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  out[3] = a[3] + (b[3] - a[3]) * t;
}

// ---------------- button ----------------

function button(id, label, variant, disabled) {
  const ui = this;
  const nid = ui.id(id);
  const focused = disabled ? false : ui.registerFocusable(nid);
  const h = touchAware(ui, BTN_H_MIN);
  ui.nextRect(h);
  const rx = ui.rx, ry = ui.ry, rw = ui.rw;

  ui.interact(nid, rx, ry, rw, h, !!disabled);
  if (ui.hover) ui.setCursorHint('pointer');
  const activated = !disabled && (ui.clicked || (focused && ui._keyActivated()));

  const hoverA = ui.spring(combine2(nid, 7), ui.hover ? 1 : 0, MOTION.hover);
  const pressA = ui.spring(combine2(nid, 8), ui.pressed ? 1 : 0, MOTION.press);

  let base, textColor, border;
  if (variant === 'primary') { base = COLOR.accent; textColor = COLOR.inkOnAccent; border = null; }
  else if (variant === 'ghost') { base = COLOR.clear; textColor = COLOR.inkDim; border = null; }
  else { base = COLOR.glassTintHi; textColor = COLOR.ink; border = COLOR.lineSoft; }

  mix4(ui.scratch0, base, COLOR.hover, hoverA * 0.5 + pressA * 0.5);
  ui.dl.rect(rx, ry, rw, h, RADIUS.md, ui.scratch0, border ? 1 : 0, border, 0, 0);

  const baseline = centerBaseline(ui, ry, h, TYPE.sm);
  ui.text.draw(ui.dl, label, rx + rw / 2, baseline, TYPE.sm, W.regular, textColor, 1, TRACK.ui, 1);

  if (focused && ui.focusVisible) ui._focusRing(rx, ry, rw, h, RADIUS.md);

  ui._lastId = nid; ui._lastX = rx; ui._lastY = ry; ui._lastW = rw; ui._lastH = h; ui._lastHover = ui.hover;
  return activated;
}

// ---------------- iconButton ----------------

function iconButton(id, icon, x, y, size, disabled) {
  const ui = this;
  const nid = ui.id(id);
  const focused = disabled ? false : ui.registerFocusable(nid);
  const hit = touchAware(ui, size);
  const hx = x - (hit - size) / 2, hy = y - (hit - size) / 2;

  ui.interact(nid, hx, hy, hit, hit, !!disabled);
  if (ui.hover) ui.setCursorHint('pointer');
  const activated = !disabled && (ui.clicked || (focused && ui._keyActivated()));

  const hoverA = ui.spring(combine2(nid, 11), ui.hover ? 1 : 0, MOTION.hover);
  const pressA = ui.spring(combine2(nid, 12), ui.pressed ? 1 : 0, MOTION.press);
  mix4(ui.scratch0, COLOR.clear, COLOR.hover, hoverA * 0.6 + pressA * 0.4);
  ui.dl.rect(x, y, size, size, RADIUS.sm, ui.scratch0, 0, null, 0, 0);
  ui.dl.icon(icon, x, y, size, size, COLOR.inkDim, 1.6, 0);

  if (focused && ui.focusVisible) ui._focusRing(x, y, size, size, RADIUS.sm);

  ui._lastId = nid; ui._lastX = x; ui._lastY = y; ui._lastW = size; ui._lastH = size; ui._lastHover = ui.hover;
  return activated;
}

// ---------------- tooltip ----------------

function tooltip(str) {
  const ui = this;
  const id = ui._lastId;
  if (id === undefined || id === -1) return;
  ui.tooltipAt(id, ui._lastX, ui._lastY, ui._lastW, ui._lastH, ui._lastHover, str);
}

// The same tooltip for a rect the caller describes, for items that are not
// toolkit widgets (the drawer's preset chips) or whose tip has to be drawn
// later than the item itself, outside a clip that would cut it. Call it every
// frame for the same id, hovered or not, so the fade out can play.
function tooltipAt(id, x, y, w0, h0, hovered, str) {
  const ui = this;
  if (hovered) {
    if (ui._tipId !== id) { ui._tipId = id; ui._tipStart = ui.t; }
  } else if (ui._tipId === id) {
    ui._tipId = -1;
  }
  const want = (ui._tipId === id && (ui.t - ui._tipStart) > TOOLTIP_DELAY_MS) ? 1 : 0;
  const op = ui.spring(combine2(id, 55), want, MOTION.fade);
  if (op < 0.01) return;

  const w = Math.min(TOOLTIP_MAX_W, ui.text.measure(str, TYPE.xs, W.regular) + SPACE.md * 2);
  ui.text.lineMetrics(TYPE.xs, ui._lm);
  const lineH = ui._lm.ascent + ui._lm.descent;
  const h = lineH + SPACE.sm * 2;

  let tx = x + w0 / 2 - w / 2;
  let ty = y - h - SPACE.xs;
  if (ty < 0) ty = y + h0 + SPACE.xs;
  if (tx < SPACE.xs) tx = SPACE.xs;
  if (tx + w > ui.width - SPACE.xs) tx = ui.width - SPACE.xs - w;

  ui.dl.pushAlpha(op);
  ui.dl.glass(tx, ty, w, h, RADIUS.sm, COLOR.glassTint, 1, 1, COLOR.lineSoft, 12, 0.35);
  ui.text.draw(ui.dl, str, tx + w / 2, ty + h / 2 + (ui._lm.ascent - ui._lm.descent) / 2, TYPE.xs, W.regular, COLOR.ink, 1, TRACK.ui, 1);
  ui.dl.popAlpha();
  ui._unsettled = ui._unsettled || op > 0.001 && op < 0.999;
}

// ---------------- text field ----------------

export const TEXT_IDLE = -1, TEXT_EDITING = 0, TEXT_COMMIT = 1, TEXT_CANCEL = 2;
const CARET_PERIOD_MS = 1060, CARET_ON_MS = 620;

export function makeTextState(maxLen, placeholder) {
  return {
    text: '', caret: 0, selAll: false, numeric: false, active: false,
    maxLen: maxLen || 64, placeholder: placeholder || '',
    focusPending: false, blinkT0: 0,
    // the ui.frame this field last ran on, to notice a frame it was not drawn
    seenFrame: 0,
    // measured on a keystroke, read every frame: text width, caret offset
    // from the text's left edge, horizontal scroll for an overlong text
    dirty: true, size: 0, textW: 0, caretX: 0, scrollX: 0
  };
}

function textBegin(st, initial, selectAll, numeric) {
  const ui = this;
  st.text = initial === undefined || initial === null ? '' : String(initial).slice(0, st.maxLen);
  st.caret = st.text.length;
  st.selAll = !!selectAll && st.text.length > 0;
  st.numeric = !!numeric;
  st.active = true;
  st.focusPending = true;
  st.seenFrame = ui.frame;
  st.blinkT0 = ui.t;
  st.scrollX = 0;
  st.dirty = true;
  // Counts as editing from this frame on, so a key typed straight after the
  // click that opened the field never reaches a global shortcut.
  ui._textSeen = true;
}

function measureText(ui, st, size) {
  st.size = size;
  st.textW = st.text.length ? ui.text.measure(st.text, size, W.regular) : 0;
  st.caretX = st.caret >= st.text.length ? st.textW
    : st.caret <= 0 ? 0 : ui.text.measure(st.text.slice(0, st.caret), size, W.regular);
  st.dirty = false;
}

// Caret index nearest a pointer offset from the text's left edge. Measures
// growing prefixes, so it builds strings, but only on a press.
function caretFromX(ui, st, size, px) {
  if (px <= 0) return 0;
  let prev = 0;
  for (let i = 1; i <= st.text.length; i++) {
    const wi = ui.text.measure(st.text.slice(0, i), size, W.regular);
    if (px < (prev + wi) / 2) return i - 1;
    prev = wi;
  }
  return st.text.length;
}

function insertChar(st, ch) {
  if (st.numeric && ch === ',') ch = '.';
  const base = st.selAll ? '' : st.text, c = st.selAll ? 0 : st.caret;
  if (base.length >= st.maxLen) return false;
  if (st.numeric) {
    if (ch === '-') {
      if (c !== 0 || base.charAt(0) === '-') return false;
    } else {
      if (ch === '.') { if (base.indexOf('.') !== -1) return false; }
      else if (!(ch >= '0' && ch <= '9')) return false;
      // nothing may go in front of a leading minus
      if (c === 0 && base.charAt(0) === '-') return false;
    }
  }
  st.text = base.slice(0, c) + ch + base.slice(c);
  st.caret = c + 1;
  st.selAll = false;
  return true;
}

function finishText(ui, st, nid, status) {
  st.active = false;
  st.focusPending = false;
  if (ui.focusId === nid) ui.focusId = -1;
  return status;
}

function textField(id, x, y, w, h, st, size, align) {
  const ui = this;
  if (!st.active) return TEXT_IDLE;
  const nid = ui.id(id);
  // A field skipped for a frame lost its focus without a commit or cancel
  // ever running (textEditing already dropped, since _textSeen went unset),
  // so it is dropped now instead of springing back mid-edit, and finishText
  // lets go of the focus it still holds (a press it held was already let go
  // by ui.end() on the frame it went undrawn). textBegin stamps seenFrame,
  // so a field first drawn on the frame after it opened is not caught here.
  const gap = st.seenFrame < ui.frame - 1;
  st.seenFrame = ui.frame;
  if (gap) return finishText(ui, st, nid, TEXT_CANCEL);
  const sz = size === undefined ? TYPE.xs : size;
  ui.registerFocusable(nid);
  if (st.focusPending) { st.focusPending = false; ui.focusId = nid; ui.focusVisible = false; }

  // A press anywhere else commits, like a browser field losing focus, and
  // so does focus moving on (Tab, or a press some widget drawn earlier this
  // frame already claimed). The press itself carries on to whatever it
  // landed on.
  const inRect = ui.pointerX >= x && ui.pointerX < x + w && ui.pointerY >= y && ui.pointerY < y + h;
  if ((ui._downEvent && !inRect) || ui.focusId !== nid) return finishText(ui, st, nid, TEXT_COMMIT);

  if (st.dirty || st.size !== sz) measureText(ui, st, sz);
  const pad = Math.min(10, h / 2);
  const avail = w - pad * 2;

  ui.interact(nid, x, y, w, h, false);
  if (ui.hover) ui.setCursorHint('text');
  if (ui.dbl) {
    st.selAll = st.text.length > 0;
    st.blinkT0 = ui.t;
  } else if (ui._downEvent && inRect && ui.activeId === nid) {
    const ox0 = textOriginX(st, x, w, pad, avail, align);
    st.caret = caretFromX(ui, st, sz, ui.pointerX - ox0);
    st.selAll = false;
    st.dirty = true;
    st.blinkT0 = ui.t;
  }

  for (let i = 0; i < ui.keyCount; i++) {
    if (!ui.keyIsDown(i)) continue;
    const key = ui.keyKey(i), code = ui.keyCode(i);
    const cmd = ui.keyMeta(i) || ui.keyCtrl(i);
    const len = st.text.length;
    if (key === 'Enter') return finishText(ui, st, nid, TEXT_COMMIT);
    if (key === 'Escape') return finishText(ui, st, nid, TEXT_CANCEL);
    if (key === 'Backspace') {
      if (st.selAll || (cmd && st.caret > 0)) {
        st.text = st.selAll ? '' : st.text.slice(st.caret);
        st.caret = 0;
      } else if (st.caret > 0) {
        st.text = st.text.slice(0, st.caret - 1) + st.text.slice(st.caret);
        st.caret--;
      }
      st.selAll = false;
    } else if (key === 'Delete') {
      if (st.selAll) { st.text = ''; st.caret = 0; }
      else if (st.caret < len) st.text = st.text.slice(0, st.caret) + st.text.slice(st.caret + 1);
      st.selAll = false;
    } else if (key === 'ArrowLeft') {
      st.caret = st.selAll || cmd ? 0 : Math.max(0, st.caret - 1);
      st.selAll = false;
    } else if (key === 'ArrowRight') {
      st.caret = st.selAll || cmd ? len : Math.min(len, st.caret + 1);
      st.selAll = false;
    } else if (key === 'Home' || key === 'ArrowUp') {
      st.caret = 0; st.selAll = false;
    } else if (key === 'End' || key === 'ArrowDown') {
      st.caret = len; st.selAll = false;
    } else if (cmd) {
      if (code === 'KeyA') st.selAll = len > 0;
      continue;   // every other shortcut belongs to the browser
    } else if (key.length === 1) {
      if (!insertChar(st, key)) continue;
    } else {
      continue;   // Shift, Alt, dead keys, function keys
    }
    st.dirty = true;
    st.blinkT0 = ui.t;
  }
  if (st.dirty) measureText(ui, st, sz);

  // ---- draw ----
  const ox = textOriginX(st, x, w, pad, avail, align);
  ui.dl.rect(x, y, w, h, RADIUS.pill, COLOR.wellHi, 1, COLOR.accent, 0, 0);
  const baseline = centerBaseline(ui, y, h, sz);
  const asc = ui._lm.ascent, desc = ui._lm.descent;
  ui.dl.pushClip(x + pad / 2, y, w - pad, h);
  if (st.selAll) {
    ui.dl.rect(ox - 1, baseline - asc - 1, st.textW + 2, asc + desc + 2, RADIUS.xs / 2, COLOR.accentSoft, 0, null, 0, 0);
  }
  if (st.text.length) {
    ui.text.draw(ui.dl, st.text, ox, baseline, sz, W.regular, COLOR.ink, 0, TRACK.tight, 1);
  } else if (st.placeholder) {
    ui.text.draw(ui.dl, st.placeholder, ox, baseline, sz, W.regular, COLOR.inkFaint, align | 0, TRACK.tight, 1);
  }
  if (!st.selAll && (ui.t - st.blinkT0) % CARET_PERIOD_MS < CARET_ON_MS) {
    ui.dl.rect(ox + st.caretX - 0.75, baseline - asc, 1.5, asc + desc, 0.75, COLOR.accent, 0, null, 0, 0);
  }
  ui.dl.popClip();

  ui._textSeen = true;
  ui._unsettled = true;   // the caret blinks
  ui._lastId = nid; ui._lastX = x; ui._lastY = y; ui._lastW = w; ui._lastH = h; ui._lastHover = ui.hover;
  return TEXT_EDITING;
}

// Where the text's left edge sits: aligned within the field while it fits,
// otherwise scrolled just far enough to keep the caret inside. scrollX is
// edit state (how far the viewer has typed past the edge), not layout, so it
// is kept on st and never springs.
function textOriginX(st, x, w, pad, avail, align) {
  if (st.textW <= avail) {
    st.scrollX = 0;
    // an empty text anchors where the caret should wait: the aligned edge
    if (!align) return x + pad;
    return align === 2 ? x + w - pad - st.textW : x + (w - st.textW) / 2;
  }
  if (st.caretX - st.scrollX > avail) st.scrollX = st.caretX - avail;
  if (st.caretX < st.scrollX) st.scrollX = st.caretX;
  if (st.scrollX > st.textW - avail) st.scrollX = st.textW - avail;
  if (st.scrollX < 0) st.scrollX = 0;
  return x + pad - st.scrollX;
}

// ---------------- control: schema dispatch ----------------

// The two schema files grew two conventions for an action: the audio side
// gives it act(S), the visual side a set(S). Both mean "do it", so both are
// honoured rather than rewriting one schema to match the other.
export function runAction(ctrl, S) {
  if (ctrl.act) ctrl.act(S); else if (ctrl.set) ctrl.set(S, 1);
}

// An action with a format() shows live state on its face ("music: on"), the
// way v0's quick chips did. Formatting builds a string, so it is refreshed
// on a click and otherwise about five times a second, which catches changes
// made elsewhere (a preset, the drawer) without allocating every frame.
const ACTION_REFRESH_MS = 200;
export function actionLabel(ui, ctrl, S, force) {
  if (!ctrl.format) return ctrl.label;
  let cache = formatCache.get(ctrl.id);
  if (!cache) { cache = { pos: -1e9, text: '' }; formatCache.set(ctrl.id, cache); }
  if (force || ui.t - cache.pos > ACTION_REFRESH_MS) { cache.pos = ui.t; cache.text = ctrl.format(S); }
  return cache.text;
}

// Multi-select chips (the word themes): a wrapped flow of pills, each lit when
// its value is in the control's current set. set(S, value) toggles one.
const chipWidths = new Map();          // ctrl.id -> Float32Array of pill widths
const CHIP_H = 24, CHIP_GAP = 6, CHIP_PAD = 10;
function multiChips(ui, ctrl, S, enabled) {
  const opts = ctrl.options;
  let widths = chipWidths.get(ctrl.id);
  if (!widths || widths.length !== opts.length) {
    widths = new Float32Array(opts.length);
    for (let i = 0; i < opts.length; i++) widths[i] = ui.text.measure(opts[i].label, TYPE.xs, W.regular) + CHIP_PAD * 2;
    chipWidths.set(ctrl.id, widths);
  }
  ui.label(ctrl.label, TYPE.sm, W.regular, COLOR.inkDim);
  // Measure the wrapped height first so the layout reserves exactly it,
  // against the width nextRect is about to hand out (narrower when indented).
  ui.peek();
  const maxW = ui.pw;
  let lines = 1, lx = 0;
  for (let i = 0; i < opts.length; i++) {
    if (lx > 0 && lx + widths[i] > maxW) { lines++; lx = 0; }
    lx += widths[i] + CHIP_GAP;
  }
  ui.nextRect(lines * CHIP_H + (lines - 1) * CHIP_GAP);
  const x0 = ui.rx, y0 = ui.ry, cur = ctrl.get(S);
  let x = x0, y = y0, changed = false;
  for (let i = 0; i < opts.length; i++) {
    const w = widths[i];
    if (x > x0 && x + w > x0 + maxW) { x = x0; y += CHIP_H + CHIP_GAP; }
    const id = ui.idx(ctrl.id, i);
    ui.interact(id, x, y, w, CHIP_H, !enabled);
    const on = cur && cur.indexOf(opts[i].value) !== -1;
    if (ui.clicked) { ctrl.set(S, opts[i].value); changed = true; }
    const h = ui.spring(id, ui.hover ? 1 : 0, MOTION.hover);
    ui.dl.rect(x, y, w, CHIP_H, RADIUS.pill, on ? COLOR.accentSoft : (h > 0.5 ? COLOR.wellHi : COLOR.well), 0, null, 0, 0);
    ui.text.draw(ui.dl, opts[i].label, x + w / 2, centerBaseline(ui, y, CHIP_H, TYPE.xs), TYPE.xs, W.regular,
                 on ? COLOR.accent : COLOR.inkDim, 1, TRACK.ui, 1);
    x += w + CHIP_GAP;
  }
  return changed;
}

// Colour: a row of curated swatches rather than a full picker. These are the
// hues the presets and sessions have actually used, plus white; the one that
// matches the current colour wears a ring. A full hue/sat picker can replace
// this later without the schema noticing, since it only calls set(S, hex).
const SWATCH_HEX = ['#d400ff', '#b455ff', '#6ea8fe', '#00ccff', '#00ffa2', '#4ad9a0',
                    '#ffb13b', '#ff7ad9', '#ff5a5a', '#ffffff'];
const SWATCH_RGBA = SWATCH_HEX.map(h => {
  const n = parseInt(h.slice(1), 16), v = new Float32Array(4);
  v[0] = (n >> 16 & 255) / 255; v[1] = (n >> 8 & 255) / 255; v[2] = (n & 255) / 255; v[3] = 1;
  return v;
});
const SW = 22, SW_GAP = 8;
// The current colour lowercased, redone only when get() hands back a
// different string, so a steady colour costs no string work per frame.
let swRaw = null, swLower = '';
function swatches(ui, ctrl, S, enabled) {
  ui.peek();
  ui.text.lineMetrics(TYPE.sm, ui._lm);
  labelHit(ui, ui.id(ctrl.id), ctrl.label, ui.px, ui.py, ui._lm.ascent + ui._lm.descent, ui.pw, !enabled);
  ui.label(ctrl.label, TYPE.sm, W.regular, COLOR.inkDim);
  ui.nextRect(SW + 4);
  const raw = ctrl.get(S);
  if (raw !== swRaw) { swRaw = raw; swLower = String(raw).toLowerCase(); }
  const cur = swLower;
  let changed = false;
  for (let i = 0; i < SWATCH_HEX.length; i++) {
    const x = ui.rx + i * (SW + SW_GAP), y = ui.ry + 2;
    if (x + SW > ui.rx + ui.rw) break;
    const id = ui.idx(ctrl.id, i);
    ui.interact(id, x, y, SW, SW, !enabled);
    if (ui.clicked) { ctrl.set(S, SWATCH_HEX[i]); changed = true; }
    const h = ui.spring(id, ui.hover ? 1 : 0, MOTION.hover);
    const grow = 1 + h * 2;
    ui.dl.rect(x - grow / 2, y - grow / 2, SW + grow, SW + grow, (SW + grow) / 2, SWATCH_RGBA[i],
               cur === SWATCH_HEX[i] ? 2 : 1, cur === SWATCH_HEX[i] ? COLOR.ink : COLOR.lineSoft, 0, 0);
  }
  return changed;
}

// ---------------- slider position mapping ----------------

// A log slider's Alt+wheel and arrow-key notch: a fixed share of the travel,
// since step/range means nothing once equal travel no longer covers equal
// units. 1/100 is about 7% of the value anywhere on a 1..1000 range.
const LOG_STEP01 = 0.01;

function isLogTaper(ctrl) {
  return ctrl.taper === 'log' && ctrl.min > 0 && ctrl.max > ctrl.min;
}

// Position (the control's own units) to track fraction, and back. The log
// form is ln(pos/min) / ln(max/min), clamped, so a stray position at or
// below zero pins to the bottom rather than turning into NaN.
function posToUnit(ctrl, pos, log) {
  if (log) {
    const u = Math.log(pos / ctrl.min) / Math.log(ctrl.max / ctrl.min);
    return !(u > 0) ? 0 : u > 1 ? 1 : u;
  }
  return (pos - ctrl.min) / ((ctrl.max - ctrl.min) || 1);
}
function unitToPos(ctrl, u, log) {
  if (log) return ctrl.min * Math.pow(ctrl.max / ctrl.min, u);
  return ctrl.min + u * ((ctrl.max - ctrl.min) || 1);
}

// Clamped to [min, max] and snapped to step. Math.round(v / step) * step
// leaves binary dust on a fractional step (0.1 * 7 is 0.7000000000000001),
// which then lands in state and saved settings, so the result is also
// rounded to the step's own count of decimals.
function snapPos(ctrl, v) {
  const lo = ctrl.min, hi = ctrl.max, step = ctrl.step;
  if (v < lo) v = lo; else if (v > hi) v = hi;
  if (step) {
    let p = 1;
    for (let d = 0; d < 6 && Math.abs(Math.round(step * p) - step * p) > 1e-9; d++) p *= 10;
    v = Math.round(Math.round(v / step) * step * p) / p;
    if (v < lo) v = lo; else if (v > hi) v = hi;
  }
  return v;
}

// ---------------- typed readouts ----------------

// The one readout being edited, if any: its text state, the slider it
// belongs to (by scoped id, so the same control drawn in two places cannot
// both open), the seed it opened with, and the field's width, fixed at open
// so the pill does not jump as the viewer types. frameT/prevT track frames
// by the clock so a field whose row vanished can be noticed and dropped.
const ro = {
  st: makeTextState(24), nid: -1, seed: '', fieldW: 0,
  drawnT: -1, frameT: -1, prevT: -1
};
const RO_FIELD_MIN_W = 64, RO_FIELD_SLACK = 28;

// The number as the readout shows it, unit and decoration stripped:
// '-12.0 dB' gives '-12.0', '±1.0 Hz' gives '1.0', '-inf dB' gives '-inf'.
// A readout with no number in it (v0 prints 'off' at the bottom of a couple
// of ranges) opens on the position instead, which for a control without a
// parse is the same units anyway. Runs on a click, so the regex is fine.
function readoutSeed(ctrl, text, pos) {
  if (ctrl.entry === 'text') return text;
  const m = /-?inf|-?\d*\.?\d+/i.exec(text);
  if (m) return m[0];
  return ctrl.parse ? '' : String(pos);
}

function beginReadoutEdit(ui, ctrl, nid, text, pos) {
  ro.nid = nid;
  ro.seed = readoutSeed(ctrl, text, pos);
  ro.fieldW = Math.max(RO_FIELD_MIN_W, ui.sliderReadoutW + RO_FIELD_SLACK);
  ro.drawnT = ui.t;
  ui.textBegin(ro.st, ro.seed, true, ctrl.entry !== 'text');
}

// Displayed units to a position, through the control's parse when it has
// one, else as the position itself. Anything that does not read as a number
// cancels, and so does committing the seed untouched: the seed is the
// readout rounded for display, and writing it back would quietly move a
// value the viewer only looked at.
function commitReadout(ctrl, S, text) {
  const t = text.trim();
  if (!t || t === ro.seed) return false;
  const raw = ctrl.parse ? ctrl.parse(S, t) : parseFloat(t);
  if (typeof raw !== 'number' || !isFinite(raw)) return false;
  const pos = snapPos(ctrl, raw);
  if (pos === ctrl.get(S)) return false;
  ctrl.set(S, pos);
  return true;
}

function control(ctrl, S) {
  const ui = this;
  if (ctrl.visible && !ctrl.visible(S)) return false;
  const enabled = ctrl.enabled ? ctrl.enabled(S) : true;
  if (!enabled) ui.dl.pushAlpha(0.45);

  let changed = false;
  ui.labelClicked = false;
  switch (ctrl.kind === 'segment' && ctrl.multi ? 'segment-multi' : ctrl.kind) {
    case 'slider': {
      const nid = ui.id(ctrl.id);
      if (ui.t !== ro.frameT) { ro.prevT = ro.frameT; ro.frameT = ui.t; }
      let editing = ro.st.active && ro.nid === nid;
      // A field that was not drawn on the last frame any slider was (its row
      // went away without a press or a key to close it), or whose control has
      // since locked, is dropped rather than left to reappear half-typed later.
      if (editing && (ro.drawnT < ro.prevT || !enabled)) { ro.st.active = false; ro.nid = -1; editing = false; }

      // The field runs before the slider, at the spot the slider is about to
      // take, so a press on the track commits first and then drags, the order
      // a browser's blur-then-click gives.
      if (editing) {
        ui.peek();
        ui.text.lineMetrics(TYPE.sm, ui._lm);
        const lineH = ui._lm.ascent + ui._lm.descent;
        const status = ui.textField('slider.readoutEdit', ui.px + ui.pw - ro.fieldW, ui.py - RO_PAD_Y,
                                    ro.fieldW, lineH + RO_PAD_Y * 2, ro.st, TYPE.sm, 2);
        ro.drawnT = ui.t;
        if (status === TEXT_COMMIT) { if (commitReadout(ctrl, S, ro.st.text)) changed = true; }
        if (status !== TEXT_EDITING) { ro.nid = -1; editing = false; }
      }

      let cache = formatCache.get(ctrl.id);
      if (!cache) { cache = { pos: NaN, text: '' }; formatCache.set(ctrl.id, cache); }
      const pos = ctrl.get(S);
      if (pos !== cache.pos) { cache.pos = pos; cache.text = ctrl.format ? ctrl.format(S) : String(pos); }
      const log = isLogTaper(ctrl);
      const value01 = posToUnit(ctrl, pos, log);
      const step01 = log ? LOG_STEP01 : ctrl.step ? (ctrl.step / ((ctrl.max - ctrl.min) || 1)) : 0.02;
      const def01 = ctrl.def !== undefined ? posToUnit(ctrl, ctrl.def, log) : undefined;
      const nv = ui.slider(ctrl.id, ctrl.label, value01, cache.text, step01, def01, !enabled,
                           editing ? RO_HIDDEN : enabled ? RO_CLICK : RO_PLAIN);
      if (nv >= 0) {
        let newPos = snapPos(ctrl, unitToPos(ctrl, nv, log));
        if (newPos === pos && ui.sliderNudge !== 0 && ctrl.step) newPos = snapPos(ctrl, pos + ui.sliderNudge * ctrl.step);
        if (newPos !== pos) { ctrl.set(S, newPos); changed = true; }
      }
      if (!editing && ui.sliderReadoutClicked) beginReadoutEdit(ui, ctrl, nid, cache.text, pos);
      break;
    }
    case 'segment': {
      let labels = segmentLabelCache.get(ctrl.id);
      if (!labels) {
        labels = new Array(ctrl.options.length);
        for (let i = 0; i < ctrl.options.length; i++) labels[i] = ctrl.options[i].label;
        segmentLabelCache.set(ctrl.id, labels);
      }
      const cur = ctrl.get(S);
      let idx = 0;
      for (let i = 0; i < ctrl.options.length; i++) if (ctrl.options[i].value === cur) { idx = i; break; }
      let ni;
      if (ctrl.dropdown) {
        // the readout is rebuilt at most four times a second, not per frame
        let cache = formatCache.get(ctrl.id);
        if (!cache) { cache = { pos: NaN, text: '', at: -1e9 }; formatCache.set(ctrl.id, cache); }
        if (ctrl.format && ui.t - cache.at > 250) { cache.at = ui.t; cache.text = ctrl.format(S); }
        ni = ui.select(ctrl.id, ctrl.label, labels, idx, cache.text, !enabled);
      } else ni = ui.segment(ctrl.id, labels, idx, !enabled);
      if (ni !== idx) { ctrl.set(S, ctrl.options[ni].value); changed = true; }
      break;
    }
    case 'toggle': {
      const on = !!ctrl.get(S);
      const nOn = ui.toggle(ctrl.id, ctrl.hasChildren ? capsLabel(ctrl) : ctrl.label,
                            on, !enabled, ctrl.hasChildren);
      if (nOn !== on) { ctrl.set(S, nOn ? 1 : 0); changed = true; }
      break;
    }
    case 'action': {
      const clicked = ui.button(ctrl.id, actionLabel(ui, ctrl, S, false), 'chip', !enabled);
      if (clicked) { runAction(ctrl, S); actionLabel(ui, ctrl, S, true); changed = true; }
      break;
    }
    case 'segment-multi':
      changed = multiChips(ui, ctrl, S, enabled);
      break;
    case 'color':
      changed = swatches(ui, ctrl, S, enabled);
      break;
  }
  if (ui.labelClicked && enabled && ctrl.def !== undefined && ctrl.get(S) !== ctrl.def) {
    ctrl.set(S, ctrl.def);
    changed = true;
  }

  if (!enabled) ui.dl.popAlpha();
  return changed;
}
