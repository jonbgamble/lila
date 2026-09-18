export interface VisionModule {
  readImage(file: File, status: (message: string) => void): Promise<FEN>;
}

export function initModule(): VisionModule {
  const worker = new Worker(
    site.asset.url(site.asset.jsModule('editor.vision.worker'), { documentOrigin: true }),
    { type: 'module' },
  );
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let pending: { resolve: (fen: FEN) => void; reject: (error: Error) => void } | undefined;

  worker.onmessage = event => {
    const response = event.data as VisionWorkerResponse;
    if (response.type === 'ready') readyResolve();
    else if (response.type === 'placement') {
      pending?.resolve(response.boardFen);
      pending = undefined;
    } else {
      const error = new Error(response.message);
      if (pending) pending.reject(error);
      else readyReject(error);
      pending = undefined;
    }
  };
  worker.onerror = event => readyReject(new Error(event.message));

  worker.postMessage({
    type: 'load',
    modelUrl: site.asset.url('lifat/vision/chessquerieslite-vits-644-int8.onnx'),
    wasmUrl: site.asset.url('npm/onnxruntime-web/ort-wasm-simd-threaded.wasm'),
    wasmModuleUrl: site.asset.url('npm/onnxruntime-web/ort-wasm-simd-threaded.mjs'),
    threads: Math.min(4, navigator.hardwareConcurrency || 1),
  });

  return {
    async readImage(file, status) {
      status('Loading ChessQueriesLite...');
      const [image] = await Promise.all([
        window.createImageBitmap(file, { imageOrientation: 'from-image' }),
        ready,
      ]);
      status('Reading board...');
      return new Promise<FEN>((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage({ type: 'image', image }, [image]);
      });
    },
  };
}

interface VisionLoadRequest {
  type: 'load';
  modelUrl: string;
  wasmUrl: string;
  wasmModuleUrl: string;
  threads: number;
}

interface VisionImageRequest {
  type: 'image';
  image: ImageBitmap;
}

export type VisionWorkerRequest = VisionLoadRequest | VisionImageRequest;

interface VisionReadyResponse {
  type: 'ready';
}

interface VisionPlacementResponse {
  type: 'placement';
  boardFen: string;
}

interface VisionErrorResponse {
  type: 'error';
  message: string;
}

export type VisionWorkerResponse = VisionReadyResponse | VisionPlacementResponse | VisionErrorResponse;
