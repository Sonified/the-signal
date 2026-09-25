// The immediate-mode UI toolkit: layout, input, and the hot/active/focus
// state machine that every widget in widgets.js is built on.
//
//   FINAL PUBLIC API
//   =================
//   import { createUI } from './imgui.js';
//   const ui = createUI(text);                 // text: lane B's text object
//
//   ui.begin(events, t, dt, width, height, dl)  // once per frame, before any layout call
//   ui.end() -> result                          // once per frame, after the last layout call
//     result is a single object this function mutates and returns every
//     frame (never a fresh one, per the no-allocation rule):
//       result.cursor      'default'|'pointer'|'grab'|'grabbing'|'ew-resize'|'text'
//       result.wantsFrames  true while a spring, a momentum scroll, or a
//                            pending tooltip is still moving, so the caller
//                            knows whether it is safe to stop driving rAF
//                            when the strobe itself is idle (it never is in
//                            practice, but a static screenshot mode wants this)
//
//   Layout (a vertical cursor with padding, inside whatever region is open):
//   ui.panel(id, x, y, w, h, glass) / ui.endPanel()
//       glass: true draws dl.glass (frosted, samples the blur capture);
//       false draws a flat dl.rect in the same tint. Both get a lineSoft
//       hairline border and no outer shadow. Pushes a clip and a padded
//       content region.
//   ui.scroll(id, h) / ui.endScroll()
//       Opens a clipped, vertically scrolling region h css px tall, wheel and
//       drag driven with momentum and rubber-band overshoot at the ends, and
//       an auto-hiding scrollbar on its right edge. Must be called inside a
//       region (a panel or the root).
//   ui.group(id, label) -> open (bool) / ui.endGroup()
//       A collapsible section: a caps-label header with a chevron that
//       rotates open, and a content area whose height springs to its
//       measured size (so it animates open and shut) while clipping its
//       content. Keep drawing children until ui.groupSettled (set by every
//       group() call, read straight after it) turns true: the section is
//       shut, its height spring has come to rest at zero, and its body has
//       been measured at least once. From then on a screen may skip the body
//       entirely for as long as that lasts; the remembered height survives
//       being skipped, so the next open does not have to remeasure blind.
//       Closing a section whose header is pinned (below) keeps the header
//       where it is: the body slides up beneath it while the scroll eases
//       back by the part of the body that was hidden above, both on the one
//       height spring, so it ends at rest in its natural place.
//       A group laid straight into a scroll region has a sticky header: once
//       the header scrolls above the viewport's top while its body is still
//       showing, it stays pinned there, drawn over its own body on a strip
//       of the enclosing pane, until the body's bottom pushes it up and out.
//       Its hit areas and ids go with it; rows under it cannot be hit.
//   ui.group(id, label, switchOn) -> open (bool)
//       The same, with an on/off switch in the header row, right-aligned
//       just left of the chevron, drawn like ui.toggle's switch. Pass the
//       section's current on/off as switchOn every frame; leave it undefined
//       (the two-argument form) for no switch. Clicking the switch flips it
//       without opening or closing the group; anywhere else on the header
//       still opens and closes. It is its own Tab stop, right after the
//       header, and Enter or Space flips it. While it is off the title dims
//       to inkDim, so a disabled section reads as one even when collapsed.
//       The toolkit does not own the value: straight after the call,
//       ui.groupSwitchChanged is true on the frame the viewer flipped it and
//       ui.groupSwitch holds the new value (always switchOn otherwise), for
//       the caller to write back to its state.
//       Groups start closed. Two optional hooks let the app remember them:
//   ui.groupInitialOpen = (id) => bool
//       Asked once per group, the first time group() sees it, with the same
//       string id the screen passed in. True starts that group open, already
//       at its full height on its very first frame with no grow animation;
//       false (or no hook at all) starts it shut, also without animating.
//   ui.onGroupToggle = (id, open) => void
//       Called when the viewer opens or closes a group (click or keyboard),
//       with the same string id and the new state, so the app can persist it.
//       Never called for the initial state above, only for a real toggle.
//   ui.beginIndent() / ui.endIndent()
//       One level of nesting inside a region: the rows laid out between the
//       two calls sit LAYOUT.childIndent further in on the left, their right
//       edge unmoved, so readouts and switches stay in line with the rows
//       around them. A toggle's row and a slider's track still take presses
//       from the region's own left edge (nextRect reports the difference as
//       ui.rIndent), so the indent narrows nothing a finger can hit. At
//       endIndent a thin guide line, a fainter and thinner cousin of a
//       group's section line, is drawn down the left of what the run laid
//       out, from its first row's top to its last row's bottom, at that
//       frame's cursor, so it grows and shrinks with rows appearing,
//       scrolling and folding and draws nothing when the run laid out
//       nothing. Inside a group it fades with the group's open state and is
//       clipped by its body like any row. Levels nest, up to MAX_INDENT.
//   ui.row(cols, gap) / ui.endRow()
//       Splits the current line into `cols` equal columns; every layout call
//       between row() and endRow() claims the next column instead of a full
//       new line. Column height is the tallest item placed in it.
//   ui.label(str, size, weight, color) -> advances the cursor one line
//   ui.spacer(h)
//   ui.setCursor(x, y, w)  // jump layout to an explicit position, e.g. chrome
//                          // drawn outside any panel flow
//   ui.cursorX / ui.cursorY / ui.regionW  (getters, current layout position)
//   ui.pointerShift  Shift was held on the latest pointer down, so a screen
//                    can tell a shift-click from a click
//   ui.textEditing   true while a ui.textField holds focus, as of the last
//                    end(); the app reads it between frames to keep global
//                    shortcuts off the keyboard while the viewer types
//
//   Widgets (installed by widgets.js onto this same object; see that file's
//   header for the full list and behaviour): ui.slider, ui.segment,
//   ui.toggle, ui.button, ui.iconButton, ui.tooltip, ui.tooltipAt,
//   ui.control, ui.textBegin, ui.textField.
//
//   Engine surface widgets.js is written against (not for screens; anything
//   below this line is the contract between imgui.js and widgets.js, both
//   lane D's own files, not a promise to callers outside ui/):
//   ui.id(name) -> number             // hash `name` (cached) combined with
//                                      // the current panel/group/scroll scope
//   ui.idx(name, salt) -> number      // ui.id(name) combined with an integer,
//                                      // for one call site drawn in a loop
//   ui.pushScope(idNum) / ui.popScope()
//   ui.nextRect(h) -> sets ui.rx, ui.ry, ui.rw, ui.rh and advances the cursor
//                     (or claims the next row column) in one call; also
//                     ui.rIndent, how far rx sits in from the region's left
//                     edge under beginIndent (0 in a row), for a widget whose
//                     hit area spans the whole line
//   ui.interact(id, x, y, w, h, disabled) -> sets ui.hover, ui.pressed,
//                     ui.clicked, ui.released, ui.dbl (read immediately after);
//                     the pointer must be inside the current clip as well as
//                     the rect, so a clipped-away widget cannot be hit
//   ui.registerFocusable(id) -> focused (bool)
//   ui.keyCount, ui.keyCode(i), ui.keyKey(i), ui.keyShift(i), ui.keyAlt(i),
//   ui.keyCtrl(i), ui.keyMeta(i), ui.keyIsDown(i)
//                                      // events this frame, for a focused widget;
//                                      // keyKey is the event's `key` (the typed
//                                      // character for a printable key)
//   ui.spring(id, target, cfg) -> value   // wraps anim.spring, tracks wantsFrames
//   ui.upper(str) -> string           // cached toUpperCase, for caps labels
//   ui.scratch0 / scratch1 / scratch2 // Float32Array(4) colour scratch
//   ui.setCursorHint(kind)
//   ui.hotId, ui.activeId, ui.focusId, ui.focusVisible, ui.pointerType
//   ui.wheelDY, ui.wheelAlt, ui.dl, ui.text, ui.t, ui.dt
//   ui.frame                          // built-frame counter, one per begin()
//   ui.slopPending                    // true while a touch press on the active
//                                      // widget has not yet travelled TOUCH_SLOP
//                                      // px, so its axis is still undecided
//
//   DEVIATIONS FROM THE ARCHITECTURE.md SKETCH (documented per the brief):
//   - ui.control(ctrl, S) takes the state object S as a second argument.
//     The Control typedef's get/set/format all take S, and ui.control has to
//     call them, so it needs S; the sketch's one-argument form had no way to
//     get one in. Screens pass the same S they already import from state.js.
//   - 450 ms tooltip delay and a handful of sizing constants (group header
//     height, scrollbar width, double-click window) are local consts here
//     and in widgets.js rather than additions to theme.js, per the brief to
//     extend nothing there.

