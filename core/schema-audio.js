// The audio side of the control schema: the Audio, Music and Atmosphere
// drawer groups, the quick bar, the transport, and the fixed rows of the
// atmosphere mixer. Owns everything a listener touches.
//
// Every control below is a DOM-free port of one handler in v0/js/ui.js. Where
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
import { S } from '../js/state.js';
import { refreshStrobeAm } from '../js/strobe-am.js';
import { posToAmp, ampToPos, ampToDb, LEVEL_RANGE_DB } from '../js/util.js';
import { setColorFromPicker } from '../js/color.js';
import { onPhone } from '../js/handheld.js';
import { chirpDurationMs } from '../js/chirp.js';
import {
  setParam, applyLevel, applyAudioShape, applyHarmonics, applyReverbMix,
  rebuildClickIR, setAmRate, audioOn, audioOff, applyAudioGain,
  warmDevice, isDeviceWarm, refreshChirp, setPipShape, applyPipLpf, applyAmOn, applyToneBreath
} from '../js/audio.js';
import { pianoOn, pianoOff, applyPianoTrim, applyPianoReverb, applyPianoHP, rebuildPianoIR, applyRevType, applyPianoRevShape, pianoEffectiveReverb, pianoEffectiveRevTime, applyBedVol, applyBedOn, applyArp, applyBedLpf, applyBedVerb, applyBedDetune, applyBedAm, bedEffectiveAm, arpEffectiveVol, arpEffectiveAm } from '../js/piano.js';
import { cloudsOn, cloudsOff, applyCloudTrim, applyCloudReverb, applyCloudAm, rebuildCloudIR } from '../js/clouds.js';
import {
  applyChoir, applyChoirVol, applyChoirOn, applyChoirAm, choirEffectiveAm,
  choirEffectiveLevel, choirEffectiveStack, choirEffectiveDensity
} from '../js/choir.js';
import { ambienceOn, ambienceOff, applyAmbVol, applyAmbReverb, rebuildAmbIR, AMBIENCE_SOURCES } from '../js/ambience.js';
import { applyMixGates } from '../js/mixgate.js';
import { MUSIC_LAYERS, applyLayerOn, applyLayerVol } from '../js/layers.js';
import { layerOnKey, layerVolKey, layerMixId, layerDrawerId } from '../js/layer-defs.js';
import {
  applyLiveOn, applyLiveDevice, applyLiveLevel, applyLiveReverb, applyLiveLatency,
  applyLiveRevTime, applyLiveComp, liveLatencyNow, liveReductionNow, liveInputs
} from '../js/livesound.js';
import { startDrift, stopDrift } from './atmosphere.js';
import { pipDipNow, toneVolMulNow, toneAmMulNow } from './audio-mirror.js';
import { save, saveLive } from './store.js';
import { subDrawer } from './schema-visual.js';
import { varianceRows } from './schema-variance.js';

// ---------- shared helpers, ported from v0/js/ui.js closures ----------

// Readouts for the pip filter: kHz above a thousand, and a sweep time in
// seconds that switches to minutes once it gets long.
const fmtHz = hz => hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + ' kHz' : Math.round(hz) + ' Hz';
const fmtSweep = sec => sec < 90 ? Math.round(sec) + 's'
  : Math.floor(sec / 60) + 'm ' + String(Math.round(sec % 60)).padStart(2, '0') + 's';

// v0 has no S field for the layers-row Audio checkbox; it only ever reads
// $('lAudio').checked, round-tripped through the saved settings JSON under
// the key 'audioOnBoot'. store.js parks that as a real scalar, S.audioOnBoot,
// loaded and saved under that same key so v0 and v1 stay byte-compatible.
// Anywhere v0 read $('lAudio').checked (v0/js/main.js's resume-on-first-gesture
// logic, for one) the v1 equivalent is S.audioOnBoot.
//
// state.js never seeds this field (it is not a v0 S field at all), and
// store.js's load() only writes it when there is a saved session to read;
// on a genuinely first visit S.audioOnBoot is left undefined. v0's markup
// default for the checkbox is checked, so undefined reads as on here rather
// than off, the same default a fresh <input checked> would give.
const audioLayerOn = s => s.audioOnBoot !== false;
// The choir's rows show while the music and the choir both play.
const choirShows = s => s.musicOn && s.choirOn;
// A Music window trim from its slider's 0..100 position: a share of the
// voice's level, 0 to 1 (see musTone below).
const trimOf = pos => Math.max(0, Math.min(1, (Number(pos) || 0) / 100));

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
  // the bus holds its trim while the clouds are off (clouds.js); on picks
  // the trim up again
  if (on) applyCloudTrim();
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

// Where the level's bar sits with the variance's dip taken off it: the dip
// is a share of the amplitude, and the fader spreads decibels evenly over its
// travel, so the share comes off as that many decibels' worth of positions
// below the set one. A dip to nothing is the foot of the bar. The tone's
// level reads its own dip the same way.
const dippedPos = (pos, dip) => dip > 0 ? Math.max(0, pos + 20 * Math.log10(Math.min(1, dip)) / DB_PER_POS) : 0;
const pipDippedPos = s => dippedPos(ampToPos(pipGet(s, 'vol')), pipDipNow());
const toneDippedPos = s => dippedPos(ampToPos(s.toneVol), toneVolMulNow());

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

