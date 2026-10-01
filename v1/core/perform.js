// The performer's ramp engine: the live-performance menu (ui/screens/
// performer.js) never sets a control directly. Every change it asks for
// comes through perfSet, and a slider or the colour glides from where it is
// to where the operator pointed over one shared interpolation time, chosen
// on the menu itself (0 to 60 seconds), so a show can be steered in slow
// deliberate moves rather than jumps. A switch cannot glide, so it lands at
// once inside a short transition, the way a preset recall lands one, and the
// audio still crossfades under it.
//
// The engine is a simplified sibling of the journey's ramp (core/journey.js
// stepTween): the same smoothstep ease, the same snap to the control's own
// step each frame, the same never-past-either-end clamp, and the same manner
// of letting go. A control the viewer (or another tab, or a journey ramp)
// moves mid-glide is theirs from then on: the position read back after each
// write is remembered, and a position that is no longer what this engine
// left drops the tween on the spot. Where it differs is shape: the journey
// enters a whole step at once, so it fills parallel arrays; here each
// perfSet is one control on its own clock, so the live tweens sit in a Map
// keyed by control id, one record per glide, reused when a new target
// arrives mid-flight. A frame of perfTick allocates nothing.
//
// A log-tapered slider (a filter frequency, a reverb time) glides in log
// space, the position's logarithm lerped, so the sweep is even to the ear
// the way the fader's travel is even to the hand. The strobe's Frequency
// takes the path every other glide of it takes, with the photosensitive
// band cut out (strobe.js glideSkippingRiskBand).
//
// Beside the engine, the menu's own record: the interpolation seconds and
// the pre-set text rows its trigger pads fire, each row one phrase handed to
// the words (words.js triggerPhrase) with the custom source's '/' line
// breaks honoured. The record is { ver: 1, rampS, texts }, read lazily on
// first use (store.js receives its storage at boot, after this module has
// loaded) under its own key and written back through saveKey, as the
// journey keeps its steps.
import { S } from '../../js/state.js';
import { endGlide } from '../../js/audio.js';
import { byId } from './schema.js';
import {
  beginTransition, applyPresetAt, REPLAY_CONTROLS, machineControl,
  presetTargets, presetMarkActive, presetLabel, presetCount, recallPresetForStep
} from './presets.js';
import { readKey, saveKey } from './store.js';
import { triggerPhrase } from './words.js';
import { glideSkippingRiskBand } from './strobe.js';
import { journeyManualOverride } from './journey.js';

const PERFORM_KEY = 'signal.perform.v1';
export const PERF_RAMP_MIN = 0, PERF_RAMP_MAX = 60;
export const PERF_TEXT_MAX = 300, PERF_TEXTS_MAX = 99;
// A ramp shorter than this is applied as a cut: a tween over a frame or two
// would only be a slower cut (journey.js TWEEN_MIN_S).
const TWEEN_MIN_S = 0.25;
// A cut still opens a transition this long, so it is a quick glide rather
// than a click in every level it moves.
const MIN_GLIDE_S = 0.05;
// What cannot glide (a segment, a switch, an action) lands inside a
// transition this long, the journey's SWITCH_GLIDE_S.
const SWITCH_GLIDE_S = 0.75;

// The record. rampS and texts are read and shown by the window; edits come
// back through setRampS and the window's own writes into texts followed by
// savePerform.
export const perform = { rampS: 5, texts: [] };
let loadedRec = false;

const clampRamp = v => Number.isFinite(v) ? Math.max(PERF_RAMP_MIN, Math.min(PERF_RAMP_MAX, v)) : 5;

// Ensure-loaded, idempotent: the window calls it as it opens, and anything
// here that needs the record calls it first. A stored row that is not a
// string is dropped; one too long is cut at the cap.
export function loadPerform() {
  if (loadedRec) return;
  loadedRec = true;
  let raw = null;
  try { raw = JSON.parse(readKey(PERFORM_KEY) || 'null'); } catch (e) { raw = null; }
  if (!raw || typeof raw !== 'object') return;
  perform.rampS = clampRamp(raw.rampS);
  if (Array.isArray(raw.texts)) {
    for (let i = 0; i < raw.texts.length && perform.texts.length < PERF_TEXTS_MAX; i++) {
      const t = raw.texts[i];
      if (typeof t === 'string') perform.texts.push(t.slice(0, PERF_TEXT_MAX));
    }
  }
}

// saveKey already defers and collapses writes out of the frame that asked,
// so writing back on every edit costs one timer, not one storage write each.
export function savePerform() {
  loadPerform();
  saveKey(PERFORM_KEY, { ver: 1, rampS: perform.rampS, texts: perform.texts });
}

export function setRampS(v) {
  loadPerform();
  if (!Number.isFinite(v)) return;
  v = clampRamp(v);
  if (v === perform.rampS) return;
  perform.rampS = v;
  savePerform();
}

// ---------- the tweens ----------
//
// One record per control on its way, kept in a Map by id. A new perfSet for
// the same id reuses the record in place, retargeting from wherever the
// glide has reached now, so nothing churns per frame; a finished or dropped
// glide leaves the Map. Slider records carry where they started, where they
// are going, the value last asked of set() and the position read back after
// (how a hand on the same fader is noticed and let win), the control's step
// and the power of ten that keeps a fractional step's dust out of state, and
// whether the path is log or skips the strobe's risk band. The colour rides
// the same Map as its own record, three channels each way.
const tweens = new Map();
let nowT = 0;

