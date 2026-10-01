// The ticker's clock (see js/ticker.js). It keeps the timers and nothing
// else: the page says which to arm and which to clear, and each one that
// comes due posts its id back for the page to run. It lives here because a
// browser throttles a hidden page's own timers hard, and a dedicated
// worker's barely at all.
//
// Messages in are [op, id, ms]: op 0 arms a one-shot, 1 a repeating timer,
// 2 clears one. Messages out are a bare id.

const live = new Map();   // id -> this worker's own timer handle

onmessage = e => {
  const [op, id, ms] = e.data;
  if (op === 2) {
    // clearTimeout clears an interval too: the two share one list of timers
    clearTimeout(live.get(id));
    live.delete(id);
  } else if (op === 1) {
    live.set(id, setInterval(() => postMessage(id), ms));
  } else {
    live.set(id, setTimeout(() => { live.delete(id); postMessage(id); }, ms));
  }
};
