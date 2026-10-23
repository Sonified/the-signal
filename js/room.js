// The music's master room: the one reverb every music voice shares. The
// piano, its drone and sequencer, the choir, the layers, the clouds and the
// Sun's Rotational hum all play into its input, and its wet return joins
// the music family's master at the Reverb level, behind the Master reverb
// switch.
//
// It used to live inside the piano's graph (js/piano.js), which is built
// only once the piano's samples have been fetched, that is, only once the
// Music switch had been turned on. With the music off there was no room at
// all, and the hum, whose wet leg plays into it, sounded dry whatever its
// Reverb mix said. So the room is its own thing now, built as soon as the
// app's audio comes up (js/audio.js ensureAudioGraph, startRoom), on the
// music family's context, with no samples to wait for and no switch to
// gate it.
//
// Nothing gates the room itself. The pause gate (js/audio.js sourceGate)
// belongs to the sources: each voice closes its own way in on a pause (the
// piano's send, js/piano.js revIn, carries it for the notes, the drone,
// the sequencer, the choir, the layers and the clouds; the hum gates
// itself ahead of its split), so a pause stops what feeds the room while
// the room rings on.
import { S } from './state.js';
import { getContext, getMaster, createRoom, swapRoom, glideParam, glideEnd } from './audio.js';
import { onPhone } from './handheld.js';
import { peekCtxFor, peekMasterFor, makeWorklet, heartOn, onFallBack } from './heart/route.js';
import { every } from './ticker.js';
import { breath, breathState } from '../core/variance.js';
import { setHumBus } from '../core/sun-hum.js';

// The room's context, its input (what every voice feeds), the two ways
// into the reverb proper (convFeed for the convolution room, algoFeed for
// the network), the wet return, and the master it plays into through the
// Reverb high-pass (hp, below).
let ctx = null, input = null, wet = null, out = null, convFeed = null;
let room = null, algo = null, algoFeed = null, algoDead = false;
let breatheTimer = 0;

// On Heart a gesture anchored at currentTime is heard from the present,
// ctx.presentTime, about a lookahead later (js/piano.js has the same);
// lateBy is how much later than currentTime that is, which the type
// switch's unplug waits on top of the tail.
const lateBy = c => c.presentTime === undefined ? 0 : Math.max(0, c.presentTime - c.currentTime);

// Built at boot (js/audio.js), on the music family's context as route.js
// would hand it, without claiming it (peekCtxFor), so the family can still
// go native if Heart fails before any voice is built; the room follows it
// there (onFallBack, below). A room already built is left as it is: the
// piano may have come up first, on whatever context it was given.
export function startRoom() {
  if (ctx) return input;
  return buildRoom(peekCtxFor('music') || getContext(), peekMasterFor('music') || getMaster());
}

// The room on this context, for a voice about to play into it: the piano
// asks here as its graph is built (js/piano.js buildGraph), handing over the
// family's context it was given. On the room's own context this is just its
// input. On another (the family moved before the piano built) the room is
// rebuilt there, so every voice and the room share one context, as they
// must; the hum is told and follows.
export function roomInput(c, master) {
  if (!c || !master) return null;
  if (ctx === c) return input;
  return buildRoom(c, master);
}

// The wet return, where the sequencer's per-line rooms join the master
// room's output so they share its level and switch (js/piano.js lineRoom).
export const roomReturn = () => wet;
// The room's context, for a voice that sends into it only when it already
// shares it (js/brush-bells.js), never moving the room.
export const roomContext = () => ctx;

