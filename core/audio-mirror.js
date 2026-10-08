// The live audio readings the drawn frame uses, read through here so they
// work on either thread: the sequencer channel's peak (the particles pulse
// with it), the sequencer's step clock (its window lights the step that
// last sounded, on the grid and on each line's row), the lines' swung
// values (a swinging knob's lights follow them round its ring), the click
// level's dip and the tone's two dips (their bars breathe with them).
//
// On the main thread they come straight from js/piano.js and js/audio.js,
// exactly as before. In worker mode the audio lives on the page and the worker's copy of
// js/piano.js has no voices to read, so the page sends them across with its
// meters (core/audio-shell.js packs them, core/audio-link.js unpacks them
// into `mirror`) and these return the latest values it sent. Each read also
// notes the frame it happened on, which is how the worker tells the page
// that someone is looking and the readings are worth sending at all.

import { S } from '../js/state.js';
import { arpPeak, seqPlayhead, seqClock, seqSwingRead, SEQ_COUNT, SEQ_SWINGS } from '../js/piano.js';
import { pipDipRead, toneVolMul, toneAmMul } from '../js/audio.js';

// The layout of the Float32Array the page posts (core/audio-shell.js writes
// it, core/audio-link.js reads it): a few fixed slots, then the read-backs
// (READBACKS below) from M_READBACKS on, each its own width in turn, then
// the atmosphere's meters, levels and statuses from M_ATMOS on
// (atmosphere.js packAtmosphere).
export const M_FLAGS = 0, M_DRIFT = 1, M_ARP = 2, M_HEAD = 3, M_READBACKS = 4;
// M_FLAGS bits: the sound is on, the worklet is built, the drift is running;
// each read-back's live bit follows from READBACK_BIT0 up.
export const F_AUDIO = 1, F_WORKLET = 2, F_DRIFT = 4;
// M_DRIFT: what the drift did since the last post (atmosphere.js noteDrift).
export const DRIFT_MOVING = 1, DRIFT_LANDED = 2;
// The readings the worker is showing, so the page knows what to send and
// how often: the mixer's meters, the sequencer's playhead, the arp's peak,
// and each read-back's watch bit from READBACK_BIT0 up.
export const W_METERS = 1, W_PLAYHEAD = 2, W_ARP = 4;
const READBACK_BIT0 = 8;
// The worker's calls travel as one flat array, five slots a call: the name,
// then up to four arguments (unused ones are 0), so the page walks it in
// fixed steps.
export const CALL_SLOTS = 5;

// ---------- read-backs ----------
// A read-back is a live value the page's audio computes that the worker's
// frame draws: a knob's swing lights, a bar's breathing fill (an audio
// variance's effective, the click level's dip). Each is one row here, and
// its place in the post, its watch bit and its live bit all follow from the
// row's place in the table, so a new one is a row and a one-line reader
// (readback below), never a new block in this file, the shell and the link.
//   width   the floats it takes in the post
//   pack    the page's read into the post at `at`; returns whether it is live
//   here    main mode's read, straight from the audio modules
//   rest    what the worker reads while it is not live: a number for a
//           single value (sent in its slot while nobody watches), or null
//           for a run of values, which reads as null (the page then leaves
//           the slots as they were and clears the live bit)
// Order is the wire's contract between the two threads of one build, and
// the bits read W_SWING 8 and W_PIP 16 as they always have, then the tone's
// level 32 and its pulse depth 64.
export const SWING_SLOTS = SEQ_COUNT * SEQ_SWINGS;
// main mode's own copy of the swings, read straight from js/piano.js
const swingHere = new Float64Array(SWING_SLOTS);
// The lines' swung values, SEQ_SWINGS a line (piano.js seqSwingRead), live
// while a sequencer plays to swing them and someone is watching (an open
// fold with a VAR or MOD turned up).
const SWING = { width: SWING_SLOTS, rest: null,
  pack: (out, at) => seqSwingRead(out, at),
  here: () => seqSwingRead(swingHere, 0) ? swingHere : null };
// The click level's variance as it plays, the share of the level the dip
// leaves (audio.js pipDipRead), 1 while nobody watches it (its row showing
// with a variance set). Asking is what wakes the worklet's report.
const PIP = { width: 1, rest: 1,
  pack: (out, at) => { out[at] = pipDipRead(); return true; },
  here: () => pipDipRead() };
// The tone's level and its pulse depth as their variances play them, the
// share of each setting the dip leaves (audio.js toneVolMul, toneAmMul), 1
// while nobody watches (the row showing with its variance set).
const TONE_VOL = { width: 1, rest: 1,
  pack: (out, at) => { out[at] = toneVolMul(); return true; },
  here: () => toneVolMul() };
