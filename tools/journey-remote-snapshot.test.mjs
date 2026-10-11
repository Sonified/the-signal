// Real Journey/schema/performer and remote receiver; isolated storage,
// sockets and audio so no commands or settings reach a live performance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
const noop = () => {};
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = globalThis;
globalThis.addEventListener = globalThis.removeEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
globalThis.document = any;
for (const k of ['AudioContext', 'Worker', 'BroadcastChannel', 'ResizeObserver', 'Image', 'WebSocket', 'Audio', 'OffscreenCanvas', 'MessageChannel', 'AudioWorkletNode', 'GainNode', 'OscillatorNode', 'MediaStream', 'IntersectionObserver', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'EventTarget', 'FontFace', 'fetch', 'screen', 'visualViewport']) globalThis[k] ??= any;
globalThis.location = { search: '', hostname: 'localhost', href: 'http://localhost/' };
globalThis.requestAnimationFrame = noop;
globalThis.dispatchEvent = () => true;
let now = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
const originalLog = console.log;
console.log = noop;
const { S } = await import(root + '/js/state.js');
const J = await import(root + '/core/journey.js');
const P = await import(root + '/core/perform.js');
const { byId } = await import(root + '/core/schema.js');
const ST = await import(root + '/core/store.js');
ST.initStore({ get: k => store.get(k) ?? null, set: (k, v) => store.set(k, v) });
ST.load();
const flush = () => new Promise(r => setTimeout(r, 0));
const run = sec => {
  const end = now + sec * 1000;
  while (now < end) { now += 1000 / 30; J.stepJourney(now); P.perfTick(now); }
};
J.stepJourney(now); P.perfTick(now);
for (let i = 0; i < 17; i++) J.journeyAddStep();
J.journeyStop(); J.journeyDeselect(); J.journeySetWindowOpen(true);
J.journeySetRamp(2, 0); J.journeySetRamp(16, 0);
J.journeySetOverride(16, 'heartMaster', 90);
J.journeySelect(2); await flush();

// Use the actual command routing, including finale faders and status output.
const sockets = [], timers = [];
class Socket {
  readyState = 1; sent = [];
  constructor(url) { this.url = url; sockets.push(this); }
  send(text) { if (text !== 'ping') this.sent.push(JSON.parse(text)); }
}
const ctx = vm.createContext({ URLSearchParams, WebSocket: Socket, document: {},
  location: { search: '?remote' }, localStorage: { getItem: () => 'isolated-test' },
  fetch: () => Promise.resolve({ status: 200 }), setTimeout() {},
  setInterval: (fn, ms) => timers.push({ fn, ms }), console: { log() {}, warn(...v) { throw Error(v.join(' ')); } }
});
const source = fs.readFileSync(root + '/platform/show-remote.js', 'utf8');
const imports = new Map([...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].map(m => [m[2], m[1].split(',').map(x => x.trim())]));
const values = { S, byId, ...J, idleWake: noop, slidesLiveState: () => 0, slidesProgress: () => null,
  ampToPos: (await import(root + '/js/util.js')).ampToPos };
const remote = new vm.SourceTextModule(source, { context: ctx });
await remote.link(spec => new vm.SyntheticModule(imports.get(spec), function () {
  for (const name of imports.get(spec)) this.setExport(name, name in values ? values[name] : noop);
}, { context: ctx }));
await remote.evaluate(); remote.namespace.initShowRemote();
let n = 0;
const send = m => {
  const message = JSON.stringify({ t: 'word', src: 'isolated-ipad', n: ++n, ...m });
  for (const s of sockets.filter(s => s.url.includes('role=follow'))) s.onmessage({ data: message });
};
const ctl = (id, v) => send({ k: 'ctl', id, v });
const get = id => byId(id).get(S);
const step = i => J.journeyStepAt(i);
const scene = i => JSON.stringify(step(i).overrides);

// A queued laptop edit must not sweep an intervening iPad move into it.
P.perfSet('fieldOpacity', 18, true);
ctl('heartMaster', 40);
await flush();
assert.equal(step(2).overrides.fieldOpacity, 18);
assert.equal(step(2).overrides.heartMaster, 100);
assert.equal(get('heartMaster'), 40);
const authored = scene(2);
for (const [id, v] of [['heartMaster', 45], ['slideRate', 250], ['slidePlay', false], ['slideXfade', 200], ['mwtsVolume', 55],
  ['finaleDrone', 50], ['finalePiano', 45], ['finaleChoir', 30], ['finaleAmb', 80], ['finaleHum', 50], ['finaleSun', 50], ['finaleWind', 75]]) ctl(id, v);
