// Owns the star field: meditatewiththesun.com's drifting sky (its main.js
// `stars`), ported to the letter. A seeded sky, the same on every visit,
// drifting slowly right to left: we are the ones turning, gently, to the
// right around the sun. It reads S every frame and does no work at all while
// S.sunStars is off; its buffers are made the first frame it is on.
//
// The site paints its sky once into offscreen 2D tiles (a static sky and
// three twinkling groups) and draws each tile twice a frame, wrapped. Here
// the same stars are drawn straight from their seeded table each frame, one
// instanced quad apiece, with the site's own numbers throughout:
//
//   the sky      9000 unit-square points from the LCG seeded 20260904 (x, y,
//                mag, tint, ph, drawn in that order), the first
//                round(css area / 3200) of them shown
//   a star       bright = (1 - mag)^3; alpha 0.12 + 0.75 bright; radius
//                0.5 + 0.9 bright css px; tint cool (200, 215, 255) under
//                0.15, warm (255, 226, 190) over 0.9, else (255, 250, 240);
//                over 0.45 bright, a bloom under the dot: a radial gradient
//                from 0.4 alpha at the centre to nothing at 3 radii
//   the drift    2.3 css px a second, wrapped across the screen's width
//   the twinkle  ph >= 0.5 is the steady sky; ph < 0.5 splits into three
//                groups by floor(ph * 6), each breathing 55% to 100% on its
//                own slow clock (rates 0.37, 0.53, 0.71; phases 0, 2.1, 4.2)
//   the wash     every layer at 0.75 * (1 - 0.675 * p^1.5), p the spectrum
//                position: the Atmosphere setting (S.sunAtmo, 0.25 by
//                default, the site's own resting place)
//   the hole     where the sun's disk sits, a soft radial hole from 0.74 to
//                0.86 of the sun tile's half side, so no star ever reads as
//                in front of it; centred on, and sized with, the sun as
//                gpu/sun.js draws it (its disk), as deep as its Opacity, and
//                gone while no sun picture is drawn
//
// Each pixel is rendered as the site's canvas does it: the bloom's gradient
// at the pixel centre times the bloom circle's coverage, the dot's coverage
// over it (source-over), the whole times the layer's alpha, then the hole
// taken out (destination-out). Coverage is a 4 x 4 grid of samples across
// the pixel, the canvas's antialiasing near enough at these sizes.
//
// The site screens the sun over the sky (mix-blend-mode: screen), so the
// video's black lets the stars through and the disk outshines them. Here the
// stars draw just after the sun in the scene pass with that same screen
// (src * (1 - dst) + dst), which is the same picture either way round: the
// stars sit behind the sun and every layer drawn after it sits over them.
//
// The drift and the twinkle run on the motion clock (core/motion.js), as
// the sun's own video and breath do: a paused scene coasts them to a stop
// and holds the sky, so the still frame can rest.
//
// Allocation per frame: none.

import { S } from '../js/state.js';
import { motionStep } from '../core/motion.js';

// The site's constants (main.js `stars`).
const SEED = 20260904;
const N = 9000;                    // unit-square points, made once
const DENSITY = 1 / 3200;          // stars per css px² of sky
const DRIFT_PX_PER_S = 2.3;        // css px per second, right to left
// The twinkling groups: incommensurate periods (~17 s, ~12 s, ~9 s) so the
// sky shimmers here and there rather than pulsing as one.
const SHIMMER_RATE = [0.37, 0.53, 0.71];
const SHIMMER_PHASE = [0.0, 2.1, 4.2];
// The hole's soft band, in the sun tile's half sides (the photosphere's limb
// sits at 0.775).
const HOLE_IN = 0.74, HOLE_OUT = 0.86;
// Per star: x, y (unit), alpha, radius (css px); r, g, b, kind (its group
// 0 to 3, plus 4 when it blooms).
const INST_FLOATS = 8;

