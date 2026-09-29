// The music layers: single recordings that loop under the music, each with its
// own switch and level (js/layers.js plays them). This table is the whole of a
// layer's definition. Everything else is built from it: the state defaults
// and the mix gate's channels (state.js, mixgate.js), the saved settings
// (v1/core/store.js), the Music section's toggle, sub-drawer and level, the
// mixer strip and its meter (v1/core/schema-audio.js, atmosphere.js,
// v1/ui/screens/mixer.js). A new layer is one entry here plus its loop in
// audio/music/layers.
//
// It imports nothing, so state.js and mixgate.js can read it without a cycle.
//
// Each loop is baked seamless into its file (audio/music/layers/manifest.json
// has how): exactly `samples` long at 48 kHz, played end to start with
// nothing added at run time. `level` is the gain at 100 %, set so 100 % sits
// about 2 dB under the ocean drone at its default level, where the choir
// sits: measured, drone -23.9 LUFS at 30 %; majestic loop -11.5 LUFS at unity,
// fifth -18.0, so 0.19 and 0.40 put both at about -26 LUFS.
// Both parked for now, not in use yet: out of the drawer and the mixer until
// they are. Uncomment a line to bring its layer back everywhere at once.
export const MUSIC_LAYERS = [
  // { id: 'majestic', label: 'Majestic voice', file: 'audio/music/layers/majestic.opus', samples: 576000, level: 0.19 },
  // { id: 'fifth',    label: 'Bright fifth',   file: 'audio/music/layers/fifth.opus',    samples: 480000, level: 0.40 }
];

// The names every other file uses for one layer, so none of them spells a
// key by hand: S.<id>On and S.<id>Vol, the mix gate's channel <id>, the
// mixer's fader mix<Id> (the name journey.js derives from the channel), and
// the Music section's sub-drawer.
const cap = id => id[0].toUpperCase() + id.slice(1);
export const layerOnKey  = L => L.id + 'On';
export const layerVolKey = L => L.id + 'Vol';
export const layerMixId  = L => 'mix' + cap(L.id);
export const layerDrawerId = L => 'music' + cap(L.id) + 'Drawer';

// Off and at 100 %, so no saved session or preset changes.
export function layerDefaults() {
  const d = {};
  for (const L of MUSIC_LAYERS) { d[layerOnKey(L)] = false; d[layerVolKey(L)] = 1.0; }
  return d;
}
export function layerChannelFlags() {
  const d = {};
  for (const L of MUSIC_LAYERS) d[L.id] = false;
  return d;
}
