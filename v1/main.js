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
// v1/platform allowed a single DOM lookup: finding the canvas.
//
// It runs on one of two threads (core/engine-thread.js). On the page, by
// default, it does everything below. With the Render section's Engine thread
// set to Worker, the page hands the engine to a worker at the top of boot
// (platform/worker-bridge.js) and keeps only the canvas, input and sound;
// this same file then runs again inside that worker (v1/worker-entry.js),
// where platform/host.js supplies the worker's platform, and the few calls
// that start or steer the sound are left to the page, which hears about them
// through the audio link (core/audio-link.js) once a frame.
import { S, STORE } from '../js/state.js';
import { seedParticles, seedTunnel } from '../js/sim.js';
import { setColorFromPicker } from '../js/color.js';
import { ensureAudioGraph, warmDevice, audioOn } from '../js/audio.js';
import { guard, guardStep, guardSimulate, guardMessage, guardSummary, guardReset } from '../js/panel-guard.js';
import { display, displayChanged, clockCheck, clockMessage, displaySummary, DISPLAY_CHANGED } from '../js/display-watch.js';

import { createPlatform } from './platform/web.js';
import { host } from './platform/host.js';
import { startWorkerShell } from './platform/worker-bridge.js';
import { createEngine } from './gpu/engine.js';
import { createScene } from './gpu/scene.js';
import { createFlowers } from './gpu/flowers.js';
import { createKaleido, setKaleidoYield } from './gpu/kaleido.js';
import { createParticles } from './gpu/particles.js';
import { createFireworks } from './gpu/fireworks.js';
import { createWordCloud } from './gpu/word-cloud.js';
import { createWordSmoke } from './gpu/word-smoke.js';
import { createText } from './gpu/text-atlas.js';
import { createUIRenderer } from './gpu/ui-renderer.js';
import { createBlur } from './gpu/blur.js';

import { stepStrobe, resetStrobeClock, resetRefreshMeasure, darkSlot } from './core/strobe.js';
import { initChores, choreRegister, choreRun, choreYield } from './core/chores.js';
import { initWords, stepWords } from './core/words.js';
import { initStore, load, save, flush, setHidden, syncFromStorage, writeDueAfterFrame } from './core/store.js';
import { replayLive, syncPresetsFromStorage } from './core/presets.js';
import { initAtmosphere, stepAtmosphere } from './core/atmosphere.js';
import { setToggleRun, setMixerOpen, setSeqOpen, setCopyHandler, audioToggleEffects } from './core/schema-audio.js';
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
import { drawOverlay, overlayState } from './ui/screens/overlay.js';
import { drawChrome, drawBurger, drawGuardNotice, openGuardNotice } from './ui/screens/chrome.js';
import { drawDrawer, stepDrawer, drawProfileBadge } from './ui/screens/drawer.js';
import { drawMixer, mixer } from './ui/screens/mixer.js';
import { drawSequencer, sequencer } from './ui/screens/sequencer.js';

console.log('[boot] modules evaluated');
// A boot that throws inside the worker is reported to the page (see
// worker-entry.js); on the page it surfaces as it always has.
boot().catch(err => { console.error('[boot] FAILED', err); if (host.bootFailed) host.bootFailed(err); else throw err; });

