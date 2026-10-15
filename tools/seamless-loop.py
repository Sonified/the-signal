#!/usr/bin/env python3
"""Make a seamless loop of a recording, encoded as the ambience plays it.

The browser loops the whole decoded file (js/ambience.js voice), so the
file itself has to be the loop: its last sample flows straight on into its
first. This builds that, from a lossless source:

1. Decode to 48 kHz stereo float.
2. Trim the recordist's own fades: a field recording usually rises out of
   silence and sinks back into it, and a fade left at either end is a
   dropout every time the loop comes round. The trim is found from the
   level (the first and last 50 ms window within 3 dB of the recording's
   median, less a margin) unless given in seconds.
3. Crossfade the tail over the head with an equal-power curve (sin/cos, so
   two uncorrelated noise streams keep a steady level through it): the
   loop is the trimmed take less the crossfade, and its first sample is
   the tail's, so the end leads into the start with no step.
4. Normalise to one peak (0.89 by default), a single gain for the file.
5. Encode Opus 96k and MP3 128k, both from the float, neither a transcode
   of the other.

Recordings under /audio are cached for a year (_headers), so never write
over a file that has shipped: give the new take a new name and point the
code at it.

usage: seamless-loop.py SOURCE OUT_BASE [--xfade S] [--head S] [--tail S] [--peak P]
  OUT_BASE without extension; OUT_BASE.opus and OUT_BASE.mp3 are written
  --xfade  crossfade length in seconds (default 4)
  --head   seconds trimmed from the start (default: found from the level)
  --tail   seconds trimmed from the end (default: found from the level)
  --peak   normalised peak (default 0.89)
then check it: tools/loop-seam-check.py OUT_BASE.opus OUT_BASE.mp3
"""
import sys, argparse, subprocess
import numpy as np

SR = 48000
W = SR // 20            # 50 ms


def decode(path):
    p = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-f', 'f32le',
                        '-ac', '2', '-ar', str(SR), '-'], capture_output=True)
    if p.returncode: sys.exit(p.stderr.decode())
    return np.frombuffer(p.stdout, np.float32).reshape(-1, 2).astype(np.float64)


def encode(x, path, codec):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR),
                    '-ac', '2', '-i', '-', *codec, path],
                   input=x.astype(np.float32).tobytes(), check=True)


def fades(x):
    """Where the recording reaches its body at each end, in samples."""
    mono = x.mean(axis=1)
    k = len(mono) // W
    level = 20 * np.log10(np.sqrt((mono[:k * W].reshape(k, W) ** 2).mean(axis=1)) + 1e-12)
    body = np.median(level) - 3
    inside = np.nonzero(level >= body)[0]
    margin = SR // 10
    return inside[0] * W + margin, (k - 1 - inside[-1]) * W + margin


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument('source'); a.add_argument('out_base')
    a.add_argument('--xfade', type=float, default=4.0)
    a.add_argument('--head', type=float); a.add_argument('--tail', type=float)
    a.add_argument('--peak', type=float, default=0.89)
    o = a.parse_args()

    x = decode(o.source)
    head, tail = fades(x)
    if o.head is not None: head = int(round(o.head * SR))
    if o.tail is not None: tail = int(round(o.tail * SR))
    x = x[head:len(x) - tail]
    X = int(round(o.xfade * SR))
    n = len(x) - X
    if X <= 0 or n <= X:
        sys.exit('the crossfade must be shorter than half the trimmed take')

    t = (np.arange(X) + 0.5) / X
    fade_in = np.sin(t * np.pi / 2)[:, None]
    fade_out = np.cos(t * np.pi / 2)[:, None]
    loop = x[:n].copy()
    loop[:X] = x[:X] * fade_in + x[n:] * fade_out
    loop *= o.peak / np.abs(loop).max()

    encode(loop, o.out_base + '.opus', ['-c:a', 'libopus', '-b:a', '96k'])
    encode(loop, o.out_base + '.mp3', ['-c:a', 'libmp3lame', '-b:a', '128k'])
    print(f'{o.source}\n  trimmed {head / SR:.3f} s from the head, {tail / SR:.3f} s from the tail; '
          f'{o.xfade:g} s crossfade; loop {n / SR:.3f} s ({n} frames) at 48 kHz, peak {o.peak}\n'
          f'  wrote {o.out_base}.opus and {o.out_base}.mp3')


if __name__ == '__main__':
    main()
