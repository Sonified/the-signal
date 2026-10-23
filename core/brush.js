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
// atlas set, the sender's id for core/brush-order.js) until gpu/brush.js
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
import { dealHand } from '../broadcast-worker/src/deal.js';
import { seedOf, notesFor, nextBand } from './brush-notes.js';
import { SOLO_ID, BROADCAST_ID } from './brush-order.js';
import { playStep, PLAY_STAGES, DELAY0_MS, minOffset, playTime, ratchetDelay, timelineAt } from './brush-playback.js';
import { createTapDrag, tapDragStep, TD_START, TD_MOVE, TD_TAP, TD_END, TD_CANCEL } from './tap-drag.js';
import { BRUSH_W, brushSide, brushSpacing, stampCopies, walkSegment, walkBatch, fieldSquare, rateContinuous, printsPerSecond } from './brush-stamps.js';

// The wire's pace: a batch at least every flushMs() while the hand moves
// (the room's Stream when the hall has told one, else FLUSH_MS), and never
// more than FLUSH_POINTS points in one (touch/main.js's numbers). Each point
// goes with the frame's clock when it was made (the wire's q), so a
// receiver plays the stroke on this hand's own timeline.
const FLUSH_MS = 20, FLUSH_POINTS = 16;
function flushMs() { return hallLink && hallLink.stream > 0 ? hallLink.stream : FLUSH_MS; }
// The hue the stroke carries on the wire (its h): this screen's identity,
// one of /touch/'s, for the stand-in it draws there. The motif itself keeps
// its own colours.
const HUES = [8, 42, 95, 168, 212, 285, 330];
const HUE = HUES[Math.floor(Math.random() * HUES.length)];

// ---------- the ring ----------
export const STAMP_FLOATS = 7;
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

