// Heart's rings: how audio moves between threads (documents/heart-audio-
// engine.md, §7.3). Each island worker writes its egress ports into one ring
// that the mix worker reads, and the mix (or the one combined worker) writes
// the master into the final ring that the drain plays. Every ring has one
// writer and one reader, so it needs no locks.
//
// Two rings keep one interface. Where the page is cross-origin isolated,
// SharedRing is a ring of planar f32 frames in a SharedArrayBuffer, its two
// indices moved with Atomics (the ringbuf.js pattern): the writer copies
// samples in and then publishes the new write index, the reader copies them
// out and then publishes the new read index, and the Atomics store of an
// index is what makes the samples before it visible on the other thread.
// Where it is not, MessageRing carries the same frames over a MessagePort as
// whole chunks, each a transferred Float32Array, and the reader posts every
// emptied chunk back so the writer fills it again: after the first lap
// nothing new is ever allocated for samples.
//
// The interface, the same on both:
//
//   writable()                          frames the writer may write now
//   write(c, src, from, frames, at)     copies src[from..] into channel c,
//                                       `at` frames past the write index
//   zero(c, frames, at)                 the same, with silence
//   commit(frames)                      publishes them to the reader
//   readable()                          frames the reader may read now
//   read(c, dst, to, frames, at)        copies channel c into dst[to..],
//                                       `at` frames past the read index
//   release(frames)                     gives them back to the writer
//   label()                             the engine frame of the next frame
//                                       to read, or -1 when unknown
//   run()                               frames to read before the label
//                                       may jump
//
// Labels. A stage passes commit() the engine frame of the chunk's first
// sample, and the ring carries it to the reader beside the samples, so the
// reader knows which moment it holds without counting. Counting is all it
// needed while every stage rendered every frame; a stage that rests
// (render-worker.js, skipTo) jumps its present forward instead, and the
// frames after the jump are labelled with where it landed. The drain then
// lines them up with its clock and the mix with its own frame, both
// exactly, whatever order the stages woke in. A commit without a label
// (the tests' hand-written chunks) leaves the reader counting as before.
//
// Copies are plain loops over (array, index) pairs rather than set() over
// subarray views, because a view is an allocation and the drain reads its
// ring on the audio thread 375 times a second.
//
// This file also holds the control block (below), the few shared integers
// that carry the clock and the wake-ups in SharedArrayBuffer mode, and the
// layout constants every Heart thread agrees on. It imports nothing, so the
// drain worklet can load it.

// Web Audio's render quantum, and the drain's step.
export const QUANTUM = 128;
// What a worker renders per heart_render call, and a MessageRing's chunk.
// Four quanta: large enough that a call's fixed cost vanishes, small enough
// that a 45 ms lookahead holds four of them.
export const CHUNK = 512;
// An island stage's egress ports, each stereo, all in its one egress ring:
// port p is channels 2p (left) and 2p + 1 (right).
export const MAX_PORTS = 16;
export const EGRESS_CHANNELS = 2 * MAX_PORTS;
// The number the mix asks heart_port_ptr(1, ·) for: the ingress fed by
// egress port `port` of island stage `stage`. Port numbers are per stage, so
// the stage is folded in to keep every ingress in the mix distinct.
export const ingressKey = (stage, port) => stage * MAX_PORTS + port;

// ---------- SharedRing ----------
// Indices run over size = capacity + 1 frames, one frame always left empty,
// so read === write means empty and never full. Each channel is a plane of
// `size` floats after the 8-byte header of the two indices.
const READ = 0, WRITE = 1, HEADER_BYTES = 8;
// The labels ride a small queue of their own after the planes: one entry per
// labelled commit (its first frame's label, f64, and its length), with its
// own read and write indices, published before the samples' write index so
// a reader never sees frames whose label has not landed. Room for a commit
// as small as a quantum all the way round, and two over.
const labelSlots = capacity => Math.ceil(capacity / QUANTUM) + 2;
const labelsAt = (channels, capacity) => (HEADER_BYTES + 4 * channels * (capacity + 1) + 7) & ~7;

