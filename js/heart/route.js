// Which engine each family of voices plays through.
//
// A family moves to Heart as a whole, because its nodes connect to each
// other: music (the piano, its drone and sequencer, the choir, the clouds
// and the strobe stages they wear), ambience, and genus (the pulse
// engine and its rooms). Clouds keeps its own flag name but lives in the
// music island, since it plays into the music's master reverb. A module switches by asking here instead of
// audio.js, and changes nothing else (spec 12):
//
//   getContext()                 ->  ctxFor('clouds')
//   getMaster()                  ->  masterFor('clouds')
//   new AudioWorkletNode(c, ...) ->  makeWorklet(c, ...)
//
// With Heart off for a family, each of these answers with the native
// object it replaces, so the module cannot tell. The flag is
// localStorage.signal_heart, overridden by ?heart= in the URL: absent is
// every family (Heart is the engine, 2026-10-08), 'off' is native, 'all'
// says the default outright, and a comma list names some ('music,clouds').
// A device that cannot run Heart (no wasm SIMD, a worklet that will not
// load) still goes native on its own (startHeart).
//
// startHeart has to have settled before a flagged family builds its graph:
// until it does, ctxFor answers with the native context, and a graph built
// then stays native.
//
// If the engine fails after it has started (a stage's worker dies, or the
// drain stops), what is safe depends on whether a family has built anything
// yet. A family that has not yet been handed its context has nothing in
// Heart, so it simply goes native: from then on ctxFor and masterFor answer
// with the native objects, and it builds there. A family already handed its
// HeartContext keeps it. Its nodes live in the stages, and its module holds
// them; answering it with the native context now would hand it a second
// context to connect the old nodes into, which throws. Only the module
// itself could rebuild its graph natively, so it stays on Heart, and the
// console says which families that leaves.
import { S } from '../state.js';

export const FAMILIES = ['music', 'clouds', 'ambience', 'genus'];

let nativeCtx = null, nativeMaster = null, engine = null, starting = null;
const contexts = new Map();
// The families that have been handed their HeartContext or Heart master.
const handed = new Set();

// The flagged families, as a Set; empty means everything plays natively.
// The URL and the stored value can be passed in (the tests do); by default
// they are read from the page, and a page that cannot read them (storage
// blocked, no location) simply has no flag.
export function parseHeartFlag(search, stored) {
  if (search === undefined) {
    try { search = location.search; } catch (e) { search = ''; }
  }
  if (stored === undefined) {
    try { stored = localStorage.getItem('signal_heart'); } catch (e) { stored = null; }
  }
  let raw = null;
  try { raw = new URLSearchParams(search || '').get('heart'); } catch (e) {}
  if (!raw) raw = stored;
  const on = new Set();
  if (!raw) { for (const f of FAMILIES) on.add(f); return on; }
  if (String(raw).toLowerCase().trim() === 'off') return on;
  for (const part of String(raw).toLowerCase().split(',')) {
    const name = part.trim();
    if (name === 'all') for (const f of FAMILIES) on.add(f);
    else if (FAMILIES.includes(name)) on.add(name);
  }
  return on;
}

// Starts Heart on the native context, if any family is flagged, and plays
// its output into the native master (audio.js's volGain, so the volume, the
// pause gate and the transport ramps all still apply). Resolves to the
// engine, or to null when every family stays native: none flagged, or a
// device that cannot run Heart, which is said once in the console. Called
// again, it answers with the first call's result.
// The viewer's Audio cushion (the drawer's render section, a machine
// setting): seconds the engine renders ahead. Read at start and applied
// live when the slider moves (schema-visual.js calls applyHeartLookahead).
function lookaheadSetting() {
  const v = S.heartLookaheadS;
  return typeof v === 'number' && isFinite(v) ? Math.max(0.05, Math.min(0.5, v)) : 0.3;
}
export function applyHeartLookahead() {
  if (engine) engine.setLookahead(lookaheadSetting());
}

export function startHeart(ctx, master) {
  nativeCtx = ctx;
  nativeMaster = master;
  if (!starting) starting = boot(ctx, master);
  return starting;
}

async function boot(ctx, master) {
  const flagged = parseHeartFlag();
  if (!flagged.size) return null;
  let eng = null;
  try {
    const [{ startEngine }, { HeartContext, Shadow }] = await Promise.all([
      import('./engine.js'), import('./heart.js')
    ]);
    eng = await startEngine(ctx, { lookahead: lookaheadSetting() });
    if (!eng) {
      console.warn('Heart: this device cannot run it, so every family plays natively');
      return null;
    }
    // the engine's compiled module when it offers one, else heart.wasm afresh
    const shadow = await Shadow.create(eng.sampleRate, eng.module);
    eng.output.connect(master);
    // Clouds is a standard music voice and plays in the music island, as
    // the choir does: one context, so it sings into the same master reverb
    // on Heart exactly as it does natively (js/clouds.js setCloudBus).
    const made = new Map();
    for (const family of flagged) {
      const isle = family === 'clouds' ? 'music' : family;
      let hc = made.get(isle);
      if (!hc) { hc = new HeartContext(eng, ctx, shadow, isle); made.set(isle, hc); }
      contexts.set(family, hc);
    }
    eng.on('error', fallBack);
    engine = eng;
    return eng;
  } catch (e) {
    // Principle 5: nothing goes silent because Heart could not start.
    console.warn('Heart: failed to start, so every family plays natively', e);
    contexts.clear();
    if (eng) try { eng.close(); } catch (err) {}
    return null;
  }
}

// The engine has failed after starting (see the top): the families not yet
// built go native, the built ones stay.
function fallBack(stage, message) {
  for (const family of [...contexts.keys()]) if (!handed.has(family)) contexts.delete(family);
  const stuck = [...handed];
  console.warn(`Heart: stage ${stage} failed (${message}). ` + (stuck.length
    ? `${stuck.join(', ')} already built on Heart and stay there; every other family plays natively`
    : 'Every family plays natively'));
}

// The context a family builds on: its HeartContext, or the native one.
export function ctxFor(family) {
  const ctx = contexts.get(family);
  if (!ctx) return nativeCtx;
  handed.add(family);
  return ctx;
}

// Where a family's output goes: Heart's master bus, or the native master.
export function masterFor(family) {
  const ctx = contexts.get(family);
  if (!ctx) return nativeMaster;
  handed.add(family);
  return ctx.destination;
}

// A processor node on whichever engine `ctx` belongs to.
export function makeWorklet(ctx, name, opts) {
  return ctx && ctx.isHeart ? ctx.createProcessor(name, opts) : new AudioWorkletNode(ctx, name, opts);
}

export const heartEngine = () => engine;
export const heartOn = family => contexts.has(family);
