// Cooperative pthreads for an Emscripten build on a page WITHOUT cross-origin isolation
// (loaded by engine.html before soffice.js; built by build/pack.sh).
// Every pthread runs on THIS thread: a "worker" is a hidden same-origin iframe (its own
// globals, same event loop) holding the SAME WebAssembly.Memory object -- nothing is
// posted between agents, so no isolation is needed. The wasm's atomic waits were
// rewritten (coopwait.cjs) into coop.wait32/wait64 imports; under JSPI they park only
// the calling thread's stack until coop.notify wakes it.
(function () {
  const log = (...a) => { (window.__coopLog = window.__coopLog || []).push(a.join(' ')); };
  // The constructor is hidden without isolation, but a shared memory's buffer still is one.
  if (typeof SharedArrayBuffer === 'undefined') {
    globalThis.SharedArrayBuffer = new WebAssembly.Memory({ initial: 0, maximum: 0, shared: true }).buffer.constructor;
  }
  let memory = null;
  const waiters = new Map();          // addr -> [{resolve, timer}]
  const stats = window.__coopStats = { waits: 0, suspends: 0, notifies: 0, woken: 0, timeouts: 0, syncWaits: 0 };
  const view32 = () => new Int32Array(memory.buffer);
  const view64 = () => new BigInt64Array(memory.buffer);
  function park(addr, timeoutNs) {
    stats.suspends++;
    // A pause whose stack has JS frames between the wait and the thread entry cannot
    // suspend (JSPI throws SuspendError). window.__coopDebug records those stacks.
    if (window.__coopDebug) try { const st = new Error().stack.split('\n').slice(2).filter((l) => !/wasm-function|wasm:\/\//.test(l)).map((l) => l.trim().replace(/\(http[^)]*\/([^/:]+):\d+:\d+\)/, '($1)'));
      const key = st.slice(0, 6).join(' < '); (window.__coopStacks = window.__coopStacks || new Map()).set(key, ((window.__coopStacks.get(key)) || 0) + 1); } catch (_) {}
    return new Promise((resolve) => {
      const rec = { resolve, timer: 0 };
      if (timeoutNs >= 0n) {
        const ms = Number(timeoutNs / 1000000n);
        rec.timer = setTimeout(() => { const l = waiters.get(addr); if (l) { const i = l.indexOf(rec); if (i >= 0) l.splice(i, 1); }
          stats.timeouts++; resolve(2); }, ms);
      }
      let l = waiters.get(addr); if (!l) waiters.set(addr, l = []); l.push(rec);
    });
  }
  const wait32 = new WebAssembly.Suspending((addr, expected, timeout) => {
    stats.waits++;
    if (Atomics.load(view32(), addr >> 2) !== expected) return 1;          // "not-equal"
    return park(addr, timeout);
  });
  const wait64 = new WebAssembly.Suspending((addr, expected, timeout) => {
    stats.waits++;
    if (Atomics.load(view64(), addr >> 3) !== expected) return 1;
    return park(addr, timeout);
  });
  function notify(addr, count) {
    stats.notifies++;
    let n = 0; const l = waiters.get(addr);
    if (l) { while (l.length && (count < 0 || n < count)) { const r = l.shift(); clearTimeout(r.timer); r.resolve(0); n++; } if (!l.length) waiters.delete(addr); }
    stats.woken += n;
    // and real waiters (the glue's Atomics.waitAsync on thread mailboxes)
    try { n += Atomics.notify(view32(), addr >> 2, count < 0 ? Infinity : Math.max(0, count - n)); } catch (_) {}
    return n;
  }
  window.__coop = { wait32, wait64, notify, setMemory: (m) => { memory = m; } };

  // ---- fake Worker: an iframe realm on this thread ----
  let nextId = 1;
  class CoopWorker {
    constructor(url, opts) {
      this.id = nextId++;
      // a pthread spawning a thread has no script name (eval-loaded): reuse the main one
      if (url == null || url === 'undefined') url = CoopWorker.url; else CoopWorker.url = CoopWorker.url || url;
      this.onmessage = null; this.onerror = null;
      const name = (opts && opts.name) || ('em-pthread_' + this.id);
      const f = document.createElement('iframe');
      f.style.display = 'none'; f.name = name; document.body.appendChild(f);
      this.frame = f; const w = f.contentWindow; this.win = w;
      const self = this;
      w.name = name;
      // a worker's global API, inside the iframe realm
      w.importScripts = (...urls) => { for (const u of urls) { const x = new XMLHttpRequest(); x.open('GET', u, false); x.send();
          if (x.status !== 200 && x.status !== 0) throw new Error('importScripts ' + u + ': ' + x.status); w.eval(x.responseText + '\n//# sourceURL=' + u); } };
      w.postMessage = (msg, tr) => { const d = msg, ports = (Array.isArray(tr) ? tr : (tr && tr.transfer) || []).filter((x) => x instanceof MessagePort); setTimeout(() => { try { self.onmessage && self.onmessage({ data: d, ports }); } catch (e) { log('parent onmessage threw', e && e.stack || e); } }, 0); };
      w.close = () => self.terminate();
      w.__coop = window.__coop;
      w.__coopMain = window;   // the runtime's main thread (NOT top: the engine is itself an iframe)
      // Emscripten 4 tells a worker by WorkerGlobalScope: without it the iframe takes
      // itself for the main thread (allocates its own memory, spawns real Workers).
      w.WorkerGlobalScope = function WorkerGlobalScope() {};
      w.Worker = CoopWorker;
      if (typeof w.SharedArrayBuffer === 'undefined') w.SharedArrayBuffer = window.SharedArrayBuffer;
      setTimeout(() => { try { w.importScripts(url); } catch (e) { log('worker load failed', e && e.stack || e); self.onerror && self.onerror(e); } }, 0);
    }
    postMessage(msg, tr) { const w = this.win, ports = (Array.isArray(tr) ? tr : (tr && tr.transfer) || []).filter((x) => x instanceof MessagePort); setTimeout(() => { try { if (msg && msg.wasmMemory) window.__coop.setMemory(msg.wasmMemory); w.onmessage && w.onmessage({ data: msg, ports }); } catch (e) { log('worker onmessage threw', e && e.stack || e); } }, 0); }
    terminate() { try { this.frame.remove(); } catch (_) {} }
    addEventListener(t, fn) { if (t === 'message') this.onmessage = fn; else if (t === 'error') this.onerror = fn; }
    unref() {} ref() {}
  }
  window.Worker = CoopWorker;
  window.__coopLogFn = log;
})();
