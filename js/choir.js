// The choir: the sandbox's Choir Performer (sandbox/player.html), as a voice
// of the music.
//
// Seven held Lah notes from the boys' choir, degrees 1 2 3 5 7 8 9 of the
// mode as sung, each with its own pitch as recorded (nothing was retuned,
// and the encodes in audio/music/choir are the recordings exactly). All
// seven start together and each loops the crossfaded steady portion of its
// note, so Stack, Density, Brightness and Focus only ever move gains: the
// chord changes without a single attack being retriggered. The maths below
// is the performer's own, constant for constant.
//
// The choir lives in the music session the way the ocean drone does: piano.js
// hands it the piano's dry bus and room input (both behind the pause gate),
// starts it in pianoOn and stops it in pianoOff, and its own switch parks or
// wakes it mid-session. Its level is its own gain with the mix gate's
// 'choir' channel on it, as the drone's bedGain carries 'drone'. After it
// comes the vary-with-strobe stage (strobe-am.js), before the meter tap.
//
// Stack, Density and Level can wander. The set value is the cap, and the
// variance takes the value below it by up to that share of it: Stack at 100
// with 40% variance wanders between 60 and 100. Each leg picks a fresh depth
// anywhere from none to the full amount and eases to it on a cosine over the
// variance period, then picks the next; the three wander independently. A
// 10 Hz timer feeds the wandered values through the same targets and the
// same gain glides the sliders use (the level through level(), so mute and
// solo still gate it), and runs only while the choir sounds and some
// variance is set.
import { S } from './state.js';
import { getContext, glideParam } from './audio.js';
import { meterTap, tapPeak } from './util.js';
import { chanGate, onChannelGates } from './mixgate.js';
import { strobeAm, strobeAmEffective } from './strobe-am.js';
import { inTurn, TURN } from './load-order.js';

// Semitone above the keyboard root -> the degree sung, ascending the mode.
const LAH = { 24: '1', 26: '2', 28: '3', 31: '5', 35: '7', 36: '8', 38: '9' };
const CHOIR_PARTS = Object.entries(LAH).map(([semi, degree]) => ({
  semi: Number(semi), degree, file: `audio/music/choir/choir-${degree}.opus`
}));
const N = CHOIR_PARTS.length;
const CHOIR_LEVEL = 0.22;
const CHOIR_DENSITY_RANK = { '1': 0, '8': 1, '5': 2, '3': 3, '2': 4, '7': 5, '9': 6 };

// The per-voice trims dialled in by ear on the sandbox keyboard, keyed by the
// sample's semitone: vol in percent, cents of retune. Applied here at run
// time (gain x vol/100, playbackRate 2^(cents/1200)) rather than baked into
// the audio, so they stay editable. Any voice not listed plays as recorded.
const CHOIR_TRIM = {
  24: { vol: 100, cents: -7 },     // 1
  31: { vol: 100, cents: 17 },     // 5
  35: { vol: 100, cents: 3 },      // 7
  38: { vol: 96,  cents: 6 }       // 9
};
const NO_TRIM = { vol: 100, cents: 0 };
const choirTrim = part => CHOIR_TRIM[part.semi] || NO_TRIM;

const cosine01 = value => {
  const x = Math.max(0, Math.min(1, value));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
};

// The performer's choirTargets, writing into one array kept for good so the
// variance timer allocates nothing. Positions are the sliders' own: stack and
// density 0-100, brightness -100..100, focus 0-100.
const targets = new Float64Array(N);
function choirTargets(stackPos, densityPos, brightPos, focusPos) {
  const stack = stackPos / 100;
  const density = densityPos / 100;
  const brightness = brightPos / 100;
  // Give the centre of the fader much more resolution without changing its
  // endpoints. A signed square keeps zero and both extremes fixed, while a
  // half-scale move produces only one quarter of the full spectral tilt.
  const tilt = Math.sign(brightness) * brightness * brightness;
  const focus = cosine01(focusPos / 100);
  // Stack and Density are continuous low-pass fields over their respective
  // voice orderings. Stack expands exponentially. Density gives each added
  // harmonic exactly one sixth of the slider, using a raised-cosine fade so
  // every handoff has zero slope at both ends and never steps.
  const stackWidth = 0.05 * Math.pow(400, stack);
  // The field alone never quite goes flat (the top voice sat at 99.6% with the
  // slider at the top), so the last tenth of the slider eases its falloff to
  // nothing: a full Stack is exactly every voice at full level.
  const stackReach = cosine01((1 - stack) * 10);
  const densityPhase = density * 6;
  const centre = (tilt + 1) * 0.5 * (N - 1);
  // Focus exponentially tightens a Gaussian from an effectively flat field
  // to a one-voice spotlight. Between voice centres, adjacent voices crossfade
  // continuously. At zero Focus, Brightness is a broad exponential tilt.
  const focusWidth = 24 * Math.pow(0.42 / 24, focus);
  for (let index = 0; index < N; index++) {
    const part = CHOIR_PARTS[index];
    const tr = choirTrim(part);
    const stackGain = Math.exp(-0.5 * Math.pow(index / stackWidth, 4) * stackReach);
    const rank = CHOIR_DENSITY_RANK[part.degree];
    const densityGain = rank === 0 ? 1 : cosine01(densityPhase - (rank - 1));
    const pitch = index / (N - 1);
    const tiltLog = 2.4 * tilt * (2 * pitch - 1) - 2.4 * Math.abs(tilt);
    const distance = (index - centre) / focusWidth;
    const spotlightLog = -0.5 * distance * distance;
    // Log-domain morph: Focus=0 is the original broad tilt; Focus=1 is the
    // narrow sweep. This remains smooth through every intermediate setting.
    const brightGain = Math.exp((1 - focus) * tiltLog + focus * spotlightLog);
    targets[index] = stackGain * densityGain * brightGain * (tr.vol / 100);
  }
}

