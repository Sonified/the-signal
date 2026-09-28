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

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
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
    if (role === 'broadcast') {
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
      this.sendCounts();
    } else {
      try { pair[1].send(JSON.stringify({ t: 'count', n: this.followers().length })); } catch (e) {}
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
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
      await this.ctx.storage.delete('snap');
    } else if (msg.t === 'state') {
      await this.ctx.storage.put('snap', message);
    } else if (msg.t !== 'phase') return;
    // A phase beacon is relayed but never stored: it says where the strobe is
    // NOW, and a copy served minutes later would be worse than none.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!m) return new Response('The Signal broadcast relay. Connect a websocket to /room/<name>.');
    const id = env.ROOM.idFromName(m[1]);
    return env.ROOM.get(id).fetch(request);
  }
};
