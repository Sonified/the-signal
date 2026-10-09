// v1 entry point: boot, and the one frame loop.
//
// Everything the viewer sees is built here each frame, in a fixed order, and
// handed to the engine as three draw lists: the overlay (word, hint, veil)
// that rides in the scene pass; the base UI (drawer, chrome); and the top
// layer (burger, mixer) that must sit above the drawer. Immediate-mode hit
// testing is first come, first served, so the layers are BUILT top first and
// DRAWN bottom first: the mixer gets the first claim on a click, the field
// gets the last.
//
// This file is the composition root, so it is the one place outside
// platform allowed a single DOM lookup: finding the canvas.
//
// It runs on one of two threads (core/engine-thread.js). On the page, by
// default, it does everything below. With the Render section's Engine thread
// set to Worker, the page hands the engine to a worker at the top of boot
// (platform/worker-bridge.js) and keeps only the canvas, input and sound;
// this same file then runs again inside that worker (worker-entry.js),
// where platform/host.js supplies the worker's platform, and the few calls
// that start or steer the sound are left to the page, which hears about them
// through the audio link (core/audio-link.js) once a frame.
import { S, STORE } from './js/state.js';
import { seedParticles, seedTunnel } from './js/sim.js';
import { setColorFromPicker } from './js/color.js';
import { ensureAudioGraph, warmDevice, audioOn, heartNudge, heartRestInfo } from './js/audio.js';
import { setMediaTransport } from './js/background.js';
import { noteHandheld } from './js/handheld.js';
import { guard, guardStep, guardSimulate, guardMessage, guardSummary, guardReset } from './js/panel-guard.js';
import { display, displayChanged, clockCheck, clockMessage, displaySummary, DISPLAY_CHANGED } from './js/display-watch.js';

import { createPlatform } from './platform/web.js';
import { host } from './platform/host.js';
import { startWorkerShell } from './platform/worker-bridge.js';
import { createEngine } from './gpu/engine.js';
import { createScene } from './gpu/scene.js';
import { createFlowers } from './gpu/flowers.js';
import { createKaleido, setKaleidoYield } from './gpu/kaleido.js';
import { createParticles } from './gpu/particles.js';
import { createFireworks } from './gpu/fireworks.js';
import { FIREWORKS_ENABLED } from './core/schema-fireworks.js';
import { createConfetti } from './gpu/confetti.js';
import { createWordCloud } from './gpu/word-cloud.js';
import { createWordSmoke } from './gpu/word-smoke.js';
import { createText } from './gpu/text-atlas.js';
import { createUIRenderer } from './gpu/ui-renderer.js';
import { createBlur } from './gpu/blur.js';

import { stepStrobe, resetStrobeClock, resetRefreshMeasure, darkSlot, strobeResume } from './core/strobe.js';
import { gentleResume, armResume } from './core/wake.js';
import { roomClockSnap } from './core/room-clock.js';
import { motionTick, motionHalt, winding, motionScale } from './core/motion.js';
import { setIdleWaker, idleWake, idleHeld, IDLE_DIAG } from './core/idle.js';
import { eye, stepEye } from './core/eye.js';
import { initChores, choreRegister, choreRun, choreYield, choreBusy } from './core/chores.js';
import { initWords, stepWords, wordsResume, wordState } from './core/words.js';
import { initStore, load, save, flush, setHidden, syncFromStorage, writeDueAfterFrame, savePending } from './core/store.js';
import { replayLive, syncPresetsFromStorage, applyActivePresetState, transitionRemaining } from './core/presets.js';
import { seedFactoryPresets } from './platform/factory-presets.js';
import { initBroadcast, broadcastPoke, followMayStart, broadcastAsking, broadcastAnswer } from './core/broadcast.js';
import { openBroadcastSocket, makeFollowUrl, broadcastUrlIntent } from './platform/broadcast-socket.js';
import { recordLiveAudio, canRecordLiveAudio, livePlayer, unlockLiveAudio } from './platform/live-media.js';
import { stepJourney, syncJourneyFromStorage, setJourneyRunning, journeyTogglePlay, journeyStepBy, journeyCount, journeyResume, journeyBusy } from './core/journey.js';
import { initAtmosphere, stepAtmosphere } from './core/atmosphere.js';
import { setToggleRun, setMixerOpen, setSeqOpen, setCopyHandler, audioToggleEffects } from './core/schema-audio.js';
import { setSettingsFileHandler } from './core/schema-visual.js';
import { byId } from './core/schema.js';
import { buildDiagnostics } from './core/diagnostics.js';
import { perf, perfAttachGpu, perfFrameStart, perfRecord } from './core/perf.js';
import {
  prof, initProfiler, profFrame, profNote,
  PF_LIT, PF_RUNNING, PF_DRAWER, PF_MIXER, PF_DIRECT, PF_CAPTURE, PF_UI_SKIPPED, PF_GLASS
} from './core/profiler.js';
import { createProfileHost } from './platform/profile-web.js';

