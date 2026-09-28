// The Journey window: a floating list of a journey's steps, in the
// sequencer's window style (ui/screens/sequencer.js), in a warm gold of its
// own so it reads as its own instrument.
//
// The steps run top to bottom, a row each: a play button that starts the
// walk at that step, STEP n and a short summary of what it holds, and an ×
// that deletes it. A click on a row anywhere off its controls selects the
// step for editing (core/journey.js): the step glides in, and from then on
// the drawer's changes are recorded into it, each recorded control wearing a
// gold dot in the drawer's gutter. A second click lets it go. While the walk
// plays, a click only opens the step's fold, and the walk carries on. The
// selected step folds open beneath its row with its own fields: HOLD and RAMP
// on one line, then TEXT, FADE IN and FADE OUT on one line (how long the
// text takes to arrive and leave: the drawer's own two fade times, recorded
// into the step when moved, and shown dim at the interface's own while it
// holds none), GAP (the Phrase gap between the text's phrases, the same way,
// or Auto), APPEAR (when in the ramp the text first shows), PIANO and
// INTERACTION, and a chip that clears every recorded setting. A row
// pressed and dragged past a few px lifts and moves, an insertion bar marking
// where it will land, as the drawer's preset chips do in their edit mode.
// The title bar plays and pauses the walk, steps it back and on by hand,
// switches AUTO, which moves on by itself once a step's ramp and hold have
// passed, and LOOP, which takes an auto walk from the last step round to the
// first. Neither switch ever stops or restarts the step playing.
//
// Everything a step holds lives in the journey record (core/journey.js),
// never on S; the window keeps only where it sits and whether it is open,
// with the UI record (saveUiState), as the sequencer does.
import {
  journeySetWindowOpen, journeyVersion, journeyCount, journeyStepAt, journeyOverrideCount,
  journeySelected, journeyPlaying, journeyPlayIdx, journeyAutoPlay, journeyProgress,
  journeySelect, journeyAddStep, journeyDeleteStep, journeyMoveStep, journeyPlayFrom, journeyPause,
  journeyTogglePlay, journeyStepBy, journeySetAutoPlay, journeySetRamp, journeySetHold, journeySetText,
  journeySetPiano, journeySetAppear, journeyClearOverrides, journeyLoop, journeySetLoop,
  journeySetOverride,
  RAMP_MIN, RAMP_MAX, HOLD_MIN, HOLD_MAX, STEP_TEXT_MAX
} from '../../core/journey.js';
import { S } from '../../../js/state.js';
import { byId } from '../../core/schema.js';
import { loadUiState, saveUiState } from '../../core/store.js';
import { makeTextState, TEXT_COMMIT, TEXT_EDITING } from '../widgets.js';
import { W, MOTION } from '../theme.js';
import { ICON } from '../drawlist.js';

// ---------- colours: the sequencer's pane, and a gold for the journey ----------
function css(hex, a) {
  const n = parseInt(hex.slice(1, 7), 16), v = new Float32Array(4);
  v[0] = (n >> 16 & 255) / 255; v[1] = (n >> 8 & 255) / 255; v[2] = (n & 255) / 255;
  v[3] = a !== undefined ? a : 1;
  return v;
}
const GOLD = '#d2b356', GOLD_DEEP = '#b8963c', GOLD_HI = '#ecd28a';
// The drawer's override dot wears the same gold, so a dot and this window
// read as one thing.
export const JOURNEY_ACCENT = css(GOLD);
const C = {
  pane: css('#1a222c'), paneBorder: css('#2c3742'), bar: css('#171e27'), barLine: css('#29313b'),
  title: css('#bac5d1'),
  lightOff: css('#3d3a2e'), lightOn: css(GOLD_HI), lightGlow: css(GOLD, 0.32), lightPaused: css(GOLD_DEEP, 0.7),
  btnBg: css('#121820'), btnBorder: css('#222a33'), btnBorderHover: css('#3a4551'), btnInk: css('#8e9aaa'),
  btnOnBg: css('#302917'), btnOnBorder: css(GOLD_DEEP), btnOnInk: css('#f3e6bd'),
  powerInk: css(GOLD_HI), powerBorder: css('#6b5a2c'),
  closeHoverInk: css('#ff8a8a'), closeHoverBorder: css('#5a3a3a'),
  label: css(GOLD), labelDim: css('#5f6c7c'),
  sectionInk: css('#5f6c7c'), valueInk: css('#d6e0e8'), summaryInk: css('#8e9aaa'),
  // the rows: the selected one's ground, the one the walk is on, the one
  // lifted in a drag
  rowActive: css(GOLD, 0.1), rowActiveBorder: css(GOLD, 0.42),
  rowLit: css(GOLD, 0.2), rowLitBorder: css(GOLD_HI, 0.85), rowPaused: css(GOLD, 0.3),
  rowHover: css('#ffffff', 0.03), rowLift: css('#232c37'),
  // the rows' own text, a third brighter than the fold's inks (valueInk and
  // summaryInk × 1.33) so the list reads first; a selected or playing row's
  // STEP n in the bright gold, so it keeps its lead over the white
  rowInk: css('#ffffff'), rowSummaryInk: css('#bdcde2'), rowLabelOn: css(GOLD_HI),
  // the playing row's timeline, dimmer while AUTO is off (it fills, then
  // waits full for the arrows)
  progress: css(GOLD_HI, 0.9), progressIdle: css(GOLD_HI, 0.4), progressTrack: css(GOLD, 0.14),
  // LOOP lit: the sequencer window's green (ui/screens/sequencer.js), not
  // the journey's gold, so it reads as on at a glance
  loopOnBg: css('#62d7aa', 0.12), loopOnBorder: css('#365e50'), loopOnInk: css('#64d8ad'),
  // the fold's ground and the add chip
  field: css('#121820'), fieldBorder: css('#2a3440'), placeholder: css('#5f6c7c')
};

