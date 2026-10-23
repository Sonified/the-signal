// The show's media fetched ahead and kept on this machine's disk across
// reloads (js/media-cache.js), as soon as a screen is in Presentation mode,
// one file at a time, in this order:
//   1. the slide videos (core/schema-slides.js SLIDE_FILES, ~420 MB), in
//      running order;
//   2. the Sun at HD+, the top of Auto's ladder (~290 MB, HEVC where this
//      browser plays it, x264 otherwise; gpu/sun.js names it, registerSunFile);
//   3. the guided meditation's audio (~15 MB): every ambience recording, the
//      choir, the four drones, the heartbeat and the rotational hum's data.
// A slide and the Sun play from a blob URL of their copy (showMediaSrc);
// the audio loaders read theirs through mediaFetch. A file not here yet
// streams as it always has. A blob URL takes the #t= media fragment like any
// other, so a slide's seek voice starts where it should.
//
// navigator.storage.persist() is asked once, so the browser does not evict
// the copies under pressure. The server's HTTP cache headers (max-age=0 on
// the slides) are no help across reloads, hence Cache Storage.
//
// CHANGED FILES. Each kind is checked its own way:
//   slides: the ETag is the file's SHA-256 ("sha256-<hex>", the media
//     manifest, tools/presentation-media-handler.mjs). Every load asks again
//     with it (If-None-Match): 304 keeps the copy, 200 is a changed file,
//     downloaded, hashed (crypto.subtle) and kept only if it matches.
//   the Sun: its name carries the render (sun_program_<date>_<frames>), so a
//     new render is a new file; R2 neither answers If-None-Match across
//     origins (the preflight is refused) nor shows its ETag. A copy on disk
//     is never asked about; a download is kept only if its bytes match its
//     Content-Length.
//   audio: the site's own ETag, asked about as the slides are; the bytes
//     checked against Content-Length.
// No network, or a server error, keeps the copy on disk. Files no longer in
// the show are deleted from disk. A server that sends no ETag (tools/
// serve.mjs, local dev, where the files are on this disk already) is
// fetched into memory only.
//
// The network pass waits its turn behind the music's own fetch ahead
// (js/load-order.js TURN.slides). The pass over the disk does not: it runs
// at once, so the Sun can wait for it (showMediaPending) and start on its
// copy rather than the network. FIRST jumps every queue: the heartbeat's
// track, among the first things a show plays, is checked or downloaded
// straight after the look at the disk, before the music and the slides. Only a screen in Presentation mode starts
// any of this (gpu/slides.js and gpu/sun.js), so a follower's phone never
// downloads the show; a file that fails is logged and skipped.
//
// The console says what each file is doing ([show-media]): from disk,
// unchanged, changed, its download every quarter of its bytes, its check,
// saved, and a total at the end.
import { SLIDE_DIR, SLIDE_FILES } from '../core/schema-slides.js';
import { TURN, inTurn } from './load-order.js';
import { mediaCache, mediaFetch, absUrl } from './media-cache.js';

// Fetched before anything else, outside the turns (see above).
const FIRST = ['audio/heartbeat.m4a'];
const urls = new Map();   // absolute URL -> blob URL of the copy this page plays
let sunFile = null;       // { url, name } from gpu/sun.js
let started = false, diskDone = false;

const log = (...a) => console.log('[show-media]', ...a);
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const secs = t0 => ((performance.now() - t0) / 1000).toFixed(1) + ' s';

// The blob URL to play url from, or null while it is not here.
export function showMediaSrc(url) { return urls.get(absUrl(url)) || null; }
// True while the first look at the disk is still running (a fraction of a
// second): the Sun waits for it before choosing its source.
export function showMediaPending() { return started && !diskDone; }
// gpu/sun.js, at its creation: the remote URL of the Sun file to keep.
export function registerSunFile(url, name) { sunFile = { url: absUrl(url), name }; }

// A blob URL now plays the file. The old one is never revoked: a slide or
// the Sun on screen may still be reading from it.
function use(url, blob) { urls.set(url, URL.createObjectURL(blob)); }

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
async function download(r, tag, type) {
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
  return new Blob(chunks, { type });
}

