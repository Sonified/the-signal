// Packs a generated 8×8 study into exact 128px production tiles.
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');

const packs = {
  motifs: {
    root: '../assets/kaleidoscope/motifs-v1',
    source: 'source/kaleidoscope-motifs-source.png',
    output: 'motifs-128.png',
    pack: 'kaleidoscope-motifs-v1',
    rows: [
      ['ginkgo-leaf', 'fern-leaf', 'eucalyptus-sprig', 'monstera-leaf', 'maple-leaf', 'willow-leaf', 'spear-leaf', 'seed-leaf'],
      ['lotus', 'peony', 'daisy', 'orchid', 'poppy', 'dahlia', 'bellflower', 'star-blossom'],
      ['four-point-star', 'eight-point-star', 'crescent-moon', 'sun', 'comet', 'constellation', 'aurora-ribbon', 'luminous-planet'],
      ['cloud-puff', 'wispy-cloud', 'rain-drop', 'curling-wave', 'mist-ribbon', 'snow-crystal', 'rainbow-fragment', 'pearl-bubble'],
      ['fern-sprout', 'vine-tip', 'lavender-stem', 'wheat-stem', 'succulent', 'mushroom', 'berry-sprig', 'seed-pod'],
      ['hard-candy', 'ribbon-candy', 'gumdrop', 'spiral-candy', 'jelly-bean', 'wrapped-candy', 'sugar-crystal', 'fruit-chew'],
      ['feather', 'seashell', 'coral-branch', 'quartz-point', 'opal-shard', 'butterfly-wing', 'polished-pebble', 'tiny-flame'],
      ['ribbon-loop', 'iridescent-drop', 'glass-torus', 'portal-shard', 'pearl-cluster', 'light-filament', 'winged-seed', 'prismatic-spiral'],
    ],
  },
  'flower-stickers': {
    root: '../assets/kaleidoscope/flower-stickers-128-v1',
    source: 'source/flower-stickers-source.png',
    output: 'flower-stickers-128.png',
    pack: 'flower-stickers-128-v1',
    rows: [
      ['daisy-01', 'daisy-02', 'daisy-03', 'daisy-04', 'daisy-05', 'daisy-06', 'daisy-07', 'daisy-08'],
      ['tulip-01', 'tulip-02', 'tulip-03', 'tulip-04', 'tulip-05', 'heart-tulip', 'tiny-tulip', 'tall-tulip'],
      ['sunflower-01', 'sunflower-02', 'sunflower-03', 'sunflower-04', 'sunflower-05', 'sunflower-06', 'sunflower-07', 'sunflower-08'],
      ['heart-petal-flower', 'teardrop-flower', 'scallop-flower', 'star-flower', 'soft-flower-01', 'soft-flower-02', 'soft-flower-03', 'soft-flower-04'],
      ['bluebell', 'lavender', 'poppy', 'buttercup', 'forget-me-not', 'clover-blossom', 'tiny-orchid', 'dandelion-puff'],
      ['lotus', 'water-lily', 'hibiscus', 'magnolia', 'peony', 'dahlia', 'zinnia', 'chrysanthemum'],
      ['polka-dot-flower', 'striped-flower', 'checker-flower', 'rainbow-flower', 'mismatched-flower', 'spiral-center-flower', 'confetti-center-flower', 'patchwork-flower'],
      ['short-stem-flower', 'two-leaf-flower', 'shy-bud', 'paired-blossoms', 'flower-sprout', 'cloud-flower', 'smiling-flower', 'sleepy-flower'],
    ],
  },
};
const packName = process.argv[2] || 'motifs';
const spec = packs[packName];
if (!spec) throw new Error(`Unknown pack "${packName}". Use: ${Object.keys(packs).join(', ')}`);
const root = path.resolve(__dirname, spec.root);
const source = path.join(root, spec.source);
const output = path.join(root, spec.output);
const tileSize = 128;
const padding = 12;
const columns = 8;
const sourceInset = 12;
const feather = 6;

