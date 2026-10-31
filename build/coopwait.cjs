// coopwait: rewrite a threaded wasm module so its blocking atomics become host calls.
//   memory.atomic.wait32 -> call coop.wait32 (i32 addr, i32 expected, i64 timeout) -> i32
//   memory.atomic.wait64 -> call coop.wait64 (i32 addr, i64 expected, i64 timeout) -> i32
//   memory.atomic.notify -> call coop.notify (i32 addr, i32 count) -> i32
// With every pthread running as its own instance on ONE JS thread, a real atomic.wait
// blocks that thread and nothing can ever notify it; as host imports (wrapped in
// WebAssembly.Suspending) a wait parks only the calling instance's stack.
// The three imports are appended after the existing function imports, so every defined
// function index shifts by 3: calls, return_calls, ref.func, element segments, exports
// and start are renumbered. A nonzero memarg offset is folded into the address.
//   node coopwait.cjs in.wasm out.wasm
'use strict';
const fs = require('fs');
const [inp, outp] = process.argv.slice(2);
const b = fs.readFileSync(inp);
if (b.readUInt32LE(0) !== 0x6d736100) throw new Error('not wasm');

// ---------- LEB / writer helpers ----------
let p = 0;
const u = () => { let r = 0, s = 0, c; do { c = b[p++]; r += (c & 127) * 2 ** s; s += 7; } while (c & 128); return r; };
const skipLeb = () => { while (b[p++] & 128); };
const uleb = (v) => { const o = []; do { let c = v % 128; v = Math.floor(v / 128); if (v) c |= 128; o.push(c); } while (v); return o; };
class W { constructor() { this.chunks = []; this.cur = []; this.len = 0; }
  byte(x) { this.cur.push(x); if (this.cur.length > 65536) this.flush(); }
  bytes(a) { for (const x of a) this.byte(x); }
  raw(buf) { this.flush(); this.chunks.push(buf); this.len += buf.length; }
  flush() { if (this.cur.length) { const c = Buffer.from(this.cur); this.chunks.push(c); this.len += c.length; this.cur = []; } }
  out() { this.flush(); return Buffer.concat(this.chunks); } }

// ---------- sections ----------
p = 8; const secs = [];
while (p < b.length) { const id = b[p++]; const sz = u(); secs.push({ id, start: p, end: p + sz }); p += sz; }
const sec = (id) => secs.find((s) => s.id === id);

// types
const types = [];
{ const s = sec(1); p = s.start; const n = u();
  for (let i = 0; i < n; i++) { const form = b[p++]; if (form !== 0x60) throw new Error('non-func type form ' + form);
    const np = u(); const ps = []; for (let j = 0; j < np; j++) ps.push(b[p++]);
    const nr = u(); const rs = []; for (let j = 0; j < nr; j++) rs.push(b[p++]); types.push({ ps, rs }); } }
// imports: count function imports
let nImpFn = 0;
{ const s = sec(2); p = s.start; const n = u();
  for (let i = 0; i < n; i++) { { const _l = u(); p += _l; } { const _l = u(); p += _l; } const k = b[p++];
    if (k === 0) { nImpFn++; u(); } else if (k === 1) { p++; const f = u(); u(); if (f & 1) u(); }
    else if (k === 2) { const f = u(); u(); if (f & 1) u(); } else if (k === 3) { p += 2; } else if (k === 4) { p++; u(); }
    else throw new Error('import kind ' + k); } }
// function section: type of each defined function
const fnType = [];
{ const s = sec(3); p = s.start; const n = u(); for (let i = 0; i < n; i++) fnType.push(u()); }
const SHIFT = 3;
const fix = (idx) => (idx >= nImpFn ? idx + SHIFT : idx);
const T_W32 = types.length, T_W64 = types.length + 1, T_N = types.length + 2;
const F_W32 = nImpFn, F_W64 = nImpFn + 1, F_N = nImpFn + 2;
console.error(`types ${types.length}, imported fns ${nImpFn}, defined fns ${fnType.length}`);

