// ImageGen artwork -> 16-frame 960px master and 32-frame 384px ping-pong export.
// Usage: node tools/pack-lotus-upscale-poc.mjs q0.png q1.png q2.png q3.png
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../assets/sprites/lotus-bloom-upscaled-3x/', import.meta.url));
const originalPath = fileURLToPath(new URL('../assets/sprites/celestial-v1/source/lotus-bloom.png', import.meta.url));
const sources = process.argv.slice(2);
if (sources.length !== 4) throw new Error('Provide generated quadrants in top-left, top-right, bottom-left, bottom-right order');
function magick(args, input) {
  const r = spawnSync('magick', args, { input, maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}
function decode(file) {
  const [width, height] = magick(['identify', '-format', '%w %h', file]).toString().split(' ').map(Number);
  return { width, height, pixels: magick([file, '-depth', '8', 'rgba:-']) };
}
function crop(img, x, y, width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) img.pixels.copy(pixels, row * width * 4,
    ((y + row) * img.width + x) * 4, ((y + row) * img.width + x + width) * 4);
  return { width, height, pixels };
}
function box(img, threshold = 200) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.pixels[(y * img.width + x) * 4 + 3] < threshold) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error('Empty frame');
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
function foreground(img) {
  const { width, height, pixels } = img, count = width * height;
  const seen = new Uint8Array(count), queue = new Int32Array(count); let largest = [];
  for (let seed = 0; seed < count; seed++) {
    if (seen[seed] || pixels[seed * 4 + 3] < 200) continue;
    let head = 0, tail = 1; queue[0] = seed; seen[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      for (const n of [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, y > 0 ? p - width : -1, y + 1 < height ? p + width : -1]) {
        if (n < 0 || seen[n] || pixels[n * 4 + 3] < 200) continue;
        seen[n] = 1; queue[tail++] = n;
      }
    }
    if (tail > largest.length) largest = Array.from(queue.subarray(0, tail));
  }
  if (!largest.length) throw new Error('No connected lotus body');
  const clean = Buffer.alloc(pixels.length);
  for (const p of largest) { pixels.copy(clean, p * 4, p * 4, p * 4 + 3); clean[p * 4 + 3] = 255; }
  return { width, height, pixels: clean };
}
function resize(img, width, height) {
  return { width, height, pixels: magick(['-size', `${img.width}x${img.height}`, '-depth', '8', 'rgba:-',
    '-filter', 'Lanczos', '-resize', `${width}x${height}!`, '-depth', '8', 'rgba:-'], img.pixels) };
}
function paste(dst, src, x, y) {
  if (x < 0 || y < 0 || x + src.width > dst.width || y + src.height > dst.height) throw new Error('Frame exceeds tile');
  for (let row = 0; row < src.height; row++) src.pixels.copy(dst.pixels,
    ((y + row) * dst.width + x) * 4, row * src.width * 4, (row + 1) * src.width * 4);
}
const blank = (width, height) => ({ width, height, pixels: Buffer.alloc(width * height * 4) });
const original = decode(originalPath), quadrants = sources.map(decode);
if (original.width !== 1254 || original.height !== 1254 || quadrants.some(q => q.width !== q.height)) throw new Error('Unexpected input dimensions');
const master = blank(3840, 3840), frames = [], placement = [];
for (let frame = 0; frame < 16; frame++) {
  const col = frame % 4, row = Math.floor(frame / 4), q = quadrants[Math.floor(row / 2) * 2 + Math.floor(col / 2)];
  const gx = Math.round((col % 2) * q.width / 2), gy = Math.round((row % 2) * q.height / 2);
  const generated = foreground(crop(q, gx, gy, Math.round((col % 2 + 1) * q.width / 2) - gx,
    Math.round((row % 2 + 1) * q.height / 2) - gy));
  const generatedBox = box(generated);
  // Match the live renderer's original crop and 320px-cell positioning at 3×.
  const sx = Math.floor(col * original.width / 4), sy = Math.floor(row * original.height / 4);
  const sw = Math.ceil((col + 1) * original.width / 4) - sx, sh = Math.ceil((row + 1) * original.height / 4) - sy;
  const old = foreground(crop(original, sx, sy, sw, sh)), oldBox = box(old);
  const body = resize(crop(generated, generatedBox.x, generatedBox.y, generatedBox.width, generatedBox.height), oldBox.width * 3, oldBox.height * 3);
  const tile = blank(960, 960), px = ((320 - sw) >> 1) * 3, py = ((320 - sh) >> 1) * 3;
  paste(tile, body, px + oldBox.x * 3, py + oldBox.y * 3);
  paste(master, tile, col * 960, row * 960);
  frames.push(resize(crop(tile, px, py, sw * 3, sh * 3), 336, 336));
  placement.push({ frame, sourceBounds: oldBox, masterBounds: { x: px + oldBox.x * 3, y: py + oldBox.y * 3, width: body.width, height: body.height } });
}
const sequence = [...Array(16).keys(), ...Array.from({ length: 16 }, (_, i) => 15 - i)];
const packed = blank(3072, 1536);
for (let i = 0; i < sequence.length; i++) paste(packed, frames[sequence[i]], (i % 8) * 384 + 24, Math.floor(i / 8) * 384 + 24);
await mkdir(path.join(root, 'source'), { recursive: true });
const outputs = [
  { id: 'lotus-bloom-master', image: 'lotus-bloom-960.png', tileSize: 960, columns: 4, rows: 4, frameCount: 16, padding: 9, sequence, data: master },
  { id: 'lotus-bloom-packed', image: 'lotus-bloom-384.png', tileSize: 384, columns: 8, rows: 4, frameCount: 32, padding: 24, sequence, data: packed }
];
const assets = [];
for (const { data, sequence: playbackSequence, ...asset } of outputs) {
  const destination = path.join(root, asset.image);
  magick(['-size', `${data.width}x${data.height}`, '-depth', '8', 'rgba:-', destination], data.pixels);
  assets.push({ ...asset, width: data.width, height: data.height, fps: 8, loop: true, playback: 'ping-pong', durationSeconds: 4,
    frameOrder: 'row-major', anchor: [0.5, 0.5], sourceFrameSequence: playbackSequence,
    sha256: createHash('sha256').update(await readFile(destination)).digest('hex') });
}
for (let i = 0; i < 4; i++) {
  const destination = path.join(root, 'source', `quadrant-${i}.png`);
  if (path.resolve(sources[i]) !== destination) await copyFile(sources[i], destination);
}
await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, pack: 'lotus-bloom-upscaled-3x', status: 'proof-of-concept', alpha: 'straight', colorSpace: 'srgb',
  originalSource: '../celestial-v1/source/lotus-bloom.png', originalSourceSha256: createHash('sha256').update(await readFile(originalPath)).digest('hex'),
  method: 'ImageGen texture and contour reconstruction in four 2x2 groups; high-resolution alpha foreground cleanup, original placement bounds only, Lanczos packing', assets, placement }, null, 2) + '\n');
console.log(JSON.stringify(assets.map(({ image, width, height, tileSize, frameCount }) => ({ path: path.join(root, image), width, height, tileSize, frameCount })), null, 2));
