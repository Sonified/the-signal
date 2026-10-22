// The hint: the opening line shown only while stopped, its sweep in, its
// release to the word smoke on a start, and its own backing. drawOverlay
// (overlay.js) steps it each frame (stepHint) and draws it last (drawHint);
// the backing machinery is shared with the word in ui/text-backing.js.
import { S } from '../../js/state.js';
import { guard } from '../../js/panel-guard.js';
import { smokeHint, hintSweepShare } from '../../core/word-fx.js';
import { TYPE, TRACK, W, MOTION } from '../theme.js';
import * as anim from '../anim.js';
import { SHADE_INK, shade, shadeMeasure, shadeShadow, panelMetrics, linePill,
         stepEnv, smooth01 } from '../text-backing.js';

// White, full strength: v0's pale blue-grey (185,198,212, #hint .hmain) read
// dimmer than the white keyboard line beneath it, the hierarchy upside down.
export const HINT_MAIN = new Float32Array([1, 1, 1, 1]);
// The two small keyboard lines, white: the faint grey ink was unreadable
// over a bright field.
const HINT_SUB = new Float32Array([1, 1, 1, 1]);

// On a touch screen the hints are two lines in the whole app and nothing
// else: 'Tap to begin' before the first start, 'Tap to resume' once a
// session has run. The keyboard line (HINT_2) never draws there.
// A follower tab draws no canvas hint at all: the DOM join gate in
// index.html ('Tap to join the live stream') is the one prompt on a
// stream link, so nothing stacks behind it.
let touchHints = false;
let followTab = false;
let everRan = false;
let HINT_1 = 'Press the space bar to begin';
export function setOverlayTouch(coarse) { touchHints = coarse; }
export function setOverlayFollow() { followTab = true; }
export function noteRun() { everRan = true; }
const HINT_2 = 'press ENTER for full screen  ·  press TAB for settings';

// The hint's own backing: the word's shadow and panel, through the same
// helpers, at fixed values that mirror Robert's tuned Text > Shadow and
// Panel, so the opening line holds its own over a bright strobing field
// whatever the words layer is set to, words off included. Not settings;
// the word's sliders never reach these. The same units as those sliders:
// opacity, blur, size and soft 0..1 of their travel, fades in ms. Panel is
// always per line (Vary per line on), and only behind the main line: the
// two small keyboard lines below it go bare.
const HINT_SHADOW_O = 0.45, HINT_SHADOW_BLUR = 0.79, HINT_SHADOW_SIZE = 0.35;
const HINT_SHADOW_IN_MS = 800, HINT_SHADOW_OUT_MS = 250;
const HINT_PANEL_O = 0.9, HINT_PANEL_SIZE = 0.33, HINT_PANEL_SOFT = 1;
// The pill is feathered to full softness, so it reads as the hint's shadow:
// its envelope must rise as gently as the letter shadow's, or the dark
// snaps in. 100 ms here was the snap behind the hint.
const HINT_PANEL_IN_MS = 800, HINT_PANEL_OUT_MS = 500;
let envHintShadow = 0, envHintPanel = 0;

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
// The smoke's release of the hint (word-smoke drives smokeHint.frontX): the
// letters still ahead of the front stay drawn here, crisp at the level the
// hint had, and each drops from this drawing as its ink enters the field.
let relOn = false, relPeak = 1, relP = 1, relWait = 0, relFront = -1e9;

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

// its counterpart during the release: gone once the front has taken a
// letter, else the arrival level it had when the smoke began, frozen
function relFx(i, n, relX, relY, wordW, size, out) {
  out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 0;
  let a = relX < relFront ? 0 : 1;
  if (a > 0 && relP < 1) {
    const span = hintEx1 - hintEx0;
    const f = span > 0 ? Math.min(1, Math.max(0, (relX - hintEx0) / span)) : 0;
    a = smooth01((relP - f * hintSws) / (1 - hintSws));
  }
  out[4] = a; out[5] = 0; out[6] = 0; out[7] = 0;
}

// and the hint at rest, every letter whole where draw() puts it, for the
// backing's passes when the letters themselves go through plain draw()
function restFx(i, n, relX, relY, wordW, size, out) {
  out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 0;
  out[4] = 1; out[5] = 0; out[6] = 0; out[7] = 0;
}

// the pill's measure during the sweep in: only the letters the front has
// brought more than halfway in count (hintToSmoke's rule), so the pill's
// dark edge rolls with the readable front instead of reaching ahead to
// letters barely begun
function hintMeasureFx(i, n, relX, relY, wordW, size, out) {
  hintFx(i, n, relX, relY, wordW, size, out);
  if (out[4] < 0.5) out[4] = 0;
}

// The hint's own sizes: the theme's xl and sm plus two points, so the centre
// lines read larger without touching any other label in the app.
const HINT_PT_MAIN = TYPE.xl + 2, HINT_PT_SUB = TYPE.sm + 2;
// The hint's lines as its draw calls below lay them: offset under the
// middle, size, weight, tracking. Only the backing reads these.
const HINT_DY = [4, 34];
const HINT_SIZE = [HINT_PT_MAIN, HINT_PT_SUB];
const HINT_WEIGHT = [W.light, W.regular];
const HINT_TRACK = [TRACK.hint, TRACK.label];
function hintLine(k) { return k === 0 ? HINT_1 : HINT_2; }

