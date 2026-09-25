# The Signal v1: one surface

v0 draws the strobe on a canvas and stacks roughly a dozen DOM layers on top
of it: drawer, quick buttons, transport, mixer window, word, hint, tooltip.
Every one of those layers can knock the canvas off its direct route to the
display, and every style or layout change on the main thread can delay a
frame. The result is the flicker v0 fought all session.

v1 removes the cause instead of managing it. **The page holds one element, a
WebGPU canvas. Everything the viewer sees, the strobe, the word, the menus,
every slider, is drawn by the GPU in the same frame.** No DOM sits over the
canvas at any time.

## Non-negotiable rules

1. **The UI never strobes.** Menus, buttons, text and glass are drawn at
   steady brightness. The strobe multiply applies to the scene only. Glass
   panels do not mix the live strobing scene; they sample a blurred capture
   taken from the most recent *lit* frame (see Frame graph), so a panel's
   brightness never changes with the strobe.
2. **No DOM over the canvas.** `v1/index.html` contains the canvas and
   nothing else visible. No overlays, no tooltips, no hidden inputs positioned
   over it.
3. **No allocation in the frame loop.** Immediate-mode UI rebuilds every frame,
   so every per-frame call must be allocation-free: positional arguments,
   theme colour constants, reused scratch arrays. No object literals, no array
   literals, no closures, no string building per frame in hot paths. A GC
   pause is a dropped strobe frame.
4. **Frame timing is sacred.** Anything slow (glyph rasterisation, IR builds,
   JSON saves) is deferred, debounced, or done in idle time, never in the
   frame that asked for it.
5. **Portability boundary.** Only `v1/platform/` may touch `window`,
   `document`, `navigator` (except `navigator.gpu` inside `v1/gpu/`),
   `localStorage`, or DOM events. `v1/core/` and `v1/ui/` are pure logic plus
   calls into the platform and GPU interfaces. This is what makes a later
   native iOS port (Swift + Metal, WGSL translated to MSL via Naga or Tint)
   a translation rather than a rewrite.

## Stack

- Vanilla ES modules, no build step, no bundler, no TypeScript, no npm.
- WebGPU only. No WebGL or Canvas2D fallback in v1; if `navigator.gpu` is
  missing, the engine reports it (the platform shows one plain message) and
  v0 remains the fallback product.
- Canvas: `alphaMode: 'opaque'`, `getPreferredCanvasFormat()` (non-sRGB), so
  colour values are sRGB-encoded exactly as CSS colours are. Blending happens
  in that space, matching how v0 looked.
- Coordinates everywhere outside `v1/gpu/` are **CSS pixels, origin top-left**.
  The GPU layer multiplies by `dpr`.
- v1 reuses v0 modules by importing them from `../js/`, unchanged:
  `state.js` (the single `S` state object and `layers`), `audio.js`,
  `piano.js`, `clouds.js`, `ambience.js`, `chirp.js`, `color.js`, `sim.js`,
  `util.js`, `words.js` (the word list), `presets.js` (the `PRESETS` data
  only; never call its `applyPreset`, it drives DOM ids). These imports are
  safe: `js/dom.js` resolves its ids to `null` on the v1 page and nothing on
  these paths dereferences them.
- **v0 files are read-only for v1 lanes.** Do not edit anything outside `v1/`.
  v0 keeps shipping while v1 is built.
- v0 and v1 share saved settings: the same `localStorage` key
  (`STORE = 'openfocus.v1'` from `js/state.js`) and the same JSON shape that
  v0's `saveSettings()` in `js/settings.js` writes.

## Directory and ownership

Each file has exactly one owning lane. A lane edits only files it owns.

