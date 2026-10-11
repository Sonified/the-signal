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
import { varianceRows, driveRow } from './schema-variance.js';
import { driveOf } from './variance.js';

const NUM = [
  // key,          min, max, def, integer
  ['heartMaster',  0,   1,   1,   false],
  ['heartAudio',   0,   4,   0.8, false],
  ['heartVisual',  0,   1,   0.8, false],
  // the recording's playback speed, a multiplier: varispeed, so its pitch
  // moves with it, and the light (which reads the sound) beats with it
  ['heartSpeed',   0.25, 2,  1,   false],
  // Speed's variance, the app's standard dip below the setting (core/strobe.js
  // VARIANCES steps it, gpu/heartbeat.js plays effHeartSpeed), led by its
  // driver: Time (the rate below), the strobe's wave or the sun's breath
  ['heartSpeedVar',       0, 1,   0,  false],
  ['heartSpeedVarPeriod', 1, 120, 20, true ]
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
  S.heartSpeedVarDrive = driveOf(S.heartSpeedVarDrive);
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the heartbeat state, the shape store.js writes and a
// preset snapshot carries; the layer switch under its own flat name.
export function heartbeatStateOf(S) {
  const out = { heartbeatOn: !!S.layers.heartbeat, heartSpeedVarDrive: driveOf(S.heartSpeedVarDrive) };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field,
// leaving anything missing or malformed as it is; numbers are clamped.
export function applyHeartbeatState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.heartbeatOn === 'boolean') S.layers.heartbeat = o.heartbeatOn;
  if (typeof o.heartSpeedVarDrive === 'string') S.heartSpeedVarDrive = driveOf(o.heartSpeedVarDrive);
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
}

// Speed's taper, the Slides' own (schema-slides.js): logarithmic either side
// of 1x at the centre, 0.25x at the left end and 2x at the right. A drag
// landing within RATE_SNAP of 1x takes it exactly.
const RATE_POS = 1000, RATE_MID = RATE_POS / 2, RATE_SNAP = 0.03;
function rateToPos(v) {
  if (!(v === v)) return NaN;
  const r = v < 0.25 ? 0.25 : v > 2 ? 2 : v;
  return Math.round(r <= 1 ? RATE_MID * (1 + Math.log2(r) / 2) : RATE_MID + RATE_MID * Math.log2(r));
}
function posToRate(pos) {
  const p = pos > 0 ? (pos < RATE_POS ? pos : RATE_POS) : 0;
  let r = p <= RATE_MID ? Math.pow(2, 2 * (p / RATE_MID - 1)) : Math.pow(2, (p - RATE_MID) / RATE_MID);
  if (Math.abs(r - 1) <= RATE_SNAP) r = 1;
  return Math.round(r * 100) / 100;
}

// One whole-percent slider over the field's own span from the NUM table,
// so a row whose range reaches past 1 (Audio level runs to 400%, the
// heartbeat's own limiter in core/heartbeat.js keeping it from clipping)
// shows and stores the whole of it.
function percent(id, key, label) {
  const n = spec(key);
  return {
    id, section: 'heartbeat', label, kind: 'slider',
    min: 0, max: Math.round(n[2] * 100), step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, n[1], n[2], false); save(); },
    formatAt: pos => pos + '%',
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
  percent('heartVisual', 'heartVisual', 'Visual amount'),
  {
    id: 'heartSpeed', section: 'heartbeat', label: 'Speed', kind: 'slider',
    min: 0, max: RATE_POS, step: 1, def: rateToPos(1),
    get: S => rateToPos(S.heartSpeed),
    set: (S, pos) => { S.heartSpeed = fit(posToRate(pos), 0.25, 2, false); save(); },
    formatAt: pos => posToRate(pos).toFixed(2) + 'x',
    parse: (S, text) => rateToPos(parseFloat(text)),
  },
  // Speed's dip, folded out from under it as the confetti's Opacity's is
  // (core/schema-confetti.js): what leads it, how far, and Time's rate,
  // shown only while Time leads. The bar lights from effHeartSpeed through
  // the slider's own taper (core/schema-variance.js wireVariances).
  driveRow('heartSpeed', 'heartSpeedVarDrive', 'Speed variance driver', null, 'heartbeat'),
  ...varianceRows('heartSpeed', {
    name: 'Speed', periodMax: 120,
    rows: { period: { visible: S => driveOf(S.heartSpeedVarDrive) === 'time' } }
  })
];

export const HEARTBEAT_SECTIONS = [
  { id: 'heartbeat', title: 'Heartbeat' }
];
