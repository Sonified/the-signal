// The Confetti layer: paper and foil pieces streaming down the tunnel toward
// the viewer, tumbling as they come, flowing out from the middle of the
// visible field as perspective spreads them.
//
// There is no simulation pass. A piece is born into a slot of a fixed pool,
// and the CPU writes that slot's record once, at birth: when on the travel
// clock it was born, its speed and size factors, its seed, where in the
// plane it starts (angle and radius), the spin clock at its birth, its
// alignment and its outward kick, and its own share of the spin rate
// (Rotation variance). From then on
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
// Bunched in time alone a burst would still be a whole disc of pieces at
// every radius, and the few in flight at once would overlap into what reads
// as a stream. So Clump bunches a burst in space too, as a radial release:
// each wave draws one radius, and its burst pieces are born near it, all the
// way round the centre, a thin ring at one depth. Each also gets an outward
// kick, so the ring widens symmetrically as it flies toward the viewer. The
// waves grow longer as Clump rises, so one ring clears before the next: a
// ring, then nothing, then the next ring. Every direction is treated alike;
// nothing about Clump ever pulls the eye to one side.
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
// The fold only ever reads its fundamental domain, one wedge pointing
// straight up (1/16 of the circle at 8 folds mirrored), so folded the pieces
// are born only into that wedge, at that share of the rate: the pieces the
// fold reads are as dense as before, and the births, the list, its sort and
// upload and the draw all shrink by the same share. The shader places them
// (confetti.wgsl.js) and keeps the density even up to the seams. The live
// field is sized for one domain, so a change of domain (Kaleidoscope on or
// off, the fold count, mirror) fills it afresh for the new one, as switching
// the layer on does; the fold's rotation is applied as it reads, so it is no
// change of domain.
//
// With the feedback in use the pieces never draw straight onto the screen.
// They draw into a video feedback image of the layer's own (feedback.js),
// and one fullscreen triangle lays that image over the scene, so the one
// route serves every setting: Feedback only decides whether each frame's image starts cleared
// (0) or as a faded copy of the last, which leaves every piece a trail that
// dies away. Stream and Twist move that copy a little each frame, out or in
// and round about the field centre, alike in every direction. The fade and
// motion go by the frame's time, so they look the same at any frame rate,
// and a stopped scene holds the image as it is.
//
// With the feedback not in use (Feedback 0 and no upper swing) that image
// would hold, each frame, just the frame's pieces over a clear, so the route
// is skipped: the pieces draw straight into the scene pass (see bypass in
// createConfetti), and the result is the same picture.
//
// Folded, the feedback can sit after the kaleidoscope (the default, and the
// only place unfolded): the fold's output is what goes into the image, so
// trails stream and turn across the whole pattern about its centre. Or it
// can sit before it: a second feedback image, the chamber's size, stands in
// for the fold's chamber, the pieces draw into it in chamber space, and the
// fold reads that image (fold.js drawFrom) straight into the scene. Stream
// and twist keep scale and angle, so the same rates carry over, applied
// about the chamber's field centre point. There the trails live inside the
// wedge and every copy of it repeats them, and Twist turns the wedge's
// content out through its edges, where it is lost, while new content turns
// in from nowhere: a shearing bloom inside the pattern rather than a turn of
// the whole.
//
// Nothing is made until the layer is first switched on, and nothing is
// allocated per frame after that. The feedback images are made when the
// layer comes on, the canvas or the chamber changes size, or the feedback
// moves before or after the fold, and let go when the layer goes off.
//
// Pulse with strobe brightens and darkens the whole feedback image, trails
// and live pieces alike, with the strobe's flicker: its colour is scaled by
// 1 - p + p * lum as it is laid over the scene, the coverage kept, so trails
// darken rather than turning see-through. After the fold that is the
// feedback composite's gain; before it, the fold's colour gain, which does
// the same. Pulse variance lets p drift slowly about the setting on the
// layer's own clock, so a stopped scene holds it.
//
// Amount, Stream and Twist each swing about their settings the same way, on
// the same clock, each with its own phase and rate: over one cycle a sine
// carries the setting up by as much as its Hi on the positive half and down
// by as much as its Lo on the negative half, clamped to the setting's own
// range. The swing feeds only this frame's feedback; the settings, and the
// shut sub-drawer's summary of them, stay where they were set. An Amount
// swinging through 0 clears each frame just as the slider at 0 does, and the
// feedback's route (before or after the fold) is chosen from the setting and
// its upper reach, not the swinging value, so a swing through 0 never lets an
// image go and makes it again.

