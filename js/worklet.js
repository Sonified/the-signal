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
// Every parameter here is meant to be glided, not stepped: a preset moves
// them all together along straight lines over a second and a half (see
// beginGlide in audio.js). So nothing below turns a gliding number into a
// switch. The pip shape is two voices with a level each rather than a flag,
// the harmonic count fades its top partial in by the fractional part rather
// than rounding, the bilateral shape blends between its two curves, and a
// pip is timed from the start of its own cycle rather than recomputed from
// the phase, so a rate that moves mid-pip cannot move the pip.
//
// Linked to the visual (S.amLinked), that one phase is the strobe's own: the
// flash is a formula of time (core/signal.js), the page hands this
// processor the formula's numbers whenever they change (js/strobe-am.js,
// the same post the Vary with strobe stages' node gets), and while linked
// the phase is steered sample by sample onto the formula's phase, shifted so
// the loud part of the pulse lands on the lit part of the flash (flashAlign,
// below). Free, it runs at the rate param exactly as it always has. Either
// way the phase only ever moves forward and never jumps, so the pips, timed
// from the start of each cycle, still fire once a cycle and stay whole.
//
// This used to be a template literal turned into a Blob URL. As a real file it
// is loaded straight with addModule(), so it is debuggable and cacheable.

// ---------- locked to the flash ----------
// Where on the strobe's cycle the genus lands while linked, as phases of the
// flash's own cycle (core/signal.js: 0 is the cycle's start, where a
// square lights; a sine or a triangle is brightest at 0.5). Robert's rule is
// that the sound is loudest while the screen is lit. `pip` is where the pip
// fires and the genus cycle begins; `peak` is where the tone's envelope (and
// the harmonics', which share it) is at its loudest.
//
//   sine, triangle   both at 0.5, the flash's peak: the envelope is a raised
//                    cosine like the sine's own brightness, so the two swell
//                    and fade together, and the pip sits on the brightest
//                    moment.
//   square           the pip at 0, the onset, the instant the screen lights;
//                    the envelope's peak at duty / 2, the middle of the lit
//                    window, so the louder half of the pulse is the lit half
//                    (peaking at the onset instead would put half the loud
//                    part in the dark before it). Under frame lock the duty
//                    is the lit frames' share (core/strobe.js signalDuty), so
//                    it centres on the frames actually lit.
//
// This is the one place to tune it. Any change of either (a new wave, a new
// duty) is glided, never stepped: the pip's by the lock below, the peak's by
// ENV_SHIFT_S.
function flashAlign(wave, duty, out) {
  if (wave === 2) { out.pip = 0; out.peak = duty / 2; }
  else { out.pip = 0.5; out.peak = 0.5; }
  return out;
}
// How the phase is held on the formula. Each sample the phase advances by
// the formula's own step (its rate at that moment) plus a pull toward the
// formula's phase, the gap closing with a time constant of LOCK_TAU_S. In
// steady running the gap is nothing and the pull is nothing. A gap opens
// only when the formula itself jumps: the link switched on (the free phase
// sits wherever it was), the formula arriving for the first time, the wave
// changing (the pip's place moves by half a cycle), the clock estimate
// being re-posted, or frame lock pinning the formula back onto its frame
// grid (a fraction of a frame, either way). The pull is capped at LOCK_SLEW
// of the formula's step, so while a gap closes the pulse runs between half
// and one and a half times its rate, and never backward: a backward pin
// slows the phase rather than turning it round, so no cycle boundary is
// crossed twice and no pip fires twice, and a forward one hurries it, so no
// boundary is jumped and no pip is lost. A big gap (half a cycle) closes
// within about a cycle; a pin's few milliseconds in a few tens of them.
const LOCK_TAU_S = 0.05, LOCK_SLEW = 0.5;
// The envelope's own shift from the pip (flashAlign's peak less its pip)
// glides to a new value over this time constant, and back to 0 when the
// link is let go.
const ENV_SHIFT_S = 0.05;

class GenusProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // The pulse rate the phase runs at while free. Linked to the visual,
      // once the flash's formula has arrived, the formula sets the pace
      // instead and this only stands ready for the moment the link is let
      // go (or for a linked start before the first post).
      { name:'rate',       defaultValue:40,  minValue:0.05, maxValue:200,   automationRate:'k-rate' },
      // How much the pulse envelope moves the tone and the harmonics: 1 is the
      // full pulse, 0 a steady tone at the pulse's peak. It is the Amplitude
      // modulation switch, glided rather than stepped, and it touches only the
      // envelope, never the phase: the rate runs on underneath at either end,
      // so the pips (timed from that same phase) never notice, and the pulse
      // comes back in step when the switch returns. a-rate like the levels,
      // so a glide moves the envelope sample by sample instead of per block.
      { name:'amDepth',    defaultValue:1,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'carrier',    defaultValue:200, minValue:20,   maxValue:20000, automationRate:'k-rate' },
      { name:'pipMs',      defaultValue:5,   minValue:0.1,  maxValue:100,   automationRate:'k-rate' },
      { name:'toneLevel',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      // The click and the chirp each have their own level and their own
      // reverb send. Switching shape is then just one level going down while
      // the other comes up, and each only ever moves between its own two
      // values, so the chirp can never be heard at the click's level on the
      // way through (it used to be, by about 20 dB, which is why a shape
      // change once had to dip through silence).
      { name:'clickLevel', defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'clickSend',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'chirpLevel', defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'chirpSend',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'clickModDepth', defaultValue:0,    minValue:0,    maxValue:1,    automationRate:'k-rate' },
      { name:'clickModRate',  defaultValue:0.1,  minValue:0.005,maxValue:8,    automationRate:'k-rate' },
      { name:'biDepth',       defaultValue:0,    minValue:0,    maxValue:1,    automationRate:'k-rate' },
      { name:'biRate',        defaultValue:1,    minValue:0.02, maxValue:4,    automationRate:'k-rate' },
      // 0 is the sine sweep, 1 the hard switch, and anything between is a
      // blend of the two curves, so a preset can glide from one to the other.
      { name:'biHard',        defaultValue:1,    minValue:0,    maxValue:1,    automationRate:'k-rate' },
      { name:'harmLevel',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'harmCount',  defaultValue:6,   minValue:1,    maxValue:16,    automationRate:'k-rate' },
      { name:'harmBright', defaultValue:1.2, minValue:0.1,  maxValue:4,     automationRate:'k-rate' },
      { name:'harmSpread', defaultValue:0.7, minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'harmPanRate',defaultValue:0.15,minValue:0,    maxValue:4,     automationRate:'k-rate' },
      { name:'shimDepth',  defaultValue:0,   minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'shimRate',   defaultValue:0.25,minValue:0.01, maxValue:6,     automationRate:'k-rate' },
      // The pip train's lowpass sweep. The cutoff travels between lo and hi on
      // a raised cosine, one full down-and-up every lpfPeriod seconds; wander
      // makes each half-sweep a different length and lets the dips stop short
      // of the floor, so the train sinks back irregularly instead of on a clock.
      { name:'lpfOn',      defaultValue:0,    minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'lpfLo',      defaultValue:400,  minValue:20,   maxValue:20000, automationRate:'k-rate' },
      { name:'lpfHi',      defaultValue:9000, minValue:20,   maxValue:20000, automationRate:'k-rate' },
      { name:'lpfPeriod',  defaultValue:60,   minValue:0.5,  maxValue:600,   automationRate:'k-rate' },
      { name:'lpfQ',       defaultValue:0.707,minValue:0.3,  maxValue:10,    automationRate:'k-rate' },
      { name:'lpfWander',  defaultValue:0,    minValue:0,    maxValue:1,     automationRate:'k-rate' }
    ];
  }
  constructor() {
    super();
    this.phase = 0; this.cphase = 0; this.cmodPhase = 0; this.biPhase = 0;
    // Samples since the current cycle began, and the click pip's own sine
    // phase. The pip used to find its place as phase / increment, which is
    // right only while the rate holds still: a rate gliding under a pip that
    // was sounding moved the pip's position within itself, and that step was
    // a click. Counting from the cycle's start keeps each pip whole whatever
    // the rate does, and a carrier that moves mid-pip bends it rather than
    // jumping its phase.
    this.pipN = 0; this.pipPh = 0;
    // The flash's formula (core/signal.js, as js/strobe-am.js posts it:
    // the anchor in this context's seconds, the phase there, the rate and
    // its ramp), whether the pulse is linked to it, and where on it the
    // genus lands (flashAlign). Until the first post there is no formula
    // and the phase runs free at the rate param even when linked, as it
    // always did. envSh is the envelope's shift from the pip as it glides,
    // 0 whenever the phase is free.
    this.sigOk = false; this.linked = false;
    this.sAt = 0; this.sP = 0; this.sR0 = 0; this.sR1 = 0; this.sDur = 0;
    this.align = flashAlign(0, 0.5, { pip: 0, peak: 0 });
    this.envSh = 0;
    this.lockA = 1 - Math.exp(-1 / (LOCK_TAU_S * sampleRate));
    this.envA = 1 - Math.exp(-1 / (ENV_SHIFT_S * sampleRate));
    // Lowpass sweep state. The sweep is a run of half-sweeps, each an eased
    // move of lpfPos (0 = the low cutoff, 1 = the high) from lpfFrom to lpfTo;
    // lpfU is how far through the current one it is. lpfHz is the cutoff
    // actually in use, in log Hz, smoothed toward the sweep so a toggle or a
    // dial never steps it. Two filters, the dry pips and their reverb send.
    this.lpfActive = false; this.lpfWasOn = false;
    this.lpfFrom = 1; this.lpfTo = 0; this.lpfU = 0; this.lpfMul = 1;
    this.lpfLog = Math.log(this.lpfCeil());
    this.lb0 = 1; this.lb1 = 0; this.lb2 = 0; this.la1 = 0; this.la2 = 0;
    this.dz1 = 0; this.dz2 = 0; this.sz1 = 0; this.sz2 = 0;
    // The chirp is a fixed waveform for a given set of controls, so it is built
    // once on the main thread and shipped over rather than being recomputed
    // per sample here. Playing it is then a table read, which is cheaper than
    // the damped sine the pip does and immune to drift.
    //
    // A new table never replaces the old one outright, since a table swapped
    // under a chirp that is sounding steps it. The two are crossfaded instead,
    // over however long the main thread asks (the whole transition during a
    // preset, a few milliseconds for a slider). A table that arrives while a
    // crossfade is still running waits for it to finish, and only the newest
    // waiting one is kept.
    this.chirp = null; this.chirpOld = null; this.chirpNext = null;
    this.xfLeft = 0; this.xfLen = 1; this.xfNext = 1;
    this.port.onmessage = e => {
      const d = e.data;
      if (d && d.signal) {
        // the flash's formula and the link, posted only when one changes
        this.sAt = +d.at || 0; this.sP = +d.p || 0;
        this.sR0 = +d.r0 || 0; this.sR1 = +d.r1 || 0; this.sDur = +d.dur || 0;
        const duty = +d.duty;
        flashAlign(d.wave | 0, duty === duty ? duty : 0.5, this.align);
        this.linked = !!d.linked; this.sigOk = true;
        return;
      }
      if (e.data && e.data.meters !== undefined) { this.metersOn = !!e.data.meters; return; }
      if (e.data && e.data.dipWatch !== undefined) { this.dipWatch = !!e.data.dipWatch; return; }
      if (e.data && e.data.chirp) {
        this.chirpNext = e.data.chirp;
        this.xfNext = Math.max(1, Math.round((e.data.xf > 0 ? e.data.xf : 0.03) * sampleRate));
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
    // The report is one object reused for every post (the clone is the main
    // thread's, not ours to avoid), holding three numbers rather than an
    // array, and the main thread can switch reports off while nothing reads
    // them.
    this.metersOn = true;
    this.pkMsg = { peaks: true, tone: 0, pulse: 0, harm: 0 };
    // The pips' loudness dip, reported on the same clock for the drawer's
    // level bar: the share of the set level it leaves right now. Off until
    // the main thread asks, and never sent while the depth is 0.
    this.dipWatch = false; this.cmodDepthNow = 0;
    this.dipMsg = { dip: 1 };
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
    // Each partial's normalised amplitude, this block's and the last block's.
    // Count and brightness are k-rate, so they arrive once per block; the
    // amplitudes are interpolated across the block from the last values to
    // these, which turns a gliding count or brightness into a smooth curve
    // instead of a staircase of 128-sample steps. Working them out once per
    // block also takes a Math.pow per partial per sample out of the loop.
    this.hAmp = new Float32Array(this.MAXH);
    this.hAmpPrev = new Float32Array(this.MAXH);
    this.hTopPrev = 0;
    this.hPrimed = false;
    this.hCountIn = NaN; this.hBrightIn = NaN; this.hTopIn = 0;
    // Each partial's left and right gain (its pan and its shimmer folded
    // together) at the start of the block, and how much it moves per sample
    // across the block. See blockGains.
    this.gL = new Float64Array(this.MAXH); this.dL = new Float64Array(this.MAXH);
    this.gR = new Float64Array(this.MAXH); this.dR = new Float64Array(this.MAXH);
  }
  // Posted on its own clock rather than per block: 128 frames is under three
  // milliseconds, which is far faster than any meter can be read, and each
  // window reports the loudest sample in it so a pip transient is never
  // missed between reads.
  reportPeaks(frames) {
    this.pkFrames += frames;
    if (this.pkFrames < sampleRate / 50) return;          // ~20 ms
    this.pkFrames = 0;
    if (this.metersOn) {
      const m = this.pkMsg;
      m.tone = this.pkTone; m.pulse = this.pkPip; m.harm = this.pkHarm;
      this.port.postMessage(m);
    }
    if (this.dipWatch && this.cmodDepthNow > 0) {
      // the very curve the pips ride below, at the phase they have reached
      this.dipMsg.dip = 1 - this.cmodDepthNow * 0.5 * (1 - Math.cos(2 * Math.PI * this.cmodPhase));
      this.port.postMessage(this.dipMsg);
    }
    this.pkTone = 0; this.pkPip = 0; this.pkHarm = 0;
  }
  // The harmonic count is fractional while it glides: 6.4 is six partials at
  // full weight and a seventh at 0.4, so partials fade in and out one at a
  // time instead of popping. Returns how many partials carry any weight.
  harmAmps(countF, bright) {
    // Both are k-rate and sit still nearly all the time, so the sixteen
    // Math.pow calls are only redone when one of them has moved.
    if (this.hPrimed && countF === this.hCountIn && bright === this.hBrightIn) return this.hTopIn;
    this.hCountIn = countF; this.hBrightIn = bright;
    const amp = this.hAmp, MAXH = this.MAXH;
    const c = Math.min(MAXH, Math.max(1, countF));
    const whole = Math.floor(c), frac = c - whole;
    const top = frac > 1e-6 ? whole + 1 : whole;
    let sum = 0;
    for (let k = 0; k < MAXH; k++) {
      let a = 0;
      if (k < whole) a = Math.pow(k + 2, -bright);
      else if (k < top) a = frac * Math.pow(k + 2, -bright);
      amp[k] = a; sum += a;
    }
    // the sum used to keep the stack at unity
    const norm = sum > 0 ? 1 / sum : 0;
    for (let k = 0; k < top; k++) amp[k] *= norm;
    if (!this.hPrimed) { this.hAmpPrev.set(amp); this.hTopPrev = top; this.hPrimed = true; }
    this.hTopIn = top;
    return top;
  }
  // The pan and shimmer oscillators run at a few hertz at most (a 4 Hz pan
  // rate times a 1.35 spread, a 6 Hz shimmer times 1.45), so across one
  // 128-sample block each moves through well under a hundredth of its cycle
  // and the curve it traces is a straight line to within a part in a hundred
  // thousand. So each partial's gains are worked out at the block's two ends
  // and drawn as a line between them, rather than as a cosine, a sine and two
  // square roots per partial per sample: with sixteen partials that was some
  // eighty transcendentals a sample, most of the processor's whole cost. The
  // phases still advance by exactly the same amount per block as before.
  blockGains(nParts, spread, panInc, shimDepth, shimInc, len) {
    const TAU = Math.PI * 2, inv = 1 / len;
    for (let k = 0; k < nParts; k++) {
      const p0 = this.panPhase[k], p1 = p0 + panInc * this.panMul[k] * len;
      const pan0 = Math.sin(TAU * p0) * spread, pan1 = Math.sin(TAU * p1) * spread;
      this.panPhase[k] = p1 - Math.floor(p1);
      let s0 = 1, s1 = 1;
      if (shimDepth > 0) {
        const q0 = this.shimPhase[k], q1 = q0 + shimInc * this.shimMul[k] * len;
        s0 = 1 - shimDepth * 0.5 * (1 - Math.cos(TAU * q0));
        s1 = 1 - shimDepth * 0.5 * (1 - Math.cos(TAU * q1));
        this.shimPhase[k] = q1 - Math.floor(q1);
      }
      const l0 = s0 * Math.sqrt(0.5 * (1 - pan0)), l1 = s1 * Math.sqrt(0.5 * (1 - pan1));
      const r0 = s0 * Math.sqrt(0.5 * (1 + pan0)), r1 = s1 * Math.sqrt(0.5 * (1 + pan1));
      this.gL[k] = l0; this.dL[k] = (l1 - l0) * inv;
      this.gR[k] = r0; this.dR[k] = (r1 - r0) * inv;
    }
  }
  // The top of the filter's travel, where it is as good as open. Clamped under
  // Nyquist so the coefficients stay stable at 44.1 kHz.
  lpfCeil() { return Math.min(20000, sampleRate * 0.45); }
  // Advances the sweep by one block and sets this block's biquad coefficients
  // (RBJ lowpass). The cutoff moves slowly enough that once per 128 samples is
  // indistinguishable from per sample.
  lpfBlock(p, len) {
    const on = p.lpfOn[0] > 0.5;
    const ceil = this.lpfCeil();
    if (on && !this.lpfWasOn) {
      // switched on: start at the top and head down, so it enters from open
      this.lpfFrom = 1; this.lpfTo = this.lpfFloor(p.lpfWander[0]); this.lpfU = 0; this.lpfMul = 1;
      // fresh memory only if it had fully let go; re-enabled mid-glide it
      // keeps ringing through, or the reset would tick
      if (!this.lpfActive) this.dz1 = this.dz2 = this.sz1 = this.sz2 = 0;
      this.lpfActive = true;
    }
    this.lpfWasOn = on;
    let target = Math.log(ceil);
    if (on) {
      const half = 0.5 * p.lpfPeriod[0] * this.lpfMul;
      this.lpfU += len / (half * sampleRate);
      if (this.lpfU >= 1) {
        // a turnaround: the next half-sweep goes the other way, with its own
        // length and, on the way down, its own depth when wander is up
        const w = p.lpfWander[0];
        this.lpfFrom = this.lpfTo;
        this.lpfTo = this.lpfFrom > 0.5 ? this.lpfFloor(w) : 1;
        this.lpfU = 0;
        this.lpfMul = Math.pow(2, (Math.random() * 2 - 1) * 1.5 * w);
      }
      const e = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, this.lpfU));
      const pos = this.lpfFrom + (this.lpfTo - this.lpfFrom) * e;
      const lo = Math.log(Math.min(ceil, p.lpfLo[0])), hi = Math.log(Math.min(ceil, p.lpfHi[0]));
      target = lo + (hi - lo) * pos;
    }
    // ~0.25 s smoothing: a toggle glides the filter open or shut, a dial glides
    this.lpfLog += (target - this.lpfLog) * (1 - Math.exp(-len / (0.25 * sampleRate)));
    if (!on && this.lpfLog > Math.log(ceil) - 0.005) {
      this.lpfActive = false;
      this.dz1 = this.dz2 = this.sz1 = this.sz2 = 0;
      return;
    }
    const f = Math.exp(this.lpfLog);
    const w0 = 2 * Math.PI * f / sampleRate;
    const cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * p.lpfQ[0]);
    const a0 = 1 + alpha;
    this.lb0 = (1 - cw) * 0.5 / a0; this.lb1 = (1 - cw) / a0; this.lb2 = this.lb0;
    this.la1 = -2 * cw / a0; this.la2 = (1 - alpha) / a0;
  }
  // Where a dip bottoms out: the floor with no wander, anywhere in the lower
  // two thirds of the travel with full wander.
  lpfFloor(w) { return w > 0 ? Math.random() * 0.66 * w : 0; }
  process(inputs, outputs, p) {
    const out = outputs[0][0];
    if (!out) return true;
    const outR = outputs[0][1] || out;      // stereo when available
    const hOut = outputs[1];
    const hL = hOut && hOut[0], hR = hOut && hOut[1];
    const cOut = outputs[2] && outputs[2][0];     // pips again, for the reverb send
    const rate = p.rate[0], carrier = p.carrier[0];
    // a-rate: these arrive as a value per sample while automating, and as a
    // single value when steady. Reading them per sample is what removes the
    // step at each block boundary that a k-rate gain produces.
    const TL = p.toneLevel, CL = p.clickLevel, HL2 = p.chirpLevel;
    const CS = p.clickSend, HS = p.chirpSend;
    const AD = p.amDepth, adN = AD.length > 1;
    const tlN = TL.length > 1, clN = CL.length > 1, chlN = HL2.length > 1;
    const csN = CS.length > 1, hsN = HS.length > 1;
    const pipSec = p.pipMs[0] / 1000;
    const pipSamples = Math.max(2, pipSec * sampleRate);
    const decay = 3.5 / pipSec;
    const inc  = rate / sampleRate;
    const cinc = carrier / sampleRate;
    const TAU = Math.PI * 2;
    const HL = p.harmLevel, hlN = HL.length > 1;
    const hSpread = p.harmSpread[0];
    const hPanInc  = p.harmPanRate[0] / sampleRate;
    const biDepth = p.biDepth[0];
    const biInc   = p.biRate[0] / sampleRate;
    const biHard  = p.biHard[0];
    const cmodDepth = p.clickModDepth[0];
    const cmodInc   = p.clickModRate[0] / sampleRate;
    this.cmodDepthNow = cmodDepth;
    const shimDepth = p.shimDepth[0];
    const shimInc   = p.shimRate[0] / sampleRate;
    // Locked to the flash (see flashAlign and LOCK_TAU_S above): the
    // formula's numbers for this block, its time at the block's first
    // sample, and the envelope shift the glide heads for. Free, none of it
    // is touched and the rate param drives the phase alone.
    const lock = this.linked && this.sigOk;
    const sDt = 1 / sampleRate, sTau0 = currentTime - this.sAt;
    const sP = this.sP, sR0 = this.sR0, sR1 = this.sR1, sDur = this.sDur;
    const pipAt = this.align.pip;
    const envTo = lock ? this.align.peak - pipAt : 0;
    const lockA = this.lockA, envA = this.envA;
    this.lpfBlock(p, outputs[0][0] ? outputs[0][0].length : 128);

    // A waiting chirp table starts its crossfade once the last one has done.
    if (this.chirpNext && this.xfLeft <= 0) {
      this.chirpOld = this.chirp;
      this.chirp = this.chirpNext;
      this.chirpNext = null;
      this.xfLen = this.xfLeft = this.xfNext;
    }
    const chirp = this.chirp && this.chirp.length > 0 ? this.chirp : null;
    const chirpLen = chirp ? chirp.length : 0;
    const old = this.chirpOld && this.chirpOld.length > 0 ? this.chirpOld : null;
    const oldLen = old ? old.length : 0;

    const hTop = this.harmAmps(p.harmCount[0], p.harmBright[0]);
    const amp = this.hAmp, ampPrev = this.hAmpPrev;
    const hLoop = hTop > this.hTopPrev ? hTop : this.hTopPrev;

    // idle only when every level is steady at zero; mid-ramp values must render
    if (!tlN && TL[0] <= 0 && !clN && CL[0] <= 0 && !chlN && HL2[0] <= 0 && !hlN && HL[0] <= 0
        && !csN && CS[0] <= 0 && !hsN && HS[0] <= 0) {
      out.fill(0);
      if (outR !== out) outR.fill(0);
      if (hL) hL.fill(0);
      if (hR) hR.fill(0);
      if (cOut) cOut.fill(0);
      if (lock) {
        // nothing is sounding, so the phase is simply put where the flash
        // has it at the block's end, with no glide to hear
        const tauE = sTau0 + out.length * sDt;
        const x = sP + sigCycles(tauE, sR0, sR1, sDur) - pipAt;
        const fi = sigRate(tauE, sR0, sR1, sDur) / sampleRate;
        this.phase = x - Math.floor(x);
        this.pipN = fi > 0 ? this.phase / fi : 1e7;
      } else {
        this.phase  = (this.phase  + inc  * out.length) % 1;
        this.pipN  = this.phase / inc;
      }
      this.envSh = envTo;
      this.cphase = (this.cphase + cinc * out.length) % 1;
      this.cmodPhase = (this.cmodPhase + cmodInc * out.length) % 1;
      this.biPhase   = (this.biPhase   + biInc   * out.length) % 1;
      this.pipPh = (this.pipN * cinc) % 1;
      this.xfLeft = Math.max(0, this.xfLeft - out.length);
      ampPrev.set(amp); this.hTopPrev = hTop;
      this.reportPeaks(out.length);
      return true;
    }
    let pkT = this.pkTone, pkP = this.pkPip, pkH = this.pkHarm;
    let xfLeft = this.xfLeft;
    const xfLen = this.xfLen;
    const len = out.length, invLen = 1 / len;
    // Whether the harmonics sound anywhere in this block; only then do their
    // pan and shimmer oscillators move, as before.
    const harmOn = !!(hL && hR) && (hlN || HL[0] > 0);
    if (harmOn) this.blockGains(hLoop, hSpread, hPanInc, shimDepth, shimInc, len);
    const gL = this.gL, dL = this.dL, gR = this.gR, dR = this.dR;
    const lpf = this.lpfActive;
    const lb0 = this.lb0, lb1 = this.lb1, lb2 = this.lb2, la1 = this.la1, la2 = this.la2;
    let dz1 = this.dz1, dz2 = this.dz2, sz1 = this.sz1, sz2 = this.sz2;
    for (let i = 0; i < len; i++) {
      const tl = tlN ? TL[i] : TL[0];
      const cl = clN ? CL[i] : CL[0];
      const chl = chlN ? HL2[i] : HL2[0];
      const cs = csN ? CS[i] : CS[0];
      const hs = hsN ? HS[i] : HS[0];
      const hl = hlN ? HL[i] : HL[0];
      const harmNow = harmOn && hl > 0;
      // The carrier's sine and the pulse envelope are shared by the tone and
      // the harmonics, so each is computed once a sample, and only if needed.
      let env = 0, sc = 0;
      if (tl > 0 || harmNow) {
        // peaks with the pip (or, linked, envSh after it: see flashAlign);
        // the depth only ever pulls the troughs up toward the peak (at full
        // depth this is 0.75 + 0.25 cos, as it always was)
        const ad = adN ? AD[i] : AD[0];
        env = ad > 0 ? 1 - 0.25 * ad * (1 - Math.cos(TAU * (this.phase - this.envSh))) : 1;
        sc = Math.sin(TAU * this.cphase);
      }
      let v = 0;
      if (tl > 0) v += tl * sc * env;
      // The two pip voices. The chirp falls back to the click's damped sine
      // while no table has arrived yet, as it always has.
      let pc = 0, ph = 0;
      const n = this.pipN;                                      // samples into the cycle
      if (cl > 0 || chl > 0 || (cOut && (cs > 0 || hs > 0))) {
        if (n < pipSamples) pc = Math.sin(TAU * this.pipPh) * Math.exp(-(n / sampleRate) * decay);
        if (chl > 0 || (cOut && hs > 0)) {
          const k = n | 0;
          ph = chirp ? (k < chirpLen ? chirp[k] : 0) : pc;
          if (xfLeft > 0) {
            const o = old ? (k < oldLen ? old[k] : 0) : pc;
            ph += (o - ph) * (xfLeft / xfLen);
          }
        }
      }
      if (xfLeft > 0) xfLeft--;
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
        let raw = 0;
        if (biHard > 0) raw += biHard * (this.biPhase < 0.5 ? -1 : 1);
        if (biHard < 1) raw += (1 - biHard) * Math.sin(TAU * this.biPhase);
        const pan = raw * biDepth;
        bl = Math.sqrt(0.5 * (1 - pan));
        br = Math.sqrt(0.5 * (1 + pan));
      }
      this.biPhase += biInc;
      if (this.biPhase >= 1) this.biPhase -= 1;

      let pipOut = (cl * pc + chl * ph) * cmod;
      let send = cOut ? (cs * pc + hs * ph) * cmod : 0;
      if (lpf) {
        // transposed direct form II, one state pair per signal
        const yd = lb0 * pipOut + dz1;
        dz1 = lb1 * pipOut - la1 * yd + dz2;
        dz2 = lb2 * pipOut - la2 * yd;
        pipOut = yd;
        if (cOut) {
          const ys = lb0 * send + sz1;
          sz1 = lb1 * send - la1 * ys + sz2;
          sz2 = lb2 * send - la2 * ys;
          send = ys;
        }
      }
      const av = v < 0 ? -v : v;                  if (av > pkT) pkT = av;
      const ap = pipOut < 0 ? -pipOut : pipOut;   if (ap > pkP) pkP = ap;
      if (cOut) cOut[i] = send;
      out[i]  = v + pipOut * bl;
      outR[i] = v + pipOut * br;

      if (harmNow) {
        const f = (i + 1) * invLen;
        // Partial n's sine comes from the two below it, sin((n+1)x) =
        // 2cos(x)sin(nx) - sin((n-1)x), exact in double precision this far up,
        // so the whole stack costs one cosine a sample instead of a sine per
        // partial. The partials start at the second, sin(2x) = 2cos(x)sin(x).
        const c2 = 2 * Math.cos(TAU * this.cphase);
        let sPrev = sc, sCur = c2 * sc;
        let l = 0, r = 0;
        for (let k = 0; k < hLoop; k++) {
          const a = ampPrev[k] + (amp[k] - ampPrev[k]) * f;
          const sig = sCur * a;
          l += sig * (gL[k] + dL[k] * i);
          r += sig * (gR[k] + dR[k] * i);
          const sNext = c2 * sCur - sPrev; sPrev = sCur; sCur = sNext;
        }
        // the same envelope as the tone, so the harmonics reinforce the pulse
        // rather than filling in its troughs
        const g = hl * env;
        const vl = l * g, vr = r * g;
        hL[i] = vl;
        hR[i] = vr;
        const ahl = vl < 0 ? -vl : vl;   if (ahl > pkH) pkH = ahl;
        const ahr = vr < 0 ? -vr : vr;   if (ahr > pkH) pkH = ahr;
      } else if (hL && hR) { hL[i] = 0; hR[i] = 0; }

      // The phase's step: the rate param's, free; linked, the formula's own
      // step at this sample plus the capped pull onto its phase (see
      // LOCK_TAU_S), which is always forward. The envelope's shift glides
      // toward its place, and back to exactly 0 once the link is let go.
      let step = inc;
      if (lock) {
        const tau = sTau0 + i * sDt;
        let x = sP + sigCycles(tau, sR0, sR1, sDur) - pipAt;
        x -= Math.floor(x);
        const fi = sigRate(tau, sR0, sR1, sDur) / sampleRate;
        let gap = x - this.phase;
        gap -= Math.round(gap);                   // the near way round, -0.5..0.5
        let pull = gap * lockA;
        const cap = LOCK_SLEW * fi;
        if (pull > cap) pull = cap; else if (pull < -cap) pull = -cap;
        step = fi + pull;
      }
      const sh = this.envSh;
      if (sh !== envTo) {
        const d = envTo - sh;
        this.envSh = d < 1e-6 && d > -1e-6 ? envTo : sh + envA * d;
      }
      this.phase += step;
      if (this.phase >= 1) {
        this.phase -= 1;
        // a new cycle, and a new pip, starting this far past the boundary
        this.pipN = step > 0 ? this.phase / step : 0;
        this.pipPh = this.pipN * cinc;
      } else {
        this.pipN += 1;
        this.pipPh += cinc; if (this.pipPh >= 1) this.pipPh -= 1;
      }
      this.cphase += cinc;  if (this.cphase >= 1) this.cphase -= 1;
    }
    this.xfLeft = xfLeft;
    if (xfLeft <= 0) this.chirpOld = null;
    // flushed to zero once the pips have rung out, so the silence between them
    // never drifts into denormals
    const tiny = 1e-25;
    this.dz1 = Math.abs(dz1) < tiny ? 0 : dz1; this.dz2 = Math.abs(dz2) < tiny ? 0 : dz2;
    this.sz1 = Math.abs(sz1) < tiny ? 0 : sz1; this.sz2 = Math.abs(sz2) < tiny ? 0 : sz2;
    ampPrev.set(amp); this.hTopPrev = hTop;
    this.pkTone = pkT; this.pkPip = pkP; this.pkHarm = pkH;
    this.reportPeaks(out.length);
    return true;
  }
}
registerProcessor('genus', GenusProcessor);

