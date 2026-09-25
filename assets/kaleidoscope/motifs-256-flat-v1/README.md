# Flat botanical kaleidoscope motifs · 256px

`motifs-256.png` is a 1024 × 1024 transparent atlas containing 16 minimal, colorful botanical illustrations. Each tile is exactly 256 × 256 pixels with 20 pixels of internal transparent padding. Read tiles left to right, then down.

Every motif uses a centered `[0.5, 0.5]` anchor and a canonical upward orientation. Tile coordinates and stable identifiers are recorded in `manifest.json`.

## Rebuild

```sh
npm install --prefix /tmp/the-signal-atlas-tools sharp
NODE_PATH=/tmp/the-signal-atlas-tools/node_modules node tools/pack-kaleidoscope-motifs-256.cjs flat
```