// A crossfade loop of a sung one-shot's steady middle, the performer's
// loopBuffer. Web Audio's own loop only jumps, so the seam is baked into a
// copy: the last X seconds before the loop end are faded (equal power) into
// the X seconds that lead up to the loop start, so arriving at the end
// already sounds like the start and the jump back is inaudible.
//   start: attack settled (0.75 s) plus the crossfade, so what fades in is
//          already steady singing
//   end:   the last point still within 6 dB of the note's typical level,
//          less a quarter second, found per recording
function loopBuffer(ctx, buf) {
  const sr = buf.sampleRate, n = buf.length, ch0 = buf.getChannelData(0);
  const w = Math.round(sr * 0.05), lv = [];
  for (let i = 0; i + w <= n; i += w) {
    let s = 0;
    for (let j = i; j < i + w; j++) s += ch0[j] * ch0[j];
    lv.push(Math.sqrt(s / w));
  }
  const body = lv.slice(Math.round(1 / 0.05)).sort((x, y) => x - y);
  const ref = body.length ? body[body.length >> 1] : 0;
  let last = lv.length - 1;
  while (last > 0 && lv[last] < ref * 0.5) last--;
  const X = 0.75, a = 0.75 + X;
  const b = Math.min(n / sr, Math.max(a + 2 * X, last * 0.05 - 0.25));
  const A = Math.round(a * sr), B = Math.round(b * sr), XN = Math.round(X * sr);
  const out = ctx.createBuffer(buf.numberOfChannels, n, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src);
    for (let i = 0; i < XN; i++) {
      const f = (i / XN) * Math.PI / 2;
      dst[B - XN + i] = src[B - XN + i] * Math.cos(f) + src[A - XN + i] * Math.sin(f);
    }
  }
  return { buf: out, a: A / sr, b: B / sr };
}

// Loaded the first time the choir is switched on, not with the piano: a
// session that never sings never fetches it. Each voice keeps its loop copy.
// Last in the queue, after the drone, the piano and the clouds
// (js/load-order.js).
const loops = new Map();          // semi -> { buf, a, b }
let loading = null;
function loadChoir(ctx) {
  if (loops.size === N) return Promise.resolve();
  if (loading) return loading;
  loading = inTurn(TURN.choir, () => Promise.all(CHOIR_PARTS.map(async part => {
    if (loops.has(part.semi)) return;
    const r = await fetch(part.file);
    if (!r.ok) throw new Error(part.file + ': ' + r.status);
    loops.set(part.semi, loopBuffer(ctx, await ctx.decodeAudioData(await r.arrayBuffer())));
  }))).finally(() => { loading = null; });
  return loading;
}

// ---------- the graph ----------
let dryBus = null, roomBus = null;   // the piano's dry bus and room input (piano.js)
let session = false;                 // the music is running (pianoOn .. pianoOff)
let wanted = false, token = 0;
let voices = null, chain = null, tap = null, am = null;
let effStack = 100, effDensity = 100, effVolDepth = 0;

// Live values for UI meters/fills. They expose the same wander values the
// audio graph is using, without making the control schema reproduce the
// wanderer's rolling cosine legs.
export const choirEffectiveLevel = () => Math.max(0, S.choirVol) * (1 - effVolDepth);
export const choirEffectiveStack = () => effStack;
export const choirEffectiveDensity = () => effDensity;

// piano.js, once its graph is built.
export function setChoirBus(dry, roomIn) { dryBus = dry; roomBus = roomIn; }

