#!/bin/bash
# Every quality tier of the Sun program, from its master
# (tools/sun-program-render.sh), through tools/sun-encode.sh with
# documents/sun-quality-ladder.md's recipes:
#   gr    Min 540x360, SD 720x480, HD 1080x720
#         EXTRA_VF="unsharp=5:5:0.5" CRF=29 TUNE=grain X265="aq-mode=3"
#   +c28  HD+ 1620x1080, High 2764x1842, Max 3072x2048
#         EXTRA_VF="unsharp=5:5:0.5" CRF=28
# Names: <stem>_<h>_hevc.mp4 and the x264 twin <stem>_<h>.mp4; the 4x rungs
# (every 4th frame, so rung frame k is program frame 4k) <stem>_<h>_4x_hevc.mp4
# and <stem>_<h>_4x.mp4, each in its tier's own recipe.
# Order: the six 1x HEVC (SD and Max leading), the six 4x HEVC rungs (what
# phones play), the six 1x x264 twins, the six 4x x264 rungs. JOBS at once
# (default 3). Each file is built as .building.mp4,
# verified (frame count, a full -xerror decode, hvc1 / full range / bt470bg
# tags) and only then renamed; a line per file goes into STATUS.md.
# Rerun to resume: finished files are skipped.
#
#   tools/sun-program-tiers.sh [stem]        default sun_program_20261013_30745
#   (the master is sun-video/program/<stem>_master.mp4)
#   JOBS=3 ONLY="480 2048" CODECS="hevc" RUNGS=0|1|only ...
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${PROGRAM_DIR:-$ROOT/sun-video/program}"
if [ "${1:-}" = one ]; then
  # one job: one <h> <hevc|x264> <1|4> [stem master total] (else from the env)
  H=$2; CODEC=$3; R=$4; STEM=${5:-$TIER_STEM}; MASTER=${6:-$TIER_MASTER}; TOTAL=${7:-$TIER_TOTAL}
  case $H in
    360) W=540 ;; 480) W=720 ;; 720) W=1080 ;; 1080) W=1620 ;; 1842) W=2764 ;; 2048) W=3072 ;;
  esac
  case $H in
    360|480|720) export CRF=29 TUNE=grain X265="aq-mode=3"; RECIPE=gr ;;
    *) export CRF=28; unset TUNE X265; RECIPE=+c28 ;;
  esac
  export EXTRA_VF="unsharp=5:5:0.5"
  NAME="${STEM}_${H}"; WANT=$TOTAL
  if [ "$R" = 4 ]; then
    NAME+="_4x"; WANT=$(( (TOTAL + 3) / 4 ))
    EXTRA_VF+=",select='not(mod(n\,4))',setpts=N/(30*TB)"
  fi
  [ "$CODEC" = hevc ] && NAME+="_hevc"
  OUT="$DIR/$NAME.mp4"
  [ -f "$OUT" ] && { echo "skip $NAME (done)"; exit 0; }
  TMP="$DIR/$NAME.building.mp4"
  T0=$(date +%s)
  echo "start $NAME ($RECIPE, ${W}x${H}, $CODEC)"
  "$ROOT/tools/sun-encode.sh" "$MASTER" "$TMP" "$W" "$H" "$CODEC"
  T1=$(date +%s)
  # verify
  N=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$TMP")
  TAGS=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_tag_string,width,height,color_range,color_space,r_frame_rate -of csv=p=0 "$TMP")
  ERR=$(ffmpeg -nostdin -v error -xerror -i "$TMP" -f null - 2>&1 | head -3 || echo "decoder exit $?")
  BAD=""
  [ "$N" = "$WANT" ] || BAD+=" frames $N not $WANT;"
  [ -z "$ERR" ] || BAD+=" decode: $ERR;"
  if [ "$CODEC" = hevc ]; then TAG=hvc1; else TAG=avc1; fi
  [ "$TAGS" = "$TAG,$W,$H,pc,bt470bg,30/1" ] || BAD+=" tags $TAGS;"
  BYTES=$(stat -f %z "$TMP")
  MB=$(awk "BEGIN{printf \"%.1f\", $BYTES / 1e6}")
  MBPS=$(awk "BEGIN{printf \"%.2f\", $BYTES * 8 / ($N / 30) / 1e6}")
  MIN=$(awk "BEGIN{printf \"%.0f\", ($T1 - $T0) / 60}")
  if [ -n "$BAD" ]; then
    echo "| $NAME.building.mp4 | $RECIPE | ${W}x${H} | $N | $MB MB | $MBPS | $MIN min | **FAILED:$BAD** |" >> "$DIR/STATUS.md"
    echo "FAILED $NAME:$BAD"; exit 1
  fi
  mv "$TMP" "$OUT"
  echo "| $NAME.mp4 | $RECIPE | ${W}x${H} | $N | $MB MB | $MBPS | $MIN min | ok |" >> "$DIR/STATUS.md"
  echo "done $NAME: $N frames, $MB MB, $MBPS Mbps, $MIN min"
  exit 0
fi

STEM="${1:-sun_program_20261013_30745}"
MASTER="$DIR/${STEM}_master.mp4"
[ -f "$MASTER" ] || { echo "no master $MASTER"; exit 1; }
TOTAL=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$MASTER")
ORDER="${ONLY:-480 2048 360 720 1080 1842}"
CODECS="${CODECS:-hevc x264}"
LIST=()
for c in $CODECS; do
  if [ "${RUNGS:-1}" != only ]; then for h in $ORDER; do LIST+=("$h $c 1"); done; fi
  if [ "${RUNGS:-1}" != 0 ]; then for h in $ORDER; do LIST+=("$h $c 4"); done; fi
done
if [ ! -f "$DIR/STATUS.md" ]; then
  { echo "# Sun program tiers"
    echo
    echo "From \`$(basename "$MASTER")\` ($TOTAL frames, 30 fps). Built by \`tools/sun-program-tiers.sh\`; a line per file as it finishes, verified (frame count, full -xerror decode, tags)."
    echo
    echo "| File | Recipe | Size | Frames | MB | Mbps | Took | Check |"
    echo "|---|---|---|---|---|---|---|---|"
  } > "$DIR/STATUS.md"
fi
echo "$(date '+%F %T') ${#LIST[@]} jobs, ${JOBS:-3} at once"
export TIER_STEM="$STEM" TIER_MASTER="$MASTER" TIER_TOTAL="$TOTAL"
printf '%s\n' "${LIST[@]}" | xargs -P "${JOBS:-3}" -L 1 "$ROOT/tools/sun-program-tiers.sh" one
echo "$(date '+%F %T') all done"
