// Same-origin video delivery for the standalone cloud presentation.
// The manifest pins an immutable R2 release; previews remain Pages assets.
export function createSlideMediaHandler(manifest) {
  const videos = new Map(manifest.videos.map(v => [v.file, v]));
  return async ({ request, env, next }) => {
    let file;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice('/slides/'.length)); }
    catch { return new Response('Invalid video path', { status: 400 }); }
    if (file.startsWith('previews/') || !file.endsWith('.mp4')) return next();
    const video = videos.get(file);
    if (!video) return new Response('Video not found', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (!env.SLIDE_MEDIA) return new Response('Video storage unavailable', { status: 503 });
    const etag = '"sha256-' + video.sha256 + '"';
    const headers = new Headers({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Cross-Origin-Resource-Policy': 'same-origin', ETag: etag });
    const matches = request.headers.get('If-None-Match')?.split(',').some(v => v.trim().replace(/^W\//, '') === etag || v.trim() === '*');
    if (matches) return new Response(null, { status: 304, headers });
    let range = null;
    const rangeHeader = request.method === 'GET' ? request.headers.get('Range') : null;
    const ifRange = request.headers.get('If-Range');
    if (rangeHeader && (!ifRange || ifRange === etag)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      let start, end;
      if (m && (m[1] || m[2])) {
        if (!m[1]) { start = Math.max(0, video.bytes - Number(m[2])); end = video.bytes - 1; }
        else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), video.bytes - 1) : video.bytes - 1; }
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= video.bytes || end < start) {
        headers.set('Content-Range', `bytes */${video.bytes}`);
        return new Response(null, { status: 416, headers });
      }
      range = { offset: start, length: end - start + 1 };
    }
    const key = manifest.prefix + file;
    const object = request.method === 'HEAD' ? await env.SLIDE_MEDIA.head(key)
      : await env.SLIDE_MEDIA.get(key, range ? { range } : undefined);
    if (!object) return new Response('Video unavailable', { status: 404 });
    if (object.size !== video.bytes) return new Response('Video incomplete', { status: 503 });
    headers.set('Content-Length', String(range ? range.length : object.size));
    if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers });
  };
}
