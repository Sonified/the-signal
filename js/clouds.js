// The generative clouds.
//
// Eight sustained pads, one per degree of the mode, played as a line rather
// than a bed. Every rule here came out of two takes played by hand on the live
// player, and the comments say which measurement. The pads sit at the same root
// as the piano, two octaves under the 40 Hz carrier, so the two instruments and
// the entrainment tone are the same number rather than merely compatible.
//
// The two takes do different things, and that difference IS the engine:
//
//   "Clouds wandering"  31 notes / 238 s. A line that meanders. Single notes,
//                       17 of 28 moves a single scale step, direction turning
//                       about every other note, gaps 4.5 to 12.5 s, half the
//                       notes in the root octave.
//
//   "Clouds Phrase"     11 notes / 54 s. A figure that FALLS by step from the
//                       fifth — 5 3 2 1, then 5 3 2 7 — with 2.2 to 2.6 s gaps
//                       INSIDE the figure and 5 to 10 s after it, then a leap
//                       back up to start again. Seven of ten moves descending.
//
// So: wander, and every so often fall. The weighting between them is the knob
// that decides whether the music is drifting or saying something.
//
// One thing deliberately not reproduced is the first take's density. Robert's
// note on it was that it ran 25 to 50 percent busier than he wanted, so every
// measured gap is stretched by CLOUD_SPARSE before anything else touches it.
import { S } from './state.js';
import { getContext, getMaster } from './audio.js';
import { meterTap, tapPeak } from './util.js';

const ROOT = 48;                       // written C3; sounds ~79.5 Hz
const DEG  = [0, 2, 4, 7, 11];         // 1 2 3 5 7, the 8 is the next octave's 1

// The semitone offsets that have a real recording. Everything else is resampled
// from the nearest of these.
const PADS = [-12, -5, 0, 2, 4, 7, 11, 12];
const NAMES = { '-12': 'octbelow', '-5': '5below', '0': '1', '2': '2',
                '4': '3', '7': '5', '11': '7', '12': '8' };

// Per-note volume, measured on the sandbox keyboard across the white keys of
// three octaves while auditioning every resampled pad. Keyed by written
// semitone offset from ROOT; a key the walk never actually visits (it only
// ever visits scale degrees 1 2 3 5 7) can still be in here from that
// audition and is simply never looked up.
const NOTE_TRIM = {
  0: 0.92, 2: 0.74, 4: 0.57, 7: 0.38, 9: 1.16, 11: 0.30,
  12: 0.25, 14: 0.20, 16: 0.09, 19: 0.03, 23: 0.03, 24: 0.03
};
const noteTrim = semi => NOTE_TRIM[semi] ?? 1;

// The performance envelope, also measured on the sandbox keyboard: the
// amplitude opens over a little more than a second and lets go over six and a
// half, and the filter trails it by about a second so a held pad sounds like
// it is arriving rather than switching on. Length is fixed, release included,
// because nothing here holds a key down to end it.
const ENV = {
  aA: 1.23, aD: 1.39, aS: 86, aR: 6.51,
  fOn: true, cut: 420, q: 0.8, fAmt: 3.2, fA: 3, fD: 4, fS: 100, fR: 3.5,
  hpOn: true, hp: 934,
  len: 11
};
const clampFilterHz = v => Math.max(20, Math.min(20000, v));
const FILTER_SUSTAIN_HZ = clampFilterHz(ENV.cut * Math.pow(2, ENV.fAmt * ENV.fS / 100));

// The line is walked in SCALE INDEX, not semitones: one step is one note of the
// mode, so "a step" means the same thing at the bottom of the range as the top.
// Index 0 is the root, 3 is the fifth above it, 5 is the octave.
const idxToSemi = i => {
  const oct = Math.floor(i / 5);
  return oct * 12 + DEG[i - oct * 5];
};
// The wandering take spanned index -5 to +8. A little headroom either side, with
// the centring pull below keeping the line off the edges.
const LO_IDX = -5, HI_IDX = 10;
const FIFTH = 3;                       // scale index of the fifth, where the figure starts

// Step size in scale steps, off the wandering take once its two accidental
// leaps are dropped: 17 of 28 moves were a single step, only two were a genuine
// jump across registers.
const STEP_W = { 1: 61, 2: 11, 3: 11, 4: 10, 5: 4, 7: 3 };
// Direction-run lengths were 3 1 1 3 4 3 5 2 1 1 1 3 1 1 — mean 2.1, so the line
// turns about every other note. That is what wanders instead of running scales.
const RUN_W = { 1: 5, 2: 4, 3: 3, 4: 1, 5: 1 };
// Both figures in the second take came down four notes and three notes.
const FALL_W = { 4: 5, 3: 5, 2: 2, 5: 1 };

