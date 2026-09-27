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

// The palettes, as v1/gpu/confetti.js reads S.confPalette: six festive hues,
// the strobe's own colour with each piece's hue turned a little, or gold and
// silver foil throughout.
const PALETTES = ['rainbow', 'strobe', 'gold'];
const DEF_PALETTE = 'rainbow';
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
  ['confTumble',  0,   1,   1   ],   // 0 spins flat facing the viewer, 1 the full 3D tumble
  ['confShine',   0,   1,   0.35],   // the share of pieces that are foil, not paper
  ['confBright',  0,   1,   1   ],
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

// Seeds every confetti field not already on S. Called first thing in
// store.load(), beside the other v1 layers' seeds, and only fills gaps.
export function initConfettiState(S) {
  if (typeof S.layers.confetti !== 'boolean') S.layers.confetti = false;
  if (PALETTES.indexOf(S.confPalette) < 0) S.confPalette = DEF_PALETTE;
  if (typeof S.confKaleido !== 'boolean') S.confKaleido = DEF_KALEIDO;
  if (typeof S.confMirror !== 'boolean') S.confMirror = DEF_MIRROR;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the confetti state, the shape the store writes and a preset
// snapshot carries. The layer switch goes under its own flat name, as
// fireworksOn does.
export function confettiStateOf(S) {
  const out = {
    confettiOn: !!S.layers.confetti,
    confPalette: S.confPalette,
    confKaleido: !!S.confKaleido,
    confMirror: !!S.confMirror
  };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a record holds, field by field, leaving anything missing
// or malformed as it is and clamping numbers into range.
export function applyConfettiState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.confettiOn === 'boolean') S.layers.confetti = o.confettiOn;
  if (PALETTES.indexOf(o.confPalette) >= 0) S.confPalette = o.confPalette;
  if (typeof o.confKaleido === 'boolean') S.confKaleido = o.confKaleido;
  if (typeof o.confMirror === 'boolean') S.confMirror = o.confMirror;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
}

// Every row dims while the layer is off, as the Fireworks section's do.
const layerOn = S => !!S.layers.confetti;
// The fold's own rows only show while the fold is on.
const isFolded = S => !!S.confKaleido;

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
    // then on.
    id: 'confSpeedVar', section: 'confetti', label: 'Speed variance', kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(spec('confSpeedVar')[3] * 100),
    get: S => Math.round(S.confSpeedVar * 100),
    set: (S, pos) => { S.confSpeedVar = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.confSpeedVar * 100) + '%',
    enabled: layerOn
  },
  {
    // How the pieces are born: at 0 a steady stream, and up from there more
    // of them come together, until at 100% they are born in bursts with
    // nothing between. The average stays the Amount. It only shapes the
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