export class SharedRing {
  constructor({ sab, channels, capacity }) {
    this.channels = channels;
    this.capacity = capacity;
    this.size = capacity + 1;
    this.at = new Int32Array(sab, 0, 2);
    this.data = new Float32Array(sab, HEADER_BYTES, channels * this.size);
    const n = labelSlots(capacity), at = labelsAt(channels, capacity);
    this.lab = new Int32Array(sab, at, 2);
    this.labFrame = new Float64Array(sab, at + 8, n);
    this.labLen = new Int32Array(sab, at + 8 + 8 * n, n);
    this.labSlots = n;
    this.labUsed = 0;      // reader: frames already read of the head entry
    // The clock and the lookahead ride the control block in this mode;
    // kept so the two rings read the same to their users.
    this.clock = 0;
    this.ahead = 0;
    this.onchange = null;
  }

  static describe(channels, capacity) {
    const sab = new SharedArrayBuffer(labelsAt(channels, capacity) + 8 + 12 * labelSlots(capacity));
    return { kind: 'shared', sab, channels, capacity };
  }

  readable() {
    const n = Atomics.load(this.at, WRITE) - Atomics.load(this.at, READ);
    return n < 0 ? n + this.size : n;
  }
  writable() { return this.capacity - this.readable(); }

  write(c, src, from, frames, at = 0) {
    const { data, size } = this, base = c * size;
    let pos = (Atomics.load(this.at, WRITE) + at) % size;
    for (let i = 0; i < frames; i++) {
      data[base + pos] = src[from + i];
      if (++pos === size) pos = 0;
    }
  }
  zero(c, frames, at = 0) {
    const { data, size } = this, base = c * size;
    const pos = (Atomics.load(this.at, WRITE) + at) % size, first = Math.min(frames, size - pos);
    data.fill(0, base + pos, base + pos + first);
    data.fill(0, base, base + frames - first);
  }
  commit(frames, label = -1) {
    if (label >= 0) {
      const w = Atomics.load(this.lab, WRITE);
      this.labFrame[w] = label;
      this.labLen[w] = frames;
      Atomics.store(this.lab, WRITE, (w + 1) % this.labSlots);
    }
    Atomics.store(this.at, WRITE, (Atomics.load(this.at, WRITE) + frames) % this.size);
  }

  read(c, dst, to, frames, at = 0) {
    const { data, size } = this, base = c * size;
    let pos = (Atomics.load(this.at, READ) + at) % size;
    for (let i = 0; i < frames; i++) {
      dst[to + i] = data[base + pos];
      if (++pos === size) pos = 0;
    }
  }
  release(frames) {
    Atomics.store(this.at, READ, (Atomics.load(this.at, READ) + frames) % this.size);
    let r = Atomics.load(this.lab, READ);
    if (r === Atomics.load(this.lab, WRITE)) return;
    this.labUsed += frames;
    while (r !== Atomics.load(this.lab, WRITE) && this.labUsed >= this.labLen[r]) {
      this.labUsed -= this.labLen[r];
      r = (r + 1) % this.labSlots;
    }
    Atomics.store(this.lab, READ, r);
  }

  label() {
    const r = Atomics.load(this.lab, READ);
    return r === Atomics.load(this.lab, WRITE) ? -1 : this.labFrame[r] + this.labUsed;
  }
  run() {
    const r = Atomics.load(this.lab, READ);
    return r === Atomics.load(this.lab, WRITE) ? Infinity : this.labLen[r] - this.labUsed;
  }

  close() {}
}

