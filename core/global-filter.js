// The global Lowpass and Highpass (core/schema-audio.js 'lpf' and 'hpf',
// the Audio section under Master volume, and the show remote's LP and HP
// faders): one pair of corners, S.lpfHz and S.hpfHz, that every sound the
// app makes passes through on its way out.
//
// The app's sound lives in several AudioContexts (js/audio.js's, which the
// Heart engine and the heartbeat's track also play into; core/sun-hum.js's;
// gpu/slides.js's; the heartbeat's own when it has had to make one; Live
// Sound's monitor), and a node can only join its own context's graph. So
// each output chain asks createGlobalFilter(ctx) for its own highpass ->
// lowpass pair and puts it just before its destination; this module keeps
// the subscriptions and, when the corners move (notifyGlobalFilter, from the
// two controls' set()), glides every pair to them with setTargetAtTime.
// A pair reads the corners from S as it is made, so a chain built after a
// boot's load starts where the saved settings left them.
//
// Both are Butterworth: Web Audio reads a lowpass's or highpass's Q in dB,
// so Q 0.707 (linear) is 20 log10(0.7071) = -3.01 dB. Fully open (lowpass
// 20 kHz, highpass 20 Hz, the defaults) they are transparent.
import { S } from '../js/state.js';

export const GF_HZ_LO = 20, GF_HZ_HI = 20000;
const Q_DB = 20 * Math.log10(Math.SQRT1_2);   // -3.01 dB: linear Q 0.707
const TC = 0.015;

const clampHz = (v, def) => typeof v === 'number' && v === v ? Math.max(GF_HZ_LO, Math.min(GF_HZ_HI, v)) : def;
export const globalLowpassHz = () => clampHz(S.lpfHz, GF_HZ_HI);
export const globalHighpassHz = () => clampHz(S.hpfHz, GF_HZ_LO);

const subs = new Set();

// A highpass -> lowpass pair on ctx, subscribed: connect the chain into
// .input and .output on to the destination. dispose() lets it go.
export function createGlobalFilter(ctx) {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.Q.value = Q_DB; hp.frequency.value = globalHighpassHz();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = Q_DB; lp.frequency.value = globalLowpassHz();
  hp.connect(lp);
  const apply = () => {
    const t = ctx.currentTime;
    hp.frequency.setTargetAtTime(globalHighpassHz(), t, TC);
    lp.frequency.setTargetAtTime(globalLowpassHz(), t, TC);
  };
  subs.add(apply);
  return { input: hp, output: lp, hp, lp, dispose() { subs.delete(apply); } };
}

// The corners moved on S: every pair glides to them.
export function notifyGlobalFilter() {
  for (const f of subs) { try { f(); } catch (e) {} }
}

// How many chains are listening (the e2e harness's check).
export const globalFilterCount = () => subs.size;
