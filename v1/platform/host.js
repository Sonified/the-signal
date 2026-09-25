// Which thread this copy of v1 is running on, and the handoff between the
// engine worker's entry module and main.js.
//
// main.js is the composition root on either thread. On the page it builds
// the web platform itself (or, in worker mode, starts the shell and hands the
// engine to the worker). Inside the worker, v1/worker-entry.js fills this
// object before it loads main.js: `worker` is true, `platform` is a promise
// for the worker's Platform (it settles once the page has transferred the
// canvas), `profileHost` stands in for platform/profile-web.js, and `link`
// is the worker's end of the audio link (core/audio-link.js), which main.js
// calls once a frame after the submit, and `bootFailed(err)` is where main.js
// reports a boot that threw. On the page they stay as below and nothing
// reads them.
export const host = {
  worker: false,
  platform: null,
  profileHost: null,
  link: null,
  bootFailed: null
};
