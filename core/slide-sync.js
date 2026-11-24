// Where the broadcaster's slide video is, for a follower that joins late. Pure
// arithmetic, no imports, so tools/slide-join.test.mjs can run it as it is.
//
// A state message carries the broadcaster's slide as it stood when the
// message was made (sp, the shape of gpu/slides.js slidesProgress and of the
// controller's own vp: t seconds in, d its length, r the rate it was
// advancing at, 0 paused, held or ended, f the file, l whether it loops),
// beside the message's own `at`, that same moment on the room's shared clock
// (core/broadcast.js stateBody). The relay keeps the last state for
// joiners, so a copy read minutes later still says where the video is NOW:
// the elapsed shared time times the rate, from t. That holds for as long as
// nothing changes the video's course, which is why the broadcaster sends a
// fresh state whenever it does (slideCourseSame below, core/broadcast.js
// slideWatch): a new file, a pause or play, a change of rate, a seek, the end.
// A follower watching already is moved again on each such change of its
// slide's course (slideChanged), never while the course stays the same.

// gpu/slides.js's own threshold for a playbackRate that has moved.
const RATE_EPS = 0.001;

// Where the slide is `elapsed` seconds after sp was taken: played on at its
// rate, wrapped round its length when it loops, held at its end when it does
// not (as the element itself stops there, gpu/slides.js 'ended'). A length
// not yet known leaves it unwrapped and unclamped.
export function slidePosition(sp, elapsed) {
  const r = sp.r > 0 ? sp.r : 0, d = sp.d;
  let t = (sp.t > 0 ? sp.t : 0) + r * (elapsed > 0 ? elapsed : 0);
  if (!(d > 0 && isFinite(d))) return t;
  if (sp.l) return r > 0 ? t % d : Math.min(t, d);
  return t < d ? t : d;
}

// How far `t` is from `target` on a video of length d: plain, or the
// shorter way round for one that loops (so 0.1 s past the top is near the
// end of the last lap, not a whole lap away).
export function slideOffset(target, t, d, loops) {
  const e = target - t;
  if (!loops || !(d > 0 && isFinite(d))) return e;
  const w = ((e % d) + d) % d;
  return w > d / 2 ? w - d : w;
}

// Whether a slide sample b is still on the course a (same file, length,
// loop and rate), so extrapolating a still lands on b. Positions are not
// compared here: a jump (a seek, a Restart) is caught by its distance from
// where the course says it should be (core/broadcast.js slideWatch). null
// for no slide on either side.
export function slideCourseSame(a, b) {
  if (!a || !b) return !a && !b;
  return a.f === b.f && a.l === b.l && Math.abs((a.r || 0) - (b.r || 0)) <= RATE_EPS &&
    (a.d === b.d || (!(a.d > 0) && !(b.d > 0)));
}

// Whether a sample is a slide that has played to its end and stopped there
// (not a pause: nothing to hold, the follower's own copy runs out too).
export function slideEnded(sp) {
  return !!sp && !sp.l && sp.d > 0 && isFinite(sp.d) && sp.t >= sp.d;
}

// Whether a follower must be moved to the room's slide again, given the
// last state's sample a (taken at aAt on the shared clock) and the new one
// b (at bAt): the same slide changed its course (paused, played, a new
// rate, Loop) or jumped from where a's course puts it by more than tol (a
// seek, a Restart). Never for the same course played on, so nothing here
// is a running correction. A new slide that plays starts with everyone's
// and is left alone; one that arrives held is landed on. A slide that has
// played to its end is left to run out on its own copy.
export function slideChanged(a, aAt, b, bAt, tol) {
  if (!b || slideEnded(b)) return false;
  if (!a || a.f !== b.f) return !(b.r > 0);
  if (!slideCourseSame(a, b)) return true;
  if (!Number.isFinite(aAt) || !Number.isFinite(bAt)) return false;
  return Math.abs(slideOffset(slidePosition(a, (bAt - aAt) / 1000), b.t, b.d, b.l)) > tol;
}

// A sample from the wire, or null: anything malformed is passed over.
export function slideSample(x) {
  if (!x || typeof x !== 'object' || typeof x.f !== 'string' || !x.f) return null;
  if (!Number.isFinite(x.t) || !Number.isFinite(x.r)) return null;
  return { f: x.f, t: x.t, d: Number.isFinite(x.d) ? x.d : NaN, r: x.r, l: x.l === true };
}