// ---------- sizes ----------
const RADIUS_WIN = 9, BAR_H = 33, PAD = 12;
// (a button stands as tall as the title bar's boxes, so the bar reads level)
const BTN_H = 22, CLOSE_H = 22, BTN_PAD_X = 9, CLOSE_PAD_X = 7, BAR_GAP = 9;
const BOX = 22, ICON_S = 18, CHEV_S = 13, SLOP = 4, ARROW_GAP = 4;
// sized for reading, not density: the rows and folds have room to breathe
const WIN_W = 506, CONTENT_W = WIN_W - PAD * 2;
const LIST_TOP = 8, ROW_H = 30, ROW_GAP = 4;
// a row: its play box, STEP n, the summary from one column, the ×
// (SUM_X clears "STEP 12" at 12 pt with the same air it had at 10)
const RPLAY = 20, STEP_X = 28, SUM_X = 92, DEL_W = 20;
// the fold under the selected row: HOLD and RAMP share the first line, hold
// first since it is the one auto-play lives by; TEXT gets a taller line for
// its field; then FADE IN and FADE OUT sharing a line, GAP, APPEAR, PIANO and
// INTERACTION, six plain lines in all
const FOLD_ROW_H = 32, FOLD_PAD = 5;
const FIELD_H = 34, TEXT_ROW_H = FIELD_H + 8;
const FOLD_H = FOLD_ROW_H * 6 + TEXT_ROW_H + FOLD_PAD * 2;
// the controls start clear of INTERACTION, the longest name; VAL_W holds the
// widest readout ("4m 55s") at 11 pt
const FOLD_NAME_X = 8, FOLD_CTL_X = 100, VAL_W = 48;
// hold and ramp side by side: each a name, a slider and its value, the pair
// parting at the fold's midline
const HR_SLIDER_X = 50, HR_NAME_W = 44, HR_GAP = 10;
// fade in and out the same way, their longer names ("FADE OUT" at 10 pt)
// pushing the sliders on a little
const FADE_SLIDER_X = 64, FADE_NAME_W = 68;
// a three-way line's button, wide enough for "Beginning" at 11 pt
const SEG_W = 74;
const ADD_GAP = 8, ADD_H = 30;
const DRAG_SLOP = 4;
// LOOP's button, square to AUTO's height, and the glyph inside it
const LOOP_W = 26, LOOP_ICON = 14, LOOP_GAP = 4;
const FOLD_NAMES = ['HOLD', 'TEXT', 'FADE IN', 'GAP', 'APPEAR', 'PIANO', 'INTERACTION'];
// The FADE line's two drawer controls (core/schema-visual.js), in ms; their
// range and step are the controls' own. A step holds them as overrides like
// any drawer setting. GAP's line is the Phrase gap the same way, in seconds,
// its far left Auto.
const FADE_IN = byId('textFadeIn'), FADE_OUT = byId('textFadeOut');
const GAP = byId('textPhraseGap');
// the two three-way lines' values, labels and button ids, made once
const APPEAR_VALUES = ['start', 'mid', 'end'], APPEAR_LABELS = ['Beginning', 'Middle', 'End'];
const APPEAR_IDS = ['jr.aStart', 'jr.aMid', 'jr.aEnd'];
const PIANO_VALUES = ['free', 'text', 'mixed'], PIANO_LABELS = ['Free', 'On text', 'Mixed'];
const PIANO_IDS = ['jr.pFree', 'jr.pText', 'jr.pMixed'];

export const journey = { open: false, placed: false, x: 0, y: 0, dragging: false, grabX: 0, grabY: 0,
  rx: 0, ry: 0, rw: 0, rh: 0 };   // where it was drawn last frame (rw 0: not showing), for stacking

// ---------- persistence of the window, as the sequencer's ----------
let restored = false;
const saved = { open: false, placed: false, x: 0, y: 0 };
function restore() {
  restored = true;
  const all = loadUiState();
  const m = all && all.journeyWin && typeof all.journeyWin === 'object' ? all.journeyWin : null;
  if (m) {
    journey.open = !!m.open;
    if (m.placed && Number.isFinite(m.x) && Number.isFinite(m.y)) { journey.placed = true; journey.x = m.x; journey.y = m.y; }
  }
  remember();
}
function remember() {
  saved.open = journey.open; saved.placed = journey.placed;
  saved.x = Math.round(journey.x); saved.y = Math.round(journey.y);
}
function persist() {
  if (journey.dragging) return;
  if (saved.open === journey.open && saved.placed === journey.placed &&
      saved.x === Math.round(journey.x) && saved.y === Math.round(journey.y)) return;
  remember();
  saveUiState({ journeyWin: { open: saved.open, placed: saved.placed, x: saved.x, y: saved.y } });
}

const lm = { ascent: 0, descent: 0 };
function baseline(ui, cy, size) {
  ui.text.lineMetrics(size, lm);
  return cy + (lm.ascent - lm.descent) / 2;
}

