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
import { getContext, getMaster, createRoom, swapRoom, glideParam } from './audio.js';
import { onPhone } from './handheld.js';
import { peekCtxFor, peekMasterFor, makeWorklet, heartOn, onFallBack } from './heart/route.js';
import { every } from './ticker.js';
import { breath, breathState } from '../core/variance.js';
import { setHumBus } from '../core/sun-hum.js';

// The room's context, its input (what every voice feeds), the two ways
// into the reverb proper (convFeed for the convolution room, algoFeed for
// the network) and the wet return to the master.
let ctx = null, input = null, wet = null, convFeed = null;
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

function buildRoom(c, master) {
  if (!c || !master) return null;
  if (ctx) teardown();
  ctx = c;
  wet = c.createGain(); wet.gain.value = revLevel();
  wet.connect(master);
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
  ctx = null; input = null; wet = null; convFeed = null;
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
