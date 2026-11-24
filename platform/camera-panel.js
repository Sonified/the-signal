// Live Video's panel: the presenter's camera in the bottom left corner of the
// screen, on the presenting page and on every page following it, at the size
// the presenter set (core/camera.js). On a presenting page its inner corner
// (the top right, pointing into the screen) drags to resize it, and the
// drawer's Size slider follows; viewers cannot resize it.
//
// It is a DOM <video> laid over the canvas, the one standing exception to
// "no DOM over the canvas" besides the join gate and the login card, and it
// is one for these reasons. Both transports hand over a MediaStream
// (platform/camera-transport.js), and a <video> plays one with the browser's
// own pacing and decoding, its shape known from the element, with nothing
// drawn by the engine. Drawn in the scene instead, the picture would need
// the engine's frame graph opened up (a new texture import beside gpu/
// slides.js, in the pass the blur capture reads), it would keep the frame
// loop awake at the camera's rate where the loop now rests, and it would
// arrive in the frosted glass whenever a window is open. As a <video> it
// costs the engine nothing at all: no frame, no capture, no wake, and the
// chrome's idle fade never hears of it. The panel sits over the canvas and
// under the first-light loader, the join gate and the login card (z-index
// below each), and lets every press but its own corner's through to the
// canvas, so a tap on a viewer's picture reaches the field as it always did.
//
// Its layout is ui/camera-fit.js's: anchored bottom left at the chrome's
// inset, kept clear of the corner controls, stepped right while the drawer
// is open. The step is one CSS transform that glides over the drawer's own
// slide, set when the drawer opens or shuts, so the frame loop that slides
// the drawer writes no style and builds no string here.
//
// Nothing is made until the panel first shows, and while it is hidden the
// <video> holds no stream, so a switch left off costs nothing.
import { S } from '../js/state.js';
import {
  ROLE_PLAIN, ROLE_PRESENT, ROLE_FOLLOW, setCamRole, loadCam, applyCamOn, onCamChange, onCamInset, camInsetNow,
  camShownOn, camShownSize, camResizable, camSetSize
} from '../core/camera.js';
import { camFit, camSizeForHand } from '../ui/camera-fit.js';
import { LAYOUT, HIT, RADIUS, GLASS, MOTION } from '../ui/theme.js';
import { cameraOpen, cameraClose, cameraReopen, onCameraStream, watchCameras } from './camera-input.js';
import { cameraSend, cameraStopSending, cameraWatch } from './camera-transport.js';

const EDGE = LAYOUT.chromeInset;
// Over the canvas and the join's still frame (main.js, 500 would cover it
// while that fades, which is fine); under first light (900), the join gate
// (1000) and the login card (1100).
const Z = 400;
// How long the step beside the drawer glides: about the drawer's own slide
// on its panel spring (MOTION.panel, near critical, settled in a quarter
// second or so).
const SLIDE_MS = Math.round(1000 * 6 / Math.sqrt(MOTION.panel.stiffness));

let started = false;
let el = null, video = null, grip = null;
let source = null;          // the MediaStream to show, or null
let aspect = 0;             // the picture's width over its height, 0 unknown
let shown = false;
let lastW = -1, lastH = -1, lastShift = -1;
const rect = { x: 0, y: 0, w: 0, h: 0 };

// The page's one call (main.js, page thread, once the store has loaded):
//   presenting  this page is ?presentation: the panel's corner resizes it
//   sendRoom    the room the camera goes to (the presentation's livestream
//               room), '' to send nowhere
//   sendKey     the login's password, or a promise of it, for the transport
//   watchRoom   on a follower, the room it follows: the panel shows the
//               broadcaster's video, switch and size, and no camera opens
export function startCamera(opts) {
  if (started || typeof document === 'undefined' || typeof window === 'undefined') return;
  started = true;
  const o = opts || {};
  const following = !!o.watchRoom;
  loadCam();
  setCamRole(following ? ROLE_FOLLOW : o.presenting ? ROLE_PRESENT : ROLE_PLAIN,
             following ? null : { open: cameraOpen, close: cameraClose, reopen: cameraReopen });
  onCamChange(update);
  onCamInset(update);
  window.addEventListener('resize', update);
  if (following) {
    cameraWatch(o.watchRoom, setSource);
    return;
  }
  const sendRoom = typeof o.sendRoom === 'string' ? o.sendRoom : '';
  onCameraStream(s => {
    setSource(s);
    if (!sendRoom) return;
    if (s) cameraSend(s, sendRoom, o.sendKey || '');
    else cameraStopSending();
  });
  watchCameras();
  // A switch the saved record found on opens the camera now, as Live Sound's
  // does (restoreLive), asking the browser as before if it has no grant.
  applyCamOn();
}

