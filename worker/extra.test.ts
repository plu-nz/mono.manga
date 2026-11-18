// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app, type Env } from './index';
import { parseAllowlist, parsePageImages, signImageUrl, signSession, verifiedEmail, verifyImageUrl, verifySession } from './extra';

const SECRET = 'test-secret';
const SERIES = '01J76XY7VSG3R5ANYPDWTXDVP6';
const CHAPTER = '01M6PKD4Y9PM0AEGK525773E9C';
const ORIGIN = 'https://manga.plu.nz';
const IMAGES_HTML = `<section id="chapter-images">
  <img
    src="https://scans.example/manga/Kingdom/0893-001.png"
    class="max-w-full" alt="Page 1" />
  <img src="https://scans.example/manga/Kingdom/0893-002.png" alt="Page 2" />
  <img src="/static/images/broken_image.jpg" alt="Broken" />
</section>`;

function env(extra: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    API_LIMIT: { limit: async () => ({ success: true }) },
    EXTRA_SOURCES_SECRET: SECRET,
    EXTRA_SOURCES_EMAILS: 'reader@example.com, other@example.com',
    GOOGLE_CLIENT_ID: 'client-1',
    ...extra,
  };
}

async function call(path: string, init: RequestInit = {}, bindings = env()): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return app.fetch(new Request(`${ORIGIN}${path}`, init), bindings, ctx);
}

async function session(email = 'reader@example.com', expiresAt = Date.now() + 60_000): Promise<string> {
  return signSession(SECRET, { email, expiresAt });
}

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  upstream = vi.fn(async (url: string) => {
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/tokeninfo')) {
      const token = new URL(url).searchParams.get('access_token');
      if (token === 'bad') return new Response('{}', { status: 400 });
      return Response.json({ email: token === 'stranger' ? 'stranger@example.com' : 'Reader@example.com', email_verified: 'true', aud: 'client-1' });
    }
    if (url.includes('/images?')) return new Response(IMAGES_HTML, { headers: { 'content-type': 'text/html' } });
    if (url.startsWith('https://scans.example/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    return new Response('<html>list</html>', { headers: { 'content-type': 'text/html' } });
  });
  vi.stubGlobal('fetch', upstream);
  vi.stubGlobal('caches', undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('extra source rules', () => {
  test('sessions verify only with a valid signature, expiry, and allowlisted email', async () => {
    const allow = parseAllowlist('Reader@example.com;other@example.com');
    const token = await session();
    expect(await verifySession(SECRET, token, allow)).toMatchObject({ email: 'reader@example.com' });
    expect(await verifySession('other-secret', token, allow)).toBeUndefined();
    expect(await verifySession(SECRET, `${token}x`, allow)).toBeUndefined();
    expect(await verifySession(SECRET, token, parseAllowlist('other@example.com'))).toBeUndefined();
    expect(await verifySession(SECRET, await session('reader@example.com', Date.now() - 1), allow)).toBeUndefined();
  });

  test('accepts only verified Google tokens issued to this app', () => {
    expect(verifiedEmail({ email: 'A@b.c', email_verified: 'true', aud: 'client-1' }, 'client-1')).toBe('a@b.c');
    expect(verifiedEmail({ email: 'a@b.c', email_verified: 'true', aud: 'someone-else' }, 'client-1')).toBeUndefined();
    expect(verifiedEmail({ email: 'a@b.c', email_verified: 'false', aud: 'client-1' }, 'client-1')).toBeUndefined();
  });

  test('extracts page images in order and signs their URLs', async () => {
    const images = parsePageImages(IMAGES_HTML);
    expect(images).toEqual(['https://scans.example/manga/Kingdom/0893-001.png', 'https://scans.example/manga/Kingdom/0893-002.png']);
    const signed = new URL(await signImageUrl(SECRET, images[0]), ORIGIN);
    expect(await verifyImageUrl(SECRET, signed.searchParams.get('u')!, signed.searchParams.get('s')!)).toBe(images[0]);
    expect(await verifyImageUrl(SECRET, signed.searchParams.get('u')!, 'forged')).toBeUndefined();
  });
});

describe('extra source routes', () => {
  test('exchanges an allowlisted Google token for a session', async () => {
    const response = await call('/api/extra/session', { method: 'POST', headers: { authorization: 'Bearer good' } });
    expect(response.status).toBe(200);
    const body = await response.json<{ token: string; email: string }>();
    expect(body.email).toBe('reader@example.com');
    expect(await verifySession(SECRET, body.token, parseAllowlist('reader@example.com'))).toBeDefined();
  });

  test('refuses accounts outside the allowlist and invalid tokens', async () => {
    expect((await call('/api/extra/session', { method: 'POST', headers: { authorization: 'Bearer stranger' } })).status).toBe(403);
    expect((await call('/api/extra/session', { method: 'POST', headers: { authorization: 'Bearer bad' } })).status).toBe(401);
    expect((await call('/api/extra/session', { method: 'POST' })).status).toBe(401);
  });

  test('is off without the secret', async () => {
    const bindings = env({ EXTRA_SOURCES_SECRET: undefined });
    expect((await call('/api/extra/session', { method: 'POST', headers: { authorization: 'Bearer good' } }, bindings)).status).toBe(404);
    expect((await call(`/api/weebcentral/series/${SERIES}/chapters`, {}, bindings)).status).toBe(404);
  });

  test('relays chapter lists as plain text only with a session', async () => {
    expect((await call(`/api/weebcentral/series/${SERIES}/chapters`)).status).toBe(401);
    const response = await call(`/api/weebcentral/series/${SERIES}/chapters`, { headers: { authorization: `Bearer ${await session()}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('<html>list</html>');
    expect(upstream.mock.calls.at(-1)![0]).toBe(`https://weebcentral.com/series/${SERIES}/full-chapter-list`);
  });

  test('rejects sessions of removed accounts, bad ids, and cross-site calls', async () => {
    const removed = await signSession(SECRET, { email: 'gone@example.com', expiresAt: Date.now() + 60_000 });
    expect((await call(`/api/weebcentral/series/${SERIES}/chapters`, { headers: { authorization: `Bearer ${removed}` } })).status).toBe(401);
    const auth = { authorization: `Bearer ${await session()}` };
    expect((await call('/api/weebcentral/series/not-an-id/chapters', { headers: auth })).status).toBe(404);
    expect((await call(`/api/weebcentral/series/${SERIES}/chapters`, { headers: { ...auth, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await call('/api/weebcentral/search?q=', { headers: auth })).status).toBe(400);
  });

  test('returns signed page URLs that the image route serves', async () => {
    const response = await call(`/api/weebcentral/chapters/${CHAPTER}/pages`, { headers: { authorization: `Bearer ${await session()}` } });
    const { pages } = await response.json<{ pages: string[] }>();
    expect(pages).toHaveLength(2);
    const image = await call(pages[0]);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    const forged = new URL(pages[0], ORIGIN);
    forged.searchParams.set('s', 'forged');
    expect((await call(`${forged.pathname}${forged.search}`)).status).toBe(403);
  });
});
