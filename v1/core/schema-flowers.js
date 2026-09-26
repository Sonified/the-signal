// The Flowers layer's controls and the state behind them. Flowers are new in
// v1, with no v0 handler to port and no v0 DOM ids, so everything here is
// defined fresh: the S field names are the contract the GPU renderer reads,
// and the defaults, ranges and persistence helpers live beside the controls
// so that the one list of flower fields cannot drift between the drawer, the
// saved session and a preset.
//
// Persistence is deliberately kept out of the shared v0 settings object.
// v0's saveSettings() writes a fixed list of keys and would drop anything it
// does not know about, so a session saved in v0 would erase every flower
// setting. store.js writes these under a key of their own instead, through
// flowerStateOf() and applyFlowerState() below.
//
// Slider conventions follow schema-visual.js: a 0 to 1 amount is shown as a
// whole-percent slider (position 0 to 100) and converted through S, while a
// multiplier or a count is stored exactly as the slider shows it. Every set()
// ends with the debounced save(). The state-only helpers at the bottom never
// call save(); store.js decides when to write.
import { save } from './store.js';

// Mode, the layer switch, and every numeric field with its range. The GPU
// agent reads these names off S directly, so they are the source of truth
// for what a valid flower state is, both at boot and when a stored record or
// a preset snapshot is read back.
const MODES = ['tunnel', 'mandala'];
const DEF_MODE = 'tunnel';
const NUM = [
  // key,               min,  max, def,  integer
  ['flowerCount',        3,   36,  12,   true ],
  ['flowerRings',        1,   12,  6,    true ],
  ['flowerSize',         0.2, 3,   1,    false],
  ['flowerSpeed',        0,   3,   1,    false],
  ['flowerBloomRate',    0,   4,   1,    false],
  ['flowerSpin',        -2,   2,   0.12, false],
  ['flowerSpiral',       0,   1,   0.38, false],
  ['flowerRipple',       0,   1,   0.6,  false],
  ['flowerOpacity',      0,   1,   0.85, false],
  ['flowerFade',         0,   1,   0.55, false],
  ['flowerTint',         0,   1,   0,    false],
  ['flowerPulse',        0,   1,   0,    false]
];

// A slider's rounded position can come back as 1.1500000000000001; this
// trims it to the step's precision and clamps it into range, so S holds the
// clean number the readout shows and the saved JSON stays tidy.
function fit(v, min, max, integer) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return integer ? Math.round(v) : Math.round(v * 10000) / 10000;
}

function spec(key) {
  for (let i = 0; i < NUM.length; i++) if (NUM[i][0] === key) return NUM[i];
  return null;
}

// Seeds every flower field that is not already on S. Called first thing in
// store.load(), so the fields exist before any saved state is applied and
// before the first frame, on a first visit as much as on a return one. It
// only fills gaps, so calling it twice is harmless.
export function initFlowerState(S) {
  if (typeof S.layers.flowers !== 'boolean') S.layers.flowers = false;
  if (MODES.indexOf(S.flowerMode) < 0) S.flowerMode = DEF_MODE;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the flower state, the shape store.js writes and a preset
// snapshot carries. The layer switch is stored under its own flat name so
// the record does not look like a partial v0 layers object.
export function flowerStateOf(S) {
  const out = { flowersOn: !!S.layers.flowers, flowerMode: S.flowerMode };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field, and
// leaves anything missing or malformed exactly as it is on S. Out-of-range
// numbers are clamped rather than rejected, so a record from a later build
// with wider ranges still lands somewhere sensible.
export function applyFlowerState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.flowersOn === 'boolean') S.layers.flowers = o.flowersOn;
  if (MODES.indexOf(o.flowerMode) >= 0) S.flowerMode = o.flowerMode;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
}

// One slider bound 1:1 to a flower field (a multiplier or a count), whose
// range and default come from the NUM table so the two can never disagree.
function direct(id, key, label, step, format, visible) {
  const n = spec(key);
  const c = {
    id, section: 'flowers', label, kind: 'slider',
    min: n[1], max: n[2], step, def: n[3],
    get: S => S[key],
    set: (S, pos) => { S[key] = fit(pos, n[1], n[2], n[4]); save(); },
    format,
    enabled: layerOn
  };
  if (visible) c.visible = visible;
  return c;
}

// One whole-percent slider over a 0 to 1 field, the way schema-visual.js
// does depth, fade and every other amount.
function percent(id, key, label, format, visible, sub) {
  const n = spec(key);
  const c = {
    id, section: 'flowers', label, kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, 0, 1, false); save(); },
    format: format || (S => Math.round(S[key] * 100) + '%'),
    enabled: layerOn
  };
  if (visible) c.visible = visible;
  if (sub) c.sub = sub;
  return c;
}

