// The word smoke: recorded dissolutions, played backward for arrival and
// forward for departure (the Smoke choice under Arrive and Leave).
//
// Nothing is simulated on stage. Offscreen, in a bounded number of tiny
// compute steps per frame, a word is rasterised into a density field from
// its real glyphs at its real place and dissolved through a seeded wind,
// with snapshots copied into a texture-array recording. A transition only
// ever REPLAYS: arrival walks its recording from faintest frame back to
// frame zero, which IS the word; departure walks one forward. Between
// snapshots the playback warps each neighbour along the same analytic wind
// before blending (see fsSmoke), so motion is continuous at any frame rate
// instead of a crossfade of stills.
//
// Only ARRIVAL is recorded, because only arrival needs time reversal: the
// recording slot holds the NEXT word's dissolution (words.js picks a word
// ahead for this), replayed backward. DEPARTURE is simulated LIVE during
// the fade-out itself, at three quarters of the viewport's css size, stepping
// the same physics in real time: no snapshots, no interpolation, every
// frame a real step, and every smoke dial acts on the departure happening
// right now. Each recording and each live departure rolls its own flow
// seed, so nothing ever retraces anything.
//
// Deadlines, not stalls: an arrival whose recording is not ready plays as
// the plain fade instead (word-fx latches that choice at the phase's
// first frame). Departures cannot miss; the word on screen is the initial
// condition. Changing the word size makes a recording stale, not
// wrong-in-place.
//
// No per-frame allocations, no synchronous readback, nothing made until
// the effect is first used. Memory: the arrival recording, 640x320
// rgba16float x 48 layers (~79 MB), its ping-pong pair, and the live
// departure pair at 3/4 of the viewport (~9 MB on a laptop screen).

import { S } from '../js/state.js';
import { PREP_WGSL, PLAY_WGSL, WIND_WGSL, SMOKE_LETTERS } from './word-smoke.wgsl.js';
import { smokeState, smokeHint, hintSweepShare, fxv, fxLive, linesTogether, lineStep } from '../core/word-fx.js';
import { wordState, wordLife, fadeOutMs } from '../core/words.js';
import { W, TRACK } from '../ui/theme.js';
import { motionStep } from '../core/motion.js';

const TEX_W = 640, TEX_H = 320;
// The live departure's field is the viewport at three quarters of its css
// size, so it keeps the screen's own shape (a portrait phone gets a tall
// field, not a stretched wide one) and scales its cost with the screen.
const LIVE_SCALE = 0.75;
// The resting screen's hint leaves through the same live field, but its
// lines are 19 and 11.5 px against the word's 35, strokes about a css pixel
// wide, which three quarters scale would blur before the smoke even moves.
// So its field runs at the full css size; the next word's departure sizes
// the field back down.
const HINT_SCALE = 1;
// The baked wind's grids (see windMain): a third of each field's resolution,
// ample for a wind whose finest eddies span several of its texels.
const WIND_DIV = 3;
const WP_W = Math.ceil(TEX_W / WIND_DIV), WP_H = Math.ceil(TEX_H / WIND_DIV);
const SNAPS = 48;
const SLOTS = 1, ARR = 0;
const LIVE_DT = 1 / 120;
const MAX_LIVE_STEPS = 4;
const SIM_DT = 1 / 60;
const STEPS_PER_SNAP = 5;             // 235 steps -> 3.9 s, run TO EXTINCTION:
                                      // the last snapshot is empty air, so
                                      // playback starts from and returns to
                                      // nothing with no fade forced over it
const TOTAL_STEPS = (SNAPS - 1) * STEPS_PER_SNAP;
const REC_SECONDS = TOTAL_STEPS * SIM_DT;
const SNAP_S = REC_SECONDS / (SNAPS - 1);
const PREP_BUDGET = 26;               // steps per frame; a recording lands in ~6 frames
const UNI_FLOATS = 40;                // ten vec4f of U
const LETTER_FLOATS = SMOKE_LETTERS * 12;

// Bumped on every behaviour change, printed on load: the console proves
// which build the page is actually running, so a stale worker-module cache
// can never again masquerade as "nothing changed".
const SMOKE_BUILD = 16;
console.log('[smoke] build', SMOKE_BUILD);

