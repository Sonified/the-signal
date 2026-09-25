// The Atmosphere mixer: v0's floating mixer window, redrawn on the GPU.
//
// v0 is the template, line for line: index.html's #ambMixerWindow for the
// structure, css/style.css's #ambMixer* and .amb-* rules for every size,
// colour and gap, and js/ambience-mixer.js for how it behaves. The window is
// a header bar (power light, title, drift, copy settings, on, close) over a
// body of compact one-line channel rows laid out on v0's six-column grid:
// the tone engine and the music as label, fader, value and a meter with its
// unit; the atmosphere recordings as source, mute, solo, fader, value and
// meter under a column header; then the atmosphere master and its reverb
// send. Every value goes through the schema control's
// own get, set and format, so presets, sync and the audio side effects stay
// exactly where they already live; only the drawing and the hand on the
// fader are this file's.
//
// The pane is v0's flat #1a222c at nearly full opacity rather than frosted
// glass. A mixer is read, not looked through, and a flat pane is one the
// strobe can never show through.
//
// In v0 dragging this window was one of the worst frame-droppers in the app,
// because moving a DOM element with a big shadow forced style, layout and a
// recomposite of everything under it. Here the window is a few hundred
// instances in a draw list; moving it changes two numbers. It lives on the
// top UI layer, built before the drawer so it wins the pointer wherever the
// two overlap.
import { S } from '../../../js/state.js';
import { byId } from '../../core/schema.js';
import {
  ambLayerControls, AMB_LAYER_COUNT, ambienceSourceName, meterCount, layerMeterCount,
  layerStatus
} from '../../core/atmosphere.js';
import { runAction, makeTextState, TEXT_EDITING, TEXT_COMMIT } from '../widgets.js';
import { ICON } from '../drawlist.js';
import { W, MOTION } from '../theme.js';
import { loadUiState, saveUiState } from '../../core/store.js';
import { anySolo, chanSilenced } from '../../../js/mixgate.js';

// ---------- v0's colours ----------
// Every one of these is a value from css/style.css, alpha included (a CSS
// #rrggbbaa's last pair over 255). Built once at load and never written.
function css(hex, a) {
  const n = parseInt(hex.slice(1, 7), 16), v = new Float32Array(4);
  v[0] = (n >> 16 & 255) / 255; v[1] = (n >> 8 & 255) / 255; v[2] = (n & 255) / 255;
  v[3] = a !== undefined ? a : hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
  return v;
}
function mixHex(a, b, t) {
  const na = parseInt(a.slice(1), 16), nb = parseInt(b.slice(1), 16), v = new Float32Array(4);
  for (let k = 0; k < 3; k++) {
    const sh = 16 - k * 8, ca = na >> sh & 255, cb = nb >> sh & 255;
    v[k] = (ca + (cb - ca) * t) / 255;
  }
  v[3] = 1;
  return v;
}

// The pane is fully opaque, and so are the row tints laid over it (v0's
// faint white washes, premixed onto the pane colour here), so nothing of the
// strobing field can show through anywhere in the window.
const C = {
  pane: css('#1a222c', 1), paneBorder: css('#2c3742'), paneHi: css('#ffffff0a'),
  title: css('#bac5d1'),
  barLine: css('#29313b'),
  lightOff: css('#35443d'), lightOn: css('#62d7aa'), lightGlow: css('#4ad9a0', 0.3),
  lightStop: css('#e0605a'), lightStopGlow: css('#e0605a', 0.3),
  btnBg: css('#121820'), btnBorder: css('#222a33'), btnBorderHover: css('#3a4551'), btnInk: css('#8e9aaa'),
  powerInk: css('#64d8ad'), powerBorder: css('#365e50'),
  driftInk: css('#eef4ff'), driftBorder: css('#7fb4ff'), driftTop: css('#3d7ef5'), driftBottom: css('#2a5cd0'),
  driftGlow: css('#4f8cff', 0.22), driftHi: css('#ffffff33'),
  copiedInk: css('#5adca1'), copiedBorder: css('#3f8f68'), copiedBg: css('#122318'),
  toastBg: css('#10211a'), toastBorder: css('#3f8f68'), toastInk: css('#7fe6b4'),
  closeHoverInk: css('#ff8a8a'), closeHoverBorder: css('#5a3a3a'),
  sectionInk: css('#5f6c7c'), faintLine: css('#ffffff08'),
  columnInk: css('#596574'),
  rowOdd: mixHex('#1a222c', '#ffffff', 2 / 255), rowHover: mixHex('#1a222c', '#ffffff', 5 / 255),
  rowLine: mixHex('#1a222c', '#ffffff', 4 / 255),
  layerInk: css('#98a5b5'), layerActive: css('#d6e0e8'), layerError: css('#ef9993'), layerLoading: css('#ccbb82'),
  msBg: mixHex('#202933', '#161d25', 0.5), msBorder: css('#303a45'), msInk: css('#758494'),
  muteBg: css('#9b3339'), muteBorder: css('#dc626a'), muteInk: css('#ffe7e7'), muteGlow: css('#c44449', 0.2),
  soloBg: css('#256846'), soloBorder: css('#58c98b'), soloInk: css('#d4ffe4'), soloGlow: css('#4ad98d', 0.2),
  valueInk: css('#8d9eaf'),
  strongLine: css('#303a45'), masterInk: css('#bac7d5'), unitInk: css('#526272'),
  statusInk: css('#657384'),
  trackBg: css('#070b10'), trackBorder: css('#070a0e'), trackFill: css('#657b87'), trackHi: css('#ffffff0c'),
  thumbBase: css('#394552'), thumbBorder: css('#090d12'),
  meterBg: css('#090d12'), meterBorder: css('#070b0e'),
  ledGreen: css('#17372c'), ledAmber: css('#39341b'), ledRed: css('#3b2023'),
  litGreen: css('#5adca1'), litAmber: css('#eccd63'), litRed: css('#ef7773'),
  glowGreen: css('#51d896', 0.2), glowAmber: css('#eccd63', 0.2), glowRed: css('#ef7773', 0.2),
  focus: css('#62d7aa'), clear: css('#000000', 0)
};

