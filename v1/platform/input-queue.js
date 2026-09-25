// The pooled input queue: the fixed ring of reused event objects and the two
// ping-ponged arrays pollInput hands out, shared by both platforms. On the
// page (platform/web.js) it is filled straight from DOM events; in the engine
// worker (platform/worker-platform.js) it is filled from the plain copies of
// those same events the page posts across. Either way the engine sees the
// same InputEvent shapes, made by the same code, so nothing above the
// platform can tell which thread it is on.
//
// Every filler reads its source by the DOM event's own field names (clientX,
// shiftKey, deltaMode, timeStamp and the rest), which is what lets a posted
// copy stand in for the real event without a translation step of its own.

const POOL_SIZE = 256;
const LINE_PX = 16;       // wheel deltaMode 1 (line) to px, matching typical UA default

export function createInputQueue() {
  // A fixed ring of reused event objects, so a burst of pointer or key
  // activity never asks the GC for anything. pollInput hands back one of two
  // ping-ponged arrays: the caller reads the one just filled while the next
  // batch of events accumulates into the other, so no array is ever cleared
  // out from under a caller that hasn't looked at it yet.
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    pool.push({
      type: '', x: 0, y: 0, button: -1, pointerId: -1, pointerType: '',
      dx: 0, dy: 0, key: '', code: '', shift: false, alt: false,
      ctrl: false, meta: false, time: 0
    });
  }
  let ring = 0;
  function nextEvent() {
    const o = pool[ring];
    ring = (ring + 1) % POOL_SIZE;
    o.type = ''; o.x = 0; o.y = 0; o.button = -1; o.pointerId = -1; o.pointerType = '';
    o.dx = 0; o.dy = 0; o.key = ''; o.code = ''; o.shift = false; o.alt = false;
    o.ctrl = false; o.meta = false; o.time = 0;
    return o;
  }

  const queueA = [], queueB = [];
  let queue = queueA;
  // A pointer that is only moving, with no down or up in between, collapses
  // onto one event per poll: the last position is the only one that matters
  // for a frame, and a fast mouse or a 120 Hz touch digitiser can otherwise
  // fill the queue with positions that never get drawn.
  const moveByPointer = new Map();

  function pushEvent() {
    const o = nextEvent();
    queue.push(o);
    return o;
  }

  function fillPointer(o, type, e) {
    o.type = type;
    // The canvas is always the full viewport (see v1/index.html), so client
    // coordinates are already canvas-local; reading a bounding rect here
    // would force a layout on every single pointer event.
    o.x = e.clientX; o.y = e.clientY;
    o.button = e.button;
    o.pointerId = e.pointerId;
    o.pointerType = e.pointerType;
    o.shift = e.shiftKey; o.alt = e.altKey; o.ctrl = e.ctrlKey; o.meta = e.metaKey;
    o.time = e.timeStamp;
  }

  // 'down', 'up' and 'cancel' each end any collapsed move for their pointer;
  // 'leave' is reported as it comes and leaves a pending move alone; 'move'
  // reuses the pointer's pending move event when there is one.
  function pointer(type, e) {
    if (type === 'move') {
      let o = moveByPointer.get(e.pointerId);
      if (!o) {
        o = pushEvent();
        moveByPointer.set(e.pointerId, o);
      }
      fillPointer(o, 'move', e);
      return;
    }
    if (type !== 'leave') moveByPointer.delete(e.pointerId);
    fillPointer(pushEvent(), type, e);
  }

  // pageW and pageH are the surface's size in css px, which a page-mode
  // (deltaMode 2) scroll is measured in.
  function wheel(e, pageW, pageH) {
    const o = pushEvent();
    o.type = 'wheel';
    o.x = e.clientX; o.y = e.clientY;
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= LINE_PX; dy *= LINE_PX; }
    else if (e.deltaMode === 2) { dx *= pageW; dy *= pageH; }
    o.dx = dx; o.dy = dy;
    o.shift = e.shiftKey; o.alt = e.altKey; o.ctrl = e.ctrlKey; o.meta = e.metaKey;
    o.time = e.timeStamp;
  }

  // type is 'key' or 'keyup'.
  function key(type, e) {
    const o = pushEvent();
    o.type = type;
    o.key = e.key; o.code = e.code;
    o.shift = e.shiftKey; o.alt = e.altKey; o.ctrl = e.ctrlKey; o.meta = e.metaKey;
    o.time = e.timeStamp;
  }

  function pollInput() {
    const out = queue;
    moveByPointer.clear();
    queue = (queue === queueA) ? queueB : queueA;
    queue.length = 0;
    return out;
  }

  return { pointer, wheel, key, pollInput };
}
