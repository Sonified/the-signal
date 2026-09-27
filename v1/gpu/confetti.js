// The Confetti layer: paper and foil pieces streaming down the tunnel toward
// the viewer, tumbling as they come, flowing out from the middle of the
// visible field as perspective spreads them.
//
// There is no simulation pass. A piece is born into a slot of a fixed pool,
// and the CPU writes that slot's record once, at birth: when on the travel
// clock it was born, its speed and size factors, and its seed. From then on
// the shader works out where it is and how it looks from the record and the
// clocks alone (see confetti.wgsl.js). The CPU's work each frame is the
// births, the list of live pieces in draw order, and one small uniform
// block.
//
// Births follow a schedule on the travel clock, so they are as dense along
// the tunnel at any Speed. It runs in waves a few travel-seconds long. At
// Clump 0 the rate is steady, a stream; up, more of each wave's births come
// in its first few percent, until at 100% they all do, a burst of pieces
// born together and then nothing until the next wave. The average rate, and
// so the Amount, stays the same either way.
//
// The clocks run only while the strobe runs, so a stopped scene holds every
// piece where it is. The travel clock carries the pieces down the tunnel and
// runs at Speed; the tumble clock turns and flutters them and runs at plain
// time. Keeping them apart means moving Speed changes how fast the pieces
// come without any of them jumping.
//
// With Kaleidoscope on, the pieces are drawn into the reusable fold's
// chamber (fold.js) instead of the scene pass, and the fold draws the N-fold
// pattern where the confetti would have been, as the particle layer does.
//
// Nothing is made until the layer is first switched on, and nothing is
// allocated per frame after that.

import { S, Z_NEAR, Z_FAR } from '../../js/state.js';
import { CONFETTI_WGSL, N_MAX, FLIGHT, LETGO, TUMBLE_PERIOD, UNIFORM_FLOATS } from './confetti.wgsl.js';
import { createFold, FOLD_CHAMBER_FORMAT } from './fold.js';

// The travel clock wraps at W travel-seconds, so it and the birth times
// stay precise in the shader's f32 (a step of about 0.0005 s near the top).
// W is far longer than any piece lives, so an age taken across the wrap is
// never ambiguous.
const W = 4096;
// Births per travel-second at Amount 100%: the old steady stream's rate,
// 4096 pieces spread evenly over one flight.
const BASE_RATE = 4096 / FLIGHT;
// The birth schedule's waves: each lasts WAVE travel-seconds, give or take
// WAVE_JITTER of that per wave so the bursts do not come like a metronome.
// At Clump 100% a wave's births all come in its first DUTY of it.
const WAVE = 2.5;
const WAVE_JITTER = 0.25;
const DUTY = 0.04;
// Speed variance at 100% draws each piece's speed factor from 1 - SPEED_VAR
// to 1 + SPEED_VAR (0.6 to 1.4).
const SPEED_VAR = 0.4;
// The longest a piece can live, travel-seconds: the slowest factor's flight,
// 9 / 0.6 = 15.
const MAX_LIFE = FLIGHT / (1 - SPEED_VAR);
// The average birth rate is capped so that every piece that can still be
// alive fits the pool with a margin: RATE_CAP * MAX_LIFE = 0.95 * N_MAX.
// At Amount 100% the rate is about 455 against a cap of about 519, so this
// only guards a future change of the constants. A burst can still outrun it
// for a moment, which the ring's own check catches (see takeSlot).
const RATE_CAP = 0.95 * N_MAX / MAX_LIFE;
// The prewarm's step through the schedule, travel-seconds.
const PREWARM_STEP = 1 / 60;
// The largest a piece may get on screen, as a half size in css px.
const MAX_HALF_CSS = 200;

const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v)) ? (v < lo ? lo : v > hi ? hi : v) : def;

