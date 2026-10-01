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
import { letterFx, wordLetters, lineCtx, smokeHint, hintSweepShare, wordFxWhole } from '../../core/word-fx.js';
import { guard } from '../../../js/panel-guard.js';
import { COLOR, TYPE, TRACK, W, MOTION } from '../theme.js';
import * as anim from '../anim.js';
import { STRIDE } from '../drawlist.js';

const VEIL = new Float32Array([0, 0, 0, 1]);
const HINT_MAIN = new Float32Array([185 / 255, 198 / 255, 212 / 255, 1]);   // v0 #hint .hmain
const REVEAL_MS = 2000;

// On a touch screen the hints are two lines in the whole app and nothing
// else: 'Tap to begin' before the first start, 'Tap to resume' once a
// session has run. The keyboard lines (HINT_2, HINT_3) never draw there.
// A follower tab draws no canvas hint at all: the DOM join gate in
// index.html ('Tap to join the live stream') is the one prompt on a
// stream link, so nothing stacks behind it.
let touchHints = false;
let followTab = false;
let everRan = false;
let HINT_1 = 'Press the space bar to begin';
export function setOverlayTouch(coarse) { touchHints = coarse; }
export function setOverlayFollow() { followTab = true; }
const HINT_2 = 'press the “~” key for settings  ·  press ENTER for full screen';
const HINT_3 = 'T for words  ·  C for color';

// The word's line box depends only on its size (font metrics, not ink), so
// it is asked for again only when the size changes. lineMetrics sets a font
// string and measures, which leaves garbage behind, and the word is on
// screen for most frames of a session.
const lm = { ascent: 0, descent: 0 };
let lmSize = -1;

// The word's backing (Text > Shadow, Shadow blur, Panel), for letters that
// have to hold their own over a busy scene. Both are black, both sit under
// the letters, and both are off at 0, so a first visit looks as it always
// has. The shadow is each letter again, directly behind itself: it darkens
// what shows through a soft or faint letter and haloes its edge. The panel is
// a rounded block filled in behind the letters as they arrive. Each is its
// own pass of text-atlas's drawWord with this record as its shade, through
// the very letterFx the word itself goes through, so neither can drift from
// a transition; the record is reused every frame, never rebuilt.
const SHADE_INK = new Float32Array([0, 0, 0, 1]);
const PANEL_FILL = new Float32Array([0, 0, 0, 1]);
const shade = {
  alpha: 0, soft: 0, dilate: 0, measure: false,
  ax0: 0, ay0: 0, ax1: 0, ay1: 0,
  dx0: 0, dy0: 0, dx1: 0, dy1: 0
};
// Softness the shadow always carries, so even behind an opaque letter it
// reaches past the glyph's edge. The shadow is drawn from the atlas's far
// copies (gpu/text-atlas.js FAR_RANGE), whose field reaches 44 of 64 atlas
// px past the ink; the glyph shader lets dilation and softness together use
// 0.9 of that, about 0.62 em at any size, dilation first. Shadow size grows
// the outline by up to SHADOW_SIZE_EM, and Shadow blur softens the grown
// edge by up to SHADOW_SOFT_CAP_EM, both at once inside that reach, so
// neither slider ever runs into the other's share. The blur's travel is
// spread from the spread to its cap, so every step of it softens the shadow
// further; a word too small to have any headroom past the spread gets none,
// never a negative.
const SHADOW_SPREAD = 1.5;
const SHADOW_SOFT_CAP_EM = 0.3;
const SHADOW_SIZE_EM = 0.3;
// The panel's margin past the letters: Panel size runs it from a sliver to
// the full pad; the corner radius rides the pad so a small panel squares
// off rather than swallowing itself in its own corners. Soft edges swap the
// hard rect for the shader's Gaussian of the same box (shadeRect's
// erf shadow, already black), up to half an em of blur; the pad grows by
// half the blur so the softened edge stays centred where the hard one was.
const PANEL_PAD_EM = 0.6, PANEL_PAD_MIN_EM = 0.08, PANEL_RADIUS_EM = 0.35;
const PANEL_SOFT_MAX_EM = 1.5;

function unit(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }

// The panel's box: every line's shown letters, where each one comes to rest,
// widened by the pad. Shown means the letter's own opacity is above nothing,
// or, while the smoke or the cloud draws the word, that its dissolve has
// begun to give it back; so the panel spreads with the arrival, draws in
// with the leaving, and is gone with the last letter. Its strength rides the
// word's fade and the layer's first rise, never the Opacity slider, which is
// the letters' own.
// One panel box: the hard rect, or the slab once the blur is real.
function panelBox(dl, x0, y0, x1, y1, padX, padY, radius, blur) {
  if (blur >= 1) {
    dl.slab(x0 - padX, y0 - padY, x1 - x0 + 2 * padX, y1 - y0 + 2 * padY, radius, blur, 1);
  } else {
    dl.rect(x0 - padX, y0 - padY, x1 - x0 + 2 * padX, y1 - y0 + 2 * padY, radius, PANEL_FILL, 0, null, 0, 0);
  }
}
// The panel's measures at one text size (Panel size and Soft edges, 0..1),
// into this record, reused every frame. Shared by the word and the hint.
const pm = { blur: 0, pad: 0, radius: 0 };
function panelMetrics(size, sizeAmt, soft) {
  pm.blur = soft * PANEL_SOFT_MAX_EM * size;
  pm.pad = (PANEL_PAD_MIN_EM + sizeAmt * (PANEL_PAD_EM - PANEL_PAD_MIN_EM)) * size + pm.blur * 0.5;
  pm.radius = pm.pad * (PANEL_RADIUS_EM / PANEL_PAD_EM);
}
// One line's pill at pm's measures. With neighbours above or below, the
// vertical pad stops at the line's own slot (slotH, its distance to them;
// Infinity for a line alone, which keeps the full pad), so the pills stay
// apart instead of stacking dark on dark where they'd overlap.
function linePill(dl, x0, y0, x1, y1, slotH) {
  if (!(x1 > x0) || !(y1 > y0)) return;
  const padY = Math.min(pm.pad, Math.max(1, (slotH - (y1 - y0)) * 0.5));
  panelBox(dl, x0, y0, x1, y1, pm.pad, padY, Math.min(pm.radius, (y1 - y0) * 0.5 + padY), pm.blur);
}
// Vary per line keeps a box per drawn line rather than the one union
// (captured in drawOverlay's measure loop): a pill per line, each as wide
// as its own letters ask.
const LINE_BOX_MAX = 16;
const LINE_BOXES = new Float32Array(LINE_BOX_MAX * 4);
let lineBoxN = 0;
function drawPanel(dl, size, strength, sizeAmt, soft, perLine, lineH) {
  const f = wordState.peak > 0 ? wordState.opacity / wordState.peak : 0;
  const a = strength * f * wordState.reveal;
  if (a <= 0.002) return;
  panelMetrics(size, sizeAmt, soft);
  dl.pushAlpha(a);
  if (perLine) {
    const slotH = lineBoxN > 1 ? lineH : Infinity;
    for (let i = 0; i < lineBoxN; i++) {
      const o = i * 4;
      linePill(dl, LINE_BOXES[o], LINE_BOXES[o + 1], LINE_BOXES[o + 2], LINE_BOXES[o + 3], slotH);
    }
  } else {
    let x0 = shade.ax0, y0 = shade.ay0, x1 = shade.ax1, y1 = shade.ay1;
    if (!(x1 > x0) && wordFxWhole()) { x0 = shade.dx0; y0 = shade.dy0; x1 = shade.dx1; y1 = shade.dy1; }
    if (x1 > x0 && y1 > y0) panelBox(dl, x0, y0, x1, y1, pm.pad, pm.pad, pm.radius, pm.blur);
  }
  dl.popAlpha();
}

// shade set up for a measure pass: nothing drawn, both bounds emptied
function shadeBounds() {
  shade.ax0 = shade.ay0 = shade.dx0 = shade.dy0 = Infinity;
  shade.ax1 = shade.ay1 = shade.dx1 = shade.dy1 = -Infinity;
}
function shadeMeasure() {
  shade.alpha = 0; shade.soft = 0; shade.dilate = 0; shade.measure = true;
  shadeBounds();
}
// shade set up for a shadow pass at one text size (Shadow blur and size, 0..1)
function shadeShadow(alpha, blur, sizeAmt, size) {
  shade.alpha = alpha; shade.measure = false;
  shade.soft = SHADOW_SPREAD + blur * Math.max(0, SHADOW_SOFT_CAP_EM * size - SHADOW_SPREAD);
  // Shadow size grows each dark letter's outline outward, the same
  // distance past every edge, and the blur then softens that grown edge.
  shade.dilate = sizeAmt * SHADOW_SIZE_EM * size;
}

