// The brush layer: the stamps core/brush.js queues (the hand's strokes and
// the hall's) drawn as motif tiles into a video feedback image of the
// layer's own (feedback.js), which fades each frame by the Fade slider's
// half-life (core/brush-stamps.js fadeHalfLife), and laid over the scene,
// over the confetti and under the edge. The marks never stream or twist:
// they fade where they were made, and only follow the field when the drawer
// slides it aside (the image's centre and unit are the field's square, so
// the trails ride the field as every feedback image does). The fade runs on
// the frame's own clock, not the scene's motion, so marks die away and a
// hand can draw whether the strobe runs or not.
//
// Atlases. Each stroke names its Image set (the wire's a), so a mark from a
// screen on another set is still drawn with its own motifs: the layer keeps
// up to MAX_ATLASES sets' atlases on the GPU, each built from the set's
// ordinary sheet by the kaleidoscope's own pass (gpu/atlas-bake.js, the
// same bake the browser keeps for both), loaded the first time a stamp or
// the drawer's picker asks for it. The picker's set (the current Image set)
// is never the one let go; the least recently used other one is. The
// current set's atlas is also the UI renderer's picture, which the picker's
// thumbnails sample (opts.picture), and its painted tiles are published in
// core/brush.js brushAtlas.
//
// Remote strokes are played out first (core/brush.js brushPlay): their
// stamps reach the queue as each one's playback cursor passes them, so the
// ribbon glides; local ones are in the queue the frame the hand made them.
//
// Stamps are taken from the queue in order, at most MAX_INST a frame, and
// only while the atlas each names is on the GPU, so the painting order is
// the order they were made in (but that within a frame the senders take
// turns at the top, core/brush-order.js); one waiting on its atlas holds the rest
// back until it lands (a set that fails to load lets its stamps go). They
// leave the queue only once encoded into the image, so a frame that holds
// the image (one with no step, a wake) draws them on the next.
//
// The image exists only while there is something in it: made for the first
// stamp, let go once it has faded to nothing (feedback.js says when, to the
// texel), so an idle brush costs no memory. Nothing is allocated per frame.

