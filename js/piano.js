// The generative piano.
//
// Not a random note picker. Every rule and every default here came out of
// measuring four takes played by hand, and the comments say which measurement.
// The instrument is a felt piano tuned so its root sits two octaves under the
// 40 Hz carrier, which means the music and the entrainment tone are the same
// number rather than merely compatible.
import { S } from './state.js';
import { getContext, getMaster, createRoom, swapRoom, glideParam, glideEnd, sourceGate } from './audio.js';
import { ctxFor, masterFor, makeWorklet } from './heart/route.js';
import { meterTap, tapPeak } from './util.js';
import { chanGate, onChannelGates } from './mixgate.js';
import { createSweep } from './sweep.js';
import { setChoirBus, choirSession } from './choir.js';
import { setLayerBus, layersSession } from './layers.js';
import { strobeAm, strobeAmEffective, strobeTap, untapStrobe } from './strobe-am.js';
import { scaledStrobeDepth } from './strobe-scale.js';
import { inTurn, TURN } from './load-order.js';
import { every, after, clear } from './ticker.js';
import { breath, breathPhase, breathState } from '../core/variance.js';

const SEMIS = [0,2,4,5,7,9,11,12,14,16,17,19,21,23,24,26,28,29,31,33,35,36,38,40];
const RELEASES = 18;
const ROOT = 48;                       // written C3; sounds ~79.5 Hz
const DEG  = [0, 2, 4, 7, 11];         // 1 2 3 5 7
const LO = ROOT, HI = ROOT + 40;

// Degree weighting straight from the longest take: the root was used twice as
// often as anything else, the second was the rarest.
const DEG_W = { 0: 22, 2: 7, 4: 10, 7: 11, 11: 10 };

const notes = new Map();
const lifts = [];
let bed = null, bedGain = null, bedMeta = null;
// The drone's Vary with strobe, just after bedGain: everything bedGain
// feeds downstream now takes its signal from this stage's node instead.
let bedAm = null;
let bedTakes = [], bedNextAt = 0, bedTimer = null, bedRunning = false;
// The drone comes in several renders, one per detune amount (manifest.json's
// versions). Each is decoded the first time it is chosen and kept. bedRun is
// the run of passes currently being scheduled: its buffer, and its own gain
// ahead of bedGain so a change of render can fade one run out under the next.
const bedBuffers = new Map();
let bedRun = null, bedSwapSeq = 0;
let ready = false, loading = null;
let dry = null, room = null, wet = null, hp = null, chan = null;
let revIn = null, convFeed = null, algo = null, algoFeed = null, algoDead = false;
let noteTap = null, bedTap = null;
let bedCut = null, bedChains = null, bedSend = null, bedRev = null;
let running = false, clock = 0, elapsed = 0, drift = 0, lastDyad = 0, timer = null;

// The music family's context (js/heart/route.js, spec 12): Heart's when the
// flag names music, the native one otherwise. It is taken once, as the graph
// is built, and kept, since every node of the family has to live on the one
// context (the choir and the layers build on the bus handed to them, so they
// follow it); a later answer from route.js can then never split the family.
// Until the graph is built the native context answers, for decoding and the
// clock, both of which a Heart context shares with it.
let fam = null;
const famCtx = () => fam || getContext();
// On Heart a gesture anchored at currentTime is heard from the present,
// ctx.presentTime, about a lookahead later (spec 6.1, late gestures), while
// music booked ahead keeps its time. Natively the two are one, and each of
// these answers exactly as before. heardNow is when a call made now is heard
// (`now`, natively: the caller's own reading of currentTime, where it has
// one); lateBy is how much later than currentTime that is, which a timer
// waiting for a gesture to finish waits on top.
const heardNow = (ctx, now = ctx.currentTime) => ctx.presentTime ?? now;
const lateBy = ctx => ctx.presentTime === undefined ? 0 : Math.max(0, ctx.presentTime - ctx.currentTime);

// v1's Music window trims each voice on top of its level: the level (the
// drawer, v1's Levels window) is the ceiling, and the trim, 0 to 1, is how
// much of it plays, so 1 is exactly the level. v0 never sets the trims, so an
// unset one reads as 1. The piano's trim rides its channel gain (chan, below)
// rather than each note, so a fade reaches the notes already ringing.
const perfTrim = v => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
const bedLevel = () => S.bedVol * perfTrim(S.musDrone ?? 1);
const arpLevel = () => S.arpVol * (1 - effArpVolDepth) * perfTrim(S.musArp ?? 1);

const canOpus = (() => {
  const a = new Audio();
  return a.canPlayType('audio/ogg; codecs=opus') !== ''
      || a.canPlayType('audio/webm; codecs=opus') !== '';
})();

// The samples the player can reach. Every note a gesture strikes is a mode
// note (DEG) between LO and HI: each is built from mode degrees or snapped to
// one, then clamped to the range, whose two ends are themselves mode notes.
// Each maps to its nearest sample, so only those are fetched: 18 of the 24,
// the six on the 4 and the 6 are never struck. Derived from the same ladder
// the gestures climb, so a change to the mode or the range follows here; a
// new gesture that strikes outside the mode must widen this by hand (see
// known-ussues.md).
const reachableSamples = () => [...new Set(SCALE.map(n => nearest(n - ROOT)))];

// Loaded on demand rather than at boot: three megabytes should not be fetched
// by someone who never turns the music on. The drone's file downloads first,
// then the notes (js/load-order.js); nothing is ready, and nothing plays,
// until both are in.
export function loadPiano() {
  if (loading) return loading;
  const ctx = getContext();
  if (!ctx || !canOpus) return Promise.resolve(false);
  loading = (async () => {
    const drone = loadDrone();
    await inTurn(TURN.piano, async () => {
      const get = async u => ctx.decodeAudioData(await (await fetch(u)).arrayBuffer());
      await Promise.all([
        ...reachableSamples().map(async s =>
          notes.set(s, await get(`audio/piano/lekko-${String(s).padStart(2,'0')}.opus`))),
        ...Array.from({ length: RELEASES }, async (_, i) => {
          lifts[i] = await get(`audio/piano/releases/release-${String(i).padStart(2,'0')}.opus`);
        })
      ]);
    });
    buildGraph();
    await drone;
    ready = true;
    return true;
  })().catch(err => { console.warn('piano failed to load', err); loading = null; return false; });
  return loading;
}

// The ocean drone's file, first in the download queue; its loop points come
// from the manifest. A failed drone leaves bed empty, as it always has.
function loadDrone() {
  return inTurn(TURN.drone, async () => {
    bedMeta = await (await fetch('audio/music/manifest.json')).json();
    bed = await bedBuffer(S.bedDetune);
  }).catch(() => { bed = null; });
}

function buildGraph() {
  // The family's own context and the master it ends at, asked together so
  // they always belong to the same engine. Before route.js has started (the
  // graph built while the engine's modules still load) both are null, and
  // the family builds natively, as it always did.
  const ctx = ctxFor('music') || getContext(), master = masterFor('music') || getMaster();
  if (!ctx || !master) return;
  fam = ctx;
  dry  = ctx.createGain(); dry.gain.value = 1;
  // two convolvers, so a new decay fades in under the old tail (audio.js)
  room = createRoom(ctx, revSec, 2.0);
  wet  = ctx.createGain(); wet.gain.value = revLevel();
  dry.connect(master);
  room.output.connect(wet).connect(master);
  // The way into the reverb, whichever type plays it: every voice feeds
  // revIn, and revIn feeds the convolution room through convFeed or the
  // algorithmic one through its own feed (applyRevType).
  revIn = ctx.createGain();
  convFeed = ctx.createGain();
  revIn.connect(convFeed).connect(room.input);
  // The pause gate (audio.js) on the way into the reverb and the dry bus
  // alike, the two points every note, the drone and the arp all pass, so a
  // pause stops them at once, notes already scheduled included, while the
  // room rings on. Neither gain is set by anything else.
  sourceGate(dry.gain);
  sourceGate(revIn.gain);
  // A high-pass on the notes only, ahead of the room so the reverb is fed the
  // same thinned signal the dry path gets; filtering after the convolver would
  // leave a low bloom in the tail that the dry note no longer has. The drone
  // bypasses it: it is its own voice with its own level. 12 dB an octave at
  // Butterworth Q, gentle enough to take mud out without hollowing the tone.
  // 20 Hz is the floor and is effectively off.
  hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.Q.value = Math.SQRT1_2;
  hp.frequency.value = S.pianoHP;
  // The piano's channel gain, after the filter: the mix gate's mute and solo
  // (mixgate.js). S.pianoVol is baked into each note as it is struck, so a
  // gate there would only reach notes not yet played; here it closes on the
  // notes already ringing too, and on their feed into the room.
  chan = ctx.createGain();
  chan.gain.value = chanLevel();
  hp.connect(chan);
  // The notes and the drone share this room, so each gets its own tap on the
  // way in. Post-fader, post-gate and pre-reverb, the same point the
  // atmosphere meters read, so the mixer's columns mean one thing throughout
  // and a muted channel's meter falls silent with it.
  noteTap = meterTap(ctx, dry, revIn);
  chan.connect(noteTap.analyser);
  // The choir (js/choir.js) sings into the same dry bus and room as the drone.
  setChoirBus(dry, revIn);
  // So do the music layers (js/layers.js).
  setLayerBus(dry, revIn);
  applyRevType();
}

// Gated on the transport rather than on the graph: a suspended context keeps
// handing back the last block it rendered, which would leave a meter lit while
// everything is silent.
const audible = () => S.running && S.audioEnabled && getContext()?.state === 'running';
export const pianoPeak = () => audible() ? tapPeak(noteTap) : 0;
export const bedPeak   = () => audible() ? tapPeak(bedTap)  : 0;
export const arpPeak   = () => audible() && arp ? tapPeak(arp.tap) : 0;

// Every gain and the filter here go through glideParam (audio.js): a
// straight line over a preset's transition, the usual short approach for a
// slider.
// The Master reverb switch closes the shared room's wet output; the level
// below it is what the room plays at when it is open.
// The sequencer's lines follow at once, since a line mixed toward its room
// plays dry whenever the room cannot be heard (roomHeard, seqSync).
export function applyPianoReverb() {
  if (wet) glideParam(wet.gain, revLevel(), 0.08);
  if (arp) seqSync();
}

// The room's two variances, each the app's standard dip (core/variance.js
// breath, the sinusoid): the level and the decay ease down from their
// settings by the amount's share and back, one cycle per its speed (an unset
// speed reads as 20 s), stepped by the music's clock (step, below) on the
// audio clock, so a suspended context holds them. The decay plays in the
// slider's half seconds, no shorter than its 1 s floor, so the convolution
// room builds a new impulse only when the dip crosses a step; the
// algorithmic one takes it as it moves. schema-audio.js reads the two
// effectives for the sliders' glowing bars.
const revLevelB = breathState(), revTimeB = breathState();
let effRevLevelDepth = 0, effRevTimeDepth = 0;
const revDip01 = v => Math.max(0, Math.min(1, +v || 0));
const revLevel = () => S.musicRevOn === false ? 0 : pianoEffectiveReverb();
const revDecay = () => Math.max(1, S.pianoRevTime * (1 - effRevTimeDepth));
const revSec = () => Math.round(revDecay() * 2) / 2;
export const pianoEffectiveReverb = () => Math.max(0, S.pianoReverb || 0) * (1 - effRevLevelDepth);
export const pianoEffectiveRevTime = () => revAlgoNow ? revDecay() : revSec();
function revBreathe(now) {
  const level0 = effRevLevelDepth, time0 = effRevTimeDepth, sec0 = revSec();
  effRevLevelDepth = breath(revLevelB, revDip01(S.pianoReverbVar), S.pianoReverbPeriod, now, 'sine', 20);
  effRevTimeDepth = breath(revTimeB, revDip01(S.pianoRevTimeVar), S.pianoRevTimePeriod, now, 'sine', 20);
  if (wet && effRevLevelDepth !== level0) glideParam(wet.gain, revLevel(), 0.25);
  if (revAlgoNow) { if (effRevTimeDepth !== time0) algoTune(0.25); }
  else if (room && revSec() !== sec0) swapRoom(room);
}

