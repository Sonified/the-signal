// The brush: the hand's instrument on the main field. A press on the bare
// field that travels past the tap's threshold is a stroke, drawn from where
// it went down (core/tap-drag.js tells the two apart); a press that never
// does is still the tap it always was: run and stop, or putting the drawer
// away. The stroke stamps the motif picked in the drawer's Brush section
// (one tile of the current Image set's atlas) along the path, in Copies
// copies about the field centre, into a trail image of its own that fades
// over the Fade slider's time (gpu/brush.js). Nothing waits on the network:
// every stamp is queued the frame the hand makes it.
//
// The same stroke goes out on the hall, when one is joined (main.js and
// platform/brush-hall.js, touch/hall.js underneath), as the motif brush's
// batches (touch/strokes.js), and every motif stroke that arrives from the
// hall is stamped through the very same walk (core/brush-stamps.js), so
// every screen draws the same figure from the same messages. Who hears whom
// is the hall's business (the phases live on the server); this side only
// sends its own strokes and draws what comes in.
//
// The demo broadcast carries the same strokes one way (core/broadcast.js):
// on the broadcasting tab each batch, encoded once, goes to the hall and to
// every watched session; a follower hands each one to brushTake exactly as
// a hall stroke, so its figure is the broadcaster's, drawn from the
// stroke's own fields (its copies, rate, set, tile and width), whatever the
// follower's own Brush settings say. A follower never sends one back.
//
// The stamps wait in a ring (STAMP_FLOATS each: u, v in the wire's unit
// square, the angle, the motif's side in unit-square units, the tile, the
// atlas set, the sender's id for core/brush-order.js, and the stroke's
// stamp spacing over the motif's side, 0 for a print, by which the
// particles' light is shared out along a ribbon, gpu/brush.js, and its
// brightness, 1 but on a replayed stroke's fade up and fade down,
// fadeGains) until gpu/brush.js
// takes them, in order, which it does as soon
// as the set's atlas is on the GPU; a ring that fills drops its oldest. Its
// picker (the drawer's Brush section) reads brushAtlas, which the GPU side
// keeps for the current Image set.
//
// No allocation on the hand's own path while no hall is joined: the walk
// emits straight into the ring. A joined hall's batches are built every
// FLUSH_MS, as touch/main.js's are.

