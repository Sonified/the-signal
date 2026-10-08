// The demo broadcast's logic half: named session links, managed from the
// drawer's Broadcast section. Each session is a room on the relay
// (broadcast-worker/ at the repo root); while a session is active this tab
// holds a socket to its room and sends the whole current state (the same
// snapshot() a preset or a saved session is) whenever the settings change,
// plus once on every (re)connect, which both seeds the room for followers who
// arrive before the first change and re-seeds it after a reconnect. Whole
// snapshots rather than diffs, so a message lost to a reconnect costs
// nothing: the next one carries everything again.
//
// main.js hands in the platform bits (the socket opener, the link builder,
// what the URL asked for) and the hooks (the overlay notice, the transport,
// the clipboard), so this module never touches the URL or the socket API and
// stays inside the core boundary.
//
// The broadcaster's side listens on store.onSave, which fires on every change
// this tab makes and never on one arriving from elsewhere. onSave must stay
// cheap (a slider drag calls it per input event), so it only arms a timer;
// the send happens when it fires. A glide's own frames (the performer's, a
// Journey ramp's) are the exception: the message sent as a glide starts
// names it, followers run it themselves, and one send as it lands trues
// them up (see `tw` at sendNow). The relay tells each broadcast socket how
// many followers its room holds ({t:'count',n}, on join and on every arrival
// or departure), which is the watcher count beside each session in the
// drawer.
//
// A follower (?follow=<room>) applies each arriving snapshot exactly as a
// preset recall does: replayLive(() => applySnapshot(snap)), so the audio
// graph and the scene glide to the broadcaster's settings instead of
// jumping, and the follower's own save() then persists what it is watching.
// The running flag rides alongside the snapshot (it is not a setting, so
// snapshot() does not carry it): the follower's strobe starts and stops with
// the broadcaster's. Sound still needs the follower's own first gesture, as
// it always does; the usual Space to start covers both.
//
// Each session is Open (the default) or an Event, and the state message
// says which (see "Open and Event" below). Open leaves a follower free to
// start and stop on its own, the broadcaster's run flag landing only when it
// actually changes. An Event holds every follower to the broadcaster's run
// until an unlock moment on the shared room clock, or for as long as it
// lasts when no moment is set; past that moment it is Open.
//
// A follower's viewer can take the strobe for their own by moving any of its
// controls (see "the follower's own strobe" below): from then on the strobe
// keeps their settings and its own time while everything else still follows,
// until the chrome's sync chip hands it back.
//
// The broadcaster's live sound rides the same sockets (core/live-audio.js):
// this module tells it whenever a watcher count or a socket's status moves,
// and its pieces count as activity for the doze below. On a follower, the
// relay's live notices and binary frames are handed straight to it.
//
// Sessions and the broadcast key persist under their own record
// (signal.broadcast.v1, through store.readKey/saveKey like the presets), so
// the drawer's list survives a reload, and a session left active reconnects
// at boot: a demo survives the broadcaster's page refresh.
import { S } from '../js/state.js';
import { onSave, wireSettings, readKey, saveKey } from './store.js';
import { replayHolding, presetTransitionCount, lastTransitionSec, machineControl, recallStreamScene } from './presets.js';
import { setPerfGlideHooks, perfGlideWriting, perfEachGlide, perfFollowGlide, perfFollowDrop } from './perform.js';
import { setJourneyGlideHooks, journeyGlideWriting, journeyEachGlide } from './journey.js';
import { CONTROLS, byId } from './schema.js';
import { setStrobeClockOffset, setStrobeSyncTarget, clearStrobeSync } from './strobe.js';
import { onWordAppear, wordState, remoteWord, setWordsRemote,
         setWordWalk, setWordWalkClock, wordWalkRunning, wordsRepeating } from './words.js';
import { setRoomClockRoom, setRoomClockOffset } from './room-clock.js';
import { initLiveAudio, liveAudioCheck, liveFollowNotice, liveFollowChunk, liveFollowEnd } from './live-audio.js';

const REC_KEY = 'signal.broadcast.v1';
// Each session's left-off scene (see "where a stream was left" below), by
// room, under a record of its own so the sessions' record stays small.
const SCENES_KEY = 'signal.broadcast.scenes.v1';
const SEND_DELAY_MS = 250;
// how long without a state send before a live session dozes, and how often
// that is checked (see the doze section below)
const IDLE_DOZE_MS = 10 * 60 * 1000;
const DOZE_CHECK_MS = 30000;
const NAME_MAX = 32;
const ROOM_MAX = 24;

// The drawer reads these accessors every frame, so the list is plain arrays
// and cached strings: nothing here allocates outside a click or a relay
// message. `version` moves whenever anything the drawer shows changes (the
// list, a status, a watcher count), so it knows when to remeasure.
// A session also carries its mode (event: false is Open), its unlock moment
// (unlock, wall-clock ms, 0 for none) with that countdown's cached label and
// the whole second it was built for (unLabel, unSec), and stale: a change
// was skipped for this room while nobody watched it (see dozing). sent is
// the last state message this room was actually sent, and scene the scene
// it was left on when last ended (see "where a stream was left").
let sessions = [];   // { name, room, active, sock, status:'off'|'wait'|'live'|'doze'|'dead', watchers, label, event, unlock, unLabel, unSec, stale, sent, scene }
let key = '';
let linkTarget = 'live';
let version = 0;
let available = false;
let bits = null, hooks = null;
let sendTimer = null;
let loaded = false;

const noop = () => {};

// ---------- persistence ----------

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  let raw = null;
  try { raw = JSON.parse(readKey(REC_KEY) || 'null'); } catch (e) { raw = null; }
  if (!raw || typeof raw !== 'object') return;
  if (typeof raw.key === 'string') key = raw.key;
  if (raw.linkTarget === 'local' || raw.linkTarget === 'live') linkTarget = raw.linkTarget;
  if (Array.isArray(raw.sessions)) {
    for (const s of raw.sessions) {
      if (!s || typeof s.name !== 'string' || typeof s.room !== 'string') continue;
      if (!/^[\w-]{1,64}$/.test(s.room)) continue;
      const one = makeSession(s.name.slice(0, NAME_MAX), s.room, !!s.active);
      // a record from before the modes has neither, and is Open
      one.event = s.mode === 'event';
      one.unlock = Number.isFinite(s.unlock) && s.unlock > 0 ? s.unlock : 0;
      sessions.push(one);
    }
  }
  let scenes = null;
  try { scenes = JSON.parse(readKey(SCENES_KEY) || 'null'); } catch (e) { scenes = null; }
  if (!scenes || typeof scenes !== 'object') return;
  for (const s of sessions) {
    const sc = scenes[s.room];
    if (sc && sc.snap && typeof sc.snap === 'object' && Number.isFinite(sc.at)) s.scene = { snap: sc.snap, at: sc.at };
  }
}

