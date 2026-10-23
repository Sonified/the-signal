// The replay: a hall's tape played back into the very scene the drawers
// used (documents/touch-foundation.md). The worker records every stroke a
// hall relays as { at, id, s } - ms since the hall's epoch, the drawer's
// id, the stroke as it was said - and a plain GET of /touch/<hall>/tape
// hands back the lot. Playback is two movements, Robert's words exactly:
// individual drawings coming together, then all together at once. Movement
// one takes the drawers one by one in id order, each session
// time-compressed to fit a fixed slot, the scene cleared between them;
// movement two replays the whole tape on its common timeline, everyone at
// once, compressed to its own span. Compression only ever speeds a session
// up (the scale caps at 1): a thirty-minute drawing fits the slot, but a
// five-second one plays at the pace the hand drew it rather than stretched
// into slow motion - or, had the cap gone the other way, squeezed into an
// instant.
//
// planReplay is pure - tape entries in, timed plans out - so node can test
// the shape of both movements without a browser (tools/touch-replay.test.mjs);
// the driver that walks a plan against the clock and stamps into the scene
// is the thin part, and the stamps take the foundation's one draw path.

import { decodeStroke, drawStroke } from './strokes.js';

export const SOLO_MS = 12000;      // movement one: each drawer's slot
export const TOGETHER_MS = 45000;  // movement two: the whole tape's span

// The plans. `entries` is the tape's [{at, id, s}]; anything that does not
// decode as a stroke, or lacks its time or drawer, is skipped - the hall
// records what was said, not what was sayable. Returns { members, together }:
// members one per drawer in id order, each { id, hue, plan } with the hue
// from the drawer's first stroke; every plan is [{tMs, stroke}], tMs from
// its own movement's zero. Each scale is min(1, span / duration):
// compression to fit, never stretching.
export function planReplay(entries, { soloMs = SOLO_MS, togetherMs = TOGETHER_MS } = {}) {
  const good = [];
  for (const e of entries || []) {
    if (!e || typeof e.at !== 'number' || typeof e.id !== 'number') continue;
    const stroke = decodeStroke(e.s);
    if (stroke) good.push({ at: e.at, id: e.id, stroke });
  }
  const byId = new Map();
  for (const e of good) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const members = [...byId.keys()].sort((x, y) => x - y).map(id => {
    const own = byId.get(id);
    const t0 = own[0].at, span = own[own.length - 1].at - t0;
    const scale = span > 0 ? Math.min(1, soloMs / span) : 1;
    return {
      id,
      hue: own[0].stroke.h,
      plan: own.map(e => ({ tMs: (e.at - t0) * scale, stroke: e.stroke }))
    };
  });
  let together = [];
  if (good.length) {
    const t0 = good[0].at, span = good[good.length - 1].at - t0;
    const scale = span > 0 ? Math.min(1, togetherMs / span) : 1;
    together = good.map(e => ({ tMs: (e.at - t0) * scale, stroke: e.stroke }));
  }
  return { members, together };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Walks one plan against the clock: each frame, every stroke whose moment
// has come is stamped into the scene with the same drawStroke that painted
// it live, so the playback is the drawing, not a film of it.
function playPlan(plan, scene) {
  return new Promise(done => {
    if (!plan.length) return done();
    const t0 = performance.now();
    let i = 0;
    (function step() {
      const t = performance.now() - t0;
      while (i < plan.length && plan[i].tMs <= t) {
        const s = plan[i++].stroke;
        scene.stamp(ctx => drawStroke(ctx, s, scene.map, scene.side));
      }
      if (i < plan.length) requestAnimationFrame(step);
      else done();
    })();
  });
}

// Fetches the tape and plays both movements. flash(words, hue) is the
// page's announcer; the pauses let a finished figure travel the feedback a
// moment before the scene clears for the next drawer.
export async function runReplay({ host, hall, scene, flash, soloMs, togetherMs }) {
  let tape;
  try {
    const res = await fetch(`https://${host}/touch/${encodeURIComponent(hall)}/tape`);
    tape = await res.json();
  } catch (e) {
    flash('no tape to play');
    return;
  }
  const { members, together } = planReplay(tape && tape.entries, { soloMs, togetherMs });
  if (!members.length) {
    flash('the tape is empty');
    return;
  }
  for (let i = 0; i < members.length; i++) {
    scene.clear();
    flash(`drawer ${i + 1}`, members[i].hue);
    await wait(1800);
    await playPlan(members[i].plan, scene);
    await wait(2600);
  }
  scene.clear();
  flash('all together');
  await wait(1800);
  await playPlan(together, scene);
}