// The header bar's vertical gradient (#1b222b to #141a22) as four bands, and
// the fader thumb's brushed-metal gradient as seven, each band sampled at its
// middle. Steps of a level or two apiece, too fine to read as steps.
const BAR_BANDS = 4;
const BAR_BAND_COLS = [];
for (let i = 0; i < BAR_BANDS; i++) BAR_BAND_COLS.push(mixHex('#1b222b', '#141a22', (i + 0.5) / BAR_BANDS));
const THUMB_STOPS = [0, '#8b99a8', 0.42, '#667380', 0.46, '#c4d1dd', 0.53, '#303a45', 0.59, '#596573', 1, '#394552'];
const THUMB_EDGES = [0, 3, 6, 7, 8, 9, 12, 15];   // band edges in the thumb's 15 px inner height
const THUMB_COLS = [];
for (let b = 0; b + 1 < THUMB_EDGES.length; b++) {
  const t = (THUMB_EDGES[b] + THUMB_EDGES[b + 1]) / 2 / 15;
  let k = 0;
  while (k + 2 < THUMB_STOPS.length - 2 && t > THUMB_STOPS[k + 2]) k += 2;
  const t0 = THUMB_STOPS[k], t1 = THUMB_STOPS[k + 2];
  THUMB_COLS.push(mixHex(THUMB_STOPS[k + 1], THUMB_STOPS[k + 3], t1 > t0 ? (t - t0) / (t1 - t0) : 0));
}

// ---------- v0's dimensions ----------
// Body text inherits v0's line-height of 1.5, so a 9 px section label sits in
// a 13.5 px line and 8 px column heads in a 12 px one; the monospace readouts
// set their own font and so their own normal line. Rows are border-box: the
// hairline on top is inside the height.
const WIN_DEFAULT = 500, WIN_MIN = 440, RADIUS_WIN = 9;
const BAR_H = 33;                 // 5 + 22 + 5 padding and close button, + 1 bottom border
const BAR_PAD_L = 13, BAR_PAD_R = 8, BAR_GAP = 9;
const BTN_H = 21, CLOSE_H = 22, BTN_PAD_X = 9, CLOSE_PAD_X = 7;
const PAD_T = 5, PAD_B = 7;
const SEC_LINE = 13.5, SEC_FIRST_H = 2 + SEC_LINE, SEC_H = 10 + 1 + 9 + SEC_LINE;
const CHAN_FIRST_H = 32, CHAN_H = 29;   // a first master-row after a label, and the ones after it
const COLS_H = 19, LAYER_H = 28;
// Slimmer than v0's CSS (5 px track, 11 x 15 thumb) at the user's request.
const FADER_H = 20, THUMB_W = 9, THUMB_H = 13, TRACK_H = 4;
const THUMB_BAND_SCALE = (THUMB_H - 2) / 15;   // THUMB_EDGES are authored on a 15 px inner height
const MS_H = 19;
const EDIT_W = 56, EDIT_H = 18;
// The body's height is measured each frame from what was actually laid out
// (bodyH below), so a channel added to a section can never leave the window
// a row short. This is only the first frame's guess.
let BODY_H = 600;
const TOAST_MS = 1400;
const NARROW_VIEW = 520;          // v0's @media (max-width:520px)

const TOAST_TEXT = 'SETTINGS COPIED';
const METER_TIP = 'Post-fader signal · -60 to 0 dBFS';
const DRIFT_TIP = 'Drift: slowly crossfade from place to place on its own';

// ---------- controls ----------
const POWER = byId('ambMixerPower'), DRIFT = byId('ambMixerDrift');
const COPY = byId('ambMixerCopy'), CLOSE = byId('ambMixerClose');

// One per fader: the schema control, the readout as last formatted (with the
// unit taken off, since v0 prints the unit in the signal column or the column
// head instead), and the drag's own state.
const DRAG_NONE = 0, DRAG_ABS = 1, DRAG_REL = 2, DRAG_PENDING = 3;
function makeFader(ctrl) {
  return { ctrl, pos: NaN, text: '', mode: DRAG_NONE, anchorX: 0, base: 0, wasPressed: false };
}
const TONE = [makeFader(byId('mixFund')), makeFader(byId('mixHarm')), makeFader(byId('mixPulse'))];
const MUSIC = [makeFader(byId('mixPiano')), makeFader(byId('mixClouds')), makeFader(byId('mixDrone')), makeFader(byId('mixArp'))];
const TONE_IDS = ['mixFund', 'mixHarm', 'mixPulse'], MUSIC_IDS = ['mixPiano', 'mixClouds', 'mixDrone', 'mixArp'];
// Each channel's key in the mix gate (js/mixgate.js), and its mute and solo
// controls from schema-audio.js, the same M and S pair a recording row has.
const TONE_CH = ['fund', 'harm', 'pulse'], MUSIC_CH = ['piano', 'clouds', 'drone', 'arp'];
const TONE_MUTE = TONE_IDS.map(id => byId(id + 'Mute')), TONE_SOLO = TONE_IDS.map(id => byId(id + 'Solo'));
const MUSIC_MUTE = MUSIC_IDS.map(id => byId(id + 'Mute')), MUSIC_SOLO = MUSIC_IDS.map(id => byId(id + 'Solo'));
// v0 sets master-row labels in capitals through CSS; here they are set once.
const capsLabel = f => f.ctrl ? f.ctrl.label.toUpperCase() : '';
const TONE_LABELS = TONE.map(capsLabel), MUSIC_LABELS = MUSIC.map(capsLabel);
const MASTER = makeFader(byId('ambMixerMaster')), REVERB = makeFader(byId('ambMixerReverb'));
const LAYERS = [];
for (let i = 0; i < AMB_LAYER_COUNT; i++) LAYERS.push(makeFader(ambLayerControls(i).level));

// placed says x and y hold a real position. x alone cannot say it: the
// window may be dragged partly off the left edge, so a negative x is a
// legitimate place, not "never placed".
export const mixer = {
  open: false, placed: false, x: 0, y: 80, w: WIN_DEFAULT,
  h: 0,             // the height the viewer dragged it to; 0 fits the content
  rx: 0, ry: 0, rw: 0, rh: 0,   // where it was drawn last frame (rw 0: not showing), for stacking
  grabX: 0, grabY: 0, grabW: 0, grabH: 0, dragging: false, resizing: false, resizingH: false
};