const TONE_AM = { width: 1, rest: 1,
  pack: (out, at) => { out[at] = toneAmMul(); return true; },
  here: () => toneAmMul() };
export const READBACKS = [SWING, PIP, TONE_VOL, TONE_AM];
let slot = M_READBACKS;
for (let i = 0; i < READBACKS.length; i++) {
  const r = READBACKS[i];
  r.at = slot; slot += r.width;
  r.bit = READBACK_BIT0 << i;                       // its watch bit, and its live bit in M_FLAGS
  r.data = new Float32Array(r.width);               // the worker's copy, as the page last sent it
  if (r.rest !== null) r.data.fill(r.rest);
  r.live = false;
  r.readAt = -1e9;                                  // the frame it was last asked for
}
export const M_ATMOS = slot;
// Every read-back's watch bit at once.
export const W_READBACKS = READBACKS.reduce((m, r) => m | r.bit, 0);

export const mirror = {
  on: false,
  arpPeak: 0,
  seqClock: -1,        // the page's step count, from which each line finds its own step
  frame: 0,            // advanced by the audio link once a frame
  arpReadAt: -1e9,     // the frame each reading was last asked for
  playheadReadAt: -1e9
};

// A read-back's value on this thread: main mode reads the audio straight;
// in worker mode the page's latest, noting the frame, which is how the
// worker tells the page someone is looking.
function readback(r) {
  if (!mirror.on) return r.here();
  r.readAt = mirror.frame;
  if (r.rest === null) return r.live ? r.data : null;
  return r.data[0];
}

// The page's side, once a post is due: every watched read-back packed into
// out, the ones nobody watches (or with nothing live) at rest. Returns the
// live bits for M_FLAGS.
export function packReadbacks(out, watch) {
  let live = 0;
  for (let i = 0; i < READBACKS.length; i++) {
    const r = READBACKS[i];
    if ((watch & r.bit) && r.pack(out, r.at)) live |= r.bit;
    else if (r.rest !== null) out.fill(r.rest, r.at, r.at + r.width);
  }
  return live;
}

// The worker's side, as a post lands: each live read-back copied in, the
// rest set to rest.
export function unpackReadbacks(m, flags) {
  for (let i = 0; i < READBACKS.length; i++) {
    const r = READBACKS[i];
    r.live = !!(flags & r.bit);
    if (r.live) for (let j = 0; j < r.width; j++) r.data[j] = m[r.at + j];
    else if (r.rest !== null) r.data.fill(r.rest);
  }
}

// The watch bits of every read-back asked for within the last `frames`.
export function readbacksWatched(frames) {
  let w = 0;
  for (let i = 0; i < READBACKS.length; i++) {
    if (mirror.frame - READBACKS[i].readAt < frames) w |= READBACKS[i].bit;
  }
  return w;
}

export function arpPeakNow() {
  if (!mirror.on) return arpPeak();
  mirror.arpReadAt = mirror.frame;
  return mirror.arpPeak;
}

// The sequencer's step clock: the count at the step that last sounded, -1
// while nothing plays. Each of the eight lines' steps is this count modulo
// that line's own length, so the window can light every line's step from
// the one number, and the page sends only that.
export function seqClockNow() {
  if (!mirror.on) return seqClock();
  mirror.playheadReadAt = mirror.frame;
  return mirror.seqClock;
}

// The active line's step, for the grid's playhead.
export function seqPlayheadNow() {
  if (!mirror.on) return seqPlayhead();
  mirror.playheadReadAt = mirror.frame;
  const c = mirror.seqClock, q = S.seqs && S.seqs[S.seqSlot | 0];
  if (c < 0 || !q) return -1;
  return c % Math.max(1, Math.min(16, q.len | 0));
}

// The lines' swung values, SEQ_SWINGS a line in piano.js's SEQ_SW_* order,
// or null while nothing swings them (the sequencer stopped), when a knob's
// lights rest on its setting. The array is reused; read it, never keep it.
export const seqSwingNow = () => readback(SWING);

// The click level's variance as it plays: the share of the set level the
// worklet's dip is leaving this moment, 1 at the top of its breath and 1
// whenever there is nothing live to read. Asking is what switches the
// worklet's report on, on this thread or the page's.
export const pipDipNow = () => readback(PIP);

// The tone's two variances as they play: the share of its set level, and of
// its set pulse depth, each dip is leaving this moment, 1 at the top of the
// breath and whenever there is nothing live to read.
export const toneVolMulNow = () => readback(TONE_VOL);
export const toneAmMulNow = () => readback(TONE_AM);
