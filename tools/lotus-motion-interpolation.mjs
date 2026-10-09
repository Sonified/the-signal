// Offline macOS Vision motion interpolation; no runtime dependency or network.
// Bidirectional flow warps the existing RGBA textures to their halfway positions.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const work = mkdtempSync(path.join(tmpdir(), 'lotus-motion-'));
const binary = path.join(work, 'optical-flow');
let compiled = false, pair = 0;
function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout;
}
function sample(data, w, h, channels, x, y, c) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const ix = Math.floor(x), iy = Math.floor(y), nx = Math.min(w - 1, ix + 1), ny = Math.min(h - 1, iy + 1), tx = x - ix, ty = y - iy;
  return (data[(iy * w + ix) * channels + c] * (1 - tx) + data[(iy * w + nx) * channels + c] * tx) * (1 - ty)
    + (data[(ny * w + ix) * channels + c] * (1 - tx) + data[(ny * w + nx) * channels + c] * tx) * ty;
}
function premultiply(img) {
  const data = new Float32Array(img.pixels.length);
  for (let p = 0; p < img.pixels.length; p += 4) {
    const a = img.pixels[p + 3] / 255;
    for (let c = 0; c < 3; c++) data[p + c] = img.pixels[p + c] * a;
    data[p + 3] = img.pixels[p + 3];
  }
  return data;
}
function loadFlow(from, to, output, w, h) {
  run(binary, [from, to, output]);
  const bytes = readFileSync(output);
  if (bytes.length !== w * h * 8) throw new Error('Unexpected optical flow dimensions');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}
export function midpoint(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Keyframe dimensions differ');
  if (!compiled) {
    run('swiftc', ['-O', '-module-cache-path', path.join(work, 'swift-cache'), fileURLToPath(new URL('./lotus-optical-flow.swift', import.meta.url)), '-o', binary]);
    compiled = true;
  }
  const { width: w, height: h } = a;
  const inputs = ['a', 'b'].map(name => path.join(work, `${pair}-${name}.png`));
  for (const [i, img] of [a, b].entries()) run('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgba:-', inputs[i]], img.pixels);
  const flows = [loadFlow(inputs[0], inputs[1], path.join(work, `${pair}-forward.f32`), w, h),
    loadFlow(inputs[1], inputs[0], path.join(work, `${pair}-backward.f32`), w, h)];
  pair++;
  const colors = [premultiply(a), premultiply(b)], pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rgba = [0, 0, 0, 0];
    for (let direction = 0; direction < 2; direction++) {
      const f = flows[direction]; let px = x, py = y;
      // Invert halfway forward flow to find the source for this output pixel.
      for (let iteration = 0; iteration < 5; iteration++) {
        const dx = sample(f, w, h, 2, px, py, 0), dy = sample(f, w, h, 2, px, py, 1);
        px = x - .5 * dx; py = y - .5 * dy;
      }
      for (let c = 0; c < 4; c++) rgba[c] += sample(colors[direction], w, h, 4, px, py, c) * .5;
    }
    const p = (y * w + x) * 4, alpha = Math.round(rgba[3]);
    if (alpha < 2 || rgba[3] < 2) continue;
    for (let c = 0; c < 3; c++) pixels[p + c] = Math.max(0, Math.min(255, Math.round(rgba[c] * 255 / rgba[3])));
    pixels[p + 3] = alpha;
  }
  return { width: w, height: h, pixels };
}