// A button: returns true on click, and leaves its hover in btnHover for the
// caller's styling. Buttons keep the pointer off the title bar's drag and
// off a row's own press.
let btnHover = false, overBtn = false;
function btn(ui, name, x, y, w, h) { return btnAt(ui, ui.id(name), x, y, w, h); }
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
// A small name's drawn width: measure() knows nothing of tracking, so the
// em between letters is added by hand.
const trackedW = (ui, t, size, track) => ui.text.measure(t, size, W.semibold) + track * size * (t.length - 1);

// ---------- readouts ----------
// Every string a row or fold prints, rebuilt only when the journey's version
// moves (an edit, a recorded setting, another tab's write), never per frame.
let sumVersion = -1;
let stepLabels = [], summaries = [], rampTexts = [], holdTexts = [], countTexts = [];
function fmtRamp(v) { return v <= 0 ? 'cut' : (v % 1 ? v.toFixed(1) : String(v)) + ' s'; }
function fmtHold(v) {
  if (v < 60) return Math.round(v) + ' s';
  const m = Math.floor(v / 60), s = Math.round(v - m * 60);
  return s ? m + 'm ' + s + 's' : m + ' min';
}
// A fade time in seconds, from its control's ms. Made once per value and
// kept, since a fade the step does not hold follows the interface and may
// move any frame; the controls' steps keep the set small, and it is cleared
// should it ever grow past a few hundred.
const fadeTexts = new Map();
function fmtFade(ms) {
  let t = fadeTexts.get(ms);
  if (t === undefined) {
    if (fadeTexts.size > 400) fadeTexts.clear();
    t = String(+(ms / 1000).toFixed(2)) + ' s';
    fadeTexts.set(ms, t);
  }
  return t;
}
// The Phrase gap's readout: 'auto' at its far left, else its seconds, from
// the same kept strings as the fades.
function fmtGap(s) { return s < 0 ? 'auto' : fmtFade(Math.round(s * 1000)); }
// The first phrase of a step's text, a few words at most, for its summary.
// Phrases part at '|'; a '/' line break inside one reads as a space here.
function firstWords(t) {
  let p = t.split('|')[0].replace(/\s*\/\s*/g, ' ').trim();
  const w = p.split(' ');
  if (w.length > 4) p = w.slice(0, 4).join(' ') + '…';
  if (p.length > 26) p = p.slice(0, 25) + '…';
  return p;
}
function refreshTexts() {
  const v = journeyVersion();
  if (v === sumVersion) return;
  sumVersion = v;
  const n = journeyCount();
  for (let i = 0; i < n; i++) {
    const st = journeyStepAt(i), k = journeyOverrideCount(i);
    if (stepLabels.length <= i) stepLabels.push('STEP ' + (i + 1));
    const count = k === 1 ? '1 setting' : k + ' settings';
    rampTexts[i] = fmtRamp(st.rampS);
    holdTexts[i] = fmtHold(st.holdS);
    countTexts[i] = count;
    summaries[i] = (st.text ? '“' + firstWords(st.text) + '” · ' : '') +
      count + ' · hold ' + holdTexts[i] + ' · ramp ' + rampTexts[i];
  }
  summaries.length = n; rampTexts.length = n; holdTexts.length = n; countTexts.length = n;
}

// ---------- per-frame layout, in typed arrays grown only when steps are added ----------
let cap = 0, foldA = new Float32Array(0), rowTop = new Float32Array(0), rowBot = new Float32Array(0);
function ensureCap(n) {
  if (n <= cap) return;
  cap = n + 8;
  foldA = new Float32Array(cap); rowTop = new Float32Array(cap); rowBot = new Float32Array(cap);
}

// The row being dragged: which one, whether it has moved past the slop yet,
// where the press began and where on the row it was taken, and where it
// would land (0..n, in the list as drawn).
const drag = { k: -1, moved: false, sx: 0, sy: 0, oy: 0, ins: -1 };

// The step's text, typed in its fold. One field at a time, so one state,
// with the step it belongs to.
const textEdit = makeTextState(STEP_TEXT_MAX, 'Phrases separated by |, a / breaks a line');
let textIdx = -1;

// A small horizontal slider (the sequencer's rate slider): a press jumps it
// there and dragging follows. Returns the new place 0..1 while pressed, or
// -1 when untouched.
function hslider(ui, id, x, cy, w, u) {
  ui.interact(id, x - 6, cy - 9, w + 12, 18, false);
  const lit = ui.hover || ui.pressed;
  if (lit) { ui.setCursorHint('ew-resize'); overBtn = true; }
  let nu = -1;
  if (ui.pressed) nu = Math.max(0, Math.min(1, (ui.pointerX - x) / w));
  const s = nu >= 0 ? nu : u;
  const dl = ui.dl;
  dl.rect(x, cy - 1.5, w, 3, 1.5, C.btnBorder, 0, null, 0, 0);
  dl.rect(x, cy - 1.5, w * s, 3, 1.5, C.label, 0, null, 0, 0);
  const kr = lit ? 6 : 5;
  dl.rect(x + w * s - kr, cy - kr, kr * 2, kr * 2, kr, lit ? C.btnOnInk : C.label, 0, null, 0, 0);
  return nu;
}
// HOLD turns in the logarithm of its time, so a few seconds get as much
// travel as several minutes, and lands on whole seconds under a minute,
// fives under five minutes, tens above.
const HOLD_LN = Math.log(HOLD_MAX / HOLD_MIN);
const holdToU = v => Math.log(v / HOLD_MIN) / HOLD_LN;
function uToHold(u) {
  const v = HOLD_MIN * Math.exp(u * HOLD_LN);
  return v < 60 ? Math.round(v) : v < 300 ? Math.round(v / 5) * 5 : Math.round(v / 10) * 10;
}

