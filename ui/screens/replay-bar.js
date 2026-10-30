// The standing playback's scrub bar (main.js replayMode, ?replay=<tape> or
// ?event=<name>): a video player's, at the very bottom of the page across
// the visible field (the drawer's inset taken off, EDGE in from each side),
// on a quiet backing of its own like the morph's (ui/screens/morph.js). A
// track with the played part lit, a knob where the pass stands, the time
// played at the left and the pass's whole length at the right, m:ss, or
// h:mm:ss for a pass of an hour or more. Pass time (core/brush.js
// brushReplayPosition), which on this page (scale 1) is the drawing's own,
// the rest after its last mark included.
//
// A press or a drag on the track moves the playback there (brushReplaySeek),
// forward or back, live as the pointer moves, held or playing: held, the
// knob stands at the new place and play goes on from it when let go. A
// press anywhere else on the bar is taken and does nothing, so it never
// reaches the field (a stroke, or the tap that holds the playback); the
// field around it keeps its own. It keeps to the quick bar's row, which
// this page hides, so the dealt hand's row and the morph above it stand
// where they always did. It comes and goes with the chrome as the morph
// does: up while the pointer has moved lately or rests on it, then faded
// out with the chrome's spring, alpha, taking no presses once gone. Nothing
// is drawn while no pass is planned (the tape still coming).

import { S } from '../../js/state.js';
import { brushReplayPosition, brushReplaySeek } from '../../core/brush.js';
import { touchAware } from '../widgets.js';
import { COLOR, RADIUS, LAYOUT, MOTION, TYPE, W, TRACK, SPACE } from '../theme.js';

const BAR_H = 30, PAD = 12, EDGE = 16, TRACK_H = 3, KNOB_R = 10;
const BACK = new Float32Array([0, 0, 0, 0.5]);

// m:ss, or h:mm:ss when long
function clockText(ms, long) {
  const s = Math.floor(ms / 1000), sec = s % 60, ss = (sec < 10 ? '0' : '') + sec;
  if (!long) return Math.floor(s / 60) + ':' + ss;
  const m = Math.floor(s / 60) % 60;
  return Math.floor(s / 3600) + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
}
// the two readouts, remade only when their second turns; each slot as wide
// as the total's shape in zeros, so the track never jitters as they change
let atS = -1, atStr = '', msS = -1, msStr = '', slotW = 0;
// the last place a press sought, so a pointer held still seeks once
let lastSeek = -1;

export function drawReplayBar(ui, dl, width, height, alpha) {
  if (alpha < 0.01) return;
  let pos = brushReplayPosition();
  if (!pos) return;
  const inset = S.edgeInset || 0;
  const w = Math.max(160, width - inset - 2 * EDGE);
  const x = inset + EDGE;
  const h = touchAware(ui, BAR_H);
  const y = height - LAYOUT.chromeInset - h;
  const long = pos.ms >= 3600000;
  const totS = Math.ceil(pos.ms / 1000);
  if (totS !== msS) {
    msS = totS; msStr = clockText(totS * 1000, long);
    slotW = ui.text.measure(msStr.replace(/\d/g, '0'), TYPE.sm, W.regular);
    atS = -1;
  }
  const tx = x + PAD + slotW + SPACE.md;
  const tw = Math.max(24, w - 2 * (PAD + slotW + SPACE.md));
  const cy = y + h / 2;

  // the track first, a knob's reach past each end, the bar's full height
  const id = ui.id('replay.track');
  ui.interact(id, tx - KNOB_R, y, tw + 2 * KNOB_R, h, false);
  const hover = ui.hover, pressed = ui.pressed;
  if (hover || pressed) ui.setCursorHint('pointer');
  if (pressed) {
    const f = (ui.pointerX - tx) / tw;
    const target = (f > 0 ? (f < 1 ? f : 1) : 0) * pos.ms;
    if (target !== lastSeek) { lastSeek = target; brushReplaySeek(target); pos = brushReplayPosition(); if (!pos) return; }
  } else lastSeek = -1;
  // the rest of the bar takes a press and does nothing with it
  ui.dragHold = 0;
  ui.interact(ui.id('replay.back'), x, y, w, h, false);
  const hoverA = ui.spring(ui.idx('replay.track', 1), hover || pressed ? 1 : 0, MOTION.hover);
  const pressA = ui.spring(ui.idx('replay.track', 2), pressed ? 1 : 0, MOTION.press);

  const at = pos.at, f = pos.ms > 0 ? at / pos.ms : 0;
  const s = Math.floor(at / 1000);
  if (s !== atS) { atS = s; atStr = clockText(s * 1000, long); }

  dl.pushAlpha(alpha);
  dl.rect(x, y, w, h, RADIUS.md, BACK, 1, COLOR.lineSoft, 0, 0);
  dl.rect(tx, cy - TRACK_H / 2, tw, TRACK_H, TRACK_H / 2, COLOR.lineStrong, 0, null, 0, 0);
  dl.rect(tx, cy - TRACK_H / 2, Math.max(TRACK_H, tw * f), TRACK_H, TRACK_H / 2, COLOR.accent, 0, null, 6, 0.35);
  const r = 5 + 3 * hoverA + 2 * pressA, kx = tx + f * tw;
  dl.rect(kx - r, cy - r, r * 2, r * 2, r, COLOR.accent, 0, null, 8, 0.4 * pressA + 0.15);
  ui.text.lineMetrics(TYPE.sm, ui._lm);
  const base = cy + (ui._lm.ascent - ui._lm.descent) / 2;
  ui.text.draw(dl, atStr, x + PAD, base, TYPE.sm, W.regular, COLOR.ink, 0, TRACK.tight, 1);
  ui.text.draw(dl, msStr, x + w - PAD, base, TYPE.sm, W.regular, COLOR.inkDim, 2, TRACK.tight, 1);
  dl.popAlpha();
}