import { COLOR, SPACE, RADIUS, TYPE, TRACK, W, MOTION, GLASS, LAYOUT } from './theme.js';
import { ICON } from './drawlist.js';
import * as anim from './anim.js';
import { installWidgets, drawSwitch, touchAware } from './widgets.js';

const FNV_OFFSET = 0x811c9dc5 | 0;
const FNV_PRIME = 0x01000193;

// Every id is folded to 31 bits, sign-extended ((h << 1) >> 1), so it is
// always a small integer (a V8 "Smi", 31 bits wide under pointer
// compression) rather than a heap-allocated number. A full unsigned 32-bit
// hash is above that range three times in four, and every such id then got
// boxed afresh each time it was passed to a Map (the spring and scroll
// tables), stored on an object or returned from a call: several 16-byte
// allocations per widget per frame, a steady trickle of garbage. The fold
// costs one bit of hash and no allocation at all.
function fnv1a(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h << 1) >> 1;
}

function combine(a, b) {
  return (Math.imul(a ^ b, FNV_PRIME) << 1) >> 1;
}

const ROOT_SCOPE = (0x9e3779b9 << 1) >> 1;   // folded to 31 bits like every id (see fnv1a)
const DBLCLICK_MS = 380;
const MAX_SCOPE_DEPTH = 32; // panel > group > scroll nesting never comes close
const MAX_FRAME_KEYS = 16;   // keydowns and keyups both count; fast typing can put several in one frame
// How far a touch press travels before the toolkit decides whether it is a
// drag on the widget under it or a scroll of the region around it. Small
// enough that a scroll feels immediate, large enough that a finger's wobble
// during a tap is not read as either.
const TOUCH_SLOP = 6;

// Group (section) header, the top level of the drawer's hierarchy. It sits on
// its own darker band, a translucent black over the glass, so a section reads
// as a section before a word of it is read; hover lifts the band with the
// usual hover wash. The title is sentence case, larger and heavier than any
// control label, in full ink. An open group also wears a thin accent bar on
// the band's left edge.
const GROUP_HEADER_H = 36;
// Dark band over the slate pane: strong enough that a section header reads
// as a header at a glance, against the near-opaque drawer body.
const GROUP_BAND = new Float32Array([0, 0, 0, 0.42]);
const GROUP_TITLE = 16;   // the card names lead the drawer, in the accent blue below
const GROUP_BAR_W = 2, GROUP_BAR_INSET = 9;   // accent bar width, and its top/bottom inset inside the band
// Spacing around a group. nextRect already leaves SPACE.xs under every row,
// the header included, so these are the amounts on top of that: the gap
// between one section and the next comes to SPACE.md, and an open body gets
// SPACE.sm of air under its header and SPACE.md under its last control. Both
// pads live inside the body, so they open and close with its animated height.
const GROUP_GAP = SPACE.md - SPACE.xs;
const GROUP_PAD_TOP = SPACE.sm;
// The thin line down an open section's left edge (see endGroup).
const SECTION_LINE_W = 1.5, SECTION_LINE_ALPHA = 0.45;
// The guide line down a run of child rows (see beginIndent): the section
// line's colour, a notch thinner and fainter so it reads as one level down.
// Its left edge sits CHILD_LINE_X in from the column the parent row starts
// in, under the stem of the parent label's first letter, and well clear of
// a child slider's knob at 0%, which reaches at most 10 px left of its track
// (childIndent - 10 = 4 px in from that column).
const CHILD_LINE_W = 1, CHILD_LINE_ALPHA = 0.3, CHILD_LINE_X = 1;
const MAX_INDENT = 4;
const GROUP_PAD_BOTTOM = SPACE.md - SPACE.xs;
const CHEVRON_SIZE = 12;
// The header's optional on/off switch: the toggle's switch (widgets.js
// drawSwitch), a size down from a toggle row's 34 by 18 so it sits quietly
// in the band beside the chevron rather than competing with the title.
const GROUP_SWITCH_W = 28, GROUP_SWITCH_H = 16;
// Sticky headers (see group()). A header pinned to the top of its scroll
// viewport sits GROUP_PIN_GAP below the viewport's edge, room for its focus
// ring, on a strip of the pane's own glass that runs the viewport's full
// width, so nothing scrolling underneath shows through beside or above it.
// Its shadow and hairline fade in over the first GROUP_PIN_FADE px of
// pinning, so a header going from scrolling to pinned never snaps.
const GROUP_PIN_GAP = 4;
const GROUP_PIN_FADE = 10;
const GROUP_PIN_SHADOW = 10, GROUP_PIN_SHADOW_ALPHA = 0.4;
// How far the shadow's casting strip reaches past the viewport on each side,
// so its left and right shadows land outside the clip and only the bottom
// one shows.
const GROUP_PIN_BLEED = GROUP_PIN_SHADOW * 3;

// One region of the vertical layout: a panel body, a group body, or a
// scroll's content. Pooled: created once per depth the app ever reaches,
// reused every frame after. Every field any kind uses is declared here, so
// all regions share one shape.
function makeRegion() {
  return { x: 0, y: 0, w: 0, cursorY: 0, top: 0, clipX: 0, clipY: 0, clipW: 0, clipH: 0, key: 0, kind: '',
           lineX: 0, lineA: 0, animH: 0, foldU: 0, glass: false, indent: 0,
           viewportX: 0, viewportY: 0, viewportW: 0, viewportH: 0 };
}

// Per-group state, one per group id for the life of the app. Beyond whether
// it is open and how tall its body measured, it carries everything the
// header needs to draw, because a pinned header is drawn in endGroup(), over
// its own body, from values group() worked out (springs are stepped once per
// frame, in group(), whichever of the two draws it).
//
// The height spring's bookkeeping lives here too. hId is its spring id;
// stepFrame and animNow let the enclosing scroll step it before layout (see
// scroll()) and group() read the same value later in the frame; animH is the
// height the body was last laid out at; sized says the body has been
// measured at least once. The fold fields describe a pinned header closing
// (see _foldStep): foldA0 is the body height when it began, foldHidden how
// far the header was pinned below its layout place, foldS how much of that
// the scroll has given back so far, and foldU how far the body is slid up
// under the header this frame.
function makeGroupState(open, hId) {
  return { open, h: 0, fresh: open, hId, stepFrame: -1, animNow: 0, animH: 0, sized: false,
           folding: false, foldA0: 0, foldHidden: 0, foldS: 0, foldU: 0,
           label: '', x: 0, y: 0, w: 0, hh: 0, swX: 0, swY: 0,
           hoverA: 0, openA: 0, swA: 1, rot: 0,
           hasSwitch: false, swOn: false, focused: false, swFocused: false,
           pinned: false, pinA: 0,
           viewX: 0, viewW: 0,
           paneKind: 0, paneX: 0, paneY: 0, paneW: 0, paneH: 0 };
}

