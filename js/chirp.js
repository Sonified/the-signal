// Delay-compensated chirp.
//
// A click is broadband but it is not synchronous where it matters. The cochlea
// is a traveling-wave delay line: energy reaches the high-frequency base almost
// at once and the low-frequency apex up to ten milliseconds later, so a single
// impulse arrives at the auditory nerve smeared across that whole window. The
// neural volley is desynchronised before it leaves the ear.
//
// A chirp fixes it at the source. Emit the low frequencies early by exactly the
// extra travel time they need and every region fires together. In the evoked
// response literature this is worth roughly a doubling of wave V amplitude over
// a click of the same level, which is a large gain for a stimulus whose entire
// job is synchrony.
//
// The delay model is Elberling and Don's, tau(f) = c1 * f^-d, the one the
// CE-Chirp is built on.
const C1 = 0.0920, D = 0.4356;
const delay = f => C1 * Math.pow(f, -D);

// comp: 0 is a plain linear sweep, 1 is full delay compensation. Anything
// between interpolates the frequency trajectory, so the control is a real dial
// rather than a switch, and the duration stays put either way.
// tilt: 0 is a flat spectrum per hertz (white, bright and brittle), 1 is flat
// per octave (pink, which spreads the drive evenly across a cochlea whose
// filters get wider as they go up). Above 1 it keeps darkening.
export function buildChirp({ sampleRate, lowHz = 150, highHz = 6000, comp = 1, tilt = 1 }) {
  const lo = Math.max(20, Math.min(lowHz, highHz - 50));
  const hi = Math.max(lo + 50, highHz);

  const tLo = delay(lo), tHi = delay(hi);
  const dur = tLo - tHi;                       // seconds, set by the model alone
  const n = Math.max(8, Math.round(dur * sampleRate));
  const out = new Float32Array(n);

  // instantaneous frequency, sample by sample
  const freq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // compensated: invert t = tLo - tau(f)  ->  f = ((tLo - t)/c1)^(-1/d)
    const u = Math.max(1e-9, (tLo - t) / C1);
    const fComp = Math.pow(u, -1 / D);
    const fLin  = lo + (hi - lo) * (i / (n - 1));
    freq[i] = fComp * comp + fLin * (1 - comp);
  }

  // A swept tone's energy at a frequency is set by how long it lingers there,
  // so the spectrum is amplitude^2 divided by the sweep rate. Solving for a
  // target tilt gives the envelope: a = sqrt(rate / f^tilt).
  let peak = 0;
  const amp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rate = i === 0 ? freq[1] - freq[0]
               : i === n - 1 ? freq[n-1] - freq[n-2]
               : (freq[i+1] - freq[i-1]) * 0.5;
    const a = Math.sqrt(Math.max(1e-12, rate) / Math.pow(freq[i], tilt));
    amp[i] = a;
    if (a > peak) peak = a;
  }

  // Short raised-cosine tapers at both ends. Without them the abrupt start and
  // stop splatter energy across the whole spectrum, which is exactly the
  // desynchronised broadband transient this is here to avoid.
  const fade = Math.max(2, Math.round(0.0005 * sampleRate));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += freq[i] / sampleRate;
    let w = 1;
    if (i < fade)         w = 0.5 * (1 - Math.cos(Math.PI * i / fade));
    if (i > n - 1 - fade) w = 0.5 * (1 - Math.cos(Math.PI * (n - 1 - i) / fade));
    out[i] = Math.sin(2 * Math.PI * phase) * (amp[i] / peak) * w;
  }

  // normalise to unity peak so the level control means the same thing in both
  // modes and switching does not jump in loudness
  let mx = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(out[i]); if (v > mx) mx = v; }
  if (mx > 0) for (let i = 0; i < n; i++) out[i] /= mx;

  return out;
}

export const chirpDurationMs = (lowHz, highHz) =>
  (delay(Math.max(20, lowHz)) - delay(Math.max(lowHz + 50, highHz))) * 1000;
