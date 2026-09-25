// The settings drawer: one glass pane down the left edge, sliding in and out
// on a spring, holding every control in the schema as collapsible groups.
//
// Nothing in here knows what a control does. The schema says what exists and
// how each one reads and writes state; the toolkit says how a slider or a
// segment looks and feels; this file only decides the order and the grouping,
// in v0's order so the drawer reads the way it always has. Adding a control
// is a schema edit, never an edit here.
//
// The drawer also owns S.edgeInset, the width of the field it covers. The
// scene recentres on the visible field from it, the same as v0's rendered
// panel edge, so the composition slides aside rather than being covered.
import { S } from '../../../js/state.js';
import { CONTROLS, SECTIONS, byId } from '../../core/schema.js';
import {
  presetsVersion, presetCount, presetLabel, presetHasOverride,
  applyPresetAt, savePresetOverAt, addUserPreset, deletePresetAt, movePreset
} from '../../core/presets.js';
import { ICON } from '../drawlist.js';
import { loadUiState, saveUiState } from '../../core/store.js';
import { prof, profToggle, profSave, profCopy } from '../../core/profiler.js';
import { makeTextState, TEXT_COMMIT } from '../widgets.js';
import { COLOR, TYPE, TRACK, W, RADIUS, LAYOUT, MOTION, SPACE } from '../theme.js';

const DRAWER_SECTIONS = ['layers', 'strobe', 'text', 'corners', 'tunnel', 'edge', 'flowers', 'kaleido', 'particles', 'fireworks', 'audio', 'music', 'atmosphere', 'render'];

// The control each section's header switch stands for: the layer's own on/off,
// the same one the section holds as its first row, so the header and the row
// always agree. A section missing here, or whose control the schema does not
// have (yet), gets a header with no switch.
const SECTION_SWITCH = {
  strobe: 'fieldOn', corners: 'cornersOn', tunnel: 'ringsOn', edge: 'edgeOn', text: 'textOn',
  flowers: 'flowersOn', kaleido: 'kaleidoOn', particles: 'particlesOn', fireworks: 'fireworksOn',
  audio: 'audioOn', music: 'musicOn', atmosphere: 'ambOn'
};

// A header switch's control, resolved once: a toggle, or a two-way segment
// whose option values are booleans. For a segment the on and off options are
// found here, so flipping the switch sets the matching option's own value.
function makeSwitch(id) {
  const ctrl = id ? byId(id) : undefined;
  if (!ctrl) return null;
  if (ctrl.kind === 'toggle') return { ctrl, onValue: null, offValue: null };
  if (ctrl.kind === 'segment' && ctrl.options && !ctrl.multi) {
    const on = ctrl.options.find(o => !!o.value), off = ctrl.options.find(o => !o.value);
    if (on && off) return { ctrl, onValue: on.value, offValue: off.value };
  }
  return null;
}

// Built once: per section, its controls in schema order with a sub-heading
// item wherever the sub-group changes, so the frame loop only walks arrays.
// A section the schema does not define (one still being merged) is left out.
const GROUPS = DRAWER_SECTIONS.filter(id => SECTIONS.some(s => s.id === id)).map(id => {
  const sec = SECTIONS.find(s => s.id === id);
  const items = [];
  let sub = null;
  for (const c of CONTROLS) {
    if (c.section !== id) continue;
    // The section's own switch lives in the header; a body row for the same
    // control would just say "On" twice, so it is left out here.
    if (c.id === SECTION_SWITCH[id]) continue;
    if (c.sub && c.sub !== sub) { sub = c.sub; items.push({ heading: c.sub.toUpperCase() }); }
    items.push(c);
  }
  const runs = childRuns(items, id);
  return { gid: 'drawer.' + id, title: sec.title, items, sw: makeSwitch(SECTION_SWITCH[id]),
           open: runs.open, close: runs.close, closeEnd: runs.closeEnd };
});

