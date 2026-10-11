// The local relay: `node tools/mirror-local.mjs [port]` (8800 when none is
// given). The mirror test's no-internet path, the same idea as OSC on your
// own router: the iPad and this Mac on one Wi-Fi, talking straight to each
// other.
//
// It does what the Cloudflare relay (broadcast-worker/) does for mirror
// rooms, on this machine: POST /auth checks the password, /room/<name> is a
// WebSocket room (one controller broadcasting, presentations following, the
// last state kept for joiners, {t:'time'} answered with this clock, 'ping'
// with 'pong'), and everything else is the repo's files, so the iPad loads
// the page itself from here: http://<this mac>.local:8800/remote.html?controller
// (Safari will not let a page from the secure site open a plain local
// connection; a page from this server may.)
//
// The password is read from MIRROR_KEY or, failing that, the file
// .mirror-key at the repo root (git-ignored). With neither, every password
// is refused. Node's built-ins only: the WebSocket framing is done here, as
// much of it as small text messages need.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8800;
let KEY = process.env.MIRROR_KEY || '';
try { if (!KEY) KEY = fs.readFileSync(path.join(ROOT, '.mirror-key'), 'utf8').trim(); } catch {}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.wasm': 'application/wasm'
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // a page on the public site asking this machine (Chrome's local network
  // access check) is let through
  'Access-Control-Allow-Private-Network': 'true'
};

// ---------- files and /auth ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/auth') {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    let body = '';
    req.on('data', c => { if (body.length < 256) body += c; });
    req.on('end', () => {
      const ok = !!KEY && body.slice(0, 256) === KEY;
      res.writeHead(ok ? 200 : 403, { ...CORS, 'Content-Type': 'text/plain' });
      res.end(ok ? 'ok' : 'no');
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/remote.html';
  let file = path.resolve(ROOT, '.' + rel);
  if (rel.includes('\0') || (file !== ROOT && !file.startsWith(ROOT + path.sep)) || path.basename(file).startsWith('.')) {
    res.writeHead(404); return res.end('not found');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ---------- WebSocket rooms ----------
const rooms = new Map();   // name -> { broadcast: Set, follow: Set, snap }
const room = name => {
  let r = rooms.get(name);
  if (!r) rooms.set(name, r = { broadcast: new Set(), follow: new Set(), snap: null });
  return r;
};

function frame(text) {
  const p = Buffer.from(text);
  const n = p.length;
  const head = n < 126 ? Buffer.from([0x81, n])
    : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, p]);
}
const sendTo = (sock, text) => { try { if (!sock.destroyed) sock.write(frame(text)); } catch {} };

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/room\/([\w-]{1,64})$/);
  const wsKey = req.headers['sec-websocket-key'];
  if (!m || !wsKey) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  if (!KEY || url.searchParams.get('key') !== KEY) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const role = url.searchParams.get('role') === 'broadcast' ? 'broadcast' : 'follow';
  const accept = crypto.createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);

  const r = room(m[1]);
  r[role].add(sock);
  const counts = () => { const msg = JSON.stringify({ t: 'count', n: r.follow.size }); for (const b of r.broadcast) sendTo(b, msg); };
  console.log(`[mirror] ${role} joined ${m[1]} from ${req.socket.remoteAddress}`);
  if (role === 'follow') { if (r.snap) sendTo(sock, r.snap); counts(); }
  else sendTo(sock, JSON.stringify({ t: 'count', n: r.follow.size }));

  const onText = text => {
    if (text === 'ping') return sendTo(sock, 'pong');
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'time') return sendTo(sock, JSON.stringify({ t: 'time', c: msg.c, s: Date.now() }));
    if (role !== 'broadcast') return;
    if (msg.t === 'state') r.snap = text;
    else if (msg.t === 'end') r.snap = null;
    else if (msg.t !== 'word' && msg.t !== 'phase') return;
    for (const f of r.follow) sendTo(f, text);
  };

  // Frames from the browser: always masked, small, unfragmented in practice.
  let buf = Buffer.alloc(0);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128;
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mk = buf.subarray(off, off + 4);
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= mk[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 1) onText(data.toString('utf8'));
      else if (op === 8) { try { sock.end(Buffer.from([0x88, 0])); } catch {} return; }
      else if (op === 9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); } catch {} }
    }
  });
  const gone = () => {
    if (!r[role].delete(sock)) return;
    console.log(`[mirror] ${role} left ${m[1]}`);
    if (role === 'follow') counts();
  };
  sock.on('close', gone);
  sock.on('error', gone);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use (is the local relay already running?)`);
  else console.error(err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  // the Bonjour name the iPad resolves (os.hostname() can be another name)
  const name = (() => {
    try { return execSync('scutil --get LocalHostName', { encoding: 'utf8' }).trim() + '.local'; }
    catch { return os.hostname().replace(/\.local$/, '') + '.local'; }
  })();
  console.log(`Mirror local relay on port ${PORT}${KEY ? '' : '  (NO PASSWORD SET: put it in .mirror-key; every password is refused)'}`);
  console.log(`  iPad:   http://${name}:${PORT}/remote.html?controller`);
  console.log(`  laptop: http://localhost:${PORT}/remote.html?presentation`);
});
