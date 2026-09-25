// The SDF glyph atlas: every letter the UI ever draws, at every weight and
// size, comes out of one texture. Text in v1 is not a DOM element with a font
// renderer behind it, it is a quad and a distance field, so this file is the
// whole of what "a font" means to the rest of the engine.
//
// The atlas is a single 2048x2048 r8unorm texture, created once and never
// resized, because the UI renderer binds it once and expects that binding to
// stay valid for the life of the app. Glyphs are packed into it with a plain
// shelf packer as they are needed. Printable ASCII and Latin-1 at the three
// theme weights are queued the moment the atlas is created, but the actual
// rasterising, the expensive part, happens a few glyphs at a time in tick(),
// which the frame loop calls once per frame with a small time budget. Nothing
// here blocks a frame waiting for a font.
//
// The distance field itself is computed with the Felzenszwalb-Huttenlocher
// exact Euclidean distance transform, run twice per glyph (once seeded by the
// ink, once seeded by the background) and combined into a signed field. This
// is slower than the eight-point approximations some SDF generators use, but
// it is exact, and a glyph is rasterised once in its lifetime, so there is no
// reason to trade correctness for speed here.
//
// The seeds come from the rasteriser's anti-aliased coverage, not from a
// yes/no threshold of it. A thresholded glyph is a staircase of whole pixels,
// and an exact transform of a staircase is an exact staircase: magnified to
// the centre word's size the steps showed as pixelation along every curve.
// Seeding the way Mapbox's TinySDF does keeps the sub-pixel edge position the
// coverage already carries: a partly covered pixel starts at a fractional
// distance from the edge instead of at zero or one, so the field's zero line
// runs where the rasteriser actually put the outline.

import { FONT, W } from '../ui/theme.js';

const ATLAS_SIZE = 2048;
// px the glyphs are rasterised at. 64 rather than 48 gives the centre word
// (35 css px, 70 device px at dpr 2) a field sampled closer to one texel per
// pixel. It still fits with room to spare: 570-odd inked glyphs (ASCII and
// Latin-1 at three weights) at the worst case of an em-sized cell plus
// padding, about 78 px square, pack 26 to a shelf in 22 shelves, 1740 px of
// the atlas's 2048, and real glyphs average far smaller than that.
const BASE_SIZE = 64;
const SDF_RANGE = 6;           // atlas px the field is valid for on either side of an edge
const PAD = 8;                 // atlas px of background kept around each glyph's ink
const GUTTER = 1;               // atlas px left between packed cells, against filtering bleed
const INF = 1e6;                // a large finite stand-in for "no seed here"; real Infinity
                                 // would turn into NaN the moment two of them are subtracted

const WEIGHTS = [W.light, W.regular, W.semibold, W.bold];
const WEIGHT_CSS = WEIGHTS.map(w => String(w));
// The full CSS font string per weight at BASE_SIZE, built once here so that
// onboarding a glyph never has to concatenate one.
const WEIGHT_FONT = WEIGHT_CSS.map(w => w + ' ' + BASE_SIZE + 'px ' + FONT);

// drawWord's per-letter transform, filled by the fx callback for each letter.
const WORD_XF = new Float32Array(8);

function weightIndex(weight) {
  if (weight === W.light) return 0;
  if (weight === W.semibold) return 2;
  if (weight === W.bold) return 3;
  return 1; // regular, and anything unrecognised snaps to it
}

// The one DOM-adjacent thing this file is allowed to touch. Rasterisation
// needs a 2D context; OffscreenCanvas gives us one with no document behind it.
function createScratchCanvas(w, h) {
  if (typeof OffscreenCanvas === 'undefined') {
    console.warn('text-atlas: OffscreenCanvas is not available, glyphs cannot be rasterised');
    return null;
  }
  return new OffscreenCanvas(w, h);
}