import { S, Z_NEAR, Z_FAR } from '../../js/state.js';
import { scaledStrobeDepth } from '../../js/strobe-scale.js';
import { CONFETTI_WGSL, N_MAX, FLIGHT, LETGO, TUMBLE_PERIOD, UNIFORM_FLOATS, SLOT_FLOATS, R_MIN, R_MAX, KICK_PACK } from './confetti.wgsl.js';
import { createFold, FOLD_CHAMBER_FORMAT } from './fold.js';
import { createFeedback, FEEDBACK_FORMAT } from './feedback.js';
import { motionStep } from '../core/motion.js';
import { eye } from '../core/eye.js';

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
// The radial release, how Clump shapes a burst in space. All of these scale
// with Clump c, so at 0 the stream is exactly as it was and in between the
// look blends smoothly.
// WAVE_GROW: at Clump 100% a wave lasts this many times WAVE, so a ring has
// flown well clear before the next is born and there is real nothing between
// them. The average rate stays the Amount, so the rings get fuller rather
// than the field thinner. Lower brings the rings closer together in depth;
// higher leaves longer gaps and bigger rings.
const WAVE_GROW = 2.2;
// RING_SPREAD: how far a burst piece's start radius strays from its wave's
// ring radius, as a share of it (one standard deviation). Small keeps the
// ring thin and crisp; up toward 0.5 it thickens into a band.
const RING_SPREAD = 0.15;
// KICK_REACH: how far out, tunnel units, a burst piece's kick carries it over
// its whole flight at Clump 100%, on top of Spread's drift and the same in
// every direction. Each piece takes KICK_LO to KICK_HI of it, so the ring
// widens into a blooming band as it comes. The screen's edge is about 7
// tunnel units out per unit of depth, so at 3 the ring opens out toward the
// edges only in the last stretch of its flight; higher throws it wider
// sooner.
const KICK_REACH = 3.0;
const KICK_LO = 0.6;
const KICK_HI = 1.4;
// Burst pieces are placed round the ring by the golden ratio rather than at
// random, each a golden share of the circle (or of the Kaleidoscope's wedge)
// on from the last, so even a sparse ring has no clumps or gaps.
const GOLDEN = 0.6180339887498949;
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
// The fold's domain centre line, straight up the screen (screen y grows
// downward), as fold.js has it.
const TAU = Math.PI * 2;
const UP = -Math.PI * 0.5;
// Feedback: the trails' half-life, seconds, at Feedback 100%. The slider s
// gives HL_MAX * s * s, so the low end, where short trails live, gets most
// of the slider's travel.
const HL_MAX = 2.0;
// Stream at full either way: the trail image's scale changes by
// exp(STREAM_MAX) a second, about 1.65 times bigger (out) or smaller (in).
// Higher throws the trails toward the edges or into the centre faster.
const STREAM_MAX = 0.5;
// Twist at full either way, radians a second: about 46 degrees, an eighth
// of a turn, so the swirl reads as a drift rather than a spin.
const TWIST_MAX = 0.8;

const clampNum = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v)) ? (v < lo ? lo : v > hi ? hi : v) : def;

// One setting swung by its variance at a phase (0 to 1) of its cycle: with
// osc = sin(TAU * phase), the positive half carries it up by osc * hi and the
// negative half down by -osc * lo (lo is 0 or below), clamped to the
// setting's own min and max. With no variance it is the setting exactly.
function swing(base, lo, hi, phase, min, max) {
  if (lo === 0 && hi === 0) return base;
  const osc = Math.sin(TAU * phase);
  const v = base + (osc >= 0 ? osc * hi : -osc * lo);
  return v < min ? min : v > max ? max : v;
}

// The Shapes selection as the bitmask the shader reads from par.x: bit i for
// shape i (1 square, 2 rectangle, 4 circle, 8 oval). S.confShapes holds the
// lit indices, and the empty list means every shape, so that and anything
// that names none in range both come out as all four. A plain loop over the
// list, so the frame allocates nothing.
function shapeMask(list) {
  let m = 0;
  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v === 0 || v === 1 || v === 2 || v === 3) m |= 1 << v;
    }
  }
  return m === 0 ? 15 : m;
}

