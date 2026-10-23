// The journey: a guided sequence of the app's own states, walked step by step.
//
// A journey is an ordered list of steps. A step is a whole scene: it holds
// every control a step can hold (the ones a snapshot replays, presets.js),
// by the same positions a built-in preset names in its inputs (a control's
// own units, what get(S) hands back), plus its own on-screen text and where
// in the ramp it appears, a ramp (how long its settings take to glide in), a
// hold (how long auto-play stays once they have), and how the piano plays
// while it lasts. Two doors onto one state (see twins) are held once, under
// the first of them.
//
// Authoring rides the drawer, the one settings UI. A new step takes the
// scene as it stands. While the Journey window is open with a step selected
// for editing, every drawer change is noticed (store.js's onSave, a mark and
// nothing more) and each control's destination, where it is headed or else
// where it is, is written into the step, so the step is always the scene on
// screen. A control the operator has locked (journeyToggleLock) is never
// written, and never moved.
// iPad controls are performance-only: their changes stay out of automatic
// recording, including later saves by other controls. A row's Snapshot
// explicitly takes the live scene into that step, including those changes.
//
// Playing enters a step by comparing it with where everything is headed now
// and touching only what differs: nothing is sent where nothing would change,
// so a voice already playing is never started again and a layer already on
// never blinks, and entering the step one is already in moves nothing. What
// differs lands in two parts. What cannot glide lands first, at once, inside
// one short transition opened the way a preset recall opens one (presets.js):
// every segment and switch, clickMode first, since the pip controls address
// the click or the chirp by it. Then every slider travels from where it is to
// where the step puts it, eased over the step's ramp, a little further each
// frame (stepTween), through the control's own set(), so the drawer's faders
// are seen to move and the sound follows each on its own short glide; the
// colour crosses in RGB. A control the viewer moves mid-ramp (or another tab
// does) is theirs from then on and leaves the ramp at once, and during a walk
// a hand's move keeps the control for the rest of the walk (the manual set),
// so a tweak made while the journey plays persists through every later step.
// A ramp of 0 is a cut, applied all at once as a preset is. Auto-play moves
// on once the ramp and the hold have passed, and after the last step stops,
// or with loop on goes round to the first again; without it the window's
// arrows move by hand. A voice the step turns on or off is the exception to
// switches landing first: it enters and leaves through its level over the
// ramp, by the same door the Music window's rows use (perform.js perfLayer;
// see throughDoor).
//
// Playing and authoring stay apart, and nothing the window does short of its
// transport and deleting the playing step ever stops or restarts the walk.
// Selecting a step while the walk plays only opens its fold, for its own
// fields (hold, ramp, text, piano): the walk carries on, and nothing the
// drawer does meanwhile is recorded, since the walk is moving the drawer too.
// Selecting a step with the walk stopped or paused selects it for editing,
// which is what ends the walk. Starting a walk stops the recording into the
// step being edited and leaves its fold open.
//
// Beside its controls, every step holds the whole sequencer and the whole
// mix (see "the sequencer and the mix" below): the eight lines and the active one, the fixed channels' mutes and
// solos, and every atmosphere recording's level, mute and solo. A ramp
// crossfades those too: numbers travel, a line changing waveform sounds both
// waves at once and trades them over the ramp, the mixer's mutes and solos
// turn as the ramp begins while the sound under them glides over the whole
// ramp (js/mixgate.js), a line's mute and solo turn at the ramp's midpoint,
// and the rest lands as the ramp begins.
//
// The viewer keeps a library of journeys, one open at a time: the Journey
// window's row of chips (ui/screens/journey.js). Everything above is about
// the open one; everything the window edits is saved into it as it happens,
// as a document is, so there is no separate save. Opening another, making a
// new one, or deleting the open one ends the walk and lets any selected step
// go (what the drawer had changed recorded first, into the journey it
// belonged to). The library's index, { ver: 1, cur: id, items: [{ id, title }] },
// lives under LIB_KEY, and each journey's own record under its own key
// (keyOf), so an edit writes only the journey it touches. The first read with
// no index takes the one journey the app kept before (under JOURNEY_KEY,
// which is left as it was) as the library's first.
//
// A journey's record is { ver: 2, steps: [step, ...], mode, trigger, autoPlay, loop, name }, mode
// being the AUTO button's 'off' | 'auto' | 'keys' ('keys' is shown as TRIGGER), trigger
// what drives TRIGGER mode, 'keys' (the digits and arrows, main.js) or 'midi' (notes,
// ui/screens/journey.js), and autoPlay its old boolean,
// still written (true only in 'auto') and read when a record has no mode; a step being
//   { overrides: { [controlId]: value }, text: '', appear: 'start', textLock: false,
//     rampS: 3, holdS: 60, piano: 'free', interaction: 'none',
//     seq: { seqSlot, seqs: [line x 8] } | null,
//     mix: { chanMute, chanSolo, layers: [{ source, level, peak, muted, solo }] } | null },
// appear being 'start' | 'mid' | 'end' and piano 'free' | 'text' | 'mixed',
// seq in store.js's seqStateOf shape and mix in its mixStateOf shape plus the
// recordings, read lazily on first use (store.js receives its storage at
// boot, after this module has loaded) under its own key, and written back
// through saveKey, as presets.js keeps the viewer's presets.
//
// A record of ver 1 holds steps as diffs: each named only what it changed,
// and everything else was left as the viewer had it. Such a record is read
// forward (readJourney): step 1, filled out with the scene as it stands for
// anything it never named, is the start, and each later step is the one
// before it with its own changes laid over, which is exactly the scene a walk
// from the top reached at that step. It is written back as ver 2 straight
// away, so the scene it was filled from is the one it keeps. A ver 2 record
// is read the same way, which fills in only a control the app has gained
// since it was written.
import { S } from '../js/state.js';
import { endGlide } from '../js/audio.js';
import { pianoGesture, applySeqs, SEQ_WAVES, SEQ_COUNT } from '../js/piano.js';
import { CHANNELS, applyMixGates } from '../js/mixgate.js';
import { normalizeAmbLayers, syncAmbLayers } from '../js/ambience.js';
import { byId } from './schema.js';
import { AUDIO_CONTROLS } from './schema-audio.js';
import { REPLAY_CONTROLS, beginTransition, recallPresetForStep, machineControl } from './presets.js';
import { idleTouch } from '../js/idle-ahead.js';
import { readKey, saveKey, onSave, save, seqStateOf, applySeqState, mixStateOf, SEQ_NUM_RANGE, oldRingSpeed } from './store.js';
import { onWordAppear, wordSequenceOnce, cancelWordSequenceOnce } from './words.js';
import { glideSkippingRiskBand } from './strobe.js';
// A cycle, perform.js importing this module for journeyManualOverride: both
// sides only call across it at run time, never as either module is first
// evaluated, so whichever loads first is complete before the other asks.
import { perfDestination, perfLayer, perfRelease } from './perform.js';

const JOURNEY_KEY = 'signal.journey.v1';
export const RAMP_MIN = 0, RAMP_MAX = 30, HOLD_MIN = 5, HOLD_MAX = 600;
const RAMP_DEF = 3, HOLD_DEF = 60;
export const STEP_TEXT_MAX = 2000;
// The journey's one name (the window's gear): every step's text says it
// wherever it says NAME, so it is typed once for the whole walk.
export const NAME_MAX = 60;
// A journey's title, the label on its chip, and how many the library holds.
export const TITLE_MAX = 32;
const LIB_MAX = 64;
const STEPS_MAX = 99;
// Selecting a step to edit it glides it in over this, short, so what the
// drawer shows is the step and the change is still no jump.
const EDIT_GLIDE_S = 0.75;
// A ramp of 0 still opens a transition this long, so a cut is a quick glide
// rather than a click in every level it moves.
const MIN_GLIDE_S = 0.05;
// A ramp shorter than this is applied as a cut: a tween over a frame or two
// would only be a slower cut.
const TWEEN_MIN_S = 0.25;
// What cannot glide (a segment, a switch) lands as a ramp begins, inside a
// transition this long, so the levels it changes still move without a click.
const SWITCH_GLIDE_S = 0.75;
// The drawer's gold on the ramping rows holds full for most of the ramp and
// fades out over its last 1 / GLOW_TAIL.
const GLOW_TAIL = 4;
const DIFF_MS = 300;
const PIANO_OK = { free: 1, text: 1, mixed: 1 };
const APPEAR_OK = { start: 1, mid: 1, end: 1 };
// Where in the ramp each appearance falls, as a fraction of it.
const APPEAR_AT = { start: 0, mid: 0.5, end: 1 };
const INTERACTION_OK = { none: 1 };
// Journey text fades and time on screen are composed in half-second beats
// even though the drawer offers finer timing. Values entering a Journey from its own UI,
// the drawer, a preset, or an older saved record all land on that grid.
const HALF_SECOND_FADE = new Set(['textFadeIn', 'textFadeOut', 'textDwell']);

// The controls a step can hold: exactly the ones a snapshot replays
// (presets.js), in its order, clickMode first. This machine's own controls
// are left out (presets.js machineControl, the drawer's Render section): how
// this screen draws, pauses and shows its hint, the parallax sim (a viewing
// aid standing in for head tracking), and which thread runs the app, which
// restarts the engine besides. None of that is a state of the session, and
// a step saved before they were left out has them dropped as it is read
// (readStep). And so are Live Sound's switch, input and latency
// (js/livesound.js): a step must never open a microphone on its own, and an
// input's id and the buffer its hardware wants belong to this machine alone.
// Nor the room's own level and tone: Master volume and the global Lowpass
// and Highpass and their resonance and glide (vol, lpf, hpf, lpfRes, hpfRes, filterGlide) are the operator's, ridden live from the
// drawer or the show remote, so no cue may set them back. Nor the master
// reverb's decay (pianoRevTime), set by hand and left to stay. Nor a slide's own
// level (slideVol): it lives in the per-slide map (core/schema-slides.js),
// edited by the fold's VOL, so a step that held a copy would set the slide
// back to that stale copy each time it was entered. A step saved
// holding one has it dropped as it is read, as with the controls above, and
// an id no control has any more (the Slides' old slideLP and slideHP) is
// passed over the same way, silently.
const R = REPLAY_CONTROLS;
const idxOf = new Map();
const skip = new Uint8Array(R.length);
const NEVER_IN_STEP = new Set(['liveOn', 'liveDevice', 'liveLatency', 'vol', 'lpf', 'hpf', 'lpfRes', 'hpfRes', 'filterGlide', 'pianoRevTime', 'slideVol']);
for (let i = 0; i < R.length; i++) {
  idxOf.set(R[i].id, i);
  if (machineControl(R[i]) || NEVER_IN_STEP.has(R[i].id)) skip[i] = 1;
}

// Twins: two controls that are doors onto the same state, as the drawer's
// Ambience switch and the mixer's power button both are S.ambOn, or the
// Layers group's Particles and the Particles section's On. Found by what
// each one's get reads from S (through a proxy that only notes the paths it
// is asked for), so a new pair is a twin the moment it exists. A step holds
// one value for the one truth: the group's first door in REPLAY order (its
// canonical, canon below), which is read as the scene is taken and set as a
// step is entered, the others following through the state they share. Were
// each door kept apart, a step could hold the other door's stale position,
// and entering it would set the fresh one and then the stale one straight
// after, undoing the edit.
function readsOf(c) {
  const seen = new Set();
  const wrap = (obj, path) => new Proxy(obj, {
    get(t, k) {
      const v = t[k];
      if (typeof k !== 'string') return v;
      const p = path ? path + '.' + k : k;
      seen.add(p);
      return v && typeof v === 'object' && !ArrayBuffer.isView(v) ? wrap(v, p) : v;
    }
  });
  try { c.get(wrap(S, '')); } catch (e) { return ''; }
  return [...seen].sort().join('|');
}
const twins = new Map();
{
  const byReads = new Map();
  for (let i = 0; i < R.length; i++) {
    if (!R[i].get) continue;
    const key = readsOf(R[i]);
    if (!key) continue;
    if (!byReads.has(key)) byReads.set(key, []);
    byReads.get(key).push(R[i].id);
  }
  for (const ids of byReads.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) twins.set(id, ids.filter(t => t !== id));
  }
}
const withTwins = id => twins.has(id) ? [id, ...twins.get(id)] : [id];
// canon[i]: the place in R of the door control i's value is held under, i
// itself for a control with no twin (and for a twin a step never holds). The
// first twin a step can hold, so a group whose first door is this machine's
// own is still held through the next. flip[i]: a switch twin that reads the
// opposite of its canonical (a mute beside an on), its stored value turned
// over on the way in from an old record.
const canon = new Int32Array(R.length);
const flip = new Uint8Array(R.length);
for (let i = 0; i < R.length; i++) canon[i] = i;
for (const [id, tws] of twins) {
  const i = idxOf.get(id);
  if (skip[i]) continue;
  let k = i;
  for (let n = 0; n < tws.length; n++) { const j = idxOf.get(tws[n]); if (j < k && !skip[j]) k = j; }
  canon[i] = k;
  if (k !== i) {
    let a, b;
    try { a = R[i].get(S); b = R[k].get(S); } catch (e) { a = b = undefined; }
    if (typeof a === 'boolean' && typeof b === 'boolean' && a !== b) flip[i] = 1;
  }
}

// The switches a step moves through the performer's door (perform.js
// perfLayer) instead of its own switch pass (throughDoor, below). opAt[i] is
// the place in R of the level switch i enters and leaves through, the
// schema's op for it (core/schema-audio.js), -1 for a switch with none or one
// a step could not hold. voice[i] marks a sound's: a voice the step turns on
// or off rides the step's ramp through its level, as the Music window's rows
// fade one, since a switch landing in the short glide brought a voice in at
// its standing level however long the ramp. A layer's switch still turns as
// the ramp begins and crossfades over it with the picture (startRamp's
// transition span), so for a layer only a fade already taking it off goes
// through the door, to be taken over. Live Sound's switch is never in a step
// (NEVER_IN_STEP), so it is never one.
const AUDIO = new Set(AUDIO_CONTROLS);
const opAt = new Int32Array(R.length).fill(-1);
const voice = new Uint8Array(R.length);
for (let i = 0; i < R.length; i++) {
  const c = R[i], j = c.op ? idxOf.get(c.op) : undefined;
  if (j === undefined || skip[i] || skip[j] || R[j].kind !== 'slider') continue;
  opAt[i] = j;
  if (AUDIO.has(c)) voice[i] = 1;
}
// The places in R the door took for the step being entered (throughDoor):
// each switch it moved, the switch's twins, and the level it was handed. And
// whether the journey is going through the door right now, when the door's
// word that a hand moved something (journeyManualOverride) is its own echo.
const doorHeld = new Uint8Array(R.length);
let driving = false;
// Remote performance changes still save the live session and broadcast it,
// but never author a step. Remember their controls until a scene is recalled
// or the operator explicitly edits/captures them: suppressing only the
// setter's save would let an unrelated later drawer edit capture them.
const performanceControls = new Set();
let performanceWriting = 0;

