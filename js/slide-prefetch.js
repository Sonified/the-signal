// The show's slide videos (core/schema-slides.js SLIDE_FILES, ~420 MB),
// fetched whole as soon as a screen is in Presentation mode, one at a time in
// running order, so every cue plays from memory instead of streaming at the
// moment it is picked. The server sends them max-age=0, so the browser's own
// cache cannot be counted on to keep them; each arrives instead as a Blob
// held for the page's life, and slideSrc(file) hands gpu/slides.js its object
// URL once it is complete (null before, and the slide streams as it always
// has). A blob URL takes the #t= media fragment like any other, so a seek's
// voice starts where it should.
//
// It waits its turn behind the music's recordings (js/load-order.js
// TURN.slides), so the first sound is never kept waiting by 420 MB of video.
// Only a screen in Presentation mode asks (gpu/slides.js update), so a
// follower's phone never downloads the show. A file that fails is logged and
// skipped; that slide streams as before.
//
// Each file prints as it goes: its start, every quarter of its bytes, and its
// end with its size and time, then a total once the whole show is in.
import { SLIDE_DIR, SLIDE_FILES } from '../core/schema-slides.js';
import { TURN, inTurn } from './load-order.js';

const urls = new Map();   // file -> object URL, once complete
let started = false;

const log = (...a) => console.log('[slide-prefetch]', ...a);
const mb = n => (n / 1048576).toFixed(1) + ' MB';

export function slideSrc(file) { return urls.get(file) || null; }

async function fetchOne(file, i, n) {
  const url = SLIDE_DIR + encodeURIComponent(file);
  const t0 = performance.now();
  log(`${i + 1}/${n} ${file}: starting`);
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('Content-Length') || 0;
  let got = 0, quarter = 1, blob;
  if (r.body && total) {
    const reader = r.body.getReader(), chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      while (quarter < 4 && got >= total * quarter / 4) {
        log(`${i + 1}/${n} ${file}: ${quarter * 25}% (${mb(got)} of ${mb(total)})`);
        quarter++;
      }
    }
    blob = new Blob(chunks, { type: 'video/mp4' });
  } else {
    blob = await r.blob();
  }
  urls.set(file, URL.createObjectURL(blob));
  const s = (performance.now() - t0) / 1000;
  log(`${i + 1}/${n} ${file}: done, ${mb(blob.size)} in ${s.toFixed(1)} s`);
  return blob.size;
}

// Idempotent: the first call starts the run, every later one is a no-op.
export function prefetchSlides() {
  if (started) return;
  started = true;
  if (typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function') return;
  inTurn(TURN.slides, async () => {
    const n = SLIDE_FILES.length, t0 = performance.now();
    log(`downloading ${n} slide videos in running order`);
    let bytes = 0, ok = 0;
    for (let i = 0; i < n; i++) {
      const file = SLIDE_FILES[i][0];
      try { bytes += await fetchOne(file, i, n); ok++; }
      catch (e) { console.warn('[slide-prefetch] ' + (i + 1) + '/' + n + ' ' + file + ' failed (' + (e && e.message ? e.message : e) + '); it will stream when its cue plays'); }
    }
    log(`all done: ${ok} of ${n} in memory, ${mb(bytes)} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  });
}
