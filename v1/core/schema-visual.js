// The visual half of the control schema: layers, Strobe, Tunnel, Edge, Text
// and the one Render item that still means something once the frame loop is
// WebGPU on the main thread by design (see the Render section below). Every
// entry is a faithful port of one handler in js/ui.js, read side by side with
// this file while it was written: the same state key, the same unit
// conversion, the same side effects, in the same order. What is dropped is
// only ever a DOM write, since the toolkit repaints every frame and never
// needs to be told to.
//
// A control's `get` returns the value in the slider's own units, exactly as
// v0's markup range does (a 0-100 percent control converts through S's 0-1
// fraction; a control whose slider already matches its state 1:1, like ring
// spread, is not converted at all). `set` takes that same unit back, writes
// through to S, repeats v0's side effect if it had one, and ends with the
// debounced save() every v0 handler ends with. `format` returns the readout
// text precisely as v0's <b><span> shows it, unit included.
//
// No control here needs a parse (the toolkit's typed-readout inverse): every
// slider's readout prints its own position, only rounded and with a unit on,
// so a number typed into it is already a position. The percent rows look like
// an exception but are not, since their position is the percentage and the
// 0-1 fraction lives only in S. colorWalk's 'off' is position 0 by name.

// Every get/set/format below receives S as a parameter rather than closing
// over a module-level import: these are pure functions of whatever state
// object the toolkit hands them, and state.js's S is passed in that way by
// every caller, so there is no need to import it here at all.
import { setColorFromPicker } from '../../js/color.js';
import { setAmRate } from '../../js/audio.js';
import { seedParticles, applyEdgeDir } from '../../js/sim.js';
import { THEMES, WORDS } from '../../js/words.js';
import { rebuildWordPool } from './words.js';
import { FX_NAMES } from './word-fx.js';
import { save } from './store.js';
import { engineThread, setEngineThreadWanted, engineThreadStatus } from './engine-thread.js';

// S stores colour as an [r,g,b] triple (js/color.js's setColorFromPicker
// writes S.rgb, S.hue, S.hueSat, S.hueLight from it); v0 kept the hex string
// only in the <input type=color> element itself. This is the way back, and
// it is duplicated in store.js rather than shared, so persistence never
// depends on the module that happens to describe the same control.
// The colour row's get runs every frame its section is open, so the string
// is remembered against the three numbers it came from and rebuilt only when
// one of them moves; a steady colour costs three comparisons, not eight
// strings and a closure.
// Arrive and Leave list the same effects. The domIds are synthetic, for
// byDomId lookups within this schema only; v0 had no such rows.
// One side's transition rows, Arrive's (leaving false) or Leave's. Leave's
// read and write the same settings plus 'Out' (see fxv in core/word-fx.js)
// and hide while the word leaves the way it came. Each row names the effects
// it belongs to and steps out of the way for every other choice: a preset
// only ever shows the controls it has.
const fadeInOn = S => S.textFadeInOn !== false;
const fadeOutOn = S => S.textFadeOutOn !== false;
function fxRows(leaving) {
  const sfx = leaving ? 'Out' : '';
  // every row sits one level in under its side's effect row
  const parent = leaving ? 'textFxOut' : 'textFxIn';
  const uses = list => S => leaving
    ? fadeOutOn(S) && !S.textFxMirror && list.indexOf(S.textFxOut) >= 0
    : fadeInOn(S) && list.indexOf(S.textFxIn) >= 0;
  const pct = (key, label, max, def, list, extra) => Object.assign({
    id: key + sfx, section: 'text', label, kind: 'slider', parent,
    min: 0, max, step: 1, def,
    visible: uses(list),
    get: S => Math.round(S[key + sfx] * 100),
    set: (S, pos) => { S[key + sfx] = pos / 100; save(); },
    format: S => Math.round(S[key + sfx] * 100) + '%'
  }, extra);
  const ALL = Object.keys(FX_NAMES);
  const smoke = uses(['smoke']);
  const gather = uses(['gather']);
  return [
    // How far the letters or the vapour travel, in word heights.
    pct('textFxDist', 'Distance', 600, 150, ['gather', 'wind', 'cloud', 'smoke'],
        { step: 5, format: S => S['textFxDist' + sfx].toFixed(2) + '× size' }),
    {
      // Gather only. On, the letters gather in (and leave) from left to
      // right rather than in no particular order, and Stagger below sets
      // how long the front takes to cross the word.
      id: 'textGatherSweep' + sfx, section: 'text', label: 'Left to right', kind: 'toggle', def: false, parent,
      visible: gather,
      get: S => !!S['textGatherSweep' + sfx],
      set: (S, on) => { S['textGatherSweep' + sfx] = !!on; save(); },
      format: S => S['textGatherSweep' + sfx] ? 'On' : 'Off'
    },
    // 0 moves every letter together; up, they arrive and leave one after
    // another across the transition.
    pct('textFxStagger', 'Stagger', 90, 50, ['fade', 'gather', 'wind']),
    // Swirl, tumble, wander and a rougher letter order.
    pct('textFxTurb', 'Turbulence', 100, 50, ['gather', 'wind', 'cloud', 'smoke']),
    // Blur and haze on the letters while they move; none once they land.
    pct('textFxBlur', 'Blur', 100, 60, ['fade', 'gather', 'wind']),
    // 0 is a constant speed; up, arrivals slow harder into place and
    // departures start slower and pick up more.
    pct('textFxEase', 'Ease', 100, 60, ALL),
    {
      // 0 blows to the right, 90 up.
      id: 'textFxWindDir' + sfx, section: 'text', label: 'Wind direction', kind: 'slider', parent,
      min: 0, max: 355, step: 5, def: 0,
      visible: uses(['wind']),
      get: S => S['textFxWindDir' + sfx],
      set: (S, pos) => { S['textFxWindDir' + sfx] = pos; save(); },
      format: S => S['textFxWindDir' + sfx] + '°'
    },
    // ---- Smoke only. The recording is prepared per word, so a change here
    // reaches the screen with the next word recorded, not the one playing. ----
    // How lively the vapour is. 100% travels about the Distance setting
    // over the dissolution; more is livelier air, less an almost-still room.
    pct('textSmokeSpeed', 'Vapour speed', 200, 100, ['smoke'], { step: 5 }),
    // Diffusion: how quickly filaments soften as they stretch. Low keeps
    // them wiry, high melts them toward fog.
    pct('textSmokeSoft', 'Softness', 100, 50, ['smoke']),
    // The bloom: how much the motion is outward-from-centre versus swirl.
    // High and the letters exhale radially with curls as texture; low and
    // the eddies own the choreography again.
    pct('textSmokeRadial', 'Outward', 100, 75, ['smoke']),
    // The wind-up: low, and the word spends real time destabilising —
    // quivering, edges fraying — while the outward momentum builds; high
    // and it just goes.
    pct('textSmokeAccel', 'Acceleration', 100, 70, ['smoke']),
    // How long the vapour stays thick before thinning away. The recording
    // always ends in empty air; this shapes how it gets there.
    pct('textSmokeLinger', 'Linger', 100, 50, ['smoke']),
    // Left to right heads its own run (Sweep speed), so it goes last: a row
    // after it at its own level would read as one of its children.
    {
      // On, the word dissolves behind a soft front sweeping left to right
      // (and assembles left to right on arrival); off, everywhere at once.
      id: 'textSmokeSweep' + sfx, section: 'text', label: 'Left to right', kind: 'toggle', def: false, parent,
      visible: smoke,
      get: S => !!S['textSmokeSweep' + sfx],
      set: (S, on) => { S['textSmokeSweep' + sfx] = !!on; save(); },
      format: S => S['textSmokeSweep' + sfx] ? 'On' : 'Off'
    },
    // How quickly the front crosses the word, as a share of the dissolve.
    pct('textSmokeSweepSpeed', 'Sweep speed', 100, 50, ['smoke'],
        { parent: 'textSmokeSweep' + sfx, visible: S => smoke(S) && !!S['textSmokeSweep' + sfx] })
  ];
}

