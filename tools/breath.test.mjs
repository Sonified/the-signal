// The sun's breath as a formula of time (core/breath.js), proven against the
// frame accumulator it replaces (gpu/sun.js stepped breathPh += md x rate /
// 60, md the motion's step from core/motion.js) and against the failures
// that forced it:
//
//   node tools/breath.test.mjs
//
// 1. Frame-rate independence: the writer driven at 240 fps, at 30 fps and
//    not at all lands on the same phase, and reading the formula 2400 times
//    over ten seconds changes nothing a single read at the end would not
//    give. The accumulator's answer depended on the frames it was shown.
// 2. A telescoped glide (a preset gliding the rate, one fold a frame) keeps
//    the phase continuous at every fold, and tracks the glided rate's
//    integral.
// 3. The pause: the real core/motion.js wind-down, with the writer folding
//    as main.js does, eases the breath's rate to exactly 0 and holds it at
//    the limit of the old easing (the phase at the pause plus rate x T / 3,
//    the integral of (1 - u)^2), which the old accumulator reaches as its
//    frames shrink; a resume carries on from the held phase. A stop for
//    safety, and a rate moved mid-wind-down, stay continuous too.
// 4. The Breath drawer's gauge (S.effSunBreathPos, S.effSunBreathIn) and
//    the accumulator agree within float noise over a simulated minute of
//    running at 60 fps, from the same start.
// 5. Worker mode: a copy unpacked from the packed state reads the same
//    breath at every moment.
// 6. The voices' read (breathHeardAt, which js/choir.js and js/piano.js
//    call on their own ticks in place of the frame's gauge): on the page's
//    copy, unpacked from the link, it gives the writer's own position, and
//    at the call sites' variedBy it plays what the gauge played with the
//    layer on; with the Sun layer off it is undefined, the gauge's own
//    value then, so a breath-linked choir and drone hold their settings
//    exactly as before, though the breath now keeps time with the layer off.

const B = await import('../core/breath.js');
const { S } = await import('../js/state.js');
const motion = await import('../core/motion.js');
const { variedBy } = await import('../core/variance.js');

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : ' (' + detail + ')'));
};
// the shortest way round the circle between two phases, in cycles
const gap = (a, b) => { let e = a - b; e -= Math.round(e); return Math.abs(e); };

const T0 = 1.7e12;           // an absolute anchor, ms, as the shared clock reads
const RATE = B.breathHz(5.5);
// Float noise on that clock: a double near 1.7e12 ms resolves a quarter of
// a microsecond, a few hundred-millionths of a breath per reading, so a
// millionth of a cycle is noise many times over and a thousandth of a frame.
const NOISE = 1e-6;

// A writer frame as main.js runs it: the motion's tick, then the steer.
function frame(s, t, dt, bpm) {
  motion.motionTick(dt);
  B.steerBreath(s, t, B.breathHz(bpm), S.running, motion.motionScale(), S.pauseWindDown);
}
function fresh() {
  S.running = false; S.pauseWindDown = 1;
  motion.motionHalt();
  return B.sunBreathState();
}

// ---- 1: frame-rate independence ----
{
  const runAt = fps => {
    const s = fresh();
    S.running = true;
    const dt = 1 / fps;
    for (let i = 0; i <= 10 * fps; i++) frame(s, T0 + i * dt * 1000, i ? dt : 0, 5.5);
    return B.breathPhaseAt(s, T0 + 10000);
  };
  const p240 = runAt(240), p30 = runAt(30);
  const one = fresh();
  S.running = true;
  frame(one, T0, 0, 5.5);
  const pOne = B.breathPhaseAt(one, T0 + 10000);
  const exact = (10 * RATE) % 1;
  ok('the writer at 240 fps and at 30 fps lands on one phase', gap(p240, p30) < 1e-12, 'gap ' + gap(p240, p30));
  ok('and on the phase of no frames at all', gap(p240, pOne) < 1e-12, 'gap ' + gap(p240, pOne));
  ok('which is rate x 10 s exactly', gap(pOne, exact) < 1e-12, 'gap ' + gap(pOne, exact));
  let g = 0;
  for (let i = 0; i <= 2400; i++) B.breathPhaseAt(one, T0 + i * 10000 / 2400);
  g = gap(B.breathPhaseAt(one, T0 + 10000), pOne);
  ok('reading it 2400 times over ten seconds moves nothing', g === 0, 'gap ' + g);
  ok('a steady breath is folded once, never again', one.gen === 1, 'gen ' + one.gen);

  // the accumulator it replaces did depend on its frames: two seconds of a
  // hidden tab inside the 240 fps run (no frames, then one the engine's
  // wake rule zeroes) lose the time outright, where the formula has it
  let acc = 0;
  for (let i = 1; i <= 10 * 240; i++) {
    if (i > 1200 && i < 1680) continue;     // hidden: no frames at all
    acc += (i === 1680 ? 0 : 1 / 240) * RATE;
  }
  ok('(the accumulator, shown a hidden tab, falls two seconds behind)', Math.abs(gap(acc % 1, pOne) - 2 * RATE) < 1e-9, 'gap ' + gap(acc % 1, pOne));
}

