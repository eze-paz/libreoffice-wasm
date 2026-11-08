#!/usr/bin/env bash
# Turn a LibreOffice wasm build into what convert/lo/engine.html loads:
#   bin/soffice.js        glue, patched for cooperative threads (patchglue.cjs)
#   bin/soffice.wasm      atomics waits/notifies rewritten into coop.* imports (coopwait.cjs),
#                         mutable globals exported for engine snapshots (exportglobals.cjs)
#   bin/soffice.data      the instdir file image, unchanged
#   bin/soffice.data.js.metadata
#   bin/soffice.lazy      the files a headless engine rarely reads, deflated one by one (lazydata.cjs)
# plus .gz copies nginx serves with gzip_static (convert/lo/build/README.md).
#   convert/lo/build/pack.sh ~/lo/instdir/program convert/lo/bin
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:?usage: pack.sh <lo instdir/program> <out dir>}
OUT=${2:?usage: pack.sh <lo instdir/program> <out dir>}
mkdir -p "$OUT"
node "$HERE/coopwait.cjs" "$SRC/soffice.wasm" "$OUT/soffice.wasm.coop"
node "$HERE/exportglobals.cjs" "$OUT/soffice.wasm.coop" "$OUT/soffice.wasm"
rm "$OUT/soffice.wasm.coop"
node "$HERE/patchglue.cjs" "$SRC/soffice.js" "$OUT/soffice.js"
cp "$SRC/soffice.data" "$SRC/soffice.data.js.metadata" "$OUT/"
node "$HERE/lazydata.cjs" "$OUT"
for f in soffice.js soffice.wasm soffice.data soffice.data.js.metadata; do
  gzip -9 -k -f "$OUT/$f"
done
ls -la "$OUT"
