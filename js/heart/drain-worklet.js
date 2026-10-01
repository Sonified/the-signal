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
// Loaded with addModule by js/heart/engine.js. The logic is the Drain class,
// which knows nothing of AudioWorkletProcessor, so it can be tested in node
// (tools/heart-tests/drain.test.mjs); the processor at the bottom only hands
// it the output and the frame.

import { QUANTUM, PLAYED, UNDERRUNS, wakeOf, ringBell, openRing } from './ring.js';

// About a quarter second at 48 kHz, in quanta.
const STATS_EVERY = 96;

export class Drain {
  constructor({ control = null, stages = 1, post }) {
    this.ctl = control;
    this.stages = stages;
    this.post = post;
    this.ring = null;
    this.started = false;
    this.played = 0;        // quanta handed to the output since F
    this.debt = 0;          // frames played as silence that are still to arrive, to be dropped
    this.underruns = 0;     // quanta played as silence
    this.report = { type: 'stats', played: 0, underruns: 0 };
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
    if (this.debt > 0) {
      const late = Math.min(this.debt, ring.readable());
      if (late > 0) { ring.release(late); this.debt -= late; }
    }
    if (ring.readable() >= n) {
      ring.read(0, L, 0, n);
      ring.read(1, R, 0, n);
      ring.release(n);
    } else {
      L.fill(0);
      R.fill(0);
      this.debt += n;
      this.underruns++;
      if (this.ctl) Atomics.add(this.ctl, UNDERRUNS, 1);
    }
    this.tick();
  }

  tick() {
    const played = ++this.played, ctl = this.ctl;
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
      this.drain = new Drain({ control: o.control, stages: o.stages, post: m => this.port.postMessage(m) });
      // A shared ring comes in the options; a message ring's port has to be
      // transferred, which options cannot do, so it follows over the port.
      if (o.ring) this.drain.attach(openRing(o.ring, 'reader'));
      this.port.onmessage = e => {
        const d = e.data;
        if (d.type === 'ring') this.drain.attach(openRing(d.ring, 'reader'));
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
