// Per-frame CPU data for the scene: the uniform block field/rings/corners
// read, the ring layer's radial colour lookup, and the edge layer's vertex
// and instance buffers. Nothing here touches the GPU directly; scene.js owns
// the device and just uploads whatever this module last wrote.
//
// Two things widen past what js/framedata.js did for the old WebGPU path.
// First, rings and corners can now carry their own colour per element
// (S.perElementColor), which the old single-tint full-screen shader never
// needed, so the ring lookup table went from one float per radial sample to
// three (its colour, already weighted by coverage, rather than a bare
// coverage number multiplied by one shared tint later). Second, the ring
// stroke width now includes S.ringThick and the ring's own tw the way
// js/renderers/canvas2d.js draws it; the old WebGPU port dropped both and
// drew every ring at a fixed width, which is a real parity gap, not a
// deliberate simplification.
//
// Every array here is allocated once and reused. build() is called once a
// frame, always in the same order, and never grows anything unless the live
// particle count has actually outrun the current capacity.

import { S, layers, Z_NEAR } from '../../js/state.js';
import { shape, smoothstep } from '../../js/util.js';
import { radialFade } from '../core/fade.js';
import { bandHue } from '../../js/color.js';

export const LUT_N = 4096;                 // radial samples for the ring layer
export const UNIFORM_FLOATS = 40;          // see scene.wgsl.js's struct U

// A tail is sampled at 25 evenly spaced points along the perimeter plus one
// extra sample at every screen corner it passes, so each corner gets its own
// mitered joint instead of a quad cut diagonally across it. MAX_CORNERS caps
// how many corners one tail may carry (two full laps; the longest trail the
// UI allows passes at most three); the buffer is sized for that worst case so
// a tail can never overrun its slot. Each quad is two triangles, six
// vertices, eight floats per vertex (position, across, alpha, colour). One
// more sample again marks the widest point of a wedge-capped particle, so the
// shape comes to a true corner there (see buildEdge).
const TAIL_STEPS = 24;       // fine enough that a rounded wedge's top reads as a curve
const MAX_CORNERS = 8;
const TAIL_SAMPLES_MAX = TAIL_STEPS + 1 + MAX_CORNERS + 1;
const TAIL_QUADS = TAIL_STEPS + MAX_CORNERS + 1;
const TAIL_VERTS_PER_PARTICLE = TAIL_QUADS * 6;      // 198
export const TAIL_FLOATS_PER_VERTEX = 8;
export const TAIL_FLOATS_PER_PARTICLE = TAIL_VERTS_PER_PARTICLE * TAIL_FLOATS_PER_VERTEX; // 1584

// A head cap is one instance: centre, radius, alpha, colour, and the tail's
// own leading direction (so the fragment shader can cut away the half of the
// circle the tail polygon already covers; see scene.wgsl.js's fsCap).
export const CAP_FLOATS_PER_PARTICLE = 12;

// js/util.js's hslToRgb, writing into one scratch array instead of returning
// a fresh one, with its channel helper hoisted out of the closure it was.
// Under per-element colour the scene converts a colour for every corner,
// ring and particle every frame, and the v0 helper left an array and a
// closure behind for each of them. Same maths and rounding, same colours.
const hslOut = [0, 0, 0];
function hueChannel(p, q, t) {
  t = ((t % 1) + 1) % 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hsl(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); hslOut[0] = v; hslOut[1] = v; hslOut[2] = v; return hslOut; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  hslOut[0] = Math.round(hueChannel(p, q, h + 1 / 3) * 255);
  hslOut[1] = Math.round(hueChannel(p, q, h) * 255);
  hslOut[2] = Math.round(hueChannel(p, q, h - 1 / 3) * 255);
  return hslOut;
}

