// Render ahead on idle (documents/heart-audio-engine.md §7.6): while
// nobody is about to touch the sound, Heart
// renders it seconds ahead in large gulps, so the render workers and the
// planners' timers sleep for seconds at a time instead of waking every few
// milliseconds. One knob, the
// drawer's Render ahead on idle (S.heartIdleAheadS, 0.5 to 10 s), is the
// most it reaches.
//
// When. Hidden (a phone's screen off, a tab behind another) nothing can be
// touched, so the cushion goes straight to the setting. Visible, it grows
// only with the viewer's evident intent to listen: it starts five minutes
// after the last audio touch (a settings write, the transport, a journey
// step, another tab's or a broadcast's change), at a second, and grows by a
// second every two minutes while the pointer is still, up to the setting.
// A moving pointer caps it at five seconds. A hand over an audio section of
// the drawer, or any audio touch, takes it straight back to the base.
//
// How a cushion grows: the planners walk first. Every timer the sound's
// planners run on (js/ticker.js) is held back from the real clock and
// walked forward on a virtual one, in due order, up to the new frontier;
// each sees the Heart clock read the virtual time, so it books exactly what
// it would have booked then (the HeartContext clock, js/heart/nodes.js
// now). Only once the walk's commands have gone out does the engine get the
// frontier as its render limit (Engine.setIdle), and the stages render up
// to it in one gulp and sleep. Planning always leads rendering.
//
// How it shrinks: by draining, never by a splice. A lower cap (the pointer
// moving, the page coming back into view) lowers the lookahead and pauses
// the walk; the stages stop rendering until what is buffered has played
// down to the cap, and carry on in gulps of that size.
//
// How it is left at once: a forward skip (Engine.skipAhead). The drain's
// clock jumps to a frame the base lookahead short of what the stages have
// rendered, the frames between are dropped as late with a short crossfade,
// and Heart's clock leads the native one by that much from then on, so
// everything planned keeps its place and the piece is simply that much
// further on. It runs BEFORE the touch's own commands, in the same task, so
// they land at the fresh horizon: every input path that writes audio calls
// idleTouch first (the transport, a key or a press, the journey, the
// follower, another tab, the engine thread's calls), and store.save is the
// backstop for anything else.
//
// Gates: Heart is the engine and runs on shared memory (message mode keeps
// today's behaviour), it is not resting (js/audio.js, the rest wins), the
// session is playing with the sound on, and Live Sound is not capturing (a
// microphone cannot be rendered ahead).

import { S } from './state.js';
import { heartEngine } from './heart/route.js';
// BUILT: the ticker's walk (js/ticker.js hold, walk, release, shift) and
// the engine's half (Engine.setIdle, skipAhead, heardNow, lead) are in, and
// tools/heart-tests/idle-ahead.test.mjs holds the proof. The flag stays as
// the kill switch: false makes every entry below return at once, so the
// hooks wired into the store, the journey, the follower, the show remote
// and the engine thread's calls cost one boolean test and change nothing.
// The ticker is imported whole, as it was while half-built, so a build
// without the walk could never break this module's load.
import * as ticker from './ticker.js';
export const IDLE_AHEAD_BUILT = true;
const { after, clear } = ticker;
const hold = () => ticker.hold(), walk = to => ticker.walk(to);
const release = () => ticker.release(), shift = ms => ticker.shift(ms);

// The visible ramp (Robert, 2026-10-15).
const START_MS = 5 * 60000;       // from the last audio touch to the first second
const STEP_MS = 2 * 60000;        // each further second, the pointer still throughout
const STEP_S = 1;
const MOVE_CAP_S = 5;             // the most while the pointer moves
const STILL_MS = 2000;            // a pointer this long still is not moving
// The walk runs this far past the render limit, so the commands a walk
// sends are on their way before a stage may render near them.
const MARGIN_MS = 250;
// The drain's lookahead sits this far past the cushion, so the limit, not
// the clock, is what holds the stages, and they sleep on it between gulps.
const SLACK_S = 0.5;
// The driver never runs more often than this, however small the cushion.
const MIN_DRIVE_MS = 250;
// After a touch, a hidden page waits this long before growing again, so a
// burst of settings (another tab's preset) lands before the walk.
const SETTLE_MS = 1000;
const DIAG = (() => { try { return /[?&]heartdiag=1(&|$)/.test(location.search); } catch (e) { return false; } })();

