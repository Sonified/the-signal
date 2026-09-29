// The Confetti layer's controls and the state behind them. New in v1, like
// the Fireworks, so the S field names here are the contract v1/gpu/confetti.js
// reads, and the defaults, ranges and persistence helpers sit beside the
// controls so the one list of confetti fields cannot drift between the
// drawer, the saved session and a preset.
//
// Persistence stays out of the shared v0 settings object for the reason the
// other v1 layers give: v0's saveSettings() writes a fixed list of keys. The
// store writes these into the v1 extra record through confettiStateOf() and
// applyConfettiState().
import { save } from './store.js';
import { subDrawer } from './schema-visual.js';

// The palettes, as v1/gpu/confetti.js reads S.confPalette: six festive hues,
// the strobe's own colour with each piece's hue turned a little, or gold and
// silver foil throughout.
const PALETTES = ['rainbow', 'strobe', 'gold'];
const DEF_PALETTE = 'rainbow';
// Where the feedback sits while folded, as v1/gpu/confetti.js reads
// S.confFbWhere: after the kaleidoscope, trails across the whole pattern, or
// before it, trails inside the wedge that every copy repeats.
const FB_WHERES = ['after', 'before'];
const DEF_FB_WHERE = 'after';
// The fold of the whole confetti field, as the Particles layer's.
const DEF_KALEIDO = false;
const DEF_MIRROR = true;

const NUM = [
  // key,         min, max, def,  integer
  ['confAmount',  0,   1,   0.5 ],   // the birth rate, as a share of the full stream
  ['confSpeed',   0.1, 2,   1   ],   // how fast the pieces come down the tunnel
  ['confSpeedVar', 0,  1,   0   ],   // each new piece's own speed, up to 40% either way
  ['confClump',   0,   1,   0   ],   // 0 a steady stream, 1 every birth in bursts
  ['confSize',    0.2, 50,  1   ],
  ['confSizeVar', 0,   0.95, 0.2],   // each new piece's own size, this far either way
  ['confOpacity', 0,   1,   1   ],   // how solid the pieces are
  ['confFade',    0,   1,   0.55],   // the centre fade in, the rings' own curve
  ['confLife',    0.05, 1,  1   ],   // the share of the flight a piece lives before fading out
  ['confSpread',  0,   1,   0   ],   // how far the paths angle out toward the edges
  ['confFlutter', 0,   1,   1   ],   // how far a piece wobbles off its straight path
  ['confSpin',    0,   3,   1   ],   // how fast the pieces turn
  ['confSpinVarLo', -1, 0,  0   ],   // each new piece's spin, down to this share slower than Rotation speed
  ['confSpinVarHi', 0,  2,  0   ],   // and up to this share faster
  ['confTumble',  0,   1,   1   ],   // 0 spins flat facing the viewer, 1 the full 3D tumble
  ['confAlign',   0,   1,   0   ],   // 1 each new piece is born pointing straight out from the centre
  ['confShine',   0,   1,   0.35],   // the share of pieces that are foil, not paper
  ['confBright',  0,   1,   1   ],
  ['confFeedback', 0,  1,   0   ],   // how long each piece leaves a trail where it passed
  ['confFbOpacity', 0, 1,   1   ],   // how solidly the feedback image lands on the scene
  ['confFbStream', -2, 2,   0   ],   // the trails stream outward (+) or inward (-), signed
  ['confFbTwist', -1,  1,   0   ],   // the trails turn about the centre, + clockwise, signed
  // Each of Amount, Stream and Twist swings over time about its setting: down
  // as far as its Lo, up as far as its Hi, both in the owner's own units and
  // each at most the owner's whole span, once every Rate seconds.
  ['confFbAmtVarLo', -1, 0, 0   ],
  ['confFbAmtVarHi', 0,  1, 0   ],
  ['confFbAmtVarRate', 1, 120, 20, true],
  ['confFbStreamVarLo', -4, 0, 0 ],
  ['confFbStreamVarHi', 0,  4, 0 ],
  ['confFbStreamVarRate', 1, 120, 20, true],
  ['confFbTwistVarLo', -2, 0, 0  ],
  ['confFbTwistVarHi', 0,  2, 0  ],
  ['confFbTwistVarRate', 1, 120, 20, true],
  ['confFbPulse', 0,   1,   0   ],   // how far the whole feedback image brightens and darkens with the strobe
  ['confFbPulseVar', 0, 1,  0   ],   // how far that pulse amount swings down from its setting and back
  ['confFbPulseRate', 1, 60, 10, true],   // seconds for one swing of the pulse variance
  ['confFolds',   3,   16,  8,    true ],   // the kaleidoscope's fold count
  ['confFoldSpin', -1, 1,   0.05]    // the kaleidoscope's turn, signed
];

