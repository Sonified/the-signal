// The Particles layer's controls and the state behind them. Like the Flowers
// and the Kaleidoscope, particles are new in v1, with no v0 handler to port
// and no v0 DOM ids, so everything here is defined fresh: the S field names
// are the contract the GPU generator reads, and the defaults, ranges and
// persistence helpers live beside the controls so that the one list of
// particle fields cannot drift between the drawer, the saved session and a
// preset.
//
// Persistence stays out of the shared v0 settings object for the same reason
// the other v1 layers do: v0's saveSettings() writes a fixed list of keys and
// would drop anything it does not know about. store.js writes these into the
// v1 extra record instead, through particleStateOf() and applyParticleState().
//
// Slider conventions follow schema-kaleido.js: a 0 to 1 amount is shown as a
// whole-percent slider (position 0 to 100) and converted through S, while a
// multiplier, a signed rate or a count is stored exactly as the slider shows
// it. Every set() ends with the debounced save(). The state-only helpers
// never call save(); store.js decides when to write.
import { save } from './store.js';

// The three choices, the two plain booleans, and every numeric field with its
// range. The GPU agent reads these names off S directly, so this table is the
// source of truth for what a valid particle state is, both at boot and when a
// stored record or a preset snapshot is read back.
const EMITTERS = ['center', 'ring', 'spiral'];
const STYLES = ['glow', 'streak', 'spark', 'bokeh', 'dust'];
const COLOURS = ['strobe', 'rainbow', 'white'];
const DEF_EMITTER = 'center';
const DEF_STYLE = 'glow';
const DEF_COLOUR = 'strobe';
const DEF_KALEIDO = false;
const DEF_MIRROR = true;
const DEF_SEQ_ON = false;
const NUM = [
  // key,            min,  max, def,  integer
  ['partRate',        0,   1,   0.5,  false],
  ['partSpeed',       0,   0.5, 0.25, false],   // 0.5 is the top: faster read as far too fast
  ['partSize',        0.2, 3,   1,    false],
  ['partSizeVar',     0,   1,   0.5,  false],
  ['partSpread',      0,   1,   0.35, false],
  ['partSwirl',      -1,   1,   0,    false],
  ['partTrail',       0,   1,   0.5,  false],
  ['partHueVar',      0,   1,   0.15, false],
  ['partOpacity',     0,   1,   0.9,  false],
  ['partFade',        0,   1,   0.55, false],   // the rings' radial fade in, same curve (core/fade.js)
  ['partPulse',       0,   1,   0,    false],
  ['partFolds',       3,   16,  8,    true ],
  // Pulse with sequencer: how far the sequencer's live output level lifts
  // the particles' brightness and size, how hard that level is read, and how
  // fast the follower rises and falls (seconds).
  ['partSeqPulse',    0,   1,   0,    false],
  ['partSeqSize',     0,   1,   0,    false],
  ['partSeqSens',     0.5, 20,  4,    false],
  ['partSeqAtk',      0.001, 0.3, 0.01, false],
  ['partSeqRel',      0.02, 2,  0.25, false],
  ['partFoldSpin',   -1,   1,   0.05, false]
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

// Seeds every particle field that is not already on S. Called first thing in
// store.load(), beside initKaleidoState, so the fields exist before any saved
// state is applied and before the first frame. It only fills gaps, so calling
// it twice is harmless.
export function initParticleState(S) {
  if (typeof S.layers.particles !== 'boolean') S.layers.particles = false;
  if (EMITTERS.indexOf(S.partEmitter) < 0) S.partEmitter = DEF_EMITTER;
  if (STYLES.indexOf(S.partStyle) < 0) S.partStyle = DEF_STYLE;
  if (COLOURS.indexOf(S.partColor) < 0) S.partColor = DEF_COLOUR;
  if (typeof S.partKaleido !== 'boolean') S.partKaleido = DEF_KALEIDO;
  if (typeof S.partMirror !== 'boolean') S.partMirror = DEF_MIRROR;
  if (typeof S.partSeqOn !== 'boolean') S.partSeqOn = DEF_SEQ_ON;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the particle state, the shape store.js writes and a preset
// snapshot carries. The layer switch goes under its own flat name, as
// kaleidoOn does, so the record does not look like a partial v0 layers
// object.
export function particleStateOf(S) {
  const out = {
    particlesOn: !!S.layers.particles,
    partEmitter: S.partEmitter,
    partStyle: S.partStyle,
    partColor: S.partColor,
    partKaleido: !!S.partKaleido,
    partMirror: !!S.partMirror,
    partSeqOn: !!S.partSeqOn
  };
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field, and
// leaves anything missing or malformed exactly as it is on S. Out-of-range
// numbers are clamped rather than rejected, so a record from a later build
// with wider ranges still lands somewhere sensible, and a choice this build
// does not know is skipped rather than guessed at.
export function applyParticleState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.particlesOn === 'boolean') S.layers.particles = o.particlesOn;
  if (EMITTERS.indexOf(o.partEmitter) >= 0) S.partEmitter = o.partEmitter;
  if (STYLES.indexOf(o.partStyle) >= 0) S.partStyle = o.partStyle;
  if (COLOURS.indexOf(o.partColor) >= 0) S.partColor = o.partColor;
  if (typeof o.partKaleido === 'boolean') S.partKaleido = o.partKaleido;
  if (typeof o.partMirror === 'boolean') S.partMirror = o.partMirror;
  if (typeof o.partSeqOn === 'boolean') S.partSeqOn = o.partSeqOn;
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
}

// Every control in the Particles section dims while the layer is off, the
// same way the Kaleidoscope section does, so the viewer can see what the
// particles would do before switching them on.
const layerOn = S => !!S.layers.particles;

// Rows that only mean something in one mode. Trail is the length of a
// streak, so it hides for the round styles; the fold controls shape the
// kaleidoscope pass, so they hide while that pass is off.
const isStreak = S => S.partStyle === 'streak';
const isFolded = S => !!S.partKaleido;
const isSeqOn = S => !!S.partSeqOn;

// One slider bound 1:1 to a particle field (a multiplier, a signed rate or a
// count), whose range and default come from the NUM table so the two can
// never disagree.
function direct(id, key, label, step, format, sub, visible) {
  const n = spec(key);
  const c = {
    id, section: 'particles', label, kind: 'slider',
    min: n[1], max: n[2], step, def: n[3],
    get: S => S[key],
    set: (S, pos) => { S[key] = fit(pos, n[1], n[2], n[4]); save(); },
    format,
    enabled: layerOn
  };
  if (sub) c.sub = sub;
  if (visible) c.visible = visible;
  return c;
}

// One whole-percent slider over a 0 to 1 field.
function percent(id, key, label, format, sub, visible) {
  const n = spec(key);
  const c = {
    id, section: 'particles', label, kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, 0, 1, false); save(); },
    format: format || (S => Math.round(S[key] * 100) + '%'),
    enabled: layerOn
  };
  if (sub) c.sub = sub;
  if (visible) c.visible = visible;
  return c;
}

