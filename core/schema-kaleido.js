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
import { retimeRoomPhase } from './room-clock.js';
import { KALEIDOSCOPE_SETS, KALEIDOSCOPE_SET_COUNT, kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';
import { subDrawer } from './schema-visual.js';
import { varianceRows } from './schema-variance.js';

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
// On by default: a set with a high resolution sheet (sets.mjs imageHi) is
// drawn from it. Records from before the toggle existed leave it on.
const DEF_HI_RES = true;
const NUM = [
  // key,               min,  max, def,  integer
  ['kaleidoFolds',       3,   32,  8,    true ],
  ['kaleidoDensity',     0,   1,   0.5,  false],
  ['kaleidoSpeed',       0,   3,   1,    false],
  // How far each shape's speed strays from Speed, and the seconds one
  // cycle of that wander takes, as the strobe's variance rates read.
  ['kaleidoSpeedVar',    0,   1,   0.15, false],
  ['kaleidoSpeedPeriod', 1,   60,  10,   true ],
  // How far the flow leans from an even zoom (0, every radius growing by
  // the same factor) toward a true flythrough (1), far shapes slow and
  // small near the centre, near ones rushing past the rim.
  ['kaleidoDepth',       0,   1,   0,    false],
  ['kaleidoSize',        0.2, 3,   1,    false],
  ['kaleidoSizeVar',     0,   1,   0.6,  false],
  ['kaleidoSpinMax',     0,   3,   0.35, false],
  ['kaleidoSpinVar',     0,   1,   0.7,  false],
  ['kaleidoTwist',      -1,   1,   0.04, false],
  ['kaleidoOrbitMax',    0,   2,   0.25, false],
  ['kaleidoOrbitVar',    0,   1,   0.7,  false],
  // the internal rotation ceiling's variance: the standard percent dip on
  // the room clock (core/strobe.js VARIANCES). Not kaleidoOrbitVar, which
  // is the Internal randomness spread above.
  ['kaleidoOrbitMaxVar', 0,   1,   0,    false],
  ['kaleidoOrbitMaxPeriod', 1, 60, 10,   true ],
  ['kaleidoOrbitMaxPeriodOff', 0, 1, 0,  false],
  // 0 seats every new shape on its wedge's axis, whole and pointing
  // outward; 1 throws it anywhere across the wedge and beyond, as before.
  ['kaleidoScatter',     0,   1,   0,    false],
  ['kaleidoOpacity',    0,   1,   0.9,  false],
  // the Opacity's variance: the standard percent dip on the room clock, as
  // the flowers' Opacity has (core/strobe.js VARIANCES)
  ['kaleidoOpacityVar',  0,   1,   0,    false],
  ['kaleidoOpacityPeriod', 1, 60,  10,   true ],
  ['kaleidoOpacityPeriodOff', 0, 1, 0,   false],
  // How far out from the centre a shape eases in: the same 0 to 1 amount,
  // curve and default as the tunnel rings' Ring fade in (core/fade.js).
  ['kaleidoFade',        0,   1,   0.55, false],
  // the fade radius's variance: the same percent dip on the room clock
  // (core/strobe.js VARIANCES)
  ['kaleidoFadeVar',     0,   1,   0,    false],
  ['kaleidoFadePeriod',  1,   60,  10,   true ],
  ['kaleidoFadePeriodOff', 0, 1,   0,    false],
  // Each piece's own fade in, in seconds of motion: eased up from nothing
  // over its first this-many seconds (gpu/kaleido.js bornT), so no birth
  // can land as a pop whatever put the piece there. 0 turns it off.
  ['kaleidoFadeInS',     0,   10,  1.5,  false],
  ['kaleidoTint',        0,   1,   0,    false],
  // the tint's variance: the standard percent dip on the room clock, as
  // the flowers' tint has (core/strobe.js VARIANCES)
  ['kaleidoTintVar',     0,   1,   0,    false],
  ['kaleidoTintPeriod',  1,   60,  10,   true ],
  ['kaleidoTintPeriodOff', 0, 1,   0,    false],
  ['kaleidoPulse',       0,   1,   0,    false],
  // the pulse's variance: the standard percent dip on the room clock, as
  // the flowers' pulse has (core/strobe.js VARIANCES)
  ['kaleidoPulseVar',    0,   1,   0,    false],
  ['kaleidoPulsePeriod', 1,   60,  10,   true ],
  ['kaleidoPulsePeriodOff', 0, 1,  0,    false],
  // Which motif atlas the shapes come from (assets/kaleidoscope/sets.mjs): 1 the
  // botanical atlas, 2 petal specimens, 3 petals and green leaves, 4 ferns
  // and wildflower petals, 5 botanical specimens, 6 the original motifs,
  // 7 colorful shapes, 8 flat colorful shapes, 9 confetti and sparkles,
  // 10 photoreal confetti and sparkles, 11 fireworks, 12 peaceful shapes.
  ['kaleidoSet',         1,   KALEIDOSCOPE_SET_COUNT, 1, true],
  // Seconds over which a change of Image set crosses the births over from
  // the old set to the new one (gpu/kaleido.js). 0 is instant, the swap
  // under the live shapes the layer always made, so a preset from before
  // this looks exactly as it did.
  ['kaleidoSetXfade',    0,   60,  0,    false],
  // Seconds over which a change of Symmetry (the fold count, or Mirror)
  // dissolves from the old pattern into the new one (gpu/kaleido.js). 0 is
  // instant, the snap the layer always made, so a preset from before this
  // looks exactly as it did.
  ['kaleidoFoldXfade',   0,   60,  0,    false],
  // The layer's own colour grade, applied in the fold: 1 leaves the motifs
  // as they are, 0 is black, flat grey or greyscale, 2 doubles the effect.
  ['kaleidoBright',      0,   2,   1,    false],
  ['kaleidoContrast',    0,   2,   1,    false],
  ['kaleidoSat',         0,   2,   1,    false],
  // The Trails drawer: video feedback of the folded pattern (gpu/kaleido.js,
  // after the fold), the same rows, ranges and defaults as the Confetti
  // layer's Feedback drawer (core/schema-confetti.js). Everything at its
  // default leaves the layer exactly as it was: no trails, no image.
  ['kaleidoFbAmt',       0,   1,   0,    false],   // how long the pattern leaves a trail
  ['kaleidoFbOpacity',   0,   1,   1,    false],   // how solidly the feedback image lands on the scene
  ['kaleidoFbOpacityVar', 0,  1,   0,    false],   // how far that Opacity dips below its setting over time
  ['kaleidoFbOpacityVarPeriod', 1, 120, 20, true],  // seconds for one swing of it
  ['kaleidoFbStream',   -2,   2,   0,    false],   // the trails stream outward (+) or inward (-), signed
  ['kaleidoFbTwist',    -1,   1,   0,    false],   // the trails turn about the centre, + clockwise, signed
  // Amount dips, Stream and Twist swing (down as far as Lo, up as far as
  // Hi, in the owner's own units), once every Rate seconds.
  ['kaleidoFbAmtVar',    0,   1,   0,    false],
  ['kaleidoFbAmtVarRate', 1, 120,  20,   true ],
  ['kaleidoFbStreamVarLo', -4, 0,  0,    false],
  ['kaleidoFbStreamVarHi', 0,  4,  0,    false],
  ['kaleidoFbStreamVarRate', 1, 120, 20, true ],
  ['kaleidoFbTwistVarLo', -2, 0,   0,    false],
  ['kaleidoFbTwistVarHi', 0,  2,   0,    false],
  ['kaleidoFbTwistVarRate', 1, 120, 20,  true ],
  ['kaleidoFbPulse',     0,   1,   0,    false],   // how far the whole feedback image brightens and darkens with the strobe
  ['kaleidoFbPulseVar',  0,   1,   0,    false],   // how far that pulse amount swings down from its setting and back
  ['kaleidoFbPulseRate', 1,   60,  10,   true ],   // seconds for one swing of the pulse variance
  // The room-clocked swings' phase offsets (core/room-clock.js), as
  // confetti's: state, not controls, written by each rate's set().
  ['kaleidoFbAmtVarRateOff', 0, 1, 0,    false],
  ['kaleidoFbStreamVarRateOff', 0, 1, 0, false],
  ['kaleidoFbTwistVarRateOff', 0, 1, 0,  false],
  ['kaleidoFbPulseRateOff', 0, 1,  0,    false]
];

// Each atlas names and maps its own semantic groups in sets.mjs. Generated
// sheets often interleave subjects, so a group can contain arbitrary tile
// indices rather than being forced to occupy one row.
const FAMILY_OPTIONS = KALEIDOSCOPE_SETS.map(set => set && Object.freeze(
  set.groups.map((item, i) => Object.freeze({ value: i, label: item.label, domId: null }))
));
const ALL_FAMILIES = KALEIDOSCOPE_SETS.map(set => set && Object.freeze(set.groups.map((_, i) => i)));

// A slider's rounded position can come back as 1.1500000000000001; this
// trims it to the step's precision and clamps it into range, so S holds the
// clean number the readout shows and the saved JSON stays tidy.
function fit(v, min, max, integer) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return integer ? Math.round(v) : Math.round(v * 10000) / 10000;
}

