// Prints a plugged-in iPhone tab's console for N seconds (Safari's Console
// domain, through ios_webkit_debug_proxy; see tools/ios-eval.mjs).
//
//   node tools/ios-console.mjs [seconds=10] [filterRegex] [urlMatch=presence.now.audio]
const secs = +(process.argv[2] || 10);
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
const match = process.argv[4] || 'presence.now.audio';
const page = (await (await fetch('http://localhost:9222/json')).json()).find(p => p.url.includes(match));
if (!page) { console.error('no tab matching', match); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let target = null, id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method: 'Target.sendMessageToTarget',
  params: { targetId: target, message: JSON.stringify({ id, method, params }) } }));
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Target.targetCreated' && !target) {
    target = m.params.targetInfo.targetId; send('Console.enable');
    setTimeout(() => process.exit(0), secs * 1000);
  } else if (m.method === 'Target.dispatchMessageFromTarget') {
    const r = JSON.parse(m.params.message);
    if (r.method === 'Console.messageAdded') {
      const t = r.params.message.text;
      if (!filter || filter.test(t)) console.log(t);
    }
  }
};
