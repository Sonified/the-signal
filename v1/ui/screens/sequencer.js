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
// them. Four patterns sit in slots along the toolbar; the one selected is
// the one that plays. Pattern 1 is the original 3 4 8 figure.
//
// Everything it edits lives on S (seqPatterns, seqSlot) and is saved through
// store.js; the engine (js/piano.js) reads it step by step, so an edit is
// heard from the next step on.
import { S } from '../../../js/state.js';
import { SEQ_ROWS, SEQ_MAX, SEQ_SLOTS, seqRandomize, applyArp } from '../../../js/piano.js';
// the playhead through the mirror, which reads it from the page in worker mode
import { seqPlayheadNow } from '../../core/audio-mirror.js';
import { loadUiState, saveUiState, save } from '../../core/store.js';
import { byId } from '../../core/schema.js';
import { W, MOTION } from '../theme.js';

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
  sectionInk: css('#5f6c7c'), valueInk: css('#d6e0e8')
};

// ---------- sizes ----------
const RADIUS_WIN = 9, BAR_H = 33, PAD = 12;
const BTN_H = 21, CLOSE_H = 22, BTN_PAD_X = 9, CLOSE_PAD_X = 7, BAR_GAP = 9;
const TOOL_H = 34;
const CELL = 22, CELL_GAP = 3, LABEL_W = 20;
const ROWS = SEQ_ROWS.length;
const ROW_LABELS = ['15', '14', '13', '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1'];
const WIN_W = PAD * 2 + LABEL_W + SEQ_MAX * CELL + (SEQ_MAX - 1) * CELL_GAP;
const GRID_H = ROWS * CELL + (ROWS - 1) * CELL_GAP;
const NUM_H = 16;            // the step numbers under the grid
const WIN_H = BAR_H + 1 + TOOL_H + GRID_H + NUM_H + PAD + 4;
const STEP_LABELS = Array.from({ length: SEQ_MAX }, (_, i) => String(i + 1));

// alpha is the window's own opacity, set by the slider beside the title;
// floored so the window can never be lost entirely.
const ALPHA_MIN = 0.15;
// The slider is logarithmic: most of its travel only dims the window a
// little, and the fade deepens quickly toward the left end. u is the knob's
// place, 0..1 across; ALPHA_K sets how strongly the curve bends.
const ALPHA_K = 20, ALPHA_LN = Math.log(1 + ALPHA_K);
const uToAlpha = u => ALPHA_MIN + (1 - ALPHA_MIN) * Math.log(1 + ALPHA_K * u) / ALPHA_LN;
const alphaToU = a => (Math.exp((a - ALPHA_MIN) / (1 - ALPHA_MIN) * ALPHA_LN) - 1) / ALPHA_K;
export const sequencer = { open: false, placed: false, x: 0, y: 0, alpha: 1, dragging: false, grabX: 0, grabY: 0, alphaDrag: false,
  rx: 0, ry: 0, rw: 0, rh: 0 };   // where it was drawn last frame (rw 0: not showing), for stacking

