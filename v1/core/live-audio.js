// Live sound over the broadcast: the broadcaster's voice (the Live Sound
// layer's mix, js/livesound.js) carried through the same relay rooms as the
// settings, to every follower's ears. This is the logic half; the recorder
// and the player are browser machinery and live in platform/live-media.js,
// handed in by main.js with the broadcast's other platform bits, so this
// module stays inside the core boundary and treats the stream as an opaque
// thing to pass along.
//
// On the broadcaster's side there is one switch, On air, in the drawer's
// Broadcast section. It is transport state, like a session's own switch,
// not a scene setting: never saved, so a reload always comes back off air
// and no page ever starts sending a microphone by itself. On air, the sound
// goes out only while three things are all true: the Live Sound layer is on
// and capturing (liveBroadcastStream() gives a stream), at least one live
// session is connected, and someone is watching it. That last condition is
// the cost model, not a nicety: the relay bills by the messages arriving and
// the time a room is awake, and an empty room sent nothing sleeps. So the
// recorder runs only while someone can hear it, and stops the moment the
// last listener anywhere leaves, the layer goes off, or the switch does.
// When the conditions return it simply starts again, and a fresh recording
// brings its own fresh header, which is exactly what a returning audience
// needs.
//
// A WebM stream can only be read from its header, which is the first piece
// a recording makes. Each room is told {t:'live',on:1} and handed that
// first piece before any other: every room watched when the recording
// begins at its first piece, and a room that comes to be watched later (its
// first follower arrives, its socket reconnects) at the next piece, from
// the copy kept here, followed by the piece itself. The relay keeps that
// header for anyone joining the room mid-stream, and the follower's player
// stitches the header and the middle of the stream together (see
// platform/live-media.js on sequence mode). A room that stops hearing the
// stream while its socket still stands is told {t:'live',on:0}, which lets
// the relay forget the header.
//
// The pieces count as activity for the idle doze (core/broadcast.js): a
// session carrying sound is never hung up for being quiet, since it is not.
// Going on air passes through broadcast.js's queueSend, the choke point
// where a dozing session wakes, so a resting session reconnects, learns its
// watcher count, and the sound starts if anyone is there. On air with no
// one watching sends nothing at all, and dozes as a silent session does.
//
// Whether the layer is capturing can change without telling anyone (the
// viewer switches it, the device goes away), so while on air the conditions
// are looked at twice a second as well as on every count and status change.
//
// A follower's side is the other half of the same notices: {t:'live',on:1}
// readies the player for a new header, each binary frame is a piece, and
// {t:'live',on:0} or {t:'end'} lets what is buffered play out.
import { liveBroadcastStream } from '../../js/livesound.js';

const LIVE_ON = '{"t":"live","on":1}';
const LIVE_OFF = '{"t":"live","on":0}';
const POLL_MS = 500;

// The drawer's status beside the switch, literals so it never builds one.
const LABEL_OFF = '';
const LABEL_NO_SOUND = 'Live Sound off';
const LABEL_NO_EARS = 'no listeners';
const LABEL_SENDING = 'sending';

let media = null;      // platform/live-media.js: record, canRecord, player
let ctx = null;        // broadcast.js's view, broadcaster only: sessions(), activity(), wake()
let notify = () => {};

let onAir = false;
let pollTimer = null;
let rec = null, recStream = null, recGen = 0;
let deadStream = null; // a stream whose recording ended on its own; not retried while it stays up
let initChunk = null;  // this recording's first piece, its header
const aired = new Set(); // sockets whose room has this recording's header
let label = LABEL_OFF;

// ---------- boot ----------

// media_: { record, canRecord, player } from platform/live-media.js.
// ctx_ is the broadcaster's hooks, or null on a follower.
export function initLiveAudio(media_, notify_, ctx_) {
  media = media_ || null;
  ctx = ctx_ || null;
  if (notify_) notify = notify_;
}

// ---------- the drawer's view ----------

export function liveOnAir() { return onAir; }
// '' off air, else what the switch is doing: 'sending', 'no listeners',
// 'Live Sound off'
export function liveAirLabel() { return label; }
export function liveAirSending() { return rec !== null; }

