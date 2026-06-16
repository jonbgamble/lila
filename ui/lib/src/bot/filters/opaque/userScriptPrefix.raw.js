(() => {
  'use strict';

  const postToIframe = globalThis.postMessage;

  globalThis.addEventListener('message', async e => {
    if (!e.data || e.data.type !== 'score' || !e.data.params) return;
    const { moves, args, limiter } = e.data.params;
    try {
      if (typeof globalThis.score !== 'function') {
        throw new Error('Expected global function "score(moves, args, limiter)"');
      }
      args.chess = Object.assign(globalThis.co.Chess.default(), args.chess);
      postToIframe({ type: 'result', result: await globalThis.score(moves, args, limiter) });
    } catch (err) {
      postToIframe({ type: 'error', message: err && err.message ? err.message : String(err) });
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
  ].forEach(nukeGlobal); // not all will be writeable. just do what we can

  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Map.prototype);
  Object.freeze(Set.prototype);

  function nukeGlobal(key) {
    try {
      Reflect.deleteProperty(globalThis, key);
      Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
    } catch {}
  }
})();
