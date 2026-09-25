// The frosted-glass source: a dual-Kawase blur, the standard cheap trick for
// a big soft blur that stays fast because almost all of the work happens at
// tiny resolutions. Four downsample passes walk the scene from full res down
// to 1/16, each one averaging a small ring of samples rather than a wide
// gaussian kernel, then two upsample passes walk back up to 1/4 res with a
// wider ring that spreads the blur back out. The result reads as a strong,
// soft frost, closer to macOS vibrancy than a small blur radius would give,
// for a fraction of the cost of blurring at full resolution.
//
// capture() is only ever called on a lit frame (the engine's call, not a
// decision made here); on a dark frame the previous capture simply stays
// bound, which is exactly what keeps a glass panel's brightness steady while
// the scene under it strobes. Every pass reads its own source texture's
// pixel size directly in the shader (via textureDimensions), so there is no
// per-pass uniform to write, and every pass descriptor is built alongside the
// texture it targets, so nothing here allocates once capture() is running
// steadily between resizes. How often capture() runs is the engine's call
// too; it throttles it to a handful of times a second.
//
// Textures in the chain are rgba16float rather than the swap format. Kawase
// blur repeatedly re-samples its own output, and an 8-bit intermediate
// banded visibly under testing-by-inspection of the maths: each pass's
// rounding error becomes the next pass's input, and four downsamples plus
// two upsamples is enough generations for that to show as rings on a smooth
// gradient. Float16 costs little at these resolutions (they top out at a
// quarter of the frame) and it is what the GLASS shader's own dither only
// has to hide the last, tiny bit of.

const BLUR_FORMAT = 'rgba16float';

const FULLSCREEN_WGSL = /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsBlur(@builtin(vertex_index) i: u32) -> VOut {
  var out: VOut;
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;

@fragment
fn fsDown(in: VOut) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(srcTex));
  let half = vec2f(0.5, 0.5) / dim;
  var sum = textureSample(srcTex, srcSamp, in.uv) * 4.0;
  sum += textureSample(srcTex, srcSamp, in.uv - half);
  sum += textureSample(srcTex, srcSamp, in.uv + half);
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(half.x, -half.y));
  sum += textureSample(srcTex, srcSamp, in.uv - vec2f(half.x, -half.y));
  return sum / 8.0;
}

