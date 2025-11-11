(() => {
  'use strict';

  const sendMessage = postMessage;
  //let handler = null;

  globalThis.addEventListener('message', async e => {
    if (!e.data || e.data.type !== 'score' || !e.data.params) return;
    const { moves, args, limiter } = e.data.params;
    try {
      //if (!handler) {
      if (typeof globalThis.score !== 'function')
        throw new Error('Expected global function "score(moves, args, limiter)"');
      //handler = globalThis.score;
      // try {
      //   Object.defineProperty(globalThis, 'score', {
      //     value: undefined,
      //     writable: false,
      //     configurable: false,
      //   });
      // } catch {}
      //}
      const maybeAsync = globalThis.score(moves, args, limiter);
      const result =
        'then' in maybeAsync && typeof maybeAsync.then === 'function' ? await maybeAsync : maybeAsync;
      sendMessage({ type: 'result', result });
    } catch (err) {
      sendMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  });
  [
    'postMessage',
    'onmessage',
    'addEventListener',
    'removeEventListener',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'importScripts',
    'navigator',
    'location',
    'Function',
    'eval',
    'setTimeout',
    'setInterval',
    'queueMicrotask',
    'crypto',
    'SharedArrayBuffer',
    'Atomics',
    'WebAssembly',
    'indexedDB',
    'caches',
    'FileReader',
    'URL',
    'URLSearchParams',
    'self',
  ].forEach(nuke); // not all of these will be writeable. just do all we can

  freeze(Object.prototype);
  freeze(Array.prototype);
  freeze(Map.prototype);
  freeze(Set.prototype);

  function nuke(key) {
    try {
      Reflect.deleteProperty(globalThis, key);
      Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
    } catch {
      console.info('no undefine', key);
    }
  }
  function freeze(k) {
    try {
      Object.freeze(k);
    } catch {
      console.info('no freeze', String(k));
    }
  }
})();
