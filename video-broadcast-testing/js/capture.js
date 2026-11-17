// My camera, turned into packets for the relay.
//
// The camera opens into a muted <video> of its own (the preview, which the
// page places so I can see myself). Each time that video shows a new camera
// frame, requestVideoFrameCallback tells us; frames come faster than the
// rate asked for more often than not, so most are let go, and the ones kept
// are spaced to hold the target rate. A kept frame becomes a VideoFrame at
// the size being sent, goes into a WebCodecs VideoEncoder, and each encoded
// chunk that comes out is wrapped in wire.js's header and handed to send().
// Nothing here waits on the network: send() says yes or no at once, and a no
// is a lost picture.
//
// Frames are taken on the page's own thread. Safari offers
// MediaStreamTrackProcessor only inside a worker, while a VideoFrame made
// from a playing <video> works on the page in both Chrome and Safari, so
// that is the one road. Where requestVideoFrameCallback is missing, or goes
// quiet (some browsers stop calling it for a video that is hidden or not on
// the page), a timer at the target rate takes the frames instead.
//
// The picture keeps the camera's own shape. The width asked for is the width
// sent; the height follows from the shape the camera actually delivers, both
// rounded to even numbers, so a phone held upright sends a tall picture and
// nobody arrives stretched. Turning the phone changes the camera's shape
// mid-stream; the next frame notices and the encoder is rebuilt for it.
//
// A frame that already has the sending size goes to the encoder as the
// camera made it. One that needs scaling is drawn into a small canvas of the
// sending size first and taken from there: drawImage scales and turns the
// picture exactly as the video shows it, in every browser, where the encoder
// left to scale on its own might not, or might not turn it. A camera frame
// that carries a rotation of its own (an iPhone held upright can) is sent
// through the canvas for the same reason.
//
// Each packet is stamped with the room's clock as it was when its frame was
// taken from the camera, not when it left the encoder, so a receiver can
// measure the whole road. The stamp rides beside the frame through the
// encoder in a small map keyed by the frame's timestamp.
//
// A full picture (a keyframe) goes out on the first frame, on any frame after
// forceKey(), after any change of settings, after any packet send() refused
// (the receivers now have a hole and can mend it only from a full picture),
// and at least every keyEvery seconds. Formats that need a decoder
// description (H.264) carry the latest one on every full picture, so anyone
// can start from any of them.
//
// Work never piles up: with more than two frames already waiting in the
// encoder, a camera frame is let go and counted as dropped.
import { KIND_VIDEO, CODECS, codecById, pack } from './wire.js';

// What a setting falls back to when it is missing or not a number.
const DEFAULTS = { width: 320, height: 240, fps: 15, bitrate: 300000, codec: CODECS[0].id, keyEvery: 2 };
// The smallest picture side, the highest rate and the lowest bitrate we ask
// of an encoder; below or above these, encoders refuse or behave oddly.
const MIN_SIDE = 16, MAX_FPS = 60, MIN_BITRATE = 10000;
// More frames than this waiting in the encoder and the camera frame is let go.
const MAX_QUEUE = 2;
// A frame arriving this fraction of a frame early still counts as on time,
// so camera jitter does not knock the rate down.
const EARLY = 0.2;
// The stats look back this far.
const WINDOW_MS = 1000;
// The backup timer ticks this often, and takes over from
// requestVideoFrameCallback when that has been quiet for STALE_MS (or three
// frames, whichever is longer).
const TICK_MS = 1000 / 60, STALE_MS = 250;
// How long the camera has to show its first picture before we give up, and
// how long a change of camera size is given to arrive.
const FIRST_PICTURE_MS = 5000, RESIZE_MS = 600;
// A direct VideoFrame from the video that throws this many times in a row
// is not tried again; the canvas does the work from then on.
const DIRECT_TRIES = 3;

// Which of wire.js's CODECS this device can encode at these settings, in
// CODECS order. Each is asked of VideoEncoder.isConfigSupported at once.
export async function listCodecs({ width, height, fps, bitrate } = {}) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') return [];
  const s = settle({ width, height, fps, bitrate }, DEFAULTS);
  const asks = CODECS.map(async entry => {
    try {
      const r = await VideoEncoder.isConfigSupported(encoderConfig(entry, s.width, s.height, s));
      return r && r.supported ? { id: entry.id, name: entry.name } : null;
    } catch (e) {
      return null;
    }
  });
  return (await Promise.all(asks)).filter(Boolean);
}

