// The chrome: the burger, the transport, the quick bar and the full-screen
// button, all floating over the field.
//
// Every piece here sits directly on the strobe, so every piece is drawn on
// GLASS, which is opaque to it: the frost comes from the last lit frame, so a
// chip never pulses with the field underneath (ARCHITECTURE rule 1). That is
// also why these are drawn here rather than with the toolkit's button, whose
// chip fill is translucent and was designed for use inside a glass panel.
//
// The frost is not free, though. Any frosted pane on screen keeps the engine
// refreshing the blur capture, a six-pass chain that starts from a full
// resolution read, and these chips are up whenever the pointer moves. So
// while the drawer and the mixer are both shut the chips are flat opaque
// tint (the same GLASS instance at blurMix 0, which needs no capture at all),
// and they frost over on a spring as either window opens, when a capture is
// being taken for that window anyway. `frost` is that spring, 0 to 1.
//
// Layout mirrors v0 so muscle memory carries: burger top left, play and mute
// top right, the quick bar along the bottom right, read right to left. The
// whole set fades out once the pointer settles, as v0's body.idle did, and
// never while the drawer is open.
//
// The panel guard's notice lives here too (drawGuardNotice, at the end): a
// frosted card in the middle of the field, on the top layer, shown when
// js/panel-guard.js has paused the strobe to protect the display.
import { S } from '../../../js/state.js';
import { guard } from '../../../js/panel-guard.js';
import { byId } from '../../core/schema.js';
import { runAction, actionLabel } from '../widgets.js';
import { ICON } from '../drawlist.js';
import { COLOR, TYPE, TRACK, W, RADIUS, LAYOUT, MOTION, GLASS } from '../theme.js';
import { mixColor } from '../anim.js';

const QUICK = [   // right to left after the full-screen button, with v0's min widths
  ['colorQuick', 118], ['textQuick', 86], ['clickQuick', 112], ['toneQuick', 86],
  ['visualQuick', 132], ['musicQuick', 94], ['ambQuick', 112]
];
const QUICK_CTRL = QUICK.map(q => byId(q[0]));
// When the bar is wider than the room left of the full-screen button, chips
// are left out in this order (indices into QUICK) until the rest fit. The
// atmosphere chip is not on the list: it is the only way to the mixer from
// the bar, so it is the last to go. Words and colour go first because T and
// C still reach them from the keyboard.
const QUICK_DROP = [1, 0, 2, 3, 4, 5];
// Per-frame scratch for the fit, allocated once: each chip's label, width,
// and whether it is shown this frame.
const quickLabel = new Array(QUICK.length).fill('');
const quickW = new Float32Array(QUICK.length);
const quickShown = new Uint8Array(QUICK.length);
const CHIP_H = LAYOUT.chipH, GAP = 8, EDGE = LAYOUT.chromeInset;
const ink = new Float32Array(4);
const hoverFill = new Float32Array([1, 1, 1, 0]);

// A glass chip with a centred label. Returns true on click.
function chip(ui, key, label, x, y, w, h, frost) {
  const id = ui.id(key);
  ui.interact(id, x, y, w, h, false);
  if (ui.hover) ui.setCursorHint('pointer');
  const hv = ui.spring(ui.idx(key, 1), ui.hover ? 1 : 0, MOTION.hover);
  const pr = ui.spring(ui.idx(key, 2), ui.pressed ? 1 : 0, MOTION.press);
  const dl = ui.dl;
  dl.glass(x, y, w, h, RADIUS.md, COLOR.glassTint, frost, 1, hv > 0.5 ? COLOR.lineStrong : COLOR.line, 0, 0);
  hoverFill[3] = hv * 0.05 + pr * 0.06;
  if (hoverFill[3] > 0.002) dl.rect(x, y, w, h, RADIUS.md, hoverFill, 0, null, 0, 0);
  mixColor(ink, COLOR.inkDim, COLOR.ink, hv);
  ui.text.draw(dl, label, x + w / 2, y + h / 2 + 4, TYPE.sm, W.regular, ink, 1, TRACK.label, 1);
  return ui.clicked;
}

