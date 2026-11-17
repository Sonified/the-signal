// Protocol check for the video test relay, against wrangler dev on :8787.
const BASE = 'ws://localhost:8787/room/proto-' + Date.now();
let fails = 0;
const ok = (c, what) => { console.log((c ? 'PASS ' : 'FAIL ') + what); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

function join() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(BASE);
    ws.binaryType = 'arraybuffer';
    const c = { ws, text: [], bin: [] };
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        if (e.data === 'pong') { c.text.push({ pong: 1 }); return; }
        const m = JSON.parse(e.data);
        c.text.push(m);
        if (m.t === 'hello') { c.id = m.you; c.hello = m; res(c); }
      } else c.bin.push(new Uint8Array(e.data));
    };
    ws.onerror = rej;
  });
}
const clear = (...cs) => cs.forEach(c => { c.text = []; c.bin = []; });

const a = await join();
ok(a.hello.ids.length === 0 && a.id >= 1, 'A hello, alone: ' + JSON.stringify(a.hello));
const b = await join();
await wait(200);
ok(b.hello.ids.join() === String(a.id) && b.id > a.id, 'B hello lists A: ' + JSON.stringify(b.hello));
ok(a.text.some(m => m.t === 'peer' && m.id === b.id && m.on === 1), 'A hears B arrive');
const c = await join();
await wait(200);
ok(c.hello.ids.slice().sort().join() === [a.id, b.id].sort().join(), 'C hello lists A and B');
clear(a, b, c);

// time
a.ws.send(JSON.stringify({ t: 'time', c: 123.5 }));
await wait(200);
const tm = a.text.find(m => m.t === 'time');
ok(tm && tm.c === 123.5 && Math.abs(tm.s - Date.now()) < 5000, 'time reply ' + JSON.stringify(tm));
ok(!b.text.some(m => m.t === 'time'), 'time reply only to sender');

// ping
a.ws.send('ping');
await wait(200);
ok(a.text.some(m => m.pong), 'ping answered pong');
clear(a, b, c);

// binary
const pkt = new Uint8Array(40);
for (let i = 0; i < 40; i++) pkt[i] = (i * 7 + 3) & 255;
pkt[2] = 0; pkt[3] = 0;
a.ws.send(pkt.buffer.slice(0));
await wait(300);
const check = (got) => {
  if (!got || got.length !== 40) return false;
  if ((got[2] | (got[3] << 8)) !== a.id) return false;
  for (let i = 0; i < 40; i++) if (i !== 2 && i !== 3 && got[i] !== pkt[i]) return false;
  return true;
};
ok(b.bin.length === 1 && check(b.bin[0]), 'B gets A\'s packet with id stamped');
ok(c.bin.length === 1 && check(c.bin[0]), 'C gets A\'s packet with id stamped');
ok(a.bin.length === 0, 'A does not get its own packet with echo off');
clear(a, b, c);

// short binary
a.ws.send(new Uint8Array(23).buffer);
await wait(300);
ok(b.bin.length === 0 && c.bin.length === 0, 'short packet dropped');

// echo on
a.ws.send(JSON.stringify({ t: 'echo', on: 1 }));
await wait(100);
a.ws.send(pkt.buffer.slice(0));
await wait(300);
ok(a.bin.length === 1 && check(a.bin[0]), 'echo on: A gets its own packet back');
ok(b.bin.length === 1 && c.bin.length === 1, 'echo on: others still get it');
ok(!b.text.some(m => m.t === 'echo'), 'echo message not relayed');
clear(a, b, c);
a.ws.send(JSON.stringify({ t: 'echo', on: 0 }));
await wait(100);
a.ws.send(pkt.buffer.slice(0));
await wait(300);
ok(a.bin.length === 0 && b.bin.length === 1, 'echo off again');
clear(a, b, c);

// json relay
b.ws.send(JSON.stringify({ t: 'key', want: a.id }));
b.ws.send('not json');
b.ws.send('[1,2]');
await wait(300);
const ka = a.text.find(m => m.t === 'key'), kc = c.text.find(m => m.t === 'key');
ok(ka && ka.from === b.id && ka.want === a.id && kc && kc.from === b.id, 'JSON relayed with from ' + JSON.stringify(ka));
ok(!b.text.some(m => m.t === 'key'), 'JSON not sent back to sender');
ok(a.text.length === 1 && c.text.length === 1, 'non-object text ignored');
clear(a, b, c);

// leave
c.ws.close();
await wait(500);
ok(a.text.some(m => m.t === 'peer' && m.id === c.id && m.on === 0), 'A hears C leave');
ok(b.text.some(m => m.t === 'peer' && m.id === c.id && m.on === 0), 'B hears C leave');
ok(a.text.filter(m => m.t === 'peer').length === 1, 'leave told once');

// a new member never reuses an id
const d = await join();
ok(d.id > c.id, 'new member gets a fresh id ' + d.id);

// non-room request
const r = await fetch('http://localhost:8787/');
console.log('GET / ->', r.status, JSON.stringify(await r.text()));

// net.js against the same relay
globalThis.location = { search: '?relay=localhost:8787' };
const { connect } = await import('../js/net.js');
const room = BASE.split('/').pop();
const seen = [];
let hello = null;
const net = connect({
  room,
  onHello(me, ids) { hello = { me, ids }; },
  onPeer(id, on) { seen.push(['peer', id, on]); },
  onPacket(buf) { seen.push(['pkt', buf.byteLength, new Uint8Array(buf)[2] | (new Uint8Array(buf)[3] << 8)]); },
  onMessage(msg) { seen.push(['msg', msg]); },
  onStatus(s) { seen.push(['status', s]); }
});
await wait(2500);
ok(hello && hello.me === net.id && hello.ids.sort().join() === [a.id, b.id, d.id].sort().join(), 'net.js hello ' + JSON.stringify(hello));
const st = net.stats();
console.log('net.stats after 2.5 s:', JSON.stringify(st), 'offset vs Date.now:', (net.now() - Date.now()).toFixed(1), 'ms');
ok(st.rtt !== null && st.people === 4 && st.status === 'open', 'net.js stats');
ok(Math.abs(net.now() - Date.now()) < 50, 'net.now close to Date.now locally');
net.setEcho(true);
await wait(100);
ok(net.send(pkt.buffer.slice(0)) === true, 'net.send returns true');
a.ws.send(pkt.buffer.slice(0));
net.sendJSON({ t: 'key' });
await wait(300);
const pk = seen.filter(s => s[0] === 'pkt');
ok(pk.some(p => p[2] === net.id) && pk.some(p => p[2] === a.id), 'net.js got its echo and A\'s packet ' + JSON.stringify(pk));
ok(a.text.some(m => m.t === 'key' && m.from === net.id), 'net.sendJSON relayed');
b.ws.send(JSON.stringify({ t: 'hi' }));
await wait(200);
ok(seen.some(s => s[0] === 'msg' && s[1].t === 'hi' && s[1].from === b.id), 'net.js onMessage');
// a forced drop: the relay closes nothing, so close the raw socket from here by
// simulating a reconnect: kill the server side is not possible, so just close
net.close();
await wait(300);
ok(seen.some(s => s[0] === 'status' && s[1] === 'closed') && net.id === 0, 'net.close');
ok(net.send(pkt.buffer.slice(0)) === false, 'net.send false when closed');
await wait(300);
ok(a.text.some(m => m.t === 'peer' && m.on === 0), 'others hear net.js leave');

for (const x of [a, b, d]) x.ws.close();
await wait(200);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
