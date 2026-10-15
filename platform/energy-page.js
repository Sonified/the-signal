// The energy profile, the page's half (core/energy.js is the engine
// thread's): the sound, the network, the CPU canary and, in worker mode,
// the page's own frame loop. Its text follows the engine's on the
// clipboard. It lives on the page in both engine modes, since the sound
// always does.
//
// Like the engine's half it is always counting. The Heart engine's own
// stats tick (four a second, js/heart/engine.js) brings its numbers, so
// that costs no timer of its own; the canary is one message every
// CANARY_EVERY_MS to a worker (platform/energy-canary.js) while the page is
// in sight, and the same timer looks for the Heart engine until it starts.
import { getContext } from '../js/audio.js';
import { heartEngine, heartOn, FAMILIES } from '../js/heart/route.js';
import { liveInputs } from '../js/livesound.js';

const MINUTE_MS = 60000;
const KEEP_ROWS = 120;
const CANARY_EVERY_MS = 15000;
const CANARY_WARMUP = 2;      // replies thrown away while the worker's code warms up
const CHUNK = 512;            // js/heart/ring.js

let started = false, workerMode = false, startT = 0, minuteStart = 0;
const rows = [];
let cur = null, totals = null;
let heartSeen = null, underrunsAtStart = -1, underrunsLast = 0;
// each Heart render stage's share of its own thread, summed per reading
let stageSum = [], stageN = 0;
let canary = null, canaryReplies = 0, canaryFirst = -1, canaryBest = Infinity, canaryLast = -1;

function newRow(i) {
  return { i, heartN: 0, heartSum: 0, heartMax: 0, underruns: 0, pageFrames: 0, pageMs: 0, canary: Infinity };
}
function advance(now) {
  while (now >= minuteStart + MINUTE_MS) {
    rows.push(cur);
    if (rows.length > KEEP_ROWS) rows.shift();
    cur = newRow(cur.i + 1);
    minuteStart += MINUTE_MS;
  }
}

function onHeartStats(s) {
  const eng = heartSeen;
  if (!eng || !s || !s.renderMs) return;
  advance(performance.now());
  const budget = 1000 * CHUNK / eng.sampleRate;
  let worst = 0;
  for (let k = 0; k < s.renderMs.length; k++) {
    if (s.renderMs[k] > worst) worst = s.renderMs[k];
    stageSum[k] = (stageSum[k] || 0) + s.renderMs[k] / budget;
  }
  stageN++;
  const load = worst / budget;
  cur.heartN++; cur.heartSum += load; totals.heartN++; totals.heartSum += load;
  if (load > cur.heartMax) cur.heartMax = load;
  if (load > totals.heartMax) totals.heartMax = load;
  if (underrunsAtStart < 0) underrunsAtStart = underrunsLast = s.underruns;
  if (s.underruns > underrunsLast) cur.underruns += s.underruns - underrunsLast;
  underrunsLast = s.underruns;
}

function lookForHeart() {
  const eng = heartEngine();
  if (eng && eng !== heartSeen && eng.on) {
    heartSeen = eng;
    underrunsAtStart = -1; underrunsLast = 0;
    stageSum = []; stageN = 0;
    eng.on('stats', onHeartStats);
  }
}

function onCanary(e) {
  const ms = e.data && e.data.ms;
  if (!(ms > 0)) return;
  if (++canaryReplies <= CANARY_WARMUP) return;
  advance(performance.now());
  if (canaryFirst < 0) canaryFirst = ms;
  if (ms < canaryBest) canaryBest = ms;
  canaryLast = ms;
  if (ms < cur.canary) cur.canary = ms;
}

function tick() {
  lookForHeart();
  if (canary && !document.hidden) canary.postMessage(0);
}

// Once at boot, on the page: worker says whether the engine runs in a
// worker (then the page's own frame loop is counted too).
export function startPageEnergy(worker) {
  if (started) return;
  started = true;
  workerMode = !!worker;
  startT = minuteStart = performance.now();
  cur = newRow(0);
  totals = newRow(-1);
  try { performance.setResourceTimingBufferSize(2000); } catch (e) {}
  try {
    canary = new Worker(new URL('./energy-canary.js', import.meta.url));
    canary.onmessage = onCanary;
  } catch (e) { canary = null; }
  // two early looks, so the warm-up is over by the first real reading
  setTimeout(tick, 2000); setTimeout(tick, 4000);
  setInterval(tick, CANARY_EVERY_MS);
}

// Worker mode: the page's frame loop (platform/worker-bridge.js), its start
// and end.
export function pageEnergyFrame(t0, t1) {
  if (!started) return;
  advance(t1);
  cur.pageFrames++; cur.pageMs += t1 - t0;
  totals.pageFrames++; totals.pageMs += t1 - t0;
}

