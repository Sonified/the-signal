// The ticker's clock (see js/ticker.js). It keeps the timers and nothing
// else: the page says which to arm and which to clear, and each one that
// comes due posts its id back for the page to run. It lives here because a
// browser throttles a hidden page's own timers hard, and a dedicated
// worker's barely at all.
//
// Messages in are [op, id, ms, first, gen]: op 0 arms a one-shot after ms,
// 1 a repeating timer every ms (its first tick after `first` ms when that
// is given, so a timer the page held back for a while picks up its own
// cadence where it left off), 2 clears one. Messages out are [id, gen], the
// generation the page armed it with, so a tick from an arming the page has
// since replaced is known for what it is; or the bare id when the page sent
// no generation, which is what js/ticker.js sends today (the walk that needs
// the rest is documents/idle-render-ahead.md, not built yet).

const live = new Map();   // id -> this worker's own timer handle

onmessage = e => {
  const [op, id, ms, first, gen] = e.data;
  // clearTimeout clears an interval too: the two share one list of timers
  clearTimeout(live.get(id));
  live.delete(id);
  if (op === 2) return;
  // a page that arms without a generation (today's js/ticker.js) hears the bare id
  const tick = gen === undefined ? id : [id, gen];
  if (op === 1) {
    const repeat = () => live.set(id, setInterval(() => postMessage(tick), ms));
    if (first >= 0) live.set(id, setTimeout(() => { postMessage(tick); repeat(); }, first));
    else repeat();
  } else {
    live.set(id, setTimeout(() => { live.delete(id); postMessage(tick); }, ms));
  }
};
