// Underrun concealment for the drain (js/heart/drain-worklet.js): what
// plays instead of silence when the ring runs dry.
//
// The drain keeps the last `size` frames it played in a history ring. When
// a quantum finds the ring dry, it plays that history ping-pong: backwards
// from the newest frame to the oldest, then forwards back to the newest,
// and so on for as long as the stall lasts. The first frame of the reverse
// is the frame just played, mirrored, so the waveform stays continuous
// going in and at every turnaround, and no fade is needed to enter it.
// When the ring has audio again, the drain's own frames play and the
// concealment fades out under them over `fade` frames, equal power, since
// the two are not the same sound. The timing is the drain's as before:
// the late frames are still dropped and the clock never shifts.
//
// A stall longer than `hold` frames is no longer a hiccup to cover, and a
// half second of sound turning over and over would draw attention, so the
// concealment then fades to silence over `decay` frames and stays silent;
// the audio coming back then fades in from silence over the same `fade`.
//
// The history is not written while concealing (including the fade out),
// so the ping-pong reads a frozen picture. A rest (a pause, see the
// drain) forgets it: what was playing before a pause is not what should
// cover a stall after it.
//
// Everything is preallocated; nothing here allocates once constructed.

export class Conceal {
  constructor({ size, fade = 256, hold = 48000, decay = 24000 }) {
    this.size = size;
    this.hL = new Float32Array(size);
    this.hR = new Float32Array(size);
    this.w = 0;           // the next history slot to write
    this.filled = 0;      // frames of history held, up to size
    this.fade = fade;
    this.hold = hold;
    this.decay = decay;
    // The equal-power fade, live's share then concealment's, a sample each.
    this.fadeIn = new Float32Array(fade);
    this.fadeOut = new Float32Array(fade);
    for (let i = 0; i < fade; i++) {
      const x = (i + 0.5) / fade * Math.PI / 2;
      this.fadeIn[i] = Math.sin(x);
      this.fadeOut[i] = Math.cos(x);
    }
    this.active = false;  // concealing, or fading it out
    this.out = 0;         // frames into the fade out, while fading
    this.base = 0;        // the newest history frame, frozen at the start
    this.span = 0;        // frames of history the ping-pong turns over
    this.p = 0;           // frames back from base
    this.dir = 1;         // 1 going back in time, -1 coming forward
    this.age = 0;         // frames concealed this run
    this.gain = 1;
  }

  // Forgets the history (a rest) and any concealment under way.
  reset() {
    this.w = 0;
    this.filled = 0;
    this.active = false;
  }

  // The history frame the ping-pong is on, one channel.
  next(ch) {
    const h = ch === 0 ? this.hL : this.hR;
    let i = this.base - this.p;
    if (i < 0) i += this.size;
    return h[i];
  }

  step() {
    if (this.span > 1) {
      this.p += this.dir;
      if (this.p >= this.span - 1) { this.p = this.span - 1; this.dir = -1; }
      else if (this.p <= 0) { this.p = 0; this.dir = 1; }
    }
    if (++this.age > this.hold) this.gain = Math.max(0, this.gain - 1 / this.decay);
  }

  // A dry quantum: fills L and R with concealment. With too little history
  // to turn over (the very start), it is silence.
  dry(L, R) {
    const n = L.length;
    if (!this.active || this.out > 0) {
      if (!this.active) {
        this.span = Math.min(this.filled, this.size);
        this.base = this.w - 1 < 0 ? this.size - 1 : this.w - 1;
        this.p = 0;
        this.dir = 1;
        this.age = 0;
        this.gain = 1;
        this.active = true;
      }
      // A stall in the middle of a fade out carries on concealing.
      this.out = 0;
    }
    if (this.span < 2) { L.fill(0); R.fill(0); return; }
    for (let i = 0; i < n; i++) {
      this.step();
      const g = this.gain;
      L[i] = this.next(0) * g;
      R[i] = this.next(1) * g;
    }
  }

  // A quantum that had audio, already in L and R: fades the concealment out
  // under it if one is under way, then keeps it as history once it is done.
  wet(L, R) {
    const n = L.length;
    let i = 0;
    if (this.active) {
      if (this.span < 2) {
        this.active = false;
      } else {
        for (; i < n && this.out < this.fade; i++, this.out++) {
          this.step();
          const a = this.fadeIn[this.out], b = this.fadeOut[this.out] * this.gain;
          L[i] = L[i] * a + this.next(0) * b;
          R[i] = R[i] * a + this.next(1) * b;
        }
        if (this.out < this.fade) return;
        this.active = false;
        this.out = 0;
      }
    }
    const size = this.size;
    let w = this.w;
    for (; i < n; i++) {
      this.hL[w] = L[i];
      this.hR[w] = R[i];
      if (++w === size) w = 0;
    }
    this.filled = Math.min(size, this.filled + n);
    this.w = w;
  }

  // A quantum played as silence on purpose (rest, refill, a wake's wait):
  // no concealment, and none to fade out of.
  quiet() { this.active = false; this.out = 0; }
}
