// The Brush section's controls and the state behind them: the motif a
// stroke on the field stamps (a tile of the current Image set's atlas,
// picked from the drawer's grid), how many copies of it turn about the
// field's centre, and how long a mark takes to fade. The drawing itself is
// core/brush.js and gpu/brush.js.
//
// These are the hand's own instrument, not the scene: a preset, a journey
// step and a followed broadcast never move them (core/presets.js
// machineControl names the section), and they are kept in a record of their
// own (store.js saveBrush, 'signal.v1.brush'), never in the shared settings
// object or the extra record, which are what a snapshot carries. Every
// control saves on change and comes back on reload.
import { saveBrush } from './store.js';
import { brushAtlas, brushStatusLine, brushConducting, brushPhase, brushRound, brushSetPhase, brushNext, brushPickAtlas, brushMember } from './brush.js';
import { fadeLabel, fadeFromText, rateLabel, BRUSH_W, ROTATE_MAX } from './brush-stamps.js';
import { kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';

const DEF_MOTIF = 0, DEF_SIZE = BRUSH_W, DEF_ROTATE = 0, DEF_SPIN = 0, DEF_COPIES = 6, DEF_FADE = 0.5, DEF_RATE = 1;
// The dealt brushes: off, four each (fifteen people take sixty of a set's
// sixty-four tiles, none twice), and the follower screens' bottom buttons
// hidden. The room's Stream and Smoothing, ms (the conductor's).
const DEF_DEAL = false, DEF_DEAL_N = 4, DEF_HIDE_FOLLOW = true, DEF_STREAM = 20, DEF_SMOOTH = 30;
// Brush notes: off (core/brush-notes.js, js/brush-bells.js).
const DEF_NOTES = false;

// Seeds every brush field not already on S. Called first thing in
// store.load(), beside the layers' own.
export function initBrushState(S) {
  if (typeof S.brushMotif !== 'number') S.brushMotif = DEF_MOTIF;
  if (typeof S.brushSize !== 'number') S.brushSize = DEF_SIZE;
  if (typeof S.brushSpin !== 'number') S.brushSpin = DEF_SPIN;
  if (typeof S.brushRotate !== 'number') S.brushRotate = DEF_ROTATE;
  if (typeof S.brushCopies !== 'number') S.brushCopies = DEF_COPIES;
  if (typeof S.brushFade !== 'number') S.brushFade = DEF_FADE;
  if (typeof S.brushRate !== 'number') S.brushRate = DEF_RATE;
  if (typeof S.brushDeal !== 'boolean') S.brushDeal = DEF_DEAL;
  if (typeof S.brushDealN !== 'number') S.brushDealN = DEF_DEAL_N;
  if (typeof S.brushHideFollow !== 'boolean') S.brushHideFollow = DEF_HIDE_FOLLOW;
  if (typeof S.brushStream !== 'number') S.brushStream = DEF_STREAM;
  if (typeof S.brushSmooth !== 'number') S.brushSmooth = DEF_SMOOTH;
  if (typeof S.brushNotes !== 'boolean') S.brushNotes = DEF_NOTES;
}

// What the record holds.
export function brushStateOf(S) {
  return { brushMotif: S.brushMotif, brushSize: S.brushSize, brushSpin: S.brushSpin, brushRotate: S.brushRotate, brushCopies: S.brushCopies, brushRate: S.brushRate, brushFade: S.brushFade,
           brushDeal: S.brushDeal, brushDealN: S.brushDealN, brushHideFollow: S.brushHideFollow,
           brushStream: S.brushStream, brushSmooth: S.brushSmooth, brushNotes: S.brushNotes };
}

// The record read back, field by field, each held to its range: the tile
// and the copies whole numbers, the rate and the fade levels in 0..1. Anything missing
// or malformed is left as it is.
export function applyBrushState(S, o) {
  if (!o || typeof o !== 'object') return;
  const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  if (Number.isFinite(o.brushMotif)) S.brushMotif = n(o.brushMotif, 0, 63);
  if (Number.isFinite(o.brushSize)) S.brushSize = n(o.brushSize, 1, 100);
  if (Number.isFinite(o.brushSpin)) S.brushSpin = Math.max(0, Math.min(ROTATE_MAX, o.brushSpin));
  if (Number.isFinite(o.brushRotate)) S.brushRotate = Math.max(0, Math.min(ROTATE_MAX, o.brushRotate));
  if (Number.isFinite(o.brushCopies)) S.brushCopies = n(o.brushCopies, 1, 24);
  if (Number.isFinite(o.brushFade)) S.brushFade = Math.max(0, Math.min(1, o.brushFade));
  if (Number.isFinite(o.brushRate)) S.brushRate = Math.max(0, Math.min(1, o.brushRate));
  if (typeof o.brushDeal === 'boolean') S.brushDeal = o.brushDeal;
  if (Number.isFinite(o.brushDealN)) S.brushDealN = n(o.brushDealN, 1, 8);
  if (typeof o.brushHideFollow === 'boolean') S.brushHideFollow = o.brushHideFollow;
  if (typeof o.brushNotes === 'boolean') S.brushNotes = o.brushNotes;
  if (Number.isFinite(o.brushStream)) S.brushStream = n(o.brushStream, 10, 60);
  if (Number.isFinite(o.brushSmooth)) S.brushSmooth = n(o.brushSmooth, 0, 200);
}

const phaseOpts = (pairs, quads) => [
  { value: 'solo',   label: 'Alone',    domId: null },
  { value: 'master', label: 'Master',   domId: null },
  { value: 'pairs',  label: pairs,      domId: null },
  { value: 'quads',  label: quads,      domId: null },
  { value: 'halves', label: 'Halves',   domId: null },
  { value: 'all',    label: 'Together', domId: null }
];
const PHASE_OPTS = phaseOpts('Pairs', 'Fours');
const PHASE_OPTS_PAIRS2 = phaseOpts('Pairs 2', 'Fours');
const PHASE_OPTS_QUADS2 = phaseOpts('Pairs', 'Fours 2');

export const BRUSH_CONTROLS = [
  // The picker: the current Image set's painted tiles as a grid of
  // thumbnails (widgets.js tiles). tiles(S) hands it the atlas as the GPU
  // side has it (core/brush.js brushAtlas) and says which set it wants
  // shown, so the atlas loads the first time the grid is drawn.
  {
    id: 'brushMotif', section: 'brush', label: 'Shape', kind: 'tiles', def: DEF_MOTIF,
    get: S => S.brushMotif,
    set: (S, v) => { S.brushMotif = Math.max(0, Math.min(63, Math.round(Number(v) || 0))); brushPickAtlas(); saveBrush(); },
    tiles: S => { brushAtlas.want = kaleidoscopeSet(S.kaleidoSet).id; return brushAtlas; }
  },
  // How large the shape is stamped, 1 to 100 (the wire's w; 100 is a
  // quarter of the field across). In a broadcast room the conductor's is
  // the room's: it goes to the hall with Stream and Smoothing and every
  // member's own strokes are drawn at it, so a member has no row of its own.
  {
    id: 'brushSize', section: 'brush', label: 'Size', kind: 'slider',
    min: 1, max: 100, step: 1, def: DEF_SIZE,
    get: S => S.brushSize,
    set: (S, pos) => { S.brushSize = Math.max(1, Math.min(100, Math.round(pos))); saveBrush(); },
    formatAt: pos => String(pos),
    visible: () => !brushMember()
  },
  // How fast the shape itself turns, in turns a second, 0 (still) to
  // ROTATE_MAX (core/brush-stamps.js), a tenth of a turn a step: each stamp
  // is laid down at the angle the shared clock gives its moment
  // (core/brush.js brushSpinAt), so only this speed is ever sent. The room's,
  // like Size: the conductor's goes to every member.
  {
    id: 'brushSpin', section: 'brush', label: 'Shape rotation', kind: 'slider',
    min: 0, max: Math.round(ROTATE_MAX * 10), step: 1, def: Math.round(DEF_SPIN * 10),
    get: S => Math.round(S.brushSpin * 10),
    set: (S, pos) => { S.brushSpin = Math.max(0, Math.min(Math.round(ROTATE_MAX * 10), Math.round(pos))) / 10; saveBrush(); },
    formatAt: pos => pos === 0 ? 'Off' : (pos / 10).toFixed(1) + ' /s',
    visible: () => !brushMember()
  },
  // How fast the whole trail image turns about the field's centre, in turns
  // a second, same range (the feedback's twist). The room's, like Size.
  {
    id: 'brushRotate', section: 'brush', label: 'Feedback rotation', kind: 'slider',
    min: 0, max: Math.round(ROTATE_MAX * 10), step: 1, def: Math.round(DEF_ROTATE * 10),
    get: S => Math.round(S.brushRotate * 10),
    set: (S, pos) => { S.brushRotate = Math.max(0, Math.min(Math.round(ROTATE_MAX * 10), Math.round(pos))) / 10; saveBrush(); },
    formatAt: pos => pos === 0 ? 'Off' : (pos / 10).toFixed(1) + ' /s',
    visible: () => !brushMember()
  },
  {
    id: 'brushCopies', section: 'brush', label: 'Copies', kind: 'slider',
    min: 1, max: 24, step: 1, def: DEF_COPIES,
    get: S => S.brushCopies,
    set: (S, pos) => { S.brushCopies = Math.max(1, Math.min(24, Math.round(pos))); saveBrush(); },
    formatAt: pos => String(pos)
  },
  // How the brush lays its shape down (core/brush-stamps.js): at the top,
  // Frame rate, a continuous ribbon along the hand; below it, separate
  // prints dropped as the hand drags, 60 a second down to 1.
  {
    id: 'brushRate', section: 'brush', label: 'Rate', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(DEF_RATE * 100),
    get: S => Math.round(S.brushRate * 100),
    set: (S, pos) => { S.brushRate = Math.max(0, Math.min(100, Math.round(pos))) / 100; saveBrush(); },
    formatAt: pos => rateLabel(pos / 100),
    parse: (S, text) => {
      if (/frame/i.test(text)) return 100;
      const n = parseFloat(text);
      if (!(n > 0)) return NaN;
      if (n > 60) return 100;
      return Math.round(99 * Math.log(Math.max(1, n)) / Math.log(60));
    }
  },
  // How long a mark takes to fade away, 1 s to a minute (core/brush-stamps.js
  // fadeSeconds): the trail image's half-life is a fifth of it.
  {
    id: 'brushFade', section: 'brush', label: 'Fade', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(DEF_FADE * 100),
    get: S => Math.round(S.brushFade * 100),
    set: (S, pos) => { S.brushFade = Math.max(0, Math.min(100, pos)) / 100; saveBrush(); },
    formatAt: pos => fadeLabel(pos / 100),
    parse: (S, text) => { const f = fadeFromText(text); return f === f ? Math.round(f * 100) : NaN; },
    // the broadcast room the brush draws in, while this screen broadcasts
    // or follows one
    statusLine: () => brushStatusLine()
  },
  // The conductor's phases, in the hall's order (broadcast-worker/src/groups.js
  // PHASES) and /touch/'s words. A live show control, not a setting: it
  // reads the hall's phase and sends the hall {t:'phase', p} (touch/hall.js
  // setPhase), and nothing of it is saved. Shown only to a conductor. No
  // def, so a click on its name never moves the room back to Alone.
  // Pressing the lit Pairs or Fours again asks for its next round (retap;
  // touch/hall.js tapStep), and the chip names the round the hall says,
  // 'Pairs 2': the options are one of three fixed lists, picked by the
  // hall's phase and round, so the labels are built once.
  {
    id: 'brushPhase', section: 'brush', label: 'Phase', kind: 'segment', retap: true,
    get options() {
      const r = brushRound();
      if (r > 1 && brushPhase() === 'pairs') return PHASE_OPTS_PAIRS2;
      if (r > 1 && brushPhase() === 'quads') return PHASE_OPTS_QUADS2;
      return PHASE_OPTS;
    },
    get: () => brushPhase(),
    set: (S, v) => brushSetPhase(v),
    visible: () => brushConducting()
  },
  // Next walks the show's script: Alone, Master, Pairs, Pairs 2, Fours,
  // Fours 2, Together (broadcast-worker/src/groups.js SCRIPT).
  {
    id: 'brushNext', section: 'brush', label: 'Next', kind: 'action',
    act: () => brushNext(),
    visible: () => brushConducting()
  },
  // The room's own settings, the conductor's alone (the hall re-tells them
  // to everyone; core/brush.js dealTick sends them): Stream, how often every
  // hand sends a batch of its stroke, and Smoothing, how far past that every
  // screen holds a remote stroke back to play it smoothly (its jitter
  // margin; a late batch still raises it there).
  {
    id: 'brushStream', section: 'brush', label: 'Stream', kind: 'slider',
    min: 10, max: 60, step: 1, def: DEF_STREAM,
    get: S => S.brushStream,
    set: (S, pos) => { S.brushStream = Math.max(10, Math.min(60, Math.round(pos))); saveBrush(); },
    formatAt: pos => pos + ' ms',
    visible: () => brushConducting()
  },
  {
    id: 'brushSmooth', section: 'brush', label: 'Smoothing', kind: 'slider',
    min: 0, max: 200, step: 1, def: DEF_SMOOTH,
    get: S => S.brushSmooth,
    set: (S, pos) => { S.brushSmooth = Math.max(0, Math.min(200, Math.round(pos))); saveBrush(); },
    formatAt: pos => pos + ' ms',
    visible: () => brushConducting()
  },
  // The dealt brushes: on, in a broadcast room the broadcasting screen's
  // switch deals every screen in it (itself too), and on a screen in no
  // room it deals this screen its own hand at once; in a room the room deals
  // every member (the conductor too)
  // its own tiles of the current Image set, none twice in the room
  // (broadcast-worker/src/deal.js), shown as a strip of buttons on their
  // screens (ui/screens/hand.js). It goes to the hall while this screen
  // conducts one.
  {
    id: 'brushDeal', section: 'brush', label: 'Show brushes', kind: 'toggle', def: DEF_DEAL,
    get: S => S.brushDeal === true,
    set: (S, on) => { S.brushDeal = !!on; saveBrush(); }
  },
  {
    id: 'brushDealN', section: 'brush', label: 'Brushes each', kind: 'slider',
    min: 1, max: 8, step: 1, def: DEF_DEAL_N,
    get: S => S.brushDealN,
    set: (S, pos) => { S.brushDealN = Math.max(1, Math.min(8, Math.round(pos))); saveBrush(); },
    formatAt: pos => String(pos),
    visible: S => S.brushDeal === true
  },
  // Brush notes: every hand a bell, the field four bands of its own notes,
  // a strike as a stroke enters each band (core/brush-notes.js). This
  // screen's own: a follower can silence the bells it hears.
  {
    id: 'brushNotes', section: 'brush', label: 'Brush notes', kind: 'toggle', def: DEF_NOTES,
    get: S => S.brushNotes === true,
    set: (S, on) => { S.brushNotes = !!on; saveBrush(); }
  },
  // The quick bar (bottom right: the Text, Tone, Music and Atmosphere chips
  // and the full screen button) left off a follower's screen: a tab
  // following a broadcast (a drawer in its room).
  {
    id: 'brushHideFollow', section: 'brush', label: 'Hide bottom buttons for followers', kind: 'toggle', def: DEF_HIDE_FOLLOW,
    get: S => S.brushHideFollow !== false,
    set: (S, on) => { S.brushHideFollow = !!on; saveBrush(); }
  }
];

export const BRUSH_SECTIONS = [
  { id: 'brush', title: 'Brush' }
];
