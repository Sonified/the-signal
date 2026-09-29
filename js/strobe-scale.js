// One emergency multiplier over every visual and audio strobe depth. The
// individual controls keep their settings; this only scales what reaches a
// renderer or gain stage, so restoring 100% restores the exact prior scene.
import { S } from './state.js';

export function strobeScale() {
  const v = S.strobeScale;
  return typeof v === 'number' && Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 1;
}

export function scaledStrobeDepth(v) {
  v = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  if (v < 0) v = 0; else if (v > 1) v = 1;
  return v * strobeScale();
}
