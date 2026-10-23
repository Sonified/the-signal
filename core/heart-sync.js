// The heartbeat in step across a room. Every screen plays the same looping
// recording, and the broadcaster's ears are the reference: its beacon (core/
// broadcast.js, the strobe's own, every 2 s) says where in the track it is
// HEARING at a shared-clock moment, and each follower steers its own playback
// onto that place without ever stepping the sound.
//
// The place is a heard place, the track position of the sound leaving the
// speaker, not the one handed to the audio graph: core/heartbeat.js reads it
// at context time minus the output's latency, so a Bluetooth screen and a
// wired one agree about what is audible at one moment, and the flash (which
// reads the same place) agrees with both.
//
// ---------- the law ----------
// err = my heard place - the broadcaster's, in seconds of track, wrapped to
// half a loop either way. A beacon is a measurement of it: the moment it
// describes is `d` seconds ago on this screen's clock (the network's delay),
// so the broadcaster has moved on by d at the rate the track plays at now:
//
//   err = place - (pos + speed * d)
//
// Between beacons the error is dead-reckoned: both screens play at the same
// rate (the Speed, and its variance, ride the room: the breath is adopted
// from the beacon, the Time drive is on the room clock, the strobe has its
// own beacon), so err moves only by what this screen's own bend did:
//
//   err += speed * bend * dt
//
// and the bend is a small proportional pull on the playback rate,
//
//   bend = -sign(err) * min(MAX_BEND, GAIN * (|err| - DEAD))
//
// (time constant 1 / (GAIN * speed), about a second and a quarter at 1x; 5%
// at most, under a tenth of a semitone's wobble in the thump). Past JUMP_S,
// or a place nothing has been heard at yet, the track is set onto the target
// in one step (core/heartbeat.js crossfades it), at most once a COOLDOWN_MS.
//
// A beacon older than STALE_MS (the broadcaster paused, left, or the relay
// dropped) lets go: no bend, the track plays on at its own rate.
//
// Everything is on this screen's performance.now() timeline, in ms; the
// broadcaster's shared-clock moment is moved onto it by core/broadcast.js
// before it is handed in. This file imports nothing.

export const HEART_GAIN = 0.8;
export const HEART_MAX_BEND = 0.05;
export const HEART_DEAD_S = 0.004;
export const HEART_JUMP_S = 0.3;
export const HEART_COOLDOWN_MS = 1500;
export const HEART_STALE_MS = 8000;
// A measurement within this of the dead-reckoned error is blended in, not
// taken whole, so a probe's jitter does not become a rate wobble.
const BLEND = 0.5, BLEND_NEAR_S = 0.05;
// A beacon that claims a moment further back than this, or ahead of the
// clock, is not believed (a clock still settling, a stalled socket).
const MAX_AGE_S = 3, MAX_AHEAD_S = 0.05;

// ---------- the broadcaster's side ----------
// core/heartbeat.js registers a function that answers { pos, dur }, the
// heard place now (seconds into the track) and the track's length, or null
// while it is not playing; the beacon asks it once per send.
let reporter = null;
export function setHeartReporter(fn) { reporter = typeof fn === 'function' ? fn : null; }
export function heartReport() { return reporter ? reporter() : null; }

// ---------- the follower's side ----------
// The latest beacon: the moment it describes (this screen's ms), where the
// broadcaster's ears were then (s), the track's length (s), when it arrived,
// and a count that says it is new.
const target = { at: NaN, pos: 0, dur: 0, rcv: -Infinity, seq: 0 };
export function takeHeartBeacon(atMs, pos, dur, nowMs) {
  if (!Number.isFinite(atMs) || !Number.isFinite(pos) || !(dur > 0)) return;
  target.at = atMs; target.pos = pos; target.dur = dur; target.rcv = nowMs; target.seq++;
}
export function clearHeartBeacon() { target.rcv = -Infinity; }
// The beacon, or null once it is stale (or none came).
export function heartTarget(nowMs) {
  return nowMs - target.rcv <= HEART_STALE_MS ? target : null;
}

// ---------- the servo ----------
export const HEART_NONE = 0, HEART_JUMP = 1;

export function heartServo() {
  return { err: 0, have: false, seen: 0, bend: 0, last: NaN, cool: -Infinity, to: 0 };
}

