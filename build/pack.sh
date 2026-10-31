#!/usr/bin/env bash
# Turn a LibreOffice wasm build into what engine.html loads:
#   bin/soffice.js        glue, patched for cooperative threads (patchglue.cjs)
#   bin/soffice.wasm      atomics waits/notifies rewritten into coop.* imports (coopwait.cjs)
#   bin/soffice.data      the instdir file image, unchanged
#   bin/soffice.data.js.metadata
# plus .gz copies to serve with gzip_static (README.md, "Serving").
#   build/pack.sh ~/lo/instdir/program bin
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:?usage: pack.sh <lo instdir/program> <out dir>}
OUT=${2:?usage: pack.sh <lo instdir/program> <out dir>}
mkdir -p "$OUT"
node "$HERE/coopwait.cjs" "$SRC/soffice.wasm" "$OUT/soffice.wasm"
node "$HERE/patchglue.cjs" "$SRC/soffice.js" "$OUT/soffice.js"
cp "$SRC/soffice.data" "$SRC/soffice.data.js.metadata" "$OUT/"
for f in soffice.js soffice.wasm soffice.data soffice.data.js.metadata; do
  gzip -9 -k -f "$OUT/$f"
done
ls -la "$OUT"
