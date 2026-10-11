const noop = () => {};
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: () => null, length: 0 };
globalThis.window = globalThis; globalThis.addEventListener = noop; globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : any, apply: () => any, construct: () => any, set: () => true });
globalThis.document = any; for (const k of ['AudioContext','Worker','BroadcastChannel','ResizeObserver','Image','WebSocket','Audio','OffscreenCanvas','MessageChannel','AudioWorkletNode','GainNode','OscillatorNode','MediaStream','IntersectionObserver','MutationObserver','PointerEvent','KeyboardEvent','Event','CustomEvent','EventTarget','FontFace','fetch','screen','visualViewport']) globalThis[k] ??= any;
globalThis.location = { search: '', hostname: 'localhost', href: 'http://localhost/' };
globalThis.requestAnimationFrame = noop;
globalThis.__simT = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => globalThis.__simT }, configurable: true, writable: true });
globalThis.dispatchEvent = () => true; globalThis.removeEventListener = () => {};
const root = process.argv[2];
const { S } = await import(root + '/js/state.js');
const J = await import(root + '/core/journey.js');
const P = await import(root + '/core/perform.js');
const { byId } = await import(root + '/core/schema.js');
const flush = () => new Promise(r => setTimeout(r, 0));
let fails = 0;
const eq = (name, got, want) => { const ok = Object.is(got, want); if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + JSON.stringify(got) + (ok ? '' : ' (want ' + JSON.stringify(want) + ')')); };
const g = id => byId(id).get(S);
let t = 1000;
let MG = null;
const run = (sec, fps = 30) => { const end = t + sec * 1000; while (t < end) { t += 1000 / fps; globalThis.__simT = t; J.stepJourney(t); P.perfTick(t); if (MG) MG.stepMixGates(); } };
const origLog = console.log; const quiet = f => { console.log = () => {}; try { return f(); } finally { console.log = origLog; } };
P.perfTick(t); J.stepJourney(t);

// ---- FIX 1, the engine alone ----
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
eq('bedOn starts on', g('bedOn'), true);
P.perfLayer('bedOn', false);
eq('mid-fade toggle reads', g('bedOn'), true);
eq('perfDestination(bedOn)', P.perfDestination('bedOn'), false);
eq('perfDestination(musDrone)', P.perfDestination('musDrone'), 80);
run(P.perform.rampS / 2);
eq('halfway musDrone below 80', g('musDrone') < 80 && g('musDrone') > 0, true);
eq('halfway destination still 80', P.perfDestination('musDrone'), 80);
run(P.perform.rampS / 2 + 0.5);
eq('landed bedOn', g('bedOn'), false);
eq('landed musDrone restored', g('musDrone'), 80);
eq('landed destination gone', P.perfDestination('bedOn'), undefined);
// twin through the fade: ambOn faded, ambMixerPower follows
byId('ambOn').set(S, true); byId('musAmb').set(S, 70);
P.perfLayer('ambOn', false);
eq('perfDestination(ambOn)', P.perfDestination('ambOn'), false);
run(P.perform.rampS + 0.5);
byId('ambOn').set(S, true);

// ---- FIX 1, through the journey ----
quiet(() => { J.journeyAddStep(); J.journeyAddStep(); J.journeyAddStep(); });
quiet(() => J.journeySetWindowOpen(true));
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
quiet(() => J.journeySelect(1)); await flush();
const st1 = J.journeyStepAt(1), st2 = J.journeyStepAt(2);
quiet(() => P.perfLayer('bedOn', false)); await flush();
eq('armed: step 2 records bedOn off at the click', st1.overrides.bedOn, false);
eq('armed: step 2 holds the trim at its level, never the falling value', st1.overrides.musDrone, 80);
run(1); await flush();
eq('armed: mid-fade diffs keep the trim at its level', st1.overrides.musDrone, 80);
// (a) the next step does not name the drone: the fade lands, nothing recorded there
delete st2.overrides.bedOn; delete st2.overrides.musDrone;
quiet(() => J.journeySelect(2)); await flush();
quiet(() => run(P.perform.rampS + 0.5)); await flush(); quiet(() => run(0.5)); await flush();
eq('(a) fade landed after moving on: bedOn off', g('bedOn'), false);
eq('(a) step 3 not contaminated (bedOn)', st2.overrides.bedOn, undefined);
eq('(a) step 3 not contaminated (musDrone)', st2.overrides.musDrone, undefined);
eq('(a) step 2 still holds off', st1.overrides.bedOn, false);
// (b) the next step names the drone on: it takes the fade, the drone stays on, nothing flips
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
st2.overrides.bedOn = true;
quiet(() => J.journeySelect(1)); await flush();
eq('(b) entering step 2 turns drone off', g('bedOn'), false);
byId('bedOn').set(S, true); await flush();
quiet(() => P.perfLayer('bedOn', false)); await flush(); run(1); await flush();
quiet(() => J.journeySelect(2)); await flush();
quiet(() => run(P.perform.rampS + 0.5)); await flush();
eq('(b) step 3 drone stays on', g('bedOn'), true);
eq('(b) step 3 trim back to its level', g('musDrone'), 80);
eq('(b) step 3 still holds on', st2.overrides.bedOn, true);
eq('(b) step 2 still holds off', st1.overrides.bedOn, false);
delete st2.overrides.bedOn;

