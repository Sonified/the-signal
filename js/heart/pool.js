// Heart's worker pool: how many workers, what each one is, and which
// island lives where (documents/heart-audio-engine.md, §3 and §7.4).
//
// A stage is one worker hosting one heart.wasm instance. Stage 0 is always
// the one that ends at the speakers: the mix, which holds the shared buses,
// the rooms and the master, or, on a small device, the combined stage that
// holds everything. The other stages are islands, each rendering a few
// voice families in parallel and handing them to the mix through its egress
// ring.
//
// Two cores are kept free, one for the page and one for the browser's own
// audio thread, and four islands is the most the app has families to fill.
// On two cores or fewer, a mix worker beside a single island would only add
// a hop, so one combined worker takes it all.

export const ROLE = { combined: 0, island: 1, mix: 2 };

// The default worker count, all workers included: islands plus the mix, or
// the one combined worker.
export function defaultWorkers(cores) {
  const n = cores || 2;
  return n <= 2 ? 1 : Math.min(4, Math.max(1, n - 2)) + 1;
}

// The stages for `workers` workers in all, stage 0 first.
export function planStages(workers) {
  if (workers <= 1) return [{ id: 0, role: ROLE.combined, islands: [] }];
  const stages = [{ id: 0, role: ROLE.mix, islands: [] }];
  for (let id = 1; id < workers; id++) stages.push({ id, role: ROLE.island, islands: [] });
  return stages;
}

// Where islands live. Each island goes, on first asking, to the island
// stage carrying the least weight so far (the lowest id on a tie), and stays
// there for the session: its nodes were created there and cannot move. A
// weight is a hint of cost, 1 unless weigh() said otherwise before the
// island was placed; a convolver-heavy family weighs more. A weight given
// after placement still counts towards where later islands go.
export class Placement {
  constructor(stages) {
    this.stages = stages;
    this.islandStages = stages.filter(s => s.role === ROLE.island);
    this.homes = new Map();
    this.weights = new Map();
    this.load = stages.map(() => 0);
  }

  weigh(island, w) {
    const before = this.weights.get(island) ?? 1;
    this.weights.set(island, w);
    const home = this.homes.get(island);
    if (home !== undefined) this.load[home] += w - before;
  }

  stageFor(island) {
    let home = this.homes.get(island);
    if (home !== undefined) return home;
    home = 0;
    let least = Infinity;
    for (const s of this.islandStages) {
      if (this.load[s.id] < least) { least = this.load[s.id]; home = s.id; }
    }
    this.homes.set(island, home);
    this.load[home] += this.weights.get(island) ?? 1;
    this.stages[home].islands.push(island);
    return home;
  }
}

// One module worker per stage, named so a profiler shows which is which.
export function spawnWorkers(stages, url) {
  return stages.map(s => new Worker(url, {
    type: 'module',
    name: `heart ${s.role === ROLE.island ? 'island' : s.role === ROLE.mix ? 'mix' : 'combined'} ${s.id}`
  }));
}