| path | owner | what |
|---|---|---|
| `v1/ARCHITECTURE.md` | architect | this contract |
| `v1/index.html` | architect | shell: one canvas |
| `v1/main.js` | integration (wave 2) | boot and frame loop wiring |
| `v1/ui/drawlist.js` | architect | DrawList format, done, read it |
| `v1/ui/theme.js` | architect | design tokens, done, read it |
| `v1/platform/web.js` | lane A1 | canvas, dpr, resize, input, storage, clipboard, visibility |
| `v1/core/strobe.js` | lane A1 | frame lock, phase, eff* values, colour walk, frame health |
| `v1/gpu/engine.js` | lane A1 | device, context, frame graph, render targets |
| `v1/gpu/scene.js` (+ `scene-data.js`, `scene.wgsl.js`) | lane A2 | field, rings, corners, edge; bead fix |
| `v1/gpu/text-atlas.js` | lane B | SDF glyph atlas, measure, emit glyphs |
| `v1/core/words.js` | lane B | word scheduler, pure port of `js/text.js` timing |
| `v1/core/word-fx.js` | text | word transitions: per-letter arrive/leave effects (fade, gather, wind, cloud), drawn by `text.drawWord` |
| `v1/gpu/word-cloud.js` | text | Cloud transition: an advected smoke density field exchanging material with per-pixel SDF ink through a formation mask |
| `v1/gpu/word-smoke.js` | text | Smoke transition: arrivals replay an offscreen-recorded dissolution backward; departures simulate the same physics LIVE at 1024x512 during the fade-out |
| `v1/gpu/ui-renderer.js` (+ `ui.wgsl.js`) | lane C | draws a DrawList |
| `v1/gpu/blur.js` | lane C | lit-frame capture blur chain for glass |
| `v1/ui/imgui.js`, `v1/ui/widgets.js`, `v1/ui/anim.js` | lane D | immediate-mode toolkit |
| `v1/core/schema.js`, `v1/core/schema-visual.js`, `v1/core/store.js` | lane E1 | control schema (visual side), persistence |
| `v1/core/schema-audio.js`, `v1/core/presets.js` | lane E2 | control schema (audio side), preset apply |
| `v1/ui/screens/*.js` | integration (wave 2) | `overlay.js` (veil, word, hint), `chrome.js` (burger, transport, quick bar), `drawer.js`, `mixer.js` |
| `v1/core/atmosphere.js` | lane E2 | drift scheduler, meter state, per-recording mixer controls |
| `v1/core/diagnostics.js` | integration | Copy diagnostics text, v0's exact format; host facts via `platform.env()` |
| `v1/core/profiler.js` | integration | frame profiler: per-frame typed-array recording, drop analysis, JSON report, `window.signalProfile` |
| `v1/platform/profile-web.js` | integration | the profiler's browser half: heap reads, performance observers, file save, window handle |
| `v1/worker-entry.js`, `v1/platform/{host,worker-shim,worker-platform,worker-bridge,input-queue}.js` | engine thread | worker mode: the worker's entry and platform, the page's shell, the shared input queue |
| `v1/core/{engine-thread,audio-link,audio-shell,audio-mirror}.js` | engine thread | worker mode: the Engine thread choice, and the link that keeps the page's sound in step |

As built, the final pass draws a third list, `topList` (burger and mixer),
over `uiList`. Immediate-mode hit testing is first come, first served, so
`main.js` builds the top layer first and the engine draws it last.

## Frame graph

One `requestAnimationFrame` loop, owned by the engine. Per frame, in order:

1. `platform.pollInput()`: normalised input events since last frame.
2. `strobe.step(t)`: advances phase, frame lock, eff values, sim
   (`sim.js` `updateRings` / `updateParticles`), returns `lum` and `lit`.
3. `words.step(t, dt)`: word scheduling.
4. UI build: toolkit consumes input, screens emit into two DrawLists:
   `overlayList` (word, hint: drawn **inside the scene pass, after** the strobe
   content, so they sit on the field but are not multiplied by it) and
   `uiList` (everything else).
