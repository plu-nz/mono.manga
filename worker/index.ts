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
import {
  MAX_SEARCH_LENGTH,
  SESSION_TTL_MS,
  bearer,
  chapterListUpstreamUrl,
  isSourceId,
  pagesUpstreamUrl,
  parseAllowlist,
  parsePageImages,
  searchUpstreamUrl,
  signImageUrl,
  signSession,
  verifiedEmail,
  verifyImageUrl,
  verifySession,
  type TokenInfo,
} from './extra';

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Per-IP limit for MangaDex JSON requests. */
  API_LIMIT: RateLimiter;
  /** Optional per-IP limit for proxied images (covers and chapter pages). */
  IMAGE_LIMIT?: RateLimiter;
  /** Google OAuth client id of the app; session exchange only accepts its tokens. */
  GOOGLE_CLIENT_ID?: string;
  /** Secret: HMAC key for extra-source sessions and image links. Extra sources are off without it. */
  EXTRA_SOURCES_SECRET?: string;
  /** Secret: comma-separated Google emails allowed to use extra sources. */
  EXTRA_SOURCES_EMAILS?: string;
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

function errorResponse(c: AppContext, status: 400 | 401 | 403 | 404 | 405 | 414 | 429 | 502, error: string, extra?: Record<string, string>): Response {
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
function crossSite(c: AppContext): boolean {
  const site = c.req.header('sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
}

app.use('/api/mangadex/*', async (c, next) => {
  if (crossSite(c)) return errorResponse(c, 403, 'forbidden');
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

async function proxyImage(c: AppContext, upstreamUrl: string, key: Request, ttl: number, report = true): Promise<Response> {
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
    if (report) reportImage(c, { url: upstreamUrl, success: false, cached: false, bytes: 0, duration: Date.now() - started });
    return errorResponse(c, 502, 'image_unreachable');
  }
  const cached = (upstream.headers.get('x-cache') ?? '').toUpperCase().startsWith('HIT');
  const contentType = upstream.headers.get('content-type') ?? '';
  const declared = Number(upstream.headers.get('content-length') ?? 0);
  if (!upstream.ok || !contentType.startsWith('image/') || declared > MAX_IMAGE_BYTES) {
    const body = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (report) reportImage(c, { url: upstreamUrl, success: false, cached, bytes: body.byteLength, duration: Date.now() - started });
    return upstream.status === 404 ? errorResponse(c, 404, 'not_found') : errorResponse(c, 502, 'image_unavailable');
  }
  const body = await upstream.arrayBuffer().catch(() => undefined);
  if (!body || body.byteLength > MAX_IMAGE_BYTES) {
    if (report) reportImage(c, { url: upstreamUrl, success: false, cached, bytes: body?.byteLength ?? 0, duration: Date.now() - started });
    return errorResponse(c, 502, 'image_unavailable');
  }
  if (report) reportImage(c, { url: upstreamUrl, success: true, cached, bytes: body.byteLength, duration: Date.now() - started });
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

// --- Extra sources (allowlisted accounts only) ------------------------------------

const EXTRA_USER_AGENT = USER_AGENT;
const SEARCH_TTL = 5 * 60;
const LIST_TTL = 10 * 60;

app.use('/api/extra/*', async (c, next) => {
  if (crossSite(c)) return errorResponse(c, 403, 'forbidden');
  if (!c.env.EXTRA_SOURCES_SECRET) return errorResponse(c, 404, 'not_configured');
  await next();
});

app.use('/api/weebcentral/*', async (c, next) => {
  if (crossSite(c)) return errorResponse(c, 403, 'forbidden');
  if (!c.env.EXTRA_SOURCES_SECRET) return errorResponse(c, 404, 'not_configured');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return errorResponse(c, 405, 'method_not_allowed', { allow: 'GET, HEAD' });
  // Images carry their own signature; everything else needs a session.
  if (c.req.path !== '/api/weebcentral/image') {
    const token = bearer(c.req.header('authorization'));
    const session = token && await verifySession(c.env.EXTRA_SOURCES_SECRET, token, parseAllowlist(c.env.EXTRA_SOURCES_EMAILS));
    if (!session) return errorResponse(c, 401, 'unauthorized');
  }
  await next();
});

/** Exchange a Google access token of an allowlisted account for a long-lived session. */
app.post('/api/extra/session', async c => {
  const limited = await rateLimited(c, c.env.API_LIMIT, 'session');
  if (limited) return limited;
  const accessToken = bearer(c.req.header('authorization'));
  if (!accessToken) return errorResponse(c, 401, 'unauthorized');
  let info: TokenInfo;
  try {
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!response.ok) return errorResponse(c, 401, 'unauthorized');
    info = await response.json<TokenInfo>();
  } catch {
    return errorResponse(c, 502, 'upstream_unreachable');
  }
  const email = verifiedEmail(info, c.env.GOOGLE_CLIENT_ID);
  if (!email) return errorResponse(c, 401, 'unauthorized');
  if (!parseAllowlist(c.env.EXTRA_SOURCES_EMAILS).has(email)) return errorResponse(c, 403, 'not_authorized');
  const session = { email, expiresAt: Date.now() + SESSION_TTL_MS };
  return c.json({ token: await signSession(c.env.EXTRA_SOURCES_SECRET!, session), ...session }, 200, { 'cache-control': 'no-store' });
});

/**
 * Relay an upstream HTML page as plain text (never rendered on this origin);
 * the app parses it. Successful responses are shared at the edge for `ttl`.
 */
async function relayText(c: AppContext, upstreamUrl: string, cacheSuffix: string, ttl: number): Promise<Response> {
  const limited = await rateLimited(c, c.env.API_LIMIT, 'extra');
  if (limited) return limited;
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" };
  const key = cacheKey(c, `extra/${cacheSuffix}`);
  const cache = edgeCache();
  const hit = await cache?.match(key);
  if (hit) return new Response(hit.body, { status: 200, headers: { ...headers, 'x-edge-cache': 'HIT' } });
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { headers: { 'user-agent': EXTRA_USER_AGENT, accept: 'text/html' } });
  } catch {
    return errorResponse(c, 502, 'upstream_unreachable');
  }
  if (upstream.status === 404) return errorResponse(c, 404, 'not_found');
  if (upstream.status === 429) return errorResponse(c, 429, 'rate_limited', { 'retry-after': '60' });
  if (!upstream.ok) return errorResponse(c, 502, 'upstream_error');
  const body = await upstream.arrayBuffer();
  if (cache) defer(c, cache.put(key, new Response(body, { headers: { ...headers, 'cache-control': `public, max-age=${ttl}` } })));
  return new Response(body, { status: 200, headers: { ...headers, 'x-edge-cache': 'MISS' } });
}

app.get('/api/weebcentral/search', c => {
  const query = (c.req.query('q') ?? '').trim();
  if (!query || query.length > MAX_SEARCH_LENGTH) return errorResponse(c, 400, 'bad_request');
  return relayText(c, searchUpstreamUrl(query), `weebcentral/search/${encodeURIComponent(query.toLowerCase())}`, SEARCH_TTL);
});

app.get('/api/weebcentral/series/:id/chapters', c => {
  const { id } = c.req.param();
  if (!isSourceId(id)) return errorResponse(c, 404, 'not_found');
  return relayText(c, chapterListUpstreamUrl(id), `weebcentral/series/${id}`, LIST_TTL);
});

app.get('/api/weebcentral/chapters/:id/pages', async c => {
  const { id } = c.req.param();
  if (!isSourceId(id)) return errorResponse(c, 404, 'not_found');
  const limited = await rateLimited(c, c.env.API_LIMIT, 'extra');
  if (limited) return limited;
  let upstream: Response;
  try {
    upstream = await fetch(pagesUpstreamUrl(id), { headers: { 'user-agent': EXTRA_USER_AGENT, accept: 'text/html' } });
  } catch {
    return errorResponse(c, 502, 'upstream_unreachable');
  }
  if (upstream.status === 404) return errorResponse(c, 404, 'not_found');
  if (!upstream.ok) return errorResponse(c, 502, 'upstream_error');
  const images = parsePageImages(await upstream.text());
  if (!images.length) return errorResponse(c, 502, 'upstream_error');
  const secret = c.env.EXTRA_SOURCES_SECRET!;
  const pages = await Promise.all(images.map(url => signImageUrl(secret, url)));
  return c.json({ pages }, 200, { 'cache-control': 'private, max-age=600' });
});

app.get('/api/weebcentral/image', async c => {
  const encoded = c.req.query('u');
  const upstreamUrl = await verifyImageUrl(c.env.EXTRA_SOURCES_SECRET!, encoded, c.req.query('s'));
  if (!upstreamUrl) return errorResponse(c, 403, 'forbidden');
  return proxyImage(c, upstreamUrl, cacheKey(c, `extra/image/${encoded}`), DAY, false);
});

app.all('/api/*', c => errorResponse(c, 404, 'not_found'));
// Non-API paths are served by the assets binding before the Worker runs; this is a defensive fallback.
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
