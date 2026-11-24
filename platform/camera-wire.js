// Live Video's packet: one binary WebSocket message per encoded camera
// frame, the very shape the video broadcast test's relay carries
// (video-broadcast-testing/js/wire.js, copied here so the test can change
// without touching a show). The relay never reads the picture; it writes the
// sender's id into the header and passes the message on.
//
// Header, little-endian:
//    0  u8   kind      1 video
//    1  u8   flags     bit 0: a full picture (a keyframe), decodable alone
//    2  u16  from      the sender's id; a sender writes 0, the relay fills it
//    4  u32  seq       counts up by one per packet, per sender
//    8  f64  t         when the frame was captured, ms
//   16  u16  width     the encoded picture's width
//   18  u16  height    and height
//   20  u8   codec     an id from CODECS below
//   21  u8   fps       the rate the sender is aiming for
//   22  u16  descLen   bytes of decoder description that follow the header
//   24  ...  the description (descLen bytes), then the encoded frame
//
// The description (H.264 needs one) rides on every full picture, so a viewer
// who joins late starts at the next full picture with no handshake.

export const HEADER = 24;
export const KIND_VIDEO = 1;
export const FLAG_KEY = 1;

// By wire id, as the test numbers them. H.264 first, VP8 the fallback.
export const CODECS = [
  { id: 0, name: 'H.264', codec: 'avc1.42E01F', encoder: { avc: { format: 'avc' } } },
  { id: 1, name: 'VP8', codec: 'vp8', encoder: {} },
  { id: 2, name: 'VP9', codec: 'vp09.00.10.08', encoder: {} }
];
export const codecById = id => CODECS.find(c => c.id === id) || null;

function bytes(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return new Uint8Array(x);
}

// One packet as an ArrayBuffer. desc may be absent.
export function pack(h, data, desc) {
  const body = bytes(data);
  const d = desc ? bytes(desc) : null;
  const dl = d ? d.byteLength : 0;
  const out = new Uint8Array(HEADER + dl + body.byteLength);
  const v = new DataView(out.buffer);
  v.setUint8(0, h.kind || KIND_VIDEO);
  v.setUint8(1, h.key ? FLAG_KEY : 0);
  v.setUint16(2, 0, true);
  v.setUint32(4, h.seq >>> 0, true);
  v.setFloat64(8, +h.t || 0, true);
  v.setUint16(16, h.width | 0, true);
  v.setUint16(18, h.height | 0, true);
  v.setUint8(20, h.codec | 0);
  v.setUint8(21, Math.max(0, Math.min(255, Math.round(h.fps || 0))));
  v.setUint16(22, dl, true);
  if (d) out.set(d, HEADER);
  out.set(body, HEADER + dl);
  return out.buffer;
}

// One arriving packet read, or null for anything too short or malformed.
// desc and data are views into the same buffer.
export function unpack(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER) return null;
  const v = new DataView(buf);
  const dl = v.getUint16(22, true);
  if (HEADER + dl > buf.byteLength) return null;
  return {
    kind: v.getUint8(0),
    key: (v.getUint8(1) & FLAG_KEY) !== 0,
    from: v.getUint16(2, true),
    seq: v.getUint32(4, true),
    t: v.getFloat64(8, true),
    width: v.getUint16(16, true),
    height: v.getUint16(18, true),
    codec: v.getUint8(20),
    fps: v.getUint8(21),
    desc: dl ? new Uint8Array(buf, HEADER, dl) : null,
    data: new Uint8Array(buf, HEADER + dl)
  };
}