function fxOptions(prefix) {
  return Object.keys(FX_NAMES).map(k => ({ value: k, label: FX_NAMES[k], domId: prefix + ':' + k }));
}

let hexR = NaN, hexG = NaN, hexB = NaN, hexStr = '';
function hex2(n) { return n.toString(16).padStart(2, '0'); }
function rgbHex(rgb) {
  const r = rgb[0], g = rgb[1], b = rgb[2];
  if (r !== hexR || g !== hexG || b !== hexB) {
    hexR = r; hexG = g; hexB = b;
    hexStr = '#' + hex2(r) + hex2(g) + hex2(b);
  }
  return hexStr;
}

// The theme chips read their set every frame the Text section is open. The
// answer is remembered as one on/off byte per theme and handed back as the
// same array until a byte changes, so a steady set costs a walk over the
// keys and no allocation. A change builds a fresh array rather than editing
// the old one, so a caller still holding the previous answer never sees it
// move. "Nothing chosen yet" (an empty S.textThemes) still means every theme.
const THEME_KEYS = Object.keys(THEMES);
const themeOn = new Uint8Array(THEME_KEYS.length);
let themeList = null;
function themesGet(S) {
  const set = S.textThemes || {};
  let virgin = true;
  for (const k in set) { if (Object.prototype.hasOwnProperty.call(set, k)) { virgin = false; break; } }
  let changed = themeList === null;
  for (let i = 0; i < THEME_KEYS.length; i++) {
    const on = virgin || !!set[THEME_KEYS[i]] ? 1 : 0;
    if (on !== themeOn[i]) { themeOn[i] = on; changed = true; }
  }
  if (changed) {
    themeList = [];
    for (let i = 0; i < THEME_KEYS.length; i++) if (themeOn[i]) themeList.push(THEME_KEYS[i]);
  }
  return themeList;
}

// ---------- layers row ----------
// Four of the five checkboxes here (the fifth, Audio, belongs to lane E2:
// it drives audioOn()/audioOff(), a user-gesture-gated path this schema does
// not touch). v0 also has a second surface for Text, the on/off pair at the
// top of the Text group below; both point at the same S.layers.text, the
// same "one owner" pattern v0 uses everywhere a corner toggle mirrors a
// drawer control.
function layerToggle(id, key, label) {
  return {
    id, section: 'layers', label, kind: 'toggle', def: true,
    get: S => !!S.layers[key],
    set: (S, on) => { S.layers[key] = on; save(); }
  };
}

// The same layer switch again at the head of the layer's own section, so a
// section can be turned on and off from inside it as well as from the Layers
// row. Both read and write the one S.layers key, so they can never disagree.
// No enabled(): a section's own switch must never dim itself.
function sectionToggle(id, key, section, label) {
  return {
    id, section, label, kind: 'toggle', def: true,
    get: S => !!S.layers[key],
    set: (S, on) => { S.layers[key] = on; save(); }
  };
}

