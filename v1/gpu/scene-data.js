// Per-frame CPU data for the scene: the uniform block field/rings/corners
// read, the ring layer's list of ring records, and the edge layer's vertex
// and instance buffers. Nothing here touches the GPU directly; scene.js owns
// the device and just uploads whatever this module last wrote.
//
// Two things widen past what js/framedata.js did for the old WebGPU path.
// First, rings and corners can now carry their own colour per element
// (S.perElementColor), which the old single-tint full-screen shader never
// needed, so each ring carries its own colour, already weighted by its
// alpha, rather than a bare coverage number multiplied by one shared tint
// later. Second, the ring
// stroke width now includes S.ringThick and the ring's own tw the way
// js/renderers/canvas2d.js draws it; the old WebGPU port dropped both and
// drew every ring at a fixed width, which is a real parity gap, not a
// deliberate simplification.
//
// Every array here is allocated once and reused. build() is called once a
// frame, always in the same order, and never grows anything unless the live
// particle count has actually outrun the current capacity.

import { S, layers, Z_NEAR, CORNER_TYPES, MAX_RINGS } from '../../js/state.js';
import { scaledStrobeDepth } from '../../js/strobe-scale.js';
import { shape, smoothstep } from '../../js/util.js';
import { radialFade } from '../core/fade.js';
import { flickerLevel } from '../core/strobe.js';
import { eye } from '../core/eye.js';
import { bandHue } from '../../js/color.js';

export const UNIFORM_FLOATS = 44;          // see scene.wgsl.js's struct U

// Rings used to be splatted into a 4096-sample radial lookup around the one
// field centre, which the shader read by distance from that centre. A lookup
// can only describe rings that all share a centre, and head-tracked parallax
// needs each ring to sit at its own (a near ring shifts further than a far
// one). So each ring that survives culling is now one record the shader
// measures a pixel against directly: its centre, radius, half-width and
// colour (which pixels measure which rings is the index below). It is the same coverage formula the lookup was filled with,
// evaluated exactly at each pixel's own radius instead of sampled at 4096
// radii and interpolated, so the picture is the same, if anything a touch
// crisper. Eight floats a ring: centre x, centre y (device px), radius,
// half-width, colour rgb already times the ring's alpha, and one spare.
export const RING_FLOATS = 8;

// Measuring every pixel against every ring is up to MAX_RINGS measurements a
// pixel, and any one pixel is only ever touched by the one or two rings whose
// stroke passes near it. So the records come with a radial index: the span
// from the field centre out to the rim is cut into RING_BINS equal bins, each
// ring is listed in every bin its stroke could reach, and a pixel works out
// its bin from its own distance to the field centre and measures only the
// rings listed there, in ring order, so it sums exactly the same terms in
// exactly the same order as before and the picture is unchanged.
//
// 256 bins make a bin about ten device px wide on a typical screen (the rim
// is some 2,700 px at 1080p and 2x), about the width of the thickest ring's
// stroke plus its antialiasing, so most rings land in one or two bins. Finer
// bins would barely shorten any pixel's list, since a ring still spans at
// least one, and would only add bins to fill; coarser ones would start
// lumping neighbouring rings together again.
//
// The index is one Uint32Array: RING_BINS + 1 offsets, then the ring numbers.
// Bin b's rings are the entries from offsets[b] to offsets[b + 1], counted
// from the start of the whole array, so the shader reads it with no base to
// add. It is sized for the worst case, every ring in every bin, so it never
// grows; ringBinsLen of it is live.
export const RING_BINS = 256;
export const RING_BIN_WORDS = RING_BINS + 1 + MAX_RINGS * RING_BINS;
// Scratch for building the index, one set, reused every frame: a count (then
// a write cursor) per bin, and each record's first and last bin.
const binCursor = new Uint32Array(RING_BINS);
const binLo = new Int32Array(MAX_RINGS), binHi = new Int32Array(MAX_RINGS);

