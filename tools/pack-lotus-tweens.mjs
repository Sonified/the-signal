// Pack ImageGen intermediate poses without changing the stabilized keyframes.
// Usage: node tools/pack-lotus-tweens.mjs group-0.png ... group-3.png
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { midpoint } from './lotus-motion-interpolation.mjs';

const root = fileURLToPath(new URL('../assets/sprites/lotus-bloom-upscaled-3x/', import.meta.url));
const motion = process.argv.includes('--motion');
const sources = process.argv.slice(2).filter(p => p !== '--motion');
if (!motion && sources.length !== 4) throw new Error('Provide four generated sheets, or --motion for deterministic interpolation');
const TILE = 960, target = { x: 480, y: 801 };
function magick(args, input) {
  const r = spawnSync('magick', args, { input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}
function decode(file) {
  const [width, height] = magick(['identify', '-format', '%w %h', file]).toString().split(' ').map(Number);
  return { width, height, pixels: magick([file, '-depth', '8', 'rgba:-']) };
}
const blank = (width, height) => ({ width, height, pixels: Buffer.alloc(width * height * 4) });
function crop(img, x, y, width, height) {
  const out = blank(width, height);
  for (let row = 0; row < height; row++) img.pixels.copy(out.pixels, row * width * 4,
    ((y + row) * img.width + x) * 4, ((y + row) * img.width + x + width) * 4);
  return out;
}
function paste(dst, src, x, y) {
  if (x < 0 || y < 0 || x + src.width > dst.width || y + src.height > dst.height) throw new Error('Paste would clip artwork');
  for (let row = 0; row < src.height; row++) src.pixels.copy(dst.pixels,
    ((y + row) * dst.width + x) * 4, row * src.width * 4, (row + 1) * src.width * 4);
}
function bounds(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.pixels[(y * img.width + x) * 4 + 3] < 200) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error('Empty frame');
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
function anchor(img) {
  const b = bounds(img), bottom = b.y + b.height - 1, band = Math.max(3, Math.round(b.height * .05));
  let weight = 0, sum = 0;
  for (let y = bottom - band + 1; y <= bottom; y++) for (let x = 0; x < img.width; x++) {
    const a = img.pixels[(y * img.width + x) * 4 + 3];
    if (a < 200) continue;
    weight += a; sum += (x + .5) * a;
  }
  return { x: sum / weight, y: bottom + 1 };
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
  if (!largest.length) throw new Error('No connected flower body');
  const out = blank(width, height);
  for (const p of largest) { pixels.copy(out.pixels, p * 4, p * 4, p * 4 + 3); out.pixels[p * 4 + 3] = 255; }
  return out;
}
function resize(img, width, height) {
  return { width, height, pixels: magick(['-size', `${img.width}x${img.height}`, '-depth', '8', 'rgba:-',
    '-filter', 'Lanczos', '-resize', `${width}x${height}!`, '-depth', '8', 'rgba:-'], img.pixels) };
}
function register(img) {
  const before = anchor(img), dx = Math.round(target.x - before.x), dy = target.y - before.y;
  const out = blank(TILE, TILE);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const p = (y * TILE + x) * 4;
    if (!img.pixels[p + 3]) continue;
    const tx = x + dx, ty = y + dy;
    if (tx < 0 || tx >= TILE || ty < 0 || ty >= TILE) throw new Error('Registration would clip a pixel');
    img.pixels.copy(out.pixels, (ty * TILE + tx) * 4, p, p + 4);
  }
  return out;
}

const source = decode(path.join(root, 'lotus-bloom-960-stable.png'));
if (source.width !== 3840 || source.height !== 3840) throw new Error('Unexpected keyframe atlas');
const keyframes = Array.from({ length: 16 }, (_, i) => crop(source, i % 4 * TILE, Math.floor(i / 4) * TILE, TILE, TILE));
const groups = sources.map(decode), frames = [], provenance = [];
for (let i = 0; i < 16; i++) {
  frames.push(keyframes[i]);
  provenance.push({ frame: i * 2, kind: 'original-keyframe', originalFrame: i });
  if (i === 15) {
    frames.push(keyframes[i]); provenance.push({ frame: 31, kind: 'endpoint-hold', originalFrame: 15 });
    continue;
  }
  if (motion) {
    const final = register(midpoint(keyframes[i], keyframes[i + 1]));
    frames.push(final);
    provenance.push({ frame: i * 2 + 1, kind: 'motion-interpolated-halfway-pose', betweenOriginalFrames: [i, i + 1] });
    console.log(`Interpolated ${i + 1}/15`);
    continue;
  }
  const group = groups[Math.floor(i / 4)], cell = i % 4;
  const x = Math.round(cell % 2 * group.width / 2), y = Math.round(Math.floor(cell / 2) * group.height / 2);
  const generated = foreground(crop(group, x, y, Math.round((cell % 2 + 1) * group.width / 2) - x,
    Math.round((Math.floor(cell / 2) + 1) * group.height / 2) - y));
  const b = bounds(generated), a = bounds(keyframes[i]), z = bounds(keyframes[i + 1]);
  const width = Math.round((a.width + z.width) / 2), height = Math.round((a.height + z.height) / 2);
  const body = resize(crop(generated, b.x, b.y, b.width, b.height), width, height);
  const tile = blank(TILE, TILE);
  paste(tile, body, Math.round((TILE - width) / 2), target.y - height);
  const final = register(tile);
  frames.push(final);
  provenance.push({ frame: i * 2 + 1, kind: 'generated-halfway-pose', betweenOriginalFrames: [i, i + 1], sourceGroup: Math.floor(i / 4), sourceCell: cell,
    fittedBounds: { width, height } });
}
const sequence = [...Array(32).keys(), ...Array.from({ length: 31 }, (_, i) => 30 - i), 0];
const master = blank(7680, 3840), small = blank(3072, 1536), loop = blank(3072, 3072), smallFrames = [];
for (let i = 0; i < frames.length; i++) {
  const a = anchor(frames[i]);
  if (Math.abs(a.x - target.x) > .501 || a.y !== target.y) throw new Error(`Frame ${i} is not registered`);
  if (i % 2 === 0 && !frames[i].pixels.equals(keyframes[i / 2].pixels)) throw new Error('Keyframe changed');
  if (i % 2 === 1 && i < 31 && (frames[i].pixels.equals(frames[i - 1].pixels) || frames[i].pixels.equals(keyframes[(i + 1) / 2].pixels))) throw new Error('Intermediate is a duplicate');
  provenance[i].registrationAnchorPixels = a;
  paste(master, frames[i], i % 8 * TILE, Math.floor(i / 8) * TILE);
  const body = resize(crop(frames[i], 9, 9, 942, 942), 336, 336), packed = blank(384, 384);
  paste(packed, body, 24, 24); smallFrames.push(packed);
  paste(small, packed, i % 8 * 384, Math.floor(i / 8) * 384);
}
for (let i = 0; i < sequence.length; i++) paste(loop, smallFrames[sequence[i]], i % 8 * 384, Math.floor(i / 8) * 384);
// The old sequence is reproduced at every second loop step, including endpoint holds.
const oldSequence = [...Array(16).keys(), ...Array.from({ length: 16 }, (_, i) => 15 - i)];
for (let i = 0; i < 32; i++) if (sequence[i * 2] !== oldSequence[i] * 2) throw new Error('Playback timing changed');
const destinationDir = path.join(root, 'source', 'tweens');
await mkdir(destinationDir, { recursive: true });
for (let i = 0; i < sources.length; i++) {
  const dst = path.join(destinationDir, `group-${i}.png`);
  if (path.resolve(sources[i]) !== dst) await copyFile(sources[i], dst);
}
const assets = [];
for (const [image, data, tileSize, frameCount, playbackSequence] of [
  ['lotus-bloom-960-stable-32.png', master, 960, 32, sequence],
  ['lotus-bloom-384-stable-32.png', small, 384, 32, sequence],
  ['lotus-bloom-384-stable-64-loop.png', loop, 384, 64, [...Array(64).keys()]]
]) {
  const dst = path.join(root, image);
  magick(['-size', `${data.width}x${data.height}`, '-depth', '8', 'rgba:-', dst], data.pixels);
  assets.push({ image, width: data.width, height: data.height, tileSize, columns: 8, rows: data.height / tileSize,
    frameCount, fps: 16, durationSeconds: 4, loop: true, playback: frameCount === 64 ? 'forward' : 'explicit-sequence',
    sourceFrameSequence: playbackSequence, frameOrder: 'row-major', alpha: 'straight', colorSpace: 'srgb',
    registrationAnchor: tileSize === 960 ? [0.5, 801 / 960] : [0.5, (24 + (801 - 9) / 942 * 336) / 384],
    sha256: createHash('sha256').update(await readFile(dst)).digest('hex') });
}
await writeFile(path.join(root, 'manifest-32.json'), JSON.stringify({ version: 1, pack: 'lotus-bloom-upscaled-3x-stabilized-32', status: 'proof-of-concept',
  source: 'lotus-bloom-960-stable.png', method: motion ? 'Bidirectional macOS Vision optical flow (revision 2, veryHigh); inverse halfway warping; premultiplied RGBA synthesis; fixed front-petal registration; unchanged original keyframes' : 'ImageGen halfway-pose reconstruction; largest foreground cleanup; average adjacent bounds; fixed front-petal registration; unchanged original keyframes',
  openingFrameCount: 32, originalKeyframeCount: 16, generatedIntermediateCount: 15, endpointHoldCount: 1, assets, provenance }, null, 2) + '\n');
console.log(JSON.stringify({ assets, checks: '16 original keyframes unchanged; 15 distinct intermediate poses; all anchors registered; old timing preserved at every second loop step' }, null, 2));
