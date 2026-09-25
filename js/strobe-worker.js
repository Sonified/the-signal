// The strobe, on a thread of its own.
//
// Everything the browser offers for making one piece of work more important
// than another is about network requests and scheduled tasks. There is no knob
// that says "this canvas present matters more than that style recalc": the
// main thread runs one thing at a time, in order, and whatever is in front of
// the frame delays the frame. The only real lever is to stop asking the main
// thread to produce the frame at all.
//
// So this worker owns phase, the frame lock, the simulation and the draw, and
// drives them from its own requestAnimationFrame. It still shares vsync with
// the compositor, so the cadence is the same; what changes is that a mixer
// drag, a style recalc or a localStorage write on the other thread cannot get
// in front of a present, even in principle.
//
// It imports the same modules the main thread does. A worker has its own
// module graph, so state.js gives it a second S, unrelated to the one the UI
// writes. That is the whole trick: sim.js and canvas2d.js run here completely
// unchanged, reading the S they always read, and the UI's settings arrive as
// snapshots that are copied onto it.
import { S, layers, WALK_STEP, WALK_DAMP, WALK_SWING } from './state.js';
import { shape, hslToRgb } from './util.js';
import { bandHue } from './color.js';
import { seedParticles, seedTunnel, applyEdgeDir, updateRings, updateParticles } from './sim.js';
import { initCanvas2D, invalidateGradients } from './renderers/canvas2d.js';
import { guard, guardStep, guardSimulate, guardReset } from './panel-guard.js';

let canvas = null, renderer = null;
let wasRunning = false;
let sinceDiag = 0;

// The main thread cannot resize a canvas it has handed over, so the surface is
// sized here from the same three numbers it would have used.
function resizeSurface() {
  if (!canvas) return;
  const wd = Math.max(1, Math.round(S.W * S.DPR)), hd = Math.max(1, Math.round(S.H * S.DPR));
  if (canvas.width !== wd || canvas.height !== hd) { canvas.width = wd; canvas.height = hd; }
  // A size change resets the context, transform included, so it is restated
  // rather than assumed. Doing it every time costs nothing and removes the
  // question of ordering entirely.
  if (S.ctx) S.ctx.setTransform(S.DPR, 0, 0, S.DPR, 0, 0);
}

// Settings arrive as a plain slice of the UI's S and are copied onto this one.
// Two of the keys are not simple assignments: `layers` has to be written into
// the existing object because canvas2d.js holds a live reference to it, and
// `rgb` is written element-wise for the same reason.
function apply(s) {
  const hadCount = S.edgeCount, hadDir = S.edgeDir;
  for (const k in s) {
    if (k === 'layers') Object.assign(layers, s.layers);
    else if (k === 'rgb') { S.rgb[0] = s.rgb[0]; S.rgb[1] = s.rgb[1]; S.rgb[2] = s.rgb[2]; }
    else S[k] = s[k];
  }
  // The edge stream is rebuilt rather than reseeded on a direction change, so
  // the two cases are not the same call.
  if (S.edgeCount !== hadCount) seedParticles(S.edgeCount);
  else if (S.edgeDir !== hadDir) applyEdgeDir();
  resizeSurface();
  // A snapshot only arrives when something in the drawer moved, so this is a
  // handful of times a second at worst and always in response to a change that
  // could have been the colour or the geometry the gradients were built from.
  invalidateGradients();
}

