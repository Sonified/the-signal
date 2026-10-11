// The Sun layer's controls and the state behind them. Like the Kaleidoscope,
// the sun is new in v1, with no v0 handler to port and no v0 DOM ids, so
// everything here is defined fresh: the S field names are the contract the
// GPU renderer (gpu/sun.js) reads, and the defaults, ranges and persistence
// helpers live beside the controls so that the one list of sun fields cannot
// drift between the drawer, the saved session and a preset.
//
// Persistence stays out of the shared v0 settings object for the same reason
// the kaleidoscope's does: v0's saveSettings() writes a fixed list of keys and
// would drop anything it does not know about. store.js writes these into the
// v1 extra record instead, through sunStateOf() and applySunState().
//
// Slider conventions follow schema-kaleido.js: a 0 to 1 amount is shown as a
// whole-percent slider (position 0 to 100) and converted through S, while a
// multiplier, a rate or a count is stored exactly as the slider shows it.
// Every set() ends with the debounced save(). The state-only helpers never
// call save(); store.js decides when to write.
import { save } from './store.js';
import { retimeRoomPhase } from './room-clock.js';
import { subDrawer } from './schema-visual.js';
import * as hum from './sun-hum.js';

// The layer switch, the kaleidoscope switch and the mirror flag are plain
// booleans; every numeric field carries its range here. gpu/sun.js reads
// these names off S directly, so this table is the source of truth for what a
// valid sun state is, both at boot and when a stored record or a preset
// snapshot is read back.
const DEF_KALEIDO_ON = false;
const DEF_MIRROR = true;
// On by default: the trails' Stream follows the breath, swinging between the
// Breath range's two ends, and the manual Stream is greyed out.
const DEF_FB_LINK = true;
// Off by default: the Color sliders do nothing, and stay hidden, until the
// viewer turns the grade on.
const DEF_GRADE = false;
// Off by default: the standard stream. On streams the site's original
// snapshot, at roughly twice the bytes (gpu/sun.js swaps it in place).
const DEF_HI_RES = false;
// Off by default: the Rotational hum is heard only once the viewer asks.
const DEF_HUM_ON = false;
// On by default, as on meditatewiththesun.com: the drifting star field
// behind the sun (gpu/stars.js), shown whether or not the sun is.
const DEF_STARS = true;
// The show's QR code over everything (gpu/sun-qr.js), off until asked for.
const DEF_QR_ON = false;
// What drives the Speed's, Feedback Amount's and Opacity's variances: the
// room-timed clock, the strobe or the breath. The breath by default.
const DEF_DRIVE = 'breath';
const DRIVES = ['time', 'strobe', 'breath'];
const DRIVE_NAMES = { time: 'Time', strobe: 'Link to strobe', breath: 'Link to breath' };
const driveOf = v => DRIVES.indexOf(v) >= 0 ? v : DEF_DRIVE;
const DRIVEN = ['sunSpeed', 'sunFbAmt', 'sunFbOpacity', 'sunHumCutoff', 'sunHumVerb'];
const NUM = [
  // key,               min,  max, def,  integer
  // the sun video's playback rate, the site's 1x to 16x
  ['sunSpeed',           1,   16,  1,    false],
  ['sunOpacity',         0,   1,   1,    false],
  ['sunSize',            0.2, 2,   1,    false],
  // The Atmosphere sweep: 0 the photosphere (1700 A, ~5,000 K) rising
  // through 304, 171 and 193 to 1 the corona (211 A, ~2 MK), crossfading
  // each adjacent channel smoothly.
  ['sunAtmo',            0,   1,   0.25, false],
  // breaths per minute; 5.5 is coherent breathing
  ['sunBreathRate',      0.5, 12,  5.5,  false],
  // how far the breath travels the Atmosphere: the breath modulates which
  // channel shows, around the Atmosphere slider's position
  ['sunBreathAmt',       0,   1,   0.5,  false],
  // Speed's variance, ridden by its Drive (above) as the Feedback's are:
  // the rate is Speed times 1 - var * (1 - drive), so at 1 the drive's top
  // runs the set Speed and its bottom comes to a stop (gpu/sun.js). The
  // standard law, a dip below the setting, never above it.
  ['sunSpeedVar',        0,   1,   0,    false],
  ['sunSpeedVarPeriod',  0,   120, 20,   true ],
  ['sunSpeedVarPeriodOff', 0, 1,   0,    false],
  // The Feedback drawer's video feedback, the same amount and opacity as the
  // Kaleidoscope's Feedback drawer: how long the sun leaves a trail, and how
  // solidly that image lands on the scene.
  ['sunFbAmt',           0,   1,   0.6,  false],
  ['sunFbOpacity',       0,   1,   1,    false],
  // Their variances, each driven by its own Drive (above): the value is the
  // setting times 1 - var * (1 - drive), the drive 1 at its top (a full
  // inhale, the strobe lit, the time cycle's start) and 0 at its bottom, so
  // at 100% the full value at the top and nothing at the bottom
  // (gpu/sun.js). The period is Time's alone, seconds a cycle, room-timed
  // with the Off phase offset (core/room-clock.js).
  ['sunFbAmtVar',        0,   1,   0,    false],
  ['sunFbAmtVarPeriod',  0,   120, 20,   true ],
  ['sunFbAmtVarPeriodOff', 0, 1,   0,    false],
  ['sunFbOpacityVar',    0,   1,   0,    false],
  ['sunFbOpacityVarPeriod', 0, 120, 20,  true ],
  ['sunFbOpacityVarPeriodOff', 0, 1, 0,  false],
  // The Center fade, the site's gate on what feeds the trails: how far out
  // from the middle the picture is kept out of the feedback, in the sun
  // square's half sides (0.775 the photosphere's limb, 1 the square's edge
  // midpoints). 0 is off, and the whole sun feeds the trails.
  ['sunFbGate',          0,   1,   0,    false],
  // The Center fade's softness: the width of the band over which the gate
  // opens, half of it either side of the fade's radius in the same half
  // sides. The default 6% is the site's own band (0.03 each side); 0 is a
  // near cut, 100% a band half the frame wide, a slow bloom.
  ['sunFbGateSoft',      0,   1,   0.06, false],
  // The trails' Stream, signed: + streams outward, - inward. Manual while
  // Link to breath is off.
  ['sunFbStream',       -1,   1,   0,    false],
  // While linked, the Stream follows the breath between these two ends, in
  // (Lo) at the breath's bottom to out (Hi) at its top.
  ['sunFbStreamLo',     -1,   1,   -0.5, false],
  ['sunFbStreamHi',     -1,   1,   0.5,  false],
  // The sun's own colour grade, the site's: 1 leaves the picture as it is,
  // 0 is black, flat grey or greyscale, 2 doubles the effect.
  ['sunBright',          0,   2,   1,    false],
  ['sunContrast',        0,   2,   1,    false],
  ['sunSat',             0,   2,   1,    false],
  // How many wedges the sun is folded into
  ['sunFolds',           3,   32,  8,    true ],
  // the fold's turning, in RPM, positive clockwise
  ['sunKaleidoSpin',    -6,   6,   0.5,  false],
  // Seconds over which a change of Symmetry (the fold count, or Mirror)
  // dissolves from the old pattern into the new one. 0 is instant.
  ['sunFoldXfade',       0,   60,  0,    false],
  // the fold count's variance: the standard percent dip on the room clock,
  // each new count riding the Symmetry slide
  ['sunFoldsVar',        0,   1,   0,    false],
  ['sunFoldsPeriod',     1,   60,  10,   true ],
  // the room-clocked swing's phase offset (core/room-clock.js): state, not a
  // control, written by the rate's set()
  ['sunFoldsPeriodOff',  0,   1,   0,    false],
  // The Rotational hum (core/sun-hum.js), the site's own: its loudness, and
  // its cutoff and speed as the site's log maps read them (humHz, humRate
  // below). The cutoff's 0.25 is the site's resting x, its speed's 0 the
  // site's resting rate.
  ['sunHumAmp',          0,   2,   0.9,  false],
  ['sunHumCutoff',       0,   1,   0.25, false],
  // The Cutoff's variance, ridden by its Drive as the Feedback's are, on the
  // 0 to 1 setting: at 100% the drive's bottom takes the cutoff down to
  // 100 Hz (gpu/sun.js moves the filter each frame).
  ['sunHumCutoffVar',    0,   1,   0,    false],
  ['sunHumCutoffVarPeriod', 0, 120, 20,  true ],
  ['sunHumCutoffVarPeriodOff', 0, 1, 0,  false],
  ['sunHumRate',         0,   1,   0,    false],
  // How much of the hum is sent into the app's master room, the music's
  // reverb (core/sun-hum.js setRoomSend). Off by default. Its variance rides
  // a Drive as the Cutoff's does.
  ['sunHumVerb',         0,   1,   0,    false],
  ['sunHumVerbVar',      0,   1,   0,    false],
  ['sunHumVerbVarPeriod', 0,  120, 20,   true ],
  ['sunHumVerbVarPeriodOff', 0, 1, 0,    false],
  // meditatewiththesun.com's master volume: every page opened with
  // ?event=<this broadcast session's name> fades its sound to it (that
  // site's event.js reads it off the broadcast snapshot). Nothing here
  // plays it; it only rides presets and the broadcast.
  ['mwtsVolume',         0,   1,   1,    false],
  // The show's QR code's size (gpu/sun-qr.js), a multiplier on the art's
  // authored size (canvas height * 533 / 1080 at 1). It is the scene, so it
  // rides presets, journeys and the broadcast like every field here.
  ['sunQrSize',          0.25, 2,  1,    false]
];

