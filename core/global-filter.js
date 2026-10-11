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

export const GF_HZ_LO = 20, GF_HZ_HI = 20000, GF_RES_MAX = 24;
const TC = 0.015;

const clampHz = (v, def) => typeof v === 'number' && v === v ? Math.max(GF_HZ_LO, Math.min(GF_HZ_HI, v)) : def;
export const globalLowpassHz = () => clampHz(S.lpfHz, GF_HZ_HI);
export const globalHighpassHz = () => clampHz(S.hpfHz, GF_HZ_LO);
const clampRes = v => typeof v === 'number' && v === v ? Math.max(0, Math.min(GF_RES_MAX, v)) : 0;
export const globalLowpassRes = () => clampRes(S.lpfRes);
export const globalHighpassRes = () => clampRes(S.hpfRes);
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
    const t = ctx.currentTime;
    hp.frequency.setTargetAtTime(globalHighpassHz(), t, TC);
    lp.frequency.setTargetAtTime(globalLowpassHz(), t, TC);
    hp.Q.setTargetAtTime(resToQdB(globalHighpassRes()), t, TC);
    lp.Q.setTargetAtTime(resToQdB(globalLowpassRes()), t, TC);
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