// Measured gaps. The wandering take split roughly 60/40 between close and open;
// the phrase take's internal gaps were 2.2 to 2.6 s and its rests 4.4 to 10.1.
const GAP_CLOSE = [4.5, 8.0], GAP_OPEN = [8.0, 12.5], P_CLOSE = 0.6;
const GAP_INSIDE = [2.1, 2.7], GAP_REST = [4.4, 10.2];
// The stretch from the raw measured gaps to the engine's own resting density.
// A falling figure fits several notes into one gesture, so simply replaying the
// measured gaps comes out busier than the take did; 1.6 is what puts the engine
// back at the take's own rate of 0.130 notes per second. That is the default
// because it is what Robert actually played -- the cloud density control in the
// drawer goes down to 20 percent from here, which is the direction he wanted
// room to move in. Only gaps are stretched, never the 2.2 s steps inside a
// figure: stretching those would take the figure apart.
const CLOUD_SPARSE = 1.6;

const pads = new Map();                // semitone offset -> AudioBuffer
let ready = false, loading = null;
let dry = null, verb = null, wet = null, padTap = null;
let running = false, clock = 0, timer = null;
// walk state: where the line is, which way it is going, how much of this run is left
let idx = 0, dir = 1, run = 0;

const canOpus = (() => {
  const a = new Audio();
  return a.canPlayType('audio/ogg; codecs=opus') !== ''
      || a.canPlayType('audio/webm; codecs=opus') !== '';
})();

const rnd = (a, b) => a + Math.random() * (b - a);
const rndOf = r => rnd(r[0], r[1]);
const clampIdx = i => Math.max(LO_IDX, Math.min(HI_IDX, i));
function weighted(obj) {
  const keys = Object.keys(obj);
  let r = Math.random() * keys.reduce((s, k) => s + obj[k], 0);
  for (const k of keys) { r -= obj[k]; if (r <= 0) return +k; }
  return +keys[0];
}
const nearest = semi => PADS.reduce((a, b) => Math.abs(b - semi) < Math.abs(a - semi) ? b : a);

// ---- diagnostics ------------------------------------------------------------
// One line per pad, in the same note naming the sandbox trim strip uses, so a
// note that comes out wrong can be read back instead of guessed at. On by
// default while this is being chased; localStorage.signal_cloudlog = '0' to
// silence it.
const NOTE_LETTERS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const noteName = semi =>
  NOTE_LETTERS[((semi % 12) + 12) % 12] + (3 + Math.floor(semi / 12));
const LOG = (() => {
  try { return localStorage.getItem('signal_cloudlog') !== '0'; } catch (e) { return true; }
})();
// How many pads are sounding at this instant: a note that reads as one loud
// note may be several landing together.
let voices = 0;

function impulse(ctx, sec, decay) {
  const n = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/n, decay);
  }
  return b;
}

// Loaded on demand rather than at boot, for the same reason the piano is: two
// megabytes should not be fetched by someone who never turns the music on.
export function loadClouds() {
  if (loading) return loading;
  const ctx = getContext();
  if (!ctx || !canOpus) return Promise.resolve(false);
  loading = (async () => {
    const get = async u => ctx.decodeAudioData(await (await fetch(u)).arrayBuffer());
    await Promise.all(PADS.map(async sm =>
      pads.set(sm, await get(`audio/music/clouds/clouds-${NAMES[sm]}.opus`))));
    buildGraph();
    ready = true;
    return true;
  })().catch(err => { console.warn('clouds failed to load', err); loading = null; return false; });
  return loading;
}

function buildGraph() {
  const ctx = getContext(), master = getMaster();
  if (!ctx || !master) return;
  dry  = ctx.createGain(); dry.gain.value = 1;
  verb = ctx.createConvolver(); verb.buffer = impulse(ctx, S.cloudRevTime, 2.2);
  wet  = ctx.createGain(); wet.gain.value = S.cloudReverb;
  dry.connect(master);
  verb.connect(wet).connect(master);
  padTap = meterTap(ctx, dry, verb);       // the mixer's clouds meter
}

// A suspended context keeps returning the last block it rendered, so the
// transport decides whether there is anything to show, not the analyser.
export const cloudPeak = () =>
  S.running && S.audioEnabled && getContext()?.state === 'running' ? tapPeak(padTap) : 0;

export function applyCloudReverb() {
  if (wet) wet.gain.setTargetAtTime(S.cloudReverb, getContext().currentTime, 0.08);
}
let irTimer = null;
export function rebuildCloudIR() {
  if (!verb) return;
  clearTimeout(irTimer);
  irTimer = setTimeout(() => { verb.buffer = impulse(getContext(), S.cloudRevTime, 2.2); }, 200);
}

