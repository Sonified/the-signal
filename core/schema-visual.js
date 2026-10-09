// The visual half of the control schema: layers, Strobe, Tunnel, Edge, Text
// and the one Render item that still means something once the frame loop is
// WebGPU on the main thread by design (see the Render section below). Every
// entry is a faithful port of one handler in v0/js/ui.js, read side by side with
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
import { byId } from './schema.js';
import { setColorFromPicker } from '../js/color.js';
import { CORNER_TYPES } from '../js/state.js';
import { setAmRate } from '../js/audio.js';
import { seedParticles, applyEdgeDir } from '../js/sim.js';
import { THEMES, WORDS } from '../js/words.js';
import { rebuildWordPool, retimeWordOpacity } from './words.js';
import { FX_NAMES } from './word-fx.js';
import { save, loadUiState, saveUiState } from './store.js';
import { engineThread, setEngineThreadWanted, engineThreadStatus } from './engine-thread.js';
import { varianceRows } from './schema-variance.js';
import { varied } from './variance.js';
import { applyHeartLookahead, applyHeartGrow } from '../js/heart/route.js';

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
// The sub-drawers (Text's Timing, Styling and Fades; Strobe's Timing,
// Brightness and Color; Tunnel's Motion, Brightness and Style; Edge's Motion
// and Style; Flowers' Motion, Shape and Brightness; Kaleidoscope's Motion,
// Shapes, Brightness and Color; Particles' Motion, Shape and Color; Render's
// Audio engine, Pause, Hint, Trails and Parallax; and the Audio and Music
// voices, whose strips carry the voice's switch): each a toggle whose rows
// nest under it, open while it is on. They are disclosures, not
// features, so whether one is open is how the interface was arranged, not
// how the session looks or sounds. It lives beside the drawer's own open
// sections in the UI record (store.js saveUiState), never in S, so no preset,
// snapshot or other tab ever sees it, and `uiOnly` keeps these rows out of
// the preset replay and the audio mirror. The drawer folds every row under
// one open and shut the way a section folds (imgui.js beginFold). All start open: the record lists only the ones the
// viewer shut. It is read the first time the drawer asks, well after main.js
// has handed the store its storage.
let shutSubs = null;
function shutSubDrawers() {
  if (shutSubs === null) {
    shutSubs = new Set();
    const saved = loadUiState();
    const list = saved && Array.isArray(saved.shutSubDrawers) ? saved.shutSubDrawers : [];
    for (const id of list) if (typeof id === 'string') shutSubs.add(id);
  }
  return shutSubs;
}
// The section defaults to Text, where sub-drawers began; the others name theirs.
// Ids are unique across sections, since they share the one shut list.
// Exported for the sections defined in files of their own (schema-flowers.js),
// so every sub-drawer shares the one shut list and the one way of saving it.
// summary lists the ids whose readouts a shut strip shows beside its name
// (drawer.js, imgui.js beginFold), the drawer's primary settings; left out,
// the drawer takes its first two sliders or segments. Each reads as the
// control's summaryLabel (a shorthand such as 'Freq'; its label's first word
// when it has none) and then its readout.
// switchId (optional) names a real on/off control, a voice's own switch, that
// the strip then carries beside its chevron the way a section header carries
// its layer's (drawer.js, imgui.js beginFold): a click on it runs that
// control's set() and leaves the drawer as it was, a click anywhere else on
// the strip opens or shuts it. That control is not drawn as a row of its own.
export function subDrawer(id, label, section = 'text', summary, switchId) {
  return {
    id, section, label, kind: 'toggle', uiOnly: true, summary, switchId,
    get: () => !shutSubDrawers().has(id),
    set: (S, on) => {
      const shut = shutSubDrawers();
      if (on) shut.delete(id); else shut.add(id);
      saveUiState({ shutSubDrawers: Array.from(shut) });
    }
  };
}

// The Edge section's effect (gpu/scene.js), read safely: anything else
// on S (a record from before effects) is Surfing, the edge as it was.
const EDGE_MODES = ['surfing', 'particles', 'flame', 'glow'];
const edgeMode = S => EDGE_MODES.indexOf(S.edgeMode) >= 0 ? S.edgeMode : 'surfing';
const surfing = S => edgeMode(S) === 'surfing';
// The edge's Pulse with strobe, 1 (the edge as it always was) when unset.
const edgePulse = S => typeof S.edgePulse === 'number' ? S.edgePulse : 1;

