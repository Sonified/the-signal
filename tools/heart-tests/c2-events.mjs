// Events back from the engine (ended, peak, port) reaching the proxies,
// and the genus port's messages in both directions.
// Run: node --test tools/heart-tests/c2-events.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

const h = await load();

test('ended reaches onended and ended listeners, even on a source the app let go of', () => {
  const { engine, ctx } = h.rig();
  let id, heard = [];
  (() => {
    const s = ctx.createBufferSource();
    id = s._id;
    s.onended = e => heard.push(['onended', e.type, e.target === s]);
    s.addEventListener('ended', () => heard.push(['listener']));
    s.start();
  })();
  engine.emit(0, h.eventBytes([{ op: 'ended', node: id }]));
  assert.deepEqual(heard, [['listener'], ['onended', 'ended', true]]);
  engine.emit(0, h.eventBytes([{ op: 'ended', node: id }]));   // once only
  assert.equal(heard.length, 2);
});

test('start and stop: frames on the wire, offset and duration in seconds, the spec\'s errors', () => {
  const { engine, clock, ctx } = h.rig({ F: 256 });
  clock.currentTime = 2;
  const s = ctx.createBufferSource();
  assert.throws(() => s.stop(), { name: 'InvalidStateError' });
  h.take(engine);
  s.start(3, 0.5, 1.25);
  s.stop(1);   // in the past: the present
  assert.deepEqual(h.take(engine).map(({ op, time, offset, duration }) => ({ op, time, offset, duration })), [
    { op: 'start', time: 3 * 48000 - 256, offset: 0.5, duration: 1.25 },
    { op: 'stop', time: 2 * 48000 - 256, offset: undefined, duration: undefined }
  ]);
  assert.throws(() => s.start(), { name: 'InvalidStateError' });
  const o = ctx.createOscillator();
  assert.throws(() => o.start(-1), RangeError);
  o.start();
  assert.equal(h.take(engine).at(-1).duration, -1, 'no duration is -1');
});

test('a buffer is registered, uploaded to the node\'s stage, then named by id', () => {
  const { engine, clock, ctx } = h.rig({ stages: 2, homes: { clouds: 1 } });
  const buf = clock.createBuffer(2, 100, 48000);
  const s = ctx.island('clouds').createBufferSource();
  h.take(engine);
  s.buffer = buf;
  assert.equal(engine.uploads.length, 1);
  assert.equal(engine.uploads[0].stage, 1);
  const [rec] = h.take(engine);
  assert.deepEqual([rec.op, rec.attr, rec.value], ['attr', 5, engine.uploads[0].id]);
  assert.equal(s.buffer, buf);
  assert.throws(() => { s.buffer = clock.createBuffer(1, 10, 48000); }, { name: 'InvalidStateError' });
  const conv = ctx.island('clouds').createConvolver();
  conv.normalize = false;
  conv.buffer = buf;
  conv.buffer = buf;           // a convolver may be handed buffers again
  assert.equal(engine.uploads.filter(u => u.id === engine.uploads[0].id).length, 3,
    'the engine is asked each time; uploading once is its job');
  s.loop = true; s.loopStart = 0.25; s.loopEnd = 1.5;
  assert.deepEqual(h.take(engine).filter(r => r.op === 'attr').map(r => [r.attr, r.value]),
    [[6, 0], [5, 1], [5, 1], [2, 1], [3, 0.25], [4, 1.5]]);
});

test('an analyser\'s peak: 0 until one arrives, one request in flight, a stand-in waveform', () => {
  const { engine, ctx } = h.rig();
  const a = ctx.createAnalyser();
  a.fftSize = 1024;
  assert.equal(a.frequencyBinCount, 512);
  assert.throws(() => { a.fftSize = 1000; }, { name: 'IndexSizeError' });
  h.take(engine);
  assert.equal(a.peak(), 0);
  assert.equal(a.peak(), 0);
  assert.deepEqual(h.take(engine).map(r => r.op), ['peak_request'], 'one ask while one is in flight');
  engine.emit(0, h.eventBytes([{ op: 'peak', node: a._id, value: 0.75 }]));
  const x = new Float32Array(1024);
  a.getFloatTimeDomainData(x);
  assert.ok(x.every(v => v === 0.75));
  assert.deepEqual(h.take(engine).map(r => r.op), ['peak_request'], 'the answer frees the next ask');
});