// fade is the chrome's idle fade, as the sequencer's.
export function drawJourney(ui, app, fade = 1) {
  if (!restored) restore();
  persist();
  journeySetWindowOpen(journey.open);
  const open = ui.spring('jr.open', journey.open ? 1 : 0, MOTION.panel);
  const o = open * fade;
  if (o < 0.002) { journey.rw = 0; return; }
  ui.pushScope(ui.id('jr'));
  refreshTexts();

  const n = journeyCount();
  ensureCap(n);
  const sel = journeySelected();
  // Each step's fold opens on a spring of its own, and the window is as
  // tall as the folds are open, so it grows and shrinks with them.
  let folds = 0;
  for (let i = 0; i < n; i++) {
    foldA[i] = ui.spring(ui.idx('jr.foldA', i), i === sel ? 1 : 0, MOTION.panel);
    folds += foldA[i] * FOLD_H;
  }
  const width = app.width, height = app.height;
  const winW = Math.min(WIN_W, width - 24);
  const h = BAR_H + 1 + LIST_TOP + n * (ROW_H + ROW_GAP) + folds + (n ? ADD_GAP - ROW_GAP : 0) + ADD_H + PAD;
  // first showing: the upper right, clear of the sequencer's usual place
  if (!journey.placed) { journey.placed = true; journey.x = Math.max(12, width - winW - 24); journey.y = 24; }
  journey.x = Math.max(12 - winW + 80, Math.min(journey.x, width - 80));
  journey.y = Math.max(12, Math.min(journey.y, height - BAR_H - 12));
  const x = journey.x, y = journey.y + (1 - open) * 16;
  journey.rx = x; journey.ry = y; journey.rw = winW; journey.rh = h;
  const dl = ui.dl;

  dl.pushAlpha(o * 0.9);
  overBtn = false;

  // ---- pane and header ----
  dl.rect(x, y, winW, h, RADIUS_WIN, C.pane, 1, C.paneBorder, 10, 0.35);
  dl.pushClip(x + 1, y + 1, winW - 2, BAR_H - 1);
  dl.rect(x + 1, y + 1, winW - 2, BAR_H + RADIUS_WIN, RADIUS_WIN - 1, C.bar, 0, null, 0, 0);
  dl.popClip();
  dl.rect(x + 1, y + BAR_H, winW - 2, 1, 0, C.barLine, 0, null, 0, 0);
  const cy = y + 1 + (BAR_H - 1) / 2;
  const playing = journeyPlaying(), playIdx = journeyPlayIdx();

  // the light: lit while the walk plays, a dim gold while it is paused on a
  // step, dark when stopped
  const lightX = x + 1 + 13;
  if (playing) {
    dl.rect(lightX - 3, cy - 6, 12, 12, 6, C.lightGlow, 0, null, 0, 0);
    dl.rect(lightX, cy - 3, 6, 6, 3, C.lightOn, 0, null, 0, 0);
  } else {
    dl.rect(lightX, cy - 3, 6, 6, 3, playIdx >= 0 ? C.lightPaused : C.lightOff, 0, null, 0, 0);
  }
  ui.text.draw(dl, 'JOURNEY', lightX + 6 + BAR_GAP, baseline(ui, cy, 13), 13, W.semibold, C.title, 0, 0.13, 1);

  // play and pause, then the two arrows, then AUTO, each claimed before the
  // title bar's drag so a press on one never moves the window
  const playX = lightX + 6 + BAR_GAP + trackedW(ui, 'JOURNEY', 13, 0.13) + 8;
  if (btn(ui, 'jr.play', playX - SLOP, cy - BOX / 2 - SLOP, BOX + SLOP * 2, BOX + SLOP * 2)) journeyTogglePlay();
  dl.rect(playX, cy - BOX / 2, BOX, BOX, 6, C.btnBg, 1,
    playing ? C.powerBorder : btnHover ? C.btnBorderHover : C.btnBorder, 0, 0);
  dl.icon(playing ? ICON.PAUSE : ICON.PLAY, playX + (BOX - ICON_S) / 2, cy - ICON_S / 2, ICON_S, ICON_S,
    btnHover ? C.valueInk : playing ? C.powerInk : C.btnInk, 2.2, 0);

  const backX = playX + BOX + 10, nextX = backX + BOX + ARROW_GAP;
  const dim = n === 0;
  if (dim) dl.pushAlpha(0.4);
  if (btn(ui, 'jr.back', backX, cy - BOX / 2, BOX, BOX) && !dim) journeyStepBy(-1);
  dl.rect(backX, cy - BOX / 2, BOX, BOX, 6, C.btnBg, 1, btnHover && !dim ? C.btnBorderHover : C.btnBorder, 0, 0);
  // the chevron points down unturned; a quarter turn one way points it
  // left, the other way right
  dl.icon(ICON.CHEVRON, backX + (BOX - CHEV_S) / 2, cy - CHEV_S / 2, CHEV_S, CHEV_S,
    btnHover && !dim ? C.valueInk : C.btnInk, 1.8, Math.PI / 2);
  if (btn(ui, 'jr.next', nextX, cy - BOX / 2, BOX, BOX) && !dim) journeyStepBy(1);
  dl.rect(nextX, cy - BOX / 2, BOX, BOX, 6, C.btnBg, 1, btnHover && !dim ? C.btnBorderHover : C.btnBorder, 0, 0);
  dl.icon(ICON.CHEVRON, nextX + (BOX - CHEV_S) / 2, cy - CHEV_S / 2, CHEV_S, CHEV_S,
    btnHover && !dim ? C.valueInk : C.btnInk, 1.8, -Math.PI / 2);
  if (dim) dl.popAlpha();

  const auto = journeyAutoPlay();
  const autoX = nextX + BOX + 10, autoW = measureBtn(ui, 'AUTO', 11);
  if (btn(ui, 'jr.auto', autoX, cy - BTN_H / 2, autoW, BTN_H)) journeySetAutoPlay(!auto);
  drawBtn(ui, autoX, cy, autoW, BTN_H, auto, 'AUTO', 11);

  // LOOP, right beside AUTO: dim ink off, the sequencer's green on
  const loop = journeyLoop();
  const loopX = autoX + autoW + LOOP_GAP;
  if (btn(ui, 'jr.loop', loopX, cy - BTN_H / 2, LOOP_W, BTN_H)) journeySetLoop(!loop);
  dl.rect(loopX, cy - BTN_H / 2, LOOP_W, BTN_H, 6, loop ? C.loopOnBg : C.btnBg, 1,
    loop ? C.loopOnBorder : btnHover ? C.btnBorderHover : C.btnBorder, 0, 0);
  dl.icon(ICON.LOOP, loopX + (LOOP_W - LOOP_ICON) / 2, cy - LOOP_ICON / 2, LOOP_ICON, LOOP_ICON,
    loop ? C.loopOnInk : btnHover ? C.valueInk : C.btnInk, 1.7, 0);

  const closeW = ui.text.measure('×', 18, W.regular) + CLOSE_PAD_X * 2 + 2;
  const closeX = x + winW - 1 - 8 - closeW;
  if (btn(ui, 'jr.close', closeX, cy - CLOSE_H / 2, closeW, CLOSE_H)) journey.open = false;
  dl.rect(closeX, cy - CLOSE_H / 2, closeW, CLOSE_H, 6, C.btnBg, 1, btnHover ? C.closeHoverBorder : C.btnBorder, 0, 0);
  ui.text.draw(dl, '×', closeX + closeW / 2, baseline(ui, cy, 18), 18, W.regular, btnHover ? C.closeHoverInk : C.btnInk, 1, 0, 1);

  // ---- the steps ----
  // (the list's foot is taken from the layout, not from drawSteps, which
  // stops early on the frame a row is deleted or moved)
  const listY = y + BAR_H + 1 + LIST_TOP;
  drawSteps(ui, x, listY, n, sel, playing, playIdx);
  const endY = listY + n * (ROW_H + ROW_GAP) + folds;

  // ---- + Add step, full width under the list ----
  {
    const ax = x + PAD, ay = endY + (n ? ADD_GAP - ROW_GAP : 0), aw = winW - PAD * 2;
    if (btn(ui, 'jr.add', ax, ay, aw, ADD_H)) journeyAddStep();
    dl.rect(ax, ay, aw, ADD_H, 6, btnHover ? C.rowActive : C.btnBg, 1, btnHover ? C.rowActiveBorder : C.btnBorder, 0, 0);
    ui.text.draw(dl, '+  Add step', ax + aw / 2, baseline(ui, ay + ADD_H / 2, 12), 12, W.regular,
      btnHover ? C.btnOnInk : C.btnInk, 1, 0.04, 1);
  }

  // the lifted row, riding the pointer over everything else
  if (drag.k >= 0 && drag.moved && drag.k < n) drawLifted(ui, x, n);

  // ---- title bar drag, the offset taken on press so the window does not jump ----
  ui.interact(ui.id('jr.drag'), x, y, winW, BAR_H, false);
  if (ui.pressed) {
    if (!journey.dragging) { journey.dragging = true; journey.grabX = ui.pointerX - journey.x; journey.grabY = ui.pointerY - journey.y; }
    journey.x = ui.pointerX - journey.grabX; journey.y = ui.pointerY - journey.grabY;
    ui.setCursorHint('grabbing');
  } else {
    journey.dragging = false;
    if (ui.hover && !overBtn) ui.setCursorHint('grab');
  }

  // clicks on empty pane stop here instead of reaching the drawer or field
  ui.interact(ui.id('jr.backstop'), x, y, winW, h, false);
  dl.popAlpha();
  ui.popScope();
}

