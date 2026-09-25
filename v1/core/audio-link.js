// The worker's end of the audio link, used only in worker mode (see
// core/engine-thread.js). The engine, the UI and the settings all live in the
// worker, but an AudioContext cannot, so the sound stays on the page
// (core/audio-shell.js) and this file keeps it in step.
//
// The model is two tabs sharing one page. The worker owns the settings, the
// same way a tab owns its own: its store writes the shared records, which the
// page stores and replays exactly as it would another tab's write
// (store.syncFromStorage through presets.replayLive). That covers everything
// eventually, but only once the store's debounce lets a write out, which is
// far too late for a fader under the viewer's hand. So once a frame, after
// the submit, this file also looks for anything that moved and sends it on
// straight away, as a short list of calls the page's registry runs
// (audio-shell.js's CALLS):
//
//   set(id, pos, glide)     a control's position changed, however it changed
//                           (a drag, a key, a quick chip, a preset, the
//                           sequencer's power button); the page runs that
//                           control's own set(), which is every side effect
//                           v0's handler had. glide marks a change made
//                           inside a preset's transition, so the page glides
//                           it the way presets.js does here.
//   run(on)                 the transport started or stopped (toggleRun, a
//                           field click, the panel guard's pause).
//   strobe(eff, achieved)   the strobe's rate moved by more than 0.01 Hz: the
//                           linked pulse rate and the arp's strobe pulse
//                           follow it, as strobe.js's own link does in main
//                           mode, with the same threshold.
//   seq(packed)             the sequencer's slot or a pattern changed.
//   watch(bits)             which live readings the worker is showing (the
//                           mixer's meters, the sequencer's playhead, the
//                           arp's peak), so the page reads and sends only those.
//
// Finding the moves is a comparison, not a hook: every control's get(S)
// against the position it had last frame, a few hundred cheap calls with no
// allocation. That catches every path that moves a setting, including the
// ones that write S directly, without touching any of them, and it stays
// correct as controls are added. The colour picker is left out (its get
// builds a string, and nothing on the page's side reads colour).
//
// The other way, the page posts one reused Float32Array of readings (see the
// layout in core/audio-mirror.js): whether the sound is on, the meters, the
// recordings' statuses, the arp's peak and the playhead, and, while the
// atmosphere's drift runs (it runs on the page, on the audio clock), the
// levels it has glided to. receiveMirror takes those in, and runs the drift's
// saving policy here, where the settings are written.
//
// The audio calls the worker's own copy of the schema still makes are
// harmless: with no AudioContext in this thread every one of them returns at
// once (platform/worker-shim.js covers the two that would try to start one).
// The Audio layer's three switches are the exception, since they start and
// stop the sound directly; here they keep only their state.

import { S } from '../../js/state.js';
import { SEQ_SLOTS, SEQ_MAX } from '../../js/piano.js';
import { CONTROLS, byId } from './schema.js';
import {
  ambLayerControls, AMB_LAYER_COUNT, setAtmosphereRemote, atmosphereMetersWanted,
  unpackAtmosphere, noteDrift
} from './atmosphere.js';
import { presetTransitionCount } from './presets.js';
import { save } from './store.js';
import {
  mirror, M_FLAGS, M_DRIFT, M_ARP, M_HEAD, M_ATMOS, F_AUDIO, F_WORKLET, F_DRIFT,
  DRIFT_MOVING, DRIFT_LANDED, W_METERS, W_PLAYHEAD, W_ARP
} from './audio-mirror.js';

// How many frames a reading stays watched after the last frame that read it.
const WATCH_FRAMES = 30;
// A position's change must exceed this before the strobe rate is sent again.
const STROBE_EPS = 0.01;
// The sequencer as one packed row: the slot, then each pattern's length and
// its steps.
const SEQ_PACK = 1 + SEQ_SLOTS * (1 + SEQ_MAX);

