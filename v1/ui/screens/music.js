// The Music window: the sound, played live, on the M key. It is the
// Performance window's sibling (ui/screens/performer.js, on P) and reads the
// same way: the window's own opacity and the interpolation time as two
// compact sliders in the title bar beside its name, then one dense row per
// voice, its switch and name on the left and its level beside them. The
// master volume leads, then the tone and the pulse, then the music engine's
// own switch and its five voices, then the atmosphere.
//
// Its faders are not the voices' levels. Those are the Levels window's (the
// mixer, on L) and the drawer's, the backstage pre-mix that sets each
// voice's ceiling; each fader here is a trim on top, 0 to 100% of that
// level (the mus* controls in core/schema-audio.js), so 100% plays exactly
// what Levels says and 50% half of it. The master volume is the one real
// level here, shared with the drawer.
//
// The interpolation time is not this window's own: it is the one shared
// perform.rampS the Performance window sets (core/perform.js), so a ramp
// chosen in either window is the ramp in both, and every handle in here
// glides over it through perfSet exactly as a Performance handle does. A
// voice's switch fades its level down to nothing before it goes off, and
// back up from nothing as it comes on (perfLayer), so a voice leaves and
// arrives over the ramp instead of clicking in or out; shift-click cuts.
//
// The window is the Performance window's, shape for shape: the flat opaque
// pane, a title bar that drags, edges that resize, a body that scrolls
// whatever does not fit, its place, size and opacity remembered in the UI
// state record under its own 'music' slot, and a reload bringing it back
// open if it was left open. The row and cell code is a copy of the
// Performance window's rather than a shared one, so this window can find its
// own shape without ever moving a handle in that one; the slider and the row
// fitting both windows use already live in ui/screens/perf-widgets.js.
//
// Every control id below is looked up once through the schema's byId at
// module load; an id the schema does not know is dropped silently, so a
// renamed control costs a handle, never a broken row.
import { byId } from '../../core/schema.js';
import { S } from '../../../js/state.js';
import { loadUiState, saveUiState } from '../../core/store.js';
import { perform, loadPerform, savePerform, setRampS, perfSet, perfRamping, perfLayer, perfLayerLevel } from '../../core/perform.js';
import { drawSwitch } from '../widgets.js';
import { COLOR, TYPE, W, MOTION } from '../theme.js';
import {
  C, baseline, hslider, targetPos, effectivePos, unitOf, posOf, fmtAt, fitRow, drawRow
} from './perf-widgets.js';

// ---------- sizes ----------
// The default height is only a ceiling: the window opens fitted to its rows
// (see fitH), as the Performance window does. It may be shrunk well below
// them, the body scrolling what no longer fits.
const WIN_W_DEF = 560, WIN_H_DEF = 720, WIN_MIN_W = 400, WIN_MIN_H = 160;
const RADIUS_WIN = 9, BAR_H = 33, CLOSE_H = 22, CLOSE_PAD_X = 7;
// the resize grab bands: how far into and past the window an edge takes a
// press, and the corner's square
const GRAB_IN = 7, GRAB_OUT = 7, CORNER_GRAB = 16;
const PAD_X = 14, PAD_B = 12;
// The ramp slider's taper, the Performance window's exactly, since it is the
// same time on the same scale: an exponential curve through 0, so the short
// times a performance mostly lives in get most of the travel, snapping to
// whole seconds.
const RAMP_MAX = 60;
const RAMP_CURVE = 4, RAMP_EK = Math.exp(RAMP_CURVE) - 1;
function rampToU(v) { return v <= 0 ? 0 : Math.log(1 + (v / RAMP_MAX) * RAMP_EK) / RAMP_CURVE; }
function uToRamp(u) {
  const v = RAMP_MAX * (Math.exp(RAMP_CURVE * (u < 0 ? 0 : u > 1 ? 1 : u)) - 1) / RAMP_EK;
  const r = Math.round(v);
  return r > RAMP_MAX ? RAMP_MAX : r;
}
// The title bar's two sliders, just right of the title, the window opacity
// first: a micro-caps label, a readout slot, then the track. WIN_O_MIN is how
// faint the window may go and still be found again.
const RAMP_TRACK_W = 110, WINO_TRACK_W = 90, BAR_RO_W = 30;
const BAR_GROUP_GAP = 22, BAR_CLOSE_GAP = 14, BAR_TITLE_GAP = 20;
const WIN_O_DEF = 0.9, WIN_O_MIN = 0.2;
// A row: the switch and name in a fixed left column, then the cells on one
// line, wrapping onto more lines only when the window is too narrow (fitRow).
// The name column is wider than the Performance window's, which clips its
// names to six letters; here Ambience and Sequencer are read whole.
const NAME_W = 116, SW_W = 30, SW_H = 16, NAME_GAP = 10;
const BLOCK_PAD = 1;
// How far an off row recedes: the black laid over its band, and how much its
// name and its handles give up. The same amounts as the Performance window.
const OFF_SHADE = 0.22, OFF_NAME_DIM = 0.55, OFF_HANDLE_DIM = 0.72;
const ROW_H = 30;
// The level column. With only one shared column (not four) the window can
// give each level a long track, so a fade is easy to place by hand; the
// readout keeps the Performance grid's narrow number slot (100%, 200%).
const LEVEL_W = 180, VALUE_W = 32;
const CELL_GAP = 8, INLINE_GAP = 7, INLINE_MIN_TRACK = 34;
const LEVEL_TRACK = LEVEL_W - VALUE_W - INLINE_GAP;
// The choir's Density readout names degrees ('+ 5 → + 3', 'all degrees'),
// not a number, so its slot is wide enough to hold the longest of them.
const DENS_VALUE_W = 64;
const GRID_HEAD_H = 14, SLIDER_MIN = 64;

