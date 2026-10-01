// The null tests' scenarios and the arithmetic of the bench
// (documents/heart-audio-engine.md, §9). Each scenario is one function of a
// context, run twice: once on a native OfflineAudioContext and once on
// Heart's OfflineHeartContext, the same calls on both, which is the twin
// design paying off. The two renders are subtracted, and what is left, the
// residual, has to sit below the scenario's pass mark.
//
// This file has no page in it, so node can run every scenario on the Heart
// side alone (tools/heart-tests/bench.test.mjs) to catch a crash or a
// refused command; only a browser can render the native side and compare.
// tools/null-test.js is the page.
//
// A scenario is { id, group, name, pass, seconds, worklets?, note?, run }:
//
//   pass       the residual's peak must be below this, in dBFS (§9's table)
//   seconds    how long to render
//   worklets   it uses the app's processors, so the native context loads
//              js/worklet.js and js/fdn-worklet.js first, and is given a
//              moment for port messages to reach them before it renders
//   run(ctx, kit)
//              builds the graph and schedules everything, with every time
//              given against a currentTime of 0. kit holds the helpers below.
//
// Sample buffers are made once per scenario and rate and handed to both
// contexts, so the native node and the Heart node read the very same
// AudioBuffer (a convolver's impulse, a source's samples).

import { OfflineHeartContext } from '../js/heart/heart.js';
import { makeWorklet } from '../js/heart/route.js';

const WORKLET_URL = new URL('../js/worklet.js', import.meta.url).href;
const FDN_URL = new URL('../js/fdn-worklet.js', import.meta.url).href;

// The pass marks of §9, by what is being tested.
export const MARK = {
  exact: -90,       // gain, constant source, panner, every automation shape, the app's processors
  filter: -80,      // biquad, delay, convolver
  band: -60         // oscillators (band-limiting is the browser's), resampling and loops
};

// ---------- the kit ----------
// A small, seeded random number generator (mulberry32), so a noise buffer is
// the same on every run and both sides.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeKit(ctx, cache) {
  const sr = ctx.sampleRate;
  // A buffer of `channels` × `seconds`, sample i of channel c being
  // fill(c, i), made once per scenario and rate.
  function buffer(name, channels, seconds, fill) {
    const key = `${name}@${sr}`;
    let buf = cache.get(key);
    if (!buf) {
      const length = Math.max(1, Math.round(seconds * sr));
      buf = new AudioBuffer({ numberOfChannels: channels, length, sampleRate: sr });
      for (let c = 0; c < channels; c++) {
        const x = buf.getChannelData(c);
        for (let i = 0; i < length; i++) x[i] = fill(c, i);
      }
      cache.set(key, buf);
    }
    return buf;
  }
  return {
    sr,
    buffer,
    // White noise at `level`, a different stream per channel.
    noise(name, channels, seconds, level = 0.5, seed = 1) {
      const rngs = Array.from({ length: channels }, (_, c) => random(seed * 7919 + c));
      return buffer(name, channels, seconds, c => level * (2 * rngs[c]() - 1));
    },
    // Something like music: a few partials and a decaying noise, for the
    // sources whose interpolation is under test (noise alone would test the
    // interpolation of noise, which no ear hears).
    tones(name, channels, seconds) {
      const r = random(5);
      return buffer(name, channels, seconds, (c, i) => {
        const t = i / sr;
        return 0.3 * Math.sin(2 * Math.PI * (220 + 3 * c) * t) + 0.15 * Math.sin(2 * Math.PI * 663 * t + c)
          + 0.08 * Math.sin(2 * Math.PI * 1771 * t) + 0.1 * Math.exp(-3 * t) * (2 * r() - 1);
      });
    },
    // A source of one buffer, started at `when`.
    play(buf, when = 0, dest = ctx.destination) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start(when);
      return src;
    },
    // A constant source at `level`, started at once, into `dest`.
    constant(level, dest) {
      const src = ctx.createConstantSource();
      src.offset.value = level;
      src.connect(dest);
      src.start(0);
      return src;
    },
    worklet: (name, opts) => makeWorklet(ctx, name, opts)
  };
}

