// Fine tuning for the music's voices (the piano, the drone, the clouds and
// the choir): each is bent up or down by as much as a whole semitone, in
// cents, by its own row in the drawer. A scene setting, so it rides presets,
// journeys and the broadcast as the voices' levels do, and a follower's
// music stays in tune with the laptop's.
//
// Every one of these voices is a recording, so a retune is a change of
// playback speed: the source's detune AudioParam, which Web Audio (and
// Heart, heart/src/nodes/buffer_source.rs) multiplies onto whatever
// playbackRate the voice already plays at, so the cents compose with a
// resampled note's own rate without either knowing about the other. At
// +100 cents a recording runs about 6% faster and so lasts about 6% less
// wall-clock time; at -100 it lasts about 6% longer. Anything that was
// scheduled in wall-clock seconds from a buffer's length (the drone's
// passes and their crossfades, a cloud's fixed-length envelope) has to be
// worked out at the rate the source actually plays at, and worked out
// again when the rate changes under a source already sounding. This module
// is that arithmetic, kept pure so it can be tested on its own; the voices
// (js/piano.js, js/clouds.js, js/choir.js) only apply what it answers.
//
// Nothing here reads S or touches an AudioNode.

export const TUNE_MAX = 100;

// The glide a retune takes (setTargetAtTime's time constant), short enough
// that the knob feels immediate and long enough that a step never clicks.
// Not glideParam (js/audio.js): inside a preset's transition that would lay
// a straight ramp across the whole window, and the playheads below would
// then have to integrate a rate that changes for half a minute. A short
// exponential is followed exactly enough by one rule (retune, below).
export const TUNE_TC = 0.05;

// How far ahead of a buffer's last sample a source that has to end early is
// made silent: the glide above is modelled, not sampled, so a few
// milliseconds of slack keep the fade inside the audio.
export const TUNE_END_MARGIN = 0.02;

// A stored or broadcast value held to the knob's range and grid; anything
// that is not a finite number is no adjustment.
export const clampCents = c =>
  typeof c === 'number' && Number.isFinite(c) ? Math.max(-TUNE_MAX, Math.min(TUNE_MAX, Math.round(c))) : 0;

// Cents to a rate multiplier. Exactly 1 at 0, so an untuned voice computes
// every time it always did.
export const centsRatio = c => c ? Math.pow(2, c / 1200) : 1;

// The readout: '+N cents', '-N cents', and '0 cents' at 0, which means no
// adjustment and nothing more (the voice's tuning being whatever its root
// and its recording make it).
export const formatCents = pos => (pos > 0 ? '+' : '') + pos + ' cents';

// ---------- playheads ----------
// Where in its buffer a source is, on the wall clock: anchored at a time t
// and a buffer position pos, running at rate from there. A source not yet
// started is anchored at its start time and its start offset.
export const playhead = (at, offset, rate) => ({ t: at, pos: offset, rate });
export const posAt = (h, t) => h.pos + Math.max(0, t - h.t) * h.rate;

// The source's rate changes at time t. The detune glides there on
// setTargetAtTime with time constant tc rather than stepping, and an
// exponential approach covers, in the long run, exactly the ground an
// instant change made tc later would: the area between the two rates'
// curves is (new - old) x tc. So the change is booked at t + tc, which is
// exact to well under a millisecond once the glide has settled and never
// more than tc x 6% (3 ms) off while it settles. A source that has not
// started by then simply starts at the new rate.
export function retune(h, t, rate, tc = TUNE_TC) {
  const at = t + tc;
  if (at > h.t) { h.pos = posAt(h, at); h.t = at; }
  h.rate = rate;
  return h;
}

// When the source runs out of buffer: reaches end (buffer seconds), on the
// wall clock, at its current rate.
export const endsAt = (h, end) => h.t + Math.max(0, end - h.pos) / h.rate;

// ---------- one pass of a crossfading looper ----------
// The drone (js/piano.js bedTake) plays each pass through its loop as a
// source of its own, overlapping the next by a crossfade: a pass plays
// buffer seconds [offset, end) from startAt, at rate. It stops when that
// audio is used up, its fade out begins xf before that, and the next pass
// begins with the fade. At rate 1 these are startAt + (end - offset) and
// that less xf, the drone's schedule exactly as it always was.
export function planPass(startAt, offset, end, xf, rate) {
  const stopAt = startAt + (end - offset) / rate;
  return { stopAt, fadeAt: stopAt - xf };
}

