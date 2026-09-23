// The generative piano.
//
// Not a random note picker. Every rule and every default here came out of
// measuring four takes played by hand, and the comments say which measurement.
// The instrument is a felt piano tuned so its root sits two octaves under the
// 40 Hz carrier, which means the music and the entrainment tone are the same
// number rather than merely compatible.
import { S } from './state.js';
import { getContext, getMaster } from './audio.js';
import { meterTap, tapPeak } from './util.js';

const SEMIS = [0,2,4,5,7,9,11,12,14,16,17,19,21,23,24,26,28,29,31,33,35,36,38,40];
const RELEASES = 18;
const ROOT = 48;                       // written C3; sounds ~79.5 Hz
const DEG  = [0, 2, 4, 7, 11];         // 1 2 3 5 7
const LO = ROOT, HI = ROOT + 40;

// Degree weighting straight from the longest take: the root was used twice as
// often as anything else, the second was the rarest.
const DEG_W = { 0: 22, 2: 7, 4: 10, 7: 11, 11: 10 };

const notes = new Map();
const lifts = [];
let bed = null, bedGain = null, bedMeta = null;
let bedTakes = [], bedNextAt = 0, bedTimer = null, bedRunning = false;
let ready = false, loading = null;
let dry = null, verb = null, wet = null, hp = null;
let noteTap = null, bedTap = null;
let running = false, clock = 0, elapsed = 0, drift = 0, lastDyad = 0, timer = null;

const canOpus = (() => {
  const a = new Audio();
  return a.canPlayType('audio/ogg; codecs=opus') !== ''
      || a.canPlayType('audio/webm; codecs=opus') !== '';
})();

function impulse(ctx, sec, decay) {
  const n = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/n, decay);
  }
  return b;
}

// Loaded on demand rather than at boot: four megabytes should not be fetched by
// someone who never turns the music on.
export function loadPiano() {
  if (loading) return loading;
  const ctx = getContext();
  if (!ctx || !canOpus) return Promise.resolve(false);
  loading = (async () => {
    const get = async u => ctx.decodeAudioData(await (await fetch(u)).arrayBuffer());
    await Promise.all([
      ...SEMIS.map(async s =>
        notes.set(s, await get(`audio/piano/lekko-${String(s).padStart(2,'0')}.opus`))),
      ...Array.from({ length: RELEASES }, async (_, i) => {
        lifts[i] = await get(`audio/piano/releases/release-${String(i).padStart(2,'0')}.opus`);
      })
    ]);
    buildGraph();
    // the ocean drone, loaded alongside; its loop points come from the manifest
    try {
      bedMeta = await (await fetch('audio/music/manifest.json')).json();
      bed = await get('audio/music/ocean-cavern.opus');
    } catch (e) { bed = null; }
    ready = true;
    return true;
  })().catch(err => { console.warn('piano failed to load', err); loading = null; return false; });
  return loading;
}

function buildGraph() {
  const ctx = getContext(), master = getMaster();
  if (!ctx || !master) return;
  dry  = ctx.createGain(); dry.gain.value = 1;
  verb = ctx.createConvolver(); verb.buffer = impulse(ctx, S.pianoRevTime, 2.0);
  wet  = ctx.createGain(); wet.gain.value = S.pianoReverb;
  dry.connect(master);
  verb.connect(wet).connect(master);
  // A high-pass on the notes only, ahead of the room so the reverb is fed the
  // same thinned signal the dry path gets; filtering after the convolver would
  // leave a low bloom in the tail that the dry note no longer has. The drone
  // bypasses it: it is its own voice with its own level. 12 dB an octave at
  // Butterworth Q, gentle enough to take mud out without hollowing the tone.
  // 20 Hz is the floor and is effectively off.
  hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.Q.value = Math.SQRT1_2;
  hp.frequency.value = S.pianoHP;
  hp.connect(dry); hp.connect(verb);
  // The notes and the drone share this room, so each gets its own tap on the
  // way in. Post-fader and pre-reverb, the same point the atmosphere meters
  // read, so the mixer's columns mean one thing throughout.
  noteTap = meterTap(ctx, hp);
}

