// Test-only instrumentation of the real renderer, not a second pool.
// The reference variant restores the former radius sort for A/B comparison.
export function instrumentKaleido(source, reference = false, browser = false) {
  if (reference) {
    source = source.replace('const i = order[n], b = bornT[i];', 'const i = order[n], b = depth[i];')
      .replace('bornT[order[m]] < b', 'depth[order[m]] > b');
  }
  source = source.replace('const depth = new Float32Array(MAX_SHAPES);',
    'const depth = new Float32Array(MAX_SHAPES); const identity = new Uint32Array(MAX_SHAPES); let serial = 0;');
  source = source.replace('depth[i] = d;\n    velPh', 'depth[i] = d; identity[i] = ++serial;\n    velPh');
  source = source.replace('if (KDIAG) dgSlot[n] = i;', 'dgSlot[n] = i;');
  source = source.replace(/return \{ update, encodeChamber, draw, resize(?:, inspect)? \};/, `return { update, encodeChamber, draw, resize,
    test: {
      init() { ready = true; requestedSet = slots[cur].set = 1;
        requestedUrl = slots[cur].url = atlasUrl(kaleidoscopeSet(1));
        slots[cur].allowedCount = 64; slots[cur].meanFill = DEFAULT_FILL;
        for (let i = 0; i < 64; i++) slots[cur].allowed[i] = i;
        slots[cur].familyMask = 31; },
      snapshot() { return { live, serial, clockS, instCount,
        instances: Array.from({ length: instCount }, (_, n) => ({
          id: identity[dgSlot[n]], slot: dgSlot[n], depth: depth[dgSlot[n]],
          born: bornT[dgSlot[n]], values: Array.from(inst.subarray(n * 8, n * 8 + 8))
        })), uniform: Array.from(uni) }; },
      previousOrder(ids) {
        const rank = new Map(ids.map((id, n) => [id, n]));
        const rows = Array.from({ length: instCount }, (_, n) => ({
          id: identity[dgSlot[n]], values: inst.slice(n * 8, n * 8 + 8)
        }));
        // Newly visible pieces have no previous drawn rank. Leave their
        // current slots alone and only permute pieces drawn in both frames.
        const continuing = rows.filter(row => rank.has(row.id))
          .sort((a, b) => rank.get(a.id) - rank.get(b.id));
        let next = 0;
        rows.forEach((row, n) => inst.set(rank.has(row.id) ? continuing[next++].values : row.values, n * 8));
        device.queue.writeBuffer(instBuf, 0, inst, 0, instCount * 8);
        return () => {
          rows.forEach((row, n) => inst.set(row.values, n * 8));
          device.queue.writeBuffer(instBuf, 0, inst, 0, instCount * 8);
        };
      }
    }
  };`);
  if (browser) {
    return source.replace(/from '([^']+)'/g, (_, path) =>
      `from '${new URL(path, new URL('../gpu/kaleido.js', location.href)).href}'`);
  }
  return source.replace(/^import .*;$/gm, '').replace(/export /g, '') + '\nreturn { createKaleido, setKaleidoYield };';
}

export const liveSettings = {
  running: true, W: 958, H: 963, DPR: 2, edgeInset: 0, rgb: [212, 0, 255],
  layers: { kaleido: true }, kaleidoSet: 1, kaleidoMirror: true,
  kaleidoConstSize: true, kaleidoGrade: true, kaleidoFolds: 16,
  kaleidoDensity: 0.45, kaleidoSpeed: 0.2, kaleidoSpeedVar: 0.65,
  kaleidoSpeedPeriod: 35, kaleidoSize: 3, kaleidoSizeVar: 0.6,
  kaleidoSpinMax: 0.61, kaleidoSpinVar: 0.66, kaleidoTwist: -0.01,
  kaleidoOrbitMax: 0.13, kaleidoOrbitVar: 0.68, kaleidoScatter: 0.11,
  kaleidoOpacity: 1, kaleidoFade: 0.31, kaleidoFadeInS: 1.5,
  kaleidoTint: 0.12, kaleidoPulse: 0.72, kaleidoSetXfade: 0,
  kaleidoBright: 1, kaleidoContrast: 1.24, kaleidoSat: 1.51,
  kaleidoFamilies: [], strobeScale: 0
};

export function seededRandom(seed = 0x51a1) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export function orderFlips(previous, current) {
  const rank = new Map(previous.map((p, n) => [p.id, n]));
  const flips = [];
  for (let a = 0; a < current.length; a++) for (let b = a + 1; b < current.length; b++) {
    const x = current[a], y = current[b];
    if (rank.has(x.id) && rank.has(y.id) && rank.get(x.id) > rank.get(y.id)) {
      const [xx, xy, xh, xa] = x.values, [yx, yy, yh, ya] = y.values;
      if (Math.hypot(xx - yx, xy - yy) < (xh + yh) * Math.SQRT2 && xa > 0.5 && ya > 0.5) flips.push([x.id, y.id]);
    }
  }
  return flips;
}