class UI {
  constructor(text) {
    this.text = text;
    // An occluding rect (setOcclusion): while set, no widget answers the
    // pointer inside it. Floating windows use it to stack: the window behind
    // is built with the front window's rect occluded, then the front one is
    // built and drawn after it, so it is both on top and the one that answers.
    this._occOn = false; this._occX = 0; this._occY = 0; this._occW = 0; this._occH = 0;
    this.dl = null;
    this.t = 0;
    this.dt = 0;
    this.width = 0;
    this.height = 0;

    // id hashing
    this._hashCache = new Map();
    this._upperCache = new Map();
    this._scope = ROOT_SCOPE;
    this._scopeStack = new Int32Array(MAX_SCOPE_DEPTH);
    this._scopeDepth = 0;

    // layout
    this._regions = [makeRegion()];
    this._regionDepth = 0; // index of the live region; -1 has no meaning here, root always present
    this._regions[0].x = 0; this._regions[0].w = 0;
    this.rx = 0; this.ry = 0; this.rw = 0; this.rh = 0; this.rIndent = 0;
    // beginIndent's levels: where each open run's guide line goes and where
    // its first row starts. Fixed size, so nesting never allocates.
    this._indentDepth = 0;
    this._indentX = new Float32Array(MAX_INDENT);
    this._indentY = new Float32Array(MAX_INDENT);
    this.px = 0; this.py = 0; this.pw = 0;
    this._row = { active: false, cols: 1, index: 0, gap: 0, x0: 0, y0: 0, colW: 0, maxH: 0 };

    // pointer
    this.pointerX = -1; this.pointerY = -1; this.pointerType = 'mouse';
    this._pointerDown = false; this._pointerId = -1;
    this._downEvent = false; this._downConsumed = false; this._downX = 0; this._downY = 0;
    this._upEvent = false;
    // A pointercancel ends the press like an up, but it is the browser taking
    // the pointer away (a touch turned into a system gesture), not the viewer
    // letting go, so the widget under it must not count a click.
    this._cancelEvent = false;
    // Held modifiers are read off the down itself, not tracked from key
    // events, so a shift pressed while the canvas lacked focus still counts.
    this.pointerShift = false;
    this.wheelDX = 0; this.wheelDY = 0;
    // Whether Alt/Option was held on any wheel event this frame. Plain wheel
    // input always belongs to the enclosing scroll region; only Alt+wheel
    // over a slider is taken by the slider, as a fine nudge.
    this.wheelAlt = false;

    // touch slop: see TOUCH_SLOP and interact()
    this.slopPending = false; this._slopX = 0; this._slopY = 0;

    // hot/active/focus
    this.hotId = -1;
    this.activeId = -1;
    // Whether whoever holds activeId ran this frame (interact, scroll or
    // endScroll with that id). In an immediate-mode toolkit a widget that
    // stops being drawn simply stops being called, so nothing else would
    // ever let go of its press: a drawer shut mid-press left activeId on a
    // scroll that no longer ran, and since only the holder may hover or
    // claim, every widget on screen went dead. end() releases a holder that
    // was not seen, or that still holds once no pointer is down.
    this._activeSeen = false;
    this.focusId = -1;
    this.focusVisible = false;
    // Counts built frames (begin() calls; idle frames the app skips do not
    // count), so a widget can tell it was not drawn on the frame before.
    this.frame = 0;
    this._tabPressed = 0; // 0 none, 1 forward, -1 backward
    this._focusPrev = new Array(64).fill(-1);
    this._focusPrevCount = 0;
    this._focusCur = new Array(64).fill(-1);
    this._focusCurCount = 0;

    // per-widget interact result, read immediately by the caller
    this.hover = false; this.pressed = false; this.clicked = false; this.released = false; this.dbl = false;
    this._lastClickId = -1; this._lastClickTime = -1e9;

    // frame keys
    this._keyCode = new Array(MAX_FRAME_KEYS).fill('');
    this._keyKey = new Array(MAX_FRAME_KEYS).fill('');
    this._keyMeta = new Array(MAX_FRAME_KEYS).fill(false);
    this._keyShift = new Array(MAX_FRAME_KEYS).fill(false);
    this._keyAlt = new Array(MAX_FRAME_KEYS).fill(false);
    this._keyCtrl = new Array(MAX_FRAME_KEYS).fill(false);
    this._keyIsDown = new Array(MAX_FRAME_KEYS).fill(true);
    this.keyCount = 0;

    this._unsettled = false;
    this.cursorHint = 'default';
    // Text entry: widgets.js's textField marks _textSeen on every frame it
    // is drawn with focus, and end() publishes that as textEditing. It is a
    // frame late by construction, which is what the app wants: main.js
    // routes the next frame's keys before the UI is built.
    this._textSeen = false;
    this.textEditing = false;
    this._result = { cursor: 'default', wantsFrames: false };

    this._wheelConsumed = false;

    // scroll state, keyed by numeric id
    this._scrolls = new Map();

    // group persistence hooks, set by the app (see the header); null means
    // every group starts shut and toggles go unreported
    this.groupInitialOpen = null;
    this.onGroupToggle = null;
    // the header switch's report, written by every group() call and read by
    // its caller straight after (see the header)
    this.groupSwitch = false;
    this.groupSwitchChanged = false;
    // whether the group just drawn may have its body skipped (see the header)
    this.groupSettled = false;

    // colour scratch for widgets, three slots covers fill+border+glow at once
    this.scratch0 = new Float32Array(4);
    this.scratch1 = new Float32Array(4);
    this.scratch2 = new Float32Array(4);

    this._lm = { ascent: 0, descent: 0 };

    // last-interacted-widget bookkeeping, for ui.tooltip(); every widget
    // function in widgets.js writes these right before it returns.
    this._lastId = -1;
    this._lastX = 0; this._lastY = 0; this._lastW = 0; this._lastH = 0;
    this._lastHover = false;
    this._tipId = -1;
    this._tipStart = 0;

    installWidgets(this);
  }

  // ---------------- frame boundary ----------------

  begin(events, t, dt, width, height, dl) {
    this._occOn = false;
    this.dl = dl;
    this.t = t;
    this.dt = dt;
    this.width = width;
    this.height = height;
    anim.setDt(dt / 1000);

    this._scope = ROOT_SCOPE;
    this._scopeDepth = 0;
    this._regionDepth = 0;
    const root = this._regions[0];
    root.x = 0; root.y = 0; root.w = width; root.cursorY = 0; root.top = 0;
    root.clipX = 0; root.clipY = 0; root.clipW = width; root.clipH = height;
    root.kind = 'root'; root.indent = 0;
    this._indentDepth = 0;
    this.rx = 0; this.ry = 0; this.rw = width; this.rh = 0; this.rIndent = 0;
    this._row.active = false;

    this.frame++;
    this._activeSeen = false;
    this._downEvent = false;
    this._upEvent = false;
    this._cancelEvent = false;
    this._downConsumed = false;
    this.wheelDX = 0; this.wheelDY = 0; this.wheelAlt = false;
    this._wheelConsumed = false;
    this.hotId = -1;
    this.cursorHint = 'default';
    this._unsettled = false;
    this.keyCount = 0;
    this._tabPressed = 0;
    this._textSeen = false;

    // swap focus lists: last frame's "current" becomes this frame's
    // "previous" (what Tab traverses), and we start a fresh current list.
    const tmp = this._focusPrev; this._focusPrev = this._focusCur; this._focusCur = tmp;
    this._focusPrevCount = this._focusCurCount;
    this._focusCurCount = 0;

    const n = events ? events.length : 0;
    for (let i = 0; i < n; i++) {
      const e = events[i];
      switch (e.type) {
        case 'down':
          // A mouse or pen that presses again while we still think it is
          // held lost its up somewhere (capture dropped, or released outside
          // the window), so the old press is over and its holder lets go
          // before this one is handed out. A touch down may be a second
          // finger, so it is left alone.
          if (this._pointerDown && this.activeId !== -1 &&
              (e.pointerId === this._pointerId || e.pointerType !== 'touch')) this._releaseActive();
          this.pointerX = e.x; this.pointerY = e.y; this.pointerType = e.pointerType;
          this._pointerDown = true; this._pointerId = e.pointerId;
          this._downEvent = true; this._downX = e.x; this._downY = e.y;
          this._cancelEvent = false;
          this.pointerShift = e.shift;
          break;
        case 'move':
          this.pointerX = e.x; this.pointerY = e.y; this.pointerType = e.pointerType;
          break;
        case 'cancel':
          this._cancelEvent = true;
          // falls through: a cancel ends the press exactly as an up does
        case 'up':
          this.pointerX = e.x; this.pointerY = e.y;
          this._pointerDown = false;
          this._upEvent = true;
          break;
        case 'leave':
          // Pointer capture (taken on down, per the platform contract) keeps
          // a drag alive past the canvas edge, so a leave must not cancel an
          // active widget; only clear hover state when nothing is captured.
          // A leave never strands activeId either way: with no press held,
          // _pointerDown is already false and end() releases any holder.
          // (The platform does not forward `buttons`, so a leave cannot tell
          // a captured drag from a lost one; the down case above covers that.)
          if (this.activeId === -1) {
            this._pointerDown = false;
            this.pointerX = -1; this.pointerY = -1;
          }
          break;
        case 'wheel':
          this.wheelDX += e.dx; this.wheelDY += e.dy;
          if (e.alt) this.wheelAlt = true;
          this.pointerX = e.x; this.pointerY = e.y;
          break;
        case 'key':
          if (e.code === 'Tab') {
            this._tabPressed = e.shift ? -1 : 1;
          } else if (this.keyCount < MAX_FRAME_KEYS) {
            const i2 = this.keyCount++;
            this._keyCode[i2] = e.code; this._keyKey[i2] = e.key; this._keyShift[i2] = e.shift;
            this._keyAlt[i2] = e.alt; this._keyCtrl[i2] = e.ctrl; this._keyMeta[i2] = e.meta; this._keyIsDown[i2] = true;
          }
          break;
        case 'keyup':
          if (this.keyCount < MAX_FRAME_KEYS) {
            const i3 = this.keyCount++;
            this._keyCode[i3] = e.code; this._keyKey[i3] = e.key; this._keyShift[i3] = e.shift;
            this._keyAlt[i3] = e.alt; this._keyCtrl[i3] = e.ctrl; this._keyMeta[i3] = e.meta; this._keyIsDown[i3] = false;
          }
          break;
      }
    }

    if (this._tabPressed !== 0 && this._focusPrevCount > 0) {
      let idx = -1;
      for (let i = 0; i < this._focusPrevCount; i++) if (this._focusPrev[i] === this.focusId) { idx = i; break; }
      const next = idx < 0
        ? (this._tabPressed > 0 ? 0 : this._focusPrevCount - 1)
        : (idx + this._tabPressed + this._focusPrevCount) % this._focusPrevCount;
      this.focusId = this._focusPrev[next];
      this.focusVisible = true;
    }
  }

