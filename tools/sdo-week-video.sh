#!/bin/bash
# A week of SDO stills as a real video, one per size, for
# tools/sdo-week-player.html: every frame in time order at 30 fps, the same
# timestamps at every size so the sizes compare honestly. The recipe of the
# site's Sun files (tools/sun-encode.sh): libx265 CRF 26 medium, hvc1,
# keyframes every 30 frames and no scene cuts (quick scrubbing), full range
# (pc) yuvj420p tagged bt470bg, faststart. No scaling, no sharpening: native
# detail. The frames are read where they lie, through a concat list.
#
# Frames: 1024 from solarmeditation's archive, other sizes from
# sun-video/stills/<channel>_<size>/ (tools/sdo-fetch-size.sh). Timestamps:
# that folder's list.txt for the first size, or the archive's frames in a
# window; a timestamp missing at any size is left out of every size.
#
#   tools/sdo-week-video.sh 0171 2048,1024
#   tools/sdo-week-video.sh 0193 2048,1024 20250314_000000 20250321_020000
#   -> sun-video/week/<channel>_<size>_hevc.mp4 and <channel>_times.json
#      (OUT=dir to put another week elsewhere)
set -e
CH=$1; SIZES=${2//,/ }; FROM=$3; TO=$4
[ -n "$CH" ] && [ -n "$SIZES" ] || { echo "usage: $0 <channel> <size,size..> [from to]"; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARCH=~/GitHub/solarmeditation/data/sdo_frames/1024/$CH
OUT=${OUT:-$ROOT/sun-video/week}
mkdir -p "$OUT"
dir() { [ "$1" = 1024 ] && echo "$ARCH" || echo "$ROOT/sun-video/stills/${CH}_$1"; }
FIRST=${SIZES%% *}
if [ -n "$FROM" ]; then
  ls "$ARCH" | grep "_1024_${CH}.jpg$" | awk -v a="$FROM" -v b="$TO" '{ t = substr($0, 1, 15); if (t >= a && t <= b) print t }'
else
  cat "$(dir "$FIRST")/list.txt"
fi > "$OUT/${CH}.all.txt"
# only the timestamps every size has
: > "$OUT/${CH}.times.txt"
while read -r t; do
  ok=1; for s in $SIZES; do [ -s "$(dir "$s")/${t}_${s}_${CH}.jpg" ] || ok=0; done
  [ $ok = 1 ] && echo "$t" >> "$OUT/${CH}.times.txt"
done < "$OUT/${CH}.all.txt"
N=$(wc -l < "$OUT/${CH}.times.txt" | tr -d ' ')
echo "$N frames ($(( $(wc -l < "$OUT/${CH}.all.txt") - N )) left out, missing at some size)"
# one ISO UTC string per frame
awk 'BEGIN { printf "[" } { printf "%s\"%s-%s-%sT%s:%s:%sZ\"", (NR > 1 ? ", " : ""), substr($0,1,4), substr($0,5,2), substr($0,7,2), substr($0,10,2), substr($0,12,2), substr($0,14,2) } END { print "]" }' \
  "$OUT/${CH}.times.txt" > "$OUT/${CH}_times.json"
for s in $SIZES; do
  D=$(dir "$s"); F="$OUT/${CH}_${s}_hevc.mp4"
  sed "s|.*|file '$D/&_${s}_${CH}.jpg'|" "$OUT/${CH}.times.txt" > "$OUT/${CH}_${s}.concat.txt"
  echo "encoding $F"
  ffmpeg -y -nostdin -loglevel error -stats -f concat -safe 0 -i "$OUT/${CH}_${s}.concat.txt" \
    -vf "settb=1/30,setpts=N,format=yuvj420p" -r 30 \
    -c:v libx265 -crf 26 -preset medium -tag:v hvc1 -x265-params log-level=error:keyint=30:min-keyint=30:scenecut=0 \
    -colorspace bt470bg -color_range pc -an -movflags +faststart "${F%.mp4}.building.mp4"
  mv "${F%.mp4}.building.mp4" "$F"
  rm -f "$OUT/${CH}_${s}.concat.txt"
done
rm -f "$OUT/${CH}.all.txt" "$OUT/${CH}.times.txt"
for s in $SIZES; do
  F="$OUT/${CH}_${s}_hevc.mp4"
  n=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$F")
  tags=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,pix_fmt,color_range,color_space,r_frame_rate -of csv=p=0 "$F")
  bytes=$(stat -f %z "$F")
  echo "$F: $(( bytes / 1048576 )) MB, $n frames, $(awk -v b="$bytes" -v n="$n" 'BEGIN { printf "%.1f", b * 8 / (n / 30) / 1e6 }') Mbps ($tags)"
done