// ---------- the rows, verified once at load ----------
// A cell for a control the schema knows; null, dropped by the filters below,
// for one it does not. k is a stable index for hit and spring ids. w is the
// natural width, min the floor a squeezed cell stops at; dw the width it is
// drawn at, ln its line and ox its x on that line (all set by fitRow).
let cellSeq = 0;
function cell(id, label, vw) {
  const c = byId(id);
  if (!c) return null;
  const w = LEVEL_W;
  return { c, label, kind: 'slider', w, min: Math.min(w, SLIDER_MIN), dw: w, ln: 0, ox: 0,
    lw: -1, k: cellSeq++, vw: vw || VALUE_W };
}
// A level: the unlabelled slider in the LEVEL column.
function levelCell(id) { return cell(id, ''); }
// toggleId null is a row with no switch (Master), never off and never dimmed.
// dimBy names the switch above a row: 'music' for the five music voices,
// which recede while the music engine is off, 'audio' for the tone and the
// pulse, which recede while the whole audio layer is off. They stay usable
// either way, so a mix can be set up in silence. short is a name to fall
// back to if the full one will not fit its column.
function makeRow(toggleId, name, cells, opts) {
  const t = toggleId ? byId(toggleId) : null;
  if (toggleId && !t) return null;
  const row = { t, name, short: opts && opts.short || '', dimBy: opts && opts.dimBy || '',
    cells: cells.filter(Boolean), cellGap: CELL_GAP, nameFit: false,
    fitW: -1, fitOver: false, linesH: ROW_H, cellH: ROW_H, k: cellSeq++ };
  for (const cel of row.cells) cel.row = row;
  // A row with a switch fades through its level (perform.js perfLayer): the
  // first cell, the LEVEL column. A row without a level simply switches.
  const first = cells[0];
  if (t && first) { row.op = first; first.opOf = row; }
  row.shownOn = true; row.fadeLevel = undefined;
  return row;
}
const MUSIC_ON = byId('musicOn'), AUDIO_ON = byId('lAudio');
const ROWS = [
  makeRow(null, 'Master', [levelCell('vol')]),
  // The tone's trim takes the fundamental and its harmonics together, and
  // its switch is the sine tone's, since the harmonics sound only while the
  // tone does. The pulse's takes the pips and their room, click or chirp.
  makeRow('aTone', 'Tone', [levelCell('musTone')], { dimBy: 'audio' }),
  makeRow('aClick', 'Pulse', [levelCell('musPulse')], { dimBy: 'audio' }),
  // the whole music engine: a switch and nothing to fade
  makeRow('musicOn', 'Music', []),
  makeRow('pianoOn', 'Piano', [levelCell('musPiano')], { dimBy: 'music' }),
  makeRow('cloudsOn', 'Clouds', [levelCell('musClouds')], { dimBy: 'music' }),
  makeRow('bedOn', 'Drone', [levelCell('musDrone')], { dimBy: 'music' }),
  makeRow('arpOn', 'Sequencer', [levelCell('musArp')], { dimBy: 'music', short: 'Seq' }),
  makeRow('choirOn', 'Choir', [levelCell('musChoir'), cell('choirDensity', 'DENS', DENS_VALUE_W)], { dimBy: 'music' }),
  makeRow('ambOn', 'Ambience', [levelCell('musAmb')])
].filter(Boolean);

