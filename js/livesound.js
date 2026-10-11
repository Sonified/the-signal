// Live Sound: a microphone or a line input, played into the experience.
//
// Whatever comes in through the chosen input passes a compressor, set from
// the drawer, then splits: a dry path and a room of its own,
// crossfaded into one bus by the Reverb mix, the voice. That voice is the
// designed sound, and it goes two places. The broadcast tap takes it whole
// (liveBroadcastStream, below). The local monitor takes it through the level
// fader and a gate that follows the transport, out to the speakers.
//
// All of it lives in an audio context of its own, not the app's. The main
// context asks for a deliberately fat buffer ('playback', js/audio.js),
// which is right for a synth nobody is playing along with and wrong for a
// voice heard back in headphones: through that buffer the monitor came back
// a good few hundred ms behind the singer. So the input gets a context made
// for it, asking for as small a buffer as the Latency slider says (the least
// the hardware offers, by default), and the rest of the sound keeps the
// cushion it was built around. The two meet only at the speakers.
//
// The input is opened only when the layer is switched on, never at boot, and
// switching it off stops the tracks, so the browser's microphone light goes
// out with it, and closes the context. The switch itself is never saved
// (core/store.js keeps the input, the level, the room, the compressor and
// the latency in a record of their own and leaves the switch out), so a reload always comes
// up with the input closed and nothing is ever opened before someone asks
// for it. A refusal fails soft: a warning in the console, the switch back to
// off, and the next switch on asks again.
//
// The browser's voice processing is turned off on the way in. Echo
// cancellation, noise suppression and automatic gain are made for a call:
// they duck under the speakers, gate the quiet tails of a held note, and pump
// the level about. This is music, so the input arrives as it is played.
//
// Monitoring through speakers feeds the microphone back into itself and
// howls. The level starts modest for that reason; headphones are the way to
// listen to it properly.
//
// In worker mode this module is loaded twice: in the worker, where the
// drawer draws and nothing can be captured, and on the page, where the audio
// shell (core/audio-shell.js) runs every set() the worker makes, so the
// page's copy is the one that captures. The page tells the worker what it
// found (the inputs, whether an attempt failed, and the latency it got)
// through liveFromPage, and how hard the compressor is working through
// liveGrFromPage, by way of platform/worker-bridge.js and worker-entry.js.
import { S } from './state.js';
import { createRoom, swapRoom } from './audio.js';
import { setAudioSessionRecording } from './background.js';
import { createGlobalFilter } from '../core/global-filter.js';

// The compressor. Its defaults are gentle glue rather than a limiter: a 3:1
// ratio from about -24 dB, over a knee 30 dB wide, so it starts leaning on
// the signal long before the threshold and never audibly clamps; a voice or
// an instrument keeps its dynamics and only sits a little more evenly in the
// mix. A 3 ms attack lets the front of a note through before it acts, so
// consonants and plucks keep their edge; 250 ms of release lets go slowly
// enough not to pump on a sustained note. The threshold, the ratio, the
// attack and the release are the drawer's now (S.liveThreshold and its
// neighbours, which start at exactly those values); the knee stays
// programmed, since its width is what keeps any setting from clamping. The
// browser's compressor also adds its own makeup gain (about +9 dB at the
// defaults, and more the lower the threshold and the higher the ratio),
// which is why the level below starts well down.
//
// A setting moves its parameter on a short glide, so a drag across the
// threshold sweeps rather than steps. The defaults here only catch a value
// that is missing or not a number.
const COMP_KNEE_DB = 30, COMP_TC = 0.05;
const COMP_THRESHOLD_DB = -24, COMP_RATIO = 3, COMP_ATTACK_MS = 3, COMP_RELEASE_MS = 250;

