# TSC 2026 cloud presentation backup

Operational handoff for humans and AI agents. Created and tested October 11, 2026 from the `sun-layer` working tree. The presentation has already been deployed; the files below reproduce its packaging. Deployment does not require changing the main `presence.now.audio` site or the relay.

## Links and starting a show

| Purpose | URL |
| --- | --- |
| Presentation entry / password form | https://presence-presentation.pages.dev/presentation.html |
| iPad show controller | https://presence-presentation.pages.dev/show.html |
| Receiving app, after authentication | https://presence-presentation.pages.dev/?remote |
| Frozen presentation build | https://50cb7ae7.presence-presentation.pages.dev/presentation.html |
| Frozen controller build | https://50cb7ae7.presence-presentation.pages.dev/show.html |
| Generated build metadata | https://presence-presentation.pages.dev/presentation-build.json |

Cloudflare may redirect `.html` addresses to the equivalent extensionless path. Both forms work. Use the presentation entry on a new computer: going directly to `?remote` without its saved password does not authenticate the receiver.

1. Open the presentation entry on the presentation computer and enter the existing show password. It POSTs to the existing relay's `/auth`, saves `mirror.pw` in localStorage, and opens the app with `?remote`.
2. Complete the app's normal safety/audio activation flow as needed. Use a WebGPU-capable browser and the **page-thread** engine; the show remote does not run in worker-engine mode.
3. Open the controller link on the iPad and enter the same password. Both sides default to room `show`. Keep the receiving app visible in its own window: background tabs can suspend the frame loop, video, or audio.
4. Confirm a screen is connected and the dot between **room** and its name is green, then cue the show. The Journey is installed but does not automatically start playing.

For an isolated rehearsal, use `/presentation.html?room=backup-test` and `/show.html?room=backup-test`. The entry carries the room into `?remote=backup-test`. Never send QA cues into the live `show` room. The frozen URLs must use the frozen controller too if you want both sides to run the exact deployed versions.

The password authenticates relay access. It does **not** make the Pages app or media URLs private. Do not put passwords, `.mirror-key`, API tokens, or secret-bearing URLs in documentation, commits, deployed files, or tool output.

## Hosting and runtime architecture

| Component | Current setup |
| --- | --- |
| Standalone Cloudflare Pages project | `presence-presentation` |
| Production deployment branch | `presentation` |
| Existing main site project, left separate | `presence-generator`, production `main`, custom domain `presence.now.audio` |
| Cloudflare account ID | `66f906f29f28b08ae9c80d4f36e25c7a` |
| Existing cloud relay | `the-signal-broadcast.robertalexander-music.workers.dev` |
| Command / status rooms | `mirror-<room>` / `mirror-<room>-status` |
| R2 bucket | `solarmeditation-media` |
| Pages Function R2 binding | `SLIDE_MEDIA` |
| Slide media release | `32e9063c8f301554` |
| R2 slide key prefix | `the-signal/presentation/32e9063c8f301554/slides/` |
| Journey revision | `bfa7e1c112732329` |
| Deployed build ID | `50cb7ae7` |

The computer runs the actual WebGPU/audio app. The iPad sends commands through the existing Cloudflare WebSocket relay; the receiver executes them and reports its Journey, controls, and actual video clock. The iPad preview is a local, silent derivative, not a screen capture streamed from the computer.

Static code, audio, images, previews, and posters are Pages assets. Full slide MP4 requests go through a Pages Function to R2, staying under the presentation site's own origin. This preserves the existing `/slides/<filename>` app URLs and supports seeking, audio routing, and GPU video imports without introducing cross-origin slide URLs.