// ---------- persistence ----------
// v0 kept the window's open state, position and width under its own key
// (WINDOW_KEY), opening on a first ever visit. Here the same record lives in
// the UI state store.js keeps apart from settings. It is read on the first
// frame, since store.js only has its storage once main.js has booted, and
// written whenever it changes, except mid-drag, when the release writes it.
let restored = false;
const saved = { open: false, placed: false, x: 0, y: 0, w: 0, h: 0 };
function restore() {
  restored = true;
  const all = loadUiState();
  const m = all && all.mixer && typeof all.mixer === 'object' ? all.mixer : null;
  if (m) {
    mixer.open = m.open !== false;
    if (m.placed && Number.isFinite(m.x) && Number.isFinite(m.y)) { mixer.placed = true; mixer.x = m.x; mixer.y = m.y; }
    if (Number.isFinite(m.width)) mixer.w = m.width;
    if (Number.isFinite(m.height)) mixer.h = m.height;
  } else {
    mixer.open = true;
  }
  remember();
}
function remember() {
  saved.open = mixer.open; saved.placed = mixer.placed;
  saved.x = Math.round(mixer.x); saved.y = Math.round(mixer.y); saved.w = Math.round(mixer.w);
  saved.h = Math.round(mixer.h);
}
function persist() {
  if (mixer.dragging || mixer.resizing || mixer.resizingH) return;
  if (saved.open === mixer.open && saved.placed === mixer.placed && saved.x === Math.round(mixer.x) &&
      saved.y === Math.round(mixer.y) && saved.w === Math.round(mixer.w) && saved.h === Math.round(mixer.h)) return;
  remember();
  saveUiState({ mixer: { open: saved.open, placed: saved.placed, x: saved.x, y: saved.y, width: saved.w, height: saved.h } });
}

// ---------- per-frame layout, in module scalars ----------
// v0's grid: 105px 23px 23px minmax(60px,120px) 30px minmax(60px,125px) with
// a 6 px gap, or the narrow screen's 78 20 20 (35-75) 23 (30-105) with 4.
// The two flexible tracks grow together from their minimum until one meets
// its maximum, as CSS grid shares free space.
let narrow = false, bodyX = 0, bodyW = 0, gap = 6;
let x1 = 0, x2 = 0, x3 = 0, x4 = 0, x5 = 0, x6 = 0;
let c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0;
let viewTop = 0, viewBot = 0;
function layoutGrid(regionX, regionW) {
  const padX = narrow ? 7 : 12;
  bodyX = regionX + padX; bodyW = regionW - padX * 2;
  gap = narrow ? 4 : 6;
  c1 = narrow ? 78 : 105; c2 = c3 = narrow ? 20 : 23; c5 = narrow ? 23 : 30;
  const min4 = narrow ? 35 : 60, max4 = narrow ? 75 : 120, min6 = narrow ? 30 : 60, max6 = narrow ? 105 : 125;
  const inner = bodyW - 16;
  let free = inner - (c1 + c2 + c3 + c5 + gap * 5) - min4 - min6;
  if (free < 0) free = 0;
  const room4 = max4 - min4, room6 = max6 - min6;
  if (free / 2 <= Math.min(room4, room6)) { c4 = min4 + free / 2; c6 = min6 + free / 2; }
  else if (room4 < room6) { c4 = max4; c6 = Math.min(max6, min6 + free - room4); }
  else { c6 = max6; c4 = Math.min(max4, min4 + free - room6); }
  x1 = bodyX + 8; x2 = x1 + c1 + gap; x3 = x2 + c2 + gap; x4 = x3 + c3 + gap; x5 = x4 + c4 + gap; x6 = x5 + c5 + gap;
}

