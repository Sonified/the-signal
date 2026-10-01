# Migration brief: the live app (v1) moves to the site root, v0 is archived in `v0/`

Written 2026-09-30 from a read-only survey of the working tree at commit `2b4e61f` plus uncommitted work. The whole plan below was then **rehearsed end to end on a scratch copy of the repo**, with the scripts in this brief, and finished with **0 unresolved references and every JS file passing `node --check`**.

Line numbers and counts are as of that survey. Other agents were editing `js/piano.js`, `js/choir.js`, `js/layers.js` and `heart/` at the time, so **re-run the Step 0 counts before acting.** Treat the patterns as the contract. The line numbers are only there to help you find things.

Robert's decision is the brief: **build the layout we live with permanently.** The live app's code lives at the site root, not in `v1/`.

---

## 0. Read this first

- **Run only when no other agent is editing files in this repo.** This moves 102 files (91 from v1/, 11 for v0) and rewrites import paths in 54 of them, plus 4 shared `js/` files and 1 test. An agent holding `v1/core/store.js` open would write it back to a path that no longer exists, and that silently forks the file. Ask Robert to confirm the repo is quiet. Then check that `git worktree list` shows only the main checkout and that `.claude/worktrees/` is empty: any open branch that touches `v1/` will need a rename-aware merge.
- **Start from a clean tree.** Ask Robert to push pending work first, so that `git status --short` is empty. Today `v1/core/signal.js`, `v1/core/variance.js`, `v1/core/schema-variance.js`, `js/heart/` and others are **untracked**. `git mv` of a directory carries untracked files along (tested), but the migration commits must contain only the migration.
- **Do not commit or push unless Robert asks.** If he does, use two commits (section 9).
- **Never use `git checkout --`, `git restore`, `git reset --hard`, `git stash` or `git clean` to fix your own mistake.** Fix forward with `git mv` and edits. Section 8 covers the one case where a full discard is acceptable.
- The repo is vanilla JS ES modules: no build step and no package.json. It uses Node 22, and `node --check` works on these files as they are. Robert's shell is **zsh**: every command below has been tested in zsh. Do not put a command line into a `$VAR` and expect zsh to split it.

---

## 1. Goal

The site is moving to **Cloudflare Pages at presence.now.audio**. It builds from the GitHub repo with no build command, and the output directory is the repo root (`documents/heart-audio-engine.md` §11). GitHub Pages (`sonified.github.io/the-signal/`) also serves the repo while it is still switched on. Robert wants:

1. **The live app served at `/`, with its code at the repo root.**
2. **v0 archived in its own folder, still runnable.**
3. **`/v1/` keeps working as a redirect to `/` and keeps its query** (`?follow=room` links are in the wild).
4. **The shared modules stay in `js/`.**

---

## 2. The repo in two minutes (for an agent new to it)

- **v0** is the original app: DOM-based, with Canvas2D, WebGL2 or WebGPU renderers. Its page is `/index.html`, which loads `js/main.js` and `css/style.css`.
- **v1** is the live app, drawn entirely on the GPU. Its page is `/v1/index.html`, which loads `v1/main.js`. Its code is in `v1/core`, `v1/gpu`, `v1/ui` and `v1/platform`. It can run its engine in a Web Worker (`v1/worker-entry.js`); that mode is opt-in through the `signal.v1.worker` localStorage key.
- **The two apps share code in both directions.** v1 reuses v0's audio and state modules in `js/` through relative imports (`../../js/state.js`). `js/` imports back into two leaf modules, `v1/core/signal.js` and `v1/core/variance.js`.
- **The base-tag trick.** `v1/index.html` contains `<base href="../">`. The shared audio modules fetch samples with **document-relative** URLs (`audio/piano/lekko-00.opus`, `audio/music/manifest.json`), and v1's image loader does the same (`assets/...`). The base makes those URLs resolve from the repo root even though the page lives in `/v1/`. The worker receives the same base as `init.baseURI` (`v1/platform/worker-bridge.js:113`, used in `worker-platform.js:134`). **v1 already behaves as if its page lived at the root.** Putting the page there and dropping the base changes no runtime fetch.
- **Module imports and `new URL('./x', import.meta.url)` resolve against the module file, not the page.** They break exactly when the module file moves, which is why most of this plan is import rewriting.
- **Heart** is the Rust/wasm audio engine. Its source is in `heart/`, the browser side is in `js/heart/`, and all of its worker, worklet and wasm URLs are module-relative.
- **Broadcast** uses a Cloudflare Worker relay (`broadcast-worker/`). The client is `v1/platform/broadcast-socket.js` plus `v1/core/broadcast.js`. Follower links have the form `<LIVE_PAGE>?follow=<room>`.
- **Local server:** `node tools/serve.mjs [port]` (default 8000) serves the repo root with COOP, COEP and CORP headers and no-store caching. It **does not** read `_redirects` or `_headers`.

---

## 3. Final tree and decisions

### Before

```
/index.html  /css/style.css                         v0 page and stylesheet
/js/                                                55 JS + heart.wasm: 44 shared, 2 v1-only, 9 v0-only
/v1/index.html  main.js  worker-entry.js  ARCHITECTURE.md
/v1/core/  gpu/  ui/  platform/  docs/mist-transition-proposal.md
/audio/ /assets/ /icons/ /manifest.webmanifest /stereo.html /sandbox/ /tools/ /heart/
/broadcast-worker/ /documents/ /reflections/ /_headers /README.md /LICENSE /known-ussues.md
```

### After (final, permanent)

```
/index.html              the live app's page (was v1/index.html; base tag removed; loads main.js)
/main.js                 (was v1/main.js)
/worker-entry.js         (was v1/worker-entry.js)
/core/  /gpu/  /ui/  /platform/      (were v1/core, v1/gpu, v1/ui, v1/platform)
/ARCHITECTURE.md         (was v1/ARCHITECTURE.md), beside README.md
/documents/mist-transition-proposal.md   (was v1/docs/; v1/docs/ disappears)
/js/                     shared modules (44) + affirmations.js, livesound.js; js/renderers/canvas2d.js; js/heart/
/v0/index.html           v0's page (gains <base href="../">)
/v0/css/style.css        (css/ disappears)
/v0/js/main.js renderer.js ui.js text.js framedata.js shaders.js ambience-mixer.js
/v0/js/renderers/webgl2.js webgpu.js
/_redirects              NEW: /v1 -> / (Cloudflare Pages)
/audio/ /assets/ /icons/ /manifest.webmanifest /stereo.html /sandbox/ /tools/ /heart/
/broadcast-worker/ /documents/ /reflections/ /_headers /README.md /LICENSE /known-ussues.md
```

`v1/` no longer exists. `css/` no longer exists.

### Collisions, checked one by one

