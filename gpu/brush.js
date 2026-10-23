// The brush layer: the stamps core/brush.js queues (the hand's strokes and
// the hall's) drawn as motif tiles into a video feedback image of the
// layer's own (feedback.js), which fades each frame by the Fade slider's
// half-life (core/brush-stamps.js fadeHalfLife), and laid over the scene,
// over the confetti and under the edge. The marks never stream. They fade
// where they were made, turn about the field's centre at the Rotation
// slider's speed (the feedback's twist; 0 leaves them still), and follow the
// field when the drawer slides it aside (the image's centre and unit are the field's square, so
// the trails ride the field as every feedback image does). The fade runs on
// the frame's own clock, not the scene's motion, so marks die away and a
// hand can draw whether the strobe runs or not.
//
// Atlases. Each stroke names its Image set (the wire's a), so a mark from a
// screen on another set is still drawn with its own motifs: the layer keeps
// up to MAX_ATLASES sets' atlases on the GPU, each built from the set's
// sheet by the kaleidoscope's own pass (gpu/atlas-bake.js, the same bake
// the browser keeps for both): a set with a high resolution sheet (sets.mjs
// imageHi) is drawn from it while the kaleidoscope's High resolution toggle
// is on, as the kaleidoscope does, packed in its own layout, else the
// ordinary one. Loaded the first time a stamp or
// the drawer's picker asks for it. The picker's set (the current Image set)
// is never the one let go; the least recently used other one is. The
// current set's atlas is also the UI renderer's picture, which the picker's
// thumbnails sample (opts.picture), and its painted tiles are published in
// core/brush.js brushAtlas.
//
// Remote strokes are played out first (core/brush.js brushPlay): their
// stamps reach the ring as each one's playback cursor passes them, carrying
// their time on the sender's timeline mapped onto this clock; the hand's
// own carry the moment it made them. Every stamp, local or remote, goes
// into the trail on that one timeline, a delay after its time (the same
// delay remote play runs at), all senders' together in time order
// (core/brush-order.js bakeOrder: time, then the senders' turn this second,
// sender, seq), so where two hands overlap the one who drew later is on
// top, by the drawing and not by the network, and every screen bakes the
// same layering. Until its bake a stamp is drawn live over the trail each
// frame, in that same order, so the hand sees its mark at once and nothing
// on top changes when a stamp moves into the trail. A stamp bakes fresh,
// so it fades from its bake, a delay after it was drawn: under 100 ms of
// skew against fades of a second or more. At a Trail res under Full the
// trail is drawn smaller and stretched, so a stamp's live sprite is a
// little sharper than the same stamp in the trail a moment later. At most
// MAX_INST stamps are drawn a frame; a due stamp whose atlas is not in yet
// holds back later bakes (they draw live meanwhile), and a set that failed
// to load lets its stamps go. A held image (a frame with no step) bakes
// nothing and keeps them for the next.
//
// The image exists only while there is something in it: made for the first
// stamp, let go once it has faded to nothing (feedback.js says when, to the
// texel), so an idle brush costs no memory. Nothing is allocated per frame.
//
// The morph (core/brush-morph.js): every stamp drawn this frame, baked or
// live, any sender's, is drawn at the frame's morph, from its atlas tile
// (0) to a small glowing particle in that tile's average colour (1), in the
// same draw (brush.wgsl.js). Each atlas measures its tiles' colours as it
// is installed (atlas-bake.js tileTints) into its uniform buffer, once; the
// morph and the particles' brightness ride in the frame's uniforms and the
// tile in the instance's spare float.

