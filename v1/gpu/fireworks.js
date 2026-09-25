// The Fireworks layer: shows that arrive on their own, out from the centre
// of the visible field. Three presets (S.fwMode): Scatter sends one shell at
// a time toward one of the four corners, bursting on the way, its sparks
// falling down the screen. Four corners sends four identical shells at once,
// symmetric about the centre, and Centre out bursts deep in the middle; in
// both of those gravity pulls toward the viewer, so the sparks come at you.
//
// There is no simulation pass and no per-spark state anywhere. Every shell,
// ember and spark moves on a closed form of its show's age (see
// fireworks.wgsl.js), so the CPU's whole job is scheduling: when the next
// show arrives, which corner it heads for, where it bursts and in what
// pattern. Each frame it writes one small uniform block (the view and the
// shows still in the air) and the draw is one instanced call.
//
// The layer keeps its own clock, which runs only while the strobe runs, so a
// stopped scene holds every show exactly where it is. Switching the layer
// off clears the sky; switching it back on brings the first show in half a
// second later.
//
// Nothing is made until the layer is first switched on, and nothing is
// allocated per frame after that.

import { S } from '../../js/state.js';
import { FIREWORKS_WGSL, PER_SHOW, MAX_SHOWS, SHOW_FLOATS, UNIFORM_FLOATS, LIFE_BASE } from './fireworks.wgsl.js';

const RECIPES = LIFE_BASE.length;
// The first show after switching on.
const FIRST_DELAY = 0.5;
// The shortest gap between two shows, however high How often is set.
const MIN_GAP = 0.2;
// The deep presets. A deep shell starts this far down the tunnel (depth 1
// is the screen's own scale). Four corners bursts at depth 1, where the
// screen positions mean what they say, and pulls gently toward the viewer.
// Centre out bursts deeper, pulls harder and drags less, so its sparks
// reach the viewer's side of every edge before they fade.
const SHELL_FROM = 4;
const CORNERS_GRAVITY = 0.3;
const CENTRE_DEPTH = 1.8, CENTRE_GRAVITY = 0.9, CENTRE_LIFE = 1.4, CENTRE_SHELL_FROM = 5, CENTRE_DRAG = 0.55;

const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v)) ? (v < lo ? lo : v > hi ? hi : v) : def;

