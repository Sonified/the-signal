// A phone or tablet. The primary pointer being coarse is the signal: it is
// true of every phone and tablet, iPads included (whose Safari calls itself
// a Mac), and false of a laptop with a touchscreen, whose primary pointer
// is still its trackpad. The user agent backs it up where matchMedia is
// missing. The core count is no help: browsers round or cap it for privacy,
// and plenty of desktops have few.
//
// Kept apart from Heart's transport (js/heart/engine.js, which asks it for
// its lookahead) so the audio modules can ask too without loading Heart.
export function handheld(g = globalThis) {
  try { if (g.matchMedia?.('(pointer: coarse)').matches) return true; } catch (err) { /* no media queries */ }
  return /iPhone|iPad|iPod|Android/i.test(g.navigator?.userAgent || '');
}

// The answer for this session, taken once, so every room built and every
// readout drawn agrees for as long as the page is open. A worker has no
// media queries, only the user agent, which an iPad's Safari words as a
// Mac's, so the engine thread is told the page's own pointer as well
// (noteHandheld, from main.js with the platform's coarseness).
let known = null;
export const onPhone = () => known ?? (known = handheld());
export function noteHandheld(coarse) { if (coarse) known = true; }
