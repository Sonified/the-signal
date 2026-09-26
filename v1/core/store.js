// Persistence: the one localStorage key v0 and v1 both read and write, under
// the same JSON shape, so a session saved in one build opens correctly in the
// other. load() is the DOM-free twin of js/settings.js's applySettings(): the
// same S assignments, in the same order, with the same non-DOM side effects
// (setColorFromPicker, applyEdgeDir, normalizeAmbLayers), and none of the
// $(id).value / classList painting, since v1 has no DOM controls to paint.
// save() is the DOM-free twin of saveSettings(): the exact same object shape,
// key for key, so the file round-trips both ways. Neither function reaches
// past the platform.storage object handed in through initStore; nothing here
// touches window.localStorage directly, which is what keeps this module
// usable from a future native host as well as the browser.
//
// A control's `set` calls save() after every change, the same way v0's
// handlers end with saveSettings(). That is dozens of times a session, never
// per frame, so building a fresh settings object on every call is cheap
// enough; the debounce below exists to collapse a slider drag's flood of
// input events into one write, not to make save() itself fast.
//
// Several tabs can hold the page open at once (v1 beside v1, or v1 beside
// v0), each with its own copy of S, and every write puts the WHOLE state
// back. Without help, a tab left open in the background would write its
// stale copy the next time anything in it saved, and the next load would
// restore those old values instead of the ones just chosen elsewhere. So
// each tab listens for the others' writes (syncFromStorage, fed by the
// platform's storage event) and takes them into its own S at once, through
// the same code load() uses, without writing anything back. A tab's own
// write can then only ever carry what the viewer last chose, wherever they
// chose it. A hidden tab also holds back the saves nobody asked for (the
// atmosphere drift's crossfade progress) until it is visible again, and
// drops them if another tab has written in the meantime (setHidden).
//
// Only v1 tabs take part in that exchange. v0 never listens, and a v0 tab
// left open (often hidden, often on an old preset) rewrites the whole shared
// object on its own background saves, so taking its writes live would throw
// the viewer's session over to whatever that forgotten tab holds. v1 stamps
// its own writes of the shared object (WRITER_KEY below); v0's saveSettings
// builds its object from a fixed list and so drops the stamp, which is how an
// unstamped write is known to be v0's. Those are not applied live; this tab
// keeps its state and marks it to be written again (see syncFromStorage).
// load() at boot still takes whatever is stored, whoever wrote it.

import { S, layers, STORE, SKIP_KEY } from '../../js/state.js';
import { setColorFromPicker } from '../../js/color.js';
import { applyEdgeDir } from '../../js/sim.js';
import { normalizeAmbLayers, syncAmbLayers } from '../../js/ambience.js';
import { CHANNELS, applyMixGates } from '../../js/mixgate.js';
// A cycle (schema-flowers.js and schema-kaleido.js import save() from here),
// but a harmless one: neither side calls into the other while it is being
// evaluated, only later, from load() and from a control's set().
import { initFlowerState, flowerStateOf, applyFlowerState } from './schema-flowers.js';
import { initKaleidoState, kaleidoStateOf, applyKaleidoState } from './schema-kaleido.js';
import { initParticleState, particleStateOf, applyParticleState } from './schema-particles.js';
import { initFireworkState, fireworkStateOf, applyFireworkState } from './schema-fireworks.js';
import { FX_NAMES } from './word-fx.js';

// State that exists only in v1, kept out of the shared STORE object. v0's
// saveSettings() writes a fixed list of keys, so anything v1 added to the
// shared object would be dropped the next time v0 saved. This record is v1's
// alone and v0 never reads or writes it. Today it holds the Flowers and
// Kaleidoscope layers, side by side in one flat object (their field names
// never collide, since every one carries its layer's prefix).
const EXTRA_KEY = 'signal.v1.extra';

let storage = null;

export function initStore(s) {
  storage = s;
}

// S.rgb is the source of truth for colour; v0 kept the hex string only in the
// <input type=color> element, so both this file and schema-visual.js need
// their own small way back to it. Duplicated rather than imported from the
// schema, so persistence never depends on the UI module that happens to
// describe the same control.
function rgbHex(rgb) {
  const h = n => n.toString(16).padStart(2, '0');
  return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
}

const SAVE_DELAY_MS = 400;
let saveTimer = null;
// Which of the two records this tab has changed and not yet written. save()
// cannot tell which fields a control touched, so it marks both; a change
// arriving from another tab clears the one it covers, since this tab's copy
// of those fields has just been replaced by the newer one and writing it
// again would at best repeat it. The other record's write still goes ahead,
// so a flower change made here is not lost to an unrelated write from v0.
let dirtyShared = false, dirtyExtra = false;
// Set while the document is hidden (setHidden, from the platform's
// visibility callback): saves are marked but not scheduled.
let hidden = false;
// Set while another tab's change is being applied, so nothing that apply
// runs (every replayed control's set() ends in save()) can write it back.
let applyingRemote = false;
// The writer stamp on this tab's writes of the shared object: this tab's id
// and a running count, "<id>:<n>". Both v0's applySettings and load() below
// read only the keys they name, so the extra key is ignored on the way in,
// and v0 never writes it. The id is fresh on every page load.
const WRITER_KEY = '_v1w';
const TAB_ID = Math.random().toString(36).slice(2, 10);
let writeCount = 0;
// console.info once per session when a v0 write is ignored, not on each one.
let v0Noted = false;

