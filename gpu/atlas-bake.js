// The motif atlas's pass from a sheet's pixels to the premultiplied image a
// layer uploads, shared by the kaleidoscope (gpu/kaleido.js, whose notes say
// why each step is there) and the brush (gpu/brush.js), so the two build the
// very same atlas from a sheet and the browser's saved bake of it
// (platform loadImageBaked, keyed by bakeTag) serves both.
//
// The pass: a square 8 x 8 sheet of any size is first repacked into the
// layout's tile, each source tile scaled into the inner square with the
// padding left transparent; then every pixel that is not solid takes its
// colour from the nearest solid pixel of its own motif (a wave of neighbour
// dilation outward from the body), anything still close to invisible goes
// fully transparent, and the result is premultiplied, each motif's painted
// share of its inner square measured on the way (its fill; an empty tile
// measures 0). Both halves yield between tiles, so the million-pixel pass
// never lands as one long stall mid strobe, and give up (resolve to null) as
// soon as stale() says another sheet was asked for meanwhile.

import { MIP_WGSL } from './flowers.wgsl.js';

export const GRID = 8;                     // every atlas is an 8 x 8 tile sheet
export const MOTIFS = GRID * GRID;
export const SOLID = 200;                  // alpha at or above this keeps its own colour
export const ALPHA_CUT = 40;               // alpha below this goes fully transparent
export const BAKE_VERSION = 1;             // up when the atlas pass (repack, colour bleed, cut) changes, so kept bakes are rebuilt

// The packed layouts an atlas is built into: its tile, the transparent
// padding round each motif and the inner square inside it that the quad
// covers (see kaleido.wgsl.js), the atlas's side, its mip levels, whether a
// sheet already that size is taken as already in the layout (otherwise it
// is always repacked), and the same as UV for the shader. A motif's fill is
// measured against its own layout's inner square, as a share, so the
// coverage solve reads both layouts alike.
export function atlasLayout(tile, pad, mips, prepadded) {
  const atlas = tile * GRID, inner = tile - 2 * pad;
  return Object.freeze({ tile, pad, inner, atlas, mips, prepadded,
                         padUV: pad / atlas, innerUV: inner / atlas, halfTexel: 0.5 / atlas });
}
// Every ordinary set: 128 px tiles round a 104 px motif, 1024 square, as
// the 128 px sheets come. Mips 1024 down to 128. The 12 px padding is still
// a texel and a half at the last of these, which with the shader's clamp
// keeps every tap inside its own motif; below it the padding runs out and
// neighbours would bleed.
export const LAYOUT_STD = atlasLayout(128, 12, 4, true);
// A high resolution sheet: the same proportions half again as large, 192 px
// tiles round a 156 px motif with 18 px of padding, 1536 square, so a
// motif's framing in its quad is the same in both and only its detail
// changes. The sheet's 192 px tiles are whole motifs with their own margin
// (as the 64 px tiles of set 1's ordinary sheet are), so it is always
// repacked, each tile scaled into the inner square. One mip level more,
// 1536 down to 96 (192 px tiles halve cleanly at every level), so a
// far-off motif is never sampled coarser than an ordinary set's smallest;
// the 18 px padding is still 1.125 texels at the last, and the shader's
// clamp sits half a texel inside the motif, so a bilinear tap is 1.16
// texels from the tile's edge there and stays inside its own motif.
export const LAYOUT_HI = atlasLayout(192, 18, 5, false);

// The record a finished atlas is kept under in the browser: tied to the
// numbers the pass depends on, BAKE_VERSION going up when the pass itself
// changes. The file's own bytes are checked by the platform.
export function bakeTag(L) {
  return 'kaleido' + BAKE_VERSION + ':' + [L.atlas, L.tile, L.inner, L.pad, SOLID, ALPHA_CUT].join('/');
}

