import assert from 'node:assert/strict';
import { pack, unpack } from '../js/wire.js';

// ---- fakes -------------------------------------------------------------
let clock = 1000;              // performance.now and room clock both
globalThis.performance = { now: () => clock };
const decoders = [];
let supportedCodecs = new Set(['avc1.42E01F', 'vp8', 'vp09.00.10.08']);
let supportChecks = 0;
let autoOutput = true;          // decoder outputs synchronously-ish on decode (we flush manually)
const liveFrames = new Set();

class FakeFrame {
  constructor(ts, w, h) { this.timestamp = ts; this.displayWidth = w; this.displayHeight = h; this.closed = false; liveFrames.add(this); }
  close() { assert.ok(!this.closed, 'double close'); this.closed = true; liveFrames.delete(this); }
}
class FakeChunk {
  constructor({ type, timestamp, data }) { this.type = type; this.timestamp = timestamp; this.byteLength = data.byteLength; }
}
class FakeDecoder {
  constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.queue = []; this.configs = []; this.resets = 0; this.needKey = true; decoders.push(this); }
  get decodeQueueSize() { return this.queue.length; }
  static isConfigSupported(cfg) { supportChecks++; return Promise.resolve({ supported: supportedCodecs.has(cfg.codec), config: cfg }); }
  configure(cfg) { if (this.state === 'closed') throw new Error('closed'); this.state = 'configured'; this.configs.push(cfg); this.cfg = cfg; this.needKey = true; }
  decode(chunk) {
    if (this.state !== 'configured') throw new Error('not configured');
    if (this.needKey && chunk.type !== 'key') throw new Error('key frame required');
    this.needKey = false;
    this.queue.push(chunk);
  }
  // test helper: emit every queued chunk as a frame
  drain() { const q = this.queue; this.queue = []; for (const c of q) this.output(new FakeFrame(c.timestamp, this.cfg.codedWidth, this.cfg.codedHeight)); }
  fail(msg) { this.state = 'closed'; this.queue = []; this.error(new Error(msg)); }
  reset() { this.state = 'unconfigured'; this.queue = []; this.resets++; }
  close() { this.state = 'closed'; this.queue = []; }
}
globalThis.VideoDecoder = FakeDecoder;
globalThis.EncodedVideoChunk = FakeChunk;

const { createReceiver } = await import('../js/receive.js');
const tick = () => new Promise(r => setTimeout(r, 0));

function pkt(from, seq, { key = false, t = clock - 50, w = 320, h = 240, codec = 0, desc = key && codec === 0 ? [1, 2, 3] : null, size = 1000 } = {}) {
  const buf = pack({ seq, t, key, width: w, height: h, codec, fps: 30 }, new Uint8Array(size), desc ? new Uint8Array(desc) : undefined);
  new DataView(buf).setUint16(2, from, true);   // the relay's job
  return unpack(buf);
}

let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log('ok  ', name); }

// ---- tests -------------------------------------------------------------
await test('waits for a full picture, asks once a second, then decodes', async () => {
  const asked = [];
  const rx = createReceiver({ now: () => clock, onNeedKey: id => asked.push(id) });
  rx.push(pkt(7, 10));
  rx.push(pkt(7, 11));
  assert.deepEqual(asked, [7]);                         // late joiner asks, once
  assert.equal(decoders.length, 0);
  clock += 1001; rx.push(pkt(7, 12));
  assert.deepEqual(asked, [7, 7]);                      // still waiting a second later: asks again
  const panels = rx.panels();
  assert.equal(panels.length, 1);
  const entry = panels[0];
  assert.equal(entry.frame, null);
  rx.push(pkt(7, 13, { key: true }));
  assert.equal(decoders.length, 0);                     // support check pending, packet held
  rx.push(pkt(7, 14));
  await tick();
  const d = decoders.at(-1);
  assert.equal(d.configs.length, 1);
  assert.equal(d.configs[0].codec, 'avc1.42E01F');
  assert.equal(d.configs[0].optimizeForLatency, true);
  assert.deepEqual([...d.configs[0].description], [1, 2, 3]);
  assert.equal(d.queue.length, 2);                      // key + held delta fed after check
  assert.equal(d.queue[0].type, 'key');
  assert.ok(d.queue[1].timestamp > d.queue[0].timestamp);
  clock += 10;
  d.drain();
  assert.equal(entry.version, 2);
  assert.ok(entry.frame && !entry.frame.closed);
  assert.equal(liveFrames.size, 1);                     // the older frame was closed
  assert.equal(rx.panels(), panels);                    // same array
  assert.equal(rx.panels()[0], entry);                  // same entry
  const st = rx.stats(7);
  assert.equal(st.keyframes, 1);
  assert.equal(st.gaps, 0);
  assert.equal(st.codec, 'H.264');
  assert.equal(st.width, 320);
  assert.equal(st.error, null);
  assert.equal(rx.stats(99), null);
  rx.close();
  assert.equal(liveFrames.size, 0);
  assert.equal(d.state, 'closed');
});

