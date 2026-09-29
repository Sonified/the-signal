// Reusable video feedback: a layer draws into an image of its own instead of
// straight into its target, and each frame that image starts as a faded copy
// of the last, so everything the layer draws leaves a trail that dies away.
// The copy can also be taken a little larger or smaller about a centre
// (stream) and turned about it (twist), so the trails stream out or in and
// swirl, alike in every direction. It is built to be shared the way fold.js
// is: every layer that wants trails owns its own instance, with its own
// settings, and Confetti is the first.
//
// How a layer plugs in. Create one per image with
// createFeedback(device, sceneFormat, { label }). On each frame:
//   1. ensure(w, h) with the image's size in texels (canvas size in device
//      pixels for an image laid over the scene). It makes the pair only
//      when the size changes, cleared, never in an ordinary frame.
//   2. Fill a reused params object: { keepHalfLife, zoomRate, twistRate,
//      cx, cy, unit, dt }. keepHalfLife is the trails' half-life in seconds, 0 for
//      no trails (each frame starts clear). zoomRate is the stream, per
//      second (the image's scale grows by exp(zoomRate * dt) a frame, so
//      positive streams outward), twistRate the turn, radians per second
//      (positive is clockwise with y down). cx, cy is the centre of both, in
//      the image's texels. unit is how many of the image's texels one unit
//      of the caller's scene covers, in any consistent measure: only its
//      frame to frame RATIO is ever used, to rescale the old image about
//      the centre when the projection changes size (confetti passes focal,
//      so a drawer slide, which shrinks the visible field and focal with
//      it, zooms the trails to match instead of leaving them at the old
//      size). 1 if left out. dt is the frame's step, 0 while the
//      scene is stopped. The fade, stream and twist all go by dt, so they
//      look the same at any frame rate. The centre and unit may move from
//      frame to frame (the field centre follows the drawer): the module
//      remembers last frame's, and the fade carries the old image along so
//      what sat at the old centre lands on the new one at the new scale, and
//      the trails stay with the scene instead of detaching from it.
//   3. begin(encoder, params, drawing), before the scene pass. It returns a
//      render pass on the image's next texture, already holding either a
//      clear or the faded, streamed, twisted copy of the last image; draw
//      the layer into it with premultiplied "over" (alpha building up as
//      coverage, as into a fold chamber), then end(pass), which ends it and
//      makes that texture current. drawing says whether the layer has
//      anything to draw into it this frame (left out, it counts as yes). It
//      returns null instead when the image is held: stopped with trails,
//      where the image stays as it is and nothing should be drawn
//      (drawing the held content again over itself would thicken anything
//      see-through); a held image whose centre or unit moved (the drawer
//      sliding while stopped) is carried to them first, so it keeps up.
//      holds(params) says the same beforehand, for a layer with other work
//      to skip. It also returns null when the image is
//      already exactly transparent black and nothing is to be drawn: the
//      fade of an empty image is empty, so the frame would change nothing,
//      and the image, the composite and view all skip it (see maxLevel in createFeedback).
//   4. Then either composite(pass, gain, opacity) inside the scene pass, which lays
//      the current image over the scene one texel per pixel (so the image
//      must be the target's size), or hand view to something that reads it,
//      such as a fold (fold.js drawFrom, whose colorGain does the same job
//      as this gain). gain, optional and 1 when left out, scales the image's
//      colour only, clamped to 0..1: its coverage is kept, so a lower gain
//      darkens the image rather than making it see-through. It is applied as
//      the image is laid over, never stored in it, so it can change every
//      frame (a pulse with the strobe) and holds steady on a held image.
//      opacity, optional and 1 when left out, clamped to 0..1, is a true
//      opacity on the composite: it scales colour and alpha together, so
//      the whole image goes that much see-through over the scene, while the
//      trails inside the image build and fade exactly as before. Near 0 the
//      composite is skipped, but the image keeps updating, so turning it
//      back up shows the trails as they are now. A fold reading view does
//      the same with its gain.
// release() lets the pair go (the layer switching off, or not using this
// image for a while); ensure makes it again, cleared. destroy() also frees
// the uniform buffer.
//
// The pipelines, sampler and layout are shared by every instance on a
// device. Each instance has its pair, one bind group per texture of it (each
// serves both the fade into the other texture and the composite of this one)
// made when the pair is, and a small uniform buffer. Nothing is allocated per
// frame.
//
// The image is half float (rgba16float), not 8 bits a channel, so a slow fade
// is honest: in 8 bits a faint texel times a k near 1 rounds back to itself,
// and the only cure was a fixed step taken off every frame, which drained a
// full image in about a second and a half at 120 Hz whatever the half-life
// said. In half float the fade is a plain multiply and the half-life means
// what it says (see fsDecay in feedback.wgsl.js). The cost is memory: the
// pair is 16 bytes a pixel per instance (two textures at 8), so a canvas
// sized image at 3456 x 2234 holds about 124 MB. rgba16float is renderable,
// blendable and filterable in core WebGPU, so nothing else changes: the
// sampler stays filtering, and a fold reading view (fold.js drawFrom) binds
// it as a float texture as before.

