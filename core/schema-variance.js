// The variance factory: the rows a variance shows in the drawer, made from
// one call spread straight after its owner's row. The law they drive, the
// three tiers and how to add a variance are in core/variance.js; this is the
// drawer's half. It lives in a file of its own, next to the schema files
// that call it, and imports none of them, so whichever of them the module
// graph reaches first finds it ready (the schema files import each other in
// a ring, through schema.js and store.js).
import { save } from './store.js';
import { retimeRoomPhase } from './room-clock.js';
import { varianceOwner } from './variance-owners.js';
import { DRIVES, driveOf } from './variance.js';

// A variance's rows. owner is the owner's id; opts, every one optional:
//   name        the variance's name in its labels: '<name> variance' and
//               '<name> var rate' ('... variance speed' for music), or the
//               On switch's '<name> variance' ahead of 'Variance amount' and
//               'Variance rate'
//   labels      [amount, period] exactly, over the above
//   amount      the amount's key on S (owner + 'Var'), or S => key for one
//               that moves with a mode (the click's, by its shape)
//   period      the period's key (owner + 'VarPeriod'; for music, owner +
//               'Period'), or S => key
//   ids         [amount, period] row ids, where they are not the keys
//   amountDef   the amount's default, in percent (0)
//   periodMin, periodMax, periodDef   the rate's range in seconds (1-60,
//               20; for music 0-120)
//   music       the Music drawers' house style: the rate reads as plain
//               seconds ('20s') rather than '20s / cycle', labelled speed
//   apply       run after any write to the amount, the period or the On
//               switch, before the save (the engine's hook)
//   on          an On switch ahead of the rows (true: owner + 'VarOn'),
//               default on; off holds the owner at its setting, and the
//               amount and period hang under it, shown while it is on
//   mode        the Behavior segment, Sinusoid or Walk, between amount and
//               period (true: owner + 'VarMode')
//   room        the rate rides the room clock: a change is folded into its
//               phase offset first (core/room-clock.js retimeRoomPhase,
//               the period's key plus Off)
//   retime      (S, oldPeriod, newPeriod), the same fold for any other
//               offset (the word walk's)
//   fit         (key, value) => the value S keeps, run on every write
//   parent, visible, enabled   placed on every row (under an On switch the
//               amount and period hang from it and add its rule)
//   section     the owner's, unless given
//   effective   S => the owner's value as the variance plays it, in the
//               owner's slider units: the owner's lit bar, set on the owner
//               and shown only while the amount is above 0 (and the switch
//               on). An owner with its own effective keeps it.
//   rows        { on, amount, mode, period }: fields merged over the row the
//               factory made, any field, for the one that differs
//   extras      further rows folded under the same chevron, after these
// The owner's section and effective are wired by wireVariances once every
// schema file has loaded (core/schema.js), since the owner is a row beside
// these, not one the factory can see.
const VARIANCE_WIRES = new WeakMap();     // a variance's first row -> { owner, rows, effective }
const keyFn = k => typeof k === 'function' ? k : () => k;
const asIs = (k, v) => v;
export function varianceRows(owner, o = {}) {
  const music = !!o.music;
  const onKey = o.on === true ? owner + 'VarOn' : o.on || null;
  const modeKey = o.mode === true ? owner + 'VarMode' : o.mode || null;
  const aKey = keyFn(o.amount || owner + 'Var');
  const pKey = keyFn(o.period || owner + (music ? 'Period' : 'VarPeriod'));
  const ids = o.ids || [o.amount || owner + 'Var', o.period || owner + (music ? 'Period' : 'VarPeriod')];
  const name = o.name || '';
  const labels = o.labels || (onKey ? ['Variance amount', 'Variance rate']
    : [name + ' variance', name + (music ? ' variance speed' : ' var rate')]);
  const pDef = o.periodDef ?? 20, unit = music ? 's' : 's / cycle';
  const fit = o.fit || asIs, apply = o.apply;
  const retime = o.retime || (o.room ? (S, was, now) => retimeRoomPhase(S, pKey(S) + 'Off', was, now) : null);
  const place = (row, parent, visible) => {
    if (o.section) row.section = o.section;
    if (parent) row.parent = parent;
    if (visible) row.visible = visible;
    if (o.enabled) row.enabled = o.enabled;
    return row;
  };
  const onShows = onKey ? S => S[onKey] !== false : null;
  const inner = onShows && o.visible ? S => o.visible(S) && onShows(S) : onShows || o.visible;
  const innerParent = onKey || o.parent;
  const made = {};
  if (onKey) made.on = place({
    id: onKey, label: name + ' variance', kind: 'toggle', def: true, varianceOf: owner,
    get: S => S[onKey] !== false,
    set: (S, on) => { S[onKey] = !!on; if (apply) apply(); save(); },
    format: S => S[onKey] !== false ? 'On' : 'Off'
  }, o.parent, o.visible);
  made.amount = place({
    id: ids[0], label: labels[0], kind: 'slider', varianceOf: owner,
    min: 0, max: 100, step: 1, def: o.amountDef ?? 0,
    get: S => Math.round((S[aKey(S)] || 0) * 100),
    set: (S, pos) => { const k = aKey(S); S[k] = fit(k, pos / 100); if (apply) apply(); save(); },
    format: S => Math.round((S[aKey(S)] || 0) * 100) + '%'
  }, innerParent, inner);
  // How the variance moves: Sinusoid breathes evenly, down by the amount
  // and back once per period; Walk drifts leg by leg to random depths
  // within it, never twice the same (core/variance.js breath).
  if (modeKey) made.mode = place({
    id: modeKey, label: 'Behavior', kind: 'segment', hideLabel: true, varianceOf: owner,
    options: [
      { value: 'sine', label: 'Sinusoid' },
      { value: 'walk', label: 'Walk' }
    ],
    def: 'sine',
    get: S => S[modeKey] === 'walk' ? 'walk' : 'sine',
    set: (S, v) => { S[modeKey] = v === 'walk' ? 'walk' : 'sine'; save(); },
    format: S => S[modeKey] === 'walk' ? 'walk' : 'sinusoid'
  }, innerParent, inner);
  made.period = place({
    id: ids[1], label: labels[1], kind: 'slider', varianceOf: owner,
    min: o.periodMin ?? (music ? 0 : 1), max: o.periodMax ?? (music ? 120 : 60), step: 1, def: pDef,
    get: S => S[pKey(S)] ?? pDef,
    set: (S, pos) => {
      const k = pKey(S), v = fit(k, pos);
      if (retime) retime(S, S[k], v);
      S[k] = v;
      if (apply) apply();
      save();
    },
    format: S => (S[pKey(S)] ?? pDef) + unit
  }, innerParent, inner);
  const rows = [];
  for (const which of ['on', 'amount', 'mode', 'period']) {
    if (!made[which]) continue;
    if (o.rows && o.rows[which]) Object.assign(made[which], o.rows[which]);
    rows.push(made[which]);
  }
  for (const x of o.extras || []) {
    if (x.varianceOf === undefined) x.varianceOf = owner;
    rows.push(x);
  }
  // An audio variance plays on its voice's own clock (core/variance.js
  // breath, js/strobe-am.js), which no table here can read, so its owner's
  // bar is only ever the effective given: one left out is said at load
  // rather than found later as a bar that never moves. A visual variance
  // without one is lit from the strobe's own (wireVariances below).
  if (music && !o.effective) console.error('schema: ' + owner + "'s variance has no effective, so its bar will never move");
  const shown = onKey ? S => S[onKey] !== false && S[aKey(S)] > 0 : S => S[aKey(S)] > 0;
  const effective = o.effective ? S => shown(S) ? o.effective(S) : undefined : null;
  VARIANCE_WIRES.set(rows[0], { owner, rows, effective });
  return rows;
}