// placed says x and y hold a real position: a window dragged partly off the
// left edge has a legitimate negative x. winO is the whole window's opacity,
// set from the title bar.
export const music = {
  open: false, placed: false, x: 0, y: 0, w: WIN_W_DEF, h: WIN_H_DEF, winO: WIN_O_DEF,
  rx: 0, ry: 0, rw: 0, rh: 0,   // where it was drawn last frame (rw 0: not showing), for stacking
  grabX: 0, grabY: 0, grabW: 0, grabH: 0, dragging: false, resizing: false, resizingH: false, resizingC: false
};

// ---------- persistence, the Performance window's pattern in a 'music' slot ----------
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
  const m = all && all.music && typeof all.music === 'object' ? all.music : null;
  music.open = false;
  if (m) {
    music.open = m.open === true;
    if (m.placed && Number.isFinite(m.x) && Number.isFinite(m.y)) { music.placed = true; music.x = m.x; music.y = m.y; }
    if (Number.isFinite(m.width)) music.w = m.width;
    if (Number.isFinite(m.height)) music.h = m.height;
    if (Number.isFinite(m.winO)) music.winO = clampWinO(m.winO);
  }
  // the shared ramp time comes with the window the first time it is asked
  // for, in case nothing has pulled the record in yet; loadPerform leaves a
  // record already loaded exactly as it is
  loadPerform();
  remember();
}
function remember() {
  saved.open = music.open; saved.placed = music.placed;
  saved.x = Math.round(music.x); saved.y = Math.round(music.y);
  saved.w = Math.round(music.w); saved.h = Math.round(music.h);
  saved.winO = round2(music.winO);
}
// Held off while a drag of any kind is under way (the opacity slider
// included), so the record is written once on release, not per frame.
function persist() {
  if (music.dragging || music.resizing || music.resizingH || music.resizingC || winOHeld) return;
  if (saved.open === music.open && saved.placed === music.placed &&
      saved.x === Math.round(music.x) && saved.y === Math.round(music.y) &&
      saved.w === Math.round(music.w) && saved.h === Math.round(music.h) &&
      saved.winO === round2(music.winO)) return;
  remember();
  saveUiState({ music: { open: saved.open, placed: saved.placed, x: saved.x, y: saved.y,
    width: saved.w, height: saved.h, winO: saved.winO } });
}

// per-frame layout scalars, module level as the Performance window keeps them
let bodyX = 0, bodyW = 0, viewTop = 0, viewBot = 0;
// the window's height with every row showing, measured each frame
let fitH = 0;
// how far the rows under a switch have receded, 0 with it on and 1 with it
// off: the five voices under the music engine, the tone and the pulse under
// the audio layer. Sprung once a frame before the rows are drawn.
let musicDim = 0, audioDim = 0;
function off(top, h) { return top + h < viewTop || top > viewBot; }

