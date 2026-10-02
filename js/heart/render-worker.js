// One Heart stage: a worker hosting one heart.wasm instance, keeping its
// out ring full (documents/heart-audio-engine.md, §3 and §7). Spawned by
// js/heart/pool.js, one per stage, and started by js/heart/engine.js with
// an 'init' message.
//
// An island renders its families and copies each egress port into its
// egress ring. The mix first reads block k of every island's egress ring
// into its ingress ports, then renders block k and copies the master into
// the final ring, which the drain plays. A combined stage (one worker, a
// small device) renders everything and writes the master straight to the
// final ring. Everything is rendered in chunks of CHUNK frames, and a stage
// renders whenever it is allowed to:
//
//   - its out ring has room for a chunk;
//   - its frame is within the lookahead of the drain's clock: the mix and
//     the combined stage up to `played + lookahead`, an island one chunk
//     beyond that, so it renders block k + 1 while the mix renders block k;
//   - the mix only: every island's egress ring holds the block.
//
// An island never waits on the mix, only on room in its ring.
//
// The lookahead is live (§7.3, adaptive lookahead): the drain grows it on
// an underrun or when the page goes hidden and eases it back after a steady
// stretch, and a stage reads it before every chunk, from the control block
// or, without one, from the last chunk the drain sent back. An island's
// egress ring is sized for the base lookahead only, so once the lookahead
// grows an island stays as far ahead of the mix as its ring holds, and the
// extra cushion lives in the final ring, where it is two channels rather
// than thirty-two.
//
// Waiting. With SharedArrayBuffer (the control block, ring.js) a stage that
// cannot render sleeps on its bell with Atomics.waitAsync, which leaves the
// worker's event loop free, so commands and buffers keep landing while it
// sleeps. It wakes when the thing it waits for happens: the drain rings it
// when the clock reaches the count it asked for (WAKE), the mix rings an
// island when it has emptied a block of the island's ring, an island rings
// the mix when it has filled one, and the drain rings every stage when the
// lookahead grows. A long safety timeout only guards against
// a wake that never comes. Without SharedArrayBuffer, the rings' own
// messages wake the stage: the drain posts back each chunk it has played,
// carrying its clock, and the mix posts back each island chunk. An island
// in this mode keys on ring room alone, as its only news of the clock would
// come through the mix it may be waiting to feed; its ring holds a few
// chunks, so it stays a few chunks ahead of the mix. A slow timer is the
// fallback.
//
// Yielding. A stage that is behind, catching up after a stall or simply too
// slow, could render chunk after chunk in one turn and never return to its
// event loop, and commands and buffers would wait behind the whole of it:
// with a lookahead grown to half a second, that is dozens of chunks, and
// for an overloaded stage it is for ever. So every few chunks it returns to
// the event loop and picks up again on a zero timer. A chain of those is
// clamped to 4 ms, small beside the 43 ms of audio four chunks hold; a
// message to itself would be quicker, but a port that keeps posting to
// itself can keep the worker's other messages waiting (node does). For the
// same reason a ring's message (message mode) only schedules a pump on
// that timer rather than rendering inside its handler: a steady stream of
// returned chunks would otherwise be a turn that never ends. Until the
// timer fires every other wake-up returns at once.
//
// Memory. Every ABI call that can allocate can grow the wasm memory, which
// detaches the typed arrays over the old one, so they are re-taken through
// view() after each such call and indices, not views, are kept.

import {
  QUANTUM, MAX_PORTS, ingressKey, openRing,
  PLAYED, LOOKAHEAD, bellOf, wakeOf, headOf, renderOf, ringBell
} from './ring.js';

const ROLE_ISLAND = 1, ROLE_MIX = 2;
const PORT_EGRESS = 0, PORT_INGRESS = 1, PORT_MASTER = 2;
// A missed wake-up costs at most this long, in SAB mode.
const SAFETY_MS = 250;
// Message mode's fallback poll.
const FALLBACK_MS = 50;
// In message mode islands report their head and render time every this many
// chunks; the mix (stage 0) every chunk, as renderedUntil() reads its head.
const REPORT_EVERY = 8;
// Chunks rendered in one turn before the stage lets its messages in.
const TURN_CHUNKS = 4;

let wasm = null, memory = null, f32 = null, u8 = null, u32 = null;
let stage = 0, role = 0, chunk = 0, lookahead = 0, ctl = null;
let out = null, ins = [], frame = 0, eventsAt = 0;
let renderMs = 0, reports = 0, dead = false, started = false, scheduled = false;
const backlog = [];
// The egress ports this island has ever written. A port missing now (not
// made yet, or destroyed) is written as silence only if it once carried
// sound, since its planes are reused round the ring and would otherwise
// replay old samples; a port never made was never written and stays zero.
const everWritten = new Uint8Array(MAX_PORTS);

