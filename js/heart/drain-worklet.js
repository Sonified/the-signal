// The drain: the one piece of Heart on the browser's audio thread
// (documents/heart-audio-engine.md, §7.2 and §7.5). The workers render
// ahead into the final ring; 'heart-drain' copies 128 frames of it into its
// output on every render quantum, and nothing else, so it can never be the
// slow part. Its output goes to the native master (volGain), where the pause
// gate and the transport's ramps stay native.
//
// The drain is also Heart's clock. Engine frame 0 plays at the native frame
// F of the first quantum that finds audio waiting, and the drain posts F
// once; from then on engine frame n plays at native frame F + n, exactly,
// for the rest of the session. It holds that line through an underrun: a
// quantum whose frames have not arrived plays silence, is counted, and is
// still counted as played, and when the late frames do arrive they are
// dropped rather than played late. A late block costs a gap, never a shift,
// so the strobe and everything timed against currentTime stay true.
//
// Every quantum moves the played count on by one. With SharedArrayBuffer it
// lives in the control block (ring.js), where the workers read it, and the
// drain rings the bell of any worker waiting for the count it has just
// reached. Without, the count rides each chunk the drain posts back to the
// mix (ring.js, MessageRing), and the page hears the count and the
// underruns every quarter second or so over the node's port.
//
// The drain also steers the lookahead (§7.3, adaptive lookahead), because
// it is the first to know of an underrun and the one thread the browser
// keeps running on time. The rule is four lines of integer work a quantum:
//
//   grow     the first silent quantum of a run doubles the lookahead, up to
//            the most; one stall is one run, so one stall doubles it once
//   hidden   the page says when it goes hidden (visibilitychange), and the
//            lookahead rises to the hidden floor at once
//   shrink   after a steady stretch, visible and without an underrun, it
//            halves, never below the base; a shrink drops nothing, the
//            stages simply render less far ahead while what is buffered
//            plays out
//   delay    a rise is announced first (LOOKAHEAD_NEXT, which the page's
//            horizon reads) and obeyed a chunk later (LOOKAHEAD, which the
//            stages read), and the drain then rings every stage's bell so
//            a sleeping one wakes and fills the new room
//
// None of it moves the time map: the clock still counts every quantum.
// Without SharedArrayBuffer the lookahead rides each chunk going back to
// the mix, beside the clock, and every change is posted to the page.
//
// Loaded with addModule by js/heart/engine.js. The logic is the Drain class,
// which knows nothing of AudioWorkletProcessor, so it can be tested in node
// (tools/heart-tests/drain.test.mjs); the processor at the bottom only hands
// it the output and the frame.

import {
  QUANTUM, CHUNK, PLAYED, UNDERRUNS, LOOKAHEAD, LOOKAHEAD_NEXT, wakeOf, ringBell, openRing
} from './ring.js';

// About a quarter second at 48 kHz, in quanta.
const STATS_EVERY = 96;
// How long a rise of the lookahead is announced before it is obeyed: the
// chunk the horizon already allows for a command batch's trip.
const RISE_DELAY = CHUNK / QUANTUM;

export class Drain {
  // `lookahead`, all in frames but `steady` (quanta): { base, max, hidden,
  // steady, startHidden }, or null to keep it fixed.
  constructor({ control = null, stages = 1, post, lookahead = null }) {
    this.ctl = control;
    this.stages = stages;
    this.post = post;
    this.ring = null;
    this.started = false;
    this.played = 0;        // quanta handed to the output since F
    this.debt = 0;          // frames played as silence that are still to arrive, to be dropped
    this.underruns = 0;     // quanta played as silence
    this.report = { type: 'stats', played: 0, underruns: 0 };
    // The lookahead: what the stages obey, where it is going, the quanta
    // until it gets there, whether the page is hidden, the quanta of calm
    // so far, and whether the last quantum was silent.
    this.policy = lookahead;
    this.target = this.next = lookahead ? lookahead.base : 0;
    this.rising = 0;
    this.hidden = false;
    this.calm = 0;
    this.dry = false;
    this.news = { type: 'lookahead', next: 0, target: 0, underruns: 0 };
    if (lookahead && lookahead.startHidden) this.setHidden(true);
  }

  attach(ring) { this.ring = ring; }

