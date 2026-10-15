# Render ahead on idle

Handoff document, 2026-10-15. The feature is **HALF-BUILT and gated off**
(`IDLE_AHEAD_BUILT = false` in `js/idle-ahead.js`); nothing it adds changes
what the live site does. Read this whole file, then ARCHITECTURE.md and
documents/heart-audio-engine.md §7, before writing code.

---

## 1. The job (why)

A phone playing The Signal with its screen off drains its battery about four
times faster than it should. The cost is not DSP volume; it is **wake
cadence**. Every wake keeps the SoC out of deep idle:

- Each Heart render worker wakes every ~11 ms to top its ring up by one chunk
  (`js/heart/render-worker.js`, `wakeAt` asks to be woken as soon as there is
  room for one more 512-frame chunk).
- The JS sound planners tick on 100 to 250 ms timers (`js/ticker.js`: choir
  wander 100 ms, tone breath 100 ms, bed volume 100 ms, ambience reverb
  breath 100 ms, strobe-am track 200 ms, arp pump 200 ms, piano step 250 ms,
  room breath 250 ms, clouds 700 ms, sweeps, bed pump 10 s).
- Together that is on the order of 500 wakes a second.

The fix: render far ahead in big gulps and let the cores sleep for seconds at
a time. To render ahead you must first **plan** ahead, so the planners are
walked forward on a virtual clock before the engine is allowed to render that
far.

## 2. The design (agreed with Robert)

### 2.1 The setting

"Render ahead on idle" in the drawer's Render section, Audio engine
sub-drawer, beside Audio cushion and Cushion growth. id `heartIdleAheadS`,
0.5 to 10 s, step 0.5, default 10. It is the **ceiling for both modes**
below.

- Sliders define one formatter, `formatAt(pos)`, never `format(S)`.
- It is a machine setting: section `'render'` makes `core/presets.js
  machineControl` skip it in presets, journeys and broadcast; its field is in
  `core/store.js MACHINE_KEYS`, so snapshots (preset recall, a followed
  broadcast) leave it alone. Both are the existing mechanisms; nothing
  parallel is added.
- Persisted through the normal store path like its siblings (the settings
  object in `buildSettings`, clamped on load).

### 2.2 Hidden mode

When the page is hidden (phone screen off, tab behind another), there is no
ramp: the cushion goes straight to the setting.

1. Walk the planners ahead (2.4) to the new frontier.
2. Only then raise the lookahead to the setting and let the engine render.
3. Gulp refill: the stages sleep until the cushion is half spent, then render
   until it is full.

### 2.3 Visible mode: an intent ramp

- Growth begins **5 minutes** after the last audio-parameter touch. A touch
  is a user-level settings write, a journey step, the transport, or an
  incoming broadcast or cross-tab change. Each one resets this clock.
- From then on the cushion is 1 s, growing **+1 s every 2 minutes** up to the
  setting, as long as the pointer is not moving.
- **Pointer movement anywhere caps it at 5 s, by DRAINING, never by
  splicing.** Stop refilling (and pause the walk) until the played cushion
  falls to the cap, then resume gulps at the capped size. Movement is
  frequent, so it must never cause an audible splice. While the pointer
  keeps moving, growth holds at 5 s; when it stops, growth resumes on the
  2-minute cadence toward the setting.
- **A hand over an audio drawer section forward-skips to the base cushion at
  once.** The audio sections are the Low Audio Tone, music, choir, clouds,
  ambience, reverb and Live Sound, the sections whose controls write audio
  params. Derive the set from the schema sections, don't hardcode labels.
  This is declared intent: instant control readiness is worth the small
  splice.
- **Any actual audio input forward-skips to the base cushion and restarts
  the 5-minute clock.** That covers a settings write, the transport or
  pause, a journey step, and a broadcast or cross-tab change.

### 2.4 The planner walk

Every sound planner schedules through `js/ticker.js` (`every`/`after`, backed
by `js/ticker-worker.js` so hidden-page throttling does not apply). Each
planner is deterministic given its clock reading, the settings, and its own
rng and cursors.

- `walk(toMs)` is a discrete-event simulation over the ticker's timers Map.
  Take the held timer with the earliest due time, set the virtual "now" to
  it, fire it, and reschedule it (`every`: due += ms; `after`: delete). A
  timer made inside the walk is due at virtual now + ms and joins the walk.
  Repeat until nothing is due at or before `toMs`.
