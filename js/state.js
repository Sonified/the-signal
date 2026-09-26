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
  rgb: [212, 0, 255],
  fieldShape: 'full',
  fieldFade: 0,               // v1: the field's radial fade in, 0..1, the tunnel layers' curve
  fieldSoft: 1,               // v1: how soft that fade's edge is, 1 the full ease, 0 a hard circle
  running: false,

  // phase is ACCUMULATED so frequency changes never cause a click
  phase: 0, lastPhase: 0, lastT: null,

  // Frequency drift swings symmetrically around the set frequency. Sine rather
  // than cosine so it starts at zero deviation, i.e. exactly where the slider says.
  freqDrift: 1, driftPeriod: 60, driftPhase: 0, effFreq: 10,
  freqDriftOn: true,          // v1's switch over the drift; off holds the set frequency

  // At high frequencies there are only a few frames per cycle, and advancing the
  // phase by elapsed time lands those few samples at different points of the
  // waveform every cycle. Frame lock instead advances by exactly one Nth of a
  // cycle per rendered frame, so every cycle is sample-identical. The cost is
  // that the achieved frequency snaps to refresh/N, which at 120 Hz and 40 Hz is
  // 39.98 rather than 40.00.
  frameLock: true, achievedFreq: 10, framesPerCycle: 0, frameIdx: 0,
  // Which way the odd frame goes when the lock lands on an odd count. 'lit'
  // keeps the extra frame on (2-lit-1-dark at 3), 'dark' keeps it off
  // (1-lit-2-dark). Never alternate them: taking turns puts a line at half
  // the rate, and half of 40 is squarely in the photosensitive band.
  spareMode: 'lit',

  // Slow drift applied to depth. Its own accumulator so it is independent of the
  // strobe rate. It only ever subtracts: effDepth swings from the set depth down
  // toward zero and back, never above what the slider says.
  depthVar: 0.80, varPeriod: 10, varPhase: 0, effDepth: 0.80,
  depthVarOn: true,          // v1's switch over the depth variance

  // Brightness drift is deliberately applied to the FIELD only. As the centre
  // dims, the periphery keeps its level and attention drifts outward, which is
  // the whole point of an open-focus tool.
  brightVar: 0.85, brightVarPeriod: 22, brightVarPhase: 0, effBright: 1.0,
  brightVarOn: true,         // v1's switch over the brightness variance

  // Rings run the same variance amount and rate on their own accumulator, started
  // half a cycle out, so the centre and the tunnel breathe against each other
  // rather than dimming together.
  ringBrightVar: 0.55, ringBrightPeriod: 10, ringBrightPhase: 0.5, effRingBright: 0.70,

  // ---------- tunnel and edge ----------
  ringSpeedMul: 0.5, edgeCount: 60, edgeSize: 6, trailMul: 1, ringFade: 0.55, ringThick: 3, ringThickVar: 1,
  edgeOpacity: 1,             // v1: scales the edge particles' brightness
  edgeCap: 'wedge',           // v1: the edge particle's head, 'wedge' (<>), 'round' or 'ball'
  edgeSpeedMul: 4, edgeDir: 'both',
  // Edge speed and size get the same dip-from-the-top variance the strobe uses,
  // each on its own accumulator and started at a different phase so the two
  // never breathe in lockstep.
  edgeSpeedVar: 0.5, edgeSpeedVarPeriod: 22, edgeSpeedVarPhase: 0,    effEdgeSpeed: 1,
  edgeSizeVar:  0.5, edgeSizeVarPeriod:  18, edgeSizeVarPhase:  0.37, effEdgeSize:  1,

  rings: [], particles: [], lastRingEmit: -1,

  // ---------- color ----------
  // Hue wanders via a damped random walk on its velocity rather than on the hue
  // itself, which gives an organic drift instead of a jitter.
  colorWalk: 1,
  colorMode: 'rotating', hue: 0, hueSat: 0.6, hueLight: 0.75, hueVel: 0,
  perElementColor: false,
  cornerHue: [0, 0.25, 0.5, 0.75], cornerHv: [0, 0, 0, 0],
  // The walk can be confined to an arc of the wheel. Full turn by default;
  // warm is roughly magenta-red through amber, which is the half of the
  // spectrum that does not suppress melatonin.
  hueLo: 0, hueSpan: 1,
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
  // The pip train's slow lowpass sweep: off by default, and its period runs out
  // to five minutes so the train can drift into the background and back.
  // Period is one full down-and-up; wander varies each half-sweep's length and
  // depth; Q is the resonance at the cutoff (0.71 is flat).
  pipLpfOn: false, pipLpfLo: 400, pipLpfHi: 9000, pipLpfPeriod: 60,
  pipLpfQ: 0.71, pipLpfWander: 0.3,
  // Bilateral alternation is off by default. It is a strong effect and a
  // deliberate choice, not something a first visit should arrive already doing.
  biOn: false, biDepth: 0.6, biPeriod: 1.0, biHardSwitch: true,
  clickReverb: 0.53, clickRevTime: 0.5,
  pipMs: 8,
  // The pip train has two shapes. 'click' is the damped sine that has always
  // been here; 'chirp' is the delay-compensated sweep, which trades a longer
  // transient for every cochlear region firing at the same instant.
  clickMode: 'chirp',
  // The corner button trims the pip in decibels rather than writing the level
  // fader, so 'normal' always means whatever the fader says and the user's own
  // setting survives a trip through loud and back.
  pipTrimDb: 0,
  chirpLowHz: 150, chirpHighHz: 6000, chirpComp: 1, chirpTilt: 1.3,
  // The chirp keeps its own level and its own room. A sweep and a damped sine
  // need different amounts of both, and dialling one should never reach into
  // the other's settings.
  chirpVol: 0, chirpReverb: 0.37, chirpRevTime: 0.5,
  chirpModDepth: 0, chirpModPeriod: 26,
  audioEnabled: false, workletReady: false,

  // ---------- words ----------
  // Ticks come from the strobe by default so a word lands on the pulse instead
  // of beside it. Frequency is the share of ticks that get a word, randomness
  // is how much that share is a coin flip rather than a fixed slot, and dwell
  // is the whole time a word is on screen with the fades happening inside it.
  textLinked: true, textRateHz: 2,
  textFreq: 0.5, textRandom: 1,
  textDwellMs: 80, textFadeInMs: 0, textFadeOutMs: 0, textSize: 35,
  textFadeInVar: 0,           // v1: each word's fade-in rolls between (1-var)x and 1x the set time
  textFadeOutVar: 0,
  textOpacity: 0.95, textOpacityVar: 0.1, textOpacityVarPeriod: 20, textOpacityPhase: 0,
  textColorMode: 'system',    // white | system, where system follows the strobe hue
  textBrighten: 0,            // system mode only: 0 is the strobe colour, 1 is white
  // Rest: after a word has been and gone, roll for whether to stop showing them
  // for a while. Frequency is how often that roll says yes, duration is the base
  // length of the pause, and variance widens the range the actual length is drawn
  // from rather than making every pause longer.
  textRestFreq: 0.04, textRestSec: 10, textRestVar: 0.7,
  // Transitions (v1/core/word-fx.js): how the letters arrive and leave inside
  // the fade in and fade out times. Mirror has the word leave the way it came.
  // Distance is in word heights, the rest are 0..1.
  textFadeInOn: true, textFadeOutOn: true,   // v1: off, the word just appears / goes
  textFxIn: 'gather', textFxOut: 'wind', textFxMirror: false,
  textFxDist: 1.5, textFxStagger: 0.5, textFxTurb: 0.5, textFxBlur: 0.6,
  textFxEase: 0.6, textFxWindDir: 0,
  textCloudCount: 12000, textCloudSize: 1.6,   // legacy Cloud particle keys, kept for old saves
  // Smoke (v1/gpu/word-smoke.js): recorded-vapour tuning, all 0..1 except
  // speed (0..2, 1 is travel of about the Distance setting).
  textSmokeSpeed: 1, textSmokeSoft: 0.5, textSmokeLinger: 0.5,
  textSmokeRadial: 0.75, textSmokeAccel: 0.7, textSmokeEq: 0.5,   // Smoke: outward-vs-swirl balance, and motion wind-up
  textSmokeSweep: false, textSmokeSweepSpeed: 0.5,   // Smoke: dissolve behind a left-to-right front
  textGatherSweep: false,     // Gather: letters in left to right, Stagger the sweep's pace
  // Leave's own copy of the settings above, used unless the word leaves the way it came.
  textFxDistOut: 1.5, textFxStaggerOut: 0.5, textFxTurbOut: 0.5, textFxBlurOut: 0.6,
  textFxEaseOut: 0.6, textFxWindDirOut: 0,
  textSmokeSpeedOut: 1, textSmokeSoftOut: 0.5, textSmokeLingerOut: 0.5,
  textSmokeRadialOut: 0.75, textSmokeAccelOut: 0.7, textSmokeEqOut: 0.5,
  textSmokeSweepOut: false, textSmokeSweepSpeedOut: 0.5,
  textGatherSweepOut: false,
  textThemes: {},             // empty means every theme is in play
  textMode: 'words',          // 'words' shows the themed pool, 'affirmations' the phrases
  textLineWidth: 0.92,        // the wrap width, as a share of the view; phrases break to fit it
  textSmartBreaks: true,      // v1: a phrase with marked breaks (js/affirmations.js) takes a line per piece
  textLinesTogetherOut: false, // v1: the Fade out block's own switch, departures only
  textLinesTogether: false,   // false: a block's lines transition one after another, top first

  // ---------- music ----------
  // A generative felt piano whose root sits two octaves under the 40 Hz carrier,
  // over a looping ocean cavern drone. Every default here is a measurement from
  // four takes played by hand rather than a guess.
  musicOn: true,
  pianoVol: 0.9, pianoReverb: 1.0, pianoRevTime: 4.5,
  pianoOn: true,              // the generative piano voice alone
  bedOn: true,                // the ocean drone's own switch
  musicRevOn: true,           // the shared music room's wet output
  arpOn: false, arpVol: 0.5, arpRate: 7, arpWave: 'sine', arpAtk: 0.01, arpDec: 0.25, arpOct: 0, arpRev: 1, arpSpread: 0.9,
  arpStrobeAm: 0,             // 'Vary with strobe': depth of a volume pulse at the flash rate, 0..1
  // The sequencer's patterns (js/piano.js, the sequencer section): four of
  // them, each up to 16 steps, a step holding a written MIDI note or -1 for a
  // rest. seqSlot is the one playing. Pattern 1 is the original 3 4 8 figure.
  seqPatterns: [
    { len: 3, steps: [76, 77, 84, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1] },
    { len: 8, steps: new Array(16).fill(-1) },
    { len: 8, steps: new Array(16).fill(-1) },
    { len: 8, steps: new Array(16).fill(-1) }
  ],
  seqSlot: 0,
  arpSwOn: false, arpSwLo: 0, arpSwHi: 1, arpSwPeriod: 120, arpSwWander: 0.3,   // the 3 4 8 arpeggio: switch, level, notes per second
  pianoHP: 20,                // high-pass on the notes, Hz; 20 is the floor and reads as off
  pianoDensity: 1.0, pianoCentre: 72, pianoSpread: 0.55, pianoHold: 1.0,
  pianoRubato: 0.5,
  // pianoCall is rare by count but long (a call, maybe a climb, the answer,
  // often a rest on the 2: 20 to 45 s); pianoCluster runs 6 to 12 s. At these
  // weights the call takes about 30% of the playing time, the clusters about
  // 20%, and the four older gestures share the rest.
  pianoDyad: 46, pianoBloom: 18, pianoSingle: 26, pianoBass: 10, pianoCall: 12, pianoCluster: 20,
  // how the call and cluster gestures pick their notes: 'generative' writes
  // new phrases from rules measured on the takes, 'snippets' plays the takes'
  // own phrases back (js/piano.js)
  pianoStyle: 'generative',
  pianoLifts: true,
  bedVol: 0.30,
  bedDetune: 152,             // which render of the drone plays (audio/music/manifest.json)
  // The drone's two slow sweeps (js/piano.js), the click train's filter sweep
  // again with the drone's own settings. Both off by default, which leaves the
  // drone exactly as it always sounded. The filter's range and time suit a
  // slow bed: a long reach down, one down-and-up every minute and a half.
  // The room sweep moves the drone's feed into the piano's room as a share of
  // the usual feed (1 is the usual), on a slightly longer cycle so the two do
  // not lock together.
  bedLpfOn: false, bedLpfLo: 400, bedLpfHi: 12000, bedLpfPeriod: 90,
  bedLpfQ: 0.71, bedLpfWander: 0.3, bedLpfSlope: 12,
  bedRevOn: true, bedRevLevel: 1,   // the drone's reverb switch and its feed level
  bedVerbOn: false, bedVerbLo: 0.5, bedVerbHi: 1.5, bedVerbPeriod: 120,
  bedVerbWander: 0.3,

  // The clouds: eight sustained pads at the degrees of the same mode, played as
  // a wandering line. cloudPhrase is how often that line falls into the
  // descending figure from the second take rather than meandering, and it is
  // the control that decides whether the music drifts or says something.
  // cloudDensity sits at 1.0 = the rate of the take as played; the slider's
  // range runs well below that, which is the direction it wants to move.
  cloudsOn: true, cloudVol: 0.60, cloudDensity: 1.0, cloudPhrase: 0.35,
  cloudReverb: 1.0, cloudRevTime: 5.0,

  // ---------- ambience ----------
  // Fixed recording levels for balancing the atmosphere in the browser.
  ambOn: true, ambVol: 0.18,
  ambLayers: [
    { source: 'ocean', level: 0.55 },
    { source: 'forest', level: 0 },
    { source: 'rain', level: 0 }
  ],
  // Drift: an unattended hand on the mixer, slowly crossfading from one
  // recorded place to another instead of holding a fixed blend.
  ambDrift: false,
  ambDriftFadeS: 12,   // seconds one drift crossfade between places takes
  // Dry by default: these are real places, recorded in the room they were in.
  ambReverb: 0, ambRevTime: 4.5,

  // ---------- mix gate ----------
  // Mute and solo for the six fixed channels (see mixgate.js). The atmosphere
  // recordings keep their own flags on their layer objects. Nothing is muted
  // or soloed by default, and v0 never changes these, so v0 sounds as before.
  chanMute: { fund: false, harm: false, pulse: false, piano: false, clouds: false, drone: false, arp: false },
  chanSolo: { fund: false, harm: false, pulse: false, piano: false, clouds: false, drone: false, arp: false },

  // ---------- layers ----------
  layers: { field: true, rings: true, corners: true, edge: true, text: true }
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
