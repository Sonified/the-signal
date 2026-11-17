// The 3D view of the video broadcast test: everyone else's camera picture
// as a flat panel standing a few metres in front of the viewer, drawn with
// WebGPU, plain and cheap, so what the page measures is the pictures and
// not the drawing.
//
//   const scene = await createScene(canvas);  // rejects in plain words without WebGPU
//   scene.set({ distance, size });            // metres; either may be left out
//   scene.draw(panels);                       // once per animation frame
//   scene.resize();                           // CSS size or pixel ratio changed
//   scene.uploadPath                          // 'direct' or 'canvas'
//   scene.lost                                // true once the GPU device is gone
//
// THE SPACE: real metres. A perspective camera at the origin looks straight
// ahead (down -Z), vertical field of view 50 degrees, near 0.1 m, far 100 m,
// so a panel `size` metres wide standing `distance` metres away looks
// exactly as big as that geometry says. One panel stands straight ahead,
// centred, at eye height (y 0), facing the viewer. Several stand at the same
// distance along an arc centred straight ahead, neighbours a tenth of a
// panel apart (centre to centre, the chord is size x 1.1), each turned to
// face the viewer, spread evenly about the centre so nothing pulls the eye
// to one side. If one arc would need more than a full circle, the panels go
// into rows instead (never smaller panels): as few rows as hold them, as
// evenly filled as they divide, the spare panels placed so the rows balance
// about eye height, and the rows stacked symmetric about eye height. Rows stand on the same cylinder,
// each panel turned about the vertical only.
//
// Each panel keeps its picture's shape (height = size x height / width); one
// with no picture yet is a dim plain 4:3 rectangle. Panels never overlap on
// screen (each row's are spread around the cylinder, rows apart), so they
// are drawn in order with no depth buffer.
//
// PICTURES: one rgba8unorm texture per panel, its picture's size, filled
// with copyExternalImageToTexture straight from the VideoFrame ('direct'),
// and only when the panel's version has moved on. A browser that refuses a
// VideoFrame there gets the frame drawn onto a 2D canvas first and the
// canvas copied instead ('canvas'); once that has worked, every later upload
// goes that way, so nothing throws each frame. The frames are the caller's:
// this file reads them only inside draw and never closes them. A panel id
// that leaves the list has its texture and buffer destroyed on that draw.
//
// COLOUR: the canvas takes navigator.gpu.getPreferredCanvasFormat(), which
// is bgra8unorm or rgba8unorm, never an -srgb format. The copy converts the
// video into sRGB and stores those sRGB-encoded bytes as they are (the
// texture is plain unorm, not -srgb, so sampling decodes nothing), the
// shader passes them through untouched, and the plain unorm canvas shows
// them as sRGB, exactly as the browser shows a <video>. Gamma is applied
// once, by the display, never twice. Linear filtering therefore blends in
// encoded values, which is what a browser scaling a <video> does too.
//
// A lost device marks the scene dead: draw does nothing from then on and
// scene.lost says so. No recovery; this is a test tool.

const FOV_Y = 50 * Math.PI / 180;
const NEAR = 0.1;
const FAR = 100;
const GAP = 0.1;                  // between neighbours, as a fraction of a panel's width
const EMPTY_ASPECT = 3 / 4;       // height / width of a panel with no picture yet
const MAX_ARC = 2 * Math.PI;      // one row may take at most a full circle
const MAX_DPR = 2;
const CLEAR = { r: 0.02, g: 0.02, b: 0.025, a: 1 };
const EMPTY_RGB = [0.13, 0.13, 0.14];
const GPU_REQUEST_TIMEOUT_MS = 10000;
const U_FLOATS = 20;              // mat4 + vec4
const U_BYTES = U_FLOATS * 4;

const WGSL = `
struct U {
  mvp: mat4x4f,   // the panel's unit square (-0.5..0.5) to clip space
  look: vec4f,    // rgb of an empty panel; a 1 when the picture is drawn, 0 when empty
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> V {
  // Triangle strip over the square: bottom left, bottom right, top left, top right.
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  var o: V;
  o.pos = u.mvp * vec4f(c - vec2f(0.5), 0.0, 1.0);
  o.uv = vec2f(c.x, 1.0 - c.y);   // the picture's first row is its top
  return o;
}

@fragment
fn fs(i: V) -> @location(0) vec4f {
  let c = textureSample(tex, samp, i.uv).rgb;
  return vec4f(select(u.look.rgb, c, u.look.a > 0.5), 1.0);
}
`;

// ---- maths (column-major 4x4 in Float32Array, as WGSL reads them) ----