const STARS_WGSL = /* wgsl */`
struct SU {
  view: vec4f,  // width, height (device px), dpr, the drift's offset (device px)
  layer: vec4f, // the alpha of the steady sky and of the three twinkling groups
  hole: vec4f,  // the sun's centre x, y (device px), the hole's inner and outer radius (device px)
  depth: vec4f, // the hole's depth (0 none), unused x3
};
@group(0) @binding(0) var<uniform> u: SU;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) centre: vec2f,
  @location(1) @interpolate(flat) look: vec4f,  // alpha, radius (device px), blooms (0 or 1), layer alpha
  @location(2) @interpolate(flat) hue: vec3f,
};

// Two quads per star: the star where the drift has wrapped it, and its twin
// one screen width over, so a star crossing the edge leaves on one side as
// it arrives on the other (the site's tile pair and its wrap-painted edges).
@vertex
fn vsStar(@builtin(vertex_index) vi: u32, @location(0) a0: vec4f, @location(1) a1: vec4f) -> VOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let k = u32(a1.w + 0.5);
  let bloom = f32((k >> 2u) & 1u);
  let rad = a0.w * u.view.z;
  let ext = select(rad, rad * 3.0, bloom > 0.5) + 1.0;
  let w = u.view.x;
  var x = a0.x * w - u.view.w;
  x = x - w * floor(x / w);
  if ((vi / 6u) == 1u) { x = x + select(-w, w, x < 0.5 * w); }
  let c = vec2f(x, a0.y * u.view.y);
  let px = c + corners[vi % 6u] * ext;
  var o: VOut;
  o.pos = vec4f(px.x / w * 2.0 - 1.0, 1.0 - px.y / u.view.y * 2.0, 0.0, 1.0);
  o.centre = c;
  o.look = vec4f(a0.z, rad, bloom, u.layer[k & 3u]);
  o.hue = a1.xyz;
  return o;
}

@fragment
fn fsStar(v: VOut) -> @location(0) vec4f {
  let rad = v.look.y;
  let rb = rad * 3.0;
  let d0 = v.pos.xy - v.centre;
  var dotCov = 0.0;
  var bloomCov = 0.0;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let d = length(d0 + (vec2f(f32(i), f32(j)) - vec2f(1.5)) * 0.25);
      dotCov += select(0.0, 1.0, d <= rad);
      bloomCov += select(0.0, 1.0, d <= rb);
    }
  }
  let aDot = v.look.x * dotCov / 16.0;
  var a = aDot;
  if (v.look.z > 0.5) {
    let g = v.look.x * 0.4 * max(0.0, 1.0 - length(d0) / rb) * bloomCov / 16.0;
    a = aDot + g * (1.0 - aDot);
  }
  a = a * v.look.w;
  // The disk's hole (a uniform branch).
  if (u.depth.x > 0.0) {
    let r = length(v.pos.xy - u.hole.xy);
    let h = clamp((u.hole.w - r) / (u.hole.w - u.hole.z), 0.0, 1.0);
    a = a * (1.0 - h * u.depth.x);
  }
  return vec4f(v.hue * a, 0.0);
}
`;

function clampNum(v, lo, hi, def) {
  if (typeof v !== 'number' || !(v === v)) return def;
  return v < lo ? lo : (v > hi ? hi : v);
}

// The site's sky, star by star: the same LCG, the same draws in the same
// order, so the same sky.
function buildSky() {
  const out = new Float32Array(N * INST_FLOATS);
  let seed = SEED;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < N; i++) {
    const x = rnd(), y = rnd(), mag = rnd(), tint = rnd(), ph = rnd();
    // most stars are faint pinpricks; a few are brighter with a soft bloom
    const bright = Math.pow(1 - mag, 3);
    const b = i * INST_FLOATS;
    out[b] = x; out[b + 1] = y;
    out[b + 2] = 0.12 + bright * 0.75;
    out[b + 3] = 0.5 + bright * 0.9;
    const hue = tint < 0.15 ? [200, 215, 255] : tint > 0.9 ? [255, 226, 190] : [255, 250, 240];
    out[b + 4] = hue[0] / 255; out[b + 5] = hue[1] / 255; out[b + 6] = hue[2] / 255;
    // ph < 0.5 twinkles; which group a star joins is fixed by its phase
    const group = ph >= 0.5 ? 0 : 1 + Math.floor(ph * 2 * SHIMMER_RATE.length);
    out[b + 7] = group + (bright > 0.45 ? 4 : 0);
  }
  return out;
}

