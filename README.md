# libreoffice-wasm

LibreOffice (Writer, Calc, Impress) compiled to WebAssembly, running its own headless
command line, `soffice --convert-to`, inside a web page. Unlike other LibreOffice WASM
builds, **it does not need cross-origin isolation**: no COOP/COEP headers, no
`SharedArrayBuffer` transfer. So it also works where you cannot set those headers, such as
embedded WebViews, pages with third-party iframes or ads, or static hosting you don't
control.

```js
import { convert } from './libreoffice.js';
const [pdf] = await convert([{ name: 'report.docx', bytes }], 'pdf');
// pdf = { name: 'report.pdf', bytes: ArrayBuffer }
```

- Same engine and same output as desktop `soffice --headless --convert-to`: docx/doc/odt/rtf,
  xlsx/xls/ods/csv and pptx/ppt/odp to pdf, docx, odt, xlsx, ods, csv, pptx, odp, png, html,
  txt, and any other export filter, with filter options (`"pdf:writer_pdf_Export:{...}"`)
  and flags (`--infilter=CSV:59,34,UTF8`).
- Files never leave the browser.
- Speed: about 3–6 s per job, with a fresh runtime each time. The download is about 80 MB gzipped (wasm 53 MB +
  data 28 MB), cached by the browser after the first load.
- Needs WebAssembly JSPI (`WebAssembly.Suspending`): Chrome / Edge 137+. Tested in Chromium,
  isolated and not isolated (`npm test`).

## How it works without isolation

A threaded Emscripten build normally runs each pthread in a Web Worker that shares memory
through a `SharedArrayBuffer`. Browsers allow that only on cross-origin-isolated pages.
Here every "thread" runs on the page's one JS thread instead:

- `coop.js` replaces `Worker` with a hidden same-origin iframe. The iframe is its own JS
  realm with the same event loop, holding the *same* `WebAssembly.Memory` object. Nothing
  shared is ever posted between agents, so no isolation is needed.
- `build/coopwait.cjs` rewrites the wasm module: every `memory.atomic.wait32/64` and
  `atomic.notify` becomes a call to a `coop.*` import. A blocking wait would freeze the
  only thread. Wrapped in `WebAssembly.Suspending`, it parks only the calling "thread"'s
  stack (JSPI) until a notify on that address wakes it.
- `build/patchglue.cjs` patches the generated `soffice.js`:
  - it hands the `coop` imports to every instance;
  - each thread's entry and each main-loop iteration run through `WebAssembly.promising`;
  - calls proxied to the main thread run directly, since everything shares one JS thread.

The same binaries work unchanged on isolated pages.

## Use it

```sh
scripts/fetch-bin.sh            # downloads the release binaries into bin/
npx http-server -g -p 8080      # or any static server; -g serves the .gz copies
# open http://localhost:8080/   (index.html: pick files, pick a format, convert)
```

Files:

| | |
|---|---|
| `engine.html` | Runs one soffice command line per page load. Load it in a hidden same-origin iframe, one per job. The postMessage protocol is documented at the top of the file. |
| `coop.js` | The cooperative-thread runtime. `engine.html` loads it. |
| `editor.html` | The live editor: one document stays open, edited by people and code at the same time (see below). |
| `edit.html` | The editor demo: open a document, edit it, save a copy. |
| `libreoffice.js` | A small ES module client: `convert(files, to, {options, fonts})`, `run(args, files)` and `mountEditor(el, {name, bytes})`. It queues jobs one at a time, because each job boots its own runtime and uses up to ~1 GB of wasm memory while it runs. |
| `index.html` | The demo page. |
| `bin/` | `soffice.js`, `soffice.wasm`, `soffice.data`, `soffice.data.js.metadata` (from the release, or from your own build). |

Extra fonts: pass `fonts: [{name: 'MyFont.ttf', bytes}]`. Without them, LibreOffice uses its
bundled set: Liberation (metric-compatible with Arial, Times New Roman and Courier New),
Carlito and Caladea (Calibri and Cambria), DejaVu, Noto and others.

### The live editor

`editor.html` keeps one document open and editable: people type and click in it, and code
edits the same document at the same time. You can try it in `edit.html`.

```js
import { mountEditor } from './libreoffice.js';
const ed = mountEditor(document.getElementById('host'), { name: 'report.docx', bytes });
await ed.ready;                                            // { docType, parts }
await ed.call('insert', { text: 'New paragraph', after_paragraph: 2 });
await ed.call('command', { uno: '.uno:Bold', select: 'New paragraph' });
const text = await ed.call('read');
const { bytes: saved } = await ed.save();                  // same format; or ed.save('pdf')
await ed.openDocument('deck.pptx', other);                 // reuses the same engine (~1 s)
```

- It is built on LibreOfficeKit, the API Collabora Online uses. LibreOffice paints tiles
  onto a canvas, with no Qt GUI.
- The cursor, the selection, the Calc cell cursor and shape selection are drawn as
  overlays.
- Keyboard input (including IME), mouse input and paste work. The toolbar has
  undo/redo, bold/italic/underline, a slide/sheet picker and zoom.