export function createCapture({ now, send, onState } = {}) {
  const clock = typeof now === 'function' ? now : () => performance.now();
  const post = typeof send === 'function' ? send : () => false;
  const tell = typeof onState === 'function' ? onState : () => {};

  const preview = document.createElement('video');
  preview.muted = true;
  preview.defaultMuted = true;
  preview.playsInline = true;
  preview.autoplay = true;
  preview.setAttribute('muted', '');
  preview.setAttribute('playsinline', '');
  preview.setAttribute('autoplay', '');

  let cur = settle({}, DEFAULTS);   // the settings asked for, start or apply
  let running = false;
  let life = 0;                     // bumps on every start and stop; stale work checks it
  let stream = null;
  let state = 'off';

  // The encoder, the settings it was last configured with (null while there
  // is none that works), and the codec entry behind it. `gen` bumps whenever
  // an encoder is let go, so its late output and errors are ignored.
  let encoder = null, active = null, gen = 0;
  let desc = null;                  // the latest decoder description, a copy
  let chain = Promise.resolve();    // encoder changes, one after another

  // The camera's shape as the video shows it, last time we looked.
  let shapeW = 0, shapeH = 0;

  // Frame taking.
  let rvfcId = null, tick = null, lastCallback = 0, due = 0, lastTs = 0;
  let canvas = null, ctx = null, canvasOnPage = false;
  let direct = true, directFails = 0;

  // Full pictures.
  let keyWanted = true, lastKeyAsked = -Infinity, lastKeyOut = -Infinity;

  // Each frame in the encoder, by its timestamp: the room-clock stamp, when
  // it went in, and the size, format and rate it went in with.
  const inFlight = new Map();
  let seq = 0;

  // Stats: totals, and samples from the last WINDOW_MS.
  let keyframes = 0, dropped = 0, refused = 0;
  let outs = [];                    // { at, bytes, sent, encodeMs }
  let camTimes = [];                // when the camera showed each frame
  let everStarted = false;

  function say(text) {
    if (text === state) return;
    state = text;
    try { tell(text); } catch (e) { /* the page's own trouble */ }
  }

  // ------------------------------------------------------------ start, stop

  async function start(settings) {
    if (running) return apply(settings);
    const my = ++life;
    cur = settle(settings, cur);
    say('starting');

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      say('error: this page cannot reach the camera (it has to be opened over https)');
      return false;
    }
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      say('error: this browser cannot send video (try a newer Chrome or Safari)');
      return false;
    }

    // The camera first, before anything else is awaited, so the tap that
    // called start still counts as the reason for asking.
    let got;
    try {
      got = await navigator.mediaDevices.getUserMedia({ video: cameraAsk(cur), audio: false });
    } catch (e) {
      if (my === life) say('error: ' + cameraTrouble(e));
      return false;
    }
    if (my !== life) { stopTracks(got); return false; }

    stream = got;
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stopTracks(stream); stream = null;
      say('error: no camera was found');
      return false;
    }
    track.addEventListener('ended', () => {
      if (my !== life) return;
      life++;
      teardown();
      say('error: the camera was switched off or taken by another app');
    });

    preview.srcObject = stream;
    const playing = preview.play();
    if (playing && playing.catch) playing.catch(() => {});

    const shown = await whenSized(preview, FIRST_PICTURE_MS);
    if (my !== life) return false;
    if (!shown) {
      teardown();
      say('error: the camera started but sent no picture');
      return false;
    }

    everStarted = true;
    running = true;
    seq = 0;
    keyframes = 0; dropped = 0; refused = 0;
    outs = []; camTimes = [];
    keyWanted = true; lastKeyAsked = -Infinity; lastKeyOut = -Infinity;
    shapeW = preview.videoWidth; shapeH = preview.videoHeight;
    due = 0;
    direct = true; directFails = 0;
    listen();

    await sync();
    return running && my === life && active != null;
  }

  function stop() {
    life++;
    const was = running || stream != null || state !== 'off';
    teardown();
    if (was) say('off');
  }

  // Everything let go: the frame loop, the encoder, the camera, the preview.
  function teardown() {
    running = false;
    if (rvfcId != null && typeof preview.cancelVideoFrameCallback === 'function') {
      try { preview.cancelVideoFrameCallback(rvfcId); } catch (e) { /* already gone */ }
    }
    rvfcId = null;
    if (tick != null) clearInterval(tick);
    tick = null;
    dropEncoder();
    stopTracks(stream);
    stream = null;
    try { preview.pause(); } catch (e) { /* not playing */ }
    preview.srcObject = null;
    shapeW = 0; shapeH = 0;
    camTimes = [];
  }

  // ------------------------------------------------------------ settings

  async function apply(settings) {
    const prev = cur;
    const next = settle(settings, cur);
    cur = next;
    if (!running) return;
    if (same(prev, next) && active) return;   // nothing new, and an encoder that works
    keyWanted = true;
    const my = life;
    if (next.width !== prev.width || next.height !== prev.height) await reaskCamera(next, my);
    if (my !== life) return;
    await sync();
  }

  // A new sending size may want a different size from the camera: one too
  // small to send without blowing up, or more than twice as big as needed
  // (a waste of the device's work). Anything between is left alone, and so
  // is the camera for a change of rate, bitrate, format or key spacing.
  async function reaskCamera(next, my) {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    const got = typeof track.getSettings === 'function' ? track.getSettings() : {};
    const have = Math.max(got.width || 0, got.height || 0);
    const need = Math.max(next.width, next.height);
    if (!have || (need <= have && have <= need * 2)) return;
    try {
      await track.applyConstraints(cameraAsk(next));
    } catch (e) {
      return;   // the camera keeps the size it had; the canvas scales from it
    }
    if (my !== life) return;
    await whenResized(preview, RESIZE_MS);
  }

  // Bring the encoder in line with the settings and the camera's shape:
  // nothing if it already is; a reconfigure in place for a change of bitrate
  // or rate; a new encoder for a change of size or format, or when there is
  // none that works. One at a time, in order.
  function sync() {
    const my = life;
    chain = chain.then(() => syncNow(my)).catch(e => {
      if (my === life && running) say('error: the picture could not be packed for sending' + reason(e));
    });
    return chain;
  }

  async function syncNow(my) {
    if (!running || my !== life) return;
    const entry = codecById(cur.codec);
    if (!entry) {
      dropEncoder();
      say('error: that picture format is not one this test knows');
      return;
    }
    const size = sendSize(cur, shapeW, shapeH);
    const want = { codec: entry.id, width: size.width, height: size.height, bitrate: cur.bitrate, fps: cur.fps };
    const fresh = !encoder || encoder.state === 'closed' || !active ||
      active.codec !== want.codec || active.width !== want.width || active.height !== want.height;
    if (!fresh && active.bitrate === want.bitrate && active.fps === want.fps) return;

    const config = encoderConfig(entry, want.width, want.height, want);
    let ok = false;
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      ok = !!(r && r.supported);
    } catch (e) {
      ok = false;
    }
    if (!running || my !== life) return;
    if (!ok) {
      dropEncoder();
      say(`error: this device cannot send ${entry.name} at ${want.width} × ${want.height}; try another format or a smaller size`);
      return;
    }

    if (fresh) {
      dropEncoder();
      const mine = gen;
      encoder = new VideoEncoder({
        output: (chunk, meta) => onChunk(mine, chunk, meta),
        error: e => onEncoderError(mine, e)
      });
    }
    try {
      encoder.configure(config);
    } catch (e) {
      dropEncoder();
      say(`error: this device would not send ${entry.name} at ${want.width} × ${want.height}; try another format or a smaller size`);
      return;
    }
    active = want;
    keyWanted = true;
    say('on');
  }

  function onEncoderError(mine, e) {
    if (mine !== gen) return;
    dropEncoder();
    if (running) say('error: packing the picture for sending stopped working; try another format or a smaller size' + reason(e));
  }

  function dropEncoder() {
    gen++;
    if (encoder && encoder.state !== 'closed') {
      try { encoder.close(); } catch (e) { /* already closed */ }
    }
    encoder = null;
    active = null;
    desc = null;
    inFlight.clear();
  }

  // ------------------------------------------------------------ frames

  function listen() {
    const my = life;
    lastCallback = 0;
    if (typeof preview.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        if (my !== life || !running) return;
        rvfcId = preview.requestVideoFrameCallback(onFrame);
        const at = performance.now();
        lastCallback = at;
        camTimes.push(at);
        offer(at);
      };
      rvfcId = preview.requestVideoFrameCallback(onFrame);
    }
    // The backup: takes frames on its own only while no callback has come
    // for a while (or ever, where the callback does not exist).
    tick = setInterval(() => {
      if (my !== life || !running) return;
      const at = performance.now();
      const quiet = Math.max(STALE_MS, 3000 / cur.fps);
      if (at - lastCallback > quiet) offer(at);
    }, TICK_MS);
  }

  // A camera frame is here. Keep it only if it is time for the next one.
  function offer(at) {
    const iv = 1000 / cur.fps;
    if (at < due - iv * EARLY) return;
    due = at - due > iv ? at + iv : due + iv;
    take();
  }

  function take() {
    const vw = preview.videoWidth, vh = preview.videoHeight;
    if (!vw || !vh || preview.readyState < 2) return;
    if (vw !== shapeW || vh !== shapeH) {   // the camera changed shape (a phone turned)
      shapeW = vw; shapeH = vh;
      sync();
      return;
    }
    if (!encoder || encoder.state !== 'configured' || !active) return;
    const size = sendSize(cur, shapeW, shapeH);
    if (size.width !== active.width || size.height !== active.height) return;   // a new encoder is on its way
    if (encoder.encodeQueueSize > MAX_QUEUE) { dropped++; return; }

    const t = clock();
    const ts = Math.max(lastTs + 1, Math.round(performance.now() * 1000));
    lastTs = ts;
    const frame = grab(ts, active.width, active.height);
    if (!frame) return;

    const at = performance.now();
    const keyEveryMs = cur.keyEvery * 1000;
    const key = keyWanted || at - Math.max(lastKeyAsked, lastKeyOut) >= keyEveryMs;
    inFlight.set(ts, { t, at, width: active.width, height: active.height, codec: active.codec, fps: active.fps });
    try {
      encoder.encode(frame, { keyFrame: key });
      if (key) { keyWanted = false; lastKeyAsked = at; }
    } catch (e) {
      inFlight.delete(ts);
    } finally {
      frame.close();
    }
  }

  // The camera's current frame as a VideoFrame of exactly w × h, or null.
  function grab(ts, w, h) {
    if (direct && preview.videoWidth === w && preview.videoHeight === h) {
      let f = null;
      try {
        f = new VideoFrame(preview, { timestamp: ts });
        directFails = 0;
      } catch (e) {
        if (++directFails >= DIRECT_TRIES) direct = false;
      }
      if (f) {
        const vis = f.visibleRect;
        const fits = f.displayWidth === w && f.displayHeight === h &&
          (!vis || (vis.width === w && vis.height === h)) && !f.rotation && !f.flip;
        if (fits) return f;
        f.close();
        direct = false;   // this camera's frames need turning or scaling: the canvas from now on
      }
    }
    return fromCanvas(ts, w, h);
  }

  function fromCanvas(ts, w, h) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        if (!ctx) makeCanvas(w, h);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(preview, 0, 0, w, h);
        return new VideoFrame(canvas, { timestamp: ts });
      } catch (e) {
        // An OffscreenCanvas this browser will not make a frame from: one
        // more go with a canvas on the page, and that one stays.
        if (canvasOnPage) return null;
        canvasOnPage = true;
        canvas = null; ctx = null;
      }
    }
    return null;
  }

  function makeCanvas(w, h) {
    if (!canvasOnPage && typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(w, h);
    } else {
      canvasOnPage = true;
      canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
    }
    ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('no 2d canvas');
  }

  // ------------------------------------------------------------ packets

  function onChunk(mine, chunk, meta) {
    if (mine !== gen) return;
    const at = performance.now();
    if (meta && meta.decoderConfig) {
      const d = meta.decoderConfig.description;
      desc = d ? copyBytes(d) : null;
    }
    const ts = chunk.timestamp;
    const info = inFlight.get(ts) || {
      t: clock(), at, width: active ? active.width : 0, height: active ? active.height : 0,
      codec: active ? active.codec : cur.codec, fps: active ? active.fps : cur.fps
    };
    // This one and anything older (frames the encoder chose to skip) are done.
    for (const k of inFlight.keys()) {
      if (k > ts) break;
      inFlight.delete(k);
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    const packet = pack({
      kind: KIND_VIDEO, key, seq, t: info.t,
      width: info.width, height: info.height, codec: info.codec, fps: info.fps
    }, data, key && desc ? desc : null);
    seq = (seq + 1) >>> 0;

    let ok;
    try { ok = post(packet) !== false; } catch (e) { ok = false; }
    if (key) { keyframes++; lastKeyOut = at; }
    if (!ok) { refused++; keyWanted = true; }
    outs.push({ at, bytes: ok ? packet.byteLength : 0, sent: ok, encodeMs: at - info.at });
    trim(at);
  }

  // ------------------------------------------------------------ stats

  function trim(at) {
    const since = at - WINDOW_MS;
    let i = 0;
    while (i < outs.length && outs[i].at < since) i++;
    if (i) outs = outs.slice(i);
    let j = 0;
    while (j < camTimes.length && camTimes[j] < since) j++;
    if (j) camTimes = camTimes.slice(j);
  }

  function stats() {
    const at = performance.now();
    trim(at);
    let frames = 0, bytes = 0, enc = 0;
    for (const o of outs) {
      if (o.sent) { frames++; bytes += o.bytes; }
      enc += o.encodeMs;
    }
    const track = stream && stream.getVideoTracks()[0];
    const got = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
    const callbacksLive = lastCallback && at - lastCallback < WINDOW_MS;
    const entry = active ? codecById(active.codec) : null;
    return {
      fps: running ? frames * 1000 / WINDOW_MS : null,
      kbps: running ? bytes * 8 / WINDOW_MS : null,
      width: active ? active.width : null,
      height: active ? active.height : null,
      codec: entry ? entry.name : null,
      encodeMs: outs.length ? enc / outs.length : null,
      keyframes: everStarted ? keyframes : null,
      dropped: everStarted ? dropped : null,
      refused: everStarted ? refused : null,
      cameraWidth: preview.videoWidth || got.width || null,
      cameraHeight: preview.videoHeight || got.height || null,
      cameraFps: !running ? null
        : callbacksLive ? camTimes.length * 1000 / WINDOW_MS
        : (got.frameRate || null)
    };
  }

  return {
    preview,
    start,
    stop,
    apply,
    forceKey() { keyWanted = true; },
    stats,
    get running() { return running; }
  };
}