// The set level less the level variance's current depth, gated, and times
// v1's Music window trim (S.musChoir, 0 to 1, where 1 plays exactly the set
// level; v0 never sets it, so unset reads as 1). choirEffectiveLevel above
// leaves the trim out: it is the level's own fill, which shows the level.
const perfTrim = v => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
const level = () => Math.max(0, S.choirVol) * (1 - effVolDepth) * perfTrim(S.musChoir ?? 1) * chanGate('choir');

// Every per-voice gain toward its target, from exactly where it is now, so
// repeated input stays continuous without restarting a long curve.
function applyChoirTargets(duration) {
  if (!voices) return;
  choirTargets(effStack, effDensity, S.choirBrightness, S.choirFocus);
  const now = getContext().currentTime;
  const tc = Math.max(0.008, duration / 4);
  for (let i = 0; i < voices.length; i++) {
    const param = voices[i].gain.gain;
    try { param.cancelAndHoldAtTime(now); }
    catch (err) { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
    param.setTargetAtTime(targets[i] * CHOIR_LEVEL, now, tc);
  }
}

// The performer's release: a cosine to silence, each voice a hair after the
// one below it.
function cosineParam(ctx, param, target, duration, delay) {
  const now = ctx.currentTime;
  let from = param.value;
  try {
    param.cancelAndHoldAtTime(now);
    from = param.value;
  } catch (err) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
  }
  const start = now + delay;
  param.setValueAtTime(from, start);
  if (duration <= 0.005) { param.setValueAtTime(target, start); return; }
  const curve = new Float32Array(48);
  for (let i = 0; i < curve.length; i++) {
    const u = i / (curve.length - 1);
    curve[i] = from + (target - from) * cosine01(u);
  }
  param.setValueCurveAtTime(curve, start + 0.001, duration);
}

async function choirStart() {
  if (wanted) return;
  const ctx = getContext();
  if (!ctx || !dryBus || !roomBus) return;
  wanted = true;
  const my = ++token;
  try { await loadChoir(ctx); }
  catch (err) {
    console.warn('choir failed to load', err);
    if (my === token) wanted = false;
    return;
  }
  if (!wanted || my !== token) return;
  // the level wander starts from the cap, as Stack and Density do below
  resetWander(volW, ctx.currentTime);
  wanderVol(ctx.currentTime);
  const g = ctx.createGain();
  g.gain.value = level();
  // Post-fader and post-gate, before the room, the same point the drone's
  // meter reads; the tap feeds the dry bus and the room alike. The strobe
  // stage sits between, so the meter shows the pulse.
  const t = meterTap(ctx, dryBus, roomBus);
  const a = strobeAm(ctx, () => S.choirStrobeAm, () => S.choirStrobeAmVar, () => S.choirStrobeAmPeriod);
  g.connect(a.node); a.node.connect(t.analyser);
  voices = CHOIR_PARTS.map(part => {
    const loop = loops.get(part.semi);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = loop.buf; source.loop = true; source.loopStart = loop.a; source.loopEnd = loop.b;
    source.playbackRate.value = Math.pow(2, choirTrim(part).cents / 1200);
    gain.gain.value = 0;
    source.connect(gain); gain.connect(g);
    source.start();
    return { source, gain };
  });
  chain = g; tap = t; am = a;
  resetWander(stackW, ctx.currentTime);
  resetWander(densW, ctx.currentTime);
  wanderLevels(ctx.currentTime);
  // the performer's opening: every voice rising to its place from silence
  applyChoirTargets(1.6);
  syncWanderTimer();
}

function choirStop() {
  wanted = false;
  ++token;
  stopWanderTimer();
  if (!voices) return;
  const ctx = getContext();
  const vs = voices, g = chain, t = tap, a = am;
  voices = null; chain = null; tap = null; am = null;
  const duration = 1.1;
  for (let i = 0; i < vs.length; i++) {
    // a curve refused (it overlapped something) still leaves the voice going
    // quiet, so the teardown below always runs
    try { cosineParam(ctx, vs[i].gain.gain, 0, duration, i * 0.02); }
    catch (e) { vs[i].gain.gain.setTargetAtTime(0, ctx.currentTime, duration / 4); }
  }
  setTimeout(() => {
    for (const v of vs) {
      try { v.source.stop(); } catch (e) {}
      try { v.source.disconnect(); v.gain.disconnect(); } catch (e) {}
    }
    try { g.disconnect(); t.analyser.disconnect(); } catch (e) {}
    if (a) a.stop();
  }, (duration + 0.2 + vs.length * 0.02) * 1000);
}

