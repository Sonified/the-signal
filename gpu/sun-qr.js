// The show's QR code (core/schema-sun.js, sunQrOn, sunQrWhich and
// sunQrSize): one of two QR PNGs drawn over the whole frame while the switch
// is on, the TSC 2026 code to meditatewiththesun.com or the one that brings a
// phone into the show as a follower (presence.now.audio/?follow=win), the
// pair made alike by tools/make-qr-overlay.py so either sits in one place.
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
// A change of which code crossfades the two by the same rules: the one going
// drawn at the opacity times (1 - mix), the one coming at the opacity times
// mix, mix easing as the opacity does.
//
// It draws in the scene pass straight after the Slides (engine drawScene,
// then slides.draw, then this), in either route, so it sits over the sun and
// over a slide video alike, and the overlay words and the UI still draw over
// it. Dead centre on both axes (open focus) of the field the drawer leaves
// visible (S.edgeInset, the same centre gpu/sun.js keeps), so it stays put
// on the sun while the drawer opens and shuts.
//
// SIZE: the art was authored against a ~1080p sun render at 490 x 553
// logical px, so at Size 100% it is drawn at height = canvas height *
// 553 / 1080, its width keeping the PNG's own aspect, whatever the canvas;
// Size (25% to 200%) scales both about the centre.
//
// Each PNG is fetched and decoded the first time the switch is on with it
// chosen, and never before; a fetch or decode that fails is logged once and
// that code draws nothing from then on. The texture is premultiplied on upload
// (copyExternalImageToTexture premultipliedAlpha) and blended
// one / one-minus-src-alpha.
// Sampling is linear, clamped.
//
// Allocation per frame: none.

import { S } from '../js/state.js';
import { idleWake } from '../core/idle.js';
import { presetTransitionCount, transitionRemaining } from '../core/presets.js';

// By sunQrWhich: 0 meditatewiththesun.com, 1 the follower's code.
const QR_URLS = [
  new URL('../slides/qr_overlay_TSC2026@2x.png', import.meta.url).href,
  new URL('../slides/qr_overlay_follow@2x.png', import.meta.url).href
];
// The art's authored height against a 1080-high render.
const QR_HEIGHT_FRAC = 553 / 1080;
const QR_FLOATS = 8;
// The fade of a flip made by hand, with no transition in flight, s.
const HAND_FADE_S = 1.0;

