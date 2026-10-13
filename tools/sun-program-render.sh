#!/bin/bash
# The Sun program master: the gap explorer's plan (Robert's export,
# documents/sun-program-plan-*.txt) baked into one near-lossless video from
# the caption-keyed day masters, its plain dissolves drawn exactly as the
# explorer draws them (tools/sun-program-render.py has the math).
#
#   tools/sun-program-render.sh [documents/sun-program-plan-2026-10-13.txt]
#   PLAN_OPTS (default --drop-ends: the program neither opens nor ends on a
#   dissolve, Robert 2026-10-13; PLAN_OPTS= keeps the export whole)
#
#   1. tools/sun-program-plan.mjs: the txt + the keyed record -> the plan
#      json beside it; stops if any stretch count differs from the PLAN's
#   2. the master, sun-video/program/sun_program_<date>_<frames>_master.mp4 (3072x2048
#      30 fps libx264 crf 14, full range bt470bg, like the day masters), with
#      program_times.json (one UTC per frame) and program_junctions.json
#   3. the frame count, then spot checks into sun-video/program/check/
# The tiers come after: tools/sun-program-tiers.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TXT="${1:-$ROOT/documents/sun-program-plan-2026-10-13.txt}"
JSON="${TXT%.txt}.json"
DATE=$(basename "$TXT" .txt | sed -E 's/.*([0-9]{4})-([0-9]{2})-([0-9]{2})$/\1\2\3/')
OUT="$ROOT/sun-video/program"
mkdir -p "$OUT"
node "$ROOT/tools/sun-program-plan.mjs" ${PLAN_OPTS---drop-ends} "$TXT" "$JSON"
TOTAL=$(node -e "console.log(require('$JSON').total)")
MASTER="$OUT/sun_program_${DATE}_${TOTAL}_master.mp4"
if [ ! -f "$MASTER" ] || [ "${FORCE:-0}" = 1 ]; then
  python3 "$ROOT/tools/sun-program-render.py" render "$JSON" "$MASTER"
fi
N=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$MASTER")
echo "master: $N frames (plan $TOTAL)"
[ "$N" = "$TOTAL" ] || { echo "FRAME COUNT MISMATCH"; exit 1; }
python3 "$ROOT/tools/sun-program-render.py" check "$JSON" "$MASTER"
