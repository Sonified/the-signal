// The playback's smoothing, pure: a replayed stroke's points eased into a
// curve and laid finer than they were drawn, so a slowed playback glides
// instead of ticking. Robert, at Replay speed 0.05x: "as it gets slower
// they start to do tick tick tick and you can see each individual data
// point". The brush plays a timed stroke on a piecewise-linear timeline
// (core/brush-playback.js timelineAt) and lays its stamps along the
// straight line between points (core/brush-stamps.js walkSegment), so at
// every point there is a corner and a sudden change of speed; 20 times
// slower, each is 20 times as long and plain to see.
//
// So the pen is passed through a filter, and the filter is read off at
// sub-steps much finer than the points (SUB_MS of screen time each, the
// stretch's length on screen over SUB_MS, whatever the speed), each
// sub-step a point of its own with its own time. Smoothing alone would
// leave the same polygon with softer corners in the same places; read
// finely, the path is a curve and its pace changes evenly.
//
// The filter runs in the drawing's own time (the sender's ms), the input
// the drawn polyline as the brush has always read it (straight between
// points, at even pace between their times), and each sub-step is solved
// exactly for that straight input (ramp below), so how finely it is read
// changes how many points the curve has, never the curve itself.
//
//   Auto  an exponential follower whose time constant is AUTO_FACTOR of
//         each stretch's own gap: the pen eases into each point as its
//         time comes, the figure the same at every Replay speed, nothing
//         to set.
//   Set   the same follower with a time constant set in ms of screen time
//         (what you see), so a slower playback is eased over a shorter
//         stretch of the drawing.
//   1€    the One Euro filter (Casiez, Roussel and Vogel, CHI 2012): a
//         follower whose cutoff rises with the pen's speed, steady and
//         smooth when the hand moves slowly, close behind it when it moves
//         fast. One cutoff from the 2D speed for u and v alike, so the
//         figure turns with the drawing and nothing favours an axis.
//
// The numbers came from the WIN 2026 tape (tools/replay-smoothing-tune.mjs,
// which runs this very file): see AUTO_FACTOR and EURO_* below.
//
// Each drawer's filter carries from batch to batch (a state, smoothState):
// a continuation's first point, the sender's repeated joint, comes back as
// the last batch's last output exactly, so the walk goes on unbroken. A
// stroke's first batch starts the filter at its first point, and so does
// any batch whose joint is not the point the state last saw (the pass
// starting mid-stroke, the smoothing switched on mid-stroke).
//
// A stroke's end: the filter is a little behind the hand, so a last batch
// can settle (settle true): the pen carries on easing into the stroke's
// real last point after it, until it is within SETTLE_EPS of it, and is
// then placed on it exactly (at once, when it is that close already). A playback whose fade down lays a tail past
// the end does not settle; the tail carries on from the eased end.

export const SMOOTH_MODES = ['off', 'auto', 'set', 'euro'];
// Screen ms between sub-steps: about two frames of a 120 Hz screen, and
// at 0.05x a hand's 8 ms between points becomes 20 sub-steps.
export const SUB_MS = 8;
// Points a batch can come back with at most, its sub-steps then its
// settle. Within the brush's timeline (core/brush.js TL_CAP, 2048 a slot)
// with room for the batch before it still playing: a stretch too long for
// SUB_MAX at SUB_MS is read twice as coarsely, and again, until it fits.
export const SUB_MAX = 512, SETTLE_MAX = 256;
// Within this of the real end (unit-square units, about half a pixel on a
// laptop's field) the settle stops and the pen is placed on the end.
export const SETTLE_EPS = 0.0005;
// Set's time constant, ms of screen time, and its slider's top.
export const SET_MS_MAX = 2000, SET_MS_DEFAULT = 80;

