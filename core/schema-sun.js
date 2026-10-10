// The Sun layer's controls and the state behind them. Like the Kaleidoscope,
// the sun is new in v1, with no v0 handler to port and no v0 DOM ids, so
// everything here is defined fresh: the S field names are the contract the
// GPU renderer (gpu/sun.js) reads, and the defaults, ranges and persistence
// helpers live beside the controls so that the one list of sun fields cannot
// drift between the drawer, the saved session and a preset.
//
// Persistence stays out of the shared v0 settings object for the same reason
// the kaleidoscope's does: v0's saveSettings() writes a fixed list of keys and
// would drop anything it does not know about. store.js writes these into the
// v1 extra record instead, through sunStateOf() and applySunState().
//
// Slider conventions follow schema-kaleido.js: a 0 to 1 amount is shown as a
// whole-percent slider (position 0 to 100) and converted through S, while a
// multiplier, a rate or a count is stored exactly as the slider shows it.
// Every set() ends with the debounced save(). The state-only helpers never
// call save(); store.js decides when to write.
import { save } from './store.js';
import { retimeRoomPhase } from './room-clock.js';
import { subDrawer } from './schema-visual.js';

// The layer switch, the kaleidoscope switch and the mirror flag are plain
// booleans; every numeric field carries its range here. gpu/sun.js reads
// these names off S directly, so this table is the source of truth for what a
// valid sun state is, both at boot and when a stored record or a preset
// snapshot is read back.
const DEF_KALEIDO_ON = false;
const DEF_MIRROR = true;
// On by default: the trails' Stream follows the breath, swinging between the
// Breath range's two ends, and the manual Stream is greyed out.
const DEF_FB_LINK = true;
const NUM = [
  // key,               min,  max, def,  integer
  // the sun video's playback rate, the site's 1x to 16x
  ['sunSpeed',           1,   16,  1,    false],
  ['sunOpacity',         0,   1,   1,    false],
  ['sunSize',            0.2, 2,   1,    false],
  // The Atmosphere sweep: 0 the photosphere (1700 A, ~5,000 K) rising
  // through 304, 171 and 193 to 1 the corona (211 A, ~2 MK), crossfading
  // each adjacent channel smoothly.
  ['sunAtmo',            0,   1,   0.25, false],
  // breaths per minute; 5.5 is coherent breathing
  ['sunBreathRate',      0.5, 12,  5.5,  false],
  // how far the breath travels the Atmosphere: the breath modulates which
  // channel shows, around the Atmosphere slider's position
  ['sunBreathAmt',       0,   1,   0.5,  false],
  // The Feedback drawer's video feedback, the same amount and opacity as the
  // Kaleidoscope's Feedback drawer: how long the sun leaves a trail, and how
  // solidly that image lands on the scene.
  ['sunFbAmt',           0,   1,   0.6,  false],
  ['sunFbOpacity',       0,   1,   1,    false],
  // The trails' Stream, signed: + streams outward, - inward. Manual while
  // Link to breath is off.
  ['sunFbStream',       -1,   1,   0,    false],
  // While linked, the Stream follows the breath between these two ends, in
  // (Lo) at the breath's bottom to out (Hi) at its top.
  ['sunFbStreamLo',     -1,   1,   -0.5, false],
  ['sunFbStreamHi',     -1,   1,   0.5,  false],
  // How many wedges the sun is folded into
  ['sunFolds',           3,   32,  8,    true ],
  // the fold's turning, in RPM, positive clockwise
  ['sunKaleidoSpin',    -6,   6,   0.5,  false],
  // Seconds over which a change of Symmetry (the fold count, or Mirror)
  // dissolves from the old pattern into the new one. 0 is instant.
  ['sunFoldXfade',       0,   60,  0,    false],
  // the fold count's variance: the standard percent dip on the room clock,
  // each new count riding the Symmetry slide
  ['sunFoldsVar',        0,   1,   0,    false],
  ['sunFoldsPeriod',     1,   60,  10,   true ],
  // the room-clocked swing's phase offset (core/room-clock.js): state, not a
  // control, written by the rate's set()
  ['sunFoldsPeriodOff',  0,   1,   0,    false]
];

// A slider's rounded position can come back as 1.1500000000000001; this
// trims it to the step's precision and clamps it into range, so S holds the
// clean number the readout shows and the saved JSON stays tidy.
function fit(v, min, max, integer) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return integer ? Math.round(v) : Math.round(v * 10000) / 10000;
}