function buildSettings() {
  return {
    freq: S.freq, depth: S.depth, bright: S.bright, wave: S.wave, fieldShape: S.fieldShape,
    fieldFade: S.fieldFade, fieldSoft: S.fieldSoft,
    color: rgbHex(S.rgb),
    ringSpeedMul: S.ringSpeedMul, ringFade: S.ringFade, ringThick: S.ringThick, ringThickVar: S.ringThickVar, edgeCount: S.edgeCount,
    edgeSize: S.edgeSize, edgeCap: S.edgeCap, edgeOpacity: S.edgeOpacity, trailMul: S.trailMul, edgeSpeedMul: S.edgeSpeedMul,
    edgeDir: S.edgeDir, layers: sharedLayers(),
    textLinked: S.textLinked, textRateHz: S.textRateHz, textFreq: S.textFreq,
    textRandom: S.textRandom, textDwellMs: S.textDwellMs,
    textFadeInMs: S.textFadeInMs, textFadeOutMs: S.textFadeOutMs,
    textFadeInVar: S.textFadeInVar, textFadeOutVar: S.textFadeOutVar,
    textSize: S.textSize, textThemes: S.textThemes, textMode: S.textMode, textLineWidth: S.textLineWidth,
    textSmartBreaks: S.textSmartBreaks,
    textLinesTogether: S.textLinesTogether, textLinesTogetherOut: S.textLinesTogetherOut,
    textOpacity: S.textOpacity, textOpacityVar: S.textOpacityVar,
    textOpacityVarPeriod: S.textOpacityVarPeriod, textBrighten: S.textBrighten,
    textColorMode: S.textColorMode,
    musicOn: S.musicOn, pianoStyle: S.pianoStyle, pianoVol: S.pianoVol, bedVol: S.bedVol,
    bedLpfOn: S.bedLpfOn, bedLpfLo: S.bedLpfLo, bedLpfHi: S.bedLpfHi, bedLpfPeriod: S.bedLpfPeriod,
    bedLpfQ: S.bedLpfQ, bedLpfWander: S.bedLpfWander, bedLpfSlope: S.bedLpfSlope, bedDetune: S.bedDetune,
    bedRevOn: S.bedRevOn, bedRevLevel: S.bedRevLevel, bedVerbOn: S.bedVerbOn, bedVerbLo: S.bedVerbLo, bedVerbHi: S.bedVerbHi, bedVerbPeriod: S.bedVerbPeriod,
    bedVerbWander: S.bedVerbWander,
    pianoReverb: S.pianoReverb, pianoRevTime: S.pianoRevTime, pianoHP: S.pianoHP, musicRevOn: S.musicRevOn, bedOn: S.bedOn, pianoOn: S.pianoOn, arpOn: S.arpOn, arpVol: S.arpVol, arpRate: S.arpRate, arpWave: S.arpWave, arpAtk: S.arpAtk, arpDec: S.arpDec, arpOct: S.arpOct, arpRev: S.arpRev, arpSpread: S.arpSpread, arpStrobeAm: S.arpStrobeAm,
      arpSwOn: S.arpSwOn, arpSwLo: S.arpSwLo, arpSwHi: S.arpSwHi, arpSwPeriod: S.arpSwPeriod, arpSwWander: S.arpSwWander,
    pianoDensity: S.pianoDensity, pianoCentre: S.pianoCentre,
    pianoSpread: S.pianoSpread, pianoHold: S.pianoHold, pianoBass: S.pianoBass,
    cloudsOn: S.cloudsOn, cloudVol: S.cloudVol, cloudDensity: S.cloudDensity,
    cloudPhrase: S.cloudPhrase, cloudReverb: S.cloudReverb, cloudRevTime: S.cloudRevTime,
    ambOn: S.ambOn, ambVol: S.ambVol, ambDrift: S.ambDrift, ambDriftFadeS: S.ambDriftFadeS,
    ambReverb: S.ambReverb, ambRevTime: S.ambRevTime,
    ambLayers: S.ambLayers,
    pipTrimDb: S.pipTrimDb, biOn: S.biOn, chirpVol: S.chirpVol, chirpReverb: S.chirpReverb, chirpRevTime: S.chirpRevTime,
    chirpModDepth: S.chirpModDepth, chirpModPeriod: S.chirpModPeriod,
    clickMode: S.clickMode, chirpLowHz: S.chirpLowHz, chirpHighHz: S.chirpHighHz,
    chirpComp: S.chirpComp, chirpTilt: S.chirpTilt,
    pipLpfOn: S.pipLpfOn, pipLpfLo: S.pipLpfLo, pipLpfHi: S.pipLpfHi, pipLpfPeriod: S.pipLpfPeriod,
    pipLpfQ: S.pipLpfQ, pipLpfWander: S.pipLpfWander,
    textRestFreq: S.textRestFreq, textRestSec: S.textRestSec, textRestVar: S.textRestVar,
    depthVar: S.depthVar, depthVarOn: S.depthVarOn, varPeriod: S.varPeriod, panelOpen: S.panelOpen,
    freqDrift: S.freqDrift, freqDriftOn: S.freqDriftOn, driftPeriod: S.driftPeriod, perElementColor: S.perElementColor, colorMode: S.colorMode,
    frameLock: S.frameLock, spareMode: S.spareMode, walkPeriod: S.walkPeriod, brightVar: S.brightVar, brightVarOn: S.brightVarOn,
    brightVarPeriod: S.brightVarPeriod, colorWalk: S.colorWalk,
    hueLo: S.hueLo, hueSpan: S.hueSpan,
    ringBrightVar: S.ringBrightVar, ringBrightPeriod: S.ringBrightPeriod,
    edgeSpeedVar: S.edgeSpeedVar, edgeSpeedVarPeriod: S.edgeSpeedVarPeriod,
    edgeSizeVar: S.edgeSizeVar, edgeSizeVarPeriod: S.edgeSizeVarPeriod,
    carrierHz: S.carrierHz, amRate: S.amRate, volume: S.volume, amLinked: S.amLinked,
    toneOn: S.toneOn, clickOn: S.clickOn, toneVol: S.toneVol, clickVol: S.clickVol, pipMs: S.pipMs,
    harmOn: S.harmOn, harmVol: S.harmVol, harmCount: S.harmCount, harmBright: S.harmBright,
    harmSpread: S.harmSpread, harmPanRate: S.harmPanRate, harmReverb: S.harmReverb,
    shimDepth: S.shimDepth, shimRate: S.shimRate, clickReverb: S.clickReverb,
    clickRevTime: S.clickRevTime, clickModDepth: S.clickModDepth, clickModPeriod: S.clickModPeriod,
    biDepth: S.biDepth, biPeriod: S.biPeriod, biHardSwitch: S.biHardSwitch,
    rendererPref: S.rendererPref,
    // v0 reads this straight off the <input id=lAudio> checkbox, which v1 has
    // no equivalent of. Lane E2's audio-layer control is the one write path
    // for it here, stashing the boot preference on S.audioOnBoot (see the
    // note in load() below); this line just carries that same name into the
    // saved JSON so the key matches what v0 writes and reads.
    // Unset means on (schema-audio.js's audioLayerOn), so only an explicit
    // false saves as off; !!undefined used to save a never-touched layer as
    // off, and the next load came up muted.
    audioOnBoot: S.audioOnBoot !== false,
    skipWarning: storage ? storage.get(SKIP_KEY) === '1' : false
  };
}

