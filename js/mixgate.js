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
// The gate is read on control changes only, never per frame, and allocates
// nothing when it is.
import { S } from './state.js';

export const CHANNELS = ['fund', 'harm', 'pulse', 'piano', 'clouds', 'drone', 'arp'];

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
export function chanGate(ch) {
  if (flag(S.chanMute, ch)) return 0;
  return anySolo() && !flag(S.chanSolo, ch) ? 0 : 1;
}

// The same answer for one atmosphere recording's layer object.
export function layerGate(layer) {
  if (!layer || layer.muted) return 0;
  return anySolo() && !layer.solo ? 0 : 1;
}

// Whether a fixed channel is being held silent by the gate, for a mixer that
// wants to dim it.
export const chanSilenced = ch => chanGate(ch) === 0;

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

// The one call every mute or solo change makes: every gate, everywhere.
export function applyMixGates() {
  lastLayerSolo = layerSoloed();
  applyChannelGates();
  if (layerApplier) layerApplier();
}