// ---- 2: a telescoped glide ----
{
  const s = fresh();
  S.running = true;
  const dt = 1 / 60;
  let worstJump = 0, integ = 0, worstTrack = 0;
  frame(s, T0, 0, 5.5);
  const p0 = B.breathPhaseAt(s, T0);
  let bpm = 5.5;
  for (let i = 1; i <= 240; i++) {
    const t = T0 + i * dt * 1000;
    // the rate this frame's interval ran at (the last fold's) goes into
    // the integral before the new one lands
    integ += B.breathRateAt(s, t - 1) * dt;
    bpm = i <= 120 ? 5.5 + (12 - 5.5) * i / 120 : 12;
    const before = B.breathPhaseAt(s, t);
    frame(s, t, dt, bpm);
    const after = B.breathPhaseAt(s, t);
    worstJump = Math.max(worstJump, gap(before, after));
    worstTrack = Math.max(worstTrack, gap(after, (p0 + integ) % 1));
  }
  ok('a glide folded every frame never jumps the phase', worstJump < 1e-12, 'worst ' + worstJump);
  ok('and tracks the glided rate\'s integral', worstTrack < NOISE, 'worst ' + worstTrack);
  ok('one fold a frame while the rate moves, none after', s.gen === 121, 'gen ' + s.gen);
  ok('landing at 12 breaths a minute', Math.abs(B.breathRateAt(s, T0 + 5000) - 12 / 60) < 1e-15);
}