// Forget the measurement (the sound stopped, or started afresh at a place
// that is already right): the next beacon is taken whole.
export function heartServoReset(sv) {
  sv.err = 0; sv.have = false; sv.bend = 0; sv.last = NaN;
}

// x wrapped to [-dur/2, dur/2)
export function wrapHeart(x, dur) {
  return x - Math.floor(x / dur + 0.5) * dur;
}

// One frame. now is this screen's ms, place the heard place now (s, any lap),
// speed the rate the track is playing at before the bend, dur the track's
// length. Returns HEART_JUMP, with sv.to the heard place to set the track
// to, or HEART_NONE; either way sv.bend is the fraction to bend the rate by
// this frame (0 when there is nothing to hold to).
export function heartServoStep(sv, tgt, now, place, speed, dur) {
  const dt = sv.last === sv.last ? Math.min(0.25, Math.max(0, (now - sv.last) / 1000)) : 0;
  sv.last = now;
  sv.err += speed * sv.bend * dt;
  sv.bend = 0;
  if (!tgt || Math.abs(tgt.dur - dur) > 0.01) { sv.have = false; return HEART_NONE; }
  if (tgt.seq !== sv.seen) {
    sv.seen = tgt.seq;
    const d = (now - tgt.at) / 1000;
    if (d >= -MAX_AHEAD_S && d <= MAX_AGE_S) {
      const meas = wrapHeart(place - (tgt.pos + speed * d), dur);
      if (sv.have && Math.abs(meas - sv.err) < BLEND_NEAR_S) sv.err += (meas - sv.err) * BLEND;
      else sv.err = meas;
      sv.have = true;
    }
  }
  if (!sv.have) return HEART_NONE;
  const a = Math.abs(sv.err);
  if (a > HEART_JUMP_S && now >= sv.cool) {
    sv.to = place - sv.err;
    sv.err = 0;
    sv.cool = now + HEART_COOLDOWN_MS;
    return HEART_JUMP;
  }
  if (a > HEART_DEAD_S) {
    const b = Math.min(HEART_MAX_BEND, HEART_GAIN * (a - HEART_DEAD_S));
    sv.bend = sv.err > 0 ? -b : b;
  }
  return HEART_NONE;
}

// ---------- the rate's lead ----------
// A rate set now is heard `lead` seconds from now (the render horizon on
// Heart, then the output's latency), but its value is the Speed as the
// screens compute it at this frame. With the breath leading the Speed, two
// screens of different latency would each play a rate the other's moment
// had, a swing in the place of up to lead difference times the rate's
// swing, which the servo would have to chase for as long as the breath
// runs. So in a room the rate is set where it is going to be when it is
// heard: this frame's value carried forward by its own slope. The slope is
// the last two frames' (a smooth curve, the breath or a variance, is
// followed to a hair); a jump (a slider drag, a preset) is not extrapolated,
// the rate then simply arrives as it always did.
// Where the Speed's own law can say what it will be (core/strobe.js: the
// Time clock and the breath are formulas), it does, exactly, for any lead:
// core/strobe.js registers heartSpeedAt(sec), and heartAheadFn hands it to
// the heartbeat. The slope below is the fallback, good to a few ms of place
// up to a 0.3 s lead and no further: its error grows with the lead squared,
// and Heart's cushion (0.3 s, and 1.5x on every underrun) differs from
// screen to screen, so two screens' leads can sit 0.4 s apart.
let aheadFn = null;
export function setHeartSpeedAt(fn) { aheadFn = typeof fn === 'function' ? fn : null; }
export function heartSpeedAtFn() { return aheadFn; }

const SLOPE_MIN_S = 0.002, SLOPE_MAX_S = 0.1, LEAD_MAX_S = 0.5, JUMP_FRAC = 0.25;
export function heartLeadState() { return { v: NaN, at: 0 }; }
export function heartRateAhead(st, speed, now, lead) {
  let out = speed;
  if (st.v === st.v && lead > 0) {
    const dt = (now - st.at) / 1000;
    if (dt > SLOPE_MIN_S && dt < SLOPE_MAX_S) {
      const d = (speed - st.v) / dt * (lead < LEAD_MAX_S ? lead : LEAD_MAX_S);
      const lim = JUMP_FRAC * (speed > 0.2 ? speed : 0.2);
      if (d <= lim && d >= -lim) out = speed + d;
    }
  }
  st.v = speed; st.at = now;
  return out < 0 ? 0 : out;
}
