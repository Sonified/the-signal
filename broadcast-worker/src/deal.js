// The dealt brushes (documents/touch-foundation.md): when the conductor
// turns them on, every member of the hall is dealt a hand of n motif tiles,
// unique across the room: no tile is ever dealt twice. Pure, so node tests
// the very code the hall runs.
//
// The deck is the conductor's paintable tiles (the client knows which tiles
// of a set are empty; the hall deals only what it was handed), shuffled by
// a seed the hall picks when the deal starts, and dealt once, in order,
// from one running position: no tile is ever dealt twice. When the deck
// runs dry (a big room, a small set), a late joiner gets what remains, a
// smaller hand, down to none. The hall is a single Durable Object, so the
// deal is atomic: no two members can ever draw the same card, and no claim
// or collision handling is needed on any client.

export const HAND_MAX = 8;

// A 32-bit seeded generator (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The deck: the tiles in the seed's shuffle (Fisher-Yates), the same for
// the same seed.
export function deck(tiles, seed) {
  const d = tiles.slice();
  const r = rng(seed);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

// A hand of up to n from position pos: { hand, pos } with the position
// after it. Short, or empty, once the deck runs out.
export function dealHand(tiles, seed, pos, n) {
  const d = deck(tiles, seed);
  const want = Math.max(0, Math.min(n | 0, HAND_MAX));
  const from = Math.min(Math.max(0, pos | 0), d.length);
  const to = Math.min(d.length, from + want);
  return { hand: d.slice(from, to), pos: to };
}

// The conductor's {t:'brushes', on, n, a, tiles}, checked: on 0 or 1, n
// 1..HAND_MAX, a the image set 1..99, tiles distinct integers 0..63, at
// least one. Returns { on, n, a, tiles } or null. Off needs nothing else.
export function readBrushes(msg) {
  if (!msg || msg.t !== 'brushes') return null;
  if (msg.on === 0) return { on: 0, n: 0, a: 0, tiles: [] };
  if (msg.on !== 1) return null;
  const { n, a, tiles } = msg;
  if (!Number.isInteger(n) || n < 1 || n > HAND_MAX) return null;
  if (!Number.isInteger(a) || a < 1 || a > 99) return null;
  if (!Array.isArray(tiles) || !tiles.length || tiles.length > 64) return null;
  const seen = new Set();
  for (const t of tiles) {
    if (!Number.isInteger(t) || t < 0 || t > 63 || seen.has(t)) return null;
    seen.add(t);
  }
  return { on: 1, n, a, tiles: tiles.slice() };
}