// A slider's rounded position can come back as 1.1500000000000001; this
// trims it to the step's precision and clamps it into range, so S holds the
// clean number the readout shows and the saved JSON stays tidy.
function fit(v, min, max, integer) {
  if (!(v >= min)) v = min;          // also catches NaN
  if (v > max) v = max;
  return integer ? Math.round(v) : Math.round(v * 10000) / 10000;
}

// The Symmetry slide's taper, the kaleidoscope's own (and the Performance
// window's ramp curve): an exponential through 0 over 0 to 60 s, so 0 to 5 s
// takes about the first 42% of the track. Fine positions, so every value the
// snap below allows has a position of its own and a typed time lands exactly;
// snapped to tenths of a second under 5 s and to half seconds above.
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

// The Speed slider's taper: logarithmic over 1x to 16x, so each doubling
// gets the same stretch of track (1 to 2 as much room as 8 to 16) and the
// slow end is not crushed against the left. Snapped to tenths of a x.
const SPEED_MIN = 1, SPEED_MAX = 16, SPEED_POS = 1000, SPEED_LN = Math.log(SPEED_MAX / SPEED_MIN);
function speedToPos(v) {
  if (!(v === v)) return NaN;
  const c = v < SPEED_MIN ? SPEED_MIN : (v > SPEED_MAX ? SPEED_MAX : v);
  return Math.round(Math.log(c / SPEED_MIN) / SPEED_LN * SPEED_POS);
}
function posToSpeed(pos) {
  const u = pos > 0 ? (pos < SPEED_POS ? pos / SPEED_POS : 1) : 0;
  const q = Math.round(SPEED_MIN * Math.exp(SPEED_LN * u) * 10) / 10;
  return q < SPEED_MAX ? q : SPEED_MAX;
}