@fragment
fn fsUp(in: VOut) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(srcTex));
  let half = vec2f(0.5, 0.5) / dim;
  var sum = textureSample(srcTex, srcSamp, in.uv + vec2f(-half.x * 2.0, 0.0));
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(-half.x, half.y)) * 2.0;
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(0.0, half.y * 2.0));
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(half.x, half.y)) * 2.0;
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(half.x * 2.0, 0.0));
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(half.x, -half.y)) * 2.0;
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(0.0, -half.y * 2.0));
  sum += textureSample(srcTex, srcSamp, in.uv + vec2f(-half.x, -half.y)) * 2.0;
  return sum / 12.0;
}
`;

export function createBlur(device, format) {
  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });
  const module = device.createShaderModule({ code: FULLSCREEN_WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const downPipeline = device.createRenderPipeline({
    layout, vertex: { module, entryPoint: 'vsBlur' },
    fragment: { module, entryPoint: 'fsDown', targets: [{ format: BLUR_FORMAT }] },
    primitive: { topology: 'triangle-list' },
  });
  const upPipeline = device.createRenderPipeline({
    layout, vertex: { module, entryPoint: 'vsBlur' },
    fragment: { module, entryPoint: 'fsUp', targets: [{ format: BLUR_FORMAT }] },
    primitive: { topology: 'triangle-list' },
  });

  // Six render targets: down1..down4 walk from half res to 1/16, then up3
  // and up2 walk back up to 1/4 (named for the resolution level they land
  // on, not the pass that writes them).
  const levels = { down1: null, down2: null, down3: null, down4: null, up3: null, up2: null };
  const views = {};
  const bindGroups = { down1: null, down2: null, down3: null, down4: null, up3: null, up2: null };
  // The scene->down1 bind group depends on the engine's sceneTex, which is
  // stable between resizes; it is rebuilt only when that texture object
  // (or this chain's own textures, on resize) changes.
  let lastSceneTexture = null;

  let pixelW = 2, pixelH = 2;

  // One render pass descriptor per level, rebuilt with the chain on resize
  // and reused by every capture after, so a capture records six passes
  // without building six descriptor objects to do it.
  const passDescs = { down1: null, down2: null, down3: null, down4: null, up3: null, up2: null };
  function makePassDesc(view) {
    return { colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] };
  }

  // Optional GPU timing (the engine's perf mode): a timestamp at the start of
  // the first pass and the end of the last one brackets the whole chain. The
  // two timestampWrites objects are built once, in setTimestamps. The frame
  // profiler borrows the same two pass slots while it records, handing in
  // its own prebuilt objects (or undefined, on a frame it is not timing)
  // through overrideTimestamps; switching it off puts perf mode's back.
  let tsFirst = undefined, tsLast = undefined;
  let ovOn = false, ovFirst = undefined, ovLast = undefined;
  function applyTimestamps() {
    if (!passDescs.down1) return;
    passDescs.down1.timestampWrites = ovOn ? ovFirst : tsFirst;
    passDescs.up2.timestampWrites = ovOn ? ovLast : tsLast;
  }

  function makeLevel(w, h) {
    const tex = device.createTexture({
      size: [Math.max(1, w), Math.max(1, h)],
      format: BLUR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return tex;
  }

  function makeBindGroup(srcView) {
    return device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: srcView }, { binding: 1, resource: sampler }],
    });
  }

  const api = { view: null };

  function buildChain() {
    for (const key of Object.keys(levels)) {
      if (levels[key]) levels[key].destroy();
    }
    const w2 = Math.max(1, Math.floor(pixelW / 2)), h2 = Math.max(1, Math.floor(pixelH / 2));
    const w4 = Math.max(1, Math.floor(pixelW / 4)), h4 = Math.max(1, Math.floor(pixelH / 4));
    const w8 = Math.max(1, Math.floor(pixelW / 8)), h8 = Math.max(1, Math.floor(pixelH / 8));
    const w16 = Math.max(1, Math.floor(pixelW / 16)), h16 = Math.max(1, Math.floor(pixelH / 16));

    levels.down1 = makeLevel(w2, h2);
    levels.down2 = makeLevel(w4, h4);
    levels.down3 = makeLevel(w8, h8);
    levels.down4 = makeLevel(w16, h16);
    levels.up3 = makeLevel(w8, h8);
    levels.up2 = makeLevel(w4, h4);

    for (const key of Object.keys(levels)) {
      views[key] = levels[key].createView();
      passDescs[key] = makePassDesc(views[key]);
    }
    applyTimestamps();

    // Fixed edges of the chain (down1->down2->down3->down4, down4->up3->up2)
    // can be bound once here; only the scene->down1 edge depends on a
    // texture we do not own and is rebuilt lazily in capture().
    bindGroups.down2 = makeBindGroup(views.down1);
    bindGroups.down3 = makeBindGroup(views.down2);
    bindGroups.down4 = makeBindGroup(views.down3);
    bindGroups.up3 = makeBindGroup(views.down4);
    bindGroups.up2 = makeBindGroup(views.up3);

    lastSceneTexture = null; // force the scene edge to rebuild on next capture
    api.view = views.up2;
  }

  buildChain();

  function resize(pw, ph, dpr) {
    pixelW = pw; pixelH = ph;
    buildChain();
  }

  function runPass(encoder, pipeline, bindGroup, desc) {
    const pass = encoder.beginRenderPass(desc);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  function capture(encoder, sceneTexture) {
    if (sceneTexture !== lastSceneTexture) {
      lastSceneTexture = sceneTexture;
      bindGroups.down1 = makeBindGroup(sceneTexture.createView());
    }
    runPass(encoder, downPipeline, bindGroups.down1, passDescs.down1);
    runPass(encoder, downPipeline, bindGroups.down2, passDescs.down2);
    runPass(encoder, downPipeline, bindGroups.down3, passDescs.down3);
    runPass(encoder, downPipeline, bindGroups.down4, passDescs.down4);
    runPass(encoder, upPipeline, bindGroups.up3, passDescs.up3);
    runPass(encoder, upPipeline, bindGroups.up2, passDescs.up2);
  }

  function setTimestamps(querySet, beginIndex, endIndex) {
    tsFirst = { querySet, beginningOfPassWriteIndex: beginIndex };
    tsLast = { querySet, endOfPassWriteIndex: endIndex };
    applyTimestamps();
  }
  // Two property writes per call, so the profiler can call it every frame.
  function overrideTimestamps(on, first, last) {
    ovOn = on; ovFirst = first; ovLast = last;
    applyTimestamps();
  }

  api.capture = capture;
  api.resize = resize;
  api.setTimestamps = setTimestamps;
  api.overrideTimestamps = overrideTimestamps;
  return api;
}