export class SceneData {
  constructor(initialParticles = 64) {
    this.capacityParticles = Math.max(1, initialParticles);
    this.tailVerts = new Float32Array(this.capacityParticles * TAIL_FLOATS_PER_PARTICLE);
    this.capInsts = new Float32Array(this.capacityParticles * CAP_FLOATS_PER_PARTICLE);
    this.tailVertCount = 0;    // vertices actually written this frame
    this.capInstCount = 0;     // cap instances actually written this frame
    this.uniform = new Float32Array(UNIFORM_FLOATS);
    this.lut = new Float32Array(LUT_N * 3);   // rgb per radial sample
    // Whether the full-screen field/rings/corners pass has anything to add
    // this frame, and whether the ring lookup holds any ring at all. With
    // every term off the pass would write opaque black over a target already
    // cleared to opaque black, a whole screen of fragment work for nothing,
    // so scene.js skips the draw (and the lookup's 48 KB upload) instead.
    this.fullActive = true;
    this.ringsAny = false;
    // Set by ensureCapacity when a frame needed more room than last frame,
    // so scene.js knows to recreate the GPU-side vertex buffers. The arrays
    // are rebuilt from scratch every frame anyway, so a grow never needs to
    // preserve old contents.
    this.grew = false;
  }

  ensureCapacity(n) {
    if (n <= this.capacityParticles) return;
    let cap = this.capacityParticles;
    while (cap < n) cap *= 2;
    this.capacityParticles = cap;
    this.tailVerts = new Float32Array(cap * TAIL_FLOATS_PER_PARTICLE);
    this.capInsts = new Float32Array(cap * CAP_FLOATS_PER_PARTICLE);
    this.grew = true;
  }

  // pixelW/pixelH/dpr come from the last resize() call, not from S, so the
  // shader's pixel-space maths always matches the texture it draws into
  // regardless of what else in S might be stale on a given frame.
  build(lum, pixelW, pixelH, dpr) {
    this.grew = false;
    buildUniform(this, lum, pixelW, pixelH, dpr);
    if (layers.edge) {
      buildEdge(this, dpr);
    } else {
      this.tailVertCount = 0;
      this.capInstCount = 0;
    }
  }
}