5. `engine.render(...)`:
   - **Scene pass** into `sceneTex` (swap-chain format, full res):
     `scene.draw(pass)` then `uiRenderer.draw(pass, overlayList)`.
   - **Capture**: only when frosted glass is on screen (the drawer or mixer;
     the chrome chips are flat tint while both are shut), on a lit frame, and
     at most every 100 ms: `blur.capture(encoder, sceneTex)` refreshes the
     blurred capture (a dual-Kawase style downsample/upsample chain at reduced
     resolution). Otherwise the previous capture is kept, so glass always
     shows a lit, steady image. Whenever no capture is due this frame (glass
     on screen or not), the scene, overlay and UI render in one pass straight
     to the swap chain, skipping sceneTex and the blit; glass reads only the
     kept blurred capture, never sceneTex.
   - **Final pass** into the swap-chain texture: full-screen blit of
     `sceneTex`, then `uiRenderer.draw(pass, uiList, blurView)`. Glass
     instances replace the pixels under them with (blurred capture x tint),
     opaque, so no strobe shows through a panel.
6. One `queue.submit`.

Nothing else may call `requestAnimationFrame`.

## Contracts

### DrawList (`v1/ui/drawlist.js`, done)

Read the file. Summary: a growable `Float32Array` of fixed-stride instances
(`STRIDE = 24` floats) of four kinds: `RECT` (SDF rounded rect with fill,
border, soft shadow), `GLASS` (rounded rect that samples the blur capture,
with tint, border, shadow), `GLYPH` (a quad sampling the SDF glyph atlas), and
`ICON` (an SDF-drawn icon from the `ICON` enum). Clip rects and group opacity
are stacks; each clip change starts a new batch (`batches[i] = first, count,
clip x/y/w/h`). All positional, allocation-free.

### Theme (`v1/ui/theme.js`, done)

Read the file. All colours are `Float32Array(4)` constants, straight alpha,
sRGB. Never write into a theme colour; use the toolkit's scratch colours.

### Platform (`v1/platform/web.js`, lane A1)

```js
export function createPlatform(canvas) -> Platform
// Platform:
//   canvas, dpr, width, height          // css px, updated on resize
//   onResize(fn)                        // fn(width, height, dpr)
//   pollInput() -> InputEvent[]          // drains a preallocated ring; see below
//   now() -> ms                          // performance.now
//   setCursor(kind)                      // 'default'|'pointer'|'grab'|'grabbing'|'ew-resize'|'text'
//   storage: { get(key)->string|null, set(key, str) }   // try/catch wrapped
//   clipboardWrite(text) -> Promise
//   onVisibility(fn)                     // fn(visible:boolean)
//   fullscreen: { toggle(), active() }
//   message(text)                        // the one allowed DOM write: a plain fatal message (no WebGPU)
```
**InputEvent** objects are drawn from a preallocated pool and reused; consumers
must not keep references past the frame. Fields:
`type` ('down'|'move'|'up'|'cancel'|'wheel'|'key'|'keyup'|'leave'),
`x`, `y` (css px), `button`, `pointerId`, `pointerType` ('mouse'|'touch'|'pen'),
`dx`, `dy` (wheel, normalised to px), `key`, `code`, `shift`, `alt`, `ctrl`,
`meta`, `time`. Pointer capture is taken on down so drags survive leaving the
canvas. Space bar default scroll is prevented. The platform does no UI logic.

### Strobe core (`v1/core/strobe.js`, lane A1)

```js
export function stepStrobe(t) -> { lum, lit }   // t = rAF timestamp ms
export function resetStrobeClock()
```
A faithful port of the non-DOM body of `tick()` in `js/main.js` (frame-health
tracking into `S.intervals` / `S.dropCount` / `S.refreshHz`, drift, frame lock
including `S.spareMode`, the eff* values with their zero-variance guards,
colour walks, `S.litLog`, then `updateRings` / `updateParticles` from
`js/sim.js`). Writes the same `S` fields v0 does so diagnostics and presets
keep working. `lit` is `lum > 0.5`. Also owns the audio AM-link update
(`setAmRate` when `S.amLinked`), exactly as v0 does.

### Engine (`v1/gpu/engine.js`, lane A1)

