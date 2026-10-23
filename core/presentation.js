// Presentation mode's gate and its show: the Settings drawer's Presentation
// mode asks for a password the first time it is switched on on a device
// (core/schema-visual.js), and every time it goes on it makes sure the TSC
// 2026 Journey is in the library, once per export.
//
// The gate is show chrome, not security: the password sits here in plain
// sight in a public repository, and all it keeps is a stray visitor from
// stumbling into the talk's controls. Once given right it is remembered on
// this device (UNLOCK_KEY, beside the brush's record: this machine's own,
// never in a preset, a step or a broadcast), so the toggle does not ask
// again. Switching off never asks. The show remote's relay password
// (platform/show-remote.js, mirror.pw) is its own thing, untouched.
//
// The Journey: the authoritative export (documents/tsc-2026-journey.json)
// and the slide videos' manifest (documents/tsc-2026-media-manifest.json)
// are fetched, every step's slideFile is checked against the manifest, and
// the Journey is imported as a new 'TSC 2026' library item and made
// current (core/journey.js journeyImport), under a marker named for the
// export's revision: the first 16 hex of the SHA-256 of its bytes, the very
// marker the standalone presentation site's seed sets
// (tools/build-cloud-presentation.mjs), so a reload, or switching the mode
// on again, never imports twice, and a changed export imports once more.

import { readKey, saveKey } from './store.js';

export const PRESENT_PASSWORD = 'solarmax';
const UNLOCK_KEY = 'signal.v1.presentUnlock';
const MARKER = 'signal.presentationJourney.';
const JOURNEY_URL = 'documents/tsc-2026-journey.json';
const MANIFEST_URL = 'documents/tsc-2026-media-manifest.json';
export const JOURNEY_TITLE = 'TSC 2026';

// The typed password, forgiving of case and the spaces round it.
export function presentPasswordOk(text) {
  return typeof text === 'string' && text.trim().toLowerCase() === PRESENT_PASSWORD;
}
// (saveKey writes a moment later, so this tab also keeps what it did itself)
let unlockedHere = false;
const installedHere = new Set();
export function presentUnlocked() { return unlockedHere || readKey(UNLOCK_KEY) === '1'; }
export function presentUnlock() { unlockedHere = true; saveKey(UNLOCK_KEY, '1'); }

// The ask under the toggle (its password row's visible rule and status
// line read it): open, and until when a wrong try says so.
export const presentAsk = { open: false, wrongUntil: 0 };

// A v2 export whose every slide is in the manifest, or the reason not.
export function presentJourneyProblem(journey, manifest) {
  if (!journey || journey.ver !== 2 || !Array.isArray(journey.steps) || !journey.steps.length) return 'not an exported v2 Journey';
  const have = new Set(((manifest && manifest.videos) || []).map(v => v.file));
  for (const step of journey.steps) {
    const f = step && step.overrides && step.overrides.slideFile;
    if (f && f !== 'none' && !have.has(f)) return 'Journey video missing: ' + f;
  }
  return '';
}

// The export's revision: the builder's, from the same bytes.
export async function presentRevision(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}

// How this side fetches a file's text, and the Journey library's import
// (core/journey.js journeyImport): main.js hands both in, core fetches
// nothing itself, and the schema that reads this module stays clear of the
// journey's own imports.
let fetchText = null, importJourney = null;
export function setPresentFetch(fn, importer) { fetchText = fn; importJourney = importer; }

// Installs the TSC 2026 Journey if this revision is not in yet. Resolves to
// what happened: 'installed', 'present', or a reason it could not.
let busy = null;
export function presentInstall() {
  if (busy) return busy;
  busy = (async () => {
    if (!fetchText || !importJourney) return 'no fetch';
    try {
      const [text, mtext] = await Promise.all([fetchText(JOURNEY_URL), fetchText(MANIFEST_URL)]);
      const rev = await presentRevision(text);
      if (installedHere.has(rev) || readKey(MARKER + rev)) return 'present';
      const journey = JSON.parse(text), manifest = JSON.parse(mtext);
      const problem = presentJourneyProblem(journey, manifest);
      if (problem) { console.warn('[presentation] ' + problem); return problem; }
      if (importJourney(JOURNEY_TITLE, journey) < 0) return 'the library is full';
      installedHere.add(rev);
      saveKey(MARKER + rev, '1');
      console.log('[presentation] TSC 2026 Journey installed (' + journey.steps.length + ' steps)');
      return 'installed';
    } catch (e) {
      console.warn('[presentation] the Journey could not be installed:', e && e.message ? e.message : e);
      return 'failed';
    } finally { busy = null; }
  })();
  return busy;
}
