// The Signal's demo broadcast relay: a Cloudflare Worker whose one Durable
// Object class, Room, holds a WebSocket room per session link. The
// broadcaster (the drawer's Broadcast section, or a page opened with
// ?broadcast=<room>&key=<passphrase>) publishes its settings snapshot
// whenever they change; every follower (?follow=<room>) receives each one,
// and a follower that joins late is handed the most recent snapshot at once,
// from the room's storage, so it syncs before the broadcaster next touches a
// dial.
//
// The broadcaster is also told, live, how many followers the room holds:
// {t:'count',n} goes to every broadcast socket when it joins and whenever a
// follower arrives or leaves. Ending a session ({t:'end'} from the
// broadcaster) clears the stored snapshot, so a follower opening the link of
// a switched-off session gets nothing rather than a stale scene, and tells
// the followers present, who keep their settings as they are.
//
// The room uses the WebSocket hibernation API, so an idle demo costs nothing:
// the object is evicted between messages and the runtime replays each event
// into a fresh instance. Nothing here may live in instance fields between
// events except what the constructor rebuilds; the snapshot therefore goes in
// ctx.storage, not on `this`. Clients ping every 20 s to keep their sockets
// through Cloudflare's idle timeout; the auto-response pair answers those
// without ever waking the object.
//
// Publishing requires the key (wrangler secret put BROADCAST_KEY). Following
// is open: anyone with the page URL and room name can watch, which is the
// point of a demo. A room name is 1-64 word characters or dashes.
//
// Mirror rooms (named mirror-...) are the exception: the remote control
// surface (remote.html), where an iPad drives the show. Both roles there need
// the password (wrangler secret put MIRROR_KEY), checked here and never in
// the page, and the broadcast key does not open them. POST /auth with the
// password as the body answers 200 or 403, so the page can ask before it
// connects and remember a password that works.
//
// Live sound. The broadcaster can also speak into the room: its Live Sound
// mix, recorded as WebM/Opus in 200 ms pieces, arrives here as binary frames,
// which fan out to the followers exactly as a word does and are never
// stored. A WebM stream is only decodable from its beginning, though: the
// first piece a recorder makes carries the stream's header (what the codec
// is, how it is framed), and every later piece is bare audio that means
// nothing without it. So a follower who joins mid-stream must be handed that
// first piece before any other. The broadcaster says {t:'live',on:1} just
// before each fresh recording (a start, a restart, a reconnect), which is
// relayed so the followers present can make ready for a new header, and the
// room keeps the next binary frame to arrive, the header piece, as liveInit.
// A follower joining while it is held is told {t:'live',on:1} and handed it,
// straight after the stored snapshot, and then hears the live pieces as they
// come. {t:'live',on:0} (the broadcaster going off air, or its last listener
// leaving) and {t:'end'} let it go.
//
// liveInit is the one exception to the rule above: it lives in an instance
// field, not in storage, because it only has to outlast the stream, and a
// streaming room is never evicted (a piece every 200 ms keeps it awake). The
// room can only hibernate once pieces have stopped for some seconds, which is
// the broadcaster's own link dropping (its reconnect sends a fresh
// {t:'live',on:1} and header, so the room re-arms) or no one listening (in
// which case nothing is being recorded, and the next listener's arrival
// starts a fresh recording). A room woken with no liveInit therefore only
// ever waits for the header that is already on its way. Keeping it out of
// storage also means a live stream costs no storage writes at all, and adds
// nothing that could wake an empty room.

