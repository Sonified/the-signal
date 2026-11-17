// The relay knows who is who: a device that joins again with the same token
// keeps its id, its old connection is retired (told {t:'replaced'}, then
// closed), and nobody is told it left. Runs against a relay address (default: wrangler dev on :8787).
//   node tests/relay-who.test.mjs [ws://localhost:8787 | wss://<deployed host>]
const BASE = (process.argv[2] || 'ws://localhost:8787') + '/room/who-' + Date.now();
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

function join(who) {
  return new Promise((res, rej) => {
    const w = new WebSocket(BASE + (who ? '?who=' + who : ''));
    w.binaryType = 'arraybuffer';
    w.text = []; w.bin = []; w.closed = null;
    w.onmessage = e => { if (typeof e.data === 'string') { if (e.data !== 'pong') w.text.push(JSON.parse(e.data)); } else w.bin.push(new Uint8Array(e.data)); };
    w.onclose = e => { w.closed = e.code; };
    w.onopen = () => res(w);
    w.onerror = () => rej(new Error('could not connect to ' + BASE));
  });
}
const hello = w => w.text.find(m => m.t === 'hello');
const packet = last => { const b = new Uint8Array(40); b[0] = 1; b[39] = last; return b.buffer; };

const tokenA = 'device-a-' + Date.now();
const a1 = await join(tokenA); await wait(400);
const b = await join('device-b-' + Date.now()); await wait(400);
const idA = hello(a1).you, idB = hello(b).you;
ok(idA > 0 && idB > 0 && idA !== idB, `two devices, two numbers: ${idA} and ${idB}`);

// the same device joins again while its old connection still looks open
b.text.length = 0;
const a2 = await join(tokenA); await wait(700);
ok(hello(a2).you === idA, `the returning device keeps its number: ${hello(a2).you}`);
ok(!hello(a2).ids.includes(idA) && hello(a2).ids.includes(idB), `it is told who else is here, not itself: ${JSON.stringify(hello(a2).ids)}`);
ok(a1.text.some(m => m.t === 'replaced'), 'its old connection was told it has been replaced');
b.send(packet(9)); await wait(500);
ok(a1.bin.length === 0 && a2.bin.length === 1, `pictures go to the new connection only: old ${a1.bin.length}, new ${a2.bin.length}`);
ok(!b.text.some(m => m.t === 'peer' && m.on === 0), 'nobody was told it left');
ok(b.text.some(m => m.t === 'peer' && m.id === idA && m.on === 1), 'the other device was told it is here (so it sends a full picture)');

// pictures from the new connection carry the same number
a2.send(packet(55)); await wait(600);
const got = b.bin.at(-1);
ok(got && (got[2] | (got[3] << 8)) === idA && got[39] === 55, 'its pictures arrive under the same number');

// a clean goodbye, then back again: still the same number, and this time the others are told it left
b.text.length = 0;
a2.close(); await wait(600);
ok(b.text.some(m => m.t === 'peer' && m.id === idA && m.on === 0), 'a real goodbye is announced');
const a3 = await join(tokenA); await wait(500);
ok(hello(a3).you === idA, `back after a goodbye, same number: ${hello(a3).you}`);

// no token: a nameless member with a fresh number
const c = await join(''); await wait(400);
ok(hello(c).you !== idA && hello(c).you !== idB, `a nameless joiner gets a fresh number: ${hello(c).you}`);

for (const w of [a3, b, c]) w.close();
await wait(300);
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