Pages has a [25 MiB limit per static asset](https://developers.cloudflare.com/pages/platform/limits/); seven slide videos exceed that. All 14 full videos use R2 for a consistent delivery path. There is no new relay Worker or separate player app.

The Sun layer still uses `gpu/sun.js` and its existing cloud mosaic sources under `https://pub-716b01aa42b4455891728323b3586b99.r2.dev/`. Those sources were already uploaded; this deployment did not duplicate or replace them. On localhost, Sun first uses `/sun-video/`, with cloud fallback. Preserve the existing R2 CORS configuration needed for Sun's cross-origin GPU imports.

## Journey installation and saving

The authoritative bundled export is [tsc-2026-journey.json](tsc-2026-journey.json): raw Journey v2, 16 steps, keys mode/trigger, autoplay off, looping off. The builder validates that every step's `slideFile` exists in the media manifest.

The generated `presentation-seed.js` is a blocking script inserted before `main.js` in staged `index.html`. Before app modules read storage, it:

- Imports the exact exported Journey as a new `jN` item titled **TSC 2026** into `signal.journeys.v1`.
- Stores the scene under `signal.journey.v1.jN` and makes it current, preserving existing library items.
- Sets the once-per-export marker `signal.presentationJourney.bfa7e1c112732329`.

Reloads preserve edits and do not duplicate or overwrite the Journey. A changed export produces a different SHA-256 revision marker, importing a new library item on first app load for that revision. Deploying unchanged Journey bytes does not force it to become current again if the user selected another Journey. Changing only code/media does not reset local edits.

localStorage and IndexedDB belong to the browser profile and origin. The stable Pages domain, frozen deployment domain, local site, and main site each have separate storage. This is not cloud synchronization of authored Journeys. Export changes and rebuild/redeploy to publish them. The export carries step scenes, overrides, sequencer and mix data; it is not a complete browser-session backup and does not include the show password or every global operator setting.

**Authoring versus performance:** `platform/show-remote.js` wraps remote schema writes with `journeyPerformanceControl` in `core/journey.js`. iPad faders update the live scene/session without automatically recording them into steps, even when the Journey window is open and ACTIVE. The row's **snapshot** button, immediately left of delete, calls `journeySnapshotStep(i)` to explicitly capture the current scene, sequencer, and mix into that step. It preserves the step's text and transport fields. The controller then receives the recalled step's live state through ordinary status reporting.

The Journey UI keeps **P-Ramp** (tooltip “Parameter Ramp Time”) above **XFADE**. They control separate transitions. A slide's saved crossfade is used for its transition directly; it is not slowly ramped from the previous slide's time. XFADE UI steps are 0.5 seconds and show one decimal. Slide rows hide Text, Piano, Preset, and Interaction controls.

In the supplied export, step 15 **QR + Sun 🌞** and step 16 **Guided Meditation 🎵🌞🎵** have 10-second parameter ramps. Step 15 has a 3-second slide crossfade. The preceding outgoing video can remain visible during this transition; wait for the saved ramp before judging Sun opacity. The deployed Sun plus QR image was visually checked after that ramp.

## iPad controller behavior in this build

`show.html` owns the controller; `platform/show-remote.js` owns the receiver. Commands are numbered by `(src, n)` so dual-route delivery acts once, using the first arrival. The staged controller's default **Switch to Cloud** target is `presence-presentation.pages.dev`; the builder changes that only in the staged copy. The repository's ordinary controller retains its existing cloud fallback.

Three distinct indicators matter:

- The dot next to **cloud/local** means the command WebSocket is open to that relay.
- The milliseconds are relay round-trip measurements, probed on connection and in bursts every 10 seconds. The screen count is relay membership, which can drop immediately on a clean receiver disconnect. Neither proves the app is rendering.
- The dot between **room** and its name means a receiver replied after completing a frame, through that route's status socket. Health probes run every 1 second; replies expire after 3 seconds. This detects a connected but frozen/background app. Ordinary socket keepalive pings run every 20 seconds.

Receiver state is checked for changes every 250 ms. It includes the actual slide's file, current time, duration, actual playback rate, and loop state. The preview extrapolates that clock locally between reports. It follows the receiving computer rather than independently predicting a cue's start.

All 14 cue previews are silent **144p, 30fps** clips, about **11.1 MB total**, plus about 93 KB of posters. `platform/cue-previews.js` downloads clips in the background and caches their complete Blobs and manifest in IndexedDB `signal-cue-previews` / `assets`, keyed with their hashes. It requests persistent storage best-effort; browsers can still deny it or clear/evict data. This cache covers previews, not the full presentation's 420.9 MB videos or a complete offline app.

One muted inline video animates inside the playing cue; future cues show their posters. `platform/preview-clock.js` performs initial alignment and bounded correction instead of constantly forcing seeks. Gear → **Preview delay compensation** defaults to 50 ms, ranges 0–500 ms in 5 ms steps, and persists as `show.previewDelayMs`. It advances the preview's target clock; operator-selected values such as 200 ms survive reload.

Slide playback speed uses a **25 ms exponential time constant** in `gpu/slides.js`, including proper handling of a target of zero. The controller's speed range is stop–1× with a detent near 1×. The smoother controls native slide playback; Sun has its own speed behavior.

**Defaults** is an explicit performance action, not startup automation or a Journey rewrite. It sends LP open, HP open, Speed 1×, Volume 100%; Drone, Piano, Choir, Ambience, Hum, Sun, Wind, and Heart faders to their bottom positions; Screen and MWTS to their top positions. A bottom Hum/Sun position is their defined minimum speed, not necessarily silence or a disabled layer. Main Volume is distinct from the laptop drawer's per-slide/master slide level.

## Repository and generated files

| File | Responsibility |
| --- | --- |
| `documents/tsc-2026-journey.json` | User-supplied Journey to bundle |
| `documents/tsc-2026-media-manifest.json` | Full-video filenames, sizes, SHA-256 hashes, bucket and immutable prefix |
| `tools/build-cloud-presentation.mjs` | Builds a separate deployment directory |
| `tools/presentation-entry.html` | Password entry and controller link |
| `tools/presentation-media-handler.mjs` | Actual R2 media request handler |
| `tools/presentation-media.test.mjs` | Handler tests using Node's built-ins |
| `slides/` | Ignored local full videos, previews, and QR asset |
| `slides/previews/144p-30fps/manifest.json` | Preview inventory, distinct from full-video manifest |
| `_headers` | Isolation headers and cache policy for static assets |

Generated only in staging: `presentation.html`, `presentation-seed.js`, `presentation-build.json`, root `presentation-media-handler.mjs`, `functions/slides/[[path]].js`, `_routes.json`, and `wrangler.jsonc`.

The builder reads **tracked working-tree content**, including modifications, through `git ls-files`. It skips dot-prefixed paths and `documents/`, then explicitly copies ignored previews and `slides/qr_overlay_live@2x.png` plus its own source templates. Arbitrary new untracked runtime modules are not included: make sure they are in the tracked inventory or explicitly packaged before deploying. The full videos are never copied into Pages staging.

Functions run only for `/slides/*`, excluding `/slides/previews/*` and `/slides/*.png`. The handler allows only MP4 filenames in the full-video manifest, supports GET/HEAD, ETag revalidation, single bounded/open/suffix byte ranges, If-Range, 206 and 416 responses, and verifies R2 object size against the manifest. It sets `video/mp4`, `Accept-Ranges: bytes`, and `Cross-Origin-Resource-Policy: same-origin` itself because Pages static `_headers` do not apply to Function responses. Its public URL revalidates because a later build can change that URL's content; uploaded release objects have immutable caching.

## Rebuild and deploy

Run from the repository root. The project already exists: do not recreate it or point the deployment at `presence-generator`. Wrangler needs existing Cloudflare authentication with access to Pages/R2; never echo the token. There is no Git push or commit requirement for a direct Pages deployment.

First validate the handler:

```sh
node tools/presentation-media.test.mjs
node --check tools/build-cloud-presentation.mjs
node --check tools/presentation-media-handler.mjs
git diff --check
```

Build into a **new, empty directory under `/private/tmp/`**. The builder rejects nonempty destinations and other locations. Choose a fresh suffix for each attempt; do not delete someone else's staging directory.

```sh
node tools/build-cloud-presentation.mjs \
  /private/tmp/signal-presentation-site-next \
  documents/tsc-2026-media-manifest.json \
  documents/tsc-2026-journey.json
```

Verify `presentation-build.json`, the generated seed, preview inventory, QR image, Function and routes before deployment. Staged `wrangler.jsonc` sets `pages_build_output_dir: "."`, compatibility date `2026-10-01`, and binding `SLIDE_MEDIA` to the manifest bucket. Do not add `account_id` to this Pages configuration; it was rejected by Wrangler's Pages validation.

Deploy **from the staging directory** using the existing project's production branch:

```sh
cd /private/tmp/signal-presentation-site-next
WRANGLER_SEND_METRICS=false npx wrangler pages deploy . \
  --project-name presence-presentation \
  --branch presentation
```

The tested deployment used Wrangler **4.133.0**. On this Mac its cached CLI was `/Users/robertalexander/.npm/_npx/c943b712072b77c4/node_modules/wrangler/bin/wrangler.js`; that cache path is incidental. If using that exact CLI, replace `npx wrangler` with `node <that-path>`. Set `WRANGLER_LOG_PATH` to a task-specific file under `/private/tmp/` if needed. The project was originally created with `pages project create presence-presentation --production-branch presentation --force` to bypass Wrangler's Workers-first creation behavior; existing-project deployments do not need `--force`.

The initial staging directory was `/private/tmp/signal-presentation-site`. Temp staging and logs are not durable source files. The manifest in `documents/` is the durable inventory; do not depend on the initial temp manifest. New deployments may need a short propagation interval before URLs respond successfully.

### Changing the video set

Rebuilding with the existing manifest reuses already uploaded videos. If a video changes:

1. Validate the optimized local MP4s, including fast-start placement of `moov` before `mdat`, codecs, and seek behavior. Preserve the filenames referenced by the Journey or update those references deliberately.
2. Generate a new manifest with every video's exact byte count and whole-file SHA-256, and choose a **new immutable release prefix**. Keep earlier objects for frozen builds. Do not overwrite objects under release `32e9063c8f301554`.
3. Upload every manifest video to its new R2 key before publishing the app. The manifest generator/upload orchestration used for the first release was temporary; the committed builder does not generate hashes or upload media for you.
4. Regenerate affected 144p previews/posters and their separate manifest if needed. Check that source names and the controller's cue prefixes still match.
5. Build, deploy, and verify the new release before replacing the operational links in documentation.

Example for one file, substituting the new release and filename:

```sh
npx wrangler r2 object put \
  'solarmeditation-media/the-signal/presentation/NEW_RELEASE/slides/FILE.mp4' \
  --file 'slides/FILE.mp4' --remote \
  --content-type video/mp4 \
  --cache-control 'public, max-age=31536000, immutable'
```

The full-video manifest currently has **14 videos, 420,880,359 bytes**. It is the authoritative inventory rather than a directory scan, so unused local files are not published by the media Function. Sun mosaic objects are a separate existing inventory; do not modify them while uploading slides.

## Local router / no-internet fallback

The cloud backup requires WAN internet on both devices. For the original Mac and iPad on the same pocket-router Wi-Fi, use the existing local setup:

```sh
node tools/serve.mjs        # app, port 8000; isolation headers and byte ranges
node tools/mirror-local.mjs # controller + local relay, port 8800
```

Open `http://localhost:8000/?remote` on the Mac and `http://Roberts-MacBook-Pro-2.local:8800/show.html` on the iPad, substituting the actual hostname or LAN IP. The receiver still needs its existing `mirror.pw`; local relay auth reads `MIRROR_KEY` or the ignored `.mirror-key` file. Use the existing private password setup, never a committed secret. Ensure local full videos and `sun-video/` copies are present before relying on an offline show; cloud fallback cannot help without internet.

The HTTP-served controller can use both local and cloud paths when available. The HTTPS cloud controller uses cloud transport; it cannot simply open insecure `ws://` connections to the laptop. From the local controller, an explicit `?cloud=https%3A%2F%2Fpresence-presentation.pages.dev` selects this backup for **Switch to Cloud**. Use `?mac=<host:8800>` to override the laptop destination when switching back from the cloud page.

## Verification and known limits

Completed on the actual deployed site, using an isolated test room and native Chromium on an Apple Metal WebGPU adapter:

- All 14 media HEAD responses returned the correct sizes. First and last 4,096-byte ranges returned 206 and matched the local files; invalid ranges returned 416.
- Static isolation headers, preview manifest, password form and real relay authentication worked.
- A fresh browser received the exact 16-step Journey, titled TSC 2026; reload preserved it without another library item. Separate seed tests preserved an existing library and edits.
- Separate presentation/controller browser instances completed the frame-based health round trip. Audification played, its cue preview animated, and a controller seek to 45% moved the actual full video to about 53 seconds.
- Touching the Sun played from the cloud route. QR + Sun showed the actual Sun video and QR after its parameter ramp; Guided Meditation loaded its step. No browser page errors were recorded.
- Handler tests covered methods, missing binding/objects, incorrect size, full and ranged delivery, HEAD, ETags, If-Range and static fallback.

The first QA attempt placed both pages in tabs of one browser and hid the presentation tab, correctly causing health to expire. Use separate visible windows/devices. An initial brief Pages propagation error cleared once the deployment became available.

QA audio was muted, and the actual venue computer and the user's iPad/Safari were not used for this cloud rehearsal. Before presenting, verify those devices' WebGPU support, audio activation/output, preview smoothness, venue network and display behavior. Full videos stream as native media; this setup does not pre-download the entire show for guaranteed offline playback. Keep the working local setup and exported Journey as the independent fallback.
