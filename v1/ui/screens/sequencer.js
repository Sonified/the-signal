// The sequencer: a floating step grid for the music's synth line, in the
// mixer's window style (ui/screens/mixer.js), after the step sequencer on the
// Sonara site (explorations/sonara: rows of pitches over columns of steps,
// a cell lit while the playhead passes it).
//
// The rows are the scale over two octaves, 15 at the top down to 1, and the
// columns are the steps, up to 16. The voice plays one note at a time, so a
// step holds one note: clicking a cell puts that note on the step, clicking
// it again leaves the step a rest. Columns past the pattern's length are
// drawn dim and wait there, keeping their notes, until the length reaches
// them.
//
// Eight lines play together, one strip each in the section under the grid:
// its name, mute and solo, waveform, its octave (BASE) and octave
// randomization (RAND), its level, and a chevron that folds open the line's
// own settings in four rows, ENVELOPE, PAN, REVERB and DELAY. A click on a strip
// anywhere off its controls makes that line the active one, the one the
// grid, the length and randomize and clear act on. Line 1 is the original
// 3 4 8 figure. Which folds are open is the window's own state, kept with
// the UI record (saveUiState), never on S or in presets.
//
// Everything it edits lives on S (seqs, seqSlot) and is saved through
// store.js; the engine (js/piano.js) reads it step by step, so an edit is
// heard from the next step on, and a line's own settings reach the sound
// through applySeqs at once.
import { S, seqSeat } from '../../../js/state.js';
import {
  SEQ_ROWS, SEQ_MAX, SEQ_COUNT, SEQ_WAVES, SEQ_OCT_MODES, SEQ_DLY_STEPS,
  seqRandomize, applyArp, applySeqs, seqAnySolo, seqGate
} from '../../../js/piano.js';
// the step clock through the mirror, which reads it from the page in worker mode
import { seqClockNow } from '../../core/audio-mirror.js';
import { loadUiState, saveUiState, save } from '../../core/store.js';
import { byId } from '../../core/schema.js';
import { W, MOTION } from '../theme.js';
import { ICON } from '../drawlist.js';

// ---------- colours: the mixer's, and Sonara's purple for the cells ----------
function css(hex, a) {
  const n = parseInt(hex.slice(1, 7), 16), v = new Float32Array(4);
  v[0] = (n >> 16 & 255) / 255; v[1] = (n >> 8 & 255) / 255; v[2] = (n & 255) / 255;
  v[3] = a !== undefined ? a : 1;
  return v;
}
const C = {
  pane: css('#1a222c'), paneBorder: css('#2c3742'), bar: css('#171e27'), barLine: css('#29313b'),
  title: css('#bac5d1'),
  lightOff: css('#35443d'), lightOn: css('#62d7aa'), lightGlow: css('#4ad9a0', 0.3),
  lightStop: css('#e0605a'), lightStopGlow: css('#e0605a', 0.3),
  btnBg: css('#121820'), btnBorder: css('#222a33'), btnBorderHover: css('#3a4551'), btnInk: css('#8e9aaa'),
  btnOnBg: css('#2a2340'), btnOnBorder: css('#8b6ec0'), btnOnInk: css('#d8c8f5'),
  powerInk: css('#64d8ad'), powerBorder: css('#365e50'),
  closeHoverInk: css('#ff8a8a'), closeHoverBorder: css('#5a3a3a'),
  label: css('#a082d2'), labelDim: css('#5f6c7c'),
  cell: css('#a082d2', 0.06), cellBorder: css('#a082d2', 0.12),
  cellHover: css('#a082d2', 0.16),
  on: css('#8b6ec0', 0.35), onBorder: css('#8b6ec0', 0.5),
  lit: css('#8b6ec0', 0.9), litBorder: css('#b496e6', 0.95), litGlow: css('#8b6ec0', 0.45),
  head: css('#ffffff', 0.05),
  sectionInk: css('#5f6c7c'), valueInk: css('#d6e0e8'),
  // the lines: the active row's ground, and the mixer's lit mute and solo
  rowActive: css('#8b6ec0', 0.12), rowActiveBorder: css('#8b6ec0', 0.4),
  muteBg: css('#9b3339'), muteBorder: css('#dc626a'), muteInk: css('#ffe7e7'),
  soloBg: css('#256846'), soloBorder: css('#58c98b'), soloInk: css('#d4ffe4'),
  // the fold's panels round a knob and its VAR and RATE, a shade under the
  // grid's empty cell, and the hairline that joins them
  panel: css('#a082d2', 0.05), panelBorder: css('#a082d2', 0.1), wire: css('#a082d2', 0.28)
};