// The layers object minus the v1-only switches. S.layers.flowers and
// S.layers.kaleido live on the same object the GPU reads, but they are
// persisted in the extra record, so the shared file keeps exactly the layer
// keys v0 knows. Otherwise v0 would restore stray 'flowers' and 'kaleido'
// keys and list them among its active layers.
function sharedLayers() {
  const out = {};
  for (const k in layers) if (k !== 'flowers' && k !== 'kaleido' && k !== 'particles' && k !== 'fireworks') out[k] = layers[k];
  return out;
}

// The six fixed mixer channels' mute and solo flags (js/mixgate.js) ride in
// this record too: v0 never shows them, so they stay out of the shared file
// the same way the v1 layers do. Copied, not referenced, so a snapshot holds
// still while the viewer keeps pressing buttons.
function mixStateOf(s) {
  const m = {}, o = {};
  for (let i = 0; i < CHANNELS.length; i++) {
    const ch = CHANNELS[i];
    m[ch] = !!s.chanMute[ch]; o[ch] = !!s.chanSolo[ch];
  }
  return { chanMute: m, chanSolo: o };
}
// Only the flags a record actually carries, so one written before these
// existed leaves every channel as it is. When any flag moved, the gates are
// re-applied at once, which at boot (no audio yet) is a no-op and later makes
// a flag arriving from another tab or a preset audible straight away. When
// none moved nothing is touched, so a flower change synced from another tab
// never re-ramps the engine levels.
function applyMixState(s, x) {
  const m = x.chanMute && typeof x.chanMute === 'object' ? x.chanMute : null;
  const o = x.chanSolo && typeof x.chanSolo === 'object' ? x.chanSolo : null;
  if (!m && !o) return;
  let moved = false;
  for (let i = 0; i < CHANNELS.length; i++) {
    const ch = CHANNELS[i];
    if (m && typeof m[ch] === 'boolean' && s.chanMute[ch] !== m[ch]) { s.chanMute[ch] = m[ch]; moved = true; }
    if (o && typeof o[ch] === 'boolean' && s.chanSolo[ch] !== o[ch]) { s.chanSolo[ch] = o[ch]; moved = true; }
  }
  if (moved) applyMixGates();
}

// The sequencer's patterns and which one plays (js/piano.js), v1 only, so
// they ride here with the other v1 state. Copied, so a snapshot holds still.
function seqStateOf(s) {
  return {
    seqSlot: s.seqSlot | 0,
    seqPatterns: s.seqPatterns.map(p => ({ len: p.len, steps: p.steps.slice() }))
  };
}
// Only well-formed patterns are taken; anything else keeps the default.
function applySeqState(s, x) {
  if (Array.isArray(x.seqPatterns)) {
    for (let i = 0; i < s.seqPatterns.length && i < x.seqPatterns.length; i++) {
      const p = x.seqPatterns[i];
      if (!p || !Array.isArray(p.steps) || !Number.isFinite(p.len)) continue;
      const steps = new Array(16).fill(-1);
      for (let k = 0; k < 16; k++) if (Number.isFinite(p.steps[k])) steps[k] = p.steps[k];
      s.seqPatterns[i] = { len: Math.max(1, Math.min(16, Math.round(p.len))), steps };
    }
  }
  if (Number.isFinite(x.seqSlot)) s.seqSlot = Math.max(0, Math.min(s.seqPatterns.length - 1, x.seqSlot | 0));
}

// The word transitions (core/word-fx.js): v1 only, since v0's word is a DOM
// element with nothing but a fade.
// Arrive's settings; Leave keeps its own copy of each under the same name
// plus 'Out'.
const WORD_FX_SIDED = ['textFxDist', 'textFxStagger', 'textFxTurb', 'textFxBlur', 'textFxEase', 'textFxWindDir',
                       'textSmokeSpeed', 'textSmokeSoft', 'textSmokeLinger', 'textSmokeSweepSpeed',
                       'textSmokeRadial', 'textSmokeAccel', 'textSmokeEq'];
