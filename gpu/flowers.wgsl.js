// WGSL for the flower layer: the two looks flowers.js can draw (an
// instanced ring of lotus sprites flying out of the tunnel, and a fullscreen
// kaleidoscope folded from the same sprite), plus the tiny downsample pass
// that builds the atlas's mip chain once at load.
//
// Every colour in the atlas is premultiplied (flowers.js does that while it
// cleans the sheet), and every output here is premultiplied too, so the
// pipeline blends with one / one-minus-src-alpha and a mix between two
// frames or two layers is simply a weighted sum of what was sampled.

import { RADIAL_FADE_WGSL } from '../core/fade.js';

export const FLOWERS_WGSL = `
struct FU {
  res: vec4f,     // Wd, Hd, 1/Wd, 1/Hd (device px)
  tint: vec4f,    // strobe colour scaled so its brightest channel is 1, tint amount
  layer: vec4f,   // layer gain (opacity times pulse), left inset px, fade in amount, ring rim radius px
  mc: vec4f,      // mandala centre xy px, radius px (half the visible diagonal), fold count
  m2: vec4f,      // rotation, zoom (fractional tiles), bloom sequence position, ripple steps per tile
  m3: vec4f,      // size, spiral twist per log unit of radius, fan half-angle, unused
};
@group(0) @binding(0) var<uniform> u: FU;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const TAU = 6.283185307;
// The mandala tiles radius in log space: every factor of three outward the
// pattern repeats at three times the size, which is what lets it zoom
// forever without ever reaching an edge.
const LOG_PERIOD = 1.0986123;
// Where the petal fans start inside a frame's cell (the base of the lotus, a
// little above the bottom of the flower) and how long the middle ray is.
const FAN_ORIGIN = vec2f(0.5, 0.80);
const FAN_BASE = 0.36;
const CELL_TEXELS = 320.0;
const MAX_LOD = 6.0;
${RADIAL_FADE_WGSL}

// Frame f of the 4 x 4 atlas, local 0..1 inside its cell.
fn cellUV(f: u32, local: vec2f) -> vec2f {
  return (vec2f(f32(f & 3u), f32(f >> 2u)) + local) * 0.25;
}

// Tint multiplies toward the strobe colour rather than replacing it, so the
// opal's own shading and the gold rims survive at any amount.
fn tintRGB(c: vec3f) -> vec3f {
  return mix(c, c * u.tint.rgb, u.tint.w);
}

// ---- bloom tunnel ----
// One instance per flower: centre, half size, alpha; the outward radial unit
// vector (the flower's "up", so petals always face away from the centre);
// the two atlas frames to cross-fade (packed a + 16 b) and the mix between
// them. Corners come from vertex_index, as the scene's head caps do.

struct TOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) frames: vec2u,
  @location(2) blend: f32,
  @location(3) alpha: f32,
};

@vertex
fn vsTunnel(@builtin(vertex_index) vi: u32,
            @location(0) cxyHalfAlpha: vec4f,
            @location(1) upFramesBlend: vec4f) -> TOut {
  var ks = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let k = ks[vi];
  let sx = select(-1.0, 1.0, (k & 1u) == 1u);
  let sy = select(-1.0, 1.0, (k & 2u) == 2u);
  let up = upFramesBlend.xy;
  let across = vec2f(-up.y, up.x);
  // Image y runs down the flower, from petal tips to base, so +sy steps
  // toward the centre of the field. This is a pure rotation: never mirrored.
  let wp = cxyHalfAlpha.xy + (across * sx - up * sy) * cxyHalfAlpha.z;
  var o: TOut;
  o.pos = vec4f(wp.x * u.res.z * 2.0 - 1.0, 1.0 - wp.y * u.res.w * 2.0, 0.0, 1.0);
  o.uv = vec2f(sx, sy) * 0.5 + 0.5;
  let fab = u32(upFramesBlend.z + 0.5);
  o.frames = vec2u(fab & 15u, (fab >> 4u) & 15u);
  o.blend = upFramesBlend.w;
  o.alpha = cxyHalfAlpha.w;
  return o;
}

@fragment
fn fsTunnel(o: TOut) -> @location(0) vec4f {
  let ca = textureSample(atlas, samp, cellUV(o.frames.x, o.uv));
  let cb = textureSample(atlas, samp, cellUV(o.frames.y, o.uv));
  let c = mix(ca, cb, o.blend);
  return vec4f(tintRGB(c.rgb), c.a) * o.alpha;
}

// ---- mandala ----
// A fullscreen fold. The angle around the field centre is folded into one
// wedge of the N-fold pattern and mirrored at its edges; inside the wedge the
// angle is stretched back out into a fan of rays through a lotus frame, from
// the base of the flower up through its petals. Radius is tiled in log space
// and flows outward with time, and two copies half a tile apart cross-fade on
// triangle weights that sum to one, so the tile seams never show and the
// field always holds two scales of flower at once, which is where the depth
// comes from.

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

// The manifest's 32-step ping-pong (0..15 then 15..0, each end held one
// step) as a continuous frame number.
fn seqFrame(n: f32) -> f32 {
  let m = n - 32.0 * floor(n / 32.0);
  return select(31.0 - m, m, m < 16.0);
}

fn sampleBloom(q: vec2f, pos: f32, lod: f32) -> vec4f {
  // Rays that leave the cell would read the neighbouring frame; the cell's
  // own border is transparent, so outside simply means nothing here.
  if (any(q < vec2f(0.0)) || any(q > vec2f(1.0))) {
    return vec4f(0.0);
  }
  let n = floor(pos);
  let F = mix(seqFrame(n), seqFrame(n + 1.0), pos - n);
  let a = floor(F);
  let b = min(a + 1.0, 15.0);
  let ca = textureSampleLevel(atlas, samp, cellUV(u32(a), q), lod);
  let cb = textureSampleLevel(atlas, samp, cellUV(u32(b), q), lod);
  return mix(ca, cb, F - a);
}

@fragment
fn fsMandala(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  if (fc.x < u.layer.y) {
    return vec4f(0.0);
  }
  let p = fc.xy - u.mc.xy;
  let rpx = max(length(p), 0.5);
  let rn = rpx / u.mc.z;

  // A soft vignette toward the corners of the visible field, and a small
  // quiet zone at the very centre where the tiles shrink below a pixel. On
  // top of those, the tunnel rings' radial fade, measured against the rings'
  // own rim (u.layer.w) so the Fade in slider eases the mandala in from the
  // centre exactly as it does the rings and the tunnel flowers. Worked out
  // first: every sample below is premultiplied and at most 1, so where this
  // is under a quarter of an 8-bit step the pixel cannot change, and the
  // four atlas reads are skipped (the faded centre, the corners, and the
  // whole field at a low opacity).
  let vig = 1.0 - smoothstep(0.45, 1.0, rn);
  let heart = smoothstep(0.0, 0.035, rn);
  let fade = radialFade(u.layer.z, rpx / u.layer.w);
  let gain = u.layer.x * vig * heart * fade;
  if (gain < 0.00098) {
    return vec4f(0.0);
  }

  let halfW = TAU / u.mc.w * 0.5;
  let spread = u.m3.z;
  let lr = log(rpx / (u.mc.z * u.m3.x));

  // The twist turns concentric tiles into a log spiral: each e-fold outward
  // is rotated a little further, which the fold then mirrors into arms.
  // Spin is subtracted: sampling the pattern at (angle - spin) turns the
  // image by +spin, clockwise on screen (y down), matching the tunnel mode
  // and the slider (right = clockwise, left = counter-clockwise).
  let ang = atan2(p.y, p.x) - u.m2.x + u.m3.y * lr;
  let wedge = halfW * 2.0;
  let am = ang - wedge * floor(ang / wedge);
  let phi = abs(am - halfW) / halfW * spread;
  let dir = vec2f(sin(phi), -cos(phi));

  // Mip level from the mapping's own scale, not from screen derivatives:
  // the fold and the tile wrap are both discontinuous, and implicit
  // derivatives across them would pick a wildly wrong level along every seam.
  // A step of one pixel moves rr / rpx along a ray and that much times the
  // angular stretch across one.
  let stretch = max(1.0, spread / halfW);

  var acc = vec4f(0.0);
  for (var i = 0; i < 2; i++) {
    let off = 0.5 * f32(i);
    let x = lr / LOG_PERIOD - u.m2.y + off;
    let k = floor(x);
    let fu = x - k;
    let w = 1.0 - abs(2.0 * fu - 1.0);
    let rr = FAN_BASE * exp((fu - 0.5) * LOG_PERIOD);
    let q = FAN_ORIGIN + dir * rr;
    let lod = clamp(log2(max(rr / rpx * stretch * CELL_TEXELS, 1e-4)), 0.0, MAX_LOD);
    // Each tile carries its own place in the bloom, lagging the one inside
    // it by the ripple, so opening travels outward with the zoom. The second
    // copy sits half a tile out and so half a ripple behind.
    let pos = u.m2.z - (k - off) * u.m2.w;
    acc = acc + sampleBloom(q, pos, lod) * w;
  }

  return vec4f(tintRGB(acc.rgb), acc.a) * gain;
}
`;

// Box-filter downsample of one mip level into the next. The atlas's 320 px
// cells halve cleanly six times (to 5 px), so a 2 x 2 box never straddles two
// frames and no frame ever bleeds into its neighbour. Premultiplied texels
// average correctly as they are.
export const MIP_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let d = vec2i(fc.xy) * 2;
  return (textureLoad(src, d, 0) + textureLoad(src, d + vec2i(1, 0), 0) +
          textureLoad(src, d + vec2i(0, 1), 0) + textureLoad(src, d + vec2i(1, 1), 0)) * 0.25;
}
`;