```js
export async function createEngine(platform) -> Engine | null
// Engine:
//   device, format, dpr, width, height (css px), pixelWidth, pixelHeight
//   sceneFormat                          // == format
//   start(frameFn)                       // frameFn(t, dt) runs once per rAF, before render
//   render({ lum, overlayList, uiList, glassVisible, lit })
//   registerScene(scene)                 // lane A2 object
//   registerUI(uiRenderer, blur)         // lane C objects
//   onDeviceLost(fn)
```
Handles resize (reconfigure, recreate `sceneTex`, notify scene/ui/blur via
their `resize(pixelW, pixelH, dpr)`), device loss (report, stop), and the
frame graph above. Canvas configured once; `getCurrentTexture()` per frame.

### Scene (`v1/gpu/scene.js`, lane A2)

```js
export function createScene(device, format) -> Scene
// Scene: draw(pass), resize(pixelW, pixelH, dpr), update(lum)   // update writes buffers, before the pass
```
Draws field, rings, corners and edge exactly as v0 does visually, reading
`S` and `layers`. Port the maths from `js/framedata.js` + `js/shaders.js`
(WGSL) into v1 files with no DOM (canvas size comes from `resize`). **Fix the
bead bug**: v0's WebGPU edge draws one rounded capsule per segment, which
reads as beads on a string. v1 must match Canvas2D's look: each particle is a
single continuous tapered tail (full width at the head, tapering to a point,
bending at corners) with a round head cap, as drawn by `drawEdge` in
`js/renderers/canvas2d.js`. Additive blend as v0.

### Text (`v1/gpu/text-atlas.js`, lane B)

```js
export function createText(device, platform) -> Text
// Text:
//   measure(str, size, weight) -> width (css px)      // no allocation
//   lineMetrics(size) -> ascent, descent via out-params or a reused object
//   draw(dl, str, x, y, size, weight, color, align, letterSpacing, alpha)
//        align: 0 left, 1 centre, 2 right; y is the baseline
//   texture, sampler, sdfRange          // for the UI renderer's GLYPH instances
//   ready -> Promise                    // font loaded + base atlas built
```
SDF (single-channel) glyph atlas rasterised from the system UI font at
weights 300, 400 and 600 (the v0 font stack is in theme.js), generated with a
proper Euclidean distance transform, sized so text is crisp from 10 px to
48 px at dpr 2. Printable ASCII plus Latin-1 prebuilt; any glyph missing at
draw time is queued and rasterised in idle time, drawing nothing (not a box)
until ready. Kerning via canvas measureText advances of pairs is optional;
correct advances per glyph are required. Atlas rasterisation needs a 2D canvas:
use `OffscreenCanvas` created through the platform (lane B may add a tiny
`createScratchCanvas(w,h)` helper to its own file, guarded, rather than
editing platform/web.js).

### Words (`v1/core/words.js`, lane B)

Pure port of the scheduling logic in `js/text.js` (`fires`, `pick`,
`maybeRest`, reveal, fade in / hold / fade out, opacity variance, linked to
the strobe cycle wrap or its own rate), with no DOM. Exposes
`initWords()` (loads `../../js/words.js` data and theme filter exactly as v0),
`rebuildWordPool()`, `stepWords(t, dt)`, and read-only `wordState`:
`{ text, opacity, colorMode }`. The ink-centring hack in v0 is unnecessary:
the SDF text system measures exact advances.

### UI renderer and blur (`v1/gpu/ui-renderer.js`, `v1/gpu/blur.js`, lane C)

```js
export function createUIRenderer(device, format, text) -> UIRenderer
// UIRenderer: draw(pass, drawList, blurView|null), resize(pixelW, pixelH, dpr)
export function createBlur(device, format) -> Blur
// Blur: capture(encoder, sceneTexture), view (GPUTextureView of the result), resize(pixelW, pixelH, dpr)
```
One pipeline, one instanced draw per batch, scissor per batch from the clip
rect. SDF rounded rect with anti-aliased edge (derivative-based), border,
and an outer soft shadow (Gaussian-approximated, the quad expanded by the
shadow radius). GLASS samples `blurView` in screen space, applies tint, adds
a very subtle top highlight and noise dither to avoid banding, and is opaque.
GLYPH uses the SDF with smoothstep over screen-space derivative. ICON evaluates
each icon's SDF analytically in the shader. Instance buffer grows by
doubling, uploaded with one `writeBuffer` per frame. Premultiplied alpha
blending (`one`, `one-minus-src-alpha`).

