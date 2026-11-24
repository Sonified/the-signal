// The drawer's Live Video section (core/camera.js): the presenter's camera
// as a panel in the corner of every screen watching, and how big it is.
// Named for its neighbour, Live Sound, which is the same thing for a
// microphone: an input of this machine's, switched on here.
//
// Every set() goes through core/camera.js, which saves the record of its own
// (signal.v1.camera) rather than the shared settings: the section's name is
// one presets.js machineControl lists, so no preset, Journey step, followed
// glide or other tab's replay ever moves these rows. What followers see
// rides beside the snapshot instead (core/broadcast.js `cv`).
//
// The section shows only where a camera can be opened from it: on the page
// thread of a page that is not following (camAvailable). A follower's panel
// follows the broadcaster and offers nothing to change; the engine's worker
// has no camera; and ?livestream never draws the drawer at all.
import { S } from '../js/state.js';
import {
  CAM_SIZE_MIN, CAM_SIZE_MAX, CAM_SIZE_DEF, camSizeClamp, camSetOn, camSetSize, camSetDevice, camInputs, camAvailable
} from './camera.js';

// The Camera row's options, a getter over the page's list as Live Sound's
// Input row is (core/schema-audio.js liveDeviceOptions): the same array while
// the list and the choice stay put, a fresh one when either moves. The
// first, the empty id, is the browser's default camera; a saved one the
// browser does not list right now stays in the list as 'Saved camera'.
let camOpts = null, camOptsList = null, camOptsFor = null;
function camDeviceOptions(s) {
  const list = camInputs(), chosen = typeof s.camDevice === 'string' ? s.camDevice : '';
  if (camOpts && list === camOptsList && chosen === camOptsFor) return camOpts;
  const opts = [{ value: '', label: 'Default camera' }];
  let found = !chosen;
  for (const d of list) {
    opts.push({ value: d.id, label: d.label });
    if (d.id === chosen) found = true;
  }
  if (!found) opts.push({ value: chosen, label: 'Saved camera' });
  camOpts = opts; camOptsList = list; camOptsFor = chosen;
  return camOpts;
}

const pct = v => Math.round(v * 100);

export const CAMERA_CONTROLS = [
  {
    // Opens the camera (asking the browser the first time) and shows it in
    // the corner; off stops it, and the camera light goes out. A refusal
    // turns this back off by itself (platform/camera-input.js).
    id: 'camOn', section: 'camera', label: 'On', kind: 'toggle', def: false,
    get: s => !!s.camOn,
    set: (s, on) => camSetOn(on)
  },
  {
    // A change while on opens the new camera at once.
    id: 'camDevice', section: 'camera', label: 'Camera', kind: 'segment', dropdown: true,
    get options() { return camDeviceOptions(S); },
    get: s => typeof s.camDevice === 'string' ? s.camDevice : '',
    set: (s, v) => camSetDevice(typeof v === 'string' ? v : '')
  },
  {
    // The panel's height as a share of the screen's shorter side (see
    // core/camera.js), the same on every screen watching. On a presenting
    // page the panel's inner corner drags it too, and this row follows.
    id: 'camSize', section: 'camera', label: 'Size', kind: 'slider',
    min: pct(CAM_SIZE_MIN), max: pct(CAM_SIZE_MAX), step: 1, def: pct(CAM_SIZE_DEF),
    get: s => pct(camSizeClamp(s.camSize)),
    set: (s, pos) => camSetSize(pos / 100),
    formatAt: pos => pos + '%',
    tip: "The panel's height, as a share of the screen's shorter side"
  }
];

export const CAMERA_SECTIONS = [
  { id: 'camera', title: 'Live Video', visible: () => camAvailable() }
];