// ---------- rendering ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The two renders of one scenario at one rate, as [left, right] arrays.
export async function renderNative(sc, sampleRate, cache = new Map()) {
  const length = Math.round(sc.seconds * sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  if (sc.worklets) await Promise.all([ctx.audioWorklet.addModule(WORKLET_URL), ctx.audioWorklet.addModule(FDN_URL)]);
  await sc.run(ctx, makeKit(ctx, cache));
  // A processor hears its port messages between renders, so they are given
  // time to arrive before the first one, as Heart applies them before frame 0.
  if (sc.worklets) await sleep(60);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

// Heart's render, and its stage's counters (any command it refused is a
// fault of the wire, not of the sound). `wasm` is a URL, bytes or a module
// (node passes bytes; the page lets it default to js/heart/heart.wasm).
export async function renderHeart(sc, sampleRate, cache = new Map(), wasm) {
  const length = Math.round(sc.seconds * sampleRate);
  const ctx = await OfflineHeartContext.create({ numberOfChannels: 2, length, sampleRate, wasm });
  await sc.run(ctx, makeKit(ctx, cache));
  const out = await ctx.startRendering();
  const [stats] = await ctx.inspect();
  return { channels: [out.getChannelData(0), out.getChannelData(1)], stats };
}

export const dB = x => x > 0 ? 20 * Math.log10(x) : -Infinity;

// native minus Heart: the peak and RMS of what is left, over both channels,
// the louder side's peak for scale, and the residual itself to draw.
export function residual(native, heart) {
  let peak = 0, sum = 0, n = 0, level = 0;
  const diff = native.map((x, c) => {
    const y = heart[c], d = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = x[i] - y[i];
      d[i] = v;
      const a = Math.abs(v);
      if (a > peak || a !== a) peak = a !== a ? Infinity : a;
      sum += v * v;
      level = Math.max(level, Math.abs(x[i]), Math.abs(y[i]));
    }
    n += x.length;
    return d;
  });
  const rms = Math.sqrt(sum / n);
  return { peak, rms, level, peakDb: dB(peak), rmsDb: dB(rms), levelDb: dB(level), diff };
}

// ---------- the scenarios ----------
export const SCENARIOS = [];
function scenario(group, pass, seconds, name, run, more = {}) {
  const id = `${group}: ${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  SCENARIOS.push({ id, group, name, pass, seconds, run, ...more });
}

// ----- automation, on a ConstantSource into a Gain -----
// The source holds 1, so the output is the gain's own value, frame by frame.
function onGain(name, automate, seconds = 1.5) {
  scenario('Automation', MARK.exact, seconds, name, (ctx, kit) => {
    const g = ctx.createGain();
    g.connect(ctx.destination);
    kit.constant(1, g);
    automate(g.gain, ctx);
  });
}
onGain('a ramp with nothing before it', p => p.linearRampToValueAtTime(0.25, 0.8));
onGain('setValueAtTime steps', p => {
  p.setValueAtTime(0.2, 0.1);
  p.setValueAtTime(0.7, 0.35);
  p.setValueAtTime(-0.4, 0.618034);
  p.setValueAtTime(0.9, 1.0001);
});
onGain('linearRampToValueAtTime', p => {
  p.setValueAtTime(0, 0.1);
  p.linearRampToValueAtTime(1, 0.6);
  p.linearRampToValueAtTime(-0.5, 0.9);
  p.linearRampToValueAtTime(0.3, 1.31);
});
onGain('exponentialRampToValueAtTime', p => {
  p.setValueAtTime(0.01, 0.1);
  p.exponentialRampToValueAtTime(1, 0.7);
  p.exponentialRampToValueAtTime(0.05, 1.2);
});
onGain('setTargetAtTime', p => {
  p.setTargetAtTime(1, 0.1, 0.05);
  p.setTargetAtTime(0.2, 0.5, 0.2);
  p.setTargetAtTime(0, 1.0, 0.01);
});
onGain('setValueCurveAtTime, then a ramp', p => {
  p.setValueCurveAtTime([0, 0.5, 0.2, 1, 0.3], 0.1, 0.8);
  p.linearRampToValueAtTime(0, 1.3);
});
onGain('the .value setter, then a ramp', p => {
  p.value = 0.3;
  p.linearRampToValueAtTime(1, 0.5);
});
onGain('a ramp after setTarget', p => {
  p.setTargetAtTime(1, 0.1, 0.1);
  p.linearRampToValueAtTime(0, 0.8);
});
onGain('an exponential ramp across zero holds', p => {
  p.setValueAtTime(-0.5, 0.1);
  p.exponentialRampToValueAtTime(0.5, 0.6);
  p.linearRampToValueAtTime(0.2, 1.1);
});
onGain('cancelScheduledValues', p => {
  p.setValueAtTime(0, 0.1);
  p.linearRampToValueAtTime(1, 1.0);
  p.setValueAtTime(0.4, 1.2);
  p.cancelScheduledValues(0.5);
  p.setValueAtTime(0.8, 0.7);
});
onGain('cancelAndHoldAtTime mid linear ramp', p => {
  p.setValueAtTime(0, 0.1);
  p.linearRampToValueAtTime(1, 1.1);
  p.cancelAndHoldAtTime(0.6);
  p.linearRampToValueAtTime(0.2, 1.0);
});
onGain('cancelAndHoldAtTime mid exponential ramp', p => {
  p.setValueAtTime(0.05, 0.1);
  p.exponentialRampToValueAtTime(1, 1.1);
  p.cancelAndHoldAtTime(0.55);
});
onGain('cancelAndHoldAtTime mid setTarget', p => {
  p.setTargetAtTime(1, 0.1, 0.3);
  p.cancelAndHoldAtTime(0.5);
  p.linearRampToValueAtTime(0, 0.9);
});
onGain('cancelAndHoldAtTime mid curve', p => {
  p.setValueCurveAtTime([1, 0.2, 0.8, 0], 0.1, 1.0);
  p.cancelAndHoldAtTime(0.55);
});
scenario('Automation', MARK.exact, 1.2, 'a-rate offset, start and stop between samples', (ctx, kit) => {
  const src = ctx.createConstantSource();
  src.offset.setValueAtTime(0.2, 0);
  src.offset.linearRampToValueAtTime(-0.8, 0.7);
  src.connect(ctx.destination);
  src.start(0.1 + 0.3 / kit.sr);
  src.stop(0.9 + 0.7 / kit.sr);
});

// ----- audio into a param -----
scenario('Param input', MARK.exact, 1.2, 'a source into a gain\'s gain', (ctx, kit) => {
  const g = ctx.createGain();
  g.gain.value = 0.5;
  g.connect(ctx.destination);
  kit.constant(1, g);
  const m = ctx.createConstantSource();
  m.offset.setValueAtTime(-0.5, 0);
  m.offset.linearRampToValueAtTime(0.5, 1);
  m.connect(g.gain);
  m.start(0.05);
});
scenario('Param input', MARK.exact, 1.2, 'a source into a panner\'s pan, clamped', (ctx, kit) => {
  const p = ctx.createStereoPanner();
  p.pan.value = 0.4;
  p.connect(ctx.destination);
  kit.play(kit.tones('tones', 1, 1.2), 0, p);
  const m = ctx.createConstantSource();
  m.offset.setValueAtTime(-1.5, 0);
  m.offset.linearRampToValueAtTime(1.5, 1.1);
  m.connect(p.pan);
  m.start(0);
});
scenario('Param input', MARK.filter, 1.2, 'a source into a biquad\'s frequency', (ctx, kit) => {
  const f = ctx.createBiquadFilter();
  f.frequency.value = 300;
  f.Q.value = 4;
  f.connect(ctx.destination);
  kit.play(kit.noise('noise', 1, 1.2), 0, f);
  const m = ctx.createConstantSource();
  m.offset.setValueAtTime(0, 0);
  m.offset.exponentialRampToValueAtTime(5000, 1.0);
  m.connect(f.frequency);
  m.start(0);
});

// ----- StereoPanner -----
function panner(name, channels, automate) {
  scenario('StereoPanner', MARK.exact, 1, name, (ctx, kit) => {
    const p = ctx.createStereoPanner();
    p.connect(ctx.destination);
    kit.play(channels === 1 ? kit.tones('tones', 1, 1) : kit.noise('noise2', 2, 1), 0, p);
    automate(p.pan);
  });
}
panner('mono, static', 1, p => { p.value = 0.3; });
panner('mono, moving', 1, p => { p.setValueAtTime(-1, 0.05); p.linearRampToValueAtTime(1, 0.95); });
panner('stereo, static', 2, p => { p.value = -0.4; });
panner('stereo, moving', 2, p => { p.setValueAtTime(1, 0.05); p.linearRampToValueAtTime(-1, 0.6); p.setTargetAtTime(0.2, 0.6, 0.1); });

// ----- Delay -----
scenario('Delay', MARK.filter, 1, 'fixed, between samples', (ctx, kit) => {
  const d = ctx.createDelay(1);
  d.delayTime.value = 0.0123;
  d.connect(ctx.destination);
  kit.play(kit.noise('burst', 1, 0.2), 0.05, d);
});
scenario('Delay', MARK.filter, 1.2, 'moving', (ctx, kit) => {
  const d = ctx.createDelay(1);
  d.delayTime.setValueAtTime(0.005, 0);
  d.delayTime.linearRampToValueAtTime(0.03, 1);
  d.connect(ctx.destination);
  kit.play(kit.tones('tones', 1, 1.2), 0, d);
});
scenario('Delay', MARK.filter, 2, 'in a feedback loop', (ctx, kit) => {
  const d = ctx.createDelay(1), fb = ctx.createGain();
  d.delayTime.value = 0.05;
  fb.gain.value = 0.6;
  d.connect(fb).connect(d);
  d.connect(ctx.destination);
  kit.play(kit.noise('burst', 1, 0.2), 0.05, d);
});

// ----- BiquadFilter -----
for (const type of ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']) {
  scenario('BiquadFilter', MARK.filter, 1, `${type}, static`, (ctx, kit) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = 1000;
    f.Q.value = 3;
    f.gain.value = 6;
    f.connect(ctx.destination);
    kit.play(kit.noise('noise', 1, 1), 0, f);
  });
}
scenario('BiquadFilter', MARK.filter, 1.5, 'lowpass, frequency and Q automated', (ctx, kit) => {
  const f = ctx.createBiquadFilter();
  f.frequency.setValueAtTime(200, 0);
  f.frequency.exponentialRampToValueAtTime(8000, 1.2);
  f.Q.setValueAtTime(0.5, 0);
  f.Q.linearRampToValueAtTime(10, 1.4);
  f.connect(ctx.destination);
  kit.play(kit.noise('noise', 1, 1.5), 0, f);
});
scenario('BiquadFilter', MARK.filter, 1.5, 'peaking, gain automated', (ctx, kit) => {
  const f = ctx.createBiquadFilter();
  f.type = 'peaking';
  f.frequency.value = 2000;
  f.gain.setValueAtTime(-12, 0);
  f.gain.linearRampToValueAtTime(12, 1.4);
  f.connect(ctx.destination);
  kit.play(kit.noise('noise', 1, 1.5), 0, f);
});
scenario('BiquadFilter', MARK.filter, 1.5, 'bandpass, detune automated', (ctx, kit) => {
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 800;
  f.Q.value = 8;
  f.detune.setValueAtTime(-1200, 0);
  f.detune.linearRampToValueAtTime(2400, 1.4);
  f.connect(ctx.destination);
  kit.play(kit.noise('noise', 1, 1.5), 0, f);
});

// ----- Oscillator -----
for (const type of ['sine', 'triangle', 'sawtooth', 'square']) {
  for (const hz of [55, 440, 3520]) {
    scenario('Oscillator', MARK.band, 1, `${type} at ${hz} Hz`, ctx => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.value = hz;
      g.gain.value = 0.5;
      o.connect(g).connect(ctx.destination);
      o.start(0.01);
    });
  }
}
scenario('Oscillator', MARK.band, 2, 'sawtooth, a frequency sweep', ctx => {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(40, 0);
  o.frequency.exponentialRampToValueAtTime(15000, 1.9);
  g.gain.value = 0.5;
  o.connect(g).connect(ctx.destination);
  o.start(0);
});
scenario('Oscillator', MARK.band, 1.5, 'sine, a detune sweep', ctx => {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 330;
  o.detune.setValueAtTime(-1200, 0);
  o.detune.linearRampToValueAtTime(1200, 1.4);
  g.gain.value = 0.5;
  o.connect(g).connect(ctx.destination);
  o.start(0);
});

// ----- AudioBufferSource -----
function source(name, pass, seconds, set, start = src => src.start(0.05), more) {
  scenario('AudioBufferSource', pass, seconds, name, (ctx, kit) => {
    const src = ctx.createBufferSource();
    src.buffer = kit.tones('tones2', 2, 1);
    set(src, kit);
    src.connect(ctx.destination);
    start(src, kit);
  }, more);
}
source('rate 1', MARK.exact, 1.2, () => {});
source('rate 0.5', MARK.band, 1.2, src => { src.playbackRate.value = 0.5; });
source('rate 1.37', MARK.band, 1.2, src => { src.playbackRate.value = 1.37; });
source('rate automated, and detune', MARK.band, 1.5, src => {
  src.playbackRate.setValueAtTime(0.7, 0);
  src.playbackRate.linearRampToValueAtTime(1.4, 1.2);
  src.detune.value = 50;
});
source('a loop with loopStart and loopEnd', MARK.band, 2, src => {
  src.loop = true;
  src.loopStart = 0.21;
  src.loopEnd = 0.4377;
});
source('looping at rate 1.37', MARK.band, 2, src => {
  src.loop = true;
  src.loopStart = 0.1;
  src.loopEnd = 0.35;
  src.playbackRate.value = 1.37;
});
source('offset and duration', MARK.exact, 1, () => {}, src => src.start(0.05, 0.25, 0.4));
// The least certain of A2's choices (heart/src/nodes/buffer_source.rs, the
// one marked line): a start between two samples shifts the playhead by that
// fraction of a sample. If Chrome does not, this residual is large (around
// −20 dB rather than below −60) and that line is the one to remove.
source('a start between samples, rate 1', MARK.band, 1, () => {}, (src, kit) => src.start(0.05 + 0.37 / kit.sr), {
  note: 'Far above the mark means Chrome does not shift a start between samples: remove the marked line in buffer_source.rs.'
});

// ----- Convolver -----
function convolver(name, irChannels, inChannels, normalize = true) {
  scenario('Convolver', MARK.filter, 2.5, name, (ctx, kit) => {
    const c = ctx.createConvolver();
    c.normalize = normalize;
    const r = random(11);
    c.buffer = kit.buffer(`ir${irChannels}`, irChannels, 0.8, (ch, i) => {
      const t = i / kit.sr;
      return (2 * r() - 1) * Math.exp(-6 * t) * (ch ? 0.8 : 1);
    });
    c.connect(ctx.destination);
    kit.play(inChannels === 1 ? kit.noise('burst', 1, 0.2) : kit.noise('burst2', 2, 0.2), 0.05, c);
  });
}
convolver('mono impulse, mono input', 1, 1);
convolver('stereo impulse, mono input', 2, 1);
convolver('stereo impulse, stereo input', 2, 2);
convolver('stereo impulse, not normalised', 2, 1, false);

// ----- the app's own processors -----
// The native side runs js/worklet.js and js/fdn-worklet.js, the Heart side
// their Rust ports. Genus draws random numbers only for its harmonics' pan
// and shimmer and for the pips' lowpass wander, so with the harmonics and
// the sweep off every path compared here is deterministic.
const GENUS = { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 1] };
function genus(name, set) {
  scenario('Worklets', MARK.exact, 2, `genus: ${name}`, (ctx, kit) => {
    const g = kit.worklet('genus', GENUS);
    const p = n => g.parameters.get(n);
    g.connect(ctx.destination, 0);
    g.connect(ctx.destination, 2);
    set(g, p, kit);
  }, { worklets: true });
}
genus('the tone, free', (g, p) => {
  p('toneLevel').value = 0.6;
  p('carrier').value = 220;
  p('rate').value = 40;
});
genus('the tone, its depth and rate gliding', (g, p) => {
  p('toneLevel').value = 0.6;
  p('amDepth').setValueAtTime(1, 0);
  p('amDepth').linearRampToValueAtTime(0.2, 1.5);
  p('rate').setValueAtTime(8, 0);
  p('rate').linearRampToValueAtTime(30, 1.8);
});
genus('the pips and their send', (g, p) => {
  p('clickLevel').value = 0.8;
  p('clickSend').value = 0.5;
  p('carrier').value = 1200;
  p('rate').value = 12;
  p('pipMs').value = 5;
});
genus('the pips, dipping and bilateral', (g, p) => {
  p('clickLevel').value = 0.8;
  p('rate').value = 9;
  p('clickModDepth').value = 0.7;
  p('clickModRate').value = 2;
  p('biDepth').value = 1;
  p('biRate').value = 1.5;
  p('biHard').value = 0.4;
});
genus('linked to the flash, its rate ramping', (g, p) => {
  p('toneLevel').value = 0.5;
  p('clickLevel').value = 0.5;
  g.port.postMessage({ signal: true, at: 0, p: 0.1, r0: 10, r1: 14, dur: 1.5, wave: 2, duty: 0.4, linked: true });
});
genus('a chirp table', (g, p, kit) => {
  p('chirpLevel').value = 0.7;
  p('chirpSend').value = 0.3;
  p('rate').value = 6;
  const n = Math.round(0.03 * kit.sr), table = new Float32Array(n);
  for (let i = 0; i < n; i++) table[i] = Math.sin(2 * Math.PI * (600 + 4000 * i / n) * i / kit.sr) * Math.sin(Math.PI * i / n);
  g.port.postMessage({ chirp: table, sig: 'bench', xf: 0.01 });
});

function onePole(name, set) {
  scenario('Worklets', MARK.exact, 1.5, `one-pole: ${name}`, (ctx, kit) => {
    const f = kit.worklet('one-pole', { outputChannelCount: [2] });
    f.connect(ctx.destination);
    kit.play(kit.noise('noise', 1, 1.5), 0, f);
    set(f.parameters.get('frequency'), ctx, kit);
  }, { worklets: true });
}
onePole('a still cutoff', fq => { fq.value = 800; });
onePole('a sweeping cutoff', fq => {
  fq.setValueAtTime(100, 0);
  fq.exponentialRampToValueAtTime(12000, 1.4);
});
onePole('the cutoff from a source, as the drone has it', (fq, ctx) => {
  fq.value = 0;
  const cut = ctx.createConstantSource();
  cut.offset.setValueAtTime(300, 0);
  cut.offset.linearRampToValueAtTime(6000, 1.2);
  cut.connect(fq);
  cut.start(0);
});

function strobe(name, msg) {
  scenario('Worklets', MARK.exact, 2, `strobe-signal: ${name}`, (ctx, kit) => {
    const s = kit.worklet('strobe-signal', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    const g = ctx.createGain();
    g.gain.value = 0.5;
    s.connect(g).connect(ctx.destination);
    if (msg) s.port.postMessage(msg);
  }, { worklets: true });
}
strobe('at rest, lit', null);
strobe('a square at 7.5 Hz', { at: 0, p: 0, r0: 7.5, r1: 7.5, dur: 0, wave: 2, duty: 0.5, on: true });
strobe('a sine, its rate ramping', { at: 0, p: 0.25, r0: 5, r1: 12, dur: 1.5, wave: 0, duty: 0.5, on: true });
strobe('a triangle', { at: 0, p: 0, r0: 9, r1: 9, dur: 0, wave: 1, duty: 0.5, on: true });

function fdn(name, set) {
  scenario('Worklets', MARK.exact, 3, `fdn-reverb: ${name}`, (ctx, kit) => {
    const r = kit.worklet('fdn-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    r.connect(ctx.destination);
    kit.play(kit.noise('burst', 1, 0.2), 0.05, r);
    set(name => r.parameters.get(name));
  }, { worklets: true });
}
fdn('defaults', () => {});
fdn('short and dark, modulated', p => {
  p('decay').value = 1.2;
  p('damping').value = 0.8;
  p('mod').value = 1;
});
fdn('the decay moving', p => {
  p('decay').setValueAtTime(0.5, 0);
  p('decay').linearRampToValueAtTime(6, 2);
});
