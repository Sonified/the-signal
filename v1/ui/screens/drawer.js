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
  presetsVersion, presetCount, presetLabel, presetHasOverride, presetIsActive,
  applyPresetAt, savePresetOverAt, addUserPreset, deletePresetAt, movePreset, renamePresetAt, presetIsUser
} from '../../core/presets.js';
import { ICON } from '../drawlist.js';
import { loadUiState, saveUiState } from '../../core/store.js';
import { prof, profToggle, profSave, profCopy } from '../../core/profiler.js';
import { makeTextState, TEXT_COMMIT, TEXT_CANCEL, touchAware } from '../widgets.js';
import {
  broadcastAvailable, broadcastVersion, broadcastCount, broadcastName, broadcastActive, broadcastStatus,
  broadcastWatchLabel, broadcastToggle, broadcastAdd, broadcastRemove, broadcastCopyLink,
  broadcastHasKey, broadcastSetKey, broadcastLinkTarget, broadcastSetLinkTarget
} from '../../core/broadcast.js';
import {
  journeyEditing, journeyOverridden, journeyClearOverride,
  journeyRampGlow, journeyRampingControl, journeyRampingSection, journeyRampingSub
} from '../../core/journey.js';
import { JOURNEY_ACCENT } from './journey.js';
import { COLOR, TYPE, TRACK, W, RADIUS, LAYOUT, MOTION, SPACE } from '../theme.js';

const DRAWER_SECTIONS = ['layers', 'strobe', 'text', 'corners', 'tunnel', 'edge', 'flowers', 'kaleido', 'particles', 'fireworks', 'confetti', 'audio', 'music', 'atmosphere', 'render'];

// The control each section's header switch stands for: the layer's own on/off,
// the same one the section holds as its first row, so the header and the row
// always agree. A section missing here, or whose control the schema does not
// have (yet), gets a header with no switch.
const SECTION_SWITCH = {
  strobe: 'fieldOn', corners: 'cornersOn', tunnel: 'ringsOn', edge: 'edgeOn', text: 'textOn',
  flowers: 'flowersOn', kaleido: 'kaleidoOn', particles: 'particlesOn', fireworks: 'fireworksOn', confetti: 'confettiOn',
  audio: 'audioOn', music: 'musicOn', atmosphere: 'ambOn'
};

// The controls a sub-drawer's strip carries as its switch (the schema's
// switchId, a voice's own on/off): drawn on the strip only, so, like a
// section's switch, never as a body row as well.
const STRIP_SWITCH = new Set(CONTROLS.filter(c => c.uiOnly && c.switchId).map(c => c.switchId));

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

// Variance folds. A row the schema tags `varianceOf: '<owner id>'` belongs to
// that owner's variance, and the owner's variance rows fold out from under it:
// shut by default, opened by a small chevron seated in the guide line beside
// the owner (imgui.js lineChevron), folding on a headerless fold (beginFold
// with no label) one indent in. Each owner gets a slot here, made once: its
// id and fold id, and whether it is open, mirrored from the UI record so the frame
// loop reads a byte rather than a set. A row tagged `varianceProxy: '<owner
// id>'` wears that owner's chevron while it is the one showing (Appearance
// rate stands in for Appearance in By time mode, the two never showing at
// once), and the fold still opens beneath it.
const OWNERS = [];
const ownerSlot = new Map();   // owner id -> slot, while GROUPS is built
let varOpen = new Uint8Array(0);

// Switch folds. A run of child rows that its parent's setting shows and
// hides (a variance switch's amount and rate, Fade in's rows, a mode's own
// rows) slides open and shut on a headerless fold like the variance folds,
// rather than popping. Each such run gets a gate slot, made once: its fold
// id and its direct children, and the run is open while any of them shows by
// its own rule. Shutting, the rows are held on screen exactly as they last
// showed (seen, one byte per row, written whenever a row's rule is asked)
// while they slide away, and take no input (ui.pushInert). A run whose
// children have no visible rule never changes, so it gets no fold.
const GATES = [];
const UNSET = {};
let gateOpen = new Uint8Array(0);

