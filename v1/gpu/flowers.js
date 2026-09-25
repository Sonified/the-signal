// Owns the flower layer: an opal lotus that blooms and closes, drawn one of
// two ways into the scene pass after the field and rings and before the edge
// particles. 'tunnel' flies rings of flowers out of the vanishing point the
// way the tunnel rings travel; 'mandala' folds the same flower into an N-fold
// kaleidoscope that zooms outward forever. Both read S every frame and do no
// work at all while S.layers.flowers is off.
//
// The sprite sheet is loaded lazily, the first time the layer is switched
// on, and nothing is drawn until the atlas is ready. The sheet on disk is a
// 4 x 4 grid of 16 bloom frames with a non-integer cell size, and it carries
// tens of thousands of nearly invisible red and yellow speckles around the
// flowers. One speckle at 5% is nothing; the same speckle in four hundred
// flowers, or folded into every wedge of a mandala, is a red haze. So the
// sheet is cleaned on the way in (anything under ALPHA_CUT goes fully
// transparent), premultiplied, repacked into whole 320 px cells, and given
// a proper mip chain, because the flowers are mostly drawn small and moving
// and an unfiltered minified sprite shimmers.
//
// Per frame the CPU side writes one small uniform block and, in tunnel mode,
// at most MAX_INST instances into a buffer allocated once. No allocation in
// update() or draw().

import { S, Z_NEAR, Z_FAR } from '../../js/state.js';
import { FLOWERS_WGSL, MIP_WGSL } from './flowers.wgsl.js';
import { radialFade } from '../core/fade.js';

// Relative to the page base (v1/index.html sets <base href="../">), so this
// resolves from the repo root.
const SHEET_URL = 'assets/sprites/celestial-v1/source/lotus-bloom.png';
const GRID = 4;                     // the sheet and the atlas are both 4 x 4
const FRAMES = GRID * GRID;
const CELL = 320;                   // atlas cell, a little over the sheet's 313.5
const ATLAS = CELL * GRID;          // 1280
// 1280 down to 20: the last level whose cells are still whole texels (5 px),
// so the box filter never mixes two frames. See flowers.wgsl.js's MIP_WGSL.
const MIP_LEVELS = 7;
const ALPHA_CUT = 48;

const MAX_RINGS = 12, MAX_COUNT = 36;
const MAX_INST = MAX_RINGS * MAX_COUNT;
const INST_FLOATS = 8;              // cx cy half alpha | upX upY framesAB blend
const UNIFORM_FLOATS = 24;          // see flowers.wgsl.js's struct FU

const TAU = Math.PI * 2;
const BASE_FPS = 8;                 // the manifest's playback rate
const SEQ_STEPS = 32;               // 0..15 then 15..0
// Seconds for one ring of flowers to travel from the vanishing point to the
// rim at flowerSpeed 1. The tunnel rings' median crossing is longer, but most
// of theirs is spent too small to see; this is about the visible part.
const CROSS_SECONDS = 12;
// How far down the depth range the rings accelerate. Pure log spacing (1.0)
// is a steady, self-similar zoom; the tunnel rings' 1/z growth crawls while
// far and rushes past at the end. 0.8 keeps most of the evenness, which is
// what lets every ring stay readable, with a little of that final rush.
const DEPTH_EASE = 0.8;
const TUNNEL_RIPPLE_STEPS = 32;     // ripple 1: one whole open and close across the depth
const MANDALA_RIPPLE_STEPS = 6;     // ripple 1: six steps of bloom between neighbouring tiles
const MANDALA_ZOOM_RATE = 0.09;     // tiles per second at flowerSpeed 1

