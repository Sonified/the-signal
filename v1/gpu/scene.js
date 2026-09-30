// Owns the strobe scene: field, rings, corners and edge particles, drawn
// straight into the engine's already-open scene pass. See ARCHITECTURE.md's
// Scene section for the contract. update(lum) writes this frame's GPU
// buffers before the pass begins; draw(pass) only records draw calls.
//
// The field/ring/corner maths is js/framedata.js and js/shaders.js ported
// into scene-data.js and scene.wgsl.js, widened so rings and corners can
// carry their own colour when S.perElementColor is on (see those files for
// why). The edge layer is a rewrite: v0's WebGPU path drew one rounded
// capsule per trail segment, which reads as a string of beads rather than a
// tail; here each particle is one tapered polygon plus a head cap that is
// clipped so it never overlaps the polygon under additive blending. See
// scene-data.js's buildEdge and this file's cap pipeline for the two halves
// of that fix.
//
// GPU resources are created once. Only the edge layer's vertex buffers ever
// grow, and only on the rare frame the live particle count outruns the
// current capacity (see SceneData.ensureCapacity); the uniform, ring record
// and ring bin index buffers are fixed size and never recreated. The records
// have room for MAX_RINGS rings and the index for its worst case, every ring
// listed in every radial bin (scene-data.js's RING_BINS), and each frame
// uploads only the live part of each.
//
// The edge can leave trails through video feedback (feedback.js), which
// softens it into streaks of light. With Edge > Feedback > Amount above 0,
// encode() draws the tails and caps into the feedback image instead of the
// scene pass, over a faded (and streamed, twisted) copy of the last frame's,
// and drawFront lays that image over the scene. At 0 the edge draws straight
// into the scene pass exactly as before and the image is let go. The edge is
// light, so into the image it adds its colour and leaves alpha at 0, and the
// composite's premultiplied "over" then adds it to the scene, just as the
// direct draw does. The centre the trails stream and turn about is the
// visible field's, and its scale the field's focal length, so a drawer slide
// carries and rescales them with the field (feedback.js).
//
// Feedback > Opacity thins the trails, never the live edge. The image holds
// this frame's edge at full strength plus the faded history, and is laid
// over at opacity o; the same frame's edge is also drawn straight into the
// scene pass at 1 - o. All of it is light and adds, so the live edge sums to
// o + (1 - o) = 1 and only the history scales with o. That direct draw uses
// the same buffers and uniforms as the draw into the image (the crossfade
// shares, the shimmer), with its strength as the pass's blend constant: its
// pipelines multiply the edge's colour by that constant as it blends, so no
// shader or uniform changes. At o = 1 the direct draw is skipped and the
// frame is exactly the composite alone, as before; near 0 the composite is
// skipped (feedback.js) and the direct draw goes at full, the plain edge,
// while the image keeps building behind it.
//
// The edge has four effects (S.edgeMode): Surfing, the tails above, and
// Particles, Flame and Glow (edge-fx.js). Whichever show this frame draw
// into the same place, the scene pass or the feedback image, so trails work
// for all of them. A change of effect crossfades: each effect keeps a share
// of the edge, the new one's rising to 1 while the others fall in
// proportion, so the shares always sum to 1, and every effect with a share
// is drawn live at it. All four are light, so the weighted sum is a true
// crossfade. A change made inside a transition (a preset's glide, a journey
// step's ramp) fades over what is left of that transition's window
// (presets.js transitionRemaining), so a ramp of 0 is all but a cut; a plain
// click in the drawer fades over CLICK_FADE_S, which can only soften it.
// This lives here, beside the drawing, so it runs wherever the engine does,
// worker or page.

import { S, Z_NEAR, MAX_RINGS } from '../../js/state.js';
import { SCENE_WGSL } from './scene.wgsl.js';
import { SceneData, LUT_N, UNIFORM_FLOATS, RING_FLOATS, RING_BIN_WORDS } from './scene-data.js';
import { createFeedback } from './feedback.js';
import { createEdgeFx } from './edge-fx.js';
import { motionStep } from '../core/motion.js';
import { presetTransitionCount, transitionRemaining } from '../core/presets.js';

