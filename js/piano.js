// The generative piano.
//
// Not a random note picker. Every rule and every default here came out of
// measuring four takes played by hand, and the comments say which measurement.
// The instrument is a felt piano tuned so its root sits two octaves under the
// 40 Hz carrier, which means the music and the entrainment tone are the same
// number rather than merely compatible.
import { S } from './state.js';
import { getContext, getMaster, createRoom, swapRoom, glideParam, glideEnd } from './audio.js';
import { meterTap, tapPeak } from './util.js';
import { chanGate, onChannelGates } from './mixgate.js';
import { createSweep } from './sweep.js';

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
// The drone comes in several renders, one per detune amount (manifest.json's
// versions). Each is decoded the first time it is chosen and kept. bedRun is
// the run of passes currently being scheduled: its buffer, and its own gain
// ahead of bedGain so a change of render can fade one run out under the next.
const bedBuffers = new Map();
let bedRun = null, bedSwapSeq = 0;
let ready = false, loading = null;
let dry = null, room = null, wet = null, hp = null, chan = null;
let noteTap = null, bedTap = null;
let bedCut = null, bedChains = null, bedSend = null, bedRev = null;
let running = false, clock = 0, elapsed = 0, drift = 0, lastDyad = 0, timer = null;

const canOpus = (() => {
  const a = new Audio();
  return a.canPlayType('audio/ogg; codecs=opus') !== ''
      || a.canPlayType('audio/webm; codecs=opus') !== '';
})();

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
      bed = await bedBuffer(S.bedDetune);
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
  // two convolvers, so a new decay fades in under the old tail (audio.js)
  room = createRoom(ctx, () => S.pianoRevTime, 2.0);
  wet  = ctx.createGain(); wet.gain.value = S.pianoReverb;
  dry.connect(master);
  room.output.connect(wet).connect(master);
  // A high-pass on the notes only, ahead of the room so the reverb is fed the
  // same thinned signal the dry path gets; filtering after the convolver would
  // leave a low bloom in the tail that the dry note no longer has. The drone
  // bypasses it: it is its own voice with its own level. 12 dB an octave at
  // Butterworth Q, gentle enough to take mud out without hollowing the tone.
  // 20 Hz is the floor and is effectively off.
  hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.Q.value = Math.SQRT1_2;
  hp.frequency.value = S.pianoHP;
  // The piano's channel gain, after the filter: the mix gate's mute and solo
  // (mixgate.js). S.pianoVol is baked into each note as it is struck, so a
  // gate there would only reach notes not yet played; here it closes on the
  // notes already ringing too, and on their feed into the room.
  chan = ctx.createGain();
  chan.gain.value = chanGate('piano');
  hp.connect(chan);
  // The notes and the drone share this room, so each gets its own tap on the
  // way in. Post-fader, post-gate and pre-reverb, the same point the
  // atmosphere meters read, so the mixer's columns mean one thing throughout
  // and a muted channel's meter falls silent with it.
  noteTap = meterTap(ctx, dry, room.input);
  chan.connect(noteTap.analyser);
}

// Gated on the transport rather than on the graph: a suspended context keeps
// handing back the last block it rendered, which would leave a meter lit while
// everything is silent.
const audible = () => S.running && S.audioEnabled && getContext()?.state === 'running';
export const pianoPeak = () => audible() ? tapPeak(noteTap) : 0;
export const bedPeak   = () => audible() ? tapPeak(bedTap)  : 0;
export const arpPeak   = () => audible() && arp ? tapPeak(arp.tap) : 0;

// Every gain and the filter here go through glideParam (audio.js): a
// straight line over a preset's transition, the usual short approach for a
// slider.
// The Master reverb switch closes the shared room's wet output; the level
// below it is what the room plays at when it is open.
export function applyPianoReverb() {
  if (wet) glideParam(wet.gain, S.musicRevOn === false ? 0 : S.pianoReverb, 0.08);
}
// Glided rather than set, so dragging the slider sweeps instead of zippering.
export function applyPianoHP() {
  if (hp) glideParam(hp.frequency, S.pianoHP, 0.05);
}

// Mute and solo, for the notes and for the drone, which has its own channel
// in the mix and so its own gate on bedGain. A short glide rather than a
// step, so a gate closing mid-note never clicks.
const GATE_TC = 0.03;
onChannelGates(() => {
  const ctx = getContext();
  if (!ctx) return;
  if (chan) glideParam(chan.gain, chanGate('piano'), GATE_TC);
  if (bedGain) glideParam(bedGain.gain, S.bedVol * chanGate('drone'), GATE_TC);
  if (arp) glideParam(arp.chanG.gain, chanGate('arp'), GATE_TC);
});
// Crossfaded into the room rather than swapped under a ringing tail.
export function rebuildPianoIR() {
  swapRoom(room, 200);
}

const nearest = semi => SEMIS.reduce((a,b) => Math.abs(b-semi) < Math.abs(a-semi) ? b : a);

// The per-sample level corrections dialled in on the sandbox keyboard, the same
// numbers the manifest carries as levelTrimsBaked. They are NOT in the audio --
// lekko-35 holds a 39 trim and still measures louder than lekko-33 at 100 -- so
// the live app has to apply them, and until now nothing did.
//
// Keyed by the SAMPLE's semitone rather than by the played note, because several
// keys share one recording: correcting the sample corrects every key that
// reaches for it. Same per-sample scheme the trim strip uses for this instrument
// (perKey: false), unlike the clouds, which are trimmed per key.
const SAMPLE_TRIM = {
  14: 1.24, 19: 0.93, 23: 0.74, 24: 0.83, 31: 1.31,
  35: 0.39, 36: 0.74, 38: 0.70, 40: 0.47
};
const sampleTrim = src => SAMPLE_TRIM[src] ?? 1;
const clampN  = n => Math.max(LO, Math.min(HI, n));
const rnd  = (a,b) => a + Math.random()*(b-a);
// Rubato widens a measured spacing around its own centre: at 0 a gesture is
// played with exactly the spread that was measured, at 2 it has seven times
// that spread, so the same figure never lands the same way twice. Floored at
// 4 ms, since two notes at the identical instant is the one thing it is here
// to avoid.
const rub = (a,b) => {
  const mid = (a+b)/2, half = (b-a)/2 * (1 + S.pianoRubato*3);
  return Math.max(0.004, rnd(mid-half, mid+half));
};
// Notes that are "together" are never quite together. Each interval is drawn on
// its own and they accumulate, so the roll comes out a different shape every
// time rather than one random number multiplied out along the chord.
function roll(t, count, a, b) {
  const times = [t];
  for (let i = 1; i < count; i++) times.push(times[i-1] + rub(a,b));
  return times;
}
const pick = arr => arr[(Math.random()*arr.length)|0];