// The backing's fade envelopes (see their block in drawOverlay), and the
// last frame's clock for their step. leaving is the text's own going (the
// word's phase 2, the hint's release or yielding): with a Fade out set the
// envelope sinks over it from that moment.
let envShadow = 0, envPanel = 0, envLastT = -1;
function stepEnv(env, onStage, leaving, dt, inMs, outMs) {
  if (!onStage) return 0;
  if (leaving && outMs > 0) return Math.max(0, env - dt / outMs);
  return inMs > 0 ? Math.min(1, env + dt / inMs) : 1;
}

// The word's backing outliving its word. Drawn live, the shadow is each
// letter again at that letter's own opacity and the panel rides the word's
// fade and the letters shown, so either can only last as long as the
// letters do, whatever its Fade out says. So every frame the word is up and
// not yet leaving, each pass's draw records are copied out (snap); the
// frame it starts leaving (or vanishes, or its switch goes off) that copy
// becomes the ghost, frozen at rest, and is replayed under everything at a
// level sinking from 1 over the effect's own Fade out, the word gone or not.
// The live pass steps aside meanwhile, its envelope back at 0, so a next
// word's backing rises from nothing while the last one's fades. Two buffers
// each, swapped as a ghost starts, so a new word's snaps never overwrite a
// ghost still on screen. At Fade out 0 nothing is kept and the backing
// follows the word as before.
function makeGhost() {
  return { snap: new Float32Array(64 * STRIDE), snapN: 0, fresh: false,
           ghost: new Float32Array(64 * STRIDE), ghostN: 0, level: 0 };
}
const ghostPanel = makeGhost(), ghostShadow = makeGhost();
function ghostSnap(g, dl, from) {
  const n = dl.count - from;
  if (n * STRIDE > g.snap.length) g.snap = new Float32Array(n * STRIDE * 2);
  g.snap.set(dl.data.subarray(from * STRIDE, dl.count * STRIDE));
  g.snapN = n; g.fresh = true;
}
// going: the word is leaving or gone, or this effect is off
function ghostStep(g, going, dt, outMs) {
  if (going && g.fresh) {
    g.fresh = false;
    if (outMs > 0 && g.snapN > 0) {
      const b = g.ghost; g.ghost = g.snap; g.snap = b;
      g.ghostN = g.snapN; g.snapN = 0; g.level = 1;
      return;
    }
  }
  // still up: this frame's live pass snaps afresh, or there is nothing to keep
  if (!going) g.fresh = false;
  if (g.level > 0) g.level = outMs > 0 ? Math.max(0, g.level - dt / outMs) : 0;
}
function ghostDraw(g, dl) {
  if (g.level <= 0.002) return;
  dl.pushAlpha(g.level);
  dl.replay(g.ghost, g.ghostN);
  dl.popAlpha();
}

// The hint's own backing: the word's shadow and panel, through the same
// helpers, at fixed values that mirror Robert's tuned Text > Shadow and
// Panel, so the opening line holds its own over a bright strobing field
// whatever the words layer is set to, words off included. Not settings;
// the word's sliders never reach these. The same units as those sliders:
// opacity, blur, size and soft 0..1 of their travel, fades in ms. Panel is
// always per line (Vary per line on): a pill for each line of the hint, the
// one line on a phone, the main line and its two keyboard lines elsewhere.
const HINT_SHADOW_O = 0.3, HINT_SHADOW_BLUR = 0.79, HINT_SHADOW_SIZE = 0.35;
const HINT_SHADOW_IN_MS = 400, HINT_SHADOW_OUT_MS = 250;
const HINT_PANEL_O = 0.9, HINT_PANEL_SIZE = 0.33, HINT_PANEL_SOFT = 1;
const HINT_PANEL_IN_MS = 100, HINT_PANEL_OUT_MS = 500;
let envHintShadow = 0, envHintPanel = 0;

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
// The smoke's release of the hint (word-smoke drives smokeHint.frontX): the
// letters still ahead of the front stay drawn here, crisp at the level the
// hint had, and each drops from this drawing as its ink enters the field.
let relOn = false, relPeak = 1, relP = 1, relWait = 0, relFront = -1e9;

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