// One single-select segment over a fixed list of choices. A value outside
// the list falls back to the default rather than landing on S.
function choice(id, key, label, values, labels, def, sub) {
  const c = {
    id, section: 'particles', label, kind: 'segment', def,
    options: values.map((value, i) => ({ value, label: labels[i], domId: null })),
    get: S => S[key],
    set: (S, v) => { S[key] = values.indexOf(v) >= 0 ? v : def; save(); },
    enabled: layerOn
  };
  if (sub) c.sub = sub;
  return c;
}

// One plain switch over a boolean field.
function toggle(id, key, label, def, sub, visible) {
  const c = {
    id, section: 'particles', label, kind: 'toggle', def,
    get: S => !!S[key],
    set: (S, on) => { S[key] = !!on; save(); },
    enabled: layerOn
  };
  if (sub) c.sub = sub;
  if (visible) c.visible = visible;
  return c;
}

const times2 = key => S => S[key].toFixed(2) + '×';

// Marks a control as a child row of the toggle or segment straight above it
// (the schema's `parent`), so the drawer indents it under that row.
const under = (parent, c) => { c.parent = parent; return c; };
// Gives a control a hover tip in the drawer (the schema's `tip`).
const tip = (str, c) => { c.tip = str; return c; };

// The particle flow in real units, shared with v1/gpu/particles.js so the
// readouts say exactly what the generator does. Births per second at a Rate
// (dust is born in larger numbers; it is the numbers that make it), and the
// seconds a particle takes to fly the tunnel at a Speed. Speed 0 freezes the
// stream, and a frozen stream has no births: new ones would pile up far down
// the tunnel and overwrite particles still in view.
//
// PARTICLE_MAX_RATE puts Rate 50% at about 1000 births a second, what the
// stream used to manage at the default Speed before its buffer ran out.
// Particles now live only the visible part of their flight, so the buffer
// no longer caps the rate there and the whole of the slider's travel counts.
export const PARTICLE_MAX_RATE = 2850, PARTICLE_DUST_RATE = 2.5;
export const PARTICLE_MEAN_VZ = 0.8;          // tunnel units per second at Speed 1
export const PARTICLE_FLIGHT = 4.0 * 0.925 - 0.1 * 0.6;   // Z_FAR to past the viewer, tunnel units
export function particleBirthsPerSec(rate, style) {
  if (!(rate > 0)) return 0;
  return 20 + Math.pow(rate, 1.5) * PARTICLE_MAX_RATE * (style === 'dust' ? PARTICLE_DUST_RATE : 1);
}
export function particleFlightSec(speed) {
  return speed > 0.001 ? PARTICLE_FLIGHT / (PARTICLE_MEAN_VZ * speed) : Infinity;
}
// The slowest particle's share of the mean speed. Speeds are drawn from 0.6
// to 1.4 times the mean, and the generator's birth-rate cap bounds each
// particle's life by the slowest, not the mean: births reuse the oldest
// buffer slot, and a cap from the mean hands a slow particle's slot to a new
// birth while the slow one is still on screen, which is a particle vanishing
// mid-view.
export const PARTICLE_SLOWEST = 0.6;
const perSecText = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k/s' : Math.round(n) + '/s';
// Rate reads its percentage and what that means in births per second.
const rateText = S => Math.round(S.partRate * 100) + '% · ' + (S.partRate > 0 ? perSecText(particleBirthsPerSec(S.partRate, S.partStyle)) : 'none');
// Speed reads its multiplier and how long a particle takes to fly the tunnel.
const speedText = S => S.partSpeed.toFixed(2) + '× · ' + (S.partSpeed > 0.001 ? particleFlightSec(S.partSpeed).toFixed(1) + ' s' : 'frozen');
// A signed amount reads 'none' at 0 and carries its sign otherwise, so the
// direction is plain without a second label.
const signed = key => S => S[key] === 0 ? 'none' : (S[key] > 0 ? '+' : '') + S[key].toFixed(2);

