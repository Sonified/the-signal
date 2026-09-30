// The live sound's media half: the browser machinery that turns the
// broadcaster's Live Sound mix into pieces a socket can carry, and turns
// those pieces back into sound on a follower. core/live-audio.js is the
// logic half (when to record, which rooms hear it, what a relay notice
// means) and never sees a MediaRecorder or a media element; main.js hands
// these functions in with the broadcast's other platform bits.
//
// Sending. A MediaRecorder on the mix's MediaStream, WebM/Opus at 96 kb/s,
// asked for a piece every 200 ms: the blueprint's live mode, about a second
// behind the broadcaster once the follower's cushion is counted. Each piece
// is a Blob, read out as an ArrayBuffer for the socket. Reading is
// asynchronous, so the reads are chained one behind another, which keeps the
// pieces in the order the recorder made them. The first piece of every
// recording carries the stream's header; the relay and the logic half both
// lean on that (see broadcast-worker/src/index.js, Live sound).
//
// Hearing. One hidden audio element, never in the document (audio is exempt
// from the no-DOM-over-canvas rule by being nowhere at all), playing a
// MediaSource whose one SourceBuffer takes the pieces as they arrive. The
// SourceBuffer runs in 'sequence' mode, which lays each coded frame straight
// after the last whatever its own timestamp says. That is what makes a
// mid-stream join and a restart both simple: a joiner is handed the
// recording's first piece (the header, and with it a moment of old audio)
// and then pieces from the middle, whose timestamps no longer agree with it,
// and a restarted recording counts from zero again; sequence mode stitches
// both into one unbroken timeline. A new recording only needs the parser
// reset (abort()) before its header goes in, so the element, and the
// permission to play it, carry through.
//
// Latency is held between two bounds. Playback starts, and restarts after
// any stall, half a second behind the newest audio received (JITTER_S): the
// jitter buffer, enough to ride out a late piece or two. If the audio
// buffered ahead of the playhead grows past MAX_AHEAD_S (a backgrounded tab,
// or the broadcaster's recorder clock running a hair fast against this
// output's), the playhead jumps forward to half a second behind again. Old
// audio behind the playhead is removed in slabs, so an hours-long session
// holds a few seconds of sound, never hours of it.
//
// A page may not start sound before the viewer's first gesture. Until then
// the pieces are still appended, and the same trimming keeps only the last
// few seconds, so a locked follower's memory stays flat however long it
// waits; unlock() (from the follow gate's tap, in main.js) blesses the
// element inside the gesture and playback begins half a second behind live.

const MIME = 'audio/webm;codecs=opus';
const REC_BPS = 96000;
const TIMESLICE_MS = 200;

const JITTER_S = 0.5;       // the cushion playback starts with
const MAX_AHEAD_S = 1.5;    // buffered ahead of the playhead beyond this, jump forward
const KEEP_BEHIND_S = 4;    // audio kept behind the playhead
const TRIM_SLAB_S = 10;     // removed only once this much has piled up past that
const QUEUE_MAX = 50;       // pieces waiting to be appended (10 s); past it, start clean

const noop = () => {};

// ---------- sending ----------

export function canRecordLiveAudio() {
  return typeof MediaRecorder !== 'undefined' && !!MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(MIME);
}

// Starts recording `stream`. Each piece reaches onChunk(ArrayBuffer), in
// order; onEnd() fires if the recording stops of its own accord (the
// stream's tracks ended, an error), never after stop(). Returns { stop() },
// or null where the browser cannot record WebM/Opus or refuses the stream.
export function recordLiveAudio(stream, onChunk, onEnd) {
  if (!canRecordLiveAudio()) return null;
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: REC_BPS });
  } catch (e) { return null; }
  let live = true;
  let chain = Promise.resolve();
  rec.ondataavailable = e => {
    const blob = e.data;
    if (!live || !blob || !blob.size) return;
    chain = chain.then(() => blob.arrayBuffer()).then(buf => { if (live) onChunk(buf); }, noop);
  };
  const ended = () => { if (!live) return; live = false; onEnd(); };
  rec.onstop = ended;
  rec.onerror = () => { try { rec.stop(); } catch (e) {} ended(); };
  try { rec.start(TIMESLICE_MS); } catch (e) { return null; }
  return {
    stop() {
      if (!live) return;
      // the recorder's last piece, delivered on stop, is dropped with it
      live = false;
      try { rec.stop(); } catch (e) {}
    }
  };
}

// ---------- hearing ----------

// The one player, made on first use: by the follow gate's tap, or by the
// first stream to arrive. null where the browser has no MediaSource able to
// play WebM/Opus. iOS offers ManagedMediaSource in MediaSource's place,
// which asks for remote playback to be declined on the element.
let player;

export function livePlayer() {
  if (player === undefined) player = makePlayer();
  return player;
}

// Called inside the follow gate's gesture, before or after boot.
export function unlockLiveAudio() {
  const p = livePlayer();
  if (p) p.unlock();
}

