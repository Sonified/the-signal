// The audio side of the control schema: the Audio, Music and Atmosphere
// drawer groups, the quick bar, the transport, and the fixed rows of the
// atmosphere mixer. Owns everything a listener touches.
//
// Every control below is a DOM-free port of one handler in js/ui.js. Where
// v0 wired a slider to an <input> and read el.value, here get/set trade in
// the same v0 SLIDER POSITION units (0-100 unless the control's own min/max
// says otherwise) so a widget can drive the control exactly the way v0's
// markup did. Where v0's handler ended by calling saveSettings(), the set
// or act below ends by calling store.save() instead, since nothing here can
// rely on a document-level click listener to catch a stray control.
//
// format(S) is not just the bare readout v0 assigned to a span's
// textContent: most of those spans sit beside static unit text in the
// markup ('%', ' Hz', 's / cycle', ...) that a schema-driven screen has
// nowhere else to put. format() below folds that unit back in, so a widget
// can print format(S) alone and match what v0 showed on screen.
import { S } from '../../js/state.js';
import { posToAmp, ampToPos, ampToDb, LEVEL_RANGE_DB } from '../../js/util.js';
import { setColorFromPicker } from '../../js/color.js';
import { chirpDurationMs } from '../../js/chirp.js';
import {
  setParam, applyLevel, applyAudioShape, applyHarmonics, applyReverbMix,
  rebuildClickIR, setAmRate, audioOn, audioOff, applyAudioGain,
  warmDevice, isDeviceWarm, refreshChirp, setPipShape, applyPipLpf
} from '../../js/audio.js';
import { pianoOn, pianoOff, applyPianoReverb, applyPianoHP, rebuildPianoIR, applyBedVol, applyBedOn, applyArp, applyBedLpf, applyBedVerb, applyBedDetune } from '../../js/piano.js';
import { cloudsOn, cloudsOff, applyCloudReverb } from '../../js/clouds.js';
import { ambienceOn, ambienceOff, applyAmbVol, applyAmbReverb, rebuildAmbIR, AMBIENCE_SOURCES } from '../../js/ambience.js';
import { applyMixGates } from '../../js/mixgate.js';
import { startDrift, stopDrift } from './atmosphere.js';
import { save } from './store.js';

// ---------- shared helpers, ported from js/ui.js closures ----------

// Readouts for the pip filter: kHz above a thousand, and a sweep time in
// seconds that switches to minutes once it gets long.
const fmtHz = hz => hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + ' kHz' : Math.round(hz) + ' Hz';
const fmtSweep = sec => sec < 90 ? Math.round(sec) + 's'
  : Math.floor(sec / 60) + 'm ' + String(Math.round(sec % 60)).padStart(2, '0') + 's';

// v0 has no S field for the layers-row Audio checkbox; it only ever reads
// $('lAudio').checked, round-tripped through the saved settings JSON under
// the key 'audioOnBoot'. store.js parks that as a real scalar, S.audioOnBoot,
// loaded and saved under that same key so v0 and v1 stay byte-compatible.
// Anywhere v0 read $('lAudio').checked (js/main.js's resume-on-first-gesture
// logic, for one) the v1 equivalent is S.audioOnBoot.
//
// state.js never seeds this field (it is not a v0 S field at all), and
// store.js's load() only writes it when there is a saved session to read;
// on a genuinely first visit S.audioOnBoot is left undefined. v0's markup
// default for the checkbox is checked, so undefined reads as on here rather
// than off, the same default a fresh <input checked> would give.
const audioLayerOn = s => s.audioOnBoot !== false;

function setAudioLayer(s, on) {
  s.audioOnBoot = on;
  if (on) audioOn(); else audioOff();
  save();
}

// toggleAudioSource in v0 flips S.toneOn/S.clickOn itself; every other
// on/off pair in that file (setMusic, setClouds, setAmb, setBilateral,
// setHarm) is already written as "set to this explicit state", which is the
// shape a schema control's set(S, on) wants. So tone and click get the same
// treatment here rather than a flip, which also makes a preset's
// P.sources.tone / P.sources.click assignment a plain call instead of a
// double negative.
function setToneOn(s, on) {
  s.toneOn = on;
  applyAudioShape();
  save();
}
function setClickOn(s, on) {
  s.clickOn = on;
  applyAudioShape();
  save();
}

function setMusicOn(s, on) {
  s.musicOn = on;
  if (on) { pianoOn(); if (s.cloudsOn) cloudsOn(); } else { pianoOff(); cloudsOff(); }
  save();
}
// Only this one, of the three music/clouds/atmosphere switches, checks
// S.running before actually sounding. That asymmetry is v0's, not a slip
// here: setMusicOn above starts the piano the moment the switch is touched,
// on or off the transport, while the clouds switch defers to whether a
// session is actually running. Both are reproduced exactly as found.
function setCloudsOn(s, on) {
  s.cloudsOn = on;
  if (on && s.musicOn && s.running) cloudsOn(); else cloudsOff();
  save();
}
function setAmbOn(s, on) {
  s.ambOn = on;
  if (on && s.running) ambienceOn(); else ambienceOff();
  save();
}
function setBilateral(s, on) {
  s.biOn = on;
  setParam('biDepth', on ? s.biDepth : 0, 0.05);
  save();
}
function setHarmOn(s, on) {
  s.harmOn = on;
  applyLevel('harmLevel', 0.3);
  save();
}
function setAmLinked(s, linked) {
  s.amLinked = linked;
  setAmRate(linked ? s.freq : s.amRate);
  save();
}
// setPipShape owns the crossfade from one shape's voice to the other's (each
// has its own level in the worklet, so neither passes through the other's).
// The state is written here as well, before it, as v0's setClickMode does,
// because the five shared pip controls address click or chirp values by
// S.clickMode: a preset selects chirp and then immediately sets the chirp's
// levels, which have to land in the chirp.
function setClickModeState(s, mode) {
  s.clickMode = mode;
  setPipShape(mode);
  save();
}

// The pip train's five shared controls each address a click value or a
// chirp value depending on S.clickMode, never both. One key per control
// name, indexed by which shape is live.
const PIP_KEYS = {
  vol:     ['clickVol',       'chirpVol'],
  reverb:  ['clickReverb',    'chirpReverb'],
  revTime: ['clickRevTime',   'chirpRevTime'],
  modDep:  ['clickModDepth',  'chirpModDepth'],
  modPer:  ['clickModPeriod', 'chirpModPeriod']
};
const pipKey = (s, which) => PIP_KEYS[which][s.clickMode === 'chirp' ? 1 : 0];
const pipGet = (s, which) => s[pipKey(s, which)];
const pipSet = (s, which, v) => { s[pipKey(s, which)] = v; };

const TILT_NAMES = [[0, 'white'], [0.5, 'bright'], [1, 'pink'], [1.25, 'warm'], [1.5, 'dark']];
function tiltName(v) {
  let best = TILT_NAMES[0];
  for (const t of TILT_NAMES) if (Math.abs(t[0] - v) < Math.abs(best[0] - v)) best = t;
  return best[1];
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = n => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);

// ---------- typed readouts: displayed units back to positions ----------
// A readout the viewer types into (see the toolkit's ui.control) is read in
// the units it shows. Most rows print their position as it is, with a unit
// folded on, and need nothing here. These are the ones whose readout is a
// different quantity from the position, each the exact inverse of its
// format(). They run on a commit, never per frame.

// The level faders print ampToDb(posToAmp(pos)), and posToAmp spreads
// LEVEL_RANGE_DB evenly over the travel, so decibels come back to a position
// on a straight line: 0 dB is 100, and each position below it is
// LEVEL_RANGE_DB / 100 dB quieter. The bottom of the range is silence, which
// the readout prints as -inf, so that is accepted too; anything quieter than
// the range reaches lands there by the toolkit's clamp.
const DB_PER_POS = LEVEL_RANGE_DB / 100;
function parseDb(s, text) {
  const t = text.trim().toLowerCase();
  if (t === '-inf' || t === '-\u221e') return 0;
  const db = parseFloat(t);
  return Number.isFinite(db) ? 100 + db / DB_PER_POS : NaN;
}

