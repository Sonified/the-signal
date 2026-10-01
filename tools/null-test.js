// The null-test bench's page (documents/heart-audio-engine.md, §9). The
// scenarios and the arithmetic live in null-test-scenarios.js; this draws
// them as a table, runs them on both engines and fills each row in: the
// verdict, the residual's peak and RMS, and a trace of the residual itself.
//
//   node tools/serve.mjs  →  http://localhost:8000/tools/null-test.html

import { SCENARIOS, renderNative, renderHeart, residual } from './null-test-scenarios.js';

const $ = id => document.getElementById(id);
const RATES = [{ sr: 48000, box: 'r48', label: '48 kHz' }, { sr: 44100, box: 'r44', label: '44.1 kHz' }];
const fmt = db => db === -Infinity ? '−∞' : (db < 0 ? '−' : '') + Math.abs(db).toFixed(1);

// results.get(id + '@' + sr) = { pass, peakDb, error }
const results = new Map();
// heard.get(id + '@' + sr) = { native, heart, diff, peak, sr }: the last
// render of each side, kept so its row's buttons can play it
const heard = new Map();
const cells = new Map();
let running = false;

// ---------- the table ----------
function build() {
  const groups = new Map();
  for (const sc of SCENARIOS) {
    if (!groups.has(sc.group)) groups.set(sc.group, []);
    groups.get(sc.group).push(sc);
  }
  const root = $('groups');
  for (const [group, list] of groups) {
    const h = document.createElement('h2');
    h.textContent = group;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>Scenario</th><th>Mark</th>${RATES.map(r =>
      `<th>${r.label} · verdict, peak, RMS, residual</th>`).join('')}</tr></thead>`;
    const body = document.createElement('tbody');
    for (const sc of list) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.className = 'name';
      name.textContent = sc.name;
      if (sc.note) {
        const note = document.createElement('small');
        note.textContent = sc.note;
        name.append(note);
      }
      name.title = 'Run this scenario';
      name.onclick = () => run([sc]);
      const mark = document.createElement('td');
      mark.className = 'mark';
      mark.textContent = `< ${fmt(sc.pass)} dB`;
      tr.append(name, mark);
      for (const r of RATES) {
        const td = document.createElement('td');
        td.innerHTML = '<div class="cell"><span class="pill">·</span><span class="num"></span><span class="num rms"></span><canvas width="320" height="60"></canvas>' +
          '<span class="plays"><button title="Play the native render" disabled>N</button>' +
          '<button title="Play Heart\'s render" disabled>H</button>' +
          '<button title="Play the residual, raised to −12 dBFS so the difference can be heard" disabled>Δ</button></span></div>';
        const k = key(sc, r.sr);
        td.querySelectorAll('.plays button').forEach((b, i) => { b.onclick = () => listen(k, ['native', 'heart', 'diff'][i], b); });
        cells.set(key(sc, r.sr), td);
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    root.append(h, wrap);
  }
}

const key = (sc, sr) => `${sc.id}@${sr}`;

function show(sc, sr, state) {
  const td = cells.get(key(sc, sr));
  const [pill, peak, rms, canvas, plays] = td.querySelector('.cell').children;
  const got = !state.busy && heard.get(key(sc, sr));
  plays.querySelectorAll('button').forEach((b, i) => {
    b.disabled = !got || (i === 2 && !(got.peak > 0 && Number.isFinite(got.peak)));
  });
  pill.className = 'pill' + (state.busy ? ' busy' : state.pass ? ' pass' : ' fail');
  pill.textContent = state.busy ? '…' : state.pass ? 'PASS' : 'FAIL';
  td.querySelector('.err')?.remove();
  if (state.busy) { peak.textContent = rms.textContent = ''; clear(canvas); return; }
  if (state.error) {
    peak.textContent = rms.textContent = '';
    clear(canvas);
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = state.error;
    td.append(err);
    return;
  }
  const r = state.r;
  peak.textContent = fmt(r.peakDb);
  peak.title = `signal peak ${fmt(r.levelDb)} dBFS`;
  rms.textContent = fmt(r.rmsDb);
  if (state.refused) {
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = `Heart refused ${state.refused} command${state.refused === 1 ? '' : 's'}`;
    td.append(err);
  }
  trace(canvas, r);
}

function clear(canvas) {
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// The residual, scaled to its own peak: per pixel column, the lowest and
// highest sample, left channel in gold and right fainter, over a hairline.
function trace(canvas, r) {
  const g = canvas.getContext('2d'), w = canvas.width, h = canvas.height, mid = h / 2;
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--line').trim();
  g.fillRect(0, mid, w, 1);
  if (!(r.peak > 0) || !Number.isFinite(r.peak)) return;
  const colours = [css.getPropertyValue('--gold').trim(), css.getPropertyValue('--gold-soft').trim()];
  for (let c = 1; c >= 0; c--) {
    const d = r.diff[c], per = d.length / w;
    g.fillStyle = colours[c];
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0;
      for (let i = Math.floor(x * per), end = Math.floor((x + 1) * per); i < end; i++) {
        if (d[i] < lo) lo = d[i];
        if (d[i] > hi) hi = d[i];
      }
      const y0 = mid - (hi / r.peak) * (mid - 1), y1 = mid - (lo / r.peak) * (mid - 1);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
}

// ---------- listening ----------
// One live context plays whichever render was asked for, at half level so a
// full-scale scenario never arrives at full volume; asking again, or for
// another, stops what is playing. The residual is raised so its peak sits at
// −12 dBFS, since at −100 dB it would be silence: what you hear is the shape
// of the difference, not its size.
let listenCtx = null, playing = null;
function stopListening() {
  if (!playing) return;
  try { playing.src.stop(); } catch (e) {}
  playing.button.classList.remove('on');
  playing = null;
}
function listen(k, which, button) {
  const was = playing && playing.button === button;
  stopListening();
  if (was) return;
  const got = heard.get(k);
  if (!got) return;
  listenCtx = listenCtx || new AudioContext();
  listenCtx.resume();
  const chans = got[which], raise = which === 'diff' ? 0.25 / got.peak : 1;
  const buf = listenCtx.createBuffer(2, chans[0].length, got.sr);
  for (let c = 0; c < 2; c++) {
    const out = buf.getChannelData(c), x = chans[c];
    for (let i = 0; i < x.length; i++) out[i] = x[i] * raise;
  }
  const src = listenCtx.createBufferSource(), g = listenCtx.createGain();
  g.gain.value = 0.5;
  src.buffer = buf;
  src.connect(g).connect(listenCtx.destination);
  src.onended = () => { if (playing && playing.src === src) stopListening(); };
  src.start();
  button.classList.add('on');
  playing = { src, button };
}

// ---------- running ----------
async function runOne(sc, sr) {
  show(sc, sr, { busy: true });
  // One buffer cache for both sides, so they read the very same AudioBuffers.
  const cache = new Map();
  let state;
  try {
    const native = await renderNative(sc, sr, cache);
    const heart = await renderHeart(sc, sr, cache);
    const r = residual(native, heart.channels);
    heard.set(key(sc, sr), { native, heart: heart.channels, diff: r.diff, peak: r.peak, sr });
    const refused = heart.stats.rejected;
    state = { r, refused, pass: r.peakDb < sc.pass && !refused };
  } catch (err) {
    console.error(sc.id, sr, err);
    state = { pass: false, error: String(err && err.message || err) };
  }
  results.set(key(sc, sr), { pass: state.pass, peakDb: state.r ? state.r.peakDb : NaN, sc });
  show(sc, sr, state);
}

async function run(list) {
  if (running) return;
  running = true;
  $('run').disabled = true;
  const rates = RATES.filter(r => $(r.box).checked);
  let done = 0;
  const total = list.length * rates.length;
  for (const sc of list) {
    for (const r of rates) {
      $('summary').textContent = `Running ${++done} of ${total}: ${sc.group}, ${sc.name}, ${r.label}`;
      await runOne(sc, r.sr);
      // let the page draw between scenarios
      await new Promise(requestAnimationFrame);
    }
  }
  running = false;
  $('run').disabled = false;
  summarise();
}

// Per rate, how many of the scenarios run so far pass, and the worst
// residual measured against its own mark.
function summarise() {
  const parts = [];
  for (const r of RATES) {
    const rows = [...results.entries()].filter(([k]) => k.endsWith('@' + r.sr)).map(([, v]) => v);
    if (!rows.length) continue;
    const passed = rows.filter(v => v.pass).length;
    const worst = rows.reduce((w, v) => {
      const over = (Number.isNaN(v.peakDb) ? Infinity : v.peakDb) - v.sc.pass;
      return !w || over > w.over ? { over, v } : w;
    }, null);
    const tone = passed === rows.length ? '' : ' class="bad"';
    parts.push(`<b${tone}>${passed} of ${rows.length}</b> pass at ${r.label}` +
      (passed < rows.length ? `, the furthest out: ${worst.v.sc.name} (${fmt(worst.v.peakDb)} dB)` : ''));
  }
  $('summary').innerHTML = parts.join('<br>') || 'Nothing run.';
}

build();
$('run').onclick = () => run(SCENARIOS);