// The numbers, from the WIN 2026 tape (tools/replay-smoothing-tune.mjs:
// 730 strokes, 101,755 point gaps). The points come about 59 a second
// (gaps 8 ms at p10, 17 median, 34 at p90, 83 at p99, 2 new a batch), the
// hands at 0.12 sides a second at p10, 0.66 median, 2.35 at p90, and they
// scatter about their own path by 0.0046 of the square's side even where
// the hand moves slowly (19 of the wire's steps, 3.8% of a w-50 mark's
// side): a phone's touch is that rough. Played at 0.05x and looked at a
// frame at a time, the drawn line's corners make it accelerate 227 sides
// a second squared RMS, which is the ticking.
//
// Auto's time constant as a share of each stretch's gap: 0.7, the knee of
// its front, the line kept within 2% of a mark of the drawing (0.0024
// sides) for 37% of the ticking (shares 0.1 to 5 tried; 1 keeps 34% at 3%
// off, 0.5 41% at 1.4%). Its floor is the gaps' own unevenness: each
// stretch eases at its own pace, so the pen's speed still steps a little
// where the gap does.
export const AUTO_FACTOR = 0.7;
// The One Euro filter's settings: min cutoff (Hz) the cutoff at rest,
// beta (Hz per side a second) how far speed raises it, d cutoff (Hz) the
// smoothing of the speed it reads. Min cutoff 0.5 to 12 Hz and beta 0 to
// 32 searched at d cutoff 1 Hz: the knee is 5 Hz (a time constant of 32
// ms of drawing), 10% of the ticking left with the line 3.8% of a mark
// off the drawing, just its own scatter; beta 0 there, as the hands'
// speeds hardly need the cutoff raised, but beta 1 keeps a fast flick
// closer (the cutoff half as high again at p90's 2.35 sides a second) and
// is on the front too, 13% of the ticking at 2.7% off, well within the
// scatter, so 5 Hz and beta 1.
export const EURO_MIN_HZ = 5, EURO_BETA = 1, EURO_D_HZ = 1;

// The settings the filter reads, these constants unless a tuning run
// (tools/replay-smoothing-tune.mjs) tries others; nothing else writes them.
export const smoothParams = { autoFactor: AUTO_FACTOR, euroMinHz: EURO_MIN_HZ, euroBeta: EURO_BETA, euroDHz: EURO_D_HZ };

const TWO_PI = Math.PI * 2;

// One filter stage over a straight stretch: the input x0 + b s for s in
// 0..h, the output y following it with time constant tau, solved exactly
// (y' = (x - y) / tau). tau 0 is no filter at all: the input itself.
export function ramp(y, x0, b, h, tau) {
  const x1 = x0 + b * h;
  if (!(tau > 0)) return x1;
  return x1 - b * tau + (y - x0 + b * tau) * Math.exp(-h / tau);
}

// A drawer's filter state: the pen (yu, yv), the One Euro's smoothed
// velocity (du, dv, unit-square sides a ms), the raw point and time it
// last read (ru, rv, rt), so the next batch's joint can be told, and
// whether it is live.
const YU = 0, YV = 1, DU = 2, DV = 3, RU = 4, RV = 5, RT = 6, ON = 7;
export function smoothState() { return new Float64Array(8); }
export function smoothLive(st) { return st[ON] === 1; }
export function smoothEnd(st) { st[ON] = 0; }
// The pen where the state last left it.
export function smoothPen(st, out) { out.u = st[YU]; out.v = st[YV]; return out; }
// Whether a batch whose first point (the joint) is (u, v) at drawing time
// t carries on where the state left off: live, and that point the very
// one it last read.
export function smoothJoins(st, t, u, v) {
  return st[ON] === 1 && st[RT] === t && st[RU] === u && st[RV] === v;
}

// The output, reused by every call: drawing time (sender ms) and position.
const OUT_N = SUB_MAX + SETTLE_MAX + 2;
export const smoothOut = { t: new Float64Array(OUT_N), u: new Float64Array(OUT_N), v: new Float64Array(OUT_N), n: 0 };
function put(t, u, v) {
  const o = smoothOut, n = o.n;
  if (n >= OUT_N) return;
  o.t[n] = t; o.u[n] = u; o.v[n] = v; o.n = n + 1;
}

// The time constant (drawing ms) for one sub-step, and for the One Euro
// its speed read first: g the stretch's gap, h the sub-step, bu bv the
// input's velocity over it.
let tauSet = 0;
function tauFor(mode, st, g, h, bu, bv) {
  const P = smoothParams;
  if (mode === 1) return P.autoFactor * g;
  if (mode === 2) return tauSet;
  const e = Math.exp(-h * TWO_PI * P.euroDHz / 1000);
  st[DU] = bu + (st[DU] - bu) * e;
  st[DV] = bv + (st[DV] - bv) * e;
  const hz = P.euroMinHz + P.euroBeta * Math.hypot(st[DU], st[DV]) * 1000;
  return 1000 / (TWO_PI * hz);
}

