# Botanical atlas: rebuilt-edge 3× POC

Final asset: `../botanical-atlas-meditation-draft-upscaled-3x-edges-v2.png`.
1536×1536, straight RGBA, 8×8 grid, 64 motifs, 192px tiles. Companion
manifest is alongside the PNG. The original asset and first POC are preserved.

The built-in ImageGen tool edited four 4×4 groups to reconstruct the contours
as well as the interiors. These saved quadrant PNGs are untouched generator
outputs, including its low-alpha colored fringe artifacts. The packer uses
foreground contours at alpha >= 200, removes small isolated components, and
resizes each motif with Lanczos to supply narrow final antialiasing. The old
asset supplies placement and extents only; its fuzzy alpha mask is not reused.
Fine texture and contour detail are synthesized and can differ from the source.

Rebuild from the repository root (requires ImageMagick):

```sh
node tools/pack-botanical-edges-poc.mjs assets/kaleidoscope/botanical-upscale-edges-v2-source/quadrant-{0,1,2,3}.png
```

Compare `/tools/botanical-upscale-poc.html` on dark, white, and green backgrounds.

Prompt used for each group:

> Rebuild the blurry, stair-stepped outlines of this 4×4 botanical sheet into
> crisp high-resolution natural photographic cutouts. Preserve every motif's
> identity, position, orientation, color, size, and interior texture. Reconstruct
> delicate serrated leaf margins, thin stems, petal tips, and natural gaps, with
> tight antialiasing rather than a broad fuzzy alpha halo. Keep the original
> overall shape and margins. Exactly 16 motifs in their original cells. True
> transparent RGBA, no matte, colored fringe, shadows, glow, detached debris,
> labels, grid lines, or background fill. Request 1536×1536 output.

Native generated groups were 1254×1254; mechanical packing makes the final
atlas exactly 1536×1536. Petal comparison was reviewed in Chrome on both dark
and white backgrounds; all 64 motifs were inspected in the packed sheet.
