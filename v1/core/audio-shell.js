// The page's half of worker mode (see core/engine-thread.js): everything that
// has to stay on the main thread because an AudioContext cannot leave it.
// With the engine in a worker, this is all the page runs besides the input
// and canvas shell in platform/worker-bridge.js: the v0 audio modules
// (js/audio.js, piano, clouds, ambience, mixgate) exactly as main mode uses
// them, with their own copy of S, loaded from the same stored settings, for
// them to read.
//
// The worker owns the settings. This copy of S is kept in step three ways,
// all of which end in the same schema set() calls main mode makes, so every
// side effect, glide and ramp is v0's own:
//
//   the worker's per-frame moves arrive as calls (core/audio-link.js lists
//   them) and run through CALLS below;
//
//   the worker's settings records arrive as it writes them, and go through
//   store.syncFromStorage with presets.replayLive, exactly as another tab's
//   write would, which picks up whatever the calls did not carry (a preset's
//   direct state, recording peaks) and glides it in;
//
//   another tab's write goes through the same path here and in the worker
//   alike, each applying it to its own copy.
//
// A set() arriving for a position this copy already has is skipped, the same
// rule replayLive follows, so a change that reached the page twice (as a call
// and inside a record, or from another tab and then echoed by the worker)
// never starts a voice a second time.
//
// This copy of the store never writes: its storage's set does nothing, so
// the saves every set() ends with are no-ops here, and the worker's records
// are the only ones written.
//
// The drift runs here too, on the audio clock, and the meters are read here.
// tick(t) steps both once a frame (the page's own requestAnimationFrame, in
// the bridge; the strobe is not on this thread in worker mode) and fills the
// readings the worker shows (layout in core/audio-mirror.js), handing them
// back when a post is due.

import { S } from '../../js/state.js';
import {
  ensureAudioGraph, warmDevice, audioOn, setAmRate, hasNode, beginGlide, endGlide, PRESET_GLIDE_S
} from '../../js/audio.js';
import { arpPeak, seqPlayhead, SEQ_SLOTS, SEQ_MAX } from '../../js/piano.js';
import { ambDriftOn } from '../../js/ambience.js';
import { CONTROLS } from './schema.js';
import { audioToggleEffects } from './schema-audio.js';
import {
  ambLayerControls, AMB_LAYER_COUNT, initAtmosphere, stepAtmosphere, setDriftHook,
  packAtmosphere, ATMOSPHERE_SLOTS
} from './atmosphere.js';
import { initStore, load, syncFromStorage } from './store.js';
import { replayLive } from './presets.js';
import {
  M_FLAGS, M_DRIFT, M_ARP, M_HEAD, M_ATMOS, F_AUDIO, F_WORKLET, F_DRIFT,
  DRIFT_MOVING, DRIFT_LANDED, W_METERS, W_PLAYHEAD, W_ARP, CALL_SLOTS
} from './audio-mirror.js';

// Post cadence for the readings: the arp's peak drives a visual envelope, so
// it goes about every 60 Hz frame while watched; meters and the playhead are
// fine at about 30 Hz.
const ARP_POST_MS = 15, METER_POST_MS = 33;

