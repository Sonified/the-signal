// node --experimental-vm-modules tools/slide-speed.test.mjs
// Exercise the actual Slides update loop with isolated video/GPU objects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../gpu/slides.js', import.meta.url), 'utf8');
const noop = () => {};
async function setup(extra = {}) {
  const S = { layers: { slides: true }, slideFile: 'test.mp4', slideRate: 1,
    slidePlay: true, slideXfade: 0, slidePpIn: 0, slidePpOut: 0,
    slidePpRamp: false, slideVolume: 1, volume: 1, ...extra };
  const videos = [];
  class Video {
    paused = true; ended = false; seeking = false; readyState = 2;
    videoWidth = 320; videoHeight = 180; duration = 120; currentTime = 0;
    playbackRate = 1; defaultPlaybackRate = 1; volume = 1;
    addEventListener() {}
    play() { this.paused = false; }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() { this.src = ''; }
  }
  const ctx = vm.createContext({ console,
    GPUShaderStage: { FRAGMENT: 1 }, GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2 },
    document: { createElement() { const el = new Video(); videos.push(el); return el; } },
    navigator: { userActivation: { hasBeenActive: false } },
    window: { addEventListener: noop, removeEventListener: noop } });
  const values = { S, idleHold: noop, idleRelease: noop, idleWake: noop,
    SLIDE_DIR: '/slides/', SLIDE_NONE: 'None', slideVolOf: () => 1, slideVolGain: v => v,
    createGlobalFilter: noop, ensureAudioGraph: noop, getContext: () => null, getOutputBus: () => null };
  const mod = new vm.SourceTextModule(source, { context: ctx });
  const imports = new Map([...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
    .map(m => [m[2], m[1].split(',').map(v => v.trim())]));
  await mod.link(spec => new vm.SyntheticModule(imports.get(spec), function () {
    for (const name of imports.get(spec)) this.setExport(name, values[name]);
  }, { context: ctx }));
  await mod.evaluate();
  const device = { createBindGroupLayout: () => ({}), createShaderModule: () => ({}),
    createPipelineLayout: () => ({}), createRenderPipeline: () => ({}), createSampler: () => ({}),
    createBuffer: () => ({}), createBindGroup: () => ({}), importExternalTexture: () => ({}),
    queue: { writeBuffer: noop } };
  const layer = mod.namespace.createSlides(device, 'rgba8unorm');
  layer.update(0);
  return { S, layer, video: videos[0], videos, api: mod.namespace };
}
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < .0011, `${message}: ${actual} vs ${expected}`);

const { S, layer, video, api } = await setup();
S.slideRate = 2;
layer.update(25);
near(video.playbackRate, 2 - Math.exp(-1), 'One 25ms time constant reaches 63.2%');
assert.equal(S.slideRate, 2, 'The authored/displayed target stays unchanged');
near(api.slidesProgress().r, video.playbackRate, 'The iPad receives the actual smoothed speed');
layer.update(75);
near(video.playbackRate, 2 - Math.exp(-3), 'Three time constants reach 95%');
const reached = video.playbackRate;
S.slideRate = .5;
layer.update(85);
near(video.playbackRate, .5 + (reached - .5) * Math.exp(-10 / 25), 'A new packet retargets from the speed reached');

for (const ticks of [[25, 50, 75], [10, 27, 30, 75], [1000 / 60, 2000 / 60, 50, 200 / 3, 75]]) {
  const run = await setup();
  run.S.slideRate = .25;
  for (const t of ticks) run.layer.update(t);
  near(run.video.playbackRate, .25 + .75 * Math.exp(-3), 'Elapsed time governs smoothing across different frame cadences');
}

const paused = await setup({ slidePlay: false });
paused.S.slideRate = 2;
paused.layer.update(1000);
assert(paused.video.playbackRate > 1 && paused.video.playbackRate < 1.9, 'A paused wake must not consume the entire idle interval');
assert(paused.layer.busy(), 'The frame loop stays awake while paused speed settles');
for (let t = 1025; t <= 1300; t += 25) paused.layer.update(t);
near(paused.video.playbackRate, 2, 'Paused speed reaches its target');
assert.equal(paused.layer.busy(), false, 'Settled paused playback can rest');
assert.equal(paused.video.paused, true);

const stopped = await setup();
stopped.S.slideRate = 0;
for (let t = 25; t <= 400; t += 25) stopped.layer.update(t);
assert.equal(stopped.video.playbackRate, 0, 'Exponential decay must reach an exact silent stop');
stopped.S.slideRate = 1;
stopped.layer.update(425);
assert(stopped.video.playbackRate > 0 && stopped.video.playbackRate < 1, 'Speed resumes through the same exponential curve');

S.slideRate = .25; S.slideFile = 'next.mp4'; layer.update(100);
assert.equal(video.playbackRate, .25, 'A new cue starts at its own configured speed');
assert.equal(video.defaultPlaybackRate, .25);

console.log('PASS: 25ms exponential speed, packet retargeting, frame cadences, target/readout isolation, paused settling, zero/resume, and cue initialization.');