// ---- FIX 2, a step's voices ride its ramp ----
quiet(() => J.journeyDeselect());
const st0 = J.journeyStepAt(0);
for (const s of [st0, st1, st2]) { delete s.overrides.musDrone; }
st0.overrides.bedOn = true; st1.overrides.bedOn = false; st2.overrides.bedOn = true;
J.journeySetRamp(1, 4); J.journeySetRamp(2, 20);
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
quiet(() => J.journeySetWindowOpen(false));
quiet(() => J.journeyPlayFrom(1));
eq('step off: toggle held on at entry', g('bedOn'), true);
run(2);
eq('step off: trim falling mid-ramp', g('musDrone') > 0 && g('musDrone') < 80, true);
eq('step off: toggle still on mid-ramp', g('bedOn'), true);
run(2.5);
eq('step off landed: toggle off', g('bedOn'), false);
eq('step off landed: trim restored', g('musDrone'), 80);
quiet(() => J.journeyStepBy(1));
eq('step on: toggle on at entry', g('bedOn'), true);
eq('step on: trim from nothing', g('musDrone'), 0);
run(10);
eq('step on: trim halfway', g('musDrone') > 20 && g('musDrone') < 70, true);
run(10.5);
eq('step on: trim arrives at its standing level', g('musDrone'), 80);
// a new step entered mid fade-out lands it first
quiet(() => J.journeyPlayFrom(1)); run(1);
eq('early: trim mid-way', g('musDrone') > 0 && g('musDrone') < 80, true);
st0.overrides.bedOn = false; J.journeySetRamp(0, 0);
quiet(() => J.journeyPlayFrom(0));
eq('early landing: toggle off', g('bedOn'), false);
eq('early landing: trim restored', g('musDrone'), 80);
// handed over: next step wants it on
byId('bedOn').set(S, true);
quiet(() => J.journeyPlayFrom(1)); run(2); const mid = g('musDrone');
quiet(() => J.journeyStepBy(1));
eq('handover: toggle stays on', g('bedOn'), true);
eq('handover: trim continues from where it was', g('musDrone'), mid);
run(20.5);
eq('handover: trim back to its level', g('musDrone'), 80);
// a hand on the trim mid fade-out keeps the voice on
quiet(() => J.journeyPlayFrom(1)); run(1);
quiet(() => P.perfSet('musDrone', 50, true)); await flush();
run(4);
eq('taken: voice stays on', g('bedOn'), true);
eq('taken: trim where the hand left it', g('musDrone'), 50);
quiet(() => J.journeyStop());
// live recording, playing walk, window open
byId('bedOn').set(S, true); byId('musDrone').set(S, 80); byId('ambOn').set(S, true); byId('musAmb').set(S, 70);
J.journeySetRamp(2, 0.1); st2.overrides.bedOn = true; st2.overrides.ambOn = true;
quiet(() => J.journeySetWindowOpen(true));
quiet(() => J.journeyPlayFrom(2)); run(0.5);
quiet(() => P.perfLayer('bedOn', false)); quiet(() => P.perfLayer('ambOn', false)); await flush();
eq('live: bedOn recorded off', st2.overrides.bedOn, false);
eq('live: musDrone recorded at its level', st2.overrides.musDrone, 80);
eq('live: ambOn recorded off', st2.overrides.ambOn, false);
eq('live: the mixer power twin is not stored apart (one value per truth)', st2.overrides.ambMixerPower, undefined);
quiet(() => run(P.perform.rampS + 0.5)); await flush();
eq('live: landing leaves the record off', st2.overrides.bedOn, false);
quiet(() => J.journeyStop()); quiet(() => J.journeySetWindowOpen(false));
// twin hold: a step turning ambience off over its ramp keeps both doors on until the landing
byId('ambOn').set(S, true); byId('musAmb').set(S, 70);
st1.overrides.ambOn = false; J.journeySetRamp(1, 4);
quiet(() => J.journeyPlayFrom(1)); run(2);
eq('twin hold: ambience still on mid-ramp', g('ambOn'), true);
run(2.5);
eq('twin hold: ambience off at the landing', g('ambOn'), false);
eq('twin hold: musAmb restored', g('musAmb'), 70);
quiet(() => J.journeyStop());
// a ramped step takes a window fade on a voice it wants on
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
J.journeySetRamp(2, 6); st2.overrides.bedOn = true; delete st2.overrides.musDrone;
quiet(() => P.perfLayer('bedOn', false)); run(2); const m2 = g('musDrone');
quiet(() => J.journeyPlayFrom(2));
eq('take: perfDestination cleared', P.perfDestination('bedOn'), undefined);
eq('take: trim continues from the fade', g('musDrone'), m2);
run(6.5);
eq('take: voice on', g('bedOn'), true);
eq('take: trim back up to its level', g('musDrone'), 80);
quiet(() => J.journeyStop());