// The Symmetry slide's taper, the kaleidoscope's own (and the Performance
// window's ramp curve): an exponential through 0 over 0 to 60 s, so 0 to 5 s
// takes about the first 42% of the track. Fine positions, so every value the
// snap below allows has a position of its own and a typed time lands exactly;
// snapped to tenths of a second under 5 s and to half seconds above.
const XFADE_MAX = 60, XFADE_POS = 1000, XFADE_CURVE = 4, XFADE_EK = Math.exp(XFADE_CURVE) - 1;
function xfadeToPos(v) {
  if (!(v > 0)) return v === 0 || v < 0 ? 0 : NaN;
  const u = Math.log(1 + (Math.min(v, XFADE_MAX) / XFADE_MAX) * XFADE_EK) / XFADE_CURVE;
  return Math.round(u * XFADE_POS);
}
function posToXfade(pos) {
  const u = pos > 0 ? (pos < XFADE_POS ? pos / XFADE_POS : 1) : 0;
  const v = XFADE_MAX * (Math.exp(XFADE_CURVE * u) - 1) / XFADE_EK;
  const q = v < 5 ? Math.round(v * 10) / 10 : Math.round(v * 2) / 2;
  return q < XFADE_MAX ? q : XFADE_MAX;
}

// The Speed slider's taper: logarithmic over 1x to 16x, so each doubling
// gets the same stretch of track (1 to 2 as much room as 8 to 16) and the
// slow end is not crushed against the left. Snapped to tenths of a x.
const SPEED_MIN = 1, SPEED_MAX = 16, SPEED_POS = 1000, SPEED_LN = Math.log(SPEED_MAX / SPEED_MIN);
function speedToPos(v) {
  if (!(v === v)) return NaN;
  const c = v < SPEED_MIN ? SPEED_MIN : (v > SPEED_MAX ? SPEED_MAX : v);
  return Math.round(Math.log(c / SPEED_MIN) / SPEED_LN * SPEED_POS);
}
function posToSpeed(pos) {
  const u = pos > 0 ? (pos < SPEED_POS ? pos / SPEED_POS : 1) : 0;
  const q = Math.round(SPEED_MIN * Math.exp(SPEED_LN * u) * 10) / 10;
  return q < SPEED_MAX ? q : SPEED_MAX;
}

function spec(key) {
  for (let i = 0; i < NUM.length; i++) if (NUM[i][0] === key) return NUM[i];
  return null;
}

// Seeds every sun field that is not already on S. Called first thing in
// store.load(), beside initKaleidoState, so the fields exist before any saved
// state is applied and before the first frame. It only fills gaps, so calling
// it twice is harmless.
export function initSunState(S) {
  if (typeof S.layers.sun !== 'boolean') S.layers.sun = false;
  if (typeof S.sunKaleidoOn !== 'boolean') S.sunKaleidoOn = DEF_KALEIDO_ON;
  if (typeof S.sunMirror !== 'boolean') S.sunMirror = DEF_MIRROR;
  if (typeof S.sunFbLink !== 'boolean') S.sunFbLink = DEF_FB_LINK;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the sun state, the shape store.js writes and a preset
// snapshot carries. The layer switch goes under its own flat name, as
// kaleidoOn does, so the record does not look like a partial v0 layers
// object.
export function sunStateOf(S) {
  const out = { sunOn: !!S.layers.sun, sunKaleidoOn: !!S.sunKaleidoOn, sunMirror: !!S.sunMirror, sunFbLink: S.sunFbLink !== false };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field, and
// leaves anything missing or malformed exactly as it is on S. Out-of-range
// numbers are clamped rather than rejected, so a record from a later build
// with wider ranges still lands somewhere sensible.
export function applySunState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.sunOn === 'boolean') S.layers.sun = o.sunOn;
  if (typeof o.sunKaleidoOn === 'boolean') S.sunKaleidoOn = o.sunKaleidoOn;
  if (typeof o.sunMirror === 'boolean') S.sunMirror = o.sunMirror;
  if (typeof o.sunFbLink === 'boolean') S.sunFbLink = o.sunFbLink;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
}

// Every control in the Sun section dims while the layer is off, the same way
// the Kaleidoscope section does, so the viewer can see what the sun would do
// before switching it on.
const layerOn = S => !!S.layers.sun;

// One slider bound 1:1 to a sun field (a multiplier, a rate or a count),
// whose range and default come from the NUM table so the two can never
// disagree.
function direct(id, key, label, step, format) {
  const n = spec(key);
  return {
    id, section: 'sun', label, kind: 'slider',
    min: n[1], max: n[2], step, def: n[3],
    get: S => S[key],
    set: (S, pos) => { S[key] = fit(pos, n[1], n[2], n[4]); save(); },
    format,
    enabled: layerOn
  };
}

// One whole-percent slider over a 0 to 1 field.
function percent(id, key, label, format) {
  const n = spec(key);
  return {
    id, section: 'sun', label, kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, 0, 1, false); save(); },
    format: format || (S => Math.round(S[key] * 100) + '%'),
    enabled: layerOn
  };
}