export const PARTICLE_CONTROLS = [
  // Sits in the drawer's Layers group straight after the Kaleidoscope toggle.
  // Off by default: a first visit looks exactly as it did before.
  {
    id: 'lParticles', section: 'layers', label: 'Particles', kind: 'toggle', def: false,
    get: S => !!S.layers.particles,
    set: (S, on) => { S.layers.particles = on; save(); }
  },
  // The same switch again at the head of the Particles section. Every other
  // control here dims while the layer is off, so without this one the
  // section had no way in from inside it. It has no enabled(), so it never
  // dims itself.
  {
    id: 'particlesOn', section: 'particles', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.particles,
    set: (S, on) => { S.layers.particles = on; save(); }
  },

  // Where the particles are born, and what each one looks like.
  choice('partEmitter', 'partEmitter', 'Emitter', EMITTERS, ['Centre', 'Ring', 'Spiral'], DEF_EMITTER),
  choice('partStyle', 'partStyle', 'Style', STYLES, ['Glow', 'Streak', 'Spark', 'Bokeh', 'Dust'], DEF_STYLE),

  // How many are born, how fast they travel, how widely they fan out, and
  // which way the stream bends. Swirl is signed: it curls one way or the
  // other, and 0 sends the particles straight out.
  percent('partRate', 'partRate', 'Rate', rateText, 'Flow'),
  direct('partSpeed', 'partSpeed', 'Speed', 0.01, speedText, 'Flow'),
  percent('partSpread', 'partSpread', 'Spread (toward screen edge)', null, 'Flow'),
  direct('partSwirl', 'partSwirl', 'Swirl', 0.01, signed('partSwirl'), 'Flow'),

  // Size is the largest a particle gets; the variance spreads them between
  // that and small. Trail only exists for the streak style.
  direct('partSize', 'partSize', 'Size', 0.05, times2('partSize'), 'Size'),
  percent('partSizeVar', 'partSizeVar', 'Size variance', null, 'Size'),
  percent('partTrail', 'partTrail', 'Trail', null, 'Size', isStreak),

  // Where the colour comes from, how far each particle wanders from it, how
  // solid the layer is, and how it fades in from the centre.
  choice('partColor', 'partColor', 'Colour', COLOURS, ['Strobe', 'Rainbow', 'White'], DEF_COLOUR, 'Colour'),
  percent('partHueVar', 'partHueVar', 'Hue variation', null, 'Colour'),
  percent('partOpacity', 'partOpacity', 'Opacity', null, 'Colour'),
  // How far out from the centre the particles take to come up to full
  // brightness, the tunnel rings' own 'Ring fade in' curve (core/fade.js),
  // so the two layers fade alike at the same setting. 0 is no fade at all.
  percent('partFade', 'partFade', 'Fade in', null, 'Colour'),

  // An optional fold of the whole particle field into wedges, like the
  // Kaleidoscope layer's own. The three rows under the switch only show
  // while it is on. The fold count reads with the number first, so clicking
  // it to type opens on the count itself.
  toggle('partKaleido', 'partKaleido', 'Kaleidoscope', DEF_KALEIDO, 'Kaleidoscope'),
  under('partKaleido', direct('partFolds', 'partFolds', 'Symmetry', 1, S => S.partFolds + '-fold', 'Kaleidoscope', isFolded)),
  under('partKaleido', toggle('partMirror', 'partMirror', 'Mirror', DEF_MIRROR, 'Kaleidoscope', isFolded)),
  under('partKaleido', direct('partFoldSpin', 'partFoldSpin', 'Rotation', 0.01, signed('partFoldSpin'), 'Kaleidoscope', isFolded)),

  // How far the particles flicker with the strobe. It defaults to 0, a
  // steady layer of its own on top of the flicker, and the readout spells
  // out what 0 means.
  percent('partPulse', 'partPulse', 'Pulse with strobe',
    S => S.partPulse === 0 ? 'never flickers' : Math.round(S.partPulse * 100) + '%',
    'With the strobe'),

  // Pulse with the sequencer, behind its own switch: off, its five dials
  // hide and the particles ignore the sequencer. On, they follow the
  // sequencer's actual output level (after its level, echoes, sweep, strobe
  // pulse and mute; its share of the reverb is not in it). Brightness pulse
  // is how far brightness follows, 100% dark in the silences; Size push swells them up to twice their size
  // on a note; Sensitivity is how loud reads as full; Attack and Release are
  // how fast the follower rises to a note and falls away after it.
  toggle('partSeqOn', 'partSeqOn', 'Pulse with sequencer', DEF_SEQ_ON, 'With the sequencer'),
  under('partSeqOn', tip('Brighten on each note, dim in the silences',
    percent('partSeqPulse', 'partSeqPulse', 'Brightness pulse',
      S => S.partSeqPulse === 0 ? 'off' : Math.round(S.partSeqPulse * 100) + '%', 'With the sequencer', isSeqOn))),
  under('partSeqOn', tip('Swell on each note, up to twice the size',
    percent('partSeqSize', 'partSeqSize', 'Size push',
      S => S.partSeqSize === 0 ? 'off' : '+' + Math.round(S.partSeqSize * 100) + '%', 'With the sequencer', isSeqOn))),
  under('partSeqOn', direct('partSeqSens', 'partSeqSens', 'Sensitivity', 0.1, S => S.partSeqSens.toFixed(1) + '×', 'With the sequencer', isSeqOn)),
  under('partSeqOn', direct('partSeqAtk', 'partSeqAtk', 'Attack', 0.001, S => Math.round(S.partSeqAtk * 1000) + ' ms', 'With the sequencer', isSeqOn)),
  under('partSeqOn', direct('partSeqRel', 'partSeqRel', 'Release', 0.01, S => Math.round(S.partSeqRel * 1000) + ' ms', 'With the sequencer', isSeqOn))
];

export const PARTICLE_SECTIONS = [
  { id: 'particles', title: 'Particles' }
];