function buildRoom(c, master) {
  if (!c || !master) return null;
  if (ctx) teardown();
  ctx = c;
  wet = c.createGain(); wet.gain.value = revLevel();
  out = master;
  hpSwap(0);
  // The way into the reverb, whichever type plays it: every voice feeds
  // input, and input feeds the convolution room through convFeed or the
  // algorithmic one through its own feed (applyRevType).
  input = c.createGain();
  convFeed = c.createGain();
  input.connect(convFeed);
  // Two convolvers, so a new decay fades in under the old tail (audio.js).
  // A phone plays this room on the algorithmic one whatever the type says
  // (applyRevType), so it builds no convolution room unless that cannot be
  // made.
  if (!onPhone()) convRoom();
  applyRevType();
  // The room's two variances breathe on their own clock, whatever is or is
  // not playing into it (revBreathe), four times a second as the piano's
  // player used to step them.
  if (!breatheTimer) breatheTimer = every(250, () => { if (ctx) revBreathe(ctx.currentTime); });
  // The Sun's Rotational hum (core/sun-hum.js) sends its wet leg here, so
  // its Reverb mix is heard from boot, with the music on or off; on a
  // rebuild it moves to the new context with the room.
  setHumBus(c, input);
  return input;
}

// Let go of a room on a context the family has left. Anything still
// ringing there is dropped with it; this only happens when Heart fails, or
// when the family moves before its first voice is built.
function teardown() {
  clearTimeout(revUnplug); revUnplug = null;
  for (const n of [wet, input, convFeed, algoFeed, algo, room && room.output]) {
    try { n && n.disconnect(); } catch (e) {}
  }
  for (const ch of [hp, hpOld]) if (ch) hpUnplug(ch);
  clearTimeout(hpIdle); hpIdle = null;
  ctx = null; input = null; wet = null; out = null; convFeed = null;
  hp = null; hpOld = null;
  room = null; algo = null; algoFeed = null; algoDead = false;
  revAlgoNow = false;
}

// Heart failed after starting. If no music voice had been built yet the
// family goes native (js/heart/route.js fallBack), and the room, built on
// the family's Heart context without claiming it, follows it there.
onFallBack(() => {
  if (ctx && ctx.isHeart && !heartOn('music')) startRoomAfresh();
});
function startRoomAfresh() {
  buildRoom(peekCtxFor('music') || getContext(), peekMasterFor('music') || getMaster());
}

// Every gain here goes through glideParam (audio.js): a straight line over
// a preset's transition, the usual short approach for a slider.
// The Master reverb switch closes the room's wet output; the level below it
// is what the room plays at when it is open.
export function applyRoomLevel() {
  if (wet) glideParam(wet.gain, revLevel(), 0.08);
}

// The Reverb high-pass, on the return after everything that joins it
// (either reverb type and the sequencer's line rooms), so the room's low
// end can be thinned without touching the dry voices. 20 Hz is the floor
// and is effectively off. Its slope, in dB an octave:
//   6        a one-pole: the signal less the 'one-pole' processor's low-pass
//            (worklet.js, Heart's one_pole.rs), since BiquadFilterNode
//            starts at 12;
//   12 to 48 Butterworth of order 2 to 8, flat to the cutoff with no bump:
//            biquads, with that one-pole in front for an odd order;
//   3        half an order, which no filter has exactly, so eight one-pole
//            shelves an octave apart below the cutoff, each rising 6 dB an
//            octave for half an octave and flat for the other half: 3 on
//            average, to within a fraction of a dB, down to 24 dB at the
//            bottom, eight octaves under the cutoff and well under hearing.
// Only the chosen slope's chain is built; a new slope builds its chain and
// crossfades to it, and the old one is unplugged once it has faded.
const HP_XF_TC = 0.03;
const revHP = () => Math.max(20, +S.pianoRevHP || 20);
const revHPSlope = () => HP_SLOPES.includes(S.pianoRevHPSlope) ? S.pianoRevHPSlope : 12;
export const HP_SLOPES = [3, 6, 12, 18, 24, 30, 36, 42, 48];
let hp = null, hpOld = null, hpIdle = null;

