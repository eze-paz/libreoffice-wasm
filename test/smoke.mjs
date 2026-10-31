// Smoke test: serves this repo, opens a page in Chromium and converts the fixtures through
// libreoffice.js, on a page that is NOT cross-origin isolated and on one that is.
//   npm install && npx playwright install chromium && npm test
// Needs bin/ (scripts/fetch-bin.sh, or build/pack.sh after a build). Binaries are served
// from their .gz copies with Content-Encoding: gzip when present, like nginx gzip_static.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

if (!fs.existsSync(path.join(ROOT, 'bin/soffice.wasm')) && !fs.existsSync(path.join(ROOT, 'bin/soffice.wasm.gz'))) {
  console.error('bin/ is empty: run scripts/fetch-bin.sh first'); process.exit(2);
}

let coi = false;
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  const h = { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' };
  if (coi) { h['Cross-Origin-Opener-Policy'] = 'same-origin'; h['Cross-Origin-Embedder-Policy'] = 'require-corp'; }
  let src = file;
  if (rel.startsWith('bin/') && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && fs.existsSync(file + '.gz')) { src = file + '.gz'; h['content-encoding'] = 'gzip'; }
  if (!file.startsWith(ROOT) || !fs.existsSync(src) || fs.statSync(src).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, h);
  fs.createReadStream(src).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n)).toString('base64');
const CASES = [
  { name: 'docx -> pdf', in: ['test.docx'], to: 'pdf', want: [['test.pdf', '%PDF-']] },
  { name: 'xlsx -> pdf', in: ['tiny.xlsx'], to: 'pdf', want: [['tiny.pdf', '%PDF-']] },
  { name: 'pptx -> pdf', in: ['deck.pptx'], to: 'pdf', want: [['deck.pdf', '%PDF-']] },
  { name: 'pptx -> odp', in: ['deck.pptx'], to: 'odp', want: [['deck.odp', 'PK']] },
  { name: 'semicolon csv -> xlsx', in: ['semicolon.csv'], to: 'xlsx', options: ['--infilter=CSV:59,34,UTF8'], want: [['semicolon.xlsx', 'PK']] },
  { name: 'batch docx + pptx -> pdf', in: ['test.docx', 'deck.pptx'], to: 'pdf', want: [['test.pdf', '%PDF-'], ['deck.pdf', '%PDF-']] },
];

const browser = await chromium.launch();
let fail = 0;
for (const mode of [false, true]) {
  coi = mode;
  const page = await browser.newPage();
  await page.goto(base + 'index.html');
  console.log(`-- page ${await page.evaluate(() => self.crossOriginIsolated) ? 'cross-origin isolated' : 'NOT isolated'}`);
  for (const c of CASES) {
    const t0 = Date.now();
    const r = await page.evaluate(async ({ c, inputs }) => {
      const { convert } = await import('./libreoffice.js');
      const files = inputs.map(([name, b64]) => ({ name, bytes: Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)) }));
      try {
        const out = await convert(files, c.to, { options: c.options, timeoutMs: 120000 });
        return out.map((f) => [f.name, f.bytes.byteLength, String.fromCharCode(...new Uint8Array(f.bytes).slice(0, 5))]);
      } catch (e) { return String(e.message || e); }
    }, { c, inputs: c.in.map((n) => [n, fx(n)]) });
    const ok = Array.isArray(r) && c.want.every(([n, head]) => r.some(([rn, size, h]) => rn === n && size > 500 && h.startsWith(head)));
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${ok ? '' : ' ' + JSON.stringify(r)}`);
  }
  // the live editor: open, edit through ops, swap documents in the same engine, save
  const t0 = Date.now();
  const r = await page.evaluate(async ({ docx, pptx }) => {
    const { mountEditor } = await import('./libreoffice.js');
    const host = document.createElement('div'); host.style.cssText = 'width:900px;height:600px'; document.body.appendChild(host);
    const bin = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    try {
      const ed = mountEditor(host, { name: 'test.docx', bytes: bin(docx) });
      const a = await ed.ready;
      await ed.call('insert', { text: 'Added live.', after_paragraph: 1 });
      const cmd = await ed.call('command', { uno: '.uno:Bold', select: 'Added live.' });
      const t1 = await ed.call('read');
      const s1 = await ed.save();
      const b = await ed.openDocument('deck.pptx', bin(pptx));
      const n = await ed.call('replace', { find: 'Sandpie slide test', replace: 'Swapped in' });
      const t2 = await ed.call('read');
      ed.close();
      return { a, cmd, t1, s1: s1.bytes.byteLength, b, n, t2 };
    } catch (e) { return String(e.message || e); }
  }, { docx: fx('test.docx'), pptx: fx('deck.pptx') });
  const ok = r && r.a && r.a.docType === 'text' && /\[2\] Added live\./.test(r.t1) && /applied/.test(r.cmd) && r.s1 > 1000 && r.b.docType === 'presentation' && r.n === 1 && /Swapped in/.test(r.t2);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} editor: edit docx, swap to pptx, save (${((Date.now() - t0) / 1000).toFixed(1)}s)${ok ? '' : ' ' + JSON.stringify(r).slice(0, 400)}`);
  await page.close();
}
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
