import assert from 'node:assert/strict';
import { createPreviewClock } from '../platform/preview-clock.js';

const report = (time, reportedAt, extra = {}) => ({
  time, reportedAt, rate: 1, duration: 120, loop: false, delayMs: 200, ...extra
});

// Model the observed iPad behavior: a seek immediately sets currentTime,
// then decoding holds playback for hundreds of milliseconds. Exercise the
// same clock used by the real player, including incoming 250ms reports.
function slowDecoder(seekLatency, baseRate = 1) {
  const clock = createPreviewClock();
  const media = { currentTime: 0, seeking: false, duration: 120 };
  let rate = baseRate, seekDone = null, seeks = 0, playback, decision;
  const samples = [];
  for (let now = 0; now <= 8000; now += 10) {
    if (seekDone !== null && now >= seekDone) {
      media.seeking = false; seekDone = null; clock.seeked(now);
    } else if (!media.seeking && now > 0) media.currentTime += rate * .01;
    if (now % 250 === 0) playback = report(30 + now / 1000 * baseRate, now, { rate: baseRate });
    if (now % 250 === 0 || now % 250 === seekLatency % 250) {
      decision = clock.update(media, playback, now);
      rate = decision.rate;
      if (decision.seek !== null) {
        seeks++; media.currentTime = decision.seek; media.seeking = true; seekDone = now + seekLatency;
      }
    }
    if (now % 1000 === 0) samples.push({ now, seeking: media.seeking, wallError: (30 + now / 1000 * baseRate + .2 * baseRate - media.currentTime) / baseRate });
  }
  assert.equal(seeks, 1, `A ${seekLatency}ms decoder at ${baseRate}x must align once, without a seek feedback loop`);
  assert(Math.abs(samples.at(-1).wallError) < .05, 'Playback must catch up to the compensated laptop clock');
  return { seekLatency, baseRate, seeks, finalErrorMs: Math.round(samples.at(-1).wallError * 1000) };
}
const scenarios = [200, 550, 1000].flatMap(latency => [1, .5, 2].map(rate => slowDecoder(latency, rate)));

const clock = createPreviewClock();
const media = { currentTime: 30, seeking: false, duration: 120 };
let result = clock.update(media, report(30, 0), 0);
assert.equal(result.seek, 30.2);
assert.equal(result.reason, 'startup');
media.currentTime = result.seek; media.seeking = true;
// A real seek received while decoding must remain pending until seeked.
result = clock.update(media, report(49, 250, { rate: 0 }), 250);
assert.equal(result.seek, null);
media.seeking = false; clock.seeked(550);
result = clock.update(media, report(49, 250, { rate: 0 }), 550);
assert.equal(result.seek, 49);
assert.equal(result.running, false);
media.currentTime = 49;
assert.equal(clock.update(media, report(49, 750, { rate: 0 }), 750).seek, null);

// Resume and speed changes use the laptop rate without manufacturing a seek.
result = clock.update(media, report(49, 1000, { rate: .5 }), 1000);
assert.equal(result.seek, null);
assert(result.rate > .5 && result.rate <= .6);
media.currentTime = 49.225;
result = clock.update(media, report(49.125, 1250, { rate: 2 }), 1250);
assert.equal(result.seek, null);
assert(result.rate >= 2 && result.rate <= 2.4);

// An explicit offset change applies immediately, even with a small error.
media.currentTime = 49.5;
result = clock.update(media, report(49.625, 1500, { rate: 2, delayMs: 250 }), 1500);
assert.equal(result.seek, 50.125);
assert.equal(result.reason, 'delay');
media.currentTime = result.seek; media.seeking = true;
clock.update(media, report(49.625, 1500, { rate: 2, delayMs: 100 }), 1550);
media.seeking = false; clock.seeked(1750);
result = clock.update(media, report(49.625, 1500, { rate: 2, delayMs: 100 }), 1750);
assert.equal(result.seek, 50.325, 'Latest offset must survive an in-flight seek');

// Loop wrap is continuous; a small error across the seam is not 120s drift.
clock.reset(); media.currentTime = 119.95;
result = clock.update(media, report(119.8, 0, { loop: true }), 0);
assert.equal(result.seek, 0);
media.currentTime = .2;
clock.seeked(100);
result = clock.update(media, report(.05, 250, { loop: true }), 250);
assert.equal(result.seek, null);
assert.equal(result.reason, null);

// Decoder stalls recover by speed first; a sustained major gap can seek.
clock.reset(); media.currentTime = 30.2;
clock.update(media, report(30, 0), 0);
clock.seeked(550);
media.currentTime = 30;
result = clock.update(media, report(30.75, 750), 750);
assert.equal(result.seek, null);
assert.equal(result.rate, 1.2);
result = clock.update(media, report(32.25, 2250), 2250);
assert.equal(result.reason, 'recovery');
assert.equal(result.seek, 32.45);

console.log(JSON.stringify({ scenarios, checks: ['Startup with slow seek decoding catches up without repeated seeks',
  'Manual seeks and pauses align exactly', 'Rate changes stay continuous', 'Offset changes survive decoding',
  'Loop seams stay continuous', 'Major stalls recover'] }));
