// The output guard: a limiter, then a soft clipper, the last thing every
// sound the app makes passes before the speakers (Render > Audio engine,
// 'Limiter' and 'Soft clip', S.outLimiter and S.outSoftClip, both on by
// default and this machine's own). Material well inside full scale goes
// through untouched; loud material (a slide at its 150% volume, a stack of
// voices landing together) is held down by the limiter and whatever still
// gets past it is rounded by the clipper instead of hard clipping in the
// converter.
//
// As with the global filter (core/global-filter.js), the sound lives in
// more than one AudioContext (js/audio.js's, which the slides now share;
// Live Sound's low-latency monitor), and a node joins only its own
// context's graph, so each output chain asks createOutputGuard(ctx) for one
// of its own and puts it straight before its destination. This module keeps
// the list; applyOutputGuards (the two toggles' set(), and a settings load)
// brings every guard to what S says.
//
//   input -> limDry --------------------------> mid
//         -> limiter -> limTrim -> limWet -----> mid
//   mid   -> clipDry --------------------------> output
//         -> clipPre (x0.5) -> shaper -> clipWet -> output
//
// BYPASS: every node stays in the graph and a stage is switched by
// crossfading its wet and dry gains on one time constant (XF_TC, about 25 ms
// to settle), complementary targets on the same glide so the two always sum
// to exactly 1. Nothing is ever disconnected, so a toggle never clicks.
// The compressor delays what it passes by a fixed 6 ms (its lookahead; see
// heart/src/nodes/dynamics_compressor.rs), and the 4x oversampler's
// resampling filters add a short delay of their own, so for the length of a
// crossfade the dry and wet sides are slightly apart in time and comb for
// those few tens of milliseconds. That is the price of never cutting; once
// the fade lands only one side is heard. With the limiter on, everything
// plays those 6 ms later than with it off, which the eye cannot tell.
//
// THE LIMITER: a DynamicsCompressorNode set firm. Threshold -3 dBFS with a
// 2.5 dB knee (so the bend runs from -3 to -0.5 dBFS) and ratio 20; attack
// 3 ms, which with the node's 6 ms lookahead has the gain down before a
// peak reaches the output; release 0.12 s, quick enough to let go between
// phrases without riding each low cycle. Static curve, peak in to peak out:
//   -6 dBFS -> -6.00   -3 -> -3.00   -2 -> -2.40   -1 -> -2.20
//    0 dBFS -> -2.14   +3 -> -1.99   +6 -> -1.84  +10 -> -1.64
// The makeup-gain trap, as core/heartbeat.js found it: the spec has the node
// apply a fixed makeup gain, (1 / curve(1.0)) ^ 0.6, whatever its input, so
// left alone the limiter would make everything below the threshold louder
// and switching it on would change the mix. With this knee the curve's
// full-scale output is -2.144 dB (Chrome's knee: an exponential from the
// threshold whose k, found by the same bisection Chrome runs, gives slope
// 1/ratio at the knee's end, k = 13.48), so the makeup is 0.6 x 2.144 =
// +1.286 dB, and LIM_TRIM after the node (x0.8624, -1.286 dB) takes it
// back off. Below -3 dBFS the stage is unity, on or off. LIM_TRIM is worked
// out here from the same curve rather than written in, so a change to the
// threshold, knee or ratio carries its own trim (limTrim, below).
//
// THE SOFT CLIP: a WaveShaperNode, oversampled 4x so the rounding's new
// harmonics fold back far less. Its curve is exactly x (unity, transparent)
// up to CLIP_KNEE (0.5, -6 dBFS), then CLIP_KNEE + r tanh((|x| - CLIP_KNEE)
// / r) with r = CLIP_CEIL - CLIP_KNEE: the same slope (1) and value at the
// knee, so it bends without a corner, and it approaches CLIP_CEIL (-0.2
// dBFS) without ever reaching it. A shaper reads its input in [-1, 1] and
// holds anything beyond at the curve's ends, so the input is first halved
// (clipPre) and the curve drawn over twice the range: a shaper input u is a
// signal x = 2u, the curve's value at u is f(2u), and the stage is unity
// below the knee with room for overs to +6 dBFS (where it reads -0.22 dBFS)
// before the shaper's own clamp, which by then is flat. An odd length puts
// a point at exactly 0, so silence stays silence.
// With the limiter ahead of it, what reaches the clipper peaks around -2
// dBFS, which the curve rounds by a few tenths of a dB; on its own it is the
// only thing between an over and the converter.
//
// Any context whose graph lacks either node (a test's recording stand-in)
// gets a plain pass-through, so a chain can always ask for one.
import { S } from '../js/state.js';

const LIM_THRESHOLD = -3, LIM_KNEE = 2.5, LIM_RATIO = 20;
const LIM_ATTACK = 0.003, LIM_RELEASE = 0.12;
const CLIP_KNEE = 0.5;
const CLIP_CEIL = Math.pow(10, -0.2 / 20);   // -0.2 dBFS
const CLIP_PRE = 0.5;                        // overs to +6 dBFS reach the curve
const CLIP_POINTS = 8193;                    // odd: a point at exactly 0
const XF_TC = 0.008;                         // ~25 ms to settle