| v1 item | Root today | Resolution |
|---|---|---|
| `index.html` | **v0's page** | Move v0's page to `v0/index.html` **first** (phase A), then move v1's page up (phase B). |
| `main.js`, `worker-entry.js` | none at root (`js/main.js` is v0's and moves to `v0/js/`) | Move up. |
| `core/ gpu/ ui/ platform/` | none | Move up. They don't clash with Cloudflare's reserved root names (`functions/`, `_worker.js`, `_routes.json`, `_headers`, `_redirects`). |
| `docs/` (one file) | `documents/` exists | **Merge into `documents/`**, so the root never has both `docs/` and `documents/`. Its 4 relative links (`../gpu/word-cloud.wgsl.js`, `../core/word-fx.js`, `../gpu/word-cloud.js`, `../ARCHITECTURE.md`) resolve identically from `documents/`, so it needs no edit. No filename clash exists. |
| `ARCHITECTURE.md` | none | Put it **at the root, beside README.md**. It is the code contract for the folders now at the root (`core/`, `gpu/`, `ui/`, `platform/`), and that is the conventional home for an architecture doc. `documents/` holds design, research and economics writing. |
| (v1 has no `css/` or `assets/`) | `css/`, `assets/` | `css/style.css` is v0-only and moves to `v0/css/`. `assets/` is shared and stays. |

### Why `v0/` and not `archive/v0/`

- `v0/` mirrors its URL (`/v0/`).
- It needs `<base href="../">`, the same one-level trick v1 lived with for months.
- Its 46 rewritten imports become `../../js/...`.

`archive/v0/` would mean `<base href="../../">` and `../../../js/...`, plus a folder whose only child is v0. Nothing else in the repo is an archive (`sandbox/` holds experiments and `stereo.html` is a standalone prototype), so the extra level buys nothing.

### Why `js/` keeps its name

With v1 at the root, `js/` sits beside `core/`, `gpu/` and friends, and a name like `shared/` would read more clearly. It is not clearly worth the cost:

- **Already paid:** the 126 v1→js and 46 v0→js imports are being rewritten anyway, so renaming would add almost nothing there.
- **New cost:** 59 specifiers in `tools/` (the Heart tests and the null test), plus **331 written `js/` paths in 96 files** (comments, documents, Rust comments, Robert's memory notes), plus `heart/build.sh` and `tools/heart-protocol.mjs` output paths, plus the muscle memory of every agent brief.
- `js/` is also not only audio: it holds state, sim, colour, words and DOM helpers, so `audio/` would be wrong.

If Robert ever wants `shared/`, it is a separate, later migration using the same relocation script.

### `/v1/` redirect: recommendation

**Recommended: a Cloudflare `_redirects` file at the repo root, and no stub page.**

```
# Old links into the app's former home. Exact paths first, then the splat.
/v1     /        301
/v1/    /        301
/v1/*   /:splat  301
```

What Cloudflare's documentation says (developers.cloudflare.com/pages/configuration/redirects, read for this survey):

- The syntax is `source destination [code]`. A `*` splat "will greedily match all characters" and is placed with `:splat`.
- **"Redirects are always followed, regardless of whether or not an asset matches the incoming request."**
- The supported codes are 301, 302, 303, 307 and 308; the default is 302. The limit is 2,000 static plus 100 dynamic rules.
- **It does not say whether the incoming query string is carried to the destination.** That is why the brief adds the exact `/v1/` line (the follow links are `/v1/?follow=…`) and makes **verifying the query on the `*.pages.dev` deployment a hard gate before the DNS cutover** (section 6). The splat line also forwards any stale deep URL (`/v1/core/store.js` → `/core/store.js`).

Why not a stub page:

- Stubs keep a `v1/` folder in the permanent tree.
- On Cloudflare a stub would never be served anyway, because the redirect wins over assets.

**Fallback if the query check fails:** delete the three `/v1` lines from `_redirects` and add the stub `v1/index.html` from Appendix A. It forwards with `location.replace('../' + location.search + location.hash)`, which keeps the query on any host.

**GitHub Pages while it is still on:**

- GitHub Pages ignores `_redirects`; Jekyll does not even publish files that start with `_`. So `sonified.github.io/the-signal/v1/…` will 404 there after the move.
- `sonified.github.io/the-signal/` itself works: the root page has no base, and `main.js` resolves inside `/the-signal/`.
- Follower links are live-session links. Once `LIVE_PAGE` points at presence.now.audio, new sessions never mint GitHub Pages links. Only links to past sessions on GitHub Pages die, and those rooms are over anyway.
- If Robert wants GitHub Pages `/v1/` links to keep working during the overlap, add the Appendix A stub **as well**. Cloudflare still redirects first, so it does no harm there. Delete the stub when GitHub Pages is switched off.
- **Ask Robert which he wants. The default is no stub.**

`localhost`: `tools/serve.mjs` ignores `_redirects`, so `http://localhost:8000/v1/` shows the server's "Nothing here" page, whose link (updated in H7) opens `/`. Teaching serve.mjs the redirect is an optional follow-up, not part of this migration.

---

## 4. Survey findings

### 4.1 Which `js/` files are shared, v1-only or v0-only

This comes from static reachability, including `new URL(..., import.meta.url)` worker and worklet edges, from `v1/main.js` + `v1/worker-entry.js` and from `js/main.js`. Every named import in the v0-only files resolves to a real export, so v0 at least links today.

| Group | Files | Action |
|---|---|---|
| **Shared, 44** | `ambience audio background chirp choir clouds color display-watch dom fdn-worklet geometry ir-worker layer-defs layers load-order mixgate panel-guard piano presets settings sim state strobe-am strobe-bridge strobe-scale strobe-worker sweep ticker-worker ticker util words worklet` (.js), `renderers/canvas2d.js`, `heart/{buffers,drain-worklet,engine,heart,nodes,params,pool,protocol-gen,render-worker,ring,route}.js` + `heart/heart.wasm` | stay in `js/` |
| **v1-only, 2** | `affirmations.js`, `livesound.js` | stay in `js/`. Moving them into `core/` would be a style change with its own rewrites. Out of scope. |
| **v0-only, 9** | `main renderer ui text framedata shaders ambience-mixer` (.js), `renderers/webgl2.js`, `renderers/webgpu.js` | move to `v0/js/` |

`canvas2d.js` stays because v1's graph reaches it: v1 → `js/presets.js` → `settings.js` → `strobe-bridge.js` → (Worker) `strobe-worker.js` → `renderers/canvas2d.js` → `geometry.js`.

**v0 depends on `core/signal.js` and `core/variance.js`** through `js/util.js`, `js/strobe-am.js`, `js/piano.js` and `js/choir.js`, so v0 keeps working only because those imports are rewritten too (4.3).

### 4.2 Imports out of v1's code into `js/` and `assets/`: **128, all lose one `../`**

| From (old → new) | Old pattern | New pattern | Static | Dynamic |
|---|---|---|---|---|
| `v1/main.js` → `main.js` | `'../js/X.js'` | `'./js/X.js'` | 7 (`main.js:22-28`) | |
| `v1/worker-entry.js` → `worker-entry.js` | `import('../js/livesound.js')` | `import('./js/livesound.js')` | | 2 (lines 40, 42) |
| `v1/{core,gpu,platform}/*` → `{core,gpu,platform}/*` | `'../../js/X.js'` | `'../js/X.js'` | 101 | 2 (`core/words.js:200,202`) |
| `v1/gpu/kaleido.js:71`, `v1/core/schema-kaleido.js:19` | `'../../assets/kaleidoscope/sets.mjs'` | `'../assets/kaleidoscope/sets.mjs'` | 2 | |
| `v1/ui/screens/*` → `ui/screens/*` | `'../../../js/X.js'` | `'../../js/X.js'` | 14 | |

That is 124 static and 4 dynamic, in 46 files. By target: state 39, audio 12, strobe-scale 7, piano 7, color 7, util 6, ambience 6, mixgate 5, livesound 5, display-watch 5, sim 4, panel-guard 4, layer-defs 4, words 2, layers 2, clouds 2, choir 2, background 2, affirmations 2, sets.mjs 2, strobe-am 1, presets 1, chirp 1.

**Unchanged:** the 284 specifiers that stay inside v1's tree. They move together, so `new URL('../worker-entry.js', import.meta.url)` in `platform/worker-bridge.js:92` and `import('./main.js')`, `./core/audio-link.js` and `./core/engine-thread.js` in `worker-entry.js:74,75,89` remain correct.

Quick recount: `grep -rhoE "['\"](\.\./)+(js|assets)/" v1 --include='*.js' | wc -l` should print `128`.

### 4.3 Imports into v1's code from outside: **6, `v1/` drops out**

| File:line | Old | New |
|---|---|---|
| `js/util.js:2` | `'../v1/core/signal.js'` | `'../core/signal.js'` |
| `js/strobe-am.js:42` | `'../v1/core/variance.js'` | `'../core/variance.js'` |
| `js/strobe-am.js:46` | `'../v1/core/signal.js'` | `'../core/signal.js'` |
| `js/piano.js:20` | `'../v1/core/variance.js'` | `'../core/variance.js'` |
| `js/choir.js:35` | `'../v1/core/variance.js'` | `'../core/variance.js'` |
| `tools/heart-tests/strobe-am.test.mjs:32` | `import('../../v1/core/signal.js')` | `import('../../core/signal.js')` |

Quick recount: `grep -rhoE "['\"](\.\./)+v1/" js tools sandbox --include='*.js' --include='*.mjs' | wc -l` should print `6`.

### 4.4 Imports in the moved v0 files: **46 rewritten, 11 unchanged**

There are 57 relative specifiers in the 9 files. Quick recount: `grep -hoE "['\"]\.{1,2}/[^'\"]+['\"]" js/{main,renderer,ui,text,framedata,shaders,ambience-mixer}.js js/renderers/{webgl2,webgpu}.js | wc -l` should print `57`.

| File | Rewritten | Pattern | Unchanged (moved siblings) |
|---|---|---|---|
| `v0/js/main.js` | 10 | `./X.js` → `../../js/X.js` | `./renderer.js ./ui.js ./text.js ./ambience-mixer.js` |
| `v0/js/renderer.js` | 4 | state, dom, strobe-bridge, `./renderers/canvas2d.js` → `../../js/renderers/canvas2d.js` | `./renderers/webgl2.js ./renderers/webgpu.js` |
| `v0/js/ui.js` | 14 | as main.js (the `./audio.js` import is multi-line, ending at line 19) | `./text.js` |
| `v0/js/text.js` | 2 | `./state.js` and **dynamic** `import('./words.js')` → `import('../../js/words.js')` (line 92) | |
| `v0/js/framedata.js` | 4 | state, util, geometry, dom | |
| `v0/js/ambience-mixer.js` | 8 | state, dom, settings, ambience, audio, piano, clouds, util | |
| `v0/js/shaders.js` | 0 | | |
| `v0/js/renderers/webgl2.js`, `webgpu.js` | 2 each | `../state.js` `../dom.js` → `../../../js/...` | `../shaders.js ../framedata.js` |

None of the 9 files uses `fetch`, `new URL`, `Worker` or `addModule`, or has any document-relative URL (`ui.js` only calls `location.reload()`).

**Import rewrites in total: 180** (128 + 6 + 46). One script does all of them (Step 2 and Step 4). The rehearsal produced exactly these counts.

### 4.5 Document-relative URLs (resolve against the page and its base)

| Where | URL | Before | After |
|---|---|---|---|
| `v1/index.html:12` → `index.html` | `<base href="../">` (+ comment, lines 8-11) | | **deleted** |
| `v1/index.html:50` → `index.html` | `src="v1/main.js"` | `/v1/main.js` through the base | `src="main.js"` → `/main.js` (handled by the Step 6 strip) |
| `index.html:16,17` → `v0/index.html` | `manifest.webmanifest`, `icons/icon-180.png` | `/` | `/` through the new `<base href="../">`, text unchanged |
| `index.html:18,814` → `v0/index.html` | `css/style.css`, `js/main.js` | `/` | `v0/css/style.css`, `v0/js/main.js` under the base (Step 3) |
| `js/piano.js:120,122,138,1017` | `audio/piano/…`, `audio/piano/releases/…`, `audio/music/manifest.json`, `audio/music/${file}.opus` | page base = `/` | page base = `/` on both pages, unchanged |
| `js/clouds.js:169`, `js/choir.js:40` | `audio/music/clouds/…`, `audio/music/choir/…` | same | unchanged |
| `js/ambience.js:19-21,32,95`, `js/layers.js:47` + `js/layer-defs.js` | `audio/`, `audio/ambience/seamless/`, `audio/music/layers/…` | same | unchanged |
| `assets/kaleidoscope/sets.mjs:53-184` | 13 sets × `image` and `manifest` under `assets/kaleidoscope/…` | same (through `platform.loadImagePixels`) | unchanged |
| `v1/gpu/flowers.js:31` → `gpu/flowers.js` | `assets/sprites/celestial-v1/source/lotus-bloom.png` | same | unchanged |
| `v1/platform/web.js:186` (page), `worker-platform.js:134` (worker, `new URL(url, init.baseURI)`) | image fetches | `document.baseURI` = `/` | `/`, unchanged |

Checked and absent: CSS `url()`, `@font-face` and web fonts (system stack only), `<img>`, service workers.

### 4.6 Module-relative URLs: none needs editing

| File:line | URL | Why it survives |
|---|---|---|
| `js/audio.js:59,62,135` | `./worklet.js`, `./fdn-worklet.js` (addModule, 743-744), `./ir-worker.js` | `js/` doesn't move |
| `js/ticker.js:68`, `js/strobe-bridge.js:169` | `./ticker-worker.js`, `./strobe-worker.js` | same |
| `js/heart/heart.js:24`, `js/heart/engine.js:37-39`, `js/heart/route.js:83` | `./heart.wasm`, `./drain-worklet.js`, `./render-worker.js`, `./engine.js`, `./heart.js` | same |
| `v1/platform/worker-bridge.js:92` → `platform/worker-bridge.js` | `new URL('../worker-entry.js', import.meta.url)` | both ends move up together |

### 4.7 Written `v1/` paths in comments and docs: **172 to strip, plus 1 by hand**

The rule is `(?<![\w./-])v1/(?=[A-Za-z])` → (nothing). So `v1/core/store.js` becomes `core/store.js`, and `v1/ARCHITECTURE.md`, `v1/index.html`, `v1/main.js` become root names.

The lookbehind **protects**:
- the asset folders that end in `-v1/` (`celestial-v1/`, `motifs-v1/`, and 9 more, 18 mentions);
- the import paths (`../v1/`, already rewritten by the script);
- the URLs (`/v1/`, handled in 4.8).

Storage keys (`signal.v1.ui`) contain no `v1/` and are never touched.

| Area | Files (count) |
|---|---|
| `v1/ARCHITECTURE.md` | 55 (56 minus line 57, which is done by hand) |
| v1 code comments | `gpu/engine.js` 9, `core/schema-visual.js` 8, `core/schema-audio.js` 5, `core/schema-confetti.js` 5, `core/schema-particles.js` 5, `core/schema-fireworks.js` 2, `core/store.js` 2, `main.js` 2, `platform/web.js` 2, and 1 each in `core/broadcast.js`, `core/profiler.js`, `core/strobe.js`, `gpu/flowers.js`, `gpu/ui-renderer.js`, `index.html` (the `src`), `platform/host.js`, `input-queue.js`, `profile-web.js`, `worker-bridge.js`, `worker-platform.js`, `worker-shim.js` |
| shared `js/` comments | `piano.js` 7, `state.js` 7, `worklet.js` 6, `livesound.js` 5, `layer-defs.js` 3, `strobe-am.js` 3, `heart/nodes.js` 2, `panel-guard.js` 2, `background.js` 1, `choir.js` 1, `util.js` 1 |
| docs and other | `known-ussues.md` 8, `broadcast-worker/README.md` 3, `documents/heart-audio-engine.md` 1, `documents/broadcast-economics-and-av-blueprint.md` 1, `assets/kaleidoscope/*/README.md` 11 (one each), `heart/src/nodes/strobe_signal.rs` 2, `heart/src/nodes/genus.rs` 1 |

The **by-hand** item is `v1/ARCHITECTURE.md:57`: "**v0 files are read-only for v1 lanes.** Do not edit anything outside `v1/`." The rule's meaning changes with the move, so it is a contract decision. Propose this replacement to Robert and use it only on his yes: "**v0 is an archive.** Do not edit anything under `v0/`. Shared modules in `js/` run under both apps."

### 4.8 Other stale mentions and hard-coded URLs

**v0-only paths in comments and pages:** 41 occurrences in 18 files (`js/ui.js`, `js/text.js`, `js/framedata.js`, `js/shaders.js`, `js/main.js`, `js/ambience-mixer.js`, `css/style.css`). They are rewritten to `v0/js/…` and `v0/css/…` by one guarded perl command (Step 3). The files: `index.html` (3, incl. its `<link>` and `<script>`), `js/{display-watch,panel-guard,strobe-bridge,strobe-worker}.js` (1 each), `v1/ARCHITECTURE.md` (8), `v1/core/{atmosphere 3, schema-audio 4, schema-visual 5, strobe 2, words 1}`, `v1/gpu/{scene-data 1, scene 2, scene.wgsl 2}`, `v1/main.js` 1, `v1/platform/web.js` 1, `v1/ui/screens/mixer.js` 3, `v1/ui/theme.js` 1.

**Hard-coded URLs and by-hand edits:**

| # | File:line (old path) | Now | Change to |
|---|---|---|---|
| H1 | `v1/index.html:8-12` → `index.html` | the 4-line comment beginning `<!-- v1 reuses v0's audio modules` + `<base href="../">` | delete. **Must be deleted, not left:** on GitHub Pages' `/the-signal/` subpath a root base of `../` would point at `sonified.github.io/`. |
| H2 | `v1/platform/broadcast-socket.js:30` → `platform/…` | `const LIVE_PAGE = 'https://sonified.github.io/the-signal/v1/';` | `'https://presence.now.audio/'` if `curl -sI https://presence.now.audio/` answers 200. Otherwise `'https://sonified.github.io/the-signal/'` (drop `v1/` regardless), and tell Robert a second edit is due at DNS cutover. |
| H3 | same file `:52` | `: 'http://localhost:8000/v1/';` | `: 'http://localhost:8000/';` |
| H4 | same file `:43-46` (comment) | "the public GitHub Pages link" | "the public live link (LIVE_PAGE)" |
| H5 | `v1/gpu/flowers.js:29-30`, `v1/platform/web.js:9`, `v1/platform/worker-platform.js:22` (comments) | "v1/index.html sets <base href="../">" / "sets it to the repo root" (after the strip: "index.html sets …") | "relative to the page, which lives at the site root" |
| H6 | `v1/ARCHITECTURE.md:57` → `ARCHITECTURE.md` | lane rule | see 4.7, Robert's yes first |
| H7 | `tools/serve.mjs:126` | `<a href="/v1/" …>Open The Signal</a>` | `<a href="/" …>` |
| H8 | `tools/serve.mjs:136` | `` `The Signal: http://localhost:${PORT}/v1/  (cross-origin…` `` | same line with `/v1/` → `/` |
| H9 | `README.md:5` | `[Open The Signal](https://sonified.github.io/the-signal/)` (today opens **v0**) | `https://presence.now.audio/` (same DNS condition as H2) |
| H10 | `README.md:104` | `# http://localhost:8000/v1/ (a port …` | `# http://localhost:8000/ (a port …`. Optionally add after the block: "v0, the original DOM version, is archived at `/v0/`." |
| H11 | `broadcast-worker/README.md:31-33` | "choose Live page to copy a public GitHub Pages URL" | "choose Live page to copy the public site URL (`LIVE_PAGE` in `platform/broadcast-socket.js`)" |
| H12 | new `/_redirects` | | the three lines in section 3 |

Checked and **needing nothing**:
- The `?follow=` handling (the inline gate in `index.html`, `broadcastUrlIntent` at `broadcast-socket.js:125`) reads only `location.search`.
- The local follow link, `location.origin + location.pathname`, becomes `/` by itself.
- `RELAY_HOST` (`broadcast-socket.js:29`) is a workers.dev host.
- **The relay has no origin or CORS allow-list** (`broadcast-worker/src/index.js` checks only the WebSocket upgrade, `/room/<name>` and the key), so it needs no redeploy.
- The drawer's link-target labels (`drawer.js:969`) hold no URL.
- `<canvas id="v1">` and `getElementById('v1')` (`main.js:119`) are an element id, not a path. **Keep them.**
- `_headers`: its `/*` and `/audio/*` rules are unaffected.

### 4.9 Storage and path scoping

- **The app uses localStorage only.** It has no service worker, IndexedDB, cookies, sessionStorage, Cache API or BroadcastChannel.
- localStorage is per **origin**, so moving paths changes nothing for v0 or v1, which already share an origin.
- **Do not rename any key**, even the ones named "v1": `openfocus.v1` (and `.skip`, `.groups`), `signal.presets.v1`, `signal.journey.v1`, `signal.journeys.v1`, `signal.perform.v1`, `signal.broadcast.v1`, `signal.v1.ui`, `signal.v1.extra`, `signal.v1.live`, `signal.v1.worker`, `signal.v1.alwaysblit`, `signal.atmosphere.window.v1`, `signal_heart`, `signal_worker`, `signal_perf`, `signal_cloudlog`, `signal_guard_test`.
- **The domain change does lose the saved state.** sonified.github.io → presence.now.audio is a different origin. See section 7, which Robert must do himself.

### 4.10 Tests, tools and deploy files

| Item | Effect |
|---|---|
| `tools/heart-tests/*.mjs` (23 files) | Only `strobe-am.test.mjs:32` changes (4.3). The rest import `../../js/…` and `../../heart/protocol.json`, which don't move. |
| `tools/null-test.html` → `null-test.js` → `null-test-scenarios.js` | `../js/…` only: unchanged |
| `tools/serve.mjs` | H7, H8 |
| `tools/pack-*.cjs`, `tools/sync-kaleidoscope-manifests.mjs`, `tools/heart-protocol.mjs`, `heart/build.sh` | `assets/` and `js/heart/` paths: unchanged |
| `sandbox/*.html` | `../audio`, `../assets`, `takes/`: unchanged |
| Cloudflare Pages | **No `404.html`, so Pages runs in SPA mode: unknown paths return `/index.html` with status 200.** A missing module therefore surfaces as "Failed to load module script … MIME type text/html", and a missing JSON as a parse error. When debugging on Pages, read the body, not the status. |
| GitHub Pages | Jekyll drops `_redirects` and `_headers` (leading underscore); nothing else changes. |

Baseline: `check-paths.mjs` (section 6) reported **672 references in 184 files, 0 unresolved**, before and after the rehearsal.

---

## 5. The plan (ordered and mechanical)

All commands run from `cd /Users/robertalexander/GitHub/the-signal`. Save the two scripts (Appendix B `relocate-imports.mjs`, Appendix C `check-paths.mjs`) **in your scratchpad, not the repo**. `<scratch>` below means that folder.

### Step 0: Preconditions and baseline

```sh
git status --short          # must be empty (section 0)
git worktree list           # only the main checkout
grep -rhoE "['\"](\.\./)+(js|assets)/" v1 --include='*.js' | wc -l                              # 128
grep -rhoE "['\"](\.\./)+v1/" js tools sandbox --include='*.js' --include='*.mjs' | wc -l       # 6
grep -hoE "['\"]\.{1,2}/[^'\"]+['\"]" js/{main,renderer,ui,text,framedata,shaders,ambience-mixer}.js js/renderers/{webgl2,webgpu}.js | wc -l   # 57
# nothing outside the 9 v0-only files may import one of them (must print nothing):
grep -rnE "(\.\./)+js/(main|renderer|ui|text|framedata|shaders|ambience-mixer)\.js|(\.\./)+js/renderers/(webgl2|webgpu)\.js" v1 tools sandbox
# must list exactly js/main.js js/renderer.js js/renderers/webgl2.js js/renderers/webgpu.js js/ui.js:
grep -lE "['\"]\./(main|renderer|ui|text|framedata|shaders|ambience-mixer)\.js['\"]|['\"]\./renderers/(webgl2|webgpu)\.js['\"]|['\"]\.\./(shaders|framedata)\.js['\"]" js/*.js js/renderers/*.js
node <scratch>/check-paths.mjs                       # unresolved: 0
node --expose-gc --test tools/heart-tests/*.test.mjs tools/heart-tests/c2-*.mjs tools/heart-tests/family-*.test.mjs 2>&1 | tail -15
find . \( -path ./.git -o -path ./heart/target -o -path ./node_modules -o -path ./.claude \) -prune -o \
  -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print0 | xargs -0 -n1 node --check
```

Write down the test pass and fail set. If any count differs from this brief, find out why before going on.

### Phase A: archive v0

**Step 1: Moves**

```sh
mkdir -p v0/js/renderers v0/css
git mv index.html v0/index.html
git mv css/style.css v0/css/style.css && rmdir css
git mv js/main.js js/renderer.js js/ui.js js/text.js js/framedata.js js/shaders.js js/ambience-mixer.js v0/js/
git mv js/renderers/webgl2.js js/renderers/webgpu.js v0/js/renderers/
```

**Step 2: v0 imports**

```sh
node <scratch>/relocate-imports.mjs --phase=v0 --dry     # total that would change: 46
node <scratch>/relocate-imports.mjs --phase=v0           # total rewritten: 46
```

**Step 3: v0's page and the v0-path mentions**

First, insert this into `v0/index.html` directly after `<meta charset="utf-8">` (line 4), before any relative URL:

```html
<!-- Archived v0. The shared modules in /js fetch samples by paths relative
     to the page (audio/piano/...), so the page is based at the site root.
     Its own files are under v0/. -->
<base href="../">
```

Then rewrite the 41 v0-path mentions. These commands were tested in zsh: 18 files, 41 changes.

```sh
list() { grep -rlIE --exclude-dir=.git --exclude-dir=target --exclude-dir=node_modules --exclude=v1-to-root-migration.md \
  "js/(main|renderer|ui|text|framedata|shaders|ambience-mixer)\.js|js/renderers/(webgl2|webgpu)\.js|css/style\.css" . | tr '\n' '\0'; }
list | xargs -0 -n1 echo | wc -l     # 18
list | xargs -0 perl -ne '$c += () = m{(?<![\w./-])(?:js/(?:main|renderer|ui|text|framedata|shaders|ambience-mixer)\.js|js/renderers/(?:webgl2|webgpu)\.js|css/style\.css)}g; END { print "would change: $c\n" }'   # 41
list | xargs -0 perl -pi -e 's{(?<![\w./-])js/(main|renderer|ui|text|framedata|shaders|ambience-mixer)\.js}{v0/js/$1.js}g; s{(?<![\w./-])js/renderers/(webgl2|webgpu)\.js}{v0/js/renderers/$1.js}g; s{(?<![\w./-])css/style\.css}{v0/css/style.css}g'
node <scratch>/check-paths.mjs       # unresolved: 0 (v1 still works from /v1/ at this point)
```

Optional, **only on Robert's yes**: change v0's `<title>The Signal</title>` to `<title>The Signal (v0 archive)</title>`.

### Phase B: the live app moves to the root

**Step 4: Moves and imports**

```sh
# nothing may already exist at the destinations (must print nothing):
for n in index.html main.js worker-entry.js core gpu ui platform ARCHITECTURE.md documents/mist-transition-proposal.md; do test -e "$n" && echo "COLLISION $n"; done
git mv v1/index.html index.html
git mv v1/main.js v1/worker-entry.js v1/ARCHITECTURE.md .
git mv v1/core v1/gpu v1/ui v1/platform .
git mv v1/docs/mist-transition-proposal.md documents/
rmdir v1/docs v1                     # fails if anything is left; look, don't force
node <scratch>/relocate-imports.mjs --phase=v1 --dry     # total that would change: 134
node <scratch>/relocate-imports.mjs --phase=v1           # by direction: 126 v1->js/, 2 v1->assets/, 5 js/->v1, 1 tools/->v1
```

**Step 5: The root page**

In `index.html`, delete the comment `<!-- v1 reuses v0's audio modules … -->` and the `<base href="../">` line (H1). Leave `src="v1/main.js"` for Step 6, which turns it into `src="main.js"`.

**Step 6: Strip the 172 written `v1/` paths**

```sh
v1list() { grep -rlIE --exclude-dir=.git --exclude-dir=target --exclude-dir=node_modules --exclude=v1-to-root-migration.md "v1/" . | tr '\n' '\0'; }
v1list | xargs -0 perl -ne '$c += () = m{(?<![\w./-])v1/(?=[A-Za-z])}g; END { print "would change: $c\n" }'   # 172
v1list | xargs -0 perl -pi -e 's{(?<![\w./-])v1/(?=[A-Za-z])}{}g'
grep -n 'src=' index.html            # src="main.js"
```

**Step 7: By hand**

Make H2, H3, H4, H5 (three comments), H6 (Robert's yes), H7 through H11 with exact-string edits, and create `_redirects` (H12) with the three lines from section 3. Check the domain first with `curl -sI https://presence.now.audio/ | head -1`.

---

## 6. Verification

**Zero-hit greps.** Each must print nothing. Use a function, because zsh does not split a `$G` variable.

```sh
g() { grep -rnIE --exclude-dir=.git --exclude-dir=target --exclude-dir=node_modules --exclude=v1-to-root-migration.md "$@"; }
g '<base' index.html
g '(^|[^A-Za-z0-9_./-])v1/' .                                            # every written v1/ path is gone (asset "-v1/" folders don't match)
g '\.\./v1/|sonified\.github\.io/the-signal/v1|localhost:8000/v1|href="/v1/"|[}]/v1/' .
g '(^|[^A-Za-z0-9_./-])js/(main|renderer|ui|text|framedata|shaders|ambience-mixer)\.js|(^|[^A-Za-z0-9_./-])js/renderers/(webgl2|webgpu)\.js|(^|[^A-Za-z0-9_./-])css/style\.css' .
g 'index\.html sets|page base \(' core gpu platform                     # H5 done
ls -d v1 css js/main.js js/ui.js js/renderer.js js/text.js js/framedata.js js/shaders.js js/ambience-mixer.js js/renderers/webgl2.js js/renderers/webgpu.js 2>/dev/null
```

**Must succeed:**

```sh
grep -q 'src="main.js"' index.html && echo root-ok
grep -q '<base href="../">' v0/index.html && grep -q 'src="v0/js/main.js"' v0/index.html && grep -q 'href="v0/css/style.css"' v0/index.html && echo v0-ok
test -f js/renderers/canvas2d.js && test -f core/signal.js && test -f documents/mist-transition-proposal.md && test -f ARCHITECTURE.md && echo files-ok
grep -c '/v1' _redirects        # 3
node <scratch>/check-paths.mjs  # "checked ~672 references …, unresolved: 0"
```

**Syntax, for all ~177 JS files.** Expect no output:

```sh
find . \( -path ./.git -o -path ./heart/target -o -path ./node_modules -o -path ./.claude \) -prune -o \
  -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print0 | xargs -0 -n1 node --check
```

**Heart tests.** The pass and fail set must match the Step 0 baseline. `family-*` runs twice because `*.test.mjs` already matches it, so compare sets, not totals.

```sh
node --expose-gc --test tools/heart-tests/*.test.mjs tools/heart-tests/c2-*.mjs tools/heart-tests/family-*.test.mjs
```

**`git status`** shows `R` renames for every moved file (102), a new `_redirects`, and edits only where sections 4 and 5 say.

### Robert's browser checklist (`node tools/serve.mjs`)

Robert does his own browser testing. Hand him this list and do not drive the browser yourself.

1. **http://localhost:8000/**: v1 boots with the `[boot]` console lines. In DevTools Network, filtered for failures, there are none. Requests go to `/main.js`, `/core/…` and `/js/state.js`, with no `/v1/…`.
2. Start sound: piano, clouds, choir, ambience and a music layer. Files come from `/audio/…` with 200 or 206.
3. Turn on Kaleidoscope and Flowers. Images load from `/assets/…`.
4. Set Render → Engine thread to worker, reload, and check it still boots and draws. The worker is `/worker-entry.js`. Set it back if he prefers main.
5. Visit `/?heart=all`. `crossOriginIsolated` is true and `/js/heart/heart.wasm` loads.
6. Broadcast: the Live page target copies `https://presence.now.audio/?follow=…` (or the GitHub Pages root, per H2). The Localhost target copies `http://localhost:8000/?follow=…`, and that link shows "Tap to join the live stream".
7. **http://localhost:8000/v0/**: v0 boots, styled, with sound. Requests go to `/v0/js/main.js`, `/v0/css/style.css`, `/js/audio.js` and `/audio/…`.
8. Presets, journeys and settings saved before the move are all still there (same origin).
9. `http://localhost:8000/v1/` shows the local "Nothing here" page (serve.mjs has no redirects), and its link opens `/`. `http://localhost:8000/tools/null-test.html` still runs.

### On Cloudflare, before pointing DNS (a hard gate for `_redirects`)

Run these against the production `<project>.pages.dev` URL Robert gives you:

```sh
H=https://<project>.pages.dev
curl -sI "$H/v1/?follow=gate-test" | grep -iE '^(HTTP|location)'   # 301 and location: /?follow=gate-test   <- THE GATE
curl -sI "$H/v1"                   | grep -iE '^(HTTP|location)'   # 301 and location: /
curl -sI "$H/v1/core/store.js"     | grep -iE '^(HTTP|location)'   # 301 and location: /core/store.js
curl -sI "$H/" | grep -iE '^(HTTP|cross-origin|cache-control)'     # 200, COOP/COEP/CORP, must-revalidate
curl -s  "$H/" | grep -c 'src="main.js"'                            # 1
curl -s  "$H/v0/" | grep -c 'v0/js/main.js'                         # 1
curl -sI "$H/js/heart/heart.wasm" | grep -i content-type            # application/wasm
curl -sI "$H/audio/piano/lekko-00.opus" | grep -i cache-control     # immutable
```

**If the `location` header loses `?follow=gate-test`, use the section 3 fallback** (the stub page instead of the `/v1` lines) before DNS goes live.

---

## 7. Robert: carry your saved state to the new domain

**Why:** browsers keep saved data per site address. Everything The Signal remembers on `sonified.github.io` (presets, hearted presets, journeys, perform settings, the broadcast key and sessions, mixer and drawer state) **will not appear on presence.now.audio**. It needs one copy and paste, on each browser and machine you use. Your phone keeps its own copy, and so does each machine. Localhost is unaffected.

**Do it once, after presence.now.audio is live and before you use it much.** Pasting overwrites anything the new site has saved under the same names.

1. In **Chrome**, open **https://sonified.github.io/the-signal/**.
2. Open the console: **View → Developer → JavaScript Console** (⌥⌘J).
3. Paste this line and press Return. It copies only The Signal's keys, because `sonified.github.io` is shared with your other GitHub Pages projects.

   ```js
   copy(JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => /^(signal|openfocus)/.test(k)))))
   ```

   If Chrome says pasting is blocked, type `allow pasting`, press Return, and paste again. Nothing visible happens: the data is now on your clipboard.
4. Optional: paste it into a note as a backup copy.
5. Open **https://presence.now.audio/** and open its console the same way (⌥⌘J).
6. Type `const saved = `, paste (⌘V), and press Return.
7. Paste this line and press Return:

   ```js
   Object.entries(saved).forEach(([k, v]) => localStorage.setItem(k, v)); location.reload();
   ```

8. The page reloads with your presets, journeys and settings. Open the drawer and check that a favourite preset is there.

To check before copying, run `Object.keys(localStorage).filter(k => /^(signal|openfocus)/.test(k))` on the old site. That lists what will travel.

---

## 8. Risks and rollback

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Concurrent agents** writing to old paths. | Run only in a quiet, clean repo (section 0). |
| R2 | **Counts drifted** since the survey. | Step 0 recounts. The relocation script recomputes from the real files and throws on any target that doesn't exist. `check-paths.mjs` catches the rest. |
| R3 | **Base tag left in the root page.** Unnoticed on presence.now.audio, broken on the GitHub Pages subpath. | H1 and the first zero-hit grep. |
| R4 | **The `_redirects` query behaviour is undocumented.** | The pages.dev gate in section 6, with the stub fallback. |
| R5 | **Pages SPA fallback masks 404s** as HTML 200. | Read response bodies when debugging. Adding a `404.html` is Robert's call, not part of this migration. |
| R6 | **Saved state stays on the old origin.** | Section 7. |
| R7 | **LIVE_PAGE points at a domain that isn't live yet.** | H2 is conditional; report the value you chose. |
| R8 | **Old GitHub Pages `/v1/` links 404** (GitHub Pages ignores `_redirects`). | Ephemeral session links. Add the stub only if Robert wants the overlap covered. |
| R9 | **Every open branch, worktree and agent brief names `v1/…` paths.** Robert's memory notes hold 25 `v1/` mentions across 8 files (`project-v1-is-live.md`, `project-core-signal.md`, `project-variance-pattern.md`, `project-live-sound.md`, `project-broadcast-relay.md`, `project-journey-mode.md`, `project-preset-recall-phase-jump.md`, `MEMORY.md`). `project-v1-is-live.md` becomes outright wrong ("work in v1/ only; root js/ + index.html is v0 archive"). | Don't edit memory yourself. Tell Robert and the coordinator that these notes need updating to "the app's code is at the root (`core/ gpu/ ui/ platform/ main.js`); v0 is archived in `v0/`". Land or close branches before starting. |
| R10 | **The strip changes prose meaning in one place** (ARCHITECTURE.md:57). | Done by hand with Robert's yes (H6). Read the `git diff --stat` and spot-check `ARCHITECTURE.md`. |
| R11 | **Mid-migration states are broken.** After Phase A, v1 still works from `/v1/` and v0 from `/v0/`. Between Step 4 and Step 6, the root page still says `src="v1/main.js"`. | Don't stop between Steps 4 and 7. Never push between phases. |

**Rollback:**

- **Before any commit, fix forward.** Every step is a `git mv` or a deterministic rewrite, so a mistake is corrected in place: re-run a script with `--dry` to see what it would do, or `git mv` a misplaced file. The text rewrites (Steps 3 and 6) are not mechanically reversible, because the strip forgets which `core/…` mentions said `v1/core/…`. **Do not try to hand-reverse them.**
- **Abandoning the whole migration before committing** is safe only because Step 0 required a clean tree at a known commit. Even so, `git reset --hard <that commit>` plus deleting the new untracked items (`_redirects`, and anything `git status` lists as `??`) is destructive. **Run it only after Robert explicitly says to discard the migration.**
- **After commit**, and only at Robert's request: `git revert <commit B>`, then `git revert <commit A>`, as new commits. Never reset a pushed branch or force-push.

---

## 9. Commits (only if Robert asks)

Use two commits, each self-consistent, with plain messages and no AI attribution:

- **A, "Archive v0 under v0/":** Steps 1-3. That is the v0 moves, the 46 import rewrites, v0's base, and the 41 path-mention edits (which touch a few `v1/` and `js/` comment files). After A alone, both apps run: v1 at `/v1/` and v0 at `/v0/`. `/` has no page, which is fine because A and B are never pushed apart.
- **B, "Serve the live app from the site root":** Steps 4-7. That is the v1 moves, the 134 import rewrites, the 172-path strip, the hard-coded URLs and `_redirects`.

If Robert says "push", his standing rule applies: commit everything in the working tree in logical groups, then push.

---

## 10. What NOT to touch

- **localStorage key names**, including every `signal.v1.*` and `openfocus.v1*` key, and the `_v1w` field.
- The element id `v1` (`<canvas id="v1">`, `getElementById('v1')`).
- The asset folders whose names end in `-v1/`, and their files.
- `js/` file names and locations other than the 9 v0-only files. `js/heart/`, `audio/`, `assets/`, `icons/`, `manifest.webmanifest`, `stereo.html`, `sandbox/`, `reflections/`, `heart/` except its 3 comment strips (and never `heart/target/`), `broadcast-worker/src/` and `wrangler.toml`, `_headers`, `.gitignore`.
- Imports inside v1's own tree: they move together and stay correct.
- No "while I'm here" extras: no `404.html`, no service worker, no manifest or PWA tags on the root page, no redirect support in `serve.mjs`, no moving `affirmations.js` or `livesound.js`, no renaming `js/`. Propose these in your report instead.

---

## 11. Pre-existing issue (out of scope: report it, don't fix it)

In worker engine mode, the app's `main.js` runs inside the worker, where `location` is the **worker's** URL, with no query. So `broadcastUrlIntent()` (`broadcast-socket.js:125`) never sees `?follow=`. And `makeFollowUrl(…, 'local')` builds a link to the worker script: today `/v1/worker-entry.js?follow=…`, after the move `/worker-entry.js?follow=…`. `worker-bridge.js` posts `baseURI` to the worker but not the page's `search` or `pathname`. Main-thread mode, the default, is unaffected. This comes from reading the code and has not been reproduced in a browser.

---

## Appendix A: Stub page (only for the fallback, or the GitHub Pages overlap)

Save as `v1/index.html`. On Cloudflare it is served only if no `_redirects` rule matches `/v1/`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The Signal</title>
<!-- The app lives at the site root. Old links (/v1/, /v1/?follow=room) land
     here and go on with their query and hash intact. -->
<script>location.replace('../' + location.search + location.hash);</script>
<noscript><meta http-equiv="refresh" content="0; url=../"></noscript>
</head>
<body style="background:#000"><a href="../" style="color:#b9c6d4">The Signal has moved</a></body>
</html>
```

## Appendix B: `relocate-imports.mjs` (rehearsed: phase v0 → 46, phase v1 → 134)

It resolves every relative specifier and module-relative `new URL()` against the file's **old** location, maps it through the move, and recomputes it from the file's **new** location, keeping any `?query`. It throws on a target that doesn't exist. Run it from the repo root after the moves of its phase.

```js
import fs from 'node:fs';
import path from 'node:path';
const P = path.posix;
const DRY = process.argv.includes('--dry');
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=all').slice(8); // v0 | v1 | all
const DO_V0 = PHASE !== 'v1', DO_V1 = PHASE !== 'v0';

const V0 = ['js/main.js', 'js/renderer.js', 'js/ui.js', 'js/text.js', 'js/framedata.js',
  'js/shaders.js', 'js/ambience-mixer.js', 'js/renderers/webgl2.js', 'js/renderers/webgpu.js'];
const V1_TOP = new Set(['index.html', 'main.js', 'worker-entry.js', 'core', 'gpu', 'ui', 'platform', 'ARCHITECTURE.md']);

const oldToNew = p => {
  if (DO_V0 && V0.includes(p)) return 'v0/' + p;
  if (!DO_V1) return p;
  if (p.startsWith('v1/docs/')) return 'documents/' + p.slice('v1/docs/'.length);
  if (p.startsWith('v1/')) return p.slice(3);
  return p;
};
const newToOld = p => {
  if (DO_V0 && p.startsWith('v0/') && V0.includes(p.slice(3))) return p.slice(3);
  if (DO_V1 && V1_TOP.has(p.split('/')[0])) return 'v1/' + p;
  return p;
};

const SKIP = new Set(['.git', 'node_modules', 'target', 'audio']);
const files = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d === '.' ? e.name : P.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); }
    else if (/\.(m?js|cjs)$/.test(e.name)) files.push(p);
  }
};
walk('.');