const LIVE_ON = '{"t":"live","on":1}';

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // the current recording's header piece, and whether the next binary
    // frame is it (see Live sound above); both forgotten on eviction
    this.liveInit = null;
    this.liveArm = false;
    // The edge answers each keepalive 'ping' with 'pong' itself, so a room
    // whose followers are only pinging stays hibernated; a join, a leave or a
    // real message still wakes it.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  followers() {
    // Only sockets still open: the closing socket can linger in the list
    // while its close event is being delivered.
    return this.ctx.getWebSockets('follow').filter(w => w.readyState === 1);
  }

  sendCounts() {
    const msg = JSON.stringify({ t: 'count', n: this.followers().length });
    for (const b of this.ctx.getWebSockets('broadcast')) {
      try { b.send(msg); } catch (e) {}
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get('role') === 'broadcast' ? 'broadcast' : 'follow';
    if (isMirror(url)) {
      if (!this.env.MIRROR_KEY || url.searchParams.get('key') !== this.env.MIRROR_KEY) {
        return new Response('bad password', { status: 403 });
      }
    } else if (role === 'broadcast') {
      if (!this.env.BROADCAST_KEY) {
        return new Response('no BROADCAST_KEY set on the worker', { status: 403 });
      }
      if (url.searchParams.get('key') !== this.env.BROADCAST_KEY) {
        return new Response('bad key', { status: 403 });
      }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    if (role === 'follow') {
      const snap = await this.ctx.storage.get('snap');
      if (snap) pair[1].send(snap);
      // A stream under way: the joiner is told so and handed its header
      // before any live piece reaches it. Armed with the header still in
      // flight, the notice alone goes, and the header follows in the fan-out.
      if (this.liveInit || this.liveArm) {
        try {
          pair[1].send(LIVE_ON);
          if (this.liveInit) pair[1].send(this.liveInit);
        } catch (e) {}
      }
      this.sendCounts();
    } else {
      try { pair[1].send(JSON.stringify({ t: 'count', n: this.followers().length })); } catch (e) {}
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    // A binary frame is a piece of the broadcaster's live sound: relayed to
    // every follower as it stands, never parsed and never stored. The first
    // after {t:'live',on:1} is the recording's header, kept for joiners.
    if (typeof message !== 'string') {
      if (!this.ctx.getTags(ws).includes('broadcast')) return;
      if (this.liveArm) { this.liveInit = message; this.liveArm = false; }
      for (const peer of this.followers()) {
        try { peer.send(message); } catch (e) {}
      }
      return;
    }
    if (message === 'ping') return;
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    // A time probe, from either role: echoed straight back with this room's
    // clock, the one clock every client of the room shares. The client halves
    // the round trip to place `s` on its own timeline (NTP's trick), which is
    // what lets every screen agree on the strobe's phase.
    if (msg.t === 'time') {
      try { ws.send(JSON.stringify({ t: 'time', c: msg.c, s: Date.now() })); } catch (e) {}
      return;
    }
    // Everything else is the broadcaster's; a follower has nothing more to
    // say (its pings are answered by the auto-response without reaching here).
    if (!this.ctx.getTags(ws).includes('broadcast')) return;
    if (msg.t === 'end') {
      this.liveInit = null;
      this.liveArm = false;
      await this.ctx.storage.delete('snap');
    } else if (msg.t === 'state') {
      await this.ctx.storage.put('snap', message);
    } else if (msg.t === 'live') {
      // a fresh recording arms the room for its header; off air lets it go
      this.liveInit = null;
      this.liveArm = msg.on === 1;
    } else if (msg.t !== 'phase' && msg.t !== 'word') return;
    // A phase beacon, a word or a live notice is relayed but never stored:
    // each says what is happening NOW, and a copy served minutes later would
    // be worse than none.
    for (const peer of this.followers()) {
      try { peer.send(message); } catch (e) { /* a peer mid-close; it will reconnect or is gone */ }
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) {}
    if (this.ctx.getTags(ws).includes('follow')) this.sendCounts();
  }

  async webSocketError(ws) {
    try { ws.close(); } catch (e) {}
    if (this.ctx.getTags(ws).includes('follow')) this.sendCounts();
  }
}

// A mirror room, by its name in the path (see Mirror rooms above).
function isMirror(url) {
  return /^\/room\/mirror-/.test(url.pathname);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/auth') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return new Response('POST the password', { status: 405, headers: CORS });
      const pw = (await request.text()).slice(0, 256);
      const ok = !!env.MIRROR_KEY && pw === env.MIRROR_KEY;
      return new Response(ok ? 'ok' : 'no', { status: ok ? 200 : 403, headers: CORS });
    }
    const m = url.pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!m) return new Response('The Signal broadcast relay. Connect a websocket to /room/<name>.');
    const id = env.ROOM.idFromName(m[1]);
    return env.ROOM.get(id).fetch(request);
  }
};
