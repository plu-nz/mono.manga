import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AuthModule = typeof import('./auth');

const DRIVE = 'https://www.googleapis.com/auth/drive.appdata';
const GMAIL = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';

interface TokenConfig {
  client_id: string;
  scope: string;
  prompt?: string;
  login_hint?: string;
  include_granted_scopes?: boolean;
  callback: (response: Record<string, unknown>) => void;
  error_callback?: (error: { type: string }) => void;
}

interface PendingRequest {
  config: TokenConfig;
  grant(scope: string, options?: { token?: string; expiresIn?: number }): void;
  error(error: string): void;
  fail(type: string): void;
}

function createFakeGis() {
  const requests: PendingRequest[] = [];
  let tokenCounter = 0;
  const oauth2 = {
    initTokenClient: vi.fn((config: TokenConfig) => ({
      requestAccessToken: vi.fn(() => {
        requests.push({
          config,
          grant: (scope, options = {}) =>
            config.callback({ access_token: options.token ?? `token-${++tokenCounter}`, expires_in: options.expiresIn ?? 3599, scope, token_type: 'Bearer' }),
          error: (error) => config.callback({ error }),
          fail: (type) => config.error_callback?.({ type }),
        });
      }),
    })),
    hasGrantedAllScopes: vi.fn(() => false),
    revoke: vi.fn((_token: string, done?: () => void) => done?.()),
  };
  return { oauth2, requests };
}

let gis: ReturnType<typeof createFakeGis>;
let fetchMock: ReturnType<typeof vi.fn>;

async function loadAuth(): Promise<AuthModule> {
  vi.resetModules();
  return import('./auth');
}

