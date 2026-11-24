// Live Video's size range and its clamp, in a module that imports nothing.
// core/camera.js imports store.js, which reaches the schema, which reaches
// core/schema-camera.js, which needs these numbers at load to build its Size
// row. Held in core/camera.js they were still uninitialised at that moment
// ("Cannot access 'CAM_SIZE_MIN' before initialization", the page dead at
// boot). Here, with no imports, they exist before anything asks for them.
// core/camera.js re-exports them, so every other import is unchanged.

// The panel's height as a share of the screen's shorter side.
export const CAM_SIZE_MIN = 0.1, CAM_SIZE_MAX = 0.6, CAM_SIZE_DEF = 0.25;

// Any value to a size in range, to three decimals (what the wire carries);
// anything that is not a finite number is the default.
export function camSizeClamp(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return CAM_SIZE_DEF;
  const c = v < CAM_SIZE_MIN ? CAM_SIZE_MIN : v > CAM_SIZE_MAX ? CAM_SIZE_MAX : v;
  return Math.round(c * 1000) / 1000;
}
