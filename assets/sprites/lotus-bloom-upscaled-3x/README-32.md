# Stabilized 32-frame blooming lotus

Files are physically saved in this shared repository directory:
`/Users/robertalexander/GitHub/the-signal/assets/sprites/lotus-bloom-upscaled-3x/`.

| File | Layout | Contents |
| --- | --- | --- |
| `lotus-bloom-960-stable-32.png` | 7680 × 3840, 8 columns × 4 rows, 960px cells | High-resolution opening atlas |
| `lotus-bloom-384-stable-32.png` | 3072 × 1536, 8 × 4, 384px cells | Smaller opening atlas, 24px padding |
| `lotus-bloom-384-stable-64-loop.png` | 3072 × 3072, 8 × 8, 384px cells | Complete opening/closing loop already packed in playback order |
| `manifest-32.json` | Metadata | Playback sequence, dimensions, anchors, provenance and SHA-256 hashes |

There are 16 unchanged stabilized keyframes, 15 new halfway poses, and one
full-bloom endpoint hold: **32 opening frames, 31 distinct poses**. Keyframe
`i` occupies opening slot `2*i`; new poses occupy slots 1, 3, …, 29. Slot 31
holds slot 30. Read cells left to right, then down. All exports are straight
RGBA, sRGB, with transparent backgrounds.

The 64-step opening/closing loop runs at **16 fps**, retaining the original
four-second duration. For either opening atlas use the explicit sequence
`0..31, 30..0, 0`. For the 64-frame packed loop simply play physical frames
`0..63` in order at 16 fps. Do not reverse that packed loop again.

The master base-petal registration anchor remains `(480, 801)`, normalized
`(0.5, 0.834375)`. Vertical registration is exact and horizontal registration
is within half a master pixel. The 384px exports retain their old crop/inset;
the corresponding normalized anchor is `(0.5, 0.7981687898)`.

## Preview

Open `http://localhost:8011/tools/lotus-tweens-poc.html` with the existing
project server, or run `node tools/serve.mjs` from the repository root.
The comparison keeps both animations synchronized, supports scrubbing all 64
loop steps, and has dark/white/green backgrounds. Frame blending is off by
default so the new baked poses can be inspected directly.

## Method and limits

The original 3× artwork was reconstructed with the built-in ImageGen tool.
For this animation extension, four further ImageGen halfway-pose sheets were
tried but rejected because some petals opened beyond their adjacent endpoint
and then snapped back. Those experimental outputs are in `source/tweens/`;
**they are not used in the final 32-frame atlases**.

The final in-betweens use bidirectional local macOS Vision optical flow
(revision 2, veryHigh). Existing textures and alpha are warped halfway along
estimated motion, synthesized in premultiplied RGBA, converted back to straight
RGBA, and registered to the fixed base. This is motion-based interpolation,
not just a crossfade of unwarped frames. No runtime interpolation dependency
is introduced; all output frames are baked PNGs.

Rapidly revealed petals can retain some ghosting in paused intermediate poses;
optical flow cannot perfectly recover hidden petal geometry from these flat
keyframes. This remains an animation proof of concept for visual review.
Vision API: [Apple documentation](https://developer.apple.com/documentation/vision/vngenerateopticalflowrequest).

## Integration for the other agent

Production flower rendering has not been changed. For `gpu/flowers.js`, use
the 960px opening atlas and change the atlas layout to **8 columns, 4 rows**,
32 frames, 16 fps and the explicit 64-step sequence above. The current loader
assumes a square 4 × 4 grid; its crop logic, destination row stride and texture
size must use the rectangular dimensions 7680 × 3840. Changing only the URL
would crop/misaddress the art.

In `gpu/flowers.wgsl.js`, set `CELL_TEXELS = 960.0` and map cells with:

```wgsl
return (vec2f(f32(f & 7u), f32(f >> 3u)) + local) * vec2f(0.125, 0.25);
```

Replace assumptions about 16 frames and a 32-step cycle in both CPU and shader
playback code. Prefer the manifest sequence so the endpoint holds stay correct.
Seven mip levels retain integer cell boundaries. The large master uses about
150 MiB including mips; the smaller 384px opening atlas uses about 24 MiB.
Check `maxTextureDimension2D >= 7680` when choosing the master quality option.

## Rebuild

Requires macOS with Swift/Vision and ImageMagick. Run in a normal local terminal
from the repository root:

```sh
node tools/pack-lotus-tweens.mjs --motion
```

`tools/lotus-motion-interpolation.mjs` compiles the local
`tools/lotus-optical-flow.swift` helper and keeps temporary frame/flow files
under the system temporary directory. It performs no network requests.
The packer checks original keyframe equality, intermediate uniqueness,
registration without clipping, and original timing at every second loop step.

## Rejected ImageGen attempt: exact prompt

Built-in tool mode, transparent background, two 2 × 2 reference sheets per call:
start poses and their matching end poses. Four calls covered 0→1 through 14→15;
the extra 15→15 output was unused.

```text
Use case: precise-object-edit / compositing.
Asset: in-between frames for an existing opal lotus opening animation.
Input image 1: a 2x2 sheet of four START keyframes. Input image 2: a 2x2 sheet of their corresponding END keyframes, one animation step later. Each matching cell is a pair; do not compare different cells.
Produce a 2x2 sheet with exactly FOUR new HALF-WAY poses. For each cell, interpolate the corresponding lotus petal geometry exactly halfway between input 1 and input 2. Move the same petal tips and gold seams into intermediate positions, respecting the existing overlaps; keep the flower halfway open. Each cell must contain ONE coherent flower with ONE contour per petal, not overlapping copies of the start and end images.
Critical invariants: preserve the opal lotus identity, existing number of petals, front base petal, gold rims, lavender/pearl/blue/pink palette, iridescent surface texture, light level and the centre anchor. Do not redesign or embellish, thicken the gold rims, brighten highlights, add sparkles, change the camera, introduce rotation, or make petals more open than the end frame. The bottom centre remains fixed in every cell.
Exact 2x2 cell layout from the references, transparent RGBA surrounding space, crisp antialiased edges. No glow outside contours, background, white/black matte, colored fringes, detached debris, labels or grid lines. Request 2048x2048 transparent PNG. The desired output is geometric animation in-betweening, not a color crossfade or a new illustration.
```