// The parent a row's run hangs from: a variance row hangs from its owner,
// unless its own parent is another row of the same variance (the amount and
// rate under a variance switch), which it keeps.
function runParent(it) {
  if (it.heading) return undefined;
  const v = it.varianceOf;
  if (!v) return it.parent;
  if (it.parent) {
    const p = byId(it.parent);
    if (p && p.varianceOf === v) return it.parent;
  }
  return v;
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
    if (c.id === SECTION_SWITCH[id] || STRIP_SWITCH.has(c.id)) continue;
    if (c.sub && c.sub !== sub) { sub = c.sub; items.push({ heading: c.sub.toUpperCase() }); }
    items.push(c);
  }
  const runs = childRuns(items, id);
  // A sub-drawer (a schema uiOnly toggle with a run under it) is drawn as a
  // fold (imgui.js beginFold): its header strip in place of the toggle row,
  // and its run inside the fold. Its fold's id is made here, once.
  const foldId = new Array(items.length).fill(null);
  for (let i = 0; i + 1 < items.length; i++) {
    const c = items[i];
    if (!c.heading && c.uiOnly && runs.open[i + 1]) foldId[i] = 'fold.' + c.id;
  }
  // A sub-drawer whose strip carries a switch (the schema's switchId): that
  // control resolved as a section header's is (makeSwitch), else null.
  const stripSw = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i++) {
    if (!foldId[i] || !items[i].switchId) continue;
    stripSw[i] = makeSwitch(items[i].switchId);
    if (!stripSw[i]) console.warn('drawer: ' + id + '.' + items[i].id + ' names switch ' + items[i].switchId + ', which is not a toggle or two-way segment');
  }
  // Each sub-drawer's summary (see subSummary): the schema's list, else its
  // first two sliders or segments.
  const subSum = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i++) {
    if (!foldId[i]) continue;
    const c = items[i];
    let ctrls;
    if (Array.isArray(c.summary)) ctrls = c.summary.map(byId).filter(x => !!x);
    else ctrls = items.filter(x => !x.heading && x.parent === c.id &&
                               (x.kind === 'slider' || (x.kind === 'segment' && !x.multi))).slice(0, 2);
    if (ctrls.length) subSum[i] = makeSummary(ctrls);
  }
  // A variance owner: a row whose run opens straight under it with one of its
  // own variance rows. varFold[i] is its slot (the fold begins after it),
  // chev[i] the slot whose chevron item i wears (the owner, or a proxy row),
  // chevId[i] that chevron's id; -1 and null elsewhere.
  const varFold = new Int16Array(items.length).fill(-1);
  const chev = new Int16Array(items.length).fill(-1);
  const chevId = new Array(items.length).fill(null);
  for (let i = 0; i + 1 < items.length; i++) {
    const c = items[i], next = items[i + 1];
    if (c.heading || !runs.open[i + 1] || next.heading || next.varianceOf !== c.id) continue;
    const slot = OWNERS.length;
    OWNERS.push({ id: c.id, foldId: 'vfold.' + c.id });
    ownerSlot.set(c.id, slot);
    varFold[i] = slot; chev[i] = slot; chevId[i] = 'vchev.' + c.id;
  }
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    if (c.heading || !c.varianceProxy) continue;
    const slot = ownerSlot.get(c.varianceProxy);
    if (slot === undefined) { console.warn('drawer: ' + id + '.' + c.id + ' stands in for ' + c.varianceProxy + ', which has no variance fold'); continue; }
    chev[i] = slot; chevId[i] = 'vchev.' + c.id;
  }
  // gateFold[i] is the gate slot of a run opening under item i, else -1: any
  // parent row that is not a plain sub-drawer or a variance owner, whose
  // direct children (runParent names it) include one with a visible rule. A
  // sub-drawer carrying a switch gets one too, inside its own fold, so its
  // voice's rows slide away when the switch turns off with the drawer open,
  // as they did under the voice's toggle row.
  const gateFold = new Int16Array(items.length).fill(-1);
  for (let j = 0; j + 1 < items.length; j++) {
    const c = items[j];
    if (c.heading || !runs.open[j + 1] || (foldId[j] && !stripSw[j]) || varFold[j] >= 0) continue;
    const desc = new Set([c.id]), kids = [];
    for (let k = j + 1; k < items.length; k++) {
      const v = items[k];
      const p = v.heading ? undefined : runParent(v);
      if (!p || !desc.has(p)) break;
      desc.add(v.id);
      if (p === c.id) kids.push(v);
    }
    if (!kids.some(v => !!v.visible)) continue;
    gateFold[j] = GATES.length;
    GATES.push({ foldId: 'gfold.' + c.id, kids });
  }
  return { sec: id, gid: 'drawer.' + id, title: sec.title, items, sw: makeSwitch(SECTION_SWITCH[id]),
           open: runs.open, close: runs.close, closeEnd: runs.closeEnd, foldId, varFold, chev, chevId,
           gateFold, seen: new Uint8Array(items.length), subSum, stripSw };
});
varOpen = new Uint8Array(OWNERS.length);
gateOpen = new Uint8Array(GATES.length);

// A shut sub-drawer's strip shows its primary settings' readouts beside its
// name, dim, joined by a thin dot (imgui.js beginFold draws it). Each part is
// remembered against the value it was printed from, and the joined line is
// rebuilt only when a part's text or which parts show changes, so a steady
// drawer builds no strings. A part whose row is hidden by its own rule is
// left out, so of two rows that take turns (Speed and Outward speed) the one
// showing is the one summarised. A segment with no readout of its own prints
// its chosen option's label. (UNSET, the value no part has been printed
// from yet, is declared with GATES above, before GROUPS is built.)
// Each part reads as a short name then its amount ("Freq 7.5 Hz"): the
// control's summaryLabel, else its label's first word, made once here.
function makeSummary(ctrls) {
  // an explicit empty summaryLabel means the value alone carries the entry
  return { ctrls, names: ctrls.map(c => c.summaryLabel !== undefined ? c.summaryLabel : c.label.split(' ')[0]),
           key: new Array(ctrls.length).fill(UNSET), text: new Array(ctrls.length).fill(''),
           shown: new Uint8Array(ctrls.length), line: '' };
}
function partText(c, v) {
  if (c.format) return c.format(S);
  if (c.kind === 'segment') {
    for (const o of c.options) if (o.value === v) return o.label;
  }
  return String(v);
}
function subSummary(sum) {
  const ctrls = sum.ctrls;
  let changed = false;
  for (let k = 0; k < ctrls.length; k++) {
    const c = ctrls[k];
    const vis = !c.visible || c.visible(S) ? 1 : 0;
    if (vis !== sum.shown[k]) { sum.shown[k] = vis; changed = true; }
    if (!vis) continue;
    const v = c.get(S);
    if (v !== sum.key[k]) { sum.key[k] = v; sum.text[k] = sum.names[k] ? sum.names[k] + ' ' + partText(c, v) : partText(c, v); changed = true; }
  }
  if (changed) {
    let line = '';
    for (let k = 0; k < ctrls.length; k++) {
      if (!sum.shown[k]) continue;
      line = line ? line + '  ·  ' + sum.text[k] : sum.text[k];
    }
    sum.line = line;
  }
  return sum.line;
}

// Begins a gate's headerless fold (see GATES) for the run that opens next:
// open while its run shows, or, inside a switch fold sliding shut, as it last
// was; one sliding shut itself freezes the run it holds.
function beginGate(ui, gs) {
  let open;
  if (frozenFrom) open = gateOpen[gs] === 1;
  else { open = gateShows(gs); gateOpen[gs] = open ? 1 : 0; }
  foldNext++;
  if (!ui.beginFold(GATES[gs].foldId, null, open)) skipNext = 1;
  else if (ui.foldShutting) nextFrozen = 1;
}