// The room. The shared music room (js/piano.js) would be the natural home,
// the way the drone and the sequencer feed it with a share slider each, but
// it lives in the main context, exists only while the piano's graph is
// built, and its wet level belongs to the Master reverb switch. Live Sound
// stands outside the music engine, as the ambience does, so it has a room of
// its own the way the ambience has (js/ambience.js): the same double-convolver
// room from audio.js, built fresh in each live context at whatever length the
// Decay slider holds (three seconds to begin with) and never carried from one
// context to the next.
//
// A new length is the ambience's move too. The impulse is built off the main
// thread behind the slider (swapRoom's delay, so a drag builds only where it
// comes to rest), goes into the room's idle convolver, and the two cross in
// straight lines over audio.js's short room crossfade (0.3 s): the new room
// fills from the sound going into it as the old one's tail fades under it,
// so nothing clicks and no tail stops dead.
//
// The Reverb slider is a mix, not a send: at 0 the voice is all dry, at 100
// all room, with no dry signal left at all. The two sides cross on an
// equal-power law (dry cos, wet sin of the mix over a quarter turn), so the
// middle of the travel neither dips nor swells in loudness.
const ROOM_S = 3.0, ROOM_DECAY = 2.0, ROOM_MIN_S = 0.5, ROOM_MAX_S = 8, ROOM_SWAP_MS = 250;
const QUARTER_TURN = Math.PI / 2;

// Each capture comes in on a gain of its own, faded up from nothing and back
// down to it, so a switch on, a switch off or a change of input never clicks.
// The old one's tracks stop once its fade has landed; a context being let go
// fades its voice the same way before it is closed.
const FADE_TC = 0.03, RETIRE_MS = 250;
// The level and the mix glide on this time constant, as they always have.
const MOVE_TC = 0.1;

// The monitor's gate. In the main context the monitor ran through the pause
// gate and the master, so a pause silenced it (tail and all), the Audio
// layer switched off silenced it, and the master volume scaled it. Here it
// cannot reach either, so it keeps its own gate and follows the same three
// things: open at the master volume while the session runs with audio on,
// shut otherwise. They are read from the shared state twenty times a
// second while a context is open, and the gate moves on a constant that
// lands in about the 0.12 s the pause gate takes (js/audio.js sourceGate).
const GATE_POLL_MS = 50, GATE_TC = 0.04;

// The Latency slider: the buffer asked of the live context, in ms, 0 to 100.
// 0 is a latencyHint of 0, which asks the hardware for the least it can do.
// latencyHint is fixed when a context is made, so a change while capturing
// builds a new one (see rebuild, below), held back until the slider has
// stopped for a moment so a drag does not make a context at every step.
const LATENCY_MAX_MS = 100, REBUILD_MS = 300;

// Worker mode's engine thread has no AudioContext and no microphone; its
// copy of this module only keeps the list the page sends it.
const IN_WORKER = typeof WorkerGlobalScope !== 'undefined';
const media = () => (!IN_WORKER && typeof navigator !== 'undefined' && navigator.mediaDevices) || null;

let graph = null;      // the live context and its chain, built when a capture starts and closed with it
let cap = null;        // the capture sounding now: { stream, src, g, ctx }
let token = 0;         // the newest request; an older one landing late is dropped
let busy = false;      // a request is waiting on the browser
let rebuildTimer = null;
let inputs = [];       // [{ id, label }], the audio inputs this browser lists
let reportedMs = -1;   // worker mode: the latency the page's context got, -1 unknown
let reportedGr = NaN;  // worker mode: the compressor's gain reduction on the page, NaN while none is open
const listeners = [];

// The monitor's gain: the Live Sound level times v1's Music window trim
// (S.musLive, 0 to 1, where 1 plays exactly the level), as the ambience's is.
const perfTrim = v => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
const monitorLevel = () => Math.max(0, S.liveLevel || 0) * perfTrim(S.musLive ?? 1);
const monitorGate = () => (S.running && S.audioEnabled) ? Math.max(0, S.volume || 0) : 0;
const mixOf = () => Math.max(0, Math.min(1, S.liveReverb || 0));
const latencyMs = () => Math.max(0, Math.min(LATENCY_MAX_MS, Math.round(S.liveLatency || 0)));
// The drawer's settings as the nodes want them, each held to its slider's
// range, with the programmed default standing in for anything unreadable.
const within = (v, lo, hi, def) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
const roomSec = () => within(S.liveRevTime, ROOM_MIN_S, ROOM_MAX_S, ROOM_S);
const compThreshold = () => within(S.liveThreshold, -60, 0, COMP_THRESHOLD_DB);
const compRatio = () => within(S.liveRatio, 1, 20, COMP_RATIO);
const compAttack = () => within(S.liveAttack, 0, 100, COMP_ATTACK_MS) / 1000;
const compRelease = () => within(S.liveRelease, 10, 1000, COMP_RELEASE_MS) / 1000;

