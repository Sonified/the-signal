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

import { S, layers, STORE, SKIP_KEY, seqSeat, CORNER_TYPES } from '../js/state.js';
import { setColorFromPicker } from '../js/color.js';
import { applyEdgeDir } from '../js/sim.js';
import { normalizeAmbLayers, syncAmbLayers } from '../js/ambience.js';
import { CHANNELS, applyMixGates } from '../js/mixgate.js';
import { MUSIC_LAYERS, layerOnKey, layerVolKey } from '../js/layer-defs.js';
// A cycle (schema-flowers.js and schema-kaleido.js import save() from here),
// but a harmless one: neither side calls into the other while it is being
// evaluated, only later, from load() and from a control's set().
import { initFlowerState, flowerStateOf, applyFlowerState } from './schema-flowers.js';
import { initKaleidoState, kaleidoStateOf, applyKaleidoState } from './schema-kaleido.js';
import { initParticleState, particleStateOf, applyParticleState } from './schema-particles.js';
import { initFireworkState, fireworkStateOf, applyFireworkState } from './schema-fireworks.js';
import { initConfettiState, confettiStateOf, applyConfettiState } from './schema-confetti.js';
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

// The music layers' switches and levels (js/layer-defs.js): <id>On, <id>Vol.
function layerSettings() {
  const o = {};
  for (const L of MUSIC_LAYERS) { o[layerOnKey(L)] = S[layerOnKey(L)]; o[layerVolKey(L)] = S[layerVolKey(L)]; }
  return o;
}

