// The Slides layer: the show's own videos, one at a time, played fullscreen
// over the scene (letterboxed, black bars), for the TSC 2026 talk. Like the
// Sun, it is new in v1 with no v0 handler or DOM ids: the S fields here are
// the contract gpu/slides.js reads each frame (the video element, its GPU
// picture and its sound chain all live there), and the defaults, ranges and
// persistence helpers sit beside the controls so the one list cannot drift
// between the drawer, the saved session, a preset, a journey step and the
// broadcast.
//
// Every control is an ordinary schema control (a toggle, a dropdown segment
// or a slider), so a journey step records and replays it (core/journey.js),
// a preset carries it and a broadcast follows it. None of it is machine
// state: it is the show, so nothing here joins store.js's MACHINE_KEYS.
//
// The videos live in slides/ at the repo root (git-ignored; copied in from
// the talk's Videos_optimized folder) and are served beside the page.
import { save } from './store.js';
import { idleWake } from './idle.js';
import { subDrawer } from './schema-visual.js';

// The show's videos, in running order: the file name (stored on S as the
// dropdown's value, so it reads plainly in a saved journey) and its label.
export const SLIDE_DIR = 'slides/';
export const SLIDE_NONE = 'none';
export const SLIDE_FILES = [
  ['010_Alexander_ECE_2026_Intro_Slide.mp4', 'Intro Slide'],
  ['015_Heartbeat_Pulse.mp4', 'Heartbeat'],
  ['020_harmonica_Car_Seat.jpeg.mp4', 'Harmonica Car Seat'],
  ['030_Audification_Explained.mp4', 'Audification Explained'],
  ['031_Shepard_Tone_Rising_Trim.mp4', 'Shepard Tone'],
  ['032_Sheprise-Trim.mp4', "Shepard's Rise"],
  ['040_Nightingale.mp4', 'Nightingale'],
  ['050_Earthquake_Sonification.mp4', 'Earthquake'],
  ['060_Rotating_Sun_Solar Wind Audification.mp4', 'Rotating Sun'],
  ['070_Solar_Spherical_Harmonics.mp4', 'Spherical Harmonics'],
  ['090_Harp_Trailer_Voice.mp4', 'HARP Trailer'],
  ['180_WISPR PSP CME Sonification dfb dbm vac trim_ANOMALY_B4.mp4', 'WISPR CME'],
  ['220_Ed_Mitchell_VR_Combined_Audio_Video.mp4', 'Ed Mitchell VR'],
  ['900_QR_Meditate_With_The_Sun_ALT_304.mp4', 'QR Meditate']
];
// The dropdown's options, None first. Shared with the Journey window's own
// SLIDE menu (ui/screens/journey.js), so the two always list the same.
export const SLIDE_OPTIONS = [{ value: SLIDE_NONE, label: 'None', domId: null }]
  .concat(SLIDE_FILES.map(f => ({ value: f[0], label: f[1], domId: null })));
const FILE_OK = new Set(SLIDE_OPTIONS.map(o => o.value));
const fileOf = v => FILE_OK.has(v) ? v : SLIDE_NONE;
const LABEL_OF = new Map(SLIDE_OPTIONS.map(o => [o.value, o.label]));
export const slideLabel = v => LABEL_OF.get(fileOf(v));

// The numeric fields and their ranges: the playback rate (x) and the
// layer's own level (0 to 1, a gain). The Lowpass and Highpass are global
// now (core/global-filter.js, the Audio section's lpf and hpf); a record
// still carrying the old slideLP and slideHP has them passed over.
const NUM = [
  // key,          min,   max,    def
  ['slideRate',    0.25,  2,      1],
  ['slideVolume',  0,     1,      1],
  // the crossfade from one slide to the next, seconds (0 a cut)
  ['slideXfade',   0,     3,      0.5],
  // the play/pause ramps, seconds (0 a cut): how long a pause takes to fade
  // the sound and slow the picture to a stop, and a play to bring both back
  ['slidePpOut',   0,     1,      0.2],
  ['slidePpIn',    0,     1,      0.2]
];
const DEF_PLAY = true, DEF_LOOP = false, DEF_PP_RAMP = false;

