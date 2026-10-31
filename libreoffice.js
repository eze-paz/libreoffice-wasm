// Minimal client for engine.html: runs one soffice command line in a fresh hidden iframe.
//
//   import { convert } from './libreoffice.js';
//   const [pdf] = await convert([{ name: 'a.docx', bytes }], 'pdf');
//   // pdf = { name: 'a.pdf', bytes: ArrayBuffer }
//
// Jobs run one at a time (each boots its own runtime, ~1 GB of wasm memory while it runs).

const DEFAULTS = { engine: new URL('./engine.html', import.meta.url).href, version: '1', timeoutMs: 10 * 60 * 1000 };
let chain = Promise.resolve();

// Raw form: args is soffice's command line; inputs are at /tmp/in/<name>, write to /tmp/out.
// → { code, files: [{name, bytes}], log: [lines] }
export function run(args, files = [], opts = {}) {
  const job = () => runOnce(args, files, { ...DEFAULTS, ...opts });
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
}

// Convert every input to `to` (anything soffice --convert-to takes: "pdf", "docx",
// "csv:Text - txt - csv (StarCalc):44,34,UTF8", ...). Extra soffice flags in opts.options,
// e.g. ['--infilter=CSV:59,34,UTF8']. → [{name, bytes}], throws with soffice's log on failure.
export async function convert(files, to, opts = {}) {
  const args = ['--headless', '--norestore', '--convert-to', to, '--outdir', '/tmp/out', ...(opts.options || []), ...files.map((f) => '/tmp/in/' + f.name)];
  const r = await run(args, files, opts);
  if (!r.files.length) throw new Error('LibreOffice produced no output: ' + r.log.slice(-5).join(' | '));
  return r.files;
}

// ArrayBuffer or typed array → a fresh ArrayBuffer to transfer
const copy = (b) => (b instanceof ArrayBuffer ? b.slice(0) : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

function runOnce(args, files, o) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = o.engine + (o.engine.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(o.version);
    const done = (fn, v) => { clearTimeout(timer); removeEventListener('message', onMsg); frame.remove(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error('LibreOffice timed out')), o.timeoutMs);
    function onMsg(e) {
      if (e.source !== frame.contentWindow || !e.data) return;
      if (e.data.type === 'lo-ready') {
        // copies, so the caller's buffers stay usable
        const fl = files.map((f) => ({ name: f.name, bytes: copy(f.bytes) }));
        const fonts = (o.fonts || []).map((f) => ({ name: f.name, bytes: copy(f.bytes) }));
        frame.contentWindow.postMessage({ type: 'lo-run', id, args, files: fl, fonts }, '*', [...fl, ...fonts].map((f) => f.bytes));
      } else if (e.data.type === 'lo-done' && e.data.id === id) {
        done(resolve, { code: e.data.code, files: e.data.files || [], log: e.data.log || [] });
      }
    }
    addEventListener('message', onMsg);
    document.body.appendChild(frame);
  });
}