// Written only when a scene is kept or its session deleted, never with the
// sessions' own record, so a click on a switch does not rewrite tens of KB.
function persistScenes() {
  const out = {};
  for (const s of sessions) if (s.scene) out[s.room] = s.scene;
  saveKey(SCENES_KEY, out);
}

function persist() {
  version++;
  syncWalkRoom();
  const out = { key, linkTarget, sessions: [] };
  for (const s of sessions) {
    out.sessions.push({ name: s.name, room: s.room, active: s.active,
                        mode: s.event ? 'event' : 'open', unlock: s.unlock });
  }
  saveKey(REC_KEY, out);
}

function makeSession(name, room, active) {
  return { name, room, active, sock: null, status: 'off', watchers: 0, label: '',
           event: false, unlock: 0, unLabel: '', unSec: -1, stale: false, sent: null, scene: null };
}

// The room a viewer's link names, made from the session's name: readable, so
// the link a viewer receives says what it is ("lab-demo", never a hash).
// Unique among this list's rooms by counting up, same as the presets do.
function slugFor(name) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ROOM_MAX);
  base = base.replace(/^-+|-+$/g, '') || 'session';
  const taken = r => sessions.some(s => s.room === r);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(base + '-' + n)) return base + '-' + n;
}

// ---------- broadcasting ----------

function liveCount() {
  let n = 0;
  for (const s of sessions) if (s.sock && s.status === 'live') n++;
  return n;
}

// A state message carries its own timing: `at`, the shared-clock moment it
// was sent, and `glide`, the window of the transition it carries when a
// recall (a preset, a journey step's landing) happened since the last send.
// The follower spends what the network left of that window (see the follow
// branch in initBroadcast), so a preset recalled here and there completes at
// the same shared-clock moment on every screen: paths converge on a shared
// deadline, which is what synchrony reads as. A message with no fresh
// transition says glide 0, and the follower takes it on a short window, so a
// streamed drag or a journey ramp (both a run of such messages) follows
// closely instead of trailing a whole preset glide behind.
//
// `wk` says whether this tab's word scheduler is the ordinary repeating one
// (words.js wordsRepeating), the only one the shared walk stands in for. A
// follower walks only while it is 1, so a Journey's one-shot sequence here,
// and the silence after it, stay the broadcaster's alone: its phrases reach
// followers as relayed words, and nothing is dealt in between. The relay
// stores the whole state message, so a follower arriving late reads it too.
//
// `ev` is the session's mode (1 an Event, 0 Open), so the one message differs
// room to room by that tail alone: the body is built once and each session
// closes it with its own. An Event with an unlock moment adds `un`, that
// moment on the shared clock. The session keeps it as wall-clock ms, since
// it has to survive a reload and the page's own clock starts again at every
// load; at send it is carried onto this tab's timeline (how far off it is by
// Date.now, from hooks.now) and then onto the shared one by clockOff, the
// same step that stamps `at`. Followers compare their own shared now against
// it, so the unlock itself needs no message: every screen frees at the same
// instant even while the room sleeps. Until this tab's clock has settled
// there is no shared moment to give, so the Event goes out without one and
// the send is made again the moment the clock settles (takeTime).
//
// `tw` is the glides in flight: a slider or the colour on its way from where
// the snapshot has it to somewhere else, over seconds, by the performer's
// engine (core/perform.js) or a Journey step's ramp (core/journey.js). Each
// is { id, to, rem }: the control, where it is going (a slider's position,
// the colour's '#rrggbb') and the seconds left, to a tenth. A follower lands
// the snapshot as ever and then sets each glide going in its own engine
// (takeGlides), so it moves as smoothly as this screen does rather than in a
// step every quarter second. So the glides' own per-frame writes are not
// sent (localSave holds them, sendOnLand remembers they were made) and a
// glide sends twice: once as it starts, which is the message naming it, and
// once as its engine runs dry, which carries where everything ended up and
// no `tw`. Every send while a glide is in flight names it again, so a
// follower arriving mid-glide (the open's send, the count's), or a change of
// the performer's own mid-glide, picks it up where it has got to. The field
// is left out when nothing is gliding. A follower from before it ignores it
// and just sees each glide land; one following a broadcaster from before it
// never sees one and follows the stream as it always did.
//
// The list is filled into objects kept from send to send (twPool), so a send
// makes nothing but its string. A machine's own control (presets.js
// machineControl) is never named, as its field never rides the snapshot
// (store.js wireSettings).
const twPool = [], twList = [];
let sendOnLand = false;
function addGlide(c, to, rem) {
  if (machineControl(c)) return;
  const n = twList.length;
  let g = twPool[n];
  if (!g) g = twPool[n] = { id: '', to: 0, rem: 0 };
  g.id = c.id; g.to = to; g.rem = Math.round(rem * 10) / 10;
  twList.push(g);
}
function fillGlides() {
  twList.length = 0;
  perfEachGlide(addGlide);
  journeyEachGlide(addGlide);
  return twList.length ? twList : undefined;
}

// store.onSave's listener on the broadcaster. A save a glide's own frame
// made (either engine marks those while they run) is held, and its landing
// sends it; anything else, the performer's own hand on another control
// mid-glide included, sends as it always did. So the gate asks who wrote,
// not whether anything is gliding.
function localSave() {
  if (perfGlideWriting() || journeyGlideWriting()) { sendOnLand = true; return; }
  queueSend();
}

// An engine running dry. Held writes are owed a send; with none, nothing
// changed that a message has not already carried. sendOnLand is only a
// debt: any state send pays it (sendNow), so it can never linger.
function glideLanded() {
  if (!sendOnLand) return;
  sendOnLand = false;
  queueSend();
}

let lastTransSeq = -1;
let sentRepeating = true;
function sendNow() {
  sendTimer = null;
  sendOnLand = false;
  if (!liveCount()) return;
  let glide = 0;
  const seq = presetTransitionCount();
  if (seq !== lastTransSeq) {
    if (lastTransSeq >= 0) glide = lastTransitionSec();
    lastTransSeq = seq;
  }
  const body = stateBody(glide);
  let sent = 0;
  for (const s of sessions) {
    if (!s.sock || s.status !== 'live') continue;
    if (!s.watchers) { s.stale = true; continue; }
    s.sock.send(stateFor(s, body));
    s.sent = body;
    s.stale = false;
    sent++;
  }
  if (sent) lastActivityMs = Date.now();
}

