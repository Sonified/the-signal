// Makes reverb impulses off the main thread for audio.js (see its impulse
// responses section): a decaying burst of stereo noise, filled here and
// handed back as two transferred Float32Arrays, so nothing is copied on the
// way and the page never spends a frame on it. Both channels share one
// envelope value per sample, which halves the Math.pow calls.
self.onmessage = e => {
  const { id, len, decay } = e.data;
  const l = new Float32Array(len), r = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, decay);
    l[i] = (Math.random() * 2 - 1) * env;
    r[i] = (Math.random() * 2 - 1) * env;
  }
  self.postMessage({ id, l, r }, [l.buffer, r.buffer]);
};
