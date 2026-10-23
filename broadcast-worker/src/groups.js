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
// groups, when given, are the drawers' groups for pairs, quads or halves
// (the rounds' live groups, liveGroups below) in place of phaseGroups.
export function routes(phase, ids, conductors = [], { conductorHears = CONDUCTOR_HEARS_GROUPS, groups = null } = {}) {
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
    for (const g of groups || phaseGroups(phase, drawers)) {
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

// ---------- the rounds: the show's script ----------
//
// The show walks SCRIPT: alone, the master, pairs round 1 (find your
// partner), pairs round 2 (everyone's partner switches; this pairing is the
// bond for the rest of the show), quads round 1 (the bonded pairs matched
// two and two: you and your partner meet two new people), quads round 2
// (your pair stays, the other pair changes), then all together. Halves is
// still a phase the conductor can choose, outside the script, grouped from
// the ids as phaseGroups says (it does not nest with the rounds' pairs).
//
// Each step's groups are planned once, when the step is first reached,
// from the drawers present then, and kept in the hall's round history
// (planStep's hist), so a step reached again (the conductor going back)
// finds the same groups. Within a step nothing reshuffles (liveGroups): a
// leaver's group keeps its place (the one left waits for a partner who may
// be back in a moment, the sticky ids making a blip harmless), and a late
// joiner folds in without moving anyone bonded: joiners pair (or make
// fours) among themselves in arrival order as new groups appended at the
// end, and joiners too few for a group of their own join the last group as
// extras. Each later round is planned over the roster as it stands when it
// starts: someone who arrived after round 1 has no old partner to avoid, a
// round-1 partner who left is simply not there, and the quads build on the
// bonds as they stand then (bonded pairs, plus any joiners paired as new
// units). The wipe forgets the history, for a new show.
//
// Avoiding the old: regroup() looks for the grouping (the same sizes as
// runs() makes, the leftover folded into the last group) with the fewest
// pairs of units that were together before, by a depth-first search over
// the ascending order, so it is deterministic from the roster alone; it
// stops at the first grouping with no repeat, and a small roster that has
// none (two people, three, five; two or three pairs; five pairs) gets the
// fewest repeats there are. Round 2 of pairs therefore splits every round-1
// pair whenever four or more are present, and quads round 2 never re-meets
// a round-1 opposing pair whenever four or more pairs are.

export const SCRIPT = [['solo', 1], ['master', 1], ['pairs', 1], ['pairs', 2], ['quads', 1], ['quads', 2], ['all', 1]];
const ROUNDS = { pairs: 2, quads: 2 };

// A phase's round held to the rounds it has (1 for every other phase).
export function roundOf(phase, r) {
  const max = ROUNDS[phase] || 1;
  const n = Number.isInteger(r) ? r : 1;
  return n < 1 ? 1 : n > max ? max : n;
}

// The step after (phase, round) along the script; the last stays put.
// Halves, outside the script, goes on to all.
export function nextStep(phase, round) {
  const i = SCRIPT.findIndex(([p, r]) => p === phase && r === roundOf(phase, round));
  if (i >= 0) return SCRIPT[Math.min(i + 1, SCRIPT.length - 1)].slice();
  if (phase === 'halves') return ['all', 1];
  return SCRIPT[0].slice();
}

// For each id, the index of the group it was in.
function indexOf(groups) {
  const m = new Map();
  if (groups) groups.forEach((g, i) => { for (const id of g) m.set(id, i); });
  return m;
}
// Whether any member of unit a shared a group in `before` with any of b.
function met(before, a, b) {
  for (const x of a) {
    const gx = before.get(x);
    if (gx === undefined) continue;
    for (const y of b) if (before.get(y) === gx) return true;
  }
  return false;
}

// Units (arrays of ids, in order) into groups of `size` units, the leftover
// folded into one of them (the last when that costs nothing more), with the
// fewest pairs of units that met in `before` (an id -> group index Map).
// Returns arrays of units, each group's first unit the earliest left, so
// the groups come in the order of their earliest member.
const SEARCH_BUDGET = 200000;
export function regroup(units, size, before) {
  const n = units.length;
  if (!n) return [];
  const k = Math.max(1, Math.floor(n / size)), extra = n - k * size;
  let best = null;
  // the larger group tried last first, then each earlier place
  for (let at = k - 1; at >= 0; at--) {
    const sizes = new Array(k).fill(size);
    sizes[at] += extra;
    if (k === 1) sizes[0] = n;
    const r = search(units, sizes, before);
    if (!best || r.cost < best.cost) best = r;
    if (best.cost === 0 || extra === 0) break;
  }
  return best.groups.map(g => g.map(i => units[i]));
}
function search(units, sizes, before) {
  const n = units.length;
  const clash = [];
  for (let i = 0; i < n; i++) {
    clash.push([]);
    for (let j = 0; j < n; j++) clash[i].push(i !== j && met(before, units[i], units[j]) ? 1 : 0);
  }
  const used = new Uint8Array(n);
  const cur = [], best = { cost: Infinity, groups: null };
  let nodes = 0;
  function fill(g, members, cost) {
    if (cost >= best.cost || nodes++ > SEARCH_BUDGET) return;
    if (g === sizes.length) { best.cost = cost; best.groups = cur.map(x => x.slice()); return; }
    if (members.length === sizes[g]) {
      cur.push(members);
      fill(g + 1, [], cost);
      cur.pop();
      return;
    }
    // a group's first member is the earliest unplaced unit (so no grouping
    // is tried twice); the rest come after the last one taken
    const from = members.length ? members[members.length - 1] + 1 : 0;
    for (let i = from; i < n; i++) {
      if (used[i]) continue;
      if (!members.length) {
        let earlier = false;
        for (let j = 0; j < i; j++) if (!used[j]) { earlier = true; break; }
        if (earlier) break;
      }
      let add = 0;
      for (const m of members) add += clash[m][i];
      used[i] = 1; members.push(i);
      fill(g, members, cost + add);
      members.pop(); used[i] = 0;
      if (best.cost === 0) return;
    }
  }
  fill(0, [], 0);
  return best;
}

// A planned step's groups as they stand for the drawers present: absent
// members leave their place empty (a group with nobody here drops out),
// and drawers the plan never saw fold in after it (see the notes above):
// in runs of `size` as new groups of their own, or, too few for one, into
// the last group.
export function liveGroups(planned, ids, size) {
  const here = new Set(ids), placed = new Set();
  const out = [];
  for (const g of planned || []) {
    const live = g.filter(id => here.has(id));
    for (const id of g) placed.add(id);
    if (live.length) out.push(live);
  }
  const extras = asc(ids.filter(id => !placed.has(id)));
  if (extras.length) {
    if (extras.length >= size || !out.length) out.push(...runs(extras, size));
    else out[out.length - 1].push(...extras);
  }
  return out;
}

const flat = groups => groups.map(g => [].concat(...g));

// Plans (phase, round) for the drawers present, over the history of the
// steps already planned ({ pairs1, pairs2, units, quads1, quads2 }, each an
// array of id groups; units the bonded pairs the quads are built from).
// Returns the step's planned groups and the history with it added; a step
// already in the history is returned as it was planned. Halves, solo,
// master and all are not planned: they come from the ids as they stand.
export function planStep(phase, round, drawers, hist = {}) {
  const ids = asc(drawers);
  const h = Object.assign({}, hist);
  const r = roundOf(phase, round);
  if (phase === 'pairs' && r === 1) {
    if (!h.pairs1) h.pairs1 = runs(ids, 2);
    return { groups: h.pairs1, hist: h };
  }
  if (phase === 'pairs' && r === 2) {
    if (!h.pairs2) h.pairs2 = flat(regroup(ids.map(id => [id]), 2, indexOf(h.pairs1 || runs(ids, 2))));
    return { groups: h.pairs2, hist: h };
  }
  if (phase === 'quads' && r === 1) {
    if (!h.quads1) {
      // the bonds as they stand: the final pairs, joiners paired after them
      h.units = liveGroups(h.pairs2 || h.pairs1 || runs(ids, 2), ids, 2);
      h.quads1 = flat(runs(h.units, 2));
    }
    return { groups: h.quads1, hist: h };
  }
  if (phase === 'quads' && r === 2) {
    if (!h.quads2) {
      const units = liveGroups(h.units || h.pairs2 || h.pairs1 || runs(ids, 2), ids, 2);
      h.quads2 = flat(regroup(units, 2, indexOf(h.quads1)));
    }
    return { groups: h.quads2, hist: h };
  }
  return { groups: null, hist: h };
}

// The drawers' live groups for a step: the planned ones as they stand for
// pairs and quads, the plain law for every other phase.
export function stepGroups(phase, round, drawers, hist) {
  const size = phase === 'pairs' ? 2 : phase === 'quads' ? 4 : 0;
  if (!size) return phaseGroups(phase, drawers);
  const plan = planStep(phase, round, drawers, hist).groups;
  return liveGroups(plan, drawers, size);
}