// ---- PHASE 2, one door ----
// a journey-started fade is the door's: the music window sees it, and the recorder reads its destination
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
st1.overrides.bedOn = false; delete st1.overrides.musDrone; J.journeySetRamp(1, 4);
quiet(() => J.journeyPlayFrom(1)); run(1);
eq('door: journey fade visible to the music window (perfLayerLevel)', P.perfLayerLevel('bedOn'), 80);
eq('door: journey fade destination', P.perfDestination('bedOn'), false);
// a hand clicking the voice back on mid journey-fade restores its level, not the mid level
quiet(() => P.perfLayer('bedOn', true)); run(P.perform.rampS + 0.5);
eq('door: hand click mid journey-fade keeps voice on', g('bedOn'), true);
eq('door: hand click mid journey-fade glides back to its level', g('musDrone'), 80);
quiet(() => J.journeyStop());
// a hand on the trim (the drawer's own set, no door) mid journey-fade keeps the voice on at the hand's level
quiet(() => J.journeyPlayFrom(1)); run(1);
byId('musDrone').set(S, 35); run(4.5);
eq('door: hand trim mid journey-fade keeps voice on', g('bedOn'), true);
eq('door: hand trim mid journey-fade stays at the hand level', g('musDrone'), 35);
quiet(() => J.journeyStop());
// a step naming the level: the voice rises to the step's level, not the remembered one
byId('bedOn').set(S, false); byId('musDrone').set(S, 80);
st2.overrides.bedOn = true; st2.overrides.musDrone = 40; J.journeySetRamp(2, 6);
quiet(() => J.journeyPlayFrom(2));
eq('door: step-level rise starts from nothing', g('musDrone'), 0);
eq('door: step-level rise destination is the step level', P.perfDestination('musDrone'), 40);
run(3);
eq('door: step-level rise mid-way', g('musDrone') > 0 && g('musDrone') < 40, true);
run(3.5);
eq('door: step-level rise lands at the step level', g('musDrone'), 40);
eq('door: step-level rise voice on', g('bedOn'), true);
quiet(() => J.journeyStop());
// a step naming the level while turning the voice off: the level goes back to the step's at the landing
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
st1.overrides.bedOn = false; st1.overrides.musDrone = 60; J.journeySetRamp(1, 4);
quiet(() => J.journeyPlayFrom(1)); run(2);
eq('door: step-level fade-out toggle on mid-ramp', g('bedOn'), true);
run(2.5);
eq('door: step-level fade-out lands off', g('bedOn'), false);
eq('door: step-level fade-out level put back to the step level', g('musDrone'), 60);
delete st1.overrides.musDrone;
quiet(() => J.journeyStop());
// a next step that leaves the voice alone lets the fade land on its own time
byId('bedOn').set(S, true); byId('musDrone').set(S, 80);
delete st2.overrides.bedOn; delete st2.overrides.musDrone; J.journeySetRamp(2, 1);
quiet(() => J.journeyPlayFrom(1)); run(1);
quiet(() => J.journeyStepBy(1));
eq('door: next step leaving the voice alone, still fading', g('bedOn') === true && P.perfDestination('bedOn') === false, true);
run(3.5);
eq('door: the fade lands on its own time', g('bedOn'), false);
eq('door: the level put back at its own landing', g('musDrone'), 80);
quiet(() => J.journeyStop());
// a preset's ramp holding a voice on until it ends, taken over by a step that wants it on
{
  const PR = await import(root + '/core/presets.js');
  const RC = PR.REPLAY_CONTROLS, out = new Array(RC.length);
  let pi = -1, vid = null;
  for (let i = 0; i < PR.presetCount() && pi < 0; i++) {
    if (!quiet(() => PR.presetTargets(i, out))) continue;
    for (const id of ['aTone', 'aClick', 'pianoOn', 'cloudsOn', 'bedOn', 'arpOn', 'choirOn', 'ambOn']) {
      const j = RC.findIndex(c => c.id === id);
      if (out[j] === false) { pi = i; vid = id; break; }
    }
  }
  if (pi >= 0) {
    const op = byId(vid).op;
    for (const s of [st0, st1, st2]) s.overrides = {};
    st0.overrides[vid] = true; J.journeySetRamp(0, 2);
    byId(vid).set(S, true); byId(op).set(S, 80);
    quiet(() => P.perfRecallPreset(pi, 4)); run(1);
    eq('door: recall holds ' + vid + ' on, headed off', P.perfDestination(vid), false);
    const mid = g(op);
    quiet(() => J.journeyPlayFrom(0));
    eq('door: step takes the recall hold (no destination left)', P.perfDestination(vid), undefined);
    eq('door: step takes the recall hold from where it got to', g(op), mid);
    run(5);
    eq('door: recall landing leaves the voice on', g(vid), true);
    eq('door: the voice back at its level', g(op), 80);
    quiet(() => J.journeyStop());
  } else eq('door: a preset turning a voice off exists', pi >= 0, true);
}