// Whether a gate's run shows: any direct child that shows by its own rule.
function gateShows(slot) {
  const kids = GATES[slot].kids;
  for (let k = 0; k < kids.length; k++) {
    const c = kids[k];
    if (!c.visible || c.visible(S)) return true;
  }
  return false;
}


// A chevron click: flips the slot and rewrites the saved list of open
// variance folds (a click's worth of work, never per frame).
function toggleVariance(slot) {
  varOpen[slot] = varOpen[slot] ? 0 : 1;
  const list = [];
  for (let s = 0; s < OWNERS.length; s++) if (varOpen[s]) list.push(OWNERS[s].id);
  saveUiState({ openVariance: list });
}

// Which open child runs sit inside a sub-drawer fold, by depth, for the
// frame loop. A fold begins at its header, just before its run opens, and
// ends just after the run closes, so the run's guide line folds with it.
// foldNext carries the folds just begun to the run they hold, as a count
// (a strip with a switch begins two: its own and, inside it, its voice's
// gate), and foldAt keeps that count per depth until the run closes.
// skipNext says one of them is shut at rest, or the strip is hidden, so the
// run's rows are skipped until it closes.
// frozenFrom is the depth of a switch fold sliding shut (0 for none):
// inside it rows show as they last did and take no input, and switch folds
// nested in it keep the state they had. nextFrozen carries that to the run.
const foldAt = new Uint8Array(16);
let runDepth = 0, skipFrom = 0, foldNext = 0, skipNext = 0, frozenFrom = 0, nextFrozen = 0;

// Closes the innermost child run, then the folds it holds.
function closeRun(ui) {
  ui.endIndent();
  if (runDepth < foldAt.length) {
    for (let k = foldAt[runDepth]; k > 0; k--) ui.endFold();
    foldAt[runDepth] = 0;
  }
  if (skipFrom === runDepth) skipFrom = 0;
  if (frozenFrom === runDepth) { frozenFrom = 0; ui.popInert(); }
  runDepth--;
}

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
    // a variance row hangs from its owner (see runParent)
    const p = runParent(it);
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

// The one column every strip's summary starts in, measured once from the
// longest sub-drawer name in the drawer plus a gap, so the summaries line up
// strip to strip (imgui.js _foldSummary).
let sumCol = 0;
function measureSumCol(ui) {
  let w = 0;
  for (const grp of GROUPS) {
    for (let i = 0; i < grp.items.length; i++) {
      if (!grp.foldId[i]) continue;
      const lw = ui.text.measure(grp.items[i].label, TYPE.sm, W.semibold);
      if (lw > w) w = lw;
    }
  }
  sumCol = Math.ceil(w) + SPACE.lg;
}

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
  // Open variance folds, by owner id, beside the sub-drawers' shutSubDrawers
  // in the same UI record: every fold starts shut, the record lists the
  // ones the viewer opened.
  const vars = saved && Array.isArray(saved.openVariance) ? saved.openVariance : [];
  for (const id of vars) {
    const slot = ownerSlot.get(id);
    if (slot !== undefined) varOpen[slot] = 1;
  }
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
// Renaming in place (edit mode, one plain click on a chip): which row index
// is being renamed, and its own field state, separate from the + field so
// the two can never collide.
const renameEdit = makeTextState(32, 'Name');
let renameK = -1;
// Confirmation after a save: the chip that was saved reads "Saved" and
// takes an accent wash for SAVED_MS, springing in and out on that state.
const SAVED_MS = 1200;
let savedIdx = -1, savedUntil = 0;
const TIP_PRESET = 'Click to load  ·  Shift-click to save over';
const TIP_ADD = 'Save the current settings as a new preset';
const TIP_EDIT = 'Delete or reorder presets';
const TIP_EDITING = 'Drag to move  ·  click to rename  ·  × to delete';

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
const tip = { id: -1, x: 0, y: 0, w: 0, h: 0, hover: false, str: '', instant: false };

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

// While a journey step is being authored (core/journey.js), every row whose
// control the step records wears a small gold dot at its upper left, in the
// gutter the row is indented past, so the layout never moves for it. It sits
// above where a variance chevron seats itself (the row's vertical middle, in
// the guide line's column) and runs before it, so in the corner they share
// the dot has the first claim on a press. A click takes the control out of
// the step. The row's rect is read with peek() before the row lays itself
// out, so the dot costs a Set lookup a row and nothing when not authoring.
const JDOT_R = 2.5, JDOT_HIT = 12, JDOT_DX = 5, JDOT_DY = 6;
const TIP_JDOT = 'Saved with this step  ·  click to remove';
function journeyDot(ui, it, salt) {
  ui.peek();
  const cx = ui.px - JDOT_DX, cy = ui.py + JDOT_DY, hx = cx - JDOT_HIT / 2, hy = cy - JDOT_HIT / 2;
  const id = ui.idx('drawer.jdot', salt);
  ui.interact(id, hx, hy, JDOT_HIT, JDOT_HIT, false);
  const hover = ui.hover;
  if (hover) { ui.setCursorHint('pointer'); noteTip(id, hx, hy, JDOT_HIT, TIP_JDOT, JDOT_HIT); }
  if (ui.clicked) { journeyClearOverride(it.id); return; }
  const r = hover ? JDOT_R + 1 : JDOT_R;
  ui.dl.rect(cx - r, cy - r, r * 2, r * 2, r, JOURNEY_ACCENT, 0, null, hover ? 6 : 0, 0.35);
}

