// The energy profile's CPU canary (platform/energy-page.js): a fixed piece
// of integer work, timed on its own thread so it can never hold up a frame.
// The same work taking longer as a session goes on means the phone has
// slowed its CPU, which it does when it runs hot.
const N = 4000000;
let keep = 0;
function work() {
  let x = 0x9e3779b9 | 0, s = 0;
  for (let i = 0; i < N; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    s = (s + (x & 0xffff)) | 0;
  }
  return s;
}
self.onmessage = () => {
  const t = performance.now();
  keep ^= work();
  self.postMessage({ ms: performance.now() - t, keep: keep & 1 });
};