// ---- PHASE 2, section 4: mutes and solos glide, the gate never the fader ----
MG = await import(root + '/js/mixgate.js');
{
  const near = (a, b, d) => Math.abs(a - b) <= d;
  for (const ch of MG.CHANNELS) { S.chanMute[ch] = false; S.chanSolo[ch] = false; }
  for (const l of (S.ambLayers || [])) { l.muted = false; l.solo = false; }
  MG.applyMixGates(0);
  for (const ch of MG.CHANNELS) MG.chanGate(ch);   // the engines read every gate as their graphs are built
  run(0.1);
  const bedVol = g('bedVol');
  // a hand's flip in the mixer: the switch shows it at once, the gate glides over the declick
  byId('mixDroneMute').set(S, true);
  eq('gate: hand mute shows at once (silenced)', MG.chanSilenced('drone'), true);
  eq('gate: hand mute starts at full', MG.chanGate('drone'), 1);
  eq('gate: still gliding (busy)', MG.mixGatesBusy(), true);
  run(MG.GATE_GLIDE_S / 2);
  eq('gate: hand mute half way', near(MG.chanGate('drone'), 0.5, 0.15), true);
  run(MG.GATE_GLIDE_S / 2 + 0.1);
  eq('gate: hand mute lands at nothing', MG.chanGate('drone'), 0);
  eq('gate: glide over (not busy)', MG.mixGatesBusy(), false);
  eq('gate: the fader never moved', g('bedVol'), bedVol);
  byId('mixDroneMute').set(S, false); run(1);
  eq('gate: hand unmute back to full', MG.chanGate('drone'), 1);
  // a journey step muting the drone over its ramp: no midpoint jump, a glide over the whole ramp
  quiet(() => J.journeyStop());
  for (const s of [st0, st1, st2]) s.overrides = {};
  const blk = (mute, solo) => ({ chanMute: Object.fromEntries(MG.CHANNELS.map(c => [c, c === mute])), chanSolo: Object.fromEntries(MG.CHANNELS.map(c => [c, c === solo])), layers: [] });
  st1.mix = blk('drone', null); J.journeySetRamp(1, 4);
  quiet(() => J.journeyPlayFrom(1));
  eq('gate: step mute shows at once (the switch)', g('mixDroneMute'), true);
  eq('gate: step mute starts at full', MG.chanGate('drone'), 1);
  run(1.9);
  const pre = MG.chanGate('drone');
  run(0.2);
  const post = MG.chanGate('drone');
  eq('gate: step mute mid-ramp is mid-way, no midpoint flip', pre > 0.3 && post < 0.7 && pre - post < 0.2, true);
  run(2.1);
  eq('gate: step mute lands at the ramp end', MG.chanGate('drone'), 0);
  eq('gate: step mute fader untouched', g('bedVol'), bedVol);
  // a solo glides everyone else down together, the soloed channel staying
  st2.mix = blk(null, 'piano'); J.journeySetRamp(2, 2);
  quiet(() => J.journeyStepBy(1));
  run(1);
  eq('gate: solo, the drone (unmuted by the step but not soloed) stays silent', MG.chanGate('drone'), 0);
  eq('gate: solo, the soloed piano stays full', MG.chanGate('piano'), 1);
  eq('gate: solo, the clouds mid-glide down', MG.chanGate('clouds') > 0 && MG.chanGate('clouds') < 1, true);
  run(1.2);
  eq('gate: solo, the clouds landed silent', MG.chanGate('clouds'), 0);
  quiet(() => J.journeyStop());
  // a mid-glide reversal picks up from where the gate had got to
  byId('mixPianoSolo').set(S, false); run(0.1);
  const mid = MG.chanGate('clouds');
  byId('mixPianoSolo').set(S, true);
  eq('gate: reversal continues from where it was', near(MG.chanGate('clouds'), mid, 1e-9), true);
  run(1); byId('mixPianoSolo').set(S, false); run(1);
  // worker mode: the length a step asks for travels ahead of the switches, and the page holds it for the batch
  const ask = MG.mixGateAsk();
  MG.applyMixGates(3);
  eq('gate: an asked glide is counted for the link', MG.mixGateAsk(), ask + 1);
  eq('gate: and its length kept', MG.mixGateAskSec(), 3);
  MG.holdMixGateGlide(3);
  byId('mixDroneMute').set(S, true);
  MG.holdMixGateGlide(-1);
  run(1.5);
  eq('gate: page batch glides as long as the worker asked', near(MG.chanGate('drone'), 0.5, 0.1), true);
  run(1.6);
  byId('mixDroneMute').set(S, false); run(1);
}

