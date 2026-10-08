// Keeping the generated sound playing with the screen locked, which on an
// iPhone takes three things at once.
//
// The audio session. Safari treats a page that only plays Web Audio as
// ambient sound: the ring switch silences it and a locked screen suspends
// it. Asking for 'playback' makes it media, like a music app. The type is
// read as the session starts, so it is set before the first AudioContext
// exists (js/audio.js ensureAudioGraph), and set again before every resume,
// on every gesture and whenever the page comes back into view, since a
// call, Siri or another app taking the sound can leave the session to be
// started over. While Live Sound holds the microphone it is
// 'play-and-record' instead (setAudioSessionRecording, js/livesound.js):
// 'playback' cannot record, and the record type ignores the ring switch too.
//
// A media element. iOS keeps a page's audio alive in the background only
// while the page is playing media, and an AudioContext alone does not count.
// On an iPhone too old for navigator.audioSession it is also the only thing
// that lifts Web Audio out of ambient sound, so with the ring switch on
// silent the sound plays exactly while this does. So a silent loop plays
// beside it: one second of digital silence, a WAV built here as a blob URL,
// never muted (a muted element is not playing media as far as iOS is
// concerned). Its first play() must happen inside a user gesture, so
// js/audio.js warmDevice starts it on the gesture that wakes the sound, and
// every later gesture plays it again if it should be playing and is not
// (the app reads its taps in the frame loop, outside the gesture, so the
// real gesture is caught here, on the document). From then on it plays
// while anything can be heard (js/audio.js followBackground): the transport
// running with the sound on, and a pause's tails ringing out. Once the
// master has closed it pauses, so a paused session lets the phone sleep.
//
// Media Session. The lock screen, a headset's button and a keyboard's media
// keys show the title and send play and pause, which go to the app's own
// transport (setMediaTransport, from main.js), so pausing from the lock
// screen is exactly the space bar. playbackState follows the transport.
//
// Every piece is feature detected and fails silently: a desktop browser
// that has none of this simply carries on as before.

// The working title, as the lock screen and the media controls show it.
const TITLE = 'The Signal';

let loop = null;         // the silent element, made on the first gesture that wakes the sound
let want = false;        // whether the loop should be playing: something can be heard
let unlocked = false;    // whether a play() has ever gone through, so later ones need no gesture
let hold = 0;            // the timer that pauses the loop once a pause's tails have rung out
let recording = false;   // whether Live Sound holds the microphone
let transport = null;    // the app's run(on), for Media Session's play and pause
let wake = null;         // resumes the AudioContext, for Media Session's play and a gesture

// Before the AudioContext is created, and again before anything resumes it.
// Setting the type it already has changes nothing.
export function prepareAudioSession() {
  try {
    const s = navigator.audioSession;
    const type = recording ? 'play-and-record' : 'playback';
    if (s && s.type !== type) s.type = type;
  } catch (e) {}
}

// Live Sound, before it asks for the microphone (on) and once the input is
// closed (off).
export function setAudioSessionRecording(on) {
  recording = !!on;
  prepareAudioSession();
}

// Synchronously, inside the gesture that starts the sound. Plays the loop
// once to unlock it; if nothing is to be heard by the time playback actually
// begins (the gesture was a tap that woke the sound without starting the
// session), it is paused again, and later play() calls need no gesture of
// their own.
export function startBackgroundKeepAlive() {
  prepareAudioSession();
  if (!loop) loop = makeLoop();
  if (!loop || !loop.paused) return;
  play();
  try {
    if (navigator.mediaSession && typeof MediaMetadata === 'function') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: TITLE });
    }
  } catch (e) {}
}

// Media Session's state follows the transport (running); the loop follows
// whether anything can be heard (audible), and after a pause keeps playing
// for ringS more seconds, while the tails ring out, before it pauses. Cheap
// to call again with the same state.
export function setBackgroundPlaying(running, audible = running, ringS = 0) {
  try {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = running ? 'playing' : 'paused';
  } catch (e) {}
  clearTimeout(hold);
  hold = 0;
  if (!audible && want && ringS > 0) {
    hold = setTimeout(() => { hold = 0; setLoop(false); }, ringS * 1000);
    return;
  }
  setLoop(!!audible);
}

function setLoop(on) {
  want = on;
  if (!loop) return;
  if (want) {
    prepareAudioSession();
    if (loop.paused) play();
    // a context an interruption left suspended has nothing else to start it
    if (wake) wake();
  } else if (!loop.paused) loop.pause();
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

// Every gesture, caught on the document as it happens: once the app has
// woken the sound, a loop that should be playing and is not (refused
// outside a gesture, or stopped by an interruption) plays again, and the
// context is resumed, both inside the gesture where iOS allows them. A loop
// whose first play was refused is unlocked here too, played and paused
// again at once if nothing is to be heard. Otherwise, while nothing is
// meant to be heard, it leaves both alone, so a tap on a paused session
// never takes the sound from another app.
function onGesture() {
  if (!loop || (!want && unlocked)) return;
  prepareAudioSession();
  if (loop.paused) play();
  if (want && wake) wake();
}

// Back in view (or back from the page cache): the same, without a gesture,
// which iOS may refuse; the next gesture then tries again.
function onShown() {
  if (typeof document !== 'undefined' && document.hidden) return;
  onGesture();
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  const opts = { capture: true, passive: true };
  for (const type of ['touchend', 'pointerup', 'click', 'keydown']) {
    document.addEventListener(type, onGesture, opts);
  }
  document.addEventListener('visibilitychange', onShown);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pageshow', onShown);
  }
}

// A play() refused (no gesture yet, or a pause() that landed first) is left
// alone: the next gesture or the next start of the transport tries again.
function play() {
  try {
    const p = loop.play();
    if (p) p.then(() => { unlocked = true; if (!want) loop.pause(); }, () => {});
    else unlocked = true;
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