// ---------- the cells ----------
// One compact horizontal sentence per slider, as in the Performance window:
// an optional short label, the track, then a fixed right-aligned value.
// Drawer readouts can carry explanatory tails; this keeps only the setting.
function compactSliderValue(c, pos) {
  let value = fmtAt(c, pos);
  const extra = value.indexOf(' · ');
  if (extra >= 0) value = value.slice(0, extra);
  value = value.replace(' / cycle', '').replace(' / min', '/m').replace(/ (s|Hz|×|%)/g, '$1');
  value = value.replace(/^([-+]?\d+(?:\.\d+)?[a-z%×/]*)\s+[a-z].*$/i, '$1');
  if (!/[-+]?\d/.test(value) && typeof pos === 'number') {
    if (c.min === 0 && c.max === 100) return Math.round(pos) + '%';
    const step = c.step || 1, decimals = step < 1 ? Math.min(2, (String(step).split('.')[1] || '').length) : 0;
    return pos.toFixed(decimals);
  }
  return value;
}
function sliderCell(ui, cel, x, top) {
  const c = cel.c, live = c.get(S);
  let tgt = targetPos(c), fill = live;
  // A row's level follows its switch: the fill runs down with a fade-out and
  // sits empty while the row is off, the handle staying at the level it will
  // come back to.
  const L = cel.opOf;
  if (L) {
    if (L.fadeLevel !== undefined) tgt = L.fadeLevel;
    else if (!L.shownOn) fill = c.min ?? 0;
  }
  const labelW = cel.label ? ui.text.measure(cel.label, TYPE.micro, W.semibold) : 0;
  // A labelled slider is sized to its own label: the label, then exactly the
  // level column's bar and its own readout slot, so it keeps the column's
  // rhythm. Measured on the first draw; the row refits once for it.
  if (cel.label) {
    const want = Math.ceil(labelW + INLINE_GAP + LEVEL_TRACK + INLINE_GAP + cel.vw);
    if (cel.w !== want) {
      cel.w = want;
      if (cel.min > want) cel.min = want;
      if (cel.row) cel.row.fitW = -1;
    }
  }
  const tx = x + (cel.label ? labelW + INLINE_GAP : 0);
  const trackRight = x + cel.dw - cel.vw - INLINE_GAP;
  const tw = Math.max(INLINE_MIN_TRACK, trackRight - tx), cy = top + ROW_H / 2;
  const sid = ui.idx('mus.sl', cel.k);
  const glow = ui.spring(ui.idx('mus.slGlow', cel.k), perfRamping(c.id) ? 1 : 0, MOTION.fade);
  const effective = effectivePos(c);
  const u = hslider(ui, sid, tx, cy, tw,
    unitOf(c, typeof tgt === 'number' ? tgt : live), unitOf(c, fill), false, glow,
    effective === undefined ? undefined : unitOf(c, effective));
  if (u >= 0) {
    const np = posOf(c, u);
    if (np !== tgt) perfSet(c.id, np, ui.pointerShift);
  }

  const ramping = perfRamping(c.id), base = baseline(ui, cy, TYPE.micro);
  if (cel.label) ui.text.draw(ui.dl, cel.label, x, base, TYPE.micro, W.semibold,
    ramping ? COLOR.accent : C.cellLabel, 0, 0.08, 1);
  ui.text.draw(ui.dl, compactSliderValue(c, L && L.fadeLevel !== undefined ? L.fadeLevel : targetPos(c)),
    trackRight + INLINE_GAP, base, TYPE.micro, W.regular, C.value, 0, 0, 1);
}
function drawCell(ui, cel, x, top) { sliderCell(ui, cel, x, top); }