// The second level of the hierarchy, under the section line: a control whose
// schema `parent` names the toggle or segment above it is a child row, drawn
// one indent in with a fainter guide line down the run (imgui.js
// beginIndent). Children must follow their parent directly, and a child may
// itself be a parent, one level further in. Worked out once per section into
// two small arrays so the frame loop only counts: close[i] is how many runs
// end before item i, open[i] whether one starts at it, and closeEnd how many
// are still open after the last item. A sub-heading ends every run. A child
// whose parent is not the item straight above it (or an open run's parent)
// is drawn as an ordinary row, with a warning, rather than guessed at.
function childRuns(items, sectionId) {
  const n = items.length;
  const open = new Uint8Array(n), close = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const p = it.heading ? undefined : it.parent;
    const prev = items[i - 1];
    // The first child of the row straight above opens a run one level inside
    // whatever runs that row sits in. Otherwise runs close until the one
    // this item belongs to (none, for an ordinary row or a heading).
    if (p && prev && !prev.heading && prev.id === p) { stack.push(p); open[i] = 1; continue; }
    while (stack.length && stack[stack.length - 1] !== p) { stack.pop(); close[i]++; }
    if (p && !stack.length) {
      console.warn('drawer: ' + sectionId + '.' + it.id + ' names parent ' + p + ', which is not the row above it; drawn unindented');
    }
  }
  return { open, close, closeEnd: stack.length };
}

// Writes a header switch through its control's set(), so every side effect
// the section's own row would run (audio starting, the store saving) runs
// here too. A toggle gets 1 or 0, exactly as ui.control hands it one.
function setSwitch(sw, on) {
  if (sw.ctrl.kind === 'toggle') sw.ctrl.set(S, on ? 1 : 0);
  else sw.ctrl.set(S, on ? sw.onValue : sw.offValue);
}

// Which sections the viewer left open, restored at the next load. Every
// section starts shut on a first visit; after that the toolkit asks
// groupOpenAtStart once per section as it first draws, and each open or close
// rewrites the saved list (a click's worth of work, never per frame). The set
// is read from the store the first time the drawer draws, well after main.js
// has handed the store its storage.
let openGroups = null;

function groupOpenAtStart(id) {
  return openGroups.has(id);
}

function groupToggled(id, open) {
  if (open) openGroups.add(id); else openGroups.delete(id);
  saveUiState({ openGroups: Array.from(openGroups) });
}

function installGroupMemory(ui) {
  const saved = loadUiState();
  const list = saved && Array.isArray(saved.openGroups) ? saved.openGroups : [];
  openGroups = new Set();
  for (const id of list) if (typeof id === 'string') openGroups.add(id);
  ui.groupInitialOpen = groupOpenAtStart;
  ui.onGroupToggle = groupToggled;
}

// The preset row: the built-ins, then the viewer's own, then a + chip that
// turns into a name field in place. Chip widths are measured when the list
// changes (presetsVersion), not per frame.
const PRESET_H = 26, PRESET_GAP = 6, CHIP_PAD = 10;
const ADD_W = 30, EDIT_MIN_W = 110;
let presetW = new Float32Array(16);
let widthsVersion = -1;
const nameEdit = makeTextState(32, 'Name');
// Confirmation after a save: the chip that was saved reads "Saved" and
// takes an accent wash for SAVED_MS, springing in and out on that state.
const SAVED_MS = 1200;
let savedIdx = -1, savedUntil = 0;
const TIP_PRESET = 'Click to load  ·  Shift-click to save over';
const TIP_ADD = 'Save the current settings as a new preset';
const TIP_EDIT = 'Delete or reorder presets';
const TIP_EDITING = 'Drag to reorder  ·  × to delete';

// Edit mode: the chip right of + turns it on and off. While on, every chip
// wears an × in its upper right corner that deletes it, a click no longer
// loads it, and a chip can be dragged to a new place in the row; an accent
// bar marks where it will land, and it moves there on release.
let presetEditing = false;
const DEL_R = 7, EDIT_PAD = 8;     // the ×'s radius, and the room it takes in a chip's right pad
const DRAG_SLOP = 4;
const drag = { k: -1, moved: false, ox: 0, oy: 0, sx: 0, sy: 0, ins: -1, lineY: 0, last: 0 };
let delHover = false;
// this frame's chip rects, for the drop target
let chipX = new Float32Array(16), chipY = new Float32Array(16), chipW = new Float32Array(16);
let editLabelW = 0;
// The row sits at the very top of the scroll body, so a tooltip above it
// would be cut by the scroll clip. The hovered chip is noted here and its
// tooltip drawn once the pane is closed off, clear of every clip.
const tip = { id: -1, x: 0, y: 0, w: 0, h: 0, hover: false, str: '' };