// the worker link end to end: a step's glide length goes out ahead of the switches it moved
{
  const { createAudioLink } = await import(root + '/core/audio-link.js');
  const sent = [];
  const link = createAudioLink(calls => { for (const x of calls) sent.push(x); });
  link.seed();
  for (const s of [st0, st1, st2]) s.overrides = {};
  st1.mix = { chanMute: Object.fromEntries(MG.CHANNELS.map(c => [c, c === 'arp'])), chanSolo: Object.fromEntries(MG.CHANNELS.map(c => [c, false])), layers: [] };
  J.journeySetRamp(1, 5);
  quiet(() => J.journeyPlayFrom(1));
  link.flush();
  const gi = sent.indexOf('gateGlide'), si = sent.indexOf('mixArpMute');
  eq('link: gateGlide sent', gi >= 0, true);
  eq('link: with the step ramp', sent[gi + 1], 5);
  eq('link: ahead of the mute it carries', si > gi, true);
  sent.length = 0; link.flush();
  eq('link: sent once', sent.indexOf('gateGlide'), -1);
  quiet(() => J.journeyStop());
}

// ---- PHASE 3, commit 1: every step a whole scene, entered as a diff ----
const PR3 = await import(root + '/core/presets.js');
const RC3 = PR3.REPLAY_CONTROLS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
{
  quiet(() => J.journeyStop()); quiet(() => J.journeySetWindowOpen(false)); quiet(() => J.journeyDeselect());
  // scene A into step 1, scene B into step 2, each recorded as it is edited
  quiet(() => J.journeySetWindowOpen(true));
  quiet(() => J.journeySelect(0)); await flush();
  byId('bedOn').set(S, true); byId('musDrone').set(S, 80); byId('color').set(S, '#00ccff'); byId('freq').set(S, 10);
  await flush(); quiet(() => run(0.5)); await flush();
  quiet(() => J.journeySelect(1)); await flush();
  byId('bedOn').set(S, false); byId('musDrone').set(S, 50); byId('color').set(S, '#ffb13b'); byId('freq').set(S, 14);
  await flush(); quiet(() => run(0.5)); await flush();
  quiet(() => J.journeyDeselect()); quiet(() => J.journeySetWindowOpen(false));
  const n0 = Object.keys(st0.overrides).length, n1 = Object.keys(st1.overrides).length;
  eq('full: a step holds every control (hundreds, the same set in each)', n0 > 300 && n0 === n1, true);
  console.log('     one step\'s controls as stored: ' + n0 + ' controls, ' + JSON.stringify(st0.overrides).length + ' bytes of JSON');
  eq('full: twins held once (bedVol, never mixDrone)', st0.overrides.bedVol !== undefined && st0.overrides.mixDrone === undefined, true);
  J.journeySetRamp(0, 2); J.journeySetRamp(1, 2);
  quiet(() => J.journeyPlayFrom(0)); run(2.5);
  eq('full: step 1 landed (freq)', g('freq'), 10);
  eq('full: step 1 landed (voice on at its level)', g('bedOn') === true && g('musDrone') === 80, true);
  // entering the step one is already in sends nothing at all
  let sets = 0; const was = [];
  for (const c of RC3) { const f = c.set; was.push(f); if (f) c.set = (...a) => { sets++; return f(...a); }; }
  const unwrap = () => { RC3.forEach((c, k) => { c.set = was[k]; }); };
  quiet(() => J.journeyPlayFrom(0)); run(2.5);
  eq('no-op: re-entering the step one is in over its ramp sets nothing', sets, 0);
  J.journeySetRamp(0, 0); sets = 0;
  quiet(() => J.journeyPlayFrom(0)); run(0.2);
  eq('no-op: re-entering it as a cut sets nothing', sets, 0);
  quiet(() => J.journeyStop());
  quiet(() => J.journeySetWindowOpen(true)); sets = 0;
  quiet(() => J.journeySelect(0)); await flush(); run(0.2); await flush();
  eq('no-op: selecting it to edit sets nothing', sets, 0);
  quiet(() => J.journeyDeselect()); quiet(() => J.journeySetWindowOpen(false));
  unwrap();
  J.journeySetRamp(0, 2);
  // what differs does move
  quiet(() => J.journeyPlayFrom(1)); run(2.5);
  eq('diff: the next step moves what differs (freq)', g('freq'), 14);
  eq('diff: the next step moves what differs (voice off, level kept)', g('bedOn') === false && g('musDrone') === 50, true);
  eq('diff: the next step moves what differs (colour)', g('color'), '#ffb13b');
  quiet(() => J.journeyStop());
  // a hand mid-walk keeps its control for the rest of the walk (window shut)
  quiet(() => J.journeyPlayFrom(0)); run(2.5);
  quiet(() => P.perfSet('freq', 12, true)); await flush();
  quiet(() => J.journeyStepBy(1)); run(2.5);
  eq('hand: a control moved mid-walk survives the next step (its snapshot says 14)', g('freq'), 12);
  eq('hand: the rest of the next step still lands', g('bedOn'), false);
  quiet(() => J.journeyStepBy(-1)); run(2.5);
  eq('hand: and the step after that (snapshot says 10)', g('freq'), 12);
  quiet(() => J.journeyStop());
  quiet(() => J.journeyPlayFrom(1)); run(2.5);
  eq('hand: a new walk gives the control back to the steps', g('freq'), 14);
  quiet(() => J.journeyStop());
}

