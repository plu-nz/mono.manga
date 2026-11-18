/**
 * Page processors turn one source page Blob into Kindle-ready JPEG pages.
 * The worker processor is preferred; the main-thread processor is the
 * fallback when module workers or OffscreenCanvas in workers are unavailable.
 */
import type { ProcessedImage } from './epub';
import { ConversionError } from './errors';
import { detectCanvasBackend, processImage, type ImageOptions } from './image';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface PageProcessor {
  process(blob: Blob, options: ImageOptions, pageIndex: number): Promise<ProcessedImage[]>;
  /** Stops work immediately; pending `process` calls reject. */
  dispose(): void;
}

const PROBE_TIMEOUT_MS = 5000;

interface Pending {
  resolve(images: ProcessedImage[]): void;
  reject(error: unknown): void;
}

class WorkerPageProcessor implements PageProcessor {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data));
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.failAll(new ConversionError('worker_failed', event.message || 'The conversion worker crashed.'));
    });
    worker.addEventListener('messageerror', () => this.failAll(new ConversionError('worker_failed', 'Could not read a message from the conversion worker.')));
  }

  async process(blob: Blob, options: ImageOptions, pageIndex: number): Promise<ProcessedImage[]> {
    if (this.disposed) throw new ConversionError('aborted', 'Conversion was cancelled.');
    const buffer = await blob.arrayBuffer();
    if (this.disposed) throw new ConversionError('aborted', 'Conversion was cancelled.');
    const id = this.nextId++;
    return new Promise<ProcessedImage[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: WorkerRequest = { type: 'process', id, pageIndex, buffer, mime: blob.type, options };
      this.worker.postMessage(request, [buffer]);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.failAll(new ConversionError('aborted', 'Conversion was cancelled.'));
  }

  private onMessage(message: WorkerResponse): void {
    if (message.type === 'probe') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === 'result') {
      pending.resolve(message.images.map((image) => ({ bytes: new Uint8Array(image.buffer), width: image.width, height: image.height })));
    } else {
      pending.reject(new ConversionError(message.code, message.message));
    }
  }

  private failAll(error: ConversionError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}

/** Starts the conversion worker and checks it can process images; `null` when it cannot. */
async function startWorker(): Promise<Worker | null> {
  if (typeof Worker === 'undefined') return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./converter.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    function finish(result: boolean) {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(result);
    }
    function onMessage(event: MessageEvent<WorkerResponse>) {
      if (event.data.type === 'probe') finish(event.data.ok);
    }
    function onError(event: ErrorEvent) {
      event.preventDefault();
      finish(false);
    }
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'probe' } satisfies WorkerRequest);
  });
  if (!ok) {
    worker.terminate();
    return null;
  }
  return worker;
}

/** Runs the pipeline on the main thread; returns `null` when no canvas is available. */
export function createMainThreadProcessor(): PageProcessor | null {
  const backend = detectCanvasBackend();
  if (!backend) return null;
  let disposed = false;
  return {
    async process(blob, options, pageIndex) {
      if (disposed) throw new ConversionError('aborted', 'Conversion was cancelled.');
      return processImage(blob, options, backend, pageIndex);
    },
    dispose() {
      disposed = true;
    },
  };
}

/** Worker processor when possible, else main-thread processor; throws `unsupported_browser` otherwise. */
export async function createPageProcessor(): Promise<PageProcessor> {
  const worker = await startWorker();
  if (worker) return new WorkerPageProcessor(worker);
  const fallback = createMainThreadProcessor();
  if (fallback) return fallback;
  throw new ConversionError('unsupported_browser', 'This browser cannot convert images (no canvas support).');
}
