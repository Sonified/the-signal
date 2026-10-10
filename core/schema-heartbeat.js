// The Heartbeat layer's controls and the state behind them, modeled on
// schema-sun.js: new in v1, no v0 handler or DOM ids, so the S field names
// here are the contract gpu/heartbeat.js reads, and the defaults, ranges and
// persistence helpers live beside the controls so the one list of heartbeat
// fields cannot drift between the drawer, the saved session and a preset.
//
// Persistence goes in the v1 extra record (store.js), through
// heartbeatStateOf() and applyHeartbeatState(), for the same reason the
// sun's does: v0's saveSettings() would drop keys it does not know.
//
// The three rows are one law: the heard gain is heartMaster * heartAudio,
// the flash's amount heartMaster * heartVisual * the beat's brightness.
// Master rides both together at the balance the other two set.
import { save } from './store.js';

const NUM = [
  // key,          min, max, def, integer
  ['heartMaster',  0,   1,   1,   false],
  ['heartAudio',   0,   1,   0.8, false],
  ['heartVisual',  0,   1,   0.8, false]
];

// Trims a slider's position to the step's precision and clamps it into
// range (schema-sun.js's fit).
function fit(v, min, max, integer) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return integer ? Math.round(v) : Math.round(v * 10000) / 10000;
}

function spec(key) {
  for (let i = 0; i < NUM.length; i++) if (NUM[i][0] === key) return NUM[i];
  return null;
}

// Seeds every heartbeat field not already on S. Called first thing in
// store.load(), beside initSunState; it only fills gaps.
export function initHeartbeatState(S) {
  if (typeof S.layers.heartbeat !== 'boolean') S.layers.heartbeat = false;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the heartbeat state, the shape store.js writes and a
// preset snapshot carries; the layer switch under its own flat name.
export function heartbeatStateOf(S) {
  const out = { heartbeatOn: !!S.layers.heartbeat };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field,
// leaving anything missing or malformed as it is; numbers are clamped.
export function applyHeartbeatState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.heartbeatOn === 'boolean') S.layers.heartbeat = o.heartbeatOn;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
}

// Every row dims while the layer is off, as the Sun section's do.
const layerOn = S => !!S.layers.heartbeat;

// One whole-percent slider over a 0 to 1 field.
function percent(id, key, label) {
  const n = spec(key);
  return {
    id, section: 'heartbeat', label, kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, 0, 1, false); save(); },
    format: S => Math.round(S[key] * 100) + '%',
    enabled: layerOn
  };
}

export const HEARTBEAT_CONTROLS = [
  // Sits in the drawer's Layers group straight after the Sun toggle (the
  // schema lists these controls straight after the sun's). Off by default.
  {
    id: 'lHeartbeat', section: 'layers', label: 'Heartbeat', kind: 'toggle', def: false,
    get: S => !!S.layers.heartbeat,
    set: (S, on) => { S.layers.heartbeat = on; save(); }
  },
  // The same switch at the head of the Heartbeat section, for its header
  // bar (drawer.js SECTION_SWITCH). No enabled(), so it never dims itself.
  {
    id: 'heartbeatOn', section: 'heartbeat', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.heartbeat,
    set: (S, on) => { S.layers.heartbeat = on; save(); }
  },
  // Master rides the sound and the light together, at the balance the two
  // rows below it set.
  percent('heartMaster', 'heartMaster', 'Master'),
  percent('heartAudio', 'heartAudio', 'Audio level'),
  percent('heartVisual', 'heartVisual', 'Visual amount')
];

export const HEARTBEAT_SECTIONS = [
  { id: 'heartbeat', title: 'Heartbeat' }
];
