// The null-test bench's Heart side, in node: every scenario of
// tools/null-test-scenarios.js rendered on OfflineHeartContext at 48 and
// 44.1 kHz. Only a browser can render the native side and subtract, so this
// checks what node can: each scenario builds and renders without throwing,
// the stage refuses no command and cuts no cycle, the sound is finite, and
// there is a sound at all.
//
//   node --test tools/heart-tests/bench.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeAudioBuffer } from './fake-audio.mjs';

globalThis.AudioBuffer ??= FakeAudioBuffer;
const { SCENARIOS, renderHeart, dB } = await import('../null-test-scenarios.js');
const WASM = readFileSync(new URL('../../js/heart/heart.wasm', import.meta.url));

// A processor's port message, the strobe's at rest, is a constant, so a
// sound is anything louder than this.
const SILENT_DB = -120;

for (const sampleRate of [48000, 44100]) {
  test(`every scenario renders on Heart at ${sampleRate / 1000} kHz`, async t => {
    for (const sc of SCENARIOS) {
      await t.test(sc.id, async () => {
        const { channels, stats } = await renderHeart(sc, sampleRate, new Map(), WASM);
        assert.equal(stats.rejected, 0, 'no command refused');
        assert.equal(stats.cut, 0, 'no cycle cut');
        let peak = 0;
        for (const x of channels) {
          for (let i = 0; i < x.length; i++) {
            if (!Number.isFinite(x[i])) assert.fail(`a ${x[i]} at frame ${i}`);
            peak = Math.max(peak, Math.abs(x[i]));
          }
        }
        assert.ok(dB(peak) > SILENT_DB, `a sound (${dB(peak).toFixed(1)} dBFS)`);
        assert.equal(channels[0].length, Math.round(sc.seconds * sampleRate));
      });
    }
  });
}

test('scenario ids are unique', () => {
  const ids = SCENARIOS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
});