const W_DRAWER = LAYOUT.drawerW, PAD_X = LAYOUT.drawerPadX, TOP = LAYOUT.drawerPadTop;
const BLEED = 24;   // the pane runs past the screen's left, top and bottom so only its right edge shows

// Three nested columns, because every clip in the toolkit is exactly the box
// it clips and widgets draw a little past their own rects.
//
// The scroll viewport spans the whole visible pane, so its clip never cuts
// anything. Group headers sit HEAD_X in from each edge; their hover fill and
// focus ring (2 px out plus a 1.5 px border) stay well inside the viewport,
// and on the right they stop short of the auto-hiding scrollbar, which
// endScroll draws 4 px wide, 2 px in from the viewport's right edge (from
// dx + 334 to dx + 338; headers end at dx + 330, their ring at dx + 332).
// A header pinned to the top of the viewport while its section scrolls under
// it (imgui.js group()) keeps the same column, 4 px below the viewport's top
// so its ring clears that edge too, on a strip of this pane that spans the
// whole viewport width; the scrollbar is drawn after the scroll closes, so
// it stays on top of that strip.
//
// Each group clips its body to its header's width, so controls inside a group
// are inset a further KNOB_OVERHANG. That is widgets.js's slider knob at full
// size: knobR = 5 + 3 * hover + 2 * press, so a pressed knob at 0% or 100%
// reaches 10 px past the track end. Its soft shadow runs a few px further,
// but it is black at low alpha on dark glass and fades out against the
// group's edge. The same 10 px covers every focus ring (3.5 px), the
// swatches' hover grow and ring (about 3 px) and the segment highlight,
// which never leaves its own rect.
//
// The result keeps the control column exactly where it always was, PAD_X
// from each side (300 px, centred in the 340 px pane), with the headers
// 10 px wider on each side. The colour swatch row needs 292 px for all ten
// swatches, so this is also the narrowest the control column can be.
const KNOB_OVERHANG = 5 + 3 + 2;
const HEAD_X = PAD_X - KNOB_OVERHANG;
const HEAD_W = W_DRAWER - HEAD_X * 2, BODY_W = W_DRAWER - PAD_X * 2;

// Readouts refresh a few times a second; formatting them is string work the
// frame loop should not do 120 times a second.
// Each line is rebuilt only when a number it prints has changed at the
// precision it prints, so a steady display makes no strings at all.
const meta = { at: -1e9, a: '', b: '',
               hz: NaN, lock: NaN, freq: NaN, fpc: NaN, med: NaN, worst: NaN, drops: NaN };
function refreshMeta(t) {
  if (t - meta.at < 250) return;
  meta.at = t;
  const hzK = S.refreshHz ? Math.round(S.refreshHz * 10) : -1;
  const lockK = S.frameLock ? 1 : 0, fpcK = S.frameLock && S.framesPerCycle ? S.framesPerCycle : 0;
  const freqK = fpcK ? Math.round(S.achievedFreq * 100) : 0;
  if (hzK !== meta.hz || lockK !== meta.lock || fpcK !== meta.fpc || freqK !== meta.freq) {
    meta.hz = hzK; meta.lock = lockK; meta.fpc = fpcK; meta.freq = freqK;
    const hz = S.refreshHz ? S.refreshHz.toFixed(1) + ' Hz' : 'measuring';
    const lock = S.frameLock && S.framesPerCycle
      ? S.achievedFreq.toFixed(2) + ' Hz at ' + S.framesPerCycle + ' fr'
      : (S.frameLock ? 'on' : 'off');
    meta.a = 'Display ' + hz + '   ·   lock ' + lock;
  }
  let med = 0, worst = 0;
  const n = S.intervals.length;
  if (n) {
    // median by a partial copy would allocate; the mean is close enough for
    // a glance, the exact figures are in Copy diagnostics
    let sum = 0;
    for (let i = 0; i < n; i++) { sum += S.intervals[i]; if (S.intervals[i] > worst) worst = S.intervals[i]; }
    med = sum / n;
  }
  const medK = Math.round(med * 10), worstK = Math.round(worst * 10), drops = S.dropCount;
  if (medK !== meta.med || worstK !== meta.worst || drops !== meta.drops) {
    meta.med = medK; meta.worst = worstK; meta.drops = drops;
    meta.b = 'Frame ' + med.toFixed(1) + ' / ' + worst.toFixed(1) + ' ms   ·   dropped ' + drops;
  }
}

let copyFlashUntil = 0;