function fit(v, min, max, integer) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return integer ? Math.round(v) : Math.round(v * 10000) / 10000;
}

function spec(key) {
  for (let i = 0; i < NUM.length; i++) if (NUM[i][0] === key) return NUM[i];
  return null;
}

// The piece shapes, in the order v1/gpu/confetti.js packs them into the
// shader's bitmask (bit i for shape i).
const SHAPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 0, label: 'Square',    domId: null }),
  Object.freeze({ value: 1, label: 'Rectangle', domId: null }),
  Object.freeze({ value: 2, label: 'Circle',    domId: null }),
  Object.freeze({ value: 3, label: 'Oval',      domId: null })
]);
const N_SHAPES = SHAPE_OPTIONS.length;
const ALL_SHAPES = Object.freeze(SHAPE_OPTIONS.map(o => o.value));

// Any list of candidate shape indices, reduced to the canonical form S
// holds, as the kaleidoscope's families are: whole numbers in range, each
// once, ascending. A list naming every shape collapses to the empty "all"
// list, and so does one naming none, since confetti with no shape to be is
// never what anyone meant. Anything that is not a valid index is skipped.
function cleanShapes(list) {
  const seen = [false, false, false, false];
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= N_SHAPES || seen[v]) continue;
    seen[v] = true;
    n++;
  }
  if (n === 0 || n === N_SHAPES) return [];
  const out = [];
  for (let i = 0; i < N_SHAPES; i++) if (seen[i]) out.push(i);
  return out;
}

// Seeds every confetti field not already on S. Called first thing in
// store.load(), beside the other v1 layers' seeds, and only fills gaps.
export function initConfettiState(S) {
  if (typeof S.layers.confetti !== 'boolean') S.layers.confetti = false;
  if (PALETTES.indexOf(S.confPalette) < 0) S.confPalette = DEF_PALETTE;
  if (FB_WHERES.indexOf(S.confFbWhere) < 0) S.confFbWhere = DEF_FB_WHERE;
  if (typeof S.confKaleido !== 'boolean') S.confKaleido = DEF_KALEIDO;
  if (typeof S.confMirror !== 'boolean') S.confMirror = DEF_MIRROR;
  if (typeof S.confFbTwistVarOn !== 'boolean') S.confFbTwistVarOn = true;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
  S.confShapes = Array.isArray(S.confShapes) ? cleanShapes(S.confShapes) : [];
}

// A plain copy of the confetti state, the shape the store writes and a preset
// snapshot carries. The layer switch goes under its own flat name, as
// fireworksOn does.
export function confettiStateOf(S) {
  const out = {
    confettiOn: !!S.layers.confetti,
    confPalette: S.confPalette,
    confFbWhere: S.confFbWhere,
    confKaleido: !!S.confKaleido,
    confMirror: !!S.confMirror,
    confFbTwistVarOn: S.confFbTwistVarOn !== false
  };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  // Copied, so the record never aliases S.
  out.confShapes = Array.isArray(S.confShapes) ? S.confShapes.slice() : [];
  return out;
}

// Restores whatever a record holds, field by field, leaving anything missing
// or malformed as it is and clamping numbers into range.
export function applyConfettiState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.confettiOn === 'boolean') S.layers.confetti = o.confettiOn;
  if (PALETTES.indexOf(o.confPalette) >= 0) S.confPalette = o.confPalette;
  if (FB_WHERES.indexOf(o.confFbWhere) >= 0) S.confFbWhere = o.confFbWhere;
  if (typeof o.confKaleido === 'boolean') S.confKaleido = o.confKaleido;
  if (typeof o.confMirror === 'boolean') S.confMirror = o.confMirror;
  if (typeof o.confFbTwistVarOn === 'boolean') S.confFbTwistVarOn = o.confFbTwistVarOn;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
  if (Array.isArray(o.confShapes)) S.confShapes = cleanShapes(o.confShapes);
}

