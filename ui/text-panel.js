// A fixed dark backing whose opacity arrives separately behind each letter.
// Each letter holds its own level across its whole box, and the level runs
// straight from one letter to the next across the gap (so two lit letters
// never dip between them, a word space included). Past a lit letter the
// dark also runs out smoothly over a lead sized from the line height and the
// panel's own feather, so the front of an arrival is as soft as the panel's
// edges, never a wall at the letter. Where the two rules overlap the higher
// level wins, so dark never doubles and the box's size never changes as the
// letters fade. The outermost letters hold their level on out to the
// panel's edge, and between lines the dark crossfades through the gap.
const MAX_LETTERS = 4096, MAX_LINES = 16;
const BLACK = new Float32Array([0, 0, 0, 1]);
// knots along a run-out, as shares of its lead; the ease between them is
// laid in by evaluating the smooth curve at each
const RUN = [0.25, 0.5, 0.75, 1];
const smooth01 = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

export class TextPanel {
  constructor() {
    this.starts = new Float64Array(MAX_LETTERS);
    this.letters = new Float32Array(MAX_LETTERS * 3); // box x0, box x1, opacity
    this.lines = new Float32Array(MAX_LINES * 6); // first, count, x0, y0, x1, y1
    this.used = new Int32Array(MAX_LINES);
    // each line's breakpoints, sorted: where its level stops being straight
    this.cuts = new Float64Array(MAX_LETTERS * (2 + 2 * RUN.length));
    this.cutAt = new Int32Array(MAX_LINES);
    this.cutN = new Int32Array(MAX_LINES);
    this.lead = new Float64Array(MAX_LINES);
    this.seed = -1;
    this.text = '';
    this.age = 0;
    this.pend = false; // a flat strip held back to merge with its neighbour
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
    this.letters[this.count * 3] = x0;
    this.letters[this.count * 3 + 1] = x1;
    this.letters[this.count * 3 + 2] = a;
    this.count++;
  }

  // Line k's breakpoints into this.cuts, sorted: every letter's box edges,
  // and for each letter that has any level the knots of its run-out on either
  // side (the outermost letters have none outward, they hold on to the edge).
  // Between two breakpoints the level is straight, so the strips cut here
  // follow the envelope.
  _prepare(k, at, blur) {
    const l = this.lines, p = this.letters, o = k * 6, c = this.cuts;
    const first = l[o], n = l[o + 1];
    const lead = this.lead[k] = Math.max(1, l[o + 5] - l[o + 3]) + 2 * blur;
    let m = at;
    for (let j = 0; j < n; j++) {
      const x0 = p[(first + j) * 3], x1 = p[(first + j) * 3 + 1];
      c[m++] = x0; c[m++] = x1;
      if (p[(first + j) * 3 + 2] <= 0.001) continue;
      for (let r = 0; r < RUN.length; r++) {
        if (j > 0) c[m++] = x0 - lead * RUN[r];
        if (j < n - 1) c[m++] = x1 + lead * RUN[r];
      }
    }
    for (let i = at + 1; i < m; i++) {   // nearly sorted already
      const v = c[i];
      let j = i - 1;
      while (j >= at && c[j] > v) { c[j + 1] = c[j]; j--; }
      c[j + 1] = v;
    }
    this.cutAt[k] = at; this.cutN[k] = m - at;
    return m;
  }

  // Line k's level at x: straight through each letter's level across its box
  // and on to its neighbour's across the gap, or a lit letter's smooth
  // run-out past its box, whichever is higher.
  _env(k, x) {
    const p = this.letters, o = k * 6;
    const first = this.lines[o], n = this.lines[o + 1], lead = this.lead[k];
    let best = 0;
    for (let j = 0; j < n; j++) {
      const a = p[(first + j) * 3 + 2];
      const x0 = p[(first + j) * 3], x1 = p[(first + j) * 3 + 1];
      if (x < x0) {
        if (j === 0) { if (a > best) best = a; }          // held out to the edge
        else if (a > 0) { const t = a * (1 - smooth01((x0 - x) / lead)); if (t > best) best = t; }
      } else if (x <= x1) {
        if (a > best) best = a;
      } else {
        if (j === n - 1) { if (a > best) best = a; }
        else {
          const nx0 = p[(first + j + 1) * 3], na = p[(first + j + 1) * 3 + 2];
          if (x < nx0) {                                   // across the gap
            const g = a + (na - a) * (x - x1) / (nx0 - x1);
            if (g > best) best = g;
          }
          if (a > 0) { const t = a * (1 - smooth01((x - x1) / lead)); if (t > best) best = t; }
        }
      }
    }
    return best;
  }