  end() {
    // The safety net (see _activeSeen in the constructor). A holder that did
    // not run this frame is gone and can never see its up; a holder still
    // set once no pointer is down (an up or cancel this frame that it did
    // not process, a claim made after the up was already read) will never
    // get another. Either way the press is released here, so a stuck id
    // costs at most one frame instead of the whole UI. A real drag (slider,
    // scroll, the mixer's title bar) runs every frame with the pointer held
    // and passes both tests.
    if (this.activeId !== -1 && (!this._activeSeen || !this._pointerDown)) this._releaseActive();
    const r = this._result;
    r.cursor = this.cursorHint;
    r.wantsFrames = this._unsettled;
    this.textEditing = this._textSeen;
    return r;
  }

  // Lets go of the current press from outside its holder, clearing the drag
  // state the toolkit itself owns. A widget's own drag state (a slider's
  // mode, the mixer's grab) resets on the next frame it sees pressed false.
  _releaseActive() {
    const st = this._scrolls.get(this.activeId);
    if (st) { st.dragging = false; st._pendingClaim = false; }
    this.activeId = -1;
    this.slopPending = false;
  }

  // ---------------- id hashing / scope ----------------

  id(name) {
    let h = this._hashCache.get(name);
    if (h === undefined) { h = fnv1a(name); this._hashCache.set(name, h); }
    return combine(this._scope, h);
  }

  idx(name, salt) {
    return combine(this.id(name), salt | 0);
  }

  pushScope(idNum) {
    this._scopeStack[this._scopeDepth++] = this._scope;
    this._scope = combine(this._scope, idNum);
  }

  popScope() {
    this._scope = this._scopeStack[--this._scopeDepth];
  }

  upper(str) {
    let u = this._upperCache.get(str);
    if (u === undefined) { u = str.toUpperCase(); this._upperCache.set(str, u); }
    return u;
  }

  // ---------------- springs / cursor hint ----------------

  spring(id, target, cfg) {
    const v = anim.spring(id, target, cfg);
    if (!anim.settled(id)) this._unsettled = true;
    return v;
  }

  setCursorHint(kind) { this.cursorHint = kind; }

  // ---------------- region / cursor ----------------

  get region() { return this._regions[this._regionDepth]; }
  get cursorX() { return this.region.x; }
  get cursorY() { return this.region.cursorY; }
  get regionW() { return this.region.w; }

  setCursor(x, y, w) {
    const reg = this.region;
    reg.x = x; reg.cursorY = y; reg.w = w;
  }

  _pushRegion(x, y, w, kind, key) {
    this._regionDepth++;
    if (this._regionDepth >= this._regions.length) this._regions.push(makeRegion());
    const reg = this._regions[this._regionDepth];
    reg.x = x; reg.y = y; reg.w = w; reg.cursorY = y; reg.top = y; reg.kind = kind; reg.key = key;
    reg.indent = 0;
    this._row.active = false;
    return reg;
  }

  _popRegion() {
    const reg = this._regions[this._regionDepth];
    this._regionDepth--;
    this._row.active = false;
    return reg;
  }

  _advance(dy) {
    this.region.cursorY += dy;
  }

  // Reports where the next nextRect(h) would land (px, py, pw) without
  // consuming it. A widget whose height depends on its own width (segment's
  // wrap decision) needs the width before it can decide what height to ask
  // for; peek() breaks that chicken-and-egg without a lookahead buffer.
  // Must be followed by nextRect() before any other layout call, since
  // nothing is committed yet.
  peek() {
    if (this._row.active) {
      const row = this._row;
      this.pw = row.colW;
      this.px = row.x0 + row.index * (row.colW + row.gap);
      this.py = row.y0;
    } else {
      const reg = this.region;
      this.pw = reg.w - reg.indent; this.px = reg.x + reg.indent; this.py = reg.cursorY;
    }
  }

  // Claims the next rect from the layout: a full-width row of height h, or
  // if a ui.row() is open, the next column of it. Sets rx/ry/rw/rh, which the
  // caller (a widget or a screen) must read before the next layout call.
  nextRect(h) {
    if (this._row.active) {
      const row = this._row;
      const i = row.index++;
      this.rx = row.x0 + i * (row.colW + row.gap);
      this.ry = row.y0;
      this.rw = row.colW;
      this.rh = h;
      this.rIndent = 0;
      if (h > row.maxH) row.maxH = h;
    } else {
      const reg = this.region;
      this.rx = reg.x + reg.indent;
      this.ry = reg.cursorY;
      this.rw = reg.w - reg.indent;
      this.rh = h;
      this.rIndent = reg.indent;
      this._advance(h + SPACE.xs);
    }
  }

  // True when a rect the toolkit is about to place is entirely outside the
  // current clip, so a scroll body can skip building glyphs for rows the
  // viewer cannot see.
  culled(x, y, w, h) {
    return this.dl.culled(x, y, w, h);
  }

  // ---------------- interaction ----------------

  // Runs the hot/active/press/click state machine for one widget rect. A
  // disabled widget still occupies layout space but never becomes hot,
  // active, or focused, and never consumes the down/up event it sits under.
  interact(id, x, y, w, h, disabled) {
    this.hover = false; this.pressed = false; this.clicked = false; this.released = false; this.dbl = false;
    // A disabled holder is not marked seen, so a widget that locks mid-press
    // lets go of it at end().
    if (disabled) return;
    if (this.activeId === id) this._activeSeen = true;
    // A widget can only be hit where it can be seen: the pointer has to be
    // inside the current clip as well as the widget's rect. A row scrolled
    // under a pinned group header, or left in the body of a closing group
    // after the clip has shut over it, is still laid out and still runs, but
    // it must not hover or take a press from whatever is drawn there now.
    const inRect = this.pointerX >= x && this.pointerX < x + w && this.pointerY >= y && this.pointerY < y + h &&
      this._pointerInClip() && !this._pointerOccluded();
    const hover = inRect && (this.activeId === -1 || this.activeId === id);
    if (hover) this.hotId = id;
    this.hover = hover;

    if (hover && this._downEvent && !this._downConsumed && this.activeId === -1) {
      this.activeId = id;
      this._activeSeen = true;
      this._downConsumed = true;
      this.focusId = id;
      this.focusVisible = false;
      this.slopPending = this.pointerType === 'touch';
      this._slopX = this._downX; this._slopY = this._downY;
    }

    // A finger that lands on a widget inside a scroll region and then moves
    // mostly vertically meant to scroll the list, not to drag or press the
    // widget. Once it has travelled TOUCH_SLOP px the axis is decided: a
    // vertical one hands the press to the enclosing scroll (the widget sees
    // no hover, press, or click from then on), a horizontal one stays with
    // the widget. Mouse and pen presses never enter this state, so a mouse
    // drag on a slider stays a slider drag in any direction.
    if (this.activeId === id && this.slopPending && this._pointerDown && !this._upEvent) {
      const sdx = this.pointerX - this._slopX, sdy = this.pointerY - this._slopY;
      if (sdx * sdx + sdy * sdy >= TOUCH_SLOP * TOUCH_SLOP) {
        this.slopPending = false;
        if (Math.abs(sdy) > Math.abs(sdx) && this._handToScroll(this._slopY)) {
          this.hover = false;
          if (this.hotId === id) this.hotId = -1;
          return false;
        }
      }
    }

    const active = this.activeId === id;
    this.pressed = active;
    if (active && this._upEvent) {
      this.slopPending = false;
      this.released = true;
      if (hover && !this._cancelEvent) {
        this.clicked = true;
        if (id === this._lastClickId && (this.t - this._lastClickTime) < DBLCLICK_MS) {
          this.dbl = true;
          this._lastClickId = -1;
        } else {
          this._lastClickId = id;
          this._lastClickTime = this.t;
        }
      }
      this.activeId = -1;
    }
    return hover;
  }

  // Whether the pointer lies inside the draw list's current clip, half open
  // like every hit rect here, so a clip shut to zero height catches nothing.
  // It reads the clip straight off the draw list's stack (see drawlist.js)
  // rather than keeping a second copy that could drift from what is drawn.
  setOcclusion(x, y, w, h) { this._occOn = w > 0 && h > 0; this._occX = x; this._occY = y; this._occW = w; this._occH = h; }
  clearOcclusion() { this._occOn = false; }
  _pointerOccluded() {
    if (!this._occOn) return false;
    const px = this.pointerX, py = this.pointerY;
    return px >= this._occX && px < this._occX + this._occW && py >= this._occY && py < this._occY + this._occH;
  }

