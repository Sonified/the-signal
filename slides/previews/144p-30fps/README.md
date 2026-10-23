# Silent 144p / 30 fps video previews

All MP4s currently in `slides/` have matching full-length preview MP4s here,
with their original filenames. Most are 256 × 144; other aspect ratios are
preserved. All are H.264 Main, 30 fps, CRF 26, medium preset, YUV 4:2:0,
fast-start MP4, with a maximum two-second keyframe interval. No audio,
subtitle, or data streams are included.

`manifest.json` records the exact byte sizes, dimensions, frame counts,
durations, source filenames, and total. Every output was checked with
ffprobe and decoded completely with ffmpeg.

Files encoded: **14**. Combined video size: **11.07 MB** (11070272 bytes).

These are local generated assets in the git-ignored `slides/` directory.
The local iPad controller (`show.html`, `platform/cue-previews.js`) uses them
inside the cue buttons: static JPEG posters for upcoming videos and one
muted player for the current cue. The laptop is the playback authority:
it reports the active cue, file, position, rate and loop flag four times
per second. The iPad projects that reported clock between messages and
corrects position differences above 0.2 seconds. Local-start prediction,
command-acknowledgement gates, gentle rate corrections and the dedicated
Audification player experiment have been removed.

The module preloads
the complete pack and caches the blobs in IndexedDB, with an in-memory
fallback when browser storage is unavailable. Failed downloads retry every
10 seconds and on network reconnection. Players receive complete cached
Blob URLs, never partial network streams. Cached assets are keyed by
the preview video's SHA-256 from `manifest.json`.

The 14 JPEG posters add 90,319 bytes. Reload the laptop and iPad once to
enable the video-file and loop fields in the laptop's progress reports.

Equivalent command from the repository root, substituting each filename:

```sh
ffmpeg -nostdin -n -i 'slides/030_Audification_Explained.mp4' \
  -map 0:v:0 -an -sn -dn -map_metadata -1 -write_tmcd 0 \
  -vf 'fps=30:round=up,scale=-2:144:flags=lanczos' \
  -c:v libx264 -preset medium -crf 26 -pix_fmt yuv420p -profile:v main \
  -g 60 -keyint_min 30 -movflags +faststart \
  'slides/previews/144p-30fps/030_Audification_Explained.mp4'
```
