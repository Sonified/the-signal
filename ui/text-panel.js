// A fixed dark backing whose opacity arrives separately behind each letter.
// Neighbouring letter levels blend across the panel, without overlapping
// dark patches or changing the box's size as the letters fade.
const MAX_LETTERS = 4096, MAX_LINES = 16;
const BLACK = new Float32Array([0, 0, 0, 1]);

export class TextPanel {
  constructor() {
    this.starts = new Float64Array(MAX_LETTERS);
    this.letters = new Float32Array(MAX_LETTERS * 2); // centre x, opacity
    this.lines = new Float32Array(MAX_LINES * 6); // first, count, x0, y0, x1, y1
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

  draw(dl, strength, pad, radius, blur, perLine, lineH) {
    if (strength <= 0.002 || !this.count) return;
    const l = this.lines, p = this.letters;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let k = 0; k < this.lineCount; k++) {
      const o = k * 6;
      if (!l[o + 1]) continue;
      bx0 = Math.min(bx0, l[o + 2]); by0 = Math.min(by0, l[o + 3]);
      bx1 = Math.max(bx1, l[o + 4]); by1 = Math.max(by1, l[o + 5]);
    }
    dl.pushAlpha(strength);
    for (let k = 0; k < this.lineCount; k++) {
      const o = k * 6, first = l[o], n = l[o + 1];
      if (!n) continue;
      const padY = perLine && this.lineCount > 1 ? Math.min(pad, Math.max(1, (lineH - l[o + 5] + l[o + 3]) * 0.5)) : pad;
      const x = (perLine ? l[o + 2] : bx0) - pad, y = (perLine ? l[o + 3] : by0) - padY;
      const w = (perLine ? l[o + 4] : bx1) + pad - x, h = (perLine ? l[o + 5] : by1) + padY - y;
      const reach = blur >= 1 ? 3 * blur + 1 : 1;
      const midY = (l[o + 3] + l[o + 5]) * 0.5;
      const top = k === 0 ? y - reach : (midY + (l[o - 3] + l[o - 1]) * 0.5) * 0.5;
      const bottom = k === this.lineCount - 1 ? y + h + reach : (midY + (l[o + 9] + l[o + 11]) * 0.5) * 0.5;
      let left = x - reach, a0 = p[first * 2 + 1];
      // One strip before the first centre, one between each pair, and one
      // after the last. The strips share edges and never blend over each other.
      for (let j = 0; j <= n; j++) {
        const right = j < n ? p[(first + j) * 2] : x + w + reach;
        const a1 = j < n ? p[(first + j) * 2 + 1] : a0;
        if (right > left && Math.max(a0, a1) > 0.001) {
          dl.panelStrip(x, y, w, h, radius, BLACK, blur, left, right, top, bottom, a0, a1);
        }
        left = right; a0 = a1;
      }
    }
    dl.popAlpha();
  }
}