function tick(t) {
  requestAnimationFrame(tick);

  if (S.lastT === null) S.lastT = t;
  let dt = (t - S.lastT)/1000; S.lastT = t;

  // Frame health, measured where the frames are actually produced. The same
  // numbers taken on the main thread only ever described how often the main
  // thread woke up, which is a different question now.
  if (dt > 0 && dt < 0.25) {
    S.intervals.push(dt*1000);
    if (S.intervals.length > 180) S.intervals.shift();
    if (S.refreshHz) {
      const expected = 1000/S.refreshHz;
      if (dt*1000 > expected*1.5) S.dropCount++;
    }
  }

  S.frameTimes.push(t);
  if (S.frameTimes.length > 60) {
    const span = (S.frameTimes[S.frameTimes.length-1] - S.frameTimes[0]) / 1000;
    S.refreshHz = (S.frameTimes.length-1) / span;
    S.frameTimes = S.frameTimes.slice(-30);
  }

  if (dt > 0.25) dt = 0;          // tab-switch guard

  // The first press seeds the tunnel, the same as the main-thread path does.
  // Done on the transition rather than every frame so a session that has run
  // its rings down to nothing does not silently refill.
  if (S.running && !wasRunning && !S.rings.length) seedTunnel(16);
  wasRunning = S.running;

  S.lastPhase = S.phase;
  if (S.running) { S.driftPhase += dt / S.driftPeriod; S.driftPhase -= Math.floor(S.driftPhase); }
  S.effFreq = S.freqDrift
    ? Math.max(0.1, S.freq + S.freqDrift * Math.sin(2*Math.PI*S.driftPhase))
    : Math.max(0.1, S.freq);

  if (S.running) {
    if (S.frameLock && S.refreshHz > 0) {
      const fpc = Math.max(2, Math.round(S.refreshHz / S.effFreq));
      if (fpc !== S.framesPerCycle) { S.framesPerCycle = fpc; S.frameIdx = 0; }
      S.achievedFreq = S.refreshHz / S.framesPerCycle;
      // an integer counter, not an accumulator: adding 1/3 repeatedly drifts
      // in floating point and the cycle boundary lands on a different frame
      S.frameIdx = (S.frameIdx + 1) % S.framesPerCycle;
      S.phase = S.frameIdx / S.framesPerCycle;
      // An odd frame count cannot split evenly, so the spare frame goes the
      // way S.spareMode says. Same lines as main.js; keep the two together.
      const spareLit = S.spareMode !== 'dark';
      S.duty = (fpc % 2) ? (Math.floor(fpc / 2) + (spareLit ? 0.01 : -0.01)) / fpc : 0.5;
    } else {
      S.framesPerCycle = 0;
      S.achievedFreq   = S.effFreq;
      S.phase += S.effFreq*dt;
    }
    S.phase -= Math.floor(S.phase);
    S.varPhase += (dt / S.varPeriod); S.varPhase -= Math.floor(S.varPhase);
  }
  // 0 at the top of the cycle, so depth starts at its full set value
  S.effDepth = S.depthVar
    ? S.depth * (1 - S.depthVar * 0.5 * (1 - Math.cos(2*Math.PI*S.varPhase)))
    : S.depth;

  if (S.running) {
    S.brightVarPhase  += (dt / S.brightVarPeriod); S.brightVarPhase  -= Math.floor(S.brightVarPhase);
    S.ringBrightPhase += (dt / S.ringBrightPeriod); S.ringBrightPhase -= Math.floor(S.ringBrightPhase);
  }
  S.effBright = S.brightVar
    ? S.bright * (1 - S.brightVar * 0.5 * (1 - Math.cos(2*Math.PI*S.brightVarPhase)))
    : S.bright;

  if (S.running) {
    S.edgeSpeedVarPhase += dt / S.edgeSpeedVarPeriod; S.edgeSpeedVarPhase -= Math.floor(S.edgeSpeedVarPhase);
    S.edgeSizeVarPhase  += dt / S.edgeSizeVarPeriod;  S.edgeSizeVarPhase  -= Math.floor(S.edgeSizeVarPhase);
  }
  S.effEdgeSpeed = S.edgeSpeedVar
    ? S.edgeSpeedMul * (1 - S.edgeSpeedVar * 0.5*(1 - Math.cos(2*Math.PI*S.edgeSpeedVarPhase)))
    : S.edgeSpeedMul;
  S.effEdgeSize = S.edgeSizeVar
    ? S.edgeSize * (1 - S.edgeSizeVar * 0.5*(1 - Math.cos(2*Math.PI*S.edgeSizeVarPhase)))
    : S.edgeSize;

  S.effRingBright = S.ringBrightVar
    ? S.bright * (1 - S.ringBrightVar * 0.5 * (1 - Math.cos(2*Math.PI*S.ringBrightPhase)))
    : S.bright;

  if (S.perElementColor && S.colorWalk > 0 && S.running) {
    for (let i = 0; i < 4; i++) {
      S.cornerHv[i] += (Math.random() - 0.5) * WALK_STEP * dt;
      S.cornerHv[i] *= WALK_DAMP;
      if (S.cornerHv[i] >  1) S.cornerHv[i] =  1;
      if (S.cornerHv[i] < -1) S.cornerHv[i] = -1;
      S.cornerHue[i] += (1 + S.cornerHv[i] * WALK_SWING) * S.colorWalk * dt / S.walkPeriod;
      S.cornerHue[i] -= Math.floor(S.cornerHue[i]);
    }
  }
  if (S.colorWalk > 0 && S.running) {
    S.hueVel += (Math.random() - 0.5) * WALK_STEP * dt;
    S.hueVel *= WALK_DAMP;
    if (S.hueVel >  1) S.hueVel =  1;
    if (S.hueVel < -1) S.hueVel = -1;
    S.hue += (1 + S.hueVel * WALK_SWING) * S.colorWalk * dt / S.walkPeriod;
    S.hue -= Math.floor(S.hue);
    const c = hslToRgb(bandHue(S.hue), S.hueSat, S.hueLight);   // lightness held, so apparent brightness is steady
    S.rgb[0] = c[0]; S.rgb[1] = c[1]; S.rgb[2] = c[2];
  }

  const lum = S.running ? shape(S.phase) : 0;
  if (S.running) { S.litLog.push(lum > 0.5 ? 1 : 0); if (S.litLog.length > 120) S.litLog.shift(); }

  // The panel guard (js/panel-guard.js) watches the level this frame shows.
  // A trip is reported once and latches; the main thread stops the session
  // through its own toggle, which reaches here as running = false.
  if (guardStep(t, lum)) {
    self.postMessage({
      t: 'guard', hz: guard.tripHz, freq: guard.tripFreq, achieved: guard.tripAchieved,
      fpc: guard.tripFpc, lock: guard.tripLock, imbalance: guard.tripImbalance
    });
  }

  updateRings(dt, t/1000);
  updateParticles(dt);

  if (renderer) renderer.draw(lum);

  // Sent after the draw, never before it. The word layer needs the cycle wrap
  // and the current colour, and the audio's AM link needs the drifted
  // frequency; all three are three numbers, and the colour is packed into one
  // integer so the other side can unpack it into the array it already has
  // rather than take delivery of a new one 120 times a second.
  self.postMessage({
    t: 'frame',
    phase: S.phase, lastPhase: S.lastPhase, effFreq: S.effFreq,
    rgb: (S.rgb[0] << 16) | (S.rgb[1] << 8) | S.rgb[2]
  });

  // The diagnostics are a readout, not a signal, so they go over about four
  // times a second rather than with every frame.
  if (++sinceDiag >= 30) {
    sinceDiag = 0;
    self.postMessage({
      t: 'diag',
      refreshHz: S.refreshHz, dropCount: S.dropCount, duty: S.duty,
      achievedFreq: S.achievedFreq, framesPerCycle: S.framesPerCycle,
      intervals: S.intervals.slice(), litLog: S.litLog.slice(),
      imbalance: guard.imbalance
    });
  }
}