// ---------- MessageRing ----------
// The writer side holds the spare chunks the reader has sent back and the
// one it is filling; it makes a new chunk only while fewer than `slots`
// exist. The reader side holds the chunks in flight towards it, in order,
// in a fixed circle of `slots`, and how far into the first it has read.
// Every message, either way, is { buf, clock, ahead }: the reader's clock
// (the frames the drain has played, as far as the reader knows) and its
// lookahead (the frames the writer may render past that clock, 0 for none
// to give) ride each returned chunk, which is how the mix hears the drain's
// progress and its lookahead without a channel of its own. Going the other
// way, towards the reader, `clock` carries the chunk's label (-1 for none).
export class MessageRing {
  constructor({ port, channels, chunk, slots }, side) {
    this.port = port;
    this.channels = channels;
    this.chunk = chunk;
    this.slots = slots;
    this.writer = side === 'writer';
    this.clock = 0;
    this.ahead = 0;
    this.onchange = null;
    // writer
    this.spare = [];
    this.made = 0;
    this.inFlight = 0;
    this.filling = null;
    // reader
    this.queue = new Array(slots).fill(null);
    this.labels = new Float64Array(slots).fill(-1);
    this.head = 0;
    this.queued = 0;
    this.offset = 0;
    // One message object and transfer list, refilled for every post.
    this.msg = { buf: null, clock: 0, ahead: 0 };
    this.xfer = [null];
    port.onmessage = e => this.receive(e.data);
  }

  static describe(channels, frames, chunk = CHUNK) {
    const { port1, port2 } = new MessageChannel(), slots = Math.max(1, Math.ceil(frames / chunk));
    return {
      writer: { kind: 'message', port: port1, channels, chunk, slots },
      reader: { kind: 'message', port: port2, channels, chunk, slots }
    };
  }

  receive({ buf, clock, ahead }) {
    if (this.writer) {
      this.spare.push(buf);
      this.inFlight--;
      this.clock = clock;
      this.ahead = ahead;
    } else {
      const k = (this.head + this.queued) % this.slots;
      this.queue[k] = buf;
      this.labels[k] = clock;
      this.queued++;
    }
    if (this.onchange) this.onchange();
  }

  // ----- writer -----
  writable() { return (this.slots - this.inFlight) * this.chunk; }

  fill() {
    if (!this.filling) {
      if (this.spare.length) this.filling = this.spare.pop();
      else if (this.made < this.slots) { this.filling = new Float32Array(this.channels * this.chunk); this.made++; }
      else throw new Error('heart: MessageRing written with no room');
    }
    return this.filling;
  }
  write(c, src, from, frames, at = 0) {
    const buf = this.fill(), base = c * this.chunk + at;
    for (let i = 0; i < frames; i++) buf[base + i] = src[from + i];
  }
  zero(c, frames, at = 0) {
    const base = c * this.chunk + at;
    this.fill().fill(0, base, base + frames);
  }
  // A chunk travels whole, so a commit is always exactly one chunk.
  commit(frames, label = -1) {
    if (frames !== this.chunk) throw new Error(`heart: MessageRing commits whole chunks of ${this.chunk}, not ${frames}`);
    this.send(this.fill(), label, 0);
    this.filling = null;
    this.inFlight++;
  }

  // ----- reader -----
  readable() { return this.queued * this.chunk - this.offset; }
  label() {
    if (!this.queued) return -1;
    const at = this.labels[this.head];
    return at >= 0 ? at + this.offset : -1;
  }
  run() { return this.queued ? this.chunk - this.offset : 0; }

  read(c, dst, to, frames, at = 0) {
    const { chunk, slots, queue } = this;
    let k = this.offset + at, i = 0;
    while (i < frames) {
      const buf = queue[(this.head + Math.floor(k / chunk)) % slots], o = k % chunk;
      const n = Math.min(frames - i, chunk - o), base = c * chunk + o;
      for (let j = 0; j < n; j++) dst[to + i + j] = buf[base + j];
      i += n;
      k += n;
    }
  }
  release(frames) {
    this.offset += frames;
    while (this.offset >= this.chunk) {
      const buf = this.queue[this.head];
      this.queue[this.head] = null;
      this.head = (this.head + 1) % this.slots;
      this.queued--;
      this.offset -= this.chunk;
      this.send(buf, this.clock, this.ahead);
    }
  }

