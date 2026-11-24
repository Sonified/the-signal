# Talks: start here

Robert gives his talks from this app. If he asks about a talk, the presentation, the slides, the show, the iPad controller or cues, read this page first. It is the map. The deep reference is [documents/cloud-presentation-backup.md](documents/cloud-presentation-backup.md).

This repository is public. Keep passwords, keys and private material out of every file here.

## The two pages

A talk is two web pages that talk to each other through a relay.

| Page | Runs on | What it is |
| --- | --- | --- |
| **Presentation** | the laptop on the projector | The app itself (`index.html`) opened with `?presentation`. It plays the slides, sound and visuals. |
| **Controller** | the iPad Robert carries | [controller.html](controller.html). A cue list and faders. It sends commands and plays nothing itself. |

Tapping a cue on the controller makes the presentation jump to that step. The faders ride volume, filters, slide speed and the finale's layers live.

## Where to open them

| Setup | Presentation | Controller |
| --- | --- | --- |
| **Main site** (latest code) | https://presence.now.audio/presentation | https://presence.now.audio/controller |
| **Standalone backup** (frozen October 11, 2026 build) | https://presence-presentation.pages.dev/presentation.html | https://presence-presentation.pages.dev/controller.html |
| **Local, no internet** | `http://localhost:8000/?presentation` | `http://<mac-name>.local:8800/controller.html` |

For the local setup, run both servers from the repository root:

```sh
node tools/serve.mjs        # the app, port 8000
node tools/mirror-local.mjs # the controller page and a local relay, port 8800
```

Both pages join room `show` unless told otherwise. To rehearse without touching a live show, give both the same other room: `?presentation=rehearsal` on the app and `?room=rehearsal` on the controller.

## How it works

- **The Journey is the deck.** A Journey is an ordered list of steps. Each step holds a scene (sound and visual settings) and may name one slide video. The talk's Journey is [documents/tsc-2026-journey.json](documents/tsc-2026-journey.json), 16 steps.
- **Presentation mode installs it.** Settings → Presentation mode asks for a gate password once per device, then imports that Journey into the library as "TSC 2026" ([core/presentation.js](core/presentation.js)). It imports once per version of the export.
- **Slides are videos.** The full files are in `slides/`, which Git ignores. On both sites they stream from the R2 bucket `solarmeditation-media` through [functions/slides/[[path]].js](functions/slides/[[path]].js). The list of them is [documents/tsc-2026-media-manifest.json](documents/tsc-2026-media-manifest.json). The small 144p previews the controller shows are tracked in `slides/previews/`.
- **The relay carries the commands.** The controller broadcasts on room `mirror-<room>` and the presentation reports back on `mirror-<room>-status`. The cloud relay is the Worker in [broadcast-worker/](broadcast-worker/). The local relay is [tools/mirror-local.mjs](tools/mirror-local.mjs). When both are reachable the controller sends down both, and the first copy to arrive acts.
- **The receiving code** is [platform/presentation-receiver.js](platform/presentation-receiver.js). Its header lists every command.
- **Cues 17 to 24 are the audience drawing.** They are not Journey steps. They move a shared drawing room through its phases (solo, pairs, fours, half room, whole room, playback). The audience joins on their phones at meditatewiththesun.com, a separate site.
- **Event pages** keep a show's drawing playing afterwards: `presence.now.audio/?event=WIN2026`. The name maps to a saved tape in [tapes/events.json](tapes/events.json), and its starting scene is [presets/events/win2026.json](presets/events/win2026.json).

## One login

The presentation page has one password. It is private: never write it down here, or anywhere in the repository.

- **Where it is asked.** Opening `?presentation` asks for it once per browser and site address, on a card over the page, before the page joins anything. The card checks it with the relay. The browser then keeps it as `mirror.pw` and does not ask again.
- **What it opens.** The iPad's rooms, the page's own livestream broadcast, the drawing room it conducts, and Settings → Presentation mode. The broadcast Key row in the drawer is filled with it too.
- **Who checks it.** The cloud relay and the laptop's local relay are both asked. Either one saying yes is enough. The local relay reads the password from the ignored file `.mirror-key`. The cloud relay holds it as two secrets, `MIRROR_KEY` and `BROADCAST_KEY`, which must be the same password.
- **Offline.** A browser that logged in once opens with no internet and no relay answering. A browser that never logged in cannot log in until a relay answers.
- **A changed password.** The page finds the old one refused, forgets it, and asks again. So does the controller.
- `?presentation&pw=<password>` still seeds it from the address. The address bar is cleaned at once.
- The livestream page and `?follow=` pages never ask for anything.
- The standalone backup site is a frozen build. It keeps its own entry form and its older broadcast setup.

## Talks given with this

| Talk | Date | Setup |
| --- | --- | --- |
| Toward a Science of Consciousness (TSC) 2026, UC San Diego | October 11, 2026 | The standalone backup site, frozen at build `50cb7ae7`. The 16-step Journey. |
| World Imagination Network (WIN) 2026, UC San Diego | October 24, 2026 | The October 23 work renamed the pages (`show` became `controller`, `?remote` became `?presentation`) and added the drawing cues and the Presentation mode install on the main site. No separate WIN Journey was saved in this repository. |

Older documents still say `show.html`, `?remote` and `show-remote.js`. Those are the earlier names of the controller, `?presentation` and `presentation-receiver.js`. The old addresses redirect ([_redirects](_redirects)).

## What is tied to the TSC deck by name

A new deck, or a changed one, touches all of these together:

- The cue names on the controller are a fixed list: `CUES` in [controller.html](controller.html). They do not come from the Journey.
- The Journey file and the media manifest are named in [core/presentation.js](core/presentation.js) (`JOURNEY_URL`, `MANIFEST_URL`, `JOURNEY_TITLE`).
- Every step's `slideFile` must be in the media manifest, and every manifest video must be uploaded to R2 under a new release prefix. Never overwrite an earlier release.
- The controller's previews are made per video and listed in `slides/previews/144p-30fps/manifest.json`.

The steps for changing the video set are in [documents/cloud-presentation-backup.md](documents/cloud-presentation-backup.md), under "Changing the video set".

## Saving and publishing

- **Journeys live in the browser.** Each site address (main, backup, frozen build, localhost) has its own storage. An edit made in one browser stays there until Robert exports it and the export replaces the file in `documents/`.
- **iPad faders are performance, not edits.** They change the live scene and never rewrite a step. The Journey row's snapshot button is the way to capture the live scene into a step.
- **The working branch is `sun-layer`.** The main site is the Cloudflare Pages project `presence-generator`, which serves the remote `main` branch. Publishing is `git push origin sun-layer` and then `git push origin sun-layer:main`. The local `main` branch is long out of date: leave it alone.
- **The backup site does not follow Git.** It is the Pages project `presence-presentation`, built by [tools/build-cloud-presentation.mjs](tools/build-cloud-presentation.mjs) and deployed by hand. The steps are in the backup document.
- Publish only when Robert asks.

## Before a show

1. Use a browser with WebGPU. Keep the presentation in its own visible window: a hidden tab stops drawing and the controller reports it as gone.
2. Open the presentation. Type the password if the card asks. Click through the safety and audio start.
3. Switch on Settings → Presentation mode and check that the "TSC 2026" Journey is current. A logged in browser is not asked again.
4. Open the controller on the iPad with the same password and the same room.
5. Check the dot between **room** and its name on the controller. Green means the presentation answered after drawing a frame. The other dot only means the relay is connected.
6. Tap the first cue and listen for sound from the room's speakers.
7. For a talk over Zoom, open the drawer's Broadcast section and check that Livestream is on with a green dot.
8. Run one presentation page only, in one tab on one machine. Two would both broadcast to `livestream`, and viewers would flip between them.

The backup needs internet on both devices. The local setup needs none, as long as `slides/` and `sun-video/` hold their files on the laptop.

## The livestream page (a talk over Zoom)

People on a call can watch and hear the show in their own browser. Send them this link: https://presence.now.audio/?livestream

**What a viewer sees.** First a screen that says "Tap to join the live stream". Their tap starts the sound. Then the show as the laptop plays it: the scene, the sound, the words and the slide videos. The volume sits at the top right and the full-screen button at the bottom right. Nothing else shows: no menu, no drawer, no windows, no play button. The only key is full screen (Enter or F). A tap on the picture does nothing, and neither do a lock screen's or a headset's play and pause: the viewer follows the laptop.

A viewer who joins late lands on the slide where everyone else is, a moment after their tap, even minutes into a video.

**What viewers follow from the iPad.** Everything it does to the room's picture and sound:

- The cues, and the scene each one brings.
- The slide's pause, play, speed, restart and seek. Each one moves every viewer once, to where the laptop's slide is: they pause where it paused, carry on where it carries on, start again at the top. Speed changes the pitch with it, as on the laptop. Between those moments nothing moves them.
- The duck: their slide sound, heartbeat and hum dip and come back over the same times.
- Volume, the lowpass and highpass with their resonance and glide, and every level and visual fader, the finale's included.
- The screen gate: when the room goes dark, so do they.

A viewer who joins during a duck, a paused slide or a dark gate joins in that state. Each change reaches viewers within about a quarter of a second. Faders that shape the sound, the filters and the slide's speed, glide there smoothly. Visual faders arrive in small steps, four a second.

Not followed: the replay of the room's drawing at cue 24 plays on the laptop only.

A viewer can set their own volume, but the next change on the laptop (a cue, any fader) puts it back to the laptop's master volume. The iPad's volume fader moves every viewer's too.

When the broadcast ends, viewers keep the last scene, with the duck released and the gate open.

**What Robert does.** Nothing. Once the password is in, the presentation page broadcasts to room `livestream` by itself, on every load. The drawer's Broadcast section shows it as Livestream, switched on, counting who watches. Other sessions in that browser are left as they are. The page's drawing room is `livestream` too, whatever else is switched on.

While anyone watches, the broadcast stays connected, however long a slide lasts. With nobody watching it rests after ten quiet minutes, and wakes on the next change.

A rehearsal stays out of the real room. `?presentation=rehearsal` broadcasts to `livestream-rehearsal`, and its viewers open `?livestream=livestream-rehearsal`.

Switching the session off in the drawer ends the stream for every viewer until the next load. The row's Link chip copies a `?follow=livestream` link, which shows the full screen with its controls: send the `?livestream` link instead.

## After a show

A show leaves the global lowpass and highpass wherever the iPad's faders put them, and the browser remembers. If the app sounds muffled days later, that is why. Settings → Bypass live show audio opens them.

## Tests

```sh
node tools/presentation-gate.test.mjs
node tools/presentation-media.test.mjs
node --experimental-vm-modules tools/journey-remote-snapshot.test.mjs
node tools/journey-sim.test.mjs "$PWD"
node tools/livestream-url.test.mjs
node tools/presentation-login.test.mjs
node tools/slide-join.test.mjs
node tools/broadcast-livestream.test.mjs
```