// ---------- persistence of the window, as the mixer's ----------
let restored = false;
const saved = { open: false, placed: false, x: 0, y: 0, alpha: 1 };
function restore() {
  restored = true;
  const all = loadUiState();
  const m = all && all.sequencer && typeof all.sequencer === 'object' ? all.sequencer : null;
  if (m) {
    sequencer.open = !!m.open;
    if (m.placed && Number.isFinite(m.x) && Number.isFinite(m.y)) { sequencer.placed = true; sequencer.x = m.x; sequencer.y = m.y; }
    if (Number.isFinite(m.alpha)) sequencer.alpha = Math.max(ALPHA_MIN, Math.min(1, m.alpha));
  }
  remember();
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
function btn(ui, name, x, y, w, h) {
  ui.interact(ui.id(name), x, y, w, h, false);
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

const SLOT_LABELS = ['1', '2', '3', '4'];

// The step rate: a second surface on the drawer's Sequencer speed control,
// reading and writing through it so the two can never disagree.
const RATE = byId('arpRate');
let rateShown = NaN, rateText = '';

// fade is the chrome's idle fade, as the mixer's.
export function drawSequencer(ui, app, fade = 1) {
  if (!restored) restore();
  persist();
  const open = ui.spring('seq.open', sequencer.open ? 1 : 0, MOTION.panel);
  const o = open * fade;
  if (o < 0.002) { sequencer.rw = 0; return; }
  const width = app.width, height = app.height;
  const winW = Math.min(WIN_W, width - 24), h = WIN_H;
  // first showing: under the mixer's usual place, right side
  if (!sequencer.placed) { sequencer.placed = true; sequencer.x = Math.max(12, width - winW - 24); sequencer.y = Math.max(12, height - h - 90); }
  sequencer.x = Math.max(12 - winW + 80, Math.min(sequencer.x, width - 80));
  sequencer.y = Math.max(12, Math.min(sequencer.y, height - BAR_H - 12));
  const x = sequencer.x, y = sequencer.y + (1 - open) * 16;
  sequencer.rx = x; sequencer.ry = y; sequencer.rw = winW; sequencer.rh = h;
  const dl = ui.dl;
  const pat = S.seqPatterns[S.seqSlot | 0] || S.seqPatterns[0];

  ui.pushScope(ui.id('seq'));
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
  const powerLabel = S.arpOn ? 'on' : 'off';
  const powerW = measureBtn(ui, powerLabel, 10);
  const powerX = closeX - BAR_GAP - powerW;

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

  // the window's opacity, a small slider right of the title; a press jumps
  // it there and dragging follows
  const ax = lightX + 6 + BAR_GAP + ui.text.measure('SEQUENCER', 11, W.semibold) + 14, aw = 80;
  ui.interact(ui.id('seq.alpha'), ax - 6, cy - 9, aw + 12, 18, false);
  if (ui.hover || ui.pressed) { ui.setCursorHint('ew-resize'); overBtn = true; }
  const aHover = ui.hover || ui.pressed;
  if (ui.pressed) {
    sequencer.alphaDrag = true;
    sequencer.alpha = uToAlpha(Math.max(0, Math.min(1, (ui.pointerX - ax) / aw)));
  } else sequencer.alphaDrag = false;
  const au = Math.max(0, Math.min(1, alphaToU(sequencer.alpha)));
  dl.rect(ax, cy - 1.5, aw, 3, 1.5, C.btnBorder, 0, null, 0, 0);
  dl.rect(ax, cy - 1.5, aw * au, 3, 1.5, C.label, 0, null, 0, 0);
  const kr = aHover ? 6 : 5;
  dl.rect(ax + aw * au - kr, cy - kr, kr * 2, kr * 2, kr, aHover ? C.btnOnInk : C.label, 0, null, 0, 0);

  // the step rate, the same kind of slider after it, with its value beside
  if (RATE) {
    const rx = ax + aw + 18, rw = 80;
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

  if (btn(ui, 'seq.power', powerX, cy - BTN_H / 2, powerW, BTN_H)) { S.arpOn = !S.arpOn; applyArp(); save(); }
  dl.rect(powerX, cy - BTN_H / 2, powerW, BTN_H, 6, C.btnBg, 1,
    S.arpOn ? C.powerBorder : btnHover ? C.btnBorderHover : C.btnBorder, 0, 0);
  ui.text.draw(dl, powerLabel, powerX + powerW / 2, baseline(ui, cy, 10), 10, W.regular, S.arpOn ? C.powerInk : C.btnInk, 1, 0, 1);

  if (btn(ui, 'seq.close', closeX, cy - CLOSE_H / 2, closeW, CLOSE_H)) sequencer.open = false;
  dl.rect(closeX, cy - CLOSE_H / 2, closeW, CLOSE_H, 6, C.btnBg, 1, btnHover ? C.closeHoverBorder : C.btnBorder, 0, 0);
  ui.text.draw(dl, '×', closeX + closeW / 2, baseline(ui, cy, 18), 18, W.regular, btnHover ? C.closeHoverInk : C.btnInk, 1, 0, 1);

  // ---- toolbar: pattern slots, length, randomize, clear ----
  const ty = y + BAR_H + 1 + TOOL_H / 2;
  let tx = x + PAD;
  ui.text.draw(dl, 'PATTERN', tx, baseline(ui, ty, 9), 9, W.semibold, C.sectionInk, 0, 0.1, 1);
  tx += ui.text.measure('PATTERN', 9, W.semibold) + 8;
  for (let i = 0; i < SEQ_SLOTS; i++) {
    const w = 22;
    if (btn(ui, 'seq.slot' + i, tx, ty - BTN_H / 2, w, BTN_H) && S.seqSlot !== i) { S.seqSlot = i; save(); }
    drawBtn(ui, tx, ty, w, BTN_H, S.seqSlot === i, SLOT_LABELS[i], 10);
    tx += w + 4;
  }
  tx += 10;
  ui.text.draw(dl, 'LENGTH', tx, baseline(ui, ty, 9), 9, W.semibold, C.sectionInk, 0, 0.1, 1);
  tx += ui.text.measure('LENGTH', 9, W.semibold) + 8;
  if (btn(ui, 'seq.lenDown', tx, ty - BTN_H / 2, 20, BTN_H) && pat.len > 1) { pat.len--; save(); }
  drawBtn(ui, tx, ty, 20, BTN_H, false, '−', 12);
  tx += 20;
  ui.text.draw(dl, String(pat.len), tx + 14, baseline(ui, ty, 11), 11, W.semibold, C.valueInk, 1, 0, 1);
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
  const head = S.arpOn && S.running ? seqPlayheadNow() : -1;
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