export function liveSetOnAir(on) {
  on = !!on;
  if (on === onAir || !ctx) return;
  if (on && !(media && media.canRecord())) { notify('This browser cannot send live sound'); return; }
  onAir = on;
  if (on) {
    pollTimer = setInterval(liveAudioCheck, POLL_MS);
    deadStream = null;
    // a resting session wakes here, and its count brings the sound in
    ctx.wake();
  } else {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  liveAudioCheck();
  if (on && !recStream && !liveBroadcastStream()) notify('On air: turn on Live Sound to be heard');
}

// ---------- the broadcaster ----------

function eligible(s) {
  return !!s.sock && s.status === 'live' && s.watchers > 0;
}

function wanted(sock, sessions) {
  for (const s of sessions) if (s.sock === sock) return eligible(s);
  return false;
}

// Looks at the conditions and starts, stops or restarts the recording to
// match. Called by broadcast.js on every watcher count and socket status
// change, and by the poll while on air. Cheap when nothing moved.
export function liveAudioCheck() {
  if (!ctx) return;
  const sessions = ctx.sessions();
  let stream = onAir ? liveBroadcastStream() : null;
  // the layer hands out one stream for as long as its context lives, so a
  // recording that died on it is retried only once a new one comes (the
  // layer off and on again, or a latency rebuild); a new object here is a
  // new stream, and the check below starts a fresh recording on it
  if (!stream) deadStream = null;
  else if (stream === deadStream) stream = null;
  let ears = false;
  for (const s of sessions) if (eligible(s)) { ears = true; break; }
  // a room that should no longer hear the stream is told so, if it still
  // has a socket to be told on (a closed or lost one drops it, and the
  // relay forgets on its own)
  for (const sock of aired) {
    if (!rec || !wanted(sock, sessions)) { sock.send(LIVE_OFF); aired.delete(sock); }
  }
  if (stream && ears) {
    if (!rec || recStream !== stream) startRecording(stream);
  } else if (rec) stopRecording();
  label = !onAir ? LABEL_OFF : !stream ? LABEL_NO_SOUND : !ears ? LABEL_NO_EARS : rec ? LABEL_SENDING : LABEL_NO_SOUND;
}

function startRecording(stream) {
  if (rec) stopRecording();
  const gen = ++recGen;
  rec = media.record(stream, buf => takeChunk(gen, buf), () => {
    // ended on its own (the layer's tracks stopped): wait for a new stream
    if (gen !== recGen) return;
    deadStream = recStream;
    dropRecording();
    liveAudioCheck();
  });
  if (!rec) {
    deadStream = stream;
    notify('Live sound could not start recording');
    return;
  }
  recStream = stream;
  initChunk = null;
}

function stopRecording() {
  if (rec) rec.stop();
  dropRecording();
}

function dropRecording() {
  recGen++;
  rec = null;
  recStream = null;
  initChunk = null;
  for (const sock of aired) sock.send(LIVE_OFF);
  aired.clear();
}

// One piece from the recorder, out to every watched room. A room hearing
// this recording for the first time is told so and handed its header
// first; the first piece is itself that header.
function takeChunk(gen, buf) {
  if (gen !== recGen || !rec) return;
  if (!initChunk) initChunk = buf;
  let sent = false;
  for (const s of ctx.sessions()) {
    if (!eligible(s)) continue;
    const sock = s.sock;
    if (!aired.has(sock)) {
      sock.send(LIVE_ON);
      sock.send(initChunk);
      aired.add(sock);
      if (buf !== initChunk) sock.send(buf);
    } else sock.send(buf);
    sent = true;
  }
  if (sent) ctx.activity();
}

// ---------- the follower ----------

let warned = false;
function player() {
  const p = media ? media.player() : null;
  if (!p && !warned) { warned = true; notify('This browser cannot play the live sound'); }
  return p;
}

// {t:'live',on} from the relay: a new recording starts (its header is the
// next piece), or the stream stopped.
export function liveFollowNotice(on) {
  const p = player();
  if (!p) return;
  if (on) p.begin(); else p.end();
}

// A binary frame: one piece of the live sound.
export function liveFollowChunk(buf) {
  const p = media ? media.player() : null;
  if (p) p.push(buf);
}

// The broadcast ended or the link gave up.
export function liveFollowEnd() {
  const p = media ? media.player() : null;
  if (p) p.end();
}