// Gated on the transport rather than on the graph: a suspended context keeps
// handing back the last block it rendered, which would leave a meter lit while
// everything is silent.
const audible = () => S.running && S.audioEnabled && getContext()?.state === 'running';
export const pianoPeak = () => audible() ? tapPeak(noteTap) : 0;
export const bedPeak   = () => audible() ? tapPeak(bedTap)  : 0;

export function applyPianoReverb() {
  if (wet) wet.gain.setTargetAtTime(S.pianoReverb, getContext().currentTime, 0.08);
}
// Glided rather than set, so dragging the slider sweeps instead of zippering.
export function applyPianoHP() {
  if (hp) hp.frequency.setTargetAtTime(S.pianoHP, getContext().currentTime, 0.05);
}
let irTimer = null;
export function rebuildPianoIR() {
  if (!verb) return;
  clearTimeout(irTimer);
  irTimer = setTimeout(() => { verb.buffer = impulse(getContext(), S.pianoRevTime, 2.0); }, 200);
}

const nearest = semi => SEMIS.reduce((a,b) => Math.abs(b-semi) < Math.abs(a-semi) ? b : a);
const clampN  = n => Math.max(LO, Math.min(HI, n));
const rnd  = (a,b) => a + Math.random()*(b-a);
const pick = arr => arr[(Math.random()*arr.length)|0];

// A note is started and left to ring. These samples decay to silence on their
// own in three to fifteen seconds, and cutting one short is the single thing
// that makes a sampler sound like a sampler.
function strike(written, vel, at) {
  const ctx = getContext();
  const src = nearest(written - ROOT);
  const buf = notes.get(src);
  if (!buf || !dry) return;
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.playbackRate.value = Math.pow(2, ((written - ROOT) - src) / 12);
  const g = ctx.createGain();
  g.gain.value = vel * vel * S.pianoVol;
  s.connect(g); g.connect(noteTap.analyser);
  s.start(at);
}
function keyLift(at) {
  if (!lifts.length || !dry) return;
  const ctx = getContext();
  const s = ctx.createBufferSource();
  s.buffer = pick(lifts);
  const g = ctx.createGain(); g.gain.value = 0.35 * S.pianoVol;
  s.connect(g); g.connect(noteTap.analyser);
  s.start(at);
}

function weighted(obj) {
  const keys = Object.keys(obj);
  let r = Math.random() * keys.reduce((s,k) => s + obj[k], 0);
  for (const k of keys) { r -= obj[k]; if (r <= 0) return +k; }
  return +keys[0];
}
function snap(n) {
  for (let i = 0; i < 12; i++) {
    if (DEG.includes((((n+i) - ROOT) % 12 + 12) % 12)) return n + i;
    if (DEG.includes((((n-i) - ROOT) % 12 + 12) % 12)) return n - i;
  }
  return n;
}

// Gestures lengthen as a section settles, from the take where the holds went
// 4.0, 6.2, 5.3, 7.8, 12.1 seconds over half a minute.
const holdScale = () => (S.pianoHold) * (1 + 0.6 * Math.min(1.6, elapsed / 90));

function centreNow() {
  drift += (Math.random() - 0.5) * 0.12;
  drift = Math.max(-1, Math.min(1, drift * 0.985));
  return S.pianoCentre + drift * S.pianoSpread * 11;
}