function spec(key) {
  for (let i = 0; i < NUM.length; i++) if (NUM[i][0] === key) return NUM[i];
  return null;
}

// Seeds every sun field that is not already on S. Called first thing in
// store.load(), beside initKaleidoState, so the fields exist before any saved
// state is applied and before the first frame. It only fills gaps, so calling
// it twice is harmless.
export function initSunState(S) {
  if (typeof S.layers.sun !== 'boolean') S.layers.sun = false;
  if (typeof S.sunKaleidoOn !== 'boolean') S.sunKaleidoOn = DEF_KALEIDO_ON;
  if (typeof S.sunMirror !== 'boolean') S.sunMirror = DEF_MIRROR;
  if (typeof S.sunFbLink !== 'boolean') S.sunFbLink = DEF_FB_LINK;
  if (typeof S.sunGrade !== 'boolean') S.sunGrade = DEF_GRADE;
  if (typeof S.sunHumOn !== 'boolean') S.sunHumOn = DEF_HUM_ON;
  if (typeof S.sunHiRes !== 'boolean') S.sunHiRes = DEF_HI_RES;
  if (typeof S.sunStars !== 'boolean') S.sunStars = DEF_STARS;
  if (typeof S.sunQrOn !== 'boolean') S.sunQrOn = DEF_QR_ON;
  for (const k of DRIVEN) S[k + 'VarDrive'] = driveOf(S[k + 'VarDrive']);
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i];
    if (typeof S[n[0]] !== 'number') S[n[0]] = n[3];
  }
}

// A plain copy of the sun state, the shape store.js writes and a preset
// snapshot carries. The layer switch goes under its own flat name, as
// kaleidoOn does, so the record does not look like a partial v0 layers
// object.
export function sunStateOf(S) {
  const out = { sunOn: !!S.layers.sun, sunKaleidoOn: !!S.sunKaleidoOn, sunMirror: !!S.sunMirror, sunFbLink: S.sunFbLink !== false, sunGrade: !!S.sunGrade, sunHumOn: !!S.sunHumOn, sunHiRes: !!S.sunHiRes, sunStars: S.sunStars !== false, sunQrOn: !!S.sunQrOn };
  for (const k of DRIVEN) out[k + 'VarDrive'] = driveOf(S[k + 'VarDrive']);
  for (let i = 0; i < NUM.length; i++) out[NUM[i][0]] = S[NUM[i][0]];
  return out;
}

// Restores whatever a stored record or snapshot holds, field by field, and
// leaves anything missing or malformed exactly as it is on S. Out-of-range
// numbers are clamped rather than rejected, so a record from a later build
// with wider ranges still lands somewhere sensible.
export function applySunState(S, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.sunOn === 'boolean') S.layers.sun = o.sunOn;
  if (typeof o.sunKaleidoOn === 'boolean') S.sunKaleidoOn = o.sunKaleidoOn;
  if (typeof o.sunMirror === 'boolean') S.sunMirror = o.sunMirror;
  if (typeof o.sunFbLink === 'boolean') S.sunFbLink = o.sunFbLink;
  if (typeof o.sunGrade === 'boolean') S.sunGrade = o.sunGrade;
  if (typeof o.sunHumOn === 'boolean') S.sunHumOn = o.sunHumOn;
  if (typeof o.sunHiRes === 'boolean') S.sunHiRes = o.sunHiRes;
  if (typeof o.sunStars === 'boolean') S.sunStars = o.sunStars;
  if (typeof o.sunQrOn === 'boolean') S.sunQrOn = o.sunQrOn;
  for (const k of DRIVEN) if (typeof o[k + 'VarDrive'] === 'string') S[k + 'VarDrive'] = driveOf(o[k + 'VarDrive']);
  for (let i = 0; i < NUM.length; i++) {
    const n = NUM[i], v = o[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = fit(v, n[1], n[2], n[4]);
  }
  // A record from the control's first night, when it was the Breath
  // drawer's "Speed link", lands on the variance it became.
  if (typeof o.sunSpeedLink === 'number' && typeof o.sunSpeedVar !== 'number')
    S.sunSpeedVar = fit(o.sunSpeedLink, 0, 1, false);
  // A preset, a journey step, a followed broadcast or another tab's write
  // also moves the controls through their set() (presets.js replayLive, the
  // worker's audio link), which syncs the hum there; this catches the one
  // path that writes state alone, the boot's load, so a hum left on comes
  // back on. Harmless in the engine worker, which has no AudioContext.
  syncHum(S);
}

