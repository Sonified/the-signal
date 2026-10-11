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
// same task.
//
// The loop is the site's crossfade over the edge, not video.loop (whose seek
// to 0 on a streamed file finds nothing buffered there and drops to black):
// two elements, the main and a ghost, same source, swap roles each lap. The
// ghost sits paused at 0 with preload 'none' until it is wanted. The edge is
// the file's end, or, when the buffer is losing to the playhead (its edge
// growing slower than 0.9 x the rate over at least a second), the buffered
// edge less BUFFER_MARGIN_S x the rate, the early wrap that beats a stall.
// Near the edge the ghost starts loading; XFADE_S x the rate video-seconds
// before it, the wrap arms: the ghost seeks to 0, takes the rate and plays,
// and once it has frames the shader blends to it over XFADE_S wall seconds,
// advanced only while the main plays. Done (or the main ended), the ghost is
// the main and the old main parks at 0. A ghost with no frames after
// GHOST_WAIT_S stands the wrap down (retry after WRAP_RETRY_S), and a main
// that ended or starved hard-cuts to 0: a hard cut beats a frozen sun. Every
// pause reason pauses both elements, the rate law sets both while a wrap is
// armed, and an armed wrap that is playing holds the frame loop awake.
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
// Speed's variance (S.sunSpeedVar) lets the breath carry the playback rate:
// Speed times 1 - var * (1 - breath), the breath 0 at full exhale and 1 at
// full inhale, so at var 1 the full inhale runs the set Speed and the full
// exhale comes to a stop. A rate no browser accepts is a stop, so below
// 1/32 the video pauses, one more reason beside the layer, the doze and the
// still scene; syncVideo is the one place that plays it, and only with no
// reason left, so no reason's end can undo another's pause.
//
// High quality (S.sunHiRes) streams the site's original snapshot, about
// twice the bytes, from another stem on the same base. A change stands any
// wrap down and swaps both elements' source in place (swapSource): the
// main's place and the play state carry over, and the play waits for the
// seek; the ghost starts over, parked at 0.
//
// Allocation per frame: the external textures (one, two while a wrap fades)
// and their bind group, which WebGPU makes new by design. Nothing else.