// Same glass, an icon instead of a label.
function glassIcon(ui, key, icon, x, y, size, round, frost) {
  const id = ui.id(key);
  ui.interact(id, x, y, size, size, false);
  if (ui.hover) ui.setCursorHint('pointer');
  const hv = ui.spring(ui.idx(key, 1), ui.hover ? 1 : 0, MOTION.hover);
  const r = round ? size / 2 : RADIUS.md;
  ui.dl.glass(x, y, size, size, r, COLOR.glassTint, frost, 1, hv > 0.5 ? COLOR.lineStrong : COLOR.line, 0, 0);
  mixColor(ink, COLOR.inkDim, COLOR.ink, hv);
  const pad = size * 0.28;
  ui.dl.icon(icon, x + pad, y + pad, size - pad * 2, size - pad * 2, ink, 1.7, 0);
  return ui.clicked;
}

// ---------- volume, top right ----------
// v0's #tpVol: a plain white speaker that mutes (the Audio layer, through
// vmute) and a 120px track beside it that drags the master volume (through
// 'vol'), so the corner and the drawer can never disagree. Neither sits on
// glass: both are steady ink, which never strobes.
const VOL_W = 120, VOL_H = 7, VOL_HIT = 27, VOL_GAP = 10, SPK = 34;
const VOL_CTRL = byId('vol'), MUTE_CTRL = byId('vmute');
const spkInk = new Float32Array([0.949, 0.949, 0.949, 1]);
const volWell = new Float32Array([1, 1, 1, 0.15]);
const volFill = new Float32Array(4);

function drawVolume(ui, spkX, trackX, cy) {
  const dl = ui.dl;
  const on = MUTE_CTRL ? !!MUTE_CTRL.get(S) : true;

  const sid = ui.id('chrome.vmute');
  ui.interact(sid, spkX - 3, cy - SPK / 2, SPK + 6, SPK, false);
  const spkHover = ui.hover;
  if (spkHover) ui.setCursorHint('pointer');
  if (ui.clicked && MUTE_CTRL) MUTE_CTRL.set(S, on ? 0 : 1);

  // a press anywhere on the track jumps there, and dragging follows it
  const tid = ui.id('chrome.vol');
  ui.interact(tid, trackX, cy - VOL_HIT / 2, VOL_W, VOL_HIT, false);
  const trackHover = ui.hover;
  if (trackHover) ui.setCursorHint('pointer');
  if (VOL_CTRL && ui.pressed && ui.activeId === tid && ui.pointerX >= 0) {
    const pos = Math.round(Math.min(1, Math.max(0, (ui.pointerX - trackX) / VOL_W)) * 100);
    if (pos !== VOL_CTRL.get(S)) VOL_CTRL.set(S, pos);
  }

  // v0 sat the cluster at .85 and lifted it to full on hover
  const hv = ui.spring(ui.idx('chrome.vol', 1), spkHover || trackHover || ui.activeId === tid ? 1 : 0, MOTION.hover);
  dl.pushAlpha(0.85 + 0.15 * hv);
  const g = 0.949 + 0.051 * hv;
  spkInk[0] = g; spkInk[1] = g; spkInk[2] = g;
  dl.icon(on ? ICON.SPEAKER : ICON.MUTE, spkX, cy - SPK / 2, SPK, SPK, spkInk, 2.3, 0);

  const ty = cy - VOL_H / 2;
  dl.rect(trackX, ty, VOL_W, VOL_H, 2, volWell, 0, null, 0, 0);
  const v = VOL_CTRL ? VOL_CTRL.get(S) / 100 : 0;
  const fw = VOL_W * v;
  if (fw > 0.5) {
    // v0's fill ran #d6d6d6 to #f2f2f2 along the track; one flat grey at the
    // middle of the part that shows, dimmed to .25 while muted as v0 did
    const c = 0.839 + 0.11 * v * 0.5;
    volFill[0] = c; volFill[1] = c; volFill[2] = c; volFill[3] = on ? 1 : 0.25;
    dl.rect(trackX, ty, fw, VOL_H, Math.min(2, fw / 2), volFill, 0, null, 0, 0);
  }
  dl.popAlpha();
}