let lastTouch = performance.now(), lastMove = -Infinity, nextStepAt = lastTouch + START_MS;
let grown = 0;            // the visible ramp's reach, seconds (0: none yet)
let active = false;       // the timers are held and the engine has a limit
let walkedTo = -Infinity; // the frontier the walk has reached, page ms
let timer = 0, timerAt = Infinity, said = -1;
let capturing = () => false;

export const setting = () => {
  const v = S.heartIdleAheadS;
  return typeof v === 'number' && isFinite(v) ? Math.max(0.5, Math.min(10, v)) : 10;
};
const hiddenNow = () => { try { return document.visibilityState === 'hidden'; } catch (e) { return false; } };
const moving = now => now - lastMove < STILL_MS;

// js/livesound.js hands over its "a capture is open" reading (it imports
// audio.js, which imports this, so the reading comes in rather than out).
export function setLiveCapturing(fn) { capturing = fn; }

function eligible(eng) {
  return !!eng && eng.mode === 'sab' && !eng.isResting() && !capturing() &&
    S.running === true && S.audioEnabled === true;
}

// The visible ramp's next step, page ms, after taking any that are due.
function stepRamp(now) {
  const most = setting();
  for (;;) {
    const at = Math.max(nextStepAt, lastMove + STEP_MS);
    if (grown >= most || now < at) return grown >= most ? Infinity : at;
    grown = Math.min(most, grown + STEP_S);
    nextStepAt = at + STEP_MS;
  }
}

// The cushion wanted now, seconds; 0 for none.
function wanted(eng, now) {
  if (!eligible(eng)) return 0;
  if (hiddenNow()) return setting();
  let e = Math.min(setting(), grown);
  if (moving(now)) e = Math.min(e, MOVE_CAP_S);
  return e;
}

function arm(ms) {
  const at = performance.now() + ms;
  if (timer && timerAt <= at + 50) return;
  if (timer) clear(timer);
  timerAt = at;
  timer = after(Math.max(0, ms), drive, { real: true });
}

// The one place the state moves: once on every timer, and at once on a
// change of visibility, a cap, a setting, or a gate.
function drive() {
  timer = 0; timerAt = Infinity;
  const eng = heartEngine();
  const now = performance.now();
  const nextStep = stepRamp(now);
  const e = wanted(eng, now);
  if (e > 0) {
    if (!active) { active = true; hold(); walkedTo = Math.max(walkedTo, now); }
    const want = now + e * 1000 + MARGIN_MS;
    let fired = 0;
    const t0 = performance.now();
    if (want > walkedTo) { fired = walk(want); walkedTo = want; }
    // The limit goes out after the walk's commands, which the engine posts
    // at the end of this task (a microtask queued before this one).
    const limitAt = walkedTo - MARGIN_MS;
    queueMicrotask(() => {
      if (!active || heartEngine() !== eng) return;
      eng.setIdle(e + SLACK_S, Math.floor(eng.frameAt(eng.heardNow() + (limitAt - performance.now()) / 1000)));
    });
    if (DIAG && (e !== said || fired)) {
      console.log(`[heartdiag] idle ${hiddenNow() ? 'hidden' : 'visible'}: cushion ${e} s; walked ${fired} ticks to +${((walkedTo - now) / 1000).toFixed(2)} s in ${(performance.now() - t0).toFixed(1)} ms`);
    }
    said = e;
    arm(Math.min(Math.max(MIN_DRIVE_MS, e * 500), nextStep - now));
  } else {
    if (active) leave(false, 'drain');
    if (eng && nextStep < Infinity) arm(nextStep - now);
  }
}

// Lets go of the held timers and the limit. `skip`: jump to a fresh
// frontier first, when the cushion is worth jumping; otherwise what is
// buffered plays out.
function leave(skip, why) {
  const eng = heartEngine();
  const jumped = skip && eng ? eng.skipAhead(why) : 0;
  if (jumped > 0) { shift(jumped * 1000); walkedTo -= jumped * 1000; }
  if (active) {
    active = false;
    if (eng) eng.setIdle(0, -1);
    release();
    if (DIAG) console.log(`[heartdiag] idle ends (${why})${jumped > 0 ? `, skipped ${jumped.toFixed(2)} s ahead` : ', the cushion plays out'}`);
  } else if (DIAG && jumped > 0) console.log(`[heartdiag] idle: skipped ${jumped.toFixed(2)} s ahead (${why})`);
  said = -1;
}

// An audio touch, BEFORE its commands: anything buffered ahead is skipped,
// the visible ramp starts over, and a hidden page grows again once the
// touch has settled. Cheap when nothing is grown (a slider drag calls it on
// every move).
export function idleTouch(why = 'a touch') {
  if (!IDLE_AHEAD_BUILT) return;
  const now = performance.now();
  lastTouch = now; grown = 0; nextStepAt = now + START_MS;
  const eng = heartEngine();
  if (!eng) return;
  leave(true, why);
  arm(SETTLE_MS);
}

