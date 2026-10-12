import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The show remote's "can you hear me": health probes into the mirror-show
// room, timed until the laptop's receiver answers on the status room.
//   node tools/mirror-probe.mjs                      the cloud relay
//   node tools/mirror-probe.mjs ws://localhost:8800/room/   the local one
const KEY = readFileSync(fileURLToPath(new URL('../.mirror-key', import.meta.url)), 'utf8').trim();
const H = process.argv[2] || 'wss://the-signal-broadcast.robertalexander-music.workers.dev/room/';
const SID = 'probe' + Math.random().toString(36).slice(2, 6);
const cmd = new WebSocket(H + 'mirror-show?role=broadcast&key=' + encodeURIComponent(KEY));
const st = new WebSocket(H + 'mirror-show-status?role=follow&key=' + encodeURIComponent(KEY));
const sent = new Map(); let n = 0, statusCount = 0;
const t0 = Date.now();
cmd.onmessage = e => { if (e.data !== 'pong') console.log('cmd <-', e.data.slice(0, 120)); };
st.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.k === 'health') { if (m.to === SID) console.log('health reply', m.probe, Date.now() - sent.get(m.probe), 'ms'); }
  else { statusCount++; if (statusCount <= 2) console.log('status <-', JSON.stringify(m).slice(0, 200)); }
};
let opened = 0;
for (const w of [cmd, st]) w.onopen = () => { if (++opened === 2) go(); };
function go() {
  const iv = setInterval(() => { const p = SID + ':' + (++n); sent.set(p, Date.now()); cmd.send(JSON.stringify({ t: 'word', k: 'health', src: SID, probe: p })); }, 1000);
  setTimeout(() => { clearInterval(iv); console.log('probes sent', n, 'status msgs', statusCount); process.exit(0); }, 8000);
}
setTimeout(() => { console.log('timeout opening', cmd.readyState, st.readyState); process.exit(1); }, 15000);