// The CPU by thread, as far as the page can see it: the page's own loop (in
// worker mode; in main mode it is the engine thread, in the engine half),
// and each Heart render stage, a worker of its own rendering one chunk in
// each chunk's time, so its render time over the chunk's length is how busy
// that thread is. The drain (an audio worklet) and the browser's own audio
// keep no account the page can read.
const ROLE_NAME = ['combined', 'island', 'mix'];
function threadLines(eng) {
  const out = [];
  if (workerMode && totals.pageFrames) {
    const span = performance.now() - startT;
    out.push(`  page thread   ${Math.round(100 * totals.pageMs / span)}% busy with its frame loop (${(totals.pageMs / totals.pageFrames).toFixed(2)} ms a frame)`);
  }
  if (eng && stageN) {
    let sum = 0;
    for (let k = 0; k < stageSum.length; k++) {
      const st = eng.stages && eng.stages[k];
      const share = stageSum[k] / stageN;
      sum += share;
      const name = st ? ROLE_NAME[st.role] || 'stage' : 'stage';
      const isl = st && st.islands && st.islands.length ? ' (' + st.islands.join(', ') + ')' : '';
      out.push(`  heart ${k} ${name}${isl}`.padEnd(16) + ` ${Math.round(100 * share)}% busy rendering`);
    }
    out.push(`  heart total   ${(sum * 100).toFixed(0)}% of one core across ${stageSum.length} thread${stageSum.length === 1 ? '' : 's'}`);
  }
  out.push(`  unmeasured    the audio output worklet, the browser's own audio, the compositor and the GPU process`);
  return out;
}

// ---------- the text (on the tap) ----------
const pct = v => Math.round(v * 100) + '%';
const pad = (v, n) => { const s = String(v); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const ms1 = v => (v * 1000).toFixed(0) + ' ms';

function networkLine() {
  let list = [];
  try { list = performance.getEntriesByType('resource'); } catch (e) {}
  let bytes = 0;
  const byType = new Map();
  for (const e of list) {
    const b = e.transferSize || 0;
    bytes += b;
    byType.set(e.initiatorType, (byType.get(e.initiatorType) || 0) + b);
  }
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
  const parts = [...byType.entries()].filter(([, b]) => b > 0).sort((x, y) => y[1] - x[1]).map(([k, b]) => k + ' ' + mb(b));
  return `${list.length} requests, ${mb(bytes)} transferred${parts.length ? ' (' + parts.join(', ') + ')' : ''}; cached and some media reads count 0`;
}

export function pageEnergyText() {
  if (!started) return 'page: energy counting not started';
  lookForHeart();
  const now = performance.now();
  advance(now);
  const ctx = getContext();
  const eng = heartEngine();
  const onHeart = FAMILIES.filter(f => heartOn(f));
  const live = liveInputs ? liveInputs() : null;
  const lines = [
    `page (sound, network, CPU canary), ${((now - startT) / MINUTE_MS).toFixed(1)} min counted`,
    `audio           ${ctx ? ctx.state + ', ' + ctx.sampleRate + ' Hz, base latency ' + (ctx.baseLatency ? ms1(ctx.baseLatency) : '-') + ', output latency ' + (ctx.outputLatency ? ms1(ctx.outputLatency) : '-') : 'no context yet'}`,
    `heart           ${eng ? 'on (' + eng.mode + ', ' + (eng.stages ? eng.stages.length : '?') + ' render stage' + (eng.stages && eng.stages.length === 1 ? '' : 's') + '), families ' + (onHeart.join(', ') || 'none') + ', chunk budget ' + (1000 * CHUNK / eng.sampleRate).toFixed(1) + ' ms' + (eng.isResting && eng.isResting() ? ', resting now' : '') : 'off (every family on the browser\'s own audio)'}`,
    `heart load      ${totals.heartN ? 'busiest stage ' + pct(totals.heartSum / totals.heartN) + ' of the chunk budget on average, worst ' + pct(totals.heartMax) + ' (' + totals.heartN + ' readings)' : 'no readings'}`,
    `heart underruns ${underrunsAtStart >= 0 ? underrunsLast - underrunsAtStart : '-'}`,
    `live sound      ${live && live.length ? live.length + ' input' + (live.length === 1 ? '' : 's') : 'off'}`,
    `page thread     ${workerMode ? (totals.pageFrames ? (totals.pageMs / totals.pageFrames).toFixed(2) + ' ms a frame over ' + totals.pageFrames + ' frames' : 'no frames') : 'the engine thread (main mode), counted above'}`,
    `network         ${networkLine()}`,
    `cpu by thread (the engine thread is in the engine half above)`,
    ...threadLines(eng),
    `cpu canary      ${canaryLast > 0 ? 'first ' + canaryFirst.toFixed(1) + ' ms, best ' + canaryBest.toFixed(1) + ', last ' + canaryLast.toFixed(1) + ' (' + Math.round(100 * (canaryLast / canaryBest - 1)) + '% over best; rising = the phone slowing as it heats)' : 'no readings yet'}`,
    ``,
    `per minute (heart = busiest stage's share of the chunk budget; canary = best that minute)`,
    `  min  heart avg  heart max  underruns  canary ms${workerMode ? '  page ms/f' : ''}`
  ];
  for (const r of rows.concat([cur])) {
    lines.push('  ' + [
      pad(r.i, 3), pad(r.heartN ? pct(r.heartSum / r.heartN) : '-', 9), pad(r.heartN ? pct(r.heartMax) : '-', 9),
      pad(r.heartN ? r.underruns : '-', 10), pad(r.canary < Infinity ? r.canary.toFixed(1) : '-', 10)
    ].join(' ') + (workerMode ? pad(r.pageFrames ? (r.pageMs / r.pageFrames).toFixed(2) : '-', 11) : ''));
  }
  return lines.join('\n');
}