// The state message without its closing brace, for stateFor to finish. The
// settings go in uncopied (store.js wireSettings): they are stringified here
// and nothing keeps the object.
function stateBody(glide) {
  sentRepeating = wordsRepeating();
  const msg = JSON.stringify({
    t: 'state', run: !!hooks.isRunning(), snap: wireSettings(),
    at: isNaN(clockOff) ? undefined : hooks.now() + clockOff, glide,
    wk: sentRepeating ? 1 : 0, tw: fillGlides()
  });
  return msg.slice(0, -1);
}

function stateFor(s, body) {
  if (!s.event) return body + ',"ev":0}';
  if (!s.unlock || isNaN(clockOff)) return body + ',"ev":1}';
  return body + ',"ev":1,"un":' + Math.round(s.unlock - Date.now() + hooks.now() + clockOff) + '}';
}

// Every send this tab starts comes through here (store.onSave, and
// broadcastPoke for run/stop), so it is also where a dozing session wakes.
// A woken session is not live yet, so it does not arm the timer; it needs
// none, because its own open sends the whole current state (onStatus 'open'
// in openSession), and a watched room gets it again the moment the relay's
// count lands. A session already live alongside it is sent to as usual.
function queueSend() {
  wakeDozing();
  if (!sendTimer && liveCount()) sendTimer = setTimeout(sendNow, SEND_DELAY_MS);
}

// Nudges the broadcaster to send, for a change save() never sees (the
// run/stop toggle). A no-op unless a session is live.
export function broadcastPoke() { if (available) queueSend(); }

// ---------- dozing ----------
// The relay's room bills by the time it is awake, and every message wakes
// it, the slow clock probe included. Followers belong to the room, not to
// this tab: each holds its own socket there, so the broadcaster's socket
// closing is something no follower can see. A quiet broadcaster can
// therefore hang up without anyone noticing, and the room goes back to
// sleep. It keeps the last snapshot it stored, so a follower already
// watching stays on what it last received and one arriving late is handed
// that snapshot, which is still current because nothing has changed.
//
// Ten minutes without a state send or a piece of live sound (every piece
// core/live-audio.js sends counts) hangs up every live session. The session
// stays active (still on in the drawer, still saved as active); it is simply
// not connected, and its status reads 'doze'. No {t:'end'} goes out, since
// that would clear the room's snapshot, which is exactly what should
// survive. The next touch (any save, or run/stop) passes through queueSend,
// which reconnects the dozing sessions, and the reconnect's own open sends
// the fresh state, all in under a second. Beacons, words and probes do not
// count as activity: they need a live socket, so they fall silent on their
// own while a session dozes, and the watcher count is unknown until the
// reconnect's count message refreshes it. The words themselves carry on
// regardless: every screen in the room deals them from the shared walk
// (core/words.js), which needs no socket at all once the clock has settled.
//
// The walk is seeded by a room name. This tab's own display walks its first
// active session's room, whatever that session's status: live, wait and doze
// all count, since dozing is exactly when the walk must keep going. Several
// active sessions cannot each have their walk on one screen, so the first
// one wins here (see words.js stepWords).
//
// The layers' slow swings (core/room-clock.js) take their phase off the
// same room clock whenever any session is active, dozing included. They
// need no seed, only the clock, so every active room's screens swing
// together, this one's among them.
let lastActivityMs = 0;
let dozeTimer = null;

function syncWalkRoom() {
  if (followSock) return;   // a follower's room is set by its own messages
  let room = '';
  for (const s of sessions) if (s.active) { room = s.room; break; }
  setWordWalk(room);
  setRoomClockRoom(room !== '');
}

// A room nobody is watching is sent nothing (see the beacons below), so a
// change made then never reaches its stored snapshot: the first watcher to
// arrive while this tab is connected is handed the fresh state by the count
// message, but one arriving after the room has dozed would read the stale
// copy, an Event set in an empty room among what it missed. So a session
// that skipped a change (stale) sends the state once, just before it hangs
// up: one message per doze, and the room sleeps on what is current.
function checkDoze() {
  // a send already armed is activity about to happen; let it land first
  if (sendTimer || Date.now() - lastActivityMs <= IDLE_DOZE_MS) return;
  let body = null, dozed = false;
  for (const s of sessions) {
    if (s.status !== 'live' || !s.sock) continue;
    if (s.stale) {
      if (body === null) body = stateBody(0);
      s.sock.send(stateFor(s, body));
      s.sent = body;
      s.stale = false;
    }
    s.sock.close();
    s.sock = null;
    s.status = 'doze';
    setLabel(s);
    dozed = true;
  }
  if (dozed) liveAudioCheck();
}

function wakeDozing() {
  for (const s of sessions) if (s.status === 'doze' && s.active) openSession(s);
}

// Ending a session that is dozing still owes the room its {t:'end'}, so a
// viewer opening the link later gets nothing rather than a stale scene. A
// socket is opened just to say it, and closed once it has (or once the relay
// proves unreachable, in which case there is no one to tell).
function endDozing(s) {
  const sock = bits.open(s.room, 'broadcast', key, {
    onMessage: noop,
    onStatus: st => {
      if (st === 'open') { sock.send('{"t":"end"}'); sock.close(); }
      else if (st === 'dead') sock.close();
    }
  });
}

