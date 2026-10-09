// node tools/kaleido-continuity.test.mjs
// CPU regression: runs the actual pool and instance builder, with a fake GPU
// and synthetic atlas coverage. GPU/real-atlas proof is in kaleido-continuity.html.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { S } from '../js/state.js';
import { radialFade, radialFadeIn, RADIAL_FADE_OUT_K } from '../core/fade.js';
import { motionStep } from '../core/motion.js';
import { scaledStrobeDepth } from '../js/strobe-scale.js';
import { kaleidoscopeSet } from '../assets/kaleidoscope/sets.mjs';
import { createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT } from '../gpu/feedback.js';
import { roomPhase, roomPhaseState } from '../core/room-clock.js';
import { instrumentKaleido, liveSettings, seededRandom, orderFlips } from './kaleido-continuity-harness.mjs';

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4 };
globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 };
const device = {
  createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
  createShaderModule: () => ({}), createRenderPipeline: () => ({}),
  createBuffer: () => ({}), createSampler: () => ({}), createBindGroup: () => ({}),
  createTexture: () => ({ createView: () => ({}), destroy() {} }),
  queue: { writeBuffer() {} }
};
const source = await readFile(new URL('../gpu/kaleido.js', import.meta.url), 'utf8');
const nativeRandom = Math.random;
function run(reference) {
  Object.assign(S, liveSettings);
  Math.random = seededRandom();
  const { createKaleido } = new Function('S', 'scaledStrobeDepth', 'KALEIDO_WGSL', 'MIP_WGSL',
    'radialFade', 'radialFadeIn', 'RADIAL_FADE_OUT_K', 'motionStep', 'kaleidoscopeSet',
    'createFeedback', 'feedbackRes', 'feedbackKeep', 'FEEDBACK_FORMAT', 'roomPhase', 'roomPhaseState',
    instrumentKaleido(source, reference))(S, scaledStrobeDepth, '', '', radialFade,
      radialFadeIn, RADIAL_FADE_OUT_K, motionStep, kaleidoscopeSet,
      createFeedback, feedbackRes, feedbackKeep, FEEDBACK_FORMAT, roomPhase, roomPhaseState);
  const layer = createKaleido(device, 'rgba8unorm', null);
  layer.test.init(); layer.resize(S.W * 2, S.H * 2, 2);
  let previous = [], flips = 0, allFlips = 0, births = 0, retires = 0;
  const seen = new Set();
  let previousLive;
  // Three minutes at the actual live speed includes several complete flights.
  for (let frame = 0; frame < 10800; frame++) {
    layer.update(frame * 1000 / 60, 1 / 60, 1);
    const snapshot = layer.test.snapshot();
    const rows = snapshot.instances;
    flips += orderFlips(previous, rows).length;
    const rank = new Map(previous.map((p, n) => [p.id, n]));
    let maxRank = -1;
    for (const row of rows) {
      if (!seen.has(row.id)) { seen.add(row.id); births++; }
      if (rank.has(row.id)) {
        if (rank.get(row.id) < maxRank) allFlips++;
        maxRank = Math.max(maxRank, rank.get(row.id));
      }
      assert.ok(row.values.every(Number.isFinite));
      assert.ok(row.values[3] >= 0 && row.values[3] <= 1);
    }
    if (previousLive !== undefined) retires += Math.max(0, previousLive - snapshot.live);
    previousLive = snapshot.live;
    previous = rows;
  }
  return { overlappingOpaqueFlips: flips, orderInversions: allFlips, distinctDrawnLives: births, retirementFramesCounted: retires };
}
try {
  const reference = run(true), fixed = run(false);
  assert.ok(reference.overlappingOpaqueFlips > 0, 'Reference must reproduce opaque overlap swaps');
  assert.equal(fixed.orderInversions, 0, 'Continuing pieces must preserve relative paint order');
  assert.equal(fixed.overlappingOpaqueFlips, 0);
  assert.ok(fixed.distinctDrawnLives > 20, 'Exercise births and reused pool slots');
  assert.ok(fixed.retirementFramesCounted > 0, 'Exercise retirement');
  console.log(JSON.stringify({ simulatedSeconds: 180, reference, fixed }, null, 2));
} finally { Math.random = nativeRandom; }