export function journeyPerformanceControl(id, apply) {
  performanceWriting++;
  try {
    for (const t of withTwins(id)) {
      const i = idxOf.get(t);
      if (i !== undefined) performanceControls.add(canon[i]);
      releaseJourneyControl(t);
      perfRelease(t);
    }
    return apply();
  } finally { performanceWriting--; }
}

// Where control c will come to rest, undefined when nothing is moving it:
// the performer's engine (perform.js perfDestination: a layer or a voice
// fading out, from a window or a step's ramp, a preset's ramp, any glide). A
// twin (see twins) shares its state with a door the engine may be moving, as
// the mixer's power button shares S.ambOn with the Ambience switch, so a
// switch whose own id names no destination takes its twin's: the same value
// when the two read alike now, the other when they read opposite (a mute
// beside an on). Anything else of a twin's is left to its own reading, since
// a slider's twin can be scaled differently.
function destOf(c) {
  const d = perfDestination(c.id);
  if (d !== undefined) return d;
  const tws = twins.get(c.id);
  if (!tws) return undefined;
  for (let k = 0; k < tws.length; k++) {
    const td = perfDestination(tws[k]);
    if (typeof td !== 'boolean') continue;
    const tc = byId(tws[k]), a = tc && tc.get ? tc.get(S) : undefined, b = c.get(S);
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? td : !td;
  }
  return undefined;
}
// What the journey records for c, and what a step entering compares with:
// where it is headed, else where it is. The journey's own ramp counts, so
// the scene taken mid-ramp (a step added while a walk plays) holds where
// each slider is going, not where it got to.
function posOf(c) {
  if (tw.active) {
    const i = idxOf.get(c.id), k = i === undefined ? -1 : twAt[i];
    if (k >= 0 && k < tw.n && twIdx[k] === i) return twTo[k];
    if (tw.colorOn && c === COLOR) return cHex;
  }
  const d = destOf(c);
  return d !== undefined ? d : c.get(S);
}
// Whether two positions of c are the same: a switch's on whether it is
// written true or 1, a colour's hex in either case.
function same(c, a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (c.kind === 'toggle') return (a === true || a === 1) === (b === true || b === 1);
  if (c.kind === 'color') return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  return false;
}
// Whether control c already stands where a step puts it (v), or is headed
// there: read through the same check a stored value passes (validValue), so
// a position outside a slider's range or off a fade's half-second grid is
// judged as the step would have stored it. Nothing that is settled is sent.
function settled(c, v) {
  return same(c, validValue(c, posOf(c)), v);
}

const MODE = byId('textMode'), CUSTOM = byId('textCustomText');
const COLOR_I = idxOf.has('color') ? idxOf.get('color') : -1;
const COLOR = COLOR_I >= 0 ? R[COLOR_I] : null;
const SIZE_I = idxOf.has('textSize') ? idxOf.get('textSize') : -1;
const SIZE = SIZE_I >= 0 ? R[SIZE_I] : null;

let data = null;
let version = 0;
// The library's index, and every journey read so far by id (the open one's
// record is `data`), kept so going back to one never reads storage that a
// write still pending has yet to reach.
const LIB_KEY = 'signal.journeys.v1';
const keyOf = id => JOURNEY_KEY + '.' + id;
let lib = null;
const cache = new Map();
// Where the walk last stood, { id, step }: written as each step is entered,
// and read once, as the page's first journey loads, so a reload can come
// back to it (Settings > Journey page reload, S.journeyReload).
const POS_KEY = 'signal.journeyPos.v1';
let cued = false;

// The step whose fold is open (-1 for none), whether the window is showing,
// and whether that step is being edited (armed: drawer changes are recorded
// into it).
let sel = -1, winOpen = false, armed = false;
let diffPending = false, lastDiffT = -1e9, nowT = 0;

// Controls the viewer has taken over during this walk. A manual move owns
// that control until the walk is stopped, including through later steps and
// a loop back to the beginning. Without this, a step that records a layer as
// on can switch it straight back on after the viewer has deliberately turned
// it off.
const manual = new Set();

// The walk: whether it is playing, which step it is on (kept while paused,
// -1 when stopped), the auto-play clock that step's ramp and hold are counted
// on, when the step was entered, when a pause began (so a resume carries on
// from the same point), and when the step's text is due on screen (-1 once
// shown, or when there is none to show).
const play = { playing: false, stepIdx: -1, phaseStartT: 0, enterT: 0, pausedAt: 0, appearAt: -1 };

// Temporary, intentionally loud diagnostics while the Journey authoring
// path is being verified in the browser console.
const JOURNEY_DIAG = true;
function journeyDiag(event, extra = null) {
  if (!JOURNEY_DIAG) return;
  console.log('[journey diagnostic]', event, {
    selected: sel, armed, windowOpen: winOpen,
    playing: play.playing, playStep: play.stepIdx,
    particles: !!(S.layers && S.layers.particles),
    ...(extra || {})
  });
}

function makeStep() {
  return { overrides: {}, text: '', appear: 'start', textLock: false, rampS: RAMP_DEF, holdS: HOLD_DEF, piano: 'free', interaction: 'none',
           seq: null, mix: null };
}

const clampN = (v, lo, hi, def) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;

// Whether a stored value can be a position of control c: a segment's own
// option, a toggle's on or off, a slider's number (clamped into its range),
// a colour's hex. Anything else is dropped, so an old or hand-edited record
// can never hand a control a value it has no meaning for. Returns the value
// to keep, or undefined.
function validValue(c, v) {
  if (c.kind === 'segment') {
    for (let k = 0; k < c.options.length; k++) if (c.options[k].value === v) return v;
    return undefined;
  }
  if (c.kind === 'toggle') return typeof v === 'boolean' ? v : v === 0 || v === 1 ? v === 1 : undefined;
  if (c.kind === 'slider') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    if (HALF_SECOND_FADE.has(c.id)) v = Math.round(v / 500) * 500;
    return Number.isFinite(c.min) && Number.isFinite(c.max) ? Math.max(c.min, Math.min(c.max, v)) : v;
  }
  if (c.kind === 'color') return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
  return undefined;
}

// A stored step, checked. Its controls are read in REPLAY order, each twin's
// value going to its group's canonical door (turned over for one that reads
// the opposite way), so an old record that kept each door apart comes in as
// one value for the one truth: the last of them in that order, which is the
// one that won when such a step was entered (each door set in turn).
function readStep(raw) {
  const st = makeStep();
  if (!raw || typeof raw !== 'object') return st;
  const o = raw.overrides;
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    // The Breath drawer's old Amount became Atmosphere's variance
    // (schema-sun.js), both whole-percent positions: a step from before the
    // move carries its value over unless it already holds the new key.
    if (o.sunAtmoVar === undefined && typeof o.sunBreathAmt === 'number') o.sunAtmoVar = o.sunBreathAmt;
    for (let i = 0; i < R.length; i++) {
      const id = R[i].id;
      if (skip[i] || !Object.prototype.hasOwnProperty.call(o, id)) continue;
      let v = validValue(R[i], o[id]);
      if (v === undefined) continue;
      const k = canon[i];
      if (k !== i) {
        if (flip[i]) v = !(v === true || v === 1);
        v = validValue(R[k], v);
        if (v === undefined) continue;
      }
      st.overrides[R[k].id] = v;
    }
  }
  if (typeof raw.text === 'string') st.text = raw.text.slice(0, STEP_TEXT_MAX);
  if (APPEAR_OK[raw.appear]) st.appear = raw.appear;
  st.textLock = raw.textLock === true;
  st.rampS = clampN(raw.rampS, RAMP_MIN, RAMP_MAX, RAMP_DEF);
  st.holdS = clampN(raw.holdS, HOLD_MIN, HOLD_MAX, HOLD_DEF);
  if (PIANO_OK[raw.piano]) st.piano = raw.piano;
  if (INTERACTION_OK[raw.interaction]) st.interaction = raw.interaction;
  st.seq = readSeqBlock(raw.seq);
  st.mix = readMixBlock(raw.mix);
  return st;
}

function readRaw(key) {
  try { return JSON.parse(readKey(key) || 'null'); } catch (e) { return null; }
}

const MODES = ['off', 'auto', 'keys'];
const TRIGGERS = ['keys', 'midi'];

function readJourney(raw) {
  const d = { ver: 2, steps: [], mode: 'off', trigger: 'keys', autoPlay: false, loop: false, name: '',
              sizeLock: false, sizeLockValue: null, sizeRestore: null, ringV: 2, partV: 2 };
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.steps)) {
      for (let i = 0; i < raw.steps.length && i < STEPS_MAX; i++) d.steps.push(readStep(raw.steps[i]));
    }
    // Steps saved before Ring speed's 1x became a fifth of the old pace
    // (js/sim.js RING_SPEED_SCALE) hold the old units; ringV 2 marks a
    // record already in the new ones (store.js oldRingSpeed).
    if (raw.ringV !== 2) for (const st of d.steps) {
      const v = st.overrides.ringSpeed;
      if (typeof v === 'number') st.overrides.ringSpeed = oldRingSpeed(v);
    }
    // and from before the particle Speed's unit halved (schema-particles.js
    // PART_SPEED_SCALE): doubled, the same speed on screen
    if (raw.partV !== 2) for (const st of d.steps) {
      const v = st.overrides.partSpeed;
      if (typeof v === 'number') st.overrides.partSpeed = Math.min(0.5, v * 2);
    }
    d.mode = MODES.includes(raw.mode) ? raw.mode : raw.autoPlay === true ? 'auto' : 'off';
    d.autoPlay = d.mode === 'auto';
    d.trigger = TRIGGERS.includes(raw.trigger) ? raw.trigger : 'keys';
    d.loop = raw.loop === true;
    d.name = typeof raw.name === 'string' ? raw.name.slice(0, NAME_MAX) : '';
    const lockValue = SIZE ? validValue(SIZE, raw.sizeLockValue) : undefined;
    if (raw.sizeLock === true && lockValue !== undefined && Array.isArray(raw.sizeRestore) && raw.sizeRestore.length === d.steps.length) {
      const restore = [];
      let valid = true;
      for (let i = 0; i < raw.sizeRestore.length; i++) {
        const entry = raw.sizeRestore[i], value = entry && SIZE ? validValue(SIZE, entry.value) : undefined;
        if (!entry || typeof entry !== 'object' || value === undefined) { valid = false; break; }
        restore.push({ own: entry.own === true, value });
      }
      if (valid) {
        // A diff's step that held no size of its own came in at the size
        // before it, the first at the size the lock found: what each is put
        // back to on unlocking, now that every step holds one.
        for (let i = 0; i < restore.length; i++) {
          if (!restore[i].own && i > 0) restore[i].value = restore[i - 1].value;
          restore[i].own = true;
        }
        d.sizeLock = true;
        d.sizeLockValue = lockValue;
        d.sizeRestore = restore;
        for (let i = 0; i < d.steps.length; i++) d.steps[i].overrides.textSize = lockValue;
      }
    }
  }
  fillSteps(d.steps);
  return d;
}

// Every step whole (see the header's ver 1): step 1 takes the scene as it
// stands for any control it does not hold, and each later step the one
// before it. Run on every read; for a ver 2 record it fills in only a
// control the app has gained since the record was written, or one a lock
// kept out of a step taken while it held (journeyToggleLock).
function fillSteps(steps) {
  let prev = null;
  for (let n = 0; n < steps.length; n++) {
    const o = steps[n].overrides;
    for (let i = 0; i < R.length; i++) {
      if (!held[i]) continue;
      const id = R[i].id;
      if (o[id] !== undefined) continue;
      let v;
      if (prev) v = prev[id];
      else { try { v = validValue(R[i], R[i].get(S)); } catch (e) { v = undefined; } }
      if (v !== undefined) o[id] = v;
    }
    prev = o;
  }
}

// A journey as this tab knows it, read once. A record still in the diff
// model is written back whole at once (see the header's ver 1), so it is
// composed only this once, from the scene as it stands now.
function journeyById(id) {
  let d = cache.get(id);
  if (!d) {
    const raw = readRaw(keyOf(id));
    d = readJourney(raw);
    cache.set(id, d);
    if (raw && typeof raw === 'object' && raw.ver !== 2) saveKey(keyOf(id), d);
  }
  return d;
}

const cleanTitle = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
const libIndex = id => { for (let i = 0; i < lib.items.length; i++) if (lib.items[i].id === id) return i; return -1; };

// The index, read once. Items with a malformed or repeated id are dropped;
// an index with none left (or none at all) starts the library afresh with
// the journey kept before it as Journey 1.
function ensureLib() {
  if (lib) return;
  lib = { ver: 1, cur: '', items: [] };
  const raw = readRaw(LIB_KEY);
  if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
    for (let i = 0; i < raw.items.length && lib.items.length < LIB_MAX; i++) {
      const it = raw.items[i];
      if (!it || typeof it.id !== 'string' || !/^j\d+$/.test(it.id) || libIndex(it.id) >= 0) continue;
      lib.items.push({ id: it.id, title: cleanTitle(it.title) || 'Journey' });
    }
    if (typeof raw.cur === 'string') lib.cur = raw.cur;
  }
  if (!lib.items.length) {
    lib.items.push({ id: 'j1', title: 'Journey 1' });
    lib.cur = 'j1';
    cache.set('j1', readJourney(readRaw(JOURNEY_KEY)));
    saveKey(keyOf('j1'), cache.get('j1'));
    saveKey(LIB_KEY, lib);
  }
  if (libIndex(lib.cur) < 0) lib.cur = lib.items[0].id;
}

