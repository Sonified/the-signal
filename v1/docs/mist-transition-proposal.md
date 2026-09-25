# Word transitions: condense from mist, dissolve into mist

Status: proposed design; no runtime changes in this document.

## The intended feeling

The word should feel like a temporary concentration of a gently moving mist.
Before arrival, a few thin, connected wisps drift and curl through the space.
Parts of those wisps become denser and resolve into letter strokes. The word
then holds perfectly still and clear. On departure, patches of its strokes
soften, lift, stretch into wisps, and disperse into the surrounding air.

The motion should be slow enough to follow a curl with your eye. Neighbouring
parts of the mist travel together, stretch apart, and fold around one another.
There should be open space between filaments, quiet changes of direction,
and a soft tail after the word disappears. Avoid an explosion, a vacuum,
glitter, a swarm of points, or a solid fog-shaped rectangle.

This proposal targets the text **Arrive / Leave → Cloud** effect found in the
current repo. It does not change the separate background particle layer.

## Why the current mechanism can look wrong

This is a source-code diagnosis, not a claim that a browser recording has
been reviewed.

- [`../gpu/word-cloud.wgsl.js`](../gpu/word-cloud.wgsl.js) already integrates
  particle positions through a time-varying curl field. The missing ingredient
  is not simply “add curl noise.”
- `seedMain` assigns each particle a particular point inside the word, then
  scatters arriving particles into an oval around it.
- `simMain` applies attraction toward that point and enforces `cageR`: anything
  outside its shrinking radius is projected onto the boundary. This directly
  changes position regardless of the flow. It can turn arrival into visible
  contraction toward a set of destinations, even when velocity is swirling.
- `vsCloud` / `fsCloud` draw circular Gaussian dots with additive light. More
  points or more blur can make a brighter cloud without making connected,
  stretching wisps.
- [`../core/word-fx.js`](../core/word-fx.js) fades each whole letter into the
  cloud. There is no shared, spatially varying material boundary where an
  individual stroke turns into mist.
- [`../gpu/word-cloud.js`](../gpu/word-cloud.js) reseeds on arrival/departure
  and runs only while a letter reports an active cloud transition. That ties
  the mist's lifecycle to the letter transition rather than letting released
  wisps finish their motion.

## Proposed approach: flowing density with local material transfer

Use a small, persistent mist density field around the word. Advect that field
through a smooth shared velocity field. Let the text exchange visibility with
the mist locally. No mist element needs a permanent destination on a glyph.

The essential change is **material transfer instead of position capture**.
Arrival does not require every bit of smoke to land. Mist passing through a
letter's space becomes a readable stroke; the unused mist continues drifting
and thinning. Departure releases density from the disappearing strokes into
the same moving air.

### 1. Give the air continuous motion

Start by reusing the existing curl field as a prescribed velocity field, with
a gentle common drift, broad rolling eddies, and weaker smaller curls. Sample
it in a stable CSS-pixel coordinate system with a continuous clock. Nearby
samples must share their motion; avoid independent random headings per dot.

Separate eddy size, flow speed, and transition duration. A longer transition
should reveal more of the same calm motion, not multiply its speed. Use a
small upward bias on released mist if it helps the look, without making every
departure an identical vertical plume.

A full fluid solver is not the first step. A prescribed curl field can drive
useful advection without pressure projection. Its divergence-free property
alone does not guarantee a convincing smoke appearance: density structure,
time continuity, and rendering still matter.

### 2. Render connected density, not visible dots

Maintain two reusable density textures for ping-pong advection. Backtrace
through the velocity field and sample the previous density, then apply slow
dissipation. Conceptually:

```text
previousPosition = backtrace(position, velocity, dt)
transported = sample(previousDensity, previousPosition) * exp(-decay * dt)
nextDensity = max(0, transported + emittedDensity - locallyAbsorbedDensity)
```

Use midpoint backtracing rather than changing position by an arbitrary
transition-dependent offset. Seed several sparse, elongated bands and let
advection deform them. Use quiet spatial variation in emission and local
breakup, rather than filling an oval uniformly or displaying a noise map as
the final cloud.

A small amount of diffusion can soften filaments; too much becomes a blur
blob. Basic semi-Lagrangian advection also loses fine detail numerically.
Watch that loss before adding extra blur. If necessary, later evaluate a
bounded higher-order advection method, with overshoot clamping.

Render density with a soft response such as `alpha = 1 - exp(-extinction *
density)`, then composite premultiplied color over the scene. Tune against
both dark and bright backgrounds. Do not use unrestricted additive dots as
the main smoke body. Tiny tracers may help diagnose motion, but should be
hidden in the final effect.

### 3. Arrival: let mist become strokes

Prepare a word-local ink mask from the existing glyph SDFs. Also maintain a
smooth formation mask that varies across space, not just across letters.
Correlate its irregular boundary with a slowly advected control field and
local mist density. Drive its overall completion with transition progress.

At a forming patch, reduce nearby mist as the corresponding ink becomes
visible. Keep this conversion close to the glyph; do not create a long-range
attractor. Some mist should pass across the word and continue onward.

Suggested first timing, expressed as fractions of the configured arrival:

| Progress | Visual event |
| --- | --- |
| 0–25% | Faint, already-moving wisps become visible; no readable word yet. |
| 20–80% | Uneven patches condense into recognizable strokes. |
| 75–100% | Remaining strokes settle to full clarity; surplus mist thins. |