const QR_WGSL = `
struct QR {
  rect: vec4f,  // left, top, width, height in target pixels
  look: vec4f,  // target width, target height, opacity, lighten (0 to 1)
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

// The art is black ink at 241/255 alpha (the dark modules, the field around
// the code) with the CLEAR parts (the light modules, the letters) cut out of
// it, so the sun shows through them. Lighten fills those clear parts with
// white: how clear a texel is (1 minus its alpha over the ink's) times the
// setting is the white's alpha, laid UNDER the ink, so the ink stays as it
// is and its antialiased edges take their share of white.
const INK_A: f32 = 0.945;
@fragment
fn fsQr(i: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, i.uv);
  let w = u.look.w * clamp(1.0 - t.a / INK_A, 0.0, 1.0);
  let under = w * (1.0 - t.a);
  return (t + vec4f(under)) * u.look.z;
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
  const sampler = device.createSampler({
    label: 'sunqr.sampler', magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
  });
  // One per code: its picture, its own uniforms (both can draw in one pass
  // mid-crossfade), and what was last written to them.
  const arts = QR_URLS.map((url, k) => ({
    url, state: 0,          // 0 not asked for, 1 loading, 2 ready, 3 failed
    texW: 1, texH: 1, bind: null, drawing: false,
    uniBuf: device.createBuffer({
      label: 'sunqr.uniforms.' + k, size: QR_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    }),
    uni: new Float32Array(QR_FLOATS),
    lastSize: -1, lastW: -1, lastH: -1, lastOp: -1, lastCx: -1, lastLight: -1
  }));

  let pixelW = 1, pixelH = 1;
  // The fades: the drawn value, the target (-1 before the first frame), and
  // the run from `from` over dur s, t s in. show is the switch's opacity,
  // mix the share of the follower's code.
  const show = { v: 0, target: -1, from: 0, t: 0, dur: 0 };
  const mix = { v: 0, target: -1, from: 0, t: 0, dur: 0 };
  let seenTransitions = -1;

  function aim(f, want, dur) {
    if (f.target < 0) { f.target = want; f.v = want; }
    else if (want !== f.target) { f.dur = dur; f.from = f.v; f.t = 0; f.target = want; }
  }
  function step(f, dt) {
    if (f.v === f.target) return;
    f.t += dt > 0 ? dt : 0;
    const u = f.dur > 0 ? Math.min(1, f.t / f.dur) : 1;
    f.v = u >= 1 ? f.target : f.from + (f.target - f.from) * (u * u * (3 - 2 * u));
  }

  async function load(a) {
    a.state = 1;
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      a.texW = bmp.width; a.texH = bmp.height;
      const tex = device.createTexture({
        label: 'sunqr.tex', size: [a.texW, a.texH], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });
      device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex, premultipliedAlpha: true }, [a.texW, a.texH]);
      if (bmp.close) bmp.close();
      a.bind = device.createBindGroup({
        label: 'sunqr.bind', layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: a.uniBuf } },
          { binding: 1, resource: tex.createView() },
          { binding: 2, resource: sampler }
        ]
      });
      a.lastSize = -1;
      a.state = 2;
      idleWake('qr loaded');
    } catch (e) {
      a.state = 3;
      console.warn('sunqr: could not load ' + a.url + ' (' + (e && e.message ? e.message : e) +
        '). Is it in slides/ and is the page served locally? That QR code draws nothing.');
    }
  }

  function resize(pw, ph) {
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
  }

  // dt: the frame's seconds (engine frameDt), zero on a wake.
  function update(dt) {
    arts[0].drawing = arts[1].drawing = false;
    const want = S.sunQrOn === true ? 1 : 0;
    const pick = S.sunQrWhich === 'follow' ? 1 : 0;
    const tc = presetTransitionCount();
    // Made inside a transition since last frame: its window's remainder.
    // Otherwise a hand flip, and the default fade.
    const dur = tc !== seenTransitions ? transitionRemaining() : HAND_FADE_S;
    aim(show, want, dur);
    aim(mix, pick, dur);
    seenTransitions = tc;
    const chosen = arts[pick];
    if (want && chosen.state === 0) load(chosen);
    // The fades' clock waits for the chosen picture, so a first fade in (or
    // a crossfade to a code not yet seen) is seen whole rather than joined
    // part way. Switched off, nothing waits: the fade out runs on.
    if (want && (chosen.state === 0 || chosen.state === 1)) return;
    step(show, dt);
    step(mix, dt);
    if (show.v <= 0) return;
    const v = S.sunQrSize;
    const size = typeof v === 'number' && v === v ? (v < 0.25 ? 0.25 : v > 2 ? 2 : v) : 1;
    // The centre of the field the drawer leaves visible, as gpu/sun.js
    // keeps it (inset in css px; pixelW / S.W is the device pixel ratio).
    const inset = S.edgeInset > 0 && S.W > 0 ? S.edgeInset * pixelW / S.W : 0;
    const cx = (pixelW + inset) * 0.5;
    const lv = S.sunQrLighten;
    const light = typeof lv === 'number' && lv === lv ? (lv < 0 ? 0 : lv > 1 ? 1 : lv) : 0;
    for (let k = 0; k < 2; k++) {
      const a = arts[k];
      const op = show.v * (k ? mix.v : 1 - mix.v);
      if (a.state !== 2 || op <= 0) continue;
      if (size !== a.lastSize || pixelW !== a.lastW || pixelH !== a.lastH || op !== a.lastOp || cx !== a.lastCx || light !== a.lastLight) {
        a.lastSize = size; a.lastW = pixelW; a.lastH = pixelH; a.lastOp = op; a.lastCx = cx; a.lastLight = light;
        const h = pixelH * QR_HEIGHT_FRAC * size;
        const w = h * a.texW / a.texH;
        const u = a.uni;
        u[0] = cx - w * 0.5; u[1] = (pixelH - h) * 0.5; u[2] = w; u[3] = h;
        u[4] = pixelW; u[5] = pixelH; u[6] = op; u[7] = light;
        device.queue.writeBuffer(a.uniBuf, 0, u);
      }
      a.drawing = true;
    }
  }

  // In the scene pass, straight after the Slides.
  function draw(pass) {
    for (let k = 0; k < 2; k++) {
      const a = arts[k];
      if (!a.drawing) continue;
      pass.setPipeline(pipe);
      pass.setBindGroup(0, a.bind);
      pass.draw(4);
    }
  }

  // Mid-fade (or waiting on the picture for one) keeps the frame loop awake,
  // as a playing slide does (main.js's still frame asks).
  // A load always ends ready or failed, so no fade waits for ever.
  const busy = () => show.target >= 0 && (show.v !== show.target || mix.v !== mix.target);

  return { update, draw, resize, busy };
}