// ---------- the broadcast's view ----------
// A broadcaster's followers run these glides themselves (core/broadcast.js).
// Each one starting, or retargeted mid-flight, asks for a state message
// (glideStart), which names every glide on its way, where to and how long
// is left (perfEachGlide); a follower hands each to perfFollowGlide and its
// own engine takes it from there. A glide's per-frame writes are marked
// while they run (glideWriting, read by the broadcast's save listener), so
// the broadcast holds them instead of streaming a message every quarter
// second, and the Map emptying (perfTick) asks for the one send that trues
// every screen up (glideLand). A glide let go because a hand took the
// control counts as landed; the hand's own change was sent anyway. The hooks
// are handed in by broadcast.js, as main.js hands the journey setRunning,
// since the broadcast depends on this module and not the other way round;
// on a follower, in worker mode or with no broadcast they are never set.
// glideWriting is 1 for this tab's own glide and 2 for one a follower was
// handed, which the follower's strobe watch passes over: the broadcaster's
// glide arriving is not the viewer taking the strobe. A plain number, so a
// frame allocates nothing.
let glideWriting = 0;
let gliding = false;
let glideStart = null, glideLand = null;
export function setPerfGlideHooks(start, land) { glideStart = start; glideLand = land; }
export const perfGlideWriting = () => glideWriting;
// fn(control, target, secondsLeft) for each slider or colour glide in flight:
// a slider's snapped target, the colour's hex. A variance switch's crossfade
// moves no control's position, so it is not named.
export function perfEachGlide(fn) {
  if (!tweens.size) return;
  for (const tw of tweens.values()) {
    if (tw.kind !== 'slider' && tw.kind !== 'color') continue;
    const left = (tw.t0 + tw.durMs - nowT) / 1000;
    fn(tw.c, tw.kind === 'color' ? tw.hex : tw.to, left > 0 ? left : 0);
  }
}
// A follower's side: a glide the broadcast named, run over what is left of
// it. Not perfSet, whose ask is a hand on the control (it releases a journey
// ramp's hold on it, takes over a layer fade); this only sets the engine
// going. Refused for anything a snapshot would not move (a sub-drawer's
// switch, a control with no get or set) or that is this machine's own
// (presets.js machineControl); startSlider and startColor type-check the
// target. Left under the cut length, it lands at once, which is right for a
// glide whose time ran out on the way here.
export function perfFollowGlide(id, to, sec) {
  const c = byId(id);
  if (!c || c.uiOnly || !c.get || !c.set || machineControl(c)) return false;
  if (!(sec > 0)) sec = 0;
  if (c.kind === 'slider') return startSlider(c, to, sec, true);
  if (c.kind === 'color') return startColor(c, to, sec, true);
  return false;
}
// A follower's viewer taking the strobe for their own: a glide the broadcast
// handed in on one of its controls stops where it is. Their own glides stay.
export function perfFollowDrop(id) {
  const tw = tweens.get(id);
  if (tw && tw.fol) tweens.delete(id);
}

// Two hex digits for each channel value, made once, so a colour on its way
// is one string a frame at most (journey.js does the same).
const HEX2 = new Array(256);
for (let i = 0; i < 256; i++) HEX2[i] = (i < 16 ? '0' : '') + i.toString(16);

const isLog = c => c.taper === 'log' && c.min > 0 && c.max > c.min;

// The power of ten that rounds a fractional step's result clean, as
// widgets.js snaps a drag and journey.js snaps a ramp.
function stepPow(step) {
  let p = 1;
  if (step) for (let d = 0; d < 6 && Math.abs(Math.round(step * p) - step * p) > 1e-9; d++) p *= 10;
  return p;
}

export function perfGet(id) {
  const c = byId(id);
  return c && c.get ? c.get(S) : undefined;
}

export function perfRamping(id) { return tweens.has(id); }

// Where a live glide on this control is headed: a slider's snapped target, the
// colour's target hex, undefined when nothing is on its way. The window parks
// a slider's handle at the goal the moment the operator sets it and lets the
// fill behind the handle catch up, so it needs the destination while the
// control's own get() still reads the moving value.
export function perfTarget(id) {
  const tw = tweens.get(id);
  if (!tw) return undefined;
  if (tw.kind === 'slider') return tw.to;
  if (tw.kind === 'color') return tw.hex;
  if (tw.kind === 'mix') return tw.on;
  return undefined;
}

// A value applied whole, inside its own short glide: the transition door is
// for this landing only, never for a tween's per-frame writes.
function setNow(c, v, sec) {
  beginTransition(Math.max(MIN_GLIDE_S, sec));
  try { c.set(S, v); } finally { endGlide(); }
}