- Ties fire in the order the timers were made.
- `hold()`: the planners' backing timers stop firing on the real clock; their
  due times are kept. `release()` re-arms each for its post-walk due time,
  so cadence is seamless when the hold ends. `shift(ms)` pulls every due
  time (and the frontier) earlier after a forward skip.
- Some timers must never be walked and keep the real clock: the rest check
  (`js/audio.js restCheck`) and the idle driver itself. They take
  `{ real: true }`.
- While a walked timer runs, the Heart clock reads the virtual time (2.6).
  Outside a walk it reads the heard-now. **This matters:** the Heartbeat
  layer's visuals read `ctx.currentTime` of a Heart context as "what is heard
  now" (`core/heartbeat.js heartRead`), so a standing planning offset would
  desync them.
- Walked ticks must not have non-audio side effects that misbehave when fired
  a hundred times in a burst. The audit (section 3) lists what was found.

### 2.5 The ordering guarantee (pause must not lag)

A pause, a space, a tap or a settings write issues gain ramps anchored at
"now". With a grown cushion those land behind the render frontier: they are
late gestures, moved whole to the horizon, so they would be heard up to N
seconds late.

- **The audible part of a pause is Heart's**: `js/audio.js setSources` closes
  the source gates (Heart params) and keeps the native master open while the
  rooms ring out. So the pause's fade really would lag.
- Therefore every input path that writes audio, the transport included, must
  trigger the forward skip **before** its commands are issued, in the same
  task.
- The skip and the commands after it must reach the stages in order, so the
  fade lands at the base horizon. That is the same latency as with idle off,
  about one base lookahead plus a chunk.
- It needs a test (section 5): grow, then pause or write a setting in the
  same task as the skip, and check the gate command's landing frame is at or
  just after the skip target, never at the stale frontier. Also check a
  settings write that arrives mid-gulp.

### 2.6 Time: what the virtual clock may and may not touch

- **The drain's clock and the time map are never touched by the virtual
  clock.** The walk is planning-only.
- How the forward skip actually works: the existing `skip` message (the
  rest's wake) cannot do it. A stage can only skip forward, and the stages
  are already about N seconds ahead. The mechanism (design worked out, not
  coded yet):
  - The page reads PLAYED and the mix's head H. The jump is
    Δ = H − played − base, rounded down to whole quanta, and skipped
    entirely when it is small (under about 0.25 s).
  - The page posts `{ type: 'jump', quanta }` to the drain. On its next
    quantum the drain:
    - reads ~1024 frames of the old continuation from the ring into a
      preallocated scratch buffer, for the crossfade;
    - adds Δ to `played` and publishes PLAYED;
    - drops the old frames as late through the existing labels and debt
      (`align()`);
    - plays the new frames with an equal-power crossfade from the old
      continuation;
    - leaves idle (`setIdle(0)`) and acks `{ type: 'jumped' }`.
  - **Heart time = native `currentTime` + D.** D (the engine's "lead") grows
    by Δ at each skip and never shrinks. The page adds Δ to D synchronously,
    before the drain has jumped.
  - The map from Heart time to engine frames never moves, so everything
    already planned keeps its place and the piece is simply Δ further on.
  - Between the page's skip and the drain's ack, the page freezes the render
    LIMIT (2.7) at H. Commands issued in the same task as the skip therefore
    late-shift to H + chunk, the fresh horizon. That is the ordering
    guarantee.
  - The page also calls `ticker.shift(Δ)`.
- Anything that bridges the native or visual clock into Heart must add D
  (not the walk offset):
  - `js/strobe-am.js postSignal`: its `at` comes from a
    `performance.now()` ↔ native-currentTime bridge and goes to Heart
    strobe-signal and genus nodes. Add D for nodes on a Heart context only.
  - The sequencer playhead (`js/piano.js seqClock`).
  - The strobe-to-audio formula is otherwise a formula of engine time
    (core/signal.js), so it survives a skip once its anchor carries D.
- `HeartGraph.frame(t)` must keep clamping `t` up to the **native** clock,
  not Heart time. Clamped to Heart time, a native-anchored ramp's start and
  end would both clamp to the same frame and collapse into a step (a click).
  Clamped to native, the late-gesture machinery moves the whole gesture to
  the horizon with its shape intact.
- Only code that runs inside walked ticks needs Heart planning time.
  Gestures can stay on the native clock.

### 2.7 Engine side

- **Planning leads rendering by construction.** Add a page-written `LIMIT`
  slot to the control block (`js/heart/ring.js`): an absolute frame in
  quanta, −1 for none.
  - After each walk, once the walk's commands have been posted (a microtask
    queued after the walk), the page writes LIMIT = frontier − margin and
    rings every stage's bell.
  - Stages render while `frame + chunk ≤ min(played + lookahead, LIMIT)`
    (islands a chunk further).
  - `Engine.horizon()` takes the same min, so a walk's commands (all at
    virtual times past the old frontier) are never late.
  - Gulp size equals the walk step. With the driver walking every
    cushion/2, the cushion swings between N/2 and N.
