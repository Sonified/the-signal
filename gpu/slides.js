// Owns the Slides layer (core/schema-slides.js): one of the show's videos,
// played fullscreen over the whole scene, letterboxed (contain, centred,
// black bars), with its sound through its own little chain into the app's
// output.
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
// While the layer is on with a file chosen, the scene shows until the
// picture is in, then the picture fades up in its letterbox; with no file
// (None), or a file that would not load, it draws nothing and the scene
// shows. The layer switching OFF is a change to None: the picture fades out
// over the scene on the same Crossfade, and the slot is emptied at the end
// (so switching back on starts the file afresh, through its own fade up).
//
// CROSSFADE (S.slideXfade, seconds; 0 a cut): a small pool of video
// elements (voices), two to start, more made as quick picks need them, up
// to MAX_VOICES. The live one is never touched: a new file loads into a free
// voice, which becomes the active one at once (Play, Speed, Loop and Restart
// all act on it from then on), while the old one joins the outgoing stack
// and plays on as it was. Once the new one has a picture the fade runs: the
// outgoing pictures drawn beneath, held at the alpha each had when it left,
// the incoming over them at a smoothstep alpha, each in its own letterbox;
// the sound crosses equal-power, each outgoing voice from the level it had
// when it left (cos) down to 0, the incoming up (sin). So a pick mid-fade
// never cuts anything: the slide fading in leaves from where it stands and
// the older ones carry on fading on their own clocks. Outgoing clocks wait
// while the incoming has no picture yet (they play on at their level), and
// an incoming that never got one is simply dropped by the next pick, since
// it is silent and unseen. An outgoing voice is emptied once it is silent
// and its picture hidden (covered by an opaque one above, or faded out).
// Only past MAX_VOICES does the oldest, deepest voice give way at once.
// From None (or from the layer just switched on) the new slide fades in
// over the scene - the stars stay up under it until it lands; to None (or
// the layer switched off) the picture fades out over the scene the same
// way. A fade (or a wait for its picture) keeps the frame loop awake,
// paused or not (busy).
//
// PLAY / PAUSE RAMPS (S.slidePpOut, S.slidePpIn, S.slidePpRamp): the active
// slide never starts or stops dead. A run factor pp (1 playing, 0 stopped)
// glides to 0 over Fade out and back to 1 over Fade in, whatever asked for
// the pause or the play (the Play switch, the Journey's button and Space,
// the walk, the remote). The sound's leg is scaled by pp, through the same
// glided gain the crossfade rides, and at 0 the element is paused. With
// Audio speed ramp on, the video's rate is Speed x pp too (floored at
// MIN_RATE), so picture and pitch wind down and back up like a turntable;
// off, the rate is never touched and the sound only fades. A new slide,
// the layer switched on, and a doze start at their target, with no ramp.
//
// SOUND: each slot's createMediaElementSource -> its leg (a gain, the
// crossfade) -> the app's global highpass -> lowpass (core/global-filter.js,
// the Audio section's lpf and hpf, which every chain in the app carries) ->
// master gain (Master slide volume x the app's Master volume x the duck) ->
// the app's output bus (js/audio.js getOutputBus): past its master, whose
// volume, pause gate and transport ramps are not the slides', into the
// output guard (core/output-guard.js, the limiter and soft clip) every
// sound shares on its way to the destination. It lives in the app's own
// context, the chain built lazily the first time a video is to play after
// the page has had a user gesture (sticky user activation), and that
// context resumed then if nothing has woken it yet. Nothing in the app
// suspends that context, so a pause of the transport leaves the slides
// playing as before; when the system suspends it (a locked phone) the
// slides go quiet with everything else and wake with it.
// Before any gesture the videos play muted (a muted play is always
// allowed), and the first pointer or key press builds the chain, unmutes
// them and resumes it. A refused play() is logged, never thrown, and
// retried muted the same way. Every change glides through setTargetAtTime
// (AUDIO_TC) so a drag never zippers.
//
// Page engine only: a worker engine has no document, so the layer stays
// empty there (as the Sun's does).
//
// Allocation per frame: the external textures (one, more while a fade runs)
// and their bind groups, which WebGPU makes new by design. Nothing else.

