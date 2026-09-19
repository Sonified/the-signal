// Shared mutable parameter state.
//
// The monolith kept every one of these as a module-level `let` inside one IIFE.
// An ES module cannot export a writable binding, so they all live on one object
// instead. It is a plain object touched from a handful of hot loops, so property
// access stays monomorphic and nothing here allocates.

export const S = {
  // ---------- rendering surface ----------
  ctx: null,                  // 2d context, created lazily: a canvas can only ever
                              // hand out one context kind, so asking for '2d' up
                              // front would permanently lock out WebGPU
  W: 0, H: 0, DPR: 1,
  renderer: null,             // set once the chosen backend is ready
  // Canvas2D by default: it is the only backend whose visuals are verified, and
  // the stall this app was chasing turned out to be system load rather than the
  // rendering path, so the GPU backends buy nothing until they are finished.
  rendererPref: 'canvas2d',   // auto | webgpu | webgl2 | canvas2d

  // ---------- strobe ----------
  freq: 7.5, depth: 0.80, bright: 1.0, wave: 'square', duty: 0.5,
  rgb: [127, 178, 255],
  fieldShape: 'full',
  running: false,

  // phase is ACCUMULATED so frequency changes never cause a click
  phase: 0, lastPhase: 0, lastT: null,

  // Frequency drift swings symmetrically around the set frequency. Sine rather
  // than cosine so it starts at zero deviation, i.e. exactly where the slider says.
  freqDrift: 1, driftPeriod: 60, driftPhase: 0, effFreq: 10,

  // At high frequencies there are only a few frames per cycle, and advancing the
  // phase by elapsed time lands those few samples at different points of the
  // waveform every cycle. Frame lock instead advances by exactly one Nth of a
  // cycle per rendered frame, so every cycle is sample-identical. The cost is
  // that the achieved frequency snaps to refresh/N, which at 120 Hz and 40 Hz is
  // 39.98 rather than 40.00.
  frameLock: true, achievedFreq: 10, framesPerCycle: 0, frameIdx: 0,

  // Slow drift applied to depth. Its own accumulator so it is independent of the
  // strobe rate. It only ever subtracts: effDepth swings from the set depth down
  // toward zero and back, never above what the slider says.
  depthVar: 0.80, varPeriod: 10, varPhase: 0, effDepth: 0.80,

  // Brightness drift is deliberately applied to the FIELD only. As the centre
  // dims, the periphery keeps its level and attention drifts outward, which is
  // the whole point of an open-focus tool.
  brightVar: 0.85, brightVarPeriod: 22, brightVarPhase: 0, effBright: 1.0,

  // Rings run the same variance amount and rate on their own accumulator, started
  // half a cycle out, so the centre and the tunnel breathe against each other
  // rather than dimming together.
  ringBrightVar: 0.55, ringBrightPeriod: 10, ringBrightPhase: 0.5, effRingBright: 0.70,

  // ---------- tunnel and edge ----------
  ringSpeedMul: 0.5, edgeCount: 60, edgeSize: 6, trailMul: 1, ringFade: 0.55,
  edgeSpeedMul: 4, edgeDir: 'both',
  // Edge speed and size get the same dip-from-the-top variance the strobe uses,
  // each on its own accumulator and started at a different phase so the two
  // never breathe in lockstep.
  edgeSpeedVar: 0.5, edgeSpeedVarPeriod: 22, edgeSpeedVarPhase: 0,    effEdgeSpeed: 1,
  edgeSizeVar:  0.5, edgeSizeVarPeriod:  18, edgeSizeVarPhase:  0.37, effEdgeSize:  1,

  rings: [], particles: [], lastRingEmit: -1,

  // ---------- colour ----------
  // Hue wanders via a damped random walk on its velocity rather than on the hue
  // itself, which gives an organic drift instead of a jitter.
  colorWalk: 0,
  colorMode: 'single', hue: 0, hueSat: 0.6, hueLight: 0.75, hueVel: 0,
  perElementColor: false,
  cornerHue: [0, 0.25, 0.5, 0.75], cornerHv: [0, 0, 0, 0],
  walkPeriod: 60,
  huePalette: [], paletteKey: '',

  // ---------- drawer geometry ----------
  panelOpen: false,
  // The edge circuit shrinks away from the drawer when it opens. Eased rather
  // than snapped so the particles glide inward alongside the panel animation.
  edgeInset: 0, edgeInsetTarget: 0, panelAnimating: false, panelAnimTimer: null,

  // ---------- frame health ----------
  refreshHz: 0, frameTimes: [], intervals: [], dropCount: 0,
  litLog: [],                 // per-frame lit/dark, so the diagnostics show the real pattern

  // ---------- audio ----------
  carrierHz: 40, amRate: 7.5, volume: 0.50, amLinked: true, lastAmSet: 0,
  toneOn: true, clickOn: true,
  toneVol: 0.3, clickVol: 0.33,
  harmOn: true, harmVol: 0.4, harmCount: 9, harmBright: 0.45,
  harmSpread: 0.7, harmPanRate: 0.45, harmReverb: 0.35,
  shimDepth: 0.57, shimRate: 0.12,
  clickModDepth: 0.55, clickModPeriod: 26,
  biDepth: 0, biPeriod: 1.0, biHardSwitch: true,
  clickReverb: 0.61, clickRevTime: 0.5,
  pipMs: 8,
  audioEnabled: false, workletReady: false,

  // ---------- layers ----------
  layers: { field: true, rings: true, corners: true, edge: true }
};

// convenience alias: the layer set is read in several hot paths
export const layers = S.layers;

// ---------- constants ----------
export const HUE_STEPS = 96;
// A symmetric random walk diffuses: it lingers wherever it happens to be and
// never tours the wheel evenly. So the direction is constant and the random
// part modulates speed instead. Coverage is guaranteed, the motion still
// breathes, and walkPeriod becomes a literal lap time.
export const WALK_STEP = 3.0, WALK_DAMP = 0.99, WALK_SWING = 0.8;

// Rings live in depth, not in radius. Each one travels toward the viewer at
// its own constant velocity and its apparent radius is FOCAL/z, so it crawls
// while far away and accelerates as it sweeps past. That hyperbolic growth is
// what reads as a tunnel; linear expansion always looks flat.
export const Z_FAR = 4.0, Z_NEAR = 0.10;
// Slow rings at low ring-spread can take over a minute to cross, so without a
// cap they accumulate into the hundreds and the per-frame sort grows without
// bound. That showed up as stalls that got steadily worse the longer it ran.
export const MAX_RINGS = 110;

export const LUT_N = 4096;                  // radial samples for the ring layer
export const MAX_EDGE_INST = 60 * 23;       // 60 particles * (22 segments + head)

// ---------- persistence keys ----------
export const STORE = 'openfocus.v1';
export const SKIP_KEY = STORE + '.skip';
export const GROUPS_KEY = STORE + '.groups';

// Renderer button ids, shared by the wiring and by the settings reader.
export const RENDER_BTNS = ['rAuto','rGPU','rGL','r2D'];
export const RENDER_MAP  = { auto:'rAuto', webgpu:'rGPU', webgl2:'rGL', canvas2d:'r2D' };