// ------------------------------------------------------------ helpers

// Settings made whole and sensible, anything missing kept from `prev`.
function settle(s, prev) {
  s = s || {};
  const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
  const codec = codecById(Number(s.codec)) ? Number(s.codec) : prev.codec;
  return {
    width: even(num(s.width, prev.width)),
    height: even(num(s.height, prev.height)),
    fps: Math.min(MAX_FPS, Math.max(1, num(s.fps, prev.fps))),
    bitrate: Math.max(MIN_BITRATE, Math.round(num(s.bitrate, prev.bitrate))),
    codec,
    keyEvery: num(s.keyEvery, prev.keyEvery)
  };
}

function same(a, b) {
  return a.width === b.width && a.height === b.height && a.fps === b.fps &&
    a.bitrate === b.bitrate && a.codec === b.codec && a.keyEvery === b.keyEvery;
}

function even(x) {
  return Math.max(MIN_SIDE, 2 * Math.round(x / 2));
}

// The width asked for, and the height that keeps the camera's shape.
function sendSize(s, camW, camH) {
  const width = even(s.width);
  const height = camW > 0 && camH > 0 ? even(width * camH / camW) : even(s.height);
  return { width, height };
}

function encoderConfig(entry, width, height, s) {
  return {
    codec: entry.codec,
    width,
    height,
    bitrate: s.bitrate,
    framerate: s.fps,
    latencyMode: 'realtime',
    ...entry.encoder
  };
}