function buildSettings() {
  return {
    freq: S.freq, depth: S.depth, bright: S.bright, strobeScale: S.strobeScale, wave: S.wave, fieldShape: S.fieldShape,
    fieldOpacity: S.fieldOpacity, fieldFade: S.fieldFade, fieldSoft: S.fieldSoft,
    fieldFadeVar: S.fieldFadeVar, fieldFadeVarPeriod: S.fieldFadeVarPeriod,
    color: rgbHex(S.rgb),
    cornerOpacity: S.cornerOpacity, cornerOpacityVar: S.cornerOpacityVar, cornerOpacityVarPeriod: S.cornerOpacityVarPeriod, cornerSpeed: S.cornerSpeed, cornerPulse: S.cornerPulse, cornerSize: S.cornerSize, cornerType: S.cornerType,
    ringSpeed5: S.ringSpeedMul, ringSpeedVar: S.ringSpeedVar, ringSpeedVarPeriod: S.ringSpeedVarPeriod,
    ringRate: S.ringRate, ringOrigin: S.ringOrigin, ringFadeInMs: S.ringFadeInMs, ringOpacity: S.ringOpacity, ringPulse: S.ringPulse, ringFade: S.ringFade, ringThick: S.ringThick, ringThickVar: S.ringThickVar, edgeCount: S.edgeCount,
    edgeSize: S.edgeSize, edgeCap: S.edgeCap, edgeOpacity: S.edgeOpacity, edgeOpacityVar: S.edgeOpacityVar, edgeOpacityVarPeriod: S.edgeOpacityVarPeriod, trailMul: S.trailMul, edgeSpeedMul: S.edgeSpeedMul,
    edgeFb: S.edgeFb, edgeFbStream: S.edgeFbStream, edgeFbTwist: S.edgeFbTwist, edgeFbOpacity: S.edgeFbOpacity,
    edgeMode: S.edgeMode, edgePulse: S.edgePulse, edgePulseVar: S.edgePulseVar, edgePulseVarPeriod: S.edgePulseVarPeriod,
    edgePartRate: S.edgePartRate, edgePartSize: S.edgePartSize, edgePartDrift: S.edgePartDrift, edgePartSparkle: S.edgePartSparkle,
    edgeFlameHeight: S.edgeFlameHeight, edgeFlameSpeed: S.edgeFlameSpeed, edgeFlameTurb: S.edgeFlameTurb,
    edgeGlowWidth: S.edgeGlowWidth, edgeGlowSoft: S.edgeGlowSoft, edgeGlowBreathe: S.edgeGlowBreathe, edgeGlowBreatheRate: S.edgeGlowBreatheRate,
    edgeDir: S.edgeDir, layers: sharedLayers(),
    textLinked: S.textLinked, textRateHz: S.textRateHz, textFreq: S.textFreq,
    textRandom: S.textRandom, textDwellMs: S.textDwellMs, textDwellVar: S.textDwellVar,
    textFadeInMs: S.textFadeInMs, textFadeOutMs: S.textFadeOutMs,
    textAppearMode: S.textAppearMode, textAppearPerMin: S.textAppearPerMin,
    textFadeInVar: S.textFadeInVar, textFadeOutVar: S.textFadeOutVar,
    textSize: S.textSize, textThemes: S.textThemes, textMode: S.textMode, textLineWidth: S.textLineWidth,
    textSmartBreaks: S.textSmartBreaks,
    textLinesTogether: S.textLinesTogether, textLinesTogetherIn: S.textLinesTogetherIn, textLinesTogetherOut: S.textLinesTogetherOut,
    textLinePause: S.textLinePause,
    textOpacity: S.textOpacity, textOpacityVar: S.textOpacityVar,
    textOpacityVarPeriod: S.textOpacityVarPeriod, textOpacityVarPeriodOff: S.textOpacityVarPeriodOff || 0,
    textBrighten: S.textBrighten,
    textShadowO: S.textShadowO || 0, textShadowBlur: S.textShadowBlur || 0, textPanelO: S.textPanelO || 0,
    textShadowSize: S.textShadowSize || 0, textPanelSize: S.textPanelSize ?? 1,
    textPanelSoft: S.textPanelSoft || 0, textShadowOn: S.textShadowOn !== false,
    textPanelPerLine: S.textPanelPerLine === true, textPanelOn: S.textPanelOn !== false,
    textShadowFadeInMs: S.textShadowFadeInMs || 0, textShadowFadeOutMs: S.textShadowFadeOutMs || 0,
    textPanelFadeInMs: S.textPanelFadeInMs || 0, textPanelFadeOutMs: S.textPanelFadeOutMs || 0,
    textColorMode: S.textColorMode,
    musicOn: S.musicOn, pianoStyle: S.pianoStyle, pianoVol: S.pianoVol, bedVol: S.bedVol,
    bedLpfOn: S.bedLpfOn, bedLpfLo: S.bedLpfLo, bedLpfHi: S.bedLpfHi, bedLpfPeriod: S.bedLpfPeriod,
    bedLpfQ: S.bedLpfQ, bedLpfWander: S.bedLpfWander, bedLpfSlope: S.bedLpfSlope, bedDetune: S.bedDetune,
    bedRevOn: S.bedRevOn, bedRevLevel: S.bedRevLevel, bedVerbOn: S.bedVerbOn, bedVerbLo: S.bedVerbLo, bedVerbHi: S.bedVerbHi, bedVerbPeriod: S.bedVerbPeriod,
    bedVerbWander: S.bedVerbWander,
    choirOn: S.choirOn, choirVol: S.choirVol, choirStack: S.choirStack, choirDensity: S.choirDensity,
    choirBrightness: S.choirBrightness, choirFocus: S.choirFocus,
    choirStackVar: S.choirStackVar, choirStackPeriod: S.choirStackPeriod,
    choirDensityVar: S.choirDensityVar, choirDensityPeriod: S.choirDensityPeriod,
    choirVolVar: S.choirVolVar, choirVolPeriod: S.choirVolPeriod,
    choirVolVarMode: S.choirVolVarMode, choirStackVarMode: S.choirStackVarMode,
    choirDensityVarMode: S.choirDensityVarMode, choirStrobeAmVarMode: S.choirStrobeAmVarMode,
    bedStrobeAmVarMode: S.bedStrobeAmVarMode,
    ...layerSettings(),
    bedStrobeAm: S.bedStrobeAm, choirStrobeAm: S.choirStrobeAm, cloudStrobeAm: S.cloudStrobeAm,
    choirStrobeAmVar: S.choirStrobeAmVar, choirStrobeAmPeriod: S.choirStrobeAmPeriod,
    bedStrobeAmVar: S.bedStrobeAmVar, bedStrobeAmPeriod: S.bedStrobeAmPeriod,
    pianoReverb: S.pianoReverb, pianoRevTime: S.pianoRevTime, pianoHP: S.pianoHP, musicRevOn: S.musicRevOn, bedOn: S.bedOn, pianoOn: S.pianoOn, arpOn: S.arpOn, arpVol: S.arpVol, arpRate: S.arpRate,
    arpVolVar: S.arpVolVar, arpVolPeriod: S.arpVolPeriod,
    pianoReverbVar: S.pianoReverbVar, pianoReverbPeriod: S.pianoReverbPeriod,
    pianoRevTimeVar: S.pianoRevTimeVar, pianoRevTimePeriod: S.pianoRevTimePeriod,
    musicRevType: S.musicRevType, phoneRevType: S.phoneRevType, pianoRevDamp: S.pianoRevDamp, pianoRevMod: S.pianoRevMod,
    arpStrobeAmVar: S.arpStrobeAmVar, arpStrobeAmPeriod: S.arpStrobeAmPeriod, arpWave: S.arpWave, arpAtk: S.arpAtk, arpDec: S.arpDec, arpOct: S.arpOct, arpRev: S.arpRev, arpSpread: S.arpSpread, arpStrobeAm: S.arpStrobeAm,
    arpHfCut: S.arpHfCut,
      arpSwOn: S.arpSwOn, arpSwLo: S.arpSwLo, arpSwHi: S.arpSwHi, arpSwPeriod: S.arpSwPeriod, arpSwWander: S.arpSwWander,
    pianoDensity: S.pianoDensity, pianoCentre: S.pianoCentre,
    pianoSpread: S.pianoSpread, pianoHold: S.pianoHold, pianoBass: S.pianoBass,
    cloudsOn: S.cloudsOn, cloudVol: S.cloudVol, cloudDensity: S.cloudDensity,
    cloudPhrase: S.cloudPhrase, cloudReverb: S.cloudReverb,
    ambOn: S.ambOn, ambVol: S.ambVol, ambDrift: S.ambDrift, ambDriftFadeS: S.ambDriftFadeS, ambKidsFreq: S.ambKidsFreq,
    ambReverb: S.ambReverb, ambRevTime: S.ambRevTime, ambRevType: S.ambRevType, ambRevDamp: S.ambRevDamp, ambRevMod: S.ambRevMod,
    ambReverbVar: S.ambReverbVar, ambReverbPeriod: S.ambReverbPeriod, ambRevTimeVar: S.ambRevTimeVar, ambRevTimePeriod: S.ambRevTimePeriod,
    ambLayers: S.ambLayers,
    pipTrimDb: S.pipTrimDb, biOn: S.biOn, chirpVol: S.chirpVol, chirpReverb: S.chirpReverb, chirpRevTime: S.chirpRevTime,
    chirpModDepth: S.chirpModDepth, chirpModPeriod: S.chirpModPeriod,
    clickMode: S.clickMode, chirpLowHz: S.chirpLowHz, chirpHighHz: S.chirpHighHz,
    chirpComp: S.chirpComp, chirpTilt: S.chirpTilt,
    pipLpfOn: S.pipLpfOn, pipLpfLo: S.pipLpfLo, pipLpfHi: S.pipLpfHi, pipLpfPeriod: S.pipLpfPeriod,
    pipLpfQ: S.pipLpfQ, pipLpfWander: S.pipLpfWander,
    textRestFreq: S.textRestFreq, textRestSec: S.textRestSec, textRestVar: S.textRestVar,
    depthVar: S.depthVar, varPeriod: S.varPeriod, panelOpen: S.panelOpen,
    freqDrift: S.freqDrift, freqDriftOn: S.freqDriftOn, driftPeriod: S.driftPeriod, perElementColor: S.perElementColor, colorMode: S.colorMode,
    frameLock: S.frameLock, spareMode: S.spareMode, pauseWindDown: S.pauseWindDown, pauseFlickerStop: S.pauseFlickerStop !== false,
    hintFadeMs: S.hintFadeMs, hintSweep: S.hintSweep, hintFadeInMs: S.hintFadeInMs, hintArrive: S.hintArrive,
    fbResScale: S.fbResScale, fbResSwitch: S.fbResSwitch,
    parallaxAmount: S.parallaxAmount, parallaxSpeed: S.parallaxSpeed, walkPeriod: S.walkPeriod, brightVar: S.brightVar,
    skipRiskBand: S.skipRiskBand !== false,
    brightVarPeriod: S.brightVarPeriod, colorWalk: S.colorWalk,
    hueLo: S.hueLo, hueSpan: S.hueSpan,
    ringBrightVar: S.ringBrightVar, ringBrightPeriod: S.ringBrightPeriod,
    edgeSpeedVar: S.edgeSpeedVar, edgeSpeedVarPeriod: S.edgeSpeedVarPeriod,
    edgeSizeVar: S.edgeSizeVar, edgeSizeVarPeriod: S.edgeSizeVarPeriod,
    carrierHz: S.carrierHz, amRate: S.amRate, volume: S.volume, amLinked: S.amLinked, amModOn: S.amModOn,
    toneStrobeAm: S.toneStrobeAm,
    toneVolVar: S.toneVolVar, toneVolPeriod: S.toneVolPeriod,
    toneStrobeAmVar: S.toneStrobeAmVar, toneStrobeAmPeriod: S.toneStrobeAmPeriod,
    toneOn: S.toneOn, clickOn: S.clickOn, toneVol: S.toneVol, clickVol: S.clickVol, pipMs: S.pipMs,
    // the Music window's trims over those levels (state.js)
    musTone: S.musTone, musPulse: S.musPulse, musPiano: S.musPiano, musClouds: S.musClouds,
    musDrone: S.musDrone, musArp: S.musArp, musChoir: S.musChoir, musAmb: S.musAmb,
    harmOn: S.harmOn, harmVol: S.harmVol, harmCount: S.harmCount, harmBright: S.harmBright,
    harmSpread: S.harmSpread, harmPanRate: S.harmPanRate, harmReverb: S.harmReverb,
    shimDepth: S.shimDepth, shimRate: S.shimRate, clickReverb: S.clickReverb,
    clickRevTime: S.clickRevTime, clickModDepth: S.clickModDepth, clickModPeriod: S.clickModPeriod,
    biDepth: S.biDepth, biPeriod: S.biPeriod, biHardSwitch: S.biHardSwitch,
    rendererPref: S.rendererPref, heartLookaheadS: S.heartLookaheadS, heartGrowX: S.heartGrowX, outputLatComp: S.outputLatComp,
    syncDiagLog: S.syncDiagLog,
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
  for (const k in layers) if (k !== 'flowers' && k !== 'kaleido' && k !== 'particles' && k !== 'fireworks' && k !== 'confetti') out[k] = layers[k];
  return out;
}

// The six fixed mixer channels' mute and solo flags (js/mixgate.js) ride in
// this record too: v0 never shows them, so they stay out of the shared file
// the same way the v1 layers do. Copied, not referenced, so a snapshot holds
// still while the viewer keeps pressing buttons.
export function mixStateOf(s) {
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

// The sequencer's eight lines and which one is active (js/piano.js), v1
// only, so they ride here with the other v1 state. Copied field by field,
// steps included, so a snapshot holds still while the viewer keeps editing.
// Exported, with applySeqState, SEQ_NUM_RANGE and mixStateOf above, for the
// journey (core/journey.js): every step keeps its own full copy of the lines
// and the mix in exactly these shapes, read back through the same checks.
export function seqStateOf(s) {
  return {
    seqSlot: s.seqSlot | 0,
    seqs: s.seqs.map(q => {
      const o = { len: q.len, steps: q.steps.slice(), wave: q.wave, mute: q.mute, solo: q.solo,
                  octMode: q.octMode, dlyPing: q.dlyPing };
      for (const k in SEQ_NUM_RANGE) o[k] = q[k];
      return o;
    })
  };
}
const SEQ_WAVE_OK = { sine: 1, triangle: 1, sawtooth: 1, square: 1 };
const SEQ_OCT_MODE_OK = { off: 1, up: 1, down: 1, both: 1 };
// Every number on a line and the range it is clamped into on the way in
// (the window's knobs and js/piano.js keep to the same ranges). The whole
// ones (octaves, oct) are rounded as well.
export const SEQ_NUM_RANGE = {
  vol: [0, 1], octaves: [1, 4], oct: [-3, 3], pan: [-1, 1], rev: [0, 1], spread: [0, 1],
  atk: [0.001, 0.5], atkVar: [0, 1], atkRate: [1, 120],
  dec: [0.02, 2], decVar: [0, 1], decRate: [1, 120],
  panMod: [0, 1], panRate: [1, 120],
  revTime: [1, 15], revVar: [0, 1], revRate: [1, 120],
  dlyTime: [0.25, 4], dlyFb: [0, 0.95], dlyFbVar: [0, 1], dlyFbRate: [1, 120], dlyMix: [0, 1]
};
const SEQ_WHOLE = { octaves: 1, oct: 1 };
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// A pattern's length and steps, taken only as a well-formed pair; anything
// else keeps what the line has. Returns whether it was taken.
function takePattern(q, p) {
  if (!p || !Array.isArray(p.steps) || !Number.isFinite(p.len)) return false;
  const steps = new Array(16).fill(-1);
  for (let k = 0; k < 16; k++) if (Number.isFinite(p.steps[k])) steps[k] = p.steps[k];
  q.len = clampN(Math.round(p.len), 1, 16);
  q.steps = steps;
  return true;
}
// Only well-formed values are taken, each clamped; anything else keeps the
// default, so a record from before a field existed leaves it as it is.
// Two older shapes are read too. A line from before the octave modes has an
// octRand switch, which reads as 'up' when on and 'off' when not. A line
// from before each had its own envelope has no atk or dec, and takes the
// old global attack and decay (arpAtk, arpDec, which applySettings has
// already put on s), so the lines keep the envelope the one dial pair gave
// them; once a line carries its own, those globals are never read again.
// A stored pan is always kept as it is; a line with none takes its seated
// default (seqSeat in js/state.js), as a fresh line does.
// A record from before the eight lines carries seqPatterns, the four
// patterns of which one played: they fill lines 1 to 4, each starting from
// the old global waveform, reverb, spread and envelope. The pattern that
// was playing stays active, and the other three that hold notes start
// muted, so the old session sounds as it did rather than four patterns
// suddenly playing at once.
const oldAtk = s => Number.isFinite(s.arpAtk) ? clampN(s.arpAtk, 0.001, 0.5) : 0.01;
const oldDec = s => Number.isFinite(s.arpDec) ? clampN(s.arpDec, 0.02, 2) : 0.25;
export function applySeqState(s, x) {
  if (Array.isArray(x.seqs)) {
    for (let i = 0; i < s.seqs.length && i < x.seqs.length; i++) {
      const p = x.seqs[i], q = s.seqs[i];
      if (!p || typeof p !== 'object') continue;
      takePattern(q, p);
      if (SEQ_WAVE_OK[p.wave]) q.wave = p.wave;
      if (typeof p.mute === 'boolean') q.mute = p.mute;
      if (typeof p.solo === 'boolean') q.solo = p.solo;
      if (typeof p.dlyPing === 'boolean') q.dlyPing = p.dlyPing;
      if (SEQ_OCT_MODE_OK[p.octMode]) q.octMode = p.octMode;
      else if (typeof p.octRand === 'boolean') q.octMode = p.octRand ? 'up' : 'off';
      for (const k in SEQ_NUM_RANGE) {
        const v = p[k];
        if (!Number.isFinite(v)) continue;
        const r = SEQ_NUM_RANGE[k];
        q[k] = clampN(SEQ_WHOLE[k] ? Math.round(v) : v, r[0], r[1]);
      }
      if (!Number.isFinite(p.atk)) q.atk = oldAtk(s);
      if (!Number.isFinite(p.pan)) q.pan = seqSeat(i);
      if (!Number.isFinite(p.dec)) q.dec = oldDec(s);
    }
    if (Number.isFinite(x.seqSlot)) s.seqSlot = clampN(x.seqSlot | 0, 0, s.seqs.length - 1);
  } else if (Array.isArray(x.seqPatterns)) {
    const was = Number.isFinite(x.seqSlot) ? clampN(x.seqSlot | 0, 0, 3) : 0;
    const wave = SEQ_WAVE_OK[s.arpWave] ? s.arpWave : 'sine';
    const rev = Number.isFinite(s.arpRev) ? clampN(s.arpRev, 0, 1) : 1;
    const spread = Number.isFinite(s.arpSpread) ? clampN(s.arpSpread, 0, 1) : 0.9;
    const atk = oldAtk(s), dec = oldDec(s);
    for (let i = 0; i < s.seqs.length; i++) { s.seqs[i].atk = atk; s.seqs[i].dec = dec; }
    for (let i = 0; i < 4 && i < s.seqs.length; i++) {
      const q = s.seqs[i];
      q.wave = wave; q.rev = rev; q.spread = spread; q.pan = seqSeat(i);
      if (!takePattern(q, x.seqPatterns[i])) continue;
      let notes = false;
      for (let k = 0; k < q.len; k++) if (q.steps[k] >= 0) notes = true;
      q.mute = i !== was && notes;
    }
    s.seqSlot = was;
  }
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
              textFadeInOn: s.textFadeInOn, textFadeOutOn: s.textFadeOutOn,
              textCustomText: typeof s.textCustomText === 'string' ? s.textCustomText : '',
              textPhraseGap: s.textPhraseGap };
  for (const k of WORD_FX_NUMS) o[k] = s[k];
  return o;
}
// The Custom source's phrases ride here too, not in the shared object: a v0
// tab's fixed-list save would drop them there. Capped, so a pasted essay
// cannot swell every save.
const CUSTOM_TEXT_MAX = 2000;
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
  if (typeof x.textCustomText === 'string') s.textCustomText = x.textCustomText.slice(0, CUSTOM_TEXT_MAX);
  // Their Phrase gap too: seconds, 0 to 30, anything below 0 reading as Auto.
  if (Number.isFinite(x.textPhraseGap)) s.textPhraseGap = x.textPhraseGap < 0 ? -1 : Math.min(30, x.textPhraseGap);
  for (const k of WORD_FX_SIDED) if (!Number.isFinite(x[k + 'Out']) && Number.isFinite(x[k])) s[k + 'Out'] = x[k];
  for (const k of WORD_FX_NUMS) if (Number.isFinite(x[k])) s[k] = x[k];
}

