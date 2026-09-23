# Known Issues

## Clouds source resolution

The Clouds source recordings were exported at too low a level, roughly 20 dB below full scale. Because the source WAV files are 16-bit PCM, that leaves approximately 13 effective bits of signal resolution after gain is restored.

The Clouds should be re-exported from the original instruments at a healthier recording level. The current web assets are a temporary replacement made directly from the existing Logic WAV bounces: each starts at the beginning, ends at 15 seconds, has a 100 ms fade-out to prevent a hard ending, and is peak-normalized to -1 dBFS before encoding.