// The profiler's footer: pinned under the scroll body at the pane's foot, so
// it never scrolls away. A Profile chip at the lower left starts a recording
// (core/profiler.js) and turns into Stop while one runs; once a report exists,
// Save and Copy chips sit beside it, and one line of status follows. Every
// label is a constant or the profiler's own cached status string, so nothing
// here builds a string per frame.
const FOOT_H = 44, FOOT_CHIP_H = 24, FOOT_GAP = 6, DOT = 6;
const TIP_PROFILE = 'Record 30 s of frame timing to find dropped frames';
let footClicked = false;

function footChip(ui, name, x, y, label, dot, disabled, tipStr) {
  const id = ui.id(name);
  const w = ui.text.measure(label, TYPE.xs, W.regular) + CHIP_PAD * 2 + (dot ? DOT + 6 : 0);
  ui.interact(id, x, y, w, FOOT_CHIP_H, disabled);
  const hover = ui.hover && !disabled;
  if (hover) ui.setCursorHint('pointer');
  footClicked = ui.clicked && !disabled;
  const hv = ui.spring(id, hover ? 1 : 0, MOTION.hover);
  ui.dl.rect(x, y, w, FOOT_CHIP_H, RADIUS.pill, hv > 0.5 ? COLOR.wellHi : COLOR.well, 1, COLOR.lineSoft, 0, 0);
  let tx = x + CHIP_PAD;
  if (dot) {
    ui.dl.rect(tx, y + (FOOT_CHIP_H - DOT) / 2, DOT, DOT, DOT / 2, dot, 0, null, 0, 0);
    tx += DOT + 6;
  }
  ui.text.draw(ui.dl, label, tx, y + FOOT_CHIP_H / 2 + 4, TYPE.xs, W.regular,
               disabled ? COLOR.inkFaint : hv > 0.5 ? COLOR.ink : COLOR.inkDim, 0, TRACK.ui, 1);
  if (tipStr) ui.tooltipAt(id, x, y, w, FOOT_CHIP_H, hover, tipStr);
  return w;
}

function drawFooter(ui, dx, height) {
  const top = height - FOOT_H;
  ui.dl.rect(dx + HEAD_X, top, HEAD_W, 1, 0, COLOR.lineSoft, 0, null, 0, 0);
  const y = top + (FOOT_H - FOOT_CHIP_H) / 2;
  const rec = prof.recording, building = prof.building;
  let x = dx + PAD_X;
  x += footChip(ui, 'drawer.profile', x, y, rec ? 'Stop' : 'Profile', rec ? COLOR.warn : COLOR.inkFaint,
                building, rec ? null : TIP_PROFILE) + FOOT_GAP;
  if (footClicked) profToggle();
  if (prof.json && !rec && !building) {
    x += footChip(ui, 'drawer.profileSave', x, y, 'Save report', null, false, null) + FOOT_GAP;
    if (footClicked) profSave();
    x += footChip(ui, 'drawer.profileCopy', x, y, 'Copy', null, false, null) + FOOT_GAP;
    if (footClicked) profCopy();
  }
  if (prof.status) {
    ui.text.draw(ui.dl, prof.status, x + 2, y + FOOT_CHIP_H / 2 + 4, TYPE.xs, W.regular, COLOR.inkDim, 0, TRACK.ui, 1);
  }
}

// The same status, as a small steady badge in the screen's lower left, drawn
// straight into a draw list by main.js while a recording runs with the
// drawer shut. Its width is measured again only when the text changes.
let badgeStr = '', badgeW = 0;
export function drawProfileBadge(dl, text, height) {
  const str = prof.status;
  if (!str) return;
  if (str !== badgeStr) { badgeStr = str; badgeW = text.measure(str, TYPE.xs, W.regular) + CHIP_PAD * 2 + DOT + 6; }
  const x = LAYOUT.chromeInset, y = height - LAYOUT.chromeInset - FOOT_CHIP_H;
  dl.rect(x, y, badgeW, FOOT_CHIP_H, RADIUS.pill, COLOR.glassTint, 1, COLOR.lineSoft, 0, 0);
  dl.rect(x + CHIP_PAD, y + (FOOT_CHIP_H - DOT) / 2, DOT, DOT, DOT / 2, COLOR.warn, 0, null, 0, 0);
  text.draw(dl, str, x + CHIP_PAD + DOT + 6, y + FOOT_CHIP_H / 2 + 4, TYPE.xs, W.regular, COLOR.inkDim, 0, TRACK.ui, 1);
}

