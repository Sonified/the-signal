// The stroke: the one thing a touch experience says, and the wire it says
// it on (documents/touch-foundation.md). A finger down opens a stroke, each
// movement extends it, the lift closes it; the points travel in small
// batches so a partner sees the line grow under the hand, not arrive after
// it. The same draw() renders a batch whether it came from this screen or
// across the hall, so everyone sees the same mark: a stroke is deterministic
// from its messages alone.
//
// Space. Points are normalized to the unit square over a centered square of
// side min(width, height), so a mark lands in the same place on every
// screen whatever its shape, and travel as integers in 1/4096ths.
//
//   {t:'s', k, h, w, d, p:[u0,v0, u1,v1, ...]}
//
//   k   the brush, an index into BRUSHES
//   h   the hue, 0-359 (the drawer's identity rides the stroke, so a remote
//       mark needs no roster lookup to be drawn right)
//   w   the width, 1-100 (percent of WIDTH_MAX of the square's side)
//   d   0 a stroke's first batch, 1 a continuation, 2 the last
//   p   the points, interleaved, quantized to QUANT
//
// The motif brush (k = MOTIF, the fifth) stamps a kaleidoscope image tile
// rather than painting a line, and carries four more fields, all required:
//
//   a   the atlas set, an integer 1-99 (the kaleidoscope image set, as
//       S.kaleidoSet numbers it)
//   m   the motif tile, an integer 0-63 (a cell of the set's 8x8 atlas)
//   c   copies, an integer 1-24, spaced evenly around the centre
//   f   fade, a number 0-1: the sender's fade slider, so a receiver can
//       fade remote marks the way the sender's own fade
//
// The real motif rendering lives in the main app (WebGPU); drawStroke here
// paints a simple stand-in so /touch/ draws something sensible when one
// arrives.
//
// The hall stamps `id` on relayed copies; the drawing never needs it, the
// page may (a cursor, a credit).

export const QUANT = 4096;
export const WIDTH_MAX = 0.06;   // w:100 is this share of the square's side

// Appended only, never reordered: k is an index on the wire and the tape.
export const BRUSHES = [
  { id: 'ink',    label: 'Ink' },      // a plain round line
  { id: 'ribbon', label: 'Ribbon' },   // width breathes with speed
  { id: 'orbs',   label: 'Orbs' },     // beads along the path
  { id: 'spark',  label: 'Spark' },    // short rays off each point
  { id: 'motif',  label: 'Motif' }     // an atlas tile, in radial copies (a, m, c, f)
];
export const MOTIF = 4;

// ---------- the wire ----------

// extras: the motif brush's { a, m, c, f }; copied onto the message as
// given (only those four), so decodeStroke is the one judge of them.
export function encodeStroke(k, h, w, d, points, extras) {
  const p = new Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    p[2 * i] = Math.max(0, Math.min(QUANT, Math.round(points[i].u * QUANT)));
    p[2 * i + 1] = Math.max(0, Math.min(QUANT, Math.round(points[i].v * QUANT)));
  }
  const msg = { t: 's', k, h, w, d, p };
  if (extras) {
    for (const f of ['a', 'm', 'c', 'f']) if (extras[f] !== undefined) msg[f] = extras[f];
  }
  return msg;
}

const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

// null for anything malformed: a hall relays whatever a member said. A
// motif stroke must carry a, m, c and f in range; any other brush decodes
// exactly as before, ignoring them.
export function decodeStroke(msg) {
  if (!msg || msg.t !== 's' || !Array.isArray(msg.p) || msg.p.length < 2 || msg.p.length % 2) return null;
  const k = msg.k | 0, h = msg.h | 0, w = msg.w | 0, d = msg.d | 0;
  if (k < 0 || k >= BRUSHES.length || h < 0 || h > 359 || w < 1 || w > 100 || d < 0 || d > 2) return null;
  const points = new Array(msg.p.length / 2);
  for (let i = 0; i < points.length; i++) {
    const u = msg.p[2 * i] / QUANT, v = msg.p[2 * i + 1] / QUANT;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
    points[i] = { u, v };
  }
  if (k !== MOTIF) return { k, h, w, d, points };
  const { a, m, c, f } = msg;
  if (!intIn(a, 1, 99) || !intIn(m, 0, 63) || !intIn(c, 1, 24) ||
      typeof f !== 'number' || !(f >= 0 && f <= 1)) return null;
  return { k, h, w, d, points, a, m, c, f };
}

// ---------- the brushes ----------
// Each takes canvas-space points (px) and paints one batch. A batch's first
// point is the previous batch's last, repeated by the sender, so lines join
// without the brush keeping state.

function ink(ctx, pts, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  ctx.stroke();
}

function ribbon(ctx, pts, color, width) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    const speed = Math.min(1, Math.hypot(dx, dy) / (width * 4));
    ctx.lineWidth = Math.max(1, width * (1.25 - speed));
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
}

function orbs(ctx, pts, color, width) {
  ctx.fillStyle = color;
  for (let i = 0; i < pts.length; i++) {
    const r = width * (0.35 + 0.3 * Math.abs(Math.sin(pts[i].x * 0.05 + pts[i].y * 0.037)));
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function spark(ctx, pts, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, width * 0.18);
  ctx.lineCap = 'round';
  for (let i = 0; i < pts.length; i++) {
    const a0 = pts[i].x * 0.071 + pts[i].y * 0.053;   // settled by position, same on every screen
    for (let r = 0; r < 3; r++) {
      const a = a0 + r * (Math.PI * 2 / 3);
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i].x + Math.cos(a) * width, pts[i].y + Math.sin(a) * width);
      ctx.stroke();
    }
  }
}

// The motif's Canvas2D stand-in: a small ring at each point. The tile and
// its radial copies are the main app's to draw; the scene's own
// kaleidoscope already repeats the ring around the centre here.
function motif(ctx, pts, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, width * 0.2);
  for (let i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, width * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

const PAINTERS = [ink, ribbon, orbs, spark, motif];

// Paints one decoded batch into a 2d context whose space is canvas pixels.
// `map` turns a unit point into canvas px (scene.mapper); alpha is the
// stroke's own, under whatever the scene composes around it.
export function drawStroke(ctx, stroke, map, side) {
  const pts = stroke.points.map(map);
  const width = Math.max(1, stroke.w / 100 * WIDTH_MAX * side);
  const color = `hsl(${stroke.h} 90% 62%)`;
  ctx.globalAlpha = 0.9;
  PAINTERS[stroke.k](ctx, pts, color, width);
  ctx.globalAlpha = 1;
}
