// The word cloud: the centre word condensing out of smoke and eroding back
// into it (the Cloud choice under Arrive and Leave, core/word-fx.js). One
// system, one material: a density field initialized from the word mask and
// advected through a shared wind before settling back into that same mask
// (the physics and the argument live in word-cloud.wgsl.js). There are no
// particles, no homes and no cage; those went the way they deserved.
//
// The CPU keeps score and nothing more. Once per word a small compute pass
// bakes the word's ink coverage and dissolve noise into a mask texture;
// every frame the simulation runs on a fixed timestep (up to four substeps,
// the remainder banked, so smoke moves at the same speed at 30 or 120 Hz),
// and one draw composites smoke and ink over the scene where the word
// draws. During a cloud transition the crisp glyph path stands aside
// (word-fx zeroes the letters) and this module's composite IS the word;
// at the hold it hands back to the crisp path at full formation, which is
// the same SDF decode at the same position, so there is nothing to pop.
//
// Released smoke outlives the word: the field keeps advecting and thinning
// on a bounded tail after the transition ends, then the layer sleeps. The
// substep uniforms come from a small ring of buffers, because
// queue.writeBuffer lands before the whole frame's dispatches and each
// substep needs its own clock and its own slice of progress.
//
// Nothing is made until a word first clouds, and nothing is allocated per
// frame after that.

import { S } from '../../js/state.js';
import { MASK_WGSL, SIM_WGSL, COMP_WGSL } from './word-cloud.wgsl.js';
import { wordLetters, MAX_CLOUD_LETTERS, fxv } from '../core/word-fx.js';
import { wordState, fadeInMs, fadeOutMs } from '../core/words.js';

const DENS_W = 256, DENS_H = 128;
const MASK_W = 512, MASK_H = 256;
const DT = 1 / 120;
const MAX_STEPS = 4;
const RING = MAX_STEPS;
const UNI_FLOATS = 24;                // six vec4f of U
const LETTER_FLOATS = MAX_CLOUD_LETTERS * 12;
const TAIL_S = 2.5;                   // how long released smoke may outlive the word

