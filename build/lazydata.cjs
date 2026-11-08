// Moves the files LibreOffice rarely reads out of soffice.data into soffice.lazy, each one
// deflated on its own, so an engine keeps them compressed and inflates a file only when
// LibreOffice reads it (convert/lo/lazyfs.js). soffice.data holds the whole instdir image in
// the page's memory for as long as the engine lives; most of it (dialog .ui files, icon
// themes, galleries) is never read by a headless engine.
// Stays in soffice.data: the fontconfig setup, the registry, program/ (read at every start).
// The fonts are lazy too: a fresh start's font scan reads them all (the pages inflate them
// ahead, lazyfs.js __loLazyInflate), a resumed engine only the ones a document uses.
//   node lazydata.cjs <bin dir>     rewrites soffice.data + soffice.data.js.metadata, writes soffice.lazy
//                                   (an existing soffice.lazy is kept and extended)
// soffice.lazy: "LAZY" | u32 index length | index JSON [{ p, o, n, s }] | deflate-raw blobs
// (o, n: blob offset/length after the index; s: the file's size).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = process.argv[2];
if (!dir) { console.error('usage: node lazydata.cjs <bin dir>'); process.exit(2); }
const metaPath = path.join(dir, 'soffice.data.js.metadata');
const dataPath = path.join(dir, 'soffice.data');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const data = fs.readFileSync(dataPath);

const EAGER = [/^\/instdir\/share\/fontconfig\//, /^\/instdir\/share\/registry\//, /^\/instdir\/program\//];
const eager = [], lazy = [];
for (const f of meta.files) (EAGER.some((re) => re.test(f.filename)) ? eager : lazy).push(f);

const parts = [], index = [];
let off = 0;
// a pack made before: its files stay as they are
const lazyPath = path.join(dir, 'soffice.lazy');
if (fs.existsSync(lazyPath)) {
  const old = fs.readFileSync(lazyPath);
  if (old.toString('latin1', 0, 4) !== 'LAZY') throw new Error(lazyPath + ' is not a lazy file pack');
  const n = old.readUInt32LE(4), base = 8 + n;
  for (const e of JSON.parse(old.toString('utf8', 8, base))) {
    const z = old.subarray(base + e.o, base + e.o + e.n);
    index.push({ p: e.p, o: off, n: z.length, s: e.s }); parts.push(z); off += z.length;
  }
}
const kept = index.length;
for (const f of lazy) {
  const z = zlib.deflateRawSync(data.subarray(f.start, f.end), { level: 9 });
  index.push({ p: f.filename, o: off, n: z.length, s: f.end - f.start });
  parts.push(z); off += z.length;
}
const idx = Buffer.from(JSON.stringify(index));
const hdr = Buffer.alloc(8); hdr.write('LAZY', 0, 'latin1'); hdr.writeUInt32LE(idx.length, 4);
fs.writeFileSync(lazyPath, Buffer.concat([hdr, idx, ...parts]));

const out = [], files = [];
let pos = 0;
for (const f of eager) {
  const b = data.subarray(f.start, f.end);
  out.push(b); files.push(Object.assign({}, f, { start: pos, end: pos + b.length })); pos += b.length;
}
fs.writeFileSync(dataPath, Buffer.concat(out));
fs.writeFileSync(metaPath, JSON.stringify(Object.assign({}, meta, { files, remote_package_size: pos })));
const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
console.log(`soffice.data ${mb(data.length)} -> ${mb(pos)} (${eager.length} files); soffice.lazy ${mb(8 + idx.length + off)} holds ${index.length} files (${lazy.length} moved now, ${kept} before; ${mb(lazy.reduce((a, f) => a + f.end - f.start, 0))} moved)`);