await test('delay = now - t, measured at output; stats over the window', async () => {
  const rx = createReceiver({ now: () => clock, onNeedKey: () => {} });
  const t0 = clock;
  rx.push(pkt(1, 0, { key: true, t: t0 - 40, size: 500 }));
  await tick();
  const d = decoders.at(-1);
  clock += 5;   // decode took 5 ms -> delay 45
  d.drain();
  rx.push(pkt(1, 1, { t: clock - 30, size: 500 }));
  clock += 20;  // delay 50, decode 20
  d.drain();
  const st = rx.stats(1);
  assert.equal(st.delayLastMs, 50);
  assert.equal(st.delayMs, (45 + 50) / 2);
  assert.equal(st.delayMaxMs, 50);
  assert.equal(st.decodeMs, (5 + 20) / 2);
  assert.equal(st.fps, 2);
  assert.equal(st.kbps, ((24 + 3 + 500) + (24 + 500)) * 8 / 1000);
  assert.equal(st.queue, 0);
  clock += 1500;
  const later = rx.stats(1);
  assert.equal(later.fps, 0);
  assert.equal(later.kbps, 0);
  assert.equal(later.delayMs, null);
  assert.equal(later.delayLastMs, 50);
  rx.close();
});

await test('seq gap: drop until key, ask, count; u32 wrap is no gap', async () => {
  const asked = [];
  const rx = createReceiver({ now: () => clock, onNeedKey: id => asked.push(id) });
  rx.push(pkt(2, 0xFFFFFFFE, { key: true }));
  await tick();
  const d = decoders.at(-1);
  rx.push(pkt(2, 0xFFFFFFFF));
  rx.push(pkt(2, 0));                                    // wrap
  assert.equal(d.queue.length, 3);
  assert.equal(rx.stats(2).gaps, 0);
  rx.push(pkt(2, 2));                                    // seq 1 missing
  assert.equal(d.queue.length, 3);
  assert.deepEqual(asked, [2]);
  assert.equal(rx.stats(2).gaps, 1);
  rx.push(pkt(2, 3));
  rx.push(pkt(2, 5));                                    // another jump while waiting: not counted twice
  assert.equal(rx.stats(2).gaps, 1);
  assert.deepEqual(asked, [2]);                          // rate limited
  rx.push(pkt(2, 6, { key: true }));                     // same format: no reconfigure, fed directly
  assert.equal(d.configs.length, 1);
  assert.equal(d.queue.length, 4);
  assert.equal(d.queue[3].type, 'key');
  rx.push(pkt(2, 7));
  assert.equal(d.queue.length, 5);
  // gap followed directly by a key (the sender's refused-packet case): counted, no ask
  clock += 2000;
  rx.push(pkt(2, 9, { key: true }));
  assert.equal(rx.stats(2).gaps, 2);
  assert.deepEqual(asked, [2]);
  assert.equal(d.queue.length, 6);
  rx.close();
});

