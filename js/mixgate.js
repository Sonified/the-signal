// The mix gate: mute and solo across the whole mix.
//
// Every track that can be heard is either one of the six fixed channels (the
// fundamental, its harmonics, the pulse train, the piano, the clouds and the
// ocean drone) or one of the atmosphere recordings. The fixed channels keep
// their flags on S.chanMute and S.chanSolo; the recordings keep theirs on
// their own layer objects, as they always have. A track's gate is then one
// answer for all of them: closed if it is muted, closed if anything anywhere
// is soloed and it is not, open otherwise. So solo is a mix-wide solo: soloing
// the piano silences the tones, the clouds, the drone and every recording,
// and soloing a recording silences the six channels in the same way.
//
// The gate is a multiplier applied at each channel's existing level control,
// never a second copy of the level, so a fader moved while its track is muted
// still lands where it was put and is heard the moment the mute comes off.
//
// This module holds no audio nodes. Each engine module registers how it
// re-applies its own gate (audio.js for the worklet levels, piano.js and
// clouds.js for their gain nodes, ambience.js for the recordings), which keeps
// the dependency pointing one way: the engines import this, never the reverse.
// The gate is read on control changes, and every frame only while one is
// gliding (below), and allocates nothing when it is.
//
// A gate glides rather than flips. The mute and solo switches, and the answer
// above of which tracks may sound, change at once, so the mixer shows where
// the mix is going the moment it is asked; what each engine multiplies in
// (chanGate, layerGate) travels from where it was to that answer over a
// glide, and while any is on its way the engines are asked to re-apply every
// frame (stepMixGates, from the frame loop of whichever thread plays the
// sound: main.js in main mode, the page's audio shell in worker mode), so a
// mute slides the track down and an unmute brings it up, and a solo, which
// moves every other track's answer, glides them all together. The fader is
// never touched: a channel's audible gain is its level times this gate, and
// only the gate moves. A hand's flip glides over GATE_GLIDE_S, enough to
// take the click out and still feel immediate; a journey step asks for its
// whole ramp (applyMixGates(sec)). A per-frame writer of the same gain (a
// variance breathing the drone, a trim on its way) reads the gate where the
// glide has got to, so it never cuts the glide short.
import { S } from './state.js';
import { MUSIC_LAYERS } from './layer-defs.js';

// The music layers (js/layer-defs.js) each have a channel of their own id.
// 'hum' is the Sun's Rotational hum (core/sun-hum.js), 'heart' the
// Heartbeat layer's recording (core/heartbeat.js).
export const CHANNELS = ['fund', 'harm', 'pulse', 'piano', 'clouds', 'drone', 'arp', 'choir',
  ...MUSIC_LAYERS.map(L => L.id), 'hum', 'heart'];

function flag(obj, ch) { return !!(obj && obj[ch]); }

// Whether any recording is soloed, on its own, because a change in this one
// answer is what obliges the six channels to re-apply (see layerSoloChanged).
function layerSoloed() {
  const layers = S.ambLayers;
  if (layers) for (let i = 0; i < layers.length; i++) if (layers[i] && layers[i].solo) return true;
  return false;
}

// Whether any track at all, channel or recording, is soloed.
export function anySolo() {
  const cs = S.chanSolo;
  if (cs) for (let i = 0; i < CHANNELS.length; i++) if (cs[CHANNELS[i]]) return true;
  return layerSoloed();
}

// 1 when the channel may sound, 0 when mute or someone else's solo holds it.
function chanAnswer(ch) {
  if (flag(S.chanMute, ch)) return 0;
  return anySolo() && !flag(S.chanSolo, ch) ? 0 : 1;
}

// The same answer for one atmosphere recording's layer object.
function layerAnswer(layer) {
  if (!layer || layer.muted) return 0;
  return anySolo() && !layer.solo ? 0 : 1;
}

// ---------- the glide ----------
// Each channel's gate as last applied: where it set off from, the answer it
// is headed for, when it set off and over how long (seconds on the
// performance clock, the same on the page and in the worker), in typed arrays
// indexed as CHANNELS; to is -1 until the channel's gate is first read. Each
// recording's the same, in one small record per layer object, made the first
// time it is read. chanUntil and layerUntil are when the last glide of each
// kind lands, 0 with none on its way.
export const GATE_GLIDE_S = 0.75;
const N = CHANNELS.length;
const CH_AT = new Map(CHANNELS.map((ch, k) => [ch, k]));
const gFrom = new Float64Array(N), gTo = new Float64Array(N).fill(-1);
const gT0 = new Float64Array(N), gDur = new Float64Array(N);
const lyGlide = new WeakMap();
let chanUntil = 0, layerUntil = 0;
const clock = () => performance.now() / 1000;
// Where a glide is at time now: eased at both ends (the journey's smoothstep),
// at its answer once its time is up.
function along(from, to, t0, dur, now) {
  if (!(dur > 0)) return to;
  const u = (now - t0) / dur;
  if (u >= 1) return to;
  if (u <= 0) return from;
  return from + (to - from) * u * u * (3 - 2 * u);
}