// ---------- the shared clock and the phase beacons ----------
// Every screen in a room can agree on one clock: the room's own (the Durable
// Object answers a time probe with its Date.now()). A probe carries this
// tab's send time; halving the round trip places the room's answer on this
// tab's own timeline, and the sample with the shortest round trip is the
// truest, so it is the one kept. The kept round trip is inflated a little on
// every later probe, so a luckier sample eventually replaces it and a slow
// clock drift cannot hide behind one early fluke. The offset goes straight
// to the strobe (setStrobeClockOffset), where it means: shared ms = this
// tab's rAF ms + offset.
//
// While broadcasting and running, a beacon goes out every BEACON_MS with the
// strobe's phase, its frequency and the six variability phases, stamped with
// shared time; followers hand it to the strobe, which slews onto it
// (core/strobe.js's applySync). Followers never send beacons and the
// broadcaster never follows any: the broadcaster is the reference.
//
// Beacons and state go only to sessions someone is actually watching. An
// empty room then hears nothing but the slow probe and the socket ping, so
// the relay's Durable Object hibernates between messages instead of being
// held awake all night by a broadcast nobody is following. The first watcher
// arriving flips the count, and the count handler sends them the state at
// once; the next beacon tick follows within BEACON_MS.
const PROBE_BURST = 5, PROBE_BURST_GAP_MS = 300, PROBE_EVERY_MS = 10000;
const BEACON_MS = 2000;
// The follower's smallest window for an arriving state: enough to smooth a
// streamed message in without a click, short enough to track a drag closely.
const FOLLOW_MIN_GLIDE_S = 0.25;
const RTT_DECAY = 1.05;
let clockOff = NaN, clockRtt = Infinity;
let followSock = null;
let probeTimer = null, beaconTimer = null;

function probeTarget() {
  if (followSock) return followSock;
  for (const s of sessions) if (s.sock && s.status === 'live') return s.sock;
  return null;
}

function sendProbe() {
  const sock = probeTarget();
  if (!sock) return;
  clockRtt *= RTT_DECAY;
  sock.send('{"t":"time","c":' + hooks.now() + '}');
}

// A fresh connection fires a quick burst so the clock settles in a second
// or two; the slow standing probe then keeps it honest.
function probeBurst() {
  for (let i = 0; i < PROBE_BURST; i++) setTimeout(sendProbe, i * PROBE_BURST_GAP_MS);
}

function takeTime(c, s) {
  const r = hooks.now();
  const rtt = r - c;
  if (!(rtt >= 0) || rtt > 2000) return;
  if (rtt <= clockRtt) {
    const first = isNaN(clockOff);
    clockRtt = rtt;
    clockOff = s - (c + r) / 2;
    setStrobeClockOffset(clockOff);
    setWordWalkClock(clockOff);
    setRoomClockOffset(clockOff);
    // an Event sent before the clock settled went out with no unlock moment
    // (stateFor); now there is one to give
    if (first && available && unlockPending()) queueSend();
  }
}

function unlockPending() {
  for (const s of sessions) if (s.active && s.event && s.unlock) return true;
  return false;
}

function sendBeacon() {
  // A Journey step can start or end a one-shot sequence from the frame loop
  // without saving anything, which would leave followers walking (or not)
  // on a stale `wk` (see sendNow). The beacon's tick notices and sends.
  if (liveCount() && wordsRepeating() !== sentRepeating) queueSend();
  if (isNaN(clockOff) || !hooks.isRunning() || !liveCount()) return;
  const msg = JSON.stringify({
    t: 'phase', at: hooks.now() + clockOff,
    p: S.phase, f: S.effFreq,
    dp: S.driftPhase, vp: S.varPhase, bp: S.brightVarPhase,
    rp: S.ringBrightPhase, sp: S.edgeSpeedVarPhase, zp: S.edgeSizeVarPhase
  });
  for (const s of sessions) if (s.sock && s.status === 'live' && s.watchers) s.sock.send(msg);
}

function takeBeacon(msg) {
  if (!Number.isFinite(msg.at) || !Number.isFinite(msg.p) || !Number.isFinite(msg.f)) return;
  // kept even while the strobe is the viewer's, so a sync can steer by it at once
  lastBeacon = msg;
  if (strobeOwn) return;
  const n = v => Number.isFinite(v) ? v : 0;
  setStrobeSyncTarget(msg.at, msg.p, msg.f,
                      n(msg.dp), n(msg.vp), n(msg.bp), n(msg.rp), n(msg.sp), n(msg.zp));
}

// ---------- the follower's own strobe ----------
// A follower's viewer may want the strobe their own way (slower, dimmer,
// off) while the rest of the room's scene keeps coming. The moment they move
// any strobe control here, the strobe comes loose from the broadcast: each
// arriving state lands with the strobe's controls held where the viewer put
// them (presets.js replayHolding, the journey's own hold), and the phase
// beacons stop steering it, so it keeps its own time as well as its own
// settings. The chrome's sync chip, shown only while this is so, hands it
// back: the last state received is replayed on the preset glide and the last
// beacon taken up, so the strobe glides and slews home rather than jumping,
// and the next beacon, never more than BEACON_MS away, keeps it there. None
// of this is a setting: never saved, never sent, loose only until the page
// reloads, the broadcast ends or the link gives up.
//
// "The strobe" is what the schema files under it: every control of the
// Strobe section (its switch, the master, frequency and waveform, depth and
// brightness with their variances, the field's opacity, shape and fade, the
// colour and its walk, and flash quantization), plus the two other surfaces
// on the same state, the Layers row's Field switch and the chrome's STROBE
// dial. Two quick chips write strobe state without going through any of
// those, so they count too: the colour chip always, and the visual layers
// chip when its cycle turns the field on or off.
//
// A local move is told from a replayed one at store.save(), which every one
// of these set()s ends in: onSave fires for this tab's own changes and never
// for another tab's (those are applied with save() held silent), and this
// module's own applies run inside followApplying. So each strobe set() is
// wrapped only to say "a strobe write is under way", and the one onSave
// listener decides. Both flags are plain counters, so a drag allocates
// nothing.
const STROBE_IDS = [];
let strobeOwn = false;
let strobeWriting = 0;
let followApplying = false;
let lastSnap = null, lastBeacon = null;

function watchStrobeWrites() {
  for (const c of CONTROLS) {
    if ((c.section === 'strobe' || c.id === 'lField' || c.id === 'strobeScale') && !c.uiOnly && c.get && c.set) {
      STROBE_IDS.push(c.id);
      const set = c.set;
      c.set = (s, v) => { strobeWriting++; try { set(s, v); } finally { strobeWriting--; } };
    }
  }
  const color = byId('colorQuick');
  if (color && color.act) {
    const act = color.act;
    color.act = s => { strobeWriting++; try { act(s); } finally { strobeWriting--; } };
  }
  const visual = byId('visualQuick');
  if (visual && visual.act) {
    const act = visual.act;
    visual.act = s => { const was = !!s.layers.field; act(s); if (!!s.layers.field !== was) takeStrobe(); };
  }
  // A glide the broadcast handed in (takeGlides) writes from the frame loop,
  // outside followApplying; its engine marks those writes (perform.js
  // glideWriting 2), and they are the broadcaster's, not the viewer's.
  onSave(() => { if (strobeWriting && perfGlideWriting() !== 2) takeStrobe(); });
}

