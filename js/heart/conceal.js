// Underrun concealment for the drain (js/heart/drain-worklet.js): what
// plays instead of silence when the ring runs dry.
//
// The drain keeps the last `size` frames it played in a history ring. When
// a quantum finds the ring dry, it plays that history ping-pong: backwards
// from the newest frame to the oldest, then forwards back to the newest,
// and so on for as long as the stall lasts. The first frame of the reverse
// is the frame just played, mirrored, so the waveform stays continuous
// going in, and no fade is needed to enter it.
//
// Each turnaround is a crossfade of `xfade` frames (the drawer's
// Crossfade): that many frames before a pass reaches the end of the
// history, a second head starts from that end coming back the other way,
// and the first fades out under it as it runs on to the end. Both move at
// the normal rate, so the pitch never bends, and they cross on the same
// frame halfway, so the fade is equal gain (no bump where they agree).
// At 0 the turn is a hard reflection.
// When the ring has audio again, the drain's own frames play and the
// concealment fades out under them over the same length (at least
// MIN_RETURN frames), equal power, since the two are not the same sound.
// The timing is the drain's as before: the late frames are still dropped
// and the clock never shifts.
//
// A stall longer than `hold` frames is no longer a hiccup to cover, and a
// half second of sound turning over and over would draw attention, so the
// concealment then fades to silence over `decay` frames and stays silent;
// the audio coming back then fades in from silence.
//
// The history is not written while concealing (including the fade out),
// so the ping-pong reads a frozen picture. A rest (a pause, see the
// drain) forgets it: what was playing before a pause is not what should
// cover a stall after it.
//
// Everything is preallocated; nothing here allocates once constructed.

// sin(x * pi / 2) for x in [0, 1], at TABLE + 1 points: every fade's shape,
// read by index, so a new length costs nothing.
const TABLE = 1024;
const SIN = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SIN[i] = Math.sin(i / TABLE * Math.PI / 2);
const MIN_RETURN = 128;

export class Conceal {
  constructor({ size, xfade = 0, hold = 48000, decay = 24000 }) {
    this.size = size;
    this.hL = new Float32Array(size);
    this.hR = new Float32Array(size);
    this.w = 0;           // the next history slot to write
    this.filled = 0;      // frames of history held, up to size
    this.xfade = 0;
    this.setXfade(xfade);
    this.hold = hold;
    this.decay = decay;
    this.active = false;  // concealing, or fading it out
    this.out = 0;         // frames into the fade out, while fading
    this.ret = MIN_RETURN; // the fade out's length, fixed when it starts
    this.base = 0;        // the newest history frame, frozen at the start
    this.span = 0;        // frames of history the ping-pong turns over
    // Head a, and head b while a turn is crossfading: frames back from
    // base, and 1 going back in time or -1 coming forward.
    this.pa = 0; this.da = 1;
    this.pb = 0; this.db = 1;
    this.turn = -1;       // frames into a turn's crossfade, or -1
    this.turnLen = 0;
    this.age = 0;         // frames concealed this run
    this.gain = 1;
    this.l = 0;           // the frame just made, left and right
    this.r = 0;
  }

  // The turnaround crossfade, in frames, live (the drawer's Crossfade).
  setXfade(frames) {
    this.xfade = Math.max(0, Math.min(this.size >> 2, frames | 0));
  }

  // Forgets the history (a rest) and any concealment under way.
  reset() {
    this.w = 0;
    this.filled = 0;
    this.active = false;
  }

  // Frames head a has left before the end of the history it is heading to.
  left() { return this.da > 0 ? this.span - 1 - this.pa : this.pa; }

  at(h, p) {
    let i = this.base - p;
    if (i < 0) i += this.size;
    return h[i];
  }

  // One frame of concealment into this.l and this.r, then the heads move on.
  frame() {
    const hL = this.hL, hR = this.hR;
    // A turn starts: head b from the end a is heading to, coming back the
    // other way, so the two cross halfway through the fade.
    if (this.turn < 0 && this.turnLen > 0 && this.left() <= this.turnLen) {
      this.turn = 0;
      this.pb = this.da > 0 ? this.span - 1 : 0;
      this.db = -this.da;
    }
    let l = this.at(hL, this.pa), r = this.at(hR, this.pa);
    if (this.turn >= 0) {
      const k = (this.turn * TABLE / this.turnLen) | 0;
      const gin = SIN[k] * SIN[k], gout = 1 - gin;
      l = l * gout + this.at(hL, this.pb) * gin;
      r = r * gout + this.at(hR, this.pb) * gin;
      // Head a runs on to the end as it fades; b takes over when it gets there.
      this.pa = Math.max(0, Math.min(this.span - 1, this.pa + this.da));
      this.pb += this.db;
      if (++this.turn >= this.turnLen) {
        this.pa = this.pb;
        this.da = this.db;
        this.turn = -1;
      }
    } else {
      this.stepA();
    }
    const g = this.gain;
    this.l = l * g;
    this.r = r * g;
    if (++this.age > this.hold) this.gain = Math.max(0, this.gain - 1 / this.decay);
  }

  // Head a one frame on, reflecting at the ends (a turn with no crossfade).
  stepA() {
    this.pa += this.da;
    if (this.pa >= this.span - 1) { this.pa = this.span - 1; this.da = -1; }
    else if (this.pa <= 0) { this.pa = 0; this.da = 1; }
  }

  // A dry quantum: fills L and R with concealment. With too little history
  // to turn over (the very start), it is silence.
  dry(L, R) {
    const n = L.length;
    if (!this.active) {
      this.span = Math.min(this.filled, this.size);
      this.base = this.w - 1 < 0 ? this.size - 1 : this.w - 1;
      // The turn's length, fixed for this run: no more than a third of
      // the history, so a pass always has a stretch of its own.
      this.turnLen = Math.min(this.xfade, Math.floor((this.span - 1) / 3));
      this.pa = 0;
      this.da = 1;
      this.turn = -1;
      this.age = 0;
      this.gain = 1;
      this.active = true;
      this.stepA();
    }
    // A stall in the middle of a fade out carries on concealing.
    this.out = 0;
    if (this.span < 2) { L.fill(0); R.fill(0); return; }
    for (let i = 0; i < n; i++) {
      this.frame();
      L[i] = this.l;
      R[i] = this.r;
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
        if (this.out === 0) this.ret = Math.max(MIN_RETURN, this.xfade);
        const len = this.ret;
        for (; i < n && this.out < len; i++, this.out++) {
          this.frame();
          const k = ((this.out + 0.5) * TABLE / len) | 0;
          const a = SIN[k], b = SIN[TABLE - k];
          L[i] = L[i] * a + this.l * b;
          R[i] = R[i] * a + this.r * b;
        }
        if (this.out < len) return;
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
