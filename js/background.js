// Keeping the generated sound playing with the screen locked, which on an
// iPhone takes three things at once.
//
// The audio session. Safari treats a page that only plays Web Audio as
// ambient sound: the ring switch silences it and a locked screen suspends
// it. Asking for 'playback' makes it media, like a music app. The type is
// read as the session starts, so it is set before the first AudioContext
// exists (js/audio.js ensureAudioGraph).
//
// A media element. iOS keeps a page's audio alive in the background only
// while the page is playing media, and an AudioContext alone does not count.
// So a silent loop plays beside it: one second of digital silence, a WAV
// built here as a blob URL, never muted (a muted element is not playing
// media as far as iOS is concerned). Its first play() must happen inside a
// user gesture, before anything awaits, so js/audio.js warmDevice starts it
// on the gesture that wakes the sound; from then on it follows the
// transport (applyAudioGain), playing while the session runs and pausing
// with it, so a paused session lets the phone sleep.
//
// Media Session. The lock screen, a headset's button and a keyboard's media
// keys show the title and send play and pause, which go to the app's own
// transport (setMediaTransport, from main.js), so pausing from the lock
// screen is exactly the space bar. playbackState is kept in step.
//
// Every piece is feature detected and fails silently: a desktop browser
// that has none of this simply carries on as before.

// The working title, as the lock screen and the media controls show it.
const TITLE = 'The Signal';

let loop = null;         // the silent element, made on the first gesture
let want = false;        // whether the transport is running
let transport = null;    // the app's run(on), for Media Session's play and pause
let wake = null;         // resumes the AudioContext, for Media Session's play

// Before the AudioContext is created.
export function prepareAudioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) {}
}

// Synchronously, inside the gesture that starts the sound. Plays the loop
// once to unlock it; if the transport is not running by the time playback
// actually begins (the gesture was a tap that woke the sound without
// starting the session), it is paused again, and later play() calls need no
// gesture of their own.
export function startBackgroundKeepAlive() {
  if (!loop) loop = makeLoop();
  if (!loop || !loop.paused) return;
  play();
  try {
    if (navigator.mediaSession && typeof MediaMetadata === 'function') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: TITLE });
    }
  } catch (e) {}
}

// Follows the transport: playing while the session runs, paused when it is
// paused. Cheap to call again with the same state.
export function setBackgroundPlaying(on) {
  want = !!on;
  try {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = want ? 'playing' : 'paused';
  } catch (e) {}
  if (!loop) return;
  if (want) { if (loop.paused) play(); }
  else if (!loop.paused) loop.pause();
}

// Hands Media Session's play and pause to the app's transport: run(true)
// asks it to start, run(false) to stop, and it ignores a request for the
// state it is already in.
export function setMediaTransport(run) {
  transport = run;
  const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
  if (!ms) return;
  try { ms.setActionHandler('play', () => { if (wake) wake(); if (transport) transport(true); }); } catch (e) {}
  try { ms.setActionHandler('pause', () => { if (transport) transport(false); }); } catch (e) {}
}

// How Media Session's play wakes the sound. The lock screen's play is the
// only gesture there is while the screen is locked, and the AudioContext iOS
// suspended there does not resume with the transport, so it is resumed in
// the same handler (js/audio.js hands this its resume).
export function setMediaWake(fn) { wake = fn; }

// A play() refused (no gesture yet, or a pause() that landed first) is left
// alone: the next gesture or the next start of the transport tries again.
function play() {
  try {
    const p = loop.play();
    if (p) p.then(() => { if (!want) loop.pause(); }, () => {});
  } catch (e) {}
}

function makeLoop() {
  try {
    if (typeof Audio !== 'function' || typeof Blob !== 'function') return null;
    const el = new Audio();
    el.setAttribute('playsinline', '');
    el.loop = true;
    el.preload = 'auto';
    el.src = URL.createObjectURL(silentWav());
    return el;
  } catch (e) {
    return null;
  }
}

// One second of mono 16-bit PCM at 8 kHz, every sample zero: the smallest
// honest WAV, about 16 KB.
function silentWav() {
  const rate = 8000, bytes = rate * 2;
  const v = new DataView(new ArrayBuffer(44 + bytes));
  const tag = (at, s) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // one channel
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);    // bytes a second
  v.setUint16(32, 2, true);           // bytes a frame
  v.setUint16(34, 16, true);          // bits a sample
  tag(36, 'data'); v.setUint32(40, bytes, true);
  return new Blob([v.buffer], { type: 'audio/wav' });
}
