// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app, type Env } from './index';
import { USER_AGENT, pageUpstreamUrl, retryAfterSeconds } from './mangadex';

const MANGA = '58be6aa6-06cb-4ca5-bd20-f1392ce451fb';
const CHAPTER = 'a3de73a0-ec90-42f1-bdb2-8ab7d95fa2c0';
const HASH = '74f21f6b8eb1d5851cc4f51ff3dcfdd1';
const ORIGIN = 'https://manga.plu.nz';

class MemoryCache {
  readonly store = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
}

let cache: MemoryCache;
let upstream: ReturnType<typeof vi.fn>;
let allow: boolean;
const limitKeys: string[] = [];

function env(extra: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    API_LIMIT: { limit: async ({ key }) => { limitKeys.push(key); return { success: allow }; } },
    ...extra,
  };
}

async function call(path: string, init: RequestInit = {}, bindings = env()): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, init), bindings, ctx);
  await Promise.all(pending);
  return response;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });
}

function upstreamRequest(index = 0): { url: string; headers: Headers } {
  const [url, init] = upstream.mock.calls[index] as [string, RequestInit | undefined];
  return { url, headers: new Headers(init?.headers) };
}

beforeEach(() => {
  cache = new MemoryCache();
  allow = true;
  limitKeys.length = 0;
  upstream = vi.fn(async () => json({ result: 'ok' }, { headers: { 'set-cookie': 'session=1', 'x-request-id': 'req-1', vary: 'Origin' } }));
  vi.stubGlobal('fetch', upstream);
  vi.stubGlobal('caches', { default: cache });
});

afterEach(() => vi.unstubAllGlobals());

