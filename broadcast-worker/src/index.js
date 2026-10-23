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
    } else if (msg.t !== 'phase' && msg.t !== 'word' && msg.t !== 's') return;
    // A phase beacon, a word, a brush stroke (the wire's {t:'s'},
    // touch/strokes.js, which every follower draws itself) or a live notice
    // is relayed but never stored:
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

// ---------- the hall: group touch (touch/, documents/touch-foundation.md) ----------
// A Hall is the Room's sibling for experiences everyone makes together: a
// WebSocket room where every member may speak, not one broadcaster. Joining
// is open (an installation's audience holds nothing but the link). Each
// member gets an id in joining order and a hello naming everyone present;
// the others hear the arrival and every leave. The hall moves through
// phases - 'solo' (you alone), 'master' (the conductor's strokes reach
// everyone, a member's nobody), 'pairs' (twos, an odd joiner makes one
// trio), 'quads' (fours, leftovers folding into the last), 'halves' (the
// first half of the joiners and the second) and 'all' (everyone, the
// conductor too) - set by a conductor, a socket that joined with the
// broadcast key. The conductor is not a drawer in the groups: in pairs,
// quads and halves it hears no one and reaches no one (CONDUCTOR_HEARS_GROUPS
// in groups.js flips the hearing half). Strokes ({t:'s'}) and any other
// member message are relayed by those routes, computed here (groups.js)
// from the ids present, so every member agrees without an election; each
// member is told its group ({t:'group'}: itself plus whoever reaches it) on
// joining, on every phase change, and whenever arrivals or leaves re-draw
// the groups. The time probe
// answers as the Room's does, one clock for the hall. Hibernation-safe the
// same way: per-socket state rides the socket's attachment, the phase and
// the id counter live in storage, and pings are answered at the edge.
//
// The tape. Everything the hall relays is a moment, but an installation
// wants its memory: every stroke a member sends is also appended to the
// hall's storage as one entry { at, id, s } - `at` ms since the hall's
// epoch (set by the first entry), `id` the drawer, `s` the stroke as the
// member said it, the id stored once beside it rather than stamped in
// twice. Keys are 'tape:' plus a zero-padded counter so storage.list walks
// them in order; the counter rides `this` only as a cache, seeded lazily
// (the constructor cannot await) from a list of the last tape key, so an
// eviction re-finds the true tail instead of forking it. The tape caps at
// TAPE_MAX entries and past the cap records nothing, silently. It survives
// the hall emptying - the drawings outlive the drawers - and only a
// conductor's {t:'wipe'} clears it, key by key by prefix (deleteAll would
// also take a live phase and id counter), and the epoch with it. A plain
// GET to /touch/<name>/tape (no websocket upgrade) answers
// { epoch, n, entries } with open CORS, which is all the replay page needs.

// The phases, the groups and who hears whom live in groups.js, pure, so
// node tests the very code the hall runs: solo, master (the conductor to
// everyone), pairs, quads, halves, all (the conductor hearing everything).
import { PHASES, routes, roundOf, nextStep, planStep, stepGroups, phaseGroups } from './groups.js';
import { dealHand, readBrushes } from './deal.js';
export { dealHand, deck, readBrushes, HAND_MAX } from './deal.js';
export { PHASES, CONDUCTOR_HEARS_GROUPS, pairGroups, phaseGroups, routes, SCRIPT, roundOf, nextStep, planStep, stepGroups, liveGroups, regroup } from './groups.js';

const TAPE_MAX = 1000000;  // entries; ~50 min of 15 hands drawing nonstop, ~250 MB at worst, well under any storage worry
const TAPE_PAD = 8;        // key digits; room past the cap if it ever grows
const MOTIF_FIELDS = ['a', 'm', 'c', 'f', 'r', 'q'];   // the motif brush's extras and any stroke's timing (touch/strokes.js)
// Sticky identity. Each device joins with a token of its own (touch/hall.js,
// ?d=<token>), and the hall remembers which id it gave that token, under
// 'tok:<token>' keys beside the tape, so a phone that blips and comes back
// takes its old id again and lands in exactly the group it left, nobody
// else moving. The map lives as long as the tape: it survives the hall
// emptying (a show survives everyone dropping at once), and a conductor's
// wipe clears it, keeping the devices still connected. TOKENS_MAX caps it
// against junk; past it a new device simply gets a fresh id each join.
const TOKENS_MAX = 10000;
// The room's own settings, the conductor's (Stream and Smoothing): how
// often every member sends a stroke batch, ms, the playback's margin past
// it, ms, the Size every member's strokes are drawn at (a stroke's w) and
// the two Rotations (the trail's rt and the shape's sr), turns a second.
// Re-told in hello and group.
const ROOM_DEFAULT = { ms: 20, sm: 30, sz: 50, rt: 0, sr: 0 };
const TOKEN_RE = /^[\w-]{8,64}$/;
// The close code a socket is sent when a newer one of the same device has
// taken its id: the client must not reconnect on it (touch/hall.js).
export const REPLACED = 4000;