// ---------- the live context ----------

// A new context asking for the Latency slider's buffer, with the whole chain
// built inside it. Nothing here touches the app's own context.
function makeGraph() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  const ms = latencyMs();
  let ctx;
  try { ctx = new AC({ latencyHint: ms / 1000 }); }
  catch (e) {
    // an older engine that takes no options: its own buffer, then
    try { ctx = new AC(); } catch (e2) { return null; }
  }
  // A new context starts from whatever the drawer holds now, the compressor
  // and the room's length alike, so a latency rebuild changes nothing else.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = compThreshold();
  comp.knee.value = COMP_KNEE_DB;
  comp.ratio.value = compRatio();
  comp.attack.value = compAttack();
  comp.release.value = compRelease();
  // the designed sound: the dry side and the room's return, crossed by the mix
  const m = mixOf();
  const dry = ctx.createGain(), wet = ctx.createGain();
  dry.gain.value = Math.cos(m * QUARTER_TURN);
  wet.gain.value = Math.sin(m * QUARTER_TURN);
  const room = createRoom(ctx, roomSec, ROOM_DECAY);
  comp.connect(dry);
  comp.connect(room.input);
  room.output.connect(wet);
  const voice = ctx.createGain();
  dry.connect(voice);
  wet.connect(voice);
  // The local monitor. The gate sits after the room, so a pause silences the
  // monitor, tail and all, while the broadcast tap, taken from the voice
  // above it, keeps hearing the input whatever this tab's transport is doing.
  const level = ctx.createGain();
  level.gain.value = monitorLevel();
  const gate = ctx.createGain();
  // the app's global Lowpass and Highpass (core/global-filter.js) on the
  // monitor's way out; the broadcast tap, taken above, is left unfiltered
  const gf = createGlobalFilter(ctx);
  const g = { ctx, ms, comp, dry, wet, room, voice, level, gate, gf, tap: null, gateTo: monitorGate(), poll: null };
  gate.gain.value = g.gateTo;
  voice.connect(level);
  level.connect(gate);
  gate.connect(gf.input);
  gf.output.connect(ctx.destination);
  g.poll = setInterval(() => followGate(g), GATE_POLL_MS);
  // The latency is only known for certain once the context is running (the
  // output's share especially), so the worker's readout is told again then.
  ctx.addEventListener('statechange', () => { if (graph === g && ctx.state === 'running') notify(false); });
  wake(ctx);
  return g;
}

