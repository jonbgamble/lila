(() => {
  'use strict';
  let iframeWorker = null;
  let iframeWorkerBlobUrl = null;
  let iframePort = null;

  window.onmessage = e => {
    if (iframePort || !e.ports?.[0]) return;

    iframePort = e.ports[0];
    iframePort.onmessage = ev => {
      if (!ev.data) return;
      try {
        if (ev.data.type === 'boot') {
          iframeWorker = makeIframeWorker(ev.data.iframeWorkerScript);
          iframePort.postMessage({ type: 'iframeWorkerIsReady' });
        } else if (ev.data.type === 'score') {
          iframeWorker.postMessage(ev.data);
        } else if (ev.data.type === 'terminate') {
          iframeWorker?.terminate();
          iframePort?.close();
          URL.revokeObjectURL(iframeWorkerBlobUrl);
          iframeWorker = null;
          iframePort = null;
          iframeWorkerBlobUrl = null;
        }
      } catch (e) {
        console.error(e);
        iframePort?.postMessage({ type: 'error', message: String((e && e.message) || e) });
      }
    };
    iframePort.start();
  };

  function makeIframeWorker(iframeWorkerScript) {
    iframeWorkerBlobUrl = URL.createObjectURL(new Blob([iframeWorkerScript], { type: 'text/javascript' }));
    iframeWorker = new Worker(iframeWorkerBlobUrl, { type: 'classic', name: 'filter-iframeWorker' });

    iframeWorker.onmessage = msg => iframePort.postMessage(msg.data);
    iframeWorker.onerror = err => iframePort.postMessage({ type: 'error', message: err.message });
    return iframeWorker;
  }
})();
