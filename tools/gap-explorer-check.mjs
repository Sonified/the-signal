// A headless look at tools/gap-explorer.html: loads it in a throwaway
// headless Chrome (its profile in tools/.headless-profiles/, git-ignored),
// prints the page's console (the gap list and the Dynamic allocation among
// it), then plays a few steps and samples the readouts, so the fades' sync
// can be read without anyone's own browser. Screenshots land in the profile
// folder.
//
//   node tools/gap-explorer-check.mjs [steps]
//
// steps: a comma list run in order, each "<what>:<seconds>", where what is
// a key to press (space, comma or , . [ ] 1 2 4 8 6 3 v), "bridge" (switch
// it on), "reload", "shot" (a screenshot), "#id" or "[data-x=y]" (click
// it), "#id=value" (set a slider as a drag does, input only; or a menu:
// #record=twoyear) or "#id^" (let go of a slider: change and pointerup);
// sampling the readouts (with the rung in hand and how many times the
// decoders have loaded a file) every 250 ms between steps (EVERY=ms to
// change, DEC=1 to sample the decoders instead, READ=<expression> to sample
// that).
// Needs tools/serve.mjs on port 8000.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const steps = (process.argv[2] || 'wait:6,shot:0,]:3,space:9,shot:0,space:1,8:4,space:6,space:1,v:3,shot:0').split(',').map(s => s.split(':'));
const DIR = new URL('./.headless-profiles', import.meta.url).pathname;
fs.mkdirSync(DIR, { recursive: true });
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900',
  `--remote-debugging-port=${port}`, `--user-data-dir=${DIR}/prof_${port}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const t0 = performance.now();
const stamp = () => String(performance.now() - t0 | 0).padStart(6) + 'ms';
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') console.log(stamp() + ' ' + m.params.type + ' ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Runtime.exceptionThrown') console.log(stamp() + ' EXCEPTION ' + m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? ''));
});
const send = (method, params = {}) => new Promise(r => { ws.send(JSON.stringify({ id: ++id, method, params })); pending.set(id, r); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:8000/tools/gap-explorer.html' });
// the readouts, one line
const READ = process.env.READ ? process.env.READ : process.env.DEC ? `JSON.stringify(gapExplorer.decoders().map(d => d.name + (d.master ? "*" : "") + " g" + d.gap + " " + d.src + (d.paused ? " p" : " >") + (d.ready ? "" : " ~") + " r" + d.rate + " e" + d.err))` : `[...document.querySelectorAll("#now .v")].map(e => e.textContent).join(" | ") + " || " + document.getElementById("note").textContent + " || rung " + gapExplorer.rung() + " loads " + gapExplorer.loads()`;
let shots = 0;
for (const [what, secs] of steps) {
  if (what === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = `${DIR}/shot_${++shots}.png`;
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log(stamp() + ' screenshot ' + f);
  } else if (what === 'reload') {
    await send('Page.reload');
  } else if (what === 'bridge') {
    await evaluate(`document.querySelector('#bridges [data-b="1"]').click()`);
  } else if (what.startsWith('#') && what.endsWith('^')) {
    // the end of a slider drag
    await evaluate(`(e => { for (const t of ['change', 'pointerup']) e.dispatchEvent(new Event(t)); })(document.querySelector(${JSON.stringify(what.slice(0, -1))}))`);
  } else if (what.startsWith('#') && what.includes('=')) {
    // a slider: #id=value
    const [sel, val] = what.split('=');
    await evaluate(`(e => { e.value = ${JSON.stringify(val)}; (e.oninput || e.onchange)(); })(document.querySelector(${JSON.stringify(sel)}))`);
  } else if (what.startsWith('#') || what.startsWith('[')) {
    // a button, by selector
    await evaluate(`document.querySelector(${JSON.stringify(what)}).click()`);
  } else if (what !== 'wait') {
    const key = what === 'space' ? ' ' : what === 'comma' ? ',' : what;
    await evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)} }))`);
  }
  console.log(stamp() + ' step ' + what);
  const end = performance.now() + Number(secs) * 1000;
  let last = '';
  while (performance.now() < end) {
    const s = await evaluate(READ);
    if (s !== last) { console.log(stamp() + '   ' + s); last = s; }
    await sleep(Number(process.env.EVERY || 250));
  }
}
console.log('runtime: ' + await evaluate(`[...document.querySelectorAll('#runtime .v')].map(e => e.textContent).join(' | ')`));
console.log('status: ' + await evaluate(`document.getElementById('status').textContent`));
await send('Browser.close').catch(() => {});
ws.close(); await sleep(300);
if (chrome.exitCode === null) chrome.kill('SIGTERM');