const lm = { ascent: 0, descent: 0 };
// The baseline that centres a line of `size` on cy, as CSS centres a line box.
function baseline(ui, cy, size) {
  ui.text.lineMetrics(size, lm);
  return cy + (lm.ascent - lm.descent) / 2;
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function off(top, h) { return top + h < viewTop || top > viewBot; }
function pointerIn(ui, x, y, w, h) {
  return ui.pointerX >= x && ui.pointerX < x + w && ui.pointerY >= y && ui.pointerY < y + h &&
         ui.pointerY >= viewTop && ui.pointerY < viewBot;
}
// ui.interact on a rect cut to the scrolling body's viewport, so a row
// scrolled half under the header, or past the bottom edge over the field,
// only answers on its visible part. A fully hidden rect still runs (with no
// area), so a drag already under way keeps its hold.
function hit(ui, id, x, y, w, h) {
  let y0 = y, y1 = y + h;
  if (y0 < viewTop) y0 = viewTop;
  if (y1 > viewBot) y1 = viewBot;
  ui.interact(id, x, y0, w, y1 > y0 ? y1 - y0 : 0, false);
}

// ---------- tooltips ----------
// v0's title attributes. Offered by whatever the pointer is over and drawn
// once, after the body, outside every clip, so no row can paint over one.
let tipId = -1, tipX = 0, tipY = 0, tipW = 0, tipH = 0, tipStr = '';
let lastTipId = -1, lastX = 0, lastY = 0, lastW = 0, lastH = 0, lastStr = '';
function offerTip(id, x, y, w, h, str) { tipId = id; tipX = x; tipY = y; tipW = w; tipH = h; tipStr = str; }
function flushTips(ui) {
  if (lastTipId !== -1 && lastTipId !== tipId) ui.tooltipAt(lastTipId, lastX, lastY, lastW, lastH, false, lastStr);
  if (tipId !== -1) ui.tooltipAt(tipId, tipX, tipY, tipW, tipH, true, tipStr);
  lastTipId = tipId; lastX = tipX; lastY = tipY; lastW = tipW; lastH = tipH; lastStr = tipStr;
  tipId = -1;
}

// ---------- readouts ----------
// Formatted by the schema on change only, then stripped of the unit v0 shows
// elsewhere: '-12.0 dB' reads '-12.0' beside a meter marked dB, '18%' reads
// '18' under the % column.
function readout(f) {
  const pos = f.ctrl.get(S);
  if (pos !== f.pos) {
    f.pos = pos;
    let t = f.ctrl.format ? f.ctrl.format(S) : String(pos);
    if (t.endsWith(' dB')) t = t.slice(0, -3);
    else if (t.endsWith('%')) t = t.slice(0, -1);
    f.text = t;
  }
  return f.text;
}

// Clamped to the control's range and snapped to its step (whole steps from
// min, which every mixer control uses).
function snap(ctrl, v) {
  const lo = ctrl.min, hi = ctrl.max, step = ctrl.step || 1;
  v = lo + Math.round((v - lo) / step) * step;
  return v < lo ? lo : v > hi ? hi : v;
}

// The one value being typed, if any. Clicking a readout opens a field over
// it seeded with the number as shown, all selected; the typed number is in
// the shown units, so it goes through the control's parse (dB on a position
// fader) when there is one and is otherwise the position itself. Enter or a
// press elsewhere commits, Escape cancels, an untouched seed changes nothing.
const edit = { st: makeTextState(12), f: null, seed: '' };
function beginEdit(ui, f) {
  // a field still open on another fader commits first, as a blur would
  if (edit.st.active && edit.f && edit.f !== f) commitEdit(edit.f);
  edit.f = f;
  edit.seed = f.text;
  ui.textBegin(edit.st, f.text, true, true);
}
function commitEdit(f) {
  const t = edit.st.text.trim();
  if (!t || t === edit.seed) return;
  const ctrl = f.ctrl;
  const raw = ctrl.parse ? ctrl.parse(S, t) : parseFloat(t);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
  const p = snap(ctrl, raw);
  if (p !== ctrl.get(S)) ctrl.set(S, p);
}

// ---------- the fader and its value ----------
// v0's range input: a 5 px recessed track filled to the value, and a 13 by 17
// metal thumb that travels inside it. A press on the thumb drags it from where
// it was taken; a press anywhere else on the track jumps it there, as the
// browser's own range input does. Double-click resets to the control's
// default, Alt+wheel nudges one step, arrows nudge while it has focus.
function onThumb(px, thumbL) { return px >= thumbL - 2 && px <= thumbL + THUMB_W + 2; }
function absU(px, x, travel) { return clamp01((px - x - 1 - THUMB_W / 2) / travel); }

function faderCells(ui, f, cy, textAlpha) {
  const ctrl = f.ctrl;
  if (!ctrl) return;
  const x = x4, w = c4;
  const nid = ui.id(ctrl.id);
  const focused = ui.registerFocusable(nid);
  const min = ctrl.min, range = (ctrl.max - min) || 1, step = ctrl.step || 1;
  const pos = ctrl.get(S);
  const valueRight = x5 + c5;

  // The field runs first, at the readout, so a press on the track commits
  // before it drags: a browser's blur-then-click order.
  let editing = edit.st.active && edit.f === f;
  if (editing) {
    const status = ui.textField('mixer.valueEdit', valueRight + 4 - EDIT_W, cy - EDIT_H / 2, EDIT_W, EDIT_H, edit.st, 11, 2);
    if (status === TEXT_COMMIT) commitEdit(f);
    if (status !== TEXT_EDITING) { edit.f = null; editing = false; }
  }

  // the readout's own click target: the whole value column
  hit(ui, ui.idx(ctrl.id, 7), x5 - 2, cy - FADER_H / 2, c5 + 4, FADER_H);
  const valueHover = ui.hover && !editing;
  if (valueHover) ui.setCursorHint('pointer');
  const openEdit = ui.clicked && !editing;

  hit(ui, nid, x, cy - FADER_H / 2, w, FADER_H);
  const hover = ui.hover, dbl = ui.dbl, released = ui.released;
  const held = ui.pressed && ui.activeId === nid;
  if (hover || held) ui.setCursorHint('pointer');

  const travel = w - 2 - THUMB_W;
  const u = clamp01((pos - min) / range);
  const thumbL = x + 1 + u * travel;
  let nu = u;
  if (held && !f.wasPressed) {
    f.anchorX = ui.pointerX; f.base = u;
    if (ui.slopPending) f.mode = DRAG_PENDING;
    else {
      f.mode = onThumb(ui.pointerX, thumbL) ? DRAG_REL : DRAG_ABS;
      if (f.mode === DRAG_ABS) nu = absU(ui.pointerX, x, travel);
    }
  } else if (held) {
    if (f.mode === DRAG_PENDING && !ui.slopPending) f.mode = onThumb(f.anchorX, x + 1 + f.base * travel) ? DRAG_REL : DRAG_ABS;
    if (f.mode === DRAG_ABS) nu = absU(ui.pointerX, x, travel);
    else if (f.mode === DRAG_REL) nu = clamp01(f.base + (ui.pointerX - f.anchorX) / travel);
  } else if (released && f.mode === DRAG_PENDING) {
    // a touch tap that never travelled: jump there unless it was on the thumb
    if (!onThumb(f.anchorX, x + 1 + f.base * travel)) nu = absU(f.anchorX, x, travel);
  }
  if (!held) f.mode = DRAG_NONE;
  f.wasPressed = held;

  let next = pos;
  if (nu !== u) next = snap(ctrl, min + nu * range);
  if (dbl && ctrl.def !== undefined) next = snap(ctrl, ctrl.def);
  if (hover && ui.wheelAlt && ui.wheelDY !== 0 && !ui._wheelConsumed) {
    next = snap(ctrl, pos + (ui.wheelDY > 0 ? -step : step));
    ui._wheelConsumed = true;
  }
  if (focused) {
    for (let i = 0; i < ui.keyCount; i++) {
      if (!ui.keyIsDown(i)) continue;
      const k = ui.keyCode(i);
      if (k === 'ArrowLeft' || k === 'ArrowDown') next = snap(ctrl, next - step);
      else if (k === 'ArrowRight' || k === 'ArrowUp') next = snap(ctrl, next + step);
    }
  }
  if (next !== pos) ctrl.set(S, next);
  const text = readout(f);
  if (openEdit) beginEdit(ui, f);

  // ---- draw ----
  const dl = ui.dl;
  const su = clamp01((next - min) / range);
  const tTop = cy - TRACK_H / 2;
  dl.rect(x, tTop, w, TRACK_H, TRACK_H / 2, C.trackBg, 1, C.trackBorder, 0, 0);
  dl.rect(x + 1, tTop + TRACK_H, w - 2, 1, 0, C.trackHi, 0, null, 0, 0);
  if (su > 0) dl.rect(x + 1, tTop + 1, su * (w - 2), TRACK_H - 2, 1, C.trackFill, 0, null, 0, 0);
  const tx = x + 1 + su * travel, ty = cy - THUMB_H / 2;
  dl.rect(tx, ty, THUMB_W, THUMB_H, 2, C.thumbBase, 1, C.thumbBorder, 3, 0.8);
  for (let b = 0; b < THUMB_COLS.length; b++) {
    dl.rect(tx + 1, ty + 1 + THUMB_EDGES[b] * THUMB_BAND_SCALE, THUMB_W - 2,
            (THUMB_EDGES[b + 1] - THUMB_EDGES[b]) * THUMB_BAND_SCALE, 0, THUMB_COLS[b], 0, null, 0, 0);
  }
  if (focused && ui.focusVisible) dl.rect(x - 2, cy - FADER_H / 2 - 2, w + 4, FADER_H + 4, 3, C.clear, 1, C.focus, 0, 0);

  if (!editing) {
    const b = baseline(ui, cy, 11);
    ui.text.draw(dl, text, valueRight, b, 11, W.regular, C.valueInk, 2, 0, textAlpha);
    if (valueHover) {
      const tw = ui.text.measure(text, 11, W.regular);
      dl.rect(valueRight - tw, b + 2.5, tw, 1, 0.5, C.valueInk, 0, null, 0, 0);
    }
  }
}

// ---------- meters ----------
// v0's LED strip: twelve segments in an 11 px recessed box, dark until lit,
// the last three amber and red. A lit segment carries a faint halo of its
// own colour, v0's 4 px glow.
function meter(ui, x, cy, w, count) {
  const dl = ui.dl, top = cy - 5.5;
  dl.rect(x, top, w, 11, 2, C.meterBg, 1, C.meterBorder, 0, 0);
  const g = narrow ? 2 : 3;
  const ledW = (w - 6 - g * 11) / 12;
  if (ledW <= 0) return;
  for (let i = 0; i < 12; i++) {
    const lx = x + 3 + i * (ledW + g);
    const lit = i < count;
    const col = i >= 11 ? (lit ? C.litRed : C.ledRed) : i >= 9 ? (lit ? C.litAmber : C.ledAmber) : (lit ? C.litGreen : C.ledGreen);
    if (lit) dl.rect(lx - 1.5, top + 1.5, ledW + 3, 8, 2.5, i >= 11 ? C.glowRed : i >= 9 ? C.glowAmber : C.glowGreen, 0, null, 0, 0);
    dl.rect(lx, top + 3, ledW, 5, 1, col, 0, null, 0, 0);
  }
  if (pointerIn(ui, x, top, w, 11)) offerTip(ui.id('mixer.meterTip'), x, top, w, 11, METER_TIP);
}

// ---------- rows ----------
function sectionLabel(ui, str, first) {
  const top = ui.cursorY, h = first ? SEC_FIRST_H : SEC_H;
  ui.spacer(h);
  if (off(top, h)) return;
  let ty = top + 2;
  if (!first) {
    ui.dl.rect(bodyX + 8, top + 10, bodyW - 16, 1, 0, C.faintLine, 0, null, 0, 0);
    ty = top + 20;
  }
  ui.text.draw(ui.dl, str, x1, baseline(ui, ty + SEC_LINE / 2, 9), 9, W.semibold, C.sectionInk, 0, 0.16, 1);
}

// A channel's label cut to the first column with an ellipsis, now that its
// M and S switches take the next two. Worked out once per column width and
// cached, like the source names below.
const fitLabelCache = new Map();
let fitLabelNarrow = null;
function fittedLabel(ui, label) {
  if (fitLabelNarrow !== narrow) { fitLabelNarrow = narrow; fitLabelCache.clear(); }
  let s = fitLabelCache.get(label);
  if (s !== undefined) return s;
  const width = t => ui.text.measure(t, 10, W.regular) + t.length * 10 * 0.11;
  s = label;
  if (width(s) > c1) {
    while (s.length > 1 && width(s + '…') > c1) s = s.slice(0, -1);
    s = s.trimEnd() + '…';
  }
  fitLabelCache.set(label, s);
  return s;
}

// A master row: fader, value, and in the signal column either a meter with
// its unit (a channel) or the unit alone, centred (MASTER, SEND). A channel
// row carries its mute and solo switches in the recordings' M and S columns
// with its label in the first column; MASTER and SEND have none and their
// label runs across all three. silenced dims the label and value as a
// recording row's does, whether its own mute or another track's solo holds it.
function masterRow(ui, f, first, label, unit, meterCountOrNone, muteCtrl, soloCtrl, silenced) {
  const top = ui.cursorY, h = first ? CHAN_FIRST_H : CHAN_H;
  ui.spacer(h);
  if (off(top, h)) return;
  const dl = ui.dl;
  dl.rect(bodyX, top, bodyW, 1, 0, first ? C.strongLine : C.faintLine, 0, null, 0, 0);
  const cy = top + 1 + (first ? 7 : 4) + FADER_H / 2;
  const alpha = silenced ? 0.45 : 1;
  const shown = muteCtrl ? fittedLabel(ui, label) : label;
  ui.text.draw(dl, shown, x1, baseline(ui, cy, 10), 10, W.regular, C.masterInk, 0, 0.11, alpha);
  if (muteCtrl) msButton(ui, muteCtrl, x2, cy, c2, true);
  if (soloCtrl) msButton(ui, soloCtrl, x3, cy, c3, false);
  faderCells(ui, f, cy, alpha);
  const ub = baseline(ui, cy, 8);
  if (meterCountOrNone >= 0) {
    const unitW = ui.text.measure(unit, 8, W.regular) + unit.length * 8 * 0.18;
    const sigGap = narrow ? 3 : 5;
    meter(ui, x6, cy, c6 - sigGap - unitW, meterCountOrNone);
    ui.text.draw(dl, unit, x6 + c6 - unitW, ub, 8, W.regular, C.unitInk, 0, 0.18, 1);
  } else {
    ui.text.draw(dl, unit, x6 + c6 / 2, ub, 8, W.regular, C.unitInk, 1, 0.18, 1);
  }
}

function columnHeads(ui) {
  const top = ui.cursorY;
  ui.spacer(COLS_H);
  if (off(top, COLS_H)) return;
  const b = baseline(ui, top + 2 + 6, 8), dl = ui.dl;
  ui.text.draw(dl, 'SOURCE', x1, b, 8, W.regular, C.columnInk, 0, 0.16, 1);
  ui.text.draw(dl, 'LEVEL', x4, b, 8, W.regular, C.columnInk, 0, 0.16, 1);
  ui.text.draw(dl, '%', x5 + c5, b, 8, W.regular, C.columnInk, 2, 0.16, 1);
  ui.text.draw(dl, 'SIGNAL', x6, b, 8, W.regular, C.columnInk, 0, 0.16, 1);
}

// Source names cut to the label column with an ellipsis, as v0's
// text-overflow does. Worked out once per column width (wide or narrow).
let fitNames = null, fitNarrow = null;
function fittedName(ui, i) {
  if (!fitNames || fitNarrow !== narrow) {
    fitNarrow = narrow;
    fitNames = new Array(AMB_LAYER_COUNT);
    const size = narrow ? 10 : 11, maxW = c1;
    for (let k = 0; k < AMB_LAYER_COUNT; k++) {
      const name = ambienceSourceName(k);
      const width = s => ui.text.measure(s, size, W.regular) + s.length * size * 0.01;
      let s = name;
      if (width(s) > maxW) {
        while (s.length > 1 && width(s + '…') > maxW) s = s.slice(0, -1);
        s = s.trimEnd() + '…';
      }
      fitNames[k] = s;
    }
  }
  return fitNames[i];
}

// v0's small square M and S switches: dark until pressed, then red for mute
// and green for solo, each with a faint glow of its own colour.
function msButton(ui, ctrl, x, cy, w, isMute) {
  const nid = ui.id(ctrl.id);
  const y = cy - MS_H / 2;
  hit(ui, nid, x, y, w, MS_H);
  if (ui.hover) { ui.setCursorHint('pointer'); offerTip(nid, x, y, w, MS_H, ctrl.label); }
  if (ui.clicked) ctrl.set(S, !ctrl.get(S));
  const on = !!ctrl.get(S), dl = ui.dl;
  if (on) {
    dl.rect(x - 2, y - 2, w + 4, MS_H + 4, 5, isMute ? C.muteGlow : C.soloGlow, 0, null, 0, 0);
    dl.rect(x, y, w, MS_H, 3, isMute ? C.muteBg : C.soloBg, 1, isMute ? C.muteBorder : C.soloBorder, 0, 0);
  } else {
    dl.rect(x, y, w, MS_H, 3, C.msBg, 1, C.msBorder, 2, 0.45);
  }
  ui.text.draw(dl, isMute ? 'M' : 'S', x + w / 2, baseline(ui, cy, 10), 10, W.semibold,
    on ? (isMute ? C.muteInk : C.soloInk) : C.msInk, 1, 0, 1);
}

function layerRow(ui, i, soloing) {
  const top = ui.cursorY;
  ui.spacer(LAYER_H);
  if (off(top, LAYER_H)) return;
  const dl = ui.dl;
  const layer = S.ambLayers ? S.ambLayers[i] : null;
  const muted = !!(layer && layer.muted), solo = !!(layer && layer.solo);
  const active = !!layer && layer.level > 0 && !muted && (!soloing || solo);
  const silenced = muted || (soloing && !solo);
  const status = layerStatus(i);
  const pending = status === 'Loading…', error = status.startsWith('Could not');

  if (i % 2 === 0) dl.rect(bodyX, top, bodyW, LAYER_H, 0, C.rowOdd, 0, null, 0, 0);
  const rowHover = pointerIn(ui, bodyX, top, bodyW, LAYER_H);
  if (rowHover) dl.rect(bodyX, top, bodyW, LAYER_H, 0, C.rowHover, 0, null, 0, 0);
  dl.rect(bodyX, top, bodyW, 1, 0, C.rowLine, 0, null, 0, 0);

  const cy = top + 1 + (LAYER_H - 1) / 2;
  const size = narrow ? 10 : 11;
  const ink = error ? C.layerError : pending ? C.layerLoading : active ? C.layerActive : C.layerInk;
  const alpha = silenced ? 0.45 : 1;
  ui.text.draw(dl, fittedName(ui, i), x1, baseline(ui, cy, size), size, W.regular, ink, 0, 0.01, alpha);
  if ((pending || error) && pointerIn(ui, x1, top, c1, LAYER_H)) offerTip(ui.idx('mixer.layerTip', i), x1, top, c1, LAYER_H, status);

  const lc = ambLayerControls(i);
  msButton(ui, lc.mute, x2, cy, c2, true);
  msButton(ui, lc.solo, x3, cy, c3, false);
  faderCells(ui, LAYERS[i], cy, alpha);
  meter(ui, x6, cy, c6, layerMeterCount(i));
}

// ---------- header ----------
let btnHover = false, overBtn = false;
function barHit(ui, name, x, y, w, h) {
  ui.interact(ui.id(name), x, y, w, h, false);
  btnHover = ui.hover;
  if (ui.hover) { ui.setCursorHint('pointer'); overBtn = true; }
  return ui.clicked;
}
function barButton(ui, x, cy, w, h, fill, border, ink, label, size) {
  ui.dl.rect(x, cy - h / 2, w, h, 6, fill, 1, border, 0, 0);
  if (label) ui.text.draw(ui.dl, label, x + w / 2, baseline(ui, cy, size), size, W.regular, ink, 1, 0, 1);
}

let copiedAt = -1e9;

// fade is the chrome's idle fade: an open mixer goes with the rest of the
// overlay once the pointer settles, and comes back on any movement.
export function drawMixer(ui, app, fade = 1) {
  if (!restored) restore();
  persist();
  const open = ui.spring('mixer.open', mixer.open ? 1 : 0, MOTION.panel);
  const o = open * fade;
  if (o < 0.002) { mixer.rw = 0; return; }
  const width = app.width, height = app.height;
  narrow = width <= NARROW_VIEW;

  // v0's sizes: min(500, screen - 24) wide by default, never under
  // min(440, screen - 24) nor over screen - 24. Tall: as tall as its content
  // or whatever the viewer dragged the bottom edge to, never past the bottom
  // of the screen (so the window's own bottom edge stays in reach), and
  // scrolling whatever does not fit.
  const maxW = Math.max(200, width - 24), minW = Math.min(WIN_MIN, maxW);
  const winW = Math.max(minW, Math.min(mixer.w, maxW));
  const minH = BAR_H + 80, fitH = 1 + BAR_H + BODY_H + 1;
  const roomH = Math.max(minH, height - 12 - Math.max(12, mixer.y));
  const maxH = roomH;
  const h = Math.max(minH, Math.min(mixer.h > 0 ? mixer.h : fitH, maxH));
  // first showing: v0's top 80, right 24
  if (!mixer.placed) { mixer.placed = true; mixer.x = Math.max(12, width - winW - 24); mixer.y = 80; }
  // keep the window reachable after a resize
  mixer.x = Math.max(12 - winW + 80, Math.min(mixer.x, width - 80));
  mixer.y = Math.max(12, Math.min(mixer.y, height - BAR_H - 12));
  const x = mixer.x, y = mixer.y + (1 - open) * 16;   // slides on open/shut only, not the idle fade
  mixer.rx = x; mixer.ry = y; mixer.rw = winW; mixer.rh = h;
  const dl = ui.dl;

  ui.pushScope(ui.id('mixer'));
  dl.pushAlpha(o);
  overBtn = false;

  // ---- the pane: flat, opaque, v0's border and a tight shadow ----
  // v0's CSS shadow was a 60 px blur; over a dark field that reads as a big
  // dark halo around the window rather than depth, so it is kept small.
  dl.rect(x, y, winW, h, RADIUS_WIN, C.pane, 1, C.paneBorder, 10, 0.35);

  // ---- header bar ----
  const cy = y + 1 + (BAR_H - 1) / 2;
  dl.pushClip(x + 1, y + 1, winW - 2, BAR_H - 1);
  dl.rect(x + 1, y + 1, winW - 2, BAR_H + RADIUS_WIN, RADIUS_WIN - 1, BAR_BAND_COLS[0], 0, null, 0, 0);
  const bandH = (BAR_H - 1) / BAR_BANDS;
  for (let i = 1; i < BAR_BANDS; i++) dl.rect(x + 1, y + 1 + i * bandH, winW - 2, bandH + 0.5, 0, BAR_BAND_COLS[i], 0, null, 0, 0);
  dl.rect(x + RADIUS_WIN, y + 1, winW - RADIUS_WIN * 2, 1, 0, C.paneHi, 0, null, 0, 0);
  dl.popClip();
  dl.rect(x + 1, y + BAR_H, winW - 2, 1, 0, C.barLine, 0, null, 0, 0);

  // laid out from the right, as v0's flex row ends: close, on, copy, drift
  const closeW = ui.text.measure('×', 18, W.regular) + CLOSE_PAD_X * 2 + 2;
  const closeX = x + winW - 1 - BAR_PAD_R - closeW;
  const powerLabel = S.ambOn ? 'on' : 'off';
  const powerW = ui.text.measure(powerLabel, 10, W.regular) + BTN_PAD_X * 2 + 2;
  const powerX = closeX - BAR_GAP - powerW;
  const copyW = ui.text.measure('copy settings', 10, W.regular) + BTN_PAD_X * 2 + 2;
  const copyX = powerX - BAR_GAP - copyW;
  const driftW = ui.text.measure('drift', 10, W.regular) + BTN_PAD_X * 2 + 2;
  const driftX = copyX - BAR_GAP - driftW;

  // power light and title
  // The light says what is actually happening, not just the switch: green
  // while the atmosphere is on and sound is playing, red while it is on but
  // the audio has stopped (session paused or sound off), dark when switched off.
  const lightX = x + 1 + BAR_PAD_L;
  if (S.ambOn) {
    const playing = S.running && S.audioEnabled;
    dl.rect(lightX - 3, cy - 6, 12, 12, 6, playing ? C.lightGlow : C.lightStopGlow, 0, null, 0, 0);
    dl.rect(lightX, cy - 3, 6, 6, 3, playing ? C.lightOn : C.lightStop, 0, null, 0, 0);
  } else {
    dl.rect(lightX, cy - 3, 6, 6, 3, C.lightOff, 0, null, 0, 0);
  }
  ui.text.draw(dl, 'MIXER', lightX + 6 + BAR_GAP, baseline(ui, cy, 11), 11, W.semibold, C.title, 0, 0.13, 1);

  // drift: lit blue while on, the label never changes (v0's own reasoning:
  // a button that rewrites itself changes width inside a drag handle)
  if (barHit(ui, 'mixer.drift', driftX, cy - BTN_H / 2, driftW, BTN_H) && DRIFT) DRIFT.set(S, !DRIFT.get(S));
  if (btnHover) offerTip(ui.id('mixer.drift'), driftX, cy - BTN_H / 2, driftW, BTN_H, DRIFT_TIP);
  if (S.ambDrift) {
    dl.rect(driftX - 3, cy - BTN_H / 2 - 3, driftW + 6, BTN_H + 6, 9, C.driftGlow, 0, null, 0, 0);
    dl.rect(driftX, cy - BTN_H / 2, driftW, BTN_H, 6, C.driftBottom, 1, C.driftBorder, 0, 0);
    dl.rect(driftX + 1, cy - BTN_H / 2 + 1, driftW - 2, (BTN_H - 2) / 2, 5, C.driftTop, 0, null, 0, 0);
    dl.rect(driftX + 5, cy - BTN_H / 2 + 1, driftW - 10, 1, 0, C.driftHi, 0, null, 0, 0);
    ui.text.draw(dl, 'drift', driftX + driftW / 2, baseline(ui, cy, 10), 10, W.regular, C.driftInk, 1, 0, 1);
  } else {
    barButton(ui, driftX, cy, driftW, BTN_H, C.btnBg, btnHover ? C.btnBorderHover : C.btnBorder, C.btnInk, 'drift', 10);
  }

  // copy settings: a check over the label and a small toast underneath
  if (barHit(ui, 'mixer.copy', copyX, cy - BTN_H / 2, copyW, BTN_H) && COPY) { runAction(COPY, S); copiedAt = ui.t; }
  const copied = ui.t - copiedAt < TOAST_MS;
  if (copied) {
    barButton(ui, copyX, cy, copyW, BTN_H, C.copiedBg, C.copiedBorder, null, null, 10);
    dl.icon(ICON.CHECK, copyX + copyW / 2 - 6.5, cy - 6.5, 13, 13, C.copiedInk, 1.6, 0);
  } else {
    barButton(ui, copyX, cy, copyW, BTN_H, C.btnBg, btnHover ? C.btnBorderHover : C.btnBorder, C.btnInk, 'copy settings', 10);
  }

  // on / off
  if (barHit(ui, 'mixer.power', powerX, cy - BTN_H / 2, powerW, BTN_H) && POWER) POWER.set(S, !POWER.get(S));
  barButton(ui, powerX, cy, powerW, BTN_H, C.btnBg,
    S.ambOn ? C.powerBorder : btnHover ? C.btnBorderHover : C.btnBorder, S.ambOn ? C.powerInk : C.btnInk, powerLabel, 10);

  // close
  if (barHit(ui, 'mixer.close', closeX, cy - CLOSE_H / 2, closeW, CLOSE_H)) { if (CLOSE) runAction(CLOSE, S); else mixer.open = false; }
  if (btnHover) offerTip(ui.id('mixer.close'), closeX, cy - CLOSE_H / 2, closeW, CLOSE_H, 'Close');
  barButton(ui, closeX, cy, closeW, CLOSE_H, C.btnBg, btnHover ? C.closeHoverBorder : C.btnBorder,
    btnHover ? C.closeHoverInk : C.btnInk, '×', 18);

  // ---- right edge: horizontal resize, v0's resize:horizontal ----
  ui.interact(ui.id('mixer.resize'), x + winW - 4, y, 8, h, false);
  if (ui.pressed) {
    if (!mixer.resizing) { mixer.resizing = true; mixer.grabW = ui.pointerX - (x + winW); }
    mixer.w = Math.max(minW, Math.min(ui.pointerX - mixer.grabW - x, maxW));
    ui.setCursorHint('ew-resize');
  } else {
    if (mixer.resizing) mixer.w = winW;
    mixer.resizing = false;
    if (ui.hover) { ui.setCursorHint('ew-resize'); overBtn = true; }
  }

  // ---- bottom edge: vertical resize, down to fit everything or up to scroll ----
  ui.interact(ui.id('mixer.resizeH'), x, y + h - 4, winW, 8, false);
  if (ui.pressed) {
    if (!mixer.resizingH) { mixer.resizingH = true; mixer.grabH = ui.pointerY - (y + h); }
    mixer.h = Math.max(minH, Math.min(ui.pointerY - mixer.grabH - y, maxH));
    ui.setCursorHint('ns-resize');
  } else {
    if (mixer.resizingH) mixer.h = h;
    mixer.resizingH = false;
    if (ui.hover) { ui.setCursorHint('ns-resize'); overBtn = true; }
  }

  // ---- title bar drag: the offset is taken on press so the window does not jump ----
  ui.interact(ui.id('mixer.drag'), x, y, winW, BAR_H, false);
  if (ui.pressed) {
    if (!mixer.dragging) { mixer.dragging = true; mixer.grabX = ui.pointerX - mixer.x; mixer.grabY = ui.pointerY - mixer.y; }
    mixer.x = ui.pointerX - mixer.grabX; mixer.y = ui.pointerY - mixer.grabY;
    ui.setCursorHint('grabbing');
  } else {
    mixer.dragging = false;
    if (ui.hover && !overBtn) ui.setCursorHint('grab');
  }

  // ---- body ----
  const cx0 = ui.cursorX, cy0 = ui.cursorY, cw0 = ui.regionW;
  const bodyTop = y + BAR_H + 1, bodyH = h - BAR_H - 2;
  viewTop = bodyTop; viewBot = bodyTop + bodyH;
  ui.setCursor(x + 1, bodyTop, winW - 2);
  ui.scroll('mixer.body', bodyH);
  layoutGrid(ui.cursorX, ui.regionW);
  const bodyStartY = ui.cursorY;
  ui.spacer(PAD_T);

  sectionLabel(ui, 'TONE', true);
  ui.spacer(5);
  for (let i = 0; i < TONE.length; i++) {
    masterRow(ui, TONE[i], i === 0, TONE_LABELS[i], 'dB', meterCount(TONE_IDS[i]),
      TONE_MUTE[i], TONE_SOLO[i], chanSilenced(TONE_CH[i]));
  }

  sectionLabel(ui, 'MUSIC', false);
  ui.spacer(5);
  for (let i = 0; i < MUSIC.length; i++) {
    masterRow(ui, MUSIC[i], i === 0, MUSIC_LABELS[i], '%', meterCount(MUSIC_IDS[i]),
      MUSIC_MUTE[i], MUSIC_SOLO[i], chanSilenced(MUSIC_CH[i]));
  }

  sectionLabel(ui, 'ATMOSPHERE', false);
  ui.spacer(2);
  columnHeads(ui);
  // Solo is mix-wide: a soloed channel above silences the recordings too.
  const soloing = anySolo();
  for (let i = 0; i < AMB_LAYER_COUNT; i++) layerRow(ui, i, soloing);

  ui.spacer(5);
  masterRow(ui, MASTER, true, 'ATMOSPHERE', 'MASTER', -1, null, null, false);
  masterRow(ui, REVERB, false, 'REVERB', 'SEND', -1, null, null, false);

  ui.spacer(PAD_B);
  // the content's full height, scroll or no scroll, for next frame's fit
  BODY_H = ui.cursorY - bodyStartY;
  ui.endScroll();
  ui.setCursor(cx0, cy0, cw0);

  // ---- the copy toast, over the body ----
  const ta = ui.spring('mixer.toast', copied ? 1 : 0, MOTION.hover);
  if (ta > 0.01) {
    const tw = ui.text.measure(TOAST_TEXT, 9, W.regular) + TOAST_TEXT.length * 0.9 + 18;
    const tx = copyX + copyW / 2 - tw / 2, ty = cy + BTN_H / 2 + 6 - (1 - ta) * 3;
    dl.pushAlpha(ta);
    dl.rect(tx, ty, tw, 19, 4, C.toastBg, 1, C.toastBorder, 16, 0.53);
    ui.text.draw(dl, TOAST_TEXT, tx + tw / 2, baseline(ui, ty + 9.5, 9), 9, W.regular, C.toastInk, 1, 0.1, 1);
    dl.popAlpha();
  }

  // clicks on empty pane stop here instead of reaching the drawer or field
  ui.interact(ui.id('mixer.backstop'), x, y, winW, h, false);
  flushTips(ui);
  dl.popAlpha();
  ui.popScope();
}