  _pointerInClip() {
    const dl = this.dl;
    const c = dl._clip, i = (dl._clipDepth - 1) * 4;
    const px = this.pointerX, py = this.pointerY;
    return px >= c[i] && px < c[i] + c[i + 2] && py >= c[i + 1] && py < c[i + 1] + c[i + 3];
  }

  // Gives the current press to the innermost scroll region enclosing the
  // layout position, as if that scroll had claimed it on the down at downY.
  // Returns false when no scroll encloses it (a chrome button, the mixer's
  // title bar), in which case the widget keeps the press.
  // The only caller hands off with the pointer held and no up in this
  // frame's batch, so the up that ends this press is still to come and the
  // scroll, which has already run this frame, reads it on the next. The
  // scroll's endScroll later this frame marks it seen; so does this, in case
  // a caller ever runs outside a scroll body.
  _handToScroll(downY) {
    for (let d = this._regionDepth; d >= 0; d--) {
      const reg = this._regions[d];
      if (reg.kind !== 'scroll') continue;
      const st = this._scrolls.get(reg.key);
      if (!st) return false;
      this.activeId = reg.key;
      this._activeSeen = true;
      st._pendingClaim = false;
      st.dragging = true;
      st.dragStartY = downY;
      st.dragStartOffset = st.offset;
      st.lastY = this.pointerY;
      st.vel = 0;
      return true;
    }
    return false;
  }

  // Adds id to this frame's Tab order (draw order is traversal order) and
  // reports whether it currently holds keyboard focus.
  registerFocusable(id) {
    if (this._focusCurCount >= this._focusCur.length) this._focusCur.push(-1);
    this._focusCur[this._focusCurCount++] = id;
    return this.focusId === id;
  }

  keyCode(i) { return this._keyCode[i]; }
  keyKey(i) { return this._keyKey[i]; }
  keyMeta(i) { return this._keyMeta[i]; }
  keyShift(i) { return this._keyShift[i]; }
  keyAlt(i) { return this._keyAlt[i]; }
  keyCtrl(i) { return this._keyCtrl[i]; }
  keyIsDown(i) { return this._keyIsDown[i]; }

  // ---------------- layout: panel ----------------

  panel(id, x, y, w, h, glass) {
    const nid = this.id(id);
    const dl = this.dl;
    // No outer shadow. The drawer, the one panel, runs past the screen's
    // left, top and bottom, so its shadow could only ever show as a dark
    // band down its right side, cut off at the screen edges; the hairline
    // border alone ends the pane cleanly.
    if (glass) {
      dl.glass(x, y, w, h, RADIUS.lg, COLOR.paneTint, GLASS.blurMix, 1, COLOR.lineSoft, 0, 0);
    } else {
      dl.rect(x, y, w, h, RADIUS.lg, COLOR.glassTintHi, 1, COLOR.lineSoft, 0, 0);
    }
    dl.pushClip(x, y, w, h);
    this.pushScope(nid);
    const pad = SPACE.md;
    this._pushRegion(x + pad, y + pad, w - pad * 2, 'panel', nid);
    this.region.clipX = x; this.region.clipY = y; this.region.clipW = w; this.region.clipH = h;
    // remembered so a pinned group header can lay a strip of this exact pane
    // behind itself (see _groupPinBacking)
    this.region.glass = !!glass;
  }

  endPanel() {
    this._popRegion();
    this.popScope();
    this.dl.popClip();
  }

  // ---------------- layout: row ----------------

  row(cols, gap) {
    const g = gap === undefined ? SPACE.sm : gap;
    const reg = this.region;
    const row = this._row;
    row.active = true; row.cols = cols; row.index = 0; row.gap = g;
    row.x0 = reg.x + reg.indent; row.y0 = reg.cursorY;
    row.colW = (reg.w - reg.indent - g * (cols - 1)) / cols;
    row.maxH = 0;
  }

  endRow() {
    if (!this._row.active) return;
    this._advance(this._row.maxH + SPACE.xs);
    this._row.active = false;
  }

  // ---------------- layout: label / spacer ----------------

  label(str, size, weight, color) {
    const s = size === undefined ? TYPE.sm : size;
    const w = weight === undefined ? W.regular : weight;
    const col = color === undefined ? COLOR.inkDim : color;
    this.text.lineMetrics(s, this._lm);
    const lineH = this._lm.ascent + this._lm.descent;
    this.nextRect(lineH);
    if (this.culled(this.rx, this.ry, this.rw, this.rh)) return;
    const baseline = this.ry + this._lm.ascent;
    this.text.draw(this.dl, str, this.rx, baseline, s, w, col, 0, TRACK.ui, 1);
  }

  spacer(h) { this._advance(h); }

  // ---------------- layout: group ----------------