// ---------- sizes ----------
const RADIUS_WIN = 9, BAR_H = 33, PAD = 12;
const BTN_H = 21, CLOSE_H = 22, BTN_PAD_X = 9, CLOSE_PAD_X = 7, BAR_GAP = 9;
const TOOL_H = 34;
const CELL = 22, CELL_GAP = 3, LABEL_W = 20;
const ROWS = SEQ_ROWS.length;
const ROW_LABELS = ['15', '14', '13', '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1'];
const GRID_H = ROWS * CELL + (ROWS - 1) * CELL_GAP;
const NUM_H = 16;            // the step numbers under the grid
// The lines' section: a hairline, a row of column names, then a strip a
// line, each with its fold under it. Every x below is from the content's
// left edge (x + PAD).
const LINES_GAP = 8, HEAD_H = 18, ROW_H = 24, ROW_GAP = 2, LINE_BTN_H = 18;
const CONTENT_W = SEQ_MAX * CELL + (SEQ_MAX - 1) * CELL_GAP + LABEL_W;
// the strip: name, M, S, wave, level and its value, the fold's chevron
const M_X = 26, S_X = 49, MS_W = 20;
const WAVE_X = 77, WAVE_W = 32;
// BASE, a compact stepper, and RAND, the mode and its count
const OCT_BTN_W = 16, OCT_DN_X = 117, OCT_VAL_X = OCT_DN_X + OCT_BTN_W + 11, OCT_UP_X = OCT_DN_X + OCT_BTN_W + 22;
const MODE_X = OCT_UP_X + OCT_BTN_W + 10, MODE_W = 34, CNT_X = MODE_X + MODE_W + 4, CNT_W = 26;
const LVOL_X = CNT_X + CNT_W + 12, LVOL_W = 150, LVAL_X = LVOL_X + LVOL_W + 12;
const CHEV_W = 18, CHEV_ICON = 12;
// the strip's own width: the level's value (up to '100%') and the chevron
const STRIP_W = LVAL_X + 30 + 6 + CHEV_W;
// The fold: four rows, each a name on the left and then its controls. A
// knob and its small name are one tight pair, the name right-aligned
// KNOB_LABEL_R px left of the knob's centre (PAIR_GAP px clear of its
// dots), so a wider value shown in the name's place while the knob is
// touched grows away from its knob, never into it.
//
// The pairs are laid end to end from each pair's measured name, not on a
// fixed pitch: a fixed pitch with names of different widths (VAR, RATE,
// FDBK) leaves a different gap before every name, which is what read as
// uneven. Here the gap from one knob's dots to the next name is always
// UNIT_GAP, and where a row parts into clusters (ENVELOPE's attack and
// decay, REVERB's send and its TIME, DELAY's TIME, its feedback and its
// spread with ping pong) it is UNIT_GAP plus CLUSTER_GAP, the one wider
// gap, the same everywhere (FOLD_BREAKS). Every row starts
// its first name on the same column. The layout is measured once, the
// first frame the text can be measured (foldLayout).
const FOLD_ROWS = 4, FOLD_ROW_H = 30, FOLD_PAD = 4;
const FOLD_H = FOLD_ROWS * FOLD_ROW_H + FOLD_PAD * 2;
const FOLD_NAME_X = 4, FOLD_CELL0 = 70;
const KNOB_REACH = 11;                    // the knob's dots reach this far from its centre
const PAIR_GAP = 5, UNIT_GAP = 14, CLUSTER_GAP = 14;
const KNOB_LABEL_R = KNOB_REACH + PAIR_GAP;
// Per knob row (ENVELOPE, PAN, REVERB, DELAY): the knobs a cluster break
// comes before, and the panels, each a first and last knob index. A panel
// wraps a value with its own VAR and RATE; a knob that stands alone
// (reverb TIME, delay TIME, SPRD) gets none, and a break parts it from the
// panel beside it.
const FOLD_BREAKS = [[3], [], [3], [1, 4]];
const FOLD_PANELS = [[0, 2, 3, 5], [0, 2], [0, 2], [1, 3]];
// A panel reaches PANEL_PAD past its first name and its last knob's dots,
// PANEL_H tall on the row's centre. Inside it, a hairline runs through each
// gap from one knob's dots to the next knob's name, at the knobs' height:
// in the gaps rather than centre to centre, since the names sit on that
// same line and a wire through them would strike them out.
const PANEL_PAD = 5, PANEL_H = 26, PANEL_R = 6, WIRE_PAD = 2;
const FOLD_NAMES = ['ENVELOPE', 'PAN', 'REVERB', 'DELAY'];
// DELAY: the ping pong box a unit gap after SPRD, in SPRD's cluster
const PING_BOX = 11, PING_LABEL_GAP = 5;
// The measured layout: each knob's centre by row (4 rows of up to 6), the
// ping pong box, and from them the lines' width, the wider of the grid and
// the widest fold row plus a margin, which the window fits. Until the first
// measure, the grid's width.
const knobX = new Float32Array(4 * 6);
// the panels (x0, x1 by row, two at most) and their wires (x0, x1 by row,
// four at most), as spans from the content's left edge
const panelX = new Float32Array(4 * 4), panelN = new Uint8Array(4);
const wireX = new Float32Array(4 * 8), wireN = new Uint8Array(4);
let laidOut = false, PING_X = 0, LINES_W = Math.max(CONTENT_W, STRIP_W), CHEV_X = LINES_W - CHEV_W, WIN_W = PAD * 2 + LINES_W;
const FOLD_MARGIN = 8;
// the window with every fold shut; each open fold adds its height
const WIN_H_BASE = BAR_H + 1 + TOOL_H + GRID_H + NUM_H + LINES_GAP + 1 + HEAD_H +
  SEQ_COUNT * ROW_H + (SEQ_COUNT - 1) * ROW_GAP + PAD;
const STEP_LABELS = Array.from({ length: SEQ_MAX }, (_, i) => String(i + 1));
const LINE_LABELS = Array.from({ length: SEQ_COUNT }, (_, i) => 'S' + (i + 1));
const WAVE_SHORT = { sine: 'sin', triangle: 'tri', sawtooth: 'saw', square: 'sqr' };
// Every whole percent, made once, so a level's value never builds a string.
const PCT = Array.from({ length: 101 }, (_, i) => i + '%');
const pctText = v => PCT[Math.max(0, Math.min(100, Math.round(v * 100)))];
// the octave's baseline, -3..+3, and the randomization's mode and range in
// the mode's own spelling
const OCT_BASE_LABELS = ['-3', '-2', '-1', '0', '+1', '+2', '+3'];
const OCT_MODE_LABELS = { off: 'OFF', up: '+', down: '−', both: '+/−' };
const OCT_COUNT_LABELS = {
  off: ['+1', '+2', '+3', '+4'], up: ['+1', '+2', '+3', '+4'],
  down: ['−1', '−2', '−3', '−4'], both: ['±1', '±2', '±3', '±4']
};
// the delay's times as its readout shows them, one per SEQ_DLY_STEPS entry
const DLY_LABELS = ['¼', '⅓', '½', '⅔', '¾', '1', '1½', '2', '3', '4'];

// alpha is the window's own opacity, set by the slider beside the title;
// floored so the window can never be lost entirely.
const ALPHA_MIN = 0.15;
// The slider is logarithmic: most of its travel only dims the window a
// little, and the fade deepens quickly toward the left end. u is the knob's
// place, 0..1 across; ALPHA_K sets how strongly the curve bends.
const ALPHA_K = 20, ALPHA_LN = Math.log(1 + ALPHA_K);
const uToAlpha = u => ALPHA_MIN + (1 - ALPHA_MIN) * Math.log(1 + ALPHA_K * u) / ALPHA_LN;
const alphaToU = a => (Math.exp((a - ALPHA_MIN) / (1 - ALPHA_MIN) * ALPHA_LN) - 1) / ALPHA_K;
export const sequencer = { open: false, placed: false, x: 0, y: 0, alpha: 0.9, dragging: false, grabX: 0, grabY: 0, alphaDrag: false,
  rx: 0, ry: 0, rw: 0, rh: 0 };   // where it was drawn last frame (rw 0: not showing), for stacking

// ---------- persistence of the window, as the mixer's ----------
let restored = false;
const saved = { open: false, placed: false, x: 0, y: 0, alpha: 0.9 };
// Which lines' folds are open, as the drawer keeps its open sections
// (drawer.js openGroups): every fold starts shut on a first visit, the UI
// record lists the lines left open, under a key of its own so the window's
// own record (persist, below) never overwrites it, and each open or close
// rewrites the list, a click's worth of work and never a frame's.
const foldOpen = new Uint8Array(SEQ_COUNT);
const foldA = new Float32Array(SEQ_COUNT);     // each fold's opening, 0..1, this frame
function restore() {
  restored = true;
  const all = loadUiState();
  const m = all && all.sequencer && typeof all.sequencer === 'object' ? all.sequencer : null;
  if (m) {
    sequencer.open = !!m.open;
    if (m.placed && Number.isFinite(m.x) && Number.isFinite(m.y)) { sequencer.placed = true; sequencer.x = m.x; sequencer.y = m.y; }
    // The window's opacity is fixed at its default now that its slider is
    // the volume; an old saved alpha is deliberately ignored.
  }
  const folds = all && Array.isArray(all.seqFolds) ? all.seqFolds : [];
  for (const i of folds) if (Number.isInteger(i) && i >= 0 && i < SEQ_COUNT) foldOpen[i] = 1;
  remember();
}
function toggleFold(i) {
  foldOpen[i] = foldOpen[i] ? 0 : 1;
  const list = [];
  for (let k = 0; k < SEQ_COUNT; k++) if (foldOpen[k]) list.push(k);
  saveUiState({ seqFolds: list });
}
function remember() {
  saved.open = sequencer.open; saved.placed = sequencer.placed;
  saved.x = Math.round(sequencer.x); saved.y = Math.round(sequencer.y);
  saved.alpha = Math.round(sequencer.alpha * 100) / 100;
}
function persist() {
  if (sequencer.dragging || sequencer.alphaDrag) return;
  if (saved.open === sequencer.open && saved.placed === sequencer.placed &&
      saved.x === Math.round(sequencer.x) && saved.y === Math.round(sequencer.y) &&
      saved.alpha === Math.round(sequencer.alpha * 100) / 100) return;
  remember();
  saveUiState({ sequencer: { open: saved.open, placed: saved.placed, x: saved.x, y: saved.y, alpha: saved.alpha } });
}