// ---------- quick bar cycles, ported from v0/js/ui.js ----------

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
// Three things a control here needs to trigger live outside core: running
// the session (which also resets the strobe clock and seeds the tunnel, both
// lane A1's), showing or hiding the mixer overlay (a screen, wave 2), and
// writing to the clipboard (only platform may touch the outside world).
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
  { id: 'live',       title: 'Live Sound' },
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
  // The Music window's trims for the tone and the pulse (ui/screens/
  // music.js). Each is how much of the voice's own level plays, 0 to 100%,
  // where 100% is exactly what the drawer and the Levels window set: the
  // tone's trim takes the fundamental and its harmonics together, the
  // pulse's the pips dry and their room, click or chirp. Never drawer rows
  // (visible false, as musicOn is); the Music window is their only face.
  {
    id: 'musTone', section: 'audio', label: 'Tone trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musTone ?? 1) * 100),
    set: (s, pos) => { s.musTone = trimOf(pos); applyLevel('toneLevel'); applyLevel('harmLevel'); save(); },
    format: s => Math.round((s.musTone ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    id: 'musPulse', section: 'audio', label: 'Click trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musPulse ?? 1) * 100),
    set: (s, pos) => { s.musPulse = trimOf(pos); applyLevel('clickLevel'); applyLevel('clickSend'); save(); },
    format: s => Math.round((s.musPulse ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    // The pulse envelope on the tone and its harmonics. Off plays them
    // steady (applyAmOn in js/audio.js takes the envelope's depth to zero);
    // the rate below keeps tracking underneath, so the pips are untouched and
    // switching back on picks the pulse up in step. Like a voice's switch it
    // is drawn only on its sub-drawer's strip, never as a row, and the two
    // rows inside slide away while it is off.
    id: 'amMod', section: 'audio', label: 'Amplitude modulation', kind: 'toggle',
    get: s => s.amModOn !== false,
    set: (s, on) => { s.amModOn = !!on; applyAmOn(); save(); },
    format: s => s.amModOn !== false ? 'On' : 'Off'
  },
  subDrawer('audioAmDrawer', 'Amplitude modulation', 'audio', ['amLinked', 'amRate'], 'amMod'),
  {
    // How the pulse rate is set: free, from Pulse rate below, or locked to
    // the strobe's frequency. It comes first in the drawer, since it
    // decides whether that slider is live.
    id: 'amLinked', section: 'audio', label: 'Audio mode', kind: 'segment',
    hideLabel: true,
    parent: 'audioAmDrawer',
    options: [
      { value: false, label: 'Free',            domId: 'aFree' },
      { value: true,  label: 'Link to visual',  domId: 'aLink' }
    ],
    get: s => s.amLinked,
    set: (s, v) => setAmLinked(s, !!v),
    format: s => s.amLinked ? 'Link to visual' : 'Free',
    visible: s => s.amModOn !== false
  },
  {
    id: 'amRate', section: 'audio', label: 'Pulse rate', kind: 'slider',
    parent: 'audioAmDrawer',
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
    enabled: s => !s.amLinked,
    visible: s => s.amModOn !== false
  },
  // ---- the four voices, each its own switch and then a sub-drawer whose
  // strip carries that switch (subDrawer in schema-visual.js, its switchId),
  // with the voice's rows straight after it. The switch is drawn on the strip
  // only, never as a row; its rows keep their own rules, so a voice switched
  // off still opens, its rows hidden until it is on ----
  {
    id: 'aTone', section: 'audio', label: 'Sine tone', kind: 'toggle',
    get: s => s.toneOn,
    set: (s, on) => setToneOn(s, !!on),
    format: s => s.toneOn ? 'On' : 'Off'
  },
  subDrawer('audioToneDrawer', 'Tone', 'audio', ['carrier', 'toneVol'], 'aTone'),
  {
    id: 'carrier', section: 'audio', label: 'Carrier', kind: 'slider',
    parent: 'audioToneDrawer',
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
    id: 'toneVol', section: 'audio', label: 'Level', kind: 'slider',
    parent: 'audioToneDrawer',
    min: 0, max: 100, step: 1, def: 83,
    get: s => ampToPos(s.toneVol),
    set: (s, pos) => { s.toneVol = posToAmp(pos); applyLevel('toneLevel'); save(); },
    format: s => ampToDb(s.toneVol) + ' dB',
    parse: parseDb,
    visible: s => s.toneOn
  },
  // The level's dip, the choir's own: over one speed cycle it eases from the
  // setting down by this share and back (js/audio.js, the tone's two
  // variances). The bar's brighter fill is the level as it plays, read back
  // from the page in worker mode (toneVolMulNow, core/audio-mirror.js).
  ...varianceRows('toneVol', {
    music: true, name: 'Level', apply: applyToneBreath,
    parent: 'audioToneDrawer', visible: s => s.toneOn,
    effective: toneDippedPos
  }),
  {
    // The tone's Vary with strobe: how deep its pulse goes, times the master
    // strobe, so bringing the strobe to 0 leaves the tone steady. The pulse
    // is the Amplitude modulation envelope above (applyAmOn in js/audio.js),
    // not a stage of its own; 100% is that envelope at its full depth, the
    // tone as it always was, and 0 is no pulse. Unset reads as 100%.
    id: 'toneStrobeAm', section: 'audio', label: 'Vary with strobe', kind: 'slider',
    parent: 'audioToneDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((typeof s.toneStrobeAm === 'number' ? s.toneStrobeAm : 1) * 100),
    set: (s, pos) => { s.toneStrobeAm = pos / 100; applyAmOn(); save(); },
    format: s => Math.round((typeof s.toneStrobeAm === 'number' ? s.toneStrobeAm : 1) * 100) + '%',
    visible: s => s.toneOn
  },
  // The pulse depth's dip, the choir's and drone's own, taken off the tone's
  // setting before the master strobe scales it (js/audio.js, toneAmDepth).
  ...varianceRows('toneStrobeAm', {
    music: true, name: 'Pulse', apply: applyToneBreath,
    parent: 'audioToneDrawer', visible: s => s.toneOn,
    effective: s => (typeof s.toneStrobeAm === 'number' ? s.toneStrobeAm : 1) * toneAmMulNow() * 100
  }),
  {
    id: 'aClick', section: 'audio', label: 'Click train', kind: 'toggle',
    get: s => s.clickOn,
    set: (s, on) => setClickOn(s, !!on),
    format: s => s.clickOn ? 'On' : 'Off'
  },
  subDrawer('audioPulseDrawer', 'Click', 'audio', ['clickMode', 'clickVol'], 'aClick'),
  {
    id: 'clickMode', section: 'audio', label: 'Mode', kind: 'segment',
    hideLabel: true,
    parent: 'audioPulseDrawer',
    options: [
      { value: 'click', label: 'Click', domId: 'cmClick' },
      { value: 'chirp', label: 'Chirp', domId: 'cmChirp' }
    ],
    get: s => s.clickMode,
    set: (s, mode) => setClickModeState(s, mode),
    format: s => s.clickMode,
    visible: s => s.clickOn
  },
  // The level first under the mode, since it answers to whichever shape the
  // mode has chosen, with its variance folded away beneath it. The variance
  // is the worklet's own dip (js/worklet.js): over each variance time the
  // pips, dry and their room alike, ease down from the level by up to the
  // variance's share of it and back, never above. The bar's brighter fill is
  // that dip as it plays (pipDipNow, core/audio-mirror.js), on either thread.
  {
    id: 'clickVol', section: 'audio', label: 'Level', kind: 'slider',
    parent: 'audioPulseDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: s => ampToPos(pipGet(s, 'vol')),
    set: (s, pos) => { pipSet(s, 'vol', posToAmp(pos)); applyLevel('clickLevel'); applyLevel('clickSend'); save(); },
    format: s => ampToDb(pipGet(s, 'vol')) + ' dB',
    parse: parseDb,
    visible: s => s.clickOn
  },
  // The two keys follow the live shape, the click's or the chirp's.
  ...varianceRows('clickVol', {
    music: true, amount: s => pipKey(s, 'modDep'), period: s => pipKey(s, 'modPer'),
    ids: ['clickModDepth', 'clickModRate'], labels: ['Variance', 'Variance time'],
    periodMin: 1, periodMax: 60, periodDef: 26, apply: applyHarmonics,
    parent: 'audioPulseDrawer', visible: s => s.clickOn, effective: pipDippedPos
  }),
  {
    id: 'pipMs', section: 'audio', label: 'Pip width', kind: 'slider',
    parent: 'audioPulseDrawer',
    min: 0.5, max: 25, step: 0.5, def: 8,
    get: s => s.pipMs,
    set: (s, pos) => { s.pipMs = pos; setParam('pipMs', s.pipMs); save(); },
    format: s => s.pipMs.toFixed(1) + ' ms',
    visible: s => s.clickOn && s.clickMode === 'click'
  },
  {
    id: 'chirpLow', section: 'audio', label: 'Chirp low', kind: 'slider',
    parent: 'audioPulseDrawer',
    min: 40, max: 2000, step: 10, def: 150,
    get: s => s.chirpLowHz,
    set: (s, pos) => { s.chirpLowHz = pos; refreshChirp(); save(); },
    format: s => s.chirpLowHz + ' Hz',
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'chirpHigh', section: 'audio', label: 'Chirp high', kind: 'slider',
    parent: 'audioPulseDrawer',
    min: 1000, max: 12000, step: 100, def: 6000,
    get: s => s.chirpHighHz,
    set: (s, pos) => { s.chirpHighHz = pos; refreshChirp(); save(); },
    format: s => s.chirpHighHz + ' Hz',
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'chirpComp', section: 'audio', label: 'Delay compensation', kind: 'slider',
    parent: 'audioPulseDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round(s.chirpComp * 100),
    set: (s, pos) => { s.chirpComp = pos / 100; refreshChirp(); save(); },
    format: s => Math.round(s.chirpComp * 100) + '%',
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'chirpTilt', section: 'audio', label: 'Spectral tilt', kind: 'slider',
    parent: 'audioPulseDrawer',
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
    id: 'chirpLen', section: 'audio', label: 'Chirp length', kind: 'action',
    parent: 'audioPulseDrawer',
    act: () => {},
    format: s => chirpDurationMs(s.chirpLowHz, s.chirpHighHz).toFixed(1) + ' ms',
    enabled: () => false,
    visible: s => s.clickOn && s.clickMode === 'chirp'
  },
  {
    id: 'clickReverb', section: 'audio', label: 'Click / Chirp reverb', kind: 'slider',
    parent: 'audioPulseDrawer',
    min: 0, max: 100, step: 1, def: 37,
    get: s => Math.round(pipGet(s, 'reverb') * 100),
    set: (s, pos) => { pipSet(s, 'reverb', pos / 100); applyReverbMix(); applyLevel('clickSend'); save(); },
    format: s => Math.round(pipGet(s, 'reverb') * 100) + '%',
    visible: s => s.clickOn
  },
  {
    id: 'clickRevTime', section: 'audio', label: 'Click / Chirp reverb time', kind: 'slider',
    parent: 'audioPulseDrawer',
    min: 0.2, max: 8, step: 0.1, def: 0.5,
    get: s => pipGet(s, 'revTime'),
    set: (s, pos) => { pipSet(s, 'revTime', pos); rebuildClickIR(); save(); },
    format: s => pipGet(s, 'revTime').toFixed(1) + 's',
    visible: s => s.clickOn
  },
  // The lowpass sweep. One filter for the whole train, click or chirp, so it
  // sits after the shape's own rows and is not swapped by the mode.
  {
    id: 'pipLpf', section: 'audio', label: 'Filter sweep', kind: 'toggle',
    parent: 'audioPulseDrawer',
    get: s => s.pipLpfOn,
    set: (s, on) => { s.pipLpfOn = !!on; applyPipLpf(); save(); },
    format: s => s.pipLpfOn ? 'On' : 'Off',
    visible: s => s.clickOn
  },
  {
    id: 'pipLpfLo', section: 'audio', label: 'Filter low', kind: 'slider',
    parent: 'pipLpf',
    min: 40, max: 4000, step: 10, def: 400, taper: 'log',
    get: s => s.pipLpfLo,
    set: (s, pos) => { s.pipLpfLo = pos; applyPipLpf(); save(); },
    format: s => fmtHz(s.pipLpfLo),
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfHi', section: 'audio', label: 'Filter high', kind: 'slider',
    parent: 'pipLpf',
    min: 500, max: 18000, step: 100, def: 9000, taper: 'log',
    get: s => s.pipLpfHi,
    set: (s, pos) => { s.pipLpfHi = pos; applyPipLpf(); save(); },
    format: s => fmtHz(s.pipLpfHi),
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfPeriod', section: 'audio', label: 'Filter sweep time', kind: 'slider',
    parent: 'pipLpf',
    min: 2, max: 300, step: 1, def: 60, taper: 'log',
    get: s => s.pipLpfPeriod,
    set: (s, pos) => { s.pipLpfPeriod = pos; applyPipLpf(); save(); },
    format: s => fmtSweep(s.pipLpfPeriod) + ' / cycle',
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfWander', section: 'audio', label: 'Filter wander', kind: 'slider',
    parent: 'pipLpf',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round(s.pipLpfWander * 100),
    set: (s, pos) => { s.pipLpfWander = pos / 100; applyPipLpf(); save(); },
    format: s => Math.round(s.pipLpfWander * 100) + '%',
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'pipLpfQ', section: 'audio', label: 'Filter resonance', kind: 'slider',
    parent: 'pipLpf',
    min: 50, max: 600, step: 1, def: 71, taper: 'log',
    get: s => Math.round(s.pipLpfQ * 100),
    set: (s, pos) => { s.pipLpfQ = pos / 100; applyPipLpf(); save(); },
    format: s => s.pipLpfQ.toFixed(2),
    visible: s => s.clickOn && s.pipLpfOn
  },
  {
    id: 'biToggle', section: 'audio', label: 'Bilateral', kind: 'toggle',
    get: s => s.biOn,
    set: (s, on) => setBilateral(s, !!on),
    format: s => s.biOn ? 'On' : 'Off'
  },
  subDrawer('audioBilateralDrawer', 'Bilateral', 'audio', ['biDepth', 'biRate'], 'biToggle'),
  {
    id: 'biDepth', section: 'audio', label: 'Bilateral depth', kind: 'slider',
    parent: 'audioBilateralDrawer',
    min: 0, max: 100, step: 1, def: 60,
    get: s => Math.round(s.biDepth * 100),
    set: (s, pos) => { s.biDepth = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.biDepth * 100) + '%',
    visible: s => s.biOn
  },
  {
    id: 'biRate', section: 'audio', label: 'Bilateral rate', kind: 'slider',
    parent: 'audioBilateralDrawer',
    min: 0.4, max: 10, step: 0.1, def: 1,
    get: s => s.biPeriod,
    set: (s, pos) => { s.biPeriod = pos; applyHarmonics(); save(); },
    format: s => s.biPeriod.toFixed(1) + 's / pass',
    visible: s => s.biOn
  },
  {
    id: 'biHardSwitch', section: 'audio', label: 'Bilateral shape', kind: 'segment',
    hideLabel: true,
    parent: 'audioBilateralDrawer',
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
    id: 'harmToggle', section: 'audio', label: 'Harmonics', kind: 'toggle',
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
  subDrawer('audioHarmonicsDrawer', 'Harmonics', 'audio', ['harmVol', 'harmCount'], 'harmToggle'),
  {
    id: 'harmVol', section: 'audio', label: 'Level', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 0, max: 100, step: 1, def: 87,
    get: s => ampToPos(s.harmVol),
    set: (s, pos) => { s.harmVol = posToAmp(pos); applyLevel('harmLevel'); save(); },
    format: s => ampToDb(s.harmVol) + ' dB',
    parse: parseDb,
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmCount', section: 'audio', label: 'How many', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 1, max: 16, step: 1, def: 9,
    get: s => s.harmCount,
    set: (s, pos) => { s.harmCount = pos; applyHarmonics(); save(); },
    format: s => String(s.harmCount),
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmBright', section: 'audio', label: 'Brightness', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 0, max: 100, step: 1, def: 45,
    get: s => Math.round(s.harmBright * 100),
    set: (s, pos) => { s.harmBright = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.harmBright * 100) + '%',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmSpread', section: 'audio', label: 'Stereo spread', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 0, max: 100, step: 1, def: 70,
    get: s => Math.round(s.harmSpread * 100),
    set: (s, pos) => { s.harmSpread = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.harmSpread * 100) + '%',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmPanRate', section: 'audio', label: 'Pan speed', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 0, max: 4, step: 0.05, def: 0.45,
    get: s => s.harmPanRate,
    set: (s, pos) => { s.harmPanRate = pos; applyHarmonics(); save(); },
    format: s => s.harmPanRate.toFixed(2) + ' Hz',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'shimDepth', section: 'audio', label: 'Shimmer depth', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 0, max: 100, step: 1, def: 57,
    get: s => Math.round(s.shimDepth * 100),
    set: (s, pos) => { s.shimDepth = pos / 100; applyHarmonics(); save(); },
    format: s => Math.round(s.shimDepth * 100) + '%',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'shimRate', section: 'audio', label: 'Shimmer rate', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 0.01, max: 6, step: 0.01, def: 0.12,
    get: s => s.shimRate,
    set: (s, pos) => { s.shimRate = pos; applyHarmonics(); save(); },
    format: s => s.shimRate.toFixed(2) + ' Hz',
    visible: s => s.harmOn && s.toneOn
  },
  {
    id: 'harmReverb', section: 'audio', label: 'Reverb', kind: 'slider',
    parent: 'audioHarmonicsDrawer',
    min: 0, max: 100, step: 1, def: 35,
    get: s => Math.round(s.harmReverb * 100),
    set: (s, pos) => { s.harmReverb = pos / 100; applyReverbMix(); save(); },
    format: s => Math.round(s.harmReverb * 100) + '%',
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
// The choir's Density readout, the performer's own: the degree last added
// and the one coming next, until every degree is in.
const CHOIR_DENSITY_NAMES = ['1', '+ 8', '+ 5', '+ 3', '+ 2', '+ 7', '+ 9'];
function choirDensityText(density) {
  const names = CHOIR_DENSITY_NAMES;
  const position = density / 100 * (names.length - 1);
  const index = Math.min(names.length - 1, Math.floor(position + 0.00001));
  const next = names[Math.min(names.length - 1, index + 1)];
  return index === names.length - 1 ? 'all degrees' : names[index] + ' → ' + next;
}
// One music layer (js/layers.js, table in js/layer-defs.js): its switch, a
// sub-drawer that switch heads, and its level inside. 100% is the table's
// level, about 2 dB under the drone at its default; up to 200% for headroom.
function musicLayerControls(L) {
  const on = layerOnKey(L), vol = layerVolKey(L), drawer = layerDrawerId(L);
  return [
    {
      id: on, section: 'music', label: L.label, kind: 'toggle',
      get: s => !!s[on],
      set: (s, v) => { s[on] = !!v; applyLayerOn(L.id); save(); },
      format: s => s[on] ? 'On' : 'Off',
      visible: s => s.musicOn
    },
    subDrawer(drawer, L.label, 'music', [vol], on),
    {
      id: vol, section: 'music', label: L.label + ' level', kind: 'slider',
      parent: drawer, summaryLabel: 'Level',
      min: 0, max: 200, step: 1, def: 100,
      get: s => Math.round(s[vol] * 100),
      set: (s, pos) => { s[vol] = pos / 100; applyLayerVol(L.id); save(); },
      format: s => Math.round(s[vol] * 100) + '%',
      visible: s => s.musicOn && s[on]
    }
  ];
}
const musicControls = [
  {
    // The whole music engine's switch. The section header's own On/Off is
    // this control (drawer.js SECTION_SWITCH), so it never shows as a body
    // row; it only exists for the header and the quick bar to drive.
    id: 'musicOn', section: 'music', label: 'Music', kind: 'segment',
    hideLabel: true,
    options: [
      { value: true,  label: 'On',  domId: 'muOn' },
      { value: false, label: 'Off', domId: 'muOff' }
    ],
    get: s => s.musicOn,
    set: (s, v) => setMusicOn(s, !!v),
    format: s => s.musicOn ? 'on' : 'off',
    visible: () => false
  },
  // ---- the five voices, Piano, Sequencer, Drone, Clouds and the shared
  // Reverb, each its own switch then a sub-drawer whose strip carries it, as
  // the Audio section's voices are. A strip hides with its switch's own
  // rule, so with the music off the section is empty as it always was ----
  {
    // The generative piano voice alone; the drone, sequencer and clouds keep
    // playing. Read by the player as each gesture is chosen (js/piano.js).
    id: 'pianoOn', section: 'music', label: 'Piano', kind: 'toggle',
    get: s => s.pianoOn !== false,
    // the channel holds its trim while the piano is off (piano.js); on
    // picks the trim up again
    set: (s, on) => { s.pianoOn = !!on; if (on) applyPianoTrim(); save(); },
    format: s => s.pianoOn !== false ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  subDrawer('musicPianoDrawer', 'Piano', 'music', ['pianoStyle', 'pianoVol'], 'pianoOn'),
  {
    // v1 only, so no v0 button ids. Read by piano.js as each gesture is
    // chosen, so a switch is heard from the next phrase on.
    id: 'pianoStyle', section: 'music',
    hideLabel: true,
    parent: 'musicPianoDrawer', label: 'Play style', kind: 'segment',
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
    parent: 'musicPianoDrawer', label: 'Piano level', kind: 'slider',
    min: 0, max: 100, step: 1, def: 90,
    get: s => Math.round(s.pianoVol * 100),
    set: (s, pos) => { s.pianoVol = pos / 100; save(); },
    format: s => Math.round(s.pianoVol * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoHP', section: 'music',
    parent: 'musicPianoDrawer', label: 'Piano high-pass', kind: 'slider',
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
    parent: 'musicPianoDrawer', label: 'Density', kind: 'slider',
    min: 20, max: 250, step: 5, def: 100,
    get: s => Math.round(s.pianoDensity * 100),
    set: (s, pos) => { s.pianoDensity = pos / 100; save(); },
    format: s => Math.round(s.pianoDensity * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoCentre', section: 'music',
    parent: 'musicPianoDrawer', label: 'Register centre', kind: 'slider',
    min: 48, max: 84, step: 1, def: 72,
    get: s => s.pianoCentre,
    set: (s, pos) => { s.pianoCentre = pos; save(); },
    format: s => noteName(s.pianoCentre),
    entry: 'text', parse: parseNote,
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoSpread', section: 'music',
    parent: 'musicPianoDrawer', label: 'Register drift', kind: 'slider',
    min: 0, max: 100, step: 1, def: 55,
    get: s => Math.round(s.pianoSpread * 100),
    set: (s, pos) => { s.pianoSpread = pos / 100; save(); },
    format: s => Math.round(s.pianoSpread * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoHold', section: 'music',
    parent: 'musicPianoDrawer', label: 'Hold length', kind: 'slider',
    min: 30, max: 250, step: 5, def: 100,
    get: s => Math.round(s.pianoHold * 100),
    set: (s, pos) => { s.pianoHold = pos / 100; save(); },
    format: s => Math.round(s.pianoHold * 100) + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    id: 'pianoBass', section: 'music',
    parent: 'musicPianoDrawer', label: 'Low anchor', kind: 'slider',
    min: 0, max: 60, step: 1, def: 10,
    get: s => s.pianoBass,
    set: (s, pos) => { s.pianoBass = pos; save(); },
    format: s => s.pianoBass + '%',
    visible: s => s.musicOn && s.pianoOn !== false
  },
  {
    // The sequencer (js/piano.js, its arp and sequencer sections), whose
    // first pattern is the original 3 4 8 figure: off by default.
    id: 'arpOn', section: 'music', label: 'Sequencer', kind: 'toggle',
    get: s => !!s.arpOn,
    set: (s, on) => { s.arpOn = !!on; applyArp(); save(); },
    format: s => s.arpOn ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  subDrawer('musicArpDrawer', 'Sequencer', 'music', ['arpVol', 'arpRate'], 'arpOn'),
  {
    // The step grid, in its own floating window (ui/screens/sequencer.js).
    id: 'seqOpen', section: 'music', label: 'Open sequencer', kind: 'action',
    parent: 'musicArpDrawer',
    act: () => seqOpenHook(),
    format: () => 'Open sequencer',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // The master over all eight lines; each line's own level is in the
    // sequencer window.
    id: 'arpVol', section: 'music', label: 'Sequencer master volume', kind: 'slider',
    parent: 'musicArpDrawer',
    min: 0, max: 100, step: 1, def: 50,
    get: s => Math.round(s.arpVol * 100),
    set: (s, pos) => { s.arpVol = pos / 100; applyArp(); save(); },
    format: s => Math.round(s.arpVol * 100) + '%',
    visible: s => s.musicOn && s.arpOn
  },
  // The master volume's dip, the app's standard: over one speed cycle it
  // eases from the setting down by this share and back (js/piano.js,
  // arpPump).
  ...varianceRows('arpVol', {
    music: true, name: 'Volume', parent: 'musicArpDrawer', visible: s => s.musicOn && s.arpOn,
    effective: () => arpEffectiveVol() * 100
  }),
  {
    id: 'arpRate', section: 'music', label: 'Sequencer speed', kind: 'slider',
    parent: 'musicArpDrawer',
    min: 2, max: 14, step: 0.5, def: 7,
    get: s => s.arpRate,
    set: (s, pos) => { s.arpRate = pos; applyArp(); save(); },
    format: s => s.arpRate.toFixed(1) + ' notes/s',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // Whole octaves either side of the written figure, over every line
    // (each line's own octave is in its PITCH row in the sequencer window);
    // the next note lands in the new register.
    id: 'arpOct', section: 'music', label: 'Sequencer octave', kind: 'slider',
    parent: 'musicArpDrawer',
    min: -2, max: 2, step: 1, def: 0,
    get: s => s.arpOct,
    set: (s, pos) => { s.arpOct = pos; save(); },
    format: s => s.arpOct === 0 ? '0' : (s.arpOct > 0 ? '+' : '') + s.arpOct + ' oct',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // A tilt over every line's own range, octave jumps included: the
    // highest note a line can reach comes down by this much, its lowest not
    // at all, the rest evenly between by semitone; the next note lands on
    // the slope (js/piano.js, the high freq reduction).
    id: 'arpHfCut', section: 'music', label: 'High freq reduction', kind: 'slider',
    parent: 'musicArpDrawer',
    min: 0, max: 20, step: 1, def: 0,
    get: s => s.arpHfCut || 0,
    set: (s, pos) => { s.arpHfCut = pos; save(); },
    format: s => (s.arpHfCut || 0) > 0 ? s.arpHfCut + ' dB' : 'off',
    visible: s => s.musicOn && s.arpOn
  },
  {
    // A volume pulse at the strobe's own flash rate and in its waveform,
    // layered over everything else the level does; 0 is none, 100% swings
    // the line from full down to silence on every flash.
    id: 'arpStrobeAm', section: 'music', label: 'Vary with strobe', kind: 'slider',
    parent: 'musicArpDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: s => Math.round((s.arpStrobeAm || 0) * 100),
    set: (s, pos) => { s.arpStrobeAm = pos / 100; applyArp(); save(); },
    format: s => Math.round((s.arpStrobeAm || 0) * 100) + '%',
    visible: s => s.musicOn && s.arpOn
  },
  // The pulse depth's dip, the drone's and choir's own (js/piano.js,
  // arpPump).
  ...varianceRows('arpStrobeAm', {
    music: true, name: 'Pulse', parent: 'musicArpDrawer', visible: s => s.musicOn && s.arpOn,
    effective: () => arpEffectiveAm() * 100
  }),
  {
    id: 'bedOn', section: 'music', label: 'Ocean drone', kind: 'toggle',
    get: s => s.bedOn !== false,
    set: (s, on) => { s.bedOn = !!on; applyBedOn(); save(); },
    format: s => s.bedOn !== false ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  subDrawer('musicDroneDrawer', 'Drone', 'music', ['bedVol', 'bedDetune'], 'bedOn'),
  {
    id: 'bedVol', section: 'music', label: 'Drone level', kind: 'slider',
    parent: 'musicDroneDrawer',
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
    hideLabel: true,
    parent: 'musicDroneDrawer',
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
  {
    // The sequencer's Vary with strobe (js/strobe-am.js): a volume pulse at
    // the strobe's flash rate and in its waveform; 0 is none, 100% swings
    // the voice from full down to silence on every flash.
    id: 'bedStrobeAm', section: 'music', label: 'Vary with strobe', kind: 'slider',
    parent: 'musicDroneDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: s => Math.round((s.bedStrobeAm || 0) * 100),
    set: (s, pos) => { s.bedStrobeAm = pos / 100; applyBedAm(); save(); },
    format: s => Math.round((s.bedStrobeAm || 0) * 100) + '%',
    visible: s => s.musicOn && s.bedOn !== false
  },
  ...varianceRows('bedStrobeAm', {
    music: true, name: 'Pulse', mode: true, apply: applyBedAm,
    parent: 'musicDroneDrawer', visible: s => s.musicOn && s.bedOn !== false,
    effective: () => bedEffectiveAm() * 100
  }),
  // The drone's filter sweep: the click train's set above, on the drone's own
  // low-pass (js/piano.js), with the same ranges, tapers and readouts.
  {
    id: 'bedLpf', section: 'music',
    parent: 'musicDroneDrawer', label: 'Drone filter sweep', kind: 'toggle',
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
    hideLabel: true,
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
    parent: 'musicDroneDrawer', label: 'Drone reverb', kind: 'toggle',
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
  // ---- the choir (js/choir.js): the sandbox's Choir Performer, seven Lah
  // voices looping together, its four controls exactly as the performer has
  // them, with a variance under Level, Stack and Density. The variance takes
  // the value below the set one (the cap) by up to its amount, wandering on
  // a new cosine leg every speed-many seconds; the slider shows the set
  // value. Every change glides the voices' gains; nothing retriggers ----
  {
    id: 'choirOn', section: 'music', label: 'Choir', kind: 'toggle',
    get: s => !!s.choirOn,
    set: (s, on) => { s.choirOn = !!on; applyChoirOn(); save(); },
    format: s => s.choirOn ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  subDrawer('musicChoirDrawer', 'Choir', 'music', ['choirStack', 'choirDensity'], 'choirOn'),
  {
    // 100% is the performer's own level, about 2 dB under the drone at its
    // default; up to 200% for headroom.
    id: 'choirVol', section: 'music', label: 'Choir level', kind: 'slider',
    parent: 'musicChoirDrawer',
    min: 0, max: 200, step: 1, def: 100,
    get: s => Math.round(s.choirVol * 100),
    set: (s, pos) => { s.choirVol = pos / 100; applyChoirVol(); save(); },
    format: s => Math.round(s.choirVol * 100) + '%',
    visible: s => s.musicOn && s.choirOn
  },
  ...varianceRows('choirVol', {
    music: true, name: 'Level', mode: true, apply: applyChoirVol,
    parent: 'musicChoirDrawer', visible: choirShows,
    effective: () => choirEffectiveLevel() * 100
  }),
  {
    // The sequencer's Vary with strobe (js/strobe-am.js): a volume pulse at
    // the strobe's flash rate and in its waveform; 0 is none, 100% swings
    // the voice from full down to silence on every flash.
    id: 'choirStrobeAm', section: 'music', label: 'Vary with strobe', kind: 'slider',
    parent: 'musicChoirDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: s => Math.round((s.choirStrobeAm || 0) * 100),
    set: (s, pos) => { s.choirStrobeAm = pos / 100; applyChoirAm(); save(); },
    format: s => Math.round((s.choirStrobeAm || 0) * 100) + '%',
    visible: s => s.musicOn && s.choirOn
  },
  ...varianceRows('choirStrobeAm', {
    music: true, name: 'Pulse', mode: true, apply: applyChoirAm,
    parent: 'musicChoirDrawer', visible: choirShows,
    effective: () => choirEffectiveAm() * 100
  }),
  {
    // Fills upward through the choir from the low voice.
    id: 'choirStack', section: 'music', label: 'Stack', kind: 'slider',
    parent: 'musicChoirDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: s => s.choirStack,
    set: (s, pos) => { s.choirStack = pos; applyChoir(); save(); },
    format: s => s.choirStack < 1 ? 'low voice' : Math.round(s.choirStack) + '% filled',
    visible: s => s.musicOn && s.choirOn
  },
  ...varianceRows('choirStack', {
    music: true, name: 'Stack', mode: true, apply: applyChoir,
    parent: 'musicChoirDrawer', visible: choirShows,
    effective: choirEffectiveStack
  }),
  {
    // Adds the harmonic degrees one at a time: 1, then 8, 5, 3, 2, 7 and 9.
    id: 'choirDensity', section: 'music', label: 'Density', kind: 'slider',
    parent: 'musicChoirDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: s => s.choirDensity,
    set: (s, pos) => { s.choirDensity = pos; applyChoir(); save(); },
    format: s => choirDensityText(s.choirDensity),
    visible: s => s.musicOn && s.choirOn
  },
  ...varianceRows('choirDensity', {
    music: true, name: 'Density', mode: true, apply: applyChoir,
    parent: 'musicChoirDrawer', visible: choirShows,
    effective: choirEffectiveDensity
  }),
  {
    // From the low voices to the high; at 0 the choir is even.
    id: 'choirBrightness', section: 'music', label: 'Brightness', kind: 'slider',
    parent: 'musicChoirDrawer',
    min: -100, max: 100, step: 1, def: 0,
    get: s => s.choirBrightness,
    set: (s, pos) => { s.choirBrightness = pos; applyChoir(); save(); },
    format: s => s.choirBrightness === 0 ? 'even'
      : (s.choirBrightness < 0 ? 'low +' : 'high +') + Math.abs(Math.round(s.choirBrightness)) + '%',
    visible: s => s.musicOn && s.choirOn
  },
  {
    // Narrows Brightness's balance into a moving spotlight.
    id: 'choirFocus', section: 'music', label: 'Focus', kind: 'slider',
    parent: 'musicChoirDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: s => s.choirFocus,
    set: (s, pos) => { s.choirFocus = pos; applyChoir(); save(); },
    format: s => s.choirFocus < 1 ? 'broad' : s.choirFocus > 99 ? 'single voice' : Math.round(s.choirFocus) + '% narrow',
    visible: s => s.musicOn && s.choirOn
  },
  // ---- the music layers (js/layers.js): Majestic voice, Bright fifth ----
  ...MUSIC_LAYERS.flatMap(musicLayerControls),
  {
    id: 'cloudsOn', section: 'music', label: 'Clouds', kind: 'segment',
    hideLabel: true,
    options: [
      { value: true,  label: 'On',  domId: 'clOn' },
      { value: false, label: 'Off', domId: 'clOff' }
    ],
    get: s => s.cloudsOn,
    set: (s, v) => setCloudsOn(s, !!v),
    format: s => s.cloudsOn ? 'on' : 'off',
    visible: s => s.musicOn
  },
  subDrawer('musicCloudsDrawer', 'Clouds', 'music', ['cloudVol', 'cloudDensity'], 'cloudsOn'),
  {
    id: 'cloudVol', section: 'music', label: 'Clouds level', kind: 'slider',
    parent: 'musicCloudsDrawer',
    min: 0, max: 100, step: 1, def: 60,
    get: s => Math.round(s.cloudVol * 100),
    set: (s, pos) => { s.cloudVol = pos / 100; save(); },
    format: s => Math.round(s.cloudVol * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  {
    id: 'cloudDensity', section: 'music', label: 'Clouds density', kind: 'slider',
    parent: 'musicCloudsDrawer',
    min: 20, max: 250, step: 5, def: 100,
    get: s => Math.round(s.cloudDensity * 100),
    set: (s, pos) => { s.cloudDensity = pos / 100; save(); },
    format: s => Math.round(s.cloudDensity * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  {
    id: 'cloudPhrase', section: 'music', label: 'Falling figure', kind: 'slider',
    parent: 'musicCloudsDrawer',
    min: 0, max: 100, step: 1, def: 35,
    get: s => Math.round(s.cloudPhrase * 100),
    set: (s, pos) => { s.cloudPhrase = pos / 100; save(); },
    format: s => Math.round(s.cloudPhrase * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  {
    id: 'cloudReverb', section: 'music', label: 'Clouds reverb', kind: 'slider',
    parent: 'musicCloudsDrawer',
    min: 0, max: 150, step: 1, def: 100,
    get: s => Math.round(s.cloudReverb * 100),
    set: (s, pos) => { s.cloudReverb = pos / 100; applyCloudReverb(); save(); },
    format: s => Math.round(s.cloudReverb * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  {
    // The sequencer's Vary with strobe (js/strobe-am.js): a volume pulse at
    // the strobe's flash rate and in its waveform; 0 is none, 100% swings
    // the voice from full down to silence on every flash.
    id: 'cloudStrobeAm', section: 'music', label: 'Vary with strobe', kind: 'slider',
    parent: 'musicCloudsDrawer',
    min: 0, max: 100, step: 1, def: 0,
    get: s => Math.round((s.cloudStrobeAm || 0) * 100),
    set: (s, pos) => { s.cloudStrobeAm = pos / 100; applyCloudAm(); save(); },
    format: s => Math.round((s.cloudStrobeAm || 0) * 100) + '%',
    visible: s => s.musicOn && s.cloudsOn
  },
  // The Music window's trims for the five voices (ui/screens/music.js),
  // as musTone's are for the tone: each how much of its voice's level plays,
  // where 100% is exactly the level the drawer and the Levels window set.
  // Out of the drawer, as musicOn is. Listed after every voice's switch on
  // purpose: in worker mode the page replays a frame's changes in this
  // order, and a fade out lands as the switch going off and then the trim
  // going back to its level, which only holds (piano.js, clouds.js) if the
  // switch is heard first. Kept below the clouds sub-drawer's rows too:
  // hidden or not, a row between a sub-drawer's children breaks their run
  // and the drawer draws the rest unindented (ui/screens/drawer.js).
  {
    id: 'musPiano', section: 'music', label: 'Piano trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musPiano ?? 1) * 100),
    set: (s, pos) => { s.musPiano = trimOf(pos); applyPianoTrim(); save(); },
    format: s => Math.round((s.musPiano ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    id: 'musClouds', section: 'music', label: 'Clouds trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musClouds ?? 1) * 100),
    set: (s, pos) => { s.musClouds = trimOf(pos); applyCloudTrim(); save(); },
    format: s => Math.round((s.musClouds ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    id: 'musDrone', section: 'music', label: 'Drone trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musDrone ?? 1) * 100),
    set: (s, pos) => { s.musDrone = trimOf(pos); applyBedVol(); save(); },
    format: s => Math.round((s.musDrone ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    id: 'musArp', section: 'music', label: 'Sequencer trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musArp ?? 1) * 100),
    set: (s, pos) => { s.musArp = trimOf(pos); applyArp(); save(); },
    format: s => Math.round((s.musArp ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    id: 'musChoir', section: 'music', label: 'Choir trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musChoir ?? 1) * 100),
    set: (s, pos) => { s.musChoir = trimOf(pos); applyChoirVol(); save(); },
    format: s => Math.round((s.musChoir ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    // The room every music voice shares: the piano, the drone and the
    // sequencer all feed this one reverb, and the per-voice rows (Drone
    // reverb level, Sequencer reverb) only set each voice's share of it.
    id: 'musicRevOn', section: 'music', label: 'Master reverb', kind: 'toggle',
    get: s => s.musicRevOn !== false,
    set: (s, on) => { s.musicRevOn = !!on; applyPianoReverb(); save(); },
    format: s => s.musicRevOn !== false ? 'On' : 'Off',
    visible: s => s.musicOn
  },
  subDrawer('musicReverbDrawer', 'Reverb', 'music', ['pianoReverb', 'pianoRevTime'], 'musicRevOn'),
  {
    // What plays the room: Convolution, a fixed impulse (a new decay is a
    // new impulse, crossfaded in), or Algorithmic, a feedback delay network
    // whose decay is one number, with a damping and a drift of its own
    // (js/piano.js applyRevType, js/fdn-worklet.js). Level and decay, and
    // their variances, are the same settings under either.
    //
    // On a phone the row is that phone's own choice instead (phoneRevType),
    // Algorithmic until the viewer picks otherwise, since a long convolution
    // is heavy on a phone's audio thread (js/piano.js applyRevType). It is a
    // machine setting there (presets.js machineControl, store.js
    // MACHINE_KEYS): no preset, step or broadcast moves it, and the show's
    // own type is left as the show has it for the desktops that play it.
    id: 'musicRevType', section: 'music', label: 'Reverb type', kind: 'segment',
    parent: 'musicReverbDrawer', machineOnPhone: true,
    options: [
      { value: 'conv', label: 'Convolution' },
      { value: 'algo', label: 'Algorithmic' }
    ],
    def: 'conv',
    get: s => (onPhone() ? s.phoneRevType !== 'conv' : s.musicRevType === 'algo') ? 'algo' : 'conv',
    set: (s, v) => {
      if (onPhone()) s.phoneRevType = v === 'conv' ? 'conv' : 'algo';
      else s.musicRevType = v === 'algo' ? 'algo' : 'conv';
      applyRevType(); save();
    },
    format: s => (onPhone() ? s.phoneRevType !== 'conv' : s.musicRevType === 'algo') ? 'algorithmic' : 'convolution',
    visible: s => s.musicOn && s.musicRevOn !== false
  },
  {
    id: 'pianoReverb', section: 'music', label: 'Reverb level', kind: 'slider',
    parent: 'musicReverbDrawer',
    min: 0, max: 200, step: 1, def: 100,
    get: s => Math.round(s.pianoReverb * 100),
    set: (s, pos) => { s.pianoReverb = pos / 100; applyPianoReverb(); save(); },
    format: s => Math.round(s.pianoReverb * 100) + '%',
    visible: s => s.musicOn && s.musicRevOn !== false
  },
  // The room's level and decay each breathe by the app's standard dip
  // (js/piano.js, revBreathe, on the music's own clock).
  ...varianceRows('pianoReverb', {
    music: true, name: 'Level', parent: 'musicReverbDrawer', visible: s => s.musicOn && s.musicRevOn !== false,
    effective: () => pianoEffectiveReverb() * 100
  }),
  {
    id: 'pianoRevTime', section: 'music', label: 'Reverb decay', kind: 'slider',
    parent: 'musicReverbDrawer',
    min: 1, max: 15, step: 0.5, def: 4.5,
    get: s => s.pianoRevTime,
    set: (s, pos) => { s.pianoRevTime = pos; rebuildPianoIR(); rebuildCloudIR(); save(); },
    format: s => s.pianoRevTime.toFixed(1) + 's',
    visible: s => s.musicOn && s.musicRevOn !== false
  },
  // Under Convolution a new decay is a new impulse, built and crossfaded
  // in, so its speed starts at 5 s rather than 0.
  ...varianceRows('pianoRevTime', {
    music: true, name: 'Decay', parent: 'musicReverbDrawer', visible: s => s.musicOn && s.musicRevOn !== false,
    periodMin: 5, effective: pianoEffectiveRevTime
  }),
  {
    // How much sooner the highs die than the decay: 0 keeps every
    // frequency to the decay, as the convolution room does; full has the
    // top end gone in about a sixth of it.
    id: 'pianoRevDamp', section: 'music', label: 'Damping', kind: 'slider',
    parent: 'musicReverbDrawer',
    min: 0, max: 100, step: 1, def: 35,
    get: s => Math.round((s.pianoRevDamp ?? 0.35) * 100),
    set: (s, pos) => { s.pianoRevDamp = pos / 100; applyPianoRevShape(); save(); },
    format: s => Math.round((s.pianoRevDamp ?? 0.35) * 100) + '%',
    visible: s => s.musicOn && s.musicRevOn !== false && s.musicRevType === 'algo'
  },
  {
    // The slow drift of the network's delay lengths, which keeps a held
    // tone from ringing metallic; 0 holds them still.
    id: 'pianoRevMod', section: 'music', label: 'Modulation', kind: 'slider',
    parent: 'musicReverbDrawer',
    min: 0, max: 100, step: 1, def: 30,
    get: s => Math.round((s.pianoRevMod ?? 0.3) * 100),
    set: (s, pos) => { s.pianoRevMod = pos / 100; applyPianoRevShape(); save(); },
    format: s => Math.round((s.pianoRevMod ?? 0.3) * 100) + '%',
    visible: s => s.musicOn && s.musicRevOn !== false && s.musicRevType === 'algo'
  }
];

// ---------- Atmosphere section (the drawer group; the mixer window is its
// own 'mixer' section further down) ----------
const atmosphereControls = [
  {
    id: 'ambOn', section: 'atmosphere', label: 'Ambience', kind: 'segment',
    hideLabel: true,
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
  // The Music window's trim for the atmosphere, as musTone's is for the
  // tone: 100% plays exactly the level above. Out of the drawer.
  {
    id: 'musAmb', section: 'atmosphere', label: 'Ambience trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musAmb ?? 1) * 100),
    set: (s, pos) => { s.musAmb = trimOf(pos); applyAmbVol(); save(); },
    format: s => Math.round((s.musAmb ?? 1) * 100) + '%',
    visible: () => false
  },
  // Opens the mixer overlay. v0's handler also closes the drawer
  // (togglePanel(false)) before dispatching the open event; the drawer's
  // open flag is plain S state, so it is set directly here rather than
  // routed through a visual-side helper.
  {
    id: 'ambMixerOpen', section: 'atmosphere', label: 'Open levels', kind: 'action',
    act: s => { s.panelOpen = false; mixerOpenHook(true); },
    visible: s => s.ambOn
  },
  {
    id: 'ambReverb', section: 'atmosphere', label: 'Reverb', kind: 'slider',
    min: 0, max: 150, step: 1, def: 100,
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

// ---------- Live Sound section (js/livesound.js) ----------
// A microphone or line input, through a compressor and a room of its own. Every set() here ends in saveLive rather than save(): these settings
// are this machine's alone and stay out of presets, other tabs and the
// broadcast (see saveLive in store.js). The switch is not saved at all, so a
// reload comes up with the input closed, and nothing is opened before
// someone switches it on.
//
// The input list is the browser's, and it changes: blank until the first
// grant (browsers hide the names until then), filled in after it, and again
// whenever something is plugged in or pulled out. So the dropdown's options
// are a getter over livesound.js's list: the same array for as long as the
// list and the choice stay put, and a fresh one when either moves, which
// the select notices by its identity (widgets.js). The first option, the
// empty id, is the system's default input; a saved input the browser does
// not list right now (before the grant, or unplugged) stays in the list as
// 'Saved input' so the box shows what is actually chosen.
let liveOpts = null, liveOptsList = null, liveOptsFor = null;
function liveDeviceOptions() {
  const list = liveInputs(), chosen = S.liveDevice || '';
  if (liveOpts && list === liveOptsList && chosen === liveOptsFor) return liveOpts;
  const opts = [{ value: '', label: 'Default input' }];
  let found = !chosen;
  for (const d of list) {
    opts.push({ value: d.id, label: d.label });
    if (d.id === chosen) found = true;
  }
  if (!found) opts.push({ value: chosen, label: 'Saved input' });
  liveOpts = opts; liveOptsList = list; liveOptsFor = chosen;
  return opts;
}

const liveControls = [
  {
    // Opens the input (asking the browser's permission the first time) and
    // brings it in; off stops it, and the microphone light goes out. A
    // refusal turns this back off by itself (livesound.js).
    id: 'liveOn', section: 'live', label: 'On', kind: 'toggle',
    get: s => !!s.liveOn,
    set: (s, on) => { s.liveOn = !!on; applyLiveOn(); }
  },
  {
    // A change while live opens the new input at once and crossfades to it.
    id: 'liveDevice', section: 'live', label: 'Input', kind: 'segment', dropdown: true,
    get options() { return liveDeviceOptions(); },
    get: s => s.liveDevice || '',
    set: (s, v) => { s.liveDevice = typeof v === 'string' ? v : ''; applyLiveDevice(); saveLive(); }
  },
  {
    // The local monitor only. The broadcast hears the input at its designed
    // level whatever this says, so a broadcaster can monitor at nothing.
    id: 'liveLevel', section: 'live', label: 'Level', kind: 'slider',
    min: 0, max: 100, step: 1, def: 25,
    get: s => Math.round(s.liveLevel * 100),
    set: (s, pos) => { s.liveLevel = pos / 100; applyLiveLevel(); saveLive(); },
    format: s => Math.round(s.liveLevel * 100) + '%',
    visible: s => s.liveOn
  },
  {
    // The Music window's trim, as musAmb is the ambience's: 100% plays
    // exactly the level above. Out of the drawer.
    id: 'musLive', section: 'live', label: 'Live Sound trim', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((s.musLive ?? 1) * 100),
    set: (s, pos) => { s.musLive = trimOf(pos); applyLiveLevel(); saveLive(); },
    format: s => Math.round((s.musLive ?? 1) * 100) + '%',
    visible: () => false
  },
  {
    // The mix between the dry input and its own room, after the compressor:
    // 0 is all dry, 100 all room with no dry signal left. The broadcast
    // hears the same mix the monitor does.
    id: 'liveReverb', section: 'live', label: 'Reverb mix', kind: 'slider',
    min: 0, max: 100, step: 1, def: 25,
    get: s => Math.round(s.liveReverb * 100),
    set: (s, pos) => { s.liveReverb = pos / 100; applyLiveReverb(); saveLive(); },
    format: s => liveMixLabel(Math.round(s.liveReverb * 100)),
    visible: s => s.liveOn
  },
  {
    // The room's length. A move builds the new impulse once the slider has
    // rested and crossfades it in under the old tail (livesound.js), so a
    // drag never clicks and never cuts the room off.
    id: 'liveRevTime', section: 'live', label: 'Decay', kind: 'slider',
    min: 0.5, max: 8, step: 0.1, def: 3,
    get: s => s.liveRevTime,
    set: (s, pos) => { s.liveRevTime = pos; applyLiveRevTime(); saveLive(); },
    format: s => s.liveRevTime.toFixed(1) + 's',
    visible: s => s.liveOn
  },
  // The compressor, ahead of the dry side and the room alike. The defaults
  // are its old programmed settings; the knee stays programmed. Each move
  // glides its parameter (livesound.js applyLiveComp).
  {
    id: 'liveThreshold', section: 'live', label: 'Threshold', kind: 'slider',
    min: -60, max: 0, step: 1, def: -24,
    get: s => s.liveThreshold,
    set: (s, pos) => { s.liveThreshold = pos; applyLiveComp(); saveLive(); },
    format: s => s.liveThreshold + ' dB',
    visible: s => s.liveOn
  },
  {
    id: 'liveRatio', section: 'live', label: 'Ratio', kind: 'slider',
    min: 1, max: 20, step: 0.5, def: 3,
    get: s => s.liveRatio,
    set: (s, pos) => { s.liveRatio = pos; applyLiveComp(); saveLive(); },
    format: s => (Number.isInteger(s.liveRatio) ? s.liveRatio : s.liveRatio.toFixed(1)) + ':1',
    visible: s => s.liveOn
  },
  {
    // The track is a cube: position p is 100 (p/100)^3 ms, so the first
    // third of the travel covers 0 to about 4 ms, where an attack is mostly
    // set, and the last stretch sweeps up to 100. The state keeps ms.
    id: 'liveAttack', section: 'live', label: 'Attack', kind: 'slider',
    min: 0, max: 100, step: 1, def: 31,
    get: s => attackToPos(s.liveAttack),
    set: (s, pos) => { s.liveAttack = posToAttack(pos); applyLiveComp(); saveLive(); },
    format: s => s.liveAttack < 10 ? s.liveAttack.toFixed(1) + ' ms' : Math.round(s.liveAttack) + ' ms',
    parse: (s, text) => attackToPos(parseFloat(text)),
    visible: s => s.liveOn
  },
  {
    // Log, as the other time sliders are: 10 to 100 ms gets half the travel.
    id: 'liveRelease', section: 'live', label: 'Release', kind: 'slider',
    min: 10, max: 1000, step: 1, def: 250, taper: 'log',
    get: s => s.liveRelease,
    set: (s, pos) => { s.liveRelease = pos; applyLiveComp(); saveLive(); },
    format: s => s.liveRelease + ' ms',
    visible: s => s.liveOn
  },
  // The meter: how far the compressor is pulling the sound down right now,
  // read from the node itself (in worker mode, the page's reading). Not a
  // control, drawn the way the chirp's length is, a readout on a disabled
  // action, refreshed with the drawer's action faces about five times a
  // second.
  {
    id: 'liveReduction', section: 'live', label: 'Gain reduction', kind: 'action',
    act: () => {},
    format: () => liveReductionLabel(liveReductionNow()),
    enabled: () => false,
    visible: s => s.liveOn
  },
  {
    // The buffer asked of the input's own audio context, 0 to 100 ms; at 0,
    // the least the hardware offers. Moving it while the input is open
    // builds the context again behind the slider (livesound.js rebuild).
    // The readout gives what was asked and, while a context is open, what
    // it actually got, output included where the browser says.
    id: 'liveLatency', section: 'live', label: 'Latency', kind: 'slider',
    min: 0, max: 100, step: 1, def: 0,
    get: s => s.liveLatency || 0,
    set: (s, pos) => { s.liveLatency = Math.max(0, Math.min(100, Math.round(pos))); applyLiveLatency(); saveLive(); },
    format: s => liveLatencyLabel(s.liveLatency || 0, liveLatencyNow()),
    visible: s => s.liveOn
  }
];

// The two live readouts are read every frame the drawer shows them, and the
// latency's second half can move on its own, so each keeps the string it
// last built and hands it back while its numbers stay put.
let mixPos = -1, mixText = '';
function liveMixLabel(pos) {
  if (pos === mixPos) return mixText;
  mixPos = pos;
  mixText = pos <= 0 ? 'dry' : pos >= 100 ? 'wet' : pos + '% wet';
  return mixText;
}
let latAsked = -1, latGot = -2, latText = '';
function liveLatencyLabel(asked, got) {
  if (asked === latAsked && got === latGot) return latText;
  latAsked = asked; latGot = got;
  const a = asked > 0 ? asked + ' ms' : 'min';
  latText = got >= 0 ? a + ', got ' + got + ' ms' : a;
  return latText;
}
// The gain reduction, to a tenth of a dB, with a dash while no context is
// open to read it from.
let grTenths = NaN, grText = '';
function liveReductionLabel(db) {
  const t = Number.isFinite(db) ? Math.round(db * 10) + 0 : NaN;
  if (Object.is(t, grTenths) && grText) return grText;
  grTenths = t;
  grText = Number.isFinite(t) ? 'Reduction ' + (t / 10).toFixed(1) + ' dB' : 'Reduction –';
  return grText;
}

// Attack's cube taper (the Attack slider above), position 0 to 100 against
// ms, and back.
const posToAttack = pos => 100 * Math.pow(Math.max(0, Math.min(100, pos)) / 100, 3);
const attackToPos = ms => Number.isFinite(ms) ? Math.round(100 * Math.cbrt(Math.max(0, Math.min(100, ms)) / 100)) : NaN;

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
    // Toggles the ambience, as the music chip toggles the music; the mixer
    // is M, the drawer's Open mixer, or the mixer's own button.
    id: 'ambQuick', section: 'quick', label: 'Ambience on or off', kind: 'action',
    act: s => setAmbOn(s, !s.ambOn),
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
    id: 'strobeScale', section: 'transport', label: 'Strobe scale', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: s => Math.round((typeof s.strobeScale === 'number' ? s.strobeScale : 1) * 100),
    set: (s, pos) => {
      s.strobeScale = Math.max(0, Math.min(1, pos / 100));
      refreshStrobeAm();
      applyArp();
      applyAmOn();
      save();
    },
    format: s => Math.round((typeof s.strobeScale === 'number' ? s.strobeScale : 1) * 100) + '%'
  },
  {
    id: 'tpPlay', section: 'transport', label: 'start / stop', kind: 'action',
    // Starting or stopping a session also resets the strobe clock and seeds
    // the tunnel, both outside core. The hook is composed by integration
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
  ...gateControls('mixChoir', 'choir', 'Choir'),
  ...MUSIC_LAYERS.flatMap(L => gateControls(layerMixId(L), L.id, L.label)),
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
    id: 'mixChoir', section: 'mixer', label: 'Choir', kind: 'slider',
    min: 0, max: 200, step: 1, def: 100,
    get: s => Math.round(s.choirVol * 100),
    set: (s, pos) => { s.choirVol = pos / 100; applyChoirVol(); save(); },
    format: s => Math.round(s.choirVol * 100) + '%'
  },
  // the music layers' faders, second surfaces on their drawer levels
  ...MUSIC_LAYERS.map(L => {
    const vol = layerVolKey(L);
    return {
      id: layerMixId(L), section: 'mixer', label: L.label, kind: 'slider',
      min: 0, max: 200, step: 1, def: 100,
      get: s => Math.round(s[vol] * 100),
      set: (s, pos) => { s[vol] = pos / 100; applyLayerVol(L.id); save(); },
      format: s => Math.round(s[vol] * 100) + '%'
    };
  }),
  {
    id: 'ambMixerMaster', section: 'mixer', label: 'Ambience', kind: 'slider',
    min: 0, max: 100, step: 1, def: 18,
    get: s => Math.round(s.ambVol * 100),
    set: (s, pos) => { s.ambVol = pos / 100; applyAmbVol(); save(); },
    format: s => Math.round(s.ambVol * 100) + '%'
  },
  {
    id: 'ambMixerReverb', section: 'mixer', label: 'Reverb', kind: 'slider',
    min: 0, max: 150, step: 1, def: 100,
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
  ...audioControls, ...musicControls, ...atmosphereControls, ...liveControls,
  ...quickControls, ...transportControls, ...mixerControls
];

// Shorthand names for the voice strips' summaries (see summary in
// schema-visual.js subDrawer), where a label's first word would repeat the
// voice's own name or say nothing ('Bilateral 60%', 'How 9'). Set once here
// rather than on each entry above.
const AUDIO_SHORT = { biDepth: 'Depth', biRate: 'Rate', harmCount: 'Count', pianoStyle: 'Style',
  pianoVol: 'Level', arpVol: 'Level', arpRate: 'Speed', bedVol: 'Level', bedDetune: 'Detune', choirVol: 'Level',
  cloudVol: 'Level', cloudDensity: 'Density', pianoReverb: 'Level', pianoRevTime: 'Decay' };
for (const c of AUDIO_CONTROLS) if (AUDIO_SHORT[c.id]) c.summaryLabel = AUDIO_SHORT[c.id];