// The door every performer widget uses. Switches (toggle, segment) and
// actions land at once; sliders and the colour set off on a glide over the
// menu's interpolation time. Returns true when the ask was taken, false for
// a control this engine has no way to move (a 'range' variance pair, a text
// field), which the window simply does not offer.
// now (the window's shift-click) bypasses the ramp: the value lands at once
// through the same short declicking transition a switch takes, and any glide
// already running on the control is dropped where it stands.
// sec, when given, is this one glide's own time in place of the menu's
// interpolation (the presets' Ramp time rides through here).
export function perfSet(id, value, now, sec) {
  loadPerform();
  const c = byId(id);
  if (!c) return false;
  journeyManualOverride(id, value);
  const kind = c.kind;

  if (kind === 'action') {
    if (typeof c.act !== 'function') return false;
    beginTransition(SWITCH_GLIDE_S);
    try { c.act(S); } finally { endGlide(); }
    return true;
  }

  if (kind === 'toggle' || kind === 'segment') {
    if (kind === 'toggle' && !(typeof value === 'boolean' || value === 0 || value === 1)) return false;
    if (kind === 'segment') {
      let ok = false;
      for (let k = 0; k < c.options.length; k++) if (c.options[k].value === value) { ok = true; break; }
      if (!ok) return false;
    }
    if (kind === 'toggle' && c.mixKey) return startMix(c, !!value, now);
    beginTransition(SWITCH_GLIDE_S);
    try { if (c.get(S) !== value) c.set(S, value); } finally { endGlide(); }
    return true;
  }

  if (kind === 'slider') takeLayerFade(c);

  if (now && (kind === 'slider' || kind === 'color')) {
    tweens.delete(c.id);
    if (kind === 'slider' && !(typeof value === 'number' && Number.isFinite(value))) return false;
    if (kind === 'color' && !(typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))) return false;
    setNow(c, value, 0);
    return true;
  }
  if (kind === 'slider') return startSlider(c, value, sec);
  if (kind === 'color') return startColor(c, value, sec);
  return false;
}

// ---------- a preset recalled over a ramp ----------
// The presets' Ramp time (presets.js): preset i recalled as one crossfade of
// `sec` seconds, every control travelling from where it is to where the
// preset puts it, through this engine. It used to land the preset whole and
// then pull the sliders and the colour back to glide, which left every
// switch, every mode and everything that is not a control landing at the
// click, inside the preset's own second and a half: a layer or a voice
// switched off simply vanished, and the glides that remained were lost
// under the cut. Now nothing lands first. The preset's positions are read
// without playing it (presets.js presetTargets), and each control goes the
// way it can:
//
//   a slider, the colour    glides over the ramp, as a handle here does;
//   a mode (a segment)      changes as the ramp begins, inside a short
//                           transition whose window spans the ramp, so the
//                           Edge layer's effect crossfades across all of it
//                           (the journey's startRamp does the same);
//   a switch coming on      comes on as the ramp begins, its level
//                           (SWITCH_LEVELS) dropped to nothing first and
//                           gliding up to the preset's;
//   a switch going off      stays on while its level glides down to nothing,
//                           and only as the ramp ends does it go off, its
//                           level going quietly back to the preset's:
//                           perfLayer's fade-out, over the ramp. One with no
//                           level simply holds until the end;
//   a variance switch       crossfades through its mix (startMix).
//
// The switches go first and the sliders read where they set off from after,
// since a mode can change what a slider addresses (clickMode decides whether
// the pip controls are the click's or the chirp's). A slider locked to a
// neighbour (its enabled rule says no, as Pulse rate shows the strobe while
// linked, as a layer's rows are while it stays off) is left for the landing.
//
// When the ramp ends (perfTick) the fade-outs land, and then the preset is
// recalled for real over its usual glide, holding every control a hand took
// on the way (presets.js recallPresetForStep). By then every control is
// where the preset wants it, so that pass moves only what is not a control
// at all (the recordings' levels, the sequencer, the mix, the word effects'
// tables) and whatever was left for it.
//
// A second recall mid-ramp starts from wherever this one has got to: every
// glide retargets from where it stands, a switch still fading out comes back
// up if the new preset wants it on, and one the new preset leaves alone goes
// on fading out. The first recall's landing is dropped; the second lands its
// own. A recall with no ramp lands at once as it always did, after settling
// whatever a ramp still had fading out.
const R = REPLAY_CONTROLS;
// the running recall's targets, filled by presetTargets, index for index
const recallTo = new Array(R.length);
let rIdx = null;
function idxOf(id) {
  if (!rIdx) { rIdx = new Map(); for (let j = 0; j < R.length; j++) rIdx.set(R[j].id, j); }
  const j = rIdx.get(id);
  return j === undefined ? -1 : j;
}
// The recall on its way, or null: { i, label, t0, durMs, offs, leave }. offs
// are the switches held on until the end, each { t, levels } with levels a
// list of { c, to, floor } (to: where the level goes back to once the switch
// is off), or null for a switch with none. leave is the ids left for the
// landing. label is the preset's name, unique in the row, so a row
// rearranged or trimmed under the ramp still lands the preset that began it.
let recall = null;

