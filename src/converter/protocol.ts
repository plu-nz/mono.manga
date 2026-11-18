/** Messages between the main thread and `converter.worker.ts`. */
import type { ConversionErrorCode } from './errors';
import type { ImageOptions } from './image';

export type WorkerRequest =
  | { type: 'probe' }
  | { type: 'process'; id: number; pageIndex: number; buffer: ArrayBuffer; mime: string; options: ImageOptions };

export interface WorkerImage {
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

export type WorkerResponse =
  | { type: 'probe'; ok: boolean; reason?: string }
  | { type: 'result'; id: number; images: WorkerImage[] }
  | { type: 'error'; id: number; code: ConversionErrorCode; message: string };