// A note is started and left to ring. These samples decay to silence on their
// own in three to fifteen seconds, and cutting one short is the single thing
// that makes a sampler sound like a sampler.
// A note struck again while its last strike is still recent never comes back
// at the same strength: it is played softer than last time (0.7 of the
// previous velocity, about 6 dB quieter), and a third strike softer again.
// The gestures still choose their notes freely; only the repeat is eased.
// Keyed by the written note and compared on the audio clock, so strikes
// booked ahead by the scheduler count in the order they will sound.
const REPEAT_WINDOW_S = 8, REPEAT_SOFTEN = 0.7;
// One record per written note (forty-one at most), rewritten in place.
const lastStrike = new Map();   // written note -> { at, vel }
function strike(written, vel, at) {
  const prev = lastStrike.get(written);
  if (prev && at - prev.at >= 0 && at - prev.at < REPEAT_WINDOW_S) {
    vel = Math.min(vel, prev.vel * REPEAT_SOFTEN);
  }
  if (prev) { prev.at = at; prev.vel = vel; } else lastStrike.set(written, { at, vel });
  const ctx = getContext();
  const src = nearest(written - ROOT);
  const buf = notes.get(src);
  if (!buf || !dry) return;
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.playbackRate.value = Math.pow(2, ((written - ROOT) - src) / 12);
  const g = ctx.createGain();
  g.gain.value = vel * vel * S.pianoVol * sampleTrim(src);
  s.connect(g); g.connect(hp);
  s.start(at);
}
function keyLift(at) {
  if (!lifts.length || !dry) return;
  const ctx = getContext();
  const s = ctx.createBufferSource();
  s.buffer = pick(lifts);
  const g = ctx.createGain(); g.gain.value = 0.35 * S.pianoVol;
  s.connect(g); g.connect(hp);
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
  strike(clampN(base + pair[1] + wide), rnd(0.60,0.80), t + rub(0.01,0.09));
  return rnd(3.2, 7.0) * holdScale();
}
// Triad, then an upper pair, then the ninth alone. Played by hand, exactly so.
function gBloom(t, c) {
  const b = ROOT + (Math.round((c - ROOT)/12) - 1) * 12;
  const triad = [0,4,7], tri = roll(t, triad.length, 0.01, 0.12);
  triad.forEach((d,i) => strike(clampN(b+d), rnd(0.66,0.84), tri[i]));
  const t2 = t + rub(2.4, 3.4);
  const upper = Math.random() < 0.5 ? [12,16] : [12,19];
  const up = roll(t2, upper.length, 0.01, 0.06);
  upper.forEach((d,i) => strike(clampN(b+d), rnd(0.58,0.76), up[i]));
  const t3 = t2 + rub(2.0, 3.0);
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
  if (Math.random() < 0.5) strike(clampN(n+7), rnd(0.5,0.7), t + rub(2.5,4.5));
  return rnd(6, 13) * holdScale();
}

// ---------- snippets: the takes played back ----------
// Play style 'snippets' (S.pianoStyle). The two newest takes' own phrases,
// note for note, with only the timing loosened: the playback approach. The
// 'generative' style further down writes new phrases from rules measured on
// the same takes instead.

