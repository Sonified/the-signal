// Live Video's transport: the one seam between the presenter's camera and
// the other screens. Everything else in the feature (the switch, the size,
// the panel, the camera's lifecycle, the size riding the broadcast) talks to
// these four functions and to nothing below them.
//
//   cameraSend(stream, room, key)   the presenter's camera is open: start
//                                   sending it to room (or swap to this
//                                   stream if already sending).
//   cameraStopSending()             the camera closed: stop, and free all.
//   cameraWatch(room, fn)           a follower: call fn(stream) whenever the
//                                   presenter's video arrives or changes, and
//                                   fn(null) when it goes.
//   cameraUnwatch()                 stop watching.
//
// The shape handed across is a MediaStream, which the panel's <video> plays
// (platform/camera-panel.js): the camera's own on the presenting page, and on
// a follower the canvas the decoded pictures are drawn on
// (canvas.captureStream()).
//
// The route: frames packed once with WebCodecs on the presenting laptop and
// sent through the video broadcast test's deployed relay (the VideoRoom,
// video-broadcast-testing/worker), which hands each to every viewer, so the
// laptop's upload is the same for 10 viewers or 200. The room is the
// livestream room's name with 'cam-' before it ('cam-livestream', or
// 'cam-livestream-rehearsal' for a rehearsal), so the camera never shares a
// room with the test page's own.
//
// THE RELAY TAKES NO PASSWORD (platform/camera-relay.js): key is ignored for
// now, and anyone who knows the room's name could send into it. Accepted for
// today; a sender key in the worker is the follow-up.
//
// The safety rule: with Live Video off, nothing connects and nothing runs.
// The sender starts only from the presenting page's open camera, which
// exists only while its switch is on, and stops when the camera closes. The
// receiver connects only while the broadcaster's switch (core/broadcast.js
// `cv`, core/camera.js camShownOn) says on, and disconnects when it goes off
// or the broadcast ends. Both live in modules loaded on first use, so a page
// that never turns the camera on never even loads them.
import { onCamChange, camShownOn } from '../core/camera.js';

export const CAMERA_TRANSPORT = 'video-relay';

// The relay room for a livestream room: 1-64 word characters or dashes.
export function camRelayRoom(room) {
  const r = String(room || 'livestream').replace(/[^\w-]+/g, '-');
  return ('cam-' + r).slice(0, 64);
}

// ---------- the presenting page ----------
let sender = null, sendGen = 0;

export function cameraSend(stream, room, key) {
  void key;   // the relay asks for none (see above)
  cameraStopSending();
  if (!stream || !room || !camShownOn()) return;
  const my = ++sendGen;
  import('./camera-send.js').then(m => {
    if (my !== sendGen) return;
    sender = m.startSender(stream, camRelayRoom(room));
  }, e => console.warn('live video: the sender did not load', e));
}

export function cameraStopSending() {
  ++sendGen;
  if (sender) { try { sender.stop(); } catch (e) {} sender = null; }
}

// ---------- a follower ----------
let watching = null, receiver = null, recvGen = 0, receiving = false, listening = false;

function stopReceiving(w) {
  if (!receiving) return;
  receiving = false;
  ++recvGen;
  if (receiver) { try { receiver.stop(); } catch (e) {} receiver = null; }
  if (w) { try { w.fn(null); } catch (e) {} }
}

// Runs on every change of the broadcaster's switch (and of anything else
// core/camera.js reports): connected exactly while it says on.
function follow() {
  const w = watching;
  if (!w || !camShownOn()) { stopReceiving(w); return; }
  if (receiving) return;
  receiving = true;
  const my = ++recvGen;
  import('./camera-receive.js').then(m => {
    if (my !== recvGen) return;
    receiver = m.startReceiver(camRelayRoom(w.room), s => {
      if (my === recvGen && watching === w) { try { w.fn(s); } catch (e) {} }
    });
  }, e => console.warn('live video: the receiver did not load', e));
}

export function cameraWatch(room, fn) {
  cameraUnwatch();
  watching = { room, fn: typeof fn === 'function' ? fn : () => {} };
  if (!listening) { listening = true; onCamChange(follow); }
  follow();
}

export function cameraUnwatch() {
  const w = watching;
  watching = null;
  stopReceiving(w);
}

// For the tests and the console: whether anything is live.
export const cameraWatching = () => !!watching;
export const cameraReceiving = () => receiving;
export const cameraSending = () => !!sender;