// Butterworth's biquad Qs for order n, lowest first; an odd order's real
// pole is the one-pole in front.
function butterQs(n) {
  const qs = [];
  for (let k = 1; k <= n >> 1; k++) {
    const th = n % 2 ? k * Math.PI / n : (2 * k - 1) * Math.PI / (2 * n);
    qs.push(1 / (2 * Math.cos(th)));
  }
  return qs;
}
// A chain's stages, in order, each with the frequency params it moves and
// each param's multiple of the cutoff.
function hpStages(c, slope) {
  const st = [];
  // The signal less depth times its one-pole low-pass at mul times the
  // cutoff: depth 1 is a first-order high-pass, less is a shelf.
  const onePole = (mul, depth) => {
    const lp = makeWorklet(c, 'one-pole', { outputChannelCount: [2] });
    const into = c.createGain(), less = c.createGain(), sum = c.createGain();
    less.gain.value = -depth;
    into.connect(sum); into.connect(lp); lp.connect(less); less.connect(sum);
    st.push({ in: into, out: sum, params: [[lp.parameters.get('frequency'), mul]], nodes: [into, lp, less, sum] });
  };
  if (slope === 3) {
    for (let k = 0; k < 8; k++) onePole(2 ** -k, 1 - Math.SQRT1_2);
    return st;
  }
  const n = slope / 6;
  if (n % 2) onePole(1, 1);
  for (const q of butterQs(n)) {
    const f = c.createBiquadFilter();
    // the spec reads a high-pass's Q in dB
    f.type = 'highpass'; f.Q.value = 20 * Math.log10(q);
    st.push({ in: f, out: f, params: [[f.frequency, 1]], nodes: [f] });
  }
  return st;
}
// A one-pole that cannot be made (its module missing) leaves the slope at
// 12, which needs none.
function hpChain(c, slope) {
  let st;
  try { st = hpStages(c, slope); }
  catch (e) {
    console.warn('room: the reverb high-pass slope is unavailable, playing 12 dB', e);
    st = hpStages(c, 12);
  }
  for (let k = 1; k < st.length; k++) st[k - 1].out.connect(st[k].in);
  const level = c.createGain();
  level.gain.value = 0;
  st[st.length - 1].out.connect(level);
  return { slope, st, level };
}
function hpTune(ch, tc) {
  const f = revHP();
  for (const s of ch.st) for (const [prm, mul] of s.params) {
    if (tc > 0) glideParam(prm, f * mul, tc); else prm.value = f * mul;
  }
}
function hpUnplug(ch) {
  try { wet && wet.disconnect(ch.st[0].in); } catch (e) {}
  for (const s of ch.st) for (const n of s.nodes) { try { n.disconnect(); } catch (e) {} }
  try { ch.level.disconnect(); } catch (e) {}
}
// Build the chosen slope's chain and fade it in over the one playing; tc 0
// (the room just built) opens it at once.
function hpSwap(tc) {
  const slope = revHPSlope();
  if (hp && hp.slope === slope) return;
  const next = hpChain(ctx, slope);
  hpTune(next, 0);
  wet.connect(next.st[0].in);
  next.level.connect(out);
  if (!(tc > 0) || !hp) { next.level.gain.value = 1; if (hp) hpUnplug(hp); hp = next; return; }
  // a chain still fading out from the last change goes now
  clearTimeout(hpIdle);
  if (hpOld) hpUnplug(hpOld);
  hpOld = hp; hp = next;
  glideParam(hp.level.gain, 1, tc);
  glideParam(hpOld.level.gain, 0, tc);
  const c = ctx, old = hpOld;
  // glideEnd is a native-clock time, measured against the native clock;
  // after a skip the room's Heart clock leads it and would come up short.
  const wait = Math.max(0, glideEnd() - getContext().currentTime) + lateBy(c) + 10 * tc;
  hpIdle = setTimeout(() => {
    hpIdle = null;
    if (ctx !== c || hpOld !== old) return;     // the room was rebuilt meanwhile
    hpUnplug(old); hpOld = null;
  }, wait * 1000);
}
export function applyRevHP() {
  if (hp) hpTune(hp, 0.05);
}
export function applyRevHPSlope() {
  if (wet) hpSwap(HP_XF_TC);
}