function fit(v, min, max) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return Math.round(v * 10000) / 10000;
}

// Seeds every slides field not already on S. Called in store.load() beside
// initSunState; it only fills gaps.
export function initSlidesState(S) {
  if (typeof S.layers.slides !== 'boolean') S.layers.slides = false;
  S.slideFile = fileOf(S.slideFile);
  if (typeof S.slidePlay !== 'boolean') S.slidePlay = DEF_PLAY;
  if (typeof S.slideLoop !== 'boolean') S.slideLoop = DEF_LOOP;
  if (typeof S.slidePpRamp !== 'boolean') S.slidePpRamp = DEF_PP_RAMP;
  if (!S.slideVols || typeof S.slideVols !== 'object') S.slideVols = {};
  for (const n of NUM) if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
}

// The plain record store.js writes into the v1 extra and a snapshot carries.
// The layer switch rides under its own flat name, as sunOn does.
export function slidesStateOf(S) {
  const out = { slidesOn: !!S.layers.slides, slideFile: fileOf(S.slideFile), slidePlay: S.slidePlay !== false, slideLoop: !!S.slideLoop, slidePpRamp: !!S.slidePpRamp };
  for (const n of NUM) out[n[0]] = S[n[0]];
  // only the lowered slides ride; a full one is the default
  const vols = {};
  if (S.slideVols) for (const f in S.slideVols) {
    const v = S.slideVols[f];
    if (FILE_OK.has(f) && typeof v === 'number' && isFinite(v) && v < 1) vols[f] = fit(v, 0, 1);
  }
  out.slideVols = vols;
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field,
// leaving anything missing or malformed as it is on S.
export function applySlidesState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.slidesOn === 'boolean') S.layers.slides = o.slidesOn;
  if (typeof o.slideFile === 'string') S.slideFile = fileOf(o.slideFile);
  if (typeof o.slidePlay === 'boolean') S.slidePlay = o.slidePlay;
  if (typeof o.slideLoop === 'boolean') S.slideLoop = o.slideLoop;
  if (typeof o.slidePpRamp === 'boolean') S.slidePpRamp = o.slidePpRamp;
  if (o.slideVols && typeof o.slideVols === 'object') {
    const vols = {};
    for (const f in o.slideVols) {
      const v = o.slideVols[f];
      if (FILE_OK.has(f) && typeof v === 'number' && isFinite(v)) vols[f] = fit(v, 0, 1);
    }
    S.slideVols = vols;
  }
  for (const n of NUM) {
    const v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2]);
  }
}

const layerOn = S => !!S.layers.slides;

// ---------- per-slide volume ----------
// Each slide remembers its own level (S.slideVols, file -> 0..1; full when
// unset): the drawer's Slide volume row and the Journey fold's VOL slider
// both edit this one map, so a slide meets the show at the level it was
// last left. gpu/slides.js reads it onto the slot's gain leg each frame.
export function slideVolOf(S, file) {
  const m = S.slideVols;
  const v = m && typeof m[file] === 'number' ? m[file] : 1;
  return v >= 0 ? (v > 1 ? 1 : v) : 0;
}
export function setSlideVol(S, file, v) {
  if (typeof file !== 'string' || file === SLIDE_NONE || !FILE_OK.has(file)) return;
  if (!S.slideVols || typeof S.slideVols !== 'object') S.slideVols = {};
  S.slideVols[file] = fit(v, 0, 1);
  save();
}

