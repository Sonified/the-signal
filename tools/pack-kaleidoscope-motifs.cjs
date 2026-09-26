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
  // Sets 3 and 4: generated sheets whose shapes do not sit exactly on the
  // 8 x 8 grid (1254 px, so 156.75 px cells, and a few shapes spill over a
  // cell line), so they are packed by component instead (packByComponents).
  'peaceful-shapes': {
    root: '../assets/kaleidoscope/peaceful-shapes-v1',
    source: 'source/peaceful-shapes-source.png',
    output: 'peaceful-shapes-128.png',
    pack: 'peaceful-shapes-v1',
    layout: 'components',
    rows: numberedRows('peaceful'),
  },
  'colorful-shapes': {
    root: '../assets/kaleidoscope/colorful-shapes-v1',
    source: 'source/colorful-shapes-source.png',
    output: 'colorful-shapes-128.png',
    pack: 'colorful-shapes-v1',
    layout: 'components',
    rows: numberedRows('colorful'),
  },
  'flat-colorful-shapes': {
    root: '../assets/kaleidoscope/flat-colorful-shapes-v1',
    source: 'source/flat-colorful-shapes-source.png',
    output: 'flat-colorful-shapes-128.png',
    pack: 'flat-colorful-shapes-v1',
    layout: 'components',
    rows: numberedRows('flat-colorful'),
  },
  'confetti-sparkles': {
    root: '../assets/kaleidoscope/confetti-sparkles-v1',
    source: 'source/confetti-sparkles-source.png',
    output: 'confetti-sparkles-128.png',
    pack: 'confetti-sparkles-v1',
    layout: 'components',
    rows: numberedRows('sparkle'),
  },
  // Clusters of tiny pieces (sequins, star confetti, shards), so the
  // smallest piece kept is far smaller than the other sheets need.
  'photoreal-confetti': {
    root: '../assets/kaleidoscope/photoreal-confetti-v1',
    source: 'source/photoreal-confetti-source.png',
    output: 'photoreal-confetti-128.png',
    pack: 'photoreal-confetti-v1',
    layout: 'components',
    minPixels: 12,
    rows: numberedRows('confetti'),
  },
  // Fine sparks and soft glow: a lower seed so faint spark tips count as the
  // burst, a wider kept ring so the glow is not clipped, and tiny pieces
  // kept for the scattered-star bursts.
  fireworks: {
    root: '../assets/kaleidoscope/fireworks-v1',
    source: 'source/fireworks-source.png',
    output: 'fireworks-128.png',
    pack: 'fireworks-v1',
    layout: 'components',
    seed: 16,
    keepRing: 10,
    minPixels: 8,
    rows: numberedRows('firework'),
  },
  // Photographed leaves and flowers; small pieces kept for the floret
  // clusters (Queen Anne's lace) and fine stems.
  'petal-specimens': {
    root: '../assets/kaleidoscope/set-2',
    source: 'source/set-2.png',
    output: 'set-2-128.png',
    pack: 'set-2',
    layout: 'components',
    minPixels: 12,
    rows: numberedRows('petal'),
  },
  'petals-green-leaves': {
    root: '../assets/kaleidoscope/set-3',
    source: 'source/set-3.png',
    output: 'set-3-128.png',
    pack: 'set-3',
    layout: 'components',
    minPixels: 12,
    rows: numberedRows('petal-leaf'),
  },
  'ferns-wildflower-petals': {
    root: '../assets/kaleidoscope/set-4',
    source: 'source/set-4.png',
    output: 'set-4-128.png',
    pack: 'set-4',
    layout: 'components',
    minPixels: 8,
    rows: numberedRows('fern-petal'),
  },
  'botanical-specimens': {
    root: '../assets/kaleidoscope/botanical-specimens-v1',
    source: 'source/botanical-specimens-source.png',
    output: 'botanical-specimens-128.png',
    pack: 'botanical-specimens-v1',
    layout: 'components',
    minPixels: 12,
    rows: numberedRows('botanical'),
  },
};
function numberedRows(prefix) {
  return Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) =>
    prefix + '-' + String(r * 8 + c + 1).padStart(2, '0')));
}
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

