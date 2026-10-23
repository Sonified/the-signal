// The show's slide videos (core/schema-slides.js SLIDE_FILES, ~420 MB),
// fetched whole as soon as a screen is in Presentation mode, one at a time in
// running order, and kept on disk across reloads, so every cue plays from
// this machine instead of streaming at the moment it is picked. slideSrc(file)
// hands gpu/slides.js a blob URL once the file is here (null before, and the
// slide streams as it always has). A blob URL takes the #t= media fragment
// like any other, so a seek's voice starts where it should.
//
// ON DISK: the browser's Cache Storage (CACHE_NAME), which survives reloads
// and restarts until the site's data is cleared; navigator.storage.persist()
// is asked once, so the browser does not evict it under pressure. The
// server's own HTTP cache headers (max-age=0) are no help there.
//
// CHANGED FILES: every video's ETag is its SHA-256 ("sha256-<hex>", from the
// media manifest, tools/presentation-media-handler.mjs). At each load every
// copy on disk is handed out at once, then each is asked about again with its
// ETag (If-None-Match): 304 keeps it, 200 is a changed file, downloaded and
// put in its place. A download whose bytes do not hash to its ETag is never
// kept. No network keeps whatever is on disk. Files no longer in the show are
// deleted from disk. A server that sends no ETag (tools/serve.mjs, local dev,
// where the files are on this disk already) is fetched into memory only.
//
// It waits its turn behind the music's recordings (js/load-order.js
// TURN.slides), so the first sound is never kept waiting by 420 MB of video.
// Only a screen in Presentation mode asks (gpu/slides.js update), so a
// follower's phone never downloads the show. A file that fails is logged and
// skipped; that slide streams as before.
//
// The console says what each file is doing as it goes ([slide-prefetch]):
// from disk, unchanged, changed, its download every quarter of its bytes, its
// hash check, saved, and a total at the end.
import { SLIDE_DIR, SLIDE_FILES } from '../core/schema-slides.js';
import { TURN, inTurn } from './load-order.js';

const CACHE_NAME = 'signal-slides-v1';
const urls = new Map();   // file -> blob URL of the copy this page plays
let started = false;

const log = (...a) => console.log('[slide-prefetch]', ...a);
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const secs = t0 => ((performance.now() - t0) / 1000).toFixed(1) + ' s';

export function slideSrc(file) { return urls.get(file) || null; }

// A blob URL now plays the file. The old one is never revoked: a slide on
// screen may still be reading from it.
function use(file, blob) { urls.set(file, URL.createObjectURL(blob)); }

const shaOf = etag => {
  const m = /^(?:W\/)?"sha256-([0-9a-f]{64})"$/.exec(etag || '');
  return m ? m[1] : null;
};
async function sha256Hex(blob) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  let s = '';
  for (let i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16);
  return s;
}

// The body of a 200, read with a print every quarter of its bytes.
async function download(r, tag) {
  const total = +r.headers.get('Content-Length') || 0;
  if (!r.body || !total) return r.blob();
  const reader = r.body.getReader(), chunks = [];
  let got = 0, quarter = 1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    while (quarter < 4 && got >= total * quarter / 4) {
      log(`${tag}: ${quarter * 25}% (${mb(got)} of ${mb(total)})`);
      quarter++;
    }
  }
  return new Blob(chunks, { type: 'video/mp4' });
}