function buildExtra() {
  return Object.assign(flowerStateOf(S), kaleidoStateOf(S), particleStateOf(S), fireworkStateOf(S), confettiStateOf(S), mixStateOf(S), seqStateOf(S),
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
  applyConfettiState(S, x);
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
  for (let i = 0; i < saveCbs.length; i++) saveCbs[i]();
  if (hidden) { clearTimeout(saveTimer); saveTimer = null; return; }
  if (!saveTimer) saveTimer = setTimeout(saveDue, SAVE_DELAY_MS);
}

// Listeners told that this tab's own settings just changed: every save()
// that is not another tab's change being applied (those return above
// first). The journey (core/journey.js) uses it to notice drawer edits
// while a step is being authored. A listener must be cheap, since a slider
// drag calls save() on every input event: mark something, never work.
const saveCbs = [];
export function onSave(fn) { saveCbs.push(fn); }

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
// takes a deep copy. structuredClone rather than a JSON round trip: one pass
// instead of a string built and parsed again, which mattered once the
// broadcast took a snapshot every quarter second through a long glide. Both
// builders hand back plain numbers, strings, booleans, arrays and objects, so
// the copy is the same data. A key whose value is undefined survives where
// JSON would drop it, which changes nothing, since every reader
// (applySettings, applyExtra's helpers) type-checks each field and passes
// over one that is not there or not the right kind. Anything written
// to disk or the wire is still stringified on the way out.
// The v1-only state rides along under v1extra, so a preset saved in v1
// recalls the flowers and the kaleidoscope too.
export function snapshot() {
  const snap = structuredClone(buildSettings());
  snap.v1extra = structuredClone(buildExtra());
  return snap;
}

// The settings this machine keeps for itself: the drawer's Render section
// (schema-visual.js), by the S fields this file saves for it. How this
// screen draws (the spare frame, the trail images' size and what a change
// of it does to the trails), how its pause and
// its hint behave, the parallax sim's sway: plumbing for the machine the
// session runs on, not part of the scene an audience is shown. They are
// saved with everything else, so a reload keeps them, and another tab of
// this machine still takes them (syncFromStorage), but a preset recall and a
// followed broadcast leave them where this machine has them (applySnapshot).
// The Render rows with no field here (the parallax switch, the engine's
// thread) are never written into this object at all. Listed by name
// rather than read off the schema, since this module must not depend on it.
const MACHINE_KEYS = ['spareMode', 'pauseWindDown', 'pauseFlickerStop',
                      'hintFadeInMs', 'hintFadeMs', 'hintSweep', 'hintArrive',
                      'fbResScale', 'fbResSwitch', 'parallaxAmount', 'parallaxSpeed', 'phoneRevType', 'heartLookaheadS', 'heartGrowX', 'outputLatComp', 'syncDiagLog'];

// The same object snapshot() gives, uncopied, for a caller that stringifies
// it at once and keeps nothing (the broadcast's state message, a few times a
// second through a long glide at most). buildSettings() and buildExtra()
// build fresh objects on every call, so v1extra is attached to one nobody
// else holds; the arrays and objects inside that are live references to S
// (layers is copied, textThemes and ambLayers are not) are only read, by
// that same synchronous stringify. The machine's own settings are blanked
// rather than deleted, which keeps the object's shape, and JSON leaves an
// undefined out, so they never reach the wire: a follower from before
// applySnapshot learned to pass them over is spared them too.
export function wireSettings() {
  const out = buildSettings();
  for (let i = 0; i < MACHINE_KEYS.length; i++) out[MACHINE_KEYS[i]] = undefined;
  out.v1extra = buildExtra();
  return out;
}

// Applies a snapshot into S while the session runs. This sets state only,
// through the same code load() uses; the caller (presets.js) is what replays
// the changes through the schema so audio and the scene hear about them,
// since this module must not depend on the schema that depends on it. (The
// one exception is the plain state helpers in schema-flowers.js and
// schema-kaleido.js, which touch S and nothing else.) A snapshot from before
// v1extra existed leaves the flowers and the kaleidoscope exactly as they
// are. The machine's own settings (MACHINE_KEYS) are passed over, so a
// preset saved before they were set apart, or a broadcaster's, still lands
// without moving this screen's.
export function applySnapshot(obj) {
  if (!obj || typeof obj !== 'object') return;
  applySettings(obj, true, true);
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

// Live Sound (js/livesound.js) keeps its settings in a record of its own,
// not in the shared object or the extra record, because both of those are
// the snapshot: a preset recalls it, another tab replays it, and a broadcast
// sends it to every follower. None of that should ever open a microphone on
// someone else's machine, and an input's id means nothing on another
// machine anyway. So the input, the level, the reverb mix and its decay, the
// compressor, the Music window's trim and the latency live here, this
// machine's alone, and the switch is not saved at all:
// every load comes up with the input closed until someone switches it on.
const LIVE_KEY = 'signal.v1.live';
export function saveLive() {
  saveKey(LIVE_KEY, { liveDevice: S.liveDevice, liveLevel: S.liveLevel, liveReverb: S.liveReverb, musLive: S.musLive,
                      liveLatency: S.liveLatency, liveRevTime: S.liveRevTime,
                      liveThreshold: S.liveThreshold, liveRatio: S.liveRatio,
                      liveAttack: S.liveAttack, liveRelease: S.liveRelease });
}
// Each held to its slider's range (core/schema-audio.js), as read back.
const LIVE_RANGES = {
  liveRevTime: [0.5, 8], liveThreshold: [-60, 0], liveRatio: [1, 20],
  liveAttack: [0, 100], liveRelease: [10, 1000]
};
function loadLive() {
  let x;
  try { x = JSON.parse(readKey(LIVE_KEY) || 'null'); } catch (e) { x = null; }
  if (!x || typeof x !== 'object') return;
  if (typeof x.liveDevice === 'string') S.liveDevice = x.liveDevice;
  for (const k of ['liveLevel', 'liveReverb', 'musLive']) {
    if (typeof x[k] === 'number' && Number.isFinite(x[k])) S[k] = Math.max(0, Math.min(1, x[k]));
  }
  // the buffer asked of the input's own context, in ms (0 is the least)
  if (typeof x.liveLatency === 'number' && Number.isFinite(x.liveLatency)) {
    S.liveLatency = Math.max(0, Math.min(100, Math.round(x.liveLatency)));
  }
  // the room's length and the compressor; a record from before them has
  // none, and the defaults (the programmed sound) stand
  for (const k in LIVE_RANGES) {
    const [lo, hi] = LIVE_RANGES[k];
    if (typeof x[k] === 'number' && Number.isFinite(x[k])) S[k] = Math.max(lo, Math.min(hi, x[k]));
  }
}

// The v0 hue-band buttons derive their own label from hueLo/hueSpan rather
// than storing a name, so load() does the same derivation the schema's Hue
// range control uses. Duplicated in both places on purpose: the schema needs
// it to answer format(S), the store never needs the label at all and only
// restores the two numbers, so there is nothing here actually worth sharing.

// Returns true on a first visit (no settings stored), so main.js can lay the
// starting preset over the defaults (core/presets.js applyActivePresetState).
export function load() {
  // v1-only defaults first, since js/state.js (v0's file) does not know
  // about them: the GPU reads these fields from the very first frame, stored
  // session or not.
  initFlowerState(S);
  initKaleidoState(S);
  initParticleState(S);
  initFireworkState(S);
  initConfettiState(S);
  if (!storage) return false;
  let s;
  try { s = JSON.parse(storage.get(STORE) || '{}'); } catch (e) { s = {}; }
  // A first visit has nothing stored. v0 leaves every S default as the
  // markup already ships it and just keeps the drawer shut; the drawer is
  // the toolkit's concern now, so all that is left to say is "closed".
  const first = !s || !Object.keys(s).length;
  if (first) S.panelOpen = false;
  else applySettings(s, false);
  // Read separately and after, so the extra record wins over anything the
  // shared object might carry, and so a v1 record survives a v0 session
  // that rewrote the shared one in between.
  let x;
  try { x = JSON.parse(storage.get(EXTRA_KEY) || 'null'); } catch (e) { x = null; }
  applyExtra(x);
  loadLive();
  return first;
}

// The edge's effects (gpu/scene.js) and the new effects' numbers as
// key, min, max, matching their rows in schema-visual.js.
const EDGE_MODES = ['surfing', 'particles', 'flame', 'glow'];
const EDGE_FX_NUM = [
  ['edgePartRate', 5, 500], ['edgePartSize', 0.5, 8], ['edgePartDrift', -1, 0], ['edgePartSparkle', 0, 1],
  ['edgeFlameHeight', 8, 240], ['edgeFlameSpeed', 0.1, 3], ['edgeFlameTurb', 0, 1],
  ['edgeGlowWidth', 2, 200], ['edgeGlowSoft', 0, 1], ['edgeGlowBreathe', 0, 1], ['edgeGlowBreatheRate', 1, 60]
];

// The body of load(), shared with applySnapshot(). `live` is true when a
// preset is being recalled mid-session rather than a saved session restored
// at boot, and changes three things. The drawer's open state and the audio
// switch are left alone, because a preset describes how the session looks
// and sounds, not whether the settings pane is showing or the sound is on.
// And the atmosphere's layer list is only replaced when it actually differs,
// because the ambience engine keys its playing voices by layer object: a
// fresh but identical array would fade every recording out and back in.
// `scene` (applySnapshot's) leaves this machine's own settings as they are
// (MACHINE_KEYS, above wireSettings): a preset or a broadcast is the scene,
// not the screen it plays on. Another tab's write is this same machine's,
// so syncFromStorage takes them, and so does load().
export const oldRingSpeed = v => Math.max(0.1, Math.min(3, Math.round(v * 5 * 100) / 100));

function applySettings(s, live, scene) {
  if (typeof s.freq === 'number')   S.freq = s.freq;
  if (typeof s.depth === 'number')  S.depth = s.depth;
  if (typeof s.bright === 'number') S.bright = s.bright;
  if (typeof s.strobeScale === 'number' && isFinite(s.strobeScale)) S.strobeScale = Math.max(0, Math.min(1, s.strobeScale));
  if (s.color) setColorFromPicker(s.color);
  // Ring speed is saved as ringSpeed5 since its 1x became a fifth of the old
  // pace (js/sim.js RING_SPEED_SCALE). A setting, preset or scene saved before
  // carries ringSpeedMul in the old units, so it is taken at five times the
  // number, which is the same speed on screen, within the slider's 0.1x-3x.
  if (typeof s.ringSpeed5 === 'number' && isFinite(s.ringSpeed5)) S.ringSpeedMul = s.ringSpeed5;
  else if (typeof s.ringSpeedMul === 'number' && isFinite(s.ringSpeedMul)) S.ringSpeedMul = oldRingSpeed(s.ringSpeedMul);
  if (typeof s.ringSpeedVar === 'number') S.ringSpeedVar = Math.max(0, Math.min(1, s.ringSpeedVar));
  if (typeof s.ringSpeedVarPeriod === 'number') S.ringSpeedVarPeriod = Math.max(1, Math.min(60, s.ringSpeedVarPeriod));
  if (typeof s.cornerOpacity === 'number' && isFinite(s.cornerOpacity)) S.cornerOpacity = Math.max(0, Math.min(1, s.cornerOpacity));
  if (typeof s.cornerOpacityVar === 'number' && isFinite(s.cornerOpacityVar)) S.cornerOpacityVar = Math.max(0, Math.min(1, s.cornerOpacityVar));
  if (typeof s.cornerOpacityVarPeriod === 'number' && isFinite(s.cornerOpacityVarPeriod)) S.cornerOpacityVarPeriod = Math.max(1, Math.min(60, s.cornerOpacityVarPeriod));
  if (typeof s.cornerSpeed === 'number' && isFinite(s.cornerSpeed)) S.cornerSpeed = Math.max(0, Math.min(4, s.cornerSpeed));
  if (typeof s.cornerPulse === 'number' && isFinite(s.cornerPulse)) S.cornerPulse = Math.max(0, Math.min(1, s.cornerPulse));
  if (typeof s.cornerSize === 'number' && isFinite(s.cornerSize)) S.cornerSize = Math.max(0.05, Math.min(1, s.cornerSize));
  if (CORNER_TYPES.indexOf(s.cornerType) >= 0) S.cornerType = s.cornerType;
  if (typeof s.ringRate === 'number') S.ringRate = Math.max(0.2, Math.min(20, s.ringRate));
  if (typeof s.ringOrigin === 'number') S.ringOrigin = Math.max(0.05, Math.min(1, s.ringOrigin));
  if (typeof s.ringFadeInMs === 'number' && isFinite(s.ringFadeInMs)) S.ringFadeInMs = Math.max(0, Math.min(3000, s.ringFadeInMs));
  if (typeof s.ringOpacity === 'number') S.ringOpacity = Math.max(0, Math.min(1, s.ringOpacity));
  if (typeof s.ringPulse === 'number') S.ringPulse = Math.max(0, Math.min(1, s.ringPulse));
  if (typeof s.ringFade === 'number')     S.ringFade = s.ringFade;
  if (typeof s.fieldOpacity === 'number') S.fieldOpacity = Math.max(0, Math.min(1, s.fieldOpacity));
  if (typeof s.fieldFade === 'number')    S.fieldFade = s.fieldFade;
  if (typeof s.fieldFadeVar === 'number' && isFinite(s.fieldFadeVar)) S.fieldFadeVar = Math.max(0, Math.min(1, s.fieldFadeVar));
  if (typeof s.fieldFadeVarPeriod === 'number' && isFinite(s.fieldFadeVarPeriod)) S.fieldFadeVarPeriod = Math.max(1, Math.min(60, s.fieldFadeVarPeriod));
  if (typeof s.fieldSoft === 'number')    S.fieldSoft = s.fieldSoft;
  if (typeof s.edgeCount === 'number')    S.edgeCount = s.edgeCount;
  if (typeof s.edgeOpacity === 'number')  S.edgeOpacity = s.edgeOpacity;
  if (typeof s.edgeOpacityVar === 'number' && isFinite(s.edgeOpacityVar)) S.edgeOpacityVar = Math.max(0, Math.min(1, s.edgeOpacityVar));
  if (typeof s.edgeOpacityVarPeriod === 'number' && isFinite(s.edgeOpacityVarPeriod)) S.edgeOpacityVarPeriod = Math.max(1, Math.min(60, s.edgeOpacityVarPeriod));
  if (typeof s.edgePulse === 'number' && isFinite(s.edgePulse)) S.edgePulse = Math.max(0, Math.min(1, s.edgePulse));
  if (typeof s.edgePulseVar === 'number' && isFinite(s.edgePulseVar)) S.edgePulseVar = Math.max(0, Math.min(1, s.edgePulseVar));
  if (typeof s.edgePulseVarPeriod === 'number' && isFinite(s.edgePulseVarPeriod)) S.edgePulseVarPeriod = Math.max(1, Math.min(60, s.edgePulseVarPeriod));
  if (typeof s.edgeFb === 'number' && isFinite(s.edgeFb)) S.edgeFb = Math.max(0, Math.min(1, s.edgeFb));
  if (typeof s.edgeFbOpacity === 'number' && isFinite(s.edgeFbOpacity)) S.edgeFbOpacity = Math.max(0, Math.min(1, s.edgeFbOpacity));
  if (typeof s.edgeFbStream === 'number' && isFinite(s.edgeFbStream)) S.edgeFbStream = Math.max(-2, Math.min(2, s.edgeFbStream));
  if (typeof s.edgeFbTwist === 'number' && isFinite(s.edgeFbTwist)) S.edgeFbTwist = Math.max(-1, Math.min(1, s.edgeFbTwist));
  if (typeof s.edgeSize === 'number')     S.edgeSize = s.edgeSize;
  if (s.edgeCap === 'wedge' || s.edgeCap === 'round' || s.edgeCap === 'ball') S.edgeCap = s.edgeCap;
  // The edge's effect and the three new effects' settings, each clamped to
  // its row's range (schema-visual.js); a record from before them keeps the
  // defaults, so it draws the Surfing edge it always did.
  if (EDGE_MODES.indexOf(s.edgeMode) >= 0) S.edgeMode = s.edgeMode;
  for (let i = 0; i < EDGE_FX_NUM.length; i++) {
    const n = EDGE_FX_NUM[i], v = s[n[0]];
    if (typeof v === 'number' && isFinite(v)) S[n[0]] = Math.max(n[1], Math.min(n[2], v));
  }
  if (typeof s.trailMul === 'number')     S.trailMul = s.trailMul;
  if (typeof s.edgeSpeedMul === 'number') S.edgeSpeedMul = s.edgeSpeedMul;
  if (typeof s.frameLock === 'boolean') S.frameLock = s.frameLock;
  // The Render section, this machine's own (MACHINE_KEYS): not for a scene.
  if (!scene) {
    // Anything else saved here (an old 'alt') falls through to the default.
    if (s.spareMode === 'lit' || s.spareMode === 'dark') S.spareMode = s.spareMode;
    if (typeof s.pauseWindDown === 'number') S.pauseWindDown = Math.max(0, Math.min(5, s.pauseWindDown));
    if (typeof s.pauseFlickerStop === 'boolean') S.pauseFlickerStop = s.pauseFlickerStop;
    if (typeof s.hintFadeMs === 'number') S.hintFadeMs = Math.max(0, Math.min(10000, s.hintFadeMs));
    if (typeof s.hintSweep === 'number') S.hintSweep = Math.max(0.6, Math.min(4, s.hintSweep));
    if (typeof s.hintFadeInMs === 'number') S.hintFadeInMs = Math.max(0, Math.min(10000, s.hintFadeInMs));
    if (s.hintArrive === 'sweep' || s.hintArrive === 'all') S.hintArrive = s.hintArrive;
    // Trail res: only the three the Render section offers; anything else
    // saved stays at the default, full size.
    if (s.fbResScale === 1 || s.fbResScale === 0.75 || s.fbResScale === 0.5) S.fbResScale = s.fbResScale;
    // Trail switch: the two it offers; anything else stays at Keep.
    if (s.fbResSwitch === 'keep' || s.fbResSwitch === 'clear') S.fbResSwitch = s.fbResSwitch;
    // A phone's own reverb type (js/piano.js applyRevType); unset is Algorithmic.
    if (s.phoneRevType === 'algo' || s.phoneRevType === 'conv') S.phoneRevType = s.phoneRevType;
    // The engine's cushion, and how it grows on underrun (js/heart/route.js)
    if (typeof s.heartLookaheadS === 'number' && isFinite(s.heartLookaheadS)) S.heartLookaheadS = Math.max(0.05, Math.min(0.5, s.heartLookaheadS));
    if (typeof s.heartGrowX === 'number' && isFinite(s.heartGrowX)) S.heartGrowX = Math.max(1.1, Math.min(2, s.heartGrowX));
    if (typeof s.outputLatComp === 'boolean') S.outputLatComp = s.outputLatComp;
    if (typeof s.syncDiagLog === 'boolean') S.syncDiagLog = s.syncDiagLog;
    // The parallax sim's sway (core/eye.js). Its switch is never saved, so a
    // load always starts with the head still.
    if (typeof s.parallaxAmount === 'number' && isFinite(s.parallaxAmount)) S.parallaxAmount = Math.max(0, Math.min(0.3, s.parallaxAmount));
    if (typeof s.parallaxSpeed === 'number' && isFinite(s.parallaxSpeed)) S.parallaxSpeed = Math.max(0.05, Math.min(2, s.parallaxSpeed));
  }
  if (typeof s.freqDrift === 'number')    S.freqDrift = s.freqDrift;
  if (typeof s.freqDriftOn === 'boolean') S.freqDriftOn = s.freqDriftOn;
  if (typeof s.driftPeriod === 'number')  S.driftPeriod = s.driftPeriod;
  if (typeof s.depthVar === 'number')     S.depthVar = s.depthVar;
  // The old variance switches: a record with one off meant "no variance",
  // which the amount alone says now, so off folds into amount 0.
  if (s.depthVarOn === false)  S.depthVar = 0;
  if (typeof s.varPeriod === 'number')    S.varPeriod = s.varPeriod;
  if (typeof s.brightVar === 'number')    S.brightVar = s.brightVar;
  if (s.brightVarOn === false) S.brightVar = 0;
  if (typeof s.skipRiskBand === 'boolean') S.skipRiskBand = s.skipRiskBand;
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
  if (typeof s.amModOn === 'boolean')     S.amModOn = s.amModOn;
  if (typeof s.toneStrobeAm === 'number' && Number.isFinite(s.toneStrobeAm))
    S.toneStrobeAm = Math.max(0, Math.min(1, s.toneStrobeAm));
  // the tone's two variances (js/audio.js), held to their sliders' ranges
  for (const [k, lo, hi] of [['toneVolVar', 0, 1], ['toneVolPeriod', 0, 120],
                             ['toneStrobeAmVar', 0, 1], ['toneStrobeAmPeriod', 0, 120]])
    if (typeof s[k] === 'number' && Number.isFinite(s[k])) S[k] = Math.max(lo, Math.min(hi, s[k]));
  if (typeof s.volume === 'number')       S.volume = s.volume;
  // the Music window's trims, each a share of its voice's level, 0 to 1
  for (const k of ['musTone', 'musPulse', 'musPiano', 'musClouds', 'musDrone', 'musArp', 'musChoir', 'musAmb']) {
    if (typeof s[k] === 'number' && isFinite(s[k])) S[k] = Math.max(0, Math.min(1, s[k]));
  }

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
  if (s.textAppearMode === 'frame' || s.textAppearMode === 'time') S.textAppearMode = s.textAppearMode;
  if (typeof s.textAppearPerMin === 'number') S.textAppearPerMin = Math.max(1, Math.min(60, s.textAppearPerMin));
  for (const k of ['textFadeInVar', 'textFadeOutVar', 'textDwellVar']) {
    if (typeof s[k] === 'number') S[k] = s[k];
  }
  if (typeof s.textSize === 'number')    S.textSize = s.textSize;
  if (typeof s.textRestFreq === 'number') S.textRestFreq = s.textRestFreq;
  if (typeof s.textRestSec === 'number')  S.textRestSec = s.textRestSec;
  if (typeof s.textRestVar === 'number')  S.textRestVar = s.textRestVar;
  if (typeof s.textOpacity === 'number')    S.textOpacity = s.textOpacity;
  if (typeof s.textOpacityVar === 'number') S.textOpacityVar = s.textOpacityVar;
  if (typeof s.textOpacityVarPeriod === 'number') S.textOpacityVarPeriod = s.textOpacityVarPeriod;
  // the rate's standing phase offset (core/words.js retimeWordOpacity), 0
  // to 1. Not seeded in js/state.js: the dip reads a missing one as 0, and
  // the save writes that 0 out, so a follower derives the room's phase.
  if (Number.isFinite(s.textOpacityVarPeriodOff)) S.textOpacityVarPeriodOff = Math.max(0, Math.min(1, s.textOpacityVarPeriodOff));
  if (typeof s.textBrighten === 'number') S.textBrighten = s.textBrighten;
  // the word's backing (Text > Shadow, Shadow blur, Panel), each 0..1. Not
  // seeded in js/state.js: every reader takes a missing value as 0, off, and
  // the save writes that 0 out, so a follower's backing matches the room's.
  for (const k of ['textShadowO', 'textShadowBlur', 'textShadowSize', 'textPanelO', 'textPanelSize', 'textPanelSoft']) {
    if (Number.isFinite(s[k])) S[k] = Math.max(0, Math.min(1, s[k]));
  }
  if (typeof s.textShadowOn === 'boolean') S.textShadowOn = s.textShadowOn;
  if (typeof s.textPanelPerLine === 'boolean') S.textPanelPerLine = s.textPanelPerLine;
  if (typeof s.textPanelOn === 'boolean') S.textPanelOn = s.textPanelOn;
  // the backing's fades, milliseconds, clamped to their sliders' span
  for (const k of ['textShadowFadeInMs', 'textShadowFadeOutMs', 'textPanelFadeInMs', 'textPanelFadeOutMs']) {
    if (Number.isFinite(s[k])) S[k] = Math.max(0, Math.min(2000, s[k]));
  }
  if (s.textColorMode === 'white' || s.textColorMode === 'system') S.textColorMode = s.textColorMode;
  if (s.textThemes && typeof s.textThemes === 'object') S.textThemes = { ...s.textThemes };
  if (s.textMode === 'words' || s.textMode === 'affirmations' || s.textMode === 'custom') S.textMode = s.textMode;
  if (typeof s.textLineWidth === 'number') S.textLineWidth = s.textLineWidth;
  if (typeof s.textSmartBreaks === 'boolean') S.textSmartBreaks = s.textSmartBreaks;
  if (typeof s.textLinesTogether === 'boolean') S.textLinesTogether = s.textLinesTogether;
  if (typeof s.textLinesTogetherOut === 'boolean') S.textLinesTogetherOut = s.textLinesTogetherOut;
  if (typeof s.textLinesTogetherIn === 'boolean') S.textLinesTogetherIn = s.textLinesTogetherIn;
  if (typeof s.textLinePause === 'number') S.textLinePause = Math.max(0, Math.min(1, s.textLinePause));

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
  ['pianoVol','bedVol','pianoReverb','pianoRevTime','pianoHP','arpVol','arpRate','arpAtk','arpDec','arpOct','arpRev','arpSpread','arpStrobeAm','arpSwLo','arpSwHi','arpSwPeriod','arpSwWander','pianoDensity','pianoCentre',
   'arpVolVar','arpVolPeriod','pianoReverbVar','pianoReverbPeriod','pianoRevTimeVar','pianoRevTimePeriod','pianoRevDamp','pianoRevMod','arpStrobeAmVar','arpStrobeAmPeriod','arpHfCut',
   'pianoSpread','pianoHold','pianoBass','ambVol','ambReverb','ambRevTime','ambDriftFadeS','ambKidsFreq',
   'cloudVol','cloudDensity','cloudPhrase','cloudReverb'].forEach(k => {
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
  if (s.musicRevType === 'conv' || s.musicRevType === 'algo') S.musicRevType = s.musicRevType;
  // The atmosphere's reverb type (js/ambience.js applyAmbRevType); unset is
  // Algorithmic. Its damping and drift held to their sliders' 0 to 1.
  if (s.ambRevType === 'conv' || s.ambRevType === 'algo') S.ambRevType = s.ambRevType;
  for (const k of ['ambRevDamp', 'ambRevMod'])
    if (typeof s[k] === 'number' && isFinite(s[k])) S[k] = Math.max(0, Math.min(1, s[k]));
  // the room's two variances (js/ambience.js revBreathe)
  for (const k of ['ambReverbVar', 'ambRevTimeVar'])
    if (typeof s[k] === 'number' && isFinite(s[k])) S[k] = Math.max(0, Math.min(1, s[k]));
  for (const k of ['ambReverbPeriod', 'ambRevTimePeriod'])
    if (typeof s[k] === 'number' && isFinite(s[k])) S[k] = Math.max(0, Math.min(120, s[k]));
  if (typeof s.bedOn === 'boolean') S.bedOn = s.bedOn;
  if (typeof s.pianoOn === 'boolean') S.pianoOn = s.pianoOn;
  // arpSwOn is no longer restored: the sequencer's volume sweep lost its
  // switch to the master volume's variance, so a saved On would sweep unseen.
  // The choir (js/choir.js), each number held to its slider's range.
  if (typeof s.choirOn === 'boolean') S.choirOn = s.choirOn;
  for (const [k, lo, hi] of [['choirVol', 0, 2], ['choirStack', 0, 100], ['choirDensity', 0, 100],
                             ['choirBrightness', -100, 100], ['choirFocus', 0, 100],
                             ['choirStackVar', 0, 1], ['choirStackPeriod', 0, 120],
                             ['choirDensityVar', 0, 1], ['choirDensityPeriod', 0, 120],
                             ['choirVolVar', 0, 1], ['choirVolPeriod', 0, 120],
                             ['bedStrobeAm', 0, 1], ['choirStrobeAm', 0, 1], ['cloudStrobeAm', 0, 1],
                             ['choirStrobeAmVar', 0, 1], ['choirStrobeAmPeriod', 0, 120],
                             ['bedStrobeAmVar', 0, 1], ['bedStrobeAmPeriod', 0, 120]])
    if (typeof s[k] === 'number' && Number.isFinite(s[k])) S[k] = Math.max(lo, Math.min(hi, s[k]));
  // Each variance's Behavior, 'walk' or the default sinusoid.
  for (const k of ['choirVolVarMode', 'choirStackVarMode', 'choirDensityVarMode',
                   'choirStrobeAmVarMode', 'bedStrobeAmVarMode'])
    if (s[k] === 'walk' || s[k] === 'sine') S[k] = s[k];
  // The music layers (js/layer-defs.js), each level held to its slider's range.
  for (const L of MUSIC_LAYERS) {
    const on = layerOnKey(L), vol = layerVolKey(L);
    if (typeof s[on] === 'boolean') S[on] = s[on];
    if (typeof s[vol] === 'number' && Number.isFinite(s[vol])) S[vol] = Math.max(0, Math.min(2, s[vol]));
  }
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