const lm = { ascent: 0, descent: 0 };
function baseline(ui, cy, size) {
  ui.text.lineMetrics(size, lm);
  return cy + (lm.ascent - lm.descent) / 2;
}

// A header or toolbar button: returns true on click, and leaves its hover in
// btnHover for the caller's styling. Buttons keep the pointer off the
// title bar's drag.
let btnHover = false, overBtn = false;
function btn(ui, name, x, y, w, h) { return btnAt(ui, ui.id(name), x, y, w, h); }
// the same by a numeric id (ui.idx), so a button per line builds no string
function btnAt(ui, id, x, y, w, h) {
  ui.interact(id, x, y, w, h, false);
  btnHover = ui.hover;
  if (btnHover) { ui.setCursorHint('pointer'); overBtn = true; }
  return ui.clicked;
}
function drawBtn(ui, x, cy, w, h, on, label, size) {
  const dl = ui.dl;
  dl.rect(x, cy - h / 2, w, h, 6, on ? C.btnOnBg : C.btnBg, 1,
    on ? C.btnOnBorder : btnHover ? C.btnBorderHover : C.btnBorder, 0, 0);
  ui.text.draw(dl, label, x + w / 2, baseline(ui, cy, size), size, W.regular, on ? C.btnOnInk : C.btnInk, 1, 0, 1);
}
function measureBtn(ui, label, size) { return ui.text.measure(label, size, W.regular) + BTN_PAD_X * 2 + 2; }
// A line's M or S: the window's button, lit red for mute and green for solo
// as the mixer's are.
function drawMs(ui, x, cy, w, h, on, isMute, label) {
  if (!on) { drawBtn(ui, x, cy, w, h, false, label, 10); return; }
  ui.dl.rect(x, cy - h / 2, w, h, 6, isMute ? C.muteBg : C.soloBg, 1, isMute ? C.muteBorder : C.soloBorder, 0, 0);
  ui.text.draw(ui.dl, label, x + w / 2, baseline(ui, cy, 10), 10, W.regular, isMute ? C.muteInk : C.soloInk, 1, 0, 1);
}

// ---------- the knob ----------
// A small rotary for the lines' own settings. Its value shows as
// an arc of dots round a round body, lit from the start of the sweep (from
// the top, for a centred knob) to the value, with a dot on the body pointing
// at it. Dragging up turns it up and down turns it down, the whole range in
// KNOB_TRAVEL px, ten times finer with Shift; a centred knob catches at its
// centre on the way through. A double-click puts it back to its default.
// One knob is dragged at a time, so its drag lives in module state, and the
// dots' directions are worked out once here, so a frame allocates nothing.
const KNOB_R = 7, KNOB_ARC_R = 10, KNOB_DOTS = 13, KNOB_TRAVEL = 150, KNOB_SWEEP = 270 * Math.PI / 180;
const KNOB_DX = new Float32Array(KNOB_DOTS), KNOB_DY = new Float32Array(KNOB_DOTS);
for (let k = 0; k < KNOB_DOTS; k++) {
  const a = -KNOB_SWEEP / 2 + KNOB_SWEEP * k / (KNOB_DOTS - 1);
  KNOB_DX[k] = Math.sin(a); KNOB_DY[k] = -Math.cos(a);
}
// half a dot's spacing, so the dot nearest the value is the last one lit
const KNOB_EPS = 0.5 / (KNOB_DOTS - 1);
let knobHeld = -1, knobY = 0, knobRaw = 0, knobFine = false;
// whether the last knob drawn is under the pointer or held, for its readout
let knobLive = false;
// Returns the knob's value after this frame's input (value itself when
// untouched); the caller writes it back if it moved.
function knob(ui, id, cx, cy, value, lo, hi, def, centred) {
  const hr = KNOB_ARC_R + 2;
  ui.interact(id, cx - hr, cy - hr, hr * 2, hr * 2, false);
  const hover = ui.hover, pressed = ui.pressed;
  knobLive = hover || pressed;
  if (hover || pressed) { ui.setCursorHint(pressed ? 'ns-resize' : 'pointer'); overBtn = true; }
  let v = value;
  if (pressed) {
    // Shift is read off the press, then followed through the key events
    // while the drag lasts, so pressing or letting go of it mid-drag
    // changes the rate from there on without a jump
    if (knobHeld !== id) { knobHeld = id; knobY = ui.pointerY; knobRaw = value; knobFine = ui.pointerShift; }
    for (let i = 0; i < ui.keyCount; i++) {
      const c = ui.keyCode(i);
      if (c === 'ShiftLeft' || c === 'ShiftRight') knobFine = ui.keyIsDown(i);
    }
    const dy = knobY - ui.pointerY;
    knobY = ui.pointerY;
    knobRaw = Math.max(lo, Math.min(hi, knobRaw + dy * (hi - lo) / (knobFine ? KNOB_TRAVEL * 10 : KNOB_TRAVEL)));
    v = centred && Math.abs(knobRaw) < (hi - lo) * 0.025 ? 0 : knobRaw;
  } else if (knobHeld === id) knobHeld = -1;
  if (ui.dbl) v = def;
  const dl = ui.dl, lit = hover || pressed;
  const u = Math.max(0, Math.min(1, (v - lo) / (hi - lo))), u0 = centred ? 0.5 : 0;
  const a = (u < u0 ? u : u0) - KNOB_EPS, b = (u > u0 ? u : u0) + KNOB_EPS;
  for (let k = 0; k < KNOB_DOTS; k++) {
    const f = k / (KNOB_DOTS - 1);
    dl.rect(cx + KNOB_DX[k] * KNOB_ARC_R - 1.2, cy + KNOB_DY[k] * KNOB_ARC_R - 1.2, 2.4, 2.4, 1.2,
      f >= a && f <= b ? C.label : C.btnBorder, 0, null, 0, 0);
  }
  dl.rect(cx - KNOB_R, cy - KNOB_R, KNOB_R * 2, KNOB_R * 2, KNOB_R, C.btnBg, 1, lit ? C.btnBorderHover : C.btnBorder, 0, 0);
  const ang = -KNOB_SWEEP / 2 + KNOB_SWEEP * u;
  dl.rect(cx + Math.sin(ang) * 4 - 1.5, cy - Math.cos(ang) * 4 - 1.5, 3, 3, 1.5, lit ? C.btnOnInk : C.valueInk, 0, null, 0, 0);
  return v;
}