// ---- 3: the pause ----
// The old accumulator through a pause: the motion's own tick and step,
// frame by frame, as gpu/sun.js stepped breathPh.
function accumulatorHeld(fps, windS) {
  S.running = false; S.pauseWindDown = windS;
  motion.motionHalt();
  S.running = true; motion.motionTick(0);
  S.running = false;
  let ph = 0;
  const dt = 1 / fps;
  for (let i = 0; i < Math.ceil((windS + 1) * fps); i++) {
    motion.motionTick(dt);
    ph += motion.motionStep(dt) * RATE;
  }
  return ph;
}
for (const windS of [1, 2.5, 5]) {
  const limit = RATE * windS / 3;
  const s = fresh();
  S.pauseWindDown = windS;
  S.running = true;
  frame(s, T0, 0, 5.5);
  const pPause = B.breathPhaseAt(s, T0);
  // paused on the next frame, then frames at 60 fps through the wind-down
  S.running = false;
  const dt = 1 / 60;
  let worstJump = 0, t = T0;
  for (let i = 1; i <= Math.ceil((windS + 1) * 60); i++) {
    t = T0 + i * dt * 1000;
    const before = B.breathPhaseAt(s, t);
    frame(s, t, dt, 5.5);
    worstJump = Math.max(worstJump, gap(before, B.breathPhaseAt(s, t)));
  }
  const held = B.breathPhaseAt(s, t);
  ok('wind-down ' + windS + ' s: every fold continuous', worstJump < 1e-12, 'worst ' + worstJump);
  ok('wind-down ' + windS + ' s: the rate lands at exactly 0', B.breathRateAt(s, t) === 0 && s.mode === B.BREATH_STOP);
  // within a frame's worth of the continuous limit (the pause lands on a
  // frame), as the accumulator itself is
  ok('wind-down ' + windS + ' s: held at the limit of the old easing', gap(held, (pPause + limit) % 1) < RATE / 60,
    'gap ' + gap(held, (pPause + limit) % 1));
  const acc240 = accumulatorHeld(240, windS), acc10k = accumulatorHeld(10000, windS);
  ok('wind-down ' + windS + ' s: the accumulator reaches the same limit as its frames shrink',
    Math.abs(acc10k - limit) < Math.abs(acc240 - limit) && Math.abs(acc10k - limit) < 1e-5,
    '240 fps ' + (acc240 - limit).toExponential(2) + ', 10 kHz ' + (acc10k - limit).toExponential(2));
  // the formula's own ease, read straight: r0 dur / 3 past its end
  const e = B.sunBreathState();
  B.retimeBreath(e, T0, RATE, windS);
  ok('wind-down ' + windS + ' s: the ease alone holds rate x T / 3 exactly',
    gap(B.breathPhaseAt(e, T0 + windS * 1000), limit % 1) < 1e-12 &&
    B.breathPhaseAt(e, T0 + windS * 1000) === B.breathPhaseAt(e, T0 + windS * 1000 + 60000));
  // still for a minute, with no frames at all
  ok('wind-down ' + windS + ' s: held still a minute later, frames or none',
    B.breathPhaseAt(s, t + 60000) === held);
  // resume: from the held phase at once, at the full rate
  S.running = true;
  const tr = t + 30000;
  frame(s, tr, 0, 5.5);
  ok('wind-down ' + windS + ' s: a resume carries on from where it held',
    B.breathPhaseAt(s, tr) === held && B.breathRateAt(s, tr + 1) === RATE);
}
{
  // a safety stop mid-wind-down: rate 0 at once, no jump
  const s = fresh();
  S.running = true; frame(s, T0, 0, 5.5);
  S.running = false;
  const dt = 1 / 60;
  for (let i = 1; i <= 20; i++) frame(s, T0 + i * dt * 1000, dt, 5.5);
  const t = T0 + 21 * dt * 1000, before = B.breathPhaseAt(s, t);
  motion.motionHalt();
  frame(s, t, dt, 5.5);
  ok('a safety stop mid-wind-down halts at once without a jump',
    gap(before, B.breathPhaseAt(s, t)) < 1e-12 && B.breathRateAt(s, t + 1) === 0);
  // a rate moved mid-wind-down: a fresh ease from the motion's scale, its
  // end where the motion's is
  const s2 = fresh();
  S.pauseWindDown = 2;
  S.running = true; frame(s2, T0, 0, 5.5);
  S.running = false;
  let tt = T0;
  for (let i = 1; i <= 60; i++) { tt = T0 + i * dt * 1000; frame(s2, tt, dt, 5.5); }
  const b2 = B.breathPhaseAt(s2, tt + dt * 1000);
  tt += dt * 1000; frame(s2, tt, dt, 9);
  const left = s2.dur, scale = motion.motionScale();
  ok('a rate moved mid-wind-down folds continuously',
    gap(b2, B.breathPhaseAt(s2, tt)) < 1e-12 && Math.abs(B.breathRateAt(s2, tt) - B.breathHz(9) * scale) < 1e-15);
  ok('and eases out over what the wind-down has left', Math.abs(left - 2 * Math.sqrt(scale)) < 1e-12 && Math.abs(left - (2 - 61 / 60)) < 1e-9,
    'left ' + left);
}

// ---- 4: the gauge against the accumulator, a minute at 60 fps ----
{
  const s = fresh();
  S.running = true;
  frame(s, T0, 0, 5.5);
  let breathPh = B.breathPhaseAt(s, T0);   // the accumulator, from the same start
  const dt = 1 / 60;
  let worstPos = 0, inMiss = 0;
  for (let i = 1; i <= 3600; i++) {
    const t = T0 + i * dt * 1000;
    frame(s, t, dt, 5.5);
    // gpu/sun.js as it was
    breathPh += motion.motionStep(dt) * 5.5 / 60;
    breathPh -= Math.floor(breathPh);
    const oldPos = 0.5 + 0.5 * Math.sin(2 * Math.PI * breathPh);
    const oldIn = Math.cos(2 * Math.PI * breathPh) >= 0;
    // gpu/sun.js as it is
    const newPos = B.breathPosAt(s, t), newIn = B.breathRising(s, t);
    worstPos = Math.max(worstPos, Math.abs(newPos - oldPos));
    if (newIn !== oldIn && Math.abs(Math.cos(2 * Math.PI * breathPh)) > NOISE) inMiss++;
  }
  ok('the gauge\'s position matches the accumulator within float noise over a minute', worstPos < NOISE, 'worst ' + worstPos);
  ok('and its Inhaling / Exhaling never disagrees', inMiss === 0, inMiss + ' frames');
  console.log('     (worst gauge gap over the minute: ' + worstPos.toExponential(2) + ')');
}

