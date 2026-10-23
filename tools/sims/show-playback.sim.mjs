// The show's playback (cue 24) over a real tape: fetches a room's tape
// from the relay, hands it to the brush (core/brush.js brushTapeAdd), runs
// the loop on a fake 60 fps clock for two passes and counts the stamps
// that come out, per pass.
//
//   node tools/sims/show-playback.sim.mjs [room] [from]
import { brushTapeAdd, brushReplay, brushPlay, brushQueue, brushQueueDrop, setBrushClock } from '../../core/brush.js';
import { planPass } from '../../core/brush-replay.js';
const room = process.argv[2] || 'win', from = +(process.argv[3] || 0);
const d = await (await fetch('https://the-signal-broadcast.robertalexander-music.workers.dev/touch/' + room + '/tape?from=' + from)).json();
console.log('tape', room, 'entries', d.entries.length, 'from', d.from, 'total', d.total);
let now = 100000;
setBrushClock(() => now);
brushTapeAdd(d.entries);
const plan = planPass(d.entries);
console.log('pass', Math.round(plan.ms) + ' ms', 'scale', plan.scale.toFixed(4), 'steps', plan.steps.length);
brushReplay(true);
let stamps = 0, frames = 0, perPass = [], passStart = now;
const end = now + plan.ms * 2 + 100;
while (now < end) {
  brushPlay(1 / 60);
  stamps += brushQueue.count; brushQueueDrop(brushQueue.count);
  now += 1000 / 60; frames++;
  if (now - passStart >= plan.ms) { perPass.push(stamps); stamps = 0; passStart = now; }
}
console.log('frames', frames, 'stamps per pass', perPass, 'leftover', stamps);
brushReplay(false);