// The third level of the drawer's hierarchy, under the group headers (see
// imgui.js group()) and above the control labels: small tracked caps in faint
// ink, the way an inspector labels a cluster of related rows. Inside a section
// it gets a top margin and a hairline divider, so each cluster reads as its
// own block, except as the section's first item, where the header above
// already does that job. The string is uppercased once, when GROUPS is built.
function subHeading(ui, str, divider) {
  if (divider) {
    ui.spacer(SPACE.sm);
    ui.nextRect(1);
    ui.dl.rect(ui.rx, ui.ry, ui.rw, 1, 0, COLOR.lineSoft, 0, null, 0, 0);
    ui.spacer(SPACE.xs);
  }
  ui.text.lineMetrics(TYPE.micro, ui._lm);
  ui.nextRect(ui._lm.ascent + ui._lm.descent);
  if (ui.culled(ui.rx, ui.ry, ui.rw, ui.rh)) return;
  ui.text.draw(ui.dl, str, ui.rx, ui.ry + ui._lm.ascent, TYPE.micro, W.semibold, COLOR.inkFaint, 0, TRACK.caps, 1);
}

function measurePresets(ui) {
  const v = presetsVersion(), n = presetCount();
  if (v === widthsVersion && presetW.length >= n) return;
  if (presetW.length < n) presetW = new Float32Array(n + 8);
  for (let i = 0; i < n; i++) presetW[i] = ui.text.measure(presetLabel(i), TYPE.xs, W.regular) + CHIP_PAD * 2;
  widthsVersion = v;
}

// Item k of the row: a preset chip below n, then the + chip or, while a name
// is being typed, the field that grows as it fills, then the Edit chip.
function itemW(k, n, editing, maxW) {
  if (k < n) return presetW[k] + (presetEditing ? EDIT_PAD : 0);
  if (k > n) return editLabelW;
  if (!editing) return ADD_W;
  const w = nameEdit.textW + CHIP_PAD * 2 + 4;
  return w < EDIT_MIN_W ? EDIT_MIN_W : w > maxW ? maxW : w;
}

function noteTip(id, x, y, w, str, h = PRESET_H) {
  tip.id = id; tip.x = x; tip.y = y; tip.w = w; tip.h = h; tip.hover = true; tip.str = str;
}

function mix4(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  out[3] = a[3] + (b[3] - a[3]) * t;
}

function drawPresets(ui) {
  measurePresets(ui);
  if (!editLabelW) editLabelW = Math.max(ui.text.measure('Edit', TYPE.xs, W.regular), ui.text.measure('Done', TYPE.xs, W.regular)) + CHIP_PAD * 2;
  const n = presetCount(), editing = nameEdit.active, total = n + 2;
  if (chipX.length < n) { chipX = new Float32Array(n + 8); chipY = new Float32Array(n + 8); chipW = new Float32Array(n + 8); }
  const maxW = ui.regionW;
  let lines = 1, lx = 0;
  for (let k = 0; k < total; k++) {
    const w = itemW(k, n, editing, maxW);
    if (lx > 0 && lx + w > maxW) { lines++; lx = 0; }
    lx += w + PRESET_GAP;
  }
  ui.nextRect(lines * PRESET_H + (lines - 1) * PRESET_GAP);
  tip.hover = false;
  const x0 = ui.rx, t = ui.t;
  let px = x0, py = ui.ry;
  for (let k = 0; k < total; k++) {
    const w = itemW(k, n, editing, maxW);
    if (px > x0 && px + w > x0 + maxW) { px = x0; py += PRESET_H + PRESET_GAP; }
    if (k < n) { chipX[k] = px; chipY[k] = py; chipW[k] = w; presetChip(ui, k, px, py, w, t); }
    else if (k > n) editChip(ui, px, py, w);
    else if (editing) {
      // Enter or a click elsewhere names it; Escape, or an empty name, drops it.
      if (ui.textField('drawer.presetName', px, py, w, PRESET_H, nameEdit) === TEXT_COMMIT) {
        const idx = addUserPreset(nameEdit.text);
        if (idx >= 0) { savedIdx = idx; savedUntil = t + SAVED_MS; }
      }
    } else addChip(ui, px, py);
    px += w + PRESET_GAP;
  }
  if (drag.k >= 0 && drag.moved && drag.k < n) drawDrag(ui, n);
}

