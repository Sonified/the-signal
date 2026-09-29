// The Edge layer's three effects beside Surfing: Particles (sparks born
// along the border, drifting out past it or in toward the centre), Flame
// (noise licks rising in off all four borders) and Glow (a soft band of
// light hugging the border, swelling slowly). The shaders, and how each one
// is built, are in edge-fx.wgsl.js; this is the CPU half, one small uniform
// block a frame and at most three draws, no vertex buffers.
//
// scene.js owns which effect is showing and the crossfade between them: it
// hands update() each effect's share of the edge this frame (0 for one not
// showing), and draws whichever have something to add, into the scene pass
// or into the edge's feedback image, exactly where the Surfing tails go.
// Everything here is light: added with alpha left alone, so an effect drawn
// at a share w beside another at 1 - w is a true crossfade.
//
// As the Surfing edge does, all three are coloured by the strobe's colour, or
// under per-element colour by the edge particles' own hues (eight of them,
// sampled evenly from S.particles, so a colour walk carries them too); scaled
// by Edge opacity and the strobe's brightness; and they shimmer only through
// flickerLevel (core/strobe.js), so paused they settle to the steady top of
// the cycle with everything else. Each keeps its own clock, stepped by
// motionStep, so on pause the sparks, the flames and the breathing coast to a
// stop with the scene and hold once it has stopped.
//
// Nothing is allocated per frame; the GPU objects are made once, the first
// time an effect other than Surfing is asked for.

import { S } from '../../js/state.js';
import { scaledStrobeDepth } from '../../js/strobe-scale.js';
import { shape } from '../../js/util.js';
import { bandHue } from '../../js/color.js';
import { flickerLevel } from '../core/strobe.js';
import { motionStep } from '../core/motion.js';
import { hsl } from './scene-data.js';
import { EDGE_FX_WGSL, FX_UNIFORM_FLOATS, SPARK_SLOTS, SPARK_RATE_MAX, FLAME_PERIOD_D } from './edge-fx.wgsl.js';

// The edge's brightness at full, and the floor its shimmer dips to, both as
// the Surfing edge has them (scene-data.js buildEdge), so switching effect
// keeps the layer's level.
const EDGE_ALPHA = 0.75;
const SHIMMER_FLOOR = 0.25;
// Below this an effect's gain adds nothing worth a draw.
const MIN_GAIN = 0.002;

// Particles. A spark's base life, seconds (each lives 0.6 to 1.4 times it,
// edge-fx.wgsl.js, which must stay under a slot's period of SPARK_SLOTS /
// SPARK_RATE_MAX = 2 s); its drift at Drift 1, css px a second; the reach of
// its wobble along the border, css px; how far in from the border it may be
// born, css px; and its brightness against the edge's.
const SPARK_LIFE = 1.0;
const SPARK_DRIFT_PX = 90;
const SPARK_JITTER_PX = 3;
const SPARK_BIRTH_BAND_PX = 10;
const SPARK_GAIN = 1.0;
const SPARK_PERIOD = SPARK_SLOTS / SPARK_RATE_MAX;
// The pool's cycle count is kept under this, so it stays exact as a float;
// it wraps once every SPARK_PERIOD * CYCLE_WRAP seconds (about a day and a
// half), reshuffling the sparks once.
const CYCLE_WRAP = 65536;

// Flame. A noise cell's width along the border and its depth, css px,
// fixed: the noise lives in the screen's own pixels, rooted at the border,
// and Height is only how far in the licks are let reach before they die
// away (the envelope, in the shader), so turning it up lets the same flames
// climb further toward the middle rather than rescaling them. Then how fast
// the licks rise, in depth cells a second, and drift along, in cells a
// second, and the warp noise's own rise, all at Speed 1; the fewest cells
// round the whole perimeter; the few px past Height the bands reach, so a
// lick's soft tip is never cut; the flame's brightness against the edge's.
const FLAME_CELL_ALONG_PX = 30;
const FLAME_CELL_DEPTH_PX = 22;
const FLAME_RISE = 1.4;
const FLAME_ALONG = 0.12;
const FLAME_WARP_RISE = 0.7;
const FLAME_CELLS_MIN = 4;
const FLAME_TIP_MARGIN_PX = 2;
const FLAME_GAIN = 0.9;

// Glow's brightness against the edge's: a whole band of light, so lower
// than a spark's. Its falloff inward is (1 - t)^k over the share t of Width
// (edge-fx.wgsl.js fsGlow), k running from GLOW_K_CRISP at Softness 0 (a
// bright rim, fading fast) to GLOW_K_SOFT at 100% (a long smooth decay).
const GLOW_GAIN = 0.55;
const GLOW_K_CRISP = 7;
const GLOW_K_SOFT = 1.5;

const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v)) ? (v < lo ? lo : v > hi ? hi : v) : def;

