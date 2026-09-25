// The Kaleidoscope layer's controls and the state behind them. Like the
// Flowers, the kaleidoscope is new in v1, with no v0 handler to port and no
// v0 DOM ids, so everything here is defined fresh: the S field names are the
// contract the GPU renderer reads, and the defaults, ranges and persistence
// helpers live beside the controls so that the one list of kaleidoscope
// fields cannot drift between the drawer, the saved session and a preset.
//
// Persistence stays out of the shared v0 settings object for the same reason
// the flowers do: v0's saveSettings() writes a fixed list of keys and would
// drop anything it does not know about. store.js writes these into the v1
// extra record instead, through kaleidoStateOf() and applyKaleidoState().
//
// Slider conventions follow schema-flowers.js: a 0 to 1 amount is shown as a
// whole-percent slider (position 0 to 100) and converted through S, while a
// multiplier, a rate or a count is stored exactly as the slider shows it.
// Every set() ends with the debounced save(). The state-only helpers never
// call save(); store.js decides when to write.
import { save } from './store.js';

// The layer switch, the mirror flag and constant size are plain booleans;
// every numeric field
// carries its range here. The GPU agent reads these names off S directly, so
// this table is the source of truth for what a valid kaleidoscope state is,
// both at boot and when a stored record or a preset snapshot is read back.
const DEF_MIRROR = true;
// Off by default: shapes grow as they come toward the rim, in the same
// perspective as the rings and the flowers.
const DEF_CONST_SIZE = false;
// Off by default: the Color sliders do nothing, and stay hidden, until the
// viewer turns the grade on.
const DEF_GRADE = false;
const NUM = [
  // key,               min,  max, def,  integer
  ['kaleidoFolds',       3,   16,  8,    true ],
  ['kaleidoDensity',     0,   1,   0.5,  false],
  ['kaleidoSpeed',       0,   3,   1,    false],
  ['kaleidoSize',        0.2, 3,   1,    false],
  ['kaleidoSizeVar',     0,   1,   0.6,  false],
  ['kaleidoSpinMax',     0,   3,   0.35, false],
  ['kaleidoSpinVar',     0,   1,   0.7,  false],
  ['kaleidoTwist',      -1,   1,   0.04, false],
  ['kaleidoOrbitMax',    0,   2,   0.25, false],
  ['kaleidoOrbitVar',    0,   1,   0.7,  false],
  // 0 seats every new shape on its wedge's axis, whole and pointing
  // outward; 1 throws it anywhere across the wedge and beyond, as before.
  ['kaleidoScatter',     0,   1,   0,    false],
  ['kaleidoOpacity',    0,   1,   0.9,  false],
  // How far out from the centre a shape eases in: the same 0 to 1 amount,
  // curve and default as the tunnel rings' Ring fade in (core/fade.js).
  ['kaleidoFade',        0,   1,   0.55, false],
  ['kaleidoTint',        0,   1,   0,    false],
  ['kaleidoPulse',       0,   1,   0,    false],
  // Which motif atlas the shapes come from (kaleido.js ATLAS_SETS): 1 the
  // original motifs, 2 the botanical atlas.
  ['kaleidoSet',         1,   2,   1,    true ],
  // The layer's own colour grade, applied in the fold: 1 leaves the motifs
  // as they are, 0 is black, flat grey or greyscale, 2 doubles the effect.
  ['kaleidoBright',      0,   2,   1,    false],
  ['kaleidoContrast',    0,   2,   1,    false],
  ['kaleidoSat',         0,   2,   1,    false]
];

// The shape families the renderer draws from, by index. S.kaleidoFamilies
// holds the chosen indices; an empty list means every family, so a first
// visit, and any record that never chose, draws the whole set without
// having to write all eight numbers into storage.
const FAMILIES = ['Leaves', 'Flowers', 'Celestial', 'Sky & water', 'Botanical', 'Candy', 'Treasures', 'Light'];
const N_FAM = FAMILIES.length;
// What get() hands the chips when the list is empty. Built once and never
// mutated, so the drawer can ask for it every frame without allocating.
const ALL_FAMILIES = Object.freeze(FAMILIES.map((_, i) => i));

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

// Any list of candidate family indices, reduced to the canonical form S
// holds: whole numbers in range, each once, ascending. A list that names
// every family collapses back to the empty "all" list, and so does one
// that names none, since a kaleidoscope with no shapes to draw is never
// what anyone meant; both come out as []. Anything that is not a valid
// index is skipped rather than failing the whole list.
function cleanFamilies(list) {
  const seen = new Array(N_FAM).fill(false);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= N_FAM || seen[v]) continue;
    seen[v] = true;
    n++;
  }
  if (n === 0 || n === N_FAM) return [];
  const out = [];
  for (let i = 0; i < N_FAM; i++) if (seen[i]) out.push(i);
  return out;
}