// The Set crossfade slider's taper, the Performance window's ramp curve
// (ui/screens/performer.js): an exponential through 0 over 0 to 60 s, so 0
// to 5 s takes about the first 42% of the track. Fine positions, so every
// value the snap below allows has a position of its own and a typed time
// lands exactly; snapped to tenths of a second under 5 s and to half
// seconds above, the precision a crossfade of that length can use.
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
function cleanFamilies(list, set) {
  const nFam = kaleidoscopeSet(set).groups.length;
  const seen = new Array(nFam).fill(false);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= nFam || seen[v]) continue;
    seen[v] = true;
    n++;
  }
  if (n === 0 || n === nFam) return [];
  const out = [];
  for (let i = 0; i < nFam; i++) if (seen[i]) out.push(i);
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
  if (typeof S.kaleidoHiRes !== 'boolean') S.kaleidoHiRes = DEF_HI_RES;
  if (typeof S.kaleidoFbTwistVarOn !== 'boolean') S.kaleidoFbTwistVarOn = true;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
  S.kaleidoFamilies = Array.isArray(S.kaleidoFamilies) ? cleanFamilies(S.kaleidoFamilies, S.kaleidoSet) : [];
}

// A plain copy of the kaleidoscope state, the shape store.js writes and a
// preset snapshot carries. The layer switch goes under its own flat name,
// as flowersOn does, so the record does not look like a partial v0 layers
// object. The family list is copied so the record never aliases S.
export function kaleidoStateOf(S) {
  const out = { kaleidoOn: !!S.layers.kaleido, kaleidoMirror: !!S.kaleidoMirror, kaleidoConstSize: !!S.kaleidoConstSize, kaleidoGrade: !!S.kaleidoGrade, kaleidoHiRes: !!S.kaleidoHiRes,
    kaleidoFbTwistVarOn: S.kaleidoFbTwistVarOn !== false };
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
  if (typeof o.kaleidoHiRes === 'boolean') S.kaleidoHiRes = o.kaleidoHiRes;
  if (typeof o.kaleidoFbTwistVarOn === 'boolean') S.kaleidoFbTwistVarOn = o.kaleidoFbTwistVarOn;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
  if (Array.isArray(o.kaleidoFamilies)) S.kaleidoFamilies = cleanFamilies(o.kaleidoFamilies, S.kaleidoSet);
}