// ---------- the fold's knobs ----------
// Each knob in a fold is described once here: the line's field it turns,
// its name, its range and default (a double-click's value), how its value
// reads while touched, and how a turned value is rounded before it is kept.
// A log knob turns in the logarithm of its value, so the short times get as
// much travel as the long ones; the delay's time turns through the index of
// SEQ_DLY_STEPS, so it only ever lands on one of those.
const F_PCT = 0, F_MS = 1, F_SEC = 2, F_PAN = 3, F_DLY = 4, F_SEC1 = 5;
const round01 = v => Math.round(v * 100) / 100;
function kspec(key, label, lo, hi, def, fmt, snap, log, centred) {
  return { key, label, lo, hi, def, fmt, snap, log: !!log, centred: !!centred, steps: null,
           kLo: log ? Math.log(lo) : lo, kHi: log ? Math.log(hi) : hi, kDef: log ? Math.log(def) : def };
}
const RATE_SNAP = v => Math.round(v);
const K_ATK = kspec('atk', 'ATK', 0.001, 0.5, 0.01, F_MS, v => Math.round(v * 1000) / 1000, true);
const K_DEC = kspec('dec', 'DEC', 0.02, 2, 0.25, F_MS, v => Math.round(v * 200) / 200, true);
const K_VAR = key => kspec(key, 'VAR', 0, 1, 0, F_PCT, round01);
const K_RATE = key => kspec(key, 'RATE', 1, 120, 20, F_SEC, RATE_SNAP, true);
// the pan's double-click goes to its own line's seat (lineKnob), not the
// centre, which dragging still catches on the way through
const K_PAN = kspec('pan', 'PAN', -1, 1, 0, F_PAN, round01, false, true);
K_PAN.seat = true;
const K_DLY = kspec('dlyTime', 'TIME', 0, SEQ_DLY_STEPS.length - 1, 1.5, F_DLY, null);
K_DLY.steps = SEQ_DLY_STEPS; K_DLY.kDef = SEQ_DLY_STEPS.indexOf(1.5);
// the fold's rows, in order, each a list of knobs left to right
const FOLD_KNOBS = [
  [K_ATK, K_VAR('atkVar'), K_RATE('atkRate'), K_DEC, K_VAR('decVar'), K_RATE('decRate')],
  [K_PAN,
   kspec('panMod', 'MOD', 0, 1, 0, F_PCT, round01), K_RATE('panRate')],
  [kspec('rev', 'AMT', 0, 1, 1, F_PCT, round01), K_VAR('revVar'), K_RATE('revRate'),
   kspec('revTime', 'TIME', 1, 15, 4.5, F_SEC1, v => Math.round(v * 2) / 2, true)],
  [K_DLY, kspec('dlyFb', 'FDBK', 0, 0.95, 0, F_PCT, round01), K_VAR('dlyFbVar'), K_RATE('dlyFbRate'),
   kspec('spread', 'SPRD', 0, 1, 0.9, F_PCT, round01)]
];
// A small name's drawn width: measure() knows nothing of tracking, so the
// 0.08 em between letters is added by hand.
const trackedW = (ui, t) => ui.text.measure(t, 8, W.semibold) + 0.08 * 8 * (t.length - 1);
// Lays the knob rows out end to end (the fold's constants above), once. Measured
// rather than fixed, so the gaps come out even whatever the names are;
// retried each frame until the text reports a width.
function foldLayout(ui) {
  if (laidOut) return;
  if (!(trackedW(ui, 'RATE') > 0)) return;
  let widest = 0;
  for (let r = 0; r < FOLD_KNOBS.length; r++) {
    const row = FOLD_KNOBS[r];
    let x = FOLD_CELL0;
    for (let k = 0; k < row.length; k++) {
      if (FOLD_BREAKS[r].indexOf(k) >= 0) x += CLUSTER_GAP;
      const c = x + trackedW(ui, row[k].label) + KNOB_LABEL_R;
      knobX[r * 6 + k] = c;
      x = c + KNOB_REACH + UNIT_GAP;
    }
    const pl = FOLD_PANELS[r];
    panelN[r] = 0; wireN[r] = 0;
    for (let j = 0; j + 1 < pl.length; j += 2) {
      const a = pl[j], b = pl[j + 1];
      const p = r * 4 + panelN[r] * 2;
      panelX[p] = knobX[r * 6 + a] - KNOB_LABEL_R - trackedW(ui, row[a].label) - PANEL_PAD;
      panelX[p + 1] = knobX[r * 6 + b] + KNOB_REACH + PANEL_PAD;
      panelN[r]++;
      for (let k = a; k < b; k++) {
        const w = r * 8 + wireN[r] * 2;
        wireX[w] = knobX[r * 6 + k] + KNOB_REACH + WIRE_PAD;
        wireX[w + 1] = knobX[r * 6 + k + 1] - KNOB_LABEL_R - trackedW(ui, row[k + 1].label) - WIRE_PAD;
        wireN[r]++;
      }
    }
    let end = x - UNIT_GAP;
    if (r === FOLD_KNOBS.length - 1) {
      PING_X = x;
      end = PING_X + PING_BOX + PING_LABEL_GAP + trackedW(ui, 'PING PONG');
    }
    if (end > widest) widest = end;
  }
  LINES_W = Math.max(CONTENT_W, STRIP_W, Math.ceil(widest + FOLD_MARGIN));
  CHEV_X = LINES_W - CHEV_W;
  WIN_W = PAD * 2 + LINES_W;
  laidOut = true;
}
// The nearest of the delay's times, for a stored value that is not quite
// one of them (a Float32 copy of a third, say).
function dlyIndex(v) {
  let best = 0;
  for (let k = 1; k < SEQ_DLY_STEPS.length; k++) {
    if (Math.abs(SEQ_DLY_STEPS[k] - v) < Math.abs(SEQ_DLY_STEPS[best] - v)) best = k;
  }
  return best;
}
// The touched knob's value as text. Only one knob can be under the pointer
// or held at a time, so one cached string serves them all, rebuilt only
// when the knob or its value changes (the rateText idiom below); percents
// come from the table and build nothing.
let readId = -1, readVal = NaN, readText = '';
function readout(id, sp, v) {
  if (id === readId && v === readVal) return readText;
  readId = id; readVal = v;
  const f = sp.fmt;
  if (f === F_PCT) readText = pctText(v);
  else if (f === F_MS) readText = v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's';
  else if (f === F_SEC) readText = Math.round(v) + 's';
  else if (f === F_SEC1) readText = v.toFixed(1) + 's';
  else if (f === F_DLY) readText = DLY_LABELS[dlyIndex(v)];
  else readText = Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
  return readText;
}
// One fold knob in cell k of a row centred on cy, turning line q's field.
// Writes the field only when the knob was actually turned (an untouched
// knob hands back exactly what it was given), so a log knob's round trip
// never rewrites a value nobody touched. Returns whether it wrote.
function lineKnob(ui, q, i, slot, cx, cy, sp) {
  const raw = q[sp.key];
  const def = sp.seat ? seqSeat(i) : sp.def, kDef = sp.seat ? def : sp.kDef;
  const cur = typeof raw === 'number' && raw === raw ? raw : def;
  const id = ui.idx('seq.knob', i * 64 + slot);
  const pos = sp.steps ? dlyIndex(cur) : sp.log ? Math.log(Math.max(sp.lo, Math.min(sp.hi, cur))) : cur;
  const got = knob(ui, id, cx, cy, pos, sp.kLo, sp.kHi, kDef, sp.centred);
  let moved = false, shown = cur;
  if (got !== pos) {
    const v = sp.steps ? sp.steps[Math.max(0, Math.min(sp.steps.length - 1, Math.round(got)))]
            : Math.max(sp.lo, Math.min(sp.hi, sp.snap(sp.log ? Math.exp(got) : got)));
    if (v !== raw) { q[sp.key] = v; moved = true; }
    shown = v;
  }
  const by = baseline(ui, cy, 8);
  const lx = cx - KNOB_LABEL_R;
  if (knobLive) ui.text.draw(ui.dl, readout(id, sp, shown), lx, by, 8, W.regular, C.valueInk, 2, 0, 1);
  else ui.text.draw(ui.dl, sp.label, lx, by, 8, W.semibold, C.sectionInk, 2, 0.08, 1);
  return moved;
}

