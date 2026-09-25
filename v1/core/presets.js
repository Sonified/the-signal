// Preset apply, ported from js/presets.js's applyPreset but driven through
// the schema instead of through real DOM elements and synthetic events.
//
// v0 built a preset out of whatever surface happened to hold the value: an
// <input> got its .value set and an 'input' event dispatched, a button got
// .click()ed, a few fields were written onto S directly. None of those
// surfaces exist here, so every one of them is replaced by the matching
// Control's own get/set, looked up the same way v0 looked up an element: by
// its v0 id. The PRESETS data itself is untouched, imported straight from
// js/presets.js, since that data is just numbers and ids and carries no DOM
// of its own. js/presets.js's own applyPreset is never called; it is built
// entirely out of $(id).click() and dispatchEvent, which do not exist here.
//
// On top of the built-ins sit the viewer's own presets. Shift-clicking any
// preset saves the current settings over it, and the + chip adds a new one.
// Both kinds are stored as snapshots (store.js's snapshot(), the settings
// object exactly as a saved session writes it) under their own storage key,
// so a built-in that has been saved over keeps its name and its place in the
// row but recalls the viewer's version instead of the v0 recipe.
import { S } from '../../js/state.js';
import { PRESETS } from '../../js/presets.js';
import { syncAmbLayers } from '../../js/ambience.js';
import { beginGlide, endGlide, PRESET_GLIDE_S } from '../../js/audio.js';
import { glideStrobeFreq } from './strobe.js';
import { byId, byDomId, CONTROLS } from './schema.js';
import { save, snapshot, applySnapshot, readKey, saveKey } from './store.js';
import { rebuildWordPool } from './words.js';

// A "click" on a v0 button, resolved through byDomId. For a segment option
// (cmChirp, aLink, biHard, and every visual per-mode button) this sets the
// owning control to that option's own value, the same thing choosing that
// button in the drawer would do. For a single-button toggle found by its own
// id (harmToggle, biToggle, the two audio sources) there is no option to
// read a value from, so it flips, matching what clicking that one button in
// v0 actually does.
function clickButton(domId) {
  const hit = byDomId(domId);
  if (!hit) return;
  const { control, option } = hit;
  control.set(S, option ? option.value : !control.get(S));
}

// A checkbox or segment control set to an explicit boolean, only touched
// when it is not already there. Mirrors v0's own guard on every one of these
// (the layer checkboxes, bilateral, harmonics, the two audio sources): a
// preset that does not mention a switch must not toggle it by accident.
function setBoolIfNeeded(id, want) {
  if (typeof want !== 'boolean') return;
  const control = byId(id);
  if (control && !!control.get(S) !== want) control.set(S, want);
}

// A preset recall is a transition, not a jump. Everything a preset moves
// glides from where it is to where the preset puts it, in straight lines over
// one shared window (PRESET_GLIDE_S in js/audio.js): every audio level and
// parameter, the rooms, the music and atmosphere gains, and the strobe
// frequency, which glides with the audio so a linked pulse stays locked to
// the field throughout. The transition only has to be open while the set()
// calls run; audio.js carries its end time to the work that lands later.
//
// Each one also bumps a counter, which the frame profiler (core/profiler.js)
// reads once a frame to mark the frames a transition was running in. A
// counter rather than a timestamp, because this module keeps no clock.
let transitionCount = 0;
export const presetTransitionCount = () => transitionCount;
function beginTransition() {
  transitionCount++;
  beginGlide(PRESET_GLIDE_S);
  glideStrobeFreq(PRESET_GLIDE_S);
}

export function applyPreset(name) {
  beginTransition();
  try { applyPresetNow(name); } finally { endGlide(); }
}

function applyPresetNow(name) {
  ensureLoaded();
  const over = data.overrides[name];
  if (over) { applySnapshotLive(over); return; }
  const P = PRESETS[name];
  if (!P) return;

  // The click and chirp pip controls share five state keys. Selecting the
  // requested voice has to happen before P.inputs is applied, or a Gamma
  // click level lands in the chirp slot instead.
  if (P.clickMode && P.clickMode !== S.clickMode) {
    clickButton(P.clickMode === 'click' ? 'cmClick' : 'cmChirp');
  }

  for (const [id, val] of Object.entries(P.inputs || {})) {
    const control = byId(id);
    if (control) control.set(S, val);
  }
  for (const [id, val] of Object.entries(P.selects || {})) {
    const control = byId(id);
    if (control) control.set(S, val);
  }
  // Layer checkboxes (and, for a preset that mentions it, the audio layer)
  // are toggles: only clicked when they are not already where the preset
  // wants them, same guard v0 used on el.checked.
  for (const [id, want] of Object.entries(P.layers || {})) {
    setBoolIfNeeded(id, want);
  }
  (P.buttons || []).forEach(domId => clickButton(domId));
  setBoolIfNeeded('biToggle', P.bilateral);
  setBoolIfNeeded('harmToggle', P.harmonics);
  // The corner cycle derives its own label from colorWalk/perElementColor
  // everywhere else in the schema; a preset is the one place v0 wrote
  // S.colorMode directly rather than driving it from those two, so this
  // does the same rather than inventing a control for a field nothing else
  // ever sets by hand.
  if (P.colorMode) S.colorMode = P.colorMode;
  if (P.sources) {
    setBoolIfNeeded('aTone', P.sources.tone);
    setBoolIfNeeded('aClick', P.sources.click);
  }
  if (P.state) Object.assign(S, P.state);
  save();
}