// Call and response, the fifth take: the call climbing 1 5 3 7, a climb from
// the octave reaching for the 9, once a third at the top (10 12 9); the answer
// 8 7 5 3; the rest on the 2, alone or as 1 3 2. Written above the base.
const SNIP_CALLS = [
  [[0,7,4,11], [0,7,4,11], [0,4,11]],     // from the root
  [[12,14], [12,7,14]],                   // from the octave
  [[16,19,14], [12,16]]                   // the top
];
const SNIP_ANSWERS = [[12,11,7,4], [12,11,7,4], [11,7,4]];
const SNIP_RESTS = [[2], [2], [0,4,2]];
function gCallSnip(t, c) {
  let base = ROOT + (Math.round((c - ROOT) / 12) - 1) * 12;
  while (base + 19 > HI) base -= 12;     // room for the top call, always in the mode
  while (base < LO) base += 12;
  const slow = 1 + 0.45 * Math.min(1.6, elapsed / 90);
  let at = t - rub(6.0, 7.6);            // so the first phrase lands on t
  const phrase = (notes, lo, hi) => {
    at += rub(6.0, 7.6);                 // the gap between phrases
    notes.forEach((d, i) => {
      if (i) at += rub(1.3, 3.0) * slow;
      strike(clampN(base + d), rnd(lo, hi), at);
    });
  };
  phrase(pick(SNIP_CALLS[0]), 0.6, 0.8);
  for (let lift = 1; lift < 3 && Math.random() < 0.45; lift++) phrase(pick(SNIP_CALLS[lift]), 0.6, 0.8);
  phrase(pick(SNIP_ANSWERS), 0.6, 0.8);
  if (Math.random() < 0.6) phrase(pick(SNIP_RESTS), 0.55, 0.75);
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

// Dark clusters, the sixth take: its eight figures, each written above the
// low root it opens on.
const SNIP_FIGS = [
  [12,14,16], [12,14,16], [12,14,19,16], [7,16,14],
  [12,7,2], [11,14,7], [11,7,0], [12,16,14,19,16,14,12,7]
];
function gClusterSnip(t) {
  const fig = pick(SNIP_FIGS);
  strike(ROOT, rnd(0.62, 0.8), t);
  let at = t;
  fig.forEach((d, i) => {
    at += i === fig.length - 1 && fig.length > 2 ? rub(3.1, 6.0) : rub(1.4, 2.8);
    strike(ROOT + d, rnd(0.55, 0.75), at);
  });
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

// ---------- generative: rules measured from the takes ----------

// The mode laid out as a ladder, every playable note in order, and its chord
// tones (1 3 5 7) as a second, sparser ladder. The two gestures below move by
// rungs on these, so a step means a step in the mode, never a semitone.
const SCALE = [], CHORD = [];
for (let n = LO; n <= HI; n++) {
  const pc = (n - ROOT) % 12;
  if (DEG.includes(pc)) SCALE.push(n);
  if (pc === 0 || pc === 4 || pc === 7 || pc === 11) CHORD.push(n);
}
// the rung at n, or the nearest one above it
const rung = (ladder, n) => { const i = ladder.findIndex(m => m >= n); return i < 0 ? ladder.length - 1 : i; };

// Call and response, measured from the fifth take (37 single notes, no chords).
//
// The call zigzags up the chord ladder: two rungs up, one back, two up (1 5 3
// 7 is one such line). It never falls twice running and always ends higher
// than it began. Sometimes, before it is answered, it calls again from the next
// chord tone above where it peaked; a call that high often lets go of the
// chord at the end and reaches for the nearest 9 instead. The answer walks
// down the chord ladder a rung at a time from the octave (or the 7 under it)
// to the 3. Most of the time the line then settles on the 2, which never
// resolves, alone or after touching the notes either side of it.
//
// Timing: notes 1.3 to 3 s apart, stretching toward 2x as a session settles
// (the take went from about 2 s to about 4); 6 to 7.6 s between phrases.
const CALL_LEN_W  = { 2: 2, 3: 2, 4: 2 };     // notes per call
const CALL_STEP_W = { 2: 3, 1: 2, '-1': 2 };  // chord rungs per move
const CLIMB_P = 0.45, REACH_P = 0.5, REST_P = 0.6, TURN_P = 0.35;
function gCall(t, c) {
  let base = ROOT + (Math.round((c - ROOT) / 12) - 1) * 12;
  while (base + 26 > HI) base -= 12;     // room to climb twice
  while (base < LO) base += 12;
  const slow = 1 + 0.45 * Math.min(1.6, elapsed / 90);
  let at = t - rub(6.0, 7.6);            // so the first phrase lands on t
  const phrase = (notes, lo, hi) => {
    at += rub(6.0, 7.6);                 // the gap between phrases
    notes.forEach((n, i) => {
      if (i) at += rub(1.3, 3.0) * slow;
      strike(clampN(n), rnd(lo, hi), at);
    });
  };
  const call = (from, reach) => {
    const len = weighted(CALL_LEN_W), line = [CHORD[from]];
    let i = from, fell = false;
    for (let k = 1; k < len; k++) {
      let s = weighted(CALL_STEP_W);
      if (s < 0 && (fell || k === 1 || k === len - 1)) s = -s;   // up first and last, never down twice
      i = Math.min(CHORD.length - 1, Math.max(0, i + s));
      fell = s < 0;
      line.push(CHORD[i]);
    }
    if (reach && Math.random() < REACH_P) {
      const top = line[line.length - 1];
      line[line.length - 1] = top - ((top - ROOT - 2) % 12 + 12) % 12;   // the 9 at or below it
      if (line[line.length - 1] <= line[line.length - 2]) line[line.length - 1] += 12;
    }
    return line;
  };

  let peak = base, line = call(rung(CHORD, base), false);
  phrase(line, 0.6, 0.8);
  peak = Math.max(...line);
  for (let lift = 1; lift < 3 && Math.random() < CLIMB_P && peak + 7 <= HI; lift++) {
    line = call(rung(CHORD, peak + 1), true);
    phrase(line, 0.6, 0.8);
    peak = Math.max(peak, ...line);
  }
  // the answer: down the chord ladder from the octave or the 7, to the 3
  const answer = [];
  const floor = rung(CHORD, base + 4);
  for (let i = rung(CHORD, base + (Math.random() < 0.67 ? 12 : 11)); i >= floor; i--) {
    answer.push(CHORD[i]);
    if (answer.length > 1 && i > floor && Math.random() < 0.15) i--;   // now and then skips a rung
  }
  phrase(answer, 0.6, 0.8);
  if (Math.random() < REST_P) {
    const two = base + 2, rest = [two];
    if (Math.random() < TURN_P) rest.unshift(...(Math.random() < 0.5 ? [base, base + 4] : [base + 4, base]));
    phrase(rest, 0.55, 0.75);
  }
  // step() moves on by 0.55 of a span, so the phrase is divided back out
  // here: nothing else starts until the last note has been struck
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

// Dark clusters, measured from the sixth take (38 notes, eight phrases).
//
// Every phrase opens on the low root, the darkest note the piano has here,
// then jumps up to the octave (or a rung or two under it) and walks the mode
// ladder close around it, everything left ringing together over the root.
// Moves are mostly single rungs (12 of 21 in the take), often two (7), rarely
// more. The first move goes up three times in four; after that the line leans
// down, two moves in three. It stays between the 2 above the root and the 5
// an octave up, and runs three notes most often, occasionally two, four, or a
// long wander of seven. The notes after the root come 1.4 to 2.8 s apart, now
// and then one waits longer, and the last always waits, 3 to 6 s.
const CL_FIRST_W = { 0: 5, '-1': 2, '-2': 1 };   // rungs from the octave
const CL_STEP_W  = { 1: 12, 2: 7, 3: 1, 4: 1 };
const CL_LEN_W   = { 2: 1, 3: 5, 4: 1, 7: 1 };
function gCluster(t) {
  strike(ROOT, rnd(0.62, 0.8), t);
  const lo = rung(SCALE, ROOT + 2), hi = rung(SCALE, ROOT + 19);
  const len = weighted(CL_LEN_W);
  let i = rung(SCALE, ROOT + 12) + weighted(CL_FIRST_W), at = t;
  for (let k = 0; k < len; k++) {
    if (k > 0) {
      const up = Math.random() < (k === 1 ? 0.75 : 0.33);
      let j = i + (up ? 1 : -1) * weighted(CL_STEP_W);
      if (j < lo || j > hi) j = 2 * i - j;          // off the edge: turn back
      i = Math.max(lo, Math.min(hi, j));
    }
    const last = k === len - 1 && len > 2;
    at += last ? rub(3.1, 6.0) : Math.random() < 0.2 ? rub(3.1, 5.4) : rub(1.4, 2.8);
    strike(SCALE[i], rnd(0.55, 0.75), at);
  }
  return (at - t) / 0.55 + rnd(1.5, 4.0) * holdScale();
}

function step() {
  if (!running) return;
  const ctx = getContext();
  const now = ctx.currentTime;
  // The Piano voice switch: off, the player schedules nothing and the clock
  // idles just behind now, so switching back on picks up within a phrase.
  if (S.pianoOn === false) {
    clock = Math.max(clock, now + 0.5);
    timer = setTimeout(step, 250);
    return;
  }
  while (clock < now + 1.5) {
    const at = Math.max(clock, now + 0.06);
    const c = centreNow();
    const kind = weighted({ 0: S.pianoDyad, 1: S.pianoBloom, 2: S.pianoSingle, 3: S.pianoBass,
                            4: S.pianoCall, 5: S.pianoCluster });
    const span = kind === 0 ? gDyad(at, c)
               : kind === 1 ? gBloom(at, c)
               : kind === 2 ? gSingle(at, c)
               : kind === 4 ? (S.pianoStyle === 'snippets' ? gCallSnip(at, c) : gCall(at, c))
               : kind === 5 ? (S.pianoStyle === 'snippets' ? gClusterSnip(at) : gCluster(at))
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
  const ctx = getContext(), run = bedRun;
  const s = ctx.createBufferSource();
  s.buffer = run.buf;
  const g = ctx.createGain();
  g.gain.value = fadeIn ? 0 : 1;
  if (fadeIn) g.gain.setValueCurveAtTime(xfIn, startAt, xf);
  g.gain.setValueCurveAtTime(xfOut, startAt + playLen - xf, xf);
  s.connect(g); g.connect(run.gain);
  s.start(startAt, offset, playLen);
  s.stop(startAt + playLen);
  s.onended = () => {
    try { g.disconnect(); } catch (e) {}
    bedTakes = bedTakes.filter(t => t !== s);
    run.takes = run.takes.filter(t => t !== s);
  };
  // where this pass starts, in the context's time and in the buffer, so a
  // change of render can find the point the drone has reached
  s.at = startAt; s.offset = offset;
  bedTakes.push(s);
  run.takes.push(s);
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
  // The drone's own low-pass, ahead of its tap so the dry path, the room and
  // the meter all hear the same filtered drone, and its own feed into the
  // piano's room in place of the tap feeding the room directly. Both start
  // where they change nothing (the filter at Nyquist, where a Web Audio
  // low-pass passes the signal through untouched, and the feed at unity),
  // and each is moved by its sweep (the drone's sweeps, after bedOff).
  bedSend = ctx.createGain();
  bedSend.gain.value = 1;
  // The Drone reverb switch and level, after the sweep's share: the sweep
  // moves bedSend, this sets how much of that reaches the room at all.
  bedRev = ctx.createGain();
  bedRev.gain.value = bedRevTarget();
  bedTap = meterTap(ctx, dry, bedSend);
  bedSend.connect(bedRev);
  bedRev.connect(room.input);
  // One cutoff for every slope: a constant source whose offset the sweep
  // moves, added into each stage's frequency (left at 0), so all four
  // chains follow the same cutoff exactly. Each chain is a Butterworth
  // cascade of its order; only the chosen slope's output is open, and a
  // change of slope crossfades between chains (applyBedLpf) instead of
  // re-wiring stages under a sounding drone.
  bedCut = ctx.createConstantSource();
  bedCut.offset.value = ctx.sampleRate / 2;
  bedCut.start();
  const pick = bedSlopeIndex();
  bedChains = BED_SLOPES.map((qs, i) => {
    if (!qs) {
      // The one-pole needs the engine's worklet module; until that has
      // loaded, the 6 dB chain is a plain wire so choosing it never breaks.
      let node;
      try {
        node = new AudioWorkletNode(ctx, 'one-pole', { outputChannelCount: [2] });
        node.parameters.get('frequency').value = 0;
        bedCut.connect(node.parameters.get('frequency'));
      } catch (e) { node = ctx.createGain(); }
      const out = ctx.createGain();
      out.gain.value = i === pick ? 1 : 0;
      node.connect(out); out.connect(bedTap.analyser);
      return chainFeed({ stages: [node], qs: [], out, live: false, idle: null }, i === pick);
    }
    const stages = qs.map(q => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 0;
      f.Q.value = q;
      bedCut.connect(f.frequency);
      return f;
    });
    for (let k = 1; k < stages.length; k++) stages[k - 1].connect(stages[k]);
    const out = ctx.createGain();
    out.gain.value = i === pick ? 1 : 0;
    stages[stages.length - 1].connect(out);
    out.connect(bedTap.analyser);
    return chainFeed({ stages, qs, out, live: false, idle: null }, i === pick);
  });
  setBedResonance(0);
  bedLpfSweep.start(ctx, bedCut.offset, ctx.sampleRate / 2);
  bedVerbSweep.start(ctx, bedSend.gain, 1);

  const loopLen = bedMeta.loopEnd - bedMeta.loopStart;
  const xf = Math.min(BED_XFADE, loopLen / 2 - 0.01);
  bedRun = newBedRun(bed, 1);
  // The intro is played once, whole, from the top; it needs no fade in of its
  // own because the master gain below is already opening.
  bedNextAt = bedTake(ctx.currentTime + 0.05, 0, bedMeta.loopEnd, xf, false);
  bedPump();
  bedTimer = setInterval(bedPump, 10000);

  glideParam(bedGain.gain, S.bedVol * chanGate('drone'), 1.2);
}

function bedOff() {
  if (!bedRunning) return;
  const ctx = getContext(), g = bedGain, takes = bedTakes, tap = bedTap;
  bedRunning = false;
  clearInterval(bedTimer); bedTimer = null;
  bedLpfSweep.stop(); bedVerbSweep.stop();
  const cut = bedCut, chains = bedChains, send = bedSend, rev = bedRev;
  bedCut = null; bedChains = null; bedSend = null; bedRev = null;
  bedTakes = []; bedGain = null; bedNextAt = 0; bedTap = null; bedRun = null;
  // well inside the 2.6 s before the takes stop, transition or not
  glideParam(g.gain, 0, 0.6);
  setTimeout(() => {
    for (const s of takes) { try { s.onended = null; s.stop(); } catch (e) {} }
    try { g.disconnect(); } catch (e) {}
    // The drone's tap is built with it, so it is torn down with it rather than
    // left hanging off the room for every on and off in the session.
    if (tap) { try { tap.analyser.disconnect(); } catch (e) {} }
    try { cut.stop(); cut.disconnect(); send.disconnect(); rev.disconnect(); } catch (e) {}
    for (const c of chains) {
      try { c.out.disconnect(); for (const f of c.stages) f.disconnect(); } catch (e) {}
    }
  }, 2600);
}

// ---------- the drone's filter and room sweeps ----------
// The same slow motion as the click train's filter sweep (lpfBlock in
// worklet.js), played onto ordinary nodes by the sweep driver in sweep.js.
// The filter sweeps its cutoff in pitch between the low and high settings;
// the room sweep moves the drone's own feed into the piano's room between
// its low and high settings, as a share of the usual feed, so the drone
// sits sometimes nearer and sometimes further in. The room's wet level
// (S.pianoReverb) still applies after the room. Off, each glides back to
// where it changes nothing. The sweeps own these two params outright: a
// preset or a dial only changes the settings they read, and they re-plan
// from where they are.
//
// The top of the filter's travel, clamped under Nyquist as the worklet's
// lpfCeil is, so a high setting near it cannot misbehave at 44.1 kHz.
const bedCeil = () => Math.min(20000, getContext().sampleRate * 0.45);
const bedLpfSweep = createSweep({
  domain: 'log',
  read: c => {
    const ceil = bedCeil();
    c.on = S.bedLpfOn; c.lo = Math.min(ceil, S.bedLpfLo); c.hi = Math.min(ceil, S.bedLpfHi);
    c.period = S.bedLpfPeriod; c.wander = S.bedLpfWander;
  }
});
const bedVerbSweep = createSweep({
  domain: 'lin',
  read: c => {
    c.on = S.bedVerbOn; c.lo = S.bedVerbLo; c.hi = S.bedVerbHi;
    c.period = S.bedVerbPeriod; c.wander = S.bedVerbWander;
  }
});
// The rolloff: 6 dB an octave as a one-pole (the 'one-pole' processor in
// worklet.js, since BiquadFilterNode starts at 12), then 12, 24, 36 or 48 as
// Butterworth cascades of order 2, 4, 6 and 8 (their stages' Q values,
// lowest first). Flat to the
// cutoff with no bump at the default resonance, so a steeper slope only
// makes the drone darker above the cutoff, not louder at it.
const BED_SLOPES = [
  null,                              // 6 dB: the one-pole in worklet.js
  [0.7071],
  [0.5412, 1.3066],
  [0.5176, 0.7071, 1.9319],
  [0.5098, 0.6013, 0.9000, 2.5629]
];
const BED_SLOPE_DB = [6, 12, 24, 36, 48];
function bedSlopeIndex() {
  const i = BED_SLOPE_DB.indexOf(S.bedLpfSlope);
  return i < 0 ? 1 : i;
}
// Resonance lifts each chain's last, highest-Q stage by the dial's ratio to
// Butterworth (0.71), so the default is exactly flat at every slope and the
// dial means the same peak whichever slope is chosen.
function setBedResonance(glide) {
  const lift = S.bedLpfQ / 0.7071;
  for (const c of bedChains) {
    if (!c.qs.length) continue;      // a one-pole has no resonance
    const last = c.stages[c.stages.length - 1], q = c.qs[c.qs.length - 1] * lift;
    if (glide > 0) glideParam(last.Q, q, glide); else last.Q.value = q;
  }
}
// Resonance and slope are not part of the motion, so they glide like any
// other dial, in a straight line over a preset's transition; a new slope is
// a short crossfade between chains.
//
// Only the chosen chain is fed. The other four used to run all the time at
// a closed output, which during a sweep meant nine biquad stages working out
// fresh coefficients every sample for nothing. A chain that has been faded
// out is unplugged from the drone once its fade is done (the glide's own
// length, a preset's transition included, plus ten time constants, by which
// point it is some 85 dB down), and plugged back in the moment it is chosen,
// its output still closed and opening over the same crossfade as before.
const BED_XF_TC = 0.08;
function chainFeed(c, on) {
  if (on) {
    if (c.idle) { clearTimeout(c.idle); c.idle = null; }
    if (!c.live) { bedGain.connect(c.stages[0]); c.live = true; }
  } else if (c.live && !c.idle) {
    const ctx = getContext(), g = bedGain;
    const wait = Math.max(0, glideEnd() - ctx.currentTime) + 10 * BED_XF_TC;
    c.idle = setTimeout(() => {
      c.idle = null;
      if (!c.live || bedGain !== g) return;       // the drone was rebuilt meanwhile
      try { g.disconnect(c.stages[0]); } catch (e) {}
      c.live = false;
    }, wait * 1000);
  }
  return c;
}
export function applyBedLpf() {
  if (!bedChains) return;
  setBedResonance(0.05);
  const pick = bedSlopeIndex();
  for (let i = 0; i < bedChains.length; i++) {
    chainFeed(bedChains[i], i === pick);
    glideParam(bedChains[i].out.gain, i === pick ? 1 : 0, BED_XF_TC);
  }
  bedLpfSweep.update();
}
// Off is no feed at all; on, the level (100% is the drone's usual feed).
const bedRevTarget = () => S.bedRevOn === false ? 0 : Math.max(0, S.bedRevLevel ?? 1);
export function applyBedVerb() {
  if (!bedSend) return;
  glideParam(bedRev.gain, bedRevTarget(), 0.08);
  bedVerbSweep.update();
}

export function applyBedVol() {
  if (bedGain) glideParam(bedGain.gain, S.bedVol * chanGate('drone'), 0.2);
}

// ---------- the drone's renders ----------
function bedVersion(id) {
  return bedMeta.versions.find(v => v.id === id) || bedMeta.versions[0];
}
function bedBuffer(id) {
  const v = bedVersion(id);
  if (!bedBuffers.has(v.id)) {
    const p = fetch(`audio/music/${v.file}.opus`)
      .then(r => r.arrayBuffer())
      .then(b => getContext().decodeAudioData(b));
    // a failed load is forgotten, so choosing it again tries again
    p.catch(() => bedBuffers.delete(v.id));
    bedBuffers.set(v.id, p);
  }
  return bedBuffers.get(v.id);
}
function newBedRun(buf, level) {
  const g = getContext().createGain();
  g.gain.value = level;
  g.connect(bedGain);
  return { buf, gain: g, takes: [] };
}

// A change of render crossfades rather than cuts. The renders are the same
// drone at different detune amounts, cut to the same length and loop points,
// so the new one starts at the point the old one has reached and the two
// overlap for BED_SWAP seconds. They are largely the same material, so the
// fades are complementary in amplitude, not equal power. setTargetAtTime
// rather than a curve, so a second change mid-fade simply redirects the gains
// from wherever they are.
const BED_SWAP = 4;
export async function applyBedDetune() {
  if (!bedMeta) return;
  const seq = ++bedSwapSeq;
  let buf;
  try { buf = await bedBuffer(S.bedDetune); }
  catch (e) { console.warn('drone render failed to load', e); return; }
  if (seq !== bedSwapSeq) return;      // a later choice has already taken over
  bed = buf;
  if (!bedRunning || !bedRun || bedRun.buf === buf) return;

  const ctx = getContext(), now = ctx.currentTime + 0.05, tc = BED_SWAP / 4;
  const old = bedRun;
  // the newest pass already sounding says where the drone is
  let pos = bedMeta.loopStart;
  for (const s of old.takes) if (s.at <= now) pos = s.offset + (now - s.at);
  const loopLen = bedMeta.loopEnd - bedMeta.loopStart;
  const xf = Math.min(BED_XFADE, loopLen / 2 - 0.01);
  // too close to the end for a pass and its crossfade: start at the loop
  if (bedMeta.loopEnd - pos < xf + 1) pos = bedMeta.loopStart;

  old.gain.gain.setTargetAtTime(0, now, tc);
  setTimeout(() => {
    for (const s of old.takes) { try { s.onended = null; s.stop(); } catch (e) {} }
    bedTakes = bedTakes.filter(t => !old.takes.includes(t));
    try { old.gain.disconnect(); } catch (e) {}
  }, (BED_SWAP * 2 + 0.5) * 1000);

  bedRun = newBedRun(buf, 0);
  bedRun.gain.gain.setTargetAtTime(1, now, tc);
  bedNextAt = bedTake(now, pos, bedMeta.loopEnd - pos, xf, false);
  bedPump();
}

// ---------- the arpeggio ----------
// Robert's figure: the 3, the 4 and the octave above the root, an octave
// above middle C (E5 F5 C6 against this piano's C), played fast and over and
// over, 3 4 8 3 4 8. It starts in the left ear, and a delayed copy answers in
// the right, a step and a half behind, so the echo falls between the notes
// and reads almost as a second player. Now and then an answering line comes
// in over it, the same notes turned round, 8 4 3, starting on the right and
// echoed to the left, while the main line eases back a little; after a while
// it leaves and the main line comes forward again.
//
// It is a synth voice, not the piano: one oscillator per side that never
// stops, tuned to the piano's own root (rootSoundingHz in audio/piano/
// manifest.json) so the two agree. The figure is played by the filter, not
// the level: each note steps the pitch and opens a low-pass that then falls
// shut again, the Attack and Decay dials setting how fast it opens and
// closes, so the line is one smooth tone swelling and dimming rather than a
// row of plucks. It has its own mixer channel ('arp' in mixgate.js: level,
// mute, solo and meter) and shares the piano's room, fed the same way the
// drone is. It runs only while the music is on and its switch is up.
const ARP_A = [76, 77, 84], ARP_B = [84, 77, 76];

// ---------- the sequencer ----------
// The figure is no longer fixed: each step reads the playing pattern
// (S.seqPatterns[S.seqSlot], edited in the sequencer window), up to 16 steps
// long, a step holding a written note or -1 for a rest. A rest leaves the
// filter shut, so the line breathes there instead of sounding. The grid's
// rows are the scale over two octaves, from the 1 an octave above middle C
// (the octave that holds the original 3 4 8) up to the 15, two octaves on.
export const SEQ_ROWS = [96, 95, 93, 91, 89, 88, 86,          // 15 14 13 12 11 10 9
                         84, 83, 81, 79, 77, 76, 74, 72];    // 8 7 6 5 4 3 2 1, top to bottom
export const SEQ_MAX = 16, SEQ_SLOTS = 4;
const SEQ_DEFAULT = { len: 3, steps: ARP_A };   // read once per step: never rebuilt
export function seqPattern() {
  const pats = S.seqPatterns, p = pats && pats[S.seqSlot | 0];
  if (!p || !Array.isArray(p.steps)) return SEQ_DEFAULT;
  return p;
}
// Where the playhead is: every scheduled step is noted with its time, and
// the window asks which was the last one to sound.
const MARKS = 32;
const markT = new Float64Array(MARKS).fill(-1), markI = new Int8Array(MARKS).fill(-1);
let markN = 0;
function seqMark(t, i) { markT[markN] = t; markI[markN] = i; markN = (markN + 1) % MARKS; }
export function seqPlayhead() {
  const ctx = getContext();
  if (!arp || !ctx) return -1;
  const now = ctx.currentTime;
  let best = -1, bt = -1;
  for (let k = 0; k < MARKS; k++) if (markT[k] <= now && markT[k] > bt) { bt = markT[k]; best = markI[k]; }
  return best;
}
// A fresh pattern: a note on three steps in four, walking the scale more
// often than leaping, the chord tones (1 3 5 8, and 10 12 15 above) three
// times as likely as the others. It starts in the lower octave.
const SEQ_ROW_W = [3, 1, 1, 3, 1, 3, 1, 3, 1, 1, 3, 1, 3, 1, 3];
const SEQ_ROW_WSUM = SEQ_ROW_W.reduce((a, b) => a + b, 0);
export function seqRandomize(p) {
  const last = SEQ_ROWS.length - 1;
  let row = [7, 10, 12, 14][(Math.random() * 4) | 0];
  for (let i = 0; i < SEQ_MAX; i++) {
    if (i > 0 && Math.random() < 0.25) { p.steps[i] = -1; continue; }
    if (i > 0) {
      if (Math.random() < 0.6) row = Math.max(0, Math.min(last, row + (Math.random() < 0.5 ? -1 : 1)));
      else {
        let r = Math.random() * SEQ_ROW_WSUM;
        for (let k = 0; k <= last; k++) { r -= SEQ_ROW_W[k]; if (r <= 0) { row = k; break; } }
      }
    }
    p.steps[i] = SEQ_ROWS[row];
  }
}
const ARP_ECHO = 0.75;          // the answering copy's level
const ARP_DIP = 0.65;           // the main line's level while the answer plays
const ARP_ROOT_HZ = 79.5;                // the piano's sounding root
// Rough loudness matching between shapes, so a change of waveform is a
// change of colour rather than of level.
const ARP_WAVE_GAIN = { sine: 1, triangle: 0.85, sawtooth: 0.42, square: 0.34 };
let arp = null;
const arpWave = () => (ARP_WAVE_GAIN[S.arpWave] ? S.arpWave : 'sine');
// The volume sweep: the same slow motion as the drone's sweeps (sweep.js),
// moving a gain of its own between the low and high shares of the set level,
// so the arpeggio swells and recedes on its own schedule. Off, it glides
// back to full and stays there.
const arpVolSweep = createSweep({
  domain: 'lin',
  read: c => {
    c.on = S.arpSwOn; c.lo = S.arpSwLo; c.hi = S.arpSwHi;
    c.period = S.arpSwPeriod; c.wander = S.arpSwWander;
  }
});
// The strobe's flash rate as it is actually shown (the frame-locked rate
// when locked, drift included otherwise) and its waveform, for Vary with
// strobe.
const strobeHz = () => Math.max(0.1, (S.frameLock && S.achievedFreq) || S.effFreq || S.freq || 7.5);
const strobeWave = () => (S.wave === 'sine' || S.wave === 'triangle' || S.wave === 'square' ? S.wave : 'sine');
const arpAmDepth = () => Math.max(0, Math.min(1, S.arpStrobeAm || 0));
const arpTargetRate = () => Math.max(2, Math.min(14, S.arpRate || 7));
const arpStepS = () => 1 / arpTargetRate();

// pan and echoPan are bare directions (-1 or 1); the Stereo spread dial
// scales them, 0 folding everything to the centre and 100% panning hard.
const arpSpread = () => Math.max(0, Math.min(1, S.arpSpread ?? 0.9));
function arpVoice(ctx, pan, echoPan) {
  const o = ctx.createOscillator();
  o.type = arpWave();
  o.frequency.value = ARP_ROOT_HZ * Math.pow(2, (ARP_A[0] - ROOT) / 12);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 200;
  filt.Q.value = 1;
  const wg = ctx.createGain();
  wg.gain.value = ARP_WAVE_GAIN[arpWave()];
  o.connect(filt); filt.connect(wg);
  o.start();
  const inG = ctx.createGain();
  wg.connect(inG);
  const dryP = ctx.createStereoPanner(); dryP.pan.value = pan * arpSpread();
  const d = ctx.createDelay(2); d.delayTime.value = arpStepS() * 1.5;
  const eg = ctx.createGain(); eg.gain.value = ARP_ECHO;
  const echoP = ctx.createStereoPanner(); echoP.pan.value = echoPan * arpSpread();
  inG.connect(dryP); inG.connect(d); d.connect(eg); eg.connect(echoP);
  return { o, filt, wg, inG, dryP, d, eg, echoP, panSign: pan, echoSign: echoPan };
}
// One note: the pitch steps (a few ms of glide, so the tone never clicks)
// and the filter opens toward the note's brightness over the Attack, then
// falls back toward just above the fundamental over the Decay. Targets are
// scheduled in order, so no cancel is ever needed; a fast figure simply
// catches the filter wherever the last fall left it.
function arpNote(written, vel, at, v) {
  const oct = Math.round(S.arpOct || 0);
  const hz = ARP_ROOT_HZ * Math.pow(2, (written - ROOT) / 12 + oct);
  v.o.frequency.setTargetAtTime(hz, at, 0.006);
  const open = Math.min(14000, hz * (5 + vel * 14));
  const atk = Math.max(0.001, S.arpAtk || 0.01);
  const dec = Math.max(0.02, S.arpDec || 0.25);
  v.filt.frequency.setTargetAtTime(open, at, atk / 3);
  v.filt.frequency.setTargetAtTime(hz * 1.4, at + atk, dec / 3);
}
function arpStart() {
  const ctx = getContext();
  if (arp || !ctx || !dry || !room) return;
  // level, then the channel gate, then a meter tap feeding the piano's dry
  // bus and room, as the drone's is
  const out = ctx.createGain(); out.gain.value = 0;
  // Vary with strobe: an oscillator at the flash rate swinging this gain
  // around 1 - depth/2 by depth/2, so at full depth the line pulses from full
  // to silence on every flash, and at 0 the gain simply sits at 1.
  const amG = ctx.createGain();
  const amLfo = ctx.createOscillator(), amDepth = ctx.createGain();
  const amD = arpAmDepth();
  amG.gain.value = 1 - amD / 2; amDepth.gain.value = amD / 2;
  amLfo.type = strobeWave(); amLfo.frequency.value = strobeHz();
  amLfo.connect(amDepth); amDepth.connect(amG.gain); amLfo.start();
  const swG = ctx.createGain(); swG.gain.value = 1;   // the volume sweep's own hand
  const chanG = ctx.createGain(); chanG.gain.value = chanGate('arp');
  // its own share of the piano's room, before the shared wet level
  const revG = ctx.createGain(); revG.gain.value = Math.max(0, S.arpRev ?? 1);
  const tap = meterTap(ctx, dry, revG);
  revG.connect(room.input);
  out.connect(amG); amG.connect(swG); swG.connect(chanG); chanG.connect(tap.analyser);
  arpVolSweep.start(ctx, swG.gain, 1);
  const a = arpVoice(ctx, -1, 1), b = arpVoice(ctx, 1, -1);
  for (const v of [a, b]) { v.dryP.connect(out); v.echoP.connect(out); }
  b.inG.gain.value = 0;
  const now = ctx.currentTime;
  markT.fill(-1);
  // The 8 4 3 answer is parked for now (bNext never arrives): only the main
  // 3 4 8 line plays. Restore the old schedule, now + 16 + Math.random() * 14,
  // to bring the answering layer back.
  arp = { out, amG, amLfo, amDepth, swG, chanG, revG, tap, a, b, rate: arpTargetRate(), next: now + 0.1, ia: 0, ib: 0,
          bOn: false, bUntil: 0, bTail: 0, bNext: Infinity, timer: null, amHz: NaN, dAt: NaN };
  glideParam(out.gain, S.arpVol, 1.0);
  arpPump();
}
function arpPump() {
  if (!arp) return;
  const ctx = getContext(), target = arpTargetRate();
  while (arp.next < ctx.currentTime + 0.6) {
    const t = arp.next;
    // The speed eases toward the dial over about a second and a half, note
    // by note, so a moved Speed accelerates or slows the figure instead of
    // jumping it to the new tempo mid-phrase.
    const step = 1 / arp.rate;
    arp.rate += (target - arp.rate) * (1 - Math.exp(-step / 1.5));
    if (!arp.bOn && t >= arp.bNext) {
      // the answer comes in and the main line eases back
      arp.bOn = true; arp.bUntil = t + 8 + Math.random() * 8; arp.ib = 0;
      arp.a.inG.gain.setTargetAtTime(ARP_DIP, t, 0.7);
      arp.b.inG.gain.setTargetAtTime(1, t, 0.7);
    } else if (arp.bOn && t >= arp.bUntil) {
      arp.bOn = false; arp.bTail = t + 3; arp.bNext = t + 16 + Math.random() * 14;
      arp.a.inG.gain.setTargetAtTime(1, t, 1.0);
      arp.b.inG.gain.setTargetAtTime(0, t, 1.0);
    }
    const pat = seqPattern();
    const len = Math.max(1, Math.min(SEQ_MAX, pat.len | 0));
    const si = arp.ia++ % len;
    const note = pat.steps[si];
    if (note >= 0) arpNote(note, 0.46 + Math.random() * 0.08, t, arp.a);
    seqMark(t, si);
    if (arp.bOn || t < arp.bTail) {
      // half a step off the main line, so the two interleave
      arpNote(ARP_B[arp.ib++ % 3], 0.42 + Math.random() * 0.08, t + step * 0.5, arp.b);
    }
    arp.next += step;
  }
  // The strobe pulse follows the flash rate as it drifts, and its shape.
  // Each target is written only when it has moved: a param handed a fresh
  // setTarget every pump never settles, so the browser keeps working it out
  // sample by sample for good (the delay line's per-sample read above all),
  // where one already heading to the same value is left to come to rest.
  const hz = strobeHz();
  if (hz !== arp.amHz) { arp.amHz = hz; arp.amLfo.frequency.setTargetAtTime(hz, ctx.currentTime, 0.05); }
  if (arp.amLfo.type !== strobeWave()) arp.amLfo.type = strobeWave();
  // the echoes ride the eased speed too, a step and a half behind it; the
  // easing creeps toward the dial for ever, so a change under a millionth
  // (a fraction of a microsecond of delay) counts as none
  const d = 1.5 / arp.rate;
  if (!(Math.abs(d - arp.dAt) <= d * 1e-6)) {
    arp.dAt = d;
    arp.a.d.delayTime.setTargetAtTime(d, ctx.currentTime, 0.25);
    arp.b.d.delayTime.setTargetAtTime(d, ctx.currentTime, 0.25);
  }
  arp.timer = setTimeout(arpPump, 200);
}
function arpStop() {
  if (!arp) return;
  const a = arp; arp = null;
  arpVolSweep.stop();
  clearTimeout(a.timer);
  glideParam(a.out.gain, 0, 0.8);
  setTimeout(() => {
    try { a.amLfo.stop(); a.amLfo.disconnect(); a.amDepth.disconnect(); a.amG.disconnect(); } catch (e) {}
    try { a.out.disconnect(); a.swG.disconnect(); a.chanG.disconnect(); a.revG.disconnect(); a.tap.analyser.disconnect(); } catch (e) {}
    for (const v of [a.a, a.b]) {
      try { v.o.stop(); } catch (e) {}
      for (const k of ['o', 'filt', 'wg', 'inG', 'dryP', 'd', 'eg', 'echoP']) {
        try { v[k].disconnect(); } catch (e) {}
      }
    }
  }, 4000);
}
// The switch, level and speed. A new speed moves the echo with it, so the
// answer stays a step and a half behind.
export function applyArp() {
  const want = running && S.arpOn;
  if (want && !arp) arpStart();
  else if (!want && arp) arpStop();
  if (!arp) return;
  glideParam(arp.out.gain, S.arpVol, 0.2);
  glideParam(arp.revG.gain, Math.max(0, S.arpRev ?? 1), 0.1);
  const amD = arpAmDepth();
  glideParam(arp.amG.gain, 1 - amD / 2, 0.05);
  glideParam(arp.amDepth.gain, amD / 2, 0.05);
  arpVolSweep.update();
  // the speed and the echo delay ease from arpPump; nothing to jump here
  const wave = arpWave();
  const spread = arpSpread();
  for (const v of [arp.a, arp.b]) {
    glideParam(v.dryP.pan, v.panSign * spread, 0.1);
    glideParam(v.echoP.pan, v.echoSign * spread, 0.1);
    if (v.o.type !== wave) { v.o.type = wave; glideParam(v.wg.gain, ARP_WAVE_GAIN[wave], 0.05); }
  }
}

// The drone's own switch: parked or woken without touching the piano. Off
// mid-session fades it out through bedOff's ramp; on brings it back with its
// usual opening glide.
export function applyBedOn() {
  if (!running) return;
  if (S.bedOn !== false) bedOn(); else bedOff();
}

export async function pianoOn() {
  if (!ready && !(await loadPiano())) return false;
  const ctx = getContext();
  if (!ctx) return false;
  running = true;
  clock = ctx.currentTime + 0.4;
  elapsed = 0;
  step();
  if (S.bedOn !== false) bedOn();
  if (S.arpOn) arpStart();
  return true;
}
export function pianoOff() { running = false; clearTimeout(timer); bedOff(); arpStop(); }
export const pianoReady = () => ready;
export const pianoAvailable = () => canOpus;