// A sounding source whose rate has just risen may now run out of audio
// before the fade it was booked with has finished. This is the fade it
// needs instead: the window [from, to] that ends at the buffer's end (less
// the margin), as long as the one it had (fadeLen) where there is still
// room, from now (t) where there is not. null when the source still ends in
// time (its audio lasts to endAt, its booked silence), which is every
// source whose rate fell or stayed.
export function endInTime(h, end, endAt, t, fadeLen, margin = TUNE_END_MARGIN) {
  const to = endsAt(h, end) - margin;
  if (to >= endAt) return null;
  const stop = Math.max(t, to);
  return { from: Math.max(t, stop - fadeLen), to: stop };
}

// The looper's whole re-plan when the rate changes mid-loop. passes are the
// current run's passes in the order they were booked, each { at, end,
// fadeAt, stopAt, h }, with their playheads already retuned (retune). At t:
//   drop     the passes booked but not yet begun, every one of them timed
//            for the old rate: they are let go and booked again;
//   early    each sounding pass that would now run out of audio before its
//            fade has finished, with the fade window it needs (endInTime);
//   nextAt   when the next pass begins: the last sounding pass's fade,
//            moved earlier if that pass now ends early;
//   nextFade how long that next pass fades in over, the same window, so
//            the two still overlap the audio they are meant to.
// With nothing sounding (a run not yet begun), nothing is moved and the
// caller's own next time stands (nextAt null).
export function replanPasses(passes, t) {
  const drop = [], sounding = [], early = [];
  for (const p of passes) (p.at > t ? drop : sounding).push(p);
  for (const p of sounding) {
    const w = endInTime(p.h, p.end, p.stopAt, t, p.stopAt - p.fadeAt);
    if (w) early.push({ pass: p, from: w.from, to: w.to });
  }
  const last = sounding[sounding.length - 1];
  if (!last) return { drop, early, nextAt: null, nextFade: null };
  const mine = early.find(e => e.pass === last);
  const nextAt = mine ? mine.from : last.fadeAt;
  const nextFade = mine ? mine.to - mine.from : last.stopAt - last.fadeAt;
  return { drop, early, nextAt, nextFade };
}

// ---------- fades that can be redirected ----------
// An early end's fade is laid as a few straight segments rather than one
// curve, because a second retune may have to move it while it runs, and a
// setValueCurveAtTime refuses every other automation call inside its span.
// Straight segments can be cut at any time: the value they have reached is
// computed here from the same table, so the cut lands exactly where the
// sound is (no reading param.value, which on Heart is a lookahead stale).
// shape 'power' is the equal-power cosine the drone's crossfades use (its
// partner fades in on the matching sine); 'linear' is a cloud's own release.
export const FADE_SEGS = 8;
export function fadePoints(from, t0, t1, shape = 'power') {
  const pts = [];
  for (let i = 1; i <= FADE_SEGS; i++) {
    const u = i / FADE_SEGS;
    pts.push([t0 + (t1 - t0) * u, from * (shape === 'power' ? Math.cos(u * Math.PI / 2) : 1 - u)]);
  }
  return pts;
}
// The value a fade (from, t0, t1, shape) has reached at t, along the very
// segments fadePoints laid: from before it starts, 0 after it ends. No fade
// at all is a gain left at 1.
export function fadeValue(f, t) {
  if (!f) return 1;
  if (t <= f.t0) return f.from;
  if (t >= f.t1) return 0;
  let pt = f.t0, pv = f.from;
  for (const [ct, cv] of fadePoints(f.from, f.t0, f.t1, f.shape)) {
    if (t <= ct) return pv + (cv - pv) * (t - pt) / (ct - pt || 1);
    pt = ct; pv = cv;
  }
  return 0;
}

// Lays a fade to silence over [t0, t1] onto param (a gain that is 1 unless
// an earlier fade, prev, has been laid on it), cutting prev away at t from
// exactly the value it has reached, so a fade redirected while it runs
// carries on from where the sound is. Returns the fade laid, for the next
// redirect. Takes the param it is handed and nothing else.
export function layFade(param, prev, t, t0, t1, shape = 'power') {
  const from = fadeValue(prev, t);
  const f = { from, t0: Math.max(t, t0), t1: Math.max(t, t0, t1), shape };
  param.cancelScheduledValues(t);
  param.setValueAtTime(from, t);
  if (f.t0 > t) param.setValueAtTime(from, f.t0);
  for (const [ct, cv] of fadePoints(from, f.t0, f.t1, shape)) param.linearRampToValueAtTime(cv, ct);
  return f;
}