// A range row's readout: 'none' while both knobs sit on the centre, else how
// far in, then how far out, each with its sign (the kaleidoscope's own).
function sideText(v) {
  const num = Math.abs(v).toFixed(2);
  if (v === 0) return num;
  return (v < 0 ? '−' : '+') + num;
}
function rangeText(lo, hi) {
  return lo === 0 && hi === 0 ? 'none' : sideText(lo) + ' / ' + sideText(hi);
}

const times2 = key => S => S[key].toFixed(2) + '×';

// Tags a control as part of the variance of the row straight above it (the
// schema's varianceOf), so the drawer folds it out from under that row.
const varianceOf = (owner, c) => { c.varianceOf = owner; return c; };
// Nests a control in the sub-drawer straight above it (the schema's
// `parent`), so the drawer folds it with that drawer.
const under = (parent, c) => { c.parent = parent; return c; };

// Atmosphere's readout: at each of the five channel stops (the sweep from the
// photosphere up to the corona) it names the channel; between them, the
// percent.
const ATMO_STOPS = [[0, '1700 Å'], [25, '304 Å'], [50, '171 Å'], [75, '193 Å'], [100, '211 Å']];
function atmoText(S) {
  const p = Math.round(S.sunAtmo * 100);
  for (let i = 0; i < ATMO_STOPS.length; i++) if (ATMO_STOPS[i][0] === p) return ATMO_STOPS[i][1];
  return p + '%';
}

