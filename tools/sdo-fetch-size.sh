#!/bin/bash
# Fetch NASA's larger browse images for frames we already have at 1024: for
# one channel and a time window, the same timestamps at SIZE (2048 or 4096),
# into sun-video/stills/<channel>_<size>/ (git-ignored). Skips what is
# already there, 4 downloads at a time (polite to sdo.gsfc.nasa.gov),
# oldest first, so a viewer can play from the start while it runs.
#   tools/sdo-fetch-size.sh 0171 2048 20250313_140000 20250321_140000
set -e
CH=$1; SIZE=$2; FROM=$3; TO=$4
SRC=~/GitHub/solarmeditation/data/sdo_frames/1024/$CH
OUT=$(cd "$(dirname "$0")/.." && pwd)/sun-video/stills/${CH}_${SIZE}
mkdir -p "$OUT"
ls "$SRC" | grep "_1024_${CH}.jpg$" | awk -v a="$FROM" -v b="$TO" '{ t = substr($0, 1, 15); if (t >= a && t <= b) print substr($0, 1, 15) }' > "$OUT/list.txt"
echo "$(wc -l < "$OUT/list.txt" | tr -d ' ') frames to fetch into $OUT"
fetch() {
  t=$1; f="$OUT/${t}_${SIZE}_${CH}.jpg"
  [ -s "$f" ] && return 0
  curl -sf --retry 3 -o "$f.part" "https://sdo.gsfc.nasa.gov/assets/img/browse/${t:0:4}/${t:4:2}/${t:6:2}/${t}_${SIZE}_${CH}.jpg" && mv "$f.part" "$f" || { rm -f "$f.part"; echo "missing $t"; }
}
export -f fetch; export OUT SIZE CH
xargs -P 4 -I{} bash -c 'fetch {}' < "$OUT/list.txt"
echo "done: $(ls "$OUT" | grep -c '\.jpg$') frames in $OUT"
