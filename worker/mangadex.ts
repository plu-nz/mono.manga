/**
 * MangaDex proxy rules: which upstream paths may be requested, how long each
 * is cached, and which headers cross the proxy. Kept free of Hono so the
 * rules are easy to read and test.
 *
 * Policy: https://api.mangadex.org/docs/2-limitations/
 */

export const MANGADEX_API = 'https://api.mangadex.org';
export const MANGADEX_REPORT = 'https://api.mangadex.network/report';
/** MangaDex requires a real, non-spoofed User-Agent that identifies the client. */
export const USER_AGENT = 'PLUNZ-Manga/0.1 (+https://manga.plu.nz)';
export const MAX_QUERY_LENGTH = 4096;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface ApiRoute {
  name: string;
  pattern: RegExp;
  /** Seconds the edge keeps a successful response. */
  edgeTtl: number;
  /** Seconds the browser may reuse it; 0 means `no-store`. */
  browserTtl: number;
}

/** Read-only endpoints the app needs. Everything else is rejected with 404. */
export const API_ROUTES: readonly ApiRoute[] = [
  { name: 'search', pattern: /^manga$/, edgeTtl: 5 * MINUTE, browserTtl: 5 * MINUTE },
  { name: 'tags', pattern: /^manga\/tag$/, edgeTtl: DAY, browserTtl: DAY },
  { name: 'manga', pattern: new RegExp(`^manga/${UUID}$`), edgeTtl: HOUR, browserTtl: 10 * MINUTE },
  { name: 'feed', pattern: new RegExp(`^manga/${UUID}/feed$`), edgeTtl: 10 * MINUTE, browserTtl: 5 * MINUTE },
  { name: 'aggregate', pattern: new RegExp(`^manga/${UUID}/aggregate$`), edgeTtl: HOUR, browserTtl: 10 * MINUTE },
  { name: 'chapters', pattern: /^chapter$/, edgeTtl: 10 * MINUTE, browserTtl: 5 * MINUTE },
  { name: 'chapter', pattern: new RegExp(`^chapter/${UUID}$`), edgeTtl: 10 * MINUTE, browserTtl: 5 * MINUTE },
  // Base URLs are guaranteed for ~15 minutes; keep the shared copy short and never store it in the browser.
  { name: 'at-home', pattern: new RegExp(`^at-home/server/${UUID}$`), edgeTtl: MINUTE, browserTtl: 0 },
  { name: 'covers', pattern: /^cover$/, edgeTtl: HOUR, browserTtl: 10 * MINUTE },
  { name: 'statistics', pattern: new RegExp(`^statistics/manga/${UUID}$`), edgeTtl: HOUR, browserTtl: 10 * MINUTE },
];

/** Matches a path (without leading slash) against the allowlist. UUIDs must be lowercase, as MangaDex emits them. */
export function matchApiRoute(path: string): ApiRoute | undefined {
  return API_ROUTES.find(route => route.pattern.test(path));
}

export function browserCacheControl(seconds: number): string {
  return seconds > 0 ? `public, max-age=${seconds}` : 'no-store';
}

/**
 * Seconds until a rate-limited client may retry. MangaDex sends either
 * `Retry-After` (seconds) or `X-RateLimit-Retry-After` (UNIX timestamp).
 */
export function retryAfterSeconds(headers: Headers, now = Date.now()): number {
  const direct = Number(headers.get('retry-after'));
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);
  const until = Number(headers.get('x-ratelimit-retry-after'));
  if (Number.isFinite(until) && until > 0) return Math.max(1, Math.ceil(until - now / 1000));
  return 60;
}

/** Only these upstream response headers reach the browser (never `Set-Cookie`). */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-request-id'];

export function forwardedHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Headers sent upstream: built from scratch so client cookies, auth, and `Via` never leave the Worker. */
export function upstreamHeaders(accept: string): Headers {
  return new Headers({ 'user-agent': USER_AGENT, accept });
}

// --- Images ---------------------------------------------------------------

const COVER_FILE = /^[0-9a-f-]{36}\.(?:jpe?g|png|gif|webp)(?:\.(?:256|512)\.jpg)?$/;
const PAGE_HASH = /^[0-9a-f]{32}$/;
const PAGE_FILE = /^[A-Za-z0-9._-]{1,200}\.(?:jpe?g|png|gif|webp)$/;
const NODE_HOST = /^(?:[a-z0-9-]+\.)+mangadex\.network$/;

export function isCoverFile(file: string): boolean {
  return COVER_FILE.test(file);
}

export function isUuid(value: string): boolean {
  return new RegExp(`^${UUID}$`).test(value);
}

export function coverUpstreamUrl(mangaId: string, file: string): string {
  return `https://uploads.mangadex.org/covers/${mangaId}/${file}`;
}

export type PageQuality = 'data' | 'data-saver';

/**
 * Validates a MangaDex@Home page request. `base` is the opaque `baseUrl`
 * from `/at-home/server/{id}`; it must point at a MangaDex@Home node or the
 * MangaDex upload server so the proxy cannot be used to fetch anything else.
 */
export function pageUpstreamUrl(base: string, quality: string, hash: string, file: string): string | undefined {
  if ((quality !== 'data' && quality !== 'data-saver') || !PAGE_HASH.test(hash) || !PAGE_FILE.test(file)) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  if (!NODE_HOST.test(url.hostname) && url.hostname !== 'uploads.mangadex.org') return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  if (!/^[A-Za-z0-9_\-/]*$/.test(path) || path.includes('//')) return undefined;
  return `${url.origin}${path}/${quality}/${hash}/${file}`;
}

/** MangaDex asks clients to report every image fetched from a base URL that does not contain `mangadex.org`. */
export function shouldReport(upstreamUrl: string): boolean {
  return !upstreamUrl.includes('mangadex.org');
}

export interface ImageReport {
  url: string;
  success: boolean;
  cached: boolean;
  bytes: number;
  duration: number;
}