### Toolkit (`v1/ui/imgui.js`, `widgets.js`, `anim.js`, lane D)

Immediate mode. Sketch (lane D finalises and documents it at the top of
`imgui.js`):

```js
export function createUI(text) -> UI
ui.begin(events, t, dt, width, height, dl)   // dl: the DrawList to emit into
ui.end() -> { cursor, wantsFrames }            // wantsFrames: an animation is running
ui.panel(id, x, y, w, h, glass)               // pushes clip + layout region
ui.endPanel()
ui.scroll(id, h) ... ui.endScroll()           // momentum wheel/drag scrolling, clipped
ui.group(id, label)  -> open (bool)            // collapsible, animated height
ui.endGroup()
ui.row(cols) / ui.endRow()                     // horizontal layout
ui.label(str, style) ; ui.spacer(h)
ui.control(ctrl)     -> changed (bool)         // dispatch by ctrl.kind using the schema
ui.slider(id, label, value01, formatted) -> new value01 | -1
ui.segment(id, labels[], index) -> index
ui.toggle(id, label, on) -> on
ui.button(id, label, variant) -> clicked
ui.iconButton(id, icon, x, y, size) -> clicked
ui.tooltip(str)                                 // for the last item
ui.hotId, ui.activeId, ui.focusId
```
Behaviour required: hover and press states, drag sliders with a relative
drag (shift for fine), click on track to jump, plain wheel always scrolls the enclosing region (Alt+wheel over a slider nudges it),
double-click resets to the control's default, keyboard focus with Tab and
arrow keys, visible focus ring, touch-friendly hit targets (min 44 css px on
touch pointers), springs for every state change (no instant snaps), pointer
capture semantics via activeId. `ids` are strings hashed once per call site
into numbers; the toolkit must not build strings per frame.

### Schema (`v1/core/schema*.js`, lanes E1 and E2)

Every control in v0's drawer, quick bar, transport and mixer becomes one
declarative entry:

```js
/** @typedef {Object} Control
 * @property {string} id        stable id; equals the v0 DOM id where one exists (presets key on it)
 * @property {string} section   'layers'|'strobe'|'tunnel'|'edge'|'text'|'audio'|'music'|'atmosphere'|'render'|'quick'|'transport'|'mixer'
 * @property {string} [sub]     sub-heading within the section, as v0 groups it
 * @property {string} label     exactly as v0 shows it
 * @property {'slider'|'segment'|'toggle'|'color'|'action'} kind
 * @property {number} [min] @property {number} [max] @property {number} [step]   // v0 slider POSITION units
 * @property {number} [def]     default position (v0 markup value)
 * @property {(S)=>number} get          state -> slider position (v0 semantics, incl. dB taper)
 * @property {(S, pos)=>void} set       slider position -> state, then every side effect v0's handler performs
 * @property {(S)=>string} [format]     readout text exactly as v0 prints it (may allocate; cached by the toolkit on change only)
 * @property {(S, text)=>number} [parse] typed readout text (DISPLAYED units) -> position, or NaN to cancel; the inverse of format
 * @property {'number'|'text'} [entry]  how the typed readout opens: 'number' (default) numeric-only, seeded with the readout's number; 'text' free text seeded with the whole readout (note names)
 * @property {'linear'|'log'} [taper]   how position maps onto the slider track (default 'linear'); needs min > 0
 * @property {Array<{value:any,label:string,domId:string}>} [options]   segment options; domId = v0 button id
 * @property {(S)=>boolean} [enabled]   v0 'locked' logic
 * @property {(S)=>boolean} [visible]   v0 visibility logic (e.g. chirp-only rows)
 * @property {string} [parent]  id of the toggle or segment row this one hangs under (its visible() keys on it); the drawer indents it one level with a guide line. Must directly follow its parent, or a sibling child; never set on a section's own On switch's rows
 */
```
Every slider's readout can be clicked and typed into. The viewer types in
the units the readout shows, which are not always position units: a level
fader's position is a 0-100 taper but its readout is dB, and the register
centre prints a note name for a MIDI number. `parse` is that inverse. Leave
it out when `format` prints the position itself (rounded, with a unit on),
and the toolkit reads the typed number as the position. The result is
clamped to [min, max], snapped to step and passed to `set` like any drag;
text that does not parse cancels.

