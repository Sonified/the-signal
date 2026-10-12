#!/bin/bash
# One Sun mosaic encode: documents/sun-quality-ladder.md has the recipes.
#
#   tools/sun-encode.sh SRC OUT W H hevc|x264 [extra ffmpeg input args, e.g. -t 10]
#
# Scales with Lanczos keeping the full (pc) range and bt470bg tags of every
# Sun file, 1 s keyframes (30 frames, no scene cuts) so the player's wrap
# and stall rescue seek cleanly, faststart for streaming. Environment:
#   EXTRA_VF  filters after the scale (the "+" recipes: unsharp=5:5:0.5)
#   CRF       x265 default 26, x264 default 25
#   TUNE      x265 -tune (the "gr" recipe: grain)
#   X265      extra x265-params (the "gr" recipe: aq-mode=3)
SRC=$1; OUT=$2; W=$3; H=$4; CODEC=$5; shift 5
VF="scale=${W}:${H}:flags=lanczos:in_range=pc:out_range=pc${EXTRA_VF:+,$EXTRA_VF},format=yuvj420p"
if [ "$CODEC" = hevc ]; then
  ENC=(-c:v libx265 -crf ${CRF:-26} -preset medium ${TUNE:+-tune $TUNE} -tag:v hvc1 -x265-params log-level=error:keyint=30:min-keyint=30:scenecut=0${X265:+:$X265})
else
  ENC=(-c:v libx264 -crf ${CRF:-25} -preset medium -g 30 -keyint_min 30 -sc_threshold 0)
fi
exec ffmpeg -y -nostdin -loglevel error "$@" -i "$SRC" -vf "$VF" "${ENC[@]}" -colorspace bt470bg -color_range pc -an -movflags +faststart "$OUT"