// The step rate: a second surface on the drawer's Sequencer speed control,
// reading and writing through it so the two can never disagree.
const RATE = byId('arpRate');
let rateShown = NaN, rateText = '';
// The header's volume slider is the master over all eight lines, driven
// through its drawer control (arpVol), so the mixer, the drawer and this
// knob can never disagree. Each line's own level is on its row below.
const VOL = byId('arpVol');

// The play and pause button beside the title: the sequencer's own switch,
// S.arpOn, turned through the drawer's Sequencer toggle so its side effects
// (applyArp, the save) are that control's, and so worker mode's per-frame
// comparison of every control's position carries it to the page's sound.
// Playing shows pause, stopped shows play. PLAY_BOX is the drawn box, a
// little narrower than the close button; the hit box reaches PLAY_SLOP past
// it on every side so the press lands without aiming.
const ARP_ON = byId('arpOn');
const PLAY_BOX = 22, PLAY_ICON = 18, PLAY_SLOP = 4, PLAY_GAP = 8;

// fade is the chrome's idle fade, as the mixer's.
export function drawSequencer(ui, app, fade = 1) {
  if (!restored) restore();
  persist();
  const open = ui.spring('seq.open', sequencer.open ? 1 : 0, MOTION.panel);
  const o = open * fade;
  if (o < 0.002) { sequencer.rw = 0; return; }
  ui.pushScope(ui.id('seq'));
  foldLayout(ui);
  // Each fold opens on a spring of its own, and the window is as tall as
  // the folds are open, so it grows and shrinks with them.
  let folds = 0;
  for (let i = 0; i < SEQ_COUNT; i++) {
    foldA[i] = ui.spring(ui.idx('seq.foldA', i), foldOpen[i] ? 1 : 0, MOTION.panel);
    folds += foldA[i] * FOLD_H;
  }
  const width = app.width, height = app.height;
  const winW = Math.min(WIN_W, width - 24), h = WIN_H_BASE + folds;
  // first showing: under the mixer's usual place, right side
  if (!sequencer.placed) { sequencer.placed = true; sequencer.x = Math.max(12, width - winW - 24); sequencer.y = Math.max(12, height - h - 90); }
  sequencer.x = Math.max(12 - winW + 80, Math.min(sequencer.x, width - 80));
  sequencer.y = Math.max(12, Math.min(sequencer.y, height - BAR_H - 12));
  const x = sequencer.x, y = sequencer.y + (1 - open) * 16;
  sequencer.rx = x; sequencer.ry = y; sequencer.rw = winW; sequencer.rh = h;
  const dl = ui.dl;
  const pat = S.seqs[S.seqSlot | 0] || S.seqs[0];     // the active line, the one the grid edits

  dl.pushAlpha(o * sequencer.alpha);
  overBtn = false;

  // ---- pane and header ----
  dl.rect(x, y, winW, h, RADIUS_WIN, C.pane, 1, C.paneBorder, 10, 0.35);
  dl.pushClip(x + 1, y + 1, winW - 2, BAR_H - 1);
  dl.rect(x + 1, y + 1, winW - 2, BAR_H + RADIUS_WIN, RADIUS_WIN - 1, C.bar, 0, null, 0, 0);
  dl.popClip();
  dl.rect(x + 1, y + BAR_H, winW - 2, 1, 0, C.barLine, 0, null, 0, 0);
  const cy = y + 1 + (BAR_H - 1) / 2;

  const closeW = ui.text.measure('×', 18, W.regular) + CLOSE_PAD_X * 2 + 2;
  const closeX = x + winW - 1 - 8 - closeW;


  // the light: green while it sounds, red while on but the session is
  // stopped, dark when off, as the mixer's
  const lightX = x + 1 + 13;
  if (S.arpOn) {
    const playing = S.running && S.audioEnabled && S.musicOn;
    dl.rect(lightX - 3, cy - 6, 12, 12, 6, playing ? C.lightGlow : C.lightStopGlow, 0, null, 0, 0);
    dl.rect(lightX, cy - 3, 6, 6, 3, playing ? C.lightOn : C.lightStop, 0, null, 0, 0);
  } else {
    dl.rect(lightX, cy - 3, 6, 6, 3, C.lightOff, 0, null, 0, 0);
  }
  ui.text.draw(dl, 'SEQUENCER', lightX + 6 + BAR_GAP, baseline(ui, cy, 11), 11, W.semibold, C.title, 0, 0.13, 1);

  // play and pause, right of the title, claimed here before the title bar's
  // drag so a press on it never moves the window
  // measure() knows nothing of tracking, and the title draws letterspaced
  // (0.13 em per gap), so the spacing is added by hand or the button lands
  // on the final letters
  const playX = lightX + 6 + BAR_GAP + ui.text.measure('SEQUENCER', 11, W.semibold)
              + 0.13 * 11 * ('SEQUENCER'.length - 1) + PLAY_GAP;
  const playing = S.arpOn;
  if (btn(ui, 'seq.play', playX - PLAY_SLOP, cy - PLAY_BOX / 2 - PLAY_SLOP, PLAY_BOX + PLAY_SLOP * 2, PLAY_BOX + PLAY_SLOP * 2)) {
    if (ARP_ON) ARP_ON.set(S, !playing); else { S.arpOn = !playing; applyArp(); save(); }
  }
  dl.rect(playX, cy - PLAY_BOX / 2, PLAY_BOX, PLAY_BOX, 6, C.btnBg, 1,
    playing ? C.powerBorder : btnHover ? C.btnBorderHover : C.btnBorder, 0, 0);
  dl.icon(playing ? ICON.PAUSE : ICON.PLAY, playX + (PLAY_BOX - PLAY_ICON) / 2, cy - PLAY_ICON / 2, PLAY_ICON, PLAY_ICON,
    btnHover ? C.valueInk : playing ? C.powerInk : C.btnInk, 2.2, 0);

  // the sequencer's volume, a small slider right of the play button; a
  // press jumps it there and dragging follows. The window's opacity has no
  // slider any more and rests at its 90% default.
  const ax = playX + PLAY_BOX + 12, aw = 70;
  ui.interact(ui.id('seq.vol'), ax - 6, cy - 9, aw + 12, 18, false);
  if (ui.hover || ui.pressed) { ui.setCursorHint('ew-resize'); overBtn = true; }
  const aHover = ui.hover || ui.pressed;
  // The slider's whole travel covers only the bottom third of the level:
  // the sequencer at full is far past useful, so the top of this knob is 33
  // and the working range gets the whole sweep. A drawer setting above 33
  // just shows as full here.
  const VOL_TOP = 33;
  const curVol = VOL ? VOL.get(S) : Math.round((S.arpVol || 0) * 100);
  if (ui.pressed && VOL) {
    const pos = Math.round(Math.max(0, Math.min(1, (ui.pointerX - ax) / aw)) * VOL_TOP);
    if (pos !== curVol) VOL.set(S, pos);
  }
  const au = Math.max(0, Math.min(1, curVol / VOL_TOP));
  dl.rect(ax, cy - 1.5, aw, 3, 1.5, C.btnBorder, 0, null, 0, 0);
  dl.rect(ax, cy - 1.5, aw * au, 3, 1.5, C.label, 0, null, 0, 0);
  const kr = aHover ? 6 : 5;
  dl.rect(ax + aw * au - kr, cy - kr, kr * 2, kr * 2, kr, aHover ? C.btnOnInk : C.label, 0, null, 0, 0);
  // its value beside it, the drawer's own percent, from the table
  const volNow = VOL ? VOL.get(S) : Math.round((S.arpVol || 0) * 100);
  ui.text.draw(dl, PCT[Math.max(0, Math.min(100, volNow | 0))], ax + aw + 10, baseline(ui, cy, 10), 10, W.regular, C.valueInk, 0, 0, 1);

  // the step rate, the same kind of slider after it, with its value beside
  if (RATE) {
    const rx = ax + aw + 50, rw = 70;
    const lo = RATE.min, hi = RATE.max, stp = RATE.step || 0.5;
    ui.interact(ui.id('seq.rate'), rx - 6, cy - 9, rw + 12, 18, false);
    if (ui.hover || ui.pressed) { ui.setCursorHint('ew-resize'); overBtn = true; }
    const rHover = ui.hover || ui.pressed;
    const cur = RATE.get(S);
    if (ui.pressed) {
      const u = Math.max(0, Math.min(1, (ui.pointerX - rx) / rw));
      const pos = Math.max(lo, Math.min(hi, lo + Math.round(u * (hi - lo) / stp) * stp));
      if (pos !== cur) RATE.set(S, pos);
    }
    const now = RATE.get(S);
    if (now !== rateShown) { rateShown = now; rateText = now.toFixed(1) + '/s'; }
    const ru = (now - lo) / (hi - lo);
    dl.rect(rx, cy - 1.5, rw, 3, 1.5, C.btnBorder, 0, null, 0, 0);
    dl.rect(rx, cy - 1.5, rw * ru, 3, 1.5, C.label, 0, null, 0, 0);
    const rk = rHover ? 6 : 5;
    dl.rect(rx + rw * ru - rk, cy - rk, rk * 2, rk * 2, rk, rHover ? C.btnOnInk : C.label, 0, null, 0, 0);
    ui.text.draw(dl, rateText, rx + rw + 10, baseline(ui, cy, 10), 10, W.regular, C.valueInk, 0, 0, 1);
  }

  // The on/off that used to sit here duplicated the title's play/pause
  // (both drive S.arpOn) and is gone by Robert's call (2026-09-26).

  if (btn(ui, 'seq.close', closeX, cy - CLOSE_H / 2, closeW, CLOSE_H)) sequencer.open = false;
  dl.rect(closeX, cy - CLOSE_H / 2, closeW, CLOSE_H, 6, C.btnBg, 1, btnHover ? C.closeHoverBorder : C.btnBorder, 0, 0);
  ui.text.draw(dl, '×', closeX + closeW / 2, baseline(ui, cy, 18), 18, W.regular, btnHover ? C.closeHoverInk : C.btnInk, 1, 0, 1);

  // ---- toolbar: the active line's length, randomize, clear ----
  // (the line itself is chosen from its row in the section below)
  const ty = y + BAR_H + 1 + TOOL_H / 2;
  let tx = x + PAD;
  ui.text.draw(dl, 'LENGTH', tx, baseline(ui, ty, 9), 9, W.semibold, C.sectionInk, 0, 0.1, 1);
  tx += ui.text.measure('LENGTH', 9, W.semibold) + 8;
  if (btn(ui, 'seq.lenDown', tx, ty - BTN_H / 2, 20, BTN_H) && pat.len > 1) { pat.len--; save(); }
  drawBtn(ui, tx, ty, 20, BTN_H, false, '−', 12);
  tx += 20;
  ui.text.draw(dl, STEP_LABELS[Math.max(1, Math.min(SEQ_MAX, pat.len | 0)) - 1], tx + 14, baseline(ui, ty, 11), 11, W.semibold, C.valueInk, 1, 0, 1);
  tx += 28;
  if (btn(ui, 'seq.lenUp', tx, ty - BTN_H / 2, 20, BTN_H) && pat.len < SEQ_MAX) { pat.len++; save(); }
  drawBtn(ui, tx, ty, 20, BTN_H, false, '+', 12);
  // randomize and clear, from the right
  const clearW = measureBtn(ui, 'clear', 10), randW = measureBtn(ui, 'randomize', 10);
  const clearX = x + winW - PAD - clearW, randX = clearX - 6 - randW;
  if (btn(ui, 'seq.rand', randX, ty - BTN_H / 2, randW, BTN_H)) { seqRandomize(pat); save(); }
  drawBtn(ui, randX, ty, randW, BTN_H, false, 'randomize', 10);
  if (btn(ui, 'seq.clear', clearX, ty - BTN_H / 2, clearW, BTN_H)) { pat.steps.fill(-1); save(); }
  drawBtn(ui, clearX, ty, clearW, BTN_H, false, 'clear', 10);

  // ---- the grid ----
  const gx = x + PAD + LABEL_W, gy = y + BAR_H + 1 + TOOL_H;
  // One step count for every line (js/piano.js seqClock): each line's step
  // is the count modulo its own length, the grid's playhead the active one's.
  const clock = S.arpOn && S.running ? seqClockNow() : -1;
  const head = clock >= 0 ? clock % Math.max(1, Math.min(SEQ_MAX, pat.len | 0)) : -1;
  if (head >= 0 && head < pat.len) {
    dl.rect(gx + head * (CELL + CELL_GAP) - 1, gy - 2, CELL + 2, GRID_H + 4, 4, C.head, 0, null, 0, 0);
  }
  for (let r = 0; r < ROWS; r++) {
    const ry = gy + r * (CELL + CELL_GAP);
    ui.text.draw(dl, ROW_LABELS[r], x + PAD + LABEL_W / 2 - 4, baseline(ui, ry + CELL / 2, 10), 10, W.semibold, C.label, 1, 0, 1);
    const note = SEQ_ROWS[r];
    for (let c = 0; c < SEQ_MAX; c++) {
      const cx = gx + c * (CELL + CELL_GAP);
      const live = c < pat.len;
      const id = ui.idx('seq.cell', r * SEQ_MAX + c);
      ui.interact(id, cx, ry, CELL, CELL, !live);
      const hover = ui.hover && live;
      if (hover) ui.setCursorHint('pointer');
      if (ui.clicked && live) { pat.steps[c] = pat.steps[c] === note ? -1 : note; save(); }
      const on = pat.steps[c] === note;
      if (!live) dl.pushAlpha(0.3);
      if (on && c === head) {
        dl.rect(cx - 2, ry - 2, CELL + 4, CELL + 4, 5, C.litGlow, 0, null, 0, 0);
        dl.rect(cx, ry, CELL, CELL, 3, C.lit, 1, C.litBorder, 0, 0);
      } else if (on) {
        dl.rect(cx, ry, CELL, CELL, 3, C.on, 1, C.onBorder, 0, 0);
      } else {
        dl.rect(cx, ry, CELL, CELL, 3, hover ? C.cellHover : C.cell, 1, C.cellBorder, 0, 0);
      }
      if (!live) dl.popAlpha();
    }
  }

  // ---- the step numbers under the grid, dim past the length, bright under the playhead ----
  const ny = gy + GRID_H + NUM_H / 2 + 2;
  for (let c = 0; c < SEQ_MAX; c++) {
    const cx = gx + c * (CELL + CELL_GAP) + CELL / 2;
    const col = c === head ? C.valueInk : c < pat.len ? C.label : C.labelDim;
    ui.text.draw(dl, STEP_LABELS[c], cx, baseline(ui, ny, 9), 9, c === head ? W.semibold : W.regular, col, 1, 0, c < pat.len ? 1 : 0.5);
  }

  // ---- the lines, each with its fold ----
  drawLines(ui, x, winW, gy + GRID_H + NUM_H + LINES_GAP, clock);

  // ---- title bar drag, the offset taken on press so the window does not jump ----
  ui.interact(ui.id('seq.drag'), x, y, winW, BAR_H, false);
  if (ui.pressed) {
    if (!sequencer.dragging) { sequencer.dragging = true; sequencer.grabX = ui.pointerX - sequencer.x; sequencer.grabY = ui.pointerY - sequencer.y; }
    sequencer.x = ui.pointerX - sequencer.grabX; sequencer.y = ui.pointerY - sequencer.grabY;
    ui.setCursorHint('grabbing');
  } else {
    sequencer.dragging = false;
    if (ui.hover && !overBtn) ui.setCursorHint('grab');
  }

  // clicks on empty pane stop here instead of reaching the drawer or field
  ui.interact(ui.id('seq.backstop'), x, y, winW, h, false);
  dl.popAlpha();
  ui.popScope();
}