function buildUniform(sd, lum, pixelW, pixelH, dpr) {
  const u = sd.uniform;
  const cssW = S.W, cssH = S.H, inset = S.edgeInset;
  // Everything is composed inside the area the drawer leaves visible, same
  // as js/geometry.js's visW/visCx, so opening the panel recentres the field
  // and the tunnel instead of running them under it.
  const visWcss = Math.max(0, cssW - inset);
  const size = Math.min(visWcss, cssH) * 0.62;
  const maxR = Math.hypot(visWcss, cssH) * 0.62;
  const level = S.effBright * (1 - S.effDepth + S.effDepth * lum);
  const rgb = S.rgb;

  u[0] = pixelW; u[1] = pixelH;
  u[2] = pixelW > 0 ? 1 / pixelW : 0; u[3] = pixelH > 0 ? 1 / pixelH : 0;
  u[4] = rgb[0] / 255; u[5] = rgb[1] / 255; u[6] = rgb[2] / 255; u[7] = level;
  u[8] = S.fieldShape === 'full' ? 2 : (S.fieldShape === 'panel' ? 1 : 0);
  u[9] = size * 0.5 * dpr;            // disc radius / panel half-extent
  u[10] = 18 * dpr;                   // panel corner radius, matches canvas2d's fixed r=18
  u[11] = (layers.field && level > 0.002) ? 1 : 0;
  for (let i = 0; i < 4; i++) u[12 + i] = shape((S.phase + i / 4) % 1) * 0.5 * S.bright * S.effDepth;

  // Corner colours: quantised the same way js/color.js's hueStr is, just
  // evaluated directly rather than through the CSS-string palette cache that
  // only exists to avoid per-frame string allocation, which does not apply
  // to writing straight into a Float32Array.
  for (let i = 0; i < 4; i++) {
    const o = 16 + i * 4;
    if (S.perElementColor) {
      const c = hsl(bandHue(S.cornerHue[i]), S.hueSat, S.hueLight);
      u[o] = c[0] / 255; u[o + 1] = c[1] / 255; u[o + 2] = c[2] / 255; u[o + 3] = 0;
    } else {
      u[o] = rgb[0] / 255; u[o + 1] = rgb[1] / 255; u[o + 2] = rgb[2] / 255; u[o + 3] = 0;
    }
  }

  u[32] = Math.min(visWcss, cssH) * 0.46 * dpr;   // corner glow radius
  u[33] = maxR * dpr;                             // outer radius of the ring LUT
  u[34] = LUT_N;
  // u[35] (rings) is written after the lookup is filled, below. Corners
  // whose four glows are all exactly zero (bright or depth at zero) add
  // nothing, so they count as off.
  const cornersOn = layers.corners && (u[12] + u[13] + u[14] + u[15]) > 0;
  u[36] = cornersOn ? 1 : 0;
  u[37] = inset * dpr;                            // left edge, device px
  u[38] = S.fieldFade || 0;                        // the field's radial fade in
  u[39] = S.fieldSoft ?? 1;                        // and how soft its edge is

  let ringsAny = false;
  if (layers.rings) {
    sd.lut.fill(0);
    const rings = S.rings, lut = sd.lut;
    const FOCAL = maxR * Z_NEAR;
    const step = (maxR * dpr) / LUT_N, inv = step > 0 ? 1 / step : 0;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      const r = FOCAL / ring.z;
      const k = r / maxR;                       // 0 at the vanishing point, 1 at the rim
      if (k > 1) continue;
      const a = radialFade(S.ringFade, k) * 0.62 * S.effRingBright;
      if (a <= 0.003) continue;

      let rr, gg, bb;
      if (S.perElementColor) {
        const c = hsl(bandHue(ring.hue), S.hueSat, S.hueLight);
        rr = c[0] / 255; gg = c[1] / 255; bb = c[2] / 255;
      } else {
        rr = rgb[0] / 255; gg = rgb[1] / 255; bb = rgb[2] / 255;
      }

      const rd = r * dpr;
      // Nearer rings read thicker; S.ringThick and the ring's own tw both
      // apply here exactly as they do in canvas2d's ctx.lineWidth, which the
      // original WebGPU port left out entirely.
      const hw = (0.7 + k * 3.4) * S.ringThick * ring.tw * dpr * 0.5;
      let lo = Math.floor((rd - hw - 1) * inv - 0.5);
      let hi = Math.ceil((rd + hw + 1) * inv - 0.5);
      if (lo < 0) lo = 0;
      if (hi > LUT_N - 1) hi = LUT_N - 1;
      if (lo <= hi) ringsAny = true;
      for (let j = lo; j <= hi; j++) {
        let cov = hw + 0.5 - Math.abs((j + 0.5) * step - rd);
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        const w = a * cov, o = j * 3;
        lut[o] += w * rr; lut[o + 1] += w * gg; lut[o + 2] += w * bb;
      }
    }
  }
  // A lookup with no ring in it is all zeros, which the shader would read
  // and add for nothing; off is the same picture without the reads.
  u[35] = ringsAny ? 1 : 0;
  sd.ringsAny = ringsAny;
  sd.fullActive = u[11] > 0 || ringsAny || cornersOn;
}

// ---- perimeter walk for the edge layer ----
//
// js/geometry.js's perimeterPoint, extended to also report which edge the
// point lies on, so a tail's direction comes straight from that edge instead
// of from a finite difference, which went diagonal whenever it peeked round a
// corner and pushed the tail off the screen edge. Same parameterisation: u in
// 0..1 walks clockwise from the top-left corner (L,0), L being S.edgeInset.
// Edges are numbered in that order, 0 top, 1 right, 2 bottom, 3 left, and
// corner k is the point where edge k starts. The point lands in the ex/ey
// scratch and the edge index is returned, so nothing is allocated.
const EDGE_TX = [1, 0, -1, 0];        // each edge's unit tangent, increasing u
const EDGE_TY = [0, 1, 0, -1];
let ex = 0, ey = 0;
function perimEdge(u, L, W, H, w, per) {
  let d = (((u % 1) + 1) % 1) * per;  // wrap negatives, trails run backwards
  if (d < w) { ex = L + d; ey = 0; return 0; }
  d -= w;
  if (d < H) { ex = W; ey = d; return 1; }
  d -= H;
  if (d < w) { ex = W - d; ey = H; return 2; }
  d -= w;
  ex = L; ey = H - d; return 3;
}

