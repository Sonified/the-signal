// The hall link: this page's end of a group touch room
// (broadcast-worker/src/index.js, Hall; documents/touch-foundation.md).
// Joining is one WebSocket to /touch/<name> on the relay. The server
// assigns an id, names everyone present, and keeps the page told of its
// GROUP - itself plus whoever reaches it under the hall's phase
// (broadcast-worker/src/groups.js): solo, master (the conductor's strokes
// reach everyone, a member's nobody), pairs, quads, halves, all. Anything
// the page send()s is relayed by the phase's routes; anything that reaches
// it arrives in `on.message`, stamped with the sender's id.
//
// The link survives the world: it reconnects with a growing backoff (a new
// id each time - a rejoin is an arrival, which the foundation keeps simple),
// pings every 20 s so the edge keeps the socket, and works not at all
// without a server: the page is told 'offline' once and everything else
// still runs, a solo instrument.
//
// Every device joins with a token of its own (deviceToken: random, made
// once, kept in localStorage, a session's memory where storage is refused),
// and the hall gives a token it has seen before its old id back, so a
// reconnect - this link's own, or a reload - lands in exactly the group it
// left and nobody else moves. If a newer connection of the same device
// (another tab) takes the id over, the hall closes this one with REPLACED
// and this link stays offline rather than taking it back.
//
//   createHall({ host, hall, key, token, on }) ->
//     { send(msg), you, phase, round, group, peers, conduct, setPhase(p, r), next(), close() }
//
// stream and smooth are the room's own settings as the hall last told them
// (the conductor's Stream and Smoothing: how often to send a batch, ms, and
// the playback's margin past it, ms) and size, the conductor's Size (a
// stroke's w, 0 until the hall has told one) and rotate (the conductor's Rotation, turns
// a second, -1 until told); hand is this device's dealt brushes,
// { on, a, tiles }, as the hall last said ({t:'hand'}, on.hand).
//
// phase and round are what the hall last told (hello, group): the show's
// step (broadcast-worker/src/groups.js SCRIPT). A conductor asks for a step
// with setPhase(p, r) (r 1 when left out) or the next one along the script
// with next(); the hall's answer is what moves phase and round here.
//
//   on.state(s)          'joining' | 'joined' | 'offline'
//   on.group(g)          { phase, round, you, ids } whenever it changes
//   on.peer(id, there)   an arrival or a leave, roster already updated
//   on.message(msg)      a groupmate spoke; msg.id is who

// The conductor's chips, the same on /touch/ and the main app: a chip for a
// phase asks for its first round, and tapped again while that phase is the
// hall's, its next round (Pairs and Fours have two; the last stays). The
// chip names the round it shows (the hall's), 'Pairs 2'.
const ROUNDS = { pairs: 2, quads: 2 };
export function tapStep(p, phase, round) {
  const max = ROUNDS[p] || 1;
  if (p === phase && max > 1) return [p, Math.min(max, (round || 1) + 1)];
  return [p, 1];
}
export function chipLabel(label, p, phase, round) {
  return p === phase && (round || 1) > 1 ? label + ' ' + round : label;
}

const PING_MS = 20000;
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const REPLACED = 4000;   // broadcast-worker/src/index.js's close code

// This device's token under `name` in `store` ({ get(k), set(k, v) }; the
// page's localStorage when left out), made the first time it is asked for.
// A store that refuses (a private tab, a worker) gets a token for this
// session only, kept in memory.
const memTokens = new Map();
export function deviceToken(name = 'signal.hall.device', store) {
  let st = store;
  if (!st) {
    try { st = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) }; } catch (e) { st = null; }
  }
  let t = null;
  try { t = st ? st.get(name) : null; } catch (e) { t = null; }
  if (typeof t === 'string' && /^[\w-]{8,64}$/.test(t)) return t;
  t = memTokens.get(name);
  if (!t) {
    try { t = crypto.randomUUID(); } catch (e) {
      t = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
    }
    memTokens.set(name, t);
  }
  try { if (st) st.set(name, t); } catch (e) {}
  return t;
}