// One pad, shaped by the fixed performance envelope: an amplitude ADSR and a
// lowpass that opens behind it, both scaled down together when the pad has
// been resampled too far up to have ENV.len seconds of recording left.
//
// The catch is resampling: a pad played an octave up runs at twice the rate
// and lasts half as long. The envelope has to fit inside what is actually
// left of the buffer, or the tail is cut off mid-fade and the pad ends on an
// edge — the same reason a fixed length is squeezed rather than truncated.
function cloud(written, vel, at, tag = '') {
  const ctx = getContext();
  const semi = written - ROOT;
  const src = nearest(semi);
  const buf = pads.get(src);
  if (!buf || !dry) return;

  const s = ctx.createBufferSource();
  s.buffer = buf;
  const rate = Math.pow(2, (semi - src) / 12);
  s.playbackRate.value = rate;
  const life = buf.duration / s.playbackRate.value - 0.3;

  // A fixed length, release included: starting the release at the length and
  // letting it run on past it is what turns an 11 second note into a sixteen
  // second one. Squeezed to whatever is actually left of the buffer, the same
  // shape scaled down rather than a cut-off one.
  const LEN = Math.max(0.5, Math.min(ENV.len, life));
  const squeeze = (a, r) => (a + r > LEN) ? LEN / (a + r) : 1;
  const kA = squeeze(Math.max(0.002, ENV.aA), Math.max(0.005, ENV.aR));

  const peak = vel * vel * S.cloudVol * noteTrim(semi);
  const g = ctx.createGain();

  // ---- the filter, and its envelope in octaves above the cutoff -----------
  let node = s;
  if (ENV.fOn) {
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = ENV.q;
    const base = clampFilterHz(ENV.cut);
    const top  = clampFilterHz(ENV.cut * Math.pow(2, ENV.fAmt));
    const kF = squeeze(Math.max(0.002, ENV.fA), Math.max(0.005, ENV.fR));
    const fA = Math.max(0.002, ENV.fA) * kF, fD = Math.max(0.02, ENV.fD * kF);
    filt.frequency.setValueAtTime(base, at);
    filt.frequency.exponentialRampToValueAtTime(top, at + fA);
    filt.frequency.exponentialRampToValueAtTime(FILTER_SUSTAIN_HZ, at + Math.min(LEN, fA + fD));
    filt.frequency.exponentialRampToValueAtTime(base, at + LEN);
    node.connect(filt);
    node = filt;
  }
  if (ENV.hpOn) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.Q.value = 0.707;
    hp.frequency.value = clampFilterHz(ENV.hp);
    node.connect(hp);
    node = hp;
  }
  node.connect(g); g.connect(padTap.analyser);

  // ---- the amplitude envelope -----------------------------------------------
  const A = Math.max(0.002, ENV.aA) * kA, D = Math.max(0.02, ENV.aD * kA);
  const R = Math.max(0.005, ENV.aR) * kA;
  const sustain = peak * (ENV.aS / 100);
  const tR = Math.max(A, LEN - R);          // the release never precedes the peak
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + A);
  if (tR > A) {
    const dEnd = Math.min(tR, A + D);
    g.gain.linearRampToValueAtTime(sustain, at + dEnd);
    if (tR > dEnd) g.gain.setValueAtTime(sustain, at + tR);
  }
  g.gain.linearRampToValueAtTime(0, at + LEN);

  s.start(at);
  let stopped = true;
  try { s.stop(at + LEN + 0.1); } catch (e) { stopped = false; }

  if (LOG) {
    voices++;
    s.onended = () => { voices--; };
    const lead = at - ctx.currentTime;
    const listed = NOTE_TRIM[semi] !== undefined;
    console.log(
      `[cloud] ${noteName(semi)} semi=${semi} ${tag}` +
      ` pad=${NAMES[src]} rate=${rate.toFixed(3)}` +
      ` trim=${noteTrim(semi)}${listed ? '' : ' UNLISTED'}` +
      ` vel=${vel.toFixed(2)} cloudVol=${S.cloudVol} peak=${peak.toFixed(3)}` +
      ` buf=${buf.duration.toFixed(2)} life=${life.toFixed(2)} LEN=${LEN.toFixed(2)} kA=${kA.toFixed(3)}` +
      ` A=${A.toFixed(2)} D=${D.toFixed(2)} R=${R.toFixed(2)} tR=${tR.toFixed(2)}` +
      ` lead=${lead.toFixed(2)} stop=${stopped ? (LEN + 0.1).toFixed(2) : 'FAILED'}` +
      ` voices=${voices} ctx=${ctx.state} running=${S.running} rev=${S.cloudReverb}`
    );
    // Read the gain back at the top of the attack. If the envelope took, this
    // is within a hair of peak; anything else means the automation did not
    // land, which is the case where a pad plays flat out to the end of the file.
    setTimeout(() => {
      if (!g) return;
      const actual = g.gain.value;
      const off = peak > 0 ? 20 * Math.log10(Math.max(actual, 1e-6) / peak) : 0;
      console.log(`[cloud]   ${noteName(semi)} at attack top: gain=${actual.toFixed(4)}` +
        ` expected=${peak.toFixed(4)} off=${off.toFixed(1)}dB`);
    }, Math.max(0, (at - ctx.currentTime + A) * 1000));
  }
}

