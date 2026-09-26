// The overlay: what rides on the field inside the scene pass, after the
// strobe content, so it sits on the field without being multiplied by it.
//
// Three things, bottom to top. The veil is v0's two-second canvas fade on the
// first start: before anything has run the field is hidden behind black, and
// the first press lifts it, so the tunnel arrives already in motion. The word
// is the centre-screen word from core/words.js. The hint is the opening line,
// shown only while stopped. All three centre on the visible field, so they
// move with the drawer exactly as the scene's own recentring does.
import { S } from '../../../js/state.js';
import { wordState } from '../../core/words.js';
import { letterFx, wordLetters, lineCtx } from '../../core/word-fx.js';
import { guard } from '../../../js/panel-guard.js';
import { COLOR, TYPE, TRACK, W, MOTION } from '../theme.js';
import * as anim from '../anim.js';

const VEIL = new Float32Array([0, 0, 0, 1]);
const HINT_MAIN = new Float32Array([185 / 255, 198 / 255, 212 / 255, 1]);   // v0 #hint .hmain
const REVEAL_MS = 2000;

const HINT_1 = 'Press the space bar to begin';
const HINT_2 = 'press the “~” key for settings  ·  press ENTER for full screen';
const HINT_3 = 'T for words  ·  C for color';

// The word's line box depends only on its size (font metrics, not ink), so
// it is asked for again only when the size changes. lineMetrics sets a font
// string and measures, which leaves garbage behind, and the word is on
// screen for most frames of a session.
const lm = { ascent: 0, descent: 0 };
let lmSize = -1;
let revealAt = -1;

// Whether anything drawn here is still moving on its own (the veil lifting,
// the hint fading). The overlay rides in the scene pass, so the blur capture
// sees it; while the strobe is stopped the engine only refreshes that capture
// when the scene could have changed, and a fade in progress counts.
export const overlayState = { animating: false };

export function drawOverlay(dl, text, t, width, height) {
  const inset = S.edgeInset || 0;
  const cx = inset + (width - inset) / 2, cy = height / 2;

  // veil: fully black until the first start, then a linear two-second lift
  if (S.running && revealAt < 0) revealAt = t;
  const veil = revealAt < 0 ? 1 : Math.max(0, 1 - (t - revealAt) / REVEAL_MS);
  if (veil > 0.001) {
    VEIL[3] = veil;
    dl.rect(0, 0, width, height, 0, VEIL, 0, null, 0, 0);
  }

  // Drawn at its peak opacity: the fade in and out are the transitions'
  // business now (core/word-fx.js), letter by letter. The letter record the
  // cloud layer reads is cleared every frame, so no word means no cloud.
  wordLetters.count = 0;
  wordLetters.seed = wordState.seed;
  if (wordState.visible && wordState.peak > 0.002 && wordState.text) {
    // An affirmation wraps into balanced lines around the middle (see
    // phrase in text-atlas); a single word is simply one line of it. The
    // letters of every line share one record, so the transitions and the
    // cloud see the whole block as one word.
    const ph = text.phrase(wordState.text, S.textSize || TYPE.word, W.light, TRACK.word, width - inset);
    const size = ph.size;
    if (size !== lmSize) { text.lineMetrics(size, lm); lmSize = size; }
    const baseY = cy + (lm.ascent - lm.descent) / 2;
    const n = ph.lines.length;
    lineCtx.n = n;
    for (let k = 0; k < n; k++) {
      lineCtx.k = k;
      text.drawWord(dl, ph.lines[k], cx, baseY + (k - (n - 1) / 2) * ph.lineH, size, W.light,
                    wordState.color, TRACK.word, wordState.peak, letterFx, wordLetters);
    }
  }

  // the panel guard's card sits where the hint does, so the hint makes way
  const h = anim.spring('overlay.hint', S.running || guard.noticeOpen ? 0 : 1, MOTION.fade);
  overlayState.animating = (veil > 0.001 && veil < 1) || !anim.settled('overlay.hint');
  if (h > 0.002) {
    dl.pushAlpha(h);
    text.draw(dl, HINT_1, cx, cy + 4, TYPE.xl, W.light, HINT_MAIN, 1, TRACK.hint, 1);
    text.draw(dl, HINT_2, cx, cy + 34, TYPE.sm, W.regular, COLOR.inkFaint, 1, TRACK.label, 1);
    text.draw(dl, HINT_3, cx, cy + 52, TYPE.sm, W.regular, COLOR.inkFaint, 1, TRACK.label, 1);
    dl.popAlpha();
  }
}
