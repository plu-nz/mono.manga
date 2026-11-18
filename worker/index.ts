import { Hono, type Context } from 'hono';
import {
  MANGADEX_API,
  MANGADEX_REPORT,
  MAX_QUERY_LENGTH,
  USER_AGENT,
  browserCacheControl,
  coverUpstreamUrl,
  forwardedHeaders,
  isCoverFile,
  isUuid,
  matchApiRoute,
  pageUpstreamUrl,
  retryAfterSeconds,
  shouldReport,
  upstreamHeaders,
  type ImageReport,
} from './mangadex';

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Per-IP limit for MangaDex JSON requests. */
  API_LIMIT: RateLimiter;
  /** Optional per-IP limit for proxied images (covers and chapter pages). */
  IMAGE_LIMIT?: RateLimiter;
}

type AppContext = Context<{ Bindings: Env }>;

const DAY = 24 * 60 * 60;
const COVER_TTL = 7 * DAY;
const PAGE_TTL = DAY;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PREFIX = '/api/mangadex/';

export const app = new Hono<{ Bindings: Env }>();

function edgeCache(): Cache | undefined {
  return typeof caches === 'undefined' ? undefined : (caches as CacheStorage & { default?: Cache }).default;
}

/** Runs work after the response when the runtime allows it (tests may not provide an execution context). */
function defer(c: AppContext, work: Promise<unknown>): void {
  const settled = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No execution context: the promise still runs, just without extending the request lifetime.
  }
}

function clientKey(c: AppContext): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

function cacheKey(c: AppContext, suffix: string): Request {
  return new Request(`${new URL(c.req.url).origin}/__edge-cache/${suffix}`);
}

function errorResponse(c: AppContext, status: 400 | 403 | 404 | 405 | 414 | 429 | 502, error: string, extra?: Record<string, string>): Response {
  return c.json({ error }, status, { 'cache-control': 'no-store', ...extra });
}

async function rateLimited(c: AppContext, limiter: RateLimiter | undefined, scope: string): Promise<Response | undefined> {
  if (!limiter) return undefined;
  const { success } = await limiter.limit({ key: `${scope}:${clientKey(c)}` });
  return success ? undefined : errorResponse(c, 429, 'rate_limited', { 'retry-after': '60' });
}

app.get('/api/healthz', c => c.json({ ok: true }, 200, { 'cache-control': 'no-store' }));

// The app is served from this Worker, so browsers only call the proxy same-origin.
// Reject requests a browser marks as coming from another site (hotlinking the proxy).
app.use('/api/mangadex/*', async (c, next) => {
  const site = c.req.header('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return errorResponse(c, 403, 'forbidden');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return errorResponse(c, 405, 'method_not_allowed', { allow: 'GET, HEAD' });
  await next();
});

// --- Images -----------------------------------------------------------------
// MangaDex serves a placeholder to browsers on third-party origins and requires
// image requests to be proxied (https://api.mangadex.org/docs/2-limitations/).

function reportImage(c: AppContext, report: ImageReport): void {
  if (!shouldReport(report.url)) return;
  defer(c, fetch(MANGADEX_REPORT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(5000),
  }).then(response => response.body?.cancel()));
}

function imageHeaders(contentType: string, bytes: number, ttl: number): Headers {
  return new Headers({
    'content-type': contentType,
    'content-length': String(bytes),
    'cache-control': `public, max-age=${ttl}, immutable`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
  });
}