// A hand over an audio section of the drawer: the intent to touch, which
// readies the controls at once (a small splice, declared worth it).
export function idleIntent() { idleTouch('a hand over the audio controls'); }

// The pointer moved, or a finger went down (js/audio.js heartNudge). A
// cushion over the cap drains to it.
export function idleMove() {
  if (!IDLE_AHEAD_BUILT) return;
  lastMove = performance.now();
  if (grown > MOVE_CAP_S) {
    grown = MOVE_CAP_S;
    nextStepAt = lastMove + STEP_MS;
    if (active) drive();
  }
}

// Something a gate reads has changed (visibility, the rest, Live Sound,
// the transport, the setting): look again now.
export function idleRefresh() {
  if (!IDLE_AHEAD_BUILT) return;
  if (!heartEngine()) return;
  if (timer) { clear(timer); timer = 0; timerAt = Infinity; }
  drive();
}

// Started once Heart is (js/audio.js): visibility is watched from then on.
let started = false;
export function startIdleAhead() {
  if (!IDLE_AHEAD_BUILT) return;
  if (started) return;
  started = true;
  try { document.addEventListener('visibilitychange', idleRefresh); } catch (e) {}
  idleRefresh();
}

// For the diagnostics and the tests.
export function idleState() {
  return { active, grown, wanted: wanted(heartEngine(), performance.now()), walkedTo };
}

// The drawer's small print under Render ahead on idle (core/schema-visual.js
// statusLine, drawn by ui/widgets.js): the engine as it stands, for a phone
// with no console. Reads: the cushion rendered and waiting (and the target
// while idle holds one), the stages' wakes a second (averaged between looks,
// the whole point of the feature), the lead once a touch has skipped, dry
// quanta, and why nothing is grown when nothing is. Main mode only: in
// worker mode the drawer lives in the worker and the engine on the page, so
// the line stays empty there. Recomputed at most four times a second and
// cached; the drawer draws it every frame.
let lineAt = 0, line = '', wakesWas = -1, wakesAt = 0, wakesRate = -1;
const mmss = ms => {
  const t = Math.max(0, Math.round(ms / 1000));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
};
export function idleStatusLine() {
  if (!IDLE_AHEAD_BUILT) return '';
  const now = performance.now();
  if (now - lineAt < 250) return line;
  lineAt = now;
  const eng = heartEngine();
  if (!eng) { line = ''; return line; }
  if (eng.mode !== 'sab') { line = 'no shared memory here: playing at the base'; return line; }
  const w = eng.wakes();
  const total = w ? w.reduce((a, b) => a + b, 0) / w.length : 0;
  if (wakesWas >= 0 && now > wakesAt) wakesRate = Math.max(0, (total - wakesWas) / ((now - wakesAt) / 1000));
  wakesWas = total; wakesAt = now;
  const parts = [`cushion ${eng.cushion().toFixed(1)}${active && said > 0 ? ` of ${said.toFixed(1)}` : ''} s`];
  if (wakesRate >= 0) parts.push(`${wakesRate < 10 ? wakesRate.toFixed(1) : Math.round(wakesRate)} wakes/s × ${eng.stages.length}`);
  const lead = eng.lead();
  if (lead > 0) parts.push(`skipped ${lead.toFixed(1)} s`);
  const st = eng.stats();
  // The busiest stage's smoothed render time as a share of a chunk's
  // real-time budget (engine.js): the number that says whether this device
  // could carry fewer workers, readable where there is no console.
  const busiest = Math.max(0, ...st.renderMs);
  parts.push(`dsp ${Math.min(999, Math.round(100 * busiest * eng.sampleRate / 512000))}%`);
  if (st.underruns > 0) parts.push(`${st.underruns} dry`);
  if (!active) {
    if (!eligible(eng)) {
      parts.push(eng.isResting() ? 'resting' : capturing() ? 'held: live sound'
        : !(S.running === true && S.audioEnabled === true) ? 'held: paused' : 'held');
    } else {
      const at = grown >= setting() ? Infinity : Math.max(nextStepAt, lastMove + STEP_MS);
      parts.push(grown > 0 ? `grown to ${grown.toFixed(0)} s` : at < Infinity ? `grows in ${mmss(at - now)}` : 'at the base');
    }
  }
  line = parts.join(' · ');
  return line;
}
