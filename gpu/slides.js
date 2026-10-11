// Owns the Slides layer (core/schema-slides.js): one of the show's videos,
// played fullscreen over the whole scene, letterboxed (contain, centred,
// black bars), with its sound through its own little chain.
//
// RENDERING PATH: the GPU one, cloned from gpu/sun.js's video texture. A
// hidden <video> element plays the file and each frame imports its current
// picture zero copy (importExternalTexture) for a fullscreen triangle to
// draw. It draws in the scene pass straight after the scene itself (engine
// drawScene), so it covers every layer, and the canvas UI (the drawer, the
// windows, the chrome) is still drawn over it in the same frame, exactly as
// over any other layer. A DOM <video> overlay was the fallback and was not
// needed: this path keeps one canvas, one compositing order and no DOM
// stacking to manage, and the drawer can never end up under the picture.
//
// While the layer is on with a file chosen, the whole frame is black until
// the picture is in, then the picture in its letterbox; with no file (None),
// or a file that would not load, it draws nothing and the scene shows. Off,
// nothing is drawn and the video pauses where it is.
//
// CROSSFADE (S.slideXfade, seconds; 0 a cut): two video elements, slots A
// and B, ping-pong. The live one is never touched: a new file loads into the
// idle slot, which becomes the active one at once (Play, Speed, Loop and
// Restart all act on it from then on), while the old one, now the outgoing
// slot, plays on as it was. Once the new one has a picture the fade runs:
// the outgoing quad drawn as ever, the incoming quad over it at a smoothstep
// alpha, each in its own letterbox; the sound crosses equal-power (cos/sin)
// on each slot's own gain leg. At the end the outgoing slot is stopped and
// emptied. A pick mid-fade (or mid-load) first snaps the running one to its
// end, so there are never more than the two slots and none is left stuck.
// From None (or from the layer just switched on) the new slide fades in over
// black; to None the picture fades out over the scene. A fade (or a wait for
// its picture) keeps the frame loop awake, paused or not (busy).
//
// SOUND: each slot's createMediaElementSource -> its leg (a gain, the
// crossfade) -> the shared highpass -> lowpass -> master gain (Volume x the
// duck) -> destination, in an AudioContext of its own made lazily, the
// first time a video is to play after the page has had a user gesture
// (sticky user activation), so it starts running rather than suspended.
// Before any gesture the videos play muted (a muted play is always
// allowed), and the first pointer or key press builds the chain, unmutes
// them and resumes it. A refused play() is logged, never thrown, and
// retried muted the same way. The filters are Butterworth: Web Audio reads
// a lowpass's or highpass's Q in dB, so Q 0.707 (linear) is set as
// 20 log10(0.7071) = -3.01 dB. Every change glides through setTargetAtTime
// (AUDIO_TC) so a drag never zippers.
//
// Page engine only: a worker engine has no document, so the layer stays
// empty there (as the Sun's does).
//
// Allocation per frame: the external textures (one, two while a fade runs)
// and their bind groups, which WebGPU makes new by design. Nothing else.

import { S } from '../js/state.js';
import { idleHold, idleRelease, idleWake } from '../core/idle.js';
import { SLIDE_DIR, SLIDE_NONE } from '../core/schema-slides.js';

const AUDIO_TC = 0.015;
// the legs follow the fade frame by frame, on a shorter glide
const LEG_TC = 0.008;
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);   // -3.01 dB: linear Q 0.707
// A refused play() is tried again no sooner than this, ms.
const PLAY_RETRY_MS = 1000;
const SL_FLOATS = 8;
const HALF_PI = Math.PI / 2;