// Every control in the Flowers section dims while the layer is off, the
// same way a v0 row locks when the thing it tunes is not running. They stay
// editable in principle but read as inactive, so the viewer can see what the
// flowers would do before switching them on.
const layerOn = S => !!S.layers.flowers;
const isTunnel = S => S.flowerMode !== 'mandala';
const isMandala = S => S.flowerMode === 'mandala';

const times2 = key => S => S[key].toFixed(2) + '×';

export const FLOWER_CONTROLS = [
  // Sits in the drawer's Layers group after Field, Rings, Corners, Edge and
  // Text, since the drawer groups by section and walks controls in order.
  // Off by default: a first visit looks exactly as it did before flowers.
  {
    id: 'lFlowers', section: 'layers', label: 'Flowers', kind: 'toggle', def: false,
    get: S => !!S.layers.flowers,
    set: (S, on) => { S.layers.flowers = on; save(); }
  },
  // The same switch at the head of the Flowers section, never dimmed, so the
  // section can be turned on from inside it (everything else here dims while
  // the layer is off).
  {
    id: 'flowersOn', section: 'flowers', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.flowers,
    set: (S, on) => { S.layers.flowers = on; save(); }
  },

  {
    id: 'flowerMode', section: 'flowers', label: 'Mode', kind: 'segment', def: DEF_MODE,
    options: [
      { value: 'tunnel',  label: 'Bloom tunnel', domId: null },
      { value: 'mandala', label: 'Mandala',      domId: null }
    ],
    get: S => S.flowerMode,
    set: (S, v) => { S.flowerMode = MODES.indexOf(v) >= 0 ? v : DEF_MODE; save(); },
    enabled: layerOn
  },
  direct('flowerCount', 'flowerCount', 'Flowers', 1, S => String(S.flowerCount)),
  direct('flowerRings', 'flowerRings', 'Rings',   1, S => String(S.flowerRings), isTunnel),
  direct('flowerSize',  'flowerSize',  'Size',    0.05, times2('flowerSize')),
  // The same S.flowerSpeed under two names: in the tunnel it is how fast the
  // blooms travel toward the viewer, in the mandala how fast the pattern
  // flows outward, and the label should say which. The toolkit takes a
  // control's label as a plain string, so rather than a label that changes
  // under it, each mode gets its own row and only the right one is visible.
  direct('flowerSpeed', 'flowerSpeed', 'Speed',   0.05, times2('flowerSpeed'), isTunnel),
  direct('flowerFlow',  'flowerSpeed', 'Flow',    0.05, times2('flowerSpeed'), isMandala),
  direct('flowerBloomRate', 'flowerBloomRate', 'Bloom speed', 0.05, times2('flowerBloomRate')),
  // Signed: negative turns the other way. A step of 0.01 so the default,
  // 0.12, is a position the slider can actually land on.
  direct('flowerSpin',  'flowerSpin',  'Spin',    0.01,
    S => S.flowerSpin === 0 ? 'still' : (S.flowerSpin > 0 ? '+' : '') + S.flowerSpin.toFixed(2) + '×'),
  percent('flowerSpiral', 'flowerSpiral', 'Spiral', null, isTunnel),
  percent('flowerRipple', 'flowerRipple', 'Ripple', null, isTunnel),
  percent('flowerOpacity', 'flowerOpacity', 'Opacity'),
  // The tunnel rings' fade in from the centre (core/fade.js), with its own
  // amount so the flowers can ease in sooner or later than the rings do.
  // Both modes use it, so it is never hidden.
  percent('flowerFade', 'flowerFade', 'Center fade radius'),

  // How far the flowers follow the strobe, in colour and in brightness. Both
  // default to 0, which keeps them a steady layer of their own on top of the
  // flicker; the Pulse readout spells that out at 0 so nobody has to guess
  // whether 0 means "no pulse" or "no flowers".
  percent('flowerTint', 'flowerTint', 'Tint to strobe colour',
    S => S.flowerTint === 0 ? 'own colour' : Math.round(S.flowerTint * 100) + '%',
    null, 'With the strobe'),
  percent('flowerPulse', 'flowerPulse', 'Pulse with strobe',
    S => S.flowerPulse === 0 ? 'never flickers' : Math.round(S.flowerPulse * 100) + '%',
    null, 'With the strobe')
];

export const FLOWER_SECTIONS = [
  { id: 'flowers', title: 'Flowers' }
];
