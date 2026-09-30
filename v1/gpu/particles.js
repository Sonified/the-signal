// The particle layer: a GPU particle generator streaming down the tunnel.
//
// Particles live in the tunnel's own space (see particles.wgsl.js): born far
// down it near the vanishing point, flying toward the viewer, projected with
// the rings' r = FOCAL / z, so they share the rings' sense of depth. The
// simulation is a compute pass over one storage buffer, and the CPU does no
// per-particle work at all: each frame it only writes two small uniform
// blocks, resets the draw's arguments and tells the simulation which
// ring-buffer slots this frame's births take.
//
// The drawing is one indirect draw. The simulation lists every particle that
// would actually light a pixel this frame (alive, past its fades, on the
// target) and counts them into the draw's own arguments, so a particle still
// fading in at the vanishing point, fading out as it passes the viewer, or
// off the edge costs no vertex work and no fill. Each style's quad is also
// trimmed to where its light is still at least one 8-bit step, which matters
// most for the big, faint particles right in front of the viewer.
//
// It is built to grow. The three registries below are the whole vocabulary a
// new emitter, style or colour needs on this side; the matching branch goes
// in particles.wgsl.js. A 3D grid emitter, a sphere shell, particles sampled
// from an image, a new look: each is a name here and a branch there.
//
// With Kaleidoscope on, the particles are drawn into the reusable fold's
// chamber (fold.js) instead of the scene pass, and the fold draws the N-fold
// pattern where the particles would have been.
//
// A particle lives only while it can be seen. Near the vanishing point the
// radial fade keeps everything dark, and a particle flying in from the far
// plane spends most of its flight there (at the defaults, more than nine
// tenths of its nineteen seconds), so the simulation places each
// birth straight at the point on its own path where it first shows. The
// buffer then holds only the visible band, the birth-rate cap is worked out
// from how long a particle can live from that point (birthTravel), and the
// simulation visits only the slots born recently enough to still be in
// flight (the live window, see encode).
//
// A stream starts full. The visible band still takes a few seconds to fill
// from its first birth, so when the stream (re)starts (the layer's first
// frame, or switching it back on) one prewarm dispatch fills it with what a
// steady stream would hold there at that moment, and the layer fades that
// population in over FADE_IN_SECONDS, as the kaleidoscope layer does. A
// stream with nothing to fill it (Speed or Rate at 0) keeps the fill
// waiting until it has, unless the ring still holds particles from before,
// which then carry on as they were. A tab switch needs no fill: the engine's
// gap guard only drops that one frame's time, and the particles in flight
// are all still there.
//
// Video feedback, with the settings and swings of the Confetti layer's (see
// confetti.js), key for key (partFb... for confFb...), but a different
// architecture, because particles are light, not paper. Confetti routes its
// whole draw through the feedback image; here the live particles are always
// drawn straight to the scene (through their fold when Kaleidoscope is on),
// exactly as they were before the feedback existed, and the image is a TRAIL
// layer of its own, composited under them. Each frame that image starts as a
// faded copy of the last, streamed and twisted about the field centre
// (feedback.js), and this frame's light goes in by the Blend setting
// (S.partFbBlend). Additive lays it onto the fading trails, so overlapping
// paths and slow fades build on each other — light added onto an
// exponential-decay accumulator settles at 1/(1-k) times the raw
// brightness, so a long half-life blooms toward white, which is the point
// of choosing it and what the Amount slider throttles. Max keeps each texel
// at the brighter of the faded past and the new light instead: bounded by
// the brightest single frame at any setting, a moving particle leaves a
// comet of exactly its own brightness fading at the half-life. The image's
// alpha stays 0 either way (nothing writes it), so the composite lays pure
// added light over the scene, and Opacity and Pulse with strobe shape only
// the trails; the live particles keep their own dials. Stopped with trails,
// the image holds.
//
// Nothing is made until the layer is first switched on, and nothing is
// allocated per frame after that. The feedback images are made when the
// layer comes on with the feedback in use, the canvas or the chamber changes
// size, or the feedback moves before or after the fold, and let go when the
// layer goes off.

import { S, Z_NEAR, Z_FAR } from '../../js/state.js';
import { scaledStrobeDepth } from '../../js/strobe-scale.js';
import { SIM_WGSL, RENDER_WGSL } from './particles.wgsl.js';
import { motionStep } from '../core/motion.js';
import { eye } from '../core/eye.js';
import { roomPhase, roomPhaseState } from '../core/room-clock.js';
import { createFold, FOLD_CHAMBER_FORMAT } from './fold.js';
import { createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT } from './feedback.js';
import { particleBirthsPerSec, PARTICLE_MEAN_VZ, PARTICLE_SLOWEST } from '../core/schema-particles.js';
// the sequencer channel's peak through the mirror, which reads it from the
// page in worker mode (core/audio-mirror.js)
import { arpPeakNow } from '../core/audio-mirror.js';

export const EMITTER_IDS = { center: 0, ring: 1, spiral: 2 };
export const STYLE_IDS = { glow: 0, streak: 1, spark: 2, bokeh: 3, dust: 4 };
export const COLOUR_IDS = { strobe: 0, rainbow: 1, white: 2 };

// How far out an emitter's births can start (reachA, tunnel units) and how
// fast they can drift outward (reachB, tunnel units per unit of travel), at
// most, as emitParticle draws them at this Spread. Only the birth-rate cap
// reads them, so a bound is enough; a new emitter adds its line here.
let reachA = 0, reachB = 0;
function emitterReach(emitter, spread) {
  if (emitter === EMITTER_IDS.ring) { reachA = 0.05 + spread * 0.95; reachB = 0.02; }
  else if (emitter === EMITTER_IDS.spiral) { reachA = 0.03 + spread * 0.6; reachB = spread * 0.05; }
  else { reachA = 0.01 + spread * 0.06; reachB = spread * 0.3; }
}