import { S } from '../js/state.js';
import { SUN_WGSL } from './sun.wgsl.js';
import { createFold, FOLD_CHAMBER_FORMAT } from './fold.js';
import { createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT } from './feedback.js';
import { motionStep, motionScale } from '../core/motion.js';
import { idleHold, idleRelease } from '../core/idle.js';
import { roomPhase, roomPhaseState } from '../core/room-clock.js';
import { breath, breathState, resetBreath, dipDepth } from '../core/variance.js';
import { setCutoffHz, cutoffHz } from '../core/sun-hum.js';

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
// The loop's wrap, meditatewiththesun.com's constants (see the top of this
// file): the crossfade in wall seconds; the wall seconds of buffer kept in
// hand when the network is losing and the wrap comes early; the wall
// seconds the ghost may take to show frames; and the wait after a stood-down
// wrap before it may arm again.
const XFADE_S = 0.5;
const BUFFER_MARGIN_S = 1.5;
const GHOST_WAIT_S = 6;
const WRAP_RETRY_S = 4;
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
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} }
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
  // Reused descriptors: only the external textures change each frame (the
  // main's picture, and the ghost's while a wrap fades; the main in both
  // slots otherwise).
  const extDesc = { label: 'sun.frame', source: null };
  const extDescGhost = { label: 'sun.frame.ghost', source: null };
  const bindEntries = [
    { binding: 0, resource: { buffer: uniBuf, size: SU_FLOATS * 4 } },
    { binding: 1, resource: null },
    { binding: 2, resource: sampler },
    { binding: 3, resource: null }
  ];
  const bindDesc = { label: 'sun.bind', layout: bgl, entries: bindEntries };
  // This frame's bind group over this frame's video picture; null when
  // there is nothing to draw this frame.
  let bind = null;

  // ---------- the video ----------
  // Two elements, the main (video) and the ghost, swapping roles each lap
  // (see the top of this file); they are made together and share a source.
  let video = null, ghost = null, videoFailed = false, triedX264 = false, holding = false;
  let retryAt = 0, nowMs = 0, dozing = false;
  let warnedImport = false, warnedPlay = false, warnedGhost = false;
  // The elements with a play() in flight (a new one waits for it).
  const playPending = new Set();
  // The stem the elements are loading or playing and the URL they share,
  // whether the breath has stopped the video (Speed link), and a swap's
  // place to seek back to (-1 none) while the play waits for it.
  let stemNow = '', srcNow = '', breathStopped = false, seekTo = -1;
  // The wrap: { since, fading, last } (seconds) while one is armed, else
  // null; the crossfade, 0 main to 1 ghost; the earliest a stood-down wrap
  // may arm again; whether an armed wrap holds the frame loop awake; and the
  // buffered edge's growth watch over the main.
  let wrap = null, xfade = 0, wrapRetryAt = 0, wrapHeld = false;
  const bufWatch = { el: null, end: 0, at: 0 };
  function onLoaded(e) {
    if (e.target !== video) return;
    if (holding) { holding = false; idleRelease('the sun video'); }
  }
  // Both elements onto a source; the ghost goes back to waiting, unloaded.
  function setSources(url) {
    srcNow = url;
    playPending.clear();
    video.src = url;
    ghost.preload = 'none';
    ghost.src = url;
  }
  function onVideoError(e) {
    const el = e.target;
    if (!el.error) return;   // a stale report from a source since replaced
    // The one swap: the HEVC file failing falls back to the x264 one, on
    // both elements (they decode the same file).
    if (!triedX264) {
      triedX264 = true;
      console.warn('sun: the HEVC video failed; falling back to x264');
      resetWrap();
      setSources(urlX264(stemNow));
      return;
    }
    // A ghost that failed costs a wrap, not the layer: the main plays on,
    // and the stand-down reloads the ghost.
    if (el === ghost) {
      if (!warnedGhost) {
        warnedGhost = true;
        console.warn('sun: the loop ghost could not load (code ' + el.error.code + '); the wrap stands down');
      }
      if (wrap) standDownWrap();
      return;
    }
    videoFailed = true;
    const err = el.error;
    console.warn('sun: the video could not load' + (err ? ' (code ' + err.code + (err.message ? ', ' + err.message : '') + ')' : '') + '; the layer stays empty');
    resetWrap();
    if (holding) { holding = false; idleRelease('the sun video'); }
  }
  function onPlayFailed(err) {
    // A play cut short by a pause or a new source (a swap) is not a
    // refusal: the next frame decides afresh, with no retry wait.
    if (err && err.name === 'AbortError') return;
    retryAt = nowMs + PLAY_RETRY_MS;
    if (!warnedPlay) {
      warnedPlay = true;
      console.warn('sun: video.play() was refused:', err && err.message ? err.message : err);
    }
  }
  function playEl(el) {
    if (!el.paused || playPending.has(el) || nowMs < retryAt) return;
    playPending.add(el);
    const p = el.play();
    if (p && p.then) p.then(() => { playPending.delete(el); }, err => { playPending.delete(el); onPlayFailed(err); });
    else playPending.delete(el);
  }
  function setRate(el, rate) {
    if (Math.abs(el.playbackRate - rate) > rate * 0.01) el.playbackRate = rate;
  }
  function makeElement(preload) {
    const el = document.createElement('video');
    el.crossOrigin = 'anonymous';   // required for the GPU import; R2 serves CORS
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.preload = preload;           // no video.loop: the wrap is the loop
    el.addEventListener('loadeddata', onLoaded);
    el.addEventListener('loadedmetadata', onMetadata);
    el.addEventListener('error', onVideoError);
    return el;
  }
  // Made and loading the first frame the layer is on, never at boot.
  // PORTABILITY: ARCHITECTURE.md keeps document to platform/; these elements
  // belong behind a platform hook (platform/web.js) when one is added. A
  // worker engine has no document, and the layer stays empty there.
  function ensureVideo() {
    if (video || videoFailed) return;
    if (typeof document === 'undefined') {
      videoFailed = true;
      console.warn('sun: no document on this thread (worker engine); the Sun layer needs the page engine');
      return;
    }
    video = makeElement('auto');
    ghost = makeElement('none');
    stemNow = stemFor(S.sunHiRes === true);
    const hevc = !!video.canPlayType(HEVC_TYPE);
    triedX264 = !hevc;
    // A paused frame loop stays awake until the first picture is in.
    holding = true;
    idleHold();
    setSources(hevc ? urlHevc(stemNow) : urlX264(stemNow));
  }
  // High quality changed: any wrap stands down, then the other stem into
  // both elements, the HEVC choice and its one x264 fallback made afresh
  // for it. The main's place is kept and sought back to once the new file's
  // metadata is in; until then syncVideo holds off playing (and the wrap
  // stays idle), and after it plays only if no pause reason holds, so a swap
  // made while paused stays paused at that place.
  function swapSource(stem) {
    resetWrap();
    seekTo = video.readyState >= 1 ? video.currentTime : (seekTo >= 0 ? seekTo : 0);
    stemNow = stem;
    videoFailed = false;
    retryAt = 0;
    const hevc = !!video.canPlayType(HEVC_TYPE);
    triedX264 = !hevc;
    if (!holding) { holding = true; idleHold(); }
    setSources(hevc ? urlHevc(stem) : urlX264(stem));
  }
  function onMetadata(e) {
    if (e.target !== video || seekTo < 0) return;
    const d = video.duration;
    const t = d > 0 && isFinite(d) ? seekTo % d : seekTo;
    seekTo = -1;
    try { video.currentTime = t; } catch (e2) {}
  }

  // ---------- the wrap (see the top of this file) ----------
  // Clears the wrap where it stands: the ghost paused, the blend at the main.
  function resetWrap() {
    if (ghost && !ghost.paused) ghost.pause();
    wrap = null;
    xfade = 0;
    bufWatch.el = null;
  }
  // The site's standDownWrap: the ghost reparked at 0 (reloaded if its
  // stream failed), a wait before the next arm, and a main with nothing
  // left to play cut to 0 (syncVideo plays it on).
  function standDownWrap() {
    resetWrap();
    if (ghost.error) ghost.src = srcNow;
    try { ghost.currentTime = 0; } catch (e) {}
    wrapRetryAt = nowMs / 1000 + WRAP_RETRY_S;
    if (video.ended || video.readyState < 3) { try { video.currentTime = 0; } catch (e) {} }
  }
  // meditatewiththesun.com's updateLoopXfade, now in seconds of the frame's
  // clock. Runs before syncVideo, so an ended main is wrapped (or cut)
  // before anything could play() it (which would seek it to 0 in place).
  function updateWrap(now) {
    if (!video || videoFailed || seekTo >= 0) return;
    const v = video, g = ghost;
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) return;

    // The edge: the file's end, or the buffered edge when the network is
    // losing to the playhead.
    let edge = dur, losing = false;
    if (!v.paused) {
      const t = v.currentTime, b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t + 0.001 && t <= b.end(i)) {
          const bEnd = b.end(i);
          if (bufWatch.el !== v) { bufWatch.el = v; bufWatch.end = bEnd; bufWatch.at = now; }
          const grow = (bEnd - bufWatch.end) / Math.max(1e-3, now - bufWatch.at);   // buffered seconds gained per wall second
          if (now - bufWatch.at >= 2) { bufWatch.end = bEnd; bufWatch.at = now; }
          // judged only on at least a second of history (the first sample
          // after a load reads as zero growth)
          losing = now - bufWatch.at >= 1 && grow < v.playbackRate * 0.9;
          if (losing && bEnd < dur - XFADE_S * v.playbackRate) edge = bEnd - BUFFER_MARGIN_S * v.playbackRate;
          break;
        }
      }
    }
    const remain = edge - v.currentTime;

    // The fade's span in video-seconds at this rate; the ghost loads once
    // the network is seen losing, or a few wall seconds before the edge.
    const span = XFADE_S * Math.max(0.1, v.playbackRate);
    if (!v.paused && g.preload === 'none' && (losing || remain <= span + 4 * v.playbackRate))
      g.preload = 'auto';

    if (!v.paused && !wrap && remain <= span && now >= wrapRetryAt) {
      wrap = { since: now, fading: false, last: now };
      xfade = 0;
      try { g.currentTime = 0; } catch (e) {}
      g.playbackRate = v.playbackRate;
      playEl(g);
    }

    if (wrap) {
      if (!wrap.fading) {
        if (g.readyState >= 2) { wrap.fading = true; wrap.last = now; }
        else if (now - wrap.since > GHOST_WAIT_S) { standDownWrap(); return; }
      }
      if (wrap.fading) {
        // XFADE_S wall seconds of fade, advanced only while the main plays
        // (a pause holds the blend where it is).
        if (!v.paused) xfade = Math.min(1, xfade + (now - wrap.last) / XFADE_S);
        wrap.last = now;
      }
    }

    // Wrap when the fade has completed, or the file ends under us.
    if (v.ended && g.readyState < 2) { standDownWrap(); return; }
    if (v.ended || (wrap && xfade >= 1)) {
      video = g;                      // the ghost (already playing) takes over
      ghost = v;
      v.pause();
      try { v.currentTime = 0; } catch (e) {}
      xfade = 0;
      wrap = null;
    }
  }
  // An armed wrap on a playing main holds the frame loop awake (a pause
  // holds the blend, so the loop may rest then).
  function syncWrapHold() {
    const want = !!wrap && !!video && !video.paused;
    if (want === wrapHeld) return;
    wrapHeld = want;
    if (want) idleHold(); else idleRelease('the sun wrap');
  }

  // Plays while the layer is on, awake, the scene moving and the variance
  // not stopped, at Speed times its drive's share (Speed variance) times the
  // motion scale (so the pause coasts it down with everything else);
  // pauses otherwise. pos is the drive, 0 its bottom to 1 its top (the
  // breath's full exhale to full inhale, the strobe dark to lit, Time's
  // trough to its start).
  // The ghost pauses and plays with the main, at the main's rate, while a
  // wrap is armed, and is never left playing otherwise.
  function syncVideo(on, pos) {
    if (!video || videoFailed) return;
    const scale = motionScale();
    const vary = clampNum(S.sunSpeedVar, 0, 1, 0);
    const breathRate = clampNum(S.sunSpeed, SPEED_MIN, SPEED_MAX, 1) * (1 - vary * (1 - pos));
    breathStopped = vary > 0 && breathRate < (breathStopped ? BREATH_GO : BREATH_STOP);
    // The Speed slider's blue line: the live dipped rate while the variance
    // breathes, gone when it rests.
    S.effSunSpeed = vary > 0 ? breathRate : undefined;
    if (!wrap && !ghost.paused) ghost.pause();
    if (!on || dozing || !(scale > 0) || breathStopped || seekTo >= 0) {
      if (!video.paused) video.pause();
      if (!ghost.paused) ghost.pause();
      return;
    }
    let rate = breathRate * scale;
    if (rate < RATE_FLOOR) rate = RATE_FLOOR;
    setRate(video, rate);
    playEl(video);
    if (wrap) { setRate(ghost, rate); playEl(ghost); }
  }
  // The engine's sleep, and the page out of sight: the video stops at once.
  // Awake again, the next update starts it if it should play.
  function doze(on) {
    dozing = !!on;
    if (dozing && video && !video.paused) video.pause();
    if (dozing && ghost && !ghost.paused) ghost.pause();
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
  // The Speed's, Amount's and Opacity's variances (schema-sun.js
  // drivenVariance): Time's phase for each, stepped on the motion clock and
  // pulled onto the room clock, with its room bookkeeping.
  const driven = {
    sunSpeed: { phase: 0, room: roomPhaseState() },
    sunFbAmt: { phase: 0, room: roomPhaseState() },
    sunFbOpacity: { phase: 0, room: roomPhaseState() },
    sunHumCutoff: { phase: 0, room: roomPhaseState() }
  };
  // A variance's drive this frame, 0 to 1 from its driver: Time's cosine, 1
  // at the cycle's start; the strobe's lum, 1 lit; the breath, 1 at the
  // full inhale. The setting plays at set times 1 - var * (1 - drive). Time
  // steps even while another driver rides, so a switch back to it lands in
  // the room's phase.
  function driveOf(key, t, md, lum, breathPos) {
    const v = driven[key];
    const period = Math.max(0.5, clampNum(S[key + 'VarPeriod'], 0, 120, 20));
    v.phase += md / period;
    v.phase -= Math.floor(v.phase);
    v.phase = roomPhase(v.room, v.phase, t, md, period, S[key + 'VarPeriodOff'] || 0);
    const drive = S[key + 'VarDrive'];
    return drive === 'time' ? 0.5 + 0.5 * Math.cos(TAU * v.phase)
      : drive === 'strobe' ? clampNum(lum, 0, 1, 1)
      : breathPos;
  }
  function varied(key, set, d) {
    const amount = clampNum(S[key + 'Var'], 0, 1, 0);
    return amount > 0 ? set * (1 - amount * (1 - d)) : set;
  }
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
    uni[b + 12] = g[4]; uni[b + 13] = band; uni[b + 14] = 0; uni[b + 15] = 0;   // [14] the crossfade, set with the picture
    uni[b + 16] = grade[0]; uni[b + 17] = grade[1]; uni[b + 18] = grade[2]; uni[b + 19] = grade[3];
  }
  const gains = new Float32Array(5);
  // This frame's Color grade, the same in every slot: brightness, contrast,
  // saturation, on. Off, the identity and 0, kaleido.js's discipline.
  const grade = new Float32Array(4);

  // t is the rAF timestamp (ms), dt seconds; lum the strobe's raw wave, 1
  // lit to 0 dark, read only by a Feedback variance linked to the strobe
  // (the sun itself keeps steady brightness through the strobe).
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
        S.effSunSpeed = undefined;
        S.effSunFbAmt = undefined;
        S.effSunFbOpacity = undefined;
        S.effSunHumCutoff = undefined;
        if (fb) fb.release();
        releaseFolds();
      }
      syncVideo(false, 1);
      syncWrapHold();
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
    // The loop's wrap first (an ended main must wrap before any play()),
    // then the video, its rate riding its variance's drive.
    updateWrap(nowMs / 1000);
    syncVideo(true, driveOf('sunSpeed', t, md, lum, S.effSunBreathPos));
    syncWrapHold();

    // The Rotational hum's Cutoff, as its variance plays it, on the 0 to 1
    // setting, straight into the hum's filter (a no-op when it has not
    // moved, and where there is no AudioContext: in worker mode
    // core/audio-link.js carries effSunHumCutoff to the page's hum).
    const cutSet = clampNum(S.sunHumCutoff, 0, 1, 0.25);
    const cut = varied('sunHumCutoff', cutSet, driveOf('sunHumCutoff', t, md, lum, S.effSunBreathPos));
    S.effSunHumCutoff = S.sunHumCutoffVar > 0 ? cut : undefined;
    setCutoffHz(cutoffHz(cut));

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
    const fbAmt = varied('sunFbAmt', clampNum(S.sunFbAmt, 0, 1, 0.6), driveOf('sunFbAmt', t, md, lum, S.effSunBreathPos));
    const fbOpacitySet = varied('sunFbOpacity', clampNum(S.sunFbOpacity, 0, 1, 1), driveOf('sunFbOpacity', t, md, lum, S.effSunBreathPos));
    // The two rows' blue lines, while their variances play.
    S.effSunFbAmt = S.sunFbAmtVar > 0 ? fbAmt : undefined;
    S.effSunFbOpacity = S.sunFbOpacityVar > 0 ? fbOpacitySet : undefined;
    fbOn = clampNum(S.sunFbAmt, 0, 1, 0.6) > 0;
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
      fbOpacity = fbOpacitySet * opacity;
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
    // The main's picture, and while a wrap fades with the ghost showing
    // frames, the ghost's too, blended by the crossfade (sun.wgsl.js). One
    // picture alone is bound in both slots with the blend at its side.
    if (!video || videoFailed) return;
    const mainOk = video.readyState >= 2;
    const ghostOk = !!wrap && wrap.fading && ghost.readyState >= 2;
    const ext = mainOk ? importFrame(extDesc, video) : null;
    const extGhost = ghostOk ? importFrame(extDescGhost, ghost) : null;
    if (!ext && !extGhost) return;
    const xf = ext && extGhost ? xfade : 0;
    bindEntries[1].resource = ext || extGhost;
    bindEntries[3].resource = extGhost || ext;
    bind = device.createBindGroup(bindDesc);
    bindEntries[1].resource = null;
    bindEntries[3].resource = null;
    for (let k = 0; k < SLOTS; k++) uni[k * SLOT_FLOATS + 14] = xf;
    device.queue.writeBuffer(uniBuf, 0, uni);
  }
  function importFrame(desc, el) {
    try {
      desc.source = el;
      return device.importExternalTexture(desc);
    } catch (e) {
      if (!warnedImport) {
        warnedImport = true;
        console.warn('sun: could not import the video frame:', e && e.message ? e.message : e);
      }
      return null;
    }
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