export const VISUAL_CONTROLS = [
  layerToggle('lField',   'field',   'Field'),
  layerToggle('lRings',   'rings',   'Rings'),
  layerToggle('lCorners', 'corners', 'Corners'),
  layerToggle('lEdge',    'edge',    'Edge'),
  layerToggle('lText',    'text',    'Text'),

  // ---------- Strobe ----------
  sectionToggle('fieldOn',   'field',   'strobe', 'On'),
  // Corners are their own layer with their own section (below Strobe), so
  // the Strobe switch never touches them.
  sectionToggle('cornersOn', 'corners', 'corners', 'On'),
  {
    id: 'freq', section: 'strobe', label: 'Frequency', kind: 'slider',
    min: 0.5, max: 45, step: 0.5, def: 7.5,
    get: S => S.freq,
    set: (S, pos) => {
      S.freq = pos;
      // Pulse rate follows the strobe whenever the two are linked; the
      // slider that actually owns amRate is lane E2's, but the freq handler
      // in v0 pokes it directly, so this does too.
      if (S.amLinked) setAmRate(S.freq);
      save();
    },
    format: S => S.freq.toFixed(1) + ' Hz'
  },
  {
    id: 'wave', section: 'strobe', label: 'Waveform', kind: 'segment', def: 'square',
    options: [
      { value: 'sine',     label: 'Sine',   domId: 'wSine' },
      { value: 'triangle', label: 'Tri',    domId: 'wTri'  },
      { value: 'square',   label: 'Square', domId: 'wSq'   }
    ],
    get: S => S.wave,
    set: (S, v) => { S.wave = v; save(); }
  },
  {
    id: 'fieldShape', section: 'strobe', label: 'Field shape', kind: 'segment', def: 'full',
    options: [
      { value: 'circle', label: 'Circle', domId: 'sCircle' },
      { value: 'panel',  label: 'Panel',  domId: 'sPanel'  },
      { value: 'full',   label: 'Full',   domId: 'sFull'   }
    ],
    get: S => S.fieldShape,
    set: (S, v) => { S.fieldShape = v; save(); }
  },
  {
    // Two buttons in v0, not a single input, so there is no v0 DOM id that
    // names the control itself; 'frameLock' is the natural name for the pair,
    // and each option carries the id of the button that sets it.
    // Drawn as a dropdown (widgets.js select): the options say what each
    // one does, which is too long for two buttons side by side.
    id: 'frameLock', section: 'strobe', label: 'Flash quantization', kind: 'segment', def: true,
    dropdown: true,
    options: [
      { value: false, label: 'Free (possible irregular frames)',       domId: 'lkOff' },
      { value: true,  label: 'Match screen refresh (regular frames)', domId: 'lkOn'  }
    ],
    get: S => S.frameLock,
    set: (S, on) => { S.frameLock = on; save(); },
    // S.framesPerCycle and S.achievedFreq are written every frame by
    // v1/core/strobe.js, the same fields v0's tick() writes, so this reads
    // exactly the numbers updateReadouts() did.
    format: S => !S.frameLock ? 'off'
      : S.framesPerCycle ? S.achievedFreq.toFixed(2) + ' Hz · ' + S.framesPerCycle + ' fr' : 'on'
  },
  {
    // Off holds the strobe on the set frequency; the amount and rate below
    // keep their values for when it comes back on.
    id: 'freqDriftOn', section: 'strobe', label: 'Frequency drift', kind: 'toggle', def: true,
    get: S => S.freqDriftOn !== false,
    set: (S, on) => { S.freqDriftOn = !!on; save(); },
    format: S => S.freqDriftOn !== false ? 'On' : 'Off'
  },
  {
    id: 'freqDrift', section: 'strobe', label: 'Drift amount', kind: 'slider',
    parent: 'freqDriftOn',
    min: 0, max: 15, step: 0.5, def: 1,
    get: S => S.freqDrift,
    set: (S, pos) => { S.freqDrift = pos; save(); },
    format: S => '±' + S.freqDrift.toFixed(1) + ' Hz',
    visible: S => S.freqDriftOn !== false
  },
  {
    id: 'driftRate', section: 'strobe', label: 'Drift rate', kind: 'slider',
    parent: 'freqDriftOn',
    min: 1, max: 60, step: 1, def: 60,
    get: S => S.driftPeriod,
    set: (S, pos) => { S.driftPeriod = pos; save(); },
    format: S => S.driftPeriod + 's / cycle',
    visible: S => S.freqDriftOn !== false
  },
  {
    id: 'depth', section: 'strobe', label: 'Depth', kind: 'slider',
    min: 0, max: 100, step: 1, def: 80,
    get: S => Math.round(S.depth * 100),
    set: (S, pos) => { S.depth = pos / 100; save(); },
    format: S => Math.round(S.depth * 100) + '%'
  },
  {
    // Off holds the depth at its set value; the amount and rate below keep
    // their values for when it comes back on.
    id: 'depthVarOn', section: 'strobe', label: 'Depth variance', kind: 'toggle', def: true,
    get: S => S.depthVarOn !== false,
    set: (S, on) => { S.depthVarOn = !!on; save(); },
    format: S => S.depthVarOn !== false ? 'On' : 'Off'
  },
  {
    id: 'depthVar', section: 'strobe', label: 'Variance amount', kind: 'slider',
    parent: 'depthVarOn',
    min: 0, max: 100, step: 1, def: 80,
    get: S => Math.round(S.depthVar * 100),
    set: (S, pos) => { S.depthVar = pos / 100; save(); },
    format: S => Math.round(S.depthVar * 100) + '%',
    visible: S => S.depthVarOn !== false
  },
  {
    id: 'varPeriod', section: 'strobe', label: 'Variance rate', kind: 'slider',
    parent: 'depthVarOn',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.varPeriod,
    set: (S, pos) => { S.varPeriod = pos; save(); },
    format: S => S.varPeriod + 's / cycle',
    visible: S => S.depthVarOn !== false
  },
  {
    id: 'bright', section: 'strobe', label: 'Brightness', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.bright * 100),
    set: (S, pos) => { S.bright = pos / 100; save(); },
    format: S => Math.round(S.bright * 100) + '%'
  },
  {
    // Off holds the brightness at its set value; the amount and rate below keep
    // their values for when it comes back on.
    id: 'brightVarOn', section: 'strobe', label: 'Brightness variance', kind: 'toggle', def: true,
    get: S => S.brightVarOn !== false,
    set: (S, on) => { S.brightVarOn = !!on; save(); },
    format: S => S.brightVarOn !== false ? 'On' : 'Off'
  },
  {
    id: 'brightVar', section: 'strobe', label: 'Variance amount', kind: 'slider',
    parent: 'brightVarOn',
    min: 0, max: 100, step: 1, def: 85,
    get: S => Math.round(S.brightVar * 100),
    set: (S, pos) => { S.brightVar = pos / 100; save(); },
    format: S => Math.round(S.brightVar * 100) + '%',
    visible: S => S.brightVarOn !== false
  },
  {
    id: 'brightVarPeriod', section: 'strobe', label: 'Variance rate', kind: 'slider',
    parent: 'brightVarOn',
    min: 1, max: 60, step: 1, def: 22,
    get: S => S.brightVarPeriod,
    set: (S, pos) => { S.brightVarPeriod = pos; save(); },
    format: S => S.brightVarPeriod + 's / cycle',
    visible: S => S.brightVarOn !== false
  },
  {
    id: 'color', section: 'strobe', label: 'Color', kind: 'color', def: '#d400ff',
    get: S => rgbHex(S.rgb),
    set: (S, hex) => { setColorFromPicker(hex); save(); }
  },
  {
    // Same shape as frameLock: three buttons, no single owning v0 id, so the
    // group takes the natural name and each option carries its button id.
    id: 'hueBand', section: 'strobe', label: 'Hue range', kind: 'segment', def: 'full',
    options: [
      { value: 'full', label: 'Full', domId: 'hbFull' },
      { value: 'warm', label: 'Warm', domId: 'hbWarm' },
      { value: 'cool', label: 'Cool', domId: 'hbCool' }
    ],
    // The three named arcs from setHueBand in js/ui.js. Warm runs magenta-red
    // through amber and stops short of green, clear of the blue that
    // suppresses melatonin; cool is its mirror, for contrast rather than sleep.
    get: S => S.hueSpan >= 1 ? 'full' : (S.hueLo > 0.9 || S.hueLo < 0.2 ? 'warm' : 'cool'),
    set: (S, name) => {
      const band = { full: [0, 1], warm: [0.93, 0.19], cool: [0.45, 0.25] }[name] || [0, 1];
      S.hueLo = band[0]; S.hueSpan = band[1];
      // v0 also calls invalidateGradients() here, which flushes a Canvas2D
      // gradient cache in js/renderers/canvas2d.js. v1's scene has no such
      // cache: lane A2's Scene.update(lum) reads S fresh every frame, so
      // there is nothing here for a v1 control to invalidate.
      save();
    },
    format: S => ({ full: 'full wheel', warm: 'warm', cool: 'cool' })[
      S.hueSpan >= 1 ? 'full' : (S.hueLo > 0.9 || S.hueLo < 0.2 ? 'warm' : 'cool')
    ]
  },
  {
    id: 'colorWalk', section: 'strobe', label: 'Color walk', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.colorWalk * 100),
    set: (S, pos) => {
      S.colorWalk = pos / 100;
      // syncColorLabel's non-DOM half: v0 also writes the corner button's
      // text, which this drops, but S.colorMode itself is read by
      // copyParams and saved, so it has to be kept in step here too.
      S.colorMode = S.colorWalk <= 0 ? 'magenta' : (S.perElementColor ? 'multi' : 'rotating');
      save();
    },
    format: S => S.colorWalk === 0 ? 'off' : Math.round(S.colorWalk * 100) + '%'
  },
  {
    id: 'walkPeriod', section: 'strobe', label: 'Walk speed', kind: 'slider',
    min: 1, max: 300, step: 1, def: 60,
    get: S => S.walkPeriod,
    set: (S, pos) => { S.walkPeriod = pos; save(); },
    format: S => S.walkPeriod + 's / lap'
  },
  {
    id: 'colorWalkMode', section: 'strobe', label: 'Walk mode', kind: 'segment', def: false,
    options: [
      { value: false, label: 'Together',    domId: 'cwTogether' },
      { value: true,  label: 'Per element', domId: 'cwEach'     }
    ],
    get: S => S.perElementColor,
    set: (S, each) => {
      S.perElementColor = each;
      S.colorMode = S.colorWalk <= 0 ? 'magenta' : (S.perElementColor ? 'multi' : 'rotating');
      // invalidateGradients() dropped for the same reason as hueBand above:
      // the corners' colour source changes, but there is no gradient cache
      // in the v1 scene left to rebuild.
      save();
    }
    // No format: v0 shows no readout span for this row, only which button
    // is lit, which the toolkit already gets from get() against options.
  },

  // ---------- Tunnel ----------
  sectionToggle('ringsOn', 'rings', 'tunnel', 'On'),
  {
    id: 'ringSpeed', section: 'tunnel', label: 'Ring spread', kind: 'slider',
    min: 0.2, max: 3, step: 0.05, def: 0.5,
    get: S => S.ringSpeedMul,
    set: (S, pos) => { S.ringSpeedMul = pos; save(); },
    format: S => S.ringSpeedMul.toFixed(1) + '×'
  },
  {
    id: 'ringFade', section: 'tunnel', label: 'Ring fade in', kind: 'slider',
    min: 0, max: 100, step: 1, def: 55,
    get: S => Math.round(S.ringFade * 100),
    set: (S, pos) => { S.ringFade = pos / 100; save(); },
    format: S => Math.round(S.ringFade * 100) + '%'
  },
  {
    id: 'ringThick', section: 'tunnel', label: 'Line thickness', kind: 'slider',
    min: 0.2, max: 5, step: 0.1, def: 3,
    get: S => S.ringThick,
    set: (S, pos) => { S.ringThick = pos; save(); },
    format: S => S.ringThick.toFixed(1) + '×'
  },
  {
    id: 'ringThickVar', section: 'tunnel', label: 'Line thickness variance', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.ringThickVar * 100),
    // Existing rings keep the thickness factor they were born with (see
    // emitRing in js/sim.js), so, exactly as in v0, a change here only shows
    // up as new rings arrive; reseeding would make the whole tunnel jump.
    set: (S, pos) => { S.ringThickVar = pos / 100; save(); },
    format: S => Math.round(S.ringThickVar * 100) + '%'
  },
  {
    id: 'ringBrightVar', section: 'tunnel', label: 'Ring brightness var', kind: 'slider',
    min: 0, max: 100, step: 1, def: 55,
    get: S => Math.round(S.ringBrightVar * 100),
    set: (S, pos) => { S.ringBrightVar = pos / 100; save(); },
    format: S => Math.round(S.ringBrightVar * 100) + '%'
  },
  {
    id: 'ringBrightPeriod', section: 'tunnel', label: 'Ring bright var rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.ringBrightPeriod,
    set: (S, pos) => { S.ringBrightPeriod = pos; save(); },
    format: S => S.ringBrightPeriod + 's / cycle'
  },

  // ---------- Edge ----------
  sectionToggle('edgeOn', 'edge', 'edge', 'On'),
  {
    // The particle's leading tip (gpu/scene-data.js's buildEdge). v1 only,
    // so no v0 button ids.
    id: 'edgeCap', section: 'edge', label: 'Head shape', kind: 'segment', def: 'wedge',
    options: [
      { value: 'wedge', label: 'Wedge',   domId: null },
      { value: 'round', label: 'Rounded', domId: null },
      { value: 'ball',  label: 'Ball',    domId: null }
    ],
    get: S => S.edgeCap === 'ball' || S.edgeCap === 'round' ? S.edgeCap : 'wedge',
    set: (S, v) => { S.edgeCap = v === 'ball' || v === 'round' ? v : 'wedge'; save(); },
    format: S => S.edgeCap === 'ball' || S.edgeCap === 'round' ? S.edgeCap : 'wedge'
  },
  {
    // Scales every edge particle's brightness, tail and head alike.
    id: 'edgeOpacity', section: 'edge', label: 'Edge opacity', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.edgeOpacity * 100),
    set: (S, pos) => { S.edgeOpacity = pos / 100; save(); },
    format: S => Math.round(S.edgeOpacity * 100) + '%'
  },
  {
    id: 'edgeCount', section: 'edge', label: 'Edge density', kind: 'slider',
    min: 2, max: 200, step: 1, def: 60,
    get: S => S.edgeCount,
    set: (S, pos) => { S.edgeCount = pos; seedParticles(S.edgeCount); save(); },
    format: S => String(S.edgeCount)
  },
  {
    // The slider reads in half the stored units: S.edgeSize stays in the
    // units v0 and saved presets use (so they draw exactly as before), while
    // the slider's 1 is the old 2 and its top is 20.
    id: 'edgeSize', section: 'edge', label: 'Edge size', kind: 'slider',
    min: 0.1, max: 20, step: 0.1, def: 3,
    get: S => S.edgeSize / 2,
    set: (S, pos) => { S.edgeSize = pos * 2; save(); },
    format: S => (S.edgeSize / 2).toFixed(1) + '×'
  },
  {
    id: 'edgeSizeVar', section: 'edge', label: 'Edge size variance', kind: 'slider',
    min: 0, max: 100, step: 1, def: 50,
    get: S => Math.round(S.edgeSizeVar * 100),
    set: (S, pos) => { S.edgeSizeVar = pos / 100; save(); },
    format: S => Math.round(S.edgeSizeVar * 100) + '%'
  },
  {
    id: 'edgeSizeVarPeriod', section: 'edge', label: 'Edge size var rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 18,
    get: S => S.edgeSizeVarPeriod,
    set: (S, pos) => { S.edgeSizeVarPeriod = pos; save(); },
    format: S => S.edgeSizeVarPeriod + 's / cycle'
  },
  {
    id: 'trailLen', section: 'edge', label: 'Trail length', kind: 'slider',
    min: 0.2, max: 6, step: 0.1, def: 1,
    get: S => S.trailMul,
    set: (S, pos) => { S.trailMul = pos; save(); },
    format: S => S.trailMul.toFixed(1) + '×'
  },
  {
    id: 'edgeSpeed', section: 'edge', label: 'Edge speed', kind: 'slider',
    min: 0, max: 6, step: 0.1, def: 4,
    get: S => S.edgeSpeedMul,
    set: (S, pos) => { S.edgeSpeedMul = pos; save(); },
    format: S => S.edgeSpeedMul.toFixed(1) + '×'
  },
  {
    id: 'edgeSpeedVar', section: 'edge', label: 'Edge speed variance', kind: 'slider',
    min: 0, max: 100, step: 1, def: 50,
    get: S => Math.round(S.edgeSpeedVar * 100),
    set: (S, pos) => { S.edgeSpeedVar = pos / 100; save(); },
    format: S => Math.round(S.edgeSpeedVar * 100) + '%'
  },
  {
    id: 'edgeSpeedVarPeriod', section: 'edge', label: 'Edge speed var rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 22,
    get: S => S.edgeSpeedVarPeriod,
    set: (S, pos) => { S.edgeSpeedVarPeriod = pos; save(); },
    format: S => S.edgeSpeedVarPeriod + 's / cycle'
  },
  {
    // A native <select> in v0, not a button row, so there is no per-option
    // DOM id to hand out; the options below exist for the toolkit's segment
    // widget, and byDomId only ever matches this control's own id ('edgeDir'),
    // never one of its options.
    id: 'edgeDir', section: 'edge', label: 'Edge rotation', kind: 'segment', def: 'both',
    options: [
      { value: 'cw',   label: 'Clockwise',          domId: null },
      { value: 'ccw',  label: 'Counter clockwise',   domId: null },
      { value: 'both', label: 'Both',                domId: null }
    ],
    get: S => S.edgeDir,
    set: (S, v) => { S.edgeDir = v; applyEdgeDir(); save(); }
  },

  // ---------- Text ----------
  // Same switch as lText above (S.layers.text), shown a second time here
  // because v0 shows it a second time here: the pair of buttons at the top
  // of the Text group, which in v0 route through $('lText').click() so the
  // checkbox stays the one owner. This entry reaches the same state directly
  // instead, since there is no checkbox in v1 to click through.
  {
    id: 'textOn', section: 'text', label: 'Words', kind: 'segment', def: true,
    options: [
      { value: true,  label: 'On',  domId: 'txOn'  },
      { value: false, label: 'Off', domId: 'txOff' }
    ],
    get: S => !!S.layers.text,
    set: (S, on) => { S.layers.text = on; save(); },
    format: S => S.layers.text ? 'on' : 'off'
  },
  {
    id: 'textLink', section: 'text', label: 'Blink source', kind: 'segment', def: true,
    options: [
      { value: true,  label: 'Match the strobe', domId: 'txLink' },
      { value: false, label: 'Own rate',          domId: 'txFree' }
    ],
    get: S => S.textLinked,
    set: (S, on) => { S.textLinked = on; save(); },
    format: S => S.textLinked ? 'strobe' : 'own rate'
  },
  {
    // Only shown while Blink source is Own rate; matching the strobe makes
    // this rate meaningless, so the row steps out of the way.
    id: 'textRate', section: 'text', label: 'Own blink rate', kind: 'slider',
    parent: 'textLink',
    min: 0.1, max: 10, step: 0.1, def: 2,
    visible: S => !S.textLinked,
    get: S => S.textRateHz,
    set: (S, pos) => { S.textRateHz = pos; save(); },
    format: S => S.textRateHz.toFixed(1) + ' Hz'
  },
  {
    // v0's set() also calls recentreWord(), which re-measures the DOM word
    // element's ink offset at the new font size. The SDF text system
    // (v1/gpu/text-atlas.js) measures exact glyph advances on every draw, so
    // per ARCHITECTURE.md's Words section the whole ink-centring hack is
    // unnecessary in v1; there is nothing for this control to call instead.
    id: 'textSize', section: 'text', label: 'Word size', kind: 'slider',
    min: 16, max: 160, step: 1, def: 35,
    get: S => S.textSize,
    set: (S, pos) => { S.textSize = pos; save(); },
    format: S => S.textSize + ' px'
  },
  {
    id: 'textColorMode', section: 'text', label: 'Word color', kind: 'segment', def: 'system',
    options: [
      { value: 'white',  label: 'White',              domId: 'txWhite'  },
      { value: 'system', label: 'Match the strobe',    domId: 'txSystem' }
    ],
    get: S => S.textColorMode,
    set: (S, v) => { S.textColorMode = v; save(); },
    format: S => S.textColorMode === 'system' ? 'match the strobe' : 'white'
  },
  {
    id: 'textOpacity', section: 'text', label: 'Opacity', kind: 'slider',
    min: 0, max: 100, step: 1, def: 95,
    get: S => Math.round(S.textOpacity * 100),
    set: (S, pos) => { S.textOpacity = pos / 100; save(); },
    format: S => Math.round(S.textOpacity * 100) + '%'
  },
  {
    // Lifts a strobe-coloured word toward white so it pops off the field.
    id: 'textBrighten', section: 'text', label: 'Brighten', kind: 'slider',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round(S.textBrighten * 100),
    set: (S, pos) => { S.textBrighten = pos / 100; save(); },
    format: S => Math.round(S.textBrighten * 100) + '%',
    visible: S => S.textColorMode === 'system'
  },
  {
    id: 'textOpacityVar', section: 'text', label: 'Opacity variance', kind: 'slider',
    min: 0, max: 100, step: 1, def: 10,
    get: S => Math.round(S.textOpacityVar * 100),
    set: (S, pos) => { S.textOpacityVar = pos / 100; save(); },
    format: S => Math.round(S.textOpacityVar * 100) + '%'
  },
  {
    id: 'textOpacityVarPeriod', section: 'text', label: 'Opacity var rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 20,
    get: S => S.textOpacityVarPeriod,
    set: (S, pos) => { S.textOpacityVarPeriod = pos; save(); },
    format: S => S.textOpacityVarPeriod + 's / cycle'
  },
  {
    id: 'textFreq', section: 'text', label: 'Appearance', kind: 'slider',
    min: 0, max: 100, step: 1, def: 50,
    get: S => Math.round(S.textFreq * 100),
    set: (S, pos) => { S.textFreq = pos / 100; save(); },
    format: S => Math.round(S.textFreq * 100) + '%'
  },
  {
    id: 'textRandom', section: 'text', label: 'Appearance variance', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.textRandom * 100),
    set: (S, pos) => { S.textRandom = pos / 100; save(); },
    format: S => Math.round(S.textRandom * 100) + '%'
  },
  {
    id: 'textRestFreq', section: 'text', label: 'Rest frequency', kind: 'slider',
    min: 0, max: 100, step: 1, def: 4,
    get: S => Math.round(S.textRestFreq * 100),
    set: (S, pos) => { S.textRestFreq = pos / 100; save(); },
    format: S => Math.round(S.textRestFreq * 100) + '%'
  },
  {
    id: 'textRestSec', section: 'text', label: 'Rest duration', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.textRestSec,
    set: (S, pos) => { S.textRestSec = pos; save(); },
    format: S => S.textRestSec + 's'
  },
  {
    id: 'textRestVar', section: 'text', label: 'Rest variance', kind: 'slider',
    min: 0, max: 100, step: 1, def: 70,
    get: S => Math.round(S.textRestVar * 100),
    set: (S, pos) => { S.textRestVar = pos / 100; save(); },
    format: S => Math.round(S.textRestVar * 100) + '%'
  },
  {
    id: 'textDwell', section: 'text', label: 'Time on screen', kind: 'slider',
    min: 0, max: 4000, step: 10, def: 80,
    get: S => S.textDwellMs,
    set: (S, pos) => { S.textDwellMs = pos; save(); },
    format: S => S.textDwellMs + ' ms'
  },
  // ---- fade in and fade out, each with its transition (core/word-fx.js) ----
  // Each side is a switch with everything it governs listed under it: the
  // time, then the effect the letters play across that time and the effect's
  // own settings. Off, the word just appears or disappears, as at 0 ms.
  {
    id: 'textFadeInOn', section: 'text', label: 'Fade in', kind: 'toggle', def: true,
    get: fadeInOn,
    set: (S, on) => { S.textFadeInOn = !!on; save(); },
    format: S => fadeInOn(S) ? 'On' : 'Off'
  },
  {
    id: 'textFadeIn', section: 'text', label: 'Duration', kind: 'slider', parent: 'textFadeInOn',
    min: 0, max: 10000, step: 50, def: 0,
    visible: fadeInOn,
    get: S => S.textFadeInMs,
    set: (S, pos) => { S.textFadeInMs = pos; save(); },
    format: S => S.textFadeInMs + ' ms'
  },
  {
    id: 'textFxIn', section: 'text', label: 'Arrive', kind: 'segment', def: 'gather', parent: 'textFadeInOn',
    options: fxOptions('fxIn'),
    visible: fadeInOn,
    get: S => S.textFxIn,
    set: (S, v) => { S.textFxIn = v; save(); },
    format: S => FX_NAMES[S.textFxIn] || S.textFxIn
  },
  ...fxRows(false),
  {
    // On, the word leaves by the same effect and settings it arrived by, on
    // a fresh path back out, and the Leave rows step out of the way. Its own
    // line between the two sides, since it ties one to the other.
    id: 'textFxMirror', section: 'text', label: 'Leave the way it came', kind: 'toggle', def: false,
    visible: fadeOutOn,
    get: S => !!S.textFxMirror,
    set: (S, on) => { S.textFxMirror = !!on; save(); },
    format: S => S.textFxMirror ? 'On' : 'Off'
  },
  {
    id: 'textFadeOutOn', section: 'text', label: 'Fade out', kind: 'toggle', def: true,
    get: fadeOutOn,
    set: (S, on) => { S.textFadeOutOn = !!on; save(); },
    format: S => fadeOutOn(S) ? 'On' : 'Off'
  },
  {
    id: 'textFadeOut', section: 'text', label: 'Duration', kind: 'slider', parent: 'textFadeOutOn',
    min: 0, max: 10000, step: 50, def: 0,
    visible: fadeOutOn,
    get: S => S.textFadeOutMs,
    set: (S, pos) => { S.textFadeOutMs = pos; save(); },
    format: S => S.textFadeOutMs + ' ms'
  },
  {
    id: 'textFxOut', section: 'text', label: 'Leave', kind: 'segment', def: 'wind', parent: 'textFadeOutOn',
    options: fxOptions('fxOut'),
    visible: S => fadeOutOn(S) && !S.textFxMirror,
    get: S => S.textFxOut,
    set: (S, v) => { S.textFxOut = v; save(); },
    format: S => FX_NAMES[S.textFxOut] || S.textFxOut
  },
  ...fxRows(true),
  {
    // Multi-select: every theme chip is independently on or off. get()
    // returns the array of theme keys currently active; an empty S.textThemes
    // reads as "every theme", matching rebuildPool's own rule in js/text.js,
    // so a fresh session shows every chip lit without having written 22
    // `true`s into storage. set(S, key) toggles exactly one key, replicating
    // the per-chip button handler in js/ui.js including the "first touch
    // turns the blanket everything into an explicit set" rule: the set has to
    // be made real before any single key can be subtracted from it. The All
    // and None buttons are separate action controls below, matching v0's
    // txAllOn/txAllOff, which write every key at once rather than toggling.
    id: 'textThemes', section: 'text', label: 'Themes', kind: 'segment', multi: true,
    options: Object.keys(THEMES).map(k => ({
      value: k, label: THEMES[k],
      // v0 builds these buttons from THEMES at runtime with no id attribute,
      // only a dataset.theme; there is no real v0 DOM id to carry over, so
      // this is a synthetic one for byDomId lookups within this schema only.
      // Presets never reference a theme by button id (js/presets.js has no
      // 'theme' keys anywhere), so nothing outside this file depends on it.
      domId: 'theme:' + k
    })),
    get: themesGet,
    set: (S, key) => {
      const keys = Object.keys(THEMES);
      if (!Object.keys(S.textThemes).length) keys.forEach(k => { S.textThemes[k] = true; });
      S.textThemes[key] = !S.textThemes[key];
      rebuildWordPool();
      save();
    },
    format: S => {
      const n = themePoolSize(S);
      return n ? n.toLocaleString() + ' words' : 'none';
    }
  },
  {
    id: 'txAllOn', section: 'text', label: 'All', kind: 'action',
    set: S => {
      Object.keys(THEMES).forEach(k => { S.textThemes[k] = true; });
      rebuildWordPool();
      save();
    }
  },
  {
    id: 'txAllOff', section: 'text', label: 'None', kind: 'action',
    set: S => {
      Object.keys(THEMES).forEach(k => { S.textThemes[k] = false; });
      rebuildWordPool();
      save();
    }
  },

  // ---------- Render ----------
  // v0's Render group also has Renderer (rAuto/rGPU/rGL/r2D) and Strobe
  // thread (thMain/thWorker) rows. The renderer row picked a backend v1 does
  // not have (it is WebGPU only, per ARCHITECTURE.md), so it is left out.
  // v0's strobe thread became v1's Engine thread below, which moves the
  // whole engine, UI included, since v1 draws everything in one canvas.
  {
    // Only matters when frame lock lands on an odd frame count; see the
    // comment above spLit/spDark in index.html for why 'lit' and 'dark' are
    // the only two options and there is no third, alternating one.
    id: 'spareMode', section: 'render', label: 'Spare frame', kind: 'segment', def: 'lit',
    options: [
      { value: 'lit',  label: 'Lit',  domId: 'spLit'  },
      { value: 'dark', label: 'Dark', domId: 'spDark' }
    ],
    get: S => S.spareMode,
    set: (S, mode) => { S.spareMode = mode; save(); },
    format: S => S.spareMode
  },
  {
    // Where the engine runs: on the page's main thread, or in a worker where
    // nothing else the page does can hold up a frame (core/engine-thread.js).
    // A WebGPU device cannot move between threads, so a change is stored and
    // applies on the next load, and the readout says 'reload to apply' until
    // then, or 'unavailable' where this browser cannot run the engine in a
    // worker (it then stays on the main thread). Stored under a key of its
    // own, not in the settings record, so presets and other tabs leave it be.
    id: 'engineThread', section: 'render', label: 'Engine thread', kind: 'segment', def: 'main',
    dropdown: true,
    options: [
      { value: 'main',   label: 'Main',   domId: null },
      { value: 'worker', label: 'Worker', domId: null }
    ],
    get: () => engineThread.wanted,
    set: (S, v) => setEngineThreadWanted(v),
    format: () => engineThreadStatus()
  }
];

// Mirrors rebuildPool's filter in js/text.js exactly, but reads the static
// WORDS table directly rather than lane B's live pool cache: format() is
// called from the toolkit on every change to S.textThemes, and computing it
// from S plus the word list keeps this control's readout a pure function of
// state, with no dependency on when v1/core/words.js last rebuilt its pool.
function themePoolSize(S) {
  const on = S.textThemes;
  if (!on || !Object.keys(on).length) return WORDS.length;
  let n = 0;
  for (const row of WORDS) {
    for (let i = 1; i < row.length; i++) {
      if (on[row[i]]) { n++; break; }
    }
  }
  return n;
}

export const VISUAL_SECTIONS = [
  { id: 'layers', title: 'Layers' },
  { id: 'strobe', title: 'Strobe' },
  { id: 'corners', title: 'Corners' },
  { id: 'tunnel', title: 'Tunnel' },
  { id: 'edge',   title: 'Edge'   },
  { id: 'text',   title: 'Text'   },
  { id: 'render', title: 'Render' }
];