// Where a dragged chip would land: on the line nearest the pointer, before
// the first chip whose middle is right of the pointer, else after that
// line's last chip. Kept as an insertion point in the row as drawn (0..n),
// with the line and its last chip so the accent bar can be placed.
function dropTarget(ui, n) {
  const pxp = ui.pointerX, pyp = ui.pointerY;
  let lineY = chipY[0], best = 1e9;
  for (let k = 0; k < n; k++) {
    const d = Math.abs(pyp - (chipY[k] + PRESET_H / 2));
    if (d < best) { best = d; lineY = chipY[k]; }
  }
  let ins = -1, last = 0;
  for (let k = 0; k < n; k++) {
    if (chipY[k] !== lineY) continue;
    last = k;
    if (ins < 0 && pxp < chipX[k] + chipW[k] / 2) ins = k;
  }
  drag.ins = ins >= 0 ? ins : last + 1;
  drag.lineY = lineY; drag.last = last;
}

function drawDrag(ui, n) {
  dropTarget(ui, n);
  const ins = drag.ins, last = drag.last;
  // the bar sits in the gap before chip `ins`, or after the line's last chip
  const barX = ins <= last ? chipX[ins] - PRESET_GAP / 2 : chipX[last] + chipW[last] + PRESET_GAP / 2;
  ui.dl.rect(barX - 1, drag.lineY - 2, 2, PRESET_H + 4, 1, COLOR.accent, 0, null, 0, 0);
  // the chip itself, riding the pointer
  const k = drag.k, w = chipW[k];
  const x = ui.pointerX - drag.ox, y = ui.pointerY - drag.oy;
  ui.dl.pushAlpha(0.85);
  ui.dl.rect(x, y, w, PRESET_H, RADIUS.pill, COLOR.wellHi, 1, COLOR.accent, 8, 0.4);
  ui.text.draw(ui.dl, presetLabel(k), x + (w - EDIT_PAD) / 2, y + PRESET_H / 2 + 4, TYPE.xs, W.regular, COLOR.ink, 1, TRACK.ui, 1);
  ui.dl.popAlpha();
}

function editChip(ui, px, py, w) {
  const id = ui.id('drawer.presetEdit');
  ui.interact(id, px, py, w, PRESET_H, false);
  const hover = ui.hover;
  if (hover) { ui.setCursorHint('pointer'); noteTip(id, px, py, w, presetEditing ? TIP_EDITING : TIP_EDIT); }
  if (ui.clicked) { presetEditing = !presetEditing; drag.k = -1; }
  const hv = ui.spring(id, hover ? 1 : 0, MOTION.hover);
  ui.dl.rect(px, py, w, PRESET_H, RADIUS.pill, presetEditing ? COLOR.accentSoft : hv > 0.5 ? COLOR.wellHi : COLOR.well, 1,
             presetEditing ? COLOR.accent : COLOR.lineSoft, 0, 0);
  ui.text.draw(ui.dl, presetEditing ? 'Done' : 'Edit', px + w / 2, py + PRESET_H / 2 + 4, TYPE.xs, W.regular,
               presetEditing ? COLOR.accent : hv > 0.5 ? COLOR.ink : COLOR.inkDim, 1, TRACK.ui, 1);
}

