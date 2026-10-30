// The standing playback's pace, frame by frame, with Replay smoothing off
// and on: the WIN 2026 tape through the real brush on a fake 60 fps clock
// at a Replay speed, counting each frame's stamps (a stutter is frames of
// none between bursts), the play delay (a ratchet moves it), and the ms of
// CPU each frame costs.
//
//   node tools/sims/replay-smooth-stutter.sim.mjs [speed] [mode] [seconds] [seek ms]
import fs from 'fs';
import { S } from '../../js/state.js';
import { brushTapeAdd, brushReplay, brushPlay, brushQueue, brushQueueDrop, setBrushClock, brushPlayDelay, brushReplaySeek } from '../../core/brush.js';
const speed = +(process.argv[2] || 0.05), mode = process.argv[3] || 'off', secs = +(process.argv[4] || 60), at = +(process.argv[5] || 120000);
S.brushReplaySpeed = speed; S.brushReplaySmooth = mode; S.brushReplaySmoothMs = 80; S.brushTrim = true;
const doc = JSON.parse(fs.readFileSync(new URL('../../tapes/win-1792736009664-n58524.json', import.meta.url)));
let now = 100000;
setBrushClock(() => now);
brushTapeAdd(doc.entries);
brushReplay(true, Infinity);
brushPlay(1 / 60); now += 1000 / 60;   // plans the pass
brushReplaySeek(at);
const counts = [], delays = [], cpu = [];
for (let f = 0; f < secs * 60; f++) {
  const t0 = performance.now();
  brushPlay(1 / 60);
  cpu.push(performance.now() - t0);
  counts.push(brushQueue.count); brushQueueDrop(brushQueue.count);
  delays.push(brushPlayDelay());
  now += 1000 / 60;
}
// skip the first 5 s (the pass finding its feet)
const c = counts.slice(300), cp = cpu.slice(300).sort((a, b) => a - b);
let zeros = 0, runs = 0, inRun = false;
for (const x of c) { if (x === 0) { zeros++; if (!inRun) { runs++; inRun = true; } } else inRun = false; }
const nz = c.filter(x => x > 0).sort((a, b) => a - b);
const q = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
const dd = [...new Set(delays.map(d => Math.round(d)))];
console.log(`speed ${speed} smooth ${mode}: frames ${c.length}, empty ${zeros} in ${runs} runs, stamps/frame p50 ${q(nz, .5)} p90 ${q(nz, .9)} max ${q(nz, 1)}`);
console.log(`  delay values seen (ms): ${dd.slice(0, 12).join(', ')}${dd.length > 12 ? ' ...' : ''}`);
console.log(`  cpu/frame ms p50 ${q(cp, .5).toFixed(2)} p99 ${q(cp, .99).toFixed(2)} max ${q(cp, 1).toFixed(2)}`);
brushReplay(false);
