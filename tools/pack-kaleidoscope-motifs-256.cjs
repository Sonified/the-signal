// Packs a generated 4×4 study into exact 256px production tiles.
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');

const packs = {
  biodigital: {
    root: '../assets/kaleidoscope/motifs-256-v1',
    source: 'source/biodigital-motifs-source.png',
    pack: 'biodigital-kaleidoscope-motifs-256-v1',
    rows: [
      ['ginkgo-neural-interface', 'quantum-fern', 'sensor-eucalyptus', 'signal-spear-leaf'],
      ['consciousness-lotus', 'biointerface-orchid', 'recursive-dahlia', 'plasma-star-blossom'],
      ['energy-vine', 'lattice-succulent', 'signal-lavender', 'data-seed-pod'],
      ['mycelial-neural-node', 'living-portal-torus', 'coherent-aurora', 'awareness-vortex'],
    ],
  },
  photoreal: {
    root: '../assets/kaleidoscope/motifs-256-photoreal-v1',
    source: 'source/photoreal-botanical-source.png',
    pack: 'photoreal-botanical-kaleidoscope-motifs-256-v1',
    rows: [
      ['ginkgo-leaf', 'fiddlehead-fern', 'eucalyptus-sprig', 'monstera-leaf'],
      ['pink-lotus', 'cream-orchid', 'coral-dahlia', 'scarlet-poppy'],
      ['white-peony', 'blue-anemone', 'passionflower', 'white-magnolia'],
      ['lavender-stem', 'vine-tendril', 'echeveria-rosette', 'milkweed-seed-pod'],
    ],
  },
  flat: {
    root: '../assets/kaleidoscope/motifs-256-flat-v1',
    source: 'source/flat-botanical-source.png',
    pack: 'flat-botanical-kaleidoscope-motifs-256-v1',
    rows: [
      ['ginkgo-leaf', 'fiddlehead-fern', 'eucalyptus-sprig', 'monstera-leaf'],
      ['pink-lotus', 'cream-orchid', 'coral-dahlia', 'scarlet-poppy'],
      ['white-peony', 'blue-anemone', 'passionflower', 'white-magnolia'],
      ['lavender-stem', 'vine-tendril', 'echeveria-rosette', 'milkweed-seed-pod'],
    ],
  },
};
const packName = process.argv[2] || 'biodigital';
const spec = packs[packName];
if (!spec) throw new Error(`Unknown pack "${packName}". Use: ${Object.keys(packs).join(', ')}`);
const root = path.resolve(__dirname, spec.root);
const source = path.join(root, spec.source);
const output = path.join(root, 'motifs-256.png');
const tileSize = 256;
const padding = 20;
const columns = 4;
const sourceInset = 14;
const feather = 12;

const rows = spec.rows;

function retainMotifComponents(data, width, height, channels) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components = [];
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || data[start * channels + 3] < 12) continue;
    let head = 0, tail = 0, sumX = 0, sumY = 0;
    const pixels = [];
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width, y = Math.floor(index / width);
      pixels.push(index);
      sumX += x;
      sumY += y;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
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
    components.push({ pixels, centerX: sumX / pixels.length, centerY: sumY / pixels.length });
  }

  const primarySize = Math.max(...components.map(component => component.pixels.length), 0);
  const minimumSize = Math.max(12, Math.round(primarySize * 0.002));
  const edgeBand = 18;
  let keep = new Uint8Array(width * height);
  for (const component of components) {
    const centered = component.centerX >= edgeBand && component.centerX < width - edgeBand
      && component.centerY >= edgeBand && component.centerY < height - edgeBand;
    if (component.pixels.length >= minimumSize && centered) {
      for (const index of component.pixels) keep[index] = 1;
    }
  }
  for (let pass = 0; pass < 10; pass++) {
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

      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        const edge = Math.min(x, y, info.width - 1 - x, info.height - 1 - y);
        const factor = Math.max(0, Math.min(1, edge / feather));
        const alpha = (y * info.width + x) * info.channels + 3;
        data[alpha] = Math.round(data[alpha] * factor);
      }
      retainMotifComponents(data, info.width, info.height, info.channels);
      const input = await sharp(data, { raw: info }).png().toBuffer();
      composites.push({ input, left: column * tileSize + padding, top: row * tileSize + padding });
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

  await sharp({ create: {
    width: columns * tileSize,
    height: rows.length * tileSize,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  } }).composite(composites).png().toFile(output);

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