// ---------- the title bar's sliders ----------
// The shared interpolation time, immediate itself, written back once the
// hand lets go; beside it the window's own opacity, kept with its geometry.
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
const TITLE = 'MUSIC', WIN_O_LABEL = 'WINDOW OP';
let titleW = -1, rampLblW = 0, winOLblW = 0;
function capsW(ui, str, size, track) {
  return ui.text.measure(str, size, W.semibold) + str.length * size * track;
}
function barLabels(ui, label, lblW, readout, tx, trackW, cy, showLabel) {
  const dl = ui.dl, base = baseline(ui, cy, TYPE.micro);
  ui.text.draw(dl, readout, tx + trackW + INLINE_GAP, base, TYPE.micro, W.regular, C.value, 0, 0, 1);
  if (showLabel) {
    ui.text.draw(dl, label, tx - INLINE_GAP - lblW, base, TYPE.micro, W.semibold,
      C.sectionInk, 0, 0.08, 1);
  }
}
// Laid out left to right just after the title, the opacity first and the
// ramp after it, never past rightX. When room is short the labels go first,
// then the ramp, then the opacity, so neither the title nor the close button
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
  const rampId = ui.id('mus.ramp'), winOId = ui.id('mus.winO');
  // the shared record is written once the hand lets go, whether or not the
  // slider is still showing
  if (rampDirty && ui.activeId !== rampId) { savePerform(); rampDirty = false; }
  winOHeld = false;
  let gx = leftX;
  if (showWinO) {
    const tx = gx + (showLabels ? winOLblW + INLINE_GAP : 0);
    const wu = (music.winO - WIN_O_MIN) / (1 - WIN_O_MIN);
    const nu = hslider(ui, winOId, tx, cy, WINO_TRACK_W, wu, wu, false);
    if (ui.hover || ui.pressed) overBtn = true;
    if (nu >= 0) {
      winOHeld = true;
      music.winO = clampWinO(round2(WIN_O_MIN + nu * (1 - WIN_O_MIN)));
    }
    barLabels(ui, WIN_O_LABEL, winOLblW, PCT_TEXT[Math.round(music.winO * 100)], tx, WINO_TRACK_W, cy, showLabels);
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

// ---------- a row ----------
// One header, LEVEL, over the level column's track.
function gridHeader(ui) {
  const top = ui.cursorY;
  ui.spacer(GRID_HEAD_H);
  if (off(top, GRID_HEAD_H)) return;
  ui.text.draw(ui.dl, 'LEVEL', bodyX + NAME_W + LEVEL_TRACK / 2,
    baseline(ui, top + GRID_HEAD_H / 2, TYPE.micro), TYPE.micro, W.semibold,
    C.cellLabel, 1, 0.08, 1);
}

function rowBlock(ui, R, index) {
  const availW = bodyW - NAME_W;
  fitRow(R, availW);
  const h = BLOCK_PAD * 2 + R.linesH;
  const top = ui.cursorY;
  ui.spacer(h);
  if (off(top, h)) return;
  const dl = ui.dl;
  // A full name that will not fit its column gives way to the short one,
  // decided once, on the first draw.
  if (!R.nameFit) {
    R.nameFit = true;
    if (R.short && ui.text.measure(R.name, TYPE.sm, W.semibold) > NAME_W - SW_W - NAME_GAP - 6) R.name = R.short;
  }
  // Alternating full-width bands, and a quiet accent wash while any handle
  // in the row is still travelling through its ramp.
  let ramping = false;
  for (let i = 0; i < R.cells.length && !ramping; i++) ramping = perfRamping(R.cells[i].c.id);
  const bandX = bodyX - PAD_X, bandW = bodyW + PAD_X * 2;
  if (index & 1) dl.rect(bandX, top, bandW, h, 0, C.rowAlt, 0, null, 0, 0);
  if (ramping) dl.rect(bandX, top, bandW, h, 0, C.rowRamp, 0, null, 0, 0);
  if (index > 0) dl.rect(bandX, top, bandW, 1, 0, C.rowLine, 0, null, 0, 0);
  // a row fading out already reads as off; the Master is always on
  let on = true;
  if (R.t) {
    R.fadeLevel = perfLayerLevel(R.t.id);
    on = R.fadeLevel === undefined && !!targetPos(R.t);
  }
  R.shownOn = on;
  const onA = R.t ? ui.spring(ui.idx('mus.swA', R.k), on ? 1 : 0, MOTION.hover) : 1;
  // An off row reads as off at a glance: its band shaded darker, its name
  // and its handles dimmed well down, eased on the switch's own spring.
  const dim = 1 - onA;
  if (dim > 0.002) {
    const sh = ui.scratch0;
    sh[0] = 0; sh[1] = 0; sh[2] = 0; sh[3] = OFF_SHADE * dim;
    dl.rect(bandX, top + (index > 0 ? 1 : 0), bandW, h - (index > 0 ? 1 : 0), 0, sh, 0, null, 0, 0);
  }
  // With the music engine off, its five voices recede as an off row's name
  // does (and the tone and the pulse with the audio layer off),
  // does, the whole row at once, but stay live, so a mix can be set up in
  // silence and heard the moment the music comes on.
  const groupA = R.dimBy === 'music' ? 1 - OFF_NAME_DIM * musicDim
    : R.dimBy === 'audio' ? 1 - OFF_NAME_DIM * audioDim : 1;
  if (groupA < 0.998) dl.pushAlpha(groupA);
  const cy = top + BLOCK_PAD + ROW_H / 2;
  if (R.t) {
    const swY = cy - SW_H / 2;
    ui.interact(ui.idx('mus.sw', R.k), bodyX - 4, swY - 6, SW_W + 12, SW_H + 12, false);
    if (ui.hover) ui.setCursorHint('pointer');
    // fades over the ramp time through the row's level; shift-click cuts
    if (ui.clicked) perfLayer(R.t.id, R.op ? R.op.c.id : null, !on, ui.pointerShift);
    drawSwitch(ui, bodyX, swY, SW_W, SW_H, onA, on);
  }
  ui.text.draw(dl, R.name, bodyX + SW_W + NAME_GAP, baseline(ui, cy, TYPE.sm),
    TYPE.sm, W.semibold, on ? C.name : C.nameOff, 0, 0.02, 1 - OFF_NAME_DIM * dim);
  // the handles stay live while the row is off, only dimmed
  const handleA = 1 - OFF_HANDLE_DIM * dim;
  if (handleA < 0.998) dl.pushAlpha(handleA);
  drawRow(ui, R, bodyX + NAME_W, top + BLOCK_PAD, availW, drawCell);
  if (handleA < 0.998) dl.popAlpha();
  if (groupA < 0.998) dl.popAlpha();
}

// ---------- the window ----------
let btnHover = false, overBtn = false;
function barHit(ui, name, x, y, w, h) {
  ui.interact(ui.id(name), x, y, w, h, false);
  btnHover = ui.hover;
  if (ui.hover) { ui.setCursorHint('pointer'); overBtn = true; }
  return ui.clicked;
}

// fade is the chrome's pass-through, as the other windows take it; main
// hands the floating windows 1, so an open window holds at full strength.
export function drawMusic(ui, app, fade = 1) {
  if (!restored) restore();
  persist();
  const open = ui.spring('music.open', music.open ? 1 : 0, MOTION.panel);
  const o = open * fade;
  if (o < 0.002) { music.rw = 0; winOHeld = false; return; }
  const width = app.width, height = app.height;

  const maxW = Math.max(320, width - 24), minW = Math.min(WIN_MIN_W, maxW);
  const winW = Math.max(minW, Math.min(music.w, maxW));
  // Never taller than its rows (last frame's measure, 0 before the first
  // one): the saved or default height is a ceiling, so it opens fitted and a
  // drag down past the last row stops there.
  let maxH = Math.max(BAR_H + 120, height - 24);
  if (fitH > 0) maxH = Math.min(maxH, fitH);
  const minH = Math.min(WIN_MIN_H, maxH);
  const winH = Math.max(minH, Math.min(music.h, maxH));
  // first showing: centred, a little down from the top
  if (!music.placed) {
    music.placed = true;
    music.x = Math.max(12, (width - winW) / 2);
    music.y = Math.max(12, Math.min(48, height - winH - 12));
  }
  // keep the title bar reachable after any resize
  music.x = Math.max(12 - winW + 80, Math.min(music.x, width - 80));
  music.y = Math.max(12, Math.min(music.y, height - BAR_H - 12));
  const x = music.x, y = music.y + (1 - open) * 16;   // slides on open and shut only
  music.rx = x; music.ry = y; music.rw = winW; music.rh = winH;
  const dl = ui.dl;

  ui.pushScope(ui.id('music'));
  // the whole window, chrome and body, at the opacity its title bar sets
  dl.pushAlpha(o * music.winO);
  overBtn = false;

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
  if (barHit(ui, 'mus.close', closeX, cy - CLOSE_H / 2, closeW, CLOSE_H)) music.open = false;
  dl.rect(closeX, cy - CLOSE_H / 2, closeW, CLOSE_H, 6, C.btnBg, 1,
    btnHover ? C.closeHoverBorder : C.btnBorder, 0, 0);
  ui.text.draw(dl, '×', closeX + closeW / 2, baseline(ui, cy, 18), 18, W.regular,
    btnHover ? C.closeHoverInk : C.btnInk, 1, 0, 1);
  // laid before the drag below so they take their presses first and set
  // overBtn to keep the grab cursor off them
  barSliders(ui, x + 1 + 13, closeX - BAR_CLOSE_GAP, cy);

  // ---- lower right corner: both at once ----
  // Run first, so where it overlaps the two edges below it wins the press.
  ui.interact(ui.id('mus.resizeC'), x + winW - CORNER_GRAB, y + winH - CORNER_GRAB,
    CORNER_GRAB + GRAB_OUT, CORNER_GRAB + GRAB_OUT, false);
  if (ui.pressed) {
    if (!music.resizingC) {
      music.resizingC = true;
      music.grabW = ui.pointerX - (x + winW); music.grabH = ui.pointerY - (y + winH);
    }
    music.w = Math.max(minW, Math.min(ui.pointerX - music.grabW - x, maxW));
    music.h = Math.max(minH, Math.min(ui.pointerY - music.grabH - y, maxH));
    ui.setCursorHint('nwse-resize');
  } else {
    if (music.resizingC) { music.w = winW; music.h = winH; }
    music.resizingC = false;
    if (ui.hover) { ui.setCursorHint('nwse-resize'); overBtn = true; }
  }
  // the last cursor hint set wins, so over the corner the edges leave it alone
  const cornerHot = ui.hover || music.resizingC;
  // the grip: three dots on the diagonal, so the corner says it can be pulled
  for (let g = 0; g < 3; g++) {
    const gx = x + winW - 6 - g * 4, gy = y + winH - 6;
    for (let h2 = 0; h2 <= g; h2++) dl.rect(gx + h2 * 4 - 1, gy - h2 * 4 - 1, 2, 2, 1, C.cellLabel, 0, null, 0, 0);
  }

  // ---- right edge: horizontal resize ----
  ui.interact(ui.id('mus.resize'), x + winW - GRAB_IN, y, GRAB_IN + GRAB_OUT, winH, false);
  if (ui.pressed) {
    if (!music.resizing) { music.resizing = true; music.grabW = ui.pointerX - (x + winW); }
    music.w = Math.max(minW, Math.min(ui.pointerX - music.grabW - x, maxW));
    ui.setCursorHint('ew-resize');
  } else {
    if (music.resizing) music.w = winW;
    music.resizing = false;
    if (ui.hover && !cornerHot) { ui.setCursorHint('ew-resize'); overBtn = true; }
  }

  // ---- bottom edge: vertical resize ----
  ui.interact(ui.id('mus.resizeH'), x, y + winH - GRAB_IN, winW, GRAB_IN + GRAB_OUT, false);
  if (ui.pressed) {
    if (!music.resizingH) { music.resizingH = true; music.grabH = ui.pointerY - (y + winH); }
    music.h = Math.max(minH, Math.min(ui.pointerY - music.grabH - y, maxH));
    ui.setCursorHint('ns-resize');
  } else {
    if (music.resizingH) music.h = winH;
    music.resizingH = false;
    if (ui.hover && !cornerHot) { ui.setCursorHint('ns-resize'); overBtn = true; }
  }

  // ---- title bar drag, the offset taken on press so the window never jumps ----
  ui.interact(ui.id('mus.drag'), x, y, winW, BAR_H, false);
  if (ui.pressed) {
    if (!music.dragging) { music.dragging = true; music.grabX = ui.pointerX - music.x; music.grabY = ui.pointerY - music.y; }
    music.x = ui.pointerX - music.grabX; music.y = ui.pointerY - music.grabY;
    ui.setCursorHint('grabbing');
  } else {
    music.dragging = false;
    if (ui.hover && !overBtn) ui.setCursorHint('grab');
  }

  // ---- body ----
  musicDim = MUSIC_ON ? ui.spring(ui.id('mus.musicDim'), targetPos(MUSIC_ON) ? 0 : 1, MOTION.hover) : 0;
  audioDim = AUDIO_ON ? ui.spring(ui.id('mus.audioDim'), targetPos(AUDIO_ON) ? 0 : 1, MOTION.hover) : 0;
  const cx0 = ui.cursorX, cy0 = ui.cursorY, cw0 = ui.regionW;
  const bodyTop = y + BAR_H + 1, bodyH = winH - BAR_H - 2;
  viewTop = bodyTop; viewBot = bodyTop + bodyH;
  ui.setCursor(x + 1, bodyTop, winW - 2);
  ui.scroll('mus.body', bodyH);
  const contentTop = ui.cursorY;
  bodyX = ui.cursorX + PAD_X; bodyW = ui.regionW - PAD_X * 2;
  gridHeader(ui);
  for (let i = 0; i < ROWS.length; i++) rowBlock(ui, ROWS[i], i);

  ui.spacer(PAD_B);
  fitH = BAR_H + 2 + Math.ceil(ui.cursorY - contentTop);
  ui.endScroll();
  ui.setCursor(cx0, cy0, cw0);

  // clicks on empty pane stop here instead of reaching the drawer or field
  ui.interact(ui.id('mus.backstop'), x, y, winW, winH, false);
  dl.popAlpha();
  ui.popScope();
}
