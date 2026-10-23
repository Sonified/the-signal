// The brush's hall, the transport half: which hall the page's address asks
// for, and the link to it (touch/hall.js createHall, the same link /touch/
// uses, over a WebSocket to the relay). core/brush.js is the logic half and
// never sees a socket; main.js hands the one to the other.
//
//   ?hall=<name>               join this hall as a member
//   &conduct=<key>             join as its conductor, /touch/'s form
//   &conduct=1&key=<key>       the same, the wire's own form
//   &relay=<host>              another relay than the deployed one
//
// No hall in the address, no link: the brush is a solo instrument, and it is
// one anyway whenever the link is offline (touch/hall.js retries, then says
// 'offline' and waits for the network). Read from the platform's pageSearch,
// so a worker reads the page's address and not its own script's.

import { createHall } from '../touch/hall.js';
import { RELAY_HOST } from './broadcast-socket.js';

// { hall, key, host } from the query string, or null for none.
export function brushHallIntent(search) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch (e) { return null; }
  const raw = q.get('hall');
  if (!raw) return null;
  const hall = raw.replace(/[^\w-]/g, '').slice(0, 64);
  if (!hall) return null;
  const c = q.get('conduct') || '';
  const key = c === '1' ? (q.get('key') || '') : c;
  return { hall, key, host: q.get('relay') || RELAY_HOST };
}

// The link for an intent. on: { state(s), group(g), message(msg) }, as
// touch/hall.js takes them.
export function openBrushHall(intent, on) {
  return createHall({ host: intent.host, hall: intent.hall, key: intent.key, on });
}