// ---------- the Rotational hum ----------
// The site's maps, exactly: the cutoff 100 Hz to 10 kHz and the speed
// (AUD_SPAN_LO 0.5 to HI 16) both logarithmic over the 0 to 1 setting.
const HUM_HZ_LO = hum.CUTOFF_LO, HUM_HZ_HI = hum.CUTOFF_HI, HUM_HZ_LN = Math.log(HUM_HZ_HI / HUM_HZ_LO);
const HUM_RATE_LO = 0.5, HUM_RATE_HI = 16, HUM_RATE_LN = Math.log(HUM_RATE_HI / HUM_RATE_LO);
// The whole speed axis is retuned by this factor before it reaches the
// engine, two calls of Robert's stacked (both 2026-10-10): first the sound
// at a displayed 2.15x moved to the 2x mark (2.15/2), then the sound at the
// 0.5x mark moved to 1x (a further halving). The slider, readouts, presets
// and saved settings all keep their positions; only the sound under them
// shifts.
const HUM_RETUNE = (2.15 / 2) * 0.5;
const humHz = hum.cutoffHz;
const humRate = v => HUM_RATE_LO * Math.pow(HUM_RATE_HI / HUM_RATE_LO, v);
// The fine sliders' positions (0 to 1000 over the 0 to 1 setting), and a
// typed Hz or rate read back to one, clamped to the span.
const HUM_POS = 1000;
const hzToPos = hz => hz === hz ? Math.round(Math.min(1, Math.max(0, Math.log(hz / HUM_HZ_LO) / HUM_HZ_LN)) * HUM_POS) : NaN;
const rateToPos = r => r === r ? Math.round(Math.min(1, Math.max(0, Math.log(r / HUM_RATE_LO) / HUM_RATE_LN)) * HUM_POS) : NaN;

// The hum plays only while its own switch AND the Sun layer are on; either
// going off pauses it through its output gate. Every setting is pushed too,
// each setter a no-op when nothing moved, so one call puts the hum wherever
// S says, the cutoff where its variance has it (S.effSunHumCutoff, the
// renderer's) while one plays. Called by every hum and layer set(), and by
// applySunState.
function syncHum(S) {
  hum.setVolume(S.sunHumAmp);
  hum.setMasterVolume(S.volume);
  hum.setCutoffHz(humHz(typeof S.effSunHumCutoff === 'number' ? S.effSunHumCutoff : S.sunHumCutoff));
  hum.setRate(humRate(S.sunHumRate) * HUM_RETUNE);
  hum.setRoomSend(typeof S.effSunHumVerb === 'number' ? S.effSunHumVerb : S.sunHumVerb);
  if (S.sunHumOn && S.layers.sun) hum.play(); else hum.pause();
}

// Every control in the Sun section dims while the layer is off, the same way
// the Kaleidoscope section does, so the viewer can see what the sun would do
// before switching it on.
const layerOn = S => !!S.layers.sun;

// One slider bound 1:1 to a sun field (a multiplier, a rate or a count),
// whose range and default come from the NUM table so the two can never
// disagree.
function direct(id, key, label, step, format) {
  const n = spec(key);
  return {
    id, section: 'sun', label, kind: 'slider',
    min: n[1], max: n[2], step, def: n[3],
    get: S => S[key],
    set: (S, pos) => { S[key] = fit(pos, n[1], n[2], n[4]); save(); },
    format,
    enabled: layerOn
  };
}

// One whole-percent slider over a 0 to 1 field.
function percent(id, key, label, format) {
  const n = spec(key);
  return {
    id, section: 'sun', label, kind: 'slider',
    min: 0, max: 100, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, 0, 1, false); save(); },
    format: format || (S => Math.round(S[key] * 100) + '%'),
    enabled: layerOn
  };
}

// A range row's readout: 'none' while both knobs sit on the centre, else how
// far in, then how far out, each with its sign (the kaleidoscope's own).
function sideText(v) {
  const num = Math.abs(v).toFixed(2);
  if (v === 0) return num;
  return (v < 0 ? '−' : '+') + num;
}
function rangeText(lo, hi) {
  return lo === 0 && hi === 0 ? 'none' : sideText(lo) + ' / ' + sideText(hi);
}

// One whole-percent slider over a 0 to 2 grade field, 100% unchanged,
// shown only while the Color switch is on, and drawn as that switch's child
// (schema-kaleido.js's grade, for the sun).
function grade(id, key, label) {
  const n = spec(key);
  return {
    id, section: 'sun', label, kind: 'slider',
    parent: 'sunGrade',
    min: 0, max: 200, step: 1, def: Math.round(n[3] * 100),
    get: S => Math.round(S[key] * 100),
    set: (S, pos) => { S[key] = fit(pos / 100, n[1], n[2], false); save(); },
    format: S => Math.round(S[key] * 100) + '%',
    enabled: layerOn,
    visible: S => !!S.sunGrade
  };
}

const times2 = key => S => S[key].toFixed(2) + '×';

// Tags a control as part of the variance of the row straight above it (the
// schema's varianceOf), so the drawer folds it out from under that row.
const varianceOf = (owner, c) => { c.varianceOf = owner; return c; };
// Nests a control in the sub-drawer straight above it (the schema's
// `parent`), so the drawer folds it with that drawer.
const under = (parent, c) => { c.parent = parent; return c; };