function ensureLoaded() {
  if (data) return;
  ensureLib();
  data = journeyById(lib.cur);
  reconcile();
  if (!cued) { cued = true; cueLastStep(); }
}

// Resume: the step the walk last entered comes back with its fold open and
// nothing playing, so the window's play, Space or an arrow goes on from it
// (journeyTogglePlay, journeyStepBy), and the scene is already where that
// step left it, the settings having been saved. Restart leaves the walk at
// the top. A step that is gone, or a different journey open, cues nothing.
function cueLastStep() {
  if (S.journeyReload === 'restart') return;
  const p = readRaw(POS_KEY);
  if (!p || p.id !== lib.cur || !Number.isInteger(p.step) || !data.steps[p.step]) return;
  sel = p.step;
  version++;
}

// After a fresh read (another tab's write), the step being edited or played
// may be gone or be a new object; the indices are kept where they still
// point at a step.
function reconcile() {
  const n = data.steps.length;
  if (sel >= n) { sel = -1; armed = false; }
  if (play.stepIdx >= n) stopWalk(false);
}

// Every edit is kept in the open journey at once, and written to storage as
// it happens, except while the viewer holds a control (a drag in the drawer
// or a window, main.js journeyHoldWrites): a step is the whole scene, so its
// record is written once as the hand lets go, not every frame of the drag.
// What waits is kept by key, so a journey left in the meantime still lands
// in its own record.
let holdWrites = false;
const owed = new Map();
function persist() {
  version++;
  if (holdWrites) { owed.set(keyOf(lib.cur), data); return; }
  saveKey(keyOf(lib.cur), data);
}
export function journeyHoldWrites(held) {
  held = !!held;
  if (held === holdWrites) return;
  holdWrites = held;
  if (held || !owed.size) return;
  for (const [key, d] of owed) saveKey(key, d);
  owed.clear();
}
function persistLib() {
  version++;
  saveKey(LIB_KEY, lib);
}

// Another tab changed a journey or the library. A journey's in-memory copy
// is dropped and read afresh on next use, and the version moves so the
// window rebuilds its readouts; otherwise this tab would keep showing the
// old steps and its next edit would write them back over the new ones. The
// index is read again at once, and should the other tab have opened another
// journey, this one follows it, its walk and its selection let go. Returns
// true when the key was the journeys'.
export function syncJourneyFromStorage(key) {
  if (typeof key !== 'string') return false;
  if (key === LOCK_KEY) { locks = null; version++; return true; }
  if (key === LIB_KEY) {
    const was = lib ? lib.cur : '';
    lib = null; data = null;
    ensureLib();
    if (lib.cur !== was) { stopWalk(false); sel = -1; armed = false; diffPending = false; }
    version++;
    return true;
  }
  if (key.startsWith(JOURNEY_KEY + '.')) {
    const id = key.slice(JOURNEY_KEY.length + 1);
    cache.delete(id);
    if (lib && id === lib.cur && data) data = null;
    version++;
    return true;
  }
  return key === JOURNEY_KEY;
}

// ---------- locks ----------
//
// The operator can lock a control (a command-click on its drawer row,
// ui/widgets.js control): the set of locked ids lives under its own key,
// this machine's alone like the UI's own state, and never rides a preset, a
// journey or a broadcast. A lock is kept under the twin group's canonical
// door and covers every door of the group (lockAt), since a lock with a back
// door is no lock. Presets, the broadcast and the show remote never read it.
//
// A lock floats the control free of the journey: no step moves it (moves,
// and the door's level in throughDoor; a ramp under way lets it go as the
// lock is taken) and no step takes it in (captureAll, runDiff,
// recordLiveControl). The hand still moves it, so its locked value is simply
// its live one, and the record holds ids alone. The steps' stored values are
// never touched by locking or unlocking: unlocked, the next step entered
// moves the control again. The one way to write a locked control's value
// into the steps is the drawer's set all (journeySetAll), which unlocks it.
//
// Who a lock refuses is LOCK_REFUSES, asked through lockRefuses(id, who):
// today the journey alone. Whether a preset's recall (core/perform.js
// perfRecallPreset, presets.js) and a broadcast's followed moves
// (perform.js perfFollowGlide) should be refused too is still open; either
// is its entry turned to true here, with that path asking lockRefuses
// before it moves a control.
const LOCK_KEY = 'signal.journeyLocks.v1';
const LOCK_REFUSES = { journey: true, preset: false, broadcast: false };
let locks = null;
const lockAt = new Uint8Array(R.length);
export function lockRefuses(id, who) {
  if (!LOCK_REFUSES[who]) return false;
  ensureLocks();
  const i = idxOf.get(id);
  return i !== undefined && lockAt[i] === 1;
}
// The journey's own question, by place in R, asked in its loops.
function lockHolds(i) {
  if (!LOCK_REFUSES.journey) return false;
  ensureLocks();
  return lockAt[i] === 1;
}
function ensureLocks() {
  if (locks) return;
  locks = new Set();
  const raw = readRaw(LOCK_KEY);
  if (Array.isArray(raw)) {
    for (let n = 0; n < raw.length; n++) {
      const i = typeof raw[n] === 'string' ? idxOf.get(raw[n]) : undefined;
      if (i !== undefined && lockable(i)) locks.add(R[canon[i]].id);
    }
  }
  markLocks();
}
function markLocks() {
  lockAt.fill(0);
  for (const id of locks) for (const t of withTwins(id)) { const j = idxOf.get(t); if (j !== undefined) lockAt[j] = 1; }
}
// A control a step can hold (the mixer's own switches belong to the mix
// block, and this machine's controls and the operator's own are never in a
// step) is one a lock means anything for.
const lockable = i => !skip[i] && !inMix[i];
export function journeyLockable(id) {
  const i = idxOf.get(id);
  return i !== undefined && lockable(i);
}
// Called for every drawer row each frame: a lookup and a byte.
export function journeyLocked(id) {
  ensureLocks();
  const i = idxOf.get(id);
  return i !== undefined && lockAt[i] === 1;
}
// Locks or unlocks control id and its twins; returns whether it is now
// locked. A lock taken lets the control go from a ramp under way at once.
export function journeyToggleLock(id) {
  ensureLocks();
  const i = idxOf.get(id);
  if (i === undefined || !lockable(i)) return false;
  const key = R[canon[i]].id, on = !locks.has(key);
  if (on) locks.add(key); else locks.delete(key);
  markLocks();
  saveKey(LOCK_KEY, [...locks]);
  if (on) for (const t of withTwins(key)) releaseJourneyControl(t);
  version++;
  return on;
}

// Whether locked control id's live value differs from what any step of the
// open journey holds for it (judged as a step entering judges it, settled):
// the drawer's set all shows only then. Called each frame for a locked row,
// so the answer is kept per id against the journey's version and the value
// it was found for; only a new version or a moved value looks again.
const variesMemo = new Map();
export function journeyLockVaries(id) {
  if (!journeyLocked(id)) return false;
  ensureLoaded();
  const k = canon[idxOf.get(id)], c = R[k];
  if (!held[k]) return false;
  const cur = validValue(c, posOf(c));
  let m = variesMemo.get(c.id);
  if (m && m.ver === version && same(c, m.cur, cur)) return m.out;
  let out = false;
  if (cur !== undefined) {
    for (let n = 0; n < data.steps.length && !out; n++) {
      const v = data.steps[n].overrides[c.id];
      if (v !== undefined && !same(c, v, cur)) out = true;
    }
  }
  if (!m) { m = { ver: 0, cur: undefined, out: false }; variesMemo.set(c.id, m); }
  m.ver = version; m.cur = cur; m.out = out;
  return out;
}

// The drawer's set all: locked control id's live value (where it is
// headed) written into every step of the open journey under its canonical
// door, the journey written once, and the lock dropped, since a value set
// across the whole journey is one the journey should carry. Saved presets
// and other journeys are untouched.
export function journeySetAll(id) {
  ensureLoaded();
  const j = idxOf.get(id);
  if (j === undefined) return false;
  const k = canon[j], c = R[k];
  if (!held[k]) return false;
  const v = validValue(c, posOf(c));
  if (v === undefined) return false;
  for (let n = 0; n < data.steps.length; n++) data.steps[n].overrides[c.id] = v;
  if (c.id === 'textSize' && data.sizeLock) data.sizeLockValue = v;
  persist();
  if (journeyLocked(c.id)) journeyToggleLock(c.id);
  return true;
}

// ---------- applying a step ----------

// A step's own text: when it has any, the Text source turns to Custom and
// shows it, through the two controls, so the word pool rebuilds and it is
// saved like any setting the viewer makes. An empty text touches nothing,
// and the words carry on as the interface has them.
// A step's text as it shows: every whole word NAME said as the journey's
// name, once one is set (until then NAME shows as written, so a missing
// name is seen in rehearsal).
const NAME_RE = /\bNAME\b/g;
function withName(text) {
  const name = data && data.name;
  return name && text.indexOf('NAME') >= 0 ? text.replace(NAME_RE, () => name) : text;
}

function applyText(text) {
  if (!text || !MODE || !CUSTOM) return;
  text = withName(text);
  if (!manual.has(CUSTOM.id) && CUSTOM.get(S) !== text) CUSTOM.set(S, text);
  if (!manual.has(MODE.id) && MODE.get(S) !== 'custom') MODE.set(S, 'custom');
}

// Whether a step entering moves control i at all: one a step can hold, held
// under its own id (a twin's canonical; the others follow through the state
// they share), not taken by the viewer for this walk (manual), and not one
// of the mixer's switches when the step's mix block holds them.
function moves(i, mixOwned) {
  return !skip[i] && canon[i] === i && !manual.has(R[i].id) && !(mixOwned && inMix[i]) && !lockHolds(i);
}
// While the step's colour walk runs (its own Color walk, else the one running
// now), the colour is the walk's, moved every frame, and a step never lands
// one over it: entering the step it is already in would otherwise put back
// the colour it was taken at.
function walking(o) {
  const w = o.colorWalk;
  return typeof w === 'number' ? w > 0 : S.colorWalk > 0;
}
// The step taking a control a glide of the performer's is moving somewhere
// else: the glide stops where it stands (perform.js perfRelease), so the
// step's own write is not overwritten by it on the next frame.
function takeFromGlide(c) {
  if (perfDestination(c.id) !== undefined) perfRelease(c.id);
}

// Transition durations configure the change itself. Apply them before the
// incoming file or layer switches, and never tween them over the step's ramp.
function applyStepTiming(o, mixOwned) {
  for (let i = 0; i < R.length; i++) {
    const c = R[i], v = o[c.id];
    if (!c.journeyImmediate || v === undefined || !moves(i, mixOwned)) continue;
    takeFromGlide(c);
    if (!same(c, c.get(S), v)) c.set(S, v);
  }
}

// Every control the step holds that is not already where the step puts it,
// or headed there (settled), set through its own set() in the replay's
// order (clickMode first), inside one transition over `sec`. What is settled
// is left alone, so a voice already playing is not started a second time.
// Selecting a step to edit it, and a step whose ramp is a cut, land this way.
function applyStep(st, sec) {
  // An audio touch, before any of the step's own commands, so they land at
  // a fresh horizon however far Heart had rendered ahead (js/idle-ahead.js).
  idleTouch('a journey step');
  performanceControls.clear();
  const o = st.overrides, mixOwned = !!st.mix, walk = walking(o);
  applyStepTiming(o, mixOwned);
  throughDoor(o, mixOwned, sec, true);
  beginTransition(Math.max(MIN_GLIDE_S, sec));
  try {
    for (let i = 0; i < R.length; i++) {
      const c = R[i];
      const v = o[c.id];
      if (v === undefined || doorHeld[i] || !moves(i, mixOwned) || (walk && i === COLOR_I) || settled(c, v)) continue;
      takeFromGlide(c);
      if (!same(c, c.get(S), v)) c.set(S, v);
    }
    applyText(st.text);
    applySeqMixNow(st, sec);
  } finally {
    endGlide();
  }
}

// Every switch the step names that goes through the performer's door
// (perform.js perfLayer), before anything else of the step lands: a voice
// the step turns on or off (voice above), and any switch a fade is still
// taking off, from a window, the last step or a preset's ramp, which would
// otherwise read on until its fade landed and be turned off under the step.
// Through the door a voice coming on enters silent and rises over sec to the
// level the step names for it (to), else where it stood, and one going off
// falls through its level and switches off at the landing, its level put
// back. A fade already under way is taken over from wherever it has got to:
// back up when the step wants the switch on, down again over this step's
// ramp when it wants a voice off. A fade the step does not name is left to
// land on its own time. now (a cut, a step selected to edit) lands each at
// once, inside a glide of sec. The fade and its in-flight record are then
// the performer's, the one place every fade lives, so the Music window shows
// a step's fade as its own, a hand on the voice mid-fade keeps it on, as a
// hand on a window's fade does (perform.js takeLayerFade, landLayerFades),
// and the recorder reads where it is headed (perfDestination). What it took
// is marked in doorHeld for the step's own passes to leave alone: a twin
// would otherwise turn the shared state at once through the other door.
// Nothing is allocated unless a switch goes through.
// A switch the step wants off while a fade already takes it off goes through
// too when the step puts its level somewhere else than the fade will, so the
// level lands where the step says rather than being let go with the switch
// left on.
function throughDoor(o, mixOwned, sec, now) {
  doorHeld.fill(0);
  driving = true;
  try {
    for (let i = 0; i < R.length; i++) {
      const c = R[i], v = o[c.id];
      if (v === undefined || !moves(i, mixOwned)) continue;
      if ((c.kind !== 'toggle' && c.kind !== 'segment') || c.mixKey) continue;
      const is = !!c.get(S), fading = is && perfDestination(c.id) === false;
      const L = opAt[i], lid = L >= 0 && !manual.has(R[L].id) && !lockHolds(L) ? R[L].id : null;
      const lv = lid ? o[lid] : undefined;
      const relevel = fading && !v && typeof lv === 'number' && perfDestination(lid) !== lv;
      if (!(fading && (v || voice[i])) && !(voice[i] && lid && !!v !== is) && !relevel) continue;
      perfLayer(c.id, !!v, { now, sec, to: typeof lv === 'number' ? lv : undefined });
      doorHeld[i] = 1;
      if (lv !== undefined) doorHeld[L] = 1;
      const tws = twins.get(c.id);
      if (tws) for (let k = 0; k < tws.length; k++) { const j = idxOf.get(tws[k]); if (j !== undefined) doorHeld[j] = 1; }
    }
  } finally { driving = false; }
}

