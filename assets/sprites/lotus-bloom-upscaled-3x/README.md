# Blooming opal lotus: 3× POC

All files are in this shared repository directory:
`assets/sprites/lotus-bloom-upscaled-3x/`.

| File | Layout | Cell size | Meaning |
| --- | --- | --- | --- |
| `lotus-bloom-960.png` | 3840×3840, 4×4 | 960×960 | 16 unique opening frames; master for the live flower renderer, 3× its existing 320px cells |
| `lotus-bloom-384.png` | 3072×1536, 8×4 | 384×384 | 32 physical frames, opening then closing; 3× the existing packed 128px animation |
| `manifest.json` | metadata | — | Dimensions, hashes, placement, and original frame sequence |

Both outputs use straight RGBA and sRGB. Read frames left to right, then down.
The sequence is `0..15, 15..0`, at 8 fps: a four-second loop, retaining the
endpoint holds in the original. In the 384px packed export that sequence is
already baked into physical frames 0..31; play those in order, without a second
ping-pong reversal. The master stores only the 16 opening frames and needs the
32-step sequence supplied by the renderer.

The built-in ImageGen tool reconstructed interior texture and contours in four
2×2 groups. Its native outputs are 1254×1254, preserved in `source/`. Each frame
is packed to match the original source frame's position and extent; original
alpha is not enlarged to form the final edge. The packer uses the generated
foreground at alpha >= 200, keeps the connected flower body, and performs
Lanczos resizing for a narrow antialiased boundary. Fine detail is synthesized,
and its texture and rim highlights can vary between frames. This is a visual
POC; it is not an exact recovery of photographic detail.

Original assets and production flower rendering are unchanged by this POC.

## Integration handoff

The current `gpu/flowers.js` reads the 4×4 source atlas, not the packed 128px
export. Use the **960px master** for that renderer. Update `SHEET_URL` to
`assets/sprites/lotus-bloom-upscaled-3x/lotus-bloom-960.png` and `CELL` to 960,
which makes `ATLAS` 3840. Update `CELL_TEXELS` in `gpu/flowers.wgsl.js` to 960
so its mip LOD calculation matches the texture. Keep `GRID = 4`, `FRAMES = 16`,
`BASE_FPS = 8`, and the existing 32-step sequence. Seven mip levels still have
integer cell boundaries (960 down to 15). The current loader copies at most
`CELL` pixels; changing just the image URL would crop the larger frames.

The master texture is about 75 MiB including those mip levels, so account for
this when deciding whether to offer it as a quality option.

## Review and rebuild

Animation comparison: `/tools/lotus-upscale-poc.html` through the project server.
It supports play/pause, all 32 steps, frame blending, and dark/white/green
backgrounds. It uses the original source as its baseline rather than the small
128px export.

Rebuild from the repo root (requires ImageMagick):

```sh
node tools/pack-lotus-upscale-poc.mjs assets/sprites/lotus-bloom-upscaled-3x/source/quadrant-{0,1,2,3}.png
```

The four source groups correspond to top-left, top-right, bottom-left, and
bottom-right quadrants of the original 4×4 sheet. The manifest records every
frame's original and final placement bounds.

## ImageGen prompt

> Use case: precise-object-edit / background-extraction.
> Asset type: four frames from an existing blooming opal lotus sprite animation.
> Edit target: attached 2-by-2 sheet. Exactly four frames, same layout, one lotus per cell.
> Primary request: high-resolution 3x super-resolution reconstruction of the existing frames. Sharpen the gold filigree rim, smooth curved petal boundaries, opalescent lavender/pearl surfaces and blue/pink iridescence. Preserve the exact opening stage in EACH cell, its petal count, overlaps, silhouette, orientation, placement, lighting, palette and flower size. These are sequential animation frames of the same flower; do not redesign, add petals, change the opening angle, or normalize them to the same pose.
> Transparent RGBA cutouts: fully transparent surrounding space and natural narrow antialiasing, no broad fuzzy halo, black/white matte, colored fringe, shadows, detached sparks, debris or glow outside the flower. Interior golden luminous centre stays inside the petals. Preserve the consistent centre anchor across frames.
> Keep all four source identities in their exact 2x2 positions. No labels, borders, grid lines, added objects or background. Deliver a 2048x2048 transparent PNG with detailed polished opal material.
