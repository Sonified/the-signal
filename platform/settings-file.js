// Settings to a file and back: the drawer's Download settings and Load
// settings (core/schema-visual.js, the foot of the Render section). Everything
// this app keeps lives in localStorage under keys that start with `signal` or
// `openfocus` (the settings record, the v1 extras, presets, journeys, the
// broadcast key, window layout), and localStorage belongs to one site. So the
// way to carry a setup from one site to another, or to keep it safe, is to
// write those keys to a file and read them back in.
//
// Page-only: a download and a file picker need the document. In worker mode
// the drawer's button reaches here through the bridge (platform/worker-bridge.js
// 'settingsFile'), still within the click's user activation.

const OURS = /^(signal|openfocus)/;

// Every key of ours, its value parsed back to JSON where it is JSON, so the
// file reads as one tidy document rather than a page of escaped strings.
function gather() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!OURS.test(k)) continue;
    const v = localStorage.getItem(k);
    try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
  }
  return out;
}

// A JSON text saved as a file, the browser's own download (also the Journey
// window's download, through platform.download).
export function saveJsonFile(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function download() {
  let data;
  try { data = gather(); } catch (e) { alert('Could not read your settings: ' + e.message); return; }
  const day = new Date().toISOString().slice(0, 10);
  saveJsonFile(`presence-settings-${day}.json`, JSON.stringify(data, null, 2));
}

// A file is taken only if it is an object whose every key is one of ours, so
// a stray JSON file can never write into storage. It is not written into
// localStorage here: the page on its way out still flushes whatever change it
// had pending (core/store.js flush, on hiding), and that would land on top of
// the file. So the file waits in sessionStorage across the reload, and the
// next page writes it in before anything reads the settings (applyPendingLoad,
// first thing in index.html).
const PENDING = 'signal.pendingLoad';
function load() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { alert('That file is not a settings file (it is not JSON).'); return; }
    const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
    if (!keys.length || !keys.every(k => OURS.test(k))) { alert('That file is not a settings file from this app.'); return; }
    if (!confirm('Replace your current settings, presets and journeys with this file? The page will reload.')) return;
    try { sessionStorage.setItem(PENDING, JSON.stringify(data)); } catch (e) { alert('Could not load the settings: ' + e.message); return; }
    location.reload();
  };
  input.click();
}

// The loaded file's keys into localStorage, strings as they are and
// everything else as the JSON it came out as. Runs before the app starts.
export function applyPendingLoad() {
  let data = null;
  try { data = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); sessionStorage.removeItem(PENDING); } catch (e) { return; }
  if (!data || typeof data !== 'object') return;
  for (const k of Object.keys(data)) {
    if (!OURS.test(k)) continue;
    try { localStorage.setItem(k, typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k])); } catch (e) {}
  }
}

// ---------- a fresh visit (localhost only) ----------
// Delete twice on localhost (main.js) reloads the page as a first-time
// visitor would meet it: every key of ours goes, from localStorage and
// sessionStorage, so factory presets, defaults and every developer switch
// (signal_worker, signal_heart, signal_perf...) start over. Other pages'
// keys on this origin (the tools, the mirror password) are not ours and stay.
// The clearing waits for the next page for the same reason a loaded file
// does: the page on its way out still flushes its pending save. So a flag
// crosses the reload in sessionStorage, and applyFreshVisit, first thing in
// index.html, clears before anything reads the settings.
//
// What was cleared is kept first, in an IndexedDB database the app never
// opens (presence-fresh-backup), so the fresh visit is truly fresh and the
// old setup can still come back: restoreFreshBackup() in the console puts
// the latest back, restoreFreshBackup(1) the one before, through the same
// hand-off a loaded file takes. The last ten are kept.
const FRESH = 'signal.freshVisit';
const BACKUP_DB = 'presence-fresh-backup', BACKUP_KEEP = 10;
const onLocalhost = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

function backupDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BACKUP_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('backups', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => reject(req.error || new Error('blocked'));
  });
}

// Every backup, newest first, as { id, at, data }.
async function backups() {
  const db = await backupDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction('backups').objectStore('backups').openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { db.close(); resolve(out); return; }
      out.push({ id: c.key, at: c.value.at, data: c.value.data });
      c.continue();
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function keepBackup(data) {
  const old = await backups();
  const db = await backupDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('backups', 'readwrite');
    const store = tx.objectStore('backups');
    store.add({ at: new Date().toISOString(), data });
    for (const b of old.slice(BACKUP_KEEP - 1)) store.delete(b.id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

async function freshReload() {
  if (!onLocalhost()) return;
  // every key of ours as the raw string it is stored as, so a restore
  // writes back exactly what was there
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (OURS.test(k)) data[k] = localStorage.getItem(k);
  }
  if (Object.keys(data).length) {
    try { await keepBackup(data); } catch (e) {
      if (!confirm('Could not keep a backup of your settings (' + (e && e.message) + '). Reload fresh anyway?')) return;
    }
  }
  try { sessionStorage.setItem(FRESH, '1'); } catch (e) { return; }
  location.reload();
}

// Runs before the app starts (index.html), ahead of applyPendingLoad.
export function applyFreshVisit() {
  let flagged = false;
  try { flagged = sessionStorage.getItem(FRESH) === '1'; } catch (e) { return; }
  if (!flagged || !onLocalhost()) return;
  let n = 0;
  for (const area of [localStorage, sessionStorage]) {
    const keys = [];
    // (a restore's backup, waiting for applyPendingLoad, stays)
    for (let i = 0; i < area.length; i++) { const k = area.key(i); if (OURS.test(k) && !(area === sessionStorage && k === PENDING)) keys.push(k); }
    for (const k of keys) { try { area.removeItem(k); if (area === localStorage) n++; } catch (e) {} }
  }
  let restoring = false;
  try { restoring = sessionStorage.getItem(PENDING) !== null; } catch (e) {}
  if (restoring) console.log('[fresh] cleared ' + n + ' saved keys, writing the backup back in');
  else console.log('[fresh] a first visit: cleared ' + n + ' saved keys of ours. Backup in IndexedDB ' + BACKUP_DB + '; restoreFreshBackup() in the console puts the latest back (restoreFreshBackup(1) the one before, if Delete-Delete ran twice).');
}

// Console only: the nth latest backup (0, the latest) back in, across a
// reload: the page is cleared as for a fresh visit and the backup then
// written in as a loaded settings file is (applyPendingLoad), so the
// storage ends up exactly as it was.
async function restoreFreshBackup(n = 0) {
  const all = await backups();
  const b = all[n];
  if (!b) { console.log('[fresh] no backup ' + n + ' (' + all.length + ' kept)'); return; }
  // cleared first (applyFreshVisit), so keys made since the backup go too
  sessionStorage.setItem(PENDING, JSON.stringify(b.data));
  sessionStorage.setItem(FRESH, '1');
  console.log('[fresh] restoring the backup from ' + b.at + ' (' + Object.keys(b.data).length + ' keys), reloading');
  location.reload();
}
if (typeof window !== 'undefined' && typeof location !== 'undefined' && onLocalhost()) window.restoreFreshBackup = restoreFreshBackup;

export function settingsFile(kind) {
  if (kind === 'download') download();
  else if (kind === 'load') load();
  else if (kind === 'fresh') freshReload();
}
