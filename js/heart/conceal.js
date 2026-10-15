// Underrun concealment for the drain (js/heart/drain-worklet.js): what
// plays instead of silence when the ring runs dry. It loops the last stretch
// heard, one of two ways (the drawer's Loop mode):
//
// Ping-pong plays the last `loop` frames backwards from the newest to the
// oldest, then forwards back to the newest, and so on. The first frame of
// the reverse is the frame just played, mirrored, so it goes in without a
// jump. Each turnaround is a crossfade of `xfade` frames: that many frames
// before a pass reaches the end, a second head starts from that end coming
// back the other way, and the first fades out under it as it runs on. Both
// move at the normal rate and cross halfway, so the fade is equal gain. At
// 0 the turn is a hard reflection. Reversed, a steady low tone changes
// direction at every turn, which is why there is the other mode.
//
// Forward plays the last stretch forwards, over and over, like a sampler's
// loop. Its length is the Loop length snapped to whole cycles of the tone
// and of the strobe (setPeriods: the page says what they are), so for the
// tone each pass lands exactly where the last began and nothing at all is
// heard at the seam; for everything else the seam is a crossfade of
// `xfade` frames, from the end of the pass into the frames that came just
// before its start, which lead straight on into it.
//
// Going in, either way, the stall's first frame out (the loop, its level in
// the wash and the room's ring together) is set against where the sound
// was heading, the last two frames heard carried one on, and the
// difference fades away over the crossfade (at least MIN_RETURN frames).
// So nothing steps going in, not even a stall that starts while the last
// one is still fading out with its room ringing, and a ping-pong goes in
// carrying on the way the sound was going instead of turning on the spot.
//
// Quantize repair: a stall always plays whole loops (a forward pass, or
// there and back), and the sound only comes back at the end of one. A
// stall still dry at the end of a loop plays another.
//
// When the ring has audio again (and, quantized, the loop has ended), the
// drain's own frames play and the concealment fades out under them over
// `ret` frames (the drawer's Return fade, at least MIN_RETURN): equal power after a
// ping-pong, which does not line up with the live sound; equal gain after
// a forward loop, which, a whole number of cycles long, does. The timing
// is the drain's as before: the late frames are still dropped and the clock
// never shifts.
//
// The wash (the drawer's Wash, Wash rise and Wash decay): the longer a
// stall goes on, the more of the loop is heard through a reverb (wash.js).
// Over `washRise` frames from the start of a stall, the mix moves from dry
// to `wash` wet, equal power; when the sound comes back the loop stops
// feeding the room as it fades, and the room rings out under the live
// sound at the level it had reached, until it falls silent and sleeps. The
// rise has a memory: between stalls it runs back down over Wash decay, so
// a stall that comes soon after another starts about as wet as that one
// ended, and a burst of short dropouts builds one wash. The room's level
// only ever rises until it sleeps, so nothing steps. At Wash 0 the
// room is never fed and costs nothing.
//
// A stall longer than `hold` frames is no longer a hiccup to cover, so the
// concealment then fades to silence over `decay` frames and stays silent;
// the audio coming back then fades in from silence.
//
// The history is what was heard, every frame of it: the live sound, the
// concealment and the fades between them, so it has no seams for a later
// loop to run across, and a stall that comes while the last one is still
// fading out simply starts again from the last frame heard. The ring holds
// twice the history: the loop reads behind the point it froze, while what
// it plays is written ahead of that point, so the two never meet. A stall
// that outlasts the room ahead stops writing, and the history then starts
// over once the sound is back. A rest (a pause, see the drain) or a quantum
// of deliberate silence forgets it too.
//
// Everything is preallocated; nothing here allocates once constructed.

// sin(x * pi / 2) for x in [0, 1], at TABLE + 1 points: every fade's shape,
// read by index, so a new length costs nothing.
const TABLE = 1024;
const SIN = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SIN[i] = Math.sin(i / TABLE * Math.PI / 2);
const MIN_RETURN = 128;
import { Wash } from './wash.js';
// How far a forward loop may stray from the Loop length to fit whole
// cycles, as a share of it, weighed against how well it fits.
const NEAR = 0.25;
// How much a strobe cycle's misfit counts against that: a tenth of a cycle
// as much as straying the whole Loop length again, since the pulse is what
// entrains.
const MISFIT = 10;

export const PINGPONG = 0, FORWARD = 1;

