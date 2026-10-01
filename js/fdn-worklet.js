// The master room's algorithmic reverb: a feedback delay network, the
// Music drawer's Reverb type 'Algorithmic' (js/piano.js, the room). Where
// the convolution room plays a fixed impulse, so a new decay is a new
// impulse built and crossfaded in, here the decay is one number: the gain
// each delay line keeps on every trip round, so a moved decay is heard on
// the very next block.
//
// The input, summed to mono, runs through four allpass diffusers that smear
// a strike into a dense wash before it reaches the network. The network is
// eight delay lines of mutually unrelated lengths, mixed into one another on
// every trip by an 8x8 Hadamard matrix (energy kept exactly, every line
// feeding every other), each line's return through a one-pole filter that
// sets how much of it survives the trip: at the low end what the decay asks,
// at the top end less as the damping rises, so highs die first as they do in
// a real room (Jot's design, the filter matched exactly at DC and Nyquist).
// Each line's length drifts slowly by up to MOD_MS, every line at its own
// rate, which keeps a held tone from settling into the network's resonances
// and ringing metallic.
//
// The level is matched to the convolution room by calculation: a convolver
// normalises its impulse to an RMS of 10^(-58/20) at 44.1 kHz (the Web Audio
// spec's calibration), so its tail's energy is that squared times the
// impulse's length. The network's tail energy, with a decay of T seconds,
// is the injected energy times T * sampleRate / (13.8 * the mean line
// length), 13.8 being ln(10^6), the 60 dB the decay is measured over. The
// output gain sets the two equal, so the switch is a change of character
// rather than of level.
//
// Loaded beside worklet.js by js/audio.js. Nothing feeding it (piano.js
// unplugs it once its tail has rung out), it plays on until the tail has had
// its decay and a second more, then clears and sleeps, costing nothing.

const LINE_MS = [29.7, 37.1, 41.1, 43.7, 53.0, 59.9, 67.7, 73.1];
const DIFF_MS = [4.77, 3.59, 12.73, 9.30];
const DIFF_G = 0.6;
const MOD_HZ = [0.11, 0.13, 0.17, 0.19, 0.23, 0.29, 0.31, 0.37];
const MOD_MS = 0.6;
// Rows of the Hadamard matrix: the input's spread into the lines and the two
// outputs' taps, orthogonal so left and right come out decorrelated.
const TAP_IN = [1, 1, 1, 1, -1, -1, -1, -1];
const TAP_L = [1, -1, 1, -1, 1, -1, 1, -1];
const TAP_R = [1, 1, -1, -1, 1, 1, -1, -1];
const N = 8, NORM = 1 / Math.sqrt(N);
const CAL = Math.pow(10, -58 / 20) * 44100;   // the convolver's RMS, times its sample rate
// Added and taken away again, which rounds anything far below hearing to an
// exact 0, so a long fade never runs on in denormals.
const FLUSH = 1e-20;