import { S } from '../js/state.js';
import { BRUSH_WGSL } from './brush.wgsl.js';
import { createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT } from './feedback.js';
import { MOTIFS, LAYOUT_STD, bakeTag, bakeAtlasPixels, buildAtlasMips } from './atlas-bake.js';
import { kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';
import { idleHold, idleRelease } from '../core/idle.js';
import { brushQueue, brushQueueDrop, brushAtlas, STAMP_FLOATS, brushPlay, brushPlaying } from '../core/brush.js';
import { fadeHalfLife, fieldSquare } from '../core/brush-stamps.js';
import { frameOrder, noteSender, forgetIdle, activeSenders, MAX_SENDERS } from '../core/brush-order.js';

const MAX_INST = 4096;
const INST_FLOATS = 8;             // x y half angle | u0 v0 - -
const MAX_ATLASES = 3;
// A tile painting less than this share of its inner square is empty: the
// cut leaves a true blank at exactly 0, and a few stray texels are no shape.
const EMPTY_FILL = 0.002;

export function createBrush(device, format, platform, opts) {
  const picture = (opts && opts.picture) || null;
  const yieldFn = (opts && opts.yieldTile) || null;
  const yieldTile = () => (yieldFn ? yieldFn() : new Promise(r => setTimeout(r, 0)));
  const L = LAYOUT_STD;

  let pixelW = 1, pixelH = 1, dpr = 1;
  let made = false, pipe = null, bgl = null, sampler = null, uniBuf = null, instBuf = null, fb = null;
  const uni = new Float32Array(8);
  const inst = new Float32Array(MAX_INST * INST_FLOATS);
  // This frame's draws: runs of instances sharing one atlas.
  const runBind = new Array(MAX_INST).fill(null);
  const runFirst = new Int32Array(MAX_INST), runCount = new Int32Array(MAX_INST);
  let nRuns = 0, nInst = 0, fbOn = false;
  // The frame's chosen stamps before they are ordered: each one's place in
  // the queue, its atlas and its sender, and the order's scratch.
  const selO = new Int32Array(MAX_INST), selAtlas = new Array(MAX_INST).fill(null);
  const selWho = new Float64Array(MAX_INST), selOrder = new Int32Array(MAX_INST);
  const selRank = new Int32Array(MAX_INST), selTally = new Int32Array(MAX_SENDERS + 2);
  const params = { keepHalfLife: 1, zoomRate: 0, twistRate: 0, cx: 0, cy: 0, unit: 1, dt: 0 };
  const sq = { cx: 0, cy: 0, side: 1 };
  let frame = 0;

  function make() {
    made = true;
    const mod = device.createShaderModule({ label: 'brush.wgsl', code: BRUSH_WGSL });
    if (mod.getCompilationInfo) {
      mod.getCompilationInfo().then(info => {
        if (info.messages.some(m => m.type === 'error')) {
          console.warn('brush.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
        }
      });
    }
    bgl = device.createBindGroupLayout({
      label: 'brush.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
      ]
    });
    // Objects laid over what is there: premultiplied "over", alpha building
    // up as coverage, as the composite needs (feedback.js).
    const over = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
    };
    pipe = device.createRenderPipeline({
      label: 'brush.stamp',
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: mod, entryPoint: 'vsStamp',
        buffers: [{
          arrayStride: INST_FLOATS * 4, stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' }
          ]
        }]
      },
      fragment: { module: mod, entryPoint: 'fsStamp', targets: [{ format: FEEDBACK_FORMAT, blend: over }] },
      primitive: { topology: 'triangle-list' }
    });
    // Trilinear, as the kaleidoscope reads its atlas: a stamp is usually
    // drawn under the atlas's own size.
    sampler = device.createSampler({
      label: 'brush.sampler',
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
      lodMaxClamp: L.mips - 1
    });
    uniBuf = device.createBuffer({ label: 'brush.uniforms', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    instBuf = device.createBuffer({ label: 'brush.instances', size: MAX_INST * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    fb = createFeedback(device, format, { label: 'brush.feedback' });
    uni[4] = L.innerUV; uni[5] = L.halfTexel;
  }

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw | 0); pixelH = Math.max(1, ph | 0); dpr = d || 1;
  }

  // ---------- the atlases ----------
  // set (the kaleidoscope's own numbering, as kaleidoscopeSet resolves it)
  // -> { set, tex, view, bind, fill, first, ready, failed, used }
  const atlases = new Map();
  let shown = null;            // the atlas published as the picker's

  function setOf(n) { return kaleidoscopeSet(n).id; }

  function load(set) {
    if (atlases.has(set)) return;
    if (!platform || !platform.loadImagePixels) return;
    if (atlases.size >= MAX_ATLASES) evict(set);
    const def = kaleidoscopeSet(set), url = def.image;
    const a = { set, tex: null, view: null, bind: null, fill: null, first: 0, ready: false, failed: false, used: frame };
    atlases.set(set, a);
    const stale = () => atlases.get(set) !== a;
    // a resting frame loop stays awake until it is in (core/idle.js)
    idleHold();
    const bake = img => bakeAtlasPixels(img, L, stale, yieldTile);
    const loading = platform.loadImageBaked ? platform.loadImageBaked(url, bakeTag(L), bake)
      : platform.loadImagePixels(url).then(bake);
    loading
      .then(baked => {
        if (stale()) return;
        if (!baked) { a.failed = true; return; }
        install(a, baked);
      })
      .catch(err => {
        if (!stale()) a.failed = true;
        console.warn('brush: could not load the motif atlas ' + url + ':', err && err.message ? err.message : err);
      })
      .finally(() => idleRelease('the brush atlas'));
  }

  function install(a, baked) {
    if (!made) make();
    const tex = device.createTexture({
      label: 'brush.atlas' + a.set,
      size: { width: L.atlas, height: L.atlas },
      format: 'rgba8unorm',
      mipLevelCount: L.mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    device.queue.writeTexture({ texture: tex }, baked.out, { bytesPerRow: L.atlas * 4, rowsPerImage: L.atlas },
                              { width: L.atlas, height: L.atlas });
    buildAtlasMips(device, tex, L.mips);
    a.tex = tex; a.view = tex.createView(); a.fill = baked.fill;
    // the tile an empty pick stamps instead: the set's first painted one
    a.first = 0;
    for (let t = 0; t < MOTIFS; t++) if (baked.fill[t] > EMPTY_FILL) { a.first = t; break; }
    a.bind = device.createBindGroup({
      label: 'brush.bind' + a.set, layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniBuf } },
        { binding: 1, resource: a.view },
        { binding: 2, resource: sampler }
      ]
    });
    a.ready = true;
  }

  // Room for one more: the least recently used set that is neither the
  // picker's (the current Image set), the one wanted, nor the set the
  // queue's head waits on. Called between frames (update, or a load from
  // it), so a texture let go here is in no encoder.
  function evict(keep) {
    const cur = setOf(S.kaleidoSet);
    const q = brushQueue;
    const head = q.count ? setOf(q.buf[q.head * STAMP_FLOATS + 5]) : 0;
    let worst = null;
    for (const a of atlases.values()) {
      if (a.set === cur || a.set === keep || a.set === head) continue;
      if (!worst || a.used < worst.used) worst = a;
    }
    if (!worst) return;
    if (worst === shown) { shown = null; if (picture) picture(null); }
    if (worst.tex) worst.tex.destroy();
    atlases.delete(worst.set);
  }

  // The current set's atlas as the picker's, once it is in: its painted
  // tiles in sheet order and the picture the thumbnails sample.
  function publish() {
    const cur = setOf(S.kaleidoSet);
    const a = atlases.get(cur);
    if (!a || !a.ready || a === shown) return;
    shown = a;
    const b = brushAtlas;
    let n = 0;
    for (let t = 0; t < MOTIFS; t++) {
      const empty = !(a.fill[t] > EMPTY_FILL);
      b.empty[t] = empty ? 1 : 0;
      if (!empty) b.tiles[n++] = t;
    }
    b.count = n; b.set = cur; b.padUV = L.padUV; b.innerUV = L.innerUV; b.ready = true;
    if (picture) picture(a.view);
  }

  // ---------- per frame ----------
  function update(t, dt) {
    frame++;
    // remote strokes let out what their playback cursors have passed
    // (core/brush.js brushPlay), into the ring taken below
    brushPlay(dt > 0 ? dt : 0);
    // The picker drew this frame and wants its set (the widget asks each
    // frame it is drawn; core/schema-brush.js).
    const want = brushAtlas.want;
    brushAtlas.want = 0;
    if (want > 0) { const s = setOf(want); load(s); const a = atlases.get(s); if (a) a.used = frame; }
    publish();

    // The field's square in device px: where a unit point lands.
    fieldSquare(S.W || pixelW / dpr, S.H || pixelH / dpr, S.edgeInset || 0, sq);
    const cx = sq.cx * dpr, cy = sq.cy * dpr, side = sq.side * dpr;

    // Take the queue's head, in order, while its atlases are in; then lay
    // the frame's stamps in sender by sender, the one in front this second
    // last (core/brush-order.js), each sender's in the order they came.
    nInst = 0; nRuns = 0;
    const q = brushQueue, buf = q.buf;
    let take = 0, nSel = 0;
    while (take < q.count && nSel < MAX_INST) {
      const o = ((q.head + take) % q.cap) * STAMP_FLOATS;
      const set = setOf(buf[o + 5]);
      let a = atlases.get(set);
      if (!a) { load(set); a = atlases.get(set); }
      if (!a) break;
      if (a.failed) { take++; continue; }    // a set that will never draw lets its stamps go
      if (!a.ready) break;
      a.used = frame;
      selO[nSel] = o; selAtlas[nSel] = a; selWho[nSel] = buf[o + 6];
      nSel++; take++;
    }
    if (nSel > 0) {
      const sec = Math.floor(Date.now() / 1000);
      forgetIdle(sec);
      for (let j = 0; j < nSel; j++) noteSender(selWho[j], sec);
      frameOrder(selWho, nSel, activeSenders.ids, activeSenders.n, sec, selOrder, selRank, selTally);
    }
    let runAtlas = null;
    for (let jj = 0; jj < nSel; jj++) {
      const j = selOrder[jj], o = selO[j], a = selAtlas[j];
      if (a !== runAtlas) {
        runAtlas = a;
        runBind[nRuns] = a.bind; runFirst[nRuns] = nInst; runCount[nRuns] = 0; nRuns++;
      }
      // An empty tile draws the set's first painted one, as the picker
      // shows it (a pick made before the atlas was known, or another set's).
      let m = buf[o + 4] | 0;
      if (m < 0 || m >= MOTIFS || !(a.fill[m] > EMPTY_FILL)) m = a.first;
      const i = nInst * INST_FLOATS;
      inst[i] = cx + (buf[o] - 0.5) * side;
      inst[i + 1] = cy + (buf[o + 1] - 0.5) * side;
      inst[i + 2] = buf[o + 3] * side * 0.5;
      inst[i + 3] = buf[o + 2];
      inst[i + 4] = (m % 8) / 8 + L.padUV;
      inst[i + 5] = ((m / 8) | 0) / 8 + L.padUV;
      inst[i + 6] = 0; inst[i + 7] = 0;
      runCount[nRuns - 1]++;
      nInst++;
    }
    takeN = take;

    // The image: made for the first stamp, let go once faded to nothing.
    if (nInst > 0 && !made) make();
    if (!made) { fbOn = false; return; }
    if (nInst === 0 && fbOn && fb.view === null && fb.live) { fb.release(); fbOn = false; }
    if (nInst > 0) fbOn = true;
    if (!fbOn) { if (take > 0) brushQueueDrop(take); takeN = 0; return; }
    fb.ensure(pixelW, pixelH, feedbackRes(S.fbResScale), feedbackKeep(S.fbResSwitch));
    params.keepHalfLife = fadeHalfLife(S.brushFade);
    params.cx = cx; params.cy = cy; params.unit = side;
    params.dt = dt > 0 ? dt : 0;
    if (nInst > 0) {
      uni[0] = 2 / pixelW; uni[1] = 2 / pixelH;
      device.queue.writeBuffer(uniBuf, 0, uni);
      device.queue.writeBuffer(instBuf, 0, inst, 0, nInst * INST_FLOATS);
    }
  }
  // The stamps this frame took from the queue (failed sets' included),
  // dropped once encoded.
  let takeN = 0;

  // Before the scene pass: the image faded and this frame's stamps drawn
  // into it. A held image (no step this frame) draws nothing and keeps the
  // stamps for the next.
  function encode(encoder) {
    if (!fbOn) return;
    const pass = fb.begin(encoder, params, nInst > 0);
    if (!pass) {
      // nothing drawn this frame; stamps of a failed set alone can go
      if (nInst === 0 && takeN > 0) { brushQueueDrop(takeN); takeN = 0; }
      return;
    }
    if (nInst > 0) {
      pass.setPipeline(pipe);
      pass.setVertexBuffer(0, instBuf);
      for (let r = 0; r < nRuns; r++) {
        pass.setBindGroup(0, runBind[r]);
        pass.draw(6, runCount[r], 0, runFirst[r]);
      }
    }
    fb.end(pass);
    if (takeN > 0) { brushQueueDrop(takeN); takeN = 0; }
  }

  function draw(pass) {
    if (fbOn) fb.composite(pass, 1, 1);
  }

  // Still moving by itself: marks fading, or stamps waiting for a frame.
  function busy() {
    return (fbOn && fb.view !== null) || (brushQueue.count > 0 && nInst > 0) || brushPlaying();
  }

  return { update, encode, draw, resize, busy };
}
