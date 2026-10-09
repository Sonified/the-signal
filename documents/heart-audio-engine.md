# Heart: the audio engine

The Signal's own audio engine: Rust compiled to WebAssembly with SIMD, rendering ahead in workers across several CPU cores, played out through one small AudioWorklet. It replaces the browser's native Web Audio graph for the generated sound (Live Sound stays native), with **identical sound**: we own the processing, not the music.

Status: spec, 2026-09-30; wave 2 (integration and the null-test bench) done the same day, and the sections below say what was built where it differs from the plan. Wave 3's groundwork is in too: late gestures move whole (§6.1), and rooms and the strobe-AM stages work on a Heart context (§12). Read this whole document before touching any Heart file.

---

## 1. Why

With every sound on, the browser's audio thread reached about 80% render capacity, and a phone underran and clicked. The heavy work is native ConvolverNodes and a few hundred nodes, all on **one** real-time thread. We cannot make the browser's native nodes faster, and we cannot choose its buffer size. Heart moves the DSP into our own code, where we can:

- **choose the buffer:** workers render ahead into a lookahead buffer we size ourselves;
- **use every core:** voices are spread over a pool of workers;
- **go wide:** Rust's `core::arch::wasm32` SIMD runs 4 samples per instruction (FFTs, gains, mixing, interpolation, the FDN's Hadamard);
- **absorb spikes:** a big FFT partition landing on one block is averaged out by the lookahead.

## 2. Principles

1. **A twin of Web Audio.** Heart implements the exact node types and AudioParam automation semantics the app uses, per the Web Audio spec. JS code builds Heart graphs with the same calls it uses today (`createGain`, `connect`, `setTargetAtTime`, `.value`, `start`, `stop`). The musical code in piano.js, choir.js and the rest does not change; a module switches engines by asking for a different context. Identical sound comes by construction, not by re-creation.
2. **One law, written once.** Every piece of DSP math lives in Rust exactly once. The main thread's `AudioParam.value` reads come from a shadow instance of the same wasm, never a JS re-implementation.
3. **Null-tested.** Every node type and every automation shape is checked by rendering the same scenario on a native `OfflineAudioContext` and on Heart, then subtracting. The residual must be below -90 dBFS (bit-close math) or, where the browser's behaviour is unspecified (oscillator band-limiting, resampling interpolation), below the bound stated per node in §9.
4. **Islands and a mix.** Audio work is partitioned into islands (one per voice family) that render in parallel, feeding one mix stage that holds the shared buses, rooms and the master. Placement is automatic; the API makes it explicit and simple.
5. **Graceful at every step.** No SharedArrayBuffer: messages carry the audio. No wasm SIMD: Heart stays off and the native engine plays. A family not yet ported: it plays natively beside Heart. Nothing ever goes silent because Heart could not start.
6. **Beautiful code.** Small modules with one job each, prose comments in full sentences in the house style (see piano.js `chainFeed`, core/variance.js), names that say what they hold. No dead code, no clever tricks without a sentence saying why.

---

## 3. Architecture

```
 main thread (page)                       workers                                audio thread
 ──────────────────                       ───────                                ────────────
 piano.js, choir.js, ...                  island worker 1 ─ heart.wasm ─┐
   │  ctxFor('music')                       (music, clouds)             │ egress ring
   ▼                                                                    ▼
 HeartContext (js/heart/heart.js)         island worker 2 ─ heart.wasm ─┤
   nodes.js / params.js  ── commands ──▶    (ambience, genus)           │
   shadow heart.wasm (param .value)                                     ▼
   engine.js  ◀── events (ended, peaks,   mix worker ─ heart.wasm ──▶ final ring ──▶ heart-drain
                port msgs, stats) ──        (shared buses, rooms,                     (AudioWorklet)
                                             master bus)                                  │
                                                                                          ▼
                                                                         native volGain ─▶ destination
```

- **Commands** (create, connect, automate, start, stop, set attribute, processor message) are binary records, batched per microtask and posted to the stage that owns the node.
- **Islands** render ahead independently into their **egress ring**. The **mix worker** waits for block k from every island, renders the mix graph and writes the **final ring**. The **drain** plays the final ring out to the native master, `volGain`, which stays native (the pause gate and transport ramps there are untouched).
- With one or two cores, everything runs in a single worker; cross-stage edges simply do not exist.

### 3.1 File layout and ownership

