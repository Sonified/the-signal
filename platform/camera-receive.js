// Live Video's receiver, on a follower page only: the presenter's packets
// from the video relay (platform/camera-relay.js), unpacked with WebCodecs
// and drawn onto a small canvas, whose canvas.captureStream() is handed to
// the panel once the first picture is on it. The essentials of
// video-broadcast-testing/js/receive.js: a decoder configured from each full
// picture (its format, size and the description it carries), deltas fed in
// order, and on a gap in the sequence, a decoder fallen behind or a failed
// decode, a wait for the next full picture, asked of the sender at most
// once a second ({t:'key', to: sender}, the test relay's request). Only the
// newest sender is shown: a full picture from anyone else takes over.
//
// Everything fails soft: no WebCodecs or no captureStream is one console
// warning and no panel; a decoder that will not configure or stops waits
// for the next full picture. Nothing runs inside the engine's frame.
import { unpack, KIND_VIDEO, codecById } from './camera-wire.js';
import { relayConnect } from './camera-relay.js';

const BEHIND = 5;          // decodes queued before the backlog is dropped
const ASK_EVERY_MS = 1000;

let warned = false;
function warn(text, e) {
  if (warned) return;
  warned = true;
  console.warn('live video: ' + text + (e && (e.message || e.name) ? ' (' + (e.message || e.name) + ')' : ''), e || '');
}

export function canReceive() {
  if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') return false;
  try { return typeof document !== 'undefined' && typeof document.createElement('canvas').captureStream === 'function'; }
  catch (e) { return false; }
}

// Starts watching room; onStream(stream) once the first picture is drawn.
// Returns { stop() }. Never throws.
export function startReceiver(room, onStream) {
  let stopped = false, net = null, dec = null, sig = '';
  let from = -1, expect = -1, waiting = true, askedAt = 0, t0 = NaN, lastTs = -1;
  let canvas = null, ctx = null, stream = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (net) net.close();
    net = null;
    closeDecoder();
    if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch (e) {} } }
    stream = null;
  };
  const handle = { stop };
  if (!canReceive()) { warn('this browser cannot unpack video (no WebCodecs or canvas capture); the camera panel stays hidden'); return handle; }

  function closeDecoder() {
    if (dec && dec.state !== 'closed') { try { dec.close(); } catch (e) {} }
    dec = null; sig = '';
  }
  function ask() {
    const now = Date.now();
    if (!net || now - askedAt < ASK_EVERY_MS) return;
    askedAt = now;
    // before any packet, whoever sends: the sender takes a key with no `to`
    net.sendJSON(from >= 0 ? { t: 'key', to: from } : { t: 'key' });
  }
  function broke() { waiting = true; ask(); }

  function draw(frame) {
    try {
      if (stopped) return;
      const w = frame.displayWidth, h = frame.displayHeight;
      if (!canvas) {
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d', { alpha: false });
      }
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.drawImage(frame, 0, 0, w, h);
      if (!stream) {
        stream = canvas.captureStream();
        try { onStream(stream); } catch (e) { console.warn('live video: the panel would not take the stream', e); }
      }
    } catch (e) {
      warn('a camera picture could not be drawn', e);
    } finally {
      frame.close();
    }
  }

  function configure(p) {
    const fmt = codecById(p.codec);
    if (!fmt) return false;
    const key = p.codec + '|' + p.width + 'x' + p.height + '|' + (p.desc ? Array.prototype.join.call(p.desc, ',') : '');
    if (dec && dec.state === 'configured' && key === sig) return true;
    closeDecoder();
    try {
      const d = new VideoDecoder({
        output: frame => { if (d === dec) draw(frame); else frame.close(); },
        error: e => { if (d !== dec) return; warn('unpacking the camera stopped; waiting for the next full picture', e); dec = null; sig = ''; broke(); }
      });
      const cfg = { codec: fmt.codec, codedWidth: p.width, codedHeight: p.height, optimizeForLatency: true };
      if (p.desc) cfg.description = p.desc.slice();
      d.configure(cfg);
      dec = d; sig = key;
      return true;
    } catch (e) {
      warn('this browser would not unpack ' + fmt.name + ' at ' + p.width + 'x' + p.height, e);
      closeDecoder();
      return false;
    }
  }

  function onPacket(buf) {
    try {
      if (stopped) return;
      const p = unpack(buf);
      if (!p || p.kind !== KIND_VIDEO) return;
      if (p.from !== from) {
        // someone else's: only their full picture takes over
        if (!p.key) return;
        from = p.from; expect = -1; t0 = NaN; lastTs = -1; closeDecoder();
      }
      if (expect >= 0 && p.seq !== expect) broke();
      expect = (p.seq + 1) >>> 0;
      if (p.key) {
        if (!configure(p)) { broke(); return; }
        waiting = false;
      } else if (waiting || !dec) { ask(); return; }
      if (dec.decodeQueueSize > BEHIND) {
        closeDecoder();
        broke();
        if (!p.key || !configure(p)) return;
        waiting = false;
      }
      if (Number.isNaN(t0)) t0 = p.t;
      let ts = Math.round((p.t - t0) * 1000);
      if (!(ts > lastTs)) ts = lastTs + 1;
      lastTs = ts;
      dec.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: ts, data: p.data }));
    } catch (e) {
      warn('a camera picture could not be unpacked; waiting for the next full picture', e);
      closeDecoder();
      broke();
    }
  }

  net = relayConnect(room, {
    onPacket,
    onHello() { if (waiting) { askedAt = 0; ask(); } },
    onPeer(id, on) { if (!on && id === from) { waiting = true; } },
    onMessage() {}
  });
  console.log('[live video] watching room "' + room + '"');
  return handle;
}
