// Owns the Sun layer: NASA SDO footage of the sun, streamed as one mosaic
// video, its five channels tinted and mixed as light, drawn as the whole
// square tile at the field centre, its edge taken away by the site's own
// circular feather so the corona melts into the room (sun.wgsl.js). It reads S every frame and does no work at all while
// S.layers.sun is off; nothing is made or fetched until it first comes on.
//
// The source is meditatewiththesun.com's: one MP4 whose frame is a 3 x 2
// grid of tiles, one SDO channel each (row 0: 1700, 0304, 0171; row 1: 0193,
// 0211, black), 30 fps. A hidden video element plays it (HEVC where the
// browser says it can, the x264 file otherwise, and the x264 file once more
// if the HEVC one fails), and each frame imports the current picture zero
// copy (importExternalTexture) for sun.wgsl.js to composite. An external
// texture lives only until the task that imported it ends, so it is imported
// fresh in update() and its bind group made with it; render() submits in the
// same task. The element loops plainly: the site's crossfade over the loop's
// edge is out of scope for v1, so the loop is a cut.
//
// The breath is the layer's master signal: one sine, S.sunBreathRate breaths
// a minute on the layer's motion clock (a paused scene holds it), with two
// consumers in step. The Atmosphere: the five channels sit along a
// temperature axis at i/4 in the order above, and the sweep position, the
// setting plus half the Breath amount times the sine, lights the pair it
// falls between (smoothstep crossfade), so an inhale climbs toward the
// corona and an exhale settles back toward the photosphere. And the
// feedback's stream, while Link is on: the stream rate sweeps from Stream
// lo to Stream hi with the same sine, so the sun's light flows outward on
// the high of the breath and back in on the low.
//
// Feedback (gpu/feedback.js) is kaleido.js's trails discipline: the live
// picture draws straight into the scene as ever; with Feedback amount above
// 0 the same picture also goes into an image of the layer's own, over a
// faded, streamed copy of the last, and that image is laid over the scene
// just before the live draw, so the echoes sit under the present. At amount
// 0 there is no image and no pass. The Center fade (S.sunFbGate, the site's
// gate) keeps the inner sun out of what feeds the image, so the trails flow
// only from the edge; the live picture is never gated.
//
// The sun's own kaleidoscope (S.sunKaleidoOn) folds the picture through
// gpu/fold.js: the feathered square is drawn into the fold's chamber instead of the
// scene, and the fold draws in the scene pass; the feedback then takes the
// folded pattern (fold, then feedback, then the echo under the live fold).
// A change of symmetry dissolves over the Symmetry slide (S.sunFoldXfade):
// two folds read the one chamber, the old symmetry fading out under the new
// at smoothstep weight; the chamber is sized for the wider of the two. The
// content is the same video either side, so the dissolve alone is the
// transition (none of kaleido.js's seat and size easing applies). The
// Symmetry variance dips the count toward 3 and back on core/variance.js's
// law, each step entering through the slide, and holds its next step while
// a slide is in flight, as kaleido.js's does (see trackSymmetry and update).
//
// Idle: the video plays while the scene moves (the motion scale above 0) and
// pauses once it has stopped, so a paused, still scene shows one held frame
// and the frame loop may rest; the engine's sleep and the page going out of
// sight also pause it (doze), and the next frame awake resumes it. The
// first load holds the loop awake until a frame is in (core/idle.js).
//
// Speed link (S.sunSpeedLink) lets the breath carry the playback rate:
// Speed times 1 - link * (1 - breath), the breath 0 at full exhale and 1 at
// full inhale, so at link 1 the full inhale runs the set Speed and the full
// exhale comes to a stop. A rate no browser accepts is a stop, so below
// 1/32 the video pauses, one more reason beside the layer, the doze and the
// still scene; syncVideo is the one place that plays it, and only with no
// reason left, so no reason's end can undo another's pause.
//
// High quality (S.sunHiRes) streams the site's original snapshot, about
// twice the bytes, from another stem on the same base. A change swaps the
// element's source in place (swapSource): the place and the play state
// carry over, and the play waits for the seek.
//
// Allocation per frame: the external texture and its bind group, which
// WebGPU makes new by design. Nothing else.

import { S } from '../js/state.js';
import { SUN_WGSL } from './sun.wgsl.js';
import { createFold, FOLD_CHAMBER_FORMAT } from './fold.js';
import { createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT } from './feedback.js';
import { motionStep, motionScale } from '../core/motion.js';
import { idleHold, idleRelease } from '../core/idle.js';
import { roomPhase, roomPhaseState } from '../core/room-clock.js';
import { breath, breathState, resetBreath, dipDepth } from '../core/variance.js';