```
heart/                              Rust crate, built to js/heart/heart.wasm
  Cargo.toml                        [scaffold]
  build.sh                          A1  cargo build + copy, prints size
  protocol.json                     [scaffold] single source of truth for opcodes
  src/lib.rs                        A1  the wasm ABI (§5)
  src/node.rs                       [scaffold] the Node trait every node implements
  src/graph.rs                      A1  node arena, topological order, cycles through delays, render
  src/param.rs                      A1  AudioParam timeline, exact spec semantics (§6)
  src/mixing.rs                     A1  channel up/down-mix rules
  src/protocol.rs                   A1  command decode (uses protocol_gen.rs)
  src/protocol_gen.rs               A1  generated, never hand-edited
  src/events.rs                     A1  the outbound event buffer
  src/buffers.rs                    A1  sample-data pool
  src/rng.rs                        A1  seeded xoshiro128**
  src/simd.rs                       A1  v128 helpers with scalar fallbacks under cfg
  src/nodes/mod.rs                  [scaffold] module list + factory
  src/nodes/gain.rs                 A2
  src/nodes/constant_source.rs      A2
  src/nodes/stereo_panner.rs        A2
  src/nodes/delay.rs                A2
  src/nodes/biquad.rs               A2
  src/nodes/oscillator.rs           A2  + periodic_wave.rs
  src/nodes/buffer_source.rs        A2
  src/nodes/analyser.rs             A2
  src/nodes/convolver.rs            B   non-uniform partitioned FFT (realfft/rustfft)
  src/nodes/fdn.rs                  B   port of js/fdn-worklet.js
  src/nodes/one_pole.rs             B   port of worklet.js 'one-pole'
  src/nodes/strobe_signal.rs        B   port of worklet.js 'strobe-signal'
  src/nodes/genus.rs                B   port of worklet.js 'genus'
  tests/                            A1/A2/B cargo tests on the native target

js/heart/
  protocol-gen.js                   A1  generated encoder, never hand-edited
  engine.js                         C1  startEngine(): pool, rings, drain, time mapping (§7)
  ring.js                           C1  SharedRing (SAB + Atomics) and MessageRing, one interface
  pool.js                           C1  worker pool, stage placement
  render-worker.js                  C1  hosts one heart.wasm stage, keeps its rings full
  drain-worklet.js                  C1  'heart-drain' processor
  buffers.js                        C1  AudioBuffer registry, copies sample data to stages
  heart.js                          C2  HeartContext, islands, OfflineHeartContext
  nodes.js                          C2  node proxies
  params.js                         C2  HeartParam (full AudioParam API, shadow .value)
  route.js                          C2  ctxFor(family), masterFor(family), makeWorklet(), flags

tools/heart-protocol.mjs            A1  generates protocol_gen.rs + protocol-gen.js
tools/serve.mjs                     D   dev server: COOP/COEP, wasm MIME, no-cache code
tools/null-test.html (+ .js)        E   the null-test bench's page (§9)
tools/null-test-scenarios.js        E   its scenarios, renderers and residual math (no DOM)
tools/heart-tests/                  C1, C2, E  the JS tests (§9 says how to run them)
_headers                            D   Cloudflare Pages headers (§11)
js/background.js                    D   iOS lock-screen audio (§10)
js/ticker.js                        D   worker-driven timers for the schedulers (§10)
```

**Ownership is strict.** An agent edits only its own files. Scaffold files are fixed contracts; if one is wrong, say so in the report instead of editing it, unless the brief says otherwise.

---

## 4. Build