// Per-tail scratch, reused for every particle: where each corner sits in u,
// the t of every corner the current tail passes, the merged list of sample
// t values, and which edge each span between two consecutive samples runs
// along.
const cornerFrac = new Float64Array(4);
const cornerT = new Float64Array(MAX_CORNERS + 1);   // + the wedge's widest point
const sampT = new Float64Array(TAIL_SAMPLES_MAX);
const spanEdge = new Int8Array(TAIL_SAMPLES_MAX);
// A corner closer than this (in t) to an evenly spaced sample takes that
// sample's place rather than sitting beside it, so no span is ever too short
// to say for certain which edge it runs along.
const MERGE_EPS = 1e-4;
// The leading tip, S.edgeCap: 'wedge' runs a short reverse tail forward of
// the head to a point, so a particle reads <> (built into the strip below,
// so it wraps corners like the tail does); 'ball' is the old round cap, a
// half-disc drawn by the cap pipeline, which can leave a rounded bite in a
// corner the head is about to turn. 'round' is the wedge as a wave: a
// raised cosine, flat at the top and flat again at both ends, so the shape
// swells up out of the screen edge and settles back into it with no corner
// anywhere, where the wedge meets the edge at an angle.

function buildEdge(sd, dpr) {
  const particles = S.particles;
  const n = particles.length;
  sd.ensureCapacity(n);
  const tv = sd.tailVerts, cv = sd.capInsts;
  const rgbG = S.rgb;
  let vi = 0, ci = 0, np = 0;

  const L = S.edgeInset, W = S.W, H = S.H;
  const w = W - L, per = 2 * (w + H);
  const wedge = S.edgeCap !== 'ball', ball = !wedge, rounded = S.edgeCap === 'round';
  if (!(per > 0)) { sd.tailVertCount = 0; sd.capInstCount = 0; return; }
  cornerFrac[0] = 0;
  cornerFrac[1] = w / per;
  cornerFrac[2] = (w + H) / per;
  cornerFrac[3] = (2 * w + H) / per;

  for (let pi = 0; pi < n; pi++) {
    const p = particles[pi];
    // each particle breathes on the master clock, offset so they shimmer
    const lp = shape((S.phase + p.off) % 1);
    const a = (0.25 + 0.75 * lp) * 0.75 * S.bright * (S.edgeOpacity ?? 1);
    if (a < 0.004) continue;

    let r, g, b;
    if (S.perElementColor) {
      const c = hsl(bandHue(p.hue), S.hueSat, S.hueLight);
      r = c[0] / 255; g = c[1] / 255; b = c[2] / 255;
    } else {
      r = rgbG[0] / 255; g = rgbG[1] / 255; b = rgbG[2] / 255;
    }

    const len = p.len * S.trailMul;
    const wid = p.w * S.effEdgeSize;
    const inv = 1 / TAIL_STEPS;
    // The tail's own span, head to tip, in perimeter units.
    const back = -p.dir * len;
    // A wedge is a reverse tail ahead of the head, the tail's mirror image:
    // the same length, so the front and back tapers are the same slope. fwd
    // is that length in units of the tail's span.
    const fwd = wedge && back !== 0 ? 1 : 0;
    // The whole particle is then one strip from u0 (t = 0) to u0 + span at
    // the tail tip (t = 1): the wedge's point when there is one, otherwise
    // the head itself. It is widest at t = tp, the head, which is 0 without
    // a wedge. When span is negative the strip walks against increasing u,
    // so every edge tangent flips to keep pointing along increasing t.
    const u0 = p.u - back * fwd;
    const span = back * (1 + fwd);
    const tp = fwd / (1 + fwd);
    const sgn = span < 0 ? -1 : 1;

    // Corners strictly inside the tail, found in increasing t by stepping
    // corner to corner from the head in the tail's direction of travel,
    // wrapping through whole laps as needed.
    let nc = 0;
    if (span !== 0) {
      let base = Math.floor(u0);
      const f = u0 - base;
      let k;
      if (span > 0) {
        k = 0;
        while (k < 4 && cornerFrac[k] <= f) k++;
        if (k === 4) { k = 0; base += 1; }
      } else {
        k = 3;
        while (k >= 0 && cornerFrac[k] >= f) k--;
        if (k < 0) { k = 3; base -= 1; }
      }
      while (nc < MAX_CORNERS) {
        const tc = (base + cornerFrac[k] - u0) / span;
        if (tc >= 1) break;
        cornerT[nc++] = tc;
        if (span > 0) { if (++k === 4) { k = 0; base += 1; } }
        else if (--k < 0) { k = 3; base -= 1; }
      }
    }

    // The head gets a sample of its own in a wedge, slotted into the corner
    // list in order, so the widest point is exact rather than rounded off
    // between two evenly spaced samples.
    if (tp > 0) {
      let k = nc++;
      while (k > 0 && cornerT[k - 1] > tp) { cornerT[k] = cornerT[k - 1]; k--; }
      cornerT[k] = tp;
    }

    // Merge the corners, in order, into the evenly spaced samples.
    let ns = 0, j = 0;
    for (let i = 0; i <= TAIL_STEPS; i++) {
      const t = i * inv;
      while (j < nc && cornerT[j] <= t + MERGE_EPS) {
        const tc = cornerT[j++];
        if (ns > 0 && tc - sampT[ns - 1] < MERGE_EPS) continue;
        sampT[ns++] = tc;
      }
      if (ns > 0 && t - sampT[ns - 1] < MERGE_EPS) continue;   // a corner took this slot
      sampT[ns++] = t;
    }

    // Every span between two samples now lies on exactly one edge, so its
    // midpoint says which.
    for (let q = 0; q + 1 < ns; q++) {
      spanEdge[q] = perimEdge(u0 + span * 0.5 * (sampT[q] + sampT[q + 1]), L, W, H, w, per);
    }

    let prevLx = 0, prevLy = 0, prevRx = 0, prevRy = 0;
    let headX = 0, headY = 0, headHw = 0;
    // The head cap's cut direction is the first span's tangent, which is
    // also the outgoing edge when the head sits exactly on a corner.
    const cutX = EDGE_TX[spanEdge[0]] * sgn, cutY = EDGE_TY[spanEdge[0]] * sgn;

    // A tail is a single tapered polygon: full width at the head, narrowing
    // to a point at the tail, sampled along the perimeter so it bends at
    // corners instead of cutting across them. This is what fixes the bead
    // bug: v0's WebGPU path drew one rounded capsule per segment here, which
    // reads as a string of beads rather than a continuous tail the way
    // js/renderers/canvas2d.js's drawEdge does.
    //
    // An ordinary sample offsets straight out along its edge's left normal
    // (-ty, tx), so the tail stays flat against the screen edge. A sample
    // where the incoming and outgoing spans lie on different edges is a
    // corner: it sits exactly on the screen corner and offsets by the sum of
    // both legs' normals, a miter that keeps the full width on each leg and
    // turns a sharp square corner instead of a rounded diagonal.
    for (let q = 0; q < ns; q++) {
      const t = sampT[q];
      const eIn = q > 0 ? spanEdge[q - 1] : spanEdge[0];
      const eOut = q < ns - 1 ? spanEdge[q] : spanEdge[ns - 2];
      // tapers to nothing both ways from the head: x is 0 at the head and 1
      // at either end, straight for a wedge, a half cosine wave when rounded
      const x = t < tp ? (tp - t) / tp : (t - tp) / (1 - tp);
      const prof = rounded ? 0.5 + 0.5 * Math.cos(Math.PI * x) : 1 - x;
      const hw = wid * 0.5 * prof * dpr;
      let ox = -EDGE_TY[eIn] * sgn, oy = EDGE_TX[eIn] * sgn;
      let cx, cy;
      if (eIn === eOut) {
        perimEdge(u0 + span * t, L, W, H, w, per);
        cx = ex * dpr; cy = ey * dpr;
      } else {
        // Walking with increasing u, edge eIn hands over to eOut at corner
        // eOut; walking against it, the tail passes corner eIn instead.
        const k = eOut === ((eIn + 1) & 3) ? eOut : eIn;
        cx = (k === 1 || k === 2 ? W : L) * dpr;
        cy = (k >= 2 ? H : 0) * dpr;
        ox += -EDGE_TY[eOut] * sgn; oy += EDGE_TX[eOut] * sgn;
      }
      const lx = cx + ox * hw, ly = cy + oy * hw;
      const rx = cx - ox * hw, ry = cy - oy * hw;

      if (q === 0) { headX = cx; headY = cy; headHw = hw; }

      if (q > 0) {
        const o = vi;
        tv[o] = prevLx; tv[o + 1] = prevLy; tv[o + 2] = -1; tv[o + 3] = a;
        tv[o + 4] = r; tv[o + 5] = g; tv[o + 6] = b; tv[o + 7] = 0;
        tv[o + 8] = prevRx; tv[o + 9] = prevRy; tv[o + 10] = 1; tv[o + 11] = a;
        tv[o + 12] = r; tv[o + 13] = g; tv[o + 14] = b; tv[o + 15] = 0;
        tv[o + 16] = lx; tv[o + 17] = ly; tv[o + 18] = -1; tv[o + 19] = a;
        tv[o + 20] = r; tv[o + 21] = g; tv[o + 22] = b; tv[o + 23] = 0;
        tv[o + 24] = prevRx; tv[o + 25] = prevRy; tv[o + 26] = 1; tv[o + 27] = a;
        tv[o + 28] = r; tv[o + 29] = g; tv[o + 30] = b; tv[o + 31] = 0;
        tv[o + 32] = rx; tv[o + 33] = ry; tv[o + 34] = 1; tv[o + 35] = a;
        tv[o + 36] = r; tv[o + 37] = g; tv[o + 38] = b; tv[o + 39] = 0;
        tv[o + 40] = lx; tv[o + 41] = ly; tv[o + 42] = -1; tv[o + 43] = a;
        tv[o + 44] = r; tv[o + 45] = g; tv[o + 46] = b; tv[o + 47] = 0;
        vi = o + 48;
      }
      prevLx = lx; prevLy = ly; prevRx = rx; prevRy = ry;
    }

    // Ball mode only: the round cap on the head. (cutX, cutY) points forward
    // into the tail (t growing), exactly the side the tail polygon already
    // covers, so the cap keeps only the other side (see scene.wgsl.js's fsCap
    // for why). Its half-disc can spill past a corner the head is about to
    // turn and leave a rounded bite in it; the wedge never does.
    if (!ball) continue;
    const co = ci;
    cv[co] = headX; cv[co + 1] = headY; cv[co + 2] = headHw; cv[co + 3] = a;
    cv[co + 4] = r; cv[co + 5] = g; cv[co + 6] = b; cv[co + 7] = cutX;
    cv[co + 8] = cutY; cv[co + 9] = 0; cv[co + 10] = 0; cv[co + 11] = 0;
    ci = co + 12;
    np++;
  }

  sd.tailVertCount = vi / TAIL_FLOATS_PER_VERTEX;
  sd.capInstCount = np;
}
