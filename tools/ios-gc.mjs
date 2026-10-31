// Listens to Safari's garbage collections on a plugged-in iPhone tab for N
// seconds and prints each one's kind and length. Needs ios_webkit_debug_proxy
// running (see tools/ios-eval.mjs).
//
//   node tools/ios-gc.mjs [seconds=6] [urlMatch=presence.now.audio]
const secs = +(process.argv[2] || 6), match = process.argv[3] || 'presence.now.audio';
const page = (await (await fetch('http://localhost:9222/json')).json()).find(p => p.url.includes(match));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let target = null, id = 0, t0 = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method: 'Target.sendMessageToTarget',
  params: { targetId: target, message: JSON.stringify({ id, method, params }) } }));
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Target.targetCreated' && !target) {
    target = m.params.targetInfo.targetId; send('Heap.enable');
    setTimeout(() => { send('Heap.disable'); setTimeout(() => process.exit(0), 300); }, secs * 1000);
  } else if (m.method === 'Target.dispatchMessageFromTarget') {
    const r = JSON.parse(m.params.message);
    if (r.error) console.log('error', r.error);
    if (r.method === 'Heap.garbageCollected') {
      const c = r.params.collection; if (!t0) t0 = c.startTime;
      console.log(c.type.padEnd(8), 'at', ((c.startTime - t0) * 1000).toFixed(0).padStart(6), 'ms  lasted', ((c.endTime - c.startTime) * 1000).toFixed(1), 'ms');
    }
  }
};