// A note name as noteName prints it (C6, F#4), a flat spelling of the same
// key (Bb3), or a bare MIDI note number, which is the position itself.
const NOTE_CLASS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
function parseNote(s, text) {
  const t = text.trim();
  const n = Number(t);
  if (t !== '' && Number.isFinite(n)) return n;
  const m = /^([a-g])\s*([#\u266fb\u266d]?)\s*(-?\d+)$/i.exec(t);
  if (!m) return NaN;
  const acc = m[2] === '#' || m[2] === '\u266f' ? 1 : m[2] ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + NOTE_CLASS[m[1].toLowerCase()] + acc;
}

// The spectral tilt prints a colour of noise, not a number, so its field
// takes one of those names (the position is the tilt times 100); a number
// is taken as the position itself.
function parseTilt(s, text) {
  const t = text.trim().toLowerCase();
  for (const row of TILT_NAMES) if (row[1] === t) return row[0] * 100;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

// ---------- quick bar cycles, ported from js/ui.js ----------

// Six shorthand arrangements of the four visual layers. The cycle writes
// straight into S.layers, the same object schema-visual.js's own layer
// toggles address, so the corner button and the drawer checkboxes can never
// disagree; there is only the one object.
const VISUAL_MODES = [
  ['full',        { field: true,  rings: true,  corners: true,  edge: true }],
  ['strobe off',  { field: false, rings: true,  corners: false, edge: true }],
  ['strobe only', { field: true,  rings: false, corners: true,  edge: false }],
  ['rings only',  { field: false, rings: true,  corners: false, edge: false }],
  ['edge only',   { field: false, rings: false, corners: false, edge: true }],
  ['off',         { field: false, rings: false, corners: false, edge: false }]
];
function visualModeNow(s) {
  for (const [name, want] of VISUAL_MODES) {
    if (Object.keys(want).every(k => !!s.layers[k] === want[k])) return name;
  }
  return 'custom';
}
function cycleVisualMode(s) {
  const now = visualModeNow(s);
  const i = VISUAL_MODES.findIndex(r => r[0] === now);
  const row = VISUAL_MODES[(i + 1) % VISUAL_MODES.length];
  Object.assign(s.layers, row[1]);
  save();
}

// The pip trim ladder, a decibel offset from whatever the fader says rather
// than a level of its own, so a trip through loud and back always lands
// where the fader was left.
const CLICK_STEPS = [
  ['loud', 6], ['normal', 0], ['gentle', -6], ['whisper', -12], ['off', null]
];
function clickStepNow(s) {
  if (!s.clickOn) return 'off';
  const row = CLICK_STEPS.find(r => r[1] === s.pipTrimDb);
  return row ? row[0] : 'normal';
}
function cycleClickStep(s) {
  const i = CLICK_STEPS.findIndex(r => r[0] === clickStepNow(s));
  const row = CLICK_STEPS[(i + 1) % CLICK_STEPS.length];
  const wantOn = row[1] !== null;
  if (wantOn) s.pipTrimDb = row[1];
  if (s.clickOn !== wantOn) setClickOn(s, wantOn);
  else { applyLevel('clickLevel'); applyLevel('clickSend'); save(); }
}

// Three color modes, cycled by one button. Each is shorthand for settings
// that already live in the drawer, same as the visual-mode cycle above.
const COLOR_MODES = ['rotating', 'multi', 'magenta'];
// Magenta means the walk goes to zero; without somewhere to keep the old
// amount that would be destructive, so the last non-zero walk is remembered
// here and handed back when the cycle returns to a walking mode. One module,
// one instance of the button, so one closure variable is enough, exactly as
// it was in ui.js.
let lastWalk = 1;
function syncColorModeField(s) {
  s.colorMode = s.colorWalk <= 0 ? 'magenta' : s.perElementColor ? 'multi' : 'rotating';
}
function setColorMode(s, mode) {
  if (s.colorWalk > 0) lastWalk = s.colorWalk;
  s.perElementColor = mode === 'multi';
  // v0 drove this through the colorWalk slider's own input event, which
  // rounds to the slider's whole-percent steps; the same rounding is done
  // by hand here so a walk of, say, 0.837 does not come back as 0.8370001
  // after a trip through magenta and back.
  s.colorWalk = mode === 'magenta' ? 0 : Math.round((lastWalk || 1) * 100) / 100;
  if (mode === 'magenta') setColorFromPicker('#d400ff');
  syncColorModeField(s);
  save();
}
function cycleColorMode(s) {
  const i = COLOR_MODES.indexOf(s.colorMode);
  setColorMode(s, COLOR_MODES[(i + 1) % COLOR_MODES.length]);
}

// ---------- injectable hooks ----------
// Three things a control here needs to trigger live outside v1/core: running
// the session (which also resets the strobe clock and seeds the tunnel, both
// lane A1's), showing or hiding the mixer overlay (a screen, wave 2), and
// writing to the clipboard (only v1/platform may touch the outside world).
// Each is a plain setter so integration can wire it once at boot without core
// importing anything from ui/, gpu/ or platform/.
let toggleRunHook = () => {};
let mixerOpenHook = () => {};
let seqOpenHook = () => {};
let copyHook = () => {};
export function setToggleRun(fn) { toggleRunHook = fn; }
export function setMixerOpen(fn) { mixerOpenHook = fn; }
export function setSeqOpen(fn) { seqOpenHook = fn; }
export function setCopyHandler(fn) { copyHook = fn; }

// The audio-side half of v0's toggle(): warming the device on a cold start,
// starting or stopping the piano, clouds and atmosphere with the session,
// and riding the master gain. v0's toggle() flips S.running itself before
// this part runs, so the caller (the injected toggleRun hook, composed by
// integration alongside the strobe reset and the visual half) is expected to
// have already set S.running to its new value.
export function audioToggleEffects(s) {
  const cold = !isDeviceWarm();
  if (cold) warmDevice().then(() => { if (audioLayerOn(s)) audioOn(); });
  if (s.running) {
    if (s.musicOn) { pianoOn(); if (s.cloudsOn) cloudsOn(); }
    if (s.ambOn) ambienceOn();
  } else {
    pianoOff(); cloudsOff(); ambienceOff();
  }
  applyAudioGain();
}

// ---------- section list ----------
export const AUDIO_SECTIONS = [
  { id: 'audio',      title: 'Audio' },
  { id: 'music',      title: 'Music' },
  { id: 'atmosphere', title: 'Ambience' },
  { id: 'quick',      title: 'Quick bar' },
  { id: 'transport',  title: 'Transport' },
  { id: 'mixer',      title: 'Ambience mixer' }
];

// ---------- Audio section ----------
const audioControls = [
  // The audio master switch at the head of the Audio section, the same one
  // the Layers row carries as lAudio. Never dims.
  {
    id: 'audioOn', section: 'audio', label: 'On', kind: 'toggle',
    get: audioLayerOn,
    set: (s, on) => setAudioLayer(s, !!on)
  },
  {
    id: 'vol', section: 'audio', label: 'Master volume', kind: 'slider',
    min: 0, max: 100, step: 1, def: 50,
    get: s => Math.round(s.volume * 100),
    set: (s, pos) => { s.volume = pos / 100; applyAudioGain(); save(); },
    format: s => Math.round(s.volume * 100) + '%'
  },
  {
    id: 'amRate', section: 'audio', label: 'Pulse rate', kind: 'slider',
    min: 0.5, max: 60, step: 0.5, def: 7.5,
    get: s => s.amLinked ? s.freq : s.amRate,
    set: (s, pos) => {
      s.amRate = pos;
      // linked mode disables this control (see enabled below), so this body
      // only ever runs while free-running, same as v0's disabled input
      if (!s.amLinked) setAmRate(s.amRate);
      save();
    },
    format: s => (s.amLinked ? s.freq : s.amRate).toFixed(1) + ' Hz',
    enabled: s => !s.amLinked
  },
  {
    id: 'aTone', section: 'audio', sub: 'Sine tone', label: 'Sine tone', kind: 'toggle',
    get: s => s.toneOn,
    set: (s, on) => setToneOn(s, !!on),
    format: s => s.toneOn ? 'On' : 'Off'
  },
  {
    id: 'carrier', section: 'audio', sub: 'Sine tone', label: 'Carrier', kind: 'slider',
    parent: 'aTone',
    min: 1, max: 1000, step: 1, def: 40,
    get: s => s.carrierHz,
    set: (s, pos) => { s.carrierHz = pos; setParam('carrier', s.carrierHz); save(); },
    format: s => s.carrierHz + ' Hz',
    // Positions stay in Hz (presets and saved settings store Hz), but the
    // track is logarithmic, so 1-100 Hz, where the carriers people actually
    // use live, gets two thirds of the travel instead of a tenth of it.
    taper: 'log',
    visible: s => s.toneOn
  },
  {
    id: 'toneVol', section: 'audio', sub: 'Sine tone', label: 'Level', kind: 'slider',
    parent: 'aTone',
    min: 0, max: 100, step: 1, def: 83,
    get: s => ampToPos(s.toneVol),
    set: (s, pos) => { s.toneVol = posToAmp(pos); applyLevel('toneLevel'); save(); },
    format: s => ampToDb(s.toneVol) + ' dB',
    parse: parseDb,
    visible: s => s.toneOn
  },
  {
    id: 'aClick', section: 'audio', sub: 'Click train', label: 'Click train', kind: 'toggle',
    get: s => s.clickOn,
    set: (s, on) => setClickOn(s, !!on),
    format: s => s.clickOn ? 'On' : 'Off'
  },
  {
    id: 'clickMode', section: 'audio', sub: 'Click train', label: 'Mode', kind: 'segment',
    parent: 'aClick',
    options: [
      { value: 'click', label: 'Click', domId: 'cmClick' },
      { value: 'chirp', label: 'Chirp', domId: 'cmChirp' }
    ],
    get: s => s.clickMode,
    set: (s, mode) => setClickModeState(s, mode),
    format: s => s.clickMode,
    visible: s => s.clickOn
  },
  {
    id: 'pipMs', section: 'audio', sub: 'Click train', label: 'Pip width', kind: 'slider',
    parent: 'aClick',
    min: 0.5, max: 25, step: 0.5, def: 8,
    get: s => s.pipMs,
    set: (s, pos) => { s.pipMs = pos; setParam('pipMs', s.pipMs); save(); },
    format: s => s.pipMs.toFixed(1) + ' ms',
    visible: s => s.clickOn && s.clickMode === 'click'
  },
  {
    id: 'chirpLow', section: 'audio', sub: 'Click train', label: 'Chirp low', kind: 'slider',
    parent: 'aClick',
    min: 40, max: 2000, step: 10, def: 150,
    get: s => s.chirpLowHz,
    set: (s, pos) => { s.chirpLowHz = pos; refreshChirp(); save(); },
    format: s => s.chirpLowHz + ' Hz',
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'chirpHigh', section: 'audio', sub: 'Click train', label: 'Chirp high', kind: 'slider',
    parent: 'aClick',
    min: 1000, max: 12000, step: 100, def: 6000,
    get: s => s.chirpHighHz,
    set: (s, pos) => { s.chirpHighHz = pos; refreshChirp(); save(); },
    format: s => s.chirpHighHz + ' Hz',
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'chirpComp', section: 'audio', sub: 'Click train', label: 'Delay compensation', kind: 'slider',
    parent: 'aClick',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round(s.chirpComp * 100),
    set: (s, pos) => { s.chirpComp = pos / 100; refreshChirp(); save(); },
    format: s => Math.round(s.chirpComp * 100) + '%',
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'chirpTilt', section: 'audio', sub: 'Click train', label: 'Spectral tilt', kind: 'slider',
    parent: 'aClick',
    min: 0, max: 150, step: 5, def: 130,
    get: s => Math.round(s.chirpTilt * 100),
    set: (s, pos) => { s.chirpTilt = pos / 100; refreshChirp(); save(); },
    format: s => tiltName(s.chirpTilt),
    entry: 'text', parse: parseTilt,
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  // Not a real control: v0 shows this row as a note ("set by the frequency
  // range and the cochlear model") with no input of its own. Kept as a
  // non-interactive action, act is a no-op and enabled is always false, so
  // the section still accounts for every row the drawer draws, and a screen
  // that skips disabled actions renders it as the plain readout it is.
  {
    id: 'chirpLen', section: 'audio', sub: 'Click train', label: 'Chirp length', kind: 'action',
    parent: 'aClick',
    act: () => {},
    format: s => chirpDurationMs(s.chirpLowHz, s.chirpHighHz).toFixed(1) + ' ms',
    enabled: () => false,
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'clickVol', section: 'audio', sub: 'Click train', label: 'Level', kind: 'slider',
    parent: 'aClick',
    min: 0, max: 100, step: 1, def: 0,
    get: s => ampToPos(pipGet(s, 'vol')),
    set: (s, pos) => { pipSet(s, 'vol', posToAmp(pos)); applyLevel('clickLevel'); applyLevel('clickSend'); save(); },
    format: s => ampToDb(pipGet(s, 'vol')) + ' dB',
    parse: parseDb,
    visible: s => s.clickOn
  },
  {
    id: 'clickReverb', section: 'audio', sub: 'Click train', label: 'Click / Chirp reverb', kind: 'slider',
    parent: 'aClick',
    min: 0, max: 100, step: 1, def: 37,
    get: s => Math.round(pipGet(s, 'reverb') * 100),
    set: (s, pos) => { pipSet(s, 'reverb', pos / 100); applyReverbMix(); applyLevel('clickSend'); save(); },
    format: s => Math.round(pipGet(s, 'reverb') * 100) + '%',
    visible: s => s.clickOn
  },
  {
    id: 'clickRevTime', section: 'audio', sub: 'Click train', label: 'Click / Chirp reverb time', kind: 'slider',
    parent: 'aClick',
    min: 0.2, max: 8, step: 0.1, def: 0.5,
    get: s => pipGet(s, 'revTime'),
    set: (s, pos) => { pipSet(s, 'revTime', pos); rebuildClickIR(); save(); },
    format: s => pipGet(s, 'revTime').toFixed(1) + 's',
    visible: s => s.clickOn
  },
  {
    id: 'clickModDepth', section: 'audio', sub: 'Click train', label: 'Click / Chirp loudness variance', kind: 'slider',
    parent: 'aClick',
    min: 0, max: 100, step: 1, def: 0,
    get: s => Math.round(pipGet(s, 'modDep') * 100),
    set: (s, pos) => { pipSet(s, 'modDep', pos / 100); applyHarmonics(); save(); },
    format: s => Math.round(pipGet(s, 'modDep') * 100) + '%',
    visible: s => s.clickOn
  },
  {
    id: 'clickModRate', section: 'audio', sub: 'Click train', label: 'Click / Chirp loudness var rate', kind: 'slider',
    parent: 'aClick',
    min: 1, max: 60, step: 1, def: 26,
    get: s => pipGet(s, 'modPer'),
    set: (s, pos) => { pipSet(s, 'modPer', pos); applyHarmonics(); save(); },
    format: s => pipGet(s, 'modPer') + 's / cycle',
    visible: s => s.clickOn
  },
  // The lowpass sweep. One filter for the whole train, click or chirp, so it
  // sits after the shape's own rows and is not swapped by the mode.
  {
    id: 'pipLpf', section: 'audio', sub: 'Click train', label: 'Filter sweep', kind: 'toggle',
    parent: 'aClick',
    get: s => s.pipLpfOn,
    set: (s, on) => { s.pipLpfOn = !!on; applyPipLpf(); save(); },
    format: s => s.pipLpfOn ? 'On' : 'Off',
    visible: s => s.clickOn
  },
  {
    id: 'pipLpfLo', section: 'audio', sub: 'Click train', label: 'Filter low', kind: 'slider',
    parent: 'pipLpf',
    min: 40, max: 4000, step: 10, def: 400, taper: 'log',
    get: s => s.pipLpfLo,
    set: (s, pos) => { s.pipLpfLo = pos; applyPipLpf(); save(); },
    format: s => fmtHz(s.pipLpfLo),
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfHi', section: 'audio', sub: 'Click train', label: 'Filter high', kind: 'slider',
    parent: 'pipLpf',
    min: 500, max: 18000, step: 100, def: 9000, taper: 'log',
    get: s => s.pipLpfHi,
    set: (s, pos) => { s.pipLpfHi = pos; applyPipLpf(); save(); },
    format: s => fmtHz(s.pipLpfHi),
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfPeriod', section: 'audio', sub: 'Click train', label: 'Filter sweep time', kind: 'slider',
    parent: 'pipLpf',
    min: 2, max: 300, step: 1, def: 60, taper: 'log',
    get: s => s.pipLpfPeriod,
    set: (s, pos) => { s.pipLpfPeriod = pos; applyPipLpf(); save(); },
    format: s => fmtSweep(s.pipLpfPeriod) + ' / cycle',
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfWander', section: 'audio', sub: 'Click train', label: 'Filter wander', kind: 'slider',
    parent: 'pipLpf',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round(s.pipLpfWander * 100),
    set: (s, pos) => { s.pipLpfWander = pos / 100; applyPipLpf(); save(); },
    format: s => Math.round(s.pipLpfWander * 100) + '%',
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfQ', section: 'audio', sub: 'Click train', label: 'Filter resonance', kind: 'slider',
    parent: 'pipLpf',
    min: 50, max: 600, step: 1, def: 71, taper: 'log',
    get: s => Math.round(s.pipLpfQ * 100),
    set: (s, pos) => { s.pipLpfQ = pos / 100; applyPipLpf(); save(); },
    format: s => s.pipLpfQ.toFixed(2),
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'biToggle', section: 'audio', sub: 'Bilateral', label: 'Bilateral', kind: 'toggle',
    get: s => s.biOn,
    set: (s, on) => setBilateral(s, !!on),
    format: s => s.biOn ? 'On' : 'Off'
  },
  {
    id: 'biDepth', section: 'audio', sub: 'Bilateral', label: 'Bilateral depth', kind: 'slider',
    parent: 'biToggle',
    min: 0, max: 100, step: 1, def: 60,
    get: s => Math.round(s.biDepth * 100),
    set: (s, pos) => { s.biDepth = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.biDepth * 100) + '%',
    visible: s => s.biOn
  },
  {
    id: 'biRate', section: 'audio', sub: 'Bilateral', label: 'Bilateral rate', kind: 'slider',
    parent: 'biToggle',
    min: 0.4, max: 10, step: 0.1, def: 1,
    get: s => s.biPeriod,
    set: (s, pos) => { s.biPeriod = pos; applyHarmonics(); save(); },
    format: s => s.biPeriod.toFixed(1) + 's / pass',
    visible: s => s.biOn
  },
  {
    id: 'biHardSwitch', section: 'audio', sub: 'Bilateral', label: 'Bilateral shape', kind: 'segment',
    parent: 'biToggle',
    options: [
      { value: true,  label: 'Switch', domId: 'biHard' },
      { value: false, label: 'Sweep',  domId: 'biSoft' }
    ],
    get: s => s.biHardSwitch,
    set: (s, v) => { s.biHardSwitch = v; applyHarmonics(); save(); },
    format: s => s.biHardSwitch ? 'Switch' : 'Sweep',
    visible: s => s.biOn
  },
  {
    id: 'harmToggle', section: 'audio', sub: 'Harmonics', label: 'Harmonics', kind: 'toggle',
    get: s => s.harmOn,
    set: (s, on) => setHarmOn(s, !!on),
    format: s => s.harmOn ? 'On' : 'Off',
    // v0 only dims this row with a 'locked' class when the tone is off; the
    // button itself is never given a real disabled attribute, so this is a
    // little stricter than v0's actual click handler. It matches v0's
    // visible INTENT (the row reads as unavailable) rather than the letter
    // of a handler that never checked.
    enabled: s => s.toneOn
  },
  {
    id: 'harmVol', section: 'audio', sub: 'Harmonics', label: 'Level', kind: 'slider',
    parent: 'harmToggle',
    min: 0, max: 100, step: 1, def: 87,
    get: s => ampToPos(s.harmVol),
    set: (s, pos) => { s.harmVol = posToAmp(pos); applyLevel('harmLevel'); save(); },
    format: s => ampToDb(s.harmVol) + ' dB',
    parse: parseDb,
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmCount', section: 'audio', sub: 'Harmonics', label: 'How many', kind: 'slider',
    parent: 'harmToggle',
    min: 1, max: 16, step: 1, def: 9,
    get: s => s.harmCount,
    set: (s, pos) => { s.harmCount = pos; applyHarmonics(); save(); },
    format: s => String(s.harmCount),
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmBright', section: 'audio', sub: 'Harmonics', label: 'Brightness', kind: 'slider',
    parent: 'harmToggle',
    min: 0, max: 100, step: 1, def: 45,
    get: s => Math.round(s.harmBright * 100),
    set: (s, pos) => { s.harmBright = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.harmBright * 100) + '%',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmSpread', section: 'audio', sub: 'Harmonics', label: 'Stereo spread', kind: 'slider',
    parent: 'harmToggle',
    min: 0, max: 100, step: 1, def: 70,
    get: s => Math.round(s.harmSpread * 100),
    set: (s, pos) => { s.harmSpread = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.harmSpread * 100) + '%',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmPanRate', section: 'audio', sub: 'Harmonics', label: 'Pan speed', kind: 'slider',
    parent: 'harmToggle',
    min: 0, max: 4, step: 0.05, def: 0.45,
    get: s => s.harmPanRate,
    set: (s, pos) => { s.harmPanRate = pos; applyHarmonics(); save(); },
    format: s => s.harmPanRate.toFixed(2) + ' Hz',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'shimDepth', section: 'audio', sub: 'Harmonics', label: 'Shimmer depth', kind: 'slider',
    parent: 'harmToggle',
    min: 0, max: 100, step: 1, def: 57,
    get: s => Math.round(s.shimDepth * 100),
    set: (s, pos) => { s.shimDepth = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.shimDepth * 100) + '%',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'shimRate', section: 'audio', sub: 'Harmonics', label: 'Shimmer rate', kind: 'slider',
    parent: 'harmToggle',
    min: 0.01, max: 6, step: 0.01, def: 0.12,
    get: s => s.shimRate,
    set: (s, pos) => { s.shimRate = pos; applyHarmonics(); save(); },
    format: s => s.shimRate.toFixed(2) + ' Hz',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmReverb', section: 'audio', sub: 'Harmonics', label: 'Reverb', kind: 'slider',
    parent: 'harmToggle',
    min: 0, max: 100, step: 1, def: 35,
    get: s => Math.round(s.harmReverb * 100),
    set: (s, pos) => { s.harmReverb = pos / 100; applyReverbMix(); save(); },
    format: s => Math.round(s.harmReverb * 100) + '%',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'amLinked', section: 'audio', sub: 'Harmonics', label: 'Audio mode', kind: 'segment',
    parent: 'harmToggle',
    options: [
      { value: false, label: 'Free',            domId: 'aFree' },
      { value: true,  label: 'Link to visual',  domId: 'aLink' }
    ],
    get: s => s.amLinked,
    set: (s, v) => setAmLinked(s, !!v),
    format: s => s.amLinked ? 'Link to visual' : 'Free',
    visible: s => s.harmOn && s.toneOn
  },
  // The layers-row Audio checkbox. Visually it sits with the four visual
  // layer toggles schema-visual.js owns, but it is the audio master switch,
  // so it lives here; its state is S.audioOnBoot, per store.js's contract.
  {
    id: 'lAudio', section: 'layers', label: 'Audio', kind: 'toggle',
    get: audioLayerOn,
    set: (s, on) => setAudioLayer(s, !!on),
    format: s => audioLayerOn(s) ? 'On' : 'Off'
  }
];

// ---------- Music section ----------
const musicControls = [
  {
    // The whole music engine's switch. The section header's own On/Off is
    // this control (drawer.js SECTION_SWITCH), so it never shows as a body
    // row; it only exists for the header and the quick bar to drive.
    id: 'musicOn', section: 'music', label: 'Music', kind: 'segment',
    options: [
      { value: true,  label: 'On',  domId: 'muOn' },
      { value: false, label: 'Off', domId: 'muOff' }
    ],
    get: s => s.musicOn,
    set: (s, v) => setMusicOn(s, !!v),
    format: s => s.musicOn ? 'on' : 'off',
    visible: () => false
  },
  {
    // The generative piano voice alone; the drone, arpeggio and clouds keep
    // playing. Read by the player as each gesture is chosen (js/piano.js).
    id: 'pianoOn', section: 'music', label: 'Piano', kind: 'toggle',
    get: s => s.pianoOn !== false,
    set: (s, on) => { s.pianoOn = !!on; save(); },
    format: s => s.pianoOn !== false ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  {
    // v1 only, so no v0 button ids. Read by piano.js as each gesture is
    // chosen, so a switch is heard from the next phrase on.
    id: 'pianoStyle', section: 'music',
    parent: 'pianoOn', label: 'Play style', kind: 'segment',
    options: [
      { value: 'generative', label: 'Generative', domId: null },
      { value: 'snippets',   label: 'Snippets',   domId: null }
    ],
    get: s => s.pianoStyle,
    set: (s, v) => { s.pianoStyle = v === 'snippets' ? 'snippets' : 'generative'; save(); },
    format: s => s.pianoStyle,
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoVol', section: 'music',
    parent: 'pianoOn', label: 'Piano level', kind: 'slider',
    min: 0, max: 100, step: 1, def: 90,
    get: s => Math.round(s.pianoVol * 100),
    set: (s, pos) => { s.pianoVol = pos / 100; save(); },
    format: s => Math.round(s.pianoVol * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoHP', section: 'music',
    parent: 'pianoOn', label: 'Piano high-pass', kind: 'slider',
    min: 20, max: 600, step: 5, def: 20,
    get: s => s.pianoHP,
    set: (s, pos) => { s.pianoHP = pos; applyPianoHP(); save(); },
    format: s => s.pianoHP <= 20 ? 'off' : s.pianoHP + ' Hz',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  // ---- the generative player's own dials: how often it plays (Density),
  // where on the keyboard it centres and how far it wanders (Register
  // centre and drift), how long gestures ring (Hold length) and how often
  // the low root anchors them (Low anchor) ----
  {
    id: 'pianoDensity', section: 'music',
    parent: 'pianoOn', label: 'Density', kind: 'slider',
    min: 20, max: 250, step: 5, def: 100,
    get: s => Math.round(s.pianoDensity * 100),
    set: (s, pos) => { s.pianoDensity = pos / 100; save(); },
    format: s => Math.round(s.pianoDensity * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoCentre', section: 'music',
    parent: 'pianoOn', label: 'Register centre', kind: 'slider',
    min: 48, max: 84, step: 1, def: 72,
    get: s => s.pianoCentre,
    set: (s, pos) => { s.pianoCentre = pos; save(); },
    format: s => noteName(s.pianoCentre),
    entry: 'text', parse: parseNote,
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoSpread', section: 'music',
    parent: 'pianoOn', label: 'Register drift', kind: 'slider',
    min: 0, max: 100, step: 1, def: 55,
    get: s => Math.round(s.pianoSpread * 100),
    set: (s, pos) => { s.pianoSpread = pos / 100; save(); },
    format: s => Math.round(s.pianoSpread * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoHold', section: 'music',
    parent: 'pianoOn', label: 'Hold length', kind: 'slider',
    min: 30, max: 250, step: 5, def: 100,
    get: s => Math.round(s.pianoHold * 100),
    set: (s, pos) => { s.pianoHold = pos / 100; save(); },
    format: s => Math.round(s.pianoHold * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoBass', section: 'music',
    parent: 'pianoOn', label: 'Low anchor', kind: 'slider',
    min: 0, max: 60, step: 1, def: 10,
    get: s => s.pianoBass,
    set: (s, pos) => { s.pianoBass = pos; save(); },
    format: s => s.pianoBass + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    // The sequencer (js/piano.js, the arpeggio and sequencer sections), whose
    // first pattern is the original 3 4 8 figure: off by default.
    id: 'arpOn', section: 'music', label: 'Sequencer', kind: 'toggle',
    get: s => !!s.arpOn,
    set: (s, on) => { s.arpOn = !!on; applyArp(); save(); },
    format: s => s.arpOn ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  {
    // The step grid, in its own floating window (ui/screens/sequencer.js).
    id: 'seqOpen', section: 'music', label: 'Open sequencer', kind: 'action',
    parent: 'arpOn',
    act: () => seqOpenHook(),
    format: () => 'Open sequencer',
    visible: s => s.musicOn && s.arpOn
  },
  {
    id: 'arpVol', section: 'music', label: 'Sequencer level', kind: 'slider',
    parent: 'arpOn',
    min: 0, max: 100, step: 1, def: 50,
    get: s => Math.round(s.arpVol * 100),
    set: (s, pos) => { s.arpVol = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpVol * 100) + '%',
    visible: s => s.musicOn && s.arpOn
  },
  {
    id: 'arpRate', section: 'music', label: 'Sequencer speed', kind: 'slider',
    parent: 'arpOn',
    min: 2, max: 14, step: 0.5, def: 7,
    get: s => s.arpRate,
    set: (s, pos) => { s.arpRate = pos; applyArp(); save(); },
    format: s => s.arpRate.toFixed(1) + ' notes/s',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // The running oscillators switch shape at once, level-matched.
    id: 'arpWave', section: 'music', label: 'Sequencer waveform', kind: 'segment', def: 'sine',
    parent: 'arpOn',
    options: [
      { value: 'sine',     label: 'Sine' },
      { value: 'triangle', label: 'Triangle' },
      { value: 'sawtooth', label: 'Saw' },
      { value: 'square',   label: 'Square' }
    ],
    get: s => s.arpWave,
    set: (s, v) => { s.arpWave = v; applyArp(); save(); },
    format: s => s.arpWave,
    visible: s => s.musicOn && s.arpOn
  },
  {
    // How fast each note's filter opens (the figure is played by the filter,
    // so this is the swell into every note).
    id: 'arpAtk', section: 'music', label: 'Sequencer attack', kind: 'slider',
    parent: 'arpOn',
    min: 1, max: 500, step: 1, def: 10, taper: 'log',
    get: s => Math.round(s.arpAtk * 1000),
    set: (s, pos) => { s.arpAtk = pos / 1000; save(); },
    format: s => Math.round(s.arpAtk * 1000) + ' ms',
    visible: s => s.musicOn && s.arpOn
  },
  {
    id: 'arpDec', section: 'music', label: 'Sequencer decay', kind: 'slider',
    parent: 'arpOn',
    min: 20, max: 2000, step: 10, def: 250, taper: 'log',
    get: s => Math.round(s.arpDec * 1000),
    set: (s, pos) => { s.arpDec = pos / 1000; save(); },
    format: s => Math.round(s.arpDec * 1000) + ' ms',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // Whole octaves either side of the written figure; the next note lands
    // in the new register.
    id: 'arpOct', section: 'music', label: 'Sequencer octave', kind: 'slider',
    parent: 'arpOn',
    min: -2, max: 2, step: 1, def: 0,
    get: s => s.arpOct,
    set: (s, pos) => { s.arpOct = pos; save(); },
    format: s => s.arpOct === 0 ? '0' : (s.arpOct > 0 ? '+' : '') + s.arpOct + ' oct',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // How wide the two lines and their echoes sit: 0 folds everything to the
    // centre, 100% pans hard left and right.
    id: 'arpSpread', section: 'music', label: 'Sequencer stereo spread', kind: 'slider',
    parent: 'arpOn',
    min: 0, max: 100, step: 1, def: 90,
    get: s => Math.round(s.arpSpread * 100),
    set: (s, pos) => { s.arpSpread = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpSpread * 100) + '%',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // A volume pulse at the strobe's own flash rate and in its waveform,
    // layered over everything else the level does; 0 is none, 100% swings
    // the line from full down to silence on every flash.
    id: 'arpStrobeAm', section: 'music', label: 'Vary with strobe', kind: 'slider',
    parent: 'arpOn',
    min: 0, max: 100, step: 1, def: 0,
    get: s => Math.round((s.arpStrobeAm || 0) * 100),
    set: (s, pos) => { s.arpStrobeAm = pos / 100; applyArp(); save(); },
    format: s => Math.round((s.arpStrobeAm || 0) * 100) + '%',
    visible: s => s.musicOn && s.arpOn
  },
  {
    id: 'arpSw', section: 'music', label: 'Sequencer volume sweep', kind: 'toggle',
    parent: 'arpOn',
    get: s => !!s.arpSwOn,
    set: (s, on) => { s.arpSwOn = !!on; applyArp(); save(); },
    format: s => s.arpSwOn ? 'On' : 'Off',
    visible: s => s.musicOn && s.arpOn
  },
  {
    id: 'arpSwLo', section: 'music', label: 'Sequencer sweep low', kind: 'slider',
    parent: 'arpSw',
    min: 0, max: 200, step: 1, def: 0,
    get: s => Math.round(s.arpSwLo * 100),
    set: (s, pos) => { s.arpSwLo = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpSwLo * 100) + '%',
    visible: s => s.musicOn && s.arpOn && s.arpSwOn
  },
  {
    id: 'arpSwHi', section: 'music', label: 'Sequencer sweep high', kind: 'slider',
    parent: 'arpSw',
    min: 0, max: 200, step: 1, def: 100,
    get: s => Math.round(s.arpSwHi * 100),
    set: (s, pos) => { s.arpSwHi = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpSwHi * 100) + '%',
    visible: s => s.musicOn && s.arpOn && s.arpSwOn
  },
  {
    id: 'arpSwPeriod', section: 'music', label: 'Sequencer sweep time', kind: 'slider',
    parent: 'arpSw',
    min: 2, max: 300, step: 1, def: 120, taper: 'log',
    get: s => s.arpSwPeriod,
    set: (s, pos) => { s.arpSwPeriod = pos; applyArp(); save(); },
    format: s => fmtSweep(s.arpSwPeriod) + ' / cycle',
    visible: s => s.musicOn && s.arpOn && s.arpSwOn
  },
  {
    id: 'arpSwWander', section: 'music', label: 'Sequencer sweep wander', kind: 'slider',
    parent: 'arpSw',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round(s.arpSwWander * 100),
    set: (s, pos) => { s.arpSwWander = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpSwWander * 100) + '%',
    visible: s => s.musicOn && s.arpOn && s.arpSwOn
  },
  {
    // Its share of the piano's room; the shared Reverb level still applies.
    id: 'arpRev', section: 'music', label: 'Sequencer reverb', kind: 'slider',
    parent: 'arpOn',
    min: 0, max: 200, step: 1, def: 100,
    get: s => Math.round(s.arpRev * 100),
    set: (s, pos) => { s.arpRev = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpRev * 100) + '%',
    visible: s => s.musicOn && s.arpOn
  },
  {
    id: 'bedOn', section: 'music', label: 'Ocean drone', kind: 'toggle',
    get: s => s.bedOn !== false,
    set: (s, on) => { s.bedOn = !!on; applyBedOn(); save(); },
    format: s => s.bedOn !== false ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  {
    id: 'bedVol', section: 'music', label: 'Drone level', kind: 'slider',
    parent: 'bedOn',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round(s.bedVol * 100),
    set: (s, pos) => { s.bedVol = pos / 100; applyBedVol(); save(); },
    format: s => Math.round(s.bedVol * 100) + '%',
    visible: s => s.musicOn && s.bedOn !== false
  },
  {
    // Which render of the drone plays: the same drone bounced at four detune
    // amounts (audio/music/manifest.json). A change crossfades to the new one.
    id: 'bedDetune', section: 'music', label: 'Drone detune', kind: 'segment', def: 152,
    parent: 'bedOn',
    options: [
      { value: 152, label: '.152' },
      { value: 188, label: '.188' },
      { value: 204, label: '.204' },
      { value: 220, label: '.220' }
    ],
    get: s => s.bedDetune,
    set: (s, v) => { s.bedDetune = v; applyBedDetune(); save(); },
    format: s => '.' + s.bedDetune,
    visible: s => s.musicOn && s.bedOn !== false
  },
  // The drone's filter sweep: the click train's set above, on the drone's own
  // low-pass (js/piano.js), with the same ranges, tapers and readouts.
  {
    id: 'bedLpf', section: 'music',
    parent: 'bedOn', label: 'Drone filter sweep', kind: 'toggle',
    get: s => s.bedLpfOn,
    set: (s, on) => { s.bedLpfOn = !!on; applyBedLpf(); save(); },
    format: s => s.bedLpfOn ? 'On' : 'Off',
    visible: s => s.musicOn && s.bedOn !== false
  },
  {
    id: 'bedLpfLo', section: 'music', label: 'Drone filter low', kind: 'slider',
    parent: 'bedLpf',
    min: 40, max: 4000, step: 10, def: 400, taper: 'log',
    get: s => s.bedLpfLo,
    set: (s, pos) => { s.bedLpfLo = pos; applyBedLpf(); save(); },
    format: s => fmtHz(s.bedLpfLo),
    visible: s => s.musicOn && s.bedOn !== false && s.bedLpfOn
  },
  {
    id: 'bedLpfHi', section: 'music', label: 'Drone filter high', kind: 'slider',
    parent: 'bedLpf',
    min: 500, max: 18000, step: 100, def: 12000, taper: 'log',
    get: s => s.bedLpfHi,
    set: (s, pos) => { s.bedLpfHi = pos; applyBedLpf(); save(); },
    format: s => fmtHz(s.bedLpfHi),
    visible: s => s.musicOn && s.bedOn !== false && s.bedLpfOn
  },
  {
    id: 'bedLpfPeriod', section: 'music', label: 'Drone filter sweep time', kind: 'slider',
    parent: 'bedLpf',
    min: 2, max: 300, step: 1, def: 90, taper: 'log',
    get: s => s.bedLpfPeriod,
    set: (s, pos) => { s.bedLpfPeriod = pos; applyBedLpf(); save(); },
    format: s => fmtSweep(s.bedLpfPeriod) + ' / cycle',
    visible: s => s.musicOn && s.bedOn !== false && s.bedLpfOn
  },
  {
    id: 'bedLpfWander', section: 'music', label: 'Drone filter wander', kind: 'slider',
    parent: 'bedLpf',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round(s.bedLpfWander * 100),
    set: (s, pos) => { s.bedLpfWander = pos / 100; applyBedLpf(); save(); },
    format: s => Math.round(s.bedLpfWander * 100) + '%',
    visible: s => s.musicOn && s.bedOn !== false && s.bedLpfOn
  },
  {
    id: 'bedLpfQ', section: 'music', label: 'Drone filter resonance', kind: 'slider',
    parent: 'bedLpf',
    min: 50, max: 600, step: 1, def: 71, taper: 'log',
    get: s => Math.round(s.bedLpfQ * 100),
    set: (s, pos) => { s.bedLpfQ = pos / 100; applyBedLpf(); save(); },
    format: s => s.bedLpfQ.toFixed(2),
    visible: s => s.musicOn && s.bedOn !== false && s.bedLpfOn
  },
  {
    // The filter's slope; 12 dB an octave is the single filter it always was,
    // 6 dB a gentle one-pole.
    id: 'bedLpfSlope', section: 'music', label: 'Drone filter rolloff', kind: 'segment', def: 12,
    parent: 'bedLpf',
    options: [
      { value: 6,  label: '6 dB' },
      { value: 12, label: '12 dB' },
      { value: 24, label: '24 dB' },
      { value: 36, label: '36 dB' },
      { value: 48, label: '48 dB' }
    ],
    get: s => s.bedLpfSlope,
    set: (s, v) => { s.bedLpfSlope = v; applyBedLpf(); save(); },
    format: s => s.bedLpfSlope + ' dB/oct',
    visible: s => s.musicOn && s.bedOn !== false && s.bedLpfOn
  },
  // The drone's reverb: its own feed into the piano's room, switched and
  // levelled here (the room's wet level, 'Reverb' below, still applies to
  // piano and drone alike). Under it, the sweep moves that feed between a
  // low and a high share of the level, by the same motion as the filter.
  {
    id: 'bedRev', section: 'music',
    parent: 'bedOn', label: 'Drone reverb', kind: 'toggle',
    get: s => s.bedRevOn,
    set: (s, on) => { s.bedRevOn = !!on; applyBedVerb(); save(); },
    format: s => s.bedRevOn ? 'On' : 'Off',
    visible: s => s.musicOn && s.bedOn !== false
  },
  {
    id: 'bedRevLevel', section: 'music', label: 'Drone reverb level', kind: 'slider',
    parent: 'bedRev',
    min: 0, max: 200, step: 1, def: 100,
    get: s => Math.round(s.bedRevLevel * 100),
    set: (s, pos) => { s.bedRevLevel = pos / 100; applyBedVerb(); save(); },
    format: s => Math.round(s.bedRevLevel * 100) + '%',
    visible: s => s.musicOn && s.bedOn !== false && s.bedRevOn
  },
  {
    id: 'bedVerb', section: 'music', label: 'Drone reverb sweep', kind: 'toggle',
    parent: 'bedRev',
    get: s => s.bedVerbOn,
    set: (s, on) => { s.bedVerbOn = !!on; applyBedVerb(); save(); },
    format: s => s.bedVerbOn ? 'On' : 'Off',
    visible: s => s.musicOn && s.bedOn !== false && s.bedRevOn
  },
  {
    id: 'bedVerbLo', section: 'music', label: 'Drone reverb low', kind: 'slider',
    parent: 'bedVerb',
    min: 0, max: 200, step: 1, def: 50,
    get: s => Math.round(s.bedVerbLo * 100),
    set: (s, pos) => { s.bedVerbLo = pos / 100; applyBedVerb(); save(); },
    format: s => Math.round(s.bedVerbLo * 100) + '%',
    visible: s => s.musicOn && s.bedOn !== false && s.bedRevOn && s.bedVerbOn
  },
  {
    id: 'bedVerbHi', section: 'music', label: 'Drone reverb high', kind: 'slider',
    parent: 'bedVerb',
    min: 0, max: 200, step: 1, def: 150,
    get: s => Math.round(s.bedVerbHi * 100),
    set: (s, pos) => { s.bedVerbHi = pos / 100; applyBedVerb(); save(); },
    format: s => Math.round(s.bedVerbHi * 100) + '%',
    visible: s => s.musicOn && s.bedOn !== false && s.bedRevOn && s.bedVerbOn
  },
  {
    id: 'bedVerbPeriod', section: 'music', label: 'Drone reverb sweep time', kind: 'slider',
    parent: 'bedVerb',
    min: 2, max: 300, step: 1, def: 120, taper: 'log',
    get: s => s.bedVerbPeriod,
    set: (s, pos) => { s.bedVerbPeriod = pos; applyBedVerb(); save(); },
    format: s => fmtSweep(s.bedVerbPeriod) + ' / cycle',
    visible: s => s.musicOn && s.bedOn !== false && s.bedRevOn && s.bedVerbOn
  },
  {
    id: 'bedVerbWander', section: 'music', label: 'Drone reverb wander', kind: 'slider',
    parent: 'bedVerb',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round(s.bedVerbWander * 100),
    set: (s, pos) => { s.bedVerbWander = pos / 100; applyBedVerb(); save(); },
    format: s => Math.round(s.bedVerbWander * 100) + '%',
    visible: s => s.musicOn && s.bedOn !== false && s.bedRevOn && s.bedVerbOn
  },
  {
    // The room every music voice shares: the piano, the drone and the
    // arpeggio all feed this one reverb, and the per-voice rows (Drone
    // reverb level, Arpeggio reverb) only set each voice's share of it.
    id: 'musicRevOn', section: 'music', label: 'Master reverb', kind: 'toggle',
    get: s => s.musicRevOn !== false,
    set: (s, on) => { s.musicRevOn = !!on; applyPianoReverb(); save(); },
    format: s => s.musicRevOn !== false ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  {
    id: 'pianoReverb', section: 'music', label: 'Reverb level', kind: 'slider',
    parent: 'musicRevOn',
    min: 0, max: 200, step: 1, def: 100,
    get: s => Math.round(s.pianoReverb * 100),
    set: (s, pos) => { s.pianoReverb = pos / 100; applyPianoReverb(); save(); },
    format: s => Math.round(s.pianoReverb * 100) + '%',
    visible: s => s.musicOn && s.musicRevOn !== false
  },
  {
    id: 'pianoRevTime', section: 'music', label: 'Reverb decay', kind: 'slider',
    parent: 'musicRevOn',
    min: 1, max: 15, step: 0.5, def: 4.5,
    get: s => s.pianoRevTime,
    set: (s, pos) => { s.pianoRevTime = pos; rebuildPianoIR(); save(); },
    format: s => s.pianoRevTime.toFixed(1) + 's',
    visible: s => s.musicOn && s.musicRevOn !== false
  },
  {
    id: 'cloudsOn', section: 'music', label: 'Clouds', kind: 'segment',
    options: [
      { value: true,  label: 'On',  domId: 'clOn' },
      { value: false, label: 'Off', domId: 'clOff' }
    ],
    get: s => s.cloudsOn,
    set: (s, v) => setCloudsOn(s, !!v),
    format: s => s.cloudsOn ? 'on' : 'off',
    visible: s => s.musicOn
  },
  {
    id: 'cloudVol', section: 'music', label: 'Clouds level', kind: 'slider',
    parent: 'cloudsOn',
    min: 0, max: 100, step: 1, def: 60,
    get: s => Math.round(s.cloudVol * 100),
    set: (s, pos) => { s.cloudVol = pos / 100; save(); },
    format: s => Math.round(s.cloudVol * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  {
    id: 'cloudDensity', section: 'music', label: 'Clouds density', kind: 'slider',
    parent: 'cloudsOn',
    min: 20, max: 250, step: 5, def: 100,
    get: s => Math.round(s.cloudDensity * 100),
    set: (s, pos) => { s.cloudDensity = pos / 100; save(); },
    format: s => Math.round(s.cloudDensity * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  {
    id: 'cloudPhrase', section: 'music', label: 'Falling figure', kind: 'slider',
    parent: 'cloudsOn',
    min: 0, max: 100, step: 1, def: 35,
    get: s => Math.round(s.cloudPhrase * 100),
    set: (s, pos) => { s.cloudPhrase = pos / 100; save(); },
    format: s => Math.round(s.cloudPhrase * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  {
    id: 'cloudReverb', section: 'music', label: 'Clouds reverb', kind: 'slider',
    parent: 'cloudsOn',
    min: 0, max: 150, step: 1, def: 100,
    get: s => Math.round(s.cloudReverb * 100),
    set: (s, pos) => { s.cloudReverb = pos / 100; applyCloudReverb(); save(); },
    format: s => Math.round(s.cloudReverb * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  }
];

// ---------- Atmosphere section (the drawer group; the mixer window is its
// own 'mixer' section further down) ----------
const atmosphereControls = [
  {
    id: 'ambOn', section: 'atmosphere', label: 'Ambience', kind: 'segment',
    options: [
      { value: true,  label: 'On',  domId: 'amOn' },
      { value: false, label: 'Off', domId: 'amOff' }
    ],
    get: s => s.ambOn,
    set: (s, v) => setAmbOn(s, !!v),
    format: s => s.ambOn ? 'on' : 'off'
  },
  {
    id: 'ambVol', section: 'atmosphere', label: 'Ambience level', kind: 'slider',
    min: 0, max: 100, step: 1, def: 18,
    get: s => Math.round(s.ambVol * 100),
    set: (s, pos) => { s.ambVol = pos / 100; applyAmbVol(); save(); },
    format: s => Math.round(s.ambVol * 100) + '%',
    visible: s => s.ambOn
  },
  // Opens the mixer overlay. v0's handler also closes the drawer
  // (togglePanel(false)) before dispatching the open event; the drawer's
  // open flag is plain S state, so it is set directly here rather than
  // routed through a visual-side helper.
  {
    id: 'ambMixerOpen', section: 'atmosphere', label: 'Open atmosphere mixer', kind: 'action',
    act: s => { s.panelOpen = false; mixerOpenHook(true); },
    visible: s => s.ambOn
  },
  {
    id: 'ambReverb', section: 'atmosphere', label: 'Reverb', kind: 'slider',
    min: 0, max: 150, step: 1, def: 0,
    get: s => Math.round(s.ambReverb * 100),
    set: (s, pos) => { s.ambReverb = pos / 100; applyAmbReverb(); save(); },
    format: s => Math.round(s.ambReverb * 100) + '%',
    visible: s => s.ambOn
  },
  {
    id: 'ambRevTime', section: 'atmosphere', label: 'Reverb decay', kind: 'slider',
    min: 1, max: 15, step: 0.5, def: 4.5,
    get: s => s.ambRevTime,
    set: (s, pos) => { s.ambRevTime = pos; rebuildAmbIR(); save(); },
    format: s => s.ambRevTime.toFixed(1) + 's',
    visible: s => s.ambOn
  },
  {
    // How long the drift's crossfade from one place to the next takes. Read
    // by js/ambience.js each time a crossfade starts, so a change applies
    // from the next move on.
    id: 'ambDriftFade', section: 'atmosphere', label: 'Drift transition', kind: 'slider',
    min: 4, max: 120, step: 1, def: 12,
    get: s => s.ambDriftFadeS,
    set: (s, pos) => { s.ambDriftFadeS = pos; save(); },
    format: s => s.ambDriftFadeS + 's',
    visible: s => s.ambOn
  },
  {
    // How much of the time the children are there while the drift runs
    // (js/ambience.js kidsShare): 0 never, 100% always, and the default the
    // two thirds the visits and absences always averaged.
    id: 'ambKidsFreq', section: 'atmosphere', label: 'Children', kind: 'slider',
    min: 0, max: 100, step: 1, def: 67,
    get: s => Math.round(s.ambKidsFreq * 100),
    set: (s, pos) => { s.ambKidsFreq = pos / 100; save(); },
    format: s => s.ambKidsFreq <= 0 ? 'never' : s.ambKidsFreq >= 1 ? 'always' : Math.round(s.ambKidsFreq * 100) + '%',
    visible: s => s.ambOn
  }
];

// ---------- Quick bar ----------
// The chips' labels are re-read about five times a second while the chrome
// is up (widgets.js actionLabel). The on/off ones are whole literals, and the
// rest remember the last part they were built from, so a label that has not
// changed is handed back as the same string instead of a fresh concatenation.
function prefixed(prefix) {
  let lastPart, lastText = '';
  return part => {
    if (part !== lastPart) { lastPart = part; lastText = prefix + part; }
    return lastText;
  };
}
const quickVisual = prefixed('visual: '), quickClick = prefixed('click: '), quickColor = prefixed('color: ');

const quickControls = [
  {
    id: 'ambQuick', section: 'quick', label: 'Open mixer', kind: 'action',
    act: s => { s.panelOpen = false; mixerOpenHook(true); },
    format: s => s.ambOn ? 'ambience: on' : 'ambience: off'
  },
  {
    id: 'musicQuick', section: 'quick', label: 'Music on or off', kind: 'action',
    act: s => setMusicOn(s, !s.musicOn),
    format: s => s.musicOn ? 'music: on' : 'music: off'
  },
  {
    id: 'visualQuick', section: 'quick', label: 'Visual layers', kind: 'action',
    act: s => cycleVisualMode(s),
    format: s => quickVisual(visualModeNow(s))
  },
  {
    id: 'toneQuick', section: 'quick', label: 'Sine tone on or off', kind: 'action',
    act: s => setToneOn(s, !s.toneOn),
    format: s => s.toneOn ? 'tone: on' : 'tone: off'
  },
  {
    id: 'clickQuick', section: 'quick', label: 'Click loudness', kind: 'action',
    act: s => cycleClickStep(s),
    format: s => quickClick(clickStepNow(s))
  },
  {
    id: 'textQuick', section: 'quick', label: 'Words on or off', kind: 'action',
    // The one owner of the Text layer is the checkbox schema-visual.js
    // exposes; this corner button is a second surface on the exact same
    // S.layers.text flag, same as v0 routed it through $('lText').click().
    act: s => { s.layers.text = !s.layers.text; save(); },
    format: s => s.layers.text ? 'text: on' : 'text: off'
  },
  {
    id: 'colorQuick', section: 'quick', label: 'Color mode', kind: 'action',
    act: s => cycleColorMode(s),
    format: s => quickColor(s.colorMode)
  }
];

// ---------- Transport ----------
// tpVol's drag track is a second surface on the 'vol' control above (v0
// dispatches straight into #vol's own input handler), so it has no separate
// entry here: a transport screen reads and drives byId('vol') for the fader
// and uses vmute below for the speaker glyph.
const transportControls = [
  {
    id: 'tpPlay', section: 'transport', label: 'start / stop', kind: 'action',
    // Starting or stopping a session also resets the strobe clock and seeds
    // the tunnel, both outside v1/core. The hook is composed by integration
    // from audioToggleEffects above plus those visual and platform pieces.
    act: s => toggleRunHook(s),
    format: s => s.running ? 'pause' : 'play'
  },
  {
    id: 'vmute', section: 'transport', label: 'mute / unmute', kind: 'toggle',
    get: audioLayerOn,
    set: (s, on) => setAudioLayer(s, !!on),
    format: s => audioLayerOn(s) ? 'unmuted' : 'muted'
  }
];

// ---------- Atmosphere mixer: fixed rows ----------
// Six fixed faders, each a second surface on a control already defined
// above: the mixer fader writes the same S field and calls the same apply
// function its drawer counterpart does, exactly as v0's per-channel
// `$(channel.fader).oninput` dispatched into `$(channel.drawer)`.
//
// Each fader has a mute and a solo beside it, the same pair every atmosphere
// recording has (atmosphere.js), ids built from the fader's own: mixFundMute,
// mixFundSolo and so on. They write S.chanMute / S.chanSolo, which only v1
// shows and store.js keeps in the v1 extra record, and any change re-applies
// every gate in the mix, since a solo here silences the recordings too.
function gateControls(id, ch, label) {
  return [
    {
      id: id + 'Mute', section: 'mixer', label: 'Mute ' + label, kind: 'toggle',
      get: s => !!s.chanMute[ch],
      set: (s, on) => { s.chanMute[ch] = !!on; applyMixGates(); save(); },
      format: s => s.chanMute[ch] ? 'M' : ''
    },
    {
      id: id + 'Solo', section: 'mixer', label: 'Solo ' + label, kind: 'toggle',
      get: s => !!s.chanSolo[ch],
      set: (s, on) => { s.chanSolo[ch] = !!on; applyMixGates(); save(); },
      format: s => s.chanSolo[ch] ? 'S' : ''
    }
  ];
}

const mixerControls = [
  ...gateControls('mixFund', 'fund', 'Fundamental'),
  ...gateControls('mixHarm', 'harm', 'Harmonics'),
  ...gateControls('mixPulse', 'pulse', 'Pulse train'),
  ...gateControls('mixPiano', 'piano', 'Piano'),
  ...gateControls('mixClouds', 'clouds', 'Clouds'),
  ...gateControls('mixDrone', 'drone', 'Ocean drone'),
  ...gateControls('mixArp', 'arp', 'Sequencer'),
  {
    id: 'mixFund', section: 'mixer', label: 'Fundamental', kind: 'slider',
    min: 0, max: 100, step: 1, def: 83,
    get: s => ampToPos(s.toneVol),
    set: (s, pos) => { s.toneVol = posToAmp(pos); applyLevel('toneLevel'); save(); },
    format: s => ampToDb(s.toneVol) + ' dB',
    parse: parseDb
  },
  {
    id: 'mixHarm', section: 'mixer', label: 'Harmonics', kind: 'slider',
    min: 0, max: 100, step: 1, def: 87,
    get: s => ampToPos(s.harmVol),
    set: (s, pos) => { s.harmVol = posToAmp(pos); applyLevel('harmLevel'); save(); },
    format: s => ampToDb(s.harmVol) + ' dB',
    parse: parseDb
  },
  {
    id: 'mixPulse', section: 'mixer', label: 'Pulse train', kind: 'slider',
    min: 0, max: 100, step: 1, def: 0,
    get: s => ampToPos(pipGet(s, 'vol')),
    set: (s, pos) => { pipSet(s, 'vol', posToAmp(pos)); applyLevel('clickLevel'); applyLevel('clickSend'); save(); },
    format: s => ampToDb(pipGet(s, 'vol')) + ' dB',
    parse: parseDb
  },
  {
    id: 'mixPiano', section: 'mixer', label: 'Piano', kind: 'slider',
    min: 0, max: 100, step: 1, def: 90,
    get: s => Math.round(s.pianoVol * 100),
    set: (s, pos) => { s.pianoVol = pos / 100; save(); },
    format: s => Math.round(s.pianoVol * 100) + '%'
  },
  {
    id: 'mixClouds', section: 'mixer', label: 'Clouds', kind: 'slider',
    min: 0, max: 100, step: 1, def: 60,
    get: s => Math.round(s.cloudVol * 100),
    set: (s, pos) => { s.cloudVol = pos / 100; save(); },
    format: s => Math.round(s.cloudVol * 100) + '%'
  },
  {
    id: 'mixDrone', section: 'mixer', label: 'Ocean drone', kind: 'slider',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round(s.bedVol * 100),
    set: (s, pos) => { s.bedVol = pos / 100; applyBedVol(); save(); },
    format: s => Math.round(s.bedVol * 100) + '%'
  },
  {
    id: 'mixArp', section: 'mixer', label: 'Sequencer', kind: 'slider',
    min: 0, max: 100, step: 1, def: 50,
    get: s => Math.round(s.arpVol * 100),
    set: (s, pos) => { s.arpVol = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpVol * 100) + '%'
  },
  {
    id: 'ambMixerMaster', section: 'mixer', label: 'Ambience', kind: 'slider',
    min: 0, max: 100, step: 1, def: 18,
    get: s => Math.round(s.ambVol * 100),
    set: (s, pos) => { s.ambVol = pos / 100; applyAmbVol(); save(); },
    format: s => Math.round(s.ambVol * 100) + '%'
  },
  {
    id: 'ambMixerReverb', section: 'mixer', label: 'Reverb', kind: 'slider',
    min: 0, max: 150, step: 1, def: 0,
    get: s => Math.round(s.ambReverb * 100),
    set: (s, pos) => { s.ambReverb = pos / 100; applyAmbReverb(); save(); },
    format: s => Math.round(s.ambReverb * 100) + '%'
  },
  {
    id: 'ambMixerDrift', section: 'mixer', label: 'Drift', kind: 'toggle',
    get: s => s.ambDrift,
    set: (s, on) => {
      s.ambDrift = !!on;
      // The scheduler itself lives in atmosphere.js, which this file already
      // imports statically at the top.
      if (s.ambDrift) startDrift(); else stopDrift();
      save();
    },
    format: s => s.ambDrift ? 'on' : 'off'
  },
  {
    id: 'ambMixerPower', section: 'mixer', label: 'Toggle atmosphere', kind: 'toggle',
    get: s => s.ambOn,
    set: (s, on) => setAmbOn(s, !!on),
    format: s => s.ambOn ? 'on' : 'off'
  },
  {
    id: 'ambMixerCopy', section: 'mixer', label: 'Copy mixer settings', kind: 'action',
    act: s => copyHook(mixerSettingsText(s))
  },
  {
    id: 'ambMixerClose', section: 'mixer', label: 'Close mixer', kind: 'action',
    act: () => mixerOpenHook(false)
  }
];

// The JSON body v0's copy button places on the clipboard, byte for byte the
// same shape (ambience.js's AMBIENCE_SOURCES gives the per-layer names).
function mixerSettingsText(s) {
  return JSON.stringify({
    atmosphere: {
      enabled: s.ambOn,
      masterLevel: Math.round(s.ambVol * 100),
      reverbLevel: Math.round(s.ambReverb * 100),
      layers: s.ambLayers.map(layer => {
        const source = AMBIENCE_SOURCES.find(item => item.id === layer.source);
        return {
          id: layer.source,
          source: source ? source.name : layer.source,
          level: Math.round(layer.level * 100),
          muted: layer.muted,
          solo: layer.solo
        };
      })
    }
  }, null, 2);
}

export const AUDIO_CONTROLS = [
  ...audioControls, ...musicControls, ...atmosphereControls,
  ...quickControls, ...transportControls, ...mixerControls
];