export function createEdgeFx(device, format, fbFormat) {
  let made = false;
  let uniBuf = null, bind = null;
  let pipes = null;   // [particles, flame, glow] on screen, the same into the feedback image, then on screen scaled by the blend constant
  const uni = new Float32Array(FX_UNIFORM_FLOATS);

  // The clocks, in seconds of motion; the breathing's phase, 0..1.
  let partClock = 0, flameClock = 0, breathe = 0;
  // What this frame draws.
  let drawPart = false, drawFlame = false, drawGlow = false;

  function make() {
    made = true;
    uniBuf = device.createBuffer({ label: 'edgeFx.uniforms', size: FX_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mod = device.createShaderModule({ label: 'edge-fx.wgsl', code: EDGE_FX_WGSL });
    if (mod.getCompilationInfo) {
      mod.getCompilationInfo().then(info => {
        if (info.messages.some(m => m.type === 'error')) {
          console.warn('edge-fx.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
        }
      });
    }
    const bgl = device.createBindGroupLayout({
      label: 'edgeFx.bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
    });
    const layout = device.createPipelineLayout({ label: 'edgeFx.layout', bindGroupLayouts: [bgl] });
    bind = device.createBindGroup({ label: 'edgeFx.bind', layout: bgl, entries: [{ binding: 0, resource: { buffer: uniBuf } }] });
    // Pure light: the colour added, alpha left as it is, on screen and into
    // the feedback image alike.
    const light = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    };
    // And the same light with its colour scaled by the pass's blend
    // constant, for the live edge drawn beside its feedback image at the
    // strength the image's Opacity leaves it (scene.js).
    const scaled = {
      color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    };
    const pipe = (fmt, vs, fs, label, blend) => device.createRenderPipeline({
      label, layout,
      vertex: { module: mod, entryPoint: vs },
      fragment: { module: mod, entryPoint: fs, targets: [{ format: fmt, blend: blend || light }] },
      primitive: { topology: 'triangle-list' }
    });
    pipes = [
      pipe(format, 'vsPart', 'fsPart', 'edgeFx.part'),
      pipe(format, 'vsFlame', 'fsFlame', 'edgeFx.flame'),
      pipe(format, 'vsGlow', 'fsGlow', 'edgeFx.glow'),
      pipe(fbFormat, 'vsPart', 'fsPart', 'edgeFx.part.fb'),
      pipe(fbFormat, 'vsFlame', 'fsFlame', 'edgeFx.flame.fb'),
      pipe(fbFormat, 'vsGlow', 'fsGlow', 'edgeFx.glow.fb'),
      pipe(format, 'vsPart', 'fsPart', 'edgeFx.part.live', scaled),
      pipe(format, 'vsFlame', 'fsFlame', 'edgeFx.flame.live', scaled),
      pipe(format, 'vsGlow', 'fsGlow', 'edgeFx.glow.live', scaled)
    ];
  }

  // This frame's uniforms from S, given each effect's share of the edge.
  // Returns whether any of the three has something to draw.
  function update(dt, wPart, wFlame, wGlow, pixelW, pixelH, dpr) {
    drawPart = false; drawFlame = false; drawGlow = false;
    const step = dt > 0 ? motionStep(dt) : 0;
    const flameSpeed = clampNum(S.edgeFlameSpeed, 0.1, 3, 1);
    partClock += step;
    if (partClock >= SPARK_PERIOD * CYCLE_WRAP) partClock -= SPARK_PERIOD * CYCLE_WRAP;
    flameClock += step * flameSpeed;
    breathe += step / clampNum(S.edgeGlowBreatheRate, 1, 60, 8);
    breathe -= Math.floor(breathe);

    if (!S.layers.edge || (wPart <= 0 && wFlame <= 0 && wGlow <= 0)) return false;
    if (!made) make();

    const L = (S.edgeInset || 0) * dpr, R = (S.W || pixelW / dpr) * dpr, B = (S.H || pixelH / dpr) * dpr;
    const w = R - L;
    if (!(w > 1) || !(B > 1)) return false;
    // The bands must stop short of meeting in the middle, or their
    // trapezoids would turn inside out.
    const halfMin = Math.max(0, Math.min(w, B) * 0.5 - 1);

    uni[0] = L; uni[1] = R; uni[2] = B; uni[3] = dpr;
    uni[4] = 1 / pixelW; uni[5] = 1 / pixelH; uni[6] = S.perElementColor ? 1 : 0; uni[7] = 0;
    const rgb = S.rgb;
    uni[8] = rgb[0] / 255; uni[9] = rgb[1] / 255; uni[10] = rgb[2] / 255; uni[11] = 0;
    if (S.perElementColor) {
      const ps = S.particles, n = ps.length;
      for (let k = 0; k < 8; k++) {
        const o = 12 + k * 4;
        if (n > 0) {
          const c = hsl(bandHue(ps[(k * n / 8) | 0].hue), S.hueSat, S.hueLight);
          uni[o] = c[0] / 255; uni[o + 1] = c[1] / 255; uni[o + 2] = c[2] / 255;
        } else {
          uni[o] = uni[8]; uni[o + 1] = uni[9]; uni[o + 2] = uni[10];
        }
        uni[o + 3] = 0;
      }
    }
    // The shimmer at eight offsets round the strobe's cycle, as the Surfing
    // particles each take their own: paused, flickerLevel is 0 and every one
    // is steady at the top. Pulse with strobe (S.edgePulse) scales how far
    // each departs from that steady top, as it does the Surfing edge's.
    const fl = flickerLevel();
    const pulse = scaledStrobeDepth(clampNum(S.edgePulse, 0, 1, 1));
    for (let k = 0; k < 8; k++) {
      const lp = 1 + (shape((S.phase + k / 8) % 1) - 1) * fl;
      const full = SHIMMER_FLOOR + (1 - SHIMMER_FLOOR) * lp;
      uni[44 + k] = pulse === 1 ? full : 1 + (full - 1) * pulse;
    }
    // Edge opacity alone, never the Strobe section's Brightness: the edge
    // is its own layer (see the same note in scene-data.js buildEdge).
    const base = EDGE_ALPHA * (S.edgeOpacity ?? 1);
    // The bands shimmer as one, on the field's own phase.
    const level0 = uni[44];

    // Particles.
    const rate = clampNum(S.edgePartRate, 0, SPARK_RATE_MAX, 120);
    const gP = base * wPart * SPARK_GAIN;
    if (gP > MIN_GAIN && rate > 0) {
      const cyc = partClock / SPARK_PERIOD, whole = Math.floor(cyc);
      uni[52] = cyc - whole; uni[53] = whole;
      uni[54] = clampNum(S.edgePartSize, 0.5, 8, 2) * dpr;
      uni[55] = clampNum(S.edgePartDrift, -1, 0, -0.35);
      uni[56] = clampNum(S.edgePartSparkle, 0, 1, 0.5);
      uni[57] = gP;
      uni[58] = rate / SPARK_RATE_MAX;
      uni[59] = SPARK_JITTER_PX * dpr;
      uni[60] = SPARK_DRIFT_PX * dpr; uni[61] = SPARK_PERIOD; uni[62] = SPARK_LIFE; uni[63] = SPARK_BIRTH_BAND_PX * dpr;
      drawPart = true;
    }

    // Flame.
    const reach = Math.min(clampNum(S.edgeFlameHeight, 8, 240, 56) * dpr, halfMin);
    const gF = base * wFlame * FLAME_GAIN * level0;
    if (gF > MIN_GAIN && reach >= 1) {
      const per = 2 * (w + B);
      const cells = Math.max(FLAME_CELLS_MIN, Math.round(per / (FLAME_CELL_ALONG_PX * dpr)));
      uni[64] = reach; uni[65] = clampNum(S.edgeFlameTurb, 0, 1, 0.5); uni[66] = gF; uni[67] = cells;
      uni[68] = (flameClock * FLAME_ALONG) % cells;
      uni[69] = (flameClock * FLAME_RISE) % FLAME_PERIOD_D;
      uni[70] = (flameClock * FLAME_WARP_RISE) % FLAME_PERIOD_D;
      uni[71] = FLAME_CELL_DEPTH_PX * dpr;
      uni[7] = Math.min(reach + FLAME_TIP_MARGIN_PX * dpr, halfMin);
      drawFlame = true;
    }

    // Glow, swelling down and back once a Breathe rate: at the top of the
    // cycle it is full, at the bottom 1 - Breathe of it.
    const width = clampNum(S.edgeGlowWidth, 2, 200, 28) * dpr;
    const soft = clampNum(S.edgeGlowSoft, 0, 1, 0.6);
    const swell = 1 - clampNum(S.edgeGlowBreathe, 0, 1, 0.4) * 0.5 * (1 - Math.cos(2 * Math.PI * breathe));
    const gG = base * wGlow * GLOW_GAIN * level0 * swell;
    // The band reaches Width in from the border, and no further.
    const outer = Math.min(width, halfMin - 1);
    if (gG > MIN_GAIN && outer >= 0.5) {
      uni[72] = GLOW_K_CRISP + (GLOW_K_SOFT - GLOW_K_CRISP) * soft; uni[73] = outer; uni[74] = gG; uni[75] = soft;
      drawGlow = true;
    }

    if (!drawPart && !drawFlame && !drawGlow) return false;
    device.queue.writeBuffer(uniBuf, 0, uni);
    return true;
  }

  // Whichever effects have something this frame, into the scene pass
  // (intoFb false) or the edge's feedback image. live draws into the scene
  // pass scaled by the blend constant the caller has set.
  function draw(pass, intoFb, live) {
    if (!drawPart && !drawFlame && !drawGlow) return;
    const o = intoFb ? 3 : live ? 6 : 0;
    pass.setBindGroup(0, bind);
    if (drawGlow) { pass.setPipeline(pipes[o + 2]); pass.draw(24); }
    if (drawFlame) { pass.setPipeline(pipes[o + 1]); pass.draw(24); }
    if (drawPart) { pass.setPipeline(pipes[o]); pass.draw(6, SPARK_SLOTS); }
  }

  return { update, draw };
}
