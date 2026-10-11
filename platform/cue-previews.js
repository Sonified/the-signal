// Local 144p previews for the show's cue buttons. All clips can be cached,
// with a shared player plus a prepared Audification-only playback test.
import { slideElementRate } from '../core/slide-rate.js';
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
    image.alt = ''; image.decoding = 'async'; image.style.zIndex = '1';
    box.appendChild(image); cues[index].appendChild(box);
    cachedBlob(db, 'poster:' + asset.file + ':' + asset.sha256, BASE + encodeURIComponent(asset.poster), asset.poster_bytes)
      .then(blob => { image.src = URL.createObjectURL(blob); })
      .catch(() => { box.hidden = true; });
    return { box, image, asset };
  });
  const player = document.createElement('video');
  player.muted = true; player.defaultMuted = true; player.playsInline = true;
  player.preload = 'auto'; player.setAttribute('aria-hidden', 'true');
  let current = null, generation = 0, loaded = false, aligned = false, playPending = false, playRefused = false;
  let lastCheck = -Infinity, correction = 0;
  function loadVideo(asset) {
    if (!asset.loading) {
      asset.loading = cachedBlob(db, 'video:' + asset.file + ':' + asset.sha256,
        BASE + encodeURIComponent(asset.file), asset.bytes)
        .then(blob => (asset.url = URL.createObjectURL(blob)))
        .catch(error => { asset.loading = null; throw error; });
    }
    return asset.loading;
  }
  // Audification-only experiment: keep this actual video element loaded
  // between cues. Starting it never resets its source or seeks before play.
  const audFile = '030_Audification_Explained.mp4';
  const audIndex = thumbnails.findIndex(thumb => thumb?.asset.source === audFile);
  const audThumb = thumbnails[audIndex];
  const audPlayer = document.createElement('video');
  audPlayer.muted = true; audPlayer.defaultMuted = true; audPlayer.playsInline = true;
  audPlayer.preload = 'auto'; audPlayer.setAttribute('aria-hidden', 'true');
  audPlayer.dataset.preparedCue = 'audification';
  let audActive = false, audRate = 1, audPlaying = false, audSpeedStopped = false;
  function prepareAud() {
    if (!audThumb || audPlayer.src) return;
    loadVideo(audThumb.asset).then(url => {
      if (audPlayer.src) return;
      audThumb.box.appendChild(audPlayer);
      audPlayer.src = url; audPlayer.load();
    }).catch(() => {});
  }
  function playAud() {
    if (!audActive) return;
    if (!audPlaying || audRate <= 0) { audPlayer.pause(); return; }
    audPlayer.playbackRate = slideElementRate(audRate);
    // Called directly in the cue/transport gesture, with no load/seek await.
    if (audPlayer.paused) void audPlayer.play().catch(() => {});
  }
  function leaveAud() {
    if (!audActive) return;
    audActive = false; audPlayer.pause();
    audThumb.image.style.visibility = '';
    // Re-arm at zero when leaving, before the next cue tap.
    if (audPlayer.readyState >= 1) audPlayer.currentTime = 0;
  }
  audPlayer.addEventListener('playing', () => {
    if (audActive) audThumb.image.style.visibility = 'hidden';
  });
  audPlayer.addEventListener('loadeddata', () => {
    audThumb.box.dataset.prepared = 'true';
    // A tap during the first download can retry once its source is ready.
    if (audActive) playAud();
  });
  prepareAud();
  function clearCurrent() {
    generation++;
    player.pause(); player.remove();
    if (current) current.thumb.image.style.visibility = '';
    current = null; loaded = false; aligned = false; playPending = false; playRefused = false;
    lastCheck = -Infinity; correction = 0;
  }
  function attach(index, asset) {
    clearCurrent();
    const thumb = thumbnails[index];
    if (!thumb) return;
    thumb.box.hidden = false;
    current = { index, asset, thumb };
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
  player.addEventListener('seeked', () => {
    if (!current || player.currentSrc !== current.asset.url) return;
    aligned = true; sync();
  });
  player.addEventListener('playing', () => {
    if (!aligned || !current) return;
    player.hidden = false; current.thumb.image.style.visibility = 'hidden';
  });
  player.addEventListener('error', clearCurrent);
  // A user tap retries a browser's autoplay restriction without changing
  // the cue action or sending any additional show commands.
  document.addEventListener('click', () => { playRefused = false; sync(); });
  function sync(force = false) {
    const playback = getPlayback();
    if (audActive) {
      if (!playback || playback.index !== audIndex || (playback.file && playback.file !== audFile)) leaveAud();
      else {
        // No clock checks, seeks, or rate corrections in this experiment.
        // Health still stops a preview when the laptop freezes/disconnects.
        if (!playback.live) audPlayer.pause();
        return;
      }
    }
    if (!playback || !Number.isInteger(playback.index) || !thumbnails[playback.index]) {
      if (current) clearCurrent();
      return;
    }
    const asset = playback.file ? assets.get(playback.file) : thumbnails[playback.index].asset;
    if (!asset) { if (current) clearCurrent(); return; }
    if (!current || current.index !== playback.index || current.asset !== asset) attach(playback.index, asset);
    if (!loaded) return;
    if (!playback.live) { player.pause(); return; }
    const running = playback.rate > 0;
    if (!running) player.pause();
    let target = playback.time + (running ? Math.max(0, performance.now() - playback.reportedAt) / 1000 * playback.rate : 0);
    if (playback.loop && playback.duration > 0) target %= playback.duration;
    target = Math.max(0, Math.min(player.duration || asset.duration_seconds, target));
    player.loop = playback.loop;
    // Decode the first frame at the current show time before exposing it.
    // The URL always comes from a fully downloaded Blob, never a stream.
    if (!aligned) {
      if (player.seeking) return;
      aligned = true;
      if (Math.abs(player.currentTime - target) > 1 / 30) {
        player.currentTime = target;
        return;
      }
    }
    if (player.seeking) return;
    const now = performance.now();
    if (force || now - lastCheck >= 1000) {
      lastCheck = now;
      let error = target - player.currentTime;
      if (playback.loop && playback.duration > 0) {
        const d = playback.duration;
        error = ((error + d / 2) % d + d) % d - d / 2;
      }
      // Correct small differences by gently adjusting rate, rather than
      // repeatedly seeking and skipping decoded frames. A seek or pause
      // requested on this iPad still lands immediately.
      if (Math.abs(error) > (force || !running ? 1 / 30 : .5)) {
        correction = 0;
        player.currentTime = target;
        return;
      }
      correction = running && Math.abs(error) > 1 / 30
        ? Math.max(-.05, Math.min(.05, error * .25)) : 0;
    }
    if (!running || (!playback.loop && target >= player.duration)) {
      player.pause();
      player.hidden = false; current.thumb.image.style.visibility = 'hidden';
      return;
    }
    try { player.playbackRate = Math.max(.0625, Math.min(4, playback.rate + correction)); }
    catch { player.pause(); return; }
    // Safari autoplay needs a visible player. The poster covers its initial
    // decoded frame until the 'playing' event, avoiding a flash from time 0.
    player.hidden = false;
    if (player.paused && !playPending && !playRefused) {
      playPending = true;
      const token = generation;
      player.play().catch(() => { if (token === generation) playRefused = true; })
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
    prepareAud();
    if ([...assets.values()].some(asset => !asset.url)) setTimeout(preload, 10000);
  }
  void preload();
  window.addEventListener('online', preload);
  setInterval(sync, 1000);
  document.addEventListener('visibilitychange', () => { sync(); if (!document.hidden) void preload(); });
  sync();
  return {
    sync,
    startPreparedCue(index, state = {}) {
      if (index !== audIndex || !audThumb || (state.f && state.f !== audFile)) {
        leaveAud(); return false;
      }
      clearCurrent();
      audActive = true; audSpeedStopped = false;
      audRate = state.r ?? 1; audPlaying = state.p !== false;
      audPlayer.loop = state.l === true;
      playAud();
      return true;
    },
    controlPrepared(command, rate) {
      if (!audActive) return;
      if (command.k === 'seek' && Number.isFinite(audPlayer.duration)) audPlayer.currentTime = command.f * audPlayer.duration;
      else if (command.id === 'slidePlay') { audPlaying = !!command.v; playAud(); }
      else if (command.id === 'slideRate') {
        if (rate === 0) { audSpeedStopped = audPlaying; audRate = 0; }
        else {
          audRate = rate;
          if (audSpeedStopped) { audPlaying = true; audSpeedStopped = false; }
        }
        playAud();
      }
    },
    preparedPlayback() {
      return audActive ? { t: audPlayer.currentTime, d: audThumb.asset.duration_seconds,
        f: audFile, r: audPlaying ? audRate : 0, l: audPlayer.loop } : null;
    },
    cueInfo(index, file) {
      const asset = file ? assets.get(file) : thumbnails[index]?.asset;
      return asset ? { f: asset.source, d: asset.duration_seconds } : null;
    }
  };
}
