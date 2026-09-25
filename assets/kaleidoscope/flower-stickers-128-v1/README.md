# Flower stickers · 128px

`flower-stickers-128.png` is a 1024 × 1024 transparent atlas containing 64 colorful children’s flower stickers. Each tile is exactly 128 × 128 pixels with internal transparent padding. Read tiles left to right, then down.

Every sticker uses a centered `[0.5, 0.5]` anchor and a canonical upward orientation. Tile coordinates and stable identifiers are recorded in `manifest.json`.

## Rebuild

```sh
npm install --prefix /tmp/the-signal-atlas-tools sharp
NODE_PATH=/tmp/the-signal-atlas-tools/node_modules node tools/pack-kaleidoscope-motifs.cjs flower-stickers
```