// The shallowest any particle lives, as a fraction of Z_NEAR: each one leaves
// where it crosses the rim, at |xy| * Z_NEAR, but never nearer than this.
// Must match EXIT_FLOOR in particles.wgsl.js.
const EXIT_FLOOR = 0.05;

const CAPACITY = 32768;
const P_BYTES = 48;                  // three vec4f per particle, see struct P
const WORKGROUP = 64;
const SIM_FLOATS = 20, RENDER_FLOATS = 24;   // SIM: five vec4f of Sim; RENDER: five vec4f of R, plus the fade vec4f
// Where a birth is placed: the point on its path where the radial fade in
// reaches a quarter of one 8-bit step. Below that no style at full opacity
// can light a pixel (the spark peaks at three times its brightness, and a
// hue turn can lift a strobe colour's channel up to a third over 1), so
// nothing is lost ahead of it.
const BIRTH_FADE = 0.25 / 255;
// Births land up to this many seconds of flight short of that point, at
// random, so they do not all come up on one ring of the screen.
const BIRTH_JITTER_SEC = 0.3;
// Frames of birth history the live window can look back over (see
// histLive): about half a minute at 120 Hz, past which it covers the whole
// ring as it always used to.
const HIST = 4096;
// The indirect draw's arguments: vertex count, instance count (the
// simulation's tally), first vertex, first instance.
const ARGS_BYTES = 16;
// Vertices per particle: one quad, or for the spark its cross as three.
const QUAD_VERTS = 6, SPARK_VERTS = 18;
// Births per second and flight time live in schema-particles.js, shared
// with the Rate and Speed readouts.
// Dust is smaller than the other styles.
const DUST_SIZE = 0.35;
// Largest particle on screen, in css px, so one passing right by the viewer
// does not fill the screen.
const MAX_SIZE_CSS = 90;
// The layer's fade in after a prewarm, as the kaleidoscope layer's.
const FADE_IN_SECONDS = 1.2;
const TAU = Math.PI * 2;
// Feedback, as confetti.js has it: the trails' half-life, seconds, at
// Feedback 100%. The slider s gives HL_MAX * s * s, so the low end, where
// short trails live, gets most of the slider's travel.
const HL_MAX = 2.0;
// Stream at full either way: the trail image's scale changes by
// exp(STREAM_MAX) a second, about 1.65 times bigger (out) or smaller (in).
const STREAM_MAX = 0.5;
// Twist at full either way, radians a second: about 46 degrees, an eighth
// of a turn, so the swirl reads as a drift rather than a spin.
const TWIST_MAX = 0.8;

const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v)) ? (v < lo ? lo : v > hi ? hi : v) : def;

// One setting swung by its variance at a phase (0 to 1) of its cycle, as
// confetti.js's: with osc = sin(TAU * phase), the positive half carries it up
// by osc * hi and the negative half down by -osc * lo (lo is 0 or below),
// clamped to the setting's own min and max. With no variance it is the
// setting exactly.
function swing(base, lo, hi, phase, min, max) {
  if (lo === 0 && hi === 0) return base;
  const osc = Math.sin(TAU * phase);
  const v = base + (osc >= 0 ? osc * hi : -osc * lo);
  return v < min ? min : v > max ? max : v;
}

// The kr (screen radius over the rings' rim) where radialFadeIn(f, kr) of
// core/fade.js reaches BIRTH_FADE. That curve is a smoothstep raised to
// 1 + 2f, so this undoes the power, then the smoothstep, whose inverse is
// 1/2 - sin(asin(1 - 2y) / 3). 0 means no fade in: every birth shows where
// it is emitted, at the far plane.
function firstVisibleK(f) {
  if (f < 0.01) return 0;
  const y = Math.pow(BIRTH_FADE, 1 / (1 + f * 2));
  return f * 0.98 * (0.5 - Math.sin(Math.asin(1 - 2 * y) / 3));
}

// The most travel (tunnel time, seconds times Speed) any birth made now can
// have ahead of it, from where birthParticle places it to the deepest any
// particle can live: the exit floor, Z_NEAR * EXIT_FLOOR. A particle leaves
// where it crosses the rim, at |xy| * Z_NEAR, so one with small |xy| flies on
// past the viewer plane until it crosses the rim or reaches the floor, and
// the bound has to cover that longest life.
//
// A particle's |xy| is at most a + b s after s of travel (the swirl only
// turns it), and it first shows where |xy| = m z, m = k / Z_NEAR. For the
// straight line a + b s against the depth z0 - c s that happens at depth
// z = (z0 b + a c) / (b + m c), which only grows with a, b and z0 and
// shrinks with c, as does the time left from there, so the emitter's
// reach, the deepest start (Z_FAR) and the slowest particle bound every
// birth. The jitter can place one up to its own length further back. If the
// reach can already show at the far plane, the bound is the whole flight,
// as before; if even the bound never shows, every birth is dropped and none
// lives at all, which leaves only the jitter.
function birthTravel(emitter, spread, k, speed) {
  const c = PARTICLE_MEAN_VZ * PARTICLE_SLOWEST;
  const whole = (Z_FAR - Z_NEAR * EXIT_FLOOR) / c;
  const m = k / Z_NEAR;
  emitterReach(emitter, spread);
  if (!(m > 0) || reachA >= m * Z_FAR) return whole;
  const z = (Z_FAR * reachB + reachA * c) / (reachB + m * c);
  const t = Math.max(z - Z_NEAR * EXIT_FLOOR, 0) / c + BIRTH_JITTER_SEC * speed;
  return t < whole ? t : whole;
}