import { S } from '../js/state.js';
import { idleHold, idleRelease, idleWake } from '../core/idle.js';
import { SLIDE_DIR, SLIDE_NONE, slideVolOf, slideVolGain } from '../core/schema-slides.js';
import { createGlobalFilter } from '../core/global-filter.js';
import { ensureAudioGraph, getContext, getOutputBus } from '../js/audio.js';

const AUDIO_TC = 0.015;
// Speed follows incoming control values with a 25 ms exponential time
// constant. S.slideRate remains the authored/requested value.
const SPEED_TC_MS = 25;
// The element's own floor: Chrome refuses playbackRate between 0 and
// 0.0625 (and mutes beneath it anyway), while exactly 0 is allowed and
// freezes the picture. So any rate asked below the floor lands AT the
// floor, and only a true 0 stops the movie.
const MIN_RATE = 0.0625;
const elRate = r => r > 0 ? Math.max(MIN_RATE, r) : 0;
// how long a rate of 0 keeps the element at its floor before freezing it:
// ten of the legs' time constants, so the gain is below hearing first
const RATE_ZERO_MS = 80;
// the legs follow the fade frame by frame, on a shorter glide
const LEG_TC = 0.008;
// A refused play() is tried again no sooner than this, ms.
const PLAY_RETRY_MS = 1000;
// The most video elements alive at once (see CROSSFADE).
const MAX_VOICES = 6;
// A seek's crossfade (the show remote's tap on the playing cue), seconds:
// short, whatever the slides' own Crossfade is.
const SEEK_XF = 0.25;
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
// The Volume setting (0 to 1) to a gain, on a cubed taper: the ear hears
// level in decibels, so a straight gain did almost nothing over the top
// three quarters of the fader. Cubed, 75% is about -7.5 dB, 50% -18 dB and
// 25% -36 dB, so the fader works evenly along its whole length.
const slideGain = S => { const v = clampNum(S.slideVolume, 0, 1, 1); return v * v * v; };
// A slide's remembered level keeps the cubed taper below 100%; above it,
// the percentage is a gain multiplier (200% = 2x).
const fileGain = f => slideVolGain(slideVolOf(S, f));
// What reaches the duck: the layer's own level times the app's Master
// volume (S.volume, the drawer's 'vol' and the show remote's VOLUME fader,
// the same straight gain js/audio.js's master gives every voice).
const outGain = S => slideGain(S) * clampNum(S.volume, 0, 1, 0.5);
const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