const SLIDES_WGSL = `
struct SL {
  rect: vec4f,  // the picture's left, top, width, height in target pixels
  look: vec4f,  // alpha (the crossfade), unused x3
};
@group(0) @binding(0) var<uniform> u: SL;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var samp: sampler;

@vertex
fn vsSlide(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment
fn fsSlide(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let uv = (p.xy - u.rect.xy) / u.rect.zw;
  let c = textureSampleBaseClampToEdge(tex, samp, clamp(uv, vec2f(0.0), vec2f(1.0))).rgb;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  return vec4f(select(vec3f(0.0), c, inside), u.look.x);
}

@fragment
fn fsBlack() -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
`;

const clampNum = (v, lo, hi, def) => typeof v === 'number' && v === v ? (v < lo ? lo : v > hi ? hi : v) : def;
const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

// ---------- the duck ----------
// The show remote's Duck button (show.html, through platform/show-remote.js):
// a multiplier on the slides' gain alone, so the room's video sound drops
// under the speaker's voice and the Sun's hum (its own chain, core/sun-hum.js)
// is never touched. setDuck(mul, seconds): the gain glides to Volume x mul
// along an exponential approach whose time constant is seconds / 3, so it is
// ~95% there after `seconds` (0 is a near cut, a 3 ms constant). It acts at
// once on the running chain, not at the next frame, so it works while the
// frame loop rests. Not saved: a reload is unducked.
let duckMul = 1;
let duckHook = null;   // the live layer's applier (one Slides layer per page)
export function setDuck(mul, seconds) {
  duckMul = clampNum(mul, 0, 1, 1);
  const tc = Math.max(0.003, clampNum(seconds, 0, 10, 0.2) / 3);
  if (duckHook) duckHook(tc);
}

// ---------- the Journey window's play button ----------
// The SLIDE line's play/pause (ui/screens/journey.js) pauses or resumes the
// slide on screen WITHOUT touching S.slidePlay: it sets a live override here
// that the active slot obeys, so nothing is saved, no journey step records
// it (the window's authoring diff compares control positions, and none
// moved) and no walk pins it (journeyManualOverride is never called). The
// override is let go whenever the slide changes (a step's slideFile, a
// pick), Restart is pressed or S.slidePlay itself changes, so the next step
// plays exactly as authored. slidesLiveState(): 0 no slide to play (layer
// off, no file, or one that failed), 1 playing, 2 paused or ended.
let liveHook = null;
export function slidesLiveState() { return liveHook ? liveHook.state() : 0; }
export function toggleSlidePlayLive() { if (liveHook) liveHook.toggle(); }
// The journey walk's pause and resume (core/journey.js setJourneyPauseHook,
// wired in main.js): a pause holds a playing slide through the same live
// override, remembering that it did; the resume lets go only a slide this
// pause held, putting back the override that stood before, so a slide
// paused some other way first stays paused. Any other move of the slide
// (a new slide, Restart, Play, the button) forgets the walk's hold.
export function pauseSlideForWalk() { if (liveHook) liveHook.walkPause(); }
export function resumeSlideForWalk() { if (liveHook) liveHook.walkResume(); }