export const SUN_CONTROLS = [
  // Sits in the drawer's Layers group straight after the Particles toggle.
  // Off by default: a first visit looks exactly as it did before.
  {
    id: 'lSun', section: 'layers', label: 'Sun', kind: 'toggle', def: false,
    get: S => !!S.layers.sun,
    set: (S, on) => { S.layers.sun = on; save(); }
  },
  // The same switch again at the head of the Sun section. Every other control
  // here dims while the layer is off, so without this one the section had no
  // way in from inside it. It has no enabled(), so it never dims itself.
  {
    id: 'sunOn', section: 'sun', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.sun,
    set: (S, on) => { S.layers.sun = on; save(); }
  },

  // ---- Breath, first of the section's drawers: the sun swelling and
  // settling at a breathing rate, and the trails it leaves ----
  subDrawer('sunBreathDrawer', 'Breath', 'sun', ['sunBreathRate', 'sunBreathAmt']),
  under('sunBreathDrawer', direct('sunBreathRate', 'sunBreathRate', 'Rate', 0.1,
    S => S.sunBreathRate.toFixed(1) + ' / min')),
  under('sunBreathDrawer', percent('sunBreathAmt', 'sunBreathAmt', 'Amount')),

  // ---- Feedback: the trails the sun leaves, and a Stream that can ride the
  // breath ----
  subDrawer('sunFeedbackDrawer', 'Feedback', 'sun', ['sunFbAmt', 'sunFbStream']),
  under('sunFeedbackDrawer', percent('sunFbAmt', 'sunFbAmt', 'Amount')),
  under('sunFeedbackDrawer', percent('sunFbOpacity', 'sunFbOpacity', 'Opacity')),
  {
    id: 'sunFbLink', section: 'sun', label: 'Link to breath', kind: 'toggle', def: DEF_FB_LINK,
    parent: 'sunFeedbackDrawer',
    get: S => S.sunFbLink !== false,
    set: (S, on) => { S.sunFbLink = !!on; save(); },
    enabled: layerOn
  },
  // The manual Stream: each frame's faded copy is taken a little larger
  // (outward) or smaller (inward) about the centre. Greyed while the breath
  // drives it.
  under('sunFeedbackDrawer', Object.assign(
    direct('sunFbStream', 'sunFbStream', 'Stream', 0.01, S => S.sunFbStream === 0 ? 'none'
      : (S.sunFbStream > 0 ? '+' + S.sunFbStream.toFixed(2) + ' out' : S.sunFbStream.toFixed(2) + ' in')),
    { enabled: S => layerOn(S) && S.sunFbLink === false })),
  {
    // Where the breath carries the Stream while linked: in at its bottom, out
    // at its top. Greyed while the link is off.
    id: 'sunFbStreamRange', section: 'sun', label: 'Breath range', kind: 'range',
    parent: 'sunFeedbackDrawer',
    min: -1, max: 1, step: 0.01, defLo: spec('sunFbStreamLo')[3], defHi: spec('sunFbStreamHi')[3],
    getLo: S => S.sunFbStreamLo,
    getHi: S => S.sunFbStreamHi,
    setLo: (S, v) => { S.sunFbStreamLo = fit(v, -1, 0); save(); },
    setHi: (S, v) => { S.sunFbStreamHi = fit(v, 0, 1); save(); },
    format: S => rangeText(S.sunFbStreamLo, S.sunFbStreamHi),
    enabled: S => layerOn(S) && S.sunFbLink !== false
  },

  // ---- the picture itself ----
  percent('sunOpacity', 'sunOpacity', 'Opacity'),
  {
    // The playback rate, 1x to 16x, on a log taper so each doubling gets the
    // same stretch of track.
    id: 'sunSpeed', section: 'sun', label: 'Speed', kind: 'slider',
    min: 0, max: SPEED_POS, step: 1, def: speedToPos(spec('sunSpeed')[3]),
    get: S => speedToPos(S.sunSpeed),
    set: (S, pos) => { S.sunSpeed = posToSpeed(pos); save(); },
    format: S => (Math.round(S.sunSpeed * 10) / 10) + 'x',
    parse: (S, text) => speedToPos(parseFloat(text)),
    enabled: layerOn
  },
  direct('sunSize', 'sunSize', 'Size', 0.05, times2('sunSize')),
  percent('sunAtmo', 'sunAtmo', 'Atmosphere', atmoText),

  // ---- Kaleidoscope: the sun folded into wedges ----
  subDrawer('sunKaleidoDrawer', 'Kaleidoscope', 'sun', ['sunKaleidoOn', 'sunFolds']),
  {
    id: 'sunKaleidoOn', section: 'sun', label: 'Kaleidoscope', kind: 'toggle', def: DEF_KALEIDO_ON,
    parent: 'sunKaleidoDrawer',
    get: S => !!S.sunKaleidoOn,
    set: (S, on) => { S.sunKaleidoOn = !!on; save(); },
    enabled: layerOn
  },
  // How many wedges the circle is cut into. The readout keeps the number
  // first, so clicking it to type opens on the fold count itself.
  under('sunKaleidoDrawer', direct('sunFolds', 'sunFolds', 'Symmetry', 1, S => S.sunFolds + '-fold')),
  // Symmetry's dip and its rate fold out from under Symmetry, the rate on
  // the room clock, retimed as the kaleidoscope's is
  varianceOf('sunFolds', under('sunKaleidoDrawer', percent('sunFoldsVar', 'sunFoldsVar', 'Symmetry variance'))),
  varianceOf('sunFolds', under('sunKaleidoDrawer', {
    id: 'sunFoldsPeriod', section: 'sun', label: 'Symmetry variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.sunFoldsPeriod,
    set: (S, pos) => {
      const v = fit(pos, 1, 60, true);
      retimeRoomPhase(S, 'sunFoldsPeriodOff', S.sunFoldsPeriod, v);
      S.sunFoldsPeriod = v;
      save();
    },
    format: S => S.sunFoldsPeriod + 's / cycle',
    enabled: layerOn
  })),
  {
    // Whether alternate wedges are reflected, the way a real kaleidoscope's
    // mirrors fold the image, or simply repeated around the circle.
    id: 'sunMirror', section: 'sun', label: 'Mirror', kind: 'toggle', def: DEF_MIRROR,
    parent: 'sunKaleidoDrawer',
    get: S => !!S.sunMirror,
    set: (S, on) => { S.sunMirror = !!on; save(); },
    enabled: layerOn
  },
  // The fold's turning, in revolutions per minute, positive clockwise.
  under('sunKaleidoDrawer', direct('sunKaleidoSpin', 'sunKaleidoSpin', 'Rotation', 0.1,
    S => S.sunKaleidoSpin === 0 ? 'still' : S.sunKaleidoSpin.toFixed(1) + ' rpm')),
  {
    // How a change of Symmetry (the fold count or Mirror) arrives. Instant
    // snaps to the new pattern; a time draws the old symmetry and the new one
    // together and dissolves from the one to the other across that many
    // seconds. The same taper and snap as the kaleidoscope's Symmetry slide.
    id: 'sunFoldXfade', section: 'sun', label: 'Symmetry slide', kind: 'slider',
    parent: 'sunKaleidoDrawer',
    min: 0, max: XFADE_POS, step: 1, def: 0,
    get: S => xfadeToPos(S.sunFoldXfade),
    set: (S, pos) => { S.sunFoldXfade = posToXfade(pos); save(); },
    format: S => {
      const v = S.sunFoldXfade;
      return v > 0 ? (v === Math.round(v) ? v : v.toFixed(1)) + 's' : 'instant';
    },
    parse: (S, text) => /^\s*inst/i.test(text) ? 0 : xfadeToPos(parseFloat(text)),
    enabled: layerOn
  }
];

export const SUN_SECTIONS = [
  { id: 'sun', title: 'Sun' }
];