// The next note of the meander. Steps are small and the direction turns often;
// what keeps the line off the ends is a pull toward the middle that grows with
// distance, rather than a clamp — a clamp sounds like bouncing off a wall. The
// wandering take put 15 of its 31 notes in the root octave, 9 below and 7 above,
// which is what that pull is tuned to.
function nextIdx() {
  if (run <= 0) {
    run = weighted(RUN_W);
    const reach = idx === 0 ? 0 : (idx > 0 ? idx / HI_IDX : idx / LO_IDX);  // 0 centre, 1 edge
    const inward = idx === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(idx);
    dir = Math.random() < 0.5 + 0.4 * reach ? inward : -inward;
  }
  run--;
  let next = idx + weighted(STEP_W) * dir;
  if (next > HI_IDX || next < LO_IDX) {           // turn early rather than pile up at the end
    dir = -dir; run = 0;
    next = idx + weighted(STEP_W) * dir;
  }
  idx = clampIdx(next);
  return idx;
}

// ---- gestures ---------------------------------------------------------------
// Each returns { end, gap }: when it stops scheduling, and how long to wait
// after that. Only the gap is stretched by the density controls — stretching a
// figure's internal timing would take the figure apart.

// The second take, almost literally. Start on the fifth, come down by step,
// rest. Both of its figures began exactly there, and the octave is chosen from
// wherever the line already is so the figure does not teleport.
function gFall(at) {
  // Both of the take's figures started on the fifth in the root octave, so that
  // is where this starts, with an occasional one an octave up. Deliberately NOT
  // derived from wherever the line currently is: doing that let each figure
  // begin where the last one ended, and the whole line ratcheted into the floor
  // and hammered the bottom pad.
  let i = clampIdx(FIFTH + (Math.random() < 0.75 ? 0 : 5));
  // and never fall past the bottom, because a clamped fall repeats one pad,
  // which is the one thing a figure must not do
  const len = Math.min(weighted(FALL_W), i - LO_IDX + 1);
  let t = at;
  for (let n = 0; n < len; n++) {
    cloud(ROOT + idxToSemi(i), rnd(0.72, 0.9), t, `fall=${n + 1}/${len} idx=${i}`);
    if (n < len - 1) {
      t += rndOf(GAP_INSIDE);
      // the take's second figure closed 2 1 7-below rather than 2 1, so the
      // last step down is sometimes a degree further than the rest
      i = Math.max(LO_IDX, i - ((n === len - 2 && Math.random() < 0.35) ? 2 : 1));
    }
  }
  idx = i;
  // it leaves the line low and settled; whatever comes next climbs back out
  dir = 1; run = 0;
  return { end: t, gap: rndOf(GAP_REST) };
}

// The first take: one note, small step, long wait.
function gWander(at) {
  const i = nextIdx();
  cloud(ROOT + idxToSemi(i), rnd(0.7, 0.88), at, `wander idx=${i} dir=${dir} run=${run}`);
  return { end: at, gap: Math.random() < P_CLOSE ? rndOf(GAP_CLOSE) : rndOf(GAP_OPEN) };
}

function step() {
  if (!running) return;
  const ctx = getContext();
  const now = ctx.currentTime;
  // Scheduled further ahead than the piano, because a pad's attack is seconds
  // long and a late start is audible as a swell arriving behind the music.
  while (clock < now + 4) {
    const at = Math.max(clock, now + 0.08);
    const g = Math.random() < S.cloudPhrase ? gFall(at) : gWander(at);
    clock = g.end + g.gap * CLOUD_SPARSE / S.cloudDensity;
  }
  timer = setTimeout(step, 700);
}

export async function cloudsOn() {
  if (!ready && !(await loadClouds())) return false;
  const ctx = getContext();
  if (!ctx) return false;
  running = true;
  clock = ctx.currentTime + 0.5;
  // Start where the wandering take started: low, on the root, moving up. Its
  // first two notes were C2 then D2.
  idx = -5; dir = 1; run = weighted(RUN_W);
  step();
  return true;
}
export function cloudsOff() { running = false; clearTimeout(timer); }
export const cloudsReady = () => ready;
export const cloudsAvailable = () => canOpus;