// One file: asked about again if it is on disk, downloaded if it is new or
// changed, checked against its hash and saved. Returns the bytes downloaded.
async function syncOne(cache, file, i, n, onDisk) {
  const url = new URL(SLIDE_DIR + encodeURIComponent(file), location.href).href;
  const tag = `${i + 1}/${n} ${file}`;
  const savedTag = onDisk ? onDisk.headers.get('ETag') : null;
  const t0 = performance.now();
  let r;
  try {
    r = await fetch(url, { cache: 'no-store', headers: savedTag ? { 'If-None-Match': savedTag } : {} });
  } catch (e) {
    if (onDisk) { log(`${tag}: no network, playing the copy on disk`); return 0; }
    throw e;
  }
  if (r.status === 304) { log(`${tag}: unchanged on the server`); return 0; }
  if (!r.ok) {
    if (onDisk) { log(`${tag}: server said ${r.status}, playing the copy on disk`); return 0; }
    throw new Error('HTTP ' + r.status);
  }
  log(onDisk ? `${tag}: CHANGED on the server, downloading the new one` : `${tag}: downloading`);
  const blob = await download(r, tag);
  const etag = r.headers.get('ETag'), sha = shaOf(etag);
  if (sha) {
    const got = await sha256Hex(blob);
    if (got !== sha) throw new Error('hash mismatch: expected ' + sha.slice(0, 12) + '…, got ' + got.slice(0, 12) + '…; not kept');
    log(`${tag}: hash checks (sha256 ${sha.slice(0, 12)}…)`);
  }
  use(file, blob);
  let where = 'in memory only (the server sends no hash)';
  if (cache && sha) {
    try {
      await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(blob.size), ETag: etag } }));
      where = 'saved to disk';
    } catch (e) {
      where = 'in memory only (saving to disk failed: ' + (e && e.message ? e.message : e) + ')';
    }
  }
  log(`${tag}: done, ${mb(blob.size)} in ${secs(t0)}, ${where}`);
  return blob.size;
}

async function run() {
  const n = SLIDE_FILES.length, t0 = performance.now();
  let cache = null;
  try { if (typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME); }
  catch (e) { console.warn('[slide-prefetch] no Cache Storage here (' + (e && e.message ? e.message : e) + '); the videos are kept in memory only'); }
  if (cache && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(ok => log('persistent storage ' + (ok ? 'granted' : 'not granted (the browser may evict under disk pressure)')), () => {});
  }

  // Everything already on disk plays at once; files the show no longer has
  // are cleared off it.
  const onDisk = new Array(n).fill(null);
  if (cache) {
    const want = new Set();
    for (let i = 0; i < n; i++) {
      const url = new URL(SLIDE_DIR + encodeURIComponent(SLIDE_FILES[i][0]), location.href).href;
      want.add(url);
      try {
        const hit = await cache.match(url);
        if (hit) { onDisk[i] = hit; use(SLIDE_FILES[i][0], await hit.clone().blob()); }
      } catch (e) { /* unreadable: fetched afresh below */ }
    }
    try { for (const req of await cache.keys()) if (!want.has(req.url)) { await cache.delete(req); log('cleared from disk (no longer in the show): ' + req.url); } }
    catch (e) { /* tidying only */ }
    const have = onDisk.filter(Boolean).length;
    log(`${have} of ${n} slide videos on disk and ready; checking every file with the server`);
  } else {
    log(`downloading ${n} slide videos in running order`);
  }

  let bytes = 0, ready = 0;
  for (let i = 0; i < n; i++) {
    const file = SLIDE_FILES[i][0];
    try { bytes += await syncOne(cache, file, i, n, onDisk[i]); }
    catch (e) {
      console.warn('[slide-prefetch] ' + (i + 1) + '/' + n + ' ' + file + ' failed (' + (e && e.message ? e.message : e) + ')' +
        (onDisk[i] ? '; playing the copy on disk' : '; it will stream when its cue plays'));
    }
    if (urls.has(file)) ready++;
  }
  log(`all done: ${ready} of ${n} ready to play from this machine, ${mb(bytes)} downloaded, ${secs(t0)}`);
}

// Idempotent: the first call starts the run, every later one is a no-op.
export function prefetchSlides() {
  if (started) return;
  started = true;
  if (typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function') return;
  inTurn(TURN.slides, run).catch(e => console.warn('[slide-prefetch] stopped: ' + (e && e.message ? e.message : e)));
}