// A context made inside the switch's click starts at once. One made later
// (a rebuild behind the Latency slider) may come up suspended where the
// browser wants a gesture; an open capture lifts that in the browsers that
// ask, so it is simply asked again once the input is in.
function wake(ctx) {
  if (ctx.state !== 'suspended') return;
  try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

function followGate(g) {
  const to = monitorGate();
  if (to === g.gateTo) return;
  g.gateTo = to;
  g.gate.gain.setTargetAtTime(to, g.ctx.currentTime, GATE_TC);
}

// Lets a context go: its voice fades to nothing, then it is closed, which
// frees every node in it, the room and the broadcast tap included. The
// input's tracks are not this function's business.
function closeGraph(g) {
  clearInterval(g.poll);
  if (g.gf) g.gf.dispose();
  // a new room length still waiting behind the Decay slider is the next context's to build
  clearTimeout(g.room.timer);
  try { g.voice.gain.setTargetAtTime(0, g.ctx.currentTime, FADE_TC); } catch (e) {}
  setTimeout(() => {
    try { const p = g.ctx.close(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }, RETIRE_MS);
}

// ---------- the capture ----------

function constraints(deviceId) {
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) { try { t.stop(); } catch (e) {} }
}

// Brings a granted stream into the current context, faded up from nothing.
// The stream belongs to no context, so a rebuild plugs the same one into
// the next without asking the browser again.
function attach(stream) {
  const ctx = graph.ctx;
  const src = ctx.createMediaStreamSource(stream);
  // Folded to one channel on the way in. Many interfaces present as a stereo
  // pair with the microphone in input 1 alone, which would put the voice
  // hard left; summed, it sits in the centre, and the room around it spreads
  // evenly to both sides.
  const g = ctx.createGain();
  g.channelCount = 1;
  g.channelCountMode = 'explicit';
  g.channelInterpretation = 'speakers';
  g.gain.value = 0;
  src.connect(g);
  g.connect(graph.comp);
  g.gain.setTargetAtTime(1, ctx.currentTime, FADE_TC);
  wake(ctx);
  return { stream, src, g, ctx };
}

// Fades a capture out, then unplugs it, and stops its tracks when asked to
// (always, except in a rebuild, which carries the stream on).
function retire(c, stopTracks) {
  try {
    const p = c.g.gain, now = c.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.setTargetAtTime(0, now, FADE_TC);
  } catch (e) {}
  setTimeout(() => {
    if (stopTracks) stopStream(c.stream);
    try { c.src.disconnect(); c.g.disconnect(); } catch (e) {}
  }, RETIRE_MS);
}

// Everything closed: the capture retired with its tracks, the context let
// go, any request still out dropped when it lands.
function shut() {
  ++token;
  busy = false;
  clearTimeout(rebuildTimer);
  rebuildTimer = null;
  if (cap) { retire(cap, true); cap = null; }
  if (graph) { closeGraph(graph); graph = null; }
  setAudioSessionRecording(false);
}

function notify(failed) {
  for (let i = 0; i < listeners.length; i++) {
    try { listeners[i](failed); } catch (e) { console.warn('live sound: a listener failed', e); }
  }
}

// Soft: the switch reads off again, the input and its context are closed,
// and the next switch on asks again.
function failed(err) {
  console.warn('live sound: could not open the input' +
    (err && err.name ? ' (' + err.name + (err.message ? ': ' + err.message : '') + ')' : ''), err);
  S.liveOn = false;
  shut();
  notify(true);
}

// Opens the chosen input (or the default) and brings it in. A new capture
// fades in over the old one, which then retires, so a change of input is a
// short crossfade. The context is made before the browser is asked for the
// input, while the switch's click is still the gesture in hand.
async function acquire() {
  if (IN_WORKER) return;
  const md = media();
  if (!md || !md.getUserMedia) { failed(new Error('this browser offers no audio input here')); return; }
  // An iPhone's session can only record as 'play-and-record', set before
  // the context and the request (js/background.js); shut puts it back.
  setAudioSessionRecording(true);
  if (!graph) graph = makeGraph();
  if (!graph) { failed(new Error('this browser offers no audio context here')); return; }
  const my = ++token;
  busy = true;
  const want = S.liveDevice || '';
  let stream = null, error = null;
  try { stream = await md.getUserMedia(constraints(want)); }
  catch (err) { error = err; }
  // A chosen input that is not there (unplugged, or an id saved by another
  // browser) falls back to the default rather than leaving the layer silent.
  if (!stream && want && error && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
    try { stream = await md.getUserMedia(constraints('')); error = null; }
    catch (err) { error = err; }
  }
  if (my !== token) { stopStream(stream); return; }
  busy = false;
  if (!stream) { failed(error); return; }
  if (!S.liveOn || !graph) { stopStream(stream); return; }
  const old = cap;
  cap = attach(stream);
  if (old) retire(old, true);
  // An input that ends on its own (unplugged, or permission taken back in
  // the browser's settings) reads as off, as a refusal does. The stream
  // outlives any rebuild, so this is listened for once, here.
  const track = stream.getAudioTracks()[0];
  if (track) track.addEventListener('ended', () => {
    if (!cap || cap.stream !== stream) return;
    failed(new Error('the input ended'));
  });
  notify(false);
  // Labels are blank until the first grant, so the list is read again now.
  refreshInputs();
}

function release() {
  const had = !!(cap || graph);
  shut();
  if (had) notify(false);
}

// A new latency while the context is open: a new context with the new
// buffer, and the chain built again inside it. The capture moves across on
// the stream it already has, so the browser does not ask again and the
// microphone light never blinks. The two contexts overlap for a moment, the
// new one fading in as the old one fades out and is closed, which keeps the
// swap from clicking; the room starts empty in the new one and fills again
// from there.
//
// To anyone listening it reads as the capture stopping and starting again,
// and it is announced as exactly that, one onLiveChange for each edge. The
// broadcast tap is one of the nodes rebuilt, so the stream handed out by
// liveBroadcastStream is a new object afterwards, which the transport
// (core/live-audio.js) sees as a new recording to start.
function rebuild() {
  rebuildTimer = null;
  if (!graph || graph.ms === latencyMs()) return;
  const moving = cap;
  cap = null;
  closeGraph(graph);
  graph = null;
  if (moving) notify(false);
  graph = makeGraph();
  if (!graph) {
    if (moving) stopStream(moving.stream);
    failed(new Error('this browser could not open a new audio context'));
    return;
  }
  if (moving) {
    cap = attach(moving.stream);
    notify(false);
  }
}

// ---------- the inputs ----------
// The browser's own 'default' and 'communications' entries are left out:
// the dropdown's first option, the empty id, already means the system's
// default. Before any grant most browsers hand back blank ids and labels,
// which are left out too, so the list is simply empty until then.
function sameInputs(next) {
  if (next.length !== inputs.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i].id !== inputs[i].id || next[i].label !== inputs[i].label) return false;
  }
  return true;
}
function refreshInputs() {
  const md = media();
  if (!md || !md.enumerateDevices) return;
  md.enumerateDevices().then(list => {
    const next = [];
    for (const d of list) {
      if (d.kind !== 'audioinput' || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
      next.push({ id: d.deviceId, label: d.label || 'Input ' + (next.length + 1) });
    }
    if (sameInputs(next)) return;
    inputs = next;
    notify(false);
  }, () => {});
}
// Read once now (with a grant from an earlier visit the labels are already
// there) and again whenever something is plugged in or pulled out.
if (media()) {
  refreshInputs();
  try { media().addEventListener('devicechange', refreshInputs); } catch (e) {}
}

// ---------- the controls (core/schema-audio.js) ----------
export function applyLiveOn() {
  if (S.liveOn) { if (!cap && !busy) acquire(); }
  else release();
}
// A new input while live is opened at once and crossfaded in.
export function applyLiveDevice() {
  if (S.liveOn && (cap || busy)) acquire();
}
export function applyLiveLevel() {
  if (graph) graph.level.gain.setTargetAtTime(monitorLevel(), graph.ctx.currentTime, MOVE_TC);
}
export function applyLiveReverb() {
  if (!graph) return;
  const m = mixOf(), now = graph.ctx.currentTime;
  graph.dry.gain.setTargetAtTime(Math.cos(m * QUARTER_TURN), now, MOVE_TC);
  graph.wet.gain.setTargetAtTime(Math.sin(m * QUARTER_TURN), now, MOVE_TC);
}
// The room's new length, crossfaded in once the slider has rested (see the
// room, above). swapRoom reads the length again when its delay runs out, so
// the last place the slider stopped is the one built.
export function applyLiveRevTime() {
  if (graph) swapRoom(graph.room, ROOM_SWAP_MS);
}
// All four at once: each is a short glide, and the ones that did not move
// glide to where they already are.
export function applyLiveComp() {
  if (!graph) return;
  const c = graph.comp, now = graph.ctx.currentTime;
  c.threshold.setTargetAtTime(compThreshold(), now, COMP_TC);
  c.ratio.setTargetAtTime(compRatio(), now, COMP_TC);
  c.attack.setTargetAtTime(compAttack(), now, COMP_TC);
  c.release.setTargetAtTime(compRelease(), now, COMP_TC);
}
// With nothing open there is nothing to do: the next capture reads the
// setting when it makes its context.
export function applyLiveLatency() {
  if (IN_WORKER || !graph) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, REBUILD_MS);
}