- The drain's idle lookahead = setting + 0.5 s slack, so the LIMIT, not the
  clock, is what holds the stages; they sleep on their bell between gulps.
- `render-worker.js wakeAt`:
  - When the LIMIT binds, return −1 (wait for the bell).
  - When the clock binds while idle (draining to a lower cap), wake when half
    the lookahead has played, not per chunk.
  - In idle, the `Atomics.waitAsync` safety timeout must be long (about 2 s,
    not 250 ms), or the 250 ms safety wakes defeat the point.
  - When visible at base, keep today's per-chunk behaviour.
- Count wakes per stage (a WAKES slot per stage in the control block),
  counted when a sleep returns, for `?heartdiag=1` and for the cadence test.
- **SharedArrayBuffer mode only.** Message mode (no SAB) keeps today's
  behaviour: its workers wake on every returned chunk anyway. Production is
  cross-origin isolated.
- Islands' egress rings stay sized for the base lookahead. The extra cushion
  lives in the final ring (2 channels).
- **Ring sizing choice:** size the final ring at engine start for the
  slider's top plus slack (11 s + a chunk). That is ~4.2 MB at 48 kHz and
  ~8.4 MB at 96 kHz, SAB pages committed lazily. A change of the setting
  then applies live, with no resize.
- **The ratchet must not mislearn.** While the idle lift is in force:
  - `floor()` includes it, so the 30 s steady step-down never shrinks it.
  - `raise()` clamps to max(policy.max, idle), not policy.max.
  - An underrun is counted and logged, but not learned from and not grown
    on. Learning there would set `bad` to ~10 s: `learned` caps at
    policy.max, and the ratchet would never learn again this session (held
    never exceeds `bad`). It would also pin the visible floor at the max.
  - `held` is not updated during idle anyway (the ring never holds the
    target plus slack).

### 2.8 Gates

