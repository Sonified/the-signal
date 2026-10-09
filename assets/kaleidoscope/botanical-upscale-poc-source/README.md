# Botanical atlas 3× proof of concept

The output is `../botanical-atlas-meditation-draft-upscaled-3x-poc.png`:
1536×1536 RGBA, eight columns and eight rows, 192×192 tiles. The production
512×512 atlas is unchanged. The companion manifest preserves all 64 original
identities and triples their pixel coordinates.

The built-in ImageGen tool created `imagegen-texture.png` from the original
atlas. Its native output was 1254×1254; it was not an exact pixel-preserving
super-resolution result. It introduced colored fringe artifacts around the
cutouts. The packer uses its interior photographic texture while taking the
placement and alpha silhouette from the original asset, with the production
loader's alpha cutoff of 40. This avoids substituting generated geometry or
colored matte for the established sprite boundaries.

Fine photographic detail is synthesized. This is a visual POC, not recovered
ground-truth detail. Inspect all 64 motifs before any production replacement.

Rebuild (requires ImageMagick):

```sh
node tools/pack-botanical-upscale-poc.mjs assets/kaleidoscope/botanical-upscale-poc-source/imagegen-texture.png
```

Preview at `/tools/botanical-upscale-poc.html` using `node tools/serve.mjs`.
The preview displays original and enhanced motifs directly at identical 3×
or 6× sizes, and allows dark, white, and green backgrounds. The production
renderer still repacks source atlases into fixed 128-pixel tiles, so it must
support larger packed textures before the new asset can retain its extra
resolution in the live kaleidoscope.

ImageGen final edit prompt:

> Use the original 512×512 Botanical atlas as the authoritative reference.
> Enhance the photographic texture of all 64 motifs, preserving the exact
> 8×8 row-major tile identities, positions, sizes, colors, and orientations.
> Restore believable tiny petal veins, leaf veins, pollen, and natural surface
> texture. Remove colored fringes, isolated colored blobs, opaque white wisps,
> and background debris from the first generated attempt. Keep genuine
> transparent RGBA backgrounds and negative spaces, soft clean cutout edges,
> and original margins. Do not redesign or add motifs, labels, shadows, or
> outlines. Request a 1536×1536 transparent PNG with 192×192 tiles.

The first generated attempt was rejected. Only the selected second attempt is
stored here, with its alpha preserved in the source file. Mechanical packing
produces the exact requested dimensions and restores the original cutouts.
