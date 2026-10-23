// Tap or drag: what a press on the bare field turns out to be. A press is
// only a candidate when it lands; once it has travelled more than
// TAP_SLOP_PX from where it went down it is a drag for good (the brush
// draws, core/brush.js), and its release is the drag's end, never a tap. A
// release that never went past it is the tap it always was (run and stop,
// or putting the drawer away, main.js). A cancel ends either cleanly, with
// no tap. Mouse, touch and pen alike.
//
// The threshold is meditatewiththesun.com's (solarmeditation/site/main.js,
// its touch tap test: a touch whose end lies more than 14 px from its start,
// Math.hypot, is a drag and does not toggle the sun), so a hand that knows
// the one page knows the other. Here the test runs as the press moves, not
// only at its end, so a stroke that wanders back near its start is still a
// stroke.
//
// Pure: tapDragStep reads one step of a press and moves the state object it
// is handed; no clock, no DOM. The caller feeds it once a frame (the
// pointer's place while the field holds the press), and on the release
// frame a 'move' to the release point before the 'up', so a flick that went
// down and up between two frames still counts its travel.

export const TAP_SLOP_PX = 14;

export const TD_NONE = 0;      // nothing happening
export const TD_PENDING = 1;   // pressed, not yet a drag
export const TD_START = 2;     // this step made it a drag: draw from (x0, y0) to here
export const TD_MOVE = 3;      // a drag, moving on
export const TD_TAP = 4;       // let go without ever passing the threshold
export const TD_END = 5;       // a drag let go
export const TD_CANCEL = 6;    // the press was cancelled; a drag in it ends, nothing taps

export function createTapDrag() {
  return { phase: 0, x0: 0, y0: 0 };   // phase: 0 idle, 1 candidate, 2 drag
}

// type: 'down' | 'move' | 'up' | 'cancel'; x, y in css px.
export function tapDragStep(st, type, x, y) {
  if (type === 'down') {
    st.phase = 1; st.x0 = x; st.y0 = y;
    return TD_PENDING;
  }
  if (st.phase === 0) return TD_NONE;
  if (type === 'move') {
    if (st.phase === 2) return TD_MOVE;
    if (Math.hypot(x - st.x0, y - st.y0) > TAP_SLOP_PX) { st.phase = 2; return TD_START; }
    return TD_PENDING;
  }
  const was = st.phase;
  st.phase = 0;
  if (type === 'up') return was === 2 ? TD_END : TD_TAP;
  return TD_CANCEL;
}