function takeStrobe() {
  if (strobeOwn || followApplying) return;
  strobeOwn = true;
  // the last beacon would otherwise keep steering for seconds
  clearStrobeSync();
  // and a handed-in glide on a strobe control would keep moving it
  for (let i = 0; i < STROBE_IDS.length; i++) perfFollowDrop(STROBE_IDS[i]);
}

// An arriving state, or the last one again on a sync. Left without a window
// it takes the preset glide. hold, when given, is more ids to leave where
// they are, besides a strobe the viewer has taken.
function applyFollowed(snap, sec, hold) {
  followApplying = true;
  try { replayHolding(snap, sec, hold || (strobeOwn ? STROBE_IDS : null)); } finally { followApplying = false; }
}

// The glides a state message named (its `tw`, see sendNow), each set going
// in this tab's own performer engine (perform.js perfFollowGlide) over what
// is left of it once `spent` seconds are taken off (the network's delay, or
// the time since the message on a sync), right after the snapshot has
// landed. The snapshot has just put each such control where the
// broadcaster's glide had it, so the glide starts from there, and a later
// message naming it again simply restarts it from that message's position:
// every send re-states them, so a follower is never more than one message
// from the truth. A glide whose time ran out on the way lands at once.
// Audio controls take this path too: it is the same engine, writing the same
// per-frame steps the broadcaster's own sound hears. The snapshot's window
// (FOLLOW_MIN_GLIDE_S, or a recall's) only carries the audio to where the
// broadcaster's glide stood when the message left; from the next frame the
// glide's own writes lead, as they do on the broadcaster, rather than the
// sound trailing the picture in quarter-second stairs. Settings only, never
// the run flag, so an Event still holds a follower before its unlock.
// Anything malformed is passed over; the engine refuses a control that is
// not a slider or the colour, or is this machine's own.
const TW_MAX_S = 120, TW_MAX_N = 512;
let lastTw = null, lastTwBase = 0;
function takeGlides(list, spent) {
  const n = list.length < TW_MAX_N ? list.length : TW_MAX_N;
  followApplying = true;
  try {
    for (let i = 0; i < n; i++) {
      const g = list[i];
      if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !Number.isFinite(g.rem)) continue;
      // a strobe the viewer has taken keeps their settings
      if (strobeOwn && STROBE_IDS.indexOf(g.id) >= 0) continue;
      const rem = g.rem < 0 ? 0 : g.rem > TW_MAX_S ? TW_MAX_S : g.rem;
      perfFollowGlide(g.id, g.to, rem - spent);
    }
  } finally { followApplying = false; }
}

function releaseStrobe() {
  strobeOwn = false;
  lastSnap = null;
  lastBeacon = null;
  lastTw = null;
}

// Read by the chrome every frame: true only on a follower whose viewer has
// taken the strobe.
export function followStrobeOwned() { return strobeOwn; }

// The sync chip: the strobe goes back under the broadcast.
// A glide in flight is left where it has got to rather than put back to where
// the last message had it, and then taken up again for what is left: the
// strobe's own come home from the viewer's settings on it, the rest carry on.
export function followStrobeSync() {
  if (!strobeOwn) return;
  strobeOwn = false;
  if (lastBeacon) takeBeacon(lastBeacon);
  if (!lastSnap) return;
  let gliding = null;
  if (lastTw) {
    gliding = [];
    for (let i = 0; i < lastTw.length && i < TW_MAX_N; i++) {
      const g = lastTw[i];
      if (g && typeof g.id === 'string') gliding.push(g.id);
    }
  }
  applyFollowed(lastSnap, undefined, gliding);
  if (lastTw) takeGlides(lastTw, (hooks.now() - lastTwBase) / 1000);
}

// ---------- Open and Event ----------
// The run flag arrives on every state message, and a state message goes out
// on every settings change, so applying it each time undid a follower's own
// start on the broadcaster's next change: the scene began and snapped back.
// In Open (and in an Event once it unlocks) the flag is therefore applied on
// its edges only. followRun remembers the last one received, and a message
// whose flag matches it leaves the follower's own choice alone; a different
// flag means the broadcaster really did start or stop, and that lands. The
// first message after the page joins has nothing to compare with, so it
// lands outright and the joiner starts in the room's true state.
//
// While an Event holds, the hold guards a PAUSED stream against free play:
// with the broadcaster stopped, a follower's start is refused before it
// happens (main.js's toggleRun asks followMayStart), so nothing blips. With
// the stream running, a follower's tap is simply a rejoin and is always
// allowed: pausing a live stream and coming back in is watching, not free
// play. A stop is never refused, and it sticks: the broadcaster's unchanged
// run riding the next settings message must not start them again, so a start
// lands on its edge only, as in Open, and a stopped follower stays stopped
// until they tap back into the still running stream, the broadcaster really
// stops and starts again, or the event unlocks. A stop still lands on every
// message while the Event holds, since stopping is always safe.
// It holds while the message says ev 1 and either no unlock moment is set,
// or this side's shared now has not reached it. With the clock not yet
// settled there is no shared now to compare, so it holds until the clock
// settles or a message says Open. None of this is saved: it is rebuilt from
// the next message, and let go when the broadcast ends or the link gives up,
// so a viewer is never left locked out by a room that is no longer there.
let followEv = false, followUn = NaN;
let followRun = -1;   // the last run flag received: -1 none yet, else 0 or 1

function eventHolds() {
  if (!followEv) return false;
  if (isNaN(clockOff) || isNaN(followUn)) return true;
  return hooks.now() + clockOff < followUn;
}

function takeRun(run) {
  const r = run ? 1 : 0;
  if (hooks.setRunning && (followRun < 0 || r !== followRun || (!run && eventHolds()))) hooks.setRunning(run);
  followRun = r;
}

function releaseEvent() {
  followEv = false;
  followUn = NaN;
  followRun = -1;
}

// Asked by main.js before any start of this tab's own (a tap, Space, the
// transport). True everywhere but on a follower an Event is holding, where
// it flashes why instead; the string is built here, on the tap, never per
// frame.
export function followMayStart() {
  if (!followSock || !eventHolds()) return true;
  // A running stream can always be rejoined; the hold only refuses starting
  // a paused one before the unlock.
  if (followRun === 1) return true;
  if (isNaN(clockOff) || isNaN(followUn)) hooks.notify('The stream is paused');
  else hooks.notify('Free play unlocks in ' + clockText(Math.ceil((followUn - hooks.now() - clockOff) / 1000)));
  return false;
}