await flush(); run(4); await flush();
assert.equal(scene(2), authored, 'all iPad faders leave the edited step intact');
byId('fieldOpacity').set(S, 55); await flush();
assert.equal(step(2).overrides.heartMaster, 100, 'later unrelated save cannot capture the live HEART value');
assert.equal(step(2).overrides.slideRate, 500, 'later unrelated save cannot capture SPEED');
assert.equal(step(2).overrides.bedVol, JSON.parse(authored).bedVol, 'finale controls and their twins stay performance-only');

// Deliberately moving the same laptop control remains an authoring gesture.
P.perfSet('heartMaster', 60, true); await flush();
assert.equal(step(2).overrides.heartMaster, 60);
ctl('heartMaster', 40); await flush();
J.journeySetText(2, 'Keep this cue text'); J.journeySetHold(2, 12);
S.seqs[0].vol = 0.37; S.chanMute.drone = true;
const other = JSON.stringify(step(16)), count = J.journeyCount(), selected = J.journeySelected();
assert.equal(J.journeySnapshotStep(2), true);
assert.equal(step(2).overrides.heartMaster, 40);
assert.equal(step(2).overrides.slideRate, get('slideRate'));
assert.equal(step(2).overrides.bedVol, get('bedVol'));
assert.equal(step(2).seq.seqs[0].vol, 0.37);
assert.equal(step(2).mix.chanMute.drone, true);
assert.equal(step(2).text, 'Keep this cue text');
assert.equal(step(2).holdS, 12);
assert.equal(JSON.stringify(step(16)), other, 'snapshot changes only its target step');
assert.equal(J.journeyCount(), count);
assert.equal(J.journeySelected(), selected);
assert.equal(J.journeyPlaying(), false);
S.seqs[0].vol = 0.99;
assert.equal(step(2).seq.seqs[0].vol, 0.37, 'snapshot owns its sequencer copy');

// iPad gestures must take the current ramp, but never pin later cues.
J.journeySetRamp(2, 2);
J.journeyPlayFrom(16); J.journeyPlayFrom(2); run(0.2);
ctl('heartMaster', 80); await flush(); run(0.5); await flush();
assert.equal(get('heartMaster'), 80, 'active ramp no longer overwrites the remote adjustment');
assert.equal(step(2).overrides.heartMaster, 40);
assert.equal(J.journeySnapshotStep(2), true);
assert.equal(step(2).overrides.heartMaster, 80);
assert.equal(J.journeyPlaying(), true, 'snapshot does not interrupt playback');
assert.equal(J.journeyPlayIdx(), 2);
J.journeyPause(); ctl('heartMaster', 75); await flush();
assert.equal(step(2).overrides.heartMaster, 80, 'paused playback also protects the step');
J.journeyStop(); byId('fieldOpacity').set(S, 35); await flush();
assert.equal(step(2).overrides.heartMaster, 80, 'stopping cannot accidentally commit a remote gesture');
assert.equal(J.journeySnapshotStep(2), true);
assert.equal(step(2).overrides.heartMaster, 75);

send({ k: 'jump', i: 16 }); await flush();
assert.equal(get('heartMaster'), 90);
send({ k: 'jump', i: 2 }); run(3); await flush();
assert.equal(get('heartMaster'), 75, 'iPad cue recall restores the explicit snapshot');
for (const { fn, ms } of timers) if (ms === 250) fn();
const status = sockets.flatMap(s => s.sent).filter(m => m.t === 'state').at(-1);
assert.equal(status.i, 2);
assert.equal(status.sl.hm, 75, 'reported fader value updates the iPad after cue recall');
assert.equal(J.journeySnapshotStep(98), false);

await new Promise(r => setTimeout(r, 100));
const index = JSON.parse(store.get('signal.journeys.v1'));
const key = 'signal.journey.v1.' + index.cur;
assert.equal(JSON.parse(store.get(key)).steps[2].overrides.heartMaster, 75);
J.syncJourneyFromStorage(key);
assert.equal(step(2).overrides.heartMaster, 75, 'explicit snapshot survives a storage reload');
console.log = originalLog;
console.log('PASS: iPad performance isolation, explicit snapshots, current ramp takeover, cue recall, iPad status and persistence.');
process.exit(0);
