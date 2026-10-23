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
import { brushAtlas, brushStatusLine, brushConducting, brushPhase, brushSetPhase } from './brush.js';
import { fadeLabel, fadeFromText, rateLabel } from './brush-stamps.js';
import { kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';

const DEF_MOTIF = 0, DEF_COPIES = 6, DEF_FADE = 0.5, DEF_RATE = 1;

// Seeds every brush field not already on S. Called first thing in
// store.load(), beside the layers' own.
export function initBrushState(S) {
  if (typeof S.brushMotif !== 'number') S.brushMotif = DEF_MOTIF;
  if (typeof S.brushCopies !== 'number') S.brushCopies = DEF_COPIES;
  if (typeof S.brushFade !== 'number') S.brushFade = DEF_FADE;
  if (typeof S.brushRate !== 'number') S.brushRate = DEF_RATE;
}

// What the record holds.
export function brushStateOf(S) {
  return { brushMotif: S.brushMotif, brushCopies: S.brushCopies, brushRate: S.brushRate, brushFade: S.brushFade };
}

// The record read back, field by field, each held to its range: the tile
// and the copies whole numbers, the rate and the fade levels in 0..1. Anything missing
// or malformed is left as it is.
export function applyBrushState(S, o) {
  if (!o || typeof o !== 'object') return;
  const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  if (Number.isFinite(o.brushMotif)) S.brushMotif = n(o.brushMotif, 0, 63);
  if (Number.isFinite(o.brushCopies)) S.brushCopies = n(o.brushCopies, 1, 24);
  if (Number.isFinite(o.brushFade)) S.brushFade = Math.max(0, Math.min(1, o.brushFade));
  if (Number.isFinite(o.brushRate)) S.brushRate = Math.max(0, Math.min(1, o.brushRate));
}

export const BRUSH_CONTROLS = [
  // The picker: the current Image set's painted tiles as a grid of
  // thumbnails (widgets.js tiles). tiles(S) hands it the atlas as the GPU
  // side has it (core/brush.js brushAtlas) and says which set it wants
  // shown, so the atlas loads the first time the grid is drawn.
  {
    id: 'brushMotif', section: 'brush', label: 'Shape', kind: 'tiles', def: DEF_MOTIF,
    get: S => S.brushMotif,
    set: (S, v) => { S.brushMotif = Math.max(0, Math.min(63, Math.round(Number(v) || 0))); saveBrush(); },
    tiles: S => { brushAtlas.want = kaleidoscopeSet(S.kaleidoSet).id; return brushAtlas; }
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
  // prints dropped as the hand drags, 8 a second down to 1.
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
      if (n >= 8.5) return 100;
      return Math.round(99 * Math.log(Math.max(1, n)) / Math.log(8));
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
    // the hall the brush is joined to, when the page was opened with one
    statusLine: () => brushStatusLine()
  },
  // The conductor's phases, in the hall's order (broadcast-worker/src/groups.js
  // PHASES) and /touch/'s words. A live show control, not a setting: it
  // reads the hall's phase and sends the hall {t:'phase', p} (touch/hall.js
  // setPhase), and nothing of it is saved. Shown only to a conductor. No
  // def, so a click on its name never moves the room back to Alone.
  {
    id: 'brushPhase', section: 'brush', label: 'Phase', kind: 'segment',
    options: [
      { value: 'solo',   label: 'Alone',    domId: null },
      { value: 'master', label: 'Master',   domId: null },
      { value: 'pairs',  label: 'Pairs',    domId: null },
      { value: 'quads',  label: 'Fours',    domId: null },
      { value: 'halves', label: 'Halves',   domId: null },
      { value: 'all',    label: 'Together', domId: null }
    ],
    get: () => brushPhase(),
    set: (S, v) => brushSetPhase(v),
    visible: () => brushConducting()
  }
];

export const BRUSH_SECTIONS = [
  { id: 'brush', title: 'Brush' }
];
