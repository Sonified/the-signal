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
// A phase is derived as floats: phase = (shared ms / the period + the
// swing's offset) mod 1. Nothing about it is a random pick, so there is no
// hashing and no step counting here, only a modulo.
//
// The offset is a plain 0 to 1 number on S beside the swing's rate, under
// the rate's name plus Off (partFadeRateOff, flowerPulsePeriodOff), saved
// and sent with the layer's other numbers. It is what keeps a rate change
// from jumping the swing: epoch zero alone, the room's phase at a new
// period is somewhere else in the cycle entirely. So a rate moved here, in
// a room, first folds the change into the offset (retimeRoomPhase, from the
// rate's set()), choosing it so the derived phase at this instant is the
// one the old period gave, and from there it runs on at the new rate. It is
// pure clock math, never the layer's accumulator: a converged screen sits
// on the derived phase, so a derivation that carries on smoothly is a swing
// that does. A drag retimes on every step and the steps telescope, so the
// whole drag is smooth. A follower never retimes anything: the rate and the
// offset reach it together as data, through the load path (store.js
// applySnapshot, whose replay does call set(), but with the new rate
// already on S, so the retime sees no change). A snapshot recall on this
// screen lands its rates and its saved offsets as data the same way, but it
// is a local change, so it then folds each swing's offset afresh from the
// pair it replaced (carryRoomPhase, from core/presets.js recallSnapshot).
// Outside a room a rate change leaves the offset alone; the accumulator
// carries the swing there.
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
// together. And a period that is moving: the offset keeps a local drag's
// target still, but a change that arrives as data (another tab, a
// follower's replay) can land a rate and an offset that do not
// continue this screen's phase, and a period the offset has not caught up
// with spins the target, which chasing would turn into jitter. So the pull
// still waits until the period has held still for SETTLE_S of motion, the
// accumulator carries the swing smoothly at the new rate meanwhile, and
// then every screen, which all ended on the same period and offset, glides
// onto the same phase.

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
// step in seconds, periodSec the swing's period in seconds, offset its
// phase offset (the rate's Off key on S, 0 when unset). Outside a room,
// clock unsettled, or stopped, it hands phase straight back. A wake while
// outside a room owes the room nothing, so the swing's wake count keeps up
// there, and entering a room later glides onto it as it always has; so does
// a swing meeting a new period (its first frame included), which settles
// and then glides like any other.
export function roomPhase(st, phase, t, step, periodSec, offset = 0) {
  if (!inRoom || clockOff !== clockOff) { st.gen = snapGen; return phase; }
  if (!(step > 0)) return phase;
  if (periodSec !== st.period) { st.period = periodSec; st.still = 0; st.gen = snapGen; return phase; }
  if (st.still < SETTLE_S) { st.still += step; return phase; }
  const pMs = periodSec * 1000;
  let target = ((t + clockOff) % pMs) / pMs + (offset === offset ? offset : 0);
  target -= Math.floor(target);
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

// Folds a rate change into a swing's phase offset, so the room's phase for
// that swing carries on from where it is at the new rate instead of jumping
// (see the offset above). Called from the rate's set(), with the period
// before the write and the one being written, both in seconds and as the
// layer reads them. offKey is the offset's name on S. The shared ms is this
// tab's performance.now plus the offset, the timeline the frame's rAF t is
// on (platform.now is performance.now on every platform), so the moment
// this derives at and the frames that follow read the one clock:
//
//   offNew = (shared / oldPeriod + offOld) - (shared / newPeriod), mod 1
//
// Outside a room, clock unsettled, or a period that is not a change, it
// does nothing.
export function retimeRoomPhase(S, offKey, oldPeriodS, newPeriodS) {
  if (oldPeriodS === newPeriodS) return;
  carryRoomPhase(S, offKey, oldPeriodS, S[offKey], newPeriodS);
}

// The same fold with the old pair named outright rather than read off S:
// the period and offset the swing was deriving from, and the period now on
// S. A snapshot recall needs it (core/presets.js recallSnapshot), since the
// recall has already written the preset's own rate and offset over the pair
// this screen was running on, so the pair is kept from before the recall and
// handed in here after it. A period that did not change still writes: the
// preset's offset is a stale one from whenever it was saved, and continuing
// this screen's phase means putting the old offset back. Outside a room,
// clock unsettled, or a period that is not a period, it does nothing and the
// offset stays whatever is on S.
export function carryRoomPhase(S, offKey, oldPeriodS, oldOff, newPeriodS) {
  if (!inRoom || clockOff !== clockOff) return;
  if (!(oldPeriodS > 0) || !(newPeriodS > 0)) return;
  const ms = performance.now() + clockOff;
  const oldMs = oldPeriodS * 1000, newMs = newPeriodS * 1000;
  let o = (ms % oldMs) / oldMs + (typeof oldOff === 'number' && oldOff === oldOff ? oldOff : 0) - (ms % newMs) / newMs;
  o -= Math.floor(o);
  S[offKey] = o;
}
