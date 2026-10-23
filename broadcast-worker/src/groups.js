// The hall's groups and routes (documents/touch-foundation.md): pure, so the
// worker (index.js, Hall) and node (tools/touch.test.mjs) share one copy.
// Everything is computed from the ids present - joining order, ascending -
// so every member agrees without an election, and an evicted hall that
// wakes again computes the same groups from the same sockets.
//
// The phases, in the conductor's order:
//
//   solo     each drawer alone
//   master   the conductor's strokes reach everyone; a member's reach nobody
//   pairs    adjacent twos; an odd joiner folds into the last pair (a trio)
//   quads    adjacent fours (two pairs merged); the leftover 1-3 fold into
//            the last group, so 5-7 only when the roster is not a multiple
//            of 4, and never under 4 unless the whole roster is
//   halves   whole quads merged into two halves, never splitting one: the
//            quads' list cut where the two halves' head counts come out
//            nearest to equal (on a tie the first half is the smaller), the
//            earlier quads first; a roster of one quad (under 8) is one
//            half, everyone
//
// The groups nest strictly: every pair lies inside one quad, every quad
// inside one half, every half inside all, so moving up the phases only ever
// merges groups and nobody is torn from the people they were drawing with.
// (Pairs nest in quads because both are adjacent runs of the joining order
// with the leftover folded into the last, and 4 is two pairs.)
//   all      everyone in one group, the conductor included: the master
//            screen shows the final drawing
//
// The conductor (a socket that joined with the key) is not a drawer in the
// groups: phaseGroups takes the members' ids only, and routes() places the
// conductors by the rules above.

export const PHASES = ['solo', 'master', 'pairs', 'quads', 'halves', 'all'];

// In pairs, quads and halves the conductor hears nothing from the members,
// so the master screen stays the conductor's own until 'all'. Flip to true
// and it receives every member's stroke in those phases too. Its own
// strokes in those phases reach no one either way (they still land on the
// tape).
export const CONDUCTOR_HEARS_GROUPS = false;

const asc = ids => [...ids].sort((x, y) => x - y);

// Adjacent runs of `size` over the ascending ids, the leftover folded into
// the last run (or standing alone when there is no run to fold into).
function runs(a, size) {
  const groups = [];
  for (let i = 0; i + size <= a.length; i += size) groups.push(a.slice(i, i + size));
  const rest = a.slice(groups.length * size);
  if (rest.length) {
    if (groups.length) groups[groups.length - 1].push(...rest);
    else groups.push(rest);
  }
  return groups;
}

// The pairing: ids ascending, adjacent twos, an odd count's last one folds
// into the final pair as a trio.
export function pairGroups(ids) {
  return runs(asc(ids), 2);
}

// (phase, ids) -> groups: every id in exactly one group, ids ascending in
// each, groups in joining order. Solo and master are every drawer alone; an
// unknown phase is treated as solo. No group is ever empty.
export function phaseGroups(phase, ids) {
  const a = asc(ids);
  if (!a.length) return [];
  if (phase === 'pairs') return runs(a, 2);
  if (phase === 'quads') return runs(a, 4);
  if (phase === 'halves') {
    const quads = runs(a, 4);
    if (quads.length < 2) return [a];
    let best = 1, bestGap = Infinity, first = 0;
    for (let b = 1; b < quads.length; b++) {
      first += quads[b - 1].length;
      const gap = Math.abs(a.length - 2 * first);
      if (gap < bestGap) { bestGap = gap; best = b; }
    }
    return [quads.slice(0, best).flat(), quads.slice(best).flat()];
  }
  if (phase === 'all') return [a];
  return a.map(id => [id]);
}

// Who hears whom. `ids` is everyone present (members and conductors),
// `conductors` the ids that joined with the key. Returns a Map of id ->
//   { to:   the ids a stroke from this id is relayed to (never itself),
//     with: this id plus everyone whose strokes reach it, ascending - what
//           the hall tells it as its group }
export function routes(phase, ids, conductors = [], { conductorHears = CONDUCTOR_HEARS_GROUPS } = {}) {
  const all = asc(ids);
  const cond = new Set(conductors.filter(id => all.includes(id)));
  const drawers = all.filter(id => !cond.has(id));
  const to = new Map(all.map(id => [id, []]));
  const others = id => all.filter(x => x !== id);
  if (phase === 'master') {
    for (const c of cond) to.set(c, others(c));
  } else if (phase === 'all') {
    for (const id of all) to.set(id, others(id));
  } else if (phase === 'pairs' || phase === 'quads' || phase === 'halves') {
    for (const g of phaseGroups(phase, drawers)) {
      for (const id of g) {
        const t = g.filter(x => x !== id);
        if (conductorHears) t.push(...cond);
        to.set(id, asc(t));
      }
    }
  }
  // solo and anything unknown: nobody hears anybody
  const out = new Map();
  for (const id of all) out.set(id, { to: to.get(id), with: [id] });
  for (const [from, t] of to) for (const id of t) out.get(id).with.push(from);
  for (const r of out.values()) r.with = asc(r.with);
  return out;
}