const rows = spec.rows;

function retainMotifComponents(data, width, height, channels) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components = [];
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || data[start * channels + 3] < 12) continue;
    let head = 0, tail = 0;
    const pixels = [];
    let sumX = 0, sumY = 0;
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      pixels.push(index);
      const x = index % width, y = Math.floor(index / width);
      sumX += x;
      sumY += y;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (!visited[next] && data[next * channels + 3] >= 12) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    components.push({ pixels, centerX: sumX / pixels.length, centerY: sumY / pixels.length });
  }

  const primarySize = Math.max(...components.map(component => component.pixels.length), 0);
  let keep = new Uint8Array(width * height);
  const edgeBand = 10;
  const minimumSize = Math.max(6, Math.round(primarySize * 0.002));
  for (const component of components) {
    const centered = component.centerX >= edgeBand && component.centerX < width - edgeBand
      && component.centerY >= edgeBand && component.centerY < height - edgeBand;
    if (component.pixels.length >= minimumSize && centered) {
      for (const index of component.pixels) keep[index] = 1;
    }
  }
  // Retain translucent glow and antialiasing around accepted components.
  for (let pass = 0; pass < 6; pass++) {
    const expanded = keep.slice();
    for (let index = 0; index < keep.length; index++) {
      if (!keep[index]) continue;
      const x = index % width, y = Math.floor(index / width);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const nx = x + ox, ny = y + oy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) expanded[ny * width + nx] = 1;
      }
    }
    keep = expanded;
  }
  for (let index = 0; index < keep.length; index++) {
    if (!keep[index]) data[index * channels + 3] = 0;
  }
}

async function main() {
  const { width, height, hasAlpha } = await sharp(source).metadata();
  if (!width || !height || !hasAlpha) throw new Error('Expected an RGBA source image.');

  const composites = [];
  const assets = [];
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < columns; column++) {
      const left = Math.round(column * width / columns);
      const top = Math.round(row * height / rows.length);
      const right = Math.round((column + 1) * width / columns);
      const bottom = Math.round((row + 1) * height / rows.length);
      const contentSize = tileSize - padding * 2;
      const { data, info } = await sharp(source)
        .extract({
          left: left + sourceInset,
          top: top + sourceInset,
          width: right - left - sourceInset * 2,
          height: bottom - top - sourceInset * 2,
        })
        .resize(contentSize, contentSize, { fit: 'fill', kernel: 'lanczos3' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // Generated sheets can have tiny remnants from adjacent cells. Fade the
      // outer pixels so mirrored motifs never reveal rectangular seams.
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const edge = Math.min(x, y, info.width - 1 - x, info.height - 1 - y);
          const factor = Math.max(0, Math.min(1, edge / feather));
          const alpha = (y * info.width + x) * info.channels + 3;
          data[alpha] = Math.round(data[alpha] * factor);
        }
      }
      retainMotifComponents(data, info.width, info.height, info.channels);
      const input = await sharp(data, { raw: info }).png().toBuffer();
      composites.push({
        input,
        left: column * tileSize + padding,
        top: row * tileSize + padding,
      });
      assets.push({
        id: rows[row][column],
        index: row * columns + column,
        row,
        column,
        x: column * tileSize,
        y: row * tileSize,
        width: tileSize,
        height: tileSize,
        anchor: [0.5, 0.5],
        orientation: 'up',
      });
    }
  }

  await sharp({
    create: {
      width: columns * tileSize,
      height: rows.length * tileSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites).png().toFile(output);

  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    version: 1,
    pack: spec.pack,
    image: path.basename(output),
    width: columns * tileSize,
    height: rows.length * tileSize,
    tileSize,
    padding,
    columns,
    rows: rows.length,
    frameOrder: 'row-major',
    alpha: 'straight',
    colorSpace: 'srgb',
    defaultOrientation: 'up',
    assets,
  }, null, 2) + '\n');

  console.log(`Packed ${assets.length} motifs into ${columns * tileSize}×${rows.length * tileSize}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
