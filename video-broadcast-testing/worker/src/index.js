// The video broadcast test's relay: a Cloudflare Worker whose one Durable
// Object class, VideoRoom, holds a WebSocket room per test (video-broadcast-
// testing/, a page where every device sends its camera, small, to every
// other device in the room and draws theirs as panels). It is a separate
// worker from the show's relay (broadcast-worker/) on purpose: whatever this
// test does to a room, a CPU limit or a flood of frames, can never touch a
// show.
//
// Every member may speak. Each gets an id from 1 to 65535 on joining, from a
// counter in the room's storage, so an id is never handed out twice while
// the room lives (a device that drops and comes back is a new member with a
// new id, and nobody mistakes its frames for the old socket's). The
// newcomer is told {t:'hello', you, ids} (ids: everyone already here); the
// others hear {t:'peer', id, on:1}, and {t:'peer', id, on:0} when it goes.
//
// A picture is a binary message in the shape js/wire.js sets out: a 24-byte
// header and the encoded frame. The room never reads the picture. It writes
// the sender's id into bytes 2 and 3 of the header (u16, little-endian), in
// place, and passes the message on to every other member, so a receiver
// always knows whose frame it holds and no sender can claim to be another.
// Anything shorter than a header is dropped. Nothing binary is ever stored:
// a frame says what the camera saw NOW. That path is the thing this test
// load-tests, so it is kept as bare as it can be: no JSON, no storage, no
// awaits, the sender's facts read from a per-instance cache of its
// attachment.
//
// Text is JSON, every message an object with a `t`:
//   {t:'time', c}   a time probe, answered to its sender alone with
//                   {t:'time', c, s: Date.now()}: the room's clock, which
//                   every device places on its own timeline by halving the
//                   round trip (NTP's trick), so a frame's capture time `t`
//                   means the same instant on every screen and the delay can
//                   be measured end to end
//   {t:'echo', on}  on (1) also sends the member's own frames back to it, so
//                   one device alone can test the whole round trip; 0 stops
//   anything else   relayed to every other member with `from` (the sender's
//                   id) added; the page uses it for {t:'key'}, a request for
//                   a fresh full picture
// Text that is not a JSON object is ignored.
//
// The room uses the WebSocket hibernation API, so an idle room costs
// nothing: the object is evicted between messages and the runtime replays
// each event into a fresh instance. Nothing may live in instance fields
// between events except what the constructor can rebuild: each socket's id
// and echo flag ride its attachment (serializeAttachment), the id counter
// lives in ctx.storage, and the attachment cache is only a cache, refilled
// from the attachments after an eviction. Clients ping every 20 s to keep
// their sockets through Cloudflare's idle timeout; the auto-response pair
// answers those at the edge without ever waking the room.
//
// Joining is open, as the test wants: anyone with the page and a room name
// is in. A room name is 1-64 word characters or dashes.

const ID_MAX = 65535;   // ids are a u16 in the packet header

export class VideoRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // socket -> its attachment ({ id, echo, gone }), so the binary path
    // never deserializes; only a cache, forgotten on eviction and refilled
    // from the attachment on first use (see att below)
    this.cache = new WeakMap();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  att(ws) {
    let a = this.cache.get(ws);
    if (!a) {
      a = ws.deserializeAttachment();
      if (a) this.cache.set(ws, a);
    }
    return a;
  }
  setAtt(ws, a) {
    this.cache.set(ws, a);
    // a socket already closed may refuse a new attachment; the cache still
    // holds the change for as long as this instance lives, which is all a
    // closed socket needs
    try { ws.serializeAttachment(a); } catch (e) {}
  }

  // The members present, open and not yet announced gone: a closing socket
  // can linger in the list while its close event is being delivered.
  members() {
    return this.ctx.getWebSockets().filter(w => {
      if (w.readyState !== 1) return false;
      const a = this.att(w);
      return !!a && !a.gone;
    });
  }

  // The next id, never one handed out before in this room's life. Past
  // 65535 (a room would need that many joins first) the counter goes round
  // again, skipping any id still present, rather than shut the room.
  async nextId() {
    let id = (await this.ctx.storage.get('nextId')) || 1;
    if (id > ID_MAX) {
      const here = new Set(this.members().map(w => this.att(w).id));
      id = 1;
      while (here.has(id) && id <= ID_MAX) id++;
    }
    await this.ctx.storage.put('nextId', id + 1);
    return id;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }
    const id = await this.nextId();
    const ids = this.members().map(w => this.att(w).id);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.setAtt(pair[1], { id, echo: false, gone: false });
    try { pair[1].send(JSON.stringify({ t: 'hello', you: id, ids })); } catch (e) {}
    const arrived = JSON.stringify({ t: 'peer', id, on: 1 });
    for (const w of this.members()) {
      if (w !== pair[1]) { try { w.send(arrived); } catch (e) {} }
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, message) {
    // A picture: stamped with its sender and fanned out, never parsed and
    // never stored. Kept synchronous; see the top of the file.
    if (typeof message !== 'string') {
      if (message.byteLength < 24) return;
      const me = this.att(ws);
      if (!me || me.gone) return;
      const b = new Uint8Array(message);
      b[2] = me.id & 0xff;
      b[3] = me.id >>> 8;
      for (const w of this.ctx.getWebSockets()) {
        if (w === ws ? !me.echo : w.readyState !== 1) continue;
        try { w.send(message); } catch (e) { /* a peer mid-close; it will reconnect or is gone */ }
      }
      return;
    }
    if (message === 'ping') return;
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.t === 'time') {
      try { ws.send(JSON.stringify({ t: 'time', c: msg.c, s: Date.now() })); } catch (e) {}
      return;
    }
    const me = this.att(ws);
    if (!me || me.gone) return;
    if (msg.t === 'echo') {
      this.setAtt(ws, Object.assign({}, me, { echo: msg.on === 1 || msg.on === true }));
      return;
    }
    msg.from = me.id;
    const out = JSON.stringify(msg);
    for (const w of this.members()) {
      if (w !== ws) { try { w.send(out); } catch (e) {} }
    }
  }

  webSocketClose(ws) {
    try { ws.close(); } catch (e) {}
    this.left(ws);
  }
  webSocketError(ws) {
    try { ws.close(); } catch (e) {}
    this.left(ws);
  }
  // Told once, whichever of close and error comes first: the attachment
  // is marked gone, which also takes the socket out of members().
  left(ws) {
    const me = this.att(ws);
    if (!me || me.gone) return;
    this.setAtt(ws, Object.assign({}, me, { gone: true }));
    const gone = JSON.stringify({ t: 'peer', id: me.id, on: 0 });
    for (const w of this.members()) {
      if (w !== ws) { try { w.send(gone); } catch (e) {} }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!m) return new Response('The Signal video broadcast test relay. Connect a websocket to /room/<name>.');
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
  }
};