// The level each switch fades through: the rows of the two windows that fade
// a switch rather than cut it (ui/screens/performer.js LAYERS, ui/screens/
// music.js ROWS), a layer's opacity and a voice's trim, with a layer's trail
// opacity beside it (TRAIL_OP). The text and the fireworks are faded the
// same way though no window row does. The music engine's switch has no level
// of its own, so it fades through its five voices' trims together. A switch
// not listed simply switches. Ids the schema does not know are dropped.
const SWITCH_LEVELS = {
  lField: ['fieldOpacity'], lEdge: ['edgeOpacity'], lCorners: ['cornerOpacity'],
  lRings: ['ringOpacity'], lKaleido: ['kaleidoOpacity'], lFlowers: ['flowerOpacity'],
  lParticles: ['partOpacity'], lConfetti: ['confOpacity'], lFireworks: ['fwBright'],
  lText: ['textOpacity'],
  aTone: ['musTone'], aClick: ['musPulse'],
  musicOn: ['musPiano', 'musClouds', 'musDrone', 'musArp', 'musChoir'],
  pianoOn: ['musPiano'], cloudsOn: ['musClouds'], bedOn: ['musDrone'],
  arpOn: ['musArp'], choirOn: ['musChoir'], ambOn: ['musAmb']
};
let levelMap = null;
function levelsOf(id) {
  if (!levelMap) {
    levelMap = new Map();
    const ok = c => c && c.kind === 'slider' && c.get && c.set;
    for (const k in SWITCH_LEVELS) {
      const out = [];
      for (const lid of SWITCH_LEVELS[k]) {
        const L = byId(lid);
        if (!ok(L)) continue;
        out.push(L);
        const fb = TRAIL_OP[lid] ? byId(TRAIL_OP[lid]) : null;
        if (ok(fb)) out.push(fb);
      }
      if (out.length) levelMap.set(k, out);
    }
  }
  return levelMap.get(id);
}
const floorOf = c => Number.isFinite(c.min) ? c.min : 0;

// A switch is a toggle, or a segment that is only an On/Off pair (the music,
// the clouds, the ambience); any other segment is a mode.
function isSwitch(c) {
  if (c.kind === 'toggle') return true;
  if (c.kind !== 'segment' || !c.options || c.options.length !== 2) return false;
  const a = c.options[0], b = c.options[1];
  return (a.value === true && b.value === false && b.label === 'Off') ||
         (a.value === false && b.value === true && a.label === 'Off');
}

// A switch the last recall was still holding on, or null.
function heldOff(r, c) {
  if (r) for (let k = 0; k < r.offs.length; k++) if (r.offs[k].t === c) return r.offs[k];
  return null;
}

// Where a switch's level belongs once the fade is done: the preset's own, or,
// for a preset that names none, what a fade-out already under way (the last
// recall's, old, or the window's, pend) meant to put back, or where the
// level is, or is headed.
function levelGoal(L, old, pend) {
  const j = idxOf(L.id);
  const v = j >= 0 ? recallTo[j] : undefined;
  if (typeof v === 'number') return v;
  if (old && old.levels) for (let k = 0; k < old.levels.length; k++) if (old.levels[k].c === L) return old.levels[k].to;
  if (pend) { if (pend.op === L) return pend.level; if (pend.fb === L) return pend.fbLevel; }
  return levelOf(L);
}

// Seconds left in the recall's ramp, undefined when none is running: the
// drawer's Ramp time bar drains through it and fills again as it lands.
export function perfRecallLeft() {
  if (!recall) return undefined;
  const left = (recall.t0 + recall.durMs - nowT) / 1000;
  return left > 0 ? left : 0;
}

export function perfRecallPreset(i, sec) {
  loadPerform();
  const prev = recall;
  recall = null;
  if (!(sec >= TWEEN_MIN_S)) {
    if (prev) settleRecall(prev, i);
    applyPresetAt(i);
    return;
  }
  const to = recallTo, n = R.length;
  // no preset at i: whatever was on its way carries on
  if (!presetTargets(i, to)) { recall = prev; return; }
  presetMarkActive(i);
  const rec = { i, label: presetLabel(i), t0: nowT, durMs: sec * 1000, offs: [], leave: new Set() };
  // each switch's level, claimed: down to nothing (a switch going off, which
  // wins over one coming on through the same trim) or up to its goal
  const down = new Set(), upTo = new Map();
  const ups = [], mixes = [];

  // ---- the switches, planned ----
  for (let j = 0; j < n; j++) {
    const c = R[j];
    if (!isSwitch(c) || machineControl(c)) continue;
    const old = heldOff(prev, c);
    let want = to[j];
    if (want === undefined) { if (!old) continue; want = false; }
    want = !!want;
    const on = !!c.get(S);
    if (c.mixKey) { if (want !== on || tweens.has(c.id)) mixes.push(c, want); continue; }
    // a fade-out a window started on it is this recall's now
    const pend = layerFades.get(c.id);
    if (pend) layerFades.delete(c.id);
    if (want === on && !old && !pend) continue;
    if (want && !on) ups.push(c);
    const lv = levelsOf(c.id);
    if (!want && !on) continue;
    if (!want && !lv) { rec.offs.push({ t: c, levels: null }); continue; }
    if (!lv) continue;
    const ls = want ? null : [];
    for (let k = 0; k < lv.length; k++) {
      const L = lv[k], goal = levelGoal(L, old, pend);
      if (typeof goal !== 'number' || !Number.isFinite(goal)) continue;
      if (ls) { ls.push({ c: L, to: goal, floor: floorOf(L) }); down.add(L.id); }
      else upTo.set(L.id, goal);
    }
    if (ls) rec.offs.push({ t: c, levels: ls });
  }

  // ---- the switches coming on, and the modes, as the ramp begins ----
  // Each level of a switch coming on drops to nothing first, through its own
  // short declick, before any switch moves (perfLayer's order), so it comes
  // on silent and dark.
  for (let k = 0; k < ups.length; k++) {
    const lv = levelsOf(ups[k].id);
    if (lv) for (let q = 0; q < lv.length; q++) {
      const L = lv[q];
      if (down.has(L.id) || !upTo.has(L.id)) continue;
      tweens.delete(L.id);
      if (L.get(S) !== floorOf(L)) setNow(L, floorOf(L), 0);
    }
  }
  beginTransition(SWITCH_GLIDE_S, sec);
  try {
    for (let j = 0; j < n; j++) {
      const c = R[j], v = to[j];
      if (v === undefined || machineControl(c) || c.kind === 'slider' || c.kind === 'color') continue;
      if (isSwitch(c)) { if (v && !c.mixKey && !c.get(S)) c.set(S, true); }
      else if (c.get(S) !== v) c.set(S, v);
    }
    for (let k = 0; k < mixes.length; k += 2) startMix(mixes[k], mixes[k + 1], false, sec);
  } finally { endGlide(); }

  // ---- the sliders and the colour, from where they now stand ----
  for (let j = 0; j < n; j++) {
    const c = R[j];
    if ((c.kind !== 'slider' && c.kind !== 'color') || machineControl(c)) continue;
    let goal = to[j];
    if (down.has(c.id)) goal = floorOf(c);
    else if (upTo.has(c.id)) goal = upTo.get(c.id);
    else if (goal === undefined) continue;
    else if (c.enabled && !c.enabled(S)) { if (c.get(S) !== goal) rec.leave.add(c.id); continue; }
    if (c.get(S) === goal && !tweens.has(c.id)) continue;
    journeyManualOverride(c.id, goal);
    if (c.kind === 'slider') { takeLayerFade(c); startSlider(c, goal, sec); }
    else startColor(c, goal, sec);
  }
  recall = rec;
}

