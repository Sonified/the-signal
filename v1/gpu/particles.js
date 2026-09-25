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
// Nothing is made until the layer is first switched on, and nothing is
// allocated per frame after that.

import { S, Z_NEAR, Z_FAR } from '../../js/state.js';
import { SIM_WGSL, RENDER_WGSL } from './particles.wgsl.js';
import { createFold, FOLD_CHAMBER_FORMAT } from './fold.js';
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

const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v)) ? (v < lo ? lo : v > hi ? hi : v) : def;

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
// have ahead of it, from where birthParticle places it to the viewer.
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
  const whole = (Z_FAR - Z_NEAR) / c;
  const m = k / Z_NEAR;
  emitterReach(emitter, spread);
  if (!(m > 0) || reachA >= m * Z_FAR) return whole;
  const z = (Z_FAR * reachB + reachA * c) / (reachB + m * c);
  const t = Math.max(z - Z_NEAR, 0) / c + BIRTH_JITTER_SEC * speed;
  return t < whole ? t : whole;
}

export function createParticles(device, format, platform) {
  let pixelW = 1, pixelH = 1, dpr = 1;
  let made = false;
  let partBuf = null, simBuf = null, renBuf = null, visBuf = null, argsBuf = null;
  let simPipe = null, prewarmPipe = null, screenPipe = null, chamberPipe = null;
  let simBind = null, renBind = null;
  let fold = null;
  const sim = new Float32Array(SIM_FLOATS);
  const ren = new Float32Array(RENDER_FLOATS);
  const args = new Uint32Array(ARGS_BYTES / 4);
  const foldParams = { folds: 8, mirror: true, rotation: 0, gain: 1 };

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
    renBind = device.createBindGroup({
      label: 'particles.render.bind', layout: renBgl,
      entries: [
        { binding: 0, resource: { buffer: renBuf } },
        { binding: 1, resource: { buffer: partBuf } },
        { binding: 2, resource: { buffer: visBuf } }
      ]
    });
    fold = createFold(device, format, { label: 'particles.fold', blend: 'add' });
  }

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw); pixelH = Math.max(1, ph); dpr = d || 1;
  }

  function update(t, dt, lum) {
    active = false;
    spawnCount = 0;
    const lyr = S.layers;
    if (!lyr || !lyr.particles) { wasOn = false; return; }
    if (!made) make();
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
    const pulse = clampNum(S.partPulse, 0, 1, 0);
    const fadeIn = clampNum(S.partFade, 0, 1, 0.55);
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
    const step = S.running ? (dt > 0 && dt < 0.25 ? dt : 0) : 0;

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

    sim[0] = step; sim[1] = t / 1000; sim[2] = spawnStart; sim[3] = spawnCount;
    sim[4] = CAPACITY; sim[5] = emitter; sim[6] = speed; sim[7] = spread;
    sim[8] = swirl; sim[9] = sizeMul; sim[10] = sizeVar; sim[11] = frameSeed * 7919;
    sim[12] = Z_FAR; sim[13] = Z_NEAR; sim[14] = fillN; sim[15] = perSec;
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

    if (kaleidoNow) {
      // The params first: the chamber is sized to the domain they make.
      foldRot += clampNum(S.partFoldSpin, -1, 1, 0.05) * 0.5 * step;
      foldParams.folds = clampNum(S.partFolds, 3, 16, 8);
      foldParams.mirror = S.partMirror !== false;
      foldParams.rotation = foldRot;
      foldParams.gain = 1;
      fold.ensureChamber(pixelW, pixelH, foldParams);
      fold.fit(cx, cy);
      const f = fold.frame;
      ren[0] = f[4]; ren[1] = f[5]; ren[2] = f[6]; ren[3] = focal;
      ren[4] = f[2]; ren[5] = f[3];
    } else {
      ren[0] = cx; ren[1] = cy; ren[2] = 1; ren[3] = focal;
      ren[4] = 1 / pixelW; ren[5] = 1 / pixelH;
      fold.releaseChamber();
    }
    ren[6] = MAX_SIZE_CSS * dpr; ren[7] = style;
    const rgb = S.rgb;
    ren[8] = rgb[0] / 255; ren[9] = rgb[1] / 255; ren[10] = rgb[2] / 255; ren[11] = colour;
    ren[12] = gain; ren[13] = hueVar; ren[14] = t / 1000; ren[15] = trail;
    ren[16] = Z_FAR; ren[17] = Z_NEAR; ren[18] = sizeMul; ren[19] = speed;
    // The radial fade: the Fade in amount, and one over the rings' rim in
    // device px, so the shader's k is the rings' k for the same radius. The
    // rim is maxR in both paths, since the chamber keeps the screen's own
    // device-px radius about the field centre.
    ren[20] = fadeIn; ren[21] = 1 / maxR; ren[22] = 0; ren[23] = 0;
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
  // visible list and its count, then (with Kaleidoscope on) the particles
  // into the fold's chamber. Both dispatches share one compute pass; WebGPU
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
    if (active && kaleidoNow && fold.chamberView) {
      const cp = encoder.beginRenderPass(fold.chamberPassDesc);
      cp.setPipeline(chamberPipe);
      cp.setBindGroup(0, renBind);
      cp.drawIndirect(argsBuf, 0);
      cp.end();
    }
  }

  // Inside the scene pass, after the kaleidoscope layer and before the edge.
  function draw(pass) {
    if (!active) return;
    if (kaleidoNow) { fold.draw(pass, foldParams); return; }
    pass.setPipeline(screenPipe);
    pass.setBindGroup(0, renBind);
    pass.drawIndirect(argsBuf, 0);
  }

  const api = { update, encode, draw, resize, setTimestampWrites, computed: false };
  return api;
}