// Component packing: every shape is the set of pixels connected (8-way) to a
// solid body, and belongs to the grid cell its centroid falls in, so a shape
// that spills over a cell line comes along whole and a stacked shape (cairn
// stones, a double wave) keeps all its parts. Everything else in the sheet,
// the faint matte the background removal left behind included, is dropped.
// One scale for the whole sheet, set by its largest shape, so the shapes
// keep their sizes relative to each other; each is centred in its tile.
async function packByComponents() {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  const SEED = spec.seed || 40, KEEP_RING = spec.keepRing || 6, MIN_PIXELS = spec.minPixels || 120;
  const label = new Int32Array(W * H).fill(-1);
  const queue = new Int32Array(W * H);
  const comps = [];
  for (let start = 0; start < W * H; start++) {
    if (label[start] >= 0 || data[start * ch + 3] < SEED) continue;
    const id = comps.length;
    let head = 0, tail = 0, sx = 0, sy = 0, n = 0;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    label[start] = id; queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++], x = i % W, y = (i / W) | 0;
      sx += x; sy += y; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const nx = x + ox, ny = y + oy;
        if ((ox || oy) && nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const j = ny * W + nx;
          if (label[j] < 0 && data[j * ch + 3] >= SEED) { label[j] = id; queue[tail++] = j; }
        }
      }
    }
    comps.push({ n, cx: sx / n, cy: sy / n, x0, y0, x1, y1 });
  }
  // each cell: its components (by centroid) and their joint bounds
  const cellW = W / columns, cellH = H / rows.length;
  const cells = Array.from({ length: columns * rows.length }, () => ({ ids: new Set(), x0: W, y0: H, x1: -1, y1: -1 }));
  comps.forEach((c, id) => {
    if (c.n < MIN_PIXELS) return;
    const col = Math.min(columns - 1, Math.floor(c.cx / cellW)), row = Math.min(rows.length - 1, Math.floor(c.cy / cellH));
    const cell = cells[row * columns + col];
    cell.ids.add(id);
    cell.x0 = Math.min(cell.x0, c.x0); cell.y0 = Math.min(cell.y0, c.y0);
    cell.x1 = Math.max(cell.x1, c.x1); cell.y1 = Math.max(cell.y1, c.y1);
  });
  const empty = cells.map((c, i) => c.ids.size ? -1 : i).filter(i => i >= 0);
  if (empty.length) throw new Error('No shape found in cells ' + empty.join(', '));
  const contentSize = tileSize - padding * 2;
  let largest = 0;
  for (const c of cells) largest = Math.max(largest, c.x1 - c.x0 + 1 + KEEP_RING * 2, c.y1 - c.y0 + 1 + KEEP_RING * 2);
  const scale = contentSize / largest;

  const composites = [], assets = [];
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < columns; column++) {
      const cell = cells[row * columns + column];
      const bx0 = Math.max(0, cell.x0 - KEEP_RING), by0 = Math.max(0, cell.y0 - KEEP_RING);
      const bx1 = Math.min(W - 1, cell.x1 + KEEP_RING), by1 = Math.min(H - 1, cell.y1 + KEEP_RING);
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      // this cell's own pixels, plus a ring of KEEP_RING around them for the
      // antialiasing and glow; a neighbour's pixels never come along
      const own = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        if (cell.ids.has(label[(by0 + y) * W + bx0 + x])) own[y * bw + x] = 1;
      }
      let keep = own;
      for (let pass = 0; pass < KEEP_RING; pass++) {
        const next = keep.slice();
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          if (!keep[y * bw + x]) continue;
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox, ny = y + oy;
            if (nx >= 0 && nx < bw && ny >= 0 && ny < bh) {
              const lj = label[(by0 + ny) * W + bx0 + nx];
              if (lj < 0 || cell.ids.has(lj)) next[ny * bw + nx] = 1;
            }
          }
        }
        keep = next;
      }
      const crop = Buffer.alloc(bw * bh * 4);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const si = ((by0 + y) * W + bx0 + x) * ch, di = (y * bw + x) * 4;
        crop[di] = data[si]; crop[di + 1] = data[si + 1]; crop[di + 2] = data[si + 2];
        crop[di + 3] = keep[y * bw + x] ? data[si + 3] : 0;
      }
      const tw = Math.max(1, Math.round(bw * scale)), th = Math.max(1, Math.round(bh * scale));
      const input = await sharp(crop, { raw: { width: bw, height: bh, channels: 4 } })
        .resize(tw, th, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
      composites.push({
        input,
        left: column * tileSize + Math.round((tileSize - tw) / 2),
        top: row * tileSize + Math.round((tileSize - th) / 2),
      });
      assets.push({ id: rows[row][column], index: row * columns + column, row, column,
        x: column * tileSize, y: row * tileSize, width: tileSize, height: tileSize,
        anchor: [0.5, 0.5], orientation: 'up' });
    }
  }
  return { composites, assets };
}

async function main() {
  if (spec.layout === 'components') {
    const { composites, assets } = await packByComponents();
    await writeAtlas(composites, assets);
    return;
  }
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

  await writeAtlas(composites, assets);
}

async function writeAtlas(composites, assets) {
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