describe('basics', () => {
  test('health check', async () => {
    const response = await call('/api/healthz');
    expect(await response.json()).toEqual({ ok: true });
  });

  test('unknown API paths are 404 JSON', async () => {
    const response = await call('/api/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  test('non-API paths fall back to assets', async () => {
    expect(await (await call('/library')).text()).toBe('asset');
  });
});

describe('MangaDex JSON proxy', () => {
  test.each([
    'manga?title=yotsuba',
    `manga/${MANGA}`,
    `manga/${MANGA}/feed?limit=500`,
    `manga/${MANGA}/aggregate`,
    'manga/tag',
    'chapter?ids[]=x',
    `chapter/${CHAPTER}`,
    `at-home/server/${CHAPTER}`,
    'cover?manga[]=x',
    `statistics/manga/${MANGA}`,
  ])('allows %s', async path => {
    const response = await call(`/api/mangadex/${path}`);
    expect(response.status).toBe(200);
    expect(upstreamRequest().url).toBe(`https://api.mangadex.org/${path}`);
  });

  test.each([
    'user/me',
    'auth/login',
    'manga/random',
    'manga/not-a-uuid',
    `manga/${MANGA.toUpperCase()}`,
    `manga/${MANGA}/read`,
    `manga/${MANGA}/feed/extra`,
    'manga%2Ftag',
    `at-home/server/${CHAPTER}x`,
    '',
  ])('rejects %s', async path => {
    const response = await call(`/api/mangadex/${path}`);
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('only GET and HEAD are allowed', async () => {
    const response = await call('/api/mangadex/manga', { method: 'POST', body: '{}' });
    expect(response.status).toBe(405);
    const head = await call('/api/mangadex/manga/tag', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(upstream).toHaveBeenCalledOnce();
  });

  test('forwards the query string unchanged', async () => {
    const query = 'title=one%20piece&includes%5B%5D=cover_art&contentRating[]=safe&order[relevance]=desc';
    await call(`/api/mangadex/manga?${query}`);
    expect(upstreamRequest().url).toBe(`https://api.mangadex.org/manga?${query}`);
  });

  test('rejects oversized query strings', async () => {
    const response = await call(`/api/mangadex/manga?title=${'a'.repeat(5000)}`);
    expect(response.status).toBe(414);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('sends an identifying User-Agent and never forwards client credentials', async () => {
    await call('/api/mangadex/manga/tag', { headers: { cookie: 'a=b', authorization: 'Bearer x', via: '1.1 proxy', 'user-agent': 'Browser' } });
    const { headers } = upstreamRequest();
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('via')).toBeNull();
  });

  test('strips upstream Set-Cookie and keeps the request id', async () => {
    const response = await call('/api/mangadex/manga/tag');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('rejects cross-site browser requests', async () => {
    const response = await call('/api/mangadex/manga/tag', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(response.status).toBe(403);
    expect((await call('/api/mangadex/manga/tag', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  test('rate limits per client IP', async () => {
    allow = false;
    const response = await call('/api/mangadex/manga/tag', { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expect(limitKeys).toEqual(['api:203.0.113.9']);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('passes upstream 429 through with Retry-After', async () => {
    upstream.mockResolvedValueOnce(json({ result: 'error' }, { status: 429, headers: { 'retry-after': '12' } }));
    const response = await call('/api/mangadex/manga?title=a');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('12');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('passes other upstream errors through without caching them', async () => {
    upstream.mockResolvedValueOnce(json({ result: 'error', errors: [{ status: 404 }] }, { status: 404 }));
    const response = await call(`/api/mangadex/manga/${MANGA}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ result: 'error' });
    expect(cache.store.size).toBe(0);
  });

  test('maps network failures to 502', async () => {
    upstream.mockRejectedValueOnce(new TypeError('fetch failed'));
    const response = await call(`/api/mangadex/manga/${MANGA}`);
    expect(response.status).toBe(502);
  });

  test('caches successful responses per path and query with route TTLs', async () => {
    const first = await call('/api/mangadex/manga?title=a');
    expect(first.headers.get('x-edge-cache')).toBe('MISS');
    expect(first.headers.get('cache-control')).toBe('public, max-age=300');
    const second = await call('/api/mangadex/manga?title=a');
    expect(second.headers.get('x-edge-cache')).toBe('HIT');
    expect(await second.json()).toEqual({ result: 'ok' });
    expect(second.headers.get('content-type')).toBe('application/json');
    await call('/api/mangadex/manga?title=b');
    expect(upstream).toHaveBeenCalledTimes(2);
    expect([...cache.store.keys()]).toEqual([
      `${ORIGIN}/__edge-cache/mangadex/manga?title=a`,
      `${ORIGIN}/__edge-cache/mangadex/manga?title=b`,
    ]);
    expect(cache.store.get(`${ORIGIN}/__edge-cache/mangadex/manga?title=a`)?.headers.get('cache-control')).toBe('public, max-age=300');
    expect(cache.store.get(`${ORIGIN}/__edge-cache/mangadex/manga?title=a`)?.headers.get('set-cookie')).toBeNull();
  });

  test('at-home server responses are cached briefly at the edge and never in the browser', async () => {
    const response = await call(`/api/mangadex/at-home/server/${CHAPTER}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(cache.store.values().next().value?.headers.get('cache-control')).toBe('public, max-age=60');
  });

  test('tags are cached for a day', async () => {
    const response = await call('/api/mangadex/manga/tag');
    expect(cache.store.values().next().value?.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  test('works without the Cache API', async () => {
    vi.stubGlobal('caches', undefined);
    expect((await call('/api/mangadex/manga/tag')).status).toBe(200);
  });
});

describe('image proxy', () => {
  const COVER_FILE = '4b9aa4eb-4356-417a-bb74-4dc879141e19.jpg.512.jpg';
  const PAGE_FILE = 'x1-7356968fea0ddf74b0e41835f5dc3fcf0915b8c20cacf4e19bb26a69dd3fa7d2.jpg';
  const NODE = 'https://cmdxd98sb0x3yprd.mangadex.network';

  function image(headers: Record<string, string> = {}): Response {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { 'content-type': 'image/jpeg', 'set-cookie': 'x=1', ...headers } });
  }

  test('proxies covers without an Origin and caches them', async () => {
    upstream.mockResolvedValueOnce(image());
    const response = await call(`/api/mangadex/covers/${MANGA}/${COVER_FILE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const { url, headers } = upstreamRequest();
    expect(url).toBe(`https://uploads.mangadex.org/covers/${MANGA}/${COVER_FILE}`);
    expect(headers.get('origin')).toBeNull();
    expect(headers.get('referer')).toBeNull();
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    // uploads.mangadex.org is not a MangaDex@Home node: no report.
    expect(upstream).toHaveBeenCalledOnce();
    const again = await call(`/api/mangadex/covers/${MANGA}/${COVER_FILE}`);
    expect(again.headers.get('x-edge-cache')).toBe('HIT');
    expect(new Uint8Array(await again.arrayBuffer())).toHaveLength(6);
  });

  test('rejects malformed cover paths', async () => {
    expect((await call(`/api/mangadex/covers/${MANGA}/../../evil.jpg`)).status).toBe(404);
    expect((await call(`/api/mangadex/covers/${MANGA}/cover.html`)).status).toBe(404);
    expect((await call(`/api/mangadex/covers/nope/${COVER_FILE}`)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('proxies MangaDex@Home pages and reports the retrieval', async () => {
    upstream.mockResolvedValueOnce(image({ 'x-cache': 'HIT from node' }));
    upstream.mockResolvedValueOnce(new Response('ok'));
    const response = await call(`/api/mangadex/page/data/${HASH}/${PAGE_FILE}?base=${encodeURIComponent(NODE)}`);
    expect(response.status).toBe(200);
    expect(upstreamRequest(0).url).toBe(`${NODE}/data/${HASH}/${PAGE_FILE}`);
    const [reportUrl, reportInit] = upstream.mock.calls[1] as [string, RequestInit];
    expect(reportUrl).toBe('https://api.mangadex.network/report');
    expect(reportInit.method).toBe('POST');
    expect(new Headers(reportInit.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(reportInit.body))).toMatchObject({ url: `${NODE}/data/${HASH}/${PAGE_FILE}`, success: true, cached: true, bytes: 6 });
    expect(cache.store.has(`${ORIGIN}/__edge-cache/pages/data/${HASH}/${PAGE_FILE}`)).toBe(true);
  });

  test('reports failed page retrievals and returns 502', async () => {
    upstream.mockRejectedValueOnce(new TypeError('connection reset'));
    upstream.mockResolvedValueOnce(new Response('ok'));
    const response = await call(`/api/mangadex/page/data-saver/${HASH}/${PAGE_FILE}?base=${encodeURIComponent(NODE)}`);
    expect(response.status).toBe(502);
    expect(JSON.parse(String((upstream.mock.calls[1] as [string, RequestInit])[1].body))).toMatchObject({ success: false, bytes: 0 });
  });

  test('refuses non-image upstream responses', async () => {
    upstream.mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    upstream.mockResolvedValueOnce(new Response('ok'));
    const response = await call(`/api/mangadex/page/data/${HASH}/${PAGE_FILE}?base=${encodeURIComponent(NODE)}`);
    expect(response.status).toBe(502);
    expect(cache.store.size).toBe(0);
  });

  test('applies the optional image rate limit', async () => {
    const keys: string[] = [];
    const bindings = env({ IMAGE_LIMIT: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } });
    const response = await call(`/api/mangadex/covers/${MANGA}/${COVER_FILE}`, { headers: { 'cf-connecting-ip': '198.51.100.1' } }, bindings);
    expect(response.status).toBe(429);
    expect(keys).toEqual(['img:198.51.100.1']);
  });

  test('validates page base URLs', () => {
    expect(pageUpstreamUrl(NODE, 'data', HASH, PAGE_FILE)).toBe(`${NODE}/data/${HASH}/${PAGE_FILE}`);
    expect(pageUpstreamUrl(`${NODE}:44300/token123/`, 'data', HASH, PAGE_FILE)).toBe(`${NODE}:44300/token123/data/${HASH}/${PAGE_FILE}`);
    expect(pageUpstreamUrl('https://uploads.mangadex.org', 'data', HASH, PAGE_FILE)).toBeDefined();
    expect(pageUpstreamUrl('http://x.mangadex.network', 'data', HASH, PAGE_FILE)).toBeUndefined();
    expect(pageUpstreamUrl('https://evil.example', 'data', HASH, PAGE_FILE)).toBeUndefined();
    expect(pageUpstreamUrl('https://mangadex.network.evil.example', 'data', HASH, PAGE_FILE)).toBeUndefined();
    expect(pageUpstreamUrl('https://user:pw@x.mangadex.network', 'data', HASH, PAGE_FILE)).toBeUndefined();
    expect(pageUpstreamUrl(`${NODE}?a=b`, 'data', HASH, PAGE_FILE)).toBeUndefined();
    expect(pageUpstreamUrl(NODE, 'raw', HASH, PAGE_FILE)).toBeUndefined();
    expect(pageUpstreamUrl(NODE, 'data', 'nothex', PAGE_FILE)).toBeUndefined();
    expect(pageUpstreamUrl(NODE, 'data', HASH, 'page.svg')).toBeUndefined();
    expect(pageUpstreamUrl('not a url', 'data', HASH, PAGE_FILE)).toBeUndefined();
  });

  test('retry-after parsing', () => {
    expect(retryAfterSeconds(new Headers({ 'retry-after': '5' }))).toBe(5);
    expect(retryAfterSeconds(new Headers({ 'x-ratelimit-retry-after': '1010' }), 1_000_000)).toBe(10);
    expect(retryAfterSeconds(new Headers())).toBe(60);
  });
});
