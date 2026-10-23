// The first group touch experience, wired on the foundation
// (documents/touch-foundation.md): pick a brush, draw - the mark duplicates
// into a kaleidoscope and rides the video feedback - then the hall pairs
// you, and in the end everyone draws together.
//
//   ?hall=name    which hall to join (default 'lobby': one address, one room)
//   ?conduct=key  join as the conductor, who moves the phases
//   ?relay=host   another relay than the site's own worker
//   ?replay=1     play the hall's tape instead of joining it (replay.js)

import { createScene } from './scene.js';
import { createHall } from './hall.js';
import { BRUSHES, encodeStroke, decodeStroke, drawStroke } from './strokes.js';
import { runReplay } from './replay.js';

const RELAY_HOST = 'the-signal-broadcast.robertalexander-music.workers.dev';
const HUES = [8, 42, 95, 168, 212, 285, 330];
const FLUSH_MS = 45, FLUSH_POINTS = 16;
const SLICE_STEPS = [1, 4, 6, 8, 12];

const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const canvas = $('scene');
const scene = createScene(canvas);
addEventListener('resize', () => scene.resize());

// ---------- who I am ----------
let brush = 0;
let hue = HUES[Math.floor(Math.random() * HUES.length)];
let width = 22;
let slicesAt = 2;   // SLICE_STEPS[2] = 6

// ---------- the hall ----------
// A replay page is an audience, not a member: it never joins, so the tape
// plays undisturbed by live strokes and the hall never counts it present.
const REPLAY = Q.get('replay') === '1';
const HOST = Q.get('relay') || RELAY_HOST;
const HALL_NAME = (Q.get('hall') || 'lobby').replace(/[^\w-]/g, '').slice(0, 64) || 'lobby';
const hall = REPLAY ? null : createHall({
  host: HOST,
  hall: HALL_NAME,
  key: Q.get('conduct') || '',
  on: {
    state: say,
    peer: () => say(),
    group: g => { flash(groupWords(g)); say(); },
    message: msg => {
      const s = decodeStroke(msg);
      if (s) scene.stamp(ctx => drawStroke(ctx, s, scene.map, scene.side));
    }
  }
});

function groupWords(g) {
  if (g.phase === 'solo') return 'drawing alone';
  if (g.phase === 'pairs') {
    const others = g.ids.filter(id => id !== g.you).length;
    return others === 0 ? 'waiting for a partner' : others === 1 ? 'drawing with a partner' : 'drawing in a trio';
  }
  return 'everyone together';
}

// ---------- drawing ----------
// One batch per finger: points gather and flush on a short clock, each
// point stamped locally the moment it lands so the hand never waits on the
// wire. Remote marks take the very same path (strokes.js).
const fingers = new Map();   // pointerId -> { pts, d, last, timer }

function unit(e) {
  const r = canvas.getBoundingClientRect();
  const side = Math.min(r.width, r.height);
  return {
    u: Math.max(0, Math.min(1, ((e.clientX - r.left) - r.width / 2) / side + 0.5)),
    v: Math.max(0, Math.min(1, ((e.clientY - r.top) - r.height / 2) / side + 0.5))
  };
}

function stampLocal(points) {
  const s = decodeStroke(encodeStroke(brush, hue, width, 1, points));
  if (s) scene.stamp(ctx => drawStroke(ctx, s, scene.map, scene.side));
}

function flush(f, done) {
  if (f.pts.length) {
    if (hall) hall.send(encodeStroke(brush, hue, width, done ? 2 : f.d, f.pts));
    f.d = 1;
    f.pts = [f.pts[f.pts.length - 1]];   // the joint the next batch grows from
  }
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  const p = unit(e);
  const f = { pts: [p], d: 0, timer: setInterval(() => flush(f, false), FLUSH_MS) };
  fingers.set(e.pointerId, f);
  stampLocal([p]);
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  const f = fingers.get(e.pointerId);
  if (!f) return;
  const p = unit(e);
  const prev = f.pts[f.pts.length - 1];
  stampLocal([prev, p]);
  f.pts.push(p);
  if (f.pts.length >= FLUSH_POINTS) flush(f, false);
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, e => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    clearInterval(f.timer);
    flush(f, true);
    fingers.delete(e.pointerId);
  });
}