await test('reconfigure on size, codec or description change', async () => {
  const rx = createReceiver({ now: () => clock });
  rx.push(pkt(3, 0, { key: true, w: 320, h: 240 }));
  await tick();
  const d = decoders.at(-1);
  rx.push(pkt(3, 1, { key: true, w: 320, h: 240 }));
  assert.equal(d.configs.length, 1);
  rx.push(pkt(3, 2, { key: true, w: 320, h: 240, desc: [1, 2, 4] }));   // new description, size known supported
  await tick();
  assert.equal(d.configs.length, 2);
  rx.push(pkt(3, 3, { key: true, w: 640, h: 480, desc: [1, 2, 4] }));   // new size
  await tick();
  assert.equal(d.configs.length, 3);
  assert.equal(d.configs[2].codedWidth, 640);
  rx.push(pkt(3, 4, { key: true, w: 640, h: 480, codec: 1 }));          // VP8, no description
  await tick();
  assert.equal(d.configs.length, 4);
  assert.equal(d.configs[3].codec, 'vp8');
  assert.equal('description' in d.configs[3], false);
  assert.equal(rx.stats(3).codec, 'VP8');
  assert.equal(decoders.at(-1), d);                      // one decoder throughout
  rx.close();
});

await test('unsupported format: plain reason, stop trying until the format changes', async () => {
  const asked = [];
  const rx = createReceiver({ now: () => clock, onNeedKey: id => asked.push(id) });
  const before = decoders.length;
  rx.push(pkt(4, 0, { key: true, codec: 3 }));           // AV1 not in supportedCodecs
  await tick();
  assert.equal(decoders.length, before);
  assert.match(rx.stats(4).error, /cannot show AV1 pictures at 320x240/);
  const checks = supportChecks;
  rx.push(pkt(4, 1));
  rx.push(pkt(4, 2, { key: true, codec: 3 }));
  await tick();
  assert.equal(supportChecks, checks);                    // not asked again
  assert.deepEqual(asked, []);                            // and no key requests for it
  rx.push(pkt(4, 3, { key: true, codec: 1 }));            // switches to VP8
  await tick();
  assert.equal(rx.stats(4).error, null);
  assert.equal(decoders.length, before + 1);
  rx.close();
});

await test('decoder error: new decoder at next key, error text clears on output', async () => {
  const asked = [];
  const rx = createReceiver({ now: () => clock, onNeedKey: id => asked.push(id) });
  rx.push(pkt(5, 0, { key: true }));
  await tick();
  const d = decoders.at(-1);
  d.drain();
  clock += 5000;
  d.fail('bad bitstream');
  assert.match(rx.stats(5).error, /unpacking pictures stopped \(bad bitstream\)/);
  assert.equal(rx.stats(5).gaps, 1);
  assert.deepEqual(asked, [5]);
  assert.equal(rx.stats(5).queue, null);
  rx.push(pkt(5, 1));
  assert.equal(d.queue.length, 0);
  rx.push(pkt(5, 2, { key: true }));                      // support cached: synchronous
  const d2 = decoders.at(-1);
  assert.notEqual(d2, d);
  assert.equal(d2.queue.length, 1);
  d2.drain();
  assert.equal(rx.stats(5).error, null);
  assert.equal(rx.panels()[0].version, 2);
  rx.close();
});

await test('falling behind: reset, wait for key; a key goes straight in', async () => {
  const asked = [];
  const rx = createReceiver({ now: () => clock, onNeedKey: id => asked.push(id) });
  rx.push(pkt(6, 0, { key: true }));
  await tick();
  const d = decoders.at(-1);
  for (let i = 1; i <= 5; i++) rx.push(pkt(6, i));
  assert.equal(d.queue.length, 6);
  rx.push(pkt(6, 6));                                     // queue 6 > 5
  assert.equal(d.resets, 1);
  assert.equal(rx.stats(6).gaps, 1);
  assert.deepEqual(asked, [6]);
  rx.push(pkt(6, 7));
  assert.equal(d.queue.length, 0);
  rx.push(pkt(6, 8, { key: true }));
  assert.equal(d.queue.length, 1);
  for (let i = 9; i <= 13; i++) rx.push(pkt(6, i));
  assert.equal(d.queue.length, 6);
  clock += 2000;
  rx.push(pkt(6, 14, { key: true }));                     // behind, but this is a key
  assert.equal(d.resets, 2);
  assert.equal(d.queue.length, 1);
  assert.equal(d.state, 'configured');
  assert.equal(rx.stats(6).gaps, 2);
  assert.deepEqual(asked, [6]);                           // no ask: the key is here
  rx.push(pkt(6, 15));
  assert.equal(d.queue.length, 2);
  rx.close();
});

