#!/bin/bash
# Transcribe the WIN_2026 event footage. Timestamps are RAW FILE TIME,
# i.e. where you land scrubbing the .MOV itself, not the Photos slow-mo timeline.
set -u
SRC="$HOME/Dropbox/WIN_2026"
OUT="$HOME/GitHub/the-signal/documents/win2026"
WAV="${TMPDIR:-/tmp}/win2026-wav"
mkdir -p "$OUT" "$WAV"

for f in "$SRC"/*.MOV; do
  b=$(basename "$f" .MOV)
  [ -f "$OUT/$b.srt" ] && { echo "skip $b (done)"; continue; }
  echo "=== $b"
  ffmpeg -nostdin -v error -y -i "$f" -vn -map 0:a:0 -ac 1 -ar 16000 \
         -c:a pcm_s16le "$WAV/$b.wav" || { echo "  no audio, skipped"; continue; }
  mlx_whisper "$WAV/$b.wav" \
    --model mlx-community/whisper-large-v3-turbo \
    --language en --output-dir "$OUT" --output-format srt \
    --word-timestamps True --verbose False 2>/dev/null
  rm -f "$WAV/$b.wav"
done
echo "ALL DONE"
