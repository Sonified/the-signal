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
// atlas set) until gpu/brush.js takes them, in order, which it does as soon
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
import { MOTIF, QUANT, encodeStroke, decodeStroke } from '../touch/strokes.js';
import { createTapDrag, tapDragStep, TD_START, TD_MOVE, TD_TAP, TD_END, TD_CANCEL } from './tap-drag.js';
import { BRUSH_W, brushSide, brushSpacing, stampCopies, walkSegment, walkBatch, fieldSquare, rateContinuous, printsPerSecond } from './brush-stamps.js';

// The wire's pace: a batch at least this often while the hand moves, and
// never more than this many points in one (touch/main.js's numbers).
const FLUSH_MS = 45, FLUSH_POINTS = 16;
// The hue the stroke carries on the wire (its h): this screen's identity,
// one of /touch/'s, for the stand-in it draws there. The motif itself keeps
// its own colours.
const HUES = [8, 42, 95, 168, 212, 285, 330];
const HUE = HUES[Math.floor(Math.random() * HUES.length)];

// ---------- the ring ----------
export const STAMP_FLOATS = 6;
// Room for a few frames of the densest drawing (a fast flick at the
// continuous spacing with 24 copies is some 4000 stamps a frame).
const QCAP = 65536;
export const brushQueue = { buf: new Float32Array(QCAP * STAMP_FLOATS), cap: QCAP, head: 0, count: 0 };

// What the walk's stamps are made of right now (set before each walk).
let qSide = 0, qMotif = 0, qSet = 1;
function push(u, v, angle) {
  const q = brushQueue;
  if (q.count === q.cap) { q.head = (q.head + 1) % q.cap; q.count--; }
  const o = ((q.head + q.count) % q.cap) * STAMP_FLOATS, b = q.buf;
  b[o] = u; b[o + 1] = v; b[o + 2] = angle; b[o + 3] = qSide; b[o + 4] = qMotif; b[o + 5] = qSet;
  q.count++;
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

// ---------- the hand ----------
const sq = { cx: 0, cy: 0, side: 1 };
const gesture = createTapDrag();
let pressing = false;
// The stroke's last point, quantized as the wire carries it, and the walk's
// carry; its settings, held for the whole stroke.
let lastQu = 0, lastQv = 0, carry = 0;
let sCopies = 1, sMotif = 0, sSet = 1, sFade = 0.5;
// The Rate, held for the stroke: continuous, or prints every printMs (the
// last at lastPrintT), each print one point on the wire (core/brush-stamps.js).
let sRate = 1, sPrints = false, printMs = 1000, lastPrintT = 0;
// The batch waiting to go out: quantized points, the first the joint.
const PEND_MAX = 64;
const pend = new Int32Array(PEND_MAX * 2);
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
  sMotif = brushMotifNow();
  sSet = kaleidoscopeSet(S.kaleidoSet).id;
  sFade = S.brushFade >= 0 && S.brushFade <= 1 ? S.brushFade : 0.5;
  sRate = S.brushRate >= 0 && S.brushRate <= 1 ? S.brushRate : 1;
  sPrints = !rateContinuous(sRate);
  printMs = 1000 / printsPerSecond(sRate);
  lastPrintT = t;
  toUnit(x, y, width, height, inset);
  lastQu = lastU; lastQv = lastV;
  qSide = brushSide(BRUSH_W); qMotif = sMotif; qSet = sSet;
  stampCopies(lastQu / QUANT, lastQv / QUANT, sCopies, emit);
  carry = 0;
  pend[0] = lastQu; pend[1] = lastQv; pendN = 1; pendD = 0; lastFlushT = t;
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
      qSide = brushSide(BRUSH_W); qMotif = sMotif; qSet = sSet;
      stampCopies(lastU / QUANT, lastV / QUANT, sCopies, emit);
      lastQu = lastU; lastQv = lastV;
      if (pendN < PEND_MAX) { pend[pendN * 2] = lastU; pend[pendN * 2 + 1] = lastV; pendN++; }
    }
    if (pendN > 0 && (pendN >= FLUSH_POINTS || t - lastFlushT >= FLUSH_MS)) flush(false, t);
    return;
  }
  if (lastU !== lastQu || lastV !== lastQv) {
    qSide = brushSide(BRUSH_W); qMotif = sMotif; qSet = sSet;
    carry = walkSegment(lastQu / QUANT, lastQv / QUANT, lastU / QUANT, lastV / QUANT, carry, brushSpacing(BRUSH_W), sCopies, emit);
    lastQu = lastU; lastQv = lastV;
    if (pendN < PEND_MAX) { pend[pendN * 2] = lastU; pend[pendN * 2 + 1] = lastV; pendN++; }
  }
  if (pendN >= FLUSH_POINTS || (t - lastFlushT >= FLUSH_MS && (pendN > 1 || pendD === 0))) flush(false, t);
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
    const pts = new Array(pendN);
    for (let i = 0; i < pendN; i++) pts[i] = { u: pend[i * 2] / QUANT, v: pend[i * 2 + 1] / QUANT };
    const msg = encodeStroke(MOTIF, HUE, BRUSH_W, done ? 2 : pendD, pts,
      { a: sSet, m: sMotif, c: sCopies, f: Math.round(sFade * 1000) / 1000, r: sRate });
    if (hallLink) hallLink.send(msg);
    if (toBc) bcSink.send(msg);
  }
  pendD = 1;
  if (sPrints) { pendN = 0; return; }
  pend[0] = lastQu; pend[1] = lastQv; pendN = 1;
}

