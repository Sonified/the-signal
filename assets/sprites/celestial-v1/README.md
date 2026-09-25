# Celestial sprite studies

Open `/sandbox/sprites.html` through the project's HTTP server to preview both animations.

| Sheet | Tile size | Sheet size | Frames | Playback |
| --- | --- | --- | --- | --- |
| `star-shimmer-64.png` | 64 × 64 | 512 × 128 | 16 | 12 fps, 1.33 seconds |
| `lotus-bloom-128.png` | 128 × 128 | 1024 × 512 | 32 | 8 fps, 4 seconds |

Both PNGs preserve alpha transparency. Read tiles left to right, then down, in eight-column rows. The twinkle contains a complete 16-frame rise-and-fall performance. The lotus plays its 16 source frames forward and backward. Playback metadata is in `manifest.json`.

Original generated artwork is preserved in `source/`. These are art prototypes; generated details may shift between frames.

## Rebuild

From the repository root, install the packing dependency outside the project and run:

```sh
npm install --prefix /tmp/the-signal-atlas-tools sharp
NODE_PATH=/tmp/the-signal-atlas-tools/node_modules node tools/pack-sprite-atlases.cjs
```

This regenerates both atlases and their manifest from the saved sources.

## Future studies

Swirling confetti, orbiting pollen, breathing halos, turning light spirals, and opening luminous gates.
