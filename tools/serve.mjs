// The local server: `node tools/serve.mjs [port]` (8000 when none is given)
// serves the repo root, with Node's built-ins and nothing else.
//
// It differs from `python3 -m http.server` in the headers. Every response is
// cross-origin isolated (COOP same-origin, COEP require-corp, CORP
// same-origin), which is what lets the page have SharedArrayBuffer, and with
// it Heart's fastest mode (documents/heart-audio-engine.md, §7.3); without
// them Heart carries its audio in messages instead. Every response is also
// `no-store`, so a reload always runs the code on disk, and the types are
// right for the files the engine loads (wasm must be application/wasm to
// compile as it streams in).
//
// Audio elements ask for byte ranges, so ranges are honoured. A directory is
// served by its index.html, after a redirect to its slash form so the page's
// relative URLs resolve inside it, as a static host does. Nothing outside
// the repo is ever served.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.woff2': 'font/woff2'
};

// On every response, the 404 and the redirects included.
const BASE_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store'
};

const server = http.createServer(async (req, res) => {
  const send = (status, headers, body) => {
    res.writeHead(status, { ...BASE_HEADERS, ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const notFound = () => send(404, { 'Content-Type': 'text/html; charset=utf-8' }, NOT_FOUND);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
  }

  // The path, decoded and resolved against the root. Anything that resolves
  // outside it (a ../ walk, encoded or not) is simply not found, and so is
  // a NUL, which the file system would refuse anyway.
  const url = new URL(req.url, 'http://localhost');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request\n'); }
  if (rel.includes('\0')) return notFound();
  let file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return notFound();

  let stat;
  try { stat = await fs.promises.stat(file); } catch { return notFound(); }
  if (stat.isDirectory()) {
    if (!url.pathname.endsWith('/')) return send(301, { Location: url.pathname + '/' + url.search }, '');
    file = path.join(file, 'index.html');
    try { stat = await fs.promises.stat(file); } catch { return notFound(); }
  }
  if (!stat.isFile()) return notFound();

  const size = stat.size;
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes'
  };

  // One range, as media elements ask: bytes=a-b, bytes=a- or bytes=-n.
  // Several ranges in one request are rare enough to answer with the whole
  // file, which the spec allows.
  let start = 0, end = size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      return send(416, { 'Content-Range': `bytes */${size}` }, '');
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;

  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

const NOT_FOUND = `<!doctype html>
<meta charset="utf-8">
<title>Not found</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#b9c6d4;font:300 18px/1.4 ui-sans-serif,-apple-system,sans-serif}</style>
<p>Nothing here. <a href="/" style="color:inherit">Open The Signal</a></p>
`;

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try: node tools/serve.mjs ${PORT + 1}`);
  else console.error(err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`The Signal: http://localhost:${PORT}/  (cross-origin isolated, no-store; serving ${ROOT})`);
});
