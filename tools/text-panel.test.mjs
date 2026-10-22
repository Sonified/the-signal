import assert from 'node:assert/strict';
import { TextPanel } from '../ui/text-panel.js';
import { DrawList, STRIDE } from '../ui/drawlist.js';

const panel = new TextPanel();
function frame(age, fade = 2000, seed = 1) {
  panel.begin(seed, 'abc', age, fade, 1);
  for (let i = 0; i < 3; i++) panel.letter(i, 20 + i * 20, 30, 30 + i * 20, 50, age >= i * 500);
  return Array.from(panel.letters.subarray(0, 6)).filter((_, i) => i % 2);
}
assert.deepEqual(frame(0), [0, 0, 0]);
frame(500);
assert.equal(frame(1000)[0], 0.5, 'first letter is halfway dark after 1000 ms');
assert.equal(frame(1500)[1], 0.5, 'later letters have their own full fade duration');
assert.deepEqual(frame(2000), [1, 0.84375, 0.5]);
assert.deepEqual(frame(3000), [1, 1, 1]);
assert.deepEqual(frame(0, 0, 2), [1, 0, 0], 'zero is immediate only behind arrived letters');
assert.deepEqual(frame(500, 0, 2), [1, 1, 0]);
assert.deepEqual(frame(0, 2000, 3), [0, 0, 0], 'consecutive words restart even without a blank frame');
frame(500, 2000, 3);
assert.equal(frame(2000, 2000, 3)[0], 1, 'elapsed time survives skipped rendering frames');

// The geometry must stay fixed while opacity rises. Adjacent strips meet
// exactly, including between lines with different ascenders/descenders.
const dl = new DrawList();
function draw(age) {
  panel.begin(4, 'ab\ncd', age, 2000, 2);
  for (let k = 0; k < 2; k++) {
    panel.line = k; panel.offset = k * 2;
    for (let i = 0; i < 2; i++) panel.letter(i, 50 + i * 20, 30 + k * 40, 60 + i * 20, 50 + k * 45, true);
  }
  dl.reset(300, 200); panel.draw(dl, 0.7, 10, 5, 8, false, 40);
  return Array.from({ length: dl.count }, (_, i) => Array.from(dl.data.slice(i * STRIDE, (i + 1) * STRIDE)));
}
draw(0);
const halfway = draw(1000), full = draw(2000);
assert.equal(full.length, 6);
for (let i = 0; i < full.length; i++) {
  assert.deepEqual(halfway[i].slice(1, 6), full[i].slice(1, 6), 'fade changes opacity, never box size');
  assert.equal(halfway[i][19], 0.5); assert.equal(full[i][19], 1);
  assert.equal(full[i][22], 3, 'softness selects the feathered panel');
  if (i % 3 !== 2) assert.equal(full[i][18], full[i + 1][17], 'horizontal strips share one edge');
}
assert.equal(full[0][12], full[3][11], 'line bands meet even when ink heights differ');
assert.equal(dl.batchCount, 1, 'letters stay in a single GPU batch');
console.log('text panel: independent timing, instant mode, resets, fixed geometry, and seamless strips pass');