  group(id, label, switchOn) {
    const nid = this.id(id);
    this.nextRect(GROUP_HEADER_H);
    // ly is where the layout puts the header; hy is where it is drawn and
    // hit, which differs from ly only while the header is pinned (below).
    const hx = this.rx, ly = this.ry, hw = this.rw, hh = this.rh;
    const hasSwitch = switchOn !== undefined;
    let swOn = !!switchOn;
    this.groupSwitchChanged = false;

    const groups = this._groups || (this._groups = new Map());
    let g = groups.get(nid);
    if (!g) {
      // Shut unless the app says this one was left open. Either way the group
      // appears in that state rather than animating into it: the chevron and
      // accent springs are seeded at their targets, and a group starting open
      // is marked `fresh` so its first frame shows the body at full height
      // (see below and endGroup()) instead of growing from zero.
      const open = this.groupInitialOpen ? !!this.groupInitialOpen(id) : false;
      g = makeGroupState(open, combine(nid, 3));
      groups.set(nid, g);
      anim.reset(combine(nid, 2), open ? Math.PI : 0);
      anim.reset(g.hId, 0);
      anim.reset(combine(nid, 4), open ? 1 : 0);
    }

    // The body's animated height is stepped ahead of the header's input,
    // because where the header sits depends on it. A click that opens or
    // closes the group this frame retargets the spring from the next frame,
    // a frame's lag no eye can find, and in exchange the header, its hit
    // areas and the body's clip all agree on one geometry within the frame.
    // A group laid in a scroll region has usually been stepped already, by
    // scroll(), before anything was laid out (see there); it reads that
    // value rather than stepping twice.
    const hId = g.hId;
    const animH = g.stepFrame === this.frame ? g.animNow : this._stepGroupHeight(g);
    const cy = ly + hh;

    // Sticky header, the way a pinned section header works on iOS and macOS.
    // A group laid straight into a scroll region keeps its header at the top
    // of the viewport once the header itself has scrolled above it, for as
    // long as any of the body is still showing. As the body's bottom comes
    // up, the header rides up with it rather than overlapping what follows,
    // so the next section's header arrives just as this one is pushed out. A
    // collapsed group has no body to hold its header down, so it scrolls
    // away like any other row. Nested groups, and a group's very first frame
    // (its height not measured yet), never pin.
    const sreg = this.region;
    const st = sreg.kind === 'scroll' ? this._scrolls.get(sreg.key) : null;
    // Listed on its scroll so the next frame's scroll() steps it first.
    if (st) {
      if (st.groupCount >= st.groups.length) st.groups.push(g);
      else st.groups[st.groupCount] = g;
      st.groupCount++;
    }
    let hy = ly;
    if (st && !g.fresh) {
      const pinTop = sreg.viewportY + GROUP_PIN_GAP;
      const pushed = cy + animH - hh;
      const at = pushed < pinTop ? pushed : pinTop;
      if (at > ly) hy = at;
    }
    const pinned = hy > ly;

    const focused = this.registerFocusable(nid);

    // The header's own on/off switch, when it has one. It sits just left of
    // the chevron and is its own focusable, after the header in Tab order.
    // It runs its interact before the header's so it gets first refusal on
    // the press under it: a click there flips the switch and, the down being
    // consumed, never reaches the header, so the group stays as it was.
    // Both hit areas sit wherever the header is drawn, pinned or not, under
    // the same ids, so a press, a hover or a focus survives the header
    // pinning or unpinning beneath it.
    const swId = combine(nid, 5);
    const swX = hx + hw - SPACE.md - CHEVRON_SIZE / 2 - SPACE.sm - GROUP_SWITCH_W;
    const swY = hy + hh / 2 - GROUP_SWITCH_H / 2;
    let swHover = false, swFocused = false;
    if (hasSwitch) {
      swFocused = this.registerFocusable(swId);
      // The hit area is wider and taller than the pill, up to a finger's
      // width on touch, centred on it; on the right it stops at the chevron.
      const hitW = touchAware(this, GROUP_SWITCH_W + SPACE.sm * 2);
      const hitH = touchAware(this, hh);
      this.interact(swId, swX + GROUP_SWITCH_W / 2 - hitW / 2, hy + hh / 2 - hitH / 2, hitW, hitH, false);
      swHover = this.hover;
      if (swHover) this.setCursorHint('pointer');
      if (this.clicked || (swFocused && this._keyActivated())) {
        swOn = !swOn;
        this.groupSwitchChanged = true;
      }
    }
    this.groupSwitch = swOn;

    this.interact(nid, hx, hy, hw, hh, false);
    // With the pointer on the switch the header is not what a click would
    // hit, so it neither lifts nor claims the hot id.
    if (swHover) { this.hover = false; this.hotId = swId; }
    if (this.hover) this.setCursorHint('pointer');
    if (this.clicked || (focused && this._keyActivated())) {
      g.open = !g.open;
      // a toggle on the very first frame is a real toggle; animate it normally
      g.fresh = false;
      // Closing a section whose header is pinned. Folded the ordinary way the
      // header would ride up with the shrinking body and leave the top, and
      // the scroll, left where it was, would be stranded in the middle of
      // what used to be the body. Instead the header stays put and the fold
      // begins here, carried out frame by frame in _foldStep: the body slides
      // up beneath the header as its height shrinks, and the scroll gives
      // back the part that was pinned past, in proportion, so the header
      // arrives at rest in its natural place at the top with no second
      // movement. A fold already under way (closed, reopened, closed again
      // before settling) simply carries on from where it is.
      if (!g.open && pinned && !g.folding && animH > 0.5) {
        let hidden = hy - ly;
        const room = st.offset > 0 ? st.offset : 0;
        if (hidden > room) hidden = room;
        g.folding = true; g.foldA0 = animH; g.foldHidden = hidden; g.foldS = 0; g.foldU = 0;
      }
      if (this.onGroupToggle) this.onGroupToggle(id, g.open);
    }

    // Everything the header draws from, kept on the group so the drawing can
    // happen here or, while pinned, in endGroup(). Each spring is stepped
    // here, once per frame, either way.
    g.label = label; g.x = hx; g.y = hy; g.w = hw; g.hh = hh; g.swX = swX; g.swY = swY;
    g.hoverA = this.spring(combine(nid, 1), this.hover ? 1 : 0, MOTION.hover);
    // the open cue: an accent bar that fades with the open state
    g.openA = this.spring(combine(nid, 4), g.open ? 1 : 0, MOTION.hover);
    // A section switched off dims its title toward inkDim, on the switch's
    // own spring, so it reads as off even while it is collapsed.
    g.swA = hasSwitch ? this.spring(combine(nid, 6), swOn ? 1 : 0, MOTION.hover) : 1;
    // down when shut, a half turn to up when open: the accordion convention
    g.rot = this.spring(combine(nid, 2), g.open ? Math.PI : 0, MOTION.panel);
    g.hasSwitch = hasSwitch; g.swOn = swOn; g.focused = focused; g.swFocused = swFocused;
    g.pinned = pinned;

    if (pinned) {
      // Drawn in endGroup(), over the body. Its backing is a strip of the
      // pane itself across the whole viewport, so the enclosing panel is
      // noted here; its shadow fades in with how far it has pinned.
      const d = (hy - ly) / GROUP_PIN_FADE;
      g.pinA = d < 1 ? d : 1;
      g.viewX = sreg.viewportX; g.viewW = sreg.viewportW;
      g.paneKind = 0;
      for (let i = this._regionDepth - 1; i >= 0; i--) {
        const r = this._regions[i];
        if (r.kind !== 'panel') continue;
        g.paneKind = r.glass ? 2 : 1;
        g.paneX = r.clipX; g.paneY = r.clipY; g.paneW = r.clipW; g.paneH = r.clipH;
        break;
      }
    } else {
      g.pinA = 0;
      this._groupHeader(g);
    }

    // The body is clipped to its animated height as always, and while the
    // header is pinned its top starts under the header rather than at the
    // header's layout position, so rows that have scrolled beneath the
    // header are neither drawn there nor, since interact() honours the clip,
    // hoverable or pressable there. Only the clip moves: the body's region
    // still starts at cy, so it lays out and measures exactly as before.
    // A group that starts open has no measured height yet (the body is what
    // measures it, in endGroup). Rather than clip that first frame to zero and
    // flash in a frame later, its clip is left effectively unbounded (pushClip
    // intersects it with the parent's), so the body shows in full at once.
    // During a pinned fold the body's region starts foldU higher, so its
    // rows slide up under the header with the body's bottom edge rather
    // than being cut off where they stand; its size is measured the same.
    const clipTop = pinned ? hy + hh : cy;
    const clipH = cy + animH - clipTop;
    this.dl.pushClip(hx, clipTop, hw, g.fresh ? 1e6 : (clipH > 0 ? clipH : 0));
    const u = g.folding ? g.foldU : 0;
    const reg = this._pushRegion(hx, cy - u, hw, 'group', nid);
    reg.animH = animH;
    reg.foldU = u;
    reg.lineX = hx; reg.lineA = g.openA;
    this._advance(GROUP_PAD_TOP);
    this.groupSettled = !g.open && g.sized && animH === 0 && anim.settled(hId);
    return g.open || animH > 0.5;
  }

  // Steps a group's height spring for this frame and remembers the result,
  // so whichever of scroll() and group() gets there first does the stepping.
  _stepGroupHeight(g) {
    g.animNow = this.spring(g.hId, g.open ? g.h : 0, MOTION.fold);
    g.stepFrame = this.frame;
    return g.animNow;
  }

  // One frame of a pinned header's fold (see group()), given the body's
  // height a this frame; returns how far the scroll offset should come back
  // this frame. Everything is a function of a alone, so it moves on the one
  // spring and reverses exactly if the viewer reopens mid-fold.
  //
  // Let a0 be the height the fold began at and H how far the header was
  // pinned below its layout place. The scroll gives back s = H * (1 - a/a0),
  // which moves the header's layout place down by s, and the body is slid up
  // by u = a0 - a. A pinned header is drawn at the lower of its pin spot
  // and its layout place plus a (the body's bottom pushing it up). Its pin
  // spot is its starting layout place plus H, and its layout place plus a is
  // now that starting place plus s + a, which is never less than H for any a
  // in [0, a0], so it never leaves its pinned spot. The body's bottom edge, and
  // everything below it, sits at the header's bottom plus (a0 - H) * a / a0,
  // and a row of the body k px from its top sits at that bottom edge less
  // a0 - k: both fall steadily with a, together, as one block sliding up
  // under the header. At a = 0 the scroll has given back all of H, so the
  // header's layout place is where it was pinned and it lets go of the pin
  // with nothing moving.
  _foldStep(g, a) {
    const a0 = g.foldA0;
    const ac = a < a0 ? a : a0;
    const s = g.foldHidden * (1 - ac / a0);
    const d = s - g.foldS;
    g.foldS = s;
    g.foldU = a0 - ac;
    // Done: shut and at rest, or reopened back past where the fold began.
    if (g.open ? (a >= a0 || anim.settled(g.hId)) : (a === 0 && anim.settled(g.hId))) {
      g.folding = false;
      g.foldU = 0;
    }
    return d;
  }

  // Draws a group header from the state group() left on it: the band, its
  // faint top highlight (inset past the corner radius so it stays a straight
  // hairline), the hover wash over both, the open accent bar at the band's
  // current rect so it moves rigidly with it, the title, the chevron, the
  // optional switch, and the focus rings.
  _groupHeader(g) {
    const dl = this.dl;
    const hx = g.x, hy = g.y, hw = g.w, hh = g.hh;
    dl.rect(hx, hy, hw, hh, RADIUS.sm, GROUP_BAND, 0, null, 0, 0);
    dl.rect(hx + RADIUS.sm, hy, hw - RADIUS.sm * 2, 1, 0, COLOR.headHi, 0, null, 0, 0);
    if (g.hoverA > 0.001) {
      this.scratch0[0] = COLOR.hover[0]; this.scratch0[1] = COLOR.hover[1];
      this.scratch0[2] = COLOR.hover[2]; this.scratch0[3] = COLOR.hover[3] * g.hoverA;
      dl.rect(hx, hy, hw, hh, RADIUS.sm, this.scratch0, 0, null, 0, 0);
    }
    if (g.openA > 0.001) {
      this.scratch1[0] = COLOR.accent[0]; this.scratch1[1] = COLOR.accent[1];
      this.scratch1[2] = COLOR.accent[2]; this.scratch1[3] = COLOR.accent[3] * g.openA;
      dl.rect(hx, hy + GROUP_BAR_INSET, GROUP_BAR_W, hh - GROUP_BAR_INSET * 2, GROUP_BAR_W / 2,
              this.scratch1, 0, null, 0, 0);
    }
    this.text.lineMetrics(GROUP_TITLE, this._lm);
    const baseline = hy + hh / 2 + (this._lm.ascent - this._lm.descent) / 2;
    // The accent blue, dimmed while the section's own switch is off.
    let titleCol = COLOR.accent;
    if (g.hasSwitch) {
      anim.mixColor(this.scratch2, COLOR.inkDim, COLOR.accent, g.swA);
      titleCol = this.scratch2;
    }
    this.text.draw(dl, g.label, hx + SPACE.md, baseline, GROUP_TITLE, W.semibold, titleCol, 0, TRACK.ui, 1);

    this._chevron(hx + hw - SPACE.md - CHEVRON_SIZE / 2, hy + hh / 2 - CHEVRON_SIZE / 2, CHEVRON_SIZE, COLOR.ink, g.rot);

    if (g.hasSwitch) {
      drawSwitch(this, g.swX, g.swY, GROUP_SWITCH_W, GROUP_SWITCH_H, g.swA, g.swOn);
      if (g.swFocused && this.focusVisible) this._focusRing(g.swX, g.swY, GROUP_SWITCH_W, GROUP_SWITCH_H, GROUP_SWITCH_H / 2);
    }

    if (g.focused && this.focusVisible) this._focusRing(hx, hy, hw, hh, RADIUS.sm);
  }

