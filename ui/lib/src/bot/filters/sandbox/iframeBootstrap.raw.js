(() => {
  'use strict';
  let iframeWorker = null;
  let iframeWorkerBlobUrl = null;
  let originPort = null;

  const handlers = {
    boot(data) {
      iframeWorkerBlobUrl = URL.createObjectURL(new Blob([data.workerScript], { type: 'text/javascript' }));
      iframeWorker = new Worker(iframeWorkerBlobUrl, { type: 'classic', name: 'filter-iframeWorker' });
      iframeWorker.onmessage = msg => originPort.postMessage(msg.data);
      iframeWorker.onerror = err => originPort.postMessage({ type: 'error', message: err.message });

      originPort.postMessage({ type: 'iframeWorkerIsReady' });
    },

    score: data => iframeWorker.postMessage(data),

    terminate() {
      iframeWorker?.terminate();
      originPort?.close();
      URL.revokeObjectURL(iframeWorkerBlobUrl);
      iframeWorker = null;
      originPort = null;
      iframeWorkerBlobUrl = null;
    },
  };
  window.onmessage = e => {
    if (originPort || !e.ports?.[0]) return;
    originPort = e.ports[0];

    originPort.onmessage = ev => {
      try {
        handlers[ev.data.type](ev.data);
      } catch (err) {
        console.error(err);
        originPort?.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    };
    originPort.start();
  };
})();