// ---------- code rewriting ----------
const stats = { w32: 0, w64: 0, notify: 0, offsetFix: 0, fns: 0, changed: 0 };
function rewriteBody(start, end, fi) {
  // locals
  p = start; const ng = u(); const groups = [];
  let nloc = types[fnType[fi]].ps.length;
  for (let i = 0; i < ng; i++) { const c = u(); const t = b[p++]; groups.push([c, t]); nloc += c; }
  const codeStart = p;
  const w = new W(); let tmpI32 = -1, tmpI64 = -1, tmpI64b = -1, extra = [];
  const needTmp = (t) => { const idx = nloc++; extra.push([1, t]); return idx; };
  let lastCopy = codeStart; let changed = false;
  const copyTo = (q) => { if (q > lastCopy) w.raw(b.subarray(lastCopy, q)); lastCopy = q; };
  const memarg = () => { const a = u(); if (a & 0x40) u(); return u(); };   // returns offset
  while (p < end) {
    const ip = p; const op = b[p++];
    switch (op) {
      case 0x02: case 0x03: case 0x04: case 0x06: { const t = b[p]; if (t === 0x40 || (t >= 0x6f && t <= 0x7f) || t === 0x63 || t === 0x64) p++; else skipLeb(); break; }
      case 0x1f: { const t = b[p]; if (t === 0x40 || (t >= 0x6f && t <= 0x7f)) p++; else skipLeb(); const n = u();
        for (let i = 0; i < n; i++) { const k = b[p++]; if (k === 0 || k === 1) { u(); u(); } else u(); } break; }
      case 0x07: case 0x08: case 0x09: case 0x18: case 0x0c: case 0x0d: u(); break;
      case 0x0e: { const n = u(); for (let i = 0; i <= n; i++) u(); break; }
      case 0x10: case 0x12: case 0xd2: { const fp = p; const idx = u();
        if (idx >= nImpFn) { copyTo(ip); w.byte(op); w.bytes(uleb(idx + SHIFT)); lastCopy = p; changed = true; } break; }
      case 0x11: case 0x13: u(); u(); break;
      case 0x14: case 0x15: u(); break;
      case 0x1c: { const n = u(); for (let i = 0; i < n; i++) p++; break; }
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: u(); break;
      case 0x3f: case 0x40: u(); break;
      case 0x41: case 0x42: skipLeb(); break;
      case 0x43: p += 4; break;
      case 0x44: p += 8; break;
      case 0xd0: { const t = b[p]; if (t >= 0x6a && t <= 0x7f) p++; else skipLeb(); break; }
      case 0xfc: { const s = u();
        if (s <= 7) break;
        if (s === 8) { u(); u(); } else if (s === 9) u(); else if (s === 10) { u(); u(); } else if (s === 11) u();
        else if (s === 12) { u(); u(); } else if (s === 13) u(); else if (s === 14) { u(); u(); } else if (s >= 15 && s <= 17) u();
        else throw new Error('0xfc ' + s + ' @' + ip); break; }
      case 0xfd: { const s = u();
        if (s <= 11 || s === 92 || s === 93) memarg();
        else if (s === 12 || s === 13) p += 16;
        else if (s >= 21 && s <= 34) p++;
        else if (s >= 84 && s <= 91) { memarg(); p++; }
        break; }
      case 0xfe: { const s = u();
        if (s === 3) { p++; break; }
        const off = memarg();
        if (s === 0 || s === 1 || s === 2) {
          copyTo(ip); changed = true;
          if (s === 0) { stats.notify++;
            if (off) { stats.offsetFix++; if (tmpI32 < 0) tmpI32 = needTmp(0x7f);
              w.byte(0x21); w.bytes(uleb(tmpI32)); w.byte(0x41); w.bytes(sleb(off)); w.byte(0x6a); w.byte(0x20); w.bytes(uleb(tmpI32)); }
            w.byte(0x10); w.bytes(uleb(F_N)); }
          else { const is64 = s === 2; if (is64) stats.w64++; else stats.w32++;
            if (off) { stats.offsetFix++;
              if (tmpI64 < 0) tmpI64 = needTmp(0x7e);
              const te = is64 ? (tmpI64b < 0 ? (tmpI64b = needTmp(0x7e)) : tmpI64b) : (tmpI32 < 0 ? (tmpI32 = needTmp(0x7f)) : tmpI32);
              w.byte(0x21); w.bytes(uleb(tmpI64)); w.byte(0x21); w.bytes(uleb(te));
              w.byte(0x41); w.bytes(sleb(off)); w.byte(0x6a); w.byte(0x20); w.bytes(uleb(te)); w.byte(0x20); w.bytes(uleb(tmpI64)); }
            w.byte(0x10); w.bytes(uleb(is64 ? F_W64 : F_W32)); }
          lastCopy = p;
        }
        break; }
      default:
        if (op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0a || op === 0x0b || op === 0x0f || op === 0x19 || op === 0x1a || op === 0x1b || op === 0xd1) break;
        if (op >= 0x28 && op <= 0x3e) { memarg(); break; }
        if (op >= 0x45 && op <= 0xc4) break;
        if (op === 0xd3 || op === 0xd4) break;          // ref.eq, ref.as_non_null
        throw new Error(`unknown opcode 0x${op.toString(16)} at ${ip} in fn ${fi}`);
    }
  }
  if (p !== end) throw new Error('body overrun fn ' + fi);
  if (!changed) return null;
  copyTo(end);
  const head = new W(); const g2 = groups.concat(extra);
  head.bytes(uleb(g2.length)); for (const [c, t] of g2) { head.bytes(uleb(c)); head.byte(t); }
  return Buffer.concat([head.out(), w.out()]);
}
function sleb(v) { const o = []; let more = true; while (more) { let c = v & 127; v >>= 7;
  if ((v === 0 && !(c & 64)) || (v === -1 && (c & 64))) more = false; else c |= 128; o.push(c); } return o; }

