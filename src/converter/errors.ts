/**
 * Error codes a user may see. The UI translates `code`; `message` is for logs.
 */
export type ConversionErrorCode =
  | 'aborted'
  | 'unsupported_browser'
  | 'image_decode_failed'
  | 'image_encode_failed'
  | 'worker_failed'
  | 'no_pages'
  | 'too_large'
  | 'invalid_job';

export class ConversionError extends Error {
  readonly code: ConversionErrorCode;
  /** Zero-based source page index the error relates to, when known. */
  readonly pageIndex?: number;

  constructor(code: ConversionErrorCode, message?: string, options?: { pageIndex?: number; cause?: unknown }) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConversionError';
    this.code = code;
    if (options?.pageIndex !== undefined) this.pageIndex = options.pageIndex;
  }
}

export function isConversionError(value: unknown): value is ConversionError {
  return value instanceof ConversionError;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConversionError('aborted', 'Conversion was cancelled.');
}