// Seeds every kaleidoscope field that is not already on S. Called first
// thing in store.load(), beside initFlowerState, so the fields exist before
// any saved state is applied and before the first frame. It only fills
// gaps, so calling it twice is harmless.
export function initKaleidoState(S) {
  if (typeof S.layers.kaleido !== 'boolean') S.layers.kaleido = false;
  if (typeof S.kaleidoMirror !== 'boolean') S.kaleidoMirror = DEF_MIRROR;
  if (typeof S.kaleidoConstSize !== 'boolean') S.kaleidoConstSize = DEF_CONST_SIZE;
  if (typeof S.kaleidoGrade !== 'boolean') S.kaleidoGrade = DEF_GRADE;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
  if (!Array.isArray(S.kaleidoFamilies)) S.kaleidoFamilies = [];
}

// A plain copy of the kaleidoscope state, the shape store.js writes and a
// preset snapshot carries. The layer switch goes under its own flat name,
// as flowersOn does, so the record does not look like a partial v0 layers
// object. The family list is copied so the record never aliases S.
export function kaleidoStateOf(S) {
  const out = { kaleidoOn: !!S.layers.kaleido, kaleidoMirror: !!S.kaleidoMirror, kaleidoConstSize: !!S.kaleidoConstSize, kaleidoGrade: !!S.kaleidoGrade };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  out.kaleidoFamilies = Array.isArray(S.kaleidoFamilies) ? S.kaleidoFamilies.slice() : [];
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field, and
// leaves anything missing or malformed exactly as it is on S. Out-of-range
// numbers are clamped rather than rejected, so a record from a later build
// with wider ranges still lands somewhere sensible, and a family list keeps
// whichever of its entries are valid.
export function applyKaleidoState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.kaleidoOn === 'boolean') S.layers.kaleido = o.kaleidoOn;
  if (typeof o.kaleidoMirror === 'boolean') S.kaleidoMirror = o.kaleidoMirror;
  if (typeof o.kaleidoConstSize === 'boolean') S.kaleidoConstSize = o.kaleidoConstSize;
  if (typeof o.kaleidoGrade === 'boolean') S.kaleidoGrade = o.kaleidoGrade;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
  if (Array.isArray(o.kaleidoFamilies)) S.kaleidoFamilies = cleanFamilies(o.kaleidoFamilies);
}

// Every control in the Kaleidoscope section dims while the layer is off, the
// same way the Flowers section does, so the viewer can see what the
// kaleidoscope would do before switching it on.
const layerOn = S => !!S.layers.kaleido;

// One slider bound 1:1 to a kaleidoscope field (a multiplier, a rate or a
// count), whose range and default come from the NUM table so the two can
// never disagree.
function direct(id, key, label, step, format, sub) {
  const n = spec(key);
  const c = {
    id, section: 'kaleido', label, kind: 'slider',
    min: n[1], max: n[2], step, def: n[3],
    get: S => S[key],
    set: (S, pos) => { S[key] = fit(pos, n[1], n[2], n[4]); save(); },
    format,
    enabled: layerOn
  };
  if (sub) c.sub = sub;
  return c;
}

// One whole-percent slider over a 0 to 1 field.
function percent(id, key, label, format, sub) {
  const n = spec(key);
  const c = {
    id, section: 'kaleido', label, kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, 0, 1, false); save(); },
    format: format || (S => Math.round(S[key] * 100) + '%'),
    enabled: layerOn
  };
  if (sub) c.sub = sub;
  return c;
}

const times2 = key => S => S[key].toFixed(2) + '×';

// One whole-percent slider over a 0 to 2 grade field, 100% unchanged,
// shown only while the Color switch is on, and drawn as that switch's child.
function grade(id, key, label) {
  const n = spec(key);
  return {
    id, section: 'kaleido', sub: 'Color', label, kind: 'slider',
    parent: 'kaleidoGrade',
    min: 0, max: 200, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, n[1], n[2], false); save(); },
    format: S => Math.round(S[key] * 100) + '%',
    enabled: layerOn,
    visible: S => !!S.kaleidoGrade
  };
}

