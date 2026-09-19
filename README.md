# The Signal

A browser-based tool for rhythmic audio-visual stimulation, built for meditation, open-focus attention practice, and inner work.

**→ [Open The Signal](https://sonified.github.io/the-signal/)**

---

## ⚠️ Photosensitivity warning — read before opening

**This page flickers the full screen at rates up to 45 Hz and modulates brightness rhythmically.**

**Do not use it if you:**

- have photosensitive epilepsy, or any seizure history
- are prone to migraine with visual aura
- do not know whether either applies to you

Flashing light can trigger seizures in people who have never had one and had no reason to suspect they were susceptible. Photosensitive epilepsy affects roughly 1 in 4,000 people. Risk is highest between about 15 and 25 Hz, and rises with how much of your visual field the flicker covers — this tool is designed to fill it.

Start at low brightness and low depth. Stop immediately if you feel dizzy, nauseous, disoriented, or notice any visual disturbance. Do not use it while tired, and do not use it around anyone who has not read this warning.

A safety gate appears on first visit and cannot be skipped.

---

## What it does

**Visual.** A full-screen field pulses at a chosen frequency, with three optional layers: a tunnel of rings travelling toward the viewer, four corner glows that pass the pulse around the periphery, and particles orbiting the screen edge. All four are locked to one shared phase clock.

**Audio.** An AudioWorklet generates a modulated tone, a train of short pips, and a stereo harmonic stack, all derived from a single sample-accurate phase accumulator. The audio rate can be linked to the visual rate or run independently.

**Modulation.** Most parameters have a slow variance control, so depth, brightness, colour, and the edge behaviour breathe over cycles measured in seconds rather than sitting still.

## Frequencies

Presets cover a few well-documented ranges:

- **7.5 Hz** — the alpha-theta crossover, the range used in trauma neurofeedback protocols
- **10 Hz** — the alpha peak, associated with relaxed wakefulness
- **40 Hz** — gamma, the range used in the MIT GENUS studies, delivered here through the audio path

One honest note on 40 Hz visual: an LCD panel cannot switch fast enough to render a clean 40 Hz flicker. The published visual work used LED arrays. The audio path has no such limit.

## Evidence, briefly

Photic and auditory driving of cortical rhythm is well established and dates to the 1930s. What is far less established is that any particular frequency produces any particular emotional or therapeutic outcome. Treat the frequency labels as descriptions of what the stimulus is doing, not as claims about what it will do for you.

## Technical

No build step, no dependencies. Native ES modules, Canvas2D, Web Audio with an AudioWorklet. Serve the directory over HTTP and open `index.html`.

```
python3 -m http.server 8000
```

`stereo.html` is a separate proof-of-concept for free-fusion 3D depth using a side-by-side stereo pair.

## Licence

MIT