// ---------- the variance wander ----------
// One leg at a time: from `from` to `to` (depths, 0 to the amount) over
// `dur` seconds of the audio clock from t0, on a cosine. `period` is the
// setting the leg was laid with.
const stackW = { from: 0, to: 0, t0: 0, dur: 0.5, period: -1 };
const densW  = { from: 0, to: 0, t0: 0, dur: 0.5, period: -1 };
const volW   = { from: 0, to: 0, t0: 0, dur: 0.5, period: -1 };
const MIN_LEG = 0.5;
let wanderTimer = null;

// Back to the cap, with the next leg due at once.
function resetWander(w, now) {
  w.from = 0; w.to = 0; w.t0 = now - MIN_LEG; w.dur = MIN_LEG; w.period = -1;
}
const legAt = (w, now) => w.from + (w.to - w.from) * cosine01((now - w.t0) / w.dur);

function wanderDepth(w, amount, period, now) {
  if (!(amount > 0)) { resetWander(w, now); return 0; }
  const legDur = Math.max(MIN_LEG, +period || 0);
  // A new speed takes over from wherever the wander is, rather than making
  // a long leg run out first.
  if (w.period !== -1 && w.period !== period) {
    w.from = legAt(w, now); w.t0 = now; w.dur = legDur;
  }
  w.period = period;
  if (now - w.t0 >= w.dur) {
    w.from = w.to; w.to = Math.random() * amount; w.t0 = now; w.dur = legDur;
  }
  // a lowered amount takes effect at once, never left below the new floor
  return Math.min(legAt(w, now), amount);
}

const clampVar = v => Math.max(0, Math.min(1, +v || 0));
function wanderLevels(now) {
  effStack = S.choirStack * (1 - wanderDepth(stackW, clampVar(S.choirStackVar), S.choirStackPeriod, now));
  effDensity = S.choirDensity * (1 - wanderDepth(densW, clampVar(S.choirDensityVar), S.choirDensityPeriod, now));
}
// The level's leg kept apart from the voices' two, so the level control
// moves only the chain gain and the voice controls only the voices.
function wanderVol(now) {
  effVolDepth = wanderDepth(volW, clampVar(S.choirVolVar), S.choirVolPeriod, now);
}

function wanderTick() {
  if (!voices) { stopWanderTimer(); return; }
  const now = getContext().currentTime;
  const s0 = effStack, d0 = effDensity, v0 = effVolDepth;
  wanderLevels(now);
  wanderVol(now);
  if (effStack !== s0 || effDensity !== d0) applyChoirTargets(0.4);
  // the same time constant the voices glide on above, so 10 Hz steps blend
  if (effVolDepth !== v0 && chain) glideParam(chain.gain, level(), 0.1);
}

function stopWanderTimer() {
  if (wanderTimer) { clearInterval(wanderTimer); wanderTimer = null; }
}
function syncWanderTimer() {
  const need = !!voices && (clampVar(S.choirStackVar) > 0 || clampVar(S.choirDensityVar) > 0 ||
    clampVar(S.choirVolVar) > 0);
  if (need && !wanderTimer) wanderTimer = setInterval(wanderTick, 100);
  else if (!need) stopWanderTimer();
}

// ---------- the controls ----------
// Stack, Density, Brightness, Focus and the two variances: the gains glide
// to the new targets, nothing retriggers.
export function applyChoir() {
  if (!voices) return;
  wanderLevels(getContext().currentTime);
  applyChoirTargets(0.075);
  syncWanderTimer();
}

// The choir's level and its variance, as the drone's level is applied.
export function applyChoirVol() {
  if (!chain) return;
  wanderVol(getContext().currentTime);
  glideParam(chain.gain, level(), 0.2);
  syncWanderTimer();
}

// Vary with strobe: the depth glides to the new setting.
export function applyChoirAm() {
  if (am) am.apply();
}
// the depth as it plays, wander included, for the slider's glow
export const choirEffectiveAm = () => strobeAmEffective(am);

// Mute and solo, a short glide so a gate closing never clicks.
onChannelGates(() => {
  if (chain) glideParam(chain.gain, level(), 0.03);
});

// The choir's own switch: parked or woken without touching the rest of the
// music. Off mid-session fades it out; on brings it in with its opening.
export function applyChoirOn() {
  if (!session) return;
  if (S.choirOn) choirStart(); else choirStop();
}

// The music session, from piano.js's pianoOn and pianoOff.
export function choirSession(on) {
  session = !!on;
  if (session && S.choirOn) choirStart(); else choirStop();
}

// Gated on the transport as the piano's meters are: a suspended context keeps
// handing back its last block.
export const choirPeak = () =>
  tap && S.running && S.audioEnabled && getContext()?.state === 'running' ? tapPeak(tap) : 0;