function clampNum(v, lo, hi, def) {
  if (typeof v !== 'number' || !(v === v)) return def;
  return v < lo ? lo : (v > hi ? hi : v);
}
function smoothstep(a, b, x) {
  const t = x <= a ? 0 : (x >= b ? 1 : (x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
// The manifest's sourceFrameSequence as arithmetic: 0..15, then 15..0.
function seqFrame(n) {
  const m = ((n % SEQ_STEPS) + SEQ_STEPS) % SEQ_STEPS;
  return m < 16 ? m : 31 - m;
}

export function createFlowers(device, format, platform) {
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const mod = device.createShaderModule({ code: FLOWERS_WGSL });
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn('flowers.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }

  // Premultiplied over: the flowers sit on the field rather than adding
  // light to it, so a full bloom reads as a solid opal object, not a glow.
  const over = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
  };

  const pipeTunnel = device.createRenderPipeline({
    layout,
    vertex: {
      module: mod, entryPoint: 'vsTunnel',
      buffers: [{
        arrayStride: INST_FLOATS * 4, stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' }
        ]
      }]
    },
    fragment: { module: mod, entryPoint: 'fsTunnel', targets: [{ format, blend: over }] },
    primitive: { topology: 'triangle-list' }
  });
  const pipeMandala = device.createRenderPipeline({
    layout,
    vertex: { module: mod, entryPoint: 'vsFull' },
    fragment: { module: mod, entryPoint: 'fsMandala', targets: [{ format, blend: over }] },
    primitive: { topology: 'triangle-list' }
  });

  const uniBuf = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const instBuf = device.createBuffer({ size: MAX_INST * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const uni = new Float32Array(UNIFORM_FLOATS);
  const inst = new Float32Array(MAX_INST * INST_FLOATS);
  // Trilinear, so a flower shrinking toward the vanishing point slides
  // smoothly down the mip chain instead of stepping between levels.
  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    lodMaxClamp: MIP_LEVELS - 1
  });

  let bind = null;                 // set once the atlas exists
  let requested = false, ready = false;
  let pixelW = 1, pixelH = 1, dpr = 1;

  // The layer's own clocks. They advance only while the strobe runs, as the
  // rings do, so a stopped scene is a still one, and each is accumulated
  // from dt rather than computed from t times a rate, so moving a speed
  // slider changes the pace from here on instead of jumping to wherever the
  // new rate says the pattern would have been.
  let flow = 0;                    // tunnel: rings travelled, in ring spacings
  let spin = 0;                    // rotation, radians, kept within one turn
  let bloom = 0;                   // position in the 32-step bloom sequence
  let zoomWhole = 0, zoomFrac = 0; // mandala: tiles zoomed, split to keep float32 precise
  let breath = 0;                  // mandala: slow size breathing phase

  let mode = 0;                    // 0 tunnel, 1 mandala
  let instCount = 0;
  let active = false;

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
    dpr = d || 1;
  }

  // ---------- loading ----------
  // Decoding goes through the platform (the one place allowed to touch
  // fetch and canvases); the cleanup yields between frames of the sheet so
  // the million-odd pixel loop never lands as one long stall mid-strobe.
  function load() {
    requested = true;
    if (!platform || !platform.loadImagePixels) {
      console.warn('flowers: the platform has no loadImagePixels; the layer stays empty');
      return;
    }
    platform.loadImagePixels(SHEET_URL)
      .then(buildAtlas)
      .catch(err => { console.warn('flowers: could not load the lotus sheet:', err && err.message ? err.message : err); });
  }

  async function buildAtlas(img) {
    const w = img.width, h = img.height, src = img.data;
    const out = new Uint8Array(ATLAS * ATLAS * 4);
    const cw = w / GRID, ch = h / GRID;
    for (let f = 0; f < FRAMES; f++) {
      const col = f % GRID, row = (f / GRID) | 0;
      // The sheet's cells are 313.5 px, so each one is cut with floor and
      // ceil of its own edges; the half-pixel overlap between neighbours
      // lands on transparent border either way.
      const sx0 = Math.floor(col * cw), sx1 = Math.min(w, Math.ceil((col + 1) * cw));
      const sy0 = Math.floor(row * ch), sy1 = Math.min(h, Math.ceil((row + 1) * ch));
      const cwid = Math.min(CELL, sx1 - sx0), chei = Math.min(CELL, sy1 - sy0);
      const dx0 = col * CELL + ((CELL - cwid) >> 1);
      const dy0 = row * CELL + ((CELL - chei) >> 1);
      for (let y = 0; y < chei; y++) {
        let si = ((sy0 + y) * w + sx0) * 4;
        let di = ((dy0 + y) * ATLAS + dx0) * 4;
        for (let x = 0; x < cwid; x++, si += 4, di += 4) {
          const a = src[si + 3];
          if (a < ALPHA_CUT) continue;          // speckle: leave it transparent
          const k = a / 255;
          out[di] = Math.round(src[si] * k);
          out[di + 1] = Math.round(src[si + 1] * k);
          out[di + 2] = Math.round(src[si + 2] * k);
          out[di + 3] = a;
        }
      }
      await new Promise(r => setTimeout(r, 0));
    }

    const tex = device.createTexture({
      size: { width: ATLAS, height: ATLAS },
      format: 'rgba8unorm',
      mipLevelCount: MIP_LEVELS,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    device.queue.writeTexture({ texture: tex }, out, { bytesPerRow: ATLAS * 4, rowsPerImage: ATLAS },
                              { width: ATLAS, height: ATLAS });
    buildMips(tex);

    bind = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: sampler }
      ]
    });
    ready = true;
  }

  // One small render pass per level, each reading the level above it. A
  // level can be sampled and rendered in the same encoder because they are
  // different subresources of the one texture.
  function buildMips(tex) {
    const mipMod = device.createShaderModule({ label: 'flowers.mip', code: MIP_WGSL });
    const pipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mipMod, entryPoint: 'vs' },
      fragment: { module: mipMod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' }
    });
    const enc = device.createCommandEncoder();
    for (let l = 1; l < MIP_LEVELS; l++) {
      const srcView = tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 });
      const dstView = tex.createView({ baseMipLevel: l, mipLevelCount: 1 });
      const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcView }] });
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: dstView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
      });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([enc.finish()]);
  }

  // ---------- per frame ----------
  // t is the rAF timestamp (ms), dt seconds, lum this frame's strobe level.
  function update(t, dt, lum) {
    active = false;
    const lyr = S.layers;
    if (!lyr || !lyr.flowers) return;
    if (!requested) load();
    if (!ready) return;

    const speed = clampNum(S.flowerSpeed, 0, 3, 1);
    const bloomRate = clampNum(S.flowerBloomRate, 0, 4, 1);
    const spinRate = clampNum(S.flowerSpin, -2, 2, 0.12);
    const count = Math.round(clampNum(S.flowerCount, 3, MAX_COUNT, 12));
    const rings = Math.round(clampNum(S.flowerRings, 1, MAX_RINGS, 6));
    const size = clampNum(S.flowerSize, 0.2, 3, 1);
    const spiral = clampNum(S.flowerSpiral, 0, 1, 0.38);
    const ripple = clampNum(S.flowerRipple, 0, 1, 0.6);
    const opacity = clampNum(S.flowerOpacity, 0, 1, 0.85);
    const fade = clampNum(S.flowerFade, 0, 1, 0.55);
    const tintAmt = clampNum(S.flowerTint, 0, 1, 0);
    const pulse = clampNum(S.flowerPulse, 0, 1, 0);
    mode = S.flowerMode === 'mandala' ? 1 : 0;

    if (S.running && dt > 0) {
      flow += dt * speed * rings / CROSS_SECONDS;
      spin = (spin + dt * spinRate) % TAU;
      bloom = (bloom + dt * BASE_FPS * bloomRate) % SEQ_STEPS;
      zoomFrac += dt * speed * MANDALA_ZOOM_RATE;
      if (zoomFrac >= 1) { const wz = Math.floor(zoomFrac); zoomWhole += wz; zoomFrac -= wz; }
      breath = (breath + dt * 0.45) % TAU;
    }

    // Pulse 0 keeps the layer at steady brightness whatever the strobe does
    // (the photosensitive-safe default); 1 lets it follow lum all the way.
    const l = lum > 0 ? (lum < 1 ? lum : 1) : 0;
    const gain = opacity * (1 - pulse + pulse * l);
    if (gain < 0.002) return;

    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    // Composed inside the area the drawer leaves visible, like the rings,
    // so opening the panel recentres the flowers too.
    const visW = Math.max(1, cssW - inset);
    const cx = (inset + visW * 0.5) * dpr, cy = cssH * 0.5 * dpr;
    // The ring layer's rim (gpu/scene-data.js), so k = r / maxR means the
    // same place on screen for the rings and both flower modes.
    const maxR = Math.hypot(visW, cssH) * 0.62;

    const rgb = S.rgb;
    const peak = Math.max(rgb[0], rgb[1], rgb[2], 1);
    uni[0] = pixelW; uni[1] = pixelH; uni[2] = 1 / pixelW; uni[3] = 1 / pixelH;
    uni[4] = rgb[0] / peak; uni[5] = rgb[1] / peak; uni[6] = rgb[2] / peak; uni[7] = tintAmt;
    uni[8] = gain; uni[9] = inset * dpr; uni[10] = fade; uni[11] = maxR * dpr;

    if (mode === 1) {
      const halfW = Math.PI / count;
      uni[12] = cx; uni[13] = cy; uni[14] = Math.hypot(visW, cssH) * 0.5 * dpr; uni[15] = count;
      // Folding the integer part of the zoom into the bloom position keeps
      // the shader's tile numbers small without changing any tile's bloom.
      const rs = ripple * MANDALA_RIPPLE_STEPS;
      uni[16] = spin; uni[17] = zoomFrac;
      uni[18] = ((bloom + zoomWhole * rs) % SEQ_STEPS + SEQ_STEPS) % SEQ_STEPS; uni[19] = rs;
      uni[20] = size * (1 + 0.05 * Math.sin(breath));
      uni[21] = spiral * 0.5;
      // The petal fan each wedge holds: wide when there are few wedges,
      // narrower as they multiply so the flower is not squeezed to threads.
      uni[22] = Math.min(1.25, Math.max(0.35, halfW * 3));
      uni[23] = 0;
      instCount = 0;
    } else {
      uni[12] = cx; uni[13] = cy; uni[14] = 1; uni[15] = count;
      for (let i = 16; i < 24; i++) uni[i] = 0;
      instCount = buildTunnel(count, rings, size, spiral, ripple, gain, fade, cx, cy, maxR);
      if (instCount) device.queue.writeBuffer(instBuf, 0, inst, 0, instCount * INST_FLOATS);
    }
    device.queue.writeBuffer(uniBuf, 0, uni);
    active = mode === 1 || instCount > 0;
  }

  // Rings of flowers in flight. Ring g (an integer that counts births) sits
  // at depth fraction s = (flow - g) / rings, so every ring keeps its own
  // identity from birth to rim: its golden twist and its spin direction never
  // change mid-flight, and a new one appears at the vanishing point exactly
  // as the oldest leaves the rim. Drawn innermost first so nearer, larger
  // flowers overlap the ones behind them.
  function buildTunnel(count, rings, size, spiral, ripple, gain, fade, cx, cy, maxR) {
    const slot = TAU / count;
    // Flowers roughly fill their share of the circle, so any count reads as
    // one wreath; a few flowers are capped rather than swamping the centre.
    const sideK = Math.min(slot * 1.05, 1.1) * size;
    const base = Math.floor(flow), frac = flow - base;
    const depthRatio = Z_NEAR / Z_FAR;
    const w = pixelW, h = pixelH;
    let n = 0;
    for (let i = 0; i < rings; i++) {
      const s = (frac + i) / rings;
      const g = base - i;
      // rho is 1 at the vanishing point and 0 at the rim. k = Z_NEAR / z is
      // the ring layer's own perspective ratio (r = FOCAL / z with FOCAL =
      // maxR * Z_NEAR), here with z spaced in log depth; see DEPTH_EASE.
      const rho = Math.pow(1 - s, DEPTH_EASE);
      const k = Math.pow(depthRatio, rho);
      // The rings' own fade (core/fade.js): an ease in from the centre set
      // by the Fade in slider, then a fixed fade out toward the rim. k here
      // is r / maxR against the rings' rim, so it is the rings' k exactly.
      const alpha = radialFade(fade, k) * gain;
      if (alpha < 0.003) continue;

      const r = maxR * k * dpr;
      const half = r * sideK * 0.5;
      if (half < 0.35) continue;

      // Every ring turns the way the Spin slider points: positive (slider to
      // the right) is clockwise on screen, since y grows downward here. The
      // twist advances each new ring by a fraction of a slot (0.38 is close
      // to the golden fraction, so the flowers of successive rings never
      // line up and trace spiral arms).
      const ang0 = (((g * spiral) % 1) * slot) + spin - Math.PI * 0.5;

      // Buds open as they approach: the time-driven bloom plus a phase that
      // leads toward the centre, so each wave of opening travels outward,
      // all scaled by an envelope that keeps the newborn ones mostly closed.
      const pos = bloom + rho * ripple * TUNNEL_RIPPLE_STEPS;
      const pn = Math.floor(pos);
      const pa = seqFrame(pn), pb = seqFrame(pn + 1);
      const env = 0.3 + 0.7 * smoothstep(0.03, 0.3, k);
      const F = (pa + (pb - pa) * (pos - pn)) * env;
      const fa = Math.floor(F), fb = fa < 15 ? fa + 1 : 15;
      const framesAB = fa + fb * 16, blend = F - fa;

      for (let j = 0; j < count; j++) {
        const th = ang0 + j * slot;
        const ux = Math.cos(th), uy = Math.sin(th);
        const px = cx + ux * r, py = cy + uy * r;
        const reach = half * 1.4143;
        if (px + reach < 0 || px - reach > w || py + reach < 0 || py - reach > h) continue;
        const o = n * INST_FLOATS;
        inst[o] = px; inst[o + 1] = py; inst[o + 2] = half; inst[o + 3] = alpha;
        inst[o + 4] = ux; inst[o + 5] = uy; inst[o + 6] = framesAB; inst[o + 7] = blend;
        n++;
      }
    }
    return n;
  }

  function draw(pass) {
    if (!active || !bind) return;
    pass.setBindGroup(0, bind);
    if (mode === 1) {
      pass.setPipeline(pipeMandala);
      pass.draw(3);
    } else {
      pass.setPipeline(pipeTunnel);
      pass.setVertexBuffer(0, instBuf);
      pass.draw(6, instCount);
    }
  }

  return { update, draw, resize };
}
