// The order the music's recordings download in, for someone arriving with
// nothing cached: the drone first (the bed everything sits on, and the
// smallest by far), then the piano, then the clouds, then the choir. Every
// voice sharing the connection at once meant they all arrived late together,
// and the drone, fetched only after the piano's forty-two files, came last
// of the lot. In turn, the first sound lands as soon as the connection can
// deliver 400 KB.
//
// A voice's fetches wait until every voice ahead of it that is still
// downloading has finished. Voices in the same turn download together, and a
// voice with nothing ahead of it in flight goes at once, so a later request
// (a new drone render, the choir switched on mid-session) is never held
// behind a queue that has already drained.
export const TURN = { drone: 0, piano: 1, clouds: 2, choir: 3 };
const inFlight = [new Set(), new Set(), new Set(), new Set()];

async function waitTurn(turn) {
  // One microtask first, so every voice the session starts in the same
  // moment has registered before anyone looks at who is ahead.
  await null;
  for (;;) {
    const ahead = [];
    for (let t = 0; t < turn; t++) for (const p of inFlight[t]) ahead.push(p);
    if (!ahead.length) return;
    await Promise.allSettled(ahead);
  }
}

// Runs job (an async function doing the fetches) when its turn comes, and
// returns its promise. A failed job frees its turn just as a finished one does.
export function inTurn(turn, job) {
  const p = waitTurn(turn).then(job);
  const mark = p.then(() => {}, () => {});
  inFlight[turn].add(mark);
  mark.then(() => inFlight[turn].delete(mark));
  return p;
}
