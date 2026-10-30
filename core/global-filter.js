// The global Lowpass and Highpass (core/schema-audio.js 'lpf' and 'hpf',
// the Audio section under Master volume, and the show remote's LP and HP
// faders): one pair of corners, S.lpfHz and S.hpfHz, that every sound the
// app makes passes through on its way out.
//
// The app's sound lives in several AudioContexts (js/audio.js's, which the
// Heart engine, the heartbeat's track, the Sun's hum and gpu/slides.js's
// chain also play into, the slides with a pair of their own past the
// master's; the heartbeat's own when it has had to make one; Live Sound's
// monitor), and a node can only join its own context's graph. So
// each output chain asks createGlobalFilter(ctx) for its own highpass ->
// lowpass pair and puts it just before its destination; this module keeps
// the subscriptions and, when the corners move (notifyGlobalFilter, from the
// two controls' set()), glides every pair to them with setTargetAtTime.
// The glide is an exponential smooth, a one-pole lowpass on the control
// itself: S.filterGlideMs (Render's Audio engine drawer's filterGlide, the show
// remote's gear's Filter interpolation) is its time constant, 0 to 200 ms,
// 25 by default; 0 jumps. Each new setting restarts the glide from wherever
// the sound is, so the iPad's faders, arriving over the network in uneven
// lumps, come out one smooth curve, never a staircase.
// A pair reads the corners from S as it is made, so a chain built after a
// boot's load starts where the saved settings left them.
//
// Each has a resonance (S.lpfRes, S.hpfRes; the Audio section's lpfRes and
// hpfRes, the show remote's gear's Filters): the height of the peak at the
// corner, in dB over the passband, 0 to 24. At 0 the filter is Butterworth,
// maximally flat: Web Audio reads a lowpass's or highpass's Q in dB, so Q
// 0.707 (linear) is 20 log10(0.7071) = -3.01 dB. A second-order lowpass or
// highpass with linear Q q > 0.707 peaks at P = q^2 / sqrt(q^2 - 1/4), so a
// peak P asks for q^2 = P (P + sqrt(P^2 - 1)) / 2, and the slider's dB is
// the true height of the bump heard (6 dB a 6 dB bump), not the raw Q.
// Fully open (lowpass 20 kHz, highpass 20 Hz, the defaults) and flat they
// are transparent.
import { S } from '../js/state.js';

export const GF_HZ_LO = 20, GF_HZ_HI = 20000, GF_RES_MAX = 24, GF_GLIDE_MAX = 200;

// The bypass (Settings' Bypass live show audio, S.presentBypassAudio): a
// show's filter, left where the iPad's faders put it, would otherwise
// still be shaping this machine's sound days later. On, the pair reports
// itself fully open and flat, so every chain glides transparent at once;
// the corners themselves are untouched on S, so switching it off hands the
// show back exactly as it was.
// A page may also bypass the pair for itself, saving nothing: the standing
// playback (?event, main.js) does, so an event's page sounds as it was made
// to whatever a visitor's browser remembers — a filter closed for a show
// weeks ago is still in that browser's settings, and the drawing's page is
// nobody's mixing desk.
let pageBypass = false;
export function bypassGlobalFilter(on) {
  on = !!on;
  if (on === pageBypass) return;
  pageBypass = on;
  notifyGlobalFilter();
}
const bypassed = () => pageBypass || S.presentBypassAudio === true;
const clampHz = (v, def) => typeof v === 'number' && v === v ? Math.max(GF_HZ_LO, Math.min(GF_HZ_HI, v)) : def;
export const globalLowpassHz = () => bypassed() ? GF_HZ_HI : clampHz(S.lpfHz, GF_HZ_HI);
export const globalHighpassHz = () => bypassed() ? GF_HZ_LO : clampHz(S.hpfHz, GF_HZ_LO);
const clampRes = v => typeof v === 'number' && v === v ? Math.max(0, Math.min(GF_RES_MAX, v)) : 0;
export const globalLowpassRes = () => bypassed() ? 0 : clampRes(S.lpfRes);
export const globalHighpassRes = () => bypassed() ? 0 : clampRes(S.hpfRes);
const glideSec = () => {
  const ms = S.filterGlideMs;
  return typeof ms === 'number' && ms === ms ? Math.max(0, Math.min(GF_GLIDE_MAX, ms)) / 1000 : 0.025;
};
// A peak of res dB at the corner, as the Q in dB Web Audio takes (0 dB of
// peak is -3.01 dB, Butterworth)
const resToQdB = res => {
  const P = Math.pow(10, res / 20);
  return 10 * Math.log10(P * (P + Math.sqrt(P * P - 1)) / 2);
};

const subs = new Set();

// A highpass -> lowpass pair on ctx, subscribed: connect the chain into
// .input and .output on to the destination. dispose() lets it go.
export function createGlobalFilter(ctx) {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.Q.value = resToQdB(globalHighpassRes()); hp.frequency.value = globalHighpassHz();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = resToQdB(globalLowpassRes()); lp.frequency.value = globalLowpassHz();
  hp.connect(lp);
  const apply = () => {
    const t = ctx.currentTime, tc = glideSec();
    const to = (p, v) => {
      if (tc > 0) p.setTargetAtTime(v, t, tc);
      else { p.cancelScheduledValues(t); p.setValueAtTime(v, t); }
    };
    to(hp.frequency, globalHighpassHz());
    to(lp.frequency, globalLowpassHz());
    to(hp.Q, resToQdB(globalHighpassRes()));
    to(lp.Q, resToQdB(globalLowpassRes()));
  };
  subs.add(apply);
  return { input: hp, output: lp, hp, lp, dispose() { subs.delete(apply); } };
}

// The corners or their resonance moved on S: every pair glides to them.
export function notifyGlobalFilter() {
  for (const f of subs) { try { f(); } catch (e) {} }
}

// How many chains are listening (the e2e harness's check).
export const globalFilterCount = () => subs.size;