  // What sits behind a pinned header: a soft shadow cast downward onto the
  // content scrolling beneath, then a strip of the pane across the whole
  // viewport from its top edge to the header's bottom, then a hairline. The
  // strip is the enclosing panel's own glass drawn again at the panel's own
  // rect and clipped to the strip, so the shader's top highlight, tint and
  // dither land on exactly the pixels the pane gave them: the strip is
  // invisible as a shape and simply hides what scrolled under it. Glass is
  // opaque, so nothing shows through. Drawn under the scroll's clip, which
  // also cuts the shadow's top and sides away.
  _groupPinBacking(g) {
    const dl = this.dl;
    const top = g.y - GROUP_PIN_GAP, h = g.hh + GROUP_PIN_GAP;
    const sa = GROUP_PIN_SHADOW_ALPHA * g.pinA;
    if (sa > 0.001) {
      dl.rect(g.viewX - GROUP_PIN_BLEED, top, g.viewW + GROUP_PIN_BLEED * 2, h, 0, COLOR.clear, 0, null,
              GROUP_PIN_SHADOW, sa);
    }
    dl.pushClip(g.viewX, top, g.viewW, h);
    if (g.paneKind === 2) {
      dl.glass(g.paneX, g.paneY, g.paneW, g.paneH, RADIUS.lg, COLOR.paneTint, GLASS.blurMix, 1, COLOR.lineSoft, 0, 0);
    } else if (g.paneKind === 1) {
      // a flat panel is translucent tint; its strip is the same tint made
      // opaque (glass with no frost), so the body cannot show through
      dl.glass(g.paneX, g.paneY, g.paneW, g.paneH, RADIUS.lg, COLOR.glassTintHi, 0, 1, COLOR.lineSoft, 0, 0);
    } else {
      dl.glass(g.viewX, top, g.viewW, h, 0, COLOR.paneTint, GLASS.blurMix, 0, null, 0, 0);
    }
    dl.popClip();
    if (g.pinA > 0.001) {
      this.scratch0[0] = COLOR.lineSoft[0]; this.scratch0[1] = COLOR.lineSoft[1];
      this.scratch0[2] = COLOR.lineSoft[2]; this.scratch0[3] = COLOR.lineSoft[3] * g.pinA;
      dl.rect(g.viewX, g.y + g.hh, g.viewW, 1, 0, this.scratch0, 0, null, 0, 0);
    }
  }

  endGroup() {
    const reg = this._popRegion();
    const g = this._groups.get(reg.key);
    // What the body itself drew, not counting the top pad group() added.
    const content = reg.cursorY - reg.top - GROUP_PAD_TOP;
    const measured = content > 0 ? content + GROUP_PAD_TOP + GROUP_PAD_BOTTOM : 0;
    // A screen is free to skip drawing a group's body once group() reports
    // it closed and settled; when it does, nothing ran between the push and
    // the pop and measured is 0. Overwriting g.h with that 0 would throw
    // away the real height and force a blind (briefly flashed) remeasuring
    // frame the next time it opens, every time. Only a frame that actually
    // measured something, or one the caller is treating as open, gets to
    // update the remembered height.
    if (measured > 0 || g.open) g.h = Math.max(0, measured);
    if (measured > 0) g.sized = true;
    // A group's first frame open: snap the height spring to what was just
    // measured and lay out below it at that height, so there is no grow
    // animation and nothing underneath jumps on the next frame.
    if (g.fresh) {
      g.fresh = false;
      anim.reset(g.hId, g.h);
      reg.animH = g.h;
    }
    // what this frame laid out, for the next frame's content prediction
    g.animH = reg.animH;
    this.dl.popClip();
    // The section line: the header's accent bar carried down the left edge
    // of an open body, thinner and softer, so everything beside it reads as
    // belonging to that section. It is drawn at the body's current rect and
    // animated height, and fades on the open state, so it slides and grows
    // with the section and never on its own. During a pinned fold the body
    // starts foldU above its usual top, and the line with it.
    const lineH = reg.animH + reg.foldU - GROUP_PAD_BOTTOM;
    if (reg.lineA > 0.001 && lineH > 1) {
      this._guideLine(reg.lineX + (GROUP_BAR_W - SECTION_LINE_W) / 2, reg.top, SECTION_LINE_W, lineH,
                      SECTION_LINE_ALPHA * reg.lineA);
    }
    // A pinned header is drawn last, after its body and the section line, so
    // it sits over everything that scrolls beneath it.
    if (g.pinned) {
      this._groupPinBacking(g);
      this._groupHeader(g);
    }
    this._advance(reg.animH + GROUP_GAP);
  }

  // The accent guide line both hierarchy levels draw: a group's section line
  // (endGroup) and a child run's line (endIndent). A rounded vertical bar in
  // the accent at the given share of its alpha, mixed into scratch1.
  _guideLine(x, y, w, h, alpha) {
    const c = this.scratch1;
    c[0] = COLOR.accent[0]; c[1] = COLOR.accent[1]; c[2] = COLOR.accent[2]; c[3] = COLOR.accent[3] * alpha;
    this.dl.rect(x, y, w, h, w / 2, c, 0, null, 0, 0);
  }

  // ---------------- layout: indent ----------------

  // One nesting level for the rows that follow (see the header). The line's
  // x is fixed here, from the column the parent row was laid in, and its top
  // is wherever the next row will land; the region's indent then pushes
  // every row after it in. Past MAX_INDENT a level is counted, so the calls
  // still balance, but neither indents nor draws.
  beginIndent() {
    const d = this._indentDepth++;
    if (d >= MAX_INDENT) return;
    const reg = this.region;
    this._indentX[d] = reg.x + reg.indent + CHILD_LINE_X;
    this._indentY[d] = reg.cursorY;
    reg.indent += LAYOUT.childIndent;
  }

  // Closes the innermost level and draws its line down what it laid out:
  // nextRect leaves SPACE.xs under every row, so the last row's bottom is
  // that far above the cursor. A run whose rows were all hidden this frame
  // laid out nothing and draws nothing. Inside a group the line fades with
  // the group's open state, as the section line does.
  endIndent() {
    if (this._indentDepth === 0) return;
    const d = --this._indentDepth;
    if (d >= MAX_INDENT) return;
    const reg = this.region;
    reg.indent -= LAYOUT.childIndent;
    if (reg.indent < 0) reg.indent = 0;
    const top = this._indentY[d];
    const h = reg.cursorY - SPACE.xs - top;
    const a = reg.kind === 'group' ? reg.lineA : 1;
    if (h > 1 && a > 0.001) this._guideLine(this._indentX[d], top, CHILD_LINE_W, h, CHILD_LINE_ALPHA * a);
  }

  _keyActivated() {
    for (let i = 0; i < this.keyCount; i++) {
      if (this._keyIsDown[i] && (this._keyCode[i] === 'Enter' || this._keyCode[i] === 'Space')) return true;
    }
    return false;
  }

  // A small chevron drawn from two icon calls would need a real glyph; the UI
  // renderer's ICON.CHEVRON already draws exactly this shape analytically
  // (see drawlist.js), so group() just calls it directly. Kept as a method
  // so both group() and any future disclosure widget share one call site.
  _chevron(x, y, size, color, rotation) {
    this.dl.icon(ICON.CHEVRON, x, y, size, size, color, 1.6, rotation);
  }

  _focusRing(x, y, w, h, r) {
    this.dl.rect(x - 2, y - 2, w + 4, h + 4, r + 2, COLOR.clear, 1.5, COLOR.focus, 0, 0);
  }

  // ---------------- layout: scroll ----------------