const fadeInOn = S => S.textFadeInOn !== false;
const fadeOutOn = S => S.textFadeOutOn !== false;
// Whole phrases, which can wrap to several lines: the affirmations, and the
// Custom source's own phrases, so the rows about how a block's lines move
// show for both.
const phraseMode = S => S.textMode === 'affirmations' || S.textMode === 'custom';
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
    // How evenly the vapour washes out in all directions. Low is the raw
    // wind, where a gust can carry the whole word one way; high removes
    // that shared drift so every push away from centre has its equal on
    // the far side, and no direction steals the eye.
    pct('textSmokeEq', 'Radial equality', 100, 50, ['smoke']),
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
  {
    // The chrome's upper-right STROBE dial, again here at the head of the
    // section: both read and write the one S.strobeScale (the emergency
    // master over every visual and audio strobe depth, see the transport
    // control in schema-audio.js), so they can never disagree. Not gated
    // by the field layer: it is a master, live whatever is on.
    id: 'masterStrobe', section: 'strobe', label: 'Master strobe', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((typeof S.strobeScale === 'number' ? S.strobeScale : 1) * 100),
    set: (S, pos) => { const c = byId('strobeScale'); if (c) c.set(S, pos); },
    format: S => Math.round((typeof S.strobeScale === 'number' ? S.strobeScale : 1) * 100) + '%'
  },
  {
    // On, every glide of the strobe's rate (a preset's, a journey's, the
    // performer's) steps straight across the 15-25 Hz photosensitive band
    // rather than sweeping through it (strobe.js glideSkippingRiskBand). Off,
    // glides run straight through. A master like the one above: live
    // whatever is on.
    id: 'skipRiskBand', section: 'strobe', label: 'Skip photosensitive range', kind: 'toggle', def: true,
    get: S => S.skipRiskBand !== false,
    set: (S, on) => { S.skipRiskBand = !!on; save(); },
    format: S => S.skipRiskBand !== false ? 'On' : 'Off'
  },
  // Corners are their own layer with their own section (below Strobe), so
  // the Strobe switch never touches them.
  sectionToggle('cornersOn', 'corners', 'corners', 'On'),
  // Their own controls, apart from the strobe's brightness and depth. Speed runs the corners' chase on its own
  // clock, stepped by the strobe's each frame, so 1x is today's lock-step.
  // Pulse is how much they flash with it, 0 a steady glow.
  {
    id: 'cornerOpacity', section: 'corners', label: 'Opacity', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((S.cornerOpacity ?? 1) * 100),
    set: (S, pos) => { S.cornerOpacity = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round((S.cornerOpacity ?? 1) * 100) + '%'
  },
  // The opacity breathes on the app's standard: over one rate cycle it
  // eases from the setting down by this share and back, never above it.
  ...varianceRows('cornerOpacity', {
    name: 'Opacity',
    effective: S => (S.effCornerOpacity ?? S.cornerOpacity ?? 1) * 100
  }),
  {
    id: 'cornerSpeed', section: 'corners', label: 'Speed', kind: 'slider',
    min: 0, max: 4, step: 0.05, def: 1,
    get: S => S.cornerSpeed ?? 1,
    set: (S, pos) => { S.cornerSpeed = Math.max(0, Math.min(4, pos)); save(); },
    format: S => (S.cornerSpeed ?? 1).toFixed(2) + '×'
  },
  {
    id: 'cornerPulse', section: 'corners', label: 'Pulse with strobe', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((S.cornerPulse ?? 1) * 100),
    set: (S, pos) => { S.cornerPulse = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => (S.cornerPulse ?? 1) === 0 ? 'never flickers' : Math.round(S.cornerPulse * 100) + '%'
  },
  {
    id: 'cornerSize', section: 'corners', label: 'Size', kind: 'slider',
    min: 5, max: 100, step: 1, def: 46,
    get: S => Math.round((S.cornerSize ?? 0.46) * 100),
    set: (S, pos) => { S.cornerSize = Math.max(0.05, Math.min(1, pos / 100)); save(); },
    format: S => Math.round((S.cornerSize ?? 0.46) * 100) + '%'
  },
  {
    id: 'cornerType', section: 'corners', label: 'Type', kind: 'segment', def: 'glow',
    hideLabel: true,
    options: [
      { value: 'glow',    label: 'Glow' },
      { value: 'beam',    label: 'Beam' },
      { value: 'bracket', label: 'Bracket' },
      { value: 'arc',     label: 'Arc' }
    ],
    get: S => S.cornerType || 'glow',
    set: (S, v) => { if (CORNER_TYPES.indexOf(v) >= 0) { S.cornerType = v; save(); } }
  },
  // ---- three sub-drawers, Timing, Brightness and Color (see subDrawer),
  // each with its rows straight after it ----
  subDrawer('strobeTimingDrawer', 'Timing', 'strobe', ['freq', 'wave']),
  {
    id: 'freq', section: 'strobe', label: 'Frequency', kind: 'slider',
    summaryLabel: 'Freq',
    parent: 'strobeTimingDrawer',
    min: 0.5, max: 45, step: 0.5, def: 7.5,
    get: S => S.freq,
    effective: S => S.freqDriftOn !== false && S.freqDrift > 0 ? S.effFreq : undefined,
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
    // Off holds the strobe on the set frequency; the amount and rate below
    // keep their values for when it comes back on.
    id: 'freqDriftOn', section: 'strobe', label: 'Frequency drift', kind: 'toggle', def: true,
    varianceOf: 'freq',
    get: S => S.freqDriftOn !== false,
    set: (S, on) => { S.freqDriftOn = !!on; save(); },
    format: S => S.freqDriftOn !== false ? 'On' : 'Off'
  },
  {
    id: 'freqDrift', section: 'strobe', label: 'Drift amount', kind: 'slider',
    varianceOf: 'freq',
    parent: 'freqDriftOn',
    min: 0, max: 15, step: 0.5, def: 1,
    get: S => S.freqDrift,
    set: (S, pos) => { S.freqDrift = pos; save(); },
    format: S => '±' + S.freqDrift.toFixed(1) + ' Hz',
    visible: S => S.freqDriftOn !== false
  },
  {
    id: 'driftRate', section: 'strobe', label: 'Drift rate', kind: 'slider',
    varianceOf: 'freq',
    parent: 'freqDriftOn',
    min: 1, max: 60, step: 1, def: 60,
    get: S => S.driftPeriod,
    set: (S, pos) => { S.driftPeriod = pos; save(); },
    format: S => S.driftPeriod + 's / cycle',
    visible: S => S.freqDriftOn !== false
  },
  {
    id: 'wave', section: 'strobe', label: 'Waveform', kind: 'segment', def: 'square',
    hideLabel: true,
    summaryLabel: 'Wave',
    parent: 'strobeTimingDrawer',
    options: [
      { value: 'sine',     label: 'Sine',   domId: 'wSine' },
      { value: 'triangle', label: 'Tri',    domId: 'wTri'  },
      { value: 'square',   label: 'Square', domId: 'wSq'   }
    ],
    get: S => S.wave,
    set: (S, v) => { S.wave = v; save(); }
  },
  {
    // Two buttons in v0, not a single input, so there is no v0 DOM id that
    // names the control itself; 'frameLock' is the natural name for the pair,
    // and each option carries the id of the button that sets it.
    // Drawn as a dropdown (widgets.js select): the options say what each
    // one does, which is too long for two buttons side by side.
    id: 'frameLock', section: 'strobe', label: 'Flash quantization', kind: 'segment', def: true,
    parent: 'strobeTimingDrawer',
    dropdown: true,
    options: [
      { value: false, label: 'Free (possible irregular frames)',       domId: 'lkOff' },
      { value: true,  label: 'Match screen refresh (regular frames)', domId: 'lkOn'  }
    ],
    get: S => S.frameLock,
    set: (S, on) => { S.frameLock = on; save(); },
    // S.framesPerCycle and S.achievedFreq are written every frame by
    // core/strobe.js, the same fields v0's tick() writes, so this reads
    // exactly the numbers updateReadouts() did.
    format: S => !S.frameLock ? 'off'
      : S.framesPerCycle ? S.achievedFreq.toFixed(2) + ' Hz · ' + S.framesPerCycle + ' fr' : 'on'
  },
  subDrawer('strobeBrightnessDrawer', 'Brightness', 'strobe', ['depth', 'bright']),
  {
    id: 'depth', section: 'strobe', label: 'Depth', kind: 'slider',
    summaryLabel: 'Depth',
    parent: 'strobeBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 80,
    get: S => Math.round(S.depth * 100),
    set: (S, pos) => { S.depth = pos / 100; save(); },
    format: S => Math.round(S.depth * 100) + '%'
  },
  // The overlay shows the dip the variance makes on the Depth setting
  // itself, not S.effDepth, which also carries the Master strobe (strobe.js
  // scales it on the way to the engine, so at Master strobe 0 it reads 0
  // however the variance breathes).
  ...varianceRows('depth', {
    name: 'Depth', period: 'varPeriod', amountDef: 80, periodDef: 10,
    effective: S => varied(S.depth, S.depthVar, S.varPhase || 0) * 100
  }),
  {
    id: 'bright', section: 'strobe', label: 'Brightness', kind: 'slider',
    summaryLabel: 'Bright',
    parent: 'strobeBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.bright * 100),
    set: (S, pos) => { S.bright = pos / 100; save(); },
    format: S => Math.round(S.bright * 100) + '%'
  },
  ...varianceRows('bright', {
    name: 'Brightness', amountDef: 85, periodDef: 22,
    effective: S => S.effBright * 100
  }),
  {
    // The field's own opacity: it dims the strobe field and nothing else.
    // Brightness above is the whole flash signal, which the rings, the
    // corners and every layer's pulse follow; this fades just the field.
    id: 'fieldOpacity', section: 'strobe', label: 'Field opacity', kind: 'slider',
    summaryLabel: 'Opacity',
    parent: 'strobeBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((S.fieldOpacity ?? 1) * 100),
    set: (S, pos) => { S.fieldOpacity = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round((S.fieldOpacity ?? 1) * 100) + '%'
  },
  {
    id: 'fieldShape', section: 'strobe', label: 'Field shape', kind: 'segment', def: 'full',
    hideLabel: true,
    parent: 'strobeBrightnessDrawer',
    options: [
      { value: 'circle', label: 'Circle', domId: 'sCircle' },
      { value: 'panel',  label: 'Panel',  domId: 'sPanel'  },
      { value: 'full',   label: 'Full',   domId: 'sFull'   }
    ],
    get: S => S.fieldShape,
    set: (S, v) => { S.fieldShape = v; save(); }
  },
  {
    // The field eased in from the centre on the rings' own curve (core/fade.js),
    // so the middle stays dark like the other layers' Fade in. 0 is no fade.
    id: 'fieldFade', section: 'strobe', label: 'Center fade radius', kind: 'slider',
    parent: 'strobeBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.fieldFade || 0) * 100),
    set: (S, pos) => { S.fieldFade = pos / 100; save(); },
    format: S => Math.round((S.fieldFade || 0) * 100) + '%'
  },
  // The fade radius breathes on the app's standard: over one rate cycle it
  // eases from the setting down by this share and back, never above it.
  ...varianceRows('fieldFade', {
    name: 'Fade radius', parent: 'strobeBrightnessDrawer',
    effective: S => (S.effFieldFade ?? S.fieldFade ?? 0) * 100
  }),
  {
    // How soft the fade's edge is. At 100% the ease spans the whole way from
    // the centre to the fade radius, exactly the shared curve; lower values
    // compress the ease toward the radius, down to a hard-edged circle at 0.
    id: 'fieldSoft', section: 'strobe', label: 'Center fade softness', kind: 'slider',
    parent: 'strobeBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((S.fieldSoft ?? 1) * 100),
    set: (S, pos) => { S.fieldSoft = pos / 100; save(); },
    format: S => Math.round((S.fieldSoft ?? 1) * 100) + '%',
    visible: S => (S.fieldFade || 0) > 0
  },
  subDrawer('strobeColorDrawer', 'Color', 'strobe', ['hueBand', 'colorWalk']),
  {
    id: 'color', section: 'strobe', label: 'Color', kind: 'color', def: '#d400ff',
    parent: 'strobeColorDrawer',
    get: S => rgbHex(S.rgb),
    set: (S, hex) => { setColorFromPicker(hex); save(); }
  },
  {
    // Same shape as frameLock: three buttons, no single owning v0 id, so the
    // group takes the natural name and each option carries its button id.
    id: 'hueBand', section: 'strobe', label: 'Hue range', kind: 'segment', def: 'full',
    hideLabel: true,
    summaryLabel: 'Hue',
    parent: 'strobeColorDrawer',
    options: [
      { value: 'full', label: 'Full', domId: 'hbFull' },
      { value: 'warm', label: 'Warm', domId: 'hbWarm' },
      { value: 'cool', label: 'Cool', domId: 'hbCool' }
    ],
    // The three named arcs from setHueBand in v0/js/ui.js. Warm runs magenta-red
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
    summaryLabel: 'Walk',
    parent: 'strobeColorDrawer',
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
    parent: 'strobeColorDrawer',
    min: 1, max: 300, step: 1, def: 60,
    get: S => S.walkPeriod,
    set: (S, pos) => { S.walkPeriod = pos; save(); },
    format: S => S.walkPeriod + 's / lap'
  },
  {
    id: 'colorWalkMode', section: 'strobe', label: 'Walk mode', kind: 'segment', def: false,
    hideLabel: true,
    parent: 'strobeColorDrawer',
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
  // ---- three sub-drawers, Motion, Brightness and Style (see subDrawer),
  // each with its rows straight after it. Motion's id still says Timing, its
  // first name, so an open or shut state saved under it carries over ----
  subDrawer('tunnelTimingDrawer', 'Motion', 'tunnel', ['ringSpeed', 'ringDensity', 'ringOrigin', 'ringFadeInMs']),
  {
    id: 'ringSpeed', section: 'tunnel', label: 'Ring speed', kind: 'slider',
    summaryLabel: 'Speed',
    parent: 'tunnelTimingDrawer',
    min: 0.1, max: 3, step: 0.05, def: 2.5,
    get: S => S.ringSpeedMul,
    set: (S, pos) => { S.ringSpeedMul = pos; save(); },
    format: S => S.ringSpeedMul.toFixed(1) + '×'
  },
  // The speed's dip, the app's standard: over one rate cycle the rings ease
  // from the setting down by this share and back, never above it. The bar
  // glows with the speed as core/strobe.js dips it each frame.
  ...varianceRows('ringSpeed', {
    labels: ['Speed variance', 'Variance rate'], parent: 'tunnelTimingDrawer',
    effective: S => typeof S.effRingSpeedMul === 'number' ? S.effRingSpeedMul : undefined
  }),
  {
    // How often a new ring is born, straight in rings a second; the old
    // behaviour was one per flash capped near five, so five is the familiar
    // pace and higher packs the tunnel denser at any strobe frequency.
    id: 'ringDensity', section: 'tunnel', label: 'Ring density', kind: 'slider',
    summaryLabel: 'Density',
    parent: 'tunnelTimingDrawer',
    min: 0.2, max: 20, step: 0.1, def: 5,
    get: S => S.ringRate,
    set: (S, pos) => { S.ringRate = pos; save(); },
    format: S => S.ringRate.toFixed(1) + ' / s'
  },
  {
    // Where a new ring is born, as a share of the tunnel's depth: 100% is
    // the far plane (the vanishing point, where they always started), lower
    // births them nearer the viewer (js/sim.js ringBirthZ). Rings already in
    // flight carry on from where they are.
    id: 'ringOrigin', section: 'tunnel', label: 'Ring origin', kind: 'slider',
    summaryLabel: 'Origin',
    parent: 'tunnelTimingDrawer',
    min: 5, max: 100, step: 1, def: 100,
    get: S => Math.round((S.ringOrigin ?? 1) * 100),
    set: (S, pos) => { S.ringOrigin = pos / 100; save(); },
    format: S => Math.round((S.ringOrigin ?? 1) * 100) + '%'
  },
  {
    // How long a new ring takes to fade up from nothing when it is born,
    // linear in opacity (gpu/scene-data.js); 0 shows it at once, as it
    // always did. The tunnel seeded at the start is there already, not faded.
    id: 'ringFadeInMs', section: 'tunnel', label: 'Ring fade in', kind: 'slider',
    summaryLabel: 'Fade in',
    parent: 'tunnelTimingDrawer',
    min: 0, max: 3000, step: 50, def: 1000,
    get: S => S.ringFadeInMs ?? 1000,
    set: (S, v) => { S.ringFadeInMs = v; save(); },
    format: S => Math.round(S.ringFadeInMs ?? 1000) + ' ms'
  },
  subDrawer('tunnelBrightnessDrawer', 'Brightness', 'tunnel', ['ringOpacity', 'ringFade', 'ringPulse']),
  {
    id: 'ringOpacity', section: 'tunnel', label: 'Ring opacity', kind: 'slider',
    summaryLabel: 'Opacity',
    parent: 'tunnelBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((S.ringOpacity ?? 1) * 100),
    set: (S, pos) => { S.ringOpacity = pos / 100; save(); },
    format: S => Math.round((S.ringOpacity ?? 1) * 100) + '%'
  },
  ...varianceRows('ringOpacity', {
    amount: 'ringBrightVar', period: 'ringBrightPeriod', labels: ['Ring brightness var', 'Ring bright var rate'],
    amountDef: 55, periodDef: 10,
    effective: S => varied(S.ringOpacity ?? 1, S.ringBrightVar, S.ringBrightPhase) * 100
  }),
  {
    id: 'ringFade', section: 'tunnel', label: 'Center fade radius', kind: 'slider',
    summaryLabel: 'Fade',
    parent: 'tunnelBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 55,
    get: S => Math.round(S.ringFade * 100),
    set: (S, pos) => { S.ringFade = pos / 100; save(); },
    format: S => Math.round(S.ringFade * 100) + '%'
  },
  {
    id: 'ringPulse', section: 'tunnel', label: 'Pulse with strobe', kind: 'slider',
    summaryLabel: 'Pulse',
    parent: 'tunnelBrightnessDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.ringPulse || 0) * 100),
    set: (S, pos) => { S.ringPulse = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => (S.ringPulse || 0) === 0 ? 'never flickers' : Math.round(S.ringPulse * 100) + '%'
  },
  subDrawer('tunnelStyleDrawer', 'Style', 'tunnel', ['ringThick']),
  {
    id: 'ringThick', section: 'tunnel', label: 'Line thickness', kind: 'slider',
    summaryLabel: 'Thickness',
    parent: 'tunnelStyleDrawer',
    min: 0.2, max: 5, step: 0.1, def: 3,
    get: S => S.ringThick,
    set: (S, pos) => { S.ringThick = pos; save(); },
    format: S => S.ringThick.toFixed(1) + '×'
  },
  {
    id: 'ringThickVar', section: 'tunnel', label: 'Line thickness variance', kind: 'slider',
    varianceOf: 'ringThick',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.ringThickVar * 100),
    // Existing rings keep the thickness factor they were born with (see
    // emitRing in js/sim.js), so, exactly as in v0, a change here only shows
    // up as new rings arrive; reseeding would make the whole tunnel jump.
    set: (S, pos) => { S.ringThickVar = pos / 100; save(); },
    format: S => Math.round(S.ringThickVar * 100) + '%'
  },

  // ---------- Edge ----------
  sectionToggle('edgeOn', 'edge', 'edge', 'On'),
  {
    // Scales the whole edge's brightness, whichever effect it shows.
    id: 'edgeOpacity', section: 'edge', label: 'Edge opacity', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.edgeOpacity * 100),
    set: (S, pos) => { S.edgeOpacity = pos / 100; save(); },
    format: S => Math.round(S.edgeOpacity * 100) + '%'
  },
  // The opacity breathes on the app's standard: over one rate cycle it
  // eases from the setting down by this share and back, never above it.
  ...varianceRows('edgeOpacity', {
    name: 'Opacity',
    effective: S => (S.effEdgeOpacity ?? S.edgeOpacity ?? 1) * 100
  }),
  {
    // How much the edge breathes with the strobe's flicker, whichever effect
    // it shows: at 100% it dips with every flash as it always has, lower
    // only part of the way, and at 0 it is a steady edge at full strength.
    // It scales how far the brightness departs from steady, never the
    // steady level itself, and pausing still settles it as before.
    id: 'edgePulse', section: 'edge', label: 'Pulse with strobe', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(edgePulse(S) * 100),
    set: (S, pos) => { S.edgePulse = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => edgePulse(S) === 0 ? 'never flickers' : Math.round(edgePulse(S) * 100) + '%'
  },
  // The pulse's dip, the app's standard: over one rate cycle the edge's
  // breathing eases from the setting down by this share and back, never
  // deeper than the setting asks. At 0 the pulse holds where it is set. The
  // bar glows with the very number core/strobe.js leaves in S.effEdgePulse
  // for the edge to draw with this frame, so the bar and the edge never
  // disagree.
  ...varianceRows('edgePulse', {
    labels: ['Pulse variance', 'Pulse variance rate'],
    effective: S => typeof S.effEdgePulse === 'number' ? S.effEdgePulse * 100 : undefined,
    rows: { amount: { set: (S, pos) => { S.edgePulseVar = Math.max(0, Math.min(1, pos / 100)); save(); } } }
  }),
  {
    // The edge's effect (gpu/scene.js). Surfing is the particles walking
    // the perimeter with their tails, as the edge always was; Particles,
    // Flame and Glow are the three in gpu/edge-fx.js. Each effect's own rows
    // show only while it is chosen: Surfing's are the Motion and Style
    // drawers below, the others' sit straight under this row. Opacity and
    // Feedback belong to the layer, whichever effect it shows. A change
    // crossfades (scene.js): over a preset's glide or a journey step's ramp
    // when one is under way, else over a third of a second.
    id: 'edgeMode', section: 'edge', label: 'Effect', kind: 'segment', def: 'surfing',
    hideLabel: true,
    options: [
      { value: 'surfing',   label: 'Surfing',   domId: null },
      { value: 'particles', label: 'Particles', domId: null },
      { value: 'flame',     label: 'Flame',     domId: null },
      { value: 'glow',      label: 'Glow',      domId: null }
    ],
    get: S => edgeMode(S),
    set: (S, v) => { S.edgeMode = EDGE_MODES.indexOf(v) >= 0 ? v : 'surfing'; save(); },
    format: S => edgeMode(S)
  },
  // Particles: sparks born evenly along the border, fading over their short
  // life.
  {
    // Sparks born a second, round the whole perimeter.
    id: 'edgePartRate', section: 'edge', label: 'Rate', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'particles',
    min: 5, max: 500, step: 5, def: 120,
    get: S => S.edgePartRate,
    set: (S, pos) => { S.edgePartRate = Math.max(5, Math.min(500, pos)); save(); },
    format: S => S.edgePartRate + ' / s'
  },
  {
    // A spark's radius, css px, before each one's own spread of it.
    id: 'edgePartSize', section: 'edge', label: 'Size', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'particles',
    min: 0.5, max: 8, step: 0.1, def: 2,
    get: S => S.edgePartSize,
    set: (S, pos) => { S.edgePartSize = Math.max(0.5, Math.min(8, pos)); save(); },
    format: S => S.edgePartSize.toFixed(1) + ' px'
  },
  {
    // How fast the sparks drift in toward the centre, alike on every side.
    // At 0 they stay where they are born and only wander a little along
    // the border. Outward went nowhere (a spark born on the border leaves
    // the screen at once), so the slider only goes in; S keeps the sign
    // convention the shader reads (negative is inward).
    id: 'edgePartDrift', section: 'edge', label: 'Drift', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'particles',
    min: 0, max: 100, step: 1, def: 35,
    get: S => Math.round(-S.edgePartDrift * 100),
    set: (S, pos) => { S.edgePartDrift = -Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => !S.edgePartDrift ? 'none' : Math.round(-S.edgePartDrift * 100) + '% in'
  },
  {
    // Each spark twinkling on its own, as a firework's sparks crackle; 0 is
    // a steady fade.
    id: 'edgePartSparkle', section: 'edge', label: 'Sparkle', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'particles',
    min: 0, max: 100, step: 1, def: 50,
    get: S => Math.round(S.edgePartSparkle * 100),
    set: (S, pos) => { S.edgePartSparkle = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round(S.edgePartSparkle * 100) + '%'
  },
  // Flame: licks rising in off all four borders, as if the frame were
  // quietly burning.
  {
    // How far in the licks reach at most, css px.
    id: 'edgeFlameHeight', section: 'edge', label: 'Height', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'flame',
    min: 8, max: 240, step: 1, def: 56,
    get: S => S.edgeFlameHeight,
    set: (S, pos) => { S.edgeFlameHeight = Math.max(8, Math.min(240, pos)); save(); },
    format: S => Math.round(S.edgeFlameHeight) + ' px'
  },
  {
    // How fast the flames flicker and climb.
    id: 'edgeFlameSpeed', section: 'edge', label: 'Speed', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'flame',
    min: 0.1, max: 3, step: 0.05, def: 1,
    get: S => S.edgeFlameSpeed,
    set: (S, pos) => { S.edgeFlameSpeed = Math.max(0.1, Math.min(3, pos)); save(); },
    format: S => S.edgeFlameSpeed.toFixed(2) + '×'
  },
  {
    // How rough the flames are: at 0 smooth rounded tongues, at 100% ragged
    // and broken, their noise warped sideways.
    id: 'edgeFlameTurb', section: 'edge', label: 'Turbulence', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'flame',
    min: 0, max: 100, step: 1, def: 50,
    get: S => Math.round(S.edgeFlameTurb * 100),
    set: (S, pos) => { S.edgeFlameTurb = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round(S.edgeFlameTurb * 100) + '%'
  },
  // Glow: a soft band of light hugging the border.
  {
    // How far in the band reaches, css px.
    id: 'edgeGlowWidth', section: 'edge', label: 'Width', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'glow',
    min: 2, max: 200, step: 1, def: 28,
    get: S => S.edgeGlowWidth,
    set: (S, pos) => { S.edgeGlowWidth = Math.max(2, Math.min(200, pos)); save(); },
    format: S => Math.round(S.edgeGlowWidth) + ' px'
  },
  {
    // How the light falls away inward from the screen's edge, where it is
    // always at full: at 0 a crisp bright rim that drops fast, at 100% a
    // long smooth decay across the whole width.
    id: 'edgeGlowSoft', section: 'edge', label: 'Softness', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'glow',
    min: 0, max: 100, step: 1, def: 60,
    get: S => Math.round(S.edgeGlowSoft * 100),
    set: (S, pos) => { S.edgeGlowSoft = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round(S.edgeGlowSoft * 100) + '%'
  },
  {
    // A slow swell: once a Breathe rate the glow dims by this much and
    // comes back, the same down-and-back as the variances. A breath, not a
    // flash; the glow still flickers with the strobe as the edge does.
    id: 'edgeGlowBreathe', section: 'edge', label: 'Breathe', kind: 'slider',
    tip: 'A slow swell of the glow; 0 holds it steady.',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'glow',
    min: 0, max: 100, step: 1, def: 40,
    get: S => Math.round(S.edgeGlowBreathe * 100),
    set: (S, pos) => { S.edgeGlowBreathe = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round(S.edgeGlowBreathe * 100) + '%'
  },
  {
    id: 'edgeGlowBreatheRate', section: 'edge', label: 'Breathe rate', kind: 'slider',
    parent: 'edgeMode', visible: S => edgeMode(S) === 'glow',
    min: 1, max: 60, step: 1, def: 8,
    get: S => S.edgeGlowBreatheRate,
    set: (S, pos) => { S.edgeGlowBreatheRate = Math.max(1, Math.min(60, pos)); save(); },
    format: S => S.edgeGlowBreatheRate + 's / cycle'
  },
  // ---- Surfing's two sub-drawers, Motion and Style (see subDrawer), each
  // with its rows straight after it, shown only while Surfing is the effect
  // (drawer.js hides a sub-drawer by its own visible rule, rows and all) ----
  Object.assign(subDrawer('edgeMotionDrawer', 'Motion', 'edge', ['edgeSpeed', 'edgeDir']), { visible: surfing }),
  {
    id: 'edgeSpeed', section: 'edge', label: 'Edge speed', kind: 'slider',
    summaryLabel: 'Speed',
    parent: 'edgeMotionDrawer',
    min: 0, max: 6, step: 0.1, def: 4,
    get: S => S.edgeSpeedMul,
    set: (S, pos) => { S.edgeSpeedMul = pos; save(); },
    format: S => S.edgeSpeedMul.toFixed(1) + '×'
  },
  ...varianceRows('edgeSpeed', {
    name: 'Edge speed', amountDef: 50, periodDef: 22,
    effective: S => S.effEdgeSpeed
  }),
  {
    // A native <select> in v0, not a button row, so there is no per-option
    // DOM id to hand out; the options below exist for the toolkit's segment
    // widget, and byDomId only ever matches this control's own id ('edgeDir'),
    // never one of its options.
    id: 'edgeDir', section: 'edge', label: 'Edge rotation', kind: 'segment', def: 'both',
    hideLabel: true,
    summaryLabel: 'Rotation',
    parent: 'edgeMotionDrawer',
    options: [
      { value: 'cw',   label: 'Clockwise',          domId: null },
      { value: 'ccw',  label: 'Counter clockwise',   domId: null },
      { value: 'both', label: 'Both',                domId: null }
    ],
    get: S => S.edgeDir,
    set: (S, v) => { S.edgeDir = v; applyEdgeDir(); save(); }
  },
  Object.assign(subDrawer('edgeStyleDrawer', 'Style', 'edge', ['edgeCount', 'edgeSize']), { visible: surfing }),
  {
    id: 'edgeCount', section: 'edge', label: 'Edge density', kind: 'slider',
    summaryLabel: 'Density',
    parent: 'edgeStyleDrawer',
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
    summaryLabel: 'Size',
    parent: 'edgeStyleDrawer',
    min: 0.1, max: 20, step: 0.1, def: 3,
    get: S => S.edgeSize / 2,
    set: (S, pos) => { S.edgeSize = pos * 2; save(); },
    format: S => (S.edgeSize / 2).toFixed(1) + '×'
  },
  ...varianceRows('edgeSize', {
    name: 'Edge size', amountDef: 50, periodDef: 18,
    effective: S => S.effEdgeSize / 2
  }),
  {
    id: 'trailLen', section: 'edge', label: 'Trail length', kind: 'slider',
    parent: 'edgeStyleDrawer',
    min: 0.2, max: 6, step: 0.1, def: 1,
    get: S => S.trailMul,
    set: (S, pos) => { S.trailMul = pos; save(); },
    format: S => S.trailMul.toFixed(1) + '×'
  },
  {
    // The particle's leading tip (gpu/scene-data.js's buildEdge). v1 only,
    // so no v0 button ids.
    id: 'edgeCap', section: 'edge', label: 'Head shape', kind: 'segment', def: 'wedge',
    hideLabel: true,
    parent: 'edgeStyleDrawer',
    options: [
      { value: 'wedge', label: 'Wedge',   domId: null },
      { value: 'round', label: 'Rounded', domId: null },
      { value: 'ball',  label: 'Ball',    domId: null }
    ],
    get: S => S.edgeCap === 'ball' || S.edgeCap === 'round' ? S.edgeCap : 'wedge',
    set: (S, v) => { S.edgeCap = v === 'ball' || v === 'round' ? v : 'wedge'; save(); },
    format: S => S.edgeCap === 'ball' || S.edgeCap === 'round' ? S.edgeCap : 'wedge'
  },
  // Video feedback on the edge (gpu/scene.js), in a sub-drawer of its
  // own as the Confetti layer's. Shut, its strip shows the amount and the
  // Stream.
  subDrawer('edgeFeedbackDrawer', 'Feedback', 'edge', ['edgeFb', 'edgeFbStream']),
  {
    // How strongly the trails show: at 50% they are half as bright, at 0
    // gone. It thins the trails only; the live edge never dims with it (the
    // edge is drawn straight into the scene for the share the trails give
    // up, gpu/scene.js). It never changes the trails inside the image
    // either, so they build and fade the same at any setting, and turning it
    // back up shows them as they are now. 100% is the trails in full.
    id: 'edgeFbOpacity', section: 'edge', label: 'Opacity', kind: 'slider',
    parent: 'edgeFeedbackDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((typeof S.edgeFbOpacity === 'number' ? S.edgeFbOpacity : 1) * 100),
    set: (S, pos) => { S.edgeFbOpacity = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round((typeof S.edgeFbOpacity === 'number' ? S.edgeFbOpacity : 1) * 100) + '%'
  },
  {
    // For softening the edge: each frame keeps a fading copy of the last,
    // so every particle leaves a glowing trail behind it and the hard line
    // of the edge melts into streaks of light. At 0 there is no trail, the
    // edge as it always was; at 100% a trail takes about two seconds to fade
    // to half, and in between the time grows with the square of the slider,
    // so the low end is fine grained.
    id: 'edgeFb', section: 'edge', label: 'Amount', kind: 'slider',
    parent: 'edgeFeedbackDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.edgeFb || 0) * 100),
    set: (S, pos) => { S.edgeFb = Math.max(0, Math.min(1, pos / 100)); save(); },
    format: S => Math.round((S.edgeFb || 0) * 100) + '%'
  },
  {
    // The trails' own motion: each frame's faded copy is taken a little
    // larger or smaller about the field centre, so the trails stream out
    // toward the screen's edges or in toward the centre, alike in every
    // direction. Nothing moves at an Amount of 0, since there is no trail.
    id: 'edgeFbStream', section: 'edge', label: 'Stream', kind: 'slider',
    parent: 'edgeFeedbackDrawer',
    min: -2, max: 2, step: 0.01, def: 0,
    get: S => S.edgeFbStream || 0,
    set: (S, pos) => { S.edgeFbStream = Math.max(-2, Math.min(2, pos)); save(); },
    format: S => !S.edgeFbStream ? 'none'
      : (S.edgeFbStream > 0 ? '+' + S.edgeFbStream.toFixed(2) + ' out' : S.edgeFbStream.toFixed(2) + ' in')
  },
  {
    // And turned a little about the centre each frame, so the trails swirl.
    id: 'edgeFbTwist', section: 'edge', label: 'Twist', kind: 'slider',
    parent: 'edgeFeedbackDrawer',
    min: -1, max: 1, step: 0.01, def: 0,
    get: S => S.edgeFbTwist || 0,
    set: (S, pos) => { S.edgeFbTwist = Math.max(-1, Math.min(1, pos)); save(); },
    format: S => !S.edgeFbTwist ? 'none'
      : (S.edgeFbTwist > 0 ? '+' + S.edgeFbTwist.toFixed(2) + ' clockwise' : S.edgeFbTwist.toFixed(2) + ' counter')
  },

  // ---------- Text ----------
  // Same switch as lText above (S.layers.text), shown a second time here
  // because v0 shows it a second time here: the pair of buttons at the top
  // of the Text group, which in v0 route through $('lText').click() so the
  // checkbox stays the one owner. This entry reaches the same state directly
  // instead, since there is no checkbox in v1 to click through.
  {
    id: 'textOn', section: 'text', label: 'Words', kind: 'segment', def: true,
    hideLabel: true,
    options: [
      { value: true,  label: 'On',  domId: 'txOn'  },
      { value: false, label: 'Off', domId: 'txOff' }
    ],
    get: S => !!S.layers.text,
    set: (S, on) => { S.layers.text = on; save(); },
    format: S => S.layers.text ? 'on' : 'off'
  },
  {
    // Individual words draw from the themed pool below; affirmations swap
    // in whole phrases (js/words.js's AFFIRMATIONS) and the themes step
    // aside, since that set is its own theme.
    // Custom shows the viewer's own phrases (the row below), in the order
    // typed; a journey step's text arrives through the same two controls.
    id: 'textMode', section: 'text', label: 'Text', kind: 'segment', def: 'words',
    hideLabel: true,
    options: [
      { value: 'words',        label: 'Words',        domId: 'txModeWords' },
      { value: 'affirmations', label: 'Affirmations', domId: 'txModeAff' },
      { value: 'custom',       label: 'Custom',       domId: null }
    ],
    get: S => S.textMode,
    set: (S, v) => { S.textMode = v; rebuildWordPool(); save(); },
    format: S => S.textMode === 'affirmations' ? 'affirmations'
               : S.textMode === 'custom' ? 'custom phrases' : 'individual words'
  },
  {
    // The Custom source's phrases, one line with a '|' between them, and a
    // '/' inside a phrase breaking its line there (core/words.js). A text
    // row (widgets.js), so it has no position a snapshot or the audio link
    // diffs; it persists in v1's extra record (store.js) and a preset's
    // replay rebuilds the pool from it at the end.
    id: 'textCustomText', section: 'text', label: 'Phrases', kind: 'text',
    parent: 'textMode',
    placeholder: 'One phrase / on two lines | another phrase', maxLen: 2000,
    tip: 'Phrases separated by "|", shown in order; "/" breaks a line',
    visible: S => S.textMode === 'custom',
    get: S => typeof S.textCustomText === 'string' ? S.textCustomText : '',
    set: (S, v) => { S.textCustomText = String(v); rebuildWordPool(); save(); }
  },
  {
    // The time between one Custom phrase leaving and the next arriving, in
    // place of the Timing drawer's roll and rests (core/words.js). Far left
    // is Auto, the roll as always; -0.5, which the half-second step can land
    // on, is Auto too, taken to -1 so there is one Auto. A journey step can
    // hold it like any slider (the Journey window's GAP line).
    id: 'textPhraseGap', section: 'text', label: 'Phrase gap', kind: 'slider',
    parent: 'textMode',
    min: -1, max: 30, step: 0.5, def: -1,
    visible: S => S.textMode === 'custom',
    get: S => S.textPhraseGap >= 0 ? S.textPhraseGap : -1,
    set: (S, pos) => { S.textPhraseGap = pos < 0 ? -1 : pos; save(); },
    format: S => S.textPhraseGap >= 0 ? S.textPhraseGap + ' s' : 'auto'
  },
  // ---- three sub-drawers, Timing, Styling and Fades (see subDrawer), each
  // with its rows straight after it, then the themes at the section's level ----
  subDrawer('textRateDrawer', 'Timing', 'text', ['textFreq', 'textAppearPerMin', 'textDwell']),
  {
    id: 'textLink', section: 'text', label: 'Blink source', kind: 'segment', def: true,
    hideLabel: true,
    parent: 'textRateDrawer',
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
    // Whether a word's chance rolls per strobe tick (so 40 Hz offers forty
    // chances a second) or holds a set pace in words per minute whatever
    // the frequency.
    id: 'textAppearMode', section: 'text', label: 'Appearance timing', kind: 'segment', def: 'frame',
    hideLabel: true,
    parent: 'textRateDrawer',
    options: [
      { value: 'frame', label: 'By frame', domId: null },
      { value: 'time',  label: 'By time',  domId: null }
    ],
    get: S => S.textAppearMode || 'frame',
    set: (S, v) => { S.textAppearMode = v; save(); },
    format: S => S.textAppearMode === 'time' ? 'by time' : 'by frame'
  },
  {
    id: 'textAppearPerMin', section: 'text', label: 'Appearance rate', kind: 'slider',
    summaryLabel: 'Rate',
    // In By time mode this row shows in Appearance's place, so it wears
    // Appearance's variance chevron (drawer.js varianceProxy) and the
    // variance folds out beneath it.
    varianceProxy: 'textFreq',
    parent: 'textRateDrawer',
    min: 1, max: 60, step: 1, def: 10,
    visible: S => S.textAppearMode === 'time',
    get: S => S.textAppearPerMin,
    set: (S, pos) => { S.textAppearPerMin = pos; save(); },
    format: S => S.textAppearPerMin + ' / min'
  },
  {
    id: 'textFreq', section: 'text', label: 'Appearance', kind: 'slider',
    summaryLabel: 'Appear',
    parent: 'textRateDrawer',
    visible: S => S.textAppearMode !== 'time',
    min: 0, max: 100, step: 1, def: 50,
    get: S => Math.round(S.textFreq * 100),
    set: (S, pos) => { S.textFreq = pos / 100; save(); },
    format: S => Math.round(S.textFreq * 100) + '%'
  },
  {
    id: 'textRandom', section: 'text', label: 'Appearance variance', kind: 'slider',
    varianceOf: 'textFreq',
    parent: 'textRateDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.textRandom * 100),
    set: (S, pos) => { S.textRandom = pos / 100; save(); },
    format: S => Math.round(S.textRandom * 100) + '%'
  },
  {
    id: 'textRestFreq', section: 'text', label: 'Rest frequency', kind: 'slider',
    parent: 'textRateDrawer',
    min: 0, max: 100, step: 1, def: 4,
    get: S => Math.round(S.textRestFreq * 100),
    set: (S, pos) => { S.textRestFreq = pos / 100; save(); },
    format: S => Math.round(S.textRestFreq * 100) + '%'
  },
  {
    id: 'textRestSec', section: 'text', label: 'Rest duration', kind: 'slider',
    parent: 'textRateDrawer',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.textRestSec,
    set: (S, pos) => { S.textRestSec = pos; save(); },
    format: S => S.textRestSec + 's'
  },
  {
    id: 'textRestVar', section: 'text', label: 'Rest variance', kind: 'slider',
    varianceOf: 'textRestSec',
    parent: 'textRateDrawer',
    min: 0, max: 100, step: 1, def: 70,
    get: S => Math.round(S.textRestVar * 100),
    set: (S, pos) => { S.textRestVar = pos / 100; save(); },
    format: S => Math.round(S.textRestVar * 100) + '%'
  },
  {
    // 0 is no hold at all: the word starts fading out the moment it has
    // faded in (core/words.js). Up to 10 s, the fades' own reach.
    id: 'textDwell', section: 'text', label: 'Time on screen', kind: 'slider',
    summaryLabel: 'Dwell',
    parent: 'textRateDrawer',
    min: 0, max: 10000, step: 10, def: 80,
    get: S => S.textDwellMs,
    set: (S, pos) => { S.textDwellMs = pos; save(); },
    format: S => S.textDwellMs + ' ms'
  },
  {
    id: 'textDwellVar', section: 'text', label: 'Duration variance', kind: 'slider',
    varianceOf: 'textDwell',
    parent: 'textRateDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round(S.textDwellVar * 100),
    set: (S, pos) => { S.textDwellVar = pos / 100; save(); },
    format: S => Math.round(S.textDwellVar * 100) + '%'
  },
  subDrawer('textStylingDrawer', 'Styling', 'text', ['textSize', 'textOpacity']),
  {
    // v0's set() also calls recentreWord(), which re-measures the DOM word
    // element's ink offset at the new font size. The SDF text system
    // (gpu/text-atlas.js) measures exact glyph advances on every draw, so
    // per ARCHITECTURE.md's Words section the whole ink-centring hack is
    // unnecessary in v1; there is nothing for this control to call instead.
    id: 'textSize', section: 'text', label: 'Word size', kind: 'slider',
    summaryLabel: 'Size',
    parent: 'textStylingDrawer',
    min: 16, max: 160, step: 1, def: 35,
    get: S => S.textSize,
    set: (S, pos) => { S.textSize = pos; save(); },
    format: S => S.textSize + ' px'
  },
  {
    id: 'textColorMode', section: 'text', label: 'Word color', kind: 'segment', def: 'system',
    hideLabel: true,
    parent: 'textStylingDrawer',
    options: [
      { value: 'white',  label: 'White',              domId: 'txWhite'  },
      { value: 'system', label: 'Match the strobe',    domId: 'txSystem' }
    ],
    get: S => S.textColorMode,
    set: (S, v) => { S.textColorMode = v; save(); },
    format: S => S.textColorMode === 'system' ? 'match the strobe' : 'white'
  },
  {
    // Lifts a strobe-coloured word toward white so it pops off the field.
    id: 'textBrighten', section: 'text', label: 'Brighten', kind: 'slider',
    parent: 'textStylingDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round(S.textBrighten * 100),
    set: (S, pos) => { S.textBrighten = pos / 100; save(); },
    format: S => Math.round(S.textBrighten * 100) + '%',
    visible: S => S.textColorMode === 'system'
  },
  {
    id: 'textOpacity', section: 'text', label: 'Opacity', kind: 'slider',
    summaryLabel: 'Opacity',
    parent: 'textStylingDrawer',
    min: 0, max: 100, step: 1, def: 95,
    get: S => Math.round(S.textOpacity * 100),
    set: (S, pos) => { S.textOpacity = pos / 100; save(); },
    format: S => Math.round(S.textOpacity * 100) + '%'
  },
  // In a running word walk a change of rate is folded into the dip's phase
  // offset first (core/words.js retimeWordOpacity), so it carries on from
  // where it is at the new rate instead of jumping. The walk steps the
  // phase (core/words.js); the bar reads it here.
  ...varianceRows('textOpacity', {
    name: 'Opacity', amountDef: 10, parent: 'textStylingDrawer', retime: retimeWordOpacity,
    effective: S => varied(S.textOpacity, S.textOpacityVar, S.textOpacityPhase) * 100
  }),
  {
    // The one wrap control: how wide a line may run, as a share of the
    // view. A phrase breaks (only ever between words) into balanced,
    // centred lines that each fit inside it.
    id: 'textLineWidth', section: 'text', label: 'Line width', kind: 'slider',
    parent: 'textStylingDrawer',
    min: 20, max: 100, step: 1, def: 92,
    get: S => Math.round((S.textLineWidth ?? 0.92) * 100),
    set: (S, pos) => { S.textLineWidth = pos / 100; save(); },
    format: S => Math.round((S.textLineWidth ?? 0.92) * 100) + '%'
  },
  {
    // On, a phrase with smart breaks marked in js/affirmations.js breaks
    // there, a line per piece and each line one complete idea; a piece too
    // wide for the Line width still wraps inside itself. Off, or for a
    // phrase with none marked, the plain balanced wrap.
    id: 'textSmartBreaks', section: 'text', label: 'Smart line breaks', kind: 'toggle', def: true,
    parent: 'textStylingDrawer',
    visible: S => S.textMode === 'affirmations',
    get: S => S.textSmartBreaks !== false,
    set: (S, on) => { S.textSmartBreaks = !!on; save(); },
    format: S => S.textSmartBreaks !== false ? 'On' : 'Off'
  },
  {
    // Off, a wrapped block transitions line by line — the first line
    // arrives, then the second, each reading left to right. On, the whole
    // block fades as one.
    id: 'textLinesTogether', section: 'text', label: 'Fade lines together', kind: 'toggle', def: false,
    parent: 'textStylingDrawer',
    get: S => !!S.textLinesTogether,
    set: (S, on) => { S.textLinesTogether = !!on; save(); },
    format: S => S.textLinesTogether ? 'On' : 'Off'
  },
  // ---- the words' backing, its own drawer: two ways to help the letters
  // hold their own over a busy scene (ui/screens/overlay.js), each off at 0
  // and each with its own opacity ----
  {
    // The shadow's switch, on its strip: a quick A/B of the scene with and
    // without it. Off greys the rows below rather than hiding them, so the
    // settings stay in sight and come back as left.
    id: 'textShadowOn', section: 'text', label: 'Shadow', kind: 'toggle', def: true,
    get: S => S.textShadowOn !== false,
    set: (S, on) => { S.textShadowOn = !!on; save(); },
    format: S => S.textShadowOn !== false ? 'On' : 'Off'
  },
  subDrawer('textShadowDrawer', 'Shadow', 'text', ['textShadowO'], 'textShadowOn'),
  {
    // A black copy of every letter directly behind it, following each
    // transition letter for letter. It darkens what shows through a soft or
    // faint letter and haloes the edge. A record from before either of
    // these controls reads as 0.
    id: 'textShadowO', section: 'text', label: 'Opacity', kind: 'slider',
    summaryLabel: 'Opacity',
    parent: 'textShadowDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.textShadowO || 0) * 100),
    set: (S, pos) => { S.textShadowO = pos / 100; save(); },
    format: S => Math.round((S.textShadowO || 0) * 100) + '%',
    enabled: S => S.textShadowOn !== false
  },
  {
    // How far the shadow softens past the letter's edge, on top of the little
    // it always has, up to the most the glyph shader allows (ui/screens/overlay.js).
    id: 'textShadowBlur', section: 'text', label: 'Blur', kind: 'slider',
    parent: 'textShadowDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.textShadowBlur || 0) * 100),
    set: (S, pos) => { S.textShadowBlur = pos / 100; save(); },
    format: S => Math.round((S.textShadowBlur || 0) * 100) + '%',
    enabled: S => S.textShadowOn !== false
  },
  {
    // How far the dark copies swell past the letters' edges, evenly all
    // round, up to a quarter more letter (ui/screens/overlay.js).
    id: 'textShadowSize', section: 'text', label: 'Size', kind: 'slider',
    parent: 'textShadowDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.textShadowSize || 0) * 100),
    set: (S, pos) => { S.textShadowSize = pos / 100; save(); },
    format: S => Math.round((S.textShadowSize || 0) * 100) + '%',
    enabled: S => S.textShadowOn !== false
  },
  {
    // The shadow's own arrival: it eases in over this once a word appears.
    // 0 follows the letters exactly, as before (ui/screens/overlay.js).
    id: 'textShadowFadeIn', section: 'text', label: 'Fade in', kind: 'slider',
    parent: 'textShadowDrawer',
    min: 0, max: 2000, step: 50, def: 0,
    get: S => S.textShadowFadeInMs || 0,
    set: (S, pos) => { S.textShadowFadeInMs = pos; save(); },
    format: S => (S.textShadowFadeInMs || 0) + ' ms',
    enabled: S => S.textShadowOn !== false
  },
  {
    // And its leaving: from the moment the word starts out, the shadow
    // sinks over this. 0 rides the letters out, as before.
    id: 'textShadowFadeOut', section: 'text', label: 'Fade out', kind: 'slider',
    parent: 'textShadowDrawer',
    min: 0, max: 2000, step: 50, def: 0,
    get: S => S.textShadowFadeOutMs || 0,
    set: (S, pos) => { S.textShadowFadeOutMs = pos; save(); },
    format: S => (S.textShadowFadeOutMs || 0) + ' ms',
    enabled: S => S.textShadowOn !== false
  },
  {
    // The panel's switch, on its strip, the shadow's twin above.
    id: 'textPanelOn', section: 'text', label: 'Panel', kind: 'toggle', def: true,
    get: S => S.textPanelOn !== false,
    set: (S, on) => { S.textPanelOn = !!on; save(); },
    format: S => S.textPanelOn !== false ? 'On' : 'Off'
  },
  subDrawer('textPanelDrawer', 'Panel', 'text', ['textPanelO'], 'textPanelOn'),
  {
    // A rounded black block behind the letters, filling in as they arrive
    // and gone with the last of them, so it never sits on an empty screen.
    id: 'textPanelO', section: 'text', label: 'Opacity', kind: 'slider',
    summaryLabel: 'Opacity',
    parent: 'textPanelDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.textPanelO || 0) * 100),
    set: (S, pos) => { S.textPanelO = pos / 100; save(); },
    format: S => Math.round((S.textPanelO || 0) * 100) + '%',
    enabled: S => S.textPanelOn !== false
  },
  {
    // The panel's margin past the letters: a sliver at 0, the full wide
    // pad at 100% (ui/screens/overlay.js).
    id: 'textPanelSize', section: 'text', label: 'Size', kind: 'slider',
    parent: 'textPanelDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round((S.textPanelSize ?? 1) * 100),
    set: (S, pos) => { S.textPanelSize = pos / 100; save(); },
    format: S => Math.round((S.textPanelSize ?? 1) * 100) + '%',
    enabled: S => S.textPanelOn !== false
  },
  {
    // Soft edges melt the panel's rim into the scene: the hard rounded rect
    // gives way to a true Gaussian of the same box, up to half an em wide
    // (ui/screens/overlay.js).
    id: 'textPanelSoft', section: 'text', label: 'Soft edges', kind: 'slider',
    parent: 'textPanelDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: S => Math.round((S.textPanelSoft || 0) * 100),
    set: (S, pos) => { S.textPanelSoft = pos / 100; save(); },
    format: S => Math.round((S.textPanelSoft || 0) * 100) + '%',
    enabled: S => S.textPanelOn !== false
  },
  {
    // On, each line of a phrase gets a panel of its own, as wide as that
    // line's letters ask; off, one panel spans the whole block
    // (ui/screens/overlay.js).
    id: 'textPanelPerLine', section: 'text', label: 'Vary per line', kind: 'toggle', def: false,
    parent: 'textPanelDrawer',
    get: S => S.textPanelPerLine === true,
    set: (S, on) => { S.textPanelPerLine = !!on; save(); },
    format: S => S.textPanelPerLine === true ? 'On' : 'Off',
    enabled: S => S.textPanelOn !== false
  },
  {
    // The panel's arrival, the shadow's fade in above but its own time.
    id: 'textPanelFadeIn', section: 'text', label: 'Fade in', kind: 'slider',
    parent: 'textPanelDrawer',
    min: 0, max: 2000, step: 50, def: 0,
    get: S => S.textPanelFadeInMs || 0,
    set: (S, pos) => { S.textPanelFadeInMs = pos; save(); },
    format: S => (S.textPanelFadeInMs || 0) + ' ms',
    enabled: S => S.textPanelOn !== false
  },
  {
    // And its leaving, from the word's first step out.
    id: 'textPanelFadeOut', section: 'text', label: 'Fade out', kind: 'slider',
    parent: 'textPanelDrawer',
    min: 0, max: 2000, step: 50, def: 0,
    get: S => S.textPanelFadeOutMs || 0,
    set: (S, pos) => { S.textPanelFadeOutMs = pos; save(); },
    format: S => (S.textPanelFadeOutMs || 0) + ' ms',
    enabled: S => S.textPanelOn !== false
  },
  subDrawer('textFadesDrawer', 'Fades', 'text', ['textFadeIn', 'textFadeOut']),
  {
    // Phrases only (affirmations or custom). When a block's lines arrive or leave one after
    // another, the rest between one line visibly landing and the next
    // visibly starting (core/word-fx.js lineStep): 0 back to back, 100% a
    // rest as long as a line's transition. The fade time stays the whole
    // block's, so a longer pause gives each line a shorter share of it.
    // Nothing to do when the lines fade together.
    id: 'textLinePause', section: 'text', label: 'Line pause', kind: 'slider',
    summaryLabel: 'Pause',
    parent: 'textFadesDrawer',
    min: 0, max: 100, step: 1, def: 0,
    visible: S => phraseMode(S),
    get: S => Math.round((S.textLinePause || 0) * 100),
    set: (S, pos) => { S.textLinePause = pos / 100; save(); },
    format: S => Math.round((S.textLinePause || 0) * 100) + '%'
  },
  // ---- fade in and fade out, each with its transition (core/word-fx.js) ----
  // Each side is a switch with everything it governs listed under it: the
  // time, then the effect the letters play across that time and the effect's
  // own settings. Off, the word just appears or disappears, as at 0 ms.
  {
    id: 'textFadeInOn', section: 'text', label: 'Fade in', kind: 'toggle', def: true,
    parent: 'textFadesDrawer',
    get: fadeInOn,
    set: (S, on) => { S.textFadeInOn = !!on; save(); },
    format: S => fadeInOn(S) ? 'On' : 'Off'
  },
  {
    id: 'textFadeIn', section: 'text', label: 'Duration', kind: 'slider', parent: 'textFadeInOn',
    summaryLabel: 'In',
    min: 0, max: 10000, step: 50, def: 0,
    visible: fadeInOn,
    get: S => S.textFadeInMs,
    set: (S, pos) => { S.textFadeInMs = pos; save(); },
    format: S => S.textFadeInMs + ' ms'
  },
  // Each word rolls its own fade time as it appears: the slider above is the
  // cap, and the variance is how far below it the roll may land.
  {
    id: 'textFadeInVar', section: 'text', label: 'Duration variance', kind: 'slider', parent: 'textFadeInOn',
    varianceOf: 'textFadeIn',
    min: 0, max: 100, step: 1, def: 0,
    visible: fadeInOn,
    get: S => Math.round(S.textFadeInVar * 100),
    set: (S, pos) => { S.textFadeInVar = pos / 100; save(); },
    format: S => Math.round(S.textFadeInVar * 100) + '%'
  },
  {
    // Phrases only (affirmations or custom). On, a multi-line block arrives as one; off, line
    // by line, the same switch Fade out has for departures.
    id: 'textLinesTogetherIn', section: 'text', label: 'Lines fade in together', kind: 'toggle', def: false,
    parent: 'textFadeInOn',
    visible: S => fadeInOn(S) && phraseMode(S),
    get: S => !!S.textLinesTogetherIn,
    set: (S, on) => { S.textLinesTogetherIn = !!on; save(); },
    format: S => S.textLinesTogetherIn ? 'On' : 'Off'
  },
  {
    id: 'textFxIn', section: 'text', label: 'Arrive', kind: 'segment', def: 'gather', parent: 'textFadeInOn',
    dropdown: true,
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
    parent: 'textFadesDrawer',
    visible: fadeOutOn,
    get: S => !!S.textFxMirror,
    set: (S, on) => { S.textFxMirror = !!on; save(); },
    format: S => S.textFxMirror ? 'On' : 'Off'
  },
  {
    id: 'textFadeOutOn', section: 'text', label: 'Fade out', kind: 'toggle', def: true,
    parent: 'textFadesDrawer',
    get: fadeOutOn,
    set: (S, on) => { S.textFadeOutOn = !!on; save(); },
    format: S => fadeOutOn(S) ? 'On' : 'Off'
  },
  {
    id: 'textFadeOut', section: 'text', label: 'Duration', kind: 'slider', parent: 'textFadeOutOn',
    summaryLabel: 'Out',
    min: 0, max: 10000, step: 50, def: 0,
    visible: fadeOutOn,
    get: S => S.textFadeOutMs,
    set: (S, pos) => { S.textFadeOutMs = pos; save(); },
    format: S => S.textFadeOutMs + ' ms'
  },
  {
    id: 'textFadeOutVar', section: 'text', label: 'Duration variance', kind: 'slider', parent: 'textFadeOutOn',
    varianceOf: 'textFadeOut',
    min: 0, max: 100, step: 1, def: 0,
    visible: fadeOutOn,
    get: S => Math.round(S.textFadeOutVar * 100),
    set: (S, pos) => { S.textFadeOutVar = pos / 100; save(); },
    format: S => Math.round(S.textFadeOutVar * 100) + '%'
  },
  {
    // Phrases only (a single word is one line). On, a multi-line
    // phrase dissolves every line at once on its way out, rather than one
    // line after another.
    id: 'textLinesTogetherOut', section: 'text', label: 'Lines fade out together', kind: 'toggle', def: false,
    parent: 'textFadeOutOn',
    visible: S => fadeOutOn(S) && phraseMode(S),
    get: S => !!S.textLinesTogetherOut,
    set: (S, on) => { S.textLinesTogetherOut = !!on; save(); },
    format: S => S.textLinesTogetherOut ? 'On' : 'Off'
  },
  {
    id: 'textFxOut', section: 'text', label: 'Leave', kind: 'segment', def: 'wind', parent: 'textFadeOutOn',
    dropdown: true,
    options: fxOptions('fxOut'),
    visible: S => fadeOutOn(S) && !S.textFxMirror,
    get: S => S.textFxOut,
    set: (S, v) => { S.textFxOut = v; save(); },
    format: S => FX_NAMES[S.textFxOut] || S.textFxOut
  },
  ...fxRows(true),
  // (textThemes below)
    // Multi-select: every theme chip is independently on or off. get()
    // returns the array of theme keys currently active; an empty S.textThemes
    // reads as "every theme", matching rebuildPool's own rule in v0/js/text.js,
    // so a fresh session shows every chip lit without having written 22
    // `true`s into storage. set(S, key) toggles exactly one key, replicating
    // the per-chip button handler in v0/js/ui.js including the "first touch
    // turns the blanket everything into an explicit set" rule: the set has to
    // be made real before any single key can be subtracted from it. The All
    // and None buttons are separate action controls below, matching v0's
    // txAllOn/txAllOff, which write every key at once rather than toggling.
  {
    id: 'textThemes', section: 'text', label: 'Themes', kind: 'segment', multi: true,
    visible: S => S.textMode !== 'affirmations' && S.textMode !== 'custom',
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
    visible: S => S.textMode !== 'affirmations' && S.textMode !== 'custom',
    set: S => {
      Object.keys(THEMES).forEach(k => { S.textThemes[k] = true; });
      rebuildWordPool();
      save();
    }
  },
  {
    id: 'txAllOff', section: 'text', label: 'None', kind: 'action',
    visible: S => S.textMode !== 'affirmations' && S.textMode !== 'custom',
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
  // The rows that stand alone come first; the rest sit in sub-drawers by
  // what they govern: Audio engine, Pause, Hint, Trails and Parallax.
  {
    // Only matters when frame lock lands on an odd number of display
    // frames per strobe cycle (40 Hz on a 120 Hz screen is 3), where the
    // halves cannot split evenly: the spare frame joins the lit half or
    // the dark. 'lit' and 'dark' are the only two options; a third,
    // alternating one would read as flicker at half the rate.
    id: 'spareMode', section: 'render', label: 'Odd frame bias', kind: 'segment', def: 'lit',
    options: [
      { value: 'lit',  label: 'Lit',  domId: 'spLit'  },
      { value: 'dark', label: 'Dark', domId: 'spDark' }
    ],
    get: S => S.spareMode,
    set: (S, mode) => { S.spareMode = mode; save(); },
    format: S => 'spare frame ' + S.spareMode
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
  },
  subDrawer('renderAudioDrawer', 'Audio engine', 'render', ['heartLookaheadS', 'heartGrowX']),
  {
    // The engine's cushion: how far ahead the sound is rendered
    // (js/heart/route.js, js/heart/engine.js). Bigger rides out stalls (a
    // fullscreen Space swipe, a busy machine); the cost is a control heard
    // this much later. Scheduled sound and the strobe lock are stamped to
    // the clock and never late. This machine's own setting, like the rest
    // of this section.
    id: 'heartLookaheadS', section: 'render', label: 'Audio cushion', kind: 'slider', parent: 'renderAudioDrawer',
    summaryLabel: 'Cushion',
    min: 0.05, max: 0.5, step: 0.01, def: 0.3,
    get: S => S.heartLookaheadS ?? 0.3,
    set: (S, v) => { S.heartLookaheadS = Math.max(0.05, Math.min(0.5, v)); applyHeartLookahead(); save(); },
    format: S => Math.round((S.heartLookaheadS ?? 0.3) * 1000) + ' ms'
  },
  {
    // How the cushion grows when it runs dry: the lookahead, and the floor
    // the ratchet leaves, both multiply by this (js/heart/drain-worklet.js
    // GROW). Gentler grows in smaller steps and may underrun again on the
    // way up; steeper settles in one leap at more latency.
    id: 'heartGrowX', section: 'render', label: 'Cushion growth', kind: 'slider', parent: 'renderAudioDrawer',
    summaryLabel: 'Growth',
    min: 1.1, max: 2, step: 0.1, def: 1.5,
    get: S => S.heartGrowX ?? 1.5,
    set: (S, v) => { S.heartGrowX = Math.max(1.1, Math.min(2, v)); applyHeartGrow(); save(); },
    format: S => '×' + (S.heartGrowX ?? 1.5).toFixed(1)
  },
  {
    // Whether the strobe's audio allows for the output's latency (js/
    // strobe-am.js postSignal): on, a sample carries the signal's value for
    // the moment it is HEARD, so the pulse sits on the flash on Bluetooth's
    // quarter second as on wired's twenty milliseconds. Off is the old
    // render-time match, for comparing. This machine's own, like the rest
    // of this drawer; the change lands within a tick of the toggle.
    id: 'outputLatComp', section: 'render', label: 'Output latency', kind: 'toggle', parent: 'renderAudioDrawer',
    def: true,
    get: S => S.outputLatComp !== false,
    set: (S, on) => { S.outputLatComp = !!on; save(); },
    format: S => S.outputLatComp !== false ? 'compensated' : 'raw'
  },
  {
    // The [syncdiag] console lines (js/strobe-am.js syncdiag): every 2 s,
    // the audio clock bridge, output and base latency, and the phase the
    // ear would hear late. Off by default; this machine's own.
    id: 'syncDiagLog', section: 'render', label: 'Console print sync and latency', kind: 'toggle', parent: 'renderAudioDrawer',
    def: false,
    get: S => S.syncDiagLog === true,
    set: (S, on) => { S.syncDiagLog = !!on; save(); },
    format: S => S.syncDiagLog === true ? 'printing' : 'off'
  },
  subDrawer('renderPauseDrawer', 'Pause', 'render', ['pauseWindDown', 'pauseFlickerStop']),
  {
    // How long the visuals take to coast to a stop when paused (core/motion.js).
    // 0 is a hard stop, and resuming is always instant. What the flicker
    // does meanwhile is the toggle below.
    id: 'pauseWindDown', section: 'render', label: 'Pause wind-down', kind: 'slider', parent: 'renderPauseDrawer',
    summaryLabel: 'Wind-down',
    min: 0, max: 5, step: 0.1, def: 1,
    get: S => S.pauseWindDown ?? 1,
    set: (S, v) => { S.pauseWindDown = v; save(); },
    format: S => (S.pauseWindDown ?? 1).toFixed(1) + ' s'
  },
  {
    // Whether pressing pause ends the flashing on that very frame. On (the
    // default) the strobe holds steady at once and only the motion coasts
    // through the wind-down; off, the flicker fades out over the wind-down
    // at its own frequency, never slowing. Its own switch, apart from the
    // time, so a viewer who pauses because the flashing is too much never
    // waits on it.
    id: 'pauseFlickerStop', section: 'render', label: 'Pause stops flicker', kind: 'toggle', def: true, parent: 'renderPauseDrawer',
    summaryLabel: 'Flicker stop',
    get: S => S.pauseFlickerStop !== false,
    set: (S, on) => { S.pauseFlickerStop = !!on; save(); },
    format: S => S.pauseFlickerStop !== false ? 'On' : 'Off'
  },
  subDrawer('renderHintDrawer', 'Hint', 'render', ['hintFadeInMs', 'hintFadeMs']),
  {
    // How long the hint takes to appear, at boot and on every pause
    // (ui/screens/overlay.js). It replaces the fade spring's own pace for
    // the appearance only; leaving is still the smoke on a start. 0 shows
    // it at once.
    id: 'hintFadeInMs', section: 'render', label: 'Hint fade in', kind: 'slider', parent: 'renderHintDrawer',
    summaryLabel: 'In',
    min: 0, max: 10000, step: 50, def: 2000,
    get: S => S.hintFadeInMs ?? 2000,
    set: (S, v) => { S.hintFadeInMs = v; save(); },
    format: S => Math.round(S.hintFadeInMs ?? 2000) + ' ms'
  },
  {
    // How long the resting screen's hint takes to smoke away on a start
    // (gpu/word-smoke.js beginHint). Its own time, not the words' Leave
    // fade, and fixed with no variance: the hint is chrome, not a word.
    // Below the smoke's 0.3 s floor it simply runs at the floor.
    id: 'hintFadeMs', section: 'render', label: 'Hint fade out', kind: 'slider', parent: 'renderHintDrawer',
    summaryLabel: 'Out',
    min: 0, max: 10000, step: 50, def: 5000,
    get: S => S.hintFadeMs ?? 5000,
    set: (S, v) => { S.hintFadeMs = v; save(); },
    format: S => Math.round(S.hintFadeMs ?? 5000) + ' ms'
  },
  {
    // How fast the hint's dissolve crosses it left to right, as a multiple
    // of the words' Leave sweep at its default speed. The default is twice
    // that, so the hint clears briskly; at the top the front crosses in
    // about an eighth of the fade, at the bottom most of it.
    id: 'hintSweep', section: 'render', label: 'Hint sweep', kind: 'slider', parent: 'renderHintDrawer',
    min: 0.6, max: 4, step: 0.05, def: 2,
    get: S => S.hintSweep ?? 2,
    set: (S, v) => { S.hintSweep = v; save(); },
    format: S => (S.hintSweep ?? 2).toFixed(2) + '×'
  },
  {
    // How the hint appears over its fade in. Left to right sends a soft
    // front across the letters, at Hint sweep's speed and by the same
    // front maths as its smoke out (core/word-fx.js hintSweepShare), so the
    // arrival and the departure feel like one gesture. All at once fades
    // the whole hint together.
    id: 'hintArrive', section: 'render', label: 'Hint arrive', kind: 'segment', def: 'sweep', parent: 'renderHintDrawer',
    options: [
      { value: 'sweep', label: 'Left to right', domId: null },
      { value: 'all',   label: 'All at once',   domId: null }
    ],
    get: S => S.hintArrive === 'all' ? 'all' : 'sweep',
    set: (S, v) => { S.hintArrive = v === 'all' ? 'all' : 'sweep'; save(); },
    format: S => S.hintArrive === 'all' ? 'All at once' : 'Left to right'
  },
  subDrawer('renderTrailsDrawer', 'Trails', 'render', ['fbResScale', 'fbResSwitch']),
  {
    // The size of the trail images laid over the whole screen (the edge's,
    // and Particles' and Confetti's after the fold or unfolded), as a share
    // of the canvas a side: at 75% they hold about half the memory and
    // fill, at 50% a quarter, stretched back over the screen with a filtered
    // read (gpu/feedback.js). For weighing the trails' cost by eye; the
    // chamber-sized images before the fold are already small and keep their
    // size. A change makes the images afresh; Trail switch below says
    // whether the trails in them carry over or start clear.
    id: 'fbResScale', section: 'render', label: 'Trail res', kind: 'segment', def: 1, parent: 'renderTrailsDrawer',
    summaryLabel: 'Res',
    options: [
      { value: 1,    label: 'Full', domId: null },
      { value: 0.75, label: '75%',  domId: null },
      { value: 0.5,  label: '50%',  domId: null }
    ],
    get: S => S.fbResScale === 0.75 || S.fbResScale === 0.5 ? S.fbResScale : 1,
    set: (S, v) => { S.fbResScale = v === 0.75 || v === 0.5 ? v : 1; save(); },
    format: S => S.fbResScale === 0.75 ? '75%' : S.fbResScale === 0.5 ? '50%' : 'Full'
  },
  {
    // What a Trail res change does to the trails already on screen. Keep
    // hands each image over to the new size (gpu/feedback.js, the hand-off),
    // so A/B-ing the sizes, or anything that changes them on its own, never
    // blanks the trails: going up they arrive soft and sharpen as new light
    // replaces them, going down they just shrink. Clear starts them afresh,
    // as Trail res always used to. A resized window starts them clear
    // either way.
    id: 'fbResSwitch', section: 'render', label: 'Trail switch', kind: 'segment', def: 'keep', parent: 'renderTrailsDrawer',
    summaryLabel: 'Switch',
    options: [
      { value: 'keep',  label: 'Keep',  domId: null },
      { value: 'clear', label: 'Clear', domId: null }
    ],
    get: S => S.fbResSwitch === 'clear' ? 'clear' : 'keep',
    set: (S, v) => { S.fbResSwitch = v === 'clear' ? 'clear' : 'keep'; save(); },
    format: S => S.fbResSwitch === 'clear' ? 'Clear' : 'Keep'
  },
  subDrawer('renderParallaxDrawer', 'Parallax', 'render', ['parallaxSim', 'parallaxAmount']),
  {
    // A stand-in for head tracking: the viewer's eye (core/eye.js) sways
    // slowly side to side, so the near layers slide against the far ones and
    // the tunnel shows its depth. It runs on wall-clock time, so it keeps
    // swaying while the scene is paused, the easiest way to look at it. A
    // viewing aid, not a setting: never saved, so every load starts still,
    // and journeys leave it be (core/journey.js).
    id: 'parallaxSim', section: 'render', label: 'Parallax sim', kind: 'toggle', def: false, parent: 'renderParallaxDrawer',
    summaryLabel: 'Sim',
    get: S => S.parallaxSim === true,
    set: (S, on) => { S.parallaxSim = !!on; },
    format: S => S.parallaxSim === true ? 'On' : 'Off'
  },
  {
    // How far the head sways each way, as a share of the tunnel's radius:
    // at 100% the nearest things would shift by a whole rim radius, so the
    // default 10% moves them a tenth of one and the far end hardly at all.
    id: 'parallaxAmount', section: 'render', label: 'Parallax amount', kind: 'slider',
    summaryLabel: 'Amount',
    parent: 'parallaxSim',
    min: 0, max: 30, step: 1, def: 10,
    get: S => Math.round((S.parallaxAmount ?? 0.1) * 100),
    set: (S, pos) => { S.parallaxAmount = pos / 100; save(); },
    format: S => Math.round((S.parallaxAmount ?? 0.1) * 100) + '%',
    visible: S => S.parallaxSim === true
  },
  {
    // How often the head sways, one side to the other and back: 0.25 Hz is
    // a slow four seconds a sway.
    id: 'parallaxSpeed', section: 'render', label: 'Head speed', kind: 'slider',
    parent: 'parallaxSim',
    min: 0.05, max: 2, step: 0.05, def: 0.25,
    get: S => S.parallaxSpeed ?? 0.25,
    set: (S, v) => { S.parallaxSpeed = v; save(); },
    format: S => (S.parallaxSpeed ?? 0.25).toFixed(2) + ' Hz',
    visible: S => S.parallaxSim === true
  },
  {
    // Everything this app keeps (settings, presets, journeys, the broadcast
    // key, window layout) to a file, and back: how a setup moves to another
    // site or is kept safe (platform/settings-file.js, through main.js).
    id: 'settingsDownload', section: 'settings', label: 'Download settings', kind: 'action',
    act: () => settingsFileHook('download')
  },
  {
    id: 'settingsLoad', section: 'settings', label: 'Load settings', kind: 'action',
    act: () => settingsFileHook('load')
  }
];

// The page's settings-file handler, set by main.js (platform.settingsFile).
let settingsFileHook = () => {};
export function setSettingsFileHandler(fn) { settingsFileHook = fn; }

// Mirrors rebuildPool's filter in v0/js/text.js exactly, but reads the static
// WORDS table directly rather than lane B's live pool cache: format() is
// called from the toolkit on every change to S.textThemes, and computing it
// from S plus the word list keeps this control's readout a pure function of
// state, with no dependency on when core/words.js last rebuilt its pool.
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
  { id: 'tunnel', title: 'Rings' },
  { id: 'edge',   title: 'Edge'   },
  { id: 'text',   title: 'Text'   },
  { id: 'render', title: 'Render' },
  // the last group in the drawer: your settings to a file and back
  { id: 'settings', title: 'Your settings' }
];