// ---------- the sequencer and the mix ----------
//
// Every step also carries the whole sequencer and the whole mix, in full, as
// it holds every control: st.seq is the eight lines and the active one in store.js's own
// shape (seqStateOf), st.mix the fixed channels' mutes and solos (mixStateOf)
// plus every atmosphere recording's level, peak, mute and solo. A new step
// takes them as they are; a step being edited takes them again whenever
// anything saves (runDiff), copied into its own objects in place. A step
// saved before these existed has neither, and leaves the sequencer and the
// mix alone until it is next edited, when it gains both. With a mix block,
// the mixer's own mute and solo switches (the fixed channels', which are
// CONTROLS a step could otherwise record) belong to the block, so they are
// neither recorded among its controls nor replayed from them.
//
// Everything is written straight into S (the lines' fields, the channel
// flags, the recordings' objects), then the engine is told once: applySeqs
// for the lines, applyMixGates for any mute or solo (which also re-syncs the
// recordings), syncAmbLayers for levels alone. A mute or solo's gate glides
// rather than flips (js/mixgate.js), over the step's ramp, or a cut's or an
// edit's glide. In worker mode those calls do nothing here and the audio link
// carries it all to the page from the diff it already takes every frame: the
// lines in their packed row, the channel switches and the recordings' rows as
// watched controls, the glide's length ahead of them.

const MIX_CTL = [];
for (let k = 0; k < CHANNELS.length; k++) {
  const name = 'mix' + CHANNELS[k][0].toUpperCase() + CHANNELS[k].slice(1);
  const mute = byId(name + 'Mute'), solo = byId(name + 'Solo');
  if (mute) MIX_CTL.push(mute);
  if (solo) MIX_CTL.push(solo);
}
const inMix = new Uint8Array(R.length);
for (let k = 0; k < MIX_CTL.length; k++) if (idxOf.has(MIX_CTL[k].id)) inMix[idxOf.get(MIX_CTL[k].id)] = 1;
// held[i]: control i is one a step holds, and takes as the scene is taken:
// one a step can hold at all, held under its own id (a twin's canonical),
// and not the mixer's switches, which the mix block holds.
const held = new Uint8Array(R.length);
for (let i = 0; i < R.length; i++) held[i] = !skip[i] && !inMix[i] && canon[i] === i ? 1 : 0;

// A line's numbers that travel over a ramp, and the grid each is kept on as
// it goes (the sequencer window's own rounding, so a ramped knob reads as a
// turned one would). The rest of a line lands as the ramp begins: its
// pattern and length, octave settings, delay time (a step count on
// SEQ_DLY_STEPS) and ping pong. Its wave crossfades (lineMorph in
// js/piano.js); its mute and solo turn at the midpoint.
const SQ_FIELDS = ['vol', 'pan', 'rev', 'spread', 'atk', 'atkVar', 'atkRate', 'dec', 'decVar', 'decRate',
                   'panMod', 'panRate', 'revTime', 'revVar', 'revRate', 'dlyFb', 'dlyFbVar', 'dlyFbRate',
                   'dlyMix'];
const SQ_GRID = [0.01, 0.01, 0.01, 0.01, 0.001, 0.01, 1, 0.005, 0.01, 1,
                 0.01, 1, 0.5, 0.01, 1, 0.01, 0.01, 1,
                 0.01];
const SQ_P = SQ_GRID.map(g => { let p = 1; for (let d = 0; d < 6 && Math.abs(Math.round(g * p) - g * p) > 1e-9; d++) p *= 10; return p; });
const SQ_SWITCH_NUMS = ['octaves', 'oct', 'dlyTime'];
const SQ_KEYS = ['wave', 'mute', 'solo', 'octMode', 'dlyPing'];

// A stored block, checked exactly as a saved session's lines are: laid over
// a fresh copy of the lines as they are now (so anything missing keeps a
// sensible value) through store.js's applySeqState, clamps and all.
function readSeqBlock(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.seqs) || !Array.isArray(S.seqs)) return null;
  const blk = seqStateOf(S);
  applySeqState(blk, raw);
  return blk;
}
// The channels' flags as booleans (anything else is off), and the recordings
// through ambience.js's own normaliser, the whole library in its order.
function readMixBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw.chanMute && typeof raw.chanMute === 'object' ? raw.chanMute : null;
  const o = raw.chanSolo && typeof raw.chanSolo === 'object' ? raw.chanSolo : null;
  const blk = { chanMute: {}, chanSolo: {}, layers: normalizeAmbLayers(Array.isArray(raw.layers) ? raw.layers : []) };
  for (let k = 0; k < CHANNELS.length; k++) {
    const ch = CHANNELS[k];
    blk.chanMute[ch] = !!(m && m[ch] === true);
    blk.chanSolo[ch] = !!(o && o[ch] === true);
  }
  return blk;
}

function newMixBlock() {
  const blk = mixStateOf(S);
  const L = Array.isArray(S.ambLayers) ? S.ambLayers : [];
  blk.layers = new Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    blk.layers[i] = { source: l.source, level: l.level, peak: l.peak, muted: !!l.muted, solo: !!l.solo };
  }
  return blk;
}

// The step takes the sequencer and the mix as they are now, into its own
// objects in place where their shape still fits. Returns whether anything
// changed, so an unchanged snapshot writes nothing.
function snapSeq(st) {
  const L = S.seqs;
  if (!Array.isArray(L)) return false;
  const blk = st.seq;
  if (!blk || !Array.isArray(blk.seqs) || blk.seqs.length !== L.length) { st.seq = seqStateOf(S); return true; }
  let moved = false;
  const slot = S.seqSlot | 0;
  if (blk.seqSlot !== slot) { blk.seqSlot = slot; moved = true; }
  for (let i = 0; i < L.length; i++) {
    const q = L[i], p = blk.seqs[i];
    if (p.len !== q.len) { p.len = q.len; moved = true; }
    for (let k = 0; k < q.steps.length; k++) if (p.steps[k] !== q.steps[k]) { p.steps[k] = q.steps[k]; moved = true; }
    for (let k = 0; k < SQ_KEYS.length; k++) {
      const f = SQ_KEYS[k];
      if (p[f] !== q[f]) { p[f] = q[f]; moved = true; }
    }
    for (const f in SEQ_NUM_RANGE) if (p[f] !== q[f]) { p[f] = q[f]; moved = true; }
  }
  return moved;
}
function snapMix(st) {
  const L = Array.isArray(S.ambLayers) ? S.ambLayers : [];
  const blk = st.mix;
  if (!blk || !Array.isArray(blk.layers) || blk.layers.length !== L.length) { st.mix = newMixBlock(); return true; }
  let moved = false;
  for (let k = 0; k < CHANNELS.length; k++) {
    const ch = CHANNELS[k], mu = !!S.chanMute[ch], so = !!S.chanSolo[ch];
    if (blk.chanMute[ch] !== mu) { blk.chanMute[ch] = mu; moved = true; }
    if (blk.chanSolo[ch] !== so) { blk.chanSolo[ch] = so; moved = true; }
  }
  for (let i = 0; i < L.length; i++) {
    const l = L[i], b = blk.layers[i];
    if (b.source !== l.source || b.level !== l.level || b.peak !== l.peak || b.muted !== !!l.muted || b.solo !== !!l.solo) {
      b.source = l.source; b.level = l.level; b.peak = l.peak; b.muted = !!l.muted; b.solo = !!l.solo;
      moved = true;
    }
  }
  return moved;
}
// With the block holding the mixer's switches, any the step recorded as
// overrides before it had one are taken out.
function dropMixOverrides(st) {
  let moved = false;
  for (let k = 0; k < MIX_CTL.length; k++) {
    const id = MIX_CTL[k].id;
    if (st.overrides[id] === undefined) continue;
    delete st.overrides[id];
    moved = true;
  }
  return moved;
}

// The recording in a block that matches the one at index i now: the same
// index when the library has not changed (it always has the same order),
// else found by source.
function blockLayer(blk, i, source) {
  const b = blk.layers[i];
  if (b && b.source === source) return b;
  for (let k = 0; k < blk.layers.length; k++) if (blk.layers[k].source === source) return blk.layers[k];
  return null;
}

// What of a line lands as a ramp begins (see SQ_FIELDS): returns whether any
// of it moved. The pattern is copied into the line's own steps array.
function writeLineSwitches(q, p) {
  let moved = false;
  if (q.len !== p.len) { q.len = p.len; moved = true; }
  const qs = q.steps, ps = p.steps;
  if (Array.isArray(qs) && Array.isArray(ps)) {
    for (let k = 0; k < ps.length && k < qs.length; k++) if (qs[k] !== ps[k]) { qs[k] = ps[k]; moved = true; }
  }
  if (q.octMode !== p.octMode) { q.octMode = p.octMode; moved = true; }
  if (q.dlyPing !== p.dlyPing) { q.dlyPing = p.dlyPing; moved = true; }
  for (let k = 0; k < SQ_SWITCH_NUMS.length; k++) {
    const f = SQ_SWITCH_NUMS[k];
    if (q[f] !== p[f]) { q[f] = p[f]; moved = true; }
  }
  return moved;
}

// The whole block at once: a cut, or a step selected for editing. Run inside
// the caller's transition, so what the engine glides it glides over that, and
// the mutes' and solos' gates over the same sec.
function applySeqMixNow(st, sec) {
  let seqMoved = false, gates = false;
  const blk = st.seq, L = S.seqs;
  if (blk && Array.isArray(L)) {
    if ((S.seqSlot | 0) !== blk.seqSlot) { S.seqSlot = blk.seqSlot; seqMoved = true; }
    for (let i = 0; i < L.length && i < blk.seqs.length; i++) {
      const q = L[i], p = blk.seqs[i];
      if (!q || !p) continue;
      if (writeLineSwitches(q, p)) seqMoved = true;
      if (q.wave !== p.wave) { q.wave = p.wave; seqMoved = true; }
      if (q.morphWave) { q.morphWave = 0; seqMoved = true; }
      if (q.mute !== p.mute) { q.mute = p.mute; seqMoved = true; }
      if (q.solo !== p.solo) { q.solo = p.solo; seqMoved = true; }
      for (let k = 0; k < SQ_FIELDS.length; k++) {
        const f = SQ_FIELDS[k];
        if (q[f] !== p[f]) { q[f] = p[f]; seqMoved = true; }
      }
    }
  }
  const mb = st.mix, AL = S.ambLayers;
  if (mb) {
    for (let k = 0; k < CHANNELS.length; k++) {
      const ch = CHANNELS[k];
      if (!!S.chanMute[ch] !== mb.chanMute[ch]) { S.chanMute[ch] = mb.chanMute[ch]; gates = true; }
      if (!!S.chanSolo[ch] !== mb.chanSolo[ch]) { S.chanSolo[ch] = mb.chanSolo[ch]; gates = true; }
    }
    if (Array.isArray(AL)) {
      for (let i = 0; i < AL.length; i++) {
        const l = AL[i], b = blockLayer(mb, i, l.source);
        if (!b) continue;
        if (l.level !== b.level || l.peak !== b.peak) { l.level = b.level; l.peak = b.peak; gates = true; }
        if (!!l.muted !== b.muted) { l.muted = b.muted; gates = true; }
        if (!!l.solo !== b.solo) { l.solo = b.solo; gates = true; }
      }
    }
  }
  if (seqMoved) applySeqs();
  if (gates) applyMixGates(Math.max(MIN_GLIDE_S, sec));
  if (seqMoved || gates) save();
}

// ---- the block's ramp ----
// The line numbers on their way, as slots in typed arrays sized once (a line
// and a field index each, from, to, and the value last written, which is how
// a hand on the same knob is noticed and let win); the recordings' levels the
// same way, by index and source; each line's waveform crossfade (on, and the
// wave it is going to, so a wave changed by hand ends it); and every line's
// mute and solo, from and to, turned together at the ramp's midpoint, each
// one only if it is still where the ramp found it. The mixer's mutes and
// solos are not among them: they turn as the ramp begins and their gates
// glide over it (startSeqMix).
const SQ_MAX = SEQ_COUNT * SQ_FIELDS.length;
const sqLine = new Int8Array(SQ_MAX), sqField = new Int8Array(SQ_MAX);
const sqFrom = new Float64Array(SQ_MAX), sqTo = new Float64Array(SQ_MAX), sqSent = new Float64Array(SQ_MAX);
let sqN = 0;
const AMB_MAX = 64;
const lyIdx = new Int16Array(AMB_MAX), lySrc = new Array(AMB_MAX).fill('');
const lyFrom = new Float64Array(AMB_MAX), lyTo = new Float64Array(AMB_MAX), lySent = new Float64Array(AMB_MAX);
let lyN = 0;
const mphOn = new Uint8Array(SEQ_COUNT), mphWave = new Array(SEQ_COUNT).fill('');
let mphAny = false;
const lnMuteF = new Uint8Array(SEQ_COUNT), lnMuteT = new Uint8Array(SEQ_COUNT);
const lnSoloF = new Uint8Array(SEQ_COUNT), lnSoloT = new Uint8Array(SEQ_COUNT);
let gatePend = false;