Make formation completion deterministic. Density may bias when a patch
forms, but a low-density patch must not leave a permanent hole in the word.
By the end of arrival, the ink mask is complete and still. Blend any remaining
small gaps in smoothly over the final interval; do not snap positions.

Use a bounded warm-up or an already-evolved initial density state so the
first visible frame has flow structure. Spread preparation across frames
where possible; never hide a large simulation burst in a frame deadline.

### 4. Departure: release strokes into flowing wisps

Use a separate, spatially coherent erosion mask to remove patches of ink.
Emit mist exactly where ink coverage decreased in that update. The source
amount comes from the change in coverage, not a fresh fixed amount every
frame. This avoids frame-rate-dependent emission and repeated brightening.

Released density immediately follows the existing air velocity. Let patches
stretch, curl, overlap, and fade through transport and dissipation. Nearby
stroke fragments should initially stay related enough that the viewer sees
the word becoming smoke.

Departure should not reverse arrival's particle paths or replay a stored
noise template backward. Keep the air flowing forward. Allow a faint residual
tail to finish after the last readable stroke is gone, within a fixed maximum
lifetime. If another word arrives, its mist may share the same air without
moving or resurrecting the old word's ink.

### 5. Make the handoff visually continuous

Both mist emission/absorption and ink opacity must derive from the same
formation or erosion mask. This needs per-pixel glyph masking; the existing
whole-letter alpha value is insufficient for the final version.

Define coverage in consistent word-local units when moving between the
full-resolution ink mask and lower-resolution density texture. Calibrate the
conversion visually; these quantities are not automatically equivalent just
because they are both called alpha. Avoid a brightness flash, a doubled word,
or an empty interval between ink and mist.

The held word remains crisp and motionless. Only the mist moves around it.

## Integration and performance boundaries

- Keep `cloud` as the persisted effect key so saved settings continue to load.
  The product label can become “Mist” if desired without a settings migration.
- Replace the cage/home-based transition inside `word-cloud.js` and
  `word-cloud.wgsl.js`; retain the existing word layout, SDF atlas, and timing
  sources. Stop using per-particle destinations for mist transport.
- Extend the text drawing path to sample the shared formation/erosion mask.
  Inspect `gpu/text-atlas.js`, `gpu/ui.wgsl.js`, and their draw data before
  choosing that interface. Preserve the existing held-text rendering.
- Allocate reusable textures and buffers outside the frame loop. Use bounded
  texture sizes, initially around 256 × 128 for a typical word region, with
  aspect ratio and resolution adapted to the actual word. That size is a
  starting experiment, not a quality guarantee for every font or display.
- Give the simulation region room for the word plus traveling wisps. Hold its
  coordinate frame steady during a transition; fade density at outer margins.
  On resize, remap existing density or retire it gently instead of stretching
  the smoke or letting a region boundary cut off a filament.
- Run advection and mask/source updates before the scene pass; composite with
  the word and under the menus. Preserve the word layer's existing strobe
  behavior and the single-canvas frame graph in
  [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
- Use a fixed simulation timestep with a bounded substep budget. Do not use
  one enormous step after tab suspension. Define resume/reset behavior and
  keep emission based on actual coverage change when timing advances.
- Let the mist remain active while residual density is visible. Use a bounded
  lifetime for cleanup without GPU readback on every frame.
- Start with one shared density field if consecutive words need overlapping
  tails. Keep old residual density separate from the new word's ink mask so
  layout changes cannot teleport the smoke.
- Keep settings few: existing duration and distance, gentle flow strength,
  and softness. Particle count should not be the user's remedy for bad flow.
  Preserve old saved values even if they become irrelevant to this approach.

## Build and review in this order

1. **Prove the mist alone.** Show a thin plume with no letters and no targets.
   It must visibly roll, stretch, and form coherent filaments. If it looks like
   jittering dots or a translating noise texture, stop and fix the flow and
   density rendering before adding typography.
2. **Prove departure.** Start with one held word. Convert its disappearing
   strokes into the proven plume. This is the clearest test of whether the
   word actually appears to become smoke.
3. **Add arrival.** Reuse the air and density rendering, with local formation
   and absorption. Verify full, still readability at the deadline.
4. **Integrate timing and controls.** Exercise short/long words, brief/slow
   fades, asymmetric arrive/leave settings, resize, pause/resume, and repeated
   words. Keep unfinished tails within a bounded resource budget.
5. **Measure before adding detail.** Profile GPU cost and dropped frames with
   the rest of the scene enabled. Increase spatial detail only if the existing
   frame timing budget supports it.

## Visual acceptance criteria

- Watch at normal speed and at quarter speed: a wisp follows a continuous
  curve, and neighbouring portions move together before stretching apart.
- No shrinking rings, straight-line homing, target snapping, abrupt velocity
  changes, evenly spaced dots, or visibly stamped noise pattern.
- A paused frame contains connected translucent filaments and open air,
  rather than a field of luminous points or a uniformly blurred oval.
- At departure, smoke originates from visibly eroding strokes. At arrival,
  ink resolves locally within the mist. Neither reads as a plain word fade
  laid over an unrelated cloud animation.
- Arrival ends with a complete readable word. Departure leaves a gentle,
  finite tail without a sudden cutoff, boundary rectangle, or brightness pop.
- At 30, 60, and 120 Hz, duration, emission amount, and travel distance remain
  comparable. The effect respects the app's allocation and frame timing rules.

The first review should be a short recording of mist-only, departure, and
arrival against both dark and light backgrounds. Shader comments and a
mathematically plausible velocity field cannot establish the visual result.