// A row's variance, folded out from under it as every variance is: what
// drives it (Time, the strobe or the breath), how far it dips, and Time's
// speed, 0 to 120 s a cycle, shown only while Time drives it. The owner's
// blue line is the varied value (its effective, below).
function drivenVariance(owner, name, drawer) {
  const vKey = owner + 'Var', dKey = owner + 'VarDrive', pKey = owner + 'VarPeriod';
  return [
    varianceOf(owner, {
      id: dKey, section: 'sun', label: name + ' variance driver', kind: 'segment', dropdown: true,
      parent: drawer,
      options: DRIVES.map(v => ({ value: v, label: DRIVE_NAMES[v], domId: null })),
      def: DEF_DRIVE,
      get: S => driveOf(S[dKey]),
      set: (S, v) => { S[dKey] = driveOf(v); save(); },
      format: S => DRIVE_NAMES[driveOf(S[dKey])],
      enabled: layerOn
    }),
    varianceOf(owner, under(drawer, percent(vKey, vKey, name + ' variance',
      S => S[vKey] > 0 ? Math.round(S[vKey] * 100) + '%' : 'off'))),
    varianceOf(owner, under(drawer, {
      id: pKey, section: 'sun', label: name + ' variance speed', kind: 'slider',
      min: 0, max: 120, step: 1, def: spec(pKey)[3],
      get: S => S[pKey],
      set: (S, pos) => {
        const v = fit(pos, 0, 120, true);
        retimeRoomPhase(S, pKey + 'Off', S[pKey], v);
        S[pKey] = v;
        save();
      },
      format: S => S[pKey] + 's',
      visible: S => driveOf(S[dKey]) === 'time',
      enabled: layerOn
    }))
  ];
}
// The live varied value gpu/sun.js publishes, as the owner's whole percent.
const fbEffective = (owner, eff) => S => S[owner + 'Var'] > 0 && typeof S[eff] === 'number' ? Math.round(S[eff] * 100) : undefined;

// Atmosphere's readout: at each of the five channel stops (the sweep from the
// photosphere up to the corona) it names the channel; between them, the
// percent.
const ATMO_STOPS = [[0, '1700 Å'], [25, '304 Å'], [50, '171 Å'], [75, '193 Å'], [100, '211 Å']];
function atmoText(S) {
  const p = Math.round(S.sunAtmo * 100);
  for (let i = 0; i < ATMO_STOPS.length; i++) if (ATMO_STOPS[i][0] === p) return ATMO_STOPS[i][1];
  return p + '%';
}