// The block's side of a ramp's start, inside its transition: what lands now
// lands, each crossfading wave starts its second tone, and the rest is set
// travelling. The mixer's mutes and solos land now too, the switches showing
// where the step is going, and their gates glide over the whole ramp
// (js/mixgate.js applyMixGates), the faders untouched: no midpoint jump in
// the sound. Returns whether anything is left to ramp.
function startSeqMix(st) {
  sqN = 0; lyN = 0; mphAny = false; gatePend = false;
  let seqMoved = false;
  const blk = st.seq, L = S.seqs;
  if (blk && Array.isArray(L)) {
    if ((S.seqSlot | 0) !== blk.seqSlot) { S.seqSlot = blk.seqSlot; seqMoved = true; }
    for (let i = 0; i < SEQ_COUNT && i < L.length && i < blk.seqs.length; i++) {
      const q = L[i], p = blk.seqs[i];
      mphOn[i] = 0;
      lnMuteF[i] = lnMuteT[i] = q && q.mute ? 1 : 0;
      lnSoloF[i] = lnSoloT[i] = q && q.solo ? 1 : 0;
      if (!q || !p) continue;
      if (writeLineSwitches(q, p)) seqMoved = true;
      if (q.wave !== p.wave) {
        const w = SEQ_WAVES.indexOf(q.wave);
        q.morphWave = w >= 0 ? w + 1 : 0; q.morphMix = 0;
        q.wave = p.wave;
        if (q.morphWave) { mphOn[i] = 1; mphWave[i] = p.wave; mphAny = true; }
        seqMoved = true;
      }
      lnMuteT[i] = p.mute ? 1 : 0; lnSoloT[i] = p.solo ? 1 : 0;
      if (lnMuteT[i] !== lnMuteF[i] || lnSoloT[i] !== lnSoloF[i]) gatePend = true;
      for (let k = 0; k < SQ_FIELDS.length; k++) {
        const f = SQ_FIELDS[k], from = q[f], to = p[f];
        if (from === to) continue;
        if (typeof from !== 'number' || !Number.isFinite(from) || typeof to !== 'number') { q[f] = to; seqMoved = true; continue; }
        const n = sqN++;
        sqLine[n] = i; sqField[n] = k; sqFrom[n] = from; sqTo[n] = to; sqSent[n] = from;
      }
    }
  }
  const mb = st.mix, AL = S.ambLayers;
  let gates = false;
  if (mb) {
    for (let k = 0; k < CHANNELS.length; k++) {
      const ch = CHANNELS[k];
      if (!!S.chanMute[ch] !== mb.chanMute[ch]) { S.chanMute[ch] = mb.chanMute[ch]; gates = true; }
      if (!!S.chanSolo[ch] !== mb.chanSolo[ch]) { S.chanSolo[ch] = mb.chanSolo[ch]; gates = true; }
    }
    if (Array.isArray(AL)) {
      for (let i = 0; i < AL.length && i < AMB_MAX; i++) {
        const l = AL[i], b = blockLayer(mb, i, l.source);
        if (!b) continue;
        if (!!l.muted !== b.muted) { l.muted = b.muted; gates = true; }
        if (!!l.solo !== b.solo) { l.solo = b.solo; gates = true; }
        l.peak = b.peak;
        if (l.level !== b.level) {
          const n = lyN++;
          lyIdx[n] = i; lySrc[n] = l.source; lyFrom[n] = l.level; lyTo[n] = b.level; lySent[n] = l.level;
        }
      }
    }
  }
  if (seqMoved) applySeqs();
  if (gates) applyMixGates(st.rampS);
  if (seqMoved || gates) save();
  return sqN > 0 || lyN > 0 || mphAny || gatePend;
}

// The midpoint: every line's mute and solo the step turns, where it is still
// as the ramp found it. Returns whether any moved.
function turnGates() {
  gatePend = false;
  let out = false;
  const L = S.seqs;
  if (Array.isArray(L)) {
    for (let i = 0; i < SEQ_COUNT && i < L.length; i++) {
      const q = L[i];
      if (!q) continue;
      if (lnMuteT[i] !== lnMuteF[i] && (q.mute ? 1 : 0) === lnMuteF[i]) { q.mute = lnMuteT[i] === 1; out = true; }
      if (lnSoloT[i] !== lnSoloF[i] && (q.solo ? 1 : 0) === lnSoloF[i]) { q.solo = lnSoloT[i] === 1; out = true; }
    }
  }
  return out;
}

// One frame of the block's ramp, on the same eased curve as the drawer's
// sliders. The engine hears it once for the frame, whatever moved.
function stepSeqMix(u, e) {
  let seqMoved = false, layMoved = false;
  const L = S.seqs;
  for (let k = 0; k < sqN; k++) {
    const line = sqLine[k];
    if (line < 0) continue;
    const q = L && L[line], fi = sqField[k], f = SQ_FIELDS[fi];
    if (!q || q[f] !== sqSent[k]) { sqLine[k] = -1; continue; }
    const from = sqFrom[k], to = sqTo[k];
    let v = to;
    if (u < 1) {
      const g = SQ_GRID[fi], p = SQ_P[fi];
      v = Math.round(Math.round((from + (to - from) * e) / g) * g * p) / p;
      if (from < to) { if (v < from) v = from; else if (v > to) v = to; }
      else if (v < to) v = to; else if (v > from) v = from;
    }
    if (v !== sqSent[k]) { q[f] = v; sqSent[k] = v; seqMoved = true; }
  }
  if (mphAny) {
    let any = false;
    for (let i = 0; i < SEQ_COUNT; i++) {
      if (!mphOn[i]) continue;
      const q = L && L[i];
      // a wave changed by hand (or a line gone) ends its crossfade
      if (!q || q.wave !== mphWave[i] || !q.morphWave) {
        mphOn[i] = 0;
        if (q && q.morphWave) { q.morphWave = 0; seqMoved = true; }
        continue;
      }
      const m = u >= 1 ? 1 : e;
      if (q.morphMix !== m) { q.morphMix = m; seqMoved = true; }
      if (u >= 1) { q.morphWave = 0; mphOn[i] = 0; } else any = true;
    }
    mphAny = any;
  }
  const AL = S.ambLayers;
  for (let k = 0; k < lyN; k++) {
    const i = lyIdx[k];
    if (i < 0) continue;
    const l = AL && AL[i];
    if (!l || l.source !== lySrc[k] || l.level !== lySent[k]) { lyIdx[k] = -1; continue; }
    const from = lyFrom[k], to = lyTo[k];
    let v = to;
    if (u < 1) {
      v = Math.round((from + (to - from) * e) * 100) / 100;
      if (from < to) { if (v < from) v = from; else if (v > to) v = to; }
      else if (v < to) v = to; else if (v > from) v = from;
    }
    if (v !== lySent[k]) { l.level = v; lySent[k] = v; layMoved = true; }
  }
  if (gatePend && u >= 0.5 && turnGates()) seqMoved = true;
  if (seqMoved) applySeqs();
  if (layMoved) syncAmbLayers();
  if (seqMoved || layMoved) save();
}

// A ramp let go before it landed: a waveform crossfade still under way ends
// on the line's new wave, so the engine is never left sounding two.
function endSeqMix() {
  if (mphAny) {
    let moved = false;
    const L = S.seqs;
    for (let i = 0; i < SEQ_COUNT; i++) {
      if (!mphOn[i]) continue;
      mphOn[i] = 0;
      const q = L && L[i];
      if (q && q.morphWave) { q.morphWave = 0; moved = true; }
    }
    if (moved) applySeqs();
  }
  sqN = 0; lyN = 0; mphAny = false; gatePend = false;
}

// ---------- the ramp ----------
//
// The sliders a playing step moves, as parallel typed arrays sized once for
// every control a step can hold, so entering a step fills them in place and a
// frame of the ramp allocates nothing. Per slot: the control's index in R (-1
// once the viewer has taken it), where it started and where it is going, the
// value the ramp last asked of set() and the position get() read back after
// (a position can be coarser than what was asked), the control's step and
// the power of ten that keeps a fractional step's dust out of state (as
// widgets.js snaps a drag), and whether it is the strobe frequency, whose path
// skips the photosensitive band exactly as a preset's glide does (strobe.js).
// The colour rides alongside as three channels, from, to and last set.
//
// The drawer reads which controls, sections and sub-drawers are moving from
// three sets filled as the ramp begins, and one number for how brightly.
const tw = { active: false, t0: 0, durMs: 0, n: 0, colorOn: false, glow: 0, seqMix: false };
const twIdx = new Int32Array(R.length);
const twFrom = new Float64Array(R.length), twTo = new Float64Array(R.length);
const twSent = new Float64Array(R.length), twLast = new Float64Array(R.length);
const twStep = new Float64Array(R.length), twP = new Float64Array(R.length);
const twBand = new Uint8Array(R.length);
// For each place in R, the slot it was last given (posOf reads a ramping
// control's target through it; a slot counts only while it still names it).
const twAt = new Int32Array(R.length).fill(-1);
const cFrom = new Int16Array(3), cTo = new Int16Array(3), cLast = new Int16Array(3);
let cHex = '';
const rampIds = new Set(), rampSections = new Set(), rampSubs = new Set();
// Two hex digits for each channel value, made once, so a colour on its way
// is one string a frame at most.
const HEX2 = new Array(256);
for (let i = 0; i < 256; i++) HEX2[i] = (i < 16 ? '0' : '') + i.toString(16);

// ---------- the broadcast's view of the ramp ----------
// A broadcaster's followers glide a ramp themselves (core/broadcast.js): the
// state message sent as it begins (glideStart) names every control on its
// way, where to and how long is left (journeyEachGlide), and every message
// after it says so again while the ramp lasts. The ramp's own per-frame
// writes are marked (glideWriting, read by the broadcast's save listener),
// so they are held rather than streamed, and the ramp ending, however it
// ends (endTween: landed, replaced by the next step, the walk stopped), asks
// for one more send (glideLand), which trues every screen up. Only the
// controls' writes are marked: the sequencer's lines and the mix are not
// controls a message can name, so a ramp moving them saves unmarked and
// streams them as it always did. The hooks are handed in by broadcast.js,
// as main.js hands in setRunning, since the broadcast depends on this module
// and not the other way round; on a follower, in worker mode or with no
// broadcast they are never set, and the flag is one nobody reads.
let glideWriting = false;
let glideStart = null, glideLand = null;
export function setJourneyGlideHooks(start, land) { glideStart = start; glideLand = land; }
export const journeyGlideWriting = () => glideWriting;
// fn(control, target, secondsLeft) for each control the playing ramp still
// moves: a slider's position, the colour's hex. A paused walk's ramp is
// standing still, so it names nothing.
export function journeyEachGlide(fn) {
  if (!play.playing || !tw.active) return;
  const left = (tw.t0 + tw.durMs - nowT) / 1000;
  const rem = left > 0 ? left : 0;
  for (let k = 0; k < tw.n; k++) if (twIdx[k] >= 0) fn(R[twIdx[k]], twTo[k], rem);
  if (tw.colorOn && COLOR) fn(COLOR, cHex, rem);
}

function endTween() {
  const was = tw.active;
  if (tw.seqMix) endSeqMix();
  tw.active = false; tw.n = 0; tw.colorOn = false; tw.glow = 0; tw.seqMix = false;
  rampIds.clear(); rampSections.clear(); rampSubs.clear();
  if (was && glideLand) glideLand();
}

// A control joins the drawer's view of the ramp: its own row, its section's
// header, and every sub-drawer strip it sits under (a variance row hangs from
// its owner), so a strip shut over it still shows something is moving.
function noteRamping(c) {
  rampIds.add(c.id);
  if (c.section) rampSections.add(c.section);
  let p = c.parent || c.varianceOf;
  for (let d = 0; p && d < 8; d++) {
    const pc = byId(p);
    if (!pc) break;
    if (pc.uiOnly) rampSubs.add(pc.id);
    p = pc.parent || pc.varianceOf;
  }
}

function addSlider(i, c, to) {
  const from = c.get(S);
  if (from === to) return;
  // a position that is not a number cannot travel; it lands
  if (typeof from !== 'number' || !Number.isFinite(from)) { c.set(S, to); return; }
  const k = tw.n++;
  twAt[i] = k;
  twIdx[k] = i; twFrom[k] = from; twTo[k] = to; twSent[k] = from; twLast[k] = from;
  const step = c.step > 0 ? c.step : 0;
  let p = 1;
  if (step) for (let d = 0; d < 6 && Math.abs(Math.round(step * p) - step * p) > 1e-9; d++) p *= 10;
  twStep[k] = step; twP[k] = p;
  twBand[k] = c.id === 'freq' ? 1 : 0;
  noteRamping(c);
}

function addColor(c, hex) {
  const rgb = S.rgb;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  if (rgb[0] === r && rgb[1] === g && rgb[2] === b) return;
  // While the colour walk runs the colour is the walk's, moved every frame;
  // the step's colour lands at once, as it always did, and the walk carries
  // on from it.
  if (S.colorWalk > 0) { c.set(S, hex); return; }
  cFrom[0] = rgb[0]; cFrom[1] = rgb[1]; cFrom[2] = rgb[2];
  cTo[0] = r; cTo[1] = g; cTo[2] = b;
  cLast[0] = rgb[0]; cLast[1] = rgb[1]; cLast[2] = rgb[2];
  cHex = hex;
  tw.colorOn = true;
  noteRamping(c);
}

// A playing step with a ramp: its switches (and its text, when that shows
// from the start) inside one short transition, then the sliders and the
// colour set travelling from wherever they are now, read only after the
// switches, since clickMode decides which voice the pip controls address.
// The switches' transition spans the whole ramp (presets.js beginTransition's
// span), so what crossfades rather than glides, the Edge layer's effect, fades
// over the ramp while the audio's levels still land in the short glide. A
// voice the step switches, and any switch a fade is still taking off, go
// through the performer's door first (throughDoor), which rides each over the
// step's ramp through its level; the passes below leave those to it.
// Only what is not already settled where the step puts it moves (applyStep).
function startRamp(st, withText) {
  const o = st.overrides, mixOwned = !!st.mix;
  applyStepTiming(o, mixOwned);
  throughDoor(o, mixOwned, st.rampS, false);
  beginTransition(SWITCH_GLIDE_S, st.rampS);
  try {
    for (let i = 0; i < R.length; i++) {
      const c = R[i], v = o[c.id];
      if (v === undefined || c.kind === 'slider' || c.kind === 'color' || doorHeld[i] || !moves(i, mixOwned) || settled(c, v)) continue;
      takeFromGlide(c);
      if (!same(c, c.get(S), v)) c.set(S, v);
    }
    if (withText) applyText(st.text);
    tw.seqMix = startSeqMix(st);
  } finally {
    endGlide();
  }
  const walk = walking(o);
  for (let i = 0; i < R.length; i++) {
    const c = R[i], v = o[c.id];
    if (v === undefined || c.journeyImmediate || (c.kind !== 'slider' && c.kind !== 'color') || doorHeld[i] || !moves(i, mixOwned) || settled(c, v)) continue;
    if (c.kind === 'color' && walk) continue;
    takeFromGlide(c);
    if (c.kind === 'slider') addSlider(i, c, v);
    else addColor(c, v);
  }
  if (tw.n > 0 || tw.colorOn || tw.seqMix) {
    tw.active = true; tw.t0 = nowT; tw.durMs = st.rampS * 1000; tw.glow = 1;
    // the broadcast's glide-start message (see the broadcast's view above)
    if (glideStart) glideStart();
  }
}

