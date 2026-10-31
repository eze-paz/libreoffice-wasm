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

// The live editor (editor.html): the document stays open, people edit it with mouse and keyboard
// while code edits the same document (ops below).
//
//   import { mountEditor } from './libreoffice.js';
//   const ed = mountEditor(document.getElementById('host'), { name: 'a.docx', bytes });
//   await ed.ready;                                   // { docType: 'text' | 'spreadsheet' | 'presentation', parts }
//   await ed.call('insert', { text: 'Hello', after_paragraph: 1 });
//   const { bytes } = await ed.save();               // the document in its own format
//
// ops: read {max_chars?} · replace {find, replace, regex?, match_case?} · insert {text, after_paragraph?|at?}
//      · set_cells {cells: {A1: 'x', B2: '=SUM(...)'}, sheet?} · command {uno: '.uno:Bold', args?, select?}
//      (with select, the edit runs on the editor's second, "AI" cursor, shown in orange) · save {format?}
// One editor per page is plenty: openDocument() swaps documents without a new engine.
export function mountEditor(el, { name, bytes, version = '1', editor = new URL('./editor.html', import.meta.url).href } = {}) {
  const frame = document.createElement('iframe');
  frame.src = editor + (editor.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(version);
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
  let seq = 0, docId = 0, loadedRes, readyRes, readyRej;
  const pending = new Map();
  const loaded = new Promise((r) => { loadedRes = r; });
  const ed = { frame, modified: false, onModified: null, onSaveRequest: null };
  const newReady = () => { ed.ready = new Promise((res, rej) => { readyRes = res; readyRej = rej; }); ed.ready.catch(() => {}); };
  function onMsg(e) {
    if (e.source !== frame.contentWindow || !e.data) return;
    const d = e.data;
    if (d.type === 'lok-ready') return loadedRes();
    if (d.docId != null && d.docId !== docId) return;
    if (d.type === 'lok-opened') readyRes({ docType: d.docType, parts: d.parts });
    else if (d.type === 'lok-failed') readyRej(new Error(d.error));
    else if (d.type === 'lok-modified') { ed.modified = !!d.modified; if (ed.onModified) ed.onModified(ed.modified); }
    else if (d.type === 'lok-save-request') { if (ed.onSaveRequest) ed.onSaveRequest(); }
    else if (d.type === 'lok-reply') { const p = pending.get(d.id); if (p) { pending.delete(d.id); d.ok ? p.res(d) : p.rej(new Error(d.error)); } }
  }
  addEventListener('message', onMsg);
  ed.call = (op, args) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res: (d) => res(op === 'save' ? { name: d.value.name, bytes: d.bytes } : d.value), rej });
    loaded.then(() => frame.contentWindow.postMessage({ type: 'lok-call', id, op, args: args || {} }, '*'));
  });
  ed.save = (format) => ed.call('save', format ? { format } : {});
  ed.openDocument = (n, b) => {
    newReady(); const id = ++docId; const buf = copy(b);
    loaded.then(() => frame.contentWindow.postMessage({ type: 'lok-open', docId: id, name: n, bytes: buf }, '*', [buf]));
    return ed.ready;
  };
  ed.close = () => { removeEventListener('message', onMsg); for (const p of pending.values()) p.rej(new Error('closed')); pending.clear(); frame.remove(); };
  newReady();
  el.appendChild(frame);
  if (bytes) ed.openDocument(name || 'document', bytes);
  return ed;
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
