#!/usr/bin/env python3
"""The Sun program master from the machine plan (tools/sun-program-plan.mjs).

  render PLAN.json MASTER.mp4   the program master, and beside it
                                program_times.json + program_junctions.json
  check  PLAN.json MASTER.mp4   spot checks of the master against the day
                                masters, PNGs and check.txt in check/ beside it

Frames are read from the caption-keyed day masters (solarmeditation
renders/cache/master, the plan.tsv fingerprints) as raw yuvj420p, never
converted, and written to one libx264 near-lossless encode with the day
masters' own settings (crf 14, preset medium, full range, bt470bg).

A fade is the gap explorer's plain dissolve (tools/gap-explorer.html,
mosaic() mode 0 and fadeNow()): overlap frame k of n is A x (1 - w) + B x w
with w = (k + 1) / (n + 1), a straight blend of the display values. Linear
in RGB is linear in Y'CbCr (the conversion is affine), so the blend is done
on the planes directly, in integers, rounded:
  out = (A (n - k) + B (k + 1) + (n + 1) / 2) / (n + 1)
"""
import json, os, subprocess, sys, time
import numpy as np

W, H, FPS = 3072, 2048, 30
FS = W * H * 3 // 2          # one yuv420p frame
ENC = ['-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuvj420p']
TAGS = ['-colorspace', 'bt470bg', '-color_range', 'pc']


def load(plan_path):
    plan = json.load(open(plan_path))
    days = []
    for l in open(plan['source']['planTsv']):
        if l.startswith('DAY\t'):
            _, day, fp, n, off = l.rstrip('\n').split('\t')[:5]
            days.append((int(off), int(n), os.path.join(plan['source']['masters'], f'{day}_{fp}.mp4')))
    times = json.load(open(plan['source']['keyed']))
    return plan, days, times


def day_of(days, i):
    lo, hi = 0, len(days) - 1
    while lo < hi:
        m = (lo + hi + 1) >> 1
        if days[m][0] <= i: lo = m
        else: hi = m - 1
    return days[lo]


def read_exact(f, n):
    buf = bytearray(n); mv = memoryview(buf); got = 0
    while got < n:
        r = f.readinto(mv[got:])
        if not r: return None
        got += r
    return buf


def keyed_frames(days, a, n):
    """Keyed frames a .. a + n - 1 as raw yuvj420p bytes, a decoder per day."""
    i, end = a, a + n
    while i < end:
        off, dn, master = day_of(days, i)
        f0, f1 = i - off, min(end, off + dn) - off
        p = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-i', master,
                              '-vf', f'trim=start_frame={f0}:end_frame={f1}', '-fps_mode', 'passthrough',
                              '-f', 'rawvideo', '-pix_fmt', 'yuvj420p', '-'], stdout=subprocess.PIPE, bufsize=FS)
        for k in range(f1 - f0):
            buf = read_exact(p.stdout, FS)
            if buf is None: raise SystemExit(f'{master}: ran out at frame {f0 + k} (wanted {f0}..{f1 - 1})')
            yield buf
        if p.stdout.read(1): raise SystemExit(f'{master}: more frames than {f0}..{f1 - 1}')
        if p.wait(): raise SystemExit(f'{master}: decoder failed')
        i = off + f1


def blend(a, b, k, n):
    A = np.frombuffer(a, np.uint8).astype(np.uint32)
    B = np.frombuffer(b, np.uint8).astype(np.uint32)
    return ((A * (n - k) + B * (k + 1) + (n + 1) // 2) // (n + 1)).astype(np.uint8).tobytes()


def program(plan, days):
    """(program frame bytes) in order, from the plan's runs."""
    for r in plan['runs']:
        if 'b' not in r:
            yield from keyed_frames(days, r['a'], r['n'])
        else:
            for k, (fa, fb) in enumerate(zip(keyed_frames(days, r['a'], r['n']), keyed_frames(days, r['b'], r['n']))):
                yield blend(fa, fb, k, r['n'])


def layers(plan):
    """Per program frame: (a, b, k, n), b = -1 outside a fade."""
    out = []
    for r in plan['runs']:
        for k in range(r['n']):
            out.append((r['a'] + k, r['b'] + k, k, r['n']) if 'b' in r else (r['a'] + k, -1, 0, 0))
    return out


def side_files(plan, times, outdir):
    L = layers(plan)
    assert len(L) == plan['total'], (len(L), plan['total'])
    # the time shown: B's once w = (k + 1) / (n + 1) >= 0.5 (the explorer's stamp)
    pt = [times[b] if b >= 0 and (k + 1) / (n + 1) >= 0.5 else times[a] for a, b, k, n in L]
    json.dump(pt, open(os.path.join(outdir, 'program_times.json'), 'w'))
    J = [dict(junction=q, name=j['name'], fade=j['fade'], start=j['start'], end=j['end'], endExclusive=j['end'] + 1,
              outLastUtc=j['outLastUtc'], inFirstUtc=j['inFirstUtc'],
              startUtc=pt[j['start']], endUtc=pt[j['end']]) for q, j in enumerate(plan['junctions'])]
    json.dump(dict(total=plan['total'], fps=FPS, firstUtc=pt[0], lastUtc=pt[-1],
                   blend='w = (k + 1) / (n + 1), out = A (1 - w) + B w; start..end inclusive program frames',
                   junctions=J), open(os.path.join(outdir, 'program_junctions.json'), 'w'), indent=1)
    return pt


def render(plan_path, out):
    plan, days, times = load(plan_path)
    outdir = os.path.dirname(os.path.abspath(out))
    os.makedirs(outdir, exist_ok=True)
    side_files(plan, times, outdir)
    tmp = out[:-4] + '.building.mp4'
    enc = subprocess.Popen(['ffmpeg', '-y', '-nostdin', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuvj420p',
                            '-s', f'{W}x{H}', '-framerate', str(FPS), *TAGS, '-i', '-', *ENC, *TAGS,
                            '-movflags', '+faststart', tmp], stdin=subprocess.PIPE, bufsize=FS)
    t0 = time.time(); n = 0
    for fr in program(plan, days):
        enc.stdin.write(fr); n += 1
        if n % 500 == 0:
            el = time.time() - t0
            print(f'{n}/{plan["total"]}  {n / el:.1f} fps  eta {(plan["total"] - n) / (n / el) / 60:.0f} min', flush=True)
    enc.stdin.close()
    if enc.wait(): raise SystemExit('encoder failed')
    if n != plan['total']: raise SystemExit(f'wrote {n} frames, plan says {plan["total"]}')
    os.replace(tmp, out)
    print(f'{out}: {n} frames in {(time.time() - t0) / 60:.1f} min')


# ---------- spot checks ----------
def decode_at(path, p, total=None):
    """Program frame p of a 30 fps file, by accurate seek."""
    ss = max(0.0, (p - 0.25) / FPS)
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{ss:.5f}', '-i', path, '-frames:v', '1',
                        '-f', 'rawvideo', '-pix_fmt', 'yuvj420p', '-'], capture_output=True)
    if len(r.stdout) != FS: raise SystemExit(f'{path}: no frame {p}')
    return r.stdout