  // Strips are handed to the draw list through here so two flat strips at
  // the same levels, edge to edge, go out as one: a settled panel is a single
  // strip however many letters it has. Ramps are never merged, the shader
  // eases each strip's own run.
  _put(dl, left, right, a0, a1, b0, b1) {
    if (Math.max(a0, a1, b0, b1) <= 0.001) { this._flush(dl); return; }
    const flat = a0 === a1 && b0 === b1;
    if (this.pend) {
      if (flat && this.pFlat && this.pRight === left && this.pA === a0 && this.pB0 === b0) { this.pRight = right; return; }
      this._flush(dl);
    }
    this.pend = true; this.pFlat = flat;
    this.pLeft = left; this.pRight = right;
    this.pA = a0; this.pA1 = a1; this.pB0 = b0; this.pB1 = b1;
  }

  _flush(dl) {
    if (!this.pend) return;
    this.pend = false;
    dl.panelStrip(this.bx, this.by, this.bw, this.bh, this.br, BLACK, this.bblur,
                  this.pLeft, this.pRight, this.bTop, this.bBottom, this.pA, this.pA1, this.pB0, this.pB1);
  }

  // The strips of one horizontal band: the panel's rect, each quad cropped
  // to [left,right] x [top,bottom], with line k's levels along both the
  // band's top and bottom edges. The strips share edges and never blend
  // over each other.
  _band(dl, k, x, y, w, h, radius, blur, reach, top, bottom) {
    this.bx = x; this.by = y; this.bw = w; this.bh = h; this.br = radius; this.bblur = blur;
    this.bTop = top; this.bBottom = bottom;
    const end = x + w + reach;
    let left = x - reach, a0 = this._env(k, left);
    for (let i = this.cutAt[k], e = i + this.cutN[k]; i < e && left < end; i++) {
      const right = Math.min(this.cuts[i], end);
      if (right <= left) continue;
      const a1 = this._env(k, right);
      this._put(dl, left, right, a0, a1, a0, a1);
      left = right; a0 = a1;
    }
    if (end > left) this._put(dl, left, end, a0, a0, a0, a0);
    this._flush(dl);
  }

  // The band between two lines: its top edge carries line ka's levels, its
  // bottom edge line kb's, cut at both lines' breakpoints so every strip is
  // linear in x along both edges. The dark crossfades through the gap from
  // one line's arrival to the other's instead of jumping at a seam.
  _gap(dl, ka, kb, x, y, w, h, radius, blur, reach, top, bottom) {
    this.bx = x; this.by = y; this.bw = w; this.bh = h; this.br = radius; this.bblur = blur;
    this.bTop = top; this.bBottom = bottom;
    const end = x + w + reach;
    let ia = this.cutAt[ka], ib = this.cutAt[kb];
    const ea = ia + this.cutN[ka], eb = ib + this.cutN[kb];
    let left = x - reach, a0 = this._env(ka, left), b0 = this._env(kb, left);
    while (left < end) {
      const xa = ia < ea ? this.cuts[ia] : Infinity, xb = ib < eb ? this.cuts[ib] : Infinity;
      const right = Math.min(xa, xb, end);
      if (xa <= right) ia++;
      if (xb <= right) ib++;
      if (right <= left) continue;
      const a1 = this._env(ka, right), b1 = this._env(kb, right);
      this._put(dl, left, right, a0, a1, b0, b1);
      left = right; a0 = a1; b0 = b1;
    }
    this._flush(dl);
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
    for (let j = 0, at = 0; j < m; j++) at = this._prepare(used[j], at, blur);
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