function setSource(s) {
  source = s || null;
  aspect = 0;
  if (source) {
    const t = source.getVideoTracks ? source.getVideoTracks()[0] : null;
    const st = t && t.getSettings ? t.getSettings() : null;
    if (st && st.width > 0 && st.height > 0) aspect = st.width / st.height;
    else if (st && st.aspectRatio > 0) aspect = st.aspectRatio;
  }
  update();
}

// The picture's own shape, once the element knows it, and again if it
// changes (a camera swapped, a phone turned).
function readAspect() {
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    const a = video.videoWidth / video.videoHeight;
    if (Math.abs(a - aspect) > 1e-3) { aspect = a; update(); }
  }
}

function build() {
  if (el) return;
  const style = document.createElement('style');
  style.textContent =
    '#live-video{position:fixed;left:' + EDGE + 'px;bottom:' + EDGE + 'px;z-index:' + Z + ';display:none;' +
    'pointer-events:none;overflow:hidden;background:#000;border-radius:' + RADIUS.md + 'px;' +
    'box-shadow:0 2px ' + GLASS.shadow + 'px rgba(0,0,0,' + GLASS.shadowAlpha + ');' +
    'transition:transform ' + SLIDE_MS + 'ms cubic-bezier(.2,.8,.2,1);-webkit-user-select:none;user-select:none}' +
    '#live-video video{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}' +
    '#live-video .grip{position:absolute;top:0;right:0;pointer-events:auto;touch-action:none;cursor:nesw-resize}' +
    '#live-video .grip::after{content:"";position:absolute;top:6px;right:6px;width:12px;height:12px;' +
    'border-top:2px solid rgba(232,237,242,.85);border-right:2px solid rgba(232,237,242,.85);' +
    'border-top-right-radius:4px;opacity:0;transition:opacity .2s ease}' +
    '#live-video .grip:hover::after,#live-video .grip.held::after{opacity:1}' +
    '@media (pointer:coarse){#live-video .grip::after{opacity:.6}}';
  document.head.appendChild(style);
  el = document.createElement('div');
  el.id = 'live-video';
  el.setAttribute('aria-hidden', 'true');
  video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.addEventListener('loadedmetadata', readAspect);
  video.addEventListener('resize', readAspect);
  el.appendChild(video);
  if (camResizable()) {
    grip = document.createElement('div');
    grip.className = 'grip';
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
    const g = coarse ? HIT.touch : HIT.mouse;
    grip.style.width = g + 'px';
    grip.style.height = g + 'px';
    wireGrip(grip);
    el.appendChild(grip);
  }
  document.body.appendChild(el);
}

function hide() {
  if (!el) return;
  if (shown) { el.style.display = 'none'; shown = false; }
  if (video.srcObject) video.srcObject = null;
}

// Lays the panel out from the truth in core/camera.js; called on any change
// there, a new picture, a resize of the window, and the drawer opening or
// shutting. Writes a style only where a value moved.
function update() {
  if (!camShownOn() || !source) { hide(); return; }
  build();
  // The drawer's final open width while it is opening or open, 0 while it
  // shuts or is shut: the transform glides there over the slide.
  const shift = S.panelOpen && camInsetNow() > 0 ? LAYOUT.drawerW : 0;
  if (!camFit(rect, camShownSize(), aspect, window.innerWidth, window.innerHeight, shift)) { hide(); return; }
  if (rect.w !== lastW || rect.h !== lastH) {
    lastW = rect.w; lastH = rect.h;
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
  }
  if (shift !== lastShift) {
    lastShift = shift;
    el.style.transform = shift ? 'translateX(' + shift + 'px)' : 'none';
  }
  if (video.srcObject !== source) {
    video.srcObject = source;
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  }
  if (!shown) { el.style.display = 'block'; shown = true; }
}

// The presenter's hand on the inner corner. Where it took hold is kept, so
// the corner does not jump to the pointer; each move asks ui/camera-fit.js
// for the size that corner means and sets it through core/camera.js, which
// saves it, moves the drawer's slider and tells the broadcast.
function wireGrip(g) {
  let id = -1, offX = 0, offY = 0;
  g.addEventListener('pointerdown', e => {
    if (id !== -1) return;
    e.preventDefault();
    e.stopPropagation();
    id = e.pointerId;
    try { g.setPointerCapture(id); } catch (err) {}
    g.classList.add('held');
    const left = EDGE + (lastShift > 0 ? lastShift : 0);
    offX = (left + rect.w) - e.clientX;
    offY = (window.innerHeight - EDGE - rect.h) - e.clientY;
  });
  g.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    e.preventDefault();
    const shift = lastShift > 0 ? lastShift : 0, vh = window.innerHeight;
    const handW = e.clientX + offX - (EDGE + shift);
    const handH = (vh - EDGE) - (e.clientY + offY);
    camSetSize(camSizeForHand(handW, handH, aspect, window.innerWidth, vh, shift));
  });
  const end = e => {
    if (e.pointerId !== id) return;
    id = -1;
    g.classList.remove('held');
    try { g.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
}
