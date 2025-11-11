(() => {
  'use strict';
  let worker = null;
  let blobUrl = null;
  let parentPort = null;

  window.addEventListener('message', e => {
    if (!parentPort && e.ports && e.ports[0]) {
      parentPort = e.ports[0];
      parentPort.onmessage = ev => {
        if (!ev.data) return;
        if (ev.data.type === 'boot') {
          try {
            worker = makeWorker(ev.data.code);
            parentPort.postMessage({ type: 'ready' });
          } catch (e) {
            console.error(e);
            parentPort.postMessage({ type: 'error', message: String((e && e.message) || e) });
          }
          return;
        }
        if (!worker) return;
        if (ev.data.type === 'score') {
          try {
            worker.postMessage(ev.data);
          } catch (e) {
            console.error(e);
            parentPort.postMessage({ type: 'error', message: String((e && e.message) || e) });
          }
        } else if (ev.data.type === 'terminate') {
          try {
            worker.terminate();
          } catch {}
          try {
            blobUrl && URL.revokeObjectURL(blobUrl);
          } catch {}
          //parentPort.postMessage({ type: 'message', data: { type: 'terminated' } });
        }
      };
      parentPort.start && parentPort.start();
    }
  });

  function makeWorker(userScript) {
    const blob = new Blob([userScript], { type: 'text/javascript' });
    blobUrl = URL.createObjectURL(blob);
    worker = new Worker(blobUrl, { type: 'classic', name: 'filter-worker' });

    worker.onmessage = msg => {
      console.log(msg.data);
      parentPort.postMessage({ type: 'result', result: msg.data.result });
    };
    worker.onerror = err => {
      console.log(err);
      parentPort.postMessage({ type: 'error', message: err.message });
    };
    return worker;
  }
})();
