// The demo broadcast's transport half: this file reads location, owns the
// WebSockets, reconnects and keeps them alive, and core/broadcast.js is the
// logic half, which never sees any of that. main.js hands the functions here
// into initBroadcast, so the core module stays inside the portability
// boundary.
//
// The broadcaster's sessions are managed in the drawer (the Broadcast
// section), each holding a socket from openBroadcastSocket while active. The
// URL still takes part on the follower's side, and seeds the broadcaster's:
//
//   ?follow=<room>                       this tab follows the room's settings
//   ?broadcast=<room>&key=<passphrase>   seeds a session named <room> and the
//                                        stored key, then broadcasts to it
//   &relay=<host>                        use this relay instead of RELAY_HOST
//
// The deployed relay is the default everywhere, localhost included, so the
// drawer's sessions just work on the local build; `?relay=localhost:8787`
// points a tab at `wrangler dev` when the worker itself is being changed.
//
// Each socket reconnects with a doubling wait capped at 8 s, forever once it
// has connected at least once (a demo should survive a sleeping laptop), but
// gives up after five straight failures to connect at all, which is what a
// wrong key or an undeployed relay looks like. A 'ping' goes up every 20 s to
// hold the connection through Cloudflare's idle timeout; the relay answers
// 'pong' without waking the room.

// The deployed relay's host, printed by `npx wrangler deploy` in
// broadcast-worker/.
const RELAY_HOST = 'the-signal-broadcast.robertalexander-music.workers.dev';

const PING_MS = 20000;
const RETRY_CAP_MS = 8000;
const CONNECT_TRIES = 5;

const LOCAL_RE = /^(localhost|127\.0\.0\.1|\[::1\])/;

function relayHost() {
  const q = new URLSearchParams(location.search);
  return q.get('relay') || RELAY_HOST;
}

// The page URL a viewer opens to follow the room: this page, with the one
// query parameter. Any parameters on the broadcaster's own URL (a key, a
// relay override) stay out of what gets handed around.
export function makeFollowUrl(room) {
  return location.origin + location.pathname + '?follow=' + encodeURIComponent(room);
}

// One socket to the relay, reconnecting until close() is called. handlers:
//   onMessage(text)  each relay message
//   onStatus(s)      'open' | 'lost' (was connected, retrying) | 'dead' (gave up)
// Returns { send(str), close() }; send while disconnected is dropped (the
// broadcaster resends a fresh snapshot on every 'open', so nothing is owed).
export function openBroadcastSocket(room, role, key, handlers) {
  const host = relayHost();
  const scheme = LOCAL_RE.test(host) ? 'ws' : 'wss';
  let url = scheme + '://' + host + '/room/' + encodeURIComponent(room) + '?role=' + role;
  if (role === 'broadcast') url += '&key=' + encodeURIComponent(key || '');

  let ws = null, open = false, everOpen = false, fails = 0, closed = false;
  let pingTimer = null, retryTimer = null;

  function connect() {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      open = everOpen = true;
      fails = 0;
      pingTimer = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, PING_MS);
      handlers.onStatus('open');
    };
    ws.onmessage = e => { if (e.data !== 'pong') handlers.onMessage(e.data); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    ws.onclose = () => {
      clearInterval(pingTimer);
      const was = open;
      open = false;
      if (closed) return;
      fails++;
      if (!everOpen && fails >= CONNECT_TRIES) {
        console.warn('[broadcast] could not reach the relay at ' + host + ' for room "' + room + '" after ' + fails + ' tries; giving up (wrong key, or the relay is not deployed?)');
        handlers.onStatus('dead');
        return;
      }
      if (was) handlers.onStatus('lost');
      retryTimer = setTimeout(connect, Math.min(RETRY_CAP_MS, 1000 * Math.pow(2, fails)));
    };
  }
  connect();

  return {
    send(str) { if (open && !closed) { try { ws.send(str); } catch (e) {} } },
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      try { ws.close(); } catch (e) {}
    }
  };
}

// What the page's URL asks of the broadcast, read once at boot:
//   { follow: room }                the tab is a follower
//   { seed: room, key: passphrase } seed a broadcaster session (legacy form)
//   { key: passphrase }             just a key to store
//   null                            the normal page load
export function broadcastUrlIntent() {
  const q = new URLSearchParams(location.search);
  const follow = q.get('follow');
  if (follow) return { follow };
  const seed = q.get('broadcast'), key = q.get('key');
  if (seed) return { seed, key };
  if (key) return { key };
  return null;
}