function userinfo(email = 'reader@example.com'): Response {
  return new Response(JSON.stringify({ sub: '1', email }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function connected(auth: AuthModule, scope = `openid ${USERINFO_EMAIL} ${DRIVE}`): Promise<void> {
  fetchMock.mockResolvedValueOnce(userinfo());
  const promise = auth.connect(['drive']);
  gis.requests.at(-1)!.grant(scope);
  await promise;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client.apps.googleusercontent.com');
  gis = createFakeGis();
  vi.stubGlobal('google', { accounts: { oauth2: gis.oauth2 } });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.head.querySelectorAll('script').forEach((script) => script.remove());
});

describe('configuration', () => {
  it('reports not_configured without a client id', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '');
    const auth = await loadAuth();
    expect(auth.isGoogleConfigured()).toBe(false);
    expect(auth.getGoogleState()).toEqual({ configured: false, connected: false, scopes: [] });
    await expect(auth.getAccessToken(['drive'], { interactive: true })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(auth.connect([])).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('connect', () => {
  it('opens the popup synchronously, stores the account without the token, and notifies', async () => {
    const auth = await loadAuth();
    const listener = vi.fn();
    auth.subscribeGoogleState(listener);
    fetchMock.mockResolvedValueOnce(userinfo());

    const promise = auth.connect(['drive']);
    // No await happened yet: the request must already be in flight (user gesture preserved).
    expect(gis.requests).toHaveLength(1);
    const { config } = gis.requests[0];
    expect(config.client_id).toBe('test-client.apps.googleusercontent.com');
    expect(config.scope.split(' ')).toEqual(['openid', 'email', DRIVE]);
    expect(config.include_granted_scopes).toBe(true);
    expect(config.prompt).toBe('select_account');

    gis.requests[0].grant(`openid ${USERINFO_EMAIL} ${DRIVE}`, { token: 'abc' });
    const state = await promise;

    expect(state).toEqual({ configured: true, connected: true, email: 'reader@example.com', scopes: ['identity', 'drive'] });
    expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer abc' } });
    expect(localStorage.getItem('manga.google.account')).not.toContain('abc');
    expect(JSON.parse(localStorage.getItem('manga.google.account')!)).toMatchObject({ connected: true, email: 'reader@example.com' });
    expect(sessionStorage.getItem('manga.google.token')).toContain('abc');
    expect(listener).toHaveBeenLastCalledWith(state);
    expect(auth.getGoogleState()).toBe(auth.getGoogleState());
  });

  it('maps popup and consent errors', async () => {
    const auth = await loadAuth();
    const blocked = auth.connect([]);
    gis.requests[0].fail('popup_failed_to_open');
    await expect(blocked).rejects.toMatchObject({ code: 'popup_blocked' });

    const closed = auth.connect([]);
    gis.requests[1].fail('popup_closed');
    await expect(closed).rejects.toMatchObject({ code: 'popup_closed' });

    const denied = auth.connect([]);
    gis.requests[2].error('access_denied');
    await expect(denied).rejects.toMatchObject({ code: 'access_denied' });
    expect(auth.getGoogleState().connected).toBe(false);
  });

  it('rejects with access_denied when a requested scope is unticked, but stays connected', async () => {
    const auth = await loadAuth();
    fetchMock.mockResolvedValueOnce(userinfo());
    const promise = auth.connect(['drive', 'gmail']);
    gis.requests[0].grant(`openid ${USERINFO_EMAIL} ${DRIVE}`);
    await expect(promise).rejects.toMatchObject({ code: 'access_denied' });
    expect(auth.getGoogleState()).toMatchObject({ connected: true, scopes: ['identity', 'drive'] });
  });
});

describe('getAccessToken', () => {
  it('reuses a cached token whose scopes cover the request', async () => {
    const auth = await loadAuth();
    await connected(auth);
    const token = await auth.getAccessToken(['drive'], { interactive: false });
    expect(token).toMatch(/^token-/);
    expect(gis.requests).toHaveLength(1);
  });

  it('refreshes silently with prompt none within 60 s of expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const auth = await loadAuth();
    await connected(auth);
    vi.setSystemTime(1_000_000 + (3599 - 59) * 1000);

    const promise = auth.getAccessToken(['drive'], { interactive: false });
    expect(gis.requests).toHaveLength(2);
    expect(gis.requests[1].config.prompt).toBe('none');
    expect(gis.requests[1].config.login_hint).toBe('reader@example.com');
    gis.requests[1].grant(`openid ${USERINFO_EMAIL} ${DRIVE}`, { token: 'fresh' });
    await expect(promise).resolves.toBe('fresh');
  });

  it('turns any silent failure into interaction_required', async () => {
    const auth = await loadAuth();
    await connected(auth);
    auth.invalidateAccessToken();

    const blocked = auth.getAccessToken(['drive'], { interactive: false });
    gis.requests[1].fail('popup_failed_to_open');
    await expect(blocked).rejects.toMatchObject({ code: 'interaction_required' });

    const required = auth.getAccessToken(['drive'], { interactive: false });
    gis.requests[2].error('interaction_required');
    await expect(required).rejects.toMatchObject({ code: 'interaction_required' });
  });

  it('does not attempt silent auth before the user connected or for new scopes', async () => {
    const auth = await loadAuth();
    await expect(auth.getAccessToken(['drive'], { interactive: false })).rejects.toMatchObject({ code: 'interaction_required' });
    expect(gis.requests).toHaveLength(0);

    await connected(auth);
    await expect(auth.getAccessToken(['gmail'], { interactive: false })).rejects.toMatchObject({ code: 'interaction_required' });
    expect(gis.requests).toHaveLength(1);
  });

  it('adds missing scopes interactively', async () => {
    const auth = await loadAuth();
    await connected(auth);
    const promise = auth.getAccessToken(['gmail'], { interactive: true });
    expect(gis.requests).toHaveLength(2);
    expect(gis.requests[1].config.scope.split(' ')).toEqual(['openid', 'email', GMAIL]);
    expect(gis.requests[1].config.prompt).toBe('');
    gis.requests[1].grant(`openid ${USERINFO_EMAIL} ${DRIVE} ${GMAIL}`, { token: 'with-gmail' });
    await expect(promise).resolves.toBe('with-gmail');
    expect(auth.getGoogleState().scopes).toEqual(['identity', 'drive', 'gmail']);
  });

  it('survives a reload through localStorage and sessionStorage', async () => {
    let auth = await loadAuth();
    await connected(auth);
    const token = await auth.getAccessToken(['drive'], { interactive: false });

    auth = await loadAuth();
    expect(auth.getGoogleState()).toMatchObject({ connected: true, email: 'reader@example.com' });
    await expect(auth.getAccessToken(['drive'], { interactive: false })).resolves.toBe(token);
    expect(gis.requests).toHaveLength(1);
  });
});

describe('disconnect', () => {
  it('revokes the token, clears storage, and notifies', async () => {
    const auth = await loadAuth();
    await connected(auth);
    const token = await auth.getAccessToken(['drive'], { interactive: false });
    const listener = vi.fn();
    auth.subscribeGoogleState(listener);

    await auth.disconnect();
    expect(gis.oauth2.revoke).toHaveBeenCalledWith(token, expect.any(Function));
    expect(localStorage.getItem('manga.google.account')).toBeNull();
    expect(sessionStorage.getItem('manga.google.token')).toBeNull();
    expect(listener).toHaveBeenLastCalledWith({ configured: true, connected: false, scopes: [] });
  });
});

describe('authorizedFetch', () => {
  it('attaches the bearer token and retries once with a fresh token on 401', async () => {
    const auth = await loadAuth();
    await connected(auth);
    const first = await auth.getAccessToken(['drive'], { interactive: false });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const promise = auth.authorizedFetch(['drive'], 'https://example.test/x', { method: 'POST', headers: { 'X-A': '1' } });
    await vi.waitFor(() => expect(gis.requests).toHaveLength(2));
    expect(gis.requests[1].config.prompt).toBe('none');
    gis.requests[1].grant(`openid ${USERINFO_EMAIL} ${DRIVE}`, { token: 'second' });
    const response = await promise;

    expect(await response.text()).toBe('ok');
    const calls = fetchMock.mock.calls.slice(-2) as Array<[string, RequestInit]>;
    expect(new Headers(calls[0][1].headers).get('Authorization')).toBe(`Bearer ${first}`);
    expect(new Headers(calls[1][1].headers).get('Authorization')).toBe('Bearer second');
    expect(new Headers(calls[1][1].headers).get('X-A')).toBe('1');
    expect(calls[1][1].method).toBe('POST');
  });

  it('maps transport failures to network errors', async () => {
    const auth = await loadAuth();
    await connected(auth);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(auth.authorizedFetch(['drive'], 'https://example.test/x')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('script loading', () => {
  it('injects the GIS script once and waits for it', async () => {
    vi.stubGlobal('google', undefined);
    const auth = await loadAuth();
    const preload = auth.preloadGoogle();
    const again = auth.preloadGoogle();
    const scripts = document.head.querySelectorAll('script[src="https://accounts.google.com/gsi/client"]');
    expect(scripts).toHaveLength(1);

    vi.stubGlobal('google', { accounts: { oauth2: gis.oauth2 } });
    scripts[0].dispatchEvent(new Event('load'));
    await Promise.all([preload, again]);

    // Now loaded: the next connect opens synchronously.
    void auth.connect([]).catch(() => undefined);
    expect(gis.requests).toHaveLength(1);
  });

  it('reports a network error when the script fails to load', async () => {
    vi.stubGlobal('google', undefined);
    const auth = await loadAuth();
    const promise = auth.connect([]);
    document.head.querySelector('script')!.dispatchEvent(new Event('error'));
    await expect(promise).rejects.toMatchObject({ code: 'network' });
  });
});
