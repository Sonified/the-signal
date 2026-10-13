# The Sun quality ladder

Decided 2026-10-12, after the TSC 2026 talk's guided meditation froze on hotel Wi-Fi (the 8 Mbps file stalled and nothing stepped down). This covers the six tiers, how each is encoded, where the files come from, which devices get which tiers, and what is still to do. It applies to both Presence (`gpu/sun.js`) and meditatewiththesun.com (`~/GitHub/solarmeditation/site/main.js`).

## The ladder

Robert's picks, judged by eye on `tools/sun-quality.html` (Master test set) on a 16" MacBook Pro and a simulated iPhone.

| Tier | Recipe | Video | Sun (one tile) | Mbps* | Full file, est.** | Phone | Computer |
|---|---|---|---|---|---|---|---|
| Min | gr | 540×360 | 180 px | 0.34 | ~27 MB | yes | no |
| SD | gr | 720×480 | 240 px | 0.60 | ~47 MB | yes | yes (its floor) |
| HD | gr | 1080×720 | 360 px | 1.45 | ~110 MB | yes | yes |
| HD+ | +c28 | 1620×1080 | 540 px | 2.35 | ~180 MB | yes | yes |
| High | +c28 | 2764×1842 | 921 px | 6.3 | ~490 MB | yes (its top) | yes |
| Max | +c28 | 3072×2048 | 1024 px | 8.3 | ~640 MB | no | yes, with Max quality on |

The names are Robert's (2026-10-12). SD and HD sit where video people expect them (480p, 720p), and HD+ is 1080. The test files in `sun-video/test/` keep the names they were rendered under: tiny, min, low, standard, high, max.

\* Measured on the 10 s test week (2026-03-18 onward), HEVC.
\** The 13-minute 1x HEVC file, scaled down about 20% because the test week is busier than average. Re-measure after the real render.

**Why phones stop at High:** a phone held upright shows the Sun about 965 px across, so High (921 px of Sun) is already about 1:1 and Max adds nothing but bytes. On a laptop the Sun can be 1700 px across, where even Max is stretched (1.66×). That's why computers get Max.

**Why computers start at SD:** an aesthetic call. Min's 180 px Sun would be stretched almost tenfold on a laptop. A computer on a link too slow for SD stays on SD and waits for frames (choppier playback) rather than showing a soft Sun.

**The Sun is one tile.** The mosaic is a 3×2 grid of SDO channels (1700, 304, 171 / 193, 211, empty). The player blends five tiles, so the Sun's real resolution is a third of the video's width. The empty tile costs under 1% of the file. Dropping a channel to make a 2×2 grid saves 12–33% of bytes depending on the channel, or makes each tile 1.5× wider at the same file width. Considered, not done.

## The recipes

All from the near-lossless day masters, never from a delivery file: `~/GitHub/solarmeditation/renders/cache/master/<YYYYMMDD>_<hash>.mp4`. There are 581 days, 3072×2048, H.264 at about 81 Mbps, 48 frames per day (one frame per 30 minutes of solar time). Encodes go through `tools/sun-encode.sh`.

| Recipe | What it is | Settings |
|---|---|---|
| **+c28** | Sharpened in the downscale, CRF 28 | `EXTRA_VF="unsharp=5:5:0.5" CRF=28` |
| **gr** | Sharpened, x265 grain mode, dark areas protected, CRF 29 | `EXTRA_VF="unsharp=5:5:0.5" CRF=29 TUNE=grain X265="aq-mode=3"` |

Each tier also needs an x264 twin (for browsers without HEVC) and, for meditatewiththesun's phones, a 4x rung (every 4th frame) of each. The ladder's earlier files took the 4x rung from High's 4x file, frame for frame.

### What we learned getting here

- **The masters matter.** Rendering from the masters instead of re-compressing delivery files is why High +c28 beats the old Max at about 30% fewer bits.
- **Sharpening** (`unsharp=5:5:0.5`) puts back the local contrast and the bright peaks that downscaling and compression flatten. It costs about 45% more bits at the same CRF. Raising CRF from 26 to 28 takes about that back, spending the bits on detail the eye sees.
- **The keyframe pulse.** At CRF 28 the dark areas "breathe" once a second: each keyframe redraws the grain, then the frames between let it fade. Measured on Tiny, keyframes were 3.9 dB cleaner than the frames around them. It's worst at the low tiers, which is why they use **gr**: x265's grain mode keeps texture in every frame and turns off the SAO filter that smudges dark areas, and aq-mode 3 gives dark regions more bits. Pulse on Tiny: +c28 3.9 dB, gr 1.7 dB, at the same size.
- **Also tried:** "flat" (`ipratio=1.0:pbratio=1.0:no-cutree=1`) cut the pulse to 1.4 dB but showed artifacts from SD up. Motion interpolation across data gaps is ruled out: plasma breaks optical flow.
- **Min brightness:** small tiers lose the brightest one-pixel peaks to averaging (the average stays the same), so they read slightly dimmer. Sharpening restores most of it. A trial 10% luma lift on Min was made but not adopted.