// The burger lives on the top layer so it stays above the open drawer.
export function drawBurger(ui, app, alpha, frost) {
  if (alpha < 0.01) return;
  ui.dl.pushAlpha(alpha);
  if (glassIcon(ui, 'chrome.burger', S.panelOpen ? ICON.CLOSE : ICON.BURGER, 14, 14, LAYOUT.burger, false, frost)) app.toggleDrawer();
  ui.dl.popAlpha();
}

export function drawChrome(ui, app, alpha, frost) {
  if (alpha < 0.01) return;
  const dl = ui.dl, width = app.width, height = app.height;
  dl.pushAlpha(alpha);

  // transport, top right, as v0 laid it out: play/pause, then the speaker,
  // then the volume track at the far right
  const ts = 38, ty = EDGE;
  const trackX = width - EDGE - VOL_W, spkX = trackX - VOL_GAP - SPK;
  if (glassIcon(ui, 'chrome.play', S.running ? ICON.PAUSE : ICON.PLAY, spkX - 14 - ts, ty, ts, true, frost)) app.toggleRun();
  drawVolume(ui, spkX, trackX, ty + ts / 2);

  // quick bar, bottom right, read right to left
  const y = height - EDGE - CHIP_H;
  let x = width - EDGE - CHIP_H;
  if (glassIcon(ui, 'chrome.fs', app.fullscreenActive() ? ICON.CONTRACT : ICON.EXPAND, x, y, CHIP_H, false, frost)) app.toggleFullscreen();
  // Measure every chip, then leave out the least needed ones until the rest
  // fit between the full-screen button and the drawer's edge, so a narrow
  // window loses a lesser chip rather than the one that opens the mixer.
  let need = 0;
  for (let i = 0; i < QUICK.length; i++) {
    const ctrl = QUICK_CTRL[i];
    quickShown[i] = ctrl ? 1 : 0;
    if (!ctrl) continue;
    const label = actionLabel(ui, ctrl, S, false);
    quickLabel[i] = label;
    quickW[i] = Math.max(QUICK[i][1], ui.text.measure(label, TYPE.sm, W.regular) + 26);
    need += GAP + quickW[i];
  }
  const room = x - ((S.edgeInset || 0) + EDGE);
  for (let d = 0; d < QUICK_DROP.length && need > room; d++) {
    const i = QUICK_DROP[d];
    if (quickShown[i]) { quickShown[i] = 0; need -= GAP + quickW[i]; }
  }
  for (let i = 0; i < QUICK.length; i++) {
    if (!quickShown[i]) continue;
    const w = quickW[i];
    x -= GAP + w;
    if (x < (S.edgeInset || 0) + EDGE) break;          // never under the open drawer
    const ctrl = QUICK_CTRL[i];
    if (chip(ui, QUICK[i][0], quickLabel[i], x, y, w, CHIP_H, frost)) { runAction(ctrl, S); actionLabel(ui, ctrl, S, true); }
  }

  dl.popAlpha();
}

// ---------- the panel guard's notice ----------
// Shown after js/panel-guard.js has paused the strobe because every flash was
// landing on the same half of the display's refresh cycle, and after either
// check in js/display-watch.js has paused it (the window changed screens, or
// the engine's clock and the page's disagree), with that check's own title
// and text in the same card. It is drawn only
// while stopped, so it never sits over a running strobe, and it goes on OK,
// on Escape (main.js), or on the next start, which with the same setting
// simply trips again.
//
// The text arrives once, on the trip, and is wrapped into lines only when it
// arrives or the card's width changes; every other frame draws the stored
// lines, so the card allocates nothing while it is up.
const GN_MAX_W = 440, GN_PAD_X = 28, GN_PAD_Y = 24;
const GN_TITLE = TYPE.lg, GN_BODY = TYPE.md;
const GN_TITLE_LH = 22, GN_BODY_LH = 19, GN_GAP = 10;
const gn = { title: '', body: '', note: '', wrapW: -1, lines: [], kinds: [], h: 0 };