const TAIL_STRIDE = 32;   // 8 floats: xy, across, alpha, rgb, pad
const CAP_STRIDE = 48;    // 12 floats: cxy, radius, alpha, rgb, cutXY, pad pad
// Edge feedback, as the Confetti layer's: the trails' half-life at Amount
// 100%, seconds, through the slider's square (HL_MAX * s * s), so the low end
// gets most of the travel; Stream's scale change per second at 1 either way
// (the image grows or shrinks by exp(STREAM_MAX * stream) a second); Twist's
// turn at full, radians a second, positive clockwise.
const HL_MAX = 4.0;
const STREAM_MAX = 0.5;
const TWIST_MAX = 0.8;
// The edge's effects, in S.edgeMode's words, and their slots in the shares
// below. A change with no transition open fades over CLICK_FADE_S seconds.
const EDGE_MODES = ['surfing', 'particles', 'flame', 'glow'];
const CLICK_FADE_S = 0.35;

export function createScene(device, format) {
  const data = new SceneData();

  const mod = device.createShaderModule({ code: SCENE_WGSL });
  // Compilation errors surface asynchronously; createScene itself cannot be
  // async (the engine calls it synchronously as part of registerScene), so
  // this just warns once rather than blocking on it.
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn('scene.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      // TEMPORARY A/B: the old ring lookup (S.ringDraw, the Render section's Ring draw).
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      // The ring records' radial bin index.
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
    ]
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const uniBuf = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const ringBuf = device.createBuffer({ size: MAX_RINGS * RING_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const binBuf = device.createBuffer({ size: RING_BIN_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const lutBuf = device.createBuffer({ size: LUT_N * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });   // temporary A/B
  const bind = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: uniBuf } },
      { binding: 1, resource: { buffer: ringBuf } },
      { binding: 2, resource: { buffer: lutBuf } },
      { binding: 3, resource: { buffer: binBuf } }
    ]
  });

  const pipeFull = device.createRenderPipeline({
    layout,
    vertex: { module: mod, entryPoint: 'vsFull' },
    fragment: { module: mod, entryPoint: 'fsFull', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });

  const additive = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
  };

  // The edge's two pipelines for a target format and blend: on screen, and
  // into the feedback image.
  const tailFor = (fmt, blend) => device.createRenderPipeline({
    layout,
    vertex: {
      module: mod, entryPoint: 'vsTail',
      buffers: [{
        arrayStride: TAIL_STRIDE, stepMode: 'vertex',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' }
        ]
      }]
    },
    fragment: { module: mod, entryPoint: 'fsTail', targets: [{ format: fmt, blend }] },
    primitive: { topology: 'triangle-list' }
  });

  const capFor = (fmt, blend) => device.createRenderPipeline({
    layout,
    vertex: {
      module: mod, entryPoint: 'vsCap',
      buffers: [{
        arrayStride: CAP_STRIDE, stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
          { shaderLocation: 2, offset: 32, format: 'float32' }
        ]
      }]
    },
    fragment: { module: mod, entryPoint: 'fsCap', targets: [{ format: fmt, blend }] },
    primitive: { topology: 'triangle-list' }
  });

  const pipeTail = tailFor(format, additive);
  const pipeCap = capFor(format, additive);
  // The same, with the colour scaled by the pass's blend constant: the live
  // edge drawn straight into the scene beside its feedback image, at the
  // strength the image's Opacity leaves it (see the top of this file).
  const scaled = {
    color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
  };
  const pipeTailLive = tailFor(format, scaled);
  const pipeCapLive = capFor(format, scaled);
  // The blend constant for that draw, reused so a frame allocates nothing.
  const liveK = { r: 1, g: 1, b: 1, a: 1 };

  // The edge's feedback image and its pipelines. Into the image the edge
  // adds its light and leaves alpha as it is (0, from the clear and the
  // fade), so the composite adds it to the scene rather than laying it
  // over as cover.
  const fb = createFeedback(device, format, { label: 'edge.fb' });
  const light = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
  };
  const pipeTailFb = tailFor(fb.format, light);
  const pipeCapFb = capFor(fb.format, light);
  const fbParams = { keepHalfLife: 0, zoomRate: 0, twistRate: 0, cx: 0, cy: 0, unit: 1, dt: 0 };
  // Whether this frame's edge goes through the feedback image, and how
  // opaque that image lands on the scene (Feedback > Opacity).
  let fbOn = false, fbOpacity = 1;

  // The other three effects, and the crossfade between all four: each
  // effect's share now, and at the last change the shares of the effects
  // being left, as proportions of what they had together, so they fall away
  // together as the new one rises. fadeFrom is the new effect's share at the
  // change (not 0 when it is coming back mid-fade), fadeT how far into the
  // fade, fadeDur how long it runs. mode is the effect being faded to, -1
  // until the first frame takes S's as it stands.
  const fx = createEdgeFx(device, format, fb.format);
  const share = new Float32Array(4), leaving = new Float32Array(4);
  let mode = -1, fadeFrom = 1, fadeT = 0, fadeDur = 0, seenTransitions = 0;
  // Whether this frame's other effects have anything to draw.
  let fxOn = false;

  let tailBuf = device.createBuffer({ size: data.tailVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  let capBuf = device.createBuffer({ size: data.capInsts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

  // Set by resize() before the first update(); starting at 1x1 keeps the
  // uniform maths finite even if a frame somehow ran before that happened.
  let pixelW = 1, pixelH = 1, dpr = 1;

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
    dpr = d || 1;
  }

  // Steps the crossfade on the frame's own time, not the motion's: it is a
  // change of setting, like a preset's glide, so it runs out while stopped
  // too (with feedback on the held image shows it at the resume).
  function stepShares(dt) {
    const want = Math.max(0, EDGE_MODES.indexOf(S.edgeMode));
    const tc = presetTransitionCount();
    if (mode < 0) {
      mode = want; share[want] = 1;
    } else if (want !== mode) {
      // Made inside a transition since last frame: its window's remainder.
      // Otherwise a click, and the short fade.
      fadeDur = tc !== seenTransitions ? transitionRemaining() : CLICK_FADE_S;
      fadeT = 0;
      fadeFrom = share[want];
      let rest = 0;
      for (let i = 0; i < 4; i++) if (i !== want) rest += share[i];
      for (let i = 0; i < 4; i++) leaving[i] = i !== want && rest > 0 ? share[i] / rest : 0;
      mode = want;
    }
    seenTransitions = tc;
    if (share[mode] >= 1) return;
    fadeT += dt > 0 ? dt : 0;
    const f = fadeDur > 0 ? Math.min(1, fadeT / fadeDur) : 1;
    const k = f * f * (3 - 2 * f);
    const s = f >= 1 ? 1 : fadeFrom + (1 - fadeFrom) * k;
    for (let i = 0; i < 4; i++) share[i] = i === mode ? s : leaving[i] * (1 - s);
  }

  // t is the frame's rAF ms, which the edge effects' breathing reads the
  // broadcast room's clock by (core/room-clock.js).
  function update(lum, dt, t) {
    stepShares(dt);
    data.build(lum, pixelW, pixelH, dpr, share[0]);
    fxOn = fx.update(dt, share[1], share[2], share[3], pixelW, pixelH, dpr, t);
    if (data.grew) {
      tailBuf.destroy();
      capBuf.destroy();
      tailBuf = device.createBuffer({ size: data.tailVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      capBuf = device.createBuffer({ size: data.capInsts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    const q = device.queue;
    q.writeBuffer(uniBuf, 0, data.uniform);
    if (data.ringsAny) {
      if (data.ringsLut) q.writeBuffer(lutBuf, 0, data.lut);   // temporary A/B
      else {
        q.writeBuffer(ringBuf, 0, data.rings, 0, data.ringCount * RING_FLOATS);
        q.writeBuffer(binBuf, 0, data.ringBins, 0, data.ringBinsLen);
      }
    }
    if (data.tailVertCount) q.writeBuffer(tailBuf, 0, data.tailVerts, 0, data.tailVertCount * 8);
    if (data.capInstCount) q.writeBuffer(capBuf, 0, data.capInsts, 0, data.capInstCount * 12);

    // This frame's edge feedback. The step is the motion's, so the trails
    // fade with the edge as it coasts to a stop on pause and hold once it
    // has stopped (feedback.js holds). Off, or the edge layer off, the image
    // is let go and the next use starts clear. The centre and focal length
    // are the visible field's, as js/geometry.js and the Confetti layer
    // frame it: the drawer covers the left.
    const amt = S.edgeFb > 0 ? Math.min(1, S.edgeFb) : 0;
    fbOn = amt > 0 && !!S.layers.edge;
    if (!fbOn) { fb.release(); return; }
    fbOpacity = typeof S.edgeFbOpacity === 'number' ? Math.max(0, Math.min(1, S.edgeFbOpacity)) : 1;
    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    const visW = Math.max(1, cssW - inset);
    const stream = typeof S.edgeFbStream === 'number' ? Math.max(-2, Math.min(2, S.edgeFbStream)) : 0;
    const twist = typeof S.edgeFbTwist === 'number' ? Math.max(-1, Math.min(1, S.edgeFbTwist)) : 0;
    fbParams.keepHalfLife = HL_MAX * amt * amt;
    fbParams.zoomRate = STREAM_MAX * stream;
    fbParams.twistRate = TWIST_MAX * twist;
    fbParams.cx = (inset + visW * 0.5) * dpr;
    fbParams.cy = cssH * 0.5 * dpr;
    fbParams.unit = Math.hypot(visW, cssH) * 0.62 * dpr * Z_NEAR;
    fbParams.dt = dt > 0 ? motionStep(dt) : 0;
    fb.ensure(pixelW, pixelH);
  }

  // The edge's tails then caps, into whichever pass, with the pipelines
  // for its target; then whichever other effects are showing.
  function drawEdge(pass, tailPipe, capPipe, intoFb, live) {
    pass.setBindGroup(0, bind);
    if (data.tailVertCount) {
      pass.setPipeline(tailPipe);
      pass.setVertexBuffer(0, tailBuf);
      pass.draw(data.tailVertCount);
    }
    if (data.capInstCount) {
      pass.setPipeline(capPipe);
      pass.setVertexBuffer(0, capBuf);
      pass.draw(6, data.capInstCount);
    }
    if (fxOn) fx.draw(pass, intoFb, live);
  }

  // Encoded by the engine before the scene pass: with edge feedback on, this
  // frame's image, the faded last one with the edge added over it. Held
  // (stopped with trails), nothing is encoded and the image stays. So too
  // once the image has faded to exactly nothing while the edge has nothing
  // to add (feedback.js begin), and drawFront's composite skips it then.
  function encode(encoder) {
    if (!fbOn) return;
    const drawing = data.tailVertCount > 0 || data.capInstCount > 0 || fxOn;
    const p = fb.begin(encoder, fbParams, drawing);
    if (!p) return;
    if (drawing) drawEdge(p, pipeTailFb, pipeCapFb, true);
    fb.end(p);
  }

  // The scene draws in two halves so a layer can sit between them: the
  // flower layer goes over the field and rings but under the edge. draw()
  // is still both halves back to back for anything that wants the whole.
  // With field, rings and corners all contributing nothing, the full-screen
  // pass would write opaque black over the pass's opaque black clear, so it
  // is skipped: the same pixels without a whole screen of fragment work.
  function drawBack(pass) {
    if (!data.fullActive) return;
    pass.setBindGroup(0, bind);
    pass.setPipeline(pipeFull);
    pass.draw(3);
  }

  function drawFront(pass) {
    // With feedback the edge is already in its image; lay that over, at
    // Opacity, and the live edge straight in at what that leaves (see the
    // top of this file). The composite skips itself at 0.002 and below, so
    // there the live edge goes at full.
    if (fbOn) {
      fb.composite(pass, 1, fbOpacity);
      const k = fbOpacity <= 0.002 ? 1 : 1 - fbOpacity;
      if (k > 0.002 && (data.tailVertCount || data.capInstCount || fxOn)) {
        liveK.r = k; liveK.g = k; liveK.b = k; liveK.a = k;
        pass.setBlendConstant(liveK);
        drawEdge(pass, pipeTailLive, pipeCapLive, false, true);
      }
      return;
    }
    // Set again (in drawEdge) because whatever drew in between will have
    // bound its own.
    if (!data.tailVertCount && !data.capInstCount && !fxOn) return;
    drawEdge(pass, pipeTail, pipeCap, false);
  }

  function draw(pass) {
    drawBack(pass);
    drawFront(pass);
  }

  return { update, encode, draw, drawBack, drawFront, resize };
}
