// The test page's side of the socket: one WebSocket to the video test relay
// (worker/src/index.js), which reconnects by itself, keeps itself alive,
// learns the room's clock and counts what it carries.
//
//   const net = connect({ room, onHello, onPeer, onPacket, onMessage, onStatus });
//
//   onHello(me, ids)  joined: my id, and the ids already present. After a
//                     reconnect it comes again, with the SAME id for me (the
//                     relay knows this device by its token, below); anyone
//                     known before and missing from the new list is first
//                     reported gone through onPeer(id, false), so a page that
//                     keeps its panels in a Map by id stays right by adding
//                     each id
//   onPeer(id, on)    someone arrived (true) or left (false)
//   onPacket(buf)     each binary packet as an ArrayBuffer, untouched
//                     (js/wire.js unpack reads it; `from` is filled in)
//   onMessage(msg)    any other relayed JSON object (it has .from)
//   onStatus(text)    'connecting' | 'open' | 'closed'
//
// The relay is the deployed one by default, localhost included, so the page
// works from a local server with no extra steps; ?relay=<host> on the page
// URL points one load at another (ws:// for localhost and 127.*, which is
// how a `wrangler dev` relay on :8787 is reached).
//
// The clock. Every frame carries its capture time on the room's clock, so a
// receiver can tell how late it is. The relay answers {t:'time', c} with
// its Date.now() as `s`; with the round trip measured here, s + rtt/2 is
// the relay's time at the moment of the reply, and the difference from
// performance.now() is this device's offset to the room. A probe whose
// trip was slow (queued behind frames, a radio waking) halves badly, so of
// the last PROBE_KEEP probes the one with the smallest round trip wins:
// the usual trick for ignoring slow ones.

// Who this is. The page makes up a random token once and tells the relay it
// on every join (?who=), so the relay knows a device coming back from a
// dropped link is the same member, keeps its id, and retires its old
// connection instead of leaving it behind as a ghost. The token lives in
// sessionStorage: it survives a reload and a reconnect, and each tab is its
// own member (two tabs on one computer are two people, which a test wants).
// A duplicated tab starts with a copy of the token; when the relay closes
// the older one ({t:'replaced'}, then close code 4000: "you joined again
// elsewhere"), that tab makes itself a new token and comes back as a new
// member.

export const RELAY_HOST = 'the-signal-video-test.robertalexander-music.workers.dev';

const WHO_KEY = 'vbt.who';
const WHO_RE = /^[\w-]{8,64}$/;
const REPLACED = 4000;

function newWho() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(16);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
  let s = '';
  for (const n of a) s += chars[n % chars.length];
  try { sessionStorage.setItem(WHO_KEY, s); } catch (e) { /* no storage: the token lasts as long as the page */ }
  return s;
}
function loadWho() {
  try {
    const s = sessionStorage.getItem(WHO_KEY);
    if (s && WHO_RE.test(s)) return s;
  } catch (e) {}
  return newWho();
}

// How much may wait in the socket's send queue before send() refuses a
// packet. A starting guess for the test to tune: too small and frames are
// refused on any hiccup, too large and frames queue up and arrive late.
// A refusal is a lost frame; the caller asks its encoder for a full picture.
export const SEND_LIMIT = 256 * 1024;

const PING_MS = 20000;                  // keepalive through Cloudflare's idle timeout
const RETRY_MIN_MS = 250, RETRY_CAP_MS = 4000;
// A socket that hangs, still connecting after CONNECT_MS or open but silent
// for SILENT_MS (a probe goes out every 10 s, so a live link always has a
// reply by then), is given up and replaced: a phone changing networks can
// leave a half-open socket that never closes by itself.
const CONNECT_MS = 5000, SILENT_MS = 30000, WATCH_MS = 1000;
const PROBE_QUICK = 5;                  // probes over the first PROBE_QUICK_MS
const PROBE_QUICK_MS = 2000;
const PROBE_MS = 10000;                 // and then one this often
const PROBE_KEEP = 10;                  // the best of these many recent probes sets the offset
const BUCKET_MS = 100, BUCKETS = 10;    // the stats window: the last ten whole tenths of a second