export function openGuardNotice(msg) {
  gn.title = msg.title; gn.body = msg.body; gn.note = msg.note;
  gn.wrapW = -1;
  guard.noticeOpen = true;
}

function wrapGuard(text, str, size, weight, maxW, kind) {
  const words = str.split(' ');
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? line + ' ' + words[i] : words[i];
    if (line && text.measure(next, size, weight) > maxW) {
      gn.lines.push(line); gn.kinds.push(kind);
      line = words[i];
    } else line = next;
  }
  if (line) { gn.lines.push(line); gn.kinds.push(kind); }
}

function layoutGuard(text, maxW) {
  gn.wrapW = maxW;
  gn.lines.length = 0; gn.kinds.length = 0;
  wrapGuard(text, gn.title, GN_TITLE, W.semibold, maxW, 0);
  wrapGuard(text, gn.body, GN_BODY, W.regular, maxW, 1);
  if (gn.note) wrapGuard(text, gn.note, GN_BODY, W.regular, maxW, 2);
  let h = GN_PAD_Y;
  for (let i = 0; i < gn.kinds.length; i++) {
    const k = gn.kinds[i];
    if (i > 0 && k !== gn.kinds[i - 1]) h += GN_GAP;
    h += k === 0 ? GN_TITLE_LH : GN_BODY_LH;
  }
  gn.h = h + GN_GAP + 8 + CHIP_H + GN_PAD_Y;
}

// Called first in the UI build, on the top layer, so it has the first claim on
// the pointer: its button, then the whole card, which swallows a click so a
// press on the card never reaches the field and starts the strobe behind it.
export function drawGuardNotice(ui, app) {
  const open = guard.noticeOpen && !S.running;
  const a = ui.spring('guard.notice', open ? 1 : 0, MOTION.fade);
  if (a < 0.01) return;
  const width = app.width, height = app.height, inset = S.edgeInset || 0;
  const w = Math.min(GN_MAX_W, width - inset - 32);
  if (w < 120) return;
  const maxW = w - GN_PAD_X * 2;
  if (maxW !== gn.wrapW) layoutGuard(ui.text, maxW);
  const x = inset + (width - inset - w) / 2;
  const y = Math.max(16, (height - gn.h) / 2);
  const dl = ui.dl;

  dl.pushAlpha(a);
  dl.glass(x, y, w, gn.h, RADIUS.lg, COLOR.paneTint, 1, 1, COLOR.line, GLASS.shadow, GLASS.shadowAlpha);
  let ly = y + GN_PAD_Y;
  for (let i = 0; i < gn.lines.length; i++) {
    const k = gn.kinds[i];
    if (i > 0 && k !== gn.kinds[i - 1]) ly += GN_GAP;
    const lh = k === 0 ? GN_TITLE_LH : GN_BODY_LH;
    const size = k === 0 ? GN_TITLE : GN_BODY;
    const col = k === 0 ? COLOR.ink : (k === 2 ? COLOR.warn : COLOR.inkDim);
    ui.text.draw(dl, gn.lines[i], x + GN_PAD_X, ly + lh * 0.72, size, k === 0 ? W.semibold : W.regular, col, 0, TRACK.tight, 1);
    ly += lh;
  }
  const by = y + gn.h - GN_PAD_Y - CHIP_H;
  if (chip(ui, 'guard.ok', 'OK', x + GN_PAD_X, by, w - GN_PAD_X * 2, CHIP_H, 1)) guard.noticeOpen = false;
  // once put away it lets go of the pointer at once, fade or no fade
  if (open) ui.interact(ui.id('guard.card'), x, y, w, gn.h, false);
  dl.popAlpha();
}