// The rows, top at y, each followed by its fold as far as the fold is open.
// A row's own controls (its play button and its ×) are claimed first, then
// the row itself, so a press anywhere else on it selects or drags. A delete
// or a move changes the list mid-build, so the rest of the rows wait for the
// next frame.
function drawSteps(ui, x, y, n, sel, playing, playIdx) {
  const dl = ui.dl, x0 = x + PAD, rowX = x0 - 5, rowW = CONTENT_W + 10;
  const prog = journeyProgress(), progInk = journeyAutoPlay() ? C.progress : C.progressIdle;
  let ry = y;
  for (let i = 0; i < n; i++) {
    const cyr = ry + ROW_H / 2;
    const fh = foldA[i] * FOLD_H;
    rowTop[i] = ry; rowBot[i] = ry + ROW_H + fh;
    const selected = i === sel, onIt = i === playIdx, lit = onIt && playing;
    const lifted = drag.k === i && drag.moved;
    if (lifted) dl.pushAlpha(0.3);
    if (lit) dl.rect(rowX, ry, rowW, ROW_H, 5, C.rowLit, 1, C.rowLitBorder, 0, 0);
    else if (selected) dl.rect(rowX, ry, rowW, ROW_H, 5, C.rowActive, 1, C.rowActiveBorder, 0, 0);
    else if (onIt) dl.rect(rowX, ry, rowW, ROW_H, 5, C.rowActive, 1, C.rowPaused, 0, 0);
    // a thin bar along the playing row's foot fills over its ramp and hold,
    // AUTO on or off, so switching AUTO never looks like the step stopping
    if (lit && prog >= 0) {
      dl.rect(rowX + 4, ry + ROW_H - 3, rowW - 8, 2, 1, C.progressTrack, 0, null, 0, 0);
      dl.rect(rowX + 4, ry + ROW_H - 3, (rowW - 8) * prog, 2, 1, progInk, 0, null, 0, 0);
    }
    const outerOver = overBtn;
    overBtn = false;
    let changed = false;

    // play at this step (or pause, on the step the walk is playing)
    const pby = cyr - RPLAY / 2;
    if (btnAt(ui, ui.idx('jr.rowPlay', i), x0 - 2, pby - 2, RPLAY + 4, RPLAY + 4)) {
      if (lit) journeyPause(); else journeyPlayFrom(i);
    }
    dl.rect(x0, pby, RPLAY, RPLAY, 5, C.btnBg, 1, btnHover ? C.btnBorderHover : lit ? C.powerBorder : C.btnBorder, 0, 0);
    dl.icon(lit ? ICON.PAUSE : ICON.PLAY, x0 + 2, pby + 2, RPLAY - 4, RPLAY - 4,
      btnHover ? C.valueInk : lit ? C.powerInk : C.btnInk, 2.2, 0);

    ui.text.draw(dl, stepLabels[i], x0 + STEP_X, baseline(ui, cyr, 12), 12, W.semibold,
      lit || selected ? C.rowLabelOn : C.rowInk, 0, 0.08, 1);
    const sx = x0 + SUM_X, sw = CONTENT_W - SUM_X - DEL_W - 8;
    dl.pushClip(sx, ry, sw, ROW_H);
    ui.text.draw(dl, summaries[i], sx, baseline(ui, cyr, 12), 12, W.regular, C.rowSummaryInk, 0, 0, 1);
    dl.popClip();

    // the ×, which deletes the step outright
    const dx = x0 + CONTENT_W - DEL_W;
    if (btnAt(ui, ui.idx('jr.rowDel', i), dx, cyr - DEL_W / 2, DEL_W, DEL_W)) { journeyDeleteStep(i); changed = true; }
    ui.text.draw(dl, '×', dx + DEL_W / 2, baseline(ui, cyr, 15), 15, W.regular, btnHover ? C.closeHoverInk : C.labelDim, 1, 0, 1);

    // the rest of the row: a click selects, a press dragged past the slop
    // lifts it
    const overCtl = overBtn;
    const rid = ui.idx('jr.row', i);
    if (!changed) {
      ui.interact(rid, rowX, ry, rowW, ROW_H, false);
      const hover = ui.hover && !overCtl;
      if (hover && !selected && !lit && drag.k < 0) dl.rect(rowX, ry, rowW, ROW_H, 5, C.rowHover, 0, null, 0, 0);
      if (hover) ui.setCursorHint(drag.k === i && drag.moved ? 'grabbing' : 'pointer');
      if (ui.pressed && ui.activeId === rid) {
        if (drag.k !== i) {
          drag.k = i; drag.moved = false; drag.sx = ui.pointerX; drag.sy = ui.pointerY;
          drag.oy = ui.pointerY - ry; drag.ins = -1;
        } else if (!drag.moved && Math.abs(ui.pointerX - drag.sx) + Math.abs(ui.pointerY - drag.sy) > DRAG_SLOP) drag.moved = true;
        if (drag.moved) ui.setCursorHint('grabbing');
      } else if (drag.k === i) {
        // released: a real drag lands it where the bar was, and a plain
        // click (never past the slop) selects it, or lets it go
        const moved = drag.moved, ins = drag.ins, clicked = ui.clicked;
        drag.k = -1; drag.moved = false;
        if (moved && ins >= 0) {
          const to = ins > i ? ins - 1 : ins;
          if (to !== i) { journeyMoveStep(i, to); changed = true; }
        } else if (!moved && clicked) journeySelect(i);
      }
    }
    if (lifted) dl.popAlpha();
    overBtn = outerOver || overCtl;
    if (changed) return;

    // the fold, clipped to however far it is open, so a control past the
    // clip is neither seen nor pressed
    if (fh > 0.5) {
      const fy = ry + ROW_H;
      dl.pushClip(rowX, fy, rowW, fh);
      drawFold(ui, i, x0, fy);
      dl.popClip();
    }
    ry += ROW_H + fh + ROW_GAP;
  }
  // a drag whose row is gone (deleted, or the list changed under it) ends
  if (drag.k >= n) { drag.k = -1; drag.moved = false; }
}