// ---------- the sliders' tapers ----------
// Rate: logarithmic either side of 1x at the centre, 0.25x (two octaves
// down) at the left end and 2x (one up) at the right, so 1x always sits
// mid-track. A drag landing within RATE_SNAP of 1x takes it exactly.
const RATE_POS = 1000, RATE_MID = RATE_POS / 2, RATE_SNAP = 0.03;
function rateToPos(v) {
  if (!(v === v)) return NaN;
  const r = v < 0.25 ? 0.25 : v > 2 ? 2 : v;
  return Math.round(r <= 1
    ? RATE_MID * (1 + Math.log2(r) / 2)            // 0.25..1 over 0..500
    : RATE_MID + RATE_MID * Math.log2(r));          // 1..2 over 500..1000
}
function posToRate(pos) {
  const p = pos > 0 ? (pos < RATE_POS ? pos : RATE_POS) : 0;
  let r = p <= RATE_MID ? Math.pow(2, 2 * (p / RATE_MID - 1)) : Math.pow(2, (p - RATE_MID) / RATE_MID);
  if (Math.abs(r - 1) <= RATE_SNAP) r = 1;
  return Math.round(r * 100) / 100;
}
export const SLIDES_CONTROLS = [
  // In the drawer's Layers group, straight after the Sun. Off by default.
  {
    id: 'lSlides', section: 'layers', label: 'Slides', kind: 'toggle', def: false,
    get: S => !!S.layers.slides,
    set: (S, on) => { S.layers.slides = !!on; save(); }
  },
  // The same switch heading its own section (the Sun's pattern), so the
  // section has a way in while every other row is dimmed.
  {
    id: 'slidesOn', section: 'slides', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.slides,
    set: (S, on) => { S.layers.slides = !!on; save(); }
  },
  {
    // The layer's own level, the section's first row (the On switch rides
    // its header): every slide's sound, before the app's Master volume and
    // the show remote's Duck multiply in (gpu/slides.js). Not the remote's
    // VOLUME fader, which drives Master volume. Never dimmed, so it can be
    // set before the layer comes on.
    id: 'slideVolume', section: 'slides', label: 'Master slide volume', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.slideVolume * 100),
    set: (S, pos) => { S.slideVolume = fit(pos / 100, 0, 1); save(); },
    format: S => Math.round(S.slideVolume * 100) + '%'
  },
  {
    // Which video plays. A change loads the new file from its start.
    id: 'slideFile', section: 'slides', label: 'Slide', kind: 'segment', dropdown: true,
    options: SLIDE_OPTIONS,
    def: SLIDE_NONE,
    get: S => fileOf(S.slideFile),
    set: (S, v) => { S.slideFile = fileOf(v); save(); },
    format: S => slideLabel(S.slideFile),
    enabled: layerOn
  },
  {
    // The picked slide's own remembered level (slideVolOf above), mirrored
    // by the Journey fold's VOL slider. It sits right after the picker in
    // the schema, so a step replaying both lands the file first.
    id: 'slideVol', section: 'slides', label: 'Slide volume', kind: 'slider',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(slideVolOf(S, fileOf(S.slideFile)) * 100),
    set: (S, pos) => setSlideVol(S, fileOf(S.slideFile), pos / 100),
    format: S => Math.round(slideVolOf(S, fileOf(S.slideFile)) * 100) + '%',
    enabled: S => layerOn(S) && fileOf(S.slideFile) !== SLIDE_NONE
  },
  {
    id: 'slidePlay', section: 'slides', label: 'Play', kind: 'toggle', def: DEF_PLAY,
    get: S => S.slidePlay !== false,
    set: (S, on) => { S.slidePlay = !!on; save(); },
    enabled: layerOn
  },
  // Play / pause, a drawer under the Play switch: a pause fades the sound
  // and slows the picture to a stop over Fade out, a play brings both back
  // over Fade in (gpu/slides.js). Audio speed ramp on lets the sound's pitch
  // follow the slowing picture, like a turntable; off, the sound only fades.
  subDrawer('slidePpDrawer', 'Play / pause', 'slides', ['slidePpOut', 'slidePpIn', 'slidePpRamp'], 'slidePlay'),
  {
    id: 'slidePpOut', section: 'slides', label: 'Fade out', kind: 'slider',
    parent: 'slidePpDrawer',
    min: 0, max: 100, step: 5, def: 20,
    get: S => Math.round(S.slidePpOut * 100),
    set: (S, pos) => { S.slidePpOut = fit(Math.round(pos / 5) * 5 / 100, 0, 1); save(); },
    format: S => S.slidePpOut > 0 ? S.slidePpOut.toFixed(2) + ' s' : 'cut',
    parse: (S, text) => /^\s*cut/i.test(text) ? 0 : Math.round(parseFloat(text) * 100),
    enabled: layerOn
  },
  {
    id: 'slidePpIn', section: 'slides', label: 'Fade in', kind: 'slider',
    parent: 'slidePpDrawer',
    min: 0, max: 100, step: 5, def: 20,
    get: S => Math.round(S.slidePpIn * 100),
    set: (S, pos) => { S.slidePpIn = fit(Math.round(pos / 5) * 5 / 100, 0, 1); save(); },
    format: S => S.slidePpIn > 0 ? S.slidePpIn.toFixed(2) + ' s' : 'cut',
    parse: (S, text) => /^\s*cut/i.test(text) ? 0 : Math.round(parseFloat(text) * 100),
    enabled: layerOn
  },
  {
    id: 'slidePpRamp', section: 'slides', label: 'Audio speed ramp', kind: 'toggle', def: DEF_PP_RAMP,
    parent: 'slidePpDrawer',
    get: S => !!S.slidePpRamp,
    set: (S, on) => { S.slidePpRamp = !!on; save(); },
    enabled: layerOn
  },
  {
    // Seek to the start (and play on, if Play is on). An action, so it is
    // never recorded into a step; the count is transient, read by
    // gpu/slides.js and never saved.
    id: 'slideRestart', section: 'slides', label: 'Restart', kind: 'action',
    set: S => { S.slideRestartN = (S.slideRestartN | 0) + 1; idleWake('slide restart'); },
    enabled: layerOn
  },
  {
    // How long a change of slide takes, picture and sound together
    // (gpu/slides.js): 0 is a cut, up to 3 s in 0.05 s steps. Its position
    // is in hundredths of a second (0 to 300), whole numbers, so the show
    // remote (platform/show-remote.js) can send it as it sends the faders.
    id: 'slideXfade', section: 'slides', label: 'Crossfade', kind: 'slider',
    min: 0, max: 300, step: 5, def: 50,
    get: S => Math.round(S.slideXfade * 100),
    set: (S, pos) => { S.slideXfade = fit(Math.round(pos / 5) * 5 / 100, 0, 3); save(); },
    format: S => S.slideXfade > 0 ? S.slideXfade.toFixed(2) + ' s' : 'cut',
    parse: (S, text) => /^\s*cut/i.test(text) ? 0 : Math.round(parseFloat(text) * 100),
    enabled: layerOn
  },
  {
    id: 'slideLoop', section: 'slides', label: 'Loop', kind: 'toggle', def: DEF_LOOP,
    get: S => !!S.slideLoop,
    set: (S, on) => { S.slideLoop = !!on; save(); },
    enabled: layerOn
  },
  {
    // Playback rate, pitch following speed (gpu/slides.js sets
    // preservesPitch off), 0.25x to 2x with 1x at the centre.
    id: 'slideRate', section: 'slides', label: 'Speed', kind: 'slider',
    min: 0, max: RATE_POS, step: 1, def: rateToPos(1),
    get: S => rateToPos(S.slideRate),
    set: (S, pos) => { S.slideRate = fit(posToRate(pos), 0.25, 2); save(); },
    format: S => S.slideRate.toFixed(2) + 'x',
    parse: (S, text) => rateToPos(parseFloat(text)),
    enabled: layerOn
  }
];

export const SLIDES_SECTIONS = [
  { id: 'slides', title: 'Slides' }
];