// Two upper dyads a step apart, alternating: degrees 1 3 against 2 5. This is
// the whole engine of the passage that worked best by ear.
function gDyad(t, c) {
  lastDyad = 1 - lastDyad;
  const pair = lastDyad ? [0, 4] : [2, 7];
  const base = ROOT + Math.round((c - ROOT) / 12) * 12;
  const wide = Math.random() < 0.3 ? 12 : 0;
  strike(clampN(base + pair[0]), rnd(0.62,0.82), t);
  strike(clampN(base + pair[1] + wide), rnd(0.60,0.80), t + rnd(0.01,0.09));
  return rnd(3.2, 7.0) * holdScale();
}
// Triad, then an upper pair, then the ninth alone. Played by hand, exactly so.
function gBloom(t, c) {
  const b = ROOT + (Math.round((c - ROOT)/12) - 1) * 12;
  [0,4,7].forEach((d,i) => strike(clampN(b+d), rnd(0.66,0.84), t + i*rnd(0.01,0.12)));
  const t2 = t + rnd(2.4, 3.4);
  (Math.random() < 0.5 ? [12,16] : [12,19])
    .forEach((d,i) => strike(clampN(b+d), rnd(0.58,0.76), t2 + i*rnd(0.01,0.06)));
  const t3 = t2 + rnd(2.0, 3.0);
  strike(clampN(b + 14), rnd(0.55,0.72), t3);
  return (t3 - t) + rnd(3.0, 6.0) * holdScale();
}
function gSingle(t, c) {
  strike(clampN(snap(Math.round(c + rnd(-5,5)))), rnd(0.5,0.75), t);
  return rnd(1.6, 4.2) * holdScale();
}
// Enters late and stays. In the take it arrived after ninety seconds and held
// for eighteen, which is most of why that section opened out.
function gBass(t) {
  const n = pick([ROOT, ROOT+7, ROOT+12]);
  strike(n, rnd(0.6,0.8), t);
  if (Math.random() < 0.5) strike(clampN(n+7), rnd(0.5,0.7), t + rnd(2.5,4.5));
  return rnd(6, 13) * holdScale();
}

function step() {
  if (!running) return;
  const ctx = getContext();
  const now = ctx.currentTime;
  while (clock < now + 1.5) {
    const at = Math.max(clock, now + 0.06);
    const c = centreNow();
    const kind = weighted({ 0: S.pianoDyad, 1: S.pianoBloom, 2: S.pianoSingle, 3: S.pianoBass });
    const span = kind === 0 ? gDyad(at, c)
               : kind === 1 ? gBloom(at, c)
               : kind === 2 ? gSingle(at, c)
               : gBass(at);
    if (S.pianoLifts && Math.random() < 0.45) keyLift(at + span * rnd(0.5, 0.95));
    // The real finding: not a rate, but short gaps inside a phrase and long
    // ones between. One take was 42% long gaps, another 18%.
    const gap = (Math.random() < 0.34 ? rnd(4.0, 9.0) : rnd(0.9, 3.2)) / S.pianoDensity;
    clock = at + span * 0.55 + gap;
    elapsed += span * 0.55 + gap;
  }
  timer = setTimeout(step, 250);
}

// The bed plays its intro once and then loops the stable middle for as long as
// the music is on.
//
// It used to do that with AudioBufferSourceNode.loop, whose splice is exactly
// one sample wide: the last sample before loopEnd is followed immediately by
// the sample at loopStart with nothing in between. Measured on this bed through
// the same decoder the page uses, that step is 0.24 full scale on the right
// channel, and a 50 ms window either side of the splice correlates at -0.04.
// Uncorrelated material, spliced instantly, at roughly double the level going
// in as coming out. That is the click, and an earlier comment here claiming the
// crossfade had been baked into the looped region was simply not true of the
// file that shipped.
//
// The tail cannot be made to match the head without re-cutting the master, so
// the crossfade happens at playback instead. Each pass through the body is its
// own source, and consecutive passes overlap by BED_XFADE seconds.
const BED_XFADE = 3.0;
// A hidden tab throttles timers hard, so the scheduler runs far enough ahead
// that even a minute between wake-ups still lands the next pass on time.
const BED_LOOKAHEAD = 90;

