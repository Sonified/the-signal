// Records Safari's Timeline, GC and JS sampling on a plugged-in iPhone tab
// for N seconds and writes the raw events to a JSON file. Needs
// ios_webkit_debug_proxy running (see tools/ios-eval.mjs).
//
//   node tools/ios-timeline.mjs [seconds=6] [out=tools/ios-timeline.out.json] [urlMatch]

const secs = +(process.argv[2] || 6);
const out = process.argv[3] || 'tools/ios-timeline.out.json';
const match = process.argv[4] || 'presence.now.audio';
import { writeFileSync } from 'node:fs';

const pages = await (await fetch('http://localhost:9222/json')).json();
const page = pages.find(p => p.url.includes(match));
if (!page) { console.error('no tab matching', match); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let outer = 0, innerId = 0, target = null;
const events = [];
function send(method, params = {}) {
  ws.send(JSON.stringify({ id: ++outer, method: 'Target.sendMessageToTarget',
    params: { targetId: target, message: JSON.stringify({ id: ++innerId, method, params }) } }));
}

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Target.targetCreated' && !target) {
    target = m.params.targetInfo.targetId;
    send('Runtime.enable');
    send('Heap.enable');
    send('ScriptProfiler.startTracking', { includeSamples: true });
    send('Timeline.enable');
    send('Timeline.setInstruments', { instruments: ['ScriptProfiler', 'Timeline', 'Heap', 'CPU'] });
    send('Timeline.start', { maxCallStackDepth: 8 });
    setTimeout(() => { send('Timeline.stop'); send('ScriptProfiler.stopTracking'); }, secs * 1000);
    setTimeout(() => {
      writeFileSync(out, JSON.stringify(events));
      console.log('wrote', events.length, 'messages to', out);
      ws.close(); process.exit(0);
    }, secs * 1000 + 4000);
  } else if (m.method === 'Target.dispatchMessageFromTarget') {
    events.push(JSON.parse(m.params.message));
  }
};