import { S } from '../js/state.js';
import { BRUSH_WGSL } from './brush.wgsl.js';
import { createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT } from './feedback.js';
import { MOTIFS, LAYOUT_STD, LAYOUT_HI, bakeTag, bakeAtlasPixels, buildAtlasMips, tileTints } from './atlas-bake.js';
import { kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';
import { idleHold, idleRelease } from '../core/idle.js';
import { brushRotateNow, brushSpinNow, brushSharedOffset, brushSpinAt, brushQueue, brushQueueRemove, brushAtlas, brushHandAtlas, STAMP_FLOATS, brushPlay, brushPlaying, brushNow, brushPlayDelay } from '../core/brush.js';
import { fadeHalfLife, fieldSquare } from '../core/brush-stamps.js';
import { brushMorphNow, brushParticleBrightNow } from '../core/brush-morph.js';
import { noteSender, forgetIdle, activeSenders, bakeOrder, turnPlace } from '../core/brush-order.js';

// Stamps drawn a frame, baked and live together.
const MAX_INST = 8192;
// Stamps looked at a frame: the whole pending ring is sorted (it holds
// about a delay's worth), past this the youngest wait.
const MAX_PEND = 16384;
const INST_FLOATS = 8;             // x y half angle | u0 v0 tile light
const MAX_ATLASES = 3;
// An atlas's uniforms: the frame's eight floats (rewritten each frame), then
// its 64 tiles' tints as vec4s (written once, as it is installed).
const UNI_BYTES = 32, TINT_BYTES = MOTIFS * 16;

// The particles' light, shared out along a ribbon. A continuous stroke's
// stamps fall every spacing s (core/brush-stamps.js brushSpacing, its side
// over 20 and over Continuity), and each particle's glow reaches R, 0.3 of
// the side (brush.wgsl.js PART_REACH of the half side), so a point on the
// ribbon is lit by some 2R / s of them, a dozen at 1x and a hundred and
// twenty at 10x: added up as light, the ribbon went white whatever its
// colour or Particle brightness. So each stamp's light is its share: on the
// ribbon's line the glows sum to (R / s) GLOW_AREA times each one's light
// (GLOW_AREA the glow's integral across its reach, core plus halo,
// 0.533), and each is given RIBBON_LIGHT s / (R GLOW_AREA), so the ribbon
// at Particle brightness 100% stands at RIBBON_LIGHT of its colour at full
// brightness, at any Continuity and any size: its hue plain, its core
// bright but not white, a quarter as bright at 25%, and past white at 400%,
// where only the halo's edges keep the colour. A print (separate stamps,
// no spacing) or a sparse ribbon is a lone light: never more than
// LONE_LIGHT, a single particle's centre just under white. Only where
// different strokes cross does the light add up past the ribbon's.
export const RIBBON_LIGHT = 0.7, LONE_LIGHT = 0.6;
const GLOW_REACH = 0.3, GLOW_AREA = 0.5332;
// span: a stamp's spacing over its side (the ring's eighth float), 0 for a print.
export function particleLight(span) {
  if (!(span > 0)) return LONE_LIGHT;
  const k = RIBBON_LIGHT * span / (GLOW_REACH * GLOW_AREA);
  return k < LONE_LIGHT ? k : LONE_LIGHT;
}
// The frame's eight uniforms (BU.view, BU.lay in brush.wgsl.js), for an
// atlas laid out in L: the target's NDC scale, the morph, the particles'
// brightness, then the atlas's inner square and half texel.
export function packFrameUniforms(uni, pixelW, pixelH, L) {
  uni[0] = 2 / pixelW; uni[1] = 2 / pixelH; uni[2] = brushMorphNow(); uni[3] = brushParticleBrightNow();
  uni[4] = L.innerUV; uni[5] = L.halfTexel;
  return uni;
}
// A tile painting less than this share of its inner square is empty: the
// cut leaves a true blank at exactly 0, and a few stray texels are no shape.
const EMPTY_FILL = 0.002;

export function createBrush(device, format, platform, opts) {
  const picture = (opts && opts.picture) || null;
  const yieldFn = (opts && opts.yieldTile) || null;
  const yieldTile = () => (yieldFn ? yieldFn() : new Promise(r => setTimeout(r, 0)));

  let pixelW = 1, pixelH = 1, dpr = 1;
  let made = false, pipe = null, livePipe = null, bgl = null, sampler = null, instBuf = null, fb = null;
  const uni = new Float32Array(8);
  const inst = new Float32Array(MAX_INST * INST_FLOATS);
  // This frame's draws: runs of instances sharing one atlas.
  const runBind = new Array(MAX_INST).fill(null);
  const runFirst = new Int32Array(MAX_INST), runCount = new Int32Array(MAX_INST);
  let nRuns = 0, nInst = 0, fbOn = false;
  // Instances [0, nBake) go into the trail this frame (runs [0, bakeRuns)),
  // [nBake, nInst) are drawn live over it (the rest of the runs).
  let nBake = 0, bakeRuns = 0;
  // The pending ring as this frame sorts it: per stamp (its number from the
  // ring's head) its time, its turn place, its sender, its seq and its
  // atlas; the order; and which were baked (or let go, a failed set's), to
  // leave the ring once the trail has them.
  const pIdx = new Int32Array(MAX_PEND), pKey = new Float64Array(MAX_PEND), pPlace = new Float64Array(MAX_PEND);
  const pWho = new Float64Array(MAX_PEND), pSeq = new Float64Array(MAX_PEND), pAtlas = new Array(MAX_PEND).fill(null);
  const baked = new Uint8Array(65536);
  let bakedAny = false;
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
      lodMaxClamp: LAYOUT_HI.mips - 1
    });
    instBuf = device.createBuffer({ label: 'brush.instances', size: MAX_INST * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    // The live pass: the same stamps straight into the scene, over the
    // trail's composite, for the ones not yet baked (premultiplied over
    // here too, so a stamp looks the same live as baked).
    livePipe = device.createRenderPipeline({
      label: 'brush.stamp.live',
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
      fragment: { module: mod, entryPoint: 'fsStamp', targets: [{ format, blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }] },
      primitive: { topology: 'triangle-list' }
    });
    fb = createFeedback(device, format, { label: 'brush.feedback' });
  }

  function resize(pw, ph, d) {
    pixelW = Math.max(1, pw | 0); pixelH = Math.max(1, ph | 0); dpr = d || 1;
  }

  // ---------- the atlases ----------
  // set (the kaleidoscope's own numbering, as kaleidoscopeSet resolves it)
  // -> { set, url, lay, uniBuf, tex, view, bind, fill, first, ready, failed, used }
  // (lay: the layout its sheet is packed in; uniBuf: the stamp shader's
  // uniforms, whose atlas numbers are this layout's, and its tiles' tints)
  const atlases = new Map();
  let shown = null;            // the atlas published as the picker's

  function setOf(n) { return kaleidoscopeSet(n).id; }

  // The sheet a set is drawn from, as the kaleidoscope picks it.
  function sheetOf(def) {
    return S.kaleidoHiRes !== false && def.imageHi ? def.imageHi : def.image;
  }

  function release(a) {
    if (a === shown) { shown = null; if (picture) picture(null, 0); }
    if (a === shownHand) { shownHand = null; if (picture) picture(null, 1); }
    if (a.tex) a.tex.destroy();
    if (a.uniBuf) a.uniBuf.destroy();
    atlases.delete(a.set);
  }

  function load(set, plain) {
    const have = atlases.get(set);
    if (have) {
      // the High resolution toggle moved: this set is read again from the
      // other sheet (a hi sheet that failed has fallen back and stays)
      if (plain || have.url === sheetOf(kaleidoscopeSet(set)) || have.fellBack) return;
      release(have);
    }
    if (!platform || !platform.loadImagePixels) return;
    if (atlases.size >= MAX_ATLASES) evict(set);
    const def = kaleidoscopeSet(set), url = plain ? def.image : sheetOf(def);
    const L = def.imageHi && url === def.imageHi ? LAYOUT_HI : LAYOUT_STD;
    const a = { set, url, lay: L, uniBuf: null, tex: null, view: null, bind: null, fill: null, first: 0, ready: false, failed: false, fellBack: !!plain, used: frame };
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
        console.warn('brush: could not load the motif atlas ' + url + ':', err && err.message ? err.message : err);
        if (stale()) return;
        // a high resolution sheet that will not load gives way to the ordinary one
        if (url !== def.image) { release(a); load(set, true); } else a.failed = true;
      })
      .finally(() => idleRelease('the brush atlas'));
  }

  function install(a, baked) {
    if (!made) make();
    const L = a.lay;
    a.uniBuf = device.createBuffer({ label: 'brush.uniforms' + a.set, size: UNI_BYTES + TINT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // each tile's average colour, what its particle glows with (the morph)
    device.queue.writeBuffer(a.uniBuf, UNI_BYTES, tileTints(baked.out, L, new Float32Array(MOTIFS * 4)));
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
        { binding: 0, resource: { buffer: a.uniBuf } },
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
      if (a.set === cur || a.set === keep || a.set === head || a === shownHand) continue;
      if (!worst || a.used < worst.used) worst = a;
    }
    if (!worst) return;
    release(worst);
  }

  // The dealt hand's row has a picture of its own (the UI renderer's slot
  // 1): the atlas of the set it asked for this frame, once it is in.
  let shownHand = null;
  function publishHand(want) {
    const a = atlases.get(setOf(want));
    if (!a || !a.ready || a === shownHand) return;
    shownHand = a;
    const h = brushHandAtlas;
    h.set = a.set; h.padUV = a.lay.padUV; h.innerUV = a.lay.innerUV; h.ready = true;
    if (picture) picture(a.view, 1);
  }

  // The atlas asked for this frame (the drawer's picker wants the current
  // set), else the current set's, as the picker's, once it is in: its
  // painted tiles in sheet order and the picture the thumbnails sample.
  function publish(want) {
    const cur = want > 0 ? setOf(want) : setOf(S.kaleidoSet);
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
    b.count = n; b.set = cur; b.padUV = a.lay.padUV; b.innerUV = a.lay.innerUV; b.ready = true;
    if (picture) picture(a.view, 0);
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
    publish(want);
    const hw = brushHandAtlas.want;
    brushHandAtlas.want = 0;
    if (hw > 0) { const s = setOf(hw); load(s); const a = atlases.get(s); if (a) a.used = frame; publishHand(hw); }

    // The field's square in device px: where a unit point lands.
    fieldSquare(S.W || pixelW / dpr, S.H || pixelH / dpr, S.edgeInset || 0, sq);
    const cx = sq.cx * dpr, cy = sq.cy * dpr, side = sq.side * dpr;

    // The pending stamps, every sender's, in baking order (core/brush-
    // order.js): by time, then the senders' turn this second, sender, seq.
    // Those a delay old go into the trail, in that order; the younger are
    // drawn live over it, in that order too, so nothing on top changes as
    // a stamp moves from one to the other. A due stamp whose atlas is not in
    // yet holds back every later one's bake (they draw live meanwhile when
    // they can), and a set that failed to load lets its stamps go.
    nInst = 0; nRuns = 0; nBake = 0; bakeRuns = 0; bakedAny = false;
    const q = brushQueue, buf = q.buf;
    const n = q.count < MAX_PEND ? q.count : MAX_PEND;
    const sec = Math.floor(Date.now() / 1000);
    // the shape's turn: a speed, and the shared clock's lead over this one
    const spinRate = brushSpinNow(), spinOff = spinRate > 0 ? brushSharedOffset() : 0;
    if (n > 0) forgetIdle(sec);
    for (let j = 0; j < n; j++) {
      const at = (q.head + j) % q.cap, o = at * STAMP_FLOATS;
      const set = setOf(buf[o + 5]);
      let a = atlases.get(set);
      if (!a) { load(set); a = atlases.get(set); }
      pIdx[j] = j; pKey[j] = q.key[at]; pWho[j] = buf[o + 6]; pSeq[j] = q.seq[at]; pAtlas[j] = a || null;
      noteSender(pWho[j], sec);
    }
    for (let j = 0; j < n; j++) pPlace[j] = turnPlace(pWho[j], activeSenders.ids, activeSenders.n, sec);
    if (n > 1) bakeOrder(pIdx, n, pKey, pPlace, pWho, pSeq);
    const due = brushNow() - brushPlayDelay();
    let blocked = false, runAtlas = null;
    // two walks over the one order: what bakes, then what draws live
    for (let pass = 0; pass < 2; pass++) {
      runAtlas = null;
      for (let jj = 0; jj < n && nInst < MAX_INST; jj++) {
        const j = pIdx[jj], a = pAtlas[j];
        if (pass === 0) {
          if (blocked || pKey[j] > due) continue;
          if (a && a.failed) { baked[j] = 1; bakedAny = true; continue; }
          if (!a || !a.ready) { blocked = true; continue; }
        } else {
          if (baked[j] || !a || !a.ready || a.failed) continue;
        }
        a.used = frame;
        if (pass === 0) { baked[j] = 1; bakedAny = true; }
        if (a !== runAtlas) {
          runAtlas = a;
          runBind[nRuns] = a.bind; runFirst[nRuns] = nInst; runCount[nRuns] = 0; nRuns++;
        }
        const o = ((q.head + j) % q.cap) * STAMP_FLOATS;
        // An empty tile draws the set's first painted one, as the picker
        // shows it (a pick made before the atlas was known, or another set's).
        let m = buf[o + 4] | 0;
        if (m < 0 || m >= MOTIFS || !(a.fill[m] > EMPTY_FILL)) m = a.first;
        const i = nInst * INST_FLOATS;
        inst[i] = cx + (buf[o] - 0.5) * side;
        inst[i + 1] = cy + (buf[o + 1] - 0.5) * side;
        inst[i + 2] = buf[o + 3] * side * 0.5;
        inst[i + 3] = spinRate > 0 ? buf[o + 2] + brushSpinAt(spinRate, pKey[j], spinOff) : buf[o + 2];
        inst[i + 4] = (m % 8) / 8 + a.lay.padUV;
        inst[i + 5] = ((m / 8) | 0) / 8 + a.lay.padUV;
        inst[i + 6] = m; inst[i + 7] = particleLight(buf[o + 7]);
        runCount[nRuns - 1]++;
        nInst++;
      }
      if (pass === 0) { nBake = nInst; bakeRuns = nRuns; }
    }
    const take = n;
    lookedN = n;

    // The image: made for the first stamp, let go once faded to nothing.
    if (nInst > 0 && !made) make();
    if (!made) { fbOn = false; return; }
    if (nInst === 0 && fbOn && fb.view === null && fb.live) { fb.release(); fbOn = false; }
    if (nInst > 0) fbOn = true;
    if (!fbOn) { dropBaked(take); return; }
    fb.ensure(pixelW, pixelH, feedbackRes(S.fbResScale), feedbackKeep(S.fbResSwitch));
    params.keepHalfLife = fadeHalfLife(S.brushFade);
    params.twistRate = brushRotateNow() * Math.PI * 2;
    params.cx = cx; params.cy = cy; params.unit = side;
    params.dt = dt > 0 ? dt : 0;
    if (nInst > 0) {
      // every frame there is a stamp to draw, so a slider moved shows at once
      for (const a of atlases.values()) {
        if (!a.uniBuf) continue;
        device.queue.writeBuffer(a.uniBuf, 0, packFrameUniforms(uni, pixelW, pixelH, a.lay));
      }
      device.queue.writeBuffer(instBuf, 0, inst, 0, nInst * INST_FLOATS);
    }
  }
  // The stamps this frame baked (and a failed set's) leave the ring, once
  // the trail has them; n is how many were looked at.
  let lookedN = 0;
  function dropBaked(n) {
    if (bakedAny) brushQueueRemove(baked);
    for (let j = 0; j < n; j++) baked[j] = 0;
    bakedAny = false; lookedN = 0;
  }

  // Before the scene pass: the image faded and this frame's stamps drawn
  // into it. A held image (no step this frame) draws nothing and keeps the
  // stamps for the next.
  function encode(encoder) {
    if (!fbOn) return;
    const pass = fb.begin(encoder, params, nBake > 0);
    if (!pass) {
      // a held image takes nothing this frame: the due stamps stay in the
      // ring (but a failed set's, which go as nothing was drawn of them)
      if (nBake === 0) dropBaked(lookedN);
      else { for (let j = 0; j < lookedN; j++) baked[j] = 0; bakedAny = false; nBake = 0; bakeRuns = 0; }
      return;
    }
    if (nBake > 0) {
      pass.setPipeline(pipe);
      pass.setVertexBuffer(0, instBuf);
      for (let r = 0; r < bakeRuns; r++) {
        pass.setBindGroup(0, runBind[r]);
        pass.draw(6, runCount[r], 0, runFirst[r]);
      }
    }
    fb.end(pass);
    dropBaked(lookedN);
  }

  // Inside the scene pass: the trail, then the stamps not yet baked, live.
  function draw(pass) {
    if (!fbOn) return;
    fb.composite(pass, 1, 1);
    if (nInst > nBake) {
      pass.setPipeline(livePipe);
      pass.setVertexBuffer(0, instBuf);
      for (let r = bakeRuns; r < nRuns; r++) {
        pass.setBindGroup(0, runBind[r]);
        pass.draw(6, runCount[r], 0, runFirst[r]);
      }
    }
  }

  // Still moving by itself: marks fading, or stamps waiting for a frame.
  function busy() {
    return (fbOn && fb.view !== null) || (brushQueue.count > 0 && nInst > 0) || brushPlaying();
  }

  return { update, encode, draw, resize, busy };
}