// ---- PHASE 3, commit 1: a ver 1 (diff) record is read forward, losslessly ----
{
  const { initStore } = await import(root + '/core/store.js');
  initStore({ get: k => store.get(k) ?? null, set: (k, v) => store.set(k, String(v)), remove: k => store.delete(k) });
  byId('color').set(S, '#ff5a5a'); byId('bedVol').set(S, 20); byId('freq').set(S, 9);
  const F = g('freq');
  quiet(() => J.journeyNew('Migrated')); await sleep(120);
  const key = 'signal.journey.v1.j2';
  const v1 = { ver: 1, mode: 'off', ringV: 2, partV: 2, steps: [
    { overrides: { bedOn: true, musDrone: 40 }, rampS: 2, holdS: 10 },
    { overrides: { musDrone: 60, bedVol: 30, mixDrone: 55 }, rampS: 2, holdS: 10 },
    { overrides: { bedOn: false, color: '#00ccff' }, rampS: 2, holdS: 10 } ] };
  store.set(key, JSON.stringify(v1));
  J.syncJourneyFromStorage(key);
  const m = [0, 1, 2].map(i => J.journeyStepAt(i).overrides);
  eq('v1: three steps read', J.journeyCount(), 3);
  eq('v1: every step whole, the same set of controls', Object.keys(m[0]).length > 300 && Object.keys(m[0]).length === Object.keys(m[2]).length, true);
  eq('v1: step 1 keeps what it named', m[0].bedOn === true && m[0].musDrone === 40, true);
  eq('v1: step 1 takes the scene for what it never named', m[0].freq === F && m[0].color === '#ff5a5a' && m[0].bedVol === 20, true);
  eq('v1: step 2 = step 1 with its own changes', m[1].bedOn === true && m[1].musDrone === 60 && m[1].color === '#ff5a5a', true);
  eq('v1: step 2 twins land on the canonical, the later door winning as it did on entry', m[1].bedVol === 55 && m[1].mixDrone === undefined, true);
  eq('v1: step 3 = step 2 with its own changes', m[2].bedOn === false && m[2].musDrone === 60 && m[2].bedVol === 55 && m[2].color === '#00ccff' && m[2].freq === F, true);
  let fold = true;
  for (const id in m[0]) {
    if (id === 'bedVol') continue;
    const want = v1.steps[2].overrides[id] ?? v1.steps[1].overrides[id] ?? m[0][id];
    if (m[2][id] !== want) { fold = false; console.log('     fold mismatch ' + id, m[2][id], want); }
  }
  eq('v1: step 3 is exactly step 1 folded through steps 2 and 3', fold, true);
  eq('v1: a step with no sequencer or mix keeps none', J.journeyStepAt(1).seq === null && J.journeyStepAt(1).mix === null, true);
  await sleep(120);
  const back = JSON.parse(store.get(key));
  eq('v1: written back at once as ver 2', back.ver, 2);
  const canon = a => JSON.stringify(a.map(o => Object.keys(o).sort().map(k => [k, o[k]])));
  const before = canon(m);
  byId('freq').set(S, 13);   // the scene moving after the migration changes nothing in it
  J.syncJourneyFromStorage(key);
  eq('v1: the ver 2 record reads back the same scenes', canon([0, 1, 2].map(i => J.journeyStepAt(i).overrides)), before);
}

