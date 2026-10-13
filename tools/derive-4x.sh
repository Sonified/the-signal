#!/bin/bash
# The 4x rung of a Sun mosaic: every 4th frame, so frame k is the 1x file's
# frame 4k, for the gap explorer's 4x and 8x (tools/gap-explorer.html).
# The recipe of solarmeditation's renders/year_cut_keyed/derive_4x.sh:
# VideoToolbox HEVC at 11.5 Mbps, hvc1; keyframes every 30 frames so the
# explorer seeks quickly; tagged full range bt470bg like every Sun file
# (VideoToolbox's own smpte170m tag shifts the brightness).
#
#   tools/derive-4x.sh sun-video/twoyear/sun_mosaic_hevc.mp4
#   -> sun-video/twoyear/sun_mosaic_4x_hevc.mp4
set -e
SRC=$1
[ -f "$SRC" ] || { echo "usage: $0 <1x hevc file>"; exit 2; }
OUT=${SRC%_hevc.mp4}_4x_hevc.mp4
ffmpeg -y -nostdin -loglevel error -stats -i "$SRC" \
  -vf "select='not(mod(n\,4))',setpts=N/(30*TB)" -fps_mode passthrough \
  -c:v hevc_videotoolbox -b:v 11.5M -pix_fmt yuv420p -g 30 -tag:v hvc1 \
  -colorspace bt470bg -color_range pc -movflags +faststart "${OUT%.mp4}.building.mp4"
mv "${OUT%.mp4}.building.mp4" "$OUT"
echo "$OUT $(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$OUT") frames"