const VIDEO_BASE = 'https://pub-716b01aa42b4455891728323b3586b99.r2.dev/';
// The standard stem and the High quality one, the site's original snapshot
// (both carry a plain x264 file and an _hevc one).
const STEM_STD = 'sun_mosaic_20260915_23289r';
const STEM_HI = 'sun_mosaic_20260904_23284';
const stemFor = hi => hi ? STEM_HI : STEM_STD;
const urlX264 = stem => VIDEO_BASE + stem + '.mp4';
const urlHevc = stem => VIDEO_BASE + stem + '_hevc.mp4';
const HEVC_TYPE = 'video/mp4; codecs="hvc1.1.6.L120.B0"';
// The photosphere's radius in tile half widths: the square is drawn this
// much larger than the photosphere, so Size sets the photosphere's diameter
// and the corona reaches out beyond it to the feather.
const PHOTOSPHERE = 0.775;
// The photosphere's diameter at Size 1, as a share of the visible field's
// smaller side.
const DISC_SHARE = 0.7;
const MAX_FOLDS = 32;
// Feedback, kaleido.js trails' constants: the half-life in seconds at Amount
// 100% (through the slider's square), and the stream's e-folds a second at
// full either way.
const HL_MAX = 2.0;
const STREAM_MAX = 0.5;
// The Center fade's band half width either side of its radius, in the sun
// square's half sides: half the Softness, never below this floor (a near
// cut, still a smoothstep with two distinct edges). Softness 0.06, the
// default, gives the site's own 0.03.
const GATE_BAND_MIN = 0.003;
// The video's playback rates: Speed's range, and the slowest rate browsers
// accept (Chrome refuses below 1/16), the floor of the pause's coast.
const SPEED_MIN = 1, SPEED_MAX = 16, RATE_FLOOR = 0.0625;
// Speed link's stop: the breath's rate below this pauses the video, which
// plays again once the rate has climbed past BREATH_GO (a little above, so
// the edge cannot flutter between the two).
const BREATH_STOP = 1 / 32, BREATH_GO = 1.25 / 32;
// A refused play() is tried again no sooner than this, ms.
const PLAY_RETRY_MS = 1000;
// The uniform slots, one per target, 256 bytes apart (dynamic offsets): see
// sun.wgsl.js's struct SU, 20 floats of each slot used.
const SLOT_BYTES = 256, SLOT_FLOATS = SLOT_BYTES / 4, SU_FLOATS = 20;
const SLOT_SCENE = 0, SLOT_CHAMBER = 1, SLOT_FB = 2, SLOTS = 3;
const TAU = Math.PI * 2;