`taper: 'log'` changes only the track: the slider's fraction is
ln(pos/min) / ln(max/min), so the low end gets the travel, while `get`,
`set`, `def`, presets and saved settings all stay in the control's own
units. Its Alt+wheel and arrow-key notch is 1/100 of the travel instead of
step/range. The carrier (1-1000 Hz) uses it.

`set` must reproduce the v0 handler's side effects precisely (for example the
`clickVol` handler writes through `pipSet` and calls `applyLevel('clickLevel')`
and `applyLevel('clickSend')`). Read each handler in `js/ui.js`. Calls that
v0 makes into DOM-only functions (repaints, `updateReadouts`) are dropped,
since the toolkit repaints every frame. `saveSettings()` is replaced by
`store.save()` (debounced) from `v1/core/store.js`.

`v1/core/schema.js` (E1) exports `CONTROLS` (the merged array, visual then
audio), `byId(id)`, and `SECTIONS` (ordered list with titles). It imports
`schema-visual.js` and `schema-audio.js`.

### Store (`v1/core/store.js`, lane E1)

```js
export function load()      // read STORE, apply into S exactly as js/settings.js applySettings does, minus DOM
export function save()      // debounced ~400 ms, writes the exact object js/settings.js saveSettings writes
export function flush()     // immediate save (on visibility hidden)
```

### Presets (`v1/core/presets.js`, lane E2)

```js
export function applyPreset(name)   // uses PRESETS from ../../js/presets.js and the schema
```
Mirrors `applyPreset` in `js/presets.js`: `inputs` map v0 DOM ids to slider
positions (look the control up by id, call `set`), `selects` likewise,
`buttons` are segment option `domId`s (find the owning control, set that
option), `layers` are the layer toggles, then `clickMode`, `bilateral`,
`harmonics`, `colorMode`, `sources`, and `state` (Object.assign into S),
then `store.save()`. Order matters exactly as in v0 (clickMode first).

### Engine thread (worker mode)

Render > Engine thread moves the whole engine into a module worker drawing
through an OffscreenCanvas, so nothing the page's thread does can delay a
frame. It is stored under `signal.v1.worker` ('1' worker, else main) and
applies on the next load; Main is the default. `main.js` then runs twice:
on the page it calls `startWorkerShell` first, which either returns false
(main mode, everything as above) or keeps the page as a shell (canvas, input,
and the sound, which cannot leave the main thread); inside the worker the same
`main.js` boots against the worker's platform (`platform/host.js`). The page's
sound is kept in step the way a second tab would be: the worker's settings
records are replayed on the page (`store.syncFromStorage` + `replayLive`), and
once a frame `core/audio-link.js` diffs every control's position and sends
what moved as calls (`set`, `run`, `strobe`, `seq`, `watch`) that
`core/audio-shell.js` runs through each control's own `set`. The page sends
back meters, recording statuses, drift levels and two live readings.

Two rules follow for every lane. A control's `get` must stay a cheap,
allocation-free read of settings (never of per-frame state such as
`S.effFreq`), since the link calls every one each frame. And frame-side code
must not call the audio modules directly: sound changes go through a
control's `set` (which must stay harmless with no AudioContext, as it runs in
the worker too) or through a call added to both ends of the link. In worker
mode the page's shell runs its own `requestAnimationFrame` for the
atmosphere; the engine's loop is the worker's.

## Conventions

- Comments: prose, explaining why, in the voice of the existing codebase
  (see `js/text.js`, `js/sim.js`, `css/style.css`). No bullet lists inside
  comments. No em dashes anywhere.
- Every module starts with a short header comment saying what it owns.
- No console noise in the frame loop. Warnings once, on failure paths.
- Verification: `node --check` every file you write. Do not run the app,
  open a browser, or write and run test scripts; Robert tests in Chrome
  himself. Do not touch git.