function presetChip(ui, k, px, py, w, t) {
  const id = ui.idx('drawer.preset', k);
  // Edit mode's ×, which runs first so it has the first claim on the press
  // where it overlaps the chip's corner.
  const dcx = px + w - DEL_R + 1, dcy = py + 1;
  if (presetEditing) {
    const did = ui.idx('drawer.presetDel', k);
    ui.interact(did, dcx - DEL_R, dcy - DEL_R, DEL_R * 2, DEL_R * 2, false);
    if (ui.hover) ui.setCursorHint('pointer');
    const dHover = ui.hover;
    if (ui.clicked) { deletePresetAt(k); drag.k = -1; return; }
    delHover = dHover;
  }
  ui.interact(id, px, py, w, PRESET_H, false);
  const hover = ui.hover;
  if (presetEditing) {
    if (hover) { ui.setCursorHint(drag.k === k ? 'grabbing' : 'grab'); noteTip(id, px, py, w, TIP_EDITING); }
    if (ui.pressed && ui.activeId === id) {
      if (drag.k !== k) {
        drag.k = k; drag.moved = false; drag.sx = ui.pointerX; drag.sy = ui.pointerY;
        drag.ox = ui.pointerX - px; drag.oy = ui.pointerY - py; drag.ins = -1;
      } else if (!drag.moved && Math.abs(ui.pointerX - drag.sx) + Math.abs(ui.pointerY - drag.sy) > DRAG_SLOP) drag.moved = true;
    } else if (drag.k === k) {
      // released: land it where the bar was
      if (drag.moved && drag.ins >= 0) movePreset(k, drag.ins > k ? drag.ins - 1 : drag.ins);
      drag.k = -1; drag.moved = false;
    }
  } else {
    if (hover) { ui.setCursorHint('pointer'); noteTip(id, px, py, w, TIP_PRESET); }
    if (ui.clicked) {
      if (ui.pointerShift) { savePresetOverAt(k); savedIdx = k; savedUntil = t + SAVED_MS; }
      else applyPresetAt(k);
    }
  }
  const lifted = drag.k === k && drag.moved;
  if (lifted) ui.dl.pushAlpha(0.3);
  const saved = k === savedIdx && t < savedUntil;
  const hv = ui.spring(id, hover ? 1 : 0, MOTION.hover);
  const fl = ui.spring(ui.idx('drawer.presetSaved', k), saved ? 1 : 0, MOTION.fade);
  mix4(ui.scratch0, hv > 0.5 ? COLOR.wellHi : COLOR.well, COLOR.accentSoft, fl);
  ui.dl.rect(px, py, w, PRESET_H, RADIUS.pill, ui.scratch0, 1, fl > 0.5 ? COLOR.accent : COLOR.lineSoft, 0, 0);
  const tw = presetEditing ? w - EDIT_PAD : w;
  ui.text.draw(ui.dl, saved ? 'Saved' : presetLabel(k), px + tw / 2, py + PRESET_H / 2 + 4, TYPE.xs, W.regular,
               saved ? COLOR.accent : hv > 0.5 ? COLOR.ink : COLOR.inkDim, 1, TRACK.ui, 1);
  // a built-in the viewer has saved over wears a small dot in its right pad
  if (presetHasOverride(k) && !presetEditing) ui.dl.rect(px + w - 7.5, py + PRESET_H / 2 - 1.5, 3, 3, 1.5, COLOR.accent, 0, null, 0, 0);
  if (presetEditing && !lifted) {
    const dh = delHover;
    ui.dl.rect(dcx - DEL_R, dcy - DEL_R, DEL_R * 2, DEL_R * 2, DEL_R, dh ? COLOR.warn : COLOR.wellHi, 1, dh ? COLOR.warn : COLOR.lineStrong, 0, 0);
    const is = 8;
    ui.dl.icon(ICON.CLOSE, dcx - is / 2, dcy - is / 2, is, is, COLOR.ink, 1.6, 0);
  }
  if (lifted) ui.dl.popAlpha();
}

function addChip(ui, px, py) {
  const id = ui.id('drawer.presetAdd');
  ui.interact(id, px, py, ADD_W, PRESET_H, false);
  const hover = ui.hover;
  if (hover) { ui.setCursorHint('pointer'); noteTip(id, px, py, ADD_W, TIP_ADD); }
  if (ui.clicked) ui.textBegin(nameEdit, '', false, false);
  const hv = ui.spring(id, hover ? 1 : 0, MOTION.hover);
  ui.dl.rect(px, py, ADD_W, PRESET_H, RADIUS.pill, hv > 0.5 ? COLOR.wellHi : COLOR.well, 1, COLOR.lineSoft, 0, 0);
  // the plus as two hairline bars rather than a glyph, so it sits exactly
  // centred whatever the font's metrics
  const cx = px + ADD_W / 2, cy = py + PRESET_H / 2, col = hv > 0.5 ? COLOR.ink : COLOR.inkDim;
  ui.dl.rect(cx - 4.5, cy - 0.75, 9, 1.5, 0.75, col, 0, null, 0, 0);
  ui.dl.rect(cx - 0.75, cy - 4.5, 1.5, 9, 0.75, col, 0, null, 0, 0);
}

