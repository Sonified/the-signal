// The energy profile's two GPU readings (core/energy.js keeps them, the
// Render drawer's Copy energy profile prints them). Both run only once
// main.js has handed the engine a sink, and both are light enough to leave
// running for a whole session:
//
//   gpu done   every GPU_EVERY frames, the time from a frame's submit to the
//              queue saying its work is done: the GPU's time on that frame
//              plus whatever was queued ahead of it. A stand-in for pass
//              timestamps, which a phone's browser may not offer.
//   light      every LIGHT_EVERY_MS, the picture under the controls (the
//              scene texture, so that frame takes the blit route) squeezed
//              to a LIGHT_W-wide thumbnail, read back and averaged: the mean
//              linear level of the red, green and blue subpixels, 1 = full
//              white everywhere. An OLED screen's power follows its lit
//              subpixels, so this is the web's nearest view of what the
//              screen spends. Tagged lit or dark, so the strobe's two halves
//              can be told apart.
//
// Nothing waits on either readback: a sample whose last one has not come
// back simply skips its turn.

const GPU_EVERY = 30;          // frames between gpu done samples
const LIGHT_EVERY_MS = 2000;   // between light samples
const LIGHT_W = 64;            // thumbnail width; 64 x 4 bytes is one 256-byte row
const LIGHT_FORMAT = 'rgba8unorm';

const LIGHT_WGSL = /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsLight(@builtin(vertex_index) i: u32) -> VOut {
  var out: VOut;
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;

fn lin(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }

// Four filtered taps spread over this thumbnail texel's cell of the frame,
// each made linear before they are averaged.
@fragment
fn fsLight(in: VOut) -> @location(0) vec4f {
  let q = fwidth(in.uv) * 0.25;
  var c = lin(textureSampleLevel(srcTex, srcSamp, in.uv + vec2f(-q.x, -q.y), 0.0).rgb);
  c += lin(textureSampleLevel(srcTex, srcSamp, in.uv + vec2f( q.x, -q.y), 0.0).rgb);
  c += lin(textureSampleLevel(srcTex, srcSamp, in.uv + vec2f(-q.x,  q.y), 0.0).rgb);
  c += lin(textureSampleLevel(srcTex, srcSamp, in.uv + vec2f( q.x,  q.y), 0.0).rgb);
  return vec4f(c * 0.25, 1.0);
}
`;

// sinkOf() returns main.js's sink ({ gpuDone(ms), light(level, lit) }) or
// null; with none, the probe does nothing at all.
export function createEnergyProbe(device, now, sinkOf) {
  const module = device.createShaderModule({ code: LIGHT_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vsLight' },
    fragment: { module, entryPoint: 'fsLight', targets: [{ format: LIGHT_FORMAT }] },
    primitive: { topology: 'triangle-list' }
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  let tex = null, view = null, readBuf = null, bind = null, h = 1;
  const passDesc = {
    colorAttachments: [{ view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }]
  };

  // The thumbnail keeps the frame's shape: LIGHT_W across, as many rows as
  // that makes (at most 256), remade with the scene texture.
  function resize(pw, ph, sceneView) {
    h = Math.max(1, Math.min(256, Math.round(LIGHT_W * ph / Math.max(1, pw))));
    if (tex) tex.destroy();
    if (readBuf && !lightPending) readBuf.destroy();
    tex = device.createTexture({
      size: { width: LIGHT_W, height: h }, format: LIGHT_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    view = tex.createView();
    passDesc.colorAttachments[0].view = view;
    readBuf = device.createBuffer({ size: 256 * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sceneView }, { binding: 1, resource: sampler }]
    });
  }

  // ---- light ----
  let lastLightT = -Infinity, lightPending = false, lightEncoded = false, lightLit = false;
  let mapBuf = null, mapH = 1;
  function lightDue(t) {
    return !!sinkOf() && !!bind && !lightPending && t - lastLightT >= LIGHT_EVERY_MS;
  }
  // After the scene pass, while sceneTex holds the picture.
  function encodeLight(encoder, lit) {
    const pass = encoder.beginRenderPass(passDesc);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: tex }, { buffer: readBuf, bytesPerRow: 256, rowsPerImage: h }, { width: LIGHT_W, height: h });
    lightEncoded = true; lightLit = lit;
  }
  function onLightMapped() {
    const b = mapBuf, rows = mapH, lit = lightLit;
    const px = new Uint8Array(b.getMappedRange());
    let sum = 0;
    for (let y = 0; y < rows; y++) {
      const o = y * 256;
      for (let x = 0; x < LIGHT_W * 4; x += 4) sum += px[o + x] + px[o + x + 1] + px[o + x + 2];
    }
    b.unmap();
    // a buffer a resize replaced while this map was out
    if (b !== readBuf) b.destroy();
    lightPending = false;
    const sink = sinkOf();
    if (sink) sink.light(sum / (rows * LIGHT_W * 3 * 255), lit);
  }
  function onLightFailed() {
    if (mapBuf !== readBuf) { try { mapBuf.destroy(); } catch (e) {} }
    lightPending = false;
  }

  // ---- gpu done ----
  let gpuFrames = 0, gpuPending = false, gpuT0 = 0;
  function onGpuDone() {
    gpuPending = false;
    const sink = sinkOf();
    if (sink) sink.gpuDone(now() - gpuT0);
  }
  function onGpuFailed() { gpuPending = false; }

  // Straight after the frame's submit.
  function afterSubmit(t) {
    if (lightEncoded) {
      lightEncoded = false;
      lastLightT = t;
      lightPending = true;
      mapBuf = readBuf; mapH = h;
      readBuf.mapAsync(GPUMapMode.READ).then(onLightMapped, onLightFailed);
    }
    if (!sinkOf() || gpuPending || ++gpuFrames < GPU_EVERY) return;
    gpuFrames = 0;
    gpuPending = true;
    gpuT0 = now();
    device.queue.onSubmittedWorkDone().then(onGpuDone, onGpuFailed);
  }

  return { resize, lightDue, encodeLight, afterSubmit };
}
