// Shared by the C2 tests: loads the C2 modules, decodes the command bytes
// they send, and stands in for the engine (C1), the shadow and the clock.
//
//   const h = await load();
//   const { engine, clock, shadow, ctx } = h.rig({ stages: 3, homes: { music: 1, clouds: 2 } });
//   ctx.island('music').createGain() ...
//   h.sent(engine)  -> [{ stage, op, node, ...fields }] in send order
import { readFileSync } from 'node:fs';
import { Commands } from '../../js/heart/protocol-gen.js';

const P = JSON.parse(readFileSync(new URL('../../heart/protocol.json', import.meta.url), 'utf8'));
const OPS = new Map(Object.entries(P.commands).map(([name, c]) => [c.op, { name, fields: c.fields }]));

export async function load() {
  const heart = await import('../../js/heart/heart.js');
  const nodes = await import('../../js/heart/nodes.js');
  const params = await import('../../js/heart/params.js');
  const route = await import('../../js/heart/route.js');
  const buffers = await import('../../js/heart/buffers.js');
  return { ...heart, ...nodes, ...params, ...buffers, route, rig: opts => rig(heart.HeartContext, opts), sent, take, decode, eventBytes };
}

// Command records back into objects, every field by its protocol name.
export function decode(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  for (let at = 0; at < u8.byteLength;) {
    const op = v.getUint16(at, true), len = v.getUint16(at + 2, true);
    const cmd = OPS.get(op);
    const rec = { op: cmd.name, node: v.getUint32(at + 4, true) };
    let p = at + 8;
    for (const [name, type] of cmd.fields) {
      if (type === 'u32') { rec[name] = v.getUint32(p, true); p += 4; }
      else if (type === 'f32') { rec[name] = v.getFloat32(p, true); p += 4; }
      else if (type === 'f64') { rec[name] = v.getFloat64(p, true); p += 8; }
      else if (type === 'f64x8') { rec[name] = Array.from({ length: 8 }, (_, k) => v.getFloat64(p + 8 * k, true)); p += 64; }
      else if (type === 'f32[]') {
        const n = v.getUint32(p, true); p += 4;
        rec[name] = Array.from({ length: n }, (_, k) => v.getFloat32(p + 4 * k, true)); p += 4 * n;
      } else {
        const n = v.getUint32(p, true); p += 4;
        rec[name] = u8.slice(p, p + n); p += Math.ceil(n / 4) * 4;
      }
    }
    if (p !== at + len) throw new Error(`record ${cmd.name} is ${len} bytes but its fields end at ${p - at}`);
    out.push(rec);
    at += len;
  }
  return out;
}

// A fake Engine (spec 7.1): `stages` stages, stage 0 the mix, islands
// placed by `homes` (name -> stage id), F frames of offset, sample rate 48k,
// and every stage's render horizon at `horizon` frames.
function fakeEngine({ stages = 1, homes = {}, F = 0, sampleRate = 48000, horizon = 0 } = {}) {
  const listeners = [];
  return {
    sampleRate,
    stages: Array.from({ length: stages }, (_, id) => ({ id, role: stages === 1 ? 0 : id ? 1 : 2, islands: [] })),
    batches: [],
    uploads: [],
    frameAt: t => t * sampleRate - F,
    timeAt: f => (f + F) / sampleRate,
    horizon: () => horizon,
    freed: [],
    freeBuffer(id, stageIds) { this.freed.push({ id, stages: [...stageIds] }); },
    stageFor: island => homes[island] ?? (stages > 1 ? 1 : 0),
    send(stage, bytes) { this.batches.push({ stage, bytes }); },
    ensureBuffer(id, stage) { this.uploads.push({ id, stage }); },
    on(type, fn) { if (type === 'events') listeners.push(fn); },
    emit(stage, u8) { for (const fn of listeners) fn(stage, u8); }
  };
}

// A fake shadow: keeps what it is written, and answers value reads with
// `answer`, noting each read.
function fakeShadow() {
  const cmds = new Commands();
  return {
    reads: [],
    answer: 0.5,
    present: null,
    follow(fn) { this.present = fn; },
    write(fn) { fn(cmds); },
    value(node, param, frame) { this.reads.push({ node, param, frame }); return this.answer; },
    records() { return decode(cmds.bytes()); }
  };
}

// An engine, a native clock and a shadow (a fake one unless `shadow` is
// given, such as heart.js's own), with the mix context on them.
function rig(HeartContext, opts = {}) {
  const engine = fakeEngine(opts);
  const clock = {
    currentTime: opts.now ?? 0, sampleRate: engine.sampleRate, state: 'running',
    createBuffer: (c, l, sr) => ({ numberOfChannels: c, length: l, sampleRate: sr, getChannelData: () => new Float32Array(l) })
  };
  const shadow = opts.shadow || fakeShadow();
  return { engine, clock, shadow, ctx: new HeartContext(engine, clock, shadow, 'mix') };
}

// Every record the engine has been sent, in order, each with its stage.
function sent(engine) {
  return engine.batches.flatMap(b => decode(b.bytes).map(r => ({ stage: b.stage, ...r })));
}
// The same, and forgets them, so a test can look at one step at a time.
function take(engine) {
  const out = sent(engine);
  engine.batches.length = 0;
  return out;
}

// Event records as the engine sends them (heart/src/events.rs).
function eventBytes(events) {
  const parts = events.map(e => {
    const payload = e.bytes || new Uint8Array(0);
    const pad = (4 - payload.length % 4) % 4;
    const len = e.op === 'ended' ? 8 : e.op === 'peak' ? 12 : 12 + payload.length + pad;
    const u8 = new Uint8Array(len), v = new DataView(u8.buffer);
    v.setUint16(0, P.events[e.op].op, true); v.setUint16(2, len, true); v.setUint32(4, e.node, true);
    if (e.op === 'peak') v.setFloat32(8, e.value, true);
    if (e.op === 'port') { v.setUint32(8, payload.length, true); u8.set(payload, 12); }
    return u8;
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
