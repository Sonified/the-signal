# Kaleidoscope motifs v1

`motifs-128.png` is a 1024 × 1024 transparent atlas containing 64 static motifs. Each tile is exactly 128 × 128 pixels with 12 pixels of internal transparent padding. Read tiles left to right, then down.

Every motif uses a centered `[0.5, 0.5]` anchor and a canonical upward orientation. Tile coordinates and names are recorded in `manifest.json`.

The collection moves from leaves and flowers through celestial, sky, botanical, candy, natural-treasure, and abstract-light motifs. The source generation is preserved in `source/`.

## Rebuild

```sh
npm install --prefix /tmp/the-signal-atlas-tools sharp
NODE_PATH=/tmp/the-signal-atlas-tools/node_modules node tools/pack-kaleidoscope-motifs.cjs
```