async function proxyImage(c: AppContext, upstreamUrl: string, key: Request, ttl: number): Promise<Response> {
  const limited = await rateLimited(c, c.env.IMAGE_LIMIT, 'img');
  if (limited) return limited;
  const cache = edgeCache();
  const hit = await cache?.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-edge-cache', 'HIT');
    return new Response(hit.body, { status: 200, headers });
  }

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { headers: upstreamHeaders('image/avif,image/webp,image/*;q=0.8') });
  } catch {
    reportImage(c, { url: upstreamUrl, success: false, cached: false, bytes: 0, duration: Date.now() - started });
    return errorResponse(c, 502, 'image_unreachable');
  }
  const cached = (upstream.headers.get('x-cache') ?? '').toUpperCase().startsWith('HIT');
  const contentType = upstream.headers.get('content-type') ?? '';
  const declared = Number(upstream.headers.get('content-length') ?? 0);
  if (!upstream.ok || !contentType.startsWith('image/') || declared > MAX_IMAGE_BYTES) {
    const body = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0));
    reportImage(c, { url: upstreamUrl, success: false, cached, bytes: body.byteLength, duration: Date.now() - started });
    return upstream.status === 404 ? errorResponse(c, 404, 'not_found') : errorResponse(c, 502, 'image_unavailable');
  }
  const body = await upstream.arrayBuffer().catch(() => undefined);
  if (!body || body.byteLength > MAX_IMAGE_BYTES) {
    reportImage(c, { url: upstreamUrl, success: false, cached, bytes: body?.byteLength ?? 0, duration: Date.now() - started });
    return errorResponse(c, 502, 'image_unavailable');
  }
  reportImage(c, { url: upstreamUrl, success: true, cached, bytes: body.byteLength, duration: Date.now() - started });
  const headers = imageHeaders(contentType, body.byteLength, ttl);
  if (cache) defer(c, cache.put(key, new Response(body, { headers })));
  headers.set('x-edge-cache', 'MISS');
  return new Response(body, { status: 200, headers });
}

app.get('/api/mangadex/covers/:mangaId/:file', c => {
  const { mangaId, file } = c.req.param();
  if (!isUuid(mangaId) || !isCoverFile(file)) return errorResponse(c, 404, 'not_found');
  return proxyImage(c, coverUpstreamUrl(mangaId, file), cacheKey(c, `covers/${mangaId}/${file}`), COVER_TTL);
});

app.get('/api/mangadex/page/:quality/:hash/:file', c => {
  const { quality, hash, file } = c.req.param();
  const upstreamUrl = pageUpstreamUrl(c.req.query('base') ?? '', quality, hash, file);
  if (!upstreamUrl) return errorResponse(c, 404, 'not_found');
  // Page files are content-addressed, so the cached copy is shared across MangaDex@Home nodes.
  return proxyImage(c, upstreamUrl, cacheKey(c, `pages/${quality}/${hash}/${file}`), PAGE_TTL);
});

// --- JSON API -------------------------------------------------------------------

app.get('/api/mangadex/*', async c => {
  const url = new URL(c.req.url);
  const path = url.pathname.slice(PREFIX.length);
  const route = matchApiRoute(path);
  if (!route) return errorResponse(c, 404, 'not_found');
  if (url.search.length > MAX_QUERY_LENGTH + 1) return errorResponse(c, 414, 'query_too_long');

  const limited = await rateLimited(c, c.env.API_LIMIT, 'api');
  if (limited) return limited;

  const key = cacheKey(c, `mangadex/${path}${url.search}`);
  const cache = edgeCache();
  const hit = await cache?.match(key);
  if (hit) {
    const headers = forwardedHeaders(hit.headers);
    headers.set('cache-control', browserCacheControl(route.browserTtl));
    headers.set('x-edge-cache', 'HIT');
    return new Response(hit.body, { status: 200, headers });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${MANGADEX_API}/${path}${url.search}`, { headers: upstreamHeaders('application/json') });
  } catch {
    return errorResponse(c, 502, 'upstream_unreachable');
  }

  const headers = forwardedHeaders(upstream.headers);
  if (!upstream.ok) {
    headers.set('cache-control', 'no-store');
    if (upstream.status === 429) headers.set('retry-after', String(retryAfterSeconds(upstream.headers)));
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const body = await upstream.arrayBuffer();
  if (cache) {
    const stored = forwardedHeaders(upstream.headers);
    stored.set('cache-control', `public, max-age=${route.edgeTtl}`);
    defer(c, cache.put(key, new Response(body, { headers: stored })));
  }
  headers.set('cache-control', browserCacheControl(route.browserTtl));
  headers.set('x-edge-cache', 'MISS');
  return new Response(body, { status: 200, headers });
});

app.all('/api/*', c => errorResponse(c, 404, 'not_found'));
// Non-API paths are served by the assets binding before the Worker runs; this is a defensive fallback.
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
