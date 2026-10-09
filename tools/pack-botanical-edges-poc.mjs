// Pack four ImageGen 4×4 sheets using their new RGBA contours, never the old mask.
// Usage: node tools/pack-botanical-edges-poc.mjs q0.png q1.png q2.png q3.png
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../assets/kaleidoscope/', import.meta.url));
const sources = process.argv.slice(2);
if (sources.length !== 4) throw new Error('Provide four generated quadrant PNGs, top-left through bottom-right');
function magick(args, input) {
  const result = spawnSync('magick', args, { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
function decode(file) {
  const [width, height] = magick(['identify', '-format', '%w %h', file]).toString().split(' ').map(Number);
  return { width, height, pixels: magick([file, '-depth', '8', 'rgba:-']) };
}
function crop(image, x, y, width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) image.pixels.copy(pixels, row * width * 4,
    ((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4);
  return { width, height, pixels };
}
function bounds(image, threshold) {
  let x0 = image.width, y0 = image.height, x1 = -1, y1 = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.pixels[(y * image.width + x) * 4 + 3] < threshold) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error('Empty motif');
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
function cleanCutout(image) {
  // ImageGen's background removal leaves saturated RGB in low-alpha fringe
  // pixels. Recover its high-resolution foreground contour before reducing
  // resolution; Lanczos packing supplies a narrow antialiased final boundary.
  const { width, height, pixels } = image, count = width * height;
  const seen = new Uint8Array(count), queue = new Int32Array(count), components = [];
  for (let seed = 0; seed < count; seed++) {
    if (seen[seed] || pixels[seed * 4 + 3] < 200) continue;
    let head = 0, tail = 1; queue[0] = seed; seen[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      for (const n of [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1,
        y > 0 ? p - width : -1, y + 1 < height ? p + width : -1]) {
        if (n < 0 || seen[n] || pixels[n * 4 + 3] < 200) continue;
        seen[n] = 1; queue[tail++] = n;
      }
    }
    components.push(Array.from(queue.subarray(0, tail)));
  }
  const largest = Math.max(...components.map(c => c.length));
  if (!Number.isFinite(largest)) throw new Error('No foreground in generated motif');
  const output = Buffer.alloc(pixels.length);
  for (const component of components) {
    if (component.length < Math.max(12, largest * 0.001)) continue;
    for (const p of component) { pixels.copy(output, p * 4, p * 4, p * 4 + 3); output[p * 4 + 3] = 255; }
  }
  return { width, height, pixels: output };
}
const old = decode(path.join(root, 'botanical-atlas-meditation-draft.png'));
const quadrants = sources.map(decode);
if (old.width !== 512 || old.height !== 512 || quadrants.some(q => q.width !== q.height)) throw new Error('Unexpected dimensions');
const size = 1536, tile = 192, output = Buffer.alloc(size * size * 4);
for (let index = 0; index < 64; index++) {
  const row = Math.floor(index / 8), column = index % 8;
  const q = quadrants[Math.floor(row / 4) * 2 + Math.floor(column / 4)];
  const x = Math.round((column % 4) * q.width / 4), y = Math.round((row % 4) * q.height / 4);
  const generated = cleanCutout(crop(q, x, y, Math.round((column % 4 + 1) * q.width / 4) - x,
    Math.round((row % 4 + 1) * q.height / 4) - y));
  const sourceBox = bounds(generated, 8);
  const oldBox = bounds(crop(old, column * 64, row * 64, 64, 64), 40);
  const body = crop(generated, sourceBox.x, sourceBox.y, sourceBox.width, sourceBox.height);
  // Match established placement and extent; all internal holes and edge alpha
  // come from the generated cutout. The original contributes coordinates only.
  const width = oldBox.width * 3, height = oldBox.height * 3;
  const resized = magick(['-size', `${body.width}x${body.height}`, '-depth', '8', 'rgba:-',
    '-filter', 'Lanczos', '-resize', `${width}x${height}!`, '-depth', '8', 'rgba:-'], body.pixels);
  for (let sy = 0; sy < height; sy++) for (let sx = 0; sx < width; sx++) {
    const src = (sy * width + sx) * 4;
    const dst = ((row * tile + oldBox.y * 3 + sy) * size + column * tile + oldBox.x * 3 + sx) * 4;
    resized.copy(output, dst, src, src + 4);
  }
}
const basename = 'botanical-atlas-meditation-draft-upscaled-3x-edges-v2';
const png = path.join(root, basename + '.png');
magick(['-size', `${size}x${size}`, '-depth', '8', 'rgba:-', png], output);
const sourceDir = path.join(root, 'botanical-upscale-edges-v2-source');
await mkdir(sourceDir, { recursive: true });
for (let i = 0; i < 4; i++) {
  const destination = path.join(sourceDir, `quadrant-${i}.png`);
  if (path.resolve(sources[i]) !== destination) await copyFile(sources[i], destination);
}
const manifest = JSON.parse(await readFile(path.join(root, 'botanical-atlas-meditation-draft.manifest.json'), 'utf8'));
manifest.pack = basename; manifest.image = basename + '.png';
manifest.width = manifest.height = size; manifest.tileSize = tile; manifest.padding *= 3;
manifest.sha256 = createHash('sha256').update(await readFile(png)).digest('hex');
manifest.status = 'proof-of-concept';
manifest.source = Array.from({ length: 4 }, (_, i) => `botanical-upscale-edges-v2-source/quadrant-${i}.png`);
manifest.method = 'ImageGen rebuilt photographic RGBA cutouts in four groups; high-resolution foreground contour from alpha >= 200, isolated speck removal, Lanczos antialiasing; original bounds only';
for (const asset of manifest.assets) for (const key of ['x', 'y', 'width', 'height']) asset[key] *= 3;
await writeFile(path.join(root, basename + '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ image: png, motifs: 64, width: size, height: size, alpha: 'new high-resolution cutouts' }));