// While a playing journey step ramps its settings in (core/journey.js), the
// drawer shows where: each moving control's row wears a soft wash and ring
// in the journey's gold, the header of every section holding one glows the
// same (imgui.js headGlow), so the sections that are changing read from
// across the room, and so does a sub-drawer's strip with a moving row shut
// inside it. All of it at one strength, the ramp's own (journeyRampGlow),
// which fades out as the ramp lands. With no ramp playing that strength is 0
// and the drawer pays that one test a frame; each lit thing costs a set
// lookup and a rect or two.
const RAMP_PAD_X = 4, RAMP_PAD_Y = 3;
const rampFill = new Float32Array(4), rampLine = new Float32Array(4);
function rampColors(glow) {
  rampFill[0] = rampLine[0] = JOURNEY_ACCENT[0];
  rampFill[1] = rampLine[1] = JOURNEY_ACCENT[1];
  rampFill[2] = rampLine[2] = JOURNEY_ACCENT[2];
  rampFill[3] = 0.08 * glow;
  rampLine[3] = 0.6 * glow;
}
function rampRow(ui, x, y, w, h) {
  ui.dl.rect(x - RAMP_PAD_X, y - RAMP_PAD_Y, w + RAMP_PAD_X * 2, h + RAMP_PAD_Y * 2, RADIUS.sm,
             rampFill, 1, rampLine, 0, 0);
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
  if (k === renameK && renameEdit.active) {
    const w = renameEdit.textW + CHIP_PAD * 2 + 4;
    return w < EDIT_MIN_W ? EDIT_MIN_W : w > maxW ? maxW : w;
  }
  if (k < n) return presetW[k] + (presetEditing ? EDIT_PAD : 0);
  if (k > n) return editLabelW;
  if (!editing) return ADD_W;
  const w = nameEdit.textW + CHIP_PAD * 2 + 4;
  return w < EDIT_MIN_W ? EDIT_MIN_W : w > maxW ? maxW : w;
}

