// Kaleidoscope atlas metadata shared by the controls, renderer and packing
// tools. A group is a semantic category, not necessarily an atlas row: the
// photographed sets deliberately interleave leaves, petals and flowers.

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
const all = range(0, 63);
const rest = (...lists) => {
  const used = new Set(lists.flat());
  return all.filter(index => !used.has(index));
};
const group = (id, label, assetIndices) => ({ id, label, assetIndices });

const set1Petals = [...range(0, 15), 60];
const set1Ferns = [16, 17, 18, 19, 20, 21, 23];
const set1Leaves = range(24, 31);
const set1Sprigs = [32, 33, 34, 35, 48, 49, 50, 52, 54, 59, 63];

const set3Leaves = [
  1, 3, 5, 7, 8, 10, 14, 17, 19, 21, 23, 24, 26, 28, 31, 33,
  35, 37, 38, 40, 42, 44, 47, 49, 51, 53, 55, 56, 58, 60, 62,
];

const set5Petals = [1, 20, 37, 52];
const set5Autumn = [3, 5, 13, 23, 32, 35, 46, 49, 63];
const set5Sprigs = [8, 14, 33, 38, 47, 60];
const set5Flowers = [
  2, 6, 9, 11, 16, 18, 22, 25, 27, 29, 31, 39, 41, 43, 45, 50,
  54, 56, 57, 59, 61,
];

const set7Flowers = [1, 4, 11, 13, 17, 20, 27, 29, 35, 38, 42, 44, 50, 53, 60, 62];
const set7Celestial = [0, 2, 3, 7, 10, 19, 23, 25, 31, 34, 40, 45, 47, 49, 52, 55, 58];
const set7Gems = [5, 9, 12, 16, 22, 28, 32, 37, 41, 46, 48, 56, 61];
const set7Spirals = [6, 14, 18, 21, 26, 30, 33, 39, 43, 51, 57, 63];

const set10Ribbons = [4, 13, 16, 22, 32, 46, 51, 57, 61];
const set10Sequins = [0, 6, 10, 19, 27, 30, 38, 44, 53, 55];
const set10Symbols = [3, 8, 20, 25, 36, 42, 45, 59];
const set10Shards = [2, 11, 15, 26, 33, 39, 48];
const set10Glitter = [12, 24, 35, 41, 50, 56, 60];

const set12Botanical = [2, 7, 11, 16, 22, 26, 28, 33, 38, 42, 47, 48, 51, 57, 61];
const set12Arches = [5, 10, 23, 27, 37, 40, 55, 58];
const set12Waves = [3, 21, 25, 32, 43, 46];
const set12Landscapes = [9, 20, 30, 53];
const set12Circles = [0, 4, 14, 17, 19, 34, 35, 39, 44, 49, 54, 59, 63];

