// The few page globals v0's shared modules touch at load time, stood in for
// inside the engine worker. It must be the first module the worker evaluates
// (v1/worker-entry.js imports it before anything else), since the modules it
// covers read these while they are being evaluated, not later.
//
// js/dom.js looks up three elements by id as it loads, js/audio.js writes
// window.__WORKLET_URL, and js/piano.js, js/clouds.js and js/ambience.js each
// build an Audio element to ask which codec to fetch. None of that is wanted
// here: the worker never plays or fetches a sound (the page does, see
// core/audio-shell.js), so every stand-in answers "nothing": no elements, and
// an Audio element that can play no format at all.
//
// The one deliberate answer is the Audio layer's checkbox. js/audio.js reads
// $('lAudio').checked to decide whether to start the sound on its own
// (applyAudioGain's self-healing start, and warmDevice's early return); a
// worker has no AudioContext to start, and trying would only fail and warn
// on every volume change. So here the checkbox reads unchecked, and the
// v0 code paths that would start audio stand down in this thread. The page's
// own copy of the same module reads the real preference and does the work.

const g = self;

if (typeof g.window === 'undefined') g.window = g;

if (typeof g.document === 'undefined') {
  const audioLayerBox = { checked: false };
  g.document = {
    getElementById: id => (id === 'lAudio' ? audioLayerBox : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    hidden: false,
    visibilityState: 'visible'
  };
}

if (typeof g.Audio === 'undefined') {
  g.Audio = class { canPlayType() { return ''; } };
}