// What the live context actually got, in whole ms: its own buffer plus the
// output's, where the browser says (only the first where it does not). -1
// while no context is open, or where the browser tells nothing. In the
// worker, the page's last report.
export function liveLatencyNow() {
  if (IN_WORKER) return reportedMs;
  if (!graph) return -1;
  const c = graph.ctx, base = c.baseLatency, out = c.outputLatency;
  if (!Number.isFinite(base)) return -1;
  return Math.round((base + (Number.isFinite(out) ? out : 0)) * 1000);
}

// How far the compressor is pulling the sound down right now, in dB: 0 when
// it is resting, negative while it works, NaN while no context is open. The
// audio thread keeps the node's figure current, so this is a plain read.
// (Older WebKit gave it as an AudioParam rather than a number.) In the
// worker, the page's last report.
export function liveReductionNow() {
  if (IN_WORKER) return reportedGr;
  if (!graph) return NaN;
  const r = graph.comp.reduction;
  const db = typeof r === 'number' ? r : r && r.value;
  return Number.isFinite(db) ? db : NaN;
}

// Worker mode: the page's reading, a few times a second while it moves
// (platform/worker-bridge.js). A reading is not a change of state, so no
// listener hears about it; the drawer simply reads it when it draws.
export function liveGrFromPage(db) {
  reportedGr = typeof db === 'number' ? db : NaN;
}

