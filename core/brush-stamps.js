// The brush's one law: from a stroke to the stamps it leaves, pure, so the
// mark drawn here and the same stroke arriving from across the hall
// (touch/strokes.js, the motif brush) come out as the same figure on every
// screen. Nothing here knows about pixels, the GPU or the wire's transport;
// gpu/brush.js maps the stamps onto the field and core/brush.js feeds them.
//
// Space is the wire's: the unit square over the centred square of side
// min(width, height) of the visible field (the drawer's inset taken off its
// left), u across and v down, so (0.5, 0.5) is the field's centre and the
// copies turn about it.
//
// A stamp lands every spacing along the path, measured as arc length from
// the stroke's first point, so where the stamps fall depends only on the
// polyline, never on how it was cut up: the hand's frame by frame segments
// here and the sender's 30 ms batches over there walk the very same line
// through the same arithmetic, carrying the distance since the last stamp
// (the carry) from one piece to the next. The stroke's first batch (d 0)
// stamps its first point and starts the carry at 0; a continuation starts
// from the carry the last piece left, its first point being that piece's
// last (the joint the sender repeats), which adds no length.
//
// That is the brush at its Rate's top, Frame rate: continuous, a stamp
// every SPACING_SHARE of the motif's side, so close that a drag reads as
// one gapless ribbon of the motif carried along the hand, however far the
// pointer jumped between two samples. Below the top the brush prints: the
// sender drops a print where the hand is, at most printsPerSecond(r) times
// a second, and those prints are the stroke's points on the wire (its r
// under 1 says so, touch/strokes.js), so a receiver stamps each point as it
// stands, with no fill and no carry. Time picks the prints, on the sender
// alone; the points themselves are the figure, the same on every screen.
//
// Each stamp is repeated copies times around the centre, copy i turned by
// 2 pi i / copies, the sprite turned with it, so the figure has exactly that
// rotational symmetry and nothing pulls the eye to one side (the open focus
// ethos). Copy 0 is the hand's own stamp, upright as the tile is drawn.
// Angles are radians, positive clockwise on screen (v grows downward).

const TAU = Math.PI * 2;

// The motif's side at the wire's w = 100, as a share of the square's side.
// The Size slider's default is BRUSH_W, a motif an eighth of the field
// across; a stroke carries its w and a receiver draws whatever it says.
export const SIDE_MAX = 0.24;
export const BRUSH_W = 50;
// The Rotation slider's top, turns a second: the whole trail turns about
// the field's centre at up to this (gpu/brush.js), 0 is still.
export const ROTATE_MAX = 4;
// Stamps every this share of the motif's side, continuous: a twentieth, so
// neighbours overlap by 95% and no edge between them can be told apart
// (5 px apart for a 110 px motif on a laptop's field), a smooth ribbon. A
// fast flick across the whole field is then about 170 stamps a copy, which
// the layer takes at up to 4096 a frame (gpu/brush.js MAX_INST), carrying
// the rest to the next.
export const SPACING_SHARE = 0.05;

// The Rate slider (0 to 1, the wire's r): 1 is Frame rate, continuous;
// below it prints per second, PRINTS_MAX just under the top (0.99) down
// to PRINTS_MIN at the bottom, evenly in the logarithm, so the travel from
// 8 a second up to 60 is as long as from 1 to 8. Absent is continuous, so
// every stroke from before r draws as it always did.
//
// The mapping changed on 2026-10-23, the top of the prints raised from 8 a
// second to 60 (8 then sat a step under Frame rate, which runs at the
// display's 60 or more, a leap): r keeps its 0 to 1 and its one meaning on
// the wire, continuous at 1 and prints below, which is all a receiver reads
// (the sender alone times its prints), so no stroke or tape entry changes
// meaning; a hand's own saved Rate under the top now prints faster than it
// did (0.5 was 2.8 a second, is 7.9).
export const PRINTS_MIN = 1, PRINTS_MAX = 60;
export function rateContinuous(r) { return !(r < 1); }
export function printsPerSecond(r) {
  const x = r > 0 ? (r < 0.99 ? r / 0.99 : 1) : 0;
  return PRINTS_MIN * Math.pow(PRINTS_MAX / PRINTS_MIN, x);
}
// The readout: 'Frame rate' at the top, else '60 /s' ... '1 /s'.
export function rateLabel(r) {
  if (rateContinuous(r)) return 'Frame rate';
  const p = printsPerSecond(r);
  return (p < 9.95 ? Math.round(p * 10) / 10 : Math.round(p)) + ' /s';
}

// The motif's side in unit-square units for a stroke's w (1 to 100).
export function brushSide(w) {
  const k = w > 1 ? (w < 100 ? w : 100) : 1;
  return k / 100 * SIDE_MAX;
}
// The spacing of a stroke of width w: SPACING_SHARE of its side, over the
// screen's Continuity (density, 1 to CONTINUITY_MAX; the Brush section's
// slider): 1 is the law as it stood, 10 ten stamps where it laid one. It
// is each screen's own, never on the wire and never the room's, so one
// stroke is the same line everywhere, more or less densely filled; the
// hand's own walk, the hall's strokes and the playback's all take it.
export const CONTINUITY_MAX = 10;
export function brushSpacing(w, density = 1) {
  const k = density > 1 ? (density < CONTINUITY_MAX ? density : CONTINUITY_MAX) : 1;
  return brushSide(w) * SPACING_SHARE / k;
}

