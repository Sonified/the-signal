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
import { letterFx, wordLetters, lineCtx, smokeHint, hintSweepShare } from '../../core/word-fx.js';
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
let wasRunning = false;

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

// The hint's appearance (Render > Hint fade in, Hint arrive), at boot and on
// every pause, on its own clock rather than the fade spring's pace; the
// spring is snapped to full as it begins and is left only the hint's
// yielding to the guard's card. Left to right sends a soft front across the
// letters by the same maths as the smoke out's sweep: the front spends
// hintSweepShare of the fade crossing the ink, and each letter then fades
// in over what remains after its place along the way. The layout is taken
// once per appearance, into this reused record, only for the ink's extent;
// the letters draw each frame through drawWord, which lands every letter
// fx leaves in place on draw()'s exact pixels. The extent is kept relative
// to the view's middle, so a drawer sliding mid fade in carries it along.
const hintLay = { count: 0, seed: 0, data: new Float32Array(128 * 12) };
let hintInAt = -1;               // t the current appearance began, -1 while none is on
let hintEx0 = 0, hintEx1 = 0;    // the first and last letter centres, from the view's middle
let hintP = 1, hintSws = 0.25;   // this frame's fade in progress and front share, for hintFx

function smooth01(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

function hintInProgress(t) {
  if (hintInAt < 0) return 0;
  const ms = Math.max(0, S.hintFadeInMs ?? 2000);
  return ms > 0 ? Math.min(1, Math.max(0, (t - hintInAt) / ms)) : 1;
}

// one letter's fade in, from its centre's x relative to the view's middle
function letterIn(relX) {
  if (hintP >= 1) return 1;
  const span = hintEx1 - hintEx0;
  const f = span > 0 ? Math.min(1, Math.max(0, (relX - hintEx0) / span)) : 0;
  return smooth01((hintP - f * hintSws) / (1 - hintSws));
}

// drawWord's per-letter hook for the sweep in: opacity only, nothing moves
function hintFx(i, n, relX, relY, wordW, size, out) {
  out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 0;
  out[4] = letterIn(relX); out[5] = 0; out[6] = 0; out[7] = 0;
}

// Starts an appearance. Glyphs still rasterising (the first frames after
// boot) mean not yet: the hint stays hidden and this runs again next
// frame, so the fade in never begins on letters that are not there.
function beginHintIn(text, cx, cy, t) {
  const rec = hintLay;
  let ok = text.layoutWord(HINT_1, cx, cy + 4, TYPE.xl, W.light, TRACK.hint, rec, false);
  ok = text.layoutWord(HINT_2, cx, cy + 34, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
  ok = text.layoutWord(HINT_3, cx, cy + 52, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
  if (!ok) return;
  let x0 = Infinity, x1 = -Infinity;
  for (let j = 0; j < rec.count; j++) {
    const x = rec.data[j * 12];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  hintEx0 = x0 - cx; hintEx1 = x1 - cx;
  hintInAt = t;
  anim.reset('overlay.hint', 1);
}

// Hands the hint to the word smoke (gpu/word-smoke.js) on a start:
// its three lines laid out exactly where draw() puts them (layoutWord walks
// the same pen and pixel snap), each letter tagged with its line's ink, and
// the fade spring snapped to zero so the plain fade never runs on top. The
// smoke picks the letters up later this same frame, so there is no gap and
// no overlap. A hint already hidden (the guard's card up) has nothing to
// dissolve, and one whose glyphs are somehow not ready keeps the plain fade.
// A start caught mid fade in dissolves what had arrived: all at once, the
// whole hint at the level it reached; left to right, only the letters the
// front had brought more than halfway in.
function hintToSmoke(text, cx, cy, t) {
  const h = anim.value('overlay.hint');
  if (h <= 0.002 || hintInAt < 0) return;
  hintP = hintInProgress(t); hintSws = hintSweepShare();
  const all = S.hintArrive === 'all';
  const peak = h * (all ? smooth01(hintP) : 1);
  if (peak <= 0.002) return;
  const rec = smokeHint;
  let ok = text.layoutWord(HINT_1, cx, cy + 4, TYPE.xl, W.light, TRACK.hint, rec, false);
  const nMain = rec.count;
  ok = text.layoutWord(HINT_2, cx, cy + 34, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
  ok = text.layoutWord(HINT_3, cx, cy + 52, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
  if (!ok) return;
  for (let j = nMain; j < rec.count; j++) rec.data[j * 12 + 9] = 1;
  if (!all && hintP < 1) {
    const d = rec.data;
    let k = 0;
    for (let j = 0; j < rec.count; j++) {
      if (letterIn(d[j * 12] - cx) < 0.5) continue;
      if (k !== j) d.copyWithin(k * 12, j * 12, j * 12 + 12);
      k++;
    }
    rec.count = k;
    if (!k) return;
  }
  rec.peak = peak;
  rec.size = TYPE.xl;
  rec.cx = cx; rec.cy = cy;
  rec.colA = HINT_MAIN; rec.colB = COLOR.inkFaint;
  rec.req = true;
  anim.reset('overlay.hint', 0);
}

export function drawOverlay(dl, text, t, width, height) {
  const inset = S.edgeInset || 0;
  const cx = inset + (width - inset) / 2, cy = height / 2;

  // veil: fully black until the first start, then a linear two-second lift.
  if (S.running && revealAt < 0) revealAt = t;
  // Every start with the hint on screen sends it off as smoke, the first
  // and each resume alike. hintToSmoke does nothing when the hint is
  // already gone (the guard's card up), and a hint caught mid fade-in
  // dissolves from the level it had reached.
  if (S.running && !wasRunning) hintToSmoke(text, cx, cy, t);
  wasRunning = S.running;
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

  // the panel guard's card sits where the hint does, so the hint makes way.
  // An appearance starts only once the last one has fully gone, and the
  // spring then only carries the yielding (and a return mid-yield).
  const want = !S.running && !guard.noticeOpen;
  if (want && hintInAt < 0 && anim.value('overlay.hint') <= 0.002) beginHintIn(text, cx, cy, t);
  const h = anim.spring('overlay.hint', want && hintInAt >= 0 ? 1 : 0, MOTION.fade);
  if (!want && h <= 0.002) hintInAt = -1;
  hintP = hintInProgress(t); hintSws = hintSweepShare();
  const hintIn = hintInAt >= 0 && hintP < 1 && h > 0.002;
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

  overlayState.animating = (veil > 0.001 && veil < 1) || !anim.settled('overlay.hint') || noticeLive || hintIn;
  if (h > 0.002 && hintInAt >= 0) {
    if (hintIn && S.hintArrive !== 'all') {
      text.drawWord(dl, HINT_1, cx, cy + 4, TYPE.xl, W.light, HINT_MAIN, TRACK.hint, h, hintFx, null);
      text.drawWord(dl, HINT_2, cx, cy + 34, TYPE.sm, W.regular, COLOR.inkFaint, TRACK.label, h, hintFx, null);
      text.drawWord(dl, HINT_3, cx, cy + 52, TYPE.sm, W.regular, COLOR.inkFaint, TRACK.label, h, hintFx, null);
    } else {
      dl.pushAlpha(h * (hintIn ? smooth01(hintP) : 1));
      text.draw(dl, HINT_1, cx, cy + 4, TYPE.xl, W.light, HINT_MAIN, 1, TRACK.hint, 1);
      text.draw(dl, HINT_2, cx, cy + 34, TYPE.sm, W.regular, COLOR.inkFaint, 1, TRACK.label, 1);
      text.draw(dl, HINT_3, cx, cy + 52, TYPE.sm, W.regular, COLOR.inkFaint, 1, TRACK.label, 1);
      dl.popAlpha();
    }
  }
}
