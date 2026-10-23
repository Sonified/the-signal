// The brush's link to its broadcast room, the transport half: the relay's
// touch hall under the broadcast room's own name (touch/hall.js createHall,
// over a WebSocket; the Hall in broadcast-worker/). core/broadcast.js says
// which room (the one this screen broadcasts or follows), main.js opens and
// closes the link as that comes and goes, and core/brush.js is the logic
// half, which never sees a socket. The broadcasting screen joins with its
// broadcast key, which makes it the room's conductor; a follower joins
// without one, as a drawer. Nothing in an address names it.
//
// No room, no link: the brush is a solo instrument, and it is one anyway
// whenever the link is offline (touch/hall.js retries, then says 'offline'
// and waits for the network).

import { createHall, deviceToken } from '../touch/hall.js';

// The link for { hall, key, host }. on: { state(s), group(g), hand(h),
// message(msg) }, as touch/hall.js takes them. storage is the platform's
// ({ get, set }): this device's token is kept there, under a name of the
// main app's own, so a /touch/ tab on the same machine is a member of its
// own rather than taking this one's id.
export function openBrushHall(intent, on, storage) {
  const token = deviceToken('signal.hall.device.main', storage);
  return createHall({ host: intent.host, hall: intent.hall, key: intent.key, token, on });
}