// sun is gpu/sun.js's layer, read for where its disk sits (sun.disk).
export function createStars(device, format, sun) {
  let pipe = null, uniBuf = null, instBuf = null, bind = null;
  const uni = new Float32Array(16);
  function ensureGpu() {
    if (pipe) return;
    const mod = device.createShaderModule({ label: 'stars.wgsl', code: STARS_WGSL });
    if (mod.getCompilationInfo) {
      mod.getCompilationInfo().then(info => {
        if (info.messages.some(m => m.type === 'error')) {
          console.warn('stars.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
        }
      });
    }
    const bgl = device.createBindGroupLayout({
      label: 'stars.bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
    });
    // Screen, the site's mix-blend-mode: the stars' premultiplied light
    // times what is left below 1, onto what is there; alpha left alone.
    const screen = {
      color: { srcFactor: 'one-minus-dst', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    };
    pipe = device.createRenderPipeline({
      label: 'stars.sky',
      layout: device.createPipelineLayout({ label: 'stars.layout', bindGroupLayouts: [bgl] }),
      vertex: {
        module: mod, entryPoint: 'vsStar',
        buffers: [{
          arrayStride: INST_FLOATS * 4, stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' }
          ]
        }]
      },
      fragment: { module: mod, entryPoint: 'fsStar', targets: [{ format, blend: screen }] },
      primitive: { topology: 'triangle-list' }
    });
    const sky = buildSky();
    instBuf = device.createBuffer({
      label: 'stars.sky', size: sky.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(instBuf, 0, sky);
    uniBuf = device.createBuffer({
      label: 'stars.uniforms', size: uni.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    bind = device.createBindGroup({
      label: 'stars.bind', layout: bgl,
      entries: [{ binding: 0, resource: { buffer: uniBuf } }]
    });
  }

  let pixelW = 1, pixelH = 1, dpr = 1;
  // The sky's own clock (seconds), stepped by the motion step; how many
  // stars this screen shows; whether they draw this frame.
  let clockS = 0, count = 0, drawing = false;

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
    dpr = d || 1;
  }

  // dt is seconds. Called after the sun's update, so its disk is this
  // frame's.
  function update(t, dt) {
    drawing = false;
    if (S.sunStars === false) return;
    ensureGpu();
    if (dt > 0) clockS += motionStep(dt);
    const W = pixelW, H = pixelH;
    count = Math.min(N, Math.round((W / dpr) * (H / dpr) * DENSITY));
    // offset grows with time; the sky scrolls left and its twin follows
    const off = (clockS * DRIFT_PX_PER_S * dpr) % W;
    // a brighter sun washes out the sky: the stars peak at 75% at the dim
    // end of the spectrum and fall to about a third of that at the bright end
    const p = clampNum(S.sunAtmo, 0, 1, 0.25);
    const wash = 0.75 * (1 - 0.675 * Math.pow(p, 1.5));
    uni[0] = W; uni[1] = H; uni[2] = dpr; uni[3] = off;
    uni[4] = wash;
    // slow shimmer: each group drifts between 55% and 100% on its own clock
    for (let k = 0; k < 3; k++) uni[5 + k] = wash * (0.775 + 0.225 * Math.sin(clockS * SHIMMER_RATE[k] + SHIMMER_PHASE[k]));
    const disk = sun ? sun.disk : null;
    const depth = disk ? disk[3] : 0;
    uni[8] = depth > 0 ? disk[0] : 0;
    uni[9] = depth > 0 ? disk[1] : 0;
    uni[10] = depth > 0 ? disk[2] * HOLE_IN : 0;
    uni[11] = depth > 0 ? disk[2] * HOLE_OUT : 1;
    uni[12] = depth;
    device.queue.writeBuffer(uniBuf, 0, uni);
    drawing = count > 0;
  }

  // Inside the scene pass, straight after the sun.
  function draw(pass) {
    if (!drawing) return;
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, instBuf);
    pass.draw(12, count);
  }

  return { update, draw, resize };
}
