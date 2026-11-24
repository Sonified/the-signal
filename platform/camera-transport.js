// Live Video's transport: the one seam between the presenter's camera and
// the other screens. Everything else in the feature (the switch, the size,
// the panel, the camera's lifecycle, the size riding the broadcast) talks to
// these four functions and to nothing below them, so a real transport goes
// in by rewriting this file alone.
//
//   cameraSend(stream, room, key)   the presenter's camera is open: start
//                                   sending it to room (or swap to this
//                                   stream if already sending). key is the
//                                   page's login (a promise of it, as main.js
//                                   holds it, or '' where there is none), for
//                                   a relay that asks who may send.
//   cameraStopSending()             the camera closed: stop, and free all.
//   cameraWatch(room, fn)           a follower: call fn(stream) whenever the
//                                   presenter's video arrives or changes, and
//                                   fn(null) when it goes.
//   cameraUnwatch()                 stop watching.
//
// The shape handed across, on both sides, is a MediaStream. That is what the
// browser's camera gives (getUserMedia), what WebRTC gives a receiver
// (RTCPeerConnection's ontrack, Luminara's view.html), and what a <video>
// plays with the browser's own pacing, aspect and compositing, which is the
// panel's whole job (platform/camera-panel.js). The other proof of concept,
// frames through a relay (video-broadcast-testing/), decodes to VideoFrames;
// its receiver would draw each onto a small canvas and hand over
// canvas.captureStream(), which every browser that can decode them offers.
// That is one copy of a picture a few hundred pixels across, a small price
// for a panel that never needs to know which transport fed it. Frames as the
// common shape would have gone the other way: every WebRTC picture turned
// into a VideoFrame by hand, and a panel drawn by the engine, which a DOM
// <video> does not need.
//
// This version is LOCAL ONLY: nothing is sent and nothing arrives. The
// presenter's panel shows the laptop's own camera straight from
// getUserMedia (platform/camera-input.js), so on the presenting page it
// looks exactly as it will; a viewer's page has no source and shows no
// panel, while the switch and the size already reach it (core/broadcast.js
// `cv`), waiting for a picture to apply to.

let watching = null;

export function cameraSend(stream, room, key) {
  // local only: the stream stays on this page
  void stream; void room; void key;
}

export function cameraStopSending() {}

export function cameraWatch(room, fn) {
  watching = { room, fn };
  // local only: no presenter's video ever arrives
}

export function cameraUnwatch() {
  watching = null;
}

// Which transport this file is, for the console and diagnostics.
export const CAMERA_TRANSPORT = 'local';
export const cameraWatching = () => !!watching;
