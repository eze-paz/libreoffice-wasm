#!/usr/bin/env bash
# Download the release binaries into bin/ (the .gz copies plus unpacked files).
#   scripts/fetch-bin.sh [tag]
set -euo pipefail
TAG=${1:-v0.2.0}
BASE=https://github.com/eze-paz/libreoffice-wasm/releases/download/$TAG
cd "$(dirname "$0")/.."
mkdir -p bin
for f in soffice.js soffice.wasm soffice.data soffice.data.js.metadata; do
  curl -fL --retry 3 -o "bin/$f.gz" "$BASE/$f.gz"
  gzip -dkf "bin/$f.gz"
done
curl -fsL "$BASE/SHA256SUMS" | (cd bin && sha256sum -c -)
