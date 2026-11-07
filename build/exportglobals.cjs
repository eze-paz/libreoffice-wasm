// Export every mutable wasm global of soffice.wasm as "__g<index>" (WebAssembly.Global objects),
// so the page can read and set a thread's stack pointer, TLS base, pthread_self and stack
// limits: an engine snapshot (lok/editor.html) saves them per thread and restores them into
// fresh thread instances. Exports only; the code is unchanged.
//   node exportglobals.cjs in.wasm out.wasm
'use strict';
const fs = require('fs');
const [inp, outp] = process.argv.slice(2);
const b = fs.readFileSync(inp);
let p = 8;
const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
const enc = (n) => { const o = []; do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; o.push(x); } while (n); return Buffer.from(o); };
const name = (t) => Buffer.concat([enc(Buffer.byteLength(t)), Buffer.from(t)]);
let importedGlobals = 0, mutable = [], exp = null;
while (p < b.length) {
  const idPos = p, id = b[p++], size = leb(), start = p;
  if (id === 2) {
    const n = leb();
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 2; k++) { const n = leb(); p += n; }   // module, field
      const k = b[p++];
      if (k === 0) leb();
      else if (k === 1) { p++; const fl = leb(); leb(); if (fl & 1) leb(); }
      else if (k === 2) { const fl = b[p++]; leb(); if (fl & 1) leb(); }
      else if (k === 3) { p++; if (b[p++]) mutable.push(importedGlobals); importedGlobals++; }
      else if (k === 4) { p++; leb(); }
    }
  }
  if (id === 6) {
    const n = leb();
    for (let i = 0; i < n; i++) {
      p++; if (b[p++]) mutable.push(importedGlobals + i);
      // init expression: one constant / global.get, then end
      const op = b[p++];
      if (op === 0x41 || op === 0x42 || op === 0x23) leb(); else if (op === 0x43) p += 4; else if (op === 0x44) p += 8; else throw new Error('global init op ' + op);
      if (b[p++] !== 0x0b) throw new Error('global init expression longer than one op');
    }
  }
  if (id === 7) exp = { idPos, start, end: start + size };
  p = start + size;
}
if (!exp) throw new Error('no export section');
p = exp.start; const count = leb(); const bodyStart = p;
const have = new Set(); for (let i = 0; i < count; i++) { const n = leb(); have.add(b.toString('utf8', p, p + n)); p += n; p++; leb(); }
const add = mutable.filter((g) => !have.has('__g' + g)).map((g) => Buffer.concat([name('__g' + g), Buffer.from([3]), enc(g)]));
const body = Buffer.concat([enc(count + add.length), b.subarray(bodyStart, exp.end), ...add]);
fs.writeFileSync(outp, Buffer.concat([b.subarray(0, exp.idPos), Buffer.from([7]), enc(body.length), body, b.subarray(exp.end)]));
console.log('exported', add.length, 'mutable globals:', mutable.join(' '));