// What the walk's stamps are made of right now (set before each walk).
let qSide = 0, qMotif = 0, qSet = 1, qWho = SOLO_ID, qKey = 0, qSeqN = 0;
function push(u, v, angle) {
  const q = brushQueue;
  if (q.count === q.cap) { q.head = (q.head + 1) % q.cap; q.count--; }
  const at = (q.head + q.count) % q.cap, o = at * STAMP_FLOATS, b = q.buf;
  b[o] = u; b[o + 1] = v; b[o + 2] = angle; b[o + 3] = qSide; b[o + 4] = qMotif; b[o + 5] = qSet;
  b[o + 6] = qWho;
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
  sRate = S.brushRate >= 0 && S.brushRate <= 1 ? S.brushRate : 1;
  sPrints = !rateContinuous(sRate);
  printMs = 1000 / printsPerSecond(sRate);
  lastPrintT = t;
  toUnit(x, y, width, height, inset);
  lastQu = lastU; lastQv = lastV;
  qSide = brushSide(BRUSH_W); qMotif = sMotif; qSet = sSet; qWho = handId(); qKey = t;
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
      qSide = brushSide(BRUSH_W); qMotif = sMotif; qSet = sSet; qWho = handId(); qKey = t;
      stampCopies(lastU / QUANT, lastV / QUANT, sCopies, emit);
      lastQu = lastU; lastQv = lastV;
      handBand = ringBand(handBand, lastQv / QUANT, bellId());
      if (pendN < PEND_MAX) { pend[pendN * 2] = lastU; pend[pendN * 2 + 1] = lastV; pendT[pendN] = t; pendN++; }
    }
    if (pendN > 0 && (pendN >= FLUSH_POINTS || t - lastFlushT >= flushMs())) flush(false, t);
    return;
  }
  if (lastU !== lastQu || lastV !== lastQv) {
    qSide = brushSide(BRUSH_W); qMotif = sMotif; qSet = sSet; qWho = handId(); qKey = t;
    carry = walkSegment(lastQu / QUANT, lastQv / QUANT, lastU / QUANT, lastV / QUANT, carry, brushSpacing(BRUSH_W), sCopies, emit);
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
    const msg = encodeStroke(MOTIF, HUE, BRUSH_W, done ? 2 : pendD, pts,
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
// Each hand rings its bell when its stroke enters a band of the field
// (core/brush-notes.js): the hand's own the moment it draws, a remote one as
// its stroke plays out here, so every screen rings what it draws. The
// bell itself is js/brush-bells.js, handed in (main.js) as bellHook(seed,
// degree), on the page or across the audio link. Each identity's seed and
// notes are worked out once.
let bellHook = null, handBand = -1;
export function setBrushBell(fn) { bellHook = fn || null; }
const voices = new Map();   // identity -> { seed, notes }
function ringBand(cur, v, who) {
  if (!bellHook || S.brushNotes !== true || !started) return cur < 0 ? -1 : cur;
  const nb = nextBand(cur, v);
  if (nb !== cur) {
    let vc = voices.get(who);
    if (!vc) {
      if (voices.size > 256) voices.clear();
      const seed = seedOf(who);
      vc = { seed, notes: notesFor(seed) };
      voices.set(who, vc);
    }
    bellHook(vc.seed, vc.notes[nb]);
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
// The hand's own id among the senders (core/brush-order.js): its hall id
// once joined, else the solo one.
function handId() { return hallLink && hallLink.you ? hallLink.you : SOLO_ID; }
// The broadcast's end (core/broadcast.js, on the broadcasting tab only):
// { wanted() whether anyone watches, send(msg) to every watched session,
// touch() wake a dozing one }, or null.
let bcSink = null;
export function setBrushBroadcast(sink) { bcSink = sink || null; }
export function brushHallState(s) {
  hallState = s; statusAt = -1e9;
  // a fresh join: the conductor says its room settings and deal again
  if (s === 'joined') { roomSent = -1; dealSent = -1; }
  idleWake('the hall');
}
export function brushHallGroup() { statusAt = -1e9; idleWake('the hall'); }

// ---------- the room's settings and the dealt brushes ----------
// The conductor's Brush rows (core/schema-brush.js) are the room's: Stream
// and Smoothing go to the hall as {t:'room', ms, sm}, and the dealt brushes
// as {t:'brushes', on, n, a, tiles}, the tiles the current Image set's
// painted ones in sheet order (brushAtlas, so the hall deals only shapes
// that draw; broadcast-worker/src/deal.js). dealTick, every frame, sends
// either one again whenever the conductor's own settings and what was last
// sent part (a slider moved, a reconnect, the hall's wipe telling the deal
// off), waiting for the set's atlas when it must.
let roomSent = -1, dealSent = -1;
function dealTick() {
  if (!brushConducting()) return;
  const ms = S.brushStream | 0, sm = S.brushSmooth | 0;
  const room = ms * 1000 + sm;
  if (room !== roomSent && ms >= 10 && ms <= 60 && sm >= 0 && sm <= 200) {
    roomSent = room;
    hallLink.send({ t: 'room', ms, sm });
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
export function brushHallHand(h) {
  // the deal stopped or changed: a pick from the old hand goes back to the
  // atlas picker's tile
  if (!h || !h.tiles.includes(S.brushMotif | 0) || h.a !== handSet) handSet = 0;
  // the room told the deal off while the broadcaster has it on: say it again
  if (!h && brushConducting() && S.brushDeal === true) dealSent = -1;
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
  if (brushConducting()) hallLink.setPhase(p, r);
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
const SLOTS = 16, SLOT_CAP = 8192, PF = 7;    // per stamp: u v angle side motif set k
const TL_CAP = 2048;                          // timeline points held per slot
const ABANDON_MS = 3000;
const slotBuf = new Array(SLOTS).fill(null);  // each a Float32Array, made on first use
const slotTlT = new Array(SLOTS).fill(null), slotTlP = new Array(SLOTS).fill(null);
const slotKey = new Array(SLOTS).fill(null);
const slotOn = new Uint8Array(SLOTS), slotDone = new Uint8Array(SLOTS), slotTimed = new Uint8Array(SLOTS);
const slotHead = new Int32Array(SLOTS), slotCount = new Int32Array(SLOTS), slotNextK = new Int32Array(SLOTS);
const slotTlN = new Int32Array(SLOTS), slotTlI = new Int32Array(SLOTS);
const slotEnd = new Float64Array(SLOTS), slotArc = new Float64Array(SLOTS), slotCarry = new Float64Array(SLOTS);
const slotFed = new Float64Array(SLOTS), slotCursor = new Float64Array(SLOTS);
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
// The time a stamp let out of a slot carries (see brushPlay).
let releaseKey = 0;
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
  push(b[o], b[o + 1], b[o + 2]);
  slotHead[i] = (slotHead[i] + 1) % SLOT_CAP;
  slotCount[i]--;
}
function letOutTo(i, cursor) {
  const b = slotBuf[i];
  while (slotCount[i] > 0 && b[slotHead[i] * PF + 6] <= cursor + 1e-9) letOut(i);
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
  slotHead[i] = 0; slotCount[i] = 0; slotNextK[i] = 0; slotTlN[i] = 0; slotTlI[i] = 0;
  slotEnd[i] = 0; slotArc[i] = 0; slotCarry[i] = 0; slotFed[i] = now; slotCursor[i] = -1;
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
  }
  const n = slotTlN[i]++;
  slotTlT[i][n] = t; slotTlP[i][n] = p;
}

// The walk's emit for a remote stroke: into slot `into`, numbered.
let into = 0;
const emitRemote = (u, v, angle, copy) => {
  const i = into;
  if (slotCount[i] === SLOT_CAP) letOut(i);     // full: the oldest goes now
  if (copy === 0) slotNextK[i]++;
  const o = ((slotHead[i] + slotCount[i]) % SLOT_CAP) * PF, b = slotBuf[i];
  b[o] = u; b[o + 1] = v; b[o + 2] = angle; b[o + 3] = qSide; b[o + 4] = qMotif; b[o + 5] = qSet;
  b[o + 6] = slotNextK[i] - 1;
  slotCount[i]++;
};

// A batch from the hall or the broadcast. from is who sent it, when the
// message itself does not say (the broadcast's strokes have one sender).
export function brushTake(msg, from) {
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
  const spacing = brushSpacing(s.w);
  const p = s.points, T = s.times;
  slotFed[i] = now;
  slotTimed[i] = T ? 1 : 0;
  // A continuous stroke joined mid-way has no stamp at its first point:
  // its count starts at 1, the first stamp a spacing on.
  if (fresh && !prints && s.d !== 0) slotNextK[i] = 1;
  if (T) {
    // Late? The first point this batch adds, against where play stands
    // (with the offset as it was): the delay rises by the lateness.
    const first = fresh || prints ? 0 : 1;
    const off0 = offsets.get(key);
    if (off0 !== undefined && first < T.length) {
      const d = playDelayNow();
      playLate += ratchetDelay(d, playTime(now, off0, d), T[first]) - d;
    }
    offsets.set(key, minOffset(off0 === undefined ? NaN : off0, now, T[T.length - 1]));
  }
  qSide = brushSide(s.w); qMotif = s.m; qSet = s.a;
  into = i;
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
  releaseKey = now - delayNow;
  dealTick();
  for (let i = 0; i < SLOTS; i++) {
    if (!slotOn[i]) continue;
    if (!slotDone[i] && now - slotFed[i] > ABANDON_MS) slotDone[i] = 1;
    let cursor;
    if (slotTimed[i]) {
      const n = slotTlN[i];
      const off = offsets.get(slotKey[i]);
      const P = playTime(now, off === undefined ? now : off, delayNow);
      // done and played to its last point, or abandoned: all of it
      if (slotDone[i] && (n === 0 || P >= slotTlT[i][n - 1] || now - slotFed[i] > ABANDON_MS)) cursor = Infinity;
      else {
        cursor = timelineAt(slotTlT[i], slotTlP[i], n, slotTlI[i], P, at);
        slotTlI[i] = at.i;
      }
      // never back, even when a ratchet moves play time back for every slot
      if (cursor < slotCursor[i]) cursor = slotCursor[i];
      slotCursor[i] = cursor;
    } else {
      cursor = playStep(slotStage, i * PLAY_STAGES, slotEnd[i], dt);
    }
    letOutTo(i, cursor);
    if (slotDone[i] && slotCount[i] === 0) { slotOn[i] = 0; slotKey[i] = null; }
  }
}

// Whether any remote stroke is still playing out (the still frame waits).
export function brushPlaying() {
  for (let i = 0; i < SLOTS; i++) if (slotOn[i]) return true;
  return false;
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