// The trim that cancels the compressor's makeup, from the static curve as
// Chrome computes it (DynamicsCompressorKernel, ported line for line in
// heart/src/nodes/dynamics_compressor.rs): the knee's k by fifteen steps of
// bisection on its slope at the knee's end, the curve's output for a full
// scale input, and the spec's makeup, (1 / that) ^ 0.6, inverted.
function limTrim(T, K, R) {
  const d2l = db => Math.pow(10, 0.05 * db), l2d = x => 20 * Math.log10(x);
  const lt = d2l(T);
  const knee = (x, k) => x < lt ? x : lt + (1 - Math.exp(-k * (x - lt))) / k;
  const dbx = T + K, x = d2l(dbx);
  let x2 = 1, dbx2 = 0;
  if (!(x < lt)) { x2 = x * 1.001; dbx2 = l2d(x2); }
  let lo = 0.1, hi = 10000, k = 5, slope = 1;
  for (let i = 0; i < 15; i++) {
    if (!(x < lt)) slope = (l2d(knee(x2, k)) - l2d(knee(x, k))) / (dbx2 - dbx);
    if (slope < 1 / R) hi = k; else lo = k;
    k = Math.sqrt(lo * hi);
  }
  const kt = d2l(T + K);
  const full = 1 < kt ? knee(1, k) : d2l(l2d(knee(kt, k)) + (0 - (T + K)) / R);
  return Math.pow(full, 0.6);
}
const LIM_TRIM = limTrim(LIM_THRESHOLD, LIM_KNEE, LIM_RATIO);   // 0.8624, -1.286 dB

// The clip's curve, made once and shared by every guard.
let curve = null;
function clipCurve() {
  if (curve) return curve;
  curve = new Float32Array(CLIP_POINTS);
  const r = CLIP_CEIL - CLIP_KNEE, mid = (CLIP_POINTS - 1) / 2;
  for (let i = 0; i < CLIP_POINTS; i++) {
    const x = (i - mid) / mid / CLIP_PRE, a = Math.abs(x);
    curve[i] = a <= CLIP_KNEE ? x : Math.sign(x) * (CLIP_KNEE + r * Math.tanh((a - CLIP_KNEE) / r));
  }
  return curve;
}

export const limiterOn = () => S.outLimiter !== false;
export const softClipOn = () => S.outSoftClip !== false;

const guards = new Set();

// NOTE (2026-10-21, known-ussues.md 'Audio: device switch plays at the new
// device's own volume'): when the OS moves the output to another device
// (headphones plugged in mid-play), the audio simply continues there at
// that device's hardware volume. A reactive fade here was tried and
// reverted: the page only learns of the switch after the sound has already
// moved, so the fade trailed a full-volume burst and added artifacts of
// its own. The real fix, if ever wanted, is to pin the context's output
// (AudioContext.setSinkId) and perform route changes deliberately — duck,
// switch, fade — at the cost of a one-time media-device permission.

// A guard on ctx, registered: connect the chain into .input and .output on
// to the destination. apply(tc) brings both stages to S (a no-op when they
// are already there); dispose() lets it go with its context.
export function createOutputGuard(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  if (typeof ctx.createDynamicsCompressor !== 'function' || typeof ctx.createWaveShaper !== 'function') {
    input.connect(output);
    return { input, output, apply() {}, dispose() {} };
  }
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = LIM_THRESHOLD;
  lim.knee.value = LIM_KNEE;
  lim.ratio.value = LIM_RATIO;
  lim.attack.value = LIM_ATTACK;
  lim.release.value = LIM_RELEASE;
  const trim = ctx.createGain();
  trim.gain.value = LIM_TRIM;
  const limDry = ctx.createGain(), limWet = ctx.createGain(), mid = ctx.createGain();
  input.connect(limDry); limDry.connect(mid);
  input.connect(lim); lim.connect(trim); trim.connect(limWet); limWet.connect(mid);

  const pre = ctx.createGain();
  pre.gain.value = CLIP_PRE;
  const shaper = ctx.createWaveShaper();
  shaper.curve = clipCurve();
  shaper.oversample = '4x';
  const clipDry = ctx.createGain(), clipWet = ctx.createGain();
  mid.connect(clipDry); clipDry.connect(output);
  mid.connect(pre); pre.connect(shaper); shaper.connect(clipWet); clipWet.connect(output);

  // Built where S stands, with no glide; after that, only a change moves.
  let limNow = limiterOn(), clipNow = softClipOn();
  limWet.gain.value = limNow ? 1 : 0; limDry.gain.value = limNow ? 0 : 1;
  clipWet.gain.value = clipNow ? 1 : 0; clipDry.gain.value = clipNow ? 0 : 1;

  function apply(tc = XF_TC) {
    if (ctx.state === 'closed') return;
    const l = limiterOn(), c = softClipOn();
    if (l === limNow && c === clipNow) return;
    const t = ctx.currentTime;
    if (l !== limNow) {
      limNow = l;
      limWet.gain.setTargetAtTime(l ? 1 : 0, t, tc);
      limDry.gain.setTargetAtTime(l ? 0 : 1, t, tc);
    }
    if (c !== clipNow) {
      clipNow = c;
      clipWet.gain.setTargetAtTime(c ? 1 : 0, t, tc);
      clipDry.gain.setTargetAtTime(c ? 0 : 1, t, tc);
    }
  }
  guards.add(apply);
  return { input, output, limiter: lim, shaper, apply, dispose() { guards.delete(apply); } };
}

// S.outLimiter or S.outSoftClip moved: every guard crossfades to it.
export function applyOutputGuards() {
  for (const f of guards) { try { f(); } catch (e) {} }
}

// How many chains are guarded (for a harness's check).
export const outputGuardCount = () => guards.size;
