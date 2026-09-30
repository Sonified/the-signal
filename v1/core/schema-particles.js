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
import { subDrawer } from './schema-visual.js';

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
// Where the feedback sits while folded, as v1/gpu/particles.js reads
// S.partFbWhere: after the kaleidoscope, trails across the whole pattern, or
// before it, trails inside the wedge that every copy repeats. The same pair
// as the Confetti layer's.
const FB_WHERES = ['after', 'before'];
const DEF_FB_WHERE = 'after';
// How this frame's light goes into the trail image, as v1/gpu/particles.js
// reads S.partFbBlend: 'add' lays it onto the fading trails, so overlapping
// paths build and a long half-life blooms toward white; 'max' keeps each
// texel at the brightest light that recently passed, bounded however slow
// the fade.
const FB_BLENDS = ['add', 'max'];
const DEF_FB_BLEND = 'add';
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
  ['partFadeVar',     0,   1,   0,    false],   // how far that radius swings down from its setting and back
  ['partFadeRate',    1,   60,  10,   true ],   // seconds for one swing of the radius variance
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
  ['partFoldSpin',   -1,   1,   0.05, false],
  // Video feedback, the Confetti layer's own, with its ranges and defaults.
  ['partFeedback',    0,   1,   0,    false],   // how long each particle leaves a trail where it passed
  ['partFbOpacity',   0,   1,   1,    false],   // how brightly the trails land; the live particles draw on their own
  ['partFbStream',   -2,   2,   0,    false],   // the trails stream outward (+) or inward (-), signed
  ['partFbTwist',    -1,   1,   0,    false],   // the trails turn about the centre, + clockwise, signed
  // Each of Amount, Stream and Twist swings over time about its setting: down
  // as far as its Lo, up as far as its Hi, both in the owner's own units and
  // each at most the owner's whole span, once every Rate seconds.
  ['partFbAmtVarLo', -1,   0,   0,    false],
  ['partFbAmtVarHi',  0,   1,   0,    false],
  ['partFbAmtVarRate', 1,  120, 20,   true ],
  ['partFbStreamVarLo', -4, 0,  0,    false],
  ['partFbStreamVarHi', 0,  4,  0,    false],
  ['partFbStreamVarRate', 1, 120, 20, true ],
  ['partFbTwistVarLo', -2,  0,  0,    false],
  ['partFbTwistVarHi', 0,   2,  0,    false],
  ['partFbTwistVarRate', 1, 120, 20,  true ],
  ['partFbPulse',     0,   1,   0,    false],   // how far the whole feedback image brightens and darkens with the strobe
  ['partFbPulseVar',  0,   1,   0,    false],   // how far that pulse amount swings down from its setting and back
  ['partFbPulseRate', 1,   60,  10,   true ]    // seconds for one swing of the pulse variance
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
  if (FB_WHERES.indexOf(S.partFbWhere) < 0) S.partFbWhere = DEF_FB_WHERE;
  if (FB_BLENDS.indexOf(S.partFbBlend) < 0) S.partFbBlend = DEF_FB_BLEND;
  if (typeof S.partFbTwistVarOn !== 'boolean') S.partFbTwistVarOn = true;
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
    partSeqOn: !!S.partSeqOn,
    partFbWhere: S.partFbWhere,
    partFbBlend: S.partFbBlend,
    partFbTwistVarOn: S.partFbTwistVarOn !== false
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
  if (FB_WHERES.indexOf(o.partFbWhere) >= 0) S.partFbWhere = o.partFbWhere;
  if (FB_BLENDS.indexOf(o.partFbBlend) >= 0) S.partFbBlend = o.partFbBlend;
  if (typeof o.partFbTwistVarOn === 'boolean') S.partFbTwistVarOn = o.partFbTwistVarOn;
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

// Marks a control as a child row of the toggle, segment or sub-drawer
// straight above it (the schema's `parent`), so the drawer nests it there.
const under = (parent, c) => { c.parent = parent; return c; };
// Marks a segment whose options say what it chooses between, so the drawer
// draws its pills without its name above them (the schema's hideLabel).
const noLabel = c => { c.hideLabel = true; return c; };
// Tags a control as part of the variance of the row straight above it (the
// schema's varianceOf), so the drawer folds it out from under that row.
const varianceOf = (owner, c) => { c.varianceOf = owner; return c; };
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

