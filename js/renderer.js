import { S } from './state.js';
import { $, cv } from './dom.js';
import { strobeNote } from './strobe-bridge.js';
import { initCanvas2D } from './renderers/canvas2d.js';
import { initWebGL2 } from './renderers/webgl2.js';
import { initWebGPU } from './renderers/webgpu.js';

export async function initRenderer() {
  const order = S.rendererPref === 'webgpu'   ? ['webgpu']
              : S.rendererPref === 'webgl2'   ? ['webgl2']
              : S.rendererPref === 'canvas2d' ? ['canvas2d']
              : ['webgpu', 'webgl2', 'canvas2d'];
  for (const kind of order) {
    let r = null;
    try {
      r = kind === 'webgpu' ? await initWebGPU()
        : kind === 'webgl2' ? initWebGL2()
        : initCanvas2D(cv);
    } catch (e) { console.warn(kind + ' init failed:', e); r = null; }
    if (r) {
      S.renderer = r;
      $('rendName').textContent = r.name + (S.rendererPref === 'auto' ? '' : ' (forced)') + strobeNote();
      return;
    }
    // a failed getContext() poisons the canvas for other kinds, so a forced
    // choice that cannot start falls back to the full auto chain
    if (S.rendererPref !== 'auto') {
      console.warn('forced renderer "' + S.rendererPref + '" unavailable, falling back');
      S.rendererPref = 'auto';
      return initRenderer();
    }
  }
  $('rendName').textContent = 'none available';
}
