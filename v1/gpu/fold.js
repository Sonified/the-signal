// A reusable kaleidoscope fold: an offscreen chamber texture that a layer
// draws into, and the fullscreen pass that folds that chamber into the whole
// N-fold pattern inside the scene pass. It is the fold kaleido.js built for
// its motifs, lifted out so any layer can be seen through the same mirrors;
// the particle layer is its first user, and kaleido.js keeps its own copy
// for now.
//
// How a layer uses it. Create one per layer with createFold(device, format)
// (the fold owns one uniform block, so two layers sharing one would overwrite
// each other's settings). On each frame the layer is folded, call
// ensureChamber(pixelW, pixelH, params) with the canvas size in device pixels
// and this frame's fold params (it makes the texture only when the wanted
// size changes, never in an ordinary frame), then fit(cx, cy) with the field
// centre in device pixels. After
// that, frame holds everything needed to draw into the chamber: a point that
// sits at (x, y) device px from the field centre on screen belongs at
// frame[4] + x * frame[6], frame[5] + y * frame[6] texels in a chamber of
// frame[0] x frame[1] texels. Draw into chamberView in a pass of the layer's
// own, before the scene pass (chamberPassDesc is ready made and clears it to
// transparent), with premultiplied colour: alpha 0 for light that adds,
// alpha 1 for something that covers. Then, inside the scene pass, call
// draw(pass, params) where params is a reused object of the layer's own:
// { folds, mirror, rotation, gain }. draw() writes the uniform block with
// queue.writeBuffer, which lands before the command buffer holding the pass
// is submitted, so it is safe to call mid encoding.
//
// The chamber is in the screen's own frame about the field centre, so
// whatever the layer draws keeps its on-screen size and direction; only the
// fundamental domain (a single wedge pointing straight up from the centre,
// the whole wedge or with mirror half of it) is ever read, and anything drawn
// outside it is simply never seen. It is sized for the domain the params
// passed to ensureChamber give (at most a whole 3-fold wedge, 60 degrees
// either side of straight up; 11.25 at 8 folds mirrored) out to the canvas's
// half diagonal, at RES texels per device pixel, so it clears and stores only
// the texels the fold can read; a change of fold count or mirror makes a new
// one, as a resize does. Without params it takes the widest. The field centre moving off
// the canvas's middle (the drawer opening) stretches the farthest corner past
// that half diagonal; fit() lowers the texels per pixel a little to cover it
// rather than reallocating while the drawer slides.
//
// No allocation in fit() or draw().

import { FOLD_WGSL } from './fold.wgsl.js';

const MIN_FOLDS = 3, MAX_FOLDS = 16;
const UNIFORM_FLOATS = 16;          // see fold.wgsl.js's struct FU
const TAU = Math.PI * 2;
const UP = -Math.PI * 0.5;          // the domain's centre line, straight up the screen
// Chamber texels per device pixel at the canvas's half diagonal. The fold
// reads it with bilinear filtering, so half resolution is soft only where the
// content is already large or already soft.
const DEFAULT_RES = 0.5;
// Transparent texels kept round the chamber's working area, so a bilinear
// read at the very centre or the far rim never touches the texture's edge.
const PAD = 4;
// The widest domain is a whole 3-fold wedge, 120 degrees; half of it reaches
// 60 degrees either side of straight up.
const WIDEST_HALF_SIN = Math.sin(Math.PI / MIN_FOLDS);

// The fold count and mirror of a params object, as draw() reads them, and
// the sine of the half angle of the domain they make: the domain is a whole
// wedge unmirrored, half of one mirrored, centred on straight up.
function foldsOf(params) {
  let folds = params && typeof params.folds === 'number' ? Math.round(params.folds) : 8;
  if (!(folds >= MIN_FOLDS)) folds = MIN_FOLDS;
  if (folds > MAX_FOLDS) folds = MAX_FOLDS;
  return folds;
}
function domainHalfSin(params) {
  if (!params) return WIDEST_HALF_SIN;
  const wedge = TAU / foldsOf(params);
  const span = params.mirror === false ? wedge : wedge * 0.5;
  return Math.sin(span * 0.5);
}
export const FOLD_CHAMBER_FORMAT = 'rgba8unorm';