// post(calls) sends the outbox (a plain array the caller may clone and must
// not keep; it is cleared straight after).
export function createAudioLink(post) {
  setAtmosphereRemote(true);
  mirror.on = true;

  // The Audio layer's switches (the section header, the Layers row and the
  // transport's mute) all read S.audioOnBoot through the same function, and
  // set it through one that also starts or stops the sound. Found by that
  // shared get rather than by id, so a fourth one would be covered too.
  const layerGet = byId('audioOn') && byId('audioOn').get;
  if (layerGet) {
    for (const c of CONTROLS) {
      if (c.get === layerGet) c.set = (s, on) => { s.audioOnBoot = !!on; save(); };
    }
  }

  // Every control with a position, clickMode first as presets.js orders its
  // replay (the five shared pip controls address the click or the chirp by
  // S.clickMode, so the voice must be settled before them), then the mixer's
  // per-recording rows, which live outside CONTROLS.
  const watched = CONTROLS.filter(c =>
    (c.kind === 'slider' || c.kind === 'segment' || c.kind === 'toggle') &&
    !c.multi && c.get && c.set && c.id !== 'engineThread');
  watched.sort((a, b) => (b.id === 'clickMode') - (a.id === 'clickMode'));
  const levelIdx = [];
  for (let i = 0; i < AMB_LAYER_COUNT; i++) {
    const row = ambLayerControls(i);
    levelIdx.push(watched.length);
    watched.push(row.level, row.mute, row.solo);
  }
  const n = watched.length;
  const shadow = new Array(n).fill(undefined);

  const seqNow = new Int16Array(SEQ_PACK), seqSent = new Int16Array(SEQ_PACK);
  function packSeq(out) {
    out[0] = S.seqSlot | 0;
    let k = 1;
    const pats = S.seqPatterns;
    for (let p = 0; p < SEQ_SLOTS; p++) {
      const pat = pats && pats[p];
      out[k++] = pat ? pat.len | 0 : 0;
      for (let i = 0; i < SEQ_MAX; i++) out[k++] = pat && pat.steps ? pat.steps[i] | 0 : -1;
    }
  }

  let lastRunning = false, lastEff = 0, lastAch = 0, lastWatch = 0, lastTransition = 0;
  let seeded = false;
  const outbox = [];

  // The baseline: what the page already has, since both loaded the same
  // stored settings. Taken at the start of the first frame, before any input
  // (the worker platform's first pollInput), so nothing the first frame does
  // is missed. The transport starts stopped on both sides.
  function seed() {
    seeded = true;
    for (let i = 0; i < n; i++) shadow[i] = watched[i].get(S);
    packSeq(seqSent);
    lastRunning = false;
    lastEff = S.effFreq || 0; lastAch = S.achievedFreq || 0;
    lastTransition = presetTransitionCount();
  }

  // One call, CALL_SLOTS wide (core/audio-mirror.js).
  function call(fn, a, b, c, d) { outbox.push(fn, a, b, c, d); }

  // Finds what moved since the last pass and posts it. Runs after each
  // frame's submit, and also straight before the store posts a settings
  // record (platform/worker-platform.js), so the page always hears the
  // individual moves before the record that already contains them.
  function flush() {
    if (!seeded) return;
    const t = presetTransitionCount();
    const glide = t !== lastTransition ? 1 : 0;
    lastTransition = t;

    let modeMoved = false;
    for (let i = 0; i < n; i++) {
      const v = watched[i].get(S), was = shadow[i];
      if (v === was || (v !== v && was !== was)) continue;
      shadow[i] = v;
      call('set', watched[i].id, v, glide, 0);
      if (watched[i].kind === 'segment') modeMoved = true;
    }
    // A segment can be a mode that changes what other controls address (the
    // pip controls read the click's values or the chirp's by S.clickMode), and
    // a control whose position under the new mode happens to equal its old one
    // would look unmoved here while the page, switched to the new mode, reads
    // something else. So when one moved, every position follows it, after it;
    // the page skips each one it already has. Segments move on clicks, never
    // on drags, so this is rare and a few hundred cheap compares on the page.
    if (modeMoved) for (let i = 0; i < n; i++) call('set', watched[i].id, shadow[i], glide, 0);

    packSeq(seqNow);
    for (let i = 0; i < SEQ_PACK; i++) {
      if (seqNow[i] !== seqSent[i]) {
        seqSent.set(seqNow);
        call('seq', seqNow.slice(), 0, 0, 0);
        break;
      }
    }

    if (S.running !== lastRunning) {
      lastRunning = S.running;
      call('run', lastRunning, 0, 0, 0);
    }

    const eff = S.effFreq || 0, ach = S.achievedFreq || 0;
    if (Math.abs(eff - lastEff) > STROBE_EPS || Math.abs(ach - lastAch) > STROBE_EPS) {
      lastEff = eff; lastAch = ach;
      call('strobe', eff, ach, 0, 0);
    }

    let w = 0;
    if (atmosphereMetersWanted()) w |= W_METERS;
    if (mirror.frame - mirror.playheadReadAt < WATCH_FRAMES) w |= W_PLAYHEAD;
    if (mirror.frame - mirror.arpReadAt < WATCH_FRAMES) w |= W_ARP;
    if (w !== lastWatch) { lastWatch = w; call('watch', w, 0, 0, 0); }

    if (outbox.length) { post(outbox); outbox.length = 0; }
  }

  function afterFrame() {
    mirror.frame++;
    flush();
  }

  // The page's readings. S.audioEnabled and S.workletReady are the page's
  // own facts (only its audio.js ever sets them), mirrored so the mixer and
  // the sequencer read "playing" correctly here. Drift levels are taken only
  // while the drift runs, and their positions are taken as already known, so
  // they are not sent straight back as the viewer's own moves.
  function receiveMirror(m) {
    const flags = m[M_FLAGS];
    S.audioEnabled = !!(flags & F_AUDIO);
    S.workletReady = !!(flags & F_WORKLET);
    mirror.arpPeak = m[M_ARP];
    mirror.seqPlayhead = m[M_HEAD];
    const drifting = !!(flags & F_DRIFT);
    unpackAtmosphere(m, M_ATMOS, drifting);
    if (drifting) for (let i = 0; i < levelIdx.length; i++) shadow[levelIdx[i]] = watched[levelIdx[i]].get(S);
    const d = m[M_DRIFT];
    if (d === DRIFT_MOVING) noteDrift('moving');
    else if (d === DRIFT_LANDED) noteDrift('landed');
  }

  return { seed, flush, afterFrame, receiveMirror };
}