// ---------- the frame ----------
(function loop() {
  scene.frame();
  requestAnimationFrame(loop);
})();

// ---------- the little UI ----------
function say() {
  if (!hall) {
    $('status').textContent = 'playing the tape';
    $('dot').style.background = `hsl(${hue} 90% 60%)`;
    return;
  }
  const here = hall.peers.size;
  const net = hall.you ? `${here} here` : 'offline, drawing alone';
  $('status').textContent = `${net}${hall.you ? ' · ' + groupWords({ phase: hall.phase, you: hall.you, ids: [...hall.group] }) : ''}`;
  $('dot').style.background = `hsl(${hue} 90% 60%)`;
}

let flashTimer = 0;
function flash(words, h) {
  const el = $('flash');
  el.textContent = words;
  el.style.color = h === undefined ? '#fff' : `hsl(${h} 90% 70%)`;
  el.style.opacity = 1;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.style.opacity = 0; }, 2400);
}

// the picker: brushes and hues; Begin closes it
function buildPicker() {
  const row = $('brushes');
  BRUSHES.forEach((b, i) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (i === brush ? ' on' : '');
    chip.textContent = b.label;
    chip.onclick = () => { brush = i; [...row.children].forEach((c, j) => c.classList.toggle('on', j === brush)); };
    row.appendChild(chip);
  });
  const hues = $('hues');
  HUES.forEach(h => {
    const dot = document.createElement('button');
    dot.className = 'dot' + (h === hue ? ' on' : '');
    dot.style.background = `hsl(${h} 90% 60%)`;
    dot.onclick = () => { hue = h; [...hues.children].forEach(c => c.classList.toggle('on', c === dot)); say(); };
    hues.appendChild(dot);
  });
  $('begin').onclick = () => { $('picker').style.display = 'none'; if (hall) flash(groupWords({ phase: hall.phase, you: hall.you, ids: [...hall.group] })); };
  $('brushChip').onclick = () => { $('picker').style.display = ''; };
  $('slices').onclick = () => {
    slicesAt = (slicesAt + 1) % SLICE_STEPS.length;
    scene.set.slices = SLICE_STEPS[slicesAt];
    $('slices').textContent = `× ${SLICE_STEPS[slicesAt]}`;
  };
  $('slices').textContent = `× ${SLICE_STEPS[slicesAt]}`;
}
buildPicker();
say();

// ---------- the replay ----------
// The tape plays itself: no picker, no hall - the scene is the audience's,
// though a finger can still draw over the playback, which is only fair.
if (REPLAY) {
  $('picker').style.display = 'none';
  runReplay({ host: HOST, hall: HALL_NAME, scene, flash });
}

// the conductor's three words, only on a key that worked
const PHASE_WORDS = [['solo', 'Alone'], ['pairs', 'Pairs'], ['all', 'Together']];
function buildConductor() {
  if (!hall.conduct) return;
  const bar = $('conduct');
  bar.style.display = '';
  for (const [p, label] of PHASE_WORDS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.onclick = () => hall.setPhase(p);
    bar.appendChild(b);
  }
  // Replay sails this page into playback: same hall, the conduct key kept,
  // so the chips come back when the tape ends and the page is reloaded
  const r = document.createElement('button');
  r.className = 'chip';
  r.textContent = 'Replay';
  r.onclick = () => {
    const q = new URLSearchParams(location.search);
    q.set('replay', '1');
    location.search = q.toString();
  };
  bar.appendChild(r);
  // Wipe clears the hall's tape ({t:'wipe'}) so the next gathering records fresh
  const wipe = document.createElement('button');
  wipe.className = 'chip';
  wipe.textContent = 'Wipe';
  wipe.onclick = () => { hall.send({ t: 'wipe' }); flash('tape wiped'); };
  bar.appendChild(wipe);
}
// conduct is only known once the hello lands; a replay page joined nothing
if (hall) {
  const conductWait = setInterval(() => {
    if (hall.you) { clearInterval(conductWait); buildConductor(); }
  }, 300);
}