import { S } from '../js/state.js';
import { kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';
import { idleWake } from './idle.js';
import { MOTIF, QUANT, encodeStroke, decodeStroke, timesToQ } from '../touch/strokes.js';
import { tapStep } from '../touch/hall.js';
import { roomClockMs } from './room-clock.js';
import { dealHand } from '../broadcast-worker/src/deal.js';
import { seedOf, notesFor, nextBand } from './brush-notes.js';
import { SOLO_ID, BROADCAST_ID } from './brush-order.js';
import { planPass, retime, ROOM_WINDOW_MS, LOOP_MS } from './brush-replay.js';
import { playStep, PLAY_STAGES, DELAY0_MS, minOffset, playTime, ratchetDelay, timelineAt } from './brush-playback.js';
import { createTapDrag, tapDragStep, TD_START, TD_MOVE, TD_TAP, TD_END, TD_CANCEL } from './tap-drag.js';
import { BRUSH_W, ROTATE_MAX, brushSide, brushSpacing, stampCopies, walkSegment, walkBatch, fieldSquare, rateContinuous, printsPerSecond } from './brush-stamps.js';

// The wire's pace: a batch at least every flushMs() while the hand moves
// (the room's Stream when the hall has told one, else FLUSH_MS), and never
// more than FLUSH_POINTS points in one (touch/main.js's numbers). Each point
// goes with the frame's clock when it was made (the wire's q), so a
// receiver plays the stroke on this hand's own timeline.
const FLUSH_MS = 20, FLUSH_POINTS = 16;
// The size a stroke is drawn at (its w): the room's when the hall has told
// one to a member, else this screen's own Size.
function brushSizeNow() {
  const z = brushMember() && hallLink.size > 0 ? hallLink.size : S.brushSize;
  return z >= 1 && z <= 100 ? z : BRUSH_W;
}
// The turn of the marks, turns a second: the room's when the hall has told
// one to a member, else this screen's own Rotation.
// The turn of the shape itself, turns a second: the room's when the hall
// has told one to a member, else this screen's own Shape rotation.
export function brushSpinNow() {
  const r = brushMember() && hallLink.spin >= 0 ? hallLink.spin : S.brushSpin;
  return r > 0 ? (r < ROTATE_MAX ? r : ROTATE_MAX) : 0;
}
// A stamp's turn (radians) from the shared clock: its moment on this
// screen's clock (key, ms, as brushNow reads) laid on the room's clock, or
// on the wall clock outside a broadcast room, times the speed. Nothing but
// the speed crosses the wire; every screen derives the same angle for the
// same moment. off is sharedOffset(), taken once a frame.
export function brushSpinAt(rate, key, off) {
  const turns = ((key + off) / 1000 * rate) % 1;
  return turns * Math.PI * 2;
}
export function brushSharedOffset() {
  const ms = roomClockMs();
  return (ms === ms ? ms : Date.now()) - clock();
}
export function brushRotateNow() {
  const r = brushMember() && hallLink.rotate >= 0 ? hallLink.rotate : S.brushRotate;
  return r > 0 ? (r < ROTATE_MAX ? r : ROTATE_MAX) : 0;
}
function flushMs() { return hallLink && hallLink.stream > 0 ? hallLink.stream : FLUSH_MS; }
// The hue the stroke carries on the wire (its h): this screen's identity,
// one of /touch/'s, for the stand-in it draws there. The motif itself keeps
// its own colours.
const HUES = [8, 42, 95, 168, 212, 285, 330];
const HUE = HUES[Math.floor(Math.random() * HUES.length)];

// ---------- the ring ----------
export const STAMP_FLOATS = 9;
// Room for a few frames of the densest drawing (a fast flick at the
// continuous spacing with 24 copies is some 4000 stamps a frame).
const QCAP = 65536;
// Beside each stamp: its time (key, ms on this screen's clock: when the
// hand made it, or a remote stamp's time on its sender's timeline mapped
// here) and its place in the order stamps came (seq). gpu/brush.js bakes
// each into the trail when its time is a delay old, all senders' together
// in time order, and draws the younger ones live over the trail till then
// (core/brush-order.js bakeOrder): so who is on top where two hands overlap
// is who drew later, never whose stamps happened to arrive later.
export const brushQueue = { buf: new Float32Array(QCAP * STAMP_FLOATS), key: new Float64Array(QCAP), seq: new Float64Array(QCAP),
                            cap: QCAP, head: 0, count: 0 };
// How many of the ring's oldest stamps gpu/brush.js looks at in a frame
// (its MAX_PEND). The show's playback also waits while the ring holds more
// than this (replayTick): past it the GPU side is behind, and letting more
// of the tape out would only lengthen the line, not draw it any sooner.
export const BRUSH_LOOK = 16384;

// What the walk's stamps are made of right now (set before each walk).
let qSide = 0, qMotif = 0, qSet = 1, qWho = SOLO_ID, qKey = 0, qSeqN = 0, qSpan = 0, qGain = 1;
function push(u, v, angle) {
  const q = brushQueue;
  if (q.count === q.cap) { q.head = (q.head + 1) % q.cap; q.count--; }
  const at = (q.head + q.count) % q.cap, o = at * STAMP_FLOATS, b = q.buf;
  b[o] = u; b[o + 1] = v; b[o + 2] = angle; b[o + 3] = qSide; b[o + 4] = qMotif; b[o + 5] = qSet;
  b[o + 6] = qWho; b[o + 7] = qSpan; b[o + 8] = qGain;
  q.key[at] = qKey; q.seq[at] = qSeqN++;
  q.count++;
}

// Takes the stamps marked (marks[i] for the i-th from the head) out of the
// ring, keeping the rest in their order: the ones the GPU side baked this
// frame, wherever they sat among younger ones.
export function brushQueueRemove(marks) {
  const q = brushQueue, b = q.buf, F = STAMP_FLOATS;
  let w = 0;
  for (let i = 0; i < q.count; i++) {
    if (marks[i]) continue;
    if (w !== i) {
      const from = (q.head + i) % q.cap, to = (q.head + w) % q.cap;
      b.copyWithin(to * F, from * F, from * F + F);
      q.key[to] = q.key[from]; q.seq[to] = q.seq[from];
    }
    w++;
  }
  q.count = w;
}
// The walk's emit, made once.
const emit = (u, v, angle) => push(u, v, angle);

// gpu/brush.js has drawn the first n stamps.
export function brushQueueDrop(n) {
  const q = brushQueue;
  const k = n < q.count ? n : q.count;
  q.head = (q.head + k) % q.cap;
  q.count -= k;
}

// ---------- the picker's atlas ----------
// The current Image set's atlas as the GPU side last built it: whether it is
// on the GPU (ready), which set, its non-empty tiles in sheet order (tiles,
// count of them) and which tiles are empty, and where a tile's motif sits in
// the sheet as UV (the layout's padding and inner square). want is the set
// the picker asked for this frame, 0 when none was drawn; gpu/brush.js loads
// it.
export const brushAtlas = {
  set: 0, ready: false, count: 0,
  tiles: new Uint8Array(64), empty: new Uint8Array(64),
  padUV: 0, innerUV: 0, want: 0
};

// The tile a stroke stamps: the picked one, unless the current set's atlas
// says it is empty, then that set's first painted tile. Before the atlas is
// known the pick stands as it is.
export function brushMotifNow() {
  const m = S.brushMotif | 0;
  const a = brushAtlas;
  if (a.ready && a.set === kaleidoscopeSet(S.kaleidoSet).id && a.count > 0 && (m < 0 || m > 63 || a.empty[m])) return a.tiles[0];
  return m < 0 ? 0 : m > 63 ? 63 : m;
}

// Whether the dealt hand shows as a row of buttons to pick from
// (ui/screens/hand.js). Off — the show's way for now — the hand is dealt
// exactly as ever, but no selector shows anywhere: each drawer simply draws
// with the first brush of their own hand (brushHallHand picks it the moment
// a hand arrives), assigned, not chosen. The drawer's atlas picker still
// picks any tile over it. Turn it back on and the row returns, pick and all.
export const SHOW_HAND = false;

// ---------- the hand ----------
const sq = { cx: 0, cy: 0, side: 1 };
const gesture = createTapDrag();
let pressing = false;
// The stroke's last point, quantized as the wire carries it, and the walk's
// carry; its settings, held for the whole stroke.
let lastQu = 0, lastQv = 0, carry = 0;
let sCopies = 1, sMotif = 0, sSet = 1, sFade = 0.5, sSize = BRUSH_W, sSpacing = 0;
// The Rate, held for the stroke: continuous, or prints every printMs (the
// last at lastPrintT), each print one point on the wire (core/brush-stamps.js).
let sRate = 1, sPrints = false, printMs = 1000, lastPrintT = 0;
// The batch waiting to go out: quantized points, the first the joint.
const PEND_MAX = 64;
const pend = new Int32Array(PEND_MAX * 2);
const pendT = new Float64Array(PEND_MAX);   // each point's time, ms
let pendN = 0, pendD = 0, lastFlushT = 0;
// a stroke begun and not yet finished
let strokeOpen = false;

function quant(x) { return Math.max(0, Math.min(QUANT, Math.round(x * QUANT))); }

// Called once a built frame, after the field's interact: whether the field
// holds the press, whether it let go this frame and whether that was a
// cancel, the pointer (css px), the canvas and the drawer's inset, and the
// frame's clock (ms). Returns true only on the release of a press that never
// became a stroke, the one case the caller takes as a tap; a stroke's
// release, and any cancel, return false.
export function brushField(pressed, released, cancelled, x, y, width, height, inset, t) {
  if (pressed && !pressing) { pressing = true; tapDragStep(gesture, 'down', x, y); }
  if (!pressing) return false;
  // the release frame's own place first, so a flick between two frames
  // still counts its travel (core/tap-drag.js)
  const r = tapDragStep(gesture, 'move', x, y);
  if (r === TD_START) { begin(gesture.x0, gesture.y0, width, height, inset, t); extend(x, y, width, height, inset, t); }
  else if (r === TD_MOVE) extend(x, y, width, height, inset, t);
  if (!released && pressed) return false;
  pressing = false;
  // the field losing the press without a release counts as a cancel
  const e = tapDragStep(gesture, released && !cancelled ? 'up' : 'cancel', x, y);
  if (e === TD_END || e === TD_CANCEL) finish(t);
  return e === TD_TAP;
}

// The pointer in the wire's unit square, quantized (lastU, lastV): exactly
// the point a receiver decodes, so the walk here and there is the same.
let lastU = 0, lastV = 0;
function toUnit(x, y, width, height, inset) {
  fieldSquare(width, height, inset, sq);
  lastU = quant((x - sq.cx) / sq.side + 0.5);
  lastV = quant((y - sq.cy) / sq.side + 0.5);
}

function begin(x, y, width, height, inset, t) {
  // a broadcast resting for want of activity wakes for a stroke
  if (bcSink) bcSink.touch();
  sCopies = Math.max(1, Math.min(24, S.brushCopies | 0));
  // a tile picked from the dealt hand draws from the hand's own set
  sMotif = handSet ? Math.max(0, Math.min(63, S.brushMotif | 0)) : brushMotifNow();
  sSet = handSet || kaleidoscopeSet(S.kaleidoSet).id;
  sFade = S.brushFade >= 0 && S.brushFade <= 1 ? S.brushFade : 0.5;
  sSize = brushSizeNow();
  sSpacing = brushSpacing(sSize, S.brushContinuity);
  sRate = S.brushRate >= 0 && S.brushRate <= 1 ? S.brushRate : 1;
  sPrints = !rateContinuous(sRate);
  printMs = 1000 / printsPerSecond(sRate);
  lastPrintT = t;
  toUnit(x, y, width, height, inset);
  lastQu = lastU; lastQv = lastV;
  qSide = brushSide(sSize); qMotif = sMotif; qSet = sSet; qWho = handId(); qKey = t;
  qSpan = sPrints ? 0 : sSpacing / qSide;
  stampCopies(lastQu / QUANT, lastQv / QUANT, sCopies, emit);
  handBand = ringBand(-1, lastQv / QUANT, bellId());
  carry = 0;
  pend[0] = lastQu; pend[1] = lastQv; pendT[0] = t; pendN = 1; pendD = 0; lastFlushT = t;
  strokeOpen = true;
  idleWake('a stroke');
}

function extend(x, y, width, height, inset, t) {
  toUnit(x, y, width, height, inset);
  if (sPrints) {
    // A print where the hand is, once its time has come and the hand has
    // moved off the last one: stamped here, and one point on the wire.
    if ((lastU !== lastQu || lastV !== lastQv) && t - lastPrintT >= printMs) {
      lastPrintT = t;
      qSide = brushSide(sSize); qMotif = sMotif; qSet = sSet; qWho = handId(); qKey = t; qSpan = 0;
      stampCopies(lastU / QUANT, lastV / QUANT, sCopies, emit);
      lastQu = lastU; lastQv = lastV;
      handBand = ringBand(handBand, lastQv / QUANT, bellId());
      if (pendN < PEND_MAX) { pend[pendN * 2] = lastU; pend[pendN * 2 + 1] = lastV; pendT[pendN] = t; pendN++; }
    }
    if (pendN > 0 && (pendN >= FLUSH_POINTS || t - lastFlushT >= flushMs())) flush(false, t);
    return;
  }
  if (lastU !== lastQu || lastV !== lastQv) {
    qSide = brushSide(sSize); qMotif = sMotif; qSet = sSet; qWho = handId(); qKey = t;
    qSpan = sSpacing / qSide;
    carry = walkSegment(lastQu / QUANT, lastQv / QUANT, lastU / QUANT, lastV / QUANT, carry, sSpacing, sCopies, emit);
    lastQu = lastU; lastQv = lastV;
    handBand = ringBand(handBand, lastQv / QUANT, bellId());
    if (pendN < PEND_MAX) { pend[pendN * 2] = lastU; pend[pendN * 2 + 1] = lastV; pendT[pendN] = t; pendN++; }
  }
  if (pendN >= FLUSH_POINTS || (t - lastFlushT >= flushMs() && (pendN > 1 || pendD === 0))) flush(false, t);
}

function finish(t) {
  if (!strokeOpen) return;
  strokeOpen = false;
  // prints keep no carry anywhere, so with none waiting nothing need go
  if (!sPrints || pendN > 0) flush(true, t);
}

// The batch out on the hall, then only the joint kept, for the next to grow
// from (touch/main.js's flush). A first batch goes out even with its one
// point, so a receiver stamps the stroke's start; the last always goes, so
// a receiver lets go of the stroke's carry. Prints repeat no joint: every
// point is a print of its own.
function flush(done, t) {
  lastFlushT = t;
  const toBc = !!bcSink && bcSink.wanted();
  if ((hallLink || toBc) && pendN > 0) {
    const pts = new Array(pendN), ts = new Array(pendN);
    for (let i = 0; i < pendN; i++) { pts[i] = { u: pend[i * 2] / QUANT, v: pend[i * 2 + 1] / QUANT }; ts[i] = pendT[i]; }
    const msg = encodeStroke(MOTIF, HUE, sSize, done ? 2 : pendD, pts,
      { a: sSet, m: sMotif, c: sCopies, f: Math.round(sFade * 1000) / 1000, r: sRate, q: timesToQ(ts) });
    if (hallLink) hallLink.send(msg);
    if (toBc) bcSink.send(msg);
  }
  pendD = 1;
  if (sPrints) { pendN = 0; return; }
  pend[0] = lastQu; pend[1] = lastQv; pendT[0] = pendT[pendN - 1]; pendN = 1;
}

// ---------- started ----------
// The screen is started by the viewer's first press or key into it (the
// gesture that also wakes the sound, main.js): before that no hand row
// shows and no bell rings, whatever Show brushes and Brush notes say.
let started = false;
export function setBrushStarted() { started = true; }

// ---------- brush notes ----------
// Each hand rings a note when its stroke crosses a line between the field's
// bands (core/brush-notes.js): the hand's own the moment it draws, a remote
// one as its stroke plays out here, so every screen rings what it draws.
// The start of a stroke only finds its band. A jump past several lines at
// once rings each, in the path's order. The sound itself is
// js/brush-bells.js (a bell with Brush bells on, a note with Brush notes,
// both with both), handed in (main.js) as bellHook(seed, degree), on the
// page or across the audio link. Each identity's seed and notes are worked
// out once.
let bellHook = null, handBand = -1;
export function setBrushBell(fn) { bellHook = fn || null; }
const voices = new Map();   // identity -> { seed, notes }
function ringBand(cur, v, who) {
  // In a room the conductor's switches are the room's (the hall's nb and
  // nt, touch/hall.js): a kind the room has off counts for nobody here,
  // whatever this screen's own switches say. Which sound then rings is
  // still the screen's own pair (js/brush-bells.js), so the gate is the
  // pair: the master presenter off is silence for the room. Out of a room,
  // or under a conductor from before the room carried them, the screen's
  // own switches decide alone.
  const m = brushMember();
  const notes = S.brushNotes === true && (!m || hallLink.bells !== 0);
  const tones = S.brushTones === true && (!m || hallLink.tones !== 0);
  if (!bellHook || (!notes && !tones) || !started) return cur < 0 ? -1 : cur;
  const nb = nextBand(cur, v);
  if (cur >= 0 && nb !== cur) {
    let vc = voices.get(who);
    if (!vc) {
      if (voices.size > 256) voices.clear();
      const seed = seedOf(who);
      vc = { seed, notes: notesFor(seed) };
      voices.set(who, vc);
    }
    // line k lies between bands k and k + 1
    if (nb > cur) for (let k = cur; k < nb; k++) bellHook(vc.seed, vc.notes[k]);
    else for (let k = cur - 1; k >= nb; k--) bellHook(vc.seed, vc.notes[k]);
  }
  return nb;
}
// The hand's own identity for its bell: the broadcaster's on the
// broadcasting screen (its followers hear its strokes by the broadcast, as
// BROADCAST_ID), else its room id, or the solo one.
function bellId() { return brushConducting() ? BROADCAST_ID : handId(); }

// ---------- the hall ----------
// The link (touch/hall.js createHall, opened by platform/brush-hall.js) or
// null for a solo instrument; its state and group as last told, for the
// drawer's status line.
let hallLink = null, hallName = '', hallState = '';
export function setBrushHall(link, name) { hallLink = link; hallName = name || ''; }
// the room's name, the hall's (and its tape's) on the relay
export function brushHallName() { return hallLink ? hallName : ''; }
// The hand's own id among the senders (core/brush-order.js): its hall id
// once joined, else the solo one.
function handId() { return hallLink && hallLink.you ? hallLink.you : SOLO_ID; }
// The same, for gpu/brush.js: the frame's draw finds the hand's own stamps
// by it in the ring, to give them their share first (core/brush-order.js
// pendingWindow, shareFrame).
export function brushHandWho() { return handId(); }
// The broadcast's end (core/broadcast.js, on the broadcasting tab only):
// { wanted() whether anyone watches, send(msg) to every watched session,
// touch() wake a dozing one }, or null.
let bcSink = null;
export function setBrushBroadcast(sink) { bcSink = sink || null; }
export function brushHallState(s) {
  hallState = s; statusAt = -1e9;
  // a fresh join: the conductor says its room settings and deal again
  if (s === 'joined') { roomSent = -1; dealSent = -1; }
  // the room's life, said aloud: who this screen is there, and when it isn't
  if (s === 'joined') console.log('[drawing] room ' + hallName + ': joined as drawer ' + hallLink.you + (hallLink.conduct ? ', conducting' : '') + ' — phase ' + hallLink.phase + ' ' + (hallLink.round || 1) + ', ' + hallLink.peers.size + ' here');
  else if (s === 'offline') console.log('[drawing] room ' + hallName + ': offline');
  idleWake('the hall');
}
// Every regroup, said plainly: the phase, and for a drawer in a grouped
// phase who it is drawing with (ids, this screen's own left out).
export function brushHallGroup() {
  statusAt = -1e9;
  if (hallLink) {
    const p = hallLink.phase, r = hallLink.round || 1;
    const word = p + (r > 1 ? ' ' + r : '');
    let who = '';
    if (p === 'pairs' || p === 'quads' || p === 'halves') {
      const mates = hallLink.group ? [...hallLink.group].filter(i => i !== hallLink.you) : [];
      who = hallLink.conduct ? ' — told to the room' : mates.length ? ' — drawing with drawer' + (mates.length > 1 ? 's' : '') + ' ' + mates.join(', ') : ' — waiting for a partner';
    } else if (p === 'solo') who = ' — everyone draws alone';
    else if (p === 'master') who = ' — the conductor draws to everyone';
    else if (p === 'all') who = ' — everyone together';
    console.log('[drawing] phase ' + word + who);
  }
  idleWake('the hall');
}

// ---------- the room's settings and the dealt brushes ----------
// The conductor's Brush rows (core/schema-brush.js) are the room's: Stream,
// Smoothing, Size and the two rotations go to the hall as {t:'room', ms, sm, sz, rt, sr}, and the dealt brushes
// as {t:'brushes', on, n, a, tiles}, the tiles the current Image set's
// painted ones in sheet order (brushAtlas, so the hall deals only shapes
// that draw; broadcast-worker/src/deal.js). dealTick, every frame, sends
// either one again whenever the conductor's own settings and what was last
// sent part (a slider moved, a reconnect, the hall's wipe telling the deal
// off), waiting for the set's atlas when it must.
let roomSent = '', dealSent = -1;
function dealTick() {
  if (!brushConducting()) return;
  const ms = S.brushStream | 0, sm = S.brushSmooth | 0;
  const sz = brushSizeNow();
  const rt = brushRotateNow();
  const sr = brushSpinNow();
  // the conductor's Brush bells and Brush notes are the room's sound policy:
  // off here is off on every drawer (ringBand), their own switches notwithstanding
  const nb = S.brushNotes === true ? 1 : 0, nt = S.brushTones === true ? 1 : 0;
  const room = ms + '/' + sm + '/' + sz + '/' + rt + '/' + sr + '/' + nb + '/' + nt;
  if (room !== roomSent && ms >= 10 && ms <= 60 && sm >= 0 && sm <= 200) {
    roomSent = room;
    hallLink.send({ t: 'room', ms, sm, sz, rt, sr, nb, nt });
  }
  const set = kaleidoscopeSet(S.kaleidoSet).id;
  const on = S.brushDeal === true && !dealHold, n = Math.max(1, Math.min(8, S.brushDealN | 0));
  const sig = on ? set * 100 + n : 0;
  if (sig === dealSent) return;
  if (!on) { dealSent = sig; hallLink.send({ t: 'brushes', on: 0 }); return; }
  const a = brushAtlas;
  if (!(a.ready && a.set === set)) { a.want = set; return; }   // the deck waits for the atlas
  if (!a.count) return;
  dealSent = sig;
  hallLink.send({ t: 'brushes', on: 1, n, a: set, tiles: Array.from(a.tiles.subarray(0, a.count)) });
}

// This screen's hand: in a broadcast room the room's deal (touch/hall.js
// on.hand; the broadcasting screen's Show brushes deals the whole room,
// every hand unique), and on a screen in no room its own deal of the same
// shape: the moment Show brushes is on, Brushes each tiles of the current
// set's painted ones, from one shuffle with this page's own seed
// (broadcast-worker/src/deal.js, the hall's own law). Until the set's atlas
// is in, the hand has no tiles yet but says how many buttons it will have
// (pending), so the row shows its places at once. handSet is the set of
// the tile picked from it, 0 while the pick is the atlas picker's. A hand is
// a quick palette, not a lock: the drawer's atlas picker still picks any
// tile.
let handSet = 0;
const LOCAL_SEED = (Math.random() * 4294967296) >>> 0;
const local = { key: -1, hand: { on: 1, a: 0, tiles: [], pending: 0 } };
// the hand last told to the console (null: none yet, so a first "no hand"
// says nothing)
let handSaid = null;
export function brushHallHand(h) {
  // the deal stopped or changed: a pick from the old hand goes back to the
  // atlas picker's tile
  if (!h || !h.tiles.includes(S.brushMotif | 0) || h.a !== handSet) handSet = 0;
  // the room told the deal off while the broadcaster has it on: say it again
  if (!h && brushConducting() && S.brushDeal === true) dealSent = -1;
  // said once per change: the room repeats the same hand (or none) often
  const said = h ? h.a + ':' + h.tiles.join(',') : '';
  if (said !== handSaid) {
    // no selector shown: a NEW hand assigns its first brush to this drawer
    // (a repeat of the same hand never does, so a tile picked meanwhile in
    // the drawer's atlas picker stands)
    if (!SHOW_HAND && h && h.tiles.length) { S.brushMotif = h.tiles[0]; handSet = h.a; }
    if (h && h.tiles.length) console.log('[drawing] dealt a hand of ' + h.tiles.length + ' brush' + (h.tiles.length > 1 ? 'es' : '') + ' (set ' + h.a + ')');
    else if (!h && handSaid !== null) console.log('[drawing] the hand is cleared');
    handSaid = said;
  }
  idleWake('the hand');
}
export function brushHand() {
  // nothing before the screen is started (setBrushStarted), or while a
  // presentation holds the deal for its first drawing cue (brushDealHold)
  if (!started || dealHold) return null;
  if (hallLink && hallState === 'joined') return hallLink.hand && hallLink.hand.tiles.length ? hallLink.hand : null;
  if (S.brushDeal !== true) return null;
  const set = kaleidoscopeSet(S.kaleidoSet).id, n = Math.max(1, Math.min(8, S.brushDealN | 0));
  const a = brushAtlas, ready = a.ready && a.set === set;
  const key = ready ? set * 100 + n : -(set * 100 + n);
  if (key !== local.key) {
    local.key = key;
    local.hand = ready
      ? { on: 1, a: set, tiles: dealHand(Array.from(a.tiles.subarray(0, a.count)), LOCAL_SEED, 0, n).hand, pending: 0 }
      : { on: 1, a: set, tiles: [], pending: n };
    if (ready && handSet && !local.hand.tiles.includes(S.brushMotif | 0)) handSet = 0;
  }
  // the current set's atlas, to deal from, while it is not in yet
  if (!ready) a.want = set;
  return local.hand;
}
export function brushPickHand(i) {
  const h = brushHand();
  if (!h || i < 0 || i >= h.tiles.length) return;
  S.brushMotif = h.tiles[i];
  handSet = h.a;
}
export function brushHandPicked(i) {
  const h = brushHand();
  return !!h && handSet === h.a && (S.brushMotif | 0) === h.tiles[i];
}
// the atlas picker's own pick lets the hand's go
export function brushPickAtlas() { handSet = 0; }
// The hand's row's own atlas (the UI renderer's second picture,
// gpu/brush.js publishHand): which set it shows, once in. want is the set
// the row asked for this frame.
export const brushHandAtlas = { set: 0, ready: false, padUV: 0, innerUV: 0, want: 0 };
// A follower in the broadcast room (joined, not its broadcaster: the
// follower buttons' rule, main.js).
export function brushMember() { return !!hallLink && hallState === 'joined' && hallLink.conduct !== true; }

// The conductor's phase row (core/schema-brush.js): shown only while this
// page is joined as the hall's conductor, lit from the phase the hall last
// told (its hello and every group message, touch/hall.js), so it shows the
// server's truth, follows a phase moved from /touch/, and comes back right
// after a reconnect. A click only asks; the hall's answer is what lights.
export function brushConducting() { return !!hallLink && hallState === 'joined' && hallLink.conduct === true; }
export function brushPhase() { return hallLink ? hallLink.phase : 'solo'; }
export function brushRound() { return hallLink ? hallLink.round || 1 : 1; }
// Every drawer's group as the hall last told this conductor (id arrays), or null.
export function brushGroups() { return hallLink && hallLink.groups ? hallLink.groups : null; }
// a chip asks for its phase, or the hall's own phase again for its next round
export function brushSetPhase(p) {
  if (!brushConducting()) return;
  const [q, r] = tapStep(p, hallLink.phase, hallLink.round);
  hallLink.setPhase(q, r);
}
export function brushNext() { if (brushConducting()) hallLink.next(); }
// The controller's drawing cues (platform/presentation-receiver.js {k:'hall', p, r}):
// the phase and its round named outright, no retap walk. A click only asks,
// as the chips do; the hall's answer lights the chips and the iPad alike.
export function brushShowPhase(p, r) {
  brushDealHold(false);
  if (brushConducting()) {
    console.log('[drawing] asking the room for ' + p + (r > 1 ? ' ' + r : ''));
    hallLink.setPhase(p, r);
  } else console.log('[drawing] a drawing cue arrived but this screen conducts no room (not broadcasting?) — only the deal hold was lifted');
}

// A presentation screen (platform/presentation-receiver.js) holds the deal
// until the show's first drawing cue: no hand row on any screen, its own
// included, and the room told to deal nobody, however Show brushes is set.
// The first drawing cue lifts it (brushShowPhase above); everywhere else the
// hold never goes on and nothing changes.
let dealHold = false;
export function brushDealHold(on) {
  on = !!on;
  if (on === dealHold) return;
  dealHold = on;
  dealSent = -1;
  idleWake('the deal hold');
}

// ---------- remote strokes, played back ----------
// A stroke from the hall or the broadcast is walked the moment a batch
// arrives, exactly as a local one (the same stamps, the same order), but
// its stamps wait in a slot of their own and are let out as the slot's
// cursor passes them (core/brush-playback.js): on the sender's own timeline
// when the stroke carries its times, else on the glide. Each stamp carries
// its number in the stroke (k; a stamp's copies share it), and each point
// received its place in that count (for a continuous stroke the arc so far
// over the spacing, the walk's stamps falling every spacing; for a slowed
// one the print's own number) with its sender time, so the cursor is the
// count at the play time, interpolated between points. A stroke's last
// batch (d 2) marks it done, and the slot lets out the rest as play reaches
// the end, then frees; one whose sender vanished mid-stroke is done once
// ABANDON_MS passes with nothing new, and lets out what it has. A first
// batch from a sender whose last stroke is still playing starts a slot of
// its own beside it. With every slot busy the one fed longest ago is let
// out whole at once and taken. All of it is allocated once (but the
// senders' offsets, a small map touched as batches arrive); brushPlay,
// every frame, only reads and moves numbers.
const SLOTS = 16, SLOT_CAP = 8192, PF = 8;    // per stamp: u v angle side motif set k gain
const TL_CAP = 2048;                          // timeline points held per slot
const ABANDON_MS = 3000;
const slotBuf = new Array(SLOTS).fill(null);  // each a Float32Array, made on first use
const slotTlT = new Array(SLOTS).fill(null), slotTlP = new Array(SLOTS).fill(null);
const slotKey = new Array(SLOTS).fill(null);
const slotOn = new Uint8Array(SLOTS), slotDone = new Uint8Array(SLOTS), slotTimed = new Uint8Array(SLOTS);
const slotHead = new Int32Array(SLOTS), slotCount = new Int32Array(SLOTS), slotNextK = new Int32Array(SLOTS);
const slotTlN = new Int32Array(SLOTS), slotTlI = new Int32Array(SLOTS);
// where on the timeline the next stamp to go out stands (letOutTimed)
const slotRelI = new Int32Array(SLOTS);
const slotEnd = new Float64Array(SLOTS), slotArc = new Float64Array(SLOTS), slotCarry = new Float64Array(SLOTS);
const slotSpacing = new Float64Array(SLOTS);
// whether its stroke lays separate prints (no spacing to share its light along)
const slotPrints = new Uint8Array(SLOTS);
const slotFed = new Float64Array(SLOTS), slotCursor = new Float64Array(SLOTS);
// whether its times are already on this clock (the playback's, brushTake's onClock)
const slotLocal = new Uint8Array(SLOTS);
// A replayed stroke's fades (the Brush section's Replay fade up and fade
// down, on the playback's messages, core/brush-replay.js retime), all on
// this clock: its first point's moment and the fade up's length from it,
// held from its first batch; the moment of its real last point and the
// fade down's length after it, from its last. 0 lengths are no fade.
const slotStart = new Float64Array(SLOTS), slotFadeUp = new Float64Array(SLOTS);
const slotFadeEnd = new Float64Array(SLOTS), slotFadeDown = new Float64Array(SLOTS);
// who drew it (core/brush-order.js): the hall's id, or the broadcaster's
const slotWho = new Float64Array(SLOTS);
// the band its stroke is in, for the sender's bell (-1 before its first)
const slotBand = new Int8Array(SLOTS);
const slotStage = new Float64Array(SLOTS * PLAY_STAGES);
// Each sender's clock offset (minOffset), by key, and what late batches
// have added to this screen's delay (ratchetDelay), which only ever rises,
// on top of the base: the room's Stream plus its Smoothing as the hall told
// them, else BATCH_MS and JITTER_MS.
const offsets = new Map();
let playLate = 0;
function playBase() {
  return hallLink && hallLink.stream > 0 && hallLink.smooth >= 0 ? hallLink.stream + hallLink.smooth : DELAY0_MS;
}
function playDelayNow() { return playBase() + playLate; }
const at = { i: 0 };
// This screen's clock, ms; a test hands in its own.
let clock = () => performance.now();
export function setBrushClock(fn) { clock = fn || (() => performance.now()); }
export function brushPlayDelay() { return playDelayNow(); }
export function brushNow() { return clock(); }
// The time a stamp let out of a slot carries (see brushPlay), and the last
// frame's: a timed slot's stamps are spread between the two by where each
// falls in the stretch its cursor crossed this frame (letOutTimed).
let releaseKey = 0, lastReleaseKey = NaN;
// A fresh session's playback (the tests' between cases): the starting delay
// and no senders' offsets known.
export function brushPlayReset() { playLate = 0; offsets.clear(); }

// Stamps leave a slot for the ring the GPU side drains.
function letOut(i) {
  const b = slotBuf[i], o = slotHead[i] * PF;
  // a stamp's own copy (angle 0) is where the hand was: its band, for the
  // sender's bell, as the stroke plays out here
  if (b[o + 2] === 0 && bellHook) slotBand[i] = ringBand(slotBand[i], b[o + 1], slotWho[i]);
  qSide = b[o + 3]; qMotif = b[o + 4]; qSet = b[o + 5]; qWho = slotWho[i]; qKey = releaseKey;
  qSpan = slotPrints[i] || !(qSide > 0) ? 0 : slotSpacing[i] / qSide;
  qGain = b[o + 7];
  push(b[o], b[o + 1], b[o + 2]);
  qGain = 1;
  slotHead[i] = (slotHead[i] + 1) % SLOT_CAP;
  slotCount[i]--;
}
function letOutTo(i, cursor) {
  const b = slotBuf[i];
  while (slotCount[i] > 0 && b[slotHead[i] * PF + 6] <= cursor + 1e-9) letOut(i);
}
// A timed slot's frame: each stamp its cursor passed carries its own
// moment, the sender time its number stands at on the slot's timeline (the
// timeline read backward, from count to time) mapped onto this clock as
// play maps it (P, the sender time being played, is releaseKey here), and
// not the frame's one time. Without this every stamp let out in a frame
// shared one time, so two hands over one spot always tied, and the tie's
// rule (core/brush-order.js, the senders' one-second turn) put first one
// and then the other on top, swapping as the second turned and whenever a
// hand came or went: the flicker where shapes overlap. With their own
// times the later drawing is on top, as the bake means it to be, and the
// turn is left for stamps of the very same moment. Held between the last
// frame's time and this one's, so a stamp is never older than what was
// already let out nor younger than now's play.
function letOutTimed(i, P, c1) {
  const to = releaseKey;
  const from = lastReleaseKey < to ? lastReleaseKey : to;   // none yet, or a ratchet moved play back
  const T = slotTlT[i], Q = slotTlP[i], n = slotTlN[i], b = slotBuf[i];
  let j = slotRelI[i] < n ? slotRelI[i] : 0;
  while (slotCount[i] > 0) {
    const k = b[slotHead[i] * PF + 6];
    if (k > c1 + 1e-9) break;
    while (j + 1 < n && Q[j + 1] < k) j++;
    let t = P;
    if (n > 0) {
      if (k <= Q[j]) t = T[j];
      else if (j + 1 >= n) t = T[n - 1];
      else {
        const span = Q[j + 1] - Q[j];
        t = span > 0 ? T[j] + (T[j + 1] - T[j]) * ((k - Q[j]) / span) : T[j + 1];
      }
    }
    const key = to - (P - t);
    releaseKey = key < from ? from : key > to ? to : key;
    letOut(i);
  }
  slotRelI[i] = j;
  releaseKey = to;
}

function openSlot(key, now) {
  let i = -1, oldest = -1;
  for (let j = 0; j < SLOTS; j++) {
    if (!slotOn[j]) { i = j; break; }
    if (oldest < 0 || slotFed[j] < slotFed[oldest]) oldest = j;
  }
  if (i < 0) { i = oldest; releaseKey = clock() - playDelayNow(); while (slotCount[i] > 0) letOut(i); }
  if (!slotBuf[i]) {
    slotBuf[i] = new Float32Array(SLOT_CAP * PF);
    slotTlT[i] = new Float64Array(TL_CAP); slotTlP[i] = new Float64Array(TL_CAP);
  }
  slotOn[i] = 1; slotDone[i] = 0; slotKey[i] = key; slotBand[i] = -1;
  slotWho[i] = typeof key === 'number' ? key : BROADCAST_ID;
  slotHead[i] = 0; slotCount[i] = 0; slotNextK[i] = 0; slotTlN[i] = 0; slotTlI[i] = 0; slotRelI[i] = 0;
  slotEnd[i] = 0; slotArc[i] = 0; slotCarry[i] = 0; slotFed[i] = now; slotCursor[i] = -1;
  slotStart[i] = 0; slotFadeUp[i] = 0; slotFadeEnd[i] = 0; slotFadeDown[i] = 0;
  for (let j = 0; j < PLAY_STAGES; j++) slotStage[i * PLAY_STAGES + j] = 0;
  return i;
}

// One point onto a slot's timeline: its sender time and its place in the
// stamp count. A full timeline lets go of the points already played.
function addPoint(i, t, p) {
  if (slotTlN[i] === TL_CAP) {
    const from = slotTlI[i] > 0 ? slotTlI[i] : 1;
    if (from === 1 && slotTlI[i] === 0) letOutTo(i, slotTlP[i][0]);   // nothing played yet: the oldest point's stamps go now
    slotTlT[i].copyWithin(0, from, TL_CAP); slotTlP[i].copyWithin(0, from, TL_CAP);
    slotTlN[i] -= from; slotTlI[i] = slotTlI[i] > from ? slotTlI[i] - from : 0;
    slotRelI[i] = slotRelI[i] > from ? slotRelI[i] - from : 0;
  }
  const n = slotTlN[i]++;
  slotTlT[i][n] = t; slotTlP[i][n] = p;
}

// The walk's emit for a remote stroke: into slot `into`, numbered.
let into = 0;
let emitN = 0;   // how many it has made since brushTake last counted
const emitRemote = (u, v, angle, copy) => {
  const i = into;
  if (slotCount[i] === SLOT_CAP) letOut(i);     // full: the oldest goes now
  if (copy === 0) slotNextK[i]++;
  const o = ((slotHead[i] + slotCount[i]) % SLOT_CAP) * PF, b = slotBuf[i];
  b[o] = u; b[o + 1] = v; b[o + 2] = angle; b[o + 3] = qSide; b[o + 4] = qMotif; b[o + 5] = qSet;
  b[o + 6] = slotNextK[i] - 1; b[o + 7] = 1;
  slotCount[i]++;
  emitN++;
};

// A replayed stroke's fades, onto the stamps its batch just made (the
// slot's last n), each by its own moment: the time its number stands at on
// the slot's timeline (read as letOutTimed reads it, from no further back
// than the batch's `pts` points and the joint before them), already this
// clock's. Faded up from 0 at the stroke's first point to full a fade up
// later, and past its real last point (the tail core/brush-replay.js
// fadeTail laid on) down from full to 0 over the fade down, the two
// multiplied where they meet on a short stroke. Brightness alone: the
// stamp's place, size and turn are as they were.
function fadeGains(i, n, pts) {
  const b = slotBuf[i], T = slotTlT[i], Q = slotTlP[i], N = slotTlN[i];
  const up = slotFadeUp[i], t0 = slotStart[i], down = slotFadeDown[i], te = slotFadeEnd[i];
  if (n > slotCount[i]) n = slotCount[i];
  if (N === 0 || n <= 0) return;
  let j = N - pts - 1 > 0 ? N - pts - 1 : 0;
  for (let c = slotCount[i] - n; c < slotCount[i]; c++) {
    const o = ((slotHead[i] + c) % SLOT_CAP) * PF, k = b[o + 6];
    while (j + 1 < N && Q[j + 1] < k) j++;
    let t;
    if (k <= Q[j]) t = T[j];
    else if (j + 1 >= N) t = T[N - 1];
    else {
      const span = Q[j + 1] - Q[j];
      t = span > 0 ? T[j] + (T[j + 1] - T[j]) * ((k - Q[j]) / span) : T[j + 1];
    }
    let g = 1;
    if (up > 0 && t - t0 < up) g = t > t0 ? (t - t0) / up : 0;
    if (down > 0 && t > te) g *= t - te < down ? 1 - (t - te) / down : 0;
    b[o + 7] = g;
  }
}

// A batch from the hall or the broadcast. from is who sent it, when the
// message itself does not say (the broadcast's strokes have one sender).
// onClock: its times are this screen's clock already (the playback's,
// core/brush-replay.js retime), so its offset is 0, known and not guessed.
export function brushTake(msg, from, onClock = false) {
  const s = decodeStroke(msg);
  if (!s || s.k !== MOTIF) return;
  // the broadcaster's own strokes reach a follower by the broadcast
  // (core/broadcast.js, its watcher gating), every phase: the room's copy,
  // marked cd, is let go here so none is drawn twice
  if (from === undefined && msg.cd === 1) return;
  const key = from !== undefined ? from : msg.id;
  const now = clock();
  let i = -1;
  for (let j = 0; j < SLOTS; j++) if (slotOn[j] && !slotDone[j] && slotKey[j] === key) { i = j; break; }
  if (s.d === 0 && i >= 0) { slotDone[i] = 1; i = -1; }   // the last one plays on beside it
  const fresh = i < 0;
  if (fresh) i = openSlot(key, now);
  const prints = !rateContinuous(s.r);
  slotPrints[i] = prints ? 1 : 0;
  // the stroke's spacing, held from its first batch here: this screen's
  // Continuity and the stroke's width as they were then, so a slider moved
  // mid-stroke (or a replayed batch drawn at another size) never shifts
  // the stamp count its timeline is laid in
  if (fresh) slotSpacing[i] = brushSpacing(s.w, S.brushContinuity);
  const spacing = slotSpacing[i];
  const p = s.points, T = s.times;
  slotFed[i] = now;
  slotTimed[i] = T ? 1 : 0;
  slotLocal[i] = onClock ? 1 : 0;
  // the playback's fades (retime's fu, fe and fd; only an onClock take
  // has them): the fade up from a stroke's first batch, the fade down from
  // its last, each on this clock
  if (onClock && T) {
    if (fresh && s.d === 0) { slotStart[i] = T[0]; slotFadeUp[i] = msg.fu > 0 ? msg.fu : 0; }
    if (s.d === 2 && msg.fd > 0 && Number.isFinite(msg.fe)) { slotFadeEnd[i] = msg.fe; slotFadeDown[i] = msg.fd; }
  }
  const fading = slotFadeUp[i] > 0 || slotFadeDown[i] > 0;
  // A continuous stroke joined mid-way has no stamp at its first point:
  // its count starts at 1, the first stamp a spacing on.
  if (fresh && !prints && s.d !== 0) slotNextK[i] = 1;
  if (T) {
    // Late? The first point this batch adds, against where play stands
    // (with the offset as it was): the delay rises by the lateness. A
    // continuous stroke's joint is never that point, its stamps being the
    // last piece's, a fresh slot's included: a hand that held still past
    // ABANDON_MS mid-stroke comes back in a new slot whose joint is as old
    // as the stillness, and counting it raised the delay by all of it,
    // for every stroke after (the archived tape's drawer 12, still 9.8 s,
    // took the replay's delay to its 2 s cap).
    const first = prints || (fresh && s.d === 0) ? 0 : 1;
    const off0 = offsets.get(key);
    if (off0 !== undefined && first < T.length) {
      const d = playDelayNow();
      playLate += ratchetDelay(d, playTime(now, off0, d), T[first]) - d;
    }
    offsets.set(key, onClock ? 0 : minOffset(off0 === undefined ? NaN : off0, now, T[T.length - 1]));
  }
  qSide = brushSide(s.w); qMotif = s.m; qSet = s.a;
  into = i;
  emitN = 0;
  if (prints) {
    // each point a print (core/brush-stamps.js), no carry; print n at n
    const k0 = slotNextK[i];
    walkBatch(p, s.d, 0, 0, s.c, emitRemote, true);
    if (T) for (let j = 0; j < p.length; j++) addPoint(i, T[j], k0 + j);
    slotEnd[i] = slotNextK[i] - 1;
  } else {
    const k0 = fresh ? slotNextK[i] - (s.d === 0 ? 0 : 1) : 0;
    slotCarry[i] = walkBatch(p, s.d, s.d === 0 ? 0 : slotCarry[i], spacing, s.c, emitRemote);
    if (T && fresh) addPoint(i, T[0], k0 + slotArc[i] / spacing);
    for (let j = 1; j < p.length; j++) {
      slotArc[i] += Math.hypot(p[j].u - p[j - 1].u, p[j].v - p[j - 1].v);
      if (T) addPoint(i, T[j], k0 + slotArc[i] / spacing);
    }
    slotEnd[i] = k0 + slotArc[i] / spacing;
  }
  if (fading && T) fadeGains(i, emitN, p.length);
  if (s.d === 2) slotDone[i] = 1;
  idleWake('a stroke');
}

// Every frame (gpu/brush.js update, before it drains the ring): each slot
// lets out what its cursor has passed. dt (seconds) moves the glide; the
// timeline reads the clock.
export function brushPlay(dt) {
  const now = clock();
  const delayNow = playDelayNow();
  // a stamp let out now was drawn a delay ago on its sender's timeline
  lastReleaseKey = releaseKey;
  releaseKey = now - delayNow;
  dealTick();
  replayTick(now);
  // a playback's stillness lasts as long as the hand's did, its speed
  // stretching it: 0.05x makes a hand's 150 ms pause 3 s here, and that is
  // no abandoned stroke
  const replayAbandon = ABANDON_MS / replaySpeedNow();
  for (let i = 0; i < SLOTS; i++) {
    if (!slotOn[i]) continue;
    const abandon = slotLocal[i] ? replayAbandon : ABANDON_MS;
    if (!slotDone[i] && now - slotFed[i] > abandon) slotDone[i] = 1;
    let cursor;
    if (slotTimed[i]) {
      const n = slotTlN[i];
      const off = offsets.get(slotKey[i]);
      const P = playTime(now, off === undefined ? now : off, delayNow);
      // done and played to its last point, or abandoned: all of it
      if (slotDone[i] && (n === 0 || P >= slotTlT[i][n - 1] || now - slotFed[i] > abandon)) cursor = Infinity;
      else {
        cursor = timelineAt(slotTlT[i], slotTlP[i], n, slotTlI[i], P, at);
        slotTlI[i] = at.i;
      }
      // never back, even when a ratchet moves play time back for every slot
      if (cursor < slotCursor[i]) cursor = slotCursor[i];
      slotCursor[i] = cursor;
      letOutTimed(i, P, cursor);
    } else {
      cursor = playStep(slotStage, i * PLAY_STAGES, slotEnd[i], dt);
      letOutTo(i, cursor);
    }
    if (slotDone[i] && slotCount[i] === 0) { slotOn[i] = 0; slotKey[i] = null; }
  }
}

// Whether any remote stroke is still playing out, or the show's playback
// runs (the still frame waits).
export function brushPlaying() {
  if (replayOn && !held) return true;
  for (let i = 0; i < SLOTS; i++) if (slotOn[i]) return true;
  return false;
}

// ---------- the show's playback ----------
// The controller's cue 24 (platform/presentation-receiver.js): the tape of
// everything the room drew since the show's first drawing cue, which the
// presentation screen keeps as it grows (platform/show-tape.js hands it in
// here), played on a loop through brushTake like any stroke from the hall
// (core/brush-replay.js plans each pass and retimes its strokes). A pass
// runs to its end and the next is planned from the tape as it stands then.
// Where the room arrived is said once each time it moves (a fresh playback,
// a tape begun again), not on every lap of the loop.
//
// The window a pass is squeezed to is the playback's own: the show's cue
// 24 fits the whole show into LOOP_MS, while the standing playback between
// shows (platform/tape-replay.js) passes Infinity, so its passes run in
// real time, the drawing exactly as it happened, with the same short rest
// between laps.
//
// The pass runs on a clock of its own (passClock, ms into the pass),
// moved on each frame by the frame's time times the playback's speed: 1
// for the show's cue 24, whose squeeze is its own law, and the Brush
// section's Replay speed (S.brushReplaySpeed, 0.05x to 2x) for the
// standing playback, read every frame, so a move of the slider changes
// the pace from where the pass stands, never jumping or starting it over.
// Each step is taken when the pass clock reaches its first new point and
// laid on this screen's clock where the pass will play it, its point gaps
// at the pass's scale over the speed.
//
// Replay size (S.brushReplaySize, 0.25x to 4x) scales the width every
// replayed batch is drawn at, cue 24's and the standing playback's alike
// (the one seam both go through, core/brush-replay.js retime), held to
// the wire's 1 to 100; a live hand's strokes and the hall's are never
// touched. It takes effect from the next batch, mid-stroke included: the
// marks grow or shrink along the line, which keeps the stroke's own
// spacing (brushTake holds each slot's spacing from its first batch).
//
// Replay fade up and Replay fade down light a replayed stroke in and out:
// its marks rise from nothing to full brightness over the fade up from its
// first point, and at its end the line carries on past its last point the
// way it was going for the fade down (core/brush-replay.js fadeTail), those
// extra marks fading out to nothing (fadeGains). Both are times of the
// drawing as the hand drew it, laid on this clock at the scale its point
// gaps are, so a fade covers the same stretch of the line at any Replay
// speed. Brightness alone, and only ever on the playback.
//
// A playback can be held (brushReplayHold: the standing page's pause, its
// Space or a tap on the field) and let go again: held, the pass clock
// stands, so on letting go the pass carries on from the very step it
// stopped at, never planned afresh. Batches already taken when the hold
// comes play out their last few moments.
const showTape = [];
let replayOn = false, pass = null, passI = 0, passClock = 0, lastTick = -1, saidSkip = -1, replayLoopMs = LOOP_MS;
let held = false;
export const REPLAY_SPEED_MIN = 0.05, REPLAY_SPEED_MAX = 2, REPLAY_SIZE_MIN = 0.25, REPLAY_SIZE_MAX = 4;
function replaySpeedNow() {
  if (replayLoopMs !== Infinity) return 1;
  const v = S.brushReplaySpeed;
  return v >= REPLAY_SPEED_MIN ? (v <= REPLAY_SPEED_MAX ? v : REPLAY_SPEED_MAX) : (v > 0 ? REPLAY_SPEED_MIN : 1);
}
function replaySizeNow() {
  const v = S.brushReplaySize;
  return v >= REPLAY_SIZE_MIN ? (v <= REPLAY_SIZE_MAX ? v : REPLAY_SIZE_MAX) : (v > 0 ? REPLAY_SIZE_MIN : 1);
}
// Replay fade up and Replay fade down (S.brushReplayFadeUp, ...FadeDown,
// seconds of the stroke's own drawing time, 0 off, up to 2), as the ms
// retime takes. Both playbacks, the standing one and cue 24's.
const REPLAY_FADE_MAX = 2;
function replayFadeMs(v) { return v > 0 ? (v < REPLAY_FADE_MAX ? v : REPLAY_FADE_MAX) * 1000 : 0; }
export function brushTapeReset() { showTape.length = 0; }
export function brushTapeAdd(entries) {
  for (const e of entries) showTape.push(e);
  if (entries.length && replayOn) idleWake('the tape');
}
export function brushTapeCount() { return showTape.length; }
export function brushReplay(on, loopMs = LOOP_MS) {
  on = !!on;
  if (on) brushDealHold(false);
  if (on && loopMs !== replayLoopMs) { replayLoopMs = loopMs; pass = null; }
  if (on === replayOn) return;
  replayOn = on;
  pass = null;
  lastTick = -1;
  saidSkip = -1;
  console.log(on ? '[drawing] playing back the room\'s drawing on a loop (' + showTape.length + ' batches so far)' : '[drawing] the playback stops');
  idleWake('the playback');
}
export function brushReplaying() { return replayOn; }
export function brushReplayHold(on) {
  on = !!on;
  if (on === held) return;
  held = on;
  // the frames while held never move the pass: it goes on from now
  lastTick = -1;
  idleWake('the playback');
}
export function brushReplayHeld() { return held; }
function replayTick(now) {
  if (!replayOn || held) return;
  // The GPU side behind: the ring holds more than it looks at in a frame
  // (BRUSH_LOOK). A replayed stamp is let out already a delay old, due the
  // frame it arrives, so every stamp the tape lets out past what the frame
  // can draw only joins a line that grows (and at QCAP loses its oldest
  // marks outright). So the pass clock stands, as a hold stands it (lastTick
  // kept at now, so nothing jumps when it runs on), and no new batch is
  // taken until the ring is back under: the tape slows to the pace this
  // screen can draw, the strokes already taken playing out their last
  // moments, and the line in front of the visitor's own hand stays a frame
  // or two long instead of seconds (Robert: "the user drawn input should be
  // high priority"). A screen that keeps up never meets it.
  if (brushQueue.count > BRUSH_LOOK) { lastTick = now; return; }
  const speed = replaySpeedNow();
  passClock += lastTick < 0 ? 0 : (now - lastTick) * speed;
  lastTick = now;
  if (!pass || (passI >= pass.steps.length && passClock >= pass.ms)) {
    pass = planPass(showTape, replayLoopMs, undefined, S.brushTrim !== false);
    passI = 0; passClock = 0;
    if (!pass.steps.length) { pass = null; return; }
    if (pass.drawers && pass.skipped !== saidSkip) {
      saidSkip = pass.skipped;
      console.log('[drawing] playback begins where the room arrives: ' + pass.drawers + ' drawers within ' + Math.round(ROOM_WINDOW_MS / 1000) + ' s, skipping the first ' + pass.skipped + ' batches' + (pass.trimmed ? ' and ending where it leaves, ' + pass.trimmed + ' batches early' : ''));
    }
  }
  const st = pass.steps, scale = pass.scale / speed, size = replaySizeNow();
  const fadeUp = replayFadeMs(S.brushReplayFadeUp), fadeDown = replayFadeMs(S.brushReplayFadeDown);
  // each batch handed over as its first new point comes due, its last
  // point laid ahead on this clock where the pass will reach it, so the
  // brush has every point before its moment and never plays catch-up
  while (passI < st.length && st[passI].takeMs <= passClock) {
    const step = st[passI++];
    brushTake(retime(step, now - (passClock - step.tMs) / speed, scale, size, fadeUp, fadeDown), undefined, true);
  }
}

// The drawer's line under the picker: where the brush is heard, rebuilt at
// most twice a second.
let statusAt = -1e9, statusStr = '';
export function brushStatusLine() {
  if (!hallLink) return '';
  const now = Date.now();
  if (now - statusAt < 500) return statusStr;
  statusAt = now;
  const st = hallState === 'joined' ? hallLink.peers.size + ' here, ' + hallLink.phase + (hallLink.conduct ? ', broadcasting' : '')
    : hallState === 'offline' ? 'offline, drawing alone' : 'joining';
  statusStr = 'Room ' + hallName + ': ' + st;
  return statusStr;
}
