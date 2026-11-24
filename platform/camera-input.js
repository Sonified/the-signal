// Live Video's camera: opened while the drawer's switch is on, closed when it
// goes off. The lifecycle and its wording follow Live Sound's microphone
// (js/livesound.js), which solved each of these first.
//
// The camera is opened when the switch goes on, and switching it off stops
// its tracks, so the browser's camera light goes out with it. The switch is
// saved with this machine's other Live Video settings (core/camera.js,
// never in a preset or a step), so a reload that finds it on opens the
// camera again at boot, asking the browser as before if it has no standing
// grant. A refusal, a missing camera, or one that ends on its own (unplugged,
// or permission taken back in the browser's settings) fails soft: a warning
// in the console, the switch back to off, and the next switch on asks again.
//
// Video only: Live Sound is the microphone. The picture is asked for at up
// to 1280 by 720, which covers the panel at its largest on a laptop; the
// camera's own shape comes through as it is (the panel keeps it).
//
// Page thread only. main.js loads this in the engine's worker too, where
// there is no camera, so nothing here runs until the page asks.
import { S } from '../js/state.js';
import { camFailed, camSetInputs } from '../core/camera.js';

const media = () => (typeof navigator !== 'undefined' && navigator.mediaDevices) || null;

let stream = null;     // the camera showing now
let token = 0;         // the newest request; an older one landing late is dropped
let busy = false;      // a request is waiting on the browser
const listeners = [];

function constraints(deviceId) {
  const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  return { audio: false, video };
}

function stopStream(s) {
  if (!s) return;
  for (const t of s.getTracks()) { try { t.stop(); } catch (e) {} }
}

function hand(s) {
  for (let i = 0; i < listeners.length; i++) {
    try { listeners[i](s); } catch (e) { console.warn('live video: a listener failed', e); }
  }
}

// Everything closed: the camera stopped, any request still out dropped when
// it lands.
function shut() {
  ++token;
  busy = false;
  if (!stream) return;
  const s = stream;
  stream = null;
  hand(null);
  stopStream(s);
}

// Soft: the switch reads off again, the camera is closed, and the next
// switch on asks again.
function failed(err) {
  console.warn('live video: could not open the camera' +
    (err && err.name ? ' (' + err.name + (err.message ? ': ' + err.message : '') + ')' : ''), err);
  shut();
  camFailed();
}

// Opens the chosen camera (or the default) and hands it on. A new camera
// replaces the old one, which then stops, so a change of camera is a swap.
async function acquire() {
  const md = media();
  if (!md || !md.getUserMedia) { failed(new Error('this browser offers no camera here')); return; }
  const my = ++token;
  busy = true;
  const want = S.camDevice || '';
  let s = null, error = null;
  try { s = await md.getUserMedia(constraints(want)); }
  catch (err) { error = err; }
  // A chosen camera that is not there (unplugged, or an id saved by another
  // browser) falls back to the default rather than leaving the panel dark.
  if (!s && want && error && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
    try { s = await md.getUserMedia(constraints('')); error = null; }
    catch (err) { error = err; }
  }
  if (my !== token) { stopStream(s); return; }
  busy = false;
  if (!s) { failed(error); return; }
  if (!S.camOn) { stopStream(s); return; }
  const old = stream;
  stream = s;
  const track = s.getVideoTracks()[0];
  if (track) track.addEventListener('ended', () => {
    if (stream !== s) return;
    failed(new Error('the camera ended'));
  });
  hand(s);
  stopStream(old);
  // Names are blank until the first grant, so the list is read again now.
  refreshCameras();
}

// core/camera.js's open, close and reopen (setCamRole's hooks).
export function cameraOpen() { if (!stream && !busy) acquire(); }
export function cameraClose() { shut(); }
export function cameraReopen() { if (stream || busy) acquire(); }

// The camera showing now, or null.
export const cameraStream = () => stream;
// Called with the camera's stream whenever one opens or is swapped, and
// with null when it closes or fails.
export function onCameraStream(fn) { listeners.push(fn); }

// ---------- the cameras ----------
// As Live Sound's inputs: the browser's list of video inputs for the
// drawer's Camera row, blank entries left out (before any grant most
// browsers hand back blank ids and labels, so the list is empty until then).
let known = [];
function same(next) {
  if (next.length !== known.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i].id !== known[i].id || next[i].label !== known[i].label) return false;
  }
  return true;
}
export function refreshCameras() {
  const md = media();
  if (!md || !md.enumerateDevices) return;
  md.enumerateDevices().then(list => {
    const next = [];
    for (const d of list) {
      if (d.kind !== 'videoinput' || !d.deviceId) continue;
      next.push({ id: d.deviceId, label: d.label || 'Camera ' + (next.length + 1) });
    }
    if (same(next)) return;
    known = next;
    camSetInputs(next);
  }, () => {});
}
// Read now (with a grant from an earlier visit the names are already there)
// and again whenever something is plugged in or pulled out. Called once,
// by the page (platform/camera-panel.js startCamera).
let watchingDevices = false;
export function watchCameras() {
  refreshCameras();
  const md = media();
  if (watchingDevices || !md) return;
  watchingDevices = true;
  try { md.addEventListener('devicechange', refreshCameras); } catch (e) {}
}