// A range row's readout (widgets.js range), as the Confetti layer's: 'none'
// while both knobs sit on the centre, else how far down, then how far up,
// each with its sign and a side left at 0 shown plainly. pct reads a
// fraction as whole percent; otherwise it is the owner's own units to two
// places. Built only when a knob moves (the widget caches it).
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
// or Twist), schema-confetti.js's own: how far it swings each way, and how
// long one swing takes, folding out from under their owner by its chevron
// (drawer.js, varianceOf). key is the NUM prefix; span the owner's whole
// slider span in its own units, so either knob can carry it from any setting
// to either end. v1/gpu/particles.js does the swinging, on the layer's own
// clock, and clamps the result to the owner's range.
function fbVariance(owner, key, span, pct, switchId) {
  const lo = key + 'Lo', hi = key + 'Hi', rate = key + 'Rate';
  const visible = switchId ? S => S[switchId] !== false : undefined;
  return [
    {
      id: key, section: 'particles', label: 'Variance', kind: 'range',
      varianceOf: owner,
      min: -span, max: span, step: 0.01, defLo: 0, defHi: 0,
      getLo: S => S[lo],
      getHi: S => S[hi],
      setLo: (S, v) => { S[lo] = fit(v, -span, 0); save(); },
      setHi: (S, v) => { S[hi] = fit(v, 0, span); save(); },
      format: S => rangeText(S[lo], S[hi], pct),
      enabled: layerOn, parent: switchId || 'partFeedbackDrawer', visible
    },
    {
      // Seconds for one swing, as the strobe's Variance rate.
      id: rate, section: 'particles', label: 'Variance rate', kind: 'slider',
      varianceOf: owner,
      min: 1, max: 120, step: 1, def: spec(rate)[3],
      get: S => S[rate],
      set: (S, pos) => { S[rate] = fit(pos, 1, 120, true); save(); },
      format: S => S[rate] + 's / cycle',
      enabled: layerOn, parent: switchId || 'partFeedbackDrawer', visible
    }
  ];
}

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

  // Where the particles are born, above the drawers, since it decides the
  // shape of the whole stream.
  noLabel(choice('partEmitter', 'partEmitter', 'Emitter', EMITTERS, ['Centre', 'Ring', 'Spiral'], DEF_EMITTER)),

  // ---- three sub-drawers, Motion, Shape and Color (see subDrawer in
  // schema-visual.js), each with its rows straight after it. Their rows sat
  // under headings of their own before the drawers; a heading inside a
  // drawer would end its run ----
  //
  // How many are born, how fast they travel, how widely they fan out, and
  // which way the stream bends. Swirl is signed: it curls one way or the
  // other, and 0 sends the particles straight out.
  subDrawer('partMotionDrawer', 'Motion', 'particles', ['partRate', 'partSpeed']),
  under('partMotionDrawer', percent('partRate', 'partRate', 'Birth rate', rateText)),
  under('partMotionDrawer', direct('partSpeed', 'partSpeed', 'Speed', 0.01, speedText)),
  under('partMotionDrawer', percent('partSpread', 'partSpread', 'Spread (toward screen edge)')),
  under('partMotionDrawer', direct('partSwirl', 'partSwirl', 'Swirl', 0.01, signed('partSwirl'))),

  // What each one looks like. Size is the largest a particle gets; the
  // variance spreads them between that and small. Trail only exists for the
  // streak style.
  subDrawer('partShapeDrawer', 'Shape', 'particles', ['partStyle', 'partSize']),
  under('partShapeDrawer', noLabel(choice('partStyle', 'partStyle', 'Style', STYLES, ['Glow', 'Streak', 'Spark', 'Bokeh', 'Dust'], DEF_STYLE))),
  under('partShapeDrawer', direct('partSize', 'partSize', 'Size', 0.05, times2('partSize'))),
  // (the variance folds out from under Size; drawer.js, the schema's varianceOf)
  varianceOf('partSize', percent('partSizeVar', 'partSizeVar', 'Size variance')),
  under('partShapeDrawer', percent('partTrail', 'partTrail', 'Trail', null, null, isStreak)),

  // Where the colour comes from, how far each particle wanders from it, how
  // solid the layer is, how it fades in from the centre, and how far it
  // flickers with the strobe.
  subDrawer('partColorDrawer', 'Color', 'particles', ['partColor', 'partOpacity']),
  under('partColorDrawer', noLabel(choice('partColor', 'partColor', 'Colour', COLOURS, ['Strobe', 'Rainbow', 'White'], DEF_COLOUR))),
  under('partColorDrawer', percent('partHueVar', 'partHueVar', 'Hue variation')),
  under('partColorDrawer', percent('partOpacity', 'partOpacity', 'Opacity')),
  // How far out from the centre the particles take to come up to full
  // brightness, the tunnel rings' own 'Ring fade in' curve (core/fade.js),
  // so the two layers fade alike at the same setting. 0 is no fade at all.
  // While a variance is set the knob shows the swung radius as it moves.
  {
    ...under('partColorDrawer', percent('partFade', 'partFade', 'Center fade radius')),
    effective: S => S.partFadeVar > 0
      ? (typeof S.effPartFade === 'number' ? S.effPartFade : S.partFade) * 100 : undefined
  },
  // How far the radius swings, as the feedback's Pulse variance does: over
  // one Variance rate cycle it eases from the setting down by this share and
  // back, so at 100% the particles breathe from the set radius in to no fade
  // at all and out again. At 0 the radius stays where it is set.
  under('partColorDrawer', varianceOf('partFade', percent('partFadeVar', 'partFadeVar', 'Radius variance'))),
  // Seconds for one swing of the radius variance, as the strobe's Variance
  // rate.
  under('partColorDrawer', varianceOf('partFade',
    direct('partFadeRate', 'partFadeRate', 'Variance rate', 1, S => S.partFadeRate + 's / cycle'))),
  // It defaults to 0, a steady layer of its own on top of the flicker, and
  // the readout spells out what 0 means.
  under('partColorDrawer', percent('partPulse', 'partPulse', 'Pulse with strobe',
    S => S.partPulse === 0 ? 'never flickers' : Math.round(S.partPulse * 100) + '%')),

  // Video feedback, the Confetti layer's, in a sub-drawer of its own that the
  // viewer opens and shuts, so no rows come and go as a slider moves. Shut,
  // its strip shows the amount and the Stream.
  subDrawer('partFeedbackDrawer', 'Feedback', 'particles', ['partFeedback', 'partFbStream']),
  // How brightly the trail image lands on the scene. The live particles are
  // drawn on their own, over the trails, so this dims only the trails: at 0
  // the particles stand alone. It only changes how the image is laid over,
  // never the trails inside it, so they build and fade the same at any
  // setting and turning it back up shows them as they are now.
  under('partFeedbackDrawer', percent('partFbOpacity', 'partFbOpacity', 'Opacity')),
  // Each frame keeps a fading copy of the last, so every particle leaves a
  // trail that stays where it was drawn and dies away. At 0 there is no
  // trail, the particles as they are; at 100% a trail takes about two
  // seconds to fade to half, and in between the time grows with the square
  // of the slider, so the low end is fine grained. Labelled Amount since the
  // drawer carries the Feedback name. While a variance is set the knob shows
  // the swung value as it moves.
  {
    ...under('partFeedbackDrawer', percent('partFeedback', 'partFeedback', 'Amount')),
    effective: S => (S.partFbAmtVarLo !== 0 || S.partFbAmtVarHi !== 0)
      ? (typeof S.effPartFeedback === 'number' ? S.effPartFeedback : S.partFeedback) * 100 : undefined
  },
  // Amount's swing, in the Amount's own share, so its readout is percent to
  // match the row above. Swinging down to 0 clears the image just as the
  // slider at 0 does; the shut strip's summary still shows the setting.
  ...fbVariance('partFeedback', 'partFbAmtVar', 1, true),
  // How this frame's light goes into the trails. Additive piles it onto
  // what is already there, so overlapping paths build and a long Amount
  // blooms toward white; Max holds each point at the brightest light that
  // recently passed it, so the trails never outshine the particles however
  // long they last.
  under('partFeedbackDrawer', noLabel(choice('partFbBlend', 'partFbBlend', 'Blend', FB_BLENDS, ['Additive', 'Max'], DEF_FB_BLEND))),
  // The trails' own motion, always in the drawer; at an Amount of 0 there is
  // no trail, so they simply have nothing to move. Each frame's faded copy
  // is taken a little larger or smaller about the field centre (Stream) and
  // turned a little about it (Twist), so the trails stream out toward the
  // edges or in to the centre, and swirl, the same way in every direction.
  // Both read 'none' at 0 and carry their sign and direction otherwise.
  {
    ...under('partFeedbackDrawer', direct('partFbStream', 'partFbStream', 'Stream', 0.01,
      S => S.partFbStream === 0 ? 'none'
        : (S.partFbStream > 0 ? '+' + S.partFbStream.toFixed(2) + ' out' : S.partFbStream.toFixed(2) + ' in'))),
    effective: S => (S.partFbStreamVarLo !== 0 || S.partFbStreamVarHi !== 0)
      ? (typeof S.effPartFbStream === 'number' ? S.effPartFbStream : S.partFbStream) : undefined
  },
  // Stream's swing, in Stream's units: a span of 4 lets either knob carry it
  // from any setting to either end, out or in, so a swing can breathe the
  // trails outward and back through still.
  ...fbVariance('partFbStream', 'partFbStreamVar', 4, false),
  {
    ...under('partFeedbackDrawer', direct('partFbTwist', 'partFbTwist', 'Twist', 0.01,
      S => S.partFbTwist === 0 ? 'none'
        : (S.partFbTwist > 0 ? '+' + S.partFbTwist.toFixed(2) + ' clockwise' : S.partFbTwist.toFixed(2) + ' counter'))),
    effective: S => S.partFbTwistVarOn !== false && (S.partFbTwistVarLo !== 0 || S.partFbTwistVarHi !== 0)
      ? (typeof S.effPartFbTwist === 'number' ? S.effPartFbTwist : S.partFbTwist) : undefined
  },
  {
    id: 'partFbTwistVarOn', section: 'particles', label: 'Twist variance', kind: 'toggle', def: true,
    varianceOf: 'partFbTwist',
    // As the Confetti layer's: the performance window can crossfade this
    // switch through S.partFbTwistVarMix, 0 the plain Twist and 1 the full
    // swing; runtime only, never saved, 1 when unset.
    mixKey: 'partFbTwistVarMix',
    get: S => S.partFbTwistVarOn !== false,
    set: (S, on) => { S.partFbTwistVarOn = !!on; save(); },
    format: S => S.partFbTwistVarOn !== false ? 'On' : 'Off',
    enabled: layerOn, parent: 'partFeedbackDrawer'
  },
  // Twist's swing, in Twist's units, a span of 2 for the same reason.
  ...fbVariance('partFbTwist', 'partFbTwistVar', 2, false, 'partFbTwistVarOn'),
  // The trail image brightens and darkens with the strobe's flicker by this
  // much; the live particles keep the Color drawer's own Pulse with strobe.
  // At 0 the trails never flicker.
  {
    ...under('partFeedbackDrawer', percent('partFbPulse', 'partFbPulse', 'Pulse with strobe',
      S => S.partFbPulse === 0 ? 'never flickers' : Math.round(S.partFbPulse * 100) + '%')),
    effective: S => S.partFbPulseVar > 0
      ? (typeof S.effPartFbPulse === 'number' ? S.effPartFbPulse : S.partFbPulse) * 100 : undefined
  },
  // How far the pulse amount swings, as every variance in the app does:
  // over one Variance rate cycle it eases from the setting down by this
  // share and back, so at 100% from the full setting to nothing and back.
  // At 0 the pulse stays where it is set.
  under('partFeedbackDrawer', varianceOf('partFbPulse', percent('partFbPulseVar', 'partFbPulseVar', 'Pulse variance'))),
  // Seconds for one swing of the pulse variance, as the strobe's Variance
  // rate.
  under('partFeedbackDrawer', varianceOf('partFbPulse',
    direct('partFbPulseRate', 'partFbPulseRate', 'Variance rate', 1, S => S.partFbPulseRate + 's / cycle'))),
  // An optional fold of the whole particle field into wedges, like the
  // Kaleidoscope layer's own. The three rows under the switch only show
  // while it is on. The fold count reads with the number first, so clicking
  // it to type opens on the count itself.
  toggle('partKaleido', 'partKaleido', 'Kaleidoscope', DEF_KALEIDO, 'Kaleidoscope'),
  under('partKaleido', direct('partFolds', 'partFolds', 'Symmetry', 1, S => S.partFolds + '-fold', 'Kaleidoscope', isFolded)),
  under('partKaleido', toggle('partMirror', 'partMirror', 'Mirror', DEF_MIRROR, 'Kaleidoscope', isFolded)),
  under('partKaleido', direct('partFoldSpin', 'partFoldSpin', 'Rotation', 0.01, signed('partFoldSpin'), 'Kaleidoscope', isFolded)),
  // Where the feedback sits, the last row under the Kaleidoscope switch
  // (it only means something folded, so it shows only while that is on):
  // after the kaleidoscope the trails stream and turn across the whole
  // pattern about its centre; before it they live inside the one wedge the
  // fold repeats, so every copy trails alike, and Twist shears the wedge's
  // content out through its edges.
  {
    ...under('partKaleido', choice('partFbWhere', 'partFbWhere', 'Feedback:', FB_WHERES,
      ['After kaleidoscope', 'Before kaleidoscope'], DEF_FB_WHERE, 'Kaleidoscope')),
    visible: isFolded,
    // with the feedback off it does nothing, so it greys out rather than
    // coming and going as the feedback is switched
    enabled: S => layerOn(S) && (S.partFeedback > 0 || S.partFbAmtVarHi > 0)
  },

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
