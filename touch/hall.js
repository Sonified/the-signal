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
//   createHall({ host, hall, key, on }) ->
//     { send(msg), you, phase, group, peers, conduct, setPhase(p), close() }
//
//   on.state(s)          'joining' | 'joined' | 'offline'
//   on.group(g)          { phase, you, ids } whenever it changes
//   on.peer(id, there)   an arrival or a leave, roster already updated
//   on.message(msg)      a groupmate spoke; msg.id is who

const PING_MS = 20000;
const BACKOFF_MS = [1000, 2000, 4000, 8000];

export function createHall({ host, hall, key = '', on = {} }) {
  const link = {
    you: 0, phase: 'solo', conduct: false,
    group: new Set(), peers: new Set(),
    send, setPhase, close
  };
  let ws = null, closed = false, tries = 0, pinger = 0, state = '';

  const tell = s => { if (s !== state) { state = s; on.state && on.state(s); } };

  function url() {
    const q = key ? `?conduct=1&key=${encodeURIComponent(key)}` : '';
    return `wss://${host}/touch/${encodeURIComponent(hall)}${q}`;
  }

  function connect() {
    if (closed) return;
    tell('joining');
    try { ws = new WebSocket(url()); } catch (e) { offline(); return; }
    ws.onopen = () => {
      tries = 0;
      clearInterval(pinger);
      pinger = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, PING_MS);
    };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') {
        link.you = msg.you;
        link.phase = msg.phase;
        link.conduct = msg.conduct === 1;
        link.peers = new Set(msg.ids);
        tell('joined');
      } else if (msg.t === 'peer') {
        if (msg.on === 1) link.peers.add(msg.id); else link.peers.delete(msg.id);
        on.peer && on.peer(msg.id, msg.on === 1);
      } else if (msg.t === 'group') {
        link.phase = msg.phase;
        link.group = new Set(msg.ids);
        on.group && on.group(msg);
      } else if (msg.t !== 'time') {
        on.message && on.message(msg);
      }
    };
    ws.onclose = () => { clearInterval(pinger); retry(); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
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
  function setPhase(p) {
    if (link.conduct) send({ t: 'phase', p });
  }
  function close() {
    closed = true;
    clearInterval(pinger);
    try { ws && ws.close(); } catch (e) {}
  }

  connect();
  return link;
}