export class Conceal {
  constructor({ size, loop = size, xfade = 0, mode = PINGPONG, quantize = false, hold = 48000, decay = 24000,
    rate = 48000, wash = 0, washRise = rate, washDecay = 4, ret = undefined }) {
    this.room = new Wash(rate);
    this.wash = 0;        // the most of the mix the room takes, 0 to 1
    this.washRise = rate; // frames from the start of a stall to that
    this.washG = 0;       // the room's level, which only rises while it rings
    this.wclock = 0;      // frames into the wash's rise, kept between stalls
    this.rate = rate;
    this.bridgePending = false;
    this.predL = 0; this.predR = 0;
    this.dryG = 1;        // the loop's own level in the mix
    this.size = size;
    this.cap = 2 * size;
    this.hL = new Float32Array(this.cap);
    this.hR = new Float32Array(this.cap);
    this.w = 0;           // the next history slot to write
    this.filled = 0;      // frames of seamless history, up to cap
    this.loop = size;
    this.xfade = 0;
    this.mode = PINGPONG;
    this.quantize = false;
    this.returnLen = rate >> 1;
    this.configure({ loop, xfade, mode, quantize, wash, washRise, washDecay, ret });
    this.tone = 0;        // frames a cycle of the tone, 0 for none
    this.strobe = 0;      // frames a cycle of the strobe, 0 for none
    this.hold = hold;
    this.decay = decay;
    this.active = false;  // concealing, or fading it out
    this.out = 0;         // frames into the fade out, while fading
    this.ret = MIN_RETURN; // the fade out's length, fixed when it starts
    this.fwd = false;     // this run is a forward loop
    this.base = 0;        // the newest history frame, frozen at the start
    this.span = 0;        // frames of history this run reads
    this.written = 0;     // frames written ahead of base this stall
    this.overflow = false; // the stall outran the room ahead of base
    // Ping-pong: head a, and head b while a turn is crossfading, as frames
    // back from base, and 1 going back in time or -1 coming forward.
    this.pa = 0; this.da = 1;
    this.pb = 0; this.db = 1;
    this.turn = -1;       // frames into a turn's crossfade, or -1
    this.turnLen = 0;
    // Forward: the loop's length, its seam's, and where in it the head is.
    this.len = 0;
    this.seam = 0;
    this.t = 0;
    this.bridge = 0;      // frames of the going-in offset left to fade
    this.bridgeLen = 0;
    this.offL = 0; this.offR = 0;
    // Quantize: frames a whole loop, frames into this one, and whether
    // the loop has ended with sound waiting.
    this.cycle = 0;
    this.cyc = 0;
    this.release = false;
    this.age = 0;         // frames concealed this run
    this.gain = 1;
    this.l = 0;           // the frame just made, left and right
    this.r = 0;
  }

  // The drawer's settings, live: Loop length and Crossfade in frames, the
  // Loop mode, and Quantize repair. A run under way keeps what it began with.
  configure({ loop, xfade, mode, quantize, wash, washRise, washDecay, ret }) {
    if (ret !== undefined) this.returnLen = Math.max(MIN_RETURN, ret | 0);
    if (wash !== undefined) this.wash = Math.max(0, Math.min(1, +wash || 0));
    if (washRise !== undefined) this.washRise = Math.max(1, washRise | 0);
    if (washDecay !== undefined && washDecay > 0) this.room.tune(washDecay);
    if (loop !== undefined) this.loop = Math.max(256, Math.min(this.size >> 1, loop | 0));
    if (xfade !== undefined) this.xfade = Math.max(0, Math.min(this.size >> 2, xfade | 0));
    if (mode !== undefined) this.mode = mode === FORWARD ? FORWARD : PINGPONG;
    if (quantize !== undefined) this.quantize = quantize === true;
  }

  // The tone's and the strobe's cycles, in frames (0 for none), which a
  // forward loop's length fits.
  setPeriods(tone, strobe) {
    this.tone = tone > 0 ? tone : 0;
    this.strobe = strobe > 0 ? strobe : 0;
  }

  // Forgets the history (a rest) and any concealment under way.
  reset() {
    this.room.sleep();
    this.washG = 0;
    this.wclock = 0;
    this.filled = 0;
    this.active = false;
    this.out = 0;
  }

  at(h, p) {
    let i = this.base - p;
    if (i < 0) i += this.cap;
    return h[i];
  }

  // The forward loop's length, at most `most`: whole cycles of the tone
  // (or, with none, of the strobe), the count whose strobe fits best and
  // that stays nearest the Loop length.
  fit(most) {
    const want = Math.min(this.loop, most);
    const unit = this.tone || this.strobe;
    if (!unit || unit > most) return want;
    const other = this.tone ? this.strobe : 0;
    let best = Math.max(1, Math.round(want / unit)) * unit, score = Infinity;
    for (let m = 1, n = Math.min(1000, Math.floor(most / unit)); m <= n; m++) {
      const L = m * unit;
      let off = 0;
      if (other) { const c = L / other; off = Math.abs(c - Math.round(c)); }
      const s = MISFIT * off + NEAR * Math.abs(L - want) / want;
      if (s < score) { score = s; best = L; }
    }
    return Math.min(most, Math.round(best));
  }

