// Live Video's state: whether the camera panel shows, how big it is, and who
// gets to say so. The camera itself (platform/camera-input.js), the panel
// (platform/camera-panel.js) and the way a picture reaches other screens
// (platform/camera-transport.js) all read and write through here, so this
// file is the one truth and holds no DOM.
//
// Two values: the switch (S.camOn) and the size (S.camSize), plus the
// camera chosen (S.camDevice). They are this machine's, the way Live Sound's
// are, and for the same reasons: a preset recall, a Journey step, a cue
// jump or another tab must never turn the presenter's camera on or off or
// change its size. So they live in a record of their own (signal.v1.camera,
// through store.js readKey/saveKey, never in the shared settings object or
// the extra record, both of which are the snapshot), and their controls sit
// in a section presets.js machineControl names, which keeps them out of
// every replay, step and followed glide.
//
// Unlike Live Sound's, the switch and the size do reach followers: a viewer
// of ?livestream sees the panel appear, go and change size with the
// presenter's. They ride beside the snapshot in the broadcast's state
// message (core/broadcast.js, as `cv`: camWire on the broadcaster,
// takeCamWire on a follower), never inside it, and a follower keeps them in
// memory only (followOn, followSize below), so its own record, and its own
// settings for anything else, are never touched. The camera's id never
// travels: it means nothing on another machine.
//
// The size is the panel's HEIGHT as a share of the screen's SHORTER side.
// The talk is watched on landscape screens (the laptop, the projector, the
// viewers' own laptops), where the shorter side is the height, so 25% is a
// quarter of the screen's height on every one of them whatever its pixels.
// On a phone held upright the shorter side is the width, so the panel keeps
// the same proportion to the screen's width and to a slide letterboxed
// across it, instead of growing to a quarter of a tall screen and covering
// the slide. The panel's width follows from the camera's own shape, never
// stretched or cropped (ui/camera-fit.js lays it out).
import { S } from '../js/state.js';
import { readKey, saveKey } from './store.js';

// The Size slider's range, as shares (0.1 is 10%). Below a tenth the face is
// a thumbnail; above six tenths the panel is the show.
export const CAM_SIZE_MIN = 0.1, CAM_SIZE_MAX = 0.6, CAM_SIZE_DEF = 0.25;

// A size held to the slider's range, three decimals at most (what the wire
// carries); anything unreadable is the default.
export function camSizeClamp(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return CAM_SIZE_DEF;
  const c = v < CAM_SIZE_MIN ? CAM_SIZE_MIN : v > CAM_SIZE_MAX ? CAM_SIZE_MAX : v;
  return Math.round(c * 1000) / 1000;
}

// ---------- this machine's record ----------
const CAM_KEY = 'signal.v1.camera';
export function saveCam() {
  saveKey(CAM_KEY, { camOn: !!S.camOn, camSize: camSizeClamp(S.camSize), camDevice: typeof S.camDevice === 'string' ? S.camDevice : '' });
}
// Read once at boot (platform/camera-panel.js startCamera), after the store
// has its storage. A browser that never had one starts off, at the default.
export function loadCam() {
  let x;
  try { x = JSON.parse(readKey(CAM_KEY) || 'null'); } catch (e) { x = null; }
  S.camOn = !!(x && x.camOn === true);
  S.camSize = camSizeClamp(x ? x.camSize : undefined);
  S.camDevice = x && typeof x.camDevice === 'string' ? x.camDevice : '';
}

// ---------- the page's part ----------
// What this page is, told once at boot: a presenting page (?presentation)
// may resize the panel by hand; a follower (?follow=, ?livestream) never
// opens a camera and shows the broadcaster's switch and size, not its own.
// Every other page is plain: its own switch and size, no hand resize.
export const ROLE_PLAIN = 0, ROLE_PRESENT = 1, ROLE_FOLLOW = 2;
let role = ROLE_PLAIN;
// The camera, handed in by the page (platform/camera-panel.js): open() and
// close(), both safe to call twice. None in the engine's worker, in a node
// test, or on the standing playback, and the drawer's section hides there.
let input = null;
export function setCamRole(r, inputHooks) {
  role = r === ROLE_PRESENT || r === ROLE_FOLLOW ? r : ROLE_PLAIN;
  input = inputHooks || null;
}
export const camRole = () => role;
// The drawer shows the section where a camera can be opened from it.
export const camAvailable = () => !!input && role !== ROLE_FOLLOW;
export const camResizable = () => role === ROLE_PRESENT;

