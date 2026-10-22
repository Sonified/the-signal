// A fixed dark backing whose opacity arrives separately behind each letter.
// Neighbouring letter levels blend across the panel — along each line
// between letter centres, and vertically through the gap between lines —
// without overlapping dark patches or changing the box's size as the
// letters fade.
const MAX_LETTERS = 4096, MAX_LINES = 16;
const BLACK = new Float32Array([0, 0, 0, 1]);

export class TextPanel {
  constructor() {
    this.starts = new Float64Array(MAX_LETTERS);
    this.letters = new Float32Array(MAX_LETTERS * 2); // centre x, opacity
    this.lines = new Float32Array(MAX_LINES * 6); // first, count, x0, y0, x1, y1
    this.used = new Int32Array(MAX_LINES);
    this.seed = -1;
    this.text = '';
    this.age = 0;
  }

  begin(seed, text, age, fadeMs, lineCount) {
    if (seed !== this.seed || text !== this.text || age < this.age) this.starts.fill(-1);
    this.seed = seed; this.text = text; this.age = age; this.fadeMs = fadeMs;
    this.count = 0; this.lineCount = Math.min(MAX_LINES, lineCount);
    this.line = 0; this.offset = 0;
    for (let k = 0; k < this.lineCount; k++) {
      const o = k * 6;
      this.lines[o] = this.lines[o + 1] = 0;
      this.lines[o + 2] = this.lines[o + 3] = Infinity;
      this.lines[o + 4] = this.lines[o + 5] = -Infinity;
    }
  }

  letter(i, x0, y0, x1, y1, shown) {
    const id = this.offset + i, o = this.line * 6;
    if (id >= MAX_LETTERS || this.count >= MAX_LETTERS || this.line >= this.lineCount) return;
    if (shown && this.starts[id] < 0) this.starts[id] = this.age;
    let a = 0;
    if (shown) {
      const u = this.fadeMs > 0 ? Math.min(1, (this.age - this.starts[id]) / this.fadeMs) : 1;
      a = u * u * (3 - 2 * u);
    }
    const l = this.lines;
    if (l[o + 1] === 0) l[o] = this.count;
    l[o + 1]++;
    l[o + 2] = Math.min(l[o + 2], x0); l[o + 3] = Math.min(l[o + 3], y0);
    l[o + 4] = Math.max(l[o + 4], x1); l[o + 5] = Math.max(l[o + 5], y1);
    this.letters[this.count * 2] = (x0 + x1) * 0.5;
    this.letters[this.count * 2 + 1] = a;
    this.count++;
  }

  // The strips of one horizontal band: the panel's rect, each quad cropped
  // to [left,right] x [top,bottom], with line k's alphas run centre to
  // centre, the same along the band's top and bottom edges. One strip
  // before the first centre, one between each pair, and one after the last;
  // the strips share edges and never blend over each other.
  _band(dl, k, x, y, w, h, radius, blur, reach, top, bottom) {
    const l = this.lines, p = this.letters, o = k * 6;
    const first = l[o], n = l[o + 1];
    let left = x - reach, a0 = p[first * 2 + 1];
    for (let j = 0; j <= n; j++) {
      const right = j < n ? p[(first + j) * 2] : x + w + reach;
      const a1 = j < n ? p[(first + j) * 2 + 1] : a0;
      if (right > left && Math.max(a0, a1) > 0.001) {
        dl.panelStrip(x, y, w, h, radius, BLACK, blur, left, right, top, bottom, a0, a1, a0, a1);
      }
      left = right; a0 = a1;
    }
  }

  // Line k's alpha at x: linear between its letter centres, constant past
  // either end.
  _at(k, x) {
    const p = this.letters, o = k * 6;
    const first = this.lines[o], n = this.lines[o + 1];
    if (x <= p[first * 2]) return p[first * 2 + 1];
    for (let i = 1; i < n; i++) {
      const x1 = p[(first + i) * 2];
      if (x <= x1) {
        const x0 = p[(first + i - 1) * 2];
        const a0 = p[(first + i - 1) * 2 + 1], a1 = p[(first + i) * 2 + 1];
        return x1 > x0 ? a0 + (a1 - a0) * (x - x0) / (x1 - x0) : a1;
      }
    }
    return p[(first + n - 1) * 2 + 1];
  }