const WORD_FX_NUMS = WORD_FX_SIDED.concat(WORD_FX_SIDED.map(k => k + 'Out'), ['textCloudCount', 'textCloudSize']);
function wordFxStateOf(s) {
  const o = { textFxIn: s.textFxIn, textFxOut: s.textFxOut, textFxMirror: s.textFxMirror,
              textSmokeSweep: s.textSmokeSweep, textSmokeSweepOut: s.textSmokeSweepOut,
              textGatherSweep: s.textGatherSweep, textGatherSweepOut: s.textGatherSweepOut,
              textFadeInOn: s.textFadeInOn, textFadeOutOn: s.textFadeOutOn };
  for (const k of WORD_FX_NUMS) o[k] = s[k];
  return o;
}
function applyWordFxState(s, x) {
  // The particle effect was first called Mist, which collided with the blur
  // slider's old name; both were renamed, and a record from then reads as now.
  const fxIn = x.textFxIn === 'mist' ? 'cloud' : x.textFxIn;
  const fxOut = x.textFxOut === 'mist' ? 'cloud' : x.textFxOut;
  if (Number.isFinite(x.textFxMist)) s.textFxBlur = x.textFxMist;
  if (Number.isFinite(x.textMistCount)) s.textCloudCount = x.textMistCount;
  if (Number.isFinite(x.textMistSize)) s.textCloudSize = x.textMistSize;
  if (FX_NAMES[fxIn])  s.textFxIn = fxIn;
  if (FX_NAMES[fxOut]) s.textFxOut = fxOut;
  if (typeof x.textFxMirror === 'boolean') s.textFxMirror = x.textFxMirror;
  if (typeof x.textSmokeSweep === 'boolean') s.textSmokeSweep = x.textSmokeSweep;
  if (typeof x.textSmokeSweepOut === 'boolean') s.textSmokeSweepOut = x.textSmokeSweepOut;
  // A record from before Leave had its own settings shared one set between
  // both sides, so Leave starts from that same value.
  else if (typeof x.textSmokeSweep === 'boolean') s.textSmokeSweepOut = x.textSmokeSweep;
  if (typeof x.textGatherSweep === 'boolean') s.textGatherSweep = x.textGatherSweep;
  if (typeof x.textGatherSweepOut === 'boolean') s.textGatherSweepOut = x.textGatherSweepOut;
  if (typeof x.textFadeInOn === 'boolean') s.textFadeInOn = x.textFadeInOn;
  if (typeof x.textFadeOutOn === 'boolean') s.textFadeOutOn = x.textFadeOutOn;
  for (const k of WORD_FX_SIDED) if (!Number.isFinite(x[k + 'Out']) && Number.isFinite(x[k])) s[k + 'Out'] = x[k];
  for (const k of WORD_FX_NUMS) if (Number.isFinite(x[k])) s[k] = x[k];
}

function buildExtra() {
  return Object.assign(flowerStateOf(S), kaleidoStateOf(S), particleStateOf(S), fireworkStateOf(S), mixStateOf(S), seqStateOf(S),
                       wordFxStateOf(S));
}

// Each layer's helper picks out only its own fields and leaves S alone for
// anything missing, so a record written before the kaleidoscope existed
// restores the flowers and keeps the kaleidoscope at its defaults.
function applyExtra(x) {
  if (!x || typeof x !== 'object') return;
  applyFlowerState(S, x);
  applyKaleidoState(S, x);
  applyParticleState(S, x);
  applyFireworkState(S, x);
  applyMixState(S, x);
  applySeqState(S, x);
  applyWordFxState(S, x);
}

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!storage) return;
  if (dirtyShared) {
    dirtyShared = false;
    const out = buildSettings();
    out[WRITER_KEY] = TAB_ID + ':' + (++writeCount);
    try { storage.set(STORE, JSON.stringify(out)); } catch (e) { /* quota or a disabled store; the run keeps going without persistence */ }
  }
  if (dirtyExtra) {
    dirtyExtra = false;
    try { storage.set(EXTRA_KEY, JSON.stringify(buildExtra())); } catch (e) { /* same */ }
  }
}

// Trailing, but without re-arming a timer on every call. A slider drag calls
// save() on each input event, up to one a frame, and clearing and setting a
// timer each time was a hundred-odd timer objects a second for the page to
// make and throw away. Now the first call arms one timer and later calls
// only note the time; when it fires it checks whether a call came in since,
// and if so waits out the remainder instead of writing. Same trailing write,
// SAVE_DELAY_MS after the last change, for two or three timers a drag.
let lastSaveCall = 0;
// The write itself (two JSON builds and synchronous localStorage sets) is not
// done from the timer, which could fire at any point inside a strobe frame's
// budget. The timer only marks it due, and main.js calls writeDueAfterFrame()
// straight after the frame's submit, the start of the longest stretch of idle
// main thread a frame has. A hidden tab draws no frames, so it is flushed on
// hiding instead (main.js), and flush() writes whatever is pending at once.
let writeDue = false;
function saveDue() {
  saveTimer = null;
  const wait = SAVE_DELAY_MS - (Date.now() - lastSaveCall);
  if (wait > 4) { saveTimer = setTimeout(saveDue, wait); return; }
  if (hidden) { writeNow(); return; }
  writeDue = true;
}
export function writeDueAfterFrame() {
  if (!writeDue) return;
  writeDue = false;
  writeNow();
}

export function save() {
  if (applyingRemote) return;
  dirtyShared = dirtyExtra = true;
  lastSaveCall = Date.now();
  if (hidden) { clearTimeout(saveTimer); saveTimer = null; return; }
  if (!saveTimer) saveTimer = setTimeout(saveDue, SAVE_DELAY_MS);
}

// Writes whatever this tab has changed and not yet written, now. Nothing
// pending means nothing written: a tab that is only being switched away from
// has no business rewriting the file with the copy it already wrote.
export function flush() {
  writeDue = false;
  writeNow();
  writeKeysNow();
  writeUiNow();
}

// The platform's visibility, handed in by main.js. A hidden tab draws no
// frames, so the only saves it can still make are timers left over from
// before (the atmosphere drift's trailing save); those are held until the
// tab is seen again, and by then a write from another tab may already have
// cleared them (see syncFromStorage). main.js flushes before hiding, so the
// viewer's own last change in this tab is written before the hold begins.
export function setHidden(h) {
  hidden = !!h;
  if (!hidden && (dirtyShared || dirtyExtra) && !saveTimer) {
    saveTimer = setTimeout(writeNow, SAVE_DELAY_MS);
  }
}