// A square 8 x 8 atlas of any other size, repacked into layout L (the
// 1024 px one for an ordinary set): each source tile scaled to fill its
// tile's inner square (104 px there), with the padding left transparent.
// Bilinear, weighted by alpha so transparent texels lend no colour to the
// edge, and clamped to the source tile so neighbours never bleed in. It
// yields after every tile, as the cleanup below does, so the repack never
// lands as one long stall mid strobe; null if another set was asked for
// meanwhile.
async function repack(img, L, stale, yieldTile) {
  const T = img.width / GRID, src = img.data;
  const TILE = L.tile, ATLAS = L.atlas, MOTIF_INNER = L.inner, MOTIF_PAD = L.pad;
  const out = new Uint8ClampedArray(ATLAS * ATLAS * 4);
  const step = T / MOTIF_INNER;
  for (let t = 0; t < MOTIFS; t++) {
    const sx0 = (t % GRID) * T, sy0 = ((t / GRID) | 0) * T;
    const dx0 = (t % GRID) * TILE + MOTIF_PAD, dy0 = ((t / GRID) | 0) * TILE + MOTIF_PAD;
    for (let y = 0; y < MOTIF_INNER; y++) {
      let fy = (y + 0.5) * step - 0.5;
      if (fy < 0) fy = 0; else if (fy > T - 1) fy = T - 1;
      const y0 = fy | 0, y1 = y0 < T - 1 ? y0 + 1 : y0, wy = fy - y0;
      for (let x = 0; x < MOTIF_INNER; x++) {
        let fx = (x + 0.5) * step - 0.5;
        if (fx < 0) fx = 0; else if (fx > T - 1) fx = T - 1;
        const x0 = fx | 0, x1 = x0 < T - 1 ? x0 + 1 : x0, wx = fx - x0;
        const i00 = ((sy0 + y0) * img.width + sx0 + x0) * 4, i10 = ((sy0 + y0) * img.width + sx0 + x1) * 4;
        const i01 = ((sy0 + y1) * img.width + sx0 + x0) * 4, i11 = ((sy0 + y1) * img.width + sx0 + x1) * 4;
        const w00 = (1 - wx) * (1 - wy) * src[i00 + 3], w10 = wx * (1 - wy) * src[i10 + 3];
        const w01 = (1 - wx) * wy * src[i01 + 3], w11 = wx * wy * src[i11 + 3];
        const wa = w00 + w10 + w01 + w11;
        const di = ((dy0 + y) * ATLAS + dx0 + x) * 4;
        if (wa <= 0) continue;
        out[di]     = (src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11) / wa;
        out[di + 1] = (src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11) / wa;
        out[di + 2] = (src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11) / wa;
        out[di + 3] = wa;   // the plain bilinear alpha: the weights sum to 1
      }
    }
    await yieldTile();
    if (stale()) return null;
  }
  return { width: ATLAS, height: ATLAS, data: out };
}

