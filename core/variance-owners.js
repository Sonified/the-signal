// The owners the strobe's variances play (core/strobe.js VARIANCES), by the
// owner's key on S and by the variance amount's key: what the drawer needs
// to light an owner's bar from the varied value, so no schema row has to
// remember an effective of its own (core/schema-variance.js wireVariances).
// No imports, so core/strobe.js and the schema side can both reach it
// whichever the module graph loads first.
const byKey = new Map(), byAmount = new Map();

export function registerVarianceOwner(v) {
  const o = { key: v.set, amount: v.amount, eff: v.eff, on: v.on };
  byKey.set(o.key, o);
  byAmount.set(o.amount, o);
}

// The variance playing the owner with this id, or one whose amount is among
// its variance rows' ids; null where the strobe plays none of them.
export function varianceOwner(ownerId, rowIds) {
  const o = byKey.get(ownerId);
  if (o) return o;
  for (const id of rowIds) if (byAmount.has(id)) return byAmount.get(id);
  return null;
}