// Matches the <option> list of v0's #presetSel, in the same order.
export const PRESET_LIST = [
  { name: 'colorwalk', label: 'Color walk' },
  { name: 'magenta',   label: 'Magenta world' },
  { name: 'genus',     label: 'Gamma 40' },
  { name: 'theta',     label: 'Alpha-theta 7.5' },
  { name: 'breath',    label: 'Resonance breath' },
  { name: 'sleep',     label: 'Sleep' },
  { name: 'focus',     label: 'Grounded alert 10' }
];

// ---------- snapshots, recalled live ----------

// Every control a snapshot can move: sliders, segments, toggles and the
// colour. Actions are left out because they do something rather than hold a
// value, and the multi-select word themes because their set() toggles one
// key rather than assigning. clickMode goes first, for the same reason it
// does in applyPreset above: the five shared pip controls address the click
// or the chirp by S.clickMode, so the voice has to be settled before them.
const REPLAY = CONTROLS.filter(c =>
  (c.kind === 'slider' || c.kind === 'segment' || c.kind === 'toggle' || c.kind === 'color') &&
  !c.multi && c.get && c.set);
REPLAY.sort((a, b) => (b.id === 'clickMode') - (a.id === 'clickMode'));
const before = new Array(REPLAY.length);

// store.applySnapshot writes state and nothing else, which is all a boot
// needs, but mid-session the audio graph, the edge particles and the rest
// only change when a control's set() tells them to. So every control's
// position is read before and after the state lands, and each one that
// moved is set again to its new position, which runs exactly the side
// effects dragging it there would have. Only the controls that changed are
// touched, so a piano that was already playing is not started a second time.
//
// A control's position can be coarser than its state (a level stored as an
// amplitude, shown as a whole-percent slider), and a couple of controls
// write through to a neighbour (Pulse rate reads the strobe frequency while
// linked), so the set() pass can leave S a hair off the snapshot. The
// snapshot is applied once more at the end, which puts every field back
// exactly as saved without triggering anything further.
//
// replayLive is that whole pass with the state write left to the caller:
// `apply` puts new values into S and does nothing else, and is run twice.
// A preset recall hands it applySnapshot; store.js's syncFromStorage hands
// it the change another tab just wrote, so a setting moved in one tab moves
// the sound and the scene in every other open tab the same way.
//
// The whole pass is a transition (see beginTransition above), so a snapshot
// glides in exactly as a built-in does, and so does a change from another tab.
export function replayLive(apply) {
  beginTransition();
  try {
    for (let i = 0; i < REPLAY.length; i++) before[i] = REPLAY[i].get(S);
    const layersBefore = S.ambLayers;
    apply();
    keepLayerObjects(layersBefore);
    for (let i = 0; i < REPLAY.length; i++) {
      const c = REPLAY[i], now = c.get(S);
      if (now !== before[i]) c.set(S, now);
    }
    apply();
    keepLayerObjects(layersBefore);
    // Always, not only when the array changed: the levels now change in
    // place, and the sync is what glides each recording to its new level.
    syncAmbLayers();
    rebuildWordPool();
  } finally {
    endGlide();
  }
}