// Whoever wants to hear that anything here moved: the panel, and the
// broadcaster's send (core/broadcast.js, queueSend). Called with nothing.
const listeners = [];
export function onCamChange(fn) { listeners.push(fn); }
function changed() {
  for (let i = 0; i < listeners.length; i++) {
    try { listeners[i](); } catch (e) { console.warn('live video: a listener failed', e); }
  }
}

// The switch, from the drawer (core/schema-camera.js) or a refusal.
export function camSetOn(on) {
  S.camOn = !!on;
  applyCamOn();
  saveCam();
  changed();
}
export function applyCamOn() {
  if (!input || role === ROLE_FOLLOW) return;
  if (S.camOn) input.open(); else input.close();
}
// A refusal, a missing camera or a camera that ended fails soft: the
// switch reads off again and the next switch on asks again
// (platform/camera-input.js has already warned).
export function camFailed() {
  if (!S.camOn) return;
  S.camOn = false;
  saveCam();
  changed();
}
// The size, from the drawer's slider or the presenter's hand on the panel.
export function camSetSize(v) {
  const next = camSizeClamp(v);
  if (next === S.camSize) return;
  S.camSize = next;
  saveCam();
  changed();
}
// A new camera chosen: while on, it is opened at once and the panel takes
// its picture as the old camera stops.
export function camSetDevice(id) {
  S.camDevice = typeof id === 'string' ? id : '';
  saveCam();
  if (input && S.camOn && role !== ROLE_FOLLOW) input.reopen();
}

// The cameras the browser lists, [{ id, label }], kept current by the page
// (platform/camera-input.js) for the drawer's Camera row: empty until the
// first grant, since browsers hide them until then. A new array whenever it
// changes, the same one otherwise, so the row notices by identity.
let inputs = [];
export const camInputs = () => inputs;
export function camSetInputs(list) { inputs = list; }

// ---------- the broadcast's part ----------
// The broadcaster's switch and size for the state message, built at each
// send (a few a second at most, never per frame).
export function camWire() {
  return { on: S.camOn ? 1 : 0, sz: camSizeClamp(S.camSize) };
}
// A follower's copy of the broadcaster's, in memory only. A state with no
// `cv` (a broadcaster from before Live Video) or an ended broadcast is off,
// keeping the last size so a panel coming back comes back as it was.
let followOn = false, followSize = CAM_SIZE_DEF;
export function takeCamWire(x) {
  const on = !!(x && typeof x === 'object' && x.on === 1);
  const size = x && typeof x === 'object' && typeof x.sz === 'number' ? camSizeClamp(x.sz) : followSize;
  if (on === followOn && size === followSize) return;
  followOn = on;
  followSize = size;
  changed();
}

// ---------- what the panel shows ----------
// The switch and the size the panel follows on this page: the
// broadcaster's on a follower, this machine's everywhere else.
export const camShownOn = () => role === ROLE_FOLLOW ? followOn : !!S.camOn;
export const camShownSize = () => role === ROLE_FOLLOW ? followSize : camSizeClamp(S.camSize);

// The drawer's open width (ui/screens/drawer.js stepDrawer, S.edgeInset),
// handed on to the panel only when it moves, so the panel steps aside from
// the drawer as the scene does. Called every frame the drawer steps: one
// comparison while it rests.
let inset = 0, insetFn = null;
export function camInset(px) {
  if (px === inset) return;
  inset = px;
  if (insetFn) insetFn(px);
}
export function onCamInset(fn) { insetFn = fn; }
export const camInsetNow = () => inset;
