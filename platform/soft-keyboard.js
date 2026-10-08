// The phone's own keyboard for the canvas's text fields (ui/widgets.js
// textBegin and textField). A canvas field is fed by keydown events, and a
// phone has no keys to send them: its keyboard only rises when a real
// editable element takes focus, and on iOS only when that focus() is called
// inside the tap itself, not in the frame that later reads the tap. So the
// page keeps one hidden <input> and focuses it in the tap's own pointerup,
// and the engine's text state follows what is typed into it.
//
// Two halves, one on each side of the engine:
//
//   createSoftKeyboard(canvas, toEngine), on the page (platform/web.js in
//   main mode, platform/worker-bridge.js in worker mode). It owns the input.
//   Each frame the engine publishes the rects where a tap opens a field (the
//   "targets", ui.textTarget, the open field's own rect among them); a touch
//   tap that lands on one focuses the input there and then, before the
//   engine has even seen the tap, and tells the engine it did ('kbArm'). The
//   input's text, caret and selection go to the engine on every input event,
//   which covers autocorrect, predictive text and IME composition (none of
//   them send reliable keydowns on a phone); Enter or Go is a commit, Escape
//   a cancel, and the input losing focus by any other hand (iOS's Done, the
//   app going to the background) is a commit, as focus leaving a field is.
//
//   createKeyboardLink(toPage), on the engine's side, the same thread as the
//   UI (handed to it as platform.softKeyboard, read by ui.softKb). It tells
//   the page when a field opens (seeded with its text, caret at the end or
//   everything selected), when the engine's own text moves away from what
//   the page last sent (a tap that placed the caret, the numeric filter or
//   maxLen refusing a character), and when the field closes, however it
//   closed. A tap that armed the input but opened nothing (it was a drag, or
//   a target that no longer opens) is released two frames after its up was
//   read, and the page lets go of the focus.
//
// In main mode the two halves call each other directly; in worker mode their
// messages ride the bridge (k: 'kbTargets' | 'kbBegin' | 'kbSync' | 'kbEnd' |
// 'kbRelease' to the page, 'kbArm' | 'kbText' | 'kbDone' to the engine).
// Every message about an edit carries the edit's generation, so one that
// crosses a close and a reopen in flight is dropped rather than landing in
// the wrong field. Mouse presses never arm the input, and on a device with
// no touch screen neither half is built, so desktop typing goes through the
// keydown path exactly as before.

