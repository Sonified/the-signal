#!/usr/bin/env python3
"""Does a video's footage repeat? For frames after a point, find the most
similar earlier frame (small grey thumbnails, mean absolute difference),
so footage that jumps back in time shows up as a near-zero match far back.

usage: frame-repeat-check.py VIDEO START END [LOOKBACK]
  frames START..END are checked against the LOOKBACK frames before START
"""
import sys, subprocess
import numpy as np
video, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
back = int(sys.argv[4]) if len(sys.argv) > 4 else 600
W, H = 96, 64
first = max(0, a - back)
p = subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-ss', str(first / 30), '-i', video,
                    '-frames:v', str(b - first + 1), '-vf', f'scale={W}:{H},format=gray',
                    '-f', 'rawvideo', '-'], capture_output=True, check=True)
f = np.frombuffer(p.stdout, np.uint8).reshape(-1, H, W).astype(np.float32)
n0 = a - first
for i in range(n0, len(f)):
    d = np.abs(f[:n0] - f[i]).mean(axis=(1, 2))
    j = int(d.argmin())
    prev = np.abs(f[i] - f[i - 1]).mean()
    print(f'frame {first + i}: step from previous {prev:5.2f} | closest earlier frame {first + j} (diff {d[j]:5.2f}, {first + i - first - j} back)')
