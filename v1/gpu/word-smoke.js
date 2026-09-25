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
// the fade-out itself, at 1024x512 — near display resolution — stepping
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
// departure pair at 1024x512 (~16 MB).

import { S } from '../../js/state.js';
import { PREP_WGSL, PLAY_WGSL, WIND_WGSL } from './word-smoke.wgsl.js';
import { MAX_CLOUD_LETTERS, smokeState, fxv } from '../core/word-fx.js';
import { wordState, fadeOutMs } from '../core/words.js';
import { W, TRACK } from '../ui/theme.js';

const TEX_W = 640, TEX_H = 320;
const LIVE_W = 1536, LIVE_H = 768;
// The baked wind's grids (see windMain): a third of each field's resolution,
// ample for a wind whose finest eddies span several of its texels.
const WIND_DIV = 3;
const WP_W = Math.ceil(TEX_W / WIND_DIV), WP_H = Math.ceil(TEX_H / WIND_DIV);
const WL_W = Math.ceil(LIVE_W / WIND_DIV), WL_H = Math.ceil(LIVE_H / WIND_DIV);
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
const UNI_FLOATS = 32;                // eight vec4f of U
const LETTER_FLOATS = MAX_CLOUD_LETTERS * 12;

// Bumped on every behaviour change, printed on load: the console proves
// which build the page is actually running, so a stale worker-module cache
// can never again masquerade as "nothing changed".
const SMOKE_BUILD = 11;
console.log('[smoke] build', SMOKE_BUILD);