// WebGPU's clip depth runs 0..1, so this is the 0..1 form of the usual
// right-handed perspective: z -near maps to 0, z -far to 1.
export function perspective(fovY, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = near * far / (near - far);
  return out;
}

export function multiply(a, b, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

// A placed panel's model matrix: the unit square scaled to w x h, turned to
// face the viewer, moved to its spot. A panel at arc angle a (to the right
// of straight ahead) takes yaw -a, a turn about the vertical, so its right
// edge points along (cos a, 0, sin a), the arc's tangent, and its front
// along (-sin a, 0, cos a), back towards the vertical axis it stands around.
export function panelModel(p, out = new Float32Array(16)) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  out.fill(0);
  out[0] = c * p.w; out[2] = -s * p.w;
  out[5] = p.h;
  out[8] = s; out[10] = c;
  out[12] = p.x; out[13] = p.y; out[14] = p.z; out[15] = 1;
  return out;
}

// aspects: each panel's height / width, in order. Returns one placement per
// panel, { x, y, z, yaw, w, h }, filling rows top to bottom, each row left
// to right.
export function layoutPanels(aspects, distance, size) {
  const n = aspects.length;
  if (!n) return [];
  // Centre-to-centre angle along the arc: the chord size x (1 + GAP).
  const step = 2 * Math.asin(Math.min(1, size * (1 + GAP) / (2 * distance)));
  const perRow = Math.max(1, Math.floor(MAX_ARC / step + 1e-9));
  const rows = Math.ceil(n / perRow);
  // As even as they divide. The spare panels keep the rows balanced about
  // eye height: an odd one to the middle row (when there is one), the rest
  // in pairs, one above and one below, nearest eye height first. Only an
  // even number of rows with an odd spare cannot balance; that one goes to
  // the row just above eye height.
  const counts = new Array(rows).fill(Math.floor(n / rows));
  const mid = (rows - 1) / 2;
  let spare = n % rows;
  if (rows % 2 === 1 && spare % 2 === 1) { counts[mid]++; spare--; }
  for (let d = rows % 2 === 1 ? 1 : 0.5; spare >= 2; d++, spare -= 2) { counts[mid - d]++; counts[mid + d]++; }
  if (spare) counts[mid - 0.5]++;
  const pitch = size * Math.max(...aspects) * (1 + GAP);
  const out = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const y = (mid - r) * pitch;
    for (let j = 0; j < counts[r]; j++, i++) {
      const a = (j - (counts[r] - 1) / 2) * step;
      out.push({ x: distance * Math.sin(a), y, z: -distance * Math.cos(a), yaw: -a, w: size, h: size * aspects[i] });
    }
  }
  return out;
}

export function aspectOf(panel) {
  if (!panel.frame) return EMPTY_ASPECT;
  const w = panel.width || panel.frame.displayWidth, h = panel.height || panel.frame.displayHeight;
  return w > 0 && h > 0 ? h / w : EMPTY_ASPECT;
}

// ---- the scene ----

function withDeadline(promise, ms) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(undefined), ms))]);
}