// Every row dims while the layer is off, as the Fireworks section's do.
const layerOn = S => !!S.layers.confetti;
// The fold's own rows only show while the fold is on.
const isFolded = S => !!S.confKaleido;

// A range row's readout (widgets.js range): 'none' while both knobs sit on
// the centre, else how far down, then how far up, each with its sign and a
// side left at 0 shown plainly. pct reads a fraction as whole percent;
// otherwise it is the owner's own units to two places. Built only when a
// knob moves (the widget caches it), so the strings cost nothing per frame.
function sideText(v, pct) {
  const a = Math.abs(v);
  const num = pct ? Math.round(a * 100) + '%' : a.toFixed(2);
  if (v === 0) return num;
  return (v < 0 ? '−' : '+') + num;
}
function rangeText(lo, hi, pct) {
  return lo === 0 && hi === 0 ? 'none' : sideText(lo, pct) + ' / ' + sideText(hi, pct);
}

// The variance fold under one of the feedback's own settings (Amount, Stream
// or Twist): how far it swings each way, and how long one swing takes. Both
// rows sit in the Feedback sub-drawer and fold out from under their owner by
// its chevron (drawer.js, varianceOf). key is the NUM prefix; span the
// owner's whole slider span in its own units, so either knob can carry it
// from any setting to either end. v1/gpu/confetti.js does the swinging, on
// the layer's own clock, and clamps the result to the owner's range.
function fbVariance(owner, key, span, pct, switchId) {
  const lo = key + 'Lo', hi = key + 'Hi', rate = key + 'Rate';
  const visible = switchId ? S => S[switchId] !== false : undefined;
  return [
    {
      id: key, section: 'confetti', label: 'Variance', kind: 'range',
      varianceOf: owner,
      min: -span, max: span, step: 0.01, defLo: 0, defHi: 0,
      getLo: S => S[lo],
      getHi: S => S[hi],
      setLo: (S, v) => { S[lo] = fit(v, -span, 0); save(); },
      setHi: (S, v) => { S[hi] = fit(v, 0, span); save(); },
      format: S => rangeText(S[lo], S[hi], pct),
      enabled: layerOn, parent: switchId || 'confFeedbackDrawer', visible
    },
    {
      // Seconds for one swing, as the strobe's Variance rate.
      id: rate, section: 'confetti', label: 'Variance rate', kind: 'slider',
      varianceOf: owner,
      min: 1, max: 120, step: 1, def: spec(rate)[3],
      get: S => S[rate],
      set: (S, pos) => { S[rate] = fit(pos, 1, 120, true); save(); },
      format: S => S[rate] + 's / cycle',
      enabled: layerOn, parent: switchId || 'confFeedbackDrawer', visible
    }
  ];
}

