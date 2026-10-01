# Known Issues

## Clouds source resolution

The Clouds source recordings were exported at too low a level, roughly 20 dB below full scale. Because the source WAV files are 16-bit PCM, that leaves approximately 13 effective bits of signal resolution after gain is restored.

The Clouds should be re-exported from the original instruments at a healthier recording level. The current web assets are a temporary replacement made directly from the existing Logic WAV bounces: each starts at the beginning, ends at 15 seconds, has a 100 ms fade-out to prevent a hard ending, and is peak-normalized to -1 dBFS before encoding.

## Hint smoke: boost band on play

When play is hit and the hint ("Press the space bar to begin") releases into smoke, a small opacity boost band sweeps left to right with the release front. The overlay's crisp letters and the smoke field's ink should hand off with no overlap (the field takes each letter one frame after the overlay hides it, half-open intervals both sides), but a residual brightening remains at the front. Likely somewhere in the handoff between v1/ui/screens/overlay.js (relFx mask) and v1/gpu/word-smoke.js (the release band raster).

## Word smoke: a new word wipes the last one's trail

When one word smokes out and another appears, the new departure takes the whole live field: the previous word's trail is destroyed instead of drifting on. The hint already merges into live smoke (the `merge` path in v1/gpu/word-smoke.js armLive, hint-only); words still run the original wipe-and-restart. Making words merge needs what the hint got: entry without re-running the entrance choreography over old vapour — but words keep sim-side sweep gating (`sws > 0` in simMain) and firm display, which act on the whole field by global clock, so the same left-to-right redraw problem applies. Attempted once (2026-09-28) and reverted after it broke consecutive words.

## Piano: always send exactly the notes that get played

**Tag: piano-samples.** The piano only downloads the samples its gestures can reach (`reachableSamples` in js/piano.js): 18 of the 24 lekko files as of 2026-09-29, every mode note (degrees 1 2 3 5 7) between C3 and E6. The six on the 4 and the 6 (lekko-05, 09, 17, 21, 29, 33) are never struck, so they are no longer sent, which saves about 1 MB for every new listener. The list is derived from the gestures' own ladder (DEG, LO, HI), so changing the mode or the range updates it automatically. What it cannot catch is a new gesture, or a change to an existing one, that strikes a note outside the mode: that note would find no sample and play nothing, silently. Whenever the piano's note choices change, check that every note it can strike is in `reachableSamples`, and widen the list if it is not.

## Parallax: folded confetti does not sway

**Tag: parallax-fold.** With Confetti's Kaleidoscope on (`S.confKaleido`), Parallax sim moves the rings and particles but the confetti holds still. The eye shift is applied (v1/gpu/confetti.wgsl.js subtracts `u.eye` from each corner before the perspective divide), but folded pieces are drawn only into the fold's fundamental domain and the fold pass then copies that wedge around the circle, mirrored and rotated. A sideways shift inside the wedge becomes a different direction in every copy, and the finished image is symmetric by construction, so any lean cancels out on screen.

Options, none built yet (2026-09-29):
- **Shift the folded image as a whole.** The fold pass samples its output offset by the eye, as if the kaleidoscope were a sheet at one depth. Cheap and reads as a sway, but near and far pieces move together: no depth within the confetti.
- **Fold objects, not pixels.** Instance each piece once per element of the fold's symmetry (N rotations, mirrored when Mirror is on), applied to the piece's 3D position before the eye shift and projection. The symmetry then lives in the world around the tunnel axis, and parallax is correct for every copy. Costs: N times the instances; a piece near a mirror line overlaps its own reflection (double bright where the image fold shows it once); copies can land where nothing is drawn today and vanish into the dark regions (off screen, under the centre fade), so the look will differ from the image fold; and the feedback trails are still image space, so they smear under the sway like everything else's.
- **Leave it symmetric.** Treat folded confetti as a mandala that faces the viewer from anywhere, in keeping with open focus.

## Trail fades: three layers, three behaviours

**Tag: trail-fades.** Edge, Particles and Confetti each keep a feedback (trail) image, and each has two opacities: the layer's main Opacity (`edgeOpacity`, `partOpacity`, `confOpacity`, the first column of the performance window) and the trail image's own Opacity in its Feedback drawer (`edgeFbOpacity`, `partFbOpacity`, `confFbOpacity`). The three layers do not agree on what the main Opacity does to the trails, so fading a layer out looks different from layer to layer. As of 2026-09-29:

- **Confetti** (v1/gpu/confetti.js update, `if (fbInUse) fbOpacity *= opacity`): with Feedback on, the main Opacity scales the whole trail image as it lands on the scene, and the pieces go into the image at full opacity (`uni[23]` is 1). Dragging Opacity down dims the trails already there along with the pieces. Side effect: with trails on, overlapping pieces cover each other and the image as a whole goes see-through. With trails off, each piece is still see-through on its own.
- **Particles** (v1/gpu/particles.js): the live particles draw on their own at `gain` (main Opacity included). The trails are fed at that same gain, then composited at `partFbOpacity` only. So the main Opacity only thins what goes *into* the trails. Trails already laid hold their strength and die away on their half-life (up to `HL_MAX` 2 s). They are not dimmed by the slider.
- **Edge** (v1/gpu/scene.js drawFront): the edge is drawn into its own trail image (like Confetti). That image is composited at `edgeFbOpacity`, and the live edge is drawn straight in at `1 - edgeFbOpacity` on top. The trail composite never sees `edgeOpacity`, so, as with Particles, the main Opacity does not reach the trails already laid.

The stopgap for the performance window's layer switch: v1/core/perform.js `perfLayer` has a `TRAIL_OP` table (Edge and Particles). When a layer is switched off or on from the window, it glides the trail Opacity down or up alongside the main Opacity and puts both back when the fade lands. Without it, the trails would hold at full strength and then vanish when the layer switched off. Confetti is left out of the table because its main Opacity already carries the trails (fading both would square the fade). This only covers the layer switch. Dragging the main Opacity by hand still leaves Edge and Particle trails up.

To standardize: pick one rule for every layer with trails, most likely Confetti's ("main Opacity dims everything the layer puts on screen, trails included"), and apply it in the renderer. For Particles the trails blend by add or max (`partFbBlend`), and both commute with a constant scale. So feeding the trails *without* the main Opacity and multiplying it into the composite instead gives the same picture at a steady setting, and lets the slider dim existing trails. Edge needs its own look: the main Opacity would have to reach the composite and the live-edge `k` both, and whether the edge goes into its image at full or at `edgeOpacity` changes overlaps (Confetti's side effect above). Once all three do that, remove `TRAIL_OP` from perform.js. Anything new with trails should follow the same rule.

## Opening prompts: one tap, one line

**Tag: begin-gate.** Built 2026-09-29: a fresh load's hint says "Tap to begin" on touch screens ("Press the space bar to begin" stays on desktop); a ?follow= load shows the DOM gate on every device, now reading "Tap to join the live stream", and the canvas hint behind it says the same words, so the two layers read as one prompt. "Tap to play audio" is gone. The gate's tap wakes the audio and dismisses in the same gesture; nothing plays before it.

Left open: after the join tap, a follower whose broadcaster is not running sees the join line again from the hint (there is nothing to join yet, "waiting for the stream" would be truer); and the gate is DOM styled while the hint is GPU text, so the two "Tap to join" lines render in slightly different type.

## Audio: too many reverbs, underruns on phones

**Tag: reverb-load.** With every sound on, the render thread reached about 80% render capacity (Chrome DevTools > WebAudio) and a phone clicked out with buffer underruns (2026-09-30). The cost is convolution, not our own code: each reverb is a ConvolverNode with a tail of seconds, and up to 13 can run at once. Those are the master music room (js/piano.js), clouds, ambience, the click/chirp room, the harmonics reverb, and one room per sequencer line (`lineRoom`, up to 8, each up to 15 s). Every room exists because it has its own decay. The send levels (how much of each voice goes in) do not need separate rooms.

Already in place: the master music room has a Reverb type, Convolution or Algorithmic (js/fdn-worklet.js, an 8-line feedback delay network, level-matched to the convolver). Switching it to Algorithmic dropped render capacity by about 20 points.

Direction (Robert's sense): **a small set of reverb presets as shared buses**, the way a mix does it. For example a short room, a hall and a long tail, each one reverb, with every voice choosing a bus and its send level instead of owning a room. The cost then stays flat however many voices there are. Per-voice decay settings (the sequencer lines' above all) would become a choice of bus.

Found (2026-09-30): a sequencer line that stopped being heard (muted, solo'd away, level 0, no notes) only had its gain faded to 0. Its whole voice (oscillator, filter, delay loop, about 25 nodes) kept running, and its room kept convolving the zeros it was fed, so a muted line cost nearly what a playing one did until the whole sequencer was switched off. Now a silent line's voice is torn down once its fade has landed and its room's tail has fully run out (the line's reverb length, past any room crossfade, plus 1.5 s), and rebuilt, room plug included, the moment the line is heard again (`lineRest` in js/piano.js). Still worth a Render Capacity check on the phone: lines with long decays playing, then muted for 20 s.