// A one-pole low-pass, 6 dB an octave, for the drone filter's gentlest
// rolloff: the browser's BiquadFilterNode starts at 12. Topology-preserving
// (trapezoidal) form, so it stays stable and exact as the cutoff moves every
// sample, and it passes the signal through untouched with the cutoff at the
// top. The cutoff is an a-rate param, so a ConstantSourceNode connected to it
// (piano.js's shared drone cutoff) drives it sample for sample alongside the
// biquad chains.
class OnePoleProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'frequency', defaultValue: 24000, minValue: 0, maxValue: 96000, automationRate: 'a-rate' }];
  }
  // The per-sample gains, worked out once per block and shared by both
  // channels. While the drone's sweep runs, the cutoff is different on every
  // sample, which used to mean a Math.tan per sample per channel. Now the
  // gain is computed exactly every GSTEP samples and drawn in a straight line
  // between: the sweep's slowest breakpoint is thousands of samples long and
  // tan barely curves over eight, so the difference is far below anything
  // audible, and a block costs seventeen tans instead of two hundred and
  // fifty-six.
  constructor() { super(); this.s = new Float64Array(8); this.G = new Float64Array(128); }
  gainAt(f) {
    // at or past the top it is a straight wire (G = 1 gives y = x)
    if (f >= 0.49 * sampleRate) return 1;
    const g = Math.tan(Math.PI / sampleRate * Math.max(1, f));
    return g / (1 + g);
  }
  fillGains(fq, n) {
    if (this.G.length < n) this.G = new Float64Array(n);
    const G = this.G, GSTEP = 8;
    if (fq.length === 1) { G.fill(this.gainAt(fq[0]), 0, n); return; }
    let i0 = 0, f0 = fq[0], g0 = this.gainAt(f0);
    while (i0 < n - 1) {
      const i1 = Math.min(i0 + GSTEP, n - 1), f1 = fq[i1];
      // a cutoff holding still (the sweep off, or parked between ramps) is
      // one gain for the whole stretch, exactly as before
      const g1 = f1 === f0 ? g0 : this.gainAt(f1);
      const d = (g1 - g0) / (i1 - i0);
      for (let i = i0; i < i1; i++) G[i] = g0 + d * (i - i0);
      i0 = i1; f0 = f1; g0 = g1;
    }
    G[n - 1] = g0;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], fq = p.frequency;
    if (!inp || !inp.length) return true;
    const n = out[0] ? out[0].length : 128;
    this.fillGains(fq, n);
    const G = this.G;
    for (let ch = 0; ch < out.length; ch++) {
      const x = inp[ch] || inp[0], y = out[ch];
      let s = this.s[ch];
      for (let i = 0; i < y.length; i++) {
        const v = (x[i] - s) * G[i];
        const o = v + s;
        s = o + v;
        y[i] = o;
      }
      this.s[ch] = s;
    }
    return true;
  }
}
registerProcessor('one-pole', OnePoleProcessor);

