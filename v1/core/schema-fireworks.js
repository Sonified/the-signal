// The Fireworks layer's controls and the state behind them. New in v1, like
// the Particles, so the S field names here are the contract v1/gpu/fireworks.js
// reads, and the defaults, ranges and persistence helpers sit beside the
// controls so the one list of firework fields cannot drift between the
// drawer, the saved session and a preset.
//
// Persistence stays out of the shared v0 settings object for the reason the
// other v1 layers give: v0's saveSettings() writes a fixed list of keys. The
// store writes these into the v1 extra record through fireworkStateOf() and
// applyFireworkState().
import { save } from './store.js';

// The presets, as v1/gpu/fireworks.js reads S.fwMode: Scatter (one show at a
// time toward a corner, falling down the screen), Four corners (four
// identical shows at once, symmetric about the centre) and Centre out
// (bursts deep in the middle that fly out past the edges). In the last two
// gravity pulls toward the viewer.
const MODES = ['scatter', 'corners', 'centre'];
const DEF_MODE = 'scatter';

const NUM = [
  // key,       min, max, def
  ['fwRate',    1,   60,  10  ],   // shows per minute, on average
  ['fwSize',    0.4, 2,   1   ],   // how far a burst reaches
  ['fwBright',  0,   1,   0.9 ]
];

function fit(v, min, max) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return Math.round(v * 10000) / 10000;
}

function spec(key) {
  for (let i = 0; i < NUM.length; i++) if (NUM[i][0] === key) return NUM[i];
  return null;
}

// Seeds every firework field not already on S. Called first thing in
// store.load(), beside the other v1 layers' seeds, and only fills gaps.
export function initFireworkState(S) {
  if (typeof S.layers.fireworks !== 'boolean') S.layers.fireworks = false;
  if (MODES.indexOf(S.fwMode) < 0) S.fwMode = DEF_MODE;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the firework state, the shape the store writes and a preset
// snapshot carries. The layer switch goes under its own flat name, as
// particlesOn does.
export function fireworkStateOf(S) {
  const out = { fireworksOn: !!S.layers.fireworks, fwMode: S.fwMode };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a record holds, field by field, leaving anything missing
// or malformed as it is and clamping numbers into range.
export function applyFireworkState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.fireworksOn === 'boolean') S.layers.fireworks = o.fireworksOn;
  if (MODES.indexOf(o.fwMode) >= 0) S.fwMode = o.fwMode;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2]);
  }
}

// Every row dims while the layer is off, as the Particles section's do.
const layerOn = S => !!S.layers.fireworks;

export const FIREWORK_CONTROLS = [
  // In the Layers group after Particles. Off by default, so a first visit
  // looks exactly as it did before.
  {
    id: 'lFireworks', section: 'layers', label: 'Fireworks', kind: 'toggle', def: false,
    get: S => !!S.layers.fireworks,
    set: (S, on) => { S.layers.fireworks = on; save(); }
  },
  // The same switch at the head of the Fireworks section (the drawer puts it
  // in the header). No enabled(), so it never dims itself.
  {
    id: 'fireworksOn', section: 'fireworks', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.fireworks,
    set: (S, on) => { S.layers.fireworks = on; save(); }
  },
  {
    id: 'fwMode', section: 'fireworks', label: 'Preset', kind: 'segment', def: DEF_MODE,
    options: [
      { value: 'scatter', label: 'Scatter',      domId: null },
      { value: 'corners', label: 'Four corners', domId: null },
      { value: 'centre',  label: 'Centre out',   domId: null }
    ],
    get: S => S.fwMode,
    set: (S, v) => { S.fwMode = MODES.indexOf(v) >= 0 ? v : DEF_MODE; save(); },
    enabled: layerOn
  },
  {
    id: 'fwRate', section: 'fireworks', label: 'How often', kind: 'slider',
    min: 1, max: 60, step: 1, def: spec('fwRate')[3],
    get: S => S.fwRate,
    set: (S, pos) => { S.fwRate = fit(pos, 1, 60); save(); },
    format: S => Math.round(S.fwRate) + ' / min',
    enabled: layerOn
  },
  {
    id: 'fwSize', section: 'fireworks', label: 'Size', kind: 'slider',
    min: 0.4, max: 2, step: 0.05, def: spec('fwSize')[3],
    get: S => S.fwSize,
    set: (S, pos) => { S.fwSize = fit(pos, 0.4, 2); save(); },
    format: S => S.fwSize.toFixed(2) + '×',
    enabled: layerOn
  },
  {
    id: 'fwBright', section: 'fireworks', label: 'Brightness', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('fwBright')[3] * 100),
    get: S => Math.round(S.fwBright * 100),
    set: (S, pos) => { S.fwBright = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.fwBright * 100) + '%',
    enabled: layerOn
  }
];

export const FIREWORK_SECTIONS = [
  { id: 'fireworks', title: 'Fireworks' }
];