await test('panels ordered by id, stable entries, drop closes everything', async () => {
  const rx = createReceiver({ now: () => clock });
  for (const id of [9, 2, 5]) rx.push(pkt(id, 0, { key: true }));
  await tick();
  const arr = rx.panels();
  assert.deepEqual(arr.map(p => p.id), [2, 5, 9]);
  const e5 = arr[1];
  for (const d of decoders.slice(-3)) d.drain();
  assert.equal(liveFrames.size, 3);
  const d5 = decoders.find(d => d.state === 'configured' && d.output && rx.panels()[1] === e5) ;
  rx.drop(5);
  assert.deepEqual(rx.panels().map(p => p.id), [2, 9]);
  assert.equal(rx.panels(), arr);
  assert.equal(liveFrames.size, 2);
  assert.equal(rx.stats(5), null);
  rx.push(pkt(3, 0));
  assert.deepEqual(rx.panels().map(p => p.id), [2, 3, 9]);
  rx.close();
  assert.equal(liveFrames.size, 0);
  assert.equal(rx.panels().length, 0);
  rx.push(pkt(2, 1, { key: true }));                      // after close: ignored
  assert.equal(rx.panels().length, 0);
});

await test('late output after drop is closed, not stored', async () => {
  const rx = createReceiver({ now: () => clock });
  rx.push(pkt(8, 0, { key: true }));
  await tick();
  const d = decoders.at(-1);
  const out = d.output;
  rx.drop(8);
  const f = new FakeFrame(0, 320, 240);
  out(f);
  assert.ok(f.closed);
});

await test('non-video kinds ignored; held packets are copies', async () => {
  const rx = createReceiver({ now: () => clock });
  const a = pkt(11, 0, { key: true }); a.kind = 2;
  rx.push(a);
  assert.equal(rx.panels().length, 0);
  supportedCodecs.add('av01.0.04M.08');
  const k = pkt(11, 0, { key: true, codec: 3, w: 100, h: 100 });
  rx.push(k);
  k.data.fill(9);                                          // socket buffer reused
  const before = decoders.length;
  await tick();
  assert.equal(decoders.length, before + 1);
  rx.close();
});

await test('no VideoDecoder at all: plain error, nothing throws', async () => {
  const saved = globalThis.VideoDecoder;
  delete globalThis.VideoDecoder;
  const asked = [];
  const rx = createReceiver({ now: () => clock, onNeedKey: id => asked.push(id) });
  rx.push(pkt(1, 0, { key: true }));
  rx.push(pkt(1, 1));
  rx.push(pkt(1, 3));
  const st = rx.stats(1);
  assert.equal(st.error, 'this browser cannot show video sent this way');
  assert.equal(st.fps, null);
  assert.equal(st.width, 320);
  assert.deepEqual(asked, []);
  rx.drop(1); rx.close();
  globalThis.VideoDecoder = saved;
});

await test('timestamps unique and increasing even when t repeats or steps back', async () => {
  const rx = createReceiver({ now: () => clock });
  rx.push(pkt(12, 0, { key: true, t: 5000 }));
  await tick();
  const d = decoders.at(-1);
  rx.push(pkt(12, 1, { t: 5000 }));
  rx.push(pkt(12, 2, { t: 4990 }));
  rx.push(pkt(12, 3, { t: 5033.3 }));
  const ts = d.queue.map(c => c.timestamp);
  assert.deepEqual(ts, [0, 1, 2, 33300]);
  rx.close();
});

console.log(`\n${pass} tests passed`);
