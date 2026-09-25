// The engine worker's entry module (worker mode, see core/engine-thread.js).
// The page's shell (platform/worker-bridge.js) starts it and says hello with
// a copy of its storage and its host facts. From there:
//
//   1. the worker platform is built from that (platform/worker-platform.js)
//      and put where main.js looks for it (platform/host.js);
//   2. it checks that WebGPU is on offer in this thread, then loads the audio
//      link (core/audio-link.js) and main.js itself, the whole engine, whose
//      boot starts and then waits for the canvas;
//   3. it answers ready (or fail, with the reason, and the page carries on
//      without it); only then does the page transfer the canvas, and boot
//      carries on here exactly as it would on the page.
//
// After that it is a router: the page's bare Float32Arrays are the audio
// readings for the link, and everything else is for the platform.

// First, before any v0 module is evaluated: the page globals they touch.
import './platform/worker-shim.js';
import { host } from './platform/host.js';
import { createWorkerPlatform } from './platform/worker-platform.js';

let wp = null, link = null, resolvePlatform = null;
let seeded = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = e => {
  const d = e.data;
  if (d instanceof Float32Array) { if (link) link.receiveMirror(d); return; }
  if (!d) return;
  if (d.k === 'hello') { start(d.init); return; }
  if (d.k === 'canvas') {
    wp.attach(d.canvas, d.size);
    resolvePlatform(wp.platform);
    return;
  }
  if (wp) wp.handle(d);
};

async function start(init) {
  wp = createWorkerPlatform(init, post);
  host.worker = true;
  host.platform = new Promise(r => { resolvePlatform = r; });
  host.profileHost = wp.profileHost;
  // main.js hands a failed boot here. Before the first frame the page would
  // otherwise stay black on every load, so it is reported through the
  // platform's message, which before any frame also puts the choice back to
  // the main thread (worker-bridge.js).
  host.bootFailed = err => {
    console.warn('[engine] boot failed in the worker:', err);
    wp.platform.message('The engine could not start in its worker (' + (err && err.message ? err.message : String(err)) +
      '). Reload the page to run it on the main thread.');
  };

  let why = '';
  try {
    if (!navigator.gpu) why = 'this browser offers no WebGPU inside a worker';
    else if (!(await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))) why = 'no WebGPU adapter inside a worker';
  } catch (err) {
    why = 'the WebGPU adapter request failed in the worker (' + (err && err.message || err) + ')';
  }

  if (!why) {
    try {
      const { createAudioLink } = await import('./core/audio-link.js');
      const { initEngineThread, ENGINE_THREAD_KEY } = await import('./core/engine-thread.js');
      const platform = wp.platform;
      link = createAudioLink(calls => post(calls));
      host.link = link;
      wp.setBeforeWrite(link.flush);
      initEngineThread('worker', platform.storage.get(ENGINE_THREAD_KEY) === '1' ? 'worker' : 'main', true,
        v => platform.storage.set(ENGINE_THREAD_KEY, v));
      // The link takes its baseline at the start of the first frame, before
      // that frame's input is read.
      const poll = platform.pollInput;
      platform.pollInput = () => {
        if (!seeded) { seeded = true; link.seed(); }
        return poll();
      };
      await import('./main.js');
    } catch (err) {
      why = 'the engine did not load in the worker (' + (err && err.message || err) + ')';
    }
  }
  post(why ? { k: 'fail', why } : { k: 'ready' });
}