  send(buf, clock, ahead) {
    const { msg, xfer } = this;
    msg.buf = buf;
    msg.clock = clock;
    msg.ahead = ahead;
    xfer[0] = buf.buffer;
    this.port.postMessage(msg, xfer);
    msg.buf = null;
    xfer[0] = null;
  }

  close() { this.port.onmessage = null; this.port.close(); }
}

// ---------- making and opening rings ----------
// The main thread makes a ring as a pair of descriptors, one for each end;
// each thread opens its end. A shared ring's two ends are the same memory;
// a message ring's are the two ports of one channel, which must be listed
// as transferables wherever a descriptor is posted (`transfer` below).
export function makeRing(shared, channels, frames) {
  if (shared) {
    const d = SharedRing.describe(channels, frames);
    return { writer: d, reader: d };
  }
  return MessageRing.describe(channels, frames);
}
export const transfer = desc => desc.kind === 'message' ? [desc.port] : [];
export const openRing = (desc, side) => desc.kind === 'shared' ? new SharedRing(desc) : new MessageRing(desc, side);

// ---------- the control block (SharedArrayBuffer mode) ----------
// A few Int32s every thread shares. The drain is the clock: it adds one to
// PLAYED for every quantum it hands the speakers, whether music or the
// silence of an underrun, so played × 128 is always the engine frame now
// sounding (less F, §7.2). The lookahead is two more (§7.3, adaptive
// lookahead), both in frames and both written only by the drain:
//
//   LOOKAHEAD       how far past the clock the mix and the combined stage
//                   render now (islands a chunk further); every stage reads
//                   it before each chunk.
//   LOOKAHEAD_NEXT  where the lookahead is going. A growth is written here
//                   at once and into LOOKAHEAD a chunk later, so the page's
//                   horizon, which reads this one, is ahead of the stages by
//                   the time they obey it, and a command batch already on
//                   its way still lands before a stage renders past it.
//
// Each stage then has four slots:
//
//   BELL     a counter the worker sleeps on with Atomics.waitAsync; anyone
//            who may have unblocked it adds one and notifies.
//   WAKE     the PLAYED value the worker is waiting for, or -1. The drain
//            rings the bell when the clock reaches it, so a worker waiting
//            on the clock is woken once, when it can render, rather than
//            on every quantum.
//   HEAD     the frames the stage has rendered, in quanta.
//   RENDER   its smoothed render time per chunk, in microseconds.
//
// The worker writes WAKE and then reads PLAYED; the drain writes PLAYED and
// then reads WAKE. Atomics are sequentially consistent, so at least one of
// the two sees the other's write, and a wake-up can never fall between them.
export const PLAYED = 0, UNDERRUNS = 1, LOOKAHEAD = 2, LOOKAHEAD_NEXT = 3;
const CONTROL_HEAD = 4, PER_STAGE = 4;
export const bellOf = s => CONTROL_HEAD + s * PER_STAGE;
export const wakeOf = s => CONTROL_HEAD + s * PER_STAGE + 1;
export const headOf = s => CONTROL_HEAD + s * PER_STAGE + 2;
export const renderOf = s => CONTROL_HEAD + s * PER_STAGE + 3;

export function makeControl(stages, lookahead = 0) {
  const ctl = new Int32Array(new SharedArrayBuffer(4 * (CONTROL_HEAD + stages * PER_STAGE)));
  ctl[LOOKAHEAD] = ctl[LOOKAHEAD_NEXT] = lookahead;
  for (let s = 0; s < stages; s++) ctl[wakeOf(s)] = -1;
  return ctl;
}
export function ringBell(ctl, s) {
  Atomics.add(ctl, bellOf(s), 1);
  Atomics.notify(ctl, bellOf(s));
}