// The inputs as the dropdown lists them, { id, label } each.
export const liveInputs = () => inputs;

// Called with (failed) whenever the capture starts or stops (a latency
// rebuild is both, in that order), the input list changes, an attempt
// fails, or a new context starts running; once straight away on subscribing.
export function onLiveChange(fn) {
  listeners.push(fn);
  try { fn(false); } catch (e) { console.warn('live sound: a listener failed', e); }
}

// Worker mode: the page's report, arriving in the worker. The list replaces
// the worker's, and a failure turns the worker's switch off too, so the
// drawer there reads the truth; the latency the page got goes beside the
// Latency slider.
export function liveFromPage(msg) {
  if (!msg) return;
  if (Array.isArray(msg.inputs)) {
    const next = [];
    for (const d of msg.inputs) {
      if (d && typeof d.id === 'string' && d.id) next.push({ id: d.id, label: String(d.label || d.id) });
    }
    if (!sameInputs(next)) inputs = next;
  }
  if (typeof msg.ms === 'number' && Number.isFinite(msg.ms)) reportedMs = msg.ms;
  if (msg.failed) S.liveOn = false;
  notify(!!msg.failed);
}

// ---------- the broadcast tap ----------
// The broadcast side (core/broadcast.js and its transport) imports this.
// A MediaStream of the designed sound while the layer is on and capturing,
// otherwise null. It is taken from the voice, after the compressor and the
// reverb mix, and before the local level fader and the monitor's gate, at
// unity: the broadcast hears the sound as designed even with the monitor
// pulled all the way down, which is how a broadcaster listens without
// feeding the speakers back into the microphone.
//
// The destination node lives in the live context, made the first time this
// is asked for and kept with it, so for as long as one capture lives every
// call returns the same stream object. A new context means a new object: the
// layer switched off and on again, or a latency rebuild, which swaps the
// context under a capture that carries on. The old stream simply goes dead.
// So a consumer holds the object only to compare, and fetches it again on
// every onLiveChange (and may on any other occasion) rather than keeping the
// one it first got. Page thread only (in the worker there is no capture, and
// this is always null).
export function liveBroadcastStream() {
  if (!cap || !graph) return null;
  if (!graph.tap) {
    graph.tap = graph.ctx.createMediaStreamDestination();
    graph.voice.connect(graph.tap);
  }
  return graph.tap.stream;
}
