// Draws a DrawList (see v1/ui/drawlist.js) with one pipeline, one instanced
// draw call per clip batch. This module owns nothing about layout or when to
// draw; it is handed a finished array of instances and a list of batches
// and turns them into pixels, exactly once per call.
//
// draw() can be called twice in the same frame (the overlay list inside the
// scene pass, then the ui list in the final pass), and both calls are
// recorded into the same command encoder before one queue.submit. Because
// queue.writeBuffer effects land before the submitted commands run rather
// than at the moment each writeBuffer is called, two calls writing the same
// GPU memory would both be visible only by the time the GPU actually reads
// them, so the second write silently clobbers the first for every pass in
// that submit, not just its own. So each draw() claims the next slot in a
// small ring for its instance data and writes and binds only that slot, and
// the small uniforms, which differ between calls only by hasBlur, keep one
// slot per hasBlur value (see uniformLast), so two calls never share memory
// that must hold different bytes for each.

import { UI_WGSL } from './ui.wgsl.js';
import { STRIDE } from '../ui/drawlist.js';

const RING_SIZE = 4;           // more than the two calls/frame the frame graph makes, for headroom
const UNIFORM_FLOATS = 4;      // viewport.xy, dpr, hasBlur

export function createUIRenderer(device, format, text) {
  const uniformAlign = (device.limits && device.limits.minUniformBufferOffsetAlignment) || 256;
  const uniformSlotBytes = uniformAlign;
  const uniformBuffer = device.createBuffer({
    size: uniformSlotBytes * RING_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // One small scratch array reused for every uniform write; never allocated
  // per frame, just refilled.
  const uniformScratch = new Float32Array(UNIFORM_FLOATS);
  // The uniforms are a function of hasBlur alone within a frame (viewport
  // and dpr only change on a resize, between frames), so they need not ride
  // the ring: slot 0 holds the unblurred set and slot 1 the blurred one, and
  // two calls sharing a slot in one submit want the very same bytes there.
  // Each slot is rewritten only when its values change, which is a resize,
  // so a normal frame makes no uniform write at all. NaN never compares
  // equal, so both are written the first time they are used.
  const uniformLast = new Float32Array(UNIFORM_FLOATS * 2).fill(NaN);

  let instanceCapacity = 2048; // instances per ring slot
  let instanceBuffer = null;
  let instanceSlotBytes = 0;
  const makeInstanceBuffer = () => {
    instanceSlotBytes = instanceCapacity * STRIDE * 4;
    // Deliberately not destroyed: growth can happen on the second draw()
    // call of a frame, after the first call has already recorded a pass
    // that references the old buffer but has not been submitted yet.
    // Explicitly destroying it here would invalidate that pending pass.
    // Dropping the reference lets the GPU keep it alive until the pending
    // work is done, then the usual GC reclaims it.
    instanceBuffer = device.createBuffer({
      size: instanceSlotBytes * RING_SIZE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  };
  makeInstanceBuffer();

  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });

  // A 1x1 stand-in for the blur view on frames with no capture yet. hasBlur
  // stays 0 whenever it is bound, so its actual pixel never shows; it only
  // exists to satisfy the bind group layout.
  const dummyBlurTexture = device.createTexture({
    size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: dummyBlurTexture }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, { width: 1, height: 1 });
  const dummyBlurView = dummyBlurTexture.createView();

  const module = device.createShaderModule({ code: UI_WGSL });

  const uniformsBGL = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: UNIFORM_FLOATS * 4 } }],
  });
  const blurBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const textBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [uniformsBGL, blurBGL, textBGL] });

  // One uniform bind group per ring slot, pointing at a fixed offset in the
  // same buffer, so draw() never has to build a bind group in the frame loop.
  const uniformBindGroups = [];
  for (let i = 0; i < RING_SIZE; i++) {
    uniformBindGroups.push(device.createBindGroup({
      layout: uniformsBGL,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer, offset: i * uniformSlotBytes, size: UNIFORM_FLOATS * 4 } }],
    }));
  }

  const textBindGroup = device.createBindGroup({
    layout: textBGL,
    entries: [
      { binding: 0, resource: text.texture.createView() },
      { binding: 1, resource: text.sampler },
    ],
  });

  // Two blur bind groups are kept side by side: one on the 1x1 stand-in, for
  // the overlay list drawn inside the scene pass with no blur, and one on the
  // live capture view, for the UI lists. A single cached group keyed on the
  // last view flipped between the two on every frame the overlay was up,
  // building two bind groups a frame for the collector to sweep. The live
  // one is rebuilt only when the capture's view object itself changes, which
  // is a resize.
  const dummyBindGroup = device.createBindGroup({
    layout: blurBGL,
    entries: [{ binding: 0, resource: dummyBlurView }, { binding: 1, resource: sampler }],
  });
  let liveBlurView = null, liveBindGroup = null;

  const vertexBufferLayout = {
    arrayStride: STRIDE * 4,
    stepMode: 'instance',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' },
      { shaderLocation: 1, offset: 16, format: 'float32x4' },
      { shaderLocation: 2, offset: 32, format: 'float32x4' },
      { shaderLocation: 3, offset: 48, format: 'float32x4' },
      { shaderLocation: 4, offset: 64, format: 'float32x4' },
      { shaderLocation: 5, offset: 80, format: 'float32x4' },
    ],
  };

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vsMain', buffers: [vertexBufferLayout] },
    fragment: {
      module, entryPoint: 'fsMain',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });

  let viewportW = 1, viewportH = 1, dpr = 1;
  let pixelW = 1, pixelH = 1;
  let ringIndex = 0;

  function resize(pw, ph, d) {
    pixelW = pw; pixelH = ph; dpr = d;
    viewportW = pw / d; viewportH = ph / d;
  }

  function draw(pass, drawList, blurView) {
    const count = drawList.count;
    if (count > instanceCapacity) {
      while (instanceCapacity < count) instanceCapacity *= 2;
      makeInstanceBuffer();
    }

    const slot = ringIndex % RING_SIZE;
    ringIndex++;

    // Instance data for this call only, at this slot's byte offset.
    const byteOffset = slot * instanceSlotBytes;
    device.queue.writeBuffer(instanceBuffer, byteOffset, drawList.data.buffer, drawList.data.byteOffset, count * STRIDE * 4);

    // Uniforms: the slot for this call's hasBlur (see uniformLast above).
    const hasBlur = blurView ? 1 : 0;
    uniformScratch[0] = viewportW;
    uniformScratch[1] = viewportH;
    uniformScratch[2] = dpr;
    uniformScratch[3] = hasBlur;
    const u = hasBlur * UNIFORM_FLOATS;
    if (uniformLast[u] !== uniformScratch[0] || uniformLast[u + 1] !== uniformScratch[1] ||
        uniformLast[u + 2] !== uniformScratch[2] || uniformLast[u + 3] !== uniformScratch[3]) {
      uniformLast[u] = uniformScratch[0]; uniformLast[u + 1] = uniformScratch[1];
      uniformLast[u + 2] = uniformScratch[2]; uniformLast[u + 3] = uniformScratch[3];
      device.queue.writeBuffer(uniformBuffer, hasBlur * uniformSlotBytes, uniformScratch.buffer, uniformScratch.byteOffset, UNIFORM_FLOATS * 4);
    }

    let blurBindGroup = dummyBindGroup;
    if (blurView) {
      if (blurView !== liveBlurView) {
        liveBlurView = blurView;
        liveBindGroup = device.createBindGroup({
          layout: blurBGL,
          entries: [{ binding: 0, resource: blurView }, { binding: 1, resource: sampler }],
        });
      }
      blurBindGroup = liveBindGroup;
    }

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, uniformBindGroups[hasBlur]);
    pass.setBindGroup(1, blurBindGroup);
    pass.setBindGroup(2, textBindGroup);
    pass.setVertexBuffer(0, instanceBuffer, byteOffset, count * STRIDE * 4);

    for (let i = 0; i < drawList.batchCount; i++) {
      const b = drawList.batches[i];
      if (b.count === 0) continue;
      const x0 = Math.max(0, Math.floor(b.x * dpr));
      const y0 = Math.max(0, Math.floor(b.y * dpr));
      const x1 = Math.min(pixelW, Math.ceil((b.x + b.w) * dpr));
      const y1 = Math.min(pixelH, Math.ceil((b.y + b.h) * dpr));
      const sw = x1 - x0, sh = y1 - y0;
      if (sw <= 0 || sh <= 0) continue;
      pass.setScissorRect(x0, y0, sw, sh);
      pass.draw(6, b.count, 0, b.first);
    }
  }

  return { draw, resize };
}