self.onmessage = e => {
  const d = e.data;
  if (d.type === 'init') init(d).catch(fail);
  else if (!started) backlog.push(d);
  else apply(d);
};

function apply(d) {
  try {
    if (d.type === 'commands') commands(d.bytes);
    else if (d.type === 'buffer') upload(d);
    else if (d.type === 'free') wasm.heart_buffer_free(d.id);
    else if (d.type === 'inspect') inspect(d.ask);
  } catch (err) { fail(err); }
}

function fail(err) {
  dead = true;
  self.postMessage({ type: 'error', stage, message: String(err && err.stack || err) });
}

async function init(d) {
  stage = d.stage;
  role = d.role;
  chunk = d.chunk;
  ctl = d.control;
  lookahead = d.lookahead;

  // heart.wasm imports nothing (§5), so the import object is empty.
  const instance = await WebAssembly.instantiate(d.module, {});
  wasm = instance.exports;
  memory = wasm.memory;
  if (wasm.heart_init(d.sampleRate, role, d.seed >>> 0) !== 1) throw new Error('heart_init refused');
  eventsAt = wasm.heart_alloc(4);
  frame = Number(wasm.heart_frame());

  out = openRing(d.out, 'writer');
  ins = d.ins.map(i => ({ stage: i.stage, ring: openRing(i.ring, 'reader') }));
  if (!ctl) {
    out.onchange = soon;
    for (const i of ins) i.ring.onchange = soon;
    setInterval(pump, FALLBACK_MS);
  }

  started = true;
  for (const m of backlog) apply(m);
  backlog.length = 0;
  self.postMessage({ type: 'ready', stage });
  pump();
}

function view() {
  if (!f32 || f32.buffer !== memory.buffer) {
    f32 = new Float32Array(memory.buffer);
    u8 = new Uint8Array(memory.buffer);
    u32 = new Uint32Array(memory.buffer);
  }
}

// ---------- commands, buffers, events ----------
function commands(bytes) {
  const len = bytes.byteLength;
  if (!len) return;
  const ptr = wasm.heart_alloc(len);
  view();
  u8.set(bytes, ptr);
  wasm.heart_commands(ptr, len);
  wasm.heart_free(ptr, len);
  events();
}

function upload({ id, channels, frames, sampleRate, data }) {
  const ptr = wasm.heart_buffer_alloc(id, channels, frames, sampleRate);
  if (!ptr) throw new Error(`heart_buffer_alloc refused buffer ${id}`);
  view();
  f32.set(data, ptr >> 2);
}

// The stage's eight counters (heart/src/lib.rs, heart_stats) and its memory,
// for Engine.inspect.
const COUNTERS = ['nodes', 'renders', 'skips', 'cut', 'rejected', 'firstCut', 'dropped', 'rebuilds'];
function inspect(ask) {
  const at = wasm.heart_stats();
  view();
  const answer = { type: 'inspect', ask, stage, frame, memory: memory.buffer.byteLength };
  COUNTERS.forEach((name, i) => { answer[name] = u32[(at >> 2) + i]; });
  self.postMessage(answer);
}

// Whatever the stage has to say (ended, peaks, processor messages) goes to
// the page as raw bytes; js/heart/heart.js decodes them.
function events() {
  const len = wasm.heart_events(eventsAt);
  if (!len) return;
  view();
  const at = u32[eventsAt >> 2];
  const bytes = u8.slice(at, at + len);
  self.postMessage({ type: 'events', stage, bytes }, [bytes.buffer]);
}

// ---------- rendering ----------
const played = () => ctl ? Atomics.load(ctl, PLAYED) * QUANTUM : out.clock;

// How far past the clock this stage may render, read afresh each time. The
// mix and the combined stage keep to the lookahead; an island runs a chunk
// further, or, without the shared clock, keys on ring room alone. Without
// the control block the drain's lookahead arrives on the chunks it sends
// back (ring.js, MessageRing); until the first one, the one from init.
function ahead() {
  if (role === ROLE_ISLAND) return ctl ? Atomics.load(ctl, LOOKAHEAD) + chunk : Infinity;
  return ctl ? Atomics.load(ctl, LOOKAHEAD) : out.ahead || lookahead;
}

