// The order stamps go into the trail, and who is in front where two hands
// draw over the same spot at once. Every stamp carries its time on this
// screen's clock (core/brush.js: a local one when the hand made it, a
// remote one its sender's time mapped here), and gpu/brush.js bakes them
// into the trail image in that time order once each is a delay old, every
// sender's together, drawing the younger ones live over the trail until
// then, sorted the same way: so the trail's layering is who drew later,
// the same on every screen whatever the network did, and a stamp moving
// from the live pass to the trail never changes what is on top.
//
// Stamps of the very same moment (the same frame on this screen) are
// ordered by the senders' turn (Robert's: "I'm in front for one second,
// then you are"): the senders active now (seen this second or the one
// before), ascending by id, take turns at the front, front = ids[second %
// count], the rest behind it in rotation (ids[front + 1] next, and so on
// round), the front sender's stamps last, on top; then by sender and by
// the order they came, so one sender's own stamps keep theirs. The second
// is the wall clock's (Date.now), which every screen roughly shares.
//
// Ids: a room member's id, the hand's own (its room id, or SOLO_ID alone),
// BROADCAST_ID for the broadcaster's strokes on a follower.

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

// Sorts idx[0..n) (stamp numbers) into baking order: by time (key), then by
// the senders' turn this second (place, from frameOrder's rule: the front
// sender's highest, so on top), then sender, then the order they came (seq).
let sk = null, sp = null, sw = null, sq = null;
const byOrder = (a, b) => (sk[a] - sk[b]) || (sp[a] - sp[b]) || (sw[a] - sw[b]) || (sq[a] - sq[b]);
export function bakeOrder(idx, n, key, place, who, seq) {
  sk = key; sp = place; sw = who; sq = seq;
  idx.subarray(0, n).sort(byOrder);
  sk = sp = sw = sq = null;
  return idx;
}

// A sender's place in this second's turn: 0 for one not active (behind
// everyone), else count minus its distance behind the front, so the front
// sender's place is count, the highest.
export function turnPlace(who, ids, count, sec) {
  const f = count > 0 ? Math.floor(sec) % count : 0;
  for (let j = 0; j < count; j++) if (ids[j] === who) return count - ((j - f + count) % count);
  return 0;
}
