/* solar meditation — the hum beneath the light.
   62.8 years of hourly solar wind speed as one looping tone (1 hour = 1 audio
   sample), lowpass-filtered and speed-scaled. This is the listen page's engine
   (app.js) distilled to what the sun face needs: no scopes, no selection, no
   DOM — just load / play / pause, years-per-second, and a cutoff.

   Decode + stitch + seam smoothing mirror app.js exactly; keep them in sync. */

'use strict';

const SunAudio = (() => {
  const DATA_URL = 'data/solar_wind_speed_hourly.u16';
  const HOURS_PER_YEAR = 8766;      // 365.25 * 24
  const BIG_GAP_HOURS = 168;        // >= 7 days is a hole worth cutting
  const SEAM_HALF = 4;              // splice de-click half-window, in samples

  let values = null, hourOf = null; // the stitched series (see app.js stitch())
  let ctx = null, buffer = null, filter = null, master = null, outputGate = null;
  let mediaOut = null;              // phone output path; see ensureCtx
  let src = null, env = null;

  let playing = false;
  let cutoffTarget = 376;           // matches the sun face's resting x (~0.25)
  let rate = 0.5;                   // resting rate = bottom of the sun-face drag
  let anchorPos = 0, anchorTime = 0, pausedPos = 0;

  // Phones get a smaller room: earbuds and tiny speakers smear long tails.
  const COARSE = window.matchMedia('(pointer: coarse)').matches;

  let volume = 0.9;                 // master gain, 0..1

  // ── diagnostics: ?audiodebug=1 paints an on-screen log (phones have no
  // console) plus a sample-step detector on the gate's output — the largest
  // |x[n]-x[n-1]| seen and when. ?nohum=1 opens the gate on pure silence.
  const QS = new URLSearchParams(location.search);
  const DEBUG = QS.get('audiodebug') === '1';
  const NOHUM = QS.get('nohum') === '1';
  let dbgEl = null, dbgT0 = 0, stepMax = 0, stepAt = 0, stepLast = 0;
  function dbg(msg) {
    if (!DEBUG) return;
    if (!dbgEl) {
      dbgEl = document.createElement('pre');
      dbgEl.style.cssText = 'position:fixed;left:0;top:0;z-index:99;margin:0;padding:6px;' +
        'max-width:100vw;max-height:60vh;overflow:auto;font:11px/1.35 ui-monospace,monospace;' +
        'color:#9f9;background:rgba(0,0,0,.72);pointer-events:none;white-space:pre-wrap';
      document.body.appendChild(dbgEl);
      dbgT0 = performance.now();
    }
    const ct = ctx ? ctx.currentTime.toFixed(3) : '-';
    dbgEl.textContent += `${((performance.now() - dbgT0) / 1000).toFixed(3)}s ctx=${ct} ${msg}\n`;
  }
  function dbgTap() {
    if (!DEBUG || !ctx || !outputGate) return;
    // ScriptProcessor is deprecated but it is the one tap iOS still honors
    const sp = ctx.createScriptProcessor(1024, 1, 1);
    const sink = ctx.createGain(); sink.gain.value = 0;   // must reach the destination to run
    outputGate.connect(sp).connect(sink).connect(ctx.destination);
    sp.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      let prev = stepLast;
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - prev);
        if (d > stepMax) { stepMax = d; stepAt = e.playbackTime + i / ctx.sampleRate; }
        prev = x[i];
      }
      stepLast = prev;
    };
    setInterval(() => {
      if (dbgEl) dbgEl.setAttribute('data-step', '');
      if (dbgEl && stepMax > 0) {
        const line = `[step] max |dx|=${stepMax.toFixed(4)} at ctx ${stepAt.toFixed(3)}  state=${ctx.state}`;
        const lines = dbgEl.textContent.split('\n').filter((l) => !l.startsWith('[step]'));
        dbgEl.textContent = [line, ...lines].join('\n');
      }
    }, 300);
  }
  let verbMix = COARSE ? 0.21 : 0.3;   // reverb wet/dry (30% drier on touch)
  let verbOn = true;                  // the room, switchable from Settings
  let verbSize = COARSE ? 1.75 : 3.5;  // tail seconds to -60 dB (half on touch)
  let dry = null, wet = null, verbTimer = 0;
  let verbSlots = null, verbActive = 0;   // two convolvers, crossfade-swapped
  let lifecycleTimer = 0, outputOpen = false, outputEverOpened = false, routeKicked = false;

  // ── decode (identical to app.js) ──────────────────────────────────

  function readHeader(buf) {
    const dv = new DataView(buf);
    let magic = '';
    for (let i = 0; i < 8; i++) magic += String.fromCharCode(dv.getUint8(i));
    if (magic !== 'SOLARHUM') throw new Error('bad magic: ' + magic);
    return {
      code:   dv.getUint8(8),
      count:  dv.getUint32(20, true),
      scale:  dv.getFloat32(24, true),
      offset: dv.getFloat32(28, true),
    };
  }

  function decodeU16(buf, h) {
    const q = new Uint16Array(buf, 32, h.count);
    const cs = Math.round(h.scale * 10000);
    const co = Math.round(h.offset * 10000);
    const out = new Float32Array(h.count);
    for (let i = 0; i < h.count; i++)
      out[i] = q[i] === 0xffff ? NaN : (co + q[i] * cs) / 10000;
    return out;
  }

  function stitch(speeds) {
    const n = speeds.length;
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(speeds[i])) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) throw new Error('no valid samples');

    let kept = 0, prev = -1;
    for (let i = first; i <= last; i++) {
      if (Number.isNaN(speeds[i])) continue;
      const gap = prev < 0 ? 0 : i - prev - 1;
      if (gap > 0 && gap < BIG_GAP_HOURS) kept += gap;
      kept++;
      prev = i;
    }

    const vals = new Float32Array(kept), hrs = new Uint32Array(kept);
    let k = 0;
    prev = -1;
    for (let i = first; i <= last; i++) {
      if (Number.isNaN(speeds[i])) continue;
      const gap = prev < 0 ? 0 : i - prev - 1;
      if (gap > 0 && gap < BIG_GAP_HOURS) {
        const a = speeds[prev], step = (speeds[i] - a) / (gap + 1);
        for (let j = 1; j <= gap; j++) {
          vals[k] = a + step * j;
          hrs[k] = prev + j;
          k++;
        }
      }
      vals[k] = speeds[i];
      hrs[k] = i;
      k++;
      prev = i;
    }
    return { vals, hrs };
  }

  // ── audio graph ───────────────────────────────────────────────────

  function ensureCtx() {
    if (ctx) return;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); }
    catch (e) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.707;
    filter.frequency.value = Math.min(cutoffTarget, 0.45 * ctx.sampleRate);

    // User volume and hardware lifecycle are deliberately separate. The
    // final gate is always born silent, then opens only after the browser's
    // output route is running; this prevents a live waveform/reverb tail from
    // being dropped onto a newly opened device at an arbitrary sample value.
    master = ctx.createGain();
    master.gain.value = volume;
    outputGate = ctx.createGain();
    outputGate.gain.value = 0;
    ctx.addEventListener('statechange', () => {
      dbg(`statechange -> ${ctx.state}`);
      if (ctx.state === 'running') {
        // First run ever: push one silent buffer straight to the destination
        // so the OS opens the route on nothing (the classic iOS pop guard).
        if (!routeKicked) {
          routeKicked = true;
          try {
            const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.05), ctx.sampleRate);
            const k = ctx.createBufferSource(); k.buffer = b; k.connect(ctx.destination); k.start();
            dbg('route kick (silent buffer)');
          } catch (e) {}
        }
        openOutput();
      } else muteOutputNow();
    });

    // On phones, raw WebAudio obeys the ringer's SILENT SWITCH — most
    // phones sit on silent, so the hum simply never sounds. Safari 17+
    // offers the clean opt-out: declare the page's audio "playback" via
    // navigator.audioSession and use the normal destination. Older touch
    // browsers get the fallback: the graph terminates in a stream feeding
    // an <audio> element, which counts as media playback.
    if ('audioSession' in navigator) {
      try { navigator.audioSession.type = 'playback'; } catch (e) {}
      master.connect(outputGate).connect(ctx.destination);
      dbg('path: audioSession -> destination');
    } else if (window.matchMedia('(pointer: coarse)').matches) {
      dbg('path: mediaOut <audio> element (no audioSession)');
      const msd = ctx.createMediaStreamDestination();
      master.connect(outputGate).connect(msd);
      mediaOut = new Audio();
      mediaOut.srcObject = msd.stream;
      mediaOut.setAttribute('playsinline', '');
    } else {
      master.connect(outputGate).connect(ctx.destination);
    }

    // A system-default output change can leave the AudioContext logically
    // running while its hardware route is rebuilt underneath it. Re-close
    // the final gate briefly for both the device-list signal and the newer
    // AudioContext sink signal. The handler is debounced because browsers may
    // emit both for one physical switch.
    if (!COARSE) {
      if (navigator.mediaDevices && navigator.mediaDevices.addEventListener)
        navigator.mediaDevices.addEventListener('devicechange', recycleOutput);
      if ('onsinkchange' in ctx) ctx.addEventListener('sinkchange', recycleOutput);
    }

    // The room, as a parallel path: the filtered hum splits into a dry leg
    // and a convolver leg, recombined equal-power at the master. The impulse
    // is synthesized — stereo shaped noise decaying to -60 dB at verbSize —
    // so no sample ever loads.
    //
    // TWO convolvers, ping-ponged: assigning a new buffer to a LIVE
    // ConvolverNode hard-resets its state — the tail truncates to silence
    // and the output steps, which pops. So a size change loads the new
    // impulse into the silent slot and crossfades; no audible node's
    // buffer is ever touched.
    dry = ctx.createGain();
    wet = ctx.createGain();
    // The switch is read from storage before any of this exists, so the
    // graph is BORN in the state it was left in — no swell on page load.
    const m0 = verbOn ? verbMix : 0;
    dry.gain.value = Math.cos(m0 * Math.PI / 2);
    wet.gain.value = Math.sin(m0 * Math.PI / 2);
    filter.connect(dry).connect(master);
    wet.connect(master);

    verbSlots = [0, 1].map((i) => {
      const conv = ctx.createConvolver();
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0;
      filter.connect(conv).connect(g).connect(wet);
      return { conv, g };
    });
    verbSlots[0].conv.buffer = makeImpulse(verbSize);
    verbActive = 0;

    if (values) buildBuffer();
    dbgTap();
  }

  // The buffer IS the series, mean-removed, seams smoothed, peak-normalized.
  // Split from ensureCtx so a gesture can PRIME the context before the data
  // has arrived; the buffer joins the graph the moment both exist.
  function buildBuffer() {
    const n = values.length;
    buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = buffer.getChannelData(0);

    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    const mean = sum / n;
    for (let i = 0; i < n; i++) ch[i] = values[i] - mean;

    // Cancel each dropped-gap step with an additive raised-cosine correction
    // (see app.js for the full story). Deltas read before any correction lands.
    const seamAt = [], seamDelta = [];
    for (let b = 1; b < n; b++) {
      if (hourOf[b] === hourOf[b - 1] + 1) continue;
      seamAt.push(b);
      seamDelta.push((ch[b] - ch[b - 1]) * 0.5);
    }
    for (let s = 0; s < seamAt.length; s++) {
      const b = seamAt[s], half = seamDelta[s];
      for (let j = 0; j < SEAM_HALF; j++) {
        const g = 0.5 * (1 + Math.cos(Math.PI * (j + 0.5) / SEAM_HALF));
        if (b - 1 - j >= 0) ch[b - 1 - j] += half * g;
        if (b + j < n) ch[b + j] -= half * g;
      }
    }

    let peak = 1e-12;
    for (let i = 0; i < n; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > peak) peak = a;
    }
    const k = 1 / peak;
    for (let i = 0; i < n; i++) ch[i] *= k;
  }

  function makeImpulse(seconds) {
    const sr = ctx.sampleRate, len = Math.max(1, Math.round(seconds * sr));
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(0.001, i / len);
    }
    return ir;
  }

  function hold(param, t) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
    }
  }

  function muteOutputNow() {
    if (!ctx || !outputGate) return;
    outputOpen = false;
    const t = ctx.currentTime;
    dbg('muteOutputNow');
    // a step to zero from a live signal is itself a click; 5ms is
    // inaudible as a fade and silent as an edge. hold() pins the LIVE
    // automated value (Safari's gain.value can report the stale set value).
    hold(outputGate.gain, t);
    outputGate.gain.linearRampToValueAtTime(0, t + 0.005);
  }

  function closeOutput(seconds = 0.035) {
    if (!ctx || !outputGate) return;
    outputOpen = false;
    const t = ctx.currentTime;
    hold(outputGate.gain, t);
    outputGate.gain.linearRampToValueAtTime(0, t + seconds);
  }

  function openOutput() {
    if (!ctx || !outputGate || !playing || ctx.state !== 'running' || outputOpen)
      return;
    clearTimeout(lifecycleTimer);
    const firstOpen = !outputEverOpened;
    outputOpen = true;
    outputEverOpened = true;
    const t = ctx.currentTime;
    dbg(`openOutput first=${firstOpen} wait=${COARSE ? 0.25 : 0}`);
    // PHONES: a quarter second of enforced silence first — the start click
    // is the phone output waking up, and its 1.15s rise is untouched.
    // DESKTOP: the visit's first sound swells over a second. A resume is
    // quicker but still a swell, not a switch — 0.18s read as a click of
    // the hum coming back, and this is a room you sit in.
    const wait = COARSE ? 0.25 : 0;
    const rise = COARSE ? 1.15 : (firstOpen ? 1.0 : 0.4);
    outputGate.gain.cancelScheduledValues(t);
    outputGate.gain.setValueAtTime(0.0001, t);
    outputGate.gain.setValueAtTime(0.0001, t + wait);
    outputGate.gain.exponentialRampToValueAtTime(1, t + wait + rise);
  }

  // The wet/dry pair always move together, equal-power, and always by
  // APPROACH rather than assignment: `tau` is the time constant, ~0.03 for a
  // fader (instant to the hand) and ~0.25 for the room being switched on or
  // off — three quarters of a second of swell, so the walls arrive and leave
  // rather than blinking. Off is simply mix 0: the tail that is already in
  // the air rides its own decay out instead of being cut.
  function applyVerb(tau) {
    if (!dry || !ctx) return;
    const m = verbOn ? verbMix : 0;
    const t = ctx.currentTime;
    dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), t, tau);
    wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), t, tau);
  }

  function recycleOutput() {
    if (!ctx || !outputGate || !playing) return;
    closeOutput(0.025);
    clearTimeout(lifecycleTimer);
    lifecycleTimer = setTimeout(() => {
      if (ctx.state === 'running') openOutput();
      else ctx.resume().then(openOutput).catch(() => {});
    }, 80);
  }

  const latency = () => ctx.outputLatency || ctx.baseLatency || 0;
  const dur = () => buffer.length / ctx.sampleRate;

  function currentPos() {
    if (!playing || !src) return pausedPos;
    let p = anchorPos + (ctx.currentTime - anchorTime) * rate;
    return p % dur();
  }

  function startSource(offsetSec) {
    src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    env = ctx.createGain();
    env.gain.value = 0;
    src.connect(env).connect(filter);
    // The lead is the whole game. A 10ms lead is shorter than the main
    // thread can stall for right after ensureCtx() has synthesised the
    // reverb and built the buffer — and a start time that lands in the
    // PAST makes the browser begin instantly with the fade-in already
    // elapsed, so the first sample arrives at full amplitude: the click.
    // 80ms is imperceptible as latency and safely past any render quantum.
    // Read currentTime as late as possible, after the nodes exist.
    const at = ctx.currentTime + 0.08;
    dbg(`startSource at=${at.toFixed(3)} offset=${(offsetSec % dur()).toFixed(2)}`);
    src.start(at, offsetSec % dur());
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + 0.04);    // a fade, not an edge
    anchorPos = offsetSec;
    anchorTime = at + latency();
  }

  function stopSource() {
    if (!src) return;
    const now = ctx.currentTime;
    pausedPos = currentPos();
    const s = src, e = env;
    src = null; env = null;
    e.gain.cancelScheduledValues(now);
    e.gain.setValueAtTime(e.gain.value, now);
    e.gain.linearRampToValueAtTime(0, now + 0.02);
    try { s.stop(now + 0.05); } catch (err) { /* already stopped */ }
    s.onended = () => { try { e.disconnect(); } catch (err) {} };
  }

  // ── public face ───────────────────────────────────────────────────

  return {
    async load() {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const h = readHeader(buf);
      if (h.code !== 2) throw new Error('expected u16 format code 2, got ' + h.code);
      const s = stitch(decodeU16(buf, h));
      values = s.vals;
      hourOf = s.hrs;
    },

    get ready() { return !!values; },
    get playing() { return playing; },
    /** Truly sounding: armed AND the context actually running (a refused
        unlock leaves `playing` true on a suspended context, silent). The
        mobile invitation waits on THIS before it retires. */
    get live() { return !!(playing && ctx && ctx.state === 'running'); },

    /** Needs a user gesture the first time (autoplay policy). If the
        browser refuses the unlock, `playing` still goes true — the SOURCE
        is armed and simply waits, silent, on the suspended context; every
        later gesture calls unlock() and the first blessed one opens the
        gates mid-flight. (Never gate retries on a resume() promise: Safari
        leaves it PENDING rather than rejecting, which once wedged us.) */
    play() {
      if (!values || playing) return;
      ensureCtx();
      if (!buffer) buildBuffer();     // ctx may have been primed dataless
      playing = true;
      this.unlock();
      dbg(`play() state=${ctx.state} nohum=${NOHUM}`);
      if (ctx.state === 'running') {
        if (!NOHUM) startSource(pausedPos);
        openOutput();
        return;
      }
      // THE CLICK: starting the source on a suspended context schedules
      // its 15ms fade-in against a FROZEN clock. When the browser finally
      // resumes, currentTime leaps past those times, the envelope is
      // already at 1, and the very first audible sample lands at full
      // amplitude on an arbitrary point of the waveform — a pop. So the
      // source waits here until the context is genuinely running.
      const armed = () => {
        if (!playing || src || !ctx || ctx.state !== 'running') return;
        if (!NOHUM) startSource(pausedPos);
        openOutput();
      };
      ctx.addEventListener('statechange', armed);
      ctx.resume().then(armed).catch(() => {});
    },

    /** Build + unlock the context inside a gesture WITHOUT needing the
        dataset — so a press that lands mid-download still spends its
        activation, and the hum can start the instant loading finishes. */
    prime() {
      ensureCtx();
      this.unlock();
    },

    /** Build the graph and the buffer BEFORE anyone touches anything.
        ensureCtx() is not cheap — it synthesises the reverb impulse and
        ensureCtx's tail runs buildBuffer over the whole series — and until
        now the first gesture paid for all of it, which is why the listen
        button measured ~900ms to next paint on a phone. Doing it during an
        idle moment instead leaves prime() and play() with almost nothing to
        do, so the tap answers immediately.

        Safe to call with no user gesture: a context constructed this way is
        born SUSPENDED and the graph's final gate is born silent, so nothing
        sounds until a real gesture resumes it. That is the same state
        prime() leaves behind; this only moves the work earlier. */
    warm() {
      if (values) ensureCtx();       // ensureCtx builds the buffer when data is in
    },

    /** Nudge the browser's gates. Idempotent and safe on EVERY gesture:
        a refused resume just stays pending; a blessed one starts sound. */
    unlock() {
      if (!ctx) return;
      dbg(`unlock state=${ctx.state}${mediaOut ? ' mediaOut' + (mediaOut.paused ? ' paused' : ' playing') : ''}`);
      // The resolved resume() is the one signal every browser agrees on —
      // don't lean on statechange alone for the first fade.
      if (ctx.state !== 'running') ctx.resume().then(openOutput).catch(() => {});
      if (mediaOut && mediaOut.paused) mediaOut.play().catch(() => {});
    },

    pause() {
      if (!playing) return;
      playing = false;
      stopSource();
    },

    /** Ramp the FINAL output gate to silence — source, reverb tail and
        all — for the moments before a page reload. pause() alone leaves
        the convolver ringing, and a reload chops that tail with a pop. */
    hush(seconds = 0.12) {
      closeOutput(seconds);
    },

    /** Raw buffer playback rate. 1 hour of sun = 1 sample, so at 48k a
        rate of 1 is ~5.48 years per second. */
    setPlaybackRate(r) {
      if (r === rate) return;
      if (playing && src) {
        anchorPos = currentPos();
        anchorTime = ctx.currentTime + latency();
        src.playbackRate.setValueAtTime(r, ctx.currentTime);
      }
      rate = r;
    },

    /** Data-time velocity. 1 yr/s at 48k = playbackRate 0.183. */
    setYearsPerSecond(yps) {
      const sr = ctx ? ctx.sampleRate : 48000;
      this.setPlaybackRate((yps * HOURS_PER_YEAR) / sr);
    },

    setCutoffHz(hz) {
      cutoffTarget = hz;
      if (filter)
        filter.frequency.setTargetAtTime(
          Math.min(hz, 0.45 * ctx.sampleRate), ctx.currentTime, 0.01);
    },

    /** Master volume, 0..1. Smoothed so slider drags never zipper. */
    setVolume(v) {
      volume = v;
      if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },

    get volume() { return volume; },

    /** Wet/dry, 0..1, crossfaded equal-power so loudness holds steady.
        Remembered while the room is switched off, and restored by the swell
        when it comes back. */
    setReverbMix(m) {
      verbMix = m;
      applyVerb(0.03);
    },

    /** The room, on or off — Settings' switch. Never a cut: the wet leg
        swells in or ebbs out over about three quarters of a second, and the
        dry leg answers it equal-power, so the total loudness holds. */
    setReverbEnabled(on) {
      verbOn = !!on;
      applyVerb(0.25);
    },

    get reverbOn() { return verbOn; },

    /** Tail length in seconds. Debounced (resynthesizing the impulse on
        every pointermove would thrash), then swapped by loading the idle
        convolver and crossfading — see the graph comment in ensureCtx. */
    setReverbSize(seconds) {
      verbSize = seconds;
      if (!verbSlots) return;
      clearTimeout(verbTimer);
      verbTimer = setTimeout(() => {
        const from = verbSlots[verbActive];
        const to = verbSlots[1 - verbActive];
        to.conv.buffer = makeImpulse(verbSize);   // silent slot: safe to touch
        const t = ctx.currentTime;
        from.g.gain.setTargetAtTime(0, t, 0.05);
        to.g.gain.setTargetAtTime(1, t, 0.05);
        verbActive = 1 - verbActive;
      }, 120);
    },
  };
})();
