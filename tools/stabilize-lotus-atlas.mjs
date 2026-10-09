// Register existing animation frames by translation only; never regenerate art.
// Usage: node tools/stabilize-lotus-atlas.mjs
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../assets/sprites/lotus-bloom-upscaled-3x/', import.meta.url));
const tileSize = 960, size = tileSize * 4;
function magick(args, input) {
  const result = spawnSync('magick', args, { input, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
const master = magick([path.join(root, 'lotus-bloom-960.png'), '-depth', '8', 'rgba:-']);
if (master.length !== size * size * 4) throw new Error('Unexpected master dimensions');
function frame(index) {
  const output = Buffer.alloc(tileSize * tileSize * 4);
  for (let y = 0; y < tileSize; y++) {
    const start = ((Math.floor(index / 4) * tileSize + y) * size + (index % 4) * tileSize) * 4;
    master.copy(output, y * tileSize * 4, start, start + tileSize * 4);
  }
  return output;
}
function anchor(pixels) {
  // The lowest part of every pose is the same front/base petal. Its opaque
  // bottom supplies y; the bottom 5% supplies a robust centre x. Petal fans
  // higher up never influence registration as the flower opens.
  let top = tileSize, bottom = -1;
  for (let y = 0; y < tileSize; y++) for (let x = 0; x < tileSize; x++) {
    if (pixels[(y * tileSize + x) * 4 + 3] < 200) continue;
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (bottom < 0) throw new Error('Empty frame');
  const band = Math.max(3, Math.round((bottom - top + 1) * .05));
  let sumX = 0, weight = 0;
  for (let y = bottom - band + 1; y <= bottom; y++) for (let x = 0; x < tileSize; x++) {
    const a = pixels[(y * tileSize + x) * 4 + 3];
    if (a < 200) continue;
    sumX += (x + .5) * a; weight += a;
  }
  return { x: sumX / weight, y: bottom + 1 };
}
const frames = Array.from({ length: 16 }, (_, i) => frame(i)), anchors = frames.map(anchor);
const target = { x: tileSize / 2, y: anchors[0].y };
const stabilized = Buffer.alloc(master.length), packed = Buffer.alloc(3072 * 1536 * 4);
const smallFrames = [], translations = [];
for (let i = 0; i < frames.length; i++) {
  const dx = Math.round(target.x - anchors[i].x), dy = Math.round(target.y - anchors[i].y);
  const tile = Buffer.alloc(frames[i].length);
  for (let y = 0; y < tileSize; y++) for (let x = 0; x < tileSize; x++) {
    const src = (y * tileSize + x) * 4;
    if (frames[i][src + 3] === 0) continue;
    const tx = x + dx, ty = y + dy;
    // Include faint antialiasing in the check: stabilization may not crop art.
    if (tx < 0 || ty < 0 || tx >= tileSize || ty >= tileSize) throw new Error(`Frame ${i}: translation would clip a pixel`);
    frames[i].copy(tile, (ty * tileSize + tx) * 4, src, src + 4);
  }
  const after = anchor(tile);
  if (Math.abs(after.x - target.x) > .501 || after.y !== target.y) throw new Error('Anchor registration failed');
  for (let y = 0; y < tileSize; y++) tile.copy(stabilized,
    ((Math.floor(i / 4) * tileSize + y) * size + (i % 4) * tileSize) * 4,
    y * tileSize * 4, (y + 1) * tileSize * 4);
  // Same 942px source window and 24px inset as the first 384px export.
  const small = magick(['-size', '960x960', '-depth', '8', 'rgba:-', '-crop', '942x942+9+9', '+repage',
    '-filter', 'Lanczos', '-resize', '336x336!', '-depth', '8', 'rgba:-'], tile);
  smallFrames.push(small);
  translations.push({ frame: i, dx, dy, before: anchors[i], after });
}
const sequence = [...Array(16).keys(), ...Array.from({ length: 16 }, (_, i) => 15 - i)];
for (let i = 0; i < sequence.length; i++) for (let y = 0; y < 336; y++) smallFrames[sequence[i]].copy(packed,
  ((Math.floor(i / 8) * 384 + 24 + y) * 3072 + (i % 8) * 384 + 24) * 4,
  y * 336 * 4, (y + 1) * 336 * 4);
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
manifest.pack += '-stabilized';
manifest.stabilization = { method: 'Integer translation only, bottom front-petal centre; no per-frame resizing or regenerated art',
  source: 'lotus-bloom-960.png', targetAnchorPixels: target, maxHorizontalErrorPixels: .5, translations };
manifest.method += '; fixed base-petal registration';
for (const [i, pixels] of [stabilized, packed].entries()) {
  const asset = manifest.assets[i];
  asset.image = asset.image.replace('.png', '-stable.png');
  const destination = path.join(root, asset.image);
  magick(['-size', `${asset.width}x${asset.height}`, '-depth', '8', 'rgba:-', destination], pixels);
  asset.sha256 = createHash('sha256').update(await readFile(destination)).digest('hex');
  // Sprite origin remains the centre of its cell for existing consumers.
  asset.registrationAnchor = i === 0 ? [target.x / 960, target.y / 960] :
    [(24 + (target.x - 9) / 942 * 336) / 384, (24 + (target.y - 9) / 942 * 336) / 384];
}
for (const placement of manifest.placement) {
  const t = translations[placement.frame]; placement.masterBounds.x += t.dx; placement.masterBounds.y += t.dy;
}
await writeFile(path.join(root, 'manifest-stable.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ target, translations: translations.map(({ frame, dx, dy }) => ({ frame, dx, dy })),
  images: manifest.assets.map(a => path.join(root, a.image)) }, null, 2));