// The room's two variances, each the app's standard dip (core/variance.js
// breath, the sinusoid): the level and the decay ease down from their
// settings by the amount's share and back, one cycle per its speed (an unset
// speed reads as 20 s), stepped on the audio clock (breatheTimer, above), so
// a suspended context holds them. The decay plays in the slider's half
// seconds, no shorter than its 1 s floor, so the convolution room builds a
// new impulse only when the dip crosses a step; the algorithmic one takes it
// as it moves. schema-audio.js reads the two effectives for the sliders'
// glowing bars.
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
// impulse. Both are fed from input and both play into wet, so the level, the
// switch and the sequencer's rooms are the same either way. A change
// crossfades the feeds, not the outputs, so the old reverb's tail rings out
// under the new one; once it has, the old one's feed is unplugged and it
// falls idle. The network is made the first time it is chosen; if its module
// did not load, the type stays on convolution.
//
// A phone plays the algorithmic one unless its viewer picked Convolution,
// lighter on its audio thread than a long convolution: the phone's own
// choice (S.phoneRevType, a machine setting), so the show's type is left as
// the show has it (schema-audio.js). The damping and drift are the show's own only when the
// show chose this reverb; under Convolution they are hidden and unheard on
// a desktop, so a phone plays the network's defaults.
let revAlgoNow = false, revUnplug = null;
const wantAlgo = () => onPhone() ? S.phoneRevType !== 'conv' : S.musicRevType === 'algo';
function convRoom() {
  if (room) return room;
  room = createRoom(ctx, revSec, 2.0);
  room.output.connect(wet);
  convFeed.connect(room.input);
  return room;
}
function algoNode() {
  if (algo || algoDead) return algo;
  try {
    algo = makeWorklet(ctx, 'fdn-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  } catch (e) {
    console.warn('room: algorithmic reverb unavailable, staying on convolution', e);
    algoDead = true;
    return null;
  }
  algoFeed = ctx.createGain();
  algoFeed.gain.value = 0;
  input.connect(algoFeed);
  algo.connect(wet);
  return algo;
}
function algoTune(tc) {
  if (!algo) return;
  const p = algo.parameters;
  glideParam(p.get('decay'), revDecay(), tc);
  const own = S.musicRevType === 'algo';
  glideParam(p.get('damping'), own ? revDip01(S.pianoRevDamp ?? 0.35) : 0.35, tc);
  glideParam(p.get('mod'), own ? revDip01(S.pianoRevMod ?? 0.3) : 0.3, tc);
}
export function applyRevType() {
  if (!input) return;
  const toAlgo = wantAlgo() && !!algoNode();
  // a phone whose network could not be made falls back to the room after all
  if (!toAlgo) convRoom();
  // On a phone the type can change while the network plays on, which moves
  // only its damping and drift between the show's and the defaults.
  if (toAlgo === revAlgoNow) { if (toAlgo && onPhone()) algoTune(0.05); return; }
  revAlgoNow = toAlgo;
  const on = toAlgo ? algoFeed : convFeed, off = toAlgo ? convFeed : algoFeed;
  // the incoming reverb catches up on any decay it missed while idle
  if (toAlgo) algoTune(0.02); else swapRoom(room);
  clearTimeout(revUnplug);
  on.connect(toAlgo ? algo : room.input);
  glideParam(on.gain, 1, 0.05);
  glideParam(off.gain, 0, 0.05);
  const c = ctx;
  revUnplug = setTimeout(() => {
    revUnplug = null;
    try { off.disconnect(); } catch (e) {}
  }, (S.pianoRevTime + 1.5 + lateBy(c)) * 1000);
}
// The algorithmic reverb's own two: its damping and its drift.
export function applyPianoRevShape() {
  algoTune(0.05);
}
// Crossfaded into the room rather than swapped under a ringing tail.
export function rebuildPianoIR() {
  if (revAlgoNow) algoTune(0.05); else swapRoom(room, 200);
}