  // A stall starts, from the last frame heard.
  start() {
    this.base = this.w - 1 < 0 ? this.cap - 1 : this.w - 1;
    const have = Math.min(this.filled, this.size);
    this.fwd = this.mode === FORWARD;
    this.turn = -1;
    this.age = 0;
    this.gain = 1;
    this.written = 0;
    this.overflow = false;
    this.active = true;
    this.out = 0;
    this.cyc = 0;
    this.release = false;
    // Where the sound was heading: the last two frames heard, carried one
    // on. The stall's first frame out is set against it (bridge).
    this.bridge = 0;
    this.bridgePending = this.filled >= 2;
    if (this.bridgePending) {
      this.predL = 2 * this.at(this.hL, 0) - this.at(this.hL, 1);
      this.predR = 2 * this.at(this.hR, 0) - this.at(this.hR, 1);
    }
    if (this.fwd) {
      // The loop and, before it, the seam's lead-in must both be heard.
      const seam = Math.min(this.xfade, have >> 2);
      this.len = have - seam >= 2 ? this.fit(have - seam) : 0;
      this.seam = Math.min(seam, this.len >> 1);
      this.span = this.len + this.seam;
      this.t = 0;
      this.cycle = Math.max(1, this.len);
    } else {
      this.span = Math.min(have, this.loop);
      // No more than a third of the history, so a pass has a stretch of its own.
      this.turnLen = Math.max(0, Math.min(this.xfade, Math.floor((this.span - 1) / 3)));
      this.pa = 0;
      this.da = 1;
      this.cycle = 2 * Math.max(1, this.span - 1 - this.turnLen);
      if (this.span >= 2) this.stepA();
    }
  }

  // One frame of concealment into this.l and this.r, then the heads move on.
  frame() {
    if (this.fwd) this.frameForward(); else this.framePingPong();
    if (++this.cyc >= this.cycle) this.cyc = 0;
    const g = this.gain;
    this.l *= g;
    this.r *= g;
    if (++this.age > this.hold) this.gain = Math.max(0, this.gain - 1 / this.decay);
  }

  frameForward() {
    if (this.len < 2) { this.l = this.r = 0; return; }
    const hL = this.hL, hR = this.hR, len = this.len, t = this.t;
    const p = len - 1 - t;
    let l = this.at(hL, p), r = this.at(hR, p);
    // The seam: the pass's last frames fade into the ones a loop earlier,
    // which run straight on into its first.
    const from = len - this.seam;
    if (t >= from) {
      const k = ((t - from) * TABLE / this.seam) | 0;
      const g = SIN[k] * SIN[k];
      l += (this.at(hL, p + len) - l) * g;
      r += (this.at(hR, p + len) - r) * g;
    }
    this.l = l;
    this.r = r;
    this.t = t + 1 === len ? 0 : t + 1;
  }

  // Frames head a has left before the end of the history it is heading to.
  left() { return this.da > 0 ? this.span - 1 - this.pa : this.pa; }

  framePingPong() {
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
    this.l = l;
    this.r = r;
  }

  // Head a one frame on, reflecting at the ends (a turn with no crossfade).
  stepA() {
    this.pa += this.da;
    if (this.pa >= this.span - 1) { this.pa = this.span - 1; this.da = -1; }
    else if (this.pa <= 0) { this.pa = 0; this.da = 1; }
  }

  // One frame of a stall into L[i] and R[i]: the loop, and the room it is
  // turning into.
  stallFrame(L, R, i) {
    this.frame();
    if (this.wash <= 0) {
      this.dryG = 1;
      if (this.room.awake) this.roomOnly(L, R, i, 0, 0, this.l, this.r);
      else { L[i] = this.l; R[i] = this.r; }
    } else {
      // The wash's clock runs on from wherever the last stall left it.
      if (this.wclock < this.washRise) this.wclock++;
      const u = this.wclock / this.washRise, sh = SIN[(u * TABLE) | 0];
      const k = (this.wash * sh * sh * TABLE) | 0;
      this.dryG = SIN[TABLE - k];
      if (SIN[k] > this.washG) this.washG = SIN[k];
      this.roomOnly(L, R, i, this.l, this.r, this.l * this.dryG, this.r * this.dryG);
    }
    // The first frame out is set against where the sound was heading, and
    // the difference fades away over the bridge: the loop, its level in
    // the mix and the room all go in without a step, whatever they are.
    if (this.bridgePending) {
      this.bridgePending = false;
      this.offL = this.predL - L[i];
      this.offR = this.predR - R[i];
      this.bridgeLen = this.bridge = Math.max(MIN_RETURN, this.xfade);
    }
    if (this.bridge > 0) {
      const g = this.bridgeStep();
      L[i] += this.offL * g;
      R[i] += this.offR * g;
    }
  }