// TEMPORARY A/B switch, to be removed once the ring records are signed off.
// With S.ringDraw 'lookup' the rings go back to being splatted into the old
// radial lookup and read through it, so the two can be compared by eye, live.
// It is the Render section's Ring draw control (core/schema-visual.js).
// Removing it means deleting that control, LUT_N, SceneData.lut, the splat
// branch in buildUniform, the lookup's buffer in scene.js and its binding and
// branch in scene.wgsl.js.
// How many rings the last frame actually drew: the ones past the cull (not
// yet beyond the rim, bright enough to move a pixel), out of all S.rings.
// The drawer's Rings header shows it beside the total.
export const ringStats = { drawn: 0 };
export const LUT_N = 4096;                 // radial samples, old lookup (temporary)

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
// Exported for the edge's other effects (edge-fx.js), which take their
// per-element colours from the same particle hues; the result is this
// scratch, good until the next call.
const hslOut = [0, 0, 0];
function hueChannel(p, q, t) {
  t = ((t % 1) + 1) % 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
export function hsl(h, s, l) {
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
    // One record per ring drawn this frame, sized for every ring the tunnel
    // can hold (MAX_RINGS), so it never grows; ringCount of them are live.
    this.rings = new Float32Array(MAX_RINGS * RING_FLOATS);
    this.ringCount = 0;
    // The records' radial bin index (see RING_BINS), ringBinsLen words live.
    this.ringBins = new Uint32Array(RING_BIN_WORDS);
    this.ringBinsLen = 0;
    this.lut = new Float32Array(LUT_N * 3);   // old lookup, rgb per radial sample (temporary A/B)
    this.ringsLut = false;                    // this frame's rings went into lut, not rings (temporary A/B)
    // Whether the full-screen field/rings/corners pass has anything to add
    // this frame, and whether there is any ring to draw at all. With every
    // term off the pass would write opaque black over a target already
    // cleared to opaque black, a whole screen of fragment work for nothing,
    // so scene.js skips the draw (and the ring upload) instead.
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
  // surf is the Surfing effect's share of the edge this frame, 1 when it is
  // the edge's effect, 0 when another is, and in between while scene.js
  // crossfades one into the other; at 0 nothing is built.
  build(lum, pixelW, pixelH, dpr, surf = 1) {
    this.grew = false;
    buildUniform(this, lum, pixelW, pixelH, dpr);
    if (layers.edge && surf > 0) {
      buildEdge(this, dpr, surf);
    } else {
      this.tailVertCount = 0;
      this.capInstCount = 0;
    }
  }
}

// The corners' own chase clock (see buildUniform), and the strobe phase it
// was last stepped from; NaN until the first frame seeds it from the strobe.
let cornerPhase = NaN, lastStrobePhase = 0;

function buildUniform(sd, lum, pixelW, pixelH, dpr) {
  const u = sd.uniform;
  const cssW = S.W, cssH = S.H, inset = S.edgeInset;
  // Everything is composed inside the area the drawer leaves visible, same
  // as js/geometry.js's visW/visCx, so opening the panel recentres the field
  // and the tunnel instead of running them under it.
  const visWcss = Math.max(0, cssW - inset);
  const size = Math.min(visWcss, cssH) * 0.62;
  const maxR = Math.hypot(visWcss, cssH) * 0.62;
  // fieldOpacity dims the field alone. Brightness is the whole flash signal
  // the rings, corners and every layer's pulse ride; this one is only the
  // field's, so it can fade without taking the others with it.
  const level = S.effBright * (1 - S.effDepth + S.effDepth * lum) * (S.fieldOpacity ?? 1);
  const rgb = S.rgb;

  u[0] = pixelW; u[1] = pixelH;
  u[2] = pixelW > 0 ? 1 / pixelW : 0; u[3] = pixelH > 0 ? 1 / pixelH : 0;
  u[4] = rgb[0] / 255; u[5] = rgb[1] / 255; u[6] = rgb[2] / 255; u[7] = level;
  u[8] = S.fieldShape === 'full' ? 2 : (S.fieldShape === 'panel' ? 1 : 0);
  u[9] = size * 0.5 * dpr;            // disc radius / panel half-extent
  u[10] = 18 * dpr;                   // panel corner radius, matches canvas2d's fixed r=18
  u[11] = (layers.field && level > 0.002) ? 1 : 0;
  // The corners strobe on their own quarter-offset phases, so they follow
  // the flicker level the way the field follows flickerLum: paused (or
  // winding down with Pause stops flicker on) they settle to the steady
  // top-of-cycle look, all four equal, instead of flickering on or freezing
  // mid-cycle.
  // Their chase runs on its own clock, stepped each frame by however far the
  // strobe's phase moved times cornerSpeed, so 1x stays in step with the
  // strobe and 0 holds the corners where they are. Pulse scales the flicker,
  // 0 leaving them at the steady top-of-cycle look, and goes through the
  // strobe's safety scale as the rings' pulse does. Opacity is theirs alone,
  // apart from the strobe's brightness and depth; full is the old default's
  // peak (0.5 x the default depth 0.8).
  const fl = flickerLevel();
  let dPh = S.phase - lastStrobePhase;
  if (dPh < 0) dPh += 1;
  lastStrobePhase = S.phase;
  if (!(cornerPhase >= 0)) cornerPhase = S.phase;
  else cornerPhase = (cornerPhase + dPh * (S.cornerSpeed ?? 1)) % 1;
  const cPulse = scaledStrobeDepth(Math.max(0, Math.min(1, S.cornerPulse ?? 1)));
  const cPeak = 0.4 * (S.cornerOpacity ?? 1);
  for (let i = 0; i < 4; i++) {
    const cs = 1 + (shape((cornerPhase + i / 4) % 1) - 1) * fl * cPulse;
    u[12 + i] = cs * cPeak;
  }

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

  u[32] = Math.min(visWcss, cssH) * (S.cornerSize ?? 0.46) * dpr;   // corner reach
  u[33] = maxR * dpr;                             // the rings' outer rim, device px
  // u[34] (how many ring records) and u[35] (rings on) are written once the
  // rings are gathered, below. Corners whose four glows are all exactly zero
  // (bright or depth at zero) add nothing, so they count as off.
  const cornersOn = layers.corners && (u[12] + u[13] + u[14] + u[15]) > 0;
  u[36] = cornersOn ? 1 : 0;
  u[37] = inset * dpr;                            // left edge, device px
  u[38] = S.fieldFade || 0;                        // the field's radial fade in
  u[39] = S.fieldSoft ?? 1;                        // and how soft its edge is
  u[40] = Math.max(0, CORNER_TYPES.indexOf(S.cornerType));   // corners' look
  // The ring records' radial bins: how many, and how many to a device px
  // (RING_BINS over the rim), which the index below is built from as the
  // shader will read it back, rounded to f32 the same.
  u[41] = RING_BINS;
  u[42] = u[33] > 0 ? RING_BINS / u[33] : 0;
  u[43] = 0;

  let ringsAny = false, nr = 0, drawn = 0;
  const useLut = S.ringDraw === 'lookup';   // temporary A/B, see LUT_N
  if (layers.rings) {
    if (useLut) sd.lut.fill(0);
    const rings = S.rings, lut = sd.lut, rec = sd.rings;
    // Every ring is centred where the shader centres the field, inside the
    // area the drawer leaves visible: (inset + width) / 2 across, half the
    // height down, from the very uniform values fsFull reads (u[37] the
    // inset and u[0] the width, device px) so the two cannot disagree.
    const cx = (u[37] + u[0]) * 0.5, cy = u[1] * 0.5;
    const ringPulse = scaledStrobeDepth(typeof S.ringPulse === 'number' ? Math.max(0, Math.min(1, S.ringPulse)) : 0);
    const ringPulseGain = 1 - ringPulse + ringPulse * (lum < 0 ? 0 : lum > 1 ? 1 : lum);
    // The layer's brightness, from S as it is NOW rather than the strobe
    // step's cached S.effRingBright (same formula, core/strobe.js): the
    // cache is computed at the top of the frame, so a switch or ramp moved
    // mid-frame (the performance window fading a layer in through its
    // opacity) would render one frame at the old level -- a flash.
    const ringBase = S.bright * (S.ringOpacity ?? 1);
    const effRingBright = S.ringBrightVar
      ? ringBase * (1 - S.ringBrightVar * 0.5 * (1 - Math.cos(2 * Math.PI * S.ringBrightPhase)))
      : ringBase;
    const fadeInS = (S.ringFadeInMs ?? 1000) / 1000;
    const FOCAL = maxR * Z_NEAR;
    const step = (maxR * dpr) / LUT_N, inv = step > 0 ? 1 / step : 0;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      const r = FOCAL / ring.z;
      const k = r / maxR;                       // 0 at the vanishing point, 1 at the rim
      if (k > 1) continue;
      // Ring fade in: a new ring ramps up from nothing over its first
      // ringFadeInMs, linear in opacity; 0 shows it at once.
      const fadeIn = fadeInS > 0 && ring.age < fadeInS ? ring.age / fadeInS : 1;
      const a = radialFade(S.ringFade, k) * 0.62 * effRingBright * ringPulseGain * fadeIn;
      if (a <= 0.003) continue;
      drawn++;

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
      if (!useLut) {
        if (nr >= MAX_RINGS) break;
        // Each ring's centre moves with the eye (core/eye.js, parallax):
        // centre - eye * FOCAL / ring.z, in device px. FOCAL / ring.z is the
        // ring's own radius r, so the shift is simply eye times rd: nearer
        // rings, being larger, slide further than the far ones and the tunnel
        // gains depth. Its fade and cull above stay on the ring's own radius,
        // as the particles' and confetti's do. At eye 0 every ring sits on
        // the field centre, as it always did. The old lookup cannot shift.
        const o = nr * RING_FLOATS;
        rec[o] = cx - eye.x * rd; rec[o + 1] = cy - eye.y * rd; rec[o + 2] = rd; rec[o + 3] = hw;
        rec[o + 4] = rr * a; rec[o + 5] = gg * a; rec[o + 6] = bb * a; rec[o + 7] = 0;
        nr++;
        continue;
      }
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
  // With no ring to draw the shader would loop over nothing (or read an
  // all-zero lookup) for nothing; off is the same picture without the work.
  // u[35] is 1 for the ring records (read through their bin index), 2 for
  // the old lookup (temporary A/B), and u[34] how many records, or the
  // lookup's sample count.
  if (!useLut) ringsAny = nr > 0;
  sd.ringCount = nr;
  sd.ringBinsLen = !useLut && nr > 0 ? buildRingBins(sd, nr, u) : 0;
  ringStats.drawn = drawn;
  sd.ringsLut = useLut;
  u[34] = useLut ? LUT_N : nr;
  u[35] = ringsAny ? (useLut ? 2 : 1) : 0;
  sd.ringsAny = ringsAny;
  sd.fullActive = u[11] > 0 || ringsAny || cornersOn;
}

// Fills sd.ringBins, the radial index over this frame's nr ring records (see
// RING_BINS), and returns how many words of it are live.
//
// A ring touches a pixel only where its coverage, hw + 0.5 - |d - rd|, is
// above zero, d being the pixel's distance from the ring's OWN centre. The
// bins are measured from the FIELD centre, and the two are s apart, so by
// the triangle inequality the pixel's field-centre distance is within s of
// d: every pixel the ring touches lies between rd - hw - 0.5 - s and
// rd + hw + 0.5 + s of the field centre. s is 0 today, every ring sharing
// the field's centre; it is what keeps the index right once head-tracked
// parallax moves each ring's centre on its own. The band listed here is a
// half pixel wider again each side (hw + 1), which covers the shader's f32
// rounding of the distances and of the bin maths with hundreds of times to
// spare (those errors are thousandths of a pixel at these sizes), so no
// extra bin is needed either side. Both ends clamp into the bins that exist:
// a pixel past the rim reads the last bin, so a ring reaching past the rim
// is listed there too.
//
// The rings go in in ring order, so each bin's list, and each pixel's sum,
// keeps the order the shader summed every ring in before.
function buildRingBins(sd, nr, u) {
  const rec = sd.rings, out = sd.ringBins, last = RING_BINS - 1;
  // The field centre and the bin scale exactly as fsFull reads them, from
  // the same f32 uniform values.
  const cx = (u[37] + u[0]) * 0.5, cy = u[1] * 0.5, scale = u[42];
  binCursor.fill(0);
  for (let i = 0; i < nr; i++) {
    const o = i * RING_FLOATS;
    const s = Math.hypot(rec[o] - cx, rec[o + 1] - cy);
    const rd = rec[o + 2], hw = rec[o + 3];
    let lo = Math.floor((rd - hw - 1 - s) * scale);
    let hi = Math.floor((rd + hw + 1 + s) * scale);
    lo = lo < 0 ? 0 : lo > last ? last : lo;
    hi = hi < 0 ? 0 : hi > last ? last : hi;
    // Stored first and counted from what was stored, so the count and the
    // fill below can never disagree, whatever the maths gave.
    binLo[i] = lo; binHi[i] = hi;
    for (let b = binLo[i]; b <= binHi[i]; b++) binCursor[b]++;
  }
  // Counts to offsets, each bin's cursor starting at its own offset.
  let at = RING_BINS + 1;
  for (let b = 0; b < RING_BINS; b++) {
    const c = binCursor[b];
    out[b] = at; binCursor[b] = at; at += c;
  }
  out[RING_BINS] = at;
  for (let i = 0; i < nr; i++) {
    for (let b = binLo[i]; b <= binHi[i]; b++) out[binCursor[b]++] = i;
  }
  return at;
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

function buildEdge(sd, dpr, surf) {
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

  // The edge particles breathe on the master clock, each offset so they
  // shimmer, which is a flicker of their own; like the corners they follow
  // the flicker level, settling to the steady top-of-cycle look the moment
  // pause ends the flashing (core/strobe.js flickerLevel).
  // Pulse with strobe (S.edgePulse) scales how deep that breathing goes:
  // at 1 exactly as it always was, at 0 a steady edge at full strength.
  const efl = flickerLevel();
  const pulse = scaledStrobeDepth(typeof S.edgePulse === 'number' ? Math.max(0, Math.min(1, S.edgePulse)) : 1);
  for (let pi = 0; pi < n; pi++) {
    const p = particles[pi];
    const lp = 1 + (shape((S.phase + p.off) % 1) - 1) * efl;
    const full = 0.25 + 0.75 * lp;
    const breath = pulse === 1 ? full : 1 + (full - 1) * pulse;
    // Edge opacity alone sets the edge's level: the Strobe section's
    // Brightness is the field's, not the scene's, so the edge stopped
    // riding it (it did in v0, and until early on in v1).
    const a = breath * 0.75 * (S.edgeOpacity ?? 1) * surf;
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