def psnr(x, y):
    d = np.frombuffer(x, np.uint8).astype(np.float32)[:W * H] - np.frombuffer(y, np.uint8).astype(np.float32)[:W * H]
    m = float(np.mean(d * d))
    return 99.0 if m == 0 else 10 * np.log10(255 * 255 / m)


def png(raw, path):
    subprocess.run(['ffmpeg', '-y', '-nostdin', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuvj420p', '-s', f'{W}x{H}',
                    *TAGS, '-i', '-', '-vf', 'scale=1536:1024:in_range=pc:in_color_matrix=bt470bg', '-frames:v', '1', path],
                   input=raw, check=True)


def expected(plan, days, L, p):
    a, b, k, n = L[p]
    fa = next(keyed_frames(days, a, 1))
    if b < 0: return fa, fa, None
    fb = next(keyed_frames(days, b, 1))
    return blend(fa, fb, k, n), fa, fb


def check(plan_path, master):
    plan, days, times = load(plan_path)
    L = layers(plan)
    outdir = os.path.dirname(os.path.abspath(master))
    cdir = os.path.join(outdir, 'check'); os.makedirs(cdir, exist_ok=True)
    J = plan['junctions']
    picks = []
    for q in (0, 5, len(J) - 1):
        j = J[q]
        picks += [(f'fade{q:02d}_start', j['start']), (f'fade{q:02d}_mid', (j['start'] + j['end']) // 2), (f'fade{q:02d}_end', j['end'])]
    s3 = J[2]['end'] + 1 + (J[3]['start'] - J[2]['end'] - 1) // 2   # the middle of stretch 3's plain run
    picks += [('stretch03_mid', s3), ('first', 0), ('last', plan['total'] - 1)]
    lines = []
    ok = True
    for name, p in picks:
        got = decode_at(master, p)
        exp, fa, fb = expected(plan, days, L, p)
        a, b, k, n = L[p]
        # the neighbours, to prove the frame sits where it should
        near = []
        for d in (-1, 1):
            if 0 <= p + d < len(L): near.append(psnr(got, expected(plan, days, L, p + d)[0]))
        e = psnr(got, exp); best = e > max(near) if near else True
        line = f'{name:16s} p {p:5d}  {times[a]}' + (f' + {times[b]}  k {k + 1}/{n}  w {(k + 1) / (n + 1):.3f}' if b >= 0 else '') + \
               f'  PSNR(Y) vs expected {e:5.1f} dB  vs neighbours {" ".join(f"{x:.1f}" for x in near)}'
        if fb is not None: line += f'  vs A alone {psnr(got, fa):.1f}  vs B alone {psnr(got, fb):.1f}'
        if not best or e < 40 or (name in ('first', 'last') and b >= 0): ok = False; line += '  <-- CHECK'
        print(line, flush=True); lines.append(line)
        png(got, os.path.join(cdir, f'{name}_p{p}.png'))
        if b >= 0 and name.endswith('_mid'):
            png(fa, os.path.join(cdir, f'{name}_p{p}_A.png')); png(fb, os.path.join(cdir, f'{name}_p{p}_B.png'))
    # the program's ends: one plain frame each, no blend
    for name, p in (('first', 0), ('last', len(L) - 1)):
        a, b, k, n = L[p]
        line = f'{name} frame {p}: ' + (f'plain, {times[a]} (keyed frame {a})' if b < 0 else f'A BLEND of {times[a]} and {times[b]}')
        if b >= 0: ok = False
        print(line); lines.append(line)
    open(os.path.join(cdir, 'check.txt'), 'w').write('\n'.join(lines) + '\n' + ('ALL OK' if ok else 'PROBLEMS') + '\n')
    print('ALL OK' if ok else 'PROBLEMS')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    mode, plan_path, path = sys.argv[1:4]
    {'render': render, 'check': check}[mode](plan_path, path)
