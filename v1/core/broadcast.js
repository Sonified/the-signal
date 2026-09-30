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
// the send happens when it fires. The relay tells each broadcast socket how
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
// Sessions and the broadcast key persist under their own record
// (signal.broadcast.v1, through store.readKey/saveKey like the presets), so
// the drawer's list survives a reload, and a session left active reconnects
// at boot: a demo survives the broadcaster's page refresh.
import { S } from '../../js/state.js';
import { onSave, snapshot, applySnapshot, readKey, saveKey } from './store.js';
import { replayLive, presetTransitionCount, lastTransitionSec } from './presets.js';
import { setStrobeClockOffset, setStrobeSyncTarget, clearStrobeSync } from './strobe.js';
import { onWordAppear, wordState, remoteWord, setWordsRemote,
         setWordWalk, setWordWalkClock, wordWalkRunning, wordsRepeating } from './words.js';

const REC_KEY = 'signal.broadcast.v1';
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
let sessions = [];   // { name, room, active, sock, status:'off'|'wait'|'live'|'doze'|'dead', watchers, label }
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
      sessions.push(makeSession(s.name.slice(0, NAME_MAX), s.room, !!s.active));
    }
  }
}

function persist() {
  version++;
  syncWalkRoom();
  const out = { key, linkTarget, sessions: [] };
  for (const s of sessions) out.sessions.push({ name: s.name, room: s.room, active: s.active });
  saveKey(REC_KEY, out);
}

function makeSession(name, room, active) {
  return { name, room, active, sock: null, status: 'off', watchers: 0, label: '' };
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
let lastTransSeq = -1;
let sentRepeating = true;
function sendNow() {
  sendTimer = null;
  if (!liveCount()) return;
  let glide = 0;
  const seq = presetTransitionCount();
  if (seq !== lastTransSeq) {
    if (lastTransSeq >= 0) glide = lastTransitionSec();
    lastTransSeq = seq;
  }
  sentRepeating = wordsRepeating();
  const msg = JSON.stringify({
    t: 'state', run: !!hooks.isRunning(), snap: snapshot(),
    at: isNaN(clockOff) ? undefined : hooks.now() + clockOff, glide,
    wk: sentRepeating ? 1 : 0
  });
  let sent = 0;
  for (const s of sessions) if (s.sock && s.status === 'live' && s.watchers) { s.sock.send(msg); sent++; }
  if (sent) lastActivityMs = Date.now();
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
// Ten minutes without a state send hangs up every live session. The session
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
let lastActivityMs = 0;
let dozeTimer = null;

function syncWalkRoom() {
  if (followSock) return;   // a follower's room is set by its own messages
  let room = '';
  for (const s of sessions) if (s.active) { room = s.room; break; }
  setWordWalk(room);
}

function checkDoze() {
  // a send already armed is activity about to happen; let it land first
  if (sendTimer || Date.now() - lastActivityMs <= IDLE_DOZE_MS) return;
  for (const s of sessions) {
    if (s.status !== 'live' || !s.sock) continue;
    s.sock.close();
    s.sock = null;
    s.status = 'doze';
    setLabel(s);
  }
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
    clockRtt = rtt;
    clockOff = s - (c + r) / 2;
    setStrobeClockOffset(clockOff);
    setWordWalkClock(clockOff);
  }
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
  const n = v => Number.isFinite(v) ? v : 0;
  setStrobeSyncTarget(msg.at, msg.p, msg.f,
                      n(msg.dp), n(msg.vp), n(msg.bp), n(msg.rp), n(msg.sp), n(msg.zp));
}

function setLabel(s) {
  s.label = s.status === 'live' ? s.watchers + ' watching' : s.status === 'doze' ? 'resting' : '';
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
  closeSession(s, true);
  sessions.splice(i, 1);
  persist();
}

// The activate/deactivate switch. Activating without a key refuses, with the
// notice saying why, so the drawer needs no state of its own for it.
export function broadcastToggle(i) {
  const s = sessions[i];
  if (!s) return;
  if (s.active) {
    s.active = false;
    closeSession(s, true);
  } else {
    if (!key) { hooks.notify('Set the broadcast key first'); return; }
    s.active = true;
    openSession(s);
  }
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

// ---------- boot ----------

// bits_ (from v1/platform/broadcast-socket.js, handed in by main.js):
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
    followSock = bits.open(room, 'follow', '', {
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
          replayLive(() => applySnapshot(msg.snap), sec);
          if (typeof msg.run === 'boolean' && hooks.setRunning) hooks.setRunning(msg.run);
          // The shared walk runs here only while the broadcaster's own
          // scheduler is dealing (wk, see sendNow). A broadcaster from
          // before the walk sends no wk, and its followers keep showing only
          // its relayed words, as they always did.
          setWordWalk(msg.wk === 1 ? room : '');
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
        } else if (msg.t === 'end') {
          clearStrobeSync();
          setWordsRemote(false);
          setWordWalk('');
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
        else if (st === 'dead') { clearStrobeSync(); setWordsRemote(false); setWordWalk(''); hooks.notify('Broadcast failed: could not reach the relay'); }
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
      if (!sessions[at].active) broadcastToggle(at);
    }
  }

  onSave(queueSend);
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
