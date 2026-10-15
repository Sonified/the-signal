// The ticker's walk (js/ticker.js): held timers fired in due order on a
// virtual clock, the virtual time readable while each runs (walkAhead),
// timers made inside a walk joining it, real timers left on the real clock,
// and every held timer armed again for its post-walk due once released, or
// earlier by a skip's shift. node has no Worker, so the page's own timers
// stand in behind the ticker here, exactly as they do where the worker
// cannot load.
//
//   node --test tools/heart-tests/ticker-walk.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const { every, after, clear, hold, walk, release, shift, walkAhead, held } = await import('../../js/ticker.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
// Written ahead of the walk itself (documents/idle-render-ahead.md, what
// remains): until js/ticker.js has hold, walk, release, shift, walkAhead
// and held, each test is skipped with the reason, and it is the spec.
const opts = typeof hold === 'function' ? {} : { skip: 'js/ticker.js has no walk yet (documents/idle-render-ahead.md)' };

test('a walk fires held timers in due order at their virtual times', opts, () => {
  const log = [];
  const t0 = performance.now();
  hold();
  assert.equal(held(), true);
  const a = every(100, () => log.push(['a', walkAhead()]));
  const b = every(250, () => log.push(['b', walkAhead()]));
  const c = after(330, () => log.push(['c', walkAhead()]));
  const fired = walk(t0 + 1000);
  // a: 100..1000 (10), b: 250, 500, 750, 1000 (4), c: 330 (1)
  assert.equal(fired, 15);
  assert.equal(log.length, 15);
  // in due order, each reading its own virtual time (to within the few ms
  // this test itself takes)
  let last = -1;
  for (const [, ahead] of log) {
    assert.ok(ahead >= last - 0.005, 'virtual time never runs backwards');
    last = ahead;
  }
  const at = name => log.filter(e => e[0] === name).map(e => e[1]);
  at('a').forEach((s, i) => assert.ok(Math.abs(s - 0.1 * (i + 1)) < 0.02, `a #${i + 1} at ${s}`));
  at('b').forEach((s, i) => assert.ok(Math.abs(s - 0.25 * (i + 1)) < 0.02, `b #${i + 1} at ${s}`));
  assert.ok(Math.abs(at('c')[0] - 0.33) < 0.02);
  // a tie (a and b at 500 and 1000) runs in the order the timers were made
  const i500a = log.findIndex(e => e[0] === 'a' && Math.abs(e[1] - 0.5) < 0.02);
  const i500b = log.findIndex(e => e[0] === 'b' && Math.abs(e[1] - 0.5) < 0.02);
  assert.ok(i500a < i500b);
  // outside a walk the clock is the real one
  assert.equal(walkAhead(), 0);
  clear(a); clear(b); clear(c);
  release();
});

test('timers made and cleared inside a walk join it on the virtual clock', opts, () => {
  const t0 = performance.now();
  const seen = [];
  hold();
  // a planner that re-arms itself with after(), as piano.js step does
  let n = 0, h = 0;
  const step = () => { seen.push(walkAhead()); if (++n < 100) h = after(200, step); };
  h = after(200, step);
  // one that clears another mid-walk
  const victim = every(50, () => seen.push(-1));
  after(120, () => clear(victim));
  walk(t0 + 1000);
  const steps = seen.filter(s => s >= 0);
  assert.equal(steps.length, 5, 'the chain stepped 200, 400, 600, 800, 1000');
  steps.forEach((s, i) => assert.ok(Math.abs(s - 0.2 * (i + 1)) < 0.02));
  assert.equal(seen.filter(s => s === -1).length, 2, 'the cleared timer fired at 50 and 100 only');
  clear(h);
  release();
});

test('real timers keep the real clock while the rest are held', opts, async () => {
  let realTicks = 0, heldTicks = 0;
  hold();
  const r = every(20, () => realTicks++, { real: true });
  const hTimer = every(20, () => heldTicks++);
  await wait(130);
  assert.ok(realTicks >= 3, `real timer ran ${realTicks} times`);
  assert.equal(heldTicks, 0, 'a held timer never fires on its own');
  clear(r); clear(hTimer);
  release();
});

test('released, a timer picks up at its post-walk due; a shift brings it earlier', opts, async () => {
  const t0 = performance.now();
  const fires = [];
  hold();
  const h = every(100, () => fires.push(performance.now() - t0));
  walk(t0 + 300);                 // fired at 100, 200, 300; next due 400
  assert.equal(fires.length, 3);
  fires.length = 0;
  release();
  await wait(250);
  assert.equal(fires.length, 0, 'nothing before its due');
  await wait(250);
  assert.ok(fires.length >= 1, 'it came due once the real clock reached it');
  assert.ok(fires[0] >= 380, `first real tick at ${fires[0].toFixed(0)} ms`);
  clear(h);

  // the same, with the frontier pulled 300 ms earlier by a skip
  const t1 = performance.now();
  const f2 = [];
  hold();
  const h2 = every(100, () => f2.push(performance.now() - t1));
  walk(t1 + 400);                 // next due 500
  release();
  shift(300);                     // next due 200
  await wait(320);
  assert.ok(f2.length >= 5, 'the walk\'s four, then the shifted first tick');
  const real = f2.slice(4);
  assert.ok(real[0] < 300, `shifted tick at ${real[0].toFixed(0)} ms, not 500`);
  clear(h2);
});