// The ramp's end, from perfTick once every glide it started has landed.
function landRecall(r) {
  const offs = r.offs;
  // A switch whose level a hand (or a journey) took on the way stays on
  // where they left it, as perfLayer's does. Judged for every switch before
  // any level is put back, since two switches can share one (the music
  // engine and a voice's trim).
  for (let k = 0; k < offs.length; k++) {
    const o = offs[k];
    o.taken = false;
    if (o.levels && o.t.get(S)) {
      for (let q = 0; q < o.levels.length; q++) {
        const x = o.levels[q];
        if (tweens.has(x.c.id) || x.c.get(S) !== x.floor) o.taken = true;
      }
    }
  }
  beginTransition(SWITCH_GLIDE_S);
  try {
    for (let k = 0; k < offs.length; k++) {
      const o = offs[k];
      if (o.taken) continue;
      if (o.t.get(S)) o.t.set(S, false);
      if (o.levels) for (let q = 0; q < o.levels.length; q++) {
        const x = o.levels[q];
        tweens.delete(x.c.id);
        if (x.c.get(S) !== x.to) x.c.set(S, x.to);
      }
    }
  } finally { endGlide(); }
  // a switch kept on brings the rest of its levels (its trails) back up
  for (let k = 0; k < offs.length; k++) {
    const o = offs[k];
    if (o.taken) for (let q = 0; q < o.levels.length; q++) {
      const x = o.levels[q];
      if (!tweens.has(x.c.id) && x.c.get(S) === x.floor) startSlider(x.c, x.to, r.durMs / 1000);
    }
  }
  // the rest of the preset, for real, every control a hand took held
  let at = presetLabel(r.i) === r.label ? r.i : -1;
  for (let q = 0; at < 0 && q < presetCount(); q++) if (presetLabel(q) === r.label) at = q;
  if (at < 0) return;
  const hold = new Set();
  for (let j = 0; j < R.length; j++) {
    const c = R[j], v = recallTo[j];
    if (v === undefined || r.leave.has(c.id)) continue;
    const now = c.get(S);
    if (now !== v && now === now) hold.add(c.id);
  }
  recallPresetForStep(at, undefined, hold);
}

// A recall with no ramp arriving while one is under way: each switch the ramp
// was holding on goes off now, its level back, unless the new preset wants it
// on, when only its level goes back, for the new preset to take from there.
// Then the cut lands whole over it (applyPresetAt).
function settleRecall(r, i) {
  if (!r.offs.length || !presetTargets(i, recallTo)) return;
  beginTransition(SWITCH_GLIDE_S);
  try {
    for (let k = 0; k < r.offs.length; k++) {
      const o = r.offs[k];
      if (!o.t.get(S)) continue;
      const j = idxOf(o.t.id);
      const keep = j >= 0 && !!recallTo[j];
      if (!keep) o.t.set(S, false);
      if (o.levels) for (let q = 0; q < o.levels.length; q++) {
        const x = o.levels[q];
        tweens.delete(x.c.id);
        if (x.c.get(S) !== x.to) x.c.set(S, x.to);
      }
    }
  } finally { endGlide(); }
}