import { FEEDBACK_WGSL } from './feedback.wgsl.js';

export const FEEDBACK_FORMAT = 'rgba16float';
// Any channel the fade leaves under this is set to exactly 0 (fsDecay). A
// quarter of an 8-bit level, so it takes away only what the 8-bit canvas
// could never show, and it is what makes a trail reach true zero in bounded
// time, which the empty-image skip needs (see maxLevel in createFeedback).
// Held as the f32 the uniform carries, so the CPU and GPU compare against
// the very same number.
const FLOOR = Math.fround(0.25 / 255);
// The largest fade factor ever sent. It keeps the half float fade from
// stalling: every nonzero half float v has its next value down within
// v * 2^-10 of it, so with k at most 1 - 2^-10, v * k lies at or below that
// next value and stores there or lower (the GPU stores to half float by
// rounding to nearest or toward zero, the two ways Vulkan, Metal and D3D
// allow), so a texel read as is falls at least one step every fade. It
// bites only at very high frame rates, on a half-life over about 709
// frames (4 s above about 177 Hz, 2 s above about 355 Hz), where the trails
// go a little shorter than asked.
const K_CAP = 1 - 2 ** -10;
// The mirror's allowance per fade (see fadeTop): 2^-11 for the half float
// store, which rounds a value x at or above FLOOR (well inside half float's
// normal range, which starts at 2^-14) to at most x plus half a step, and a
// step there is at most x * 2^-10; and 2^-18 more for the f32 multiply
// (2^-24) and the filtered read (a convex mix of the texels, which the
// hardware filters at f32 precision, so it overshoots the largest texel by
// well under 2^-19).
const SLACK = 2 ** -11 + 2 ** -18;
const UNIFORM_FLOATS = 16;          // see feedback.wgsl.js's struct FB
// Where the composite's gain sits in the uniforms (struct FB's look.x).
const GAIN_AT = 12;
// And the composite's opacity (look.w). look.y and look.z are begin's, last
// frame's centre.
const OPACITY_AT = 15;

// The bound on a faded image (see createFeedback's maxLevel): every channel
// at most m before a fade with factor k (as the uniform holds it, f32), at
// most this after it.
function fadeTop(m, k) {
  const t = m * k * (1 + SLACK);
  return t < FLOOR ? 0 : t;
}

