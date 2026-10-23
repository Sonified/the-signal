// The tape, made sacred: pulls a drawing room's whole tape off the relay
// and keeps it in the repo, where nothing can record over it.
//
//   node tools/tape-archive.mjs <room> [host]
//
// The relay answers GET /touch/<room>/tape?from=N with
// { epoch, n, entries, from, total } (broadcast-worker/src/index.js), so
// this asks page after page until it holds the whole tape, then writes
// tapes/<room>-<epoch>-n<total>.json. The name carries the tape's epoch
// (its identity: a wipe starts a new one) and its length, so a re-run after
// more drawing writes a NEW file beside the old and NOTHING here is ever
// overwritten: an archive that already exists is left exactly as it is.
// The epoch changing mid-pull (a wipe during the fetch) starts the pull
// over on the new tape.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const room = process.argv[2];
const host = process.argv[3] || 'the-signal-broadcast.robertalexander-music.workers.dev';
if (!room) { console.error('usage: node tools/tape-archive.mjs <room> [host]'); process.exit(1); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://' + host + '/touch/' + encodeURIComponent(room) + '/tape';

let epoch = null, entries = [], total = Infinity;
while (entries.length < total) {
  const r = await fetch(base + '?from=' + entries.length);
  if (!r.ok) { console.error('the relay answered ' + r.status); process.exit(1); }
  const page = await r.json();
  if (epoch !== null && page.epoch !== epoch) {
    console.log('the tape changed under the pull (epoch ' + epoch + ' -> ' + page.epoch + '); starting over');
    epoch = null; entries = []; total = Infinity;
    continue;
  }
  epoch = page.epoch;
  total = page.total;
  if (!page.entries.length && entries.length < total) { console.error('the relay sent no entries at ' + entries.length + ' of ' + total); process.exit(1); }
  entries = entries.concat(page.entries);
  console.log('  ' + entries.length + ' / ' + total);
}

if (!entries.length) { console.log('room "' + room + '" has no tape'); process.exit(0); }

const dir = join(root, 'tapes');
mkdirSync(dir, { recursive: true });
const file = join(dir, room + '-' + epoch + '-n' + total + '.json');
if (existsSync(file)) { console.log('already archived, left untouched: ' + file); process.exit(0); }
writeFileSync(file, JSON.stringify({ room, epoch, savedAt: new Date().toISOString(), total, entries }));
console.log('archived: ' + file + ' (' + total + ' entries, epoch ' + epoch + ')');