// ---------- a layer switched on or off from the window ----------
// Rather than landing at once, the layer fades over the ramp time through its
// own opacity control (op): on, the opacity drops to nothing, the layer comes
// on and the opacity glides up to its level; off, the opacity glides down to
// nothing, then the layer goes off and the opacity is quietly put back, so
// the layer keeps its level for next time. now (shift-click), a cut-length
// ramp, a layer with no opacity or one already at nothing just switch.
// A fade-out in flight is kept here by toggle id until perfTick lands it.
//
// A layer with trails fades its trail image's opacity alongside (TRAIL_OP):
// the layer's opacity only thins what goes into the trails, so the trails
// already laid would hold at full strength and then cut when the layer went
// off. The trail opacity glides with it and is put back the same way.
const layerFades = new Map();
// Confetti is not listed: its Opacity already dims its trails
// (gpu/confetti.js), and fading both would square the fade.
const TRAIL_OP = { edgeOpacity: 'edgeFbOpacity', partOpacity: 'partFbOpacity' };
// A slider's level to fade from and back to: where a glide on it is headed,
// or where it is.
function levelOf(c) {
  const tgt = perfTarget(c.id);
  return typeof tgt === 'number' ? tgt : c.get(S);
}
export function perfLayer(toggleId, opId, on, now) {
  loadPerform();
  const t = byId(toggleId);
  if (!t) return false;
  const op = opId ? byId(opId) : null;
  journeyManualOverride(toggleId);
  if (op) journeyManualOverride(op.id);
  const pend = layerFades.get(toggleId);
  layerFades.delete(toggleId);
  if (!op || op.kind !== 'slider') return perfSet(toggleId, on);
  const floor = Number.isFinite(op.min) ? op.min : 0;
  // where the opacity belongs: a fade-out's remembered level, or where a
  // glide on it is headed, or where it is
  const level = pend ? pend.level : levelOf(op);
  // the trail opacity likewise, when the layer has one
  let fb = TRAIL_OP[op.id] ? byId(TRAIL_OP[op.id]) : null;
  if (fb && fb.kind !== 'slider') fb = null;
  const fbFloor = fb && Number.isFinite(fb.min) ? fb.min : 0;
  const fbLevel = !fb ? undefined : pend && pend.fb === fb ? pend.fbLevel : levelOf(fb);
  if (fb) journeyManualOverride(fb.id);
  if (now || perform.rampS < TWEEN_MIN_S || typeof level !== 'number' || level <= floor) {
    if (pend || tweens.has(op.id)) { tweens.delete(op.id); if (op.get(S) !== level) setNow(op, level, 0); }
    if (fb && (pend || tweens.has(fb.id))) { tweens.delete(fb.id); if (typeof fbLevel === 'number' && fb.get(S) !== fbLevel) setNow(fb, fbLevel, 0); }
    return perfSet(toggleId, on);
  }
  // a trail opacity already at nothing (or not a number) is left alone
  const fbFades = fb && typeof fbLevel === 'number' && fbLevel > fbFloor;
  if (on) {
    if (!t.get(S)) {
      tweens.delete(op.id); setNow(op, floor, 0);
      if (fbFades) { tweens.delete(fb.id); setNow(fb, fbFloor, 0); }
      perfSet(toggleId, true);
    }
    if (fbFades) startSlider(fb, fbLevel);
    return startSlider(op, level);   // up from nothing, or back up from where a fade-out had got to
  }
  if (!t.get(S)) return true;
  layerFades.set(toggleId, { t, op, level, floor, fb: fbFades ? fb : null, fbLevel });
  if (fbFades) startSlider(fb, fbFloor);
  return startSlider(op, floor);
}
// The level a layer fading out will come back to, undefined when none is
// fading: the window shows such a layer as off already, and parks its
// opacity handle at that level while the fill runs down.
export function perfLayerLevel(toggleId) {
  const f = layerFades.get(toggleId);
  return f ? f.level : undefined;
}
// A hand on a layer's opacity mid fade-out takes it over: the layer stays on
// wherever they leave it, and its trails come back up. A hand on the trails
// alone leaves them where it put them.
function takeLayerFade(c) {
  if (!layerFades.size) return;
  for (const [tid, f] of layerFades) {
    if (f.op === c) { layerFades.delete(tid); if (f.fb) startSlider(f.fb, f.fbLevel); }
    else if (f.fb === c) f.fb = null;
  }
}
// Once the fade-out's glide has landed: the layer goes off and its opacity
// goes back to its level, and its trail opacity too. If the glide was let go
// anywhere but the floor, a hand (or a journey) took the opacity over, and
// the layer stays on.
function landLayerFades() {
  for (const [tid, f] of layerFades) {
    if (tweens.has(f.op.id)) continue;
    layerFades.delete(tid);
    // the layer stays on, so its trails come back up
    if (f.op.get(S) !== f.floor) { if (f.fb) startSlider(f.fb, f.fbLevel); continue; }
    beginTransition(SWITCH_GLIDE_S);
    try {
      if (f.t.get(S)) f.t.set(S, false);
      f.op.set(S, f.level);
      if (f.fb) { tweens.delete(f.fb.id); f.fb.set(S, f.fbLevel); }
    } finally { endGlide(); }
  }
}

