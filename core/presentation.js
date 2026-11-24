// Presentation mode's gate and its show: the Settings drawer's Presentation
// mode asks for the show's one login the first time it is switched on in a
// browser that has none (core/schema-visual.js), and every time it goes on it
// makes sure the TSC 2026 Journey is in the library, once per export.
//
// The gate holds no password. The login is the relay's own (POST /auth on
// the cloud relay or the laptop's local one, the password the ?presentation
// page asks for at boot, platform/presentation-login.js), and this module
// only asks two questions of it through a hook main.js hands in
// (setPresentAuth): has this browser logged in (a password is held), and
// is this typed password good (a promise of 'ok', 'no', or 'down' when no
// relay answered). A browser that has logged in counts as unlocked with no
// second question; one that has not is asked, and the answer goes to the
// relay. Switching off never asks. Nothing here fetches or stores: the
// hook does both, on the platform's side.
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
import { idleWake } from './idle.js';

const MARKER = 'signal.presentationJourney.';
const JOURNEY_URL = 'documents/tsc-2026-journey.json';
const MANIFEST_URL = 'documents/tsc-2026-media-manifest.json';
export const JOURNEY_TITLE = 'TSC 2026';

// The login's two questions (see above), from main.js. Without a hook (a
// test, or a page that never wired one) nothing is logged in and every try
// reads as no relay answering.
let auth = null;
export function setPresentAuth(hooks) { auth = hooks || null; }
// (a login made in this tab counts at once, whatever the hook says)
let unlockedHere = false;
// the revision this tab installed last (the stored one is written a moment
// later, core/store.js saveKey)
let lastHere = '';
export function presentUnlocked() {
  if (unlockedHere) return true;
  try { return !!(auth && auth.loggedIn && auth.loggedIn()); } catch (e) { return false; }
}

// The ask under the toggle (its password row's visible rule and status
// line read it): open, a check under way, and until when its last answer
// is shown (msg: 'Wrong password' or that no relay answered).
export const presentAsk = { open: false, checking: false, msg: '', msgUntil: 0 };
export const PRESENT_WRONG = 'Wrong password';
export const PRESENT_DOWN = 'Could not reach the relay to check it';
const MSG_MS = 2500;

// A typed password, checked with the relay through the hook. Resolves to
// 'ok' (this tab is unlocked from now on), 'no', or 'down', and leaves the
// ask's status saying so. A second try while one is out is ignored ('busy').
export function presentTry(text) {
  if (presentAsk.checking) return Promise.resolve('busy');
  // exactly as typed, as the relay compares it; only an empty one is no try
  const pw = typeof text === 'string' ? text : '';
  if (!pw.trim()) return Promise.resolve('no');
  presentAsk.checking = true;
  presentAsk.msg = '';
  let p;
  try { p = auth && auth.login ? Promise.resolve(auth.login(pw)) : Promise.resolve('down'); }
  catch (e) { p = Promise.resolve('down'); }
  return p.then(v => v === 'ok' || v === 'no' ? v : 'down', () => 'down').then(v => {
    presentAsk.checking = false;
    if (v === 'ok') unlockedHere = true;
    else { presentAsk.msg = v === 'no' ? PRESENT_WRONG : PRESENT_DOWN; presentAsk.msgUntil = Date.now() + MSG_MS; }
    // the drawer's row redraws with the answer, even on a resting loop
    idleWake('the presentation login');
    return v;
  });
}

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
      // Present when this is the revision installed LAST, not one installed
      // ever: a deck put back to an earlier order is a change, and installs
      // again. A browser from before the last-revision key (and the
      // standalone site's seed) has only the per-revision marker.
      let last = lastHere;
      if (!last) { try { last = JSON.parse(readKey(MARKER + 'last') || 'null') || ''; } catch (e) { last = ''; } }
      if (last ? last === rev : !!readKey(MARKER + rev)) return 'present';
      const journey = JSON.parse(text), manifest = JSON.parse(mtext);
      const problem = presentJourneyProblem(journey, manifest);
      if (problem) { console.warn('[presentation] ' + problem); return problem; }
      if (importJourney(JOURNEY_TITLE, journey) < 0) return 'the library is full';
      lastHere = rev;
      saveKey(MARKER + rev, '1');
      saveKey(MARKER + 'last', rev);
      console.log('[presentation] TSC 2026 Journey installed (' + journey.steps.length + ' steps)');
      return 'installed';
    } catch (e) {
      console.warn('[presentation] the Journey could not be installed:', e && e.message ? e.message : e);
      return 'failed';
    } finally { busy = null; }
  })();
  return busy;
}