export const KALEIDO_CONTROLS = [
  // Sits in the drawer's Layers group straight after the Flowers toggle.
  // Off by default: a first visit looks exactly as it did before.
  {
    id: 'lKaleido', section: 'layers', label: 'Kaleidoscope', kind: 'toggle', def: false,
    get: S => !!S.layers.kaleido,
    set: (S, on) => { S.layers.kaleido = on; save(); }
  },
  // The same switch again at the head of the Kaleidoscope section. Every
  // other control here dims while the layer is off, so without this one the
  // section had no way in from inside it. It has no enabled(), so it never
  // dims itself.
  {
    id: 'kaleidoOn', section: 'kaleido', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.kaleido,
    set: (S, on) => { S.layers.kaleido = on; save(); }
  },
  // The radial fade in from the centre, the rings' Ring fade in for this
  // layer: 0 is no fade, higher values ease the shapes in further out.
  // Second in the section, beside the switch, since it shapes how the
  // whole layer reads rather than any one kind of motion.
  percent('kaleidoFade', 'kaleidoFade', 'Fade in'),

  // How many wedges the circle is cut into. The readout keeps the number
  // first, so clicking it to type opens on the fold count itself.
  direct('kaleidoFolds', 'kaleidoFolds', 'Symmetry', 1, S => S.kaleidoFolds + '-fold'),
  {
    // Whether alternate wedges are reflected, the way a real kaleidoscope's
    // mirrors fold the image, or simply repeated around the circle.
    id: 'kaleidoMirror', section: 'kaleido', label: 'Mirror', kind: 'toggle', def: DEF_MIRROR,
    get: S => !!S.kaleidoMirror,
    set: (S, on) => { S.kaleidoMirror = !!on; save(); },
    enabled: layerOn
  },
  percent('kaleidoDensity', 'kaleidoDensity', 'Density'),
  direct('kaleidoSpeed', 'kaleidoSpeed', 'Speed', 0.05, times2('kaleidoSpeed')),
  direct('kaleidoSize', 'kaleidoSize', 'Max size', 0.05, times2('kaleidoSize')),
  percent('kaleidoSizeVar', 'kaleidoSizeVar', 'Size variance'),
  {
    // Whether a shape grows as it comes toward the rim. Checked, each one
    // keeps one size for its whole flight (Max size times its own share of
    // the variance) while it still flies outward and fades as before.
    id: 'kaleidoConstSize', section: 'kaleido', label: 'Constant size', kind: 'toggle', def: DEF_CONST_SIZE,
    get: S => !!S.kaleidoConstSize,
    set: (S, on) => { S.kaleidoConstSize = !!on; save(); },
    enabled: layerOn
  },

  // Rotation comes in three layers, largest first, each under its own
  // heading so the names say which kind of turning a slider moves.
  //
  // Complete rotation is the whole pattern turning as one. Signed: it
  // twists one way or the other as it flows, and 0 holds it square. The id
  // stays kaleidoTwist so presets and saved settings still find it.
  direct('kaleidoTwist', 'kaleidoTwist', 'Complete rotation', 0.01,
    S => S.kaleidoTwist === 0 ? 'none' : (S.kaleidoTwist > 0 ? '+' : '') + S.kaleidoTwist.toFixed(2),
    'Complete rotation'),

  // Internal rotation is each shape orbiting within its wedge, so it slides
  // into the mirrors, merges with its own reflection and vanishes off the
  // edge. The ceiling reads in radians per second, with 'still' at 0; the
  // randomness runs from every shape moving together in one direction (0)
  // to each shape taking its own speed and direction (100%).
  direct('kaleidoOrbitMax', 'kaleidoOrbitMax', 'Max internal rotation', 0.01,
    S => S.kaleidoOrbitMax === 0 ? 'still' : S.kaleidoOrbitMax.toFixed(2) + ' rad/s',
    'Internal rotation'),
  percent('kaleidoOrbitVar', 'kaleidoOrbitVar', 'Internal randomness', null, 'Internal rotation'),
  // Where a shape is born across its wedge. At 0 every shape starts on the
  // wedge's axis, clear of both mirrors, so it shows whole, centred and
  // pointing outward until internal rotation carries it into a mirror; the
  // readout says so. Higher values spread births off the axis, and 100% is
  // anywhere across the wedge and the band beyond it.
  percent('kaleidoScatter', 'kaleidoScatter', 'Scatter',
    S => S.kaleidoScatter === 0 ? 'on the axis' : Math.round(S.kaleidoScatter * 100) + '%',
    'Internal rotation'),

  // Shape spin is each shape turning about its own centre, at its own rate
  // up to the ceiling set here; the randomness spreads the shapes between
  // still and that ceiling. The ceiling reads in radians per second so a
  // typed value means something exact, with 'still' at 0 so nobody wonders
  // whether 0 means stopped. A step of 0.01 so the default, 0.35, is a
  // position the slider can land on. The ids stay kaleidoSpinMax and
  // kaleidoSpinVar for presets and saved settings.
  direct('kaleidoSpinMax', 'kaleidoSpinMax', 'Max shape spin', 0.01,
    S => S.kaleidoSpinMax === 0 ? 'still' : S.kaleidoSpinMax.toFixed(2) + ' rad/s', 'Shape spin'),
  percent('kaleidoSpinVar', 'kaleidoSpinVar', 'Spin randomness', null, 'Shape spin'),

  {
    // Which atlas the shapes are drawn from. Switching swaps the images
    // under the live shapes once the new atlas is ready, so the pattern
    // keeps flowing rather than restarting.
    id: 'kaleidoSet', section: 'kaleido', sub: 'Shapes', label: 'Image set', kind: 'segment', def: 1,
    options: [
      { value: 1, label: 'Set 1', domId: null },
      { value: 2, label: 'Set 2', domId: null }
    ],
    get: S => S.kaleidoSet,
    set: (S, v) => { S.kaleidoSet = fit(Number(v), 1, 2, true); save(); },
    enabled: layerOn
  },
  {
    // Multi-select over the shape families, after the word themes' chips in
    // schema-visual.js. get() returns the lit indices, with the empty list
    // reading as every family. set(S, value) toggles exactly one: the first
    // touch on the blanket "all" makes it an explicit set so that one family
    // can be taken out of it, and turning the last lit family off lights
    // them all again rather than leaving the layer with nothing to draw.
    id: 'kaleidoFamilies', section: 'kaleido', sub: 'Shapes', label: 'Shapes', kind: 'segment', multi: true,
    options: FAMILIES.map((label, i) => ({ value: i, label, domId: null })),
    get: S => (S.kaleidoFamilies && S.kaleidoFamilies.length ? S.kaleidoFamilies : ALL_FAMILIES),
    set: (S, value) => {
      const i = Number(value);
      if (!Number.isInteger(i) || i < 0 || i >= N_FAM) return;
      const cur = S.kaleidoFamilies && S.kaleidoFamilies.length ? S.kaleidoFamilies : ALL_FAMILIES;
      const next = cur.indexOf(i) >= 0 ? cur.filter(v => v !== i) : cur.concat(i);
      S.kaleidoFamilies = cleanFamilies(next);
      save();
    },
    format: S => {
      const n = S.kaleidoFamilies && S.kaleidoFamilies.length ? S.kaleidoFamilies.length : N_FAM;
      return n === N_FAM ? 'all shapes' : n + ' of ' + N_FAM;
    },
    enabled: layerOn
  },

  // How far the kaleidoscope follows the strobe, in colour and in
  // brightness. Both default to 0, a steady layer of its own on top of the
  // flicker, and the readouts spell out what 0 means.
  // The motifs' own color, graded before any tint toward the strobe. The
  // switch heads the group; off, the grade is not applied and the sliders
  // are hidden, keeping their values for when it comes back on.
  {
    id: 'kaleidoGrade', section: 'kaleido', sub: 'Color', label: 'On', kind: 'toggle', def: DEF_GRADE,
    get: S => !!S.kaleidoGrade,
    set: (S, on) => { S.kaleidoGrade = !!on; save(); },
    enabled: layerOn
  },
  grade('kaleidoBright', 'kaleidoBright', 'Brightness'),
  grade('kaleidoContrast', 'kaleidoContrast', 'Contrast'),
  grade('kaleidoSat', 'kaleidoSat', 'Saturation'),

  percent('kaleidoOpacity', 'kaleidoOpacity', 'Opacity', null, 'With the strobe'),
  percent('kaleidoTint', 'kaleidoTint', 'Tint to strobe colour',
    S => S.kaleidoTint === 0 ? 'own colour' : Math.round(S.kaleidoTint * 100) + '%',
    'With the strobe'),
  percent('kaleidoPulse', 'kaleidoPulse', 'Pulse with strobe',
    S => S.kaleidoPulse === 0 ? 'never flickers' : Math.round(S.kaleidoPulse * 100) + '%',
    'With the strobe')
];

export const KALEIDO_SECTIONS = [
  { id: 'kaleido', title: 'Kaleidoscope' }
];