export class Hall {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // the tape counter, only a cache of the last stored key: null until the
    // first write after construction seeds it from storage (see The tape)
    this.tapeN = null;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // The sockets present, less any a newer socket of the same device has
  // replaced (still lingering, not yet closed out).
  members() {
    return this.ctx.getWebSockets('member').filter(w => {
      if (w.readyState !== 1) return false;
      const a = w.deserializeAttachment();
      return !!a && !a.replaced;
    });
  }
  idOf(ws) {
    const a = ws.deserializeAttachment();
    return a ? a.id : -1;
  }

  // Where the show stands: the phase, its round, and the rounds' history
  // (groups.js planStep), all in storage beside each other.
  async step() {
    const room = (await this.ctx.storage.get('room')) || ROOM_DEFAULT;
    return {
      phase: (await this.ctx.storage.get('phase')) || 'solo',
      round: (await this.ctx.storage.get('round')) || 1,
      hist: (await this.ctx.storage.get('hist')) || {},
      ms: room.ms, sm: room.sm, sz: room.sz || ROOM_DEFAULT.sz, rt: room.rt >= 0 ? room.rt : ROOM_DEFAULT.rt, sr: room.sr >= 0 ? room.sr : ROOM_DEFAULT.sr
    };
  }

  // ---------- the dealt brushes (deal.js) ----------
  // The deal ('deal': { on, n, a, tiles, seed, pos }) and each device's
  // hand under 'hand:<token>' (or the id, for a device with no token), so a
  // returning device is handed the same tiles again. A member is told its
  // hand as {t:'hand', on, a, tiles} on joining and whenever the deal starts
  // or stops.
  handKey(a) { return 'hand:' + (a.token || 'id' + a.id); }
  async handFor(a, deal) {
    const k = this.handKey(a);
    let hand = await this.ctx.storage.get(k);
    if (!Array.isArray(hand)) {
      const r = dealHand(deal.tiles, deal.seed, deal.pos, deal.n);
      hand = r.hand; deal.pos = r.pos;
      await this.ctx.storage.put(k, hand);
      await this.ctx.storage.put('deal', deal);
    }
    return hand;
  }
  async tellHand(w, deal) {
    const a = w.deserializeAttachment();
    if (!a) return;
    const msg = deal && deal.on
      ? { t: 'hand', on: 1, a: deal.a, tiles: await this.handFor(a, deal) }
      : { t: 'hand', on: 0 };
    try { w.send(JSON.stringify(msg)); } catch (e) {}
  }
  async clearHands() {
    for (;;) {
      const page = await this.ctx.storage.list({ prefix: 'hand:', limit: 128 });
      if (!page.size) break;
      await this.ctx.storage.delete([...page.keys()]);
    }
  }
  // The conductor's {t:'brushes'}: on with a new count, set or deck starts
  // a fresh deal (a new seed, every hand let go); the same again only deals
  // to whoever has none yet. Members are dealt in joining order.
  async setBrushes(b) {
    const old = await this.ctx.storage.get('deal');
    let deal = old;
    const same = old && old.on && b.on && old.n === b.n && old.a === b.a &&
      old.tiles.length === b.tiles.length && old.tiles.every((t, i) => t === b.tiles[i]);
    if (!b.on) {
      deal = { on: 0 };
      await this.clearHands();
    } else if (!same) {
      await this.clearHands();
      deal = { on: 1, n: b.n, a: b.a, tiles: b.tiles, seed: (Math.random() * 4294967296) >>> 0, pos: 0 };
    }
    await this.ctx.storage.put('deal', deal);
    const ws = this.members().sort((x, y) => this.idOf(x) - this.idOf(y));
    for (const w of ws) await this.tellHand(w, deal);
  }