// Another v1 tab has written one of the two records: take it into
// this tab's S so the two agree, and so this tab's next write carries the
// newer values instead of undoing them. `value` is the new JSON string, or
// null when the key was removed (nothing to apply then). `replay` is
// presets.js's replayLive, which runs the apply and then re-sets every
// control whose position moved, so running audio and the scene follow the
// change exactly as they do when a preset is recalled mid-session; without
// it the state lands silently, as it does at boot. The shared object goes
// through applySettings in live mode (the drawer's open state and the audio
// switch stay this tab's own), the extra record through applyExtra.
//
// The atmosphere's levels are merged into this tab's existing layer objects
// rather than replacing the array: the ambience engine keys its voices by
// layer object, so a fresh array would fade every recording out and back in
// on each incoming drift save. Merged in place, the gains just glide.
//
// A shared object without v1's writer stamp came from a v0 tab and is not
// applied (see the note at the top of this file). This tab's state stays as
// the viewer set it, and the shared record is marked unwritten, so the next
// write this tab makes anyway (the viewer's next change, the flush on
// hiding, the return to view) puts it back. Nothing is written in answer
// right away: a v0 tab's drift saves arrive every couple of seconds, and
// replying to each would only turn two tabs into a pair taking turns at the
// disk. A stamp carrying this tab's own id is ignored as well.
//
// Returns true when the key was one of these two, whatever came of it, so
// the caller knows not to offer it to anyone else.
export function syncFromStorage(key, value, replay) {
  if (key !== STORE && key !== EXTRA_KEY) return false;
  if (typeof value !== 'string') return true;
  let obj;
  try { obj = JSON.parse(value); } catch (e) { return true; }
  if (!obj || typeof obj !== 'object') return true;
  if (key === STORE) {
    const stamp = typeof obj[WRITER_KEY] === 'string' ? obj[WRITER_KEY] : '';
    if (!stamp) {
      dirtyShared = true;
      if (!v0Noted) {
        v0Noted = true;
        console.info('[store] ignored a settings write from a v0 tab (no v1 stamp); this tab keeps its own settings and will write them back');
      }
      return true;
    }
    if (stamp.split(':')[0] === TAB_ID) return true;
  }
  if (key === STORE) dirtyShared = false; else dirtyExtra = false;
  if (!dirtyShared && !dirtyExtra) { clearTimeout(saveTimer); saveTimer = null; }
  let levelsMoved = false;
  const apply = key === STORE
    ? () => { levelsMoved = mergeAmbLevels(obj.ambLayers) || levelsMoved; applySettings(obj, true); }
    : () => applyExtra(obj);
  applyingRemote = true;
  try {
    if (replay) replay(apply); else apply();
    if (levelsMoved) syncAmbLayers();
  } finally {
    applyingRemote = false;
  }
  return true;
}

// Copies incoming atmosphere levels onto the layer objects already in
// S.ambLayers, when both lists name the same sources in the same order
// (they always do once normalised, short of a library change between
// builds). Returns whether any level, mute or solo actually changed. When
// the shapes differ it leaves everything alone and applySettings replaces
// the array as it would for a preset.
function mergeAmbLevels(arr) {
  if (!Array.isArray(arr)) return false;
  const cur = S.ambLayers;
  const next = normalizeAmbLayers(arr);
  if (!Array.isArray(cur) || cur.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) if (!cur[i] || cur[i].source !== next[i].source) return false;
  let moved = false;
  for (let i = 0; i < next.length; i++) {
    const a = cur[i], b = next[i];
    if (a.level !== b.level || a.peak !== b.peak || a.muted !== b.muted || a.solo !== b.solo) {
      a.level = b.level; a.peak = b.peak; a.muted = b.muted; a.solo = b.solo;
      moved = true;
    }
  }
  return moved;
}

// UI-only state: which drawer sections were left open, and anything else of
// that kind later. It is how the interface was arranged, not how the session
// looks or sounds, so it is not a setting: it stays out of the shared v0
// object, out of the v1 extra record, and out of preset snapshots, under a
// key of its own. Written on the same debounce as save(), and by flush().
const UI_KEY = 'signal.v1.ui';
let uiPending = null;
let uiTimer = null;

// The saved UI state object, or null when there is none (or it is unreadable).
export function loadUiState() {
  if (!storage) return null;
  try {
    const o = JSON.parse(storage.get(UI_KEY) || 'null');
    return o && typeof o === 'object' ? o : null;
  } catch (e) { return null; }
}

// Merges rather than replaces: the drawer writes its open sections and the
// mixer its window, each under a key of its own, and neither should wipe
// the other's. The first write after a flush starts from what is on disk.
export function saveUiState(obj) {
  if (uiPending === null) uiPending = loadUiState() || {};
  for (const k in obj) uiPending[k] = obj[k];
  clearTimeout(uiTimer);
  uiTimer = setTimeout(writeUiNow, SAVE_DELAY_MS);
}

function writeUiNow() {
  clearTimeout(uiTimer);
  if (!storage || uiPending === null) return;
  try { storage.set(UI_KEY, JSON.stringify(uiPending)); } catch (e) { /* same as writeNow: carry on without persistence */ }
  uiPending = null;
}

// A preset is the settings object exactly as save() writes it, so a saved
// preset and a saved session are the same thing and can never drift apart
// in shape. buildSettings() hands back live references (layers, textThemes,
// ambLayers), which is fine for a write that serialises immediately but not
// for a snapshot that has to stay put while the viewer keeps playing, so this
// takes a deep copy through JSON, the same round trip the file itself makes.
// The v1-only state rides along under v1extra, so a preset saved in v1
// recalls the flowers and the kaleidoscope too.
export function snapshot() {
  const snap = JSON.parse(JSON.stringify(buildSettings()));
  snap.v1extra = JSON.parse(JSON.stringify(buildExtra()));
  return snap;
}