// The owners' side of every variance in the merged list: each variance row
// takes its owner's section unless it has one, and the owner takes the
// variance's effective unless it has its own. byId maps id to control.
export function wireVariances(controls, byId) {
  for (const c of controls) {
    const w = VARIANCE_WIRES.get(c);
    if (!w) continue;
    const owner = byId.get(w.owner);
    if (!owner) { console.warn('schema: ' + c.id + ' is a variance of ' + w.owner + ', which is not a control'); continue; }
    for (const r of w.rows) if (r.section === undefined) r.section = owner.section;
    if (w.effective && owner.effective === undefined) owner.effective = w.effective;
  }
  // Any slider the strobe's variances play straight off S (core/strobe.js
  // VARIANCES) lights its bar from the varied value, unless it has an
  // effective of its own, so a variance never runs with its bar dark. The
  // value goes through the owner's own get(), on a view of S with the
  // effective over the setting, so the bar lands in the slider's units.
  // Looked up on first draw: the strobe registers its owners when it loads.
  const rowsOf = new Map();
  for (const c of controls) {
    if (!c.varianceOf) continue;
    if (!rowsOf.has(c.varianceOf)) rowsOf.set(c.varianceOf, []);
    rowsOf.get(c.varianceOf).push(c.id);
  }
  for (const [id, ids] of rowsOf) {
    const owner = byId.get(id);
    if (!owner || owner.kind !== 'slider' || owner.effective !== undefined) continue;
    let v = null, view = null;
    owner.effective = S => {
      if (!v) { v = varianceOwner(id, ids); if (!v) return undefined; view = Object.create(S); }
      if (!(S[v.amount] > 0) || (v.on && S[v.on] === false) || typeof S[v.eff] !== 'number') return undefined;
      view[v.key] = S[v.eff];
      return owner.get(view);
    };
  }
}

// What a variance dips with, a dropdown row folded out from under its owner
// ahead of the factory's rows: Time (its own rate), the strobe's wave or the
// sun's breath, the same choice the sun's variances carry (core/schema-sun.js
// drivenVariance). The dip's law is the same for all three (core/variance.js
// variedBy); Time is the default, the dip as it always was. Here, in the leaf,
// for the same reason varianceRows is: the rings (schema-visual.js) and the
// flowers' Opacity (schema-flowers.js) both call it while the schema ring
// loads.
const DRIVE_NAMES = { time: 'Time', strobe: 'Link to strobe', breath: 'Link to breath' };
export function driveRow(owner, key, label, parent, section = 'tunnel') {
  const row = {
    id: key, section, label, kind: 'segment', dropdown: true, varianceOf: owner,
    options: DRIVES.map(v => ({ value: v, label: DRIVE_NAMES[v], domId: null })),
    def: 'time',
    get: S => driveOf(S[key]),
    set: (S, v) => { S[key] = driveOf(v); save(); },
    format: S => DRIVE_NAMES[driveOf(S[key])]
  };
  if (parent) row.parent = parent;
  return row;
}
