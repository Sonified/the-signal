// =====================================================================
//  Shared GPU frame data
// =====================================================================
//
//  The canvas2d path spent its frame budget in raster/composite: a
//  full-screen 'lighter' blend of several large fills at DPR 2 is a lot of
//  fill-rate going through the 2d backend, and the periodic stalls that
//  produced were visible as stutter in the strobe.
//
//  The GPU port collapses three of the four layers into ONE full-screen
//  fragment shader. Field, rings and corners are all pure functions of the
//  pixel's position, so there is no geometry to rasterise at all -- and
//  because every layer shares a single colour, additive compositing is just
//  a scalar sum inside the shader, which costs nothing.
//
//  Rings deserve a note. They are concentric circles about the screen
//  centre, so the whole layer is a function of ONE variable: distance from
//  centre. Rather than loop 110 ring tests per pixel, the CPU rasterises the
//  rings into a 1D radial coverage profile (a few thousand floats, ~8 writes
//  per ring) and the shader does a single interpolated lookup. The ring
//  layer therefore costs the same whether one ring is alive or a hundred.
//
//  Edge particles are real geometry (they bend around the corners), so they
//  are instanced capsules: one instance per trail segment plus one for the
//  head dot, at most 60 * 23 = 1380 instances, drawn in the same render pass
//  with hardware additive blending.
// ---------------------------------------------------------------------

import { S, layers, LUT_N, MAX_EDGE_INST, Z_NEAR } from './state.js';
import { shape, smoothstep } from './util.js';
import { perimeterPoint, px, py } from './geometry.js';
import { cv } from './dom.js';

export const uniArr  = new Float32Array(24);     // 6 * vec4, 96 bytes
export const lutArr  = new Float32Array(LUT_N);
export const edgeArr = new Float32Array(MAX_EDGE_INST * 6);
export let edgeInst = 0;

// Fills uniArr / lutArr / edgeArr in place. Allocates nothing.
export function buildFrameData(lum) {
  const W = S.W, H = S.H, DPR = S.DPR, rgb = S.rgb;
  const Wd = cv.width, Hd = cv.height;
  const size = Math.min(W,H) * 0.62;
  const maxR = Math.hypot(W,H) * 0.62;
  const level = S.effBright * (1 - S.effDepth + S.effDepth*lum);

  uniArr[0] = Wd; uniArr[1] = Hd; uniArr[2] = 1/Wd; uniArr[3] = 1/Hd;
  uniArr[4] = rgb[0]/255; uniArr[5] = rgb[1]/255; uniArr[6] = rgb[2]/255;
  uniArr[7] = level;
  uniArr[8]  = S.fieldShape === 'full' ? 2 : (S.fieldShape === 'panel' ? 1 : 0);
  uniArr[9]  = size * 0.5 * DPR;          // disc radius / panel half-extent
  uniArr[10] = 18 * DPR;                  // panel corner radius
  uniArr[11] = (layers.field && level > 0.002) ? 1 : 0;
  for (let i = 0; i < 4; i++) uniArr[12+i] = shape((S.phase + i/4) % 1) * 0.5 * S.bright * S.effDepth;
  uniArr[16] = Math.min(W,H) * 0.46 * DPR;   // corner glow radius
  uniArr[17] = maxR * DPR;                   // outer radius of the ring LUT
  uniArr[18] = LUT_N;
  uniArr[19] = layers.rings ? 1 : 0;
  uniArr[20] = layers.corners ? 1 : 0;
  uniArr[21] = 0; uniArr[22] = 0; uniArr[23] = 0;

  // ---- ring layer -> 1D radial coverage profile ----
  if (layers.rings) {
    lutArr.fill(0);
    const rings = S.rings;
    const FOCAL = maxR * Z_NEAR;
    const step = (maxR * DPR) / LUT_N, inv = 1/step;
    for (let i = 0; i < rings.length; i++) {
      const r = FOCAL / rings[i].z;
      const k = r / maxR;
      if (k > 1) continue;
      // The exponent biases the ramp later as the slider rises, so at 100% rings
      // stay essentially invisible through the middle and only bloom near the rim.
      const fadeIn  = S.ringFade < 0.01 ? 1
                    : Math.pow(smoothstep(0, S.ringFade * 0.98, k), 1 + S.ringFade*2);
      const fadeOut = k < 0.72 ? 1 : Math.max(0, (1 - k) / 0.28);
      const a = fadeIn * fadeOut * 0.62 * S.effRingBright;
      if (a <= 0.003) continue;
      const rd = r * DPR;
      const hw = (0.7 + k * 3.4) * DPR * 0.5;   // half of the stroke width
      let lo = Math.floor((rd - hw - 1) * inv - 0.5);
      let hi = Math.ceil ((rd + hw + 1) * inv - 0.5);
      if (lo < 0) lo = 0;
      if (hi > LUT_N - 1) hi = LUT_N - 1;
      for (let j = lo; j <= hi; j++) {
        let cov = hw + 0.5 - Math.abs((j + 0.5) * step - rd);
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        lutArr[j] += a * cov;
      }
    }
  }

  // ---- edge layer -> instanced capsules ----
  edgeInst = 0;
  if (layers.edge) {
    for (const p of S.particles) {
      const lp = shape((S.phase + p.off) % 1);
      const aBase = (0.25 + 0.75*lp) * 0.75 * S.bright;
      const len = p.len * S.trailMul;
      const wid = p.w * S.effEdgeSize;
      const steps = Math.min(22, Math.max(8, Math.ceil(len * 300)));
      const invSteps = 1/steps;

      for (let i = 0; i < steps; i++) {
        if (edgeInst >= MAX_EDGE_INST) break;
        const t0 = i * invSteps;
        const a = aBase * Math.pow(1 - t0, 1.7);
        if (a < 0.004) continue;
        perimeterPoint(p.u - p.dir*len*t0);            const x0 = px, y0 = py;
        perimeterPoint(p.u - p.dir*len*(t0+invSteps));
        const o = edgeInst * 6;
        edgeArr[o]   = x0 * DPR; edgeArr[o+1] = y0 * DPR;
        edgeArr[o+2] = px * DPR; edgeArr[o+3] = py * DPR;
        edgeArr[o+4] = wid * (1 - t0*0.72) * DPR * 0.5;   // half width
        edgeArr[o+5] = a;
        edgeInst++;
      }

      if (edgeInst < MAX_EDGE_INST) {
        perimeterPoint(p.u);
        const o = edgeInst * 6;
        edgeArr[o]   = px * DPR; edgeArr[o+1] = py * DPR;
        edgeArr[o+2] = px * DPR; edgeArr[o+3] = py * DPR;
        edgeArr[o+4] = wid * 0.9 * DPR;                   // head dot radius
        edgeArr[o+5] = aBase * 0.9;
        edgeInst++;
      }
    }
  }
}