function ready() {
  if (out.writable() < chunk) return false;
  if (frame + chunk > played() + ahead()) return false;
  for (const i of ins) if (i.ring.readable() < chunk) return false;
  return true;
}

function soon() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(resume, 0);
}
function resume() {
  scheduled = false;
  pump();
}

function pump() {
  if (dead || !started || scheduled) return;
  try {
    for (let turn = 0; ;) {
      // The bell is read before the checks, so a ring that lands between
      // them changes it and the wait below returns at once.
      const bell = ctl ? Atomics.load(ctl, bellOf(stage)) : 0;
      if (ready()) {
        if (turn++ === TURN_CHUNKS) { soon(); return; }
        render();
        continue;
      }
      if (!ctl) return;
      Atomics.store(ctl, wakeOf(stage), wakeAt());
      if (ready()) continue;        // the clock moved while we decided
      sleep(bell);
      return;
    }
  } catch (err) { fail(err); }
}

// The clock count to be woken at, or -1 when what is missing is room in an
// egress ring or an island's block, which the other stage rings for.
function wakeAt() {
  const now = Atomics.load(ctl, PLAYED), reach = ahead();
  let want = -1;
  if (frame + chunk > now * QUANTUM + reach) want = Math.ceil((frame + chunk - reach) / QUANTUM);
  // The final ring empties a quantum at a time, as the drain plays it.
  if (role !== ROLE_ISLAND) {
    const room = out.writable();
    if (room < chunk) want = Math.max(want, now + Math.ceil((chunk - room) / QUANTUM));
  }
  return want;
}

function sleep(bell) {
  if (!Atomics.waitAsync) { setTimeout(pump, Math.max(1, chunk / QUANTUM)); return; }
  const w = Atomics.waitAsync(ctl, bellOf(stage), bell, SAFETY_MS);
  if (w.async) w.value.then(pump);
  else queueMicrotask(pump);
}

function render() {
  if (ins.length) pullIngress();
  // The frame is counted here rather than taken from heart_render's u32,
  // which JS reads as a signed i32 that would wrap after twelve hours.
  const t0 = performance.now();
  wasm.heart_render(chunk);
  const ms = performance.now() - t0;
  frame += chunk;
  view();
  if (role === ROLE_ISLAND) pushEgress(); else pushMaster();
  out.commit(chunk);
  if (ctl && role === ROLE_ISLAND) ringBell(ctl, 0);
  events();
  report(ms);
}

// The mix's block k of each island, from its egress ring into the matching
// ingress ports. A port the mix has no ingress for is left in the ring.
function pullIngress() {
  for (const { stage: s, ring } of ins) {
    for (let p = 0; p < MAX_PORTS; p++) {
      const ptr = wasm.heart_port_ptr(PORT_INGRESS, ingressKey(s, p));
      if (!ptr) continue;
      view();
      const at = ptr >> 2;
      ring.read(2 * p, f32, at, chunk);
      ring.read(2 * p + 1, f32, at + chunk, chunk);
    }
    ring.release(chunk);
    if (ctl) ringBell(ctl, s);
  }
}

// A port's buffer is planar: left at ptr, right a chunk after it.
function pushEgress() {
  for (let p = 0; p < MAX_PORTS; p++) {
    const ptr = wasm.heart_port_ptr(PORT_EGRESS, p);
    if (ptr) {
      view();
      out.write(2 * p, f32, ptr >> 2, chunk);
      out.write(2 * p + 1, f32, (ptr >> 2) + chunk, chunk);
      everWritten[p] = 1;
    } else if (everWritten[p]) {
      out.zero(2 * p, chunk);
      out.zero(2 * p + 1, chunk);
    }
  }
}

function pushMaster() {
  const ptr = wasm.heart_port_ptr(PORT_MASTER, 0);
  if (ptr) {
    view();
    out.write(0, f32, ptr >> 2, chunk);
    out.write(1, f32, (ptr >> 2) + chunk, chunk);
  } else {
    out.zero(0, chunk);
    out.zero(1, chunk);
  }
}

// The render time is smoothed over about ten chunks. With the control block
// the page reads it and the head straight from shared memory; without, they
// are posted.
function report(ms) {
  renderMs += (ms - renderMs) * 0.1;
  if (ctl) {
    Atomics.store(ctl, headOf(stage), frame / QUANTUM);
    Atomics.store(ctl, renderOf(stage), Math.round(renderMs * 1000));
  } else if (stage === 0 || ++reports % REPORT_EVERY === 0) {
    self.postMessage({ type: 'head', stage, frame, renderMs });
  }
}