  // The band between two lines: its top edge carries line ka's alphas, its
  // bottom edge line kb's, cut at both lines' letter centres so every strip
  // is linear in x along both edges. The dark crossfades through the gap
  // from one line's arrival to the other's instead of jumping at a seam.
  _gap(dl, ka, kb, x, y, w, h, radius, blur, reach, top, bottom) {
    const l = this.lines, p = this.letters;
    const fa = l[ka * 6], na = l[ka * 6 + 1], fb = l[kb * 6], nb = l[kb * 6 + 1];
    const end = x + w + reach;
    let ia = 0, ib = 0, left = x - reach;
    let a0 = p[fa * 2 + 1], b0 = p[fb * 2 + 1];
    for (;;) {
      const xa = ia < na ? p[(fa + ia) * 2] : Infinity;
      const xb = ib < nb ? p[(fb + ib) * 2] : Infinity;
      const right = Math.min(xa, xb, end);
      const a1 = this._at(ka, right), b1 = this._at(kb, right);
      if (right > left && Math.max(a0, a1, b0, b1) > 0.001) {
        dl.panelStrip(x, y, w, h, radius, BLACK, blur, left, right, top, bottom, a0, a1, b0, b1);
      }
      if (right >= end) break;
      if (xa <= right) ia++;
      if (xb <= right) ib++;
      left = right; a0 = a1; b0 = b1;
    }
  }

  draw(dl, strength, pad, radius, blur, perLine, lineH) {
    if (strength <= 0.002 || !this.count) return;
    const l = this.lines, used = this.used;
    let m = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let k = 0; k < this.lineCount; k++) {
      const o = k * 6;
      if (!l[o + 1]) continue;
      used[m++] = k;
      bx0 = Math.min(bx0, l[o + 2]); by0 = Math.min(by0, l[o + 3]);
      bx1 = Math.max(bx1, l[o + 4]); by1 = Math.max(by1, l[o + 5]);
    }
    if (!m) return;
    const reach = blur >= 1 ? 3 * blur + 1 : 1;
    dl.pushAlpha(strength);
    if (perLine) {
      // Each line its own pill, feathered on every side — the full reach
      // above and below, never cut at the midline between lines, so the
      // rounded edge and the blur survive. Neighbouring pills may brush
      // feathers in the gap, exactly as the per-line slabs always did.
      for (let j = 0; j < m; j++) {
        const k = used[j], o = k * 6;
        const padY = this.lineCount > 1 ? Math.min(pad, Math.max(1, (lineH - l[o + 5] + l[o + 3]) * 0.5)) : pad;
        const x = l[o + 2] - pad, y = l[o + 3] - padY;
        const w = l[o + 4] + pad - x, h = l[o + 5] + padY - y;
        this._band(dl, k, x, y, w, h, radius, blur, reach, y - reach, y + h + reach);
      }
    } else {
      // One panel over the block, tiled into horizontal bands: each line's
      // slice carries that line's alphas, and between lines a crossfade
      // band blends one line's levels into the next, so the dark spreads as
      // one sheet with no seam while the feather still reaches past every
      // outer edge. Lines that happen to touch or overlap meet at a plain
      // midline instead of a crossfade band.
      const x = bx0 - pad, y = by0 - pad, w = bx1 + pad - x, h = by1 + pad - y;
      let top = y - reach;
      for (let j = 0; j < m; j++) {
        const k = used[j], o = k * 6;
        let bottom, gTop = 0, gBottom = 0;
        if (j === m - 1) bottom = y + h + reach;
        else {
          gTop = l[o + 5]; gBottom = l[used[j + 1] * 6 + 3];
          bottom = gTop < gBottom - 0.5 ? gTop : (gTop + gBottom) * 0.5;
        }
        this._band(dl, k, x, y, w, h, radius, blur, reach, top, bottom);
        if (j < m - 1 && bottom === gTop) {
          this._gap(dl, k, used[j + 1], x, y, w, h, radius, blur, reach, gTop, gBottom);
          top = gBottom;
        } else top = bottom;
      }
    }
    dl.popAlpha();
  }
}
