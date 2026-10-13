#!/bin/bash
# Our archive's 1024 frames for one channel and a time window, hard-linked
# into sun-video/stills/<channel>_1024/ (git-ignored) so the local server can
# serve them beside the fetched 2048s (tools/sdo-fetch-size.sh): same names,
# <stamp>_1024_<channel>.jpg, and no extra disk (copied only if the archive
# is ever on another volume). Skips what is already there.
#   tools/sdo-link-1024.sh 0171 20250314_000000 20250321_235959
set -e
CH=$1; FROM=$2; TO=$3
SRC=~/GitHub/solarmeditation/data/sdo_frames/1024/$CH
OUT=$(cd "$(dirname "$0")/.." && pwd)/sun-video/stills/${CH}_1024
mkdir -p "$OUT"
ls "$SRC" | grep "_1024_${CH}.jpg$" | awk -v a="$FROM" -v b="$TO" '{ t = substr($0, 1, 15); if (t >= a && t <= b) print t }' > "$OUT/list.txt"
while read -r t; do
  f="${t}_1024_${CH}.jpg"
  [ -e "$OUT/$f" ] || ln "$SRC/$f" "$OUT/$f" 2>/dev/null || cp "$SRC/$f" "$OUT/$f"
done < "$OUT/list.txt"
echo "$(ls "$OUT" | grep -c '\.jpg$') frames in $OUT"
