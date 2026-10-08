// The official starting row: the presets a first visit opens with
// (presets/factory.json, Robert's own row as of 2026-10-02, with Blooming
// Grace 2 lit). It is the presets record exactly as core/presets.js keeps it
// under signal.presets.v1, so seeding it is one write: the same chips in the
// same order, the same hearts and the same built-ins saved over or hidden,
// all of them the viewer's own from then on, to recall, save over, rename or
// delete like any preset they made.
//
// Seeded only when there is no presets record at all, so a returning viewer
// (and Robert, who already has these) keeps theirs exactly as it is, and a
// file loaded from the drawer (platform/settings-file.js applyPendingLoad,
// which runs before this) is never written over.
//
// The file is fetched only on that first visit, never on a return one. The
// boot waits for it (main.js boot, before anything is drawn), so the first
// frame is already the starting preset rather than the old defaults with the
// preset landing a moment later; the settings themselves are applied from
// the lit chip's snapshot right after the store loads (core/presets.js
// applyActivePresetState). A fetch that fails or runs past the deadline
// leaves no record, and the page boots on the old defaults as it always did.
//
// A viewer who has been here before but never had a presets record (their
// settings are already stored) gets the row with nothing lit: their screen
// is their own settings, not Blooming Grace 2, and a lit chip would say
// otherwise.
//
// Page-only, like settings-file.js: in worker mode this runs on the page
// before the worker starts, so the copy of localStorage the worker begins
// from already holds the record.

import { STORE } from '../js/state.js';

const PRESETS_KEY = 'signal.presets.v1';
// Long enough for the file (about 16 KB compressed) over a poor mobile link,
// short enough that a page that cannot reach it still opens.
const FETCH_TIMEOUT_MS = 8000;

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export async function seedFactoryPresets() {
  if (read(PRESETS_KEY) !== null) return;
  let rec = null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : 0;
  try {
    // relative to this module, so the app works from any path it is served at
    const res = await fetch(new URL('../presets/factory.json', import.meta.url), ctl ? { signal: ctl.signal } : undefined);
    if (res.ok) rec = await res.json();
  } catch (e) {
    console.info('[presets] could not fetch the starting presets; booting on the defaults', e && e.message || e);
  } finally {
    clearTimeout(timer);
  }
  if (!rec || typeof rec !== 'object' || !Array.isArray(rec.user)) return;
  // another tab may have made a record while the file was on its way
  if (read(PRESETS_KEY) !== null) return;
  const stored = read(STORE);
  if (stored !== null && stored !== '{}') rec.active = null;
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(rec)); } catch (e) { /* quota or a disabled store: boot on the defaults */ }
}