// The show's files, in order. kind: 'slide' and 'sun' play from blob URLs,
// 'audio' through mediaFetch. byName: a new version is a new name (the Sun).
// The audio lists come from their modules, imported only here, on the page
// in Presentation mode (js/ambience.js reaches for document as it loads).
async function showItems() {
  const items = SLIDE_FILES.map(f => ({ url: absUrl(SLIDE_DIR + encodeURIComponent(f[0])), name: f[0], kind: 'slide', type: 'video/mp4' }));
  if (sunFile) items.push({ url: sunFile.url, name: sunFile.name, kind: 'sun', type: 'video/mp4', byName: true });
  try {
    const [amb, choir, piano] = await Promise.all([import('./ambience.js'), import('./choir.js'), import('./piano.js')]);
    const ext = piano.canOpus ? '.opus' : '.mp3';
    const audio = amb.AMBIENCE_SOURCES.map(s => s.path + ext).concat(choir.choirFiles());
    try {
      const meta = await (await mediaFetch('audio/music/manifest.json')).json();
      for (const v of meta.versions) audio.push(`audio/music/${v.file}.opus`);
    } catch (e) { log('the drone list could not be read (' + (e && e.message ? e.message : e) + '); the drones are left to the music fetch'); }
    audio.push('audio/heartbeat.m4a', 'audio/solar_wind_speed_hourly.u16');
    for (const u of audio) items.push({ url: absUrl(u), name: u, kind: 'audio', type: '' });
  } catch (e) {
    log('the meditation audio list could not be made (' + (e && e.message ? e.message : e) + '); the audio streams as before');
  }
  return items;
}

// One file: asked about again if it is on disk (by-name ones are not),
// downloaded if new or changed, checked, and saved. Returns the bytes
// downloaded.
async function syncOne(cache, it, tag, onDisk) {
  if (onDisk && it.byName) { log(`${tag}: on disk`); return 0; }
  const savedTag = onDisk ? onDisk.headers.get('ETag') : null;
  const t0 = performance.now();
  let r;
  try {
    // no-store: the HTTP cache would answer before the server could
    r = await fetch(it.url, { cache: 'no-store', headers: savedTag ? { 'If-None-Match': savedTag } : {} });
  } catch (e) {
    if (onDisk) { log(`${tag}: no network, using the copy on disk`); return 0; }
    throw e;
  }
  if (r.status === 304) { if (it.kind !== 'audio') log(`${tag}: unchanged on the server`); return 0; }
  if (!r.ok) {
    if (onDisk) { log(`${tag}: server said ${r.status}, using the copy on disk`); return 0; }
    throw new Error('HTTP ' + r.status);
  }
  log(onDisk ? `${tag}: CHANGED on the server, downloading the new one` : `${tag}: downloading`);
  const blob = await download(r, tag, it.type || r.headers.get('Content-Type') || '');
  const etag = r.headers.get('ETag'), sha = shaOf(etag);
  const want = +r.headers.get('Content-Length') || 0;
  if (sha) {
    const got = await sha256Hex(blob);
    if (got !== sha) throw new Error('hash mismatch: expected ' + sha.slice(0, 12) + '…, got ' + got.slice(0, 12) + '…; not kept');
    log(`${tag}: hash checks (sha256 ${sha.slice(0, 12)}…)`);
  } else if (want && blob.size !== want) {
    throw new Error('got ' + blob.size + ' bytes of ' + want + '; not kept');
  }
  if (it.kind !== 'audio') use(it.url, blob);
  let where = 'in memory only (the server sends no tag)';
  if (cache && (etag || it.byName)) {
    try {
      const headers = { 'Content-Length': String(blob.size) };
      if (blob.type) headers['Content-Type'] = blob.type;
      if (etag) headers.ETag = etag;
      await cache.put(it.url, new Response(blob, { headers }));
      where = 'saved to disk';
    } catch (e) {
      where = 'in memory only (saving to disk failed: ' + (e && e.message ? e.message : e) + ')';
    }
  }
  if (it.kind === 'audio' && where !== 'saved to disk') where = 'not kept (the loader fetches it as before)';
  log(`${tag}: done, ${mb(blob.size)} in ${secs(t0)}, ${where}`);
  return blob.size;
}

