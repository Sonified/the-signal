// Mechanical atlas packing only; artwork comes from the saved ImageGen sources.
// Requires sharp. See assets/sprites/celestial-v1/README.md for the rebuild command.
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '../assets/sprites/celestial-v1');
const specs = [
  { id: 'star-shimmer', name: 'Celestial twinkle', sourceId: 'star-twinkle-v2', tileSize: 64, fps: 12, playback: 'source', revision: 2 },
  { id: 'lotus-bloom', name: 'Opal lotus', tileSize: 128, fps: 8, playback: 'ping-pong', revision: 1 },
];

async function main() {
  const assets = [];
  for (const spec of specs) {
    const sourceId = spec.sourceId || spec.id;
    const source = path.join(root, 'source', `${sourceId}.png`);
    const { width, height, hasAlpha } = await sharp(source).metadata();
    if (!hasAlpha || width !== height) throw new Error(`Expected square RGBA source: ${source}`);
    const inset = spec.tileSize / 16;
    const contentSize = spec.tileSize - 2 * inset;
    const frames = [];
    for (let frame = 0; frame < 16; frame++) {
      const col = frame % 4, row = Math.floor(frame / 4);
      const left = Math.round(col * width / 4), top = Math.round(row * height / 4);
      const right = Math.round((col + 1) * width / 4), bottom = Math.round((row + 1) * height / 4);
      frames.push(await sharp(source)
        .extract({ left, top, width: right - left, height: bottom - top })
        .resize(contentSize, contentSize, { kernel: 'lanczos3' })
        .png().toBuffer());
    }
    const sourceSequence = [...Array(16).keys()];
    // Generated twinkles contain a complete rise-and-fall cycle. The lotus is
    // an opening study, so its closing motion is supplied by ping-pong playback.
    const sequence = spec.playback === 'source'
      ? sourceSequence
      : [...sourceSequence, ...sourceSequence.toReversed()];
    const columns = 8, rows = Math.ceil(sequence.length / columns);
    await sharp({ create: {
      width: columns * spec.tileSize, height: rows * spec.tileSize,
      channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
    } }).composite(sequence.map((sourceFrame, frame) => ({
      input: frames[sourceFrame],
      left: (frame % columns) * spec.tileSize + inset,
      top: Math.floor(frame / columns) * spec.tileSize + inset,
    }))).png().toFile(path.join(root, `${spec.id}-${spec.tileSize}.png`));
    assets.push({ ...spec, image: `${spec.id}-${spec.tileSize}.png`,
      width: columns * spec.tileSize, height: rows * spec.tileSize,
      columns, rows, frameCount: sequence.length, loop: true,
      frameOrder: 'row-major', padding: inset, anchor: [0.5, 0.5],
      durationSeconds: Math.round(sequence.length / spec.fps * 100) / 100,
      source: `source/${sourceId}.png`, sourceFrameSequence: sequence });
  }
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    version: 2, pack: 'celestial-v1', status: 'art-prototype',
    alpha: 'straight', colorSpace: 'srgb', assets,
  }, null, 2) + '\n');
  console.log('Packed:', assets.map(a => `${a.image}: ${a.width}×${a.height}, ${a.frameCount} frames`).join('\n'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
