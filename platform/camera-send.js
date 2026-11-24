// Live Video's sender, on the presenting page only: the camera stream the
// panel already shows, packed small once with WebCodecs and sent through the
// video relay (platform/camera-relay.js) one packet per frame, whatever the
// number of viewers. The essentials of video-broadcast-testing/js/
// capture.js: a hidden <video> plays the stream, a timer takes a frame at
// the sending rate, a canvas scales it to the sending size (the camera's own
// shape kept), the encoder packs it, and every full picture carries the
// decoder's description so a viewer can start at any of them. A full picture
// goes out every KEY_EVERY_MS, and at once when someone joins the room or a
// viewer asks ({t:'key', to: me}, the test relay's keyframe request).
//
// Everything fails soft: no WebCodecs, no format this browser can encode, or
// an encoder that stops, is one console warning and nothing sent; the
// panel on this page is untouched either way. Nothing here runs inside the
// engine's frame: it is all timers and the encoder's own callbacks.
import { pack, KIND_VIDEO, CODECS } from './camera-wire.js';
import { relayConnect } from './camera-relay.js';

const WIDTH = 640, HEIGHT = 360, FPS = 15, BITRATE = 500000, KEY_EVERY_MS = 2000;
const MAX_QUEUE = 2;     // frames waiting in the encoder before one is skipped

const even = x => Math.max(2, 2 * Math.round(x / 2));
let warned = false;
function warn(text, e) {
  if (warned) return;
  warned = true;
  console.warn('live video: ' + text + (e && (e.message || e.name) ? ' (' + (e.message || e.name) + ')' : ''), e || '');
}

export function canSend() {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

async function pickCodec(width, height) {
  for (const c of CODECS) {
    const config = { codec: c.codec, width, height, bitrate: BITRATE, framerate: FPS, latencyMode: 'realtime', ...c.encoder };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r && r.supported) return { entry: c, config };
    } catch (e) {}
  }
  return null;
}

// Starts sending stream to room; returns { stop() }. Never throws.
export function startSender(stream, room) {
  let stopped = false, net = null, encoder = null, timer = null, video = null;
  let canvas = null, ctx = null, active = null, desc = null;
  let seq = 0, lastKey = 0, keyWanted = true, lastTs = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer); timer = null;
    if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch (e) {} }
    encoder = null;
    if (net) net.close();
    net = null;
    if (video) { try { video.pause(); video.srcObject = null; } catch (e) {} }
    video = null;
  };
  const handle = { stop };
  if (!canSend()) { warn('this browser cannot pack video (no WebCodecs); viewers will not see the camera'); return handle; }

  (async () => {
    try {
      video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.autoplay = true;
      video.srcObject = stream;
      try { await video.play(); } catch (e) {}
      // the camera's shape, once it is known
      for (let i = 0; i < 50 && !stopped && !(video.videoWidth > 0); i++) await new Promise(r => setTimeout(r, 100));
      if (stopped) return;
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
      const width = vw >= vh ? WIDTH : even(HEIGHT * vw / vh);
      const height = vw >= vh ? even(WIDTH * vh / vw) : WIDTH;
      const pick = await pickCodec(width, height);
      if (stopped) return;
      if (!pick) { warn('this browser can pack none of H.264, VP8 or VP9 at ' + width + 'x' + height + '; viewers will not see the camera'); stop(); return; }
      active = { codec: pick.entry.id, width, height };
      encoder = new VideoEncoder({
        output: (chunk, meta) => { try { onChunk(chunk, meta); } catch (e) { warn('a packed frame could not be sent', e); } },
        error: e => { warn('packing the camera stopped; viewers will not see it until Live Video is switched off and on', e); stop(); }
      });
      encoder.configure(pick.config);
      canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
      ctx = canvas.getContext('2d', { alpha: false });
      net = relayConnect(room, {
        onHello() { keyWanted = true; },
        onPeer(id, on) { if (on) keyWanted = true; },
        onMessage(msg) { if (msg.t === 'key' && (msg.to == null || (net && msg.to === net.id))) keyWanted = true; },
        onPacket() {}
      });
      timer = setInterval(take, Math.round(1000 / FPS));
      console.log('[live video] sending ' + pick.entry.name + ' ' + width + 'x' + height + ' to room "' + room + '"');
    } catch (e) {
      warn('the camera could not be sent', e);
      stop();
    }
  })();

  function take() {
    try {
      if (stopped || !encoder || encoder.state !== 'configured' || !net || !net.open) return;
      if (!video || video.readyState < 2 || !(video.videoWidth > 0)) return;
      if (encoder.encodeQueueSize > MAX_QUEUE) return;
      ctx.drawImage(video, 0, 0, active.width, active.height);
      const now = performance.now();
      const ts = Math.max(lastTs + 1, Math.round(now * 1000));
      lastTs = ts;
      const frame = new VideoFrame(canvas, { timestamp: ts });
      const key = keyWanted || now - lastKey >= KEY_EVERY_MS;
      try {
        encoder.encode(frame, { keyFrame: key });
        if (key) { keyWanted = false; lastKey = now; }
      } finally {
        frame.close();
      }
    } catch (e) {
      warn('a camera frame could not be packed', e);
    }
  }

  function onChunk(chunk, meta) {
    if (stopped || !net) return;
    if (meta && meta.decoderConfig && meta.decoderConfig.description) {
      const d = meta.decoderConfig.description;
      desc = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Uint8Array(d.slice(0));
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    const packet = pack({ kind: KIND_VIDEO, key, seq, t: Date.now(), width: active.width, height: active.height, codec: active.codec, fps: FPS },
                        data, key && desc ? desc : null);
    seq = (seq + 1) >>> 0;
    // a refused packet (the link too slow) breaks the chain: the next is a full picture
    if (!net.send(packet)) keyWanted = true;
  }

  return handle;
}
