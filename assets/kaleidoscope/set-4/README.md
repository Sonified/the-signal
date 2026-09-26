# Kaleidoscope set 4: Ferns and wildflower petals

`set-4-128.png` is a 1024 × 1024 transparent atlas of 32 fern leaflets and 32 wildflower petals, each centred in a 128 × 128 tile with at least 12 px of transparent padding. Read tiles left to right, then down; names are in `manifest.json`. It is Image set 4 in the kaleidoscope (`v1/gpu/kaleido.js` ATLAS_SETS).

The generated sheet in `source/` is 1254 px, so its 8 × 8 cells are not whole pixels and a few shapes cross a cell line. It is packed by component instead of by fixed crop: each shape is its connected pixels, assigned to the cell its centre falls in, and the faint matte left by the background removal is dropped. One scale for the whole sheet keeps the shapes' sizes relative to each other.

## Rebuild

```sh
npm install --prefix /tmp/the-signal-atlas-tools sharp
NODE_PATH=/tmp/the-signal-atlas-tools/node_modules node tools/pack-kaleidoscope-motifs.cjs ferns-wildflower-petals
```
