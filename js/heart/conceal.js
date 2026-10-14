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
// The history is what was heard, every frame of it: the live sound, the
// concealment and the fades between them, so it has no seams for a later
// ping-pong to run across, and a stall that comes while the last one is
// still fading out simply starts again from the last frame heard. The ring
// holds twice the history: the ping-pong reads the `size` frames behind
// the point it froze, while what it plays is written ahead of that point,
// so the two never meet. A stall that outlasts the room ahead stops
// writing, and the history then starts over once the sound is back. A rest
// (a pause, see the drain) or a quantum of deliberate silence forgets it
// too: what was playing before a pause is not what should cover a stall
// after it.
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
    this.cap = 2 * size;
    this.hL = new Float32Array(this.cap);
    this.hR = new Float32Array(this.cap);
    this.w = 0;           // the next history slot to write
    this.filled = 0;      // frames of seamless history, up to cap
    this.xfade = 0;
    this.setXfade(xfade);
    this.hold = hold;
    this.decay = decay;
    this.active = false;  // concealing, or fading it out
    this.out = 0;         // frames into the fade out, while fading
    this.ret = MIN_RETURN; // the fade out's length, fixed when it starts
    this.base = 0;        // the newest history frame, frozen at the start
    this.span = 0;        // frames of history the ping-pong turns over
    this.written = 0;     // frames written ahead of base this stall
    this.overflow = false; // the stall outran the room ahead of base
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
    this.filled = 0;
    this.active = false;
    this.out = 0;
  }

  // Frames head a has left before the end of the history it is heading to.
  left() { return this.da > 0 ? this.span - 1 - this.pa : this.pa; }

  at(h, p) {
    let i = this.base - p;
    if (i < 0) i += this.cap;
    return h[i];
  }

  // A stall starts, from the last frame heard.
  start() {
    this.span = Math.min(this.filled, this.size);
    this.base = this.w - 1 < 0 ? this.cap - 1 : this.w - 1;
    // The turn's length, fixed for this run: no more than a third of the
    // history, so a pass always has a stretch of its own.
    this.turnLen = Math.max(0, Math.min(this.xfade, Math.floor((this.span - 1) / 3)));
    this.pa = 0;
    this.da = 1;
    this.turn = -1;
    this.age = 0;
    this.gain = 1;
    this.written = 0;
    this.overflow = false;
    this.active = true;
    this.out = 0;
    if (this.span >= 2) this.stepA();
  }

  // One frame of concealment into this.l and this.r, then the heads move on.
  frame() {
    if (this.span < 2) { this.l = this.r = 0; return; }
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

  // What was heard, frames `from` on, into the history. During a stall it
  // goes ahead of base, and stops before it would reach what is being read.
  record(L, R, from) {
    const cap = this.cap, n = L.length;
    let w = this.w, i = from;
    for (; i < n; i++) {
      if (this.active) {
        if (this.overflow) break;
        if (++this.written >= cap - this.span) { this.overflow = true; break; }
      }
      this.hL[w] = L[i];
      this.hR[w] = R[i];
      if (++w === cap) w = 0;
    }
    this.filled = Math.min(cap, this.filled + (i - from));
    this.w = w;
  }

  // A dry quantum: fills L and R with concealment. With too little history
  // to turn over (the very start), it is silence.
  dry(L, R) {
    const n = L.length;
    // A new stall, or one that comes while the last is fading out: from
    // the last frame heard. Only a stall that outran its room carries on
    // where it was, as there is no seamless history to start from.
    if (!this.active || (this.out > 0 && !this.overflow)) this.start();
    this.out = 0;
    for (let i = 0; i < n; i++) {
      this.frame();
      L[i] = this.l;
      R[i] = this.r;
    }
    this.record(L, R, 0);
  }

  // A quantum that had audio, already in L and R: fades the concealment out
  // under it if one is under way, and keeps what was heard as history.
  wet(L, R) {
    const n = L.length;
    let i = 0;
    if (this.active) {
      if (this.out === 0) this.ret = Math.max(MIN_RETURN, this.xfade);
      const len = this.ret;
      for (; i < n && this.out < len; i++, this.out++) {
        this.frame();
        const k = ((this.out + 0.5) * TABLE / len) | 0;
        const a = SIN[k], b = SIN[TABLE - k];
        L[i] = L[i] * a + this.l * b;
        R[i] = R[i] * a + this.r * b;
      }
      if (this.out < len) { this.record(L, R, 0); return; }
      // Done: what was heard up to here goes in, unless the stall outran
      // its room, and then the history starts over from here.
      const over = this.overflow;
      if (!over) this.record(L, R, 0);
      this.active = false;
      this.out = 0;
      this.overflow = false;
      if (over) { this.filled = 0; this.record(L, R, i); }
      return;
    }
    this.record(L, R, 0);
  }

  // A quantum played as silence on purpose (rest, refill, a wake's wait):
  // no concealment, none to fade out of, and the history starts over.
  quiet() { this.active = false; this.out = 0; this.filled = 0; }
}