// The hint's lines as its draw calls below lay them: offset under the
// middle, size, weight, tracking. Only the backing reads these.
const HINT_DY = [4, 34, 52];
const HINT_SIZE = [TYPE.xl, TYPE.sm, TYPE.sm];
const HINT_WEIGHT = [W.light, W.regular, W.regular];
const HINT_TRACK = [TRACK.hint, TRACK.label, TRACK.label];
function hintLine(k) { return k === 0 ? HINT_1 : k === 1 ? HINT_2 : HINT_3; }

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
  const n = touchHints ? 1 : 3;
  const panelA = HINT_PANEL_O * envHintPanel * level;
  if (panelA > 0.002) {
    dl.pushAlpha(panelA);
    for (let k = 0; k < n; k++) {
      shadeMeasure();
      text.drawWord(dl, hintLine(k), cx, cy + HINT_DY[k], HINT_SIZE[k], HINT_WEIGHT[k],
                    SHADE_INK, HINT_TRACK[k], level, fx, null, shade);
      const up = k > 0 ? HINT_DY[k] - HINT_DY[k - 1] : Infinity;
      const down = k < n - 1 ? HINT_DY[k + 1] - HINT_DY[k] : Infinity;
      panelMetrics(HINT_SIZE[k], HINT_PANEL_SIZE, HINT_PANEL_SOFT);
      linePill(dl, shade.ax0, shade.ay0, shade.ax1, shade.ay1, Math.min(up, down));
    }
    dl.popAlpha();
  }
  const shadowA = HINT_SHADOW_O * envHintShadow;
  if (shadowA > 0.002) {
    for (let k = 0; k < n; k++) {
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
  if (touchHints) HINT_1 = everRan ? 'Tap to resume' : 'Tap to begin';
  const rec = hintLay;
  let ok = text.layoutWord(HINT_1, cx, cy + 4, TYPE.xl, W.light, TRACK.hint, rec, false);
  if (!touchHints) {
    ok = text.layoutWord(HINT_2, cx, cy + 34, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
    ok = text.layoutWord(HINT_3, cx, cy + 52, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
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
function hintToSmoke(text, cx, cy, t) {
  if (relOn) return;   // a release in flight carries on; nothing new to send
  const h = anim.value('overlay.hint');
  if (h <= 0.002 || hintInAt < 0) return;
  hintP = hintInProgress(t); hintSws = hintSweepShare();
  const all = S.hintArrive === 'all';
  const peak = h * (all ? smooth01(hintP) : 1);
  if (peak <= 0.002) return;
  const rec = smokeHint;
  let ok = text.layoutWord(HINT_1, cx, cy + 4, TYPE.xl, W.light, TRACK.hint, rec, false);
  const nMain = rec.count;
  if (!touchHints) {
    ok = text.layoutWord(HINT_2, cx, cy + 34, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
    ok = text.layoutWord(HINT_3, cx, cy + 52, TYPE.sm, W.regular, TRACK.label, rec, true) && ok;
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
  rec.size = TYPE.xl;
  rec.cx = cx; rec.cy = cy;
  rec.colA = HINT_MAIN; rec.colB = COLOR.inkFaint;
  rec.req = true;
  relOn = true;
  relWait = 3;
  relPeak = peak;
  relP = all ? 1 : hintP;
  anim.reset('overlay.hint', 0);
}

export function drawOverlay(dl, text, t, width, height) {
  const inset = S.edgeInset || 0;
  const cx = inset + (width - inset) / 2, cy = height / 2;

  // veil: fully black until the first start, then a linear two-second lift.
  if (S.running && revealAt < 0) revealAt = t;
  if (S.running) everRan = true;
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
  // The backing's own fades, an envelope per effect: it rises over the Fade
  // in as a word arrives and, with a Fade out set, hands over to its ghost
  // the moment the word starts leaving (wordState.phase 2), which sinks over
  // the Fade out whether the word is still there or not. At 0 either simply
  // follows the word as before. An empty stage resets both, so the next
  // word's backing fades in from nothing.
  const dt = envLastT < 0 ? 0 : Math.min(100, t - envLastT);
  envLastT = t;
  const wordUp = wordState.visible && wordState.peak > 0.002 && !!wordState.text;
  const leaving = wordState.phase === 2;
  const shadowOutMs = S.textShadowFadeOutMs || 0, panelOutMs = S.textPanelFadeOutMs || 0;
  const shadowStage = S.textShadowOn !== false && wordUp;
  const panelStage = S.textPanelOn !== false && wordUp;
  // a Fade out hands the leaving to the ghost, so the live envelope drops out
  envShadow = stepEnv(envShadow, shadowStage && !(leaving && shadowOutMs > 0), leaving, dt,
    S.textShadowFadeInMs || 0, shadowOutMs);
  envPanel = stepEnv(envPanel, panelStage && !(leaving && panelOutMs > 0), leaving, dt,
    S.textPanelFadeInMs || 0, panelOutMs);
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
    const panelO = S.textPanelOn !== false ? unit(S.textPanelO || 0) * envPanel : 0;
    const shadowO = S.textShadowOn !== false ? unit(S.textShadowO || 0) * envShadow : 0;
    if (panelO > 0.002) {
      // Vary per line remeasures per line, a box each; otherwise the one
      // union across the block. Either way each line takes its dissolve
      // box when the smoke or the cloud holds all its letters at nothing.
      const from = dl.count;
      shadeMeasure();
      const perLine = S.textPanelPerLine === true;
      lineBoxN = 0;
      for (let k = 0; k < n; k++) {
        if (perLine) shadeBounds();
        lineCtx.k = k;
        text.drawWord(dl, ph.lines[k], cx, baseY + (k - (n - 1) / 2) * ph.lineH, size, W.light,
                      SHADE_INK, TRACK.word, wordState.peak, letterFx, null, shade);
        if (perLine && lineBoxN < LINE_BOX_MAX) {
          let bx0 = shade.ax0, by0 = shade.ay0, bx1 = shade.ax1, by1 = shade.ay1;
          if (!(bx1 > bx0) && wordFxWhole()) { bx0 = shade.dx0; by0 = shade.dy0; bx1 = shade.dx1; by1 = shade.dy1; }
          const o = lineBoxN * 4;
          LINE_BOXES[o] = bx0; LINE_BOXES[o + 1] = by0; LINE_BOXES[o + 2] = bx1; LINE_BOXES[o + 3] = by1;
          lineBoxN++;
        }
      }
      drawPanel(dl, size, panelO, unit(S.textPanelSize ?? 1), unit(S.textPanelSoft || 0), perLine, ph.lineH);
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

  // the panel guard's card sits where the hint does, so the hint makes way.
  // An appearance starts only once the last one has fully gone, and the
  // spring then only carries the yielding (and a return mid-yield).
  const want = !S.running && !guard.noticeOpen && !followTab;
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

  const ghostMoving = ghostPanel.level > 0 || ghostShadow.level > 0;
  overlayState.animating = (veil > 0.001 && veil < 1) || !anim.settled('overlay.hint') || noticeLive || hintIn || relOn || hintEnvMoving || ghostMoving;
  if (relOn) {
    if (smokeHint.releasing) relWait = 0;
    else if (relWait > 0) relWait--;
    else relOn = false;
    if (relOn) {
      relFront = smokeHint.releasing ? smokeHint.frontX - smokeHint.cx : -1e9;
      drawHintBacking(dl, text, cx, cy, relFx, relPeak);
      text.drawWord(dl, HINT_1, cx, cy + 4, TYPE.xl, W.light, HINT_MAIN, TRACK.hint, relPeak, relFx, null);
      if (!touchHints) {
        text.drawWord(dl, HINT_2, cx, cy + 34, TYPE.sm, W.regular, COLOR.inkFaint, TRACK.label, relPeak, relFx, null);
        text.drawWord(dl, HINT_3, cx, cy + 52, TYPE.sm, W.regular, COLOR.inkFaint, TRACK.label, relPeak, relFx, null);
      }
    }
  } else if (h > 0.002 && hintInAt >= 0) {
    if (hintIn && S.hintArrive !== 'all') {
      drawHintBacking(dl, text, cx, cy, hintFx, h);
      text.drawWord(dl, HINT_1, cx, cy + 4, TYPE.xl, W.light, HINT_MAIN, TRACK.hint, h, hintFx, null);
      if (!touchHints) {
        text.drawWord(dl, HINT_2, cx, cy + 34, TYPE.sm, W.regular, COLOR.inkFaint, TRACK.label, h, hintFx, null);
        text.drawWord(dl, HINT_3, cx, cy + 52, TYPE.sm, W.regular, COLOR.inkFaint, TRACK.label, h, hintFx, null);
      }
    } else {
      const level = h * (hintIn ? smooth01(hintP) : 1);
      drawHintBacking(dl, text, cx, cy, restFx, level);
      dl.pushAlpha(level);
      text.draw(dl, HINT_1, cx, cy + 4, TYPE.xl, W.light, HINT_MAIN, 1, TRACK.hint, 1);
      if (!touchHints) {
        text.draw(dl, HINT_2, cx, cy + 34, TYPE.sm, W.regular, COLOR.inkFaint, 1, TRACK.label, 1);
        text.draw(dl, HINT_3, cx, cy + 52, TYPE.sm, W.regular, COLOR.inkFaint, 1, TRACK.label, 1);
      }
      dl.popAlpha();
    }
  }
}