// Applies a snapshot into S while the session runs. This sets state only,
// through the same code load() uses; the caller (presets.js) is what replays
// the changes through the schema so audio and the scene hear about them,
// since this module must not depend on the schema that depends on it. (The
// one exception is the plain state helpers in schema-flowers.js and
// schema-kaleido.js, which touch S and nothing else.) A snapshot from before
// v1extra existed leaves the flowers and the kaleidoscope exactly as they
// are.
export function applySnapshot(obj) {
  if (!obj || typeof obj !== 'object') return;
  applySettings(obj, true);
  applyExtra(obj.v1extra);
  save();
}

// Other small JSON records (the user's presets) go through the same storage
// object under their own keys. Writes are deferred out of the frame that
// asked for them, per the frame-timing rule, and collapse if several land
// together; flush() above writes anything still pending.
const pendingKeys = new Map();
let keysTimer = null;

export function readKey(key) {
  if (!storage) return null;
  try { return storage.get(key); } catch (e) { return null; }
}

export function saveKey(key, obj) {
  pendingKeys.set(key, obj);
  clearTimeout(keysTimer);
  keysTimer = setTimeout(writeKeysNow, 60);
}

function writeKeysNow() {
  clearTimeout(keysTimer);
  if (!storage || !pendingKeys.size) return;
  for (const [key, obj] of pendingKeys) {
    try { storage.set(key, JSON.stringify(obj)); } catch (e) { /* same as writeNow: carry on without persistence */ }
  }
  pendingKeys.clear();
}

// The v0 hue-band buttons derive their own label from hueLo/hueSpan rather
// than storing a name, so load() does the same derivation the schema's Hue
// range control uses. Duplicated in both places on purpose: the schema needs
// it to answer format(S), the store never needs the label at all and only
// restores the two numbers, so there is nothing here actually worth sharing.

export function load() {
  // v1-only defaults first, since js/state.js (v0's file) does not know
  // about them: the GPU reads these fields from the very first frame, stored
  // session or not.
  initFlowerState(S);
  initKaleidoState(S);
  initParticleState(S);
  initFireworkState(S);
  if (!storage) return;
  let s;
  try { s = JSON.parse(storage.get(STORE) || '{}'); } catch (e) { s = {}; }
  // A first visit has nothing stored. v0 leaves every S default as the
  // markup already ships it and just keeps the drawer shut; the drawer is
  // the toolkit's concern now, so all that is left to say is "closed".
  if (!s || !Object.keys(s).length) S.panelOpen = false;
  else applySettings(s, false);
  // Read separately and after, so the extra record wins over anything the
  // shared object might carry, and so a v1 record survives a v0 session
  // that rewrote the shared one in between.
  let x;
  try { x = JSON.parse(storage.get(EXTRA_KEY) || 'null'); } catch (e) { x = null; }
  applyExtra(x);
}

