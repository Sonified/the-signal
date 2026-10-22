#!/bin/sh
# Runs the Heart tests one file at a time, each under its own time limit,
# since the full suite in one node process can hang (family-ambience among
# them). macOS has no `timeout`, so perl's alarm stands in: the file is
# killed when its time runs out and reported as TIMEOUT.
#
#   tools/heart-tests/run-each.sh [seconds] [file ...]
#
# With no files it runs every *.test.mjs and c2-*.mjs here. Logs go to
# tools/heart-tests/logs/ (git-ignored), one per file.
cd "$(dirname "$0")/../.." || exit 1
limit=${1:-240}
[ $# -gt 0 ] && shift
logs=tools/heart-tests/logs
mkdir -p "$logs"
files="$*"
[ -z "$files" ] && files=$(ls tools/heart-tests/*.test.mjs tools/heart-tests/c2-*.mjs | grep -v c2-harness)
fails=0
for f in $files; do
  start=$(date +%s)
  perl -e 'alarm shift; exec @ARGV' "$limit" node --expose-gc --test --test-force-exit "$f" > "$logs/$(basename "$f").log" 2>&1
  code=$?
  took=$(( $(date +%s) - start ))
  if [ $code -eq 0 ]; then echo "pass     $f (${took}s)"
  elif [ $code -eq 142 ]; then echo "TIMEOUT  $f (${took}s)"; fails=$((fails + 1))
  else echo "FAIL $code $f (${took}s)"; fails=$((fails + 1)); fi
done
exit $fails