// The strobe's own flash as a signal, for every Vary with strobe stage
// (js/strobe-am.js): one of these feeds them all. It is not a clock of its
// own and it chases nothing. The flash is one formula of time
// (core/signal.js), and this runs that formula at every sample's own
// time, handed the formula's numbers by the page whenever they change: the
// anchor (in this context's seconds), the phase there, the rate and its
// ramp, the wave, the duty, and whether the flicker shows. Between changes
// there is nothing to tell it; the screen and this are each just reading
// the same law at their own moment.
//
// Out comes 2 x shape - 1: +1 lit, -1 dark. With the flicker stopped
// (paused) it eases over a twentieth of a second to +1, the steady lit
// level the field holds, and back when it starts. A millisecond's smoothing
// keeps a square's edges, and the rare re-anchor of the phase, from
// clicking.
//
// This file is loaded by addModule and keeps to itself: a worklet that
// imported the law would hang the whole module, the engine's tone and pips
// included, on module imports inside worklets, which not every browser this
// app runs on has had for long. So the law's pieces are copied here,
// sigCycles from core/signal.js's cyclesAt, sigRate from its rateAt and
// sigShape from its waveShape, exactly as the click's dip above keeps its
// copy of the variance law. A change to any of them there must be made here
// too. The genus processor above reads sigCycles and sigRate as well, for
// its phase while linked to the visual.
function sigCycles(tau, r0, r1, dur) {
  if (tau <= 0 || !(dur > 0)) return r0 * tau;
  if (tau < dur) return r0 * tau + (r1 - r0) * tau * tau / (2 * dur);
  return (r0 + r1) * 0.5 * dur + r1 * (tau - dur);
}
function sigRate(tau, r0, r1, dur) {
  if (tau <= 0 || !(dur > 0)) return r0;
  return tau < dur ? r0 + (r1 - r0) * tau / dur : r1;
}
function sigShape(wave, duty, p) {
  if (wave === 2) return p < duty ? 1 : 0;
  if (wave === 1) return p < 0.5 ? p * 2 : 2 - p * 2;
  return 0.5 * (1 - Math.cos(2 * Math.PI * p));
}
class StrobeSignalProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // the formula's numbers (core/signal.js signalState), at seconds on
    // this context's clock; until the page's first word, a steady 7.5 Hz
    // square held lit
    this.at = 0; this.p = 0; this.r0 = 7.5; this.r1 = 7.5; this.dur = 0;
    this.wave = 2; this.duty = 0.5; this.on = false;
    // the output's smoothing and the ease to lit, starting at rest, lit
    this.y = 1; this.hold = 1;
    this.a = 1 - Math.exp(-1 / (0.001 * sampleRate));
    this.h = 1 - Math.exp(-1 / (0.05 * sampleRate));
    this.port.onmessage = e => {
      const d = e.data;
      if (!d) return;
      this.at = +d.at || 0; this.p = +d.p || 0;
      this.r0 = +d.r0 || 0; this.r1 = +d.r1 || 0; this.dur = +d.dur || 0;
      this.wave = d.wave | 0; this.duty = +d.duty; this.on = !!d.on;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length, dt = 1 / sampleRate, tau0 = currentTime - this.at;
    const p0 = this.p, r0 = this.r0, r1 = this.r1, dur = this.dur, wave = this.wave, duty = this.duty;
    const a = this.a, h = this.h, holdTo = this.on ? 0 : 1;
    let y = this.y, hold = this.hold;
    for (let i = 0; i < n; i++) {
      let ph = p0 + sigCycles(tau0 + i * dt, r0, r1, dur);
      ph -= Math.floor(ph);
      hold += h * (holdTo - hold);
      const v = sigShape(wave, duty, ph) * (1 - hold) + hold;
      y += a * (v - y);
      out[i] = 2 * y - 1;
    }
    this.y = y; this.hold = hold;
    return true;
  }
}
registerProcessor('strobe-signal', StrobeSignalProcessor);
