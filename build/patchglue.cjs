// Patch LibreOffice's Emscripten glue (soffice.js) for coop.js:
//  1. hand the coop.* imports (and the memory) to every instantiation
//  2. run each pthread's entry through WebAssembly.promising, so its waits can suspend
'use strict';
const fs = require('fs');
const [inp, outp] = process.argv.slice(2);
let s = fs.readFileSync(inp, 'utf8');
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 80)}`); s = s.replace(a, b); };
//    ... and record the embind registrations a thread makes once it runs (soffice's start
//    registers every UNO type from its main thread, init_unoembind_uno): that registry is
//    JS state of the thread's realm, which an engine snapshot (lok/editor.html) replays
rep('function getWasmImports(){assignWasmImports();return{env:wasmImports,wasi_snapshot_preview1:wasmImports}}',
    'var __coopEmbindLog=null;function getWasmImports(){assignWasmImports();for(const k of Object.keys(wasmImports)){if(!/^_embind_(register|finalize)/.test(k))continue;const f=wasmImports[k];wasmImports[k]=function(...a){if(__coopEmbindLog)__coopEmbindLog.push([k,a]);return f.apply(this,a)}}var __c=globalThis.__coop;__c.setMemory(wasmMemory);return{env:wasmImports,wasi_snapshot_preview1:wasmImports,coop:__c}}');
rep('var result=getWasmTableEntry(ptr)(arg);checkStackCookie();function finish(result){if(keepRuntimeAlive()){EXITSTATUS=result}else{__emscripten_thread_exit(result)}}finish(result)',
    'function finish(result){if(keepRuntimeAlive()){EXITSTATUS=result}else{__emscripten_thread_exit(result)}}' +
    'WebAssembly.promising(getWasmTableEntry(ptr))(arg).then(r=>{checkStackCookie();finish(r)},e=>{if(e!="unwind"){err("coop: thread entry threw: "+(e&&e.stack||e))}})');
rep('wasmModuleReceived=module=>{var instance=new WebAssembly.Instance(module,getWasmImports());resolve(receiveInstance(instance,module))}', 'wasmModuleReceived=module=>{WebAssembly.instantiate(module,getWasmImports()).then(instance=>{var __r=receiveInstance(instance,module);try{var __h=self.__coopMain&&self.__coopMain.__coopOnInstance;if(__h)__h(self)}catch(__e){err("coop: instance hook threw: "+__e)}resolve(__r)},e=>{err("coop: pthread instantiate failed: "+e)})}');  // >8MB sync Instance is refused on a window thread
// 3. A pthread's proxied JS call (every FS syscall, EM_ASM on main) used to go through
//    wasm (_emscripten_run_on_main_thread_js) and WAIT for the main thread -- a wait
//    reached through a JS frame, which JSPI cannot suspend ("trying to suspend JS frames").
//    Here every thread shares this one JS thread and memory, so run the main runtime's
//    function directly: a sync call returns its result with no waiting at all.
rep('var proxyToMainThread=(funcIndex,emAsmAddr,sync,...callArgs)=>{', 'var proxyToMainThread=(funcIndex,emAsmAddr,sync,...callArgs)=>{if(ENVIRONMENT_IS_PTHREAD&&self.__coopMain&&self.__coopMain!==self){var T=self.__coopMain,f=emAsmAddr?T.ASM_CONSTS[emAsmAddr]:T.proxiedFunctionTable[funcIndex];var run=()=>{T.PThread.currentProxiedOperationCallerThread=_pthread_self();try{return f(...callArgs)}catch(__e){(T.__coopLog=T.__coopLog||[]).push("proxied fn "+(f&&f.name)+" threw: "+(__e&&__e.stack||__e));throw __e}finally{T.PThread.currentProxiedOperationCallerThread=0}};if(!sync){setTimeout(run,0);return 0}return run()}');
rep('function abort(what){', 'function abort(what){try{var __m=self.__coopMain||self;(__m.__coopLog=__m.__coopLog||[]).push("ABORT "+what+" "+new Error().stack.split("\\n").slice(1,40).join(" | "))}catch(_){}');
// 4. LibreOffice's event loop runs as emscripten_set_main_loop iterations called from JS
//    timers, so a wait inside an iteration (Calc's import waits on its parser thread)
//    was not suspendable -> SuspendError -> std::terminate. Run each iteration as a
//    promising entry and skip ticks while one is paused, so iterations never overlap.
rep('var _emscripten_set_main_loop_arg=(func,arg,fps,simulateInfiniteLoop)=>{var iterFunc=()=>getWasmTableEntry(func)(arg);',
    'var _emscripten_set_main_loop_arg=(func,arg,fps,simulateInfiniteLoop)=>{self.__coopLoopArgs=[func,arg,fps];var __it=WebAssembly.promising(getWasmTableEntry(func)),__busy=false;var iterFunc=()=>{if(__busy)return;self.__coopLoopBusy=__busy=true;__it(arg).then(()=>{self.__coopLoopBusy=__busy=false},e=>{self.__coopLoopBusy=__busy=false;if(e!="unwind"){err("coop: main loop iteration threw: "+(e&&e.stack||e))}})};');
// 5. Interactive mode (convert/lo/lok/): LibreOfficeKit calls must run on a pthread (a wait
//    on the page thread busy-spins). The page takes over the thread callMain() starts --
//    __coopEntryHook(realm) returning true keeps it for the page's own jobs -- and
//    __coopOnInstance(realm) runs once each thread's instance is up (it registers the
//    LOK callback function in every realm's table). Both are no-ops for conversions.
//    __coopLoopArgs (4.) and __coopEmbindLog (1.) are what a snapshot needs of a thread.
rep('var invokeEntryPoint=(ptr,arg)=>{', 'var invokeEntryPoint=(ptr,arg)=>{__coopEmbindLog=[];self.__coopEntry=[ptr,arg];var __h=self.__coopMain&&self.__coopMain.__coopEntryHook;if(__h&&__h(self,ptr,arg))return;');
fs.writeFileSync(outp, s);
console.log('patched', outp);
