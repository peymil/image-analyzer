#!/usr/bin/env sh
# libimagequant (imagequant 4.4.1 crate) → tek iş parçacıklı WASM → web/src/pipeline/imagequant.wasm
# Gereksinim: rustup + wasm32-unknown-unknown hedefi.
#   rustup target add wasm32-unknown-unknown
set -eu
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/imagequant_wasm.wasm ../../src/pipeline/imagequant.wasm
echo "kopyalandı: src/pipeline/imagequant.wasm"