// The Fade slider (0 to 1, the wire's f) as how long a mark takes to fade
// away, 1 s at the bottom to a minute at the top, evenly in the logarithm
// so each step of the slider feels alike. FADE_HALVINGS half-lives make the
// fade (a mark is down to a thirty-second of itself by then, gone to the
// eye over the dark field), so the feedback's half-life is that time over
// FADE_HALVINGS.
export const FADE_MIN_S = 1, FADE_MAX_S = 60;
export const FADE_HALVINGS = 5;
export function fadeSeconds(f) {
  const x = f > 0 ? (f < 1 ? f : 1) : 0;
  return FADE_MIN_S * Math.pow(FADE_MAX_S / FADE_MIN_S, x);
}
export function fadeHalfLife(f) {
  return fadeSeconds(f) / FADE_HALVINGS;
}
// The readout, in plain time: '1 s', '2.4 s', '15 s', '1 min'.
export function fadeLabel(f) {
  const s = fadeSeconds(f);
  if (s >= 59.5) return '1 min';
  if (s < 9.95) return (Math.round(s * 10) / 10) + ' s';
  return Math.round(s) + ' s';
}
// Typed seconds (or minutes, 'min' or 'm' after the number) back to the
// slider's 0..1, NaN when it does not read.
export function fadeFromText(text) {
  const n = parseFloat(text);
  if (!(n > 0)) return NaN;
  const s = /m/i.test(text) ? n * 60 : n;
  const x = Math.log(s / FADE_MIN_S) / Math.log(FADE_MAX_S / FADE_MIN_S);
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// The visible field's square in CSS px: its centre and side, from the
// canvas's size and the drawer's inset, written into out ({cx, cy, side}).
// The same geometry the GPU side maps stamps through, in device px.
export function fieldSquare(width, height, inset, out) {
  const ins = inset > 0 ? inset : 0;
  const visW = Math.max(1, width - ins);
  out.cx = ins + visW * 0.5;
  out.cy = height * 0.5;
  out.side = Math.max(1, Math.min(visW, height));
  return out;
}

// One stamp and its copies: emit(u, v, angle, copy) for each, copy 0 first.
export function stampCopies(u, v, copies, emit) {
  const n = copies > 1 ? copies | 0 : 1;
  const du = u - 0.5, dv = v - 0.5;
  emit(u, v, 0, 0);
  for (let i = 1; i < n; i++) {
    const a = TAU * i / n, c = Math.cos(a), s = Math.sin(a);
    emit(0.5 + c * du - s * dv, 0.5 + s * du + c * dv, a, i);
  }
}

// Walks one segment from (u0, v0) to (u1, v1), stamping (with copies) every
// spacing of path. carry is the length walked since the last stamp; the new
// carry comes back. A zero-length segment changes nothing.
export function walkSegment(u0, v0, u1, v1, carry, spacing, copies, emit) {
  const du = u1 - u0, dv = v1 - v0;
  const len = Math.sqrt(du * du + dv * dv);
  if (!(len > 0) || !(spacing > 0)) return carry;
  let at = spacing - carry;           // distance along this segment of the next stamp
  while (at <= len) {
    const k = at / len;
    stampCopies(u0 + du * k, v0 + dv * k, copies, emit);
    at += spacing;
  }
  return len - (at - spacing);
}

// A decoded batch's points ({u, v} each, as touch/strokes.js decodeStroke
// gives them), d its place in the stroke, carry what the stroke's last
// piece left (anything for a first batch). Returns the carry for the next.
// prints (a stroke with r under 1): every point is a print, stamped as it
// stands, and there is no carry.
export function walkBatch(points, d, carry, spacing, copies, emit, prints) {
  if (prints) {
    if (points) for (let i = 0; i < points.length; i++) stampCopies(points[i].u, points[i].v, copies, emit);
    return 0;
  }
  let c = carry > 0 ? carry : 0;
  if (!points || !points.length) return c;
  if (d === 0) {
    stampCopies(points[0].u, points[0].v, copies, emit);
    c = 0;
  }
  for (let i = 1; i < points.length; i++) {
    c = walkSegment(points[i - 1].u, points[i - 1].v, points[i].u, points[i].v, c, spacing, copies, emit);
  }
  return c;
}

// A decoded motif stroke batch to its list of stamps, for the tests and any
// caller happy to allocate: { stamps: [{u, v, angle, copy}], carry }.
export function stampsFor(stroke, carry) {
  const stamps = [];
  const out = walkBatch(stroke.points, stroke.d, carry, brushSpacing(stroke.w), stroke.c,
    (u, v, angle, copy) => { stamps.push({ u, v, angle, copy }); }, !rateContinuous(stroke.r));
  return { stamps, carry: out };
}