self.onmessage = e => {
  const m = e.data;
  if (m.t === 'init') {
    canvas = m.canvas;
    apply(m.state);
    renderer = initCanvas2D(canvas);
    seedParticles(S.edgeCount);
    applyEdgeDir();
    self.postMessage({ t: 'started', name: renderer ? renderer.name : null });
    requestAnimationFrame(tick);
  } else if (m.t === 'state') {
    apply(m.state);
  } else if (m.t === 'guardSim') {
    guardSimulate(m.hz);
  } else if (m.t === 'displayReset') {
    // The window is on another screen (js/main.js's display tripwire). What
    // was measured here describes the old one, so it all starts again.
    S.frameTimes.length = 0;
    S.refreshHz = 0;
    S.framesPerCycle = 0;
    S.frameIdx = 0;
    S.lastT = null;
    guardReset();
  } else if (m.t === 'inset') {
    // Its own message because it changes on every frame of the drawer
    // animation and carries nothing else with it.
    S.edgeInset = m.edgeInset;
  }
};

// Sent at module evaluation, before the canvas has been handed over. The main
// thread waits for it, because a module worker that fails to load reports the
// failure asynchronously, and by then a canvas transferred optimistically
// would already be gone and the fallback path would have nothing to draw on.
self.postMessage({ t: 'hello' });
