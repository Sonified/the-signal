// The show's tape, kept on the presentation screen as it grows. The hall
// records every stroke anyone in the room draws (broadcast-worker/, the
// tape), in every phase, including the ones this screen never hears (in
// pairs and fours the conductor is sent nobody's strokes). From the show's
// first drawing cue this screen asks the relay every POLL_MS for the
// entries it does not have yet (GET /touch/<room>/tape?from=N) and hands
// them to the brush (core/brush.js brushTapeAdd), so by the playback cue
// the whole show's drawing is already here, and anything drawn during the
// playback arrives while it plays.
//
// The show's start is a place on the tape, not a wipe: cue 17 (Solo) asks
// the relay for the tape's length and keeps it (localStorage, per room,
// with the tape's epoch), and only what comes after it is the show's, so
// rehearsals on the same room stay on the tape and out of the playback. A
// reload mid-show finds the mark again and fetches from it afresh. A tape
// wiped since (another epoch, or shorter than the mark) starts from 0.
//
// An older relay ignores ?from= and answers the whole tape (no `from` in
// the reply): the part before what this screen has is cut off here, and
// the next ask waits OLD_RELAY_MS rather than POLL_MS, the whole tape
// being megabytes after a long day.

import { brushTapeAdd, brushTapeReset, brushTapeCount, brushHallName } from '../core/brush.js';
import { relayHost } from './broadcast-socket.js';

const POLL_MS = 1000, OLD_RELAY_MS = 15000;
const MARK_KEY = 'signal.showTape.v1';

function readMark(room) {
  try {
    const m = JSON.parse(localStorage.getItem(MARK_KEY) || 'null');
    return m && m.room === room && Number.isInteger(m.from) ? m : null;
  } catch (e) { return null; }
}
function writeMark(m) {
  try { localStorage.setItem(MARK_KEY, JSON.stringify(m)); } catch (e) {}
}

export function createShowTape() {
  let timer = null, busy = false, waitTill = 0;
  // the room the copy here is of, the tape's epoch, and where the show
  // starts on it; the entries here are the tape's from + 0 onward
  let room = '', epoch = 0, from = 0, marking = false;
  const url = n => 'https://' + relayHost() + '/touch/' + encodeURIComponent(room) + '/tape?from=' + n;

  async function get(n) {
    const r = await fetch(url(n), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status + '');
    return r.json();
  }

  function adopt(name) {
    room = name;
    const m = readMark(name);
    epoch = m ? m.epoch : 0;
    from = m ? m.from : 0;
    brushTapeReset();
  }

  async function poll() {
    const name = brushHallName();
    if (!name || busy || (!marking && Date.now() < waitTill)) return;
    if (name !== room) adopt(name);
    busy = true;
    try {
      if (marking) {
        // the show starts here: the tape's length now
        const d = await get(1e9);
        epoch = d.epoch || 0;
        from = typeof d.total === 'number' ? d.total : (d.n | 0);
        marking = false;
        writeMark({ room, epoch, from });
        brushTapeReset();
        console.log('[show-tape] the show starts at entry ' + from + ' of room ' + room + "'s tape");
        return;
      }
      const have = brushTapeCount();
      const d = await get(from + have);
      if (brushHallName() !== room) return;
      const ep = d.epoch || 0;
      if (!epoch && ep) { epoch = ep; writeMark({ room, epoch, from }); }   // an empty tape at the mark, begun since
      if (ep !== epoch || (typeof d.total === 'number' && d.total < from + have)) {
        // wiped since the mark: the show is all of the new tape
        console.log('[show-tape] room ' + room + "'s tape was wiped; keeping it from its start");
        epoch = ep; from = 0;
        writeMark({ room, epoch, from });
        brushTapeReset();
        return;
      }
      let got = Array.isArray(d.entries) ? d.entries : [];
      if (typeof d.from !== 'number') { got = got.slice(from + have); waitTill = Date.now() + OLD_RELAY_MS; }   // an older relay: the whole tape
      if (got.length) brushTapeAdd(got);
    } catch (e) {
      // offline or the relay down: the copy here stands, and the next poll asks again
    } finally {
      busy = false;
    }
  }

  return {
    // keeps polling from now on (every drawing cue says so)
    run() {
      if (timer) return;
      timer = setInterval(poll, POLL_MS);
      poll();
    },
    // cue 17: the show starts at the tape's end as it is now
    mark() {
      marking = true;
      if (timer) poll(); else this.run();
    }
  };
}