// Where a dragged row would land: before the first row whose middle is
// below the pointer, else after the last, kept as an insertion point in the
// list as drawn (0..n). Then the accent bar in that gap, and the row itself
// riding the pointer at the height it was taken.
function drawLifted(ui, x, n) {
  const dl = ui.dl, py = ui.pointerY;
  let ins = n;
  for (let k = 0; k < n; k++) {
    if (py < (rowTop[k] + rowTop[k] + ROW_H) / 2) { ins = k; break; }
  }
  drag.ins = ins;
  const rowX = x + PAD - 5, rowW = CONTENT_W + 10;
  const barY = ins < n ? rowTop[ins] - ROW_GAP / 2 : rowBot[n - 1] + ROW_GAP / 2;
  dl.rect(rowX, barY - 1, rowW, 2, 1, C.label, 0, null, 0, 0);
  const k = drag.k, ry = py - drag.oy, cyr = ry + ROW_H / 2, x0 = x + PAD;
  dl.pushAlpha(0.85);
  dl.rect(rowX, ry, rowW, ROW_H, 5, C.rowLift, 1, C.label, 8, 0.4);
  ui.text.draw(dl, stepLabels[k], x0 + STEP_X, baseline(ui, cyr, 12), 12, W.semibold, C.rowLabelOn, 0, 0.08, 1);
  dl.pushClip(x0 + SUM_X, ry, CONTENT_W - SUM_X - DEL_W - 8, ROW_H);
  ui.text.draw(dl, summaries[k], x0 + SUM_X, baseline(ui, cyr, 12), 12, W.regular, C.rowSummaryInk, 0, 0, 1);
  dl.popClip();
  dl.popAlpha();
}