// Whole seconds as m:ss under an hour, h:mm:ss from an hour on.
function clockText(sec) {
  if (!(sec > 0)) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const ss = (s < 10 ? ':0' : ':') + s;
  return h ? h + (m < 10 ? ':0' : ':') + m + ss : m + ss;
}

function setLabel(s) {
  s.label =s.status === 'live' ? s.watchers + ' watching' : s.status === 'doze' ? 'resting' : '';
  version++;
}

function openSession(s) {
  s.status = 'wait';
  s.watchers = 0;
  setLabel(s);
  s.sock = bits.open(s.room, 'broadcast', key, {
    onMessage: str => {
      let msg;
      try { msg = JSON.parse(str); } catch (e) { return; }
      if (!msg) return;
      if (msg.t === 'count' && Number.isFinite(msg.n)) {
        const had = s.watchers;
        s.watchers = msg.n | 0;
        setLabel(s);
        // the first watcher finds a room gone quiet: hand them the state now
        if (!had && s.watchers && s.status === 'live') sendNow();
        // and the sound, if on air: the last watcher leaving stops it
        liveAudioCheck();
      } else if (msg.t === 'time' && Number.isFinite(msg.c) && Number.isFinite(msg.s)) {
        takeTime(msg.c, msg.s);
      }
    },
    onStatus: st => {
      if (st === 'open') {
        s.status = 'live';
        setLabel(s);
        // a fresh connection starts a fresh idle window (see dozing)
        lastActivityMs = Date.now();
        // the relay reports the room's counts right after the join; if
        // followers are already waiting, that count message sends them the
        // state. This send covers any other watched session, and this one
        // too once its count lands.
        sendNow();
        probeBurst();
      } else if (st === 'lost') {
        s.status = 'wait';
        setLabel(s);
      } else if (st === 'dead') {
        s.status = 'dead';
        s.active = false;
        s.sock = null;
        setLabel(s);
        hooks.notify('Broadcast "' + s.name + '" failed: relay unreachable or wrong key');
        persist();
      }
      // A lost socket's room loses its place in the live sound, so the
      // reconnect hands it a fresh header; an open one with watchers already
      // counted takes the sound up at once.
      liveAudioCheck();
    }
  });
}

function closeSession(s, end) {
  if (s.sock) {
    // tell the room it is over, so its stored snapshot clears and a viewer
    // opening the link later gets nothing rather than a stale scene
    if (end && s.status === 'live') s.sock.send('{"t":"end"}');
    s.sock.close();
    s.sock = null;
  } else if (end && s.status === 'doze') endDozing(s);
  s.status = 'off';
  s.watchers = 0;
  setLabel(s);
  liveAudioCheck();
}

// ---------- the drawer's view ----------

export function broadcastAvailable() { return available; }
export function broadcastVersion() { return version; }
export function broadcastCount() { return sessions.length; }
export function broadcastName(i) { const s = sessions[i]; return s ? s.name : ''; }
export function broadcastActive(i) { const s = sessions[i]; return !!s && s.active; }
// 'off' | 'wait' (connecting or reconnecting) | 'live' | 'doze' (active,
// hung up while idle) | 'dead' (gave up)
export function broadcastStatus(i) { const s = sessions[i]; return s ? s.status : 'off'; }
// '<n> watching' while live, 'resting' while dozing, else ''; cached so the
// drawer never builds it
export function broadcastWatchLabel(i) { const s = sessions[i]; return s ? s.label : ''; }
export function broadcastHasKey() { return !!key; }
export function broadcastKey() { return key; }
export function broadcastLinkTarget() { return linkTarget; }

export function broadcastSetLinkTarget(target) {
  const next = target === 'local' ? 'local' : 'live';
  if (next === linkTarget) return;
  linkTarget = next;
  persist();
}

export function broadcastSetKey(k) {
  const clean = String(k || '').trim();
  if (clean === key) return;
  key = clean;
  // a live session keeps its already-authorised socket; the new key is what
  // the next connect uses
  persist();
}

// Adds a named session (inactive). Returns its index, or -1 for an empty name.
export function broadcastAdd(name) {
  ensureLoaded();
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!clean) return -1;
  sessions.push(makeSession(clean, slugFor(clean), false));
  persist();
  return sessions.length - 1;
}

export function broadcastRemove(i) {
  const s = sessions[i];
  if (!s) return;
  if (asking === s) { asking = null; version++; }
  closeSession(s, true);
  sessions.splice(i, 1);
  persist();
  if (s.scene) persistScenes();
}

// The activate/deactivate switch. Activating without a key refuses, with the
// notice saying why, so the drawer needs no state of its own for it. A
// session with a left-off scene asks first (see below) and stays off until
// the question is answered.
export function broadcastToggle(i) {
  const s = sessions[i];
  if (!s) return;
  if (s.active) {
    s.active = false;
    keepScene(s);
    closeSession(s, true);
  } else {
    if (!key) { hooks.notify('Set the broadcast key first'); return; }
    if (s.scene) { askRecall(s); return; }
    s.active = true;
    openSession(s);
  }
  persist();
}

// ---------- where a stream was left ----------
// Ending a stream leaves its followers where they are: each keeps playing the
// last state it was sent, and saves it as its own. So when the broadcaster
// ends a session from its switch, the scene that room was last sent is kept
// with the session (the snapshot out of sent, the exact state message, without
// the run flag and timing that ride beside it), stamped with when. A reload, a lost link
// and a doze are not endings and keep nothing, and a session that sent its
// room nothing since the page loaded keeps whatever it already had, since
// that is still what its followers last saw. Only the latest is kept, and
// it stays through either answer below until the next ending replaces it,
// so a mis-tap is undone by switching the session off and on again.
//
// Turning such a session back on from the switch first asks whether to go
// back there. Recall lands that scene on this screen through the presets'
// own door (presets.js recallStreamScene) and only then opens the session,
// so its first state message carries it and a follower still sitting there
// sees nothing move. Start from here opens it as it stands. Putting the
// question away any other way (Escape, a press off the card) leaves the
// session off. The question itself is the chrome's (ui/screens/chrome.js),
// which reads it here. Sessions that come back up on their own at load, and
// the URL's seeded one, never ask.
let asking = null, askText = '';