// ---------- the duck ----------
// The show remote's Duck button (show.html, through platform/show-remote.js):
// a multiplier on the slides' gain, so the room's video sound drops under
// the speaker's voice; the heartbeat and the Sun's hum take the same
// multiplier on their own levels (core/heartbeat.js setHeartDuck,
// core/sun-hum.js setHumDuck). setDuck(mul, seconds): the gain glides to Volume x mul
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
// Space on a slide that has played to its end (main.js): it starts again
// from the top, as the play button would; true when it did.
export function replayEndedSlide() { return liveHook ? liveHook.replay() : false; }
// The journey walk's pause and resume (core/journey.js setJourneyPauseHook,
// wired in main.js): a pause holds a playing slide through the same live
// override, remembering that it did; the resume lets go only a slide this
// pause held, putting back the override that stood before, so a slide
// paused some other way first stays paused. Any other move of the slide
// (a new slide, Restart, Play, the button) forgets the walk's hold.
// The show remote's cue fill (platform/show-remote.js): where the slide on
// screen stands, {t, d, r, f, l} (seconds in, its length, the rate it is
// advancing at, 0 paused or ended), or null with no video of known length.
export function slidesProgress() { return liveHook ? liveHook.progress() : null; }
// and its seek: a tap on the playing cue puts the video at that share of
// its length, f 0..1, playing or held as it was
export function seekSlide(f) { if (liveHook) liveHook.seek(f); }
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
  // outgoing ones, then the incoming over them), each made once, when first
  // needed.
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
  const pics = [];

  let pixelW = 1, pixelH = 1;
  // This frame: whether the black underlay draws, and how many pictures
  // (pics[0..nPics-1], bottom first).
  let drawBlack = false, nPics = 0;

  // ---------- the voices ----------
  // file: what the element holds ('' empty); failed: it would not load;
  // holding: the frame loop held awake for its first picture; playPending:
  // a play() in flight; retryAt: a refused play's wait; legNow: the gain
  // last aimed at its leg; src/leg: its audio nodes, once the chain exists.
  // While outgoing: g0 and a0, its leg gain and picture alpha when it left;
  // p, its fade's progress (0 to 1) over dur ms; plays, whether it was
  // playing; v, its picture's fade out over the scene (-1 none) over vdur.
  const slots = [];
  let noDocument = false;
  // The active slot's index (the one the controls play), the outgoing stack
  // (oldest, deepest first), what the layer was last asked to show ('' nothing
  // yet), and the incoming's fade: pending (waiting for its picture), running
  // from t0 over dur ms. wasOn: a picture has been up this session (no fade
  // out of a freshly restored boot). lastMs: the previous frame, for the
  // outgoing clocks.
  let act = 0, shown = '', wasOn = false;
  const outs = [];
  const fade = { pending: false, running: false, t0: 0, dur: 0, t: 1 };
  let dozing = false, nowMs = 0, lastMs = 0;
  let playWas = true, restartSeen = 0;
  // the play/pause run factor (see the header): 1 running, 0 stopped; ppInit
  // false means the next frame sets it straight to its target
  let pp = 1, ppInit = false, ppMs = 0, ppMoving = false;
  // when the asked rate reached 0 (-1 not there): the element holds at its
  // floor until the gain leg has run out, and only then freezes
  let rateZeroAt = -1;
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
    const s = { k, el, file: '', failed: false, holding: false, playPending: false, retryAt: 0, legNow: -1, src: null, leg: null,
                g0: 0, a0: 0, p: 0, dur: 0, plays: false, v: -1, vdur: 0, speed: 1, speedMoving: false };
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
  // A voice neither active nor outgoing (always empty), made new while the
  // pool has room; past MAX_VOICES the oldest outgoing one gives way.
  function freeSlot() {
    for (const s of slots) if (s !== slots[act] && !outs.includes(s)) return s;
    if (slots.length < MAX_VOICES) {
      const s = makeSlot(slots.length);
      s.el.muted = slots[0].el.muted;
      if (actx) {
        try { wire(s); } catch (e) { console.warn('slides: a new voice could not join the sound chain (' + (e && e.message ? e.message : e) + ')'); }
      }
      slots.push(s);
      return s;
    }
    const s = outs.shift();
    empty(s);
    return s;
  }

  // at: where to start, seconds (a seek's voice), through the URL's media
  // fragment, so the first picture it reports is already the one at that time
  function loadInto(s, file, at) {
    s.file = file;
    s.failed = false;
    s.retryAt = 0;
    s.playPending = false;
    hold(s);
    setLeg(s, 0);
    s.el.loop = S.slideLoop === true;
    s.el.src = SLIDE_DIR + encodeURIComponent(file) + (at > 0 ? '#t=' + at.toFixed(3) : '');
    // a new source resets the rate to the default rate, so both are set
    s.speed = clampNum(S.slideRate, 0, 2, 1);
    s.speedMoving = false;
    const r = elRate(s.speed);
    s.el.defaultPlaybackRate = r;
    s.el.playbackRate = r;
  }
  // Stopped and emptied, its decoder let go; ready to take the next file.
  function empty(s) {
    setLeg(s, 0);
    release(s, 'slide emptied');
    s.file = ''; s.failed = false; s.playPending = false; s.speedMoving = false;
    try { s.el.pause(); } catch (e) {}
    s.el.removeAttribute('src');
    try { s.el.load(); } catch (e) {}
  }
  const hasFile = s => !!s.file && !s.failed;
  const hasPicture = s => hasFile(s) && s.el.readyState >= 2 && s.el.videoWidth > 0 && s.el.videoHeight > 0;

  // ---------- the sound ----------
  let actx = null, gf = null, gain = null, audioFailed = false, gestureArmed = false;
  const hasActivation = () => {
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    return ua ? ua.hasBeenActive : true;
  };
  // The chain is built in the app's own context (js/audio.js), ending at
  // its output bus: after the master, so the transport's pause gate, ramps
  // and Master volume (which outGain already carries) never act on it twice,
  // and before the output guard, so the slides share the app's limiter and
  // soft clip. ensureAudioGraph makes the context and the bus before its
  // first await, so they are there the moment it returns (main.js has
  // asked for it at boot anyway); with neither, the chain is given up and
  // the elements' own volume stands in, as for any chain that cannot build.
  function buildAudio() {
    if (actx || audioFailed || !slots.length) return;
    try {
      ensureAudioGraph();
      const ctx = getContext(), bus = getOutputBus();
      if (!ctx || !bus) throw new Error('the app has no audio graph');
      actx = ctx;
      // the global pair, which follows the Audio section's lpf and hpf itself
      gf = createGlobalFilter(actx);
      gain = actx.createGain();
      gain.gain.value = outGain(S) * duckMul;
      gf.output.connect(gain); gain.connect(bus);
      for (const s of slots) wire(s);
    } catch (e) {
      audioFailed = true;
      actx = null;
      console.warn('slides: could not build the sound chain (' + (e && e.message ? e.message : e) + '); the videos play with their own volume only');
    }
  }
  // A voice into the chain: its element's source -> its leg -> the filter.
  function wire(s) {
    s.src = actx.createMediaElementSource(s.el);
    s.leg = actx.createGain();
    s.leg.gain.value = s.legNow >= 0 ? s.legNow : 0;
    s.src.connect(s.leg); s.leg.connect(gf.input);
    s.el.volume = 1;
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
  // the master, held at the element's own ceiling of 1 (a slide set above
  // 100% only gets its boost through the chain's gain).
  function elementVolume(s) {
    const v = Math.min(1, outGain(S) * duckMul * (s.legNow >= 0 ? s.legNow : 0));
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
  let lastVol = -1;
  function syncAudio() {
    const vol = outGain(S) * duckMul;
    if (!actx) {
      for (const s of slots) elementVolume(s);
      return;
    }
    if (vol !== lastVol) { lastVol = vol; gain.gain.setTargetAtTime(vol, actx.currentTime, AUDIO_TC); }
  }
  // The duck, glided from wherever the gain is now (see setDuck); the
  // volume it lands on is noted, so syncAudio does not re-aim it fast.
  duckHook = tc => {
    const vol = outGain(S) * duckMul;
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
  // The incoming's progress: 0 waiting for its picture, 1 fully in.
  const fadeLin = () => fade.running ? (fade.t < 0 ? 0 : fade.t > 1 ? 1 : fade.t) : fade.pending ? 0 : 1;
  // An outgoing voice's picture starts fading out over the scene (nothing
  // will come to cover it), from the alpha it holds.
  function vanish(o, xf) { if (o.v < 0) { o.v = 0; o.vdur = xf * 1000; } }
  // The layer was asked for another file (or None). The active voice, if
  // its picture is up, joins the outgoing stack from the level and alpha it
  // has right now, and fades out on its own clock; nothing already fading
  // is touched. One still loading is silent and unseen, so it just empties.
  function change(file) {
    seekTo = null;
    liveOverride = null; walkHeld = false; ppInit = false;
    const xf = clampNum(S.slideXfade, 0, 10, 0.5);
    const cur = slots[act];
    // only a picture already up (on a layer that was on) fades out
    const live = wasOn && hasPicture(cur);
    shown = file;
    if (live && xf > 0) {
      cur.g0 = cur.legNow >= 0 ? cur.legNow : 0;
      cur.a0 = smooth(fadeLin());
      cur.p = 0; cur.dur = xf * 1000; cur.plays = !cur.el.paused; cur.v = -1;
      outs.push(cur);
      act = freeSlot().k;
    } else empty(cur);
    // a cut takes everything still fading with it
    if (!(xf > 0)) { for (const o of outs) empty(o); outs.length = 0; }
    fade.pending = fade.running = false; fade.t = 1;
    // None leaves the active voice empty; the stack fades out over the
    // scene (update starts each one's vanish, as nothing is coming)
    if (file === SLIDE_NONE) return;
    // the new file into the active voice, which takes the controls at once
    loadInto(slots[act], file);
    if (xf > 0) { fade.pending = true; fade.dur = xf * 1000; fade.t = 0; }
  }

  // SEEK (seekSlide): the same file loads into a free voice at the new time
  // and takes the controls at once, while the voice that was playing joins
  // the outgoing stack and plays on, heard and seen, until the new one has
  // its picture; then the two cross on SEEK_XF, the sound equal power, the
  // picture smoothstep, exactly as a change of slide does. Seeking the one
  // element in place would flush its decoder (black) and jump its sound
  // mid-waveform (a click). Play, pause, the live override and the run
  // factor carry over untouched: a held slide seeks and stays held. A seek
  // while the last one is still waiting for its picture just reloads that
  // waiting voice at the newer time. seekTo: what the iPad's bar shows while
  // the new voice has not yet learned its length.
  let seekTo = null;
  function seek(f) {
    const cur = slots[act];
    if (!hasFile(cur)) return;
    const prev = outs.length ? outs[outs.length - 1] : null;
    let d = cur.el.duration;
    if (!(d > 0 && isFinite(d)) && prev && prev.file === cur.file) d = prev.el.duration;
    if (!(d > 0 && isFinite(d))) return;
    const at = Math.max(0, Math.min(1, f)) * d;
    if (hasPicture(cur) && wasOn) {
      cur.g0 = cur.legNow >= 0 ? cur.legNow : 0;
      cur.a0 = smooth(fadeLin());
      cur.p = 0; cur.dur = SEEK_XF * 1000; cur.plays = !cur.el.paused; cur.v = -1;
      outs.push(cur);
      act = freeSlot().k;
    } else if (!outs.length) {
      // nothing on screen to cover the wait: a plain seek
      try { cur.el.currentTime = at; } catch (e) {}
      return;
    } else empty(cur);
    loadInto(slots[act], cur.file, at);
    fade.pending = true; fade.running = false; fade.dur = SEEK_XF * 1000; fade.t = 0;
    seekTo = { file: cur.file, at, d };
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
    if (nPics === pics.length) pics.push(makePic(nPics));
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
    // the outgoing clocks' step, capped as the run factor's is
    const dtMs = Math.min(100, Math.max(0, t - lastMs));
    nowMs = lastMs = t;
    drawBlack = false; nPics = 0;
    for (const pk of pics) pk.bind = null;
    const on = !!(S.layers && S.layers.slides);
    // The layer off is a change to None: the picture fades out over the
    // scene on the Crossfade, through the very same path below.
    const file = on && typeof S.slideFile === 'string' ? S.slideFile : SLIDE_NONE;
    const wantPlay = S.slidePlay !== false;
    if (file === SLIDE_NONE && (shown === '' || shown === SLIDE_NONE) && !outs.length) {
      // nothing to show and nothing fading out
      shown = SLIDE_NONE;
      wasOn = true;
      playWas = wantPlay;
      return;
    }
    ensureSlots();
    if (!slots.length) { drawBlack = file !== SLIDE_NONE; return; }
    if (file !== shown) change(file);
    wasOn = true;
    const cur = slots[act];

    // The fade's clock: a pending one starts once the incoming picture is
    // in (or the incoming failed, which ends it: nothing is left to show).
    if (fade.pending) {
      if (cur.failed) { fade.pending = false; fade.t = 1; }
      else if (hasPicture(cur) && !cur.el.seeking) { fade.pending = false; fade.running = true; fade.t0 = nowMs; fade.t = 0; }
    }
    if (fade.running) {
      fade.t = fade.dur > 0 ? (nowMs - fade.t0) / fade.dur : 1;
      if (fade.t >= 1) { fade.running = false; fade.t = 1; }
    }

    // The outgoing clocks run while nothing waits on an incoming picture.
    // With nothing coming (None, or an incoming that failed) each picture
    // fades out over the scene too. A voice goes once it is silent and its
    // picture is hidden: faded out, or under an opaque picture above it.
    if (outs.length) {
      const xf = clampNum(S.slideXfade, 0, 10, 0.5);
      const run = !fade.pending;
      let covered = hasPicture(cur) && fadeLin() >= 1;
      for (let i = outs.length - 1; i >= 0; i--) {
        const o = outs[i];
        if (!hasFile(cur)) vanish(o, xf);
        if (run) {
          o.p = o.dur > 0 ? Math.min(1, o.p + dtMs / o.dur) : 1;
          if (o.v >= 0) o.v = o.vdur > 0 ? Math.min(1, o.v + dtMs / o.vdur) : 1;
        }
        const a = o.v >= 0 ? o.a0 * (1 - smooth(o.v)) : o.a0;
        if (o.p >= 1 && (covered || a <= 0.001 || !hasPicture(o))) { outs.splice(i, 1); empty(o); }
        else if (a >= 0.999 && hasPicture(o)) covered = true;
      }
    }

    // ---- the active slot: Play, Loop, Speed, Restart ----
    let ppGain = 1, rateGain = 1;
    if (hasFile(cur)) {
      const loop = S.slideLoop === true;
      if (cur.el.loop !== loop) cur.el.loop = loop;
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
      // the run factor glides toward 1 or 0; a first frame, a doze or a
      // finished video takes its target at once
      const target = playOn && !cur.el.ended ? 1 : 0;
      // a ramp's first frame counts one 60 Hz tick, however long the loop
      // had rested before it; later frames count their own time, capped
      const dt = ppMoving ? Math.min(0.1, Math.max(0, (nowMs - ppMs) / 1000)) : 1 / 60;
      ppMs = nowMs;
      if (!ppInit || dozing || cur.el.ended) { pp = target; ppInit = true; }
      else if (pp !== target) {
        const secs = clampNum(target > pp ? S.slidePpIn : S.slidePpOut, 0, 1, 0.2);
        const step = secs > 0 ? dt / secs : 1;
        pp = target > pp ? Math.min(target, pp + step) : Math.max(target, pp - step);
      }
      ppMoving = pp !== target;
      ppGain = pp;
      // The picture's rate: Speed, times the run factor only when Audio
      // speed ramp is on (the turntable; pitch follows, as the element is
      // built). Off, the rate is never touched by a pause: the sound just
      // fades on its gain leg and the picture stops when it reaches 0.
      const targetRate = clampNum(S.slideRate, 0, 2, 1);
      // Retarget from the speed already reached, including uneven network
      // arrivals. A paused player's first wake counts one frame rather than
      // its entire idle interval; subsequent frames use elapsed time.
      const speedDt = cur.speedMoving || !cur.el.paused ? dtMs : Math.min(dtMs, 1000 / 60);
      cur.speed += (targetRate - cur.speed) * -Math.expm1(-speedDt / SPEED_TC_MS);
      cur.speedMoving = Math.abs(targetRate - cur.speed) > .0001;
      // Exponential decay needs a finite landing so exact zero can still
      // reach the existing silent stop below the element's rate floor.
      if (!cur.speedMoving) cur.speed = targetRate;
      const rate = cur.speed;
      const want = S.slidePpRamp === true && pp < 1 ? rate * pp : rate;
      // Under the element's floor the rate holds at 6.25% while the gain
      // takes the last of the slow-down to silence. A true 0 freezes the
      // picture only after the leg has had RATE_ZERO_MS to run out - a
      // flick straight to 0 must not freeze the pipeline mid-waveform on
      // the very frame the fade starts (the click).
      let eff;
      if (want >= MIN_RATE) { rateZeroAt = -1; eff = want; }
      else {
        rateGain = want / MIN_RATE;
        if (want > 0) rateZeroAt = -1;
        else if (rateZeroAt < 0) rateZeroAt = nowMs;
        eff = rateZeroAt >= 0 && nowMs - rateZeroAt >= RATE_ZERO_MS ? 0 : MIN_RATE;
      }
      if (Math.abs(cur.el.playbackRate - eff) > 0.001) { try { cur.el.playbackRate = eff; } catch (e) {} cur.el.defaultPlaybackRate = eff; }
      if (pp > 0 && !dozing) { if (!cur.el.ended) play(cur); }
      else pause(cur);
    } else { restartSeen = S.slideRestartN | 0; ppInit = false; ppMoving = false; }
    playWas = wantPlay;
    // the outgoing voices play on as they were, until each is emptied
    for (const o of outs) {
      if (o.plays && !dozing && !o.el.ended) play(o); else pause(o);
    }

    // ---- the sound: equal power across the fade ----
    // the incoming up on sin, each outgoing down on cos from where it left
    const lin = fadeLin();
    const inGain = shown === SLIDE_NONE ? 0 : Math.sin(lin * HALF_PI);
    setLeg(cur, hasFile(cur) ? inGain * ppGain * rateGain * fileGain(cur.file) : 0);
    for (const o of outs) setLeg(o, o.g0 * Math.cos(o.p * HALF_PI));
    syncAudio();

    // ---- the picture ----
    // The outgoing pictures, deepest first, each at the alpha it left with
    // (fading out over the scene when nothing is coming), then the incoming
    // over them.
    for (const o of outs) addPic(o, o.v >= 0 ? o.a0 * (1 - smooth(o.v)) : o.a0);
    if (hasFile(cur)) addPic(cur, fade.pending ? 0 : smooth(lin));
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
    replay() {
      if (liveHook.state() !== 2 || !slots[act].el.ended) return false;
      liveHook.toggle();
      return true;
    },
    walkPause() {
      if (liveHook.state() !== 1) return;
      walkPrev = liveOverride;
      liveOverride = false;
      walkHeld = true;
      idleWake('slide walk pause');
    },
    progress() {
      const st = liveHook.state();
      if (!st) return null;
      const el = slots[act].el;
      const d = el.duration;
      if (!(d > 0 && isFinite(d))) {
        // a seek's voice still learning its length: where it is going
        return seekTo && seekTo.file === slots[act].file ? { t: seekTo.at, d: seekTo.d, r: 0, f: slots[act].file, l: el.loop } : null;
      }
      return { t: Math.max(0, Math.min(d, el.currentTime || 0)), d, r: st === 1 && !el.paused ? el.playbackRate : 0,
        f: slots[act].file, l: el.loop };
    },
    seek(f) {
      if (!liveHook.state() || !isFinite(f)) return;
      seek(f);
      idleWake('slide seek');
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
  const busy = () => fade.pending || fade.running || outs.length > 0 || ppMoving || slots[act]?.speedMoving || (rateZeroAt >= 0 && nowMs - rateZeroAt < RATE_ZERO_MS + 100) ||
    ((drawBlack || nPics > 0) && slots.length > 0 && !slots[act].el.paused && !slots[act].el.ended);

  return { update, draw, resize, doze, busy };
}