test('genus messages in: signal, meters, dipWatch and chirp, as protocol.json lays them out', () => {
  const { engine, ctx } = h.rig({ F: 128 });
  const g = ctx.createProcessor('genus');
  h.take(engine);
  g.port.postMessage({ signal: true, at: 1, p: 0.2, r0: 7, r1: 9, dur: 3, wave: 2, duty: 0.3, linked: true });
  g.port.postMessage({ meters: false });
  g.port.postMessage({ dipWatch: true });
  const table = new Float32Array([0.5, -0.25, 1]);
  g.port.postMessage({ chirp: table, sig: '48000:600:2400:1:0', xf: 0.03 }, [table.buffer]);
  g.port.postMessage({ nothing: 1 });   // unknown: ignored, as the worklet ignores it
  const msgs = h.take(engine).map(r => new DataView(r.bytes.buffer));
  assert.equal(msgs.length, 4);
  const f64 = (v, i) => v.getFloat64(4 + 8 * i, true);
  assert.equal(msgs[0].getUint32(0, true), 1);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => f64(msgs[0], i)), [48000 - 128, 0.2, 7, 9, 3, 2, 0.3, 1]);
  assert.deepEqual([msgs[1].getUint32(0, true), f64(msgs[1], 0)], [2, 0]);
  assert.deepEqual([msgs[2].getUint32(0, true), f64(msgs[2], 0)], [3, 1]);
  const c = msgs[3];
  assert.equal(c.getUint32(0, true), 4);
  assert.equal(f64(c, 0), 1, 'the first signature is number 1');
  assert.ok(Math.abs(f64(c, 1) - 0.03) < 1e-12);
  assert.equal(c.getUint32(20, true), 3);
  assert.deepEqual([0, 1, 2].map(i => c.getFloat32(24 + 4 * i, true)), [0.5, -0.25, 1]);
});

test('genus messages out: peaks, dip and the chirp ack with its own string', () => {
  const { engine, ctx } = h.rig();
  const g = ctx.createProcessor('genus');
  const got = [];
  g.port.onmessage = e => got.push(JSON.parse(JSON.stringify(e.data)));
  g.port.postMessage({ chirp: new Float32Array(2), sig: 'sig-a', xf: 0.03 });
  g.port.postMessage({ chirp: new Float32Array(2), xf: 0.03 });   // no signature
  const payload = (type, write, size) => {
    const u8 = new Uint8Array(4 + size), v = new DataView(u8.buffer);
    v.setUint32(0, type, true); write(v);
    return u8;
  };
  engine.emit(0, h.eventBytes([
    { op: 'port', node: g._id, bytes: payload(101, v => { v.setFloat32(4, 0.5, true); v.setFloat32(8, 0.25, true); v.setFloat32(12, 0.125, true); }, 12) },
    { op: 'port', node: g._id, bytes: payload(102, v => v.setFloat32(4, 0.75, true), 4) },
    { op: 'port', node: g._id, bytes: payload(103, v => v.setFloat64(4, 1, true), 8) },
    { op: 'port', node: g._id, bytes: payload(103, v => v.setFloat64(4, 0, true), 8) },
    { op: 'stats', node: 0 }
  ].filter(e => e.op !== 'stats')));
  assert.deepEqual(got, [
    { peaks: true, tone: 0.5, pulse: 0.25, harm: 0.125 },
    { dip: 0.75 },
    { chirpAck: 'sig-a' },
    { chirpAck: true }
  ]);
});

test('a processor exposes its params by name, with the protocol\'s ranges', () => {
  const { ctx } = h.rig();
  const g = ctx.createProcessor('genus');
  assert.equal(g.parameters.size, 27);
  const rate = g.parameters.get('rate');
  assert.deepEqual([rate.defaultValue, rate.minValue, rate.maxValue, rate.automationRate], [40, Math.fround(0.05), 200, 'k-rate']);
  const one = ctx.createProcessor('one-pole');
  assert.equal(one.parameters.get('frequency').maxValue, 96000);
  assert.deepEqual([...ctx.createProcessor('fdn-reverb').parameters.keys()], ['decay', 'damping', 'mod']);
  assert.equal(one.port.postMessage({ any: 1 }), undefined, 'a processor with no messages ignores them');
});
