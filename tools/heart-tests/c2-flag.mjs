// route.js: the flag, and the answers each family gets with Heart off.
// Run: node --test tools/heart-tests/c2-flag.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './c2-harness.mjs';

const h = await load();
const { parseHeartFlag, ctxFor, masterFor, makeWorklet, heartOn, heartEngine, startHeart } = h.route;
const flag = (search, stored) => [...parseHeartFlag(search, stored)].sort();

test('absent or off is native', () => {
  assert.deepEqual(flag('', null), []);
  assert.deepEqual(flag('', 'off'), []);
  assert.deepEqual(flag('?heart=off', 'all'), [], 'the URL overrides storage');
});

test('all, and comma lists of families, forgiving of case and spaces', () => {
  assert.deepEqual(flag('', 'all'), ['ambience', 'clouds', 'genus', 'music']);
  assert.deepEqual(flag('?heart=music,clouds', null), ['clouds', 'music']);
  assert.deepEqual(flag('?x=1&heart=Genus%2C%20ambience', 'music'), ['ambience', 'genus']);
  assert.deepEqual(flag('', 'clouds,nonsense'), ['clouds'], 'unknown names are dropped');
  assert.deepEqual(flag('?heart=', 'genus'), ['genus'], 'an empty URL value leaves storage in charge');
});

test('with no page to read (node), the flag is simply off', () => {
  assert.deepEqual([...parseHeartFlag()], []);
});

test('Heart off: every family gets the native context and master', async () => {
  const native = { isHeart: undefined }, master = { name: 'volGain' };
  assert.equal(await startHeart(native, master), null);
  assert.equal(ctxFor('music'), native);
  assert.equal(masterFor('clouds'), master);
  assert.equal(heartOn('genus'), false);
  assert.equal(heartEngine(), null);
});

test('makeWorklet makes a Heart processor on a Heart context', () => {
  const { ctx } = h.rig();
  const node = makeWorklet(ctx, 'one-pole', { outputChannelCount: [2] });
  assert.ok(node instanceof h.HeartProcessor);
  assert.ok(node.parameters.get('frequency'));
});