// The body of load(), shared with applySnapshot(). `live` is true when a
// preset is being recalled mid-session rather than a saved session restored
// at boot, and changes three things. The drawer's open state and the audio
// switch are left alone, because a preset describes how the session looks
// and sounds, not whether the settings pane is showing or the sound is on.
// And the atmosphere's layer list is only replaced when it actually differs,
// because the ambience engine keys its playing voices by layer object: a
// fresh but identical array would fade every recording out and back in.
function applySettings(s, live) {
  if (typeof s.freq === 'number')   S.freq = s.freq;
  if (typeof s.depth === 'number')  S.depth = s.depth;
  if (typeof s.bright === 'number') S.bright = s.bright;
  if (s.color) setColorFromPicker(s.color);
  if (typeof s.ringSpeedMul === 'number') S.ringSpeedMul = s.ringSpeedMul;
  if (typeof s.ringFade === 'number')     S.ringFade = s.ringFade;
  if (typeof s.fieldFade === 'number')    S.fieldFade = s.fieldFade;
  if (typeof s.fieldSoft === 'number')    S.fieldSoft = s.fieldSoft;
  if (typeof s.edgeCount === 'number')    S.edgeCount = s.edgeCount;
  if (typeof s.edgeOpacity === 'number')  S.edgeOpacity = s.edgeOpacity;
  if (typeof s.edgeSize === 'number')     S.edgeSize = s.edgeSize;
  if (s.edgeCap === 'wedge' || s.edgeCap === 'round' || s.edgeCap === 'ball') S.edgeCap = s.edgeCap;
  if (typeof s.trailMul === 'number')     S.trailMul = s.trailMul;
  if (typeof s.edgeSpeedMul === 'number') S.edgeSpeedMul = s.edgeSpeedMul;
  if (typeof s.frameLock === 'boolean') S.frameLock = s.frameLock;
  // Anything else saved here (an old 'alt') falls through to the default.
  if (s.spareMode === 'lit' || s.spareMode === 'dark') S.spareMode = s.spareMode;
  if (typeof s.freqDrift === 'number')    S.freqDrift = s.freqDrift;
  if (typeof s.freqDriftOn === 'boolean') S.freqDriftOn = s.freqDriftOn;
  if (typeof s.driftPeriod === 'number')  S.driftPeriod = s.driftPeriod;
  if (typeof s.depthVar === 'number')     S.depthVar = s.depthVar;
  if (typeof s.depthVarOn === 'boolean')  S.depthVarOn = s.depthVarOn;
  if (typeof s.varPeriod === 'number')    S.varPeriod = s.varPeriod;
  if (typeof s.brightVar === 'number')    S.brightVar = s.brightVar;
  if (typeof s.brightVarOn === 'boolean') S.brightVarOn = s.brightVarOn;
  if (typeof s.brightVarPeriod === 'number') S.brightVarPeriod = s.brightVarPeriod;
  if (typeof s.colorWalk === 'number')    S.colorWalk = s.colorWalk;
  if (typeof s.hueLo === 'number')   S.hueLo = s.hueLo;
  if (typeof s.hueSpan === 'number') S.hueSpan = s.hueSpan;
  if (typeof s.walkPeriod === 'number')   S.walkPeriod = s.walkPeriod;
  if (typeof s.perElementColor === 'boolean') S.perElementColor = s.perElementColor;
  if (typeof s.colorMode === 'string') {
    // 'single' was retired when the corner cycle became rotating / multi / magenta.
    S.colorMode = s.colorMode === 'single' ? 'magenta' : s.colorMode;
  }
  if (typeof s.ringThick === 'number')    S.ringThick = s.ringThick;
  if (typeof s.ringThickVar === 'number') S.ringThickVar = s.ringThickVar;
  if (typeof s.ringBrightVar === 'number')    S.ringBrightVar = s.ringBrightVar;
  if (typeof s.ringBrightPeriod === 'number') S.ringBrightPeriod = s.ringBrightPeriod;
  if (typeof s.edgeSpeedVar === 'number')       S.edgeSpeedVar = s.edgeSpeedVar;
  if (typeof s.edgeSpeedVarPeriod === 'number') S.edgeSpeedVarPeriod = s.edgeSpeedVarPeriod;
  if (typeof s.edgeSizeVar === 'number')        S.edgeSizeVar = s.edgeSizeVar;
  if (typeof s.edgeSizeVarPeriod === 'number')  S.edgeSizeVarPeriod = s.edgeSizeVarPeriod;
  if (!live) S.panelOpen = !!s.panelOpen;
  if (s.edgeDir) { S.edgeDir = s.edgeDir; applyEdgeDir(); }
  if (typeof s.carrierHz === 'number')    S.carrierHz = s.carrierHz;
  if (typeof s.amRate === 'number')       S.amRate = s.amRate;
  if (typeof s.amLinked === 'boolean')    S.amLinked = s.amLinked;
  if (typeof s.volume === 'number')       S.volume = s.volume;

  if (s.wave) S.wave = s.wave;
  if (s.fieldShape) S.fieldShape = s.fieldShape;
  // The GPU backends were an A/B against Canvas2D in v0; v1 has only the one
  // WebGPU path, so the preference is restored for round-trip fidelity (a
  // save from v0 must read back unchanged) but nothing in v1 branches on it.
  if (s.rendererPref) S.rendererPref = s.rendererPref;

  if (s.layers) Object.assign(layers, s.layers);

  if (typeof s.textLinked === 'boolean') S.textLinked = s.textLinked;
  if (typeof s.textRateHz === 'number')  S.textRateHz = s.textRateHz;
  if (typeof s.textFreq === 'number')    S.textFreq = s.textFreq;
  if (typeof s.textRandom === 'number')  S.textRandom = s.textRandom;
  if (typeof s.textDwellMs === 'number') S.textDwellMs = s.textDwellMs;
  // one fade slider became two; an old save seeds both from the single value
  if (typeof s.textFadeMs === 'number') { S.textFadeInMs = S.textFadeOutMs = s.textFadeMs; }
  if (typeof s.textFadeInMs === 'number')  S.textFadeInMs = s.textFadeInMs;
  if (typeof s.textFadeOutMs === 'number') S.textFadeOutMs = s.textFadeOutMs;
  for (const k of ['textFadeInVar', 'textFadeOutVar']) {
    if (typeof s[k] === 'number') S[k] = s[k];
  }
  if (typeof s.textSize === 'number')    S.textSize = s.textSize;
  if (typeof s.textRestFreq === 'number') S.textRestFreq = s.textRestFreq;
  if (typeof s.textRestSec === 'number')  S.textRestSec = s.textRestSec;
  if (typeof s.textRestVar === 'number')  S.textRestVar = s.textRestVar;
  if (typeof s.textOpacity === 'number')    S.textOpacity = s.textOpacity;
  if (typeof s.textOpacityVar === 'number') S.textOpacityVar = s.textOpacityVar;
  if (typeof s.textOpacityVarPeriod === 'number') S.textOpacityVarPeriod = s.textOpacityVarPeriod;
  if (typeof s.textBrighten === 'number') S.textBrighten = s.textBrighten;
  if (s.textColorMode === 'white' || s.textColorMode === 'system') S.textColorMode = s.textColorMode;
  if (s.textThemes && typeof s.textThemes === 'object') S.textThemes = { ...s.textThemes };
  if (s.textMode === 'words' || s.textMode === 'affirmations') S.textMode = s.textMode;
  if (typeof s.textLineWidth === 'number') S.textLineWidth = s.textLineWidth;
  if (typeof s.textSmartBreaks === 'boolean') S.textSmartBreaks = s.textSmartBreaks;
  if (typeof s.textLinesTogether === 'boolean') S.textLinesTogether = s.textLinesTogether;
  if (typeof s.textLinesTogetherOut === 'boolean') S.textLinesTogetherOut = s.textLinesTogetherOut;

  // music and ambience
  if (typeof s.musicOn === 'boolean') S.musicOn = s.musicOn;
  if (typeof s.cloudsOn === 'boolean') S.cloudsOn = s.cloudsOn;
  if (s.pianoStyle === 'generative' || s.pianoStyle === 'snippets') S.pianoStyle = s.pianoStyle;
  if (typeof s.ambOn   === 'boolean') S.ambOn   = s.ambOn;
  if (typeof s.ambDrift === 'boolean') S.ambDrift = s.ambDrift;
  if (Array.isArray(s.ambLayers)) {
    const next = normalizeAmbLayers(s.ambLayers);
    if (!live || JSON.stringify(next) !== JSON.stringify(S.ambLayers)) S.ambLayers = next;
  }
  // cloudRevTime is v0's list too (js/settings.js); it was missing here, so a
  // saved clouds reverb decay never came back after a reload.
  ['pianoVol','bedVol','pianoReverb','pianoRevTime','pianoHP','arpVol','arpRate','arpAtk','arpDec','arpOct','arpRev','arpSpread','arpStrobeAm','arpSwLo','arpSwHi','arpSwPeriod','arpSwWander','pianoDensity','pianoCentre',
   'pianoSpread','pianoHold','pianoBass','ambVol','ambReverb','ambRevTime','ambDriftFadeS',
   'cloudVol','cloudDensity','cloudPhrase','cloudReverb','cloudRevTime'].forEach(k => {
    if (typeof s[k] === 'number') S[k] = s[k];
  });

  // migrate the older exclusive setting if it is still on disk
  if (s.audioShape) { S.toneOn = s.audioShape === 'tone'; S.clickOn = s.audioShape === 'clicks'; }
  if (typeof s.harmOn === 'boolean') S.harmOn = s.harmOn;
  if (typeof s.harmVol === 'number') S.harmVol = s.harmVol;
  if (typeof s.harmCount === 'number')   S.harmCount = s.harmCount;
  if (typeof s.harmBright === 'number') {
    // stored values above 1 are from the old 0.1-4 rolloff scale, before the
    // slider became a 0-1 brightness; they would send a negative exponent
    S.harmBright = s.harmBright > 1 ? 0.7 : s.harmBright;
  }
  if (typeof s.harmSpread === 'number')  S.harmSpread = s.harmSpread;
  if (typeof s.harmPanRate === 'number') S.harmPanRate = s.harmPanRate;
  if (typeof s.biDepth === 'number')  S.biDepth = s.biDepth;
  if (typeof s.biPeriod === 'number') S.biPeriod = s.biPeriod;
  if (typeof s.biHardSwitch === 'boolean') S.biHardSwitch = s.biHardSwitch;
  if (typeof s.clickModDepth === 'number')  S.clickModDepth  = s.clickModDepth;
  if (typeof s.clickModPeriod === 'number') S.clickModPeriod = s.clickModPeriod;
  if (typeof s.clickRevTime === 'number')   S.clickRevTime   = s.clickRevTime;
  if (typeof s.clickReverb === 'number')    S.clickReverb    = s.clickReverb;
  if (typeof s.clickVol === 'number')       S.clickVol       = s.clickVol;
  if (typeof s.chirpModDepth === 'number')  S.chirpModDepth  = s.chirpModDepth;
  if (typeof s.chirpModPeriod === 'number') S.chirpModPeriod = s.chirpModPeriod;
  if (typeof s.pipLpfOn === 'boolean')     S.pipLpfOn     = s.pipLpfOn;
  for (const k of ['pipLpfLo','pipLpfHi','pipLpfPeriod','pipLpfQ','pipLpfWander'])
    if (typeof s[k] === 'number') S[k] = s[k];
  if (typeof s.bedLpfOn === 'boolean')  S.bedLpfOn  = s.bedLpfOn;
  if (typeof s.bedVerbOn === 'boolean') S.bedVerbOn = s.bedVerbOn;
  if (typeof s.bedRevOn === 'boolean') S.bedRevOn = s.bedRevOn;
  if (typeof s.arpOn === 'boolean') S.arpOn = s.arpOn;
  if (typeof s.musicRevOn === 'boolean') S.musicRevOn = s.musicRevOn;
  if (typeof s.bedOn === 'boolean') S.bedOn = s.bedOn;
  if (typeof s.pianoOn === 'boolean') S.pianoOn = s.pianoOn;
  if (typeof s.arpSwOn === 'boolean') S.arpSwOn = s.arpSwOn;
  if (['sine', 'triangle', 'sawtooth', 'square'].includes(s.arpWave)) S.arpWave = s.arpWave;
  if (typeof s.bedRevLevel === 'number') S.bedRevLevel = s.bedRevLevel;
  for (const k of ['bedLpfLo','bedLpfHi','bedLpfPeriod','bedLpfQ','bedLpfWander','bedLpfSlope','bedDetune',
                   'bedVerbLo','bedVerbHi','bedVerbPeriod','bedVerbWander'])
    if (typeof s[k] === 'number') S[k] = s[k];
  if (typeof s.shimDepth === 'number') S.shimDepth = s.shimDepth;
  if (typeof s.shimRate === 'number')  S.shimRate = s.shimRate;
  if (typeof s.harmReverb === 'number')  S.harmReverb = s.harmReverb;
  if (typeof s.pipMs === 'number') S.pipMs = s.pipMs;
  if (typeof s.toneVol  === 'number') S.toneVol  = s.toneVol;
  if (typeof s.toneOn  === 'boolean') S.toneOn  = s.toneOn;
  if (typeof s.clickOn === 'boolean') S.clickOn = s.clickOn;
  if (typeof s.chirpLowHz === 'number')  S.chirpLowHz = s.chirpLowHz;
  if (typeof s.chirpHighHz === 'number') S.chirpHighHz = s.chirpHighHz;
  if (typeof s.chirpComp === 'number')   S.chirpComp = s.chirpComp;
  if (typeof s.chirpTilt === 'number')   S.chirpTilt = s.chirpTilt;
  if (typeof s.chirpVol === 'number')     S.chirpVol = s.chirpVol;
  if (typeof s.chirpReverb === 'number')  S.chirpReverb = s.chirpReverb;
  if (typeof s.chirpRevTime === 'number') S.chirpRevTime = s.chirpRevTime;
  if (typeof s.biOn === 'boolean') S.biOn = s.biOn;
  if (s.clickMode === 'click' || s.clickMode === 'chirp') S.clickMode = s.clickMode;
  if (typeof s.pipTrimDb === 'number') S.pipTrimDb = s.pipTrimDb;
  S.amLinked = !!s.amLinked;

  // v0 restores this straight onto the <input id=lAudio> checkbox and leaves
  // it there for a user gesture to act on later; v1 has no checkbox, so the
  // same boolean is parked on S itself under the same name, for whichever
  // lane wires the audio layer's boot behaviour to read.
  // v0 only ever checks the box here, never clears it, and the box starts
  // checked, so every page load boots with audio on and the first Space
  // brings sound. A saved false is therefore not restored, same as v0.
  if (!live && s.audioOnBoot) S.audioOnBoot = true;
}
