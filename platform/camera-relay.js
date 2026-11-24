// Live Video's socket to the video relay: the deployed VideoRoom of the video
// broadcast test (video-broadcast-testing/worker, apart from the show's own
// relay), reached as video-broadcast-testing/js/net.js reaches it, cut to
// what Live Video needs: join a room, reconnect by itself with backoff, keep
// alive, hand on binary packets and relayed messages.
//
// THE RELAY TAKES NO PASSWORD. Anyone who knows the room name can join it
// and send frames, and a viewer shows whoever sent the newest full picture.
// Accepted for now (the room name is fixed, not secret); a sender key in
// the worker is the follow-up.
//
//   const r = relayConnect(room, { onHello(me), onPeer(id, on), onPacket(buf), onMessage(msg) });
//   r.send(buf) -> false when refused (not open, or too much queued)
//   r.sendJSON(obj); r.id; r.close()

export const RELAY_HOST = 'the-signal-video-test.robertalexander-music.workers.dev';

const WHO_KEY = 'signal.cam.who';
const WHO_RE = /^[\w-]{8,64}$/;
const REPLACED = 4000;
export const SEND_LIMIT = 256 * 1024;
const PING_MS = 20000;                  // keepalive; the relay answers 'pong' at the edge
const RETRY_MIN_MS = 250, RETRY_CAP_MS = 8000;
const CONNECT_MS = 5000, SILENT_MS = 45000, WATCH_MS = 1000;

function newWho() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  try { sessionStorage.setItem(WHO_KEY, s); } catch (e) {}
  return s;
}
function loadWho() {
  try { const s = sessionStorage.getItem(WHO_KEY); if (s && WHO_RE.test(s)) return s; } catch (e) {}
  return newWho();
}

export function relayUrl(room, who) {
  return 'wss://' + RELAY_HOST + '/room/' + encodeURIComponent(room) + '?who=' + encodeURIComponent(who);
}

export function relayConnect(room, h) {
  let who = loadWho();
  const call = (name, a, b) => {
    const f = h && h[name];
    if (typeof f === 'function') { try { f(a, b); } catch (e) { console.warn('live video: ' + name + ' failed', e); } }
  };
  let ws = null, closed = false, me = 0, fails = 0;
  let retryTimer = null, pingTimer = null, watchTimer = null, since = 0, lastRx = 0;

  function stopTimers() {
    clearInterval(pingTimer); clearInterval(watchTimer);
    pingTimer = watchTimer = null;
  }
  function lost(sock) {
    if (sock !== ws) return;
    stopTimers();
    ws = null; me = 0;
    try { sock.close(); } catch (e) {}
    if (closed) return;
    fails++;
    if (fails === 1) console.warn('live video: the video relay dropped; reconnecting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, Math.min(RETRY_CAP_MS, RETRY_MIN_MS * Math.pow(2, fails - 1)));
  }
  function open() {
    if (closed) return;
    let sock;
    try { sock = new WebSocket(relayUrl(room, who)); }
    catch (e) { ws = null; fails++; clearTimeout(retryTimer); retryTimer = setTimeout(open, RETRY_CAP_MS); return; }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    since = Date.now();
    watchTimer = setInterval(() => {
      const t = Date.now();
      if (sock.readyState === 0 ? t - since > CONNECT_MS : t - lastRx > SILENT_MS) lost(sock);
    }, WATCH_MS);
    sock.onopen = () => {
      if (sock !== ws) return;
      lastRx = Date.now();
      fails = 0;
      pingTimer = setInterval(() => { try { if (sock.readyState === 1) sock.send('ping'); } catch (e) {} }, PING_MS);
    };
    sock.onmessage = e => {
      if (sock !== ws) return;
      lastRx = Date.now();
      const d = e.data;
      if (typeof d !== 'string') { call('onPacket', d); return; }
      if (d === 'pong') return;
      let msg;
      try { msg = JSON.parse(d); } catch (err) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'replaced' && msg.from === undefined) { who = newWho(); lost(sock); return; }
      if (msg.t === 'hello' && msg.from === undefined) { me = msg.you | 0; call('onHello', me); return; }
      if (msg.t === 'peer' && msg.from === undefined) { call('onPeer', msg.id, msg.on === 1 || msg.on === true); return; }
      if (msg.t === 'time' && msg.from === undefined) return;
      call('onMessage', msg);
    };
    sock.onerror = () => lost(sock);
    sock.onclose = e => {
      if (sock === ws && e && e.code === REPLACED) who = newWho();
      lost(sock);
    };
  }
  open();
  return {
    get id() { return me; },
    get open() { return !!ws && ws.readyState === 1; },
    send(buf) {
      if (!ws || ws.readyState !== 1 || ws.bufferedAmount > SEND_LIMIT) return false;
      try { ws.send(buf); return true; } catch (e) { return false; }
    },
    sendJSON(obj) {
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    },
    close() {
      closed = true;
      stopTimers();
      clearTimeout(retryTimer);
      const s = ws;
      ws = null; me = 0;
      if (s) { try { s.close(); } catch (e) {} }
    }
  };
}