export function createConfetti(device, format) {
  let pixelW = 1, pixelH = 1, dpr = 1;
  let made = false;
  let uniBuf = null, slotBuf = null, orderBuf = null, chamberPipe = null, imagePipe = null, scenePipe = null, bind = null;
  let fold = null;
  // The feedback images (see the top of this file): fbScreen is canvas
  // sized and laid over the scene, fbChamber the chamber's size for
  // feedback before the fold. foldScene is the fold that reads fbChamber
  // straight into the scene; fold itself draws into fbScreen, so the two
  // differ in target format. fbParams is this frame's feedback, for
  // whichever image is in use, and before says which that is. layerOn is
  // the layer switch as update() found it.
  let fbScreen = null, fbChamber = null, foldScene = null;
  const fbParams = { keepHalfLife: 0, zoomRate: 0, twistRate: 0, cx: 0, cy: 0, unit: 1, dt: 0 };
  let before = false, layerOn = false;
  // The bypass: with the feedback not in use, the feedback image is only
  // ever cleared, drawn and laid over the scene, so the pieces (unfolded) or
  // the fold (folded) go straight into the scene pass instead and the image
  // is let go.
  //
  // Why it is the same picture. The image starts at 0. Each piece, far to
  // near, goes in with premultiplied over, colour and alpha alike:
  // I = c_k + I * (1 - a_k). Unrolled, I.rgb = sum over k of c_k times the
  // product of (1 - a_j) for every nearer piece j, and 1 - I.a = the product
  // of (1 - a_k) over all of them, since alpha runs the same recurrence. The
  // composite then gives g * I.rgb + scene * (1 - I.a), g the pulse gain.
  // Drawn straight into the scene with colour one / one-minus-src-alpha,
  // each piece's colour scaled by g, the scene after the last piece is
  // sum of g * c_k times the same products, plus the scene times the product
  // of every (1 - a_k): term for term the same. The pulse is linear in the
  // colour, so it rides in the pieces' brightness (uni[7]; the shader scales
  // colour by it and leaves alpha alone). Alpha is zero / one, leaving the
  // scene's alpha as it is: the scene pass clears it to 1 and the composite
  // would give A + 1 * (1 - A) = 1 too, and nothing reads it anyway (the
  // canvas is opaque, the frost reads rgb, no blend uses the target's alpha).
  // The composite's opacity o scales I.a as a whole, which per piece blending
  // cannot copy where pieces overlap, so unfolded the bypass waits for o at
  // 1 (or o at or under 0.002, where the composite is skipped and so is the
  // bypass draw).
  //
  // Folded, the fold's one fullscreen triangle covers each pixel once, so
  // the image is just the fold's output F (F + 0 * (1 - F.a)), and the
  // composite gives (F.rgb * g, F.a) * o over the scene. The fold drawn
  // straight into the scene with colorGain g and gain o gives exactly that
  // (fold.wgsl.js fsFold), so folded the bypass needs no condition on o; it
  // takes the composite's 0.002 cutoff so the two skip together. The pieces
  // go into foldScene's chamber, the scene format fold, and fold's is let go.
  //
  // The one difference is rounding: the old route stores the image in half
  // float between the pieces and the composite, the bypass does not. Far
  // less than the last bit of the screen's 8-bit channel where pieces
  // overlap.
  //
  // It cannot hide trails. With the feedback not in use the half-life is 0
  // on every frame (the swing of a 0 setting with no upper reach is clamped
  // at 0), so the image route itself starts every frame from a clear and
  // never holds one. Taking the image back up makes a new, clear pair.
  let bypass = false;
  const uni = new Float32Array(UNIFORM_FLOATS);
  // The uniform block as last uploaded, bit for bit, and whether there has
  // been an upload. update writes only when this frame's block differs, so a
  // stopped scene with nothing moving uploads nothing, and any change at all,
  // to any of its floats, however it came about (a swaying eye on a stopped
  // scene too), is a differing bit and goes up. Nothing else writes uniBuf.
  const uniBits = new Uint32Array(uni.buffer);
  const upBits = new Uint32Array(UNIFORM_FLOATS);
  let upValid = false;
  // Whether the live list has changed since it was last uploaded. Set by
  // every path that touches order or n (the prewarm and a frame that steps
  // the clock), cleared by the upload.
  let orderDirty = true;
  const foldParams = { folds: 8, mirror: true, rotation: 0, gain: 1, colorGain: 1 };
  // The pulse: this frame's colour gain for the feedback image, and the
  // phase (0 to 1) of its variance's cycle.
  let fbGain = 1, pulsePhase = 0;
  // The feedback image's opacity over the scene (Feedback > Opacity): the
  // composite's after the fold, the fold's gain before it.
  let fbOpacity = 1;
  // The phases (0 to 1) of the Amount, Stream and Twist variances' cycles,
  // each its own, so the three swing independently at their own rates.
  let amtPhase = 0, streamPhase = 0, twistPhase = 0;

  let travel = 0, tumble = 0, spin = 0, drawOn = false;
  let foldRot = 0, kaleidoNow = false, wasOn = false;
  // The domain the live field was filled for: Kaleidoscope, fold count and
  // mirror as they were last frame.
  let prevKaleido = false, prevFolds = 0, prevMirror = true;

  // The CPU's mirror of the slot records, SLOT_FLOATS per slot as the shader
  // reads them (confetti.wgsl.js): birth, speed factor, seed, size factor;
  // then angle, base radius, spin clock at birth, and alignment in percent
  // plus kick over KICK_PACK; then the spin factor and three spares, left 0.
  // And which slots hold a live piece.
  const rec = new Float32Array(N_MAX * SLOT_FLOATS);
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
  // The current wave's ring: its radius, tunnel units, and where the golden
  // ratio placing of its burst pieces has got to, as a share of the circle
  // (or of the wedge, folded).
  let ringR = 1, ringAt = 0;
  // Each birth's variations for this frame, set before the schedule runs:
  // the variances and alignment, the domain births fall in (its
  // start angle and span, radians, and whether folded and mirrored), and the
  // spin clock and travel clock now with the spin's rate per travel-second,
  // to back-date each birth's spin clock.
  let speedVar = 0, sizeVar = 0.2, alignPct = 0;
  // Rotation variance's two sides: a birth's spin factor falls anywhere in
  // [1 + spinLo, 1 + spinHi].
  let spinLo = 0, spinHi = 0;
  let domStart = 0, domSpan = TAU, domFold = 0;
  let spinPerTravel = 0;
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
    let age = now - rec[s * SLOT_FLOATS];
    if (age < -0.5 * W) age += W;
    else if (age < 0) age = 0;
    return age * rec[s * SLOT_FLOATS + 1] / FLIGHT;
  }

  function make() {
    made = true;
    uniBuf = device.createBuffer({ label: 'confetti.uniforms', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    slotBuf = device.createBuffer({ label: 'confetti.slots', size: N_MAX * SLOT_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
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
    // Opaque paper, not light: premultiplied "over", with alpha building up
    // as coverage. These pipelines draw into a fold's chamber (chamberPipe)
    // or a feedback image (imagePipe; scenePipe below is the bypass's), and
    // both are read back as premultiplied colour laid over what lies
    // beneath: alpha left at 0 would take the paper for light and add it
    // instead of laying it over. The two differ only in target format: the
    // chamber is 8 bits a channel, the feedback images half float (see
    // feedback.js).
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
    chamberPipe = pipeFor(FOLD_CHAMBER_FORMAT, overCover, 'confetti.draw.chamber');
    imagePipe = pipeFor(FEEDBACK_FORMAT, overCover, 'confetti.draw.image');
    // The bypass's draw straight into the scene (see bypass): premultiplied
    // over for colour, the scene's alpha left as it is.
    scenePipe = pipeFor(format, {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    }, 'confetti.draw.scene');
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
    // few px across, and a half resolution chamber would blur it away. It
    // folds into fbScreen, not the screen, and its "over" builds alpha up
    // there as coverage, which the composite needs. foldScene is the same
    // fold into the scene, for feedback before the fold.
    fbScreen = createFeedback(device, format, { label: 'confetti.feedback' });
    fbChamber = createFeedback(device, format, { label: 'confetti.feedback.chamber' });
    fold = createFold(device, fbScreen.format, { label: 'confetti.fold', res: 1 });
    foldScene = createFold(device, format, { label: 'confetti.fold.scene', res: 1 });
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

  // A roughly normal random, mean 0 and standard deviation 1, never past 3
  // either way: three uniforms summed, which is cheap and bounded.
  function gauss() {
    return (rand() + rand() + rand() - 1.5) * 2;
  }

  // Starts a new wave of the schedule: its length, longer as Clump rises
  // (WAVE_GROW), and its ring, a radius drawn from the same range as any
  // piece's start and a random point for the golden ratio placing to start
  // from, so no two rings line up.
  function newWave(clump) {
    waveLen = WAVE * (1 + WAVE_JITTER * (2 * rand() - 1)) * (1 + (WAVE_GROW - 1) * clump);
    ringR = R_MIN + (R_MAX - R_MIN) * 0.5 * (rand() + rand());
    ringAt = rand();
  }

  // One piece born at travel time b (wrapped), with c the Clump that shapes
  // it: the Clump for a birth in a wave's burst, 0 for one in the stream
  // between. Everything about it is drawn here, once, from the settings as
  // they are now, so moving the variances, Clump or Alignment only shapes
  // the pieces born after it.
  //
  // Where it starts: an angle all the way round (folded, across the wedge
  // domain the fold reads), and a radius from the range, bias toward the
  // middle, pulled c of the way onto the wave's ring. A burst piece's angle
  // takes the golden ratio's next step round the ring instead of a random
  // one, so the ring is evenly filled; either way every direction is alike.
  // A burst piece also gets its kick outward, c of KICK_REACH times its own
  // KICK_LO to KICK_HI.
  //
  // The spin clock at its birth, for the alignment: the clock now, back-dated
  // by the travel time since b at the spin's rate per travel-second, so a
  // piece born earlier in this frame, or in the prewarm, has already turned
  // as far as it would have, and one born just now shows its aligned pose.
  // Wrapped at the spin clock's period, which the shader allows (it turns a
  // whole number of times in one).
  function birth(b, c) {
    const s = takeSlot(b);
    if (s < 0) return;
    const o = s * SLOT_FLOATS;
    rec[o] = b;
    rec[o + 1] = 1 + speedVar * SPEED_VAR * (2 * rand() - 1);
    rec[o + 2] = (rand() * 16777216) | 0;
    rec[o + 3] = 1 + sizeVar * (2 * rand() - 1);
    let at, kick = 0;
    let rad = R_MIN + (R_MAX - R_MIN) * 0.5 * (rand() + rand());
    if (c > 0) {
      ringAt += GOLDEN;
      if (ringAt >= 1) ringAt -= 1;
      at = ringAt;
      rad += (ringR * (1 + RING_SPREAD * gauss()) - rad) * c;
      kick = KICK_REACH * c * (KICK_LO + (KICK_HI - KICK_LO) * rand());
    } else {
      at = rand();
    }
    let age = travel - b;
    if (age < -0.5 * W) age += W;
    else if (age > 0.5 * W) age -= W;
    if (age < 0) age = 0;
    let sb = (spin - age * spinPerTravel) % TUMBLE_PERIOD;
    if (sb < 0) sb += TUMBLE_PERIOD;
    rec[o + 4] = domStart + domSpan * at;
    rec[o + 5] = rad;
    rec[o + 6] = sb;
    rec[o + 7] = alignPct + Math.min(kick / KICK_PACK, 0.999);
    // The piece's spin factor, drawn evenly across Rotation variance's two
    // sides, once, like its speed and size, so moving the variance only
    // reaches the pieces born from then on. The shader rounds the turns it
    // gives back to a whole number (confetti.wgsl.js), and the spin is still
    // counted from rec[o + 6], this birth's clock, so an aligned piece is
    // born aligned whatever its factor. The spares are cleared, since a slot
    // is reused.
    rec[o + 8] = 1 + spinLo + (spinHi - spinLo) * rand();
    rec[o + 9] = 0; rec[o + 10] = 0; rec[o + 11] = 0;
    alive[s] = 1;
    if (nb < N_MAX) born[nb++] = s;
  }

  // Runs the birth schedule over span travel-seconds from travel time t0,
  // bearing each birth at its exact moment. Within a wave the rate is
  // piecewise constant, base * mix(1, burst / DUTY, clump) with burst 1 in
  // the wave's first DUTY and 0 after, so the average over a wave is base
  // at any Clump. Each stretch of constant rate is walked exactly: a birth
  // falls wherever the carried fraction reaches a whole one. At Clump 100%
  // a wave's pieces are all born inside its first DUTY, about a fifth of a
  // travel-second once the wave has grown, into consecutive slots and onto
  // the wave's ring: a thin ring of pieces that fly down the tunnel
  // together. Only the burst's births are shaped by Clump (see birth); the
  // stream's between are born as at Clump 0.
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
          birth(b, inBurst ? clump : 0);
        }
        acc += r * (seg - at);
        if (acc < 0) acc = 0;
      }
      t += seg;
      wavePos += seg;
      if (wavePos >= waveLen - 1e-9) {
        wavePos = 0;
        newWave(clump);
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
  // gap. Each birth's spin clock is back-dated from now as any birth's is
  // (see birth), at the spin's current rate, so the fill's pieces have turned
  // as far as they would have flying all along. Runs once when the layer
  // turns on or the fold's domain changes, never per frame.
  function prewarm(base, clump) {
    alive.fill(0);
    n = 0; nb = 0; cursor = 0; ringFull = false; acc = 0; filling = true;
    newWave(clump);
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
    orderDirty = true;
    device.queue.writeBuffer(slotBuf, 0, rec);
  }
  const byFar = (a, b) => depthOf(b, nowF) - depthOf(a, nowF);

  function update(t, dt, lum) {
    drawOn = false;
    if (!S.layers || !S.layers.confetti) {
      // Off: nothing draws, and the trails go with it, so the layer comes
      // back from a cleared image.
      wasOn = false; layerOn = false;
      if (made) { fbScreen.release(); fbChamber.release(); }
      return;
    }
    if (!made) make();
    layerOn = true;

    // The frame's step, eased to 0 over the pause wind-down (core/motion.js).
    const step = dt > 0 ? motionStep(dt) : 0;
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
    const spinRate = clampNum(S.confSpin, 0, 3, 1);
    spin += step * spinRate;
    if (spin >= TUMBLE_PERIOD) spin -= TUMBLE_PERIOD;
    // How far the spin clock runs per travel-second, to back-date a birth's
    // spin clock from its travel time (see birth).
    spinPerTravel = spinRate / clampNum(S.confSpeed, 0.1, 2, 1);

    // The fold's domain, as fold.js makes it from the same params: one wedge
    // (TAU over the rounded fold count), half of it with mirror, centred on
    // straight up. Folded, births come at the domain's share of the rate.
    kaleidoNow = !!S.confKaleido;
    const folds = Math.round(clampNum(S.confFolds, 3, 16, 8));
    const mirror = S.confMirror !== false;
    const span = TAU / folds * (mirror ? 0.5 : 1);

    const amount = clampNum(S.confAmount, 0, 1, 0.5);
    const full = Math.min(amount * BASE_RATE, RATE_CAP);
    const base = kaleidoNow ? full * span / TAU : full;
    const clump = clampNum(S.confClump, 0, 1, 0);
    speedVar = clampNum(S.confSpeedVar, 0, 1, 0);
    sizeVar = clampNum(S.confSizeVar, 0, 0.95, 0.2);
    spinLo = clampNum(S.confSpinVarLo, -1, 0, 0);
    spinHi = clampNum(S.confSpinVarHi, 0, 2, 0);
    // Alignment in whole percent, the record's packing of it (the slider's
    // own step), and the domain births fall in: the fold's wedge, or folded
    // off, the whole circle.
    alignPct = Math.round(clampNum(S.confAlign, 0, 1, 0) * 100);
    domStart = kaleidoNow ? UP - span * 0.5 : 0;
    domSpan = kaleidoNow ? span : TAU;

    // A new domain wants a field sized for it at once, not one that drifts
    // there over a whole flight. The fold count and mirror only shape the
    // domain while folded.
    const domainChanged = kaleidoNow !== prevKaleido
      || (kaleidoNow && (folds !== prevFolds || mirror !== prevMirror));
    prevKaleido = kaleidoNow; prevFolds = folds; prevMirror = mirror;

    if (!wasOn || domainChanged) {
      // Just switched on, or onto a new domain: start from a full, moving
      // field.
      wasOn = true;
      prewarm(base, clump);
    } else if (stepT === 0) {
      // The clock has not moved (stopped, or paused past the wind-down), so
      // there are no births, and the list, built last frame at this same
      // travel time, is already this frame's: no piece has finished (each
      // was kept last frame for a flight under 1 at this time), every depth
      // key is the one it has, and it is sorted. So is the pool: no ring
      // advance, nothing to upload.
      nb = 0; advanced = 0; ringFull = false;
    } else {
      orderDirty = true;
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
          device.queue.writeBuffer(slotBuf, upStart * SLOT_FLOATS * 4, rec, upStart * SLOT_FLOATS, advanced * SLOT_FLOATS);
        } else {
          device.queue.writeBuffer(slotBuf, upStart * SLOT_FLOATS * 4, rec, upStart * SLOT_FLOATS, (N_MAX - upStart) * SLOT_FLOATS);
          device.queue.writeBuffer(slotBuf, 0, rec, 0, (end - N_MAX) * SLOT_FLOATS);
        }
      }
    }

    // The births and the list run whatever the look, so pieces keep flowing
    // while the layer is dimmed out and come back mid flow. Only the draw is
    // skipped; the fold and the feedback still run, so trails already made
    // keep fading, streaming and turning.
    const bright = clampNum(S.confBright, 0, 1, 1);
    const opacity = clampNum(S.confOpacity, 0, 1, 1);
    const pieces = n > 0 && bright > 0.002 && opacity > 0.002;

    // The visible field and the rings' projection, as the particles frame
    // them: the drawer covers the left, in device pixels.
    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    const visW = Math.max(1, cssW - inset);
    const maxR = Math.hypot(visW, cssH) * 0.62 * dpr;
    const focal = maxR * Z_NEAR;
    const cx = (inset + visW * 0.5) * dpr, cy = cssH * 0.5 * dpr;

    // This frame's feedback: the half-life from the slider's square (0, no
    // trails), the stream and twist rates, and the frame's step, 0 while
    // stopped, which holds the image. Before the fold only while folded
    // with trails; otherwise after, the one route.
    //
    // Each of the three first swings by its variance (see swing and the top
    // of this file), its phase advancing by the frame's step over its rate,
    // so a stopped scene holds the swing where it is, as the pulse's does.
    // The route keys off the feedback being in use, the setting or its upper
    // reach above 0, rather than off this frame's swung amount, so a swing
    // that passes through 0 clears for those frames (keepHalfLife 0, exactly
    // the slider at 0) without letting one image go and making the other.
    amtPhase += step / clampNum(S.confFbAmtVarRate, 1, 120, 20);
    amtPhase -= Math.floor(amtPhase);
    streamPhase += step / clampNum(S.confFbStreamVarRate, 1, 120, 20);
    streamPhase -= Math.floor(streamPhase);
    twistPhase += step / clampNum(S.confFbTwistVarRate, 1, 120, 20);
    twistPhase -= Math.floor(twistPhase);
    const fbBase = clampNum(S.confFeedback, 0, 1, 0);
    const amtHi = clampNum(S.confFbAmtVarHi, 0, 1, 0);
    const fbS = swing(fbBase, clampNum(S.confFbAmtVarLo, -1, 0, 0), amtHi, amtPhase, 0, 1);
    const fbStream = swing(clampNum(S.confFbStream, -2, 2, 0),
      clampNum(S.confFbStreamVarLo, -4, 0, 0), clampNum(S.confFbStreamVarHi, 0, 4, 0), streamPhase, -2, 2);
    const fbTwistBase = clampNum(S.confFbTwist, -1, 1, 0);
    // confFbTwistVarMix crossfades the plain setting into the swing while
    // the performance window brings the variance in or out (1 when unset)
    const twistMix = clampNum(S.confFbTwistVarMix, 0, 1, 1);
    const fbTwist = S.confFbTwistVarOn === false ? fbTwistBase
      : fbTwistBase + (swing(fbTwistBase, clampNum(S.confFbTwistVarLo, -2, 0, 0),
        clampNum(S.confFbTwistVarHi, 0, 2, 0), twistPhase, -1, 1) - fbTwistBase) * twistMix;
    S.effConfFeedback = fbS;
    S.effConfFbStream = fbStream;
    S.effConfFbTwist = fbTwist;
    const fbInUse = fbBase > 0 || amtHi > 0;
    before = kaleidoNow && fbInUse && S.confFbWhere === 'before';
    fbParams.keepHalfLife = HL_MAX * fbS * fbS;
    fbParams.zoomRate = STREAM_MAX * fbStream;
    fbParams.twistRate = TWIST_MAX * fbTwist;
    fbParams.dt = step;

    // Pulse with strobe: the amount p, swung by its variance the way every
    // variance in the app swings (core/strobe.js's depth and brightness):
    // over one Variance rate cycle it eases from the setting down by the
    // variance's share and back, so at 100% from the full setting to nothing
    // and back. Then the colour gain from the strobe's lum. Stopped, the
    // phase holds and the strobe reports a steady lum, so the gain holds too.
    pulsePhase += step / clampNum(S.confFbPulseRate, 1, 60, 10);
    pulsePhase -= Math.floor(pulsePhase);
    let pulse = clampNum(S.confFbPulse, 0, 1, 0);
    const pulseVar = clampNum(S.confFbPulseVar, 0, 1, 0);
    if (pulseVar > 0) pulse *= 1 - pulseVar * 0.5 * (1 - Math.cos(TAU * pulsePhase));
    pulse = scaledStrobeDepth(pulse);
    S.effConfFbPulse = pulse;
    const l = lum > 0 ? (lum < 1 ? lum : 1) : 0;
    fbGain = 1 - pulse + pulse * l;
    fbOpacity = clampNum(S.confFbOpacity, 0, 1, 1);
    // With trails, the layer's Opacity rides the image as it lands rather
    // than the pieces going into it (uni[23] is 1 then), so the trails
    // already laid dim with the slider, and a layer faded out takes them
    // with it instead of leaving them up until it switches off. Without
    // trails it stays per piece, as the bypass needs.
    if (fbInUse) fbOpacity *= opacity;
    // The bypass (see its note above): the feedback not in use, and
    // unfolded, an opacity the pieces can carry exactly.
    bypass = !fbInUse && (kaleidoNow || fbOpacity === 1 || fbOpacity <= 0.002);
    // Before the fold the fold's colour gain carries it, and so on the
    // bypass, where the fold goes straight into the scene. After, the fold
    // draws into the feedback image, where a gain would be baked into the
    // trails, so it stays 1 and the composite carries it instead.
    foldParams.colorGain = before || bypass ? fbGain : 1;

    // Where the draw lands: the feedback image about the field centre, or
    // with Kaleidoscope on the fold's chamber (see fold.js for the mapping),
    // which before the fold is fbChamber standing in for it. Only the fold
    // in use keeps a chamber.
    if (kaleidoNow) {
      // The params first: the chamber is sized to the domain they make.
      // Brightness is already in the pieces' colour, so the fold adds none.
      foldRot += clampNum(S.confFoldSpin, -1, 1, 0.05) * 0.5 * step;
      foldParams.folds = folds;
      foldParams.mirror = mirror;
      foldParams.rotation = foldRot;
      // Before the fold, the fold's gain is the image's opacity (it scales
      // colour and alpha alike, and skips the draw near 0); after, the fold
      // draws into the image, so it stays 1 and the composite carries it.
      // The bypass likewise, the fold going straight into the scene.
      foldParams.gain = before || bypass ? fbOpacity : 1;
      const fd = before || bypass ? foldScene : fold;
      (fd === foldScene ? fold : foldScene).releaseChamber();
      fd.ensureChamber(pixelW, pixelH, foldParams, before);
      fd.fit(cx, cy);
      const f = fd.frame;
      uni[0] = f[4]; uni[1] = f[5]; uni[4] = f[2]; uni[5] = f[3]; uni[22] = f[6];
    } else {
      uni[0] = cx; uni[1] = cy; uni[4] = 1 / pixelW; uni[5] = 1 / pixelH; uni[22] = 1;
      fold.releaseChamber();
      foldScene.releaseChamber();
    }
    // The feedback image in use, sized, with its centre in its own texels
    // and its unit: how many of its texels one tunnel unit of scene covers.
    // A drawer slide changes the projection twice over, moving the centre
    // AND shrinking focal with the visible field, so the trails must be
    // rescaled about the centre by the unit's ratio as well as carried to
    // the new centre (feedback.js does both from cx, cy and unit). On
    // screen the unit is focal itself; in the chamber it is focal times the
    // chamber's texels per device pixel, which fold.fit also lowers a
    // little while the centre sits off the middle. The image not in use is
    // let go, so coming back to it starts clear.
    if (bypass) {
      fbScreen.release();
      fbChamber.release();
    } else if (before) {
      const f = foldScene.frame;
      fbChamber.ensure(f[0], f[1]);
      fbParams.cx = f[4]; fbParams.cy = f[5]; fbParams.unit = focal * f[6];
      fbScreen.release();
    } else {
      fbScreen.ensure(pixelW, pixelH);
      fbParams.cx = cx; fbParams.cy = cy; fbParams.unit = focal;
      fbChamber.release();
    }

    if (!pieces) return;
    if (orderDirty) {
      device.queue.writeBuffer(orderBuf, 0, order, 0, n);
      orderDirty = false;
    }
    const pal = S.confPalette === 'strobe' ? 1 : S.confPalette === 'gold' ? 2 : 0;
    const rgb = S.rgb;
    uni[2] = focal; uni[3] = dpr;
    // Unfolded on the bypass the pulse's gain rides in the brightness,
    // which scales the pieces' colour alone, as the composite's gain would
    // have scaled the image's (see bypass).
    uni[6] = MAX_HALF_CSS * dpr; uni[7] = bypass && !kaleidoNow ? bright * fbGain : bright;
    uni[8] = travel; uni[9] = W; uni[10] = 0; uni[11] = tumble;
    uni[12] = shapeMask(S.confShapes); uni[13] = clampNum(S.confSize, 0.2, 50, 1); uni[14] = clampNum(S.confShine, 0, 1, 0.35); uni[15] = pal;
    uni[16] = rgb[0] / 255; uni[17] = rgb[1] / 255; uni[18] = rgb[2] / 255; uni[19] = Z_FAR;
    uni[20] = clampNum(S.confSpread, 0, 1, 0); uni[21] = clampNum(S.confFlutter, 0, 1, 1); uni[23] = fbInUse ? 1 : opacity;
    uni[24] = clampNum(S.confFade, 0, 1, 0.55); uni[25] = Z_NEAR; uni[26] = spin; uni[27] = clampNum(S.confTumble, 0, 1, 1);
    uni[28] = clampNum(S.confLife, 0.05, 1, 1);
    uni[29] = kaleidoNow ? (mirror ? 2 : 1) : 0; uni[30] = UP - span * 0.5; uni[31] = span;
    // The viewer's eye, tunnel units (core/eye.js). It needs no overscan: no
    // piece is trimmed to the visible field (each flies its whole flight,
    // on screen or off, and the rasteriser does the clipping), so whatever
    // leaning brings in from past the edge is already there to be drawn.
    uni[32] = eye.x; uni[33] = eye.y; uni[34] = 0; uni[35] = 0;
    let same = upValid;
    for (let i = 0; same && i < UNIFORM_FLOATS; i++) if (uniBits[i] !== upBits[i]) same = false;
    if (!same) {
      device.queue.writeBuffer(uniBuf, 0, uni);
      upBits.set(uniBits);
      upValid = true;
    }
    drawOn = true;
  }

  // Encoded by the engine before the scene pass: this frame's feedback
  // image. The pieces go in far to near, as the list runs. Folded, two
  // instances a piece: the piece and its twin across the nearer domain edge,
  // which collapses unless the card straddles it (see confetti.wgsl.js).
  // The feedback's own pass fades, streams and turns the last image in (or
  // clears), so it runs even with no pieces to draw and trails keep dying
  // away while the layer is dimmed out. Held (stopped with trails), nothing
  // is encoded and the image stays as it is.
  function encode(encoder) {
    if (!layerOn) return;
    // The bypass: no image. Folded, the pieces into foldScene's chamber,
    // which draw() folds straight into the scene; unfolded, nothing here.
    // Both skip where the composite would have (opacity at or under 0.002).
    if (bypass) {
      if (drawOn && kaleidoNow && fbOpacity > 0.002 && foldScene.chamberView) {
        const cp = encoder.beginRenderPass(foldScene.chamberPassDesc);
        cp.setPipeline(chamberPipe);
        cp.setBindGroup(0, bind);
        cp.draw(6, 2 * n);
        cp.end();
      }
      return;
    }
    // Before the fold: the pieces straight into fbChamber, in chamber space.
    // An image already faded to nothing with no pieces to add is skipped
    // (feedback.js begin), as is its fold, which gets no view.
    if (before) {
      const cp = fbChamber.begin(encoder, fbParams, drawOn);
      if (!cp) return;
      if (drawOn) {
        cp.setPipeline(imagePipe);
        cp.setBindGroup(0, bind);
        cp.draw(6, 2 * n);
      }
      fbChamber.end(cp);
      return;
    }
    // After the fold, or unfolded: folded, the pieces into the fold's own
    // chamber first, and the fold draws that into fbScreen; unfolded, the
    // pieces straight into fbScreen.
    // Held, begin only carries the image with the field (feedback.js).
    if (fbScreen.holds(fbParams)) { fbScreen.begin(encoder, fbParams, false); return; }
    const folded = drawOn && kaleidoNow && fold.chamberView;
    if (folded) {
      const cp = encoder.beginRenderPass(fold.chamberPassDesc);
      cp.setPipeline(chamberPipe);
      cp.setBindGroup(0, bind);
      cp.draw(6, 2 * n);
      cp.end();
    }
    // Whether anything goes in: an image already faded to nothing with
    // nothing to add is skipped, and so is its composite (feedback.js).
    const lp = fbScreen.begin(encoder, fbParams, !!folded || (drawOn && !kaleidoNow));
    if (!lp) return;
    if (folded) {
      fold.draw(lp, foldParams);
    } else if (drawOn && !kaleidoNow) {
      lp.setPipeline(imagePipe);
      lp.setBindGroup(0, bind);
      lp.draw(6, n);
    }
    fbScreen.end(lp);
  }

  // Inside the scene pass, over the fireworks and under the edge: the
  // feedback image over the scene, or before the fold, the fold reading
  // fbChamber into the scene. Either way the image's colour is scaled by the
  // pulse's gain as it goes over (foldParams.colorGain before the fold).
  function draw(pass) {
    if (!layerOn) return;
    if (bypass) {
      if (!drawOn || !(fbOpacity > 0.002)) return;
      if (kaleidoNow) { if (foldScene.chamberView) foldScene.draw(pass, foldParams); return; }
      pass.setPipeline(scenePipe);
      pass.setBindGroup(0, bind);
      pass.draw(6, n);
      return;
    }
    if (before) { foldScene.drawFrom(pass, foldParams, fbChamber.view); return; }
    fbScreen.composite(pass, fbGain, fbOpacity);
  }

  return { update, encode, draw, resize };
}