function clampNum(v, lo, hi, def) {
  if (typeof v !== 'number' || !(v === v)) return def;
  return v < lo ? lo : (v > hi ? hi : v);
}
function smoothstep(a, b, x) {
  const t = x <= a ? 0 : (x >= b ? 1 : (x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function createSun(device, format) {
  const bgl = device.createBindGroupLayout({
    label: 'sun.bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SU_FLOATS * 4 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const layout = device.createPipelineLayout({ label: 'sun.layout', bindGroupLayouts: [bgl] });
  const mod = device.createShaderModule({ label: 'sun.wgsl', code: SUN_WGSL });
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn('sun.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }
  // Premultiplied over, the repo's convention (kaleido.js, fold.js); the
  // sun writes alpha 0, so it adds as light, as the site composites
  // additively over black (sun.wgsl.js).
  const over = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
  };
  // One pipeline per target format, made the first time that target is
  // used (the scene's at once).
  const pipes = new Map();
  function pipeFor(fmt) {
    let p = pipes.get(fmt);
    if (p) return p;
    p = device.createRenderPipeline({
      label: 'sun.picture.' + fmt, layout,
      vertex: { module: mod, entryPoint: 'vsSun' },
      fragment: { module: mod, entryPoint: 'fsSun', targets: [{ format: fmt, blend: over }] },
      primitive: { topology: 'triangle-list' }
    });
    pipes.set(fmt, p);
    return p;
  }
  const pipeScene = pipeFor(format);
  let pipeChamber = null, pipeFb = null;

  const uniBuf = device.createBuffer({
    label: 'sun.uniforms', size: SLOTS * SLOT_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const uni = new Float32Array(SLOTS * SLOT_FLOATS);
  const offScene = [SLOT_SCENE * SLOT_BYTES];
  const offChamber = [SLOT_CHAMBER * SLOT_BYTES];
  const offFb = [SLOT_FB * SLOT_BYTES];
  const sampler = device.createSampler({
    label: 'sun.sampler',
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
  });
  // Reused descriptors: only the external texture changes each frame.
  const extDesc = { label: 'sun.frame', source: null };
  const bindEntries = [
    { binding: 0, resource: { buffer: uniBuf, size: SU_FLOATS * 4 } },
    { binding: 1, resource: null },
    { binding: 2, resource: sampler }
  ];
  const bindDesc = { label: 'sun.bind', layout: bgl, entries: bindEntries };
  // This frame's bind group over this frame's video picture; null when
  // there is nothing to draw this frame.
  let bind = null;

  // ---------- the video ----------
  let video = null, videoFailed = false, triedX264 = false, holding = false;
  let playPending = false, retryAt = 0, nowMs = 0, dozing = false;
  let warnedImport = false, warnedPlay = false;
  // The stem the element is loading or playing, whether the breath has
  // stopped the video (Speed link), and a swap's place to seek back to
  // (-1 none) while the play waits for it.
  let stemNow = '', breathStopped = false, seekTo = -1;
  function onLoaded() {
    if (holding) { holding = false; idleRelease('the sun video'); }
  }
  function onVideoError() {
    // The one swap: the HEVC file failing falls back to the x264 one.
    if (!triedX264) {
      triedX264 = true;
      console.warn('sun: the HEVC video failed; falling back to x264');
      playPending = false;
      video.src = urlX264(stemNow);
      return;
    }
    videoFailed = true;
    const err = video && video.error;
    console.warn('sun: the video could not load' + (err ? ' (code ' + err.code + (err.message ? ', ' + err.message : '') + ')' : '') + '; the layer stays empty');
    onLoaded();
  }
  function onPlayed() { playPending = false; }
  function onPlayFailed(err) {
    playPending = false;
    // A play cut short by a pause or a new source (a swap) is not a
    // refusal: the next frame decides afresh, with no retry wait.
    if (err && err.name === 'AbortError') return;
    retryAt = nowMs + PLAY_RETRY_MS;
    if (!warnedPlay) {
      warnedPlay = true;
      console.warn('sun: video.play() was refused:', err && err.message ? err.message : err);
    }
  }
  // Made and loading the first frame the layer is on, never at boot.
  // PORTABILITY: ARCHITECTURE.md keeps document to platform/; this element
  // belongs behind a platform hook (platform/web.js) when one is added. A
  // worker engine has no document, and the layer stays empty there.
  function ensureVideo() {
    if (video || videoFailed) return;
    if (typeof document === 'undefined') {
      videoFailed = true;
      console.warn('sun: no document on this thread (worker engine); the Sun layer needs the page engine');
      return;
    }
    video = document.createElement('video');
    video.crossOrigin = 'anonymous';   // required for the GPU import; R2 serves CORS
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;                 // a plain cut at the loop (see the top of this file)
    video.preload = 'auto';
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('error', onVideoError);
    stemNow = stemFor(S.sunHiRes === true);
    const hevc = !!video.canPlayType(HEVC_TYPE);
    triedX264 = !hevc;
    // A paused frame loop stays awake until the first picture is in.
    holding = true;
    idleHold();
    video.src = hevc ? urlHevc(stemNow) : urlX264(stemNow);
  }
  // High quality changed: the other stem into the same element, the HEVC
  // choice and its one x264 fallback made afresh for it. The place is kept
  // and sought back to once the new file's metadata is in; until then
  // syncVideo holds off playing, and after it plays only if no pause reason
  // holds, so a swap made while paused stays paused at that place.
  function swapSource(stem) {
    seekTo = video.readyState >= 1 ? video.currentTime : (seekTo >= 0 ? seekTo : 0);
    stemNow = stem;
    videoFailed = false;
    playPending = false;
    retryAt = 0;
    const hevc = !!video.canPlayType(HEVC_TYPE);
    triedX264 = !hevc;
    if (!holding) { holding = true; idleHold(); }
    video.src = hevc ? urlHevc(stem) : urlX264(stem);
  }
  function onMetadata() {
    if (seekTo < 0) return;
    const d = video.duration;
    const t = d > 0 && isFinite(d) ? seekTo % d : seekTo;
    seekTo = -1;
    try { video.currentTime = t; } catch (e) {}
  }
  // Plays while the layer is on, awake, the scene moving and the breath not
  // stopped, at Speed times the breath's share (Speed link) times the
  // motion scale (so the pause coasts it down with everything else);
  // pauses otherwise. pos is the breath, 0 full exhale to 1 full inhale.
  function syncVideo(on, pos) {
    if (!video || videoFailed) return;
    const scale = motionScale();
    const link = clampNum(S.sunSpeedLink, 0, 1, 0);
    const breathRate = clampNum(S.sunSpeed, SPEED_MIN, SPEED_MAX, 1) * (1 - link * (1 - pos));
    breathStopped = link > 0 && breathRate < (breathStopped ? BREATH_GO : BREATH_STOP);
    if (!on || dozing || !(scale > 0) || breathStopped || seekTo >= 0) {
      if (!video.paused) video.pause();
      return;
    }
    let rate = breathRate * scale;
    if (rate < RATE_FLOOR) rate = RATE_FLOOR;
    if (Math.abs(video.playbackRate - rate) > rate * 0.01) video.playbackRate = rate;
    if (video.paused && !playPending && nowMs >= retryAt) {
      playPending = true;
      const p = video.play();
      if (p && p.then) p.then(onPlayed, onPlayFailed); else playPending = false;
    }
  }
  // The engine's sleep, and the page out of sight: the video stops at once.
  // Awake again, the next update starts it if it should play.
  function doze(on) {
    dozing = !!on;
    if (dozing && video && !video.paused) video.pause();
  }

  // ---------- frame state ----------
  let pixelW = 1, pixelH = 1, dpr = 1;
  let wasOn = false;
  // The layer's motion clock (seconds), the breath's phase (0 to 1) and the
  // fold's spin (radians), all stepped by the motion step.
  let clockS = 0, breathPh = 0, spinAng = 0;
  // This frame: whether the live picture draws, whether it is folded, and
  // whether the feedback runs.
  let liveDraw = false, folded = false, fbOn = false;

  // ---------- the fold pair and the symmetry slide ----------
  // foldA owns the chamber and folds the symmetry the pattern is at or
  // sliding to; foldB folds the one it slides from, reading foldA's chamber
  // (drawFrom). fbFoldA and fbFoldB do the same into the feedback image.
  // Each has its own uniform block (fold.js), made the first time needed.
  let foldA = null, foldB = null, fbFoldA = null, fbFoldB = null;
  const chamberParams = { folds: 8, mirror: true };
  const pNew = { folds: 8, mirror: true, rotation: 0, gain: 1, colorGain: 1 };
  const pOld = { folds: 8, mirror: true, rotation: 0, gain: 0, colorGain: 1 };
  const pFbNew = { folds: 8, mirror: true, rotation: 0, gain: 1, colorGain: 1, gateLo: 0, gateHi: 0 };
  const pFbOld = { folds: 8, mirror: true, rotation: 0, gain: 0, colorGain: 1, gateLo: 0, gateHi: 0 };
  // kaleido.js's slide state: the symmetry last seen (symFolds, symMirror)
  // and the one slid from (oldFolds, oldMirror); the slide runs while
  // slideAge < slideLen, seconds of wall time, slideK the new one's eased
  // weight. foldWasOn says the fold ran last frame (a fresh start adopts
  // the symmetry as it stands).
  let symFolds = 0, symMirror = true, oldFolds = 0, oldMirror = true;
  let slideLen = 0, slideAge = 0, slideK = 1, sliding = false, foldWasOn = false;
  // Symmetry's variance: its breath on the motion clock, its room
  // bookkeeping, and the last issued count with the setting it was issued
  // under (a new step waits out a slide in flight; a new setting never does).
  const foldsB = breathState(), foldsRoom = roomPhaseState();
  let foldsIssued = 0, foldsSetLast = -1;

  // ---------- feedback ----------
  let fb = null, fbScale = 1, fbOpacity = 1;
  const fbParams = { keepHalfLife: 0, zoomRate: 0, twistRate: 0, cx: 0, cy: 0, unit: 1, dt: 0 };

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
    dpr = d || 1;
  }

  // kaleido.js trackSymmetry, ported as it stands: a change with a slide
  // time dissolves the old symmetry out under the new. Back to the symmetry
  // fading out mid-slide, the two swap roles with the mix carried over; to a
  // third, whichever was winning becomes the old one and the slide starts
  // again, so a drag through several counts dissolves once to where it
  // stops.
  function trackSymmetry(nFolds, mirror, dt) {
    if (slideAge < slideLen && dt > 0) slideAge += dt;
    if (!foldWasOn) {
      symFolds = nFolds; symMirror = mirror;
      slideLen = 0; slideAge = 0;
    } else if (nFolds !== symFolds || mirror !== symMirror) {
      const T = clampNum(S.sunFoldXfade, 0, 60, 0);
      const running = slideAge < slideLen;
      const x = running ? slideAge / slideLen : 1;
      if (T <= 0) {
        slideLen = 0; slideAge = 0;
      } else if (running && nFolds === oldFolds && mirror === oldMirror) {
        // smoothstep(1 - x) is 1 - smoothstep(x), so the mix is unbroken
        oldFolds = symFolds; oldMirror = symMirror;
        slideLen = T; slideAge = (1 - x) * T;
      } else {
        if (!(running && x < 0.5)) { oldFolds = symFolds; oldMirror = symMirror; }
        slideLen = T; slideAge = 0;
      }
      symFolds = nFolds; symMirror = mirror;
    }
    slideK = slideAge < slideLen ? smoothstep(0, 1, slideAge / slideLen) : 1;
    return slideAge < slideLen;
  }

  function releaseFolds() {
    if (foldA) foldA.releaseChamber();
    if (foldB) foldB.releaseChamber();
    if (fbFoldA) fbFoldA.releaseChamber();
    if (fbFoldB) fbFoldB.releaseChamber();
  }

  // One uniform slot: the centre in the target's texels, its texels per
  // device px, the square's half side in device px, the target's size, the
  // Center fade and its band half width (0 everywhere but the feedback
  // image's slot) and the gain.
  function putSlot(slot, ox, oy, scale, half, tw, th, gate, band, gain, g) {
    const b = slot * SLOT_FLOATS;
    uni[b] = ox; uni[b + 1] = oy; uni[b + 2] = scale; uni[b + 3] = half;
    uni[b + 4] = tw; uni[b + 5] = th; uni[b + 6] = gate; uni[b + 7] = gain;
    uni[b + 8] = g[0]; uni[b + 9] = g[1]; uni[b + 10] = g[2]; uni[b + 11] = g[3];
    uni[b + 12] = g[4]; uni[b + 13] = band; uni[b + 14] = 0; uni[b + 15] = 0;
    uni[b + 16] = grade[0]; uni[b + 17] = grade[1]; uni[b + 18] = grade[2]; uni[b + 19] = grade[3];
  }
  const gains = new Float32Array(5);
  // This frame's Color grade, the same in every slot: brightness, contrast,
  // saturation, on. Off, the identity and 0, kaleido.js's discipline.
  const grade = new Float32Array(4);

  // t is the rAF timestamp (ms), dt seconds; lum is unused (the sun keeps
  // steady brightness through the strobe).
  function update(t, dt, lum) {
    bind = null; liveDraw = false; folded = false; fbOn = false; sliding = false;
    nowMs = t;
    const on = !!(S.layers && S.layers.sun);
    if (!on) {
      if (wasOn) {
        // Off: the trails and chambers go with the layer; the video pauses
        // where it is, kept for the next switch-on.
        wasOn = false;
        foldWasOn = false;
        S.effSunFolds = undefined;
        S.effSunBreathPos = undefined;
        S.effSunBreathIn = undefined;
        if (fb) fb.release();
        releaseFolds();
      }
      syncVideo(false, 1);
      return;
    }
    wasOn = true;
    ensureVideo();
    if (video && stemNow !== stemFor(S.sunHiRes === true)) swapSource(stemFor(S.sunHiRes === true));

    // The frame's step, eased to 0 over the pause wind-down (core/motion.js).
    const md = dt > 0 ? motionStep(dt) : 0;

    // The breath, the master signal (see the top of this file).
    const breathRate = clampNum(S.sunBreathRate, 0.5, 12, 5.5);
    breathPh += md * breathRate / 60;
    breathPh -= Math.floor(breathPh);
    const breathSin = Math.sin(TAU * breathPh);
    // The Breath drawer's live gauge (schema-sun.js sunBreathGauge): where
    // the breath is, 0 full exhale to 1 full inhale, and whether it is
    // rising (inhaling). Transient, like effSunFolds: never saved.
    S.effSunBreathPos = 0.5 + 0.5 * breathSin;
    S.effSunBreathIn = Math.cos(TAU * breathPh) >= 0;
    // The video, its rate riding this breath (Speed link).
    syncVideo(true, S.effSunBreathPos);

    // The Atmosphere sweep, breathing: the five channels at i/4 along it,
    // the pair the live position falls between crossfaded by smoothstep.
    let atmo = clampNum(S.sunAtmo, 0, 1, 0.25) + 0.5 * clampNum(S.sunBreathAmt, 0, 1, 0.5) * breathSin;
    atmo = atmo < 0 ? 0 : (atmo > 1 ? 1 : atmo);
    gains.fill(0);
    const graded = S.sunGrade === true;
    grade[0] = graded ? clampNum(S.sunBright ?? 1, 0, 2, 1) : 1;
    grade[1] = graded ? clampNum(S.sunContrast ?? 1, 0, 2, 1) : 1;
    grade[2] = graded ? clampNum(S.sunSat ?? 1, 0, 2, 1) : 1;
    grade[3] = graded ? 1 : 0;
    const x = atmo * 4;
    const i = Math.floor(x);
    if (i >= 4) gains[4] = 1;
    else {
      const su = smoothstep(0, 1, x - i);
      gains[i] = 1 - su;
      gains[i + 1] = su;
    }

    // The fold's spin, RPM, positive clockwise on screen: fold.js turns
    // the pattern clockwise (y down) as its rotation grows.
    spinAng = (spinAng + md * clampNum(S.sunKaleidoSpin, -6, 6, 0.5) * TAU / 60) % TAU;

    const opacity = clampNum(S.sunOpacity, 0, 1, 1);
    liveDraw = opacity > 0.002;

    // ---------- Symmetry, as set and as its variance plays it ----------
    // kaleido.js's update, ported: the breath steps on the motion clock and
    // is pulled onto the room clock in a room; the dip takes the count that
    // share of the way down to 3, never above the setting; each whole count
    // goes to trackSymmetry as a drag would. The breath holds its next step
    // while a slide is in flight and issues it once the slide lands, so the
    // dissolves chain whole; a change of the setting itself goes straight
    // through.
    folded = S.sunKaleidoOn === true;
    let nFolds = 8, mirror = true;
    if (folded) {
      const setFolds = Math.round(clampNum(S.sunFolds, 3, MAX_FOLDS, 8));
      const foldsVar = clampNum(S.sunFoldsVar ?? 0, 0, 1, 0);
      nFolds = setFolds;
      if (foldsVar > 0) {
        const foldsPeriod = clampNum(S.sunFoldsPeriod ?? 10, 1, 60, 10);
        breath(foldsB, foldsVar, foldsPeriod, clockS + md, 'sine');
        foldsB.phase = roomPhase(foldsRoom, foldsB.phase, t, md, foldsPeriod, S.sunFoldsPeriodOff || 0);
        nFolds = Math.round(setFolds - dipDepth(foldsVar, foldsB.phase) * (setFolds - 3));
        if (nFolds < 3) nFolds = 3; else if (nFolds > setFolds) nFolds = setFolds;
        if (foldsIssued && setFolds === foldsSetLast && slideAge < slideLen) nFolds = foldsIssued;
        else foldsIssued = nFolds;
      } else if (foldsB.at !== -1) {
        resetBreath(foldsB, -1);
        foldsIssued = 0;
      }
      foldsSetLast = setFolds;
      mirror = S.sunMirror !== false;   // missing means on
      sliding = trackSymmetry(nFolds, mirror, dt);
      foldWasOn = true;
      // The Symmetry slider's live bar, as kaleido.js's effKaleidoFolds.
      S.effSunFolds = sliding && oldFolds !== symFolds
        ? oldFolds + (symFolds - oldFolds) * slideK : foldsVar > 0 ? symFolds : undefined;
    } else {
      if (foldWasOn) { foldWasOn = false; releaseFolds(); }
      if (foldsB.at !== -1) { resetBreath(foldsB, -1); foldsIssued = 0; }
      slideLen = 0; slideAge = 0; slideK = 1;
      S.effSunFolds = undefined;
    }
    if (md > 0) clockS += md;

    // ---------- geometry ----------
    // The field centre the drawer leaves visible, as kaleido.js's.
    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    const visW = Math.max(1, cssW - inset);
    const cx = (inset + visW * 0.5) * dpr, cy = cssH * 0.5 * dpr;
    // The photosphere's radius, and the tile square's half side round it.
    const R = 0.5 * DISC_SHARE * clampNum(S.sunSize, 0.2, 2, 1) * Math.min(visW, cssH) * dpr;
    const half = R / PHOTOSPHERE;

    // ---------- the fold ----------
    if (folded) {
      if (!foldA) foldA = createFold(device, format, { label: 'sun.fold', res: 1 });
      if (!foldB) foldB = createFold(device, format, { label: 'sun.fold.old', res: 1 });
      // The chamber spans the wider of the two symmetries' domains while a
      // slide runs (both centred on straight up, so the narrower read is a
      // part of the wider).
      const spanNew = symMirror ? Math.PI / symFolds : TAU / symFolds;
      const spanOld = oldMirror ? Math.PI / oldFolds : TAU / oldFolds;
      if (sliding && spanOld > spanNew) { chamberParams.folds = oldFolds; chamberParams.mirror = oldMirror; }
      else { chamberParams.folds = symFolds; chamberParams.mirror = symMirror; }
      foldA.ensureChamber(pixelW, pixelH, chamberParams);
      foldA.fit(cx, cy);
      if (sliding) { foldB.ensureChamber(pixelW, pixelH, chamberParams, true); foldB.fit(cx, cy); }
      // The wedge starts on the sun's right (rotation -pi/2 reads the
      // chamber's right-hand side into the up-pointing domain) and turns
      // with the spin.
      const rotation = -Math.PI * 0.5 + spinAng;
      pNew.folds = symFolds; pNew.mirror = symMirror; pNew.rotation = rotation;
      pNew.gain = opacity * (sliding ? slideK : 1);
      pOld.folds = oldFolds; pOld.mirror = oldMirror; pOld.rotation = rotation;
      pOld.gain = opacity * (1 - slideK);
      pFbNew.folds = symFolds; pFbNew.mirror = symMirror; pFbNew.rotation = rotation;
      pFbNew.gain = sliding ? slideK : 1;
      pFbOld.folds = oldFolds; pFbOld.mirror = oldMirror; pFbOld.rotation = rotation;
      pFbOld.gain = 1 - slideK;
      if (!pipeChamber) pipeChamber = pipeFor(FOLD_CHAMBER_FORMAT);
      const f = foldA.frame;
      putSlot(SLOT_CHAMBER, f[4], f[5], f[6], half, f[0], f[1], 0, 0, 1, gains);
    }

    // ---------- feedback ----------
    const fbAmt = clampNum(S.sunFbAmt, 0, 1, 0.6);
    fbOn = fbAmt > 0;
    if (!fbOn) {
      if (fb) fb.release();
      if (fbFoldA) fbFoldA.releaseChamber();
      if (fbFoldB) fbFoldB.releaseChamber();
    } else {
      if (!fb) fb = createFeedback(device, format, { label: 'sun.feedback' });
      fbScale = feedbackRes(S.fbResScale);
      fb.ensure(pixelW, pixelH, fbScale, feedbackKeep(S.fbResSwitch));
      fbParams.keepHalfLife = HL_MAX * fbAmt * fbAmt;
      // The stream: linked, it sweeps Stream lo to Stream hi with the
      // breath (outward on its high); unlinked, the plain Stream setting.
      if (S.sunFbLink !== false) {
        const lo = clampNum(S.sunFbStreamLo, -1, 1, -0.5), hi = clampNum(S.sunFbStreamHi, -1, 1, 0.5);
        fbParams.zoomRate = STREAM_MAX * (lo + (hi - lo) * (breathSin + 1) * 0.5);
      } else {
        fbParams.zoomRate = STREAM_MAX * clampNum(S.sunFbStream, -1, 1, 0);
      }
      fbParams.twistRate = 0;
      // Centre and unit in device px (feedback.js scales them): the unit is
      // the photosphere's radius, so a drawer slide or a Size change rescales the
      // trails with the sun.
      fbParams.cx = cx; fbParams.cy = cy; fbParams.unit = R; fbParams.dt = md;
      // The echo fades with the layer.
      fbOpacity = clampNum(S.sunFbOpacity, 0, 1, 1) * opacity;
      // The Center fade: G in the sun square's own units (1 the edges'
      // midpoints, 0.775 the limb), gating only what feeds the image, never
      // the live picture or the history already in it. Folded, the feedback
      // folds take it as device px about the field centre (the fold keeps
      // each pixel's radius, so gating there is gating the source); the live
      // folds never carry it.
      const gateG = clampNum(S.sunFbGate, 0, 1, 0);
      const gateOn = gateG > 0;
      // The band's half width, from the Softness, in the same square units.
      const gateW = Math.max(GATE_BAND_MIN, 0.5 * clampNum(S.sunFbGateSoft, 0, 1, 0.06));
      pFbNew.gateLo = pFbOld.gateLo = gateOn ? (gateG - gateW) * half : 0;
      pFbNew.gateHi = pFbOld.gateHi = gateOn ? (gateG + gateW) * half : 0;
      if (folded) {
        if (!fbFoldA) fbFoldA = createFold(device, FEEDBACK_FORMAT, { label: 'sun.fold.fb', res: 1 });
        if (!fbFoldB) fbFoldB = createFold(device, FEEDBACK_FORMAT, { label: 'sun.fold.fb.old', res: 1 });
        fbFoldA.ensureChamber(pixelW, pixelH, chamberParams, true);
        fbFoldA.fit(cx, cy, fbScale);
        if (sliding) { fbFoldB.ensureChamber(pixelW, pixelH, chamberParams, true); fbFoldB.fit(cx, cy, fbScale); }
      } else {
        if (!pipeFb) pipeFb = pipeFor(FEEDBACK_FORMAT);
        const kx = fb.width / pixelW, ky = fb.height / pixelH;
        putSlot(SLOT_FB, cx * kx, cy * ky, fbScale, half, fb.width, fb.height, gateG, gateOn ? gateW : 0, 1, gains);
      }
    }

    if (!liveDraw && !fbOn) return;
    putSlot(SLOT_SCENE, cx, cy, 1, half, pixelW, pixelH, 0, 0, opacity, gains);

    // ---------- this frame's picture ----------
    if (!video || videoFailed || video.readyState < 2) return;
    let ext = null;
    try {
      extDesc.source = video;
      ext = device.importExternalTexture(extDesc);
    } catch (e) {
      if (!warnedImport) {
        warnedImport = true;
        console.warn('sun: could not import the video frame:', e && e.message ? e.message : e);
      }
      return;
    }
    bindEntries[1].resource = ext;
    bind = device.createBindGroup(bindDesc);
    bindEntries[1].resource = null;
    device.queue.writeBuffer(uniBuf, 0, uni);
  }

  // Before the scene pass: the sun into the fold's chamber when folded,
  // then the feedback image (fade and stream the last, then the picture,
  // folded or not, over it). Held (stopped with trails), the image is only
  // carried with the field. With no picture this frame the image still
  // fades.
  function encode(encoder) {
    if (bind && folded && foldA && foldA.chamberView) {
      const cp = encoder.beginRenderPass(foldA.chamberPassDesc);
      cp.setPipeline(pipeChamber);
      cp.setBindGroup(0, bind, offChamber);
      cp.draw(6);
      cp.end();
    }
    if (!fbOn) return;
    if (fb.holds(fbParams)) { fb.begin(encoder, fbParams, false); return; }
    const drawing = !!bind && (!folded || !!(foldA && foldA.chamberView));
    const lp = fb.begin(encoder, fbParams, drawing);
    if (!lp) return;
    if (drawing) {
      if (folded) {
        if (sliding) fbFoldB.drawFrom(lp, pFbOld, foldA.chamberView);
        fbFoldA.drawFrom(lp, pFbNew, foldA.chamberView);
      } else {
        lp.setPipeline(pipeFb);
        lp.setBindGroup(0, bind, offFb);
        lp.draw(6);
      }
    }
    fb.end(lp);
  }

  // Inside the scene pass, just before the kaleidoscope layer: the echo
  // first, then the live picture over it (the fold pair while folded, the
  // old symmetry under the new while a slide runs).
  function draw(pass) {
    if (fbOn) fb.composite(pass, 1, fbOpacity);
    if (!bind || !liveDraw) return;
    if (folded) {
      if (!foldA || !foldA.chamberView) return;
      if (sliding) foldB.drawFrom(pass, pOld, foldA.chamberView);
      foldA.draw(pass, pNew);
      return;
    }
    pass.setPipeline(pipeScene);
    pass.setBindGroup(0, bind, offScene);
    pass.draw(6);
  }

  // A symmetry slide runs on the frame's own clock, paused or not, so the
  // still frame waits for it (main.js via engine.busy).
  const busy = () => wasOn && folded && slideAge < slideLen;

  return { update, encode, draw, resize, busy, doze };
}