  // Who hears whom at step st, from the sockets present (groups.js): id ->
  // { to, with }. The conductor flag rides each socket's attachment; the
  // drawers' groups are the step's live ones (stepGroups: the planned
  // groups as they stand, joiners folded in).
  routesNow(st, members) {
    return this.planNow(st, members).routes;
  }
  // The routes and the drawers' groups at step st (the groups: every drawer
  // in exactly one, the conductor in none, as the show controller draws them).
  planNow(st, members) {
    const ids = [], conductors = [];
    for (const w of members) {
      const a = w.deserializeAttachment();
      if (!a) continue;
      ids.push(a.id);
      if (a.conduct) conductors.push(a.id);
    }
    const cond = new Set(conductors);
    const drawers = ids.filter(id => !cond.has(id)).sort((x, y) => x - y);
    const groups = st.phase === 'pairs' || st.phase === 'quads' || st.phase === 'halves'
      ? stepGroups(st.phase, st.round, drawers, st.hist) : null;
    return { routes: routes(st.phase, ids, conductors, { groups }), groups: groups || phaseGroups(st.phase, drawers) };
  }

  // The conductor moves the show to (phase, round): a step of pairs or
  // quads not reached before is planned now, over the drawers present
  // (groups.js planStep), and kept, so going back to it finds it again.
  async setStep(phase, round) {
    const r = roundOf(phase, round);
    const st = await this.step();
    const drawers = [];
    for (const w of this.members()) {
      const a = w.deserializeAttachment();
      if (a && !a.conduct) drawers.push(a.id);
    }
    const hist = planStep(phase, r, drawers, st.hist).hist;
    await this.ctx.storage.put('phase', phase);
    await this.ctx.storage.put('round', r);
    await this.ctx.storage.put('hist', hist);
    this.tellGroups({ phase, round: r, hist });
  }

  // One stroke onto the tape. Seeds the counter on first use - and after
  // any eviction - from the last stored key, so hibernation cannot fork
  // the sequence; the first entry pins the hall's epoch.
  async record(id, s) {
    if (this.tapeN === null) {
      const last = await this.ctx.storage.list({ prefix: 'tape:', reverse: true, limit: 1 });
      this.tapeN = last.size ? parseInt([...last.keys()][0].slice(5), 10) + 1 : 0;
    }
    if (this.tapeN >= TAPE_MAX) return;   // a full tape just stops listening
    let epoch = await this.ctx.storage.get('epoch');
    if (epoch === undefined) {
      epoch = Date.now();
      await this.ctx.storage.put('epoch', epoch);
    }
    await this.ctx.storage.put('tape:' + String(this.tapeN++).padStart(TAPE_PAD, '0'),
      { at: Date.now() - epoch, id, s });
  }

