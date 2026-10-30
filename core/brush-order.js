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

// ---------- the frame's share ----------
// A frame draws at most so many stamps (gpu/brush.js MAX_INST) and looks at
// only the ring's oldest so many (its MAX_PEND). Every sender's stamps share
// the one ring, the visitor's own hand among the replay's or the hall's, and
// the hand's are always the youngest: at the ring's tail, and last in the
// bake order (they carry the moment they were made, while a remote stamp
// is let out a delay after its own and is due the frame it arrives). So
// whenever the others' line was longer than a frame could draw (the
// standing playback at 10x Continuity on a laptop whose frames had slowed),
// the hand's marks were either outside the window or past the budget, and
// drew nothing until the line had drained: seconds of a stroke not there
// under the finger. The hand comes first now, and the others take what is
// left; the bake order itself is untouched, only who gets the frame.

// The stamps a frame looks at, as ring places (from the head) into pos:
// the oldest headMax, as ever, then, from the rest of the ring, the hand's
// own (who === hand), newest first, up to handMax of them. Returns how many.
// q is the ring (core/brush.js brushQueue), F its floats per stamp, the
// sender at float 6. The rest of the ring is read only when there is a
// line past the window, and then only its senders.
export function pendingWindow(q, F, hand, headMax, handMax, pos) {
  const n0 = q.count < headMax ? q.count : headMax;
  for (let j = 0; j < n0; j++) pos[j] = j;
  let m = n0;
  if (q.count > n0 && handMax > 0) {
    const h = Math.fround(hand), b = q.buf;
    for (let j = q.count - 1; j >= n0 && m < n0 + handMax; j--)
      if (b[((q.head + j) % q.cap) * F + 6] === h) pos[m++] = j;
  }
  return m;
}

// Which of the m stamps looked at take this frame, and how: order is their
// bake order (bakeOrder above, over entries 0..m), key each one's time,
// mine whether it is the hand's, ready its atlas (1 in, 0 not yet, 2 failed
// to load), n0 how many are the ring's head window (entries at or past n0
// are the hand's from beyond it, pendingWindow). due is the bake's moment.
// Into out, in order, the entries drawn: [0, bake) go into the trail,
// [bake, inst) are drawn live over it; gone[e] marks each that leaves the
// ring (baked, or a failed set's let go). pri is scratch. Returns
// frameShare { bake, inst }. Nothing is allocated.
//
// The law kept: what bakes is always a prefix of the bake order's due
// stamps, as before, so the trail's layering is the time order on every
// screen however the frame's budget is shared out; a due stamp that cannot
// bake now (its atlas not in, no room, or beyond the window) holds back
// every later one's bake, and those draw live meanwhile, in the same order,
// over the trail. A stamp from beyond the window never bakes: stamps older
// than it may still be waiting outside the window, and they must go into
// the trail first. It is drawn live till the window reaches it.
//
// What changes is the budget: the hand's newest handMax stamps (ready ones)
// are reserved their place before anything else is drawn, so another
// sender's stamp takes an instance only while the reservation still fits
// beside it. The hand is one person's drawing, a delay's worth of it at
// most, so the reservation is small; handMax well under maxInst means the
// others always have the rest of the frame and their line still moves on.
// The hand's stamps being the youngest, drawing them on top is exactly the
// order's own: nothing is lifted out of turn, a few older stamps of the
// others simply wait a frame or two to be drawn.
export const frameShare = { bake: 0, inst: 0 };
export function shareFrame(order, m, n0, key, mine, ready, due, maxInst, handMax, pri, out, gone) {
  let reserve = 0;
  for (let e = 0; e < m; e++) { pri[e] = 0; gone[e] = 0; }
  for (let jj = m - 1; jj >= 0 && reserve < handMax; jj--) {
    const e = order[jj];
    if (mine[e] && ready[e] === 1) { pri[e] = 1; reserve++; }
  }
  let n = 0, blocked = false;
  // the bake: the due stamps in order, while each can go
  for (let jj = 0; jj < m; jj++) {
    const e = order[jj];
    if (blocked || key[e] > due) continue;
    if (e >= n0) { blocked = true; continue; }
    if (ready[e] === 2) { gone[e] = 1; continue; }
    if (ready[e] !== 1) { blocked = true; continue; }
    if (pri[e]) reserve--;
    else if (n + reserve >= maxInst) { blocked = true; continue; }
    gone[e] = 1;
    out[n++] = e;
  }
  const bake = n;
  // the rest live, in the same order: the reserved always, the others
  // while there is room beside what is still reserved
  for (let jj = 0; jj < m; jj++) {
    const e = order[jj];
    if (gone[e] || ready[e] !== 1) continue;
    if (pri[e]) reserve--;
    else if (n + reserve >= maxInst) { if (reserve === 0) break; continue; }
    out[n++] = e;
  }
  frameShare.bake = bake; frameShare.inst = n;
  return frameShare;
}
