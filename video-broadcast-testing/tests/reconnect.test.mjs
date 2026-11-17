// net.js reconnect check: run, kill wrangler dev at ~3 s, restart it; watch.
globalThis.location = { search: '?relay=localhost:8787' };
const { connect } = await import('../js/net.js');
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);
const other = connect({ room: 'recon', onHello: (me, ids) => log('other hello', me, ids) });
await new Promise(r => setTimeout(r, 500));
const net = connect({
  room: 'recon',
  onHello: (me, ids) => log('hello', me, ids),
  onPeer: (id, on) => log('peer', id, on),
  onPacket: buf => log('packet from', new Uint8Array(buf)[2] | (new Uint8Array(buf)[3] << 8)),
  onStatus: s => log('status', s)
});
net.setEcho(true);
const timer = setInterval(() => net.send(new Uint8Array(30).buffer), 2000);
await new Promise(r => setTimeout(r, 28000));
clearInterval(timer);
log('stats', JSON.stringify(net.stats()));
net.close(); other.close();
process.exit(0);