// The Reverb type: Convolution, the room above, or Algorithmic, the feedback
// delay network in fdn-worklet.js, whose decay is a number rather than an
// impulse. Both are fed from revIn and both play into wet, so the level, the
// switch and the sequencer's rooms are the same either way. A change
// crossfades the feeds, not the outputs, so the old reverb's tail rings out
// under the new one; once it has, the old one's feed is unplugged and it
// falls idle. The network is made the first time it is chosen; if its module
// did not load, the type stays on convolution.
let revAlgoNow = false, revUnplug = null;
function algoNode() {
  if (algo || algoDead) return algo;
  const ctx = famCtx();
  try {
    algo = makeWorklet(ctx, 'fdn-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  } catch (e) {
    console.warn('piano: algorithmic reverb unavailable, staying on convolution', e);
    algoDead = true;
    return null;
  }
  algoFeed = ctx.createGain();
  algoFeed.gain.value = 0;
  revIn.connect(algoFeed);
  algo.connect(wet);
  return algo;
}
function algoTune(tc) {
  if (!algo) return;
  const p = algo.parameters;
  glideParam(p.get('decay'), revDecay(), tc);
  glideParam(p.get('damping'), revDip01(S.pianoRevDamp ?? 0.35), tc);
  glideParam(p.get('mod'), revDip01(S.pianoRevMod ?? 0.3), tc);
}
export function applyRevType() {
  if (!revIn) return;
  const toAlgo = S.musicRevType === 'algo' && !!algoNode();
  if (toAlgo === revAlgoNow) return;
  revAlgoNow = toAlgo;
  const on = toAlgo ? algoFeed : convFeed, off = toAlgo ? convFeed : algoFeed;
  // the incoming reverb catches up on any decay it missed while idle
  if (toAlgo) algoTune(0.02); else swapRoom(room);
  clearTimeout(revUnplug);
  on.connect(toAlgo ? algo : room.input);
  glideParam(on.gain, 1, 0.05);
  glideParam(off.gain, 0, 0.05);
  revUnplug = setTimeout(() => {
    revUnplug = null;
    try { off.disconnect(); } catch (e) {}
  }, (S.pianoRevTime + 1.5 + lateBy(famCtx())) * 1000);
}
// The algorithmic reverb's own two: its damping and its drift.
export function applyPianoRevShape() {
  algoTune(0.05);
}
// Glided rather than set, so dragging the slider sweeps instead of zippering.
export function applyPianoHP() {
  if (hp) glideParam(hp.frequency, S.pianoHP, 0.05);
}

// The piano's channel: its mix gate times the Music window's trim. While
// the piano's own switch is off the trim it last had is held, so a fade out
// that lands (perform.js puts the trim back to its level once the switch is
// off) never brings the notes still ringing back up; switching the piano on
// picks the trim up again (applyPianoTrim, from the switch).
let chanTrim = 1;
function chanLevel() {
  if (S.pianoOn !== false) chanTrim = perfTrim(S.musPiano ?? 1);
  return chanGate('piano') * chanTrim;
}
export function applyPianoTrim() {
  if (chan) glideParam(chan.gain, chanLevel(), 0.2);
}

// Mute and solo, for the notes and for the drone, which has its own channel
// in the mix and so its own gate on bedGain. A short glide rather than a
// step, so a gate closing mid-note never clicks.
const GATE_TC = 0.03;
onChannelGates(() => {
  const ctx = getContext();
  if (!ctx) return;
  if (chan) glideParam(chan.gain, chanLevel(), GATE_TC);
  if (bedGain) glideParam(bedGain.gain, bedLevel() * chanGate('drone'), GATE_TC);
  if (arp) glideParam(arp.chanG.gain, chanGate('arp'), GATE_TC);
});
// Crossfaded into the room rather than swapped under a ringing tail.
export function rebuildPianoIR() {
  if (revAlgoNow) algoTune(0.05); else swapRoom(room, 200);
}

const nearest = semi => SEMIS.reduce((a,b) => Math.abs(b-semi) < Math.abs(a-semi) ? b : a);

// The per-sample level corrections dialled in on the sandbox keyboard, the same
// numbers the manifest carries as levelTrimsBaked. They are NOT in the audio --
// lekko-35 holds a 39 trim and still measures louder than lekko-33 at 100 -- so
// the live app has to apply them, and until now nothing did.
//
// Keyed by the SAMPLE's semitone rather than by the played note, because several
// keys share one recording: correcting the sample corrects every key that
// reaches for it. Same per-sample scheme the trim strip uses for this instrument
// (perKey: false), unlike the clouds, which are trimmed per key.
const SAMPLE_TRIM = {
  14: 1.24, 19: 0.93, 23: 0.74, 24: 0.83, 31: 1.31,
  35: 0.39, 36: 0.74, 38: 0.70, 40: 0.47
};
const sampleTrim = src => SAMPLE_TRIM[src] ?? 1;
const clampN  = n => Math.max(LO, Math.min(HI, n));
const rnd  = (a,b) => a + Math.random()*(b-a);
// Rubato widens a measured spacing around its own centre: at 0 a gesture is
// played with exactly the spread that was measured, at 2 it has seven times
// that spread, so the same figure never lands the same way twice. Floored at
// 4 ms, since two notes at the identical instant is the one thing it is here
// to avoid.
const rub = (a,b) => {
  const mid = (a+b)/2, half = (b-a)/2 * (1 + S.pianoRubato*3);
  return Math.max(0.004, rnd(mid-half, mid+half));
};
// Notes that are "together" are never quite together. Each interval is drawn on
// its own and they accumulate, so the roll comes out a different shape every
// time rather than one random number multiplied out along the chord.
function roll(t, count, a, b) {
  const times = [t];
  for (let i = 1; i < count; i++) times.push(times[i-1] + rub(a,b));
  return times;
}
const pick = arr => arr[(Math.random()*arr.length)|0];

// A note is started and left to ring. These samples decay to silence on their
// own in three to fifteen seconds, and cutting one short is the single thing
// that makes a sampler sound like a sampler.
// A note struck again while its last strike is still recent never comes back
// at the same strength: it is played softer than last time (0.7 of the
// previous velocity, about 6 dB quieter), and a third strike softer again.
// The gestures still choose their notes freely; only the repeat is eased.
// Keyed by the written note and compared on the audio clock, so strikes
// booked ahead by the scheduler count in the order they will sound.
const REPEAT_WINDOW_S = 8, REPEAT_SOFTEN = 0.7;
// One record per written note (forty-one at most), rewritten in place.
const lastStrike = new Map();   // written note -> { at, vel }
function strike(written, vel, at) {
  const prev = lastStrike.get(written);
  if (prev && at - prev.at >= 0 && at - prev.at < REPEAT_WINDOW_S) {
    vel = Math.min(vel, prev.vel * REPEAT_SOFTEN);
  }
  if (prev) { prev.at = at; prev.vel = vel; } else lastStrike.set(written, { at, vel });
  const ctx = famCtx();
  const src = nearest(written - ROOT);
  const buf = notes.get(src);
  if (!buf || !dry) return;
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.playbackRate.value = Math.pow(2, ((written - ROOT) - src) / 12);
  const g = ctx.createGain();
  g.gain.value = vel * vel * S.pianoVol * sampleTrim(src);
  s.connect(g); g.connect(hp);
  // never in the past: a start before the clock's zero throws
  s.start(Math.max(at, ctx.currentTime));
}
function keyLift(at) {
  if (!lifts.length || !dry) return;
  const ctx = famCtx();
  const s = ctx.createBufferSource();
  s.buffer = pick(lifts);
  const g = ctx.createGain(); g.gain.value = 0.35 * S.pianoVol;
  s.connect(g); g.connect(hp);
  // never in the past: a start before the clock's zero throws
  s.start(Math.max(at, ctx.currentTime));
}

function weighted(obj) {
  const keys = Object.keys(obj);
  let r = Math.random() * keys.reduce((s,k) => s + obj[k], 0);
  for (const k of keys) { r -= obj[k]; if (r <= 0) return +k; }
  return +keys[0];
}
function snap(n) {
  for (let i = 0; i < 12; i++) {
    if (DEG.includes((((n+i) - ROOT) % 12 + 12) % 12)) return n + i;
    if (DEG.includes((((n-i) - ROOT) % 12 + 12) % 12)) return n - i;
  }
  return n;
}

// Gestures lengthen as a section settles, from the take where the holds went
// 4.0, 6.2, 5.3, 7.8, 12.1 seconds over half a minute.
const holdScale = () => (S.pianoHold) * (1 + 0.6 * Math.min(1.6, elapsed / 90));

function centreNow() {
  drift += (Math.random() - 0.5) * 0.12;
  drift = Math.max(-1, Math.min(1, drift * 0.985));
  return S.pianoCentre + drift * S.pianoSpread * 11;
}

// Two upper dyads a step apart, alternating: degrees 1 3 against 2 5. This is
// the whole engine of the passage that worked best by ear.
function gDyad(t, c) {
  lastDyad = 1 - lastDyad;
  const pair = lastDyad ? [0, 4] : [2, 7];
  const base = ROOT + Math.round((c - ROOT) / 12) * 12;
  const wide = Math.random() < 0.3 ? 12 : 0;
  strike(clampN(base + pair[0]), rnd(0.62,0.82), t);
  strike(clampN(base + pair[1] + wide), rnd(0.60,0.80), t + rub(0.01,0.09));
  return rnd(3.2, 7.0) * holdScale();
}
// Triad, then an upper pair, then the ninth alone. Played by hand, exactly so.
function gBloom(t, c) {
  const b = ROOT + (Math.round((c - ROOT)/12) - 1) * 12;
  const triad = [0,4,7], tri = roll(t, triad.length, 0.01, 0.12);
  triad.forEach((d,i) => strike(clampN(b+d), rnd(0.66,0.84), tri[i]));
  const t2 = t + rub(2.4, 3.4);
  const upper = Math.random() < 0.5 ? [12,16] : [12,19];
  const up = roll(t2, upper.length, 0.01, 0.06);
  upper.forEach((d,i) => strike(clampN(b+d), rnd(0.58,0.76), up[i]));
  const t3 = t2 + rub(2.0, 3.0);
  strike(clampN(b + 14), rnd(0.55,0.72), t3);
  return (t3 - t) + rnd(3.0, 6.0) * holdScale();
}
function gSingle(t, c) {
  strike(clampN(snap(Math.round(c + rnd(-5,5)))), rnd(0.5,0.75), t);
  return rnd(1.6, 4.2) * holdScale();
}
// Enters late and stays. In the take it arrived after ninety seconds and held
// for eighteen, which is most of why that section opened out.
function gBass(t) {
  const n = pick([ROOT, ROOT+7, ROOT+12]);
  strike(n, rnd(0.6,0.8), t);
  if (Math.random() < 0.5) strike(clampN(n+7), rnd(0.5,0.7), t + rub(2.5,4.5));
  return rnd(6, 13) * holdScale();
}

// ---------- snippets: the takes played back ----------
// Play style 'snippets' (S.pianoStyle). The two newest takes' own phrases,
// note for note, with only the timing loosened: the playback approach. The
// 'generative' style further down writes new phrases from rules measured on
// the same takes instead.

// Call and response, the fifth take: the call climbing 1 5 3 7, a climb from
// the octave reaching for the 9, once a third at the top (10 12 9); the answer
// 8 7 5 3; the rest on the 2, alone or as 1 3 2. Written above the base.
const SNIP_CALLS = [
  [[0,7,4,11], [0,7,4,11], [0,4,11]],     // from the root
  [[12,14], [12,7,14]],                   // from the octave
  [[16,19,14], [12,16]]                   // the top
];
const SNIP_ANSWERS = [[12,11,7,4], [12,11,7,4], [11,7,4]];
const SNIP_RESTS = [[2], [2], [0,4,2]];
function gCallSnip(t, c) {
  let base = ROOT + (Math.round((c - ROOT) / 12) - 1) * 12;
  while (base + 19 > HI) base -= 12;     // room for the top call, always in the mode
  while (base < LO) base += 12;
  const slow = 1 + 0.45 * Math.min(1.6, elapsed / 90);
  // The first phrase lands on t and each later one a gap after the last.
  // (This used to back off one random gap and add a different one, so the
  // first phrase could land up to 1.6 s before t, and before the audio
  // clock's zero right after the context started.)
  let at = t, firstPhrase = true;
  const phrase = (notes, lo, hi) => {
    if (!firstPhrase) at += rub(6.0, 7.6);   // the gap between phrases
    firstPhrase = false;
    notes.forEach((d, i) => {
      if (i) at += rub(1.3, 3.0) * slow;
      strike(clampN(base + d), rnd(lo, hi), at);
    });
  };
  phrase(pick(SNIP_CALLS[0]), 0.6, 0.8);
  for (let lift = 1; lift < 3 && Math.random() < 0.45; lift++) phrase(pick(SNIP_CALLS[lift]), 0.6, 0.8);
  phrase(pick(SNIP_ANSWERS), 0.6, 0.8);
  if (Math.random() < 0.6) phrase(pick(SNIP_RESTS), 0.55, 0.75);
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

// Dark clusters, the sixth take: its eight figures, each written above the
// low root it opens on.
const SNIP_FIGS = [
  [12,14,16], [12,14,16], [12,14,19,16], [7,16,14],
  [12,7,2], [11,14,7], [11,7,0], [12,16,14,19,16,14,12,7]
];
function gClusterSnip(t) {
  const fig = pick(SNIP_FIGS);
  strike(ROOT, rnd(0.62, 0.8), t);
  let at = t;
  fig.forEach((d, i) => {
    at += i === fig.length - 1 && fig.length > 2 ? rub(3.1, 6.0) : rub(1.4, 2.8);
    strike(ROOT + d, rnd(0.55, 0.75), at);
  });
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

// ---------- generative: rules measured from the takes ----------

// The mode laid out as a ladder, every playable note in order, and its chord
// tones (1 3 5 7) as a second, sparser ladder. The two gestures below move by
// rungs on these, so a step means a step in the mode, never a semitone.
const SCALE = [], CHORD = [];
for (let n = LO; n <= HI; n++) {
  const pc = (n - ROOT) % 12;
  if (DEG.includes(pc)) SCALE.push(n);
  if (pc === 0 || pc === 4 || pc === 7 || pc === 11) CHORD.push(n);
}
// the rung at n, or the nearest one above it
const rung = (ladder, n) => { const i = ladder.findIndex(m => m >= n); return i < 0 ? ladder.length - 1 : i; };

// Call and response, measured from the fifth take (37 single notes, no chords).
//
// The call zigzags up the chord ladder: two rungs up, one back, two up (1 5 3
// 7 is one such line). It never falls twice running and always ends higher
// than it began. Sometimes, before it is answered, it calls again from the next
// chord tone above where it peaked; a call that high often lets go of the
// chord at the end and reaches for the nearest 9 instead. The answer walks
// down the chord ladder a rung at a time from the octave (or the 7 under it)
// to the 3. Most of the time the line then settles on the 2, which never
// resolves, alone or after touching the notes either side of it.
//
// Timing: notes 1.3 to 3 s apart, stretching toward 2x as a session settles
// (the take went from about 2 s to about 4); 6 to 7.6 s between phrases.
const CALL_LEN_W  = { 2: 2, 3: 2, 4: 2 };     // notes per call
const CALL_STEP_W = { 2: 3, 1: 2, '-1': 2 };  // chord rungs per move
const CLIMB_P = 0.45, REACH_P = 0.5, REST_P = 0.6, TURN_P = 0.35;
function gCall(t, c) {
  let base = ROOT + (Math.round((c - ROOT) / 12) - 1) * 12;
  while (base + 26 > HI) base -= 12;     // room to climb twice
  while (base < LO) base += 12;
  const slow = 1 + 0.45 * Math.min(1.6, elapsed / 90);
  // The first phrase lands on t and each later one a gap after the last.
  // (This used to back off one random gap and add a different one, so the
  // first phrase could land up to 1.6 s before t, and before the audio
  // clock's zero right after the context started.)
  let at = t, firstPhrase = true;
  const phrase = (notes, lo, hi) => {
    if (!firstPhrase) at += rub(6.0, 7.6);   // the gap between phrases
    firstPhrase = false;
    notes.forEach((n, i) => {
      if (i) at += rub(1.3, 3.0) * slow;
      strike(clampN(n), rnd(lo, hi), at);
    });
  };
  const call = (from, reach) => {
    const len = weighted(CALL_LEN_W), line = [CHORD[from]];
    let i = from, fell = false;
    for (let k = 1; k < len; k++) {
      let s = weighted(CALL_STEP_W);
      if (s < 0 && (fell || k === 1 || k === len - 1)) s = -s;   // up first and last, never down twice
      i = Math.min(CHORD.length - 1, Math.max(0, i + s));
      fell = s < 0;
      line.push(CHORD[i]);
    }
    if (reach && Math.random() < REACH_P) {
      const top = line[line.length - 1];
      line[line.length - 1] = top - ((top - ROOT - 2) % 12 + 12) % 12;   // the 9 at or below it
      if (line[line.length - 1] <= line[line.length - 2]) line[line.length - 1] += 12;
    }
    return line;
  };

  let peak = base, line = call(rung(CHORD, base), false);
  phrase(line, 0.6, 0.8);
  peak = Math.max(...line);
  for (let lift = 1; lift < 3 && Math.random() < CLIMB_P && peak + 7 <= HI; lift++) {
    line = call(rung(CHORD, peak + 1), true);
    phrase(line, 0.6, 0.8);
    peak = Math.max(peak, ...line);
  }
  // the answer: down the chord ladder from the octave or the 7, to the 3
  const answer = [];
  const floor = rung(CHORD, base + 4);
  for (let i = rung(CHORD, base + (Math.random() < 0.67 ? 12 : 11)); i >= floor; i--) {
    answer.push(CHORD[i]);
    if (answer.length > 1 && i > floor && Math.random() < 0.15) i--;   // now and then skips a rung
  }
  phrase(answer, 0.6, 0.8);
  if (Math.random() < REST_P) {
    const two = base + 2, rest = [two];
    if (Math.random() < TURN_P) rest.unshift(...(Math.random() < 0.5 ? [base, base + 4] : [base + 4, base]));
    phrase(rest, 0.55, 0.75);
  }
  // step() moves on by 0.55 of a span, so the phrase is divided back out
  // here: nothing else starts until the last note has been struck
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

// Dark clusters, measured from the sixth take (38 notes, eight phrases).
//
// Every phrase opens on the low root, the darkest note the piano has here,
// then jumps up to the octave (or a rung or two under it) and walks the mode
// ladder close around it, everything left ringing together over the root.
// Moves are mostly single rungs (12 of 21 in the take), often two (7), rarely
// more. The first move goes up three times in four; after that the line leans
// down, two moves in three. It stays between the 2 above the root and the 5
// an octave up, and runs three notes most often, occasionally two, four, or a
// long wander of seven. The notes after the root come 1.4 to 2.8 s apart, now
// and then one waits longer, and the last always waits, 3 to 6 s.
const CL_FIRST_W = { 0: 5, '-1': 2, '-2': 1 };   // rungs from the octave
const CL_STEP_W  = { 1: 12, 2: 7, 3: 1, 4: 1 };
const CL_LEN_W   = { 2: 1, 3: 5, 4: 1, 7: 1 };
function gCluster(t) {
  strike(ROOT, rnd(0.62, 0.8), t);
  const lo = rung(SCALE, ROOT + 2), hi = rung(SCALE, ROOT + 19);
  const len = weighted(CL_LEN_W);
  let i = rung(SCALE, ROOT + 12) + weighted(CL_FIRST_W), at = t;
  for (let k = 0; k < len; k++) {
    if (k > 0) {
      const up = Math.random() < (k === 1 ? 0.75 : 0.33);
      let j = i + (up ? 1 : -1) * weighted(CL_STEP_W);
      if (j < lo || j > hi) j = 2 * i - j;          // off the edge: turn back
      i = Math.max(lo, Math.min(hi, j));
    }
    const last = k === len - 1 && len > 2;
    at += last ? rub(3.1, 6.0) : Math.random() < 0.2 ? rub(3.1, 5.4) : rub(1.4, 2.8);
    strike(SCALE[i], rnd(0.55, 0.75), at);
  }
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

// One gesture at `at`, chosen by the measured mix, with its occasional key
// lift. Returns its span, which step() spaces the next one by.
function gesture(at) {
  const c = centreNow();
  const kind = weighted({ 0: S.pianoDyad, 1: S.pianoBloom, 2: S.pianoSingle, 3: S.pianoBass,
                          4: S.pianoCall, 5: S.pianoCluster });
  const span = kind === 0 ? gDyad(at, c)
             : kind === 1 ? gBloom(at, c)
             : kind === 2 ? gSingle(at, c)
             : kind === 4 ? (S.pianoStyle === 'snippets' ? gCallSnip(at, c) : gCall(at, c))
             : kind === 5 ? (S.pianoStyle === 'snippets' ? gClusterSnip(at) : gCluster(at))
             : gBass(at);
  if (S.pianoLifts && Math.random() < 0.45) keyLift(at + span * rnd(0.5, 0.95));
  return span;
}

// One gesture now, on request: v1's journey plays the piano on the words,
// one gesture as each appears (core/journey.js). The free clock is left
// alone, so free play picks up where it idled when the step lets it go.
// Nothing without a running, loaded piano with its voice on, which also
// makes it a harmless no-op in v1's engine worker, where no context exists.
export function pianoGesture() {
  if (!running || !ready || S.pianoOn === false) return;
  const ctx = famCtx();
  if (!ctx) return;
  // from the present, so on Heart a roll's first notes are not all moved
  // onto the same instant (heardNow, at the top)
  gesture(heardNow(ctx) + 0.06);
}

function step() {
  if (!running) return;
  const ctx = famCtx();
  const now = ctx.currentTime;
  revBreathe(now);
  // The Piano voice switch: off, the player schedules nothing and the clock
  // idles just behind now, so switching back on picks up within a phrase.
  // v1's journey idles it the same way while a step plays the piano on the
  // words instead (S.pianoFreePlay false, never saved; undefined is free),
  // each word then asking for one gesture through pianoGesture below.
  if (S.pianoOn === false || S.pianoFreePlay === false) {
    clock = Math.max(clock, now + 0.5);
    timer = after(250, step);
    return;
  }
  while (clock < now + 1.5) {
    const at = Math.max(clock, heardNow(ctx, now) + 0.06);
    const span = gesture(at);
    // The real finding: not a rate, but short gaps inside a phrase and long
    // ones between. One take was 42% long gaps, another 18%.
    const gap = (Math.random() < 0.34 ? rnd(4.0, 9.0) : rnd(0.9, 3.2)) / S.pianoDensity;
    clock = at + span * 0.55 + gap;
    elapsed += span * 0.55 + gap;
  }
  timer = after(250, step);
}

// The bed plays its intro once and then loops the stable middle for as long as
// the music is on.
//
// It used to do that with AudioBufferSourceNode.loop, whose splice is exactly
// one sample wide: the last sample before loopEnd is followed immediately by
// the sample at loopStart with nothing in between. Measured on this bed through
// the same decoder the page uses, that step is 0.24 full scale on the right
// channel, and a 50 ms window either side of the splice correlates at -0.04.
// Uncorrelated material, spliced instantly, at roughly double the level going
// in as coming out. That is the click, and an earlier comment here claiming the
// crossfade had been baked into the looped region was simply not true of the
// file that shipped.
//
// The tail cannot be made to match the head without re-cutting the master, so
// the crossfade happens at playback instead. Each pass through the body is its
// own source, and consecutive passes overlap by BED_XFADE seconds.
const BED_XFADE = 3.0;
// A hidden tab throttles timers hard, so the scheduler runs far enough ahead
// that even a minute between wake-ups still lands the next pass on time.
const BED_LOOKAHEAD = 90;

// Equal power, not linear. The two sides of this splice are uncorrelated, so
// their amplitudes do not sum -- their powers do, and linear ramps would leave
// an audible trough in the middle of every crossfade.
const XF_N = 256;
const xfIn  = new Float32Array(XF_N);
const xfOut = new Float32Array(XF_N);
for (let i = 0; i < XF_N; i++) {
  const t = i / (XF_N - 1);
  xfIn[i]  = Math.sin(t * Math.PI / 2);
  xfOut[i] = Math.cos(t * Math.PI / 2);
}

// One pass over the buffer, fading out into whatever is scheduled after it.
// Returns the time the next pass should start, which is one crossfade early so
// the two overlap.
function bedTake(startAt, offset, playLen, xf, fadeIn) {
  const ctx = famCtx(), run = bedRun;
  const s = ctx.createBufferSource();
  s.buffer = run.buf;
  const g = ctx.createGain();
  g.gain.value = fadeIn ? 0 : 1;
  if (fadeIn) g.gain.setValueCurveAtTime(xfIn, startAt, xf);
  g.gain.setValueCurveAtTime(xfOut, startAt + playLen - xf, xf);
  s.connect(g); g.connect(run.gain);
  s.start(startAt, offset, playLen);
  s.stop(startAt + playLen);
  s.onended = () => {
    try { g.disconnect(); } catch (e) {}
    bedTakes = bedTakes.filter(t => t !== s);
    run.takes = run.takes.filter(t => t !== s);
  };
  // where this pass starts, in the context's time and in the buffer, so a
  // change of render can find the point the drone has reached
  s.at = startAt; s.offset = offset;
  bedTakes.push(s);
  run.takes.push(s);
  return startAt + playLen - xf;
}

function bedPump() {
  const ctx = getContext();
  if (!bedRunning || !ctx) return;
  const loopLen = bedMeta.loopEnd - bedMeta.loopStart;
  // A crossfade longer than half the loop would overlap its own two ends and
  // leave setValueCurveAtTime with two curves fighting over the same range.
  const xf = Math.min(BED_XFADE, loopLen / 2 - 0.01);
  while (bedNextAt < ctx.currentTime + BED_LOOKAHEAD) {
    bedNextAt = bedTake(bedNextAt, bedMeta.loopStart, loopLen, xf, true);
  }
}

function bedOn() {
  const ctx = famCtx();
  if (!bed || !bedMeta || bedRunning) return;
  bedRunning = true;
  bedGain = ctx.createGain();
  bedGain.gain.value = 0;
  bedAm = strobeAm(ctx, () => S.bedStrobeAm, () => S.bedStrobeAmVar, () => S.bedStrobeAmPeriod,
    () => S.bedStrobeAmVarMode);
  bedGain.connect(bedAm.node);
  // The drone's own low-pass, ahead of its tap so the dry path, the room and
  // the meter all hear the same filtered drone, and its own feed into the
  // piano's room in place of the tap feeding the room directly. Both start
  // where they change nothing (the filter at Nyquist, where a Web Audio
  // low-pass passes the signal through untouched, and the feed at unity),
  // and each is moved by its sweep (the drone's sweeps, after bedOff).
  bedSend = ctx.createGain();
  bedSend.gain.value = 1;
  // The Drone reverb switch and level, after the sweep's share: the sweep
  // moves bedSend, this sets how much of that reaches the room at all.
  bedRev = ctx.createGain();
  bedRev.gain.value = bedRevTarget();
  bedTap = meterTap(ctx, dry, bedSend);
  bedSend.connect(bedRev);
  bedRev.connect(revIn);
  // One cutoff for every slope: a constant source whose offset the sweep
  // moves, added into each stage's frequency (left at 0), so all four
  // chains follow the same cutoff exactly. Each chain is a Butterworth
  // cascade of its order; only the chosen slope's output is open, and a
  // change of slope crossfades between chains (applyBedLpf) instead of
  // re-wiring stages under a sounding drone.
  bedCut = ctx.createConstantSource();
  bedCut.offset.value = ctx.sampleRate / 2;
  bedCut.start();
  const pick = bedSlopeIndex();
  bedChains = BED_SLOPES.map((qs, i) => {
    if (!qs) {
      // The one-pole needs the engine's worklet module; until that has
      // loaded, the 6 dB chain is a plain wire so choosing it never breaks.
      let node;
      try {
        node = makeWorklet(ctx, 'one-pole', { outputChannelCount: [2] });
        node.parameters.get('frequency').value = 0;
        bedCut.connect(node.parameters.get('frequency'));
      } catch (e) { node = ctx.createGain(); }
      const out = ctx.createGain();
      out.gain.value = i === pick ? 1 : 0;
      node.connect(out); out.connect(bedTap.analyser);
      return chainFeed({ stages: [node], qs: [], out, live: false, idle: null }, i === pick);
    }
    const stages = qs.map(q => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 0;
      f.Q.value = q;
      bedCut.connect(f.frequency);
      return f;
    });
    for (let k = 1; k < stages.length; k++) stages[k - 1].connect(stages[k]);
    const out = ctx.createGain();
    out.gain.value = i === pick ? 1 : 0;
    stages[stages.length - 1].connect(out);
    out.connect(bedTap.analyser);
    return chainFeed({ stages, qs, out, live: false, idle: null }, i === pick);
  });
  setBedResonance(0);
  bedLpfSweep.start(ctx, bedCut.offset, ctx.sampleRate / 2);
  bedVerbSweep.start(ctx, bedSend.gain, 1);

  const loopLen = bedMeta.loopEnd - bedMeta.loopStart;
  const xf = Math.min(BED_XFADE, loopLen / 2 - 0.01);
  bedRun = newBedRun(bed, 1);
  // The intro is played once, whole, from the top; it needs no fade in of its
  // own because the master gain below is already opening. It starts a moment
  // after the present, so on Heart it is not late and is not moved: its fade
  // out stays on time with the next pass, booked ahead on true time.
  bedNextAt = bedTake(heardNow(ctx) + 0.05, 0, bedMeta.loopEnd, xf, false);
  bedPump();
  bedTimer = every(10000, bedPump);

  glideParam(bedGain.gain, bedLevel() * chanGate('drone'), 1.2);
}

function bedOff() {
  if (!bedRunning) return;
  const ctx = famCtx(), g = bedGain, takes = bedTakes, tap = bedTap, am = bedAm;
  bedRunning = false;
  bedAm = null;
  clear(bedTimer); bedTimer = null;
  bedLpfSweep.stop(); bedVerbSweep.stop();
  const cut = bedCut, chains = bedChains, send = bedSend, rev = bedRev;
  bedCut = null; bedChains = null; bedSend = null; bedRev = null;
  bedTakes = []; bedGain = null; bedNextAt = 0; bedTap = null; bedRun = null;
  // well inside the 2.6 s before the takes stop, transition or not
  glideParam(g.gain, 0, 0.6);
  setTimeout(() => {
    for (const s of takes) { try { s.onended = null; s.stop(); } catch (e) {} }
    try { g.disconnect(); } catch (e) {}
    if (am) am.stop();
    // The drone's tap is built with it, so it is torn down with it rather than
    // left hanging off the room for every on and off in the session.
    if (tap) { try { tap.analyser.disconnect(); } catch (e) {} }
    try { cut.stop(); cut.disconnect(); send.disconnect(); rev.disconnect(); } catch (e) {}
    for (const c of chains) {
      try { c.out.disconnect(); for (const f of c.stages) f.disconnect(); } catch (e) {}
    }
  }, 2600 + lateBy(ctx) * 1000);
}

// ---------- the drone's filter and room sweeps ----------
// The same slow motion as the click train's filter sweep (lpfBlock in
// worklet.js), played onto ordinary nodes by the sweep driver in sweep.js.
// The filter sweeps its cutoff in pitch between the low and high settings;
// the room sweep moves the drone's own feed into the piano's room between
// its low and high settings, as a share of the usual feed, so the drone
// sits sometimes nearer and sometimes further in. The room's wet level
// (S.pianoReverb) still applies after the room. Off, each glides back to
// where it changes nothing. The sweeps own these two params outright: a
// preset or a dial only changes the settings they read, and they re-plan
// from where they are.
//
// The top of the filter's travel, clamped under Nyquist as the worklet's
// lpfCeil is, so a high setting near it cannot misbehave at 44.1 kHz.
const bedCeil = () => Math.min(20000, getContext().sampleRate * 0.45);
const bedLpfSweep = createSweep({
  domain: 'log',
  read: c => {
    const ceil = bedCeil();
    c.on = S.bedLpfOn; c.lo = Math.min(ceil, S.bedLpfLo); c.hi = Math.min(ceil, S.bedLpfHi);
    c.period = S.bedLpfPeriod; c.wander = S.bedLpfWander;
  }
});
const bedVerbSweep = createSweep({
  domain: 'lin',
  read: c => {
    c.on = S.bedVerbOn; c.lo = S.bedVerbLo; c.hi = S.bedVerbHi;
    c.period = S.bedVerbPeriod; c.wander = S.bedVerbWander;
  }
});
// The rolloff: 6 dB an octave as a one-pole (the 'one-pole' processor in
// worklet.js, since BiquadFilterNode starts at 12), then 12, 24, 36 or 48 as
// Butterworth cascades of order 2, 4, 6 and 8 (their stages' Q values,
// lowest first). Flat to the
// cutoff with no bump at the default resonance, so a steeper slope only
// makes the drone darker above the cutoff, not louder at it.
const BED_SLOPES = [
  null,                              // 6 dB: the one-pole in worklet.js
  [0.7071],
  [0.5412, 1.3066],
  [0.5176, 0.7071, 1.9319],
  [0.5098, 0.6013, 0.9000, 2.5629]
];
const BED_SLOPE_DB = [6, 12, 24, 36, 48];
function bedSlopeIndex() {
  const i = BED_SLOPE_DB.indexOf(S.bedLpfSlope);
  return i < 0 ? 1 : i;
}
// Resonance lifts each chain's last, highest-Q stage by the dial's ratio to
// Butterworth (0.71), so the default is exactly flat at every slope and the
// dial means the same peak whichever slope is chosen.
function setBedResonance(glide) {
  const lift = S.bedLpfQ / 0.7071;
  for (const c of bedChains) {
    if (!c.qs.length) continue;      // a one-pole has no resonance
    const last = c.stages[c.stages.length - 1], q = c.qs[c.qs.length - 1] * lift;
    if (glide > 0) glideParam(last.Q, q, glide); else last.Q.value = q;
  }
}
// Resonance and slope are not part of the motion, so they glide like any
// other dial, in a straight line over a preset's transition; a new slope is
// a short crossfade between chains.
//
// Only the chosen chain is fed. The other four used to run all the time at
// a closed output, which during a sweep meant nine biquad stages working out
// fresh coefficients every sample for nothing. A chain that has been faded
// out is unplugged from the drone once its fade is done (the glide's own
// length, a preset's transition included, plus ten time constants, by which
// point it is some 85 dB down), and plugged back in the moment it is chosen,
// its output still closed and opening over the same crossfade as before.
const BED_XF_TC = 0.08;
function chainFeed(c, on) {
  if (on) {
    if (c.idle) { clearTimeout(c.idle); c.idle = null; }
    if (!c.live) { bedAm.node.connect(c.stages[0]); c.live = true; }
  } else if (c.live && !c.idle) {
    // The chains hang off the strobe stage, so that is what is unplugged, the
    // one alive now: a later drone brings its own.
    const ctx = famCtx(), am = bedAm;
    const wait = Math.max(0, glideEnd() - ctx.currentTime) + lateBy(ctx) + 10 * BED_XF_TC;
    c.idle = setTimeout(() => {
      c.idle = null;
      if (!c.live || bedAm !== am) return;        // the drone was rebuilt meanwhile
      try { am.node.disconnect(c.stages[0]); } catch (e) {}
      c.live = false;
    }, wait * 1000);
  }
  return c;
}
export function applyBedLpf() {
  if (!bedChains) return;
  setBedResonance(0.05);
  const pick = bedSlopeIndex();
  for (let i = 0; i < bedChains.length; i++) {
    chainFeed(bedChains[i], i === pick);
    glideParam(bedChains[i].out.gain, i === pick ? 1 : 0, BED_XF_TC);
  }
  bedLpfSweep.update();
}
// Off is no feed at all; on, the level (100% is the drone's usual feed).
const bedRevTarget = () => S.bedRevOn === false ? 0 : Math.max(0, S.bedRevLevel ?? 1);
export function applyBedVerb() {
  if (!bedSend) return;
  glideParam(bedRev.gain, bedRevTarget(), 0.08);
  bedVerbSweep.update();
}

export function applyBedVol() {
  if (bedGain) glideParam(bedGain.gain, bedLevel() * chanGate('drone'), 0.2);
}
// Vary with strobe on the drone: its depth has moved.
export function applyBedAm() {
  if (bedAm) bedAm.apply();
}
// the depth as it plays, wander included, for the slider's glow
export const bedEffectiveAm = () => strobeAmEffective(bedAm);

// ---------- the drone's renders ----------
function bedVersion(id) {
  return bedMeta.versions.find(v => v.id === id) || bedMeta.versions[0];
}
function bedBuffer(id) {
  const v = bedVersion(id);
  if (!bedBuffers.has(v.id)) {
    const p = fetch(`audio/music/${v.file}.opus`)
      .then(r => r.arrayBuffer())
      .then(b => getContext().decodeAudioData(b));
    // a failed load is forgotten, so choosing it again tries again
    p.catch(() => bedBuffers.delete(v.id));
    bedBuffers.set(v.id, p);
  }
  return bedBuffers.get(v.id);
}
function newBedRun(buf, level) {
  const ctx = famCtx(), g = ctx.createGain();
  g.gain.value = level;
  g.connect(bedGain);
  return { buf, gain: g, takes: [] };
}

// A change of render crossfades rather than cuts. The renders are the same
// drone at different detune amounts, cut to the same length and loop points,
// so the new one starts at the point the old one has reached and the two
// overlap for BED_SWAP seconds. They are largely the same material, so the
// fades are complementary in amplitude, not equal power. setTargetAtTime
// rather than a curve, so a second change mid-fade simply redirects the gains
// from wherever they are.
const BED_SWAP = 4;
export async function applyBedDetune() {
  if (!bedMeta) return;
  const seq = ++bedSwapSeq;
  let buf;
  try { buf = await bedBuffer(S.bedDetune); }
  catch (e) { console.warn('drone render failed to load', e); return; }
  if (seq !== bedSwapSeq) return;      // a later choice has already taken over
  bed = buf;
  if (!bedRunning || !bedRun || bedRun.buf === buf) return;

  // From the present, as the drone's first pass is (bedOn), so on Heart
  // nothing here is late: both fades and the new pass keep their times.
  const ctx = famCtx(), now = heardNow(ctx) + 0.05, tc = BED_SWAP / 4;
  const old = bedRun;
  // the newest pass already sounding says where the drone is
  let pos = bedMeta.loopStart;
  for (const s of old.takes) if (s.at <= now) pos = s.offset + (now - s.at);
  const loopLen = bedMeta.loopEnd - bedMeta.loopStart;
  const xf = Math.min(BED_XFADE, loopLen / 2 - 0.01);
  // too close to the end for a pass and its crossfade: start at the loop
  if (bedMeta.loopEnd - pos < xf + 1) pos = bedMeta.loopStart;

  old.gain.gain.setTargetAtTime(0, now, tc);
  setTimeout(() => {
    for (const s of old.takes) { try { s.onended = null; s.stop(); } catch (e) {} }
    bedTakes = bedTakes.filter(t => !old.takes.includes(t));
    try { old.gain.disconnect(); } catch (e) {}
  }, (BED_SWAP * 2 + 0.5 + lateBy(ctx)) * 1000);

  bedRun = newBedRun(buf, 0);
  bedRun.gain.gain.setTargetAtTime(1, now, tc);
  bedNextAt = bedTake(now, pos, bedMeta.loopEnd - pos, xf, false);
  bedPump();
}

// ---------- the sequencer ----------
// Robert's figure: the 3, the 4 and the octave above the root, an octave
// above middle C (E5 F5 C6 against this piano's C), played fast and over and
// over, 3 4 8 3 4 8. It sits on its pan, and a delayed copy answers to the
// right of it, a step and a half behind, so the echo falls between the notes
// and reads almost as a second player (each line's delay, lineVoice; it
// used to start in the left ear, until spread became the delay's alone). Now and then an answering line comes
// in over it, the same notes turned round, 8 4 3, starting on the right and
// echoed to the left, while the main line eases back a little; after a while
// it leaves and the main line comes forward again.
//
// It is a synth voice, not the piano: one oscillator per line that never
// stops, tuned to the piano's own root (rootSoundingHz in audio/piano/
// manifest.json) so the two agree. The figure is played by the filter, not
// the level: each note steps the pitch and opens a low-pass that then falls
// shut again, each line's attack and decay setting how fast it opens and
// closes, so the line is one smooth tone swelling and dimming rather than a
// row of plucks. It has its own mixer channel ('arp' in mixgate.js: level,
// mute, solo and meter), and each line has a room of its own (lineRoom)
// whose output joins the piano room's at the shared Reverb level. It runs
// only while the music is on and its switch is up.
const ARP_A = [76, 77, 84], ARP_B = [84, 77, 76];

// ---------- the sequencer ----------
// The figure is no longer fixed, and no longer one line: eight lines
// (S.seqs, edited in the sequencer window) play together. Each is up to 16
// steps long, a step holding a written note or -1 for a rest, and a rest
// leaves that line's filter shut, so the line breathes there instead of
// sounding. All eight read the one step clock at the one Speed, starting
// together, but each loops over its own length, so a line of 3 against a
// line of 4 comes round together only every 12 steps. The grid's rows are
// the scale over two octaves, from the 1 an octave above middle C (the
// octave that holds the original 3 4 8) up to the 15, two octaves on.
export const SEQ_ROWS = [96, 95, 93, 91, 89, 88, 86,          // 15 14 13 12 11 10 9
                         84, 83, 81, 79, 77, 76, 74, 72];    // 8 7 6 5 4 3 2 1, top to bottom
export const SEQ_MAX = 16, SEQ_COUNT = 8;
export const SEQ_WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
// The line at i, or null when S holds nothing usable there.
const seqAt = i => { const a = S.seqs, q = a && a[i]; return q && Array.isArray(q.steps) ? q : null; };
const seqLen = q => Math.max(1, Math.min(SEQ_MAX, q.len | 0));
const clampPan = x => (x < -1 ? -1 : x > 1 ? 1 : x);
const clamp01 = x => (x > 0 ? (x < 1 ? x : 1) : 0);

// Mute and solo among the lines, by the mix gate's own rules (js/mixgate.js)
// but kept inside the sequencer: a muted line is silent, and while any line
// is soloed only the soloed lines sound. This gate multiplies with the 'arp'
// channel's, which still holds the whole sequencer in the mix.
export function seqAnySolo() {
  for (let i = 0; i < SEQ_COUNT; i++) { const q = seqAt(i); if (q && q.solo) return true; }
  return false;
}
export function seqGate(q, anySolo) {
  if (!q || q.mute) return 0;
  return anySolo && !q.solo ? 0 : 1;
}
// Whether any step inside the line's length holds a note. A line with none
// is held silent, so a cleared line does not go on humming its last pitch.
export function seqHasNotes(q) {
  const n = seqLen(q), st = q.steps;
  for (let k = 0; k < n; k++) if (st[k] >= 0) return true;
  return false;
}

// Where the playhead is: every scheduled step is noted with its time and
// the step clock's count, and the window asks which was the last one to
// sound. The count, not a step, so each line can find its own step in it.
const MARKS = 32;
const markT = new Float64Array(MARKS).fill(-1), markC = new Float64Array(MARKS).fill(-1);
let markN = 0;
function seqMark(t, c) { markT[markN] = t; markC[markN] = c; markN = (markN + 1) % MARKS; }
// The count at the step that last sounded, -1 while nothing plays. A line's
// step under it is the count modulo that line's length.
export function seqClock() {
  const ctx = getContext();
  if (!arp || !ctx) return -1;
  const now = ctx.currentTime;
  let best = -1, bt = -1;
  for (let k = 0; k < MARKS; k++) if (markT[k] <= now && markT[k] > bt) { bt = markT[k]; best = markC[k]; }
  return best;
}
// The active line's step, for the grid's playhead.
export function seqPlayhead() {
  const c = seqClock(), q = seqAt(S.seqSlot | 0);
  return c < 0 || !q ? -1 : c % seqLen(q);
}
// A fresh pattern: a note on three steps in four, walking the scale more
// often than leaping, the chord tones (1 3 5 8, and 10 12 15 above) three
// times as likely as the others. It starts in the lower octave.
const SEQ_ROW_W = [3, 1, 1, 3, 1, 3, 1, 3, 1, 1, 3, 1, 3, 1, 3];
const SEQ_ROW_WSUM = SEQ_ROW_W.reduce((a, b) => a + b, 0);
export function seqRandomize(p) {
  const last = SEQ_ROWS.length - 1;
  let row = [7, 10, 12, 14][(Math.random() * 4) | 0];
  for (let i = 0; i < SEQ_MAX; i++) {
    if (i > 0 && Math.random() < 0.25) { p.steps[i] = -1; continue; }
    if (i > 0) {
      if (Math.random() < 0.6) row = Math.max(0, Math.min(last, row + (Math.random() < 0.5 ? -1 : 1)));
      else {
        let r = Math.random() * SEQ_ROW_WSUM;
        for (let k = 0; k <= last; k++) { r -= SEQ_ROW_W[k]; if (r <= 0) { row = k; break; } }
      }
    }
    p.steps[i] = SEQ_ROWS[row];
  }
}

// The lines as one row of numbers, the single way they travel in worker
// mode (core/audio-link.js packs, core/audio-shell.js unpacks), so
// both ends share this one layout: the active slot, then each line as
// SEQ_STRIDE numbers, its length, its 16 steps, its wave (an index into
// SEQ_WAVES) and octave mode (an index into SEQ_OCT_MODES), then the
// switches in SEQ_PACK_BOOLS as 0 or 1 and the numbers in SEQ_PACK_NUMS, in
// the tables' order. Both ends walk the same two tables, so a field added
// to them travels without either end changing. Neither allocates.
// The last two numbers are a line's waveform crossfade (see lineShape), set
// only while a journey step ramps a line from one wave to another: never
// saved, and 0 on a line nobody is morphing.
export const SEQ_OCT_MODES = ['off', 'up', 'down', 'both'];
const SEQ_PACK_BOOLS = ['mute', 'solo', 'dlyPing'];
const SEQ_PACK_NUMS = ['vol', 'octaves', 'oct', 'pan', 'rev', 'spread',
  'atk', 'atkVar', 'atkRate', 'dec', 'decVar', 'decRate', 'panMod', 'panRate',
  'revTime', 'revVar', 'revRate', 'dlyTime', 'dlyFb', 'dlyFbVar', 'dlyFbRate', 'dlyMix',
  'morphWave', 'morphMix'];
const SEQ_TAIL = 2 + SEQ_PACK_BOOLS.length + SEQ_PACK_NUMS.length;
export const SEQ_STRIDE = 1 + SEQ_MAX + SEQ_TAIL;
export const SEQ_PACK = 1 + SEQ_COUNT * SEQ_STRIDE;
export function packSeqs(out) {
  out[0] = S.seqSlot | 0;
  let k = 1;
  for (let i = 0; i < SEQ_COUNT; i++) {
    const q = seqAt(i);
    if (!q) {
      out[k++] = 0;
      for (let j = 0; j < SEQ_MAX; j++) out[k++] = -1;
      for (let j = 0; j < SEQ_TAIL; j++) out[k++] = 0;
      continue;
    }
    out[k++] = q.len | 0;
    for (let j = 0; j < SEQ_MAX; j++) { const v = q.steps[j]; out[k++] = v >= 0 ? v | 0 : -1; }
    const w = SEQ_WAVES.indexOf(q.wave);
    out[k++] = w < 0 ? 0 : w;
    const m = SEQ_OCT_MODES.indexOf(q.octMode);
    out[k++] = m < 0 ? 0 : m;
    for (let j = 0; j < SEQ_PACK_BOOLS.length; j++) out[k++] = q[SEQ_PACK_BOOLS[j]] ? 1 : 0;
    for (let j = 0; j < SEQ_PACK_NUMS.length; j++) {
      const v = +q[SEQ_PACK_NUMS[j]];
      out[k++] = v === v ? v : 0;
    }
  }
}
// Written in place, since the engine reads the lines at every step and the
// next step plays the edit.
export function unpackSeqs(p) {
  S.seqSlot = Math.max(0, Math.min(SEQ_COUNT - 1, p[0] | 0));
  let k = 1;
  for (let i = 0; i < SEQ_COUNT; i++) {
    const q = seqAt(i);
    if (!q) { k += SEQ_STRIDE; continue; }
    q.len = p[k++];
    for (let j = 0; j < SEQ_MAX; j++) q.steps[j] = p[k++];
    q.wave = SEQ_WAVES[p[k++]] || 'sine';
    q.octMode = SEQ_OCT_MODES[p[k++]] || 'off';
    for (let j = 0; j < SEQ_PACK_BOOLS.length; j++) q[SEQ_PACK_BOOLS[j]] = p[k++] !== 0;
    for (let j = 0; j < SEQ_PACK_NUMS.length; j++) q[SEQ_PACK_NUMS[j]] = p[k++];
  }
}

// The delay's time as the knob offers it, in steps, snapped to these
// musical values: a quarter step up to four steps.
export const SEQ_DLY_STEPS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2, 3, 4];

// ---------- a line's slow swings ----------
// Five settings on each line can swing on their own slow sine: the
// envelope's attack and decay, the mix into the line's room, the pan and
// the delay's feedback. Each is a variance on the one law
// (core/variance.js breath), with its own period (its RATE, 1 to 120 s a
// cycle) and depth (its VAR, or MOD for the pan), run on the sequencer's own
// clock: seqT moves only on the step clock's pump, by the audio clock's time
// since the last pump, so the swings hold still while the sequencer is
// stopped and pick up where they were when it starts again. At depth 0 each
// is exactly its set value and holds at the top of its cycle, so a VAR
// turned up from 0 eases out from the setting.
//
// Attack, decay, the mix and the feedback swing down only, the house style:
// set * (1 - the breath's depth), never above where it was set, so a deep
// feedback cannot be pushed toward runaway repeats. The pan swings
// symmetrically about its setting on the same clock (breathPhase), never a
// one-sided drift.
const TAU = Math.PI * 2;
const breaths = () => Array.from({ length: SEQ_COUNT }, breathState);
const bAtk = breaths(), bDec = breaths(), bPan = breaths(), bRev = breaths(), bFb = breaths();
let seqT = 0;
// Each line's values as of the last pump or control change.
const effAtk = new Float64Array(SEQ_COUNT).fill(0.01), effDec = new Float64Array(SEQ_COUNT).fill(0.25);
const effPan = new Float64Array(SEQ_COUNT), effRev = new Float64Array(SEQ_COUNT).fill(1);
const effFb = new Float64Array(SEQ_COUNT);
// A finite value clamped into lo..hi, or def for anything else.
const num = (v, lo, hi, def) => (v === v && typeof v === 'number' ? (v < lo ? lo : v > hi ? hi : v) : def);
const swingRate = r => num(r, 1, 120, 20);
const dip = (set, b, depth, rate) => set * (1 - breath(b, clamp01(depth), swingRate(rate), seqT, 'sine'));
function seqAdvance(dt) { seqT += dt; }
// The line's values on the sequencer's clock now. Attack and decay keep the
// floors the old global dials had, 1 ms and 20 ms, so a deep dip never asks
// the filter for an instant move.
const ARP_FB_MAX = 0.95;
function seqEff(i, q) {
  effAtk[i] = Math.max(0.001, dip(num(q.atk, 0.001, 0.5, 0.01), bAtk[i], q.atkVar, q.atkRate));
  effDec[i] = Math.max(0.02, dip(num(q.dec, 0.02, 2, 0.25), bDec[i], q.decVar, q.decRate));
  const mod = clamp01(q.panMod);
  effPan[i] = clampPan(num(q.pan, -1, 1, 0) + mod * Math.sin(TAU * breathPhase(bPan[i], mod, swingRate(q.panRate), seqT)));
  effRev[i] = dip(num(q.rev, 0, 1, 1), bRev[i], q.revVar, q.revRate);
  effFb[i] = dip(num(q.dlyFb, 0, ARP_FB_MAX, 0), bFb[i], q.dlyFbVar, q.dlyFbRate);
}
// The swung values as they stand, for the sequencer window's knobs, whose
// lights follow a swing round their ring while the hand's setting stays put:
// SEQ_SWINGS numbers a line into out from at, in SEQ_SW_* order, each in its
// setting's own units (attack and decay in seconds, the pan -1..1, the mix
// and the feedback as fractions). They move on the pump, five times a second.
// Returns false and writes nothing while no sequencer plays here to swing
// them (stopped, or the worker's silent copy), and the lights rest on the
// settings.
export const SEQ_SW_ATK = 0, SEQ_SW_DEC = 1, SEQ_SW_PAN = 2, SEQ_SW_REV = 3, SEQ_SW_FB = 4, SEQ_SWINGS = 5;
export function seqSwingRead(out, at) {
  if (!arp) return false;
  for (let i = 0; i < SEQ_COUNT; i++, at += SEQ_SWINGS) {
    out[at + SEQ_SW_ATK] = effAtk[i]; out[at + SEQ_SW_DEC] = effDec[i];
    out[at + SEQ_SW_PAN] = effPan[i]; out[at + SEQ_SW_REV] = effRev[i];
    out[at + SEQ_SW_FB] = effFb[i];
  }
  return true;
}

// ---------- each line's own room ----------
// Every line has a reverb of its own now, so each can have its own decay
// (revTime). A room is two convolvers (createRoom in audio.js), built the
// first time its line is heard with a mix above 0 and kept for the rest of
// the session, across the sequencer stopping and starting, so a line kept
// dry builds nothing. Its impulse comes off the main thread through
// getIR, and a new decay crossfades in under the old tail. Its input
// carries the pause gate as the shared room's does, and its output joins
// the shared room's at the Reverb level and switch (wet).
//
// The cost: eight lines all sending is eight stereo convolutions of up to
// 15 s, where one shared room used to carry them all, roughly eight times
// the reverb's audio thread work. A room whose line has gone quiet costs
// little once its tail has rung out, since the browser stops convolving
// once nothing feeds it, which is why a silent line's voice lets go of its
// room (lineRest); the lazy build is what keeps an unused line at nothing.
const lineRooms = new Array(SEQ_COUNT).fill(null);
const roomSec = new Float64Array(SEQ_COUNT);
const lineRevTime = i => { const q = seqAt(i); return q ? num(q.revTime, 1, 15, 4.5) : 4.5; };
function lineRoom(ctx, i) {
  let r = lineRooms[i];
  if (!r) {
    r = lineRooms[i] = createRoom(ctx, () => lineRevTime(i), 2.0);
    sourceGate(r.input.gain);
    r.output.connect(wet);
    roomSec[i] = lineRevTime(i);
  }
  return r;
}

// ---------- each line's reverb mix ----------
// A line's rev is a mix, not a send: at 0 the line is all dry, at 1 all
// room with no dry voice left, and between the two trade places on the
// equal-power law (the dry at the cosine of the quarter turn, the room at
// its sine), so the middle holds its loudness rather than dipping, as the
// Live Sound's own mix does (js/livesound.js). A saved send reads as the
// same share of mix, so the low settings sound much as they did; only the
// top of the range, where the dry voice now leaves, is new.
//
// A mix can only give a line to a room that is there to take it, so the
// line plays fully dry whatever its mix while its room cannot be heard:
// the Master reverb switched off, the Reverb level at 0, or the line's room
// still waiting for its first impulse. The moment the room can be heard
// again, the crossfade takes hold, the dry voice gliding down as the room
// comes up. No mix can silence a line.
const QUARTER_TURN = Math.PI / 2;
const roomHeard = r => !!r && r.live.key !== '' && S.musicRevOn !== false && S.pianoReverb > 0;

const ARP_DIP = 0.65;           // the main line's level while the answer plays
const ARP_ROOT_HZ = 79.5;                // the piano's sounding root
// Rough loudness matching between shapes, so a change of waveform is a
// change of colour rather than of level.
const ARP_WAVE_GAIN = { sine: 1, triangle: 0.85, sawtooth: 0.42, square: 0.34 };
let arp = null;
const lineWave = q => (q && ARP_WAVE_GAIN[q.wave] ? q.wave : 'sine');
// The volume sweep: the same slow motion as the drone's sweeps (sweep.js),
// moving a gain of its own between the low and high shares of the set level,
// so the sequencer swells and recedes on its own schedule. Off, it glides
// back to full and stays there.
const arpVolSweep = createSweep({
  domain: 'lin',
  read: c => {
    c.on = S.arpSwOn; c.lo = S.arpSwLo; c.hi = S.arpSwHi;
    c.period = S.arpSwPeriod; c.wander = S.arpSwWander;
  }
});
// The strobe pulse taps the strobe's own flash (strobe-am.js strobeTap), the
// one signal the drone's, the choir's and the clouds' stages tap too.
// The master volume's and the strobe pulse's variances, each the app's
// standard dip (core/variance.js breath, the sinusoid): down from the
// setting by the amount's share and back, one cycle per its speed (an unset
// speed reads as 20 s), stepped by arpPump on the audio clock, so a
// suspended context holds them where they are. schema-audio.js reads the
// two effectives for the sliders' glowing bars.
const dip01 = v => Math.max(0, Math.min(1, +v || 0));
const arpVolB = breathState(), arpAmB = breathState();
let effArpVolDepth = 0, effArpAmDepth = 0;
const arpDip = (b, amount, period, now) => breath(b, amount, period, now, 'sine', 20);
export const arpEffectiveVol = () => Math.max(0, S.arpVol || 0) * (1 - effArpVolDepth);
export const arpEffectiveAm = () => dip01(S.arpStrobeAm) * (1 - effArpAmDepth);
const arpAmDepth = () => scaledStrobeDepth(dip01(S.arpStrobeAm) * (1 - effArpAmDepth));
const arpTargetRate = () => Math.max(2, Math.min(14, S.arpRate || 7));

// One line's tone, in the old single line's shape: an oscillator that never
// stops, played by its filter, then a dry copy on its own panner and the
// line's delay, both into `into`, traded by the delay's mix (lineShape).
//
// The delay is two delay lines, A and B, each one repeat long, with a loop
// gain on every path between them (aa, ab, ba, bb). Ping pong feeds the
// voice into A only and crosses the loop, A into B and B back into A, so
// the repeats land on alternating sides: the first on A's side, the old
// echo's, then B's, then A's again. In place feeds the voice into both
// (inB opens) and loops each into itself, so the two run the same repeats
// side by side at half level each, one either side of the pan; at spread 0
// they sit on the pan together and add up to exactly one repeat there. The
// feedback is the loop gain, so at 0 (the default) there is a single
// repeat, a step and a half behind, at the old echo's level: today's echo.
// panSign is the side the old dry copy leaned to (-1, left); A's repeats
// lean the other way, right for a line, as the old echo did.
const ARP_DLY_MAX = 2;          // four steps at the slowest Speed, 2 notes/s
// m1 sits between the tone and its filter at 1, and is only ever moved by a
// waveform crossfade (lineShape), when a second tone (o2, through m2) joins
// it under the same filter. The last few pitches arpNote scheduled are kept
// (sHz, sAt, a ring of SCHED_N), so a second tone started mid-phrase can be
// handed the notes already queued ahead of it.
const SCHED_N = 8;
function lineVoice(ctx, q, panSign, into, dSec) {
  const wave = lineWave(q);
  const o = ctx.createOscillator();
  o.type = wave;
  o.frequency.value = ARP_ROOT_HZ * Math.pow(2, (ARP_A[0] - ROOT) / 12);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 200;
  filt.Q.value = 1;
  const wg = ctx.createGain();
  wg.gain.value = ARP_WAVE_GAIN[wave];
  const m1 = ctx.createGain();
  // hf is the note's own level under the high freq reduction, stepped at
  // each note (arpNote) and resting at 1 while the tilt is off.
  const hf = ctx.createGain();
  o.connect(m1); m1.connect(filt); filt.connect(hf); hf.connect(wg);
  o.start();
  const inG = ctx.createGain();
  wg.connect(inG);
  // dm is the delay mix's dry side, the voice's own share before its panner
  const dm = ctx.createGain();
  const dryP = ctx.createStereoPanner();
  const dA = ctx.createDelay(ARP_DLY_MAX), dB = ctx.createDelay(ARP_DLY_MAX);
  dA.delayTime.value = dSec; dB.delayTime.value = dSec;
  const inB = ctx.createGain(); inB.gain.value = 0;
  const aa = ctx.createGain(), ab = ctx.createGain(), ba = ctx.createGain(), bb = ctx.createGain();
  aa.gain.value = 0; ab.gain.value = 0; ba.gain.value = 0; bb.gain.value = 0;
  const egA = ctx.createGain(), egB = ctx.createGain();
  egA.gain.value = 0; egB.gain.value = 0;
  const pA = ctx.createStereoPanner(), pB = ctx.createStereoPanner();
  inG.connect(dm); dm.connect(dryP); inG.connect(dA); inG.connect(inB); inB.connect(dB);
  dA.connect(aa); aa.connect(dA); dA.connect(ab); ab.connect(dB);
  dB.connect(bb); bb.connect(dB); dB.connect(ba); ba.connect(dA);
  dA.connect(egA); egA.connect(pA); dB.connect(egB); egB.connect(pB);
  dryP.connect(into); pA.connect(into); pB.connect(into);
  const v = { o, filt, hf, hfAt: 1, wg, inG, dm, dryP, dA, dB, inB, aa, ab, ba, bb, egA, egB, pA, pB,
              g: null, dg: null, rv: null, rw: null, roomed: false, panSign, dgAt: NaN,
              live: false, gAt: NaN, dryAt: NaN, aAt: NaN, bAt: NaN, revAt: NaN,
              fbAt: NaN, pingAt: null, mixAt: NaN, dAt: dSec,
              m1, o2: null, m2: null, m1At: 1, m2At: 0,
              sHz: new Float64Array(SCHED_N), sAt: new Float64Array(SCHED_N).fill(-1), sN: 0 };
  return v;
}
// A line's delay in seconds: its time in steps at the eased speed, so it
// follows Speed as the old echo did.
const lineDelay = q => Math.min(ARP_DLY_MAX, num(q && q.dlyTime, 0.25, 4, 1.5) / arp.rate);
// A sequencer line's whole voice: the tone and its delay's repeats, then
// the line's own gain (its level times its mute and solo gate), which parts
// in two. The parting comes after the delay, so every repeat reaches the
// room and blooms there, not only the note that started them. One way is the
// mix's dry side (dg) onto the dry bus; the other is its wet side (rv),
// through its share of the level chain (rw, which the chain drives as it
// drives the dry bus) toward the line's own room, plugged in by seqSync
// once the line is heard with a mix above 0. The two sides are the reverb
// mix's pair of gains (see each line's reverb mix, above). Built the first
// time the line has a note and can be heard (seqSync), kept while it is
// heard, and let go once it falls silent and its room has rung out
// (lineRest), so a line nobody hears costs no oscillator at all.
function seqVoice(ctx, i) {
  const q = seqAt(i);
  const g = ctx.createGain(); g.gain.value = 0;
  const dg = ctx.createGain(); dg.gain.value = 1;
  const rv = ctx.createGain(); rv.gain.value = 0;
  const rw = ctx.createGain(); rw.gain.value = 0;
  g.connect(dg); dg.connect(arp.busD); g.connect(rv); rv.connect(rw);
  arp.chanG.connect(rw.gain);
  const v = lineVoice(ctx, q, -1, g, lineDelay(q));
  v.g = g; v.dg = dg; v.rv = rv; v.rw = rw;
  v.idle = null; v.fadeAt = 0;          // a pending let go (lineRest)
  lineShape(v, q, i);
  return v;
}
// Wave, pan, spread and the delay's routing onto a tone, each written only
// when it has moved: a param handed a fresh target it already has never
// settles (see arpPump). i is the line whose swung values it reads.
//
// The dry voice, the line's core, sits exactly on the line's pan, swing
// included; spread only moves the delay's repeats. This narrows the old
// behaviour on purpose: spread used to push the dry voice one way and the
// echo the other, so a wide line never sounded where its pan said. The
// old seat is kept by the lines' seated default pans instead (seqSeat in
// js/state.js).
//
// Ping pong bounces the repeats across the centre: the first lands at the
// core's mirror image (-pan), the next back on the core's own side (+pan),
// and on, each pushed out from the centre by spread. Which side is "away"
// is taken from the SET pan, not the swung one, so a pan swing that
// crosses the centre slides the repeats smoothly instead of flipping them;
// a line set dead centre answers to the right first, as the old echo did.
// In place, the repeats sit either side of the core's own pan by spread.
//
// The delay's send (dlyMix) is a plain gain on the repeats (egA, egB): 0
// sends nothing, 1 sends the voice whole into the taps, straight line
// between. The voice itself (dm) never moves; the knob only adds repeats on
// top. In place the two taps each carry half, so the pair sums to the one
// ping pong tap. It sits before the line gain, so the room still hears the
// voice and its repeats: the delay adds, then the reverb mixes that.
function lineShape(v, q, i) {
  if (!q) return;
  const wave = lineWave(q);
  if (v.o.type !== wave) { v.o.type = wave; glideParam(v.wg.gain, ARP_WAVE_GAIN[wave], 0.05); }
  lineMorph(v, q, wave);
  const pan = effPan[i], sp = clamp01(q.spread ?? 0.9);
  const ping = q.dlyPing !== false;
  let ap, bp;
  if (ping) {
    const set = +q.pan || 0, away = set > 0 ? -1 : set < 0 ? 1 : -v.panSign;
    ap = clampPan(-pan + away * sp); bp = clampPan(pan - away * sp);
  } else {
    ap = clampPan(pan - v.panSign * sp); bp = clampPan(pan + v.panSign * sp);
  }
  if (pan !== v.dryAt) { v.dryAt = pan; glideParam(v.dryP.pan, pan, 0.1); }
  if (ap !== v.aAt) { v.aAt = ap; glideParam(v.pA.pan, ap, 0.1); }
  if (bp !== v.bAt) { v.bAt = bp; glideParam(v.pB.pan, bp, 0.1); }
  if (ping !== v.pingAt) {
    v.pingAt = ping;
    glideParam(v.inB.gain, ping ? 0 : 1, 0.05);
    v.mixAt = NaN;             // the taps' level follows the routing
    v.fbAt = NaN;              // the loop gains swap paths with the routing
  }
  const mix = num(q.dlyMix, 0, 1, 0.5);
  if (mix !== v.mixAt) {
    v.mixAt = mix;
    const e = ping ? mix : mix / 2;
    glideParam(v.egA.gain, e, 0.05);
    glideParam(v.egB.gain, e, 0.05);
  }
  const fb = effFb[i];
  if (fb !== v.fbAt) {
    v.fbAt = fb;
    glideParam(v.aa.gain, ping ? 0 : fb, 0.1); glideParam(v.bb.gain, ping ? 0 : fb, 0.1);
    glideParam(v.ab.gain, ping ? fb : 0, 0.1); glideParam(v.ba.gain, ping ? fb : 0, 0.1);
  }
}
// A waveform crossfade: while a journey step ramps a line from one wave to
// another (core/journey.js), the line names the wave it is leaving
// (morphWave, 1 + its index in SEQ_WAVES) and how far it has come (morphMix,
// 0 to 1). The line's own tone is already the new wave; a second tone in the
// old one plays beside it, at the same pitch and under the same filter, so
// every note sounds both, and the two trade places on equal-power gains
// (sin and cos of the quarter turn), each scaled by its wave's loudness
// match, so the blend holds its level the whole way. As the second tone
// starts, the new one is dropped to silence and the wave gain set to the new
// wave's straight away, so the first instant sounds exactly as the old wave
// did; it is handed the pitches already queued ahead (the voice's ring of
// scheduled notes), so it is never out of tune with the phrase. With no morph
// named (the ramp landed, stopped, or someone changed the wave by hand) the
// second tone fades and stops, and the line's own tone is back at 1.
function lineMorph(v, q, wave) {
  const mw = q.morphWave | 0;
  const from = mw > 0 && mw <= SEQ_WAVES.length ? SEQ_WAVES[mw - 1] : null;
  const ctx = famCtx();
  if (!ctx) return;
  if (from && from !== wave) {
    const x = clamp01(+q.morphMix || 0);
    const a = Math.sin(x * Math.PI / 2);
    const b = Math.cos(x * Math.PI / 2) * ARP_WAVE_GAIN[from] / ARP_WAVE_GAIN[wave];
    if (!v.o2) {
      // The second tone is heard from the present (on Heart its start is
      // moved there), at the pitch the first holds there, and is handed the
      // notes queued after it, on their own times (spec 6.1: its first
      // value makes nothing late).
      const now = ctx.currentTime, at = heardNow(ctx, now);
      const o2 = ctx.createOscillator(), m2 = ctx.createGain();
      o2.type = from;
      o2.frequency.value = v.o.frequency.value;
      for (let k = 0; k < SCHED_N; k++) if (v.sAt[k] > at) o2.frequency.setTargetAtTime(v.sHz[k], v.sAt[k], 0.006);
      m2.gain.value = b;
      o2.connect(m2); m2.connect(v.filt);
      o2.start();
      v.o2 = o2; v.m2 = m2; v.m2At = b;
      v.wg.gain.cancelScheduledValues(now); v.wg.gain.setValueAtTime(ARP_WAVE_GAIN[wave], now);
      v.m1.gain.cancelScheduledValues(now); v.m1.gain.setValueAtTime(a, now);
      v.m1At = a;
      return;
    }
    if (v.o2.type !== from) v.o2.type = from;
    if (a !== v.m1At) { v.m1At = a; glideParam(v.m1.gain, a, 0.03); }
    if (b !== v.m2At) { v.m2At = b; glideParam(v.m2.gain, b, 0.03); }
    return;
  }
  if (v.o2) {
    const o2 = v.o2, m2 = v.m2;
    v.o2 = null; v.m2 = null;
    glideParam(m2.gain, 0, 0.03);
    // from the present, where the fade above is heard, so on Heart the fade
    // still has its whole quarter second before the stop
    try { o2.stop(heardNow(ctx) + 0.25); } catch (e) {}
    o2.onended = () => { try { o2.disconnect(); m2.disconnect(); } catch (e) {} };
  }
  if (v.m1At !== 1) { v.m1At = 1; glideParam(v.m1.gain, 1, 0.03); }
}
// The delay's time onto a tone, when it has moved: the easing creeps toward
// the dial for ever, so a change under a millionth (a fraction of a
// microsecond of delay) counts as none.
function lineDelayTo(ctx, v, q) {
  const d = lineDelay(q);
  if (Math.abs(d - v.dAt) <= d * 1e-6) return;
  v.dAt = d;
  v.dA.delayTime.setTargetAtTime(d, ctx.currentTime, 0.25);
  v.dB.delayTime.setTargetAtTime(d, ctx.currentTime, 0.25);
}
// Every line's voice brought to its settings: built when it first has a note
// and is heard, its gain glided to level times gate (0 with no notes), its
// mix, its room, its shape. Run from applyArp on a control change and from
// every pump, which is how a grid edit (it only saves) reaches the sound
// within a pump, and how the swings, which the pump advances, reach it.
// live marks the lines the pump schedules notes for; a silent one schedules
// nothing.
const seqLive = (q, solo) => !!q && clamp01(+q.vol || 0) > 0 && seqGate(q, solo) > 0 && seqHasNotes(q);
function seqSync() {
  const ctx = famCtx();
  if (!arp || !ctx) return;
  const solo = seqAnySolo();
  for (let i = 0; i < SEQ_COUNT; i++) {
    const q = seqAt(i);
    if (q) { seqEff(i, q); seqRange(i, q); }
    const vol = q ? clamp01(+q.vol || 0) : 0;
    const live = seqLive(q, solo);
    let v = arp.v[i];
    if (!v) {
      if (!live) continue;
      v = arp.v[i] = seqVoice(ctx, i);
    }
    v.live = live;
    const g = live ? vol : 0;
    if (g !== v.gAt) { v.gAt = g; glideParam(v.g.gain, g, GATE_TC); }
    lineRest(ctx, i, v);
    if (!q) continue;
    if (live && !v.roomed && num(q.rev, 0, 1, 1) > 0) { v.rw.connect(lineRoom(ctx, i).input); v.roomed = true; }
    const room = lineRooms[i], sec = lineRevTime(i);
    if (room && sec !== roomSec[i]) { roomSec[i] = sec; swapRoom(room, 200); }
    // the mix, swing included, onto its two sides; the dry side stays whole
    // while the room cannot be heard
    const turn = effRev[i] * QUARTER_TURN;
    const w = Math.sin(turn), d = roomHeard(room) ? Math.cos(turn) : 1;
    if (w !== v.revAt) { v.revAt = w; glideParam(v.rv.gain, w, 0.1); }
    if (d !== v.dgAt) { v.dgAt = d; glideParam(v.dg.gain, d, 0.1); }
    lineShape(v, q, i);
    if (i === 0 && arp.b) lineShape(arp.b, q, 0);
  }
}
// A line nobody can hear used to keep its whole voice: the tone, its
// filter, the delay's loop and its panners all working out silence for
// ever, and the line's room convolving the zeros they sent it, since a
// browser takes a fed convolver for a busy one whatever the samples are.
// Eight lines was eight voices and up to eight rooms of 15 s doing nothing
// but costing the audio thread, enough to underrun a phone. So a line that
// stops being heard (muted, solo'd away, at level 0, or out of notes) now
// lets its voice go, and seqSync builds it fresh, room plug and all, the
// moment the line is heard again. Its settings, swings and room are kept
// by line, so only the voice is new.
//
// Nothing that can still be heard is cut. The voice waits for its gain's
// fade to land (the glide's own length, a preset's transition included,
// plus ten time constants, as chainFeed waits; fadeAt), and then, if it
// is plugged into its room, for the room to ring all the way out from
// there: the longest of the line's reverb length, the length the room was
// last asked for and the impulse it is actually playing, past the end of
// any crossfade in the room too (whose outgoing side is heard until then),
// plus a margin. Only then is the room's input unplugged, so the tail
// never rests on the browser carrying a convolver on with nothing fed to
// it. The wait is measured again on the audio clock when the timer comes
// due, so a crossfade that landed meanwhile, or a context suspended
// mid-wait, simply pushes it later. A line heard again before then keeps
// its voice, as a chosen bed chain keeps its feed. Line 1 is kept while
// the parked answer exists, since the answer plays into line 1's gain.
const REST_PAD = 1.5;
function lineQuietAt(i, v) {
  const room = lineRooms[i];
  if (!v.roomed || !room) return v.fadeAt;
  const buf = room.live.c.buffer;
  const tail = Math.max(lineRevTime(i), roomSec[i], buf ? buf.duration : 0);
  return Math.max(v.fadeAt + tail, room.busyUntil) + REST_PAD;
}
function lineRest(ctx, i, v) {
  if (v.live) {
    if (v.idle) { clearTimeout(v.idle); v.idle = null; }
    return;
  }
  if (v.idle || (i === 0 && arp.b)) return;
  const a = arp;
  v.fadeAt = Math.max(glideEnd(), ctx.currentTime) + lateBy(ctx) + 10 * GATE_TC;
  const due = () => {
    v.idle = null;
    // the sequencer was stopped or the line heard again meanwhile
    if (arp !== a || a.v[i] !== v || v.live || (i === 0 && a.b)) return;
    if (seqLive(seqAt(i), seqAnySolo())) return;
    const left = lineQuietAt(i, v) - ctx.currentTime;
    if (left > 0) { v.idle = setTimeout(due, Math.max(250, left * 1000)); return; }
    // chanG drives rw's gain from outside the voice, so voiceOff alone
    // would leave the dead voice hanging off the level chain
    try { a.chanG.disconnect(v.rw.gain); } catch (e) {}
    voiceOff(v);
    a.v[i] = null;
  };
  v.idle = setTimeout(due, Math.max(0, lineQuietAt(i, v) - ctx.currentTime) * 1000);
}
// One note: the pitch steps (a few ms of glide, so the tone never clicks)
// and the filter opens toward the note's brightness over the attack, then
// falls back toward just above the fundamental over the decay, both the
// line's own as swung this pump. Targets are scheduled in order, so no
// cancel is ever needed; a fast figure simply catches the filter wherever
// the last fall left it. shift is the line's own octave plus its octave
// randomization, in whole octaves over the global Sequencer octave. The
// pitch is held under 0.45 of the sample rate, since a line's octave, its
// randomization and the global octave together can reach far past it. gain
// is the note's place on the high freq reduction's slope (hfGain), stepped
// with the pitch and written only when it moves, so with the tilt off it
// is never touched.
function arpNote(written, vel, at, v, shift, atk, dec, gain) {
  const oct = Math.round(S.arpOct || 0) + shift;
  const hz = Math.min(getContext().sampleRate * 0.45, ARP_ROOT_HZ * Math.pow(2, (written - ROOT) / 12 + oct));
  v.o.frequency.setTargetAtTime(hz, at, 0.006);
  if (gain !== v.hfAt) { v.hfAt = gain; v.hf.gain.setTargetAtTime(gain, at, 0.006); }
  // a waveform crossfade's second tone plays the same note (lineMorph), and
  // the ring keeps the note for a second tone that starts after it is queued
  if (v.o2) v.o2.frequency.setTargetAtTime(hz, at, 0.006);
  const s = v.sN++ % SCHED_N;
  v.sHz[s] = hz; v.sAt[s] = at;
  const open = Math.min(14000, hz * (5 + vel * 14));
  v.filt.frequency.setTargetAtTime(open, at, atk / 3);
  v.filt.frequency.setTargetAtTime(hz * 1.4, at + atk, dec / 3);
}
// The octaves a note moves by: the line's own octave, then per note its
// randomization, 'up' a lift of 0 to its count, 'down' a drop of 0 to its
// count, 'both' anything from minus the count to plus it, each whole
// octave equally likely.
const octBase = q => Math.max(-3, Math.min(3, Math.round(+q.oct || 0)));
const octCount = q => Math.max(1, Math.min(4, q.octaves | 0));
function noteShift(q) {
  const base = octBase(q);
  const m = q.octMode;
  if (m !== 'up' && m !== 'down' && m !== 'both') return base;
  const n = octCount(q);
  if (m === 'both') return base + Math.floor(Math.random() * (2 * n + 1)) - n;
  const r = Math.floor(Math.random() * (n + 1));
  return m === 'up' ? base + r : base - r;
}

// ---------- the high freq reduction ----------
// A slope laid over each line's own range, so the high notes stop
// screaming over the low ones as the level comes up: the lowest note the
// line can reach sounds as it always has, the highest comes down by the
// whole of S.arpHfCut (0 to 20 dB), and every note between sits on the
// straight line joining them, measured in semitones, so the tilt is even
// in dB all the way up. The range is the line's written notes inside its
// length, widened by its octave jumps: 'up' reaches its count of octaves
// over the highest note, 'down' as many under the lowest, 'both' both
// ways. The line's own octave and the global Sequencer octave move every
// note alike, so they leave the slope where it is. Kept per line by
// seqSync (lineLo, lineSpan, lineDn), which the pump runs before it
// schedules, so an edit is on the slope by its first note; a line of one
// repeated pitch and no jumps has no span, and no reduction.
const lineLo = new Float64Array(SEQ_COUNT), lineSpan = new Float64Array(SEQ_COUNT);
const lineDn = new Float64Array(SEQ_COUNT);
function seqRange(i, q) {
  const n = seqLen(q), st = q.steps;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) {
    const w = st[k];
    if (!(w >= 0)) continue;
    if (w < lo) lo = w;
    if (w > hi) hi = w;
  }
  if (lo > hi) { lineLo[i] = 0; lineSpan[i] = 0; lineDn[i] = 0; return; }
  const m = q.octMode, c = octCount(q);
  const up = m === 'up' || m === 'both' ? c : 0;
  const dn = m === 'down' || m === 'both' ? c : 0;
  lineLo[i] = lo; lineDn[i] = dn;
  lineSpan[i] = hi - lo + 12 * (up + dn);
}
// The note's level on the slope: written is its written pitch, jump the
// octaves its randomization moved it by (noteShift less the line's own
// octave), so its place is its semitones over the lowest reachable note.
function hfGain(i, written, jump) {
  const db = +S.arpHfCut || 0, span = lineSpan[i];
  if (!(db > 0) || !(span > 0)) return 1;
  const at = written - lineLo[i] + 12 * (jump + lineDn[i]);
  const x = at <= 0 ? 0 : at >= span ? 1 : at / span;
  return Math.pow(10, -Math.min(20, db) * x / 20);
}
function arpStart() {
  const ctx = famCtx();
  if (arp || !ctx || !dry || !room) return;
  // The bus's level chain (master level, strobe pulse, sweep, the 'arp'
  // channel gate) runs on a steady 1 rather than on the sound, and its output
  // drives the gain of the dry bus every line feeds, and of each line's own
  // way into its room (rw, seqVoice). So each line keeps its own reverb
  // amount and room while one chain still scales everything, dry and wet
  // alike, and the strobe pulse still lands before every room, not on its
  // tail.
  const ctrl = ctx.createConstantSource(); ctrl.offset.value = 1;
  const out = ctx.createGain(); out.gain.value = 0;
  // Vary with strobe: the strobe's own flash (+1 lit, -1 dark, strobe-am.js
  // strobeTap) swinging this gain around 1 - depth/2 by depth/2, so at full
  // depth the line pulses from full to silence on every flash, in step with
  // it, and at 0 the gain simply sits at 1.
  const amG = ctx.createGain();
  const amDepth = ctx.createGain();
  const amD = arpAmDepth();
  amG.gain.value = 1 - amD / 2; amDepth.gain.value = amD / 2;
  amDepth.connect(amG.gain);
  const amTap = strobeTap(ctx, amDepth);
  const swG = ctx.createGain(); swG.gain.value = 1;   // the volume sweep's own hand
  const chanG = ctx.createGain(); chanG.gain.value = chanGate('arp');
  ctrl.connect(out); out.connect(amG); amG.connect(swG); swG.connect(chanG);
  // the bus sits at 0 on its own, so the chain's output is its gain
  const busD = ctx.createGain(); busD.gain.value = 0;
  chanG.connect(busD.gain);
  // a meter tap on the dry bus feeding the piano's dry bus, as the drone's
  // is; the sends go into the lines' own rooms (lineRoom)
  const tap = meterTap(ctx, dry);
  busD.connect(tap.analyser);
  ctrl.start();
  arpVolSweep.start(ctx, swG.gain, 1);
  const now = ctx.currentTime;
  markT.fill(-1);
  // The 8 4 3 answer is parked for now (bNext never arrives): only the lines
  // play. Restore the old schedule, now + 16 + Math.random() * 14, to bring
  // the answering layer back; it answers line 1 and rides that line's gain.
  arp = { ctrl, out, amG, amTap, amDepth, swG, chanG, busD, tap,
          v: new Array(SEQ_COUNT).fill(null), b: null,
          rate: arpTargetRate(), next: heardNow(ctx, now) + 0.1, ia: 0, ib: 0,
          bOn: false, bUntil: 0, bTail: 0, bNext: Infinity, timer: null, tickAt: now };
  glideParam(out.gain, arpLevel(), 1.0);
  arpPump();
}
function arpPump() {
  if (!arp) return;
  const ctx = famCtx(), target = arpTargetRate();
  // The swings move by the audio clock's own time since the last pump, so a
  // suspended context holds them where they are, as a stopped sequencer does
  // (no pump runs at all then).
  const dt = ctx.currentTime - arp.tickAt;
  arp.tickAt = ctx.currentTime;
  // The two variances' step; only a moved depth rewrites its gains, so a
  // still dip costs nothing.
  const vd0 = effArpVolDepth, ad0 = effArpAmDepth;
  effArpVolDepth = arpDip(arpVolB, dip01(S.arpVolVar), S.arpVolPeriod, ctx.currentTime);
  effArpAmDepth = arpDip(arpAmB, dip01(S.arpStrobeAmVar), S.arpStrobeAmPeriod, ctx.currentTime);
  if (effArpVolDepth !== vd0) glideParam(arp.out.gain, arpLevel(), 0.25);
  if (effArpAmDepth !== ad0) {
    const amD = arpAmDepth();
    glideParam(arp.amG.gain, 1 - amD / 2, 0.25);
    glideParam(arp.amDepth.gain, amD / 2, 0.25);
  }
  if (dt > 0) seqAdvance(dt);
  seqSync();
  while (arp.next < ctx.currentTime + 0.6) {
    const t = arp.next;
    // The speed eases toward the dial over about a second and a half, note
    // by note, so a moved Speed accelerates or slows the figure instead of
    // jumping it to the new tempo mid-phrase.
    const step = 1 / arp.rate;
    arp.rate += (target - arp.rate) * (1 - Math.exp(-step / 1.5));
    if (!arp.bOn && t >= arp.bNext) {
      // the answer comes in and line 1 eases back; the answer's tone is
      // built the first time, into line 1's own gain
      const a = arp.v[0] || (arp.v[0] = seqVoice(ctx, 0));
      if (!arp.b) {
        arp.b = lineVoice(ctx, seqAt(0), 1, a.g, lineDelay(seqAt(0)));
        arp.b.inG.gain.value = 0;
        lineShape(arp.b, seqAt(0), 0);
      }
      arp.bOn = true; arp.bUntil = t + 8 + Math.random() * 8; arp.ib = 0;
      a.inG.gain.setTargetAtTime(ARP_DIP, t, 0.7);
      arp.b.inG.gain.setTargetAtTime(1, t, 0.7);
    } else if (arp.bOn && t >= arp.bUntil) {
      arp.bOn = false; arp.bTail = t + 3; arp.bNext = t + 16 + Math.random() * 14;
      arp.v[0].inG.gain.setTargetAtTime(1, t, 1.0);
      arp.b.inG.gain.setTargetAtTime(0, t, 1.0);
    }
    // every live line reads its own step off the shared count
    const c = arp.ia++;
    for (let i = 0; i < SEQ_COUNT; i++) {
      const v = arp.v[i];
      if (!v || !v.live) continue;
      const q = seqAt(i);
      if (!q) continue;
      const note = q.steps[c % seqLen(q)];
      if (!(note >= 0)) continue;
      const sh = noteShift(q);
      arpNote(note, 0.46 + Math.random() * 0.08, t, v, sh, effAtk[i], effDec[i], hfGain(i, note, sh - octBase(q)));
    }
    seqMark(t, c);
    if (arp.b && (arp.bOn || t < arp.bTail)) {
      // half a step off the main line, so the two interleave
      arpNote(ARP_B[arp.ib++ % 3], 0.42 + Math.random() * 0.08, t + step * 0.5, arp.b, 0, effAtk[0], effDec[0], 1);
    }
    arp.next += step;
  }
  // (The strobe pulse needs nothing here: it taps the flash itself, which
  // follows every change of rate and shape on its own.)
  // Every line's delay rides the eased speed too, its own count of steps
  // behind the note
  for (let i = 0; i < SEQ_COUNT; i++) if (arp.v[i]) lineDelayTo(ctx, arp.v[i], seqAt(i));
  if (arp.b) lineDelayTo(ctx, arp.b, seqAt(0));
  arp.timer = after(200, arpPump);
}
const VOICE_NODES = ['o', 'filt', 'hf', 'wg', 'inG', 'dm', 'dryP', 'dA', 'dB', 'inB', 'aa', 'ab', 'ba', 'bb',
                     'egA', 'egB', 'pA', 'pB', 'g', 'dg', 'rv', 'rw', 'm1', 'o2', 'm2'];
function voiceOff(v) {
  try { v.o.stop(); } catch (e) {}
  if (v.o2) try { v.o2.stop(); } catch (e) {}
  for (const k of VOICE_NODES) {
    if (v[k]) try { v[k].disconnect(); } catch (e) {}
  }
}
function arpStop() {
  if (!arp) return;
  const a = arp; arp = null;
  arpVolSweep.stop();
  clear(a.timer);
  // the whole sequencer goes below, so no line lets go on its own
  for (const v of a.v) if (v && v.idle) { clearTimeout(v.idle); v.idle = null; }
  glideParam(a.out.gain, 0, 0.8);
  setTimeout(() => {
    untapStrobe(a.amTap);
    try { a.amDepth.disconnect(); a.amG.disconnect(); } catch (e) {}
    try { a.ctrl.stop(); a.ctrl.disconnect(); a.out.disconnect(); a.swG.disconnect(); a.chanG.disconnect(); } catch (e) {}
    try { a.busD.disconnect(); a.tap.analyser.disconnect(); } catch (e) {}
    for (const v of a.v) if (v) voiceOff(v);
    if (a.b) voiceOff(a.b);
  }, 4000 + lateBy(famCtx()) * 1000);
}
// The switch, the master level (arpVol, over every line), the strobe pulse
// and the sweep, then every line's own settings through seqSync. The speed
// and the lines' delays ease from arpPump; nothing to jump here.
export function applyArp() {
  const want = running && S.arpOn;
  if (want && !arp) arpStart();
  else if (!want && arp) arpStop();
  if (!arp) return;
  glideParam(arp.out.gain, arpLevel(), 0.2);
  const amD = arpAmDepth();
  glideParam(arp.amG.gain, 1 - amD / 2, 0.05);
  glideParam(arp.amDepth.gain, amD / 2, 0.05);
  arpVolSweep.update();
  seqSync();
}

// A line's own settings only (its level, mute, solo, wave, envelope, pan,
// reverb and delay), for the sequencer window's per-line controls and
// worker mode's packed row: the master chain has not moved, so it is left
// alone. The envelope and the delay's time are read by the pump, so they
// are heard from its next pass.
export function applySeqs() { seqSync(); }

// The drone's own switch: parked or woken without touching the piano. Off
// mid-session fades it out through bedOff's ramp; on brings it back with its
// usual opening glide.
export function applyBedOn() {
  if (!running) return;
  if (S.bedOn !== false) bedOn(); else bedOff();
}

export async function pianoOn() {
  if (!ready && !(await loadPiano())) return false;
  const ctx = getContext();
  if (!ctx) return false;
  running = true;
  clock = ctx.currentTime + 0.4;
  elapsed = 0;
  step();
  if (S.bedOn !== false) bedOn();
  if (S.arpOn) arpStart();
  choirSession(true);
  layersSession(true);
  return true;
}
export function pianoOff() { running = false; clear(timer); bedOff(); arpStop(); choirSession(false); layersSession(false); }
export const pianoReady = () => ready;
export const pianoAvailable = () => canOpus;