  scroll(id, h) {
    const nid = this.id(id);
    const reg = this.region;
    const x = reg.x, y = reg.cursorY, w = reg.w;
    let st = this._scrolls.get(nid);
    if (!st) {
      st = { offset: 0, vel: 0, dragging: false, dragStartY: 0, dragStartOffset: 0, contentH: 0, lastY: 0,
             _pendingClaim: false, layMax: 0, groups: [], groupCount: 0 };
      this._scrolls.set(nid, st);
    }

    // The groups laid straight into this region last frame have their height
    // springs stepped now, before anything is laid out, because the offset
    // this frame's layout uses depends on them. The content will be as tall
    // as last frame's plus whatever those heights moved by, so the end of the
    // scroll range is known before the first row is placed, and a pinned
    // header's fold hands back its share of the offset (see _foldStep). Both
    // then move on the same frame as the heights they come from, never a
    // frame behind, which is what keeps the rows below a fold from rising
    // and settling back.
    let dH = 0, give = 0;
    for (let i = 0; i < st.groupCount; i++) {
      const g = st.groups[i];
      if (g.stepFrame === this.frame) continue;
      const a = this._stepGroupHeight(g);
      dH += a - g.animH;
      if (g.folding) give += this._foldStep(g, a);
      st.groups[i] = null;
    }
    st.groupCount = 0;
    const lastMax = st.contentH > h ? st.contentH - h : 0;
    const predH = st.contentH + dH;
    const newMax = predH > h ? predH - h : 0;
    // Overshoot past the end that a drag or a fling put there; anything else
    // past the end was taken out last frame (see endScroll).
    const over = st.offset > lastMax ? st.offset - lastMax : 0;
    if (give !== 0) {
      st.offset -= give;
      st.dragStartOffset -= give;
    }

    const downInRegion = this._downEvent && !this._downConsumed && this.activeId === -1 &&
      this.pointerX >= x && this.pointerX < x + w && this.pointerY >= y && this.pointerY < y + h;

    const held = this.activeId === nid && this._pointerDown;
    if (!held) {
      // Content shrinking under the scroll (a section folding shut near the
      // end) pulls the offset in with it, on this frame, so the list stays
      // on its end the whole way. A real overshoot keeps exactly its size
      // relative to the end, for the rubber band to take in; shrinking never
      // makes a new one.
      const cap = newMax + over;
      if (st.offset > cap) st.offset = cap;
    }
    st.layMax = newMax;

    if (this.activeId === nid) {
      this._activeSeen = true;
      if (this._pointerDown) {
        const dy = this.pointerY - st.dragStartY;
        const raw = st.dragStartOffset - dy;
        st.offset = this._rubberBand(raw, predH, h);
        const frameDt = this.dt > 0 ? this.dt / 1000 : 1 / 60;
        st.vel = (st.lastY - this.pointerY) / frameDt;
        st.lastY = this.pointerY;
      }
      if (this._upEvent) {
        this.activeId = -1;
        st.dragging = false;
      }
    } else if (downInRegion) {
      st._pendingClaim = true;
      st.dragStartY = this.pointerY;
      st.dragStartOffset = st.offset;
      st.lastY = this.pointerY;
    }

    this.dl.pushClip(x, y, w, h);
    const contentReg = this._pushRegion(x, y - st.offset, w, 'scroll', nid);
    contentReg.viewportY = y; contentReg.viewportH = h; contentReg.viewportX = x; contentReg.viewportW = w;
    return st;
  }

  _rubberBand(offset, contentH, viewH) {
    const max = Math.max(0, contentH - viewH);
    if (offset < 0) return offset * 0.35;
    if (offset > max) return max + (offset - max) * 0.35;
    return offset;
  }

  endScroll() {
    const reg = this._popRegion();
    const nid = reg.key;
    const st = this._scrolls.get(nid);
    const viewY = reg.viewportY, viewH = reg.viewportH, viewX = reg.viewportX, viewW = reg.viewportW;
    st.contentH = reg.cursorY - (viewY - st.offset);
    const maxOffset = Math.max(0, st.contentH - viewH);
    // scroll() predicted this frame's height from the group springs alone. A
    // change it could not see (a row appearing or vanishing, the preset row
    // rewrapping) can still leave the offset past the real end; that is not
    // an overshoot anyone flung, so it is taken in outright, landing on the
    // next frame together with the layout change that caused it, rather than
    // left for the rubber band to spring back from. A real overshoot sat
    // past the predicted end too, and is left alone.
    if (this.activeId !== nid && st.offset > maxOffset && st.offset <= st.layMax + 0.5) st.offset = maxOffset;

    // Claim the drag that scroll() noticed but deferred, so any child widget
    // in the body got first refusal on the down event this frame. The claim
    // lands after scroll() already looked for its release, so it is only
    // taken while the pointer is still held at the end of the batch. A down
    // and up in the same batch (a trackpad tap at 120 Hz, often) was a tap
    // on empty space, not a drag: the down is still consumed, so it never
    // falls through to the field, and it catches any fling in progress, but
    // nothing holds activeId waiting for an up that has already gone by.
    if (st._pendingClaim) {
      st._pendingClaim = false;
      if (this.activeId === -1 && !this._downConsumed) {
        this._downConsumed = true;
        st.vel = 0;
        if (this._pointerDown) {
          this.activeId = nid;
          st.dragging = true;
        }
      }
    }
    if (this.activeId === nid) this._activeSeen = true;

    // Wheel and trackpad deltas arrive already in px and already carry the
    // OS's own inertia, so they move the content one-for-one, once per
    // frame (wheelDY is this frame's sum and _wheelConsumed stops an outer
    // scroll from applying it again), and zero our own momentum rather than
    // stacking on top of it. The result is clamped to the scrollable range
    // instead of rubber-banded: feeding a rubber-banded offset back through
    // _rubberBand every frame let a long trackpad fling at either end walk
    // the content ever further out while the spring-back below pulled
    // against it. The clamp never pulls an existing overshoot (left by a
    // touch fling) in with a jump; it only refuses to push further out.
    // The momentum step is skipped on a wheel frame so nothing fights the
    // wheel while it is moving.
    const inRegion = this.pointerX >= viewX && this.pointerX < viewX + viewW && this.pointerY >= viewY && this.pointerY < viewY + viewH;
    let wheeled = false;
    if (this.activeId !== nid && inRegion && this.wheelDY !== 0 && !this._wheelConsumed) {
      const lo = st.offset < 0 ? st.offset : 0;
      const hi = st.offset > maxOffset ? st.offset : maxOffset;
      const next = st.offset + this.wheelDY;
      st.offset = next < lo ? lo : next > hi ? hi : next;
      st.vel = 0;
      this._wheelConsumed = true;
      this._unsettled = true;
      wheeled = true;
    }

    if (this.activeId !== nid && !wheeled) {
      const dtS = this.dt > 0 ? this.dt / 1000 : 0;
      if (dtS > 0) {
        // The rubber band: only a real overshoot, left by a touch drag or
        // carried by a fling, is ever past an end here (content shrinking
        // under the scroll is followed in scroll() instead), and it springs
        // back in.
        if (st.offset < 0) {
          st.vel += (0 - st.offset) * MOTION.scroll.friction * 6 * dtS;
        } else if (st.offset > maxOffset) {
          st.vel += (maxOffset - st.offset) * MOTION.scroll.friction * 6 * dtS;
        }
        st.offset += st.vel * dtS;
        const decay = Math.exp(-MOTION.scroll.friction * dtS);
        st.vel *= decay;
        if (st.offset < 0 && st.offset > -0.5) { st.offset = 0; st.vel = 0; }
        if (st.offset > maxOffset && st.offset < maxOffset + 0.5) { st.offset = maxOffset; st.vel = 0; }
      }
      if (Math.abs(st.vel) > 0.02) this._unsettled = true;
    }

    this.dl.popClip();
    this._advance(viewH);

    // scrollbar
    if (st.contentH > viewH + 0.5) {
      const barW = 4;
      const trackH = viewH - 6;
      const barH = Math.max(20, trackH * (viewH / st.contentH));
      const travel = trackH - barH;
      const p = maxOffset > 0 ? Math.min(1, Math.max(0, st.offset / maxOffset)) : 0;
      const barY = viewY + 3 + travel * p;
      const active = st.dragging || Math.abs(st.vel) > 0.5 || inRegion;
      const op = this.spring(combine(nid, 9), active ? 1 : 0, MOTION.fade);
      if (op > 0.01) {
        this.scratch1[0] = COLOR.wellHi[0]; this.scratch1[1] = COLOR.wellHi[1];
        this.scratch1[2] = COLOR.wellHi[2]; this.scratch1[3] = COLOR.wellHi[3] * op;
        this.dl.rect(viewX + viewW - barW - 2, barY, barW, barH, barW / 2, this.scratch1, 0, null, 0, 0);
      }
    }
  }
}

export function createUI(text) {
  return new UI(text);
}
