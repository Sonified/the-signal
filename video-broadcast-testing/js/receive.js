// Packets in, pictures out: one WebCodecs VideoDecoder per sender.
//
// Every sender's packets arrive in order (the socket is TCP), but a sender
// sometimes has a packet refused before it leaves, which shows here as a
// jump in `seq`, and then its next packet is a full picture. So a sender's
// stream is either flowing or waiting: it flows from a full picture on, and
// anything that breaks it (a jump in `seq`, the decoder failing, the decoder
// falling behind) sets it waiting again until the next full picture. While
// it waits the receiver asks for one through `onNeedKey`, at most once a
// second, and throws its packets away.
//
// The receiver owns the decoded pictures. Each sender keeps only its newest
// VideoFrame; a newer one closes the one before. The 3D view reads `frame`
// inside its animation frame and never closes it.
//
// Delay is the number the whole test is about: from the camera taking the
// picture on the sender (`t`, on the room's shared clock) to the picture
// being ready to draw here (the decoder's output, read on the same clock).
// Each chunk's timestamp is the key to a small note of when its picture was
// taken, when it arrived and when it went into the decoder, so the output
// can be measured. The timestamp is the capture time in microseconds since
// that sender's first packet, nudged up where needed so it always grows.

import { KIND_VIDEO, CODECS, codecById } from './wire.js';

const WINDOW = 1000;        // ms of history the stats look back over
const BEHIND = 5;           // decodeQueueSize above this means falling behind
const ASK_EVERY = 1000;     // ms between requests for a full picture
const NOTES = 120;          // timestamp notes kept at most, per sender
const HOLD = 60;            // packets held at most while a format is checked

const NO_DECODER = 'this browser cannot show video sent this way';