export function createSlides(device, format) {
  const bgl = device.createBindGroupLayout({
    label: 'slides.bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: SL_FLOATS * 4 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const mod = device.createShaderModule({ label: 'slides.wgsl', code: SLIDES_WGSL });
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn('slides.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }
  // The picture goes over what is beneath at its alpha (1 outside a fade,
  // where it and its bars replace the scene); the black underlay is opaque.
  const over = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
  };
  const pipePicture = device.createRenderPipeline({
    label: 'slides.picture',
    layout: device.createPipelineLayout({ label: 'slides.layout', bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: 'vsSlide' },
    fragment: { module: mod, entryPoint: 'fsSlide', targets: [{ format, blend: over }] },
    primitive: { topology: 'triangle-list' }
  });
  const pipeBlack = device.createRenderPipeline({
    label: 'slides.black',
    layout: device.createPipelineLayout({ label: 'slides.black.layout', bindGroupLayouts: [] }),
    vertex: { module: mod, entryPoint: 'vsSlide' },
    fragment: { module: mod, entryPoint: 'fsBlack', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });
  const sampler = device.createSampler({
    label: 'slides.sampler', magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
  });
  // One uniform block, descriptor and draw entry per drawn picture (the
  // outgoing, then the incoming over it), made once.
  function makePic(k) {
    const buf = device.createBuffer({
      label: 'slides.uniforms.' + k, size: SL_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const entries = [
      { binding: 0, resource: { buffer: buf } },
      { binding: 1, resource: null },
      { binding: 2, resource: sampler }
    ];
    return { buf, uni: new Float32Array(SL_FLOATS), ext: { label: 'slides.frame.' + k, source: null },
             entries, desc: { label: 'slides.bind.' + k, layout: bgl, entries }, bind: null };
  }
  const pics = [makePic(0), makePic(1)];

  let pixelW = 1, pixelH = 1;
  // This frame: whether the black underlay draws, and how many pictures
  // (pics[0..nPics-1], bottom first).
  let drawBlack = false, nPics = 0;

  // ---------- the two slots ----------
  // file: what the element holds ('' empty); failed: it would not load;
  // holding: the frame loop held awake for its first picture; playPending:
  // a play() in flight; retryAt: a refused play's wait; legNow: the gain
  // last aimed at its leg; src/leg: its audio nodes, once the chain exists.
  const slots = [];
  let noDocument = false;
  // The active slot (the one the controls play), the outgoing one during a
  // fade (-1 none), what the layer was last asked to show ('' nothing yet),
  // and the fade: pending (waiting for the incoming picture), running from
  // t0 over dur ms, fromBlack (no outgoing: over black), toNone (no
  // incoming: the outgoing fades out over the scene).
  let act = 0, out = -1, shown = '', wasOn = false;
  const fade = { pending: false, running: false, t0: 0, dur: 0, fromBlack: false, toNone: false, t: 1 };
  let dozing = false, nowMs = 0;
  let playWas = true, restartSeen = 0, outPlays = false;
  // the play button's live override (see toggleSlidePlayLive): null follows
  // S.slidePlay, true or false holds the active slide playing or paused
  let liveOverride = null;
  // whether the walk's pause holds the slide, and the override before it
  let walkHeld = false, walkPrev = null;
  let warnedImport = false;

  function makeSlot(k) {
    const el = document.createElement('video');
    el.playsInline = true;
    el.preload = 'auto';
    // Pitch follows speed.
    el.preservesPitch = false;
    el.mozPreservesPitch = false;
    el.webkitPreservesPitch = false;
    const s = { k, el, file: '', failed: false, holding: false, playPending: false, retryAt: 0, legNow: -1, src: null, leg: null };
    el.addEventListener('loadeddata', () => { release(s, 'a slide video'); idleWake('slide loaded'); });
    el.addEventListener('ended', () => idleWake('slide ended'));
    el.addEventListener('error', () => {
      if (!el.error || !s.file) return;   // an emptied slot's report
      if (!s.failed) {
        s.failed = true;
        console.warn('slides: could not load ' + SLIDE_DIR + s.file + ' (code ' + el.error.code +
          (el.error.message ? ', ' + el.error.message : '') + '). Is it in slides/ and is the page served locally?');
      }
      release(s, 'a slide video failed');
      idleWake('slide failed');
    });
    return s;
  }
  function hold(s) { if (!s.holding) { s.holding = true; idleHold(); } }
  function release(s, why) { if (s.holding) { s.holding = false; idleRelease(why); } }

  function ensureSlots() {
    if (slots.length || noDocument) return;
    if (typeof document === 'undefined') {
      noDocument = true;
      console.warn('slides: no document on this thread (worker engine); the Slides layer needs the page engine');
      return;
    }
    // PORTABILITY: as gpu/sun.js's element, these belong behind a platform
    // hook once one exists.
    slots.push(makeSlot(0), makeSlot(1));
    restartSeen = S.slideRestartN | 0;
  }

  function loadInto(s, file) {
    s.file = file;
    s.failed = false;
    s.retryAt = 0;
    s.playPending = false;
    hold(s);
    setLeg(s, 0);
    s.el.loop = S.slideLoop === true;
    s.el.src = SLIDE_DIR + encodeURIComponent(file);
    // a new source resets the rate to the default rate, so both are set
    const r = clampNum(S.slideRate, 0.25, 2, 1);
    s.el.defaultPlaybackRate = r;
    s.el.playbackRate = r;
  }
  // Stopped and emptied, its decoder let go; ready to take the next file.
  function empty(s) {
    setLeg(s, 0);
    release(s, 'slide emptied');
    s.file = ''; s.failed = false; s.playPending = false;
    try { s.el.pause(); } catch (e) {}
    s.el.removeAttribute('src');
    try { s.el.load(); } catch (e) {}
  }
  const hasFile = s => !!s.file && !s.failed;
  const hasPicture = s => hasFile(s) && s.el.readyState >= 2 && s.el.videoWidth > 0 && s.el.videoHeight > 0;

  // ---------- the sound ----------
  let actx = null, hp = null, lp = null, gain = null, audioFailed = false, gestureArmed = false;
  const hasActivation = () => {
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    return ua ? ua.hasBeenActive : true;
  };
  function buildAudio() {
    if (actx || audioFailed || !slots.length) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC({ latencyHint: 'playback' });
      hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = BUTTERWORTH_Q_DB;
      lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = BUTTERWORTH_Q_DB;
      gain = actx.createGain();
      hp.frequency.value = clampNum(S.slideHP, 20, 20000, 20);
      lp.frequency.value = clampNum(S.slideLP, 20, 20000, 20000);
      gain.gain.value = clampNum(S.slideVolume, 0, 1, 1) * duckMul;
      hp.connect(lp); lp.connect(gain); gain.connect(actx.destination);
      for (const s of slots) {
        s.src = actx.createMediaElementSource(s.el);
        s.leg = actx.createGain();
        s.leg.gain.value = s.legNow >= 0 ? s.legNow : 0;
        s.src.connect(s.leg); s.leg.connect(hp);
        s.el.volume = 1;
      }
    } catch (e) {
      audioFailed = true;
      actx = null;
      console.warn('slides: could not build the sound chain (' + (e && e.message ? e.message : e) + '); the videos play with their own volume only');
    }
  }
  function resumeAudio() {
    if (actx && actx.state !== 'running' && actx.state !== 'closed') {
      actx.resume().catch(err => console.log('slides: the AudioContext would not resume yet: ' + (err && err.message ? err.message : err)));
    }
  }
  // The first pointer or key press after a refused or pre-gesture play:
  // the chain is built, the videos unmuted and resumed, inside the gesture.
  function onGesture() {
    gestureArmed = false;
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    if (!slots.length) return;
    buildAudio();
    resumeAudio();
    // without a chain the elements' own sound is all there is; with one
    // still not running (a resume refused), muting changes nothing heard
    for (const s of slots) { s.el.muted = false; s.retryAt = 0; }
    idleWake('slide sound');
  }
  function armGesture() {
    if (gestureArmed || typeof window === 'undefined') return;
    gestureArmed = true;
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }
  // Without a chain each element's own volume stands in for its leg times
  // the master.
  function elementVolume(s) {
    const v = clampNum(S.slideVolume, 0, 1, 1) * duckMul * (s.legNow >= 0 ? s.legNow : 0);
    if (Math.abs(s.el.volume - v) > 0.001) s.el.volume = v;
  }
  // A slot's crossfade leg, glided; a no-op when it has not moved.
  function setLeg(s, v) {
    if (Math.abs(v - s.legNow) < 0.0005) return;
    s.legNow = v;
    if (s.leg) s.leg.gain.setTargetAtTime(v, actx.currentTime, LEG_TC);
    else elementVolume(s);
  }
  // The chain's settings, glided; each a no-op once it is where S says.
  let lastHP = -1, lastLP = -1, lastVol = -1;
  function syncAudio() {
    const vol = clampNum(S.slideVolume, 0, 1, 1) * duckMul;
    if (!actx) {
      for (const s of slots) elementVolume(s);
      return;
    }
    const t = actx.currentTime;
    const hz1 = clampNum(S.slideHP, 20, 20000, 20), hz2 = clampNum(S.slideLP, 20, 20000, 20000);
    if (hz1 !== lastHP) { lastHP = hz1; hp.frequency.setTargetAtTime(hz1, t, AUDIO_TC); }
    if (hz2 !== lastLP) { lastLP = hz2; lp.frequency.setTargetAtTime(hz2, t, AUDIO_TC); }
    if (vol !== lastVol) { lastVol = vol; gain.gain.setTargetAtTime(vol, t, AUDIO_TC); }
  }
  // The duck, glided from wherever the gain is now (see setDuck); the
  // volume it lands on is noted, so syncAudio does not re-aim it fast.
  duckHook = tc => {
    const vol = clampNum(S.slideVolume, 0, 1, 1) * duckMul;
    if (!actx) { for (const s of slots) elementVolume(s); return; }
    lastVol = vol;
    gain.gain.setTargetAtTime(vol, actx.currentTime, tc);
  };

  // ---------- play and pause ----------
  function play(s) {
    const el = s.el;
    if (!el.paused || s.playPending || nowMs < s.retryAt) return;
    if (!actx && !audioFailed) {
      if (hasActivation()) buildAudio();
      else { for (const o of slots) o.el.muted = true; armGesture(); }
    }
    resumeAudio();
    // a chain that is not running yet waits on the next gesture too
    if (actx && actx.state !== 'running') armGesture();
    s.playPending = true;
    const p = el.play();
    if (p && p.then) p.then(() => { s.playPending = false; }, err => {
      s.playPending = false;
      if (err && err.name === 'AbortError') return;   // a pause or a new source cut it short
      s.retryAt = nowMs + PLAY_RETRY_MS;
      console.log('slides: play() was refused (' + (err && err.message ? err.message : err) + '); playing muted until the next click or key');
      if (!el.muted) { for (const o of slots) o.el.muted = true; s.retryAt = 0; }
      armGesture();
    });
    else s.playPending = false;
  }
  function pause(s) { if (!s.el.paused) s.el.pause(); }

  // ---------- the fade ----------
  // Ends the fade where it stands: at its end, the outgoing slot emptied
  // and the active one at full (still black if its picture is not in yet).
  function finishFade() {
    if (out >= 0) { empty(slots[out]); out = -1; }
    fade.pending = fade.running = fade.fromBlack = fade.toNone = false;
    fade.t = 1;
  }
  // The layer was asked for another file (or None): the running fade
  // snapped to its end first, then a cut or a new fade.
  function change(file) {
    finishFade();
    liveOverride = null; walkHeld = false;
    const xf = clampNum(S.slideXfade, 0, 3, 0.5);
    const cur = slots[act];
    // only a picture already up (on a layer that was on) fades out
    const live = wasOn && hasPicture(cur);
    shown = file;
    if (file === SLIDE_NONE) {
      if (live && xf > 0) {
        // the picture becomes the outgoing slot; the active one is the
        // other, empty (the idle slot is always empty outside a fade)
        out = act; outPlays = !cur.el.paused;
        act = 1 - act;
        fade.toNone = true; fade.running = true; fade.t0 = nowMs; fade.dur = xf * 1000; fade.t = 0;
      } else empty(cur);
      return;
    }
    // the new file into the idle slot, which takes the controls at once
    const next = slots[1 - act];
    if (live && xf > 0) { out = act; outPlays = !cur.el.paused; }
    else empty(cur);
    act = 1 - act;
    loadInto(next, file);
    if (xf > 0) {
      fade.pending = true; fade.fromBlack = out < 0; fade.dur = xf * 1000; fade.t = 0;
    }
  }

  function resize(pw, ph) {
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
  }

  function doze(on) {
    dozing = !!on;
    if (dozing) for (const s of slots) pause(s);
  }

  // One picture into pics[nPics], at alpha a, in its own letterbox.
  function addPic(s, a) {
    if (a <= 0.001 || !hasPicture(s)) return;
    const pk = pics[nPics];
    let ext = null;
    try {
      pk.ext.source = s.el;
      ext = device.importExternalTexture(pk.ext);
    } catch (e) {
      if (!warnedImport) {
        warnedImport = true;
        console.warn('slides: could not import the video frame:', e && e.message ? e.message : e);
      }
      return;
    }
    const vw = s.el.videoWidth, vh = s.el.videoHeight;
    const k = Math.min(pixelW / vw, pixelH / vh);
    const w = vw * k, h = vh * k, u = pk.uni;
    u[0] = (pixelW - w) * 0.5; u[1] = (pixelH - h) * 0.5; u[2] = w; u[3] = h;
    u[4] = a > 1 ? 1 : a;
    device.queue.writeBuffer(pk.buf, 0, u);
    pk.entries[1].resource = ext;
    pk.bind = device.createBindGroup(pk.desc);
    pk.entries[1].resource = null;
    nPics++;
  }

  function update(t) {
    nowMs = t;
    drawBlack = false; nPics = 0;
    pics[0].bind = pics[1].bind = null;
    const on = !!(S.layers && S.layers.slides);
    const file = typeof S.slideFile === 'string' ? S.slideFile : SLIDE_NONE;
    const wantPlay = S.slidePlay !== false;
    if (!on) {
      // Off: any fade lands at its end, the active slide pauses where it is
      if (slots.length) {
        finishFade();
        pause(slots[act]);
        release(slots[act], 'slides off');
      }
      wasOn = false;
      playWas = wantPlay;
      return;
    }
    if (file === SLIDE_NONE && (shown === '' || shown === SLIDE_NONE) && out < 0) {
      // nothing to show and nothing fading out
      shown = SLIDE_NONE;
      wasOn = true;
      playWas = wantPlay;
      return;
    }
    ensureSlots();
    if (!slots.length) { drawBlack = file !== SLIDE_NONE; return; }
    // A slide the layer holds from before it was switched off, switched on
    // again with the same file, simply carries on (no fade).
    if (file !== shown || (!wasOn && file !== SLIDE_NONE && !slots[act].file)) change(file);
    wasOn = true;
    const cur = slots[act];

    // The fade's clock: a pending one starts once the incoming picture is
    // in (or the incoming failed, which ends it: nothing is left to show).
    if (fade.pending) {
      if (cur.failed) finishFade();
      else if (hasPicture(cur)) { fade.pending = false; fade.running = true; fade.t0 = nowMs; fade.t = 0; }
    }
    if (fade.running) {
      fade.t = fade.dur > 0 ? (nowMs - fade.t0) / fade.dur : 1;
      if (fade.t >= 1) { finishFade(); if (shown === SLIDE_NONE) empty(cur); }
    }

    // ---- the active slot: Play, Loop, Speed, Restart ----
    if (hasFile(cur)) {
      const loop = S.slideLoop === true;
      if (cur.el.loop !== loop) cur.el.loop = loop;
      const rate = clampNum(S.slideRate, 0.25, 2, 1);
      if (Math.abs(cur.el.playbackRate - rate) > 0.001) { cur.el.playbackRate = rate; cur.el.defaultPlaybackRate = rate; }
      const rn = S.slideRestartN | 0;
      if (rn !== restartSeen) {
        restartSeen = rn;
        liveOverride = null; walkHeld = false;
        try { cur.el.currentTime = 0; } catch (e) {}
      }
      // Play itself moved (the drawer, a step, the remote): the button's
      // override gives way to it.
      if (wantPlay !== playWas) { liveOverride = null; walkHeld = false; }
      // Play switched back on over a finished video starts it again.
      if (wantPlay && !playWas && cur.el.ended) { try { cur.el.currentTime = 0; } catch (e) {} }
      const playOn = liveOverride !== null ? liveOverride : wantPlay;
      if (playOn && !dozing) { if (!cur.el.ended) play(cur); }
      else pause(cur);
    } else restartSeen = S.slideRestartN | 0;
    playWas = wantPlay;
    // the outgoing slot plays on as it was, until it is emptied
    if (out >= 0) {
      const o = slots[out];
      if (outPlays && !dozing && !o.el.ended) play(o); else pause(o);
    }

    // ---- the sound: equal power across the fade ----
    const lin = fade.running ? (fade.t < 0 ? 0 : fade.t > 1 ? 1 : fade.t) : fade.pending ? 0 : 1;
    const inGain = shown === SLIDE_NONE ? 0 : Math.sin(lin * HALF_PI);
    setLeg(cur, hasFile(cur) ? inGain : 0);
    if (out >= 0) setLeg(slots[out], Math.cos(lin * HALF_PI));
    else setLeg(slots[1 - act], 0);
    syncAudio();

    // ---- the picture ----
    // Black under a slide still loading or fading in from nothing; then the
    // outgoing picture, then the incoming over it.
    const alpha = smooth(lin);
    if (fade.toNone) {
      addPic(slots[out], 1 - alpha);
      return;
    }
    if (out < 0 && hasFile(cur) && (fade.fromBlack || fade.pending || !hasPicture(cur))) drawBlack = true;
    if (out >= 0) addPic(slots[out], 1);
    if (hasFile(cur)) addPic(cur, fade.pending ? 0 : alpha);
  }

  // In the scene pass, after everything else the scene draws.
  function draw(pass) {
    if (drawBlack) {
      pass.setPipeline(pipeBlack);
      pass.draw(3);
    }
    if (nPics > 0) {
      pass.setPipeline(pipePicture);
      for (let i = 0; i < nPics; i++) {
        pass.setBindGroup(0, pics[i].bind);
        pass.draw(3);
      }
    }
  }

  liveHook = {
    state() {
      if (!(S.layers && S.layers.slides) || !slots.length) return 0;
      const cur = slots[act];
      if (!hasFile(cur)) return 0;
      const playOn = liveOverride !== null ? liveOverride : S.slidePlay !== false;
      return playOn && !cur.el.ended ? 1 : 2;
    },
    toggle() {
      const st = liveHook.state();
      if (!st) return;
      walkHeld = false;
      if (st === 1) liveOverride = false;
      else {
        liveOverride = true;
        const cur = slots[act];
        if (cur.el.ended) { try { cur.el.currentTime = 0; } catch (e) {} }
      }
      idleWake('slide play button');
    },
    walkPause() {
      if (liveHook.state() !== 1) return;
      walkPrev = liveOverride;
      liveOverride = false;
      walkHeld = true;
      idleWake('slide walk pause');
    },
    walkResume() {
      if (!walkHeld) return;
      walkHeld = false;
      liveOverride = walkPrev;
      walkPrev = null;
      idleWake('slide walk resume');
    }
  };

  // A playing video, or a fade running or waiting for its picture, keeps the
  // frame loop awake (main.js's still frame asks), paused or not.
  const busy = () => fade.pending || fade.running || out >= 0 ||
    ((drawBlack || nPics > 0) && slots.length > 0 && !slots[act].el.paused && !slots[act].el.ended);

  return { update, draw, resize, doze, busy };
}
