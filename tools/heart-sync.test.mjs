// The heartbeat in step across a room (core/heart-sync.js): the servo that
// steers a follower's heard place onto the broadcaster's, and the rate's
// lead, proven on a simulated broadcaster and follower with the breath
// leading the Speed (a dip of 50% over an 11 s breath), a relay that delays
// every beacon, and screens whose output latencies differ:
//
//   node tools/heart-sync.test.mjs
//
// 1. wrapHeart keeps an error within half a loop either way.
// 2. A follower 0.2 s off, beaconed every 2 s through a 150 ms network,
//    settles inside 10 ms and stays there through a whole breath, with
//    nothing jumped (the bend alone), and its pitch bend never passes 5%.
// 3. A joiner 12 s off (or a screen back from sleep) is set onto the place
//    in one jump, then settles; a second jump never comes inside the
//    cooldown.
// 4. Two screens 200 ms apart in output latency, the breath swinging the
//    rate: with each setting the rate where it will be heard (the lead)
//    the heard places stay within 10 ms; without it they swing apart by
//    tens, which is what the lead is for. A drag's jump is not
//    extrapolated.
// 5. A beacon gone stale lets go (no bend); a beacon from another track, or
//    one claiming a moment in the future, is not believed.
// 6. The broadcaster's report and the follower's take pass through their
//    registration.

import {
  wrapHeart, heartServo, heartServoStep, heartServoReset, takeHeartBeacon, heartTarget, clearHeartBeacon,
  setHeartReporter, heartReport, heartLeadState, heartRateAhead,
  HEART_NONE, HEART_JUMP, HEART_MAX_BEND, HEART_STALE_MS, HEART_COOLDOWN_MS
} from '../core/heart-sync.js';

let fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra && !cond ? '  ' + extra : ''));
};

const DUR = 32;
const mod = (x, m) => x - Math.floor(x / m) * m;
// the breath-led Speed: 1 at full inhale down to 1 - 0.5 at full exhale
const rateAt = t => 1 - 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / 11000));

// 1
{
  ok('wrapHeart folds 20 into -12', Math.abs(wrapHeart(20, DUR) + 12) < 1e-9);
  ok('wrapHeart leaves 3', wrapHeart(3, DUR) === 3);
  ok('wrapHeart folds -17 into 15', Math.abs(wrapHeart(-17, DUR) - 15) < 1e-9);
  ok('wrapHeart: half a loop is the far edge', wrapHeart(16, DUR) === -16);
}

// The simulation. Each screen sets the rate it computes at its frame (the
// formula of the shared clock) and hears it `lag` later, its latency: the
// broadcaster's heard place is the integral of what it hears, the
// follower's the same with the servo's bend on top, from a start `off`
// seconds away. With `leadOn` each sets the rate carried forward by its lag
// (heartRateAhead), as core/heartbeat.js does in a room. Frames every
// 16 ms; a beacon leaves every 2 s and arrives `delay` ms later describing
// its send moment.
function screen(lag, leadOn) {
  const ls = heartLeadState(), q = [];
  let heard = rateAt(-1e6);
  return {
    set(t, speed) {
      q.push([t + lag, leadOn ? heartRateAhead(ls, speed, t, lag / 1000) : speed]);
    },
    hear(t) {
      while (q.length && q[0][0] <= t) heard = q.shift()[1];
      return heard;
    }
  };
}

function run({ off, seconds, delay = 150, lag = 0, lagB = 0, leadOn = false }) {
  const FRAME = 16;
  let pB = 5, pF = pB + off;
  const sv = heartServo();
  clearHeartBeacon();
  const F = screen(lag, leadOn), B = screen(lagB, leadOn);
  const inflight = [];
  let jumps = 0, maxBend = 0, worst = 0, last = null;
  for (let t = 0; t <= seconds * 1000; t += FRAME) {
    // broadcaster: its place at t is stamped before the frame steps it
    if (t % 2000 === 0) inflight.push({ at: t, pos: mod(pB, DUR), arrive: t + delay });
    B.set(t, rateAt(t));
    pB += B.hear(t) * FRAME / 1000;
    while (inflight.length && inflight[0].arrive <= t) {
      const b = inflight.shift();
      takeHeartBeacon(b.at, b.pos, DUR, t);
    }
    // follower
    const speed = rateAt(t);
    const act = heartServoStep(sv, heartTarget(t), t, mod(pF, DUR), speed, DUR);
    if (act === HEART_JUMP) { pF = sv.to; jumps++; }
    const bend = sv.bend;
    if (Math.abs(bend) > maxBend) maxBend = Math.abs(bend);
    F.set(t, speed);
    pF += F.hear(t) * (1 + bend) * FRAME / 1000;
    last = wrapHeart(pF - pB, DUR);
    if (t > 12000 && Math.abs(last) > worst) worst = Math.abs(last);
  }
  return { jumps, maxBend, worst, last };
}

