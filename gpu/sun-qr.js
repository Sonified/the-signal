// The show's QR code (core/schema-sun.js, sunQrOn and sunQrSize): the TSC
// 2026 QR PNG drawn over the whole frame while the switch is on.
//
// FADE: the switch never pops. Its drawn opacity eases (smoothstep) from
// wherever it is toward 0 or 1, the way the Edge layer crossfades its effects
// (gpu/scene.js stepShares), on the frame's own clock, so it runs out while
// the transport is stopped too. A flip made inside a transition since the
// last frame (a journey step's ramp, a preset recall, a followed broadcast:
// presets.js beginTransition, which a step opens over its whole rampS) fades
// over what is left of that transition's window (transitionRemaining); a
// flip by hand, with no transition opened, fades over HAND_FADE_S. A flip
// mid-fade starts from the opacity it has reached. While it fades the frame
// loop is kept awake (busy). The saved state at boot lands without a fade.
//
// It draws in the scene pass straight after the Slides (engine drawScene,
// then slides.draw, then this), in either route, so it sits over the sun and
// over a slide video alike, and the overlay words and the UI still draw over
// it. Dead centre on both axes (open focus).
//
// SIZE: the art was authored against a ~1080p sun render at 490 x 533
// logical px, so at Size 100% it is drawn at height = canvas height *
// 533 / 1080, its width keeping the PNG's own aspect, whatever the canvas;
// Size (25% to 200%) scales both about the centre.
//
// The PNG is fetched and decoded the first time the switch is on, and
// never before; a fetch or decode that fails is logged once and the layer
// draws nothing from then on. The texture is premultiplied on upload
// (copyExternalImageToTexture premultipliedAlpha) and blended
// one / one-minus-src-alpha.
// Sampling is linear, clamped.
//
// Allocation per frame: none.

import { S } from '../js/state.js';
import { idleWake } from '../core/idle.js';
import { presetTransitionCount, transitionRemaining } from '../core/presets.js';

const QR_URL = new URL('../slides/qr_overlay_TSC2026@2x.png', import.meta.url).href;
// The art's authored height against a 1080-high render.
const QR_HEIGHT_FRAC = 533 / 1080;
const QR_FLOATS = 8;
// The fade of a flip made by hand, with no transition in flight, s.
const HAND_FADE_S = 1.0;

const QR_WGSL = `
struct QR {
  rect: vec4f,  // left, top, width, height in target pixels
  look: vec4f,  // target width, target height, opacity, unused
};
@group(0) @binding(0) var<uniform> u: QR;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsQr(@builtin(vertex_index) vi: u32) -> VOut {
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let px = u.rect.xy + c * u.rect.zw;
  let ndc = px / u.look.xy * 2.0 - vec2f(1.0);
  var o: VOut;
  o.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  o.uv = c;
  return o;
}

@fragment
fn fsQr(i: VOut) -> @location(0) vec4f {
  return textureSample(tex, samp, i.uv) * u.look.z;
}
`;

export function createSunQr(device, format) {
  const bgl = device.createBindGroupLayout({
    label: 'sunqr.bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: QR_FLOATS * 4 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const mod = device.createShaderModule({ label: 'sunqr.wgsl', code: QR_WGSL });
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn('sunqr.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }
  // Premultiplied over: the texel already carries its alpha in its colour.
  const premul = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
  const pipe = device.createRenderPipeline({
    label: 'sunqr.pipe',
    layout: device.createPipelineLayout({ label: 'sunqr.layout', bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: 'vsQr' },
    fragment: { module: mod, entryPoint: 'fsQr', targets: [{ format, blend: { color: premul, alpha: premul } }] },
    primitive: { topology: 'triangle-strip' }
  });
  const uniBuf = device.createBuffer({
    label: 'sunqr.uniforms', size: QR_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const uni = new Float32Array(QR_FLOATS);
  const sampler = device.createSampler({
    label: 'sunqr.sampler', magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
  });

  let pixelW = 1, pixelH = 1;
  let state = 0;            // 0 not asked for, 1 loading, 2 ready, 3 failed
  let texW = 1, texH = 1, bind = null;
  let drawing = false;
  let lastSize = -1, lastW = -1, lastH = -1, lastOp = -1;
  // The fade: the drawn opacity, the switch's target (-1 before the first
  // frame), and the run from fadeFrom over fadeDur s, fadeT s in.
  let op = 0, target = -1, fadeFrom = 0, fadeT = 0, fadeDur = 0;
  let seenTransitions = -1;

  async function load() {
    state = 1;
    try {
      const res = await fetch(QR_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      texW = bmp.width; texH = bmp.height;
      const tex = device.createTexture({
        label: 'sunqr.tex', size: [texW, texH], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });
      device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex, premultipliedAlpha: true }, [texW, texH]);
      if (bmp.close) bmp.close();
      bind = device.createBindGroup({
        label: 'sunqr.bind', layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: uniBuf } },
          { binding: 1, resource: tex.createView() },
          { binding: 2, resource: sampler }
        ]
      });
      lastSize = -1;
      state = 2;
      idleWake('qr loaded');
    } catch (e) {
      state = 3;
      console.warn('sunqr: could not load ' + QR_URL + ' (' + (e && e.message ? e.message : e) +
        '). Is it in slides/ and is the page served locally? The QR code draws nothing.');
    }
  }

  function resize(pw, ph) {
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
  }

  // dt: the frame's seconds (engine frameDt), zero on a wake.
  function update(dt) {
    drawing = false;
    const want = S.sunQrOn === true ? 1 : 0;
    const tc = presetTransitionCount();
    if (target < 0) {
      target = want; op = want;
    } else if (want !== target) {
      // Made inside a transition since last frame: its window's remainder.
      // Otherwise a hand flip, and the default fade.
      fadeDur = tc !== seenTransitions ? transitionRemaining() : HAND_FADE_S;
      fadeFrom = op; fadeT = 0; target = want;
    }
    seenTransitions = tc;
    if (want && state === 0) load();
    // The fade's clock waits for the picture, so a first fade in is seen
    // whole rather than joined part way.
    if (state !== 2) return;
    if (op !== target) {
      fadeT += dt > 0 ? dt : 0;
      const f = fadeDur > 0 ? Math.min(1, fadeT / fadeDur) : 1;
      op = f >= 1 ? target : fadeFrom + (target - fadeFrom) * (f * f * (3 - 2 * f));
    }
    if (op <= 0) return;
    const v = S.sunQrSize;
    const size = typeof v === 'number' && v === v ? (v < 0.25 ? 0.25 : v > 2 ? 2 : v) : 1;
    if (size !== lastSize || pixelW !== lastW || pixelH !== lastH || op !== lastOp) {
      lastSize = size; lastW = pixelW; lastH = pixelH; lastOp = op;
      const h = pixelH * QR_HEIGHT_FRAC * size;
      const w = h * texW / texH;
      uni[0] = (pixelW - w) * 0.5; uni[1] = (pixelH - h) * 0.5; uni[2] = w; uni[3] = h;
      uni[4] = pixelW; uni[5] = pixelH; uni[6] = op; uni[7] = 0;
      device.queue.writeBuffer(uniBuf, 0, uni);
    }
    drawing = true;
  }

  // In the scene pass, straight after the Slides.
  function draw(pass) {
    if (!drawing) return;
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.draw(4);
  }

  // Mid-fade (or waiting on the picture for one) keeps the frame loop awake,
  // as a playing slide does (main.js's still frame asks).
  const busy = () => target >= 0 && op !== target && state !== 3;

  return { update, draw, resize, busy };
}