// One step's fold: its seven lines on a faint ground, top at fy.
function drawFold(ui, i, x0, fy) {
  const dl = ui.dl, st = journeyStepAt(i);
  if (!st) return;
  dl.rect(x0 - 5, fy + 1, CONTENT_W + 10, FOLD_H - 2, 5, C.bar, 1, C.barLine, 0, 0);
  const cx = x0 + FOLD_CTL_X, right = x0 + CONTENT_W - 6, mid = x0 + CONTENT_W / 2;
  let ry = fy + FOLD_PAD;
  for (let r = 0; r < FOLD_NAMES.length; r++) {
    const rh = r === 1 ? TEXT_ROW_H : FOLD_ROW_H;
    const cy = ry + rh / 2;
    ry += rh;
    ui.text.draw(dl, FOLD_NAMES[r], x0 + FOLD_NAME_X, baseline(ui, cy, 10), 10, W.semibold, C.sectionInk, 0, 0.1, 1);
    if (r === 0) {
      // HOLD, 5 s to 10 min (log): how long auto-play stays once the ramp
      // is done, its value right-aligned just short of the midline
      const hx = x0 + HR_SLIDER_X, hw = mid - HR_GAP - VAL_W - hx;
      let u = hslider(ui, ui.idx('jr.hold', i), hx, cy, hw, holdToU(st.holdS));
      if (u >= 0) journeySetHold(i, uToHold(u));
      ui.text.draw(dl, holdTexts[i], mid - HR_GAP, baseline(ui, cy, 11), 11, W.regular, C.valueInk, 2, 0, 1);
      // RAMP beside it, 0 to 30 s in half seconds: how long the step's
      // settings glide in
      ui.text.draw(dl, 'RAMP', mid + HR_GAP, baseline(ui, cy, 10), 10, W.semibold, C.sectionInk, 0, 0.1, 1);
      const rx = mid + HR_GAP + HR_NAME_W, rw = right - VAL_W - rx;
      u = hslider(ui, ui.idx('jr.ramp', i), rx, cy, rw, (st.rampS - RAMP_MIN) / (RAMP_MAX - RAMP_MIN));
      if (u >= 0) journeySetRamp(i, Math.round((RAMP_MIN + u * (RAMP_MAX - RAMP_MIN)) * 2) / 2);
      ui.text.draw(dl, rampTexts[i], right, baseline(ui, cy, 11), 11, W.regular, C.valueInk, 2, 0, 1);
    } else if (r === 1) {
      // the field starts just past its short name, where the FADE sliders
      // start, not at the buttons' column, so it has the width for phrases
      const tx = x0 + FADE_SLIDER_X;
      drawTextField(ui, i, st, tx, cy, right - tx);
    } else if (r === 2) {
      // FADE IN and FADE OUT, laid out as HOLD and RAMP: how long the step's
      // words take to arrive and to leave
      fadeHalf(ui, ui.idx('jr.fadeIn', i), i, st, FADE_IN, x0 + FADE_SLIDER_X, mid - HR_GAP, cy, fmtFade);
      ui.text.draw(dl, 'FADE OUT', mid + HR_GAP, baseline(ui, cy, 10), 10, W.semibold, C.sectionInk, 0, 0.1, 1);
      fadeHalf(ui, ui.idx('jr.fadeOut', i), i, st, FADE_OUT, mid + HR_GAP + FADE_NAME_W, right, cy, fmtFade);
    } else if (r === 3) {
      // GAP: the time between one of the step's phrases leaving and the
      // next arriving, or Auto, the word scheduler's roll. Its own line, as
      // wide as FADE IN's half, since a third slider on the FADE line would
      // leave each too short to set by the half second.
      fadeHalf(ui, ui.idx('jr.gap', i), i, st, GAP, x0 + FADE_SLIDER_X, mid - HR_GAP, cy, fmtGap);
    } else if (r === 4) {
      // APPEAR: when in the ramp the step's text first shows, as the step
      // begins, halfway through, or as its settings land
      for (let k = 0; k < 3; k++) {
        const bx = cx + k * (SEG_W + 4), v = APPEAR_VALUES[k];
        if (btnAt(ui, ui.idx(APPEAR_IDS[k], i), bx, cy - BTN_H / 2, SEG_W, BTN_H)) journeySetAppear(i, v);
        drawBtn(ui, bx, cy, SEG_W, BTN_H, st.appear === v, APPEAR_LABELS[k], 11);
      }
    } else if (r === 5) {
      // PIANO: plays freely; only one gesture as each word appears, the free
      // player idle; or both, free play with a gesture on each word
      for (let k = 0; k < 3; k++) {
        const bx = cx + k * (SEG_W + 4), v = PIANO_VALUES[k];
        if (btnAt(ui, ui.idx(PIANO_IDS[k], i), bx, cy - BTN_H / 2, SEG_W, BTN_H)) journeySetPiano(i, v);
        drawBtn(ui, bx, cy, SEG_W, BTN_H, st.piano === v, PIANO_LABELS[k], 11);
      }
    } else {
      // INTERACTION: None is the only choice so far, shown and resting dim
      btnHover = false;
      dl.pushAlpha(0.45);
      drawBtn(ui, cx, cy, SEG_W, BTN_H, false, 'None', 11);
      dl.popAlpha();
      // and on the right, the recorded settings' count and the chip that
      // clears them all
      const k = journeyOverrideCount(i);
      const cw = measureBtn(ui, 'clear settings', 11), chipX = right - cw + 6;
      if (k > 0) {
        if (btnAt(ui, ui.idx('jr.clear', i), chipX, cy - BTN_H / 2, cw, BTN_H)) journeyClearOverrides(i);
        drawBtn(ui, chipX, cy, cw, BTN_H, false, 'clear settings', 11);
      } else {
        btnHover = false;
        dl.pushAlpha(0.35);
        drawBtn(ui, chipX, cy, cw, BTN_H, false, 'clear settings', 11);
        dl.popAlpha();
      }
      ui.text.draw(dl, countTexts[i], chipX - 8, baseline(ui, cy, 11), 11, W.regular,
        k > 0 ? C.label : C.labelDim, 2, 0, 1);
    }
  }
}