// ---- 5: across threads ----
{
  const s = fresh();
  S.running = true; frame(s, T0, 0, 7);
  S.running = false;
  for (let i = 1; i <= 3; i++) frame(s, T0 + i * 16.7, 0.0167, 7);
  const copy = B.sunBreathState();
  B.unpackBreath(copy, B.packBreath(s, new Float64Array(B.BREATH_PACK)));
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const t = T0 + i * 7.3;
    worst = Math.max(worst, gap(B.breathPhaseAt(copy, t), B.breathPhaseAt(s, t)),
      Math.abs(B.breathScaleAt(copy, t) - B.breathScaleAt(s, t)));
  }
  ok('an unpacked copy reads the very breath, and the very pause, the writer does', worst === 0, 'worst ' + worst);
}

// ---- 6: the voices' read ----
{
  // the writer, running then pausing, as in 5; the page's copy is the
  // module's own sunBreath, which breathHeardAt reads
  const s = fresh();
  S.running = true; frame(s, T0, 0, 6.5);
  for (let i = 1; i <= 120; i++) frame(s, T0 + i * 16.7, 0.0167, 6.5);
  S.running = false;
  for (let i = 121; i <= 160; i++) frame(s, T0 + i * 16.7, 0.0167, 6.5);
  B.unpackBreath(B.sunBreath, B.packBreath(s, new Float64Array(B.BREATH_PACK)));
  const on = { layers: { sun: true } }, off = { layers: { sun: false } }, bare = {};
  let worst = 0, siteWorst = 0, offMoved = 0;
  for (let i = 0; i < 600; i++) {
    const t = T0 + i * 11.3;
    const heard = B.breathHeardAt(on, t);
    // the gauge as gpu/sun.js publishes it, from the writer's own state
    const gauge = 0.5 + 0.5 * Math.sin(2 * Math.PI * B.breathPhaseAt(s, t));
    worst = Math.max(worst, Math.abs(heard - B.breathPosAt(s, t)));
    // the call sites: the choir's Stack (set 0.8, amount 0.6) and the
    // level dips (1 - variedBy(..., 1, a, ...)), gauge against formula
    siteWorst = Math.max(siteWorst,
      Math.abs(variedBy('breath', 0.8, 0.6, 0, 1, heard) - variedBy('breath', 0.8, 0.6, 0, 1, gauge)),
      Math.abs((1 - variedBy('breath', 1, 0.4, 0, 1, heard)) - (1 - variedBy('breath', 1, 0.4, 0, 1, gauge))));
    if (B.breathHeardAt(off, t) !== undefined || B.breathHeardAt(bare, t) !== undefined) offMoved++;
  }
  ok('the voices\' read on the page\'s copy gives the writer\'s own position', worst === 0, 'worst ' + worst);
  ok('and at the call sites plays what the gauge played, layer on', siteWorst < NOISE, 'worst ' + siteWorst);
  ok('with the Sun layer off (or no layers yet) it is undefined, the gauge\'s own value then', offMoved === 0, offMoved + ' readings');
  // off, with the breath keeping time: every call site holds its setting,
  // as it did on the gauge's undefined
  const s2 = fresh();
  S.running = true; frame(s2, T0, 0, 5.5);
  B.unpackBreath(B.sunBreath, B.packBreath(s2, new Float64Array(B.BREATH_PACK)));
  let held = true;
  for (let i = 0; i < 100; i++) {
    const t = T0 + i * 437;
    const x = B.breathHeardAt(off, t), old = undefined;
    if (variedBy('breath', 0.8, 0.6, 0, 1, x) !== variedBy('breath', 0.8, 0.6, 0, 1, old) ||
        variedBy('breath', 0.8, 0.6, 0, 1, x) !== 0.8 ||
        1 - variedBy('breath', 1, 0.4, 0, 1, x) !== 0) held = false;
  }
  ok('and a breath-linked Stack, Density or level holds its setting while the breath runs on', held);
  // the moving breath still reaches them once the layer is on
  const a = B.breathHeardAt(on, T0 + 1000), b = B.breathHeardAt(on, T0 + 4000);
  ok('which the layer switched on follows at once', typeof a === 'number' && Math.abs(a - b) > 0.01, a + ' ' + b);
}