// The device-wide parts, made once per device: the module, the layout, the
// fade pipeline and sampler, and a composite pipeline per scene format.
const sharedByDevice = new WeakMap();
function sharedFor(device) {
  let sh = sharedByDevice.get(device);
  if (sh) return sh;
  const mod = device.createShaderModule({ label: 'feedback.wgsl', code: FEEDBACK_WGSL });
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn('feedback.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }
  const bgl = device.createBindGroupLayout({
    label: 'feedback.bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const layout = device.createPipelineLayout({ label: 'feedback.layout', bindGroupLayouts: [bgl] });
  // The fade replaces every texel, so no blend.
  const decayPipe = device.createRenderPipeline({
    label: 'feedback.decay', layout,
    vertex: { module: mod, entryPoint: 'vsFeedback' },
    fragment: { module: mod, entryPoint: 'fsDecay', targets: [{ format: FEEDBACK_FORMAT }] },
    primitive: { topology: 'triangle-list' }
  });
  // Linear, for the streamed and twisted read; the edges are handled in the
  // shader (outside reads as nothing), so the address mode only matters
  // within half a texel of the rim.
  const sampler = device.createSampler({
    label: 'feedback.sampler',
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
  });
  sh = { mod, bgl, layout, decayPipe, sampler, comp: new Map() };
  sharedByDevice.set(device, sh);
  return sh;
}

// The composite onto the scene: premultiplied "over" for colour and alpha
// alike, as the fold's default blend.
function compositeFor(device, sh, format) {
  let p = sh.comp.get(format);
  if (p) return p;
  p = device.createRenderPipeline({
    label: 'feedback.composite', layout: sh.layout,
    vertex: { module: sh.mod, entryPoint: 'vsFeedback' },
    fragment: {
      module: sh.mod, entryPoint: 'fsComposite',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
        }
      }]
    },
    primitive: { topology: 'triangle-list' }
  });
  sh.comp.set(format, p);
  return p;
}