// The eight lines, a strip each under a hairline and a row of column names,
// each strip followed by its fold as far as the fold is open. top is the
// hairline's y. Each strip's own controls are claimed first, then the strip
// itself, so a press anywhere else on it makes the line active. Every edit
// writes the line on S, moves the sound through applySeqs and saves; in
// worker mode the packed sequencer row carries it to the page.
function drawLines(ui, x, winW, top, clock) {
  const dl = ui.dl, x0 = x + PAD;
  dl.rect(x + 1, top, winW - 2, 1, 0, C.barLine, 0, null, 0, 0);
  const hy = baseline(ui, top + 1 + HEAD_H / 2, 9);
  ui.text.draw(dl, 'LINES', x0, hy, 9, W.semibold, C.sectionInk, 0, 0.1, 1);
  ui.text.draw(dl, 'BASE', x0 + OCT_VAL_X, hy, 9, W.semibold, C.sectionInk, 1, 0.1, 1);
  ui.text.draw(dl, 'RAND', x0 + (MODE_X + CNT_X + CNT_W) / 2, hy, 9, W.semibold, C.sectionInk, 1, 0.1, 1);
  ui.text.draw(dl, 'LEVEL', x0 + LVOL_X + LVOL_W / 2, hy, 9, W.semibold, C.sectionInk, 1, 0.1, 1);
  const soloing = seqAnySolo();
  let ry = top + 1 + HEAD_H;
  for (let i = 0; i < SEQ_COUNT; i++) {
    const q = S.seqs[i];
    const fh = foldA[i] * FOLD_H;
    if (!q) { ry += ROW_H + fh + ROW_GAP; continue; }
    const cy = ry + ROW_H / 2;
    const active = (S.seqSlot | 0) === i;
    if (active) dl.rect(x0 - 5, ry, LINES_W + 10, ROW_H, 5, C.rowActive, 1, C.rowActiveBorder, 0, 0);
    const outerOver = overBtn;
    overBtn = false;
    let moved = false;

    // the name, brighter on a step where this line sounds a note, dim while
    // its own mute or another line's solo holds it
    const silenced = seqGate(q, soloing) === 0;
    const len = Math.max(1, Math.min(SEQ_MAX, q.len | 0));
    const sounding = clock >= 0 && !silenced && q.vol > 0 && q.steps[clock % len] >= 0;
    ui.text.draw(dl, LINE_LABELS[i], x0 + 1, baseline(ui, cy, 10), 10, W.semibold,
      sounding ? C.valueInk : silenced ? C.labelDim : C.label, 0, 0, 1);

    const by = cy - LINE_BTN_H / 2;
    if (btnAt(ui, ui.idx('seq.mute', i), x0 + M_X, by, MS_W, LINE_BTN_H)) { q.mute = !q.mute; moved = true; }
    drawMs(ui, x0 + M_X, cy, MS_W, LINE_BTN_H, !!q.mute, true, 'M');
    if (btnAt(ui, ui.idx('seq.solo', i), x0 + S_X, by, MS_W, LINE_BTN_H)) { q.solo = !q.solo; moved = true; }
    drawMs(ui, x0 + S_X, cy, MS_W, LINE_BTN_H, !!q.solo, false, 'S');

    // the waveform, cycling sine, triangle, saw, square
    if (btnAt(ui, ui.idx('seq.wave', i), x0 + WAVE_X, by, WAVE_W, LINE_BTN_H)) {
      const w = SEQ_WAVES.indexOf(q.wave);
      q.wave = SEQ_WAVES[(w + 1) % SEQ_WAVES.length];
      moved = true;
    }
    drawBtn(ui, x0 + WAVE_X, cy, WAVE_W, LINE_BTN_H, false, WAVE_SHORT[q.wave] || 'sin', 10);

    // its octave and octave randomization
    if (drawStripPitch(ui, q, i, x0, cy)) moved = true;

    // the line's level, the title bar's slider in small: a press jumps it
    // there and dragging follows, over the whole 0 to 100%, its value beside
    const vx = x0 + LVOL_X;
    ui.interact(ui.idx('seq.lvol', i), vx - 6, cy - 9, LVOL_W + 12, 18, false);
    const vHover = ui.hover || ui.pressed;
    if (vHover) { ui.setCursorHint('ew-resize'); overBtn = true; }
    if (ui.pressed) {
      const nv = Math.round(Math.max(0, Math.min(1, (ui.pointerX - vx) / LVOL_W)) * 100) / 100;
      if (nv !== q.vol) { q.vol = nv; moved = true; }
    }
    const vu = Math.max(0, Math.min(1, +q.vol || 0));
    dl.rect(vx, cy - 1.5, LVOL_W, 3, 1.5, C.btnBorder, 0, null, 0, 0);
    dl.rect(vx, cy - 1.5, LVOL_W * vu, 3, 1.5, C.label, 0, null, 0, 0);
    const vk = vHover ? 6 : 5;
    dl.rect(vx + LVOL_W * vu - vk, cy - vk, vk * 2, vk * 2, vk, vHover ? C.btnOnInk : C.label, 0, null, 0, 0);
    ui.text.draw(dl, PCT[Math.round(vu * 100)], x0 + LVAL_X, baseline(ui, cy, 10), 10, W.regular, C.valueInk, 0, 0, 1);

    // the fold's chevron: down while shut, turning up as the fold opens
    const chx = x0 + CHEV_X;
    if (btnAt(ui, ui.idx('seq.fold', i), chx, by, CHEV_W, LINE_BTN_H)) toggleFold(i);
    dl.icon(ICON.CHEVRON, chx + (CHEV_W - CHEV_ICON) / 2, cy - CHEV_ICON / 2, CHEV_ICON, CHEV_ICON,
      btnHover ? C.valueInk : C.btnInk, 1.6, foldA[i] * Math.PI);

    // the rest of the strip makes this line the active one
    const overCtl = overBtn;
    ui.interact(ui.idx('seq.line', i), x0 - 5, ry, LINES_W + 10, ROW_H, false);
    const stripHover = ui.hover;
    if (stripHover && !overCtl && !active) ui.setCursorHint('pointer');
    if (ui.clicked && !active) { S.seqSlot = i; save(); }
    overBtn = false;

    // the fold, clipped to however far it is open, so a control past the
    // clip is neither seen nor pressed
    if (fh > 0.5) {
      const fy = ry + ROW_H;
      dl.pushClip(x0 - 5, fy, LINES_W + 10, fh);
      if (drawFold(ui, q, i, x0, fy)) moved = true;
      dl.popClip();
    }

    if (moved) { applySeqs(); save(); }
    overBtn = outerOver || overCtl || overBtn || (stripHover && !active);
    ry += ROW_H + fh + ROW_GAP;
  }
}

