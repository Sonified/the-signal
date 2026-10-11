import assert from 'node:assert/strict';
import { createSlideMediaHandler } from './presentation-media-handler.mjs';

const data = new TextEncoder().encode('0123456789');
const calls = [];
const manifest = { prefix: 'release/slides/', videos: [{ file: 'A video.mp4', bytes: 10, sha256: 'abcdef' }] };
const handler = createSlideMediaHandler(manifest);
const bucket = {
  async head(key) { calls.push({ key, head: true }); return { size: 10 }; },
  async get(key, options) {
    calls.push({ key, options });
    const r = options?.range;
    return { size: 10, body: r ? data.slice(r.offset, r.offset + r.length) : data };
  }
};
const run = (headers = {}, method = 'GET', file = 'A%20video.mp4', env = { SLIDE_MEDIA: bucket }) => handler({
  request: new Request('https://presentation.test/slides/' + file, { headers, method }), env,
  next: () => new Response('static asset')
});
let response = await run();
assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
assert.equal(response.headers.get('Content-Type'), 'video/mp4');
assert.equal(response.headers.get('Content-Length'), '10');
assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
assert.equal(calls[0].key, 'release/slides/A video.mp4');
for (const [value, content, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'],
  ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=8-99', '89', 'bytes 8-9/10'], ['bytes=-99', '0123456789', 'bytes 0-9/10']]) {
  response = await run({ Range: value });
  assert.equal(response.status, 206); assert.equal(await response.text(), content);
  assert.equal(response.headers.get('Content-Range'), contentRange);
  assert.equal(+response.headers.get('Content-Length'), content.length);
}
for (const range of ['bytes=10-', 'bytes=8-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bytes=999999999999999999999999-']) {
  response = await run({ Range: range }); assert.equal(response.status, 416);
  assert.equal(response.headers.get('Content-Range'), 'bytes */10');
}
response = await run({ Range: 'bytes=2-5' }, 'HEAD');
assert.equal(response.status, 200); assert.equal(await response.text(), '');
assert.equal(response.headers.get('Content-Length'), '10');
response = await run({ 'If-None-Match': 'W/"sha256-abcdef"' }); assert.equal(response.status, 304);
response = await run({ Range: 'bytes=2-5', 'If-Range': '"different"' }); assert.equal(response.status, 200);
response = await run({ Range: 'bytes=2-5', 'If-Range': '"sha256-abcdef"' }); assert.equal(response.status, 206);
assert.equal((await run({}, 'GET', 'previews/144p-30fps/A.mp4')).status, 200);
assert.equal(await (await run({}, 'GET', 'qr.png')).text(), 'static asset');
assert.equal((await run({}, 'GET', 'missing.mp4')).status, 404);
assert.equal((await run({}, 'POST')).status, 405);
assert.equal((await run({}, 'GET', 'A%20video.mp4', {})).status, 503);
assert.equal((await run({}, 'GET', 'A%20video.mp4', { SLIDE_MEDIA: { get: async () => null } })).status, 404);
assert.equal((await run({}, 'GET', 'A%20video.mp4', { SLIDE_MEDIA: { get: async () => ({ size: 9 }) } })).status, 503);
console.log('PASS: video streaming, bounded/open/suffix byte ranges, invalid ranges, HEAD, cache validation, same-origin media, preview/static fallback and missing storage.');
