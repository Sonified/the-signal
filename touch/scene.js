// The scene: video feedback and the kaleidoscope, the ground every touch
// experience draws on (documents/touch-foundation.md). Canvas2D, no build,
// phone-first.
//
// Video feedback is two buffers taking turns: each frame the last frame is
// painted into the next one slightly scaled and turned about the centre,
// dimmed toward black, and the frame's new strokes are painted on top. What
// was drawn seconds ago is still travelling - outward or inward, turning,
// fading - which is the tunnel a camera pointed at its own monitor makes.
//
// The kaleidoscope duplicates the object rather than clipping wedges: every
// stroke batch is stamped SLICES times around the centre, every second
// stamp mirrored, so one finger draws a mandala and the feedback carries
// the whole figure. One stamp with slices 1.
//
// Space: strokes arrive in the unit square over a centred square of side
// min(w, h) (strokes.js); map() turns a unit point into buffer pixels.

const DPR_CAP = 2;

export function createScene(canvas) {
  const visible = canvas.getContext('2d');
  let a = document.createElement('canvas'), b = document.createElement('canvas');
  let actx = a.getContext('2d'), bctx = b.getContext('2d');
  let W = 2, H = 2, side = 2, cx = 1, cy = 1;

  const set = {
    slices: 6,
    mirror: true,
    zoom: 1.0065,      // outward a third of a percent a frame; under 1 falls inward
    spin: 0.0028,      // radians a frame
    decay: 0.965       // what a frame keeps of the last
  };
  // What this frame's strokes still have to be painted: closures taking a ctx.
  const marks = [];

  function resize() {
    const dpr = Math.min(DPR_CAP, (globalThis.devicePixelRatio || 1));
    W = Math.max(2, Math.round(canvas.clientWidth * dpr));
    H = Math.max(2, Math.round(canvas.clientHeight * dpr));
    canvas.width = W; canvas.height = H;
    for (const c of [a, b]) { c.width = W; c.height = H; }
    side = Math.min(W, H); cx = W / 2; cy = H / 2;
    for (const c of [actx, bctx]) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
  }

  const map = pt => ({ x: cx + (pt.u - 0.5) * side, y: cy + (pt.v - 0.5) * side });

  // Queues one paint (fn(ctx)) to be stamped through the kaleidoscope on
  // the next frame, into the feedback itself, so the mark trails like the
  // rest of the world.
  function stamp(fn) { marks.push(fn); }

  function frame() {
    // the last frame, dimmed, drifting
    bctx.globalAlpha = 1;
    bctx.fillStyle = '#000';
    bctx.fillRect(0, 0, W, H);
    bctx.save();
    bctx.globalAlpha = set.decay;
    bctx.translate(cx, cy);
    bctx.scale(set.zoom, set.zoom);
    bctx.rotate(set.spin);
    bctx.translate(-cx, -cy);
    bctx.drawImage(a, 0, 0);
    bctx.restore();
    // this frame's marks, each stamped around the centre
    if (marks.length) {
      const n = Math.max(1, set.slices | 0);
      for (let s = 0; s < n; s++) {
        bctx.save();
        bctx.translate(cx, cy);
        bctx.rotate(s * Math.PI * 2 / n);
        if (set.mirror && (s & 1)) bctx.scale(-1, 1);
        bctx.translate(-cx, -cy);
        for (const fn of marks) fn(bctx);
        bctx.restore();
      }
      marks.length = 0;
    }
    visible.drawImage(b, 0, 0);
    const t = a; a = b; b = t;
    const tc = actx; actx = bctx; bctx = tc;
  }

  function clear() {
    for (const c of [actx, bctx]) { c.globalAlpha = 1; c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
  }

  resize();
  return {
    set, map, stamp, frame, resize, clear,
    get side() { return side; }
  };
}