export function drawDrawer(ui, app) {
  const o = ui.spring('drawer.open', S.panelOpen ? 1 : 0, MOTION.panel);
  const dx = -(W_DRAWER + BLEED) * (1 - o);
  S.edgeInset = Math.max(0, Math.min(W_DRAWER, dx + W_DRAWER));
  if (o < 0.002) return;
  if (openGroups === null) installGroupMemory(ui);

  const height = app.height;
  ui.panel('drawer', dx - BLEED, -BLEED, W_DRAWER + BLEED, height + BLEED * 2, true);
  ui.setCursor(dx, TOP, W_DRAWER);
  ui.scroll('drawer.body', height - TOP - FOOT_H);
  // loose content (presets, readouts, copy buttons) uses the control column
  ui.setCursor(ui.cursorX + PAD_X, ui.cursorY, BODY_W);

  // presets, a wrapped row of chips at the head of the drawer
  subHeading(ui, 'PRESETS', false);
  drawPresets(ui);
  // a wider gap than between sections, so the presets read as a block of
  // their own above the list rather than as the first section's contents
  ui.spacer(SPACE.lg);

  // every section as a collapsible group, headers on the wider column
  ui.setCursor(dx + HEAD_X, ui.cursorY, HEAD_W);
  for (let g = 0; g < GROUPS.length; g++) {
    const grp = GROUPS[g];
    const sw = grp.sw;
    const open = ui.group(grp.gid, grp.title, sw ? !!sw.ctrl.get(S) : undefined);
    if (sw && ui.groupSwitchChanged) setSwitch(sw, ui.groupSwitch);
    // Keep drawing through the whole closing animation, until the toolkit
    // says the height spring has come to rest shut; from then on the body is
    // skipped, which is most of the drawer on most frames. A section that
    // starts shut is drawn once under a zero-height clip, which is what
    // measures it so its first open grows to the right height. One restored
    // open reports open from its first frame and draws in full.
    if (open || !ui.groupSettled) {
      // Only x and width change, so the group still measures its body from
      // the same top and endGroup's height is unaffected.
      ui.setCursor(ui.cursorX + KNOB_OVERHANG, ui.cursorY, ui.regionW - KNOB_OVERHANG * 2);
      // Child runs open and close around their rows (see childRuns). Each
      // endIndent draws its run's line down whatever the run laid out this
      // frame, so a run whose rows are hidden draws none.
      const items = grp.items, runOpen = grp.open, runClose = grp.close;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        for (let k = runClose[i]; k > 0; k--) ui.endIndent();
        if (runOpen[i]) ui.beginIndent();
        if (it.heading) {
          subHeading(ui, it.heading, i > 0);
        } else {
          ui.control(it, S);
          // a control can carry a hover tip (schema `tip`), shown like the chips'
          if (it.tip && ui._lastHover) noteTip(ui._lastId, ui._lastX, ui._lastY, ui._lastW, it.tip, ui._lastH);
        }
      }
      for (let k = grp.closeEnd; k > 0; k--) ui.endIndent();
    }
    ui.endGroup();
  }

  // live readouts and the two copy buttons, v0's #meta block
  ui.setCursor(dx + PAD_X, ui.cursorY, BODY_W);
  ui.spacer(SPACE.lg);
  refreshMeta(ui.t);
  ui.label(meta.a, TYPE.xs, W.regular, COLOR.inkDim);
  ui.label(meta.b, TYPE.xs, W.regular, COLOR.inkDim);
  ui.spacer(SPACE.sm);
  ui.row(2);
  if (ui.button('drawer.copyDiag', ui.t < copyFlashUntil ? 'Copied' : 'Copy diagnostics', 'chip', false)) {
    app.copyDiagnostics(); copyFlashUntil = ui.t + 1400;
  }
  if (ui.button('drawer.copySettings', 'Copy settings', 'chip', false)) app.copySettings();
  ui.endRow();
  ui.spacer(SPACE.xl);

  ui.endScroll();

  // the profiler's footer, pinned below the scroll body
  drawFooter(ui, dx, height);

  // Anything that reaches the pane without landing on a control stops here,
  // so a click on empty glass never falls through to the field and stops the
  // session.
  ui.interact(ui.id('drawer.backstop'), dx, 0, W_DRAWER, height, false);
  ui.endPanel();

  // after the pane's clip too: a tip centred on a chip near the right edge
  // is wider than the space left in the pane, so it may overhang the field
  if (tip.id !== -1) ui.tooltipAt(tip.id, tip.x, tip.y, tip.w, tip.h, tip.hover, tip.str);
}
