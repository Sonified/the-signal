# Rain

Three sixty-second seamless loops, from the sound library originally gathered
for Breathscape. All three are **Creative Commons 0** (public domain): no
attribution is legally required, no commercial restriction. The credits are here
anyway, because the people who climbed a hill with a recorder deserve them.

| file | source | recordist | Freesound |
|---|---|---|---|
| `gentle` | 1 Minute Rain (Medium) | yzhamua | [188655](https://freesound.org/s/188655/) |
| `steady-seamless` | rain.wav | aumguy | [180380](https://freesound.org/s/180380/) |
| `night` | RAIN NIGHT Village Drips Courtyard | silencyo | [81731](https://freesound.org/s/81731/) |

## How they were made

Cut to sixty seconds, then the tail crossfaded back over the head with an equal
power curve so the loop point is a sum of two uncorrelated noise streams rather
than a step. On rain that seam is inaudible. Normalised to a single peak of
0.89, one gain per file, so each keeps its own character rather than being
flattened to a common loudness.

**Steady rain was cut again.** Its first cut (`steady`, kept so a cached copy
never changes under anyone) left the recordist's own fade in at the head of the
file, so every pass of the loop dipped about 25 dB for a tenth of a second, and
its crossfade ran the wrong way and ended in a splice at three seconds.
`steady-seamless` is rebuilt from the lossless 180380 take with
`tools/seamless-loop.py`: the fade in and the fade out trimmed off (0.25 s and
0.65 s), a 4 s equal power crossfade, 49.6 s long. `tools/loop-seam-check.py`
measures the wrap of any loop; run it over a new take before shipping it.

Encoded twice from the same source: **Opus 96k** for browsers that take it,
**MP3 128k** as the fallback. Neither is a transcode of the other.

## Not included, and why

The same library holds three more recordings under Creative Commons Attribution
rather than CC0, so using them means carrying the credit wherever the audio
goes: soundman516's *Heavy Rain, Front Porch* and IllusiaProductions'
*Rain dripping from the rain gutter* (both CC-BY 4.0), and alexkandrell's
*Heavy Rain, UK Cambridge* (CC-BY 3.0). They are usable, including commercially.
They just carry a condition these three do not.
