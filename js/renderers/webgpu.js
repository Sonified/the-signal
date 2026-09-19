// ---------- WebGPU ----------
import { layers } from '../state.js';
import { cv, $ } from '../dom.js';
import { WGSL } from '../shaders.js';
import { uniArr, lutArr, edgeArr, edgeInst, buildFrameData } from '../framedata.js';

export async function initWebGPU() {
  if (!navigator.gpu) return null;
  let adapter = null, device = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    device = await adapter.requestDevice();
  } catch (e) { return null; }
  if (!device) return null;

  const gctx = cv.getContext('webgpu');
  if (!gctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  // 'opaque' lets the compositor skip the blend with the page behind us.
  gctx.configure({ device, format, alphaMode: 'opaque' });

  const mod = device.createShaderModule({ code: WGSL });
  // WGSL errors are reported asynchronously; surface them here rather than
  // letting the page render a silent blank canvas.
  if (mod.getCompilationInfo) {
    const info = await mod.getCompilationInfo();
    if (info.messages.some(m => m.type === 'error')) {
      console.warn('WGSL compile errors:', info.messages.map(m => m.message).join(' | '));
      return null;
    }
  }

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
    ]
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const uniBuf = device.createBuffer({ size: uniArr.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lutBuf = device.createBuffer({ size: lutArr.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const edgeBuf = device.createBuffer({ size: edgeArr.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

  const bind = device.createBindGroup({
    layout: bgl,
    entries: [{ binding: 0, resource: { buffer: uniBuf } }, { binding: 1, resource: { buffer: lutBuf } }]
  });

  const pipeFull = device.createRenderPipeline({
    layout,
    vertex:   { module: mod, entryPoint: 'vsFull' },
    fragment: { module: mod, entryPoint: 'fsFull', targets: [{ format }] },
    primitive:{ topology: 'triangle-list' }
  });

  const pipeEdge = device.createRenderPipeline({
    layout,
    vertex: {
      module: mod, entryPoint: 'vsEdge',
      buffers: [{
        arrayStride: 24, stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x2' },
          { shaderLocation: 1, offset: 8,  format: 'float32x2' },
          { shaderLocation: 2, offset: 16, format: 'float32x2' }
        ]
      }]
    },
    fragment: {
      module: mod, entryPoint: 'fsEdge',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
        }
      }]
    },
    primitive: { topology: 'triangle-list' }
  });

  let lost = false;
  device.lost.then(info => {
    lost = true;
    console.warn('WebGPU device lost:', info && info.message);
    $('rendName').textContent = 'WebGPU (device lost)';
  });

  const clearVal = { r: 0, g: 0, b: 0, a: 1 };

  return {
    name: 'WebGPU',
    resize() { /* the swap chain follows cv.width/height automatically */ },
    draw(lum) {
      if (lost) return;
      buildFrameData(lum);
      const q = device.queue;
      q.writeBuffer(uniBuf, 0, uniArr);
      if (layers.rings) q.writeBuffer(lutBuf, 0, lutArr);
      if (edgeInst) q.writeBuffer(edgeBuf, 0, edgeArr, 0, edgeInst * 6);

      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: gctx.getCurrentTexture().createView(),
          clearValue: clearVal, loadOp: 'clear', storeOp: 'store'
        }]
      });
      pass.setBindGroup(0, bind);
      pass.setPipeline(pipeFull);
      pass.draw(3);
      if (edgeInst) {
        pass.setPipeline(pipeEdge);
        pass.setVertexBuffer(0, edgeBuf);
        pass.draw(6, edgeInst);
      }
      pass.end();
      q.submit([enc.finish()]);
    }
  };
}
