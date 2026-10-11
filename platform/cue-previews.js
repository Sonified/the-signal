// Local 144p previews for the show's cue buttons. All clips can be cached,
// while a single muted player follows the laptop's reported video clock.
import { createPreviewClock } from './preview-clock.js';

const BASE = '/slides/previews/144p-30fps/';

function openCache() {
  return new Promise(resolve => {
    try {
      const request = indexedDB.open('signal-cue-previews', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('assets');
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachedBlob(db, key, url, bytes) {
  if (db) {
    const stored = await new Promise(resolve => {
      try {
        const request = db.transaction('assets').objectStore('assets').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    if (stored instanceof Blob && stored.size === bytes) return stored;
  }
  const response = await fetch(url);
  if (!response.ok) throw Error('Preview asset unavailable');
  const blob = await response.blob();
  if (blob.size !== bytes) throw Error('Preview asset incomplete');
  if (db) {
    await new Promise(resolve => {
      try {
        const tx = db.transaction('assets', 'readwrite');
        tx.objectStore('assets').put(blob, key);
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
  return blob;
}

export async function createCuePreviews({ cues, prefixes, getPlayback }) {
  const db = await openCache();
  // Best effort: browser-managed storage may otherwise be evicted.
  try { void navigator.storage?.persist?.().catch(() => {}); } catch {}
  // Keep the manifest alongside the blobs so cached previews can load even
  // if the local file server is temporarily unreachable on a later visit.
  let manifest;
  try {
    const response = await fetch(BASE + 'manifest.json');
    if (!response.ok) throw Error('Preview manifest unavailable');
    manifest = await response.json();
    if (db) {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put(manifest, 'manifest');
    }
  } catch (error) {
    if (db) manifest = await new Promise(resolve => {
      const request = db.transaction('assets').objectStore('assets').get('manifest');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    if (!manifest) throw error;
  }
  const assets = new Map();
  for (const item of manifest.videos || []) {
    if (!item.file || item.file.includes('/') || item.file.includes('\\') || !item.poster || item.poster.includes('/') || item.poster.includes('\\')) continue;
    assets.set(item.source, { ...item, url: null, loading: null });
  }
  const thumbnails = prefixes.map((prefix, index) => {
    const asset = [...assets.values()].find(v => v.source.startsWith(prefix + '_'));
    if (!asset || !cues[index]) return null;
    const box = document.createElement('span');
    box.className = 'cue-thumb'; box.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.alt = ''; image.decoding = 'async';
    box.appendChild(image); cues[index].appendChild(box);
    cachedBlob(db, 'poster:' + asset.file + ':' + asset.sha256, BASE + encodeURIComponent(asset.poster), asset.poster_bytes)
      .then(blob => { image.src = URL.createObjectURL(blob); })
      .catch(() => { box.hidden = true; });
    return { box, image, asset };
  });
  const player = document.createElement('video');
  player.muted = true; player.defaultMuted = true; player.playsInline = true;
  player.preload = 'auto'; player.setAttribute('aria-hidden', 'true');
  let current = null, generation = 0, loaded = false, playPending = false, playRefused = false;
  let delayMs = 0;
  const clock = createPreviewClock();
  const events = [];
  let targetTime = null, frameCount = 0, lastFrameAt = null;
  function record(kind, extra = {}) {
    events.push({ at: Math.round(performance.now()), kind, time: +player.currentTime.toFixed(3),
      paused: player.paused, seeking: player.seeking, ready: player.readyState, ...extra });
    if (events.length > 50) events.shift();
  }
  for (const kind of ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing', 'pause',
    'waiting', 'stalled', 'seeking', 'seeked', 'ratechange', 'ended', 'error']) {
    player.addEventListener(kind, () => record(kind));
  }
  if (player.requestVideoFrameCallback) {
    const frame = () => { frameCount++; lastFrameAt = performance.now(); player.requestVideoFrameCallback(frame); };
    player.requestVideoFrameCallback(frame);
  }
  function loadVideo(asset) {
    if (!asset.loading) {
      asset.loading = cachedBlob(db, 'video:' + asset.file + ':' + asset.sha256,
        BASE + encodeURIComponent(asset.file), asset.bytes)
        .then(blob => (asset.url = URL.createObjectURL(blob)))
        .catch(error => { asset.loading = null; throw error; });
    }
    return asset.loading;
  }
  function clearCurrent() {
    generation++;
    player.pause(); player.remove();
    if (current) current.thumb.image.style.visibility = '';
    current = null; loaded = false; playPending = false; playRefused = false;
    clock.reset();
  }
  function attach(index, asset) {
    clearCurrent();
    const thumb = thumbnails[index];
    if (!thumb) return;
    thumb.box.hidden = false;
    current = { index, asset, thumb };
    record('attach', { file: asset.source, index });
    player.hidden = true;
    const token = generation;
    loadVideo(asset).then(url => {
      if (!current || token !== generation) return;
      player.src = url; player.load();
      thumb.box.appendChild(player);
    }).catch(() => { if (token === generation) clearCurrent(); });
  }
  player.addEventListener('loadeddata', () => {
    if (!current || player.currentSrc !== current.asset.url) return;
    loaded = true; sync();
  });
  player.addEventListener('error', clearCurrent);
  player.addEventListener('seeked', () => { clock.seeked(performance.now()); sync(); });
  // A user tap retries a browser's autoplay restriction without changing
  // the cue action or sending any additional show commands.
  document.addEventListener('click', () => { playRefused = false; sync(); });
  function sync() {
    const playback = getPlayback();
    if (!playback || !Number.isInteger(playback.index) || !thumbnails[playback.index]) {
      if (current) clearCurrent();
      return;
    }
    const asset = playback.file ? assets.get(playback.file) : thumbnails[playback.index].asset;
    if (!asset) { if (current) clearCurrent(); return; }
    const nextDelay = Number.isFinite(playback.delayMs) ? Math.max(0, playback.delayMs) : 0;
    delayMs = nextDelay;
    if (!current || current.index !== playback.index || current.asset !== asset) attach(playback.index, asset);
    if (!loaded) return;
    if (!playback.live) { player.pause(); clock.reset(); return; }
    player.hidden = false; current.thumb.image.style.visibility = 'hidden';
    const timing = clock.update({ currentTime: player.currentTime, seeking: player.seeking,
      duration: player.duration || asset.duration_seconds }, playback, performance.now());
    targetTime = timing.target;
    player.loop = playback.loop;
    if (timing.seek !== null) {
      record('correct', { target: +timing.seek.toFixed(3), reason: timing.reason });
      player.currentTime = timing.seek;
    }
    if (!timing.running) { player.pause(); return; }
    try { player.playbackRate = timing.rate; }
    catch { player.pause(); return; }
    if (player.paused && !playPending && !playRefused) {
      playPending = true;
      const token = generation;
      record('play-request');
      player.play().then(() => { if (token === generation) record('play-resolved'); })
        .catch(error => { if (token === generation) { playRefused = true; record('play-rejected', { name: error?.name }); } })
        .finally(() => { if (token === generation) playPending = false; });
    }
  }
  // Two downloads at a time preload the complete pack. Retry interrupted
  // downloads in the background; current-cue requests reuse the same work.
  let preloading = false;
  async function preload() {
    if (preloading) return;
    preloading = true;
    const pending = [...assets.values()].filter(asset => !asset.url);
    async function worker() {
      while (pending.length) {
        try { await loadVideo(pending.shift()); } catch { /* Retry next pass. */ }
      }
    }
    try { await Promise.all([worker(), worker()]); }
    finally { preloading = false; }
    if ([...assets.values()].some(asset => !asset.url)) setTimeout(preload, 10000);
  }
  void preload();
  window.addEventListener('online', preload);
  setInterval(sync, 250);
  document.addEventListener('visibilitychange', () => { sync(); if (!document.hidden) void preload(); });
  sync();
  return {
    sync,
    diagnostics() {
      const quality = player.getVideoPlaybackQuality?.();
      return { file: current?.asset.source, index: current?.index, time: player.currentTime,
        target: targetTime, rate: player.playbackRate, paused: player.paused, seeking: player.seeking,
        ready: player.readyState, network: player.networkState, playPending, playRefused, delayMs,
        error: player.error?.code ?? null, frameCount,
        frameAgeMs: lastFrameAt === null ? null : Math.round(performance.now() - lastFrameAt),
        droppedFrames: quality?.droppedVideoFrames ?? null,
        totalFrames: quality?.totalVideoFrames ?? null, events: events.slice() };
    }
  };
}