export function createWordSmoke(device, format, text) {
  let made = false, playing = false, playSlot = -1;
  let densA = null, densB = null, recTex = null;
  let liveA = null, liveB = null;
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
    radial: 0.75, accel: 0.7
  }));

  // the live departure: metadata mirrors a recording's, but the field is
  // stepped in real time while it is on screen
  const live = {
    text: '', rx: 0, ry: 0, rw: 1, rh: 1, cx: 0, cy: 0,
    size: 35, wind: 0, diff: 1, decayMul: 1, turb: 0.5, seed: 0,
    wx0: 0, wx1: 0, icx: 0, icy: 0, fadeS: 3, tailS: 6, radial: 0.75, accel: 0.7
  };
  // liveMode: 0 idle, 1 the word is fading out, 2 the tail — the word is
  // gone and its vapour keeps flowing until dilution finishes it
  let liveMode = 0, liveT = 0, liveAcc = 0, liveParity = 0, liveSteps = 0, needLiveRaster = false;
  let heldPeak = 0, drawLive = false;
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
    const mkLive = label => device.createTexture({
      label, size: [LIVE_W, LIVE_H, 1], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
    liveA = mkLive('wordsmoke.live.a');
    liveB = mkLive('wordsmoke.live.b');
    const mkWind = (label, w, h) => device.createTexture({
      label, size: [w, h, 1], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
    const windPrepV = mkWind('wordsmoke.wind.prep', WP_W, WP_H).createView();
    const windLiveV = mkWind('wordsmoke.wind.live', WL_W, WL_H).createView();
    liveCompBuf = device.createBuffer({ label: 'wordsmoke.uni.liveplay', size: UNI_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const dens = [densA.createView(), densB.createView()];
    const liveV = [liveA.createView({ dimension: '2d' }), liveB.createView({ dimension: '2d' })];
    const liveArr = [liveA.createView({ dimension: '2d-array' }), liveB.createView({ dimension: '2d-array' })];
    const recView = recTex.createView({ dimension: '2d-array' });
    const atlasView = text.texture.createView();
    const samp = device.createSampler({
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
    const prepBgl = device.createBindGroupLayout({
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
    // the live departure runs the same pipelines over its own hi-res pair
    const liveEntries = (buf, p) => [
      { binding: 0, resource: { buffer: buf } },
      { binding: 1, resource: liveV[p] },
      { binding: 2, resource: samp },
      { binding: 3, resource: liveV[1 - p] },
      { binding: 4, resource: atlasView },
      { binding: 5, resource: { buffer: letterBuf } },
      { binding: 6, resource: windLiveV }
    ];
    liveRasterBind = device.createBindGroup({ label: 'wordsmoke.live.raster.bind', layout: prepBgl, entries: liveEntries(liveRasterBuf, 1) });
    liveSimBinds = [];
    for (let r = 0; r < MAX_LIVE_STEPS; r++) {
      liveSimBinds.push([0, 1].map(p => device.createBindGroup({
        label: 'wordsmoke.live.sim.bind.' + r + '.' + p, layout: prepBgl, entries: liveEntries(liveUni[r], p)
      })));
    }

    // the baked wind: one dispatch before each step, reading that step's
    // own uniforms (region, time, size, turbulence, seed)
    const windMod = device.createShaderModule({ label: 'wordsmoke.wind.wgsl', code: WIND_WGSL });
    check(windMod, 'wordsmoke.wind.wgsl');
    const windBgl = device.createBindGroupLayout({
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
    const windBind = (label, buf, view) => device.createBindGroup({
      label, layout: windBgl,
      entries: [{ binding: 0, resource: { buffer: buf } }, { binding: 1, resource: view }]
    });
    windPrepBinds = uniBufs.map((b, r) => windBind('wordsmoke.wind.prep.' + r, b, windPrepV));
    windLiveBinds = liveUni.map((b, r) => windBind('wordsmoke.wind.live.' + r, b, windLiveV));

    const playMod = device.createShaderModule({ label: 'wordsmoke.play.wgsl', code: PLAY_WGSL });
    check(playMod, 'wordsmoke.play.wgsl');
    const playBgl = device.createBindGroupLayout({
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
  }

  // Start the live departure for the word on screen: the same layout and
  // air computation as a recording, but the clock is the fade-out itself
  // and the field lives at display-grade resolution. The word is showing,
  // so its glyphs are ready and this cannot miss.
  function beginLive(word) {
    const size = S.textSize || 35;
    const inset = S.edgeInset || 0;
    const cx = inset + (cssW - inset) / 2;
    text.lineMetrics(size, lm);
    const y = cssH / 2 + (lm.ascent - lm.descent) / 2;
    if (!text.layoutWord(word, cx, y, size, W.light, TRACK.word, layout)) return false;

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const L = layout.data;
    for (let j = 0; j < layout.count; j++) {
      const o = j * 12;
      x0 = Math.min(x0, L[o] - L[o + 2]); x1 = Math.max(x1, L[o] + L[o + 2]);
      y0 = Math.min(y0, L[o + 1] - L[o + 3]); y1 = Math.max(y1, L[o + 1] + L[o + 3]);
    }
    const D = Math.max(1, (fxv('textFxDist', true) || 1.5) * size);
    const spd = Math.max(0, Math.min(2, fxv('textSmokeSpeed', true) ?? 1));
    const soft = Math.max(0, Math.min(1, fxv('textSmokeSoft', true) ?? 0.5));
    const linger = Math.max(0, Math.min(1, fxv('textSmokeLinger', true) ?? 0.5));
    const radialC = Math.max(0, Math.min(1, fxv('textSmokeRadial', true) ?? 0.75));

    live.text = word;
    live.fadeS = Math.max(0.3, (fadeOutMs() || 1000) / 1000);
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
    live.turb = fxv('textFxTurb', true);
    live.radial = Math.max(0, Math.min(1, fxv('textSmokeRadial', true) ?? 0.75));
    live.accel = Math.max(0, Math.min(1, fxv('textSmokeAccel', true) ?? 0.7));
    live.seed = Math.random() * 100;
    // Linger is the tail: how long the vapour may outlive the word,
    // flowing and diluting, before the layer sleeps
    live.tailS = 2 + 10 * linger;
    live.wx0 = x0; live.wx1 = x1;
    // Outward pushes from the middle of the ink, not the anchor: the anchor
    // is the baseline, with nearly all the letters above it, so a bloom
    // from there sends the smoke up far more than down.
    live.icx = (x0 + x1) / 2; live.icy = (y0 + y1) / 2;

    device.queue.writeBuffer(letterBuf, 0, layout.data, 0, layout.count * 12);
    letterBufBusy = true;
    fillLiveUni(0, 0, 0, 0);
    uni[19] = layout.count;            // the raster wants the letter count
    device.queue.writeBuffer(liveRasterBuf, 0, uni);
    liveT = 0;
    liveAcc = 0;
    liveParity = 0;
    needLiveRaster = true;
    return true;
  }

  // the live sim's uniforms: the recording layout, with the fade as the
  // clock and the live sweep gating the physics (see simMain)
  function fillLiveUni(dt, t, sws, tailN) {
    uni[0] = live.rx; uni[1] = live.ry; uni[2] = live.rw; uni[3] = live.rh;
    uni[4] = 1 / LIVE_W; uni[5] = 1 / LIVE_H; uni[6] = dt; uni[7] = t;
    uni[8] = live.size; uni[9] = live.fadeS; uni[10] = live.diff; uni[11] = live.decayMul;
    uni[12] = cssW; uni[13] = cssH; uni[14] = live.turb; uni[15] = live.seed;
    uni[16] = live.wind; uni[17] = 0; uni[18] = 0; uni[19] = 0;
    uni[20] = sws; uni[21] = 1; uni[22] = 0; uni[23] = tailN;
    uni[24] = live.wx0; uni[25] = live.wx1; uni[26] = 1; uni[27] = 0;
    uni[28] = live.radial; uni[29] = live.accel; uni[30] = live.icx; uni[31] = live.icy;
  }

  // Try to begin recording `word` into `slot`: lay it out exactly as the
  // overlay will draw it; glyphs still rasterising mean "not yet".
  function beginPrep(word, slot) {
    const size = S.textSize || 35;
    const inset = S.edgeInset || 0;
    const cx = inset + (cssW - inset) / 2;
    text.lineMetrics(size, lm);
    const y = cssH / 2 + (lm.ascent - lm.descent) / 2;
    if (!text.layoutWord(word, cx, y, size, W.light, TRACK.word, layout)) return false;

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const L = layout.data;
    for (let j = 0; j < layout.count; j++) {
      const o = j * 12;
      x0 = Math.min(x0, L[o] - L[o + 2]); x1 = Math.max(x1, L[o] + L[o + 2]);
      y0 = Math.min(y0, L[o + 1] - L[o + 3]); y1 = Math.max(y1, L[o + 1] + L[o + 3]);
    }
    // only arrivals are recorded now, so this is always the Arrive side
    const leaving = false;
    const D = Math.max(1, (fxv('textFxDist', leaving) || 1.5) * size);
    const spd = Math.max(0, Math.min(2, fxv('textSmokeSpeed', leaving) ?? 1));
    const soft = Math.max(0, Math.min(1, fxv('textSmokeSoft', leaving) ?? 0.5));
    const linger = Math.max(0, Math.min(1, fxv('textSmokeLinger', leaving) ?? 0.5));
    const radialC = Math.max(0, Math.min(1, fxv('textSmokeRadial', leaving) ?? 0.75));
    // room for the whole journey with headroom to spare: recordings carry
    // 48 layers of memory, so they stay bounded rather than viewport-sized,
    // but the bound sits well past where dilution has already finished
    const mx = D * (0.55 + 1.45 * spd) * (0.65 + 1.35 * radialC) + size * 0.6;

    const r = rec[slot];
    r.text = word;
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
    r.turb = fxv('textFxTurb', leaving);
    r.radial = Math.max(0, Math.min(1, fxv('textSmokeRadial', leaving) ?? 0.75));
    r.accel = Math.max(0, Math.min(1, fxv('textSmokeAccel', leaving) ?? 0.7));
    r.seed = Math.random() * 100;      // a new sky for every recording, always
    r.wx0 = x0; r.wx1 = x1;            // sweep is playback-side; it only needs to know where the ink sits
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
    const inFx = S.textFxIn;
    const outFx = S.textFxMirror ? S.textFxIn : S.textFxOut;
    const phase = wordState.phase;
    const size = S.textSize || 35;
    const smokeNow = wordState.visible &&
      ((phase === 0 && inFx === 'smoke') || (phase === 2 && outFx === 'smoke'));

    if (made) {
      // a recording made at another word size no longer matches the word's
      // pixels; stale, not usable
      for (let s = 0; s < SLOTS; s++) if (rec[s].ready && rec[s].size !== size) invalidate(s);
    }

    // Arrival reads its recording; departure is simulated live. The latch
    // in word-fx already chose playing-or-fade at the phase's first frame.
    if (smokeNow && smokeState.playing) {
      const wt = wordState.text;
      if (phase === 0 && rec[ARR].ready && rec[ARR].text === wt) playSlot = ARR;
      else if (phase === 2) {
        if (!made) make();
        if (live.text !== wt) { if (beginLive(wt)) liveMode = 1; }
        if (live.text === wt) { liveMode = 1; heldPeak = wordState.peak; }
      }
    }
    // The word has gone but its vapour has not: the tail. It keeps flowing
    // and diluting until its bounded time is up (Linger sets the room), or
    // until a new departure takes the field over.
    if (liveMode === 1 && !(smokeNow && phase === 2)) liveMode = 2;
    if (liveMode === 2 && liveT > live.fadeS + live.tailS) { liveMode = 0; live.text = ''; }

    if (liveMode > 0) {
      // fixed-step substeps of the live field, remainder banked; the tail
      // position lets the shader raise the mixing gently, never a cliff
      if (dt > 0 && dt < 0.25) liveAcc += dt;
      if (liveAcc > MAX_LIVE_STEPS * LIVE_DT) liveAcc = MAX_LIVE_STEPS * LIVE_DT;
      const swSpdL = Math.max(0, Math.min(1, fxv('textSmokeSweepSpeed', true) ?? 0.5));
      const swsL = fxv('textSmokeSweep', true) ? 0.85 - 0.72 * swSpdL : 0;
      while (liveAcc >= LIVE_DT && liveSteps < MAX_LIVE_STEPS) {
        liveAcc -= LIVE_DT;
        const tailN = Math.max(0, Math.min(1, (liveT - live.fadeS) / live.tailS));
        fillLiveUni(LIVE_DT, liveT, swsL, tailN);
        device.queue.writeBuffer(liveUni[liveSteps], 0, uni);
        liveT += LIVE_DT;
        liveSteps++;
      }
      drawLive = true;
    }

    // Record the coming word's arrival, but never on a frame that just
    // wrote the live departure's layout into the shared letter buffer.
    if (inFx === 'smoke' && wordState.nextText && !letterBufBusy &&
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
    text.lineMetrics(size, lm);
    const ax = inset + (cssW - inset) / 2;
    const ay = cssH / 2 + (lm.ascent - lm.descent) / 2;

    // The arrival's recorded playback, into its own uniform block. The
    // shader does the easing and the sweep per column.
    if (playSlot >= 0) {
      const r = rec[playSlot];
      const k = 1 + 0.8 * fxv('textFxEase', false);
      const p = wordState.progress;
      const sharp = smooth01((p - 0.92) / 0.08);
      const swSpd = Math.max(0, Math.min(1, fxv('textSmokeSweepSpeed', false) ?? 0.5));
      const sws = fxv('textSmokeSweep', false) ? 0.85 - 0.72 * swSpd : 0;
      const ox = ax - r.cx, oy = ay - r.cy;
      uni[0] = r.rx + ox; uni[1] = r.ry + oy; uni[2] = r.rw; uni[3] = r.rh;
      uni[4] = 1 / TEX_W; uni[5] = 1 / TEX_H; uni[6] = SNAP_S; uni[7] = r.size;
      uni[8] = playSlot * SNAPS; uni[9] = SNAPS - 1; uni[10] = p; uni[11] = wordState.peak;
      uni[12] = cssW; uni[13] = cssH; uni[14] = 0; uni[15] = sharp;
      const c = wordState.color;
      uni[16] = c[0]; uni[17] = c[1]; uni[18] = c[2]; uni[19] = r.wind;
      uni[20] = r.turb; uni[21] = r.seed; uni[22] = sws; uni[23] = 0;
      uni[24] = r.wx0 + ox; uni[25] = r.wx1 + ox; uni[26] = -1; uni[27] = k;
      uni[28] = r.radial; uni[29] = r.accel; uni[30] = r.icx + ox; uni[31] = r.icy + oy;
      device.queue.writeBuffer(compBuf, 0, uni);
      playing = true;
    }

    // The live departure's display, one layer of NOW: no snapshot axis, no
    // warp. In the tail the word is gone (progress pinned past 1, peak held
    // from its last frame) and dilution alone carries the vapour out.
    if (drawLive) {
      const k = 1 + 0.8 * fxv('textFxEase', true);
      const p = liveMode === 1 ? wordState.progress : 1.001;
      const sharp = 1 - smooth01(p / 0.08);
      const swSpd = Math.max(0, Math.min(1, fxv('textSmokeSweepSpeed', true) ?? 0.5));
      const sws = fxv('textSmokeSweep', true) ? 0.85 - 0.72 * swSpd : 0;
      const ox = ax - live.cx, oy = ay - live.cy;
      uni[0] = live.rx + ox; uni[1] = live.ry + oy; uni[2] = live.rw; uni[3] = live.rh;
      uni[4] = 1 / LIVE_W; uni[5] = 1 / LIVE_H; uni[6] = 0; uni[7] = live.size;
      uni[8] = 0; uni[9] = 0; uni[10] = p; uni[11] = liveMode === 1 ? wordState.peak : heldPeak;
      uni[12] = cssW; uni[13] = cssH; uni[14] = 0; uni[15] = sharp;
      const c = wordState.color;
      uni[16] = c[0]; uni[17] = c[1]; uni[18] = c[2]; uni[19] = live.wind;
      uni[20] = live.turb; uni[21] = live.seed; uni[22] = sws; uni[23] = 0;
      uni[24] = live.wx0 + ox; uni[25] = live.wx1 + ox; uni[26] = 1; uni[27] = k;
      uni[28] = live.radial; uni[29] = live.accel; uni[30] = live.icx + ox; uni[31] = live.icy + oy;
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
      const lgw = Math.ceil(LIVE_W / 8), lgh = Math.ceil(LIVE_H / 8);
      const lp = encoder.beginComputePass();
      if (needLiveRaster) {
        needLiveRaster = false;
        lp.setPipeline(rasterPipe);
        lp.setBindGroup(0, liveRasterBind);
        lp.dispatchWorkgroups(lgw, lgh);
        liveParity = 0;                // the raster wrote texture A
      }
      if (liveSteps > 0) {
        const wgw = Math.ceil(WL_W / 8), wgh = Math.ceil(WL_H / 8);
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

  return { update, encode, draw, resize };
}
