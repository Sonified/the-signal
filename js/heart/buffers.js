// Sample buffers for Heart (documents/heart-audio-engine.md, §12):
// decodeAudioData stays native, and a native AudioBuffer handed to a Heart
// node is registered here and its samples copied into the stage that needs
// them, once.
//
// An id is the buffer's name on the wire (the `buffer` attr). The same
// AudioBuffer always gets the same id, through a WeakMap, so a buffer the
// app hands to a hundred notes is one id and one upload. Ids are unique for
// the page, so every engine and the offline bench can share them.
//
// The samples travel planar, channel after channel. With SharedArrayBuffer
// one shared copy is made and every stage reads it into its own wasm
// memory; without, each stage is sent a copy of its own, transferred.
// Either way the stage copies it in with heart_buffer_alloc
// (render-worker.js).
//
// And it is let go of again. The rooms rebuild their impulse for every
// change of decay, so an upload that nothing will name again must not stay
// in a stage's memory for the session. Two things say so: the page letting
// go of the AudioBuffer (the registry below hears it collected), and a
// convolver handed a new impulse (nodes.js), whose old one is freed on that
// node's stages at once. Either way each stage is told heart_buffer_free,
// which waits while a node there still plays the buffer, and the uploader
// forgets it was sent, so a later use uploads it afresh.

const ids = new WeakMap();
const byId = new Map();
let nextId = 1;
// Every live engine's uploader, to be told when a buffer is collected.
const uploaders = new Set();
const forget = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(id => {
      byId.delete(id);
      for (const u of uploaders) u.free(id);
    })
  : null;

export function registerBuffer(audioBuffer) {
  let id = ids.get(audioBuffer);
  if (id) return id;
  id = nextId++;
  ids.set(audioBuffer, id);
  byId.set(id, new WeakRef(audioBuffer));
  if (forget) forget.register(audioBuffer, id);
  return id;
}

export const bufferOf = id => byId.get(id)?.deref() ?? null;

// The buffer's channels, one after another, in a new Float32Array over a
// buffer of the kind asked for.
function planar(audioBuffer, shared) {
  const { numberOfChannels: channels, length: frames } = audioBuffer;
  const bytes = 4 * channels * frames;
  const data = new Float32Array(shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
  for (let c = 0; c < channels; c++) data.set(audioBuffer.getChannelData(c), c * frames);
  return data;
}

// One engine's uploader. `post(stageId, message, transfer)` reaches that
// stage's worker.
//
//   ensure(id, stageId, audioBuffer?)  uploads buffer `id` to the stage
//                                      unless it is there already. The
//                                      AudioBuffer may be handed over, which
//                                      saves the lookup. False only when the
//                                      id names no buffer the page still holds.
//   free(id, stageIds?)                frees it on those stages (all, by
//                                      default) that hold it
//   close()                            the engine is gone; stop listening
//
// The engine posts a free behind every command already sent (engine.js), so
// a node switched away from the buffer just before has let go of it by the
// time the free lands.
export function createUploader({ shared, stages, post }) {
  const sent = Array.from({ length: stages }, () => new Set());
  const sharedCopies = new WeakMap();

  function ensure(id, stageId, audioBuffer = bufferOf(id)) {
    if (sent[stageId].has(id)) return true;
    if (!audioBuffer) return false;
    let data;
    if (shared) {
      data = sharedCopies.get(audioBuffer);
      if (!data) { data = planar(audioBuffer, true); sharedCopies.set(audioBuffer, data); }
    } else {
      data = planar(audioBuffer, false);
    }
    post(stageId, {
      type: 'buffer', id,
      channels: audioBuffer.numberOfChannels,
      frames: audioBuffer.length,
      sampleRate: audioBuffer.sampleRate,
      data
    }, shared ? [] : [data.buffer]);
    sent[stageId].add(id);
    return true;
  }

  function free(id, stageIds = sent.keys()) {
    for (const s of stageIds) {
      if (sent[s]?.delete(id)) post(s, { type: 'free', id }, []);
    }
  }

  const uploader = { ensure, free, close: () => uploaders.delete(uploader) };
  uploaders.add(uploader);
  return uploader;
}