// A snapshot writes a fresh S.ambLayers array whenever any recording's level
// differs. The atmosphere keys every playing voice by its layer object, so a
// fresh array read as every recording having been removed and a new one
// added: each was faded out and started again from a random point, a restart
// of the whole atmosphere on every recall. When the new list names the same
// recordings in the same order (it always does once normalised), the new
// levels, mutes and solos are copied onto the objects already playing and the
// old array is kept, so each recording just glides to its new level.
function keepLayerObjects(prev) {
  const next = S.ambLayers;
  if (next === prev || !Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return;
  for (let i = 0; i < next.length; i++) {
    if (!prev[i] || !next[i] || prev[i].source !== next[i].source) return;
  }
  for (let i = 0; i < next.length; i++) {
    const a = prev[i], b = next[i];
    a.level = b.level; a.peak = b.peak; a.muted = b.muted; a.solo = b.solo;
  }
  S.ambLayers = prev;
}

function applySnapshotLive(snap) {
  replayLive(() => applySnapshot(snap));
  save();
}

// ---------- the viewer's own presets ----------

// { overrides: { [builtinName]: snapshot }, user: [ { name, snapshot } ],
//   order: ['b:<builtin name>' | 'u:<user name>', ...], hidden: [builtinName] },
// read lazily on first use (store.js receives its storage at boot, after
// this module has loaded) and written back through store.saveKey.
//
// The drawer's row is `row`, rebuilt from that record: each entry is either a
// built-in (b, its index in PRESET_LIST) or one of the viewer's (u, the
// object in data.user). `order` is the viewer's arrangement of it (the Edit
// mode's drag); `hidden` is the built-ins they have deleted, which stay gone.
// A preset the order does not mention (a built-in added in a later version,
// or a record written before there was an order) joins at the end: built-ins
// first in their own order, then the viewer's, which is the row as it always
// was when nothing has been arranged.
const PRESETS_KEY = 'signal.presets.v1';
const NAME_MAX = 32;
let data = null;
let version = 0;
let row = [];

function ensureLoaded() {
  if (data) return;
  data = { overrides: {}, user: [], order: null, hidden: [], active: null };
  let raw = null;
  try { raw = JSON.parse(readKey(PRESETS_KEY) || 'null'); } catch (e) { raw = null; }
  if (raw && typeof raw === 'object') readRecord(raw);
  rebuildRow();
}

function readRecord(raw) {
  if (Array.isArray(raw.order)) data.order = raw.order.filter(k => typeof k === 'string');
  if (Array.isArray(raw.hidden)) data.hidden = raw.hidden.filter(k => typeof k === 'string');
  if (typeof raw.active === 'string') data.active = raw.active;
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const p of PRESET_LIST) {
      const snap = raw.overrides[p.name];
      if (snap && typeof snap === 'object') data.overrides[p.name] = snap;
    }
  }
  if (Array.isArray(raw.user)) {
    for (const u of raw.user) {
      if (!u || typeof u.name !== 'string' || !u.snapshot || typeof u.snapshot !== 'object') continue;
      const name = u.name.trim().slice(0, NAME_MAX);
      if (name) data.user.push({ name, snapshot: u.snapshot });
    }
  }
}

function rebuildRow() {
  const hidden = new Set(data.hidden);
  const usedB = new Set(), usedU = new Set();
  const next = [];
  if (data.order) {
    for (const key of data.order) {
      const nm = key.slice(2);
      if (key.startsWith('b:')) {
        const i = PRESET_LIST.findIndex(p => p.name === nm);
        if (i >= 0 && !usedB.has(i) && !hidden.has(nm)) { usedB.add(i); next.push({ b: i, u: null }); }
      } else if (key.startsWith('u:')) {
        const u = data.user.find(x => x.name === nm && !usedU.has(x));
        if (u) { usedU.add(u); next.push({ b: -1, u }); }
      }
    }
  }
  PRESET_LIST.forEach((p, i) => { if (!usedB.has(i) && !hidden.has(p.name)) next.push({ b: i, u: null }); });
  for (const u of data.user) if (!usedU.has(u)) next.push({ b: -1, u });
  row = next;
}

// A row entry's lasting name, the same form the saved order uses.
function entryKey(e) { return e.u ? 'u:' + e.u.name : 'b:' + PRESET_LIST[e.b].name; }

function persist() {
  version++;
  data.order = row.map(entryKey);
  saveKey(PRESETS_KEY, data);
}

// Another tab saved, added or renamed a preset. The in-memory copy is
// dropped and read afresh on next use, and the version moves so the drawer
// remeasures its chips; otherwise this tab would keep showing the old row
// and its next save would write the old row back over the new one. Returns
// true when the key was the presets record.
export function syncPresetsFromStorage(key) {
  if (key !== PRESETS_KEY) return false;
  if (data) { data = null; version++; }
  return true;
}

