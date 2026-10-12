#!/bin/bash
# The 10 s master test clips tools/sun-quality.html plays (?set=master), and
# the keyframe-pulse measurement: documents/sun-quality-ladder.md has what
# they found.
#
#   tools/sun-master-tests.sh            build the master week, render every clip
#   tools/sun-master-tests.sh pulse      measure the pulse on Tiny's versions
#
# Source: the meditatewiththesun day masters (near-lossless, 48 frames a
# day), 2026-03-18 to 03-26 joined into sun-video/test/master_week.mp4.
# Clips land in sun-video/test/ (git-ignored, as all the Sun's video is).
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MASTERS=${MASTERS:-$HOME/GitHub/solarmeditation/renders/cache/master}
T=$ROOT/sun-video/test
E=$ROOT/tools/sun-encode.sh
WEEK=$T/master_week.mp4
mkdir -p "$T"

# Every tier: name, width, height (the files keep 'standard'; the page calls it SD).
TIERS=("tiny 540 360" "min 720 480" "low 1080 720" "standard 1620 1080" "high 2764 1842" "max 3072 2048")

week() {
  [ -f "$WEEK" ] && return
  local list; list=$(mktemp)
  ls "$MASTERS" | grep -E '^2026031[89]|^2026032[0-6]' | sed "s|^|file '$MASTERS/|;s|\$|'|" > "$list"
  ffmpeg -y -nostdin -loglevel error -f concat -safe 0 -i "$list" -c copy "$WEEK"
  rm -f "$list"
}

# One tier's five versions, in the page's columns:
#   plain   no sharpening, CRF 26
#   +c28    sharpened (unsharp 5:5:0.5), CRF 28              (the SD, High, Max pick)
#   ft28    sharpened, flat (equal I/P/B, no cutree), CRF 28 (rejected: artifacts SD and up)
#   ft31    the same, CRF 31
#   gr      sharpened, x265 tune grain + aq-mode 3, CRF 29   (the Tiny, Min, Low pick)
# and the plain-sharpened CRF 26 (_s) the first test made.
clips() {
  local n=$1 w=$2 h=$3
  "$E" "$WEEK" "$T/master_$n.mp4" "$w" "$h" hevc -t 10 &
  EXTRA_VF="unsharp=5:5:0.5" "$E" "$WEEK" "$T/master_${n}_s.mp4" "$w" "$h" hevc -t 10 &
  CRF=28 EXTRA_VF="unsharp=5:5:0.5" "$E" "$WEEK" "$T/master_${n}_s_c28.mp4" "$w" "$h" hevc -t 10 &
  CRF=28 EXTRA_VF="unsharp=5:5:0.5" X265="ipratio=1.0:pbratio=1.0:no-cutree=1" "$E" "$WEEK" "$T/master_${n}_s_c28_flat.mp4" "$w" "$h" hevc -t 10 &
  CRF=31 EXTRA_VF="unsharp=5:5:0.5" X265="ipratio=1.0:pbratio=1.0:no-cutree=1" "$E" "$WEEK" "$T/master_${n}_s_c31_flat.mp4" "$w" "$h" hevc -t 10 &
  CRF=29 TUNE=grain EXTRA_VF="unsharp=5:5:0.5" X265="aq-mode=3" "$E" "$WEEK" "$T/master_${n}_s_gr29.mp4" "$w" "$h" hevc -t 10 &
  wait
}

# The pulse: each version's luma PSNR against the uncompressed sharpened
# source, on the 304 tile, keyframes (frames 31 and 61) against the rest.
pulse() {
  for f in master_tiny_s_c28 master_tiny_s_c28_flat master_tiny_s_gr29; do
    local stats; stats=$(mktemp)
    ffmpeg -nostdin -loglevel error -i "$T/$f.mp4" -i "$WEEK" -frames:v 90 -filter_complex \
      "[1:v]scale=540:360:flags=lanczos:in_range=pc:out_range=pc,unsharp=5:5:0.5,format=yuvj420p,crop=180:180:180:0[ref];[0:v]crop=180:180:180:0[enc];[enc][ref]psnr=stats_file=$stats" -f null -
    awk -v name=$f '{for(i=1;i<=NF;i++){if($i~/^n:/)n=substr($i,3); if($i~/^psnr_y:/)p=substr($i,8)} if(n==31||n==61){k+=p;kn++} else {o+=p;on++}} END {printf "%s: keyframes %.2f dB, others %.2f dB, pulse %.2f dB\n", name, k/kn, o/on, k/kn-o/on}' "$stats"
    rm -f "$stats"
  done
}

if [ "$1" = pulse ]; then pulse; exit; fi
week
for spec in "${TIERS[@]}"; do clips $spec; done
for f in "$T"/master_*.mp4; do
  echo "$(basename "$f") $(ffprobe -v error -show_entries format=bit_rate -of csv=p=0 "$f")"
done
