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
// The hall stamps `id` on relayed copies; the drawing never needs it, the
// page may (a cursor, a credit).

export const QUANT = 4096;
export const WIDTH_MAX = 0.06;   // w:100 is this share of the square's side

export const BRUSHES = [
  { id: 'ink',    label: 'Ink' },      // a plain round line
  { id: 'ribbon', label: 'Ribbon' },   // width breathes with speed
  { id: 'orbs',   label: 'Orbs' },     // beads along the path
  { id: 'spark',  label: 'Spark' }     // short rays off each point
];

// ---------- the wire ----------

export function encodeStroke(k, h, w, d, points) {
  const p = new Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    p[2 * i] = Math.max(0, Math.min(QUANT, Math.round(points[i].u * QUANT)));
    p[2 * i + 1] = Math.max(0, Math.min(QUANT, Math.round(points[i].v * QUANT)));
  }
  return { t: 's', k, h, w, d, p };
}

// null for anything malformed: a hall relays whatever a member said.
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
  return { k, h, w, d, points };
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

const PAINTERS = [ink, ribbon, orbs, spark];

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