// Whether this device can raise an on-screen keyboard at all. Read on the
// page (the worker learns it from the hello).
export function softKeyboardWanted() {
  try {
    return (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
      (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  } catch { return false; }
}

// How far a finger may travel between down and up and still count as a tap
// on a target. Generous: a drag that slips through is released by the engine.
const TAP_SLOP = 12;

export function createSoftKeyboard(canvas, toEngine) {
  // 16 px text, so iOS never zooms the page to it; fixed at the top left of
  // the viewport, so focusing it never scrolls anything into view; invisible
  // by opacity and transparent ink and caret, so the canvas's own caret is the
  // only one on screen. Not display:none or visibility:hidden, which cannot
  // take focus. Out of the tab order and the pointer's way.
  const input = document.createElement('input');
  input.type = 'text';
  input.tabIndex = -1;
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('enterkeyhint', 'done');
  input.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;' +
    'opacity:0;font-size:16px;color:transparent;background:transparent;' +
    'caret-color:transparent;outline:none;pointer-events:none;z-index:-1;';
  document.body.appendChild(input);

  let targets = [];        // flat x, y, w, h from the engine's last frame
  let gen = 0;             // the edit the engine has open, 0 for none
  let armSeq = 0, armed = 0;   // the tap that focused the input, until the engine answers
  let sentN = 0;           // input reports sent, so a stale correction can be told apart
  let fingerDown = false, downX = 0, downY = 0;
  let blurPending = false; // the engine closed the field while a finger was still down
  let composing = false;
  let quiet = false;       // our own focus or blur, which is not the viewer's doing

  const holdsFocus = () => document.activeElement === input;

  function targetAt(x, y) {
    for (let i = 0; i + 3 < targets.length; i += 4) {
      if (x >= targets[i] && x < targets[i] + targets[i + 2] &&
          y >= targets[i + 1] && y < targets[i + 1] + targets[i + 3]) return i;
    }
    return -1;
  }

  function focusInput() {
    quiet = true;
    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    quiet = false;
  }
  function blurInput() {
    if (!holdsFocus()) return;
    quiet = true;
    input.blur();
    quiet = false;
  }

  // The engine's text into the input, caret at `caret`, or all of it
  // selected so the first key replaces it.
  function setValue(text, caret, all) {
    if (input.value !== text) input.value = text;
    const n = text.length;
    const a = all && n > 0 ? 0 : Math.min(caret, n), b = all ? n : a;
    try { input.setSelectionRange(a, b); } catch {}
  }

  function report() {
    if (!gen) return;
    const v = input.value, n = v.length;
    const s = input.selectionStart, e = input.selectionEnd;
    toEngine({ k: 'kbText', gen, n: ++sentN, text: v,
               caret: e === null ? n : e, all: n > 0 && s === 0 && e === n });
  }
  function done(how) {
    if (gen) toEngine({ k: 'kbDone', gen, how });
  }

  input.addEventListener('input', report);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; report(); });
  input.addEventListener('keydown', e => {
    // 229 is a key the IME is still holding; its Enter picks a candidate
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); done(1); }
    else if (e.key === 'Escape') { e.preventDefault(); done(2); }
  });
  // a hardware keyboard's arrows move the caret without an input event
  input.addEventListener('keyup', e => {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') report();
  });
  input.addEventListener('blur', () => {
    composing = false;
    if (!quiet) done(1);
  });

  // While the input holds focus, the tap's own mouse emulation must not hand
  // focus back to the canvas (it is focusable) and so close the keyboard.
  // Nothing on the canvas listens for those emulated events.
  canvas.addEventListener('touchend', e => { if (holdsFocus()) e.preventDefault(); }, { passive: false });

  return {
    // The page's pointerdown, before it is queued. True while the input holds
    // focus, so the caller leaves the canvas unfocused and the keyboard up; a
    // press elsewhere still commits, in the engine, and the field's close
    // then lets the input go.
    down(e) {
      if (e.pointerType === 'mouse') return false;
      fingerDown = true;
      downX = e.clientX; downY = e.clientY;
      return holdsFocus();
    },
    // The page's pointerup, before it is queued: the tap itself, the one
    // moment iOS will raise its keyboard for a focus() call.
    up(e) {
      if (e.pointerType === 'mouse') return;
      fingerDown = false;
      const x = e.clientX, y = e.clientY;
      const k = targetAt(x, y);
      if (k >= 0 && targetAt(downX, downY) === k && Math.abs(x - downX) + Math.abs(y - downY) < TAP_SLOP) {
        armed = ++armSeq;
        blurPending = false;
        if (!holdsFocus()) focusInput();
        toEngine({ k: 'kbArm', seq: armed });
        return;
      }
      if (blurPending) { blurPending = false; if (!gen && !armed) blurInput(); }
    },
    cancel(e) {
      if (e.pointerType === 'mouse') return;
      fingerDown = false;
      if (blurPending) { blurPending = false; if (!gen && !armed) blurInput(); }
    },
    // From the engine's link.
    receive(m) {
      switch (m.k) {
        case 'kbTargets': targets = m.r; break;
        case 'kbBegin':
          gen = m.gen; armed = 0; blurPending = false; sentN = 0;
          input.maxLength = m.maxLen;
          input.setAttribute('autocorrect', m.numeric ? 'off' : 'on');
          input.setAttribute('autocapitalize', m.numeric ? 'off' : 'sentences');
          input.spellcheck = !m.numeric;
          setValue(m.text, m.text.length, m.all);
          // Focus comes only from a tap (up, above): a focus out here, after
          // the gesture, would on iOS take the keys without the keyboard.
          break;
        case 'kbSync':
          // skipped mid-composition, and when the engine has not yet seen the
          // latest input (it will answer that one in turn)
          if (m.gen !== gen || composing || m.n !== sentN) break;
          setValue(m.text, m.caret, m.all);
          break;
        case 'kbEnd':
          if (m.gen !== gen) break;
          gen = 0;
          if (armed) break;
          // A finger still down may be tapping the next field open; its up decides.
          if (fingerDown) blurPending = true;
          else blurInput();
          break;
        case 'kbRelease':
          if (m.seq !== armed) break;
          armed = 0;
          if (!gen) blurInput();
          break;
      }
    }
  };
}

