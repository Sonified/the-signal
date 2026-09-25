// Design tokens for v1.
//
// Every colour, size, radius and timing the UI uses comes from here, so the
// look can be tuned in one place and so no widget ever builds a colour per
// frame. Colours are Float32Array(4), straight alpha, sRGB, frozen by
// convention: never write into one. The toolkit mixes into its own scratch
// colours when it animates.
//
// The palette carries v0's identity forward (the same ink, dim ink, hairline
// and cornflower accent) and adds what v0 could not afford: real glass, soft
// shadows, and a glow on the accent. The glass tint is dark and cool so a
// panel reads as a pane over the field rather than a box on top of it.

const c = (r, g, b, a = 1) => { const v = new Float32Array(4); v[0] = r / 255; v[1] = g / 255; v[2] = b / 255; v[3] = a; return v; };

export const FONT = 'ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif';

export const W = { light: 300, regular: 400, semibold: 600, bold: 700 };

// Type scale, css px. `word` is the centre-screen word, as v0.
export const TYPE = { micro: 10, xs: 10.5, sm: 11.5, md: 13, lg: 15, xl: 19, word: 35 };

// Letter spacing in em, as v0's stylesheet uses.
export const TRACK = { tight: 0, ui: 0.02, label: 0.04, caps: 0.13, hint: 0.06, word: 0.07 };

export const SPACE = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };

export const RADIUS = { xs: 4, sm: 6, md: 9, lg: 14, pill: 999 };

// Touch targets follow the platform guideline; mouse targets can be tighter.
export const HIT = { touch: 44, mouse: 28 };

export const COLOR = {
  // text
  ink:        c(232, 237, 242),        // v0 --ui-text
  inkDim:     c(139, 151, 163),        // v0 --ui-dim
  inkFaint:   c(91, 102, 114),         // v0 hint sub-line
  inkOnAccent: c(8, 16, 28),

  // structure
  line:       c(34, 42, 51),           // v0 --ui-line
  lineSoft:   c(255, 255, 255, 0.06),  // glass edge highlight
  lineStrong: c(58, 69, 81),           // v0 hover border

  // surfaces
  glassTint:  c(12, 16, 22, 0.78),     // chips and small glass
  paneTint:   c(17, 22, 29, 0.87),     // the settings drawer: mostly opaque, with enough frost left that it still belongs to the field
  headHi:     c(255, 255, 255, 0.12),  // section header top highlight
  glassTintHi: c(17, 21, 26, 0.70),    // chips and small buttons
  well:       c(255, 255, 255, 0.04),  // slider track, segment background
  wellHi:     c(255, 255, 255, 0.08),
  hover:      c(255, 255, 255, 0.06),
  press:      c(255, 255, 255, 0.10),

  // accent
  accent:     c(110, 168, 254),        // v0 --ui-accent
  accentSoft: c(110, 168, 254, 0.22),
  accentGlow: c(110, 168, 254, 0.45),

  // status
  warn:       c(224, 164, 76),         // v0 #warn
  good:       c(98, 215, 170),         // v0 atmosphere power light
  focus:      c(110, 168, 254, 0.85),

  shadow:     c(0, 0, 0, 1),
  clear:      c(0, 0, 0, 0)
};

export const GLASS = {
  blurMix: 1,          // how much frost; 0 is a flat tinted pane
  shadow: 28,          // outer shadow radius, css px
  shadowAlpha: 0.45
};

// Motion. Springs rather than eased tweens so an interrupted animation (hover
// off halfway through hover on) carries its velocity instead of snapping.
export const MOTION = {
  hover:  { stiffness: 520, damping: 38 },
  press:  { stiffness: 900, damping: 50 },
  panel:  { stiffness: 260, damping: 30 },   // drawer, mixer
  // A group's body height. The panel's stiffness, so a section folds at the
  // pace the drawer slides, but just past critical damping (2 * sqrt(260) is
  // about 32.2) and integrated monotone (see anim.js): the whole list below a
  // section flows from this number, so it must arrive without overshooting.
  fold:   { stiffness: 260, damping: 34, monotone: true },
  fade:   { stiffness: 180, damping: 26 },   // chrome idle fade
  scroll: { friction: 5.5 }                   // momentum decay per second
};

// Layout constants that mirror v0's so muscle memory carries over.
export const LAYOUT = {
  drawerW: 340,              // v0 #panel width
  drawerPadTop: 70,
  drawerPadX: 20,
  chromeInset: 16,           // distance of corner chrome from the edges
  // How far a child row (a control whose schema `parent` is the toggle or
  // segment above it) sits in from its parent, per level; see imgui.js
  // beginIndent. Only the label, track and knob column moves: the right edge,
  // where readouts and switches sit, stays aligned with every other row.
  childIndent: 14,
  chipH: 38,                 // quick-bar buttons
  burger: 42,
  idleMs: 1000               // chrome idle fade delay (v0 used 1000 in js/ui.js, 2200 here before)
};