// Every control in the Kaleidoscope section dims while the layer is off, the
// same way the Flowers section does, so the viewer can see what the
// kaleidoscope would do before switching it on.
const layerOn = S => !!S.layers.kaleido;

// One slider bound 1:1 to a kaleidoscope field (a multiplier, a rate or a
// count), whose range and default come from the NUM table so the two can
// never disagree.
function direct(id, key, label, step, format) {
  const n = spec(key);
  const c = {
    id, section: 'kaleido', label, kind: 'slider',
    min: n[1], max: n[2], step, def: n[3],
    get: S => S[key],
    set: (S, pos) => { S[key] = fit(pos, n[1], n[2], n[4]); save(); },
    format,
    enabled: layerOn
  };
  return c;
}

// One whole-percent slider over a 0 to 1 field.
function percent(id, key, label, format) {
  const n = spec(key);
  const c = {
    id, section: 'kaleido', label, kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, 0, 1, false); save(); },
    format: format || (S => Math.round(S[key] * 100) + '%'),
    enabled: layerOn
  };
  return c;
}

const times2 = key => S => S[key].toFixed(2) + '×';

// Tags a control as part of the variance of the row straight above it (the
// schema's varianceOf), so the drawer folds it out from under that row.
const varianceOf = (owner, c) => { c.varianceOf = owner; return c; };
// Nests a control in the sub-drawer straight above it (the schema's
// `parent`), so the drawer folds it with that drawer.
const under = (parent, c) => { c.parent = parent; return c; };

// One whole-percent slider over a 0 to 2 grade field, 100% unchanged,
// shown only while the Color switch is on, and drawn as that switch's child.
function grade(id, key, label) {
  const n = spec(key);
  return {
    id, section: 'kaleido', label, kind: 'slider',
    parent: 'kaleidoGrade',
    min: 0, max: 200, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, n[1], n[2], false); save(); },
    format: S => Math.round(S[key] * 100) + '%',
    enabled: layerOn,
    visible: S => !!S.kaleidoGrade
  };
}