async function run() {
  const t0 = performance.now();
  const cache = await mediaCache();
  if (!cache) console.warn('[show-media] no Cache Storage here; the show is kept in memory only');
  else if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(ok => log('persistent storage ' + (ok ? 'granted' : 'not granted (the browser may evict under disk pressure)')), () => {});
  }

  // The disk, at once: every slide and the Sun already here play from it.
  const playable = SLIDE_FILES.map(f => absUrl(SLIDE_DIR + encodeURIComponent(f[0])));
  if (sunFile) playable.push(sunFile.url);
  const onDisk = new Map();
  if (cache) {
    for (const url of playable) {
      try {
        const hit = await cache.match(url);
        if (hit) { onDisk.set(url, hit); use(url, await hit.clone().blob()); }
      } catch (e) { /* unreadable: fetched afresh below */ }
    }
  }
  diskDone = true;
  log(`${onDisk.size} of ${playable.length} videos on disk and ready` + (sunFile && onDisk.has(sunFile.url) ? ' (the Sun among them)' : ''));

  // The first files, at once, ahead of every turn.
  const first = new Set(FIRST.map(absUrl));
  for (const u of FIRST) {
    const url = absUrl(u), tag = 'first: ' + u;
    let hit = null;
    if (cache) { try { hit = (await cache.match(url)) || null; } catch (e) { /* fetched afresh */ } }
    try {
      const got = await syncOne(cache, { url, name: u, kind: 'audio', type: '' }, tag, hit);
      if (!got) log(`${tag}: ${hit ? 'on disk' : 'not kept'}`);
    } catch (e) { console.warn('[show-media] ' + tag + ' failed (' + (e && e.message ? e.message : e) + '); it streams as before'); }
  }

  // Then the network, in its turn.
  await inTurn(TURN.slides, async () => {
    const items = (await showItems()).filter(it => !first.has(it.url));
    const n = items.length;
    if (cache) {
      for (const it of items) {
        if (it.kind !== 'audio' || onDisk.has(it.url)) continue;
        try { const hit = await cache.match(it.url); if (hit) onDisk.set(it.url, hit); } catch (e) { /* fetched afresh */ }
      }
      const want = new Set(items.map(it => it.url).concat([...first]));
      try {
        for (const req of await cache.keys()) {
          if (want.has(req.url)) continue;
          await cache.delete(req);
          log('cleared from disk (no longer in the show): ' + req.url);
        }
      } catch (e) { /* tidying only */ }
    }
    log(`checking ${n} files with the server: ${SLIDE_FILES.length} slides, ${sunFile ? 'the Sun, ' : ''}${n - SLIDE_FILES.length - (sunFile ? 1 : 0)} audio`);
    let bytes = 0, ready = 0;
    for (let i = 0; i < n; i++) {
      const it = items[i], tag = `${i + 1}/${n} ${it.name}`;
      try { bytes += await syncOne(cache, it, tag, onDisk.get(it.url) || null); }
      catch (e) {
        console.warn('[show-media] ' + tag + ' failed (' + (e && e.message ? e.message : e) + ')' +
          (onDisk.has(it.url) ? '; using the copy on disk' : '; it streams as before'));
      }
      if (it.kind === 'audio' ? (cache && await cache.match(it.url)) : urls.has(it.url)) ready++;
    }
    log(`all done: ${ready} of ${n} on this machine, ${mb(bytes)} downloaded, ${secs(t0)}`);
  });
}

// Idempotent: the first call starts the run, every later one is a no-op.
export function showMediaStart() {
  if (started) return;
  started = true;
  if (typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function') { diskDone = true; return; }
  run().catch(e => { diskDone = true; console.warn('[show-media] stopped: ' + (e && e.message ? e.message : e)); });
}
