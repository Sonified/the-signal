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
// current capacity (see SceneData.ensureCapacity); the uniform and ring
// lookup buffers are fixed size and never touched again after creation.

import { SCENE_WGSL } from './scene.wgsl.js';
import { SceneData, LUT_N, UNIFORM_FLOATS } from './scene-data.js';

const TAIL_STRIDE = 32;   // 8 floats: xy, across, alpha, rgb, pad
const CAP_STRIDE = 48;    // 12 floats: cxy, radius, alpha, rgb, cutXY, pad pad

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
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
    ]
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const uniBuf = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lutBuf = device.createBuffer({ size: LUT_N * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({
    layout: bgl,
    entries: [{ binding: 0, resource: { buffer: uniBuf } }, { binding: 1, resource: { buffer: lutBuf } }]
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

  const pipeTail = device.createRenderPipeline({
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
    fragment: { module: mod, entryPoint: 'fsTail', targets: [{ format, blend: additive }] },
    primitive: { topology: 'triangle-list' }
  });

  const pipeCap = device.createRenderPipeline({
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
    fragment: { module: mod, entryPoint: 'fsCap', targets: [{ format, blend: additive }] },
    primitive: { topology: 'triangle-list' }
  });

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

  function update(lum) {
    data.build(lum, pixelW, pixelH, dpr);
    if (data.grew) {
      tailBuf.destroy();
      capBuf.destroy();
      tailBuf = device.createBuffer({ size: data.tailVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      capBuf = device.createBuffer({ size: data.capInsts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    const q = device.queue;
    q.writeBuffer(uniBuf, 0, data.uniform);
    if (data.ringsAny) q.writeBuffer(lutBuf, 0, data.lut);
    if (data.tailVertCount) q.writeBuffer(tailBuf, 0, data.tailVerts, 0, data.tailVertCount * 8);
    if (data.capInstCount) q.writeBuffer(capBuf, 0, data.capInsts, 0, data.capInstCount * 12);
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
    // Set again because whatever drew in between will have bound its own.
    if (!data.tailVertCount && !data.capInstCount) return;
    pass.setBindGroup(0, bind);
    if (data.tailVertCount) {
      pass.setPipeline(pipeTail);
      pass.setVertexBuffer(0, tailBuf);
      pass.draw(data.tailVertCount);
    }
    if (data.capInstCount) {
      pass.setPipeline(pipeCap);
      pass.setVertexBuffer(0, capBuf);
      pass.draw(6, data.capInstCount);
    }
  }

  function draw(pass) {
    drawBack(pass);
    drawFront(pass);
  }

  return { update, draw, drawBack, drawFront, resize };
}
