// Runs a JavaScript expression in a Safari tab on a plugged-in iPhone and
// prints its value. Needs ios_webkit_debug_proxy running (brew install
// ios-webkit-debug-proxy; then `ios_webkit_debug_proxy -F`).
//
//   node tools/ios-eval.mjs '<expression>' [urlMatch=presence.now.audio]
//
// The value is returned by value, so hand back JSON-able things. A promise
// is awaited.

const expr = process.argv[2];
const match = process.argv[3] || 'presence.now.audio';
if (!expr) { console.error('usage: node tools/ios-eval.mjs <expr> [urlMatch]'); process.exit(1); }

const pages = await (await fetch('http://localhost:9222/json')).json();
const page = pages.find(p => p.url.includes(match));
if (!page) { console.error('no tab matching', match, pages.map(p => p.url)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let outer = 0, target = null;
const done = (v, code = 0) => { console.log(v); ws.close(); process.exit(code); };
setTimeout(() => done('timeout', 1), 60000);

function inner(method, params) {
  ws.send(JSON.stringify({ id: ++outer, method: 'Target.sendMessageToTarget',
    params: { targetId: target, message: JSON.stringify({ id: 1, method, params }) } }));
}

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Target.targetCreated' && !target) {
    target = m.params.targetInfo.targetId;
    inner('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  } else if (m.method === 'Target.dispatchMessageFromTarget') {
    const r = JSON.parse(m.params.message);
    if (r.id !== 1) return;
    if (r.error) done('error ' + JSON.stringify(r.error), 1);
    const res = r.result;
    if (res.wasThrown || res.exceptionDetails) done('thrown ' + JSON.stringify(res.result), 1);
    const v = res.result.value;
    done(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  }
};
ws.onerror = e => done('ws error ' + (e.message || e), 1);
