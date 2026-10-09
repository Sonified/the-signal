// Owns the kaleidoscope layer: a pool of small motifs (leaves, flowers,
// stars, sweets, gems, light) tumbling through one object chamber, and the
// fold that turns that chamber into the whole N-fold pattern, the way a real
// kaleidoscope works. It reads S every frame and does no work at all while
// S.layers.kaleido is off.
//
// A real kaleidoscope has one chamber of loose objects and a set of mirrors;
// everything else is reflection. So each object here exists once. The
// chamber is an offscreen texture in the screen's own frame about the field
// centre (half resolution, and edge-inset aware, so opening the drawer
// recentres it as it does the rings and flowers), and every object is drawn
// into it once per frame, in one instanced draw, wherever it happens to be.
// Only the fundamental domain matters, a single wedge pointing straight up
// (the whole wedge, or with mirror half of it), but the objects do not know
// that: they stream out from the centre in a continuous zoom, every radius
// growing by the same factor each second, so they are spread evenly in log
// radius from the centre to the rim and the pattern looks alike at every
// scale; they grow as they come, and at the same time sweep sideways across
// the wedge at their own angular rate, so they are thrown across the part
// that gets repeated, drift in from outside it, cross it and leave. How many
// there are follows from Density as a share of the domain covered, not as a
// count (see coverageTarget). By default each is born on the domain's centre line, sized to fit
// inside it and pointing straight out, so until that sweep carries it into
// a mirror it shows whole in every wedge (see SEAT_ON_MIRROR and the
// kaleidoScatter setting). The fold pass, drawn in the scene pass after the
// flowers and before the edge particles, then turns every screen pixel's
// angle back into that wedge and reads the chamber there. Every object is repeated round the
// circle by construction, merges with its own reflection at a mirror line and
// splits from it again, and no seam can open because there is nothing to
// line up. See kaleido.wgsl.js for the fold itself.
//
// Mirror off, the pattern is plain rotation, which only closes up if the
// chamber is periodic: what leaves one side of the wedge must be arriving at
// the other. So in that mode an object's angle wraps round the wedge, and one
// straddling an edge is drawn once more on the far side. Mirror on, the
// mirror line itself is the continuity, and objects roam a band one wedge
// wider than the domain on each side, re-entering from the far side of the
// band once they have wandered out of it.
//
// A change of fold count or of mirror is instant at Symmetry slide 0
// (S.kaleidoFoldXfade). With a slide time the fold is drawn twice for that
// long, the symmetry it left fading out under the new one fading in, both
// reading the one chamber (see trackSymmetry).
//
// The motif atlas is loaded lazily, the first time the layer is switched on,
// and nothing is drawn until it is ready. S.kaleidoSet picks which atlas
// (assets/kaleidoscope/sets.mjs); changing it loads the other one in the
// background. With Set crossfade at instant (S.kaleidoSetXfade 0) the new
// atlas is swapped in under the live shapes once it is built. With a
// crossfade time, nothing is swapped under anything: every piece remembers
// the atlas it was born from and keeps drawing from it until it retires,
// while the births tip over from the old set to the new across that time,
// its clock starting only once the new atlas is ready. So two atlases can be
// live at once, in two slots (see slots), and the sprite pass binds both.
// The atlas the renderer works
// with is 8 x 8 tiles of 128 px with 12 px of transparent padding. A smaller
// square 8 x 8 atlas (set 1, the botanical atlas, is 512 px, 64 px
// tiles with no padding) is first repacked into that layout, each tile
// scaled into the 104 px inner square (see repack). A set's high resolution
// sheet (sets.mjs imageHi, drawn while S.kaleidoHiRes is on) is repacked
// into a layout half again as large instead, 192 px tiles round a 156 px
// inner square, so its detail survives (see LAYOUT_HI). Each atlas slot
// carries its own layout to the shader, so one of each can be live at once.
// The high resolution atlas with its mips is about 12 MB of GPU memory,
// against 5.6 MB for an ordinary one.
// Its background removal left a faint matte around every motif: tens of
// thousands of nearly transparent, nearly white pixels. One of them is
// nothing; the same rim folded into dozens of copies is white fuzz around
// everything. So the atlas is cleaned on the way in. Every pixel that is not
// solid takes its colour from the nearest solid pixel of its own motif (a
// wave of neighbour dilation outward from the solid body), which leaves the
// soft edges soft but the colour of the motif rather than of the old matte;
// then anything still close to invisible goes fully transparent, and the
// result is premultiplied and given a short mip chain.
//
// The pool is struct-of-arrays, allocated once. Per frame the CPU side
// advances the live objects, spawns and retires them, keeps their paint order
// in place, and writes at most MAX_INST instances plus one small uniform
// block into buffers allocated once. The chamber texture is made the first
// time the layer draws after a resize, never in an ordinary frame. No
// allocation in update(), encodeChamber() or draw().
//
// Trails (the Trails drawer) are video feedback with the Confetti layer's
// rows, ranges and clocks (gpu/confetti.js has the long notes), laid out as
// the Edge layer's are (gpu/scene.js): an echo beside the live pattern, never
// in place of it. The live fold draws straight into the scene every frame
// exactly as it did before trails existed, at the layer's own Opacity and
// Pulse, untouched by any trail setting. With Amount above 0 the same fold
// also goes into a feedback image of the layer's own (feedback.js), over a
// faded, streamed and turned copy of the last, and that image is laid over
// the scene just before the live fold, at the Trails Opacity (times the
// layer's, so a layer faded out takes its trails along) with the Trails
// Pulse on its colour, so the echoes read as history under the present.
// Where the live pattern is soft or see-through, the echo's own newest
// copy of it shows a little through it, a slight thickening of soft edges
// while trails are up; at Trails Opacity 0 the echo is skipped and the
// picture is exactly the live fold.
//
// The feedback sits after the fold: the whole pattern trails, streaming
// and turning about its centre, the view as it is seen. Before the fold,
// the chamber itself would trail, in the wedge only; but the chamber is
// resized by every change of fold count, mirror or symmetry slide, which
// would clear the trails each time, and a slide's two folds read one
// chamber, so after the fold is both the simpler route and the one that
// carries the Symmetry slide and the Set crossfade through unbroken (both
// simply change what is folded in). The route is chosen from Amount's
// setting alone, not its dipped value, so a dip through 0 clears for those
// frames without letting the image go. At Amount 0 there is no image and no
// echo at all. Amount, Stream, Twist and Pulse swing on the layer's own
// clocks, pulled onto the room clock in a broadcast room, and the Opacity
// dips with the strobe's own variances, each exactly as confetti's do. The
// image is made the first frame trails are in use and let go when Amount
// goes back to 0 or the layer goes off.