- Heart is the engine, on shared memory (`?heart=off` or a native fallback
  keeps today's behaviour; native is not extended in v1).
- The engine is not resting. The rest wins: a paused session with the master
  shut needs nothing.
- The session is running with sound on.
- Live Sound is not capturing (a microphone cannot be pre-rendered).
  `js/livesound.js` `cap`/`busy`; while it runs, idle is off and the cushion
  stays at the old hidden floor (0.3 s).
- An incoming broadcast (`?follow=`) or cross-tab change is an audio touch:
  forward skip + reset, before applying.

---

## 3. What's done

All committed on sun-layer and main. Everything below is inert until
`IDLE_AHEAD_BUILT` is true.

| file | state |
|---|---|
| `js/idle-ahead.js` | **HALF-BUILT, gated off.** The controller, written in full to the design above: the visible ramp (5 min, +1 s / 2 min, 5 s move cap by draining), hidden mode, the driver (one `{ real: true }` ticker timer at cushion/2), the walk-then-limit ordering, `idleTouch` (skip + reset, re-grow after 1 s when hidden), `idleIntent`, `idleMove`, `idleRefresh`, `startIdleAhead`, `setLiveCapturing`, `?heartdiag=1` lines. It calls ticker and engine functions that do not exist yet (`ticker.hold/walk/release/shift`, `Engine.setIdle/skipAhead/heardNow/lead`). `IDLE_AHEAD_BUILT = false` makes every entry return at once, and the ticker is imported as a namespace so the missing names cannot break module loading. |
| `js/ticker-worker.js` | Done, backward compatible. Accepts `[op, id, ms, first, gen]`: a repeating timer can take its first tick after `first` ms, and replies `[id, gen]` when a generation is sent, else the bare id that today's `js/ticker.js` expects. |
| `js/ticker.js` | **Not started.** Needs the walk (section 4, step 1). |
| `core/store.js` | Done: `heartIdleAheadS` in the settings object, `MACHINE_KEYS` and the load clamp; `save()` calls `idleTouch('a setting')` as the backstop (before the remote-apply early return, so other tabs' and broadcasts' writes count); `saveAuto()` for saves that are not touches; `settingsKey(key)`. |
| `core/atmosphere.js` | Done: the drift's saves use `saveAuto()`, so an unattended drift is not an audio touch. |
| `core/schema-visual.js` | Done, hidden: the "Render ahead on idle" row (0.5 to 10 s, step 0.5, def 10, `formatAt`), `visible: () => IDLE_AHEAD_BUILT`. Its set calls `idleRefresh()`. |
| `core/journey.js` | Done: `applyStep` calls `idleTouch('a journey step')` before any of the step's commands. |
| `core/broadcast.js` | Done: `applyFollowed` calls `idleTouch` first. |
| `platform/show-remote.js` | Done: `idleTouch` before each remote action. |
| `core/audio-shell.js` | Done (worker mode's page): `set` (when the value differs) and `run` call `idleTouch` first; a settings record calls it before `syncFromStorage`. |
| `tools/heart-tests/ticker-walk.test.mjs` | Written, **skips** until `js/ticker.js` has the walk. It is the spec: due-order firing at virtual times, ties in creation order, timers made and cleared mid-walk, real timers untouched, release re-arming at post-walk dues, shift. |
| `tools/heart-tests/run-each.sh` | New: runs the Heart tests one file at a time under a perl-alarm time limit (macOS has no `timeout`), logs to the git-ignored `tools/heart-tests/logs/`. |
| `.gitignore` | Ignores those logs. |

### 3.1 The planner clock audit (findings)

Ticker timers (walked), and what each needs once Heart time is virtual inside
a walk:

| site | clock it reads | verdict |
|---|---|---|
| `js/piano.js step` (after 250) | `famCtx()` currentTime and presentTime (Heart) | fine as is |
| `js/piano.js arpPump` (after 200) | `famCtx()` (Heart) | fine; but see `seqClock` below |
| `js/piano.js bedPump` (every 10000) | `getContext()` = the **native** context, against the Heart cursor `bedNextAt` | **fix**: use `famCtx()`. After a skip (D > 0) the native clock is D behind the cursor and the bed would stop being booked. |
| `js/piano.js bedVolTick` (every 100), `applyBedVol`, `bedOn` (line ~786) | `getContext().currentTime` (native) | **fix**: the family's Heart clock |
| `js/piano.js seqClock` | native clock against Heart-time marks; `MARKS = 32` | **fix**: family clock; MARKS to ~512 (a 10 s walk of a fast arp books far more than 32 steps ahead) |
| `js/choir.js wanderTick` (every 100), `applyChoirTargets`, `applyChoir`, `applyChoirVol` | `getContext().currentTime` (native) | **fix**: the choir's Heart context |
| `js/clouds.js step` (after 700) | its own Heart context | fine |
| `js/room.js` every(250) `revBreathe(ctx.currentTime)` | the room's Heart context | fine; the convolution reverb-time breath goes through `swapRoom` on a native 200 ms setTimeout, so it is not walked: during idle the room's reverb-time breathing is applied late in real time. An accepted approximation (slow breathing, heavy swaps) |
| `js/ambience.js revBreathe` (every 100) | `outCtx` (Heart) | fine once `glideParam` is param-aware |
| `js/audio.js toneBreathTick` (every 100) | `audioCtx` (native) through `rampLevel`/`setParam` | **fix**: genus clock (`node.context.currentTime`) and param-aware anchors. Otherwise every walked tick collapses onto the horizon and the breath is lost. |
| `js/audio.js restCheck` (after) | native | **must be `{ real: true }`**, never walked |
| `js/strobe-am.js track` (every 200) | native bridge (right for the bridge); `applyDepth` wander at native time | **fix**: wander at Heart time; `postSignal`'s `at` + D for Heart nodes |
| `js/sweep.js tick` (every CADENCE) | its context's `presentTime ?? currentTime` (Heart) | fine |

Not on the ticker, so not walked:

- `core/atmosphere.js` drift: rAF at ~5 Hz, visible only. Its fades are
  gestures on the native clock and late-shift to the horizon.
- `js/ambience.js` layer glides (`advanceGlide`, `syncAmbLayers`,
  `applyAmbVol`, `fadeAmbIn`): native clock. They are gestures, fine;
  after a skip the mixer faders' shown level is D off (cosmetic).
- `core/heartbeat.js`, `core/sun-hum.js`, `js/layers.js`: Heart context,
  fine.
- `route.js tellPeriods`: setInterval, not planning.

Shared helper that needs changing:

- `js/audio.js glideParam`, `anchorParam`, `rampLevel`, `fadeToneIn`,
  `setSources` anchor on `audioCtx.currentTime`. Make them **param-aware**:
  a HeartParam (`prm._node.context.isHeart`) takes its context's clock, a
  native param the native one.
- Convert the glide window `glideT1` (native) by the same offset.
- Every walked tick that calls `glideParam` (choir, room, ambience,
  strobe-am, piano) is then right.

Mixed native/Heart waits (minor, fix while there):

- `js/piano.js` ~900 and `js/room.js` ~236 compute `glideEnd() −
  ctx.currentTime` with a native `glideEnd` and a Heart `ctx`. After a skip
  the wait is short by D.

Cosmetic, to note in the final report:

- Meter taps (analysers, genus peaks) are rendered at the frontier, so the
  drawer's meters read ahead while the cushion is grown.
- The strobe-audio link and the words read the time formula, not taps, so
  they stay true once `postSignal` carries D.
- Worker mode: the atmosphere drift's records come back to the page through
  `replayLive`, whose `set()`s call `save()`, so there a drift landing
  counts as a touch. Accepted; main mode is the default.

### 3.2 What was and was not verified

Run and seen to pass, on this commit's tree:

- The ESM check (each changed `.js` copied to `.mjs`, `node --check`) on
  every file in the table above, and `ticker-walk.test.mjs`.
- `js/idle-ahead.js` loads in node, and its entries are no-ops while gated.
- `node tools/journey-sim.test.mjs "$PWD"`: all passed (it loads store,
  journey, schema and so idle-ahead).
- The ticker worker answers today's ticker.js message format with bare ids,
  repeating and one-shot, and a clear stops the ticks (simulated in node).

NOT seen to finish on the changed tree (abandoned at handoff; the next agent
runs them):

- The Heart suite file by file after these changes. The run reached
  `drain.test.mjs`, all passing up to there; e2e, the family tests, pool,
  ring, stall-workers, strobe-am, transport and worklets-null were not seen.
  These changes touch nothing under `js/heart/`.
- The pause-ordering test and the wake-cadence measurement, which do not
  exist yet (section 4, step 13).

Code that runs on the live site now:

- The ticker worker rewrite (verified compatible, above).
- `store.save()`'s `idleTouch` call and the other `idleTouch` hooks: one
  boolean test while `IDLE_AHEAD_BUILT` is false.
- `saveAuto()` in the drift.
- `settingsKey()` in the engine-thread shell.

Everything else is unreachable until the flag is flipped.

### 3.3 Test baseline (before any change)

`tools/heart-tests/run-each.sh 240`: every file passes except two that time
out, because node does not exit after every subtest has passed (lingering
handles):

- `e2e.test.mjs`: 41 ✔, 0 ✖.
- `family-music.test.mjs`.

Judge those two by the ✔/✖ lines in their logs. family-ambience passed (6
s) in this run, so the hang note in memory now points at these two.

## 4. What remains (in order)

1. **`js/ticker.js` walk.**
   - `every/after(ms, fn, { real })`.
   - Per-timer `due` and `gen`. Posts `[op, id, ms, first, gen]`, hears
     `[id, gen]`, and drops a tick whose gen is stale or that arrives while
     held.
   - `hold()`, `walk(toMs)` returning the count fired (linear scan per fire
     is fine, ~20 timers; guard against runaways), `release()`, `shift(ms)`,
     `walkAhead()` (seconds, non-zero only while a walked timer runs),
     `held()`.
   - New timers while held: due = max(now, frontier) + ms. Inside a walk:
     virtual now + ms. Released: now + ms.
   - The page-timer fallback the same way.
   - `ticker-walk.test.mjs` then runs instead of skipping.
2. **`js/heart/ring.js`**: `LIMIT` in the control head (−1 at make) and a
   per-stage `WAKES` slot. Every slot index goes through
   `bellOf`/`wakeOf`/…; `drain.test.mjs` uses those helpers.
3. **`js/heart/render-worker.js`**: LIMIT in `ready()`; `wakeAt()` −1 when
   LIMIT binds, half-lookahead when the clock binds under a LIMIT; a ~2 s
   safety in idle; count wakes.
4. **`js/heart/drain-worklet.js`**:
   - `setIdle(frames)`: raise above `policy.max` up to `policy.idleMax`;
     drop to `max(floor(), idle)` at once, by draining.
   - `floor()` includes idle.
   - No learn or grow while idle.
   - `jump(quanta)` with the crossfade (scratch preallocated, 8 quanta), and
     the `'jumped'` ack (one reused object).
   - Port messages `'idle'` and `'jump'`.
   - Add drain tests: jump drops exactly Δ, plays the frame after it,
     crossfades; idle survives 30 s steady; underrun while idle leaves
     `bad`/`learned` alone.
5. **`js/heart/engine.js`**:
   - `lead()`; `heardNow()` = ctx.currentTime + lead, used wherever it reads
     `ctx.currentTime` (timeMap start, horizon fallback, wake clock, stats
     fill).
   - `setIdle(seconds, limitFrame)`: writes LIMIT and rings bells, or stashes
     the limit while a jump is pending; posts `'idle'`.
   - `skipAhead(why)`: one jump in flight at a time; freezes LIMIT at the mix
     head; D += Δ; posts `'jump'`; returns Δ in seconds.
   - `cushion()`.
   - `horizon()` takes min(played + ahead + lead, LIMIT + lead) before the
     heads.
   - Final ring sized for 11 s; `policy.idleMax` to the drain.
   - The diag beat prints wakes a second per stage and the idle cushion.
6. **`js/heart/nodes.js`, `heart.js`, `params.js`**: `HeartGraph.now()` =
   clock.currentTime + engine.lead() + ticker `walkAhead()`.
   - `HeartContext.currentTime` returns it.
   - `present()` caches only the horizon per task and takes
     `max(frameAt(now()), horizon)` per call.
   - The `.value` setter uses `now()`.
   - **`frame(t)` keeps the native clamp** (2.6).
7. **`js/audio.js`**:
   - Param-aware anchors (3.1); `toneBreathTick` on the genus clock;
     `restCheck` real.
   - `idleTouch('the transport')` at the top of `applyAudioGain`,
     `startAudio`, `audioOff`, before any command.
   - `heartNudge(type)`: `idleMove()` on move/wheel, `idleTouch()` on
     down/key.
   - `startIdleAhead()` once `startHeart` has an engine; `idleRefresh()` on
     rest and wake.
8. **Planner fixes** from 3.1 (piano, choir, strobe-am).
9. **`js/livesound.js`**: `setLiveCapturing(() => !!cap || busy)` at
   import; `idleRefresh()` when a capture opens or shuts.
10. **`main.js`**: pass the input type to `heartNudge`; `onStorage` calls
    `idleTouch` before `syncFromStorage` when `settingsKey(key)`.
    **`platform/worker-bridge.js`**: the same types.
11. **Drawer hover**: in the drawer's hover handling, a pointer over a row
    whose section is an audio section calls `idleIntent()`. Take the set of
    sections from the controls `core/schema-audio.js` defines. Worker mode
    needs a call across `core/audio-link.js` / `core/audio-shell.js`.
12. **`js/state.js`**: `heartIdleAheadS: 10` beside `heartGrowX`.
13. **Tests** (a new `tools/heart-tests/idle-ahead.test.mjs` on the e2e rig,
    `tools/heart-tests/fake-audio.mjs`, SAB mode, combined and mix + two
    islands):
    - Gulps: heads stop at LIMIT; wakes per second with a 2 s cushion vs
      base, using the WAKES slots. This is the cadence measurement for the
      report.
    - **Pause ordering**: grow to ~2 s, then in one task `skipAhead()` and a
      gate ramp anchored at the native now on a Heart gain. The ramp must be
      heard at or after the skip target and within base + 2 chunks of it,
      never at the old frontier.
    - The same for a settings write mid-gulp.
    - Record by `drain.played`, not native frame minus F: after a jump the
      two differ by D.
14. Flip `IDLE_AHEAD_BUILT` to true; the drawer row appears.
15. **Docs**: heart-audio-engine.md §7.6 (render ahead on idle), and the
    `?heartdiag=1` lines.
16. **Verify**:
    - `tools/heart-tests/run-each.sh 240`, file by file (never the whole
      suite in one process). e2e and family-music time out after passing:
      read their logs.
    - ESM check: copy every changed `.js` to a `.mjs` and `node --check` it
      (`node --check` on `.js` misses ESM errors here).
    - `node tools/journey-sim.test.mjs "$PWD"` (repo suite).
    - Don't drive a browser; Robert tests on his phone with `?heartdiag=1`:
      lookahead at 10 s while hidden, wakes a second per stage in the beat.
17. Commit on sun-layer, push, then `git push origin sun-layer:main`.