export function createConfetti(device, format) {
  let pixelW = 1, pixelH = 1, dpr = 1;
  let made = false;
  let uniBuf = null, slotBuf = null, orderBuf = null, pipe = null, chamberPipe = null, bind = null;
  let fold = null;
  const uni = new Float32Array(UNIFORM_FLOATS);
  const foldParams = { folds: 8, mirror: true, rotation: 0, gain: 1 };

  let travel = 0, tumble = 0, spin = 0, drawOn = false;
  let foldRot = 0, kaleidoNow = false, wasOn = false;

  // The CPU's mirror of the slot records (birth, speed factor, seed, size
  // factor per slot), and which slots hold a live piece.
  const rec = new Float32Array(N_MAX * 4);
  const alive = new Uint8Array(N_MAX);
  // The live list: slot indices from the farthest piece to the nearest, and
  // beside each its current depth, the sort key. n is its length.
  const order = new Uint32Array(N_MAX);
  const key = new Float32Array(N_MAX);
  let n = 0;
  // This frame's births, in the order they were born.
  const born = new Uint32Array(N_MAX);
  let nb = 0;
  // The ring: the next slot to try, how far it moved this frame (for the
  // upload), whether a full lap found nothing free, and whether the prewarm
  // is running it.
  let cursor = 0, advanced = 0, ringFull = false, filling = false;
  // The travel clock as the shader sees it, rounded to f32, so the depths
  // the list is sorted by are the depths drawn.
  let nowF = 0;
  // The schedule: where in the current wave it is and how long that wave is,
  // both travel-seconds, and the fraction of a birth carried between frames.
  let wavePos = 0, waveLen = WAVE, acc = 0;
  // Each birth's variations for this frame, set before the schedule runs.
  let speedVar = 0, sizeVar = 0.2;
  // A xorshift32 state for the births' own randoms.
  let rng = 0x9e3779b9 | 0;
  function rand() {
    rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
    return (rng >>> 0) / 4294967296;
  }

  // The flight so far of the piece in slot s at travel time now, from the
  // mirror, as the shader works it out. An age below minus half of W is one
  // taken across the clock's wrap; a small negative one is a birth this
  // frame whose time rounded a hair past the clock's in f32, so just born.
  function flightOf(s, now) {
    let age = now - rec[s * 4];
    if (age < -0.5 * W) age += W;
    else if (age < 0) age = 0;
    return age * rec[s * 4 + 1] / FLIGHT;
  }

  function make() {
    made = true;
    uniBuf = device.createBuffer({ label: 'confetti.uniforms', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    slotBuf = device.createBuffer({ label: 'confetti.slots', size: N_MAX * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    orderBuf = device.createBuffer({ label: 'confetti.order', size: N_MAX * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const mod = device.createShaderModule({ label: 'confetti.wgsl', code: CONFETTI_WGSL });
    if (mod.getCompilationInfo) {
      mod.getCompilationInfo().then(info => {
        if (info.messages.some(m => m.type === 'error')) {
          console.warn('confetti.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
        }
      });
    }
    const bgl = device.createBindGroupLayout({
      label: 'confetti.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }
      ]
    });
    // Opaque paper, not light: premultiplied "over", and the target's alpha
    // left as it is.
    const over = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    };
    // Into the fold's chamber the same "over", except that alpha builds up
    // as coverage too. The fold reads the chamber's alpha as how much a texel
    // covers what lies beneath; left at 0 as on screen, it would take the
    // paper for light and add it instead of laying it over.
    const overCover = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
    };
    const layout = device.createPipelineLayout({ label: 'confetti.layout', bindGroupLayouts: [bgl] });
    const pipeFor = (fmt, blend, name) => device.createRenderPipeline({
      label: name, layout,
      vertex: { module: mod, entryPoint: 'vsConf' },
      fragment: { module: mod, entryPoint: 'fsConf', targets: [{ format: fmt, blend }] },
      primitive: { topology: 'triangle-list' }
    });
    pipe = pipeFor(format, over, 'confetti.draw');
    chamberPipe = pipeFor(FOLD_CHAMBER_FORMAT, overCover, 'confetti.draw.chamber');
    bind = device.createBindGroup({
      label: 'confetti.bind', layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: { buffer: slotBuf } },
        { binding: 2, resource: { buffer: orderBuf } }
      ]
    });
    // The default "over" fold: the chamber holds covering paper, not light.
    // Full resolution rather than the fold's default half: a piece is only a
    // few px across, and a half resolution chamber would blur it away.
    fold = createFold(device, format, { label: 'confetti.fold', res: 1 });
  }

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw); pixelH = Math.max(1, ph); dpr = d || 1;
  }

  // The next free slot for a birth at travel time now, taking the ring in
  // order and passing over any slot whose piece is still in flight. Between
  // frames the live list has already let go of every finished piece, so the
  // live flag says it all; in the prewarm, which does not keep the list, a
  // piece that has finished by the birth's time counts as free too. If a
  // whole lap finds nothing, the ring is full and the rest of this frame's
  // births are dropped rather than overwrite a piece in flight: that is the
  // per frame cap, at most the free slots.
  function takeSlot(now) {
    if (ringFull) return -1;
    for (let k = 0; k < N_MAX; k++) {
      const s = cursor;
      cursor = cursor + 1 === N_MAX ? 0 : cursor + 1;
      advanced++;
      if (!alive[s] || (filling && flightOf(s, now) >= 1)) return s;
    }
    ringFull = true;
    return -1;
  }

  // One piece born at travel time b (wrapped). Its speed and size factors
  // are drawn here, once, from the variances as they are now, so moving
  // either slider only shapes the pieces born after it.
  function birth(b) {
    const s = takeSlot(b);
    if (s < 0) return;
    const o = s * 4;
    rec[o] = b;
    rec[o + 1] = 1 + speedVar * SPEED_VAR * (2 * rand() - 1);
    rec[o + 2] = (rand() * 16777216) | 0;
    rec[o + 3] = 1 + sizeVar * (2 * rand() - 1);
    alive[s] = 1;
    if (nb < N_MAX) born[nb++] = s;
  }

  // Runs the birth schedule over span travel-seconds from travel time t0,
  // bearing each birth at its exact moment. Within a wave the rate is
  // piecewise constant, base * mix(1, burst / DUTY, clump) with burst 1 in
  // the wave's first DUTY and 0 after, so the average over a wave is base
  // at any Clump. Each stretch of constant rate is walked exactly: a birth
  // falls wherever the carried fraction reaches a whole one. At Clump 100%
  // a wave's pieces are all born inside its first DUTY, about a tenth of a
  // travel-second, into consecutive slots: a thin shell of pieces that fly
  // down the tunnel together.
  function runSchedule(t0, span, base, clump) {
    const hi = base * (1 - clump + clump / DUTY);
    const lo = base * (1 - clump);
    let t = 0;
    while (span - t > 1e-9) {
      const burstEnd = DUTY * waveLen;
      const inBurst = wavePos < burstEnd;
      let seg = (inBurst ? burstEnd : waveLen) - wavePos;
      if (seg > span - t) seg = span - t;
      const r = inBurst ? hi : lo;
      if (r > 0) {
        let at = 0;
        while (acc + r * (seg - at) >= 1) {
          at += (1 - acc) / r;
          acc = 0;
          let b = t0 + t + at;
          if (b >= W) b -= W; else if (b < 0) b += W;
          birth(b);
        }
        acc += r * (seg - at);
        if (acc < 0) acc = 0;
      }
      t += seg;
      wavePos += seg;
      if (wavePos >= waveLen - 1e-9) {
        wavePos = 0;
        waveLen = WAVE * (1 + WAVE_JITTER * (2 * rand() - 1));
      }
    }
  }

  // The depth of the piece in slot s at travel time now, as the shader
  // works it out, so the draw order is the order the shader draws in.
  function depthOf(s, now) {
    return Z_FAR - (Z_FAR - LETGO) * flightOf(s, now);
  }

  // One insertion sort pass over the live list, far to near. The list comes
  // in from last frame already sorted, with this frame's births at the front
  // where the farthest pieces belong. Pieces only change places when a
  // faster one overtakes a slower one, which in one frame passes a few
  // neighbours at most, and never at Speed variance 0, where depth order is
  // birth order. The only other moves are among the newborns, settling into
  // order by their speeds. So nearly every piece is already in place, and
  // the pass is close to one walk down the list rather than the n squared
  // an insertion sort costs on shuffled input.
  function sortLive() {
    for (let i = 1; i < n; i++) {
      const kz = key[i];
      if (kz <= key[i - 1]) continue;
      const s = order[i];
      let j = i - 1;
      while (j >= 0 && key[j] < kz) {
        key[j + 1] = key[j];
        order[j + 1] = order[j];
        j--;
      }
      key[j + 1] = kz;
      order[j + 1] = s;
    }
  }

  // Lets go of every piece that has finished its flight, keeping the rest
  // in order with their depths at travel time now.
  function dropFinished(now) {
    let w = 0;
    for (let i = 0; i < n; i++) {
      const s = order[i];
      if (flightOf(s, now) >= 1) { alive[s] = 0; continue; }
      order[w] = s;
      key[w] = depthOf(s, now);
      w++;
    }
    n = w;
  }

  // The layer comes up mid flow instead of empty: the schedule is run over
  // the last MAX_LIFE travel-seconds, the longest any piece born then could
  // still be flying, with every birth given its time in the past, and the
  // pieces still in flight now make the live list, sorted once. A clump
  // wave starts at a random point, so the fill can come up mid burst or mid
  // gap. Runs once when the layer turns on, never per frame.
  function prewarm(base, clump) {
    alive.fill(0);
    n = 0; nb = 0; cursor = 0; ringFull = false; acc = 0; filling = true;
    waveLen = WAVE * (1 + WAVE_JITTER * (2 * rand() - 1));
    wavePos = rand() * waveLen;
    const t0 = travel - MAX_LIFE;
    if (base > 0) {
      for (let k = 0; k * PREWARM_STEP < MAX_LIFE; k++) {
        const a = k * PREWARM_STEP;
        runSchedule(t0 + a, Math.min(PREWARM_STEP, MAX_LIFE - a), base, clump);
      }
    }
    filling = false;
    for (let s = 0; s < N_MAX; s++) {
      if (!alive[s]) continue;
      if (flightOf(s, nowF) >= 1) { alive[s] = 0; continue; }
      order[n++] = s;
    }
    // The fill's pieces are far from sorted, so a full sort once rather than
    // the insertion pass.
    order.subarray(0, n).sort(byFar);
    for (let i = 0; i < n; i++) key[i] = depthOf(order[i], nowF);
    nb = 0;
    device.queue.writeBuffer(slotBuf, 0, rec);
  }
  const byFar = (a, b) => depthOf(b, nowF) - depthOf(a, nowF);

  function update(t, dt) {
    drawOn = false;
    if (!S.layers || !S.layers.confetti) { wasOn = false; return; }
    if (!made) make();

    const step = S.running && dt > 0 ? dt : 0;
    const t0 = travel;
    const stepT = step * clampNum(S.confSpeed, 0.1, 2, 1);
    travel += stepT;
    if (travel >= W) travel -= W;
    nowF = Math.fround(travel);
    tumble += step;
    if (tumble >= TUMBLE_PERIOD) tumble -= TUMBLE_PERIOD;
    // The spin has a clock of its own at the Rotation speed, so moving that
    // slider changes how fast the pieces turn from here on instead of jumping
    // every piece to a new angle. It wraps at the same period, since every
    // piece turns a whole number of times in one.
    spin += step * clampNum(S.confSpin, 0, 3, 1);
    if (spin >= TUMBLE_PERIOD) spin -= TUMBLE_PERIOD;

    const amount = clampNum(S.confAmount, 0, 1, 0.5);
    const base = Math.min(amount * BASE_RATE, RATE_CAP);
    const clump = clampNum(S.confClump, 0, 1, 0);
    speedVar = clampNum(S.confSpeedVar, 0, 1, 0);
    sizeVar = clampNum(S.confSizeVar, 0, 0.95, 0.2);

    if (!wasOn) {
      // Just switched on: start from a full, moving field.
      wasOn = true;
      prewarm(base, clump);
    } else {
      // Finished pieces go first, so their slots are free for this frame's
      // births. Every birth this frame is younger than every piece already
      // in flight, so the births go in at the front, the latest born first,
      // and the one sort pass puts any overtaking right.
      dropFinished(nowF);
      nb = 0; advanced = 0; ringFull = false;
      const upStart = cursor;
      if (stepT > 0 && base > 0) runSchedule(t0, stepT, base, clump);
      if (nb > 0) {
        order.copyWithin(nb, 0, n);
        key.copyWithin(nb, 0, n);
        for (let k = 0; k < nb; k++) {
          const s = born[nb - 1 - k];
          order[k] = s;
          key[k] = depthOf(s, nowF);
        }
        n += nb;
      }
      sortLive();
      // Only the records the ring passed over this frame go up: the births,
      // and any live slots skipped between them, unchanged. Two writes when
      // the range wraps past the end of the pool.
      if (advanced >= N_MAX) {
        device.queue.writeBuffer(slotBuf, 0, rec);
      } else if (advanced > 0) {
        const end = upStart + advanced;
        if (end <= N_MAX) {
          device.queue.writeBuffer(slotBuf, upStart * 16, rec, upStart * 4, advanced * 4);
        } else {
          device.queue.writeBuffer(slotBuf, upStart * 16, rec, upStart * 4, (N_MAX - upStart) * 4);
          device.queue.writeBuffer(slotBuf, 0, rec, 0, (end - N_MAX) * 4);
        }
      }
    }

    // The births and the list run whatever the look, so pieces keep flowing
    // while the layer is dimmed out and come back mid flow. Only the draw is
    // skipped.
    const bright = clampNum(S.confBright, 0, 1, 1);
    const opacity = clampNum(S.confOpacity, 0, 1, 1);
    if (n === 0 || bright <= 0.002 || opacity <= 0.002) return;
    device.queue.writeBuffer(orderBuf, 0, order, 0, n);

    // The visible field and the rings' projection, as the particles frame
    // them: the drawer covers the left, in device pixels.
    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    const visW = Math.max(1, cssW - inset);
    const maxR = Math.hypot(visW, cssH) * 0.62 * dpr;
    const focal = maxR * Z_NEAR;
    const cx = (inset + visW * 0.5) * dpr, cy = cssH * 0.5 * dpr;

    // Where the draw lands: the screen about the field centre, or with
    // Kaleidoscope on the fold's chamber (see fold.js for the mapping).
    kaleidoNow = !!S.confKaleido;
    if (kaleidoNow) {
      // The params first: the chamber is sized to the domain they make.
      // Brightness is already in the pieces' colour, so the fold adds none.
      foldRot += clampNum(S.confFoldSpin, -1, 1, 0.05) * 0.5 * step;
      foldParams.folds = clampNum(S.confFolds, 3, 16, 8);
      foldParams.mirror = S.confMirror !== false;
      foldParams.rotation = foldRot;
      foldParams.gain = 1;
      fold.ensureChamber(pixelW, pixelH, foldParams);
      fold.fit(cx, cy);
      const f = fold.frame;
      uni[0] = f[4]; uni[1] = f[5]; uni[4] = f[2]; uni[5] = f[3]; uni[22] = f[6];
    } else {
      uni[0] = cx; uni[1] = cy; uni[4] = 1 / pixelW; uni[5] = 1 / pixelH; uni[22] = 1;
      fold.releaseChamber();
    }

    const pal = S.confPalette === 'strobe' ? 1 : S.confPalette === 'gold' ? 2 : 0;
    const rgb = S.rgb;
    uni[2] = focal; uni[3] = dpr;
    uni[6] = MAX_HALF_CSS * dpr; uni[7] = bright;
    uni[8] = travel; uni[9] = W; uni[10] = 0; uni[11] = tumble;
    uni[12] = 0; uni[13] = clampNum(S.confSize, 0.2, 50, 1); uni[14] = clampNum(S.confShine, 0, 1, 0.35); uni[15] = pal;
    uni[16] = rgb[0] / 255; uni[17] = rgb[1] / 255; uni[18] = rgb[2] / 255; uni[19] = Z_FAR;
    uni[20] = clampNum(S.confSpread, 0, 1, 0); uni[21] = clampNum(S.confFlutter, 0, 1, 1); uni[23] = opacity;
    uni[24] = clampNum(S.confFade, 0, 1, 0.55); uni[25] = Z_NEAR; uni[26] = spin; uni[27] = clampNum(S.confTumble, 0, 1, 1);
    uni[28] = clampNum(S.confLife, 0.05, 1, 1); uni[29] = 0; uni[30] = 0; uni[31] = 0;
    device.queue.writeBuffer(uniBuf, 0, uni);
    drawOn = true;
  }

  // Encoded by the engine before the scene pass: with Kaleidoscope on, the
  // pieces into the fold's chamber, in the same far to near order as on
  // screen.
  function encode(encoder) {
    if (!drawOn || !kaleidoNow || !fold.chamberView) return;
    const cp = encoder.beginRenderPass(fold.chamberPassDesc);
    cp.setPipeline(chamberPipe);
    cp.setBindGroup(0, bind);
    cp.draw(6, n);
    cp.end();
  }

  // Inside the scene pass, over the fireworks and under the edge.
  function draw(pass) {
    if (!drawOn) return;
    if (kaleidoNow) { fold.draw(pass, foldParams); return; }
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.draw(6, n);
  }

  return { update, encode, draw, resize };
}
