// The floating windows on a small screen (a phone, either way up).
//
// On a big screen a window may be dragged half off the edge and may run past
// the bottom, as it always could. On a small one every window is kept whole
// on the screen instead: no wider or taller than the screen less a margin,
// and pushed back inside it, so its title bar and the × at its upper right
// are always in reach. Whatever no longer fits scrolls inside the window,
// down and, for the windows laid out at a fixed width, across (the
// sequencer's and the journey's bodies, ui.scroll's contentW).
//
// fitWindow clamps the window's own saved place (st.x, st.y) in place, so a
// drag starts from where the window is seen, and leaves the fitted size in
// fit, one record reused every frame.
export const FIT_MARGIN = 8;

export function smallScreen(width, height) { return width <= 600 || height <= 500; }

export const fit = { w: 0, h: 0 };

export function fitWindow(st, width, height, winW, winH) {
  const w = Math.min(winW, width - FIT_MARGIN * 2), h = Math.min(winH, height - FIT_MARGIN * 2);
  st.x = Math.max(FIT_MARGIN, Math.min(st.x, width - w - FIT_MARGIN));
  st.y = Math.max(FIT_MARGIN, Math.min(st.y, height - h - FIT_MARGIN));
  fit.w = w; fit.h = h;
}
