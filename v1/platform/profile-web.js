// The frame profiler's browser half: everything core/profiler.js needs that
// only a web page can give it. It reads the JS heap, gathers the host facts
// for the report's system section, runs the performance observers and the
// window listeners while a recording is open, saves a report as a file, and
// puts the console handle on window. Like v1/platform/web.js, this is
// allowed to touch window, document and navigator so that core never does.
//
// Nothing here runs in the frame loop except readHeap, and only while a
// recording is open. The observers and listeners are attached when a
// recording starts and taken off when it stops, so a normal session pays
// for none of them.

export function createProfileHost() {
  const perf = typeof performance !== 'undefined' ? performance : null;
  const heapSupported = !!(perf && perf.memory && typeof perf.memory.usedJSHeapSize === 'number');
  const supported = (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes) || [];

  // Chrome's performance.memory hands back a fresh small object on every
  // read; there is no way to read the two numbers without it. It is the one
  // allocation this makes per frame, and only while recording.
  function readHeap(out) {
    if (!heapSupported) { out[0] = -1; out[1] = -1; return; }
    const m = perf.memory;
    out[0] = m.usedJSHeapSize;
    out[1] = m.totalJSHeapSize;
  }

  // High-entropy client hints arrive asynchronously, so they are asked for
  // when a recording starts and are there by the time the report is built.
  let hints = null;
  function requestHints() {
    try {
      const uad = navigator.userAgentData;
      if (uad && uad.getHighEntropyValues) {
        uad.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList'])
          .then(v => { hints = v; }, () => {});
      }
    } catch {}
  }

  function sysInfo() {
    const nav = navigator, uad = nav.userAgentData;
    let hdr = null, gamut = null;
    try {
      hdr = matchMedia('(dynamic-range: high)').matches;
      gamut = matchMedia('(color-gamut: p3)').matches ? 'p3' : matchMedia('(color-gamut: srgb)').matches ? 'srgb' : 'other';
    } catch {}
    return {
      userAgent: nav.userAgent,
      userAgentData: uad ? { platform: uad.platform, mobile: uad.mobile, brands: uad.brands, highEntropy: hints } : null,
      platform: nav.platform,
      hardwareConcurrency: nav.hardwareConcurrency || null,
      deviceMemoryGB: nav.deviceMemory || null,
      language: nav.language,
      screen: {
        width: screen.width, height: screen.height,
        availWidth: screen.availWidth, availHeight: screen.availHeight,
        colorDepth: screen.colorDepth, isExtended: screen.isExtended ?? null,
        hdr, gamut
      },
      devicePixelRatio: window.devicePixelRatio || 1,
      window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement),
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      crossOriginIsolated: !!self.crossOriginIsolated,
      url: location.href,
      jsHeapSizeLimit: heapSupported ? perf.memory.jsHeapSizeLimit : null,
      performanceEntryTypes: supported.slice()
    };
  }

  // ---------- observers, while recording ----------
  // Every entry is copied into a plain object straight away, so nothing
  // holds on to the browser's entry objects after the callback.
  function loafEntry(e) {
    const scripts = [];
    const src = e.scripts || [];
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      scripts.push({
        sourceURL: s.sourceURL || '', sourceFunctionName: s.sourceFunctionName || '',
        invoker: s.invoker || '', invokerType: s.invokerType || '',
        start: s.startTime, duration: s.duration,
        forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration || 0,
        pauseDuration: s.pauseDuration || 0
      });
    }
    return {
      start: e.startTime, duration: e.duration, blockingDuration: e.blockingDuration || 0,
      renderStart: e.renderStart || 0, styleAndLayoutStart: e.styleAndLayoutStart || 0,
      firstUIEventTimestamp: e.firstUIEventTimestamp || 0, scripts
    };
  }

  // sink: { loaf(o), longtask(o), event(o), note(kind, detail) }
  // Returns { has, stop }: which observers the browser offered, and the
  // function that takes every observer and listener back off.
  function observe(sink, audioCtx) {
    const offs = [];
    function watch(type, opts, fn) {
      if (!supported.includes(type)) return false;
      try {
        const po = new PerformanceObserver(list => {
          const es = list.getEntries();
          for (let i = 0; i < es.length; i++) fn(es[i]);
        });
        po.observe(Object.assign({ type }, opts));
        offs.push(() => po.disconnect());
        return true;
      } catch { return false; }
    }
    const has = {
      loaf: watch('long-animation-frame', {}, e => sink.loaf(loafEntry(e))),
      longtask: watch('longtask', {}, e => sink.longtask({
        start: e.startTime, duration: e.duration,
        attribution: (e.attribution || []).map(a => a.containerType + ':' + (a.containerSrc || a.containerName || a.name || ''))
      })),
      // 16 ms is the lowest threshold the spec allows; slower input events
      // are rare enough that watching them costs nothing noticeable.
      event: watch('event', { durationThreshold: 16 }, e => sink.event({
        name: e.name, start: e.startTime, duration: e.duration,
        processingStart: e.processingStart, processingEnd: e.processingEnd
      }))
    };

    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      offs.push(() => target.removeEventListener(type, fn, opts));
    }
    on(document, 'visibilitychange', () => sink.note('visibility', document.visibilityState));
    on(window, 'blur', () => sink.note('focus', 'window lost focus'));
    on(window, 'focus', () => sink.note('focus', 'window gained focus'));
    on(window, 'resize', () => sink.note('resize', window.innerWidth + 'x' + window.innerHeight + ' @' + window.devicePixelRatio));
    on(window, 'error', e => sink.note('error', (e.message || 'error') + (e.filename ? ' at ' + e.filename + ':' + e.lineno : '')));
    on(window, 'unhandledrejection', e => {
      const r = e.reason;
      sink.note('unhandledrejection', r && r.message ? r.message : String(r));
    });
    if (audioCtx && audioCtx.addEventListener) {
      on(audioCtx, 'statechange', () => sink.note('audio', 'state ' + audioCtx.state));
    }
    // console.error and console.warn are wrapped for the length of the
    // recording, so what the app itself complains about lands in the report
    // with a time. Errors the browser prints on its own (WebGPU validation,
    // for one) do not pass through here; the engine reports those.
    const ce = console.error, cw = console.warn;
    console.error = function () { try { sink.note('console.error', fmtArgs(arguments)); } catch {} return ce.apply(console, arguments); };
    console.warn = function () { try { sink.note('console.warn', fmtArgs(arguments)); } catch {} return cw.apply(console, arguments); };
    offs.push(() => { console.error = ce; console.warn = cw; });

    return {
      has,
      stop() { for (let i = offs.length - 1; i >= 0; i--) { try { offs[i](); } catch {} } offs.length = 0; }
    };
  }

  function fmtArgs(args) {
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      parts.push(a && a.message ? a.message : typeof a === 'object' ? safeJson(a) : String(a));
    }
    return parts.join(' ').slice(0, 500);
  }
  function safeJson(o) { try { return JSON.stringify(o); } catch { return String(o); } }

  // ---------- output ----------
  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function expose(name, api) {
    try { window[name] = api; } catch {}
  }

  function after(ms, fn) { return setTimeout(fn, ms); }

  return {
    heapSupported, readHeap, sysInfo, requestHints, observe, download, expose, after,
    hidden: () => !!document.hidden,
    now: () => performance.now(),
    nowISO: () => new Date().toISOString()
  };
}
