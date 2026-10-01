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

function download() {
  let data;
  try { data = gather(); } catch (e) { alert('Could not read your settings: ' + e.message); return; }
  const day = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `presence-settings-${day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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

export function settingsFile(kind) {
  if (kind === 'download') download();
  else if (kind === 'load') load();
}