// One frame of the ramp: each slider eased (smoothstep) toward its target,
// snapped to its step, and set only when that lands somewhere new. A control
// whose position is no longer what the ramp left it at has been moved by
// someone else, and is dropped on the spot and left where they put it.
function stepTween(t) {
  const x = (t - tw.t0) / tw.durMs;
  const u = x >= 1 ? 1 : x > 0 ? x : 0;
  const e = u * u * (3 - 2 * u);
  for (let k = 0; k < tw.n; k++) {
    const i = twIdx[k];
    if (i < 0) continue;
    const c = R[i];
    if (c.get(S) !== twLast[k]) { twIdx[k] = -1; rampIds.delete(c.id); continue; }
    const from = twFrom[k], to = twTo[k];
    let v = to;
    if (u < 1) {
      v = twBand[k] ? glideSkippingRiskBand(from, to, e) : from + (to - from) * e;
      const step = twStep[k];
      if (step) { const p = twP[k]; v = Math.round(Math.round(v / step) * step * p) / p; }
      // a snap never carries it past either end
      if (from < to) { if (v < from) v = from; else if (v > to) v = to; }
      else if (v < to) v = to; else if (v > from) v = from;
    }
    if (v !== twSent[k]) {
      twSent[k] = v;
      glideWriting = true;
      try { c.set(S, v); } finally { glideWriting = false; }
      twLast[k] = c.get(S);
    }
  }
  if (tw.colorOn) stepColor(u, e);
  if (tw.seqMix) stepSeqMix(u, e);
  if (u >= 1) { endTween(); return; }
  const g = (1 - u) * GLOW_TAIL;
  tw.glow = g < 1 ? g : 1;
}

function stepColor(u, e) {
  const rgb = S.rgb;
  if (rgb[0] !== cLast[0] || rgb[1] !== cLast[1] || rgb[2] !== cLast[2]) {
    tw.colorOn = false;
    rampIds.delete(COLOR.id);
    return;
  }
  let r = cTo[0], g = cTo[1], b = cTo[2];
  if (u < 1) {
    r = Math.round(cFrom[0] + (cTo[0] - cFrom[0]) * e);
    g = Math.round(cFrom[1] + (cTo[1] - cFrom[1]) * e);
    b = Math.round(cFrom[2] + (cTo[2] - cFrom[2]) * e);
  }
  if (r === cLast[0] && g === cLast[1] && b === cLast[2]) return;
  glideWriting = true;
  try { COLOR.set(S, u < 1 ? '#' + HEX2[r] + HEX2[g] + HEX2[b] : cHex); } finally { glideWriting = false; }
  const now = S.rgb;
  cLast[0] = now[0]; cLast[1] = now[1]; cLast[2] = now[2];
}

// ---------- authoring ----------

// Record authoring changes after the setter that called save() returns. This
// microtask is the transaction boundary: it coalesces all writes from one UI
// action, but does not depend on another animation frame arriving. The old
// frame throttle could leave a step at "0 settings" when the scene stopped
// scheduling frames immediately after a click.
let diffQueued = false;
function queueDiff() {
  if (diffQueued) return;
  diffQueued = true;
  queueMicrotask(() => {
    if (diffPending) runDiff();
    diffQueued = false;
    // A normalising set() inside runDiff can save once more.
    if (diffPending) queueDiff();
  });
}
onSave(() => {
  if (performanceWriting) return;
  if (!armed || sel < 0 || !winOpen) {
    return;
  }
  if (!diffPending) journeyDiag('save observed; queueing diff');
  diffPending = true;
  queueDiff();
});

// Writes each control's destination into the step (posOf: where it is
// headed, else where it is), so the step being edited is always the scene on
// screen. What the viewer asked for is where a control is headed: a switch
// fading out from a window reads on until its fade lands, and a glide reads
// every value on its way (perform.js perfDestination). The colour, while the
// colour walk runs, is the walk's (core/strobe.js moves S.rgb every frame),
// so it is left as the step holds it then. Only what changed is written,
// and named in the diagnostic.
function runDiff() {
  diffPending = false;
  if (!armed) { journeyDiag('DIFF REJECTED', { reason: 'not armed' }); return; }
  ensureLoaded();
  const st = data.steps[sel];
  if (!st) { journeyDiag('DIFF REJECTED', { reason: 'selected step missing' }); return; }
  const o = st.overrides;
  let moved = false, changed = JOURNEY_DIAG ? [] : null;
  for (let i = 0; i < R.length; i++) {
    if (!held[i] || lockHolds(i) || performanceControls.has(i) || (i === COLOR_I && S.colorWalk > 0)) continue;
    const c = R[i], dest = destOf(c), raw = dest !== undefined ? dest : c.get(S);
    const v = validValue(c, raw);
    if (v === undefined) continue;
    // While authoring, the drawer follows the Journey's half-second grid as
    // soon as its finer fade control is released; never a control still on
    // its way, whose glide this write would stop.
    if (v !== raw && dest === undefined && HALF_SECOND_FADE.has(c.id)) c.set(S, v);
    if (same(c, o[c.id], v)) continue;
    if (c.id === 'textSize' && data.sizeLock) {
      data.sizeLockValue = v;
      for (let j = 0; j < data.steps.length; j++) data.steps[j].overrides.textSize = v;
    } else o[c.id] = v;
    if (changed) changed.push(c.id + '=' + String(v));
    moved = true;
  }
  // the whole sequencer and mix, as they are now (the mixer's own switches
  // among them, which is why they are passed over above)
  if (snapSeq(st)) moved = true;
  if (snapMix(st)) moved = true;
  if (dropMixOverrides(st)) moved = true;
  if (moved) {
    persist();
    journeyDiag('RECORDED STEP ' + (sel + 1), { changed });
  } else journeyDiag('diff found no changed settings');
}

function flushDiff() { if (diffPending) runDiff(); }

// Lets the step go: its fold shuts, and anything the drawer changed while it
// was being edited is recorded first.
function deselect() {
  if (sel < 0) return;
  flushDiff();
  sel = -1;
  armed = false;
  diffPending = false;
  version++;
}

// A walk starting: the step being edited stops recording (what the drawer
// changed is recorded first), and its fold stays open.
function disarm() {
  if (!armed) return;
  flushDiff();
  armed = false;
  diffPending = false;
  version++;
}

// The window tells the journey whether it is showing, every frame it is
// built. Shutting it ends the authoring: whatever the drawer changed is
// recorded, and the step is let go, so changes made with the window away
// can never land in a step nobody is looking at. The walk carries on.
export function journeySetWindowOpen(open) {
  if (winOpen && !open) deselect();
  winOpen = !!open;
  // Self-heal an idle open fold left disarmed by any transport path. An open
  // selected step is an editor whenever no Journey step is running.
  if (winOpen && sel >= 0 && play.stepIdx < 0 && !armed) {
    armed = true;
    diffPending = false;
    version++;
  }
}

// A click on step i's row (a second click on the selected one lets it go).
// With the walk playing it only opens the step's fold: the walk, its ramp and
// the scene are untouched, and nothing is recorded. Otherwise the step is
// selected for editing: a paused or finished walk is let go, and the step
// glides in over EDIT_GLIDE_S so the drawer shows what it holds.
export function journeySelect(i) {
  ensureLoaded();
  journeyDiag('row clicked', { requestedStep: i, sameStep: i === sel });
  if (i === sel && armed) { deselect(); journeyDiag('step deselected'); return; }
  if (!data.steps[i]) return;
  flushDiff();
  sel = i;
  diffPending = false;
  version++;
  // During a walk, a row is direct navigation: keep the transport running
  // and enter that step now. Live control changes are recorded into the
  // playing step by journeyManualOverride(), so it stays editable in place
  // without using the stopped-walk authoring arm.
  if (play.playing) {
    armed = false;
    enterStep(i);
    journeyDiag('JUMPED TO STEP ' + (i + 1), { particlesAfterApply: !!S.layers.particles });
    return;
  }
  stopWalk(false);
  armed = true;
  applyStep(data.steps[i], EDIT_GLIDE_S);
  cancelWordSequenceOnce();
  journeyDiag('EDITING STEP ' + (i + 1), {
    lParticles: data.steps[i].overrides.lParticles,
    particlesOn: data.steps[i].overrides.particlesOn,
    text: data.steps[i].text
  });
}
export function journeyDeselect() { deselect(); }

// The drawer's accessors, called every frame, so each is a read.
export const journeyEditing = () => armed && sel >= 0 && winOpen;

// Journey mode, for the drawer's preset Ramp time: the window open with the
// mode on, or a walk playing. While it is, a preset recalled from the drawer
// glides over the journey's own ramp rather than the drawer's: the step
// being edited, else the step the walk is on, else the step whose fold is
// open. With no step in play there is no journey ramp, and the recall cuts.
export const journeyModeOn = () => winOpen || play.playing;
export function journeyRampS() {
  if (!data) return 0;
  const i = armed ? sel : play.stepIdx >= 0 ? play.stepIdx : sel;
  const st = i >= 0 ? data.steps[i] : null;
  return st ? st.rampS : 0;
}

// ---------- the list ----------

// The scene as it stands, into step st: every control a step holds, at
// where it is headed (posOf), so a scene taken while a layer fades out holds
// it off, at the level it goes back to, and one taken mid-ramp holds where
// the ramp is going. Settings whose layer is off or whose drawer row is
// hidden are taken too: the step is the whole scene. The mixer's switches
// and the recordings live in the step's mix block instead.
function captureAll(st) {
  const o = st.overrides;
  for (let i = 0; i < R.length; i++) {
    if (!held[i] || lockHolds(i)) continue;
    const c = R[i], v = validValue(c, posOf(c));
    if (v !== undefined) o[c.id] = v;
  }
}

// Explicitly replace this step's scene, including live iPad adjustments.
// Its text and transport fields stay its own; capturing never restarts the
// walk or selects a different step.
export function journeySnapshotStep(i) {
  ensureLoaded();
  const st = data.steps[i];
  if (!st) return false;
  flushDiff();
  captureAll(st);
  st.seq = Array.isArray(S.seqs) ? seqStateOf(S) : null;
  st.mix = newMixBlock();
  dropMixOverrides(st);
  if (data.sizeLock && data.sizeRestore && SIZE) {
    const value = validValue(SIZE, SIZE.get(S));
    if (value !== undefined) data.sizeRestore[i] = { own: true, value };
    st.overrides.textSize = data.sizeLockValue;
  }
  if (sel === i) {
    performanceControls.clear();
    diffPending = false;
  }
  persist();
  return true;
}

// A new step at the end, born holding the whole scene as it stands, and
// selected straight away (for editing, unless the walk is playing, when its
// fold just opens).
export function journeyAddStep() {
  ensureLoaded();
  if (data.steps.length >= STEPS_MAX) return -1;
  const st = makeStep();
  captureAll(st);
  // a locked control is not taken; the new step carries on the one before
  // it, as reading the journey back would fill it (fillSteps)
  const last = data.steps.length ? data.steps[data.steps.length - 1].overrides : null;
  if (last) for (let i = 0; i < R.length; i++) {
    if (held[i] && lockHolds(i) && last[R[i].id] !== undefined) st.overrides[R[i].id] = last[R[i].id];
  }
  if (data.sizeLock && SIZE) {
    st.overrides.textSize = data.sizeLockValue;
    data.sizeRestore.push({ own: true, value: data.sizeLockValue });
  }
  // and the sequencer and the mix as they are
  if (Array.isArray(S.seqs)) st.seq = seqStateOf(S);
  st.mix = newMixBlock();
  data.steps.push(st);
  persist();
  const i = data.steps.length - 1;
  journeySelect(i);
  return i;
}

export function journeyDeleteStep(i) {
  ensureLoaded();
  if (!data.steps[i]) return;
  if (i === sel) deselect();
  if (play.stepIdx === i) stopWalk(false);
  else if (play.stepIdx > i) play.stepIdx--;
  if (sel > i) sel--;
  data.steps.splice(i, 1);
  if (data.sizeLock && data.sizeRestore) data.sizeRestore.splice(i, 1);
  persist();
}

// The window's drag: the step at `from` moves to sit at `to`, counted in the
// list as it is once the step has been lifted out. The selection and the
// walk follow their steps.
export function journeyMoveStep(from, to) {
  ensureLoaded();
  const steps = data.steps, n = steps.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
  const selStep = sel >= 0 ? steps[sel] : null, playStep = play.stepIdx >= 0 ? steps[play.stepIdx] : null;
  const st = steps.splice(from, 1)[0];
  steps.splice(to, 0, st);
  if (data.sizeLock && data.sizeRestore) {
    const restore = data.sizeRestore.splice(from, 1)[0];
    data.sizeRestore.splice(to, 0, restore);
  }
  if (selStep) sel = steps.indexOf(selStep);
  if (playStep) play.stepIdx = steps.indexOf(playStep);
  persist();
}

// ---------- a step's own fields ----------
// None of these touch the walk. On the step playing, a new ramp or hold only
// moves when auto-play moves on (the ramp under way keeps the length it
// began with), and the text, the appearance and the piano take effect live.

export function journeySetRamp(i, v) {
  ensureLoaded();
  const st = data.steps[i];
  if (!st || !Number.isFinite(v)) return;
  v = Math.max(RAMP_MIN, Math.min(RAMP_MAX, v));
  if (v === st.rampS) return;
  st.rampS = v;
  persist();
}

export function journeySetHold(i, v) {
  ensureLoaded();
  const st = data.steps[i];
  if (!st || !Number.isFinite(v)) return;
  v = Math.max(HOLD_MIN, Math.min(HOLD_MAX, v));
  if (v === st.holdS) return;
  st.holdS = v;
  persist();
}

