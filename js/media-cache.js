// The show's media on this machine's disk: the browser's Cache Storage,
// filled by js/show-media.js on a Presentation-mode screen (the slide
// videos, the HD+ sun, the guided meditation's audio) and read back through
// mediaFetch by the loaders (js/load-order.js, js/ambience.js,
// core/sun-hum.js, core/heartbeat.js), so a reload hears them from disk
// rather than the network. Anywhere nothing was saved (every other screen,
// or a browser without Cache Storage) mediaFetch is a plain fetch.
//
// The name stays signal-slides-v1, from when only the slides were kept, so
// the copies already saved under it are kept too.
export const MEDIA_CACHE = 'signal-slides-v1';

let opened = null;
export function mediaCache() {
  if (!opened) {
    opened = typeof caches !== 'undefined'
      ? caches.open(MEDIA_CACHE).catch(() => null)
      : Promise.resolve(null);
  }
  return opened;
}

export const absUrl = u => new URL(u, typeof location !== 'undefined' ? location.href : 'http://localhost/').href;

// fetch(url), answered from the disk when the file is saved there.
export async function mediaFetch(url) {
  const c = await mediaCache();
  if (c) {
    try { const hit = await c.match(absUrl(url)); if (hit) return hit; }
    catch (e) { /* unreadable: the network below */ }
  }
  return fetch(url);
}
