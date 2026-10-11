// Follow the laptop clock without repeatedly interrupting the video decoder.
// Small errors change playback speed; explicit timeline changes seek once.
export function createPreviewClock() {
  let previous = null, offset = null, alignment = 'startup', recoveredAt = -Infinity;
  const difference = (a, b, loop, duration) => {
    let delta = a - b;
    if (loop && duration > 0) delta -= Math.round(delta / duration) * duration;
    return delta;
  };
  return {
    reset() { previous = null; offset = null; alignment = 'startup'; recoveredAt = -Infinity; },
    seeked(now) { recoveredAt = now; },
    update(media, playback, now) {
      const running = playback.rate > 0;
      const delay = Number.isFinite(playback.delayMs) ? Math.max(0, playback.delayMs) : 0;
      const duration = media.duration;
      const loop = playback.loop && playback.duration > 0;
      let target = playback.time + (running
        ? (Math.max(0, now - playback.reportedAt) + delay) / 1000 * playback.rate : 0);
      if (loop) target %= playback.duration;
      target = Math.max(0, Math.min(duration, target));
      if (offset !== null && offset !== delay) alignment = 'delay';
      offset = delay;

      if (previous && playback.reportedAt !== previous.reportedAt) {
        const expected = previous.time + Math.max(0, playback.reportedAt - previous.reportedAt) / 1000 * previous.rate;
        const jump = difference(playback.time, expected, loop, playback.duration);
        if (Math.abs(jump) > .35) alignment = 'timeline';
        // Pausing must hold the laptop's exact frame, without compensation.
        if (!running && (previous.rate > 0 || Math.abs(playback.time - previous.time) > .001)) alignment = 'pause';
      }
      previous = { time: playback.time, rate: playback.rate, reportedAt: playback.reportedAt };
      const error = difference(target, media.currentTime, loop, duration);
      let seek = null, reason = null;
      if (!media.seeking) {
        // Slow seek completion itself creates lag. Give rate correction time
        // to recover before considering another large-error seek.
        if (alignment || (running && Math.abs(error / playback.rate) > 1.5 && now - recoveredAt > 1500)) {
          reason = alignment || 'recovery';
          alignment = null;
          if (Math.abs(error) > .001) seek = target;
        }
      }
      const wallError = running ? error / playback.rate : 0;
      const adjustment = media.seeking || seek !== null || Math.abs(wallError) < .03
        ? 0 : Math.max(-.2, Math.min(.2, wallError / 1.2));
      const rate = running ? Math.max(.0625, Math.min(4, playback.rate * (1 + adjustment))) : 0;
      return { target, seek, reason, rate, running: running && (loop || target < duration), error };
    }
  };
}