export function createHall({ host, hall, key = '', token, on = {} }) {
  const tok = token || deviceToken();
  const link = {
    you: 0, phase: 'solo', round: 1, conduct: false,
    stream: 0, smooth: -1, size: 0, rotate: -1, hand: null,
    group: new Set(), peers: new Set(), groups: null,
    send, setPhase, next, close
  };
  let ws = null, closed = false, tries = 0, pinger = 0, state = '';

  const tell = s => { if (s !== state) { state = s; on.state && on.state(s); } };

  function url() {
    const q = `?d=${encodeURIComponent(tok)}` + (key ? `&conduct=1&key=${encodeURIComponent(key)}` : '');
    return `wss://${host}/touch/${encodeURIComponent(hall)}${q}`;
  }

  function connect() {
    if (closed) return;
    tell('joining');
    let sock;
    try { sock = ws = new WebSocket(url()); } catch (e) { offline(); return; }
    // Only the newest socket speaks: a stale one's late events are let go,
    // so it can never start a second reconnect of its own.
    ws.onopen = () => {
      if (sock !== ws) return;
      tries = 0;
      clearInterval(pinger);
      pinger = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, PING_MS);
    };
    ws.onmessage = e => {
      if (sock !== ws) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') {
        link.you = msg.you;
        link.phase = msg.phase;
        link.round = msg.round || 1;
        link.conduct = msg.conduct === 1;
        if (Number.isFinite(msg.ms)) link.stream = msg.ms;
        if (Number.isFinite(msg.sm)) link.smooth = msg.sm;
        if (Number.isFinite(msg.sz)) link.size = msg.sz;
        if (Number.isFinite(msg.rt)) link.rotate = msg.rt;
        link.peers = new Set(msg.ids);
        tell('joined');
      } else if (msg.t === 'peer') {
        if (msg.on === 1) link.peers.add(msg.id); else link.peers.delete(msg.id);
        on.peer && on.peer(msg.id, msg.on === 1);
      } else if (msg.t === 'group') {
        link.phase = msg.phase;
        link.round = msg.round || 1;
        if (Number.isFinite(msg.ms)) link.stream = msg.ms;
        if (Number.isFinite(msg.sm)) link.smooth = msg.sm;
        if (Number.isFinite(msg.sz)) link.size = msg.sz;
        if (Number.isFinite(msg.rt)) link.rotate = msg.rt;
        link.group = new Set(msg.ids);
        // every drawer's group, told to a conductor only
        link.groups = Array.isArray(msg.gs) ? msg.gs : null;
        on.group && on.group(msg);
      } else if (msg.t === 'hand') {
        link.hand = msg.on === 1 && Array.isArray(msg.tiles) ? { on: 1, a: msg.a, tiles: msg.tiles } : null;
        on.hand && on.hand(link.hand);
      } else if (msg.t !== 'time') {
        on.message && on.message(msg);
      }
    };
    ws.onclose = e => {
      if (sock !== ws) return;
      clearInterval(pinger);
      // another connection of this device holds the id now: stay away
      if (e && e.code === REPLACED) {
        closed = true;
        console.warn('[drawing] another tab of this browser took this device\'s place in the room (one identity per browser profile) — this tab is out of the drawing. For a second drawer on one machine use a private window or another browser.');
        tell('offline');
        return;
      }
      retry();
    };
    ws.onerror = () => { try { sock.close(); } catch (e) {} };
  }

  function retry() {
    if (closed) return;
    if (tries >= BACKOFF_MS.length) { offline(); return; }
    setTimeout(connect, BACKOFF_MS[Math.min(tries++, BACKOFF_MS.length - 1)]);
  }

  // Out of retries: a solo instrument from here on, but a page regaining
  // the network (online event) is worth one more round.
  function offline() {
    tell('offline');
    tries = 0;
    try {
      addEventListener('online', () => { if (state === 'offline') connect(); }, { once: true });
    } catch (e) {}
  }

  function send(msg) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
  }
  function setPhase(p, r) {
    if (link.conduct) send(r > 1 ? { t: 'phase', p, r } : { t: 'phase', p });
  }
  function next() {
    if (link.conduct) send({ t: 'next' });
  }
  function close() {
    closed = true;
    clearInterval(pinger);
    try { ws && ws.close(); } catch (e) {}
  }

  connect();
  return link;
}