- **Toolchain:** Rust stable 1.98 with `wasm32-unknown-unknown`, installed through Homebrew. `export PATH=/opt/homebrew/opt/rustup/bin:$PATH` before cargo.
- **`heart/build.sh`:** `RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown`, then copy `target/wasm32-unknown-unknown/release/heart.wasm` to `js/heart/heart.wasm`. Release profile: `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`. No wasm-bindgen: the ABI is a handful of raw `extern "C"` exports (§5), so there is no JS glue to load.
- **The built `.wasm` is committed.** Deploys and localhost serve it as a plain file; only people changing Rust need cargo.
- **Dependencies:** `realfft` and `rustfft` (the latter's wasm SIMD path) for the convolver's FFTs. Nothing else without a reason in the report.
- **Tests:** `cargo test` on the native target (aarch64-apple-darwin) for all math. The SIMD paths have scalar twins under `cfg(not(target_arch = "wasm32"))`, tested against each other.

---

## 5. The wasm ABI (A1)

One instance per stage. Every function is `#[no_mangle] pub extern "C"`. Pointers are offsets into the instance's memory; JS views them with typed arrays, re-taken after any call that can grow memory.

| Export | Does |
|---|---|
| `heart_init(sample_rate: f32, role: u32, seed: u32) -> u32` | role 0 = combined (islands + mix), 1 = island, 2 = mix, 3 = shadow (param timelines only, no audio). Returns 1 if ready, 0 if refused. |
| `heart_alloc(bytes: u32) -> u32` / `heart_free(ptr: u32, bytes: u32)` | scratch memory for command batches, 8-byte aligned |
| `heart_commands(ptr: u32, len: u32)` | applies a batch of command records (§8), in order |
| `heart_render(frames: u32) -> u32` | renders `frames` (whole quanta, at most 8192) from the current frame. Its return is the new frame count as a u32, which wraps after a day at 48 kHz and reads as a signed i32 in JS after twelve hours: use `heart_frame`. |
| `heart_port_ptr(kind: u32, port: u32) -> u32` | kind 0 = egress (island output port), 1 = ingress (mix input port, keyed `sourceStage·16 + port`), 2 = master. Planar f32, left then right, each the last render's frames long. 0 when no such port exists. |
| `heart_events(ptr_out: u32) -> u32` | writes the address of the events since the last call to `ptr_out` and returns their length; the bytes stay valid until the next call |
| `heart_buffer_alloc(id: u32, channels: u32, frames: u32, sample_rate: f32) -> u32` | reserves planar storage for sample buffer `id` (channel c at ptr + 4·c·frames); JS fills it before its next command batch or render. 0 if refused. |
| `heart_buffer_free(id: u32)` | JS is done with buffer `id`. It goes at once, or, while a node still holds it, when the last holder lets go. |
| `heart_param_value(node: u32, param: u32, frame: f64) -> f32` | shadow role: the param's intrinsic value at a frame, per the timeline (§6). A render stage answers with its last computed value. NaN for an unknown param. |
| `heart_frame() -> f64` | the next frame to render |
| `heart_skip(frames: f64)` | a render stage's present moves on by `frames` (whole quanta) without rendering them, every node keeping its state: what fell due in the gap meets the next frame rendered, as for a node skipped as silent. The rest's wake (§7.2). The shadow ignores it. |
| `heart_now(frame: f64)` | shadow role: the page's present moves up to `frame` (it never goes back). js/heart/heart.js calls it before each batch, so an automation call is anchored at the moment it is made (§6.1). A render stage ignores it. |
| `heart_stats() -> u32` | the address of eight u32 counters: nodes alive; nodes rendered in the last render call (summed over its quanta); nodes skipped as silent in it; nodes cut off in a cycle with no delay at the last order rebuild; command records rejected so far; the first node cut at the last rebuild (0 for none); dropped nodes still sounding out; order rebuilds so far. A shadow fills in its node count and its rejections. |

---

## 6. Semantics to match exactly

Everything here is the Web Audio spec unless it says Chrome. Where the spec leaves a choice to the browser, match Chrome (the bench and most listeners run Chrome) and say so in a comment.

### 6.1 AudioParam timeline (A1, src/param.rs)
- The events are `setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime`, `setTargetAtTime`, `setValueCurveAtTime`, `cancelScheduledValues` and `cancelAndHoldAtTime`, with the spec's exact formulas and ordering rules: insertion order for equal times, how a ramp starts from the previous event, and the hold value computed for `cancelAndHold` mid-ramp, mid-target and mid-curve.
- `setValueCurveAtTime` interpolates linearly between curve points, per the spec's index formula.
- `setTargetAtTime` approaches as `v(t) = target + (v0 − target)·e^(−(t − t0)/τ)`. Chrome snaps to the target once within its threshold; match that.
- Times are f64 seconds, converted to f64 frames. Values are f32.
- The computed value is clamped to [minValue, maxValue] (the nominal range per node param).
- **a-rate:** one value per sample, with a constant fast path when no event lands in the block. **k-rate:** the value at the block's first frame.
- **Audio-rate inputs** connected to a param are summed (down-mixed to mono) and **added** to the intrinsic value, then clamped. The app does this at `rw.gain`, `busD.gain`, `amG.gain`, a strobe stage's `node.gain`, the drone filters' `frequency` and the one-pole `frequency`.
- **`.value` reads** on the main thread return the intrinsic timeline value from the shadow instance at the **present**: the frame a call made now lands on, `Engine.horizon()` (or `currentTime`'s frame where nothing renders ahead, as offline). Chrome answers with what its renderer computed last; Heart answers where its renderer stands, so an anchor taken from `.value` (audio.js `anchorParam`) is exactly the value its gesture starts from. Writing `.value` is `setValueAtTime(v, currentTime)`, as the spec says. `HeartContext.presentTime` is the present in context seconds.
- **A ramp with nothing before it** acts, per the spec, as if `setValueAtTime(currentValue, currentTime)` had been called first, at the time of the call. The wire carries no call time, so each instance anchors it at its own present: the shadow at the present its batch's calls landed on, which it is told before every batch (`heart_now`); a stage at its render head, the earliest frame it can still change.
- **Late gestures move whole** (js/heart/nodes.js, `HeartGraph`, late gestures; decided for wave 3). A stage renders ahead of `currentTime`, and the app's gestures are an anchor at `currentTime` and a short ramp (glideParam, anchorParam, the pause gate, rampVol, holdParam, a room's crossfade). The first call to a param that lands behind the present sets that param's lateness Δ = present − time, and that call and **every later call to the same param in the same task** are moved on by Δ, so `cancelScheduledValues(now)`, `setValueAtTime(v, now)`, `linearRampToValueAtTime(x, now + 0.12)` become the same three events Δ later and keep their shape exactly. Δ is about a lookahead: some 65 ms with SharedArrayBuffer, up to about 130 ms on a message-mode island.
  - A **task** is the run of code up to the next microtask checkpoint (the reach of one command batch). The present is read once per task, so every gesture anchored at `currentTime` in one task (a room's two sides, every source gate at a pause) moves by the same Δ, and the next task reads it afresh.
  - **Untouched:** a call ahead of the present (music planned ahead) unless an earlier call to its owner in the same task was late (a new node's first value is not late, below); attributes and connections (not times; they land at a stage's head); processor messages, whose anchors stay on true time (the strobe's fold, §7.4, is their own answer to the horizon).
  - **A late cancel holds.** `cancelScheduledValues` at the present leaves alone what has already played; moved to the present, it would also take away the rest of a ramp a stage has still to render before then, and the param would step back to where that ramp began. So a late cancel is sent as `cancelAndHoldAtTime` at the moved time: the timeline runs on unchanged up to it, as the native one has already played up to `currentTime`. A cancel ahead of the present stays a cancel.
  - **A new node's first value is not a gesture.** A param's **initial value** is a `setValueAtTime` behind the present (the `.value =` that sets up a fresh gain or a tone's pitch, most often) that is the first call to a param of a node made in the same task. The node has played nothing yet, so it is sent twice: at its own time, which a stage lands on the node's first frame, so the param never sounds its default (a processor, or a gain spliced into a sounding path, would play it), and at the present, where a late gesture after it starts from it. It **sets no Δ**: a later call in the task booked ahead of the present (a pass's fades booked against its start, a line's notes) keeps its true time, as natively. A later call in the task that is itself late makes the param late as any first late call does, except that the gesture is taken to begin at the initial value where that is earlier: Δ = present − min(its time, the initial value's time), so `.value = 0` then a 50 ms ramp from `currentTime` is the same 50 ms ramp from the present, and everything after it in the task moves with it. A call ahead of the present that came before that late one is not moved back. A late call to a param of an older node, `.value =` included, is a gesture and moves whole as above. A ramp booked ahead straight after an initial value (`.value = 0` then a ramp to `currentTime + 2`) runs from the present to its true end, Δ shorter than natively; write a fade meant to move with a source started now as a gesture (setTargetAtTime or a ramp anchored at `currentTime`), or book both ahead.
  - **Sources:** `start` and `stop` are a timeline of their own, moved by the same rule, with the source as the owner. A voice started at `currentTime` wears an envelope anchored at the same moment (clouds.js's cloud, ambience.js's voice, the choir's opening, the bed's first pass), which moves by the same Δ, so it starts exactly where its envelope does; a stop in the same task goes with its start (a take's length and its fade out stay together). A live piano strike at `currentTime` is heard Δ later; notes booked ahead are untouched.
  - The shadow hears the same moved records as the stage, so `.value` stays what plays.

### 6.2 Graph (A1, src/graph.rs)
- Nodes in an arena with stable u32 ids issued by JS. Render order is topological per 128-frame quantum.
- **Cycles** are allowed only through a DelayNode (spec). As in Chrome, the render order is the pull order from the outputs, and the connection that closes a cycle reads what its source gave the quantum before, so a round trip is the cycle's delays plus one quantum (the bench's feedback loop nulls only so). The app's delay feedback loops (`dA → aa → dA` and the cross paths) rely on this; their delays are always over 18 ms.
- **Channel counts:** every node has `channelCount`, `channelCountMode` (max / clamped-max / explicit) and `channelInterpretation` (speakers), with the spec's defaults per type. Up-mix mono→stereo copies, down-mix stereo→mono is ½(L + R). StereoPanner and Convolver are clamped-max 2.
- **Silence:** a node whose inputs are all silent and whose tail has run out outputs silence without rendering (the spec's "actively processing"). Silence is a flag on the bus, set by nodes that know they output zeros (a gain at constant 0 with no automation, a stopped source), and propagated. This is what lets idle convolvers and voices cost nothing.
- **Sources:** `start(when, offset, duration)` and `stop(when)` are sample accurate. A finished source emits an `ended` event and is released when nothing references it.
- **Disconnect:** all the spec's overloads that the app uses: all outputs, to one node, to one param, and by output index.

### 6.3 Node types and their exact behaviour
| Node | Owner | Must match |
|---|---|---|
| Gain | A2 | `out = in · gain` (a-rate) |
| ConstantSource | A2 | `offset` a-rate, start/stop |
| StereoPanner | A2 | the spec's equal-power law, mono and stereo inputs |
| Delay | A2 | Chrome: linear interpolation of fractional delay, `delayTime` a-rate, maxDelayTime buffer |
| BiquadFilter | A2 | lowpass and highpass at least (all eight types is welcome). **Q is in dB for lowpass/highpass**: `α = sin(w0)/(2·10^(Q/20))`. Coefficients per sample while `frequency`/`Q`/`detune`/`gain` vary (automation or audio input), per block when constant. Frequency clamped to [0, Nyquist]. Direct Form I in f64 state, as Chrome does. |
| Oscillator | A2 | sine, triangle, sawtooth and square through **band-limited wavetables, as Chrome's PeriodicWave**: table size and range count by sample rate, partials cut per range so nothing aliases, interpolation between the two nearest tables and within a table as Chrome does. `frequency` and `detune` a-rate. |
| AudioBufferSource | A2 | `playbackRate` and `detune` (k-rate in the spec, applied per block), `loop`, `loopStart`/`loopEnd`, `start(when, offset, duration)`. Chrome's linear interpolation for non-integer rates, the spec's loop wrap rules. |
| Analyser | A2 | passes audio through untouched. Keeps the last `fftSize` mono frames; on request emits the peak \|x\| over them (event `peak`). The app only ever reads peaks. |
| Convolver | B | the spec's normalisation (`normalize = true`): `scale = 1/√(Σx²/(channels·len)) · 10^(−58/20) · 44100/sr`, with the 4-channel halving. Mono input into a 2-channel IR gives L = in∗IR0, R = in∗IR1; stereo input gives L = inL∗IR0, R = inR∗IR1. **Non-uniform partitioned FFT convolution**: zero latency, 128-frame head partitions, sizes doubling through the tail. The tail is the IR's length. |
| FDN | B | port of js/fdn-worklet.js, sample for sample |
| one-pole | B | port of worklet.js 'one-pole', `frequency` a-rate with G exact every 8 samples |
| strobe-signal | B | port of worklet.js 'strobe-signal', including its message `{at, p, r0, r1, dur, wave, duty, on}` and the shared signal math (`core/signal.js` cyclesAt/rateAt/waveShape) |
| genus | B | port of worklet.js 'genus', all 27 params, 3 outputs `[2, 2, 1]`, every port message in and out (peaks, dip, chirp table with ack) |

### 6.4 Randomness
Every random choice inside the DSP (genus partial phases, LPF wander, IR noise if built in Rust) uses `src/rng.rs`, seeded per instance from `heart_init`. The app's musical randomness (which note, which velocity) stays in JS. A null test seeds both sides identically or compares statistics, as §9 says per node.

---

## 7. Transport, time and threads (C1)

### 7.1 The Engine object (js/heart/engine.js)

```js
// Starts Heart on top of a running native AudioContext. Resolves to an
// Engine, or to null when this device cannot run it (no wasm SIMD, worklet
// failed), in which case the caller keeps the native engine.
export async function startEngine(nativeCtx, opts) -> Engine | null
//   opts: { lookahead: seconds, the base (default 0.045 with SAB, 0.09 without;
//                      0.12 and 0.18 on a phone or tablet, §7.3),
//           maxLookahead: seconds (default 0.5), hiddenLookahead: seconds (default 0.3),
//           fullscreenLookahead: seconds (default 0.3),
//           steadySeconds: the calm before each step down (default 30),
//           handheld: boolean (default: detected, §7.3),
//           workers: count (default: clamp(hardwareConcurrency − 2, 1, 4) island
//                    workers + 1 mix worker; 1 combined worker on ≤ 2 cores),
//           wasmUrl }

Engine = {
  mode,                     // 'sab' | 'message'
  sampleRate,
  module,                   // the compiled heart.wasm, so the page's shadow need not compile it again
  output,                   // the 'heart-drain' AudioWorkletNode: connect it to the native master
  stages,                   // [{ id, role, islands: [] }]; stage 0 is the mix (or the combined stage)
  frameAt(ctxTime),         // engine frame (f64) that plays at a native context time
  timeAt(frame),            // the inverse
  renderedUntil(stageId=0), // native ctx time up to which that stage has rendered
  horizon(),                // an engine frame no stage will have rendered past when a batch sent now lands
  stageFor(island),         // places an island on a stage (by weight, stable) and returns the stage id
  weigh(island, w),         // a cost hint for placement (convolver-heavy families weigh more)
  send(stageId, bytes),     // queues a command batch; batches flush once per microtask
  ensureBuffer(id, stageId, audioBuffer?), // uploads sample buffer id to that stage unless it is there
  freeBuffer(id, stageIds?),// frees it there (all stages by default), behind every command already sent
  on(type, fn),             // 'events' (stage, raw event bytes), 'underrun', 'stats', 'error' (stage, message)
  stats(),                  // { underruns, fill, renderMs per stage, lookahead (s), overloaded }
  lookahead(),              // the lookahead now, in seconds (it adapts, §7.3)
  inspect(),                // Promise of each stage's heart_stats counters and memory, by name
  close()
}
```

`OfflineHeartContext` (heart.js) runs the same interface over one combined stage on the page, with `horizon()` the next frame to render, and adds `inspect()` to the context itself.

### 7.2 Time
- The drain posts the native context frame `F` at which it played engine frame 0. From then on, engine frame n plays at native frame n + F, exactly. `frameAt(t) = t·sr − F`.
- An underrun plays zeros for the missing frames and **never shifts the mapping**: late frames are dropped when they arrive. Time stays true, and the strobe and visual sync never drift.
- Commands carry native context times (what the app already computes from `ctx.currentTime`). A param call or a start or stop behind the render horizon moves on by its lateness with the rest of its gesture (§6.1, late gestures); anything else whose frame is already rendered applies at the next frame to render. Scheduled music (the piano plans 1.5 s ahead, the sequencer 0.6 s) stays sample accurate; a slider move is heard about one lookahead later (some 65 ms with SAB at the desktop base, the horizon's chunks included, more while the lookahead has grown).
- **The rest.** While the master is shut (a paused session's tails rung out, js/audio.js) and no hand has moved for 2 s, the page tells the drain to rest: it reads nothing, publishes no new count and rings no bell, but still counts every quantum, so the stages run out of room and sleep and nothing is rendered. A wake (any input, or the master opening) sends every stage a `skip` to a frame four chunks past now, which it reaches with `heart_skip` instead of rendering the gap, and lets the drain go. Every chunk in every ring carries the engine frame it starts at (ring.js, labels), so the drain drops what was rendered before the rest as late and plays the first frame after the jump exactly at its moment, and the mix drops whatever of an island's ring is older than its own frame. The mapping never moves; a dry quantum before the ring is full again is the refill, not an underrun, and teaches the lookahead nothing.
- The adaptive lookahead (§7.3) never touches the mapping. Growing renders further ahead, shrinking renders less far ahead and lets what is buffered play out; nothing is dropped or skipped to change it, and the drain's clock counts every quantum either way.
- `HeartContext.currentTime` is the native `ctx.currentTime`, so every clock bridge in the app (strobe-am's `performance.now` ↔ `currentTime`) stays correct.

### 7.3 Rings
- **SharedRing:** a SPSC ring of planar f32 blocks over a SharedArrayBuffer with Atomics read/write indices (the ringbuf.js pattern). Waiting: the worker waits on the read index with `Atomics.wait`, and the drain notifies after each consumption.
- **MessageRing:** the same interface over a MessageChannel, with chunks of 512 frames sent as transferables and a free-list returned the other way so steady state allocates nothing.
- `crossOriginIsolated` picks the ring: SAB when true, messages otherwise. Both pass the same tests.
- Each island stage has one egress ring carrying all its egress ports (up to 16 stereo ports per stage). The mix stage has one final ring (stereo).
- Worker scheduling: an island renders while its egress ring has room and its frame is below `played + lookahead + lead` (a chunk with SAB; without, it keys on ring room alone); the mix and the combined stage render while their frame is below `played + lookahead`, the mix block k once every island ring holds k. A stage behind (catching up, or overloaded) returns to its event loop every four chunks, on a zero timer, so commands and buffers land meanwhile; in message mode a ring's message only schedules a pump on that timer.

#### Adaptive lookahead
The lookahead is not fixed. It grows when the drain underruns, when the page hides and while it is fullscreen, and eases back after a steady stretch, but never to a size that has underrun this session, live, in both modes.

- **Base, by device.** Desktop: 45 ms with SAB, 90 ms without. A phone or tablet starts with a cushion: 120 ms with SAB, 180 ms without. The signal is a coarse primary pointer (`matchMedia('(pointer: coarse)')`), true of every phone and tablet, iPads included (whose Safari calls itself a Mac), and false of a touchscreen laptop, whose primary pointer is its trackpad; an iOS or Android user agent backs it up. The core count is not used: browsers round or cap it for privacy, and many desktops have few.
- **Grow on underrun.** The first silent quantum of a run grows the lookahead by half again (x1.5), up to the most, 0.5 s. One stall is one run, so one stall grows it once; a later stall that still underruns grows it again. The most is set by the music, not by memory: the sequencer books 0.6 s ahead, and a lookahead past 0.5 s plus the horizon's chunks would land its notes behind the horizon.
- **Grow ahead of trouble.** When the page goes hidden (`visibilitychange`) the lookahead rises at once to the hidden floor, 0.3 s: nothing is interactive then, and that is when the OS slows the workers.
- **Fullscreen holds the hidden cushion in advance.** While the page is fullscreen (`fullscreenchange`, `document.fullscreenElement`) the lookahead rises to the fullscreen floor, 0.3 s, and stays there however long it is calm. A fullscreen window on macOS is a Space of its own, and a swipe hides it with no warning: `visibilitychange` arrives only once it is gone, at the moment Chrome lowers the renderer's thread priority, so the hidden rise is rendered by workers already slowed and the 45 ms cushion runs dry first (the native engine never met this, as it renders on the audio thread, which keeps its priority). Some Chrome versions occlude the window without the event at all. Rendered while the page is still in front, the cushion is there before the swipe. The cost is a slider heard about 0.3 s late while fullscreen. The page also checks visibility and fullscreen on its quarter-second stats tick, in case an event never came.
- **Shrink only to sizes that have held (the ratchet).** After 30 s visible with no underrun it halves, step by step, never below the base, never while hidden, never below the fullscreen floor while fullscreen, and never to a size that has underrun this session. Calm at a grown size proves nothing about a smaller one, so stepping back down would meet the same dropout at the next swipe, for ever. So the first silent quantum of a run marks the cushion the final ring really held when it ran dry as bad, and every size below it with it; the session floor becomes half again the largest bad size (the step growth takes from it), and the lookahead never comes back below it. The size counted is the one the ring was filled to, not one it was rising to: a rise announced but not yet rendered when the ring ran dry blames the old size. An underrun before the stages ever filled the ring (the start) teaches nothing. Coming back visible starts the stretch over. The base is 0.3 s everywhere (the drawer's Audio cushion sets it per machine), so a failure there leaves the session floor near 0.45 s; the ratchet mostly matters when the cushion has been dialled small.
- **Who decides.** The drain: it is the first to know of an underrun and the one thread the browser keeps on time, so a growth does not wait on a busy or throttled page. The page only tells it when it hides or goes fullscreen. The rule costs a few integer comparisons a quantum.
- **Announce, then obey.** A rise is written first to where the lookahead is going (the page's horizon reads this) and a chunk later to what the stages obey, after which the drain rings every stage's bell so a sleeping one wakes and fills the new room. So a command batch already on its way, anchored at a horizon read before the rise, still lands before any stage renders past it. A shrink needs no delay: the horizon takes the stages' heads into account.
- **How the stages hear it.** With SAB, two control-block slots, `LOOKAHEAD` (obeyed) and `LOOKAHEAD_NEXT` (announced), both written only by the drain; every stage reads `LOOKAHEAD` before every chunk. Without, the drain puts the lookahead on every chunk it sends back to the mix, beside the clock (`{ buf, clock, ahead }`), and posts each change to the page for its horizon; islands key on ring room and need no news of it.
- **Ring sizes.** SharedArrayBuffers cannot grow, so the final ring holds the most from the start: 2 channels × 4 bytes × (0.5 s + a chunk) ≈ 196 KB at 48 kHz (388 KB at 96 kHz). A message-mode final ring may make that many chunks, made only as first needed. An egress ring holds what it held before: the desktop SAB base plus two chunks, 32 channels × 4 bytes × 3201 frames ≈ 410 KB an island at 48 kHz, 1.6 MB for four. Sized for the most it would be 3.2 MB an island, 12.8 MB for four, too much for a phone. Past the base an island is held by ring room a little ahead of the mix, which loses nothing: the cushion that covers a stall, whichever stage stalls, is the final ring's.
- **Diagnostics.** `?heartdiag=1` in the address (page only, one boolean when off) logs, each stamped with the page clock and the audio clock: every `visibilitychange` and `fullscreenchange` (and any change the stats tick caught without one) with the fill and lookahead then; every run of underruns as the drain meets it, told from the audio thread (what the ring held, the lookahead, the size it has held, the floor) and when sound returns; every rise and step down; and a heartbeat every 2 s (mode, visibility, fill, lookahead, each stage's ms a chunk against the budget).
- **Stall or overload.** A stall is a stage that renders well inside a chunk's real-time duration (512 frames ≈ 10.7 ms at 48 kHz) yet underruns: the OS parked it, and the cushion fixes it. An overload is a stage whose smoothed render time per chunk is at or above that duration: no cushion can fix it. Each change of lookahead logs one `console.info('[heart] lookahead …')` with the new value, the underrun count, why (underruns or hiding), which of the two it looks like, and each stage's render time against the budget; a stage overloaded for a second running logs one `console.warn('[heart] overload: …')` naming it, then nothing more for 30 s. `Engine.stats()` carries `lookahead` and `overloaded`, and `Engine.lookahead()` the lookahead now.

### 7.4 Placement
- An island is a named group of nodes (`'music'`, `'drone'`, `'arp'`, `'choir'`, `'clouds'`, `'ambience'`, `'genus'`). Its nodes all live on one stage. Shared buses live in the **mix**.
- Placement is greedy by weight hint (convolvers count heavy), stable for the session.
- **Cross edges** only go island → mix, into a node's input (never into a param). C2's facade turns each one into an egress port in the island and an ingress port in the mix. An edge mix → island is an error with a clear message.
- **Replicable nodes** (strobe-signal) are created once per stage that uses them, and every command for them is sent to every replica. They are deterministic functions of their messages and the frame clock, so the replicas agree exactly, provided a message lands on the same frame on each: a message whose anchor is still ahead of a stage waits for it, one whose anchor has passed lands at the stage's head. So on an engine of more than one stage, nodes.js folds each strobe message forward to `Engine.horizon()`: the same formula, written from a later point on it (`at' = at + Δ`, `p' = p + cycles(Δ) mod 1`, `r0' = rate(Δ)`, what is left of the ramp). Every replica, made now or later, hears the folded numbers. The cost is that a change of the strobe's formula is heard up to a lookahead and two chunks later than it would be on one stage.

### 7.5 The drain (js/heart/drain-worklet.js)
- `heart-drain`: 0 inputs, 1 output of 2 channels. It copies the final ring into its output and nothing else, so it can never be the slow part.
- It posts `F` once, and on underrun increments a shared counter (or posts, in message mode).
- `Atomics.notify` on the read index after each block, so a waiting worker wakes.
- It looks at the ring once per quantum: late frames are dropped, and the quantum plays only if a whole quantum is waiting behind them in that same look. A second look could find a chunk a stage committed in between and play it late, a shift of the mapping.
- It steers the lookahead (§7.3, adaptive lookahead) and rings every stage's bell when a rise takes effect. No allocation: it posts only on a change, from one reused object.

---

## 8. Commands and events

`heart/protocol.json` is the single source of truth. `tools/heart-protocol.mjs` generates the Rust decoder table (`src/protocol_gen.rs`) and the JS encoder (`js/heart/protocol-gen.js`). Records are little-endian: `u16 op, u16 byteLength, u32 node`, then the op's fields as listed in the JSON, f64 for times, f32 for values. Batches are concatenated records.

Events back (the same JSON, `events` section): `ended(node)`, `peak(node, value)`, `port(node, bytes)` for processor messages (genus peaks, dip, chirpAck), `stats(frame, renderMicros)` (reserved; nothing sends it yet), and `log(node, code, value)`, the stage telling the page something it should know, which nodes.js says with `console.warn`. Its one code so far is `cycle_cut`: at a change of connections, `value` nodes sat in a cycle with no DelayNode and play silence, the first of them `node`; it is sent when that changes, and once more with value 0 when the cycle is gone.

A record's length is a u16, so one record is at most 65,535 bytes: a curve of about 16,370 values, a processor message of about 65,520 bytes. The app's curves and chirp tables fit with room to spare; a stage drops an event that would not fit rather than send one whose length lies.

---

## 9. Null tests (E, wave 2)

`tools/null-test.html` runs every scenario twice: once on a native `OfflineAudioContext`, once on an `OfflineHeartContext` (HeartContext rendering synchronously on the page's own heart.wasm, role combined). A scenario is just `(ctx) => { build a graph; schedule automation }`, the same function for both, which is the twin design paying off. It shows the residual (peak and RMS dBFS) per scenario, with a pass mark:

| Node / automation | Pass |
|---|---|
| Gain, ConstantSource, StereoPanner, every automation shape | below −90 dBFS |
| BiquadFilter (constant and automated), Delay | below −80 dBFS |
| Oscillator sine/tri/saw/square | below −60 dBFS (band-limiting is browser-specific) |
| AudioBufferSource at non-integer rates, looping | below −60 dBFS |
| Convolver (same IR buffer on both sides) | below −80 dBFS |
| one-pole, strobe-signal, genus, FDN (Heart vs the JS worklets on a native context) | below −90 dBFS with matched seeds |
| Whole families (piano gesture, sequencer bar, drone minute) | listening test plus below −50 dBFS where seeds match |

It runs in the browser when Robert opens it. Agents do not drive a browser.

### 9.1 The bench as built

- **Open it:** `node tools/serve.mjs`, then http://localhost:8000/tools/null-test.html. "Run all" renders every scenario at 48 kHz and 44.1 kHz (either can be unticked); clicking a scenario runs it alone. Each row shows PASS or FAIL against its mark, the residual's peak and RMS in dBFS, and a trace of the residual scaled to its own peak. A command Heart refused shows under the row and fails it.
- **Scenarios** (tools/null-test-scenarios.js): every automation shape on a ConstantSource into a Gain (a ramp with nothing before it, steps, linear, exponential, setTarget, a curve, the `.value` setter, a ramp after setTarget, an exponential ramp across zero, cancel, cancelAndHold mid linear, mid exponential, mid setTarget and mid curve, and an a-rate offset with start and stop between samples); audio into a gain, a pan (clamped) and a biquad frequency; StereoPanner mono and stereo, still and moving; Delay fixed between samples, moving, and in a feedback loop; BiquadFilter, all eight types still, and lowpass, peaking and bandpass automated; Oscillator, the four types at 55, 440 and 3520 Hz, a sawtooth sweep and a detune sweep; AudioBufferSource at rate 1, 0.5 and 1.37, automated with detune, looping with loopStart and loopEnd, looping at 1.37, with offset and duration, and started between samples; Convolver with a mono and a stereo impulse, mono and stereo input, normalised and not; and the app's processors, genus (the tone free and gliding, the pips and their send, the pips dipping and bilateral, linked to the flash with a ramping rate, a chirp table), one-pole (still, sweeping, and driven by a source as the drone drives it), strobe-signal (at rest, square, a ramping sine, triangle) and fdn-reverb (defaults, short and dark, a moving decay).
- **Genus's randomness:** its harmonics' pan and shimmer and the pips' lowpass wander draw from `Math.random` in the worklet, which the bench cannot seed, so the genus scenarios keep the harmonics and the sweep off. Every path they test is deterministic.
- **The least certain Chrome choice** is A2's sub-sample shift for a buffer source started between samples (the marked line in buffer_source.rs). Its scenario says so on the page: a residual far above −60 dB means Chrome does not shift, and that line goes.
- **In node,** without a browser: `tools/heart-tests/bench.test.mjs` renders every scenario on Heart at both rates (no throw, no refused command, no cut cycle, finite and not silent), and `tools/heart-tests/worklets-null.test.mjs` null-tests the four processors against js/worklet.js and js/fdn-worklet.js themselves, run a quantum at a time under a stand-in AudioWorklet scope. All of those are bit-exact (residual −∞) at both rates.

### 9.2 Running the tests

```
heart/build.sh                                   # the wasm; clean, and js/heart/heart.wasm is current
(cd heart && cargo test)                         # the Rust
node --expose-gc --test tools/heart-tests/*.test.mjs tools/heart-tests/c2-*.mjs
```

`e2e.test.mjs` is the whole engine end to end on the real heart.wasm: the twin API on the real transport (render workers in worker_threads, the drain on a fake audio thread), in SharedArrayBuffer and message mode, with one combined worker and with a mix and two islands. It checks exact output for a constant through a gain and a buffer source, an island chain (oscillator, biquad, panner) against the same graph rendered offline, a convolver room fed from an island and its impulse replaced, one strobe signal on two islands agreeing to the bit, genus playing with its peaks and chirp acknowledgement, an analyser's peak, the shadow's values, ports opening and closing, buffers and dropped nodes freed, no command refused and no cycle cut on any stage, and route.js's flag and its fallback when a stage dies.

---

## 10. Platform work (D)

- **iOS lock screen:** `navigator.audioSession.type = 'playback'` before the AudioContext is created (where supported); a silent looping `<audio>` element (a 1 s digital-silence WAV made at runtime as a blob URL, never muted) started inside the same gesture that starts the sound and paused with the transport; Media Session metadata (title, play/pause wired to the transport). All in `js/background.js`, called from `warmDevice`/`audioOn`/`applyAudioGain`.
- **Worker ticker:** the schedulers (piano `step` 250 ms, arp pump 200 ms, clouds `step` 700 ms, choir wander 100 ms, bed pump 10 s, sweeps 1 s, strobe-am track 200 ms) run from `js/ticker.js`: `every(ms, fn)` and `after(ms, fn)` backed by a tiny worker's timers, which browsers throttle far less in the background. The same callbacks, a different clock.
- **Dev server:** `node tools/serve.mjs [port]` serves the repo with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, the right MIME for `.wasm`, `.mjs` and `.opus`, and `Cache-Control: no-store` so localhost is always fresh. `python3 -m http.server` keeps working (Heart then runs in message mode).

## 11. Hosting (D prepares; DNS is Robert's)

- Cloudflare Pages, built from the GitHub repo, no build command, output directory the repo root.
- `_headers`: the three isolation headers on every path. Long caching (`public, max-age=31536000, immutable`) **only** for files that never change in place: `/audio/*`. Code, HTML, worklets and `heart.wasm`: `public, max-age=0, must-revalidate`, so a push is live for returning visitors at once.
- The custom domain (presence.now.audio) is attached by Robert. Nothing in this build points DNS anywhere.

---

## 12. Migration (wave 3)

A **family** moves as a whole, because its nodes connect to each other:

| Family | Modules | Ends at |
|---|---|---|
| music | piano.js (notes, drone, sequencer, shared room, FDN), choir.js, layers.js, the strobe-AM stages they use | `masterFor('music')` |
| clouds | clouds.js | `masterFor('clouds')` |
| ambience | ambience.js | `masterFor('ambience')` |
| genus | audio.js's genus node, harmonics room, click room | `masterFor('genus')` |

- **The hook is in.** js/audio.js `ensureAudioGraph` awaits `startHeart(audioCtx, volGain)` once the worklet modules are added. route.js imports nothing; with no family flagged it loads no Heart code and returns null, and the app is exactly as it was.
- `js/heart/route.js` exports `ctxFor(family)` (the HeartContext, or the native context when Heart is off for that family), `masterFor(family)` (Heart's master bus, or the native `volGain`) and `makeWorklet(ctx, name, opts)` (a Heart processor or a native `AudioWorkletNode`). A module replaces `getContext()`/`getMaster()`/`new AudioWorkletNode` with these three and changes nothing else.
- `meterTap`/`tapPeak` (js/util.js) prefer an analyser's `peak()` when it has one.
- `decodeAudioData` stays native; a native AudioBuffer handed to a Heart node is registered and uploaded on first use.
- **Flag:** `localStorage.signal_heart`: absent or `'off'` = native; `'all'`; or a comma list of families (`'music,clouds'`). Also `?heart=` in the URL, which overrides. Default stays native until each family passes its null tests and Robert's ears.
- Order: genus (self-contained, our own code already), clouds, ambience, then music.
- **If the engine fails after starting** (a stage's worker dies, the drain stops), route.js sends every family not yet handed its context native, and leaves the ones already built on Heart where they are, since their nodes live in the stages and their module holds them; the console says which. A family that wants to survive that has to rebuild its own graph on `ctxFor` again.
- **Dropping is releasing.** A Heart node is freed when the page lets go of its proxy (a FinalizationRegistry sends `destroy`) and the stage then frees it as a browser collects one: once nothing feeds it and its tail has rung out, a source once it has ended. A dropped chain goes whole. Nothing calls `destroy` by hand.
- **Buffers are released** when the page lets go of an AudioBuffer, and a convolver handed a new impulse frees the old one on its stages at once, so a room rebuilding its impulse for every decay does not grow a stage's memory.
- **The offline context** is made with `await OfflineHeartContext.create(...)`, which resolves once its wasm is in; its params can be read only then.
- **Cross edges** go island → mix, into a node's input, never into a param and never mix → island; nodes.js throws with a clear message otherwise. A family keeps everything that feeds a param in its own island.
- **strobe-am.js keeps one strobe-signal node per context** (a Map from context to node). A Heart context's node is made with route.js `makeWorklet(ctx, 'strobe-signal', ...)`, every post of the formula goes to every node, native and Heart (nodes.js folds and replicates it across stages), and `strobeAm`/`strobeTap`/`untapStrobe` take the family's context, so a Heart family's stages and the arp's tap are wired to its own node. The clock estimate stays the native context's, which every Heart context reads.
- **Rooms on Heart.** audio.js `swapRoom` takes the preset's transition window for a Heart room too (`room.ctx.isHeart`), since `glideEnd()` is a time on the native clock Heart contexts share. `roomPlace` keeps a crossfade's end as the time it is heard (`ctx.presentTime ?? currentTime`) and waits for the clock to pass it before touching the side it faded out, since an impulse handed to a convolver lands at a stage's head, ahead of the moved fade. Natively the two times are one and nothing changes.
- **Gestures anchored at `currentTime`** move whole on Heart (§6.1, late gestures): a family's glides, anchors, gates and crossfades keep their shapes and are heard about a lookahead late; scheduled music and the strobe's anchors stay on true time. What a family still has to check in its own code:
  - **Timers that wait for a gesture to finish** (a `setTimeout` that disconnects or stops after a fade) must allow the shift: read the end from `ctx.presentTime` rather than `currentTime`, or keep a margin above a lookahead (the choir's teardown has 0.2 s, ambience's `fadeOut` 2 s; the rooms read `presentTime`).
  - **A fade on one node and a stop on another**, with the stop at `currentTime + d` for a small d (piano.js `lineMorph`'s second oscillator, a 30 ms target and a stop at +0.25 s): the fade moves, the stop, ahead of the present, does not, so the fade gets d − Δ instead of d. Fine above a few time constants past the lookahead; shorter ones need the stop anchored later.
  - **Gestures split across an `await`** are two tasks, each with its own Δ.

## 13. Waves

1. **Wave 1, in parallel:** A1 Rust core, A2 standard nodes, B special nodes, C1 transport, C2 twin API, D platform.
2. **Wave 2:** E integration (build, wire, fix seams) and the null-test bench.
3. **Wave 3, in parallel:** the four families behind the flag.
4. **Then:** Robert's ears, the phone, Render Capacity, and turning the flag on family by family. Shared reverb buses (known-ussues.md, reverb-load) become a mix-stage feature after that.
