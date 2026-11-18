/**
 * Errors a user may see from any Google integration. The UI translates by
 * `code`; `message` is English diagnostic text for logs.
 */
export type GoogleErrorCode =
  | 'not_configured'
  | 'popup_blocked'
  | 'popup_closed'
  | 'interaction_required'
  | 'access_denied'
  | 'quota'
  | 'too_large'
  | 'network'
  | 'api';

export class GoogleError extends Error {
  readonly code: GoogleErrorCode;
  /** HTTP status when the error came from a Google API response. */
  readonly status?: number;

  constructor(code: GoogleErrorCode, message?: string, options?: { status?: number; cause?: unknown }) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GoogleError';
    this.code = code;
    this.status = options?.status;
  }
}

export function isGoogleError(value: unknown, code?: GoogleErrorCode): value is GoogleError {
  return value instanceof Error && value.name === 'GoogleError' && (code === undefined || (value as GoogleError).code === code);
}

const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'storageQuotaExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
]);

const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'authError']);

/** Extracts `error.message` and reasons from a Google JSON error body, tolerating anything. */
function parseErrorBody(body: string): { message?: string; reasons: string[] } {
  try {
    const json = JSON.parse(body) as {
      error?: { message?: string; status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
    };
    const error = json.error;
    if (!error || typeof error !== 'object') return { reasons: [] };
    const reasons = [
      ...(error.errors ?? []).map((item) => item.reason),
      ...(error.details ?? []).map((item) => item.reason),
      error.status,
    ].filter((reason): reason is string => typeof reason === 'string');
    return { message: error.message, reasons };
  } catch {
    return { reasons: [] };
  }
}

/** Maps an HTTP status plus Google error body to a `GoogleError`. */
export function googleErrorFromStatus(status: number, body = '', context = 'Google API'): GoogleError {
  const { message, reasons } = parseErrorBody(body);
  const detail = `${context} failed with HTTP ${status}${message ? `: ${message}` : ''}`;
  if (status === 401) return new GoogleError('interaction_required', detail, { status });
  if (status === 413) return new GoogleError('too_large', detail, { status });
  if (status === 429 || reasons.some((reason) => QUOTA_REASONS.has(reason))) return new GoogleError('quota', detail, { status });
  if (status === 403 && reasons.some((reason) => SCOPE_REASONS.has(reason))) {
    return new GoogleError('interaction_required', detail, { status });
  }
  return new GoogleError('api', detail, { status });
}

/** Throws a mapped `GoogleError` unless the response is OK. */
export async function ensureOk(response: Response, context?: string): Promise<Response> {
  if (response.ok) return response;
  let body = '';
  try {
    body = await response.text();
  } catch {
    // Body is optional diagnostic detail.
  }
  throw googleErrorFromStatus(response.status, body, context);
}

/** Wraps `fetch` so transport failures surface as `GoogleError('network')`; aborts pass through. */
export async function googleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new GoogleError('network', 'Could not reach Google', { cause: error });
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