// The slow half of an atlas: the repack, the colour bleed and the cut,
// yielding between tiles. Resolves to the finished pixels and each motif's
// painted share ({ out, fill }, what loadImageBaked keeps), or null if
// another set was asked for meanwhile (stale) or the sheet is not a square
// 8 x 8 one.
export async function bakeAtlasPixels(img, L, stale, yieldTile) {
  // Everything below works in this sheet's own layout.
  const TILE = L.tile, ATLAS = L.atlas;
  if (!L.prepadded || img.width !== ATLAS || img.height !== ATLAS) {
    if (img.width !== img.height || img.width % GRID) {
      console.warn('kaleido: expected a square atlas of 8 x 8 tiles, got ' + img.width + ' x ' + img.height);
      return null;
    }
    img = await repack(img, L, stale, yieldTile);
    if (!img) return null;
  }
  const src = img.data;
  // Measured into its own list and copied over at the swap, so the atlas
  // still drawing keeps its own fill figures while this one builds.
  const fill = new Float32Array(MOTIFS);
  const out = new Uint8Array(ATLAS * ATLAS * 4);
  const TT = TILE * TILE;
  const state = new Uint8Array(TT);     // 0 unreached, 1 in the current wave, 2 coloured
  const rgb = new Uint8Array(TT * 3);
  let cur = new Int32Array(TT), nxt = new Int32Array(TT);

  for (let t = 0; t < MOTIFS; t++) {
    const tx = (t % GRID) * TILE, ty = ((t / GRID) | 0) * TILE;

    // Seed the waves from the solid body, and count the pixels that will
    // survive the cut but still need a colour; once those are all reached
    // the rest of the tile does not matter (premultiplied, it is zero).
    state.fill(0);
    let nCur = 0, need = 0;
    for (let y = 0; y < TILE; y++) {
      let si = ((ty + y) * ATLAS + tx) * 4;
      for (let x = 0; x < TILE; x++, si += 4) {
        const li = y * TILE + x, a = src[si + 3];
        rgb[li * 3] = src[si]; rgb[li * 3 + 1] = src[si + 1]; rgb[li * 3 + 2] = src[si + 2];
        if (a >= SOLID) { state[li] = 2; cur[nCur++] = li; }
        else if (a >= ALPHA_CUT) need++;
      }
    }

    // Each wave takes the ring of pixels one step (8-connected) further
    // from the body and gives each the average colour of its neighbours
    // already coloured, so a pixel ends up with the colour of the body
    // nearest to it, blended where two parts of the motif are equally near.
    while (need > 0 && nCur > 0) {
      let nNext = 0;
      for (let i = 0; i < nCur; i++) {
        const li = cur[i], x = li % TILE, y = (li / TILE) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= TILE) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= TILE) continue;
            const ni = yy * TILE + xx;
            if (state[ni] === 0) { state[ni] = 1; nxt[nNext++] = ni; }
          }
        }
      }
      for (let i = 0; i < nNext; i++) {
        const li = nxt[i], x = li % TILE, y = (li / TILE) | 0;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= TILE) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= TILE) continue;
            const ni = yy * TILE + xx;
            if (state[ni] !== 2) continue;
            r += rgb[ni * 3]; g += rgb[ni * 3 + 1]; b += rgb[ni * 3 + 2]; n++;
          }
        }
        if (n) { rgb[li * 3] = Math.round(r / n); rgb[li * 3 + 1] = Math.round(g / n); rgb[li * 3 + 2] = Math.round(b / n); }
      }
      for (let i = 0; i < nNext; i++) {
        const li = nxt[i];
        state[li] = 2;
        const a = src[((ty + ((li / TILE) | 0)) * ATLAS + tx + (li % TILE)) * 4 + 3];
        if (a >= ALPHA_CUT && a < SOLID) need--;
      }
      const sw = cur; cur = nxt; nxt = sw; nCur = nNext;
    }

    // Cut and premultiply into the atlas, summing the surviving alpha as
    // the motif's painted share of the square its quad covers (the
    // padding is transparent, so summing the whole tile is the same).
    let painted = 0;
    for (let y = 0; y < TILE; y++) {
      let si = ((ty + y) * ATLAS + tx) * 4;
      for (let x = 0; x < TILE; x++, si += 4) {
        const a = src[si + 3];
        if (a < ALPHA_CUT) continue;          // matte and speckle: leave it transparent
        const li = (y * TILE + x) * 3, k = a / 255;
        out[si] = Math.round(rgb[li] * k);
        out[si + 1] = Math.round(rgb[li + 1] * k);
        out[si + 2] = Math.round(rgb[li + 2] * k);
        out[si + 3] = a;
        painted += k;
      }
    }
    fill[t] = Math.min(1, painted / (L.inner * L.inner));
    // Yield after every tile, not every row: a row of eight dilations is
    // several milliseconds of main thread, a dropped strobe frame each.
    await yieldTile();
    if (stale()) return null;      // another set was asked for meanwhile
  }
  return { out, fill };
}

// The mip chain under a finished atlas: one small render pass per level,
// each reading the level above it, as flowers.js builds its chain. 128 px
// tiles (and 192 px ones) halve cleanly at every level here, so a 2 x 2 box
// never straddles two motifs. The texture must be rgba8unorm with
// RENDER_ATTACHMENT among its usages.
export function buildAtlasMips(device, tex, levels) {
  const mipMod = device.createShaderModule({ label: 'atlas.mip', code: MIP_WGSL });
  const mp = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: mipMod, entryPoint: 'vs' },
    fragment: { module: mipMod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' }
  });
  const enc = device.createCommandEncoder();
  for (let l = 1; l < levels; l++) {
    const srcView = tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 });
    const dstView = tex.createView({ baseMipLevel: l, mipLevelCount: 1 });
    const bg = device.createBindGroup({ layout: mp.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcView }] });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: dstView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
    });
    pass.setPipeline(mp);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }
  device.queue.submit([enc.finish()]);
}