export function createReceiver({ now, onNeedKey } = {}) {
  const roomNow = typeof now === 'function' ? now : () => Date.now();
  const hereNow = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();
  const canDecode = typeof globalThis.VideoDecoder === 'function' &&
    typeof globalThis.EncodedVideoChunk === 'function';

  const senders = new Map();      // id -> sender state
  const list = [];                // the panels, ordered by id, same array always
  const support = new Map();      // format key -> { ok, reason } or a Promise of one
  let closed = false;

  function add(id) {
    const panel = { id, frame: null, version: 0, width: null, height: null };
    const s = {
      id, panel,
      decoder: null,
      cfg: null, sig: null,       // what the decoder is configured with
      bad: null,                  // a format this device cannot decode
      pending: null,              // a format being checked, and packets held for it
      token: 0,
      waiting: true,
      seq: null,
      askedAt: -Infinity,
      t0: null, lastTs: -1,
      notes: new Map(),           // chunk timestamp -> { t, arrivedAt, fedAt, size }
      arrivals: [],               // { at, size } within the window
      outputs: [],                // { at, delay, decode } within the window
      decoded: 0, keyframes: 0, gaps: 0,
      delayLast: null,
      codecName: null,
      error: canDecode ? null : NO_DECODER,
      errorKind: canDecode ? null : 'browser',
      dead: false
    };
    senders.set(id, s);
    let i = list.length;
    while (i > 0 && list[i - 1].id > id) i--;
    list.splice(i, 0, panel);
    return s;
  }

  function push(p) {
    if (closed || !p || p.kind !== KIND_VIDEO) return;
    const s = senders.get(p.from) || add(p.from);
    const at = hereNow();
    s.arrivals.push({ at, size: p.size || p.data.byteLength });
    trim(s, at);

    const fmt = codecById(p.codec);
    s.codecName = fmt ? fmt.name : `format ${p.codec}`;
    if (p.key) s.keyframes++;
    if (p.key && !s.panel.frame) { s.panel.width = p.width; s.panel.height = p.height; }

    const expected = s.seq === null ? null : (s.seq + 1) >>> 0;
    s.seq = p.seq >>> 0;
    if (expected !== null && s.seq !== expected && !s.waiting) breaks(s, !p.key);

    if (!canDecode) return;
    if (p.key) return key(s, p, fmt, at);
    if (s.waiting) return ask(s);
    if (s.pending) return hold(s, p, at);
    feed(s, p, at);
  }

  // A full picture: start, restart or carry on, configuring first if the
  // format, size or description differs from what the decoder holds.
  function key(s, p, fmt, at) {
    const sig = signature(p);
    if (s.bad && same(s.bad, sig)) { s.waiting = true; return; }
    if (s.bad) { s.bad = null; clearError(s, 'format'); }
    if (!fmt) return unsupported(s, sig, `this test does not know picture format ${p.codec}`);

    if (s.decoder && s.decoder.state === 'configured' && s.sig && same(s.sig, sig)) {
      s.pending = null;
      s.waiting = false;
      feed(s, p, at);
      return;
    }

    const cfg = { codec: fmt.codec, codedWidth: p.width, codedHeight: p.height, optimizeForLatency: true };
    if (sig.desc) cfg.description = sig.desc;
    const answer = supported(cfg);
    s.waiting = false;
    if (answer instanceof Promise) {
      const token = ++s.token;
      s.pending = { token, cfg, sig, packets: [] };
      hold(s, p, at);
      answer.then(a => settle(s, token, a));
      return;
    }
    s.pending = null;
    if (!answer.ok) return unsupported(s, sig, answer.reason);
    if (configure(s, cfg, sig)) feed(s, p, at);
  }

  // Whether this device can decode a format, asked once per format and size.
  function supported(cfg) {
    const k = `${cfg.codec}|${cfg.codedWidth}x${cfg.codedHeight}|${cfg.description ? 'd' : '-'}`;
    const known = support.get(k);
    if (known) return known;
    const name = nameOf(cfg.codec);
    const no = `this device cannot show ${name} pictures at ${cfg.codedWidth}x${cfg.codedHeight}`;
    if (typeof VideoDecoder.isConfigSupported !== 'function') {
      const yes = { ok: true };
      support.set(k, yes);
      return yes;
    }
    let check;
    try { check = VideoDecoder.isConfigSupported(cfg); }
    catch (e) { check = Promise.reject(e); }
    const promise = Promise.resolve(check).then(
      r => (r && r.supported) ? { ok: true } : { ok: false, reason: no },
      e => ({ ok: false, reason: `${no} (${plain(e)})` })
    ).then(a => { support.set(k, a); return a; });
    support.set(k, promise);
    return promise;
  }

  // The format check came back: configure and feed what was held, or give up
  // on this format until the sender changes it.
  function settle(s, token, a) {
    if (closed || s.dead || !s.pending || s.pending.token !== token) return;
    const { cfg, sig, packets } = s.pending;
    s.pending = null;
    if (!a.ok) return unsupported(s, sig, a.reason);
    if (!configure(s, cfg, sig)) return;
    for (const q of packets) if (!feed(s, q, q.arrivedAt)) break;
  }

  // Packets that come while a format is being checked wait in a short line;
  // their bytes are copied, as the packet's views point into the socket's.
  function hold(s, p, at) {
    const line = s.pending.packets;
    if (line.length >= HOLD) {
      s.pending = null;
      return breaks(s, true);
    }
    line.push({
      key: p.key, t: p.t, size: p.size, arrivedAt: at,
      data: p.data.slice()
    });
  }

  function configure(s, cfg, sig) {
    try {
      if (!s.decoder || s.decoder.state === 'closed') s.decoder = decoderFor(s);
      s.decoder.configure(cfg);
      s.cfg = cfg;
      s.sig = sig;
      clearError(s, 'decode');
      return true;
    } catch (e) {
      s.cfg = null;
      s.sig = null;
      unsupported(s, sig, `the ${nameOf(cfg.codec)} decoder would not start (${plain(e)})`);
      return false;
    }
  }

  function decoderFor(s) {
    const dec = new VideoDecoder({
      output: frame => shown(s, dec, frame),
      error: e => failed(s, dec, e)
    });
    return dec;
  }

  // Hand one packet to the decoder. Returns false when the stream broke.
  function feed(s, p, at) {
    let dec = s.decoder;
    if (!dec || dec.state !== 'configured') { breaks(s, !p.key); return false; }
    if (dec.decodeQueueSize > BEHIND) {
      // Behind: drop the decoder's backlog. A full picture can go straight
      // into the fresh decoder; anything else has to wait for one.
      const cfg = s.cfg, sig = s.sig;
      reset(s);
      breaks(s, !p.key);
      if (!p.key || !configure(s, cfg, sig)) return false;
      s.waiting = false;
      dec = s.decoder;
    }
    const ts = stamp(s, p.t);
    s.notes.set(ts, { t: p.t, arrivedAt: at, fedAt: hereNow(), size: p.size });
    if (s.notes.size > NOTES) s.notes.delete(s.notes.keys().next().value);
    try {
      dec.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: ts, data: p.data }));
      return true;
    } catch (e) {
      s.notes.delete(ts);
      setError(s, 'decode', `a picture could not be unpacked (${plain(e)})`);
      reset(s);
      breaks(s, true);
      return false;
    }
  }

  // A capture time turned into a chunk timestamp: microseconds since this
  // sender's first packet, always larger than the one before.
  function stamp(s, t) {
    if (s.t0 === null && Number.isFinite(t)) s.t0 = t;
    let ts = Number.isFinite(t) ? Math.round((t - s.t0) * 1000) : s.lastTs + 1;
    if (ts <= s.lastTs) ts = s.lastTs + 1;
    s.lastTs = ts;
    return ts;
  }

  // A decoded picture: measure it, then make it the sender's newest.
  function shown(s, dec, frame) {
    if (closed || s.dead || s.decoder !== dec) { frame.close(); return; }
    const at = hereNow();
    const note = noteFor(s, frame.timestamp);
    const delay = note && Number.isFinite(note.t) ? roomNow() - note.t : null;
    const decode = note ? at - note.fedAt : null;
    if (delay !== null) s.delayLast = delay;
    s.outputs.push({ at, delay, decode });
    s.decoded++;
    trim(s, at);
    clearError(s, 'decode');

    const panel = s.panel;
    if (panel.frame) panel.frame.close();
    panel.frame = frame;
    panel.version++;
    panel.width = frame.displayWidth;
    panel.height = frame.displayHeight;
  }

  // The note for a picture, found by its timestamp. Notes older than it are
  // for pictures the decoder never gave back, and go. Should a browser not
  // hand the timestamp back unchanged, the oldest note stands in for it, as
  // these streams never reorder.
  function noteFor(s, ts) {
    let note = s.notes.get(ts);
    if (note) {
      for (const k of s.notes.keys()) {
        if (k >= ts) break;
        s.notes.delete(k);
      }
      s.notes.delete(ts);
      return note;
    }
    const first = s.notes.keys().next();
    if (first.done) return null;
    note = s.notes.get(first.value);
    s.notes.delete(first.value);
    return note;
  }

  // The decoder hit an error and has closed itself; a new one starts at the
  // next full picture.
  function failed(s, dec, e) {
    if (closed || s.dead || s.decoder !== dec) return;
    s.decoder = null;
    s.cfg = null;
    s.sig = null;
    s.notes.clear();
    setError(s, 'decode', `unpacking pictures stopped (${plain(e)})`);
    breaks(s, true);
  }

  function reset(s) {
    const dec = s.decoder;
    if (dec && dec.state !== 'closed') {
      try { dec.reset(); } catch (e) { try { dec.close(); } catch (_) {} s.decoder = null; }
    }
    s.cfg = null;
    s.sig = null;
    s.notes.clear();
  }

  // The stream cannot go on until a full picture: count it once, wait, and
  // ask (unless the packet in hand is that full picture).
  function breaks(s, needAsk) {
    if (!s.waiting) { s.gaps++; s.waiting = true; }
    if (needAsk) ask(s);
  }

  function ask(s) {
    if (closed || s.dead || s.bad || !canDecode) return;
    const at = hereNow();
    if (at - s.askedAt < ASK_EVERY) return;
    s.askedAt = at;
    if (typeof onNeedKey === 'function') {
      try { onNeedKey(s.id); } catch (e) { console.warn('receive: onNeedKey threw', e); }
    }
  }

  function unsupported(s, sig, reason) {
    s.bad = sig;
    s.waiting = true;
    s.pending = null;
    setError(s, 'format', reason);
  }

  function setError(s, kind, text) { s.error = text; s.errorKind = kind; }
  function clearError(s, kind) {
    if (s.errorKind === kind) { s.error = null; s.errorKind = null; }
  }

  function trim(s, at) {
    const since = at - WINDOW;
    while (s.arrivals.length && s.arrivals[0].at < since) s.arrivals.shift();
    while (s.outputs.length && s.outputs[0].at < since) s.outputs.shift();
  }

  function drop(id) {
    const s = senders.get(id);
    if (!s) return;
    s.dead = true;
    s.pending = null;
    if (s.decoder && s.decoder.state !== 'closed') {
      try { s.decoder.close(); } catch (_) {}
    }
    s.decoder = null;
    s.notes.clear();
    if (s.panel.frame) { s.panel.frame.close(); s.panel.frame = null; }
    senders.delete(id);
    const i = list.indexOf(s.panel);
    if (i >= 0) list.splice(i, 1);
  }

  function panels() { return list; }

  function stats(id) {
    const s = senders.get(id);
    if (!s) return null;
    const at = hereNow();
    trim(s, at);
    let bytes = 0;
    for (const a of s.arrivals) bytes += a.size;
    let dSum = 0, dN = 0, dMax = null, cSum = 0, cN = 0;
    for (const o of s.outputs) {
      if (o.delay !== null) {
        dSum += o.delay; dN++;
        if (dMax === null || o.delay > dMax) dMax = o.delay;
      }
      if (o.decode !== null) { cSum += o.decode; cN++; }
    }
    const span = WINDOW / 1000;
    return {
      fps: s.decoded ? s.outputs.length / span : null,
      kbps: bytes * 8 / 1000 / span,
      width: s.panel.width,
      height: s.panel.height,
      codec: s.codecName,
      delayMs: dN ? dSum / dN : null,
      delayMaxMs: dMax,
      delayLastMs: s.delayLast,
      decodeMs: cN ? cSum / cN : null,
      keyframes: s.keyframes,
      gaps: s.gaps,
      queue: s.decoder && s.decoder.state !== 'closed' ? s.decoder.decodeQueueSize : null,
      error: s.error
    };
  }

  function close() {
    for (const id of [...senders.keys()]) drop(id);
    closed = true;
  }

  return { push, drop, panels, stats, close };
}

// What a full picture asks of the decoder; the description is copied.
function signature(p) {
  return {
    codec: p.codec,
    width: p.width,
    height: p.height,
    desc: p.desc && p.desc.byteLength ? new Uint8Array(p.desc) : null
  };
}

function same(a, b) {
  if (a.codec !== b.codec || a.width !== b.width || a.height !== b.height) return false;
  if (!a.desc || !b.desc) return !a.desc && !b.desc;
  if (a.desc.byteLength !== b.desc.byteLength) return false;
  for (let i = 0; i < a.desc.byteLength; i++) if (a.desc[i] !== b.desc[i]) return false;
  return true;
}

function nameOf(codec) {
  const c = CODECS.find(x => x.codec === codec);
  return c ? c.name : codec;
}

function plain(e) {
  return (e && (e.message || e.name)) || String(e);
}