// ---- the exact 1D distance transform, Felzenszwalb & Huttenlocher ----
// f holds, per sample, 0 at a seed and INF elsewhere. d receives the squared
// distance to the nearest seed. v and z are scratch: v the index of the
// parabola owning each span of the lower envelope, z the span boundaries.
function edt1d(f, n, d, v, z) {
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

export function createText(device, platform) {
  // ---- the atlas texture, created once, bound once ----
  const atlasTexture = device.createTexture({
    size: [ATLAS_SIZE, ATLAS_SIZE, 1],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });

  // ---- glyph storage: typed arrays for the common Latin range, a Map for
  // whatever shows up beyond it. status: 0 untouched, 1 known width but not
  // yet rasterised, 2 ready (which may still mean "no ink", for space and
  // its kin: those are ready immediately, with qw 0, and draw() skips them).
  const advanceTab = [new Float32Array(256), new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const statusTab = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  // 8 floats per code: u0 v0 u1 v1, ox oy (quad top-left offset from the pen,
  // base px), qw qh (quad size, atlas/base px).
  const boxTab = [new Float32Array(256 * 8), new Float32Array(256 * 8), new Float32Array(256 * 8), new Float32Array(256 * 8)];
  const mapTab = [new Map(), new Map(), new Map(), new Map()];

  function readAdvance(wi, code) {
    if (code < 256) return advanceTab[wi][code];
    const rec = mapTab[wi].get(code);
    return rec ? rec.advance : 0;
  }
  function readStatus(wi, code) {
    if (code < 256) return statusTab[wi][code];
    const rec = mapTab[wi].get(code);
    return rec ? rec.status : 0;
  }
  function storeResult(wi, code, advance, status, u0, v0, u1, v1, ox, oy, qw, qh) {
    if (code < 256) {
      advanceTab[wi][code] = advance;
      statusTab[wi][code] = status;
      const b = code * 8, arr = boxTab[wi];
      arr[b] = u0; arr[b + 1] = v0; arr[b + 2] = u1; arr[b + 3] = v1;
      arr[b + 4] = ox; arr[b + 5] = oy; arr[b + 6] = qw; arr[b + 7] = qh;
    } else {
      let rec = mapTab[wi].get(code);
      if (!rec) { rec = { advance: 0, status: 0, u0: 0, v0: 0, u1: 0, v1: 0, ox: 0, oy: 0, qw: 0, qh: 0 }; mapTab[wi].set(code, rec); }
      rec.advance = advance; rec.status = status;
      rec.u0 = u0; rec.v0 = v0; rec.u1 = u1; rec.v1 = v1;
      rec.ox = ox; rec.oy = oy; rec.qw = qw; rec.qh = qh;
    }
  }

  // ---- the shelf packer ----
  let packX = 0, packY = 0, packRowH = 0, warnedFull = false;
  function allocRegion(w, h) {
    if (packX + w > ATLAS_SIZE) { packX = 0; packY += packRowH + GUTTER; packRowH = 0; }
    if (packY + h > ATLAS_SIZE) return null;
    const x = packX, y = packY;
    packX += w + GUTTER;
    if (h > packRowH) packRowH = h;
    return { x, y };
  }

  // ---- scratch: a measuring context (never resized, size does not matter
  // for measureText) and a rasterising canvas (grown, never shrunk) ----
  const measureCanvas = createScratchCanvas(8, 8);
  const measureCtx = measureCanvas.getContext('2d');
  let rasterCanvas = null, rasterCtx = null, rasterW = 0, rasterH = 0;
  function ensureRasterCanvas(w, h) {
    const nw = Math.max(w, rasterW), nh = Math.max(h, rasterH);
    if (!rasterCanvas || nw > rasterW || nh > rasterH) {
      rasterW = nw; rasterH = nh;
      rasterCanvas = createScratchCanvas(rasterW, rasterH);
      rasterCtx = rasterCanvas.getContext('2d', { willReadFrequently: true });
    }
  }

  // ---- EDT scratch, grown on demand, sized to the largest glyph cell seen ----
  let edtCap = 0, cellCap = 0;
  let colBuf, colD, colV, colZ, rowBuf, rowD, rowV, rowZ;
  let gBuf, fOut, fIn, distOutSq, distInSq, sdfOut;
  function ensureEdtScratch(w, h) {
    const m = Math.max(w, h);
    if (m > edtCap) {
      edtCap = m;
      colBuf = new Float64Array(edtCap); colD = new Float64Array(edtCap);
      colV = new Int32Array(edtCap); colZ = new Float64Array(edtCap + 1);
      rowBuf = new Float64Array(edtCap); rowD = new Float64Array(edtCap);
      rowV = new Int32Array(edtCap); rowZ = new Float64Array(edtCap + 1);
    }
    const n = w * h;
    if (n > cellCap) {
      cellCap = n;
      gBuf = new Float64Array(cellCap);
      fOut = new Float64Array(cellCap); fIn = new Float64Array(cellCap);
      distOutSq = new Float64Array(cellCap); distInSq = new Float64Array(cellCap);
      sdfOut = new Uint8Array(cellCap);
    }
  }

  function edt2d(f, w, h, outSq) {
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) colBuf[y] = f[y * w + x];
      edt1d(colBuf, h, colD, colV, colZ);
      for (let y = 0; y < h; y++) gBuf[y * w + x] = colD[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) rowBuf[x] = gBuf[y * w + x];
      edt1d(rowBuf, w, rowD, rowV, rowZ);
      for (let x = 0; x < w; x++) outSq[y * w + x] = rowD[x];
    }
  }

  // img is the RGBA readback of the scratch canvas; only its alpha, the
  // rasteriser's coverage, is used. fOut is seeded at the ink and fIn at the
  // background, so after the transform distOutSq holds each pixel's squared
  // distance to the ink (non-zero only outside it) and distInSq its squared
  // distance to the background (non-zero only inside). A pixel the outline
  // crosses gets the TinySDF seed: its coverage says how far past the half
  // way mark the edge lies, so its own distance starts at that fraction
  // rather than at zero. The signed result is positive inside, which is the
  // encoding ui.wgsl.js's shadeGlyph decodes: texel = 0.5 + d / (2 * range).
  function computeSDF(img, w, h) {
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const a = img[i * 4 + 3] / 255;
      if (a >= 1) { fOut[i] = 0; fIn[i] = INF; }
      else if (a <= 0) { fOut[i] = INF; fIn[i] = 0; }
      else {
        const o = 0.5 - a, ins = a - 0.5;
        fOut[i] = o > 0 ? o * o : 0;
        fIn[i] = ins > 0 ? ins * ins : 0;
      }
    }
    edt2d(fOut, w, h, distOutSq);
    edt2d(fIn, w, h, distInSq);
    for (let i = 0; i < n; i++) {
      const sd = Math.sqrt(distInSq[i]) - Math.sqrt(distOutSq[i]);
      let t = 0.5 + sd / (2 * SDF_RANGE);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      sdfOut[i] = (t * 255 + 0.5) | 0;
    }
  }

  // ---- the rasterisation queue: a flat array of (weightIndex, code) pairs,
  // drained head-first so nothing here ever splices or shifts ----
  const pendingQueue = [];
  let pendingHead = 0;
  let initialRemaining = 0;
  let isInitialBatch = false;
  let resolveReady;
  const readyPromise = new Promise(res => { resolveReady = res; });

  // The cheap half of onboarding a glyph: measure it, decide whether it has
  // any ink at all, and either mark it ready on the spot (space and its
  // relatives) or queue the expensive half. This is what keeps layout correct
  // the instant a new glyph is seen, even though its atlas region will not
  // exist for a few more frames.
  function touchGlyph(wi, code) {
    if (readStatus(wi, code) !== 0) return;
    measureCtx.font = WEIGHT_FONT[wi];
    measureCtx.textAlign = 'left';
    measureCtx.textBaseline = 'alphabetic';
    const ch = String.fromCodePoint(code);
    const m = measureCtx.measureText(ch);
    const advance = m.width;
    const boxW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const boxH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if (!(boxW > 0.01 && boxH > 0.01)) {
      // no ink: whitespace and the like. Nothing to pack, nothing to wait for.
      storeResult(wi, code, advance, 2, 0, 0, 0, 0, 0, 0, 0, 0);
      return;
    }
    storeResult(wi, code, advance, 1, 0, 0, 0, 0, 0, 0, 0, 0);
    pendingQueue.push(wi, code);
    if (isInitialBatch) initialRemaining++;
  }

  function ensureGlyph(wi, code) {
    if (readStatus(wi, code) === 0) touchGlyph(wi, code);
  }

  // The expensive half: draw the glyph to the scratch canvas, seed the two
  // grids from its coverage, run the distance transform twice, pack it,
  // upload it.
  function rasterizeFull(wi, code) {
    const weightFont = WEIGHT_FONT[wi];
    measureCtx.font = weightFont;
    measureCtx.textAlign = 'left';
    measureCtx.textBaseline = 'alphabetic';
    const ch = String.fromCodePoint(code);
    const m = measureCtx.measureText(ch);
    const advance = m.width;
    const left = m.actualBoundingBoxLeft, ascent = m.actualBoundingBoxAscent;
    const boxW = Math.ceil(left + m.actualBoundingBoxRight);
    const boxH = Math.ceil(ascent + m.actualBoundingBoxDescent);
    const cellW = boxW + PAD * 2, cellH = boxH + PAD * 2;

    ensureRasterCanvas(cellW, cellH);
    if (!rasterCtx) return; // no OffscreenCanvas available; already warned
    rasterCtx.clearRect(0, 0, cellW, cellH);
    rasterCtx.font = weightFont;
    rasterCtx.textAlign = 'left';
    rasterCtx.textBaseline = 'alphabetic';
    rasterCtx.fillStyle = '#fff';
    rasterCtx.fillText(ch, PAD + left, PAD + ascent);

    const img = rasterCtx.getImageData(0, 0, cellW, cellH).data;
    ensureEdtScratch(cellW, cellH);
    const n = cellW * cellH;
    computeSDF(img, cellW, cellH);

    const region = allocRegion(cellW, cellH);
    if (!region) {
      if (!warnedFull) { console.warn('text-atlas: atlas is full, some glyphs will not appear'); warnedFull = true; }
      return; // advance already stored and correct; this glyph just never draws
    }
    device.queue.writeTexture(
      { texture: atlasTexture, origin: { x: region.x, y: region.y } },
      sdfOut.subarray(0, n),
      { bytesPerRow: cellW, rowsPerImage: cellH },
      { width: cellW, height: cellH }
    );

    const u0 = region.x / ATLAS_SIZE, v0 = region.y / ATLAS_SIZE;
    const u1 = (region.x + cellW) / ATLAS_SIZE, v1 = (region.y + cellH) / ATLAS_SIZE;
    const ox = -left - PAD, oy = -ascent - PAD;
    storeResult(wi, code, advance, 2, u0, v0, u1, v1, ox, oy, cellW, cellH);
  }

  // Queue every printable ASCII and Latin-1 codepoint, at all three weights,
  // right now. Only the cheap measuring half runs synchronously; the actual
  // rasterising is left for tick() to spread across frames.
  isInitialBatch = true;
  for (let wi = 0; wi < 3; wi++) {
    for (let code = 0x20; code <= 0x7e; code++) touchGlyph(wi, code);
    for (let code = 0xa0; code <= 0xff; code++) touchGlyph(wi, code);
  }
  isInitialBatch = false;
  if (initialRemaining === 0) resolveReady();

  // Font-level line metrics, measured once per weight at BASE_SIZE. They
  // scale linearly with size for a given font, so lineMetrics() only has to
  // multiply, which keeps the per-frame path free of font strings, TextMetrics
  // objects and canvas work. fontBoundingBox* is the line box; the ink box of
  // 'M' is the fallback for engines that do not report it.
  const baseAscent = new Float32Array(3), baseDescent = new Float32Array(3);
  for (let wi = 0; wi < 3; wi++) {
    measureCtx.font = WEIGHT_FONT[wi];
    const m = measureCtx.measureText('M');
    baseAscent[wi] = m.fontBoundingBoxAscent !== undefined ? m.fontBoundingBoxAscent : m.actualBoundingBoxAscent;
    baseDescent[wi] = m.fontBoundingBoxDescent !== undefined ? m.fontBoundingBoxDescent : m.actualBoundingBoxDescent;
  }

  // Returns whether glyphs are still queued, so the frame loop's chore
  // scheduler (core/chores.js) knows this slice did not finish them.
  function tick(budgetMs) {
    if (pendingHead >= pendingQueue.length) return false;
    const start = platform.now();
    while (pendingHead < pendingQueue.length) {
      const wi = pendingQueue[pendingHead], code = pendingQueue[pendingHead + 1];
      pendingHead += 2;
      rasterizeFull(wi, code);
      if (initialRemaining > 0) {
        initialRemaining--;
        if (initialRemaining === 0) resolveReady();
      }
      if (platform.now() - start >= budgetMs) break;
    }
    if (pendingHead >= pendingQueue.length) { pendingQueue.length = 0; pendingHead = 0; return false; }
    return true;
  }

  // Sums advances (plus a spacing term per glyph, so the same helper serves
  // both the letterSpacing-free public measure() and draw()'s own true-width
  // pass) while quietly onboarding any glyph it has not seen before.
  function computeWidth(wi, scale, str, spacingPx) {
    let width = 0, i = 0;
    const len = str.length;
    while (i < len) {
      let code = str.charCodeAt(i);
      let step = 1;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
        const c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { code = ((code - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000; step = 2; }
      }
      ensureGlyph(wi, code);
      width += readAdvance(wi, code) * scale + spacingPx;
      i += step;
    }
    return width;
  }

  const text = {
    texture: atlasTexture,
    sampler,
    sdfRange: SDF_RANGE,
    baseSize: BASE_SIZE,
    ready: readyPromise,

    measure(str, size, weight) {
      if (!str) return 0;
      return computeWidth(weightIndex(weight), size / BASE_SIZE, str, 0);
    },

    lineMetrics(size, out) {
      // Font-level metrics, not ink metrics: the line box, the same for every
      // string at a given size. It takes no weight, and always has used the
      // regular weight's line box, so it reads the cached regular entry.
      const scale = size / BASE_SIZE;
      out.ascent = baseAscent[1] * scale;
      out.descent = baseDescent[1] * scale;
    },

    draw(dl, str, x, y, size, weight, color, align, letterSpacing, alpha) {
      if (!str) return;
      // A line wholly above or below the clip (a row scrolled out of the
      // drawer or the mixer) is skipped before any per-glyph work. The band
      // is generous: no glyph's quad, padding included, reaches more than
      // 1.25 em above its baseline or 0.6 em below it; 2 px more covers the
      // shader's 1 px quad growth and the scissor's rounding.
      if (dl.culledY(y - size * 1.5 - 2, y + size * 0.75 + 2)) return;
      const wi = weightIndex(weight);
      const scale = size / BASE_SIZE;
      const spacingPx = letterSpacing * size;
      // Only centred and right-aligned text needs its width before the first
      // glyph goes down. Left-aligned text, most of every screen's labels,
      // starts at x, so the extra pass over its glyphs is skipped.
      let startX = x;
      if (align === 1) startX = x - computeWidth(wi, scale, str, spacingPx) / 2;
      else if (align === 2) startX = x - computeWidth(wi, scale, str, spacingPx);

      const dpr = platform.dpr;
      const sy = Math.round(y * dpr) / dpr;

      const useAlpha = alpha < 1;
      if (useAlpha) dl.pushAlpha(alpha);

      let penX = startX, i = 0;
      const len = str.length;
      while (i < len) {
        let code = str.charCodeAt(i);
        let step = 1;
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
          const c2 = str.charCodeAt(i + 1);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) { code = ((code - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000; step = 2; }
        }
        ensureGlyph(wi, code);
        const status = readStatus(wi, code);
        const adv = readAdvance(wi, code);
        if (status === 2) {
          let u0, v0, u1, v1, ox, oy, qw, qh;
          if (code < 256) {
            const arr = boxTab[wi], b = code * 8;
            u0 = arr[b]; v0 = arr[b + 1]; u1 = arr[b + 2]; v1 = arr[b + 3];
            ox = arr[b + 4]; oy = arr[b + 5]; qw = arr[b + 6]; qh = arr[b + 7];
          } else {
            const rec = mapTab[wi].get(code);
            u0 = rec.u0; v0 = rec.v0; u1 = rec.u1; v1 = rec.v1;
            ox = rec.ox; oy = rec.oy; qw = rec.qw; qh = rec.qh;
          }
          if (qw > 0) {
            const gx = penX + ox * scale;
            const gy = sy + oy * scale;
            const sgx = Math.round(gx * dpr) / dpr;
            const sgy = Math.round(gy * dpr) / dpr;
            dl.glyph(sgx, sgy, qw * scale, qh * scale, u0, v0, u1, v1, color, SDF_RANGE);
          }
        }
        penX += adv * scale + spacingPx;
        i += step;
      }

      if (useAlpha) dl.popAlpha();
    },

    // The centre word: draw() centred, but every letter passes through fx
    // first (core/word-fx.js's letterFx) for an offset, scale, rotation,
    // opacity and edge softness of its own. A letter fx leaves alone lands
    // exactly where draw() would put it, pixel snap included, so a word at
    // rest is identical to the plain path. Kept apart from draw() so every
    // other label in the app pays nothing for it. rec, when given, is
    // word-fx's wordLetters: each letter's final quad goes into it for the
    // cloud layer, which seeds its particles on the same ink.
    drawWord(dl, str, x, y, size, weight, color, letterSpacing, alpha, fx, rec) {
      if (!str) return;
      const wi = weightIndex(weight);
      const scale = size / BASE_SIZE;
      const spacingPx = letterSpacing * size;
      const wordW = computeWidth(wi, scale, str, spacingPx);
      const dpr = platform.dpr;
      const sy = Math.round(y * dpr) / dpr;
      // the word's visual middle: the baseline sits below it by about a third
      // of the size, which is all the vertical order in word-fx needs
      const midY = y - size * 0.35;
      const xf = WORD_XF;

      dl.pushAlpha(alpha);
      let penX = x - wordW / 2, i = 0, li = 0;
      const len = str.length;
      while (i < len) {
        let code = str.charCodeAt(i);
        let step = 1;
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
          const c2 = str.charCodeAt(i + 1);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) { code = ((code - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000; step = 2; }
        }
        ensureGlyph(wi, code);
        const status = readStatus(wi, code);
        const adv = readAdvance(wi, code);
        if (status === 2) {
          let u0, v0, u1, v1, ox, oy, qw, qh;
          if (code < 256) {
            const arr = boxTab[wi], b = code * 8;
            u0 = arr[b]; v0 = arr[b + 1]; u1 = arr[b + 2]; v1 = arr[b + 3];
            ox = arr[b + 4]; oy = arr[b + 5]; qw = arr[b + 6]; qh = arr[b + 7];
          } else {
            const rec = mapTab[wi].get(code);
            u0 = rec.u0; v0 = rec.v0; u1 = rec.u1; v1 = rec.v1;
            ox = rec.ox; oy = rec.oy; qw = rec.qw; qh = rec.qh;
          }
          if (qw > 0) {
            const gw = qw * scale, gh = qh * scale;
            const sgx = Math.round((penX + ox * scale) * dpr) / dpr;
            const sgy = Math.round((sy + oy * scale) * dpr) / dpr;
            const gcx = sgx + gw / 2, gcy = sgy + gh / 2;
            fx(li, len, gcx - x, gcy - midY, wordW, size, xf);
            const cx = gcx + xf[0], cy = gcy + xf[1], s = xf[2];
            if (rec && rec.count * 12 < rec.data.length) {
              const r = rec.data, o = rec.count * 12;
              r[o] = cx; r[o + 1] = cy; r[o + 2] = gw * s / 2; r[o + 3] = gh * s / 2;
              r[o + 4] = u0; r[o + 5] = v0; r[o + 6] = u1; r[o + 7] = v1;
              r[o + 8] = xf[3]; r[o + 9] = xf[7]; r[o + 10] = 0; r[o + 11] = 0;
              rec.count++;
            }
            if (xf[4] > 0.002 && s > 0.01) {
              // the halo first, so the letter sits on top of its own haze
              if (xf[6] > 0.01) {
                const hs = s * (1 + 0.9 * xf[6]);
                dl.pushAlpha(xf[4] * 0.35 * xf[6]);
                dl.glyph(cx - gw * hs / 2, cy - gh * hs / 2, gw * hs, gh * hs,
                         u0, v0, u1, v1, color, SDF_RANGE, xf[3], size);
                dl.popAlpha();
              }
              dl.pushAlpha(xf[4]);
              if (s === 1 && xf[0] === 0 && xf[1] === 0 && xf[3] === 0 && xf[5] === 0) {
                dl.glyph(sgx, sgy, gw, gh, u0, v0, u1, v1, color, SDF_RANGE);
              } else {
                dl.glyph(cx - gw * s / 2, cy - gh * s / 2, gw * s, gh * s,
                         u0, v0, u1, v1, color, SDF_RANGE, xf[3], xf[5]);
              }
              dl.popAlpha();
            }
          }
        }
        penX += adv * scale + spacingPx;
        i += step;
        li++;
      }
      dl.popAlpha();
    },

    // The same walk as drawWord with the drawing left out: each letter's
    // final resting quad and atlas cell into rec (word-fx's 12-float letter
    // layout), with drawWord's own pixel snapping, so a recording prepared
    // from this layout lands on exactly the pixels the word will occupy.
    // Returns false while any inked glyph is still waiting on the
    // rasteriser; the caller tries again next frame.
    layoutWord(str, x, y, size, weight, letterSpacing, rec) {
      rec.count = 0;
      if (!str) return false;
      const wi = weightIndex(weight);
      const scale = size / BASE_SIZE;
      const spacingPx = letterSpacing * size;
      const wordW = computeWidth(wi, scale, str, spacingPx);
      const dpr = platform.dpr;
      const sy = Math.round(y * dpr) / dpr;
      let penX = x - wordW / 2, i = 0, ready = true;
      const len = str.length;
      while (i < len) {
        let code = str.charCodeAt(i);
        let step = 1;
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
          const c2 = str.charCodeAt(i + 1);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) { code = ((code - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000; step = 2; }
        }
        ensureGlyph(wi, code);
        const status = readStatus(wi, code);
        const adv = readAdvance(wi, code);
        if (status !== 2) { ready = false; }
        else {
          let u0, v0, u1, v1, ox, oy, qw, qh;
          if (code < 256) {
            const arr = boxTab[wi], b = code * 8;
            u0 = arr[b]; v0 = arr[b + 1]; u1 = arr[b + 2]; v1 = arr[b + 3];
            ox = arr[b + 4]; oy = arr[b + 5]; qw = arr[b + 6]; qh = arr[b + 7];
          } else {
            const rec2 = mapTab[wi].get(code);
            u0 = rec2.u0; v0 = rec2.v0; u1 = rec2.u1; v1 = rec2.v1;
            ox = rec2.ox; oy = rec2.oy; qw = rec2.qw; qh = rec2.qh;
          }
          if (qw > 0 && rec.count * 12 < rec.data.length) {
            const gw = qw * scale, gh = qh * scale;
            const sgx = Math.round((penX + ox * scale) * dpr) / dpr;
            const sgy = Math.round((sy + oy * scale) * dpr) / dpr;
            const r = rec.data, o = rec.count * 12;
            r[o] = sgx + gw / 2; r[o + 1] = sgy + gh / 2; r[o + 2] = gw / 2; r[o + 3] = gh / 2;
            r[o + 4] = u0; r[o + 5] = v0; r[o + 6] = u1; r[o + 7] = v1;
            r[o + 8] = 0; r[o + 9] = 0; r[o + 10] = 0; r[o + 11] = 0;
            rec.count++;
          }
        }
        penX += adv * scale + spacingPx;
        i += step;
      }
      return ready && rec.count > 0;
    },

    tick,
  };

  return text;
}