// One line's fold: its four rows on a faint ground, top at fy. Returns
// whether anything on the line moved.
function drawFold(ui, q, i, x0, fy) {
  const dl = ui.dl;
  let moved = false;
  dl.rect(x0 - 5, fy + 1, LINES_W + 10, FOLD_H - 2, 5, C.bar, 1, C.barLine, 0, 0);
  for (let r = 0; r < FOLD_ROWS; r++) {
    const cy = fy + FOLD_PAD + r * FOLD_ROW_H + FOLD_ROW_H / 2;
    ui.text.draw(dl, FOLD_NAMES[r], x0 + FOLD_NAME_X, baseline(ui, cy, 9), 9, W.semibold, C.sectionInk, 0, 0.1, 1);
    // the panels and their wires first, so names and knobs sit on them
    for (let j = 0; j < panelN[r]; j++) {
      const a = panelX[r * 4 + j * 2], b = panelX[r * 4 + j * 2 + 1];
      dl.rect(x0 + a, cy - PANEL_H / 2, b - a, PANEL_H, PANEL_R, C.panel, 1, C.panelBorder, 0, 0);
    }
    for (let j = 0; j < wireN[r]; j++) {
      const a = wireX[r * 8 + j * 2], b = wireX[r * 8 + j * 2 + 1];
      if (b > a) dl.rect(x0 + a, cy - 0.5, b - a, 1, 0, C.wire, 0, null, 0, 0);
    }
    const row = FOLD_KNOBS[r];
    for (let k = 0; k < row.length; k++) {
      if (lineKnob(ui, q, i, r * 8 + k, x0 + knobX[r * 6 + k], cy, row[k])) moved = true;
    }
    // ping pong, after the delay's knobs: on, each repeat takes the other
    // side from the last; off, the repeats stay in place, either side of
    // the line's pan by its spread
    if (r === FOLD_ROWS - 1) {
      const ping = q.dlyPing !== false;
      const bx = x0 + PING_X, lw = trackedW(ui, 'PING PONG');
      if (btnAt(ui, ui.idx('seq.ping', i), bx - 2, cy - 8, PING_BOX + 7 + lw, 16)) { q.dlyPing = !ping; moved = true; }
      dl.rect(bx, cy - PING_BOX / 2, PING_BOX, PING_BOX, 3, ping ? C.btnOnBg : C.btnBg, 1,
        ping ? C.btnOnBorder : btnHover ? C.btnBorderHover : C.btnBorder, 0, 0);
      if (ping) dl.icon(ICON.CHECK, bx + 1, cy - PING_BOX / 2 + 1, PING_BOX - 2, PING_BOX - 2, C.btnOnInk, 1.6, 0);
      ui.text.draw(dl, 'PING PONG', bx + PING_BOX + PING_LABEL_GAP, baseline(ui, cy, 8), 8, W.semibold,
        btnHover ? C.valueInk : C.sectionInk, 0, 0.08, 1);
    }
  }
  return moved;
}

