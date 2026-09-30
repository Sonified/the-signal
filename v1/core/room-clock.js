// The broadcast room's clock, as the visual layers read it. Inside a room
// every screen, broadcaster and followers alike, can agree on one clock
// without sending anything: the room's own, which the time probes place on
// this tab's timeline (shared ms = this tab's rAF ms + the offset). The
// slow swings the layers run (the particles' and the confetti's feedback
// variances, the particles' Center fade radius, the edge glow's breathing,
// the flowers' pulse variance) each take their phase off that clock while
// in a room, so every screen in it swells and eases together with no
// messages, the broadcaster's socket dozing and the room hibernating
// included.
//
// core/broadcast.js is the only writer: whether this screen is in a room
// (a broadcaster with a session active, dozing or not; a follower once its
// room has sent a state) and the offset, the same one it hands the strobe
// and the word walk. Outside a room, or until the offset settles (NaN),
// nothing here runs and every phase is its layer's own accumulator exactly
// as it always was. The word walk keeps its own copy of the offset
// (core/words.js); this file does not replace it, because the walk also
// stands aside during a broadcaster's Journey sequence and the swings must
// not.
//
// A phase is derived as floats, epoch zero: phase = (shared ms mod the
// period) / the period. Nothing about it is a random pick, so there is no
// hashing and no step counting here, only a modulo.
//
// It is never jumped onto, though. Each layer keeps advancing its own
// accumulator as it always has, and roomPhase then pulls that phase toward
// the room's, bleeding off the difference the way the strobe's beacons pull
// its six variability phases (core/strobe.js, slewTo at SYNC_RATE): the
// swing speeds up or eases for a moment and lands on the shared phase,
// which is what entering a room, the clock settling, or a resume after a
// stop look like. Once the two are within a hair the phase simply is the
// room's, every frame, so a converged screen is pure derivation.
//
// Except when the gap is big. A swing more than LARGE_ERR of a cycle away
// from the room is set onto it in one step, and so is every swing after a
// wake (core/wake.js; main.js calls roomClockSnap on a resume frame), since
// the room's time kept moving while this screen was away. A glide over a
// large error races the swing through its cycle in a second or two, and a
// fast sweep is what reads as flashing; one step is a single change, a blink.
//
// Two things hold the pull. A stopped scene: the pull is scaled by the
// frame's motion step (core/motion.js), so it fades with the pause
// wind-down and a stopped scene holds its swings still, as it does outside
// a room; on resume every screen glides back onto the shared phase
// together. And a period that is moving: with epoch zero, the shared phase
// at a slightly different period is somewhere else entirely, so while a
// rate slider is dragged (or a preset or a follower's replay glides it)
// the target spins, and chasing it would jitter. The pull waits until the
// period has held still for SETTLE_S of motion, the accumulator carries
// the swing smoothly at the new rate meanwhile, and then every screen,
// which all ended on the same period, glides onto the same new phase.

let inRoom = false;
let clockOff = NaN;      // shared ms minus this tab's rAF ms

export function setRoomClockRoom(on) { inRoom = !!on; }
export function setRoomClockOffset(off) { clockOff = Number.isFinite(off) ? off : NaN; }
export function roomClockRunning() { return inRoom && clockOff === clockOff; }

// The pull's rate, per second of motion: the strobe's SYNC_RATE, so the
// swings settle the way its own variability phases do (a time constant of
// about a second and a quarter, a half-cycle error mostly gone in three).
const PULL_RATE = 0.8;
// Seconds of motion a period must hold still before the pull resumes.
const SETTLE_S = 0.5;
// Closer than this (in cycles) and the phase is simply set to the room's.
const SNAP = 1e-4;
// Further than this (in cycles) and it is set to the room's too, in one
// step: past a quarter cycle the glide would visibly race the swing.
const LARGE_ERR = 0.25;
// Bumped by every wake; a swing whose own count is behind it snaps once, on
// its next frame in a room with the pull running, and catches up.
let snapGen = 0;
export function roomClockSnap() { snapGen++; }

// One swing's own bookkeeping: the period it last saw, how long that period
// has held, and the wake count it last snapped at. Made once per phase, when
// its layer is made; roomPhase writes into it and allocates nothing.
export function roomPhaseState() { return { period: 0, still: 0, gen: 0 }; }

// The swing's phase for this frame. phase is the layer's accumulator after
// its own advance this frame, t the frame's rAF ms, step this frame's motion
// step in seconds, periodSec the swing's period in seconds. Outside a room,
// clock unsettled, or stopped, it hands phase straight back. A wake while
// outside a room owes the room nothing, so the swing's wake count keeps up
// there, and entering a room later glides onto it as it always has; so does
// a swing meeting a new period (its first frame included), which settles
// and then glides like any other.
export function roomPhase(st, phase, t, step, periodSec) {
  if (!inRoom || clockOff !== clockOff) { st.gen = snapGen; return phase; }
  if (!(step > 0)) return phase;
  if (periodSec !== st.period) { st.period = periodSec; st.still = 0; st.gen = snapGen; return phase; }
  if (st.still < SETTLE_S) { st.still += step; return phase; }
  const pMs = periodSec * 1000;
  let target = ((t + clockOff) % pMs) / pMs;
  if (target < 0) target += 1;
  // shortest way round the circle, in [-0.5, 0.5]
  let e = target - phase;
  e -= Math.round(e);
  if (st.gen !== snapGen || (e < SNAP && e > -SNAP) || e > LARGE_ERR || e < -LARGE_ERR) {
    st.gen = snapGen;
    return target;
  }
  const k = step * PULL_RATE;
  phase += e * (k < 1 ? k : 1);
  return phase - Math.floor(phase);
}