// The step's text, cleaned. On the step being edited it shows at once:
// anything the drawer changed is recorded first, and then the Text source
// turning to Custom is recorded with it, as the scene the step now shows. On
// the step playing it shows at
// once too, cutting whatever word is up (wordNow), and a text still waiting
// for its moment in the ramp no longer waits.
export function journeySetText(i, text) {
  ensureLoaded();
  const st = data.steps[i];
  if (!st) return;
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, STEP_TEXT_MAX);
  if (clean === st.text) return;
  st.text = clean;
  if (i === sel && armed) {
    flushDiff();
    applyText(clean);
    cancelWordSequenceOnce();
  }
  else if (play.playing && i === play.stepIdx) {
    play.appearAt = -1;
    if (clean) { applyText(clean); wordSequenceOnce(); }
    else cancelWordSequenceOnce();
  }
  persist();
}

// The journey's name. A step on screen whose text says NAME takes the new
// one at once (the step being edited, or the step playing once its text has
// appeared); the phrase showing finishes as it was.
export function journeySetName(v) {
  ensureLoaded();
  const clean = String(v || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (clean === data.name) return;
  data.name = clean;
  const i = armed && sel >= 0 ? sel : play.playing && play.appearAt < 0 ? play.stepIdx : -1;
  const st = i >= 0 ? data.steps[i] : null;
  if (st && st.text.indexOf('NAME') >= 0) {
    if (i === sel && armed) {
      flushDiff();
      applyText(st.text);
      cancelWordSequenceOnce();
    }
    else applyText(st.text);
  }
  persist();
}
export function journeyName() { ensureLoaded(); return data.name; }

// When in its ramp the step's text first shows: 'start' as the step begins,
// 'mid' halfway through the ramp, 'end' as the ramp lands. On the step
// playing, a text still waiting takes the new moment (at once, when that has
// already passed); one already shown stays.
export function journeySetAppear(i, v) {
  ensureLoaded();
  const st = data.steps[i];
  if (!st || !APPEAR_OK[v] || st.appear === v) return;
  st.appear = v;
  if (i === play.stepIdx && play.appearAt >= 0) play.appearAt = play.enterT + APPEAR_AT[v] * st.rampS * 1000;
  persist();
}

export function journeySetPiano(i, mode) {
  ensureLoaded();
  const st = data.steps[i];
  if (!st || !PIANO_OK[mode] || st.piano === mode) return;
  st.piano = mode;
  if (play.playing && i === play.stepIdx) setPianoFree(mode !== 'text');
  persist();
}

// One drawer control's position, recorded into step i from the window (its
// FADE line), as though the drawer had moved it, checked as a stored one is.
// On the step on screen (the one being edited, or the one the walk is on) it
// lands at once through the control's own set(), so it is seen and heard and
// the drawer follows, and what is recorded is the position read back (the
// same the diff that set()'s save sets off finds). On the step playing, a
// ramp moving the control lets it go, as for any hand on the drawer.
export function journeySetOverride(i, id, v) {
  ensureLoaded();
  const st = data.steps[i], j = idxOf.get(id);
  if (!st || j === undefined || skip[j]) return;
  const k = canon[j], c = R[k];
  v = validValue(c, flip[j] ? !(v === true || v === 1) : v);
  if (v === undefined) return;
  const editing = armed && i === sel;
  if (editing || i === play.stepIdx) {
    if (c.journeyImmediate) takeFromGlide(c);
    if (!same(c, c.get(S), v)) c.set(S, v);
    v = c.get(S);
  }
  if (same(c, st.overrides[c.id], v)) return;
  st.overrides[c.id] = v;
  persist();
}

// SIZE can be linked across the whole Journey. The first lock click keeps a
// private copy of every step's own size. Moving SIZE while linked changes
// every step; unlocking puts each step's own back.
export function journeySizeLocked() { ensureLoaded(); return data.sizeLock; }

export function journeySetTextSize(i, v) {
  ensureLoaded();
  if (!data.sizeLock) { journeySetOverride(i, 'textSize', v); return; }
  if (!data.steps[i] || !SIZE) return;
  v = validValue(SIZE, v);
  if (v === undefined) return;
  if (SIZE.get(S) !== v) SIZE.set(S, v);
  v = SIZE.get(S);
  data.sizeLockValue = v;
  for (let j = 0; j < data.steps.length; j++) data.steps[j].overrides.textSize = v;
  persist();
}

export function journeySetSizeLock(i, on) {
  ensureLoaded();
  on = !!on;
  if (!SIZE || !data.steps[i] || data.sizeLock === on) return;
  flushDiff();
  if (on) {
    const fallback = validValue(SIZE, SIZE.get(S));
    let value = data.steps[i].overrides.textSize;
    if (value === undefined) value = fallback;
    value = validValue(SIZE, value);
    if (value === undefined) return;
    data.sizeRestore = data.steps.map(st => {
      const own = validValue(SIZE, st.overrides.textSize);
      return { own: true, value: own !== undefined ? own : fallback };
    });
    data.sizeLock = true;
    data.sizeLockValue = value;
    for (let j = 0; j < data.steps.length; j++) data.steps[j].overrides.textSize = value;
    SIZE.set(S, value);
  } else {
    const restore = data.sizeRestore || [];
    for (let j = 0; j < data.steps.length; j++) {
      const entry = restore[j];
      if (entry) data.steps[j].overrides.textSize = entry.value;
    }
    const live = play.stepIdx >= 0 ? play.stepIdx : armed ? sel : -1;
    const entry = live >= 0 ? restore[live] : null;
    if (entry) SIZE.set(S, entry.value);
    data.sizeLock = false;
    data.sizeLockValue = null;
    data.sizeRestore = null;
  }
  diffPending = false;
  persist();
}

// ---------- a preset loaded into a step ----------
//
// The step's text world: the controls behind the fold's TEXT line (the
// step's text lands through the Text source and the Custom phrases,
// applyText above), its FADE IN and FADE OUT, and its GAP. The text itself
// and when it appears are the step's own fields beside them.
const TEXT_LOCK_IDS = ['textMode', 'textCustomText', 'textDwell', 'textFadeIn', 'textFadeOut', 'textPhraseGap', 'textSize'];
const TEXT_LOCK = new Set(TEXT_LOCK_IDS);
const SIZE_LOCK = new Set(['textSize']);

// The window's preset picker: preset k (its index in the drawer's row) is
// loaded into the step being edited. Authoring only, so it does nothing
// while the walk plays, and it never touches the walk.
//
// The preset is recalled live, over the same short glide selecting a step
// uses (EDIT_GLIDE_S), and the step then takes the whole scene it made
// (captureAll), its positions read back from the controls (presets.js
// recallPresetForStep says why): the preset's own over the step's for
// everything it moved, the step's as they were for anything it left. The
// sequencer and the mix stay the step's, since a preset carries neither:
// applyStep puts them back over whatever the preset moved, so what is on
// screen and in the speakers is what the step now holds.
//
// With the step's text locked, its text world is left exactly as it is: the
// preset never moves those controls, its own positions for them are not
// taken, the step's own recorded ones are kept, and its text and appearance
// stay. Unlocked, the preset's positions for them come in like any other,
// and the step's text is cleared, so its words follow the preset's own text
// settings.
export function journeyLoadPreset(k) {
  ensureLoaded();
  if (!armed || sel < 0 || !winOpen || play.playing) return;
  const st = data.steps[sel];
  if (!st) return;
  flushDiff();
  const locked = st.textLock === true;
  const keep = locked ? TEXT_LOCK : data.sizeLock ? SIZE_LOCK : null;
  if (recallPresetForStep(k, EDIT_GLIDE_S, keep) === undefined) return;
  const was = {};
  if (keep) for (const id of keep) if (st.overrides[id] !== undefined) was[id] = st.overrides[id];
  captureAll(st);
  for (const id in was) st.overrides[id] = was[id];
  if (!locked) st.text = '';
  if (data.sizeLock) st.overrides.textSize = data.sizeLockValue;
  applyStep(st, EDIT_GLIDE_S);
  persist();
}

// The TEXT line's lock: whether loading a preset into step i leaves its text
// world alone. It changes nothing on screen, only what a later load does.
export function journeySetTextLock(i, on) {
  ensureLoaded();
  const st = data.steps[i];
  on = !!on;
  if (!st || st.textLock === on) return;
  st.textLock = on;
  persist();
}

// AUTO, a three-way button: 'off' (the transport alone moves the walk),
// 'auto' (each step moves on after its ramp and hold) and 'keys' (no auto
// advance; the digits 1-9 jump to that step, main.js). Switching it never
// touches the step playing: its settings, its ramp and its clock carry on
// exactly as they were, and leaving 'auto' leaves the step playing until the
// arrows, the transport or a digit move the walk. Only when auto comes on
// with the step already past its ramp and hold is the clock moved, so the
// hold is counted again from now rather than the walk jumping on the
// instant it is asked to wait.
export function journeySetMode(mode) {
  ensureLoaded();
  if (!MODES.includes(mode) || data.mode === mode) return;
  const autoOn = mode === 'auto' && !data.autoPlay;
  data.mode = mode;
  data.autoPlay = mode === 'auto';
  const st = play.stepIdx >= 0 ? data.steps[play.stepIdx] : null;
  if (autoOn && st) {
    const now = play.playing ? nowT : play.pausedAt;
    if (now - play.phaseStartT >= (st.rampS + st.holdS) * 1000) play.phaseStartT = now - st.rampS * 1000;
  }
  persist();
}
export function journeySetAutoPlay(on) { journeySetMode(on ? 'auto' : 'off'); }

// TRIGGER mode's source: 'keys' (the digits 1-9 jump, the arrows step,
// main.js) or 'midi' (note n jumps to step n, 100 steps back, 101 on;
// ui/screens/journey.js). Switching it touches nothing playing.
export function journeySetTrigger(t) {
  ensureLoaded();
  if (!TRIGGERS.includes(t) || data.trigger === t) return;
  data.trigger = t;
  persist();
}

// KEYS mode's digit: plays step i as its row's play button does
// (journeyPlayFrom), except that the step already playing is left alone, so
// a held key's repeats never restart it. A digit past the last step does
// nothing.
export function journeyJumpTo(i) {
  ensureLoaded();
  if (!(i >= 0 && i < data.steps.length)) return;
  if (play.playing && play.stepIdx === i) return;
  journeyPlayFrom(i);
}

// LOOP: an auto-play walk that passes the last step goes round to the first
// again instead of stopping. Switching it touches nothing playing.
export function journeySetLoop(on) {
  ensureLoaded();
  on = !!on;
  if (data.loop === on) return;
  data.loop = on;
  persist();
}

// ---------- the library ----------

// Keeps every title distinct, counting up ("Evening", "Evening 2"), compared
// without case, as the presets' names are; skip lets a rename keep its own.
function uniqueTitle(t, skip) {
  const taken = c => {
    const l = c.toLowerCase();
    for (let j = 0; j < lib.items.length; j++) if (j !== skip && lib.items[j].title.toLowerCase() === l) return true;
    return false;
  };
  if (!taken(t)) return t;
  for (let n = 2; ; n++) if (!taken(t + ' ' + n)) return t + ' ' + n;
}

// Leaving the open journey: what the drawer changed in the selected step is
// recorded into it first, then the walk ends and the step is let go.
function leaveOpen() {
  flushDiff();
  stopWalk(false);
  sel = -1; armed = false; diffPending = false;
}

function openId(id) {
  lib.cur = id;
  data = journeyById(id);
  persistLib();
}

// Opens the journey at chip i (the open one's own chip does nothing).
export function journeyOpenAt(i) {
  ensureLoaded();
  const it = lib.items[i];
  if (!it || it.id === lib.cur) return;
  leaveOpen();
  openId(it.id);
}

// A new, empty journey at the end of the row, opened. An empty title is a
// cancel. Returns its index, or -1.
export function journeyNew(title) {
  ensureLoaded();
  const t = cleanTitle(title);
  if (!t || lib.items.length >= LIB_MAX) return -1;
  leaveOpen();
  let n = 0;
  for (const it of lib.items) n = Math.max(n, parseInt(it.id.slice(1), 10) || 0);
  const id = 'j' + (n + 1);
  lib.items.push({ id, title: uniqueTitle(t, -1) });
  cache.set(id, readJourney(null));
  openId(id);
  persist();
  return lib.items.length - 1;
}

// An exported journey (a v2 record, as journeyExport writes one) added at
// the end of the row under title (made distinct as any title is) and
// opened, through the same read a reload takes. Returns its index, or -1
// when the library is full. The Presentation mode's TSC 2026 install
// (core/presentation.js) is its caller.
export function journeyImport(title, raw) {
  ensureLoaded();
  const t = cleanTitle(title);
  if (!t || lib.items.length >= LIB_MAX) return -1;
  leaveOpen();
  let n = 0;
  for (const it of lib.items) n = Math.max(n, parseInt(it.id.slice(1), 10) || 0);
  const id = 'j' + (n + 1);
  const rec = readJourney(JSON.parse(JSON.stringify(raw)));
  lib.items.push({ id, title: uniqueTitle(t, -1) });
  cache.set(id, rec);
  saveKey(keyOf(id), rec);
  openId(id);
  version++;
  return lib.items.length - 1;
}

// A copy of the open journey, exact settings and steps, placed on the chip
// just right of it and opened. The copy is named with the next free letter:
// "Dawn" begets "Dawn A", then "Dawn B", and a title already lettered counts
// up from its own base, so duplicating "Dawn B" gives the next letter free.
// Detached through the same write/read round trip a reload takes, so the two
// journeys share nothing.
export function journeyDuplicate() {
  ensureLoaded();
  if (lib.items.length >= LIB_MAX) return -1;
  // the selected step's pending drawer edits belong in the copy too
  flushDiff();
  const i = libIndex(lib.cur);
  const src = lib.items[i];
  if (!src) return -1;
  const copy = readJourney(JSON.parse(JSON.stringify(data)));
  let n = 0;
  for (const it of lib.items) n = Math.max(n, parseInt(it.id.slice(1), 10) || 0);
  const id = 'j' + (n + 1);
  const m = /^(.*\S)\s+[A-Z]$/.exec(src.title);
  const base = m ? m[1] : src.title;
  const taken = t => { const l = t.toLowerCase(); return lib.items.some(it => it.title.toLowerCase() === l); };
  let title = '';
  for (let c = 0; c < 26 && !title; c++) {
    const cand = base + ' ' + String.fromCharCode(65 + c);
    if (!taken(cand)) title = cand;
  }
  if (!title) title = uniqueTitle(base, -1);   // every letter taken: the numbered fallback
  leaveOpen();
  lib.items.splice(i + 1, 0, { id, title });
  cache.set(id, copy);
  saveKey(keyOf(id), copy);
  openId(id);
  version++;
  return i + 1;
}

// Deletes the journey at chip i; the open one hands over to its right-hand
// neighbour (else its left). The library always keeps one.
export function journeyDeleteAt(i) {
  ensureLoaded();
  const it = lib.items[i];
  if (!it || lib.items.length <= 1) return;
  if (it.id === lib.cur) {
    leaveOpen();
    const next = lib.items[i + 1] || lib.items[i - 1];
    lib.cur = next.id;
    data = journeyById(next.id);
  }
  lib.items.splice(i, 1);
  cache.delete(it.id);
  saveKey(keyOf(it.id), null);
  persistLib();
}

// An empty title leaves the chip as it was.
export function journeyRenameAt(i, title) {
  ensureLoaded();
  const it = lib.items[i], t = cleanTitle(title);
  if (!it || !t) return;
  const u = uniqueTitle(t, i);
  if (u === it.title) return;
  it.title = u;
  persistLib();
}

export function journeyMoveAt(from, to) {
  ensureLoaded();
  const n = lib.items.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
  const it = lib.items.splice(from, 1)[0];
  lib.items.splice(to, 0, it);
  persistLib();
}

// The open journey as a file: its record just as storage keeps it, so the
// file reads like the saved TSC journey (documents/tsc-2026-journey.json),
// named after its chip.
export function journeyExport() {
  ensureLoaded();
  const it = lib.items[libIndex(lib.cur)];
  return { title: it ? it.title : 'Journey', json: JSON.stringify(data, null, 1) };
}
export function journeyLibCount() { ensureLoaded(); return lib.items.length; }
export function journeyLibTitle(i) { ensureLoaded(); return lib.items[i] ? lib.items[i].title : ''; }
export function journeyLibOpen() { ensureLoaded(); return libIndex(lib.cur); }

// ---------- the walk ----------

// The piano: a step set to play on the text idles the free-running piano
// (js/piano.js reads S.pianoFreePlay; it is never saved) and plays one
// gesture as each word appears, and nothing else. Mixed lets it play freely
// and adds the gesture on each word; free is the piano as the interface has
// it, no gestures.
function setPianoFree(free) {
  if ((S.pianoFreePlay !== false) === free) return;
  S.pianoFreePlay = free;
}
onWordAppear(() => {
  if (!play.playing || !data) return;
  const st = data.steps[play.stepIdx];
  if (!st || st.piano === 'free') return;
  // The count carries the gesture to the page in worker mode
  // (core/audio-link.js); the call plays it here in main mode, and is a
  // no-op in the worker, where no audio runs.
  S.pianoGestureN = (S.pianoGestureN | 0) + 1;
  pianoGesture();
});

// Enters step i: a cut when its ramp is (nearly) 0, else the ramp. Its text,
// when it has any, shows as the step begins or waits for its moment in the
// ramp (appear); until then the words carry on as they were, and at that
// moment the text source turns to the step's text and its first phrase goes
// up straight away (stepJourney).
function enterStep(i) {
  performanceControls.clear();
  const st = data.steps[i];
  // The open/highlighted row follows the transport. Previously playStep
  // moved independently from sel, leaving the old row yellow while another
  // step was actually running.
  if (sel !== i) {
    sel = i;
    version++;
  }
  armed = false;
  play.stepIdx = i;
  saveKey(POS_KEY, { id: lib.cur, step: i });
  play.phaseStartT = play.enterT = nowT;
  play.appearAt = -1;
  cancelWordSequenceOnce();
  endTween();
  const ramped = st.rampS >= TWEEN_MIN_S;
  const at = APPEAR_AT[st.appear] || 0;
  const textNow = !!st.text && (!ramped || at === 0);
  if (ramped) startRamp(st, textNow);
  else applyStep(st, st.rampS);
  if (textNow) wordSequenceOnce();
  else if (st.text) play.appearAt = nowT + at * st.rampS * 1000;
  setPianoFree(st.piano !== 'text');
}

// The app's own run switch (main.js's toggleRun, handed in as setRunning):
// the journey's transport carries the whole experience with it, so playing
// a step starts the app and pausing the walk pauses the app.
let setRunning = null;
export function setJourneyRunning(fn) { setRunning = fn; }
const runApp = on => { if (setRunning) setRunning(on); };
// The walk's own pause and resume, handed in by main.js (which pairs it with
// gpu/slides.js pauseSlideForWalk / resumeSlideForWalk, so this core module
// imports nothing from gpu/): called with true as a playing walk pauses
// (journeyPause, whatever asked: Space, the window's play button, a row's)
// and false as the walk plays again: journeyTogglePlay resuming from that
// pause, or journeyPlayFrom starting a step (the slides let go only what the
// pause held).
let pauseHook = null;
export function setJourneyPauseHook(fn) { pauseHook = fn; }

function stopWalk(rearm = true) {
  const edit = play.stepIdx;
  play.playing = false;
  play.stepIdx = -1;
  play.appearAt = -1;
  endTween();
  cancelWordSequenceOnce();
  manual.clear();
  setPianoFree(true);
  // A naturally completed/stopped walk must not leave a fold that looks
  // editable while silently discarding its changes. Keep the last played
  // step open and immediately make it the authoring step.
  if (rearm && winOpen && data && data.steps[edit]) {
    sel = edit;
    armed = true;
    diffPending = false;
    version++;
  }
}

// Called by live UI controls when the viewer deliberately changes a value.
// The current Journey tween releases it immediately, and every later step in
// this same walk leaves it alone. A paused walk still counts as the same
// session, so a change made while paused remains authoritative on resume.
export function journeyManualOverride(id, requested) {
  // the journey's own steps going through the performer's door (throughDoor)
  if (driving) return;
  for (const t of withTwins(id)) {
    const i = idxOf.get(t);
    if (i !== undefined) performanceControls.delete(canon[i]);
  }
  if (id === 'lParticles' || id === 'particlesOn') journeyDiag('particle control changed', { id });
  if (armed && sel >= 0 && winOpen) { diffPending = true; queueDiff(); }
  if (play.stepIdx < 0 || typeof id !== 'string') return;
  // With Journey visible, performing a control while a step plays is an
  // edit of that step. Capture the requested position after the UI setter
  // completes, and release only the current ramp. It must not enter the
  // walk-wide manual set, or the next step would be forbidden from restoring
  // its own snapshot (the Particles-on / Step-1-off failure).
  if (winOpen) {
    const target = play.stepIdx;
    queueMicrotask(() => recordLiveControl(target, id, requested));
    for (const t of withTwins(id)) releaseJourneyControl(t);
    return;
  }
  // Taking one door by hand protects its twins (see twins) from a later
  // Journey step as well.
  for (const t of withTwins(id)) { manual.add(t); releaseJourneyControl(t); }
}

function releaseJourneyControl(id) {
  const i = idxOf.get(id);
  if (i !== undefined) {
    for (let k = 0; k < tw.n; k++) if (twIdx[k] === i) twIdx[k] = -1;
  }
  if (COLOR && id === COLOR.id) tw.colorOn = false;
  rampIds.delete(id);
}

// A hand's move, recorded into the step playing, once, under the door its
// twins share (canon): what was asked for, turned over for a twin that reads
// the opposite way, else where the control is headed (a layer fading out
// from the music window still reads on until the fade lands).
function recordLiveControl(stepIdx, id, requested) {
  if (!data || !winOpen) return;
  const st = data.steps[stepIdx], j = idxOf.get(id);
  if (!st || j === undefined) return;
  const k = canon[j], c = R[k];
  let moved = false;
  const changed = [];
  if (held[k] && !lockHolds(k)) {
    let v = requested === undefined ? posOf(c) : flip[j] ? !(requested === true || requested === 1) : requested;
    v = validValue(c, v);
    if (v !== undefined && !same(c, st.overrides[c.id], v)) {
      st.overrides[c.id] = v;
      changed.push(c.id + '=' + String(v));
      moved = true;
    }
  }
  if (snapSeq(st)) moved = true;
  if (snapMix(st)) moved = true;
  if (!moved) return;
  persist();
  journeyDiag('LIVE RECORDED STEP ' + (stepIdx + 1), { changed });
}

// Starts the walk at step i, entering it over its own ramp. A step being
// edited stops recording; its fold stays open.
export function journeyPlayFrom(i) {
  ensureLoaded();
  const n = data.steps.length;
  if (!n) return;
  i = Math.max(0, Math.min(n - 1, i | 0));
  disarm();
  play.playing = true;
  runApp(true);
  if (pauseHook) pauseHook(false);
  journeyDiag('PLAY STEP ' + (i + 1), {
    lParticles: data.steps[i].overrides.lParticles,
    particlesOn: data.steps[i].overrides.particlesOn,
    text: data.steps[i].text
  });
  enterStep(i);
  journeyDiag('STEP ' + (i + 1) + ' APPLIED', { particlesAfterApply: !!S.layers.particles });
}

// A pause holds the walk where it is, ramp and all: the sliders stop where
// the ramp had them, and a resume carries on from that point.
export function journeyPause() {
  if (!play.playing) return;
  play.playing = false;
  play.pausedAt = nowT;
  setPianoFree(true);
  runApp(false);
  if (pauseHook) pauseHook(true);
}

export function journeyStop() { stopWalk(); }

// The title bar's play button: pause while playing; otherwise start at the
// step being edited, else carry on from a pause, else start at the step
// whose fold is open, else at the top.
export function journeyTogglePlay() {
  ensureLoaded();
  if (play.playing) { journeyPause(); return; }
  if (armed && sel >= 0) { journeyPlayFrom(sel); return; }
  const st = play.stepIdx >= 0 ? data.steps[play.stepIdx] : null;
  if (st) {
    const d = nowT - play.pausedAt;
    play.phaseStartT += d; play.enterT += d;
    if (play.appearAt >= 0) play.appearAt += d;
    if (tw.active) tw.t0 += d;
    play.playing = true;
    runApp(true);
    setPianoFree(st.piano !== 'text');
    if (pauseHook) pauseHook(false);
    return;
  }
  journeyPlayFrom(sel >= 0 ? sel : 0);
}

// The title bar's arrows: one step back or on from where the walk is (or
// from the step whose fold is open), playing from there.
export function journeyStepBy(dir) {
  ensureLoaded();
  const n = data.steps.length;
  if (!n) return;
  const base = play.stepIdx >= 0 ? play.stepIdx : sel >= 0 ? sel : dir > 0 ? -1 : 1;
  const to = Math.max(0, Math.min(n - 1, base + dir));
  if (play.playing && to === play.stepIdx) return;
  journeyPlayFrom(to);
}

// A wake (core/wake.js): a playing walk is carried forward by the time spent
// away, exactly as a resume from pause carries it (journeyTogglePlay), so a
// step mid-hold keeps the hold it had left, a ramp carries on from where it
// stood, and a step's text still waits for its moment. A paused walk needs
// nothing: its own resume counts from pausedAt.
export function journeyResume(away) {
  if (!play.playing || !(away > 0)) return;
  play.phaseStartT += away; play.enterT += away;
  if (play.appearAt >= 0) play.appearAt += away;
  if (tw.active) tw.t0 += away;
}

// A walk playing, or an authoring diff waiting its turn: the still frame
// (main.js) keeps the loop awake for either, since both move on the
// frame's clock.
export function journeyBusy() { return play.playing || diffPending; }

// Once a frame, from main.js, straight after the words step: the throttled
// authoring diff, the ramp, the step's text at its moment, and auto-play's
// clock. Nothing here allocates; a paused walk, its ramp included, waits.
export function stepJourney(t) {
  nowT = t;
  if (diffPending && t - lastDiffT >= DIFF_MS) { lastDiffT = t; runDiff(); }
  if (!play.playing) return;
  ensureLoaded();
  const st = data.steps[play.stepIdx];
  if (!st) { stopWalk(); return; }
  if (tw.active) stepTween(t);
  if (play.appearAt >= 0 && t >= play.appearAt) {
    play.appearAt = -1;
    if (st.text) { applyText(st.text); wordSequenceOnce(); }
  }
  if (data.autoPlay && t - play.phaseStartT >= (st.rampS + st.holdS) * 1000) {
    const next = play.stepIdx + 1;
    if (next < data.steps.length) enterStep(next);
    else if (data.loop) enterStep(0);
    else stopWalk();
  }
}

// ---------- reads for the drawer ----------
// The ramp, as the drawer shows it: how brightly the moving rows glow, 0..1
// (0 whenever no ramp is playing, which is the one test an idle drawer pays),
// and whether a control, a section or a sub-drawer strip is in it, a set
// lookup each.

export const journeyRampGlow = () => play.playing ? tw.glow : 0;
export const journeyRamping = () => play.playing && tw.active;
export const journeyRampingControl = id => rampIds.has(id);
export const journeyRampingSection = id => rampSections.has(id);
export const journeyRampingSub = id => rampSubs.has(id);

// ---------- reads for the window ----------
// All allocation-free; journeyVersion() moves whenever anything a readout
// prints could have changed, so the window rebuilds its strings only then.

export function journeyVersion() { ensureLoaded(); return version; }
export function journeyCount() { ensureLoaded(); return data.steps.length; }
// The step itself, for reading its fields; edits go through the setters.
export function journeyStepAt(i) { ensureLoaded(); return data.steps[i] || null; }
export const journeySelected = () => sel;
export const journeyPlaying = () => play.playing;
export const journeyPlayIdx = () => play.stepIdx;
// true only in 'auto' (the walk advancing by itself); KEYS reads false
export function journeyAutoPlay() { ensureLoaded(); return data.autoPlay; }
export function journeyMode() { ensureLoaded(); return data.mode; }
export function journeyTrigger() { ensureLoaded(); return data.trigger; }
export function journeyLoop() { ensureLoaded(); return data.loop; }
// How far through its ramp and hold the playing step is, 0..1, while the
// walk plays, with auto-play on or off (off, it fills and then waits full),
// so switching AUTO never makes the step look stopped or restarted; -1 when
// nothing plays.
export function journeyProgress() {
  if (!play.playing || !data) return -1;
  const st = data.steps[play.stepIdx];
  if (!st) return -1;
  const total = (st.rampS + st.holdS) * 1000;
  return total > 0 ? Math.max(0, Math.min(1, (nowT - play.phaseStartT) / total)) : 1;
}
