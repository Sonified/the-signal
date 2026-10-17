// The springs' exact solution (ui/anim.js), proven against the physics and
// against the failure that forced it:
//
//   node tools/spring.test.mjs
//
// 1. The closed form matches a reference integrator run at 10 kHz substeps,
//    for every MOTION pair, at every frame length — the exact solution and a
//    fine-enough approximation must be the same curve.
// 2. The press pair survives 50 ms frames. Semi-implicit Euler at one step a
//    frame multiplied its error by about -3.2 per 50 ms step (the phone
//    slider knob that flickered and grew until it filled the screen); the
//    exact solution settles.
// 3. Frame-rate independence: the same spring sampled at 30 fps and 120 fps
//    agrees wherever the sample times coincide.
// 4. A monotone pair never passes its target, even with carried velocity.
// 5. A ten-second stall lands the spring settled at its target, not flung.

const anim = await import('../ui/anim.js');
const { MOTION } = await import('../ui/theme.js');

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : ' (' + detail + ')'));
};

// The reference: the same oscillator stepped at 10 kHz, far inside the
// integrator's stability region, so it converges on the true solution.
function refStep(cfg, st, target, dt) {
  const n = Math.ceil(dt * 10000), h = dt / n;
  for (let i = 0; i < n; i++) {
    st.v += (cfg.stiffness * (target - st.x) - cfg.damping * st.v) * h;
    st.x += st.v * h;
  }
}

// Fresh cfg copies so the coefficient cache never carries between cases.
const pair = name => ({ ...MOTION[name] });

let id = 0;

// ---- 1: the closed form is the physics ----
for (const name of ['hover', 'press', 'panel', 'fold', 'fade']) {
  for (const dt of [1 / 240, 1 / 120, 1 / 60, 1 / 30, 0.05]) {
    const cfg = pair(name);
    const sid = ++id;
    anim.reset(sid, 0);
    anim.setDt(dt);
    const ref = { x: 0, v: 0 };
    let worst = 0;
    const steps = Math.ceil(0.4 / dt);
    for (let i = 0; i < steps; i++) {
      refStep(cfg, ref, 1, dt);
      const x = anim.spring(sid, 1, cfg);
      // the settle snap (EPS 0.01) is anim's own behaviour, outside the physics
      if (!anim.settled(sid)) worst = Math.max(worst, Math.abs(x - ref.x));
    }
    ok(name + ' matches physics at dt ' + dt.toFixed(4), worst < 0.005, 'worst gap ' + worst.toFixed(5));
  }
}

// ---- 2: the press pair survives the frames that broke the integrator ----
{
  const cfg = pair('press');
  const sid = ++id;
  anim.reset(sid, 0);
  anim.setDt(0.05);
  let peak = 0, x = 0;
  for (let i = 0; i < 60; i++) { x = anim.spring(sid, 1, cfg); peak = Math.max(peak, Math.abs(x)); }
  ok('press at 50 ms frames stays bounded', peak < 1.5, 'peak ' + peak);
  ok('press at 50 ms frames settles on 1', x === 1 && anim.settled(sid), 'x ' + x);
}

// ---- 3: the curve does not depend on the frame rate ----
{
  const a = pair('hover'), b = pair('hover');
  const sa = ++id, sb = ++id;
  anim.reset(sa, 0); anim.reset(sb, 0);
  let worst = 0;
  // 120 fps: four steps for each 30 fps step; compare at the shared times
  for (let i = 0; i < 30; i++) {
    let xa = 0;
    anim.setDt(1 / 120);
    for (let k = 0; k < 4; k++) xa = anim.spring(sa, 1, a);
    anim.setDt(1 / 30);
    const xb = anim.spring(sb, 1, b);
    if (!anim.settled(sa) && !anim.settled(sb)) worst = Math.max(worst, Math.abs(xa - xb));
  }
  ok('30 fps and 120 fps trace one curve', worst < 1e-9, 'worst gap ' + worst);
}

// ---- 4: monotone never passes its target ----
{
  // Retargeting mid-flight is the real source of carried velocity: send the
  // fold out toward 1, let it build speed, then send it back to 0.2. The
  // speed it carries is the one way physics could cross the new target.
  const cfg = pair('fold');
  const sid = ++id;
  anim.reset(sid, 0);
  anim.setDt(1 / 120);
  let x = 0;
  for (let i = 0; i < 6; i++) x = anim.spring(sid, 1, cfg);
  let under = true;
  for (let i = 0; i < 400; i++) {
    x = anim.spring(sid, 0.2, cfg);
    if (x < 0.2 - 1e-9) under = false;
  }
  ok('fold never passes a retarget', under, 'crossed to ' + x);
  ok('fold lands on the retarget', x === 0.2, 'x ' + x);
}

// ---- 5: a stalled tab lands settled, not flung ----
{
  const cfg = pair('panel');
  const sid = ++id;
  anim.reset(sid, 0);
  anim.setDt(10);
  const x = anim.spring(sid, 1, cfg);
  ok('a 10 s frame lands on the target', x === 1 && anim.settled(sid), 'x ' + x);
  const over = pair('fold');
  const sid2 = ++id;
  anim.reset(sid2, 0);
  anim.setDt(120);
  const x2 = anim.spring(sid2, 1, over);
  ok('a 2 min stall on an overdamped pair is finite and lands', Number.isFinite(x2) && x2 === 1, 'x ' + x2);
}

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