export function createParticles(device, format, platform) {
  let pixelW = 1, pixelH = 1, dpr = 1;
  let made = false;
  let partBuf = null, simBuf = null, renBuf = null, visBuf = null, argsBuf = null;
  let simPipe = null, prewarmPipe = null, screenPipe = null, chamberPipe = null, imagePipe = null, imagePipeMax = null;
  let simBind = null, renBind = null;
  let foldAdd = null, foldMax = null;
  // The trail images (see the top of this file): fbScreen is canvas sized
  // and composited under the live particles, fbChamber the chamber's size
  // for feedback before the fold, where foldScene lays it into the scene
  // instead. foldScene owns the chamber and draws the raw folded particles
  // into the scene in every folded mode; fold only reads that chamber into
  // fbScreen. fbParams is this frame's feedback, for whichever image is in
  // use, and before says which that is. layerOn is the layer switch as
  // update() found it.
  let fbScreen = null, fbChamber = null, foldScene = null;
  const fbParams = { keepHalfLife: 0, zoomRate: 0, twistRate: 0, cx: 0, cy: 0, unit: 1, dt: 0 };
  let before = false, layerOn = false;
  // The bypass: with the feedback not in use there is no image work at all,
  // and the images are let go. The raw particles draw the same either way.
  let bypass = false;
  const sim = new Float32Array(SIM_FLOATS);
  const ren = new Float32Array(RENDER_FLOATS);
  const args = new Uint32Array(ARGS_BYTES / 4);
  const foldParams = { folds: 8, mirror: true, rotation: 0, gain: 1, colorGain: 1 };
  // The same fold shape for laying the TRAIL image into the scene (the
  // before route): its gain is the trails' opacity and its colorGain their
  // pulse, where foldParams stays plain for the raw particles.
  const foldFbParams = { folds: 8, mirror: true, rotation: 0, gain: 1, colorGain: 1 };
  // The trail image's pulse (its colour gain this frame) and opacity over
  // the scene, whether the Blend setting holds peaks (max) rather than
  // adding, and the phases (0 to 1) of the pulse, Amount, Stream and Twist
  // variances' cycles, each its own, and the Center fade radius's beside them.
  // Each phase also has its room bookkeeping: in a broadcast room it is
  // pulled onto the room clock (core/room-clock.js), so every screen swings
  // together.
  let fbGain = 1, fbOpacity = 1, fbMax = false;
  let pulsePhase = 0, opPhase = 0, streamPhase = 0, twistPhase = 0, fadePhase = 0;
  const pulseRoom = roomPhaseState(), opRoom = roomPhaseState(), streamRoom = roomPhaseState();
  const twistRoom = roomPhaseState(), fadeRoom = roomPhaseState();

  let cursor = 0, spawned = 0, spawnAcc = 0, frameSeed = 1;
  let foldRot = 0;
  let active = false, kaleidoNow = false, spawnCount = 0, spawnStart = 0;
  // wasOn: the layer was on last frame. needFill: the stream has (re)started
  // and still wants its prewarm. fillN: particles the prewarm encoded this
  // frame lays down (0 for none). layerFade: the fade in after it, 0 to 1.
  let wasOn = false, needFill = false, fillN = 0, layerFade = 1;
  // The sequencer follower's level, 0..1 (Pulse with sequencer).
  let seqEnv = 0;

  // The live window. travelClock is how far every particle in flight has
  // moved along its path (tunnel time: seconds times Speed) since the layer
  // was made; it stops with the stream and follows the live Speed, so it
  // measures what a particle's life is really spent on. travelHold is the
  // most any particle in flight may still have ahead of it. The history
  // keeps, per frame with births, the ring count before them and the latest
  // travel clock by which any birth so far may still be alive (a running
  // maximum, so it only grows and can be searched). winStart and winCount
  // are the slots this frame's simulation visits.
  let travelClock = 0, travelHold = 0, winStart = 0, winCount = 0;
  const histBefore = new Float64Array(HIST), histUntil = new Float64Array(HIST);
  let histHead = 0, histLen = 0, histLost = false, histMax = 0;

  function histReset() { histHead = 0; histLen = 0; histLost = false; histMax = 0; }
  function histPush(before, until) {
    if (until > histMax) histMax = until;
    histBefore[histHead] = before;
    histUntil[histHead] = histMax;
    histHead = (histHead + 1) % HIST;
    if (histLen < HIST) histLen++; else histLost = true;
  }
  // How many of the latest births may still be in flight: all of them from
  // the first history entry whose births may outlive `since`. If that is the
  // oldest entry left and older ones have been overwritten, there is no
  // telling, so everything counts.
  function histLive(since) {
    const oldest = (histHead - histLen + HIST) % HIST;
    let lo = 0, hi = histLen;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (histUntil[(oldest + mid) % HIST] > since) hi = mid; else lo = mid + 1;
    }
    if (lo === histLen) return 0;
    if (lo === 0 && histLost) return spawned;
    return spawned - histBefore[(oldest + lo) % HIST];
  }

  function check(mod, name) {
    if (!mod.getCompilationInfo) return;
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn(name + ' compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }

  function make() {
    made = true;
    partBuf = device.createBuffer({ label: 'particles.buffer', size: CAPACITY * P_BYTES, usage: GPUBufferUsage.STORAGE });
    simBuf = device.createBuffer({ label: 'particles.sim.uniforms', size: SIM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    renBuf = device.createBuffer({ label: 'particles.render.uniforms', size: RENDER_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // The visible list holds at most every slot once.
    visBuf = device.createBuffer({ label: 'particles.visible', size: CAPACITY * 4, usage: GPUBufferUsage.STORAGE });
    argsBuf = device.createBuffer({ label: 'particles.draw.args', size: ARGS_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });

    const simMod = device.createShaderModule({ label: 'particles.sim.wgsl', code: SIM_WGSL });
    check(simMod, 'particles.sim.wgsl');
    const simBgl = device.createBindGroupLayout({
      label: 'particles.sim.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        // the render block, so the visibility test sees exactly what the draw will
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
      ]
    });
    const simLayout = device.createPipelineLayout({ label: 'particles.sim.layout', bindGroupLayouts: [simBgl] });
    simPipe = device.createComputePipeline({
      label: 'particles.sim', layout: simLayout,
      compute: { module: simMod, entryPoint: 'simMain' }
    });
    prewarmPipe = device.createComputePipeline({
      label: 'particles.prewarm', layout: simLayout,
      compute: { module: simMod, entryPoint: 'prewarmMain' }
    });
    simBind = device.createBindGroup({
      label: 'particles.sim.bind', layout: simBgl,
      entries: [
        { binding: 0, resource: { buffer: simBuf } },
        { binding: 1, resource: { buffer: partBuf } },
        { binding: 2, resource: { buffer: renBuf } },
        { binding: 3, resource: { buffer: visBuf } },
        { binding: 4, resource: { buffer: argsBuf } }
      ]
    });

    const renMod = device.createShaderModule({ label: 'particles.render.wgsl', code: RENDER_WGSL });
    check(renMod, 'particles.render.wgsl');
    const renBgl = device.createBindGroupLayout({
      label: 'particles.render.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }
      ]
    });
    const renLayout = device.createPipelineLayout({ label: 'particles.render.layout', bindGroupLayouts: [renBgl] });
    // Pure light: added to whatever is beneath, alpha untouched.
    const add = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    };
    const pipeFor = (fmt, name) => device.createRenderPipeline({
      label: name, layout: renLayout,
      vertex: { module: renMod, entryPoint: 'vsPart' },
      fragment: { module: renMod, entryPoint: 'fsPart', targets: [{ format: fmt, blend: add }] },
      primitive: { topology: 'triangle-list' }
    });
    screenPipe = pipeFor(format, 'particles.draw.screen');
    chamberPipe = pipeFor(FOLD_CHAMBER_FORMAT, 'particles.draw.chamber');
    // Into a feedback image, one pipe per Blend setting (see the top of
    // this file): Additive lays the light onto the fading trails, so
    // overlapping paths build and bloom; Max keeps each texel at the
    // brightest light that recently passed, bounded by one frame's worth.
    // Alpha stays at the image's clear 0 either way (added as 0, or maxed
    // with 0). WebGPU ignores the factors for max but validates them.
    imagePipe = pipeFor(FEEDBACK_FORMAT, 'particles.draw.image');
    const maxBlend = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
    };
    imagePipeMax = device.createRenderPipeline({
      label: 'particles.draw.image.max', layout: renLayout,
      vertex: { module: renMod, entryPoint: 'vsPart' },
      fragment: { module: renMod, entryPoint: 'fsPart', targets: [{ format: FEEDBACK_FORMAT, blend: maxBlend }] },
      primitive: { topology: 'triangle-list' }
    });
    renBind = device.createBindGroup({
      label: 'particles.render.bind', layout: renBgl,
      entries: [
        { binding: 0, resource: { buffer: renBuf } },
        { binding: 1, resource: { buffer: partBuf } },
        { binding: 2, resource: { buffer: visBuf } }
      ]
    });
    // foldScene owns the one chamber and adds the raw folded light into the
    // scene, every folded frame, feedback or not. foldAdd and foldMax read
    // that same chamber (drawFrom) and lay the folded pattern into fbScreen,
    // one per Blend setting since a fold's blend is baked into its pipeline;
    // neither ever needs a chamber of its own.
    fbScreen = createFeedback(device, format, { label: 'particles.feedback' });
    fbChamber = createFeedback(device, format, { label: 'particles.feedback.chamber' });
    foldAdd = createFold(device, FEEDBACK_FORMAT, { label: 'particles.fold', blend: 'add' });
    foldMax = createFold(device, FEEDBACK_FORMAT, { label: 'particles.fold.max', blend: 'max' });
    foldScene = createFold(device, format, { label: 'particles.fold.scene', blend: 'add' });
  }

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw); pixelH = Math.max(1, ph); dpr = d || 1;
  }

  function update(t, dt, lum) {
    active = false;
    spawnCount = 0;
    const lyr = S.layers;
    if (!lyr || !lyr.particles) {
      // Off: nothing draws, and the trails go with it, so the layer comes
      // back from a cleared image.
      wasOn = false; layerOn = false;
      if (made) { fbScreen.release(); fbChamber.release(); }
      return;
    }
    if (!made) make();
    layerOn = true;
    // The layer's first frame, or back on after being off: the stream
    // restarts, and whatever it shows fades in.
    if (!wasOn) {
      wasOn = true;
      needFill = true;
      layerFade = 0;
    }

    const style = STYLE_IDS[S.partStyle] ?? 0;
    const emitter = EMITTER_IDS[S.partEmitter] ?? 0;
    const colour = COLOUR_IDS[S.partColor] ?? 0;
    const rate = clampNum(S.partRate, 0, 1, 0.5);
    const speed = clampNum(S.partSpeed, 0, 0.5, 0.25);
    let sizeMul = clampNum(S.partSize, 0.2, 3, 1);
    if (style === STYLE_IDS.dust) sizeMul *= DUST_SIZE;
    const sizeVar = clampNum(S.partSizeVar, 0, 1, 0.5);
    const spread = clampNum(S.partSpread, 0, 1, 0.35);
    const swirl = clampNum(S.partSwirl, -1, 1, 0);
    const trail = clampNum(S.partTrail, 0, 1, 0.5);
    const hueVar = clampNum(S.partHueVar, 0, 1, 0.15);
    const opacity = clampNum(S.partOpacity, 0, 1, 0.9);
    const pulse = scaledStrobeDepth(clampNum(S.partPulse, 0, 1, 0));
    kaleidoNow = !!S.partKaleido;

    // Pulse with sequencer: the sequencer channel's peak this frame, scaled
    // by Sensitivity and followed with the Attack and Release times, so the
    // particles rise with each note and fall away as it (and its echoes)
    // dies. Read only while one of the two amounts is up.
    const seqOn = !!S.partSeqOn;
    const seqAmt = seqOn ? clampNum(S.partSeqPulse, 0, 1, 0) : 0, seqSize = seqOn ? clampNum(S.partSeqSize, 0, 1, 0) : 0;
    if (seqAmt > 0 || seqSize > 0) {
      const target = Math.min(1, arpPeakNow() * clampNum(S.partSeqSens, 0.5, 20, 4));
      const tc = target > seqEnv ? clampNum(S.partSeqAtk, 0.001, 0.3, 0.01) : clampNum(S.partSeqRel, 0.02, 2, 0.25);
      const fdt = dt > 0 && dt < 0.25 ? dt : 0;
      seqEnv += (target - seqEnv) * (1 - Math.exp(-fdt / tc));
      sizeMul *= 1 + seqSize * seqEnv;
    } else seqEnv = 0;

    // Stopped, the tunnel holds still: no births, no motion, still drawn.
    // After a pause it first coasts to that stop (core/motion.js).
    const step = dt > 0 && dt < 0.25 ? motionStep(dt) : 0;

    // The Center fade radius, swung by its variance the way the feedback's
    // pulse is below: its phase advances by the frame's step over its rate,
    // so a stopped scene holds the radius where it is, and over one cycle it
    // eases from the setting down by the variance's share and back. At 0 it
    // is the setting exactly. Everything after reads the swung radius, so
    // where births first show follows it too, and travelHold covers the
    // particles born before it moved. In a room the phase is then pulled
    // onto the room clock's (core/room-clock.js); outside one that is a no-op.
    const fadeRate = clampNum(S.partFadeRate, 1, 60, 10);
    fadePhase += step / fadeRate;
    fadePhase -= Math.floor(fadePhase);
    fadePhase = roomPhase(fadeRoom, fadePhase, t, step, fadeRate, S.partFadeRateOff || 0);
    let fadeIn = clampNum(S.partFade, 0, 1, 0.55);
    const fadeVar = clampNum(S.partFadeVar, 0, 1, 0);
    if (fadeVar > 0) fadeIn *= 1 - fadeVar * 0.5 * (1 - Math.cos(TAU * fadePhase));
    S.effPartFade = fadeIn;

    // Everything in flight moves this frame's travel along its path.
    const stepTravel = step * speed;
    travelClock += stepTravel;

    // Where births show first, and the longest any of them can then live.
    const kVis = firstVisibleK(fadeIn);
    const reach = birthTravel(emitter, spread, kVis, speed);

    // Births per second at this Rate (shared with the Rate readout in
    // schema-particles.js, so what it says is what happens). A frozen stream
    // has no births at all.
    let perSec = speed > 0.001 ? particleBirthsPerSec(rate, S.partStyle) : 0;
    const fillNow = needFill && perSec > 0;
    // The most travel anything in flight may still have ahead of it: every
    // frame takes this frame's travel off everyone's, and a birth brings at
    // most reach. A restart clears the ring, so it starts again from reach.
    // Holding it this way, rather than taking this frame's reach alone,
    // keeps the particles born before a change of Fade in, Spread or
    // Emitter covered for as long as they can still be flying.
    travelHold = fillNow ? reach : Math.max(reach, travelHold - stepTravel);
    // The rate is capped so that no slot is handed to a new birth while its
    // particle may still be in flight: CAPACITY births (less a margin) must
    // take longer than the longest life, travelHold / speed seconds. With
    // lives cut to their visible part, this rarely binds.
    if (perSec > 0) {
      const cap = CAPACITY * 0.95 * speed / travelHold;
      if (perSec > cap) perSec = cap;
    }

    // The prewarm, once there is a stream to fill it with: every birth of
    // the last travelHold / speed seconds, the longest any of them can still
    // be in flight, which the cap keeps inside the ring. Stopped or not: a
    // stopped scene shows the tunnel full and still.
    if (needFill) {
      if (fillNow) {
        let fill = Math.ceil(perSec * travelHold / speed);
        if (fill > CAPACITY) fill = CAPACITY;
        if (fill < 1) fill = 1;
        fillN = fill;
        cursor = fill % CAPACITY;
        spawned = fill;
        spawnAcc = 0;
        layerFade = 0;
        needFill = false;
        // The whole fill counts as born now, each with at most reach left.
        histReset();
        histPush(0, travelClock + reach);
      } else if (spawned > 0) {
        // Frozen or not birthing, over particles the ring still holds from
        // before: those carry on exactly as they were.
        needFill = false;
      }
    }
    if (layerFade < 1 && dt > 0) layerFade = Math.min(1, layerFade + dt / FADE_IN_SECONDS);

    // The prewarm's frame has no births of its own: its newest particle is
    // this frame's.
    spawnAcc += fillN > 0 ? 0 : perSec * step;
    let n = spawnAcc | 0;
    if (n > CAPACITY) n = CAPACITY;
    spawnAcc -= n;
    spawnStart = cursor;
    spawnCount = n;
    if (n > 0) histPush(spawned, travelClock + reach);
    cursor = (cursor + n) % CAPACITY;
    spawned += n;
    frameSeed = (frameSeed + 1) % 1000000;

    // The live window: the slots born since the first history entry whose
    // particles may have been alive at the start of this frame's step, so a
    // particle's last step, the one that takes it past the viewer and lets
    // it go, is still taken. They run back around the ring from the cursor.
    let live = histLive(travelClock - stepTravel);
    if (live > CAPACITY) live = CAPACITY;
    winCount = live;
    winStart = ((cursor - live) % CAPACITY + CAPACITY) % CAPACITY;

    // Where births land (sim.d.x is read only at birth, particles.wgsl.js):
    // Origin depth's share of the tunnel in log z, the rings' own mapping
    // (js/sim.js ringBirthZ), so the slider moves the birth ring evenly;
    // 100% is Z_FAR, exactly as it always was.
    const originO = clampNum(S.partOrigin, 0.05, 1, 1);
    const birthZ = originO >= 1 ? Z_FAR : Z_NEAR * Math.pow(Z_FAR / Z_NEAR, originO);
    sim[0] = step; sim[1] = t / 1000; sim[2] = spawnStart; sim[3] = spawnCount;
    sim[4] = CAPACITY; sim[5] = emitter; sim[6] = speed; sim[7] = spread;
    sim[8] = swirl; sim[9] = sizeMul; sim[10] = sizeVar; sim[11] = frameSeed * 7919;
    sim[12] = birthZ; sim[13] = Z_NEAR; sim[14] = fillN; sim[15] = perSec;
    sim[16] = winStart; sim[17] = winCount; sim[18] = kVis; sim[19] = BIRTH_JITTER_SEC;
    device.queue.writeBuffer(simBuf, 0, sim);

    // The field centre and the rings' projection, recentred on the area the
    // drawer leaves visible, in device pixels.
    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    const visW = Math.max(1, cssW - inset);
    const cx = (inset + visW * 0.5) * dpr, cy = cssH * 0.5 * dpr;
    const maxR = Math.hypot(visW, cssH) * 0.62 * dpr;
    const focal = maxR * Z_NEAR;

    const l = lum > 0 ? (lum < 1 ? lum : 1) : 0;
    const gain = opacity * (1 - pulse + pulse * l) * (1 - seqAmt + seqAmt * seqEnv) * layerFade;

    // This frame's feedback, exactly as confetti.js works it out: the
    // half-life from the slider's square (0, no trails), the stream and
    // twist rates, and the frame's step, 0 while stopped, which holds the
    // image. Stream and Twist first swing by their variances, and the
    // trails' opacity dips by its own further down, each phase advancing by
    // the frame's step over its rate, so a stopped scene holds the swing
    // where it is. In a room each is pulled onto the room clock, as the
    // fade radius's is above.
    const opRate = clampNum(S.partFbOpVarRate, 1, 120, 20);
    const streamRate = clampNum(S.partFbStreamVarRate, 1, 120, 20);
    const twistRate = clampNum(S.partFbTwistVarRate, 1, 120, 20);
    opPhase += step / opRate;
    opPhase -= Math.floor(opPhase);
    streamPhase += step / streamRate;
    streamPhase -= Math.floor(streamPhase);
    twistPhase += step / twistRate;
    twistPhase -= Math.floor(twistPhase);
    opPhase = roomPhase(opRoom, opPhase, t, step, opRate, S.partFbOpVarRateOff || 0);
    streamPhase = roomPhase(streamRoom, streamPhase, t, step, streamRate, S.partFbStreamVarRateOff || 0);
    twistPhase = roomPhase(twistRoom, twistPhase, t, step, twistRate, S.partFbTwistVarRateOff || 0);
    const fbBase = clampNum(S.partFeedback, 0, 1, 0);
    const fbStream = swing(clampNum(S.partFbStream, -2, 2, 0),
      clampNum(S.partFbStreamVarLo, -4, 0, 0), clampNum(S.partFbStreamVarHi, 0, 4, 0), streamPhase, -2, 2);
    const fbTwistBase = clampNum(S.partFbTwist, -1, 1, 0);
    // partFbTwistVarMix crossfades the plain setting into the swing while
    // the performance window brings the variance in or out (1 when unset)
    const twistMix = clampNum(S.partFbTwistVarMix, 0, 1, 1);
    const fbTwist = S.partFbTwistVarOn === false ? fbTwistBase
      : fbTwistBase + (swing(fbTwistBase, clampNum(S.partFbTwistVarLo, -2, 0, 0),
        clampNum(S.partFbTwistVarHi, 0, 2, 0), twistPhase, -1, 1) - fbTwistBase) * twistMix;
    S.effPartFbStream = fbStream;
    S.effPartFbTwist = fbTwist;
    const fbInUse = fbBase > 0;
    before = kaleidoNow && fbInUse && S.partFbWhere === 'before';
    // The Render section's Trail res: fbScreen's texels per device pixel,
    // handed to its ensure and to the fold that lays the chamber's pattern
    // into it, so the two agree (feedback.js, fold.js fit). fbChamber is
    // already small and keeps its own size. The Trail switch says whether a
    // change of it keeps fbScreen's trails (feedback.js ensure's keep).
    const fbRes = feedbackRes(S.fbResScale);
    const fbKeep = feedbackKeep(S.fbResSwitch);
    fbParams.keepHalfLife = HL_MAX * fbBase * fbBase;
    fbParams.zoomRate = STREAM_MAX * fbStream;
    fbParams.twistRate = TWIST_MAX * fbTwist;
    fbParams.dt = step;

    // The feedback's Pulse with strobe, as confetti's: the amount swung by
    // its variance (over one Variance rate cycle it eases from the setting
    // down by the variance's share and back), then the colour gain from the
    // strobe's lum. Stopped, the phase holds and so does the gain.
    const pulseRate = clampNum(S.partFbPulseRate, 1, 60, 10);
    pulsePhase += step / pulseRate;
    pulsePhase -= Math.floor(pulsePhase);
    pulsePhase = roomPhase(pulseRoom, pulsePhase, t, step, pulseRate, S.partFbPulseRateOff || 0);
    let fbPulse = clampNum(S.partFbPulse, 0, 1, 0);
    const fbPulseVar = clampNum(S.partFbPulseVar, 0, 1, 0);
    if (fbPulseVar > 0) fbPulse *= 1 - fbPulseVar * 0.5 * (1 - Math.cos(TAU * pulsePhase));
    fbPulse = scaledStrobeDepth(fbPulse);
    S.effPartFbPulse = fbPulse;
    fbGain = 1 - fbPulse + fbPulse * l;
    // The trails' Opacity, dipped by its variance as the Pulse above: over
    // one Variance rate cycle it eases from the setting down by the
    // variance's share and back.
    fbOpacity = clampNum(S.partFbOpacity, 0, 1, 1);
    const fbOpVar = clampNum(S.partFbOpVar, 0, 1, 0);
    if (fbOpVar > 0) fbOpacity *= 1 - fbOpVar * 0.5 * (1 - Math.cos(TAU * opPhase));
    S.effPartFbOpacity = fbOpacity;
    fbMax = S.partFbBlend === 'max';
    // The bypass (see its note in createParticles): the feedback not in use,
    // so no image work this frame.
    bypass = !fbInUse;

    // Where the particles land: the screen about the field centre, or with
    // Kaleidoscope on foldScene's chamber (see fold.js for the mapping).
    if (kaleidoNow) {
      // The params first: the chamber is sized to the domain they make.
      // foldScene always owns it and draws the raw particles plain; the
      // trail read (foldFbParams) carries the same shape with the trails'
      // opacity and pulse, only read in the before route.
      foldRot += clampNum(S.partFoldSpin, -1, 1, 0.05) * 0.5 * step;
      foldParams.folds = clampNum(S.partFolds, 3, 16, 8);
      foldParams.mirror = S.partMirror !== false;
      foldParams.rotation = foldRot;
      foldFbParams.folds = foldParams.folds;
      foldFbParams.mirror = foldParams.mirror;
      foldFbParams.rotation = foldRot;
      foldFbParams.gain = fbOpacity;
      foldFbParams.colorGain = fbGain;
      foldScene.ensureChamber(pixelW, pixelH, foldParams);
      foldScene.fit(cx, cy);
      // After the fold, the Blend setting's fold reads foldScene's chamber
      // into the trail image (drawFrom), so it needs the same frame but no
      // texture of its own (ensureChamber's external flag). Same inputs,
      // same res, so the two frames agree texel for texel.
      (fbMax ? foldAdd : foldMax).releaseChamber();
      if (!bypass && !before) {
        const fi = fbMax ? foldMax : foldAdd;
        fi.ensureChamber(pixelW, pixelH, foldParams, true);
        fi.fit(cx, cy, fbRes);
      } else {
        (fbMax ? foldMax : foldAdd).releaseChamber();
      }
      const f = foldScene.frame;
      ren[0] = f[4]; ren[1] = f[5]; ren[2] = f[6]; ren[3] = focal;
      ren[4] = f[2]; ren[5] = f[3];
    } else {
      ren[0] = cx; ren[1] = cy; ren[2] = 1; ren[3] = focal;
      ren[4] = 1 / pixelW; ren[5] = 1 / pixelH;
      foldAdd.releaseChamber();
      foldMax.releaseChamber();
      foldScene.releaseChamber();
    }
    // The feedback image in use, sized, with its centre in its own texels
    // and its unit: how many of its texels one tunnel unit of scene covers,
    // so a drawer slide, which moves the centre and shrinks focal with the
    // visible field, carries and rescales the trails with the scene
    // (feedback.js). On screen the unit is focal itself; in the chamber it
    // is focal times the chamber's texels per device pixel. The image not in
    // use is let go, so coming back to it starts clear. The screen image's
    // centre and unit stay in device px at any Trail res: feedback.js takes
    // them into its own texels by the scale ensure was given.
    if (bypass) {
      fbScreen.release();
      fbChamber.release();
    } else if (before) {
      const f = foldScene.frame;
      fbChamber.ensure(f[0], f[1]);
      fbParams.cx = f[4]; fbParams.cy = f[5]; fbParams.unit = focal * f[6];
      fbScreen.release();
    } else {
      fbScreen.ensure(pixelW, pixelH, fbRes, fbKeep);
      fbParams.cx = cx; fbParams.cy = cy; fbParams.unit = focal;
      fbChamber.release();
    }
    ren[6] = MAX_SIZE_CSS * dpr; ren[7] = style;
    const rgb = S.rgb;
    ren[8] = rgb[0] / 255; ren[9] = rgb[1] / 255; ren[10] = rgb[2] / 255; ren[11] = colour;
    // The live particles' own brightness; the trails' Opacity and Pulse
    // never touch it, only the trail image (see the top of this file).
    ren[12] = gain; ren[13] = hueVar; ren[14] = t / 1000; ren[15] = trail;
    ren[16] = Z_FAR; ren[17] = Z_NEAR; ren[18] = sizeMul; ren[19] = speed;
    // The radial fade: the Fade in amount, and one over the rings' rim in
    // device px, so the shader's k is the rings' k for the same radius. The
    // rim is maxR in both paths, since the chamber keeps the screen's own
    // device-px radius about the field centre. Then the viewer's eye, tunnel
    // units (core/eye.js), which footprint takes off each particle's xy
    // before projecting it. It needs no overscan here: the simulation's cull
    // is footprint's own quad against the target, shifted with the rest, and
    // the fades that decide where a particle is born and let go ride with
    // the particle, so leaning never shows an edge the stream stops at.
    ren[20] = fadeIn; ren[21] = 1 / maxR; ren[22] = eye.x; ren[23] = eye.y;
    device.queue.writeBuffer(renBuf, 0, ren);

    // The draw's arguments, with the instance count back at 0 for the
    // simulation to count up. Queued ahead of this frame's submit, so the
    // compute pass sees the zero and the draws see its tally.
    args[0] = style === STYLE_IDS.spark ? SPARK_VERTS : QUAD_VERTS;
    args[1] = 0; args[2] = 0; args[3] = 0;
    device.queue.writeBuffer(argsBuf, 0, args);

    active = gain > 0.002 || spawnCount > 0;
  }

  // Encoded by the engine before the scene pass: on a restart the prewarm
  // over the whole ring, then the simulation step, which also writes the
  // visible list and its count, then the particles into a fold's chamber
  // (with Kaleidoscope on) and the feedback image (with it in use), below.
  // Both dispatches share one compute pass; WebGPU
  // makes each dispatch's writes visible to the next, and only the second
  // appends to the list.
  //
  // The simulation covers only the live window, not every slot the ring has
  // ever handed out. Measured in travel rather than seconds, a particle's
  // life does not change when the live Speed slider does, so the window
  // (the births that may still be in flight, update above) is exact to
  // within the bound on each birth's life. With lives cut to their visible
  // part that is a fraction of the ring; the slots it leaves behind hold
  // particles that have finished their flight, and are not visited again
  // until the ring hands them to new births.
  // The compute pass's descriptor, built once. It carries timestampWrites
  // only while the frame profiler is recording (setTimestampWrites below);
  // api.computed tells the engine whether this frame encoded the pass at
  // all, so a timing slot it did not write is never read as one.
  const computeDesc = { timestampWrites: undefined };
  function setTimestampWrites(tw) { computeDesc.timestampWrites = tw; }

  function encode(encoder) {
    api.computed = false;
    if (!made || !S.layers || !S.layers.particles) return;
    const slots = winCount;
    if (slots > 0 || fillN > 0) {
      api.computed = true;
      const pass = encoder.beginComputePass(computeDesc);
      pass.setBindGroup(0, simBind);
      if (fillN > 0) {
        pass.setPipeline(prewarmPipe);
        pass.dispatchWorkgroups(CAPACITY / WORKGROUP);
        fillN = 0;
      }
      if (slots > 0) {
        pass.setPipeline(simPipe);
        pass.dispatchWorkgroups(Math.ceil(slots / WORKGROUP));
      }
      pass.end();
    }
    if (!layerOn) return;
    // The chamber first, whenever folded: this frame's raw particles, drawn
    // once and read twice, by foldScene into the scene and (feedback in use,
    // after the fold) by fold into the trail image. It runs feedback or not,
    // held or not: a stopped scene still draws its frozen particles.
    const folded = active && kaleidoNow && !!foldScene.chamberView;
    if (folded) {
      const cp = encoder.beginRenderPass(foldScene.chamberPassDesc);
      cp.setPipeline(chamberPipe);
      cp.setBindGroup(0, renBind);
      cp.drawIndirect(argsBuf, 0);
      cp.end();
    }
    // Then the trail image, when the feedback is in use. Its own pass fades,
    // streams and turns the last image in (or clears), so it runs even with
    // no particles to add (active false, the layer dimmed out) and trails
    // keep dying away. Held (stopped with trails), nothing goes in and the
    // image stays as it is. An image already faded to nothing with nothing
    // to add is skipped, and so is its composite (feedback.js).
    if (bypass) return;
    const ip = fbMax ? imagePipeMax : imagePipe;
    if (before) {
      // Before the fold: this frame's light into fbChamber, in chamber
      // space, by the Blend setting; draw() folds that image into the scene.
      const cp = fbChamber.begin(encoder, fbParams, active);
      if (!cp) return;
      if (active) {
        cp.setPipeline(ip);
        cp.setBindGroup(0, renBind);
        cp.drawIndirect(argsBuf, 0);
      }
      fbChamber.end(cp);
      return;
    }
    // After the fold, or unfolded: folded, the Blend setting's fold lays the
    // chamber's pattern into fbScreen; unfolded, the particles go in
    // straight.
    if (fbScreen.holds(fbParams)) { fbScreen.begin(encoder, fbParams, false); return; }
    const lp = fbScreen.begin(encoder, fbParams, folded || (active && !kaleidoNow));
    if (!lp) return;
    if (folded) {
      (fbMax ? foldMax : foldAdd).drawFrom(lp, foldParams, foldScene.chamberView);
    } else if (active && !kaleidoNow) {
      lp.setPipeline(ip);
      lp.setBindGroup(0, renBind);
      lp.drawIndirect(argsBuf, 0);
    }
    fbScreen.end(lp);
  }

  // Inside the scene pass, after the kaleidoscope layer and before the
  // edge: first the trail image, laid under (the composite, or before the
  // fold, foldScene reading fbChamber), then the live particles over it,
  // exactly as they drew before the feedback existed. The trails go by the
  // layer, not by active, so they still land and die away while the
  // particles themselves are dimmed out.
  function draw(pass) {
    if (!layerOn) return;
    if (!bypass) {
      if (before) foldScene.drawFrom(pass, foldFbParams, fbChamber.view);
      else fbScreen.composite(pass, fbGain, fbOpacity);
    }
    if (!active) return;
    if (kaleidoNow) { foldScene.draw(pass, foldParams); return; }
    pass.setPipeline(screenPipe);
    pass.setBindGroup(0, renBind);
    pass.drawIndirect(argsBuf, 0);
  }

  const api = { update, encode, draw, resize, setTimestampWrites, computed: false };
  return api;
}