  // One render quantum: fills L and R from the ring. `now` is the native
  // currentFrame, needed only for F.
  play(L, R, now) {
    const ring = this.ring, n = L.length;
    if (!this.started) {
      if (!ring || ring.readable() < n) { L.fill(0); R.fill(0); return; }
      this.started = true;
      this.post({ type: 'start', F: now });
    }
    // The clock as it will stand once this quantum is out, for the chunks
    // released below to carry back to the mix.
    ring.clock = (this.played + 1) * QUANTUM;
    ring.ahead = this.target;
    // One look at the ring per quantum. A stage may commit between two
    // looks, and a second look could then find a quantum's worth waiting
    // behind late frames not yet dropped, and play them late.
    let ready = ring.readable();
    if (this.debt > 0) {
      const late = Math.min(this.debt, ready);
      if (late > 0) { ring.release(late); this.debt -= late; ready -= late; }
    }
    if (ready >= n) {
      ring.read(0, L, 0, n);
      ring.read(1, R, 0, n);
      ring.release(n);
      this.dry = false;
    } else {
      L.fill(0);
      R.fill(0);
      this.debt += n;
      this.underruns++;
      if (this.ctl) Atomics.add(this.ctl, UNDERRUNS, 1);
      this.calm = 0;
      if (!this.dry && this.policy) this.raise(2 * this.next);
      this.dry = true;
    }
    this.tick();
  }

  tick() {
    const played = ++this.played, ctl = this.ctl;
    if (this.policy) this.steer();
    if (ctl) {
      Atomics.store(ctl, PLAYED, played);
      for (let s = 0; s < this.stages; s++) {
        const want = Atomics.load(ctl, wakeOf(s));
        if (want >= 0 && played >= want) {
          Atomics.store(ctl, wakeOf(s), -1);
          ringBell(ctl, s);
        }
      }
    } else if (played % STATS_EVERY === 0) {
      this.report.played = played;
      this.report.underruns = this.underruns;
      this.post(this.report);
    }
  }

  // ---------- the lookahead ----------
  // The page went hidden or came back. Hidden, nothing is interactive and
  // the OS starts slowing the workers, so the cushion goes up before it is
  // needed; visible again, the steady stretch starts over.
  setHidden(hidden) {
    this.hidden = hidden;
    this.calm = 0;
    if (hidden && this.policy) this.raise(this.policy.hidden);
  }

  // Announces a rise, to be obeyed RISE_DELAY quanta on.
  raise(frames) {
    frames = Math.min(this.policy.max, frames);
    if (frames <= this.next) return;
    this.next = frames;
    this.rising = RISE_DELAY;
    if (this.ctl) Atomics.store(this.ctl, LOOKAHEAD_NEXT, frames);
    else this.tell();
  }

  // Once a quantum: a rise falls due, or a steady stretch ends in a step
  // down.
  steer() {
    const p = this.policy;
    if (this.rising > 0 && --this.rising === 0) this.obey(true);
    if (this.hidden || this.rising > 0 || this.dry) return;
    if (this.target <= p.base) { this.calm = 0; return; }
    if (++this.calm < p.steady) return;
    this.calm = 0;
    this.next = Math.max(p.base, Math.ceil(this.target / 2 / QUANTUM) * QUANTUM);
    this.obey(false);
  }

  obey(rose) {
    this.target = this.next;
    const ctl = this.ctl;
    if (!ctl) { this.tell(); return; }
    Atomics.store(ctl, LOOKAHEAD_NEXT, this.next);
    Atomics.store(ctl, LOOKAHEAD, this.target);
    if (rose) for (let s = 0; s < this.stages; s++) ringBell(ctl, s);
  }

  // Message mode: the page hears every change (its horizon needs it).
  tell() {
    const n = this.news;
    n.next = this.next;
    n.target = this.target;
    n.underruns = this.underruns;
    this.post(n);
  }

  close() {
    if (this.ring) this.ring.close();
    this.ring = null;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('heart-drain', class HeartDrain extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = options.processorOptions;
      this.alive = true;
      this.drain = new Drain({
        control: o.control, stages: o.stages, lookahead: o.lookahead || null,
        post: m => this.port.postMessage(m)
      });
      // A shared ring comes in the options; a message ring's port has to be
      // transferred, which options cannot do, so it follows over the port.
      if (o.ring) this.drain.attach(openRing(o.ring, 'reader'));
      this.port.onmessage = e => {
        const d = e.data;
        if (d.type === 'ring') this.drain.attach(openRing(d.ring, 'reader'));
        else if (d.type === 'hidden') this.drain.setHidden(d.hidden === true);
        else if (d.type === 'close') { this.alive = false; this.drain.close(); }
      };
    }

    process(inputs, outputs) {
      const out = outputs[0];
      if (this.alive) this.drain.play(out[0], out[1], currentFrame);
      return this.alive;
    }
  });
}
