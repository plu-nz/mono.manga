/**
 * Web Worker that runs the image pipeline off the main thread. It handles one
 * page per message; the main thread waits for each reply before sending the
 * next page, so at most one page is in flight.
 */
import { ConversionError } from './errors';
import { detectCanvasBackend, processImage, type CanvasBackend } from './image';
import type { WorkerRequest, WorkerResponse } from './protocol';

// The project's TypeScript lib is DOM, not WebWorker; this is the subset used here.
const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse, options?: { transfer?: Transferable[] }): void;
};

let backend: CanvasBackend | null | undefined;

/** Inside a worker there is no `document`, so this is the OffscreenCanvas backend or `null`. */
function workerBackend(): CanvasBackend | null {
  if (backend === undefined) backend = detectCanvasBackend();
  return backend;
}

function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (exact ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'probe') {
    const ok = workerBackend() !== null;
    scope.postMessage({ type: 'probe', ok, reason: ok ? undefined : 'OffscreenCanvas 2D or createImageBitmap is unavailable in workers.' });
    return;
  }
  if (request.type === 'process') void handleProcess(request);
});

async function handleProcess(request: Extract<WorkerRequest, { type: 'process' }>): Promise<void> {
  try {
    const active = workerBackend();
    if (!active) throw new ConversionError('unsupported_browser', 'OffscreenCanvas is unavailable in workers.');
    const blob = new Blob([request.buffer], { type: request.mime });
    const images = await processImage(blob, request.options, active, request.pageIndex);
    const payload = images.map((image) => ({
      buffer: ownBuffer(image.bytes),
      width: image.width,
      height: image.height,
    }));
    scope.postMessage({ type: 'result', id: request.id, images: payload }, { transfer: payload.map((image) => image.buffer) });
  } catch (error) {
    const code = error instanceof ConversionError ? error.code : 'worker_failed';
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ type: 'error', id: request.id, code, message });
  }
}
