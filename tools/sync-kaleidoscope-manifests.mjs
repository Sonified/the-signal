// Adds the semantic groups from assets/kaleidoscope/sets.mjs to every live
// atlas manifest. Run after changing a grouping or importing a new atlas.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KALEIDOSCOPE_SETS } from '../assets/kaleidoscope/sets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

function groupedManifest(set, manifest) {
  const assetKey = Array.isArray(manifest.assets) ? 'assets' : Array.isArray(manifest.tiles) ? 'tiles' : null;
  if (!assetKey || manifest[assetKey].length !== 64) {
    throw new Error(`${set.manifest}: expected exactly 64 assets`);
  }
  const assets = manifest[assetKey];
  const owner = new Array(64).fill(null);
  const groups = set.groups.map(item => {
    for (const index of item.assetIndices) {
      if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error(`${set.name}: invalid tile ${index}`);
      if (owner[index]) throw new Error(`${set.name}: tile ${index} is in both ${owner[index]} and ${item.id}`);
      owner[index] = item.id;
    }
    return { id: item.id, label: item.label, assetIndices: item.assetIndices };
  });
  const missing = owner.flatMap((id, index) => id ? [] : [index]);
  if (missing.length) throw new Error(`${set.name}: ungrouped tiles ${missing.join(', ')}`);
  manifest.name = set.name;
  manifest.groups = groups;
  manifest[assetKey] = assets.map((item, index) => {
    const { group: oldGroup, groups: oldGroups, ...asset } = item;
    return { ...asset, group: owner[index] };
  });
  if (set.id !== 1) return JSON.stringify(manifest, null, 2) + '\n';

  // Set 1 predates the packer and keeps one asset per line. Preserve that
  // compact, hand-readable format instead of expanding 64 records.
  const { assets: compactAssets, groups: compactGroups, ...header } = manifest;
  const top = JSON.stringify({ ...header, groups: compactGroups }, null, 2).replace(/\n}$/, '');
  const lines = compactAssets.map(asset => '    ' + JSON.stringify(asset));
  return `${top},\n  "assets": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

for (const set of KALEIDOSCOPE_SETS.slice(1)) {
  const filename = path.join(root, set.manifest);
  const before = await fs.readFile(filename, 'utf8');
  const after = groupedManifest(set, JSON.parse(before));
  if (check) {
    if (before !== after) throw new Error(`${set.manifest} is out of sync; run node tools/sync-kaleidoscope-manifests.mjs`);
  } else if (before !== after) {
    await fs.writeFile(filename, after);
    console.log(`Updated ${set.manifest}`);
  }
}
