// The overlay: what rides on the field inside the scene pass, after the
// strobe content, so it sits on the field without being multiplied by it.
//
// Three things, bottom to top. The veil is v0's two-second canvas fade on the
// first start: before anything has run the field is hidden behind black, and
// the first press lifts it, so the tunnel arrives already in motion. The word
// is the centre-screen word from core/words.js, drawn with its backing by
// overlay-word.js. The hint is the opening line, shown only while stopped,
// stepped and drawn by overlay-hint.js. All three centre on the visible
// field, so they move with the drawer exactly as the scene's own recentring
// does. This file is the conductor: the veil, the hotkey notice, the frame
// clock, and the order the layers land in.
import { S } from '../../js/state.js';
import { TYPE, TRACK, W } from '../theme.js';
import { drawWordLayer } from './overlay-word.js';
import { stepHint, drawHint, hintToSmoke, noteRun, HINT_MAIN } from './overlay-hint.js';
export { setOverlayTouch, setOverlayFollow } from './overlay-hint.js';

const VEIL = new Float32Array([0, 0, 0, 1]);
const REVEAL_MS = 2000;
let revealAt = -1;
// A stream link's still frame (core/broadcast.js followStill) shows the
// stream's scene before the join tap, so the first-start veil is let go.
let veilLifted = false;
export function liftVeil() { veilLifted = true; }
let wasRunning = false;
// the last frame's clock, for the word's and hint's envelope steps
let envLastT = -1;

// Whether anything drawn here is still moving on its own (the veil lifting,
// the hint fading). The overlay rides in the scene pass, so the blur capture
// sees it; while the strobe is stopped the engine only refreshes that capture
// when the scene could have changed, and a fade in progress counts.
export const overlayState = { animating: false };

// A small transient notice for a hotkey's effect ("Text: On"), shown at the
// bottom centre, held a moment and faded like the hint. flashNotice takes a
// fixed string (the callers pass constants, so nothing is built per press)
// and restarts the clock, so a second press just refreshes it.
const NOTICE_HOLD_MS = 900, NOTICE_FADE_MS = 600;
const notice = { text: null, at: -1e9 };
export function flashNotice(str) { notice.text = str; notice.at = -1; }

export function drawOverlay(dl, text, t, width, height) {
  const inset = S.edgeInset || 0;
  const cx = inset + (width - inset) / 2, cy = height / 2;

  // veil: fully black until the first start, then a linear two-second lift.
  if (S.running && revealAt < 0) revealAt = t;
  if (S.running) noteRun();
  // Every start with the hint on screen sends it off as smoke, the first
  // and each resume alike. hintToSmoke does nothing when the hint is
  // already gone (the guard's card up), and a hint caught mid fade-in
  // dissolves from the level it had reached.
  if (S.running && !wasRunning) hintToSmoke(text, cx, cy, t);
  wasRunning = S.running;
  const veil = veilLifted ? 0 : revealAt < 0 ? 1 : Math.max(0, 1 - (t - revealAt) / REVEAL_MS);
  if (veil > 0.001) {
    VEIL[3] = veil;
    dl.rect(0, 0, width, height, 0, VEIL, 0, null, 0, 0);
  }

  const dt = envLastT < 0 ? 0 : Math.min(100, t - envLastT);
  envLastT = t;

  // the word and its backing, ghosts first, under everything that follows
  const ghostMoving = drawWordLayer(dl, text, dt, cx, cy, width, inset);

  // the hint's clocks and envelopes step now; its letters land after the
  // notice, so the draw order below never changes
  const hintMoving = stepHint(text, t, dt, cx, cy);

  // the hotkey notice, under the composition so it never sits on the word
  let noticeLive = false;
  if (notice.text) {
    if (notice.at < 0) notice.at = t;   // stamped on its first drawn frame
    const age = t - notice.at;
    const na = age < NOTICE_HOLD_MS ? 1 : 1 - (age - NOTICE_HOLD_MS) / NOTICE_FADE_MS;
    if (na <= 0) { notice.text = null; } else {
      noticeLive = true;
      dl.pushAlpha(na);
      text.draw(dl, notice.text, cx, height - 72, TYPE.sm, W.regular, HINT_MAIN, 1, TRACK.label, 1);
      dl.popAlpha();
    }
  }

  overlayState.animating = (veil > 0.001 && veil < 1) || noticeLive || hintMoving || ghostMoving;
  drawHint(dl, text, cx, cy);
}