// ---- PHASE 3, commit 2: command-click locks (interaction and record only; what a lock does is undecided) ----
const { createUI } = await import(root + '/ui/imgui.js');
const textStub = new Proxy({ measure: str => String(str).length * 6, lineMetrics: (size, lm) => { lm.ascent = 9; lm.descent = 3; } }, { get: (t, k) => k in t ? t[k] : () => {} });
const dlStub = new Proxy({ _clip: new Float32Array([0, 0, 800, 600]), _clipDepth: 1, culled: () => false }, { get: (t, k) => k in t ? t[k] : () => {} });
const UI = createUI(textStub);
let ut = 0;
const frame = (events, fn) => { ut += 16; UI.begin(events, ut, 16, 800, 600, dlStub); UI.setCursor(0, 0, 300); fn(); UI.end(); };
const ptr = (type, x, y, mods = {}) => ({ type, x, y, pointerId: 1, pointerType: 'mouse', button: 0, shift: !!mods.shift, meta: !!mods.meta, ctrl: !!mods.ctrl, alt: false });
const click = (ctl, x, y, mods) => { frame([ptr('down', x, y, mods)], () => UI.control(ctl, S, true)); frame([ptr('up', x, y, mods)], () => UI.control(ctl, S, true)); };
{
  const LOCK_KEY = 'signal.journeyLocks.v1';
  eq('lock: a step control is lockable', J.journeyLockable('freq'), true);
  eq('lock: the operator\'s own (Master volume) is not', J.journeyLockable('vol'), false);
  J.journeyToggleLock('mixDrone');
  eq('lock: twins lock together (mixDrone locks bedVol)', J.journeyLocked('bedVol') && J.journeyLocked('mixDrone'), true);
  J.journeyToggleLock('bedVol');
  eq('lock: and unlock together', J.journeyLocked('bedVol') || J.journeyLocked('mixDrone'), false);
  // the drawer row: command-click toggles the lock and writes nothing
  const fq = byId('freq');
  quiet(() => P.perfSet('freq', 10, true)); run(0.1);
  frame([], () => UI.control(fq, S, true));
  click(fq, 150, 22, { meta: true });
  eq('lock: command-click on the row locks it', J.journeyLocked('freq'), true);
  eq('lock: command-click writes nothing', g('freq'), 10);
  click(fq, 2, 3, { meta: true });   // on the label: no reset to default
  eq('lock: command-click on the name toggles, never resets', J.journeyLocked('freq') === false && g('freq') === 10, true);
  click(fq, 150, 22, { ctrl: true });
  eq('lock: control-click does NOT lock (the Mac context-menu click stays the browser\'s)', J.journeyLocked('freq'), false);
  click(fq, 150, 22, { meta: true });
  eq('lock: command-click locks again', J.journeyLocked('freq'), true);
  await sleep(120);
  eq('lock: written under its own key', JSON.parse(store.get(LOCK_KEY)).includes('freq'), true);
  J.syncJourneyFromStorage(LOCK_KEY);
  eq('lock: survives a reload (the key read again)', J.journeyLocked('freq'), true);
  // the floating model: a locked control is neither taken into a step nor moved by one
  byId('freq').set(S, 11); run(0.1);
  const held0 = J.journeyStepAt(0).overrides.freq;
  const before = J.journeyCount(), lastF = J.journeyStepAt(before - 1).overrides.freq;
  quiet(() => J.journeyAddStep()); quiet(() => J.journeyDeselect());
  eq('lock: a new step does not take it (it carries on the step before)', J.journeyStepAt(before).overrides.freq === lastF && lastF !== 11, true);
  J.journeySetRamp(0, 0);
  byId('freq').set(S, 13); run(0.1);
  quiet(() => J.journeyPlayFrom(0)); run(0.2);
  eq('lock: a step entering does not move it', g('freq'), 13);
  quiet(() => J.journeyStop());
  quiet(() => J.journeySetWindowOpen(true)); quiet(() => J.journeySelect(0)); await flush();
  byId('freq').set(S, 15); await flush(); run(0.1); await flush();
  eq('lock: not recorded while its step is edited', J.journeyStepAt(0).overrides.freq, held0);
  quiet(() => J.journeyDeselect()); quiet(() => J.journeySetWindowOpen(false));
  J.journeyToggleLock('freq');
  eq('lock: unlocking rewrites no step', J.journeyStepAt(0).overrides.freq, held0);
  eq('lock: and moves nothing at once', g('freq'), 15);
  quiet(() => J.journeyPlayFrom(0)); run(0.2);
  eq('lock: unlocked, the next step entered moves it again', g('freq'), held0);
  quiet(() => J.journeyStop());
  // a lock taken mid-ramp lets the control go where it stands
  J.journeySetRamp(1, 4);
  J.journeyStepAt(1).overrides.freq = held0 + 6;
  quiet(() => J.journeyPlayFrom(1)); run(2);
  const midF = g('freq');
  J.journeyToggleLock('freq');
  run(2.5);
  eq('lock: mid-ramp lock releases it where it stood', g('freq') === midF && midF !== held0 + 6, true);
  quiet(() => J.journeyStop());
  // set all: the pill shows only while locked and some step differs
  const nSteps = J.journeyCount();
  byId('freq').set(S, 17); run(0.1);
  eq('set all: the pill shows (locked, steps differ)', J.journeyLockVaries('freq'), true);
  quiet(() => J.journeySetAll('freq')); await sleep(120);
  let all = true;
  for (let n = 0; n < nSteps; n++) if (J.journeyStepAt(n).overrides.freq !== 17) all = false;
  eq('set all: every step of the open journey holds the live value', all, true);
  eq('set all: persisted', JSON.parse(store.get('signal.journey.v1.j2')).steps.every(st => st.overrides.freq === 17), true);
  eq('set all: the lock is dropped', J.journeyLocked('freq'), false);
  eq('set all: no pill once unlocked', J.journeyLockVaries('freq'), false);
  J.journeyToggleLock('freq');
  eq('set all: no pill while every step matches', J.journeyLockVaries('freq'), false);
  byId('freq').set(S, 18); run(0.1);
  eq('set all: the pill comes back when the hand moves it off', J.journeyLockVaries('freq'), true);
  byId('freq').set(S, 17); run(0.1);
  J.journeyStepAt(nSteps - 1).overrides.freq = 16;
  J.journeySetText(0, 'bump');   // a version move: the step data is read again
  eq('set all: crafted variance in one step shows the pill', J.journeyLockVaries('freq'), true);
  // the pill on the drawer row: a click sets all and unlocks, writing no value of its own
  frame([], () => UI.control(fq, S, true));
  click(fq, 'Frequency'.length * 6 + 5 + 9 + 5 + 4, 6);   // the stub's name width, the gap, the lock, the gap, into the pill
  eq('set all: the row pill sets every step and unlocks', J.journeyLocked('freq') === false && J.journeyStepAt(nSteps - 1).overrides.freq === 17 && g('freq') === 17, true);
}