// One batch through the filter. mode a SMOOTH_MODES index (1 auto, 2 set,
// 3 euro; anything else returns -1 and leaves everything as it is), setMs
// Set's time constant in screen ms. T the points' drawing times (sender
// ms, ascending), U V their positions (unit square), n how many; d the
// batch's place in its stroke; scale screen ms per drawing ms (the pass's
// scale over the speed); st the drawer's state; settle whether a last
// batch eases into its real end. Fills smoothOut (from the batch's first
// point, the joint, to its last at T[n - 1], then any settle after it) and
// returns its count.
export function smoothBatch(mode, setMs, T, U, V, n, d, scale, st, settle) {
  const o = smoothOut;
  o.n = 0;
  if (!(mode >= 1 && mode <= 3) || !(n > 0) || !(scale > 0)) return -1;
  tauSet = setMs > 0 ? setMs / scale : 0;
  const cont = d !== 0 && smoothJoins(st, T[0], U[0], V[0]);
  if (!cont) { st[YU] = U[0]; st[YV] = V[0]; st[DU] = 0; st[DV] = 0; }
  st[ON] = 1;
  put(T[0], st[YU], st[YV]);
  // how finely: SUB_MS of screen time, coarser until it fits SUB_MAX
  let sub = SUB_MS / scale, total = 0;
  for (;;) {
    total = 0;
    for (let i = 1; i < n; i++) { const g = T[i] - T[i - 1]; if (g > 0) total += Math.ceil(g / sub - 1e-9); }
    if (total <= SUB_MAX) break;
    sub *= 2;
  }
  for (let i = 1; i < n; i++) {
    const g = T[i] - T[i - 1];
    if (!(g > 0)) continue;   // two points at one time: the input steps, the pen follows from here
    const steps = Math.ceil(g / sub - 1e-9), h = g / steps;
    const bu = (U[i] - U[i - 1]) / g, bv = (V[i] - V[i - 1]) / g;
    for (let k = 0; k < steps; k++) {
      const x0u = U[i - 1] + bu * h * k, x0v = V[i - 1] + bv * h * k;
      const tau = tauFor(mode, st, g, h, bu, bv);
      st[YU] = ramp(st[YU], x0u, bu, h, tau);
      st[YV] = ramp(st[YV], x0v, bv, h, tau);
      put(k + 1 === steps ? T[i] : T[i - 1] + h * (k + 1), st[YU], st[YV]);
    }
  }
  const zu = U[n - 1], zv = V[n - 1], zt = T[n - 1];
  st[RU] = zu; st[RV] = zv; st[RT] = zt;
  if (settle) {
    const D = Math.hypot(st[YU] - zu, st[YV] - zv);
    if (D > SETTLE_EPS) {
      // the slowest the filter can ease at rest, and how long from D down
      // to SETTLE_EPS at that: an exponential's ln(D / eps) time constants
      let g = n > 1 ? (zt - T[0]) / (n - 1) : 0;
      if (!(g > 0)) g = SUB_MS;
      const tauRest = mode === 1 ? smoothParams.autoFactor * g : mode === 2 ? tauSet : 1000 / (TWO_PI * smoothParams.euroMinHz);
      const span = tauRest * Math.log(D / SETTLE_EPS);
      let steps = Math.ceil(span / (SUB_MS / scale) - 1e-9);
      if (steps > SETTLE_MAX) steps = SETTLE_MAX;
      if (steps < 1) steps = 1;
      const h = span / steps;
      for (let k = 1; k <= steps; k++) {
        const tau = tauFor(mode, st, g, h, 0, 0);
        st[YU] = ramp(st[YU], zu, 0, h, tau);
        st[YV] = ramp(st[YV], zv, 0, h, tau);
        put(zt + h * k, k === steps ? zu : st[YU], k === steps ? zv : st[YV]);
      }
      st[YU] = zu; st[YV] = zv;
    } else if (D > 0) {
      // already within it: the last point is placed on the end itself
      o.u[o.n - 1] = zu; o.v[o.n - 1] = zv;
      st[YU] = zu; st[YV] = zv;
    }
  }
  if (d === 2) st[ON] = 0;
  return o.n;
}