import { DrawList } from './ui/drawlist.js';
import { createUI } from './ui/imgui.js';
import { runAction } from './ui/widgets.js';
import * as anim from './ui/anim.js';
import { LAYOUT, MOTION } from './ui/theme.js';
import { drawOverlay, overlayState, flashNotice, setOverlayTouch, setOverlayFollow } from './ui/screens/overlay.js';
import { drawChrome, drawBurger, drawGuardNotice, openGuardNotice, streamAskHits, drawStreamAsk } from './ui/screens/chrome.js';
import { drawDrawer, stepDrawer, drawProfileBadge, drawerEdge } from './ui/screens/drawer.js';
import { drawMixer, mixer } from './ui/screens/mixer.js';
import { drawSequencer, sequencer } from './ui/screens/sequencer.js';
import { drawJourney, journey } from './ui/screens/journey.js';
import { drawPerformer, performer } from './ui/screens/performer.js';
import { drawMusic, music } from './ui/screens/music.js';
import { drawTextbank, textbank } from './ui/screens/textbank.js';
import { perfTick, perfResume, perfBusy } from './core/perform.js';

// Mobile browsers require a user gesture before audio can leave a suspended
// AudioContext. A broadcast follower must keep running while it waits, so the
// temporary DOM gate consumes only this tap, wakes audio, and fades away; it
// never reaches the canvas's run/pause field.
// The tap is also a join into a stream already flashing under the gate, so
// the strobe's contrast ramps in from nothing as the gate lifts
// (core/wake.js).
if (!host.worker && typeof document !== 'undefined') {
  const followAudioGate = document.getElementById('follow-audio-gate');
  if (followAudioGate) {
    const unlockFollowerAudio = e => {
      e.preventDefault();
      e.stopPropagation();
      gentleResume();
      followAudioGate.classList.add('done');
      warmDevice();
      audioOn();
      // the broadcaster's live sound plays from a media element, which this
      // same gesture lets play (platform/live-media.js)
      unlockLiveAudio();
      setTimeout(() => followAudioGate.remove(), 650);
    };
    followAudioGate.addEventListener('pointerdown', unlockFollowerAudio, { once: true });
  }
}

console.log('[boot] modules evaluated +' + Math.round(performance.now()) + 'ms');
// A boot that throws inside the worker is reported to the page (see
// worker-entry.js); on the page it surfaces as it always has.
boot().catch(err => { console.error('[boot] FAILED', err); if (host.bootFailed) host.bootFailed(err); else throw err; });