// The hint's backing, under its letters: a pill per line, then the shadow,
// each a drawWord pass through fx at level, the very walk the letters take
// (hintFx sweeping in, relFx under the smoke, restFx otherwise), so the
// shadow is each letter's own and follows its opacity exactly. The panel,
// like the word's, rides the hint's whole-line level (the spring, the all
// at once fade in, the release's frozen peak), never a letter's; its box is
// the letters shown, as the word's is, so sweeping in the pill spreads with
// the front under the arriving letters rather than standing dark ahead of
// them, and at rest it is the whole line. Each line's pads are in its own
// size's ems, as the word's are in the word's.
function drawHintBacking(dl, text, cx, cy, fx, level) {
  // Only the main line is backed: the small grey keyboard lines read
  // better bare, a dark backing only muddies them. They still bound the
  // main line's pill, so it never spreads down over them.
  const lines = touchHints ? 1 : 2, n = 1;
  // During the sweep in the pill is tied to the hint's own appearance: its
  // strength rises over the very Hint fade in the letters take (the
  // envelope's own 100 ms would stand it up dark before them), and its box
  // is measured through hintMeasureFx, so the dark edge arrives with the
  // front at the hint's speed and roll, never ahead of either.
  const sweeping = fx === hintFx && hintP < 1;
  const panelA = HINT_PANEL_O * envHintPanel * level * (sweeping ? smooth01(hintP) : 1);
  const boxFx = sweeping ? hintMeasureFx : fx;
  if (panelA > 0.002) {
    dl.pushAlpha(panelA);
    for (let k = 0; k < n; k++) {
      shadeMeasure();
      text.drawWord(dl, hintLine(k), cx, cy + HINT_DY[k], HINT_SIZE[k], HINT_WEIGHT[k],
                    SHADE_INK, HINT_TRACK[k], level, boxFx, null, shade);
      const up = k > 0 ? HINT_DY[k] - HINT_DY[k - 1] : Infinity;
      const down = k < lines - 1 ? HINT_DY[k + 1] - HINT_DY[k] : Infinity;
      panelMetrics(HINT_SIZE[k], HINT_PANEL_SIZE, HINT_PANEL_SOFT);
      linePill(dl, shade.ax0, shade.ay0, shade.ax1, shade.ay1, Math.min(up, down));
    }
    dl.popAlpha();
  }
  // The shadow backs every line, the small keyboard lines included: white
  // subtext with no dark behind it was unreadable over a bright field.
  const shadowA = HINT_SHADOW_O * envHintShadow;
  if (shadowA > 0.002) {
    for (let k = 0; k < lines; k++) {
      shadeShadow(shadowA, HINT_SHADOW_BLUR, HINT_SHADOW_SIZE, HINT_SIZE[k]);
      text.drawWord(dl, hintLine(k), cx, cy + HINT_DY[k], HINT_SIZE[k], HINT_WEIGHT[k],
                    SHADE_INK, HINT_TRACK[k], level, fx, null, shade);
    }
  }
}

