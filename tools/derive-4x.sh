#!/bin/bash
# A rung of a Sun mosaic: every Nth frame (4 unless given), so frame k is
# the 1x file's frame Nk, for the gap explorer's fast speeds
# (tools/gap-explorer.html: the 4x rung for 4x and 8x, the 8x for 16x).
# The recipe of solarmeditation's renders/year_cut_keyed/derive_4x.sh:
# VideoToolbox HEVC at 11.5 Mbps, hvc1; keyframes every 30 frames so the
# explorer seeks quickly; tagged full range bt470bg like every Sun file
# (VideoToolbox's own smpte170m tag shifts the brightness).
#
#   tools/derive-4x.sh sun-video/twoyear/sun_mosaic_hevc.mp4 [8]
#   -> sun-video/twoyear/sun_mosaic_4x_hevc.mp4 (or _8x_)
set -e
SRC=$1; N=${2:-4}
[ -f "$SRC" ] || { echo "usage: $0 <1x hevc file> [N]"; exit 2; }
OUT=${SRC%_hevc.mp4}_${N}x_hevc.mp4
ffmpeg -y -nostdin -loglevel error -stats -i "$SRC" \
  -vf "select='not(mod(n\,$N))',setpts=N/(30*TB)" -fps_mode passthrough \
  -c:v hevc_videotoolbox -b:v 11.5M -pix_fmt yuv420p -g 30 -tag:v hvc1 \
  -colorspace bt470bg -color_range pc -movflags +faststart "${OUT%.mp4}.building.mp4"
# VideoToolbox writes its own smpte170m tag whatever -colorspace says: the
# stream's own colour flags set to bt470bg and full range, without re-encoding
ffmpeg -y -nostdin -loglevel error -i "${OUT%.mp4}.building.mp4" -c copy \
  -bsf:v hevc_metadata=matrix_coefficients=5:video_full_range_flag=1 -tag:v hvc1 -movflags +faststart "$OUT"
rm -f "${OUT%.mp4}.building.mp4"
echo "$OUT $(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$OUT") frames"