  // The whole tape as JSON, oldest first: the zero-padded keys make it a
  // plain prefix walk, read in pages and concatenated.
  async readTape() {
    const entries = [];
    let startAfter;
    for (;;) {
      const opts = { prefix: 'tape:', limit: 1000 };
      if (startAfter !== undefined) opts.startAfter = startAfter;
      const page = await this.ctx.storage.list(opts);
      for (const [k, v] of page) { entries.push(v); startAfter = k; }
      if (page.size < 1000 || entries.length >= TAPE_MAX) break;
    }
    const epoch = (await this.ctx.storage.get('epoch')) || 0;
    return new Response(JSON.stringify({ epoch, n: entries.length, entries }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // The conductor's eraser: every tape key, by prefix (deleteAll would also
  // take a live phase and id counter), then the epoch, then the devices'
  // ids, all but those of the devices still here, which keep theirs so the
  // room is not reshuffled by the wipe. The id counter runs on, so no id
  // is ever given twice.
  async wipe() {
    for (const prefix of ['tape:', 'tok:']) {
      for (;;) {
        const page = await this.ctx.storage.list({ prefix, limit: 128 });
        if (!page.size) break;
        await this.ctx.storage.delete([...page.keys()]);
      }
    }
    await this.ctx.storage.delete('epoch');
    // and the rounds' history: a new show plans its rounds afresh; and the
    // deal, every hand let go (the conductor deals again)
    await this.ctx.storage.delete('hist');
    await this.clearHands();
    await this.ctx.storage.delete('deal');
    for (const w of this.members()) await this.tellHand(w, null);
    this.tapeN = 0;
    let n = 0;
    for (const w of this.members()) {
      const a = w.deserializeAttachment();
      if (a && a.token) { await this.ctx.storage.put('tok:' + a.token, a.id); n++; }
    }
    await this.ctx.storage.put('tokN', n);
  }

  // The id for a joining device: its own again if its token is known, else
  // the next one, remembered under the token while there is room.
  async idFor(token) {
    if (token) {
      const known = await this.ctx.storage.get('tok:' + token);
      if (known !== undefined) return known;
    }
    const id = (await this.ctx.storage.get('nextId')) || 1;
    await this.ctx.storage.put('nextId', id + 1);
    if (token) {
      const n = (await this.ctx.storage.get('tokN')) || 0;
      if (n < TOKENS_MAX) {
        await this.ctx.storage.put('tok:' + token, id);
        await this.ctx.storage.put('tokN', n + 1);
      }
    }
    return id;
  }

  // Tells every member its group and the phase, after anything that moves
  // either: a join, a leave, a phase change.
  tellGroups(st) {
    const members = this.members();
    const { routes: plan, groups } = this.planNow(st, members);
    const phase = st.phase, round = st.round;
    for (const w of members) {
      const id = this.idOf(w);
      const r = plan.get(id);
      // a conductor is also told every drawer's group (gs), for the show
      // controller's dots
      const a = w.deserializeAttachment();
      const gs = a && a.conduct ? { gs: groups } : null;
      try {
        w.send(JSON.stringify(Object.assign({ t: 'group', phase, round, ms: st.ms, sm: st.sm, sz: st.sz, rt: st.rt, sr: st.sr, you: id, ids: r ? r.with : [id] }, gs)));
      } catch (e) {}
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // the tape is plain HTTP: the replay page fetches it, no socket needed
      if (request.method === 'GET' && /\/tape$/.test(new URL(request.url).pathname)) {
        return this.readTape();
      }
      return new Response('expected a websocket', { status: 426 });
    }
    const url = new URL(request.url);
    // The conductor: may set the phase. The broadcast key keeps the hall
    // zero-setup (the worker already holds it); a bad key joins as a member
    // rather than failing, so a stale link still gets to draw.
    const conduct = url.searchParams.get('conduct') === '1' &&
      !!this.env.BROADCAST_KEY && url.searchParams.get('key') === this.env.BROADCAST_KEY;
    const raw = url.searchParams.get('d') || '';
    const token = TOKEN_RE.test(raw) ? raw : '';
    const id = await this.idFor(token);
    // The same id still held by a socket here: that is this device's old
    // socket, lingering (the network dropped it before the hall heard), or
    // the device in a second tab. Either way the new socket IS the member:
    // the old one is marked replaced (so its close, whenever it comes, says
    // nothing to anyone) and closed with REPLACED, which tells its client
    // not to come back.
    for (const w of this.ctx.getWebSockets('member')) {
      const a = w.deserializeAttachment();
      if (!a || a.id !== id || a.replaced) continue;
      w.serializeAttachment(Object.assign({}, a, { replaced: true }));
      try { w.close(REPLACED, 'replaced by a newer connection of this device'); } catch (e) {}
    }
    const st = await this.step();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['member']);
    pair[1].serializeAttachment({ id, conduct, token });
    const ids = this.members().map(w => this.idOf(w));
    try {
      pair[1].send(JSON.stringify({ t: 'hello', you: id, phase: st.phase, round: st.round, ms: st.ms, sm: st.sm, sz: st.sz, rt: st.rt, sr: st.sr, ids, conduct: conduct ? 1 : 0 }));
    } catch (e) {}
    const arrived = JSON.stringify({ t: 'peer', id, on: 1 });
    for (const w of this.members()) {
      if (this.idOf(w) !== id) { try { w.send(arrived); } catch (e) {} }
    }
    // a join re-draws the groups; solo only learns the roster
    this.tellGroups(st);
    // and, with the brushes dealt, the joiner its hand (the same one again
    // for a device it has seen)
    const deal = await this.ctx.storage.get('deal');
    if (deal && deal.on) await this.tellHand(pair[1], deal);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;   // the hall carries no audio
    if (message === 'ping') return;
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'time') {
      try { ws.send(JSON.stringify({ t: 'time', c: msg.c, s: Date.now() })); } catch (e) {}
      return;
    }
    const me = ws.deserializeAttachment();
    if (!me) return;
    // the conductor's steps: a phase and its round (1 when not said), or
    // the next step along the script (groups.js SCRIPT; the last stays)
    if (msg.t === 'phase') {
      if (!me.conduct || !PHASES.includes(msg.p)) return;
      await this.setStep(msg.p, msg.r);
      return;
    }
    if (msg.t === 'next') {
      if (!me.conduct) return;
      const st = await this.step();
      const [p, r] = nextStep(st.phase, st.round);
      await this.setStep(p, r);
      return;
    }
    // the conductor's room settings: how often everyone sends a batch (ms)
    // the playback's jitter margin (sm), the Size (sz) and the Rotations (rt, sr), re-told to all
    if (msg.t === 'room') {
      if (!me.conduct) return;
      const ms = Number.isInteger(msg.ms) && msg.ms >= 10 && msg.ms <= 60 ? msg.ms : null;
      const sm = Number.isInteger(msg.sm) && msg.sm >= 0 && msg.sm <= 200 ? msg.sm : null;
      if (ms === null || sm === null) return;
      // the Size and Rotations are optional: a conductor that sends none leaves the room's
      const sz = Number.isInteger(msg.sz) && msg.sz >= 1 && msg.sz <= 100 ? msg.sz : (await this.step()).sz;
      const rt = Number.isFinite(msg.rt) && msg.rt >= 0 && msg.rt <= 4 ? msg.rt : (await this.step()).rt;
      const sr = Number.isFinite(msg.sr) && msg.sr >= 0 && msg.sr <= 4 ? msg.sr : (await this.step()).sr;
      await this.ctx.storage.put('room', { ms, sm, sz, rt, sr });
      this.tellGroups(await this.step());
      return;
    }
    if (msg.t === 'brushes') {
      if (!me.conduct) return;
      const b = readBrushes(msg);
      if (b) await this.setBrushes(b);
      return;
    }
    if (msg.t === 'wipe') {
      // the conductor clears the tape; from anyone else it says nothing
      if (me.conduct) await this.wipe();
      return;
    }
    // Everything else is the member speaking to its group: a stroke
    // ({t:'s'}), or whatever a later experience adds. Stamped with the
    // sender and relayed to the group; a stroke also lands on the tape,
    // after the relay so the recording never delays the room, in its
    // canonical shape (the fields the wire defines, nothing a client
    // smuggled alongside them).
    const members = this.members();
    const r = this.routesNow(await this.step(), members).get(me.id);
    const to = new Set(r ? r.to : []);
    msg.id = me.id;
    // a conductor's stroke is marked: in the broadcast room its followers
    // see it by the broadcast already, and let the room's copy go
    if (me.conduct) msg.cd = 1;
    const out = JSON.stringify(msg);
    for (const w of members) {
      if (to.has(this.idOf(w))) {
        try { w.send(out); } catch (e) {}
      }
    }
    if (msg.t === 's') {
      // the motif brush's fields (atlas set, tile, copies, fade) ride along
      // whenever the stroke carried them; strokes.js decides what is valid
      const s = { t: 's', k: msg.k, h: msg.h, w: msg.w, d: msg.d, p: msg.p };
      for (const f of MOTIF_FIELDS) if (msg[f] !== undefined) s[f] = msg[f];
      await this.record(me.id, s);
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) {}
    await this.left(ws);
  }
  async webSocketError(ws) {
    try { ws.close(); } catch (e) {}
    await this.left(ws);
  }
  async left(ws) {
    const me = ws.deserializeAttachment();
    // a replaced socket's id is already the newer socket's: nobody left
    if (!me || me.replaced) return;
    const gone = JSON.stringify({ t: 'peer', id: me.id, on: 0 });
    for (const w of this.members()) {
      try { w.send(gone); } catch (e) {}
    }
    this.tellGroups(await this.step());
    // An empty hall keeps everything: the tape and its epoch (the drawings
    // outlive the drawers, until a {t:'wipe'}), and the phase, the id
    // counter and the devices' ids, so a show whose whole room dropped at
    // once comes back in the phase and the groups it left. The conductor
    // starts a new gathering with Alone.
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
    // the tape: a hall's recording, read over plain HTTP by the replay
    // page; the same DO as the hall itself, found by the same name
    const tape = url.pathname.match(/^\/touch\/([\w-]{1,64})\/tape$/);
    if (tape) {
      return env.HALL.get(env.HALL.idFromName(tape[1])).fetch(request);
    }
    const hall = url.pathname.match(/^\/touch\/([\w-]{1,64})$/);
    if (hall) {
      const id = env.HALL.idFromName(hall[1]);
      return env.HALL.get(id).fetch(request);
    }
    const m = url.pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!m) return new Response('The Signal broadcast relay. Connect a websocket to /room/<name>, or a hall to /touch/<name>.');
    const id = env.ROOM.idFromName(m[1]);
    return env.ROOM.get(id).fetch(request);
  }
};