class FdnReverb extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'decay', defaultValue: 4.5, minValue: 0.1, maxValue: 60, automationRate: 'k-rate' },
      { name: 'damping', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mod', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.modMax = MOD_MS / 1000 * sr;
    // whole samples, so a line at rest reads its sample exactly rather than
    // interpolating, which would dull the highs a little on every trip
    this.base = Float64Array.from(LINE_MS, ms => Math.round(ms / 1000 * sr));
    this.lines = Array.from(this.base, d => new Float32Array(Math.ceil(d + this.modMax) + 4));
    this.wi = new Int32Array(N);
    this.lp = new Float64Array(N);
    this.ap = new Float64Array(N);
    this.b0 = new Float64Array(N);
    this.a1 = new Float64Array(N);
    this.dNow = Float64Array.from(this.base);
    this.dStep = new Float64Array(N);
    this.modPh = Float64Array.from(MOD_HZ, (_, i) => i / N);
    this.v = new Float64Array(N);
    this.diff = DIFF_MS.map(ms => new Float32Array(Math.max(1, Math.round(ms / 1000 * sr))));
    this.di = new Int32Array(DIFF_MS.length);
    const meanD = this.base.reduce((a, b) => a + b, 0) / N;
    this.outG = CAL / sr * Math.sqrt(13.8 * meanD);
    this.decay = -1;
    this.damp = -1;
    this.quiet = 0;
    this.asleep = true;
  }

  // Each line's survival per trip, at DC from the decay and at Nyquist from
  // the decay shortened by the damping, as a one-pole filter's two ends.
  tune(decay, damp) {
    this.decay = decay;
    this.damp = damp;
    const sr = sampleRate, tLo = Math.max(0.1, decay), tHi = tLo * (1 - 0.85 * damp);
    for (let i = 0; i < N; i++) {
      const gd = Math.pow(10, -3 * this.base[i] / (tLo * sr));
      const gn = Math.pow(10, -3 * this.base[i] / (tHi * sr));
      const a1 = (gd - gn) / (gd + gn);
      this.a1[i] = a1;
      this.b0[i] = gd * (1 - a1);
    }
  }

  sleep() {
    this.asleep = true;
    for (const l of this.lines) l.fill(0);
    for (const d of this.diff) d.fill(0);
    this.lp.fill(0);
    this.ap.fill(0);
  }

  process(inputs, outputs, params) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    const inp = inputs[0], has = !!inp && inp.length > 0;
    const decay = params.decay[0], damp = params.damping[0], mod = params.mod[0];
    if (has) { this.asleep = false; this.quiet = 0; }
    else if (!this.asleep) {
      this.quiet += n;
      if (this.quiet > (decay + 1) * sampleRate) this.sleep();
    }
    if (this.asleep) return true;
    if (decay !== this.decay || damp !== this.damp) this.tune(decay, damp);

    // The lines' drifting lengths, eased across the block from where the
    // last one left them.
    const { base, lines, wi, lp, ap, b0, a1, dNow, dStep, modPh, v, diff, di } = this;
    for (let i = 0; i < N; i++) {
      modPh[i] = (modPh[i] + MOD_HZ[i] * n / sampleRate) % 1;
      const dEnd = base[i] + mod * this.modMax * Math.sin(2 * Math.PI * modPh[i]);
      dStep[i] = (dEnd - dNow[i]) / n;
    }
    const inL = has ? inp[0] : null, inR = has ? (inp[1] || inp[0]) : null;
    const outG = this.outG;

    for (let s = 0; s < n; s++) {
      let x = has ? 0.5 * (inL[s] + inR[s]) : 0;
      for (let k = 0; k < diff.length; k++) {
        const buf = diff[k], idx = di[k], dl = buf[idx];
        const t = x + DIFF_G * dl;
        x = dl - DIFF_G * t;
        buf[idx] = t;
        di[k] = idx + 1 === buf.length ? 0 : idx + 1;
      }
      let yl = 0, yr = 0;
      for (let i = 0; i < N; i++) {
        const line = lines[i], len = line.length;
        // The read, d samples back: whole samples k, then the fraction by
        // a first-order allpass, which passes every frequency whole where a
        // straight-line blend between two samples would dull the highs on
        // every trip. The fraction is kept between 0.5 and 1.5, where the
        // allpass is well behaved.
        const d = dNow[i] + dStep[i] * s, k = Math.floor(d - 0.5), fr = d - k;
        let p0 = wi[i] - k;
        if (p0 < 0) p0 += len;
        const p1 = p0 === 0 ? len - 1 : p0 - 1;
        const eta = (1 - fr) / (1 + fr);
        const r = eta * line[p0] + line[p1] - eta * ap[i];
        ap[i] = r;
        yl += TAP_L[i] * r;
        yr += TAP_R[i] * r;
        const f = (b0[i] * r + a1[i] * lp[i] + FLUSH) - FLUSH;
        lp[i] = f;
        v[i] = f;
      }
      for (let h = 1; h < N; h <<= 1) {
        for (let i = 0; i < N; i += h << 1) {
          for (let j = i; j < i + h; j++) {
            const a = v[j], b = v[j + h];
            v[j] = a + b;
            v[j + h] = a - b;
          }
        }
      }
      for (let i = 0; i < N; i++) {
        const line = lines[i], w = wi[i];
        line[w] = (v[i] + x * TAP_IN[i]) * NORM;
        wi[i] = w + 1 === line.length ? 0 : w + 1;
      }
      L[s] = yl * outG;
      if (R !== L) R[s] = yr * outG;
    }
    for (let i = 0; i < N; i++) dNow[i] += dStep[i] * n;
    return true;
  }
}

registerProcessor('fdn-reverb', FdnReverb);