const MAX_TARGETS = 128;

export function createKeyboardLink(toPage) {
  const cur = new Float32Array(MAX_TARGETS * 4);
  let curN = 0;
  let sent = [];
  let armed = 0, armFrames = 0;

  const link = {
    // the text state being edited, and its edit's generation
    st: null, gen: 0,
    // the page's latest, waiting for the field's next frame: its text (null
    // when nothing new), caret, whole-text selection and report number, and
    // a Done (1 commit, 2 cancel, 0 none)
    inText: null, inCaret: 0, inAll: false, inN: 0, inDone: 0,
    // what the page's input holds, as far as this side knows
    knownText: '', knownCaret: 0, knownAll: false,

    // A rect where a tap opens a field, for this frame's list.
    target(x, y, w, h) {
      if (curN >= MAX_TARGETS) return;
      const j = curN++ * 4;
      cur[j] = Math.floor(x); cur[j + 1] = Math.floor(y);
      cur[j + 2] = Math.ceil(w); cur[j + 3] = Math.ceil(h);
    },

    begin(st, numeric) {
      link.st = st;
      link.gen++;
      armed = 0;   // the tap that armed the input is answered
      link.inText = null; link.inDone = 0; link.inN = 0;
      link.knownText = st.text; link.knownCaret = st.caret; link.knownAll = st.selAll;
      toPage({ k: 'kbBegin', gen: link.gen, text: st.text, all: st.selAll, maxLen: st.maxLen, numeric: !!numeric });
    },

    end() {
      if (!link.st) return;
      link.st = null;
      link.inText = null; link.inDone = 0;
      toPage({ k: 'kbEnd', gen: link.gen });
    },

    // After the open field's frame: anything the engine changed itself goes
    // back to the page's input.
    sync(st) {
      if (st.text === link.knownText && st.caret === link.knownCaret && st.selAll === link.knownAll) return;
      link.knownText = st.text; link.knownCaret = st.caret; link.knownAll = st.selAll;
      toPage({ k: 'kbSync', gen: link.gen, n: link.inN, text: st.text, caret: st.caret, all: st.selAll });
    },

    // From the page.
    receive(d) {
      switch (d.k) {
        case 'kbArm': armed = d.seq; armFrames = 0; break;
        case 'kbText':
          if (d.gen !== link.gen || !link.st) break;
          link.inText = d.text; link.inCaret = d.caret; link.inAll = d.all; link.inN = d.n;
          break;
        case 'kbDone':
          if (d.gen !== link.gen || !link.st) break;
          link.inDone = d.how;
          break;
      }
    },

    // Once a frame, from ui.end().
    frameEnd(ui) {
      // A field closed without finishText (its owner dropped st.active), or
      // not drawn for a whole frame (its row or screen went away), lets the
      // keyboard go now rather than when it is next drawn, which may be never.
      const st = link.st;
      if (st && (!st.active || st.seenFrame < ui.frame - 1)) link.end();
      // A tap that armed the input and, by the frame after its up was read,
      // opened nothing.
      if (armed) {
        if (armFrames > 0 || ui._upEvent) armFrames++;
        if (armFrames >= 2) { toPage({ k: 'kbRelease', seq: armed }); armed = 0; }
      }
      // This frame's targets, posted only when they differ from the last
      // posted (rounded, so a still layout sends nothing).
      let same = sent.length === curN * 4;
      for (let i = 0; same && i < curN * 4; i++) same = sent[i] === cur[i];
      if (!same) {
        sent = Array.from(cur.subarray(0, curN * 4));
        toPage({ k: 'kbTargets', r: sent });
      }
      curN = 0;
    }
  };
  return link;
}