function keepScene(s) {
  if (!s.sent) return;
  let msg = null;
  try { msg = JSON.parse(s.sent + '}'); } catch (e) { msg = null; }
  s.sent = null;
  if (!msg || !msg.snap || typeof msg.snap !== 'object') return;
  s.scene = { snap: msg.snap, at: Date.now() };
  persistScenes();
}

function askRecall(s) {
  asking = s;
  askText = 'Go back to where you left ' + s.name + ' (' + agoText(Date.now() - s.scene.at) +
            ') so viewers pick up where they were.';
  version++;
}

// How long ago, in the fewest words: '5 min ago', '2 h ago', '3 d ago'.
function agoText(ms) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' h ago';
  return Math.floor(h / 24) + ' d ago';
}

export function broadcastAsking() { return asking !== null; }
export function broadcastAskText() { return askText; }

// The answer: 1 Recall, 0 Start from here, anything else put away unanswered.
export function broadcastAnswer(choice) {
  const s = asking;
  if (!s) return;
  asking = null;
  version++;
  if (choice !== 1 && choice !== 0) return;
  if (s.active || sessions.indexOf(s) < 0) return;
  if (!key) { hooks.notify('Set the broadcast key first'); return; }
  if (choice === 1 && s.scene) recallStreamScene(s.scene.snap);
  s.active = true;
  openSession(s);
  persist();
}

// The viewer's link for row i, built on the click that asks for it.
export function broadcastLink(i) {
  const s = sessions[i];
  return s ? bits.followUrl(s.room, linkTarget) : '';
}

// Copies row i's link and says so.
export function broadcastCopyLink(i) {
  const url = broadcastLink(i);
  if (!url) return;
  hooks.copy(url);
  hooks.notify('Link copied: ?follow=' + sessions[i].room);
}

// Row i's mode: true an Event, false Open.
export function broadcastEvent(i) { const s = sessions[i]; return !!s && s.event; }

// Every mode or unlock change goes through queueSend, as a settings change
// does, so a dozing session wakes and its reconnect carries the new state,
// and one already live sends it within SEND_DELAY_MS.
export function broadcastSetEvent(i, on) {
  const s = sessions[i];
  if (!s || s.event === !!on) return;
  s.event = !!on;
  persist();
  queueSend();
}

export function broadcastHasUnlock(i) { const s = sessions[i]; return !!s && s.unlock > 0; }

// Row i's unlock as the drawer shows it: 'Not set', 'in 12:40' counting
// down, or 'Unlocked' once passed. Read every frame, so the countdown is
// rebuilt only when its whole second moves, and kept on the session.
const UNLOCK_UNSET = 'Not set', UNLOCK_DONE = 'Unlocked';
export function broadcastUnlockLabel(i) {
  const s = sessions[i];
  if (!s || !s.unlock) return UNLOCK_UNSET;
  const left = s.unlock - Date.now();
  const sec = left > 0 ? Math.ceil(left / 1000) : 0;
  if (sec !== s.unSec || !s.unLabel) {
    s.unSec = sec;
    s.unLabel = sec > 0 ? 'in ' + clockText(sec) : UNLOCK_DONE;
  }
  return s.unLabel;
}

// The unlock row's typed entry, on its commit: a wall-clock time today
// ("21:30", "9:30pm"; one already past means tomorrow's), or a wait from now
// ("45m", "1h30m", "1.5h", a bare "45" read as minutes), or "none" to clear
// it. Anything else leaves the unlock as it was and says so.
export function broadcastSetUnlock(i, text) {
  const s = sessions[i];
  if (!s) return;
  const at = parseUnlock(text);
  if (isNaN(at)) { hooks.notify('Try a time like 21:30, or a wait like 45m or 1h30m'); return; }
  if (at === s.unlock) return;
  s.unlock = at;
  s.unLabel = '';
  persist();
  queueSend();
}

// Wall-clock ms, 0 for cleared, NaN for text it cannot read.
function parseUnlock(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, '');
  if (t === 'none' || t === 'off' || t === 'clear') return 0;
  let m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
  if (m && (m[2] !== undefined || m[3])) {
    let h = +m[1];
    const min = m[2] !== undefined ? +m[2] : 0;
    if (m[3]) {
      if (h < 1 || h > 12) return NaN;
      h = h % 12 + (m[3] === 'pm' ? 12 : 0);
    }
    if (h > 23 || min > 59) return NaN;
    const d = new Date();
    d.setHours(h, min, 0, 0);
    // stepped by the calendar, not by 24 hours, so a clock change overnight
    // still lands on the time typed
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m?)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined)) return NaN;
  const ms = ((m[1] !== undefined ? +m[1] : 0) * 60 + (m[2] !== undefined ? +m[2] : 0)) * 60000;
  return Date.now() + Math.round(ms);
}

// ---------- boot ----------