const RE = /(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*|new URL\(\s*)(['"`])(\.{1,2}\/[^'"`]+)\2/gm;
const tally = {};
let total = 0;
for (const f of files) {
  const oldF = newToOld(f);
  const src = fs.readFileSync(f, 'utf8');
  let n = 0;
  const out = src.replace(RE, (m, pre, q, spec, offset) => {
    if (pre.startsWith('new URL') && !/^\s*,\s*import\.meta\.url/.test(src.slice(offset + m.length))) return m;
    const cut = spec.search(/[?#]/);
    const bare = cut < 0 ? spec : spec.slice(0, cut), tail = cut < 0 ? '' : spec.slice(cut);
    const oldT = P.normalize(P.join(P.dirname(oldF), bare));
    const newT = oldToNew(oldT);
    let rel = P.relative(P.dirname(f), newT);
    if (!rel.startsWith('.')) rel = './' + rel;
    if (rel + tail === spec) return m;
    if (!fs.existsSync(newT)) throw new Error(`${f}: ${spec} -> ${rel} (${newT}) does not exist`);
    n++;
    const key = (oldF.startsWith('v1/') ? 'v1 code' : V0.includes(oldF) ? 'v0 code' : oldF.split('/')[0] + '/') + ' -> ' +
      (oldT.startsWith('v1/') ? 'v1 code' : V0.includes(oldT) ? 'v0 code' : oldT.split('/')[0] + '/');
    tally[key] = (tally[key] || 0) + 1;
    return pre + q + rel + tail + q;
  });
  if (n) { total += n; if (!DRY) fs.writeFileSync(f, out); console.log(String(n).padStart(3), f); }
}
console.log('\nby direction:'); for (const k of Object.keys(tally).sort()) console.log(String(tally[k]).padStart(4), k);
console.log(`total ${DRY ? 'that would change' : 'rewritten'}: ${total} (expected: phase v0 46, phase v1 134, all 180)`);
```

## Appendix C: `check-paths.mjs` (0 unresolved before, between and after the phases)

It checks every relative module specifier, every module-relative `new URL()`, and every `<script src>` and `<link href>` in the pages, honouring `<base>`.

```js
import fs from 'node:fs';
import path from 'node:path';
const P = path.posix;
const ROOTS = ['index.html', 'main.js', 'worker-entry.js', 'core', 'gpu', 'ui', 'platform', 'v0', 'v1', 'js', 'tools', 'sandbox', 'assets/kaleidoscope/sets.mjs']
  .filter(r => fs.existsSync(r));
const SKIP = new Set(['node_modules', 'target', '.git']);
const files = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = P.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); }
    else if (/\.(m?js|cjs|html)$/.test(e.name)) files.push(p);
  }
};
for (const r of ROOTS) fs.statSync(r).isDirectory() ? walk(r) : files.push(r);
const JS_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"`]([^'"`]+)['"`]/g,
  /new URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url/g
];
let n = 0, bad = 0;
const check = (from, base, spec) => {
  n++;
  const t = P.normalize(P.join(base, spec.split(/[?#]/)[0]));
  if (!fs.existsSync(t)) { bad++; console.log('UNRESOLVED', from, spec, '->', t); }
};
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let base = P.dirname(f);
  if (f.endsWith('.html')) {
    const b = /<base\s+href="([^"]*)"/i.exec(src);
    if (b) base = P.normalize(P.join(base, b[1]));
    for (const m of src.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"#:]+)"/g)) check(f, base, m[1]);
  }
  for (const re of JS_RES) for (const m of src.matchAll(re)) if (m[1].startsWith('.')) check(f, f.endsWith('.html') ? base : P.dirname(f), m[1]);
}
console.log(`checked ${n} references in ${files.length} files, unresolved: ${bad}`);
process.exit(bad ? 1 : 0);
```