// The line's pitch, on its strip: its own octave, a small stepper from -3
// to +3 over the global transpose, then its octave randomization, a mode
// cycling OFF, +, − and +/− (up, down, either way), and beside it the
// range, which cycles 1 to 4 and only answers a click while the mode is on.
// All of them are the strip's controls, so a click on one never makes the
// line the active one.
function drawStripPitch(ui, q, i, x0, cy) {
  const dl = ui.dl;
  let moved = false;
  const by = cy - LINE_BTN_H / 2;
  const oct = Math.max(-3, Math.min(3, Math.round(+q.oct || 0)));
  if (btnAt(ui, ui.idx('seq.octDn', i), x0 + OCT_DN_X, by, OCT_BTN_W, LINE_BTN_H) && oct > -3) { q.oct = oct - 1; moved = true; }
  drawBtn(ui, x0 + OCT_DN_X, cy, OCT_BTN_W, LINE_BTN_H, false, '−', 11);
  ui.text.draw(dl, OCT_BASE_LABELS[oct + 3], x0 + OCT_VAL_X, baseline(ui, cy, 10), 10, W.semibold, C.valueInk, 1, 0, 1);
  if (btnAt(ui, ui.idx('seq.octUp', i), x0 + OCT_UP_X, by, OCT_BTN_W, LINE_BTN_H) && oct < 3) { q.oct = oct + 1; moved = true; }
  drawBtn(ui, x0 + OCT_UP_X, cy, OCT_BTN_W, LINE_BTN_H, false, '+', 11);

  const mi = SEQ_OCT_MODES.indexOf(q.octMode), mode = mi < 0 ? 'off' : q.octMode;
  if (btnAt(ui, ui.idx('seq.octMode', i), x0 + MODE_X, by, MODE_W, LINE_BTN_H)) {
    q.octMode = SEQ_OCT_MODES[((mi < 0 ? 0 : mi) + 1) % SEQ_OCT_MODES.length];
    moved = true;
  }
  drawBtn(ui, x0 + MODE_X, cy, MODE_W, LINE_BTN_H, mode !== 'off', OCT_MODE_LABELS[mode], 10);
  const octs = Math.max(1, Math.min(4, q.octaves | 0));
  const labels = OCT_COUNT_LABELS[mode];
  if (mode !== 'off') {
    if (btnAt(ui, ui.idx('seq.octN', i), x0 + CNT_X, by, CNT_W, LINE_BTN_H)) { q.octaves = octs % 4 + 1; moved = true; }
    drawBtn(ui, x0 + CNT_X, cy, CNT_W, LINE_BTN_H, false, labels[Math.max(1, Math.min(4, q.octaves | 0)) - 1], 10);
  } else {
    btnHover = false;
    dl.pushAlpha(0.35);
    drawBtn(ui, x0 + CNT_X, cy, CNT_W, LINE_BTN_H, false, labels[octs - 1], 10);
    dl.popAlpha();
  }
  return moved;
}