// Starts an appearance. Glyphs still rasterising (the first frames after
// boot) mean not yet: the hint stays hidden and this runs again next
// frame, so the fade in never begins on letters that are not there.
function beginHintIn(text, cx, cy, t) {
  // The words are chosen as each appearance starts, so they hold steady
  // while the hint is up and the resume wording arrives only after a run.
  HINT_1 = touchHints ? (everRan ? 'Tap to resume' : 'Tap to begin')
    : (everRan ? 'Press the space bar to resume' : 'Press the space bar to begin');
  const rec = hintLay;
  let ok = text.layoutWord(HINT_1, cx, cy + 4, HINT_PT_MAIN, W.light, TRACK.hint, rec, false);
  if (!touchHints) {
    ok = text.layoutWord(HINT_2, cx, cy + 34, HINT_PT_SUB, W.regular, TRACK.label, rec, true) && ok;
  }
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
export function hintToSmoke(text, cx, cy, t) {
  if (relOn) return;   // a release in flight carries on; nothing new to send
  const h = anim.value('overlay.hint');
  if (h <= 0.002 || hintInAt < 0) return;
  hintP = hintInProgress(t); hintSws = hintSweepShare();
  const all = S.hintArrive === 'all';
  const peak = h * (all ? smooth01(hintP) : 1);
  if (peak <= 0.002) return;
  const rec = smokeHint;
  let ok = text.layoutWord(HINT_1, cx, cy + 4, HINT_PT_MAIN, W.light, TRACK.hint, rec, false);
  const nMain = rec.count;
  if (!touchHints) {
    ok = text.layoutWord(HINT_2, cx, cy + 34, HINT_PT_SUB, W.regular, TRACK.label, rec, true) && ok;
  }
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
  rec.size = HINT_PT_MAIN;
  rec.cx = cx; rec.cy = cy;
  rec.colA = HINT_MAIN; rec.colB = HINT_SUB;
  rec.req = true;
  relOn = true;
  relWait = 3;
  relPeak = peak;
  relP = all ? 1 : hintP;
  anim.reset('overlay.hint', 0);
}

// This frame's spring value, fade progress and sweep flag, stepped once by
// stepHint and read again by drawHint after the overlay's notice has drawn.
let hintH = 0, hintSweepingIn = false;

// Steps the hint's appearance, spring and backing envelopes, without
// drawing. Returns whether anything hint-side is still moving, for the
// overlay's animating flag; the emission itself is drawHint, kept separate
// so the hotkey notice draws between them exactly as it always has.
export function stepHint(text, t, dt, cx, cy) {
  // the panel guard's card sits where the hint does, so the hint makes way.
  // An appearance starts only once the last one has fully gone, and the
  // spring then only carries the yielding (and a return mid-yield).
  // Render > Hint's Show play/pause hint (S.hintShow), off: the hint is
  // never drawn, and one up as it is switched off goes at once, no fade
  const hintOff = S.hintShow === false;
  if (hintOff && (hintInAt >= 0 || anim.value('overlay.hint') > 0.002)) { anim.reset('overlay.hint', 0); hintInAt = -1; }
  const want = !S.running && !guard.noticeOpen && !followTab && !hintOff;
  // paused mid-release: the rest of the hint puffs off at once and a fresh
  // hint fades in over the smoke (one field, nothing waits)
  if (want && relOn) smokeHint.finishReq = true;
  if (want && !relOn && hintInAt < 0 && anim.value('overlay.hint') <= 0.002) beginHintIn(text, cx, cy, t);
  const h = anim.spring('overlay.hint', want && hintInAt >= 0 ? 1 : 0, MOTION.fade);
  if (!want && h <= 0.002) hintInAt = -1;
  hintP = hintInProgress(t); hintSws = hintSweepShare();
  const hintIn = hintInAt >= 0 && hintP < 1 && h > 0.002;
  // The hint's backing envelopes, as the word's: they rise over their Fade
  // in from the moment a hint is up, sink over their Fade out from the
  // moment it starts going (the smoke's release on a start, or yielding to
  // the guard's card), and an empty stage resets both for the next one.
  {
    const hintUp = relOn || (h > 0.002 && hintInAt >= 0);
    const leaving = relOn || !want;
    envHintShadow = stepEnv(envHintShadow, hintUp, leaving, dt, HINT_SHADOW_IN_MS, HINT_SHADOW_OUT_MS);
    envHintPanel = stepEnv(envHintPanel, hintUp, leaving, dt, HINT_PANEL_IN_MS, HINT_PANEL_OUT_MS);
  }
  const hintEnvMoving = (envHintShadow > 0 && envHintShadow < 1) || (envHintPanel > 0 && envHintPanel < 1);
  hintH = h; hintSweepingIn = hintIn;
  return !anim.settled('overlay.hint') || hintIn || relOn || hintEnvMoving;
}

// Draws the hint stepHint prepared: the release's frozen letters under the
// smoke, the sweep in, or the whole line at the spring's level.
export function drawHint(dl, text, cx, cy) {
  const h = hintH, hintIn = hintSweepingIn;
  if (relOn) {
    if (smokeHint.releasing) relWait = 0;
    else if (relWait > 0) relWait--;
    else relOn = false;
    if (relOn) {
      relFront = smokeHint.releasing ? smokeHint.frontX - smokeHint.cx : -1e9;
      drawHintBacking(dl, text, cx, cy, relFx, relPeak);
      text.drawWord(dl, HINT_1, cx, cy + 4, HINT_PT_MAIN, W.light, HINT_MAIN, TRACK.hint, relPeak, relFx, null);
      if (!touchHints) {
        text.drawWord(dl, HINT_2, cx, cy + 34, HINT_PT_SUB, W.regular, HINT_SUB, TRACK.label, relPeak, relFx, null);
      }
    }
  } else if (h > 0.002 && hintInAt >= 0) {
    if (hintIn && S.hintArrive !== 'all') {
      drawHintBacking(dl, text, cx, cy, hintFx, h);
      text.drawWord(dl, HINT_1, cx, cy + 4, HINT_PT_MAIN, W.light, HINT_MAIN, TRACK.hint, h, hintFx, null);
      if (!touchHints) {
        text.drawWord(dl, HINT_2, cx, cy + 34, HINT_PT_SUB, W.regular, HINT_SUB, TRACK.label, h, hintFx, null);
      }
    } else {
      const level = h * (hintIn ? smooth01(hintP) : 1);
      drawHintBacking(dl, text, cx, cy, restFx, level);
      dl.pushAlpha(level);
      text.draw(dl, HINT_1, cx, cy + 4, HINT_PT_MAIN, W.light, HINT_MAIN, 1, TRACK.hint, 1);
      if (!touchHints) {
        text.draw(dl, HINT_2, cx, cy + 34, HINT_PT_SUB, W.regular, HINT_SUB, 1, TRACK.label, 1);
      }
      dl.popAlpha();
    }
  }
}