// storage is { get(key) } over the page's localStorage; nothing is ever set.
export function createAudioShell(storage) {
  initStore({ get: storage.get, set() {} });
  load();
  initAtmosphere();

  // Every control a call can name: the schema's, and the mixer's
  // per-recording rows, which live outside it.
  const byName = new Map();
  for (const c of CONTROLS) byName.set(c.id, c);
  for (let i = 0; i < AMB_LAYER_COUNT; i++) {
    const row = ambLayerControls(i);
    byName.set(row.level.id, row.level); byName.set(row.mute.id, row.mute); byName.set(row.solo.id, row.solo);
  }

  // Whether a preset's glide is open on this side (set calls marked glide).
  let gliding = false;
  let watch = 0;

  // The call registry. Each takes up to four arguments, as the link sends them.
  const CALLS = {
    // A control's position moved in the worker: run its own set() here.
    set(id, pos) {
      const c = byName.get(id);
      if (c && c.get(S) !== pos) c.set(S, pos);
    },
    // The audio half of toggleRun (main.js); the visual half ran in the worker.
    run(on) {
      S.running = !!on;
      audioToggleEffects(S);
    },
    // strobe.js's AM link and the arp's strobe pulse, from the worker's rates.
    strobe(eff, achieved) {
      S.effFreq = eff; S.achievedFreq = achieved;
      if (S.amLinked && hasNode() && Math.abs(S.effFreq - S.lastAmSet) > 0.01) {
        setAmRate(S.effFreq); S.lastAmSet = S.effFreq;
      }
    },
    // The sequencer's slot and patterns, unpacked in place (the arp reads them
    // at every step, so the next step plays the edit).
    seq(p) {
      S.seqSlot = p[0];
      let k = 1;
      for (let i = 0; i < SEQ_SLOTS; i++) {
        const pat = S.seqPatterns[i];
        const len = p[k++];
        if (!pat) { k += SEQ_MAX; continue; }
        pat.len = len;
        for (let j = 0; j < SEQ_MAX; j++) pat.steps[j] = p[k++];
      }
    },
    watch(bits) { watch = bits; }
  };

  let warned = false;
  // Runs one batch of calls, in order. A run of set calls marked glide (a
  // preset recalled in the worker) shares one transition, opened and closed
  // around it, as presets.js does around its own set() calls.
  function runCalls(calls) {
    try {
      for (let i = 0; i + CALL_SLOTS <= calls.length; i += CALL_SLOTS) {
        const fn = calls[i];
        const glide = fn === 'set' && !!calls[i + 3];
        if (glide && !gliding) { beginGlide(PRESET_GLIDE_S); gliding = true; }
        else if (!glide && gliding) { endGlide(); gliding = false; }
        const h = CALLS[fn];
        if (!h) continue;
        try { h(calls[i + 1], calls[i + 2], calls[i + 3], calls[i + 4]); }
        catch (e) { if (!warned) { warned = true; console.warn('audio shell: a call from the engine worker failed', fn, e); } }
      }
    } finally {
      if (gliding) { endGlide(); gliding = false; }
    }
  }

  // A settings record: the worker's own write, or another tab's. Returns
  // whether the key was one of the two settings records.
  function storageChanged(key, value) {
    return syncFromStorage(key, value, replayLive);
  }

  // The first gesture wakes the output device, as main.js does in main mode,
  // but here, inside the gesture's own event handler, where a browser that
  // wants user activation for resume() is sure to see it.
  let woken = false;
  function wake() {
    if (woken) return;
    woken = true;
    warmDevice();
    if (S.audioOnBoot !== false && !S.audioEnabled) audioOn();
  }

  // ---- the readings ----
  const readings = new Float32Array(M_ATMOS + ATMOSPHERE_SLOTS);
  let driftCode = 0, lastFlags = -1, lastPost = -1e9;
  setDriftHook(moved => {
    const c = moved === 'landed' ? DRIFT_LANDED : DRIFT_MOVING;
    if (c > driftCode) driftCode = c;
  });

  // Once a page frame. Returns the readings when a post is due (the caller
  // posts a copy), otherwise null.
  function tick(t) {
    stepAtmosphere(t, !!(watch & W_METERS));
    const drifting = ambDriftOn();
    const flags = (S.audioEnabled ? F_AUDIO : 0) | (S.workletReady ? F_WORKLET : 0) | (drifting ? F_DRIFT : 0);
    const since = t - lastPost;
    const due = flags !== lastFlags || driftCode !== 0 ||
      ((watch & W_ARP) && since >= ARP_POST_MS) ||
      ((watch & (W_METERS | W_PLAYHEAD)) && since >= METER_POST_MS);
    if (!due) return null;
    readings[M_FLAGS] = flags;
    readings[M_DRIFT] = driftCode;
    readings[M_ARP] = (watch & W_ARP) ? arpPeak() : 0;
    readings[M_HEAD] = (watch & W_PLAYHEAD) ? seqPlayhead() : -1;
    packAtmosphere(readings, M_ATMOS);
    lastFlags = flags; driftCode = 0; lastPost = t;
    return readings;
  }

  // Compile the worklet now, while nothing plays, as main.js does at boot.
  ensureAudioGraph();

  return { runCalls, storageChanged, wake, tick };
}
