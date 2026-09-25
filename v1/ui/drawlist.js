// The DrawList: the only thing the UI hands to the GPU.
//
// Everything the viewer sees outside the scene is one of four shapes, and each
// shape is one fixed-size instance record in a single Float32Array. The UI
// renderer uploads that array once per frame and draws it with one instanced
// call per clip batch. Nothing here allocates while a frame is being built:
// the array grows by doubling on the rare frame that outruns it, and the clip
// batches are pooled objects reused from frame to frame. Every writer takes
// positional arguments and colour arrays that already exist (theme constants
// or the toolkit's scratch colours), because an options object per widget per
// frame is exactly the garbage that turns into a dropped strobe frame.
//
// Coordinates are CSS pixels from the top left. Colours are straight-alpha
// sRGB in 0..1, the same numbers a CSS colour would have. The renderer does
// the premultiply and the device-pixel scale.

export const KIND = { RECT: 0, GLASS: 1, GLYPH: 2, ICON: 3 };

// Icons are drawn analytically in the shader, so adding one means adding a
// case there and a number here, never an image.
export const ICON = {
  NONE: 0, CIRCLE: 1, RING: 2, PLAY: 3, PAUSE: 4, BURGER: 5, CLOSE: 6,
  CHEVRON: 7, CHECK: 8, EXPAND: 9, CONTRACT: 10, DOT: 11, PLUS: 12, MINUS: 13,
  SPEAKER: 14, MUTE: 15, GRIP: 16
};

// Instance layout, 24 floats:
//   0 kind
//   1 x   2 y   3 w   4 h          rect in css px
//   5 radius                        corner radius, css px; GLYPH rotation (radians)
//   6..9  fill rgba                 RECT fill, GLASS tint (a = tint strength), GLYPH and ICON colour
//   10 border width                 css px, 0 for none
//   11..14 border rgba
//   15 shadow radius                css px, 0 for none; the quad is expanded by this
//   16 shadow alpha
//   17..20 u0 v0 u1 v1              GLYPH atlas uvs; ICON unused
//   21 A                            GLYPH sdf range in atlas px; ICON icon id; GLASS blur mix 0..1
//   22 B                            ICON stroke width css px; GLYPH edge softness css px; ICON rotation lives in 17 (radians)
//   23 opacity                      the group-alpha stack product at emit time
export const STRIDE = 24;

const MAX_CLIP_DEPTH = 32, MAX_ALPHA_DEPTH = 32;

export class DrawList {
  constructor(capacity = 2048) {
    this.data = new Float32Array(capacity * STRIDE);
    this.count = 0;
    // Batches are reused objects; batchCount says how many are live this
    // frame. Each is { first, count, x, y, w, h } with the clip in css px.
    this.batches = [];
    this.batchCount = 0;
    this._clip = new Float32Array(MAX_CLIP_DEPTH * 4);
    this._clipDepth = 0;
    this._alpha = new Float32Array(MAX_ALPHA_DEPTH);
    this._alphaDepth = 0;
    this._vw = 0; this._vh = 0;
  }

  // Starts a frame. The viewport is the whole surface and is the root clip.
  reset(viewW, viewH) {
    this.count = 0;
    this.batchCount = 0;
    this.glassCount = 0;   // frosted glass only; lets the engine skip the blur capture when none is up
    this._vw = viewW; this._vh = viewH;
    this._clipDepth = 1;
    const c = this._clip;
    c[0] = 0; c[1] = 0; c[2] = viewW; c[3] = viewH;
    this._alphaDepth = 1;
    this._alpha[0] = 1;
    this._openBatch();
  }

  get alpha() { return this._alpha[this._alphaDepth - 1]; }

  // ---- clip stack ----

  // Intersects with the current clip. A new clip starts a new batch, so keep
  // clips per region (a panel, a scroll body), not per widget.
  pushClip(x, y, w, h) {
    const c = this._clip, i = (this._clipDepth - 1) * 4;
    const x0 = Math.max(x, c[i]), y0 = Math.max(y, c[i + 1]);
    const x1 = Math.min(x + w, c[i] + c[i + 2]), y1 = Math.min(y + h, c[i + 1] + c[i + 3]);
    if (this._clipDepth >= MAX_CLIP_DEPTH) return;
    const j = this._clipDepth * 4;
    c[j] = x0; c[j + 1] = y0; c[j + 2] = Math.max(0, x1 - x0); c[j + 3] = Math.max(0, y1 - y0);
    this._clipDepth++;
    this._openBatch();
  }
  popClip() {
    if (this._clipDepth <= 1) return;
    this._clipDepth--;
    this._openBatch();
  }
  // True when a rect is entirely outside the current clip, so callers can skip
  // emitting rows that are scrolled out of view.
  culled(x, y, w, h) {
    const c = this._clip, i = (this._clipDepth - 1) * 4;
    return x + w < c[i] || y + h < c[i + 1] || x > c[i] + c[i + 2] || y > c[i + 1] + c[i + 3];
  }

  // True when the horizontal band from y0 to y1 lies wholly above or below
  // the current clip, for a caller (text) that can rule out a whole line
  // before it does any per-glyph work.
  culledY(y0, y1) {
    const c = this._clip, i = (this._clipDepth - 1) * 4;
    return y1 < c[i + 1] || y0 > c[i + 1] + c[i + 3];
  }

  // ---- group opacity ----

  pushAlpha(a) {
    if (this._alphaDepth >= MAX_ALPHA_DEPTH) return;
    this._alpha[this._alphaDepth] = this._alpha[this._alphaDepth - 1] * a;
    this._alphaDepth++;
  }
  popAlpha() { if (this._alphaDepth > 1) this._alphaDepth--; }