export const CONFETTI_CONTROLS = [
  // In the Layers group after Fireworks. Off by default, so a first visit
  // looks exactly as it did before.
  {
    id: 'lConfetti', section: 'layers', label: 'Confetti', kind: 'toggle', def: false,
    get: S => !!S.layers.confetti,
    set: (S, on) => { S.layers.confetti = on; save(); }
  },
  // The same switch at the head of the Confetti section (the drawer puts it
  // in the header). No enabled(), so it never dims itself.
  {
    id: 'confettiOn', section: 'confetti', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.confetti,
    set: (S, on) => { S.layers.confetti = on; save(); }
  },
  {
    id: 'confAmount', section: 'confetti', label: 'Amount', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confAmount')[3] * 100),
    get: S => Math.round(S.confAmount * 100),
    set: (S, pos) => { S.confAmount = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confAmount * 100) + '%',
    enabled: layerOn
  },
  {
    id: 'confSize', section: 'confetti', label: 'Size', kind: 'slider',
    min: 0.2, max: 50, step: 0.05, def: spec('confSize')[3],
    get: S => S.confSize,
    set: (S, pos) => { S.confSize = fit(pos, 0.2, 50); save(); },
    format: S => S.confSize.toFixed(2) + '×',
    enabled: layerOn
  },
  {
    // How much the pieces differ in size: each is up to this much bigger or
    // smaller than Size. The 20% default is the spread the pieces always
    // had. Drawn once as a piece is born, so moving it only shapes the
    // pieces born from then on.
    id: 'confSizeVar', section: 'confetti', label: 'Size variance', kind: 'slider',
    min: 0, max: 95, step: 1, def: Math.round(spec('confSizeVar')[3] * 100),
    get: S => Math.round(S.confSizeVar * 100),
    set: (S, pos) => { S.confSizeVar = fit(pos / 100, 0, 0.95); save(); },
    format: S => Math.round(S.confSizeVar * 100) + '%',
    enabled: layerOn
  },
  {
    // Which shapes the pieces come in, each switched on or off, after the
    // kaleidoscope's Families. get() returns the lit indices, with the empty
    // list reading as all four. set(S, value) toggles exactly one: the first
    // touch on the blanket "all" makes it an explicit set so one shape can
    // be taken out, and a touch on the only lit shape does nothing, so at
    // least one shape always stays on. The shader picks each piece's
    // shape from its seed every frame, so a change reshapes the pieces
    // already in flight as well as the new ones.
    id: 'confShapes', section: 'confetti', label: 'Shapes', kind: 'segment', multi: true,
    options: SHAPE_OPTIONS,
    get: S => (S.confShapes && S.confShapes.length ? S.confShapes : ALL_SHAPES),
    set: (S, value) => {
      const i = Number(value);
      if (!Number.isInteger(i) || i < 0 || i >= N_SHAPES) return;
      const cur = S.confShapes && S.confShapes.length ? S.confShapes : ALL_SHAPES;
      if (cur.length === 1 && cur[0] === i) return;
      const next = cur.indexOf(i) >= 0 ? cur.filter(v => v !== i) : cur.concat(i);
      S.confShapes = cleanShapes(next);
      save();
    },
    format: S => {
      const n = S.confShapes && S.confShapes.length ? S.confShapes.length : N_SHAPES;
      return n === N_SHAPES ? 'all shapes' : n + ' of ' + N_SHAPES;
    },
    enabled: layerOn
  },
  {
    // How solid the pieces are: at 100% paper covers what is behind it, and
    // down from there every piece turns see-through. Brightness is the other
    // way down: it darkens the colour and keeps the pieces solid.
    id: 'confOpacity', section: 'confetti', label: 'Opacity', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confOpacity')[3] * 100),
    get: S => Math.round(S.confOpacity * 100),
    set: (S, pos) => { S.confOpacity = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confOpacity * 100) + '%',
    enabled: layerOn
  },
  {
    id: 'confSpeed', section: 'confetti', label: 'Speed', kind: 'slider',
    min: 0.1, max: 2, step: 0.05, def: spec('confSpeed')[3],
    get: S => S.confSpeed,
    set: (S, pos) => { S.confSpeed = fit(pos, 0.1, 2); save(); },
    format: S => S.confSpeed.toFixed(2) + '×',
    enabled: layerOn
  },
  {
    // How much the pieces differ in speed: at 100% each flies anywhere from
    // 0.6 to 1.4 times Speed, so the quick ones overtake the slow. Drawn
    // once as a piece is born, so moving it only shapes the pieces born from
    // then on. It folds out from under Speed by its chevron (drawer.js,
    // varianceOf), so it has to follow Speed directly; Clump after it is a
    // row of its own again.
    id: 'confSpeedVar', section: 'confetti', label: 'Speed variance', kind: 'slider',
    varianceOf: 'confSpeed',
    min: 0, max: 100, step: 1, def: Math.round(spec('confSpeedVar')[3] * 100),
    get: S => Math.round(S.confSpeedVar * 100),
    set: (S, pos) => { S.confSpeedVar = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confSpeedVar * 100) + '%',
    enabled: layerOn
  },
  {
    // How the pieces are born: at 0 a steady stream, and up from there more
    // of them come together, until at 100% they are born in bursts with
    // nothing between. Each burst is a radial release: a ring all the way
    // round the centre, widening as it comes. The average stays the Amount.
    // It only shapes the
    // births from now on; pieces already flying keep their places.
    id: 'confClump', section: 'confetti', label: 'Clump', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confClump')[3] * 100),
    get: S => Math.round(S.confClump * 100),
    set: (S, pos) => { S.confClump = fit(pos / 100, 0, 1); save(); },
    format: S => S.confClump === 0 ? 'stream' : Math.round(S.confClump * 100) + '%',
    enabled: layerOn
  },
  {
    // How far out from the centre the pieces take to come up to full
    // strength, the tunnel rings' own Fade in curve (core/fade.js), as the
    // particles have it. 0 is no fade at all.
    id: 'confFade', section: 'confetti', label: 'Fade in', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confFade')[3] * 100),
    get: S => Math.round(S.confFade * 100),
    set: (S, pos) => { S.confFade = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confFade * 100) + '%',
    enabled: layerOn
  },
  {
    // How much of its flight a piece lives: 100% flies the whole way to the
    // viewer, lower fades each one out earlier, farther off.
    id: 'confLife', section: 'confetti', label: 'Life', kind: 'slider',
    min: 5, max: 100, step: 1, def: Math.round(spec('confLife')[3] * 100),
    get: S => Math.round(S.confLife * 100),
    set: (S, pos) => { S.confLife = fit(pos / 100, 0.05, 1); save(); },
    format: S => Math.round(S.confLife * 100) + '%',
    enabled: layerOn
  },
  {
    // 0 is the stream as it was, coming straight down the tunnel at the
    // viewer; up, the paths angle out and leave through the edges instead.
    id: 'confSpread', section: 'confetti', label: 'Spread', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confSpread')[3] * 100),
    get: S => Math.round(S.confSpread * 100),
    set: (S, pos) => { S.confSpread = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confSpread * 100) + '%',
    enabled: layerOn
  },
  {
    // The wobble off each piece's path: 0 flies a straight line, 100% is
    // the full flutter. The tumble is untouched; spinning does not bend a
    // path.
    id: 'confFlutter', section: 'confetti', label: 'Flutter', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confFlutter')[3] * 100),
    get: S => Math.round(S.confFlutter * 100),
    set: (S, pos) => { S.confFlutter = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confFlutter * 100) + '%',
    enabled: layerOn
  },
  {
    // How fast the pieces turn. 0 holds every piece still at its angle.
    id: 'confSpin', section: 'confetti', label: 'Rotation speed', kind: 'slider',
    min: 0, max: 3, step: 0.05, def: spec('confSpin')[3],
    get: S => S.confSpin,
    set: (S, pos) => { S.confSpin = fit(pos, 0, 3); save(); },
    format: S => S.confSpin.toFixed(2) + '×',
    enabled: layerOn
  },
  {
    // How much the pieces differ in how fast they turn, folded out from
    // under Rotation speed by its chevron. Each piece draws its own share of
    // its spin, anywhere from 1 + lo to 1 + hi, so at -40% / +120% some turn
    // at 0.6 times their rate and some at 2.2 times, and at -100% some stand
    // still. It is a range so the two sides can differ: slower pieces and
    // faster ones are separate choices. Drawn once as a piece is born, as
    // Speed variance is, so moving it only shapes the pieces born from then
    // on. Alignment still holds, since the spin is counted from the piece's
    // own birth and only its rate changes.
    id: 'confSpinVar', section: 'confetti', label: 'Rotation variance', kind: 'range',
    varianceOf: 'confSpin',
    min: -1, max: 2, step: 0.01, defLo: 0, defHi: 0,
    getLo: S => S.confSpinVarLo,
    getHi: S => S.confSpinVarHi,
    setLo: (S, v) => { S.confSpinVarLo = fit(v, -1, 0); save(); },
    setHi: (S, v) => { S.confSpinVarHi = fit(v, 0, 2); save(); },
    format: S => rangeText(S.confSpinVarLo, S.confSpinVarHi, true),
    enabled: layerOn
  },
  {
    // How far the spin leaves the screen's plane: 0 turns every piece flat,
    // always facing the viewer like a spinning square; 100% is the full 3D
    // tumble, cards flipping edge on and catching the light.
    id: 'confTumble', section: 'confetti', label: '3D rotation', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confTumble')[3] * 100),
    get: S => Math.round(S.confTumble * 100),
    set: (S, pos) => { S.confTumble = fit(pos / 100, 0, 1); save(); },
    format: S => S.confTumble === 0 ? 'flat' : Math.round(S.confTumble * 100) + '%',
    enabled: layerOn
  },
  {
    // How each piece is posed as it is born: at 100% face on, its long side
    // pointing straight out from the centre, as the Kaleidoscope layer seats
    // its shapes; at 0 turned at random. The spin and 3D rotation then carry
    // it on from there, so with Rotation speed at 0 aligned pieces stay
    // aligned. Kept once as a piece is born, so moving it only poses the
    // pieces born from then on.
    id: 'confAlign', section: 'confetti', label: 'Alignment', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confAlign')[3] * 100),
    get: S => Math.round(S.confAlign * 100),
    set: (S, pos) => { S.confAlign = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confAlign * 100) + '%',
    enabled: layerOn
  },
  {
    id: 'confShine', section: 'confetti', label: 'Shine', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confShine')[3] * 100),
    get: S => Math.round(S.confShine * 100),
    set: (S, pos) => { S.confShine = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confShine * 100) + '%',
    enabled: layerOn
  },
  {
    id: 'confPalette', section: 'confetti', label: 'Palette', kind: 'segment', def: DEF_PALETTE,
    options: [
      { value: 'rainbow', label: 'Rainbow',       domId: null },
      { value: 'strobe',  label: 'Strobe',        domId: null },
      { value: 'gold',    label: 'Gold & silver', domId: null }
    ],
    get: S => S.confPalette,
    set: (S, v) => { S.confPalette = PALETTES.indexOf(v) >= 0 ? v : DEF_PALETTE; save(); },
    enabled: layerOn
  },
  {
    id: 'confBright', section: 'confetti', label: 'Brightness', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confBright')[3] * 100),
    get: S => Math.round(S.confBright * 100),
    set: (S, pos) => { S.confBright = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confBright * 100) + '%',
    enabled: layerOn
  },
  // Video feedback, in a sub-drawer of its own (see subDrawer in
  // schema-visual.js) that the viewer opens and shuts, so no rows come and
  // go as a slider moves. Shut, its strip shows the amount and the Stream.
  subDrawer('confFeedbackDrawer', 'Feedback', 'confetti', ['confFeedback', 'confFbStream']),
  // How solidly the whole feedback image, the trails and the pieces drawn
  // into it, lands on the scene: a true opacity, so at 50% all of it is half
  // see-through. It only changes how the image is laid over, never the
  // trails inside it, so they build and fade the same at any setting and
  // turning it back up shows them as they are now. 100% is the image in
  // full.
  {
    id: 'confFbOpacity', section: 'confetti', label: 'Opacity', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confFbOpacity')[3] * 100),
    get: S => Math.round(S.confFbOpacity * 100),
    set: (S, pos) => { S.confFbOpacity = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confFbOpacity * 100) + '%',
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  // Each frame keeps a fading copy of the last, so every piece leaves a
  // trail that stays where it was drawn and dies away. At 0 there is no
  // trail, the pieces as they are; at 100% a trail takes about two seconds
  // to fade to half, and in between the time grows with the square of the
  // slider, so the low end is fine grained. Labelled Amount since the drawer
  // carries the Feedback name; the id stays confFeedback so saved settings
  // and presets still load.
  {
    id: 'confFeedback', section: 'confetti', label: 'Amount', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confFeedback')[3] * 100),
    get: S => Math.round(S.confFeedback * 100),
    effective: S => (S.confFbAmtVarLo !== 0 || S.confFbAmtVarHi !== 0)
      ? (typeof S.effConfFeedback === 'number' ? S.effConfFeedback : S.confFeedback) * 100 : undefined,
    set: (S, pos) => { S.confFeedback = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confFeedback * 100) + '%',
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  // Amount's swing, in the Amount's own share, so its readout is percent to
  // match the row above. Swinging down to 0 clears the image just as the
  // slider at 0 does; the shut strip's summary still shows the setting.
  ...fbVariance('confFeedback', 'confFbAmtVar', 1, true),
  // The trails' own motion, always in the drawer; at an Amount of 0 there is
  // no trail, so they simply have nothing to move. Each frame's faded copy
  // is taken a little larger or smaller about the field centre (Stream) and
  // turned a little about it (Twist), so the trails stream out toward the
  // edges or in to the centre, and swirl, the same way in every direction. Both read 'none' at 0 and carry their sign and direction
  // otherwise.
  {
    id: 'confFbStream', section: 'confetti', label: 'Stream', kind: 'slider',
    min: -2, max: 2, step: 0.01, def: spec('confFbStream')[3],
    get: S => S.confFbStream,
    effective: S => (S.confFbStreamVarLo !== 0 || S.confFbStreamVarHi !== 0)
      ? (typeof S.effConfFbStream === 'number' ? S.effConfFbStream : S.confFbStream) : undefined,
    set: (S, pos) => { S.confFbStream = fit(pos, -2, 2); save(); },
    format: S => S.confFbStream === 0 ? 'none'
      : (S.confFbStream > 0 ? '+' + S.confFbStream.toFixed(2) + ' out' : S.confFbStream.toFixed(2) + ' in'),
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  // Stream's swing, in Stream's units: a span of 4 lets either knob carry it
  // from any setting to either end, out or in, so a swing can breathe the
  // trails outward and back through still.
  ...fbVariance('confFbStream', 'confFbStreamVar', 4, false),
  {
    id: 'confFbTwist', section: 'confetti', label: 'Twist', kind: 'slider',
    min: -1, max: 1, step: 0.01, def: spec('confFbTwist')[3],
    get: S => S.confFbTwist,
    effective: S => S.confFbTwistVarOn !== false && (S.confFbTwistVarLo !== 0 || S.confFbTwistVarHi !== 0)
      ? (typeof S.effConfFbTwist === 'number' ? S.effConfFbTwist : S.confFbTwist) : undefined,
    set: (S, pos) => { S.confFbTwist = fit(pos, -1, 1); save(); },
    format: S => S.confFbTwist === 0 ? 'none'
      : (S.confFbTwist > 0 ? '+' + S.confFbTwist.toFixed(2) + ' clockwise' : S.confFbTwist.toFixed(2) + ' counter'),
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  {
    id: 'confFbTwistVarOn', section: 'confetti', label: 'Twist variance', kind: 'toggle', def: true,
    varianceOf: 'confFbTwist',
    // The performance window crossfades this switch over its ramp time
    // (perform.js startMix) through S.confFbTwistVarMix, 0 the plain Twist
    // and 1 the full swing; runtime only, never saved, 1 when unset.
    mixKey: 'confFbTwistVarMix',
    get: S => S.confFbTwistVarOn !== false,
    set: (S, on) => { S.confFbTwistVarOn = !!on; save(); },
    format: S => S.confFbTwistVarOn !== false ? 'On' : 'Off',
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  // Twist's swing, in Twist's units, a span of 2 for the same reason.
  ...fbVariance('confFbTwist', 'confFbTwistVar', 2, false, 'confFbTwistVarOn'),
  // The whole feedback image, trails and the live pieces alike, brightens
  // and darkens with the strobe's flicker by this much. Only its colour
  // changes, never its coverage, so the trails darken rather than turning
  // see-through. At 0 it never flickers.
  {
    id: 'confFbPulse', section: 'confetti', label: 'Pulse with strobe', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confFbPulse')[3] * 100),
    get: S => Math.round(S.confFbPulse * 100),
    effective: S => S.confFbPulseVar > 0
      ? (typeof S.effConfFbPulse === 'number' ? S.effConfFbPulse : S.confFbPulse) * 100 : undefined,
    set: (S, pos) => { S.confFbPulse = fit(pos / 100, 0, 1); save(); },
    format: S => S.confFbPulse === 0 ? 'never flickers' : Math.round(S.confFbPulse * 100) + '%',
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  // How far the pulse amount swings, as every variance in the app does:
  // over one Variance rate cycle it eases from the setting down by this
  // share and back, so at 100% from the full setting to nothing and back.
  // At 0 the pulse stays where it is set.
  {
    id: 'confFbPulseVar', section: 'confetti', label: 'Pulse variance', kind: 'slider',
    varianceOf: 'confFbPulse',
    min: 0, max: 100, step: 1, def: Math.round(spec('confFbPulseVar')[3] * 100),
    get: S => Math.round(S.confFbPulseVar * 100),
    set: (S, pos) => { S.confFbPulseVar = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confFbPulseVar * 100) + '%',
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  {
    // Seconds for one swing of the pulse variance, as the strobe's Variance
    // rate.
    id: 'confFbPulseRate', section: 'confetti', label: 'Variance rate', kind: 'slider',
    varianceOf: 'confFbPulse',
    min: 1, max: 60, step: 1, def: spec('confFbPulseRate')[3],
    get: S => S.confFbPulseRate,
    set: (S, pos) => { S.confFbPulseRate = fit(pos, 1, 60, true); save(); },
    format: S => S.confFbPulseRate + 's / cycle',
    enabled: layerOn, parent: 'confFeedbackDrawer'
  },
  // Only means something folded, so it shows only while the Kaleidoscope is
  // on: after the kaleidoscope the trails stream and turn across the whole
  // pattern about its centre; before it they live inside the one wedge the
  // fold repeats, so every copy trails alike, and Twist shears the wedge's
  // content out through its edges.
  {
    id: 'confFbWhere', section: 'confetti', label: 'Where', kind: 'segment', def: DEF_FB_WHERE,
    options: [
      { value: 'after',  label: 'After kaleidoscope',  domId: null },
      { value: 'before', label: 'Before kaleidoscope', domId: null }
    ],
    get: S => S.confFbWhere,
    set: (S, v) => { S.confFbWhere = FB_WHERES.indexOf(v) >= 0 ? v : DEF_FB_WHERE; save(); },
    // with the feedback off it does nothing, so it greys out rather than
    // coming and going as the feedback is switched
    enabled: S => layerOn(S) && (S.confFeedback > 0 || S.confFbAmtVarHi > 0),
    visible: isFolded, parent: 'confFeedbackDrawer'
  },
  // An optional fold of the whole confetti field into wedges, exactly as the
  // Particles layer's (the rows copy its shape: the switch under its own
  // heading, the three rows nested under it and shown only while it is on).
  // It sits last because its heading would otherwise gather the rows after
  // it. The fold count reads with the number first, so clicking it to type
  // opens on the count itself; the turn reads 'none' at 0 and carries its
  // sign otherwise.
  {
    id: 'confKaleido', section: 'confetti', label: 'Kaleidoscope', kind: 'toggle', def: DEF_KALEIDO,
    get: S => !!S.confKaleido,
    set: (S, on) => { S.confKaleido = !!on; save(); },
    enabled: layerOn,
    sub: 'Kaleidoscope'
  },
  {
    id: 'confFolds', section: 'confetti', label: 'Symmetry', kind: 'slider',
    min: 3, max: 16, step: 1, def: spec('confFolds')[3],
    get: S => S.confFolds,
    set: (S, pos) => { S.confFolds = fit(pos, 3, 16, true); save(); },
    format: S => S.confFolds + '-fold',
    enabled: layerOn,
    sub: 'Kaleidoscope', visible: isFolded, parent: 'confKaleido'
  },
  {
    id: 'confMirror', section: 'confetti', label: 'Mirror', kind: 'toggle', def: DEF_MIRROR,
    get: S => !!S.confMirror,
    set: (S, on) => { S.confMirror = !!on; save(); },
    enabled: layerOn,
    sub: 'Kaleidoscope', visible: isFolded, parent: 'confKaleido'
  },
  {
    id: 'confFoldSpin', section: 'confetti', label: 'Rotation', kind: 'slider',
    min: -1, max: 1, step: 0.01, def: spec('confFoldSpin')[3],
    get: S => S.confFoldSpin,
    set: (S, pos) => { S.confFoldSpin = fit(pos, -1, 1); save(); },
    format: S => S.confFoldSpin === 0 ? 'none' : (S.confFoldSpin > 0 ? '+' : '') + S.confFoldSpin.toFixed(2),
    enabled: layerOn,
    sub: 'Kaleidoscope', visible: isFolded, parent: 'confKaleido'
  }
];

export const CONFETTI_SECTIONS = [
  { id: 'confetti', title: 'Confetti' }
];