- Calc gets row/column headers and a formula bar.
- Operations (`ed.call(op, args)`):
  - `read`;
  - `replace` (`find`, `replace`, `regex`);
  - `insert` (`text`, `after_paragraph` | `at`);
  - `set_cells` (`cells`, `sheet`);
  - `command` (`uno`, `args`, `select`);
  - `save` (`format`).
- **Two views.** Code acts in a second LibreOffice view. A `command` with `select` runs on
  that view's own cursor, which the user sees in orange. The user's cursor never moves.
  Without `select`, the command applies to the user's selection.
- **Input ordering.** Posted input (keys, clicks, async `.uno:` commands) is applied by
  LibreOffice's main loop. Before running an operation, the editor waits until everything
  posted so far has landed, so operations never interleave with half-applied typing.
- **Threads.** All LibreOfficeKit calls run on a pthread taken over for the purpose (see
  `build/patchglue.cjs`). On the page thread a wait would busy-spin.
- **Callbacks.** LibreOfficeKit's callbacks reach JS through a function the editor adds
  to every thread's table (`-sALLOW_TABLE_GROWTH`, see `lo-source.patch`).

### Serving

Serve the four `bin/` files with long cache lifetimes and gzip (or brotli). Use
`?v=<version>` (the `version` option) to bust caches when you replace them. With nginx and
the `.gz` copies next to the files:

```nginx
location /bin/ {
    gzip_static on;
    types { application/wasm wasm; text/javascript js; application/octet-stream data; application/json metadata; }
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

GitHub release download URLs send no CORS headers, so host the binaries on your own origin
(or a CDN that sends `Access-Control-Allow-Origin`).

## Build

The build runs on Linux; WSL Ubuntu 24.04 works. A full build takes about 4 hours on 10 cores and ~25 GB of disk.

```sh
git clone https://git.libreoffice.org/core ~/lo && git -C ~/lo checkout 7528c0d406012e10c6ce34c3f24bf277302ec695
git clone https://github.com/emscripten-core/emsdk ~/emsdk && ~/emsdk/emsdk install 4.0.10 && ~/emsdk/emsdk activate 4.0.10
cp build/autogen.input ~/lo/ && git -C ~/lo apply $PWD/build/lo-source.patch
# On WSL, drop the Windows PATH, or configure thinks it is a Windows build:
unset WSL_DISTRO_NAME WSLENV; export PATH=$(echo "$PATH" | tr : '\n' | grep -v ^/mnt/ | paste -sd:)
. ~/emsdk/emsdk_env.sh && cd ~/lo && ./autogen.sh && make
build/pack.sh ~/lo/instdir/program bin     # coopwait + patchglue + .gz copies
```

- `autogen.input` is headless (`--disable-gui`) with `--with-wasm-module=calc writer impress`.
- `lo-source.patch` fixes a compile error on that master commit, in
  `comphelper/source/crypto/Crypto_OpenSSL.cxx`, where a const vector gets resized. Only
  OpenSSL targets hit it. It also links soffice with `-sALLOW_TABLE_GROWTH` and `addFunction`
  (for the editor's callbacks), and makes the wasm main loop apply every pending posted event
  per iteration in LibreOfficeKit mode (`vcl/headless/svpinst.cxx`).
- Host packages configure asks for include gperf, flex, bison, nasm, libarchive-zip-perl,
  libfont-ttf-perl and libxml-parser-perl.

Gotchas:

- **After changing `--with-wasm-module`,** delete the stale implementation filters:
  `find workdir/ComponentTarget -name "*.filtered" -o -name "*.optionals" | xargs rm`.
  Then run `make` twice. Otherwise the new module's ODF exporters are silently left out
  (saves fail with "Storing has failed, no error is set!"), or `soffice.js` links against
  the old file-system image list (`ErrnoError 44` while loading `soffice.data`). To check:
  `grep -c sdraw instdir/program/soffice.js` should not be 0.
- `patchglue.cjs` matches exact strings in the glue from Emscripten 4.0.10. Another
  Emscripten version will likely need new anchors. It fails loudly when an anchor is
  missing.

## Limits

- No GUI, macros (Basic/scripting), Java or Base. This is the conversion engine only.
- soffice never exits in WebAssembly, because its event loop keeps the runtime alive. So
  the engine decides a job is done when every input has printed its `convert ... ->` or
  `Error:` line and every output file is written and closed.
- The build still has Emscripten `ASSERTIONS` on; a release build would be somewhat smaller
  and faster.
- Android WebView should work wherever JSPI is enabled, but hasn't been tested yet.

## License

- **The code in this repository** (`coop.js`, `engine.html`, `libreoffice.js`, `index.html`,
  `build/*.cjs`, `pack.sh`, tests) is MIT; see `LICENSE`.
- **The binaries** are LibreOffice. They are built unmodified from the commit and options
  above, apart from `build/lo-source.patch` and the post-link rewrites in
  `build/coopwait.cjs` and `build/patchglue.cjs`. LibreOffice is under the Mozilla Public
  License 2.0, with third-party components under their own licenses: see
  `licenses/LibreOffice-LICENSE.txt` and `licenses/LibreOffice-NOTICE.txt`. The bundled
  fonts carry their own (mostly SIL OFL) licenses.

LibreOffice is a registered trademark of The Document Foundation. This project is not
affiliated with or endorsed by The Document Foundation.