// opts (read once): label, for the pipeline and texture names in console
// errors; res, chamber texels per device pixel; blend, 'over' (premultiplied,
// the default) or 'add' (pure light, the chamber's alpha ignored).
export function createFold(device, format, opts) {
  const label = (opts && opts.label) || 'fold';
  const res = (opts && opts.res > 0 && opts.res <= 1) ? opts.res : DEFAULT_RES;
  const blendMode = opts && opts.blend === 'add' ? 'add' : 'over';

  const bgl = device.createBindGroupLayout({
    label: label + '.bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const mod = device.createShaderModule({ label: label + '.wgsl', code: FOLD_WGSL });
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn(label + '.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }
  const blend = blendMode === 'add'
    ? {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
      }
    : {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
      };
  const pipe = device.createRenderPipeline({
    label: label + '.pass',
    layout: device.createPipelineLayout({ label: label + '.layout', bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: 'vsFold' },
    fragment: { module: mod, entryPoint: 'fsFold', targets: [{ format, blend }] },
    primitive: { topology: 'triangle-list' }
  });

  const uniBuf = device.createBuffer({
    label: label + '.uniforms',
    size: UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const uni = new Float32Array(UNIFORM_FLOATS);
  const sampler = device.createSampler({
    label: label + '.sampler',
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
  });

  let chamber = null, view = null, bind = null;
  let chamberW = 0, chamberH = 0, canvasW = 1, canvasH = 1, halfSin = WIDEST_HALF_SIN;
  let cxNow = 0, cyNow = 0;
  const frame = new Float32Array(8);
  const chamberPassDesc = {
    label: label + '.chamber',
    colorAttachments: [{
      view: null,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: 'clear',
      storeOp: 'store'
    }]
  };

  // Sizes the chamber for a canvas of pixelW x pixelH device px and the
  // domain params (the { folds, mirror } draw() will get) make, making it
  // only when that size differs from the one it has. Returns whether a
  // chamber exists.
  function ensureChamber(pixelW, pixelH, params) {
    canvasW = Math.max(1, pixelW | 0);
    canvasH = Math.max(1, pixelH | 0);
    halfSin = domainHalfSin(params);
    const maxDim = (device.limits && device.limits.maxTextureDimension2D) || 8192;
    const ext = 0.5 * Math.hypot(canvasW, canvasH) * res;
    const wantH = Math.min(maxDim, Math.ceil(ext) + 2 * PAD);
    const wantW = Math.min(maxDim, 2 * (Math.ceil(ext * halfSin) + PAD));
    if (chamber && chamberW === wantW && chamberH === wantH) return true;
    if (chamber) chamber.destroy();
    chamberW = wantW; chamberH = wantH;
    chamber = device.createTexture({
      label: label + '.chamber',
      size: { width: chamberW, height: chamberH },
      format: FOLD_CHAMBER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    view = chamber.createView();
    chamberPassDesc.colorAttachments[0].view = view;
    bind = device.createBindGroup({
      label: label + '.bind',
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: view },
        { binding: 2, resource: sampler }
      ]
    });
    return true;
  }

  // Places the field centre (device px) in the chamber and works out the
  // texels per device pixel that let the chamber reach the farthest screen
  // pixel both straight up and across the domain. Fills frame.
  function fit(cx, cy) {
    cxNow = cx; cyNow = cy;
    const farX = cx > canvasW - cx ? cx : canvasW - cx;
    const farY = cy > canvasH - cy ? cy : canvasH - cy;
    const reachPx = Math.max(1, Math.hypot(farX, farY));
    const up = (chamberH - 2 * PAD) / reachPx;
    const across = (chamberW * 0.5 - PAD) / (reachPx * halfSin);
    frame[0] = chamberW; frame[1] = chamberH;
    frame[2] = chamberW > 0 ? 1 / chamberW : 0; frame[3] = chamberH > 0 ? 1 / chamberH : 0;
    frame[4] = chamberW * 0.5; frame[5] = chamberH - PAD;
    frame[6] = up < across ? up : across; frame[7] = 0;
  }

  // The fold itself, inside the scene pass: one fullscreen triangle, one
  // chamber read per pixel. params: { folds, mirror, rotation, gain }.
  function draw(pass, params) {
    if (!bind) return;
    const folds = foldsOf(params);
    const mirror = !(params && params.mirror === false);
    const rotation = params && typeof params.rotation === 'number' ? params.rotation % TAU : 0;
    const gain = params && typeof params.gain === 'number' ? params.gain : 1;
    if (!(gain > 0.001)) return;
    const wedge = TAU / folds;
    const span = mirror ? wedge * 0.5 : wedge;
    uni[0] = frame[0]; uni[1] = frame[1]; uni[2] = frame[2]; uni[3] = frame[3];
    uni[4] = frame[4]; uni[5] = frame[5]; uni[6] = frame[6]; uni[7] = gain;
    uni[8] = cxNow; uni[9] = cyNow; uni[10] = wedge; uni[11] = rotation;
    uni[12] = UP - span * 0.5; uni[13] = mirror ? 1 : 0; uni[14] = 0; uni[15] = 0;
    device.queue.writeBuffer(uniBuf, 0, uni);
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.draw(3);
  }

  // Frees the chamber (on a resize the layer does not need it straight
  // away, or when the layer stops folding); ensureChamber makes it again.
  function releaseChamber() {
    if (chamber) chamber.destroy();
    chamber = null; view = null; bind = null;
    chamberW = 0; chamberH = 0;
    chamberPassDesc.colorAttachments[0].view = null;
  }

  function destroy() {
    releaseChamber();
    uniBuf.destroy();
  }

  return {
    chamberFormat: FOLD_CHAMBER_FORMAT,
    chamberPassDesc,
    frame,
    get chamberView() { return view; },
    ensureChamber, fit, draw, releaseChamber, destroy
  };
}