async function boot() {
  const inWorker = host.worker;
  const canvas = inWorker ? null : document.getElementById('v1');
  // Worker mode, page side: the engine goes to the worker and this page
  // becomes its shell. Otherwise (the default, or no worker to be had) this
  // returns false and the engine boots here as always.
  console.log('[boot] boot() entered, worker:', inWorker);
  if (!inWorker && await startWorkerShell(canvas)) return;
  console.log('[boot] engine stays on this thread');
  const platform = inWorker ? await host.platform : createPlatform(canvas);
  console.log('[boot] platform ready');

  // State first: v0 and v1 share one saved settings object.
  initStore(platform.storage);
  load();
  // The colour walk needs hue, saturation and lightness seeded from the
  // current colour; v0 does this from its picker on every boot, saved or not.
  {
    const c = S.rgb, hex = '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    setColorFromPicker(hex);
  }
  const syncSize = (w, h, dpr) => { S.W = w; S.H = h; S.DPR = dpr; };
  syncSize(platform.width, platform.height, platform.dpr);
  platform.onResize(syncSize);
  seedParticles(S.edgeCount);

  // Perf mode: read once, here. Off (the normal case) the frame loop pays one
  // boolean test for it and nothing else.
  perf.on = platform.storage.get('signal_perf') === '1';

  console.log('[boot] settings loaded, requesting engine (adapter/device)');
  const engine = await createEngine(platform, { perf: perf.on });
  console.log('[boot] engine ready:', !!engine);
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
  console.log('[boot] text atlas created');
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
  // The fireworks; they build nothing until first switched on.
  engine.registerFireworks(createFireworks(device, format));
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
  const overlayList = new DrawList(512);
  const uiList = new DrawList(4096);
  const topList = new DrawList(2048);

  initWords();
  initAtmosphere();
  if (!inWorker) ensureAudioGraph();   // compile the worklet now, while nothing plays (in worker mode the page does)

  // ---- actions the screens and keys share ----
  function toggleRun() {
    S.running = !S.running;
    if (S.running) {
      if (!S.rings.length) seedTunnel(16);
      resetStrobeClock();
    }
    // In worker mode the page starts or stops the sound when the audio link
    // tells it S.running moved.
    if (!inWorker) audioToggleEffects(S);
  }
  const lText = byId('lText'), colorQuick = byId('colorQuick');
  const app = {
    width: 0, height: 0,
    toggleRun,
    toggleDrawer: () => { S.panelOpen = !S.panelOpen; },
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
  function guardPause() {
    if (S.running) toggleRun();
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
    openGuardNotice(clockMessage());
    profNote('clock conflict', displaySummary(S.refreshHz, inWorker));
  }
  let pageVisible = true;
  setToggleRun(toggleRun);
  setMixerOpen(open => { mixer.open = !!open; });
  setSeqOpen(() => { sequencer.open = true; });
  setCopyHandler(txt => platform.clipboardWrite(txt));
  // Going out of sight writes this tab's own pending changes first, then
  // holds back anything later (store.js's setHidden).
  platform.onVisibility(visible => {
    pageVisible = visible;
    if (!visible) flush();
    setHidden(!visible);
  });
  // Another tab's write lands in this tab's state at once, live, so this tab
  // can never later save its older copy over it.
  platform.onStorage((key, value) => {
    if (syncFromStorage(key, value, replayLive)) return;
    syncPresetsFromStorage(key);
  });

  // ---- per-frame state, allocated once ----
  const renderArgs = { lum: 0, lit: false, overlayList, uiList, topList, glassVisible: false, sceneChanged: true };
  const uiEvents = [];
  let lastActivity = 0, audioWoken = false, lastCursor = '';
  let frontWin = 'mixer', seqWasOpen = false, mixerWasOpen = false;
  const inWin = (r, x, y) => r.rw > 0 && x >= r.rx && x < r.rx + r.rw && y >= r.ry && y < r.ry + r.rh;
  // What the last UI build left behind, for deciding whether this frame can
  // skip building one at all: the chrome's fade, and whether any spring,
  // momentum scroll or tooltip was still moving.
  let lastChromeA = 1, uiUnsettled = true, lastInset = -1;
  // The platform's key events carry no repeat flag, so M remembers that it is
  // held and ignores the auto-repeats, as v0's !e.repeat did; otherwise a
  // held key would flap the window open and shut. Its keyup clears it.
  let mixerKeyHeld = false, seqKeyHeld = false;

  // Global keys, as v0 binds them. They are taken out of the toolkit's view
  // so a focused slider never also treats Space or Enter as "activate".
  function globalKey(e) {
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    if (e.meta || e.ctrl) return false;
    if (e.code === 'Space') { toggleRun(); return true; }
    if (k === 'Enter' || lk === 'f') { platform.fullscreen.toggle(); return true; }
    if (k === '`' || k === '~' || lk === 'h') { app.toggleDrawer(); return true; }
    // Escape shuts the mixer first when it is up and leaves the drawer alone,
    // as v0's mixer took the key before the drawer could see it. The panel
    // guard's notice, when it is up, goes before either.
    if (k === 'Escape') {
      if (guard.noticeOpen) guard.noticeOpen = false;
      else if (sequencer.open) sequencer.open = false;
      else if (mixer.open) mixer.open = false;
      else S.panelOpen = false;
      return true;
    }
    // M opens and shuts the mixer (v0's js/ambience-mixer.js shortcut). It
    // leaves the drawer as it is, as v0 did; the chip and the drawer button
    // are the ones that put the drawer away.
    if (lk === 'm' && !e.alt) {
      if (!mixerKeyHeld) { mixerKeyHeld = true; mixer.open = !mixer.open; }
      return true;
    }
    // S does the same for the sequencer window.
    if (lk === 's' && !e.alt) {
      if (!seqKeyHeld) { seqKeyHeld = true; sequencer.open = !sequencer.open; }
      return true;
    }
    if (lk === 't' && lText) { lText.set(S, lText.get(S) ? 0 : 1); return true; }
    if (lk === 'c' && colorQuick) { runAction(colorQuick, S); return true; }
    return false;
  }

  // The frame, in the order its work feeds the image. Anything that does not
  // feed this frame's pixels (meters nobody can see, glyph rasterising) waits
  // until after the submit, so it never stands between the strobe and the
  // screen.
  function frame(t, dt) {
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
      if (e.type === 'move' || e.type === 'down' || e.type === 'wheel' || e.type === 'key') lastActivity = t;
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
      if (e.type === 'keyup' && (e.key === 'm' || e.key === 'M')) mixerKeyHeld = false;
      if (e.type === 'keyup' && (e.key === 's' || e.key === 'S')) seqKeyHeld = false;
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
    const awake = S.panelOpen || guard.noticeOpen || ui.activeId !== -1 || t - lastActivity < LAYOUT.idleMs;
    const idle = !awake && events.length === 0 && !uiUnsettled && ui.activeId === -1 && lastChromeA < 0.01;
    if (idle) {
      // ui.begin normally hands the springs this frame's dt; the overlay's
      // own springs still run, so they get it here instead.
      anim.setDt(dt);
    } else {
      // UI, top layer first so it wins the pointer
      ui.begin(uiEvents, t, dt * 1000, width, height, topList);

      const chromeA = ui.spring('chrome.alpha', awake ? 1 : 0, MOTION.fade);
      // the chrome chips frost only while a window that needs the capture is up
      const frost = ui.spring('chrome.frost', S.panelOpen || mixer.open ? 1 : 0, MOTION.fade);
      lastChromeA = chromeA;
      stepDrawer(ui);   // the slide everything below reads this frame

      drawGuardNotice(ui, app);
      // The two floating windows stack by last touch: a press inside one (or
      // its opening) brings it to the front. The back one is built first with
      // the front one's rect occluded, so it can neither show under nor take
      // a press from it; the front one is built and drawn after, on top.
      if (sequencer.open && !seqWasOpen) frontWin = 'seq';
      if (mixer.open && !mixerWasOpen) frontWin = 'mixer';
      seqWasOpen = sequencer.open; mixerWasOpen = mixer.open;
      if (ui._downEvent) {
        const inS = inWin(sequencer, ui._downX, ui._downY), inM = inWin(mixer, ui._downX, ui._downY);
        if (inS && !(inM && frontWin === 'mixer')) frontWin = 'seq';
        else if (inM && !(inS && frontWin === 'seq')) frontWin = 'mixer';
      }
      const front = frontWin === 'seq' ? sequencer : mixer;
      ui.setOcclusion(front.rx, front.ry, front.rw, front.rh);
      if (frontWin === 'seq') drawMixer(ui, app, chromeA); else drawSequencer(ui, app, chromeA);
      ui.clearOcclusion();
      if (frontWin === 'seq') drawSequencer(ui, app, chromeA); else drawMixer(ui, app, chromeA);
      drawBurger(ui, app, S.panelOpen ? 1 : chromeA, frost);

      ui.dl = uiList;
      drawDrawer(ui, app);
      drawChrome(ui, app, chromeA, frost);

      // the field: any press nothing above claimed. With the drawer open it
      // puts the drawer away, as v0 does; otherwise it starts and stops.
      ui.interact(ui.id('field'), 0, 0, width, height, false);
      if (ui.clicked) { if (S.panelOpen) S.panelOpen = false; else toggleRun(); }

      const res = ui.end();
      uiUnsettled = res.wantsFrames;
      // the pointer goes with the chrome's idle fade and returns on any move
      const cursor = awake ? res.cursor : 'none';
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
    const inset = S.edgeInset;
    renderArgs.lum = r.lum;
    renderArgs.lit = r.lit || !S.running;
    renderArgs.glassVisible = uiList.glassCount + topList.glassCount > 0;
    renderArgs.sceneChanged = S.running || events.length > 0 || inset !== lastInset || overlayState.animating;
    lastInset = inset;
    engine.render(renderArgs);
    if (perfOn) t4 = platform.now();

    // after the submit: nothing below feeds the frame just sent
    if (!metersShown) stepAtmosphere(t, false);   // drift only; the meters are off while unseen
    // worker mode: tell the page's sound what moved this frame
    if (inWorker) host.link.afterFrame();
    // the pending settings save and queued glyphs, on a dark slot (or once
    // they have waited 250 ms, whatever the pattern)
    choreRun(t, darkSlot());

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

  console.log('[boot] layers registered, starting frame loop');
  engine.start(frame);
}
