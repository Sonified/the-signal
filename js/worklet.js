// The AudioWorklet processor.
//
// One AudioWorklet generates both the modulated tone and the pip train from a
// single sample-accurate phase accumulator. This replaces a pair of looping
// buffers, which had three problems that no amount of patching fixed: buffer
// length was round(sampleRate/rate) so the real rate was never quite the asked
// rate, every parameter change had to stop and rebuild both sources, and drift
// was applied with playbackRate which dragged the carrier pitch along with it.
// Deriving everything from one phase makes tone and clicks locked by
// construction, and parameters now change without restarting anything.
//
// This used to be a template literal turned into a Blob URL. As a real file it
// is loaded straight with addModule(), so it is debuggable and cacheable.

class GenusProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name:'rate',       defaultValue:40,  minValue:0.05, maxValue:200,   automationRate:'k-rate' },
      { name:'carrier',    defaultValue:200, minValue:20,   maxValue:20000, automationRate:'k-rate' },
      { name:'pipMs',      defaultValue:5,   minValue:0.1,  maxValue:100,   automationRate:'k-rate' },
      { name:'chirpOn',    defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'toneLevel',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'clickLevel', defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'clickSend',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'clickModDepth', defaultValue:0,    minValue:0,    maxValue:1,    automationRate:'k-rate' },
      { name:'clickModRate',  defaultValue:0.1,  minValue:0.005,maxValue:8,    automationRate:'k-rate' },
      { name:'biDepth',       defaultValue:0,    minValue:0,    maxValue:1,    automationRate:'k-rate' },
      { name:'biRate',        defaultValue:1,    minValue:0.02, maxValue:4,    automationRate:'k-rate' },
      { name:'biHard',        defaultValue:1,    minValue:0,    maxValue:1,    automationRate:'k-rate' },
      { name:'harmLevel',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'harmCount',  defaultValue:6,   minValue:1,    maxValue:16,    automationRate:'k-rate' },
      { name:'harmBright', defaultValue:1.2, minValue:0.1,  maxValue:4,     automationRate:'k-rate' },
      { name:'harmSpread', defaultValue:0.7, minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'harmPanRate',defaultValue:0.15,minValue:0,    maxValue:4,     automationRate:'k-rate' },
      { name:'shimDepth',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'shimRate',   defaultValue:0.25,minValue:0.01, maxValue:6,     automationRate:'k-rate' }
    ];
  }
  constructor() {
    super();
    this.phase = 0; this.cphase = 0; this.cmodPhase = 0; this.biPhase = 0;
    // The chirp is a fixed waveform for a given set of controls, so it is built
    // once on the main thread and shipped over rather than being recomputed
    // per sample here. Playing it is then a table read, which is cheaper than
    // the damped sine the pip does and immune to drift.
    this.chirp = null;
    this.port.onmessage = e => {
      if (e.data && e.data.chirp) {
        this.chirp = e.data.chirp;
        // Say which table is in hand. A post made while the context was still
        // suspended can be lost before it ever reaches here, and without an
        // acknowledgement the main thread cannot tell that from a delivery.
        this.port.postMessage({ chirpAck: e.data.sig === undefined ? true : e.data.sig });
      }
    };
    // Meter taps. Tone, pips and harmonics leave here folded into two outputs,
    // so no analyser downstream can tell them apart. Each one's peak is taken
    // at the point it is still its own signal and posted to the mixer, which is
    // cheaper than three extra outputs and exact.
    this.pkTone = 0; this.pkPip = 0; this.pkHarm = 0; this.pkFrames = 0;
    // Every harmonic gets its own pan phase and its own slightly different pan
    // rate, so they never settle into a single synchronised sweep.
    this.MAXH = 16;
    this.panPhase = new Float32Array(this.MAXH);
    this.panMul   = new Float32Array(this.MAXH);
    this.shimPhase = new Float32Array(this.MAXH);
    this.shimMul   = new Float32Array(this.MAXH);
    for (let i = 0; i < this.MAXH; i++) {
      this.panPhase[i]  = Math.random();
      this.panMul[i]    = 0.65 + Math.random() * 0.7;
      this.shimPhase[i] = Math.random();
      this.shimMul[i]   = 0.55 + Math.random() * 0.9;
    }
  }
  // Posted on its own clock rather than per block: 128 frames is under three
  // milliseconds, which is far faster than any meter can be read, and each
  // window reports the loudest sample in it so a pip transient is never
  // missed between reads.
  reportPeaks(frames) {
    this.pkFrames += frames;
    if (this.pkFrames < sampleRate / 50) return;          // ~20 ms
    this.pkFrames = 0;
    this.port.postMessage({ peaks: [this.pkTone, this.pkPip, this.pkHarm] });
    this.pkTone = 0; this.pkPip = 0; this.pkHarm = 0;
  }
  process(inputs, outputs, p) {
    const out = outputs[0][0];
    if (!out) return true;
    const outR = outputs[0][1] || out;      // stereo when available
    const hOut = outputs[1];
    const hL = hOut && hOut[0], hR = hOut && hOut[1];
    const cOut = outputs[2] && outputs[2][0];     // pips again, for the reverb send
    const CS = p.clickSend, csN = CS.length > 1;
    const rate = p.rate[0], carrier = p.carrier[0];
    // a-rate: these arrive as a value per sample while automating, and as a
    // single value when steady. Reading them per sample is what removes the
    // step at each block boundary that a k-rate gain produces.
    const TL = p.toneLevel, CL = p.clickLevel;
    const tlN = TL.length > 1, clN = CL.length > 1;
    const pipSec = p.pipMs[0] / 1000;
    const pipSamples = Math.max(2, pipSec * sampleRate);
    const decay = 3.5 / pipSec;
    const inc  = rate / sampleRate;
    const cinc = carrier / sampleRate;
    const TAU = Math.PI * 2;
    // idle only when both are steady at zero; mid-ramp values must render
    const HL = p.harmLevel, hlN = HL.length > 1;
    const hCount  = Math.round(p.harmCount[0]);
    const hBright = p.harmBright[0];
    const hSpread = p.harmSpread[0];
    const hPanInc  = p.harmPanRate[0] / sampleRate;
    const biDepth = p.biDepth[0];
    const biInc   = p.biRate[0] / sampleRate;
    const biHard  = p.biHard[0] > 0.5;
    const chirp = this.chirp;
    const useChirp = p.chirpOn[0] > 0.5 && chirp && chirp.length > 0;
    const chirpLen = chirp ? chirp.length : 0;
    const cmodDepth = p.clickModDepth[0];
    const cmodInc   = p.clickModRate[0] / sampleRate;
    const shimDepth = p.shimDepth[0];
    const shimInc   = p.shimRate[0] / sampleRate;

    // amplitude per harmonic, and the sum used to keep the stack at unity
    let hNorm = 0;
    for (let k = 0; k < hCount; k++) hNorm += Math.pow(k + 2, -hBright);
    hNorm = hNorm > 0 ? 1 / hNorm : 0;

    if (!tlN && TL[0] <= 0 && !clN && CL[0] <= 0 && !hlN && HL[0] <= 0) {
      out.fill(0);
      if (outR !== out) outR.fill(0);
      if (hL) hL.fill(0);
      if (hR) hR.fill(0);
      this.phase  = (this.phase  + inc  * out.length) % 1;
      this.cphase = (this.cphase + cinc * out.length) % 1;
      this.cmodPhase = (this.cmodPhase + cmodInc * out.length) % 1;
      this.biPhase   = (this.biPhase   + biInc   * out.length) % 1;
      this.reportPeaks(out.length);
      return true;
    }
    let pkT = this.pkTone, pkP = this.pkPip, pkH = this.pkHarm;
    for (let i = 0; i < out.length; i++) {
      const tl = tlN ? TL[i] : TL[0];
      const cl = clN ? CL[i] : CL[0];
      let v = 0;
      if (tl > 0) {
        const env = 0.75 + 0.25 * Math.cos(TAU * this.phase);   // peaks with the pip
        v += tl * Math.sin(TAU * this.cphase) * env;
      }
      let pip = 0;
      if (cl > 0 || (cOut && (csN ? CS[i] : CS[0]) > 0)) {
        const n = this.phase / inc;                             // samples into the cycle
        if (useChirp) {
          const k = n | 0;
          if (k < chirpLen) pip = chirp[k];
        } else if (n < pipSamples) {
          const t = n / sampleRate;
          pip = Math.sin(TAU * carrier * t) * Math.exp(-t * decay);
        }
      }
      // slow loudness modulation on the pips alone; only ever dips below the
      // set click level, never above it
      let cmod = 1;
      if (cmodDepth > 0) {
        cmod = 1 - cmodDepth * 0.5 * (1 - Math.cos(TAU * this.cmodPhase));
      }
      this.cmodPhase += cmodInc;
      if (this.cmodPhase >= 1) this.cmodPhase -= 1;

      // bilateral placement applies to the pips alone; the tone stays centred
      // so it keeps driving both ears while the clicks alternate
      let bl = 1, br = 1;
      if (biDepth > 0) {
        const raw = biHard ? (this.biPhase < 0.5 ? -1 : 1)
                           : Math.sin(TAU * this.biPhase);
        const pan = raw * biDepth;
        bl = Math.sqrt(0.5 * (1 - pan));
        br = Math.sqrt(0.5 * (1 + pan));
      }
      this.biPhase += biInc;
      if (this.biPhase >= 1) this.biPhase -= 1;

      const pipOut = cl * pip * cmod;
      const av = v < 0 ? -v : v;                  if (av > pkT) pkT = av;
      const ap = pipOut < 0 ? -pipOut : pipOut;   if (ap > pkP) pkP = ap;
      if (cOut) cOut[i] = pip * cmod * (csN ? CS[i] : CS[0]);
      out[i]  = v + pipOut * bl;
      outR[i] = v + pipOut * br;

      const hl = hlN ? HL[i] : HL[0];
      if (hl > 0 && hL && hR) {
        // the same envelope as the tone, so the harmonics reinforce the pulse
        // rather than filling in its troughs
        const env = 0.75 + 0.25 * Math.cos(TAU * this.phase);
        let l = 0, r = 0;
        for (let k = 0; k < hCount; k++) {
          const n = k + 2;                              // harmonics above the fundamental
          const amp = Math.pow(n, -hBright);
          // each harmonic breathes on its own slow oscillator, at its own rate
          // and from its own starting point, so they never swell together
          let shim = 1;
          if (shimDepth > 0) {
            shim = 1 - shimDepth * 0.5 * (1 - Math.cos(TAU * this.shimPhase[k]));
            this.shimPhase[k] += shimInc * this.shimMul[k];
            if (this.shimPhase[k] >= 1) this.shimPhase[k] -= 1;
          }
          const sig = Math.sin(TAU * this.cphase * n) * amp * shim;
          const pan = Math.sin(TAU * this.panPhase[k]) * hSpread;
          l += sig * Math.sqrt(0.5 * (1 - pan));
          r += sig * Math.sqrt(0.5 * (1 + pan));
          this.panPhase[k] += hPanInc * this.panMul[k];
          if (this.panPhase[k] >= 1) this.panPhase[k] -= 1;
        }
        const g = hl * hNorm * env;
        hL[i] = l * g;
        hR[i] = r * g;
        const ahl = hL[i] < 0 ? -hL[i] : hL[i];   if (ahl > pkH) pkH = ahl;
        const ahr = hR[i] < 0 ? -hR[i] : hR[i];   if (ahr > pkH) pkH = ahr;
      } else if (hL && hR) { hL[i] = 0; hR[i] = 0; }

      this.phase  += inc;   if (this.phase  >= 1) this.phase  -= 1;
      this.cphase += cinc;  if (this.cphase >= 1) this.cphase -= 1;
    }
    this.pkTone = pkT; this.pkPip = pkP; this.pkHarm = pkH;
    this.reportPeaks(out.length);
    return true;
  }
}
registerProcessor('genus', GenusProcessor);