// ---------- the hall ----------
// The link (touch/hall.js createHall, opened by platform/brush-hall.js) or
// null for a solo instrument; its state and group as last told, for the
// drawer's status line.
let hallLink = null, hallName = '', hallState = '';
export function setBrushHall(link, name) { hallLink = link; hallName = name || ''; }
// The broadcast's end (core/broadcast.js, on the broadcasting tab only):
// { wanted() whether anyone watches, send(msg) to every watched session,
// touch() wake a dozing one }, or null.
let bcSink = null;
export function setBrushBroadcast(sink) { bcSink = sink || null; }
export function brushHallState(s) { hallState = s; statusAt = -1e9; idleWake('the hall'); }
export function brushHallGroup() { statusAt = -1e9; }

// The conductor's phase row (core/schema-brush.js): shown only while this
// page is joined as the hall's conductor, lit from the phase the hall last
// told (its hello and every group message, touch/hall.js), so it shows the
// server's truth, follows a phase moved from /touch/, and comes back right
// after a reconnect. A click only asks; the hall's answer is what lights.
export function brushConducting() { return !!hallLink && hallState === 'joined' && hallLink.conduct === true; }
export function brushPhase() { return hallLink ? hallLink.phase : 'solo'; }
export function brushSetPhase(p) { if (brushConducting()) hallLink.setPhase(p); }

// Each sender's stroke in flight: the carry its last batch left, by the id
// the hall stamps. A first batch starts afresh, a last one lets go.
// from is who sent it, when the message itself does not say (the
// broadcast's strokes have one sender, the broadcaster).
const carries = new Map();
export function brushTake(msg, from) {
  const s = decodeStroke(msg);
  if (!s || s.k !== MOTIF) return;
  const key = from !== undefined ? from : msg.id;
  qSide = brushSide(s.w); qMotif = s.m; qSet = s.a;
  // prints: each point as it stands, no carry kept (core/brush-stamps.js)
  if (!rateContinuous(s.r)) {
    walkBatch(s.points, s.d, 0, 0, s.c, emit, true);
    idleWake('a stroke');
    return;
  }
  const c0 = s.d === 0 ? 0 : (carries.get(key) || 0);
  const c1 = walkBatch(s.points, s.d, c0, brushSpacing(s.w), s.c, emit);
  if (s.d === 2) carries.delete(key);
  else {
    if (carries.size > 256 && !carries.has(key)) carries.clear();
    carries.set(key, c1);
  }
  idleWake('a stroke');
}

// The drawer's line under the picker: where the brush is heard, rebuilt at
// most twice a second.
let statusAt = -1e9, statusStr = '';
export function brushStatusLine() {
  if (!hallLink) return '';
  const now = Date.now();
  if (now - statusAt < 500) return statusStr;
  statusAt = now;
  const st = hallState === 'joined' ? hallLink.peers.size + ' here, ' + hallLink.phase + (hallLink.conduct ? ', conducting' : '')
    : hallState === 'offline' ? 'offline, drawing alone' : 'joining';
  statusStr = 'Hall ' + hallName + ': ' + st;
  return statusStr;
}
