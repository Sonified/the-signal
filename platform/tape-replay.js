// The standing playback: a drawing the room made, kept as a file in tapes/
// (tools/tape-archive.mjs), played on a loop on a page opened
// ?replay=<path>&draw, the layer meditatewiththesun.com shows between
// shows (its site/event.js). It is the show's playback (cue 24), fed from
// a file instead of the relay: the tape is fetched once, handed to the
// brush whole (core/brush.js brushTapeAdd), and the very loop the
// presentation screen runs plays it (brushReplay, core/brush-replay.js
// planning each pass), so a pass starts where the room arrived, which on a
// whole show's tape is the creation itself. Unlike the show's playback,
// which squeezes the whole show into 45 s, this one plays in real time
// (REAL_TIME, the pass never squeezed): the drawing exactly as it happened,
// the short rest between laps, round forever, at the Brush section's Replay
// speed (1x, real time, unless a screen's own record says otherwise).
//
// Nothing here talks to the relay. The page joins no hall and follows no
// broadcast (main.js), so a visitor's own strokes draw on their screen
// alone, over the loop, and go nowhere: the playback's strokes play under
// their drawers' replay keys, beside the hand's, and a pass never clears
// what anyone draws, which fades on its own as every mark does.
//
// The path is the page's own: a file under tapes/ on this same site, never
// another site's address (tapePath). An archived tape is { room, epoch,
// savedAt, total, entries }, entries as the relay's tape GET answers them
// ({ at, id, s }); a bare array of entries is taken too. A fetch that fails
// (offline, a deploy still landing) is tried again, sooner first.

import { brushTapeReset, brushTapeAdd, brushReplay } from '../core/brush.js';

const RETRY_MS = 5000, RETRY_MAX_MS = 300000;
// the pass's window (core/brush.js brushReplay): no window, so no squeeze
export const REAL_TIME = Infinity;

// The tape a ?replay= names, as a path on this site, or '' when it names
// none or anything but a file under tapes/: no scheme, no host, no climbing
// out with '..', nothing but plain names and slashes, ending .json.
export function tapePath(p) {
  if (typeof p !== 'string' || p.length > 256) return '';
  if (!/^tapes\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.json$/.test(p)) return '';
  if (p.split('/').some(seg => seg === '.' || seg === '..')) return '';
  return p;
}

// An event's name resolved to its tape: tapes/events.json maps slugs to
// archives ("win-iv" to the file tools/tape-archive.mjs wrote), so
// ?event=WIN-IV is a standing address while each show's archive is chosen
// by one line in the manifest. The name is slugged as broadcast rooms are
// (lowercase, runs of anything else as one dash), '' when the manifest
// lacks it or the path it names is not a tape's.
export function eventSlug(name) {
  return typeof name === 'string'
    ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) : '';
}
export async function eventTape(slug, get = fetch) {
  if (!slug) return '';
  const r = await get('tapes/events.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('events.json answered ' + r.status);
  const map = await r.json();
  return tapePath(map && typeof map === 'object' ? map[slug] : '');
}

// An event's own scene: presets/events/<slug>.json, a settings snapshot
// (the drawer's state as the store saves it, the machine's own settings
// left out) that an ?event= page starts from on every visit, applied as a
// preset recall is (core/store.js applySnapshot, main.js boot). null when
// the event has none, the file cannot be reached, or it takes too long, so
// a page with no scene boots on the visitor's own settings as before.
const SCENE_TIMEOUT_MS = 8000;
export async function eventScene(slug, get = fetch) {
  if (!slug) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), SCENE_TIMEOUT_MS) : 0;
  try {
    const r = await get('presets/events/' + slug + '.json', { cache: 'no-cache', signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return null;
    const s = await r.json();
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  } catch (e) {
    console.info('[replay] no scene for event "' + slug + '": ' + (e && e.message || e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The entries of a fetched tape, or null when it holds none in a shape the
// brush can play.
export function tapeEntries(doc) {
  const e = Array.isArray(doc) ? doc : doc && Array.isArray(doc.entries) ? doc.entries : null;
  return e && e.length ? e : null;
}

// Fetches the tape at `path` (tapePath's) and plays it on a loop from then
// on. Resolves once it plays, with how many entries it holds; a failed
// fetch waits and tries again, so it resolves whenever the file is reached.
// get is fetch (the tests hand in their own).
export async function startTapeReplay(path, get = fetch) {
  const p = tapePath(path);
  if (!p) { console.warn('[replay] no tape to play: ?replay= must name a file under tapes/'); return 0; }
  let wait = RETRY_MS;
  for (;;) {
    try {
      const r = await get(p);
      if (!r.ok) throw new Error(r.status + '');
      const entries = tapeEntries(await r.json());
      if (!entries) { console.warn('[replay] ' + p + ' holds no entries; nothing to play'); return 0; }
      brushTapeReset();
      brushTapeAdd(entries);
      brushReplay(true, REAL_TIME);
      console.log('[replay] ' + p + ': ' + entries.length + ' batches, playing on a loop in real time');
      return entries.length;
    } catch (e) {
      console.warn('[replay] could not fetch ' + p + ' (' + (e && e.message) + '); trying again in ' + Math.round(wait / 1000) + ' s');
      await new Promise(res => setTimeout(res, wait));
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    }
  }
}
