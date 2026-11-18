/**
 * Errors a user may see from a provider. The UI translates `code`;
 * `message` is for logs only.
 */
export type ProviderErrorCode =
  | 'rate_limited'
  | 'network'
  | 'not_found'
  | 'upstream'
  | 'empty_archive'
  | 'unsupported_format'
  | 'unauthorized';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /** HTTP status of the failed response, when there was one. */
  readonly status?: number;
  /** Seconds to wait before retrying, for `rate_limited`. */
  readonly retryAfter?: number;

  constructor(code: ProviderErrorCode, message?: string, options?: { status?: number; retryAfter?: number; cause?: unknown }) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

export function isProviderError(value: unknown, code?: ProviderErrorCode): value is ProviderError {
  return value instanceof ProviderError && (code === undefined || value.code === code);
}