// ---------- a switch that crossfades ----------
// A toggle with a mixKey (a variance switch) does not cut: its S[mixKey], 0
// the plain setting and 1 the switch's full effect, glides over the ramp
// time. On, the switch goes on at once with the mix at 0 and the mix rises;
// off, the mix falls and the switch goes off when it lands, the mix left at
// 1 for whatever turns it on next. now (shift-click) or a cut-length ramp
// switches at once. A second click mid-glide turns back from where it is.
// sec, when given, is the ramp in place of the menu's (a preset's recall).
function startMix(c, on, now, sec) {
  const key = c.mixKey;
  const cur = Number.isFinite(S[key]) ? S[key] : 1;
  const rampS = sec ?? perform.rampS;
  if (now || rampS < TWEEN_MIN_S) {
    tweens.delete(c.id);
    S[key] = 1;
    beginTransition(SWITCH_GLIDE_S);
    try { if (c.get(S) !== on) c.set(S, on); } finally { endGlide(); }
    return true;
  }
  let tw = tweens.get(c.id);
  const running = !!tw && tw.kind === 'mix';
  if (!running) {
    if (c.get(S) === on) return true;
    tw = { kind: 'mix', c, t0: 0, durMs: 0, from: 0, to: 0, on: false, warm: false };
    tweens.set(c.id, tw);
  }
  // from nothing when the switch is off, or from wherever a glide had got to
  const from = c.get(S) ? (running ? cur : 1) : 0;
  if (on && !c.get(S)) { S[key] = 0; c.set(S, true); }
  tw.warm = running;
  tw.t0 = nowT; tw.durMs = rampS * 1000;
  tw.from = from; tw.to = on ? 1 : 0; tw.on = on;
  S[key] = from;
  return true;
}
function stepMix(tw, u, e) {
  const c = tw.c, key = c.mixKey;
  // switched off elsewhere: nothing left to fade
  if (!c.get(S)) { S[key] = 1; return false; }
  S[key] = u < 1 ? tw.from + (tw.to - tw.from) * e : tw.to;
  if (u < 1) return true;
  if (!tw.on) { c.set(S, false); S[key] = 1; }
  return false;
}

// fol marks a glide a broadcast's follower started (perfFollowGlide below);
// any other ask of the same control makes it this tab's own again.
function startSlider(c, to, sec, fol) {
  if (typeof to !== 'number' || !Number.isFinite(to)) return false;
  if (Number.isFinite(c.min) && Number.isFinite(c.max)) to = Math.max(c.min, Math.min(c.max, to));
  const step = c.step > 0 ? c.step : 0;
  const p = stepPow(step);
  if (step) to = Math.round(Math.round(to / step) * step * p) / p;

  const rampS = sec ?? perform.rampS;
  if (rampS < TWEEN_MIN_S) {
    tweens.delete(c.id);
    if (c.get(S) !== to) setNow(c, to, rampS);
    return true;
  }
  const from = c.get(S);
  // a position that is not a number cannot travel; it lands
  if (typeof from !== 'number' || !Number.isFinite(from)) { tweens.delete(c.id); setNow(c, to, rampS); return true; }
  if (from === to) { tweens.delete(c.id); return true; }

  // retargeting reuses the record: the glide picks up from where it is
  let tw = tweens.get(c.id);
  const warm = !!tw && tw.kind === 'slider';
  if (!warm) { tw = { kind: 'slider', c, t0: 0, durMs: 0, from: 0, to: 0, sent: 0, last: 0, step: 0, p: 1, band: 0, log: 0, warm: false, fol: 0 }; tweens.set(c.id, tw); }
  tw.warm = warm;
  // A glide already under way picks up from its own exact position (sent)
  // rather than the readout's, which can be rounded: a percent control reads
  // whole numbers, and restarting from the rounded one every drag frame threw
  // the fraction away and pinned the value in place. Only if nothing else has
  // moved the control since; otherwise its current reading is the start.
  const f0 = warm && from === tw.last && Number.isFinite(tw.sent) ? tw.sent : from;
  tw.t0 = nowT; tw.durMs = rampS * 1000;
  tw.from = f0; tw.to = to; tw.sent = f0; tw.last = from;
  tw.step = step; tw.p = p;
  tw.band = c.id === 'freq' ? 1 : 0;
  tw.log = !tw.band && isLog(c) && from > 0 && to > 0 ? 1 : 0;
  tw.fol = fol ? 1 : 0;
  // the broadcast's glide-start message (see "the broadcast's view" below)
  if (glideStart) glideStart();
  return true;
}

function startColor(c, hex, sec, fol) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const rgb = S.rgb;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  if (rgb[0] === r && rgb[1] === g && rgb[2] === b) { tweens.delete(c.id); return true; }
  const rampS = sec ?? perform.rampS;
  if (rampS < TWEEN_MIN_S) {
    tweens.delete(c.id);
    setNow(c, hex, rampS);
    return true;
  }
  let tw = tweens.get(c.id);
  const warm = !!tw && tw.kind === 'color';
  if (!warm) { tw = { kind: 'color', c, t0: 0, durMs: 0, hex: '', f: [0, 0, 0], t: [0, 0, 0], l: [0, 0, 0], warm: false, fol: 0 }; tweens.set(c.id, tw); }
  tw.warm = warm;
  tw.t0 = nowT; tw.durMs = rampS * 1000; tw.hex = hex;
  tw.f[0] = rgb[0]; tw.f[1] = rgb[1]; tw.f[2] = rgb[2];
  tw.t[0] = r; tw.t[1] = g; tw.t[2] = b;
  tw.l[0] = rgb[0]; tw.l[1] = rgb[1]; tw.l[2] = rgb[2];
  tw.fol = fol ? 1 : 0;
  if (glideStart) glideStart();
  return true;
}

