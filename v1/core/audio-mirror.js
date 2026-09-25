// Two live audio readings the drawn frame uses, read through here so they
// work on either thread: the sequencer channel's peak (the particles pulse
// with it) and the sequencer's playhead (its window lights the step that
// last sounded).
//
// On the main thread both come straight from js/piano.js, exactly as before.
// In worker mode the audio lives on the page and the worker's copy of
// js/piano.js has no voices to read, so the page sends both across with its
// meters (core/audio-shell.js packs them, core/audio-link.js unpacks them
// into `mirror`) and these return the latest values it sent. Each read also
// notes the frame it happened on, which is how the worker tells the page
// that someone is looking and the readings are worth sending at all.

import { arpPeak, seqPlayhead } from '../../js/piano.js';

// The layout of the Float32Array the page posts (core/audio-shell.js writes
// it, core/audio-link.js reads it): a few fixed slots, then the atmosphere's
// meters, levels and statuses from M_ATMOS on (atmosphere.js packAtmosphere).
export const M_FLAGS = 0, M_DRIFT = 1, M_ARP = 2, M_HEAD = 3, M_ATMOS = 4;
// M_FLAGS bits: the sound is on, the worklet is built, the drift is running.
export const F_AUDIO = 1, F_WORKLET = 2, F_DRIFT = 4;
// M_DRIFT: what the drift did since the last post (atmosphere.js noteDrift).
export const DRIFT_MOVING = 1, DRIFT_LANDED = 2;
// The readings the worker is showing, so the page knows what to send and
// how often: the mixer's meters, the sequencer's playhead, the arp's peak.
export const W_METERS = 1, W_PLAYHEAD = 2, W_ARP = 4;
// The worker's calls travel as one flat array, five slots a call: the name,
// then up to four arguments (unused ones are 0), so the page walks it in
// fixed steps.
export const CALL_SLOTS = 5;

export const mirror = {
  on: false,
  arpPeak: 0,
  seqPlayhead: -1,
  frame: 0,            // advanced by the audio link once a frame
  arpReadAt: -1e9,     // the frame each reading was last asked for
  playheadReadAt: -1e9
};

export function arpPeakNow() {
  if (!mirror.on) return arpPeak();
  mirror.arpReadAt = mirror.frame;
  return mirror.arpPeak;
}

export function seqPlayheadNow() {
  if (!mirror.on) return seqPlayhead();
  mirror.playheadReadAt = mirror.frame;
  return mirror.seqPlayhead;
}