// The gate each engine multiplies into the channel's level: the answer, or,
// while a glide is carrying the channel to it, where the glide has got to.
// An answer that moved without applyMixGates (nothing should) is taken at
// once, as every answer was before gates glided.
export function chanGate(ch) {
  const want = chanAnswer(ch);
  const k = CH_AT.get(ch);
  if (k === undefined) return want;
  if (gTo[k] !== want) { gFrom[k] = gTo[k] = want; gDur[k] = 0; return want; }
  return gDur[k] > 0 && chanUntil ? along(gFrom[k], want, gT0[k], gDur[k], clock()) : want;
}

// The same for one atmosphere recording's layer object.
export function layerGate(layer) {
  const want = layerAnswer(layer);
  if (!layer) return want;
  const g = lyGlide.get(layer);
  if (!g) { lyGlide.set(layer, { from: want, to: want, t0: 0, dur: 0 }); return want; }
  if (g.to !== want) { g.from = g.to = want; g.dur = 0; return want; }
  return g.dur > 0 && layerUntil ? along(g.from, want, g.t0, g.dur, clock()) : want;
}

// Whether a fixed channel is being held silent by the gate, for a mixer that
// wants to dim it: the answer, so the strip dims as the mute is pressed, while
// the sound under it glides down.
export const chanSilenced = ch => chanAnswer(ch) === 0;

// ---------- appliers ----------
const channelAppliers = [];
let layerApplier = null;
export function onChannelGates(fn) { channelAppliers.push(fn); }
export function onLayerGates(fn) { layerApplier = fn; }

function applyChannelGates() {
  for (let i = 0; i < channelAppliers.length; i++) channelAppliers[i]();
}

// Called by ambience.js whenever its layers are re-synced. A recording's solo
// switching on or off changes every fixed channel's gate as well, but most
// syncs (a level fader, the drift's crossfade) touch no solo at all, so the
// channels are only re-applied when the answer has actually changed.
let lastLayerSolo = false;
export function layerSoloChanged() {
  const now = layerSoloed();
  if (now === lastLayerSolo) return;
  lastLayerSolo = now;
  applyChannelGates();
}

// The one call every mute or solo change makes: every gate, everywhere. Each
// gate whose answer moved sets off toward it from wherever it is now, over
// sec seconds: a journey step's ramp, or, unasked, the gate glide a batch
// from the engine worker carries (holdMixGateGlide), else GATE_GLIDE_S, a
// hand's flip. Then every engine re-applies once, as it always has, and
// stepMixGates carries the glides on from the next frame.
export function applyMixGates(sec) {
  const asked = typeof sec === 'number' && sec >= 0;
  if (asked) { askN++; askSec = sec; }
  const s = asked ? sec : batchSec >= 0 ? batchSec : GATE_GLIDE_S;
  const now = clock();
  lastLayerSolo = layerSoloed();
  for (let k = 0; k < N; k++) {
    const want = chanAnswer(CHANNELS[k]);
    if (gTo[k] === want) continue;
    // a channel never read has nothing sounding through its gate yet
    if (gTo[k] < 0 || !(s > 0)) { gFrom[k] = gTo[k] = want; gDur[k] = 0; continue; }
    gFrom[k] = along(gFrom[k], gTo[k], gT0[k], gDur[k], now);
    gTo[k] = want; gT0[k] = now; gDur[k] = s;
    if (now + s > chanUntil) chanUntil = now + s;
  }
  const layers = S.ambLayers;
  if (layers) {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i], g = l && lyGlide.get(l);
      if (!g) continue;
      const want = layerAnswer(l);
      if (g.to === want) continue;
      if (!(s > 0)) { g.from = g.to = want; g.dur = 0; continue; }
      g.from = along(g.from, g.to, g.t0, g.dur, now);
      g.to = want; g.t0 = now; g.dur = s;
      if (now + s > layerUntil) layerUntil = now + s;
    }
  }
  applyChannelGates();
  if (layerApplier) layerApplier();
}

// Once a frame from the loop of the thread that plays the sound (and, as a
// no-op for the sound, in the engine worker, which keeps its own copy of the
// answers): while a gate is gliding, every engine re-applies its gates at
// where the glides have got to, and once the last has landed, a final time
// at the answers. Nothing at all while none is.
export function stepMixGates() {
  if (!chanUntil && !layerUntil) return;
  const now = clock();
  if (chanUntil) {
    applyChannelGates();
    if (now >= chanUntil) chanUntil = 0;
  }
  if (layerUntil) {
    if (layerApplier) layerApplier();
    if (now >= layerUntil) layerUntil = 0;
  }
}
// Whether a gate is on its way: the still frame (main.js) stays awake for it.
export const mixGatesBusy = () => chanUntil > 0 || layerUntil > 0;

// The glide's length across the worker link (core/audio-link.js). The worker
// counts each glide a caller asked for and keeps its length (askN, askSec);
// the link sends the length to the page ahead of the switches that moved, and
// the page holds it for that batch of calls (holdMixGateGlide, -1 letting go),
// so the switches' own set() there glides their gates as long as the worker
// asked. A hand's flip asks for nothing and glides GATE_GLIDE_S on both sides.
let askN = 0, askSec = 0, batchSec = -1;
export const mixGateAsk = () => askN;
export const mixGateAskSec = () => askSec;
export function holdMixGateGlide(sec) { batchSec = typeof sec === 'number' && sec >= 0 ? sec : -1; }
