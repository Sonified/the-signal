#!/usr/bin/env python3
"""Does a looping recording loop without a gap? The browser plays each
ambience file as a whole-buffer loop (js/ambience.js voice, loop = true, in
Heart and natively alike), so the last sample is followed straight by the
first. This decodes each file as the browser would (ffmpeg, 48 kHz stereo,
encoder priming and padding trimmed) and measures the wrap:

  length    the decoded length, the loop's period
  lead/tail how much of the start and end is near silence (below -60 dBFS)
  seam      the quietest 50 ms within 1 s either side of the wrap, in dB
  floor     the recording's own quietest 50 ms anywhere away from the wrap
            (its 1st percentile), what it does by itself
  head/tail the level of the first and last 250 ms against the file's median
  step      the sample jump across the wrap against the file's typical step

A seam more than 6 dB below the recording's own floor is a dropout the
recording does not have anywhere else: it fails, as does any silent lead
or tail. Exit status 1 if any file fails.

usage: loop-seam-check.py FILE...
  e.g. tools/loop-seam-check.py audio/rain/*.opus audio/ambience/seamless/*.opus
"""
import sys, subprocess
import numpy as np

SR = 48000
W = SR // 20            # 50 ms


def decode(path):
    p = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-f', 'f32le',
                        '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True)
    return np.frombuffer(p.stdout, np.float32).reshape(-1, 2)


def db(v):
    return 20 * np.log10(np.maximum(v, 1e-10))


def rms_windows(mono, hop):
    """RMS of every 50 ms window, stepped by hop samples."""
    sq = np.concatenate([[0.0], np.cumsum(mono.astype(np.float64) ** 2)])
    starts = np.arange(0, len(mono) - W + 1, hop)
    return np.sqrt((sq[starts + W] - sq[starts]) / W)


def check(path):
    x = decode(path)
    n = len(x)
    mono = x.mean(axis=1)
    loud = np.nonzero(np.abs(x).max(axis=1) > 1e-3)[0]
    lead = loud[0] / SR if len(loud) else n / SR
    tail = (n - 1 - loud[-1]) / SR if len(loud) else n / SR

    body = rms_windows(mono[SR:n - SR], W // 2)
    floor = np.percentile(db(body), 1)
    median = np.median(db(body))
    # the wrap as the loop plays it: the last second, then the first
    wrap = np.concatenate([mono[-SR:], mono[:SR]])
    seam = db(rms_windows(wrap, W // 10)).min()
    head = db(np.sqrt((mono[:SR // 4] ** 2).mean())) - median
    end = db(np.sqrt((mono[-SR // 4:] ** 2).mean())) - median
    step = np.abs(x[0] - x[-1]).max()
    typical = np.percentile(np.abs(np.diff(x, axis=0)).max(axis=1), 99.9)

    bad = []
    if seam < floor - 6: bad.append(f'seam {seam - floor:.0f} dB below the floor')
    if lead > 0.005: bad.append(f'{lead * 1000:.0f} ms silent lead')
    if tail > 0.005: bad.append(f'{tail * 1000:.0f} ms silent tail')
    print(f'{"FAIL" if bad else "ok  "}  {path}\n'
          f'      length {n / SR:.3f} s ({n} frames), lead {lead * 1000:.1f} ms, tail {tail * 1000:.1f} ms\n'
          f'      seam min {seam:.1f} dB, recording floor {floor:.1f} dB, median {median:.1f} dB\n'
          f'      first 250 ms {head:+.1f} dB, last 250 ms {end:+.1f} dB (from the median)\n'
          f'      wrap step {step:.4f}, 99.9% step {typical:.4f}'
          + (f'\n      {"; ".join(bad)}' if bad else ''))
    return not bad


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    results = [check(p) for p in sys.argv[1:]]
    sys.exit(0 if all(results) else 1)