function makePlayer() {
  const MS = typeof ManagedMediaSource !== 'undefined' ? ManagedMediaSource
           : typeof MediaSource !== 'undefined' ? MediaSource : null;
  if (!MS || !MS.isTypeSupported(MIME) || typeof Audio === 'undefined') return null;
  const el = new Audio();
  el.preload = 'auto';
  el.disableRemotePlayback = true;

  let ms = null, sb = null;
  let init = null;            // the current recording's header piece
  let expectInit = false;     // the next piece is a header
  let needReset = false;      // abort() the parser before the next append
  let broken = false;         // the source failed; the next piece rebuilds it
  let unlocked = false;       // the viewer has made a gesture
  let filling = true;         // paused, gathering the cushion before playing
  // Where the header piece's own audio ends on the timeline. A joiner's
  // header carries a moment from the recording's start, long past, so
  // playback never begins before this; for a fresh recording it skips only
  // its first 200 ms.
  let floor = 0, appendingInit = false;
  const queue = [];

  // A fresh MediaSource on the element: at the start, and after a failure.
  function build() {
    broken = false;
    needReset = false;
    appendingInit = false;
    floor = 0;
    sb = null;
    const mine = ms = new MS();
    const url = URL.createObjectURL(mine);
    mine.addEventListener('sourceopen', () => {
      URL.revokeObjectURL(url);
      if (ms !== mine) return;
      try {
        sb = mine.addSourceBuffer(MIME);
        sb.mode = 'sequence';
      } catch (e) { sb = null; broken = true; return; }
      sb.addEventListener('updateend', pump);
      sb.addEventListener('error', () => { broken = true; });
      pump();
    }, { once: true });
    el.src = url;
    filling = true;
  }

  // One step of the append loop, run whenever the SourceBuffer comes free
  // and whenever a piece arrives.
  function pump() {
    if (!sb || sb.updating || !ms || ms.readyState !== 'open') return;
    if (appendingInit) {
      appendingInit = false;
      const b = sb.buffered;
      if (b.length) floor = b.end(b.length - 1);
    }
    if (needReset) { needReset = false; try { sb.abort(); } catch (e) {} }
    steer();
    if (trim()) return;
    const buf = queue.shift();
    if (!buf) return;
    appendingInit = buf === init;
    try { sb.appendBuffer(buf); } catch (e) { appendingInit = false; broken = true; }
  }

  // Start once the cushion is there; jump forward if too far behind.
  function steer() {
    if (!unlocked) return;
    const b = sb.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    if (filling) {
      if (end - Math.max(el.currentTime, b.start(b.length - 1), floor) < JITTER_S) return;
      filling = false;
      el.currentTime = end - JITTER_S;
      const p = el.play();
      if (p) p.catch(e => {
        // not allowed after all: back to gathering until another gesture
        if (e && e.name === 'NotAllowedError') { unlocked = false; filling = true; }
      });
    } else if (end - el.currentTime > MAX_AHEAD_S) {
      el.currentTime = end - JITTER_S;
    }
  }

  // Removes old audio once a slab of it has piled up behind the playhead
  // (or, while gathering, behind the newest audio). True when a removal
  // started, which holds the append until it ends.
  function trim() {
    const b = sb.buffered;
    if (!b.length) return false;
    const head = filling ? b.end(b.length - 1) : el.currentTime;
    const cut = head - KEEP_BEHIND_S;
    if (cut - b.start(0) < TRIM_SLAB_S) return false;
    try { sb.remove(b.start(0), cut); return true; } catch (e) { return false; }
  }

  // Playback ran dry (a late piece, a dropped link): pause and gather the
  // cushion again rather than limp along on no buffer at all. A seek's own
  // brief wait is not a stall.
  el.addEventListener('waiting', () => {
    if (!unlocked || filling || el.seeking) return;
    filling = true;
    el.pause();
  });
  el.addEventListener('error', () => { broken = true; });

  return {
    // A new recording starts: its first piece is a header. What is still
    // playing from the last one stops here and the new one fills in.
    begin() {
      expectInit = true;
      queue.length = 0;
      if (!filling) { filling = true; el.pause(); }
    },
    // One piece from the relay.
    push(buf) {
      if (expectInit) {
        expectInit = false;
        init = buf;
        queue.length = 0;
        if (!ms || broken) build();
        else needReset = true;
      } else if (!init) {
        return;   // a piece with no header to read it by (joined off air)
      } else if (broken) {
        // start clean on a new source: the header, then on from here
        build();
        queue.length = 0;
        queue.push(init);
      }
      queue.push(buf);
      if (queue.length > QUEUE_MAX) {
        // the source is not keeping up at all: drop what waits and take
        // up again from the header, which sequence mode stitches on
        queue.length = 0;
        needReset = true;
        queue.push(init);
        if (!filling) { filling = true; el.pause(); }
      }
      pump();
    },
    // The stream stopped: whatever is buffered plays out, then silence.
    end() {
      init = null;
      expectInit = false;
      queue.length = 0;
    },
    // Inside the viewer's gesture: a play() here is what lets every later
    // play() on this element go ahead (WebKit ties it to the element;
    // Chrome to the page, which a gesture has now touched). With nothing
    // buffered yet it is paused again at once and waits for the cushion.
    unlock() {
      if (unlocked) return;
      unlocked = true;
      const p = el.play();
      if (p) p.catch(noop);
      el.pause();
      pump();
    }
  };
}
