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