import { S } from '../js/state.js';
import { scaledStrobeDepth } from '../js/strobe-scale.js';
import { KALEIDO_WGSL } from './kaleido.wgsl.js';
import { MIP_WGSL } from './flowers.wgsl.js';
import { radialFade, radialFadeIn, RADIAL_FADE_OUT_K } from '../core/fade.js';
import { motionStep } from '../core/motion.js';
import { kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';
import { createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT } from './feedback.js';
import { roomPhase, roomPhaseState } from '../core/room-clock.js';

const GRID = 8;                     // every atlas is an 8 x 8 tile sheet
const MOTIFS = GRID * GRID;
const SOLID = 200;                  // alpha at or above this keeps its own colour
const ALPHA_CUT = 40;               // alpha below this goes fully transparent

// Live objects, the densest setting's ceiling. They all go to the chamber in
// one instanced draw, and the fold makes every mirrored copy for free, so
// even the ceiling is a light load.
const MAX_SHAPES = 2048;
// Instances: one per object, plus the wrap-round copies of rotation mode,
// where an object straddling an edge of the wedge is drawn on both sides.
// Room for every live shape's copies with margin, so paint order cannot
// cause a piece to be dropped at the instance limit.
const MAX_INST = 4 * MAX_SHAPES;
// The packed layouts an atlas is built into: its tile, the transparent
// padding round each motif and the inner square inside it that the quad
// covers (see kaleido.wgsl.js), the atlas's side, its mip levels, whether a
// sheet already that size is taken as already in the layout (otherwise it
// is always repacked), and the same as UV for the shader. A motif's fill is
// measured against its own layout's inner square, as a share, so the
// coverage solve reads both layouts alike.
function atlasLayout(tile, pad, mips, prepadded) {
  const atlas = tile * GRID, inner = tile - 2 * pad;
  return Object.freeze({ tile, pad, inner, atlas, mips, prepadded,
                         padUV: pad / atlas, innerUV: inner / atlas, halfTexel: 0.5 / atlas });
}
// Every ordinary set: 128 px tiles round a 104 px motif, 1024 square, as
// the 128 px sheets come. Mips 1024 down to 128. The 12 px padding is still
// a texel and a half at the last of these, which with the shader's clamp
// keeps every tap inside its own motif; below it the padding runs out and
// neighbours would bleed.
const LAYOUT_STD = atlasLayout(128, 12, 4, true);
// A high resolution sheet: the same proportions half again as large, 192 px
// tiles round a 156 px motif with 18 px of padding, 1536 square, so a
// motif's framing in its quad is the same in both and only its detail
// changes. The sheet's 192 px tiles are whole motifs with their own margin
// (as the 64 px tiles of set 1's ordinary sheet are), so it is always
// repacked, each tile scaled into the inner square. One mip level more,
// 1536 down to 96 (192 px tiles halve cleanly at every level), so a
// far-off motif is never sampled coarser than an ordinary set's smallest;
// the 18 px padding is still 1.125 texels at the last, and the shader's
// clamp sits half a texel inside the motif, so a bilinear tap is 1.16
// texels from the tile's edge there and stays inside its own motif.
const LAYOUT_HI = atlasLayout(192, 18, 5, false);
// The sampler is shared by both atlases, so it may reach the deepest level
// either layout has; an ordinary atlas's own view has only its four, and
// the read is clamped to those as it always was.
const MAX_MIP_LEVELS = LAYOUT_HI.mips;
// The motifs' mean painted share of the inner square if the atlas has not
// said: measured over the v1 atlas it is 0.41.
const DEFAULT_FILL = 0.41;
const MAX_FOLDS = 32;
const INST_FLOATS = 8;              // x y half alpha | upX upY motif atlas slot
const UNIFORM_FLOATS = 32;          // see kaleido.wgsl.js's struct KU
// Where the two slots' layouts sit in the uniforms (KU's lay0 and lay1).
const U_LAY0 = 24, U_LAY1 = 28;

const TAU = Math.PI * 2;
const UP = -Math.PI * 0.5;          // the domain's centre line, straight up the screen
// ?kaldiag=1 in the page's address: one console line each time the drawn
// instance count falls by more than a quarter in a frame (naming whatever
// structural event last ran), one on every structural event itself (a set
// change, a prewarm, a resize, a change of folds or mirror), and a
// heartbeat every two seconds with the live count, the drawn count and how
// many overlapping pairs swapped draw order since the last beat (an
// overtake flips which piece is on top where they cross, which can read as
// a pop). Page mode only, as confetti's confdiag; one boolean test a frame
// when off.
const KDIAG = (() => { try { return /[?&]kaldiag=1(&|$)/.test(location.search); } catch (e) { return false; } })();
// Chamber texels per device pixel at the canvas's own half diagonal. The
// fold reads it with bilinear filtering, so half resolution is soft only
// where a motif is already large.
const CHAMBER_RES = 0.5;
// Transparent texels kept round the chamber's working area, so a bilinear
// read at the very centre or the far rim never touches the texture's edge.
const CHAMBER_PAD = 4;
// The chamber is only as wide as the domain the fold reads: half of it
// reaches the domain's half angle either side of straight up, 60 degrees at
// the widest (a whole 3-fold wedge) but 11.25 at the default 8 folds
// mirrored, where a chamber sized for the widest would clear and store more
// than four times the texels any fold ever reads. See ensureChamber.
// Density is coverage, not a count. At density 1 the objects' painted area,
// summed, is this many times the area of the fundamental domain they show
// in, so the domain is packed with a little overlap; 0.5 is half that, a
// comfortably populated chamber, and 0 is empty. The live count follows
// from it, whatever the folds, mirror, size or scatter (see coverageTarget).
const COVER_FULL = 1.2;
// Mirrored, how far beyond each side of the domain an object may roam, in
// domain widths, before it re-enters from the other side. Wide enough that
// the objects arrive from outside rather than appearing at the edge.
const BAND_EXTRA = 1;
// The flow is a continuous zoom: every object's radius grows by the same
// factor each second, the classic endless kaleidoscope. A perspective
// flight evenly spaced in depth spends most of its time small near the
// centre and passes the rim in a rush, so few objects were ever large at
// once; evenly spaced in log radius, every scale from the centre out holds
// its fair share. An object is born at K_BIRTH of the rim radius, a few
// device pixels out, wholly inside the fold's hole (see HOLE_PAD_TEXELS), and
// retires at the rim. ZOOM_RATE
// is the growth in e-folds per second at kaleidoSpeed 1: 0.3 is a factor of
// 1.35 a second, doubling in about 2.3 s, a whole flight of about 15 s.
const K_BIRTH = 0.01;
const LOG_SPAN = -Math.log(K_BIRTH);    // e-folds from birth to the rim
const ZOOM_RATE = 0.3;
// With Speed at 0 nothing flies out, so an object's life is taken as this
// long when working out how far its orbit spreads it (inDomainShare).
const STILL_LIFE = 60;
// An object's fade toward the centre is the rings' radial fade (core/fade.js)
// at the Fade in setting, against the same rim, so the two layers ease in
// together. At Fade in 0 the radial fade is 1 all the way in, so on its own
// a shape would pop into being at K_BIRTH, inside the very domain the fold
// shows (the domain's apex is the centre). Nothing is born where the fold
// can see it: the fold reads nothing inside a small hole about the centre
// and opens to a full read by twice its radius (see kaleido.wgsl.js), and
// the hole is sized every frame to hold the largest newborn whole, its
// painted reach plus HOLE_PAD_TEXELS of the chamber for the fold's bilinear
// read. A newborn then comes into view only by flying out across that edge.
// The rim needs no such care: the radial fade out there is exactly 0, so an
// object retiring at the rim was already wholly invisible.
//
// The coverage solve still treats the first FADE_IN_EFOLDS of the flight
// (out to about twice the birth radius, much the same span as the hole and
// its soft edge) as fading in, so the visible band it counts from is where
// it has always been. No object's own alpha carries this any more; that was
// a fade on the spot, inside the domain.
const FADE_IN_EFOLDS = 0.7;
const FADE_IN_D = FADE_IN_EFOLDS / LOG_SPAN;
// Chamber texels of clearance between a newborn's farthest painted pixel and
// the hole's edge: one for the fold's bilinear read, one to spare.
const HOLE_PAD_TEXELS = 2;
// Bisection steps for fadeHalfK, ample for float precision over log radius.
const FADE_HALF_STEPS = 40;
// When the target count moves (a density change, or a fold, mirror or size
// change that alters how many objects the coverage takes), the difference is
// made up along the whole flight, not only at the centre, so the new density
// shows within a second or two: new objects appear at random points of the
// flight and fade in on the spot over APPEAR_SECONDS, and surplus ones fade
// out where they are. FILL_TAU is that catch-up's time constant and
// FILL_MIN_RATE its floor in objects per second; a gap within FILL_DEADBAND
// of the target (plus two) is the ordinary trickle of births and
// retirements, left to settle on its own.
const APPEAR_SECONDS = 0.6;
const FILL_TAU = 0.5;
const FILL_MIN_RATE = 30;
const FILL_DEADBAND = 0.08;
// Quadrature steps per axis for inDomainShare.
const SHARE_STEPS = 16;
// Speed variance: each object travels faster or slower than the average,
// by up to the setting's share of it either way, so the motifs drift past
// one another instead of marching out in lockstep. Its own speed is the
// sine of a phase drawn at birth, and Variance rate is the seconds one
// cycle of it takes: each object surges and slows on that period, scaled
// by its own velW so they never pulse together. SPEED_FLOOR keeps a
// full-variance object from stalling at the centre for good.
const SPEED_FLOOR = 0.1;
// With spin variance at 0 every object turns at this fraction of the maximum
// rate, all the same way, which reads as one slow shared sway.
const COMMON_SPIN = 0.5;
// A quad's corner reach against its half size: half * sqrt 2. It is also
// how far a motif's painted pixels can reach from its centre, whichever way
// it has spun: measured over the atlas, the farthest visible pixel of the
// widest motifs sits 1.37 half sizes out, just inside this.
const CORNER = 1.4143;
// Every object is born on its seat line, the line through the domain where
// it sits clear of both edges, with its up axis along that line and so
// pointing straight out; Scatter spreads births away from it. Anything past
// an edge of the domain is replaced by reflections, so a motif stays whole
// only while all of it stays inside. Mirror off, the seat line is the
// wedge's centre line; mirror on, it is the centre line of the half-wedge
// domain, halfway between the two mirror lines. (A motif centred on a
// mirror line instead meets its own reflection and shows one half of itself
// twice: whole only for a motif that is symmetric and not spinning, and many
// in the atlas are neither, the moon, the comet, the wave, the wing. Set
// SEAT_ON_MIRROR to seat mirrored objects on the mirror lines, fitted to the
// whole domain width, which doubles their size.)
const SEAT_ON_MIRROR = false;
// The size law: at Max size 1 the largest object's painted reach (half *
// CORNER) is the distance from its seat line to the nearest domain edge at
// its radius, r * sin(fit angle), less this margin, so at every radius it
// fits whole and grows with perspective as it comes. Max size above 1
// deliberately overflows into the mirrors. Capped so the widest wedges (3
// folds, unmirrored) do not blow a motif up to fill the screen.
const FIT_MARGIN = 0.06;
const SIZE_CAP = 0.8;
// Below this half size in chamber texels a motif is not worth a quad.
const MIN_HALF_TEXELS = 0.25;
// Switching the layer on fills the chamber at once, as if it had been
// running all along, and fades that first population in over this long.
const FADE_IN_SECONDS = 1.2;
// Constant size. An object normally grows with its radius; with the toggle
// on it keeps the size it would have at this fraction of the way to the rim,
// from there to the rim. Nearer the centre the wedge is too narrow for that
// size, so there it keeps growing with its radius as it would without the
// toggle, fitted whole. The
// switch between the two laws eases over a short time constant, so toggling
// it mid-run slides every live object to its new size instead of popping.
const CONST_K = 0.35;
const CONST_EASE_SECONDS = 0.25;

// The sheet a set is drawn from: its high resolution one while the High
// resolution toggle is on (missing means on) and it has one, else its own.
function atlasUrl(set) {
  return S.kaleidoHiRes !== false && set.imageHi ? set.imageHi : set.image;
}
// The layout a sheet is packed into (see LAYOUT_HI).
function layoutFor(set, url) {
  const def = kaleidoscopeSet(set);
  return def.imageHi && url === def.imageHi ? LAYOUT_HI : LAYOUT_STD;
}

// Trails, confetti's own constants (gpu/confetti.js): the half-life in
// seconds at Amount 100% (HL_MAX times the slider's square), the stream's
// e-folds a second at full either way, and the twist's radians a second.
const HL_MAX = 2.0;
const STREAM_MAX = 0.5;
const TWIST_MAX = 0.8;

// One setting swung by its variance at a phase (0 to 1) of its cycle,
// confetti's swing: the positive half of a sine carries it up by as much
// as hi, the negative half down by as much as -lo, clamped to min..max.
function swing(base, lo, hi, phase, min, max) {
  if (lo === 0 && hi === 0) return base;
  const osc = Math.sin(TAU * phase);
  const v = base + (osc >= 0 ? osc * hi : -osc * lo);
  return v < min ? min : v > max ? max : v;
}

function clampNum(v, lo, hi, def) {
  if (typeof v !== 'number' || !(v === v)) return def;
  return v < lo ? lo : (v > hi ? hi : v);
}
// A travel fraction to its share of the rim radius. Travel is log radius
// rescaled to run from 0 at birth to 1 at the rim, so an even step of travel
// is an even factor of radius.
function radiusK(d) {
  return Math.exp(-LOG_SPAN * (1 - d));
}
// The length of the overlap of [a, b] with [lo, hi], or 0.
function overlap(a, b, lo, hi) {
  const x = (b < hi ? b : hi) - (a > lo ? a : lo);
  return x > 0 ? x : 0;
}
function smoothstep(a, b, x) {
  const t = x <= a ? 0 : (x >= b ? 1 : (x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
// How visible an object is toward the centre at travel d, for the coverage
// solve: the radial fade in at setting f times the fold's hole, stood in for
// by a fade over the first FADE_IN_EFOLDS. The fade out at the rim is not
// part of it.
function centreFade(f, d) {
  const birth = d < FADE_IN_D ? smoothstep(0, FADE_IN_D, d) : 1;
  return radialFadeIn(f, radiusK(d)) * birth;
}
// The radius fraction where centreFade first reaches one half, the inner
// edge of the band the coverage solve treats as visible. Both factors rise
// monotonically with d, so a bisection over travel finds it; it runs only
// when the coverage target is worked out again, never per frame. Capped
// just inside the fade out, so the band never closes up at Fade in 100%.
function fadeHalfK(f) {
  let lo = 0, hi = 1;
  for (let i = 0; i < FADE_HALF_STEPS; i++) {
    const mid = (lo + hi) * 0.5;
    if (centreFade(f, mid) < 0.5) lo = mid; else hi = mid;
  }
  const k = radiusK(hi), cap = RADIAL_FADE_OUT_K * 0.95;
  return k < cap ? k : cap;
}

// Between tiles the atlas repack and cleanup yield the main thread. The v1
// frame loop hands in core/chores.js's choreYield, which resumes them on a
// dark-frame slot, so a slow tile can only ever lengthen a dark gap; with
// nothing handed in they yield to a zero timeout as before.
let yieldFn = null;
export function setKaleidoYield(fn) { yieldFn = fn; }
function timeoutTick(r) { setTimeout(r, 0); }
function yieldTile() { return yieldFn ? yieldFn() : new Promise(timeoutTick); }

export function createKaleido(device, format, platform) {
  // The fold binds the chamber and a bilinear sampler; the sprite pass binds
  // the motif atlas and its trilinear sampler, plus the second atlas a set
  // crossfade keeps live (binding 3), so it has a layout of its own.
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ]
  });
  const spriteBgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
    ]
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const spriteLayout = device.createPipelineLayout({ bindGroupLayouts: [spriteBgl] });
  const mod = device.createShaderModule({ code: KALEIDO_WGSL });
  if (mod.getCompilationInfo) {
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn('kaleido.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }

  // Premultiplied over, as the flowers: the motifs are objects, both where
  // they pile up in the chamber and where the fold lays them on the field.
  const over = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
  };
  const CHAMBER_FORMAT = 'rgba8unorm';
  const spritePipe = device.createRenderPipeline({
    layout: spriteLayout,
    vertex: {
      module: mod, entryPoint: 'vsSprite',
      buffers: [{
        arrayStride: INST_FLOATS * 4, stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' }
        ]
      }]
    },
    fragment: { module: mod, entryPoint: 'fsSprite', targets: [{ format: CHAMBER_FORMAT, blend: over }] },
    primitive: { topology: 'triangle-list' }
  });
  const foldPipe = device.createRenderPipeline({
    layout,
    vertex: { module: mod, entryPoint: 'vsFold' },
    fragment: { module: mod, entryPoint: 'fsFold', targets: [{ format, blend: over }] },
    primitive: { topology: 'triangle-list' }
  });

  const uniBuf = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const instBuf = device.createBuffer({ size: MAX_INST * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const uni = new Float32Array(UNIFORM_FLOATS);
  const inst = new Float32Array(MAX_INST * INST_FLOATS);
  // Trilinear, so a motif growing out of the centre slides smoothly
  // up the mip chain instead of stepping between levels.
  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    lodMaxClamp: MAX_MIP_LEVELS - 1
  });
  // The chamber has one level; the fold reads it bilinearly.
  const chamberSampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
  });

  // ---------- the chamber ----------
  // Sized on resize and on a change of fold count or mirror, made lazily. It
  // spans this frame's domain at the canvas's half diagonal, with the field
  // centre at the middle of its bottom edge (the domain always points up).
  // The drawer moving the centre off the canvas's middle stretches the
  // farthest corner beyond that half diagonal; rather than reallocating as
  // the drawer slides, update() lowers the chamber's texels per pixel a
  // little to fit.
  let chamber = null, chamberView = null, chamberW = 0, chamberH = 0;
  let chamberExt = 1, wantH = 1;
  let spriteBind = null;           // set once an atlas exists (see rebind)
  let foldBind = null;             // set with the chamber
  // The symmetry slide's second fold (see trackSymmetry): its own uniforms,
  // made the first time a slide runs, and its bind group over the same
  // chamber, made then and again only after the chamber is.
  let uniBuf2 = null, foldBind2 = null;
  const uni2 = new Float32Array(UNIFORM_FLOATS);
  const chamberPassDesc = {
    colorAttachments: [{
      view: null,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: 'clear',
      storeOp: 'store'
    }]
  };

  // ---------- the pool ----------
  // Struct-of-arrays, one slot per object. depth is the travel fraction in
  // log radius, 0 at birth and 1 at the rim (see radiusK). phiU is the object's angle from
  // the domain's centre line, in domain widths, so the domain is -0.5 to 0.5
  // whatever the fold count, and a change of fold count or of mirror
  // re-spreads the live objects rather than stranding them. sizeRnd, spinRnd
  // and orbitRnd are the object's own random draws, kept raw so the size,
  // spin and orbit sliders act on live objects at once.
  const depth = new Float32Array(MAX_SHAPES);
  // When each piece was born, on the layer's own motion clock (clockS), for
  // the Fade in time: a piece's first fadeInSNow seconds ease its alpha up
  // from nothing, so no birth, whatever put it there, can land as a pop.
  // Prewarmed and aged pieces are back-dated past it (age()).
  const bornT = new Float32Array(MAX_SHAPES);
  const velPh = new Float32Array(MAX_SHAPES);   // speed phase (see SPEED_FLOOR)
  const velW = new Float32Array(MAX_SHAPES);    // its own share of the wander rate
  const phiU = new Float32Array(MAX_SHAPES);
  const sizeRnd = new Float32Array(MAX_SHAPES);
  const spinRnd = new Float32Array(MAX_SHAPES);
  const spinAng = new Float32Array(MAX_SHAPES);
  const orbitRnd = new Float32Array(MAX_SHAPES);
  const motifOf = new Uint8Array(MAX_SHAPES);
  // The atlas slot (0 or 1, see slots) the object was born from. motifOf is
  // a tile of that atlas, and the object draws from it until it retires.
  const atlasOf = new Uint8Array(MAX_SHAPES);
  // How far an object has faded in on the spot (see APPEAR_SECONDS), and
  // which way it is going: 1 appearing, -1 leaving as surplus, 0 steady.
  // Objects born at the centre start at 1; the flight's own fade serves.
  const appear = new Float32Array(MAX_SHAPES);
  const appearDir = new Int8Array(MAX_SHAPES);
  // order holds the live slots, youngest first. A piece keeps its place
  // relative to every other live piece even when their flight speeds differ.
  // Sorting by current radius would abruptly swap opaque overlapping motifs
  // at each overtake. free is a stack of empty slots.
  const order = new Int16Array(MAX_SHAPES);
  const free = new Int16Array(MAX_SHAPES);
  let live = 0, freeTop = 0;
  // Live objects fading out as surplus, and those fading in or out at all,
  // so the per-frame settling pass runs only while there are any.
  let dying = 0, fading = 0;
  // The catch-up toward a moved target (see FILL_TAU): its direction (1
  // filling, -1 thinning, 0 idle) and its fractional accumulator.
  let fillDir = 0, fillAcc = 0;

  // ---------- the atlases ----------
  // Up to two motif atlases live at once, one per slot: the current set,
  // which every birth comes from once a crossfade is over, and while one
  // runs the set it is fading out of. Each slot keeps its own atlas, its
  // motifs' painted share of the quad (fill, measured as the atlas is
  // cleaned) and the motifs its families allow, with their mean fill,
  // rebuilt only when the families change; tile indices mean different
  // things in every set, so none of this can be shared. The outgoing slot's
  // allowed list is frozen as it was at the switch. The sprite pass binds
  // slot 0 at binding 1 and slot 1 at binding 3, an empty slot borrowing the
  // other's view, and its layout with it. Each slot also keeps the sheet it
  // was built from (url) and that sheet's layout (lay), since one set can be
  // built from two sheets (see atlasUrl) and the two need not be packed
  // alike.
  function makeSlot() {
    return {
      set: 0, url: '', lay: LAYOUT_STD, tex: null, view: null,
      fill: new Float32Array(MOTIFS),
      allowed: new Uint8Array(MOTIFS),
      allowedCount: 0, familyMask: -1, meanFill: DEFAULT_FILL
    };
  }
  const slots = [makeSlot(), makeSlot()];
  // Live objects drawing from each slot, so the outgoing atlas can go the
  // moment the last of its pieces retires once the crossfade is done.
  const users = new Int32Array(2);
  let cur = 0;                     // the current set's slot; 1 - cur is the outgoing one
  // The births' crossfade: its length and how far it has run, in seconds
  // of the strobe's clock (it stands still while paused, as births do).
  // Not running when xfadeAge >= xfadeLen.
  let xfadeLen = 0, xfadeAge = 0;
  // The crossfade time read when the set last changed, waiting on its atlas.
  let pendingXfade = 0;
  // A third set asked for mid-crossfade, built but waiting for the outgoing
  // slot (drainSlot) to empty before it moves in (see install). drainSlot is
  // -1 when nothing waits.
  let drainSlot = -1, drainTex = null, drainFill = null, drainSet = 0;
  let drainUrl = '', drainLay = LAYOUT_STD;
  // The mean fill the coverage solve uses: the current set's, or while a
  // crossfade runs, blended from the outgoing set's as the births tip over.
  let meanFillNow = DEFAULT_FILL;

  // The coverage target and the settings it was worked out from, so it is
  // recomputed only when one of them moves.
  const tKey = new Float64Array(13).fill(NaN);
  let targetNow = 0;

  // The atlas set last asked for, the sheet it was asked from (the High
  // resolution toggle moves that without moving the set), and a count that
  // makes a load finishing after a newer one was asked for throw itself away.
  let requestedSet = 0, requestedUrl = '', loadToken = 0, ready = false;
  let pixelW = 1, pixelH = 1, dpr = 1;

  // The domain as this frame's settings shape it, shared by spawning,
  // motion and instancing so none of them needs it passed along.
  let mirrorOn = true, spanNow = 1, reachKNow = 0.5, sizeVarNow = 0.6;
  let seatMirror = false, scatterNow = 0, fadeNow = 0.55;

  // The layer's own clocks advance only while the strobe runs, as the rings
  // do, and are accumulated from dt so moving a slider changes the pace from
  // here on rather than jumping the pattern.
  let twistAng = 0;                // complete rotation, radians
  let velRefPh = 0;                // the Speed glow's reference swing phase
  let spawnAcc = 0, spawnGap = 1;  // spawn accumulator and the next (jittered) gap
  let wasOn = false, fade = 0;
  // The frame's geometry, kept for inspect() below.
  let dbgMaxR = 0, dbgHoleR = 0, dbgSideK = 0, dbgSizeVar = 0, dbgCx = 0, dbgCy = 0;
  // The layer's motion clock, seconds: steps with motionStep, so a pause
  // holds every running fade in where it is.
  let clockS = 0;
  let fadeInSNow = 0;
  // The diagnostic's state (see KDIAG).
  let dgEvent = '', dgInst = 0, dgBeat = 0;
  let dgPrev = new Map(), dgCur = new Map();
  function dgLog(what, extra) { console.log('[kaldiag] ' + what, extra || ''); }
  // How far the size law has moved from growing with radius (0) to
  // constant (1), eased toward the toggle so live objects never pop.
  let constBlend = 0;
  let instCount = 0;
  let active = false;

  // ---------- the symmetry slide ----------
  // symFolds and symMirror are the symmetry last seen, the one the pattern
  // is at or sliding to; oldFolds, oldMirror and oldSpan the one it is
  // sliding from. The slide runs while slideAge < slideLen, seconds of wall
  // time, and slideK is the new symmetry's eased weight this frame.
  // slideDraw says this frame's draw() folds twice.
  let symFolds = 0, symMirror = true;
  let oldFolds = 0, oldMirror = true, oldSpan = 1;
  let slideLen = 0, slideAge = 0, slideK = 1;
  let slideDraw = false;

  // ---------- trails ----------
  // The feedback image (see the top of this file) and the fold pipeline
  // that draws into it (its own target format), both made the first frame
  // trails are in use. fbOn says this frame also folds into the image, the
  // echo laid under the live fold; fbParams is its frame for feedback.js,
  // fbGain the Trails pulse's colour gain on the echo and fbOpacity the
  // echo's opacity. The folds into the image have uniforms of their own
  // (uniFb, and uniFb2 for a slide's old symmetry): the Trail res scale, and
  // a gain without the layer's opacity or pulse, which ride the live fold
  // alone. Their buffers are made with the image, their bind groups over
  // each new chamber as the live fold's are.
  let fbScreen = null, fbFoldPipe = null, fbOn = false;
  const fbParams = { keepHalfLife: 0, zoomRate: 0, twistRate: 0, cx: 0, cy: 0, unit: 1, dt: 0 };
  let fbGain = 1, fbOpacity = 1, fbScale = 1;
  const uniFb = new Float32Array(UNIFORM_FLOATS), uniFb2 = new Float32Array(UNIFORM_FLOATS);
  let uniFbBuf = null, uniFb2Buf = null, fbFoldBind = null, fbFoldBind2 = null;
  // This frame: whether the live fold shows (its gain above the cutoff) and
  // whether the fold goes into the image (the image's gain above it).
  let liveDraw = false, fbDraw = false;
  // The swings' phases (0 to 1), each its own, and their room bookkeeping
  // (core/room-clock.js), as confetti's.
  let fbAmtPhase = 0, fbStreamPhase = 0, fbTwistPhase = 0, fbPulsePhase = 0;
  const fbAmtRoom = roomPhaseState(), fbStreamRoom = roomPhaseState();
  const fbTwistRoom = roomPhaseState(), fbPulseRoom = roomPhaseState();

  function resize(pw, ph, d) {
    if (KDIAG) { dgEvent = 'resize ' + pw + 'x' + ph + '@' + d; dgLog(dgEvent); }
    pixelW = Math.max(1, pw | 0);
    pixelH = Math.max(1, ph | 0);
    dpr = d || 1;
    const maxDim = (device.limits && device.limits.maxTextureDimension2D) || 8192;
    chamberExt = 0.5 * Math.hypot(pixelW, pixelH) * CHAMBER_RES;
    wantH = Math.min(maxDim, Math.ceil(chamberExt) + 2 * CHAMBER_PAD);
    // The old chamber's contents mean nothing at the new size; it is made
    // again the next time the layer draws, and not at all while it is off.
    if (chamber) { chamber.destroy(); chamber = null; chamberView = null; foldBind = null; foldBind2 = null; fbFoldBind = null; fbFoldBind2 = null; }
  }

  // halfSin is the sine of the domain's half angle. Only the domain is ever
  // read (plus a bilinear texel at its edges, inside CHAMBER_PAD), so the
  // width it needs is the domain's own across the farthest radius. A new
  // fold count or mirror setting makes a new chamber, as a resize does; an
  // ordinary frame never does.
  function ensureChamber(halfSin) {
    const maxDim = (device.limits && device.limits.maxTextureDimension2D) || 8192;
    const wantW = Math.min(maxDim, 2 * (Math.ceil(chamberExt * halfSin) + CHAMBER_PAD));
    if (chamber && chamberW === wantW && chamberH === wantH) return;
    if (chamber) chamber.destroy();
    chamberW = wantW; chamberH = wantH;
    chamber = device.createTexture({
      size: { width: chamberW, height: chamberH },
      format: CHAMBER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    chamberView = chamber.createView();
    chamberPassDesc.colorAttachments[0].view = chamberView;
    foldBind = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: chamberView },
        { binding: 2, resource: chamberSampler }
      ]
    });
    foldBind2 = null;              // made again over this chamber when a slide wants it
    fbFoldBind = null; fbFoldBind2 = null;   // and the trails' folds, when trails want them
  }

  // The second fold's bind group, over the chamber as it now is. Called
  // only on a frame a slide runs and the group is missing: the first slide,
  // or the first slide frame after a new chamber.
  function makeFoldBind2() {
    if (!uniBuf2) uniBuf2 = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    foldBind2 = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniBuf2 } },
        { binding: 1, resource: chamberView },
        { binding: 2, resource: chamberSampler }
      ]
    });
  }

  // The trails' fold bind group over the chamber as it now is, with its
  // uniforms: second is the slide's old symmetry. Called only on a frame
  // trails fold into the image and the group is missing (trails coming on,
  // a new chamber, a slide's first frame), never in an ordinary frame.
  function makeFbFoldBind(second) {
    const buf = second
      ? (uniFb2Buf || (uniFb2Buf = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })))
      : (uniFbBuf || (uniFbBuf = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })));
    const b = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: buf } },
        { binding: 1, resource: chamberView },
        { binding: 2, resource: chamberSampler }
      ]
    });
    if (second) fbFoldBind2 = b; else fbFoldBind = b;
  }

  // ---------- loading ----------
  // Decoding goes through the platform; the repack and the cleanup yield
  // after each tile so the million-pixel pass never lands as one long stall
  // mid strobe.
  function load(set, url) {
    requestedSet = set; requestedUrl = url;
    const token = ++loadToken;
    if (!platform || !platform.loadImagePixels) {
      console.warn('kaleido: the platform has no loadImagePixels; the layer stays empty');
      return;
    }
    platform.loadImagePixels(url)
      .then(img => buildAtlas(img, token, set, url))
      .catch(err => { console.warn('kaleido: could not load the motif atlas ' + url + ':', err && err.message ? err.message : err); });
  }

  // A square 8 x 8 atlas of any other size, repacked into layout L (the
  // 1024 px one for an ordinary set): each source tile scaled to fill its
  // tile's inner square (104 px there), with the padding left transparent.
  // Bilinear, weighted by alpha so transparent texels lend no colour to the
  // edge, and clamped to the source tile so neighbours never bleed in. It
  // yields after every tile, as the cleanup below does, so the repack never
  // lands as one long stall mid strobe; null if another set was asked for
  // meanwhile.
  async function repack(img, token, L) {
    const T = img.width / GRID, src = img.data;
    const TILE = L.tile, ATLAS = L.atlas, MOTIF_INNER = L.inner, MOTIF_PAD = L.pad;
    const out = new Uint8ClampedArray(ATLAS * ATLAS * 4);
    const step = T / MOTIF_INNER;
    for (let t = 0; t < MOTIFS; t++) {
      const sx0 = (t % GRID) * T, sy0 = ((t / GRID) | 0) * T;
      const dx0 = (t % GRID) * TILE + MOTIF_PAD, dy0 = ((t / GRID) | 0) * TILE + MOTIF_PAD;
      for (let y = 0; y < MOTIF_INNER; y++) {
        let fy = (y + 0.5) * step - 0.5;
        if (fy < 0) fy = 0; else if (fy > T - 1) fy = T - 1;
        const y0 = fy | 0, y1 = y0 < T - 1 ? y0 + 1 : y0, wy = fy - y0;
        for (let x = 0; x < MOTIF_INNER; x++) {
          let fx = (x + 0.5) * step - 0.5;
          if (fx < 0) fx = 0; else if (fx > T - 1) fx = T - 1;
          const x0 = fx | 0, x1 = x0 < T - 1 ? x0 + 1 : x0, wx = fx - x0;
          const i00 = ((sy0 + y0) * img.width + sx0 + x0) * 4, i10 = ((sy0 + y0) * img.width + sx0 + x1) * 4;
          const i01 = ((sy0 + y1) * img.width + sx0 + x0) * 4, i11 = ((sy0 + y1) * img.width + sx0 + x1) * 4;
          const w00 = (1 - wx) * (1 - wy) * src[i00 + 3], w10 = wx * (1 - wy) * src[i10 + 3];
          const w01 = (1 - wx) * wy * src[i01 + 3], w11 = wx * wy * src[i11 + 3];
          const wa = w00 + w10 + w01 + w11;
          const di = ((dy0 + y) * ATLAS + dx0 + x) * 4;
          if (wa <= 0) continue;
          out[di]     = (src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11) / wa;
          out[di + 1] = (src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11) / wa;
          out[di + 2] = (src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11) / wa;
          out[di + 3] = wa;   // the plain bilinear alpha: the weights sum to 1
        }
      }
      await yieldTile();
      if (token !== loadToken) return null;
    }
    return { width: ATLAS, height: ATLAS, data: out };
  }

  async function buildAtlas(img, token, set, url) {
    // Everything below works in this sheet's own layout.
    const L = layoutFor(set, url);
    const TILE = L.tile, ATLAS = L.atlas;
    if (!L.prepadded || img.width !== ATLAS || img.height !== ATLAS) {
      if (img.width !== img.height || img.width % GRID) {
        console.warn('kaleido: expected a square atlas of 8 x 8 tiles, got ' + img.width + ' x ' + img.height);
        return;
      }
      img = await repack(img, token, L);
      if (!img) return;
    }
    const src = img.data;
    // Measured into its own list and copied over at the swap, so the atlas
    // still drawing keeps its own fill figures while this one builds.
    const fill = new Float32Array(MOTIFS);
    const out = new Uint8Array(ATLAS * ATLAS * 4);
    const TT = TILE * TILE;
    const state = new Uint8Array(TT);     // 0 unreached, 1 in the current wave, 2 coloured
    const rgb = new Uint8Array(TT * 3);
    let cur = new Int32Array(TT), nxt = new Int32Array(TT);

    for (let t = 0; t < MOTIFS; t++) {
      const tx = (t % GRID) * TILE, ty = ((t / GRID) | 0) * TILE;

      // Seed the waves from the solid body, and count the pixels that will
      // survive the cut but still need a colour; once those are all reached
      // the rest of the tile does not matter (premultiplied, it is zero).
      state.fill(0);
      let nCur = 0, need = 0;
      for (let y = 0; y < TILE; y++) {
        let si = ((ty + y) * ATLAS + tx) * 4;
        for (let x = 0; x < TILE; x++, si += 4) {
          const li = y * TILE + x, a = src[si + 3];
          rgb[li * 3] = src[si]; rgb[li * 3 + 1] = src[si + 1]; rgb[li * 3 + 2] = src[si + 2];
          if (a >= SOLID) { state[li] = 2; cur[nCur++] = li; }
          else if (a >= ALPHA_CUT) need++;
        }
      }

      // Each wave takes the ring of pixels one step (8-connected) further
      // from the body and gives each the average colour of its neighbours
      // already coloured, so a pixel ends up with the colour of the body
      // nearest to it, blended where two parts of the motif are equally near.
      while (need > 0 && nCur > 0) {
        let nNext = 0;
        for (let i = 0; i < nCur; i++) {
          const li = cur[i], x = li % TILE, y = (li / TILE) | 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= TILE) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= TILE) continue;
              const ni = yy * TILE + xx;
              if (state[ni] === 0) { state[ni] = 1; nxt[nNext++] = ni; }
            }
          }
        }
        for (let i = 0; i < nNext; i++) {
          const li = nxt[i], x = li % TILE, y = (li / TILE) | 0;
          let r = 0, g = 0, b = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= TILE) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= TILE) continue;
              const ni = yy * TILE + xx;
              if (state[ni] !== 2) continue;
              r += rgb[ni * 3]; g += rgb[ni * 3 + 1]; b += rgb[ni * 3 + 2]; n++;
            }
          }
          if (n) { rgb[li * 3] = Math.round(r / n); rgb[li * 3 + 1] = Math.round(g / n); rgb[li * 3 + 2] = Math.round(b / n); }
        }
        for (let i = 0; i < nNext; i++) {
          const li = nxt[i];
          state[li] = 2;
          const a = src[((ty + ((li / TILE) | 0)) * ATLAS + tx + (li % TILE)) * 4 + 3];
          if (a >= ALPHA_CUT && a < SOLID) need--;
        }
        const sw = cur; cur = nxt; nxt = sw; nCur = nNext;
      }

      // Cut and premultiply into the atlas, summing the surviving alpha as
      // the motif's painted share of the square its quad covers (the
      // padding is transparent, so summing the whole tile is the same).
      let painted = 0;
      for (let y = 0; y < TILE; y++) {
        let si = ((ty + y) * ATLAS + tx) * 4;
        for (let x = 0; x < TILE; x++, si += 4) {
          const a = src[si + 3];
          if (a < ALPHA_CUT) continue;          // matte and speckle: leave it transparent
          const li = (y * TILE + x) * 3, k = a / 255;
          out[si] = Math.round(rgb[li] * k);
          out[si + 1] = Math.round(rgb[li + 1] * k);
          out[si + 2] = Math.round(rgb[li + 2] * k);
          out[si + 3] = a;
          painted += k;
        }
      }
      fill[t] = Math.min(1, painted / (L.inner * L.inner));
      // Yield after every tile, not every row: a row of eight dilations is
      // several milliseconds of main thread, a dropped strobe frame each.
      await yieldTile();
      if (token !== loadToken) return;      // another set was asked for meanwhile
    }

    const tex = device.createTexture({
      size: { width: ATLAS, height: ATLAS },
      format: 'rgba8unorm',
      mipLevelCount: L.mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    device.queue.writeTexture({ texture: tex }, out, { bytesPerRow: ATLAS * 4, rowsPerImage: ATLAS },
                              { width: ATLAS, height: ATLAS });
    buildMips(tex, L.mips);
    install(tex, fill, set, url, L);
  }

  // ---------- the atlas slots ----------
  // The sprite pass's bind group over both slots, made again only when an
  // atlas comes or goes, never in an ordinary frame. An empty slot borrows
  // the other's view, so the shader always has two to read, and its layout
  // with it. The layouts go into the uniforms here, and ride every frame's
  // uniform write from then on.
  function rebind() {
    const sa = slots[0].view ? slots[0] : slots[1], sb = slots[1].view ? slots[1] : slots[0];
    const a = sa.view, b = sb.view;
    if (!a) { spriteBind = null; return; }
    putLayout(U_LAY0, sa.lay);
    putLayout(U_LAY1, sb.lay);
    spriteBind = device.createBindGroup({
      layout: spriteBgl,
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: a },
        { binding: 2, resource: sampler },
        { binding: 3, resource: b }
      ]
    });
  }

  function putLayout(at, L) {
    uni[at] = L.padUV; uni[at + 1] = L.innerUV; uni[at + 2] = L.halfTexel; uni[at + 3] = 0;
  }

  // Frees a slot. Frames already submitted finish with its atlas before it
  // goes; the caller rebinds before the next frame is encoded.
  function dropSlot(sl) {
    if (sl.tex) sl.tex.destroy();
    sl.tex = null; sl.view = null; sl.set = 0; sl.url = ''; sl.lay = LAYOUT_STD;
    sl.allowedCount = 0; sl.familyMask = -1;
  }

  // Makes slot s the current set. Instant, every live object moves onto its
  // atlas keeping its motif index, the swap under the live shapes the layer
  // has always made, and the other slot goes. Otherwise the set that was
  // current becomes the outgoing one, keeping its pieces and its frozen
  // families, and the births cross over to s across T seconds, starting p0
  // of the way. Either way s re-reads the families setting against its own
  // set (empty after a set change, so all of them).
  function makeCurrent(s, instant, T, p0) {
    cur = s;
    slots[s].familyMask = -1;
    if (instant) {
      for (let n = 0; n < live; n++) atlasOf[order[n]] = s;
      users[s] = live; users[1 - s] = 0;
      dropSlot(slots[1 - s]);
      xfadeLen = 0; xfadeAge = 0;
    } else {
      xfadeLen = T; xfadeAge = p0 * T;
    }
    rebind();
    ready = true;
  }

  // A freshly built atlas arrives. The first one, or one asked for with the
  // crossfade at instant, replaces the current slot's atlas under the live
  // shapes. With a crossfade time it goes into the other slot and the
  // crossfade's clock starts now, so a slow load never eats into it. If that
  // slot still holds a set from an earlier change (a second change made
  // mid-crossfade) and pieces of that set are still flying, the new atlas
  // waits rather than take a third binding: those pieces may not change
  // image where the fold can see them, so each keeps its own atlas until it
  // is out of sight (past a mirror, inside the hole, off the screen or faded
  // to nothing; see hideSwap) and only then takes up the set that was
  // current, with a motif that set allows. Births meanwhile all come from
  // the current set, so the slot only empties. Once it has, the new atlas
  // moves in and its crossfade starts (see update). At Speed 0 with no orbit
  // nothing ever leaves sight, and the new set waits for motion.
  function install(tex, fill, set, url, L) {
    const T = pendingXfade;
    const crossfade = !!slots[cur].tex && T > 0;
    const s = crossfade ? 1 - cur : cur;
    const sl = slots[s];
    if (crossfade && sl.tex && users[s] > 0) {
      drainSlot = s; drainTex = tex; drainFill = fill; drainSet = set;
      drainUrl = url; drainLay = L;
      xfadeAge = xfadeLen;
      return;
    }
    if (sl.tex) sl.tex.destroy();
    sl.tex = tex; sl.view = tex.createView(); sl.set = set;
    sl.url = url; sl.lay = L;
    sl.fill.set(fill);
    makeCurrent(s, !crossfade, T, 0);
  }

  // The Image set has just changed to set. The crossfade time is read now,
  // at the change, whether it came from the drawer, a recall, a journey step
  // or a followed broadcast; with the layer off (or just coming on) nothing
  // is on screen to cross over from, so the change is instant. A set already
  // in a slot is taken from there rather than loaded again: back to the
  // current one, the mix simply carries on (instant, the outgoing set goes);
  // back to the outgoing one, the two swap roles with the mix carried over
  // continuously, so the births do not jump. A slot counts as holding the
  // set only if it was built from the same sheet (url), so the High
  // resolution toggle reloads the current set from its other sheet and
  // swaps it in exactly as a change of set would; toggling back mid
  // crossfade finds the other sheet still in its slot.
  function changeSet(set, url) {
    if (KDIAG) { dgEvent = 'changeSet ' + set + ' ' + url; dgLog(dgEvent); }
    // A set still waiting on a draining slot is overtaken by this one.
    if (drainSlot >= 0) {
      drainTex.destroy();
      drainSlot = -1; drainTex = null; drainFill = null;
    }
    const T = wasOn ? clampNum(S.kaleidoSetXfade, 0, 60, 0) : 0;
    const o = 1 - cur;
    if (slots[cur].tex && slots[cur].set === set && slots[cur].url === url) {
      requestedSet = set; requestedUrl = url; ++loadToken;
      if (T <= 0) makeCurrent(cur, true, 0, 0);
      return;
    }
    if (slots[o].tex && slots[o].set === set && slots[o].url === url) {
      requestedSet = set; requestedUrl = url; ++loadToken;
      const p = xfadeAge < xfadeLen ? xfadeAge / xfadeLen : 1;
      makeCurrent(o, T <= 0, T, 1 - p);
      return;
    }
    pendingXfade = T;
    load(set, url);
  }

  // One small render pass per level, each reading the level above it, as
  // flowers.js builds its chain. 128 px tiles (and 192 px ones) halve
  // cleanly at every level here, so a 2 x 2 box never straddles two motifs.
  function buildMips(tex, levels) {
    const mipMod = device.createShaderModule({ label: 'kaleido.mip', code: MIP_WGSL });
    const mp = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mipMod, entryPoint: 'vs' },
      fragment: { module: mipMod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' }
    });
    const enc = device.createCommandEncoder();
    for (let l = 1; l < levels; l++) {
      const srcView = tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 });
      const dstView = tex.createView({ baseMipLevel: l, mipLevelCount: 1 });
      const bg = device.createBindGroup({ layout: mp.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcView }] });
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: dstView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
      });
      pass.setPipeline(mp);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([enc.finish()]);
  }

  // ---------- the pool, per frame ----------
  // The families setting as a bitmask over slot sl's semantic groups;
  // empty, missing or nonsense means every group. Groups map to arbitrary
  // motif indices because photographed leaves and petals are interleaved.
  // Only ever run for the current slot, and only while its set is the one
  // asked for, so the outgoing set keeps the families it had at the switch.
  function refreshFamilies(sl) {
    const groups = kaleidoscopeSet(sl.set).groups;
    const fams = S.kaleidoFamilies;
    let mask = 0;
    if (fams && typeof fams.length === 'number') {
      for (let i = 0; i < fams.length; i++) {
        const f = fams[i];
        if (typeof f === 'number' && f >= 0 && f < groups.length) mask |= 1 << (f | 0);
      }
    }
    if (mask === 0) mask = (1 << groups.length) - 1;
    if (mask === sl.familyMask) return;
    sl.familyMask = mask;
    const allowed = sl.allowed, motifFill = sl.fill;
    let allowedCount = 0;
    let fillSum = 0;
    const seen = new Uint8Array(MOTIFS);
    for (let f = 0; f < groups.length; f++) {
      if (!(mask & (1 << f))) continue;
      const indices = groups[f].assetIndices;
      for (let c = 0; c < indices.length; c++) {
        const m = indices[c];
        if (seen[m]) continue;
        seen[m] = 1;
        allowed[allowedCount++] = m;
        fillSum += motifFill[m];
      }
    }
    sl.allowedCount = allowedCount;
    // A family of very sparse motifs would ask for a huge pool; the floor
    // keeps the count sane, and the fallback covers an atlas never measured.
    sl.meanFill = allowedCount && fillSum > 0 ? Math.max(0.05, fillSum / allowedCount) : DEFAULT_FILL;
  }

  function clearPool() {
    live = 0;
    freeTop = 0;
    dying = 0; fading = 0;
    fillDir = 0; fillAcc = 0;
    users[0] = 0; users[1] = 0;
    for (let i = MAX_SHAPES - 1; i >= 0; i--) free[freeTop++] = i;
  }

  function pickMotif(sl) {
    const count = sl.allowedCount;
    let m = (Math.random() * count) | 0;
    if (m >= count) m = count - 1;
    return sl.allowed[m];
  }

  // Which set a newborn in slot i draws from, and its motif from that set's
  // own allowed list. While a crossfade runs a birth comes from the current
  // set with probability p, rising linearly from 0 to 1 across the
  // crossfade time, and from the outgoing set otherwise: one random per
  // birth. Linear is enough because each piece then lives a whole flight,
  // so what is on screen is a running average of the births over the last
  // flight, which already rounds the start and end of the change. Pieces
  // already flying keep their own set until they retire. The slot i must
  // not be counted in users yet (a re-entry takes itself off first).
  function birth(i) {
    let s = cur;
    const o = 1 - cur;
    if (xfadeAge < xfadeLen && slots[o].allowedCount && Math.random() * xfadeLen >= xfadeAge) s = o;
    atlasOf[i] = s;
    users[s]++;
    motifOf[i] = pickMotif(slots[s]);
  }

  // Object i, which buildInstances has just found out of sight, gives up a
  // draining atlas slot (see install) for the current set, with a motif that
  // set allows. Out of sight, the new image cannot show as a swap; it comes
  // into view only as the object moves back in. Anything else is left alone.
  function hideSwap(i) {
    if (atlasOf[i] !== drainSlot || !slots[cur].allowedCount) return;
    users[drainSlot]--;
    atlasOf[i] = cur;
    users[cur]++;
    motifOf[i] = pickMotif(slots[cur]);
  }

  // How far object i's half size is scaled against the radius law at radius
  // fraction k: 1 while it grows with radius, CONST_K / k once constant, and
  // in between while the toggle eases. Never above 1, so constant size never
  // makes an object wider than its wedge fits (see CONST_K).
  function sizeLaw(k) {
    return 1 + ((k > CONST_K ? CONST_K / k : 1) - 1) * constBlend;
  }

  // How far past the domain's edge, in domain widths, object i reaches
  // before it is wholly out of the domain. While size grows with radius its
  // angular half width, asin(reach / r), is the same all along its flight;
  // at constant size it narrows as the object flies out, so it is taken at
  // the object's current depth. An object whose reach passes its radius
  // covers the centre and is not out; that is Infinity.
  function reachU(i) {
    let ratio = reachKNow * (1 - sizeVarNow * sizeRnd[i]);
    if (constBlend > 0) ratio *= sizeLaw(radiusK(depth[i]));
    return ratio >= 1 ? Infinity : Math.asin(ratio) / spanNow;
  }

  // Where object i's angle may range. Mirrored, the domain widened by the
  // object's own half width (so at the band's edge it is wholly outside) and
  // by BAND_EXTRA more, so it is thrown in from well outside; an object wide
  // enough to cover the centre gets the whole circle. Unmirrored, the domain
  // itself, since there the angle wraps.
  function spawnBand(i) {
    if (!mirrorOn) return 0.5;
    const e = reachU(i), whole = Math.PI / spanNow;
    return 0.5 + BAND_EXTRA + (e < whole ? e : whole);
  }

  function spawn(d) {
    if (!freeTop || !slots[cur].allowedCount) return;
    const i = free[--freeTop];
    depth[i] = d;
    velPh[i] = Math.random() * TAU;
    velW[i] = 0.5 + Math.random();
    sizeRnd[i] = Math.random();
    spinRnd[i] = Math.random() * 2 - 1;
    orbitRnd[i] = Math.random() * 2 - 1;
    spinAng[i] = 0;
    birth(i);
    bornT[i] = clockS;
    appear[i] = 1;
    appearDir[i] = 0;
    // Its seat line (see SEAT_ON_MIRROR), then pulled Scatter of the way
    // toward a spot anywhere across its band: 0 is always the seat, 1 the
    // band's uniform spread.
    const seat = seatMirror ? (Math.random() < 0.5 ? -0.5 : 0.5) : 0;
    phiU[i] = seat + scatterNow * ((Math.random() * 2 - 1) * spawnBand(i) - seat);
    order[live++] = i;
  }

  // Spin variance 0 gives every object the same gentle turn; 1 gives each its
  // own rate anywhere in [-spinMax, spinMax], some nearly still.
  function spinRate(i, spinMax, spinVar) {
    return spinMax * ((1 - spinVar) * COMMON_SPIN + spinVar * spinRnd[i]);
  }

  // Orbit variance 0 throws every object across the chamber at the full
  // rate, all the same way, so the whole pattern flows as one; 1 gives each
  // its own rate anywhere in [-orbitMax, orbitMax], some nearly still, both
  // directions. Radians per second about the centre.
  function orbitRate(i, orbitMax, orbitVar) {
    return orbitMax * ((1 - orbitVar) + orbitVar * orbitRnd[i]);
  }

  // Gives the object just spawned in slot i everything it would have
  // gathered by its travel if it had been flying all along: lifeSec is a
  // whole flight's seconds, so it has been out depth * lifeSec, turning at
  // its spin rate and carried along its orbit, wrapping as advance() wraps
  // it (round the band mirrored, round the wedge unmirrored). Its motif and
  // size stay as drawn: a wrap would have redrawn them anyway.
  function age(i, lifeSec, spinMax, spinVar, orbitMax, orbitVar) {
    const secs = depth[i] * lifeSec;
    bornT[i] = clockS - secs;
    spinAng[i] = (spinRate(i, spinMax, spinVar) * secs) % TAU;
    let u = phiU[i] + orbitRate(i, orbitMax, orbitVar) * secs / spanNow;
    if (mirrorOn) {
      const b = spawnBand(i), w = 2 * b;
      u -= w * Math.floor((u + b) / w);
    } else {
      u -= Math.floor(u + 0.5);
    }
    phiU[i] = u;
  }

  // Fill the chamber at its steady state, as if the layer had been running
  // all along. Travel is even along a flight, so the depths are spread
  // evenly (one jittered draw per equal slice, in ascending order so the
  // pool starts sorted far to near), and each object is aged to its depth.
  function prewarm(count, lifeSec, spinMax, spinVar, orbitMax, orbitVar) {
    for (let n = 0; n < count; n++) {
      const before = live;
      spawn((n + Math.random()) / count);
      if (live === before) return;
      age(order[live - 1], lifeSec, spinMax, spinVar, orbitMax, orbitVar);
    }
  }

  // One more object at a random point of the flight, aged to it, fading in
  // where it stands. False when the pool is full.
  function spawnMidFlight(lifeSec, spinMax, spinVar, orbitMax, orbitVar) {
    const before = live;
    spawn(Math.random());
    if (live === before) return false;
    const i = order[live - 1];
    age(i, lifeSec, spinMax, spinVar, orbitMax, orbitVar);
    appear[i] = 0;
    appearDir[i] = 1;
    fading++;
    return true;
  }

  // Marks one live object, picked at random, to fade out where it stands.
  // A few tries find one not already leaving; false if they all miss.
  function retireOne() {
    for (let tries = 0; tries < 8 && live; tries++) {
      let q = (Math.random() * live) | 0;
      if (q >= live) q = live - 1;
      const i = order[q];
      if (appearDir[i] === -1) continue;
      if (appearDir[i] === 0) fading++;
      appearDir[i] = -1;
      dying++;
      return true;
    }
    return false;
  }

  // Frees slot i, keeping the fade counts true. The caller drops it from
  // order.
  function release(i) {
    users[atlasOf[i]]--;
    if (appearDir[i] !== 0) fading--;
    if (appearDir[i] === -1) dying--;
    appearDir[i] = 0;
    free[freeTop++] = i;
  }

  // Moves the on-the-spot fades along on wall time, so a density change
  // shows even while paused, and frees the surplus objects that have faded
  // all the way out. Removal keeps the paint order.
  function settle(dt) {
    if (!fading) return;
    const step = dt / APPEAR_SECONDS;
    let w = 0;
    for (let n = 0; n < live; n++) {
      const i = order[n];
      const dir = appearDir[i];
      if (dir > 0) {
        const a = appear[i] + step;
        if (a >= 1) { appear[i] = 1; appearDir[i] = 0; fading--; } else appear[i] = a;
      } else if (dir < 0) {
        const a = appear[i] - step;
        if (a <= 0) { release(i); continue; }
        appear[i] = a;
      }
      order[w++] = i;
    }
    live = w;
  }

  // Closes the gap between the live count (less the objects already
  // leaving) and the target, along the whole flight (see FILL_TAU). A gap
  // inside the deadband is the ordinary trickle and is left alone; once a
  // catch-up starts it runs until the gap is closed.
  function balance(dt, target, lifeSec, spinMax, spinVar, orbitMax, orbitVar) {
    let gap = target - (live - dying);
    if (fillDir === 0) {
      const band = 2 + FILL_DEADBAND * target;
      fillDir = gap > band ? 1 : (gap < -band ? -1 : 0);
      fillAcc = 0;
      if (fillDir === 0) return;
    }
    let mag = gap * fillDir;
    if (mag <= 0.5) { fillDir = 0; fillAcc = 0; return; }
    fillAcc += dt * Math.max(mag / FILL_TAU, FILL_MIN_RATE);
    while (fillAcc >= 1 && mag > 0.5) {
      fillAcc -= 1;
      const ok = fillDir > 0
        ? spawnMidFlight(lifeSec, spinMax, spinVar, orbitMax, orbitVar)
        : retireOne();
      if (!ok) { fillDir = 0; fillAcc = 0; return; }
      mag -= 1;
    }
  }

  // The share of a mirrored object's life spent with its centre inside the
  // domain, averaged over the orbit and birth draws. Its angle, in domain
  // widths, starts where spawn() puts it and runs at a steady rate for a
  // whole flight, wrapping round a band of half width bandHalf, which is a
  // circle of circumference 2 * bandHalf; the time inside is the laps it
  // makes plus its overlap with the domain on the last part lap. Travel is
  // even in log radius, so the share of time is also the share of coverage.
  // With no orbit and no scatter it is 1; with a strong orbit it tends to
  // the domain's share of the band. Unmirrored, the angle wraps round the
  // domain itself and the answer is 1.
  function inDomainShare(bandHalf, lifeSec, orbitMax, orbitVar) {
    if (!mirrorOn) return 1;
    const w = 2 * bandHalf;
    const seats = seatMirror ? 2 : 1;
    let sum = 0;
    for (let a = 0; a < SHARE_STEPS; a++) {
      const om = orbitMax * ((1 - orbitVar) + orbitVar * (((a + 0.5) / SHARE_STEPS) * 2 - 1));
      const run = Math.abs(om) * lifeSec / spanNow;
      const dir = om < 0 ? -1 : 1;
      for (let b = 0; b < SHARE_STEPS; b++) {
        const spread = ((b + 0.5) / SHARE_STEPS) * 2 - 1;
        for (let c = 0; c < seats; c++) {
          const seat = seatMirror ? (c ? 0.5 : -0.5) : 0;
          // Reflected so it always runs the positive way; the domain is
          // symmetric about its centre line.
          const u0 = dir * (seat + scatterNow * (spread * bandHalf - seat));
          if (run < 1e-6) { sum += (u0 > -0.5 && u0 < 0.5) ? 1 : 0; continue; }
          const laps = Math.floor(run / w), rest = run - laps * w;
          const inside = laps + overlap(u0, u0 + rest, -0.5, 0.5) + overlap(u0, u0 + rest, w - 0.5, w + 0.5);
          sum += inside / run;
        }
      }
    }
    return sum / (SHARE_STEPS * SHARE_STEPS * seats);
  }

  // The live count that gives density its coverage. Objects are spread
  // evenly in log radius, and under the radius size law each one's painted
  // area grows as r squared, as the domain's area per unit of log radius
  // does, so the share of the domain covered is the same at every radius:
  //   cover = inside * 4 * fill * h0^2 * E * G / (LOG_SPAN * span)
  // where inside is how many objects are within the domain, 4 h^2 a quad's
  // area at half size h, fill the motifs' mean painted share of their quad
  // (measured from the atlas), h0 the largest half size per unit radius, E
  // the mean of (1 - sizeVar * rnd)^2 over the size draw, and G the
  // constant-size law's mean effect on area, taken area-weighted over the
  // visible band, from where the fade in reaches one half (fadeHalfK, so it
  // follows the Fade in setting) to the start of the fade out (1 when size
  // grows with radius). The count itself holds the same coverage at every
  // radius, so inside that band Density means the same at any fade. Solved for the count at
  // density * COVER_FULL, and divided by the share of objects inside the
  // domain at any moment. Worked out only when a setting it depends on
  // moves.
  function coverageTarget(density, h0, sizeVar, constWant, lifeSec, orbitMax, orbitVar) {
    if (tKey[0] === density && tKey[1] === spanNow && tKey[2] === h0 && tKey[3] === sizeVar &&
        tKey[4] === constWant && tKey[5] === lifeSec && tKey[6] === orbitMax &&
        tKey[7] === orbitVar && tKey[8] === scatterNow && tKey[9] === meanFillNow &&
        tKey[10] === (mirrorOn ? 1 : 0) && tKey[11] === (seatMirror ? 1 : 0) &&
        tKey[12] === fadeNow) return targetNow;
    tKey[0] = density; tKey[1] = spanNow; tKey[2] = h0; tKey[3] = sizeVar;
    tKey[4] = constWant; tKey[5] = lifeSec; tKey[6] = orbitMax;
    tKey[7] = orbitVar; tKey[8] = scatterNow; tKey[9] = meanFillNow;
    tKey[10] = mirrorOn ? 1 : 0; tKey[11] = seatMirror ? 1 : 0; tKey[12] = fadeNow;

    if (!(density > 0) || !(h0 > 0)) return (targetNow = 0);
    const e2 = 1 - sizeVar + sizeVar * sizeVar / 3;
    let g2 = 1;
    if (constWant) {
      const lo = fadeHalfK(fadeNow), hi = RADIAL_FADE_OUT_K;
      const c = CONST_K < lo ? lo : (CONST_K > hi ? hi : CONST_K);
      // The integral of k^2 g^2 over log k: growing below c, constant above.
      const num = 0.5 * (c * c - lo * lo) + CONST_K * CONST_K * Math.log(hi / c);
      g2 = num / (0.5 * (hi * hi - lo * lo));
    }
    const inside = density * COVER_FULL * LOG_SPAN * spanNow / (4 * meanFillNow * h0 * h0 * e2 * g2);

    // The band an object of average size roams, as spawnBand() works it.
    const ratio = reachKNow * (1 - sizeVar * 0.5);
    const whole = Math.PI / spanNow;
    const e = ratio >= 1 ? whole : Math.min(Math.asin(ratio) / spanNow, whole);
    const share = inDomainShare(0.5 + BAND_EXTRA + e, lifeSec, orbitMax, orbitVar);
    const n = inside / (share > 1e-3 ? share : 1e-3);
    return (targetNow = n < MAX_SHAPES ? n : MAX_SHAPES);
  }

  // Moves every live object out and across, and retires those that reach
  // the rim. Mirrored, an object that has wandered out past its band's edge
  // (and is still heading away) is by then wholly out of sight, and comes
  // back from the far edge as a new object, with a fresh motif, size and
  // spin draw, at the depth it had reached: the band keeps a steady flow of
  // objects crossing it at every radius, not only near the centre.
  // Unmirrored, the angle simply wraps round the wedge.
  function advance(dt, travel, spinMax, spinVar, orbitMax, orbitVar, speedVar, speedPeriod) {
    let w = 0;
    const du = dt / spanNow;
    const dph = dt * TAU / speedPeriod;
    for (let n = 0; n < live; n++) {
      const i = order[n];
      velPh[i] = (velPh[i] + dph * velW[i]) % TAU;
      let v = 1 + speedVar * Math.sin(velPh[i]);
      if (v < SPEED_FLOOR) v = SPEED_FLOOR;
      const d = depth[i] + dt * travel * v;
      if (d >= 1) { release(i); continue; }
      depth[i] = d;                // reachU reads it
      const om = orbitRate(i, orbitMax, orbitVar);
      let u = phiU[i] + du * om;
      // reachU is never negative, so the band is at least 0.5 + BAND_EXTRA
      // wide; an object inside that cannot be past its edge, and the asin
      // (and, at constant size, the exp) in reachU is only worked out for
      // the few that might be.
      if (mirrorOn && (u > 0.5 + BAND_EXTRA || u < -0.5 - BAND_EXTRA)) {
        const b = 0.5 + BAND_EXTRA + reachU(i);
        if ((u > b && om > 0) || (u < -b && om < 0)) {
          const side = u > 0 ? -1 : 1;
          sizeRnd[i] = Math.random();
          spinRnd[i] = Math.random() * 2 - 1;
          // a new object as far as the eye can tell, so it is a birth too,
          // and takes its set from the crossfade as one
          users[atlasOf[i]]--;
          birth(i);
          u = side * spawnBand(i);
        }
      } else if (!mirrorOn) {
        u -= Math.floor(u + 0.5);
      }
      phiU[i] = u;
      spinAng[i] = (spinAng[i] + dt * spinRate(i, spinMax, spinVar)) % TAU;
      order[w++] = i;
    }
    live = w;
  }

  // Insertion sort by birth time, youngest first. Prewarm backdates births
  // so its initial paint order is still far to near; new centre births go
  // underneath existing pieces. Birth time stays fixed through overtakes
  // and angular re-entry, so two live pieces never flip who covers whom.
  // Ordinary frames are one pass; only new births need moving into place.
  function sortOrder() {
    for (let n = 1; n < live; n++) {
      const i = order[n], b = bornT[i];
      let m = n - 1;
      while (m >= 0 && bornT[order[m]] < b) { order[m + 1] = order[m]; m--; }
      order[m + 1] = i;
    }
  }

  // Notices a change of symmetry and runs the slide (see S.kaleidoFoldXfade).
  // The slide time is read at the change, whatever made it; with the layer
  // off or just coming on there is nothing on screen to slide from, so the
  // change is instant, as changeSet's is. It runs on wall time, as the
  // Constant size ease does, so a change made while paused still lands.
  // While it runs the fold is drawn twice, the old symmetry at weight 1 - k
  // and then the new at k, with k the smoothstep of the time gone, so the
  // dissolve starts and lands gently. Both folds read the one chamber, laid
  // out for the new symmetry: phiU is in domain widths, so the pieces take
  // their new seats and sizes at the change, under the old mirrors, while
  // the mirrors themselves dissolve.
  //
  // A second change mid-slide never draws a third fold. Back to the
  // symmetry fading out, the two simply swap roles with the mix carried
  // over, so nothing jumps. To a third symmetry, whichever of the two was
  // winning (k past one half or not) becomes the old one and the slide
  // starts again from nothing; dragging the slider through several fold
  // counts in a moment so stays on the pattern it started from, rather than
  // flickering through each count it passes, and dissolves once to where it
  // stops.
  function trackSymmetry(folds, mirror, dt) {
    if (slideAge < slideLen && dt > 0) slideAge += dt;
    if (!wasOn) {
      symFolds = folds; symMirror = mirror;
      slideLen = 0; slideAge = 0;
    } else if (folds !== symFolds || mirror !== symMirror) {
      const T = clampNum(S.kaleidoFoldXfade, 0, 60, 0);
      const running = slideAge < slideLen;
      const x = running ? slideAge / slideLen : 1;
      let from = symFolds, fromMirror = symMirror;
      if (T <= 0) {
        slideLen = 0; slideAge = 0;
      } else if (running && folds === oldFolds && mirror === oldMirror) {
        // smoothstep(1 - x) is 1 - smoothstep(x), so the mix is unbroken
        oldFolds = symFolds; oldMirror = symMirror;
        slideLen = T; slideAge = (1 - x) * T;
      } else {
        if (!(running && x < 0.5)) { oldFolds = symFolds; oldMirror = symMirror; }
        slideLen = T; slideAge = 0;
      }
      if (T > 0) {
        from = oldFolds; fromMirror = oldMirror;
        oldSpan = oldMirror ? Math.PI / oldFolds : TAU / oldFolds;
      }
      symFolds = folds; symMirror = mirror;
      if (KDIAG) {
        dgEvent = 'symmetry ' + from + (fromMirror ? ' mirrored' : '') + ' -> ' + folds + (mirror ? ' mirrored' : '') +
          (T > 0 ? ', slide ' + T + 's' : ', instant');
        dgLog(dgEvent);
      }
    }
    slideK = slideAge < slideLen ? smoothstep(0, 1, slideAge / slideLen) : 1;
    return slideAge < slideLen;
  }

  // This frame's trails, confetti's clocks and route (gpu/confetti.js). Each
  // swing's phase steps by the frame's motion step over its rate, so a
  // stopped scene holds it, and in a room it is then pulled onto the room
  // clock with its offset (a no-op outside one). Amount dips, Stream and
  // Twist swing both ways, Pulse dips; the Opacity's dip is the strobe's
  // (core/strobe.js VARIANCES writes effKaleidoFbOpacity). The effectives go
  // out for the Trails rows' lit bars. The echo is laid at the Trails
  // Opacity times the layer's own, so a layer faded out takes its trails
  // along rather than leaving them up until it switches off; the live fold
  // keeps the layer's opacity alone, untouched by any trail setting.
  function stepTrails(t, md, lum, opacity) {
    const amtRate = clampNum(S.kaleidoFbAmtVarRate, 1, 120, 20);
    const streamRate = clampNum(S.kaleidoFbStreamVarRate, 1, 120, 20);
    const twistRate = clampNum(S.kaleidoFbTwistVarRate, 1, 120, 20);
    const pulseRate = clampNum(S.kaleidoFbPulseRate, 1, 60, 10);
    fbAmtPhase += md / amtRate;
    fbAmtPhase -= Math.floor(fbAmtPhase);
    fbStreamPhase += md / streamRate;
    fbStreamPhase -= Math.floor(fbStreamPhase);
    fbTwistPhase += md / twistRate;
    fbTwistPhase -= Math.floor(fbTwistPhase);
    fbPulsePhase += md / pulseRate;
    fbPulsePhase -= Math.floor(fbPulsePhase);
    fbAmtPhase = roomPhase(fbAmtRoom, fbAmtPhase, t, md, amtRate, S.kaleidoFbAmtVarRateOff || 0);
    fbStreamPhase = roomPhase(fbStreamRoom, fbStreamPhase, t, md, streamRate, S.kaleidoFbStreamVarRateOff || 0);
    fbTwistPhase = roomPhase(fbTwistRoom, fbTwistPhase, t, md, twistRate, S.kaleidoFbTwistVarRateOff || 0);
    fbPulsePhase = roomPhase(fbPulseRoom, fbPulsePhase, t, md, pulseRate, S.kaleidoFbPulseRateOff || 0);

    const fbBase = clampNum(S.kaleidoFbAmt, 0, 1, 0);
    const amtVar = clampNum(S.kaleidoFbAmtVar, 0, 1, 0);
    const fbS = fbBase * (1 - amtVar * 0.5 * (1 - Math.cos(TAU * fbAmtPhase)));
    const fbStream = swing(clampNum(S.kaleidoFbStream, -2, 2, 0),
      clampNum(S.kaleidoFbStreamVarLo, -4, 0, 0), clampNum(S.kaleidoFbStreamVarHi, 0, 4, 0), fbStreamPhase, -2, 2);
    const twistBase = clampNum(S.kaleidoFbTwist, -1, 1, 0);
    // kaleidoFbTwistVarMix crossfades the plain setting into the swing while
    // the performance window brings the variance in or out (1 when unset)
    const twistMix = clampNum(S.kaleidoFbTwistVarMix, 0, 1, 1);
    const fbTwist = S.kaleidoFbTwistVarOn === false ? twistBase
      : twistBase + (swing(twistBase, clampNum(S.kaleidoFbTwistVarLo, -2, 0, 0),
        clampNum(S.kaleidoFbTwistVarHi, 0, 2, 0), fbTwistPhase, -1, 1) - twistBase) * twistMix;
    S.effKaleidoFbAmt = fbS;
    S.effKaleidoFbStream = fbStream;
    S.effKaleidoFbTwist = fbTwist;

    let pulse = clampNum(S.kaleidoFbPulse, 0, 1, 0);
    const pulseVar = clampNum(S.kaleidoFbPulseVar, 0, 1, 0);
    if (pulseVar > 0) pulse *= 1 - pulseVar * 0.5 * (1 - Math.cos(TAU * fbPulsePhase));
    pulse = scaledStrobeDepth(pulse);
    S.effKaleidoFbPulse = pulse;
    const l = lum > 0 ? (lum < 1 ? lum : 1) : 0;
    fbGain = 1 - pulse + pulse * l;
    fbOpacity = clampNum(S.effKaleidoFbOpacity ?? S.kaleidoFbOpacity, 0, 1, 1);

    // The route keys off the setting, not this frame's dip, so a dip to 0
    // clears for those frames (keepHalfLife 0) without letting the image go.
    fbOn = fbBase > 0;
    if (!fbOn) {
      if (fbScreen) fbScreen.release();
      return;
    }
    // the echo fades with the layer (see above)
    fbOpacity *= opacity;
    if (!fbScreen) {
      fbScreen = createFeedback(device, format, { label: 'kaleido.feedback' });
      fbFoldPipe = device.createRenderPipeline({
        layout,
        vertex: { module: mod, entryPoint: 'vsFold' },
        fragment: { module: mod, entryPoint: 'fsFold', targets: [{ format: FEEDBACK_FORMAT, blend: over }] },
        primitive: { topology: 'triangle-list' }
      });
    }
    // The image stands for the canvas at the Render section's Trail res,
    // its centre the field centre and its unit the pattern's rim radius, so
    // a drawer slide carries and rescales the trails with the pattern
    // (feedback.js). The fold drawing into it takes the same scale (fbScale,
    // applied to its uniforms in update).
    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    const visW = Math.max(1, cssW - inset);
    fbScale = feedbackRes(S.fbResScale);
    fbScreen.ensure(pixelW, pixelH, fbScale, feedbackKeep(S.fbResSwitch));
    fbParams.keepHalfLife = HL_MAX * fbS * fbS;
    fbParams.zoomRate = STREAM_MAX * fbStream;
    fbParams.twistRate = TWIST_MAX * fbTwist;
    fbParams.cx = (inset + visW * 0.5) * dpr;
    fbParams.cy = cssH * 0.5 * dpr;
    fbParams.unit = Math.hypot(visW, cssH) * 0.62 * dpr;
    fbParams.dt = md;
  }

  // t is the rAF timestamp (ms), dt seconds, lum this frame's strobe level.
  function update(t, dt, lum) {
    active = false;
    slideDraw = false;
    instCount = 0;
    fbOn = false; liveDraw = false; fbDraw = false;
    const lyr = S.layers;
    if (!lyr || !lyr.kaleido) {
      // Off: the trails go with the layer, so it comes back from a clear image.
      wasOn = false;
      if (fbScreen) fbScreen.release();
      return;
    }
    const wantDef = kaleidoscopeSet(S.kaleidoSet);
    const wantUrl = atlasUrl(wantDef);
    if (wantDef.id !== requestedSet || wantUrl !== requestedUrl) changeSet(wantDef.id, wantUrl);
    if (!ready) return;

    const folds = Math.round(clampNum(S.kaleidoFolds, 3, MAX_FOLDS, 8));
    const mirror = S.kaleidoMirror !== false;   // missing means on
    const density = clampNum(S.kaleidoDensity, 0, 1, 0.5);
    const speed = clampNum(S.kaleidoSpeed, 0, 3, 1);
    const speedVar = clampNum(S.kaleidoSpeedVar ?? 0.15, 0, 1, 0.15);
    const speedPeriod = clampNum(S.kaleidoSpeedPeriod ?? 10, 1, 60, 10);
    const sizeMul = clampNum(S.kaleidoSize, 0.2, 3, 1);
    const sizeVar = clampNum(S.kaleidoSizeVar, 0, 1, 0.6);
    const spinMax = clampNum(S.kaleidoSpinMax, 0, 3, 0.35);
    const spinVar = clampNum(S.kaleidoSpinVar, 0, 1, 0.7);
    const twist = clampNum(S.kaleidoTwist, -1, 1, 0.04);
    const orbitMax = clampNum(S.kaleidoOrbitMax ?? 0.25, 0, 2, 0.25);
    const orbitVar = clampNum(S.kaleidoOrbitVar ?? 0.7, 0, 1, 0.7);
    const scatter = clampNum(S.kaleidoScatter ?? 0, 0, 1, 0);
    const opacity = clampNum(S.effKaleidoOpacity ?? S.kaleidoOpacity, 0, 1, 0.9);
    const tintAmt = clampNum(S.effKaleidoTint ?? S.kaleidoTint, 0, 1, 0);
    const pulse = scaledStrobeDepth(clampNum(S.kaleidoPulse, 0, 1, 0));
    // With the Color switch off the grade is the identity, whatever the
    // sliders hold.
    const graded = S.kaleidoGrade === true;
    const bright = graded ? clampNum(S.kaleidoBright ?? 1, 0, 2, 1) : 1;
    const contrast = graded ? clampNum(S.kaleidoContrast ?? 1, 0, 2, 1) : 1;
    const sat = graded ? clampNum(S.kaleidoSat ?? 1, 0, 2, 1) : 1;
    const constWant = S.kaleidoConstSize === true ? 1 : 0;
    fadeNow = clampNum(S.effKaleidoFade ?? S.kaleidoFade ?? 0.55, 0, 1, 0.55);
    // The current set follows the families setting live, except while a
    // newer set is still loading: S.kaleidoFamilies already belongs to that
    // one, and births meanwhile keep the families they had.
    const curSlot = slots[cur], outSlot = slots[1 - cur];
    if (curSlot.set === requestedSet) refreshFamilies(curSlot);
    meanFillNow = xfadeAge < xfadeLen && outSlot.allowedCount
      ? outSlot.meanFill + (curSlot.meanFill - outSlot.meanFill) * (xfadeAge / xfadeLen)
      : curSlot.meanFill;

    // The domain: mirrored, half a wedge (mirror line to mirror line);
    // unmirrored, the whole wedge. The size law fits the largest object
    // whole between its seat line and the nearest domain edge: half the
    // domain either side of its centre line, or with SEAT_ON_MIRROR the
    // whole domain either side of the mirror line it sits on.
    const wedge = TAU / folds;
    mirrorOn = mirror;
    spanNow = mirror ? wedge * 0.5 : wedge;
    seatMirror = mirror && SEAT_ON_MIRROR;
    scatterNow = scatter;
    sizeVarNow = sizeVar;
    const fitAng = seatMirror ? spanNow : spanNow * 0.5;
    const fitK = Math.min(Math.sin(fitAng) * (1 - FIT_MARGIN) / CORNER, SIZE_CAP * 0.5);
    const sideK = 2 * fitK * sizeMul;
    reachKNow = sideK * 0.5 * CORNER;
    // While a symmetry slide runs, the chamber is sized, and filled, for
    // the wider of the two domains, so each fold finds content across all
    // it reads. Both are centred on straight up, so the narrower one's read
    // is a part of the wider one's. Everything else (motion, births, the
    // coverage target, the size law) is the new symmetry's alone.
    const sliding = trackSymmetry(folds, mirror, dt);
    const readSpan = sliding && oldSpan > spanNow ? oldSpan : spanNow;

    // Travel per second (a whole flight is LOG_SPAN e-folds), a flight's
    // length in seconds, and the live count density's coverage asks for.
    const travel = speed * ZOOM_RATE / LOG_SPAN;
    const lifeSec = speed > 0 ? LOG_SPAN / (ZOOM_RATE * speed) : STILL_LIFE;
    const target = coverageTarget(density, fitK * sizeMul, sizeVar, constWant, lifeSec, orbitMax, orbitVar);

    if (!wasOn) {
      wasOn = true;
      constBlend = constWant;       // the prewarmed chamber starts under the chosen law
      if (KDIAG) { dgEvent = 'prewarm'; dgLog('prewarm, target ' + Math.round(target)); }
      clearPool();
      prewarm(Math.round(target), lifeSec, spinMax, spinVar, orbitMax, orbitVar);
      spawnAcc = 0; spawnGap = 1;
      fade = 0;
    }
    if (fade < 1 && dt > 0) fade = Math.min(1, fade + dt / FADE_IN_SECONDS);
    // Eased on wall time, not the strobe's clock, so the toggle shows even
    // while paused; a frame with no time to ease over simply lands on it.
    if (constBlend !== constWant) {
      if (dt > 0) {
        constBlend += (constWant - constBlend) * (1 - Math.exp(-dt / CONST_EASE_SECONDS));
        if (Math.abs(constWant - constBlend) < 0.001) constBlend = constWant;
      } else {
        constBlend = constWant;
      }
    }

    // The Speed slider's glowing bar (schema-kaleido.js reads it as the
    // control's effective): one reference swing at the base rate, the
    // envelope each shape follows with its own phase and weight, floored
    // as theirs are. It holds where it is while the scene is paused.
    {
      let v = 1 + speedVar * Math.sin(velRefPh);
      if (v < SPEED_FLOOR) v = SPEED_FLOOR;
      S.effKaleidoSpeed = speed * v;
    }

    // The frame's step, eased to 0 over the pause wind-down (core/motion.js).
    fadeInSNow = clampNum(S.kaleidoFadeInS ?? 1.5, 0, 10, 1.5);
    const md = dt > 0 ? motionStep(dt) : 0;
    if (md > 0) {
      clockS += md;
      // The births' crossfade runs on the same clock as the births.
      if (xfadeAge < xfadeLen) xfadeAge += md;
      twistAng = (twistAng + md * twist) % TAU;
      velRefPh = (velRefPh + md * TAU / speedPeriod) % TAU;
      advance(md, travel, spinMax, spinVar, orbitMax, orbitVar, speedVar, speedPeriod);
      // Births at the centre arrive at the rate that holds the live count at
      // its target (target objects per flight), at jittered intervals so
      // they come in a loose trickle rather than a metronome.
      //
      // The density is steered ONLY through that rate. A shape may enter
      // only by being born at the centre and leave only past the rim (or
      // behind a mirror); it must never appear or vanish mid-view. So a thin
      // pattern is filled by births up to three times as fast, and a full
      // one by pausing births until enough have flown out, never by adding
      // or removing shapes where they stand.
      const deficit = (target - live) / (target > 1 ? target : 1);
      let steer = 1 + 2 * deficit;
      if (steer < 0) steer = 0; else if (steer > 3) steer = 3;
      spawnAcc += md * target * travel * steer;
      while (spawnAcc >= spawnGap) {
        spawnAcc -= spawnGap;
        spawnGap = 0.5 + Math.random();
        spawn(0);
      }
    }
    // Any on-the-spot fade left over from an older pool still runs out, but
    // nothing starts one any more (balance() is no longer called).
    if (dt > 0) settle(dt);
    // The outgoing set's atlas goes once the crossfade is over and its last
    // piece has retired.
    if (outSlot.tex && users[1 - cur] <= 0 && !(xfadeAge < xfadeLen)) { dropSlot(outSlot); rebind(); }
    // A set waiting on a draining slot moves in once its last piece is gone
    // (see install).
    if (drainSlot >= 0 && users[drainSlot] <= 0) {
      const tex = drainTex, fill = drainFill, set = drainSet, url = drainUrl, lay = drainLay;
      drainSlot = -1; drainTex = null; drainFill = null;
      install(tex, fill, set, url, lay);
    }
    // The trails run whether or not anything is drawn this frame, so trails
    // already made keep fading, streaming and turning.
    stepTrails(t, md, lum, opacity);
    if (!live) return;

    // Pulse 0 keeps the layer at steady brightness whatever the strobe does
    // (the photosensitive-safe default); 1 lets it follow lum all the way.
    // The fold applies it, so the chamber itself never strobes. Trails
    // never touch it: the fold into the trails image has a gain of its own,
    // the switch-on fade alone (the layer's opacity and the Trails pulse
    // ride the echo as it is laid over, stepTrails), so a live fold dimmed
    // out or strobed dark still feeds the trails.
    const l = lum > 0 ? (lum < 1 ? lum : 1) : 0;
    const gain = opacity * (1 - pulse + pulse * l) * fade;
    liveDraw = gain >= 0.002;
    fbDraw = fbOn && fade >= 0.002;
    if (!liveDraw && !fbDraw) {
      // Nothing is drawn, so every piece is out of sight.
      if (drainSlot >= 0) for (let n = 0; n < live; n++) hideSwap(order[n]);
      return;
    }

    const cssW = S.W || pixelW / dpr, cssH = S.H || pixelH / dpr;
    const inset = S.edgeInset || 0;
    // Composed inside the area the drawer leaves visible, like the rings and
    // flowers, so opening the panel recentres the kaleidoscope too.
    const visW = Math.max(1, cssW - inset);
    const cx = (inset + visW * 0.5) * dpr, cy = cssH * 0.5 * dpr;
    // The farthest any screen pixel sits from the centre. The fold turns
    // every pixel into the domain at its own radius, so the chamber must
    // reach this far straight up and this far times the domain's half angle
    // across; the texels per pixel are whatever makes that fit.
    const farX = cx > pixelW - cx ? cx : pixelW - cx;
    const farY = cy > pixelH - cy ? cy : pixelH - cy;
    const reachPx = Math.max(1, Math.hypot(farX, farY));

    const halfSin = Math.sin(readSpan * 0.5);
    ensureChamber(halfSin);
    if (sliding && !foldBind2) makeFoldBind2();
    const scaleUp = (chamberH - 2 * CHAMBER_PAD) / reachPx;
    const scaleAcross = (chamberW * 0.5 - CHAMBER_PAD) / (reachPx * halfSin);
    const s = scaleUp < scaleAcross ? scaleUp : scaleAcross;
    // The rim, and the fold's hole about the centre (see HOLE_PAD_TEXELS):
    // the newborn's radius plus the largest painted reach any object can
    // have there (reachKNow of its radius; size variance and the constant
    // size law only ever shrink it), plus the bilinear clearance.
    const maxR = Math.hypot(visW, cssH) * 0.62 * dpr;
    const holeR = K_BIRTH * maxR * (1 + reachKNow) + HOLE_PAD_TEXELS / s;
    dbgMaxR = maxR; dbgHoleR = holeR; dbgSideK = sideK; dbgSizeVar = sizeVar;
    dbgCx = cx; dbgCy = cy;

    const rgb = S.rgb;
    const peak = Math.max(rgb[0], rgb[1], rgb[2], 1);
    uni[0] = chamberW; uni[1] = chamberH; uni[2] = 1 / chamberW; uni[3] = 1 / chamberH;
    uni[4] = chamberW * 0.5; uni[5] = chamberH - CHAMBER_PAD; uni[6] = s; uni[7] = holeR;
    uni[8] = rgb[0] / peak; uni[9] = rgb[1] / peak; uni[10] = rgb[2] / peak; uni[11] = tintAmt;
    uni[12] = cx; uni[13] = cy; uni[14] = wedge; uni[15] = twistAng;
    uni[16] = UP - spanNow * 0.5; uni[17] = mirror ? 1 : 0; uni[18] = gain; uni[19] = 0;
    uni[20] = bright; uni[21] = contrast; uni[22] = sat; uni[23] = 0;
    // The slide's old fold: the same chamber, seat, scale, hole, colour and
    // rotation, folded to the old symmetry. Each fold's gain carries its
    // weight, so the hole and the strobe pulse ride both alike.
    if (sliding) {
      uni2.set(uni);
      uni2[14] = TAU / oldFolds; uni2[16] = UP - oldSpan * 0.5; uni2[17] = oldMirror ? 1 : 0;
      uni2[18] = gain * (1 - slideK);
      uni[18] = gain * slideK;
    }
    // The folds into the trails image: the live fold's uniforms, then its
    // pixels are the image's texels, Trail res to a device pixel, so the
    // centre and hole scale by it and the chamber's texels per pixel by its
    // inverse (as fold.js fit); and its gain the switch-on fade alone, each
    // symmetry at its slide weight.
    if (fbDraw) {
      if (!fbFoldBind) makeFbFoldBind(false);
      if (sliding && !fbFoldBind2) makeFbFoldBind(true);
      const into = fbScale;
      uniFb.set(uni);
      uniFb[6] = s / into; uniFb[7] = holeR * into; uniFb[12] = cx * into; uniFb[13] = cy * into;
      uniFb[18] = fade * (sliding ? slideK : 1);
      if (sliding) {
        uniFb2.set(uni2);
        uniFb2[6] = uniFb[6]; uniFb2[7] = uniFb[7]; uniFb2[12] = uniFb[12]; uniFb2[13] = uniFb[13];
        uniFb2[18] = fade * (1 - slideK);
      }
    }

    sortOrder();
    instCount = buildInstances(sideK, sizeVar, maxR, reachPx, s, holeR, readSpan);
    if (KDIAG) kaldiag(t);
    if (!instCount) return;
    device.queue.writeBuffer(instBuf, 0, inst, 0, instCount * INST_FLOATS);
    device.queue.writeBuffer(uniBuf, 0, uni);
    if (sliding) device.queue.writeBuffer(uniBuf2, 0, uni2);
    if (fbDraw) {
      device.queue.writeBuffer(uniFbBuf, 0, uniFb);
      if (sliding) device.queue.writeBuffer(uniFb2Buf, 0, uniFb2);
    }
    slideDraw = sliding;
    active = true;
  }

  // The diagnostic's frame work (see KDIAG): the drop check, the heartbeat
  // and the order-flip count. dgCur maps each drawn slot to its place in
  // the draw order and its screen position; a pair drawn both frames whose
  // order swapped while their quads overlap flipped who is on top.
  // A change of folds or mirror logs itself once, at the change, naming
  // the old and new symmetry and the slide time (see trackSymmetry).
  let dgFlips = 0;
  const dgSlot = new Int32Array(MAX_INST);   // which pool slot drew instance n
  function kaldiag(t) {
    if (instCount < dgInst * 0.75 && dgInst - instCount > 3) {
      dgLog('drawn count fell ' + dgInst + ' -> ' + instCount + (dgEvent ? ' after ' + dgEvent : ''), 'live ' + live);
    }
    dgInst = instCount;
    const tmp = dgPrev; dgPrev = dgCur; dgCur = tmp; dgCur.clear();
    for (let n = 0; n < instCount; n++) {
      const b = n * INST_FLOATS;
      dgCur.set(dgSlot[n], { n, x: inst[b], y: inst[b + 1], h: inst[b + 2] });
    }
    for (const [ka, a] of dgCur) {
      const pa = dgPrev.get(ka);
      if (!pa) continue;
      for (const [kb, c] of dgCur) {
        if (kb <= ka) continue;
        const pb = dgPrev.get(kb);
        if (!pb) continue;
        const dx = a.x - c.x, dy = a.y - c.y, rr = (a.h + c.h) * 1.2;
        if (dx * dx + dy * dy < rr * rr && (a.n - c.n) * (pa.n - pb.n) < 0) dgFlips++;
      }
    }
    if (t - dgBeat > 2000) {
      dgLog('beat: live ' + live + ', drawn ' + instCount + ', order flips ' + dgFlips + ' in ' + ((t - dgBeat) / 1000).toFixed(1) + 's');
      dgBeat = t; dgFlips = 0; dgEvent = '';
    }
  }

  // Every live object, in stable paint order, as device px from the field centre.
  // Travel to radius is the continuous zoom (see radiusK), and the fade is
  // the rings' radialFade at the Fade in setting against maxR, the same rim
  // as the ring layer (both are hypot(visible width, height) * 0.62); the
  // newborn's own way into view is the fold's hole (holeR, see
  // HOLE_PAD_TEXELS), not a fade of its own. An
  // object fading in or out on the spot (see balance) carries that too. Each object's
  // up axis is its own ray outward plus its spin. Its size follows the
  // radius, or at constant size the fixed CONST_K share of the rim, blended
  // by constBlend.
  //
  // Mirrored, an object is drawn once if any of it is inside the domain and
  // not at all otherwise. Unmirrored, it is drawn at every whole-wedge turn
  // of its angle that overlaps the domain: once for most, twice while it
  // straddles an edge, so what slides out one side is already sliding in at
  // the other and the rotation closes without a seam.
  //
  // Every object left out here is out of sight, so one still drawing from a
  // draining atlas slot may take its new image there (hideSwap); one inside
  // the hole or past a mirror counts only when clear of the fold's bilinear
  // reach as well (pad, in device px).
  //
  // readSpan is the angle the folds read: the domain itself, or while a
  // symmetry slide runs the wider of the old and new domains. Pieces keep
  // their seats in the new domain (span); only how far out they count as
  // seen widens, to rh domain widths either side of the centre line, so
  // the old fold finds the pieces, or mirrored the band, across its whole
  // wedge. Unmirrored, the copies past the new domain feed only the old
  // fold, so near the instance limit they give way, keeping room for every
  // piece still to come to show in the new one.
  function buildInstances(sideK, sizeVar, maxR, reachPx, s, holeR, readSpan) {
    const span = spanNow, whole = Math.PI / span, rh = 0.5 * readSpan / span;
    const pad = HOLE_PAD_TEXELS / s;
    let n = 0;
    for (let q = 0; q < live; q++) {
      const i = order[q];
      const d = depth[i], k = radiusK(d);
      // The layer's gain (opacity, pulse, fade-in) is the fold's to apply,
      // so the chamber holds only each object's own fades.
      let alpha = radialFade(fadeNow, k) * appear[i];
      // The piece's own fade in, by time: smooth over its first fadeInSNow
      // seconds on the motion clock, however it was born. Pieces the
      // prewarm aged mid-flight are back-dated past it (age()).
      if (fadeInSNow > 0.05) {
        const a01 = (clockS - bornT[i]) / fadeInSNow;
        if (a01 < 1) alpha *= a01 <= 0 ? 0 : a01 * a01 * (3 - 2 * a01);
      }
      if (alpha < 0.003) { hideSwap(i); continue; }

      const r = maxR * k;
      const half = r * sideK * (1 - sizeVar * sizeRnd[i]) * 0.5 * (constBlend > 0 ? sizeLaw(k) : 1);
      if (half * s < MIN_HALF_TEXELS) { hideSwap(i); continue; }
      if (r - half * CORNER > reachPx) {                             // wholly beyond every screen pixel
        if (r - half * CORNER - pad > reachPx) hideSwap(i);
        continue;
      }
      // Wholly inside the hole, where the fold reads nothing: every newborn,
      // until its flight carries it out across the hole's edge.
      if (r + half * CORNER + pad <= holeR) { hideSwap(i); continue; }

      // The angular half width from this frame's size and radius, exactly
      // what reachU() gives but without working the depth out again.
      // Mirrored, an object whose centre is inside the domain is drawn
      // whatever its width, so the asin is only needed for one outside it.
      const u = phiU[i];
      const ratio = half * CORNER / r;
      let e = 0;
      let kLo = 0, kHi = 0;
      let nLo = 0, nHi = 0;
      if (mirrorOn) {
        if (u >= rh || u <= -rh) {
          e = ratio >= 1 ? Infinity : Math.asin(ratio) / span;
          if (Math.abs(u) - e >= rh) {
            const rp = (half * CORNER + pad) / r;
            if (rp < 1 && Math.abs(u) - Math.asin(rp) / span >= rh) hideSwap(i);
            continue;
          }
        }
      } else {
        e = ratio >= 1 ? Infinity : Math.asin(ratio) / span;
        if (e > whole) e = whole;
        kLo = Math.ceil(-rh - e - u);
        kHi = Math.floor(rh + e - u);
        nLo = Math.ceil(-0.5 - e - u);
        nHi = Math.floor(0.5 + e - u);
      }
      const spin = spinAng[i], motif = motifOf[i];
      for (let kk = kLo; kk <= kHi; kk++) {
        if (n >= MAX_INST) return n;
        if ((kk < nLo || kk > nHi) && n >= MAX_INST - 2 * (live - q)) continue;
        const th = UP + (u + kk) * span;
        const o = th + spin;
        const b = n * INST_FLOATS;
        if (KDIAG) dgSlot[n] = i;
        inst[b] = Math.cos(th) * r; inst[b + 1] = Math.sin(th) * r; inst[b + 2] = half; inst[b + 3] = alpha;
        inst[b + 4] = Math.cos(o); inst[b + 5] = Math.sin(o); inst[b + 6] = motif; inst[b + 7] = atlasOf[i];
        n++;
      }
    }
    return n;
  }

  // The chamber pass, encoded by the engine before the scene pass on any
  // frame the layer draws: cleared to transparent, then every object once.
  // With trails the trails image follows it (encodeTrails).
  function encodeChamber(encoder) {
    if (active && spriteBind && chamberView) {
      const pass = encoder.beginRenderPass(chamberPassDesc);
      pass.setPipeline(spritePipe);
      pass.setBindGroup(0, spriteBind);
      pass.setVertexBuffer(0, instBuf);
      pass.draw(6, instCount);
      pass.end();
    }
    if (fbOn) encodeTrails(encoder);
  }

  // The trails image's own pass, after the chamber's: it fades, streams
  // and turns the last image in (feedback.js begin), and the fold, both
  // symmetries while a slide runs, goes into it at its own uniforms. It runs
  // with nothing to fold too, so trails keep dying away while the layer is
  // dimmed out. Held (stopped with trails), begin only carries the image
  // with the field.
  function encodeTrails(encoder) {
    if (fbScreen.holds(fbParams)) { fbScreen.begin(encoder, fbParams, false); return; }
    const drawing = active && fbDraw && !!spriteBind && !!chamberView && !!fbFoldBind;
    // An image already faded to nothing with nothing to add is skipped, and
    // so is its composite (feedback.js).
    const lp = fbScreen.begin(encoder, fbParams, drawing);
    if (!lp) return;
    if (drawing) {
      lp.setPipeline(fbFoldPipe);
      if (slideDraw && fbFoldBind2) {
        lp.setBindGroup(0, fbFoldBind2);
        lp.draw(3);
      }
      lp.setBindGroup(0, fbFoldBind);
      lp.draw(3);
    }
    fbScreen.end(lp);
  }

  // The fold, inside the scene pass where the kaleidoscope sits in the
  // layer order: one fullscreen triangle, one chamber read per pixel.
  // While a symmetry slide runs, the old symmetry is folded first and the
  // new one over it, each at its own weight (see trackSymmetry). With
  // trails the echo goes down first, the trails image at the Trails Opacity
  // with the Trails pulse on its colour, and the live fold over it as ever,
  // so the echoes sit under the present. The composite skips itself at an
  // opacity of 0.002 and below, leaving the live fold alone.
  function draw(pass) {
    if (fbOn) fbScreen.composite(pass, fbGain, fbOpacity);
    if (!active || !liveDraw || !foldBind) return;
    pass.setPipeline(foldPipe);
    if (slideDraw && foldBind2) {
      pass.setBindGroup(0, foldBind2);
      pass.draw(3);
    }
    pass.setBindGroup(0, foldBind);
    pass.draw(3);
  }

  // The debug page's window into the pool (tools/kaleido-test.html): every
  // live piece, drawn into the chamber or not, as plain numbers, with the
  // frame's wedge and geometry. It allocates, so the app's own frames never
  // call it; only the test page does, once a frame.
  function inspect() {
    const pieces = [];
    for (let n = 0; n < live; n++) {
      const i = order[n], d = depth[i], k = radiusK(d);
      const r = dbgMaxR * k;
      const half = r * dbgSideK * (1 - dbgSizeVar * sizeRnd[i]) * 0.5 * (constBlend > 0 ? sizeLaw(k) : 1);
      pieces.push({ u: phiU[i], r, half, born: clockS - bornT[i], atlas: atlasOf[i] });
    }
    return { pieces, span: spanNow, mirror: mirrorOn, maxR: dbgMaxR, holeR: dbgHoleR,
             cx: dbgCx, cy: dbgCy, clock: clockS, live };
  }

  return { update, encodeChamber, draw, resize, inspect };
}