// ---- PHASE 3, commit 3: the drawer's rows write through the performer's doors ----
{
  const fq = byId('freq');
  quiet(() => P.perfSet('freq', 10, true)); run(0.1);
  frame([], () => UI.control(fq, S, true));
  click(fq, 150, 22);
  const asked = P.perfDestination('freq');
  eq('drawer: a click on the track asks a glide (destination set)', typeof asked === 'number' && asked !== 10, true);
  eq('drawer: the value has not jumped there', g('freq') !== asked, true);
  run(P.perform.rampS / 2);
  eq('drawer: half way it is on its way', g('freq') !== 10 && g('freq') !== asked, true);
  run(P.perform.rampS / 2 + 0.5);
  eq('drawer: and lands where it was asked', g('freq'), asked);
  click(fq, 60, 22, { shift: true });
  eq('drawer: a shift-click lands now', P.perfDestination('freq') === undefined && g('freq') !== asked, true);
  const now = g('freq');
  click(fq, 250, 22, { meta: true });
  eq('drawer: a command-click starts no glide and writes nothing', P.perfDestination('freq') === undefined && g('freq') === now, true);
  J.journeyToggleLock('freq');
  // a drag re-aims the glide at every move, the glide travelling as it goes
  frame([ptr('down', 100, 22)], () => UI.control(fq, S, true));
  const d100 = P.perfDestination('freq');
  eq('drawer: the press asks a glide at the press point', typeof d100 === 'number', true);
  frame([ptr('move', 200, 22)], () => UI.control(fq, S, true));
  const d200 = P.perfDestination('freq');
  eq('drawer: the drag re-aims the glide at once, mid-press', typeof d200 === 'number' && d200 > d100, true);
  const before = g('freq');
  run(0.4);
  frame([ptr('move', 200, 22)], () => UI.control(fq, S, true));
  eq('drawer: the glide travels while the hand is still down', g('freq') !== before, true);
  frame([ptr('up', 200, 22)], () => UI.control(fq, S, true));
  run(P.perform.rampS + 0.5);
  const v200 = g('freq');
  eq('drawer: and lands where the hand let go', v200, d200);
  run(P.perform.rampS + 0.5);
  click(fq, 120, 22, { shift: true });
  const vShift = g('freq');
  eq('drawer: and a shift-click still lands now', vShift < v200 && P.perfDestination('freq') === undefined, true);
  // a switch with a level of its own fades through it, as the Music window's rows do
  const le = byId('lEdge');
  byId('lEdge').set(S, true); byId('edgeOpacity').set(S, 100); run(0.1);
  frame([], () => UI.control(le, S, true));
  click(le, 150, 15);
  eq('drawer: a layer switch fades out (still on, headed off)', g('lEdge') === true && P.perfDestination('lEdge') === false, true);
  run(P.perform.rampS + 0.5);
  eq('drawer: the layer lands off, its level put back', g('lEdge') === false && g('edgeOpacity') === 100, true);
  click(le, 150, 15, { shift: true });
  eq('drawer: shift-click turns it back on now', g('lEdge') === true && P.perfDestination('lEdge') === undefined, true);
  // a control that is not the schema's own is written straight, as before
  let fakeV = 2;
  const fake = { id: 'simFake', label: 'Fake', kind: 'slider', min: 0, max: 10, step: 1, def: 0, get: () => fakeV, set: (s, v) => { fakeV = v; } };
  frame([], () => UI.control(fake, S, true));
  click(fake, 150, 22);
  eq('drawer: a control the doors cannot take is written straight', fakeV, 5);
  click(fake, 2, 3);
  eq('drawer: and its name still resets it straight', fakeV, 0);
}
console.log(fails ? fails + ' FAILED' : 'all passed');
