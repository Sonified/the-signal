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
// The loop runs over the first four solar rotations only, not the whole
// file: LOOP_END_S stands in for the file's end. July's eclipse season drops
// frames daily, so the file after early July is full of jumps (39 of its 51
// gaps over 2 h fall after this edge), and four whole rotations bring the
// sun round to the same face, so the wrap lands on matching geometry.
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
// A stalled decoder is rescued the same way (watchStall): a main that is
// playing, with buffer in hand, whose clock has not moved for STALL_S wall
// seconds (seen live: HEVC wedged mid-file, everything buffered, the clock
// frozen, a seek never finishing) arms a rescue wrap. The ghost, a decoder
// of its own, seeks to the main's place and plays, the frozen frame holds
// meanwhile, and the usual crossfade hands over; the dead element is then
// reloaded, a fresh decoder parked as the ghost. A ghost that cannot show
// frames in GHOST_WAIT_S reloads both elements in place (swapSource), as
// Max quality off and on did by hand.
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
// A tier change stands any wrap down and swaps both elements' source in
// place (swapSource), whatever the tier, the same base and naming: the
// main's place and the play state carry over, and the play waits for the
// seek; the ghost starts over, parked at 0.
//
// The quality ladder (TIERS, Robert's names, Standard in the middle): Min
// (720x480), Low (1080x720), Standard (1620x1080), High (the recipe cut,
// 2764x1842) and Max (the original,
// 3072x2048, only with Max quality on, S.sunHiRes). From the cloud, the
// first load times a real ranged fetch (PROBE_BYTES, cut off at
// PROBE_WAIT_MS, the bytes that came counted either way) and takes the
// highest tier whose bar the link clears, each bar 2 to 3 times its file's
// bitrate so the slides streaming beside it still fit.
//
// Down fast, up slow. Any sign a tier is not keeping up (a stall, the clock
// starved of data for STARVE_S, a network error, a dead rescue) drops one
// tier at once, in place, and holds it there. Up only after
// AWAY_S away (the page hidden, the laptop asleep, the layer off): the link
// is measured afresh, a slower one drops at once, a faster one rises ONE
// tier per loop, at the wrap's crossfade (the ghost loads the next tier), so
// nobody sees it. Max quality flipped is a fresh wish: measured afresh and
// swapped at once. The local copies (localhost) skip all of this.
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
import { setCutoffHz, cutoffHz, setReverbMix } from '../core/sun-hum.js';