// The Trails drawer's helpers, confetti's own (core/schema-confetti.js).
// A room-clocked swing's rate: the change is folded into the swing's phase
// offset before the write (core/room-clock.js), so in a broadcast room it
// carries on from where it is at the new rate.
function setRate(S, key, v) {
  retimeRoomPhase(S, key + 'Off', S[key], v);
  S[key] = v;
}
// A range row's readout: 'none' while both knobs sit on the centre, else
// how far down, then how far up, each with its sign, in the owner's units.
function sideText(v) {
  const num = Math.abs(v).toFixed(2);
  if (v === 0) return num;
  return (v < 0 ? '−' : '+') + num;
}
function rangeText(lo, hi) {
  return lo === 0 && hi === 0 ? 'none' : sideText(lo) + ' / ' + sideText(hi);
}
// The variance fold under Stream or Twist: how far it swings each way, and
// how long one swing takes, folded out from under its owner (drawer.js,
// varianceOf). key is the NUM prefix; span the owner's whole slider span,
// so either knob can carry it from any setting to either end.
// gpu/kaleido.js does the swinging and clamps to the owner's range.
function fbVariance(owner, key, span, switchId) {
  const lo = key + 'Lo', hi = key + 'Hi', rate = key + 'Rate';
  const visible = switchId ? S => S[switchId] !== false : undefined;
  return [
    {
      id: key, section: 'kaleido', label: 'Variance', kind: 'range',
      varianceOf: owner,
      min: -span, max: span, step: 0.01, defLo: 0, defHi: 0,
      getLo: S => S[lo],
      getHi: S => S[hi],
      setLo: (S, v) => { S[lo] = fit(v, -span, 0); save(); },
      setHi: (S, v) => { S[hi] = fit(v, 0, span); save(); },
      format: S => rangeText(S[lo], S[hi]),
      enabled: layerOn, parent: switchId || 'kaleidoTrailsDrawer', visible
    },
    {
      id: rate, section: 'kaleido', label: 'Variance rate', kind: 'slider',
      varianceOf: owner,
      min: 1, max: 120, step: 1, def: spec(rate)[3],
      get: S => S[rate],
      set: (S, pos) => { setRate(S, rate, fit(pos, 1, 120, true)); save(); },
      format: S => S[rate] + 's / cycle',
      enabled: layerOn, parent: switchId || 'kaleidoTrailsDrawer', visible
    }
  ];
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
  // ---- four sub-drawers, Motion, Shapes, Brightness and Color (see
  // subDrawer in schema-visual.js), each with its rows straight after it.
  // Rotation's three kinds sat under headings of their own before the
  // drawers; a heading inside a drawer would end its run, and the labels
  // already say which kind of turning a slider moves ----
  subDrawer('kaleidoMotionDrawer', 'Motion', 'kaleido', ['kaleidoSpeed', 'kaleidoDensity']),
  under('kaleidoMotionDrawer', Object.assign(
    direct('kaleidoSpeed', 'kaleidoSpeed', 'Speed', 0.05, times2('kaleidoSpeed')),
    // the glowing bar: a reference shape's swing, the envelope every shape
    // rides at its own phase, as gpu/kaleido.js writes it each frame
    { effective: S => S.kaleidoSpeedVar > 0 && typeof S.effKaleidoSpeed === 'number'
        ? S.effKaleidoSpeed : undefined })),
  // The speed's variance and its rate fold out from under Speed, and the
  // size's from under Max size (drawer.js, the schema's varianceOf).
  varianceOf('kaleidoSpeed', percent('kaleidoSpeedVar', 'kaleidoSpeedVar', 'Speed variance')),
  varianceOf('kaleidoSpeed', direct('kaleidoSpeedPeriod', 'kaleidoSpeedPeriod', 'Variance rate', 1, S => S.kaleidoSpeedPeriod + 's / cycle')),
  // Depth: 0 is the flat continuous zoom as ever, every shape's radius
  // growing by the same factor each second, and the readout says so; 100%
  // is a true flythrough, far shapes hanging small near the centre and
  // rushing past the rim, each at its own distance, so shapes at one radius
  // slide past one another. A whole flight keeps Speed's length throughout.
  under('kaleidoMotionDrawer', percent('kaleidoDepth', 'kaleidoDepth', 'Depth',
    S => S.kaleidoDepth === 0 ? 'even zoom' : Math.round(S.kaleidoDepth * 100) + '%')),
  under('kaleidoMotionDrawer', percent('kaleidoDensity', 'kaleidoDensity', 'Density')),
  // Rotation comes in three layers, largest first.
  //
  // Complete rotation is the whole pattern turning as one. Signed: it
  // twists one way or the other as it flows, and 0 holds it square. The id
  // stays kaleidoTwist so presets and saved settings still find it.
  under('kaleidoMotionDrawer', direct('kaleidoTwist', 'kaleidoTwist', 'Complete rotation', 0.01,
    S => S.kaleidoTwist === 0 ? 'none' : (S.kaleidoTwist > 0 ? '+' : '') + S.kaleidoTwist.toFixed(2))),
  // Internal rotation is each shape orbiting within its wedge, so it slides
  // into the mirrors, merges with its own reflection and vanishes off the
  // edge. The ceiling reads in radians per second, with 'still' at 0; the
  // randomness runs from every shape moving together in one direction (0)
  // to each shape taking its own speed and direction (100%).
  under('kaleidoMotionDrawer', direct('kaleidoOrbitMax', 'kaleidoOrbitMax', 'Max internal rotation', 0.01,
    S => S.kaleidoOrbitMax === 0 ? 'still' : S.kaleidoOrbitMax.toFixed(2) + ' rad/s')),
  varianceOf('kaleidoOrbitMax', under('kaleidoMotionDrawer',
    percent('kaleidoOrbitMaxVar', 'kaleidoOrbitMaxVar', 'Internal rotation variance'))),
  varianceOf('kaleidoOrbitMax', under('kaleidoMotionDrawer', {
    // the rate on the room clock, retimed as the tint's is below
    id: 'kaleidoOrbitMaxPeriod', section: 'kaleido', label: 'Internal rotation variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.kaleidoOrbitMaxPeriod,
    set: (S, pos) => {
      const v = fit(pos, 1, 60, true);
      retimeRoomPhase(S, 'kaleidoOrbitMaxPeriodOff', S.kaleidoOrbitMaxPeriod, v);
      S.kaleidoOrbitMaxPeriod = v;
      save();
    },
    format: S => S.kaleidoOrbitMaxPeriod + 's / cycle',
    enabled: layerOn
  })),
  under('kaleidoMotionDrawer', percent('kaleidoOrbitVar', 'kaleidoOrbitVar', 'Internal randomness')),
  // Shape spin is each shape turning about its own centre, at its own rate
  // up to the ceiling set here; the randomness spreads the shapes between
  // still and that ceiling. The ceiling reads in radians per second so a
  // typed value means something exact, with 'still' at 0 so nobody wonders
  // whether 0 means stopped. A step of 0.01 so the default, 0.35, is a
  // position the slider can land on. The ids stay kaleidoSpinMax and
  // kaleidoSpinVar for presets and saved settings.
  under('kaleidoMotionDrawer', direct('kaleidoSpinMax', 'kaleidoSpinMax', 'Max shape spin', 0.01,
    S => S.kaleidoSpinMax === 0 ? 'still' : S.kaleidoSpinMax.toFixed(2) + ' rad/s')),
  under('kaleidoMotionDrawer', percent('kaleidoSpinVar', 'kaleidoSpinVar', 'Spin randomness')),

  subDrawer('kaleidoShapesDrawer', 'Shapes', 'kaleido', ['kaleidoSet', 'kaleidoFolds']),
  {
    // Which atlas the shapes are drawn from. Switching never restarts the
    // pattern: at Set crossfade instant it swaps the images under the live
    // shapes once the new atlas is ready, and with a crossfade time the
    // births cross over to the new set instead (see kaleidoSetXfade).
    id: 'kaleidoSet', section: 'kaleido', label: 'Image set', kind: 'segment', dropdown: true, def: 1,
    parent: 'kaleidoShapesDrawer',
    // the strip's summary says just 'Set 1'; the row keeps its full labels
    summaryLabel: '',
    format: S => 'Set ' + S.kaleidoSet,
    options: KALEIDOSCOPE_SETS.slice(1).map(set => ({
      value: set.id,
      label: 'Set ' + set.id + ' - ' + set.name,
      domId: null,
    })),
    get: S => S.kaleidoSet,
    set: (S, v) => {
      S.kaleidoSet = fit(Number(v), 1, KALEIDOSCOPE_SET_COUNT, true);
      // Group indices mean different things in each atlas. A new set starts
      // with all of its categories selected instead of inheriting another
      // set's numeric selection.
      S.kaleidoFamilies = [];
      save();
    },
    enabled: layerOn
  },
  {
    // Whether a set with a high resolution sheet (sets.mjs imageHi; set 1
    // so far) is drawn from it rather than from its ordinary one. Switching
    // it reloads the current set's atlas and swaps it in as a change of
    // Image set does (instant, or across the Set crossfade). Sets without
    // one ignore it.
    id: 'kaleidoHiRes', section: 'kaleido', label: 'High resolution', kind: 'toggle', def: DEF_HI_RES,
    parent: 'kaleidoShapesDrawer',
    get: S => !!S.kaleidoHiRes,
    set: (S, on) => { S.kaleidoHiRes = !!on; save(); },
    enabled: layerOn
  },
  {
    // How a change of Image set crosses over. Instant swaps the images
    // under the live shapes, as the layer always did; a time keeps every
    // shape already flying on its own set until it leaves, and tips the
    // births over from the old set to the new across that many seconds,
    // counted from when the new set has loaded. No opacity fade: the old
    // shapes simply stop being born. The track is the Performance window's
    // ramp taper (an exponential through 0, so the short times get most of
    // the travel), snapped to half seconds.
    id: 'kaleidoSetXfade', section: 'kaleido', label: 'Set crossfade', kind: 'slider',
    parent: 'kaleidoShapesDrawer',
    min: 0, max: XFADE_POS, step: 1, def: 0,
    get: S => xfadeToPos(S.kaleidoSetXfade),
    set: (S, pos) => { S.kaleidoSetXfade = posToXfade(pos); save(); },
    format: S => {
      const v = S.kaleidoSetXfade;
      return v > 0 ? (v === Math.round(v) ? v : v.toFixed(1)) + 's' : 'instant';
    },
    parse: (S, text) => /^\s*inst/i.test(text) ? 0 : xfadeToPos(parseFloat(text)),
    enabled: layerOn
  },
  {
    // Multi-select over the shape families, after the word themes' chips in
    // schema-visual.js. get() returns the lit indices, with the empty list
    // reading as every family. set(S, value) toggles exactly one: the first
    // touch on the blanket "all" makes it an explicit set so that one family
    // can be taken out of it, and turning the last lit family off lights
    // them all again rather than leaving the layer with nothing to draw.
    id: 'kaleidoFamilies', section: 'kaleido', label: 'Families', kind: 'segment', multi: true,
    parent: 'kaleidoShapesDrawer',
    options: FAMILY_OPTIONS[1],
    optionsFor: S => FAMILY_OPTIONS[kaleidoscopeSet(S.kaleidoSet).id],
    get: S => (S.kaleidoFamilies && S.kaleidoFamilies.length
      ? S.kaleidoFamilies
      : ALL_FAMILIES[kaleidoscopeSet(S.kaleidoSet).id]),
    set: (S, value) => {
      const i = Number(value);
      const set = kaleidoscopeSet(S.kaleidoSet);
      const nFam = set.groups.length;
      if (!Number.isInteger(i) || i < 0 || i >= nFam) return;
      const cur = S.kaleidoFamilies && S.kaleidoFamilies.length ? S.kaleidoFamilies : ALL_FAMILIES[set.id];
      const next = cur.indexOf(i) >= 0 ? cur.filter(v => v !== i) : cur.concat(i);
      S.kaleidoFamilies = cleanFamilies(next, set.id);
      save();
    },
    format: S => {
      const nFam = kaleidoscopeSet(S.kaleidoSet).groups.length;
      const n = S.kaleidoFamilies && S.kaleidoFamilies.length ? S.kaleidoFamilies.length : nFam;
      return n === nFam ? 'all shapes' : n + ' of ' + nFam;
    },
    enabled: layerOn
  },
  // How many wedges the circle is cut into. The readout keeps the number
  // first, so clicking it to type opens on the fold count itself.
  under('kaleidoShapesDrawer', direct('kaleidoFolds', 'kaleidoFolds', 'Symmetry', 1, S => S.kaleidoFolds + '-fold')),
  {
    // How a change of Symmetry (the fold count or Mirror) arrives. Instant
    // snaps to the new pattern, as the layer always did; a time draws the
    // old symmetry and the new one together and dissolves from the one to
    // the other across that many seconds. The same taper and snap as Set
    // crossfade.
    id: 'kaleidoFoldXfade', section: 'kaleido', label: 'Symmetry slide', kind: 'slider',
    parent: 'kaleidoShapesDrawer',
    min: 0, max: XFADE_POS, step: 1, def: 0,
    get: S => xfadeToPos(S.kaleidoFoldXfade),
    set: (S, pos) => { S.kaleidoFoldXfade = posToXfade(pos); save(); },
    format: S => {
      const v = S.kaleidoFoldXfade;
      return v > 0 ? (v === Math.round(v) ? v : v.toFixed(1)) + 's' : 'instant';
    },
    parse: (S, text) => /^\s*inst/i.test(text) ? 0 : xfadeToPos(parseFloat(text)),
    enabled: layerOn
  },
  {
    // Whether alternate wedges are reflected, the way a real kaleidoscope's
    // mirrors fold the image, or simply repeated around the circle.
    id: 'kaleidoMirror', section: 'kaleido', label: 'Mirror', kind: 'toggle', def: DEF_MIRROR,
    parent: 'kaleidoShapesDrawer',
    get: S => !!S.kaleidoMirror,
    set: (S, on) => { S.kaleidoMirror = !!on; save(); },
    enabled: layerOn
  },
  under('kaleidoShapesDrawer', direct('kaleidoSize', 'kaleidoSize', 'Max size', 0.05, times2('kaleidoSize'))),
  varianceOf('kaleidoSize', percent('kaleidoSizeVar', 'kaleidoSizeVar', 'Size variance')),
  {
    // Whether a shape grows as it comes toward the rim. Checked, each one
    // keeps one size for its whole flight (Max size times its own share of
    // the variance) while it still flies outward and fades as before.
    id: 'kaleidoConstSize', section: 'kaleido', label: 'Constant size', kind: 'toggle', def: DEF_CONST_SIZE,
    parent: 'kaleidoShapesDrawer',
    get: S => !!S.kaleidoConstSize,
    set: (S, on) => { S.kaleidoConstSize = !!on; save(); },
    enabled: layerOn
  },
  // Where a shape is born across its wedge. At 0 every shape starts on the
  // wedge's axis, clear of both mirrors, so it shows whole, centred and
  // pointing outward until internal rotation carries it into a mirror; the
  // readout says so. Higher values spread births off the axis, and 100% is
  // anywhere across the wedge and the band beyond it.
  under('kaleidoShapesDrawer', percent('kaleidoScatter', 'kaleidoScatter', 'Scatter',
    S => S.kaleidoScatter === 0 ? 'on the axis' : Math.round(S.kaleidoScatter * 100) + '%')),

  // The layer's master opacity, its radial fade in from the centre (the
  // rings' Ring fade in for this layer: 0 is no fade, higher values ease the
  // shapes in further out), and how far it flickers with the strobe.
  subDrawer('kaleidoBrightnessDrawer', 'Brightness', 'kaleido', ['kaleidoOpacity', 'kaleidoFade', 'kaleidoFadeInS']),
  under('kaleidoBrightnessDrawer', percent('kaleidoOpacity', 'kaleidoOpacity', 'Opacity')),
  varianceOf('kaleidoOpacity', under('kaleidoBrightnessDrawer',
    percent('kaleidoOpacityVar', 'kaleidoOpacityVar', 'Opacity variance'))),
  varianceOf('kaleidoOpacity', under('kaleidoBrightnessDrawer', {
    // the rate on the room clock, retimed as the tint's is below
    id: 'kaleidoOpacityPeriod', section: 'kaleido', label: 'Opacity variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.kaleidoOpacityPeriod,
    set: (S, pos) => {
      const v = fit(pos, 1, 60, true);
      retimeRoomPhase(S, 'kaleidoOpacityPeriodOff', S.kaleidoOpacityPeriod, v);
      S.kaleidoOpacityPeriod = v;
      save();
    },
    format: S => S.kaleidoOpacityPeriod + 's / cycle',
    enabled: layerOn
  })),
  under('kaleidoBrightnessDrawer', percent('kaleidoFade', 'kaleidoFade', 'Center fade radius')),
  varianceOf('kaleidoFade', under('kaleidoBrightnessDrawer',
    percent('kaleidoFadeVar', 'kaleidoFadeVar', 'Fade radius variance'))),
  varianceOf('kaleidoFade', under('kaleidoBrightnessDrawer', {
    // the rate on the room clock, retimed as the tint's is below
    id: 'kaleidoFadePeriod', section: 'kaleido', label: 'Fade radius variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.kaleidoFadePeriod,
    set: (S, pos) => {
      const v = fit(pos, 1, 60, true);
      retimeRoomPhase(S, 'kaleidoFadePeriodOff', S.kaleidoFadePeriod, v);
      S.kaleidoFadePeriod = v;
      save();
    },
    format: S => S.kaleidoFadePeriod + 's / cycle',
    enabled: layerOn
  })),
  under('kaleidoBrightnessDrawer', direct('kaleidoFadeInS', 'kaleidoFadeInS', 'Fade in time', 0.1,
    S => (S.kaleidoFadeInS ?? 1.5) < 0.05 ? 'off' : (S.kaleidoFadeInS ?? 1.5).toFixed(1) + 's')),
  under('kaleidoBrightnessDrawer', Object.assign(percent('kaleidoPulse', 'kaleidoPulse', 'Pulse with strobe',
    S => S.kaleidoPulse === 0 ? 'never flickers' : Math.round(S.kaleidoPulse * 100) + '%'), {
    effective: S => S.kaleidoPulseVar > 0
      ? (typeof S.effKaleidoPulse === 'number' ? S.effKaleidoPulse : S.kaleidoPulse) * 100 : undefined
  })),
  varianceOf('kaleidoPulse', under('kaleidoBrightnessDrawer',
    percent('kaleidoPulseVar', 'kaleidoPulseVar', 'Pulse variance'))),
  varianceOf('kaleidoPulse', under('kaleidoBrightnessDrawer', {
    // the rate on the room clock, retimed as the tint's is below
    id: 'kaleidoPulsePeriod', section: 'kaleido', label: 'Pulse variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.kaleidoPulsePeriod,
    set: (S, pos) => {
      const v = fit(pos, 1, 60, true);
      retimeRoomPhase(S, 'kaleidoPulsePeriodOff', S.kaleidoPulsePeriod, v);
      S.kaleidoPulsePeriod = v;
      save();
    },
    format: S => S.kaleidoPulsePeriod + 's / cycle',
    enabled: layerOn
  })),

  // Video feedback of the folded pattern, the Confetti layer's Feedback
  // drawer row for row (core/schema-confetti.js has the long notes): each
  // frame keeps a fading copy of the last, streamed and turned about the
  // field centre, so the whole pattern leaves trails. Shut, its strip shows
  // the amount and the Stream.
  subDrawer('kaleidoTrailsDrawer', 'Feedback', 'kaleido', ['kaleidoFbAmt', 'kaleidoFbStream']),
  // How solidly the whole feedback image lands on the scene, a true
  // opacity; the trails inside it build and fade the same at any setting.
  under('kaleidoTrailsDrawer', percent('kaleidoFbOpacity', 'kaleidoFbOpacity', 'Opacity')),
  // Its dip, the app's standard (stepped with the strobe's own variances,
  // core/strobe.js), as confetti's.
  ...varianceRows('kaleidoFbOpacity', {
    name: 'Opacity', periodMax: 120, parent: 'kaleidoTrailsDrawer', enabled: layerOn,
    effective: S => (S.effKaleidoFbOpacity ?? S.kaleidoFbOpacity) * 100
  }),
  // At 0 no trail; at 100% a trail takes about two seconds to fade to half,
  // the time growing with the square of the slider.
  under('kaleidoTrailsDrawer', Object.assign(percent('kaleidoFbAmt', 'kaleidoFbAmt', 'Amount'), {
    effective: S => S.kaleidoFbAmtVar > 0
      ? (typeof S.effKaleidoFbAmt === 'number' ? S.effKaleidoFbAmt : S.kaleidoFbAmt) * 100 : undefined
  })),
  // Amount's dip: over one rate cycle the trails ease from the setting down
  // by this share and back, never above it.
  varianceOf('kaleidoFbAmt', under('kaleidoTrailsDrawer', percent('kaleidoFbAmtVar', 'kaleidoFbAmtVar', 'Variance'))),
  varianceOf('kaleidoFbAmt', under('kaleidoTrailsDrawer', {
    id: 'kaleidoFbAmtVarRate', section: 'kaleido', label: 'Variance rate', kind: 'slider',
    min: 1, max: 120, step: 1, def: 20,
    get: S => S.kaleidoFbAmtVarRate,
    set: (S, pos) => { setRate(S, 'kaleidoFbAmtVarRate', fit(pos, 1, 120, true)); save(); },
    format: S => S.kaleidoFbAmtVarRate + 's / cycle',
    enabled: layerOn
  })),
  // The trails' own motion: each frame's faded copy is taken a little
  // larger or smaller about the field centre (Stream) and turned about it
  // (Twist), the same way in every direction.
  under('kaleidoTrailsDrawer', Object.assign(
    direct('kaleidoFbStream', 'kaleidoFbStream', 'Stream', 0.01, S => S.kaleidoFbStream === 0 ? 'none'
      : (S.kaleidoFbStream > 0 ? '+' + S.kaleidoFbStream.toFixed(2) + ' out' : S.kaleidoFbStream.toFixed(2) + ' in')),
    { effective: S => (S.kaleidoFbStreamVarLo !== 0 || S.kaleidoFbStreamVarHi !== 0)
        ? (typeof S.effKaleidoFbStream === 'number' ? S.effKaleidoFbStream : S.kaleidoFbStream) : undefined })),
  ...fbVariance('kaleidoFbStream', 'kaleidoFbStreamVar', 4),
  under('kaleidoTrailsDrawer', Object.assign(
    direct('kaleidoFbTwist', 'kaleidoFbTwist', 'Twist', 0.01, S => S.kaleidoFbTwist === 0 ? 'none'
      : (S.kaleidoFbTwist > 0 ? '+' + S.kaleidoFbTwist.toFixed(2) + ' clockwise' : S.kaleidoFbTwist.toFixed(2) + ' counter')),
    { effective: S => S.kaleidoFbTwistVarOn !== false && (S.kaleidoFbTwistVarLo !== 0 || S.kaleidoFbTwistVarHi !== 0)
        ? (typeof S.effKaleidoFbTwist === 'number' ? S.effKaleidoFbTwist : S.kaleidoFbTwist) : undefined })),
  {
    id: 'kaleidoFbTwistVarOn', section: 'kaleido', label: 'Twist variance', kind: 'toggle', def: true,
    varianceOf: 'kaleidoFbTwist',
    // The performance window crossfades this switch over its ramp time
    // (perform.js startMix) through S.kaleidoFbTwistVarMix, 0 the plain
    // Twist and 1 the full swing; runtime only, never saved, 1 when unset.
    mixKey: 'kaleidoFbTwistVarMix',
    get: S => S.kaleidoFbTwistVarOn !== false,
    set: (S, on) => { S.kaleidoFbTwistVarOn = !!on; save(); },
    format: S => S.kaleidoFbTwistVarOn !== false ? 'On' : 'Off',
    enabled: layerOn, parent: 'kaleidoTrailsDrawer'
  },
  ...fbVariance('kaleidoFbTwist', 'kaleidoFbTwistVar', 2, 'kaleidoFbTwistVarOn'),
  // The whole feedback image brightens and darkens with the strobe's
  // flicker by this much, its colour only, so trails darken rather than
  // turning see-through.
  under('kaleidoTrailsDrawer', Object.assign(percent('kaleidoFbPulse', 'kaleidoFbPulse', 'Pulse with strobe',
    S => S.kaleidoFbPulse === 0 ? 'never flickers' : Math.round(S.kaleidoFbPulse * 100) + '%'), {
    effective: S => S.kaleidoFbPulseVar > 0
      ? (typeof S.effKaleidoFbPulse === 'number' ? S.effKaleidoFbPulse : S.kaleidoFbPulse) * 100 : undefined
  })),
  varianceOf('kaleidoFbPulse', under('kaleidoTrailsDrawer', percent('kaleidoFbPulseVar', 'kaleidoFbPulseVar', 'Pulse variance'))),
  varianceOf('kaleidoFbPulse', under('kaleidoTrailsDrawer', {
    id: 'kaleidoFbPulseRate', section: 'kaleido', label: 'Variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.kaleidoFbPulseRate,
    set: (S, pos) => { setRate(S, 'kaleidoFbPulseRate', fit(pos, 1, 60, true)); save(); },
    format: S => S.kaleidoFbPulseRate + 's / cycle',
    enabled: layerOn
  })),

  // The motifs' own color, graded before any tint toward the strobe, then
  // how far the layer takes on the strobe's colour. The grade's switch heads
  // its sliders, indented under it; off, the grade is not applied and the
  // sliders are hidden, keeping their values for when it comes back on.
  subDrawer('kaleidoColorDrawer', 'Color', 'kaleido', ['kaleidoTint']),
  {
    id: 'kaleidoGrade', section: 'kaleido', label: 'Color', kind: 'toggle', def: DEF_GRADE,
    parent: 'kaleidoColorDrawer',
    get: S => !!S.kaleidoGrade,
    set: (S, on) => { S.kaleidoGrade = !!on; save(); },
    enabled: layerOn
  },
  grade('kaleidoBright', 'kaleidoBright', 'Brightness'),
  grade('kaleidoContrast', 'kaleidoContrast', 'Contrast'),
  grade('kaleidoSat', 'kaleidoSat', 'Saturation'),
  under('kaleidoColorDrawer', percent('kaleidoTint', 'kaleidoTint', 'Tint to strobe colour',
    S => S.kaleidoTint === 0 ? 'own colour' : Math.round(S.kaleidoTint * 100) + '%')),
  varianceOf('kaleidoTint', under('kaleidoColorDrawer',
    percent('kaleidoTintVar', 'kaleidoTintVar', 'Tint variance'))),
  varianceOf('kaleidoTint', under('kaleidoColorDrawer', {
    // the rate on the room clock: a new rate folds into the swing's phase
    // offset first (core/room-clock.js), so the dip carries on rather than
    // jumping, as every room-clocked variance rate does
    id: 'kaleidoTintPeriod', section: 'kaleido', label: 'Tint variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.kaleidoTintPeriod,
    set: (S, pos) => {
      const v = fit(pos, 1, 60, true);
      retimeRoomPhase(S, 'kaleidoTintPeriodOff', S.kaleidoTintPeriod, v);
      S.kaleidoTintPeriod = v;
      save();
    },
    format: S => S.kaleidoTintPeriod + 's / cycle',
    enabled: layerOn
  }))
];

// Shorthand names for the shut sub-drawer strips' summaries (see summary in
// schema-visual.js subDrawer), set once here rather than threaded through
// the helpers above.
const KALEIDO_SHORT = { kaleidoFade: 'Fade' };
for (const c of KALEIDO_CONTROLS) if (KALEIDO_SHORT[c.id]) c.summaryLabel = KALEIDO_SHORT[c.id];

export const KALEIDO_SECTIONS = [
  { id: 'kaleido', title: 'Kaleidoscope' }
];
