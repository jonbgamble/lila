import { memoize } from 'lib';
import { type Feature, features } from 'lib/device';

import type { VisionWorkerResponse } from './editor.vision.worker';

export async function initModule({ file }: { file: File }): Promise<FEN> {
  const [worker, image] = await Promise.all([
    getReader(),
    window.createImageBitmap(file, { imageOrientation: 'from-image' }),
  ]);
  return new Promise<FEN>((resolve, reject) => {
    worker.onmessage = event => {
      const response = event.data as VisionWorkerResponse;
      if (response.type === 'placement') resolve(response.boardFen);
      else if (response.type === 'error') reject(new Error(response.message));
    };
    worker.onerror = event => reject(new Error(event.message));
    worker.postMessage({ type: 'image', image }, [image]);
  });
}

type VisionFeature = 'webgpu' | Feature;

interface VisionReader {
  model: string;
  runtime: string;
  wasm: string;
  providers: ('webgpu' | 'wasm')[];
  requires: VisionFeature[];
}

const getReader = memoize<Promise<Worker>>(async () => {
  const boardReaders: VisionReader[] = [
    // {
    //   model: 'lifat/vision/chessquerieslite-vits-644-fp32.onnx',
    //   runtime: 'npm/onnxruntime-web/ort.webgpu.min.mjs',
    //   wasm: 'npm/onnxruntime-web/ort-wasm-simd-threaded.asyncify',
    //   providers: ['webgpu', 'wasm'],
    //   requires: ['wasm', 'webgpu', 'dynamicImportFromWorker'],
    // },
    {
      model: 'lifat/vision/chessquerieslite-vits-644-int8.onnx',
      runtime: 'npm/onnxruntime-web/ort.wasm.min.mjs',
      wasm: 'npm/onnxruntime-web/ort-wasm-simd-threaded',
      providers: ['wasm'],
      requires: ['wasm', 'dynamicImportFromWorker'],
    },
  ] as const;

  // you can't detect webgpu synchronously in device.ts, so detection lives here.
  const deviceFeatures: VisionFeature[] = [...features()];
  if ('gpu' in navigator && (await navigator.gpu.requestAdapter())) deviceFeatures.push('webgpu');
  const reader = boardReaders.find(reader =>
    reader.requires.every(requirement => deviceFeatures.includes(requirement)),
  );
  if (!reader) throw new Error('device not supported');

  return new Promise<Worker>((resolve, reject) => {
    const worker = new Worker(
      site.asset.url(site.asset.jsModule('editor.vision.worker'), { documentOrigin: true }),
      { type: 'module' },
    );
    worker.onmessage = event => {
      const response = event.data as VisionWorkerResponse;
      if (response.type === 'ready') resolve(worker);
      else if (response.type === 'error') reject(new Error(response.message));
    };
    worker.onerror = event => reject(new Error(event.message));
    worker.postMessage({
      type: 'load',
      runtimeUrl: site.asset.url(reader.runtime),
      modelUrl: site.asset.url(reader.model),
      wasmUrl: site.asset.url(`${reader.wasm}.wasm`),
      wasmModuleUrl: site.asset.url(`${reader.wasm}.mjs`),
      executionProviders: reader.providers,
      threads: Math.min(4, navigator.hardwareConcurrency || 1),
    });
  });
});