export async function createScene(canvas) {
  if (!navigator.gpu) throw new Error('This browser cannot draw the 3D view: it has no WebGPU. Try a recent Chrome on a computer or Safari on a recent iPhone.');
  let adapter = null;
  try { adapter = await withDeadline(navigator.gpu.requestAdapter(), GPU_REQUEST_TIMEOUT_MS); } catch { adapter = null; }
  if (!adapter) throw new Error('This browser has WebGPU but could not find a graphics card to use for the 3D view. Restarting the browser may help.');
  let device = null;
  try { device = await withDeadline(adapter.requestDevice(), GPU_REQUEST_TIMEOUT_MS); } catch { device = null; }
  if (!device) throw new Error('The graphics card would not start for the 3D view. Restarting the browser may help.');

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('This page could not draw 3D on its canvas. Reloading the page may help.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  let lost = false;
  device.lost.then(info => {
    lost = true;
    console.warn('[scene] GPU device lost:', info && info.message);
  });

  const layout = device.createBindGroupLayout({
    label: 'scene.layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const mod = device.createShaderModule({ label: 'scene.wgsl', code: WGSL });
  const pipeline = device.createRenderPipeline({
    label: 'scene.pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module: mod, entryPoint: 'vs' },
    fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-strip' },
  });
  const sampler = device.createSampler({
    label: 'scene.sampler', magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });
  // Stands in for the picture while a panel has none (the shader draws the
  // plain colour then, but a bind group needs some texture).
  const blank = device.createTexture({
    label: 'scene.blank', size: [1, 1], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  let distance = 2.5, size = 1;
  let uploadPath = 'direct';
  let staging = null, stagingCtx = null;   // the 2D canvas of the 'canvas' path
  let warnedUpload = false;
  let cssW = 0, cssH = 0, dpr = 0;
  const proj = new Float32Array(16);
  const model = new Float32Array(16);
  const uni = new Float32Array(U_FLOATS);
  const entries = new Map();               // id -> { tex, w, h, version, ubuf, bind, seen }
  let frameNo = 0;

  function resize() {
    dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    cssW = canvas.clientWidth;
    cssH = canvas.clientHeight;
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    perspective(FOV_Y, w / h, NEAR, FAR, proj);
  }

  function set(o) {
    if (!o) return;
    if (Number.isFinite(o.distance) && o.distance > 0) distance = o.distance;
    if (Number.isFinite(o.size) && o.size > 0) size = o.size;
  }

  function entryFor(id) {
    let e = entries.get(id);
    if (!e) {
      const ubuf = device.createBuffer({ label: 'scene.u', size: U_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      e = { tex: null, w: 0, h: 0, version: undefined, ubuf, bind: null, seen: 0 };
      e.bind = bindFor(e);
      entries.set(id, e);
    }
    return e;
  }

  function bindFor(e) {
    return device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: e.ubuf } },
        { binding: 1, resource: (e.tex || blank).createView() },
        { binding: 2, resource: sampler },
      ],
    });
  }

  function copyViaCanvas(frame, tex, w, h) {
    if (!staging) {
      staging = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      stagingCtx = staging.getContext('2d');
    }
    if (staging.width !== w) staging.width = w;
    if (staging.height !== h) staging.height = h;
    stagingCtx.drawImage(frame, 0, 0, w, h);
    device.queue.copyExternalImageToTexture({ source: staging }, { texture: tex }, [w, h]);
  }

  function upload(e, frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (!(w > 0 && h > 0)) return false;   // a closed frame reads 0 x 0
    if (!e.tex || e.w !== w || e.h !== h) {
      if (e.tex) e.tex.destroy();
      e.tex = device.createTexture({
        label: 'scene.picture', size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      e.w = w; e.h = h;
      e.bind = bindFor(e);
    }
    if (uploadPath === 'direct') {
      try {
        device.queue.copyExternalImageToTexture({ source: frame }, { texture: e.tex }, [w, h]);
        return true;
      } catch (err) {
        try {
          copyViaCanvas(frame, e.tex, w, h);
          uploadPath = 'canvas';
          console.warn('[scene] a VideoFrame cannot be copied to the GPU directly here; going through a 2D canvas:', err && err.message);
          return true;
        } catch (err2) {
          if (!warnedUpload) { warnedUpload = true; console.warn('[scene] picture upload failed both ways:', err && err.message, '/', err2 && err2.message); }
          return false;
        }
      }
    }
    try {
      copyViaCanvas(frame, e.tex, w, h);
      return true;
    } catch (err) {
      if (!warnedUpload) { warnedUpload = true; console.warn('[scene] picture upload through the canvas failed:', err && err.message); }
      return false;
    }
  }

  function draw(panels) {
    if (lost) return;
    // A missed resize() must never leave the picture stretched.
    if (canvas.clientWidth !== cssW || canvas.clientHeight !== cssH || Math.min(MAX_DPR, window.devicePixelRatio || 1) !== dpr) resize();
    frameNo++;

    const list = panels || [];
    const aspects = list.map(aspectOf);
    const placed = layoutPanels(aspects, distance, size);

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const e = entryFor(p.id);
      e.seen = frameNo;
      // A failed upload still counts its version as tried, so a bad frame
      // is not retried (and warned about) every frame; the next one is.
      if (p.frame && p.version !== e.version) { upload(e, p.frame); e.version = p.version; }
      multiply(proj, panelModel(placed[i], model), uni);
      const showing = !!(p.frame && e.tex);
      uni[16] = EMPTY_RGB[0]; uni[17] = EMPTY_RGB[1]; uni[18] = EMPTY_RGB[2];
      uni[19] = showing ? 1 : 0;
      device.queue.writeBuffer(e.ubuf, 0, uni);
    }
    for (const [id, e] of entries) {
      if (e.seen === frameNo) continue;
      if (e.tex) e.tex.destroy();
      e.ubuf.destroy();
      entries.delete(id);
    }

    const enc = device.createCommandEncoder({ label: 'scene.frame' });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: CLEAR, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    for (let i = 0; i < list.length; i++) {
      pass.setBindGroup(0, entries.get(list[i].id).bind);
      pass.draw(4);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  resize();

  return {
    set, draw, resize,
    get uploadPath() { return uploadPath; },
    get lost() { return lost; },
  };
}
