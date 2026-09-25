# Image-generation prompts

Mode: built-in `image_gen`. Original RGBA outputs are preserved in `source/`; the atlas packer only crops, resizes, and arranges them.

## Celestial twinkle v2

```text
Use case: stylized-concept
Asset type: production transparent PNG animation sprite sheet for a wellness / spiritual future-tech interface
Input image: edit target; retain only its exact 4-by-4 sprite-sheet layout and transparent canvas concept. Completely replace the artwork.
Primary request: Create sixteen distinct sequential animation frames of one elegant twinkling sparkle, inspired by the visual language of the sparkle emoji but original and refined. The animation must feel like a real twinkle, not one static shape being uniformly scaled. Across the frames, animate the geometry: begin with a nearly invisible pinprick; grow one long vertical ray first; snap into a crisp asymmetric four-point diamond flare; let the horizontal ray catch up; briefly split the highlights into layered needle-like rays; introduce two or three tiny companion glints that orbit or flicker at different positions; add a subtle prismatic lavender-and-warm-gold shimmer along the ray edges; then collapse the rays in a different order and finish as a fading pinprick. Every frame should have visibly different ray lengths, proportions, highlight placement, and companion glints so motion reads as articulation and shimmer rather than scale.
Scene/backdrop: genuine alpha transparency in every tile, no colored or black background
Style/medium: polished luminous 2D/3D hybrid icon animation, celestial, elegant, minimal, stylized, premium wellness technology; clean sparkle-emoji readability at 64 by 64 pixels
Composition/framing: exact 4 columns by 4 rows, row-major chronological frames, identical tile sizes, sparkle centered at the same anchor point in every tile, generous transparent padding, no grid lines, no gutters, no labels
Lighting/mood: radiant yet delicate, warm pearl-white core with restrained opal lavender and champagne-gold diffraction
Constraints: actual transparent alpha; sixteen separate frames; smooth coherent animation sequence; center anchor locked; strong silhouette changes; readable when reduced to 64x64; frame 1 and frame 16 nearly invisible; no text, numbers, borders, checkerboards, drop shadows, or background
Avoid: circular orb, bubble, medallion, flower, ring, mandala, growing ball, uniform scaling, duplicated identical frames, noisy particles, cloudy blobs, red fringe, yellow fringe, opaque background, sprite-sheet labels
```
