// The music's recordings, fetched at boot instead of at the first gesture.
// Fetching needs no gesture (only starting the sound does), so while the
// page sits waiting for the first key or click the connection is free: the
// drone, the piano, the clouds and the choir come down in the order of
// js/load-order.js and wait as raw bytes. The first gesture then only
// decodes them, and the drone is heard as soon as it is decoded.
//
// Called on the thread that owns the sound: main.js in main mode, the
// page's audio shell in worker mode. Anywhere else (the engine's worker has
// no audio context) it does nothing.
import { TURN, inTurn, prefetchBytes } from './load-order.js';
import { canOpus, droneFile, pianoFiles } from './piano.js';
import { cloudFiles } from './clouds.js';
import { choirFiles } from './choir.js';

export function prefetchMusic() {
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
  if (!canOpus) return;
  const quiet = p => p.catch(() => { /* the loader fetches afresh when it needs it */ });
  quiet(inTurn(TURN.drone, async () => { await prefetchBytes(await droneFile()); }));
  quiet(inTurn(TURN.piano, () => Promise.all(pianoFiles().map(prefetchBytes))));
  quiet(inTurn(TURN.clouds, () => Promise.all(cloudFiles().map(prefetchBytes))));
  quiet(inTurn(TURN.choir, () => Promise.all(choirFiles().map(prefetchBytes))));
}