// Trims, refuses an empty name (the caller treats that as a cancel), and
// keeps every label in the row distinct, built-ins included, by counting up:
// "Evening", "Evening 2", "Evening 3". Compared without case, since two chips
// reading "evening" and "Evening" would be just as confusing. skipUser lets a
// rename keep its own current name.
function uniqueName(raw, skipUser) {
  const base = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!base) return null;
  const taken = n => {
    const l = n.toLowerCase();
    for (const p of PRESET_LIST) if (p.label.toLowerCase() === l) return true;
    for (let j = 0; j < data.user.length; j++) if (j !== skipUser && data.user[j].name.toLowerCase() === l) return true;
    return false;
  };
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const cand = base + ' ' + n;
    if (!taken(cand)) return cand;
  }
}

// The drawer's view of the row, index by index (see rebuildRow). Every
// accessor here is allocation-free, since the drawer calls them each frame;
// presetsVersion() changes whenever the list, its order or a label does, so
// the drawer knows when to remeasure its chips.
export function presetsVersion() { ensureLoaded(); return version; }
export function presetCount() { ensureLoaded(); return row.length; }
export function presetIsUser(i) { ensureLoaded(); return !!(row[i] && row[i].u); }
export function presetLabel(i) {
  ensureLoaded();
  const e = row[i];
  return !e ? '' : e.u ? e.u.name : PRESET_LIST[e.b].label;
}
// The preset last clicked (or saved over, or just made): the drawer lights
// it. It stays lit until another one takes over, and is kept with the row,
// so a reload, which restores the same settings, still shows it.
export function presetIsActive(i) {
  ensureLoaded();
  const e = row[i];
  return !!e && data.active !== null && entryKey(e) === data.active;
}
function setActive(e) {
  const k = e ? entryKey(e) : null;
  if (k === data.active) return;
  data.active = k;
  persist();
}

// True for a built-in the viewer has saved over.
export function presetHasOverride(i) {
  ensureLoaded();
  const e = row[i];
  return !!e && !e.u && !!data.overrides[PRESET_LIST[e.b].name];
}

export function applyPresetAt(i) {
  ensureLoaded();
  const e = row[i];
  if (!e) return;
  if (e.u) applySnapshotLive(e.u.snapshot);
  else applyPreset(PRESET_LIST[e.b].name);
  setActive(e);
}

export function savePresetOverAt(i) {
  ensureLoaded();
  const e = row[i];
  if (!e) return;
  savePresetOver(e.u ? data.user.indexOf(e.u) : PRESET_LIST[e.b].name);
  setActive(e);
}

// Edit mode's ×: a preset of the viewer's is removed outright; a built-in is
// hidden (and anything saved over it dropped), so it stays gone.
export function deletePresetAt(i) {
  ensureLoaded();
  const e = row[i];
  if (!e) return;
  if (entryKey(e) === data.active) data.active = null;
  if (e.u) {
    const j = data.user.indexOf(e.u);
    if (j >= 0) data.user.splice(j, 1);
  } else {
    const nm = PRESET_LIST[e.b].name;
    if (!data.hidden.includes(nm)) data.hidden.push(nm);
    delete data.overrides[nm];
  }
  row.splice(i, 1);
  persist();
}

// Edit mode's drag: the preset at `from` moves to sit at `to`, counted in the
// row as it is once the preset has been lifted out.
export function movePreset(from, to) {
  ensureLoaded();
  if (from < 0 || from >= row.length || to < 0 || to >= row.length || from === to) return;
  const e = row.splice(from, 1)[0];
  row.splice(to, 0, e);
  persist();
}

// Shift-click: a string names a built-in, a number is an index into the
// viewer's own presets.
export function savePresetOver(target) {
  ensureLoaded();
  if (typeof target === 'string') {
    if (!PRESETS[target]) return;
    data.overrides[target] = snapshot();
  } else {
    const u = data.user[target];
    if (!u) return;
    u.snapshot = snapshot();
  }
  persist();
}

// Saves the current settings as a new preset. Returns its index in the
// drawer's row, or -1 when the name was empty and nothing was made.
export function addUserPreset(name) {
  ensureLoaded();
  const clean = uniqueName(name, -1);
  if (!clean) return -1;
  const u = { name: clean, snapshot: snapshot() };
  data.user.push(u);
  row.push({ b: -1, u });
  data.active = 'u:' + u.name;        // it holds the settings on screen now
  persist();
  return row.length - 1;
}

// Renames one of the viewer's presets (userIndex counts from the first of
// them, not from the start of the row). An empty name leaves it as it was.
export function renameUserPreset(userIndex, name) {
  ensureLoaded();
  const u = data.user[userIndex];
  if (!u) return false;
  const clean = uniqueName(name, userIndex);
  if (!clean) return false;
  if (data.active === 'u:' + u.name) data.active = 'u:' + clean;
  u.name = clean;
  persist();
  return true;
}
