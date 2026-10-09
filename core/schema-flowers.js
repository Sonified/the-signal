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
import { subDrawer } from './schema-visual.js';
import { varianceRows } from './schema-variance.js';
import { varied } from './variance.js';

// Mode, the layer switch, and every numeric field with its range. The GPU
// agent reads these names off S directly, so they are the source of truth
// for what a valid flower state is, both at boot and when a stored record or
// a preset snapshot is read back.
const MODES = ['tunnel', 'mandala'];
const DEF_MODE = 'tunnel';
const NUM = [
  // key,               min,  max, def,  integer
  ['flowerCount',        3,   32,  12,   true ],
  ['flowerRings',        1,   12,  6,    true ],
  ['flowerSize',         0.2, 3,   1,    false],
  ['flowerSpeed',        0,   3,   1,    false],
  ['flowerBloomRate',    0,   4,   1,    false],
  // the bloom speed's variance: the standard percent dip on the room clock,
  // as Opacity's, Tint's and Pulse's below
  ['flowerBloomRateVar', 0,   1,   0,    false],
  ['flowerBloomRatePeriod', 1, 60, 10,   true ],
  ['flowerSpin',        -2,   2,   0.12, false],
  ['flowerSpiral',       0,   1,   0.38, false],
  ['flowerRipple',       0,   1,   0.6,  false],
  ['flowerOpacity',      0,   1,   0.85, false],
  ['flowerOpacityVar',   0,   1,   0,    false],
  ['flowerOpacityPeriod', 1,  60,  10,   true ],
  ['flowerFade',         0,   1,   0.55, false],
  ['flowerTint',         0,   1,   0,    false],
  // the tint's variance: the standard percent dip on the room clock, as
  // Opacity's and Pulse's above
  ['flowerTintVar',      0,   1,   0,    false],
  ['flowerTintPeriod',   1,   60,  10,   true ],
  ['flowerPulse',        0,   1,   0,    false],
  ['flowerPulseVar',     0,   1,   0,    false],
  ['flowerPulsePeriod',  1,   60,  10,   true ],
  // The room-clocked swings' phase offsets (core/room-clock.js), one beside
  // each period above. State, not controls: a period's set() writes its
  // offset, and they are saved and sent with the rest so every screen in a
  // room derives the same phase.
  ['flowerBloomRatePeriodOff', 0, 1, 0,   false],
  ['flowerOpacityPeriodOff', 0, 1,  0,    false],
  ['flowerTintPeriodOff', 0,  1,   0,    false],
  ['flowerPulsePeriodOff', 0,   1,  0,    false]
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
function percent(id, key, label, format, visible) {
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
  return c;
}

// Nests a control in the sub-drawer straight above it (the schema's
// `parent`), so the drawer folds it with that drawer. A row's own mode rule
// still applies inside, so it shows only while its drawer is open and its
// mode is the current one.
const under = (parent, c) => { c.parent = parent; return c; };

// Every control in the Flowers section dims while the layer is off, the
// same way a v0 row locks when the thing it tunes is not running. They stay
// editable in principle but read as inactive, so the viewer can see what the
// flowers would do before switching them on.
const layerOn = S => !!S.layers.flowers;
const isTunnel = S => S.flowerMode !== 'mandala';
const isMandala = S => S.flowerMode === 'mandala';

const times2 = key => S => S[key].toFixed(2) + '×';

// A Brightness setting's variance (schema-variance.js varianceRows): its
// amount and rate under the owner's own names plus Var and Period, every
// write fitted to the NUM table as the layer's other fields are, the rate on
// the room clock (room: in a broadcast room a new rate is folded into the
// swing's phase offset first, so it carries on from where it is rather than
// jumping), and the bar glowing with the setting as the variance plays it,
// the same shape core/strobe.js computes into the owner's eff* each frame.
const fitNum = (key, v) => { const n = spec(key); return fit(v, n[1], n[2], n[4]); };
const swing = (owner, o) => varianceRows(owner, Object.assign({
  period: owner + 'Period', periodDef: spec(owner + 'Period')[3], room: true, fit: fitNum,
  parent: 'flowersBrightnessDrawer', enabled: layerOn,
  effective: S => varied(S[owner], S[owner + 'Var'], S[owner + 'Phase'] || 0) * 100
}, o));

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
    hideLabel: true,
    options: [
      { value: 'tunnel',  label: 'Bloom tunnel', domId: null },
      { value: 'mandala', label: 'Mandala',      domId: null }
    ],
    get: S => S.flowerMode,
    set: (S, v) => { S.flowerMode = MODES.indexOf(v) >= 0 ? v : DEF_MODE; save(); },
    enabled: layerOn
  },
  // ---- three sub-drawers, Motion, Shape and Brightness (see subDrawer in
  // schema-visual.js), each with its rows straight after it. Mode stays
  // above them, since it decides which of their rows show at all ----
  subDrawer('flowersMotionDrawer', 'Motion', 'flowers', ['flowerSpeed', 'flowerFlow', 'flowerBloomRate']),
  // The same S.flowerSpeed under two names: in the tunnel it is how fast the
  // blooms travel toward the viewer, in the mandala how fast the pattern
  // flows outward, and the label should say which. The toolkit takes a
  // control's label as a plain string, so rather than a label that changes
  // under it, each mode gets its own row and only the right one is visible.
  under('flowersMotionDrawer',
    direct('flowerSpeed', 'flowerSpeed', 'Speed', 0.05, times2('flowerSpeed'), isTunnel)),
  under('flowersMotionDrawer',
    direct('flowerFlow', 'flowerSpeed', 'Outward speed', 0.05, times2('flowerSpeed'), isMandala)),
  under('flowersMotionDrawer',
    direct('flowerBloomRate', 'flowerBloomRate', 'Bloom speed', 0.05, times2('flowerBloomRate'))),
  // A multiplier, not a percent, so its bar glows in the row's own units
  ...swing('flowerBloomRate', {
    labels: ['Bloom speed variance', 'Bloom variance rate'], parent: 'flowersMotionDrawer',
    effective: S => S.effFlowerBloomRate ?? S.flowerBloomRate
  }),
  // Signed: negative turns the other way. A step of 0.01 so the default,
  // 0.12, is a position the slider can actually land on.
  under('flowersMotionDrawer',
    direct('flowerSpin', 'flowerSpin', 'Spin', 0.01,
      S => S.flowerSpin === 0 ? 'still' : (S.flowerSpin > 0 ? '+' : '') + S.flowerSpin.toFixed(2) + '×')),

  subDrawer('flowersShapeDrawer', 'Shape', 'flowers', ['flowerCount', 'flowerSize']),
  under('flowersShapeDrawer',
    direct('flowerCount', 'flowerCount', 'Flowers', 1, S => String(S.flowerCount))),
  under('flowersShapeDrawer',
    direct('flowerRings', 'flowerRings', 'Rings', 1, S => String(S.flowerRings), isTunnel)),
  under('flowersShapeDrawer',
    direct('flowerSize', 'flowerSize', 'Size', 0.05, times2('flowerSize'))),
  under('flowersShapeDrawer', percent('flowerSpiral', 'flowerSpiral', 'Spiral', null, isTunnel)),
  under('flowersShapeDrawer', percent('flowerRipple', 'flowerRipple', 'Ripple', null, isTunnel)),

  subDrawer('flowersBrightnessDrawer', 'Brightness', 'flowers', ['flowerOpacity', 'flowerFade']),
  under('flowersBrightnessDrawer', percent('flowerOpacity', 'flowerOpacity', 'Opacity')),
  ...swing('flowerOpacity', { name: 'Opacity' }),
  // The tunnel rings' fade in from the centre (core/fade.js), with its own
  // amount so the flowers can ease in sooner or later than the rings do.
  // Both modes use it, so it is never hidden.
  under('flowersBrightnessDrawer', percent('flowerFade', 'flowerFade', 'Center fade radius')),
  // How far the flowers follow the strobe, in brightness and in colour. Both
  // default to 0, which keeps them a steady layer of their own on top of the
  // flicker; the Pulse readout spells that out at 0 so nobody has to guess
  // whether 0 means "no pulse" or "no flowers". They sat under a "With the
  // strobe" heading before the sub-drawers; a heading inside a sub-drawer
  // would end its run, and the two names already say it.
  under('flowersBrightnessDrawer',
    percent('flowerPulse', 'flowerPulse', 'Pulse with strobe',
      S => S.flowerPulse === 0 ? 'never flickers' : Math.round(S.flowerPulse * 100) + '%')),
  ...swing('flowerPulse', { labels: ['Pulse variance', 'Pulse variance rate'] }),
  under('flowersBrightnessDrawer', percent('flowerTint', 'flowerTint', 'Tint to strobe colour',
    S => S.flowerTint === 0 ? 'own colour' : Math.round(S.flowerTint * 100) + '%')),
  ...swing('flowerTint', { labels: ['Tint variance', 'Tint variance rate'] })
];

// Shorthand names for the shut sub-drawer strips' summaries (see summary in
// schema-visual.js subDrawer), set once here rather than threaded through
// the helpers above.
const FLOWER_SHORT = { flowerSpeed: 'Speed', flowerFlow: 'Speed', flowerBloomRate: 'Bloom',
  flowerCount: 'Count', flowerSize: 'Size', flowerOpacity: 'Opacity', flowerFade: 'Fade' };
for (const c of FLOWER_CONTROLS) if (FLOWER_SHORT[c.id]) c.summaryLabel = FLOWER_SHORT[c.id];

export const FLOWER_SECTIONS = [
  { id: 'flowers', title: 'Flowers' }
];