function noteTip(id, x, y, w, str, h = PRESET_H, instant = false) {
  tip.id = id; tip.x = x; tip.y = y; tip.w = w; tip.h = h; tip.hover = true; tip.str = str; tip.instant = instant;
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
    if (k === renameK && renameEdit.active) {
      // The chip as a name field. Enter or a click elsewhere commits;
      // Escape, an empty name or a clash with another label leaves it as
      // it was. Built-ins never get here (see the click below).
      chipX[k] = px; chipY[k] = py; chipW[k] = w;
      const res = ui.textField('drawer.presetRename', px, py, w, PRESET_H, renameEdit);
      if (res === TEXT_COMMIT) { renamePresetAt(k, renameEdit.text); renameK = -1; }
      else if (res === TEXT_CANCEL) renameK = -1;
    }
    else if (k < n) { chipX[k] = px; chipY[k] = py; chipW[k] = w; presetChip(ui, k, px, py, w, t); }
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
  if (ui.clicked) { presetEditing = !presetEditing; drag.k = -1; renameK = -1; renameEdit.active = false; }
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
    if (ui.clicked) { deletePresetAt(k); drag.k = -1; renameK = -1; renameEdit.active = false; return; }
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
      // released: a real drag lands it where the bar was, and a plain click
      // (never past the slop) opens the name for editing, on the viewer's
      // own presets; a built-in's name is fixed.
      if (drag.moved && drag.ins >= 0) movePreset(k, drag.ins > k ? drag.ins - 1 : drag.ins);
      else if (!drag.moved && presetIsUser(k)) { renameK = k; ui.textBegin(renameEdit, presetLabel(k), true, false); }
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
  // lit while it is the preset last clicked, and briefly on a save
  const act = presetIsActive(k);
  const fl = ui.spring(ui.idx('drawer.presetSaved', k), saved || act ? 1 : 0, MOTION.fade);
  mix4(ui.scratch0, hv > 0.5 ? COLOR.wellHi : COLOR.well, COLOR.accentSoft, fl);
  ui.dl.rect(px, py, w, PRESET_H, RADIUS.pill, ui.scratch0, 1, fl > 0.5 ? COLOR.accent : COLOR.lineSoft, 0, 0);
  const tw = presetEditing ? w - EDIT_PAD : w;
  ui.text.draw(ui.dl, saved ? 'Saved' : presetLabel(k), px + tw / 2, py + PRESET_H / 2 + 4, TYPE.xs, W.regular,
               saved || act ? COLOR.accent : hv > 0.5 ? COLOR.ink : COLOR.inkDim, 1, TRACK.ui, 1);
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

// The Broadcast section, the drawer's last (core/broadcast.js): a row per
// named session, then a + chip that names a new one, then the key. It is
// drawn only where a broadcast can start at all (broadcastAvailable), so a
// follower tab, and a page in worker mode, never shows it.
//
// A session's row is a toggle row whose switch is the session's on/off, with
// a status dot and the session's name where a toggle's label would be, the
// watcher count right-aligned while it is live, and a Link chip (the
// profiler footer's chip) that copies the viewer's link. The dot reads from
// the theme's status tokens: faint while off, the accent while connecting,
// the good green while live, and warn, the drawer's colour for deleting and
// for trouble, once the session has given up. Deleting follows the presets:
// an Edit chip beside the + turns every row's Link chip into an ×, and Done
// turns them back. The + opens a name field in place, as the presets' does,
// and the key row opens one where its value was. Every string drawn is a
// literal or one the core keeps cached, and the widths are measured when
// broadcastVersion moves, as the preset chips' are on presetsVersion.
const BC_ROW_H = 30, BC_SWITCH_W = 34;   // a toggle row's height and its switch's width (widgets.js toggle)
const BC_PLUS = 9, BC_PLUS_GAP = 6;      // the + chip's plus, and the gap before its label
const BC_ADD_LABEL = 'New session', BC_LINK_LABEL = 'Link', BC_KEY_LABEL = 'Key';
const BC_LINK_TARGETS = ['Live page', 'Localhost'];
const BC_KEY_MASK = '••••••••';          // the same eight dots whatever the key, so its length never shows
const BC_KEY_UNSET = 'Not set';
const TIP_BC_LINK = 'Copy the link a viewer opens to follow this session';
const TIP_BC_ON = 'Go live: anyone at this link follows your settings';
const TIP_BC_OFF = 'Stop broadcasting to this link';
const TIP_BC_NEEDKEY = 'Set the key below first';
const TIP_BC_DEL = 'End this session and delete it';
const TIP_BC_ADD = 'Name a new broadcast session';
const TIP_BC_EDIT = 'Delete sessions';
const TIP_BC_EDITING = '× ends a session and deletes it';
const TIP_BC_KEY = 'Set the key the relay asks for';
// The two name fields, made once: a new session's name (the core's own limit,
// 32) and the key, which is typed fresh each time rather than shown.
const sessionEdit = makeTextState(32, 'Session name');
const keyEdit = makeTextState(128, 'Broadcast key');
let bcEditing = false;
// which row's Link chip is showing its copied check, and until when
let bcLinkFlashRow = -1, bcLinkFlashUntil = 0;
let bcNameW = new Float32Array(8), bcWatchW = new Float32Array(8);
let bcVersion = -1;
let bcLinkW = 0, bcAddW = 0, bcKeyLabelW = 0;

function measureBroadcast(ui) {
  if (!bcLinkW) {
    bcLinkW = ui.text.measure(BC_LINK_LABEL, TYPE.xs, W.regular) + CHIP_PAD * 2;
    bcAddW = ui.text.measure(BC_ADD_LABEL, TYPE.xs, W.regular) + CHIP_PAD * 2 + BC_PLUS + BC_PLUS_GAP;
    bcKeyLabelW = ui.text.measure(BC_KEY_LABEL, TYPE.sm, W.regular);
    if (!editLabelW) editLabelW = Math.max(ui.text.measure('Edit', TYPE.xs, W.regular), ui.text.measure('Done', TYPE.xs, W.regular)) + CHIP_PAD * 2;
  }
  const v = broadcastVersion(), n = broadcastCount();
  if (v === bcVersion && bcNameW.length >= n) return;
  if (bcNameW.length < n) { bcNameW = new Float32Array(n + 8); bcWatchW = new Float32Array(n + 8); }
  for (let i = 0; i < n; i++) {
    bcNameW[i] = ui.text.measure(broadcastName(i), TYPE.sm, W.regular);
    bcWatchW[i] = ui.text.measure(broadcastWatchLabel(i), TYPE.xs, W.regular);
  }
  bcVersion = v;
}

function statusColor(st) {
  return st === 'live' ? COLOR.good : st === 'wait' ? COLOR.accent : st === 'dead' ? COLOR.warn : COLOR.inkFaint;
}

function drawBroadcast(ui) {
  measureBroadcast(ui);
  const target = broadcastLinkTarget() === 'local' ? 1 : 0;
  const nextTarget = ui.select('drawer.bcLinkTarget', 'Link target', BC_LINK_TARGETS, target, '', false);
  if (nextTarget !== target) broadcastSetLinkTarget(nextTarget === 1 ? 'local' : 'live');
  ui.spacer(SPACE.sm);
  const n = broadcastCount();
  if (!n) bcEditing = false;
  // An × click is carried out after the rows, so this frame draws the list
  // it laid out from, with no row drawn under another's index.
  let drop = -1;
  for (let i = 0; i < n; i++) if (sessionRow(ui, i)) drop = i;
  if (drop >= 0) broadcastRemove(drop);
  addSessionRow(ui, n);
  keyRow(ui);
}

// One session's row; true when its × was clicked. Each row is its own id
// scope, so the toggle, chip and × ids repeat safely row to row. The row's
// rect is read with peek() before the toggle lays it out, so the Link chip,
// or the ×, can run first and have the first claim on a press over the row,
// as a preset chip's × does over its chip.
function sessionRow(ui, i) {
  ui.pushScope(ui.idx('drawer.bcRow', i));
  ui.peek();
  const x = ui.px, y = ui.py, w = ui.pw, h = touchAware(ui, BC_ROW_H);
  const chipX = x + w - BC_SWITCH_W - SPACE.sm - bcLinkW;
  let del = false;
  if (bcEditing) {
    const cx = chipX + bcLinkW / 2, cy = y + h / 2;
    // hit across the whole slot the Link chip had, larger than the × itself,
    // so a near miss never lands on the row behind it
    const did = ui.id('drawer.bcDel');
    ui.interact(did, chipX, y, bcLinkW, h, false);
    const dh = ui.hover;
    if (dh) { ui.setCursorHint('pointer'); noteTip(did, chipX, y, bcLinkW, TIP_BC_DEL, h); }
    del = ui.clicked;
    ui.dl.rect(cx - DEL_R, cy - DEL_R, DEL_R * 2, DEL_R * 2, DEL_R, dh ? COLOR.warn : COLOR.wellHi, 1, dh ? COLOR.warn : COLOR.lineStrong, 0, 0);
    const is = 8;
    ui.dl.icon(ICON.CLOSE, cx - is / 2, cy - is / 2, is, is, COLOR.ink, 1.6, 0);
  } else {
    // The Link chip, at its cached width whatever it shows, so the pill
    // never resizes: the label normally, and for a moment after a click a
    // green check to say the link is on the clipboard. (Not footChip, which
    // takes its width from the label it is given each frame.)
    const cy = y + (h - FOOT_CHIP_H) / 2;
    const lid = ui.id('drawer.bcLink');
    ui.interact(lid, chipX, cy, bcLinkW, FOOT_CHIP_H, false);
    const lh = ui.hover;
    if (lh) { ui.setCursorHint('pointer'); noteTip(lid, chipX, cy, bcLinkW, TIP_BC_LINK, FOOT_CHIP_H); }
    if (ui.clicked) { broadcastCopyLink(i); bcLinkFlashRow = i; bcLinkFlashUntil = ui.t + 1400; }
    const hv = ui.spring(lid, lh ? 1 : 0, MOTION.hover);
    ui.dl.rect(chipX, cy, bcLinkW, FOOT_CHIP_H, RADIUS.pill, hv > 0.5 ? COLOR.wellHi : COLOR.well, 1, COLOR.lineSoft, 0, 0);
    if (bcLinkFlashRow === i && ui.t < bcLinkFlashUntil) {
      const is = 10;
      ui.dl.icon(ICON.CHECK, chipX + (bcLinkW - is) / 2, cy + (FOOT_CHIP_H - is) / 2, is, is, COLOR.good, 1.6, 0);
    } else {
      ui.text.draw(ui.dl, BC_LINK_LABEL, chipX + bcLinkW / 2, cy + FOOT_CHIP_H / 2 + 4, TYPE.xs, W.regular,
                   lh ? COLOR.ink : COLOR.inkDim, 1, TRACK.ui, 1);
    }
  }
  // In edit mode the row takes no click, as a preset chip no longer loads
  // then, so a press meant for an × can never start a broadcast instead.
  // Without a key the switch is inert too: flipped on it could only snap
  // straight back, so instead it sits disabled and its tip says what to do.
  const on = broadcastActive(i);
  const hasKey = broadcastHasKey();
  if (ui.toggle('drawer.bcOn', '', on, bcEditing || !hasKey) !== on) broadcastToggle(i);
  // The switch explains itself on hover. A disabled interact never reports
  // hover, so its rect is tested by hand, over the switch alone rather than
  // the toggle's whole row.
  if (!bcEditing) {
    const sx = x + w - BC_SWITCH_W;
    if (ui.pointerX >= sx && ui.pointerX < x + w && ui.pointerY >= y && ui.pointerY < y + h) {
      noteTip(ui.id('drawer.bcOnTip'), sx, y, BC_SWITCH_W,
              !hasKey ? TIP_BC_NEEDKEY : on ? TIP_BC_OFF : TIP_BC_ON, h);
    }
  }
  // the dot and the name where the toggle's label would sit, on its baseline
  ui.text.lineMetrics(TYPE.sm, ui._lm);
  const base = y + h / 2 + (ui._lm.ascent - ui._lm.descent) / 2;
  ui.dl.rect(x, y + (h - DOT) / 2, DOT, DOT, DOT / 2, statusColor(broadcastStatus(i)), 0, null, 0, 0);
  const nx = x + DOT + 6, ww = bcWatchW[i];
  const room = chipX - SPACE.sm - (ww > 0 ? ww + SPACE.sm : 0) - nx;
  // a name too long for the room left is cut at its edge
  const cut = bcNameW[i] > room;
  if (cut) ui.dl.pushClip(nx, y, room > 0 ? room : 0, h);
  ui.text.draw(ui.dl, broadcastName(i), nx, base, TYPE.sm, W.regular, COLOR.inkDim, 0, TRACK.ui, 1);
  if (cut) ui.dl.popClip();
  if (ww > 0) ui.text.draw(ui.dl, broadcastWatchLabel(i), chipX - SPACE.sm, base, TYPE.xs, W.regular, COLOR.inkDim, 2, TRACK.ui, 1);
  ui.popScope();
  return del;
}

// The + chip, or while a name is being typed the field that grows as it
// fills, then the Edit chip once there is a session to delete. Enter or a
// click elsewhere adds it; Escape, or an empty name, drops it.
function addSessionRow(ui, n) {
  const typing = sessionEdit.active;
  let w = bcAddW;
  if (typing) {
    const maxW = ui.regionW - (n ? editLabelW + PRESET_GAP : 0);
    w = sessionEdit.textW + CHIP_PAD * 2 + 4;
    w = w < EDIT_MIN_W ? EDIT_MIN_W : w > maxW ? maxW : w;
  }
  ui.nextRect(PRESET_H);
  const x = ui.rx, y = ui.ry;
  if (typing) {
    if (ui.textField('drawer.bcName', x, y, w, PRESET_H, sessionEdit) === TEXT_COMMIT) broadcastAdd(sessionEdit.text);
  } else addSessionChip(ui, x, y);
  if (n) bcEditChip(ui, x + w + PRESET_GAP, y, editLabelW);
}

function addSessionChip(ui, px, py) {
  const id = ui.id('drawer.bcAdd');
  ui.interact(id, px, py, bcAddW, PRESET_H, false);
  const hover = ui.hover;
  if (hover) { ui.setCursorHint('pointer'); noteTip(id, px, py, bcAddW, TIP_BC_ADD); }
  if (ui.clicked) ui.textBegin(sessionEdit, '', false, false);
  const hv = ui.spring(id, hover ? 1 : 0, MOTION.hover);
  ui.dl.rect(px, py, bcAddW, PRESET_H, RADIUS.pill, hv > 0.5 ? COLOR.wellHi : COLOR.well, 1, COLOR.lineSoft, 0, 0);
  // the plus in hairline bars, as the presets' + chip draws it
  const col = hv > 0.5 ? COLOR.ink : COLOR.inkDim;
  const cx = px + CHIP_PAD + BC_PLUS / 2, cy = py + PRESET_H / 2;
  ui.dl.rect(cx - 4.5, cy - 0.75, 9, 1.5, 0.75, col, 0, null, 0, 0);
  ui.dl.rect(cx - 0.75, cy - 4.5, 1.5, 9, 0.75, col, 0, null, 0, 0);
  ui.text.draw(ui.dl, BC_ADD_LABEL, px + CHIP_PAD + BC_PLUS + BC_PLUS_GAP, cy + 4, TYPE.xs, W.regular, col, 0, TRACK.ui, 1);
}

// The presets' Edit chip (editChip), turning the sessions' edit mode on and off.
function bcEditChip(ui, px, py, w) {
  const id = ui.id('drawer.bcEdit');
  ui.interact(id, px, py, w, PRESET_H, false);
  const hover = ui.hover;
  if (hover) { ui.setCursorHint('pointer'); noteTip(id, px, py, w, bcEditing ? TIP_BC_EDITING : TIP_BC_EDIT); }
  if (ui.clicked) bcEditing = !bcEditing;
  const hv = ui.spring(id, hover ? 1 : 0, MOTION.hover);
  ui.dl.rect(px, py, w, PRESET_H, RADIUS.pill, bcEditing ? COLOR.accentSoft : hv > 0.5 ? COLOR.wellHi : COLOR.well, 1,
             bcEditing ? COLOR.accent : COLOR.lineSoft, 0, 0);
  ui.text.draw(ui.dl, bcEditing ? 'Done' : 'Edit', px + w / 2, py + PRESET_H / 2 + 4, TYPE.xs, W.regular,
               bcEditing ? COLOR.accent : hv > 0.5 ? COLOR.ink : COLOR.inkDim, 1, TRACK.ui, 1);
}

// The key: a row labelled Key, its value right-aligned as eight dots or Not
// set. A click anywhere on it opens a field where the value was, empty, so
// the key is never shown in the clear; Enter or a click elsewhere stores
// what was typed, and an empty field (or Escape) leaves the key as it was.
function keyRow(ui) {
  const h = touchAware(ui, BC_ROW_H);
  ui.nextRect(h);
  const x = ui.rx, y = ui.ry, w = ui.rw;
  ui.text.lineMetrics(TYPE.sm, ui._lm);
  const base = y + h / 2 + (ui._lm.ascent - ui._lm.descent) / 2;
  ui.text.draw(ui.dl, BC_KEY_LABEL, x, base, TYPE.sm, W.regular, COLOR.inkDim, 0, TRACK.ui, 1);
  if (keyEdit.active) {
    const fx = x + bcKeyLabelW + SPACE.md;
    const res = ui.textField('drawer.bcKey', fx, y + (h - PRESET_H) / 2, x + w - fx, PRESET_H, keyEdit, TYPE.xs, 2);
    // trimmed on the commit only, a click's worth of work
    if (res === TEXT_COMMIT && keyEdit.text.trim()) broadcastSetKey(keyEdit.text);
    return;
  }
  const id = ui.id('drawer.bcKeyRow');
  ui.interact(id, x, y, w, h, false);
  const hover = ui.hover;
  if (hover) { ui.setCursorHint('pointer'); noteTip(id, x, y, w, TIP_BC_KEY, h); }
  if (ui.clicked) ui.textBegin(keyEdit, '', false, false);
  const has = broadcastHasKey();
  const hv = ui.spring(id, hover ? 1 : 0, MOTION.hover);
  ui.text.draw(ui.dl, has ? BC_KEY_MASK : BC_KEY_UNSET, x + w, base, TYPE.xs, W.regular,
               hv > 0.5 ? COLOR.ink : has ? COLOR.inkDim : COLOR.inkFaint, 2, TRACK.ui, 1);
}

// The drawer's slide, stepped once per frame before anything reads it, so
// the drawer, the burger riding its edge and S.edgeInset all move on this
// frame's value: the same spring, the same maths, no frame of lag.
let slideO = 0, slideDx = -(W_DRAWER + BLEED);
export function stepDrawer(ui) {
  slideO = ui.spring('drawer.open', S.panelOpen ? 1 : 0, MOTION.panel);
  slideDx = -(W_DRAWER + BLEED) * (1 - slideO);
  S.edgeInset = Math.max(0, Math.min(W_DRAWER, slideDx + W_DRAWER));
}
// The pane's right edge this frame, css px (negative while it is tucked
// away past the screen's left).
export function drawerEdge() { return slideDx + W_DRAWER; }

export function drawDrawer(ui, app) {
  const o = slideO, dx = slideDx;
  if (o < 0.002) return;
  if (openGroups === null) { installGroupMemory(ui); measureSumCol(ui); }

  const height = app.height;
  // An open dropdown's menu floats over the rows after its own (widgets.js
  // select): it takes its presses first, from where it was drawn last frame,
  // and hides the rows it covers from the pointer until popupDraw below.
  ui.popupInput();
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
  const authoring = journeyEditing();
  const rampGlow = journeyRampGlow();
  if (rampGlow > 0) rampColors(rampGlow);
  for (let g = 0; g < GROUPS.length; g++) {
    const grp = GROUPS[g];
    const sw = grp.sw;
    if (rampGlow > 0 && journeyRampingSection(grp.sec)) { ui.headGlow = rampGlow; ui.headGlowColor = JOURNEY_ACCENT; }
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
      // A sub-drawer is a fold (imgui.js beginFold) around its run, opening
      // and shutting on the section's own height spring; shut and at rest,
      // its rows are skipped, the runs inside it still counted so all balance.
      // A variance owner (see OWNERS) wears a chevron in the guide line beside
      // it, drawn around its row, and its variance run sits in a headerless
      // fold begun straight after it, carried to the run by foldNext as a
      // sub-drawer's is. The owner's own row may be hidden (a proxy row
      // above wears the chevron then); the fold still begins in its place.
      const items = grp.items, runOpen = grp.open, runClose = grp.close, foldId = grp.foldId;
      const varFold = grp.varFold, chev = grp.chev, chevId = grp.chevId;
      const gateFold = grp.gateFold, seen = grp.seen, stripSw = grp.stripSw;
      runDepth = 0; skipFrom = 0; foldNext = 0; skipNext = 0; frozenFrom = 0; nextFrozen = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        for (let k = runClose[i]; k > 0; k--) closeRun(ui);
        if (runOpen[i]) {
          ui.beginIndent();
          runDepth++;
          if (runDepth < foldAt.length) {
            foldAt[runDepth] = foldNext;
            if (skipNext) skipFrom = runDepth;
          }
          if (nextFrozen && !frozenFrom) { frozenFrom = runDepth; ui.pushInert(); }
          foldNext = 0; skipNext = 0; nextFrozen = 0;
        }
        if (skipFrom) continue;
        if (foldId[i]) {
          // its header, which the fold draws (and pins) itself
          const sw = stripSw[i];
          // A strip carrying a switch hides by that switch's own rule (a
          // music voice's while the music is off), rows and all, as the
          // voice's toggle row did; no fold is begun and the run is skipped.
          if (sw && sw.ctrl.visible && !sw.ctrl.visible(S)) { skipNext = 1; continue; }
          // So does a sub-drawer by a visible rule of its own (the Edge's
          // Motion and Style, Surfing's, while another effect is chosen).
          if (it.visible && !it.visible(S)) { skipNext = 1; continue; }
          const open = !!it.get(S);
          // The summary is kept current even while open (a few gets, no
          // strings once steady), so it is there on the very click that
          // shuts the strip; the strip shows it only while set shut.
          const sum = grp.subSum[i];
          const sumStr = sum ? subSummary(sum) : '';
          if (rampGlow > 0 && journeyRampingSub(it.id)) { ui.headGlow = rampGlow; ui.headGlowColor = JOURNEY_ACCENT; }
          let drawn;
          if (sw) {
            // The switch rides the strip; a click on it runs its control's
            // set() (setSwitch) and leaves the drawer open or shut as it was.
            drawn = ui.beginFold(foldId[i], it.label, open, sumStr, sumCol, !!sw.ctrl.get(S),
                                 !!sw.ctrl.enabled && !sw.ctrl.enabled(S));
            if (ui.foldSwitchChanged) setSwitch(sw, ui.foldSwitch);
          } else drawn = ui.beginFold(foldId[i], it.label, open, sumStr, sumCol);
          if (ui.foldToggled) it.set(S, open ? 0 : 1);
          foldNext++;
          if (!drawn) skipNext = 1;
          else if (gateFold[i] >= 0) beginGate(ui, gateFold[i]);
          continue;
        }
        if (it.heading) {
          subHeading(ui, it.heading, i > 0);
        } else {
          // Whether the row shows is settled once, here: by its own rule,
          // remembered in seen, or inside a switch fold sliding shut, as it
          // last showed.
          let shown;
          if (frozenFrom) shown = seen[i] === 1;
          else { shown = !it.visible || it.visible(S); seen[i] = shown ? 1 : 0; }
          if (shown) {
            if (authoring && journeyOverridden(it.id)) journeyDot(ui, it, g * 1024 + i);
            // a row in a playing step's ramp: where it starts, before it
            // lays out, and its height from how far it moved the cursor
            const ramping = rampGlow > 0 && journeyRampingControl(it.id);
            let rx = 0, ry = 0, rw = 0;
            if (ramping) { ui.peek(); rx = ui.px; ry = ui.py; rw = ui.pw; }
            const slot = chev[i];
            if (slot >= 0) {
              const open = varOpen[slot] === 1;
              // Always in the full accent, open or shut, acting or not: in the
              // guide line's own faint colour it was too dim to find.
              if (ui.lineChevron(chevId[i], open, true)) toggleVariance(slot);
            }
            ui.control(it, S, true);
            if (ramping) rampRow(ui, rx, ry, rw, ui.cursorY - ry - SPACE.xs);
            if (slot >= 0) ui.endLineChevron();
            // a control can carry a hover tip (schema `tip`), shown like the chips'
            if (it.tip && ui._lastHover) {
              // Anchored over the row's LABEL, not the whole row, so the
              // tip sits above the word it explains rather than the slider.
              // Measured only on hovered frames, so steady frames pay nothing.
              const lw = it.label ? ui.text.measure(it.label, TYPE.sm, W.regular) : ui._lastW;
              noteTip(ui._lastId, ui._lastX, ui._lastY, lw, it.tip, ui._lastH, true);
            }
          }
          if (varFold[i] >= 0) {
            foldNext++;
            if (!ui.beginFold(OWNERS[varFold[i]].foldId, null, varOpen[varFold[i]] === 1)) skipNext = 1;
          }
          if (gateFold[i] >= 0) beginGate(ui, gateFold[i]);
        }
      }
      for (let k = grp.closeEnd; k > 0; k--) closeRun(ui);
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

  // Broadcast, the last section of all (see drawBroadcast), on the headers'
  // column like the sections above and skipped whole where no broadcast can
  // start. Its body is drawn until it settles shut, as every section's is.
  if (broadcastAvailable()) {
    ui.spacer(SPACE.lg);
    ui.setCursor(dx + HEAD_X, ui.cursorY, HEAD_W);
    const open = ui.group('drawer.broadcast', 'Broadcast');
    if (open || !ui.groupSettled) {
      ui.setCursor(ui.cursorX + KNOB_OVERHANG, ui.cursorY, ui.regionW - KNOB_OVERHANG * 2);
      drawBroadcast(ui);
    }
    ui.endGroup();
  }
  ui.spacer(SPACE.xl);

  ui.endScroll();

  // the profiler's footer, pinned below the scroll body
  drawFooter(ui, dx, height);

  // Anything that reaches the pane without landing on a control stops here,
  // so a click on empty glass never falls through to the field and stops the
  // session.
  ui.interact(ui.id('drawer.backstop'), dx, 0, W_DRAWER, height, false);
  ui.endPanel();

  // the open menu, over every row, header and clip of the pane
  ui.popupDraw();

  // after the pane's clip too: a tip centred on a chip near the right edge
  // is wider than the space left in the pane, so it may overhang the field
  if (tip.id !== -1) ui.tooltipAt(tip.id, tip.x, tip.y, tip.w, tip.h, tip.hover, tip.str, tip.instant);
}
