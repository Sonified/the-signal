// The music layers (table in js/layer-defs.js): single recordings that loop
// under the music, each with its own switch, level and mixer channel.
//
// They live in the music session the way the choir and the ocean drone do:
// piano.js hands them its dry bus and room input (both behind the pause
// gate), starts them in pianoOn and stops them in pianoOff, and each layer's
// own switch parks or wakes it mid-session. Each file is fetched the first
// time its layer is switched on during a session, never before.
//
// The loop is baked into the file (audio/music/layers/manifest.json): the
// crossfade is already in the audio, so playback is Web Audio's own loop and
// nothing more. The loop points are set from the table's sample count rather
// than from buffer.duration, so a decoder that leaves a sample or two of
// codec padding on the end still wraps at exactly the right place.
import { S } from './state.js';
import { getContext, glideParam } from './audio.js';
import { meterTap, tapPeak } from './util.js';
import { chanGate, onChannelGates } from './mixgate.js';
import { MUSIC_LAYERS, layerOnKey, layerVolKey } from './layer-defs.js';

export { MUSIC_LAYERS } from './layer-defs.js';

const LOOP_RATE = 48000;          // the rate the loops were cut at
const FADE_IN_TC = 1.2;           // the drone's opening glide
const FADE_OUT_TC = 0.3;          // about -70 dB by the teardown
const TEARDOWN_MS = 2500;

// One record per layer: its decoded buffer (kept once loaded), the load in
// flight, and while it sounds its source, gain and meter tap.
const run = new Map();
for (const L of MUSIC_LAYERS) {
  run.set(L.id, { L, buf: null, loading: null, wanted: false, token: 0, src: null, gain: null, tap: null });
}

let dryBus = null, roomBus = null;   // the piano's dry bus and room input (piano.js)
let session = false;                 // the music is running (pianoOn .. pianoOff)

// piano.js, once its graph is built.
export function setLayerBus(dry, roomIn) { dryBus = dry; roomBus = roomIn; }

const level = r => r.L.level * Math.max(0, S[layerVolKey(r.L)] || 0) * chanGate(r.L.id);

function load(ctx, r) {
  if (r.buf) return Promise.resolve(r.buf);
  if (r.loading) return r.loading;
  r.loading = (async () => {
    const res = await fetch(r.L.file);
    if (!res.ok) throw new Error(r.L.file + ': ' + res.status);
    r.buf = await ctx.decodeAudioData(await res.arrayBuffer());
    return r.buf;
  })().finally(() => { r.loading = null; });
  return r.loading;
}

async function start(r) {
  if (r.wanted) return;
  // The bus's own context: the music family's (js/piano.js), Heart's when
  // the flag names music, so a layer always builds where its bus lives.
  const ctx = dryBus && dryBus.context;
  if (!ctx || !dryBus || !roomBus) return;
  r.wanted = true;
  const my = ++r.token;
  try { await load(ctx, r); }
  catch (err) {
    console.warn(r.L.id + ' layer failed to load', err);
    if (my === r.token) r.wanted = false;
    return;
  }
  if (!r.wanted || my !== r.token) return;
  const src = ctx.createBufferSource();
  src.buffer = r.buf;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = Math.min(r.buf.duration, r.L.samples / LOOP_RATE);
  const g = ctx.createGain();
  g.gain.value = 0;
  // Post-fader and post-gate, before the room, as the choir's and the drone's
  // meters read; the tap feeds the dry bus and the room alike.
  const t = meterTap(ctx, dryBus, roomBus);
  src.connect(g); g.connect(t.analyser);
  src.start();
  r.src = src; r.gain = g; r.tap = t;
  glideParam(g.gain, level(r), FADE_IN_TC);
}

function stop(r) {
  r.wanted = false;
  ++r.token;
  if (!r.src) return;
  const ctx = r.gain.context;
  const src = r.src, g = r.gain, t = r.tap;
  r.src = null; r.gain = null; r.tap = null;
  // Its own curve, not glideParam: a preset transition would stretch that
  // into a line longer than the teardown below.
  const now = ctx.currentTime, p = g.gain;
  try { p.cancelAndHoldAtTime(now); }
  catch (e) { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); }
  p.setTargetAtTime(0, now, FADE_OUT_TC);
  // On Heart the fade is heard from the present, ctx.presentTime, about a
  // lookahead after currentTime (js/heart/nodes.js, late gestures), so the
  // teardown waits that much longer; natively the two are one.
  const late = ctx.presentTime === undefined ? 0 : Math.max(0, ctx.presentTime - ctx.currentTime);
  setTimeout(() => {
    try { src.stop(); } catch (e) {}
    try { src.disconnect(); g.disconnect(); t.analyser.disconnect(); } catch (e) {}
  }, TEARDOWN_MS + late * 1000);
}

const find = id => run.get(id);

// One layer's switch: parked or woken without touching the rest of the music.
export function applyLayerOn(id) {
  const r = find(id);
  if (!r || !session) return;
  if (S[layerOnKey(r.L)]) start(r); else stop(r);
}

// One layer's level, as the choir's is applied.
export function applyLayerVol(id) {
  const r = find(id);
  if (r && r.gain) glideParam(r.gain.gain, level(r), 0.2);
}

// Mute and solo, a short glide so a gate closing never clicks.
onChannelGates(() => {
  for (const r of run.values()) if (r.gain) glideParam(r.gain.gain, level(r), 0.03);
});

// The music session, from piano.js's pianoOn and pianoOff.
export function layersSession(on) {
  session = !!on;
  for (const r of run.values()) {
    if (session && S[layerOnKey(r.L)]) start(r); else stop(r);
  }
}

// Gated on the transport as the piano's meters are: a suspended context keeps
// handing back its last block.
export function layerPeak(id) {
  const r = find(id);
  return r && r.tap && S.running && S.audioEnabled && getContext()?.state === 'running' ? tapPeak(r.tap) : 0;
}
