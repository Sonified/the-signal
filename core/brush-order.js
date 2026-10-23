// Who is in front where two hands draw over the same spot at once. Stamps
// from different senders reach this screen interleaved as their batches
// arrive, so drawn in that order the overlap's top shape would flicker
// from frame to frame. Instead each frame's new stamps are laid into the
// trail image sender by sender, in an order that turns once a second
// (Robert's: "I'm in front for one second, then you are"): the senders
// active now (seen this second or the one before), ascending by id, take
// turns at the front, front = ids[second % count], the rest behind it in
// rotation (ids[front + 1] next, and so on round), and the front sender's
// stamps go in last, on top. One sender's own stamps keep their order.
// Only what is new is ordered: the trail image keeps what was laid in
// already (gpu/brush.js stamps each stamp once, into the feedback image,
// and never draws it again), so old trails keep the order they were laid
// in.
//
// The second is the wall clock's (Date.now), which every screen roughly
// shares, so two screens showing the same two senders put the same one in
// front at about the same moment. Ids: a hall member's id, the hand's own
// (its hall id, or SOLO_ID with no hall), BROADCAST_ID for the
// broadcaster's strokes on a follower.

export const SOLO_ID = 0, BROADCAST_ID = -1;
export const MAX_SENDERS = 64;

// The senders active now, kept ascending (allocated once): note each
// frame's senders with the frame's second; anyone not seen this second or
// the one before drops out.
const actIds = new Float64Array(MAX_SENDERS), actSec = new Float64Array(MAX_SENDERS);
let actN = 0;
export const activeSenders = { ids: actIds, get n() { return actN; } };
export function noteSender(who, sec) {
  for (let i = 0; i < actN; i++) if (actIds[i] === who) { actSec[i] = sec; return; }
  if (actN === MAX_SENDERS) return;
  let at = actN++;
  while (at > 0 && actIds[at - 1] > who) { actIds[at] = actIds[at - 1]; actSec[at] = actSec[at - 1]; at--; }
  actIds[at] = who; actSec[at] = sec;
}
export function forgetIdle(sec) {
  let k = 0;
  for (let i = 0; i < actN; i++) if (actSec[i] >= sec - 1) { actIds[k] = actIds[i]; actSec[k] = actSec[i]; k++; }
  actN = k;
}
export function resetSenders() { actN = 0; }

// The drawing order of a frame's n stamps (who[i] each one's sender) into
// out (indices), back to front: by sender, the front sender last, each
// sender's stamps in the order they came. ids/count the active senders,
// ascending; a sender not among them goes first, at the back. rank and
// tally are scratch the caller owns (Int32Array, n and count + 2 long).
export function frameOrder(who, n, ids, count, sec, out, rank, tally) {
  const f = count > 0 ? Math.floor(sec) % count : 0;
  // place 0 is the back; the front sender takes place count
  for (let p = 0; p <= count + 1; p++) tally[p] = 0;
  for (let i = 0; i < n; i++) {
    let idx = -1;
    for (let j = 0; j < count; j++) if (ids[j] === who[i]) { idx = j; break; }
    // r 0 the front, then the rest round; place = count - r, unknown 0
    const p = idx < 0 ? 0 : count - ((idx - f + count) % count);
    rank[i] = p;
    tally[p + 1]++;
  }
  for (let p = 1; p <= count + 1; p++) tally[p] += tally[p - 1];
  for (let i = 0; i < n; i++) out[tally[rank[i]]++] = i;
  return out;
}