// One half of the FADE line (or the GAP line's one slider): a drawer
// control's slider from sx, its value, read by fmt, right-aligned at vx. The
// step's own position when it holds one; otherwise the interface's, drawn
// dim, since that is what the step will leave it at. Moving it records it
// into the step (core/journey.js, which also lands it at once when the step
// is the one on screen). The gap's half-second step can land on -0.5, which
// is Auto as -1 is, so it is recorded as -1, the one Auto its control keeps.
function fadeHalf(ui, id, i, st, c, sx, vx, cy, fmt) {
  if (!c) return;
  const own = st.overrides[c.id], v = own !== undefined ? own : c.get(S);
  if (typeof v !== 'number') return;
  const dl = ui.dl, span = c.max - c.min;
  if (own === undefined) dl.pushAlpha(0.45);
  const u = hslider(ui, id, sx, cy, vx - VAL_W - sx, span > 0 ? (v - c.min) / span : 0);
  ui.text.draw(dl, fmt(v), vx, baseline(ui, cy, 11), 11, W.regular, C.valueInk, 2, 0, 1);
  if (own === undefined) dl.popAlpha();
  if (u >= 0) {
    const raw = c.min + u * span;
    let nv = c.step > 0 ? Math.round(raw / c.step) * c.step : raw;
    if (c === GAP && nv < 0) nv = -1;
    journeySetOverride(i, c.id, nv);
  }
}

// TEXT: the step's own phrases, separated by '|', a '/' inside one breaking
// its line (core/words.js). Shown dim when empty (the words then carry on as
// the interface has them); a click opens a field in place, and Enter or a
// press elsewhere keeps it.
function drawTextField(ui, i, st, fx, cy, fw) {
  const dl = ui.dl, fy = cy - FIELD_H / 2;
  if (textEdit.active && textIdx === i) {
    const res = ui.textField('jr.text', fx, fy, fw, FIELD_H, textEdit, 13, 0, 5);
    if (res === TEXT_COMMIT) journeySetText(i, textEdit.text);
    if (res !== TEXT_EDITING) textIdx = -1;
    overBtn = true;
    return;
  }
  const id = ui.idx('jr.textBox', i);
  ui.interact(id, fx, fy, fw, FIELD_H, false);
  const hover = ui.hover;
  if (hover) { ui.setCursorHint('text'); overBtn = true; }
  if (ui.clicked) { textIdx = i; ui.textBegin(textEdit, st.text, false, false); }
  dl.rect(fx, fy, fw, FIELD_H, 5, C.field, 1, hover ? C.btnBorderHover : C.fieldBorder, 0, 0);
  dl.pushClip(fx + 5, fy, fw - 10, FIELD_H);
  if (st.text) ui.text.draw(dl, st.text, fx + 10, baseline(ui, cy, 13), 13, W.regular, C.valueInk, 0, 0, 1);
  else ui.text.draw(dl, 'empty: the words carry on as they are', fx + 10, baseline(ui, cy, 13), 13, W.regular, C.placeholder, 0, 0, 1);
  dl.popClip();
}