## The color grade

`assets/sun-grade.json` holds Robert's per-layer grade (brightness, contrast, elevate, saturation), with the math and its order written out. It is **v3** (2026-10-13), the one in use; v2 and v1 are kept as `assets/sun-grade-v2.json` and `-v1.json`, and both raw downloads from the quality page are in `documents/sun-grade-exports/`. The same bytes live in `~/GitHub/solarmeditation/site/assets/sun-grade.json`; change one, copy it to the other. Elevate is a mid-tone lift that leaves black and white alone: `c + 0.25 * elevate * sin²(πc)`. Neither player applies the grade yet.

## How the player picks a tier

`gpu/sun.js` (Presence, on sun-layer) and meditatewiththesun's `site/main.js` (local commits, not deployed) share the rules:

- **Pick on load:** a 1 MB ranged fetch of the High file, cut off at 1.5 s, timed from the server's reply, gives the link speed. The player takes the highest tier whose bar it clears, within the device's range (phones up to High; computers from SD, and Max only with the Max quality toggle on).
- **Down fast:** a stall, 4 s starved of data, a network error, or a failed rescue drops one tier at once, in place.
- **Up slow:** only after an hour away does it measure again. A slower link drops at once; a faster one rises one tier per loop, at the loop's crossfade.

The code today has the new names and the device range (phones cap at High, computers floor at SD), but only five tiers (SD, HD, HD+, High, Max) built from the old delivery files. Still to do: add Min, and switch to the new files.

## Still to do

1. **Render the real files** from the masters for the full 23,289-frame cut (the same frames as `sun_mosaic_20260915_23289r`, so the loop point at frame 15255 still holds): six tiers, each HEVC and x264, plus 4x rungs. Then check them on calm and busy stretches, not just the test week.
2. **Crossfade across data gaps** in the masters instead of hard cuts. The next task, not started.
3. **Upload to R2** (`solarmeditation-media`): needs Robert's go-ahead each time.
4. **Update both players:** add Min, switch to the new files, and re-derive the bars from the new bitrates. (The names and the phone/computer range are already in.)
5. **Apply `sun-grade.json`** in Presence's Sun shader and meditatewiththesun's.
6. **meditatewiththesun** stays local until Robert has tested it.

## Tools

- `tools/sun-quality.html` (http://localhost:8000/tools/sun-quality.html): the comparison page. It has Delivery and Master test sets, Computer and simulated Phone views (use Actual pixels at normal laptop distance to judge a phone), per-layer grade sliders with presets and hearts, favorites, Copy favorites, and Download settings. The 10-second test clips live in `sun-video/test/` (git-ignored).
- `tools/gap-explorer.html` (http://localhost:8000/tools/gap-explorer.html): the 58 data gaps of the keyed cut (`sun-video/keyed/`) on a whole-record timeline, and the program played live with moving crossfades under Hard cut, Fixed N or Dynamic (the handoff's allocator), per-gap overrides and the optional bridge cut over the choppy month; prints the gap list and Dynamic allocation to the console. `tools/gap-explorer-check.mjs` looks at it in headless Chrome.
- `tools/sun-encode.sh`: one encode, per the recipes above.
- `tools/sun-master-tests.sh`: rebuilds the master week (`sun-video/test/master_week.mp4`) and every test clip; `pulse` measures the keyframe pulse. The one-off trial encodes and measurements made along the way are in `sun-video/test/trials/`.
- `tools/sdo-week-video.sh`: a week of one SDO channel's stills as 30 fps HEVC (the Sun files' recipe, native size, no sharpening), one video per size from the same timestamps, into `sun-video/week/` (git-ignored) with `<channel>_times.json`: `tools/sdo-week-video.sh 0171 2048,1024`.
- `tools/sdo-week-player.html` (http://localhost:8000/tools/sdo-week-player.html?ch=0171): plays those videos fitted at about one image pixel per device pixel, 1 and 2 flipping between 1024 and 2048 at the same moment; speed 0.25-4×, frame steps, scrub with UTC time, loop, wheel zoom and drag pan while it plays, everything remembered.
- meditatewiththesun's headless checks of the ladder: `~/GitHub/solarmeditation/tools/ladder_smoke/`.
- `tools/mirror-probe.mjs`: the show remote's "can you hear me" check from the command line.