export function createWordCloud(device, format, text) {
  let made = false, active = false, wasActive = false;
  let needMask = false, needSeed = false, steps = 0, parity = 0;
  let densA = null, densB = null, maskTex = null;
  let uniBufs = null, compBuf = null, maskBuf = null, seedBuf = null, letterBuf = null;
  let maskPipe = null, seedPipe = null, simPipe = null, compPipe = null;
  let maskBind = null, seedBinds = null, simBinds = null, compBinds = null;
  let dpr = 1, cssW = 1, cssH = 1;
  let simT = 0, acc = 0, lastLiveT = -1e9, lastDir = 0, heldPeak = 0;
  let maskSeed = -1, progPrev = 1, lastPhase = 1;
  let rx = 0, ry = 0, rw = 1, rh = 1;   // the region, css px, held while smoke lives
  const uni = new Float32Array(UNI_FLOATS);

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
    densA = device.createTexture({ label: 'wordcloud.density.a', size: [DENS_W, DENS_H, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    densB = device.createTexture({ label: 'wordcloud.density.b', size: [DENS_W, DENS_H, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    maskTex = device.createTexture({ label: 'wordcloud.mask', size: [MASK_W, MASK_H, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    const dens = [densA.createView(), densB.createView()];
    const maskView = maskTex.createView();
    const atlasView = text.texture.createView();
    const samp = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
    });

    uniBufs = [];
    for (let r = 0; r < RING; r++) {
      uniBufs.push(device.createBuffer({ label: 'wordcloud.uni.' + r, size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    }
    compBuf = device.createBuffer({ label: 'wordcloud.uni.comp', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    maskBuf = device.createBuffer({ label: 'wordcloud.uni.mask', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    seedBuf = device.createBuffer({ label: 'wordcloud.uni.seed', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    letterBuf = device.createBuffer({ label: 'wordcloud.letters', size: LETTER_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const maskMod = device.createShaderModule({ label: 'wordcloud.mask.wgsl', code: MASK_WGSL });
    check(maskMod, 'wordcloud.mask.wgsl');
    const maskBgl = device.createBindGroupLayout({
      label: 'wordcloud.mask.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } }
      ]
    });
    maskPipe = device.createComputePipeline({
      label: 'wordcloud.mask',
      layout: device.createPipelineLayout({ label: 'wordcloud.mask.layout', bindGroupLayouts: [maskBgl] }),
      compute: { module: maskMod, entryPoint: 'maskMain' }
    });
    maskBind = device.createBindGroup({
      label: 'wordcloud.mask.bind', layout: maskBgl,
      entries: [
        { binding: 0, resource: { buffer: maskBuf } },
        { binding: 1, resource: { buffer: letterBuf } },
        { binding: 2, resource: atlasView },
        { binding: 3, resource: samp },
        { binding: 4, resource: maskView }
      ]
    });

    const simMod = device.createShaderModule({ label: 'wordcloud.sim.wgsl', code: SIM_WGSL });
    check(simMod, 'wordcloud.sim.wgsl');
    const simBgl = device.createBindGroupLayout({
      label: 'wordcloud.sim.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } }
      ]
    });
    const simLayout = device.createPipelineLayout({ label: 'wordcloud.sim.layout', bindGroupLayouts: [simBgl] });
    simPipe = device.createComputePipeline({
      label: 'wordcloud.sim', layout: simLayout,
      compute: { module: simMod, entryPoint: 'simMain' }
    });
    seedPipe = device.createComputePipeline({
      label: 'wordcloud.seed', layout: simLayout,
      compute: { module: simMod, entryPoint: 'seedMain' }
    });
    // Seed both ping-pong textures identically. seedMain ignores its read
    // texture, but retaining the shared layout keeps the simulation simple.
    seedBinds = [0, 1].map(p => device.createBindGroup({
      label: 'wordcloud.seed.bind.' + p, layout: simBgl,
      entries: [
        { binding: 0, resource: { buffer: seedBuf } },
        { binding: 1, resource: dens[p] },
        { binding: 2, resource: samp },
        { binding: 3, resource: dens[1 - p] },
        { binding: 4, resource: maskView }
      ]
    }));
    // one bind group per (substep ring slot, read parity): read this parity,
    // write the other
    simBinds = [];
    for (let r = 0; r < RING; r++) {
      simBinds.push([0, 1].map(p => device.createBindGroup({
        label: 'wordcloud.sim.bind.' + r + '.' + p, layout: simBgl,
        entries: [
          { binding: 0, resource: { buffer: uniBufs[r] } },
          { binding: 1, resource: dens[p] },
          { binding: 2, resource: samp },
          { binding: 3, resource: dens[1 - p] },
          { binding: 4, resource: maskView }
        ]
      })));
    }

    const compMod = device.createShaderModule({ label: 'wordcloud.comp.wgsl', code: COMP_WGSL });
    check(compMod, 'wordcloud.comp.wgsl');
    const compBgl = device.createBindGroupLayout({
      label: 'wordcloud.comp.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
      ]
    });
    compPipe = device.createRenderPipeline({
      label: 'wordcloud.comp',
      layout: device.createPipelineLayout({ label: 'wordcloud.comp.layout', bindGroupLayouts: [compBgl] }),
      vertex: { module: compMod, entryPoint: 'vsCloud' },
      fragment: {
        module: compMod, entryPoint: 'fsCloud',
        // premultiplied over, exactly as the word's own glyphs composite
        targets: [{ format, blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
        } }]
      },
      primitive: { topology: 'triangle-list' }
    });
    compBinds = [0, 1].map(p => device.createBindGroup({
      label: 'wordcloud.comp.bind.' + p, layout: compBgl,
      entries: [
        { binding: 0, resource: { buffer: compBuf } },
        { binding: 1, resource: { buffer: letterBuf } },
        { binding: 2, resource: dens[p] },
        { binding: 3, resource: maskView },
        { binding: 4, resource: atlasView },
        { binding: 5, resource: samp }
      ]
    }));
  }

  function resize(pw, ph, d) {
    dpr = d || 1;
    cssW = Math.max(1, pw) / dpr; cssH = Math.max(1, ph) / dpr;
  }

  // invTexW/H differ between the mask bake and the simulation, so the shared
  // texel guard in the shaders sees each texture's own size
  function fillUni(out, invW, invH, dt, t, pEnd, pStart, dir, peak, turb, D, fadeS, ease, size, n, seed) {
    out[0] = rx; out[1] = ry; out[2] = rw; out[3] = rh;
    out[4] = invW; out[5] = invH; out[6] = dt; out[7] = t;
    out[8] = pEnd; out[9] = pStart; out[10] = dir; out[11] = peak;
    out[12] = cssW; out[13] = cssH; out[14] = turb; out[15] = D;
    const c = wordState.color;
    out[16] = c[0]; out[17] = c[1]; out[18] = c[2]; out[19] = fadeS;
    out[20] = ease; out[21] = size; out[22] = n; out[23] = seed;
  }

  function smooth01(x) {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  }

  function update(t, dt) {
    const n = wordLetters.count;
    const phase = wordState.phase;
    const outFx = S.textFxMirror ? S.textFxIn : S.textFxOut;
    const cloudNow = n > 0 && wordState.visible &&
      ((phase === 0 && S.textFxIn === 'cloud') || (phase === 2 && outFx === 'cloud'));
    const dir = cloudNow ? (phase === 2 ? 1 : -1) : 0;
    if (dir !== 0) { lastLiveT = t; lastDir = dir; }

    // Only released departure material gets a tail. Arrival resolves to the
    // mask and hands off immediately to the normal crisp held word.
    active = made ? (dir !== 0 || (lastDir > 0 && (t - lastLiveT) / 1000 < TAIL_S)) : false;
    if (!active && dir === 0) {
      wasActive = false;
      steps = 0;
      return;
    }
    if (!made) make();
    if (!wasActive) { needSeed = true; acc = 0; }
    wasActive = true;
    active = true;

    const size = S.textSize || 35;
    // Arrive and Leave have their own settings; the tail is a departure's.
    const leaving = dir > 0 || (dir === 0 && lastDir > 0);
    const D = Math.max(1, (fxv('textFxDist', leaving) || 1.5) * size);
    const turb = fxv('textFxTurb', leaving);
    // The journey time the guide paces itself against: this phase's own
    // configured fade. The tail keeps the departure's.
    const st = ((dir >= 0 ? fadeOutMs() : fadeInMs()) || 1000) / 1000;
    const ease = fxv('textFxEase', leaving);
    // The tail draws at the opacity the word left with: the hidden word's
    // own peak is 0, and smoke should thin away, not vanish with it.
    if (dir !== 0) heldPeak = wordState.peak;
    const tailAge = dir === 0 ? Math.max(0, (t - lastLiveT) / 1000) : 0;
    const tailFade = dir === 0 ? 1 - smooth01((tailAge - TAIL_S * 0.5) / (TAIL_S * 0.5)) : 1;
    const peak = (dir !== 0 ? wordState.peak : heldPeak) * tailFade;

    // A new word takes a fresh mask and a fresh region, sized to its ink
    // plus room for the smoke to travel; the region then holds still while
    // any of that word's smoke is alive, so the field never teleports.
    if (cloudNow && wordLetters.seed !== maskSeed) {
      maskSeed = wordLetters.seed;
      needMask = true;
      needSeed = true;
      const L = wordLetters.data;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let j = 0; j < n; j++) {
        const o = j * 12;
        x0 = Math.min(x0, L[o] - L[o + 2]); x1 = Math.max(x1, L[o] + L[o + 2]);
        y0 = Math.min(y0, L[o + 1] - L[o + 3]); y1 = Math.max(y1, L[o + 1] + L[o + 3]);
      }
      // Symmetric on every side: the seeds are born on a ring at the
      // Distance setting and the vapour disperses every way equally, so
      // the room is the same all around. Sized for the further of the two
      // journeys, since the region outlives the phase that made it.
      const room = Math.max(D, (fxv('textFxDist', !leaving) || 1.5) * size);
      const mx = room * 1.3 + size * 0.6;
      rx = Math.max(0, x0 - mx); rw = Math.min(cssW, x1 + mx) - rx;
      ry = Math.max(0, y0 - mx);
      rh = Math.min(cssH, y1 + mx) - ry;
      device.queue.writeBuffer(letterBuf, 0, wordLetters.data, 0, n * 12);
      fillUni(uni, 1 / MASK_W, 1 / MASK_H, 0, 0, 0, 0, dir, peak, turb, D, st, ease, size, n, maskSeed % 1000);
      device.queue.writeBuffer(maskBuf, 0, uni);
    }

    // progress this frame, and where it stood last frame; a phase flip
    // restarts the span so no erosion is charged across the boundary
    const prog = cloudNow ? wordState.progress : progPrev;
    const phaseChanged = phase !== lastPhase;
    if (phaseChanged) {
      progPrev = prog;
      if (dir !== 0) needSeed = true;
    }
    lastPhase = phase;

    // Seeding is a phase boundary operation. Arrival starts as a plume
    // grown from the word; departure starts as the exact word itself.
    if (needSeed) {
      fillUni(uni, 1 / DENS_W, 1 / DENS_H, 0, simT, prog, prog, dir, peak, turb, D, st, ease, size, n, maskSeed % 1000);
      device.queue.writeBuffer(seedBuf, 0, uni);
    }

    // fixed-step substeps, remainder banked, burst capped
    if (dt > 0 && dt < 0.25) acc += dt;
    if (acc > MAX_STEPS * DT) acc = MAX_STEPS * DT;
    steps = 0;
    const nSub = Math.floor(acc / DT);
    for (let k = 0; k < nSub && k < MAX_STEPS; k++) {
      acc -= DT;
      const p0 = progPrev + (prog - progPrev) * (k / nSub);
      const p1 = progPrev + (prog - progPrev) * ((k + 1) / nSub);
      fillUni(uni, 1 / DENS_W, 1 / DENS_H, DT, simT, p1, p0, dir, peak, turb, D, st, ease, size, n, maskSeed % 1000);
      device.queue.writeBuffer(uniBufs[steps], 0, uni);
      simT += DT;
      steps++;
    }
    progPrev = prog;

    fillUni(uni, 1 / DENS_W, 1 / DENS_H, 0, simT, prog, prog, dir, peak, turb, D, st, ease, size, n, maskSeed % 1000);
    device.queue.writeBuffer(compBuf, 0, uni);
  }

  // Before the scene pass: bake a changed mask, seed both density textures
  // from it at a phase boundary, then run this frame's substeps. Each write
  // are visible to the next.
  function encode(encoder) {
    if (!active || (!needSeed && !needMask && steps === 0)) return;
    const gw = Math.ceil(DENS_W / 8), gh = Math.ceil(DENS_H / 8);
    const pass = encoder.beginComputePass();
    if (needMask) {
      needMask = false;
      pass.setPipeline(maskPipe);
      pass.setBindGroup(0, maskBind);
      pass.dispatchWorkgroups(Math.ceil(MASK_W / 8), Math.ceil(MASK_H / 8));
    }
    if (needSeed) {
      needSeed = false;
      pass.setPipeline(seedPipe);
      pass.setBindGroup(0, seedBinds[0]);
      pass.dispatchWorkgroups(gw, gh);
      pass.setBindGroup(0, seedBinds[1]);
      pass.dispatchWorkgroups(gw, gh);
      parity = 0;
    }
    if (steps > 0) {
      pass.setPipeline(simPipe);
      for (let s = 0; s < steps; s++) {
        pass.setBindGroup(0, simBinds[s][parity]);
        pass.dispatchWorkgroups(gw, gh);
        parity = 1 - parity;
      }
    }
    pass.end();
  }

  // In the scene pass, where the word draws.
  function draw(pass) {
    if (!active) return;
    pass.setPipeline(compPipe);
    pass.setBindGroup(0, compBinds[parity]);
    pass.draw(6);
  }

  return { update, encode, draw, resize };
}