export const KALEIDOSCOPE_SETS = Object.freeze([
  null,
  {
    id: 1,
    name: 'Botanical atlas',
    image: 'assets/kaleidoscope/botanical-atlas-meditation-draft.png',
    manifest: 'assets/kaleidoscope/botanical-atlas-meditation-draft.manifest.json',
    // The same motifs at three times the size (192 px tiles, 1536 square),
    // drawn instead of image while the High resolution toggle is on.
    imageHi: 'assets/kaleidoscope/botanical-atlas-meditation-draft-upscaled-3x-edges-v2.png',
    groups: [
      group('petals', 'Petals', set1Petals),
      group('ferns', 'Ferns', set1Ferns),
      group('leaves', 'Leaves', set1Leaves),
      group('sprigs-shoots', 'Sprigs & shoots', set1Sprigs),
      group('flowers', 'Flowers', rest(set1Petals, set1Ferns, set1Leaves, set1Sprigs)),
    ],
  },
  {
    id: 2,
    name: 'Petal specimens',
    image: 'assets/kaleidoscope/set-2/set-2-128.png',
    manifest: 'assets/kaleidoscope/set-2/manifest.json',
    groups: [group('petals', 'Petals', all)],
  },
  {
    id: 3,
    name: 'Petals and green leaves',
    image: 'assets/kaleidoscope/set-3/set-3-128.png',
    manifest: 'assets/kaleidoscope/set-3/manifest.json',
    groups: [
      group('petals', 'Petals', rest(set3Leaves)),
      group('leaves', 'Leaves', set3Leaves),
    ],
  },
  {
    id: 4,
    name: 'Ferns and wildflower petals',
    image: 'assets/kaleidoscope/set-4/set-4-128.png',
    manifest: 'assets/kaleidoscope/set-4/manifest.json',
    groups: [
      group('ferns', 'Ferns', all.filter(index => ((index >> 3) + (index & 7)) % 2 === 0)),
      group('petals', 'Wildflower petals', all.filter(index => ((index >> 3) + (index & 7)) % 2 === 1)),
    ],
  },
  {
    id: 5,
    name: 'Botanical specimens',
    image: 'assets/kaleidoscope/botanical-specimens-v1/botanical-specimens-128.png',
    manifest: 'assets/kaleidoscope/botanical-specimens-v1/manifest.json',
    groups: [
      group('flowers', 'Flowers', set5Flowers),
      group('petals', 'Petals', set5Petals),
      group('green-leaves', 'Green leaves', rest(set5Flowers, set5Petals, set5Autumn, set5Sprigs)),
      group('autumn-leaves', 'Autumn leaves', set5Autumn),
      group('ferns-sprigs', 'Ferns & sprigs', set5Sprigs),
    ],
  },
  {
    id: 6,
    name: 'Luminous motifs',
    image: 'assets/kaleidoscope/motifs-v1/motifs-128.png',
    manifest: 'assets/kaleidoscope/motifs-v1/manifest.json',
    groups: [
      group('leaves', 'Leaves', range(0, 7)),
      group('flowers', 'Flowers', range(8, 15)),
      group('celestial', 'Celestial', range(16, 23)),
      group('sky-water', 'Sky & water', range(24, 31)),
      group('botanical', 'Botanical', range(32, 39)),
      group('candy', 'Candy', range(40, 47)),
      group('treasures', 'Treasures', range(48, 55)),
      group('light', 'Light', range(56, 63)),
    ],
  },
  {
    id: 7,
    name: 'Colorful shapes',
    image: 'assets/kaleidoscope/colorful-shapes-v1/colorful-shapes-128.png',
    manifest: 'assets/kaleidoscope/colorful-shapes-v1/manifest.json',
    groups: [
      group('flowers', 'Flowers', set7Flowers),
      group('celestial', 'Celestial', set7Celestial),
      group('gems', 'Gems', set7Gems),
      group('spirals', 'Spirals', set7Spirals),
      group('abstract', 'Abstract', rest(set7Flowers, set7Celestial, set7Gems, set7Spirals)),
    ],
  },
  {
    id: 8,
    name: 'Flat colorful shapes',
    image: 'assets/kaleidoscope/flat-colorful-shapes-v1/flat-colorful-shapes-128.png',
    manifest: 'assets/kaleidoscope/flat-colorful-shapes-v1/manifest.json',
    groups: [
      group('geometry', 'Geometry', range(0, 15)),
      group('stars-symbols', 'Stars & symbols', [16, 17, 48, 49, 50, 51]),
      group('curves-segments', 'Curves & segments', range(18, 31)),
      group('organic', 'Organic shapes', [...range(32, 39), ...range(52, 55)]),
      group('polygons', 'Polygons', [...range(40, 47), ...range(56, 63)]),
    ],
  },
  {
    id: 9,
    name: 'Confetti and sparkles',
    image: 'assets/kaleidoscope/confetti-sparkles-v1/confetti-sparkles-128.png',
    manifest: 'assets/kaleidoscope/confetti-sparkles-v1/manifest.json',
    groups: [
      group('sparkles', 'Sparkles', [0, 7, 14, 18, 25, 37, 40, 54, 58, 63]),
      group('circles', 'Circles', [1, 12, 21, 28, 34, 45, 50, 61]),
      group('polygons', 'Polygons', [2, 9, 17, 27, 32, 39, 46, 48, 55, 59]),
      group('bars-shards', 'Bars & shards', [3, 8, 10, 13, 16, 19, 22, 23, 26, 30, 36, 38, 43, 44, 49, 53, 57, 60]),
      group('ribbons-curves', 'Ribbons & curves', [4, 6, 11, 15, 24, 31, 35, 41, 47, 52]),
      group('zigzags', 'Zigzags', [5, 20, 29, 33, 42, 51, 56, 62]),
    ],
  },
  {
    id: 10,
    name: 'Photoreal confetti',
    image: 'assets/kaleidoscope/photoreal-confetti-v1/photoreal-confetti-128.png',
    manifest: 'assets/kaleidoscope/photoreal-confetti-v1/manifest.json',
    groups: [
      group('ribbons', 'Ribbons', set10Ribbons),
      group('sequins', 'Sequins', set10Sequins),
      group('stars-hearts', 'Stars & hearts', set10Symbols),
      group('gem-shards', 'Gem shards', set10Shards),
      group('glitter-clusters', 'Glitter clusters', set10Glitter),
      group('foil-paper', 'Foil & paper', rest(set10Ribbons, set10Sequins, set10Symbols, set10Shards, set10Glitter)),
    ],
  },
  {
    id: 11,
    name: 'Fireworks',
    image: 'assets/kaleidoscope/fireworks-v1/fireworks-128.png',
    manifest: 'assets/kaleidoscope/fireworks-v1/manifest.json',
    groups: [group('fireworks', 'Fireworks', all)],
  },
  {
    id: 12,
    name: 'Peaceful shapes',
    image: 'assets/kaleidoscope/peaceful-shapes-v1/peaceful-shapes-128.png',
    manifest: 'assets/kaleidoscope/peaceful-shapes-v1/manifest.json',
    groups: [
      group('botanical', 'Botanical', set12Botanical),
      group('arches-crescents', 'Arches & crescents', set12Arches),
      group('waves', 'Waves', set12Waves),
      group('landscapes', 'Landscapes', set12Landscapes),
      group('circles-stacks', 'Circles & stacks', set12Circles),
      group('organic', 'Organic shapes', rest(set12Botanical, set12Arches, set12Waves, set12Landscapes, set12Circles)),
    ],
  },
]);

export const KALEIDOSCOPE_SET_COUNT = KALEIDOSCOPE_SETS.length - 1;

export function kaleidoscopeSet(value) {
  const id = Number(value) | 0;
  return KALEIDOSCOPE_SETS[id] || KALEIDOSCOPE_SETS[1];
}
