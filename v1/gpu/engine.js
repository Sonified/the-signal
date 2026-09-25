// The engine: device, canvas context, the frame graph, and the one
// requestAnimationFrame loop v1 is allowed to have. Everything else (scene,
// UI renderer, blur, toolkit) registers itself here and gets called back in
// the order laid out in ARCHITECTURE.md's Frame graph section. This file is
// the one place outside v1/platform allowed to touch navigator (navigator.gpu
// specifically), because the device belongs to the GPU layer, not the page.

let loggedAdapter = false;

// The blur capture's refresh ceiling. Glass shows a heavily blurred image of
// the field, and at this blur a capture ten times a second is
// indistinguishable from forty, while each one is six passes starting from a
// full-resolution read.
let ALWAYS_BLIT = false;
try { ALWAYS_BLIT = (typeof localStorage !== 'undefined') && localStorage.getItem('signal.v1.alwaysblit') === '1'; } catch (e) { /* worker or blocked storage: stays false */ }
const CAPTURE_INTERVAL_MS = 100;

// GPU timing (perf mode only): timestamp pairs for the scene (or direct)
// pass, the blur chain, and the final pass, read back every so often.
const TS_COUNT = 6;
const TS_SAMPLE_FRAMES = 30;

// opts.perf: turn on GPU pass timing when the adapter offers timestamp
// queries. Off, nothing below adds a single call to the frame.
//
// The timestamp-query feature itself is requested whenever the adapter
// offers it, perf mode or not, so the frame profiler (profileBegin below)
// can time passes in an ordinary session. Having the feature enabled costs
// nothing; only the timestampWrites on a pass do, and those are attached
// only while perf mode or the profiler is on.
// A wedged GPU process (it happens after a burst of device errors) leaves
// requestAdapter and requestDevice pending forever, and a promise that never
// settles is a page that stays black forever. Every await on the way to a
// device gets a deadline instead; missing it reads as "no engine", which
// main.js turns into a message a person can act on rather than a black page.
const GPU_REQUEST_TIMEOUT_MS = 10000;
function withDeadline(promise, ms) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(undefined), ms))]);
}