const CLOUD_BASE = 'https://pub-716b01aa42b4455891728323b3586b99.r2.dev/';
// Served from this machine (tools/serve.mjs on localhost), the Sun plays its
// own copies in sun-video/ (git-ignored, downloaded from the cloud), so a
// show never waits on the network; a file missing there falls back to the
// cloud once, before the HEVC to x264 swap is spent.
const LOCAL_BASE = '/sun-video/';
const ON_LOCALHOST = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
let VIDEO_BASE = ON_LOCALHOST ? LOCAL_BASE : CLOUD_BASE;
// The High stem (the recipe cut) and the Max one, the site's original
// snapshot; every tier carries a plain x264 file and an _hevc one.
const STEM_HIGH = 'sun_mosaic_20260915_23289r';
const STEM_MAX = 'sun_mosaic_20260904_23284';
// The ladder, low to high: the three below High are scaled from it
// (720x480, 1080x720 and 1620x1080, CRF 26 HEVC / 25 x264, 1 s keyframes, full
// range bt470bg, as the site's own encodes). bar: the link (Mbps) to choose
// it; ~: its HEVC bitrate.
const TIERS = [
  { name: 'Min', stem: STEM_HIGH + '_480', bar: 0 },         // ~0.46 Mbps
  { name: 'Low', stem: STEM_HIGH + '_720', bar: 2.5 },       // ~0.94
  { name: 'Standard', stem: STEM_HIGH + '_1080', bar: 5 },   // ~1.7
  { name: 'High', stem: STEM_HIGH, bar: 10 },                // ~4.1
  { name: 'Max', stem: STEM_MAX, bar: 20 }                   // ~8.0
];
const MAX_TIER = TIERS.length - 1;
const urlX264 = stem => VIDEO_BASE + stem + '.mp4';
const urlHevc = stem => VIDEO_BASE + stem + '_hevc.mp4';
// The link probe (see the top of this file): the bytes timed, the bar in
// Mbps (meditatewiththesun's, Robert's call 2026-09-16), and the most it may
// take: a slow link pays no more than what 1.5 s brings, and the bytes that
// came by then still give its speed (Robert's call, 2026-10-12).
const PROBE_BYTES = 1000000;
const PROBE_WAIT_MS = 1500;
// Away this long (wall seconds without a frame of the layer), the link is
// measured afresh on return.
const AWAY_S = 3600;
// A tier's clock stood this many wall seconds without the data to move on
// is a link that is not keeping up; a network error's reload waits this long.
const STARVE_S = 4;
const NET_RETRY_MS = 3000;
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
// The loop's end in video seconds: frame 15255 of the 30 fps file, four
// Carrington rotations (4 x 27.2753 days) after its first frame (2026-03-18
// 15:38 to 2026-07-05 18:08 UTC, from meditatewiththesun's
// mosaic_times.json). Both stems carry the same frames up to frame 16424,
// so the one edge serves both.
const LOOP_END_S = 15255 / 30;
// A playing main whose clock has stood this many wall seconds, with at least
// STALL_AHEAD_S of buffer past it (less is the network, the wrap's to
// handle), is stalled.
const STALL_S = 1;
const STALL_AHEAD_S = 0.5;
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
  // The stall watch over the main: its clock as last seen, and since when.
  const stallWatch = { el: null, t: -1, at: 0 };
  // The starvation watch, the same shape; the tier playing (-1 none yet);
  // the tier a return measured, risen to a loop at a time (-1 none); the
  // tier the ghost is loading for this loop's wrap (-1 the same file); a
  // probe in flight, and a flip owed one after it; Max quality as last seen; the wall clock at the
  // layer's last frame; and when a network error's reload is due (0 none).
  const starveWatch = { el: null, t: -1, at: 0 };
  let tier = -1, upTo = -1, wrapUp = -1, probing = false, again = false, hiWas = null, seenAt = 0, netRetryAt = 0;
  const topTier = () => S.sunHiRes === true ? MAX_TIER : MAX_TIER - 1;
  const urlFor = stem => triedX264 ? urlX264(stem) : urlHevc(stem);

  // The link's speed in Mbps: a ranged fetch of the High file's head, cut
  // off at PROBE_WAIT_MS, the bytes that came by then counted (0 on an
  // error). PORTABILITY: fetch on the page thread, as the elements below are.
  async function measure() {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, PROBE_WAIT_MS);
    let got = 0, t1 = -1;
    try {
      // no-store: a cached range would read as infinitely fast
      const r = await fetch(urlHevc(STEM_HIGH), { headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) }, cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw Error('HTTP ' + r.status);
      // the clock starts at the reply: the connection's setup and first
      // round trip are latency, not speed, and timed in they read a 50 Mbps
      // link as 15-30 (the cutoff still counts from the request)
      t1 = performance.now();
      const rd = r.body.getReader();
      for (;;) { const c = await rd.read(); if (c.done) break; got += c.value.byteLength; }
    } catch (e) {
      if (!(e && e.name === 'AbortError')) { console.log('sun: the link probe failed (' + (e && e.message) + ')'); return 0; }
    } finally { clearTimeout(timer); }
    const secs = (performance.now() - t1) / 1000;
    return t1 >= 0 && secs > 0 ? got * 8 / secs / 1e6 : 0;
  }
  // The highest tier a link of mbps clears, within Max quality's say.
  function tierFor(mbps) {
    let i = 0;
    while (i < topTier() && mbps >= TIERS[i + 1].bar) i++;
    return i;
  }
  // why: 'start' (the first load waits on it), 'flip' (Max quality changed:
  // the answer is swapped to at once) or 'return' (back from away: lower at
  // once, higher a loop at a time).
  function probeLink(why) {
    // a flip while another probe runs is measured after it
    if (probing) { if (why === 'flip') again = true; return; }
    probing = true;
    // the frame loop stays awake to take the verdict
    idleHold();
    measure().then(mbps => {
      probing = false;
      const to = tierFor(mbps);
      console.log('sun: the link measured ' + mbps.toFixed(1) + ' Mbps; ' + TIERS[to].name + ' quality' + (why === 'return' ? ' (back from away)' : ''));
      if (why === 'start' || !video) tier = to;
      else if (to < tier || why === 'flip') { if (to !== tier) setTier(to); upTo = -1; }
      else if (to > tier) upTo = to;
      idleRelease('the sun link probe');
      if (again) { again = false; probeLink('flip'); }
    });
  }
  // A tier now, in place (swapSource).
  function setTier(i) {
    tier = i;
    swapSource(TIERS[i].stem);
  }
  // A tier not keeping up: one down, at once, and no rise until the next
  // return from away.
  function stepDown(why) {
    if (tier <= 0 || VIDEO_BASE === LOCAL_BASE) return false;
    upTo = -1;
    console.warn('sun: ' + why + '; stepping down to ' + TIERS[tier - 1].name + ' quality');
    setTier(tier - 1);
    return true;
  }

  function onLoaded(e) {
    if (e.target !== video) return;
    if (holding) { holding = false; idleRelease('the sun video'); }
  }
  // Both elements onto a source; the ghost goes back to waiting, unloaded.
  function setSources(url) {
    srcNow = url;
    wrapUp = -1;
    playPending.clear();
    video.src = url;
    ghost.preload = 'none';
    ghost.src = url;
  }
  function onVideoError(e) {
    const el = e.target;
    if (!el.error) return;   // a stale report from a source since replaced
    if (VIDEO_BASE === LOCAL_BASE) {
      VIDEO_BASE = CLOUD_BASE;
      console.warn('sun: no local copy of ' + srcNow + '; playing it from the cloud');
      resetWrap();
      setSources(CLOUD_BASE + srcNow.slice(LOCAL_BASE.length));
      return;
    }
    // A network error is the link, not the codec: High steps down, the
    // standard file reloads in place after a breath (the x264 fallback
    // would only ask the same link for more bytes).
    if (el.error.code === 2) {
      if (el === ghost) { if (wrap) standDownWrap(); return; }
      if (stepDown('the ' + TIERS[tier].name + ' quality video lost the network')) return;
      if (!netRetryAt) {
        console.warn('sun: the video lost the network; reloading it in ' + NET_RETRY_MS / 1000 + ' s');
        netRetryAt = nowMs + NET_RETRY_MS;
      }
      return;
    }
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
  // Render > Sun playback rate throttle (S.sunRateHz) caps the writes a second per
  // element; 0 leaves every 1% drift written at once.
  const rateAt = new WeakMap();
  function setRate(el, rate) {
    if (Math.abs(el.playbackRate - rate) <= rate * 0.01) return;
    const hz = S.sunRateHz > 0 ? Math.min(40, S.sunRateHz) : 0;
    if (hz && nowMs - (rateAt.get(el) ?? -Infinity) < 1000 / hz) return;
    rateAt.set(el, nowMs);
    el.playbackRate = rate;
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
    if (tier < 0) {
      if (VIDEO_BASE === LOCAL_BASE) tier = topTier();
      else { probeLink('start'); if (tier < 0) return; }   // the probe decides first (1.5 s at most)
    }
    video = makeElement('auto');
    ghost = makeElement('none');
    stemNow = TIERS[tier].stem;
    const hevc = !!video.canPlayType(HEVC_TYPE);
    triedX264 = !hevc;
    // A paused frame loop stays awake until the first picture is in.
    holding = true;
    idleHold();
    setSources(hevc ? urlHevc(stemNow) : urlX264(stemNow));
  }
  // A tier changed: any wrap stands down, then the other stem into
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
    // a rise whose ghost could not show frames: given up until the next
    // return from away, the ghost back on this tier's file
    if (wrapUp >= 0) {
      console.warn('sun: ' + TIERS[wrapUp].name + ' quality did not load in time; staying on ' + TIERS[tier].name);
      wrapUp = -1; upTo = -1;
      ghost.preload = 'none';
      ghost.src = srcNow;
    } else if (ghost.error) ghost.src = srcNow;
    try { ghost.currentTime = 0; } catch (e) {}
    wrapRetryAt = nowMs / 1000 + WRAP_RETRY_S;
    if (video.ended || video.readyState < 3 || video.currentTime >= LOOP_END_S) { try { video.currentTime = 0; } catch (e) {} }
  }
  // meditatewiththesun.com's updateLoopXfade, now in seconds of the frame's
  // clock. Runs before syncVideo, so an ended main is wrapped (or cut)
  // before anything could play() it (which would seek it to 0 in place).
  function updateWrap(now) {
    if (!video || videoFailed || seekTo >= 0) return;
    const v = video, g = ghost;
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) return;

    // The edge: the loop's end (or the file's, if shorter), or the buffered
    // edge when the network is losing to the playhead.
    const end = Math.min(dur, LOOP_END_S);
    let edge = end, losing = false;
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
          if (losing && bEnd < end - XFADE_S * v.playbackRate) edge = bEnd - BUFFER_MARGIN_S * v.playbackRate;
          break;
        }
      }
    }
    const remain = edge - v.currentTime;

    // The fade's span in video-seconds at this rate; the ghost loads once
    // the network is seen losing, or a few wall seconds before the edge.
    const span = XFADE_S * Math.max(0.1, v.playbackRate);
    // A pending rise rides this wrap: the ghost loads the next tier up from
    // its start, in the same few seconds before the edge (never while the
    // network is seen losing).
    if (!v.paused && !wrap && wrapUp < 0 && upTo > tier && !losing && remain <= span + 4 * v.playbackRate) {
      wrapUp = tier + 1;
      g.preload = 'auto';
      g.src = urlFor(TIERS[wrapUp].stem);
    }
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
        if (g.readyState >= 2 && !g.seeking) { wrap.fading = true; wrap.last = now; }
        else if (now - wrap.since > GHOST_WAIT_S) {
          // A rescue whose ghost cannot show frames either: both reloaded in place.
          if (wrap.rescue) {
            if (stepDown('the rescue ghost showed no frames')) return;
            console.warn('sun: the rescue ghost showed no frames; reloading the video in place'); swapSource(stemNow); return;
          }
          standDownWrap(); return;
        }
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
      const rescued = !!(wrap && wrap.rescue);
      video = g;                      // the ghost (already playing) takes over
      ghost = v;
      v.pause();
      if (rescued) {
        // The stalled decoder is not trusted to seek again: a fresh load,
        // parked unloaded as a new ghost is.
        playPending.delete(v);
        v.preload = 'none';
        v.src = srcNow;
        console.warn('sun: rescued, the ghost has taken over and the stalled element reloads');
      } else if (wrapUp >= 0) {
        // the rise landed: this tier from here on, the old element parked
        // on its file as a new ghost is
        tier = wrapUp; wrapUp = -1;
        if (upTo <= tier) upTo = -1;
        stemNow = TIERS[tier].stem;
        srcNow = urlFor(stemNow);
        playPending.delete(v);
        v.preload = 'none';
        v.src = srcNow;
        console.log('sun: risen to ' + TIERS[tier].name + ' quality at the loop');
      } else {
        try { v.currentTime = 0; } catch (e) {}
      }
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
  // The stall rescue (see the top of this file). Watches only a main that
  // is playing on its own: paused, ended, mid-play(), mid-swap or under an
  // armed wrap, the watch starts over.
  function watchStall(now) {
    const v = video;
    if (!v || videoFailed || seekTo >= 0 || wrap || v.paused || v.ended || playPending.has(v)) { stallWatch.el = null; return; }
    const t = v.currentTime;
    if (stallWatch.el !== v || t !== stallWatch.t) { stallWatch.el = v; stallWatch.t = t; stallWatch.at = now; return; }
    if (now - stallWatch.at < STALL_S) return;
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) return;
    // A seek that never finished is a stall whatever the buffer says;
    // otherwise only with buffer in hand past the clock.
    if (!v.seeking) {
      let ahead = 0;
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.001 && t <= b.end(i)) { ahead = b.end(i) - t; break; }
      if (ahead < Math.min(STALL_AHEAD_S, dur - t - 0.05)) return;
    }
    stallWatch.el = null;
    if (stepDown('the ' + TIERS[tier].name + ' quality video stalled at ' + t.toFixed(2) + 's')) return;
    console.warn('sun: the video stalled at ' + t.toFixed(2) + 's (clock still ' + (now - stallWatch.at).toFixed(1) + 's, ready ' + v.readyState + (v.seeking ? ', seeking' : '') + '); the ghost takes over');
    const g = ghost;
    if (g.error || wrapUp >= 0) { g.src = srcNow; wrapUp = -1; }
    g.preload = 'auto';
    try { g.currentTime = Math.min(t + 0.05, Math.max(0, dur - 0.1)); } catch (e) {}
    g.playbackRate = v.playbackRate;
    wrap = { since: now, fading: false, last: now, rescue: true };
    xfade = 0;
    playEl(g);
  }

  // The starvation watch (see the top of this file): a main meant to be
  // playing (or with its play() in flight, which a starved first load is)
  // whose clock has stood STARVE_S without the data to move on. Mid-swap,
  // mid-wrap or paused, the watch starts over.
  function watchStarve(now) {
    const v = video;
    if (!v || tier <= 0 || videoFailed || seekTo >= 0 || wrap ||
        (v.paused && !playPending.has(v)) || v.ended || v.readyState >= 3) { starveWatch.el = null; return; }
    const t = v.currentTime;
    if (starveWatch.el !== v || t !== starveWatch.t) { starveWatch.el = v; starveWatch.t = t; starveWatch.at = now; return; }
    if (now - starveWatch.at < STARVE_S) return;
    starveWatch.el = null;
    stepDown('the ' + TIERS[tier].name + ' quality video waited ' + STARVE_S + ' s for data at ' + t.toFixed(2) + 's');
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
  // The Kaleidoscope's Opacity, a crossfade of the raw sun and the fold
  // (S.sunKaleidoOpacity, the wet share). The sun is pure light (alpha 0,
  // sun.wgsl.js), so the two simply add: the raw sun at 1 - wet and the
  // fold at wet sum to one picture's worth, 50% exactly half of each.
  let dryGain = 1, wetGain = 1, drawDry = true, drawWet = false;

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
    sunHumCutoff: { phase: 0, room: roomPhaseState() },
    sunHumVerb: { phase: 0, room: roomPhaseState() }
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
  // Where the sun sits this frame, for the star field's hole (gpu/stars.js):
  // the centre (device px), the tile square's half side (device px), and
  // the hole's depth, the Opacity while a picture is drawn, else 0.
  const disk = new Float32Array(4);
  // This frame's Color grade, the same in every slot: brightness, contrast,
  // saturation, on. Off, the identity and 0, kaleido.js's discipline.
  const grade = new Float32Array(4);

  // t is the rAF timestamp (ms), dt seconds; lum the strobe's raw wave, 1
  // lit to 0 dark, read only by a Feedback variance linked to the strobe
  // (the sun itself keeps steady brightness through the strobe).
  function update(t, dt, lum) {
    bind = null; liveDraw = false; folded = false; fbOn = false; sliding = false;
    disk[3] = 0;
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
        S.effSunHumVerb = undefined;
        if (fb) fb.release();
        releaseFolds();
      }
      syncVideo(false, 1);
      syncWrapHold();
      return;
    }
    wasOn = true;
    // Max quality flipped, or back from AWAY_S away: the link measured
    // afresh (see the top of this file)
    const hi = S.sunHiRes === true, wall = Date.now();
    const flipped = hiWas !== null && hi !== hiWas, back = seenAt > 0 && wall - seenAt >= AWAY_S * 1000;
    hiWas = hi; seenAt = wall;
    if (video && tier >= 0 && VIDEO_BASE !== LOCAL_BASE && (flipped || back)) probeLink(flipped ? 'flip' : 'return');
    else if (video && VIDEO_BASE === LOCAL_BASE && flipped) setTier(topTier());
    ensureVideo();
    if (video && netRetryAt && nowMs >= netRetryAt) { netRetryAt = 0; swapSource(stemNow); }

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
    watchStall(nowMs / 1000);
    watchStarve(nowMs / 1000);
    syncWrapHold();

    // The Rotational hum's Cutoff, as its variance plays it, on the 0 to 1
    // setting, straight into the hum's filter (a no-op when it has not
    // moved, and where there is no AudioContext: in worker mode
    // core/audio-link.js carries effSunHumCutoff to the page's hum).
    const cutSet = clampNum(S.sunHumCutoff, 0, 1, 0.25);
    const cut = varied('sunHumCutoff', cutSet, driveOf('sunHumCutoff', t, md, lum, S.effSunBreathPos));
    S.effSunHumCutoff = S.sunHumCutoffVar > 0 ? cut : undefined;
    setCutoffHz(cutoffHz(cut));
    // and its Reverb mix, the same way
    const verb = varied('sunHumVerb', clampNum(S.sunHumVerb, 0, 1, 0.3), driveOf('sunHumVerb', t, md, lum, S.effSunBreathPos));
    S.effSunHumVerb = S.sunHumVerbVar > 0 ? verb : undefined;
    setReverbMix(verb);

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
    const wet = folded ? clampNum(S.sunKaleidoOpacity, 0, 1, 1) : 0;
    dryGain = 1 - wet;
    wetGain = wet;
    drawDry = !folded || dryGain > 0.002;
    drawWet = folded && wetGain > 0.002;
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
    disk[0] = cx; disk[1] = cy; disk[2] = half;

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
      pNew.gain = opacity * wetGain * (sliding ? slideK : 1);
      pOld.folds = oldFolds; pOld.mirror = oldMirror; pOld.rotation = rotation;
      pOld.gain = opacity * wetGain * (1 - slideK);
      pFbNew.folds = symFolds; pFbNew.mirror = symMirror; pFbNew.rotation = rotation;
      pFbNew.gain = wetGain * (sliding ? slideK : 1);
      pFbOld.folds = oldFolds; pFbOld.mirror = oldMirror; pFbOld.rotation = rotation;
      pFbOld.gain = wetGain * (1 - slideK);
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
      }
      if (drawDry) {
        if (!pipeFb) pipeFb = pipeFor(FEEDBACK_FORMAT);
        const kx = fb.width / pixelW, ky = fb.height / pixelH;
        putSlot(SLOT_FB, cx * kx, cy * ky, fbScale, half, fb.width, fb.height, gateG, gateOn ? gateW : 0, dryGain, gains);
      }
    }

    if (!liveDraw && !fbOn) return;
    putSlot(SLOT_SCENE, cx, cy, 1, half, pixelW, pixelH, 0, 0, opacity * dryGain, gains);

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
    // A picture is up: the star field's hole opens where it sits.
    disk[3] = opacity;
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
      // The crossfade, as the live picture's.
      drawDryFb(lp);
      if (drawWet) {
        if (sliding) fbFoldB.drawFrom(lp, pFbOld, foldA.chamberView);
        fbFoldA.drawFrom(lp, pFbNew, foldA.chamberView);
      }
    }
    fb.end(lp);
  }
  function drawDryFb(lp) {
    if (!drawDry) return;
    lp.setPipeline(pipeFb);
    lp.setBindGroup(0, bind, offFb);
    lp.draw(6);
  }

  // Inside the scene pass, just before the kaleidoscope layer: the echo
  // first, then the live picture over it (the fold pair while folded, the
  // old symmetry under the new while a slide runs).
  function draw(pass) {
    if (fbOn) fb.composite(pass, 1, fbOpacity);
    if (!bind || !liveDraw) return;
    if (folded && (!foldA || !foldA.chamberView)) return;
    // The crossfade: the raw sun at 1 - wet, the fold at wet, adding.
    drawDryLive(pass);
    if (drawWet) {
      if (sliding) foldB.drawFrom(pass, pOld, foldA.chamberView);
      foldA.draw(pass, pNew);
    }
  }
  function drawDryLive(pass) {
    if (!drawDry) return;
    pass.setPipeline(pipeScene);
    pass.setBindGroup(0, bind, offScene);
    pass.draw(6);
  }

  // A symmetry slide runs on the frame's own clock, paused or not, so the
  // still frame waits for it (main.js via engine.busy).
  const busy = () => wasOn && folded && slideAge < slideLen;

  return { update, encode, draw, resize, busy, doze, disk };
}
