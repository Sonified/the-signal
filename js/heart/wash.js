// The concealment's reverb wash (js/heart/conceal.js): the longer a stall
// lasts, the more of the loop is heard through this room, and when the sound
// comes back the room rings out under it on its own.
//
// It is the master room's algorithmic reverb (js/fdn-worklet.js) run a
// frame at a time on the audio thread: four allpass diffusers into eight
// delay lines of unrelated lengths, mixed on every trip by a Hadamard
// matrix, each return through a one-pole filter that sets the decay at the
// low end and, shortened by the damping, at the top; each line's length
// drifts a little so a held tone does not ring metallic. Its level is set so
// a steady sound comes out about as loud as it went in (outG, from the
// lines' mean survival per trip).
//
// It costs nothing asleep: it wakes on the first frame fed to it that is
// not silence, and sleeps again (lines cleared) once it has had silence for
// its decay and half a second more. Everything is preallocated.

const LINE_MS = [29.7, 37.1, 41.1, 43.7, 53.0, 59.9, 67.7, 73.1];
const DIFF_MS = [4.77, 3.59, 12.73, 9.30];
const DIFF_G = 0.6;
const MOD_HZ = [0.11, 0.13, 0.17, 0.19, 0.23, 0.29, 0.31, 0.37];
const MOD_MS = 0.6, MOD = 0.3;
const TAP_IN = [1, 1, 1, 1, -1, -1, -1, -1];
const TAP_L = [1, -1, 1, -1, 1, -1, 1, -1];
const TAP_R = [1, 1, -1, -1, 1, 1, -1, -1];
const N = 8, NORM = 1 / Math.sqrt(N);
const FLUSH = 1e-20;
const DAMP = 0.35;

export class Wash {
  constructor(rate) {
    this.rate = rate;
    this.modMax = MOD_MS / 1000 * rate;
    this.base = Float64Array.from(LINE_MS, ms => Math.round(ms / 1000 * rate));
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
    this.diff = DIFF_MS.map(ms => new Float32Array(Math.max(1, Math.round(ms / 1000 * rate))));
    this.di = new Int32Array(DIFF_MS.length);
    this.outG = 1;
    this.decay = 0;
    this.awake = false;
    this.quiet = 0;
    this.ol = 0;
    this.or = 0;
    this.tune(4);
  }

  // The decay, in seconds: each line's survival per trip at DC, and at
  // Nyquist shortened by the damping, as a one-pole filter's two ends.
  tune(decay) {
    this.decay = decay = Math.max(0.2, decay);
    const sr = this.rate, tHi = decay * (1 - 0.85 * DAMP);
    let g2 = 0;
    for (let i = 0; i < N; i++) {
      const gd = Math.pow(10, -3 * this.base[i] / (decay * sr));
      const gn = Math.pow(10, -3 * this.base[i] / (tHi * sr));
      const a1 = (gd - gn) / (gd + gn);
      this.a1[i] = a1;
      this.b0[i] = gd * (1 - a1);
      g2 += gd * gd;
    }
    // A steady input builds up to 1 / (1 - g^2) of its power in the lines.
    this.outG = Math.sqrt(1 - g2 / N);
  }

  sleep() {
    this.awake = false;
    for (const l of this.lines) l.fill(0);
    for (const d of this.diff) d.fill(0);
    this.lp.fill(0);
    this.ap.fill(0);
    this.ol = this.or = 0;
  }

  // Once a quantum, before its frames: where the lines' lengths drift to.
  block(n) {
    if (!this.awake) return;
    const { base, dNow, dStep, modPh } = this;
    for (let i = 0; i < N; i++) {
      modPh[i] = (modPh[i] + MOD_HZ[i] * n / this.rate) % 1;
      const dEnd = base[i] + MOD * this.modMax * Math.sin(2 * Math.PI * modPh[i]);
      dStep[i] = (dEnd - dNow[i]) / n;
    }
  }

  // One frame in, the room's frame out in this.ol and this.or.
  step(xl, xr) {
    let x = 0.5 * (xl + xr);
    if (x !== 0) { this.awake = true; this.quiet = 0; }
    else if (!this.awake) { this.ol = this.or = 0; return; }
    else if (++this.quiet > (this.decay + 0.5) * this.rate) { this.sleep(); return; }
    const { lines, wi, lp, ap, b0, a1, dNow, dStep, v, diff, di } = this;
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
      const d = (dNow[i] += dStep[i]), k = Math.floor(d - 0.5), fr = d - k;
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
    this.ol = yl * this.outG;
    this.or = yr * this.outG;
  }
}
