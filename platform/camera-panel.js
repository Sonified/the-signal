// Live Video's panel: the presenter's camera in the bottom right corner of
// the screen, stacked above the full-screen button's row as a video player or
// a call places its picture, on the presenting page and on every page
// following it, at the size the presenter set (core/camera.js). On a
// presenting page its inner corner (the top left, pointing into the screen)
// drags to resize it, and the drawer's Size slider follows; viewers cannot
// resize it.
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
// Its layout is ui/camera-fit.js's: its right edge on the full-screen
// button's, its bottom a chip gap above the bottom row, kept clear of the top
// row and of the open drawer. The drawer opens from the left, so it meets
// the panel only where the screen is narrow (a phone, or the panel at its
// largest on a small window): there the panel shrinks to stay clear of the
// drawer's edge, or goes while the drawer fills the screen, and comes back as
// it shuts. Nothing slides aside. The bound is the drawer's final
// width, taken when it opens or shuts (not each frame of its slide), so the
// frame loop that slides the drawer writes no style and builds no string here.
//
// Nothing is made until the panel first shows, and while it is hidden the
// <video> holds no stream, so a switch left off costs nothing.
import { S } from '../js/state.js';
import {
  ROLE_PLAIN, ROLE_PRESENT, ROLE_FOLLOW, setCamRole, loadCam, applyCamOn, onCamChange, onCamInset, camInsetNow,
  camShownOn, camShownSize, camResizable, camSetSize
} from '../core/camera.js';
import { camFit, camSizeForHand, camRightOf, camBottomOf } from '../ui/camera-fit.js';
import { LAYOUT, HIT, RADIUS, GLASS } from '../ui/theme.js';
import { cameraOpen, cameraClose, cameraReopen, onCameraStream, watchCameras } from './camera-input.js';
import { cameraSend, cameraStopSending, cameraWatch } from './camera-transport.js';

// Over the canvas; under the join's still frame (main.js, 500, which covers
// it for the moment that fades), first light (900), the join gate (1000) and
// the login card (1100).
const Z = 400;

let started = false;
let el = null, video = null, grip = null;
let source = null;          // the MediaStream to show, or null
let aspect = 0;             // the picture's width over its height, 0 unknown
let shown = false;
let lastW = -1, lastH = -1, lastRight = -1, lastBottom = -1, lastLeft = 0;
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
    '#live-video{position:fixed;z-index:' + Z + ';display:none;' +
    'pointer-events:none;overflow:hidden;background:#000;border-radius:' + RADIUS.md + 'px;' +
    'box-shadow:0 2px ' + GLASS.shadow + 'px rgba(0,0,0,' + GLASS.shadowAlpha + ');-webkit-user-select:none;user-select:none}' +
    '#live-video video{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}' +
    '#live-video .grip{position:absolute;top:0;left:0;pointer-events:auto;touch-action:none;cursor:nwse-resize}' +
    '#live-video .grip::after{content:"";position:absolute;top:6px;left:6px;width:12px;height:12px;' +
    'border-top:2px solid rgba(232,237,242,.85);border-left:2px solid rgba(232,237,242,.85);' +
    'border-top-left-radius:4px;opacity:0;transition:opacity .2s ease}' +
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
  // shuts or is shut: the bound the panel keeps clear of.
  const vw = window.innerWidth, vh = window.innerHeight;
  lastLeft = S.panelOpen && camInsetNow() > 0 ? LAYOUT.drawerW : 0;
  if (!camFit(rect, camShownSize(), aspect, vw, vh, lastLeft)) { hide(); return; }
  if (rect.w !== lastW || rect.h !== lastH) {
    lastW = rect.w; lastH = rect.h;
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
  }
  // pinned by its right edge and its bottom, so a resize grows it up and left
  const right = vw - camRightOf(vw), bottom = vh - camBottomOf(vh);
  if (right !== lastRight || bottom !== lastBottom) {
    lastRight = right; lastBottom = bottom;
    el.style.right = right + 'px';
    el.style.bottom = bottom + 'px';
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
    // the panel's top left corner, as laid out, against the pointer
    offX = rect.x - e.clientX;
    offY = rect.y - e.clientY;
  });
  g.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    e.preventDefault();
    camSetSize(camSizeForHand(e.clientX + offX, e.clientY + offY, aspect, window.innerWidth, window.innerHeight, lastLeft));
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
