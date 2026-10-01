// Which thread the engine runs on: the page's main thread (the default), or a
// Web Worker drawing into the canvas through an OffscreenCanvas, so nothing
// the page's own thread does (a garbage collection, a long task, a busy
// audio callback) can hold up a strobe frame. The Render section's Engine
// thread control reads and sets this.
//
// A WebGPU device belongs to the thread that made it and cannot move, so the
// choice is stored and applied on the next load. It lives under a key of its
// own, v1 only, never in the shared settings record: it describes this
// browser, not the session, and presets and other tabs have no business
// moving it. The platform side writes it (platform/worker-bridge.js on the
// page, the worker platform inside the worker, which posts the write to the
// page); this file only keeps the state the control shows.
//
// `active` is the thread this load actually runs on. `wanted` is what is
// stored, which differs from `active` from the moment the viewer changes it
// until the next reload, and also when a worker was asked for but this
// browser could not provide one (`available` false: no OffscreenCanvas, no
// module workers, or no WebGPU inside a worker), in which case the engine
// has quietly stayed on the main thread.

export const ENGINE_THREAD_KEY = 'signal.v1.worker';

export const engineThread = {
  active: 'main',
  wanted: 'main',
  available: true
};

let write = null;

// store(value) persists the choice: '1' for the worker, '0' for the main thread.
export function initEngineThread(active, wanted, available, store) {
  engineThread.active = active;
  engineThread.wanted = wanted;
  engineThread.available = !!available;
  write = store;
}

export function setEngineThreadWanted(v) {
  const next = v === 'worker' ? 'worker' : 'main';
  if (next === engineThread.wanted) return;
  engineThread.wanted = next;
  if (write) write(next === 'worker' ? '1' : '0');
}

// The control's readout: what this load is doing, or what the next one will.
export function engineThreadStatus() {
  if (engineThread.wanted === 'worker' && !engineThread.available) return 'unavailable';
  if (engineThread.wanted !== engineThread.active) return 'reload to apply';
  return engineThread.active === 'worker' ? 'running in a worker' : 'running on the page';
}