// 2
{
  const r = run({ off: 0.2, seconds: 40 });
  ok('0.2 s off: settles inside 10 ms and holds through a whole breath', r.worst < 0.010, 'worst ' + r.worst);
  ok('0.2 s off: nothing jumped', r.jumps === 0, 'jumps ' + r.jumps);
  ok('the bend never passes the cap', r.maxBend <= HEART_MAX_BEND + 1e-12, 'bend ' + r.maxBend);
  const q = run({ off: -0.15, seconds: 40 });
  ok('0.15 s the other way settles too', q.worst < 0.010 && q.jumps === 0, JSON.stringify(q));
}

// 3
{
  const r = run({ off: 12, seconds: 40 });
  ok('12 s off: one jump', r.jumps === 1, 'jumps ' + r.jumps);
  ok('12 s off: settled inside 10 ms after it', r.worst < 0.010, 'worst ' + r.worst);
  const sv = heartServo();
  clearHeartBeacon();
  takeHeartBeacon(0, 3, DUR, 100);
  // two beacons a second apart, both saying the follower is 5 s off
  let a = heartServoStep(sv, heartTarget(150), 150, 8, 1, DUR);
  ok('a far error jumps at once', a === HEART_JUMP && Math.abs(sv.to - 3.15) < 1e-9, a + ' ' + sv.to);
  takeHeartBeacon(1000, 4.15, DUR, 1100);
  a = heartServoStep(sv, heartTarget(1150), 1150, 12, 1, DUR);
  ok('and not again inside the cooldown (it bends at the cap instead)',
     a === HEART_NONE && sv.bend === -HEART_MAX_BEND, a + ' ' + sv.bend);
  takeHeartBeacon(1000 + HEART_COOLDOWN_MS, 4.15 + 1.5, DUR, 2600 + 100);
  a = heartServoStep(sv, heartTarget(2750), 2750, 20, 1, DUR);
  ok('after the cooldown it may', a === HEART_JUMP, String(a));
}

// 4
{
  // screens 200 ms apart in latency, the breath swinging the rate
  const withLead = run({ off: 0, seconds: 90, lag: 250, lagB: 50, leadOn: true });
  const without = run({ off: 0, seconds: 90, lag: 250, lagB: 50, leadOn: false });
  ok('with the lead a screen 200 ms laggier holds inside 10 ms', withLead.worst < 0.010, 'worst ' + withLead.worst);
  ok('without it the same pair swings apart by tens of ms (what the lead is for)',
     without.worst > 2 * withLead.worst && without.worst > 0.02, 'worst ' + without.worst);
  ok('the lead leaves the bend small', withLead.maxBend < 0.02, 'bend ' + withLead.maxBend);
  const rough = run({ off: 0, seconds: 90, lag: 250, lagB: 30, delay: 400, leadOn: true });
  ok('and a 400 ms network does not spoil it', rough.worst < 0.015, 'worst ' + rough.worst);
  // a drag: the rate jumps and the lead does not run away with it
  const ls = heartLeadState();
  heartRateAhead(ls, 1, 0, 0.25);
  const dragged = heartRateAhead(ls, 1.8, 16, 0.25);
  ok('a jump in the Speed is not extrapolated', dragged === 1.8, String(dragged));
  const smooth = heartRateAhead(ls, 1.801, 32, 0.25);
  ok('a smooth run is carried forward', Math.abs(smooth - (1.801 + 0.001 / 0.016 * 0.25)) < 1e-9, String(smooth));
  ok('a rate carried below zero stops at zero', heartRateAhead(heartLeadState(), 0.1, 0, 0.25) === 0.1
     && (() => { const z = heartLeadState(); heartRateAhead(z, 0.3, 0, 0.25); return heartRateAhead(z, 0.1, 16, 0.25) >= 0; })());
}

// 5
{
  const sv = heartServo();
  clearHeartBeacon();
  takeHeartBeacon(0, 3, DUR, 0);
  ok('a fresh beacon is a target', heartTarget(100) !== null);
  ok('a stale one is let go', heartTarget(HEART_STALE_MS + 1) === null);
  heartServoStep(sv, heartTarget(150), 150, 3.5, 1, DUR);
  heartServoStep(sv, null, 20000, 3.5, 1, DUR);
  ok('no bend without a target', sv.bend === 0 && !sv.have);
  clearHeartBeacon();
  takeHeartBeacon(0, 3, 40, 0);
  const a = heartServoStep(heartServo(), heartTarget(150), 150, 3.5, 1, DUR);
  ok('a beacon from a track of another length is not followed', a === HEART_NONE);
  const sv2 = heartServo();
  clearHeartBeacon();
  takeHeartBeacon(5000, 3, DUR, 100);
  heartServoStep(sv2, heartTarget(150), 150, 20, 1, DUR);
  ok('a beacon from the future is not measured', !sv2.have);
  clearHeartBeacon();
  takeHeartBeacon(NaN, 3, DUR, 0);
  ok('a malformed beacon is dropped', heartTarget(10) === null);
  heartServoReset(sv2);
  ok('reset forgets the measurement', !sv2.have && sv2.bend === 0);
}

// 6
{
  ok('no reporter, no report', heartReport() === null);
  setHeartReporter(() => ({ pos: 1.5, dur: DUR }));
  ok('the reporter answers the beacon', heartReport().pos === 1.5);
  setHeartReporter(null);
  ok('and can be let go', heartReport() === null);
}

console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