  // The bridge's share this frame, from 1 down to 0.
  bridgeStep() {
    const k = ((this.bridge - 1) * TABLE / this.bridgeLen) | 0;
    this.bridge--;
    return SIN[k] * SIN[k];
  }

  // Between stalls the wash's clock runs back down over the room's decay,
  // so a stall soon after another starts about as wet as that one ended.
  washRest(n) {
    if (this.wclock > 0) this.wclock = Math.max(0, this.wclock - n * this.washRise / (this.room.decay * this.rate));
  }

  // The room fed (xl, xr), its ring added to (yl, yr), into L[i] and R[i].
  roomOnly(L, R, i, xl, xr, yl, yr) {
    const room = this.room;
    room.step(xl, xr);
    L[i] = yl + room.ol * this.washG;
    R[i] = yr + room.or * this.washG;
    if (!room.awake) this.washG = 0;
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
  // to loop (the very start), it is silence.
  dry(L, R) {
    const n = L.length;
    // A new stall, or one that comes while the last is fading out: from
    // the last frame heard. Only a stall that outran its room carries on
    // where it was, as there is no seamless history to start from.
    if (!this.active || (this.out > 0 && !this.overflow)) this.start();
    this.out = 0;
    this.release = false;
    this.room.block(n);
    for (let i = 0; i < n; i++) this.stallFrame(L, R, i);
    this.record(L, R, 0);
  }

  // A quantum that had audio, already in L and R: quantized, the loop plays
  // on over it to its end; then the concealment fades out under it. What
  // was heard is kept as history.
  wet(L, R) {
    const n = L.length;
    let i = 0;
    this.room.block(n);
    if (!this.active || this.out > 0 || this.release) this.washRest(n);
    if (this.active) {
      // Quantized, the sound waits for the end of the loop under way.
      if (this.quantize && this.out === 0 && !this.release) {
        for (; i < n; i++) {
          if (this.cyc === 0 && this.age > 0) { this.release = true; break; }
          this.stallFrame(L, R, i);
        }
        if (!this.release) { this.record(L, R, 0); return; }
      }
      if (this.out === 0) this.ret = this.returnLen;
      const len = this.ret, fwd = this.fwd, feed = this.wash > 0, room = this.room;
      for (; i < n && this.out < len; i++, this.out++) {
        this.frame();
        const k = ((this.out + 0.5) * TABLE / len) | 0;
        let a = SIN[k], b = SIN[TABLE - k];
        if (fwd) { a *= a; b = 1 - a; }
        const cl = this.l * b, cr = this.r * b;
        if (feed || room.awake) {
          this.roomOnly(L, R, i, feed ? cl : 0, feed ? cr : 0, L[i] * a + cl * this.dryG, R[i] * a + cr * this.dryG);
        } else {
          L[i] = L[i] * a + cl * this.dryG;
          R[i] = R[i] * a + cr * this.dryG;
        }
        // A bridge still fading when the sound came back fades out with
        // the loop it belongs to.
        if (this.bridge > 0) {
          const g = this.bridgeStep() * b;
          L[i] += this.offL * g;
          R[i] += this.offR * g;
        }
      }
      if (this.out < len) { this.record(L, R, 0); return; }
      // Done: what was heard up to here goes in, unless the stall outran
      // its room, and then the history starts over from here.
      for (let j = i; j < n && this.room.awake; j++) this.roomOnly(L, R, j, 0, 0, L[j], R[j]);
      const over = this.overflow;
      if (!over) this.record(L, R, 0);
      this.active = false;
      this.out = 0;
      this.overflow = false;
      this.release = false;
      if (over) { this.filled = 0; this.record(L, R, i); }
      return;
    }
    // The room ringing out under the sound.
    for (; i < n && this.room.awake; i++) this.roomOnly(L, R, i, 0, 0, L[i], R[i]);
    this.record(L, R, 0);
  }

  // A quantum played as silence on purpose (rest, refill, a wake's wait):
  // no concealment, none to fade out of, and the history starts over.
  quiet() { this.active = false; this.out = 0; this.release = false; this.filled = 0; this.room.sleep(); this.washG = 0; this.wclock = 0; }
}
