#!/usr/bin/env bash
# Builds Heart for the browser: the release wasm with SIMD, copied to
# js/heart/heart.wasm (committed, so nobody else needs cargo), and its size.
# Any failure stops the script with cargo's own message and a non-zero exit.
#
#   heart/build.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../js/heart/heart.wasm"
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

cd "$here"
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/heart.wasm "$out"

bytes=$(wc -c < "$out" | tr -d ' ')
echo "heart.wasm: $bytes bytes ($(( (bytes + 1023) / 1024 )) KiB) -> js/heart/heart.wasm"