// One frame of a slider's glide. True while it lives, false once it lands or
// is let go. No beginTransition here: per-frame writes ride the frame, and
// the transition door was for the switch landing only.
function stepSlider(tw, u, e) {
  const c = tw.c;
  // someone else moved it; it is theirs, drop the ramp
  if (c.get(S) !== tw.last) return false;
  const from = tw.from, to = tw.to;
  let v = to;
  if (u < 1) {
    if (tw.band) v = glideSkippingRiskBand(from, to, e);
    else if (tw.log) v = Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * e);
    else v = from + (to - from) * e;
    // No step snap mid-glide: snapping each frame turns a small move on a
    // coarse control into a few visible notches spread across the ramp. The
    // value travels continuously and lands on the snapped target (to, set
    // in startSlider) on the final frame.
    // it never overshoots either end
    if (from < to) { if (v < from) v = from; else if (v > to) v = to; }
    else if (v < to) v = to; else if (v > from) v = from;
  }
  if (v !== tw.sent) {
    tw.sent = v;
    glideWriting = tw.fol ? 2 : 1;
    try { c.set(S, v); } finally { glideWriting = 0; }
    tw.last = c.get(S);
  }
  return u < 1;
}

// One frame of the colour's crossing, in RGB, channels rounded; the final
// frame sets the exact target hex. A running colour walk writes S.rgb in
// stepStrobe immediately before this tick, so the ramp deliberately paints
// over that moving value each frame and updates S.hue with it. Once the ramp
// lands, the walk continues from the chosen colour. With the walk off, an
// outside colour change still takes ownership and cancels this ramp.
function stepColorTw(tw, u, e) {
  const rgb = S.rgb;
  if ((S.colorWalk || 0) <= 0 && (rgb[0] !== tw.l[0] || rgb[1] !== tw.l[1] || rgb[2] !== tw.l[2])) return false;
  let r = tw.t[0], g = tw.t[1], b = tw.t[2];
  if (u < 1) {
    r = Math.round(tw.f[0] + (tw.t[0] - tw.f[0]) * e);
    g = Math.round(tw.f[1] + (tw.t[1] - tw.f[1]) * e);
    b = Math.round(tw.f[2] + (tw.t[2] - tw.f[2]) * e);
  }
  if (r !== tw.l[0] || g !== tw.l[1] || b !== tw.l[2]) {
    glideWriting = tw.fol ? 2 : 1;
    try { tw.c.set(S, u < 1 ? '#' + HEX2[r] + HEX2[g] + HEX2[b] : tw.hex); } finally { glideWriting = 0; }
    const now = S.rgb;
    tw.l[0] = now[0]; tw.l[1] = now[1]; tw.l[2] = now[2];
  }
  return u < 1;
}

// Once a frame, from main.js, with the rAF timestamp: every live glide moves
// a little further on the same eased curve the journey uses. Deleting while
// iterating is what Map is for; nothing else here allocates.
// The shape of a glide: nearly straight, eased only at its ends. The first
// and last EASE_END of the time accelerate and settle, and everything between
// moves at one steady pace, so an 8 s ramp is visibly on its way from the
// first second and arrives without a lurch. (A smoothstep S-curve, the
// journey's, spends its first quarter barely moving and rushes the middle,
// which over a long ramp reads as nothing and then a jump.) A retarget of a
// glide already under way, as every frame of a drag is, starts warm: no
// acceleration from rest, so a drag never freezes the value where it is.
const EASE_END = 0.15;
function glideShape(u, warm) {
  const a = warm ? 0 : EASE_END, d = EASE_END;
  const vmax = 1 / (1 - a / 2 - d / 2);
  if (u < a) return vmax * u * u / (2 * a);
  if (u < 1 - d) return vmax * (a / 2 + (u - a));
  const r = 1 - u;
  return 1 - vmax * r * r / (2 * d);
}
// A wake (core/wake.js): every glide in flight is carried forward by the
// time spent away, so it resumes from where it stood rather than landing
// in one frame. Runs once per wake, never per frame.
export function perfResume(away) {
  if (!(away > 0)) return;
  if (recall) recall.t0 += away;
  if (!tweens.size) return;
  for (const tw of tweens.values()) tw.t0 += away;
}
export function perfTick(t) {
  nowT = t;
  if (tweens.size) {
    for (const tw of tweens.values()) {
      const x = (t - tw.t0) / tw.durMs;
      const u = x >= 1 ? 1 : x > 0 ? x : 0;
      const e = glideShape(u, tw.warm);
      const alive = tw.kind === 'color' ? stepColorTw(tw, u, e)
        : tw.kind === 'mix' ? stepMix(tw, u, e) : stepSlider(tw, u, e);
      if (!alive) tweens.delete(tw.c.id);
    }
  }
  if (layerFades.size) landLayerFades();
  // a preset's ramp whose time is up: its own glides have all landed above
  if (recall && t - recall.t0 >= recall.durMs) {
    const r = recall;
    recall = null;
    landRecall(r);
  }
  // Every glide gone, landed or let go, this frame or since the last one:
  // the final writes above have all been made, so the broadcast's landing
  // send carries them.
  if (gliding && !tweens.size && glideLand) glideLand();
  gliding = tweens.size > 0;
}

// A trigger pad: row i's phrase goes up now, through the words' own one-shot
// (words.js triggerPhrase), '/' line breaks and all. An empty row is a pad
// that does nothing.
export function triggerText(i) {
  loadPerform();
  const t = perform.texts[i];
  if (typeof t !== 'string' || !t.trim()) return;
  triggerPhrase(t);
}
