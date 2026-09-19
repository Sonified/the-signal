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

## Open focus

Most of the visual design serves a different purpose than the flicker does.

**Open Focus** is Les Fehmi's term for a mode of attention that is diffuse and inclusive rather than narrow and effortful. Ordinary attention is a spotlight: it grips one object and excludes everything else, and that grip carries muscular and autonomic tension with it. Open focus is the opposite posture — peripheral, spacious, holding the whole field at once without picking anything out of it. Fehmi's method reaches it through guided attention exercises and EEG alpha-synchrony feedback, not through driving the brain at a frequency. It is an attentional skill, not a stimulus response.

This tool tries to make that posture easier to fall into, through the arrangement of what is on screen:

**The rings travel outward.** They rise at the vanishing point in the middle of the screen and accelerate toward the edges, growing as they approach. Anything moving outward pulls the eye outward with it. Rather than asking you to relax your gaze, the geometry keeps leading it away from the centre.

**The edge ring holds the periphery.** Particles orbit the rim of the screen continuously, trailing behind them. They sit almost entirely outside the visual field you can attend to sharply, which is the point — they give your peripheral vision something present and continuous to rest in. Together with the outward rings, the effect is a field that is populated at its edges rather than at its centre, so the natural place for attention to settle is wide.

**The corner glows pass the pulse around.** Each of the four corners runs a quarter-cycle behind the last, so the beat travels around the periphery rather than blinking everywhere at once. Attention follows that circuit without being asked to.

**Nothing holds still.** Almost every parameter has a slow variance control of its own — depth, brightness, ring brightness, edge speed, edge size, colour, and the frequency itself all breathe over cycles measured in seconds, each on an independent clock. This is deliberate. A perfectly constant stimulus habituates: the response attenuates and the mind starts to wander from something that has stopped changing. Slow, uncorrelated modulation keeps the field alive enough to remain interesting without becoming demanding. The intent is to sustain attention without capturing it, since capture is the opposite of what open focus is for.

---

## What it does

**Visual.** A full-screen field pulses at a chosen frequency, with three optional layers: the tunnel of rings, the four corner glows, and the orbiting edge particles. All four are locked to one shared phase clock.

**Audio.** An AudioWorklet generates a modulated tone, a train of short pips, and a stereo harmonic stack, all derived from a single sample-accurate phase accumulator. The audio rate can be linked to the visual rate or run independently.

**Bilateral option.** The pips can alternate left and right at an adjustable rate while the tone stays centred. This echoes the bilateral stimulation used in EMDR, though it is not EMDR — that is a full clinical protocol with a therapist and a target memory, and bilateral stimulation on its own has much thinner support than the protocol as a whole.

---

## Frequencies

**7.5 Hz** sits at the alpha-theta crossover. This is the range the Peniston-Kulkosky neurofeedback protocol targeted in work with PTSD and addiction, where the therapeutic events were reported specifically in the crossover state. Below it you drift toward sleep; above it you are alert and defended.

**10 Hz** is the alpha peak, associated with relaxed, eyes-closed wakefulness. Photic driving of alpha is one of the oldest findings in EEG, going back to Adrian and Matthews in 1934, and intermittent photic stimulation remains standard clinical practice.

**0.1 Hz**, available through the variance controls at ten seconds per cycle, is the cardiac resonance frequency. Breathing at roughly six breaths per minute maximises heart rate variability and baroreflex gain. Unlike the entrainment claims, this one is well supported.

### On 40 Hz

The 40 Hz research is the most cited and the most misunderstood, so it is worth being precise.

**What the studies did.** Li-Huei Tsai's lab at MIT showed that 40 Hz sensory stimulation reduced amyloid plaque and altered microglial activity in mouse models of Alzheimer's. The visual arm (Iaccarino et al., *Nature*, 2016) used 40 Hz LED flicker. The auditory arm (Martorell et al., *Cell*, 2019) used **1 ms tone pips at 10 kHz, repeated 40 times per second** — a click train. Combined audio-visual stimulation reached further than either alone, into hippocampus and prefrontal cortex. The acronym for this work is GENUS, Gamma ENtrainment Using Sensory stimuli.

**What a 40 Hz sine tone is not.** The brain entrains to the **envelope** of a sound — how fast it pulses — not to its pitch. A continuous 40 Hz sine has a flat envelope; nothing about it is pulsing forty times a second. It is a very low bass note. It does produce genuine 40 Hz neural activity, because auditory nerve fibres phase-lock to the waveform itself at low frequencies, yielding a frequency-following response. But that response is largely subcortical, and it is a different phenomenon from the thalamocortical 40 Hz steady-state response that the GENUS work drives. No study I am aware of shows a pure 40 Hz tone producing the GENUS outcomes.

There is also a delivery problem. Human hearing threshold at 40 Hz is roughly 50-60 dB higher than at 1 kHz — it is at the absolute floor of audibility. Most speakers do not reproduce it at all and many headphones roll off before reaching it. A good deal of "40 Hz audio" is probably not arriving at the listener's ear as 40 Hz in any meaningful quantity.

**So this tool offers both**, clearly separated. The carrier slider sets the pitch of the tone; the pulse rate sets the envelope. If you want the stimulus the research actually used, enable the click train and set the pulse rate to 40 — the **Gamma 40** preset does exactly this, using short pips and switching off every other layer, since anything still lit during the dark phase fills in the gaps that carry the signal.

**And one hardware limit worth knowing.** An LCD panel cannot switch fast enough to render a clean 40 Hz flicker; pixels are still in transition when the next frame arrives, which is why 40 Hz looks murky and uneven on a laptop while 10 Hz looks perfect. The published visual work used LED arrays. The audio path has no such limitation, so on a normal screen the 40 Hz work is best done through sound.

**Finally, the honest caveat on all of it.** The mouse results are striking; the human translation is far more modest. Cognito Therapeutics has taken 40 Hz stimulation into human trials with reported slowing of functional decline, not the dramatic plaque clearance seen in mice, and parts of the underlying mechanism have had replication difficulties.

---

## Evidence, in general

Photic and auditory driving of cortical rhythm is well established and dates to the 1930s. That rhythmic stimulation entrains cortex in the theta and alpha range is solid, and sits in good journals.

What is far less established is that any particular frequency produces any particular emotional or therapeutic outcome. That literature is smaller, the studies are smaller, and a fair amount of it is authored by people selling devices. Treat the frequency labels here as descriptions of what the stimulus is doing, not as claims about what it will do for you.

It is also worth saying plainly that whatever effect a session has is not separable from attention, intention, darkness, and the fact of having set aside time to sit with yourself. Those are not lesser mechanisms.

---

## Technical

No build step, no dependencies. Native ES modules, Canvas2D, Web Audio with an AudioWorklet. Serve the directory over HTTP and open `index.html`.

```
python3 -m http.server 8000
```

`stereo.html` is a separate proof-of-concept for free-fusion 3D depth using a side-by-side stereo pair.

---

## This is not a medical device

The Signal is an experimental art and meditation tool. It is **not a medical intervention**, and it is **not intended to diagnose, treat, cure, or prevent any disease or condition**. It has not been evaluated or approved by any regulatory body. Nothing here is medical or psychological advice.

If you are being treated for a neurological or psychiatric condition, or working through trauma, talk to your clinician before using anything like this. It is not a substitute for care, and it is not a substitute for a therapeutic relationship.

Rhythmic sensory stimulation can surface strong emotional or physical responses in some people. **You are responsible for your own experience while using this tool** — for deciding whether it is appropriate for you, for the settings you choose, for the environment you use it in, and for stopping when you should. Use it at your own risk.

## Licence

MIT