// Equal power, not linear. The two sides of this splice are uncorrelated, so
// their amplitudes do not sum -- their powers do, and linear ramps would leave
// an audible trough in the middle of every crossfade.
const XF_N = 256;
const xfIn  = new Float32Array(XF_N);
const xfOut = new Float32Array(XF_N);
for (let i = 0; i < XF_N; i++) {
  const t = i / (XF_N - 1);
  xfIn[i]  = Math.sin(t * Math.PI / 2);
  xfOut[i] = Math.cos(t * Math.PI / 2);
}

// One pass over the buffer, fading out into whatever is scheduled after it.
// Returns the time the next pass should start, which is one crossfade early so
// the two overlap.
function bedTake(startAt, offset, playLen, xf, fadeIn) {
  const ctx = getContext();
  const s = ctx.createBufferSource();
  s.buffer = bed;
  const g = ctx.createGain();
  g.gain.value = fadeIn ? 0 : 1;
  if (fadeIn) g.gain.setValueCurveAtTime(xfIn, startAt, xf);
  g.gain.setValueCurveAtTime(xfOut, startAt + playLen - xf, xf);
  s.connect(g); g.connect(bedGain);
  s.start(startAt, offset, playLen);
  s.stop(startAt + playLen);
  s.onended = () => {
    try { g.disconnect(); } catch (e) {}
    bedTakes = bedTakes.filter(t => t !== s);
  };
  bedTakes.push(s);
  return startAt + playLen - xf;
}

function bedPump() {
  const ctx = getContext();
  if (!bedRunning || !ctx) return;
  const loopLen = bedMeta.loopEnd - bedMeta.loopStart;
  // A crossfade longer than half the loop would overlap its own two ends and
  // leave setValueCurveAtTime with two curves fighting over the same range.
  const xf = Math.min(BED_XFADE, loopLen / 2 - 0.01);
  while (bedNextAt < ctx.currentTime + BED_LOOKAHEAD) {
    bedNextAt = bedTake(bedNextAt, bedMeta.loopStart, loopLen, xf, true);
  }
}

function bedOn() {
  const ctx = getContext();
  if (!bed || !bedMeta || bedRunning) return;
  bedRunning = true;
  bedGain = ctx.createGain();
  bedGain.gain.value = 0;
  bedTap = meterTap(ctx, dry, verb);
  bedGain.connect(bedTap.analyser);

  const loopLen = bedMeta.loopEnd - bedMeta.loopStart;
  const xf = Math.min(BED_XFADE, loopLen / 2 - 0.01);
  // The intro is played once, whole, from the top; it needs no fade in of its
  // own because the master gain below is already opening.
  bedNextAt = bedTake(ctx.currentTime + 0.05, 0, bedMeta.loopEnd, xf, false);
  bedPump();
  bedTimer = setInterval(bedPump, 10000);

  bedGain.gain.setTargetAtTime(S.bedVol, ctx.currentTime, 1.2);
}

function bedOff() {
  if (!bedRunning) return;
  const ctx = getContext(), g = bedGain, takes = bedTakes, tap = bedTap;
  bedRunning = false;
  clearInterval(bedTimer); bedTimer = null;
  bedTakes = []; bedGain = null; bedNextAt = 0; bedTap = null;
  g.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
  setTimeout(() => {
    for (const s of takes) { try { s.onended = null; s.stop(); } catch (e) {} }
    try { g.disconnect(); } catch (e) {}
    // The drone's tap is built with it, so it is torn down with it rather than
    // left hanging off the room for every on and off in the session.
    if (tap) { try { tap.analyser.disconnect(); } catch (e) {} }
  }, 2600);
}
export function applyBedVol() {
  if (bedGain) bedGain.gain.setTargetAtTime(S.bedVol, getContext().currentTime, 0.2);
}

export async function pianoOn() {
  if (!ready && !(await loadPiano())) return false;
  const ctx = getContext();
  if (!ctx) return false;
  running = true;
  clock = ctx.currentTime + 0.4;
  elapsed = 0;
  step();
  bedOn();
  return true;
}
export function pianoOff() { running = false; clearTimeout(timer); bedOff(); }
export const pianoReady = () => ready;
export const pianoAvailable = () => canOpus;