const ROOM_RE = /^[\w-]{1,64}$/;
const LOCAL_RE = /^(localhost|127\.)/;

function relayUrl(room, who) {
  let host = RELAY_HOST;
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('relay')) host = q.get('relay');
  } catch (e) {}
  const scheme = LOCAL_RE.test(host) ? 'ws' : 'wss';
  return scheme + '://' + host + '/room/' + encodeURIComponent(room) + '?who=' + encodeURIComponent(who);
}

export function connect(opts) {
  const room = String(opts.room || '');
  if (!ROOM_RE.test(room)) {
    console.warn('[net] room "' + room + '" is not 1-64 letters, digits, _ or -; the relay will not take it');
  }
  let who = loadWho();
  const call = (name, ...args) => {
    const f = opts[name];
    if (typeof f === 'function') {
      try { f(...args); } catch (e) { console.error('[net] ' + name + ' threw', e); }
    }
  };

  let ws = null, closed = false, status = '', me = 0, echo = false;
  let fails = 0, retryTimer = null, pingTimer = null, probeTimer = null;
  let watchTimer = null, since = 0, lastRx = 0;
  const peers = new Set();
  let refused = 0;

  // the clock (see the top)
  let offset = Date.now() - performance.now();
  let rtt = null;
  const probes = [];   // { rtt, off }, newest last

  // the stats window: a ring of BUCKETS + 1 tenths, so BUCKETS whole ones
  // sit behind the one now filling
  const RING = BUCKETS + 1;
  const stamp = new Float64Array(RING).fill(-1);
  const upB = new Float64Array(RING), downB = new Float64Array(RING);
  const upM = new Float64Array(RING), downM = new Float64Array(RING);
  function slot() {
    const b = Math.floor(performance.now() / BUCKET_MS);
    const i = b % RING;
    if (stamp[i] !== b) { stamp[i] = b; upB[i] = downB[i] = upM[i] = downM[i] = 0; }
    return i;
  }
  function countUp(n) { const i = slot(); upB[i] += n; upM[i]++; }
  function countDown(n) { const i = slot(); downB[i] += n; downM[i]++; }

  function setStatus(s) {
    if (s === status) return;
    status = s;
    call('onStatus', s);
  }

  function sendText(s) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(s); } catch (e) { return false; }
    countUp(s.length);
    return true;
  }

  function probe() {
    sendText(JSON.stringify({ t: 'time', c: performance.now() }));
  }
  function startProbes() {
    let n = 0;
    const next = () => {
      probe();
      n++;
      probeTimer = setTimeout(next, n < PROBE_QUICK ? PROBE_QUICK_MS / PROBE_QUICK : PROBE_MS);
    };
    next();
  }
  function onTime(msg) {
    const now = performance.now();
    if (typeof msg.c !== 'number' || typeof msg.s !== 'number') return;
    const trip = now - msg.c;
    if (!(trip >= 0)) return;
    rtt = trip;
    probes.push({ rtt: trip, off: msg.s + trip / 2 - now });
    if (probes.length > PROBE_KEEP) probes.shift();
    let best = probes[0];
    for (const p of probes) if (p.rtt < best.rtt) best = p;
    offset = best.off;
  }

  function stopTimers() {
    clearInterval(pingTimer);
    clearTimeout(probeTimer);
    clearInterval(watchTimer);
    pingTimer = probeTimer = watchTimer = null;
  }

  // The socket ends, however it ended (its close event, or given up as
  // hung): forgotten, so any late event of its own is ignored, and replaced.
  function lost(sock) {
    if (sock !== ws) return;
    stopTimers();
    me = 0;
    ws = null;
    try { sock.close(); } catch (e) {}
    if (closed) return;
    setStatus('closed');
    fails++;
    retry();
  }

  function open() {
    if (closed) return;
    setStatus('connecting');
    let sock;
    try { sock = new WebSocket(relayUrl(room, who)); } catch (e) { fails++; retry(); return; }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    since = performance.now();
    watchTimer = setInterval(() => {
      const t = performance.now();
      if (sock.readyState === 0 ? t - since > CONNECT_MS : t - lastRx > SILENT_MS) lost(sock);
    }, WATCH_MS);
    sock.onopen = () => {
      if (sock !== ws) return;
      lastRx = performance.now();
      fails = 0;
      setStatus('open');
      pingTimer = setInterval(() => sendText('ping'), PING_MS);
      startProbes();
      if (echo) sendText(JSON.stringify({ t: 'echo', on: 1 }));
    };
    sock.onmessage = e => {
      if (sock !== ws) return;
      lastRx = performance.now();
      const d = e.data;
      if (typeof d !== 'string') {
        countDown(d.byteLength);
        call('onPacket', d);
        return;
      }
      countDown(d.length);
      if (d === 'pong') return;
      let msg;
      try { msg = JSON.parse(d); } catch (err) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'time' && msg.from === undefined) { onTime(msg); return; }
      // retired by the relay because another page joined with my token (a
      // duplicated tab): come back as someone new, not as a rival for it
      if (msg.t === 'replaced' && msg.from === undefined) { who = newWho(); lost(sock); return; }
      if (msg.t === 'hello' && msg.from === undefined) {
        me = msg.you | 0;
        const ids = Array.isArray(msg.ids) ? msg.ids.filter(x => x !== me) : [];
        const now = new Set(ids);
        for (const id of [...peers]) {
          if (!now.has(id)) { peers.delete(id); call('onPeer', id, false); }
        }
        for (const id of ids) peers.add(id);
        call('onHello', me, ids);
        return;
      }
      if (msg.t === 'peer' && msg.from === undefined) {
        const on = msg.on === 1 || msg.on === true;
        if (on) peers.add(msg.id); else peers.delete(msg.id);
        call('onPeer', msg.id, on);
        return;
      }
      call('onMessage', msg);
    };
    sock.onerror = () => lost(sock);
    sock.onclose = e => {
      // retired by the relay because another page joined with my token (a
      // duplicated tab): come back as someone new, not as a rival for it
      if (sock === ws && e && e.code === REPLACED) who = newWho();
      lost(sock);
    };
  }
  function retry() {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, Math.min(RETRY_CAP_MS, RETRY_MIN_MS * Math.pow(2, Math.max(0, fails - 1))));
  }

  open();

  return {
    get id() { return me; },
    now() { return performance.now() + offset; },
    send(buf) {
      if (!ws || ws.readyState !== 1) return false;
      if (ws.bufferedAmount > SEND_LIMIT) { refused++; return false; }
      try { ws.send(buf); } catch (e) { return false; }
      countUp(buf.byteLength);
      return true;
    },
    sendJSON(obj) { return sendText(JSON.stringify(obj)); },
    setEcho(on) {
      echo = !!on;
      sendText(JSON.stringify({ t: 'echo', on: echo ? 1 : 0 }));
    },
    // Per second over the last BUCKETS whole tenths (one second, ending at
    // most a tenth ago), counting everything the socket carried: frames,
    // relayed messages, probes and pings.
    stats() {
      const cur = Math.floor(performance.now() / BUCKET_MS);
      let ub = 0, db = 0, um = 0, dm = 0;
      for (let i = 0; i < RING; i++) {
        const age = cur - stamp[i];
        if (age < 1 || age > BUCKETS) continue;
        ub += upB[i]; db += downB[i]; um += upM[i]; dm += downM[i];
      }
      const per = 1000 / (BUCKETS * BUCKET_MS);
      return {
        upBytes: ub * per, downBytes: db * per, upMsgs: um * per, downMsgs: dm * per,
        buffered: ws ? ws.bufferedAmount : 0,
        rtt,
        refused,
        status,
        people: peers.size + 1
      };
    },
    close() {
      closed = true;
      stopTimers();
      clearTimeout(retryTimer);
      const s = ws;
      ws = null;
      me = 0;
      if (s) { try { s.close(); } catch (e) {} }
      setStatus('closed');
    }
  };
}