// bits_ (from platform/broadcast-socket.js, handed in by main.js):
//   intent      what the URL asked for, or null
//   open        openBroadcastSocket
//   followUrl   makeFollowUrl
// hooks_: notify(str) flashes the overlay notice; isRunning() and
// setRunning(on) are main.js's view of the transport; copy(str) is the
// platform clipboard.
export function initBroadcast(bits_, hooks_) {
  bits = bits_;
  hooks = hooks_ || {};
  hooks.notify = hooks.notify || noop;
  hooks.copy = hooks.copy || noop;
  const intent = bits.intent;

  // A follower tab is only a follower: no sessions, no drawer section. Its
  // strobe follows the beacons (takeBeacon) as well as its settings, so its
  // flashes land with the broadcaster's, not just at the same rate.
  if (intent && intent.follow) {
    const room = intent.follow;
    watchStrobeWrites();
    initLiveAudio(bits.media, hooks.notify, null);
    followSock = bits.open(room, 'follow', '', {
      // a piece of the broadcaster's live sound (core/live-audio.js)
      onBinary: liveFollowChunk,
      onMessage: str => {
        let msg;
        try { msg = JSON.parse(str); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'state' && msg.snap && typeof msg.snap === 'object') {
          // Deadline alignment (see sendNow): a message carrying a recall
          // says how long its glide was; this side runs what the network
          // left of it, so both screens land together. Without a fresh
          // recall the window is short, just enough to smooth the next
          // message of a stream in, rather than a whole preset glide of lag.
          let sec = FOLLOW_MIN_GLIDE_S;
          if (Number.isFinite(msg.glide) && msg.glide > 0) {
            const del = !isNaN(clockOff) && Number.isFinite(msg.at)
              ? Math.max(0, (hooks.now() + clockOff - msg.at) / 1000)
              : 0.3;
            sec = Math.max(FOLLOW_MIN_GLIDE_S, msg.glide - del);
          }
          // A strobe the viewer has taken stays theirs (applyFollowed holds
          // it); the rest lands as always. Kept for the sync chip.
          lastSnap = msg.snap;
          applyFollowed(msg.snap, sec);
          // Then the glides it names, over what the network left of each
          // (see takeGlides); kept, with when they were counted from, for
          // the sync chip. None named means none in flight.
          lastTw = Array.isArray(msg.tw) && msg.tw.length ? msg.tw : null;
          if (lastTw) {
            const spent = !isNaN(clockOff) && Number.isFinite(msg.at)
              ? Math.max(0, (hooks.now() + clockOff - msg.at) / 1000) : 0;
            lastTwBase = hooks.now() - spent * 1000;
            takeGlides(lastTw, spent);
          }
          // The mode first, so the run flag is judged by this message's own
          // (see Open and Event). A broadcaster from before the modes sends
          // no ev, and its followers are Open.
          followEv = msg.ev === 1;
          followUn = followEv && Number.isFinite(msg.un) ? msg.un : NaN;
          if (typeof msg.run === 'boolean') takeRun(msg.run);
          // The shared walk runs here only while the broadcaster's own
          // scheduler is dealing (wk, see sendNow). A broadcaster from
          // before the walk sends no wk, and its followers keep showing only
          // its relayed words, as they always did.
          setWordWalk(msg.wk === 1 ? room : '');
          // The layers' swings follow the room clock whatever wk says: a
          // broadcaster's Journey keeps its own swings on the room clock,
          // so its followers' must stay there too.
          setRoomClockRoom(true);
        } else if (msg.t === 'phase') {
          takeBeacon(msg);
        } else if (msg.t === 'word') {
          // The broadcaster's exact word, with its seed and fade rolls, so
          // the same word dissolves the same way here. The first one hands
          // the word scheduler to the broadcast (words.js goes remote). A
          // word its shared walk dealt carries the step (k); once this side's
          // own walk runs it deals that very word at that very moment, so
          // the relayed copy is dropped rather than shown twice. Any other
          // word (a performer's phrase, a Journey's) is the broadcaster
          // choosing live, and wins over the walk while it shows.
          if (typeof msg.w === 'string') {
            const k = Number.isFinite(msg.k) ? msg.k : -1;
            if (k < 0 || !wordWalkRunning()) remoteWord(msg.w, msg.seed, msg.fi, msg.fo, k);
          }
        } else if (msg.t === 'time' && Number.isFinite(msg.c) && Number.isFinite(msg.s)) {
          takeTime(msg.c, msg.s);
        } else if (msg.t === 'live') {
          // the live sound starting afresh (its header comes next) or stopping
          liveFollowNotice(msg.on === 1);
        } else if (msg.t === 'end') {
          liveFollowEnd();
          clearStrobeSync();
          releaseStrobe();
          releaseEvent();
          setWordsRemote(false);
          setWordWalk('');
          setRoomClockRoom(false);
          hooks.notify('The broadcast has ended');
        }
      },
      onStatus: st => {
        if (st === 'open') {
          hooks.notify('Following: ' + room);
          probeBurst();
          // The word scheduler is the broadcaster's from the first moment,
          // not from the first word: otherwise this side would deal its own
          // words into the gap before the broadcaster's first one arrives.
          setWordsRemote(true);
        }
        else if (st === 'lost') hooks.notify('Broadcast link lost, reconnecting…');
        else if (st === 'dead') { liveFollowEnd(); clearStrobeSync(); releaseStrobe(); releaseEvent(); setWordsRemote(false); setWordWalk(''); setRoomClockRoom(false); hooks.notify('Broadcast failed: could not reach the relay'); }
      }
    });
    probeTimer = setInterval(sendProbe, PROBE_EVERY_MS);
    return;
  }

  available = true;
  ensureLoaded();

  // The URL can seed the broadcaster: a key alone is stored, and the legacy
  // ?broadcast=<room>&key=<k> form becomes a session of that name, activated.
  if (intent) {
    if (intent.key) broadcastSetKey(intent.key);
    if (intent.seed && /^[\w-]{1,64}$/.test(intent.seed)) {
      let at = sessions.findIndex(s => s.room === intent.seed);
      if (at < 0) { sessions.push(makeSession(intent.seed, intent.seed, false)); persist(); at = sessions.length - 1; }
      // straight on, never asking: the URL already said what it wants
      if (sessions[at].active) { /* already up */ }
      else if (!key) hooks.notify('Set the broadcast key first');
      else { sessions[at].active = true; openSession(sessions[at]); persist(); }
    }
  }

  onSave(localSave);
  // Both glide engines report here (see `tw` at sendNow): a glide starting
  // asks for its message, an engine running dry for the landing send.
  setPerfGlideHooks(queueSend, glideLanded);
  setJourneyGlideHooks(queueSend, glideLanded);
  // The live sound's view of the sessions: it reads their sockets, statuses
  // and counts, its pieces are activity for the doze, and going on air wakes
  // a dozing session through queueSend like any other touch.
  initLiveAudio(bits.media, hooks.notify, {
    sessions: () => sessions,
    activity: () => { lastActivityMs = Date.now(); },
    wake: queueSend
  });
  probeTimer = setInterval(sendProbe, PROBE_EVERY_MS);
  beaconTimer = setInterval(sendBeacon, BEACON_MS);
  dozeTimer = setInterval(checkDoze, DOZE_CHECK_MS);

  // Each word this tab's scheduler picks goes out the moment it appears,
  // with its seed and fade rolls, so every follower shows the same word
  // arriving and leaving the same way. Words are occasional (seconds
  // apart), so the message is built on the spot. A word the shared walk
  // dealt says its step (k), so a follower already walking can tell it has
  // it; the rest go out untagged and win on every follower.
  onWordAppear(w => {
    if (!liveCount()) return;
    const msg = JSON.stringify({ t: 'word', w, seed: wordState.seed, fi: wordState.fadeInMul, fo: wordState.fadeOutMul,
                                 k: wordState.step >= 0 ? wordState.step : undefined });
    for (const s of sessions) if (s.sock && s.status === 'live' && s.watchers) s.sock.send(msg);
  });

  // Sessions left active last time come back up on their own.
  for (const s of sessions) if (s.active) openSession(s);
  syncWalkRoom();
}