  // ---- shapes ----

  // Rounded rect with optional border and outer soft shadow. Pass null for
  // borderColor with border 0, and 0 for shadow to skip them.
  rect(x, y, w, h, r, fill, border, borderColor, shadow, shadowAlpha) {
    const o = this._slot(KIND.RECT, x, y, w, h, r, fill, shadow > 0 ? shadow : 0);
    if (o < 0) return;
    this._border(o, border, borderColor, shadow, shadowAlpha);
  }

  // Frosted glass: replaces what is under it with the blurred lit-frame
  // capture, tinted. tint[3] is how strongly the tint covers the blur.
  // blurMix 0..1 lets a panel fade its frost in without a second texture.
  // A pane at blurMix 0 is flat tint and never reads the capture, so it is
  // not counted: glassCount is what tells the engine a capture is worth
  // taking, and a flat pane does not need one.
  glass(x, y, w, h, r, tint, blurMix, border, borderColor, shadow, shadowAlpha) {
    const o = this._slot(KIND.GLASS, x, y, w, h, r, tint, shadow > 0 ? shadow : 0);
    if (o < 0) return;
    if (blurMix > 0.001) this.glassCount++;
    this._border(o, border, borderColor, shadow, shadowAlpha);
    this.data[o + 21] = blurMix;
  }

  // One glyph quad. The text system computes the quad and uvs; this only
  // stores them. rotation (radians, about the quad's centre) and soft (edge
  // blur, css px) are for the centre word's transitions; every other caller
  // leaves them off and gets 0.
  glyph(x, y, w, h, u0, v0, u1, v1, color, sdfRange, rotation, soft) {
    const o = this._slot(KIND.GLYPH, x, y, w, h, 0, color, 0);
    if (o < 0) return;
    const d = this.data;
    d[o + 17] = u0; d[o + 18] = v0; d[o + 19] = u1; d[o + 20] = v1;
    d[o + 21] = sdfRange;
    if (rotation) d[o + 5] = rotation;
    if (soft) d[o + 22] = soft;
  }

  // An analytic icon centred in its box. stroke is the line width in css px
  // for outline icons; rotation in radians (the chevron uses it).
  icon(id, x, y, w, h, color, stroke, rotation) {
    const o = this._slot(KIND.ICON, x, y, w, h, 0, color, 0);
    if (o < 0) return;
    const d = this.data;
    d[o + 17] = rotation;
    d[o + 21] = id;
    d[o + 22] = stroke;
  }

  // ---- internals ----

  // An instance that cannot put a pixel inside the current clip is dropped
  // here rather than stored, uploaded and scissored away on the GPU: rows
  // scrolled out of the drawer or the mixer, the body of a group clipped
  // shut. The shader grows every quad by its shadow radius plus 1 px, and the
  // renderer rounds the scissor outward to whole device pixels, so the test
  // uses the rect grown by the shadow plus 2 px, which can only keep an
  // instance that draws nothing, never drop one that draws something.
  _slot(kind, x, y, w, h, r, color, shadow) {
    const a = this._alpha[this._alphaDepth - 1];
    if (a <= 0.001 || w <= 0 || h <= 0) return -1;
    const m = shadow + 2, c = this._clip, ci = (this._clipDepth - 1) * 4;
    if (x + w + m < c[ci] || y + h + m < c[ci + 1] || x - m > c[ci] + c[ci + 2] || y - m > c[ci + 1] + c[ci + 3]) return -1;
    if ((this.count + 1) * STRIDE > this.data.length) this._grow();
    const o = this.count * STRIDE, d = this.data;
    d[o] = kind;
    d[o + 1] = x; d[o + 2] = y; d[o + 3] = w; d[o + 4] = h;
    d[o + 5] = r;
    d[o + 6] = color[0]; d[o + 7] = color[1]; d[o + 8] = color[2]; d[o + 9] = color[3];
    d[o + 10] = 0;
    d[o + 11] = 0; d[o + 12] = 0; d[o + 13] = 0; d[o + 14] = 0;
    d[o + 15] = 0; d[o + 16] = 0;
    d[o + 17] = 0; d[o + 18] = 0; d[o + 19] = 0; d[o + 20] = 0;
    d[o + 21] = 0; d[o + 22] = 0;
    d[o + 23] = a;
    this.count++;
    this.batches[this.batchCount - 1].count++;
    return o;
  }

  _border(o, border, borderColor, shadow, shadowAlpha) {
    const d = this.data;
    if (border > 0 && borderColor) {
      d[o + 10] = border;
      d[o + 11] = borderColor[0]; d[o + 12] = borderColor[1];
      d[o + 13] = borderColor[2]; d[o + 14] = borderColor[3];
    }
    if (shadow > 0) { d[o + 15] = shadow; d[o + 16] = shadowAlpha; }
  }

  // Closes the current batch if it is empty-and-reusable, otherwise opens a
  // new one carrying the current clip.
  _openBatch() {
    const c = this._clip, i = (this._clipDepth - 1) * 4;
    let b = this.batchCount > 0 ? this.batches[this.batchCount - 1] : null;
    if (!b || b.count > 0) {
      if (this.batchCount >= this.batches.length) {
        this.batches.push({ first: 0, count: 0, x: 0, y: 0, w: 0, h: 0 });
      }
      b = this.batches[this.batchCount++];
      b.count = 0;
    }
    b.first = this.count;
    b.x = c[i]; b.y = c[i + 1]; b.w = c[i + 2]; b.h = c[i + 3];
  }

  _grow() {
    const next = new Float32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }
}