export async function createEngine(platform, opts) {
  const perfOn = !!(opts && opts.perf);
  if (!navigator.gpu) return null;

  let adapter = null;
  try {
    adapter = await withDeadline(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), GPU_REQUEST_TIMEOUT_MS);
  } catch {
    adapter = null;
  }
  if (adapter === undefined) {
    console.warn('[engine] adapter request timed out; the GPU process may need a browser restart');
    adapter = null;
  }
  if (!adapter) return null;

  // Adapter facts, kept for the profiler's report as well as logged once.
  const adapterInfo = { vendor: '', architecture: '', device: '', description: '', isFallbackAdapter: false };
  try {
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
    if (info) {
      adapterInfo.vendor = info.vendor || '';
      adapterInfo.architecture = info.architecture || '';
      adapterInfo.device = info.device || '';
      adapterInfo.description = info.description || '';
      adapterInfo.isFallbackAdapter = !!(info.isFallbackAdapter || adapter.isFallbackAdapter);
      if (!loggedAdapter) {
        loggedAdapter = true;
        console.log('[engine] adapter:', adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description);
      }
    }
  } catch {
    // Adapter info is diagnostic only; a browser that refuses to hand it
    // over is not a reason to fail startup.
  }

  let device = null;
  let hasTimestamps = false;
  if (adapter.features && adapter.features.has('timestamp-query')) {
    try {
      device = await withDeadline(adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }), GPU_REQUEST_TIMEOUT_MS);
      hasTimestamps = !!device;
    } catch {
      device = null;
    }
  }
  if (!device) {
    try {
      device = await withDeadline(adapter.requestDevice(), GPU_REQUEST_TIMEOUT_MS);
    } catch {
      device = null;
    }
  }
  if (!device) {
    console.warn('[engine] no device within the deadline');
    return null;
  }

  const context = platform.canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  // What the profiler's report says about the GPU. Built once, here.
  const LIMITS_OF_INTEREST = ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize',
    'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxColorAttachmentBytesPerSample',
    'maxBindGroups', 'maxSampledTexturesPerShaderStage'];
  const gpuInfo = {
    adapter: adapterInfo,
    adapterFeatures: adapter.features ? Array.from(adapter.features).sort() : [],
    deviceFeatures: device.features ? Array.from(device.features).sort() : [],
    limits: {},
    preferredCanvasFormat: format,
    timestampQuery: hasTimestamps
  };
  for (const k of LIMITS_OF_INTEREST) if (device.limits && k in device.limits) gpuInfo.limits[k] = device.limits[k];

  // Validation and out-of-memory errors nothing caught, passed to whoever
  // asked (the profiler, while it records).
  const gpuErrorCbs = [];
  device.addEventListener('uncapturederror', e => {
    const msg = e && e.error && e.error.message ? e.error.message : String(e && e.error);
    for (let i = 0; i < gpuErrorCbs.length; i++) gpuErrorCbs[i](msg);
  });

  // ---------- fullscreen blit ----------
  // sceneTex holds the whole strobing composition at full resolution. The
  // final pass blits it into the swap-chain texture with a fullscreen
  // triangle that reads it by exact pixel coordinate, which needs no sampler
  // and no vertex buffer: three vertices generated from vertex_index cover
  // the viewport, and @builtin(position) in the fragment stage already gives
  // device-pixel coordinates that line up one to one with sceneTex.
  const blitModule = device.createShaderModule({
    label: 'engine.blit',
    code: `
      struct VOut { @builtin(position) pos: vec4f };

      @vertex
      fn vs(@builtin(vertex_index) i: u32) -> VOut {
        var out: VOut;
        let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
        let y = f32(i & 2u) * 2.0 - 1.0;
        out.pos = vec4f(x, y, 0.0, 1.0);
        return out;
      }

      @group(0) @binding(0) var sceneTex: texture_2d<f32>;

      @fragment
      fn fs(in: VOut) -> @location(0) vec4f {
        return textureLoad(sceneTex, vec2i(in.pos.xy), 0);
      }
    `
  });
  const blitPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: blitModule, entryPoint: 'vs' },
    fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  });

  let sceneTex = null, sceneTexView = null, blitBindGroup = null;
  let pixelWidth = 0, pixelHeight = 0;

  function createSceneTexture(pw, ph) {
    if (sceneTex) sceneTex.destroy();
    sceneTex = device.createTexture({
      size: { width: pw, height: ph },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    sceneTexView = sceneTex.createView();
    scenePassDesc.colorAttachments[0].view = sceneTexView;
    blitBindGroup = device.createBindGroup({
      layout: blitPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sceneTexView }]
    });
  }

  // Render pass descriptors are built once and reused; only the .view fields
  // change from frame to frame (or on resize), so a frame that never resizes
  // never allocates one of these. directPassDesc is the one-pass route, the
  // scene and every UI list straight into the swap-chain texture, taken on
  // every frame that is not taking a blur capture.
  const scenePassDesc = {
    colorAttachments: [{
      view: null,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store'
    }]
  };
  const finalPassDesc = {
    colorAttachments: [{
      view: null,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store'
    }]
  };
  const directPassDesc = {
    colorAttachments: [{
      view: null,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store'
    }]
  };
  // queue.submit takes an array; this one is reused so the call never builds
  // a fresh one-element array per frame.
  const submitList = [null];

  // ---------- GPU timing, perf mode only ----------
  // Every pass writes its timestamps every frame (writing costs next to
  // nothing); every TS_SAMPLE_FRAMES frames one frame also resolves them into
  // a buffer and copies that to a mappable one, which is read back whenever
  // the GPU gets to it. Nothing waits on the map: a frame that comes due while
  // the last read is still pending just skips its turn.
  const gpu = {
    supported: hasTimestamps,
    samples: 0,
    sceneMs: 0, sceneMax: 0,       // scene pass, or the whole direct pass
    directMs: 0, directMax: 0, directSamples: 0,
    blurMs: 0, blurMax: 0, blurSamples: 0,
    finalMs: 0, finalMax: 0
  };
  gpu.supported = perfOn && hasTimestamps;
  let querySet = null, resolveBuf = null, readBuf = null;
  let perfMainTW = undefined, perfFinalTW = undefined;
  let tsFrames = 0, tsPending = false, tsWasDirect = false, tsWasCapture = false;
  if (perfOn && hasTimestamps) {
    try {
      querySet = device.createQuerySet({ type: 'timestamp', count: TS_COUNT });
      resolveBuf = device.createBuffer({ size: TS_COUNT * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      readBuf = device.createBuffer({ size: TS_COUNT * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      perfMainTW = { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
      perfFinalTW = { querySet, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 };
      scenePassDesc.timestampWrites = perfMainTW;
      directPassDesc.timestampWrites = perfMainTW;
      finalPassDesc.timestampWrites = perfFinalTW;
    } catch {
      querySet = null;
      gpu.supported = false;
    }
  }
  function spanMs(ts, a, b) {
    const d = Number(ts[b] - ts[a]) / 1e6;
    return d >= 0 && d < 1000 ? d : -1;
  }
  // A light running average, so the diagnostics line settles on a typical
  // figure rather than whichever frame happened to be sampled last.
  function ease(prev, v, n) { return n <= 1 ? v : prev + (v - prev) * 0.2; }
  // The map callbacks are made once, not per read, and read which route the
  // sampled frame took from tsWasDirect / tsWasCapture, which cannot change
  // while tsPending holds off the next sample.
  function onTimestampsMapped() {
    const wasDirect = tsWasDirect, wasCapture = tsWasCapture;
    const ts = new BigUint64Array(readBuf.getMappedRange());
    gpu.samples++;
    const first = spanMs(ts, 0, 1);
    if (first >= 0) {
      if (wasDirect) {
        gpu.directSamples++;
        gpu.directMs = ease(gpu.directMs, first, gpu.directSamples);
        if (first > gpu.directMax) gpu.directMax = first;
      } else {
        gpu.sceneMs = ease(gpu.sceneMs, first, gpu.samples - gpu.directSamples);
        if (first > gpu.sceneMax) gpu.sceneMax = first;
        const fin = spanMs(ts, 4, 5);
        if (fin >= 0) {
          gpu.finalMs = ease(gpu.finalMs, fin, gpu.samples - gpu.directSamples);
          if (fin > gpu.finalMax) gpu.finalMax = fin;
        }
      }
    }
    if (wasCapture) {
      const b = spanMs(ts, 2, 3);
      if (b >= 0) {
        gpu.blurSamples++;
        gpu.blurMs = ease(gpu.blurMs, b, gpu.blurSamples);
        if (b > gpu.blurMax) gpu.blurMax = b;
      }
    }
    readBuf.unmap();
    tsPending = false;
  }
  function onTimestampsFailed() { tsPending = false; }
  function readTimestamps() {
    readBuf.mapAsync(GPUMapMode.READ).then(onTimestampsMapped, onTimestampsFailed);
  }

  // ---------- frame profiler (v1/core/profiler.js), only while it records ----------
  // Two rings of preallocated slots, so a recording frame never builds a
  // descriptor, a buffer or a callback. Each GPU-timed frame takes a slot of
  // PROF_TS_PER timestamps (main pass, final pass, blur chain, particle
  // compute, a begin and an end each), resolves them into its own 256-byte
  // stretch of one resolve buffer (resolveQuerySet offsets must be multiples
  // of 256), copies that into the slot's own mappable buffer and maps it
  // after the submit. A slot whose map has not come back yet is skipped,
  // so a GPU running behind drops timing samples, never frames. The second
  // ring stamps each submit and waits on queue.onSubmittedWorkDone(); its
  // resolution time, measured on this thread, is when the main thread
  // learned the GPU had finished that frame. The promises those two calls
  // return are the profiler's only per-frame garbage, and only while it
  // records. Nothing here runs at all otherwise.
  const PROF_TS_RING = 8, PROF_TS_PER = 8, PROF_DONE_RING = 16;
  let prof = null;           // the profiler's sink while recording
  let profSink = null;       // the same, kept after it stops, for late results
  let profQS = null, profResolve = null, profReady = false;
  let profTsNext = 0, profDoneNext = 0;
  const profRead = [], profTsCb = [], profTsFail = [], profDoneCb = [], profDoneFail = [];
  const profMainTW = [], profFinalTW = [], profBlurA = [], profBlurB = [], profCompTW = [];
  const profTsBusy = new Uint8Array(PROF_TS_RING), profTsMask = new Uint8Array(PROF_TS_RING);
  const profTsFrame = new Int32Array(PROF_TS_RING), profTsGen = new Int32Array(PROF_TS_RING);
  const profDoneBusy = new Uint8Array(PROF_DONE_RING);
  const profDoneFrame = new Int32Array(PROF_DONE_RING), profDoneGen = new Int32Array(PROF_DONE_RING);
  const profDoneT = new Float64Array(PROF_DONE_RING);

  function makeProfTsCb(k) {
    return function () {
      const buf = profRead[k];
      const ts = new BigUint64Array(buf.getMappedRange(0, PROF_TS_PER * 8));
      const m = profTsMask[k];
      const main = spanMs(ts, 0, 1);
      const fin = m & 1 ? spanMs(ts, 2, 3) : -1;
      const bl = m & 2 ? spanMs(ts, 4, 5) : -1;
      const comp = m & 4 ? spanMs(ts, 6, 7) : -1;
      buf.unmap();
      profTsBusy[k] = 0;
      if (profSink) profSink.gpuPasses(profTsGen[k], profTsFrame[k], main, fin, bl, comp);
    };
  }
  function makeProfTsFail(k) { return function () { profTsBusy[k] = 0; }; }
  function makeProfDoneCb(k) {
    return function () {
      profDoneBusy[k] = 0;
      if (profSink) profSink.gpuDone(profDoneGen[k], profDoneFrame[k], platform.now() - profDoneT[k]);
    };
  }
  function makeProfDoneFail(k) { return function () { profDoneBusy[k] = 0; }; }
  function profSetup() {
    if (profReady) return;
    profReady = true;
    for (let k = 0; k < PROF_DONE_RING; k++) {
      profDoneCb.push(makeProfDoneCb(k));
      profDoneFail.push(makeProfDoneFail(k));
    }
    if (!hasTimestamps) return;
    try {
      profQS = device.createQuerySet({ type: 'timestamp', count: PROF_TS_RING * PROF_TS_PER });
      profResolve = device.createBuffer({ size: PROF_TS_RING * 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      for (let k = 0; k < PROF_TS_RING; k++) {
        const b = k * PROF_TS_PER;
        profRead.push(device.createBuffer({ size: PROF_TS_PER * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
        profMainTW.push({ querySet: profQS, beginningOfPassWriteIndex: b, endOfPassWriteIndex: b + 1 });
        profFinalTW.push({ querySet: profQS, beginningOfPassWriteIndex: b + 2, endOfPassWriteIndex: b + 3 });
        profBlurA.push({ querySet: profQS, beginningOfPassWriteIndex: b + 4 });
        profBlurB.push({ querySet: profQS, endOfPassWriteIndex: b + 5 });
        profCompTW.push({ querySet: profQS, beginningOfPassWriteIndex: b + 6, endOfPassWriteIndex: b + 7 });
        profTsCb.push(makeProfTsCb(k));
        profTsFail.push(makeProfTsFail(k));
      }
    } catch {
      profQS = null;
    }
  }
  // sink: { n, gen, gpuDone(gen, frame, ms), gpuPasses(gen, frame, mainMs, finalMs, blurMs, computeMs) }
  // n is the index of the frame being built, read at render time. Returns
  // whether GPU pass timing is available.
  function profileBegin(sink) {
    profSetup();
    prof = sink; profSink = sink;
    return !!profQS;
  }
  function profileEnd() {
    if (!prof) return;
    prof = null;
    scenePassDesc.timestampWrites = perfMainTW;
    directPassDesc.timestampWrites = perfMainTW;
    finalPassDesc.timestampWrites = perfFinalTW;
    if (blur && blur.overrideTimestamps) blur.overrideTimestamps(false, undefined, undefined);
    if (particles && particles.setTimestampWrites) particles.setTimestampWrites(undefined);
  }

  let scene = null, uiRenderer = null, blur = null, flowers = null, kaleido = null, particles = null, fireworks = null, wordCloud = null, wordSmoke = null;
  let deviceLost = false;
  const lostCbs = [];

  // Capture bookkeeping. captureValid goes false whenever the blur chain's
  // textures are rebuilt (their contents are then undefined); captureStale
  // goes true whenever the caller says the scene may have changed, and stays
  // true until a capture actually lands, so a change made while throttled is
  // still picked up by a trailing capture rather than lost.
  let captureValid = false, captureStale = true, lastCaptureT = -1e9;
  let frameT = 0, frameDt = 0;

  const engine = {
    device, format, sceneFormat: format,
    dpr: platform.dpr, width: platform.width, height: platform.height,
    pixelWidth: 0, pixelHeight: 0,
    // What the last render() did, for the perf counters in main.js.
    lastDirect: false, lastCapture: false,
    gpu, gpuInfo,
    start, render, registerScene, registerFlowers, registerKaleido, registerParticles, registerFireworks, registerWordCloud, registerWordSmoke, registerUI, onDeviceLost,
    onGpuError: fn => { gpuErrorCbs.push(fn); },
    profileBegin, profileEnd
  };

  function handleResize(cssW, cssH, dpr) {
    engine.width = cssW; engine.height = cssH; engine.dpr = dpr;
    pixelWidth = Math.max(1, platform.canvas.width);
    pixelHeight = Math.max(1, platform.canvas.height);
    engine.pixelWidth = pixelWidth; engine.pixelHeight = pixelHeight;
    createSceneTexture(pixelWidth, pixelHeight);
    if (scene && scene.resize) scene.resize(pixelWidth, pixelHeight, dpr);
    if (flowers && flowers.resize) flowers.resize(pixelWidth, pixelHeight, dpr);
    if (kaleido && kaleido.resize) kaleido.resize(pixelWidth, pixelHeight, dpr);
    if (particles && particles.resize) particles.resize(pixelWidth, pixelHeight, dpr);
    if (fireworks) fireworks.resize(pixelWidth, pixelHeight, dpr);
    if (wordCloud) wordCloud.resize(pixelWidth, pixelHeight, dpr);
    if (wordSmoke) wordSmoke.resize(pixelWidth, pixelHeight, dpr);
    if (uiRenderer && uiRenderer.resize) uiRenderer.resize(pixelWidth, pixelHeight, dpr);
    if (blur && blur.resize) blur.resize(pixelWidth, pixelHeight, dpr);
    captureValid = false; captureStale = true;
  }

  function registerScene(s) {
    scene = s;
    if (pixelWidth && scene.resize) scene.resize(pixelWidth, pixelHeight, engine.dpr);
  }
  // The flower layer (v1/gpu/flowers.js) draws inside the scene pass between
  // the scene's two halves: over the field and rings, under the edge.
  function registerFlowers(f) {
    flowers = f;
    if (pixelWidth && flowers.resize) flowers.resize(pixelWidth, pixelHeight, engine.dpr);
  }
  // The kaleidoscope layer (v1/gpu/kaleido.js) sits in the same gap, over
  // the flowers and under the edge. Its fold reads an offscreen object
  // chamber, which it fills in a small pass of its own before the scene pass
  // (encodeChamber in render below).
  function registerKaleido(k) {
    kaleido = k;
    if (pixelWidth && kaleido.resize) kaleido.resize(pixelWidth, pixelHeight, engine.dpr);
  }
  // The particle generator (v1/gpu/particles.js) draws over the kaleidoscope
  // and under the edge. Its simulation (a compute pass) and, when folded, its
  // chamber are encoded before the scene pass (particles.encode below).
  function registerParticles(p) {
    particles = p;
    if (pixelWidth && particles.resize) particles.resize(pixelWidth, pixelHeight, engine.dpr);
  }
  // The fireworks (v1/gpu/fireworks.js) draw over the particles and under
  // the edge. They have no pass of their own: one instanced draw, placed from
  // each show's age.
  function registerFireworks(f) {
    fireworks = f;
    if (pixelWidth) fireworks.resize(pixelWidth, pixelHeight, engine.dpr);
  }
  // The word cloud (v1/gpu/word-cloud.js) draws straight after the word, in
  // whichever pass the word is in; its seed dispatch, on the frame a word
  // first clouds, is encoded before either route.
  function registerWordCloud(m) {
    wordCloud = m;
    if (pixelWidth) wordCloud.resize(pixelWidth, pixelHeight, engine.dpr);
  }
  // The word smoke (v1/gpu/word-smoke.js): the recorded-dissolution word
  // transition. Its offscreen preparation is encoded before the passes; its
  // playback draws where the word draws.
  function registerWordSmoke(m) {
    wordSmoke = m;
    if (pixelWidth) wordSmoke.resize(pixelWidth, pixelHeight, engine.dpr);
  }
  function registerUI(ui, bl) {
    uiRenderer = ui; blur = bl;
    captureValid = false; captureStale = true;
    if (blur && querySet && blur.setTimestamps) blur.setTimestamps(querySet, 2, 3);
    if (pixelWidth) {
      if (uiRenderer && uiRenderer.resize) uiRenderer.resize(pixelWidth, pixelHeight, engine.dpr);
      if (blur && blur.resize) blur.resize(pixelWidth, pixelHeight, engine.dpr);
    }
  }
  function onDeviceLost(fn) { lostCbs.push(fn); }

  // The strobing content of the scene pass, identical in both render paths.
  // A scene without the split (or no layers between its halves) draws in
  // one call.
  function drawScene(pass) {
    if (!scene) return;
    if ((flowers || kaleido || particles || fireworks) && scene.drawBack) {
      scene.drawBack(pass);
      if (flowers) flowers.draw(pass);
      if (kaleido) kaleido.draw(pass);
      if (particles) particles.draw(pass);
      if (fireworks) fireworks.draw(pass);
      scene.drawFront(pass);
    } else if (scene.draw) {
      scene.draw(pass);
    }
  }

  device.lost.then(info => {
    deviceLost = true;
    for (let i = 0; i < lostCbs.length; i++) lostCbs[i](info.message);
  });

  // ---------- frame graph ----------
  // topList is a second UI layer drawn over uiList: the floating mixer and the
  // burger live there so they sit above the drawer. Immediate-mode hit testing
  // is first-come, so integration builds that layer first and draws it last.
  //
  // glassVisible means frosted glass (DrawList.glassCount), the only thing
  // that ever reads the capture. sceneChanged is the caller's word that the
  // scene may differ from the last one captured: always while running, and
  // while stopped only on input, a drawer slide or an overlay fade.
  function render(args) {
    if (deviceLost || !sceneTex) return;
    const lum = args.lum, lit = args.lit, glassVisible = args.glassVisible;
    const overlayList = args.overlayList, uiList = args.uiList, topList = args.topList;

    if (scene && scene.update) scene.update(lum);
    if (flowers) flowers.update(frameT, frameDt, lum);
    if (kaleido) kaleido.update(frameT, frameDt, lum);
    if (particles) particles.update(frameT, frameDt, lum);
    if (fireworks) fireworks.update(frameT, frameDt);
    if (wordCloud) wordCloud.update(frameT, frameDt);
    if (wordSmoke) wordSmoke.update(frameT, frameDt);
    if (args.sceneChanged) captureStale = true;

    // Capture a fresh blur only on a lit frame with frosted glass on screen,
    // and at most CAPTURE_INTERVAL_MS apart; a dark frame keeps the previous
    // capture, so a panel's frost never flickers with the strobe. A capture
    // the glass has never had (first use, or after a resize) is taken on the
    // first lit frame regardless of the throttle.
    const doCapture = !!blur && glassVisible && lit &&
      (!captureValid || (captureStale && frameT - lastCaptureT >= CAPTURE_INTERVAL_MS));
    // With no capture due, sceneTex has no reader but the blit, so the scene
    // goes straight into the swap-chain texture and the blit disappears.
    // That holds with frosted glass up too: glass samples the blur chain's
    // own output (blur.view), never sceneTex, so a glass frame between
    // captures is the same picture drawn in one pass. Only a capture frame
    // (at most ten a second) needs the scene in a texture of its own. The UI
    // lists follow the scene in the same pass: they draw after it either
    // way, and one pass spares a tiled GPU the store and reload of the whole
    // frame that a second pass on the same texture costs.
    // Diagnostic switch: localStorage 'signal.v1.alwaysblit' = '1' restores
    // the pre-optimisation routing, where EVERY frame with glass on screen
    // goes through sceneTex and the blit, so the path never alternates while
    // a panel is open. If an open drawer blinks in direct mode and steadies
    // under this flag, the alternation itself is the artifact.
    const direct = !doCapture && !(ALWAYS_BLIT && glassVisible);

    const encoder = device.createCommandEncoder();
    const swapView = context.getCurrentTexture().createView();

    // Profiler: point every timed pass at this frame's slot, or at nothing
    // when every slot is still waiting on its readback.
    let pk = -1;
    if (prof) {
      if (profQS && profTsBusy[profTsNext] === 0) { pk = profTsNext; profTsNext = (pk + 1) % PROF_TS_RING; }
      const mainTW = pk >= 0 ? profMainTW[pk] : undefined;
      scenePassDesc.timestampWrites = mainTW;
      directPassDesc.timestampWrites = mainTW;
      finalPassDesc.timestampWrites = pk >= 0 ? profFinalTW[pk] : undefined;
      if (blur && blur.overrideTimestamps) {
        blur.overrideTimestamps(true, pk >= 0 ? profBlurA[pk] : undefined, pk >= 0 ? profBlurB[pk] : undefined);
      }
      if (particles && particles.setTimestampWrites) particles.setTimestampWrites(pk >= 0 ? profCompTW[pk] : undefined);
    }

    // The kaleidoscope's chamber pass, ahead of whichever route the scene
    // takes below, since both fold it into the scene. It encodes nothing on
    // a frame the layer is off or has nothing to draw.
    if (kaleido && kaleido.encodeChamber) kaleido.encodeChamber(encoder);
    if (particles && particles.encode) particles.encode(encoder);
    if (wordCloud) wordCloud.encode(encoder);
    if (wordSmoke) wordSmoke.encode(encoder);

    if (direct) {
      directPassDesc.colorAttachments[0].view = swapView;
      const pass = encoder.beginRenderPass(directPassDesc);
      drawScene(pass);
      if (uiRenderer) {
        if (overlayList && overlayList.count > 0) uiRenderer.draw(pass, overlayList, null);
        if (wordCloud) wordCloud.draw(pass);
        if (wordSmoke) wordSmoke.draw(pass);
        const bv = blur ? blur.view : null;
        if (uiList && uiList.count > 0) uiRenderer.draw(pass, uiList, bv);
        if (topList && topList.count > 0) uiRenderer.draw(pass, topList, bv);
      }
      pass.end();
    } else {
      // Scene pass: the strobing field, rings, corners and edge, plus anything
      // that rides on top of the field without being multiplied by it (word,
      // hint), drawn into sceneTex at full resolution.
      const scenePass = encoder.beginRenderPass(scenePassDesc);
      drawScene(scenePass);
      if (uiRenderer && overlayList && overlayList.count > 0) uiRenderer.draw(scenePass, overlayList, null);
      if (wordCloud) wordCloud.draw(scenePass);
      if (wordSmoke) wordSmoke.draw(scenePass);
      scenePass.end();

      if (doCapture) {
        blur.capture(encoder, sceneTex);
        captureValid = true;
        captureStale = false;
        lastCaptureT = frameT;
      }

      // Final pass: blit sceneTex to the swap chain, then the steady-brightness
      // UI on top, unaffected by whatever lum the scene pass just drew.
      finalPassDesc.colorAttachments[0].view = swapView;
      const finalPass = encoder.beginRenderPass(finalPassDesc);
      finalPass.setPipeline(blitPipeline);
      finalPass.setBindGroup(0, blitBindGroup);
      finalPass.draw(3);
      const bv = blur ? blur.view : null;
      if (uiRenderer && uiList && uiList.count > 0) uiRenderer.draw(finalPass, uiList, bv);
      if (uiRenderer && topList && topList.count > 0) uiRenderer.draw(finalPass, topList, bv);
      finalPass.end();
    }
    engine.lastDirect = direct;
    engine.lastCapture = doCapture;

    if (pk >= 0) {
      encoder.resolveQuerySet(profQS, pk * PROF_TS_PER, PROF_TS_PER, profResolve, pk * 256);
      encoder.copyBufferToBuffer(profResolve, pk * 256, profRead[pk], 0, PROF_TS_PER * 8);
      profTsMask[pk] = (direct ? 0 : 1) | (doCapture ? 2 : 0) | (particles && particles.computed ? 4 : 0);
      profTsFrame[pk] = prof.n; profTsGen[pk] = prof.gen; profTsBusy[pk] = 1;
    }

    // Perf mode's own sampling stands aside while the profiler holds the
    // pass timestamps.
    let sampled = false;
    if (querySet && !prof) {
      tsFrames++;
      if (tsFrames >= TS_SAMPLE_FRAMES && !tsPending) {
        tsFrames = 0;
        encoder.resolveQuerySet(querySet, 0, TS_COUNT, resolveBuf, 0);
        encoder.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, TS_COUNT * 8);
        tsPending = true; tsWasDirect = direct; tsWasCapture = doCapture;
        sampled = true;
      }
    }

    submitList[0] = encoder.finish();
    device.queue.submit(submitList);
    submitList[0] = null;

    if (sampled) readTimestamps();

    if (prof) {
      if (pk >= 0) profRead[pk].mapAsync(GPUMapMode.READ).then(profTsCb[pk], profTsFail[pk]);
      const k = profDoneNext;
      if (profDoneBusy[k] === 0) {
        profDoneNext = (k + 1) % PROF_DONE_RING;
        profDoneBusy[k] = 1;
        profDoneFrame[k] = prof.n; profDoneGen[k] = prof.gen;
        profDoneT[k] = platform.now();
        device.queue.onSubmittedWorkDone().then(profDoneCb[k], profDoneFail[k]);
      }
    }
  }

  let rafHandle = 0;
  function start(frameFn) {
    let lastFrameT = null;
    function raf(t) {
      // A lost device is the one condition where the loop truly stops rather
      // than just skipping a frame's work: there is nothing left to submit
      // to, and integration is responsible for deciding whether to build a
      // new engine. Every other frame requests its successor first thing, as
      // v0 does, so a slow frame never pushes the next one further out than
      // it has to be.
      if (deviceLost) return;
      rafHandle = requestAnimationFrame(raf);
      frameT = t;
      let dt = lastFrameT === null ? 0 : (t - lastFrameT) / 1000;
      lastFrameT = t;
      if (dt < 0 || dt > 0.25) dt = 0;   // tab-switch / device-sleep guard
      frameDt = dt;
      frameFn(t, dt);
    }
    rafHandle = requestAnimationFrame(raf);
  }

  handleResize(platform.width, platform.height, platform.dpr);
  platform.onResize(handleResize);

  return engine;
}