export function createFireworks(device, format) {
  let pixelW = 1, pixelH = 1, dpr = 1;
  let made = false;
  let uniBuf = null, pipe = null, bind = null;
  const uni = new Float32Array(UNIFORM_FLOATS);

  // The shows, one slot each: whether it is in the air, the clock time it
  // launched, the age past which nothing of it is left, and its floats as
  // the shader reads them (age and colour are filled in per frame).
  const live = new Uint8Array(MAX_SHOWS);
  const launchAt = new Float64Array(MAX_SHOWS);
  const endAge = new Float64Array(MAX_SHOWS);
  const data = new Float32Array(MAX_SHOWS * SHOW_FLOATS);

  let clock = 0, nextAt = 0, wasOn = false, lastCorner = -1, drawCount = 0;

  function make() {
    made = true;
    uniBuf = device.createBuffer({ label: 'fireworks.uniforms', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mod = device.createShaderModule({ label: 'fireworks.wgsl', code: FIREWORKS_WGSL });
    if (mod.getCompilationInfo) {
      mod.getCompilationInfo().then(info => {
        if (info.messages.some(m => m.type === 'error')) {
          console.warn('fireworks.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
        }
      });
    }
    const bgl = device.createBindGroupLayout({
      label: 'fireworks.bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
    });
    // Pure light: added to whatever is beneath, alpha untouched.
    const add = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    };
    pipe = device.createRenderPipeline({
      label: 'fireworks.draw',
      layout: device.createPipelineLayout({ label: 'fireworks.layout', bindGroupLayouts: [bgl] }),
      vertex: { module: mod, entryPoint: 'vsFire' },
      fragment: { module: mod, entryPoint: 'fsFire', targets: [{ format, blend: add }] },
      primitive: { topology: 'triangle-list' }
    });
    bind = device.createBindGroup({
      label: 'fireworks.bind', layout: bgl,
      entries: [{ binding: 0, resource: { buffer: uniBuf } }]
    });
  }

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw); pixelH = Math.max(1, ph); dpr = d || 1;
  }

  // The time to the next show: random, as arrivals are, around the mean How
  // often sets, so shows sometimes come close together and sometimes leave
  // the sky empty for a while.
  function gap() {
    const mean = 60 / clampNum(S.fwRate, 1, 60, 10);
    const x = -Math.log(1 - Math.random()) * mean;
    return x < MIN_GAP ? MIN_GAP : (x > mean * 3 ? mean * 3 : x);
  }

  // One show's floats into slot s, in its own frame (the matrix is set
  // apart, per copy). bx, by is the burst point on screen; deep shows burst
  // at depth zb, pulled toward the viewer by grav, and flat ones at depth 1,
  // pulled down the screen.
  function writeShow(s, bx, by, bend, dur, recipe, seed, pattern, deep, zb, grav, lifeMul, shellZ, dragMul) {
    const o = s * SHOW_FLOATS;
    data[o] = 0; data[o + 1] = dur; data[o + 2] = recipe; data[o + 3] = seed;
    data[o + 4] = bx; data[o + 5] = by; data[o + 6] = bend; data[o + 7] = clampNum(S.fwSize, 0.4, 2, 1);
    data[o + 8] = 0; data[o + 9] = 0; data[o + 10] = 0; data[o + 11] = zb;
    data[o + 12] = pattern[0]; data[o + 13] = pattern[1]; data[o + 14] = pattern[2]; data[o + 15] = deep;
    data[o + 16] = 1; data[o + 17] = 0; data[o + 18] = 0; data[o + 19] = 1;
    data[o + 20] = grav; data[o + 21] = lifeMul; data[o + 22] = shellZ; data[o + 23] = dragMul;
    live[s] = 1;
    launchAt[s] = clock;
    endAge[s] = dur + LIFE_BASE[recipe] * lifeMul * 1.2 + 0.05;
  }
  function setMatrix(s, xx, xy, yx, yy) {
    const o = s * SHOW_FLOATS + 16;
    data[o] = xx; data[o + 1] = xy; data[o + 2] = yx; data[o + 3] = yy;
  }

  // The pattern's own randomness, shared by every copy of a salvo: its
  // angle, a tilted ring's squash, a star's ray count.
  const pattern = new Float32Array(3);
  function drawPattern() {
    pattern[0] = Math.random() * Math.PI * 2;
    pattern[1] = 0.35 + 0.65 * Math.random();
    pattern[2] = 5 + ((Math.random() * 4) | 0);
  }
  const seedNow = () => (Math.random() * 16777216) | 0;
  const recipeNow = () => (Math.random() * RECIPES) | 0;

  // Up to `need` free slots into freeSlots; false if there are not enough.
  const freeSlots = new Int8Array(4);
  function takeSlots(need) {
    let n = 0;
    for (let i = 0; i < MAX_SHOWS && n < need; i++) if (!live[i]) freeSlots[n++] = i;
    return n === need;
  }

  // Scatter: one show, heading for any corner but the last one used, so two
  // in a row never share. hx and hy are the visible field's half width and
  // half height in field units, so a corner is (plus or minus hx, plus or
  // minus hy).
  function launchScatter(hx, hy) {
    if (!takeSlots(1)) return;
    let corner;
    if (lastCorner < 0) corner = (Math.random() * 4) | 0;
    else { corner = (Math.random() * 3) | 0; if (corner >= lastCorner) corner++; }
    lastCorner = corner;
    const sx = corner === 1 || corner === 2 ? 1 : -1;   // TL, TR, BR, BL
    const sy = corner >= 2 ? 1 : -1;

    // Burst somewhere between halfway and three quarters of the way out,
    // nudged to one side of the straight line.
    const f = 0.5 + 0.28 * Math.random();
    let bx = sx * hx * f, by = sy * hy * f;
    const side = (Math.random() - 0.5) * 0.16;
    const nx = -by * side, ny = bx * side;
    bx += nx; by += ny;
    const len = Math.hypot(bx, by);

    drawPattern();
    const dur = 0.85 + 0.35 * Math.random() + 0.15 * len;
    writeShow(freeSlots[0], bx, by, (Math.random() - 0.5) * 0.12, dur, recipeNow(), seedNow(), pattern,
              0, 1, 0.10, 1, 1, 1);
  }

  // Four corners: four identical shows at once, placed symmetrically about
  // the centre so nothing pulls the eye to one side. One show is worked out
  // and copied four times, each copy seen through its own matrix: the four
  // mirror images for the diagonal corners, or the four quarter turns for
  // up, right, down and left (quarter turns rather than mirrors there, since
  // a mirror cannot carry up onto left). Same seed, same recipe, same timing,
  // so every spark and every crackle happens in all four at once.
  function launchCorners(hx, hy) {
    if (!takeSlots(4)) return;
    const diagonal = Math.random() < 0.5;
    const f = 0.5 + 0.28 * Math.random();
    let bx, by;
    if (diagonal) { bx = hx * f; by = -hy * f; }
    else { bx = 0; by = -Math.min(hx, hy) * f; }
    const len = Math.hypot(bx, by);
    drawPattern();
    const dur = 0.85 + 0.35 * Math.random() + 0.15 * len;
    const recipe = recipeNow(), seed = seedNow(), bend = (Math.random() - 0.5) * 0.12;
    for (let i = 0; i < 4; i++) {
      const s = freeSlots[i];
      writeShow(s, bx, by, bend, dur, recipe, seed, pattern, 1, 1, CORNERS_GRAVITY, 1, SHELL_FROM, 1);
      if (diagonal) setMatrix(s, i & 1 ? -1 : 1, 0, 0, i & 2 ? -1 : 1);
      else if (i === 0) setMatrix(s, 1, 0, 0, 1);
      else if (i === 1) setMatrix(s, 0, -1, 1, 0);
      else if (i === 2) setMatrix(s, -1, 0, 0, -1);
      else setMatrix(s, 0, 1, -1, 0);
    }
  }

  // Centre out: a shell rising straight up the tunnel at the centre, bursting
  // deep, its sparks falling toward the viewer and so flying out past every
  // edge of the screen as they come.
  function launchCentre() {
    if (!takeSlots(1)) return;
    drawPattern();
    const dur = 0.9 + 0.3 * Math.random();
    writeShow(freeSlots[0], 0, 0, 0, dur, recipeNow(), seedNow(), pattern,
              1, CENTRE_DEPTH, CENTRE_GRAVITY, CENTRE_LIFE, CENTRE_SHELL_FROM, CENTRE_DRAG);
  }

  function update(t, dt) {
    drawCount = 0;
    if (!S.layers || !S.layers.fireworks) {
      if (wasOn) { live.fill(0); wasOn = false; }
      return;
    }
    if (!made) make();
    if (!wasOn) { wasOn = true; nextAt = clock + FIRST_DELAY; }

    const step = S.running && dt > 0 ? dt : 0;
    clock += step;

    // The visible field, as the particles and the scene frame it: the drawer
    // covers the left, and a field unit is half the shorter side of the rest.
    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    const visW = Math.max(1, cssW - inset);
    const unit = Math.max(1, Math.min(visW, cssH) * 0.5);

    for (let i = 0; i < MAX_SHOWS; i++) if (live[i] && clock - launchAt[i] > endAge[i]) live[i] = 0;
    // One launch at most per frame, so a long stall never fires a salvo.
    if (step > 0 && clock >= nextAt) {
      const hx = visW * 0.5 / unit, hy = cssH * 0.5 / unit;
      if (S.fwMode === 'corners') launchCorners(hx, hy);
      else if (S.fwMode === 'centre') launchCentre();
      else launchScatter(hx, hy);
      nextAt = clock + gap();
    }

    const rgb = S.rgb;
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    let n = 0;
    for (let i = 0; i < MAX_SHOWS; i++) {
      if (!live[i]) continue;
      const src = i * SHOW_FLOATS, dst = 8 + n * SHOW_FLOATS;
      for (let k = 0; k < SHOW_FLOATS; k++) uni[dst + k] = data[src + k];
      uni[dst] = clock - launchAt[i];
      // the strobe's live colour, so a colour walk carries the shows with it
      uni[dst + 8] = r; uni[dst + 9] = g; uni[dst + 10] = b;
      n++;
    }
    const gain = clampNum(S.fwBright, 0, 1, 0.9);
    uni[0] = (inset + visW * 0.5) * dpr; uni[1] = cssH * 0.5 * dpr; uni[2] = unit * dpr; uni[3] = dpr;
    uni[4] = 1 / pixelW; uni[5] = 1 / pixelH; uni[6] = gain; uni[7] = n;
    if (n > 0 && gain > 0.002) {
      device.queue.writeBuffer(uniBuf, 0, uni);
      drawCount = n;
    }
  }

  // Inside the scene pass, over the particles and under the edge.
  function draw(pass) {
    if (!drawCount) return;
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.draw(6, drawCount * PER_SHOW);
  }

  return { update, draw, resize };
}
