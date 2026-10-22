// The centre word and its backing (Text > Shadow, Panel): the ghosts first,
// then the panel, the shadow over it and the word over both, drawn by
// drawOverlay (overlay.js) between the veil and the hint. The backing
// machinery itself — the shade record, panel measures, envelopes and ghosts
// — is shared with the hint and lives in ui/text-backing.js.
import { S } from '../../js/state.js';
import { wordState } from '../../core/words.js';
import { letterFx, wordLetters, lineCtx, wordFxWhole } from '../../core/word-fx.js';
import { TYPE, TRACK, W } from '../theme.js';
import { TextPanel } from '../text-panel.js';
import { SHADE_INK, shade, shadeShadow, pm, panelMetrics, unit, stepEnv,
         makeGhost, ghostSnap, ghostStep, ghostDraw } from '../text-backing.js';

// The word's line box depends only on its size (font metrics, not ink), so
// it is asked for again only when the size changes. lineMetrics sets a font
// string and measures, which leaves garbage behind, and the word is on
// screen for most frames of a session.
const lm = { ascent: 0, descent: 0 };
let lmSize = -1;

// Whole-word effects hide the atlas letters while drawing their own ink.
// Use their dissolve progress to start each letter's backing fade too.
const panel = new TextPanel();
function panelFx(i, n, relX, relY, wordW, size, out) {
  letterFx(i, n, relX, relY, wordW, size, out);
  if (wordFxWhole()) out[4] = 1 - out[7];
}
// eachLetter's sink for the panel pass: a letter counts as shown from the
// frame its transition gives it any opacity at all.
function panelSink(li, x0, y0, x1, y1, op) {
  panel.letter(li, x0, y0, x1, y1, op > 0.002);
}

let envShadow = 0;
const ghostPanel = makeGhost(), ghostShadow = makeGhost();

// One frame of the word layer. Returns whether a ghost is still fading, for
// the overlay's animating flag.
export function drawWordLayer(dl, text, dt, cx, cy, width, inset) {
  // Drawn at its peak opacity: the fade in and out are the transitions'
  // business now (core/word-fx.js), letter by letter. The letter record the
  // cloud layer reads is cleared every frame, so no word means no cloud.
  wordLetters.count = 0;
  wordLetters.seed = wordState.seed;
  // The shadow's arrival uses a shared envelope; the panel's arrival is
  // timed separately at each letter below. A nonzero Fade out keeps the
  // existing snapshot fading after the word starts leaving.
  const wordUp = wordState.visible && wordState.peak > 0.002 && !!wordState.text;
  const leaving = wordState.phase === 2;
  const shadowOutMs = S.textShadowFadeOutMs || 0, panelOutMs = S.textPanelFadeOutMs || 0;
  const shadowStage = S.textShadowOn !== false && wordUp;
  const panelStage = S.textPanelOn !== false && wordUp;
  if (!panelStage) panel.seed = -1;
  // a Fade out hands the leaving to the ghost, so the live envelope drops out
  envShadow = stepEnv(envShadow, shadowStage && !(leaving && shadowOutMs > 0), leaving, dt,
    S.textShadowFadeInMs || 0, shadowOutMs);
  ghostStep(ghostShadow, !shadowStage || leaving, dt, shadowOutMs);
  ghostStep(ghostPanel, !panelStage || leaving, dt, panelOutMs);
  // under everything, the word's own backing included: older goes behind
  ghostDraw(ghostPanel, dl);
  ghostDraw(ghostShadow, dl);
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
    // The backing first, panel under shadow, the word over both. Each pass
    // walks every line with lineCtx set just as the word's own pass does,
    // so a block's lines keep their own clocks in all three.
    // Each effect's own switch: off, its pass simply skips, the sliders
    // keeping their settings for the A back.
    const panelO = panelStage && !(leaving && panelOutMs > 0) ? unit(S.textPanelO || 0) : 0;
    const shadowO = S.textShadowOn !== false ? unit(S.textShadowO || 0) * envShadow : 0;
    if (panelO > 0.002) {
      const from = dl.count;
      const perLine = S.textPanelPerLine === true;
      panel.begin(wordState.seed, wordState.text, wordState.age, S.textPanelFadeInMs || 0, n);
      for (let k = 0; k < n; k++) {
        panel.line = k;
        lineCtx.k = k;
        text.eachLetter(ph.lines[k], cx, baseY + (k - (n - 1) / 2) * ph.lineH, size, W.light,
                        TRACK.word, panelFx, panelSink);
        panel.offset += ph.lines[k].length;
      }
      panelMetrics(size, unit(S.textPanelSize ?? 1), unit(S.textPanelSoft || 0));
      panel.draw(dl, panelO * wordState.reveal, pm.pad, pm.radius, pm.blur, perLine, ph.lineH);
      if (!leaving) ghostSnap(ghostPanel, dl, from);
    }
    if (shadowO > 0.002) {
      const from = dl.count;
      shadeShadow(shadowO, unit(S.textShadowBlur || 0), unit(S.textShadowSize || 0), size);
      for (let k = 0; k < n; k++) {
        lineCtx.k = k;
        text.drawWord(dl, ph.lines[k], cx, baseY + (k - (n - 1) / 2) * ph.lineH, size, W.light,
                      SHADE_INK, TRACK.word, wordState.peak, letterFx, null, shade);
      }
      if (!leaving) ghostSnap(ghostShadow, dl, from);
    }
    for (let k = 0; k < n; k++) {
      lineCtx.k = k;
      text.drawWord(dl, ph.lines[k], cx, baseY + (k - (n - 1) / 2) * ph.lineH, size, W.light,
                    wordState.color, TRACK.word, wordState.peak, letterFx, wordLetters);
    }
  }
  return ghostPanel.level > 0 || ghostShadow.level > 0;
}