async function boot() {
  const inWorker = host.worker;
  const canvas = inWorker ? null : document.getElementById('v1');
  // Worker mode, page side: the engine goes to the worker and this page
  // becomes its shell. Otherwise (the default, or no worker to be had) this
  // returns false and the engine boots here as always.
  console.log('[boot] boot() entered, worker: +' + Math.round(performance.now()) + 'ms', inWorker);
  // A first visit fetches the starting presets and writes them in before
  // anything reads storage (the worker's copy of it included); a return
  // visit, which already has a presets record, fetches nothing.
  if (!inWorker) await seedFactoryPresets();
  if (!inWorker && await startWorkerShell(canvas)) return;
  console.log('[boot] engine stays on this thread +' + Math.round(performance.now()) + 'ms');
  const platform = inWorker ? await host.platform : createPlatform(canvas);
  console.log('[boot] platform ready +' + Math.round(performance.now()) + 'ms');
  setOverlayTouch(!!platform.coarse);
  // the page's pointer, for the engine thread's phone readouts (js/handheld.js)
  noteHandheld(!!platform.coarse);

  // State first: v0 and v1 share one saved settings object.
  initStore(platform.storage);
  // A first visit starts on the lit chip's settings (the starting row's
  // Blooming Grace 2) rather than the bare defaults.
  if (load()) applyActivePresetState();
  // The colour walk needs hue, saturation and lightness seeded from the
  // current colour; v0 does this from its picker on every boot, saved or not.
  {
    const c = S.rgb, hex = '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    setColorFromPicker(hex);
  }
  // A resize clears the canvas, so a resting frame loop must draw again.
  const syncSize = (w, h, dpr) => { S.W = w; S.H = h; S.DPR = dpr; idleWake('resize'); };
  syncSize(platform.width, platform.height, platform.dpr);
  platform.onResize(syncSize);
  seedParticles(S.edgeCount);

  // Perf mode: read once, here. Off (the normal case) the frame loop pays one
  // boolean test for it and nothing else.
  perf.on = platform.storage.get('signal_perf') === '1';

  console.log('[boot] settings loaded, requesting engine (adapter/device) +' + Math.round(performance.now()) + 'ms');
  const engine = await createEngine(platform, { perf: perf.on });
  console.log('[boot] engine ready: +' + Math.round(performance.now()) + 'ms', !!engine);
  if (!engine) {
    // Two different failures, two different truths: a browser with no
    // WebGPU at all, or a browser whose GPU process stopped answering (the
    // adapter and device requests above are on deadlines, so a wedged GPU
    // lands here instead of leaving the page black forever).
    platform.message(navigator.gpu
      ? 'The graphics system did not respond. Quit the browser fully and reopen it, then reload this page. The original version of The Signal also still works here.'
      : 'This version of The Signal draws everything with WebGPU, and this browser does not offer it. The original version still works here.');
    return;
  }
  engine.onDeviceLost(() => platform.message('The graphics device was reset. Reload the page to continue.'));

  const { device, format } = engine;
  if (perf.on) perfAttachGpu(engine.gpu);
  const text = createText(device, platform);
  console.log('[boot] text atlas created +' + Math.round(performance.now()) + 'ms');
  // Dark-frame chores (core/chores.js): the after-submit work that can stall
  // or allocate waits for a slot where a stall would only lengthen a dark
  // gap. Glyph rasterising goes in slices; the settings write is one piece.
  // The kaleidoscope's atlas build yields to the same slots between tiles.
  initChores(platform.now);
  choreRegister('glyphs', text.tick);
  choreRegister('save', () => { writeDueAfterFrame(); return false; });
  setKaleidoYield(choreYield);
  engine.registerScene(createScene(device, format));
  // The flower layer loads its sprite sheet itself, the first time it is
  // switched on, and draws nothing until the atlas is built.
  engine.registerFlowers(createFlowers(device, format, platform));
  // Likewise the kaleidoscope and its motif atlas.
  engine.registerKaleido(createKaleido(device, format, platform));
  // And the particle generator; it builds nothing until first switched on.
  engine.registerParticles(createParticles(device, format, platform));
  // The fireworks; they build nothing until first switched on, and are not
  // made at all while FIREWORKS_ENABLED (core/schema-fireworks.js) is off,
  // so the engine's draw and update skip them.
  if (FIREWORKS_ENABLED) engine.registerFireworks(createFireworks(device, format));
  // The confetti; it too builds nothing until first switched on.
  engine.registerConfetti(createConfetti(device, format));
  // The word's Cloud transition; it builds nothing until a word first clouds.
  engine.registerWordCloud(createWordCloud(device, format, text));
  // The Smoke transition: recorded dissolution, prepared offscreen, played
  // backward for arrival. Builds nothing until first used.
  engine.registerWordSmoke(createWordSmoke(device, format, text));
  engine.registerUI(createUIRenderer(device, format, text), createBlur(device, format));

  // The frame profiler (the drawer's Profile chip, or signalProfile in the
  // console). Idle until asked; see core/profiler.js.
  const profHost = inWorker ? host.profileHost : createProfileHost();
  initProfiler(profHost, platform, engine);

  // The panel guard's console handle and test switch (js/panel-guard.js). With
  // no 60 Hz display to hand, signalGuard.simulate(60) makes the guard model
  // one; simulate(0) goes back to the real display. localStorage
  // 'signal_guard_test' set to a refresh rate ('60', or '1' for 60) does the
  // same from boot.
  const simulateGuard = hz => {
    guardSimulate(hz);
    return guard.simHz ? 'simulating a ' + guard.simHz + ' Hz display' : 'measuring the real display';
  };
  profHost.expose('signalGuard', { simulate: simulateGuard, get state() { return guard; } });
  {
    const v = platform.storage.get('signal_guard_test');
    const hz = v === '1' ? 60 : parseFloat(v);
    if (hz > 0) simulateGuard(hz);
  }

  const ui = createUI(text);
  // a touch screen's keyboard for the text fields (platform/soft-keyboard.js)
  ui.softKb = platform.softKeyboard || null;
  const overlayList = new DrawList(512);
  const uiList = new DrawList(4096);
  const topList = new DrawList(2048);

  initWords();
  initAtmosphere();
  if (!inWorker) ensureAudioGraph();   // compile the worklet now, while nothing plays (in worker mode the page does)

  // ---- actions the screens and keys share ----
  // Every start or stop of this tab's own comes through toggleRun. On a
  // follower of an Event broadcast still short of its unlock, a start is
  // refused here, before anything moves, and the notice says when free play
  // opens (core/broadcast.js followMayStart); a stop always goes through.
  // The broadcast's own run flag lands through flipRun, which asks nothing.
  function toggleRun() {
    if (!S.running && !followMayStart()) return;
    flipRun();
  }
  function flipRun() {
    idleWake('run');
    S.running = !S.running;
    if (S.running) {
      if (!S.rings.length) seedTunnel(16);
      resetStrobeClock();
    }
    // In worker mode the page starts or stops the sound when the audio link
    // tells it S.running moved.
    if (!inWorker) audioToggleEffects(S);
    // Run/stop is not a setting, so no save() announces it; the demo
    // broadcast is told directly (a no-op unless this tab broadcasts).
    broadcastPoke();
  }
  const colorQuick = byId('colorQuick');
  // The floating windows in the order of the drawer's Windows buttons
  // (drawer.js WIN_LABELS).
  const winByButton = [music, mixer, sequencer, performer, journey, textbank];
  const app = {
    width: 0, height: 0,
    toggleRun,
    toggleDrawer: () => { S.panelOpen = !S.panelOpen; },
    windowOpen: i => !!winByButton[i].open,
    toggleWindow: i => { const w = winByButton[i]; w.open = !w.open; },
    toggleFullscreen: () => platform.fullscreen.toggle(),
    fullscreenActive: () => platform.fullscreen.active(),
    copyDiagnostics: () => platform.clipboardWrite(buildDiagnostics(platform.env())),
    copySettings: () => {
      // flush() writes only what is pending; save() first so the clipboard
      // always gets the complete current object, even on a first visit.
      save();
      flush();
      let txt = platform.storage.get(STORE) || '{}';
      try { txt = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) {}
      platform.clipboardWrite(txt);
    }
  };
  // A panel guard trip: stop exactly as the viewer's own stop does (audio and
  // all), then show the notice. Runs once, on the frame that trips.
  // A safety stop skips the pause wind-down (core/motion.js): the flicker
  // ends on this frame, as it always did.
  function guardPause() {
    if (S.running) toggleRun();
    motionHalt();
    openGuardNotice(guardMessage());
    profNote('panel guard', guardSummary());
  }
  // The display tripwire (js/display-watch.js): the window is on a different
  // screen, or the screen itself changed. Everything measured belongs to the
  // old one, so the refresh rate, the frame lock's count and the guard's
  // integrators are all thrown away, and a running strobe stops the way a
  // guard trip stops it, with its own notice. The next start measures the
  // new display from zero. Runs once, on the frame the change is seen.
  function displayPause(t) {
    resetRefreshMeasure();
    guardReset();
    displayChanged(t);
    // The pause-and-notice on a screen change is switched off by Robert's
    // call (2026-09-25): the strobe keeps running through the move, and the
    // panel guard, re-armed above and judging by the new display's own
    // refresh, pauses within seconds if the new panel is actually at risk.
    // That layered catch was tested live on a 60 Hz external and worked.
    // Uncomment to bring the immediate pause back.
    // if (S.running) {
    //   toggleRun();
    //   openGuardNotice(DISPLAY_CHANGED);
    // }
    profNote('display changed', displaySummary(S.refreshHz, inWorker));
  }
  // The second clock (worker mode): the page's frame cadence and the
  // engine's have disagreed for two seconds, so neither can be trusted to
  // say what the panel is really showing.
  function clockPause() {
    if (S.running) toggleRun();
    motionHalt();
    openGuardNotice(clockMessage());
    profNote('clock conflict', displaySummary(S.refreshHz, inWorker));
  }
  let pageVisible = true, backInView = false;
  setToggleRun(toggleRun);
  setJourneyRunning(on => { if (on !== !!S.running) toggleRun(); });
  // Media Session's play and pause (the lock screen, a headset, a media key;
  // js/background.js) are the space bar's own toggleRun. In worker mode they
  // reach this thread from the page through host.run, and the audio link is
  // flushed straight away, since a locked screen draws no frame to carry the
  // run call back to the sound.
  const mediaRun = on => { if (on !== !!S.running) toggleRun(); };
  if (inWorker) host.run = on => { mediaRun(on); host.link.flush(); };
  else setMediaTransport(mediaRun);
  setMixerOpen(open => { mixer.open = !!open; });
  setSeqOpen(() => { sequencer.open = true; });
  setCopyHandler(txt => platform.clipboardWrite(txt));
  setSettingsFileHandler(kind => platform.settingsFile(kind));
  // Going out of sight writes this tab's own pending changes first, then
  // holds back anything later (store.js's setHidden). Coming back arms a
  // wake, so the next frame resumes gently whatever its gap (core/wake.js).
  // In worker mode the page's visibility reaches this through the bridge.
  platform.onVisibility(visible => {
    pageVisible = visible;
    if (!visible) flush();
    else { armResume(); backInView = true; }
    setHidden(!visible);
    // The engine's own loop has already let go of any rest (gpu/engine.js);
    // showing again is the absence's wake, not the still frame's.
    if (resting) { resting = false; if (IDLE_DIAG) idleLeft(visible ? 'the page came back into view' : 'the page went out of sight'); }
  });
  // Another tab's write lands in this tab's state at once, live, so this tab
  // can never later save its older copy over it.
  platform.onStorage((key, value) => {
    idleWake('another tab');
    if (syncFromStorage(key, value, replayLive)) return;
    if (syncPresetsFromStorage(key)) return;
    syncJourneyFromStorage(key);
  });
  // The demo broadcast (core/broadcast.js): the drawer's Broadcast section
  // manages named session links, each a room this tab sends its settings to
  // on every save; ?follow=<room> makes this tab a follower instead, taking
  // the room's settings through the same live path a preset recall uses.
  // Page thread only: in worker mode the store lives in the worker, which
  // never sees the page's URL, so a normal load is what a demo runs on.
  if (!inWorker) {
    const bIntent = broadcastUrlIntent();
    if (bIntent && bIntent.follow) setOverlayFollow();
    initBroadcast(
      { intent: bIntent, open: openBroadcastSocket, followUrl: makeFollowUrl,
        // the live sound's recorder and player (core/live-audio.js)
        media: { record: recordLiveAudio, canRecord: canRecordLiveAudio, player: livePlayer } },
      {
        // a notice shows on the overlay, which a resting loop must draw
        notify: msg => { flashNotice(msg); idleWake('a notice'); },
        isRunning: () => S.running,
        setRunning: on => { if (on !== !!S.running) flipRun(); },
        copy: txt => platform.clipboardWrite(txt),
        // the strobe clock's timebase: the same clock the frame loop's t is on
        now: platform.now
      }
    );
  }

  // ---- per-frame state, allocated once ----
  const renderArgs = { lum: 0, lit: false, overlayList, uiList, topList, glassVisible: false, sceneChanged: true };
  const uiEvents = [];
  let lastActivity = 0, audioWoken = false, lastCursor = '';
  // Whether the pointer rested on the UI (see chromeAwake) at the last build.
  let overUI = false, overWin = false;
  // The floating windows' stacking, back to front: each entry is a window's
  // state object (its open flag and last drawn rect) and its draw function.
  // Opening a window, or a press inside it, moves it to the end, the front.
  // Fixed arrays, reordered in place, so the frame allocates nothing.
  const WIN_N = 6;
  const zWin = [sequencer, mixer, journey, performer, music, textbank];
  const zDraw = [drawSequencer, drawMixer, drawJourney, drawPerformer, drawMusic, drawTextbank];
  const zWasOpen = [false, false, false, false, false, false];
  function toFront(k) {
    if (k === WIN_N - 1) return;
    const w = zWin[k], d = zDraw[k], o = zWasOpen[k];
    for (let j = k; j < WIN_N - 1; j++) { zWin[j] = zWin[j + 1]; zDraw[j] = zDraw[j + 1]; zWasOpen[j] = zWasOpen[j + 1]; }
    zWin[WIN_N - 1] = w; zDraw[WIN_N - 1] = d; zWasOpen[WIN_N - 1] = o;
  }
  const inWin = (r, x, y) => r.rw > 0 && x >= r.rx && x < r.rx + r.rw && y >= r.ry && y < r.ry + r.rh;
  // What the last UI build left behind, for deciding whether this frame can
  // skip building one at all: the chrome's fade, and whether any spring,
  // momentum scroll or tooltip was still moving.
  let lastChromeA = 1, uiUnsettled = true, lastInset = -1;
  // A touch that lands while the chrome has faded away (the last build left
  // it under half shown), or the first touch since the page came back into
  // view (a phone unlocked, whatever was showing when it went dark), is a
  // wake tap: on the bare field it only brings the controls back, so
  // reaching for the burger on a phone never pauses a running session. The
  // next tap, with the controls up, pauses as ever. A stopped session still
  // starts on its first tap ('Tap to resume').
  let wakeTap = false;
  let lastEyeX = 0, lastEyeY = 0;
  // ---- the still frame ----
  // Paused, wound down and left alone, the picture stops changing, yet the
  // loop would go on encoding every layer's passes at the display's rate to
  // draw the same image again. So once nothing on screen can change, the
  // frame asks the engine for no more frames (gpu/engine.js sleep) and the
  // canvas keeps showing the last one. Still means all of: stopped, the
  // pause wind-down finished (core/motion.js), the scene unchanged this
  // frame by input, the drawer's slide, the overlay or the eye (exactly the
  // test that keeps the glass's capture fresh, below), no input for
  // IDLE_QUIET_MS and no press held, every spring and scroll in the UI
  // settled and no text field holding the caret, no meters showing, no
  // profiler or perf mode measuring frames, no glide in flight (a preset's
  // window, the performer's, a journey walking or its authoring diff), no
  // word up, no settings write or chore waiting for a frame, no load
  // holding the loop (core/idle.js), and nothing the engine draws still on
  // the move by itself (a crossfade, a word's tail, the glass owing a
  // capture). And at least IDLE_MIN_FRAMES since the last wake, so whatever
  // woke it is drawn.
  // Anything that could change the picture wakes it (core/idle.js lists
  // who): input, a resume, a resize, a setting saved, another tab, a
  // broadcast message, a notice, a load finishing. Input also wakes a
  // resting Heart (js/audio.js), so the sound's cushion refills while the
  // hand travels to the click. The page going out of sight stops the loop
  // as it always did, and its return is the ordinary wake from an absence.
  const IDLE_QUIET_MS = 2000, IDLE_MIN_FRAMES = 2;
  let resting = false, lastInputT = -Infinity, framesAwake = 0;
  // ?idlediag=1: when the rest began, the frames encoded by then, and the
  // Heart reading at the last heartbeat.
  let restSince = 0, restFrames = 0, beatHeads = 0, beatTimer = 0;
  function wakeLoop(why) {
    framesAwake = 0;
    if (!engine.wake()) return;
    resting = false;
    if (IDLE_DIAG) idleLeft(why);
  }
  setIdleWaker(wakeLoop);
  platform.onInput(type => {
    wakeLoop(type);
    // in worker mode the page nudges the sound itself (platform/worker-bridge.js)
    if (!inWorker) heartNudge();
  });
  function idleEntered() {
    restSince = performance.now();
    restFrames = engine.frames;
    const h = heartRestInfo();
    beatHeads = h ? h.heads : 0;
    console.log('[idlediag] rest: paused, wound down, ' + (IDLE_QUIET_MS / 1000) + ' s without input, nothing on screen moving; frames encoded so far ' + engine.frames);
    beatTimer = setInterval(idleBeat, 60000);
  }
  function idleLeft(why) {
    clearInterval(beatTimer);
    console.log('[idlediag] wake: ' + why + ', after ' + ((performance.now() - restSince) / 1000).toFixed(1) + ' s at rest, ' + (engine.frames - restFrames) + ' frames encoded meanwhile');
  }
  // Once a minute at rest: the frames encoded since the rest began, and the
  // Heart chunks rendered in the last minute, both 0 once everything sleeps
  // (Heart rests a little after the picture, once the pause's tails have
  // rung out, so its first minute may show the last of them).
  function idleBeat() {
    const h = heartRestInfo();
    const chunks = h ? Math.round((h.heads - beatHeads) / 512) : -1;
    console.log('[idlediag] at rest ' + ((performance.now() - restSince) / 60000).toFixed(0) + ' min: frames encoded since the rest began ' + (engine.frames - restFrames) +
      ', Heart chunks rendered this minute ' + (h ? chunks + (h.resting ? ' (resting)' : ' (awake)') : 'n/a (no Heart on this thread)'));
    if (h) beatHeads = h.heads;
  }

  // The platform's key events carry no repeat flag, so M remembers that it is
  // held and ignores the auto-repeats, as v0's !e.repeat did; otherwise a
  // held key would flap the window open and shut. Its keyup clears it.
  let musicKeyHeld = false, levelsKeyHeld = false, seqKeyHeld = false, journeyKeyHeld = false, perfKeyHeld = false, textKeyHeld = false;

  // Global keys, as v0 binds them. They are taken out of the toolkit's view
  // so a focused slider never also treats Space or Enter as "activate".
  function globalKey(e) {
    // a paste with no field focused is not a keystroke (its text could be
    // any single letter, and 'f' must not go fullscreen)
    if (e.code === 'Paste') return false;
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    if (e.meta || e.ctrl) return false;
    // With the journey window open and journey mode ACTIVE, Space plays and
    // pauses the walk (a resume carries on where it paused) and the left and
    // right arrows step it; a journey with no steps leaves Space to the app.
    const journeyKeys = journey.open && journey.active && journeyCount() > 0;
    if (e.code === 'Space') { if (journeyKeys) journeyTogglePlay(); else toggleRun(); return true; }
    if (journeyKeys && (k === 'ArrowLeft' || k === 'ArrowRight')) { journeyStepBy(k === 'ArrowLeft' ? -1 : 1); return true; }
    if (k === 'Enter' || lk === 'f') { platform.fullscreen.toggle(); return true; }
    if (k === '`' || k === '~' || lk === 'h') { app.toggleDrawer(); return true; }
    // Escape shuts the front-most open floating window first and leaves the
    // drawer alone, as v0's mixer took the key before the drawer could see
    // it; with no window up, it puts the drawer away. The stream's recall
    // question and the panel guard's notice, when up, go before any of them;
    // the question goes unanswered, which leaves its session off.
    if (k === 'Escape') {
      if (broadcastAsking()) { broadcastAnswer(-1); return true; }
      if (guard.noticeOpen) { guard.noticeOpen = false; return true; }
      for (let j = WIN_N - 1; j >= 0; j--) {
        if (zWin[j].open) { zWin[j].open = false; return true; }
      }
      S.panelOpen = false;
      return true;
    }
    // M opens and shuts the Music window, the sound's performance controls.
    // It leaves the drawer as it is, as v0's mixer key did; the chip and the
    // drawer button are the ones that put the drawer away.
    if (lk === 'm' && !e.alt) {
      if (!musicKeyHeld) { musicKeyHeld = true; music.open = !music.open; }
      return true;
    }
    // L does the same for the Levels window, the atmosphere mixer that M
    // used to open (v0's v0/js/ambience-mixer.js shortcut).
    if (lk === 'l' && !e.alt) {
      if (!levelsKeyHeld) { levelsKeyHeld = true; mixer.open = !mixer.open; }
      return true;
    }
    // S does the same for the sequencer window.
    if (lk === 's' && !e.alt) {
      if (!seqKeyHeld) { seqKeyHeld = true; sequencer.open = !sequencer.open; }
      return true;
    }
    // J does the same for the journey window.
    if (lk === 'j' && !e.alt) {
      if (!journeyKeyHeld) { journeyKeyHeld = true; journey.open = !journey.open; }
      return true;
    }
    // P does the same for the performer window.
    if (lk === 'p' && !e.alt) {
      if (!perfKeyHeld) { perfKeyHeld = true; performer.open = !performer.open; }
      return true;
    }
    // T opens and shuts the Text window, the performer's phrase bank. It
    // used to switch the words layer on and off; that switch is the Text
    // row's toggle in the Performance window and the drawer now.
    if (lk === 't' && !e.alt) {
      if (!textKeyHeld) { textKeyHeld = true; textbank.open = !textbank.open; }
      return true;
    }
    if (lk === 'c' && colorQuick) { runAction(colorQuick, S); return true; }
    return false;
  }

  // A resume frame (core/wake.js): the app was away for `away` ms, or this is
  // the first frame, or the page just came back into view. The engine has
  // already made this frame's dt zero; here every scheduler that keeps an
  // absolute due-time is carried forward by the absence, so nothing that
  // came due while away fires now, and the room-derived swings are told to
  // land on the room's now in one step. The strobe's contrast ramp was
  // started by the engine's wake test.
  function holdBreath(away) {
    strobeResume(away);
    wordsResume(away);
    journeyResume(away);
    perfResume(away);
    roomClockSnap();
  }

  // The frame, in the order its work feeds the image. Anything that does not
  // feed this frame's pixels (meters nobody can see, glyph rasterising) waits
  // until after the submit, so it never stands between the strobe and the
  // screen. away is -1 on an ordinary frame (see holdBreath).
  function frame(t, dt, away) {
    if (away >= 0) holdBreath(away);
    // The phase stamps run for perf mode or while the profiler records;
    // otherwise the frame pays two boolean tests for both.
    const profOn = prof.recording;
    const perfOn = perf.on || profOn;
    let t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0;
    if (perfOn) { if (perf.on) perfFrameStart(t); t0 = platform.now(); }

    const width = platform.width, height = platform.height;
    app.width = width; app.height = height;

    // input: wake the chrome, wake audio on the first gesture, take globals
    const events = platform.pollInput();
    uiEvents.length = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'down') {
        wakeTap = e.pointerType === 'touch' && (lastChromeA < 0.5 || backInView);
        backInView = false;
      }
      if (e.type === 'move' || e.type === 'down' || e.type === 'wheel' || e.type === 'key') lastActivity = t;
      lastInputT = t;
      // (in worker mode the page wakes the sound inside the gesture itself)
      if (!audioWoken && !inWorker && (e.type === 'down' || e.type === 'key')) {
        audioWoken = true;
        warmDevice();
        if (S.audioOnBoot !== false && !S.audioEnabled) audioOn();
      }
      // While a text field has focus every key belongs to it: letters, Space,
      // Enter and Escape are typing and committing there, not shortcuts. The
      // flag is the one the last UI build left, which is the right one here,
      // since keys are routed before this frame's UI exists.
      if (e.type === 'keyup' && (e.key === 'm' || e.key === 'M')) musicKeyHeld = false;
      if (e.type === 'keyup' && (e.key === 'l' || e.key === 'L')) levelsKeyHeld = false;
      if (e.type === 'keyup' && (e.key === 's' || e.key === 'S')) seqKeyHeld = false;
      if (e.type === 'keyup' && (e.key === 'j' || e.key === 'J')) journeyKeyHeld = false;
      if (e.type === 'keyup' && (e.key === 'p' || e.key === 'P')) perfKeyHeld = false;
      if (e.type === 'keyup' && (e.key === 't' || e.key === 'T')) textKeyHeld = false;
      if (e.type === 'key' && !ui.textEditing && globalKey(e)) continue;
      uiEvents.push(e);
    }
    if (perfOn) t1 = platform.now();

    // The display tripwire comes before anything is measured or drawn, so a
    // frame on a new screen never runs on the old screen's numbers.
    if (platform.pollDisplay()) displayPause(t);

    // simulation. The mixer's meters are drawn this frame only while its
    // window is showing (open, or still fading out: the same spring
    // drawMixer reads), so only then are they stepped before the UI.
    // The pause wind-down's scale for this frame, before anything moves.
    motionTick(dt);
    // The viewer's eye for parallax (core/eye.js), on wall-clock time so a
    // simulated head keeps swaying while the scene is paused. Before any
    // layer's update, which all read it.
    stepEye(dt);
    const r = stepStrobe(t);
    // Worker mode: hold the engine's measured refresh against the page's.
    // While they disagree the guard judges by the slower one.
    if (inWorker) {
      if (clockCheck(t, S.refreshHz, S.running, pageVisible)) clockPause();
      guard.trustHz = display.trustHz;
    }
    // The panel guard watches the level this frame is about to show; a trip
    // stops the strobe before the next one. A start puts its notice away.
    if (guardStep(t, r.lum)) guardPause();
    if (guard.noticeOpen && S.running) guard.noticeOpen = false;
    stepWords(t, dt);
    // the journey's walk and its authoring diff (core/journey.js)
    stepJourney(t);
    // the performer window's ramps (core/perform.js): every glide it has
    // in flight moves a little further, wherever the window itself is
    perfTick(t);
    const metersShown = mixer.open || anim.value('mixer.open') >= 0.002;
    if (metersShown) stepAtmosphere(t, true);
    if (perfOn) t2 = platform.now();

    overlayList.reset(width, height);
    uiList.reset(width, height);
    topList.reset(width, height);

    // With the chrome (and an open mixer, which fades with it) faded out, the
    // drawer shut, nothing still animating and no input at all this frame,
    // the whole UI build would produce two empty lists. So it is skipped, and
    // the empty lists go to the engine as they are. Any input, even a bare
    // move, brings the build straight back, which is also what keeps a click
    // on the field working. A held press (a fader mid-drag) keeps it awake.
    // The chrome and the cursor fade on the same idle rule with the drawer
    // open or shut; an open drawer only keeps the UI BUILD awake, since the
    // drawer itself stays up. The mixer and sequencer are deliberately not
    // part of the fade at all: they open and close only by their buttons,
    // their keys and their own X, so while open they hold at full strength
    // and only keep the build awake, like the drawer. A pointer resting on
    // any of the UI floating over the picture holds the chrome up; one
    // resting on the bare picture lets the chrome alone fade.
    const chromeAwake = guard.noticeOpen || broadcastAsking() || ui.activeId !== -1 || overUI || t - lastActivity < LAYOUT.idleMs;
    const awake = chromeAwake || S.panelOpen || mixer.open || sequencer.open || journey.open || performer.open || music.open || textbank.open;
    const idle = !awake && events.length === 0 && !uiUnsettled && ui.activeId === -1 && lastChromeA < 0.01;
    if (idle) {
      // ui.begin normally hands the springs this frame's dt; the overlay's
      // own springs still run, so they get it here instead.
      anim.setDt(dt);
    } else {
      // UI, top layer first so it wins the pointer
      ui.begin(uiEvents, t, dt * 1000, width, height, topList);

      const chromeA = ui.spring('chrome.alpha', chromeAwake ? 1 : 0, MOTION.fade);
      // the chrome chips frost only while a window that needs the capture is up
      const frost = ui.spring('chrome.frost', S.panelOpen || mixer.open ? 1 : 0, MOTION.fade);
      lastChromeA = chromeA;
      stepDrawer(ui);   // the slide everything below reads this frame

      // the stream's recall question takes the pointer before anything
      // else and is painted last on this layer (see chrome.js)
      streamAskHits(ui, app);
      drawGuardNotice(ui, app);
      // The floating windows (mixer, sequencer, journey) stack by last
      // touch: a press inside one, or its opening, brings it to the front,
      // and a press where several overlap goes to the front-most of them.
      // They are built back to front, each with the rects of every window in
      // front of it occluded (as last drawn), so none can show under or take
      // a press from one above it, and the front one is drawn last, on top.
      for (let j = 0; j < WIN_N; j++) {
        const w = zWin[j];
        if (w.open && !zWasOpen[j]) { zWasOpen[j] = true; toFront(j); j--; continue; }
        zWasOpen[j] = w.open;
      }
      if (ui._downEvent) {
        for (let j = WIN_N - 1; j >= 0; j--) {
          if (inWin(zWin[j], ui._downX, ui._downY)) { toFront(j); break; }
        }
      }
      for (let j = 0; j < WIN_N; j++) {
        ui.clearOcclusion();
        for (let f = j + 1; f < WIN_N; f++) { const w = zWin[f]; ui.addOcclusion(w.rx, w.ry, w.rw, w.rh); }
        zDraw[j](ui, app, 1);
      }
      ui.clearOcclusion();
      drawBurger(ui, app, chromeA, frost);
      drawStreamAsk(ui);

      ui.dl = uiList;
      drawDrawer(ui, app);
      drawChrome(ui, app, chromeA, frost);

      // Everything above the field has run its hit tests, so a hot widget
      // here is UI under the pointer; the window and drawer rects catch the
      // gaps between their controls.
      {
        // The windows are their own world: a pointer resting on the mixer or
        // sequencer (their widgets included) lets the rest of the chrome
        // fade, and only keeps the cursor alive below.
        const px = ui.pointerX, py = ui.pointerY;
        overWin = px >= 0 && (inWin(mixer, px, py) || inWin(sequencer, px, py) || inWin(journey, px, py) || inWin(performer, px, py) || inWin(music, px, py) || inWin(textbank, px, py));
        overUI = px >= 0 && !overWin && (ui.hotId !== -1 ||
                             (S.panelOpen && px < drawerEdge()));
      }

      // the field: any press nothing above claimed. With the drawer open it
      // puts the drawer away, as v0 does; otherwise it starts and stops,
      // except that a wake tap on a running session only woke the chrome.
      ui.interact(ui.id('field'), 0, 0, width, height, false);
      if (ui.clicked) {
        if (S.panelOpen) S.panelOpen = false;
        else if (!(wakeTap && S.running)) toggleRun();
      }

      const res = ui.end();
      uiUnsettled = res.wantsFrames;
      // the pointer goes with the chrome's idle fade and returns on any move
      const cursor = (chromeAwake || overWin) ? res.cursor : 'none';
      if (cursor !== lastCursor) { lastCursor = cursor; platform.setCursor(cursor); }
    }

    drawOverlay(overlayList, text, t, width, height);
    // While recording with the drawer shut, a small steady badge in the
    // lower left counts the drops (the drawer's own footer shows it when open).
    if (profOn && !S.panelOpen) drawProfileBadge(uiList, text, height);
    if (perfOn) t3 = platform.now();

    // render; before anything has run the scene is steady, so any frame is a
    // safe blur capture, otherwise only lit frames are (ARCHITECTURE rule 1).
    // While stopped the scene only changes on input, as the drawer slides it
    // aside, or while the overlay fades, so only those mark the capture stale.
    // Winding down after a pause (core/motion.js) the scene still moves and
    // the flicker is still fading out, so until it ends it counts as running
    // for both: a changed scene, and a capture only on a truly lit frame.
    // A moving eye (core/eye.js) moves the stopped scene too.
    const inset = S.edgeInset;
    const wind = winding();
    const eyeMoved = eye.x !== lastEyeX || eye.y !== lastEyeY;
    renderArgs.lum = r.lum;
    renderArgs.lit = r.lit || (!S.running && !wind);
    renderArgs.glassVisible = uiList.glassCount + topList.glassCount > 0;
    renderArgs.sceneChanged = S.running || wind || events.length > 0 || inset !== lastInset || overlayState.animating || eyeMoved;
    lastInset = inset;
    lastEyeX = eye.x; lastEyeY = eye.y;
    engine.render(renderArgs);
    if (perfOn) t4 = platform.now();

    // after the submit: nothing below feeds the frame just sent
    if (!metersShown) stepAtmosphere(t, false);   // drift only; the meters are off while unseen
    // worker mode: tell the page's sound what moved this frame
    if (inWorker) host.link.afterFrame();
    // the pending settings save and queued glyphs, on a dark slot (or once
    // they have waited 250 ms, whatever the pattern)
    choreRun(t, darkSlot());

    // The still frame (see its note above): the last frame drawn stays up.
    framesAwake++;
    if (pageVisible && !S.running && motionScale() === 0 && !renderArgs.sceneChanged &&
        framesAwake >= IDLE_MIN_FRAMES && t - lastInputT >= IDLE_QUIET_MS &&
        !uiUnsettled && ui.activeId === -1 && !ui.textEditing && !metersShown && !profOn && !perf.on &&
        !perfBusy() && !journeyBusy() && !(transitionRemaining() > 0) && !wordState.visible &&
        !savePending() && !choreBusy() && !idleHeld() && !engine.busy()) {
      engine.sleep();
      resting = true;
      if (IDLE_DIAG) idleEntered();
    }

    if (perfOn) {
      const t5 = platform.now();
      if (perf.on) perfRecord(t1 - t0, t2 - t1, t3 - t2, t4 - t3, t5 - t4, t5 - t0, engine.lastDirect, engine.lastCapture, idle);
      if (profOn) {
        let pf = 0;
        if (r.lit) pf |= PF_LIT;
        if (S.running) pf |= PF_RUNNING;
        if (S.panelOpen) pf |= PF_DRAWER;
        if (mixer.open) pf |= PF_MIXER;
        if (engine.lastDirect) pf |= PF_DIRECT;
        if (engine.lastCapture) pf |= PF_CAPTURE;
        if (idle) pf |= PF_UI_SKIPPED;
        if (renderArgs.glassVisible) pf |= PF_GLASS;
        profFrame(t, t1 - t0, t2 - t1, t3 - t2, t4 - t3, t5 - t4, pf);
      }
    }
  }

  console.log('[boot] layers registered, starting frame loop +' + Math.round(performance.now()) + 'ms');
  engine.start(frame);
}