// 7. A room: the follower's breath (same rate, another phase) is set onto
//    the broadcaster's by the beacon. The first beacon lands in one step; a
//    later disagreement (the follower's glide folded a different integral)
//    is slewed out, never faster than SYNC_BEND of the rate, never reversing
//    the breath; a pause, a stale beacon and a rate of the viewer's own pull
//    nothing.
{
  const phaseGap = (a, b) => gap(a.ph, b.ph);
  const bro = fresh(), fol = fresh();
  S.running = true;
  frame(bro, 1000, 0, 5.5);
  frame(fol, 4300, 0, 5.5);                    // the same rate, anchored elsewhere
  B.setBreathClockOffset(0);
  const beaconAt = tr => B.breathBeacon(bro, T0 + tr);
  const sendBeacon = tr => { const b = beaconAt(tr); B.setBreathSyncTarget(tr, b.ph, b.hz); };
  const ph = (s, tr) => B.breathPhaseAt(s, T0 + tr);
  const before = gap(ph(bro, 10000), ph(fol, 10000));
  ok('before the beacon the two breaths sit apart', before > 0.05, before);
  sendBeacon(10000);
  B.syncBreath(fol, T0 + 10000, 10000, 1 / 60);
  ok('the first beacon sets the follower onto the broadcaster in one step',
     gap(ph(bro, 10000), ph(fol, 10000)) < NOISE, gap(ph(bro, 10000), ph(fol, 10000)));
  // knock the follower off by a tenth of a cycle, as a differently glided rate would
  fol.offset += 0.1; fol.gen++;
  let tr = 10000, worstStep = 0, lastErr = gap(ph(bro, tr), ph(fol, tr)), monotone = true;
  const cap = RATE * 0.4 / 60;
  for (let i = 0; i < 60 * 30; i++) {
    tr += 1000 / 60;
    if (i % 120 === 0) sendBeacon(tr);
    const p0 = ph(fol, tr);
    B.syncBreath(fol, T0 + tr, tr, 1 / 60);
    worstStep = Math.max(worstStep, Math.abs(ph(fol, tr) - p0 > 0.5 ? 1 : 0) + gap(ph(fol, tr), p0));
    const e = gap(ph(bro, tr), ph(fol, tr));
    if (e > lastErr + NOISE) monotone = false;
    lastErr = e;
  }
  ok('a later disagreement is slewed out within the half minute', lastErr < 1e-3, lastErr);
  ok('and only ever shrinks, never overshoots', monotone);
  ok('no frame moves the offset by more than the bend cap', worstStep <= cap + NOISE, worstStep + ' vs ' + cap);
  // a paused follower holds still
  S.running = false; S.pauseWindDown = 1;
  frame(fol, tr + 10, 1, 5.5); for (let i = 0; i < 90; i++) { tr += 16; frame(fol, tr, 0.016, 5.5); }
  fol.offset += 0.1;
  const held0 = fol.offset;
  B.syncBreath(fol, T0 + tr, tr, 1 / 60);
  ok('a paused follower is not pulled', fol.offset === held0);
  // a stale beacon, and a rate of the viewer\'s own, pull nothing
  S.running = true; frame(fol, tr + 50, 0, 5.5); tr += 50;
  const stale = fol.offset;
  B.syncBreath(fol, T0 + tr + 20000, tr + 20000, 1 / 60);
  ok('a stale beacon pulls nothing', fol.offset === stale);
  frame(fol, tr + 60, 0, 8); tr += 60;
  sendBeacon(tr);
  const own = fol.offset;
  B.syncBreath(fol, T0 + tr, tr, 1 / 60);
  ok('a rate the viewer took for their own is not bent toward the broadcaster', fol.offset === own);
  B.clearBreathSync();
  frame(fol, tr + 60, 0, 5.5);
  const cl = fol.offset;
  B.syncBreath(fol, T0 + tr, tr, 1 / 60);
  ok('after the room ends nothing pulls', fol.offset === cl);
  const paused = B.breathBeacon((() => { const q = fresh(); return q; })(), T0);
  ok('a breath that is not running steady sends no phase', paused === null);
}

console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