export const SUN_CONTROLS = [
  // Sits in the drawer's Layers group straight after the Text toggle.
  // Off by default: a first visit looks exactly as it did before.
  {
    id: 'lSun', section: 'layers', label: 'Sun', kind: 'toggle', def: false,
    get: S => !!S.layers.sun,
    set: (S, on) => { S.layers.sun = on; syncHum(S); save(); }
  },
  // The same switch again at the head of the Sun section. Every other control
  // here dims while the layer is off, so without this one the section had no
  // way in from inside it. It has no enabled(), so it never dims itself.
  {
    id: 'sunOn', section: 'sun', label: 'On', kind: 'toggle', def: false,
    get: S => !!S.layers.sun,
    set: (S, on) => { S.layers.sun = on; syncHum(S); save(); }
  },

  // ---- Solar Parameters, first of the section's drawers: the picture
  // itself ----
  subDrawer('sunSolarDrawer', 'Solar Parameters', 'sun', ['sunSize', 'sunAtmo']),
  {
    // High quality: the site's original snapshot, streamed at roughly twice
    // the bytes of the standard file. A change swaps the source in place,
    // keeping the place and the play state (gpu/sun.js swapSource).
    id: 'sunHiRes', section: 'sun', label: 'High quality', kind: 'toggle', def: DEF_HI_RES,
    parent: 'sunSolarDrawer',
    get: S => !!S.sunHiRes,
    set: (S, on) => { S.sunHiRes = !!on; save(); },
    enabled: layerOn
  },
  under('sunSolarDrawer', percent('sunOpacity', 'sunOpacity', 'Opacity')),
  {
    // The playback rate, 1x to 16x, on a log taper so each doubling gets the
    // same stretch of track.
    id: 'sunSpeed', section: 'sun', label: 'Speed', kind: 'slider',
    parent: 'sunSolarDrawer',
    min: 0, max: SPEED_POS, step: 1, def: speedToPos(spec('sunSpeed')[3]),
    get: S => speedToPos(S.sunSpeed),
    set: (S, pos) => { S.sunSpeed = posToSpeed(pos); save(); },
    format: S => (Math.round(S.sunSpeed * 10) / 10) + 'x',
    parse: (S, text) => speedToPos(parseFloat(text)),
    // the live dipped rate while the variance breathes, the slider's blue line
    effective: S => typeof S.effSunSpeed === 'number' ? speedToPos(S.effSunSpeed) : undefined,
    enabled: layerOn
  },
  // Speed's variance, folded out from under the Speed row: its driver, its
  // dip and Time's speed (see the NUM table).
  ...drivenVariance('sunSpeed', 'Speed', 'sunSolarDrawer'),
  under('sunSolarDrawer', direct('sunSize', 'sunSize', 'Size', 0.05, times2('sunSize'))),
  under('sunSolarDrawer', percent('sunAtmo', 'sunAtmo', 'Atmosphere', atmoText)),

  // ---- Breath: the sun swelling and settling at a breathing rate, and the
  // trails it leaves ----
  subDrawer('sunBreathDrawer', 'Breath', 'sun', ['sunBreathRate', 'sunBreathAmt']),
  {
    // A live gauge, not a setting: the knob rides the breath gpu/sun.js
    // publishes each frame (S.effSunBreathPos), right on the inhale and left
    // on the exhale, so the cycle can be followed by eye. Its set does
    // nothing, so a drag springs back to the breath and a typed value is
    // refused (parse NaN), and with no def the label click resets nothing.
    // uiOnly keeps it out of presets, journeys, the broadcast and the store.
    id: 'sunBreathGauge', section: 'sun', label: 'Breath', kind: 'slider',
    parent: 'sunBreathDrawer', uiOnly: true,
    min: 0, max: 1000, step: 1,
    get: S => Math.round((S.effSunBreathPos ?? 0.5) * 1000),
    set: () => {},
    format: S => S.effSunBreathIn === true ? 'Inhaling' : S.effSunBreathIn === false ? 'Exhaling' : '—',
    parse: () => NaN,
    enabled: layerOn
  },
  under('sunBreathDrawer', direct('sunBreathRate', 'sunBreathRate', 'Rate', 0.1,
    S => S.sunBreathRate.toFixed(1) + ' / min')),
  under('sunBreathDrawer', percent('sunBreathAmt', 'sunBreathAmt', 'Amount')),
  // How far the breath carries the video's speed, to a stop at the exhale.

  // ---- Feedback: the trails the sun leaves, and a Stream that can ride the
  // breath ----
  subDrawer('sunFeedbackDrawer', 'Feedback', 'sun', ['sunFbAmt', 'sunFbStream']),
  under('sunFeedbackDrawer', Object.assign(percent('sunFbAmt', 'sunFbAmt', 'Amount'),
    { effective: fbEffective('sunFbAmt', 'effSunFbAmt') })),
  ...drivenVariance('sunFbAmt', 'Amount', 'sunFeedbackDrawer'),
  under('sunFeedbackDrawer', Object.assign(percent('sunFbOpacity', 'sunFbOpacity', 'Opacity'),
    { effective: fbEffective('sunFbOpacity', 'effSunFbOpacity') })),
  ...drivenVariance('sunFbOpacity', 'Opacity', 'sunFeedbackDrawer'),
  // The Center fade: the inner sun kept out of the trails, so they flow
  // only from the edge. The live picture is never faded.
  under('sunFeedbackDrawer', percent('sunFbGate', 'sunFbGate', 'Center fade',
    S => S.sunFbGate > 0 ? Math.round(S.sunFbGate * 100) + '%' : 'off')),
  // How gently the Center fade opens, from a near cut to a slow bloom.
  under('sunFeedbackDrawer', percent('sunFbGateSoft', 'sunFbGateSoft', 'Center fade softness')),
  {
    id: 'sunFbLink', section: 'sun', label: 'Link to breath', kind: 'toggle', def: DEF_FB_LINK,
    parent: 'sunFeedbackDrawer',
    get: S => S.sunFbLink !== false,
    set: (S, on) => { S.sunFbLink = !!on; save(); },
    enabled: layerOn
  },
  // The manual Stream: each frame's faded copy is taken a little larger
  // (outward) or smaller (inward) about the centre. Greyed while the breath
  // drives it.
  under('sunFeedbackDrawer', Object.assign(
    direct('sunFbStream', 'sunFbStream', 'Stream', 0.01, S => S.sunFbStream === 0 ? 'none'
      : (S.sunFbStream > 0 ? '+' + S.sunFbStream.toFixed(2) + ' out' : S.sunFbStream.toFixed(2) + ' in')),
    { enabled: S => layerOn(S) && S.sunFbLink === false })),
  {
    // Where the breath carries the Stream while linked: in at its bottom, out
    // at its top. Greyed while the link is off.
    id: 'sunFbStreamRange', section: 'sun', label: 'Breath range', kind: 'range',
    parent: 'sunFeedbackDrawer',
    min: -1, max: 1, step: 0.01, defLo: spec('sunFbStreamLo')[3], defHi: spec('sunFbStreamHi')[3],
    getLo: S => S.sunFbStreamLo,
    getHi: S => S.sunFbStreamHi,
    setLo: (S, v) => { S.sunFbStreamLo = fit(v, -1, 0); save(); },
    setHi: (S, v) => { S.sunFbStreamHi = fit(v, 0, 1); save(); },
    format: S => rangeText(S.sunFbStreamLo, S.sunFbStreamHi),
    enabled: S => layerOn(S) && S.sunFbLink !== false
  },

  // ---- Color: the site's own grade of the picture, before the feather, so
  // the live sun, the fold and the trails all carry it. The grade's switch
  // heads its sliders, indented under it; off, the grade is not applied and
  // the sliders are hidden, keeping their values for when it comes back on.
  subDrawer('sunColorDrawer', 'Color', 'sun', ['sunBright', 'sunContrast', 'sunSat']),
  {
    id: 'sunGrade', section: 'sun', label: 'Color', kind: 'toggle', def: DEF_GRADE,
    parent: 'sunColorDrawer',
    get: S => !!S.sunGrade,
    set: (S, on) => { S.sunGrade = !!on; save(); },
    enabled: layerOn
  },
  grade('sunBright', 'sunBright', 'Brightness'),
  grade('sunContrast', 'sunContrast', 'Contrast'),
  grade('sunSat', 'sunSat', 'Saturation'),

  // ---- Kaleidoscope: the sun folded into wedges ----
  subDrawer('sunKaleidoDrawer', 'Kaleidoscope', 'sun', ['sunKaleidoOn', 'sunFolds']),
  {
    id: 'sunKaleidoOn', section: 'sun', label: 'Kaleidoscope', kind: 'toggle', def: DEF_KALEIDO_ON,
    parent: 'sunKaleidoDrawer',
    get: S => !!S.sunKaleidoOn,
    set: (S, on) => { S.sunKaleidoOn = !!on; save(); },
    enabled: layerOn
  },
  // How many wedges the circle is cut into. The readout keeps the number
  // first, so clicking it to type opens on the fold count itself.
  under('sunKaleidoDrawer', direct('sunFolds', 'sunFolds', 'Symmetry', 1, S => S.sunFolds + '-fold')),
  // Symmetry's dip and its rate fold out from under Symmetry, the rate on
  // the room clock, retimed as the kaleidoscope's is
  varianceOf('sunFolds', under('sunKaleidoDrawer', percent('sunFoldsVar', 'sunFoldsVar', 'Symmetry variance'))),
  varianceOf('sunFolds', under('sunKaleidoDrawer', {
    id: 'sunFoldsPeriod', section: 'sun', label: 'Symmetry variance rate', kind: 'slider',
    min: 1, max: 60, step: 1, def: 10,
    get: S => S.sunFoldsPeriod,
    set: (S, pos) => {
      const v = fit(pos, 1, 60, true);
      retimeRoomPhase(S, 'sunFoldsPeriodOff', S.sunFoldsPeriod, v);
      S.sunFoldsPeriod = v;
      save();
    },
    format: S => S.sunFoldsPeriod + 's / cycle',
    enabled: layerOn
  })),
  {
    // Whether alternate wedges are reflected, the way a real kaleidoscope's
    // mirrors fold the image, or simply repeated around the circle.
    id: 'sunMirror', section: 'sun', label: 'Mirror', kind: 'toggle', def: DEF_MIRROR,
    parent: 'sunKaleidoDrawer',
    get: S => !!S.sunMirror,
    set: (S, on) => { S.sunMirror = !!on; save(); },
    enabled: layerOn
  },
  // The fold's turning, in revolutions per minute, positive clockwise.
  under('sunKaleidoDrawer', direct('sunKaleidoSpin', 'sunKaleidoSpin', 'Rotation', 0.1,
    S => S.sunKaleidoSpin === 0 ? 'still' : S.sunKaleidoSpin.toFixed(1) + ' rpm')),
  {
    // How a change of Symmetry (the fold count or Mirror) arrives. Instant
    // snaps to the new pattern; a time draws the old symmetry and the new one
    // together and dissolves from the one to the other across that many
    // seconds. The same taper and snap as the kaleidoscope's Symmetry slide.
    id: 'sunFoldXfade', section: 'sun', label: 'Symmetry slide', kind: 'slider',
    parent: 'sunKaleidoDrawer',
    min: 0, max: XFADE_POS, step: 1, def: 0,
    get: S => xfadeToPos(S.sunFoldXfade),
    set: (S, pos) => { S.sunFoldXfade = posToXfade(pos); save(); },
    format: S => {
      const v = S.sunFoldXfade;
      return v > 0 ? (v === Math.round(v) ? v : v.toFixed(1)) + 's' : 'instant';
    },
    parse: (S, text) => /^\s*inst/i.test(text) ? 0 : xfadeToPos(parseFloat(text)),
    enabled: layerOn
  },

  // ---- Rotational hum, last of the section's drawers: the site's sound,
  // the solar wind's 62.8 years as one looping tone (core/sun-hum.js). Its
  // switch rides the drawer's strip, as the Audio voices' do; it plays only
  // while the Sun layer is on too. Every set() pushes straight into the hum
  // (syncHum), whose own ramps keep a drag from zippering ----
  {
    id: 'sunHumOn', section: 'sun', label: 'Rotational hum', kind: 'toggle', def: DEF_HUM_ON,
    get: S => !!S.sunHumOn,
    set: (S, on) => { S.sunHumOn = !!on; syncHum(S); save(); },
    enabled: layerOn
  },
  subDrawer('sunHumDrawer', 'Rotational hum', 'sun', ['sunHumAmp', 'sunHumCutoff'], 'sunHumOn'),
  {
    id: 'sunHumAmp', section: 'sun', label: 'Amplitude', kind: 'slider',
    parent: 'sunHumDrawer',
    min: 0, max: 200, step: 1, def: Math.round(spec('sunHumAmp')[3] * 100),
    get: S => Math.round(S.sunHumAmp * 100),
    set: (S, pos) => { S.sunHumAmp = fit(pos / 100, 0, 2, false); syncHum(S); save(); },
    format: S => Math.round(S.sunHumAmp * 100) + '%',
    enabled: layerOn
  },
  {
    // The lowpass's corner, 100 Hz to 10 kHz on the site's log map.
    id: 'sunHumCutoff', section: 'sun', label: 'Cutoff', kind: 'slider',
    parent: 'sunHumDrawer',
    min: 0, max: HUM_POS, step: 1, def: Math.round(spec('sunHumCutoff')[3] * HUM_POS),
    get: S => Math.round(S.sunHumCutoff * HUM_POS),
    set: (S, pos) => { S.sunHumCutoff = fit(pos / HUM_POS, 0, 1, false); syncHum(S); save(); },
    format: S => Math.round(humHz(S.sunHumCutoff)) + ' Hz',
    parse: (S, text) => hzToPos(parseFloat(text)),
    // the live cutoff while its variance plays, the slider's blue line
    effective: S => S.sunHumCutoffVar > 0 && typeof S.effSunHumCutoff === 'number'
      ? Math.round(S.effSunHumCutoff * HUM_POS) : undefined,
    enabled: layerOn
  },
  ...drivenVariance('sunHumCutoff', 'Cutoff', 'sunHumDrawer'),
  {
    // How fast the series plays, 0.5x to 16x on the site's log map (1 hour
    // of sun is one sample at 48 kHz, so 1x is about 5.5 years a second).
    // The dial snaps to the landmarks 0.5x, 1x and 2x: a drag landing
    // within 0.05 of one takes it exactly.
    id: 'sunHumRate', section: 'sun', label: 'Speed', kind: 'slider',
    parent: 'sunHumDrawer',
    min: 0, max: HUM_POS, step: 1, def: Math.round(spec('sunHumRate')[3] * HUM_POS),
    get: S => Math.round(S.sunHumRate * HUM_POS),
    set: (S, pos) => {
      let v = fit(pos / HUM_POS, 0, 1, false);
      const r = humRate(v);
      for (const t of [0.5, 1, 2]) if (Math.abs(r - t) <= 0.05) { v = Math.log(t / HUM_RATE_LO) / HUM_RATE_LN; break; }
      S.sunHumRate = v; syncHum(S); save();
    },
    format: S => humRate(S.sunHumRate).toFixed(2) + 'x',
    parse: (S, text) => rateToPos(parseFloat(text)),
    enabled: layerOn
  },
  {
    // The send into the app's master room, the reverb every music voice
    // shares, heard while the transport runs (core/sun-hum.js).
    id: 'sunHumVerb', section: 'sun', label: 'Reverb mix', kind: 'slider',
    parent: 'sunHumDrawer',
    min: 0, max: 100, step: 1, def: Math.round(spec('sunHumVerb')[3] * 100),
    get: S => Math.round(S.sunHumVerb * 100),
    set: (S, pos) => { S.sunHumVerb = fit(pos / 100, 0, 1, false); syncHum(S); save(); },
    format: S => Math.round(S.sunHumVerb * 100) + '%',
    // the live send while its variance plays, the slider's blue line
    effective: S => S.sunHumVerbVar > 0 && typeof S.effSunHumVerb === 'number'
      ? Math.round(S.effSunHumVerb * 100) : undefined,
    enabled: layerOn
  },
  ...drivenVariance('sunHumVerb', 'Reverb mix', 'sunHumDrawer'),

  // ---- meditatewiththesun.com: the room's volume on that site, for the
  // phones following this broadcast (see mwtsVolume above). Never dimmed:
  // it steers the room whether or not this screen shows the sun ----
  subDrawer('sunMwtsDrawer', 'meditatewiththesun.com', 'sun', ['mwtsVolume']),
  {
    id: 'mwtsVolume', section: 'sun', label: 'Master volume', kind: 'slider',
    parent: 'sunMwtsDrawer',
    min: 0, max: 100, step: 1, def: 100,
    get: S => Math.round(S.mwtsVolume * 100),
    set: (S, pos) => { S.mwtsVolume = fit(pos / 100, 0, 1, false); save(); },
    format: S => Math.round(S.mwtsVolume * 100) + '%'
  },

  // ---- Sun QR, the section's last rows: the show's QR PNG over
  // everything, the sun and any slide alike (gpu/sun-qr.js), dead centre.
  // Never dimmed: it draws whether or not the sun layer is on ----
  {
    id: 'sunQrOn', section: 'sun', label: 'Sun QR', kind: 'toggle', def: DEF_QR_ON,
    get: S => !!S.sunQrOn,
    set: (S, on) => { S.sunQrOn = !!on; save(); }
  },
  {
    // A multiplier on the art's authored size, 25% to 200%.
    id: 'sunQrSize', section: 'sun', label: 'Size', kind: 'slider',
    min: 25, max: 200, step: 1, def: Math.round(spec('sunQrSize')[3] * 100),
    get: S => Math.round(S.sunQrSize * 100),
    set: (S, pos) => { S.sunQrSize = fit(pos / 100, 0.25, 2, false); save(); },
    format: S => Math.round(S.sunQrSize * 100) + '%'
  },

  // ---- Star field, a section of its own: meditatewiththesun.com's one
  // control for its sky, the switch. Never dimmed: the stars drift whether
  // or not the sun is shown (gpu/stars.js) ----
  {
    id: 'sunStars', section: 'stars', label: 'Star field', kind: 'toggle', def: DEF_STARS,
    get: S => S.sunStars !== false,
    set: (S, on) => { S.sunStars = !!on; save(); }
  }
];

export const SUN_SECTIONS = [
  { id: 'sun', title: 'Sun' },
  { id: 'stars', title: 'Star field' }
];
