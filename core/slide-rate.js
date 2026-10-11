// Pure playback math shared by the laptop and its show controller.
export function slideRateFromPos(pos) {
  const p = pos > 0 ? Math.min(1000, pos) : 0;
  // Round to the stored hundredth BEFORE snapping, and snap strictly: the
  // old order tested the unrounded rate, so a stored 1.03 mapped to a
  // position whose rate snapped back to 1.00 — the readout said 1.00x while
  // the slides played at 1.03x, and a drag there jumped the knob to 500.
  // Rounded-then-snapped, position -> rate -> position is a fixed point.
  const r = p <= 500 ? p / 500 : Math.pow(2, (p - 500) / 500);
  const q = Math.round(r * 100) / 100;
  return Math.abs(q - 1) < 0.03 ? 1 : q;
}

export function slideRateToPos(v) {
  if (!(v === v)) return NaN;
  const r = Math.max(0, Math.min(2, v));
  return Math.round(r <= 1 ? 500 * r : 500 + 500 * Math.log2(r));
}

export const slideElementRate = r => r > 0 ? Math.max(0.0625, r) : 0;
