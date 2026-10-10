// Owns the Heartbeat layer's light: a flat, full-screen wash of warm red
// whose brightness is the heartbeat track's own loudness, read live from the
// sound as it plays (core/heartbeat.js), so the sound and the light are one
// signal. It reads S every frame and does no work at all while
// S.layers.heartbeat is off; nothing is made or fetched until it first
// comes on.
//
// The recipe is Robert's generator script's, kept to the letter:
//
//   envelope   the RMS of the mono signal over the generator's frame (1/30 s,
//              read fresh each render frame), held at its peak and let go
//              exponentially: env = max(rms, env * exp(-dt / 0.35))
//   normalise  e = clamp(env / HEART_NORM, 0, 1)
//   brightness b = 0.05 + 0.95 * e^0.85
//   colour     the peak (198, 44, 22) / 255 at the flat level HEART_K
//
// dt is the audio clock's step between reads, so the hold lets go at the
// sound's pace. The heard level (Master * Audio level) never reaches the
// analyser, so the light beats at any volume; the light's amount is
// Master * Visual amount * b.
//
// The wash draws the way the strobe field fills the screen (scene.js's
// full-screen triangle), straight after the field and before every other
// layer, so they all sit over it. It is light that adds: premultiplied,
// alpha 0, no gradient (the video's gradient is already averaged into K).
//
// Paused, the source stops once the scene has wound down (the motion scale
// at 0) and the light holds where the beat left it, so a still scene is one
// held frame and the loop may rest; the engine's sleep and the page going
// out of sight stop it too (doze), and the next frame awake starts it again
// from its place.
//
// Allocation per frame: none.

import { S } from '../js/state.js';
import { motionScale } from '../core/motion.js';
import {
  heartSync, heartRead, heartPause, heartArm, heartUnavailable, heartRms, heartDt
} from '../core/heartbeat.js';

// The 99.5th percentile of this exact track's peak-hold envelope
// (audio/heartbeat.m4a, the recipe above), precomputed by the generator:
// the level that reads as a full beat.
export const HEART_NORM = 0.507980;
// The flat level the generator's lifted gaussian averages to across the
// frame, precomputed: the whole screen at this share of the peak colour.
export const HEART_K = 0.8316;
// The peak hold's release, seconds.
const HEART_TAU = 0.35;
const PEAK_R = 198 / 255, PEAK_G = 44 / 255, PEAK_B = 22 / 255;

const HEART_WGSL = /* wgsl */`
struct HU { rgb: vec4f };
@group(0) @binding(0) var<uniform> u: HU;

@vertex
fn vsHeart(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

@fragment
fn fsHeart() -> @location(0) vec4f {
  return vec4f(u.rgb.rgb, 0.0);
}
`;

function clamp01(v, def) {
  if (typeof v !== 'number' || !(v === v)) return def;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

export function createHeartbeat(device, format) {
  // Made the first time the layer is on, never at boot.
  let pipe = null, uniBuf = null, bind = null;
  const uni = new Float32Array(4);
  function ensureGpu() {
    if (pipe) return;
    const mod = device.createShaderModule({ label: 'heartbeat.wgsl', code: HEART_WGSL });
    if (mod.getCompilationInfo) {
      mod.getCompilationInfo().then(info => {
        if (info.messages.some(m => m.type === 'error')) {
          console.warn('heartbeat.wgsl compile errors:', info.messages.map(m => m.message).join(' | '));
        }
      });
    }
    const bgl = device.createBindGroupLayout({
      label: 'heartbeat.bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
    });
    // Light that adds: the colour onto what is there, alpha left alone.
    const light = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' }
    };
    pipe = device.createRenderPipeline({
      label: 'heartbeat.wash',
      layout: device.createPipelineLayout({ label: 'heartbeat.layout', bindGroupLayouts: [bgl] }),
      vertex: { module: mod, entryPoint: 'vsHeart' },
      fragment: { module: mod, entryPoint: 'fsHeart', targets: [{ format, blend: light }] },
      primitive: { topology: 'triangle-list' }
    });
    uniBuf = device.createBuffer({
      label: 'heartbeat.uniforms', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    bind = device.createBindGroup({
      label: 'heartbeat.bind', layout: bgl,
      entries: [{ binding: 0, resource: { buffer: uniBuf } }]
    });
  }

  let wasOn = false, dozing = false, drawing = false;
  // The peak-hold envelope, and the wash's amount last written.
  let env = 0, lastAmt = -1;

  // t is the rAF timestamp (ms), dt seconds: unused, the envelope runs on
  // the audio clock (core/heartbeat.js heartRead).
  function update(t, dt) {
    drawing = false;
    const on = !!(S.layers && S.layers.heartbeat);
    if (!on) {
      if (wasOn) { wasOn = false; heartPause(); env = 0; }
      return;
    }
    if (!wasOn) { wasOn = true; heartArm(); }
    ensureGpu();

    const master = clamp01(S.heartMaster, 1);
    const audio = clamp01(S.heartAudio, 0.8);
    const visual = clamp01(S.heartVisual, 0.8);
    const playing = heartSync(!dozing && motionScale() > 0, master * audio);
    if (heartUnavailable()) return;
    if (playing) {
      heartRead();
      if (heartDt > 0) {
        const held = env * Math.exp(-heartDt / HEART_TAU);
        env = heartRms > held ? heartRms : held;
      }
    }
    let e = env / HEART_NORM;
    e = e < 0 ? 0 : (e > 1 ? 1 : e);
    const b = 0.05 + 0.95 * Math.pow(e, 0.85);
    const amt = master * visual * b * HEART_K;
    if (!(amt > 0.0005)) return;
    drawing = true;
    if (amt !== lastAmt) {
      lastAmt = amt;
      uni[0] = PEAK_R * amt; uni[1] = PEAK_G * amt; uni[2] = PEAK_B * amt; uni[3] = 0;
      device.queue.writeBuffer(uniBuf, 0, uni);
    }
  }

  // Inside the scene pass, straight after the field (engine.js drawScene).
  function draw(pass) {
    if (!drawing) return;
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.draw(3);
  }

  // The engine's sleep, and the page out of sight: the sound stops at once
  // (no frame may follow to stop it). Awake again, the next update starts it
  // if it should play, and may ask the context to resume.
  function doze(on) {
    dozing = !!on;
    if (dozing) heartPause();
    else heartArm();
  }

  return { update, draw, doze };
}