const code = new W();
{ const s = sec(10); p = s.start; const n = u(); code.bytes(uleb(n));
  for (let i = 0; i < n; i++) { const sz = u(); const st = p, en = p + sz; stats.fns++;
    const nb = rewriteBody(st, en, i);
    if (nb) { stats.changed++; code.bytes(uleb(nb.length)); code.raw(nb); }
    else { code.bytes(uleb(sz)); code.raw(b.subarray(st, en)); }
    p = en; } }
console.error('code', stats);

// ---------- other sections ----------
const out = new W(); out.raw(b.subarray(0, 8));
const emit = (id, body) => { out.byte(id); out.bytes(uleb(body.length)); out.raw(body); };
const name = (s) => { const x = Buffer.from(s); return [...uleb(x.length), ...x]; };
for (const s of secs) {
  const body = b.subarray(s.start, s.end);
  if (s.id === 1) { p = s.start; const n = u(); const w = new W(); w.bytes(uleb(n + 3)); w.raw(b.subarray(p, s.end));
    w.bytes([0x60, 3, 0x7f, 0x7f, 0x7e, 1, 0x7f]); w.bytes([0x60, 3, 0x7f, 0x7e, 0x7e, 1, 0x7f]); w.bytes([0x60, 2, 0x7f, 0x7f, 1, 0x7f]);
    emit(1, w.out()); }
  else if (s.id === 2) { p = s.start; const n = u(); const w = new W(); w.bytes(uleb(n + 3));
    // new function imports go right after the LAST function import, so imported fn indices stay put
    const entries = []; for (let i = 0; i < n; i++) { const st = p; { const _l = u(); p += _l; } { const _l = u(); p += _l; } const k = b[p++];
      if (k === 0) u(); else if (k === 1) { p++; const f = u(); u(); if (f & 1) u(); } else if (k === 2) { const f = u(); u(); if (f & 1) u(); } else if (k === 3) p += 2; else if (k === 4) { p++; u(); }
      entries.push({ k, buf: b.subarray(st, p) }); }
    let lastFn = -1; entries.forEach((e, i) => { if (e.k === 0) lastFn = i; });
    entries.forEach((e, i) => { w.raw(e.buf); if (i === lastFn) {
      w.bytes([...name('coop'), ...name('wait32'), 0, ...uleb(T_W32)]);
      w.bytes([...name('coop'), ...name('wait64'), 0, ...uleb(T_W64)]);
      w.bytes([...name('coop'), ...name('notify'), 0, ...uleb(T_N)]); } });
    emit(2, w.out()); }
  else if (s.id === 7) { p = s.start; const n = u(); const w = new W(); w.bytes(uleb(n));
    for (let i = 0; i < n; i++) { const nl = u(); w.bytes(uleb(nl)); w.raw(b.subarray(p, p + nl)); p += nl; const k = b[p++]; const idx = u();
      w.byte(k); w.bytes(uleb(k === 0 ? fix(idx) : idx)); }
    emit(7, w.out()); }
  else if (s.id === 8) { p = s.start; emit(8, Buffer.from(uleb(fix(u())))); }
  else if (s.id === 9) { p = s.start; const n = u(); const w = new W(); w.bytes(uleb(n));
    // a const expr, copied with any ref.func renumbered
    const expr = () => { for (;;) { const op = b[p++]; w.byte(op); if (op === 0x0b) return;
        if (op === 0x41 || op === 0x42) { const st = p; skipLeb(); w.raw(b.subarray(st, p)); }
        else if (op === 0x23) w.bytes(uleb(u()));
        else if (op === 0xd2) w.bytes(uleb(fix(u())));
        else if (op === 0xd0) w.byte(b[p++]);
        else if (op === 0x6a || op === 0x6b || op === 0x6c || op === 0x7c || op === 0x7d || op === 0x7e) {}
        else throw new Error("elem const op 0x" + op.toString(16)); } };
    for (let i = 0; i < n; i++) { const fl = u(); w.bytes(uleb(fl));
      if (fl === 2 || fl === 6) w.bytes(uleb(u()));                 // table index
      if (fl === 0 || fl === 2 || fl === 4 || fl === 6) expr();       // offset
      if (fl === 1 || fl === 2 || fl === 3 || fl === 5 || fl === 6 || fl === 7) w.byte(b[p++]);   // elemkind / reftype
      const cnt = u(); w.bytes(uleb(cnt));
      for (let j = 0; j < cnt; j++) { if (fl < 4) w.bytes(uleb(fix(u()))); else expr(); } }
    if (p !== s.end) throw new Error("elem section misparse");
    emit(9, w.out()); }
  else if (s.id === 10) emit(10, code.out());
  else { out.byte(s.id); out.bytes(uleb(s.end - s.start)); out.raw(body); }
}
const res = out.out();
fs.writeFileSync(outp, res);
console.error('wrote', outp, res.length);