export function createFeedback(device, sceneFormat, opts) {
  const label = (opts && opts.label) || 'feedback';
  const sh = sharedFor(device);
  const compPipe = compositeFor(device, sh, sceneFormat);
  const uniBuf = device.createBuffer({
    label: label + '.uniforms',
    size: UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const uni = new Float32Array(UNIFORM_FLOATS);
  // The composite's gain, 1 until told otherwise. uniGain is what the buffer
  // holds, so composite writes only when it changes; -1 forces the first.
  uni[GAIN_AT] = 1;
  let uniGain = -1;
  // The same for the composite's opacity.
  uni[OPACITY_AT] = 1;
  let uniOpacity = -1;

  // tex, views and binds are indexed by texture: binds[i] reads tex[i]. cur
  // is the one holding the latest image, next the one a begun pass writes.
  // live says the current texture holds an image worth showing; a new pair
  // has none, so its first frame clears rather than fades.
  const tex = [null, null], views = [null, null], binds = [null, null];
  let w = 0, h = 0, cur = 0, next = 1, live = false;
  // The centre and unit the current image was drawn about: the last begun
  // frame's. Only meaningful while live; a clear sets them afresh, so a new
  // or cleared image never carries a stale centre into its first fade.
  let lastCx = 0, lastCy = 0, lastUnit = 1;
  // An upper bound on every channel of every texel of the current image, as
  // every reader sees it (clamped to 0..1: fsDecay and fsComposite clamp,
  // and the one image a fold reads raw, Confetti's, is premultiplied cover
  // that never passes 1), kept on the CPU so an image that has faded to
  // exactly nothing costs nothing. Anything drawn sets it to 1. A clear with
  // nothing drawn sets it to 0. A fade takes m to at most
  // m * k * (1 + SLACK), or 0 under FLOOR (fadeTop). Why that is never low:
  // fsDecay reads prev, a texel as is, a filtered mix of texels, or outside,
  // 0, so min(prev, 1) is at most m, give or take the filter's overshoot;
  // times k in f32 that is x, at most m * k give or take 2^-24; and the half
  // float store rounds x, when it is at least FLOOR, up by at most half a
  // step, a relative 2^-11. Half float's precision is far finer than FLOOR,
  // but it is relative, and it is the relative error that has to be covered
  // at every level from 1 down, which SLACK does with room to spare. And
  // when fadeTop gives 0, t is under FLOOR, so every x, being no more than
  // t, is under it too, and fsDecay has written exactly 0 everywhere. The
  // bound also falls: k * (1 + SLACK) is under 1 - 2^-12 even at K_CAP, so
  // an untouched image's bound reaches 0 in at most about 28,400 fades, and
  // at any ordinary setting far fewer. It lags the image, never leads it:
  // at 120 Hz a 4 s half-life's image is truly empty after about 40 s and
  // the bound says so after about 61, when the skip starts; until then the
  // passes run on an image too faint to see, which costs a little and shows
  // nothing. A held frame runs no fade, so it leaves the
  // bound alone. At 0 the image is known to be transparent black: its fade
  // is transparent black whatever the centre, stream or twist, and laying
  // it over the scene adds 0 and keeps 1 - 0 of what is there, the scene
  // exactly. So with 0 and nothing to draw, begin skips the frame and
  // composite and view skip the image. pendingLevel is begin's value, taken
  // up by end when that texture becomes current.
  let maxLevel = 0, pendingLevel = 0;
  // Cleared every frame: the fade, when there is one, covers every texel
  // itself, so nothing needs loading first.
  const passDesc = {
    label: label + '.pass',
    colorAttachments: [{
      view: null,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: 'clear',
      storeOp: 'store'
    }]
  };

  function ensure(width, height) {
    const maxDim = (device.limits && device.limits.maxTextureDimension2D) || 8192;
    const ww = Math.min(maxDim, Math.max(1, width | 0));
    const hh = Math.min(maxDim, Math.max(1, height | 0));
    if (tex[0] && w === ww && h === hh) return;
    release();
    w = ww; h = hh;
    for (let i = 0; i < 2; i++) {
      tex[i] = device.createTexture({
        label: label + '.image' + i,
        size: { width: w, height: h },
        format: FEEDBACK_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      views[i] = tex[i].createView();
      binds[i] = device.createBindGroup({
        label: label + '.bind' + i, layout: sh.bgl,
        entries: [
          { binding: 0, resource: { buffer: uniBuf } },
          { binding: 1, resource: views[i] },
          { binding: 2, resource: sh.sampler }
        ]
      });
    }
    cur = 0; next = 1; live = false; maxLevel = 0;
  }

  // Stopped with trails and an image to hold: begin would return null.
  function holds(p) {
    return live && p.keepHalfLife > 0 && !(p.dt > 0);
  }

  // A held image still follows the field. Stopped, the drawer can slide and
  // move the centre and unit; the image is then carried to them (no fade,
  // no stream or twist, nothing drawn), so the trails stay with the scene
  // instead of being left where the pause found them. Still, it is left
  // exactly as it is.
  function carry(encoder, p) {
    const unit = p.unit > 0 ? p.unit : 1;
    if (p.cx === lastCx && p.cy === lastCy && unit === lastUnit) return;
    uni[0] = 1;
    uni[1] = FLOOR;
    uni[2] = lastUnit / unit;
    uni[3] = 0;
    uni[4] = p.cx; uni[5] = p.cy; uni[6] = 1; uni[7] = 0;
    uni[8] = w; uni[9] = h; uni[10] = 1 / w; uni[11] = 1 / h;
    uni[GAIN_AT + 1] = lastCx; uni[GAIN_AT + 2] = lastCy;
    device.queue.writeBuffer(uniBuf, 0, uni);
    lastCx = p.cx; lastCy = p.cy; lastUnit = unit;
    // Every reader clamps to 1, so the bound can too (see maxLevel).
    const level = Math.min(1, fadeTop(maxLevel, 1));
    next = 1 - cur;
    passDesc.colorAttachments[0].view = views[next];
    const pass = encoder.beginRenderPass(passDesc);
    pass.setPipeline(sh.decayPipe);
    pass.setBindGroup(0, binds[cur]);
    pass.draw(3);
    pass.end();
    cur = next;
    maxLevel = level;
  }

  // Held, the image is only carried (see carry) and null comes back: the
  // layer draws nothing into a held image.
  function begin(encoder, p, drawing) {
    if (!tex[0]) return null;
    if (holds(p)) { if (maxLevel > 0) carry(encoder, p); return null; }
    const draws = drawing !== false;
    const decay = live && p.keepHalfLife > 0;
    const unit = p.unit > 0 ? p.unit : 1;
    // Empty and nothing to draw: this frame's image would be the empty
    // image again (see maxLevel), so none is made; the current one stays, and
    // so does live. A new pair's textures start zeroed (WebGPU clears every
    // new texture), so this holds before its first frame too.
    if (maxLevel === 0 && !draws) {
      lastCx = p.cx; lastCy = p.cy; lastUnit = unit;
      return null;
    }
    pendingLevel = draws ? 1 : 0;
    if (decay) {
      const dt = p.dt;
      const zoom = p.zoomRate || 0, twist = p.twistRate || 0;
      const a = twist * dt;
      // The map from this frame's pixel to last frame's image: its offset
      // from this frame's centre, rescaled by last frame's unit over this
      // one's and undone by the stream's scale, turned back by the twist,
      // about last frame's centre (see fsDecay). With a still centre and
      // unit that is the plain stream and twist about the centre; with
      // neither, and no stream or twist, it is the texel itself, read
      // texel for texel.
      const still = p.cx === lastCx && p.cy === lastCy && unit === lastUnit;
      const k = Math.exp(-dt * Math.LN2 / p.keepHalfLife);
      uni[0] = k < K_CAP ? k : K_CAP;
      uni[1] = FLOOR;
      uni[2] = Math.exp(-zoom * dt) * lastUnit / unit;
      uni[3] = still && zoom === 0 && twist === 0 ? 1 : 0;
      uni[4] = p.cx; uni[5] = p.cy; uni[6] = Math.cos(a); uni[7] = Math.sin(a);
      uni[8] = w; uni[9] = h; uni[10] = 1 / w; uni[11] = 1 / h;
      uni[GAIN_AT + 1] = lastCx; uni[GAIN_AT + 2] = lastCy;
      device.queue.writeBuffer(uniBuf, 0, uni);
      if (!draws) pendingLevel = fadeTop(maxLevel, uni[0]);
    }
    // What this frame's image is drawn about, for the next frame's fade. A
    // clear (no trails, or a new image) starts it here too, so there is no
    // stale "last" to jump from.
    lastCx = p.cx; lastCy = p.cy; lastUnit = unit;
    next = 1 - cur;
    passDesc.colorAttachments[0].view = views[next];
    const pass = encoder.beginRenderPass(passDesc);
    if (decay) {
      pass.setPipeline(sh.decayPipe);
      pass.setBindGroup(0, binds[cur]);
      pass.draw(3);
    }
    return pass;
  }

  function end(pass) {
    pass.end();
    cur = next;
    live = true;
    maxLevel = pendingLevel;
  }

  // Inside the scene pass: the current image over the scene, texel for
  // pixel, its colour scaled by gain (see step 4 at the top). Nothing until
  // the image has had a frame. The gain goes into its own slot of the
  // uniforms; begin writes the whole block, but uni keeps the gain there, so
  // either write leaves it right, and the one written last before the
  // submit is what both passes of the frame read.
  function composite(pass, gain, opacity) {
    if (!live || !binds[cur] || maxLevel === 0) return;
    let o = typeof opacity === 'number' && opacity === opacity ? opacity : 1;
    if (o < 0) o = 0; else if (o > 1) o = 1;
    if (o <= 0.002) return;
    uni[OPACITY_AT] = o;
    if (o !== uniOpacity) {
      uniOpacity = o;
      device.queue.writeBuffer(uniBuf, OPACITY_AT * 4, uni, OPACITY_AT, 1);
    }
    let g = typeof gain === 'number' && gain === gain ? gain : 1;
    if (g < 0) g = 0; else if (g > 1) g = 1;
    uni[GAIN_AT] = g;
    if (g !== uniGain) {
      uniGain = g;
      device.queue.writeBuffer(uniBuf, GAIN_AT * 4, uni, GAIN_AT, 1);
    }
    pass.setPipeline(compPipe);
    pass.setBindGroup(0, binds[cur]);
    pass.draw(3);
  }

  function release() {
    for (let i = 0; i < 2; i++) {
      if (tex[i]) tex[i].destroy();
      tex[i] = null; views[i] = null; binds[i] = null;
    }
    w = 0; h = 0; live = false; maxLevel = 0;
    passDesc.colorAttachments[0].view = null;
  }

  function destroy() {
    release();
    uniBuf.destroy();
  }

  return {
    format: FEEDBACK_FORMAT,
    // Null too while the image is known empty (see maxLevel): a reader laying
    // it over the scene would change nothing.
    get view() { return live && maxLevel > 0 ? views[cur] : null; },
    get live() { return live; },
    get width() { return w; },
    get height() { return h; },
    ensure, holds, begin, end, composite, release, destroy
  };
}