export function createWordSmoke(device, format, text) {
  let made = false, playing = false, playSlot = -1;
  let densA = null, densB = null, recTex = null;
  let liveA = null, liveB = null, windLive = null;
  let liveW = 0, liveH = 0, wlW = 0, wlH = 0;
  let prepBgl = null, windBgl = null, playBgl = null, samp = null, atlasView = null;
  let uniBufs = null, compBuf = null, rasterBuf = null, letterBuf = null;
  let liveUni = null, liveRasterBuf = null, liveCompBuf = null;
  let rasterPipe = null, simPipe = null, playPipe = null;
  let rasterBind = null, simBinds = null, playBind = null;
  let windPipe = null, windPrepBinds = null, windLiveBinds = null;
  let liveRasterBind = null, liveSimBinds = null, playBindLive = null;
  let dpr = 1, cssW = 1, cssH = 1;
  const uni = new Float32Array(UNI_FLOATS);

  // one recording per slot: which word it holds, where that word sat, and
  // the air it was dissolved in (all baked; playback only replays)
  const rec = [null, null].map(() => ({
    text: '', ready: false,
    rx: 0, ry: 0, rw: 1, rh: 1, cx: 0, cy: 0,
    size: 35, count: 0, wind: 0, diff: 1, decayMul: 1, turb: 0.5, seed: 0,
    wx0: 0, wx1: 0,   // the ink's own x extent, for the playback sweep's clock
    icx: 0, icy: 0,   // the middle of the ink, where Outward pushes from
    radial: 0.75, accel: 0.7, eq: 0.5, availW: 0, lineW: 0.92, lines: 1, lineH: 0
  }));

  // the live departure: metadata mirrors a recording's, but the field is
  // stepped in real time while it is on screen
  const live = {
    text: '', rx: 0, ry: 0, rw: 1, rh: 1, cx: 0, cy: 0,
    size: 35, wind: 0, diff: 1, decayMul: 1, turb: 0.5, seed: 0,
    wx0: 0, wx1: 0, icx: 0, icy: 0, fadeS: 3, tailS: 6, radial: 0.75, accel: 0.7, eq: 0.5,
    lines: 1, lineH: 0,
    // the look the field plays to its end, taken as it is armed, so a tail
    // still flowing after its word has gone never borrows the next word's:
    // the sweep share gating the physics, the ease, how many lines run one
    // after another and the spacing of their starts
    sweep: 0, k: 1, seqN: 1, lstep: 0,
    // which word the field holds (its seed, as the text alone cannot tell
    // two showings of the same word apart)
    wseed: -1,
    // the hint (smokeHint) rather than the word: its own clock, anchor,
    // peak and two inks instead of wordState's
    hint: false, peak: 1, sws: 0,
    // where on the live clock this batch began: merging batches share the
    // field and its clock, each keeping its own start
    batchT0: 0
  };
  // liveMode: 0 idle, 1 the word is fading out, 2 the tail — the word is
  // gone and its vapour keeps flowing until dilution finishes it
  let liveMode = 0, liveT = 0, liveAcc = 0, liveParity = 0, liveSteps = 0, needLiveRaster = false;
  let heldPeak = 0, drawLive = false;
  // the hint's release: its front, softness, ink end, letters, and whether
  // it is still crossing (word-fx's smokeHint carries it to the overlay)
  let relCount = 0, relSoft = 0, relPrev = 0, relShown = 0, relEnd = 0, relActive = false;
  let letterBufBusy = false;

  // the preparation state machine
  let prepSlot = -1, prepText = '';
  let prepStep = 0, prepRastered = false, parity = 0, simT = 0;
  const layout = { count: 0, seed: 0, data: new Float32Array(LETTER_FLOATS) };
  const lm = { ascent: 0, descent: 0 };

  function check(mod, name) {
    if (!mod.getCompilationInfo) return;
    mod.getCompilationInfo().then(info => {
      if (info.messages.some(m => m.type === 'error')) {
        console.warn(name + ' compile errors:', info.messages.map(m => m.message).join(' | '));
      }
    });
  }

  function make() {
    made = true;
    const mk = label => device.createTexture({
      label, size: [TEX_W, TEX_H, 1], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
    });
    densA = mk('wordsmoke.density.a');
    densB = mk('wordsmoke.density.b');
    recTex = device.createTexture({
      label: 'wordsmoke.recordings', size: [TEX_W, TEX_H, SNAPS * SLOTS], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const mkWind = (label, w, h) => device.createTexture({
      label, size: [w, h, 1], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
    const windPrepV = mkWind('wordsmoke.wind.prep', WP_W, WP_H).createView();
    liveCompBuf = device.createBuffer({ label: 'wordsmoke.uni.liveplay', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const dens = [densA.createView(), densB.createView()];
    const recView = recTex.createView({ dimension: '2d-array' });
    atlasView = text.texture.createView();
    samp = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
    });

    uniBufs = [];
    for (let r = 0; r < PREP_BUDGET; r++) {
      uniBufs.push(device.createBuffer({ label: 'wordsmoke.uni.' + r, size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    }
    compBuf = device.createBuffer({ label: 'wordsmoke.uni.play', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    rasterBuf = device.createBuffer({ label: 'wordsmoke.uni.raster', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    liveRasterBuf = device.createBuffer({ label: 'wordsmoke.uni.liveraster', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    liveUni = [];
    for (let r = 0; r < MAX_LIVE_STEPS; r++) {
      liveUni.push(device.createBuffer({ label: 'wordsmoke.uni.live.' + r, size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    }
    letterBuf = device.createBuffer({ label: 'wordsmoke.letters', size: LETTER_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const prepMod = device.createShaderModule({ label: 'wordsmoke.prep.wgsl', code: PREP_WGSL });
    check(prepMod, 'wordsmoke.prep.wgsl');
    prepBgl = device.createBindGroupLayout({
      label: 'wordsmoke.prep.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } }
      ]
    });
    const prepLayout = device.createPipelineLayout({ label: 'wordsmoke.prep.layout', bindGroupLayouts: [prepBgl] });
    rasterPipe = device.createComputePipeline({
      label: 'wordsmoke.raster', layout: prepLayout,
      compute: { module: prepMod, entryPoint: 'rasterMain' }
    });
    simPipe = device.createComputePipeline({
      label: 'wordsmoke.sim', layout: prepLayout,
      compute: { module: prepMod, entryPoint: 'simMain' }
    });
    const prepEntries = (buf, p) => [
      { binding: 0, resource: { buffer: buf } },
      { binding: 1, resource: dens[p] },
      { binding: 2, resource: samp },
      { binding: 3, resource: dens[1 - p] },
      { binding: 4, resource: atlasView },
      { binding: 5, resource: { buffer: letterBuf } },
      { binding: 6, resource: windPrepV }
    ];
    // the raster ignores its prev binding and writes A; steps then read A
    rasterBind = device.createBindGroup({ label: 'wordsmoke.raster.bind', layout: prepBgl, entries: prepEntries(rasterBuf, 1) });
    simBinds = [];
    for (let r = 0; r < PREP_BUDGET; r++) {
      simBinds.push([0, 1].map(p => device.createBindGroup({
        label: 'wordsmoke.sim.bind.' + r + '.' + p, layout: prepBgl, entries: prepEntries(uniBufs[r], p)
      })));
    }

    // the baked wind: one dispatch before each step, reading that step's
    // own uniforms (region, time, size, turbulence, seed)
    const windMod = device.createShaderModule({ label: 'wordsmoke.wind.wgsl', code: WIND_WGSL });
    check(windMod, 'wordsmoke.wind.wgsl');
    windBgl = device.createBindGroupLayout({
      label: 'wordsmoke.wind.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } }
      ]
    });
    windPipe = device.createComputePipeline({
      label: 'wordsmoke.wind',
      layout: device.createPipelineLayout({ label: 'wordsmoke.wind.layout', bindGroupLayouts: [windBgl] }),
      compute: { module: windMod, entryPoint: 'windMain' }
    });
    windPrepBinds = uniBufs.map((b, r) => windBind('wordsmoke.wind.prep.' + r, b, windPrepV));

    const playMod = device.createShaderModule({ label: 'wordsmoke.play.wgsl', code: PLAY_WGSL });
    check(playMod, 'wordsmoke.play.wgsl');
    playBgl = device.createBindGroupLayout({
      label: 'wordsmoke.play.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
      ]
    });
    playPipe = device.createRenderPipeline({
      label: 'wordsmoke.play',
      layout: device.createPipelineLayout({ label: 'wordsmoke.play.layout', bindGroupLayouts: [playBgl] }),
      vertex: { module: playMod, entryPoint: 'vsSmoke' },
      fragment: {
        module: playMod, entryPoint: 'fsSmoke',
        targets: [{ format, blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
        } }]
      },
      primitive: { topology: 'triangle-list' }
    });
    playBind = device.createBindGroup({
      label: 'wordsmoke.play.bind', layout: playBgl,
      entries: [
        { binding: 0, resource: { buffer: compBuf } },
        { binding: 1, resource: recView },
        { binding: 2, resource: atlasView },
        { binding: 3, resource: samp },
        { binding: 4, resource: { buffer: letterBuf } }
      ]
    });
  }

  function windBind(label, buf, view) {
    return device.createBindGroup({
      label, layout: windBgl,
      entries: [{ binding: 0, resource: { buffer: buf } }, { binding: 1, resource: view }]
    });
  }

  // The live departure's field, sized to the viewport (LIVE_SCALE, or
  // HINT_SCALE for the hint) when a departure begins; a resize reaches the
  // next departure, never the one flowing now. Same pipelines as the recordings, its own textures.
  function sizeLive(scale) {
    const w = Math.max(8, Math.round(cssW * scale));
    const h = Math.max(8, Math.round(cssH * scale));
    if (w === liveW && h === liveH) return;
    if (liveA) { liveA.destroy(); liveB.destroy(); windLive.destroy(); }
    liveW = w; liveH = h;
    wlW = Math.ceil(w / WIND_DIV); wlH = Math.ceil(h / WIND_DIV);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    liveA = device.createTexture({ label: 'wordsmoke.live.a', size: [w, h, 1], format: 'rgba16float', usage });
    liveB = device.createTexture({ label: 'wordsmoke.live.b', size: [w, h, 1], format: 'rgba16float', usage });
    windLive = device.createTexture({ label: 'wordsmoke.wind.live', size: [wlW, wlH, 1], format: 'rgba16float', usage });
    const liveV = [liveA.createView({ dimension: '2d' }), liveB.createView({ dimension: '2d' })];
    const liveArr = [liveA.createView({ dimension: '2d-array' }), liveB.createView({ dimension: '2d-array' })];
    const windLiveV = windLive.createView();
    const liveEntries = (buf, p) => [
      { binding: 0, resource: { buffer: buf } },
      { binding: 1, resource: liveV[p] },
      { binding: 2, resource: samp },
      { binding: 3, resource: liveV[1 - p] },
      { binding: 4, resource: atlasView },
      { binding: 5, resource: { buffer: letterBuf } },
      { binding: 6, resource: windLiveV }
    ];
    // the raster reads the field's current texture (to go in over it) and
    // writes the other, so one bind per parity
    liveRasterBind = [0, 1].map(p => device.createBindGroup({
      label: 'wordsmoke.live.raster.bind.' + p, layout: prepBgl, entries: liveEntries(liveRasterBuf, p)
    }));
    liveSimBinds = [];
    for (let r = 0; r < MAX_LIVE_STEPS; r++) {
      liveSimBinds.push([0, 1].map(p => device.createBindGroup({
        label: 'wordsmoke.live.sim.bind.' + r + '.' + p, layout: prepBgl, entries: liveEntries(liveUni[r], p)
      })));
    }
    windLiveBinds = liveUni.map((b, r) => windBind('wordsmoke.wind.live.' + r, b, windLiveV));
    playBindLive = [0, 1].map(p => device.createBindGroup({
      label: 'wordsmoke.play.live.bind.' + p, layout: playBgl,
      entries: [
        { binding: 0, resource: { buffer: liveCompBuf } },
        { binding: 1, resource: liveArr[p] },
        { binding: 2, resource: atlasView },
        { binding: 3, resource: samp },
        { binding: 4, resource: { buffer: letterBuf } }
      ]
    }));
  }

  function resize(pw, ph, d) {
    dpr = d || 1;
    cssW = Math.max(1, pw) / dpr; cssH = Math.max(1, ph) / dpr;
  }

  function smooth01(v) {
    const x = v < 0 ? 0 : v > 1 ? 1 : v;
    return x * x * (3 - 2 * x);
  }

  function invalidate(slot) {
    rec[slot].ready = false;
    rec[slot].text = '';
    smokeState.readyText = '';
  }

  // the prep passes read the recording's air out of these slots; see the U
  // struct in the wgsl for the exact mapping
  function fillPrepUni(r, dt, t) {
    uni[0] = r.rx; uni[1] = r.ry; uni[2] = r.rw; uni[3] = r.rh;
    uni[4] = 1 / TEX_W; uni[5] = 1 / TEX_H; uni[6] = dt; uni[7] = t;
    uni[8] = r.size; uni[9] = REC_SECONDS; uni[10] = r.diff; uni[11] = r.decayMul;
    uni[12] = cssW; uni[13] = cssH; uni[14] = r.turb; uni[15] = r.seed;
    uni[16] = r.wind; uni[17] = 0; uni[18] = 0; uni[19] = r.count;
    uni[20] = 0; uni[21] = 0; uni[22] = 0; uni[23] = 0;
    uni[24] = 0; uni[25] = 0; uni[26] = 0; uni[27] = 0;
    uni[28] = r.radial; uni[29] = r.accel; uni[30] = r.icx; uni[31] = r.icy;
    uni[32] = r.eq; uni[33] = 0; uni[34] = 0; uni[35] = 0;
  }

  // Start the live departure for the word on screen: the same layout and
  // air computation as a recording, but the clock is the fade-out itself
  // and the field lives at display-grade resolution. The word is showing,
  // so its glyphs are ready and this cannot miss.
  function beginLive(word) {
    const inset = S.edgeInset || 0;
    // the same wrap the overlay draws: every line's letters into one
    // layout, so the smoke is the whole block
    const ph = text.phrase(word, S.textSize || 35, W.light, TRACK.word, cssW - inset);
    const size = ph.size;
    const cx = inset + (cssW - inset) / 2;
    text.lineMetrics(size, lm);
    const y = cssH / 2 + (lm.ascent - lm.descent) / 2;
    layout.count = 0;
    let laid = true;
    for (let k = 0; k < ph.lines.length; k++) {
      if (!text.layoutWord(ph.lines[k], cx, y + (k - (ph.lines.length - 1) / 2) * ph.lineH,
                           size, W.light, TRACK.word, layout, true)) laid = false;
    }
    if (!laid || !layout.count) return false;
    live.lines = ph.lines.length; live.lineH = ph.lineH;
    live.hint = false;
    if (relActive) { relActive = false; smokeHint.releasing = false; }
    // the word's own Leave look and fade out, from its life
    armLive(layout.data, layout.count, size, cx, y, LIVE_SCALE, Math.max(0.3, (fadeOutMs() || 1000) / 1000), fxv);
    live.text = word;
    live.wseed = wordState.seed;
    return true;
  }

  // The resting screen's hint, on a start from it: the overlay
  // has already laid its letters out (smokeHint), so this only arms the
  // live field with them. Its fade time and sweep are its own (Render >
  // Hint fade, Hint sweep), fixed with no variance roll, because the hint is
  // a piece of chrome rather than a word; the rest of the look is the Leave
  // smoke settings, whatever the words' Leave effect is set to.
  function beginHint() {
    const n = Math.min(smokeHint.count, SMOKE_LETTERS);
    if (!n) return;
    const ms = Math.max(0, S.hintFadeMs ?? 5000);
    live.sws = hintSweepShare();   // its own front (core/word-fx.js)
    live.lines = 1; live.lineH = 0;
    live.hint = true;
    live.peak = smokeHint.peak;
    heldPeak = smokeHint.peak;
    // the hint is no word and has no life: the Leave settings as they stand
    armLive(smokeHint.data, n, smokeHint.size, smokeHint.cx, smokeHint.cy, HINT_SCALE, Math.max(0.3, ms / 1000), fxLive);
    // The release: the front starts left of the ink and update feeds the
    // raster the band it crosses each frame; until a letter is taken the
    // overlay draws it crisp (screens/overlay.js), so nothing shows twice.
    // The hint's vapour mixes away harder than a word's: with little else
    // on screen it was reaching the view's edge and artifacting against
    // the clamped rim; dying a little sooner keeps it clear of the edge.
    // (1 is the word's own Linger-derived decay; raise to fade sooner.)
    live.decayMul *= 1.6;
    relCount = n;
    relSoft = smokeHint.size * 0.9;
    relPrev = relShown = live.wx0 - relSoft;
    relEnd = live.wx1 + relSoft;
    relActive = live.sws > 0.001;
    smokeHint.releasing = relActive;
    smokeHint.frontX = relPrev;
    if (relActive) {
      // frame one enters nothing: an empty band over the field just
      // cleared or carried; the letters follow the front from here on
      uni[20] = relPrev; uni[22] = relPrev;
      device.queue.writeBuffer(liveRasterBuf, 0, uni);
    }
    // no word is ever this, so a word's departure still takes the field
    live.text = '';
    live.wseed = -1;
    liveMode = 1;
  }

  // The live field's setup from a laid-out set of letters L (count of
  // them, the 12-float layout): the air from the Leave settings at the
  // given size, the ink's extent for the sweep and Outward, and the raster
  // queued for this frame's encode. (cx, cy) is the anchor the display
  // offsets from as the drawer moves the view. fx reads the look: fxv for a
  // word (its life's), fxLive for the hint (the settings as they stand).
  function armLive(L, count, size, cx, y, scale, fadeS, fx) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j < count; j++) {
      const o = j * 12;
      x0 = Math.min(x0, L[o] - L[o + 2]); x1 = Math.max(x1, L[o] + L[o + 2]);
      y0 = Math.min(y0, L[o + 1] - L[o + 3]); y1 = Math.max(y1, L[o + 1] + L[o + 3]);
    }
    const D = Math.max(1, (fx('textFxDist', true) || 1.5) * size);
    const spd = Math.max(0, Math.min(2, fx('textSmokeSpeed', true) ?? 1));
    const soft = Math.max(0, Math.min(1, fx('textSmokeSoft', true) ?? 0.5));
    const linger = Math.max(0, Math.min(1, fx('textSmokeLinger', true) ?? 0.5));

    // Merging is the HINT dropping into live smoke (play/pause cycles);
    // a word departing is the original takeover: fresh clock, fresh field.
    const merge = live.hint && liveMode > 0;
    if (!(merge && liveA)) sizeLive(scale);
    live.fadeS = fadeS;
    // The live field is the WHOLE viewport: it costs almost nothing (two
    // textures, no snapshots), and it means the smoke simply keeps smoking
    // outward — there is no box to meet. The only absorption is a guard at
    // the actual screen edge, where the vapour is leaving view anyway.
    live.rx = 0; live.rw = cssW;
    live.ry = 0; live.rh = cssH;
    live.cx = cx; live.cy = y;
    live.size = size;
    live.wind = D * (0.55 + 1.45 * spd) / live.fadeS;
    live.diff = 0.1 + soft * 1.0;
    live.decayMul = 1.6 - 1.2 * linger;
    live.turb = fx('textFxTurb', true);
    live.radial = Math.max(0, Math.min(1, fx('textSmokeRadial', true) ?? 0.75));
    live.eq = Math.max(0, Math.min(1, fx('textSmokeEq', true) ?? 0.5));
    live.accel = Math.max(0, Math.min(1, fx('textSmokeAccel', true) ?? 0.7));
    // The sweep and the lines' order, for the physics and the display
    // alike. The hint's sweep is its release (letters enter behind the
    // front), so its field runs ungated, one mature smoke, and it is one
    // line. A word's lines running one after another read left to right
    // within each line, whether or not the sweep is switched on.
    live.k = 1 + 0.8 * fx('textFxEase', true);
    live.seqN = !live.hint && !linesTogether(true) && live.lines > 1 ? live.lines : 1;
    const swSpd = Math.max(0, Math.min(1, fx('textSmokeSweepSpeed', true) ?? 0.5));
    live.sweep = live.hint ? 0 : fx('textSmokeSweep', true) ? 0.85 - 0.72 * swSpd : 0;
    if (live.seqN > 1 && !live.sweep) live.sweep = 0.5;
    live.lstep = live.seqN > 1 ? lineStep(live.sweep, live.k) : 0;
    // merging keeps the air, so the old vapour's wind never jumps
    if (!merge) live.seed = Math.random() * 100;
    // Linger is the tail: how long the vapour may outlive the word,
    // flowing and diluting, before the layer sleeps
    live.tailS = 2 + 10 * linger;
    live.wx0 = x0; live.wx1 = x1;
    // Outward pushes from the middle of the ink, not the anchor: the anchor
    // is the baseline, with nearly all the letters above it, so a bloom
    // from there sends the smoke up far more than down.
    live.icx = (x0 + x1) / 2; live.icy = (y0 + y1) / 2;

    device.queue.writeBuffer(letterBuf, 0, L, 0, count * 12);
    letterBufBusy = true;
    fillLiveUni(0, 0, 0, 0);
    // The live raster always lands over what the field holds (a fresh
    // field reads as empty air, m5.w): one smoke field, anything drops in.
    // The band (m5.x..m5.z) says which letters enter now: a word whole,
    // the hint letter by letter as its front crosses (the release, update).
    uni[17] = 1;
    uni[19] = count;                   // the raster wants the letter count
    uni[20] = -1e9; uni[22] = 1e9;
    uni[23] = merge ? 1 : 0;
    device.queue.writeBuffer(liveRasterBuf, 0, uni);
    if (!merge) { liveT = 0; liveAcc = 0; }
    live.batchT0 = merge ? liveT : 0;
    needLiveRaster = true;
  }

  // the live sim's uniforms: the recording layout, with the fade as the
  // clock and the live sweep gating the physics (see simMain)
  function fillLiveUni(dt, t, sws, tailN) {
    uni[0] = live.rx; uni[1] = live.ry; uni[2] = live.rw; uni[3] = live.rh;
    uni[4] = 1 / liveW; uni[5] = 1 / liveH; uni[6] = dt; uni[7] = t;
    uni[8] = live.size; uni[9] = live.fadeS; uni[10] = live.diff; uni[11] = live.decayMul;
    uni[12] = cssW; uni[13] = cssH; uni[14] = live.turb; uni[15] = live.seed;
    uni[16] = live.wind; uni[17] = 0; uni[18] = 0; uni[19] = 0;
    uni[20] = sws; uni[21] = 1; uni[22] = 0; uni[23] = tailN;
    uni[24] = live.wx0; uni[25] = live.wx1; uni[26] = 1; uni[27] = 0;
    uni[28] = live.radial; uni[29] = live.accel; uni[30] = live.icx; uni[31] = live.icy;
    // the lines' spacing, the same the display reads (armLive)
    uni[32] = live.eq; uni[33] = live.seqN; uni[34] = live.lineH; uni[35] = live.lstep;
  }

  // Try to begin recording `word` into `slot`: lay it out exactly as the
  // overlay will draw it; glyphs still rasterising mean "not yet".
  function beginPrep(word, slot) {
    const inset = S.edgeInset || 0;
    // the same wrap the overlay draws: every line's letters into one
    // layout, so the smoke is the whole block
    const ph = text.phrase(word, S.textSize || 35, W.light, TRACK.word, cssW - inset);
    const size = ph.size;
    const cx = inset + (cssW - inset) / 2;
    text.lineMetrics(size, lm);
    const y = cssH / 2 + (lm.ascent - lm.descent) / 2;
    layout.count = 0;
    let laid = true;
    for (let k = 0; k < ph.lines.length; k++) {
      if (!text.layoutWord(ph.lines[k], cx, y + (k - (ph.lines.length - 1) / 2) * ph.lineH,
                           size, W.light, TRACK.word, layout, true)) laid = false;
    }
    if (!laid || !layout.count) return false;

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const L = layout.data;
    for (let j = 0; j < layout.count; j++) {
      const o = j * 12;
      x0 = Math.min(x0, L[o] - L[o + 2]); x1 = Math.max(x1, L[o] + L[o + 2]);
      y0 = Math.min(y0, L[o + 1] - L[o + 3]); y1 = Math.max(y1, L[o + 1] + L[o + 3]);
    }
    // only arrivals are recorded now, so this is always the Arrive side;
    // the word has not appeared yet, so its look is the settings as they
    // stand (its life takes them again the moment it appears)
    const leaving = false;
    const D = Math.max(1, (fxLive('textFxDist', leaving) || 1.5) * size);
    const spd = Math.max(0, Math.min(2, fxLive('textSmokeSpeed', leaving) ?? 1));
    const soft = Math.max(0, Math.min(1, fxLive('textSmokeSoft', leaving) ?? 0.5));
    const linger = Math.max(0, Math.min(1, fxLive('textSmokeLinger', leaving) ?? 0.5));
    const radialC = Math.max(0, Math.min(1, fxLive('textSmokeRadial', leaving) ?? 0.75));
    // room for the whole journey with headroom to spare: recordings carry
    // 48 layers of memory, so they stay bounded rather than viewport-sized,
    // but the bound sits well past where dilution has already finished
    const mx = D * (0.55 + 1.45 * spd) * (0.65 + 1.35 * radialC) + size * 0.6;

    const r = rec[slot];
    r.text = word;
    r.lines = ph.lines.length; r.lineH = ph.lineH;
    r.ready = false;
    smokeState.readyText = '';
    r.rx = Math.max(0, x0 - mx); r.rw = Math.min(cssW, x1 + mx) - r.rx;
    r.ry = Math.max(0, y0 - mx); r.rh = Math.min(cssH, y1 + mx) - r.ry;
    r.cx = cx; r.cy = y;
    r.size = size;
    r.count = layout.count;
    r.wind = D * (0.55 + 1.45 * spd) / REC_SECONDS;
    r.diff = 0.1 + soft * 1.0;
    r.decayMul = 1.6 - 1.2 * linger;
    r.turb = fxLive('textFxTurb', leaving);
    r.radial = Math.max(0, Math.min(1, fxLive('textSmokeRadial', leaving) ?? 0.75));
    r.eq = Math.max(0, Math.min(1, fxLive('textSmokeEq', leaving) ?? 0.5));
    r.accel = Math.max(0, Math.min(1, fxLive('textSmokeAccel', leaving) ?? 0.7));
    r.seed = Math.random() * 100;      // a new sky for every recording, always
    r.wx0 = x0; r.wx1 = x1;            // sweep is playback-side; it only needs to know where the ink sits
    r.availW = Math.round(cssW - inset); // the width the phrase wrapped against
    r.lineW = S.textLineWidth ?? 0.92;   // and the Line width dial it wrapped under
    r.smart = S.textSmartBreaks !== false; // and whether smart breaks were on
    r.icx = (x0 + x1) / 2; r.icy = (y0 + y1) / 2;   // Outward's centre (see beginLive)

    device.queue.writeBuffer(letterBuf, 0, layout.data, 0, layout.count * 12);
    fillPrepUni(r, 0, 0);
    device.queue.writeBuffer(rasterBuf, 0, uni);
    prepSlot = slot;
    prepText = word;
    prepStep = 0;
    prepRastered = false;
    parity = 0;
    simT = 0;
    return true;
  }

  function update(t, dt) {
    playing = false;
    playSlot = -1;
    drawLive = false;
    liveSteps = 0;
    letterBufBusy = false;
    // the word on screen's own effects, from its life
    const inFx = wordLife.fxIn;
    const outFx = wordLife.fxOut;
    const phase = wordState.phase;
    const size = S.textSize || 35;
    const smokeNow = wordState.visible &&
      ((phase === 0 && inFx === 'smoke') || (phase === 2 && outFx === 'smoke'));

    if (made) {
      // a recording made at another word size no longer matches the word's
      // pixels; stale, not usable. The size to match is the word's own
      // fitted size (a long affirmation shrinks to the view), so a resize
      // that changes the fit invalidates too.
      // A changed view width can also re-break a phrase's lines without
      // moving the fitted size, so the wrapped width must match too.
      // A recording already playing an arrival plays it out: the latch
      // (word-fx) chose it for this phase, and pulled from under it the
      // word would be drawn by nothing until its hold. The size it lands
      // at is the overlay's to settle.
      const ins = S.edgeInset || 0;
      const arriving = smokeNow && phase === 0 && smokeState.playing;
      for (let s = 0; s < SLOTS; s++) {
        if (rec[s].ready && !(arriving && rec[s].text === wordState.text) &&
            (rec[s].availW !== Math.round(cssW - ins) ||
             rec[s].lineW !== (S.textLineWidth ?? 0.92) ||
             rec[s].smart !== (S.textSmartBreaks !== false) ||
             rec[s].size !== text.wordSize(rec[s].text, size, W.light, TRACK.word, cssW - ins))) invalidate(s);
      }
    }

    // The hint's handover from the overlay, taken the frame it is offered.
    // It comes with a start, and words are hidden while stopped, so no word
    // is on screen to be departing (a previous word's tail gives way).
    if (smokeHint.req) {
      smokeHint.req = false;
      if (!made) make();
      beginHint();
    }

    // Arrival reads its recording; departure is simulated live. The latch
    // in word-fx already chose playing-or-fade at the phase's first frame.
    if (smokeNow && smokeState.playing) {
      const wt = wordState.text;
      if (phase === 0 && rec[ARR].ready && rec[ARR].text === wt) playSlot = ARR;
      else if (phase === 2) {
        if (!made) make();
        const mine = live.text === wt && live.wseed === wordState.seed;
        if (!mine) { if (beginLive(wt)) liveMode = 1; }
        else { liveMode = 1; heldPeak = wordState.peak; }
      }
    }
    // The word has gone but its vapour has not: the tail. It keeps flowing
    // and diluting until its bounded time is up (Linger sets the room), or
    // until a new departure takes the field over.
    // The hint has no word phase to follow: its fade is its own clock.
    if (liveMode === 1 && (live.hint ? liveT - live.batchT0 >= live.fadeS : !(smokeNow && phase === 2))) liveMode = 2;
    if (liveMode === 2 && liveT - live.batchT0 > live.fadeS + live.tailS) { liveMode = 0; live.text = ''; }

    if (liveMode > 0) {
      // fixed-step substeps of the live field, remainder banked; the tail
      // position lets the shader raise the mixing gently, never a cliff
      // The hint's smoke is part of the scene, so it coasts to a stop with
      // everything on a pause and carries on from there (core/motion.js).
      const step = live.hint ? motionStep(dt) : dt;
      if (step > 0 && step < 0.25) liveAcc += step;
      if (liveAcc > MAX_LIVE_STEPS * LIVE_DT) liveAcc = MAX_LIVE_STEPS * LIVE_DT;
      // the sweep the field was armed with (armLive), to its very end
      const swsL = live.sweep;
      while (liveAcc >= LIVE_DT && liveSteps < MAX_LIVE_STEPS) {
        liveAcc -= LIVE_DT;
        const tailN = Math.max(0, Math.min(1, (liveT - live.batchT0 - live.fadeS) / live.tailS));
        fillLiveUni(LIVE_DT, liveT, swsL, tailN);
        device.queue.writeBuffer(liveUni[liveSteps], 0, uni);
        liveT += LIVE_DT;
        liveSteps++;
      }
      // The hint's release: the front crosses the ink on this batch's
      // clock and each letter behind it drops into the field, once. A
      // pause mid-release (overlay's finishReq) lets the rest go at once.
      if (relActive && live.hint) {
        const fin = smokeHint.finishReq;
        if (fin) smokeHint.finishReq = false;
        // Exactly one frame behind the overlay: it drew this frame with the
        // front published last frame (relShown), hiding the letters left of
        // it, and only those enter the field now. Every letter is drawn by
        // exactly one of the two on every frame, never both.
        if (relShown > relPrev) {
          fillLiveUni(0, 0, 0, 0);
          uni[17] = 1;
          uni[19] = relCount;
          uni[20] = relPrev; uni[22] = relShown; uni[23] = 1;
          device.queue.writeBuffer(liveRasterBuf, 0, uni);
          needLiveRaster = true;
          relPrev = relShown;
        }
        const f0 = live.wx0 - relSoft;
        const fr = (liveT - live.batchT0) / Math.max(live.sws * live.fadeS, 0.001);
        relShown = fin ? relEnd : Math.min(relEnd, f0 + fr * (relEnd - f0));
        smokeHint.frontX = relShown;
        if (relPrev >= relEnd) { relActive = false; smokeHint.releasing = false; }
      }
      drawLive = true;
    }

    // Record the coming word's arrival, but never on a frame that just
    // wrote the live departure's layout into the shared letter buffer. The
    // coming word has no life yet, so whether it arrives as smoke is the
    // setting as it stands.
    if (S.textFxIn === 'smoke' && wordState.nextText && !letterBufBusy && !relActive &&
        !(rec[ARR].ready && rec[ARR].text === wordState.nextText) &&
        playSlot !== ARR &&
        !(prepSlot === ARR && prepText === wordState.nextText)) {
      if (!made) make();
      beginPrep(wordState.nextText, ARR);   // false leaves prep idle, retried next frame
    }

    if (!made) return;

    // Where the word's anchor sits now, against where it sat at prep: the
    // whole field moves by the difference, so the smoke rides the drawer
    // and any resize exactly as the word does.
    const inset = S.edgeInset || 0;
    const ax = inset + (cssW - inset) / 2;
    // the anchor's height depends on the word's OWN drawn size (a long
    // affirmation fits itself smaller), so each branch measures with its own
    const anchorY = sz => { text.lineMetrics(sz, lm); return cssH / 2 + (lm.ascent - lm.descent) / 2; };

    // The arrival's recorded playback, into its own uniform block. The
    // shader does the easing and the sweep per column.
    if (playSlot >= 0) {
      const r = rec[playSlot];
      const k = 1 + 0.8 * fxv('textFxEase', false);
      const p = wordState.progress;
      const sharp = smooth01((p - 0.92) / 0.08);
      const swSpd = Math.max(0, Math.min(1, fxv('textSmokeSweepSpeed', false) ?? 0.5));
      const seqN = !linesTogether(false) && r.lines > 1 ? r.lines : 1;
      let sws = fxv('textSmokeSweep', false) ? 0.85 - 0.72 * swSpd : 0;
      if (seqN > 1 && !sws) sws = 0.5;
      const ox = ax - r.cx, oy = anchorY(r.size) - r.cy;
      uni[0] = r.rx + ox; uni[1] = r.ry + oy; uni[2] = r.rw; uni[3] = r.rh;
      uni[4] = 1 / TEX_W; uni[5] = 1 / TEX_H; uni[6] = SNAP_S; uni[7] = r.size;
      uni[8] = playSlot * SNAPS; uni[9] = SNAPS - 1; uni[10] = p; uni[11] = wordState.peak;
      uni[12] = cssW; uni[13] = cssH; uni[14] = 0; uni[15] = sharp;
      const c = wordState.color;
      uni[16] = c[0]; uni[17] = c[1]; uni[18] = c[2]; uni[19] = r.wind;
      uni[20] = r.turb; uni[21] = r.seed; uni[22] = sws; uni[23] = 0;
      uni[24] = r.wx0 + ox; uni[25] = r.wx1 + ox; uni[26] = -1; uni[27] = k;
      uni[28] = r.radial; uni[29] = r.accel; uni[30] = r.icx + ox; uni[31] = r.icy + oy;
      uni[32] = r.eq; uni[33] = seqN; uni[34] = r.lineH; uni[35] = seqN > 1 ? lineStep(sws, k) : 0;
      uni[36] = c[0]; uni[37] = c[1]; uni[38] = c[2]; uni[39] = 0;
      device.queue.writeBuffer(compBuf, 0, uni);
      playing = true;
    }

    // The live departure's display, one layer of NOW: no snapshot axis, no
    // warp. In the tail the word is gone (progress pinned past 1, peak held
    // from its last frame) and dilution alone carries the vapour out.
    if (drawLive) {
      const k = live.k;
      const p = liveMode !== 1 ? 1.001 : live.hint ? Math.min(1, (liveT - live.batchT0) / live.fadeS) : wordState.progress;
      // the hint's field is pure smoke (the overlay owns the crisp
      // letters), so nothing in it is ever drawn firm
      const sharp = live.hint ? 0 : 1 - smooth01(p / 0.08);
      const seqN = live.seqN, sws = live.sweep;
      // the hint anchors on the view's middle, the word on its own baseline
      const ox = ax - live.cx, oy = (live.hint ? cssH / 2 : anchorY(live.size)) - live.cy;
      uni[0] = live.rx + ox; uni[1] = live.ry + oy; uni[2] = live.rw; uni[3] = live.rh;
      uni[4] = 1 / liveW; uni[5] = 1 / liveH; uni[6] = 0; uni[7] = live.size;
      uni[8] = 0; uni[9] = 0; uni[10] = p;
      uni[11] = liveMode !== 1 ? heldPeak : live.hint ? live.peak : wordState.peak;
      uni[12] = cssW; uni[13] = cssH; uni[14] = 0; uni[15] = sharp;
      // the hint's main line and sub-lines are two inks; a word is one
      const c = live.hint ? smokeHint.colA : wordState.color;
      const c2 = live.hint ? smokeHint.colB : c;
      uni[16] = c[0]; uni[17] = c[1]; uni[18] = c[2]; uni[19] = live.wind;
      uni[20] = live.turb; uni[21] = live.seed; uni[22] = sws; uni[23] = 0;
      uni[24] = live.wx0 + ox; uni[25] = live.wx1 + ox; uni[26] = 1; uni[27] = k;
      uni[28] = live.radial; uni[29] = live.accel; uni[30] = live.icx + ox; uni[31] = live.icy + oy;
      uni[32] = live.eq; uni[33] = seqN; uni[34] = live.lineH; uni[35] = live.lstep;
      uni[36] = c2[0]; uni[37] = c2[1]; uni[38] = c2[2]; uni[39] = 0;
      device.queue.writeBuffer(liveCompBuf, 0, uni);
      playing = true;
    }
  }

  // Before the scene pass: the live departure's raster and substeps, then
  // this frame's slice of the recording work inside its budget. Snapshot
  // copies sit between compute passes, so the pass is closed around them.
  function encode(encoder) {
    if (!made) return;
    if (needLiveRaster || liveSteps > 0) {
      const lgw = Math.ceil(liveW / 8), lgh = Math.ceil(liveH / 8);
      const lp = encoder.beginComputePass();
      if (needLiveRaster) {
        needLiveRaster = false;
        lp.setPipeline(rasterPipe);
        lp.setBindGroup(0, liveRasterBind[liveParity]);
        lp.dispatchWorkgroups(lgw, lgh);
        liveParity = 1 - liveParity;   // the raster wrote the other texture
      }
      if (liveSteps > 0) {
        const wgw = Math.ceil(wlW / 8), wgh = Math.ceil(wlH / 8);
        for (let s = 0; s < liveSteps; s++) {
          lp.setPipeline(windPipe);
          lp.setBindGroup(0, windLiveBinds[s]);
          lp.dispatchWorkgroups(wgw, wgh);
          lp.setPipeline(simPipe);
          lp.setBindGroup(0, liveSimBinds[s][liveParity]);
          lp.dispatchWorkgroups(lgw, lgh);
          liveParity = 1 - liveParity;
        }
      }
      lp.end();
    }
    if (prepSlot < 0) return;
    let pass = null;
    const gw = Math.ceil(TEX_W / 8), gh = Math.ceil(TEX_H / 8);
    const open = () => { if (!pass) pass = encoder.beginComputePass(); };
    const close = () => { if (pass) { pass.end(); pass = null; } };
    const base = prepSlot * SNAPS;
    const snap = layer => {
      close();
      encoder.copyTextureToTexture(
        { texture: parity === 0 ? densA : densB },
        { texture: recTex, origin: { x: 0, y: 0, z: base + layer } },
        [TEX_W, TEX_H, 1]);
    };

    if (!prepRastered) {
      prepRastered = true;
      open();
      pass.setPipeline(rasterPipe);
      pass.setBindGroup(0, rasterBind);
      pass.dispatchWorkgroups(gw, gh);
      parity = 0;                      // the raster wrote texture A
      snap(0);
    }

    let budget = PREP_BUDGET;
    const r = rec[prepSlot];
    while (budget > 0 && prepStep < TOTAL_STEPS) {
      const ring = PREP_BUDGET - budget;
      fillPrepUni(r, SIM_DT, simT);
      device.queue.writeBuffer(uniBufs[ring], 0, uni);
      open();
      pass.setPipeline(windPipe);
      pass.setBindGroup(0, windPrepBinds[ring]);
      pass.dispatchWorkgroups(Math.ceil(WP_W / 8), Math.ceil(WP_H / 8));
      pass.setPipeline(simPipe);
      pass.setBindGroup(0, simBinds[ring][parity]);
      pass.dispatchWorkgroups(gw, gh);
      parity = 1 - parity;
      simT += SIM_DT;
      prepStep++;
      budget--;
      if (prepStep % STEPS_PER_SNAP === 0) snap(prepStep / STEPS_PER_SNAP);
    }
    close();

    if (prepStep >= TOTAL_STEPS) {
      r.ready = true;
      smokeState.readyText = r.text;
      prepSlot = -1;
      prepText = '';
    }
  }

  // In the scene pass, where the word draws. An arrival's playback and a
  // previous word's still-flowing tail can both be on screen; each has its
  // own uniforms, so both draw.
  function draw(pass) {
    if (!playing) return;
    pass.setPipeline(playPipe);
    if (playSlot >= 0) {
      pass.setBindGroup(0, playBind);
      pass.draw(6);
    }
    if (drawLive) {
      pass.setBindGroup(0, playBindLive[liveParity]);
      pass.draw(6);
    }
  }

  // A word's smoke still playing out on the frame's own clock, for the still
  // frame (main.js). The hint's smoke steps with the motion, so a paused
  // hint holds where it is and keeps nothing awake.
  const busy = () => liveMode !== 0 && !live.hint;

  return { update, encode, draw, resize, busy };
}