function cameraAsk(s) {
  return {
    facingMode: 'user',
    width: { ideal: s.width },
    height: { ideal: s.height },
    frameRate: { ideal: s.fps }
  };
}

function cameraTrouble(e) {
  const name = (e && e.name) || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'camera permission was not given';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no camera was found';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'the camera is busy in another app or tab';
  return 'the camera could not start' + reason(e);
}

function reason(e) {
  const m = e && (e.message || e.name);
  return m ? ` (${m})` : '';
}

function stopTracks(s) {
  if (!s) return;
  for (const t of s.getTracks()) {
    try { t.stop(); } catch (e) { /* already stopped */ }
  }
}

function copyBytes(d) {
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  return new Uint8Array(d.slice(0));
}

// Resolves true once the video knows its picture size, false after `ms`.
function whenSized(video, ms) {
  return new Promise(resolve => {
    if (video.videoWidth > 0 && video.readyState >= 2) { resolve(true); return; }
    let timer = null;
    const check = () => { if (video.videoWidth > 0 && video.readyState >= 2) done(true); };
    const done = ok => {
      clearTimeout(timer);
      for (const ev of ['loadeddata', 'loadedmetadata', 'resize', 'playing']) video.removeEventListener(ev, check);
      resolve(ok);
    };
    timer = setTimeout(() => done(video.videoWidth > 0), ms);
    for (const ev of ['loadeddata', 'loadedmetadata', 'resize', 'playing']) video.addEventListener(ev, check);
  });
}

// Resolves at the video's next change of picture size, or after `ms`.
function whenResized(video, ms) {
  return new Promise(resolve => {
    let timer = null;
    const done = () => { clearTimeout(timer); video.removeEventListener('resize', done); resolve(); };
    timer = setTimeout(done, ms);
    video.addEventListener('resize', done);
  });
}
